// Cash session opening — transient retries and the ONE expected unique violation (H-01 of the second audit). DB-FREE: a fake $transaction injects the
// failures and records the options; the REAL cash service runs on top.
//   - the exact index behind CASH_SESSION_ALREADY_OPEN is the partial unique index cash_session_one_open_per_register (CashSession(registerId) WHERE status = 'OPEN',
//     migration 1); only a P2002 of THAT index is translated into 409 CASH_SESSION_ALREADY_OPEN;
//   - any other P2002 is neither retried nor translated into a false commercial error: it reaches the caller unchanged;
//   - transient failures (shared classifier) are retried, at most 3 attempts, then 409 CONCURRENCY_ERROR.
import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { createCashService } from '../../src/modules/cash/cash.service.js';
import { AppError } from '../../src/shared/errors.js';

const REGISTER = '00000000-0000-4000-8000-0000000000aa';
const BRANCH = '00000000-0000-4000-8000-0000000000bb';
const OWNER = { userId: 'owner-1', roles: ['OWNER'], assignments: [{ roleId: 'OWNER-company', roleCode: 'OWNER', scopeKind: 'COMPANY', locationId: null, permissions: [] }], effectiveLocationIds: [BRANCH] } as unknown as Express.AuthContext;

function world(failures: Array<Record<string, unknown>> = []) {
  const pending = [...failures];
  const calls: Array<{ isolationLevel?: string }> = [];
  const writes: string[] = [];
  const tx = {
    $queryRaw: async () => [{ id: REGISTER, branchId: BRANCH }],
    cashSession: {
      findFirst: async () => null,
      create: async () => { writes.push('cashSession.create'); return { id: 'session-1', registerId: REGISTER, status: 'OPEN', startingCash: 1000n, openedAt: new Date(), openedById: 'owner-1', closedAt: null, closedById: null, closingCash: null, expectedCash: null, difference: null }; },
    },
    cashMovement: { create: async () => { writes.push('cashMovement.create'); return {}; } },
    auditLog: { create: async () => { writes.push('auditLog.create'); return {}; } },
  };
  const db = {
    $transaction: async (operation: (t: unknown) => Promise<unknown>, options?: { isolationLevel?: string }) => {
      calls.push({ ...options });
      const failure = pending.shift();
      if (failure) throw Object.assign(new Error('driver failure'), failure);
      return operation(tx);
    },
  } as unknown as PrismaClient;
  return { service: createCashService(db), calls, writes };
}
const adapter = (originalCode: string) => ({ code: 'P2010', meta: { driverAdapterError: { cause: { originalCode } } } });
const p2002 = (index: string, modelName = 'CashSession') => ({ code: 'P2002', meta: { modelName, driverAdapterError: { cause: { kind: 'UniqueConstraintViolation', originalCode: '23505', constraint: { index } } } } });
const open = (w: ReturnType<typeof world>) => w.service.openSession(REGISTER, OWNER, 1000n);
const outcome = (promise: Promise<unknown>) => promise.then(() => null, (cause: unknown) => cause);

describe('cash openSession — transient failures', () => {
  it.each([
    ['P2034', { code: 'P2034' }],
    ['meta.code 40001', { code: 'P2010', meta: { code: '40001' } }],
    ['adapter originalCode 40001', adapter('40001')],
    ['adapter originalCode 40P01', adapter('40P01')],
    ['adapter cause.code 40001', { meta: { driverAdapterError: { cause: { code: '40001' } } } }],
    ['adapter kind TransactionWriteConflict', { meta: { driverAdapterError: { cause: { kind: 'TransactionWriteConflict' } } } }],
    ['cause chain -> adapter originalCode 40P01', { cause: { meta: { driverAdapterError: { cause: { originalCode: '40P01' } } } } }],
  ])('CS01 %s is retried (Serializable each time) and the session opens once', async (_label, failure) => {
    const w = world([failure]);
    const summary = await open(w);
    expect(summary).toMatchObject({ sessionId: 'session-1', branchId: BRANCH });
    expect(w.calls).toHaveLength(2);
    expect(w.calls.every((c) => c.isolationLevel === 'Serializable')).toBe(true);
    expect(w.writes).toEqual(['cashSession.create', 'cashMovement.create', 'auditLog.create']);
  });

  it('CS02 three transient failures -> 409 CONCURRENCY_ERROR after exactly 3 attempts, nothing written, no driver detail', async () => {
    const secret = { code: 'P2010', meta: { driverAdapterError: { cause: { originalCode: '40001', message: 'SECRET-DRIVER-DETAIL' } } } };
    const w = world([secret, secret, secret]);
    const error = await outcome(open(w));
    expect(error).toBeInstanceOf(AppError);
    expect({ status: (error as AppError).status, code: (error as AppError).code }).toEqual({ status: 409, code: 'CONCURRENCY_ERROR' });
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain('SECRET-DRIVER-DETAIL');
    expect(w.calls).toHaveLength(3);
    expect(w.writes).toEqual([]);
  });
});

describe('cash openSession — P2002', () => {
  it.each([
    ['adapter-pg: the exact partial index name', p2002('cash_session_one_open_per_register')],
    ['Prisma engine: the only unique column of CashSession (registerId)', { code: 'P2002', meta: { modelName: 'CashSession', target: ['registerId'] } }],
  ])('CS03 %s -> 409 CASH_SESSION_ALREADY_OPEN after one attempt (existing semantics)', async (_label, failure) => {
    const w = world([failure]);
    const error = await outcome(open(w));
    expect(error).toBeInstanceOf(AppError);
    expect({ status: (error as AppError).status, code: (error as AppError).code }).toEqual({ status: 409, code: 'CASH_SESSION_ALREADY_OPEN' });
    expect(w.calls).toHaveLength(1);
  });

  it.each([
    ['another constraint of another table', p2002('User_email_key', 'User')],
    ['another constraint of CashSession', p2002('CashSession_pkey')],
    ['the legit index name on another model', p2002('cash_session_one_open_per_register', 'CashMovement')],
    ['a P2002 that names nothing', { code: 'P2002', meta: {} }],
  ])('CS04 %s is NOT retried and NOT translated into a false commercial error: it reaches the caller unchanged', async (_label, failure) => {
    const w = world([failure]);
    const error = await outcome(open(w));
    expect(error).not.toBeInstanceOf(AppError);
    expect((error as { code?: string }).code).toBe('P2002');
    expect(w.calls).toHaveLength(1);
  });
});
