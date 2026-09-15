// Public API contract boundary (Phase 1D.1 compatibility fix). The internal
// Express.AuthContext (assignments/legacyPermissions/effectiveLocationIds —
// see rbac/authorization-context.ts) is the Production-authorization-shaped
// model and must never leak directly through /auth/login or /auth/me:
// admin/ (admin/src/lib/api.ts's UserContext, admin/src/lib/auth.ts's
// user.permissions.includes(...)) and client/ (client/src/app/page.tsx's
// user.roles/user.branchIds) were both built against the baseline contract
// { id, name, email, roles, branchIds, permissions } and must not require
// changes for a backend-only phase.
export type PublicUserContext = {
  id: string;
  name: string;
  email: string;
  roles: string[];
  branchIds: string[];
  permissions: string[];
};

type LegacyBranchRoleRow = { role: { code: string } };

export type PublicUserContextSource = {
  id: string;
  name: string;
  email: string;
  branchRoles: LegacyBranchRoleRow[];
};

type InternalContextSlice = Pick<Express.AuthContext, 'effectiveLocationIds' | 'legacyPermissions'>;

// `roles` here intentionally preserves its PRE-1D.1 semantics — derived from
// UserBranchRole only — NOT the internal AuthContext.roles union (legacy ∪
// Production role codes, the MANAGER->WAREHOUSE desync fix). The frontend's
// role-display/gating logic was built against the old, UserBranchRole-only
// meaning, and Phase 1D.1 must not silently change it.
export function toPublicUserContext(
  user: PublicUserContextSource,
  context: InternalContextSlice,
): PublicUserContext {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    roles: [...new Set(user.branchRoles.map((row) => row.role.code))],
    branchIds: context.effectiveLocationIds,
    permissions: context.legacyPermissions,
  };
}
