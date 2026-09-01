import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class ActualizarEmpresaDto {
    @IsString()
    @IsOptional()
    nombre?: string;

    @IsBoolean()
    @IsOptional()
    activa?: boolean;
}