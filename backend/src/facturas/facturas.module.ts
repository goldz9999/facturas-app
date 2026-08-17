import { Module } from '@nestjs/common';
import { FacturasController } from './facturas.controller';
import { FacturasService } from './facturas.service';
import { SupabaseService } from './supabase.service';
import { FacturasCleanupService } from './facturas-cleanup.service';

@Module({
  controllers: [FacturasController],
  providers: [FacturasService, SupabaseService, FacturasCleanupService],
})
export class FacturasModule { }