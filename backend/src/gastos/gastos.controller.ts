import { BadRequestException, Body, Controller, Get, NotFoundException, Param, ParseIntPipe, Patch, Post, Query, Request, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiQuery } from '@nestjs/swagger';
import { GastosService, FiltrosGastos, DatosPago } from './gastos.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { resolverEmpresaIdFiltro } from '../common/resolver-empresa.util';

@UseGuards(JwtAuthGuard)
@Controller('gastos')
export class GastosController {
    constructor(private gastosService: GastosService) { }

    // Lista con filtros (sección 24 de requerimientos: panel de control).
    // super_admin ve de todas las empresas (o filtra por una con
    // ?empresa_id=); admin/empleado ven mezcladas las empresas a las que
    // tienen acceso (Paso 33: puede ser más de una), o filtran por una
    // puntual con ?empresa_id= (ver resolverEmpresaIdFiltro).
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
    @ApiQuery({ name: 'empresa_id', required: false, type: Number, description: 'Filtrar por una empresa específica' })
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

        const empresaId = resolverEmpresaIdFiltro(req, q.empresa_id);
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

    // Totales para Dashboard.jsx (hoy/semana/mes, empresa vs personal, top
    // categorías/proveedores, últimos gastos). Debe declararse antes de
    // GET ':id' -- si no, Nest interpreta "resumen" como un :id numérico
    // que ParseIntPipe rechaza con 400 antes de llegar acá.
    @ApiQuery({ name: 'empresa_id', required: false, type: Number, description: 'Filtrar por una empresa específica' })
    @Get('resumen')
    async resumen(@Query('empresa_id') empresaIdQuery: string | undefined, @Request() req) {
        const empresaId = resolverEmpresaIdFiltro(req, empresaIdQuery);
        return this.gastosService.resumen(empresaId);
    }

    @Get(':id')
    async obtenerPorId(@Param('id', ParseIntPipe) id: number, @Request() req) {
        const empresaId = resolverEmpresaIdFiltro(req);
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
        const empresaId = resolverEmpresaIdFiltro(req);
        return this.gastosService.actualizar(id, body, empresaId);
    }

    // Bandeja de revisión (ReviewInbox.jsx): el usuario confirma que un
    // gasto con confianza media/baja está correcto tal como lo extrajo la
    // IA, sin corregir el monto. Sube confianza a 'alta' y apaga
    // pendiente_revision (ver GastosService.confirmarConfianza, Paso 4.3).
    @Patch(':id/confirmar-confianza')
    async confirmarConfianza(@Param('id', ParseIntPipe) id: number) {
        return this.gastosService.confirmarConfianza(id);
    }

    // Vista de duplicados (DuplicatesReview.jsx): el usuario confirma que sí
    // es el mismo pago que ya registró otro usuario. No borra la marca
    // (posible_duplicado_de queda para trazabilidad), solo apaga
    // pendiente_revision (ver GastosService.confirmarDuplicado, Paso 4.2).
    @Patch(':id/confirmar-duplicado')
    async confirmarDuplicado(@Param('id', ParseIntPipe) id: number) {
        return this.gastosService.confirmarDuplicado(id);
    }

    // Vista de duplicados: el usuario confirma que NO es el mismo pago (dos
    // gastos distintos que solo coincidían en monto/fecha). Limpia la marca
    // por completo (ver GastosService.descartarDuplicado, Paso 4.2).
    @Patch(':id/descartar-duplicado')
    async descartarDuplicado(@Param('id', ParseIntPipe) id: number) {
        return this.gastosService.descartarDuplicado(id);
    }

    @Post(':id/comprobante')
    async adjuntarComprobante(@Param('id', ParseIntPipe) id: number, @Body() body: any, @Request() req) {
        if (!id) throw new NotFoundException('Gasto no encontrado');
        const empresaId = resolverEmpresaIdFiltro(req);
        return this.gastosService.adjuntarComprobante(id, body, undefined, undefined, undefined, empresaId);
    }

    // Botón "Añadir" de Pagos en ExpenseDetail. `medio` es obligatorio (uno
    // de 'yape' | 'transferencia' | 'efectivo' | 'tarjeta' | 'otro', ver
    // DatosPago); numero_operacion y monto son opcionales.
    @Post(':id/pago')
    async agregarPago(@Param('id', ParseIntPipe) id: number, @Body() body: DatosPago, @Request() req) {
        const empresaId = resolverEmpresaIdFiltro(req);
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
        const empresaId = resolverEmpresaIdFiltro(req);
        return this.gastosService.subirEvidenciaImagen(id, file, empresaId);
    }
}