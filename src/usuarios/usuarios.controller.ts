import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, NotFoundException, Param, ParseIntPipe, Patch, Post, Put, Query, Request, UseGuards } from '@nestjs/common';
import { ArrayNotEmpty, IsArray, IsInt } from 'class-validator';
import { combinarEmpresas, empresasGestionables, esSuperAdmin, resolverRolAlta, validarGestion, validarPermisoPersonal, validarPermisoTelegram } from '../auth/roles-empresa';
import { UsuariosService } from './usuarios.service';
import { CrearUsuarioDto } from './dto/crear-usuario.dto';
import { ActualizarUsuarioDto } from './dto/actualizar-usuario.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

class EmpresasUsuarioDto {
    @IsArray()
    @ArrayNotEmpty({ message: 'Elige al menos una empresa.' })
    @IsInt({ each: true })
    empresa_ids: number[];
}

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('usuarios')
export class UsuariosController {
    constructor(private usuariosService: UsuariosService) { }

    // El rol de req.user (admin) se derivó de la empresa activa de este request
    // (?empresa_id=). Todo el alcance de un admin debe usar ESA misma empresa,
    // no la primera de su lista: si no, sería admin por la empresa B pero
    // actuaría sobre la A, donde puede ser un simple empleado.
    private empresaActiva(req: any): number {
        const id = req.user.empresa_activa_id;
        if (id == null) throw new ForbiddenException('No hay una empresa activa para esta operación.');
        return id;
    }

    // Antes de tocar a otro usuario: debe pertenecer a la empresa activa y no
    // tener más privilegio que quien lo toca (un admin no gestiona propietarios
    // ni super admins).
    // Empresas en las que quien llama puede dar o quitar acceso: el propietario
    // en todas; un administrador, en las que administra; el super admin, en todas.
    private async gestionables(req: any): Promise<number[]> {
        if (req.user.es_super_admin) return this.usuariosService.idsEmpresasActivas();
        return empresasGestionables({ empresas: req.user.empresas ?? [] });
    }

    private async verificarGestion(req: any, id: number, empresaId: number): Promise<void> {
        const objetivo = await this.usuariosService.obtenerPorId(id);
        if (!objetivo) throw new NotFoundException(`Usuario ${id} no encontrado`);
        const enEmpresa = objetivo.empresas.find((e) => e.empresa_id === empresaId);
        if (!enEmpresa) throw new NotFoundException(`Usuario ${id} no encontrado en tu empresa`);
        validarGestion(
            { es_super_admin: req.user.es_super_admin, rol_empresa: req.user.rol_empresa },
            { es_super_admin: esSuperAdmin({ es_super_admin: objetivo.es_super_admin, rol: objetivo.rol }), rol_empresa: enEmpresa.rol },
        );
    }

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
    async crear(@Body() dto: CrearUsuarioDto, @Request() req) {
        // Valida que quien crea pueda otorgar ese rol (p. ej. solo un
        // propietario crea propietarios) y deriva el rol legacy.
        const alta = resolverRolAlta(dto, { es_super_admin: req.user.es_super_admin, rol_empresa: req.user.rol_empresa });
        validarPermisoPersonal({ es_super_admin: req.user.es_super_admin, rol_empresa: req.user.rol_empresa }, dto.puede_registrar_personal || undefined);
        if (dto.telegram_id !== undefined && !req.user.puede_gestionar_telegram) {
            throw new ForbiddenException('No tienes permiso para gestionar cuentas de Telegram.');
        }
        if (req.user.rol === 'admin') {
            if (dto.rol === 'super_admin') {
                throw new ForbiddenException('Un admin de empresa no puede crear super_admin');
            }
            // Por defecto el nuevo miembro queda en la empresa activa de quien lo
            // crea. Si pide más (empresa_ids), solo entre las que administra.
            const empresaActiva = this.empresaActiva(req);
            let empresas = [empresaActiva];
            if (dto.empresa_ids?.length) {
                const gestionables = await this.gestionables(req);
                empresas = combinarEmpresas([], dto.empresa_ids, gestionables);
            }
            return this.usuariosService.crear(dto, empresas, alta);
        }
        return this.usuariosService.crear(dto, undefined, alta);
    }

    // Igual que crear(): admin solo puede editar usuarios que ya tengan
    // acceso a su propia empresa (la activa) y no puede ascender a nadie a
    // super_admin, ni reasignar empresas (eso lo hace solo super_admin). Tampoco
    // puede modificar a un propietario ni a un super_admin.
    //
    // Protección contra auto-bloqueo: nadie puede cambiar su propio rol ni
    // desactivar su propia cuenta desde acá, sin importar el rol que tenga
    // (ni siquiera super_admin) -- si fuera el único super_admin activo,
    // quedaría sin forma de revertirlo. Debe hacerlo otro usuario con
    // permisos, o directo en la base de datos como último recurso.
    @Patch(':id')
    @Roles('super_admin', 'admin')
    async actualizar(
        @Param('id', ParseIntPipe) id: number,
        @Body() dto: ActualizarUsuarioDto,
        @Request() req,
        @Query('empresa_id') empresaIdQuery?: string,
    ) {
        validarPermisoPersonal({ es_super_admin: req.user.es_super_admin, rol_empresa: req.user.rol_empresa }, dto.puede_registrar_personal);
        validarPermisoTelegram({ es_super_admin: req.user.es_super_admin, rol_empresa: req.user.rol_empresa }, dto.puede_gestionar_telegram);
        // La cuenta de Telegram se gestiona en /telegram/usuarios (con su propio permiso).
        if (dto.telegram_id !== undefined && !req.user.puede_gestionar_telegram) {
            throw new ForbiddenException('No tienes permiso para gestionar cuentas de Telegram.');
        }
        if (id === req.user.id && dto.puede_gestionar_telegram !== undefined && dto.puede_gestionar_telegram !== req.user.puede_gestionar_telegram) {
            throw new ForbiddenException('No puedes cambiar tu propio permiso de Telegram');
        }
        if (dto.rol_empresa !== undefined) {
            if (id === req.user.id && dto.rol_empresa !== req.user.rol_empresa) {
                throw new ForbiddenException('No puedes cambiar tu propio rol');
            }
            // Mismas reglas que al crear: solo un propietario nombra propietarios.
            resolverRolAlta({ rol_empresa: dto.rol_empresa }, { es_super_admin: req.user.es_super_admin, rol_empresa: req.user.rol_empresa });
        }
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
            const empresaId = this.empresaActiva(req);
            await this.verificarGestion(req, id, empresaId);
            return this.usuariosService.actualizar(id, dto, empresaId);
        }
        if (dto.rol_empresa !== undefined) {
            const empresa = Number(empresaIdQuery);
            if (!Number.isInteger(empresa) || empresa <= 0) throw new BadRequestException('Indica ?empresa_id= para cambiar el rol en una empresa.');
            return this.usuariosService.actualizar(id, dto, undefined, empresa);
        }
        return this.usuariosService.actualizar(id, dto);
    }

    // A qué empresas pertenece un miembro de la empresa activa. Solo se tocan las
    // empresas que quien edita gestiona; las demás del usuario se conservan.
    // Las empresas nuevas reciben el mismo rol que tiene en la empresa activa.
    @Put(':id/empresas')
    @Roles('super_admin', 'admin')
    async empresas(@Param('id', ParseIntPipe) id: number, @Body() dto: EmpresasUsuarioDto, @Request() req) {
        const empresaId = this.empresaActiva(req);
        await this.verificarGestion(req, id, empresaId);
        const objetivo = (await this.usuariosService.obtenerPorId(id))!;
        const gestionables = await this.gestionables(req);
        const final = combinarEmpresas(objetivo.empresa_ids, dto.empresa_ids, gestionables);
        const rolActual = objetivo.empresas.find((e) => e.empresa_id === empresaId)?.rol ?? 'empleado';
        // Nadie da el rol propietario por esta vía salvo otro propietario (o super admin).
        const rolNuevas = rolActual === 'propietario' && !(req.user.es_super_admin || req.user.rol_empresa === 'propietario') ? 'empleado' : rolActual;
        await this.usuariosService.asignarEmpresas(id, final, rolNuevas);
        return this.usuariosService.obtenerPorId(id);
    }

    @Patch(':id/desactivar')
    @Roles('super_admin', 'admin')
    async desactivar(@Param('id', ParseIntPipe) id: number, @Request() req) {
        if (id === req.user.id) {
            throw new ForbiddenException('No puedes desactivar tu propio usuario');
        }
        if (req.user.rol === 'admin') {
            const empresaId = this.empresaActiva(req);
            await this.verificarGestion(req, id, empresaId);
            return this.usuariosService.desactivar(id, empresaId);
        }
        return this.usuariosService.desactivar(id);
    }

    @Delete(':id')
    @Roles('super_admin', 'admin')
    async eliminar(@Param('id', ParseIntPipe) id: number, @Request() req) {
        if (id === req.user.id) {
            throw new ForbiddenException('No puedes eliminar tu propio usuario');
        }
        if (req.user.rol === 'admin') {
            const empresaId = this.empresaActiva(req);
            await this.verificarGestion(req, id, empresaId);
            return this.usuariosService.eliminar(id, empresaId);
        }
        return this.usuariosService.eliminar(id);
    }
}
