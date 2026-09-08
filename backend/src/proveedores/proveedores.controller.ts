import { BadRequestException, Controller, Get, Query, Request, UseGuards } from '@nestjs/common';
import { ApiQuery } from '@nestjs/swagger';
import { ProveedoresService } from './proveedores.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

// Solo lectura por ahora: los proveedores se crean/editan desde el flujo de
// Telegram (ProveedoresService.buscarOCrear), no desde el panel web. Esto
// solo desbloquea ProviderList.jsx / ProviderDetail.jsx (ver Paso 23.3 de
// PROGRESO_SIREGG: "GET /proveedores no existe, bloquea Providers.jsx").
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
}