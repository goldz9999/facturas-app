import { UnauthorizedException } from '@nestjs/common';
import { JwtStrategy } from './jwt.strategy';

const config = { get: () => 'secreto-de-prueba' } as any;

function estrategia(over: Record<string, unknown> = {}) {
    const ctx = {
        obtener: jest.fn().mockResolvedValue({
            id: 1,
            email: 'a@b.pe',
            rol: 'empleado',
            activo: true,
            es_super_admin: false,
            empresa_ids: [1, 2],
            empresas: [
                { empresa_id: 1, rol: 'contador' },
                { empresa_id: 2, rol: 'administrador' },
            ],
            puede_registrar_personal: true,
            ultima_empresa_id: 1,
            ...over,
        }),
    };
    return new JwtStrategy(config, ctx as any);
}

describe('JwtStrategy.validate', () => {
    it('deriva el rol de la empresa pedida por ?empresa_id', async () => {
        const u = await estrategia().validate({ query: { empresa_id: '2' } }, { sub: 1 });
        expect(u.rol).toBe('admin');
        expect(u.rol_empresa).toBe('administrador');
    });

    it('sin query usa ultima_empresa_id', async () => {
        const u = await estrategia().validate({ query: {} }, { sub: 1 });
        expect(u.rol).toBe('empleado');
        expect(u.rol_empresa).toBe('contador');
    });

    it('super_admin conserva rol super_admin y se trata como propietario', async () => {
        const u = await estrategia({ es_super_admin: true, empresas: [], empresa_ids: [] }).validate({ query: {} }, { sub: 1 });
        expect(u.rol).toBe('super_admin');
        expect(u.rol_empresa).toBe('propietario');
        expect(u.es_super_admin).toBe(true);
    });

    it('usuario sin empresas: empleado sin rol de empresa', async () => {
        const u = await estrategia({ empresas: [], empresa_ids: [], ultima_empresa_id: null }).validate({ query: {} }, { sub: 1 });
        expect(u.rol).toBe('empleado');
        expect(u.rol_empresa).toBeNull();
        expect(u.empresa_ids).toEqual([]);
    });

    it('rechaza usuario inactivo', async () => {
        await expect(estrategia({ activo: false }).validate({ query: {} }, { sub: 1 })).rejects.toThrow(UnauthorizedException);
    });

    it('rechaza usuario inexistente', async () => {
        const s = estrategia();
        (s as any).usuarioContexto.obtener.mockResolvedValue(null);
        await expect(s.validate({ query: {} }, { sub: 1 })).rejects.toThrow(UnauthorizedException);
    });
});
