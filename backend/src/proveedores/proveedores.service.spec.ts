import { BadRequestException } from '@nestjs/common';
import { ProveedoresService } from './proveedores.service';

type Fila = { id: number; nombre: string; ruc: string | null; empresa_id: number };

// Supabase en memoria, solo lo que usa resolverDesdePanel.
function servicio(filas: Fila[]) {
    const updates: any[] = [];
    const inserts: any[] = [];
    const query = () => {
        const conds: ((f: Fila) => boolean)[] = [];
        const q: any = {
            select: () => q,
            eq: (c: string, v: any) => { conds.push((f: any) => f[c] === v); return q; },
            ilike: (c: string, v: string) => { conds.push((f: any) => f[c].toLowerCase() === v.toLowerCase()); return q; },
            order: () => q,
            limit: () => q,
            maybeSingle: async () => ({ data: filas.find((f) => conds.every((k) => k(f))) ?? null, error: null }),
            update: (cambios: any) => { updates.push(cambios); return { eq: () => ({ eq: async () => ({ error: null }) }) }; },
            insert: (fila: any) => { inserts.push(fila); return { select: () => ({ single: async () => ({ data: { id: 100, ...fila }, error: null }) }) }; },
        };
        return q;
    };
    const svc = new ProveedoresService({ getClient: () => ({ from: query }) } as any);
    return { svc, updates, inserts };
}

describe('ProveedoresService.resolverDesdePanel', () => {
    const filas: Fila[] = [
        { id: 1, nombre: 'Sodimac', ruc: null, empresa_id: 1 },
        { id: 2, nombre: 'Maestro', ruc: '20111111111', empresa_id: 1 },
    ];

    it('usa el proveedor existente por nombre y le corrige el RUC', async () => {
        const { svc, updates } = servicio(filas);
        const p = await svc.resolverDesdePanel('sodimac', '20222222222', 1);
        expect(p.id).toBe(1);
        expect(updates).toEqual([{ ruc: '20222222222' }]);
    });

    it('no asigna un RUC que ya es de otro proveedor', async () => {
        const { svc } = servicio(filas);
        await expect(svc.resolverDesdePanel('Sodimac', '20111111111', 1)).rejects.toThrow(BadRequestException);
    });

    it('nombre nuevo con RUC conocido usa el proveedor de ese RUC', async () => {
        const { svc, inserts } = servicio(filas);
        expect((await svc.resolverDesdePanel('Maestro Home', '20111111111', 1)).id).toBe(2);
        expect(inserts).toEqual([]);
    });

    it('crea el proveedor si no existe y valida el RUC', async () => {
        const { svc, inserts } = servicio(filas);
        await svc.resolverDesdePanel('Promart', undefined, 1);
        expect(inserts).toEqual([{ nombre: 'Promart', ruc: null, empresa_id: 1 }]);
        await expect(svc.resolverDesdePanel('Promart', '123', 1)).rejects.toThrow(BadRequestException);
        await expect(svc.resolverDesdePanel('  ', undefined, 1)).rejects.toThrow(BadRequestException);
    });
});
