import { IsBoolean, IsIn, IsOptional, IsString, Matches, MaxLength, ValidateIf } from 'class-validator';

export const MONEDAS = ['PEN', 'USD'] as const;

export class ActualizarEmpresaDto {
    @IsString()
    @IsOptional()
    nombre?: string;

    @IsBoolean()
    @IsOptional()
    activa?: boolean;

    // RUC peruano: 11 dígitos. null lo borra.
    @ValidateIf((_, v) => v !== null && v !== undefined)
    @Matches(/^[0-9]{11}$/, { message: 'El RUC debe tener 11 dígitos.' })
    ruc?: string | null;

    @ValidateIf((_, v) => v !== null && v !== undefined)
    @IsString()
    @MaxLength(300)
    direccion?: string | null;

    @IsIn(MONEDAS)
    @IsOptional()
    moneda?: (typeof MONEDAS)[number];

    // No se expone en el body para uso normal: lo setea internamente
    // EmpresasService.actualizarLogo() tras subir el archivo al bucket.
    // Se declara aquí para poder reutilizar actualizar() sin duplicar lógica.
    @IsString()
    @IsOptional()
    logo_url?: string;
}
