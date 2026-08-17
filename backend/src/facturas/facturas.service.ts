import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { SupabaseService } from './supabase.service';

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
  constructor(private supabase: SupabaseService) { }

  async findAll(params: FindFacturasParams) {
    const page = params.page && params.page > 0 ? params.page : 1;
    const pageSize = params.pageSize && params.pageSize > 0 ? params.pageSize : 20;
    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    let query = this.supabase
      .getClient()
      .from('tabla_2')
      .select('*', { count: 'exact' })
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
  // Reenvía cada archivo al Webhook de n8n (multipart/form-data, campo "data").
  // El workflow procesa la imagen/documento (OCR + IA) y guarda la fila en Supabase;
  // el frontend se entera del nuevo registro solo mediante Supabase Realtime.
  async procesarArchivos(files: Array<Express.Multer.File>) {
    const webhookUrl = process.env.N8N_WEBHOOK_URL;
    if (!webhookUrl) {
      throw new InternalServerErrorException(
        'Falta configurar N8N_WEBHOOK_URL en las variables de entorno.',
      );
    }

    const resultados = await Promise.all(
      files.map(async (file) => {
        try {
          const formData = new FormData();
          const bytes = new Uint8Array(file.buffer);
          const blob = new Blob([bytes], {
            type: file.mimetype || 'application/octet-stream',
          });
          formData.append('data', blob, file.originalname);

          const res = await fetch(webhookUrl, {
            method: 'POST',
            body: formData,
          });

          const contentType = res.headers.get('content-type') || '';
          const body = contentType.includes('application/json')
            ? await res.json()
            : await res.text();

          if (!res.ok) {
            return {
              archivo: file.originalname,
              ok: false,
              error: typeof body === 'string' ? body : JSON.stringify(body),
            };
          }

          return { archivo: file.originalname, ok: true, resultado: body };
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
}