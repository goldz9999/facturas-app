import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { SupabaseService } from '../common/supabase.service';

export interface Proveedor {
    id: number;
    nombre: string;
    categoria_id_sugerida: number | null;
    es_personal_sugerido: boolean | null;
}

// A diferencia de las categorías (lista fija), los proveedores SÍ se crean
// dinámicamente: no hay riesgo real de "duplicado semántico" como con
// categorías (no hay forma ambigua de escribir "Textiles Pérez" que se
// confunda con una categoría distinta), y proveedores nuevos aparecen todo
// el tiempo en el uso normal del negocio.
//
// El aprendizaje (sección 9 de requerimientos) vive en dos columnas nuevas
// de `proveedores`: categoria_id_sugerida y es_personal_sugerido. La
// primera vez que aparece un proveedor no hay sugerencia (quedan null) y el
// bot pregunta; la respuesta (o cualquier corrección posterior) se guarda
// ahí para la próxima vez.
@Injectable()
export class ProveedoresService {
    constructor(private supabase: SupabaseService) { }

    // Busca un proveedor por nombre (normalizado) o lo crea si no existe.
    // Normalización simple: trim + minúsculas, para que "Textiles Pérez" y
    // "textiles pérez " no generen dos filas distintas. No se intenta un
    // match difuso (fuzzy) todavía — si hace falta más adelante (variantes
    // con errores de tipeo, RUC, etc.), se puede sumar sin romper esta firma.
    async buscarOCrear(nombreCrudo: string): Promise<Proveedor> {
        const client = this.supabase.getClient();
        const nombreNormalizado = nombreCrudo.trim();

        const { data: existente, error: errorBusqueda } = await client
            .from('proveedores')
            .select('id, nombre, categoria_id_sugerida, es_personal_sugerido')
            .ilike('nombre', nombreNormalizado)
            .maybeSingle();

        if (errorBusqueda) {
            throw new InternalServerErrorException(
                `Error buscando proveedor: ${errorBusqueda.message}`,
            );
        }
        if (existente) return existente;

        const { data: creado, error: errorCreacion } = await client
            .from('proveedores')
            .insert({ nombre: nombreNormalizado })
            .select('id, nombre, categoria_id_sugerida, es_personal_sugerido')
            .single();

        if (errorCreacion) {
            throw new InternalServerErrorException(
                `Error creando proveedor: ${errorCreacion.message}`,
            );
        }
        return creado;
    }

    // Guarda (o actualiza) la sugerencia de clasificación de un proveedor.
    // Se llama tanto la primera vez que el usuario responde a la pregunta
    // de categoría, como cada vez que corrige una clasificación existente
    // — las correcciones deben alimentar futuras sugerencias (sección 9).
    async guardarSugerencia(
        proveedorId: number,
        categoriaId: number,
        esPersonal: boolean,
    ): Promise<void> {
        const { error } = await this.supabase
            .getClient()
            .from('proveedores')
            .update({
                categoria_id_sugerida: categoriaId,
                es_personal_sugerido: esPersonal,
            })
            .eq('id', proveedorId);

        if (error) {
            throw new InternalServerErrorException(
                `Error guardando sugerencia de proveedor: ${error.message}`,
            );
        }
    }
}