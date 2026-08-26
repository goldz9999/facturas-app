import { Module } from '@nestjs/common';
import { ProveedoresService } from './proveedores.service';
import { CommonModule } from '../common/common.module';

@Module({
    imports: [CommonModule],
    providers: [ProveedoresService],
    exports: [ProveedoresService], // lo necesitarán FacturasModule y TelegramModule
})
export class ProveedoresModule { }