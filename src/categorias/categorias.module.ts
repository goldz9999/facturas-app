import { Module } from '@nestjs/common';
import { CategoriasController } from './categorias.controller';
import { CategoriasService } from './categorias.service';
import { CommonModule } from '../common/common.module';

@Module({
    imports: [CommonModule],
    controllers: [CategoriasController],
    providers: [CategoriasService],
    exports: [CategoriasService], // lo necesitará TelegramModule
})
export class CategoriasModule { }