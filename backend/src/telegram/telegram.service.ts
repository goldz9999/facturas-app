import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FacturasService, ArchivoEntrada } from '../facturas/facturas.service';
import { ModoService } from '../facturas/modo.service';
import { UsuariosService } from '../usuarios/usuarios.service';

interface TelegramUpdate {
    message?: {
        chat: { id: number | string };
        message_id: number;
        document?: { file_id: string; file_name?: string; mime_type?: string };
        photo?: Array<{ file_id: string }>;
        voice?: { file_id: string; mime_type?: string };
        text?: string;
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

            const archivo = await this.obtenerArchivo(message);
            if (!archivo) {
                // Es un mensaje de texto u otro tipo que no procesamos (equivalente
                // a las ramas vacías del "Switch Telegram1" de n8n).
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
                    ? await this.facturasService.procesarArchivoIndividual(archivo, usuario.id)
                    : await this.facturasService.reenviarArchivoAN8n(archivo);

            await this.enviarMensaje(chatId, this.armarMensaje(resultado));
        } catch (err) {
            this.logger.error(`Error procesando update de Telegram: ${err.message}`);
            await this.enviarMensaje(
                chatId,
                '❌ Hubo un error procesando tu factura. Intenta de nuevo en unos minutos.',
            ).catch(() => undefined);
        }
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

    private async enviarMensaje(chatId: number | string, texto: string) {
        await fetch(`${this.apiBase}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: texto,
                parse_mode: 'HTML',
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

        let msg = '🧾 <b>Factura registrada</b>\n\n';
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