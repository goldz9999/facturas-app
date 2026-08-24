import { Body, Controller, Post } from '@nestjs/common';
import { TelegramService } from './telegram.service';

@Controller('facturas/telegram')
export class TelegramController {
    constructor(private readonly telegramService: TelegramService) { }

    // Webhook que reemplaza al "Telegram Trigger1" de n8n. Configúralo con:
    // https://api.telegram.org/bot<TOKEN>/setWebhook?url=<TU_BACKEND>/facturas/telegram/webhook
    @Post('webhook')
    async telegramWebhook(@Body() update: any) {
        // Se responde 200 de inmediato; el procesamiento (incluyendo el mensaje
        // de vuelta al chat) ocurre por fuera para no bloquear a Telegram.
        this.telegramService.handleUpdate(update).catch(() => undefined);
        return { ok: true };
    }
}