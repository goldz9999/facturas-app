import { Body, Controller, Delete, ForbiddenException, Get, Param, ParseIntPipe, Patch, Post, Request, UseGuards } from '@nestjs/common';
import { UsuariosService } from './usuarios.service';
import { CrearUsuarioDto } from './dto/crear-usuario.dto';
import { ActualizarUsuarioDto } from './dto/actualizar-usuario.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('usuarios')
export class UsuariosController {
    constructor(private usuariosService: UsuariosService) { }

    // super_admin ve usuarios de todas las empresas; admin solo ve los de la suya.
    @Get()
    @Roles('super_admin', 'admin')
    listar(@Request() req) {
        const empresaId = req.user.rol === 'super_admin' ? undefined : req.user.empresa_id;
        return this.usuariosService.listar(empresaId);
    }

    // super_admin puede crear admin/empleado para cualquier empresa (indicando empresa_id).
    // admin solo puede crear empleados/admins para SU PROPIA empresa (empresa_id del body se ignora).
    @Post()
    @Roles('super_admin', 'admin')
    crear(@Body() dto: CrearUsuarioDto, @Request() req) {
        if (req.user.rol === 'admin') {
            if (dto.rol === 'super_admin') {
                throw new ForbiddenException('Un admin de empresa no puede crear super_admin');
            }
            return this.usuariosService.crear(dto, req.user.empresa_id);
        }
        return this.usuariosService.crear(dto);
    }

    // Igual que crear(): admin solo puede editar usuarios de su propia
    // empresa y no puede ascender a nadie a super_admin.
    @Patch(':id')
    @Roles('super_admin', 'admin')
    actualizar(@Param('id', ParseIntPipe) id: number, @Body() dto: ActualizarUsuarioDto, @Request() req) {
        if (req.user.rol === 'admin') {
            if (dto.rol === 'super_admin') {
                throw new ForbiddenException('Un admin de empresa no puede otorgar el rol super_admin');
            }
            return this.usuariosService.actualizar(id, dto, req.user.empresa_id);
        }
        return this.usuariosService.actualizar(id, dto);
    }

    @Patch(':id/desactivar')
    @Roles('super_admin', 'admin')
    desactivar(@Param('id', ParseIntPipe) id: number) {
        return this.usuariosService.desactivar(id);
    }

    @Delete(':id')
    @Roles('super_admin', 'admin')
    eliminar(@Param('id', ParseIntPipe) id: number, @Request() req) {
        const empresaId = req.user.rol === 'admin' ? req.user.empresa_id : undefined;
        return this.usuariosService.eliminar(id, empresaId);
    }
}