import { Prisma } from '../generated/prisma/client.js';
import { toJsonSafe } from './json-safe.js';

type AuditData = Pick<Prisma.AuditLogUncheckedCreateInput,
  'userId' | 'action' | 'entityType' | 'entityId'> & {
  // D3: required, never implicitly omitted. A Location-specific operation
  // records its real branch; only a global COMPANY-scoped operation (product,
  // variant, price) records null. Never substitute an arbitrary Location.
  branchId: string | null;
  before?: unknown;
  after?: unknown;
};

function json(value: unknown) {
  if (value === undefined) return undefined;
  if (value === null) return Prisma.JsonNull;
  return toJsonSafe(value) as Prisma.InputJsonValue;
}

// Callers supply explicit business snapshots, never credentials or whole users.
// The caller owns the transaction; this helper never opens or commits one.
export function createAuditLog(tx: Pick<Prisma.TransactionClient, 'auditLog'>, data: AuditData) {
  return tx.auditLog.create({ data: {
    userId: data.userId,
    branchId: data.branchId,
    action: data.action,
    entityType: data.entityType,
    entityId: data.entityId,
    before: json(data.before),
    after: json(data.after),
  } });
}
