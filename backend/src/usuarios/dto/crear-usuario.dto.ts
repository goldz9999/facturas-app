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
}