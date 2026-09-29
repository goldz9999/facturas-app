import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { SupabaseService } from '../common/supabase.service';
import { CrearUsuarioDto } from './dto/crear-usuario.dto';
import { ActualizarUsuarioDto } from './dto/actualizar-usuario.dto';
import { EmpresasService } from '../empresas/empresas.service';
import {
    EmpresaRol,
    empresasDeFilas,
    esSuperAdmin,
    puedeRegistrarPersonal,
    esRolEmpresa,
    RolEmpresa,
    rolEmpresaActualizado,
    rolEmpresaDesdeLegacy,
} from '../auth/roles-empresa';

// Paso 33: empresa_id (una sola FK) se reemplazó por la tabla puente
// usuario_empresas -- un usuario puede tener acceso a más de una empresa.
// `empresa_ids` no es una columna real: se arma en cada método uniendo con
// usuario_empresas, para no tener que tocar todos los callers que ya
// esperaban un objeto Usuario con la info de empresa adentro.
export interface Usuario {
    id: number;
    telegram_id: number;
    nombre: string | null;
    rol: string;
    activo: boolean;
    empresa_ids: number[];
    // Rol por empresa (usuario_empresas.rol). Nunca incluye el hash de contraseña.
    empresas: EmpresaRol[];
    tiene_password: boolean;
    es_super_admin?: boolean;
    puede_registrar_personal: boolean;
    creado_en: string;
}

interface FilaUsuario {
    id: number;
    telegram_id: number;
    nombre: string | null;
    rol: string;
    activo: boolean;
    puede_registrar_personal: boolean;
    creado_en: string;
    password_hash?: string | null;
    usuario_empresas?: Array<{ empresa_id: number; rol?: string | null }>;
}

const SELECT_CON_EMPRESAS = '*, usuario_empresas(empresa_id, rol)';

@Injectable()
export class UsuariosService {
    constructor(
        private supabaseService: SupabaseService,
        private empresasService: EmpresasService,
    ) { }

    private mapear(fila: FilaUsuario): Usuario {
        // El hash de la contraseña nunca sale del servicio: se reemplaza por un booleano.
        const { usuario_empresas, password_hash, ...resto } = fila;
        const empresas = empresasDeFilas(usuario_empresas ?? null, resto.rol);
        return {
            ...resto,
            // Permiso efectivo: un propietario siempre puede, aunque su flag esté apagado.
            puede_registrar_personal: puedeRegistrarPersonal({ es_super_admin: esSuperAdmin(resto as any), empresas, puede_registrar_personal: resto.puede_registrar_personal }),
            empresa_ids: empresas.map((e) => e.empresa_id),
            empresas,
            tiene_password: !!password_hash,
        };
    }

    async buscarPorTelegramId(telegramId: number | string): Promise<Usuario | null> {
        const { data, error } = await this.supabaseService
            .getClient()
            .from('usuarios')
            .select(SELECT_CON_EMPRESAS)
            .eq('telegram_id', telegramId)
            .maybeSingle();

        if (error) throw new Error(`Error consultando usuarios: ${error.message}`);
        return data ? this.mapear(data as unknown as FilaUsuario) : null;
    }

    // Usado por TelegramService (Paso 32/33) para saber el rol/permisos del
    // usuario dueño de un gasto (buscarPorTelegramId no sirve ahí porque en
    // esos puntos del flujo solo se tiene el usuarios.id interno, no el
    // telegram_id).
    async obtenerPorId(id: number): Promise<Usuario | null> {
        const { data, error } = await this.supabaseService
            .getClient()
            .from('usuarios')
            .select(SELECT_CON_EMPRESAS)
            .eq('id', id)
            .maybeSingle();

        if (error) throw new Error(`Error consultando usuarios: ${error.message}`);
        return data ? this.mapear(data as unknown as FilaUsuario) : null;
    }

    // empresaId: si viene, solo trae usuarios con acceso a esa empresa
    // (admin de empresa listando su equipo). super_admin llama sin filtro.
    async listar(empresaId?: number): Promise<Usuario[]> {
        let query = this.supabaseService
            .getClient()
            .from('usuarios')
            .select(SELECT_CON_EMPRESAS)
            .order('creado_en', { ascending: false });

        if (empresaId !== undefined) {
            // Filtra por usuarios que tengan una fila en usuario_empresas
            // para esa empresa (Supabase: filtro sobre tabla embebida).
            query = query.eq('usuario_empresas.empresa_id', empresaId);
        }

        const { data, error } = await query;
        if (error) throw new Error(`Error listando usuarios: ${error.message}`);

        const filas = (data ?? []) as unknown as FilaUsuario[];
        // El .eq sobre la tabla embebida filtra la fila anidada, no la fila
        // principal (puede devolver usuarios sin ninguna empresa si no
        // matchea) -- se descartan acá los que quedaron sin empresas tras
        // el filtro, para no listar usuarios ajenos a la empresa pedida.
        const usuarios = filas.map((f) => this.mapear(f));
        return empresaId !== undefined ? usuarios.filter((u) => u.empresa_ids.includes(empresaId)) : usuarios;
    }

    // empresaIds: a qué empresas queda asignado el usuario nuevo.
    // - Si quien crea es admin de empresa (no super_admin), el controller
    //   fuerza forzarEmpresaIds = [su propia empresa] y dto.empresa_ids se
    //   ignora: un admin nunca puede dar de alta a alguien en otra empresa.
    // - Si no viene ninguno ni forzado, se asigna a la empresa por defecto
    //   (hoy solo existe una) -- mismo comportamiento que antes de este
    //   paso.
    async crear(
        dto: CrearUsuarioDto,
        forzarEmpresaIds?: number[],
        alta?: { rol: string; rol_empresa: RolEmpresa },
    ): Promise<Usuario> {
        const rolLegacyAlta = alta?.rol ?? dto.rol ?? 'empleado';
        const rolEmpresaAlta = alta?.rol_empresa ?? rolEmpresaDesdeLegacy(rolLegacyAlta);
        let empresaIds = forzarEmpresaIds ?? dto.empresa_ids ?? [];
        if (empresaIds.length === 0) {
            const porDefecto = await this.empresasService.obtenerPorDefecto();
            if (porDefecto) empresaIds = [porDefecto.id];
        }

        const passwordHash = dto.password ? await bcrypt.hash(dto.password, 10) : null;

        const { data, error } = await this.supabaseService
            .getClient()
            .from('usuarios')
            .insert({
                telegram_id: dto.telegram_id,
                nombre: dto.nombre ?? null,
                rol: rolLegacyAlta,
                activo: dto.activo ?? true,
                email: dto.email ?? null,
                password_hash: passwordHash,
                // Nadie registra gastos personales salvo que un propietario lo permita.
                puede_registrar_personal: dto.puede_registrar_personal ?? false,
            })
            .select('*')
            .single();

        if (error) {
            if (error.code === '23505') throw new ConflictException('Ese correo ya está registrado.');
            throw new Error(`Error creando usuario: ${error.message}`);
        }

        if (empresaIds.length > 0) {
            await this.asignarEmpresas(data.id, empresaIds, rolEmpresaAlta);
        }

        return (await this.obtenerPorId(data.id))!;
    }

    // empresaIdPermitido presente = quien llama es admin de empresa: solo
    // puede tocar usuarios que ya tengan acceso a su propia empresa (mismo
    // patrón que crear/listar).
    async actualizar(id: number, dto: ActualizarUsuarioDto, empresaIdPermitido?: number, empresaIdRol?: number): Promise<Usuario> {
        if (empresaIdPermitido !== undefined) {
            await this.verificarPerteneceAEmpresa(id, empresaIdPermitido);
        }

        const cambios: Record<string, unknown> = {};
        if (dto.nombre !== undefined) cambios.nombre = dto.nombre;
        if (dto.email !== undefined) cambios.email = dto.email;
        // Un administrador de empresa (empresaIdPermitido) solo cambia el rol EN su empresa
        // (usuario_empresas.rol); el rol global de la cuenta lo decide un super_admin.
        if (dto.rol !== undefined && empresaIdPermitido === undefined) cambios.rol = dto.rol;
        if (dto.activo !== undefined) cambios.activo = dto.activo;
        if (dto.password) cambios.password_hash = await bcrypt.hash(dto.password, 10);
        if (dto.telegram_id !== undefined) cambios.telegram_id = dto.telegram_id;
        if (dto.puede_registrar_personal !== undefined) {
            cambios.puede_registrar_personal = dto.puede_registrar_personal;
        }

        if (Object.keys(cambios).length > 0) {
            const { error } = await this.supabaseService.getClient().from('usuarios').update(cambios).eq('id', id);
            if (error) throw new Error(`Error actualizando usuario: ${error.message}`);
        }

        if (dto.rol !== undefined) {
            await this.sincronizarRolEmpresas(id, dto.rol, empresaIdPermitido);
        }

        // Rol fino en UNA empresa: la del administrador que edita, o la que indica un super admin.
        if (dto.rol_empresa !== undefined) {
            const empresaId = empresaIdPermitido ?? empresaIdRol;
            if (empresaId === undefined) throw new BadRequestException('Indica la empresa para cambiar el rol.');
            await this.establecerRolEmpresa(id, empresaId, dto.rol_empresa);
        }

        // Reasignar empresas: solo quien puede ver todas (super_admin,
        // empresaIdPermitido === undefined) puede mandar la lista completa
        // de empresas de otro usuario. Un admin de empresa nunca debería
        // poder quitarle a alguien el acceso a una empresa que él ni
        // siquiera administra.
        if (dto.empresa_ids !== undefined && empresaIdPermitido === undefined) {
            const rolBase = dto.rol ?? (await this.rolGlobal(id));
            await this.asignarEmpresas(id, dto.empresa_ids, rolEmpresaDesdeLegacy(rolBase));
        }

        const actualizado = await this.obtenerPorId(id);
        if (!actualizado) throw new NotFoundException(`Usuario ${id} no encontrado`);
        return actualizado;
    }

    // Reemplaza por completo la lista de empresas del usuario (borra las
    // que ya no estén, inserta las nuevas). Usado por actualizar() y desde
    // TelegramService no hace falta -- ese flujo solo lee, nunca reasigna.
    async asignarEmpresas(usuarioId: number, empresaIds: number[], rolPorDefecto: RolEmpresa = 'empleado'): Promise<void> {
        const client = this.supabaseService.getClient();

        // Conserva el rol de las empresas que se mantienen; las nuevas reciben rolPorDefecto.
        const { data: previas, error: errorLectura } = await client
            .from('usuario_empresas')
            .select('empresa_id, rol')
            .eq('usuario_id', usuarioId);
        if (errorLectura) throw new Error(`Error reasignando empresas: ${errorLectura.message}`);
        const rolPrevio = new Map<number, RolEmpresa>(
            (previas ?? []).filter((f: any) => esRolEmpresa(f.rol)).map((f: any) => [f.empresa_id, f.rol as RolEmpresa]),
        );

        const { error: errorBorrado } = await client.from('usuario_empresas').delete().eq('usuario_id', usuarioId);
        if (errorBorrado) throw new Error(`Error reasignando empresas: ${errorBorrado.message}`);

        if (empresaIds.length === 0) return;
        const filas = empresaIds.map((empresaId) => ({
            usuario_id: usuarioId,
            empresa_id: empresaId,
            rol: rolPrevio.get(empresaId) ?? rolPorDefecto,
        }));
        const { error: errorInsert } = await client.from('usuario_empresas').insert(filas);
        if (errorInsert) throw new Error(`Error reasignando empresas: ${errorInsert.message}`);
    }

    // Aplica un cambio de rol legacy (admin/empleado) a las filas de
    // usuario_empresas sin pisar roles finos de la misma clase.
    private async sincronizarRolEmpresas(usuarioId: number, rolLegacyNuevo: string, soloEmpresaId?: number): Promise<void> {
        const client = this.supabaseService.getClient();
        let query = client.from('usuario_empresas').select('id, rol').eq('usuario_id', usuarioId);
        if (soloEmpresaId !== undefined) query = query.eq('empresa_id', soloEmpresaId);
        const { data, error } = await query;
        if (error) throw new Error(`Error leyendo roles por empresa: ${error.message}`);

        for (const fila of (data ?? []) as { id: number; rol: string | null }[]) {
            const nuevo = rolEmpresaActualizado(esRolEmpresa(fila.rol) ? fila.rol : 'empleado', rolLegacyNuevo);
            if (nuevo === fila.rol) continue;
            const { error: errorUpdate } = await client.from('usuario_empresas').update({ rol: nuevo }).eq('id', fila.id);
            if (errorUpdate) throw new Error(`Error actualizando rol por empresa: ${errorUpdate.message}`);
        }
    }

    private async establecerRolEmpresa(usuarioId: number, empresaId: number, rol: RolEmpresa): Promise<void> {
        const { error } = await this.supabaseService
            .getClient()
            .from('usuario_empresas')
            .update({ rol })
            .eq('usuario_id', usuarioId)
            .eq('empresa_id', empresaId);
        if (error) throw new Error(`Error actualizando rol por empresa: ${error.message}`);
    }

    private async rolGlobal(usuarioId: number): Promise<string> {
        const { data, error } = await this.supabaseService.getClient().from('usuarios').select('rol').eq('id', usuarioId).maybeSingle();
        if (error) throw new Error(`Error consultando el rol del usuario: ${error.message}`);
        return data?.rol ?? 'empleado';
    }

    // Borrado real (distinto de desactivar). Los gastos que haya generado
    // este usuario NO se borran ni quedan huérfanos: conservan su nombre
    // como snapshot de texto (`gastos.usuario_nombre`) y su `usuario_id`
    // simplemente queda en null (ON DELETE SET NULL en la FK). Así se puede
    // dar de baja a alguien que ya no trabaja en la empresa sin perder el
    // historial de a quién pertenecía cada gasto. usuario_empresas se borra
    // en cascada (ON DELETE CASCADE), no hace falta limpiarla a mano.
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
            .from('usuario_empresas')
            .select('usuario_id')
            .eq('usuario_id', id)
            .eq('empresa_id', empresaId)
            .maybeSingle();

        if (error) throw new Error(`Error verificando usuario: ${error.message}`);
        if (!data) throw new NotFoundException(`Usuario ${id} no encontrado en tu empresa`);
    }

    async desactivar(id: number, empresaIdPermitido?: number): Promise<Usuario> {
        if (empresaIdPermitido !== undefined) {
            await this.verificarPerteneceAEmpresa(id, empresaIdPermitido);
        }
        const { error } = await this.supabaseService
            .getClient()
            .from('usuarios')
            .update({ activo: false })
            .eq('id', id);

        if (error) throw new Error(`Error desactivando usuario: ${error.message}`);
        const actualizado = await this.obtenerPorId(id);
        if (!actualizado) throw new NotFoundException(`Usuario ${id} no encontrado`);
        return actualizado;
    }

    // Usado por TelegramService antes de procesar cualquier archivo.
    async estaAutorizado(telegramId: number | string): Promise<Usuario | null> {
        const usuario = await this.buscarPorTelegramId(telegramId);
        return usuario && usuario.activo ? usuario : null;
    }
}