import { uniqueViolation } from '../payments/prisma-unique-violation.js';

// The ONE unique violation the Inventory writers expect and may retry: two concurrent first loads of the same (variant, branch) both try to create its
// Inventory row; the loser's transaction aborts with P2002 on Inventory_variantId_branchId_key (the exact index PostgreSQL names through
// @prisma/adapter-pg; the Prisma engine names the column list instead). Anything else — another constraint, another model, a P2002 that names nothing —
// is not ours: it is neither retried nor translated.
const sameFields = (fields: string[] | null, expected: string[]) =>
  fields !== null && fields.length === expected.length && expected.every((field) => fields.includes(field));

export function isInventoryFirstRowRace(error: unknown): boolean {
  const violation = uniqueViolation(error);
  if (violation === null) return false;
  return (violation.modelName === null || violation.modelName === 'Inventory')
    && (violation.name === 'Inventory_variantId_branchId_key' || sameFields(violation.fields, ['variantId', 'branchId']));
}
