import { Module } from '@nestjs/common';
import { CategoriasService } from './categorias.service';
import { CommonModule } from '../common/common.module';

@Module({
    imports: [CommonModule],
    providers: [CategoriasService],
    exports: [CategoriasService], // lo necesitará TelegramModule
})
export class CategoriasModule { }