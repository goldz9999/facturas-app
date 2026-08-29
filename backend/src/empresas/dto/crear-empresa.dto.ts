import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class CrearEmpresaDto {
    @IsString()
    nombre: string;

    @IsBoolean()
    @IsOptional()
    activa?: boolean;
}
