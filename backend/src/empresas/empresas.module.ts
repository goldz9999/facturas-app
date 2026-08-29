import { Module } from '@nestjs/common';
import { EmpresasController } from './empresas.controller';
import { EmpresasService } from './empresas.service';
import { CommonModule } from '../common/common.module';

@Module({
    imports: [CommonModule],
    controllers: [EmpresasController],
    providers: [EmpresasService],
    exports: [EmpresasService], // lo necesitará UsuariosModule
})
export class EmpresasModule { }
