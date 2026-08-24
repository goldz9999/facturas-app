import { Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../common/supabase.service';
import { CrearUsuarioDto } from './dto/crear-usuario.dto';

export interface Usuario {
    id: number;
    telegram_id: number;
    nombre: string | null;
    rol: string;
    activo: boolean;
    empresa_id: number | null;
    creado_en: string;
}

@Injectable()
export class UsuariosService {
    constructor(private supabaseService: SupabaseService) { }

    async buscarPorTelegramId(telegramId: number | string): Promise<Usuario | null> {
        const { data, error } = await this.supabaseService
            .getClient()
            .from('usuarios')
            .select('*')
            .eq('telegram_id', telegramId)
            .maybeSingle();

        if (error) throw new Error(`Error consultando usuarios: ${error.message}`);
        return data;
    }

    async listar(): Promise<Usuario[]> {
        const { data, error } = await this.supabaseService
            .getClient()
            .from('usuarios')
            .select('*')
            .order('creado_en', { ascending: false });

        if (error) throw new Error(`Error listando usuarios: ${error.message}`);
        return data ?? [];
    }

    async crear(dto: CrearUsuarioDto): Promise<Usuario> {
        const { data, error } = await this.supabaseService
            .getClient()
            .from('usuarios')
            .insert({
                telegram_id: dto.telegram_id,
                nombre: dto.nombre ?? null,
                rol: dto.rol ?? 'empleado',
                activo: dto.activo ?? true,
            })
            .select('*')
            .single();

        if (error) throw new Error(`Error creando usuario: ${error.message}`);
        return data;
    }

    async desactivar(id: number): Promise<Usuario> {
        const { data, error } = await this.supabaseService
            .getClient()
            .from('usuarios')
            .update({ activo: false })
            .eq('id', id)
            .select('*')
            .maybeSingle();

        if (error) throw new Error(`Error desactivando usuario: ${error.message}`);
        if (!data) throw new NotFoundException(`Usuario ${id} no encontrado`);
        return data;
    }

    // Usado por TelegramService antes de procesar cualquier archivo.
    async estaAutorizado(telegramId: number | string): Promise<Usuario | null> {
        const usuario = await this.buscarPorTelegramId(telegramId);
        return usuario && usuario.activo ? usuario : null;
    }
}