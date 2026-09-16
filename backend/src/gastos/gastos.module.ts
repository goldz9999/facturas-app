import { Module } from '@nestjs/common';
import { GastosController } from './gastos.controller';
import { GastosService } from './gastos.service';
import { GastosGateway } from './gastos.gateway';
import { CommonModule } from '../common/common.module';
import { ProveedoresModule } from '../proveedores/proveedores.module';
import { PedidosModule } from '../pedidos/pedidos.module';

@Module({
    imports: [CommonModule, ProveedoresModule, PedidosModule],
    controllers: [GastosController],
    providers: [GastosService, GastosGateway],
    exports: [GastosService], // lo necesitará TelegramModule y FacturasModule
})
export class GastosModule { }