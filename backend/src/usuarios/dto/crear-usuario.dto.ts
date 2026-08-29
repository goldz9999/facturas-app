import { IsBoolean, IsNumber, IsOptional, IsString } from 'class-validator';

export class CrearUsuarioDto {
    @IsNumber()
    telegram_id: number;

    @IsString()
    @IsOptional()
    nombre?: string;

    @IsString()
    @IsOptional()
    rol?: string;

    @IsBoolean()
    @IsOptional()
    activo?: boolean;

    // Opcional: mientras solo exista una empresa, si no se indica se asigna
    // automáticamente a la empresa por defecto (ver
    // EmpresasService.obtenerPorDefecto). El día que exista más de una
    // empresa, este campo pasa a ser obligatorio en la práctica -- quien
    // llame a este endpoint deberá indicarlo explícitamente.
    @IsNumber()
    @IsOptional()
    empresa_id?: number;
}