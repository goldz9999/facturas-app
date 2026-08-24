import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post } from '@nestjs/common';
import { UsuariosService } from './usuarios.service';
import { CrearUsuarioDto } from './dto/crear-usuario.dto';

@Controller('usuarios')
export class UsuariosController {
    constructor(private usuariosService: UsuariosService) { }

    @Get()
    listar() {
        return this.usuariosService.listar();
    }

    @Post()
    crear(@Body() dto: CrearUsuarioDto) {
        return this.usuariosService.crear(dto);
    }

    @Patch(':id/desactivar')
    desactivar(@Param('id', ParseIntPipe) id: number) {
        return this.usuariosService.desactivar(id);
    }
}