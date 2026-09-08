import { BadRequestException, Body, Controller, Get, NotFoundException, Param, ParseIntPipe, Patch, Post, Query, Request, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiQuery } from '@nestjs/swagger';
import { GastosService, FiltrosGastos, DatosPago } from './gastos.service';
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
    async obtenerPorId(@Param('id', ParseIntPipe) id: number, @Request() req) {
        const empresaId = req.user.rol === 'super_admin' ? undefined : req.user.empresa_id;
        return this.gastosService.obtenerPorId(id, empresaId);
    }

    // Guardar cambios / Confirmar gasto desde ExpenseDetail.
    @Patch(':id')
    async actualizar(
        @Param('id', ParseIntPipe) id: number,
        @Body() body: {
            monto?: number;
            descripcion?: string;
            es_personal?: boolean;
            categoria_id?: number;
            proveedor_id?: number;
        },
        @Request() req,
    ) {
        const empresaId = req.user.rol === 'super_admin' ? undefined : req.user.empresa_id;
        return this.gastosService.actualizar(id, body, empresaId);
    }

    @Post(':id/comprobante')
    async adjuntarComprobante(@Param('id', ParseIntPipe) id: number, @Body() body: any, @Request() req) {
        if (!id) throw new NotFoundException('Gasto no encontrado');
        const empresaId = req.user.rol === 'super_admin' ? undefined : req.user.empresa_id;
        return this.gastosService.adjuntarComprobante(id, body, undefined, undefined, undefined, empresaId);
    }

    // Botón "Añadir" de Pagos en ExpenseDetail. `medio` es obligatorio (uno
    // de 'yape' | 'transferencia' | 'efectivo' | 'tarjeta' | 'otro', ver
    // DatosPago); numero_operacion y monto son opcionales.
    @Post(':id/pago')
    async agregarPago(@Param('id', ParseIntPipe) id: number, @Body() body: DatosPago, @Request() req) {
        const empresaId = req.user.rol === 'super_admin' ? undefined : req.user.empresa_id;
        return this.gastosService.insertarPago(id, body, empresaId);
    }

    // Subir una imagen/foto de respaldo (ej. captura de Yape, foto de un
    // comprobante) desde el panel web -- reusable tanto para el modal de
    // Pagos como el de Comprobantes en ExpenseDetail. Mismo límite de
    // tamaño que /facturas/upload (15MB).
    @Post(':id/evidencia')
    @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 15 * 1024 * 1024 } }))
    async agregarEvidencia(
        @Param('id', ParseIntPipe) id: number,
        @UploadedFile() file: Express.Multer.File,
        @Request() req,
    ) {
        if (!file) throw new BadRequestException('No se recibió ningún archivo.');
        const empresaId = req.user.rol === 'super_admin' ? undefined : req.user.empresa_id;
        return this.gastosService.subirEvidenciaImagen(id, file, empresaId);
    }
}