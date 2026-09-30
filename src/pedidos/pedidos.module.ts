import { Module } from '@nestjs/common';
import { PedidosController } from './pedidos.controller';
import { PedidosService } from './pedidos.service';
import { CommonModule } from '../common/common.module';

@Module({
    imports: [CommonModule],
    controllers: [PedidosController],
    providers: [PedidosService],
    // Exportado porque lo necesitan GastosModule (validar pedido_id al
    // asociar) y TelegramModule (botones de selección de pedido).
    exports: [PedidosService],
})
export class PedidosModule { }