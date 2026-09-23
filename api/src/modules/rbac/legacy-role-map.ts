import { ROLE_CODES, type RoleCode } from './roles.js';

// Phase 1C (Production V1) explicit legacy -> Production migration
// classification for the UserBranchRole -> UserRoleScope backfill.
//
// D2.1 (2026-09-20 human-approved supersession, recorded in AGENTS.md
// "Roles — Production V1"): the historical Phase 1C interpretation mapped
// legacy MANAGER rows automatically to WAREHOUSE. That mapping is
// SUPERSEDED. MANAGER is now an explicit DEFERRED disposition — it never
// resolves to a Production role code, automatically or otherwise. This
// supersession changes migration identity semantics only; it does not
// remove WAREHOUSE from Production V1 (WAREHOUSE is provisioned
// independently, as a native Production role/assignment — see D2.2).
//
// ADMIN/CASHIER/SELLER keep their own code (ELIGIBLE). Any legacy role code
// with no explicit ELIGIBLE or DEFERRED classification fails closed — this
// module never guesses a disposition from permissions, branch, or any other
// heuristic (Phase 1C spec: "MANAGER handled explicitly, not guessed").
export type LegacyRoleDisposition =
  | { kind: 'ELIGIBLE'; productionRoleCode: RoleCode }
  | { kind: 'DEFERRED'; reason: 'LEGACY_MANAGER' };

// Eligible legacy codes only. MANAGER is deliberately absent from this
// table — it is classified via the explicit DEFERRED branch in
// resolveLegacyRoleDisposition below, never through this map, so there is no
// path in this module that can produce MANAGER -> WAREHOUSE.
export const LEGACY_ROLE_CODE_TO_PRODUCTION_ROLE_CODE: Record<string, RoleCode> = {
  ADMIN: ROLE_CODES.ADMIN,
  CASHIER: ROLE_CODES.CASHIER,
  SELLER: ROLE_CODES.SELLER,
};

// Fails closed on any legacy Role code this function does not explicitly
// classify (e.g. OWNER/WAREHOUSE should never appear on a legacy
// UserBranchRole row, and any other unexpected code is corrupt/unplanned-for
// state) rather than silently skipping it or picking a default.
export function resolveLegacyRoleDisposition(legacyRoleCode: string): LegacyRoleDisposition {
  if (legacyRoleCode === 'MANAGER') {
    return { kind: 'DEFERRED', reason: 'LEGACY_MANAGER' };
  }
  const mapped = LEGACY_ROLE_CODE_TO_PRODUCTION_ROLE_CODE[legacyRoleCode];
  if (!mapped) {
    throw new Error(
      `No explicit Production role mapping or deferral for legacy UserBranchRole role code "${legacyRoleCode}"; ` +
        `refusing to guess one (Phase 1C requires an explicit classification for every legacy role)`,
    );
  }
  return { kind: 'ELIGIBLE', productionRoleCode: mapped };
}
