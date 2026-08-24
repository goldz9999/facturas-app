import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { FacturasModule } from './facturas/facturas.module';
import { TelegramModule } from './telegram/telegram.module';
import { UsuariosModule } from './usuarios/usuarios.module';
import { GastosModule } from './gastos/gastos.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    FacturasModule,
    TelegramModule,
    UsuariosModule,
    GastosModule,
  ],
})
export class AppModule { }