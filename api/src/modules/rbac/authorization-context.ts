import { productionPermissionValues } from './permissions.js';
import { resolveEffectiveLocationIds, type LocationLookupDatabase } from './effective-branch-ids.js';
import { mapUserRoleScopeRows } from './scope-resolver.js';
import { isProductionRoleCode } from './roles.js';

const PRODUCTION_PERMISSION_CODES = new Set<string>(productionPermissionValues);

type PermissionRow = { permission: { code: string } };
// Phase 1D.3.6: UserBranchRole contributes only role.code, merged below into
// the internal AuthContext.roles union (legacy ∪ Production, kept for
// internal compatibility/display only — see the D1 note on `roles` below) —
// it can never again contribute a permission of any kind, legacy or
// Production. This is now a type-level guarantee, not merely a runtime
// filter.
type LegacyBranchRoleRow = { role: { code: string } };
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

// Phase 1D.1/1D.2/1D.3.6 (assignment-shaped, per
// docs/superpowers/plans/2026-09-14-phase-1d-production-authorization.md's
// Cross-cutting design §A/§B/§D): single shared source for req.auth/
// socket.data, replacing the three duplicated inline implementations in
// middleware/auth.ts, modules/auth/auth.service.ts and realtime/socket.ts.
// Task 1D.3.6 deleted the compatibility-window `legacyPermissions` field and
// its computation outright — every route switched to Production
// `assignments` by then (Tasks 1D.3.1-1D.3.5), so UserBranchRole no longer
// contributes any permission authority at all (only role.code, merged into
// the internal AuthContext.roles union — see the D1 note on `roles` below).
// `assignments` holds one entry per UserRoleScope
// row, untouched/unmerged, so a caller with multiple assignments (e.g.
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
  // D1 (Phase 1 Global Closeout): this `roles` union is INTERNAL only — kept
  // for backward-compatible internal consumers, not the public API. It may
  // still contain a legacy-only code (e.g. MANAGER) alongside Production
  // codes; nothing downstream may treat it as public Production authority.
  // Public `roles` are projected exclusively from `assignments`
  // (user-context.dto.ts's toPublicUserContext), never from this field.
  // UserRoleScope remains the sole Production role/permission authority;
  // UserBranchRole contributes nothing to it.
  const roles = [
    ...new Set([
      ...user.branchRoles.map((row) => row.role.code),
      ...user.roleScopes.map((scope) => scope.role.code),
    ]),
  ];

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

  return { userId: user.id, roles, assignments, effectiveLocationIds };
}
