import { ConflictException } from '@nestjs/common';
import { UsuariosService } from './usuarios.service';

interface Opciones {
    insertUsuario?: { data?: unknown; error?: { code?: string; message: string } | null };
    previas?: { empresa_id: number; rol: string | null }[];
    fila?: Record<string, unknown> | null;
    filas?: Record<string, unknown>[];
}

function montar(opts: Opciones = {}) {
    const insertados: { usuarios: any[]; usuario_empresas: any[] } = { usuarios: [], usuario_empresas: [] };
    const from = jest.fn((tabla: string) => {
        if (tabla === 'usuarios') {
            return {
                insert: (v: any) => {
                    insertados.usuarios.push(v);
                    return { select: () => ({ single: async () => opts.insertUsuario ?? { data: { id: 5 }, error: null } }) };
                },
                select: () => ({
                    eq: () => ({ maybeSingle: async () => ({ data: opts.fila ?? null, error: null }) }),
                    order: async () => ({ data: opts.filas ?? [], error: null }),
                }),
            };
        }
        return {
            select: () => ({ eq: async () => ({ data: opts.previas ?? [], error: null }) }),
            delete: () => ({ eq: async () => ({ error: null }) }),
            insert: async (v: any) => {
                insertados.usuario_empresas.push(v);
                return { error: null };
            },
        };
    });
    const svc = new UsuariosService({ getClient: () => ({ from }) } as any, {} as any);
    return { svc, insertados };
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
