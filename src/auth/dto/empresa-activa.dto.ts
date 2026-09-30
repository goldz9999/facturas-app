import { IsInt, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class EmpresaActivaDto {
    @Type(() => Number)
    @IsInt()
    @Min(1)
    empresa_id: number;
}