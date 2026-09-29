import { SetMetadata } from '@nestjs/common';
import { RolEmpresa } from '../roles-empresa';

export const ROLES_EMPRESA_KEY = 'roles_empresa';

// Restringe un endpoint a ciertos roles POR EMPRESA (el que tiene el usuario en
// la empresa activa del request). Se usa con RolesEmpresaGuard, después de
// JwtAuthGuard. El super admin siempre pasa.
export const RolesEmpresa = (...roles: RolEmpresa[]) => SetMetadata(ROLES_EMPRESA_KEY, roles);
