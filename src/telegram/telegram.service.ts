import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FacturasService, ArchivoEntrada } from '../facturas/facturas.service';
import { UsuariosService } from '../usuarios/usuarios.service';
import { GastosService } from '../gastos/gastos.service';
import { TelegramEstadoService } from './telegram-estado.service';
import { CategoriasService } from '../categorias/categorias.service';
import { ProveedoresService } from '../proveedores/proveedores.service';
import { EmpresasService } from '../empresas/empresas.service';
import { PedidosService } from '../pedidos/pedidos.service';

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
        private categoriasService: CategoriasService,
        private proveedoresService: ProveedoresService,
        private empresasService: EmpresasService,
        private pedidosService: PedidosService,
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
            if (estadoPrevio?.esperando === 'tipo_cambio' && estadoPrevio.gasto_id && message.text) {
                await this.manejarTipoCambio(chatId, estadoPrevio.gasto_id, message.text);
                return;
            }
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
                // No es foto/audio/documento. Si trae texto (y no es un comando
                // ni la respuesta a una pregunta ya manejada más arriba), se
                // interpreta como registro de gasto por texto libre (Paso 25):
                // "gasté 30 soles en útiles de oficina". Cualquier otro update
                // sin texto (stickers, etc.) se ignora, igual que antes.
                if (message.text?.trim()) {
                    await this.procesarTextoLibre(chatId, usuario.id, message.text.trim());
                }
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

            // Si llegó un archivo mientras el chat estaba esperando la
            // corrección de un monto (en vez de responder con texto), esa
            // pregunta quedó abandonada: se limpia el estado para que no
            // quede "escuchando" de fondo y confunda una respuesta de texto
            // posterior con la corrección de un gasto viejo.
            if (estadoPrevio?.esperando === 'confirmar_monto' || estadoPrevio?.esperando === 'tipo_cambio') {
                await this.telegramEstado.limpiar(Number(chatId));
            }

            const resultado = await this.facturasService.procesarArchivoIndividual(
                archivo,
                usuario.id,
                'telegram',
            );

            if (!resultado.success) {
                // La imagen no es un comprobante válido (captura de web, cotización, etc.)
                if ((resultado as any).no_es_comprobante) {
                    await this.enviarMensaje(
                        chatId,
                        '🤔 Esta imagen no parece ser un comprobante de pago o factura completada. ' +
                        'No se registró ningún gasto.\n\n' +
                        'Si es una factura pendiente de pago, envíala cuando ya esté pagada.',
                    );
                }
                return;
            }

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

            // Si es audio y no quedó pendiente una corrección de monto,
            // preguntamos empresa (si tiene acceso a varias) y luego
            // personal/empresa. Si quedó pendiente la confianza, todo esto
            // se retoma desde el callback correspondiente.
            if (esAudio && !pidioConfianza) {
                const empresaPendiente = await this.preguntarEmpresaSiFalta(chatId, resultado.gasto_id, usuario.id);
                if (!empresaPendiente) {
                    await this.manejarTipoAudioConItems(chatId, resultado.gasto_id, resultado.items ?? [], usuario.id);
                }
            }

            // Matching de proveedor/categoría (sección 9 de requerimientos):
            // si el proveedor es nuevo (o todavía no tiene una categoría
            // aprendida), se pregunta con botones. Se pospone si ya se
            // preguntó por confianza, para no encimar dos preguntas seguidas
            // — se retoma cuando esa se resuelva (ver manejarCorreccionMonto
            // y el callback media_ok).
            //
            // A propósito SIN el filtro "!resultado.vinculado_a" que tenía
            // antes (fix Paso 18.2): un archivo agrupado (ej. factura que
            // llega después de un Yape suelto) también puede dejar
            // falta_categoria=true si el gasto con el que se agrupó nunca
            // tuvo la oportunidad de clasificarse. pidioConfianza siempre es
            // false en el caso agrupado (esa confirmación está gateada por
            // el mismo !vinculado_a más arriba), así que no hay riesgo de
            // encimar preguntas.
            if (!esAudio && !pidioConfianza) {
                // La empresa se pregunta SIEMPRE para imágenes cuando el usuario
                // tiene acceso a varias, sin importar si falta categoría o no.
                // Antes solo se preguntaba cuando falta_categoria=true, por lo
                // que un proveedor ya conocido (categoría aprendida) registraba
                // en la empresa por defecto sin preguntar — bug reportado.
                const empresaPendiente = await this.preguntarEmpresaSiFalta(chatId, resultado.gasto_id, usuario.id);
                if (!empresaPendiente) {
                    if (resultado.falta_categoria) {
                        await this.preguntarCategoria(chatId, resultado.gasto_id, resultado.proveedor_id);
                    } else if (!resultado.vinculado_a) {
                        // Proveedor ya conocido con categoría aprendida: solo
                        // falta preguntar el pedido si la empresa lo usa.
                        await this.preguntarPedidoSiFalta(chatId, resultado.gasto_id, resultado.pedido_mencionado);
                    }
                }
                // Si empresaPendiente=true: la cadena categoría→tipo→pedido
                // se retoma desde el callback 'empresa:'.
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

            // Si el gasto quedó en dólares y no estamos esperando que el
            // usuario corrija el monto (confianza baja), guardamos el estado
            // 'tipo_cambio' para que su próxima respuesta de texto sea
            // interpretada como el tipo de cambio y el monto se convierta a
            // soles automáticamente.
            if (resultado.moneda === 'USD' && !pidioConfianza) {
                await this.telegramEstado.guardar(Number(chatId), 'tipo_cambio', resultado.gasto_id);
            }
        } catch (err) {
            this.logger.error(`Error procesando update de Telegram (chat ${chatId}): ${err.message}`, err.stack);
            await this.enviarMensaje(
                chatId,
                '❌ Hubo un error procesando tu factura. Intenta de nuevo en unos minutos.',
            ).catch(() => undefined);
        }
    }

    // --- Registro por texto libre (Paso 25) ---

    // Se llama cuando llega un mensaje de texto que no es un comando ni la
    // respuesta a una pregunta pendiente (esos casos ya se filtraron en
    // handleUpdate antes de llegar acá). Reusa el mismo pipeline que ya
    // existe para audio (FacturasService.procesarTextoExtraido, vía
    // procesarTextoLibre) porque el prompt de extracción de audio ya está
    // pensado para lenguaje coloquial libre. El flujo de confirmación que
    // sigue (confianza media/baja, "¿tienes comprobante?") es
    // intencionalmente el mismo que usa un audio: un texto libre tampoco
    // trae comprobante propio, así que no aplica agrupación, matching de
    // proveedor/categoría ni chequeo de duplicados (mismas limitaciones que
    // audio hoy, documentadas en el Paso 4.2/4.3 del progreso).
    private async procesarTextoLibre(chatId: number | string, usuarioId: number, texto: string) {
        const resultado = await this.facturasService.procesarTextoLibre(texto, usuarioId, 'telegram');

        if (!resultado.success) {
            await this.enviarMensaje(
                chatId,
                '🤔 No reconocí ningún gasto en tu mensaje. Si quieres registrar uno, cuéntame el monto y en qué lo gastaste, ej: "gasté 30 soles en útiles de oficina".',
            );
            return;
        }

        await this.enviarMensaje(chatId, this.armarMensaje(resultado));

        // Igual que con audio: confianza media pregunta, baja pide corregir
        // el monto directamente; si ninguna de las dos aplicó, recién ahí
        // preguntamos si tiene comprobante para adjuntar (mismo orden que
        // usa el flujo de archivos, para no encimar dos preguntas seguidas).
        let pidioConfianza = false;
        if (resultado.confianza === 'media') {
            await this.confirmarConfianzaMedia(chatId, resultado.gasto_id, resultado.total);
            pidioConfianza = true;
        } else if (resultado.confianza === 'baja') {
            await this.pedirCorreccionMonto(chatId, resultado.gasto_id, resultado.total);
            pidioConfianza = true;
        }

        if (!pidioConfianza) {
            await this.preguntarSiTieneComprobante(chatId, resultado.gasto_id);
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

    // Detecta items con tipo_gasto en un audio y actúa:
    // - todos personal → auto-marca el gasto como personal
    // - mixto → muestra desglose y pide decisión con botones
    // - sin clasificar → flujo normal (preguntarTipoParaAudio)
    private async manejarTipoAudioConItems(chatId: number | string, gastoId: number, items: any[], usuarioId: number) {
        const personales = items.filter((i) => i.tipo_gasto === 'personal');
        const empresa = items.filter((i) => i.tipo_gasto === 'empresa');
        const hayPersonal = personales.length > 0;
        const hayEmpresa = empresa.length > 0;

        if (hayPersonal && !hayEmpresa) {
            await this.gastosService.actualizar(gastoId, { es_personal: true });
            await this.enviarMensaje(chatId, '🙋 Detecté que todos los ítems son personales. Guardado como gasto personal.');
            await this.preguntarSiTieneComprobante(chatId, gastoId);
            return;
        }

        if (hayPersonal && hayEmpresa) {
            const sumar = (arr: any[]) => arr.reduce((s, i) => s + (Number(i.costo) || 0), 0);
            const montoP = sumar(personales);
            const montoE = sumar(empresa);
            const fmt = (n: number) => `S/ ${n.toFixed(2)}`;
            const listP = personales.map((i) => `  • ${i.producto}${i.costo ? ' (' + fmt(Number(i.costo)) + ')' : ''}`).join('\n');
            const listE = empresa.map((i) => `  • ${i.producto}${i.costo ? ' (' + fmt(Number(i.costo)) + ')' : ''}`).join('\n');
            const msg = `⚠️ Detecté ítems mezclados:\n\n🙋 <b>Personal</b> — ${fmt(montoP)}\n${listP}\n\n🏢 <b>Empresa</b> — ${fmt(montoE)}\n${listE}\n\n¿Qué hago?`;
            await this.enviarMensaje(chatId, msg, {
                inline_keyboard: [
                    [
                        { text: '🙋 Todo personal', callback_data: `audio_mix_personal:${gastoId}` },
                        { text: '🏢 Todo empresa', callback_data: `audio_mix_empresa:${gastoId}` },
                    ],
                    [{ text: '✂️ Separar en dos gastos', callback_data: `audio_mix_separar:${gastoId}:${montoP}:${montoE}` }],
                ],
            });
            return;
        }

        // Sin clasificar: si hay ítems con nombre, preguntar uno a uno para aprender.
        // Si no hay ítems (o el usuario no puede registrar personal), flujo normal.
        const usuario = await this.usuariosService.obtenerPorId(usuarioId);
        const itemsConNombre = items.filter((i) => i.producto);
        if (itemsConNombre.length > 0 && usuario?.puede_registrar_personal) {
            const primerItem = itemsConNombre[0];
            await this.telegramEstado.guardar(Number(chatId), 'clasificar_item', gastoId, {
                items: itemsConNombre.map((i: any) => ({ producto: i.producto, costo: i.costo, tipo_gasto: undefined })),
                idx: 0,
            });
            await this.enviarMensaje(
                chatId,
                `No sé si cada ítem es personal o de empresa. ¿<b>${primerItem.producto}</b> es personal o de la empresa?`,
                {
                    inline_keyboard: [
                        [
                            { text: '🙋 Personal', callback_data: `item_tipo:${gastoId}:personal` },
                            { text: '🏢 Empresa', callback_data: `item_tipo:${gastoId}:empresa` },
                        ],
                    ],
                },
            );
            return;
        }

        await this.preguntarTipoParaAudio(chatId, gastoId, usuarioId);
    }

    // Pregunta si el gasto de audio es personal o de empresa, luego comprobante.
    // Se llama cuando el gasto es de audio y el usuario puede registrar personal.
    // Si no puede registrar personal, va directo a comprobante.
    private async preguntarTipoParaAudio(chatId: number | string, gastoId: number, usuarioId: number) {
        const usuario = await this.usuariosService.obtenerPorId(usuarioId);
        if (!usuario?.puede_registrar_personal) {
            await this.preguntarSiTieneComprobante(chatId, gastoId);
            return;
        }
        await this.enviarMensaje(chatId, '¿Es un gasto personal o de la empresa?', {
            inline_keyboard: [[
                { text: '🙋 Personal', callback_data: `audio_tipo:${gastoId}:personal` },
                { text: '🏢 Empresa', callback_data: `audio_tipo:${gastoId}:empresa` },
            ]],
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

    // --- Selección de empresa cuando el usuario tiene acceso a varias (Paso 33) ---

    // Antes (Paso 32) esto solo aplicaba a super_admin, que no tiene
    // empresa propia y ve "todas". Ahora (Paso 33) un admin/empleado
    // también puede tener acceso a más de una empresa (usuario_empresas),
    // así que el criterio pasa a ser simplemente "¿a cuántas empresas
    // tiene acceso?": si es una sola, se usa esa sin preguntar (mismo
    // comportamiento de siempre); si son varias, se pregunta con botones
    // y se corrige el gasto (que se había creado con una por defecto, ver
    // GastosService.obtenerEmpresaIdDeUsuario). Devuelve true si quedó
    // pendiente de respuesta, para que el caller no pregunte categoría
    // todavía (la categoría depende de la empresa).
    private async preguntarEmpresaSiFalta(
        chatId: number | string,
        gastoId: number,
        usuarioId: number,
    ): Promise<boolean> {
        const usuario = await this.usuariosService.obtenerPorId(usuarioId);
        if (!usuario) return false;

        const empresas =
            usuario.rol === 'super_admin'
                ? await this.empresasService.listar()
                : (await Promise.all(usuario.empresa_ids.map((id) => this.empresasService.obtenerPorId(id)))).filter(
                    (e): e is NonNullable<typeof e> => e != null,
                );
        if (empresas.length <= 1) return false;

        const filas = empresas.map((emp) => [
            { text: emp.nombre, callback_data: `empresa:${gastoId}:${emp.id}` },
        ]);
        await this.enviarMensaje(chatId, '🏢 ¿A qué empresa pertenece este gasto?', {
            inline_keyboard: filas,
        });
        return true;
    }

    // --- Matching de proveedor/categoría (sección 9) ---

    // Manda los botones de categoría + tipo de gasto (Personal/Empresa). El
    // proveedor viaja en el callback_data junto con el gasto para poder
    // guardar la sugerencia sin tener que volver a consultar el gasto.
    private async preguntarCategoria(
        chatId: number | string,
        gastoId: number,
        proveedorId: number | null,
    ) {
        if (!proveedorId) return; // sin nombre de empresa detectado, no hay a quién ligar la sugerencia
        const gasto = await this.gastosService.obtenerPorId(gastoId);
        const categorias = await this.categoriasService.listar(gasto.empresa_id);
        if (categorias.length === 0) return;

        const filas: Array<Array<{ text: string; callback_data: string }>> = [];
        for (let i = 0; i < categorias.length; i += 2) {
            filas.push(
                categorias.slice(i, i + 2).map((c) => ({
                    text: c.nombre,
                    callback_data: `cat:${gastoId}:${proveedorId}:${c.id}`,
                })),
            );
        }
        filas.push([{ text: '🚫 Sin categoría', callback_data: `cat:${gastoId}:${proveedorId}:0` }]);
        await this.enviarMensaje(chatId, '🏷️ ¿En qué categoría entra este gasto?', {
            inline_keyboard: filas,
        });
    }

    // Se llama después de resolver una confirmación/corrección de confianza,
    // igual que preguntarComprobanteSiFalta: si el gasto sigue sin
    // categoría asignada, recién ahí se pregunta.
    private async preguntarCategoriaSiFalta(chatId: number | string, gastoId: number, usuarioId: number) {
        // La empresa se pregunta primero porque la lista de categorías
        // depende de gasto.empresa_id (CategoriasService.listar(empresaId))
        // -- si queda pendiente, esperamos a la respuesta del callback
        // "empresa:" antes de preguntar categoría (ver manejarCallbackQuery).
        const empresaPendiente = await this.preguntarEmpresaSiFalta(chatId, gastoId, usuarioId);
        if (empresaPendiente) return;

        const gasto = await this.gastosService.obtenerPorId(gastoId);
        if (!gasto.categoria_id) {
            await this.preguntarCategoria(chatId, gastoId, gasto.proveedor_id ?? null);
        }
    }

    // Botón "Personal" / "Empresa" para completar la clasificación después
    // de elegir categoría. gastoId, proveedorId y categoriaId viajan en el
    // callback_data para no tener que recordar estado entre pasos.
    //
    // Paso 33: si el usuario tiene puede_registrar_personal = false, ni
    // siquiera se le ofrece el botón "Personal" -- se clasifica directo
    // como gasto de empresa (finalizarClasificacion), sin preguntar nada.
    private async preguntarTipoGasto(
        chatId: number | string,
        gastoId: number,
        proveedorId: number,
        categoriaId: number,
        usuarioId: number,
    ) {
        const usuario = await this.usuariosService.obtenerPorId(usuarioId);
        if (usuario && !usuario.puede_registrar_personal) {
            await this.finalizarClasificacion(chatId, gastoId, proveedorId, categoriaId, false);
            return;
        }

        await this.enviarMensaje(chatId, '¿Es un gasto personal o de la empresa?', {
            inline_keyboard: [
                [
                    {
                        text: '🙋 Personal',
                        callback_data: `tipo:${gastoId}:${proveedorId}:${categoriaId}:personal`,
                    },
                    {
                        text: '🏢 Empresa',
                        callback_data: `tipo:${gastoId}:${proveedorId}:${categoriaId}:empresa`,
                    },
                ],
            ],
        });
    }

    // Último paso de la clasificación: guarda categoría + tipo de gasto en
    // el gasto y la sugerencia en el proveedor (aprendizaje progresivo,
    // sección 9), para que la próxima vez no se pregunte. Extraído a un
    // método aparte (Paso 33) porque ahora hay dos caminos para llegar
    // acá: el botón "tipo:" de siempre, o directo desde
    // preguntarTipoGasto() cuando el usuario tiene puede_registrar_personal
    // = false (nunca se le pregunta, se asume "empresa").
    private async finalizarClasificacion(
        chatId: number | string,
        gastoId: number,
        proveedorId: number,
        categoriaId: number,
        esPersonal: boolean,
    ) {
        await this.gastosService.actualizarCategoria(gastoId, categoriaId || null, esPersonal, proveedorId);
        const gastoParaEmpresa = await this.gastosService.obtenerPorId(gastoId);
        if (categoriaId) {
            await this.proveedoresService.guardarSugerencia(proveedorId, categoriaId, esPersonal, gastoParaEmpresa.empresa_id);
            await this.enviarMensaje(chatId, '✅ Clasificado. La próxima vez que aparezca este proveedor lo recordaré.');
        } else {
            await this.gastosService.actualizar(gastoId, { es_personal: esPersonal });
            await this.enviarMensaje(chatId, esPersonal ? '🙋 Guardado como personal.' : '🏢 Guardado como empresa.');
        }

        // RF-11: última pregunta de la cadena (empresa → categoría → tipo →
        // pedido). Va al final porque la lista de pedidos depende de la
        // empresa ya resuelta, y porque es la única opcional: si la empresa
        // no tiene pedidos activos, no se pregunta nada.
        await this.preguntarPedidoSiFalta(chatId, gastoId);
    }


    // --- Pedidos / proyectos (RF-11, §8/§12) ---

    // Pregunta a qué pedido pertenece el gasto, si la empresa tiene pedidos
    // activos y el gasto todavía no tiene uno. Se llama al final de la
    // clasificación (finalizarClasificacion), no antes: la lista de pedidos
    // depende de gasto.empresa_id, igual que la de categorías, así que para
    // cuando llegamos acá la empresa ya quedó resuelta.
    //
    // `pedidoMencionado` es el nombre que Gemini leyó de un audio/texto
    // libre ("para el pedido Dragon"), sin resolver. Si resuelve a UNA sola
    // coincidencia se propone directamente ("¿Es el pedido Dragon?"); si
    // resuelve a varias ("Dragon", "Dragon 2026") o a ninguna, se muestra
    // la lista completa -- nunca se asocia automáticamente (§19/§20: la IA
    // propone un nombre, el id siempre sale de la base de datos y el
    // usuario confirma).
    private async preguntarPedidoSiFalta(
        chatId: number | string,
        gastoId: number,
        pedidoMencionado?: string | null,
    ) {
        const gasto = await this.gastosService.obtenerPorId(gastoId);
        if (gasto.pedido_id) return; // ya tiene pedido, no hay nada que preguntar
        if (!gasto.empresa_id) return;

        const activos = await this.pedidosService.listarActivos(gasto.empresa_id);
        if (activos.length === 0) return; // la empresa no usa pedidos: no molestamos

        if (pedidoMencionado) {
            const coincidencias = await this.pedidosService.buscarPorNombre(pedidoMencionado, gasto.empresa_id);
            if (coincidencias.length === 1) {
                const p = coincidencias[0];
                await this.enviarMensaje(chatId, `📦 ¿Este gasto corresponde al pedido "${p.nombre}"?`, {
                    inline_keyboard: [
                        [{ text: `✅ Sí, ${p.nombre}`, callback_data: `pedido:${gastoId}:${p.id}` }],
                        [{ text: '📋 Elegir otro', callback_data: `pedido_lista:${gastoId}` }],
                        [{ text: '🚫 Sin pedido', callback_data: `pedido:${gastoId}:0` }],
                    ],
                });
                return;
            }
            // 0 coincidencias (mencionó un pedido que no existe) o varias
            // (ambiguo): se cae a la lista completa, sin elegir por él.
        }

        await this.mostrarListaDePedidos(chatId, gastoId, activos);
    }

    // Botonera con los pedidos activos de la empresa del gasto. Extraído
    // aparte porque se llega acá por dos caminos: directo (sin mención de
    // pedido) o desde el botón "Elegir otro" de la propuesta.
    private async mostrarListaDePedidos(
        chatId: number | string,
        gastoId: number,
        activos?: Array<{ id: number; nombre: string }>,
    ) {
        let pedidos = activos;
        if (!pedidos) {
            const gasto = await this.gastosService.obtenerPorId(gastoId);
            if (!gasto.empresa_id) return;
            pedidos = await this.pedidosService.listarActivos(gasto.empresa_id);
        }
        if (pedidos.length === 0) return;

        // Dos por fila, mismo criterio visual que preguntarCategoria.
        const filas: Array<Array<{ text: string; callback_data: string }>> = [];
        for (let i = 0; i < pedidos.length; i += 2) {
            filas.push(
                pedidos.slice(i, i + 2).map((p) => ({
                    text: p.nombre,
                    callback_data: `pedido:${gastoId}:${p.id}`,
                })),
            );
        }
        // pedido_id 0 = "sin pedido" (se guarda como null). Se usa 0 y no
        // una acción aparte para que el chequeo de dueño del gasto en
        // manejarCallbackQuery cubra este caso con la misma regla.
        filas.push([{ text: '🚫 Sin pedido', callback_data: `pedido:${gastoId}:0` }]);

        await this.enviarMensaje(chatId, '📦 ¿A qué pedido corresponde este gasto?', {
            inline_keyboard: filas,
        });
    }

    // --- Heurística de agrupación: confirmación con botones Sí/No ---

    private async confirmarAgrupacion(
        chatId: number | string,
        vinculadoA: {
            gasto_id: number;
            monto: number;
            comprobante_id: number | null;
            evidencia_id: number | null;
            pago_id: number | null;
        },
    ) {
        const comp = vinculadoA.comprobante_id ?? 0;
        const evid = vinculadoA.evidencia_id ?? 0;
        const pago = vinculadoA.pago_id ?? 0;
        await this.enviarMensaje(
            chatId,
            `🔗 Vinculé este comprobante al gasto de S/ ${vinculadoA.monto} que registraste hace poco. ¿Es correcto?`,
            {
                inline_keyboard: [
                    [
                        {
                            text: '✅ Sí, es correcto',
                            callback_data: `agrupar_si:${vinculadoA.gasto_id}:${comp}:${evid}:${pago}`,
                        },
                        {
                            text: '❌ No, es otro gasto',
                            callback_data: `agrupar_no:${vinculadoA.gasto_id}:${comp}:${evid}:${pago}`,
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
            `⚠️ No estoy 100% seguro de haber leído bien este comprobante (monto detectado: S/ ${Number(montoDetectado).toFixed(2)}). ¿Está correcto?`,
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
            `🔎 No pude leer bien este comprobante (monto detectado: S/ ${Number(montoDetectado).toFixed(2)}, puede estar mal). ` +
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
        await this.enviarMensaje(chatId, `✅ Listo, corregí el monto a S/ ${monto.toFixed(2)}.`);
        const gasto = await this.gastosService.obtenerPorId(gastoId);
        // Audio: sin proveedor ni comprobante → flujo empresa → personal/empresa → comprobante.
        // Imagen: tiene proveedor → flujo comprobante → categoría.
        if (!gasto.proveedor_id) {
            const empresaPendiente = await this.preguntarEmpresaSiFalta(chatId, gastoId, gasto.usuario_id);
            if (!empresaPendiente) {
                await this.preguntarTipoParaAudio(chatId, gastoId, gasto.usuario_id);
            }
        } else {
            await this.preguntarComprobanteSiFalta(chatId, gastoId);
            await this.preguntarCategoriaSiFalta(chatId, gastoId, gasto.usuario_id);
        }
    }

    private async manejarTipoCambio(chatId: number | string, gastoId: number, texto: string) {
        const normalizado = texto.trim().replace(',', '.').replace(/[^\d.]/g, '');
        const tasa = normalizado ? parseFloat(normalizado) : NaN;

        if (!normalizado || isNaN(tasa) || tasa < 1 || tasa > 20) {
            await this.enviarMensaje(
                chatId,
                '❌ Tipo de cambio no válido. Respóndeme solo el número, ej: 3.80',
            );
            return;
        }

        const gasto = await this.gastosService.obtenerPorId(gastoId);
        const montoUSD = Number(gasto.monto);
        const montoPEN = Math.round(montoUSD * tasa * 100) / 100;

        await this.gastosService.corregirMonto(gastoId, montoPEN);
        await this.telegramEstado.limpiar(Number(chatId));
        await this.enviarMensaje(
            chatId,
            `✅ Convertido: $${montoUSD.toFixed(2)} × ${tasa} = S/ ${montoPEN.toFixed(2)}`,
        );
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
            const usuario = await this.usuariosService.estaAutorizado(chatId);
            if (!usuario) return;

            if (accion === 'comprobante_no') {
                await this.enviarMensaje(chatId, '👍 Listo, gasto guardado sin comprobante.');
                return;
            }

            // Acciones que operan directamente sobre un gasto: se verifica
            // que el gasto le pertenezca al usuario que apretó el botón,
            // para que nadie pueda confirmar/corregir/adjuntar cosas sobre
            // un gasto ajeno mandando un callback_data armado a mano.
            const accionesSobreGasto = ['comprobante_si', 'agregar_comprobante', 'media_ok', 'media_no', 'dup_si', 'dup_no', 'cat', 'tipo', 'audio_tipo', 'empresa', 'pedido', 'pedido_lista', 'audio_mix_personal', 'audio_mix_empresa', 'audio_mix_separar', 'item_tipo'];
            if (accionesSobreGasto.includes(accion)) {
                if (!gastoId || !(await this.esDuenoDelGasto(gastoId, usuario.id))) {
                    await this.enviarMensaje(chatId, '🚫 Ese gasto no te pertenece.');
                    return;
                }
            }

            if (accion === 'comprobante_si' || accion === 'agregar_comprobante') {
                await this.telegramEstado.guardar(Number(chatId), 'subir_comprobante', gastoId);
                await this.enviarMensaje(chatId, '📎 Envíame la foto o el PDF del comprobante.');
                return;
            }

            if (accion === 'agrupar_si') {
                await this.enviarMensaje(chatId, '👍 Perfecto, quedó todo junto en el mismo gasto.');
                return;
            }

            if (accion === 'agrupar_no') {
                // La heurística se equivocó: lo que se agrupó de más (comprobante
                // y/o evidencia y/o pago, según lo que trajera ese archivo) se
                // separa del gasto al que se había adjuntado, y pasa a tener su
                // propio gasto nuevo. No hace falta chequeo de dueño acá:
                // buscarCandidatoParaAgrupar (facturas.service.ts) solo agrupa
                // gastos del mismo usuario, así que este adjunto ya era del
                // usuario que aprieta el botón.
                const [, , compIdStr, evidIdStr, pagoIdStr] = data.split(':');
                const comprobanteId = Number(compIdStr) || null;
                const evidenciaId = Number(evidIdStr) || null;
                const pagoId = Number(pagoIdStr) || null;
                await this.gastosService.separarAdjunto(gastoId, comprobanteId, evidenciaId, pagoId, usuario.id);
                await this.enviarMensaje(chatId, '👍 Listo, lo registré como un gasto aparte.');
                return;
            }

            if (accion === 'media_ok') {
                await this.gastosService.confirmarConfianza(gastoId);
                await this.enviarMensaje(chatId, '👍 Perfecto, quedó confirmado.');
                await this.preguntarComprobanteSiFalta(chatId, gastoId);
                await this.preguntarCategoriaSiFalta(chatId, gastoId, usuario.id);
                // Si no hizo falta preguntar categoría (ya la tenía), la
                // cadena que termina en preguntarPedidoSiFalta no se dispara
                // -- se cubre acá. preguntarPedidoSiFalta ya sale temprano si
                // el gasto tiene pedido, así que no duplica la pregunta.
                const gastoTrasConfirmar = await this.gastosService.obtenerPorId(gastoId);
                if (gastoTrasConfirmar.categoria_id) {
                    await this.preguntarPedidoSiFalta(chatId, gastoId);
                }
                return;
            }

            if (accion === 'media_no') {
                await this.telegramEstado.guardar(Number(chatId), 'confirmar_monto', gastoId);
                await this.enviarMensaje(chatId, '✏️ Ok, respóndeme solo el número con el monto correcto, ej: 45.50');
                return;
            }

            // Posible duplicado nivel "media" (sección 17): el usuario
            // resuelve la duda que dejó avisarPosibleDuplicado.
            if (accion === 'dup_si') {
                // Confirma que sí era el mismo pago: se deja la marca
                // posible_duplicado_de tal cual (no se borra nada, para no
                // perder trazabilidad — el reporte podrá filtrarlo después),
                // pero se apaga pendiente_revision porque ya lo validó una
                // persona -- si no, este gasto quedaría para siempre en
                // cualquier vista de "pendientes" aunque ya esté resuelto.
                await this.gastosService.confirmarDuplicado(gastoId);
                await this.enviarMensaje(
                    chatId,
                    '🗑️ Anotado, queda marcado como duplicado para el reporte.',
                );
                return;
            }

            if (accion === 'dup_no') {
                // Era un gasto distinto que coincidió por casualidad: se
                // limpia la marca y pendiente_revision.
                await this.gastosService.descartarDuplicado(gastoId);
                await this.enviarMensaje(chatId, '✅ Listo, quedó como un gasto distinto.');
                return;
            }

            // Respondido "¿Personal o empresa?" para un gasto de audio.
            if (accion === 'audio_tipo') {
                const esPersonal = segundoIdStr === 'personal';
                await this.gastosService.actualizar(gastoId, { es_personal: esPersonal });
                await this.enviarMensaje(
                    chatId,
                    esPersonal ? '🙋 Guardado como gasto personal.' : '🏢 Guardado como gasto de empresa.',
                );
                await this.preguntarSiTieneComprobante(chatId, gastoId);
                return;
            }

            // Ítems mixtos: usuario eligió "todo personal" o "todo empresa".
            if (accion === 'audio_mix_personal' || accion === 'audio_mix_empresa') {
                const esPersonal = accion === 'audio_mix_personal';
                await this.gastosService.actualizar(gastoId, { es_personal: esPersonal });
                await this.enviarMensaje(
                    chatId,
                    esPersonal ? '🙋 Guardado como gasto personal.' : '🏢 Guardado como gasto de empresa.',
                );
                await this.preguntarSiTieneComprobante(chatId, gastoId);
                return;
            }

            // Ítems mixtos: usuario eligió separar en dos gastos.
            if (accion === 'audio_mix_separar') {
                const [, , montoPStr, montoEStr] = data.split(':');
                const montoPersonal = parseFloat(montoPStr) || 0;
                const montoEmpresa = parseFloat(montoEStr) || 0;
                const gastoOriginal = await this.gastosService.obtenerPorId(gastoId);
                // Gasto original pasa a ser el de empresa.
                await this.gastosService.actualizar(gastoId, { es_personal: false, monto: montoEmpresa });
                // Nuevo gasto para la parte personal, con el mismo audio como evidencia.
                if (montoPersonal > 0) {
                    const audioEv = (gastoOriginal.evidencias as any[])?.find((e: any) => e.tipo === 'audio');
                    await this.gastosService.crear({
                        usuario_id: usuario.id,
                        empresa_id: gastoOriginal.empresa_id,
                        descripcion: gastoOriginal.descripcion,
                        monto: montoPersonal,
                        fecha: gastoOriginal.fecha,
                        es_personal: true,
                        confianza: 'alta',
                        evidencia: audioEv
                            ? { tipo: audioEv.tipo, storage_path: audioEv.storage_path, origen: audioEv.origen ?? 'telegram' }
                            : undefined,
                    });
                }
                await this.enviarMensaje(
                    chatId,
                    `✂️ Separado.\n🏢 Empresa: S/ ${montoEmpresa.toFixed(2)}\n🙋 Personal: S/ ${montoPersonal.toFixed(2)}`,
                );
                await this.preguntarSiTieneComprobante(chatId, gastoId);
                return;
            }

            // Clasificación per-ítem: usuario respondió si un ítem es personal o empresa.
            // callback_data: item_tipo:<gastoId>:<tipo>   (tipo = 'personal' | 'empresa')
            if (accion === 'item_tipo') {
                const tipo = segundoIdStr as 'personal' | 'empresa';
                const estado = await this.telegramEstado.obtener(Number(chatId));
                const meta = estado?.meta as { items: any[]; idx: number } | null;
                if (!meta) return;
                const items = meta.items;
                const idx = meta.idx;
                items[idx].tipo_gasto = tipo;
                const nextIdx = idx + 1;
                if (nextIdx < items.length) {
                    const nextItem = items[nextIdx];
                    await this.telegramEstado.guardar(Number(chatId), 'clasificar_item', gastoId, { items, idx: nextIdx });
                    await this.enviarMensaje(
                        chatId,
                        `¿<b>${nextItem.producto}</b> es personal o de la empresa?`,
                        {
                            inline_keyboard: [
                                [
                                    { text: '🙋 Personal', callback_data: `item_tipo:${gastoId}:personal` },
                                    { text: '🏢 Empresa', callback_data: `item_tipo:${gastoId}:empresa` },
                                ],
                            ],
                        },
                    );
                } else {
                    await this.telegramEstado.limpiar(Number(chatId));
                    await this.manejarTipoAudioConItems(chatId, gastoId, items, usuario.id);
                }
                return;
            }

            // Respondió a "¿A qué empresa pertenece este gasto?" (Paso 32/33).
            // Se corrige el gasto (se había creado con la empresa por
            // defecto) y recién ahí se retoma la pregunta de categoría, que
            // depende de la empresa correcta.
            if (accion === 'empresa') {
                const empresaId = Number(segundoIdStr);
                await this.gastosService.actualizarEmpresa(gastoId, empresaId);
                const gasto = await this.gastosService.obtenerPorId(gastoId);
                if (!gasto.categoria_id) {
                    if (gasto.proveedor_id) {
                        // Imagen con proveedor nuevo: preguntar categoría.
                        await this.preguntarCategoria(chatId, gastoId, gasto.proveedor_id);
                    } else {
                        // Audio (o imagen sin proveedor): saltar categoría y
                        // preguntar si es personal o de empresa.
                        await this.preguntarTipoParaAudio(chatId, gastoId, usuario.id);
                    }
                } else {
                    // Proveedor ya conocido con categoría aprendida: la empresa
                    // es lo único que faltaba → ir directo a pedido.
                    await this.preguntarPedidoSiFalta(chatId, gastoId);
                }
                return;
            }

            // RF-11: eligió el pedido (o "Sin pedido", que llega como 0).
            // El id NO se confía tal cual: actualizar() valida contra
            // PedidosService.validarDeEmpresa que el pedido sea de la misma
            // empresa del gasto, así que un callback_data armado a mano con
            // un pedido de otra empresa rebota con 404.
            if (accion === 'pedido') {
                const pedidoId = Number(segundoIdStr) || null;
                if (!pedidoId) {
                    await this.enviarMensaje(chatId, '👍 Listo, queda sin pedido asignado.');
                    return;
                }
                const gastoActual = await this.gastosService.obtenerPorId(gastoId);
                const pedido = await this.pedidosService.validarDeEmpresa(pedidoId, gastoActual.empresa_id);
                await this.gastosService.actualizar(gastoId, { pedido_id: pedidoId });
                await this.enviarMensaje(chatId, `📦 Asociado al pedido "${pedido.nombre}".`);
                return;
            }

            // Botón "Elegir otro" de la propuesta de pedido: descarta lo que
            // Gemini había leído y muestra la lista completa.
            if (accion === 'pedido_lista') {
                await this.mostrarListaDePedidos(chatId, gastoId);
                return;
            }

            // Eligió categoría: falta el tipo de gasto (Personal/Empresa)
            // antes de guardar nada, así que se pregunta eso a continuación.
            // proveedorId y categoriaId viajan en el callback_data completo
            // (data), no en segundoIdStr, porque acá hay más de dos ids.
            if (accion === 'cat') {
                const [, , proveedorIdStr, categoriaIdStr] = data.split(':');
                const categoriaId = Number(categoriaIdStr);
                if (categoriaId === 0) {
                    // Usuario eligió "Sin categoría": saltar directo a tipo de gasto.
                    await this.preguntarTipoGasto(chatId, gastoId, Number(proveedorIdStr), 0, usuario.id);
                } else {
                    await this.preguntarTipoGasto(chatId, gastoId, Number(proveedorIdStr), categoriaId, usuario.id);
                }
                return;
            }

            // Último paso: ya con categoría + tipo de gasto, se actualiza el
            // gasto y se guarda la sugerencia en el proveedor.
            if (accion === 'tipo') {
                const [, , proveedorIdStr, categoriaIdStr, tipo] = data.split(':');
                await this.finalizarClasificacion(
                    chatId,
                    gastoId,
                    Number(proveedorIdStr),
                    Number(categoriaIdStr),
                    tipo === 'personal',
                );
                return;
            }
        } catch (err) {
            this.logger.error(`Error manejando callback de Telegram: ${err.message}`);
            await this.enviarMensaje(chatId, '❌ Hubo un error. Intenta de nuevo.').catch(() => undefined);
        }
    }

    // Chequea que el gasto exista y pertenezca al usuario dado. Se usa antes
    // de ejecutar cualquier acción de callback que actúe sobre un gasto
    // puntual, para que un callback_data armado a mano con un gasto_id
    // ajeno no pueda confirmar/corregir/adjuntar nada.
    private async esDuenoDelGasto(gastoId: number, usuarioId: number): Promise<boolean> {
        try {
            const gasto = await this.gastosService.obtenerPorId(gastoId);
            return gasto.usuario_id === usuarioId;
        } catch {
            return false; // gasto inexistente: tampoco es "suyo"
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

    // El error "Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON"
    // (visto en producción, factura de Rommax's, 16/09/2026) pasa cuando
    // `infoRes.json()` intenta parsear una respuesta que en realidad es una
    // página de error HTML, no el JSON que devuelve normalmente la API de
    // Telegram -- típicamente un 502/503/504 de un proxy/gateway en el
    // camino (Koyeb/Railway del lado de salida, o el propio Telegram caído
    // un momento), no un error de nuestro código. Antes esto reventaba con
    // un mensaje inútil ("Unexpected token...") sin decir qué status HTTP
    // llegó ni de qué endpoint. Ahora: se valida `res.ok` y el
    // `content-type` ANTES de parsear como JSON, se reintenta una vez tras
    // una pausa corta (por si fue un hiccup transitorio de red), y si
    // vuelve a fallar el error queda con el status HTTP real y un
    // fragmento del cuerpo crudo -- eso es lo que hace falta ver en los
    // logs para saber si el problema fue Telegram, la red de salida, o
    // otra cosa.
    private async fetchJsonConReintento(url: string, intentos = 2): Promise<any> {
        let ultimoError: unknown;
        for (let intento = 1; intento <= intentos; intento++) {
            try {
                const res = await fetch(url);
                const contentType = res.headers.get('content-type') ?? '';
                if (!res.ok || !contentType.includes('application/json')) {
                    const cuerpo = (await res.text()).slice(0, 300);
                    throw new Error(
                        `Respuesta no-JSON de Telegram (status ${res.status}, content-type "${contentType}"): ${cuerpo}`,
                    );
                }
                return await res.json();
            } catch (err) {
                ultimoError = err;
                this.logger.warn(
                    `descargarArchivo: intento ${intento}/${intentos} falló para ${url.replace(this.token!, '***')}: ${(err as Error).message}`,
                );
                if (intento < intentos) await new Promise((r) => setTimeout(r, 1500));
            }
        }
        throw ultimoError;
    }

    private async descargarArchivo(fileId: string): Promise<Buffer> {
        const info = await this.fetchJsonConReintento(`${this.apiBase}/getFile?file_id=${fileId}`);
        if (!info.ok) {
            throw new Error(`No se pudo obtener el archivo de Telegram: ${JSON.stringify(info)}`);
        }

        const filePath = info.result.file_path;
        const fileRes = await fetch(`${this.fileBase}/${filePath}`);
        if (!fileRes.ok) {
            throw new Error(`No se pudo descargar el archivo de Telegram (status ${fileRes.status}): ${filePath}`);
        }
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

        const moneda: 'PEN' | 'USD' = resultado.moneda === 'USD' ? 'USD' : 'PEN';
        const simbolo = moneda === 'USD' ? '$' : 'S/';
        const fmt = (n: number | null | undefined) =>
            n != null ? `${simbolo} ${Number(n).toFixed(2)}` : null;

        const items = Array.isArray(resultado.items) ? resultado.items : [];
        const lineas = items.map((item: any) => {
            const pu = item.precio_unitario != null && item.precio_unitario > 0 ? fmt(item.precio_unitario) : null;
            const cant = item.cantidad > 0 ? `${item.cantidad}` : '';
            const costo = item.costo > 0 ? fmt(item.costo) : (item.costo == null ? '-' : '?');
            const detalle = cant && pu ? `${cant} × ${pu}` : cant ? `${cant} ×` : '';
            return `• ${esc(item.producto)}${detalle ? '  ' + detalle : ''}  —  ${esc(costo)}`;
        });

        // Tres casos posibles: factura real (con comprobante en BD), captura
        // de pago suelta (Yape/transferencia, sin comprobante -- ver
        // "parece_factura" en facturas.service.ts), o audio sin comprobante.
        const medioLabel: Record<string, string> = {
            yape: 'Yape',
            transferencia: 'Transferencia',
            efectivo: 'Efectivo',
            tarjeta: 'Tarjeta',
        };

        let msg: string;
        if (resultado.parece_factura) {
            msg = '🧾 <b>Factura registrada</b>\n\n';
            if (resultado.empresa) msg += `🏢 <b>Empresa:</b> ${esc(resultado.empresa)}\n`;
            if (resultado.n_factura) msg += `🔢 <b>N° Factura:</b> ${esc(resultado.n_factura)}\n`;
        } else if (resultado.medio_pago) {
            // Captura de pago suelta: no hay comprobante propio, pero sí un
            // destinatario y un medio de pago que vale la pena mostrar.
            const medio = medioLabel[resultado.medio_pago] || esc(resultado.medio_pago);
            msg = `📲 <b>Pago registrado (${medio})</b>\n\n`;
            if (resultado.empresa) msg += `👤 <b>Destinatario:</b> ${esc(resultado.empresa)}\n`;
        } else {
            msg = '💬 <b>Gasto registrado</b> (sin comprobante)\n\n';
        }
        if (resultado.fecha) msg += `📅 <b>Fecha:</b> ${esc(resultado.fecha)}\n`;
        if (moneda === 'USD') msg += `💱 <b>Moneda:</b> Dólares (USD)\n`;
        if (lineas.length) msg += `\n<b>Productos:</b>\n${lineas.join('\n')}`;

        if (resultado.subtotal != null) msg += `\n\n💵 <b>Sub Total:</b> ${fmt(resultado.subtotal)}`;
        if (resultado.igv != null) msg += `\n📊 <b>IGV:</b> ${fmt(resultado.igv)}`;
        if (resultado.total != null) msg += `\n💰 <b>Total:</b> ${fmt(resultado.total)}`;

        if (moneda === 'USD') {
            msg += `\n\n⚠️ <i>El gasto está en dólares ($). Responde con el tipo de cambio para convertirlo a soles (ej: 3.80).</i>`;
        }

        return msg;
    }
}