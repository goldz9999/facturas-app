import { BadRequestException, Body, Controller, ForbiddenException, Get, NotFoundException, Param, ParseIntPipe, Patch, Post, Query, Request, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiQuery } from '@nestjs/swagger';
import { GastosService, FiltrosGastos, DatosPago, MedioPago } from './gastos.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { resolverEmpresaIdFiltro } from '../common/resolver-empresa.util';

// Espacio "Gastos personales" (?ambito=personal): los gastos marcados como
// personales del propio usuario, en todas las empresas a las que tiene acceso.
// No es una empresa: el aislamiento sigue siendo la lista empresa_ids del usuario.
function alcance(req: { user: { id: number; rol: string; empresa_ids: number[] } }, empresaIdQuery: string | undefined, ambito: string | undefined) {
    if (ambito === 'personal') return { empresaId: req.user.empresa_ids ?? [], personalDe: req.user.id };
    return { empresaId: resolverEmpresaIdFiltro(req, empresaIdQuery), personalDe: undefined };
}

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
    @ApiQuery({ name: 'duplicado_confirmado', required: false, type: Boolean })
    @ApiQuery({ name: 'sin_comprobante', required: false, type: Boolean })
    @ApiQuery({ name: 'empresa_id', required: false, type: Number, description: 'Filtrar por una empresa específica' })
    @ApiQuery({ name: 'limite', required: false, type: Number })
    @ApiQuery({ name: 'offset', required: false, type: Number })
    @ApiQuery({ name: 'ambito', required: false, enum: ['personal'], description: 'personal = solo mis gastos personales' })
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
            duplicadoConfirmado: aBooleano(q.duplicado_confirmado),
            sinComprobante: aBooleano(q.sin_comprobante),
            limite: aNumero(q.limite),
            offset: aNumero(q.offset),
        };

        const { empresaId, personalDe } = alcance(req, q.empresa_id, q.ambito);
        if (personalDe !== undefined) Object.assign(filtros, { esPersonal: true, usuarioId: personalDe });
        return this.gastosService.listar(filtros, empresaId);
    }

    // Hallazgo 37.4-A: exponía los últimos gastos de CUALQUIER usuarioId a
    // cualquier usuario autenticado (nadie lo llamaba desde el frontend,
    // pero el endpoint existía sin protección). Ahora solo el propio
    // usuario puede consultar sus últimos gastos -- ni siquiera super_admin
    // consulta los de otro por acá.
    @ApiQuery({ name: 'limite', required: false, type: Number })
    @Get('usuario/:usuarioId/ultimos')
    async ultimosPorUsuario(
        @Param('usuarioId', ParseIntPipe) usuarioId: number,
        @Query('limite') limite?: string,
        @Request() req?,
    ) {
        if (usuarioId !== req.user.id) {
            throw new ForbiddenException('Solo puedes consultar tus propios últimos gastos.');
        }
        const n = limite ? parseInt(limite, 10) : 5;
        return this.gastosService.ultimosPorUsuario(usuarioId, n);
    }

    // Totales para Dashboard.jsx (hoy/semana/mes, empresa vs personal, top
    // categorías/proveedores, últimos gastos). Debe declararse antes de
    // GET ':id' -- si no, Nest interpreta "resumen" como un :id numérico
    // que ParseIntPipe rechaza con 400 antes de llegar acá.
    @ApiQuery({ name: 'empresa_id', required: false, type: Number, description: 'Filtrar por una empresa específica' })
    @ApiQuery({ name: 'ambito', required: false, enum: ['personal'], description: 'personal = solo mis gastos personales' })
    @Get('resumen')
    async resumen(@Query('empresa_id') empresaIdQuery: string | undefined, @Query('ambito') ambito: string | undefined, @Request() req) {
        const { empresaId, personalDe } = alcance(req, empresaIdQuery, ambito);
        return this.gastosService.resumen(empresaId, personalDe);
    }

    // Conteos para las cards resumen de Gastos.jsx. Debe declararse antes de
    // GET ':id' por el mismo motivo que 'resumen' (ParseIntPipe).
    @ApiQuery({ name: 'empresa_id', required: false, type: Number, description: 'Filtrar por una empresa específica' })
    @ApiQuery({ name: 'ambito', required: false, enum: ['personal'], description: 'personal = solo mis gastos personales' })
    @Get('conteos')
    async conteos(@Query('empresa_id') empresaIdQuery: string | undefined, @Query('ambito') ambito: string | undefined, @Request() req) {
        const { empresaId, personalDe } = alcance(req, empresaIdQuery, ambito);
        return this.gastosService.contarPorEstado(empresaId, personalDe);
    }

    @ApiQuery({ name: 'empresa_id', required: false, type: Number })
    @Get(':id')
    async obtenerPorId(@Param('id', ParseIntPipe) id: number, @Query('empresa_id') empresaIdQuery: string | undefined, @Request() req) {
        const empresaId = resolverEmpresaIdFiltro(req, empresaIdQuery);
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
            // RF-11: asociar/cambiar el pedido del gasto desde el panel.
            // null quita la asociación ("Sin pedido"). GastosService valida
            // que el pedido sea de la misma empresa del gasto.
            pedido_id?: number | null;
            proveedor_nombre?: string;
            proveedor_ruc?: string | null;
            medio_pago?: MedioPago;
        },
        @Query('empresa_id') empresaIdQuery: string | undefined,
        @Request() req,
    ) {
        const empresaId = resolverEmpresaIdFiltro(req, empresaIdQuery);
        // Solo estos campos: el body no pasa por un DTO, y sin este filtro se
        // podría escribir cualquier columna (empresa_id, usuario_id, ...).
        const permitidos = ['monto', 'descripcion', 'es_personal', 'categoria_id', 'proveedor_id', 'pedido_id', 'proveedor_nombre', 'proveedor_ruc', 'medio_pago'] as const;
        const cambios = Object.fromEntries(permitidos.filter((k) => body?.[k] !== undefined).map((k) => [k, body[k]]));
        return this.gastosService.actualizar(id, cambios, empresaId);
    }

    // Bandeja de revisión (ReviewInbox.jsx): el usuario confirma que un
    // gasto con confianza media/baja está correcto tal como lo extrajo la
    // IA, sin corregir el monto. Sube confianza a 'alta' y apaga
    // pendiente_revision (ver GastosService.confirmarConfianza, Paso 4.3).
    @ApiQuery({ name: 'empresa_id', required: false, type: Number })
    @Patch(':id/confirmar-confianza')
    async confirmarConfianza(@Param('id', ParseIntPipe) id: number, @Query('empresa_id') empresaIdQuery: string | undefined, @Request() req) {
        const empresaId = resolverEmpresaIdFiltro(req, empresaIdQuery);
        return this.gastosService.confirmarConfianza(id, empresaId);
    }

    // Vista de duplicados (DuplicatesReview.jsx): el usuario confirma que sí
    // es el mismo pago que ya registró otro usuario. No borra la marca
    // (posible_duplicado_de queda para trazabilidad), solo apaga
    // pendiente_revision (ver GastosService.confirmarDuplicado, Paso 4.2).
    @ApiQuery({ name: 'empresa_id', required: false, type: Number })
    @Patch(':id/confirmar-duplicado')
    async confirmarDuplicado(@Param('id', ParseIntPipe) id: number, @Query('empresa_id') empresaIdQuery: string | undefined, @Request() req) {
        const empresaId = resolverEmpresaIdFiltro(req, empresaIdQuery);
        return this.gastosService.confirmarDuplicado(id, empresaId);
    }

    // Vista de duplicados: el usuario confirma que NO es el mismo pago (dos
    // gastos distintos que solo coincidían en monto/fecha). Limpia la marca
    // por completo (ver GastosService.descartarDuplicado, Paso 4.2).
    @ApiQuery({ name: 'empresa_id', required: false, type: Number })
    @Patch(':id/descartar-duplicado')
    async descartarDuplicado(@Param('id', ParseIntPipe) id: number, @Query('empresa_id') empresaIdQuery: string | undefined, @Request() req) {
        const empresaId = resolverEmpresaIdFiltro(req, empresaIdQuery);
        return this.gastosService.descartarDuplicado(id, empresaId);
    }

    // Botón "X" de ReviewInbox.jsx: el usuario descarta un gasto mal
    // capturado (no es un duplicado, es basura/error de lectura). Borra el
    // gasto y sus filas hijas (ver GastosService.rechazar).
    @ApiQuery({ name: 'empresa_id', required: false, type: Number })
    @Patch(':id/rechazar')
    async rechazar(@Param('id', ParseIntPipe) id: number, @Query('empresa_id') empresaIdQuery: string | undefined, @Request() req) {
        const empresaId = resolverEmpresaIdFiltro(req, empresaIdQuery);
        return this.gastosService.rechazar(id, empresaId);
    }

    @Post(':id/comprobante')
    async adjuntarComprobante(@Param('id', ParseIntPipe) id: number, @Body() body: any, @Query('empresa_id') empresaIdQuery: string | undefined, @Request() req) {
        if (!id) throw new NotFoundException('Gasto no encontrado');
        const empresaId = resolverEmpresaIdFiltro(req, empresaIdQuery);
        return this.gastosService.adjuntarComprobante(id, body, undefined, undefined, undefined, empresaId);
    }

    // Editar el comprobante desde el panel de Revisión (ReviewDashboard):
    // a diferencia de POST arriba (que siempre inserta uno nuevo, pensado
    // para el flujo de Telegram), este actualiza el comprobante existente
    // del gasto si ya tiene uno, para no dejar filas duplicadas.
    @ApiQuery({ name: 'empresa_id', required: false, type: Number })
    @Patch(':id/comprobante')
    async actualizarComprobante(
        @Param('id', ParseIntPipe) id: number,
        @Body() body: { tipo?: string; numero?: string | null },
        @Query('empresa_id') empresaIdQuery: string | undefined,
        @Request() req,
    ) {
        const empresaId = resolverEmpresaIdFiltro(req, empresaIdQuery);
        return this.gastosService.actualizarComprobante(id, body, empresaId);
    }

    // Botón "Añadir" de Pagos en ExpenseDetail. `medio` es obligatorio (uno
    // de 'yape' | 'transferencia' | 'efectivo' | 'tarjeta' | 'otro', ver
    // DatosPago); numero_operacion y monto son opcionales.
    @Post(':id/pago')
    async agregarPago(@Param('id', ParseIntPipe) id: number, @Body() body: DatosPago, @Query('empresa_id') empresaIdQuery: string | undefined, @Request() req) {
        const empresaId = resolverEmpresaIdFiltro(req, empresaIdQuery);
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
        @Query('empresa_id') empresaIdQuery: string | undefined,
        @Request() req,
    ) {
        if (!file) throw new BadRequestException('No se recibió ningún archivo.');
        const empresaId = resolverEmpresaIdFiltro(req, empresaIdQuery);
        return this.gastosService.subirEvidenciaImagen(id, file, empresaId);
    }
}