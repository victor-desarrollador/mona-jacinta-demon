import { permissionValues } from '../../shared/permissions.js';
import { productionPermissionValues } from './permissions.js';
import { resolveEffectiveLocationIds, type LocationLookupDatabase } from './effective-branch-ids.js';
import { mapUserRoleScopeRows } from './scope-resolver.js';
import { isProductionRoleCode } from './roles.js';

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

// Phase 1D.2: the only database access this module needs — resolving
// effectiveLocationIds for a COMPANY-kind UserRoleScope row (Cross-cutting
// design §C). Reused directly from effective-branch-ids.ts rather than
// redefined, since it is the same narrow need.
export type AuthorizationContextDatabase = LocationLookupDatabase;

// Phase 1D.1/1D.2 (assignment-shaped, per
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
// authorization-policy.ts's hasPermissionAtLocation, the only function
// allowed to reason about permission+location together. A COMPANY-kind row
// is preserved exactly as-is (scopeKind: 'COMPANY', locationId: null) in
// `assignments` — it is never rewritten into a LOCATION entry and never
// given a fabricated location id (Cross-cutting §C).
export async function buildAuthorizationContext(
  db: AuthorizationContextDatabase,
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

  // Phase 1D.2: COMPANY is now a qualifying assignment, not a thrown error.
  // resolveEffectiveLocationIds expands to every active Location id for a
  // COMPANY-kind row — display/filter convenience only, never authorization
  // authority (see effective-branch-ids.ts and Cross-cutting design §C).
  const effectiveLocationIds = await resolveEffectiveLocationIds(db, mapUserRoleScopeRows(user.roleScopes));

  // Fix (review correction): a persisted UserRoleScope row's Role.code must
  // be validated against the canonical Production role catalog
  // (isProductionRoleCode, roles.ts) at runtime, not merely cast. `MANAGER`
  // (legacy-only) or any unknown/future value must never become a
  // ProductionAssignment — a TS type assertion alone cannot enforce this
  // against real, persisted data. Fails closed per row: an invalid row is
  // skipped entirely; it does not affect any other row's assignment.
  const assignments: Express.ProductionAssignment[] = [];
  for (const scope of user.roleScopes) {
    const roleCode = scope.role.code;
    if (!isProductionRoleCode(roleCode)) continue;
    assignments.push({
      roleId: scope.roleId,
      roleCode,
      scopeKind: scope.scopeKind,
      locationId: scope.locationId,
      permissions: scope.role.permissions
        .map((p) => p.permission.code)
        .filter((code) => PRODUCTION_PERMISSION_CODES.has(code)),
    });
  }

  return { userId: user.id, roles, legacyPermissions, assignments, effectiveLocationIds };
}
