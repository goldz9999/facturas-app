import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { ExtractJwt, Strategy } from 'passport-jwt';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
    constructor(config: ConfigService) {
        super({
            jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
            ignoreExpiration: false,
            secretOrKey: config.get<string>('JWT_SECRET') ?? 'dev-secret-cambiar-en-produccion',
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