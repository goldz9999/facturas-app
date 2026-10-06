import { FacturaExtraida } from '../ia/gemini.service';

function fechaHoyPeru(): string {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
}

// Devuelve { fecha, pudoLeerla }. Cuando no se pudo interpretar la fecha
// devuelta por Gemini, usamos la fecha de hoy como placeholder PERO avisamos
// con pudoLeerla=false, para que el llamador baje la confianza a "baja" en
// vez de guardar el gasto como si la fecha hubiera sido leída correctamente
// (bug anterior: una fecha mal leída se disfrazaba de fecha válida).
function normalizarFecha(f?: string | null): { fecha: string; pudoLeerla: boolean } {
    const s = f != null ? String(f).trim() : '';
    if (!s) return { fecha: fechaHoyPeru(), pudoLeerla: false };
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { fecha: s, pudoLeerla: true };
    const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (m) {
        const [, dia, mes, anio] = m;
        return { fecha: `${anio}-${mes.padStart(2, '0')}-${dia.padStart(2, '0')}`, pudoLeerla: true };
    }
    return { fecha: fechaHoyPeru(), pudoLeerla: false };
}

function normalizarRuc(r?: string | null): string {
    if (!r) return '';
    // Solo dígitos; el RUC peruano tiene 11 dígitos. Si no calza con eso,
    // se descarta en vez de guardar basura (Gemini a veces mezcla el RUC
    // con otro número cercano en la factura).
    const soloDigitos = String(r).replace(/\D/g, '');
    return soloDigitos.length === 11 ? soloDigitos : '';
}

export type MedioPago = 'yape' | 'transferencia' | 'efectivo' | 'tarjeta' | 'otro';

const MEDIOS_PAGO: MedioPago[] = ['yape', 'transferencia', 'efectivo', 'tarjeta', 'otro'];

function normalizarMedioPago(m?: string | null): MedioPago | null {
    const v = String(m ?? '').trim().toLowerCase();
    return (MEDIOS_PAGO as string[]).includes(v) ? (v as MedioPago) : null;
}

export type NivelConfianza = 'alta' | 'media' | 'baja';

const NIVELES_CONFIANZA: NivelConfianza[] = ['alta', 'media', 'baja'];

function normalizarConfianza(c?: string | null): NivelConfianza {
    const v = String(c ?? '').trim().toLowerCase();
    return (NIVELES_CONFIANZA as string[]).includes(v) ? (v as NivelConfianza) : 'media';
}

export interface FacturaNormalizada {
    fecha: string;
    empresa: string;
    ruc: string;
    n_factura: string;
    subtotal: number | null;
    igv: number | null;
    total_factura: number | null;
    medio_pago: MedioPago | null;
    numero_operacion: string;
    confianza: NivelConfianza;
    moneda: 'PEN' | 'USD';
    es_documento_valido: boolean;
    // RF-11: nombre de pedido que la persona mencionó en un audio/texto
    // libre ("para el pedido Dragon"). Cadena vacía si no mencionó ninguno.
    // NO es un id: el backend lo resuelve contra `pedidos` de la empresa.
    pedido_mencionado: string;
    items: Array<{ producto: string; cantidad: number; costo: number }>;
}

// Equivalente a "Separar articulos1" + "Extraer ID Factura1" en n8n
export function normalizarFactura(data: FacturaExtraida): FacturaNormalizada {
    const { fecha, pudoLeerla: fechaValida } = normalizarFecha(data.Fecha);
    const empresa = data.Empresa != null ? data.Empresa : '';
    const ruc = normalizarRuc(data.RUC);
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

    // Si no se pudo interpretar la fecha (Gemini no la devolvió o vino en un
    // formato irreconocible), no confiamos en el resto de la extracción como
    // si nada: forzamos confianza "baja" para que el gasto caiga en la
    // bandeja de Revisión en vez de guardarse con una fecha inventada.
    const confianza = fechaValida ? normalizarConfianza(data.Confianza) : 'baja';

    const monedaRaw = String(data.Moneda ?? '').trim().toUpperCase();
    const moneda: 'PEN' | 'USD' = monedaRaw === 'USD' ? 'USD' : 'PEN';
    // EsDocumentoValido: default true (dar beneficio de la duda para audios
    // y texto libre donde este campo no se envía, y para retrocompatibilidad).
    const es_documento_valido = data.EsDocumentoValido !== false;

    return {
        fecha,
        empresa,
        ruc,
        n_factura: numero,
        subtotal,
        igv,
        total_factura: totalFactura,
        medio_pago: normalizarMedioPago(data.MedioPago),
        numero_operacion: data.NumeroOperacion != null ? String(data.NumeroOperacion).trim() : '',
        confianza,
        moneda,
        es_documento_valido,
        pedido_mencionado: data.PedidoMencionado != null ? String(data.PedidoMencionado).trim() : '',
        items,
    };
}