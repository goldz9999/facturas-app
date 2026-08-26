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
                pendiente_revision: params.confianza === 'media' || params.confianza === 'baja',
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

    // Heurística de agrupación de evidencias (sección 14 del documento de
    // requerimientos: "1 gasto → factura + Yape + audio"). Busca, para el
    // mismo usuario, un gasto reciente (dentro de `ventanaMinutos`) cuyo
    // monto coincida con `monto` (con una pequeña tolerancia por redondeos
    // entre el comprobante y el Yape). Si lo encuentra, el llamador debe
    // adjuntar el nuevo comprobante/evidencia a ese gasto en vez de crear
    // uno nuevo, y confirmarle al usuario que lo hizo así.
    async buscarCandidatoParaAgrupar(usuarioId: number, monto: number, ventanaMinutos = 15) {
        const desde = new Date(Date.now() - ventanaMinutos * 60 * 1000).toISOString();
        const tolerancia = 0.5; // soles

        const { data, error } = await this.supabase
            .getClient()
            .from('gastos')
            .select('*, comprobantes(*), evidencias(*)')
            .eq('usuario_id', usuarioId)
            .gte('creado_en', desde)
            .order('creado_en', { ascending: false })
            .limit(5);

        if (error) {
            throw new InternalServerErrorException(
                `Error buscando gasto para agrupar: ${error.message}`,
            );
        }

        const candidato = (data ?? []).find(
            (g) => g.monto != null && Math.abs(Number(g.monto) - monto) <= tolerancia,
        );
        return candidato ?? null;
    }

    // Deshace una agrupación automática que el usuario marcó como incorrecta
    // (botón "No" en la confirmación): saca el comprobante (y su evidencia,
    // si tiene) del gasto al que se habían adjuntado y les crea un gasto
    // propio, con los mismos datos que ya se habían extraído.
    async separarComprobante(
        comprobanteId: number,
        evidenciaId: number | null,
        usuarioId: number,
    ) {
        const client = this.supabase.getClient();

        const { data: comprobante, error: errComp } = await client
            .from('comprobantes')
            .select('*')
            .eq('id', comprobanteId)
            .maybeSingle();
        if (errComp) {
            throw new InternalServerErrorException(`Error buscando el comprobante: ${errComp.message}`);
        }
        if (!comprobante) {
            throw new NotFoundException(`Comprobante ${comprobanteId} no encontrado`);
        }

        const fechaHoyPeru = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
        const { gasto: nuevoGasto } = await this.crear({
            usuario_id: usuarioId,
            descripcion: comprobante.empresa_emisora ?? null,
            monto: comprobante.total ?? 0,
            fecha: comprobante.fecha_documento ?? fechaHoyPeru,
        });

        const { error: errMoveComp } = await client
            .from('comprobantes')
            .update({ gasto_id: nuevoGasto.id })
            .eq('id', comprobanteId);
        if (errMoveComp) {
            throw new InternalServerErrorException(`Error separando el comprobante: ${errMoveComp.message}`);
        }

        if (evidenciaId) {
            const { error: errMoveEvid } = await client
                .from('evidencias')
                .update({ gasto_id: nuevoGasto.id })
                .eq('id', evidenciaId);
            if (errMoveEvid) {
                throw new InternalServerErrorException(
                    `Error separando la evidencia: ${errMoveEvid.message}`,
                );
            }
        }

        return nuevoGasto;
    }

    // Corrige el monto de un gasto ya creado (ej. cuando el usuario responde
    // el monto correcto tras una extracción de baja confianza) y sube su
    // confianza a 'alta', ya que quedó validado por una persona. Si el
    // gasto tiene comprobante, también actualiza su total para que no
    // quede desalineado.
    async corregirMonto(gastoId: number, monto: number) {
        const client = this.supabase.getClient();

        const { data: gasto, error } = await client
            .from('gastos')
            .update({ monto, confianza: 'alta', pendiente_revision: false })
            .eq('id', gastoId)
            .select('*')
            .single();
        if (error) {
            throw new InternalServerErrorException(`Error corrigiendo el monto: ${error.message}`);
        }

        const { error: errComp } = await client
            .from('comprobantes')
            .update({ total: monto })
            .eq('gasto_id', gastoId);
        if (errComp) {
            throw new InternalServerErrorException(`Error actualizando el comprobante: ${errComp.message}`);
        }

        return gasto;
    }

    // Detección de duplicados entre USUARIOS DISTINTOS (sección 17 de
    // requerimientos: caso "Wilber le manda la captura a su esposa y ella
    // también la sube"). Compara mismo monto + misma fecha contra gastos de
    // otros usuarios. Señales que hoy no se extraen (RUC, n° de operación de
    // Yape, similitud de imagen) quedan fuera hasta que existan esos campos;
    // por eso el nivel más alto que podemos declarar es "alta" solo cuando
    // además coincide el número de comprobante/factura.
    async buscarPosibleDuplicadoEntreUsuarios(
        usuarioId: number,
        monto: number,
        fecha: string,
        numeroComprobante?: string | null,
    ) {
        const tolerancia = 0.5; // soles

        const { data, error } = await this.supabase
            .getClient()
            .from('gastos')
            .select('*, usuarios(nombre), comprobantes(*)')
            .neq('usuario_id', usuarioId)
            .eq('fecha', fecha)
            .order('creado_en', { ascending: false })
            .limit(20);

        if (error) {
            throw new InternalServerErrorException(
                `Error buscando posibles duplicados: ${error.message}`,
            );
        }

        const candidato = (data ?? []).find(
            (g) => g.monto != null && Math.abs(Number(g.monto) - monto) <= tolerancia,
        );
        if (!candidato) return null;

        const coincideNumero =
            !!numeroComprobante &&
            Array.isArray(candidato.comprobantes) &&
            candidato.comprobantes.some((c: any) => c.numero && c.numero === numeroComprobante);

        return {
            gasto: candidato,
            usuario_nombre: candidato.usuarios?.nombre ?? 'otro usuario',
            nivel: coincideNumero ? ('alta' as const) : ('media' as const),
        };
    }

    // Deja registrado en el gasto nuevo que probablemente es el mismo gasto
    // que `duplicadoDeId` (de otro usuario). No borra ni bloquea nada — solo
    // marca, para que el bot avise y para que el reporte lo pueda filtrar.
    async marcarPosibleDuplicado(gastoId: number, duplicadoDeId: number) {
        const { error } = await this.supabase
            .getClient()
            .from('gastos')
            .update({ posible_duplicado_de: duplicadoDeId, pendiente_revision: true })
            .eq('id', gastoId);

        if (error) {
            throw new InternalServerErrorException(`Error marcando duplicado: ${error.message}`);
        }
    }

    // El usuario confirmó que NO es un duplicado: limpia la marca.
    async descartarDuplicado(gastoId: number) {
        const { error } = await this.supabase
            .getClient()
            .from('gastos')
            .update({ posible_duplicado_de: null, pendiente_revision: false })
            .eq('id', gastoId);

        if (error) {
            throw new InternalServerErrorException(`Error descartando duplicado: ${error.message}`);
        }
    }

    // Marca un gasto como confirmado por el usuario (sube su confianza a
    // 'alta') sin tocar el monto. Usado cuando la extracción con confianza
    // "media" resultó ser correcta y el usuario solo confirma.
    // Guarda la categoría + tipo de gasto elegidos por el usuario cuando el
    // proveedor era nuevo (sección 9 de requerimientos: matching de
    // proveedor/categoría). No toca confianza ni pendiente_revision — son
    // conceptos independientes (un gasto puede tener confianza alta y
    // seguir sin categoría, o viceversa).
    async actualizarCategoria(gastoId: number, categoriaId: number, esPersonal: boolean) {
        const { data: gasto, error } = await this.supabase
            .getClient()
            .from('gastos')
            .update({ categoria_id: categoriaId, es_personal: esPersonal })
            .eq('id', gastoId)
            .select('*')
            .single();
        if (error) {
            throw new InternalServerErrorException(`Error actualizando la categoría: ${error.message}`);
        }
        return gasto;
    }

    async confirmarConfianza(gastoId: number) {
        const { data: gasto, error } = await this.supabase
            .getClient()
            .from('gastos')
            .update({ confianza: 'alta', pendiente_revision: false })
            .eq('id', gastoId)
            .select('*')
            .single();
        if (error) {
            throw new InternalServerErrorException(`Error confirmando el gasto: ${error.message}`);
        }
        return gasto;
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