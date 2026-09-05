import { Controller, Get, UseGuards } from '@nestjs/common';
import { CategoriasService } from './categorias.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@UseGuards(JwtAuthGuard)
@Controller('categorias')
export class CategoriasController {
    constructor(private categoriasService: CategoriasService) { }

    @Get()
    async listar() {
        return this.categoriasService.listar();
    }
}