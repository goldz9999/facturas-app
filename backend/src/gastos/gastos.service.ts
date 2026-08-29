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

// Datos de pago (sección 7/8 de requerimientos): entidad separada del
// comprobante. Presente solo cuando se pudo identificar el medio de pago
// (ej. captura de Yape/transferencia, o el usuario lo dijo por audio).
export interface DatosPago {
    medio: 'yape' | 'transferencia' | 'efectivo' | 'tarjeta' | 'otro';
    numero_operacion?: string | null;
    monto?: number | null;
}

// Item de detalle de un comprobante (línea de factura). Mismo shape que
// ItemGasto de arriba, tipado aparte para dejar claro que esto es lo que
// persiste en `comprobante_items`, colgado del comprobante (no del gasto
// directamente: un gasto sin comprobante -ej. audio- no tiene items).
export interface DatosItemComprobante {
    producto: string;
    cantidad: number | null;
    costo: number | null;
}

export interface CrearGastoParams {
    usuario_id: number;
    // Empresa a la que pertenece el gasto (RF-23, fundación multi-tenant).
    // Obligatorio en la práctica: quien llame a crear() debe resolverlo
    // desde el usuario que genera el gasto (ver FacturasService), no
    // inventarlo ni dejarlo en null salvo casos ya migrados.
    empresa_id?: number | null;
    descripcion?: string | null;
    monto: number;
    fecha: string; // YYYY-MM-DD
    es_personal?: boolean;
    categoria_id?: number | null;
    proveedor_id?: number | null;
    confianza?: 'alta' | 'media' | 'baja' | null;
    comprobante?: DatosComprobante | null;
    evidencia?: DatosEvidencia | null;
    pago?: DatosPago | null;
    // Detalle línea por línea del comprobante (sección 7 de requerimientos).
    // Solo se persiste si `comprobante` también viene (no tiene sentido un
    // item de comprobante sin comprobante). Antes esto llegaba hasta acá
    // pero se ignoraba; ver Paso "comprobante_items".
    items?: DatosItemComprobante[];
}

@Injectable()
export class GastosService {
    constructor(private supabase: SupabaseService) { }

    // Crea un gasto y, si vienen, su comprobante, evidencia, pago y detalle
    // de items asociados en el mismo flujo.
    async crear(params: CrearGastoParams) {
        const client = this.supabase.getClient();

        // empresa_id (RF-23): si no viene explícito, se resuelve desde el
        // usuario que genera el gasto. Esto evita que un llamador nuevo (o
        // un flujo interno como separarAdjunto/separarComprobante) se olvide
        // de propagarlo y termine creando un gasto huérfano de empresa.
        const empresaId =
            params.empresa_id ?? (await this.obtenerEmpresaIdDeUsuario(params.usuario_id));

        const { data: gasto, error: errorGasto } = await client
            .from('gastos')
            .insert({
                usuario_id: params.usuario_id,
                empresa_id: empresaId,
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
            if (params.items && params.items.length > 0) {
                await this.insertarItemsComprobante(comprobante.id, params.items);
            }
        }

        let evidencia: any = null;
        if (params.evidencia) {
            evidencia = await this.insertarEvidencia(gasto.id, params.evidencia);
        }

        let pago: any = null;
        if (params.pago) {
            pago = await this.insertarPago(gasto.id, params.pago);
        }

        return { gasto, comprobante, evidencia, pago };
    }

    // Adjunta un comprobante (y opcionalmente una evidencia) a un gasto ya
    // existente. Usado por el flujo de Telegram "¿Tienes comprobante? Sí" y
    // por el comando /gastos → "Agregar comprobante".
    async adjuntarComprobante(
        gastoId: number,
        comprobante: DatosComprobante | null,
        evidencia?: DatosEvidencia | null,
        pago?: DatosPago | null,
        items?: DatosItemComprobante[],
    ) {
        await this.obtenerPorId(gastoId); // valida que el gasto exista

        // El comprobante es opcional acá: cuando el archivo agrupado no es
        // otra factura sino solo una captura de pago (ej. Yape), no hay
        // comprobante nuevo que registrar -- solo evidencia y/o pago. Insertar
        // un "comprobante" vacío (sin número, sin empresa) generaba una fila
        // basura colgada del mismo gasto.
        let comprobanteInsertado: any = null;
        if (comprobante) {
            comprobanteInsertado = await this.insertarComprobante(gastoId, comprobante);
            if (items && items.length > 0) {
                await this.insertarItemsComprobante(comprobanteInsertado.id, items);
            }
        }

        let evidenciaInsertada: any = null;
        if (evidencia) {
            evidenciaInsertada = await this.insertarEvidencia(gastoId, evidencia);
        }

        // Caso "factura + Yape" (sección 14): si el segundo archivo agrupado
        // trae un medio de pago identificado (ej. la captura de Yape llegó
        // después de la factura), se registra como pago de este mismo gasto
        // en vez de perderse.
        let pagoInsertado: any = null;
        if (pago) {
            pagoInsertado = await this.insertarPago(gastoId, pago);
        }

        return { comprobante: comprobanteInsertado, evidencia: evidenciaInsertada, pago: pagoInsertado };
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
            .select('*, comprobantes(*, comprobante_items(*)), evidencias(*), pagos(*)')
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
            .select('*, comprobantes(*, comprobante_items(*)), evidencias(*), pagos(*)')
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
    // Deshace una agrupación automática que el usuario marcó como incorrecta
    // (botón "No, es otro gasto"). El adjunto que se agrupó por error puede
    // ser un comprobante (otra factura agrupada por monto) o, cuando la
    // heurística agrupó solo una captura de pago (Yape/transferencia) sin
    // comprobante nuevo, puede ser solo evidencia + pago. En ambos casos se
    // crea un gasto nuevo y se mueven ahí las filas que correspondan.
    async separarAdjunto(
        gastoOrigenId: number,
        comprobanteId: number | null,
        evidenciaId: number | null,
        pagoId: number | null,
        usuarioId: number,
    ) {
        const client = this.supabase.getClient();

        if (comprobanteId) {
            return this.separarComprobante(comprobanteId, evidenciaId, usuarioId);
        }

        // Caso sin comprobante: el adjunto de sobra es solo evidencia y/o
        // pago (típicamente la captura de Yape agrupada de más). El monto
        // del gasto nuevo sale del pago si se pudo leer; si no, se usa el
        // del gasto de origen (por algo se agruparon: el monto coincidía).
        let monto: number | null = null;
        if (pagoId) {
            const { data: pago, error: errPago } = await client
                .from('pagos')
                .select('*')
                .eq('id', pagoId)
                .maybeSingle();
            if (errPago) {
                throw new InternalServerErrorException(`Error buscando el pago: ${errPago.message}`);
            }
            monto = pago?.monto ?? null;
        }
        if (monto == null) {
            const gastoOrigen = await this.obtenerPorId(gastoOrigenId);
            monto = gastoOrigen?.monto ?? 0;
        }
        const montoFinal: number = monto as number;

        const fechaHoyPeru = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
        const { gasto: nuevoGasto } = await this.crear({
            usuario_id: usuarioId,
            descripcion: null,
            monto: montoFinal,
            fecha: fechaHoyPeru,
        });

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

        if (pagoId) {
            const { error: errMovePago } = await client
                .from('pagos')
                .update({ gasto_id: nuevoGasto.id })
                .eq('id', pagoId);
            if (errMovePago) {
                throw new InternalServerErrorException(`Error separando el pago: ${errMovePago.message}`);
            }
        }

        return nuevoGasto;
    }

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
    // otros usuarios. El nivel "alta" se declara cuando además coincide el
    // número de comprobante/factura, o el mismo proveedor (por RUC, cuando
    // se pudo extraer) — ambas son señales fuertes de que es el mismo pago.
    // Número de operación de Yape y similitud de imagen quedan fuera hasta
    // que existan esos campos.
    async buscarPosibleDuplicadoEntreUsuarios(
        usuarioId: number,
        monto: number,
        fecha: string,
        numeroComprobante?: string | null,
        proveedorId?: number | null,
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

        // Mismo proveedor (identificado por RUC vía buscarOCrear, ver
        // ProveedoresService) es otra señal fuerte: si Wilber y su esposa
        // suben la misma foto de la misma ferretería el mismo día por el
        // mismo monto, es altamente probable que sea el mismo pago aunque
        // no se haya podido leer el número de comprobante.
        const coincideProveedor = !!proveedorId && candidato.proveedor_id === proveedorId;

        return {
            gasto: candidato,
            usuario_nombre: candidato.usuarios?.nombre ?? 'otro usuario',
            nivel: coincideNumero || coincideProveedor ? ('alta' as const) : ('media' as const),
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

    // El usuario confirmó que SÍ era el mismo pago (botón "dup_si"): a
    // diferencia de descartarDuplicado, acá se deja `posible_duplicado_de`
    // tal cual -- no se borra, para no perder la trazabilidad de que este
    // gasto quedó marcado como duplicado en el reporte. Lo único que se
    // apaga es `pendiente_revision`, porque una persona ya lo validó; si no
    // se apagara, este gasto quedaría para siempre en cualquier vista futura
    // de "pendientes de revisar" (RF-20) aunque ya esté resuelto.
    async confirmarDuplicado(gastoId: number) {
        const { error } = await this.supabase
            .getClient()
            .from('gastos')
            .update({ pendiente_revision: false })
            .eq('id', gastoId);

        if (error) {
            throw new InternalServerErrorException(`Error confirmando duplicado: ${error.message}`);
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
            .select('*, comprobantes(*, comprobante_items(*)), evidencias(*), pagos(*)')
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

    // Resuelve la empresa de un usuario (RF-23). Consulta directa a
    // `usuarios` en vez de depender de UsuariosService, para no acoplar
    // GastosModule a UsuariosModule solo por este dato puntual.
    private async obtenerEmpresaIdDeUsuario(usuarioId: number): Promise<number | null> {
        const { data, error } = await this.supabase
            .getClient()
            .from('usuarios')
            .select('empresa_id')
            .eq('id', usuarioId)
            .maybeSingle();

        if (error) {
            throw new InternalServerErrorException(
                `Error resolviendo la empresa del usuario: ${error.message}`,
            );
        }
        return data?.empresa_id ?? null;
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

    // Inserta el detalle línea por línea de un comprobante recién creado.
    // No valida cantidades/costos: ya vienen normalizados desde
    // facturas-normalizer.ts (0 en vez de null si Gemini no pudo leerlos).
    private async insertarItemsComprobante(comprobanteId: number, items: DatosItemComprobante[]) {
        const filas = items
            .filter((i) => i.producto && i.producto.trim().length > 0)
            .map((i) => ({
                comprobante_id: comprobanteId,
                producto: i.producto,
                cantidad: i.cantidad ?? null,
                costo: i.costo ?? null,
            }));

        if (filas.length === 0) return [];

        const { data, error } = await this.supabase
            .getClient()
            .from('comprobante_items')
            .insert(filas)
            .select('*');

        if (error) {
            throw new InternalServerErrorException(
                `Error guardando el detalle del comprobante: ${error.message}`,
            );
        }
        return data ?? [];
    }

    private async insertarPago(gastoId: number, datos: DatosPago) {
        const { data, error } = await this.supabase
            .getClient()
            .from('pagos')
            .insert({
                gasto_id: gastoId,
                medio: datos.medio,
                numero_operacion: datos.numero_operacion ?? null,
                monto: datos.monto ?? null,
            })
            .select('*')
            .single();

        if (error) {
            throw new InternalServerErrorException(`Error guardando el pago: ${error.message}`);
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