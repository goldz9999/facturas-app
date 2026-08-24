import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { SupabaseService } from '../common/supabase.service';
import { GeminiService } from '../ia/gemini.service';
import { normalizarFactura } from './facturas-normalizer';
import { ModoProcesamiento } from './modo.service';

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
  async procesarArchivos(
    files: Array<Express.Multer.File>,
    modo: ModoProcesamiento = 'n8n',
  ) {
    if (modo === 'backend') {
      return this.procesarArchivosEnBackend(files);
    }
    return this.procesarArchivosConN8n(files);
  }

  // Reemplaza todo el workflow de n8n: sube la imagen a Supabase Storage,
  // transcribe con Gemini, extrae los datos estructurados y guarda
  // factura + items en la base de datos.
  private async procesarArchivosEnBackend(files: Array<Express.Multer.File>) {
    const resultados = await Promise.all(
      files.map(async (file) => {
        try {
          const resultado = await this.procesarArchivoIndividual(file);
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

  // Pipeline completo (subir a Storage + Gemini + guardar en Supabase).
  // Público porque también lo usa TelegramService para procesar audios/fotos/
  // documentos recibidos por el bot, sin pasar por n8n.
  async procesarArchivoIndividual(file: ArchivoEntrada) {
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

    // 3. Extraer datos estructurados con Gemini
    const datosExtraidos = await this.gemini.extraerFactura(texto);

    // 4. Normalizar (fecha, items) igual que "Separar articulos1"
    const factura = normalizarFactura(datosExtraidos);

    // 5. Insertar factura
    const { data: facturaInsertada, error: errorFactura } = await this.supabase
      .getClient()
      .from('facturas')
      .insert({
        fecha: factura.fecha,
        empresa: factura.empresa,
        n_factura: factura.n_factura,
        subtotal: factura.subtotal || 0,
        igv: factura.igv || 0,
        total_factura: factura.total_factura || 0,
        imagen_url: esAudio ? null : nombreArchivo,
      })
      .select()
      .single();

    if (errorFactura) {
      throw new InternalServerErrorException(
        `Error guardando la factura: ${errorFactura.message}`,
      );
    }

    // 6. Insertar items
    let itemsInsertados = 0;
    if (factura.items.length > 0) {
      const { error: errorItems } = await this.supabase
        .getClient()
        .from('factura_items')
        .insert(
          factura.items.map((item) => ({
            factura_id: facturaInsertada.id,
            producto: item.producto,
            cantidad: item.cantidad,
            costo: item.costo,
          })),
        );
      if (errorItems) {
        throw new InternalServerErrorException(
          `Error guardando los items: ${errorItems.message}`,
        );
      }
      itemsInsertados = factura.items.length;
    }

    // 7. Respuesta con la misma forma que devolvía el webhook de n8n,
    //    más el detalle de items (útil para armar el mensaje de Telegram).
    return {
      success: true,
      mensaje: 'Factura procesada correctamente',
      factura_id: facturaInsertada.id,
      empresa: factura.empresa,
      n_factura: factura.n_factura,
      fecha: factura.fecha,
      subtotal: factura.subtotal,
      igv: factura.igv,
      total: factura.total_factura || 0,
      items_insertados: itemsInsertados,
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