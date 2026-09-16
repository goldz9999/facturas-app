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

// Notifica a los clientes conectados cuando cambia algo en `gastos`, para que
// el frontend (useGastosRealtime) refresque sin tener que hacer polling.
// Reutiliza el MISMO JWT que ya usa la API REST (JwtAuthGuard/JwtStrategy) --
// no hay una capa de permisos nueva que mantener: si el token trae
// empresa_ids: [3, 7], el socket solo se une a esas salas y solo recibe
// eventos de esas empresas. super_admin (empresa_ids puede venir vacío, ve
// "todo" en la API vía resolverEmpresaIdFiltro) se une a una sala especial
// que recibe todos los eventos.
//
// No viaja el gasto completo en el evento: viaja solo un aviso
// ({ empresaId, gastoId }) y el frontend decide qué recargar con las mismas
// llamadas REST de siempre (useExpenses). Así evitamos duplicar la lógica de
// mapeo/permisos de lectura que ya vive en GastosService.listar/obtenerPorId.
@WebSocketGateway({
    cors: { origin: '*' }, // ajustar a la URL real del frontend en producción
    namespace: '/gastos',
})
export class GastosGateway implements OnGatewayConnection, OnGatewayDisconnect {
    @WebSocketServer()
    server: Server;

    private readonly logger = new Logger(GastosGateway.name);

    constructor(private config: ConfigService) { }

    handleConnection(client: Socket) {
        try {
            const token =
                (client.handshake.auth?.token as string) ||
                (client.handshake.headers.authorization || '').replace(/^Bearer /, '');

            if (!token) throw new Error('Sin token');

            const secret = this.config.get<string>('JWT_SECRET') ?? 'dev-secret-cambiar-en-produccion';
            const payload = jwt.verify(token, secret) as {
                sub: number;
                rol: string;
                empresa_ids: number[];
            };

            if (payload.rol === 'super_admin') {
                client.join('super_admin');
            }
            for (const empresaId of payload.empresa_ids ?? []) {
                client.join(`empresa:${empresaId}`);
            }

            this.logger.log(`Cliente conectado: usuario ${payload.sub} (${client.id})`);
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
    // caso solo lo ve super_admin.
    notificarCambio(empresaId: number | null | undefined, gastoId: number, tipo: 'creado' | 'actualizado' | 'eliminado') {
        const payload = { empresaId: empresaId ?? null, gastoId, tipo };
        if (empresaId) {
            this.server.to(`empresa:${empresaId}`).emit('gasto:cambio', payload);
        }
        this.server.to('super_admin').emit('gasto:cambio', payload);
    }
}