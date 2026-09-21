import { BadRequestException, ForbiddenException } from '@nestjs/common';

// Reemplaza el "resolverEmpresaId" que antes vivía duplicado, casi igual,
// dentro de CategoriasController y ProveedoresController (Paso 33). Hasta
// ahora un admin/empleado tenía una sola empresa en su JWT
// (req.user.empresa_id) y se usaba directo, sin preguntar nada. Ahora el
// JWT lleva `empresa_ids: number[]` (puede ser más de una), así que hay
// que validar que la empresa pedida esté en esa lista, no asumirla.
//
// Variante "obligatoria": para catálogos donde "ver todo mezclado" no es
// un caso de uso real (categorías, proveedores, empresas) -- si el usuario
// tiene más de una empresa, siempre debe indicar cuál con ?empresa_id=,
// mismo criterio que ya se le exigía solo a super_admin antes de este paso.
export function resolverEmpresaId(
    req: { user: { rol: string; empresa_ids: number[] } },
    empresaIdQuery?: string,
): number {
    const empresaIds = req.user.empresa_ids ?? [];

    if (req.user.rol === 'super_admin') {
        const id = empresaIdQuery ? Number(empresaIdQuery) : undefined;
        if (!id) {
            throw new BadRequestException('Como super_admin, indica ?empresa_id= para elegir una empresa.');
        }
        return id;
    }

    if (empresaIds.length === 0) {
        throw new ForbiddenException('Tu usuario no tiene ninguna empresa asignada.');
    }
    // Compatibilidad: si solo tiene una empresa, se usa directo sin pedir
    // el query param -- mismo comportamiento que existía antes de este
    // paso, cuando cada usuario tenía una sola empresa.
    if (empresaIds.length === 1 && !empresaIdQuery) {
        return empresaIds[0];
    }
    const id = empresaIdQuery ? Number(empresaIdQuery) : undefined;
    if (!id) {
        throw new BadRequestException('Tienes acceso a varias empresas: indica ?empresa_id= para elegir una.');
    }
    if (!empresaIds.includes(id)) {
        throw new ForbiddenException('No tienes acceso a esa empresa.');
    }
    return id;
}

// Variante "filtro opcional": para listados donde ver varias empresas
// mezcladas SÍ tiene sentido (gastos). super_admin sin query ve todo
// (undefined = sin filtro); admin/empleado sin query ve todas las
// empresas a las que tiene acceso (empresaIds completo, como filtro "IN");
// con query, se acota a esa sola si el usuario tiene acceso a ella.
// Paso 38: el super_admin ya NO tiene vista global ("todas las empresas
// mezcladas") -- opera sobre una sola empresa a la vez, igual que
// resolverEmpresaId, y ?empresa_id= pasa a ser obligatorio para él (antes
// era opcional y, sin mandarlo, devolvía `undefined` = sin filtro = veía
// todo). Ya nunca devuelve `undefined`, así que ningún endpoint de gastos
// puede quedar sin filtro de empresa.
export function resolverEmpresaIdFiltro(
    req: { user: { rol: string; empresa_ids: number[] } },
    empresaIdQuery?: string,
): number | number[] {
    const empresaIds = req.user.empresa_ids ?? [];

    if (req.user.rol === 'super_admin') {
        const id = empresaIdQuery ? Number(empresaIdQuery) : NaN;
        if (!id || !Number.isInteger(id) || id <= 0) {
            throw new BadRequestException('Como super_admin, indica ?empresa_id= para elegir una empresa.');
        }
        return id;
    }

    if (empresaIdQuery) {
        const id = Number(empresaIdQuery);
        if (!empresaIds.includes(id)) {
            throw new ForbiddenException('No tienes acceso a esa empresa.');
        }
        return id;
    }

    // Hallazgo 38.3: un admin/empleado sin ninguna empresa asignada
    // (empresa_ids = []) devolvía [] acá, y aplicarFiltroEmpresa trataba
    // un array vacío como "sin filtro" -- veía los gastos de TODAS las
    // empresas. Ahora se rechaza antes de llegar a esa función.
    if (empresaIds.length === 0) {
        throw new ForbiddenException('Tu usuario no tiene ninguna empresa asignada.');
    }
    return empresaIds;
}