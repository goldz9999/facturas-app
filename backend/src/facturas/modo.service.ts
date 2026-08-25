import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../common/supabase.service';

export type ModoProcesamiento = 'n8n' | 'backend';

const TABLA = 'configuracion';
const CLAVE = 'modo_procesamiento';

// Modo global usado como fallback en memoria (por si la tabla "configuracion"
// todavía no existe en Supabase) y para no tener que leer la BD en cada request.
let modoEnMemoria: ModoProcesamiento = 'backend';
let avisoTablaFaltante = false;

// Fuente de verdad única para el modo de procesamiento (n8n vs backend).
// La usan tanto el endpoint de upload web como el webhook de Telegram, para
// que el switch del frontend afecte a los dos canales por igual.
//
// Requiere (opcional, recomendado) una tabla en Supabase:
//   create table configuracion (clave text primary key, valor text not null);
// Si no existe, el modo simplemente vive en memoria del proceso (se resetea
// al reiniciar el backend, pero sigue funcionando).
@Injectable()
export class ModoService {
    private readonly logger = new Logger(ModoService.name);

    constructor(private supabase: SupabaseService) { }

    async getModo(): Promise<ModoProcesamiento> {
        try {
            const { data, error } = await this.supabase
                .getClient()
                .from(TABLA)
                .select('valor')
                .eq('clave', CLAVE)
                .maybeSingle();

            if (error) throw error;

            if (data?.valor === 'backend' || data?.valor === 'n8n') {
                modoEnMemoria = data.valor;
            }
        } catch (err) {
            this.avisarTablaFaltante(err);
        }
        return modoEnMemoria;
    }

    async setModo(modo: ModoProcesamiento): Promise<ModoProcesamiento> {
        modoEnMemoria = modo;
        try {
            const { error } = await this.supabase
                .getClient()
                .from(TABLA)
                .upsert({ clave: CLAVE, valor: modo });
            if (error) throw error;
        } catch (err) {
            this.avisarTablaFaltante(err);
        }
        return modoEnMemoria;
    }

    private avisarTablaFaltante(err: any) {
        if (!avisoTablaFaltante) {
            avisoTablaFaltante = true;
            this.logger.warn(
                `No se pudo leer/guardar la tabla "${TABLA}" en Supabase (¿existe?). ` +
                `El modo de procesamiento se mantendrá solo en memoria mientras el backend siga corriendo. Detalle: ${err?.message || err}`,
            );
        }
    }
}