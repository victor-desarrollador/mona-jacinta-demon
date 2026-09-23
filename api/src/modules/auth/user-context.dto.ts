import { hasPermission } from '../rbac/authorization-policy.js';
import { PRODUCTION_PERMISSIONS, type ProductionPermission } from '../rbac/permissions.js';
import { PERMISSIONS, type Permission } from '../../shared/permissions.js';
import { roleCodeValues } from '../rbac/roles.js';

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

// D3 (Demo Operativa V1): additive extension for the admin catalogue/stock
// UI. These Production codes have no legacy/public equivalent, so they are
// projected verbatim, appended after the frozen compatibility strings above
// (which stay unchanged and in their original order). Explicit and closed —
// still never a dynamic dump of every Production permission. Projection
// only: server-side requirePermission remains authoritative.
const PUBLIC_PRODUCTION_PERMISSION_PROJECTION: readonly ProductionPermission[] = [
  PRODUCTION_PERMISSIONS.PRODUCT_MANAGE,
  PRODUCTION_PERMISSIONS.PRODUCT_VARIANT_MANAGE,
  PRODUCTION_PERMISSIONS.PRICE_MANAGE,
  PRODUCTION_PERMISSIONS.IMPORT_RUN,
];

// D1 (Phase 1 Global Closeout): `roles` now derives exclusively from the
// caller's Production `assignments` (authorization-context.ts already
// guarantees every entry there passed `isProductionRoleCode` — legacy
// `MANAGER` can never appear in `assignments`, so no extra filtering is
// needed here). This replaces the pre-D1 contract, which derived `roles`
// from `UserBranchRole` only and returned an empty array for any canonical
// Production user with zero legacy rows (e.g. a corrected OWNER/ADMIN) —
// a confirmed compatibility bug, not an authorization bug (backend
// enforcement never read this field). `user.branchRoles` is kept on
// `PublicUserContextSource` only because every existing call site still
// supplies it; it no longer contributes to this projection.
//
// Review correction: the projected `roles` array is deduplicated AND
// ordered by the canonical Production role catalog (`roleCodeValues`,
// rbac/roles.ts: OWNER, ADMIN, CASHIER, SELLER, WAREHOUSE), never by
// UserRoleScope row/database order, so a multi-role caller gets a
// deterministic response regardless of assignment insertion order.
export function toPublicUserContext(
  user: PublicUserContextSource,
  context: InternalContextSlice,
): PublicUserContext {
  const presentRoleCodes = new Set(context.assignments.map((assignment) => assignment.roleCode));
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    roles: roleCodeValues.filter((code) => presentRoleCodes.has(code)),
    branchIds: context.effectiveLocationIds,
    // hasPermission already owns OWNER implicit authority, canonical
    // assignment qualification, and COMPANY-required policy where relevant —
    // reused here rather than reading assignment.permissions unions directly
    // so OWNER (zero RolePermission rows) still projects every mapped code.
    permissions: [
      ...PUBLIC_PERMISSION_COMPATIBILITY_MAP
        .filter(([productionPermission]) => hasPermission(context, productionPermission))
        .map(([, legacyPublicPermission]) => legacyPublicPermission),
      ...PUBLIC_PRODUCTION_PERMISSION_PROJECTION.filter((permission) => hasPermission(context, permission)),
    ],
  };
}
