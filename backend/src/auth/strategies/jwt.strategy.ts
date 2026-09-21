import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { ExtractJwt, Strategy } from 'passport-jwt';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
    constructor(config: ConfigService) {
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

    async validate(payload: {
        sub: number;
        email: string;
        rol: string;
        empresa_ids: number[];
        puede_registrar_personal: boolean;
    }) {
        // Lo que retorna aquí queda disponible como req.user en los controllers.
        return {
            id: payload.sub,
            email: payload.email,
            rol: payload.rol,
            empresa_ids: payload.empresa_ids ?? [],
            puede_registrar_personal: payload.puede_registrar_personal,
        };
    }
}