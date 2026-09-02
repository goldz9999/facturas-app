import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class ActualizarEmpresaDto {
    @IsString()
    @IsOptional()
    nombre?: string;

    @IsBoolean()
    @IsOptional()
    activa?: boolean;

    // No se expone en el body para uso normal: lo setea internamente
    // EmpresasService.actualizarLogo() tras subir el archivo al bucket.
    // Se declara aquí para poder reutilizar actualizar() sin duplicar lógica.
    @IsString()
    @IsOptional()
    logo_url?: string;
}