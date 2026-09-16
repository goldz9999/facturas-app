import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, Request, UseGuards } from '@nestjs/common';
import { ApiQuery } from '@nestjs/swagger';
import { CategoriasService } from './categorias.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { resolverEmpresaId } from '../common/resolver-empresa.util';

@UseGuards(JwtAuthGuard)
@Controller('categorias')
export class CategoriasController {
    constructor(private categoriasService: CategoriasService) { }

    // Resuelve la empresa sobre la que se opera (ver
    // common/resolver-empresa.util.ts). admin/empleado con una sola
    // empresa quedan acotados a esa sin preguntar nada; con más de una
    // (Paso 33), o super_admin, deben indicar cuál con ?empresa_id= -- un
    // catálogo de categorías mezclando varias empresas no es un caso de
    // uso real (a diferencia de GastosController.listar()).

    @ApiQuery({ name: 'empresa_id', required: false, type: Number, description: 'Obligatorio si tienes acceso a más de una empresa' })
    @Get()
    async listar(@Query('empresa_id') empresaIdQuery: string, @Request() req) {
        return this.categoriasService.listar(resolverEmpresaId(req, empresaIdQuery));
    }

    @ApiQuery({ name: 'empresa_id', required: false, type: Number, description: 'Obligatorio si tienes acceso a más de una empresa' })
    @Post()
    async crear(@Body() body: { nombre: string }, @Query('empresa_id') empresaIdQuery: string, @Request() req) {
        return this.categoriasService.crear(body.nombre, resolverEmpresaId(req, empresaIdQuery));
    }

    @ApiQuery({ name: 'empresa_id', required: false, type: Number, description: 'Obligatorio si tienes acceso a más de una empresa' })
    @Patch(':id')
    async actualizar(
        @Param('id', ParseIntPipe) id: number,
        @Body() body: { nombre: string },
        @Query('empresa_id') empresaIdQuery: string,
        @Request() req,
    ) {
        return this.categoriasService.actualizar(id, body.nombre, resolverEmpresaId(req, empresaIdQuery));
    }

    @ApiQuery({ name: 'empresa_id', required: false, type: Number, description: 'Obligatorio si tienes acceso a más de una empresa' })
    @Delete(':id')
    async eliminar(@Param('id', ParseIntPipe) id: number, @Query('empresa_id') empresaIdQuery: string, @Request() req) {
        await this.categoriasService.eliminar(id, resolverEmpresaId(req, empresaIdQuery));
        return { eliminado: true };
    }
}