import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { SupabaseService } from '../common/supabase.service';

export interface Proveedor {
    id: number;
    nombre: string;
    ruc: string | null;
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

    // Busca un proveedor por RUC (si viene y es confiable) o por nombre
    // normalizado, o lo crea si no existe. El RUC es preferible porque es un
    // identificador exacto: evita que "Textiles Pérez S.A.C." y "TEXTILES
    // PEREZ SAC" (mismo RUC, texto distinto) generen dos filas separadas.
    // Si el RUC no vino en esta factura (frecuente: no siempre es legible),
    // se cae al match por nombre como hasta ahora.
    async buscarOCrear(nombreCrudo: string, ruc?: string | null): Promise<Proveedor> {
        const client = this.supabase.getClient();
        const nombreNormalizado = nombreCrudo.trim();
        const rucNormalizado = ruc?.trim() || null;
        const columnas = 'id, nombre, ruc, categoria_id_sugerida, es_personal_sugerido';

        if (rucNormalizado) {
            const { data: porRuc, error: errorPorRuc } = await client
                .from('proveedores')
                .select(columnas)
                .eq('ruc', rucNormalizado)
                .maybeSingle();

            if (errorPorRuc) {
                throw new InternalServerErrorException(
                    `Error buscando proveedor por RUC: ${errorPorRuc.message}`,
                );
            }
            if (porRuc) {
                // Ya existía con este RUC. Si antes se había creado sin RUC
                // (match por nombre) esto no debería pasar porque acabamos
                // de buscar por RUC exacto, así que no hace falta actualizar
                // nada más aquí.
                return porRuc as any;
            }
        }

        const { data: existente, error: errorBusqueda } = await client
            .from('proveedores')
            .select(columnas)
            .ilike('nombre', nombreNormalizado)
            .maybeSingle();

        if (errorBusqueda) {
            throw new InternalServerErrorException(
                `Error buscando proveedor: ${errorBusqueda.message}`,
            );
        }
        if (existente) {
            // Proveedor ya existía por nombre pero todavía no tenía RUC
            // guardado (ej. se creó una vez con una foto donde no se leía) y
            // esta vez sí lo pudimos leer: lo completamos para que la
            // próxima búsqueda ya pueda usar el match exacto por RUC.
            if (rucNormalizado && !(existente as any).ruc) {
                const { error: errorUpdate } = await client
                    .from('proveedores')
                    .update({ ruc: rucNormalizado })
                    .eq('id', (existente as any).id);
                if (errorUpdate) {
                    throw new InternalServerErrorException(
                        `Error completando RUC de proveedor: ${errorUpdate.message}`,
                    );
                }
                return { ...(existente as any), ruc: rucNormalizado };
            }
            return existente as any;
        }

        const { data: creado, error: errorCreacion } = await client
            .from('proveedores')
            .insert({ nombre: nombreNormalizado, ruc: rucNormalizado })
            .select(columnas)
            .single();

        if (errorCreacion) {
            throw new InternalServerErrorException(
                `Error creando proveedor: ${errorCreacion.message}`,
            );
        }
        return creado as any;
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