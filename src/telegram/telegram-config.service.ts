import { BadGatewayException, BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// Ruta del webhook que recibe los updates (TelegramController).
export const RUTA_WEBHOOK = '/facturas/telegram/webhook';

export interface EstadoBot {
    token_configurado: boolean;
    secret_configurado: boolean;
    bot: { username: string; nombre: string } | null;
    webhook: {
        url: string | null;
        base_url: string | null;
        pendientes: number;
        ultimo_error: string | null;
        ultimo_error_en: string | null;
    } | null;
    ruta_webhook: string;
}

// Conectar el bot de Telegram con el backend desde el panel: si el backend
// cambia de dominio, el propietario vuelve a apuntar el webhook sin tocar la
// API de Telegram a mano. El token y el secret siguen viviendo en variables
// de entorno (TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET), nunca en la base.
@Injectable()
export class TelegramConfigService {
    constructor(private config: ConfigService) { }

    private get token(): string {
        const t = this.config.get<string>('TELEGRAM_BOT_TOKEN');
        if (!t) throw new ServiceUnavailableException('Falta configurar TELEGRAM_BOT_TOKEN en el backend.');
        return t;
    }

    private async llamar<T>(metodo: string, body?: Record<string, unknown>): Promise<T> {
        let res: Response;
        try {
            res = await fetch(`https://api.telegram.org/bot${this.token}/${metodo}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body ?? {}),
            });
        } catch {
            throw new BadGatewayException('No se pudo conectar con Telegram.');
        }
        const data = (await res.json().catch(() => null)) as { ok: boolean; result?: T; description?: string } | null;
        if (!data?.ok) throw new BadGatewayException(`Telegram respondió: ${data?.description ?? res.status}`);
        return data.result as T;
    }

    async estado(): Promise<EstadoBot> {
        const secret = !!this.config.get<string>('TELEGRAM_WEBHOOK_SECRET');
        if (!this.config.get<string>('TELEGRAM_BOT_TOKEN')) {
            return { token_configurado: false, secret_configurado: secret, bot: null, webhook: null, ruta_webhook: RUTA_WEBHOOK };
        }
        const [yo, info] = await Promise.all([
            this.llamar<{ username: string; first_name: string }>('getMe'),
            this.llamar<{ url: string; pending_update_count: number; last_error_message?: string; last_error_date?: number }>('getWebhookInfo'),
        ]);
        const url = info.url || null;
        return {
            token_configurado: true,
            secret_configurado: secret,
            bot: { username: yo.username, nombre: yo.first_name },
            webhook: {
                url,
                base_url: url && url.endsWith(RUTA_WEBHOOK) ? url.slice(0, -RUTA_WEBHOOK.length) : null,
                pendientes: info.pending_update_count ?? 0,
                ultimo_error: info.last_error_message ?? null,
                ultimo_error_en: info.last_error_date ? new Date(info.last_error_date * 1000).toISOString() : null,
            },
            ruta_webhook: RUTA_WEBHOOK,
        };
    }

    // Apunta el bot a `${baseUrl}/facturas/telegram/webhook`. Telegram exige HTTPS.
    async conectar(baseUrl: string): Promise<EstadoBot> {
        const base = normalizarBaseUrl(baseUrl);
        const secret = this.config.get<string>('TELEGRAM_WEBHOOK_SECRET');
        await this.llamar('setWebhook', { url: base + RUTA_WEBHOOK, ...(secret ? { secret_token: secret } : {}) });
        return this.estado();
    }

    // Deja el bot sin webhook: los mensajes quedan en cola en Telegram hasta reconectarlo.
    async desconectar(): Promise<EstadoBot> {
        await this.llamar('deleteWebhook', { drop_pending_updates: false });
        return this.estado();
    }
}

export function normalizarBaseUrl(valor: string): string {
    let url: URL;
    try {
        url = new URL((valor ?? '').trim());
    } catch {
        throw new BadRequestException('Escribe una URL válida, por ejemplo https://api.tudominio.com');
    }
    if (url.protocol !== 'https:') throw new BadRequestException('Telegram solo acepta direcciones https://');
    if (url.search || url.hash || url.username || url.password) throw new BadRequestException('La URL no debe llevar parámetros ni credenciales.');
    const path = url.pathname.replace(/\/+$/, '');
    // Si pegan la URL completa del webhook, se queda solo con la base.
    const base = path.endsWith(RUTA_WEBHOOK) ? path.slice(0, -RUTA_WEBHOOK.length) : path;
    return url.origin + base;
}
