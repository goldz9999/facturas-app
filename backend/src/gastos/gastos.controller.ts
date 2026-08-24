import { Body, Controller, Get, NotFoundException, Param, ParseIntPipe, Post, Query } from '@nestjs/common';
import { GastosService } from './gastos.service';

@Controller('gastos')
export class GastosController {
    constructor(private gastosService: GastosService) { }

    @Get('usuario/:usuarioId/ultimos')
    async ultimosPorUsuario(
        @Param('usuarioId', ParseIntPipe) usuarioId: number,
        @Query('limite') limite?: string,
    ) {
        const n = limite ? parseInt(limite, 10) : 5;
        return this.gastosService.ultimosPorUsuario(usuarioId, n);
    }

    @Get(':id')
    async obtenerPorId(@Param('id', ParseIntPipe) id: number) {
        return this.gastosService.obtenerPorId(id);
    }

    @Post(':id/comprobante')
    async adjuntarComprobante(@Param('id', ParseIntPipe) id: number, @Body() body: any) {
        if (!id) throw new NotFoundException('Gasto no encontrado');
        return this.gastosService.adjuntarComprobante(id, body);
    }
}