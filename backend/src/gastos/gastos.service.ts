import { Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../common/supabase.service';
import { ProveedoresService } from '../proveedores/proveedores.service';
import { convertirImagenAWebp } from '../facturas/imagen.util';

// Mismo bucket que usa facturas.service.ts para las evidencias que llegan
// por Telegram/upload -- se repite acá (en vez de importar desde
// FacturasModule) para no crear una dependencia de módulo que no hace
// falta: convertirImagenAWebp es una función pura, sin DI de por medio.
const BUCKET = 'Facturas';

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

// Filtros de GastosController.listar() / GET /gastos — cubre la sección 24
// de requerimientos (panel de control: día/semana/mes, personal/empresa,
// por categoría/proveedor/usuario/proyecto/medio de pago, pendientes de
// revisión, posibles duplicados, sin comprobante).
export interface FiltrosGastos {
    desde?: string; // YYYY-MM-DD, inclusive
    hasta?: string; // YYYY-MM-DD, inclusive
    esPersonal?: boolean;
    categoriaId?: number;
    proveedorId?: number;
    usuarioId?: number;
    pedidoId?: number;
    medioPago?: string; // 'yape' | 'transferencia' | 'efectivo' | 'tarjeta' | otro valor libre en pagos.medio
    pendienteRevision?: boolean;
    posibleDuplicado?: boolean; // true = solo gastos con posible_duplicado_de seteado
    sinComprobante?: boolean; // true = sin fila en comprobantes; false = con comprobante
    limite?: number; // default 50, tope 200
    offset?: number; // default 0
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
    constructor(
        private supabase: SupabaseService,
        private proveedoresService: ProveedoresService,
    ) { }

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

        // Snapshot del nombre: si el usuario se elimina más adelante (ej. ya
        // no trabaja en la empresa), el gasto sigue mostrando quién lo hizo.
        const nombreUsuario = await this.obtenerNombreDeUsuario(params.usuario_id);

        const { data: gasto, error: errorGasto } = await client
            .from('gastos')
            .insert({
                usuario_id: params.usuario_id,
                usuario_nombre: nombreUsuario,
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
        empresaId?: number | null,
    ) {
        await this.obtenerPorId(gastoId, empresaId); // valida que el gasto exista y sea de esta empresa

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
            pagoInsertado = await this.insertarPago(gastoId, pago, empresaId);
        }

        return { comprobante: comprobanteInsertado, evidencia: evidenciaInsertada, pago: pagoInsertado };
    }

    // Solo adjunta la evidencia (ej. cuando llega un audio sin comprobante,
    // pero igual queremos guardar el archivo original como respaldo).
    async adjuntarEvidencia(gastoId: number, evidencia: DatosEvidencia, empresaId?: number | null) {
        await this.obtenerPorId(gastoId, empresaId);
        return this.insertarEvidencia(gastoId, evidencia);
    }

    // Sube una imagen (ej. captura de Yape, foto de un comprobante) a
    // Storage desde el panel web y la deja registrada como evidencia del
    // gasto -- mismo bucket y misma conversión a WebP que el flujo de
    // Telegram/upload (ver facturas.service.ts), pero sin pasar por Gemini:
    // acá el usuario ya llenó los datos a mano (Pago, Comprobante), la
    // imagen es solo el respaldo visual.
    async subirEvidenciaImagen(gastoId: number, file: Express.Multer.File, empresaId?: number | null) {
        await this.obtenerPorId(gastoId, empresaId); // valida que el gasto exista y sea de esta empresa, 404 si no

        const mimeType = file.mimetype;
        const extMap: Record<string, string> = { 'application/pdf': 'pdf' };
        const extPorNombre = file.originalname?.includes('.')
            ? file.originalname.split('.').pop()
            : undefined;
        const ext = extPorNombre || extMap[mimeType] || 'bin';

        let nombreArchivoFinal = `web_${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
        let bufferASubir = file.buffer;
        let mimeASubir = mimeType;

        const convertida = await convertirImagenAWebp(file.buffer, mimeType);
        if (convertida) {
            nombreArchivoFinal = `web_${Date.now()}-${Math.random().toString(36).slice(2, 8)}.webp`;
            bufferASubir = convertida.buffer;
            mimeASubir = convertida.mimetype;
        }

        const { error: uploadError } = await this.supabase
            .getClient()
            .storage.from(BUCKET)
            .upload(nombreArchivoFinal, bufferASubir, { contentType: mimeASubir, upsert: true });
        if (uploadError) {
            throw new InternalServerErrorException(`Error subiendo el archivo: ${uploadError.message}`);
        }

        return this.insertarEvidencia(gastoId, {
            tipo: ext === 'pdf' ? 'pdf' : 'imagen',
            storage_path: nombreArchivoFinal,
            origen: 'web',
        });
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
    //
    // `traeComprobante`/`traePago` describen qué pieza aporta el archivo que
    // se está procesando ahora mismo. Un candidato solo es válido si le
    // *falta* esa pieza -- si el gasto candidato YA tiene comprobante y el
    // archivo nuevo también trae uno, no es "el Yape que faltaba", es un
    // gasto distinto que casualmente coincide en monto (o el mismo archivo
    // procesado dos veces, ej. por un reintento). Sin este filtro, un gasto
    // ya completo podía terminar con dos comprobantes y dos pagos pegados
    // encima -- confirmado en producción (mismo N° de operación de Yape
    // repetido en dos filas de `pagos` del mismo gasto).
    async buscarCandidatoParaAgrupar(
        usuarioId: number,
        monto: number,
        opciones: { traeComprobante?: boolean; traePago?: boolean } = {},
        ventanaMinutos = 15,
    ) {
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

        const candidato = (data ?? []).find((g) => {
            if (g.monto == null || Math.abs(Number(g.monto) - monto) > tolerancia) return false;

            const yaTieneComprobante = Array.isArray(g.comprobantes) && g.comprobantes.length > 0;
            const yaTienePago = Array.isArray(g.pagos) && g.pagos.length > 0;

            // Si el archivo nuevo trae comprobante, el candidato debe carecer
            // de uno (si no, ya tiene su propia factura -- no es el mismo).
            if (opciones.traeComprobante && yaTieneComprobante) return false;
            // Mismo criterio para pago (ej. Yape ya registrado antes).
            if (opciones.traePago && yaTienePago) return false;

            return true;
        });
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
    // otros usuarios. El nivel "alta" se declara cuando además coincide
    // alguna señal fuerte: número de comprobante/factura, mismo proveedor
    // (por proveedor_id, que ya agrupa por RUC vía buscarOCrear), el RUC
    // crudo de esta factura contra el RUC del proveedor del candidato
    // (además del match por proveedor_id, cubre el caso borde de dos filas
    // de `proveedores` con el mismo RUC), o el número de operación de Yape.
    // Similitud de imagen queda fuera todavía.
    async buscarPosibleDuplicadoEntreUsuarios(
        usuarioId: number,
        monto: number,
        fecha: string,
        numeroComprobante?: string | null,
        proveedorId?: number | null,
        ruc?: string | null,
        numeroOperacion?: string | null,
    ) {
        const tolerancia = 0.5; // soles

        const { data, error } = await this.supabase
            .getClient()
            .from('gastos')
            .select('*, usuarios(nombre), comprobantes(*), proveedores(ruc), pagos(numero_operacion)')
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

        // RUC crudo de esta factura contra el RUC guardado en el proveedor
        // del candidato. Complementa a coincideProveedor: por lo general
        // ambos coinciden juntos (mismo RUC → mismo proveedor_id, gracias a
        // ProveedoresService.buscarOCrear), pero esto también agarra el caso
        // borde de dos filas de `proveedores` con el mismo RUC (ej. una se
        // creó por nombre antes de que existiera match por RUC).
        const rucCandidato = (candidato as any).proveedores?.ruc ?? null;
        const coincideRuc = !!ruc && !!rucCandidato && ruc === rucCandidato;

        // Número de operación de Yape/transferencia (tabla `pagos`, sección
        // 7/8). Señal fuerte porque es un identificador único del banco/app,
        // no algo que dos pagos distintos compartan por casualidad.
        const coincideOperacion =
            !!numeroOperacion &&
            Array.isArray((candidato as any).pagos) &&
            (candidato as any).pagos.some((p: any) => p.numero_operacion && p.numero_operacion === numeroOperacion);

        return {
            gasto: candidato,
            usuario_nombre: candidato.usuarios?.nombre ?? 'otro usuario',
            nivel: coincideNumero || coincideProveedor || coincideRuc || coincideOperacion ? ('alta' as const) : ('media' as const),
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

    // Lista de gastos con filtros (sección 24 de requerimientos: día/semana/mes,
    // personal/empresarial, por categoría/proveedor/usuario/proyecto/medio de
    // pago, pendientes de revisión, posibles duplicados, sin comprobante).
    //
    // `medioPago` y `sinComprobante` se resuelven en memoria después de traer
    // la página de resultados (no como filtro SQL) porque dependen de tablas
    // hijas (pagos/comprobantes) y, al volumen actual de un solo tenant
    // interno, es mucho más simple y legible que pelear con el embedded
    // filter de PostgREST. Si el volumen crece de forma importante, esto es
    // el primer punto a revisar (mover el filtro a SQL o a una vista).
    async listar(filtros: FiltrosGastos, empresaId?: number) {
        const limite = Math.min(filtros.limite ?? 50, 200);
        const offset = filtros.offset ?? 0;

        let query = this.supabase
            .getClient()
            .from('gastos')
            .select(
                '*, categorias(nombre), proveedores(nombre), comprobantes(id, numero, tipo), pagos(id, medio, numero_operacion)',
            )
            .order('fecha', { ascending: false })
            .order('creado_en', { ascending: false });

        // Aislamiento por empresa: si viene empresaId (quien llama es admin,
        // no super_admin), se fuerza. super_admin (empresaId undefined) ve
        // de todas las empresas, igual que ya hace UsuariosService.listar().
        if (empresaId !== undefined) {
            query = query.eq('empresa_id', empresaId);
        }

        if (filtros.desde) query = query.gte('fecha', filtros.desde);
        if (filtros.hasta) query = query.lte('fecha', filtros.hasta);
        if (filtros.esPersonal !== undefined) query = query.eq('es_personal', filtros.esPersonal);
        if (filtros.categoriaId !== undefined) query = query.eq('categoria_id', filtros.categoriaId);
        if (filtros.proveedorId !== undefined) query = query.eq('proveedor_id', filtros.proveedorId);
        if (filtros.usuarioId !== undefined) query = query.eq('usuario_id', filtros.usuarioId);
        if (filtros.pedidoId !== undefined) query = query.eq('pedido_id', filtros.pedidoId);
        if (filtros.pendienteRevision !== undefined) query = query.eq('pendiente_revision', filtros.pendienteRevision);
        if (filtros.posibleDuplicado) query = query.not('posible_duplicado_de', 'is', null);

        // Se pide una página más grande cuando hay filtro de medio de pago o
        // "sin comprobante", porque el filtro real se aplica después de
        // traer los datos (ver nota arriba) — si no, la paginación quedaría
        // mal (podríamos devolver menos de `limite` aunque existan más
        // resultados reales más adelante en la tabla).
        const necesitaFiltroEnMemoria = !!filtros.medioPago || filtros.sinComprobante !== undefined;
        const rangoHasta = necesitaFiltroEnMemoria ? offset + limite * 5 - 1 : offset + limite - 1;
        query = query.range(offset, rangoHasta);

        const { data, error } = await query;
        if (error) {
            throw new InternalServerErrorException(`Error listando gastos: ${error.message}`);
        }

        let resultado = data ?? [];

        if (filtros.medioPago) {
            resultado = resultado.filter((g: any) =>
                (g.pagos ?? []).some((p: any) => p.medio === filtros.medioPago),
            );
        }
        if (filtros.sinComprobante !== undefined) {
            resultado = resultado.filter((g: any) => {
                const tieneComprobante = (g.comprobantes ?? []).length > 0;
                return filtros.sinComprobante ? !tieneComprobante : tieneComprobante;
            });
        }

        return resultado.slice(0, limite);
    }

    // Totales agregados para Dashboard.jsx (hoy/semana/mes, empresa vs
    // personal, top categorías/proveedores del mes, últimos gastos). Mismo
    // criterio que ProveedoresService.listar(): no se desnormaliza nada
    // nuevo, se calcula on-the-fly a partir de `gastos` (Paso 24.3 de
    // PROGRESO_SIREGG). "Hoy"/"semana"/"mes" se calculan en huso horario de
    // Perú, igual que ya hace facturas-normalizer.ts / GastosService (ver
    // fechaHoyPeru más arriba en este archivo).
    async resumen(empresaId?: number) {
        const client = this.supabase.getClient();

        const fechaHoyPeru = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
        const hoy = new Date(`${fechaHoyPeru}T00:00:00`);

        // Semana: lunes como inicio (mismo criterio de calendario que usa
        // el resto de la app en español). getDay(): 0=domingo..6=sábado.
        const diaSemana = hoy.getDay();
        const diasDesdeLunes = diaSemana === 0 ? 6 : diaSemana - 1;
        const inicioSemana = new Date(hoy);
        inicioSemana.setDate(hoy.getDate() - diasDesdeLunes);
        const inicioSemanaStr = inicioSemana.toLocaleDateString('en-CA', { timeZone: 'America/Lima' });

        const inicioMesStr = `${fechaHoyPeru.slice(0, 7)}-01`;

        // Un solo fetch: todo lo del mes en curso alcanza para hoy, semana
        // y mes a la vez (hoy ⊆ semana ⊆ mes). Los "últimos gastos" se
        // piden aparte porque pueden ser de un mes anterior si el mes
        // actual recién empieza.
        let queryMes = client
            .from('gastos')
            .select('monto, fecha, es_personal, categoria_id, proveedor_id, categorias(nombre), proveedores(nombre)')
            .gte('fecha', inicioMesStr);
        if (empresaId !== undefined) queryMes = queryMes.eq('empresa_id', empresaId);

        const { data: gastosMes, error: errorMes } = await queryMes;
        if (errorMes) {
            throw new InternalServerErrorException(`Error calculando resumen: ${errorMes.message}`);
        }

        let today = 0, week = 0, month = 0, company = 0, personal = 0;
        const categorias = new Map<number, { nombre: string; cantidad: number }>();
        const proveedores = new Map<number, { nombre: string; cantidad: number }>();

        for (const g of gastosMes ?? []) {
            const monto = Number(g.monto) || 0;
            month += monto;
            if (g.fecha === fechaHoyPeru) today += monto;
            if (g.fecha >= inicioSemanaStr) week += monto;
            if (g.es_personal) personal += monto; else company += monto;

            if (g.categoria_id != null) {
                const nombre = (g as any).categorias?.nombre || 'Sin categoría';
                const actual = categorias.get(g.categoria_id) || { nombre, cantidad: 0 };
                actual.cantidad += 1;
                categorias.set(g.categoria_id, actual);
            }
            if (g.proveedor_id != null) {
                const nombre = (g as any).proveedores?.nombre || 'Sin proveedor';
                const actual = proveedores.get(g.proveedor_id) || { nombre, cantidad: 0 };
                actual.cantidad += 1;
                proveedores.set(g.proveedor_id, actual);
            }
        }

        const topCategorias = [...categorias.entries()]
            .map(([id, v]) => ({ id, nombre: v.nombre, cantidad: v.cantidad }))
            .sort((a, b) => b.cantidad - a.cantidad)
            .slice(0, 4);
        const topProveedores = [...proveedores.entries()]
            .map(([id, v]) => ({ id, nombre: v.nombre, cantidad: v.cantidad }))
            .sort((a, b) => b.cantidad - a.cantidad)
            .slice(0, 4);

        // Últimos 5 gastos, mismo formato que GET /gastos (relaciones
        // completas) para que el frontend pueda reusar mapearGasto/ExpenseTable
        // sin traducir dos veces.
        const recientes = await this.listar({ limite: 5 }, empresaId);

        return { today, week, month, company, personal, topCategorias, topProveedores, recientes };
    }

    // empresaId: si viene definido, el gasto debe pertenecer a esa empresa
    // o se trata como si no existiera (404, no 403 -- evitamos confirmarle
    // a un usuario de otra empresa que el ID sí existe). super_admin llama
    // con empresaId = undefined y ve cualquier gasto, igual que en listar().
    async obtenerPorId(gastoId: number, empresaId?: number | null) {
        const { data, error } = await this.supabase
            .getClient()
            .from('gastos')
            .select(
                '*, categorias(nombre), proveedores(nombre), comprobantes(*, comprobante_items(*)), evidencias(*), pagos(*)',
            )
            .eq('id', gastoId)
            .maybeSingle();

        if (error) {
            throw new InternalServerErrorException(`Error buscando el gasto: ${error.message}`);
        }
        if (!data) {
            throw new NotFoundException(`Gasto ${gastoId} no encontrado`);
        }
        if (empresaId !== undefined && empresaId !== null && data.empresa_id !== empresaId) {
            throw new NotFoundException(`Gasto ${gastoId} no encontrado`);
        }

        // Las evidencias se guardan en el bucket privado "Facturas" (ver
        // facturas.service.ts / facturas-cleanup.service.ts) -- ExpenseDetail
        // necesita una URL para mostrarlas, así que se firma acá (1h de
        // validez) en vez de exponer el bucket como público.
        if (data.evidencias && data.evidencias.length > 0) {
            data.evidencias = await Promise.all(
                data.evidencias.map(async (ev: any) => {
                    if (!ev.storage_path) return { ...ev, url: null };
                    const { data: firmada, error: errorFirma } = await this.supabase
                        .getClient()
                        .storage.from('Facturas')
                        .createSignedUrl(ev.storage_path, 3600);
                    if (errorFirma) {
                        // Antes esto se tragaba en silencio y el frontend
                        // mostraba "Imagen no disponible" sin pista de por
                        // qué. Logueamos acá (bucket mal escrito, storage_path
                        // que no existe en el bucket, etc.) para poder
                        // diagnosticarlo desde los logs de Railway.
                        console.error(
                            `[GastosService] Error firmando evidencia ${ev.id} (path: "${ev.storage_path}"): ${errorFirma.message}`,
                        );
                    }
                    return { ...ev, url: firmada?.signedUrl ?? null };
                }),
            );
        }

        return data;
    }

    // Campos editables desde ExpenseDetail (panel web). categoria_id y
    // proveedor_id ya se pueden editar (GET /categorias expone la lista
    // para el <select> del frontend; proveedor_id se sigue resolviendo
    // solo, no hay <select> de proveedores todavía).
    async actualizar(
        gastoId: number,
        cambios: Partial<{
            monto: number;
            descripcion: string | null;
            es_personal: boolean;
            categoria_id: number;
            proveedor_id: number;
        }>,
        empresaId?: number | null,
    ) {
        const gastoActual = await this.obtenerPorId(gastoId, empresaId); // valida existencia + empresa, 404 si no

        let query = this.supabase
            .getClient()
            .from('gastos')
            .update({
                ...cambios,
                // Confirmar desde el panel resuelve la revisión pendiente,
                // igual que la confirmación por Telegram.
                pendiente_revision: false,
            })
            .eq('id', gastoId);

        // Defensa en profundidad: aunque obtenerPorId ya validó la empresa
        // arriba, este .eq() evita que un update se cuele por una carrera
        // entre esa validación y este UPDATE (p. ej. el gasto cambiando de
        // empresa entre medio, aunque hoy no hay flujo que haga eso).
        if (empresaId !== undefined && empresaId !== null) {
            query = query.eq('empresa_id', empresaId);
        }

        const { data, error } = await query.select('*').single();

        if (error) {
            throw new InternalServerErrorException(`Error actualizando el gasto: ${error.message}`);
        }

        // Si el usuario corrigió/asignó la categoría a mano desde el panel
        // web, esa corrección debe alimentar la sugerencia del proveedor
        // (mismo mecanismo del Paso 9: `guardarSugerencia`), para que la
        // próxima vez que el bot vea este proveedor por Telegram ya
        // proponga la categoría correcta en vez de preguntar de nuevo.
        // Requiere un proveedor conocido (el del gasto, o uno nuevo que
        // también haya venido en este mismo PATCH) y saber si es
        // personal o empresa -- si `es_personal` no vino en este PATCH,
        // se usa el valor que ya tenía el gasto.
        const proveedorId = cambios.proveedor_id ?? gastoActual.proveedor_id;
        if (cambios.categoria_id !== undefined && proveedorId) {
            const esPersonal = cambios.es_personal ?? gastoActual.es_personal;
            await this.proveedoresService.guardarSugerencia(proveedorId, cambios.categoria_id, esPersonal, empresaId);
        }

        return data;
    }

    // Resuelve la empresa de un usuario (RF-23). Consulta directa a
    // `usuarios` en vez de depender de UsuariosService, para no acoplar
    // GastosModule a UsuariosModule solo por este dato puntual.
    // Público porque FacturasService también necesita resolver la empresa
    // del usuario, ahora que ProveedoresService.buscarOCrear() requiere
    // empresaId para el aislamiento multiempresa (evita duplicar esta
    // consulta en dos servicios).
    async obtenerEmpresaIdDeUsuario(usuarioId: number): Promise<number | null> {
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

    private async obtenerNombreDeUsuario(usuarioId: number): Promise<string | null> {
        const { data, error } = await this.supabase
            .getClient()
            .from('usuarios')
            .select('nombre')
            .eq('id', usuarioId)
            .maybeSingle();

        if (error) {
            throw new InternalServerErrorException(`Error resolviendo el nombre del usuario: ${error.message}`);
        }
        return data?.nombre ?? null;
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

    // Público (antes privado): expuesto ahora también vía POST
    // /gastos/:id/pago para el botón "Añadir" de Pagos en ExpenseDetail.
    // Sigue siendo usado internamente por crear()/adjuntarComprobante() para
    // el flujo de Telegram (factura + Yape), sin cambios ahí.
    async insertarPago(gastoId: number, datos: DatosPago, empresaId?: number | null) {
        await this.obtenerPorId(gastoId, empresaId); // valida que el gasto exista y sea de esta empresa, 404 si no
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