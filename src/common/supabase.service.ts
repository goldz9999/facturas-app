// src/facturas/supabase.service.ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

@Injectable()
export class SupabaseService {
    private client: SupabaseClient;

    constructor(private config: ConfigService) {
        const url = this.config.get<string>('SUPABASE_URL');
        const key = this.config.get<string>('SUPABASE_KEY');

        if (!url || !key) {
            throw new Error(
                'Faltan SUPABASE_URL o SUPABASE_KEY en las variables de entorno (.env)',
            );
        }

        this.client = createClient(url, key);
    }

    getClient(): SupabaseClient {
        return this.client;
    }

    async buscarUsuarioPorTelegramId(telegramId: number | string) {
        const { data, error } = await this.client
            .from('usuarios')
            .select('id, nombre, rol, activo')
            .eq('telegram_id', telegramId)
            .maybeSingle();

        if (error) throw new Error(`Error consultando usuarios: ${error.message}`);
        return data; // null si no existe
    }
}