import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtStrategy } from './strategies/jwt.strategy';
import { CommonModule } from '../common/common.module';

@Module({
    imports: [
        CommonModule,
        PassportModule,
        JwtModule.registerAsync({
            imports: [ConfigModule],
            inject: [ConfigService],
            useFactory: (config: ConfigService) => {
                // Mismo fix que jwt.strategy.ts -- sin fallback inseguro.
                const secret = config.get<string>('JWT_SECRET');
                if (!secret) {
                    throw new Error(
                        'Falta la variable de entorno JWT_SECRET. Definila antes de arrancar el backend (ver .env.example).',
                    );
                }
                return { secret, signOptions: { expiresIn: '8h' } };
            },
        }),
    ],
    controllers: [AuthController],
    providers: [AuthService, JwtStrategy],
    exports: [JwtModule],
})
export class AuthModule { }