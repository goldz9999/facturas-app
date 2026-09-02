import { Body, Controller, Get, NotFoundException, Param, ParseIntPipe, Post, Query, Request, UseGuards } from '@nestjs/common';
import { ApiQuery } from '@nestjs/swagger';
import { GastosService, FiltrosGastos } from './gastos.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@UseGuards(JwtAuthGuard)
@Controller('gastos')
export class GastosController {
    constructor(private gastosService: GastosService) { }

    // Lista con filtros (sección 24 de requerimientos: panel de control).
    // super_admin ve de todas las empresas (o filtra por una con
    // ?empresa_id=); admin/empleado quedan acotados siempre a la suya,
    // mismo patrón que UsuariosController.listar().
    @ApiQuery({ name: 'desde', required: false, description: 'YYYY-MM-DD' })
    @ApiQuery({ name: 'hasta', required: false, description: 'YYYY-MM-DD' })
    @ApiQuery({ name: 'es_personal', required: false, type: Boolean })
    @ApiQuery({ name: 'categoria_id', required: false, type: Number })
    @ApiQuery({ name: 'proveedor_id', required: false, type: Number })
    @ApiQuery({ name: 'usuario_id', required: false, type: Number })
    @ApiQuery({ name: 'pedido_id', required: false, type: Number })
    @ApiQuery({ name: 'medio_pago', required: false, type: String })
    @ApiQuery({ name: 'pendiente_revision', required: false, type: Boolean })
    @ApiQuery({ name: 'posible_duplicado', required: false, type: Boolean })
    @ApiQuery({ name: 'sin_comprobante', required: false, type: Boolean })
    @ApiQuery({ name: 'empresa_id', required: false, type: Number, description: 'Solo super_admin: filtrar por una empresa específica' })
    @ApiQuery({ name: 'limite', required: false, type: Number })
    @ApiQuery({ name: 'offset', required: false, type: Number })
    @Get()
    async listar(@Query() q: Record<string, string>, @Request() req) {
        const aBooleano = (v?: string) => (v === undefined ? undefined : v === 'true');
        const aNumero = (v?: string) => (v === undefined ? undefined : Number(v));

        const filtros: FiltrosGastos = {
            desde: q.desde,
            hasta: q.hasta,
            esPersonal: aBooleano(q.es_personal),
            categoriaId: aNumero(q.categoria_id),
            proveedorId: aNumero(q.proveedor_id),
            usuarioId: aNumero(q.usuario_id),
            pedidoId: aNumero(q.pedido_id),
            medioPago: q.medio_pago,
            pendienteRevision: aBooleano(q.pendiente_revision),
            posibleDuplicado: aBooleano(q.posible_duplicado),
            sinComprobante: aBooleano(q.sin_comprobante),
            limite: aNumero(q.limite),
            offset: aNumero(q.offset),
        };

        // super_admin: sin acotar, salvo que pida una empresa puntual por query.
        const empresaId = req.user.rol === 'super_admin' ? aNumero(q.empresa_id) : req.user.empresa_id;
        return this.gastosService.listar(filtros, empresaId);
    }

    @ApiQuery({ name: 'limite', required: false, type: Number })
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