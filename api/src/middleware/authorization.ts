import type { RequestHandler } from 'express';
import { AppError } from '../shared/errors.js';
import type { Permission } from '../shared/permissions.js';

export type BranchScope = 'own' | 'any' | 'global';
export type ResourceBranchResolver = (
  req: Parameters<RequestHandler>[0],
) => string | undefined | Promise<string | undefined>;

export type PermissionOptions = {
  branchScope?: BranchScope;
  resolveResourceBranch?: ResourceBranchResolver;
};

function forbidden(message = 'No cuenta con permisos para esta operación.') {
  return new AppError(403, 'FORBIDDEN', message);
}

export function getUserBranchScope(req: Parameters<RequestHandler>[0]): string[] {
  if (!req.auth) throw new AppError(401, 'UNAUTHORIZED', 'Se requiere autenticación.');
  return req.auth.branchIds;
}

export function assertBranchAccess(
  req: Parameters<RequestHandler>[0],
  branchId: string,
): void {
  if (!branchId || !getUserBranchScope(req).includes(branchId)) throw forbidden();
}

export function requirePermission(
  permission: Permission,
  options: PermissionOptions = {},
): RequestHandler {
  const branchScope = options.branchScope ?? 'global';
  return async (req, _res, next) => {
    try {
      if (!req.auth) throw new AppError(401, 'UNAUTHORIZED', 'Se requiere autenticación.');
      if (!req.auth.permissions.includes(permission)) throw forbidden();

      if (branchScope !== 'global') {
        if (!options.resolveResourceBranch) {
          throw forbidden('No se pudo resolver el alcance de la sucursal.');
        }
        const resourceBranchId = await options.resolveResourceBranch(req);
        if (!resourceBranchId) throw forbidden('No se pudo resolver el alcance de la sucursal.');
        assertBranchAccess(req, resourceBranchId);
      }
      next();
    } catch (error) {
      next(error instanceof AppError ? error : forbidden());
    }
  };
}