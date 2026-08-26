import { Module } from '@nestjs/common';
import { FacturasController } from './facturas.controller';
import { FacturasService } from './facturas.service';
import { FacturasCleanupService } from './facturas-cleanup.service';
import { CommonModule } from '../common/common.module';
import { IaModule } from '../ia/ia.module';
import { GastosModule } from '../gastos/gastos.module';

@Module({
  imports: [CommonModule, IaModule, GastosModule],
  controllers: [FacturasController],
  providers: [FacturasService, FacturasCleanupService],
  exports: [FacturasService], // los necesita TelegramModule
})
export class FacturasModule { }