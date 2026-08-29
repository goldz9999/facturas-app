import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { SupabaseService } from '../common/supabase.service';
import { UsuarioLockService } from '../common/usuario-lock.service';
import { GeminiService } from '../ia/gemini.service';
import { normalizarFactura } from './facturas-normalizer';
import { GastosService } from '../gastos/gastos.service';
import { convertirImagenAWebp } from './imagen.util';
import { ProveedoresService } from '../proveedores/proveedores.service';

const BUCKET = 'Facturas';

// Forma mínima que necesitamos de un archivo, para poder reusar el mismo
// pipeline tanto con archivos de Multer (upload web) como con archivos
// descargados de la API de Telegram.
export interface ArchivoEntrada {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
}

export interface FindFacturasParams {
  empresa?: string;
  n_factura?: string;
  desde?: string; // fecha ISO YYYY-MM-DD
  hasta?: string; // fecha ISO YYYY-MM-DD
  page?: number;
  pageSize?: number;
}

@Injectable()
export class FacturasService {
  constructor(
    private supabase: SupabaseService,
    private gemini: GeminiService,
    private gastosService: GastosService,
    private proveedoresService: ProveedoresService,
    private usuarioLock: UsuarioLockService,
  ) { }

  async findAll(params: FindFacturasParams) {
    const page = params.page && params.page > 0 ? params.page : 1;
    const pageSize = params.pageSize && params.pageSize > 0 ? params.pageSize : 20;
    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    let query = this.supabase
      .getClient()
      .from('facturas')
      .select('*, factura_items(*)', { count: 'exact' })
      .order('fecha', { ascending: false })
      .range(from, to);

    if (params.empresa) {
      query = query.ilike('empresa', `%${params.empresa}%`);
    }
    if (params.n_factura) {
      query = query.ilike('n_factura', `%${params.n_factura}%`);
    }
    if (params.desde) {
      query = query.gte('fecha', params.desde);
    }
    if (params.hasta) {
      query = query.lte('fecha', params.hasta);
    }

    const { data, error, count } = await query;

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    const dataConImagen = await Promise.all(
      (data ?? []).map(async (row) => {
        if (!row.imagen_url) {
          return { ...row, imagen_signed_url: null };
        }
        const { data: signed } = await this.supabase
          .getClient()
          .storage.from('Facturas')
          .createSignedUrl(row.imagen_url, 3600); // válida 1 hora
        return { ...row, imagen_signed_url: signed?.signedUrl ?? null };
      }),
    );

    return {
      data: dataConImagen,
      page,
      pageSize,
      total: count ?? 0,
    };
  }
  // Punto de entrada único: procesa el archivo directamente en el backend
  // (Gemini + Supabase). usuarioId es obligatorio: todo gasto queda
  // vinculado al usuario que lo subió (RF de trazabilidad).
  async procesarArchivos(files: Array<Express.Multer.File>, usuarioId: number) {
    return this.procesarArchivosEnBackend(files, usuarioId);
  }

  // Reemplaza todo el workflow de n8n: sube la imagen a Supabase Storage,
  // transcribe con Gemini, extrae los datos estructurados y guarda
  // el gasto (+ comprobante + evidencia) en el esquema nuevo.
  private async procesarArchivosEnBackend(
    files: Array<Express.Multer.File>,
    usuarioId: number,
  ) {
    const resultados = await Promise.all(
      files.map(async (file) => {
        try {
          const resultado = await this.procesarArchivoIndividual(file, usuarioId);
          return { archivo: file.originalname, ok: true, resultado };
        } catch (err) {
          return {
            archivo: file.originalname,
            ok: false,
            error: err.message || 'Error desconocido al procesar la factura',
          };
        }
      }),
    );

    return { resultados };
  }

  // Pipeline completo (subir a Storage + Gemini + guardar en el esquema
  // gastos/comprobantes/evidencias). Público porque también lo usa
  // TelegramService para procesar audios/fotos/documentos recibidos por el
  // bot, sin pasar por n8n. usuarioId identifica quién generó el gasto
  // (para Telegram: el usuario autorizado que escribió; para el upload
  // web: el usuario logueado en el frontend).
  async procesarArchivoIndividual(
    file: ArchivoEntrada,
    usuarioId: number,
    origen: 'web' | 'telegram' = 'web',
  ) {
    const mimeType = file.mimetype || 'application/octet-stream';
    const esAudio = mimeType.startsWith('audio/');
    const extMap: Record<string, string> = {
      'image/jpeg': 'jpg',
      'image/jpg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
      'application/pdf': 'pdf',
      'application/msword': 'doc',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
        'docx',
    };
    const extPorNombre = file.originalname?.includes('.')
      ? file.originalname.split('.').pop()
      : undefined;
    const ext = extPorNombre || extMap[mimeType] || 'bin';
    const nombreArchivo = `web_${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}.${ext}`;

    // 1. Subir el archivo original a Supabase Storage (igual que "Guardar Imagen1").
    //    Si es una imagen (no PDF/doc), se convierte a WebP antes de subir
    //    para ahorrar espacio en el bucket; el buffer original (sin
    //    convertir) se sigue usando para Gemini más abajo, no se pierde
    //    calidad para la extracción.
    let nombreArchivoFinal = nombreArchivo;
    if (!esAudio) {
      const convertida = await convertirImagenAWebp(file.buffer, mimeType);
      const bufferASubir = convertida?.buffer ?? file.buffer;
      const mimeASubir = convertida?.mimetype ?? mimeType;
      if (convertida) {
        nombreArchivoFinal = `web_${Date.now()}-${Math.random().toString(36).slice(2, 8)}.webp`;
      }

      const { error: uploadError } = await this.supabase
        .getClient()
        .storage.from(BUCKET)
        .upload(nombreArchivoFinal, bufferASubir, {
          contentType: mimeASubir,
          upsert: true,
        });
      if (uploadError) {
        throw new InternalServerErrorException(
          `Error subiendo el archivo: ${uploadError.message}`,
        );
      }
    }

    // 2. Transcribir con Gemini (imagen/documento u audio)
    const texto = esAudio
      ? await this.gemini.transcribirAudio(file.buffer, mimeType)
      : await this.gemini.transcribirImagenODocumento(file.buffer, mimeType);

    // 3. Extraer datos estructurados con Gemini (prompt distinto si es audio)
    const datosExtraidos = await this.gemini.extraerFactura(texto, esAudio);

    // 4. Normalizar (fecha, items) igual que "Separar articulos1"
    const factura = normalizarFactura(datosExtraidos);

    // 5. Heurística de agrupación de evidencias (solo para comprobantes, no
    //    para audio): si el mismo usuario tiene un gasto reciente con el
    //    mismo monto (ej. acaba de mandar la factura y ahora manda el Yape,
    //    o al revés), asumimos que es el mismo gasto y le adjuntamos el
    //    comprobante + evidencia en vez de crear un gasto nuevo. Ver
    //    diagnóstico técnico, sección 3.
    const montoDetectado = factura.total_factura || 0;

    const datosComprobante = {
      tipo: 'factura' as const,
      numero: factura.n_factura || null,
      empresa_emisora: factura.empresa || null,
      subtotal: factura.subtotal,
      igv: factura.igv,
      total: factura.total_factura,
      fecha_documento: factura.fecha,
    };
    const datosEvidencia = {
      tipo: ext === 'pdf' ? 'pdf' : ('imagen' as const),
      storage_path: nombreArchivoFinal,
      origen,
    };

    // 5a. Pago (sección 7/8): solo se registra cuando Gemini identificó un
    //    medio de pago claro (captura de Yape/transferencia, o el usuario lo
    //    dijo por audio). Si es una factura sin indicación de pago, no se
    //    inventa nada.
    const datosPago = factura.medio_pago
      ? {
        medio: factura.medio_pago,
        numero_operacion: factura.numero_operacion || null,
        monto: montoDetectado || null,
      }
      : null;

    // A partir de acá (buscar si hay un gasto para agrupar -> insertar) todo
    // corre serializado por usuario (UsuarioLockService). Si dos archivos
    // del mismo usuario llegan casi juntos (ej. factura + captura de Yape
    // mandadas seguidas, o un álbum de fotos), sin este lock ambos podrían
    // leer "no hay gasto con este monto" al mismo tiempo -- ninguno ve
    // todavía el insert del otro -- y terminar como dos gastos separados en
    // vez de agruparse en uno solo. Lo que sí corrió antes (subir a
    // Storage, Gemini) no necesita serializarse, así que queda afuera del
    // lock para no perder paralelismo donde no hace falta.
    const resultado = await this.usuarioLock.runExclusive(usuarioId, async () => {
      const candidato =
        !esAudio && montoDetectado > 0
          ? await this.gastosService.buscarCandidatoParaAgrupar(usuarioId, montoDetectado)
          : null;

      // 5c. Matching de proveedor/categoría (sección 9 de requerimientos):
      //    solo aplica a comprobantes con nombre de empresa detectado, no a
      //    audio (que normalmente no trae un nombre de proveedor confiable)
      //    ni cuando el archivo se agrupó con un gasto propio reciente (el
      //    gasto ya existe y ya tiene su categoría, si la tuvo).
      let proveedorId: number | null = null;
      let categoriaId: number | null = null;
      let esPersonalSugerido: boolean | null = null;
      let faltaPreguntarCategoria = false;

      if (!esAudio && !candidato && factura.empresa) {
        const proveedor = await this.proveedoresService.buscarOCrear(factura.empresa, factura.ruc);
        proveedorId = proveedor.id;
        if (proveedor.categoria_id_sugerida) {
          // Proveedor ya conocido: se aplica la sugerencia directo, sin
          // preguntar (aprendizaje progresivo).
          categoriaId = proveedor.categoria_id_sugerida;
          esPersonalSugerido = proveedor.es_personal_sugerido;
        } else {
          // Proveedor nuevo (o sin sugerencia todavía): Telegram debe
          // preguntar categoría + tipo de gasto, y guardar la respuesta como
          // sugerencia para la próxima vez.
          faltaPreguntarCategoria = true;
        }
      }

      let gastoId: number;
      let vinculadoA: {
        gasto_id: number;
        monto: number;
        comprobante_id: number | null;
        evidencia_id: number | null;
        pago_id: number | null;
      } | null = null;
      let posibleDuplicado: { usuario_nombre: string; nivel: 'alta' | 'media' } | null = null;

      if (candidato) {
        // No siempre el segundo archivo agrupado es "otra factura": si lo
        // único que aporta es la captura de un pago (Yape/transferencia,
        // sin número de factura ni empresa emisora), no debe generar un
        // comprobante nuevo -- solo cuelga la evidencia y el pago del mismo
        // gasto. Se considera "factura" cuando trae número o nombre de
        // empresa emisora.
        const pareceFactura = Boolean(datosComprobante.numero || datosComprobante.empresa_emisora);

        const { comprobante, evidencia, pago } = await this.gastosService.adjuntarComprobante(
          candidato.id,
          pareceFactura ? datosComprobante : null,
          esAudio ? null : datosEvidencia,
          datosPago,
        );
        gastoId = candidato.id;
        vinculadoA = {
          gasto_id: candidato.id,
          monto: candidato.monto,
          comprobante_id: comprobante?.id ?? null,
          evidencia_id: evidencia?.id ?? null,
          pago_id: pago?.id ?? null,
        };
      } else {
        // 5b. Guardar el gasto en el esquema nuevo (gastos + comprobante +
        //    evidencia). Si es audio, no hay comprobante (puede no haber
        //    factura física) ni evidencia (el audio no se sube a Storage).
        //    NOTA: los items línea por línea (factura.items) no tienen tabla
        //    propia todavía en el esquema nuevo; se devuelven en la respuesta
        //    para el mensaje de Telegram, pero no se persisten aparte. Si se
        //    necesita el detalle guardado, se puede sumar una tabla
        //    `comprobante_items` sin tocar esta función.
        const { gasto } = await this.gastosService.crear({
          usuario_id: usuarioId,
          descripcion: factura.empresa || null,
          monto: montoDetectado,
          fecha: factura.fecha,
          confianza: factura.confianza,
          comprobante: esAudio ? null : datosComprobante,
          evidencia: esAudio ? null : datosEvidencia,
          pago: datosPago,
          categoria_id: categoriaId,
          proveedor_id: proveedorId,
          es_personal: esPersonalSugerido ?? undefined,
        });
        gastoId = gasto.id;

        // Detección de duplicados entre usuarios distintos (sección 17): solo
        // tiene sentido para comprobantes (mismo caso del ejemplo, Yape/foto),
        // no para audio, que no tiene monto confiable para comparar.
        if (!esAudio && montoDetectado > 0) {
          const duplicado = await this.gastosService.buscarPosibleDuplicadoEntreUsuarios(
            usuarioId,
            montoDetectado,
            factura.fecha,
            datosComprobante.numero,
            proveedorId,
          );
          if (duplicado) {
            await this.gastosService.marcarPosibleDuplicado(gastoId, duplicado.gasto.id);
            posibleDuplicado = { usuario_nombre: duplicado.usuario_nombre, nivel: duplicado.nivel };
          }
        }
      }

      return { gastoId, vinculadoA, posibleDuplicado, proveedorId, faltaPreguntarCategoria };
    });

    const { gastoId, vinculadoA, posibleDuplicado, proveedorId, faltaPreguntarCategoria } = resultado;

    // 6. Respuesta con una forma compatible con la que devolvía el webhook
    //    de n8n (empresa, n_factura, fecha, subtotal, igv, total, items),
    //    más el id del gasto nuevo (útil para armar el mensaje de Telegram
    //    y para el flujo de "adjuntar comprobante después"), más info de
    //    agrupación si aplicó la heurística (para que Telegram confirme).
    return {
      success: true,
      mensaje: 'Gasto registrado correctamente',
      gasto_id: gastoId,
      empresa: factura.empresa,
      n_factura: factura.n_factura,
      fecha: factura.fecha,
      subtotal: factura.subtotal,
      igv: factura.igv,
      total: factura.total_factura || 0,
      medio_pago: factura.medio_pago,
      confianza: factura.confianza,
      items: factura.items,
      vinculado_a: vinculadoA,
      es_audio: esAudio,
      posible_duplicado: posibleDuplicado,
      proveedor_id: proveedorId,
      falta_categoria: faltaPreguntarCategoria,
    };
  }

  // Adjunta un comprobante (foto/PDF) a un gasto YA existente. Usado por el
  // flujo de botones de Telegram: "¿Tienes comprobante? Sí" o
  // "/gastos → Agregar comprobante". A diferencia de procesarArchivoIndividual,
  // acá nunca se crea un gasto nuevo: siempre cuelga del gastoId dado.
  async adjuntarComprobanteAGasto(gastoId: number, file: ArchivoEntrada) {
    const mimeType = file.mimetype || 'application/octet-stream';
    const extMap: Record<string, string> = {
      'image/jpeg': 'jpg',
      'image/jpg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
      'application/pdf': 'pdf',
    };
    const extPorNombre = file.originalname?.includes('.')
      ? file.originalname.split('.').pop()
      : undefined;
    const ext = extPorNombre || extMap[mimeType] || 'bin';
    const nombreArchivo = `telegram_${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}.${ext}`;

    // Igual que en procesarArchivoIndividual: si es imagen, se convierte a
    // WebP antes de subir (ahorro de espacio); Gemini sigue leyendo el
    // buffer original más abajo.
    const convertida = await convertirImagenAWebp(file.buffer, mimeType);
    const bufferASubir = convertida?.buffer ?? file.buffer;
    const mimeASubir = convertida?.mimetype ?? mimeType;
    const nombreArchivoFinal = convertida
      ? `telegram_${Date.now()}-${Math.random().toString(36).slice(2, 8)}.webp`
      : nombreArchivo;

    const { error: uploadError } = await this.supabase
      .getClient()
      .storage.from(BUCKET)
      .upload(nombreArchivoFinal, bufferASubir, { contentType: mimeASubir, upsert: true });
    if (uploadError) {
      throw new InternalServerErrorException(`Error subiendo el archivo: ${uploadError.message}`);
    }

    const texto = await this.gemini.transcribirImagenODocumento(file.buffer, mimeType);
    const datosExtraidos = await this.gemini.extraerFactura(texto, false);
    const factura = normalizarFactura(datosExtraidos);

    const { comprobante, pago } = await this.gastosService.adjuntarComprobante(
      gastoId,
      {
        tipo: 'factura',
        numero: factura.n_factura || null,
        empresa_emisora: factura.empresa || null,
        subtotal: factura.subtotal,
        igv: factura.igv,
        total: factura.total_factura,
        fecha_documento: factura.fecha,
      },
      {
        tipo: ext === 'pdf' ? 'pdf' : 'imagen',
        storage_path: nombreArchivoFinal,
        origen: 'telegram',
      },
      factura.medio_pago
        ? {
          medio: factura.medio_pago,
          numero_operacion: factura.numero_operacion || null,
          monto: factura.total_factura || null,
        }
        : null,
    );

    return { comprobante, pago, factura };
  }

}