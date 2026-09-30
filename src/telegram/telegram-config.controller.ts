import { Body, Controller, Delete, Get, Put, UseGuards } from '@nestjs/common';
import { IsString } from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesEmpresaGuard } from '../auth/guards/roles-empresa.guard';
import { RolesEmpresa } from '../auth/decorators/roles-empresa.decorator';
import { TelegramConfigService } from './telegram-config.service';

class ConectarWebhookDto {
    @IsString()
    base_url: string;
}

// El bot es uno solo para toda la plataforma: solo el propietario lo reconecta.
@UseGuards(JwtAuthGuard, RolesEmpresaGuard)
@RolesEmpresa('propietario')
@Controller('telegram/config')
export class TelegramConfigController {
    constructor(private telegramConfig: TelegramConfigService) { }

    @Get()
    estado() {
        return this.telegramConfig.estado();
    }

    @Put('webhook')
    conectar(@Body() dto: ConectarWebhookDto) {
        return this.telegramConfig.conectar(dto.base_url);
    }

    @Delete('webhook')
    desconectar() {
        return this.telegramConfig.desconectar();
    }
}
