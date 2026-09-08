import { Module } from '@nestjs/common';
import { ProveedoresService } from './proveedores.service';
import { ProveedoresController } from './proveedores.controller';
import { CommonModule } from '../common/common.module';

@Module({
    imports: [CommonModule],
    controllers: [ProveedoresController],
    providers: [ProveedoresService],
    exports: [ProveedoresService], // lo necesitarán FacturasModule y TelegramModule
})
export class ProveedoresModule { }