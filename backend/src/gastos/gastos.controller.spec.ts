import { GastosController } from './gastos.controller';

describe('GastosController', () => {
    const mk = () => {
        const svc = {
            listar: jest.fn().mockResolvedValue([]),
            resumen: jest.fn().mockResolvedValue({}),
            contarPorEstado: jest.fn().mockResolvedValue({}),
            actualizar: jest.fn().mockResolvedValue({}),
        };
        return { c: new GastosController(svc as any), svc };
    };
    const req = { user: { id: 7, rol: 'empleado', empresa_ids: [1, 2] } };

    it('ambito=personal: solo mis gastos personales, en todas mis empresas', async () => {
        const { c, svc } = mk();
        await c.listar({ ambito: 'personal', empresa_id: '1' }, req);
        expect(svc.listar).toHaveBeenCalledWith(expect.objectContaining({ esPersonal: true, usuarioId: 7 }), [1, 2]);
        await c.resumen(undefined, 'personal', req);
        expect(svc.resumen).toHaveBeenCalledWith([1, 2], 7);
        await c.conteos(undefined, 'personal', req);
        expect(svc.contarPorEstado).toHaveBeenCalledWith([1, 2], 7);
    });

    it('sin ambito sigue filtrando por la empresa pedida', async () => {
        const { c, svc } = mk();
        await c.resumen('2', undefined, req);
        expect(svc.resumen).toHaveBeenCalledWith(2, undefined);
    });

    it('PATCH solo deja pasar los campos editables', async () => {
        const { c, svc } = mk();
        await c.actualizar(5, { monto: 10, empresa_id: 99, usuario_id: 1, proveedor_ruc: null, medio_pago: 'yape' } as any, '1', req);
        expect(svc.actualizar).toHaveBeenCalledWith(5, { monto: 10, proveedor_ruc: null, medio_pago: 'yape' }, 1);
    });
});
