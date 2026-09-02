import { IsBoolean, IsEmail, IsIn, IsNumber, IsOptional, IsString, MinLength } from 'class-validator';

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

    // Vincular/desvincular la cuenta de Telegram de un usuario ya existente
    // (ej. alguien creado primero desde el panel web, sin telegram_id, y
    // vinculado después una vez que se obtiene su ID de Telegram).
    @IsNumber()
    @IsOptional()
    telegram_id?: number;

    // Solo un super_admin puede reasignar la empresa de un usuario; si quien
    // llama es admin de empresa, el controller ignora este campo y fuerza
    // su propia empresa (mismo patrón que en CrearUsuarioDto).
    @IsNumber()
    @IsOptional()
    empresa_id?: number;
}