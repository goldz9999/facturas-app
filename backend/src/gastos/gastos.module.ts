import { Module } from '@nestjs/common';
import { GastosController } from './gastos.controller';
import { GastosService } from './gastos.service';
import { CommonModule } from '../common/common.module';

@Module({
    imports: [CommonModule],
    controllers: [GastosController],
    providers: [GastosService],
    exports: [GastosService], // lo necesitará TelegramModule y FacturasModule
})
export class GastosModule { }