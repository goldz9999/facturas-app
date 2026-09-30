import { BadRequestException, ConflictException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { AuthService } from './auth.service';

// Supabase en memoria para usuarios (una fila) y el bucket de avatares.
function servicio(opts: { updateError?: { code: string; message: string } } = {}) {
    const fila: Record<string, any> = { id: 7, nombre: 'Lucía', email: 'l@x.pe', password_hash: bcrypt.hashSync('clave123', 4), avatar_url: null };
    const updates: any[] = [];
    const client = {
        from: () => ({
            select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { ...fila }, error: null }) }) }),
            update: (c: any) => ({
                eq: async () => {
                    if (opts.updateError) return { error: opts.updateError };
                    updates.push(c); Object.assign(fila, c); return { error: null };
                },
            }),
        }),
        storage: {
            from: () => ({
                upload: jest.fn().mockResolvedValue({ error: null }),
                getPublicUrl: (path: string) => ({ data: { publicUrl: 'https://s/avatares/' + path } }),
            }),
        },
    };
    return { svc: new AuthService({ getClient: () => client } as any, {} as any), updates, fila };
}

describe('AuthService — perfil propio', () => {
    it('cambia el nombre sin pedir contraseña', async () => {
        const { svc, updates } = servicio();
        const r = await svc.actualizarPerfil(7, { nombre: '  Lucía R. ' });
        expect(updates).toEqual([{ nombre: 'Lucía R.' }]);
        expect(r.nombre).toBe('Lucía R.');
    });

    it('correo o contraseña nuevos piden la contraseña actual correcta', async () => {
        const { svc, updates } = servicio();
        await expect(svc.actualizarPerfil(7, { email: 'n@x.pe' })).rejects.toThrow(BadRequestException);
        await expect(svc.actualizarPerfil(7, { password_nueva: 'nueva123', password_actual: 'mala' })).rejects.toThrow(BadRequestException);
        expect(updates).toEqual([]);
        await svc.actualizarPerfil(7, { email: 'n@x.pe', password_nueva: 'nueva123', password_actual: 'clave123' });
        expect(updates[0].email).toBe('n@x.pe');
        expect(bcrypt.compareSync('nueva123', updates[0].password_hash)).toBe(true);
    });

    it('el mismo correo no pide contraseña; un correo ya usado da 409', async () => {
        const { svc, updates } = servicio();
        await svc.actualizarPerfil(7, { email: 'l@x.pe' });
        expect(updates).toEqual([]);
        const conflicto = servicio({ updateError: { code: '23505', message: 'dup' } }).svc;
        await expect(conflicto.actualizarPerfil(7, { email: 'otro@x.pe', password_actual: 'clave123' })).rejects.toThrow(ConflictException);
    });

    it('la foto debe ser una imagen permitida y se guarda su URL', async () => {
        const { svc, fila } = servicio();
        await expect(svc.subirAvatar(7, { mimetype: 'image/svg+xml' } as any)).rejects.toThrow(BadRequestException);
        await svc.subirAvatar(7, { mimetype: 'image/png', buffer: Buffer.from('x') } as any);
        expect(fila.avatar_url).toMatch(/^https:\/\/s\/avatares\/7\/avatar\.png\?v=\d+$/);
        await svc.quitarAvatar(7);
        expect(fila.avatar_url).toBeNull();
    });
});
