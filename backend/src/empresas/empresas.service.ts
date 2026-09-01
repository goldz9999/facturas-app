import { Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../common/supabase.service';
import { CrearEmpresaDto } from './dto/crear-empresa.dto';
import { ActualizarEmpresaDto } from './dto/actualizar-empresa.dto';

export interface Empresa {
    id: number;
    nombre: string;
    activa: boolean;
    creado_en: string;
}

// Fundación de multi-tenant (RF-23, sección 25 de requerimientos). Hoy solo
// existe una fila (el negocio actual), sembrada por la migración SQL
// (2026-08-29_crear_tabla_empresas_y_fk). Se implementa la entidad completa
// desde ahora, en vez de un valor fijo sin tabla, para no tener que migrar
// datos históricos el día que aparezca una segunda empresa real.
//
// Sin filtrado por RLS/tenant todavía: este servicio y el resto del backend
// no aíslan datos entre empresas distintas (no hace falta mientras solo
// exista una). Cuando se agregue una segunda empresa real, hay que revisar
// cada query de gastos/usuarios/etc. para que filtre por empresa_id del
// usuario autenticado -- ver Paso 16 en PROGRESO_SIREGG.md.
@Injectable()
export class EmpresasService {
    constructor(private supabase: SupabaseService) { }

    async listar(): Promise<Empresa[]> {
        const { data, error } = await this.supabase
            .getClient()
            .from('empresas')
            .select('*')
            .order('creado_en', { ascending: true });

        if (error) {
            throw new InternalServerErrorException(`Error listando empresas: ${error.message}`);
        }
        return data ?? [];
    }

    async obtenerPorId(id: number): Promise<Empresa> {
        const { data, error } = await this.supabase
            .getClient()
            .from('empresas')
            .select('*')
            .eq('id', id)
            .maybeSingle();

        if (error) {
            throw new InternalServerErrorException(`Error buscando la empresa: ${error.message}`);
        }
        if (!data) {
            throw new NotFoundException(`Empresa ${id} no encontrada`);
        }
        return data;
    }

    async crear(dto: CrearEmpresaDto): Promise<Empresa> {
        const { data, error } = await this.supabase
            .getClient()
            .from('empresas')
            .insert({
                nombre: dto.nombre,
                activa: dto.activa ?? true,
            })
            .select('*')
            .single();

        if (error) {
            throw new InternalServerErrorException(`Error creando la empresa: ${error.message}`);
        }
        return data;
    }

    async actualizar(id: number, dto: ActualizarEmpresaDto): Promise<Empresa> {
        const cambios: Partial<Pick<Empresa, 'nombre' | 'activa'>> = {};
        if (dto.nombre !== undefined) cambios.nombre = dto.nombre;
        if (dto.activa !== undefined) cambios.activa = dto.activa;

        const { data, error } = await this.supabase
            .getClient()
            .from('empresas')
            .update(cambios)
            .eq('id', id)
            .select('*')
            .maybeSingle();

        if (error) {
            throw new InternalServerErrorException(`Error actualizando la empresa: ${error.message}`);
        }
        if (!data) {
            throw new NotFoundException(`Empresa ${id} no encontrada`);
        }
        return data;
    }

    // Borrado real. Falla con un mensaje claro si la empresa todavía tiene
    // usuarios o gastos asociados (FK), en vez de un error crudo de Postgres.
    async eliminar(id: number): Promise<void> {
        const { error } = await this.supabase.getClient().from('empresas').delete().eq('id', id);

        if (error) {
            if (error.code === '23503') {
                throw new InternalServerErrorException(
                    'No se puede eliminar: la empresa todavía tiene usuarios o gastos asociados. Desactívala en vez de eliminarla.',
                );
            }
            throw new InternalServerErrorException(`Error eliminando la empresa: ${error.message}`);
        }
    }

    // Usado por UsuariosService cuando se crea un usuario sin empresa_id
    // explícito (caso normal hoy, mientras solo exista una empresa): en vez
    // de dejarlo en null, se asigna a la primera empresa registrada.
    // Cuando exista más de una empresa, quien llame a crear usuario deberá
    // indicar explícitamente el empresa_id -- este método deja de ser un
    // default seguro en cuanto listar() devuelva más de una fila, y quien lo
    // use debe manejar ese caso (ver UsuariosService.crear).
    async obtenerPorDefecto(): Promise<Empresa | null> {
        const { data, error } = await this.supabase
            .getClient()
            .from('empresas')
            .select('*')
            .order('id', { ascending: true })
            .limit(1)
            .maybeSingle();

        if (error) {
            throw new InternalServerErrorException(
                `Error buscando la empresa por defecto: ${error.message}`,
            );
        }
        return data;
    }
}