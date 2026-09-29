import { ForbiddenException } from '@nestjs/common';
import { EmpresasController } from './empresas.controller';

describe('EmpresasController.obtenerPorId', () => {
    const c = new EmpresasController({ obtenerPorId: jest.fn().mockResolvedValue({ id: 1 }) } as any);

    it('un admin solo lee la empresa activa, no otras donde tenga un rol menor', async () => {
        await expect(c.obtenerPorId(1, { user: { rol: 'admin', empresa_activa_id: 2, empresa_ids: [1, 2] } })).rejects.toThrow(ForbiddenException);
        await expect(c.obtenerPorId(2, { user: { rol: 'admin', empresa_activa_id: 2, empresa_ids: [1, 2] } })).resolves.toEqual({ id: 1 });
    });

    it('un super admin lee cualquiera', async () => {
        await expect(c.obtenerPorId(9, { user: { rol: 'super_admin', empresa_activa_id: null, empresa_ids: [] } })).resolves.toEqual({ id: 1 });
    });
});

describe('EmpresasController.actualizar', () => {
    const mk = () => {
        const svc = { obtenerPorId: jest.fn(), actualizar: jest.fn().mockResolvedValue({ id: 2 }) };
        return { c: new EmpresasController(svc as any), svc };
    };
    const admin = (activa: number | null) => ({ user: { rol: 'admin', es_super_admin: false, rol_empresa: 'administrador', empresa_activa_id: activa } });

    it('un administrador solo cambia el nombre de su empresa activa (ignora otros campos)', async () => {
        const { c, svc } = mk();
        await c.actualizar(2, { nombre: 'Nueva', activa: false, logo_url: 'x' } as any, admin(2));
        expect(svc.actualizar).toHaveBeenCalledWith(2, { nombre: 'Nueva' });
    });
    it('no puede tocar otra empresa', async () => {
        const { c, svc } = mk();
        await expect(c.actualizar(1, { nombre: 'X' } as any, admin(2))).rejects.toThrow(ForbiddenException);
        expect(svc.actualizar).not.toHaveBeenCalled();
    });
    it('un super admin cambia cualquier campo', async () => {
        const { c, svc } = mk();
        await c.actualizar(9, { activa: false } as any, { user: { rol: 'super_admin', es_super_admin: true, empresa_activa_id: null } });
        expect(svc.actualizar).toHaveBeenCalledWith(9, { activa: false });
    });
});
