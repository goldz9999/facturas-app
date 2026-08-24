import { Module } from '@nestjs/common';
import { FacturasController } from './facturas.controller';
import { FacturasService } from './facturas.service';
import { FacturasCleanupService } from './facturas-cleanup.service';
import { ModoService } from './modo.service';
import { CommonModule } from '../common/common.module';
import { IaModule } from '../ia/ia.module';

@Module({
  imports: [CommonModule, IaModule],
  controllers: [FacturasController],
  providers: [FacturasService, FacturasCleanupService, ModoService],
  exports: [FacturasService, ModoService], // los necesita TelegramModule
})
export class FacturasModule { }