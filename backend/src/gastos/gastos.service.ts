import { Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../common/supabase.service';

// Un item extraído por Gemini (factura o audio), tal como lo devuelve
// facturas-normalizer.
export interface ItemGasto {
    producto: string;
    cantidad: number | null;
    costo: number | null;
}

// Datos de comprobante, presentes solo cuando el gasto viene de una
// factura/foto/PDF (no de un audio puro).
export interface DatosComprobante {
    tipo?: string; // 'factura' por default
    numero?: string | null;
    empresa_emisora?: string | null;
    subtotal?: number | null;
    igv?: number | null;
    total?: number | null;
    fecha_documento?: string | null;
}

// Datos de evidencia (archivo de respaldo: foto, PDF, audio original).
export interface DatosEvidencia {
    tipo: string; // 'imagen' | 'pdf' | 'audio' | etc.
    storage_path: string;
    origen?: string; // 'telegram' | 'web', default 'telegram'
}

export interface CrearGastoParams {
    usuario_id: number;
    descripcion?: string | null;
    monto: number;
    fecha: string; // YYYY-MM-DD
    es_personal?: boolean;
    categoria_id?: number | null;
    proveedor_id?: number | null;
    confianza?: 'alta' | 'media' | 'baja' | null;
    comprobante?: DatosComprobante | null;
    evidencia?: DatosEvidencia | null;
    items?: ItemGasto[];
}

@Injectable()
export class GastosService {
    constructor(private supabase: SupabaseService) { }

    // Crea un gasto y, si vienen, su comprobante y evidencia asociados en el
    // mismo flujo. Los items (RF de factura_items original) hoy no tienen
    // tabla propia en el esquema nuevo: se guardan como parte del comprobante
    // si en el futuro se necesita el detalle línea por línea, se puede crear
    // una tabla `comprobante_items` sin tocar esta firma.
    async crear(params: CrearGastoParams) {
        const client = this.supabase.getClient();

        const { data: gasto, error: errorGasto } = await client
            .from('gastos')
            .insert({
                usuario_id: params.usuario_id,
                categoria_id: params.categoria_id ?? null,
                proveedor_id: params.proveedor_id ?? null,
                es_personal: params.es_personal ?? false,
                descripcion: params.descripcion ?? null,
                monto: params.monto,
                fecha: params.fecha,
                confianza: params.confianza ?? null,
            })
            .select('*')
            .single();

        if (errorGasto) {
            throw new InternalServerErrorException(`Error creando el gasto: ${errorGasto.message}`);
        }

        let comprobante: any = null;
        if (params.comprobante) {
            comprobante = await this.insertarComprobante(gasto.id, params.comprobante);
        }

        let evidencia: any = null;
        if (params.evidencia) {
            evidencia = await this.insertarEvidencia(gasto.id, params.evidencia);
        }

        return { gasto, comprobante, evidencia };
    }

    // Adjunta un comprobante (y opcionalmente una evidencia) a un gasto ya
    // existente. Usado por el flujo de Telegram "¿Tienes comprobante? Sí" y
    // por el comando /gastos → "Agregar comprobante".
    async adjuntarComprobante(
        gastoId: number,
        comprobante: DatosComprobante,
        evidencia?: DatosEvidencia | null,
    ) {
        await this.obtenerPorId(gastoId); // valida que el gasto exista

        const comprobanteInsertado = await this.insertarComprobante(gastoId, comprobante);

        let evidenciaInsertada: any = null;
        if (evidencia) {
            evidenciaInsertada = await this.insertarEvidencia(gastoId, evidencia);
        }

        return { comprobante: comprobanteInsertado, evidencia: evidenciaInsertada };
    }

    // Solo adjunta la evidencia (ej. cuando llega un audio sin comprobante,
    // pero igual queremos guardar el archivo original como respaldo).
    async adjuntarEvidencia(gastoId: number, evidencia: DatosEvidencia) {
        await this.obtenerPorId(gastoId);
        return this.insertarEvidencia(gastoId, evidencia);
    }

    // Últimos N gastos de un usuario, con su comprobante (si tiene), para el
    // comando "gastos" / "/gastos" del bot.
    async ultimosPorUsuario(usuarioId: number, limite = 5) {
        const { data, error } = await this.supabase
            .getClient()
            .from('gastos')
            .select('*, comprobantes(*), evidencias(*)')
            .eq('usuario_id', usuarioId)
            .order('fecha', { ascending: false })
            .order('creado_en', { ascending: false })
            .limit(limite);

        if (error) {
            throw new InternalServerErrorException(`Error listando gastos: ${error.message}`);
        }
        return data ?? [];
    }

    async obtenerPorId(gastoId: number) {
        const { data, error } = await this.supabase
            .getClient()
            .from('gastos')
            .select('*, comprobantes(*), evidencias(*)')
            .eq('id', gastoId)
            .maybeSingle();

        if (error) {
            throw new InternalServerErrorException(`Error buscando el gasto: ${error.message}`);
        }
        if (!data) {
            throw new NotFoundException(`Gasto ${gastoId} no encontrado`);
        }
        return data;
    }

    private async insertarComprobante(gastoId: number, datos: DatosComprobante) {
        const { data, error } = await this.supabase
            .getClient()
            .from('comprobantes')
            .insert({
                gasto_id: gastoId,
                tipo: datos.tipo ?? 'factura',
                numero: datos.numero ?? null,
                empresa_emisora: datos.empresa_emisora ?? null,
                subtotal: datos.subtotal ?? null,
                igv: datos.igv ?? null,
                total: datos.total ?? null,
                fecha_documento: datos.fecha_documento ?? null,
            })
            .select('*')
            .single();

        if (error) {
            throw new InternalServerErrorException(`Error guardando el comprobante: ${error.message}`);
        }
        return data;
    }

    private async insertarEvidencia(gastoId: number, datos: DatosEvidencia) {
        const { data, error } = await this.supabase
            .getClient()
            .from('evidencias')
            .insert({
                gasto_id: gastoId,
                tipo: datos.tipo,
                storage_path: datos.storage_path,
                origen: datos.origen ?? 'telegram',
            })
            .select('*')
            .single();

        if (error) {
            throw new InternalServerErrorException(`Error guardando la evidencia: ${error.message}`);
        }
        return data;
    }
}