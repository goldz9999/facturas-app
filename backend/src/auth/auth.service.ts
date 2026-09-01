import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { SupabaseService } from '../common/supabase.service';
import { LoginDto } from './dto/login.dto';

export interface UsuarioAutenticado {
    id: number;
    nombre: string | null;
    email: string | null;
    rol: string;
    empresa_id: number | null;
}

@Injectable()
export class AuthService {
    constructor(
        private supabaseService: SupabaseService,
        private jwtService: JwtService,
    ) { }

    async login(dto: LoginDto): Promise<{ access_token: string; usuario: UsuarioAutenticado }> {
        const { data, error } = await this.supabaseService
            .getClient()
            .from('usuarios')
            .select('id, nombre, email, password_hash, rol, activo, empresa_id')
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

        const usuario: UsuarioAutenticado = {
            id: data.id,
            nombre: data.nombre,
            email: data.email,
            rol: data.rol,
            empresa_id: data.empresa_id,
        };

        const access_token = await this.jwtService.signAsync({
            sub: usuario.id,
            email: usuario.email,
            rol: usuario.rol,
            empresa_id: usuario.empresa_id,
        });

        return { access_token, usuario };
    }
}