import { Module } from '@nestjs/common';
import { TelegramController } from './telegram.controller';
import { TelegramService } from './telegram.service';
import { FacturasModule } from '../facturas/facturas.module';
import { UsuariosModule } from '../usuarios/usuarios.module';

@Module({
    imports: [FacturasModule, UsuariosModule],
    controllers: [TelegramController],
    providers: [TelegramService],
})
export class TelegramModule { }