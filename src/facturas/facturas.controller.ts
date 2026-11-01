import {
  BadRequestException,
  Controller,
  Post,
  Request,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { FacturasService } from './facturas.service';

@UseGuards(JwtAuthGuard)
@Controller('facturas')
export class FacturasController {
  constructor(private readonly facturasService: FacturasService) { }

  // S1: endpoint ahora requiere JWT. usuario_id se toma del token, no del
  // query string, para que nadie pueda crear gastos a nombre de otro usuario.
  @Post('upload')
  @UseInterceptors(
    FilesInterceptor('files', 10, {
      limits: { fileSize: 15 * 1024 * 1024 }, // 15MB por archivo
    }),
  )
  async upload(
    @UploadedFiles() files: Array<Express.Multer.File>,
    @Request() req: any,
  ) {
    if (!files || files.length === 0) {
      throw new BadRequestException('No se recibió ningún archivo.');
    }
    return this.facturasService.procesarArchivos(files, req.user.id);
  }

  // El webhook de Telegram (POST /facturas/telegram/webhook) vive ahora en
  // TelegramController (src/telegram/telegram.controller.ts) para evitar una
  // dependencia circular entre FacturasModule y TelegramModule. La URL
  // pública no cambia: sigue siendo /facturas/telegram/webhook.
}
