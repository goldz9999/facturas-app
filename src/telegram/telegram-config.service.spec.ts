import { BadGatewayException, BadRequestException } from '@nestjs/common';
import { normalizarBaseUrl, TelegramConfigService } from './telegram-config.service';

const config = (vars: Record<string, string | undefined>) => ({ get: (k: string) => vars[k] }) as any;

describe('normalizarBaseUrl', () => {
    it('deja solo el origen y la base, sin barra final ni la ruta del webhook', () => {
        expect(normalizarBaseUrl(' https://api.rpsoft.pe/ ')).toBe('https://api.rpsoft.pe');
        expect(normalizarBaseUrl('https://x.pe/api/facturas/telegram/webhook')).toBe('https://x.pe/api');
    });
    it('rechaza http, texto inválido y URLs con parámetros', () => {
        expect(() => normalizarBaseUrl('http://x.pe')).toThrow(BadRequestException);
        expect(() => normalizarBaseUrl('no es url')).toThrow(BadRequestException);
        expect(() => normalizarBaseUrl('https://x.pe?a=1')).toThrow(BadRequestException);
    });
});

describe('TelegramConfigService', () => {
    const respuestas: Record<string, unknown> = {
        getMe: { username: 'siregg_bot', first_name: 'SIREGG' },
        getWebhookInfo: { url: 'https://api.rpsoft.pe/facturas/telegram/webhook', pending_update_count: 2, last_error_message: 'Timeout', last_error_date: 1790000000 },
        setWebhook: true,
        deleteWebhook: true,
    };
    let llamadas: { metodo: string; body: any }[];
    beforeEach(() => {
        llamadas = [];
        global.fetch = jest.fn(async (url: string, init: any) => {
            const metodo = url.split('/').pop()!;
            llamadas.push({ metodo, body: JSON.parse(init.body) });
            return { status: 200, json: async () => ({ ok: true, result: respuestas[metodo] }) } as any;
        }) as any;
    });

    it('sin token no llama a Telegram', async () => {
        const r = await new TelegramConfigService(config({})).estado();
        expect(r.token_configurado).toBe(false);
        expect(llamadas).toEqual([]);
    });

    it('estado: bot, URL base y último error', async () => {
        const r = await new TelegramConfigService(config({ TELEGRAM_BOT_TOKEN: 't' })).estado();
        expect(r.bot).toEqual({ username: 'siregg_bot', nombre: 'SIREGG' });
        expect(r.webhook).toMatchObject({ base_url: 'https://api.rpsoft.pe', pendientes: 2, ultimo_error: 'Timeout' });
    });

    it('conectar manda la URL completa y el secret', async () => {
        await new TelegramConfigService(config({ TELEGRAM_BOT_TOKEN: 't', TELEGRAM_WEBHOOK_SECRET: 's3' })).conectar('https://nuevo.pe/');
        expect(llamadas[0]).toEqual({ metodo: 'setWebhook', body: { url: 'https://nuevo.pe/facturas/telegram/webhook', secret_token: 's3' } });
    });

    it('un error de Telegram se informa', async () => {
        global.fetch = jest.fn(async () => ({ status: 400, json: async () => ({ ok: false, description: 'bad webhook' }) })) as any;
        await expect(new TelegramConfigService(config({ TELEGRAM_BOT_TOKEN: 't' })).conectar('https://x.pe')).rejects.toThrow(BadGatewayException);
    });
});
