import { BadRequestException, Body, Controller, Get, Param, Patch, Query, Request, UseGuards } from '@nestjs/common';
import { ApiQuery } from '@nestjs/swagger';
import { ProveedoresService } from './proveedores.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesEmpresaGuard } from '../auth/guards/roles-empresa.guard';
import { RolesEmpresa } from '../auth/decorators/roles-empresa.decorator';
import { resolverEmpresaId } from '../common/resolver-empresa.util';

// GET es de solo lectura (los proveedores se crean desde el flujo de
// Telegram vía ProveedoresService.buscarOCrear, no desde el panel web).
// El PATCH sí es editable desde el panel: guarda la misma "regla de
// clasificación aprendida" (categoria_id_sugerida / es_personal_sugerido)
// que Telegram ya guarda con guardarSugerencia() -- no se agregó lógica
// nueva, solo se expuso la que ya existía (mismo criterio que en 24.1/24.3
// de PROGRESO_SIREGG). Desbloquea ProviderList.jsx / ProviderDetail.jsx.
@UseGuards(JwtAuthGuard, RolesEmpresaGuard)
@Controller('proveedores')
export class ProveedoresController {
    constructor(private proveedoresService: ProveedoresService) { }

    // Resuelve la empresa (ver common/resolver-empresa.util.ts). Mismo
    // criterio que CategoriasController: un catálogo de proveedores
    // mezclando varias empresas no es un caso de uso real, así que si el
    // usuario tiene acceso a más de una (Paso 33) debe indicar cuál.

    @ApiQuery({ name: 'empresa_id', required: false, type: Number, description: 'Obligatorio si tienes acceso a más de una empresa' })
    @Get()
    async listar(@Query('empresa_id') empresaIdQuery: string, @Request() req) {
        return this.proveedoresService.listar(resolverEmpresaId(req, empresaIdQuery));
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
    @ApiQuery({ name: 'empresa_id', required: false, type: Number, description: 'Obligatorio si tienes acceso a más de una empresa' })
    @RolesEmpresa('propietario', 'administrador', 'contador')
    @Patch(':id')
    async actualizar(
        @Param('id') id: string,
        @Body() body: { categoria_id?: number; es_personal?: boolean },
        @Query('empresa_id') empresaIdQuery: string,
        @Request() req,
    ) {
        const empresaId = resolverEmpresaId(req, empresaIdQuery);
        if (body.categoria_id === undefined || body.es_personal === undefined) {
            throw new BadRequestException('Faltan categoria_id y/o es_personal en el body.');
        }
        await this.proveedoresService.guardarSugerencia(Number(id), body.categoria_id, body.es_personal, empresaId);
        return { success: true };
    }
}