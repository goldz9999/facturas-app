import { ConflictException, Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../common/supabase.service';

export interface Categoria {
    id: number;
    nombre: string;
    empresa_id: number;
}

// Catálogo de categorías, por empresa desde la migración
// add_empresa_id_to_categorias. Antes era una lista fija global (Materia
// prima, Tela, Tinta, etc.) que el bot nunca podía modificar; ahora cada
// empresa administra su propio catálogo (CRUD real desde el panel web),
// y el bot sigue sin crear categorías por su cuenta -- solo las usa.
@Injectable()
export class CategoriasService {
    constructor(private supabase: SupabaseService) { }

    async listar(empresaId: number): Promise<Categoria[]> {
        const { data, error } = await this.supabase
            .getClient()
            .from('categorias')
            .select('id, nombre, empresa_id')
            .eq('empresa_id', empresaId)
            .order('nombre', { ascending: true });

        if (error) {
            throw new InternalServerErrorException(`Error listando categorías: ${error.message}`);
        }
        return data ?? [];
    }

    async crear(nombre: string, empresaId: number): Promise<Categoria> {
        const nombreNormalizado = nombre.trim();
        if (!nombreNormalizado) {
            throw new ConflictException('El nombre de la categoría no puede estar vacío.');
        }

        const { data, error } = await this.supabase
            .getClient()
            .from('categorias')
            .insert({ nombre: nombreNormalizado, empresa_id: empresaId })
            .select('id, nombre, empresa_id')
            .single();

        if (error) {
            // Código 23505 = unique_violation (categorias_nombre_empresa_unq).
            if (error.code === '23505') {
                throw new ConflictException(`Ya existe una categoría llamada "${nombreNormalizado}".`);
            }
            throw new InternalServerErrorException(`Error creando categoría: ${error.message}`);
        }
        return data;
    }

    async actualizar(id: number, nombre: string, empresaId: number): Promise<Categoria> {
        const nombreNormalizado = nombre.trim();
        if (!nombreNormalizado) {
            throw new ConflictException('El nombre de la categoría no puede estar vacío.');
        }

        const { data, error } = await this.supabase
            .getClient()
            .from('categorias')
            .update({ nombre: nombreNormalizado })
            .eq('id', id)
            .eq('empresa_id', empresaId) // nunca editar una categoría de otra empresa
            .select('id, nombre, empresa_id')
            .maybeSingle();

        if (error) {
            if (error.code === '23505') {
                throw new ConflictException(`Ya existe una categoría llamada "${nombreNormalizado}".`);
            }
            throw new InternalServerErrorException(`Error actualizando categoría: ${error.message}`);
        }
        if (!data) {
            throw new NotFoundException(`Categoría ${id} no encontrada`);
        }
        return data;
    }

    async eliminar(id: number, empresaId: number): Promise<void> {
        // gastos.categoria_id y proveedores.categoria_id_sugerida no tienen
        // ON DELETE CASCADE (a propósito -- borrar una categoría no debe
        // borrar gastos históricos). Si está en uso, Postgres devuelve un
        // error de foreign key (23503); se traduce a un mensaje claro en
        // vez de un 500 genérico.
        const { error, count } = await this.supabase
            .getClient()
            .from('categorias')
            .delete({ count: 'exact' })
            .eq('id', id)
            .eq('empresa_id', empresaId);

        if (error) {
            if (error.code === '23503') {
                throw new ConflictException(
                    'No se puede eliminar: hay gastos o proveedores usando esta categoría.',
                );
            }
            throw new InternalServerErrorException(`Error eliminando categoría: ${error.message}`);
        }
        if (!count) {
            throw new NotFoundException(`Categoría ${id} no encontrada`);
        }
    }
}