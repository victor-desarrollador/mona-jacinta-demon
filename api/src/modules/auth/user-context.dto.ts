import { hasPermission } from '../rbac/authorization-policy.js';
import { PRODUCTION_PERMISSIONS, type ProductionPermission } from '../rbac/permissions.js';
import { PERMISSIONS, type Permission } from '../../shared/permissions.js';

// Public API contract boundary (Phase 1D.1 compatibility fix, Phase 1D.3.6
// correction). The internal Express.AuthContext (assignments/
// effectiveLocationIds — see rbac/authorization-context.ts) is the
// Production-authorization-shaped model and must never leak directly through
// /auth/login or /auth/me: admin/ (admin/src/lib/api.ts's UserContext,
// admin/src/lib/auth.ts's user.permissions.includes(...)) and client/
// (client/src/app/page.tsx's user.roles/user.branchIds) were both built
// against the baseline contract { id, name, email, roles, branchIds,
// permissions } and must not require changes for a backend-only phase.
//
// Task 1D.3.6 deleted the compatibility-window `legacyPermissions` field
// entirely — this DTO's `permissions` output is now a NON-AUTHORITATIVE
// PUBLIC COMPATIBILITY PROJECTION of the caller's current Production
// authority (via authorization-policy.ts's centralized hasPermission), never
// backend authorization authority itself and never derived from
// UserBranchRole/legacy RolePermission grants. See
// PUBLIC_PERMISSION_COMPATIBILITY_MAP below for the explicit, frozen 1:1
// mapping this projects through.
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

type InternalContextSlice = Pick<Express.AuthContext, 'effectiveLocationIds' | 'assignments'>;

// The only 12 legacy concepts with a 1:1 Production equivalent
// (shared/permissions.ts <-> rbac/permissions.ts). Explicit and frozen —
// never a dynamic lowercase transform of a Production code — so a future
// Production permission with no legacy/public equivalent can never leak into
// this compatibility contract by accident. Order is the deterministic public
// ordering of the projected `permissions` array.
const PUBLIC_PERMISSION_COMPATIBILITY_MAP: ReadonlyArray<readonly [ProductionPermission, Permission]> = [
  [PRODUCTION_PERMISSIONS.SALE_CREATE, PERMISSIONS.SALE_CREATE],
  [PRODUCTION_PERMISSIONS.SALE_CHARGE, PERMISSIONS.SALE_CHARGE],
  [PRODUCTION_PERMISSIONS.SALE_COMPLETE, PERMISSIONS.SALE_COMPLETE],
  [PRODUCTION_PERMISSIONS.SALE_VIEW, PERMISSIONS.SALE_VIEW],
  [PRODUCTION_PERMISSIONS.SALE_QUEUE_VIEW, PERMISSIONS.SALE_QUEUE_VIEW],
  [PRODUCTION_PERMISSIONS.INVENTORY_VIEW, PERMISSIONS.INVENTORY_VIEW],
  [PRODUCTION_PERMISSIONS.INVENTORY_MANAGE, PERMISSIONS.INVENTORY_MANAGE],
  [PRODUCTION_PERMISSIONS.CASH_SESSION_OPEN, PERMISSIONS.CASH_SESSION_OPEN],
  [PRODUCTION_PERMISSIONS.CASH_SESSION_CLOSE, PERMISSIONS.CASH_SESSION_CLOSE],
  [PRODUCTION_PERMISSIONS.USER_MANAGE, PERMISSIONS.USER_MANAGE],
  [PRODUCTION_PERMISSIONS.REPORT_VIEW, PERMISSIONS.REPORT_VIEW],
  [PRODUCTION_PERMISSIONS.AUDIT_VIEW, PERMISSIONS.AUDIT_VIEW],
];

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
    // hasPermission already owns OWNER implicit authority, canonical
    // assignment qualification, and COMPANY-required policy where relevant —
    // reused here rather than reading assignment.permissions unions directly
    // so OWNER (zero RolePermission rows) still projects every mapped code.
    permissions: PUBLIC_PERMISSION_COMPATIBILITY_MAP
      .filter(([productionPermission]) => hasPermission(context, productionPermission))
      .map(([, legacyPublicPermission]) => legacyPublicPermission),
  };
}
