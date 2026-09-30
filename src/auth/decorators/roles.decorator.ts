import { SetMetadata } from '@nestjs/common';

export type RolUsuario = 'super_admin' | 'admin' | 'empleado';

export const ROLES_KEY = 'roles';
export const Roles = (...roles: RolUsuario[]) => SetMetadata(ROLES_KEY, roles);