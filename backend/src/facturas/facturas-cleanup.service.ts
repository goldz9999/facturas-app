import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SupabaseService } from './supabase.service';

const BUCKET = 'Facturas';
const MESES_RETENCION = 3;

@Injectable()
export class FacturasCleanupService {
    private readonly logger = new Logger(FacturasCleanupService.name);

    constructor(private supabase: SupabaseService) { }

    // Corre todos los días a las 3:00 AM (hora del servidor)
    @Cron(CronExpression.EVERY_DAY_AT_3AM)
    async borrarImagenesVencidas() {
        const limite = new Date();
        limite.setMonth(limite.getMonth() - MESES_RETENCION);
        const limiteIso = limite.toISOString().slice(0, 10); // YYYY-MM-DD

        const client = this.supabase.getClient();

        // Busca filas con imagen guardada y fecha anterior al límite
        const { data: filas, error } = await client
            .from('tabla_2')
            .select('id, imagen_url, fecha')
            .not('imagen_url', 'is', null)
            .lt('fecha', limiteIso);

        if (error) {
            this.logger.error(`Error buscando facturas vencidas: ${error.message}`);
            return;
        }

        if (!filas || filas.length === 0) {
            this.logger.log('No hay imágenes vencidas para borrar.');
            return;
        }

        const rutas = filas.map((f) => f.imagen_url as string);

        const { error: errorBorrado } = await client.storage
            .from(BUCKET)
            .remove(rutas);

        if (errorBorrado) {
            this.logger.error(`Error borrando imágenes del bucket: ${errorBorrado.message}`);
            return;
        }

        // Limpia la referencia en la base de datos (el registro de la factura queda intacto)
        const ids = filas.map((f) => f.id);
        const { error: errorUpdate } = await client
            .from('tabla_2')
            .update({ imagen_url: null })
            .in('id', ids);

        if (errorUpdate) {
            this.logger.error(`Error limpiando imagen_url: ${errorUpdate.message}`);
            return;
        }

        this.logger.log(`Se borraron ${rutas.length} imagen(es) con más de ${MESES_RETENCION} meses.`);
    }
}