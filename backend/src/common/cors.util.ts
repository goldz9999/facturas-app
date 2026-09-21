// Hallazgo 37.4-E: antes `main.ts` y `gastos.gateway.ts` aceptaban
// cualquier origen (`origin: true` / `origin: '*'`). Esto centraliza la
// validación para que ambos usen el mismo criterio.
//
// Se lee `process.env` directamente (no `ConfigService`) a propósito: acá
// abajo se usa dentro de una función que Express/Socket.IO invoca en cada
// request, no en el momento en que se arma el decorador de la clase — para
// entonces el proceso ya tiene las variables de entorno cargadas (en
// Docker/Hetzner vienen inyectadas por el propio contenedor; en desarrollo
// local, `ConfigModule.forRoot()` ya corrió `dotenv` antes de que llegue el
// primer request).
//
// `FRONTEND_URL` admite una o varias URLs separadas por coma, por ejemplo
// para tener el mismo backend sirviendo a un dominio de producción y a un
// subdominio de staging: `FRONTEND_URL=https://app.midominio.com,https://staging.midominio.com`.
function origenesPermitidos(): string[] {
    return (process.env.FRONTEND_URL || '')
        .split(',')
        .map((u) => u.trim().replace(/\/$/, ''))
        .filter(Boolean);
}

// localhost queda siempre permitido para no tener que tocar variables de
// entorno solo para desarrollar en la máquina local. Puertos típicos de
// Vite (5173) y de un build servido localmente (3000/4173).
const ORIGENES_DEV = [
    'http://localhost:5173',
    'http://127.0.0.1:5173',
    'http://localhost:4173',
    'http://localhost:3000',
];

export function esOrigenPermitido(origin: string | undefined): boolean {
    // Sin header Origin (curl, Postman, llamadas server-to-server, o el
    // propio navegador en requests same-origin): no hay CORS que aplicar.
    if (!origin) return true;

    const limpio = origin.replace(/\/$/, '');
    if (ORIGENES_DEV.includes(limpio)) return true;

    const permitidos = origenesPermitidos();
    if (permitidos.length === 0) {
        // FRONTEND_URL sin configurar: se avisa una sola vez para no
        // inundar los logs, y se sigue rechazando cualquier origen que no
        // sea localhost (fail-closed, no fail-open como antes).
        if (!(globalThis as any).__avisoFrontendUrlFaltante) {
            (globalThis as any).__avisoFrontendUrlFaltante = true;
            // eslint-disable-next-line no-console
            console.warn(
                'FRONTEND_URL no está configurada: solo se aceptan orígenes localhost. Definila en el entorno de producción (ver .env.example).',
            );
        }
        return false;
    }

    return permitidos.includes(limpio);
}

// Adaptador al formato que esperan `app.enableCors` (Express) y
// `@WebSocketGateway({ cors })` (Socket.IO/engine.io) -- ambos aceptan la
// misma forma de función `(origin, callback)`.
export function corsOriginCallback(
    origin: string | undefined,
    callback: (err: Error | null, allow?: boolean) => void,
) {
    callback(null, esOrigenPermitido(origin));
}