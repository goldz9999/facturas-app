import { Module } from '@nestjs/common';
import { FacturasController } from './facturas.controller';
import { FacturasService } from './facturas.service';
import { SupabaseService } from './supabase.service';
import { FacturasCleanupService } from './facturas-cleanup.service';
import { GeminiService } from './gemini.service';
import { TelegramService } from './telegram.service';
import { ModoService } from './modo.service';

@Module({
  controllers: [FacturasController],
  providers: [
    FacturasService,
    SupabaseService,
    FacturasCleanupService,
    GeminiService,
    TelegramService,
    ModoService,
  ],
})
export class FacturasModule { }