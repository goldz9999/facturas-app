import { ConflictException, ForbiddenException } from '@nestjs/common';
import { TelegramUsuariosController } from './telegram-usuarios.controller';

const miembro = (id: number, rol: string, over: Record<string, unknown> = {}) => ({
    id, nombre: 'U' + id, rol: 'empleado', es_super_admin: false, activo: true, telegram_id: null, tiene_password: true,
    empresas: [{ empresa_id: 1, rol }], ...over,
});

function montar(usuarios: any[]) {
    const svc = {
        listar: jest.fn().mockResolvedValue(usuarios),
        obtenerPorId: jest.fn(async (id: number) => usuarios.find((u) => u.id === id) ?? null),
        establecerTelegram: jest.fn().mockResolvedValue({}),
        buscarPorTelegramId: jest.fn(async (t: number) => usuarios.find((u) => u.telegram_id === t) ?? null),
        crear: jest.fn().mockResolvedValue({ id: 9 }),
    };
    return { c: new TelegramUsuariosController(svc as any), svc };
}
const req = (over: Record<string, unknown> = {}) => ({
    user: { id: 10, es_super_admin: false, rol_empresa: 'administrador', empresa_activa_id: 1, puede_gestionar_telegram: true, ...over },
});

describe('TelegramUsuariosController', () => {
    it('sin permiso no ve ni cambia nada', async () => {
        const { c, svc } = montar([miembro(2, 'empleado')]);
        await expect(c.listar(req({ puede_gestionar_telegram: false }))).rejects.toThrow(ForbiddenException);
        await expect(c.vincular(2, { telegram_id: 5 }, req({ puede_gestionar_telegram: false }))).rejects.toThrow(ForbiddenException);
        expect(svc.establecerTelegram).not.toHaveBeenCalled();
    });

    it('con permiso vincula y quita la cuenta de un miembro de la empresa', async () => {
        const { c, svc } = montar([miembro(2, 'empleado')]);
        await c.vincular(2, { telegram_id: 8109597915 }, req());
        await c.quitar(2, req());
        expect(svc.establecerTelegram.mock.calls).toEqual([[2, 8109597915], [2, null]]);
    });

    it('quien no es propietario no toca la cuenta de un propietario', async () => {
        const { c } = montar([miembro(3, 'propietario')]);
        await expect(c.quitar(3, req())).rejects.toThrow(ForbiddenException);
        await expect(c.quitar(3, req({ rol_empresa: 'propietario' }))).resolves.toEqual({ success: true });
    });

    it('alta solo Telegram: empleado de la empresa activa; ID repetido = 409', async () => {
        const { c, svc } = montar([miembro(2, 'empleado', { telegram_id: 77 })]);
        await c.crear({ nombre: ' Pedro ', telegram_id: 55 }, req());
        expect(svc.crear).toHaveBeenCalledWith({ nombre: 'Pedro', telegram_id: 55 }, [1], { rol: 'empleado', rol_empresa: 'empleado' });
        await expect(c.crear({ nombre: 'X', telegram_id: 77 }, req())).rejects.toThrow(ConflictException);
    });
});
