import { Injectable, NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { SupabaseService } from '../common/supabase.service';
import { CrearUsuarioDto } from './dto/crear-usuario.dto';
import { ActualizarUsuarioDto } from './dto/actualizar-usuario.dto';
import { EmpresasService } from '../empresas/empresas.service';

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
    constructor(
        private supabaseService: SupabaseService,
        private empresasService: EmpresasService,
    ) { }

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

    async listar(empresaId?: number): Promise<Usuario[]> {
        let query = this.supabaseService
            .getClient()
            .from('usuarios')
            .select('*')
            .order('creado_en', { ascending: false });

        if (empresaId !== undefined) {
            query = query.eq('empresa_id', empresaId);
        }

        const { data, error } = await query;

        if (error) throw new Error(`Error listando usuarios: ${error.message}`);
        return data ?? [];
    }

    async crear(dto: CrearUsuarioDto, forzarEmpresaId?: number): Promise<Usuario> {
        // Si quien llama es admin de una empresa (no super_admin), forzarEmpresaId
        // llega seteado desde el controller y pisa cualquier empresa_id del body:
        // un admin nunca puede crear usuarios para otra empresa.
        // Si no viene empresa_id explícito ni forzado, se asigna a la empresa por
        // defecto (hoy solo existe una). Cuando exista más de una empresa,
        // omitir este campo seguirá funcionando (cae en la primera
        // registrada por id), pero deja de ser una elección segura -- en ese
        // momento habría que exigir el campo en vez de asumir un default.
        const empresaId =
            forzarEmpresaId ?? dto.empresa_id ?? (await this.empresasService.obtenerPorDefecto())?.id ?? null;

        const passwordHash = dto.password ? await bcrypt.hash(dto.password, 10) : null;

        const { data, error } = await this.supabaseService
            .getClient()
            .from('usuarios')
            .insert({
                telegram_id: dto.telegram_id,
                nombre: dto.nombre ?? null,
                rol: dto.rol ?? 'empleado',
                activo: dto.activo ?? true,
                empresa_id: empresaId,
                email: dto.email ?? null,
                password_hash: passwordHash,
            })
            .select('*')
            .single();

        if (error) throw new Error(`Error creando usuario: ${error.message}`);
        return data;
    }

    // empresaId presente = quien llama es admin de empresa: solo puede tocar
    // usuarios de su propia empresa (mismo patrón que crear/listar).
    async actualizar(id: number, dto: ActualizarUsuarioDto, empresaIdPermitido?: number): Promise<Usuario> {
        if (empresaIdPermitido !== undefined) {
            await this.verificarPerteneceAEmpresa(id, empresaIdPermitido);
        }

        const cambios: Record<string, unknown> = {};
        if (dto.nombre !== undefined) cambios.nombre = dto.nombre;
        if (dto.email !== undefined) cambios.email = dto.email;
        if (dto.rol !== undefined) cambios.rol = dto.rol;
        if (dto.activo !== undefined) cambios.activo = dto.activo;
        if (dto.password) cambios.password_hash = await bcrypt.hash(dto.password, 10);
        // Reasignar empresa solo tiene sentido para quien puede ver todas
        // (super_admin, empresaIdPermitido === undefined). Un admin de
        // empresa nunca debería poder cambiar la empresa de nadie.
        if (dto.empresa_id !== undefined && empresaIdPermitido === undefined) {
            cambios.empresa_id = dto.empresa_id;
        }

        const { data, error } = await this.supabaseService
            .getClient()
            .from('usuarios')
            .update(cambios)
            .eq('id', id)
            .select('*')
            .maybeSingle();

        if (error) throw new Error(`Error actualizando usuario: ${error.message}`);
        if (!data) throw new NotFoundException(`Usuario ${id} no encontrado`);
        return data;
    }

    // Borrado real (distinto de desactivar). Los gastos que haya generado
    // este usuario NO se borran ni quedan huérfanos: conservan su nombre
    // como snapshot de texto (`gastos.usuario_nombre`) y su `usuario_id`
    // simplemente queda en null (ON DELETE SET NULL en la FK). Así se puede
    // dar de baja a alguien que ya no trabaja en la empresa sin perder el
    // historial de a quién pertenecía cada gasto.
    async eliminar(id: number, empresaIdPermitido?: number): Promise<void> {
        if (empresaIdPermitido !== undefined) {
            await this.verificarPerteneceAEmpresa(id, empresaIdPermitido);
        }

        const { error } = await this.supabaseService.getClient().from('usuarios').delete().eq('id', id);

        if (error) {
            throw new Error(`Error eliminando usuario: ${error.message}`);
        }
    }

    private async verificarPerteneceAEmpresa(id: number, empresaId: number): Promise<void> {
        const { data, error } = await this.supabaseService
            .getClient()
            .from('usuarios')
            .select('id')
            .eq('id', id)
            .eq('empresa_id', empresaId)
            .maybeSingle();

        if (error) throw new Error(`Error verificando usuario: ${error.message}`);
        if (!data) throw new NotFoundException(`Usuario ${id} no encontrado en tu empresa`);
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