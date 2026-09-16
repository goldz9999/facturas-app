import { IsIn, IsNotEmpty, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { ESTADOS_PEDIDO, EstadoPedido } from '../pedidos.service';

// Todos opcionales: el panel manda solo lo que cambió (mismo criterio que
// el PATCH de gastos/proveedores).
export class ActualizarPedidoDto {
    @IsOptional()
    @IsString()
    @IsNotEmpty({ message: 'El nombre del pedido no puede estar vacío.' })
    nombre?: string;

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