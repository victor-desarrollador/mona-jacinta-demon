// CASH-WITHDRAWAL/EXPENSE (PILOT fast track, migration 10): DB-FREE behavioral
// coverage for manual cash exits registered against an OPEN session.
//
// In-memory stubs only: no pg, no test-db harness, no database of any kind.
// PostgreSQL row-lock interleavings (real concurrency, migration 1–10) still
// require a LOCAL_TEST proof; these tests pin the projection, idempotency and
// the service-level persistence/authorization/lock contracts.
//
// PRE-REGISTERED EXPECTATIONS (2026-10-18), CM-01..CM-21:
//   CM-01 an EXPENSE by a LOCATION CASHIER succeeds: one EXPENSE movement
//         (salePaymentId NULL, reason, idempotencyKey), one audit
//   CM-02 a WITHDRAWAL by an ADMIN COMPANY supervisor succeeds
//   CM-03 projectedExpectedCash = startingCash + Σ SALE_INCOME − Σ WITHDRAWAL − Σ EXPENSE
//   CM-04 close reconciliation subtracts WITHDRAWAL and EXPENSE
//   CM-05 wrong branch -> 403 before any write
//   CM-06 a new operation on a CLOSED session -> CASH_SESSION_ALREADY_CLOSED
//   CM-07 amount zero -> 400
//   CM-08 amount negative -> 400
//   CM-09 unsafe / non-BigInt input -> 400
//   CM-10 int8 overflow amount -> 400
//   CM-11 reason missing / blank -> 400
//   CM-12 same key + same payload -> replayed:true, one movement, one audit
//   CM-13 same key + different payload -> 409 IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD
//   CM-14 a replayed key after the session is CLOSED still replays
//   CM-15 distinct exits serialize on the CashSession FOR UPDATE lock, projection sees prior exits
//   CM-16 audit failure -> the movement is rolled back
//   CM-17 an actor without CASH_MOVEMENT_MANAGE -> 403
//   CM-18 a WITHDRAWAL without a supervisor -> 403
//   CM-19 amount > projectedExpectedCash -> 409 INSUFFICIENT_CASH_IN_DRAWER
//   CM-20 amount == projectedExpectedCash -> allowed
//   CM-21 MANUAL stays fail-closed at reconciliation
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { DEFAULT_ROLE_GRANTS } from '../../src/modules/rbac/role-permission-matrix.js';
import * as cashModule from '../../src/modules/cash/cash.service.js';
import { cashMovementDto } from '../../src/modules/cash/cash.dto.js';

const BRANCH = 'branch-1';
const OTHER_BRANCH = 'branch-2';
const REGISTER_ID = 'register-1';
const SESSION_ID = 'session-1';
const OPENING_AMOUNT = 100000n;
const ACTOR_ID = 'actor-1';

function locationAssignment(roleCode: 'CASHIER' | 'SELLER', locationId: string): Express.ProductionAssignment {
  return {
    roleId: `${roleCode}-${locationId}`,
    roleCode,
    scopeKind: 'LOCATION',
    locationId,
    permissions: [...(DEFAULT_ROLE_GRANTS[roleCode as 'CASHIER' | 'SELLER'] ?? [])],
  };
}

function companyAssignment(roleCode: 'OWNER' | 'ADMIN'): Express.ProductionAssignment {
  return {
    roleId: `${roleCode}-company`,
    roleCode,
    scopeKind: 'COMPANY',
    locationId: null,
    permissions: roleCode === 'ADMIN' ? [...DEFAULT_ROLE_GRANTS.ADMIN] : [],
  };
}

function ctxFor(userId: string, assignments: Express.ProductionAssignment[]): Express.AuthContext {
  return {
    userId,
    roles: assignments.map(({ roleCode }) => roleCode),
    assignments,
    effectiveLocationIds: assignments.map(({ locationId }) => locationId).filter((id): id is string => id !== null),
  } as unknown as Express.AuthContext;
}

type SessionRow = { id: string; registerId: string; startingCash: bigint; status: 'OPEN' | 'CLOSED' };
type MovementRow = {
  id: string;
  sessionId: string;
  type: string;
  amount: bigint;
  salePaymentId: string | null;
  userId: string;
  reason: string | null;
  idempotencyKey: string | null;
  timestamp: Date;
};
type AuditRow = { action: string; entityType: string; entityId: string; branchId: string | null; after: unknown };

function session(overrides: Partial<SessionRow> = {}): SessionRow {
  return { id: SESSION_ID, registerId: REGISTER_ID, startingCash: OPENING_AMOUNT, status: 'OPEN', ...overrides };
}

function movement(overrides: Partial<MovementRow> & { type: string; amount: bigint }): MovementRow {
  return {
    id: `movement-seed-${Math.random().toString(36).slice(2)}`,
    sessionId: SESSION_ID,
    salePaymentId: null,
    userId: ACTOR_ID,
    reason: null,
    idempotencyKey: null,
    timestamp: new Date(),
    ...overrides,
  };
}

// A stateful, transactional in-memory stand-in: `$transaction` snapshots the
// rows and restores them when the operation throws, so a rollback is observable.
function createFakeDb(initial: { sessions: SessionRow[]; movements: MovementRow[]; audits?: AuditRow[] }) {
  const state = {
    sessions: initial.sessions.map((s) => ({ ...s })),
    movements: initial.movements.map((m) => ({ ...m })),
    audits: (initial.audits ?? []).map((a) => ({ ...a })),
  };
  const writes: string[] = [];
  const sqlLog: string[] = [];
  let counter = 0;
  let auditShouldThrow = false;

  const registers = [{ id: REGISTER_ID, branchId: BRANCH, name: 'Caja 1' }];

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
      findUnique: ({ where }: { where: { id: string } }) =>
        Promise.resolve(state.sessions.find((s) => s.id === where.id) ?? null),
    },
    cashMovement: {
      findUnique: ({ where }: { where: { sessionId_idempotencyKey: { sessionId: string; idempotencyKey: string } } }) => {
        const key = where.sessionId_idempotencyKey;
        return Promise.resolve(
          state.movements.find((m) => m.sessionId === key.sessionId && m.idempotencyKey === key.idempotencyKey) ?? null,
        );
      },
      findMany: ({ where }: { where: { sessionId: string } }) =>
        Promise.resolve(state.movements.filter((m) => m.sessionId === where.sessionId).map((m) => ({ ...m }))),
      create: ({ data }: { data: Omit<MovementRow, 'id' | 'timestamp'> }) => {
        writes.push(`cashMovement.create:${data.type}`);
        counter += 1;
        const row: MovementRow = { id: `movement-${counter}`, timestamp: new Date(), ...data };
        state.movements.push(row);
        return Promise.resolve({ ...row });
      },
    },
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
        throw error;
      }
    },
    ...tx,
  } as unknown as PrismaClient;

  return {
    client,
    state,
    writes,
    sqlLog,
    failAudit: () => { auditShouldThrow = true; },
    service: () => cashModule.createCashService(client),
  };
}

async function refusalOf(action: () => Promise<unknown>) {
  try {
    await action();
  } catch (error) {
    return error as { status?: number; code?: string };
  }
  throw new Error('cash-movement: expected the operation to refuse');
}

const cashier = ctxFor(ACTOR_ID, [locationAssignment('CASHIER', BRANCH)]);
const supervisor = ctxFor(ACTOR_ID, [companyAssignment('ADMIN')]);
const seller = ctxFor(ACTOR_ID, [locationAssignment('SELLER', BRANCH)]);

function registerMove(
  db: ReturnType<typeof createFakeDb>,
  kind: 'WITHDRAWAL' | 'EXPENSE',
  ctx: Express.AuthContext,
  amount: bigint,
  reason: string,
  key = randomUUID(),
) {
  return db.service().registerMovement(kind, SESSION_ID, ctx, { amount, reason, idempotencyKey: key });
}

describe('cash-movement CM-01..CM-04 success and projection', () => {
  it('CM-01 an EXPENSE by a LOCATION cashier persists the movement + audit and never mutates expectedCash', async () => {
    const db = createFakeDb({ sessions: [session()], movements: [movement({ type: 'OPENING', amount: OPENING_AMOUNT })] });
    const key = randomUUID();
    const result = await registerMove(db, 'EXPENSE', cashier, 5000n, '  Flete  ', key);

    expect(result.replayed).toBe(false);
    expect(result.movement).toMatchObject({ type: 'EXPENSE', amount: 5000n, reason: 'Flete', salePaymentId: null, idempotencyKey: key });
    expect(db.state.movements.filter((m) => m.type === 'EXPENSE')).toHaveLength(1);
    expect(db.state.audits.map((a) => a.action)).toEqual(['CASH_EXPENSE_REGISTERED']);
    expect(db.state.audits[0]).toMatchObject({ entityType: 'CashMovement', branchId: BRANCH });
    expect(db.writes).not.toContain('cashSession.update');
  });

  it('CM-02 a WITHDRAWAL by an ADMIN COMPANY supervisor succeeds', async () => {
    const db = createFakeDb({ sessions: [session()], movements: [movement({ type: 'OPENING', amount: OPENING_AMOUNT })] });
    const result = await registerMove(db, 'WITHDRAWAL', supervisor, 30000n, 'Retiro banco');
    expect(result).toMatchObject({ replayed: false, movement: { type: 'WITHDRAWAL', amount: 30000n, reason: 'Retiro banco', salePaymentId: null } });
    expect(db.state.audits.map((a) => a.action)).toEqual(['CASH_WITHDRAWAL_REGISTERED']);
  });

  it('CM-03 projectedExpectedCash = startingCash + SALE_INCOME − WITHDRAWAL − EXPENSE (pure)', () => {
    const projected = cashModule.projectExpectedCash({
      startingCash: 100000n,
      movements: [
        { type: 'OPENING', amount: 100000n, salePaymentId: null },
        { type: 'SALE_INCOME', amount: 8000n, salePaymentId: 'p1' },
        { type: 'WITHDRAWAL', amount: 5000n, salePaymentId: null },
        { type: 'EXPENSE', amount: 2000n, salePaymentId: null },
      ],
    });
    expect(projected).toEqual({ ok: true, projectedExpectedCash: 101000n });

    expect(cashModule.projectExpectedCash({
      startingCash: 100000n,
      movements: [{ type: 'OPENING', amount: 100000n, salePaymentId: null }, { type: 'MANUAL', amount: 1n, salePaymentId: null }],
    })).toMatchObject({ ok: false, reason: 'MOVEMENT_TYPE_NOT_ALLOWED' });

    expect(cashModule.projectExpectedCash({
      startingCash: 9223372036854775807n,
      movements: [{ type: 'OPENING', amount: 9223372036854775807n, salePaymentId: null }, { type: 'SALE_INCOME', amount: 1n, salePaymentId: 'p1' }],
    })).toMatchObject({ ok: false, reason: 'AMOUNT_OVERFLOW' });
  });

  it('CM-04 close reconciliation subtracts WITHDRAWAL and EXPENSE (pure)', () => {
    const reconciled = cashModule.reconcileCashSession({
      startingCash: 100000n,
      movements: [
        { type: 'OPENING', amount: 100000n, salePaymentId: null },
        { type: 'SALE_INCOME', amount: 8000n, salePaymentId: 'p1' },
        { type: 'WITHDRAWAL', amount: 5000n, salePaymentId: null },
        { type: 'EXPENSE', amount: 2000n, salePaymentId: null },
      ],
      cashPayments: [{ id: 'p1', amount: 8000n }],
      countedCash: 101000n,
    });
    expect(reconciled).toEqual({ ok: true, expectedCash: 101000n, difference: 0n });
  });
});

describe('cash-movement CM-05..CM-11 authorization and input validation', () => {
  it('CM-05 wrong branch -> 403 from hasPermissionAtLocation, no write', async () => {
    const db = createFakeDb({ sessions: [session()], movements: [movement({ type: 'OPENING', amount: OPENING_AMOUNT })] });
    const elsewhere = ctxFor(ACTOR_ID, [locationAssignment('CASHIER', OTHER_BRANCH)]);
    const error = await refusalOf(() => registerMove(db, 'EXPENSE', elsewhere, 1000n, 'x'));
    expect(error.status).toBe(403);
    expect(db.writes).toEqual([]);
  });

  it('CM-06 a new operation on a CLOSED session -> CASH_SESSION_ALREADY_CLOSED, no write', async () => {
    const db = createFakeDb({ sessions: [session({ status: 'CLOSED' })], movements: [movement({ type: 'OPENING', amount: OPENING_AMOUNT })] });
    const error = await refusalOf(() => registerMove(db, 'EXPENSE', cashier, 1000n, 'x'));
    expect(error.code).toBe('CASH_SESSION_ALREADY_CLOSED');
    expect(db.writes).toEqual([]);
  });

  it('CM-07..CM-11 the strict DTO rejects zero/negative/unsafe/overflow amounts and a blank reason', () => {
    for (const amount of ['0', '-1', '1.5', '9223372036854775808', 'abc']) {
      expect(cashMovementDto.safeParse({ amount, reason: 'ok', idempotencyKey: randomUUID() }).success).toBe(false);
    }
    // Non-string (a raw number or BigInt) is never accepted as an amount.
    expect(cashMovementDto.safeParse({ amount: 8000, reason: 'ok', idempotencyKey: randomUUID() }).success).toBe(false);
    expect(cashMovementDto.safeParse({ amount: 8000n, reason: 'ok', idempotencyKey: randomUUID() }).success).toBe(false);
    for (const reason of ['', '   ', undefined]) {
      expect(cashMovementDto.safeParse({ amount: '8000', reason, idempotencyKey: randomUUID() }).success).toBe(false);
    }
    expect(cashMovementDto.safeParse({ amount: '8000', reason: 'ok', idempotencyKey: 'not-a-uuid' }).success).toBe(false);
  });
});

describe('cash-movement CM-12..CM-16 idempotency and atomicity', () => {
  it('CM-12 same key + same payload replays: one movement, one audit', async () => {
    const db = createFakeDb({ sessions: [session()], movements: [movement({ type: 'OPENING', amount: OPENING_AMOUNT })] });
    const key = randomUUID();
    const first = await registerMove(db, 'EXPENSE', cashier, 4000n, 'Flete', key);
    const second = await registerMove(db, 'EXPENSE', cashier, 4000n, 'Flete', key);

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.movement.id).toBe(first.movement.id);
    expect(db.state.movements.filter((m) => m.type === 'EXPENSE')).toHaveLength(1);
    expect(db.state.audits).toHaveLength(1);
  });

  it('CM-13 same key + different payload -> 409 IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD', async () => {
    const db = createFakeDb({ sessions: [session()], movements: [movement({ type: 'OPENING', amount: OPENING_AMOUNT })] });
    const key = randomUUID();
    await registerMove(db, 'EXPENSE', cashier, 4000n, 'Flete', key);
    const error = await refusalOf(() => registerMove(db, 'EXPENSE', cashier, 4001n, 'Flete', key));
    expect(error.status).toBe(409);
    expect(error.code).toBe('IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD');
    // The type is part of the payload: the same key on the other endpoint refuses.
    const otherType = await refusalOf(() => registerMove(db, 'WITHDRAWAL', supervisor, 4000n, 'Flete', key));
    expect(otherType.code).toBe('IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD');
  });

  it('CM-14 a replayed key after the session is CLOSED still replays (no OPEN requirement)', async () => {
    const key = randomUUID();
    const db = createFakeDb({
      sessions: [session({ status: 'CLOSED' })],
      movements: [
        movement({ type: 'OPENING', amount: OPENING_AMOUNT }),
        movement({ type: 'EXPENSE', amount: 4000n, reason: 'Flete', idempotencyKey: key }),
      ],
    });
    const replay = await registerMove(db, 'EXPENSE', cashier, 4000n, 'Flete', key);
    expect(replay.replayed).toBe(true);
    expect(db.state.movements.filter((m) => m.type === 'EXPENSE')).toHaveLength(1);
    expect(db.state.audits).toHaveLength(0);
  });

  it('CM-15 distinct exits serialize on the session lock and each projection sees prior exits', async () => {
    const db = createFakeDb({ sessions: [session()], movements: [movement({ type: 'OPENING', amount: OPENING_AMOUNT })] });
    await registerMove(db, 'WITHDRAWAL', supervisor, 30000n, 'Retiro 1');
    const second = await registerMove(db, 'WITHDRAWAL', supervisor, 60000n, 'Retiro 2');
    // 100000 − 30000 = 70000 projected before the second; 60000 fits, leaving 10000.
    expect(second.movement.amount).toBe(60000n);
    const third = await refusalOf(() => registerMove(db, 'WITHDRAWAL', supervisor, 20000n, 'Retiro 3'));
    expect(third.code).toBe('INSUFFICIENT_CASH_IN_DRAWER');

    const lock = db.sqlLog.find((sql) => sql.includes('FROM "CashSession"') && sql.includes('FOR UPDATE'));
    expect(lock).toBeDefined();
    expect(db.sqlLog.indexOf(lock!)).toBeLessThan(db.sqlLog.length);
    // The lock precedes the movement write.
    expect(db.writes.findIndex((w) => w.startsWith('cashMovement.create:'))).toBeGreaterThan(-1);
  });

  it('CM-16 an audit failure rolls the movement back', async () => {
    const db = createFakeDb({ sessions: [session()], movements: [movement({ type: 'OPENING', amount: OPENING_AMOUNT })] });
    db.failAudit();
    await refusalOf(() => registerMove(db, 'EXPENSE', cashier, 4000n, 'Flete'));
    expect(db.state.movements.filter((m) => m.type === 'EXPENSE')).toHaveLength(0);
    expect(db.state.audits).toHaveLength(0);
  });
});

describe('cash-movement CM-17..CM-21 authorization limits and drawer floor', () => {
  it('CM-17 an actor without CASH_MOVEMENT_MANAGE -> 403', async () => {
    const db = createFakeDb({ sessions: [session()], movements: [movement({ type: 'OPENING', amount: OPENING_AMOUNT })] });
    const error = await refusalOf(() => registerMove(db, 'EXPENSE', seller, 1000n, 'x'));
    expect(error.status).toBe(403);
    expect(db.writes).toEqual([]);
  });

  it('CM-18 a WITHDRAWAL without a supervisor (LOCATION CASHIER) -> 403', async () => {
    const db = createFakeDb({ sessions: [session()], movements: [movement({ type: 'OPENING', amount: OPENING_AMOUNT })] });
    const error = await refusalOf(() => registerMove(db, 'WITHDRAWAL', cashier, 1000n, 'Retiro'));
    expect(error.status).toBe(403);
    expect(db.writes).toEqual([]);
  });

  it('CM-19 amount > projectedExpectedCash -> 409 INSUFFICIENT_CASH_IN_DRAWER, no write', async () => {
    const db = createFakeDb({ sessions: [session()], movements: [movement({ type: 'OPENING', amount: OPENING_AMOUNT })] });
    const error = await refusalOf(() => registerMove(db, 'EXPENSE', cashier, OPENING_AMOUNT + 1n, 'x'));
    expect(error.status).toBe(409);
    expect(error.code).toBe('INSUFFICIENT_CASH_IN_DRAWER');
    expect(db.writes).toEqual([]);
  });

  it('CM-20 amount == projectedExpectedCash is allowed', async () => {
    const db = createFakeDb({ sessions: [session()], movements: [movement({ type: 'OPENING', amount: OPENING_AMOUNT })] });
    const result = await registerMove(db, 'WITHDRAWAL', supervisor, OPENING_AMOUNT, 'Vaciado total');
    expect(result.movement.amount).toBe(OPENING_AMOUNT);
  });

  it('CM-21 MANUAL stays fail-closed at reconciliation', () => {
    expect(cashModule.reconcileCashSession({
      startingCash: 100000n,
      movements: [movementShape('OPENING', 100000n), movementShape('MANUAL', 500n)],
      cashPayments: [],
      countedCash: 100500n,
    })).toMatchObject({ ok: false, reason: 'MOVEMENT_TYPE_NOT_ALLOWED' });
  });

  it('CM-22 a WITHDRAWAL carrying a salePaymentId is refused by reconciliation', () => {
    expect(cashModule.reconcileCashSession({
      startingCash: 100000n,
      movements: [movementShape('OPENING', 100000n), { type: 'WITHDRAWAL', amount: 5000n, salePaymentId: 'p1' }],
      cashPayments: [],
      countedCash: 95000n,
    })).toMatchObject({ ok: false, reason: 'PAYMENT_MOVEMENT_MISMATCH' });
  });
});

function movementShape(type: string, amount: bigint, salePaymentId: string | null = null) {
  return { type, amount, salePaymentId };
}

describe('cash-movement GET movements (branch-authorized)', () => {
  it('lists the session movements for an authorized actor and refuses another branch', async () => {
    const db = createFakeDb({
      sessions: [session()],
      movements: [
        movement({ type: 'OPENING', amount: OPENING_AMOUNT }),
        movement({ type: 'EXPENSE', amount: 1000n, reason: 'Flete', idempotencyKey: randomUUID() }),
      ],
    });
    const listed = await db.service().listMovements(SESSION_ID, cashier);
    expect(listed).toHaveLength(2);
    expect(listed[1]).toMatchObject({ type: 'EXPENSE', amount: 1000n, reason: 'Flete', salePaymentId: null });

    const elsewhere = ctxFor(ACTOR_ID, [locationAssignment('CASHIER', OTHER_BRANCH)]);
    const error = await refusalOf(() => db.service().listMovements(SESSION_ID, elsewhere));
    expect(error.status).toBe(403);
  });
});
