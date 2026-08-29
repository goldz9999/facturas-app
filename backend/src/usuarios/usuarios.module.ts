import { Module } from '@nestjs/common';
import { UsuariosController } from './usuarios.controller';
import { UsuariosService } from './usuarios.service';
import { CommonModule } from '../common/common.module';
import { EmpresasModule } from '../empresas/empresas.module';

@Module({
    imports: [CommonModule, EmpresasModule],
    controllers: [UsuariosController],
    providers: [UsuariosService],
    exports: [UsuariosService], // TelegramModule lo va a necesitar
})
export class UsuariosModule { }