import { Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Request, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
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

    // Un admin puede consultar su propia empresa (chequeo hecho en el controller
    // porque el service no conoce el request); super_admin puede ver cualquiera.
    @Get(':id')
    @Roles('super_admin', 'admin')
    async obtenerPorId(@Param('id', ParseIntPipe) id: number, @Request() req) {
        if (req.user.rol === 'admin' && req.user.empresa_id !== id) {
            return this.empresasService.obtenerPorId(req.user.empresa_id);
        }
        return this.empresasService.obtenerPorId(id);
    }

    @Post()
    @Roles('super_admin')
    @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 3 * 1024 * 1024 } })) // 3MB
    crear(@Body() dto: CrearEmpresaDto, @UploadedFile() file?: Express.Multer.File) {
        return this.empresasService.crear(dto, file);
    }

    @Patch(':id')
    @Roles('super_admin')
    actualizar(@Param('id', ParseIntPipe) id: number, @Body() dto: ActualizarEmpresaDto) {
        return this.empresasService.actualizar(id, dto);
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