import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { UsuariosController } from './usuarios.controller';

const objetivo = (over: Record<string, unknown> = {}) => ({
    id: 5,
    rol: 'empleado',
    es_super_admin: false,
    empresas: [{ empresa_id: 2, rol: 'empleado' }],
    ...over,
});

function montar(obj: unknown = objetivo()) {
    const service = {
        obtenerPorId: jest.fn().mockResolvedValue(obj),
        actualizar: jest.fn().mockResolvedValue({}),
        desactivar: jest.fn().mockResolvedValue({}),
        eliminar: jest.fn().mockResolvedValue(undefined),
    };
    return { c: new UsuariosController(service as any), service };
}

const admin = (over: Record<string, unknown> = {}) => ({
    user: { id: 10, rol: 'admin', es_super_admin: false, rol_empresa: 'administrador', empresa_activa_id: 2, empresa_ids: [1, 2], ...over },
});
const superAdmin = { user: { id: 1, rol: 'super_admin', es_super_admin: true, rol_empresa: 'propietario', empresa_activa_id: null, empresa_ids: [] } };

describe('UsuariosController — alcance por empresa activa', () => {
    it('actualizar se acota a la empresa activa, no a la primera empresa del usuario', async () => {
        const { c, service } = montar();
        await c.actualizar(5, { nombre: 'x' } as any, admin());
        expect(service.actualizar).toHaveBeenCalledWith(5, { nombre: 'x' }, 2);
    });

    it('desactivar y eliminar pasan la empresa activa', async () => {
        const { c, service } = montar();
        await c.desactivar(5, admin());
        await c.eliminar(5, admin());
        expect(service.desactivar).toHaveBeenCalledWith(5, 2);
        expect(service.eliminar).toHaveBeenCalledWith(5, 2);
    });

    it('sin empresa activa rechaza', async () => {
        const { c, service } = montar();
        await expect(c.actualizar(5, {} as any, admin({ empresa_activa_id: null }))).rejects.toThrow(ForbiddenException);
        expect(service.actualizar).not.toHaveBeenCalled();
    });

    it('un usuario fuera de la empresa activa no se puede tocar', async () => {
        const { c, service } = montar(objetivo({ empresas: [{ empresa_id: 1, rol: 'empleado' }] }));
        await expect(c.actualizar(5, {} as any, admin())).rejects.toThrow(NotFoundException);
        expect(service.actualizar).not.toHaveBeenCalled();
    });

    it('un administrador no puede modificar a un propietario', async () => {
        const { c, service } = montar(objetivo({ empresas: [{ empresa_id: 2, rol: 'propietario' }] }));
        await expect(c.actualizar(5, { password: 'nuevaclave' } as any, admin())).rejects.toThrow(ForbiddenException);
        await expect(c.desactivar(5, admin())).rejects.toThrow(ForbiddenException);
        await expect(c.eliminar(5, admin())).rejects.toThrow(ForbiddenException);
        expect(service.actualizar).not.toHaveBeenCalled();
    });

    it('un administrador no puede modificar a un super admin', async () => {
        const { c } = montar(objetivo({ es_super_admin: true }));
        await expect(c.actualizar(5, { email: 'a@b.pe' } as any, admin())).rejects.toThrow(ForbiddenException);
    });

    it('un propietario sí puede modificar a otro propietario', async () => {
        const { c, service } = montar(objetivo({ empresas: [{ empresa_id: 2, rol: 'propietario' }] }));
        await c.actualizar(5, { nombre: 'x' } as any, admin({ rol_empresa: 'propietario' }));
        expect(service.actualizar).toHaveBeenCalledWith(5, { nombre: 'x' }, 2);
    });

    it('autoedición: pedir rol admin siendo admin solo actúa sobre la empresa activa', async () => {
        const { c, service } = montar(objetivo({ id: 10, empresas: [{ empresa_id: 2, rol: 'administrador' }] }));
        await c.actualizar(10, { rol: 'admin' } as any, admin());
        expect(service.actualizar).toHaveBeenCalledWith(10, { rol: 'admin' }, 2);
    });

    it('un super admin no se acota a una empresa', async () => {
        const { c, service } = montar();
        await c.actualizar(5, { nombre: 'x' } as any, superAdmin);
        expect(service.actualizar).toHaveBeenCalledWith(5, { nombre: 'x' });
    });
});
