import {
    ampliarPropietario,
    elegirEmpresaActiva,
    EmpresaRol,
    empresasDeFilas,
    esRolEmpresa,
    esSuperAdmin,
    resolverRolAlta,
    rolEmpresaActualizado,
    rolEmpresaDesdeLegacy,
    rolLegacy,
    validarGestion,
} from './roles-empresa';

const empresas: EmpresaRol[] = [
    { empresa_id: 1, rol: 'contador' },
    { empresa_id: 2, rol: 'propietario' },
];

describe('rolLegacy', () => {
    it('super_admin gana sobre cualquier rol de empresa', () => {
        expect(rolLegacy(true, 'empleado')).toBe('super_admin');
        expect(rolLegacy(true, null)).toBe('super_admin');
    });
    it('propietario y administrador equivalen a admin', () => {
        expect(rolLegacy(false, 'propietario')).toBe('admin');
        expect(rolLegacy(false, 'administrador')).toBe('admin');
    });
    it('supervisor, contador, empleado y sin empresa equivalen a empleado', () => {
        expect(rolLegacy(false, 'supervisor')).toBe('empleado');
        expect(rolLegacy(false, 'contador')).toBe('empleado');
        expect(rolLegacy(false, 'empleado')).toBe('empleado');
        expect(rolLegacy(false, null)).toBe('empleado');
    });
});

describe('rolEmpresaDesdeLegacy', () => {
    it('empleado se queda empleado; admin y super_admin pasan a administrador', () => {
        expect(rolEmpresaDesdeLegacy('empleado')).toBe('empleado');
        expect(rolEmpresaDesdeLegacy('admin')).toBe('administrador');
        expect(rolEmpresaDesdeLegacy('super_admin')).toBe('administrador');
    });
    it('un valor desconocido cae al rol más bajo', () => {
        expect(rolEmpresaDesdeLegacy('cualquier-cosa')).toBe('empleado');
    });
});

describe('rolEmpresaActualizado', () => {
    it('conserva el rol fino si la clase legacy no cambia', () => {
        expect(rolEmpresaActualizado('propietario', 'admin')).toBe('propietario');
        expect(rolEmpresaActualizado('contador', 'empleado')).toBe('contador');
    });
    it('cambia cuando la clase legacy cambia', () => {
        expect(rolEmpresaActualizado('contador', 'admin')).toBe('administrador');
        expect(rolEmpresaActualizado('administrador', 'empleado')).toBe('empleado');
    });
});

describe('esRolEmpresa / esSuperAdmin', () => {
    it('valida los cinco roles', () => {
        expect(esRolEmpresa('contador')).toBe(true);
        expect(esRolEmpresa('admin')).toBe(false);
        expect(esRolEmpresa(null)).toBe(false);
    });
    it('super admin por flag o por rol legacy', () => {
        expect(esSuperAdmin({ es_super_admin: true, rol: 'empleado' })).toBe(true);
        expect(esSuperAdmin({ es_super_admin: false, rol: 'super_admin' })).toBe(true);
        expect(esSuperAdmin({ es_super_admin: null, rol: 'admin' })).toBe(false);
    });
});

describe('empresasDeFilas', () => {
    it('usa el rol de la fila cuando es válido', () => {
        expect(empresasDeFilas([{ empresa_id: 3, rol: 'supervisor' }], 'empleado')).toEqual([{ empresa_id: 3, rol: 'supervisor' }]);
    });
    it('rol nulo o inválido cae al rol global legacy, nunca a uno más alto', () => {
        expect(empresasDeFilas([{ empresa_id: 3, rol: null }], 'empleado')).toEqual([{ empresa_id: 3, rol: 'empleado' }]);
        expect(empresasDeFilas([{ empresa_id: 4, rol: 'basura' }], 'admin')).toEqual([{ empresa_id: 4, rol: 'administrador' }]);
    });
    it('null o vacío devuelve lista vacía', () => {
        expect(empresasDeFilas(null, 'admin')).toEqual([]);
        expect(empresasDeFilas([], 'admin')).toEqual([]);
    });
});

describe('elegirEmpresaActiva', () => {
    it('sin empresas devuelve null', () => {
        expect(elegirEmpresaActiva([], '1', 1)).toBeNull();
    });
    it('prioriza ?empresa_id si el usuario tiene acceso', () => {
        expect(elegirEmpresaActiva(empresas, '2', 1)?.empresa_id).toBe(2);
    });
    it('ignora ?empresa_id ajeno o inválido y usa la última empresa', () => {
        expect(elegirEmpresaActiva(empresas, '99', 2)?.empresa_id).toBe(2);
        expect(elegirEmpresaActiva(empresas, 'abc', 2)?.empresa_id).toBe(2);
    });
    it('sin query ni última empresa usa la primera', () => {
        expect(elegirEmpresaActiva(empresas, undefined, null)?.empresa_id).toBe(1);
    });
});

describe('resolverRolAlta', () => {
    const admin = { es_super_admin: false, rol_empresa: 'administrador' as const };
    const dueno = { es_super_admin: false, rol_empresa: 'propietario' as const };
    const superAdmin = { es_super_admin: true, rol_empresa: 'propietario' as const };

    it('rol_empresa manda y el rol legacy se deriva', () => {
        expect(resolverRolAlta({ rol_empresa: 'contador' }, admin)).toEqual({ rol_empresa: 'contador', rol: 'empleado' });
        expect(resolverRolAlta({ rol_empresa: 'administrador' }, admin)).toEqual({ rol_empresa: 'administrador', rol: 'admin' });
    });
    it('solo con rol legacy usa su equivalente', () => {
        expect(resolverRolAlta({ rol: 'admin' }, admin)).toEqual({ rol_empresa: 'administrador', rol: 'admin' });
    });
    it('sin nada crea un empleado', () => {
        expect(resolverRolAlta({}, admin)).toEqual({ rol_empresa: 'empleado', rol: 'empleado' });
    });
    it('solo un propietario o super admin puede crear propietarios', () => {
        expect(() => resolverRolAlta({ rol_empresa: 'propietario' }, admin)).toThrow('propietario');
        expect(resolverRolAlta({ rol_empresa: 'propietario' }, dueno)).toEqual({ rol_empresa: 'propietario', rol: 'admin' });
        expect(resolverRolAlta({ rol_empresa: 'propietario' }, superAdmin)).toEqual({ rol_empresa: 'propietario', rol: 'admin' });
    });
    it('solo un super admin puede crear super admins', () => {
        expect(() => resolverRolAlta({ rol: 'super_admin' }, dueno)).toThrow('super_admin');
        expect(resolverRolAlta({ rol: 'super_admin' }, superAdmin)).toEqual({ rol_empresa: 'administrador', rol: 'super_admin' });
    });
});

describe('validarGestion', () => {
    const admin = { es_super_admin: false, rol_empresa: 'administrador' as const };
    const dueno = { es_super_admin: false, rol_empresa: 'propietario' as const };
    const superAdmin = { es_super_admin: true, rol_empresa: 'propietario' as const };
    const objetivo = (rol: any, sup = false) => ({ es_super_admin: sup, rol_empresa: rol });

    it('un administrador puede gestionar a administradores, contadores y empleados', () => {
        expect(() => validarGestion(admin, objetivo('administrador'))).not.toThrow();
        expect(() => validarGestion(admin, objetivo('contador'))).not.toThrow();
        expect(() => validarGestion(admin, objetivo('empleado'))).not.toThrow();
    });
    it('un administrador no puede gestionar a un propietario ni a un super admin', () => {
        expect(() => validarGestion(admin, objetivo('propietario'))).toThrow('propietario');
        expect(() => validarGestion(admin, objetivo('empleado', true))).toThrow('super_admin');
    });
    it('un propietario gestiona a otro propietario pero no a un super admin', () => {
        expect(() => validarGestion(dueno, objetivo('propietario'))).not.toThrow();
        expect(() => validarGestion(dueno, objetivo('empleado', true))).toThrow('super_admin');
    });
    it('un super admin gestiona a cualquiera', () => {
        expect(() => validarGestion(superAdmin, objetivo('propietario', true))).not.toThrow();
    });
});

describe('ampliarPropietario', () => {
    it('un propietario accede a todas las empresas activas como propietario, las suyas primero', () => {
        const r = ampliarPropietario([{ empresa_id: 3, rol: 'propietario' }, { empresa_id: 1, rol: 'contador' }], [5, 1, 2, 3]);
        expect(r).toEqual([
            { empresa_id: 3, rol: 'propietario' },
            { empresa_id: 1, rol: 'contador' },
            { empresa_id: 2, rol: 'propietario' },
            { empresa_id: 5, rol: 'propietario' },
        ]);
    });
    it('quien no es propietario en ninguna no gana acceso', () => {
        const propias = [{ empresa_id: 1, rol: 'administrador' as const }];
        expect(ampliarPropietario(propias, [1, 2, 3])).toBe(propias);
    });
});
