import { BadRequestException, Body, Controller, Get, Param, Patch, Query, Request, UseGuards } from '@nestjs/common';
import { ApiQuery } from '@nestjs/swagger';
import { ProveedoresService } from './proveedores.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

// GET es de solo lectura (los proveedores se crean desde el flujo de
// Telegram vía ProveedoresService.buscarOCrear, no desde el panel web).
// El PATCH sí es editable desde el panel: guarda la misma "regla de
// clasificación aprendida" (categoria_id_sugerida / es_personal_sugerido)
// que Telegram ya guarda con guardarSugerencia() -- no se agregó lógica
// nueva, solo se expuso la que ya existía (mismo criterio que en 24.1/24.3
// de PROGRESO_SIREGG). Desbloquea ProviderList.jsx / ProviderDetail.jsx.
@UseGuards(JwtAuthGuard)
@Controller('proveedores')
export class ProveedoresController {
    constructor(private proveedoresService: ProveedoresService) { }

    // Mismo criterio que CategoriasController: admin/empleado quedan
    // acotados a su empresa (desde el JWT); super_admin no tiene empresa
    // propia y debe indicar una explícitamente, porque un catálogo de
    // proveedores mezclando varias empresas no es un caso de uso real.
    private resolverEmpresaId(req: any, empresaIdQuery?: string): number {
        if (req.user.rol !== 'super_admin') {
            return req.user.empresa_id;
        }
        const id = empresaIdQuery ? Number(empresaIdQuery) : undefined;
        if (!id) {
            throw new BadRequestException(
                'Como super_admin, indica ?empresa_id= para ver proveedores de una empresa.',
            );
        }
        return id;
    }

    @ApiQuery({ name: 'empresa_id', required: false, type: Number, description: 'Solo super_admin: obligatorio' })
    @Get()
    async listar(@Query('empresa_id') empresaIdQuery: string, @Request() req) {
        return this.proveedoresService.listar(this.resolverEmpresaId(req, empresaIdQuery));
    }

    // Guarda la "regla de clasificación aprendida" desde el panel web
    // (botón "Guardar regla" en ProviderDetail.jsx). Reusa
    // ProveedoresService.guardarSugerencia -- el mismo método que ya usa
    // TelegramService -- así que una corrección hecha acá también alimenta
    // la próxima sugerencia automática del bot, no es un dato aparte.
    //
    // empresaId siempre resuelto server-side (nunca del body), mismo
    // criterio de aislamiento multiempresa que el resto del controller: si
    // el proveedor no es de esa empresa, guardarSugerencia() no actualiza
    // ninguna fila (el .eq('empresa_id', ...) del UPDATE no matchea).
    @ApiQuery({ name: 'empresa_id', required: false, type: Number, description: 'Solo super_admin: obligatorio' })
    @Patch(':id')
    async actualizar(
        @Param('id') id: string,
        @Body() body: { categoria_id?: number; es_personal?: boolean },
        @Query('empresa_id') empresaIdQuery: string,
        @Request() req,
    ) {
        const empresaId = this.resolverEmpresaId(req, empresaIdQuery);
        if (body.categoria_id === undefined || body.es_personal === undefined) {
            throw new BadRequestException('Faltan categoria_id y/o es_personal en el body.');
        }
        await this.proveedoresService.guardarSugerencia(Number(id), body.categoria_id, body.es_personal, empresaId);
        return { success: true };
    }
}