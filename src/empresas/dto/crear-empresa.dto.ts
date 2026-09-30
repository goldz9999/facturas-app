import { IsBoolean, IsNotEmpty, IsOptional, IsString, Matches, MaxLength, ValidateIf } from 'class-validator';

export class CrearEmpresaDto {
    @IsString()
    @IsNotEmpty()
    @MaxLength(160)
    nombre: string;

    @ValidateIf((_, v) => v !== null && v !== undefined && v !== '')
    @Matches(/^[0-9]{11}$/, { message: 'El RUC debe tener 11 dígitos.' })
    ruc?: string | null;

    @IsBoolean()
    @IsOptional()
    activa?: boolean;
}
