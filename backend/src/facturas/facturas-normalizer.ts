import { FacturaExtraida } from './gemini.service';

function fechaHoyPeru(): string {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
}

function normalizarFecha(f?: string | null): string {
    if (!f) return fechaHoyPeru();
    const s = String(f).trim();
    if (!s) return fechaHoyPeru();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (m) {
        const [, dia, mes, anio] = m;
        return `${anio}-${mes.padStart(2, '0')}-${dia.padStart(2, '0')}`;
    }
    return fechaHoyPeru();
}

export interface FacturaNormalizada {
    fecha: string;
    empresa: string;
    n_factura: string;
    subtotal: number | null;
    igv: number | null;
    total_factura: number | null;
    items: Array<{ producto: string; cantidad: number; costo: number }>;
}

// Equivalente a "Separar articulos1" + "Extraer ID Factura1" en n8n
export function normalizarFactura(data: FacturaExtraida): FacturaNormalizada {
    const fecha = normalizarFecha(data.Fecha);
    const empresa = data.Empresa != null ? data.Empresa : '';
    const numero = data.NumeroFactura != null ? data.NumeroFactura : '';
    const articulos = Array.isArray(data.Articulos) ? data.Articulos : [];
    const subtotal = data.SubTotal != null ? data.SubTotal : null;
    const igv = data.IGV != null ? data.IGV : null;
    const totalFactura = data.Total != null ? data.Total : null;

    const items = articulos
        .filter((art) => art && art.Descripcion)
        .map((art) => {
            const tieneCantidad = art.Cantidad != null && (art.Cantidad as any) !== '';
            const cantidad = tieneCantidad ? Number(art.Cantidad) : 0;

            let costo = art.Importe;
            if (costo == null) {
                const c = tieneCantidad ? Number(art.Cantidad) : 1;
                const u = Number(art.PrecioUnitario);
                costo = !isNaN(c) && !isNaN(u) ? c * u : null;
            }

            return {
                producto: art.Descripcion || '',
                cantidad: cantidad || 0,
                costo: Number(costo) || 0,
            };
        });

    return {
        fecha,
        empresa,
        n_factura: numero,
        subtotal,
        igv,
        total_factura: totalFactura,
        items,
    };
}