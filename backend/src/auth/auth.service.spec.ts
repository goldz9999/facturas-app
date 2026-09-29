import { UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { AuthService } from './auth.service';

function servicio(fila: Record<string, unknown>) {
    const supabase = {
        getClient: () => ({
            from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: fila, error: null }) }) }) }),
        }),
    };
    const jwt = { signAsync: jest.fn().mockResolvedValue('tok') };
    return new AuthService(supabase as any, jwt as any);
}

const base = {
    id: 7,
    nombre: 'Lucía',
    email: 'l@x.pe',
    password_hash: bcrypt.hashSync('clave123', 4),
    rol: 'admin',
    activo: true,
    es_super_admin: false,
    puede_registrar_personal: true,
    ultima_empresa_id: 2,
    usuario_empresas: [
        { empresa_id: 2, rol: 'administrador' },
        { empresa_id: 5, rol: 'contador' },
    ],
};

describe('AuthService.login', () => {
    it('devuelve el rol por empresa y el flag de super admin', async () => {
        const r = await servicio(base).login({ email: 'l@x.pe', password: 'clave123' } as any);
        expect(r.access_token).toBe('tok');
        expect(r.usuario.empresas).toEqual([
            { empresa_id: 2, rol: 'administrador' },
            { empresa_id: 5, rol: 'contador' },
        ]);
        expect(r.usuario.empresa_ids).toEqual([2, 5]);
        expect(r.usuario.es_super_admin).toBe(false);
    });

    it('un usuario con rol legacy super_admin es super admin aunque el flag no esté', async () => {
        const r = await servicio({ ...base, rol: 'super_admin', es_super_admin: false, usuario_empresas: [] })
            .login({ email: 'l@x.pe', password: 'clave123' } as any);
        expect(r.usuario.es_super_admin).toBe(true);
        expect(r.usuario.empresas).toEqual([]);
    });

    it('fila de empresa sin rol cae al rol global legacy', async () => {
        const r = await servicio({ ...base, usuario_empresas: [{ empresa_id: 2, rol: null }] })
            .login({ email: 'l@x.pe', password: 'clave123' } as any);
        expect(r.usuario.empresas).toEqual([{ empresa_id: 2, rol: 'administrador' }]);
    });

    it('contraseña incorrecta lanza Unauthorized', async () => {
        await expect(servicio(base).login({ email: 'l@x.pe', password: 'mala' } as any)).rejects.toThrow(UnauthorizedException);
    });
});
