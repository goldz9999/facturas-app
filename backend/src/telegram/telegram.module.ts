import { Module } from '@nestjs/common';
import { TelegramController } from './telegram.controller';
import { TelegramService } from './telegram.service';
import { TelegramEstadoService } from './telegram-estado.service';
import { FacturasModule } from '../facturas/facturas.module';
import { UsuariosModule } from '../usuarios/usuarios.module';
import { GastosModule } from '../gastos/gastos.module';
import { CommonModule } from '../common/common.module';
import { CategoriasModule } from '../categorias/categorias.module';
import { ProveedoresModule } from '../proveedores/proveedores.module';
import { EmpresasModule } from '../empresas/empresas.module';

@Module({
    imports: [
        FacturasModule,
        UsuariosModule,
        GastosModule,
        CommonModule,
        CategoriasModule,
        ProveedoresModule,
        EmpresasModule,
    ],
    controllers: [TelegramController],
    providers: [TelegramService, TelegramEstadoService],
})
export class TelegramModule { }