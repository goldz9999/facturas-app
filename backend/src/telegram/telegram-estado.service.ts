import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { SupabaseService } from '../common/supabase.service';

export type EstadoEsperando = 'subir_comprobante' | 'confirmar_monto';

export interface TelegramEstado {
    id: number;
    telegram_id: number;
    esperando: EstadoEsperando;
    gasto_id: number | null;
    expira_en: string;
}

// Persiste el estado conversacional del bot (a qué está esperando responder
// cada chat) en Supabase, para sobrevivir reinicios del backend en Railway/Koyeb.
@Injectable()
export class TelegramEstadoService {
    private readonly TTL_MINUTOS = 10;

    constructor(private supabase: SupabaseService) { }

    async guardar(telegramId: number, esperando: EstadoEsperando, gastoId?: number | null) {
        const expiraEn = new Date(Date.now() + this.TTL_MINUTOS * 60 * 1000).toISOString();

        // telegram_id es UNIQUE: upsert reemplaza cualquier estado previo de ese chat.
        const { error } = await this.supabase
            .getClient()
            .from('telegram_estado')
            .upsert(
                {
                    telegram_id: telegramId,
                    esperando,
                    gasto_id: gastoId ?? null,
                    expira_en: expiraEn,
                },
                { onConflict: 'telegram_id' },
            );

        if (error) {
            throw new InternalServerErrorException(`Error guardando estado de Telegram: ${error.message}`);
        }
    }

    // Devuelve el estado vigente del chat, o null si no hay ninguno o ya expiró.
    async obtener(telegramId: number): Promise<TelegramEstado | null> {
        const { data, error } = await this.supabase
            .getClient()
            .from('telegram_estado')
            .select('*')
            .eq('telegram_id', telegramId)
            .maybeSingle();

        if (error) {
            throw new InternalServerErrorException(`Error leyendo estado de Telegram: ${error.message}`);
        }
        if (!data) return null;

        if (new Date(data.expira_en).getTime() < Date.now()) {
            await this.limpiar(telegramId);
            return null;
        }

        return data as TelegramEstado;
    }

    async limpiar(telegramId: number) {
        const { error } = await this.supabase
            .getClient()
            .from('telegram_estado')
            .delete()
            .eq('telegram_id', telegramId);

        if (error) {
            throw new InternalServerErrorException(`Error limpiando estado de Telegram: ${error.message}`);
        }
    }
}