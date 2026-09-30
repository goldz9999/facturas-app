import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_EMPRESA_KEY } from '../decorators/roles-empresa.decorator';
import { RolEmpresa } from '../roles-empresa';

@Injectable()
export class RolesEmpresaGuard implements CanActivate {
    constructor(private reflector: Reflector) { }

    canActivate(context: ExecutionContext): boolean {
        const permitidos = this.reflector.getAllAndOverride<RolEmpresa[]>(ROLES_EMPRESA_KEY, [context.getHandler(), context.getClass()]);
        if (!permitidos || permitidos.length === 0) return true;

        const { user } = context.switchToHttp().getRequest();
        if (!user) throw new ForbiddenException('No autenticado');
        if (user.es_super_admin || permitidos.includes(user.rol_empresa)) return true;

        throw new ForbiddenException('Tu rol en esta empresa no permite esta acción.');
    }
}
