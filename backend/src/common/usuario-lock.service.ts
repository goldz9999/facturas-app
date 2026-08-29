import { Injectable } from '@nestjs/common';

// Mutex en memoria, uno por usuario. Sirve para que, cuando llegan dos
// archivos casi al mismo tiempo del mismo usuario (ej. factura + captura de
// Yape mandadas juntas, o un álbum de fotos), el tramo "leer si ya existe un
// gasto con este monto -> insertar" se ejecute de a uno, en orden, en vez de
// en paralelo. Sin esto, ambos requests pueden leer la tabla `gastos` antes
// de que cualquiera de los dos haya insertado, y la heurística de agrupación
// (GastosService.buscarCandidatoParaAgrupar) nunca encuentra al otro —
// terminan como dos gastos separados en vez de uno con su comprobante y su
// pago.
//
// Solo sirve para un único proceso de Node (no es un lock distribuido). Es
// suficiente acá porque el backend corre en una sola instancia en Koyeb; si
// en algún momento se escala a múltiples instancias, esto habría que
// moverlo a un lock real en Postgres (ej. advisory lock) o Redis.
@Injectable()
export class UsuarioLockService {
    private colas = new Map<number, Promise<unknown>>();

    // Encola `fn` para que corra después de que termine (con éxito o error)
    // cualquier tarea previa en cola para el mismo usuarioId. Las tareas de
    // usuarios distintos no se bloquean entre sí.
    async runExclusive<T>(usuarioId: number, fn: () => Promise<T>): Promise<T> {
        const anterior = this.colas.get(usuarioId) ?? Promise.resolve();

        // `tarea` espera a que termine lo anterior (ignorando si falló) y
        // recién ahí ejecuta `fn`. Se guarda de una vez en el mapa para que
        // la siguiente llamada, aunque llegue en el mismo tick, encole
        // detrás de esta.
        const tarea = anterior.catch(() => undefined).then(fn);

        // Encadenado para limpieza: no debe rechazar (rompería futuras
        // llamadas que esperan `anterior`), así que se traga el error acá;
        // el error real lo sigue recibiendo quien llamó a runExclusive
        // porque devolvemos `tarea` (no este catch) más abajo.
        this.colas.set(
            usuarioId,
            tarea.catch(() => undefined),
        );

        return tarea;
    }
}