import { ForbiddenException } from '@nestjs/common';
import { RolesEmpresaGuard } from './roles-empresa.guard';

function contexto(user: unknown, roles: string[] | undefined) {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(roles) };
    const ctx = { getHandler: () => ({}), getClass: () => ({}), switchToHttp: () => ({ getRequest: () => ({ user }) }) };
    return { guard: new RolesEmpresaGuard(reflector as any), ctx: ctx as any };
}

describe('RolesEmpresaGuard', () => {
    it('sin roles declarados deja pasar', () => {
        const { guard, ctx } = contexto({ rol_empresa: 'empleado' }, undefined);
        expect(guard.canActivate(ctx)).toBe(true);
    });
    it('deja pasar al rol permitido en la empresa activa', () => {
        const { guard, ctx } = contexto({ rol_empresa: 'contador', es_super_admin: false }, ['administrador', 'contador']);
        expect(guard.canActivate(ctx)).toBe(true);
    });
    it('rechaza a un rol no permitido, o sin rol en la empresa', () => {
        expect(() => contexto({ rol_empresa: 'empleado', es_super_admin: false }, ['administrador']).guard.canActivate(contexto({ rol_empresa: 'empleado' }, ['administrador']).ctx)).toThrow(ForbiddenException);
        const { guard, ctx } = contexto({ rol_empresa: null, es_super_admin: false }, ['administrador']);
        expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
    });
    it('el super admin siempre pasa', () => {
        const { guard, ctx } = contexto({ rol_empresa: 'propietario', es_super_admin: true }, ['contador']);
        expect(guard.canActivate(ctx)).toBe(true);
    });
});
