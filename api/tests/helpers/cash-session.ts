import type { PrismaClient } from '../../src/generated/prisma/client.js';

// System V2 P0-A: the legacy FIXED_TOTAL payment path takes CASH only, so a test
// that registers a payment through POST /sales/:id/payments needs an OPEN cash
// session at the sale's branch. Idempotent: it returns the branch register's
// OPEN session when there is one (one OPEN session per register is a database
// invariant), and opens one otherwise.
export async function ensureOpenCashSession(db: PrismaClient, branchId: string, openedById: string) {
  const register = await db.cashRegister.findFirstOrThrow({ where: { branchId }, orderBy: { id: 'asc' } });
  const open = await db.cashSession.findFirst({ where: { registerId: register.id, status: 'OPEN' } });
  if (open) return open;
  return db.cashSession.create({ data: { registerId: register.id, openedById, startingCash: 0n, status: 'OPEN' } });
}
