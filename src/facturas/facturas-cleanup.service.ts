import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SupabaseService } from '../common/supabase.service';
import { huellaImagen } from './imagen.util';

const BUCKET = 'Facturas';

// Límite de prueba: 300 MB. El plan gratuito de Supabase Storage es de 1 GB;
// se usa un límite más chico para probar el comportamiento del borrado antes
// de acercarse al límite real del plan. Cambiar este número basta para
// ajustar el umbral.
const LIMITE_BYTES = 300 * 1024 * 1024;

interface ArchivoBucket {
    path: string;
    size: number;
}

// Ya no se borra por antigüedad fija (antes: 3 meses). Ahora se borra por
// espacio: si el bucket supera LIMITE_BYTES, se van borrando las evidencias
// más antiguas (por evidencias.creado_en) hasta volver a estar por debajo
// del límite. El gasto y el comprobante quedan intactos siempre; solo se
// pierde el archivo de respaldo (storage_path pasa a null).
@Injectable()
export class FacturasCleanupService implements OnApplicationBootstrap {
    private readonly logger = new Logger(FacturasCleanupService.name);

    constructor(private supabase: SupabaseService) { }

    // Las imágenes subidas antes de existir la huella no la tienen: se calcula
    // al arrancar (sin bloquear el arranque) y cada hora, por tandas.
    onApplicationBootstrap() {
        setTimeout(() => this.completarHuellas().catch((e) => this.logger.warn(`Huellas: ${e.message}`)), 5000);
    }

    @Cron(CronExpression.EVERY_HOUR)
    async completarHuellas(tanda = 100): Promise<number> {
        const client = this.supabase.getClient();
        const { data, error } = await client
            .from('evidencias')
            .select('id, storage_path')
            .is('huella', null)
            .eq('tipo', 'imagen')
            .not('storage_path', 'is', null)
            .order('id', { ascending: false })
            .limit(tanda);
        if (error) throw new Error(error.message);
        let hechas = 0;
        for (const ev of data ?? []) {
            const { data: archivo, error: errDescarga } = await client.storage.from(BUCKET).download(ev.storage_path);
            if (errDescarga || !archivo) continue;
            const buffer = Buffer.from(await archivo.arrayBuffer());
            const huella = await huellaImagen(buffer, archivo.type || 'image/webp');
            if (!huella) continue;
            const { error: errUpdate } = await client.from('evidencias').update({ huella }).eq('id', ev.id);
            if (!errUpdate) hechas++;
        }
        if (hechas) this.logger.log(`Huella calculada para ${hechas} imagen(es) existentes.`);
        return hechas;
    }

    // Corre todos los días a las 3:00 AM (hora del servidor)
    @Cron(CronExpression.EVERY_DAY_AT_3AM)
    async borrarEvidenciasPorEspacio() {
        const client = this.supabase.getClient();

        let archivos: ArchivoBucket[];
        try {
            archivos = await this.listarArchivosBucket(client);
        } catch (err) {
            this.logger.error(`Error listando el bucket "${BUCKET}": ${err.message}`);
            return;
        }

        const tamanoPorRuta = new Map(archivos.map((a) => [a.path, a.size]));
        const usoBytes = archivos.reduce((acc, a) => acc + a.size, 0);
        const usoMB = (usoBytes / (1024 * 1024)).toFixed(1);
        const limiteMB = (LIMITE_BYTES / (1024 * 1024)).toFixed(0);

        if (usoBytes <= LIMITE_BYTES) {
            this.logger.log(`Uso de storage: ${usoMB} MB de ${limiteMB} MB. Nada que borrar.`);
            return;
        }

        const bytesABorrar = usoBytes - LIMITE_BYTES;
        this.logger.log(
            `Uso de storage: ${usoMB} MB supera el límite de ${limiteMB} MB. ` +
            `Liberando ~${(bytesABorrar / (1024 * 1024)).toFixed(1)} MB desde las evidencias más antiguas...`,
        );

        let bytesLiberados = 0;
        let totalBorrados = 0;

        // Borra en lotes de 20, empezando por las evidencias más antiguas,
        // hasta liberar suficiente espacio o quedarse sin evidencias con
        // archivo.
        while (bytesLiberados < bytesABorrar) {
            const { data: filas, error } = await client
                .from('evidencias')
                .select('id, storage_path')
                .not('storage_path', 'is', null)
                .order('creado_en', { ascending: true })
                .limit(20);

            if (error) {
                this.logger.error(`Error buscando evidencias para liberar espacio: ${error.message}`);
                break;
            }
            if (!filas || filas.length === 0) {
                this.logger.warn(
                    'No quedan evidencias con archivo para borrar, pero el uso sigue por encima del límite.',
                );
                break;
            }

            const rutas = filas.map((f) => f.storage_path as string);

            const { error: errorBorrado } = await client.storage.from(BUCKET).remove(rutas);
            if (errorBorrado) {
                this.logger.error(`Error borrando archivos del bucket: ${errorBorrado.message}`);
                break;
            }

            const ids = filas.map((f) => f.id);
            const { error: errorUpdate } = await client
                .from('evidencias')
                .update({ storage_path: null })
                .in('id', ids);
            if (errorUpdate) {
                this.logger.error(`Error limpiando storage_path: ${errorUpdate.message}`);
                break;
            }

            for (const ruta of rutas) {
                bytesLiberados += tamanoPorRuta.get(ruta) ?? 0;
            }
            totalBorrados += filas.length;
        }

        this.logger.log(
            `Se borraron ${totalBorrados} archivo(s), liberando ~${(bytesLiberados / (1024 * 1024)).toFixed(1)} MB.`,
        );
    }

    // Lista todos los archivos del bucket (paginado, por si hay más de 1000)
    // con su tamaño en bytes, para poder calcular el uso total y cuánto se
    // libera al borrar cada uno.
    private async listarArchivosBucket(client: ReturnType<SupabaseService['getClient']>): Promise<ArchivoBucket[]> {
        const archivos: ArchivoBucket[] = [];
        const limit = 1000;
        let offset = 0;

        while (true) {
            const { data, error } = await client.storage.from(BUCKET).list('', {
                limit,
                offset,
                sortBy: { column: 'name', order: 'asc' },
            });
            if (error) throw new Error(error.message);
            if (!data || data.length === 0) break;

            for (const f of data) {
                // Las carpetas no tienen "id"; el bucket es plano (sin
                // subcarpetas) así que en la práctica no debería haber, pero
                // se filtran por las dudas.
                if (f.id) {
                    archivos.push({ path: f.name, size: f.metadata?.size ?? 0 });
                }
            }

            if (data.length < limit) break;
            offset += limit;
        }

        return archivos;
    }
}