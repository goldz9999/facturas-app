import { ConflictException, NotFoundException } from '@nestjs/common';
import { UsuariosService } from './usuarios.service';

interface Opciones {
    insertUsuario?: { data?: unknown; error?: { code?: string; message: string } | null };
    previas?: { id?: number; empresa_id?: number; rol: string | null }[];
    fila?: Record<string, unknown> | null;
    filas?: Record<string, unknown>[];
    pertenece?: boolean;
}

function montar(opts: Opciones = {}) {
    const insertados: { usuarios: any[]; usuario_empresas: any[] } = { usuarios: [], usuario_empresas: [] };
    const updates: { usuarios: any[]; usuario_empresas: any[] } = { usuarios: [], usuario_empresas: [] };
    const from = jest.fn((tabla: string) => {
        if (tabla === 'usuarios') {
            return {
                insert: (v: any) => {
                    insertados.usuarios.push(v);
                    return { select: () => ({ single: async () => opts.insertUsuario ?? { data: { id: 5 }, error: null } }) };
                },
                update: (v: any) => {
                    updates.usuarios.push(v);
                    return { eq: async () => ({ error: null }) };
                },
                select: () => ({
                    eq: () => ({ maybeSingle: async () => ({ data: opts.fila ?? null, error: null }) }),
                    order: async () => ({ data: opts.filas ?? [], error: null }),
                }),
            };
        }
        return {
            // select(...).eq(...)[.eq(...)] se puede esperar directamente o terminar en maybeSingle().
            select: () => {
                const r: any = {
                    eq: () => r,
                    maybeSingle: async () => ({ data: opts.pertenece === false ? null : { usuario_id: 1 }, error: null }),
                    then: (ok: any, ko: any) => Promise.resolve({ data: opts.previas ?? [], error: null }).then(ok, ko),
                };
                return r;
            },
            delete: () => ({ eq: async () => ({ error: null }) }),
            update: (v: any) => {
                updates.usuario_empresas.push(v);
                const r: any = { eq: () => r, then: (ok: any, ko: any) => Promise.resolve({ error: null }).then(ok, ko) };
                return r;
            },
            insert: async (v: any) => {
                insertados.usuario_empresas.push(v);
                return { error: null };
            },
        };
    });
    const svc = new UsuariosService({ getClient: () => ({ from }) } as any, {} as any);
    return { svc, insertados, updates };
}

const filaBase = {
    id: 5,
    telegram_id: null,
    nombre: 'Ana',
    rol: 'empleado',
    activo: true,
    password_hash: '$2a$hash',
    puede_registrar_personal: true,
    creado_en: '2026-09-29',
    usuario_empresas: [{ empresa_id: 1, rol: 'contador' }],
};

describe('UsuariosService.listar', () => {
    it('no expone password_hash y devuelve rol por empresa y si tiene contraseña', async () => {
        const { svc } = montar({ filas: [filaBase, { ...filaBase, id: 6, password_hash: null }] });
        const r = await svc.listar();
        expect(r[0]).not.toHaveProperty('password_hash');
        expect(r[0].empresas).toEqual([{ empresa_id: 1, rol: 'contador' }]);
        expect(r[0].tiene_password).toBe(true);
        expect(r[1].tiene_password).toBe(false);
    });
});

describe('UsuariosService.asignarEmpresas', () => {
    it('conserva el rol de las empresas que se mantienen y usa el rol por defecto para las nuevas', async () => {
        const { svc, insertados } = montar({ previas: [{ empresa_id: 1, rol: 'contador' }] });
        await svc.asignarEmpresas(9, [1, 2], 'administrador');
        expect(insertados.usuario_empresas[0]).toEqual([
            { usuario_id: 9, empresa_id: 1, rol: 'contador' },
            { usuario_id: 9, empresa_id: 2, rol: 'administrador' },
        ]);
    });
});

describe('UsuariosService.crear', () => {
    it('guarda el rol legacy derivado y el rol por empresa elegido', async () => {
        const { svc, insertados } = montar({ fila: filaBase });
        const u = await svc.crear(
            { nombre: 'Ana', email: 'ana@x.pe', password: 'clave123' } as any,
            [1],
            { rol: 'empleado', rol_empresa: 'contador' },
        );
        expect(insertados.usuarios[0].rol).toBe('empleado');
        expect(insertados.usuario_empresas[0]).toEqual([{ usuario_id: 5, empresa_id: 1, rol: 'contador' }]);
        expect(u.empresas).toEqual([{ empresa_id: 1, rol: 'contador' }]);
        expect(u).not.toHaveProperty('password_hash');
    });

    it('correo repetido lanza Conflict con mensaje claro', async () => {
        const { svc } = montar({ insertUsuario: { data: null, error: { code: '23505', message: 'duplicate key' } } });
        await expect(
            svc.crear({ nombre: 'Ana', email: 'ana@x.pe', password: 'clave123' } as any, [1], { rol: 'empleado', rol_empresa: 'empleado' }),
        ).rejects.toThrow(new ConflictException('Ese correo ya está registrado.'));
    });
});

describe('UsuariosService.actualizar por un administrador de empresa', () => {
    it('no toca el rol global (usuarios.rol); solo el rol en esa empresa', async () => {
        const { svc, updates } = montar({ fila: filaBase, previas: [{ id: 77, rol: 'empleado' }] });
        await svc.actualizar(9, { rol: 'admin', password: 'nuevaclave' } as any, 3);
        expect(updates.usuarios[0]).toHaveProperty('password_hash');
        expect(updates.usuarios[0]).not.toHaveProperty('rol');
        expect(updates.usuario_empresas).toEqual([{ rol: 'administrador' }]);
    });

    it('un super admin (sin empresa acotada) sí actualiza el rol global', async () => {
        const { svc, updates } = montar({ fila: filaBase, previas: [] });
        await svc.actualizar(9, { rol: 'admin' } as any);
        expect(updates.usuarios[0]).toMatchObject({ rol: 'admin' });
    });
});

describe('UsuariosService.desactivar', () => {
    it('acotado a una empresa exige que el usuario pertenezca a ella', async () => {
        const { svc } = montar({ pertenece: false, fila: filaBase });
        await expect(svc.desactivar(9, 3)).rejects.toThrow(NotFoundException);
    });
});

describe('UsuariosService.actualizar — rol por empresa', () => {
    it('cambia el rol del usuario en esa empresa', async () => {
        const { svc, updates } = montar({ fila: filaBase });
        await svc.actualizar(9, { rol_empresa: 'contador' } as any, 3);
        expect(updates.usuario_empresas).toEqual([{ rol: 'contador' }]);
    });
    it('un super admin indica la empresa aparte', async () => {
        const { svc, updates } = montar({ fila: filaBase });
        await svc.actualizar(9, { rol_empresa: 'supervisor' } as any, undefined, 7);
        expect(updates.usuario_empresas).toEqual([{ rol: 'supervisor' }]);
    });
});
