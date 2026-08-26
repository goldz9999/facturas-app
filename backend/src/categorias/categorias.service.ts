import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { SupabaseService } from '../common/supabase.service';

export interface Categoria {
    id: number;
    nombre: string;
}

// Las categorías son una lista fija (sección 8 de requerimientos: Materia
// prima, Tela, Tinta, Papel, Herramientas, Transporte, Servicios,
// Alimentación, Administración, Otros). El bot NUNCA crea categorías
// nuevas por su cuenta — si falta alguna, se agrega a mano en Supabase.
@Injectable()
export class CategoriasService {
    constructor(private supabase: SupabaseService) { }

    async listar(): Promise<Categoria[]> {
        const { data, error } = await this.supabase
            .getClient()
            .from('categorias')
            .select('id, nombre')
            .order('nombre', { ascending: true });

        if (error) {
            throw new InternalServerErrorException(`Error listando categorías: ${error.message}`);
        }
        return data ?? [];
    }
}