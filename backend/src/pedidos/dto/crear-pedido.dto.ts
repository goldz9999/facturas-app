import { IsIn, IsNotEmpty, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { ESTADOS_PEDIDO, EstadoPedido } from '../pedidos.service';

export class CrearPedidoDto {
    @IsString()
    @IsNotEmpty({ message: 'El nombre del pedido es obligatorio.' })
    nombre: string;

    @IsOptional()
    @IsString()
    cliente?: string | null;

    @IsOptional()
    @IsNumber({}, { message: 'El presupuesto debe ser un número.' })
    @Min(0, { message: 'El presupuesto no puede ser negativo.' })
    presupuesto?: number | null;

    @IsOptional()
    @IsIn(ESTADOS_PEDIDO, { message: `El estado debe ser uno de: ${ESTADOS_PEDIDO.join(', ')}.` })
    estado?: EstadoPedido;
}