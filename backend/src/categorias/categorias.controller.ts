import { BadRequestException, Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, Request, UseGuards } from '@nestjs/common';
import { ApiQuery } from '@nestjs/swagger';
import { CategoriasService } from './categorias.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@UseGuards(JwtAuthGuard)
@Controller('categorias')
export class CategoriasController {
    constructor(private categoriasService: CategoriasService) { }

    // Resuelve la empresa sobre la que se opera. admin/empleado quedan
    // acotados siempre a la suya (desde el JWT). super_admin no tiene
    // empresa propia (empresa_id es null en su usuario -- ve "todas"), así
    // que acá SÍ debe indicar una con ?empresa_id=: a diferencia de
    // GastosController.listar(), donde "ver todas mezcladas" tiene
    // sentido para una lista de gastos, un catálogo de categorías
    // mezclando varias empresas no es un caso de uso real.
    private resolverEmpresaId(req: any, empresaIdQuery?: string): number {
        if (req.user.rol !== 'super_admin') {
            return req.user.empresa_id;
        }
        const id = empresaIdQuery ? Number(empresaIdQuery) : undefined;
        if (!id) {
            throw new BadRequestException(
                'Como super_admin, indica ?empresa_id= para ver o administrar categorías de una empresa.',
            );
        }
        return id;
    }

    @ApiQuery({ name: 'empresa_id', required: false, type: Number, description: 'Solo super_admin: obligatorio' })
    @Get()
    async listar(@Query('empresa_id') empresaIdQuery: string, @Request() req) {
        return this.categoriasService.listar(this.resolverEmpresaId(req, empresaIdQuery));
    }

    @ApiQuery({ name: 'empresa_id', required: false, type: Number, description: 'Solo super_admin: obligatorio' })
    @Post()
    async crear(@Body() body: { nombre: string }, @Query('empresa_id') empresaIdQuery: string, @Request() req) {
        return this.categoriasService.crear(body.nombre, this.resolverEmpresaId(req, empresaIdQuery));
    }

    @ApiQuery({ name: 'empresa_id', required: false, type: Number, description: 'Solo super_admin: obligatorio' })
    @Patch(':id')
    async actualizar(
        @Param('id', ParseIntPipe) id: number,
        @Body() body: { nombre: string },
        @Query('empresa_id') empresaIdQuery: string,
        @Request() req,
    ) {
        return this.categoriasService.actualizar(id, body.nombre, this.resolverEmpresaId(req, empresaIdQuery));
    }

    @ApiQuery({ name: 'empresa_id', required: false, type: Number, description: 'Solo super_admin: obligatorio' })
    @Delete(':id')
    async eliminar(@Param('id', ParseIntPipe) id: number, @Query('empresa_id') empresaIdQuery: string, @Request() req) {
        await this.categoriasService.eliminar(id, this.resolverEmpresaId(req, empresaIdQuery));
        return { eliminado: true };
    }
}