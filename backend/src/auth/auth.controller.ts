import { Body, Controller, HttpCode, HttpStatus, Patch, Post, UseGuards, Request } from '@nestjs/common';
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
}