import {
  BadRequestException,
  Controller,
  Post,
  Query,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { FacturasService } from './facturas.service';

@Controller('facturas')
export class FacturasController {
  constructor(private readonly facturasService: FacturasService) { }

  // GET /facturas (findAll) se eliminó: consultaba la tabla vieja
  // `facturas`/`factura_items`, previa a la migración al esquema
  // gastos/comprobantes/pagos/evidencias. Confirmado contra Supabase real
  // (proyecto Registrodefacturasn8n): ambas tablas están en 0 filas y
  // ningún flujo activo (Telegram ni /facturas/upload) escribe en ellas.
  // La fuente de verdad de gastos hoy es GET /gastos/:id y
  // GET /gastos/usuario/:usuarioId/ultimos (ver GastosController).

  // Recibe uno o varios archivos (imágenes o documentos) desde el frontend.
  // "usuario_id" es obligatorio: todo gasto queda vinculado al usuario que
  // lo subió.
  @Post('upload')
  @UseInterceptors(
    FilesInterceptor('files', 10, {
      limits: { fileSize: 15 * 1024 * 1024 }, // 15MB por archivo
    }),
  )
  async upload(
    @UploadedFiles() files: Array<Express.Multer.File>,
    @Query('usuario_id') usuarioId?: string,
  ) {
    if (!files || files.length === 0) {
      throw new BadRequestException('No se recibió ningún archivo.');
    }
    if (!usuarioId) {
      throw new BadRequestException('usuario_id es obligatorio.');
    }
    return this.facturasService.procesarArchivos(files, Number(usuarioId));
  }

  // El webhook de Telegram (POST /facturas/telegram/webhook) vive ahora en
  // TelegramController (src/telegram/telegram.controller.ts) para evitar una
  // dependencia circular entre FacturasModule y TelegramModule. La URL
  // pública no cambia: sigue siendo /facturas/telegram/webhook.
}