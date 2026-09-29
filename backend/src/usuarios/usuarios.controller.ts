import { Body, Controller, Delete, ForbiddenException, Get, Param, ParseIntPipe, Patch, Post, Query, Request, UseGuards } from '@nestjs/common';
import { resolverRolAlta } from '../auth/roles-empresa';
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

    // super_admin ve usuarios de todas las empresas; admin solo ve los que
    // tengan acceso a la suya (Paso 33: puede ser una entre varias).
    //
    // Con ?empresa_id= (el panel web siempre lo manda) lista los miembros de la
    // empresa activa; el rol de req.user ya se derivó de esa misma empresa.
    @Get()
    @Roles('super_admin', 'admin')
    listar(@Query('empresa_id') empresaIdQuery: string | undefined, @Request() req) {
        const pedida = Number(empresaIdQuery);
        const empresaId =
            req.user.rol === 'super_admin'
                ? (Number.isInteger(pedida) && pedida > 0 ? pedida : undefined)
                : (req.user.empresa_activa_id ?? req.user.empresa_ids?.[0]);
        return this.usuariosService.listar(empresaId);
    }

    // super_admin puede crear admin/empleado para cualquier empresa (indicando empresa_ids).
    // admin solo puede crear empleados/admins para SU PROPIA empresa (empresa_ids del body se ignora).
    @Post()
    @Roles('super_admin', 'admin')
    crear(@Body() dto: CrearUsuarioDto, @Request() req) {
        // Valida que quien crea pueda otorgar ese rol (p. ej. solo un
        // propietario crea propietarios) y deriva el rol legacy.
        const alta = resolverRolAlta(dto, { es_super_admin: req.user.es_super_admin, rol_empresa: req.user.rol_empresa });
        if (req.user.rol === 'admin') {
            if (dto.rol === 'super_admin') {
                throw new ForbiddenException('Un admin de empresa no puede crear super_admin');
            }
            // El nuevo miembro queda SOLO en la empresa activa de quien lo crea
            // (no en todas las que este administra).
            const empresaActiva = req.user.empresa_activa_id;
            return this.usuariosService.crear(dto, empresaActiva != null ? [empresaActiva] : req.user.empresa_ids, alta);
        }
        return this.usuariosService.crear(dto, undefined, alta);
    }

    // Igual que crear(): admin solo puede editar usuarios que ya tengan
    // acceso a su propia empresa y no puede ascender a nadie a super_admin,
    // ni reasignar empresas (eso lo hace solo super_admin).
    //
    // Protección contra auto-bloqueo: nadie puede cambiar su propio rol ni
    // desactivar su propia cuenta desde acá, sin importar el rol que tenga
    // (ni siquiera super_admin) -- si fuera el único super_admin activo,
    // quedaría sin forma de revertirlo. Debe hacerlo otro usuario con
    // permisos, o directo en la base de datos como último recurso.
    @Patch(':id')
    @Roles('super_admin', 'admin')
    actualizar(@Param('id', ParseIntPipe) id: number, @Body() dto: ActualizarUsuarioDto, @Request() req) {
        if (id === req.user.id) {
            if (dto.rol !== undefined && dto.rol !== req.user.rol) {
                throw new ForbiddenException('No puedes cambiar tu propio rol');
            }
            if (dto.activo === false) {
                throw new ForbiddenException('No puedes desactivar tu propio usuario');
            }
            // Mismo motivo que el rol: si pudieras tocar tu propio
            // puede_registrar_personal, un admin (o cualquier usuario con
            // acceso a este endpoint) se auto-otorgaría un permiso que el
            // super_admin/admin superior decidió no darle, sin que nadie más
            // lo apruebe. El frontend ya oculta este campo al editarte a ti
            // mismo (UserList.jsx) -- esto es la validación real, porque el
            // frontend se puede saltear pegándole directo al PATCH.
            if (dto.puede_registrar_personal !== undefined && dto.puede_registrar_personal !== req.user.puede_registrar_personal) {
                throw new ForbiddenException('No puedes cambiar tu propio permiso de gastos personales');
            }
        }

        if (req.user.rol === 'admin') {
            if (dto.rol === 'super_admin') {
                throw new ForbiddenException('Un admin de empresa no puede otorgar el rol super_admin');
            }
            return this.usuariosService.actualizar(id, dto, req.user.empresa_ids?.[0]);
        }
        return this.usuariosService.actualizar(id, dto);
    }

    @Patch(':id/desactivar')
    @Roles('super_admin', 'admin')
    desactivar(@Param('id', ParseIntPipe) id: number, @Request() req) {
        if (id === req.user.id) {
            throw new ForbiddenException('No puedes desactivar tu propio usuario');
        }
        return this.usuariosService.desactivar(id);
    }

    @Delete(':id')
    @Roles('super_admin', 'admin')
    eliminar(@Param('id', ParseIntPipe) id: number, @Request() req) {
        if (id === req.user.id) {
            throw new ForbiddenException('No puedes eliminar tu propio usuario');
        }
        const empresaId = req.user.rol === 'admin' ? req.user.empresa_ids?.[0] : undefined;
        return this.usuariosService.eliminar(id, empresaId);
    }
}