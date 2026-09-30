import { IsDateString, IsIn, IsNotEmpty, IsNumber, IsOptional, IsString, Matches, Min } from 'class-validator';
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

    // Celular peruano (9 dígitos, empieza con 9). null = sin celular.
    @IsOptional()
    @Matches(/^9\d{8}$/, { message: 'El celular debe tener 9 dígitos y empezar con 9.' })
    celular?: string | null;

    // YYYY-MM-DD. null = sin fecha de culminación.
    @IsOptional()
    @IsDateString({ strict: true }, { message: 'La fecha de culminación debe tener formato YYYY-MM-DD.' })
    fecha_culminacion?: string | null;
}