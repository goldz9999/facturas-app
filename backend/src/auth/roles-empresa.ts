import { ForbiddenException } from '@nestjs/common';

// Rol por empresa (usuario_empresas.rol). El rol "legacy" de req.user.rol
// (super_admin | admin | empleado) se DERIVA de la empresa activa para que
// RolesGuard, UsuariosController, el gateway y Telegram sigan funcionando
// sin reescribirse.

export const ROLES_EMPRESA = ['propietario', 'administrador', 'supervisor', 'contador', 'empleado'] as const;
export type RolEmpresa = (typeof ROLES_EMPRESA)[number];

export interface EmpresaRol {
    empresa_id: number;
    rol: RolEmpresa;
}

export type RolLegacy = 'super_admin' | 'admin' | 'empleado';

export function esRolEmpresa(v: unknown): v is RolEmpresa {
    return typeof v === 'string' && (ROLES_EMPRESA as readonly string[]).includes(v);
}

// El flag es_super_admin es la fuente nueva; usuarios.rol = 'super_admin'
// se sigue respetando mientras exista la columna legacy.
export function esSuperAdmin(fila: { es_super_admin?: boolean | null; rol: string }): boolean {
    return !!fila.es_super_admin || fila.rol === 'super_admin';
}

export function rolLegacy(esSuper: boolean, rolEmpresa: RolEmpresa | null): RolLegacy {
    if (esSuper) return 'super_admin';
    return rolEmpresa === 'propietario' || rolEmpresa === 'administrador' ? 'admin' : 'empleado';
}

export function rolEmpresaDesdeLegacy(rol: string): RolEmpresa {
    if (rol === 'admin' || rol === 'super_admin') return 'administrador';
    return 'empleado';
}

// Al editar el rol legacy de un usuario no se pisa un rol fino (p. ej.
// contador) si la clase legacy resultante es la misma.
export function rolEmpresaActualizado(actual: RolEmpresa, legacyNuevo: string): RolEmpresa {
    return rolLegacy(false, actual) === legacyNuevo ? actual : rolEmpresaDesdeLegacy(legacyNuevo);
}

export function empresasDeFilas(
    filas: { empresa_id: number; rol?: string | null }[] | null,
    rolGlobal: string,
): EmpresaRol[] {
    return (filas ?? []).map((f) => ({
        empresa_id: f.empresa_id,
        rol: esRolEmpresa(f.rol) ? f.rol : rolEmpresaDesdeLegacy(rolGlobal),
    }));
}

export function elegirEmpresaActiva(
    empresas: EmpresaRol[],
    empresaIdQuery: string | undefined,
    ultimaEmpresaId: number | null,
): EmpresaRol | null {
    if (empresas.length === 0) return null;
    const q = empresaIdQuery ? Number(empresaIdQuery) : NaN;
    if (Number.isInteger(q)) {
        const porQuery = empresas.find((e) => e.empresa_id === q);
        if (porQuery) return porQuery;
    }
    if (ultimaEmpresaId != null) {
        const porUltima = empresas.find((e) => e.empresa_id === ultimaEmpresaId);
        if (porUltima) return porUltima;
    }
    return empresas[0];
}

// Decide el rol con el que se da de alta a un usuario nuevo y valida que quien
// lo crea pueda otorgarlo. `rol_empresa` (rol fino) manda; si solo viene el rol
// legacy se usa su equivalente. El rol legacy guardado en usuarios.rol se deriva.
export function resolverRolAlta(
    dto: { rol?: string; rol_empresa?: RolEmpresa },
    quien: { es_super_admin: boolean; rol_empresa: RolEmpresa | null },
): { rol_empresa: RolEmpresa; rol: string } {
    if (dto.rol === 'super_admin' && !quien.es_super_admin) {
        throw new ForbiddenException('Solo un super_admin puede crear otro super_admin');
    }
    const rolEmpresa = dto.rol_empresa ?? rolEmpresaDesdeLegacy(dto.rol ?? 'empleado');
    if (rolEmpresa === 'propietario' && !quien.es_super_admin && quien.rol_empresa !== 'propietario') {
        throw new ForbiddenException('Solo un propietario puede crear otro propietario');
    }
    return { rol_empresa: rolEmpresa, rol: dto.rol === 'super_admin' ? 'super_admin' : rolLegacy(false, rolEmpresa) };
}

// Quien modifica/desactiva/elimina a otro usuario dentro de una empresa no puede
// tocar a alguien con más privilegio: un administrador no gestiona propietarios
// ni super admins (cambiar su correo/contraseña equivaldría a tomar su cuenta).
export function validarGestion(
    quien: { es_super_admin: boolean; rol_empresa: RolEmpresa | null },
    objetivo: { es_super_admin: boolean; rol_empresa: RolEmpresa | null },
): void {
    if (quien.es_super_admin) return;
    if (objetivo.es_super_admin) {
        throw new ForbiddenException('No puedes modificar a un super_admin');
    }
    if (objetivo.rol_empresa === 'propietario' && quien.rol_empresa !== 'propietario') {
        throw new ForbiddenException('Solo un propietario puede modificar a otro propietario');
    }
}
