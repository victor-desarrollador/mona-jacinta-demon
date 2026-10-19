// CASH MOVEMENT REVERSAL (PILOT, migration 11): DB-FREE behavioral coverage
// for correcting a mistaken WITHDRAWAL / EXPENSE with an append-only
// compensating movement (WITHDRAWAL_REVERSAL / EXPENSE_REVERSAL).
//
// In-memory stubs only: no pg, no test-db harness, no database of any kind.
// The same-session composite FK, the one-reversal UNIQUE and the CHECKs are
// PostgreSQL facts proven by the LOCAL_TEST suite (cash-movement.pg.test.ts);
// these tests pin the arithmetic, idempotency and the service contracts.
//
// PRE-REGISTERED EXPECTATIONS (OWNER decisions R1–R8, 2026-10-18):
//   CR-01 a WITHDRAWAL_REVERSAL restores expected cash
//   CR-02 an EXPENSE_REVERSAL restores expected cash
//   CR-03 reversal amount != original amount -> REVERSAL_MISMATCH
//   CR-04 original absent from the session -> REVERSAL_MISMATCH
//   CR-05 reversal type does not match the original type -> REVERSAL_MISMATCH
//   CR-06 two reversals of one original -> REVERSAL_MISMATCH
//   CR-07 a reversal without reversesMovementId -> REVERSAL_MISMATCH
//   CR-08 MANUAL stays fail-closed
//   CR-09 BigInt bounds, independent of the movement order
//   CR-10 reverse a WITHDRAWAL: one WITHDRAWAL_REVERSAL + one audit
//   CR-11 reverse an EXPENSE: one EXPENSE_REVERSAL + one audit
//   CR-12 the original row is never updated nor deleted
//   CR-13 the reversal amount is the original amount; the DTO refuses amount/type/ids
//   CR-14 a different key on an already reversed original -> 409 CASH_MOVEMENT_ALREADY_REVERSED, no details
//   CR-15 same key + same payload -> replayed:true, one reversal, one audit
//   CR-16 same key + different payload -> 409 IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD
//   CR-17 CLOSED session + new reversal -> 409 CASH_SESSION_ALREADY_CLOSED
//   CR-18 CLOSED session + replay of a committed reversal -> replay succeeds
//   CR-19 original of another session -> 404; actor of another branch -> 403
//   CR-20 CASHIER -> 403          CR-21 OWNER allowed
//   CR-22 ADMIN COMPANY allowed   CR-23 ADMIN LOCATION -> 403
//   CR-24..CR-28 OPENING / SALE_INCOME / CLOSING / MANUAL / a reversal -> 409 CASH_MOVEMENT_NOT_REVERSIBLE
//   CR-29 audit failure -> the reversal rolls back
//   CR-30 a P2002 of CashMovement_reversesMovementId_key is re-read -> ALREADY_REVERSED (or replay)
//   CR-31 a P2002 of CashMovement_sessionId_idempotencyKey_key is re-read -> replay or 409
//   CR-32 any other P2002 is rethrown unchanged
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { DEFAULT_ROLE_GRANTS } from '../../src/modules/rbac/role-permission-matrix.js';
import * as cashModule from '../../src/modules/cash/cash.service.js';
import * as dtoModule from '../../src/modules/cash/cash.dto.js';
import { p2002Adapter } from '../helpers/checkout-reservation-fake-db.js';

const BRANCH = 'branch-1';
const OTHER_BRANCH = 'branch-2';
const REGISTER_ID = 'register-1';
const SESSION_ID = 'session-1';
const OTHER_SESSION_ID = 'session-2';
const OPENING_AMOUNT = 100000n;
const MAX = 9223372036854775807n;

type Assignment = Express.ProductionAssignment;
function locationAssignment(roleCode: 'CASHIER' | 'SELLER' | 'WAREHOUSE' | 'ADMIN', locationId: string): Assignment {
  return { roleId: `${roleCode}-${locationId}`, roleCode, scopeKind: 'LOCATION', locationId, permissions: [...DEFAULT_ROLE_GRANTS[roleCode]] };
}
function companyAssignment(roleCode: 'OWNER' | 'ADMIN'): Assignment {
  return { roleId: `${roleCode}-company`, roleCode, scopeKind: 'COMPANY', locationId: null, permissions: roleCode === 'ADMIN' ? [...DEFAULT_ROLE_GRANTS.ADMIN] : [] };
}
function ctxFor(userId: string, assignments: Assignment[]): Express.AuthContext {
  return {
    userId,
    roles: assignments.map(({ roleCode }) => roleCode),
    assignments,
    effectiveLocationIds: assignments.map(({ locationId }) => locationId).filter((id): id is string => id !== null),
  } as unknown as Express.AuthContext;
}

const owner = ctxFor('owner-1', [companyAssignment('OWNER')]);
const adminCompany = ctxFor('admin-1', [companyAssignment('ADMIN')]);
const adminLocation = ctxFor('admin-loc-1', [locationAssignment('ADMIN', BRANCH)]);
const cashier = ctxFor('cashier-1', [locationAssignment('CASHIER', BRANCH)]);
const seller = ctxFor('seller-1', [locationAssignment('SELLER', BRANCH)]);
const warehouse = ctxFor('warehouse-1', [locationAssignment('WAREHOUSE', BRANCH)]);

type SessionRow = { id: string; registerId: string; startingCash: bigint; status: 'OPEN' | 'CLOSED' };
type MovementRow = {
  id: string; sessionId: string; type: string; amount: bigint; salePaymentId: string | null; userId: string;
  reason: string | null; idempotencyKey: string | null; reversesMovementId: string | null; timestamp: Date;
};
type AuditRow = { action: string; entityType: string; entityId: string; branchId: string | null; userId: string; before: unknown; after: unknown };

const session = (overrides: Partial<SessionRow> = {}): SessionRow => ({
  id: SESSION_ID, registerId: REGISTER_ID, startingCash: OPENING_AMOUNT, status: 'OPEN', ...overrides,
});
let seedCounter = 0;
function movement(overrides: Partial<MovementRow> & { type: string; amount: bigint }): MovementRow {
  seedCounter += 1;
  return {
    id: `seed-${seedCounter}`, sessionId: SESSION_ID, salePaymentId: null, userId: 'cashier-1', reason: null,
    idempotencyKey: null, reversesMovementId: null, timestamp: new Date(), ...overrides,
  };
}
const opening = () => movement({ id: 'opening-1', type: 'OPENING', amount: OPENING_AMOUNT });
const withdrawal = () => movement({ id: 'withdrawal-1', type: 'WITHDRAWAL', amount: 30000n, reason: 'Retiro mal cargado', idempotencyKey: randomUUID() });
const expense = () => movement({ id: 'expense-1', type: 'EXPENSE', amount: 4000n, reason: 'Gasto mal cargado', idempotencyKey: randomUUID() });

// A stateful, transactional in-memory stand-in: `$transaction` snapshots the
// rows and restores them when the operation throws. Every mutation of a
// pre-existing movement row is recorded so CR-12 can prove there is none.
function createFakeDb(initial: { sessions: SessionRow[]; movements: MovementRow[] }) {
  const state = {
    sessions: initial.sessions.map((s) => ({ ...s })),
    movements: initial.movements.map((m) => ({ ...m })),
    audits: [] as AuditRow[],
  };
  const writes: string[] = [];
  const sqlLog: string[] = [];
  let counter = 0;
  let auditShouldThrow = false;
  // Injected once at the next movement create: simulates a concurrent winner
  // that committed between this transaction's snapshot and its INSERT.
  let raceOnCreate: (() => Error) | null = null;
  // A peer's commit is durable: it survives this transaction's rollback.
  const peerCommits: MovementRow[] = [];
  const registers = [{ id: REGISTER_ID, branchId: BRANCH, name: 'Caja 1' }];
  const forbiddenMutation = (name: string) => () => { writes.push(name); throw new Error(`${name} must never be called`); };

  const tx = {
    $queryRaw: (templates: string[], ...values: unknown[]) => {
      const sql = templates.join('$?');
      sqlLog.push(sql);
      if (sql.includes('FROM "CashSession"') && sql.includes('FOR UPDATE')) {
        const found = state.sessions.find((s) => s.id === values[0]);
        return Promise.resolve(found ? [{ ...found }] : []);
      }
      return Promise.resolve([]);
    },
    cashRegister: {
      findUniqueOrThrow: ({ where }: { where: { id: string } }) => {
        const register = registers.find((r) => r.id === where.id);
        if (!register) throw new Error('register not found');
        return Promise.resolve({ ...register });
      },
    },
    cashSession: {
      findUnique: ({ where }: { where: { id: string } }) => Promise.resolve(state.sessions.find((s) => s.id === where.id) ?? null),
      update: forbiddenMutation('cashSession.update'),
    },
    cashMovement: {
      findUnique: ({ where }: { where: { sessionId_idempotencyKey?: { sessionId: string; idempotencyKey: string }; reversesMovementId?: string; id?: string } }) => {
        if (where.sessionId_idempotencyKey) {
          const key = where.sessionId_idempotencyKey;
          return Promise.resolve(state.movements.find((m) => m.sessionId === key.sessionId && m.idempotencyKey === key.idempotencyKey) ?? null);
        }
        if (where.reversesMovementId !== undefined) {
          return Promise.resolve(state.movements.find((m) => m.reversesMovementId === where.reversesMovementId) ?? null);
        }
        return Promise.resolve(state.movements.find((m) => m.id === where.id) ?? null);
      },
      findFirst: ({ where }: { where: { id: string; sessionId: string } }) =>
        Promise.resolve(state.movements.find((m) => m.id === where.id && m.sessionId === where.sessionId) ?? null),
      findMany: ({ where }: { where: { sessionId: string } }) =>
        Promise.resolve(state.movements.filter((m) => m.sessionId === where.sessionId).map((m) => ({ ...m }))),
      create: ({ data }: { data: Omit<MovementRow, 'id' | 'timestamp' | 'reversesMovementId'> & { reversesMovementId?: string | null } }) => {
        if (raceOnCreate) {
          const error = raceOnCreate();
          raceOnCreate = null;
          return Promise.reject(error);
        }
        writes.push(`cashMovement.create:${data.type}`);
        counter += 1;
        const row: MovementRow = { ...data, id: `movement-${counter}`, timestamp: new Date(), reversesMovementId: data.reversesMovementId ?? null };
        state.movements.push(row);
        return Promise.resolve({ ...row });
      },
      update: forbiddenMutation('cashMovement.update'),
      updateMany: forbiddenMutation('cashMovement.updateMany'),
      delete: forbiddenMutation('cashMovement.delete'),
      deleteMany: forbiddenMutation('cashMovement.deleteMany'),
      upsert: forbiddenMutation('cashMovement.upsert'),
    },
    salePayment: { findMany: () => Promise.resolve([]) },
    auditLog: {
      create: ({ data }: { data: AuditRow }) => {
        if (auditShouldThrow) throw new Error('audit unavailable');
        writes.push(`audit:${data.action}`);
        state.audits.push({ ...data });
        return Promise.resolve(data);
      },
    },
  };

  const client = {
    $transaction: async (operation: (transaction: unknown) => Promise<unknown>) => {
      const snap = {
        sessions: state.sessions.map((s) => ({ ...s })),
        movements: state.movements.map((m) => ({ ...m })),
        audits: state.audits.map((a) => ({ ...a })),
      };
      try {
        return await operation(tx);
      } catch (error) {
        state.sessions = snap.sessions;
        state.movements = snap.movements;
        state.audits = snap.audits;
        state.movements.push(...peerCommits.splice(0));
        throw error;
      }
    },
    ...tx,
  } as unknown as PrismaClient;

  return {
    client, state, writes, sqlLog,
    failAudit: () => { auditShouldThrow = true; },
    // The concurrent winner's row is committed, then this caller's INSERT hits the index.
    raceWith: (winner: MovementRow, error: Error) => {
      raceOnCreate = () => { peerCommits.push({ ...winner }); return error; };
    },
    service: () => cashModule.createCashService(client),
  };
}

type Refusal = { status?: number; code?: string; details?: unknown };
async function refusalOf(action: () => Promise<unknown>): Promise<Refusal> {
  try {
    await action();
  } catch (error) {
    return error as Refusal;
  }
  throw new Error('cash-movement-reversal: expected the operation to refuse');
}

type ReverseFn = (sessionId: string, movementId: string, ctx: Express.AuthContext, input: { reason: string; idempotencyKey: string }) =>
  Promise<{ movement: MovementRow; original: MovementRow; replayed: boolean }>;
function reverse(db: ReturnType<typeof createFakeDb>, movementId: string, ctx: Express.AuthContext, reason = 'Carga equivocada', key = randomUUID(), sessionId = SESSION_ID) {
  const service = db.service() as unknown as { reverseMovement?: ReverseFn };
  expect(typeof service.reverseMovement, 'cash.service must expose reverseMovement').toBe('function');
  return service.reverseMovement!(sessionId, movementId, ctx, { reason, idempotencyKey: key });
}

type Shape = { id?: string; type: string; amount: bigint; salePaymentId: string | null; reversesMovementId?: string | null };
const shape = (id: string, type: string, amount: bigint, extra: Partial<Shape> = {}): Shape => ({ id, type, amount, salePaymentId: null, reversesMovementId: null, ...extra });
const reconcile = (movements: Shape[], countedCash: bigint, startingCash = OPENING_AMOUNT, cashPayments: { id: string; amount: bigint }[] = []) =>
  cashModule.reconcileCashSession({ startingCash, movements, cashPayments, countedCash } as Parameters<typeof cashModule.reconcileCashSession>[0]);
const project = (movements: Shape[], startingCash = OPENING_AMOUNT) =>
  cashModule.projectExpectedCash({ startingCash, movements } as Parameters<typeof cashModule.projectExpectedCash>[0]);

describe('cash-movement-reversal CR-01..CR-09 reconciliation and projection', () => {
  const base = shape('o', 'OPENING', OPENING_AMOUNT);

  it('CR-01 a WITHDRAWAL_REVERSAL restores expected cash (reconcile + project)', () => {
    const movements = [base, shape('w', 'WITHDRAWAL', 30000n), shape('r', 'WITHDRAWAL_REVERSAL', 30000n, { reversesMovementId: 'w' })];
    expect(reconcile(movements, OPENING_AMOUNT)).toEqual({ ok: true, expectedCash: OPENING_AMOUNT, difference: 0n });
    expect(project(movements)).toEqual({ ok: true, projectedExpectedCash: OPENING_AMOUNT });
  });

  it('CR-02 an EXPENSE_REVERSAL restores expected cash, alongside real income and other exits', () => {
    const movements = [
      base, shape('s', 'SALE_INCOME', 8000n, { salePaymentId: 'p1' }), shape('e', 'EXPENSE', 4000n),
      shape('e2', 'EXPENSE', 1000n), shape('r', 'EXPENSE_REVERSAL', 4000n, { reversesMovementId: 'e' }),
    ];
    // 100000 + 8000 − 4000 − 1000 + 4000 = 107000
    expect(reconcile(movements, 107000n, OPENING_AMOUNT, [{ id: 'p1', amount: 8000n }])).toEqual({ ok: true, expectedCash: 107000n, difference: 0n });
    expect(project(movements)).toEqual({ ok: true, projectedExpectedCash: 107000n });
  });

  const mismatch = (movements: Shape[]) => {
    expect(reconcile(movements, OPENING_AMOUNT)).toEqual({ ok: false, reason: 'REVERSAL_MISMATCH' });
    expect(project(movements)).toEqual({ ok: false, reason: 'REVERSAL_MISMATCH' });
  };

  it('CR-03 a reversal amount different from its original fails closed', () => {
    mismatch([base, shape('w', 'WITHDRAWAL', 30000n), shape('r', 'WITHDRAWAL_REVERSAL', 29999n, { reversesMovementId: 'w' })]);
    mismatch([base, shape('w', 'WITHDRAWAL', 30000n), shape('r', 'WITHDRAWAL_REVERSAL', 30001n, { reversesMovementId: 'w' })]);
  });

  it('CR-04 a reversal whose original is not in the session fails closed', () => {
    mismatch([base, shape('r', 'WITHDRAWAL_REVERSAL', 30000n, { reversesMovementId: 'w-elsewhere' })]);
  });

  it('CR-05 a reversal whose type does not correspond to the original fails closed', () => {
    mismatch([base, shape('w', 'WITHDRAWAL', 3000n), shape('r', 'EXPENSE_REVERSAL', 3000n, { reversesMovementId: 'w' })]);
    mismatch([base, shape('e', 'EXPENSE', 3000n), shape('r', 'WITHDRAWAL_REVERSAL', 3000n, { reversesMovementId: 'e' })]);
    mismatch([base, shape('s', 'SALE_INCOME', 3000n, { salePaymentId: 'p1' }), shape('r', 'EXPENSE_REVERSAL', 3000n, { reversesMovementId: 's' })]);
    // A reversal of a reversal is never a corresponding pair.
    mismatch([base, shape('e', 'EXPENSE', 3000n), shape('r', 'EXPENSE_REVERSAL', 3000n, { reversesMovementId: 'e' }),
      shape('rr', 'EXPENSE_REVERSAL', 3000n, { reversesMovementId: 'r' })]);
  });

  it('CR-06 two reversals of one original fail closed', () => {
    mismatch([base, shape('e', 'EXPENSE', 3000n), shape('r1', 'EXPENSE_REVERSAL', 3000n, { reversesMovementId: 'e' }),
      shape('r2', 'EXPENSE_REVERSAL', 3000n, { reversesMovementId: 'e' })]);
  });

  it('CR-07 a reversal without a link (null or absent), with a payment link, or non-positive fails closed; a link on a non-reversal fails closed', () => {
    mismatch([base, shape('e', 'EXPENSE', 3000n), shape('r', 'EXPENSE_REVERSAL', 3000n, { reversesMovementId: null })]);
    mismatch([base, shape('e', 'EXPENSE', 3000n), { id: 'r', type: 'EXPENSE_REVERSAL', amount: 3000n, salePaymentId: null }]);
    mismatch([base, shape('e', 'EXPENSE', 3000n), shape('r', 'EXPENSE_REVERSAL', 3000n, { reversesMovementId: 'e', salePaymentId: 'p1' })]);
    mismatch([base, shape('e', 'EXPENSE', 3000n), shape('r', 'EXPENSE_REVERSAL', -3000n, { reversesMovementId: 'e' })]);
    mismatch([base, shape('e', 'EXPENSE', 3000n), shape('x', 'WITHDRAWAL', 100n, { reversesMovementId: 'e' })]);
  });

  it('CR-08 MANUAL and unknown types stay fail-closed', () => {
    for (const type of ['MANUAL', 'DEPOSIT', 'ADJUSTMENT']) {
      expect(reconcile([base, shape('m', type, 500n)], OPENING_AMOUNT)).toEqual({ ok: false, reason: 'MOVEMENT_TYPE_NOT_ALLOWED' });
      expect(project([base, shape('m', type, 500n)])).toEqual({ ok: false, reason: 'MOVEMENT_TYPE_NOT_ALLOWED' });
    }
  });

  it('CR-09 BigInt bounds: a reversal listed before its original never transiently overflows; a real overflow still refuses', () => {
    const atMax = [shape('o', 'OPENING', MAX), shape('r', 'WITHDRAWAL_REVERSAL', 5n, { reversesMovementId: 'w' }), shape('w', 'WITHDRAWAL', 5n)];
    expect(reconcile(atMax, MAX, MAX)).toEqual({ ok: true, expectedCash: MAX, difference: 0n });
    expect(project(atMax, MAX)).toEqual({ ok: true, projectedExpectedCash: MAX });
    const over = [shape('o', 'OPENING', MAX), shape('s', 'SALE_INCOME', 1n, { salePaymentId: 'p1' })];
    expect(reconcile(over, MAX, MAX, [{ id: 'p1', amount: 1n }])).toEqual({ ok: false, reason: 'AMOUNT_OVERFLOW' });
    expect(project(over, MAX)).toEqual({ ok: false, reason: 'AMOUNT_OVERFLOW' });
  });

  it('CR-09b a close refuses REVERSAL_MISMATCH as CASH_RECONCILIATION_INCONSISTENT', async () => {
    const db = createFakeDb({
      sessions: [session()],
      movements: [opening(), withdrawal(), movement({ id: 'bad', type: 'WITHDRAWAL_REVERSAL', amount: 1n, reason: 'x', idempotencyKey: randomUUID(), reversesMovementId: 'withdrawal-1' })],
    });
    const error = await refusalOf(() => db.service().closeSession(SESSION_ID, cashier, OPENING_AMOUNT));
    expect(error).toMatchObject({ status: 409, code: 'CASH_RECONCILIATION_INCONSISTENT' });
  });
});

describe('cash-movement-reversal CR-10..CR-13 success, immutability and amount', () => {
  it('CR-10 reverse a WITHDRAWAL: one WITHDRAWAL_REVERSAL with the original amount, one audit', async () => {
    const db = createFakeDb({ sessions: [session()], movements: [opening(), withdrawal()] });
    const key = randomUUID();
    const result = await reverse(db, 'withdrawal-1', adminCompany, '  Retiro duplicado  ', key);

    expect(result.replayed).toBe(false);
    expect(result.movement).toMatchObject({
      type: 'WITHDRAWAL_REVERSAL', amount: 30000n, reason: 'Retiro duplicado', idempotencyKey: key,
      reversesMovementId: 'withdrawal-1', salePaymentId: null, sessionId: SESSION_ID, userId: 'admin-1',
    });
    expect(result.original).toMatchObject({ id: 'withdrawal-1', type: 'WITHDRAWAL', amount: 30000n });
    expect(db.state.movements.filter((m) => m.type === 'WITHDRAWAL_REVERSAL')).toHaveLength(1);
    expect(db.state.audits).toHaveLength(1);
    expect(db.state.audits[0]).toMatchObject({
      action: 'CASH_WITHDRAWAL_REVERSED', entityType: 'CashMovement', entityId: result.movement.id, branchId: BRANCH, userId: 'admin-1',
      // BigInt-safe audit JSON (toJsonSafe): money is a decimal string, never a float.
      before: { id: 'withdrawal-1', type: 'WITHDRAWAL', amount: '30000', reason: 'Retiro mal cargado' },
      after: {
        reversalMovementId: result.movement.id, originalMovementId: 'withdrawal-1', sessionId: SESSION_ID,
        type: 'WITHDRAWAL_REVERSAL', amount: '30000', reason: 'Retiro duplicado', idempotencyKey: key,
        projectedExpectedCashBefore: '70000', projectedExpectedCashAfter: '100000',
      },
    });
    // The session lock is taken before anything else.
    expect(db.sqlLog[0]).toMatch(/FROM "CashSession"[\s\S]*FOR UPDATE/);
  });

  it('CR-11 reverse an EXPENSE: one EXPENSE_REVERSAL, audit CASH_EXPENSE_REVERSED', async () => {
    const db = createFakeDb({ sessions: [session()], movements: [opening(), expense()] });
    const result = await reverse(db, 'expense-1', owner);
    expect(result.movement).toMatchObject({ type: 'EXPENSE_REVERSAL', amount: 4000n, reversesMovementId: 'expense-1' });
    expect(db.state.audits.map((a) => a.action)).toEqual(['CASH_EXPENSE_REVERSED']);
  });

  it('CR-12 the original row stays byte-identical: never updated, never deleted', async () => {
    const original = withdrawal();
    const db = createFakeDb({ sessions: [session()], movements: [opening(), original] });
    await reverse(db, original.id, adminCompany);
    expect(db.state.movements.find((m) => m.id === original.id)).toEqual(original);
    expect(db.writes.filter((w) => !w.startsWith('cashMovement.create:') && !w.startsWith('audit:'))).toEqual([]);
  });

  it('CR-13 the reversal amount is copied from the original; the DTO refuses amount, type, reversesMovementId and sessionId', async () => {
    const db = createFakeDb({ sessions: [session()], movements: [opening(), withdrawal()] });
    const service = db.service() as unknown as { reverseMovement: (...args: unknown[]) => Promise<{ movement: MovementRow }> };
    // Even if a caller smuggles an amount into the input object, it is ignored.
    const result = await service.reverseMovement(SESSION_ID, 'withdrawal-1', adminCompany, { reason: 'x', idempotencyKey: randomUUID(), amount: 1n });
    expect(result.movement.amount).toBe(30000n);

    const dto = (dtoModule as Record<string, unknown>).cashMovementReversalDto as { safeParse: (v: unknown) => { success: boolean } } | undefined;
    expect(dto, 'cash.dto must export cashMovementReversalDto').toBeDefined();
    const ok = { reason: 'Carga equivocada', idempotencyKey: randomUUID() };
    expect(dto!.safeParse(ok).success).toBe(true);
    for (const extra of [{ amount: '1' }, { type: 'WITHDRAWAL_REVERSAL' }, { reversesMovementId: 'x' }, { sessionId: SESSION_ID }]) {
      expect(dto!.safeParse({ ...ok, ...extra }).success, JSON.stringify(extra)).toBe(false);
    }
    for (const reason of ['', '   ', 'x'.repeat(201), undefined, 5]) {
      expect(dto!.safeParse({ ...ok, reason }).success, String(reason)).toBe(false);
    }
    for (const idempotencyKey of ['not-a-uuid', '00000000-0000-1000-8000-000000000000', undefined]) {
      expect(dto!.safeParse({ ...ok, idempotencyKey }).success, String(idempotencyKey)).toBe(false);
    }
    const params = (dtoModule as Record<string, unknown>).cashMovementParamsDto as { safeParse: (v: unknown) => { success: boolean } } | undefined;
    expect(params, 'cash.dto must export cashMovementParamsDto').toBeDefined();
    expect(params!.safeParse({ sessionId: randomUUID(), movementId: randomUUID() }).success).toBe(true);
    expect(params!.safeParse({ sessionId: randomUUID(), movementId: 'nope' }).success).toBe(false);
  });
});

describe('cash-movement-reversal CR-14..CR-18 double reversal, idempotency and closed sessions', () => {
  it('CR-14 a different key on an already reversed original -> 409 CASH_MOVEMENT_ALREADY_REVERSED without details, no write', async () => {
    const db = createFakeDb({ sessions: [session()], movements: [opening(), withdrawal()] });
    await reverse(db, 'withdrawal-1', adminCompany);
    const writesBefore = db.writes.length;
    const error = await refusalOf(() => reverse(db, 'withdrawal-1', owner, 'Otra vez'));
    expect(error).toMatchObject({ status: 409, code: 'CASH_MOVEMENT_ALREADY_REVERSED' });
    expect(error.details).toBeUndefined();
    expect(db.writes.length).toBe(writesBefore);
    expect(db.state.movements.filter((m) => m.type === 'WITHDRAWAL_REVERSAL')).toHaveLength(1);
  });

  it('CR-15 same key + same payload -> replayed:true, one reversal, one audit', async () => {
    const db = createFakeDb({ sessions: [session()], movements: [opening(), expense()] });
    const key = randomUUID();
    const first = await reverse(db, 'expense-1', adminCompany, 'Duplicado', key);
    const second = await reverse(db, 'expense-1', adminCompany, '  Duplicado ', key);
    expect(second.replayed).toBe(true);
    expect(second.movement.id).toBe(first.movement.id);
    expect(second.original).toMatchObject({ id: 'expense-1', type: 'EXPENSE' });
    expect(db.state.movements.filter((m) => m.type === 'EXPENSE_REVERSAL')).toHaveLength(1);
    expect(db.state.audits).toHaveLength(1);
  });

  it('CR-16 same key + different payload (reason, original, or a key already used by an exit) -> 409 IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD', async () => {
    const exitKey = randomUUID();
    const db = createFakeDb({
      sessions: [session()],
      movements: [opening(), expense(), withdrawal(), movement({ id: 'expense-2', type: 'EXPENSE', amount: 10n, reason: 'Flete', idempotencyKey: exitKey })],
    });
    const key = randomUUID();
    await reverse(db, 'expense-1', adminCompany, 'Duplicado', key);
    const otherReason = await refusalOf(() => reverse(db, 'expense-1', adminCompany, 'Otro motivo', key));
    expect(otherReason).toMatchObject({ status: 409, code: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD' });
    const otherOriginal = await refusalOf(() => reverse(db, 'withdrawal-1', adminCompany, 'Duplicado', key));
    expect(otherOriginal).toMatchObject({ status: 409, code: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD' });
    const exitCollision = await refusalOf(() => reverse(db, 'withdrawal-1', adminCompany, 'Flete', exitKey));
    expect(exitCollision).toMatchObject({ status: 409, code: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD' });
    expect(db.state.movements.filter((m) => m.type.endsWith('_REVERSAL'))).toHaveLength(1);
  });

  it('CR-17 CLOSED session + new reversal -> 409 CASH_SESSION_ALREADY_CLOSED, no write', async () => {
    const db = createFakeDb({ sessions: [session({ status: 'CLOSED' })], movements: [opening(), withdrawal()] });
    const error = await refusalOf(() => reverse(db, 'withdrawal-1', adminCompany));
    expect(error).toMatchObject({ status: 409, code: 'CASH_SESSION_ALREADY_CLOSED' });
    expect(db.writes).toEqual([]);
  });

  it('CR-18 CLOSED session + replay of a committed reversal -> replay succeeds, nothing written', async () => {
    const key = randomUUID();
    const db = createFakeDb({
      sessions: [session({ status: 'CLOSED' })],
      movements: [opening(), withdrawal(), movement({ id: 'rev-1', type: 'WITHDRAWAL_REVERSAL', amount: 30000n, reason: 'Duplicado', idempotencyKey: key, reversesMovementId: 'withdrawal-1' })],
    });
    const replay = await reverse(db, 'withdrawal-1', adminCompany, 'Duplicado', key);
    expect(replay).toMatchObject({ replayed: true, movement: { id: 'rev-1' }, original: { id: 'withdrawal-1' } });
    expect(db.writes).toEqual([]);
  });
});

describe('cash-movement-reversal CR-19..CR-23 scope and supervisor', () => {
  it('CR-19 an original of another session -> 404; an actor of another branch -> 403; unknown session -> 404', async () => {
    const db = createFakeDb({
      sessions: [session(), session({ id: OTHER_SESSION_ID })],
      movements: [opening(), movement({ id: 'w-other', sessionId: OTHER_SESSION_ID, type: 'WITHDRAWAL', amount: 10n, reason: 'x', idempotencyKey: randomUUID() })],
    });
    expect(await refusalOf(() => reverse(db, 'w-other', adminCompany))).toMatchObject({ status: 404 });
    expect(await refusalOf(() => reverse(db, 'missing', adminCompany))).toMatchObject({ status: 404 });
    expect(await refusalOf(() => reverse(db, 'w-other', adminCompany, 'x', randomUUID(), 'no-such-session'))).toMatchObject({ status: 404 });
    const elsewhere = ctxFor('cashier-b', [locationAssignment('CASHIER', OTHER_BRANCH)]);
    expect(await refusalOf(() => reverse(db, 'w-other', elsewhere, 'x', randomUUID(), OTHER_SESSION_ID))).toMatchObject({ status: 403 });
    expect(db.writes).toEqual([]);
  });

  it('CR-20 CASHIER (and SELLER / WAREHOUSE) -> 403, nothing written', async () => {
    for (const actor of [cashier, seller, warehouse]) {
      const db = createFakeDb({ sessions: [session()], movements: [opening(), expense()] });
      expect(await refusalOf(() => reverse(db, 'expense-1', actor))).toMatchObject({ status: 403, code: 'FORBIDDEN' });
      expect(db.writes).toEqual([]);
    }
  });

  it('CR-21 OWNER is allowed', async () => {
    const db = createFakeDb({ sessions: [session()], movements: [opening(), expense()] });
    expect((await reverse(db, 'expense-1', owner)).replayed).toBe(false);
  });

  it('CR-22 a COMPANY-scoped ADMIN is allowed; one lacking CASH_MOVEMENT_MANAGE is not', async () => {
    const db = createFakeDb({ sessions: [session()], movements: [opening(), expense()] });
    expect((await reverse(db, 'expense-1', adminCompany)).replayed).toBe(false);
    const stripped = ctxFor('admin-2', [{ ...companyAssignment('ADMIN'), permissions: DEFAULT_ROLE_GRANTS.ADMIN.filter((p) => p !== 'CASH_MOVEMENT_MANAGE') }]);
    const db2 = createFakeDb({ sessions: [session()], movements: [opening(), expense()] });
    expect(await refusalOf(() => reverse(db2, 'expense-1', stripped))).toMatchObject({ status: 403 });
  });

  it('CR-23 a LOCATION-scoped ADMIN is not a supervisor -> 403', async () => {
    const db = createFakeDb({ sessions: [session()], movements: [opening(), expense()] });
    expect(await refusalOf(() => reverse(db, 'expense-1', adminLocation))).toMatchObject({ status: 403 });
    expect(db.writes).toEqual([]);
  });
});

describe('cash-movement-reversal CR-24..CR-29 non-reversible types and atomicity', () => {
  const cases: [string, MovementRow][] = [
    ['CR-24 OPENING', movement({ id: 'target', type: 'OPENING', amount: 1n })],
    ['CR-25 SALE_INCOME', movement({ id: 'target', type: 'SALE_INCOME', amount: 1n, salePaymentId: 'p1' })],
    ['CR-26 CLOSING', movement({ id: 'target', type: 'CLOSING', amount: 1n })],
    ['CR-27 MANUAL', movement({ id: 'target', type: 'MANUAL', amount: 1n })],
    ['CR-28 a reversal itself', movement({ id: 'target', type: 'EXPENSE_REVERSAL', amount: 4000n, reason: 'x', idempotencyKey: randomUUID(), reversesMovementId: 'expense-1' })],
  ];
  for (const [name, target] of cases) {
    it(`${name} is not reversible -> 409 CASH_MOVEMENT_NOT_REVERSIBLE, no write`, async () => {
      const db = createFakeDb({ sessions: [session()], movements: [opening(), expense(), target] });
      expect(await refusalOf(() => reverse(db, 'target', owner))).toMatchObject({ status: 409, code: 'CASH_MOVEMENT_NOT_REVERSIBLE' });
      expect(db.writes).toEqual([]);
    });
  }

  it('CR-29 an audit failure rolls the reversal back (no durable reversal, no audit)', async () => {
    const db = createFakeDb({ sessions: [session()], movements: [opening(), withdrawal()] });
    db.failAudit();
    const key = randomUUID();
    const error = await refusalOf(() => reverse(db, 'withdrawal-1', owner, 'x', key));
    expect((error as unknown as Error).message).toBe('audit unavailable');
    expect(db.state.movements.filter((m) => m.type === 'WITHDRAWAL_REVERSAL')).toHaveLength(0);
    expect(db.state.audits).toHaveLength(0);
  });

  it('CR-29b a session whose movements do not reconcile refuses the reversal (fail-closed projection)', async () => {
    const db = createFakeDb({ sessions: [session()], movements: [opening(), withdrawal(), movement({ type: 'MANUAL', amount: 1n })] });
    expect(await refusalOf(() => reverse(db, 'withdrawal-1', owner))).toMatchObject({ status: 409, code: 'CASH_RECONCILIATION_INCONSISTENT' });
    expect(db.writes).toEqual([]);
  });
});

describe('cash-movement-reversal CR-30..CR-32 unique-violation classification (prisma-unique-violation.ts)', () => {
  const winnerReversal = (key: string, reason = 'Ganador') =>
    movement({ id: 'winner', type: 'WITHDRAWAL_REVERSAL', amount: 30000n, reason, idempotencyKey: key, reversesMovementId: 'withdrawal-1' });

  it('CR-30 a P2002 of the one-reversal index (adapter index or fields) is re-read -> ALREADY_REVERSED, or a replay when the winner carries the same key and payload', async () => {
    for (const constraint of [{ index: 'CashMovement_reversesMovementId_key' }, { fields: ['"reversesMovementId"'] }]) {
      const db = createFakeDb({ sessions: [session()], movements: [opening(), withdrawal()] });
      db.raceWith(winnerReversal(randomUUID()), p2002Adapter(constraint, 'CashMovement'));
      const error = await refusalOf(() => reverse(db, 'withdrawal-1', owner, 'Perdedor'));
      expect(error, JSON.stringify(constraint)).toMatchObject({ status: 409, code: 'CASH_MOVEMENT_ALREADY_REVERSED' });
    }
    const key = randomUUID();
    const db = createFakeDb({ sessions: [session()], movements: [opening(), withdrawal()] });
    db.raceWith(winnerReversal(key, 'Mismo'), p2002Adapter({ index: 'CashMovement_reversesMovementId_key' }, 'CashMovement'));
    const replay = await reverse(db, 'withdrawal-1', owner, 'Mismo', key);
    expect(replay).toMatchObject({ replayed: true, movement: { id: 'winner' } });
    expect(db.state.audits).toHaveLength(0);
  });

  it('CR-31 a P2002 of the (sessionId, idempotencyKey) index is re-read -> replay (same payload) or 409 (different payload)', async () => {
    for (const constraint of [{ index: 'CashMovement_sessionId_idempotencyKey_key' }, { fields: ['"sessionId"', '"idempotencyKey"'] }]) {
      const key = randomUUID();
      const db = createFakeDb({ sessions: [session()], movements: [opening(), withdrawal()] });
      db.raceWith(winnerReversal(key, 'Mismo'), p2002Adapter(constraint, 'CashMovement'));
      expect(await reverse(db, 'withdrawal-1', owner, 'Mismo', key), JSON.stringify(constraint)).toMatchObject({ replayed: true, movement: { id: 'winner' } });

      const key2 = randomUUID();
      const db2 = createFakeDb({ sessions: [session()], movements: [opening(), withdrawal()] });
      db2.raceWith(movement({ id: 'exit', type: 'EXPENSE', amount: 5n, reason: 'Flete', idempotencyKey: key2 }), p2002Adapter(constraint, 'CashMovement'));
      expect(await refusalOf(() => reverse(db2, 'withdrawal-1', owner, 'Mismo', key2))).toMatchObject({ status: 409, code: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD' });
    }
  });

  it('CR-32 any other P2002 (another constraint, another model, unnamed) is rethrown unchanged', async () => {
    for (const error of [
      p2002Adapter({ index: 'CashMovement_salePaymentId_key' }, 'CashMovement'),
      p2002Adapter({ index: 'CashMovement_reversesMovementId_key' }, 'AuditLog'),
      Object.assign(new Error('Unique constraint failed'), { code: 'P2002', meta: {} }),
    ]) {
      const db = createFakeDb({ sessions: [session()], movements: [opening(), withdrawal()] });
      db.raceWith(winnerReversal(randomUUID()), error);
      expect(await refusalOf(() => reverse(db, 'withdrawal-1', owner))).toBe(error);
    }
  });
});
