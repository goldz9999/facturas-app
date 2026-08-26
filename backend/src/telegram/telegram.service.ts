import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FacturasService, ArchivoEntrada } from '../facturas/facturas.service';
import { UsuariosService } from '../usuarios/usuarios.service';
import { GastosService } from '../gastos/gastos.service';
import { TelegramEstadoService } from './telegram-estado.service';

interface TelegramUpdate {
    message?: {
        chat: { id: number | string };
        message_id: number;
        document?: { file_id: string; file_name?: string; mime_type?: string };
        photo?: Array<{ file_id: string }>;
        voice?: { file_id: string; mime_type?: string };
        text?: string;
    };
    callback_query?: {
        id: string;
        data?: string;
        message?: { chat: { id: number | string }; message_id: number };
    };
}

@Injectable()
export class TelegramService {
    private readonly logger = new Logger(TelegramService.name);
    private readonly token: string | undefined;

    constructor(
        private config: ConfigService,
        private facturasService: FacturasService,
        private usuariosService: UsuariosService,
        private gastosService: GastosService,
        private telegramEstado: TelegramEstadoService,
    ) {
        this.token = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    }

    private get apiBase() {
        return `https://api.telegram.org/bot${this.token}`;
    }

    private get fileBase() {
        return `https://api.telegram.org/file/bot${this.token}`;
    }

    // Punto de entrada del webhook. Nunca lanza: Telegram solo necesita un 200 rápido,
    // los errores se le devuelven al usuario como un mensaje de chat.
    async handleUpdate(update: TelegramUpdate) {
        if (!this.token) {
            this.logger.error('Falta configurar TELEGRAM_BOT_TOKEN.');
            return;
        }

        if (update.callback_query) {
            await this.manejarCallbackQuery(update.callback_query);
            return;
        }

        const message = update.message;
        if (!message) return;

        const chatId = message.chat.id;

        try {
            const usuario = await this.usuariosService.estaAutorizado(chatId);
            if (!usuario) {
                await this.enviarMensaje(
                    chatId,
                    `🚫 Tu cuenta de Telegram no está autorizada.\nPídele al administrador que te dé de alta con este ID: <code>${chatId}</code>`,
                );
                return;
            }

            // Si el chat está esperando que le confirmen/corrijan el monto de
            // un gasto de baja confianza, un mensaje de texto se interpreta
            // como la respuesta a esa pregunta, no como un comando ni un
            // archivo nuevo.
            const estadoPrevio = await this.telegramEstado.obtener(Number(chatId));
            if (estadoPrevio?.esperando === 'confirmar_monto' && estadoPrevio.gasto_id && message.text) {
                await this.manejarCorreccionMonto(chatId, estadoPrevio.gasto_id, message.text);
                return;
            }

            // Comando "/gastos" o "gastos": lista los últimos gastos con botón
            // para adjuntar comprobante a cada uno.
            const texto = message.text?.trim().toLowerCase();
            if (texto === '/gastos' || texto === 'gastos') {
                await this.enviarUltimosGastos(chatId, usuario.id);
                return;
            }

            const archivo = await this.obtenerArchivo(message);
            if (!archivo) {
                // Es un mensaje de texto u otro tipo que no procesamos (equivalente
                // a las ramas vacías del "Switch Telegram1" de n8n).
                return;
            }

            // Antes de procesar el archivo como un gasto nuevo, revisamos si el
            // chat está esperando que le suban un comprobante para un gasto ya
            // existente (flujo de botones "¿Tienes comprobante? Sí" o
            // "/gastos → Agregar comprobante").
            if (estadoPrevio?.esperando === 'subir_comprobante' && estadoPrevio.gasto_id) {
                await this.manejarSubidaDeComprobante(chatId, estadoPrevio.gasto_id, archivo);
                return;
            }

            const resultado = await this.facturasService.procesarArchivoIndividual(
                archivo,
                usuario.id,
                'telegram',
            );

            // Es audio si el propio pipeline lo marcó como tal, sin importar
            // si la persona dijo o no una empresa/n° de factura al hablar.
            const esAudio = Boolean(resultado.es_audio);

            await this.enviarMensaje(chatId, this.armarMensaje(resultado));

            // Confianza media o baja (sección 23 de requerimientos): en vez
            // de dar el gasto por bueno sin más, "media" pide confirmación y
            // "baja" pide directamente el dato correcto. Aplica tanto a
            // audio como a comprobante — un audio con confianza baja
            // necesita corrección igual (o más) que una foto mal leída.
            // No aplica si el comprobante se agrupó con un gasto existente,
            // porque ese gasto ya pasó (o va a pasar) su propia confirmación
            // cuando se creó.
            let pidioConfianza = false;
            if (!resultado.vinculado_a) {
                if (resultado.confianza === 'media') {
                    await this.confirmarConfianzaMedia(chatId, resultado.gasto_id, resultado.total);
                    pidioConfianza = true;
                } else if (resultado.confianza === 'baja') {
                    await this.pedirCorreccionMonto(chatId, resultado.gasto_id, resultado.total);
                    pidioConfianza = true;
                }
            }

            // Si es audio y no quedó pendiente una corrección de monto (que
            // ya te va a hacer escribir igual), preguntamos si tiene
            // comprobante para adjuntar después. Si ya le pedimos corregir
            // el monto, evitamos bombardear con dos preguntas seguidas: se
            // pregunta por el comprobante recién cuando responda esa.
            if (esAudio && !pidioConfianza) {
                await this.preguntarSiTieneComprobante(chatId, resultado.gasto_id);
            }

            // La heurística de agrupación (facturas.service.ts) decidió que
            // este comprobante pertenece a un gasto reciente en vez de crear
            // uno nuevo. Se lo confirmamos al usuario, con opción de decir
            // que no era así.
            if (resultado.vinculado_a) {
                await this.confirmarAgrupacion(chatId, resultado.vinculado_a);
            }

            // Posible duplicado entre usuarios distintos (sección 17): si el
            // parecido es "seguro" (mismo monto+fecha+número de comprobante),
            // solo se avisa. Si es "parcial" (solo monto+fecha), se pregunta
            // antes de dar el gasto por bueno — nunca se borra automático.
            if (resultado.posible_duplicado) {
                await this.avisarPosibleDuplicado(chatId, resultado.gasto_id, resultado.posible_duplicado);
            }
        } catch (err) {
            this.logger.error(`Error procesando update de Telegram: ${err.message}`);
            await this.enviarMensaje(
                chatId,
                '❌ Hubo un error procesando tu factura. Intenta de nuevo en unos minutos.',
            ).catch(() => undefined);
        }
    }

    // --- Flujo 1: audio sin comprobante -> botones Sí/No ---

    private async preguntarSiTieneComprobante(chatId: number | string, gastoId: number) {
        await this.enviarMensaje(chatId, '¿Tienes el comprobante de este gasto?', {
            inline_keyboard: [
                [
                    { text: '✅ Sí', callback_data: `comprobante_si:${gastoId}` },
                    { text: '❌ No', callback_data: `comprobante_no:${gastoId}` },
                ],
            ],
        });
    }

    // Se llama después de resolver una confirmación/corrección de confianza.
    // Si el gasto sigue sin comprobante (típico de audio), recién ahí le
    // preguntamos si tiene uno para adjuntar — evita mandar la pregunta de
    // comprobante y la de confianza al mismo tiempo.
    private async preguntarComprobanteSiFalta(chatId: number | string, gastoId: number) {
        const gasto = await this.gastosService.obtenerPorId(gastoId);
        const tieneComprobante = Array.isArray(gasto.comprobantes) && gasto.comprobantes.length > 0;
        if (!tieneComprobante) {
            await this.preguntarSiTieneComprobante(chatId, gastoId);
        }
    }

    // --- Heurística de agrupación: confirmación con botones Sí/No ---

    private async confirmarAgrupacion(
        chatId: number | string,
        vinculadoA: { gasto_id: number; monto: number; comprobante_id: number; evidencia_id: number | null },
    ) {
        const evid = vinculadoA.evidencia_id ?? 0;
        await this.enviarMensaje(
            chatId,
            `🔗 Vinculé este comprobante al gasto de S/ ${vinculadoA.monto} que registraste hace poco. ¿Es correcto?`,
            {
                inline_keyboard: [
                    [
                        {
                            text: '✅ Sí, es correcto',
                            callback_data: `agrupar_si:${vinculadoA.comprobante_id}:${evid}`,
                        },
                        {
                            text: '❌ No, es otro gasto',
                            callback_data: `agrupar_no:${vinculadoA.comprobante_id}:${evid}`,
                        },
                    ],
                ],
            },
        );
    }

    // --- Duplicados entre usuarios distintos ---

    private async avisarPosibleDuplicado(
        chatId: number | string,
        gastoId: number,
        duplicado: { usuario_nombre: string; nivel: 'alta' | 'media' },
    ) {
        if (duplicado.nivel === 'alta') {
            await this.enviarMensaje(
                chatId,
                `⚠️ Este pago ya fue registrado por <b>${duplicado.usuario_nombre}</b>.`,
            );
            return;
        }

        await this.enviarMensaje(
            chatId,
            `🔁 Posible gasto duplicado: encontré uno con el mismo monto y fecha registrado por <b>${duplicado.usuario_nombre}</b>. ¿Deseas registrarlo igualmente?`,
            {
                inline_keyboard: [
                    [
                        { text: '✅ Sí, es distinto', callback_data: `dup_no:${gastoId}` },
                        { text: '🗑️ No, era el mismo', callback_data: `dup_si:${gastoId}` },
                    ],
                ],
            },
        );
    }

    // --- Confianza media/baja: confirmación o corrección de monto ---

    private async confirmarConfianzaMedia(chatId: number | string, gastoId: number, montoDetectado: number) {
        await this.enviarMensaje(
            chatId,
            `⚠️ No estoy 100% seguro de haber leído bien este comprobante (monto detectado: S/ ${montoDetectado}). ¿Está correcto?`,
            {
                inline_keyboard: [
                    [
                        { text: '✅ Sí, está bien', callback_data: `media_ok:${gastoId}` },
                        { text: '✏️ Corregir monto', callback_data: `media_no:${gastoId}` },
                    ],
                ],
            },
        );
    }

    private async pedirCorreccionMonto(chatId: number | string, gastoId: number, montoDetectado: number) {
        await this.telegramEstado.guardar(Number(chatId), 'confirmar_monto', gastoId);
        await this.enviarMensaje(
            chatId,
            `🔎 No pude leer bien este comprobante (monto detectado: S/ ${montoDetectado}, puede estar mal). ` +
            `¿Cuál es el monto correcto? Respóndeme solo el número, ej: 45.50`,
        );
    }

    private async manejarCorreccionMonto(chatId: number | string, gastoId: number, texto: string) {
        const normalizado = texto.trim().replace(',', '.').replace(/[^\d.]/g, '');
        const monto = normalizado ? parseFloat(normalizado) : NaN;

        if (!normalizado || isNaN(monto) || monto <= 0) {
            await this.enviarMensaje(chatId, '❌ No entendí el monto. Respóndeme solo el número, ej: 45.50');
            return; // el estado sigue activo, para que pueda reintentar
        }

        await this.gastosService.corregirMonto(gastoId, monto);
        await this.telegramEstado.limpiar(Number(chatId));
        await this.enviarMensaje(chatId, `✅ Listo, corregí el monto a S/ ${monto}.`);
        await this.preguntarComprobanteSiFalta(chatId, gastoId);
    }

    // --- Flujo 2: comando /gastos -> lista con botón "Agregar comprobante" ---

    private async enviarUltimosGastos(chatId: number | string, usuarioId: number) {
        const gastos = await this.gastosService.ultimosPorUsuario(usuarioId, 5);
        if (gastos.length === 0) {
            await this.enviarMensaje(chatId, 'Todavía no tienes gastos registrados.');
            return;
        }

        for (const gasto of gastos) {
            const tieneComprobante = Array.isArray(gasto.comprobantes) && gasto.comprobantes.length > 0;
            const desc = gasto.descripcion || '(sin descripción)';
            const linea =
                `📌 <b>${desc}</b>\n💰 ${gasto.monto}  ·  📅 ${gasto.fecha}` +
                (tieneComprobante ? '\n🧾 Ya tiene comprobante' : '\n💬 Sin comprobante');

            await this.enviarMensaje(
                chatId,
                linea,
                tieneComprobante
                    ? undefined
                    : {
                        inline_keyboard: [
                            [
                                {
                                    text: '📎 Agregar comprobante',
                                    callback_data: `agregar_comprobante:${gasto.id}`,
                                },
                            ],
                        ],
                    },
            );
        }
    }

    // --- Botones (callback_query) ---

    private async manejarCallbackQuery(callback: NonNullable<TelegramUpdate['callback_query']>) {
        const chatId = callback.message?.chat.id;
        const data = callback.data || '';
        const [accion, primerIdStr, segundoIdStr] = data.split(':');
        const gastoId = Number(primerIdStr);

        // Responder el callback siempre, para que el botón deje de "cargar" en
        // la app de Telegram, incluso si algo falla después.
        await this.responderCallback(callback.id);

        if (!chatId) return;

        try {
            if (accion === 'comprobante_no') {
                await this.enviarMensaje(chatId, '👍 Listo, gasto guardado sin comprobante.');
                return;
            }

            if (accion === 'comprobante_si' || accion === 'agregar_comprobante') {
                if (!gastoId) return;
                await this.telegramEstado.guardar(Number(chatId), 'subir_comprobante', gastoId);
                await this.enviarMensaje(chatId, '📎 Envíame la foto o el PDF del comprobante.');
                return;
            }

            if (accion === 'agrupar_si') {
                await this.enviarMensaje(chatId, '👍 Perfecto, quedó todo junto en el mismo gasto.');
                return;
            }

            if (accion === 'agrupar_no') {
                // La heurística se equivocó: el comprobante (primerIdStr) y su
                // evidencia (segundoIdStr, puede ser 0) se separan del gasto al
                // que se habían adjuntado, y pasan a tener su propio gasto.
                const comprobanteId = gastoId; // reutiliza la misma variable: es el primer id del callback
                const evidenciaId = Number(segundoIdStr) || null;
                const usuario = await this.usuariosService.estaAutorizado(chatId);
                if (!usuario) return;
                await this.gastosService.separarComprobante(comprobanteId, evidenciaId, usuario.id);
                await this.enviarMensaje(chatId, '👍 Listo, lo registré como un gasto aparte.');
                return;
            }

            if (accion === 'media_ok') {
                if (!gastoId) return;
                await this.gastosService.confirmarConfianza(gastoId);
                await this.enviarMensaje(chatId, '👍 Perfecto, quedó confirmado.');
                await this.preguntarComprobanteSiFalta(chatId, gastoId);
                return;
            }

            if (accion === 'media_no') {
                if (!gastoId) return;
                await this.telegramEstado.guardar(Number(chatId), 'confirmar_monto', gastoId);
                await this.enviarMensaje(chatId, '✏️ Ok, respóndeme solo el número con el monto correcto, ej: 45.50');
                return;
            }

            if (accion === 'dup_no') {
                if (!gastoId) return;
                await this.gastosService.descartarDuplicado(gastoId);
                await this.enviarMensaje(chatId, '👍 Listo, lo dejo como un gasto aparte.');
                return;
            }

            if (accion === 'dup_si') {
                // No se borra nada (nunca automático): queda marcado como
                // probable duplicado para que el reporte lo pueda filtrar.
                await this.enviarMensaje(chatId, '👍 Anotado, lo dejo marcado como duplicado.');
                return;
            }
        } catch (err) {
            this.logger.error(`Error manejando callback de Telegram: ${err.message}`);
            await this.enviarMensaje(chatId, '❌ Hubo un error. Intenta de nuevo.').catch(() => undefined);
        }
    }

    // Se llama cuando llega un archivo mientras el chat está en estado
    // 'subir_comprobante': lo adjunta al gasto pendiente en vez de crear un
    // gasto nuevo.
    private async manejarSubidaDeComprobante(
        chatId: number | string,
        gastoId: number,
        archivo: ArchivoEntrada,
    ) {
        await this.telegramEstado.limpiar(Number(chatId));

        if (archivo.mimetype.startsWith('audio/')) {
            await this.enviarMensaje(
                chatId,
                '⚠️ Necesito una foto o PDF del comprobante, no un audio. Vuelve a intentarlo.',
            );
            return;
        }

        const { factura } = await this.facturasService.adjuntarComprobanteAGasto(gastoId, archivo);
        await this.enviarMensaje(
            chatId,
            `🧾 <b>Comprobante adjuntado</b>\n\n` +
            (factura.empresa ? `🏢 <b>Empresa:</b> ${factura.empresa}\n` : '') +
            (factura.n_factura ? `🔢 <b>N° Factura:</b> ${factura.n_factura}\n` : '') +
            `💰 <b>Total:</b> ${factura.total_factura ?? '-'}`,
        );
    }

    private async responderCallback(callbackQueryId: string) {
        await fetch(`${this.apiBase}/answerCallbackQuery`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ callback_query_id: callbackQueryId }),
        }).catch(() => undefined);
    }

    // Equivalente a "Switch Telegram1" + "Get document1/Get photo1/Get voice1"
    private async obtenerArchivo(
        message: NonNullable<TelegramUpdate['message']>,
    ): Promise<ArchivoEntrada | null> {
        if (message.document) {
            const buffer = await this.descargarArchivo(message.document.file_id);
            const nombre = message.document.file_name || 'documento';
            return {
                buffer,
                mimetype: message.document.mime_type || 'application/octet-stream',
                originalname: nombre,
            };
        }

        if (message.photo && message.photo.length > 0) {
            const ultima = message.photo[message.photo.length - 1];
            const buffer = await this.descargarArchivo(ultima.file_id);
            return { buffer, mimetype: 'image/jpeg', originalname: 'foto.jpg' };
        }

        if (message.voice) {
            const buffer = await this.descargarArchivo(message.voice.file_id);
            return {
                buffer,
                mimetype: message.voice.mime_type || 'audio/ogg',
                originalname: 'audio.ogg',
            };
        }

        return null;
    }

    private async descargarArchivo(fileId: string): Promise<Buffer> {
        const infoRes = await fetch(`${this.apiBase}/getFile?file_id=${fileId}`);
        const info = await infoRes.json();
        if (!info.ok) {
            throw new Error(`No se pudo obtener el archivo de Telegram: ${JSON.stringify(info)}`);
        }

        const filePath = info.result.file_path;
        const fileRes = await fetch(`${this.fileBase}/${filePath}`);
        const arrayBuffer = await fileRes.arrayBuffer();
        return Buffer.from(arrayBuffer);
    }

    private async enviarMensaje(
        chatId: number | string,
        texto: string,
        replyMarkup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> },
    ) {
        await fetch(`${this.apiBase}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: texto,
                parse_mode: 'HTML',
                ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
            }),
        });
    }

    // Equivalente a "Armar mensaje1" en n8n
    private armarMensaje(resultado: any): string {
        const esc = (t: any) =>
            String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

        const items = Array.isArray(resultado.items) ? resultado.items : [];
        const lineas = items.map((item: any) => {
            const cant = item.cantidad > 0 ? `${item.cantidad} x ` : '';
            const costo = item.costo != null ? item.costo : '-';
            return `• ${esc(cant)}${esc(item.producto)}  —  ${esc(costo)}`;
        });

        // Si no hay n_factura ni empresa, asumimos que vino de un audio sin
        // comprobante (no se creó fila en "comprobantes").
        const tieneComprobante = Boolean(resultado.n_factura || resultado.empresa);

        let msg = tieneComprobante
            ? '🧾 <b>Factura registrada</b>\n\n'
            : '💬 <b>Gasto registrado</b> (sin comprobante)\n\n';
        if (resultado.empresa) msg += `🏢 <b>Empresa:</b> ${esc(resultado.empresa)}\n`;
        if (resultado.n_factura) msg += `🔢 <b>N° Factura:</b> ${esc(resultado.n_factura)}\n`;
        if (resultado.fecha) msg += `📅 <b>Fecha:</b> ${esc(resultado.fecha)}\n`;
        msg += `\n<b>Productos:</b>\n${lineas.length ? lineas.join('\n') : '(sin productos)'}`;

        if (resultado.subtotal != null) msg += `\n\n💵 <b>Sub Total:</b> ${resultado.subtotal}`;
        if (resultado.igv != null) msg += `\n📊 <b>IGV:</b> ${resultado.igv}`;
        if (resultado.total != null) msg += `\n💰 <b>Total:</b> ${resultado.total}`;

        return msg;
    }
}