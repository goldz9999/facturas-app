import { IsArray, IsBoolean, IsEmail, IsIn, IsNumber, IsOptional, IsString, MinLength } from 'class-validator';
import { ROLES_EMPRESA, RolEmpresa } from '../../auth/roles-empresa';

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

    // Rol por empresa (el que usa el panel web). Si viene, manda sobre `rol`,
    // que se deriva de él.
    @IsIn(ROLES_EMPRESA)
    @IsOptional()
    rol_empresa?: RolEmpresa;

    @IsBoolean()
    @IsOptional()
    activo?: boolean;

    // Paso 33: un usuario puede tener acceso a más de una empresa. Opcional
    // -- si no se indica ninguna, se asigna a la empresa por defecto (ver
    // EmpresasService.obtenerPorDefecto). Si quien crea el usuario es un
    // admin de empresa (no super_admin), este valor se ignora: el controller
    // fuerza [su propia empresa].
    @IsArray()
    @IsNumber({}, { each: true })
    @IsOptional()
    empresa_ids?: number[];

    // Paso 33: si puede registrar gastos personales (además de los de
    // empresa). true por defecto.
    @IsBoolean()
    @IsOptional()
    puede_registrar_personal?: boolean;

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