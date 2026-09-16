import { ConflictException, Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../common/supabase.service';

// Estados posibles de un pedido. 'activo' es el único que se ofrece como
// opción de asociación en Telegram (ver PedidosService.listarActivos):
// asociar un gasto nuevo a un pedido ya finalizado o cancelado casi
// siempre es un error de dedo del usuario. Desde el panel web SÍ se puede
// asociar a cualquier estado, porque ahí el caso de uso es corregir a
// mano un gasto viejo (ver nota en PROGRESO_SIREGG, Paso 36).
export type EstadoPedido = 'activo' | 'finalizado' | 'cancelado';

export const ESTADOS_PEDIDO: EstadoPedido[] = ['activo', 'finalizado', 'cancelado'];

export interface Pedido {
    id: number;
    empresa_id: number;
    nombre: string;
    cliente: string | null;
    presupuesto: number | null;
    estado: EstadoPedido;
    creado_en: string;
}

export interface PedidoConResumen extends Pedido {
    cantidad_gastos: number;
    total_gastado: number;
}

// Pedidos/proyectos (RF-11, §8 centro de costo / §12 consolidación de
// costos). Mismo patrón que CategoriasService: catálogo por empresa, con
// el `empresa_id` resuelto por el controller (resolver-empresa.util) y
// aplicado como filtro en TODAS las queries -- nunca se busca un pedido
// solo por id sin acotar la empresa (ver §29 del pedido de trabajo: un
// `pedido_id` manipulado a mano no debe poder cruzar empresas).
@Injectable()
export class PedidosService {
    constructor(private supabase: SupabaseService) { }

    private readonly COLUMNAS = 'id, empresa_id, nombre, cliente, presupuesto, estado, creado_en';

    // Listado con costo consolidado de cada pedido. El SUM se hace acá (no
    // en React) trayendo los montos de los gastos de esos pedidos en una
    // sola query y agregando en memoria -- al volumen actual es más simple
    // que una vista o un RPC, mismo criterio que GastosService.resumen().
    async listar(empresaId: number): Promise<PedidoConResumen[]> {
        const { data, error } = await this.supabase
            .getClient()
            .from('pedidos')
            .select(this.COLUMNAS)
            .eq('empresa_id', empresaId)
            .order('creado_en', { ascending: false });

        if (error) {
            throw new InternalServerErrorException(`Error listando pedidos: ${error.message}`);
        }
        const pedidos = (data ?? []) as Pedido[];
        if (pedidos.length === 0) return [];

        const totales = await this.totalesPorPedido(
            pedidos.map((p) => p.id),
            empresaId,
        );
        return pedidos.map((p) => ({
            ...p,
            cantidad_gastos: totales.get(p.id)?.cantidad ?? 0,
            total_gastado: totales.get(p.id)?.total ?? 0,
        }));
    }

    // Solo los pedidos que pueden recibir gastos nuevos. Lo usa Telegram
    // para armar los botones de selección de pedido.
    async listarActivos(empresaId: number): Promise<Pedido[]> {
        const { data, error } = await this.supabase
            .getClient()
            .from('pedidos')
            .select(this.COLUMNAS)
            .eq('empresa_id', empresaId)
            .eq('estado', 'activo')
            .order('creado_en', { ascending: false });

        if (error) {
            throw new InternalServerErrorException(`Error listando pedidos activos: ${error.message}`);
        }
        return (data ?? []) as Pedido[];
    }

    async obtenerPorId(id: number, empresaId: number): Promise<PedidoConResumen> {
        const { data, error } = await this.supabase
            .getClient()
            .from('pedidos')
            .select(this.COLUMNAS)
            .eq('id', id)
            .eq('empresa_id', empresaId) // 404, no 403: no confirmamos que el id exista en otra empresa
            .maybeSingle();

        if (error) {
            throw new InternalServerErrorException(`Error buscando el pedido: ${error.message}`);
        }
        if (!data) {
            throw new NotFoundException(`Pedido ${id} no encontrado`);
        }

        const totales = await this.totalesPorPedido([id], empresaId);
        return {
            ...(data as Pedido),
            cantidad_gastos: totales.get(id)?.cantidad ?? 0,
            total_gastado: totales.get(id)?.total ?? 0,
        };
    }

    // Resuelve un nombre de pedido (ej. el que Gemini leyó de "compré
    // tinta para el pedido Dragon") a un pedido real de la empresa.
    // Deliberadamente NO devuelve un id suelto: devuelve las coincidencias
    // para que el llamador decida. Si hay más de una ("Dragon", "Dragon
    // 2026"), el bot debe preguntar en vez de elegir por su cuenta (§19/§20
    // del pedido de trabajo: la IA nunca determina el id, solo propone un
    // nombre; el id siempre sale de la base de datos).
    async buscarPorNombre(nombre: string, empresaId: number): Promise<Pedido[]> {
        const termino = (nombre ?? '').trim();
        if (!termino) return [];

        const { data, error } = await this.supabase
            .getClient()
            .from('pedidos')
            .select(this.COLUMNAS)
            .eq('empresa_id', empresaId)
            .eq('estado', 'activo')
            .ilike('nombre', `%${termino}%`);

        if (error) {
            throw new InternalServerErrorException(`Error buscando el pedido por nombre: ${error.message}`);
        }
        const coincidencias = (data ?? []) as Pedido[];

        // Un match exacto (case-insensitive) gana sobre los parciales: si
        // existen "Dragon" y "Dragon 2026" y el usuario dijo exactamente
        // "Dragon", no hay ambigüedad real que preguntar.
        const exactas = coincidencias.filter(
            (p) => p.nombre.trim().toLowerCase() === termino.toLowerCase(),
        );
        return exactas.length > 0 ? exactas : coincidencias;
    }

    async crear(
        datos: { nombre: string; cliente?: string | null; presupuesto?: number | null; estado?: EstadoPedido },
        empresaId: number,
    ): Promise<Pedido> {
        const nombre = (datos.nombre ?? '').trim();
        if (!nombre) {
            throw new ConflictException('El nombre del pedido no puede estar vacío.');
        }

        const { data, error } = await this.supabase
            .getClient()
            .from('pedidos')
            .insert({
                empresa_id: empresaId,
                nombre,
                cliente: datos.cliente?.trim() || null,
                presupuesto: datos.presupuesto ?? null,
                estado: datos.estado ?? 'activo',
            })
            .select(this.COLUMNAS)
            .single();

        if (error) {
            if (error.code === '23505') {
                throw new ConflictException(`Ya existe un pedido llamado "${nombre}".`);
            }
            throw new InternalServerErrorException(`Error creando pedido: ${error.message}`);
        }
        return data as Pedido;
    }

    async actualizar(
        id: number,
        cambios: Partial<{ nombre: string; cliente: string | null; presupuesto: number | null; estado: EstadoPedido }>,
        empresaId: number,
    ): Promise<Pedido> {
        const update: Record<string, any> = {};
        if (cambios.nombre !== undefined) {
            const nombre = cambios.nombre.trim();
            if (!nombre) throw new ConflictException('El nombre del pedido no puede estar vacío.');
            update.nombre = nombre;
        }
        if (cambios.cliente !== undefined) update.cliente = cambios.cliente?.trim() || null;
        if (cambios.presupuesto !== undefined) update.presupuesto = cambios.presupuesto;
        if (cambios.estado !== undefined) update.estado = cambios.estado;

        if (Object.keys(update).length === 0) {
            return this.obtenerPorId(id, empresaId);
        }

        const { data, error } = await this.supabase
            .getClient()
            .from('pedidos')
            .update(update)
            .eq('id', id)
            .eq('empresa_id', empresaId) // nunca editar un pedido de otra empresa
            .select(this.COLUMNAS)
            .maybeSingle();

        if (error) {
            if (error.code === '23505') {
                throw new ConflictException(`Ya existe un pedido llamado "${update.nombre}".`);
            }
            throw new InternalServerErrorException(`Error actualizando pedido: ${error.message}`);
        }
        if (!data) {
            throw new NotFoundException(`Pedido ${id} no encontrado`);
        }
        return data as Pedido;
    }

    // Borrado real. A diferencia de categorías (que rebota con 23503 si
    // está en uso), acá la FK es ON DELETE SET NULL: los gastos asociados
    // sobreviven y quedan sin pedido. Se avisa cuántos quedaron sueltos
    // para que el panel pueda mostrarlo.
    async eliminar(id: number, empresaId: number): Promise<{ gastos_desasociados: number }> {
        const resumen = await this.obtenerPorId(id, empresaId); // 404 si no existe o es de otra empresa

        const { error } = await this.supabase
            .getClient()
            .from('pedidos')
            .delete()
            .eq('id', id)
            .eq('empresa_id', empresaId);

        if (error) {
            throw new InternalServerErrorException(`Error eliminando pedido: ${error.message}`);
        }
        return { gastos_desasociados: resumen.cantidad_gastos };
    }

    // Valida que un pedido pertenezca a la empresa dada. Lo usa
    // GastosService antes de guardar un `pedido_id`, para que un id
    // manipulado a mano no pueda cruzar empresas (§8/§28 del pedido de
    // trabajo). Devuelve el pedido para que el llamador pueda usar su
    // nombre en mensajes.
    async validarDeEmpresa(pedidoId: number, empresaId: number): Promise<Pedido> {
        const { data, error } = await this.supabase
            .getClient()
            .from('pedidos')
            .select(this.COLUMNAS)
            .eq('id', pedidoId)
            .eq('empresa_id', empresaId)
            .maybeSingle();

        if (error) {
            throw new InternalServerErrorException(`Error validando el pedido: ${error.message}`);
        }
        if (!data) {
            throw new NotFoundException(`Pedido ${pedidoId} no encontrado`);
        }
        return data as Pedido;
    }

    // SUM(monto) + COUNT por pedido, acotado a la empresa. Excluye los
    // duplicados ya confirmados con el mismo criterio que
    // GastosService.listar()/resumen() (Paso 35.3) -- si no, un gasto que
    // ya se marcó como "el mismo gasto que otro" inflaría el costo del
    // pedido contando el mismo pago dos veces.
    private async totalesPorPedido(
        pedidoIds: number[],
        empresaId: number,
    ): Promise<Map<number, { cantidad: number; total: number }>> {
        const totales = new Map<number, { cantidad: number; total: number }>();
        if (pedidoIds.length === 0) return totales;

        const { data, error } = await this.supabase
            .getClient()
            .from('gastos')
            .select('pedido_id, monto')
            .eq('empresa_id', empresaId)
            .in('pedido_id', pedidoIds)
            .or('posible_duplicado_de.is.null,pendiente_revision.eq.true');

        if (error) {
            throw new InternalServerErrorException(`Error calculando el costo del pedido: ${error.message}`);
        }

        for (const g of (data ?? []) as any[]) {
            const actual = totales.get(g.pedido_id) ?? { cantidad: 0, total: 0 };
            actual.cantidad += 1;
            actual.total += Number(g.monto) || 0;
            totales.set(g.pedido_id, actual);
        }
        return totales;
    }
}