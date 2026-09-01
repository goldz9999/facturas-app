import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY, RolUsuario } from '../decorators/roles.decorator';

// Se usa siempre DESPUÉS de JwtAuthGuard (req.user debe existir ya).
// super_admin pasa cualquier chequeo de rol automáticamente.
@Injectable()
export class RolesGuard implements CanActivate {
    constructor(private reflector: Reflector) { }

    canActivate(context: ExecutionContext): boolean {
        const rolesPermitidos = this.reflector.getAllAndOverride<RolUsuario[]>(ROLES_KEY, [
            context.getHandler(),
            context.getClass(),
        ]);

        if (!rolesPermitidos || rolesPermitidos.length === 0) return true;

        const { user } = context.switchToHttp().getRequest();
        if (!user) throw new ForbiddenException('No autenticado');

        if (user.rol === 'super_admin' || rolesPermitidos.includes(user.rol)) {
            return true;
        }

        throw new ForbiddenException('No tienes permiso para realizar esta acción');
    }
}