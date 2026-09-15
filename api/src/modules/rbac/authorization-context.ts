import { permissionValues } from '../../shared/permissions.js';
import { productionPermissionValues } from './permissions.js';
import { resolveEffectiveBranchIds } from './effective-branch-ids.js';
import { mapUserRoleScopeRows } from './scope-resolver.js';

const LEGACY_PERMISSION_CODES = new Set<string>(permissionValues);
const PRODUCTION_PERMISSION_CODES = new Set<string>(productionPermissionValues);

type PermissionRow = { permission: { code: string } };
type LegacyBranchRoleRow = { role: { code: string; permissions: PermissionRow[] } };
type ProductionRoleScopeRow = {
  roleId: string;
  scopeKind: 'LOCATION' | 'COMPANY';
  locationId: string | null;
  role: { code: string; permissions: PermissionRow[] };
};

export type AuthorizationContextInput = {
  id: string;
  branchRoles: LegacyBranchRoleRow[];
  roleScopes: ProductionRoleScopeRow[];
};

// Phase 1D.1 (assignment-shaped, per
// docs/superpowers/plans/2026-09-14-phase-1d-production-authorization.md's
// Cross-cutting design §A/§B/§D): single shared source for req.auth/
// socket.data, replacing the three duplicated inline implementations in
// middleware/auth.ts, modules/auth/auth.service.ts and realtime/socket.ts.
// `legacyPermissions` and `assignments` are built from independently
// filtered code sets (§D) so a Role row that carries BOTH the legacy
// lowercase and Production uppercase RolePermission grants for the same
// permission concept can never leak the wrong vocabulary through the wrong
// join table. `assignments` holds one entry per UserRoleScope row,
// untouched/unmerged, so a caller with multiple assignments (e.g.
// SELLER @ A + WAREHOUSE @ B) can never have a permission from one
// assignment combine with a location from another — see
// authorization-policy.ts's hasPermissionAtLocation (Phase 1D.2), the only
// function allowed to reason about permission+location together.
export async function buildAuthorizationContext(
  user: AuthorizationContextInput,
): Promise<Express.AuthContext> {
  const roles = [
    ...new Set([
      ...user.branchRoles.map((row) => row.role.code),
      ...user.roleScopes.map((scope) => scope.role.code),
    ]),
  ];

  const legacyPermissions = [
    ...new Set(
      user.branchRoles.flatMap((row) => row.role.permissions.map((p) => p.permission.code)),
    ),
  ].filter((code) => LEGACY_PERMISSION_CODES.has(code));

  // Still throws on COMPANY (Phase 1C behavior, unchanged) — Phase 1D.2
  // replaces this call with the COMPANY-aware resolver and builds the
  // COMPANY ProductionAssignment entry itself. For LOCATION-only scopes this
  // is exactly the same effective-location set the pre-1D.1 branchIds field
  // carried — effectiveLocationIds must stay a real, non-empty array here
  // (never hardcoded to []), since it remains the sole location-filtering
  // input for every current consumer until those consumers migrate to
  // assignment-based checks in later phases.
  const effectiveLocationIds = resolveEffectiveBranchIds(mapUserRoleScopeRows(user.roleScopes));

  const assignments = user.roleScopes.map((scope) => ({
    roleId: scope.roleId,
    roleCode: scope.role.code as Express.AuthContext['assignments'][number]['roleCode'],
    scopeKind: scope.scopeKind,
    locationId: scope.locationId,
    permissions: scope.role.permissions
      .map((p) => p.permission.code)
      .filter((code) => PRODUCTION_PERMISSION_CODES.has(code)),
  }));

  return { userId: user.id, roles, legacyPermissions, assignments, effectiveLocationIds };
}
