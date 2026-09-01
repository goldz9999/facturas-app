import { IsBoolean, IsEmail, IsIn, IsOptional, IsString, MinLength } from 'class-validator';

export class ActualizarUsuarioDto {
    @IsString()
    @IsOptional()
    nombre?: string;

    @IsEmail()
    @IsOptional()
    email?: string;

    // Nueva contraseña opcional: si no viene, se conserva la actual.
    @IsString()
    @MinLength(6)
    @IsOptional()
    password?: string;

    @IsIn(['super_admin', 'admin', 'empleado'])
    @IsOptional()
    rol?: string;

    @IsBoolean()
    @IsOptional()
    activo?: boolean;
}