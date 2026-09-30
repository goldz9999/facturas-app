import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
    OnGatewayConnection,
    OnGatewayDisconnect,
    WebSocketGateway,
    WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import * as jwt from 'jsonwebtoken';
import { corsOriginCallback } from '../common/cors.util';
import { UsuarioContextoService } from '../common/usuario-contexto.service';

// Notifica a los clientes conectados cuando cambia algo en `gastos`, para que
// el frontend (useGastosRealtime) refresque sin tener que hacer polling.
// Reutiliza el MISMO JWT que ya usa la API REST (JwtAuthGuard/JwtStrategy).
//
// Paso 38.2: el super_admin YA NO tiene una sala global que reciba todos
// los eventos (antes 'super_admin' se unía a todo, siguiendo la misma
// vista global que tenía la API antes de este paso). Ahora, sin importar
// el rol, el cliente indica UNA empresa al conectar
// (auth: { token, empresa_id }) y solo se une a esa sala -- si no manda un
// empresa_id válido (entero positivo), o si el rol no tiene acceso a esa
// empresa (admin/empleado fuera de su empresa_ids), se rechaza la
// conexión. Para cambiar de empresa hay que reconectar el socket (ver
// useGastosRealtime.js en el frontend).
//
// No viaja el gasto completo en el evento: viaja solo un aviso
// ({ empresaId, gastoId }) y el frontend decide qué recargar con las mismas
// llamadas REST de siempre (useExpenses). Así evitamos duplicar la lógica de
// mapeo/permisos de lectura que ya vive en GastosService.listar/obtenerPorId.
@WebSocketGateway({
    // Hallazgo 37.4-E: antes `origin: '*'` aceptaba cualquier dominio.
    // Mismo criterio que main.ts (FRONTEND_URL + localhost), ver cors.util.ts.
    cors: { origin: corsOriginCallback },
    namespace: '/gastos',
})
export class GastosGateway implements OnGatewayConnection, OnGatewayDisconnect {
    @WebSocketServer()
    server: Server;

    private readonly logger = new Logger(GastosGateway.name);

    constructor(
        private config: ConfigService,
        private usuarioContexto: UsuarioContextoService,
    ) { }

    async handleConnection(client: Socket) {
        try {
            const token =
                (client.handshake.auth?.token as string) ||
                (client.handshake.headers.authorization || '').replace(/^Bearer /, '');

            if (!token) throw new Error('Sin token');

            // Hallazgo 37.4-B: sin fallback inseguro -- si falta la variable
            // de entorno, se rechaza la conexión en vez de aceptar tokens
            // firmados con un secreto público conocido (ver también
            // jwt.strategy.ts / auth.module.ts, que ahora hacen fallar el
            // arranque completo del backend si falta JWT_SECRET).
            const secret = this.config.get<string>('JWT_SECRET');
            if (!secret) throw new Error('JWT_SECRET no configurado en el servidor');

            const payload = jwt.verify(token, secret) as unknown as {
                sub: number;
            };

            const empresaIdRaw = client.handshake.auth?.empresa_id;
            const empresaId = Number(empresaIdRaw);
            if (!empresaIdRaw || !Number.isInteger(empresaId) || empresaId <= 0) {
                throw new Error('Falta empresa_id válido en la conexión');
            }

            // Paso 44: rol y empresas se leen de la base, no del token
            // (mismo criterio que JwtStrategy.validate()).
            const usuario = await this.usuarioContexto.obtener(payload.sub);
            if (!usuario || !usuario.activo) {
                throw new Error('Usuario inexistente o desactivado');
            }
            if (usuario.rol !== 'super_admin' && !usuario.empresa_ids.includes(empresaId)) {
                throw new Error('No tiene acceso a esa empresa');
            }

            client.join(`empresa:${empresaId}`);
            this.logger.log(`Cliente conectado: usuario ${payload.sub}, empresa ${empresaId} (${client.id})`);
        } catch (err) {
            this.logger.warn(`Conexión de socket rechazada: ${(err as Error).message}`);
            client.disconnect(true);
        }
    }

    handleDisconnect(client: Socket) {
        this.logger.log(`Cliente desconectado: ${client.id}`);
    }

    // Llamado desde GastosService cada vez que se crea/actualiza/borra un
    // gasto. empresaId puede ser null (gasto sin empresa resuelta) -- en ese
    // caso, desde el Paso 38.2, no notifica a nadie (ya no existe la sala
    // global que antes lo recibía).
    notificarCambio(empresaId: number | null | undefined, gastoId: number, tipo: 'creado' | 'actualizado' | 'eliminado') {
        if (!empresaId) return;
        const payload = { empresaId, gastoId, tipo };
        this.server.to(`empresa:${empresaId}`).emit('gasto:cambio', payload);
    }
}