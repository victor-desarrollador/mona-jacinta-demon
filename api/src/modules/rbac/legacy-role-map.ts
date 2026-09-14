import { ROLE_CODES, type RoleCode } from './roles.js';

// Phase 1C (Production V1) explicit legacy -> Production role mapping for the
// UserBranchRole -> UserRoleScope backfill. docs/production-v1/06-erd-data-model.md
// §2.2 ROLE: "REUSED (codes changed: MANAGER→WAREHOUSE)" — ADMIN/CASHIER/SELLER
// keep their own code; MANAGER is not a Production V1 role
// (docs/production-v1/00-master-index.md) and maps to WAREHOUSE. This is the
// only place that mapping is allowed to live: the backfill must never guess a
// target role from permissions, branch, or any other heuristic (Phase 1C
// spec: "MANAGER handled explicitly, not guessed").
export const LEGACY_ROLE_CODE_TO_PRODUCTION_ROLE_CODE: Record<string, RoleCode> = {
  ADMIN: ROLE_CODES.ADMIN,
  CASHIER: ROLE_CODES.CASHIER,
  SELLER: ROLE_CODES.SELLER,
  MANAGER: ROLE_CODES.WAREHOUSE,
};

// Fails closed on any legacy Role code this map does not explicitly cover
// (e.g. OWNER/WAREHOUSE should never appear on a legacy UserBranchRole row,
// and any other unexpected code is corrupt/unplanned-for state) rather than
// silently skipping it or picking a default.
export function resolveProductionRoleCodeForLegacy(legacyRoleCode: string): RoleCode {
  const mapped = LEGACY_ROLE_CODE_TO_PRODUCTION_ROLE_CODE[legacyRoleCode];
  if (!mapped) {
    throw new Error(
      `No explicit Production role mapping for legacy UserBranchRole role code "${legacyRoleCode}"; ` +
        `refusing to guess one (Phase 1C requires an explicit mapping for every legacy role)`,
    );
  }
  return mapped;
}
