import { Body, Controller, Get, Param, ParseIntPipe, Post } from '@nestjs/common';
import { EmpresasService } from './empresas.service';
import { CrearEmpresaDto } from './dto/crear-empresa.dto';

// Endpoints mínimos para gestionar empresas mientras no existe un frontend
// propio (el nuevo se construye en otro repositorio). Pensado para probarse
// por Swagger/Postman en esta etapa.
@Controller('empresas')
export class EmpresasController {
    constructor(private empresasService: EmpresasService) { }

    @Get()
    listar() {
        return this.empresasService.listar();
    }

    @Get(':id')
    obtenerPorId(@Param('id', ParseIntPipe) id: number) {
        return this.empresasService.obtenerPorId(id);
    }

    @Post()
    crear(@Body() dto: CrearEmpresaDto) {
        return this.empresasService.crear(dto);
    }
}
