import { Body, Controller, Headers, Post, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TelegramService } from './telegram.service';

@Controller('facturas/telegram')
export class TelegramController {
    constructor(
        private readonly telegramService: TelegramService,
        private readonly config: ConfigService,
    ) { }

    // Webhook que reemplaza al "Telegram Trigger1" de n8n. Configúralo con:
    // https://api.telegram.org/bot<TOKEN>/setWebhook?url=<TU_BACKEND>/facturas/telegram/webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>
    //
    // Hallazgo 37.4-C: antes se aceptaba cualquier cuerpo sin validar
    // origen -- quien conociera la URL (no es secreta: es la misma que
    // recibe el update, visible en logs/config) podía mandar "updates"
    // falsos haciéndose pasar por un telegram_id de la whitelist. Telegram
    // reenvía el `secret_token` configurado en setWebhook como el header
    // X-Telegram-Bot-Api-Secret-Token en cada request real; si no coincide
    // con TELEGRAM_WEBHOOK_SECRET, se rechaza antes de procesar nada.
    //
    // Si TELEGRAM_WEBHOOK_SECRET todavía no está configurado (despliegue
    // viejo, no se corrió setWebhook con secret_token todavía), no se
    // bloquea el webhook -- solo se loguea una advertencia una vez, para no
    // romper producción de golpe con este cambio. Configurar la variable y
    // volver a correr setWebhook con secret_token en cuanto se pueda.
    @Post('webhook')
    async telegramWebhook(
        @Body() update: any,
        @Headers('x-telegram-bot-api-secret-token') secretHeader: string | undefined,
    ) {
        // S4: la variable es obligatoria en producción. Si no está configurada
        // el arranque falla igual que con JWT_SECRET, pero aquí lo detectamos
        // en cada request para no romper despliegues en tránsito.
        const secretEsperado = this.config.get<string>('TELEGRAM_WEBHOOK_SECRET');
        if (!secretEsperado) {
            throw new UnauthorizedException('TELEGRAM_WEBHOOK_SECRET no configurado en el servidor');
        }
        if (secretHeader !== secretEsperado) {
            throw new UnauthorizedException('Secret token inválido');
        }
        // Se responde 200 de inmediato; el procesamiento (incluyendo el mensaje
        // de vuelta al chat) ocurre por fuera para no bloquear a Telegram.
        this.telegramService.handleUpdate(update).catch(() => undefined);
        return { ok: true };
    }
}