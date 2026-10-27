// Phase 1B (Production V1) role catalog. docs/production-v1/03-role-permission-matrix.md
// §"Roles": "Roles are stored in the `Role` table (`code` values: `SELLER`,
// `CASHIER`, `WAREHOUSE`, `ADMIN`, `OWNER`)." No `MANAGER` — the Demo V2
// `MANAGER` role code stays in the existing `Role` table as historical data
// (docs/production-v1/00-master-index.md: "MANAGER may exist historically but
// is not a Production V1 business role") until Phase 1C's UserBranchRole ->
// UserRoleScope migration addresses it. These constants are domain
// definitions only; Phase 1B does not seed or migrate `Role` rows.
export const ROLE_CODES = {
  OWNER: 'OWNER',
  ADMIN: 'ADMIN',
  CASHIER: 'CASHIER',
  SELLER: 'SELLER',
  WAREHOUSE: 'WAREHOUSE',
} as const;

export type RoleCode = (typeof ROLE_CODES)[keyof typeof ROLE_CODES];

export const roleCodeValues = Object.values(ROLE_CODES) as RoleCode[];

export function isProductionRoleCode(value: string): value is RoleCode {
  return (roleCodeValues as string[]).includes(value);
}
