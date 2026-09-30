import { BadRequestException, ConflictException, ForbiddenException, Injectable, InternalServerErrorException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ActualizarPerfilDto } from './dto/actualizar-perfil.dto';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { SupabaseService } from '../common/supabase.service';
import { LoginDto } from './dto/login.dto';
import { EmpresaRol, esSuperAdmin, puedeGestionarTelegram, puedeRegistrarPersonal } from './roles-empresa';
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
    puede_gestionar_telegram: boolean;
    ultima_empresa_id: number | null;
    avatar_url: string | null;
}

const EXTENSION_IMAGEN: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

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
            .select('id, nombre, email, password_hash, rol, activo, es_super_admin, puede_registrar_personal, puede_gestionar_telegram, ultima_empresa_id, avatar_url, usuario_empresas(empresa_id, rol)')
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
            puede_gestionar_telegram: puedeGestionarTelegram({ es_super_admin: esSuperAdmin(data), empresas, puede_gestionar_telegram: data.puede_gestionar_telegram }),
            ultima_empresa_id: data.ultima_empresa_id ?? null,
            avatar_url: data.avatar_url ?? null,
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

    // Configuración personal: cada usuario edita su nombre, correo y contraseña.
    // Correo y contraseña piden la contraseña actual (si alguien toma una sesión
    // abierta no puede quedarse con la cuenta).
    async actualizarPerfil(usuarioId: number, dto: ActualizarPerfilDto) {
        const client = this.supabaseService.getClient();
        const { data: actual, error } = await client
            .from('usuarios')
            .select('id, email, password_hash')
            .eq('id', usuarioId)
            .maybeSingle();
        if (error) throw new InternalServerErrorException(`Error consultando el usuario: ${error.message}`);
        if (!actual) throw new NotFoundException('Usuario no encontrado');

        // El login compara el correo tal cual: se guarda sin cambiar mayúsculas.
        const email = dto.email?.trim();
        const cambiaEmail = email !== undefined && email !== (actual.email ?? '');
        const cambiaPassword = !!dto.password_nueva;
        if (cambiaEmail || cambiaPassword) {
            if (!dto.password_actual) throw new BadRequestException('Escribe tu contraseña actual para cambiar el correo o la contraseña.');
            // Una cuenta sin contraseña (solo Telegram) no puede validarse aquí.
            const valida = !!actual.password_hash && (await bcrypt.compare(dto.password_actual, actual.password_hash));
            if (!valida) throw new BadRequestException('La contraseña actual no es correcta.');
        }

        const cambios: Record<string, unknown> = {};
        if (dto.nombre !== undefined) cambios.nombre = dto.nombre.trim();
        if (cambiaEmail) cambios.email = email;
        if (cambiaPassword) cambios.password_hash = await bcrypt.hash(dto.password_nueva!, 10);
        if (Object.keys(cambios).length === 0) return this.perfil(usuarioId);

        const { error: errorUpdate } = await client.from('usuarios').update(cambios).eq('id', usuarioId);
        if (errorUpdate) {
            if (errorUpdate.code === '23505') throw new ConflictException('Ese correo ya está registrado.');
            throw new InternalServerErrorException(`Error guardando el perfil: ${errorUpdate.message}`);
        }
        return this.perfil(usuarioId);
    }

    // Foto de perfil: se guarda en el bucket público "avatares" (una por usuario).
    async subirAvatar(usuarioId: number, file: Express.Multer.File | undefined) {
        const extension = file ? EXTENSION_IMAGEN[file.mimetype] : undefined;
        if (!file || !extension) throw new BadRequestException('La foto debe ser una imagen PNG, JPG o WebP.');
        const storage = this.supabaseService.getClient().storage.from('avatares');
        const path = `${usuarioId}/avatar.${extension}`;
        const { error } = await storage.upload(path, file.buffer, { contentType: file.mimetype, upsert: true });
        if (error) throw new InternalServerErrorException(`Error subiendo la foto: ${error.message}`);
        // ?v= evita que el navegador siga mostrando la foto anterior (misma URL).
        const url = `${storage.getPublicUrl(path).data.publicUrl}?v=${Date.now()}`;
        return this.guardarAvatar(usuarioId, url);
    }

    async quitarAvatar(usuarioId: number) {
        return this.guardarAvatar(usuarioId, null);
    }

    private async guardarAvatar(usuarioId: number, url: string | null) {
        const { error } = await this.supabaseService.getClient().from('usuarios').update({ avatar_url: url }).eq('id', usuarioId);
        if (error) throw new InternalServerErrorException(`Error guardando la foto: ${error.message}`);
        return this.perfil(usuarioId);
    }

    private async perfil(usuarioId: number): Promise<{ id: number; nombre: string | null; email: string | null; avatar_url: string | null }> {
        const { data, error } = await this.supabaseService
            .getClient()
            .from('usuarios')
            .select('id, nombre, email, avatar_url')
            .eq('id', usuarioId)
            .maybeSingle();
        if (error) throw new InternalServerErrorException(`Error consultando el perfil: ${error.message}`);
        if (!data) throw new NotFoundException('Usuario no encontrado');
        return data;
    }
}
