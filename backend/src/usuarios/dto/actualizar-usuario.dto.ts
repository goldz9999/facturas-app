import { IsArray, IsBoolean, IsEmail, IsIn, IsNumber, IsOptional, IsString, MinLength } from 'class-validator';
import { ROLES_EMPRESA, RolEmpresa } from '../../auth/roles-empresa';

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

    // Rol del usuario en la empresa activa (el que usa el panel web).
    @IsIn(ROLES_EMPRESA)
    @IsOptional()
    rol_empresa?: RolEmpresa;

    @IsBoolean()
    @IsOptional()
    activo?: boolean;

    // Vincular/desvincular la cuenta de Telegram de un usuario ya existente
    // (ej. alguien creado primero desde el panel web, sin telegram_id, y
    // vinculado después una vez que se obtiene su ID de Telegram).
    @IsNumber()
    @IsOptional()
    telegram_id?: number;

    // Paso 33: reemplaza por completo la lista de empresas del usuario.
    // Solo un super_admin puede reasignarla; si quien llama es admin de
    // empresa, el controller ignora este campo (mismo patrón que en
    // CrearUsuarioDto).
    @IsArray()
    @IsNumber({}, { each: true })
    @IsOptional()
    empresa_ids?: number[];

    // Paso 33: switch global -- si puede registrar gastos personales.
    @IsBoolean()
    @IsOptional()
    puede_registrar_personal?: boolean;
}