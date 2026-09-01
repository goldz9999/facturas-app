import { IsBoolean, IsEmail, IsIn, IsNumber, IsOptional, IsString, MinLength } from 'class-validator';

export class CrearUsuarioDto {
    // Opcional: un usuario puede crearse desde el panel web sin tener aún
    // una cuenta de Telegram vinculada (se vincula después, cuando escribe
    // por primera vez al bot).
    @IsNumber()
    @IsOptional()
    telegram_id?: number;

    @IsString()
    @IsOptional()
    nombre?: string;

    @IsIn(['super_admin', 'admin', 'empleado'])
    @IsOptional()
    rol?: string;

    @IsBoolean()
    @IsOptional()
    activo?: boolean;

    // Opcional: mientras solo exista una empresa, si no se indica se asigna
    // automáticamente a la empresa por defecto (ver
    // EmpresasService.obtenerPorDefecto). Si quien crea el usuario es un
    // admin de empresa (no super_admin), este valor se ignora: el controller
    // fuerza la empresa del propio admin.
    @IsNumber()
    @IsOptional()
    empresa_id?: number;

    // Credenciales para el login web. Sin password, el usuario solo puede
    // usarse desde Telegram (o queda pendiente de activar su acceso web).
    @IsEmail()
    @IsOptional()
    email?: string;

    @IsString()
    @MinLength(6)
    @IsOptional()
    password?: string;
}