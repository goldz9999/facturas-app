import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { FacturasService, ModoProcesamiento } from './facturas.service';
import { ModoService } from './modo.service';

@Controller('facturas')
export class FacturasController {
  constructor(
    private readonly facturasService: FacturasService,
    private readonly modoService: ModoService,
  ) { }

  // Modo global de procesamiento (n8n | backend). Lo usan por igual el
  // upload web y el webhook de Telegram, así el switch del frontend
  // controla ambos canales desde un solo lugar.
  @Get('modo')
  async getModo() {
    return { modo: await this.modoService.getModo() };
  }

  @Post('modo')
  async setModo(@Body('modo') modo: ModoProcesamiento) {
    if (modo !== 'n8n' && modo !== 'backend') {
      throw new BadRequestException('El modo debe ser "n8n" o "backend".');
    }
    return { modo: await this.modoService.setModo(modo) };
  }

  @Get()
  async findAll(
    @Query('empresa') empresa?: string,
    @Query('n_factura') n_factura?: string,
    @Query('desde') desde?: string,
    @Query('hasta') hasta?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.facturasService.findAll({
      empresa,
      n_factura,
      desde,
      hasta,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  // Recibe uno o varios archivos (imágenes o documentos) desde el frontend.
  // "modo" (opcional) permite forzar el modo para esta subida puntual;
  // si no se manda, se usa el modo global configurado con /facturas/modo.
  @Post('upload')
  @UseInterceptors(
    FilesInterceptor('files', 10, {
      limits: { fileSize: 15 * 1024 * 1024 }, // 15MB por archivo
    }),
  )
  async upload(
    @UploadedFiles() files: Array<Express.Multer.File>,
    @Query('modo') modo?: ModoProcesamiento,
  ) {
    if (!files || files.length === 0) {
      throw new BadRequestException('No se recibió ningún archivo.');
    }
    const modoAUsar = modo || (await this.modoService.getModo());
    return this.facturasService.procesarArchivos(files, modoAUsar);
  }

  // El webhook de Telegram (POST /facturas/telegram/webhook) vive ahora en
  // TelegramController (src/telegram/telegram.controller.ts) para evitar una
  // dependencia circular entre FacturasModule y TelegramModule. La URL
  // pública no cambia: sigue siendo /facturas/telegram/webhook.
}