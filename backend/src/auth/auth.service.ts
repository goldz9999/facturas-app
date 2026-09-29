import { ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { SupabaseService } from '../common/supabase.service';
import { LoginDto } from './dto/login.dto';
import { EmpresaRol, esSuperAdmin, puedeRegistrarPersonal } from './roles-empresa';
import { empresasConAlcance } from '../common/usuario-contexto.service';

export interface UsuarioAutenticado {
    id: number;
    nombre: string | null;
    email: string | null;
    rol: string;
    es_super_admin: boolean;
    empresa_ids: number[];
    empresas: EmpresaRol[];
    puede_registrar_personal: boolean;
    ultima_empresa_id: number | null;
}

@Injectable()
export class AuthService {
    constructor(
        private supabaseService: SupabaseService,
        private jwtService: JwtService,
    ) { }

    async login(dto: LoginDto): Promise<{ access_token: string; usuario: UsuarioAutenticado }> {
        // Paso 33: empresa_id (una sola FK) se reemplazó por la tabla
        // puente usuario_empresas -- se trae junto con el usuario en el
        // mismo select para no hacer una segunda consulta.
        const { data, error } = await this.supabaseService
            .getClient()
            .from('usuarios')
            .select('id, nombre, email, password_hash, rol, activo, es_super_admin, puede_registrar_personal, ultima_empresa_id, usuario_empresas(empresa_id, rol)')
            .eq('email', dto.email)
            .maybeSingle();

        if (error) throw new Error(`Error consultando usuarios: ${error.message}`);

        // Mismo mensaje tanto si el correo no existe como si la contraseña
        // es incorrecta, para no revelar qué correos están registrados.
        if (!data || !data.password_hash) {
            throw new UnauthorizedException('Credenciales inválidas');
        }

        if (!data.activo) {
            throw new UnauthorizedException('Usuario desactivado');
        }

        const passwordValida = await bcrypt.compare(dto.password, data.password_hash);
        if (!passwordValida) {
            throw new UnauthorizedException('Credenciales inválidas');
        }

        const empresas = await empresasConAlcance(this.supabaseService.getClient(), data.usuario_empresas as any, data.rol);
        const usuario: UsuarioAutenticado = {
            id: data.id,
            nombre: data.nombre,
            email: data.email,
            rol: data.rol,
            es_super_admin: esSuperAdmin(data),
            empresa_ids: empresas.map((e) => e.empresa_id),
            empresas,
            puede_registrar_personal: puedeRegistrarPersonal({ es_super_admin: esSuperAdmin(data), empresas, puede_registrar_personal: data.puede_registrar_personal }),
            ultima_empresa_id: data.ultima_empresa_id ?? null,
        };

        const access_token = await this.jwtService.signAsync({
            sub: usuario.id,
            email: usuario.email,
            rol: usuario.rol,
            empresa_ids: usuario.empresa_ids,
            puede_registrar_personal: usuario.puede_registrar_personal,
        });

        return { access_token, usuario };
    }

    // Guarda la última empresa activa del usuario para recordarla entre
    // navegadores/dispositivos. Valida el acceso igual que el resto de la
    // API: super_admin puede elegir cualquier empresa existente; los demás
    // solo entre las suyas (empresa_ids viene de la base, ver Paso 44).
    async establecerEmpresaActiva(
        usuario: { id: number; rol: string; empresa_ids: number[] },
        empresaId: number,
    ): Promise<{ ultima_empresa_id: number }> {
        if (usuario.rol === 'super_admin') {
            const { data, error } = await this.supabaseService
                .getClient()
                .from('empresas')
                .select('id')
                .eq('id', empresaId)
                .maybeSingle();
            if (error) throw new Error(`Error consultando empresas: ${error.message}`);
            if (!data) throw new NotFoundException('Esa empresa no existe.');
        } else if (!usuario.empresa_ids.includes(empresaId)) {
            throw new ForbiddenException('No tienes acceso a esa empresa.');
        }

        const { error } = await this.supabaseService
            .getClient()
            .from('usuarios')
            .update({ ultima_empresa_id: empresaId })
            .eq('id', usuario.id);
        if (error) throw new Error(`Error guardando la empresa activa: ${error.message}`);

        return { ultima_empresa_id: empresaId };
    }
}