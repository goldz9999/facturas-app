import { Injectable } from '@nestjs/common';
import { SupabaseService } from './supabase.service';

export interface UsuarioContexto {
    id: number;
    email: string | null;
    rol: string;
    activo: boolean;
    empresa_ids: number[];
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
            .select('id, email, rol, activo, puede_registrar_personal, ultima_empresa_id, usuario_empresas(empresa_id)')
            .eq('id', usuarioId)
            .maybeSingle();

        if (error) throw new Error(`Error consultando usuario: ${error.message}`);
        if (!data) return null;

        return {
            id: data.id,
            email: data.email,
            rol: data.rol,
            activo: data.activo,
            puede_registrar_personal: data.puede_registrar_personal,
            ultima_empresa_id: data.ultima_empresa_id ?? null,
            empresa_ids: (data.usuario_empresas ?? []).map((e: { empresa_id: number }) => e.empresa_id),
        };
    }
}