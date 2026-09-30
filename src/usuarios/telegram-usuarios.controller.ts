import { Body, ConflictException, Controller, Delete, ForbiddenException, Get, NotFoundException, Param, ParseIntPipe, Post, Put, Request, UseGuards } from '@nestjs/common';
import { IsInt, IsNotEmpty, IsString, MaxLength, Min } from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { esSuperAdmin } from '../auth/roles-empresa';
import { UsuariosService } from './usuarios.service';

class TelegramIdDto {
    @IsInt({ message: 'El ID de Telegram debe ser un número.' })
    @Min(1, { message: 'El ID de Telegram debe ser un número positivo.' })
    telegram_id: number;
}

class NuevoTelegramDto extends TelegramIdDto {
    @IsString()
    @IsNotEmpty()
    @MaxLength(120)
    nombre: string;
}

// Cuentas autorizadas del bot: el bot solo atiende a usuarios activos con
// telegram_id. Las gestiona el propietario o quien él autorice
// (puede_gestionar_telegram), siempre dentro de la empresa activa.
@UseGuards(JwtAuthGuard)
@Controller('telegram/usuarios')
export class TelegramUsuariosController {
    constructor(private usuariosService: UsuariosService) { }

    private empresaActiva(req: any): number {
        if (!req.user.puede_gestionar_telegram) {
            throw new ForbiddenException('No tienes permiso para gestionar cuentas de Telegram.');
        }
        const id = req.user.empresa_activa_id;
        if (id == null) throw new ForbiddenException('No hay una empresa activa para esta operación.');
        return id;
    }

    // Solo miembros de la empresa activa. Quien no es propietario no toca la
    // cuenta de un propietario ni de un super admin (sería suplantarlo en el bot).
    private async verificar(req: any, id: number, empresaId: number) {
        const u = await this.usuariosService.obtenerPorId(id);
        const rol = u?.empresas.find((e) => e.empresa_id === empresaId)?.rol;
        if (!u || !rol) throw new NotFoundException('Usuario no encontrado en tu empresa');
        const esPropietario = req.user.es_super_admin || req.user.rol_empresa === 'propietario';
        const objetivoPrivilegiado = esSuperAdmin({ es_super_admin: u.es_super_admin, rol: u.rol }) || rol === 'propietario';
        if (objetivoPrivilegiado && !esPropietario && id !== req.user.id) {
            throw new ForbiddenException('Solo un propietario puede cambiar la cuenta de Telegram de otro propietario.');
        }
    }

    @Get()
    async listar(@Request() req) {
        const empresaId = this.empresaActiva(req);
        const usuarios = await this.usuariosService.listar(empresaId);
        return usuarios.map((u) => ({
            id: u.id,
            nombre: u.nombre,
            email: (u as any).email ?? null,
            activo: u.activo,
            telegram_id: u.telegram_id ?? null,
            rol_empresa: u.empresas.find((e) => e.empresa_id === empresaId)?.rol ?? 'empleado',
            tiene_password: u.tiene_password,
        }));
    }

    // Vincula (o cambia) el ID de Telegram de un miembro.
    @Put(':id')
    async vincular(@Param('id', ParseIntPipe) id: number, @Body() dto: TelegramIdDto, @Request() req) {
        const empresaId = this.empresaActiva(req);
        await this.verificar(req, id, empresaId);
        await this.usuariosService.establecerTelegram(id, dto.telegram_id);
        return { success: true };
    }

    // Quita la autorización: el bot deja de atenderlo (su cuenta web sigue igual).
    @Delete(':id')
    async quitar(@Param('id', ParseIntPipe) id: number, @Request() req) {
        const empresaId = this.empresaActiva(req);
        await this.verificar(req, id, empresaId);
        await this.usuariosService.establecerTelegram(id, null);
        return { success: true };
    }

    // Alta de alguien que solo usa el bot (sin acceso al panel): queda como
    // empleado de la empresa activa. El rol se cambia después en Usuarios.
    @Post()
    async crear(@Body() dto: NuevoTelegramDto, @Request() req) {
        const empresaId = this.empresaActiva(req);
        const existente = await this.usuariosService.buscarPorTelegramId(dto.telegram_id);
        if (existente) {
            throw new ConflictException(`Ese ID de Telegram ya está vinculado a ${existente.nombre || 'otro usuario'}.`);
        }
        const u = await this.usuariosService.crear(
            { nombre: dto.nombre.trim(), telegram_id: dto.telegram_id } as any,
            [empresaId],
            { rol: 'empleado', rol_empresa: 'empleado' },
        );
        return { id: u.id };
    }
}
