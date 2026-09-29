import { GastosService } from './gastos.service';

function servicio(filas: any[]) {
    const filtros: [string, string, any][] = [];
    const q: any = {
        select: () => q,
        neq: (c: string, v: any) => { filtros.push(['neq', c, v]); return q; },
        eq: (c: string, v: any) => { filtros.push(['eq', c, v]); return q; },
        order: () => q,
        limit: () => q,
        then: (ok: any) => ok({
            data: filas.filter((f) => filtros.every(([op, c, v]) => (op === 'eq' ? f[c] === v : f[c] !== v))),
            error: null,
        }),
    };
    const svc = new GastosService({ getClient: () => ({ from: () => q }) } as any, {} as any, {} as any, {} as any, {} as any);
    return svc;
}

// Gasto de Adrian: factura 000014 de ROMMAX (RUC 20607668524), fecha leída 20/07.
const original = {
    id: 1, usuario_id: 1, empresa_id: 1, monto: 368.5, fecha: '2026-07-20', proveedor_id: 1,
    posible_duplicado_de: null, pendiente_revision: false, usuarios: { nombre: 'Adrian' },
    comprobantes: [{ numero: '000014' }], proveedores: { ruc: '20607668524' }, pagos: [],
};

describe('buscarPosibleDuplicadoEntreUsuarios', () => {
    it('misma factura del mismo emisor aunque la IA leyera otra fecha (caso Miguel)', async () => {
        const r = await servicio([original]).buscarPosibleDuplicadoEntreUsuarios(2, 368.5, '2026-09-03', '000014', null, '20607668524', null, 1, 3);
        expect(r?.gasto.id).toBe(1);
        expect(r?.nivel).toBe('alta');
    });

    it('el mismo número de otro emisor no es duplicado', async () => {
        const r = await servicio([original]).buscarPosibleDuplicadoEntreUsuarios(2, 50, '2026-09-03', '000014', null, '20999999999', null, 1, 3);
        expect(r).toBeNull();
    });

    it('misma operación de Yape es duplicado fuerte', async () => {
        const conYape = { ...original, comprobantes: [], pagos: [{ numero_operacion: '06924092' }] };
        const r = await servicio([conYape]).buscarPosibleDuplicadoEntreUsuarios(2, 10, '2026-01-01', null, null, null, '06924092', 1, 3);
        expect(r?.nivel).toBe('alta');
    });

    it('solo misma fecha y monto: duplicado de nivel medio', async () => {
        const sinDatos = { ...original, comprobantes: [], proveedores: null, proveedor_id: null };
        const r = await servicio([sinDatos]).buscarPosibleDuplicadoEntreUsuarios(2, 368.2, '2026-07-20', null, null, null, null, 1, 3);
        expect(r?.nivel).toBe('media');
    });

    it('no compara con otra empresa ni con duplicados ya confirmados', async () => {
        expect(await servicio([{ ...original, empresa_id: 2 }]).buscarPosibleDuplicadoEntreUsuarios(2, 368.5, '2026-07-20', '000014', null, '20607668524', null, 1, 3)).toBeNull();
        expect(await servicio([{ ...original, posible_duplicado_de: 9 }]).buscarPosibleDuplicadoEntreUsuarios(2, 368.5, '2026-07-20', '000014', null, '20607668524', null, 1, 3)).toBeNull();
    });
});

// Cadena de Supabase que devuelve `filas` tal cual (los filtros no importan aquí).
function servicioFijo(filas: any[]) {
    const q: any = {};
    for (const m of ['select', 'not', 'eq', 'neq', 'order', 'limit']) q[m] = () => q;
    q.then = (ok: any) => ok({ data: filas, error: null });
    return new GastosService({ getClient: () => ({ from: () => q }) } as any, {} as any, {} as any, {} as any, {} as any);
}

describe('buscarDuplicadoPorImagen', () => {
    const h = 'a'.repeat(64);
    const casiH = 'a'.repeat(63) + 'b'; // 1 bit distinto
    const ev = (over: any = {}) => ({
        huella: casiH, gasto_id: 1,
        gastos: { id: 1, empresa_id: 1, monto: 368.5, posible_duplicado_de: null, pendiente_revision: false, usuario_nombre: 'Adrian', comprobantes: [{ numero: '000014' }], pagos: [], ...over },
    });

    it('la misma imagen con el mismo monto es duplicado', async () => {
        const r = await servicioFijo([ev()]).buscarDuplicadoPorImagen([h], 368.5, 1, 4, '000014', null);
        expect(r?.gasto.id).toBe(1);
        expect(r?.usuario_nombre).toBe('Adrian');
    });

    it('capturas parecidas de pagos distintos no: otro monto u otra operación', async () => {
        expect(await servicioFijo([ev()]).buscarDuplicadoPorImagen([h], 50, 1, 4, null, null)).toBeNull();
        const yape = ev({ comprobantes: [], pagos: [{ numero_operacion: '111' }] });
        expect(await servicioFijo([yape]).buscarDuplicadoPorImagen([h], 368.5, 1, 4, null, '222')).toBeNull();
        expect(await servicioFijo([ev()]).buscarDuplicadoPorImagen([h], 368.5, 1, 4, '000099', null)).toBeNull();
    });

    it('imagen distinta no coincide', async () => {
        expect(await servicioFijo([ev({}), { ...ev(), huella: 'f'.repeat(64) }].slice(1)).buscarDuplicadoPorImagen([h], 368.5, 1, 4, null, null)).toBeNull();
    });
});

describe('buscarPosibleDuplicadoDelMismoUsuario', () => {
    const previo = { id: 1, comprobantes: [{ numero: '000010' }], proveedores: { ruc: '20607668524' }, pagos: [] };
    it('el RUC solo no es duplicado (otra compra al mismo proveedor)', async () => {
        expect(await servicioFijo([previo]).buscarPosibleDuplicadoDelMismoUsuario(1, 5, '000011', '20607668524', null)).toBeNull();
    });
    it('mismo número y mismo RUC sí; mismo número de otro emisor no', async () => {
        expect((await servicioFijo([previo]).buscarPosibleDuplicadoDelMismoUsuario(1, 5, '000010', '20607668524', null))?.gasto.id).toBe(1);
        expect(await servicioFijo([previo]).buscarPosibleDuplicadoDelMismoUsuario(1, 5, '000010', '20999999999', null)).toBeNull();
    });
});
