import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { FacturasModule } from './facturas/facturas.module';
import { TelegramModule } from './telegram/telegram.module';
import { UsuariosModule } from './usuarios/usuarios.module';
import { GastosModule } from './gastos/gastos.module';
import { EmpresasModule } from './empresas/empresas.module';
import { AuthModule } from './auth/auth.module';
import { ProveedoresModule } from './proveedores/proveedores.module';
import { PedidosModule } from './pedidos/pedidos.module';
import { HealthController } from './health/health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    FacturasModule,
    TelegramModule,
    UsuariosModule,
    GastosModule,
    EmpresasModule,
    AuthModule,
    ProveedoresModule,
    PedidosModule,
  ],
  controllers: [HealthController],
})
export class AppModule { }