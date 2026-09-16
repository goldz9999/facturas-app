import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, Request, UseGuards } from '@nestjs/common';
import { ApiQuery } from '@nestjs/swagger';
import { PedidosService } from './pedidos.service';
import { CrearPedidoDto } from './dto/crear-pedido.dto';
import { ActualizarPedidoDto } from './dto/actualizar-pedido.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { resolverEmpresaId } from '../common/resolver-empresa.util';

// RF-11. Se usa `resolverEmpresaId` (variante obligatoria), no
// `resolverEmpresaIdFiltro`: igual que categorías y proveedores, un
// catálogo de pedidos mezclando varias empresas no es un caso de uso real
// -- el panel siempre opera sobre la empresa elegida en el EmpresaSwitcher.
//
// No se agregan roles nuevos ni se toca el sistema de permisos: cualquier
// usuario autenticado gestiona los pedidos de las empresas a las que ya
// tiene acceso, mismo criterio que ya rige para categorías.
@UseGuards(JwtAuthGuard)
@Controller('pedidos')
export class PedidosController {
    constructor(private pedidosService: PedidosService) { }

    @ApiQuery({ name: 'empresa_id', required: false, type: Number, description: 'Obligatorio si tienes acceso a más de una empresa' })
    @ApiQuery({ name: 'solo_activos', required: false, type: Boolean, description: 'true = solo pedidos que pueden recibir gastos nuevos' })
    @Get()
    async listar(
        @Query('empresa_id') empresaIdQuery: string,
        @Query('solo_activos') soloActivos: string,
        @Request() req,
    ) {
        const empresaId = resolverEmpresaId(req, empresaIdQuery);
        return soloActivos === 'true'
            ? this.pedidosService.listarActivos(empresaId)
            : this.pedidosService.listar(empresaId);
    }

    // Devuelve el pedido con su resumen (cantidad_gastos, total_gastado)
    // incluido, en vez de un GET /pedidos/:id/resumen aparte: es un solo
    // round-trip para ProjectDetail.jsx, que siempre necesita ambos, y
    // evita duplicar un endpoint por un par de campos agregados (§14 del
    // pedido de trabajo deja abierta esa elección según la arquitectura).
    // La lista de gastos del pedido NO va acá: sale de
    // GET /gastos?pedido_id=X, que ya existía desde el Paso 20 y ya trae
    // el formato que ExpenseTable.jsx sabe renderizar.
    @ApiQuery({ name: 'empresa_id', required: false, type: Number, description: 'Obligatorio si tienes acceso a más de una empresa' })
    @Get(':id')
    async obtener(@Param('id', ParseIntPipe) id: number, @Query('empresa_id') empresaIdQuery: string, @Request() req) {
        return this.pedidosService.obtenerPorId(id, resolverEmpresaId(req, empresaIdQuery));
    }

    @ApiQuery({ name: 'empresa_id', required: false, type: Number, description: 'Obligatorio si tienes acceso a más de una empresa' })
    @Post()
    async crear(@Body() body: CrearPedidoDto, @Query('empresa_id') empresaIdQuery: string, @Request() req) {
        return this.pedidosService.crear(body, resolverEmpresaId(req, empresaIdQuery));
    }

    @ApiQuery({ name: 'empresa_id', required: false, type: Number, description: 'Obligatorio si tienes acceso a más de una empresa' })
    @Patch(':id')
    async actualizar(
        @Param('id', ParseIntPipe) id: number,
        @Body() body: ActualizarPedidoDto,
        @Query('empresa_id') empresaIdQuery: string,
        @Request() req,
    ) {
        return this.pedidosService.actualizar(id, body, resolverEmpresaId(req, empresaIdQuery));
    }

    @ApiQuery({ name: 'empresa_id', required: false, type: Number, description: 'Obligatorio si tienes acceso a más de una empresa' })
    @Delete(':id')
    async eliminar(@Param('id', ParseIntPipe) id: number, @Query('empresa_id') empresaIdQuery: string, @Request() req) {
        const { gastos_desasociados } = await this.pedidosService.eliminar(id, resolverEmpresaId(req, empresaIdQuery));
        return { eliminado: true, gastos_desasociados };
    }
}