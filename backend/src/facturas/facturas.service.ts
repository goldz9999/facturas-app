import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { SupabaseService } from '../common/supabase.service';
import { GeminiService } from '../ia/gemini.service';
import { normalizarFactura } from './facturas-normalizer';
import { ModoProcesamiento } from './modo.service';
import { GastosService } from '../gastos/gastos.service';

const BUCKET = 'Facturas';

export { ModoProcesamiento };

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
  // Punto de entrada único: según "modo" reenvía a n8n (legado) o procesa
  // el archivo directamente en el backend (Gemini + Supabase), sin n8n.
  // usuarioId es obligatorio en modo 'backend': todo gasto queda vinculado
  // al usuario que lo subió (RF de trazabilidad).
  async procesarArchivos(
    files: Array<Express.Multer.File>,
    modo: ModoProcesamiento = 'n8n',
    usuarioId?: number,
  ) {
    if (modo === 'backend') {
      if (!usuarioId) {
        throw new InternalServerErrorException(
          'usuario_id es obligatorio para procesar en modo backend.',
        );
      }
      return this.procesarArchivosEnBackend(files, usuarioId);
    }
    return this.procesarArchivosConN8n(files);
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
  async procesarArchivoIndividual(file: ArchivoEntrada, usuarioId: number) {
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

    // 1. Subir el archivo original a Supabase Storage (igual que "Guardar Imagen1")
    if (!esAudio) {
      const { error: uploadError } = await this.supabase
        .getClient()
        .storage.from(BUCKET)
        .upload(nombreArchivo, file.buffer, {
          contentType: mimeType,
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

    // 5. Guardar el gasto en el esquema nuevo (gastos + comprobante +
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
      monto: factura.total_factura || 0,
      fecha: factura.fecha,
      comprobante: esAudio
        ? null
        : {
          tipo: 'factura',
          numero: factura.n_factura || null,
          empresa_emisora: factura.empresa || null,
          subtotal: factura.subtotal,
          igv: factura.igv,
          total: factura.total_factura,
          fecha_documento: factura.fecha,
        },
      evidencia: esAudio
        ? null
        : {
          tipo: ext === 'pdf' ? 'pdf' : 'imagen',
          storage_path: nombreArchivo,
          origen: 'web',
        },
    });

    // 6. Respuesta con una forma compatible con la que devolvía el webhook
    //    de n8n (empresa, n_factura, fecha, subtotal, igv, total, items),
    //    más el id del gasto nuevo (útil para armar el mensaje de Telegram
    //    y para el flujo de "adjuntar comprobante después").
    return {
      success: true,
      mensaje: 'Gasto registrado correctamente',
      gasto_id: gasto.id,
      empresa: factura.empresa,
      n_factura: factura.n_factura,
      fecha: factura.fecha,
      subtotal: factura.subtotal,
      igv: factura.igv,
      total: factura.total_factura || 0,
      items: factura.items,
    };
  }

  // Reenvía cada archivo al Webhook de n8n (multipart/form-data, campo "data").
  // El workflow procesa la imagen/documento (OCR + IA) y guarda la fila en Supabase;
  // el frontend se entera del nuevo registro solo mediante Supabase Realtime.
  private async procesarArchivosConN8n(files: Array<Express.Multer.File>) {
    const resultados = await Promise.all(
      files.map(async (file) => {
        try {
          const resultado = await this.reenviarArchivoAN8n(file);
          return { archivo: file.originalname, ok: true, resultado };
        } catch (err) {
          return {
            archivo: file.originalname,
            ok: false,
            error: err.message || 'Error desconocido al enviar a n8n',
          };
        }
      }),
    );

    return { resultados };
  }

  // Reenvía UN archivo al webhook genérico de n8n y devuelve su respuesta ya
  // parseada. Público porque también lo usa TelegramService cuando el modo
  // global está en "n8n" (así el bot sigue usando n8n si así se elige,
  // aunque ya no reciba updates directamente de Telegram).
  async reenviarArchivoAN8n(file: ArchivoEntrada): Promise<any> {
    const webhookUrl = process.env.N8N_WEBHOOK_URL;
    if (!webhookUrl) {
      throw new InternalServerErrorException(
        'Falta configurar N8N_WEBHOOK_URL en las variables de entorno.',
      );
    }

    const bytes = new Uint8Array(file.buffer);
    const blob = new Blob([bytes], {
      type: file.mimetype || 'application/octet-stream',
    });
    const formData = new FormData();
    formData.append('data', blob, file.originalname);

    const res = await fetch(webhookUrl, { method: 'POST', body: formData });

    const contentType = res.headers.get('content-type') || '';
    const body = contentType.includes('application/json')
      ? await res.json()
      : await res.text();

    if (!res.ok) {
      throw new Error(typeof body === 'string' ? body : JSON.stringify(body));
    }

    return body;
  }
}