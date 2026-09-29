import { Body, Controller, Delete, ForbiddenException, Get, Param, ParseIntPipe, Patch, Post, Request, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { EmpresasService } from './empresas.service';
import { CrearEmpresaDto } from './dto/crear-empresa.dto';
import { ActualizarEmpresaDto } from './dto/actualizar-empresa.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

// Solo super_admin gestiona empresas: son quienes ven/crean el nivel
// "tenant" completo. Un admin de empresa ni siquiera necesita listar otras.
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('empresas')
export class EmpresasController {
    constructor(private empresasService: EmpresasService) { }

    @Get()
    @Roles('super_admin')
    listar() {
        return this.empresasService.listar();
    }

    // Paso 33: usado por el EmpresaSwitcher del frontend para admin/empleado
    // con acceso a más de una empresa (antes solo existía para
    // super_admin, que usa listar() de arriba). Cualquier rol autenticado
    // puede llamarlo -- cada quien solo ve las suyas, resueltas desde su
    // propio JWT, nunca de un query param.
    @Get('mias')
    @Roles('super_admin', 'admin', 'empleado')
    async mias(@Request() req) {
        if (req.user.rol === 'super_admin') {
            return this.empresasService.listar();
        }
        const ids: number[] = req.user.empresa_ids ?? [];
        return Promise.all(ids.map((id) => this.empresasService.obtenerPorId(id)));
    }

    // Un admin puede consultar cualquier empresa a la que tenga acceso
    // (Paso 33: puede ser más de una); super_admin puede ver cualquiera.
    @Get(':id')
    @Roles('super_admin', 'admin')
    async obtenerPorId(@Param('id', ParseIntPipe) id: number, @Request() req) {
        // Solo la empresa activa: el rol de admin se derivó de ELLA, no de las demás.
        if (req.user.rol === 'admin' && req.user.empresa_activa_id !== id) {
            throw new ForbiddenException('No tienes acceso a esa empresa.');
        }
        return this.empresasService.obtenerPorId(id);
    }

    @Post()
    @Roles('super_admin')
    @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 3 * 1024 * 1024 } })) // 3MB
    crear(@Body() dto: CrearEmpresaDto, @UploadedFile() file?: Express.Multer.File) {
        return this.empresasService.crear(dto, file);
    }

    // Un administrador/propietario solo puede renombrar SU empresa activa; activar/desactivar
    // y el logo siguen siendo del super admin.
    @Patch(':id')
    @Roles('super_admin', 'admin')
    async actualizar(@Param('id', ParseIntPipe) id: number, @Body() dto: ActualizarEmpresaDto, @Request() req) {
        if (req.user.es_super_admin) return this.empresasService.actualizar(id, dto);
        if (req.user.empresa_activa_id !== id) {
            throw new ForbiddenException('Solo puedes modificar la empresa activa.');
        }
        return this.empresasService.actualizar(id, { nombre: dto.nombre });
    }

    @Patch(':id/logo')
    @Roles('super_admin')
    @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 3 * 1024 * 1024 } })) // 3MB
    subirLogo(@Param('id', ParseIntPipe) id: number, @UploadedFile() file: Express.Multer.File) {
        return this.empresasService.actualizarLogo(id, file);
    }

    @Delete(':id')
    @Roles('super_admin')
    eliminar(@Param('id', ParseIntPipe) id: number) {
        return this.empresasService.eliminar(id);
    }
}