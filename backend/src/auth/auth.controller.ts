import { Body, Controller, Delete, HttpCode, HttpStatus, Patch, Post, UploadedFile, UseGuards, UseInterceptors, Request } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ActualizarPerfilDto } from './dto/actualizar-perfil.dto';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { EmpresaActivaDto } from './dto/empresa-activa.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

@Controller('auth')
export class AuthController {
    constructor(private authService: AuthService) { }

    @Post('login')
    @HttpCode(HttpStatus.OK)
    login(@Body() dto: LoginDto) {
        return this.authService.login(dto);
    }

    @UseGuards(JwtAuthGuard)
    @Post('me')
    @HttpCode(HttpStatus.OK)
    me(@Request() req) {
        return req.user;
    }

    // Recuerda la empresa activa del usuario en la base (no solo en el
    // navegador), para que lo siga entre dispositivos.
    @UseGuards(JwtAuthGuard)
    @Patch('empresa-activa')
    empresaActiva(@Body() dto: EmpresaActivaDto, @Request() req) {
        return this.authService.establecerEmpresaActiva(req.user, dto.empresa_id);
    }

    // Configuración personal: siempre sobre el propio usuario (req.user.id),
    // nunca sobre un id del body o la URL.
    @UseGuards(JwtAuthGuard)
    @Patch('perfil')
    actualizarPerfil(@Body() dto: ActualizarPerfilDto, @Request() req) {
        return this.authService.actualizarPerfil(req.user.id, dto);
    }

    @UseGuards(JwtAuthGuard)
    @Patch('perfil/avatar')
    @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 2 * 1024 * 1024 } })) // 2MB
    subirAvatar(@UploadedFile() file: Express.Multer.File, @Request() req) {
        return this.authService.subirAvatar(req.user.id, file);
    }

    @UseGuards(JwtAuthGuard)
    @Delete('perfil/avatar')
    quitarAvatar(@Request() req) {
        return this.authService.quitarAvatar(req.user.id);
    }
}
