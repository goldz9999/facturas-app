import { Module } from '@nestjs/common';
import { GastosController } from './gastos.controller';
import { GastosService } from './gastos.service';
import { CommonModule } from '../common/common.module';
import { ProveedoresModule } from '../proveedores/proveedores.module';

@Module({
    imports: [CommonModule, ProveedoresModule],
    controllers: [GastosController],
    providers: [GastosService],
    exports: [GastosService], // lo necesitará TelegramModule y FacturasModule
})
export class GastosModule { }