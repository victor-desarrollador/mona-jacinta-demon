import type { RequestHandler } from 'express';
import { AppError } from '../shared/errors.js';
import type { Permission } from '../shared/permissions.js';
import type { ProductionPermission } from '../modules/rbac/permissions.js';
import { hasBranchAccess, hasPermission, hasPermissionAtLocation } from '../modules/rbac/authorization-policy.js';

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
  return req.auth.effectiveLocationIds;
}

// Phase 1D.2 (docs/superpowers/plans/2026-09-14-phase-1d-production-
// authorization.md Task 1D.2.4): coarse membership only, through the
// centralized policy's hasBranchAccess over req.auth.assignments — never
// req.auth.effectiveLocationIds directly. No permission is attached; keep
// this only for the small set of call sites with no specific permission
// behind them (Task 1D.5.3's cash GET routes are the intended long-term
// survivor). Prefer assertPermissionAtLocation below wherever a specific
// permission is known.
export function assertBranchAccess(req: Parameters<RequestHandler>[0], branchId: string): void {
  if (!req.auth) throw new AppError(401, 'UNAUTHORIZED', 'Se requiere autenticación.');
  if (!hasBranchAccess(req.auth, branchId)) throw forbidden();
}

// The permission-paired equivalent, for manual service-level rechecks that
// are actually standing in for a route's location-scoped Production
// permission gate (Phase 1D.3's per-route conversions call this instead of
// assertBranchAccess wherever a specific permission is already known).
export function assertPermissionAtLocation(
  req: Parameters<RequestHandler>[0],
  permission: ProductionPermission,
  branchId: string,
): void {
  if (!req.auth) throw new AppError(401, 'UNAUTHORIZED', 'Se requiere autenticación.');
  if (!hasPermissionAtLocation(req.auth, permission, branchId)) throw forbidden();
}

// Production-only (Phase 1D.2 split). Reads exclusively req.auth.assignments,
// through authorization-policy.ts's hasPermission/hasPermissionAtLocation —
// never req.auth.legacyPermissions. Every route not yet switched to
// Production keeps using requireLegacyPermission below until its own Phase
// 1D.3 task lands; this function must never accept or check a legacy
// lowercase permission code.
export function requirePermission(
  permission: ProductionPermission,
  options: PermissionOptions = {},
): RequestHandler {
  const branchScope = options.branchScope ?? 'global';
  return async (req, _res, next) => {
    try {
      if (!req.auth) throw new AppError(401, 'UNAUTHORIZED', 'Se requiere autenticación.');

      if (branchScope === 'global') {
        if (!hasPermission(req.auth, permission)) throw forbidden();
        next();
        return;
      }

      if (!options.resolveResourceBranch) {
        throw forbidden('No se pudo resolver el alcance de la sucursal.');
      }
      const resourceBranchId = await options.resolveResourceBranch(req);
      if (!resourceBranchId) throw forbidden('No se pudo resolver el alcance de la sucursal.');
      if (!hasPermissionAtLocation(req.auth, permission, resourceBranchId)) throw forbidden();
      next();
    } catch (error) {
      next(error instanceof AppError ? error : forbidden());
    }
  };
}

// Compatibility-window ONLY (Cross-cutting design §D of the Phase 1D plan) —
// reads exclusively req.auth.legacyPermissions and req.auth.effectiveLocationIds,
// NEVER req.auth.assignments. Reproduces exactly the pre-split
// requirePermission behavior (legacy permission gate, paired with an
// effectiveLocationIds-based branch-scope check for branchScope 'own'/'any')
// for every route not yet switched to Production, so route behavior is
// unchanged by this rename. Deleted outright at Task 1D.3.6, once every
// route has switched — never merely stopped being called.
export function requireLegacyPermission(
  permission: Permission,
  options: PermissionOptions = {},
): RequestHandler {
  const branchScope = options.branchScope ?? 'global';
  return async (req, _res, next) => {
    try {
      if (!req.auth) throw new AppError(401, 'UNAUTHORIZED', 'Se requiere autenticación.');
      if (!req.auth.legacyPermissions.includes(permission)) throw forbidden();

      if (branchScope !== 'global') {
        if (!options.resolveResourceBranch) {
          throw forbidden('No se pudo resolver el alcance de la sucursal.');
        }
        const resourceBranchId = await options.resolveResourceBranch(req);
        if (!resourceBranchId) throw forbidden('No se pudo resolver el alcance de la sucursal.');
        if (!req.auth.effectiveLocationIds.includes(resourceBranchId)) throw forbidden();
      }
      next();
    } catch (error) {
      next(error instanceof AppError ? error : forbidden());
    }
  };
}
