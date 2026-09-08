import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { SupabaseService } from '../common/supabase.service';

export interface Proveedor {
    id: number;
    nombre: string;
    ruc: string | null;
    categoria_id_sugerida: number | null;
    es_personal_sugerido: boolean | null;
    empresa_id: number;
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
//
// Multiempresa (fix del gap documentado en el informe de avance): el
// catálogo de proveedores es por empresa desde la migración
// add_empresa_id_to_proveedores. Antes, dos empresas distintas veían y
// reutilizaban el mismo proveedor/RUC como si fueran una sola.
@Injectable()
export class ProveedoresService {
    constructor(private supabase: SupabaseService) { }

    // Busca un proveedor por RUC (si viene y es confiable) o por nombre
    // normalizado, o lo crea si no existe. El RUC es preferible porque es un
    // identificador exacto: evita que "Textiles Pérez S.A.C." y "TEXTILES
    // PEREZ SAC" (mismo RUC, texto distinto) generen dos filas separadas.
    // Si el RUC no vino en esta factura (frecuente: no siempre es legible),
    // se cae al match por nombre como hasta ahora.
    //
    // empresaId es obligatorio: el matching (por RUC o por nombre) nunca
    // debe cruzar empresas, o una empresa vería/reutilizaría el proveedor
    // (y su categoría sugerida) de otra.
    async buscarOCrear(nombreCrudo: string, ruc: string | null | undefined, empresaId: number): Promise<Proveedor> {
        const client = this.supabase.getClient();
        const nombreNormalizado = nombreCrudo.trim();
        const rucNormalizado = ruc?.trim() || null;
        const columnas = 'id, nombre, ruc, categoria_id_sugerida, es_personal_sugerido, empresa_id';

        if (rucNormalizado) {
            const { data: porRuc, error: errorPorRuc } = await client
                .from('proveedores')
                .select(columnas)
                .eq('ruc', rucNormalizado)
                .eq('empresa_id', empresaId)
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
            .eq('empresa_id', empresaId)
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
                    .eq('id', (existente as any).id)
                    .eq('empresa_id', empresaId);
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
            .insert({ nombre: nombreNormalizado, ruc: rucNormalizado, empresa_id: empresaId })
            .select(columnas)
            .single();

        if (errorCreacion) {
            throw new InternalServerErrorException(
                `Error creando proveedor: ${errorCreacion.message}`,
            );
        }
        return creado as any;
    }

    // Lista de proveedores de una empresa para el panel (ProviderList.jsx /
    // ProviderDetail.jsx). A diferencia de buscarOCrear/guardarSugerencia
    // (llamados desde el flujo de Telegram con un proveedor puntual), acá se
    // agregan también las estadísticas de uso (cuántos gastos y la fecha del
    // último) porque el frontend las necesita para mostrar la lista y no
    // tiene otra forma de calcularlas.
    async listar(empresaId: number): Promise<Array<Proveedor & { veces_usado: number; ultimo_uso: string | null; categoria_sugerida_nombre: string | null }>> {
        const client = this.supabase.getClient();

        const { data: proveedores, error } = await client
            .from('proveedores')
            .select('id, nombre, ruc, categoria_id_sugerida, es_personal_sugerido, empresa_id')
            .eq('empresa_id', empresaId)
            .order('nombre', { ascending: true });

        if (error) {
            throw new InternalServerErrorException(`Error listando proveedores: ${error.message}`);
        }
        if (!proveedores || proveedores.length === 0) return [];

        // Uso (conteo + última fecha) calculado sobre `gastos` en vez de
        // guardarlo desnormalizado en `proveedores` -- se recalcula siempre
        // fresco y evita otra columna que mantener sincronizada.
        const { data: gastos, error: errorGastos } = await client
            .from('gastos')
            .select('proveedor_id, fecha')
            .eq('empresa_id', empresaId)
            .in('proveedor_id', proveedores.map((p) => p.id));

        if (errorGastos) {
            throw new InternalServerErrorException(`Error calculando uso de proveedores: ${errorGastos.message}`);
        }

        const usoPorProveedor = new Map<number, { veces: number; ultima: string | null }>();
        for (const g of gastos ?? []) {
            if (!g.proveedor_id) continue;
            const actual = usoPorProveedor.get(g.proveedor_id) ?? { veces: 0, ultima: null };
            actual.veces += 1;
            if (g.fecha && (!actual.ultima || g.fecha > actual.ultima)) actual.ultima = g.fecha;
            usoPorProveedor.set(g.proveedor_id, actual);
        }

        const idsCategoriaSugerida = [...new Set(proveedores.map((p) => p.categoria_id_sugerida).filter((id): id is number => id != null))];
        const nombresCategoria = new Map<number, string>();
        if (idsCategoriaSugerida.length > 0) {
            const { data: categorias, error: errorCategorias } = await client
                .from('categorias')
                .select('id, nombre')
                .in('id', idsCategoriaSugerida);
            if (errorCategorias) {
                throw new InternalServerErrorException(`Error resolviendo categorías sugeridas: ${errorCategorias.message}`);
            }
            for (const c of categorias ?? []) nombresCategoria.set(c.id, c.nombre);
        }

        return proveedores.map((p) => ({
            ...(p as any),
            veces_usado: usoPorProveedor.get(p.id)?.veces ?? 0,
            ultimo_uso: usoPorProveedor.get(p.id)?.ultima ?? null,
            categoria_sugerida_nombre: p.categoria_id_sugerida ? nombresCategoria.get(p.categoria_id_sugerida) ?? null : null,
        }));
    }

    // Guarda (o actualiza) la sugerencia de clasificación de un proveedor.
    // Se llama tanto la primera vez que el usuario responde a la pregunta
    // de categoría, como cada vez que corrige una clasificación existente
    // — las correcciones deben alimentar futuras sugerencias (sección 9).
    //
    // empresaId opcional por compatibilidad con llamadores que todavía no
    // lo resuelven explícitamente; cuando viene, es una defensa extra para
    // no actualizar por error un proveedor de otra empresa.
    async guardarSugerencia(
        proveedorId: number,
        categoriaId: number,
        esPersonal: boolean,
        empresaId?: number | null,
    ): Promise<void> {
        let query = this.supabase
            .getClient()
            .from('proveedores')
            .update({
                categoria_id_sugerida: categoriaId,
                es_personal_sugerido: esPersonal,
            })
            .eq('id', proveedorId);

        if (empresaId !== undefined && empresaId !== null) {
            query = query.eq('empresa_id', empresaId);
        }

        const { error } = await query;

        if (error) {
            throw new InternalServerErrorException(
                `Error guardando sugerencia de proveedor: ${error.message}`,
            );
        }
    }
}