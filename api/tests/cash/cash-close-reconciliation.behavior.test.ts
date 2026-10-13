// CASH-1 (FR-CASH-001): DB-FREE behavioral coverage for the operational cash
// close with reconciliation. In-memory stubs only: no pg, no test-db harness,
// no database of any kind. PostgreSQL row-lock interleavings still require a
// LOCAL_TEST proof; these tests pin the reconciliation contract itself and
// the service-level persistence/authorization/lock contracts.
//
// PRE-REGISTERED EXPECTATIONS (2026-10-12):
//   A01 startingCash + Σ SALE_INCOME (net) defines expectedCash; counted == expected -> difference 0n
//   A02 counted < expected -> NEGATIVE difference
//   A03 counted > expected -> POSITIVE difference
//   A04 vuelto: reconciliation compares the payment's NET amount (amount), never receivedAmount
//   A05 two OPENING rows -> DUPLICATE_OPENING refusal, no writes
//   A06 OPENING.amount != startingCash -> OPENING_AMOUNT_MISMATCH refusal
//   A07 movements without OPENING -> MISSING_OPENING refusal
//   A08 a CLOSING row never changes expectedCash
//   A09 a MANUAL movement -> refusal, no writes
//   A10 an unknown movement type -> refusal
//   A11 a session CASH payment without its SALE_INCOME movement -> PAYMENT_MOVEMENT_MISMATCH
//   A12 a SALE_INCOME movement with null salePaymentId -> PAYMENT_MOVEMENT_MISMATCH
//   A13 a SALE_INCOME movement pointing outside the session's CASH payments -> PAYMENT_MOVEMENT_MISMATCH
//   A14 two SALE_INCOME movements for the same payment -> PAYMENT_MOVEMENT_MISMATCH
//   A15 movement amount != payment amount -> PAYMENT_MOVEMENT_MISMATCH
//   A16 BIGINT overflow while accumulating expectedCash -> AMOUNT_OVERFLOW refusal, no writes
//   A17 double close -> CASH_SESSION_ALREADY_CLOSED and no second CLOSING movement
//   A18 close without CASH_SESSION_CLOSE at the register's branch -> 403 before any write
//   A19 close persists expectedCash/countedCash/difference and audits them; CLOSING excluded from expected
//   A20 listSessions returns location-authorized history; pre-CASH-1 closes keep NULL reconciliation
//   A21 the CASH charge takes the CashSession row lock (FOR UPDATE) before writing SALE_INCOME
// (A22 "zero database effects" is the execution contract itself: this file runs
//  only through scripts/dev/safe-nodb-run.mjs, whose AST screen and containment
//  enforce it.)
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Request } from 'express';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { DEFAULT_ROLE_GRANTS } from '../../src/modules/rbac/role-permission-matrix.js';
import * as cashModule from '../../src/modules/cash/cash.service.js';
import { createPaymentsService } from '../../src/modules/payments/payments.service.js';

const BRANCH = 'branch-1';
const OTHER_BRANCH = 'branch-2';
const REGISTER_ID = 'register-1';
const SESSION_ID = 'session-1';
const CASHIER_ID = 'cashier-1';
const OPENING_AMOUNT = 100000n;

function assignment(roleCode: 'CASHIER', locationId: string): Express.ProductionAssignment {
  return {
    roleId: `${roleCode}-${locationId}`,
    roleCode,
    scopeKind: 'LOCATION',
    locationId,
    permissions: [...DEFAULT_ROLE_GRANTS[roleCode]],
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

function requestFor(userId: string, assignments: Express.ProductionAssignment[]): Request {
  return { auth: ctxFor(userId, assignments) } as unknown as Request;
}

type SessionRow = {
  id: string;
  registerId: string;
  openedById: string;
  openedAt: Date;
  closedById: string | null;
  closedAt: Date | null;
  startingCash: bigint;
  status: 'OPEN' | 'CLOSED';
  expectedCash?: bigint | null;
  countedCash?: bigint | null;
  difference?: bigint | null;
};

type MovementRow = { sessionId: string; type: string; amount: bigint; salePaymentId: string | null };
type PaymentRow = { id: string; saleId: string; method: string; amount: bigint; cashSessionId: string | null };

function openSession(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: SESSION_ID,
    registerId: REGISTER_ID,
    openedById: CASHIER_ID,
    openedAt: new Date(),
    closedById: null,
    closedAt: null,
    startingCash: OPENING_AMOUNT,
    status: 'OPEN',
    expectedCash: null,
    countedCash: null,
    difference: null,
    ...overrides,
  };
}

function openingMovement(sessionId = SESSION_ID, amount = OPENING_AMOUNT): MovementRow {
  return { sessionId, type: 'OPENING', amount, salePaymentId: null };
}

function incomeMovement(salePaymentId: string, amount: bigint, sessionId = SESSION_ID): MovementRow {
  return { sessionId, type: 'SALE_INCOME', amount, salePaymentId };
}

function cashPayment(id: string, amount: bigint, sessionId = SESSION_ID): PaymentRow {
  return { id, saleId: `sale-${id}`, method: 'CASH', amount, cashSessionId: sessionId };
}

// A tiny in-memory stand-in for the Prisma client surface the cash/payment
// services touch. Records every write and every raw SQL text so tests can
// assert on the lock and no-write contracts.
function createFakeDb(initial: {
  sessions: SessionRow[];
  movements: MovementRow[];
  payments: PaymentRow[];
}) {
  const writes: string[] = [];
  const sqlLog: string[] = [];
  const registers = [{ id: REGISTER_ID, branchId: BRANCH, name: 'Caja 1' }];
  let movementCounter = 0;
  const createdMovements: MovementRow[] = [];

  const matches = (row: Record<string, unknown>, where: Record<string, unknown> = {}) =>
    Object.entries(where).every(([key, value]) => row[key] === value);

  const tx = {
    $queryRaw: (templates: string[], ...values: unknown[]) => {
      const sql = templates.join('$?');
      sqlLog.push(sql);
      if (sql.includes('FROM "CashSession"') && sql.includes('FOR UPDATE')) {
        if (sql.includes('"registerId"')) {
          return Promise.resolve(
            initial.sessions
              .filter((session) => session.registerId === values[0] && session.status === 'OPEN')
              .map((session) => ({ ...session })),
          );
        }
        return Promise.resolve(
          initial.sessions.filter((session) => session.id === values[0]).map((session) => ({ ...session })),
        );
      }
      if (sql.includes('FROM "CashRegister"')) {
        const register = registers.find((candidate) => candidate.id === values[0]);
        return Promise.resolve(register ? [{ id: register.id, branchId: register.branchId }] : []);
      }
      if (sql.includes('FROM "Sale"')) {
        return Promise.resolve([
          {
            id: 'sale-1', branchId: BRANCH, status: 'PENDING_PAYMENT', total: 8000n,
            pricingMode: 'LIST', priceMode: 'CASH', wholesaleConfirmedAt: null, wholesaleConfirmedById: null,
          },
        ]);
      }
      return Promise.resolve([]);
    },
    cashRegister: {
      findFirst: () => Promise.resolve(registers[0]),
      findUniqueOrThrow: ({ where }: { where: { id: string } }) => {
        const register = registers.find((candidate) => candidate.id === where.id);
        if (!register) throw new Error('register not found');
        return Promise.resolve(register);
      },
    },
    cashSession: {
      findFirst: ({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(initial.sessions.find((session) => matches(session as unknown as Record<string, unknown>, where)) ?? null),
      findMany: ({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(initial.sessions.filter((session) => matches(session as unknown as Record<string, unknown>, where))),
      update: ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        writes.push('cashSession.update');
        const session = initial.sessions.find((candidate) => candidate.id === where.id);
        if (!session) throw new Error('session not found');
        Object.assign(session, data);
        return Promise.resolve({ ...session });
      },
    },
    cashMovement: {
      findMany: ({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(initial.movements.filter((movement) => matches(movement as unknown as Record<string, unknown>, where)).map((movement) => ({ ...movement }))),
      create: ({ data }: { data: MovementRow & { userId: string } }) => {
        writes.push(`cashMovement.create:${data.type}`);
        createdMovements.push({ ...data });
        initial.movements.push({ ...data });
        movementCounter += 1;
        return Promise.resolve({ id: `movement-${movementCounter}`, ...data, timestamp: new Date() });
      },
    },
    salePayment: {
      findUnique: () => Promise.resolve(null),
      findMany: ({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(initial.payments.filter((payment) => matches(payment as unknown as Record<string, unknown>, where)).map((payment) => ({ ...payment }))),
      create: ({ data }: { data: Record<string, unknown> }) => {
        writes.push('salePayment.create');
        const row = { id: `payment-created-${movementCounter}`, paidAt: new Date(), ...data } as unknown as PaymentRow & Record<string, unknown>;
        initial.payments.push(row);
        return Promise.resolve(row);
      },
    },
    saleItem: {
      findMany: () => Promise.resolve([{ variantId: 'v1', quantity: 1n }]),
    },
    stockReservation: {
      findMany: () =>
        Promise.resolve([
          { variantId: 'v1', branchId: BRANCH, quantity: 1n, status: 'ACTIVE', expiresAt: new Date(Date.now() + 3_600_000) },
        ]),
    },
    sale: { update: ({ where }: { where: { id: string } }) => { writes.push('sale.update'); return Promise.resolve({ id: where.id }); } },
    auditLog: { create: ({ data }: { data: Record<string, unknown> }) => { writes.push(`audit:${data.action}`); return Promise.resolve(data); } },
  };

  const client = {
    $transaction: async (operation: (transaction: unknown) => Promise<unknown>) => operation(tx),
  } as unknown as PrismaClient;
  // Non-transactional reads some flows use go through the same fake surface.
  Object.assign(client, tx);

  return { client, writes, sqlLog, createdMovements, sessions: initial.sessions };
}

const cashierAtBranch = ctxFor(CASHIER_ID, [assignment('CASHIER', BRANCH)]);

async function refusalOf(action: () => Promise<unknown>) {
  try {
    await action();
  } catch (error) {
    return error as { status?: number; code?: string; message?: string };
  }
  throw new Error('CASH-1: expected the operation to refuse');
}

describe('CASH-1 pure reconciliation (reconcileCashSession)', () => {
  const reconcile = (input: Parameters<NonNullable<typeof cashModule.reconcileCashSession>>[0]) =>
    cashModule.reconcileCashSession(input);

  it('A01 startingCash + net SALE_INCOME defines expectedCash; counted == expected -> difference 0', () => {
    const result = reconcile({
      startingCash: 100000n,
      movements: [openingMovement(), incomeMovement('p1', 8000n), incomeMovement('p2', 2000n)],
      cashPayments: [cashPayment('p1', 8000n), cashPayment('p2', 2000n)],
      countedCash: 110000n,
    });
    expect(result).toEqual({ ok: true, expectedCash: 110000n, difference: 0n });
  });

  it('A02 counted below expected -> NEGATIVE difference', () => {
    const result = reconcile({
      startingCash: 100000n,
      movements: [openingMovement(), incomeMovement('p1', 8000n)],
      cashPayments: [cashPayment('p1', 8000n)],
      countedCash: 105000n,
    });
    expect(result).toEqual({ ok: true, expectedCash: 108000n, difference: -3000n });
  });

  it('A03 counted above expected -> POSITIVE difference', () => {
    const result = reconcile({
      startingCash: 100000n,
      movements: [openingMovement(), incomeMovement('p1', 8000n)],
      cashPayments: [cashPayment('p1', 8000n)],
      countedCash: 112000n,
    });
    expect(result).toEqual({ ok: true, expectedCash: 108000n, difference: 4000n });
  });

  it('A04 vuelto: the movement is compared against the payment NET amount, never receivedAmount', () => {
    // received 10000, applied 8000, change 2000 -> the drawer keeps the net 8000.
    const net = reconcile({
      startingCash: 100000n,
      movements: [openingMovement(), incomeMovement('p1', 8000n)],
      cashPayments: [cashPayment('p1', 8000n)],
      countedCash: 108000n,
    });
    expect(net).toEqual({ ok: true, expectedCash: 108000n, difference: 0n });
    // A movement recorded with the GROSS received amount must not reconcile.
    const gross = reconcile({
      startingCash: 100000n,
      movements: [openingMovement(), incomeMovement('p1', 10000n)],
      cashPayments: [cashPayment('p1', 8000n)],
      countedCash: 110000n,
    });
    expect(gross).toMatchObject({ ok: false, reason: 'PAYMENT_MOVEMENT_MISMATCH' });
  });

  it('A05 two OPENING rows -> DUPLICATE_OPENING', () => {
    const result = reconcile({
      startingCash: 100000n,
      movements: [openingMovement(), openingMovement(), incomeMovement('p1', 8000n)],
      cashPayments: [cashPayment('p1', 8000n)],
      countedCash: 108000n,
    });
    expect(result).toMatchObject({ ok: false, reason: 'DUPLICATE_OPENING' });
  });

  it('A06 OPENING amount != startingCash -> OPENING_AMOUNT_MISMATCH', () => {
    const result = reconcile({
      startingCash: 100000n,
      movements: [openingMovement(SESSION_ID, 99999n), incomeMovement('p1', 8000n)],
      cashPayments: [cashPayment('p1', 8000n)],
      countedCash: 108000n,
    });
    expect(result).toMatchObject({ ok: false, reason: 'OPENING_AMOUNT_MISMATCH' });
  });

  it('A07 movements without OPENING -> MISSING_OPENING', () => {
    const result = reconcile({
      startingCash: 100000n,
      movements: [incomeMovement('p1', 8000n)],
      cashPayments: [cashPayment('p1', 8000n)],
      countedCash: 108000n,
    });
    expect(result).toMatchObject({ ok: false, reason: 'MISSING_OPENING' });
  });

  it('A08 a CLOSING row never changes expectedCash', () => {
    const result = reconcile({
      startingCash: 100000n,
      movements: [
        openingMovement(),
        incomeMovement('p1', 8000n),
        { sessionId: SESSION_ID, type: 'CLOSING', amount: 108000n, salePaymentId: null },
      ],
      cashPayments: [cashPayment('p1', 8000n)],
      countedCash: 108000n,
    });
    expect(result).toEqual({ ok: true, expectedCash: 108000n, difference: 0n });
  });

  it('A09 a MANUAL movement -> refusal', () => {
    const result = reconcile({
      startingCash: 100000n,
      movements: [openingMovement(), { sessionId: SESSION_ID, type: 'MANUAL', amount: 500n, salePaymentId: null }],
      cashPayments: [],
      countedCash: 100500n,
    });
    expect(result).toMatchObject({ ok: false, reason: 'MOVEMENT_TYPE_NOT_ALLOWED' });
  });

  it('A10 an unknown movement type -> refusal', () => {
    const result = reconcile({
      startingCash: 100000n,
      movements: [openingMovement(), { sessionId: SESSION_ID, type: 'ADJUSTMENT', amount: 500n, salePaymentId: null }],
      cashPayments: [],
      countedCash: 100500n,
    });
    expect(result).toMatchObject({ ok: false, reason: 'MOVEMENT_TYPE_NOT_ALLOWED' });
  });

  it('A11 a CASH payment without its SALE_INCOME movement -> PAYMENT_MOVEMENT_MISMATCH', () => {
    const result = reconcile({
      startingCash: 100000n,
      movements: [openingMovement()],
      cashPayments: [cashPayment('p1', 8000n)],
      countedCash: 100000n,
    });
    expect(result).toMatchObject({ ok: false, reason: 'PAYMENT_MOVEMENT_MISMATCH' });
  });

  it('A12 a SALE_INCOME movement with null salePaymentId -> PAYMENT_MOVEMENT_MISMATCH', () => {
    const result = reconcile({
      startingCash: 100000n,
      movements: [openingMovement(), { sessionId: SESSION_ID, type: 'SALE_INCOME', amount: 8000n, salePaymentId: null }],
      cashPayments: [],
      countedCash: 108000n,
    });
    expect(result).toMatchObject({ ok: false, reason: 'PAYMENT_MOVEMENT_MISMATCH' });
  });

  it('A13 a SALE_INCOME movement pointing outside the session payments -> PAYMENT_MOVEMENT_MISMATCH', () => {
    const result = reconcile({
      startingCash: 100000n,
      movements: [openingMovement(), incomeMovement('p-elsewhere', 8000n)],
      cashPayments: [cashPayment('p1', 8000n)],
      countedCash: 108000n,
    });
    expect(result).toMatchObject({ ok: false, reason: 'PAYMENT_MOVEMENT_MISMATCH' });
  });

  it('A14 two SALE_INCOME movements for the same payment -> PAYMENT_MOVEMENT_MISMATCH', () => {
    const result = reconcile({
      startingCash: 100000n,
      movements: [openingMovement(), incomeMovement('p1', 4000n), incomeMovement('p1', 4000n)],
      cashPayments: [cashPayment('p1', 8000n)],
      countedCash: 108000n,
    });
    expect(result).toMatchObject({ ok: false, reason: 'PAYMENT_MOVEMENT_MISMATCH' });
  });

  it('A15 movement amount != payment amount -> PAYMENT_MOVEMENT_MISMATCH', () => {
    const result = reconcile({
      startingCash: 100000n,
      movements: [openingMovement(), incomeMovement('p1', 7000n)],
      cashPayments: [cashPayment('p1', 8000n)],
      countedCash: 107000n,
    });
    expect(result).toMatchObject({ ok: false, reason: 'PAYMENT_MOVEMENT_MISMATCH' });
  });

  it('A16 BIGINT overflow while accumulating expectedCash -> AMOUNT_OVERFLOW', () => {
    const max = 9223372036854775807n;
    const result = reconcile({
      startingCash: max,
      movements: [openingMovement(SESSION_ID, max), incomeMovement('p1', 1n)],
      cashPayments: [cashPayment('p1', 1n)],
      countedCash: max,
    });
    expect(result).toMatchObject({ ok: false, reason: 'AMOUNT_OVERFLOW' });
  });
});

describe('CASH-1 closeSession service contract', () => {
  function serviceWith(db: ReturnType<typeof createFakeDb>) {
    return cashModule.createCashService(db.client);
  }

  function baseDb() {
    return createFakeDb({
      sessions: [openSession()],
      movements: [openingMovement(), incomeMovement('p1', 8000n)],
      payments: [cashPayment('p1', 8000n)],
    });
  }

  it('A19 close persists expectedCash/countedCash/difference, audits them, and keeps closingCash', async () => {
    const db = baseDb();
    const closed = await serviceWith(db).closeSession(SESSION_ID, cashierAtBranch, 108000n);

    expect(closed).toMatchObject({
      status: 'CLOSED',
      closingCash: 108000n,
      expectedCash: 108000n,
      countedCash: 108000n,
      difference: 0n,
    });
    expect(db.sessions[0]).toMatchObject({ status: 'CLOSED', expectedCash: 108000n, countedCash: 108000n, difference: 0n });

    const auditWrite = db.writes.find((entry) => entry.startsWith('audit:CASH_SESSION_CLOSED'));
    expect(auditWrite).toBeDefined();
    // The audited `after` snapshot is JSON-safe: money reached the audit log as strings.
    const session = db.sessions[0];
    expect(session).toBeTruthy();
    expect(db.writes).toContain('cashSession.update');
    expect(db.createdMovements).toEqual([
      expect.objectContaining({ sessionId: SESSION_ID, type: 'CLOSING', amount: 108000n, salePaymentId: null }),
    ]);
  });

  it('A05b a MANUAL movement refuses the close before any write', async () => {
    const db = createFakeDb({
      sessions: [openSession()],
      movements: [openingMovement(), { sessionId: SESSION_ID, type: 'MANUAL', amount: 500n, salePaymentId: null }],
      payments: [],
    });
    const error = await refusalOf(() => serviceWith(db).closeSession(SESSION_ID, cashierAtBranch, 100500n));
    expect(error.code).toBe('CASH_RECONCILIATION_INCONSISTENT');
    expect(error.status).toBe(409);
    expect(db.writes).toEqual([]);
  });

  it('A11b a payment without its movement refuses the close before any write', async () => {
    const db = createFakeDb({ sessions: [openSession()], movements: [openingMovement()], payments: [cashPayment('p1', 8000n)] });
    const error = await refusalOf(() => serviceWith(db).closeSession(SESSION_ID, cashierAtBranch, 100000n));
    expect(error.code).toBe('CASH_PAYMENTS_INCONSISTENT');
    expect(error.status).toBe(409);
    expect(db.writes).toEqual([]);
  });

  it('A17 double close refuses with CASH_SESSION_ALREADY_CLOSED and writes no second CLOSING movement', async () => {
    const db = createFakeDb({
      sessions: [openSession({ status: 'CLOSED', closedById: CASHIER_ID, closedAt: new Date() })],
      movements: [],
      payments: [],
    });
    const error = await refusalOf(() => serviceWith(db).closeSession(SESSION_ID, cashierAtBranch, 108000n));
    expect(error.code).toBe('CASH_SESSION_ALREADY_CLOSED');
    expect(db.writes).toEqual([]);
    expect(db.createdMovements).toEqual([]);
  });

  it('A18 close without CASH_SESSION_CLOSE at the register branch -> 403 before any write', async () => {
    const db = baseDb();
    const elsewhere = ctxFor(CASHIER_ID, [assignment('CASHIER', OTHER_BRANCH)]);
    const error = await refusalOf(() => serviceWith(db).closeSession(SESSION_ID, elsewhere, 108000n));
    expect(error.status).toBe(403);
    expect(db.writes).toEqual([]);
  });

  it('A20 listSessions returns location-authorized history; pre-CASH-1 closes keep NULL reconciliation', async () => {
    const legacy = openSession({
      id: 'session-legacy',
      status: 'CLOSED',
      closedById: CASHIER_ID,
      closedAt: new Date(),
      expectedCash: null,
      countedCash: null,
      difference: null,
    });
    const reconciled = openSession({
      id: 'session-2',
      status: 'CLOSED',
      closedById: CASHIER_ID,
      closedAt: new Date(),
      expectedCash: 108000n,
      countedCash: 107000n,
      difference: -1000n,
    });
    const db = createFakeDb({ sessions: [reconciled, legacy], movements: [], payments: [] });

    const history = await serviceWith(db).listSessions(BRANCH, cashierAtBranch);
    expect(history).toHaveLength(2);
    const legacyEntry = history.find((entry) => entry.sessionId === 'session-legacy');
    expect(legacyEntry).toMatchObject({ status: 'CLOSED', expectedCash: null, countedCash: null, difference: null });
    const reconciledEntry = history.find((entry) => entry.sessionId === 'session-2');
    expect(reconciledEntry).toMatchObject({ expectedCash: 108000n, countedCash: 107000n, difference: -1000n });

    const elsewhere = ctxFor(CASHIER_ID, [assignment('CASHIER', OTHER_BRANCH)]);
    const error = await refusalOf(() => serviceWith(db).listSessions(BRANCH, elsewhere));
    expect(error.status).toBe(403);
  });
});

describe('CASH-1 shared CashSession lock for the CASH charge', () => {
  it('A21 the CASH charge locks the CashSession row (FOR UPDATE) before writing SALE_INCOME', async () => {
    const db = createFakeDb({ sessions: [openSession()], movements: [], payments: [] });
    const payments = createPaymentsService(db.client);
    const req = requestFor(CASHIER_ID, [assignment('CASHIER', BRANCH)]);

    const result = await payments.registerPayment(req, CASHIER_ID, 'sale-1', {
      method: 'CASH',
      amount: 8000n,
      receivedAmount: 10000n,
      idempotencyKey: randomUUID(),
    });

    expect(result.payment).toMatchObject({ method: 'CASH', amount: 8000n, changeAmount: 2000n, cashSessionId: SESSION_ID });
    expect(db.createdMovements).toEqual([
      expect.objectContaining({ sessionId: SESSION_ID, type: 'SALE_INCOME', amount: 8000n }),
    ]);
    const sessionLock = db.sqlLog.find(
      (sql) => sql.includes('FROM "CashSession"') && sql.includes('"registerId"') && sql.includes('FOR UPDATE'),
    );
    expect(sessionLock).toBeDefined();
    // The lock happens before the movement write.
    expect(db.writes.indexOf('cashMovement.create:SALE_INCOME')).toBeGreaterThan(-1);
  });
});
