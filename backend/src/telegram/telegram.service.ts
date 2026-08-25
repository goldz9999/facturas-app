import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FacturasService, ArchivoEntrada } from '../facturas/facturas.service';
import { ModoService } from '../facturas/modo.service';
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
        private modoService: ModoService,
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
            const estado = await this.telegramEstado.obtener(Number(chatId));
            if (estado?.esperando === 'subir_comprobante' && estado.gasto_id) {
                await this.manejarSubidaDeComprobante(chatId, estado.gasto_id, archivo);
                return;
            }

            // El switch del frontend decide quién procesa: el propio backend o,
            // si se sigue prefiriendo, se reenvía al webhook genérico de n8n
            // (en ese caso n8n ya no recibe el update de Telegram directamente,
            // solo el archivo, así que el mensaje de vuelta al chat lo arma y
            // envía el backend con la respuesta que da n8n).
            const modo = await this.modoService.getModo();
            const resultado =
                modo === 'backend'
                    ? await this.facturasService.procesarArchivoIndividual(archivo, usuario.id, 'telegram')
                    : await this.facturasService.reenviarArchivoAN8n(archivo);

            // Si el archivo era un audio (sin comprobante) y estamos en modo
            // backend, preguntamos si tiene comprobante para adjuntar después.
            const esAudioSinComprobante =
                modo === 'backend' && !resultado.n_factura && !resultado.empresa && resultado.gasto_id;

            await this.enviarMensaje(chatId, this.armarMensaje(resultado));

            if (esAudioSinComprobante) {
                await this.preguntarSiTieneComprobante(chatId, resultado.gasto_id);
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
        const [accion, gastoIdStr] = data.split(':');
        const gastoId = Number(gastoIdStr);

        // Responder el callback siempre, para que el botón deje de "cargar" en
        // la app de Telegram, incluso si algo falla después.
        await this.responderCallback(callback.id);

        if (!chatId || !gastoId) return;

        try {
            if (accion === 'comprobante_no') {
                await this.enviarMensaje(chatId, '👍 Listo, gasto guardado sin comprobante.');
                return;
            }

            if (accion === 'comprobante_si' || accion === 'agregar_comprobante') {
                await this.telegramEstado.guardar(Number(chatId), 'subir_comprobante', gastoId);
                await this.enviarMensaje(chatId, '📎 Envíame la foto o el PDF del comprobante.');
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