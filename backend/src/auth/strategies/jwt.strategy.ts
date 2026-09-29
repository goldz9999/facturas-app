import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { UsuarioContextoService } from '../../common/usuario-contexto.service';
import { elegirEmpresaActiva, rolLegacy } from '../roles-empresa';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
    constructor(config: ConfigService, private usuarioContexto: UsuarioContextoService) {
        // Hallazgo 37.4-B: antes, si faltaba la variable de entorno
        // JWT_SECRET, se usaba 'dev-secret-cambiar-en-produccion' -- un
        // valor público (está en este mismo archivo del repo). Cualquiera
        // que lo conociera podía fabricar un token válido de super_admin
        // si Koyeb/Railway no tenía la variable configurada. Ahora, sin
        // JWT_SECRET, el backend falla al arrancar en vez de aceptar ese
        // secreto conocido.
        const secret = config.get<string>('JWT_SECRET');
        if (!secret) {
            throw new Error(
                'Falta la variable de entorno JWT_SECRET. Definila antes de arrancar el backend (ver .env.example).',
            );
        }
        super({
            jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
            ignoreExpiration: false,
            secretOrKey: secret,
            passReqToCallback: true,
        });
    }

    // Paso 44: el token solo identifica al usuario (`sub`); todo lo demás se
    // lee de la base en cada request, así que un cambio de accesos (o
    // desactivar al usuario) rige de inmediato. `rol` (legacy) se deriva del
    // rol que el usuario tiene en la empresa activa de ESTE request
    // (?empresa_id=, si no ultima_empresa_id, si no la primera).
    async validate(req: { query?: Record<string, unknown> }, payload: { sub: number }) {
        const usuario = await this.usuarioContexto.obtener(payload.sub);
        if (!usuario || !usuario.activo) {
            throw new UnauthorizedException('Sesión inválida o usuario desactivado');
        }
        const q = req?.query?.empresa_id;
        const activa = elegirEmpresaActiva(usuario.empresas, typeof q === 'string' ? q : undefined, usuario.ultima_empresa_id);
        // Lo que retorna aquí queda disponible como req.user en los controllers.
        return {
            id: usuario.id,
            nombre: usuario.nombre,
            email: usuario.email,
            avatar_url: usuario.avatar_url,
            rol: rolLegacy(usuario.es_super_admin, activa?.rol ?? null),
            rol_empresa: usuario.es_super_admin ? 'propietario' : (activa?.rol ?? null),
            es_super_admin: usuario.es_super_admin,
            empresa_activa_id: activa?.empresa_id ?? null,
            empresas: usuario.empresas,
            empresa_ids: usuario.empresa_ids,
            puede_registrar_personal: usuario.puede_registrar_personal,
            ultima_empresa_id: usuario.ultima_empresa_id,
        };
    }
}