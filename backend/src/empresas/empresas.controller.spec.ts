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
