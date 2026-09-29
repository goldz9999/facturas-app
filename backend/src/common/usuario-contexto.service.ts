import { Injectable } from '@nestjs/common';
import { SupabaseService } from './supabase.service';
import { SupabaseClient } from '@supabase/supabase-js';
import { EmpresaRol, ampliarPropietario, empresasDeFilas, esPropietarioEnAlguna, esSuperAdmin, puedeRegistrarPersonal } from '../auth/roles-empresa';

// Empresas del usuario con su rol. Un propietario ve además todas las empresas
// activas (como propietario): solo en ese caso se consulta la tabla empresas.
export async function empresasConAlcance(
    client: SupabaseClient,
    filas: { empresa_id: number; rol?: string | null }[] | null,
    rolGlobal: string,
): Promise<EmpresaRol[]> {
    const empresas = empresasDeFilas(filas, rolGlobal);
    if (!esPropietarioEnAlguna(empresas)) return empresas;
    const { data, error } = await client.from('empresas').select('id').eq('activa', true);
    if (error) throw new Error(`Error consultando empresas: ${error.message}`);
    return ampliarPropietario(empresas, (data ?? []).map((e: { id: number }) => e.id));
}

export interface UsuarioContexto {
    id: number;
    nombre: string | null;
    email: string | null;
    avatar_url: string | null;
    rol: string; // columna legacy usuarios.rol
    activo: boolean;
    es_super_admin: boolean;
    empresa_ids: number[];
    empresas: EmpresaRol[];
    puede_registrar_personal: boolean;
    ultima_empresa_id: number | null;
}

// Paso 44: fuente única de "quién es este usuario AHORA". Antes,
// JwtStrategy.validate() y GastosGateway confiaban en lo que el token
// traía congelado desde el login (rol, empresa_ids, puede_registrar_personal),
// así que un cambio de accesos hecho por un super_admin no tenía efecto hasta
// que el usuario volvía a iniciar sesión (o el token expiraba, 8h) -- y peor,
// quitarle una empresa a alguien no le cortaba el acceso a ella.
// Ahora se consulta la base en cada request (una sola query, con
// usuario_empresas embebida) y el token solo sirve para identificar al
// usuario (`sub`).
@Injectable()
export class UsuarioContextoService {
    constructor(private supabaseService: SupabaseService) { }

    // Devuelve null si el usuario ya no existe.
    async obtener(usuarioId: number): Promise<UsuarioContexto | null> {
        const { data, error } = await this.supabaseService
            .getClient()
            .from('usuarios')
            .select('id, nombre, email, avatar_url, rol, activo, es_super_admin, puede_registrar_personal, ultima_empresa_id, usuario_empresas(empresa_id, rol)')
            .eq('id', usuarioId)
            .maybeSingle();

        if (error) throw new Error(`Error consultando usuario: ${error.message}`);
        if (!data) return null;

        const empresas = await empresasConAlcance(this.supabaseService.getClient(), data.usuario_empresas as any, data.rol);
        return {
            id: data.id,
            nombre: data.nombre ?? null,
            email: data.email,
            avatar_url: data.avatar_url ?? null,
            rol: data.rol,
            activo: data.activo,
            es_super_admin: esSuperAdmin(data),
            // Permiso efectivo (propietario siempre; el resto según el flag).
            puede_registrar_personal: puedeRegistrarPersonal({ es_super_admin: esSuperAdmin(data), empresas, puede_registrar_personal: data.puede_registrar_personal }),
            ultima_empresa_id: data.ultima_empresa_id ?? null,
            empresa_ids: empresas.map((e) => e.empresa_id),
            empresas,
        };
    }
}