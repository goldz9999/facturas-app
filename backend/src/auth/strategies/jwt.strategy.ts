import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { UsuarioContextoService } from '../../common/usuario-contexto.service';

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
        });
    }

    // Paso 44: el token solo identifica al usuario (`sub`); rol,
    // empresa_ids y puede_registrar_personal se leen de la base en cada
    // request, así que un cambio de accesos (o desactivar al usuario)
    // rige de inmediato, sin esperar a que expire el token.
    async validate(payload: { sub: number }) {
        const usuario = await this.usuarioContexto.obtener(payload.sub);
        if (!usuario || !usuario.activo) {
            throw new UnauthorizedException('Sesión inválida o usuario desactivado');
        }
        // Lo que retorna aquí queda disponible como req.user en los controllers.
        return {
            id: usuario.id,
            email: usuario.email,
            rol: usuario.rol,
            empresa_ids: usuario.empresa_ids,
            puede_registrar_personal: usuario.puede_registrar_personal,
            ultima_empresa_id: usuario.ultima_empresa_id,
        };
    }
}