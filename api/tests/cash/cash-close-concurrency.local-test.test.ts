// CASH-1 J/K: opt-in proof on a NEW, isolated LOCAL_TEST PostgreSQL instance.
// No host configuration file, default Vitest setup, truncate, seed or reset.
// A marker AND owner-supplied cluster system identifier bind the intended
// isolated instance before this file writes a single fixture row. The owner
// must obtain that identifier from the new instance, never the existing one.
//
// PRE-CLASSIFIED ADVERSARIAL EXPECTATIONS (before any PostgreSQL run):
// A01 change: expectedCash uses net payment.amount, not receivedAmount.
// A02 two CASH payments: each has exactly one SALE_INCOME, both are counted.
// A03 same-key replay: one payment and movement, result.replayed is true.
// A04 same key/different payload: 409, no new payment or movement.
// A05 two closes: one CLOSING; loser gets CASH_SESSION_ALREADY_CLOSED.
// A06 counted short: negative difference, expectedCash unchanged.
// A07 counted over: positive difference, expectedCash unchanged.
// A08 no OPEN session: NO_OPEN_CASH_SESSION, no payment or movement.
// A09 reopened register: later CASH binds only to the new OPEN session.
// A10 non-CASH tender: no SALE_INCOME and no change to expectedCash.
// A11 payment audit failure: transaction rolls back payment and movement.
// A12 close audit failure: transaction rolls back CLOSING and CLOSED status.
// A13 real 40001 once: full close transaction retries and writes once.
// A14 real 40001 three times: CONCURRENCY_ERROR, no close side effects.
// J, K, A01, A03, A11-A14 are exercised here; the remaining
// expectations are classified follow-ups, never reported as passing tests.
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import type { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient, type Prisma } from '../../src/generated/prisma/client.js';
import { DEFAULT_ROLE_GRANTS } from '../../src/modules/rbac/role-permission-matrix.js';
import { createCashService } from '../../src/modules/cash/cash.service.js';
import { createPaymentsService } from '../../src/modules/payments/payments.service.js';
import {
  classifyLocalTestBaseline,
  defaultLocalTestCanonicalBaseline,
  readLocalTestBaselineFacts,
  type ApprovedMigration,
} from '../../scripts/local-test-baseline.js';

// CLEANUP ADVERSARIAL CLASSIFICATION (offline, before implementation):
// C01-C13: each ordered delete can fail after earlier deletes succeeded.
// C14: fixture creation can fail after its first write.
// C15: a failed afterEach must retain the IDs and prevent the next write.
// C16: a timed-out delete must retain the IDs and prevent the next write.
// C17: a successful retry must delete every targeted row before clearing IDs.
// C18: baseline classification can fail after deletion; new writes stay blocked.
// C19: a second fixture attempt while one is pending must do no reads or writes.
// C20: resource closure must still run after a cleanup failure.
// ERROR CLASSIFICATION (offline expectations fixed before implementation):
// E01 direct SQLSTATE 40001 -> 40001; E02 direct 40P01 -> unverified.
// E03 P2034 with adapter originalCode 40001 -> 40001.
// E04 P2034 with adapter originalCode 40P01 -> unverified.
// E05 P2034 without originalCode -> unverified.
// E06 P2010 with adapter originalCode 40001 -> 40001.
// E07 P2010 with adapter originalCode 23505 -> unverified.
// E08 P2010 without adapter cause -> unverified.
// E09 P2010 with only meta.code 40001 -> unverified.
// E10 P2010 with only message text 40001 -> unverified.
// E11 P2002 with adapter originalCode 40001 -> unverified.
// E12 P2010 with numeric originalCode 40001 -> unverified.
// E13 P2034 with contradictory meta.code 40001 and originalCode 40P01 -> unverified.
// E14 null and ordinary Error -> UNKNOWN; E15 nested cause without adapter -> unverified.
// E16 originalCode 40001 with a non-conflict adapter kind -> unverified.

const enabled = process.env.MONA_CASH_CLOSE_LOCAL_TEST === '1';
const STARTING = 10_000n;
const CHARGE = 8_000n;
const RECEIVED = 10_000n;
const G1_7: ApprovedMigration[] = [
  { name: '20260907015311_init', checksum: 'a584edab13a2ae540d694578ffa3b5a622decff04e238a5cf16d3040d295e4cb' },
  { name: '20260912182432_add_company_location', checksum: '19c345aa92c79a0a613dc03ea01dcf10e91b5a75fd6f3535076d8d71b6f740af' },
  { name: '20260912191702_add_user_role_scope', checksum: '2b415411eddc1212bf60419ce49022cea38d1fc2d12cb08938ad7c953caf7f3a' },
  { name: '20260922210000_d3_initial_stock_and_global_audit', checksum: '62b3b169e06a48dc2e2a3f81cee11e02a809b2733db2453c5b9eef91c15f77cf' },
  { name: '20261002120000_block1_pricing_wholesale', checksum: '45cf8d080e8fa4ec0a8dab9c9e5d4b780eb1642f0a8992d43b57dff655250173' },
  { name: '20261006120000_pilot_pricing_v2', checksum: 'd948f74e9c0eed3ce959f5c0e6edea70871d7d5957275f3304922e31bab6df12' },
  { name: '20261012120000_cash_session_reconciliation', checksum: 'd98b7ce082bff6810312866c81c26203146dff03c7a12e5f3bd6a595893fc47f' },
];

type Fixture = {
  branchId: string; userId: string; registerId: string; sessionId: string;
  saleId: string; itemId: string; holdId: string; inventoryId: string;
  paymentKey: string; ctx: Express.AuthContext; req: Request;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

type Gate = { arrived: ReturnType<typeof deferred<number>>; release: ReturnType<typeof deferred<void>> };
const gate = (): Gate => ({ arrived: deferred<number>(), release: deferred<void>() });
type Trace = { pids: number[]; failures: string[]; started: ReturnType<typeof deferred<number>> };
const trace = (): Trace => ({ pids: [], failures: [], started: deferred<number>() });

function classifySerializationFailure(error: unknown): string {
  const candidate = error as {
    code?: unknown;
    meta?: { driverAdapterError?: { cause?: { kind?: unknown; originalCode?: unknown } } };
  } | null;
  const code = typeof candidate?.code === 'string' ? candidate.code : 'UNKNOWN';
  if (code === '40001') return code;
  const cause = candidate?.meta?.driverAdapterError?.cause;
  if ((code === 'P2010' || code === 'P2034') &&
      cause?.kind === 'TransactionWriteConflict' && cause.originalCode === '40001') return '40001';
  return code;
}

let ownerPool: Pool;
let payPool: Pool;
let closePool: Pool;
let ownerDb: PrismaClient;
let payDb: PrismaClient;
let closeDb: PrismaClient;
let fixture: Fixture | null = null;
let cleanupFailed = false;

async function exactBaseline() {
  const facts = await readLocalTestBaselineFacts(ownerDb);
  return classifyLocalTestBaseline(facts, defaultLocalTestCanonicalBaseline(G1_7)).state;
}

async function makeFixture(): Promise<Fixture> {
  if (fixture || cleanupFailed) throw new Error('pending fixture cleanup blocks new writes');
  const id = randomUUID();
  const branchId = randomUUID();
  const userId = randomUUID();
  const registerId = randomUUID();
  const sessionId = randomUUID();
  const saleId = randomUUID();
  const itemId = randomUUID();
  const holdId = randomUUID();
  const inventoryId = randomUUID();
  const paymentKey = randomUUID();
  const company = await ownerDb.company.findFirstOrThrow({ select: { id: true } });
  const role = await ownerDb.role.findUniqueOrThrow({ where: { code: 'CASHIER' }, select: { id: true } });
  const variant = await ownerDb.productVariant.findFirstOrThrow({ select: { id: true, productId: true, sku: true }, orderBy: { id: 'asc' } });
  const assignment: Express.ProductionAssignment = {
    roleId: role.id, roleCode: 'CASHIER', scopeKind: 'LOCATION', locationId: branchId,
    permissions: [...DEFAULT_ROLE_GRANTS.CASHIER],
  };
  const ctx = {
    userId, roles: ['CASHIER'], assignments: [assignment], effectiveLocationIds: [branchId],
  } as Express.AuthContext;
  const f: Fixture = {
    branchId, userId, registerId, sessionId, saleId, itemId, holdId, inventoryId, paymentKey,
    ctx, req: { auth: ctx } as Request,
  };
  // Record the exact IDs before the first write, so partial fixture creation
  // still has a targeted cleanup path.
  fixture = f;
  const pointOfSaleNumber = 1_000_000 + parseInt(id.slice(0, 7), 16);
  await ownerDb.location.create({ data: {
    id: branchId, companyId: company.id, code: `cash-jk-${id}`, name: `Cash JK ${id}`,
    type: 'RETAIL_BRANCH', address: 'Test', pointOfSaleNumber,
  } });
  await ownerDb.branch.create({ data: {
    id: branchId, code: `cash-jk-${id}`, name: `Cash JK ${id}`, address: 'Test', pointOfSaleNumber,
  } });
  await ownerDb.user.create({ data: {
    id: userId, name: `Cash JK ${id}`, email: `cash-jk-${id}@test.invalid`, passwordHash: 'not-used',
  } });
  await ownerDb.userRoleScope.create({ data: { userId, roleId: role.id, scopeKind: 'LOCATION', locationId: branchId } });
  await ownerDb.inventory.create({ data: { id: inventoryId, variantId: variant.id, branchId, physical: 1n, reserved: 1n } });
  await ownerDb.cashRegister.create({ data: { id: registerId, branchId, name: `Cash JK ${id}` } });
  await ownerDb.cashSession.create({ data: { id: sessionId, registerId, openedById: userId, startingCash: STARTING, status: 'OPEN' } });
  await ownerDb.cashMovement.create({ data: { sessionId, type: 'OPENING', amount: STARTING, salePaymentId: null, userId } });
  await ownerDb.sale.create({ data: {
    id: saleId, sellerId: userId, branchId, status: 'PENDING_PAYMENT',
    priceMode: 'CASH', pricingMode: 'LIST', subtotal: CHARGE, discountTotal: 0n, total: CHARGE,
  } });
  await ownerDb.saleItem.create({ data: {
    id: itemId, saleId, variantId: variant.id, productId: variant.productId,
    productName: `Cash JK ${id}`, variantName: 'Test', sku: variant.sku,
    quantity: 1n, unitPrice: CHARGE, subtotal: CHARGE,
  } });
  await ownerDb.stockReservation.create({ data: {
    id: holdId, saleId, variantId: variant.id, branchId, quantity: 1n,
    expiresAt: new Date(Date.now() + 3_600_000), status: 'ACTIVE',
  } });
  return f;
}

async function cleanupFixture(verifyBaseline: () => Promise<string> = exactBaseline, timeoutMs = 45_000) {
  if (!fixture) {
    const wasFailed = cleanupFailed;
    cleanupFailed = true;
    expect(await verifyBaseline()).toBe('EXACT_BASELINE');
    cleanupFailed = wasFailed;
    return;
  }
  const f = fixture;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        // No prefix-wide deletions: only the exact IDs created by this test.
        await ownerDb.auditLog.deleteMany({ where: { OR: [{ entityId: f.sessionId }, { entityId: f.saleId }, { userId: f.userId }] } });
        await ownerDb.cashMovement.deleteMany({ where: { sessionId: f.sessionId } });
        await ownerDb.salePayment.deleteMany({ where: { saleId: f.saleId } });
        await ownerDb.stockReservation.deleteMany({ where: { id: f.holdId } });
        await ownerDb.saleItem.deleteMany({ where: { id: f.itemId } });
        await ownerDb.sale.deleteMany({ where: { id: f.saleId } });
        await ownerDb.cashSession.deleteMany({ where: { id: f.sessionId } });
        await ownerDb.cashRegister.deleteMany({ where: { id: f.registerId } });
        await ownerDb.inventory.deleteMany({ where: { id: f.inventoryId } });
        await ownerDb.userRoleScope.deleteMany({ where: { userId: f.userId, locationId: f.branchId } });
        await ownerDb.user.deleteMany({ where: { id: f.userId } });
        await ownerDb.branch.deleteMany({ where: { id: f.branchId } });
        await ownerDb.location.deleteMany({ where: { id: f.branchId } });
        expect(await verifyBaseline()).toBe('EXACT_BASELINE');
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('fixture cleanup timed out')), timeoutMs);
      }),
    ]);
    fixture = null;
  } catch (error) {
    cleanupFailed = true;
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function closeResources(clients: Array<PrismaClient | undefined>, pools: Array<Pool | undefined>) {
  const closedClients = await Promise.allSettled(clients.map((client) => client?.$disconnect()));
  const closedPools = await Promise.allSettled(pools.map((pool) => pool?.end()));
  const failures = [...closedClients, ...closedPools].filter((result) => result.status === 'rejected');
  if (failures.length) throw new AggregateError(failures.map((result) => result.reason), 'fixture resources did not close');
}

function instrument(base: PrismaClient, t: Trace, paused?: Gate, lockTable?: 'CashSession') {
  const transaction = base.$transaction.bind(base) as <T>(
    callback: (tx: Prisma.TransactionClient) => Promise<T>,
    options?: { isolationLevel?: Prisma.TransactionIsolationLevel; timeout?: number },
  ) => Promise<T>;
  return new Proxy(base, {
    get(target, property, receiver) {
      if (property !== '$transaction') return Reflect.get(target, property, receiver);
      return async <T>(callback: (tx: Prisma.TransactionClient) => Promise<T>, options?: { isolationLevel?: Prisma.TransactionIsolationLevel; timeout?: number }) => {
        try {
          return await transaction(async (tx) => {
            const pidRows = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
            const pid = pidRows[0]?.pid;
            if (!pid) throw new Error('payment/close backend PID unavailable');
            t.pids.push(pid);
            t.started.resolve(pid);
            const wrapped = new Proxy(tx, {
              get(inner, key, innerReceiver) {
                if (key !== '$queryRaw') return Reflect.get(inner, key, innerReceiver);
                return async (...args: unknown[]) => {
                  const sql = Array.isArray(args[0]) ? (args[0] as string[]).join('?') : '';
                  const result = await Reflect.apply(Reflect.get(inner, key) as (...a: unknown[]) => Promise<unknown>, inner, args);
                  if (paused && lockTable && t.pids.length === 1 && sql.includes(`FROM "${lockTable}"`) && sql.includes('FOR UPDATE')) {
                    paused.arrived.resolve(pid);
                    await paused.release.promise;
                  }
                  return result;
                };
              },
            }) as Prisma.TransactionClient;
            return callback(wrapped);
          }, options);
        } catch (error) {
          t.failures.push(classifySerializationFailure(error));
          throw error;
        }
      };
    },
  }) as PrismaClient;
}

function failAtAudit(base: PrismaClient): PrismaClient {
  const transaction = base.$transaction.bind(base) as <T>(
    callback: (tx: Prisma.TransactionClient) => Promise<T>,
    options?: { isolationLevel?: Prisma.TransactionIsolationLevel; timeout?: number },
  ) => Promise<T>;
  return new Proxy(base, {
    get(target, property, receiver) {
      if (property !== '$transaction') return Reflect.get(target, property, receiver);
      return <T>(callback: (tx: Prisma.TransactionClient) => Promise<T>, options?: { isolationLevel?: Prisma.TransactionIsolationLevel; timeout?: number }) =>
        transaction((tx) => callback(new Proxy(tx, {
          get(inner, key, innerReceiver) {
            if (key !== 'auditLog') return Reflect.get(inner, key, innerReceiver);
            return new Proxy(inner.auditLog, {
              get(delegate, method, delegateReceiver) {
                if (method === 'create') return () => Promise.reject(new Error('intentional audit failure'));
                return Reflect.get(delegate, method, delegateReceiver);
              },
            });
          },
        }) as Prisma.TransactionClient), options);
    },
  }) as PrismaClient;
}

async function proveBlocked(waiterPid: number, holderPid: number) {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const { rows } = await ownerPool.query<{
      pid: number; wait_event_type: string | null; query: string; xact_start: Date | null; blockers: number[];
    }>(`SELECT a.pid, a.wait_event_type, a.query, a.xact_start, pg_blocking_pids(a.pid) AS blockers
        FROM pg_stat_activity a WHERE a.pid = $1 AND a.datname = current_database()`, [waiterPid]);
    const row = rows[0];
    if (row?.wait_event_type === 'Lock' && row.xact_start && row.blockers.includes(holderPid)) {
      expect(row.query).toContain('CashSession');
      expect(row.query).toContain('FOR UPDATE');
      return;
    }
    // Poll interval bounds observer load; only pg_blocking_pids is evidence.
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('CASH-1 lock relationship was not observed');
}

async function assertAccounting(f: Fixture, expectedPayments: number, expectedCash: bigint, status: 'OPEN' | 'CLOSED') {
  const session = await ownerDb.cashSession.findUniqueOrThrow({ where: { id: f.sessionId } });
  const payments = await ownerDb.salePayment.findMany({ where: { saleId: f.saleId } });
  const movements = await ownerDb.cashMovement.findMany({ where: { sessionId: f.sessionId } });
  const incomes = movements.filter((m) => m.type === 'SALE_INCOME');
  const closings = movements.filter((m) => m.type === 'CLOSING');
  expect(session.status).toBe(status);
  expect(payments).toHaveLength(expectedPayments);
  expect(incomes).toHaveLength(expectedPayments);
  expect(new Set(payments.map((p) => p.id)).size).toBe(expectedPayments);
  expect(new Set(incomes.map((m) => m.salePaymentId)).size).toBe(expectedPayments);
  for (const payment of payments) {
    expect(payment.cashSessionId).toBe(f.sessionId);
    expect(incomes.filter((m) => m.salePaymentId === payment.id)).toEqual([
      expect.objectContaining({ amount: payment.amount, sessionId: f.sessionId }),
    ]);
  }
  expect(STARTING + payments.reduce((sum, payment) => sum + payment.amount, 0n)).toBe(expectedCash);
  expect(closings).toHaveLength(status === 'CLOSED' ? 1 : 0);
  if (status === 'CLOSED') {
    expect(session.expectedCash).toBe(expectedCash);
    expect(session.countedCash).toBe(expectedCash);
    expect(session.difference).toBe(0n);
    expect(closings[0]?.amount).toBe(expectedCash);
  } else {
    expect(session.expectedCash).toBeNull();
    expect(session.countedCash).toBeNull();
    expect(session.difference).toBeNull();
  }
  expect(await ownerDb.auditLog.count({ where: { userId: f.userId, action: 'PAYMENT_REGISTERED' } })).toBe(expectedPayments);
  expect(await ownerDb.auditLog.count({ where: { entityType: 'CashSession', entityId: f.sessionId, action: 'CASH_SESSION_CLOSED' } })).toBe(status === 'CLOSED' ? 1 : 0);
}

async function appError(promise: Promise<unknown>, code: string) {
  const error = await promise.then(() => null, (cause: unknown) => cause);
  expect(error).toMatchObject({ status: 409, code });
}

function requireSignal<T>(signal: Promise<T>, operation: Promise<unknown>): Promise<T> {
  return Promise.race([
    signal,
    operation.then(
      () => { throw new Error('operation completed before the required lock proof'); },
      (error: unknown) => { throw error; },
    ),
  ]);
}

describe.skipIf(!enabled)('CASH-1 J/K isolated PostgreSQL contention proof', () => {
  beforeAll(async () => {
    // The selector and all binding inputs must be explicit. Nothing reads the
    // existing ~/.config/mona-jacinta/local-test.env or host checkpoint files.
    if (process.env.MONA_TEST_DATABASE_TARGET !== 'local') throw new Error('LOCAL_TEST selector required');
    const expectedMarker = process.env.MONA_CASH_CLOSE_ISOLATED_MARKER_ID;
    const expectedSystemId = process.env.MONA_CASH_CLOSE_ISOLATED_SYSTEM_ID;
    if (!expectedMarker || expectedMarker !== process.env.LOCAL_TEST_DATABASE_MARKER_ID ||
        !expectedSystemId || !/^[1-9][0-9]{15,20}$/.test(expectedSystemId)) {
      throw new Error('isolated LOCAL_TEST binding is missing');
    }
    const { openProvenLocalTestPool } = await import('../../scripts/demo-database.js');
    const opened: Pool[] = [];
    try {
      const first = await openProvenLocalTestPool(3, process.env);
      opened.push(first.pool);
      const second = await openProvenLocalTestPool(1, process.env);
      opened.push(second.pool);
      const third = await openProvenLocalTestPool(1, process.env);
      opened.push(third.pool);
      [ownerPool, payPool, closePool] = opened as [Pool, Pool, Pool];
      const { rows } = await ownerPool.query<{ system_id: string }>('SELECT system_identifier::text AS system_id FROM pg_control_system()');
      if (rows.length !== 1 || rows[0]?.system_id !== expectedSystemId) throw new Error('isolated PostgreSQL cluster does not match binding');
      // G1-7 adds these physical nullable BIGINT columns after status. A
      // migration ledger row alone cannot prove that the live table has them.
      const columns = await ownerPool.query<{
        attnum: number; attname: string; data_type: string; attnotnull: boolean; atthasdef: boolean;
      }>(`SELECT attnum, attname, format_type(atttypid, atttypmod) AS data_type, attnotnull, atthasdef
          FROM pg_attribute
          WHERE attrelid = 'public."CashSession"'::regclass AND attnum BETWEEN 9 AND 11 AND NOT attisdropped
          ORDER BY attnum`);
      expect(columns.rows).toEqual(['expectedCash', 'countedCash', 'difference'].map((attname, index) => ({
        attnum: index + 9, attname, data_type: 'bigint', attnotnull: false, atthasdef: false,
      })));
      ownerDb = new PrismaClient({ adapter: new PrismaPg(ownerPool, { schema: 'public' }), log: [] });
      payDb = new PrismaClient({ adapter: new PrismaPg(payPool, { schema: 'public' }), log: [] });
      closeDb = new PrismaClient({ adapter: new PrismaPg(closePool, { schema: 'public' }), log: [] });
      expect(await exactBaseline()).toBe('EXACT_BASELINE');
    } catch (error) {
      try {
        await closeResources([ownerDb, payDb, closeDb], opened);
      } catch (closeError) {
        throw new AggregateError([error, closeError], 'isolated setup and resource closure failed', { cause: closeError });
      }
      throw error;
    }
  });

  afterEach(async () => {
    await cleanupFixture();
  });

  afterAll(async () => {
    await closeResources([ownerDb, payDb, closeDb], [ownerPool, payPool, closePool]);
  });

  it('J: confirmed CASH payment precedes close; close includes it, with no duplicate on replay', async () => {
    const f = await makeFixture();
    const payGate = gate();
    const payTrace = trace();
    const closeTrace = trace();
    const pay = createPaymentsService(instrument(payDb, payTrace, payGate, 'CashSession'));
    const close = createCashService(instrument(closeDb, closeTrace));
    const input = { method: 'CASH' as const, amount: CHARGE, receivedAmount: RECEIVED, idempotencyKey: f.paymentKey };
    const payment = pay.registerPayment(f.req, f.userId, f.saleId, input);
    let closing: Promise<unknown> | undefined;
    try {
      const holderPid = await requireSignal(payGate.arrived.promise, payment);
      closing = close.closeSession(f.sessionId, f.ctx, STARTING + CHARGE);
      const waiterPid = await requireSignal(closeTrace.started.promise, closing);
      expect(waiterPid).not.toBe(holderPid);
      await proveBlocked(waiterPid, holderPid);
    } finally {
      payGate.release.resolve();
      await Promise.allSettled([payment, closing]);
    }
    const paid = await payment;
    const closed = await closing;
    expect(paid).toMatchObject({ replayed: false, payment: { amount: CHARGE, receivedAmount: RECEIVED, changeAmount: RECEIVED - CHARGE } });
    expect(closed).toMatchObject({ status: 'CLOSED', expectedCash: STARTING + CHARGE, difference: 0n });
    const replay = await createPaymentsService(payDb).registerPayment(f.req, f.userId, f.saleId, input);
    expect(replay).toMatchObject({ replayed: true, payment: { id: paid.payment.id } });
    expect(closeTrace.pids.length).toBeGreaterThanOrEqual(1);
    expect(closeTrace.pids.length).toBeLessThanOrEqual(3);
    expect(closeTrace.failures.every((code) => code === '40001')).toBe(true);
    await assertAccounting(f, 1, STARTING + CHARGE, 'CLOSED');
  });

  it('K: close precedes CASH payment; payment rejects without a partial write', async () => {
    const f = await makeFixture();
    const closeGate = gate();
    const payTrace = trace();
    const closeTrace = trace();
    const close = createCashService(instrument(closeDb, closeTrace, closeGate, 'CashSession'));
    const pay = createPaymentsService(instrument(payDb, payTrace));
    const closing = close.closeSession(f.sessionId, f.ctx, STARTING);
    let payment: Promise<unknown> | undefined;
    try {
      const holderPid = await requireSignal(closeGate.arrived.promise, closing);
      payment = pay.registerPayment(f.req, f.userId, f.saleId, {
        method: 'CASH', amount: CHARGE, receivedAmount: RECEIVED, idempotencyKey: f.paymentKey,
      });
      const waiterPid = await requireSignal(payTrace.started.promise, payment);
      expect(waiterPid).not.toBe(holderPid);
      await proveBlocked(waiterPid, holderPid);
    } finally {
      closeGate.release.resolve();
      await Promise.allSettled([closing, payment]);
    }
    expect(await closing).toMatchObject({ status: 'CLOSED', expectedCash: STARTING });
    await appError(payment!, 'NO_OPEN_CASH_SESSION');
    expect(payTrace.pids.length).toBeGreaterThanOrEqual(1);
    expect(payTrace.pids.length).toBeLessThanOrEqual(3);
    expect(payTrace.failures.some((code) => code === '40001')).toBe(true);
    await assertAccounting(f, 0, STARTING, 'CLOSED');
    expect((await ownerDb.sale.findUniqueOrThrow({ where: { id: f.saleId } })).paymentStartedAt).toBeNull();
  });

  it('A11/A12: failures after real payment and close writes roll back their complete transactions', async () => {
    const f = await makeFixture();
    const failedPay = createPaymentsService(failAtAudit(payDb));
    await expect(failedPay.registerPayment(f.req, f.userId, f.saleId, {
      method: 'CASH', amount: CHARGE, receivedAmount: RECEIVED, idempotencyKey: f.paymentKey,
    })).rejects.toThrow('intentional audit failure');
    await assertAccounting(f, 0, STARTING, 'OPEN');
    expect((await ownerDb.sale.findUniqueOrThrow({ where: { id: f.saleId } })).paymentStartedAt).toBeNull();

    const failedClose = createCashService(failAtAudit(closeDb));
    await expect(failedClose.closeSession(f.sessionId, f.ctx, STARTING)).rejects.toThrow('intentional audit failure');
    await assertAccounting(f, 0, STARTING, 'OPEN');
  });

  it.each([1, 3] as const)('A13/A14: %i real serializable conflict(s) retry or exhaust without partial writes', async (conflictCount) => {
    const f = await makeFixture();
    const t = trace();
    const barriers = Array.from({ length: conflictCount }, () => ({ ready: deferred<void>(), go: deferred<void>(), pid: deferred<number>() }));
    let attempt = 0;
    const transaction = closeDb.$transaction.bind(closeDb) as <T>(callback: (tx: Prisma.TransactionClient) => Promise<T>, options?: { isolationLevel?: Prisma.TransactionIsolationLevel; timeout?: number }) => Promise<T>;
    const controlled = new Proxy(closeDb, {
      get(target, property, receiver) {
        if (property !== '$transaction') return Reflect.get(target, property, receiver);
        return async <T>(callback: (tx: Prisma.TransactionClient) => Promise<T>, options?: { isolationLevel?: Prisma.TransactionIsolationLevel; timeout?: number }) => {
          const index = attempt++;
          const barrier = barriers[index];
          if (!barrier) {
            if (conflictCount === 1 && index === 1) return transaction(callback, options);
            throw new Error('unexpected extra attempt');
          }
          barrier.ready.resolve();
          await barrier.go.promise;
          try {
            return await transaction(async (tx) => {
              const pidRows = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
              const pid = pidRows[0]?.pid;
              if (!pid) throw new Error('close backend PID unavailable');
              t.pids.push(pid);
              barrier.pid.resolve(pid);
              return callback(tx);
            }, options);
          } catch (error) {
            t.failures.push(classifySerializationFailure(error));
            throw error;
          }
        };
      },
    }) as PrismaClient;
    const closePromise = createCashService(controlled).closeSession(f.sessionId, f.ctx, STARTING);
    void closePromise.catch(() => undefined);
    try {
      for (const barrier of barriers) {
        await requireSignal(barrier.ready.promise, closePromise);
        const holder = await ownerPool.connect();
        let committed = false;
        try {
          await holder.query('BEGIN');
          const holderPid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
          if (!holderPid) throw new Error('holder backend PID unavailable');
          // New tuple version with unchanged business value: forces a genuine
          // 40001 when the serializable close later locks this row.
          await holder.query('UPDATE "CashSession" SET "openedAt" = "openedAt" WHERE id = $1', [f.sessionId]);
          barrier.go.resolve();
          const waiterPid = await requireSignal(barrier.pid.promise, closePromise);
          expect(waiterPid).not.toBe(holderPid);
          await proveBlocked(waiterPid, holderPid);
          await holder.query('COMMIT');
          committed = true;
        } finally {
          if (!committed) await holder.query('ROLLBACK').catch(() => undefined);
          holder.release();
        }
      }
    } finally {
      for (const barrier of barriers) barrier.go.resolve();
      await Promise.allSettled([closePromise]);
    }
    if (conflictCount === 1) {
      expect(await closePromise).toMatchObject({ status: 'CLOSED', expectedCash: STARTING });
      expect(attempt).toBe(2);
      await assertAccounting(f, 0, STARTING, 'CLOSED');
    } else {
      await appError(closePromise, 'CONCURRENCY_ERROR');
      expect(attempt).toBe(3);
      await assertAccounting(f, 0, STARTING, 'OPEN');
    }
    expect(t.failures).toHaveLength(conflictCount);
    expect(t.failures.every((code) => code === '40001')).toBe(true);
  });
});

describe('CASH-1 fixture cleanup offline', () => {
  const deletionOrder = [
    'auditLog', 'cashMovement', 'salePayment', 'stockReservation', 'saleItem', 'sale',
    'cashSession', 'cashRegister', 'inventory', 'userRoleScope', 'user', 'branch', 'location',
  ] as const;
  const pending = () => ({
    branchId: 'branch', userId: 'user', registerId: 'register', sessionId: 'session',
    saleId: 'sale', itemId: 'item', holdId: 'hold', inventoryId: 'inventory',
  }) as Fixture;

  it('retains a partially cleaned fixture and refuses a new write', async () => {
    const previousDb = ownerDb;
    const previousFixture = fixture;
    const previousCleanupFailed = cleanupFailed;
    let writes = 0;
    const f = {
      branchId: 'branch', userId: 'user', registerId: 'register', sessionId: 'session',
      saleId: 'sale', itemId: 'item', holdId: 'hold', inventoryId: 'inventory',
    } as Fixture;
    ownerDb = new Proxy({} as PrismaClient, {
      get(_target, model: string) {
        return {
          deleteMany: async () => { if (model === 'cashMovement') throw new Error('partial cleanup'); },
          findFirstOrThrow: async () => ({ id: 'existing', productId: 'product', sku: 'sku' }),
          findUniqueOrThrow: async () => ({ id: 'role' }),
          create: async () => { writes++; },
        };
      },
    });
    fixture = f;
    try {
      await expect(cleanupFixture(async () => 'EXACT_BASELINE')).rejects.toThrow('partial cleanup');
      expect(fixture).toBe(f);
      await expect(makeFixture()).rejects.toThrow('pending fixture cleanup');
      expect(writes).toBe(0);
      expect(fixture).toBe(f);
    } finally {
      ownerDb = previousDb;
      fixture = previousFixture;
      cleanupFailed = previousCleanupFailed;
    }
  });

  it.each(deletionOrder)('C01-C13 %s failure retains all IDs; retry completes targeted cleanup', async (failedModel) => {
    const previousDb = ownerDb;
    const previousFixture = fixture;
    const previousCleanupFailed = cleanupFailed;
    const f = pending();
    let fail = true;
    let verified = 0;
    const calls: string[] = [];
    ownerDb = new Proxy({} as PrismaClient, {
      get(_target, model: string) {
        return { deleteMany: async () => {
          calls.push(model);
          if (fail && model === failedModel) throw new Error(`failed ${model}`);
        } };
      },
    });
    fixture = f;
    cleanupFailed = false;
    try {
      await expect(cleanupFixture(async () => { verified++; return 'EXACT_BASELINE'; })).rejects.toThrow(`failed ${failedModel}`);
      expect(calls).toEqual(deletionOrder.slice(0, deletionOrder.indexOf(failedModel) + 1));
      expect(verified).toBe(0);
      expect(fixture).toBe(f);
      expect(cleanupFailed).toBe(true);
      fail = false;
      calls.length = 0;
      await cleanupFixture(async () => { verified++; return 'EXACT_BASELINE'; });
      expect(calls).toEqual(deletionOrder);
      expect(verified).toBe(1);
      expect(fixture).toBeNull();
      await expect(makeFixture()).rejects.toThrow('pending fixture cleanup');
    } finally {
      ownerDb = previousDb;
      fixture = previousFixture;
      cleanupFailed = previousCleanupFailed;
    }
  });

  it('C16 timeout keeps IDs and blocks writes even if the delayed delete later resolves', async () => {
    const previousDb = ownerDb;
    const previousFixture = fixture;
    const previousCleanupFailed = cleanupFailed;
    const f = pending();
    let release!: () => void;
    let delayed = true;
    ownerDb = new Proxy({} as PrismaClient, {
      get() { return { deleteMany: () => {
        if (!delayed) return Promise.resolve();
        delayed = false;
        return new Promise<void>((resolve) => { release = resolve; });
      } }; },
    });
    fixture = f;
    cleanupFailed = false;
    try {
      await expect(cleanupFixture(async () => 'EXACT_BASELINE', 5)).rejects.toThrow('fixture cleanup timed out');
      expect(fixture).toBe(f);
      release();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(fixture).toBe(f);
      await expect(makeFixture()).rejects.toThrow('pending fixture cleanup');
    } finally {
      ownerDb = previousDb;
      fixture = previousFixture;
      cleanupFailed = previousCleanupFailed;
    }
  });

  it('C18 baseline failure retains IDs after every delete and blocks new writes', async () => {
    const previousDb = ownerDb;
    const previousFixture = fixture;
    const previousCleanupFailed = cleanupFailed;
    const f = pending();
    const calls: string[] = [];
    ownerDb = new Proxy({} as PrismaClient, {
      get(_target, model: string) { return { deleteMany: async () => { calls.push(model); } }; },
    });
    fixture = f;
    cleanupFailed = false;
    try {
      await expect(cleanupFixture(async () => 'OPERATIONAL_DATA')).rejects.toThrow();
      expect(calls).toEqual(deletionOrder);
      expect(fixture).toBe(f);
      await expect(makeFixture()).rejects.toThrow('pending fixture cleanup');
    } finally {
      ownerDb = previousDb;
      fixture = previousFixture;
      cleanupFailed = previousCleanupFailed;
    }
  });

  it('C14 partial fixture creation keeps its IDs and prevents replacement', async () => {
    const previousDb = ownerDb;
    const previousFixture = fixture;
    const previousCleanupFailed = cleanupFailed;
    let writes = 0;
    ownerDb = new Proxy({} as PrismaClient, {
      get(_target, model: string) {
        return {
          findFirstOrThrow: async () => ({ id: 'existing', productId: 'product', sku: 'sku' }),
          findUniqueOrThrow: async () => ({ id: 'role' }),
          create: async () => { if (++writes === 2) throw new Error(`creation failed at ${model}`); },
        };
      },
    });
    fixture = null;
    cleanupFailed = false;
    try {
      await expect(makeFixture()).rejects.toThrow('creation failed at branch');
      const first = fixture;
      expect(first).not.toBeNull();
      expect(writes).toBe(2);
      await expect(makeFixture()).rejects.toThrow('pending fixture cleanup');
      expect(writes).toBe(2);
      expect(fixture).toBe(first);
    } finally {
      ownerDb = previousDb;
      fixture = previousFixture;
      cleanupFailed = previousCleanupFailed;
    }
  });

  it('C18 baseline failure with no fixture blocks subsequent creation', async () => {
    const previousFixture = fixture;
    const previousCleanupFailed = cleanupFailed;
    fixture = null;
    cleanupFailed = false;
    try {
      await expect(cleanupFixture(async () => 'OPERATIONAL_DATA')).rejects.toThrow();
      expect(cleanupFailed).toBe(true);
      await expect(makeFixture()).rejects.toThrow('pending fixture cleanup');
    } finally {
      fixture = previousFixture;
      cleanupFailed = previousCleanupFailed;
    }
  });

  it('C20 attempts every client and pool close and reports a failed close', async () => {
    const calls: string[] = [];
    const client = (name: string, fail = false) => ({
      $disconnect: async () => { calls.push(name); if (fail) throw new Error('disconnect failed'); },
    }) as PrismaClient;
    const pool = (name: string) => ({ end: async () => { calls.push(name); } }) as Pool;
    await expect(closeResources(
      [client('owner', true), client('pay'), client('close')],
      [pool('owner pool'), pool('pay pool'), pool('close pool')],
    )).rejects.toThrow('fixture resources did not close');
    expect(calls).toEqual(['owner', 'pay', 'close', 'owner pool', 'pay pool', 'close pool']);
  });
});

describe('CASH-1 PostgreSQL serialization classifier offline', () => {
  const adapterError = (code: string, originalCode: unknown) => ({
    code, meta: { driverAdapterError: { cause: { kind: 'TransactionWriteConflict', originalCode } } },
  });
  const cases: Array<{ name: string; error: unknown; expected: string }> = [
    { name: 'E01 direct 40001', error: { code: '40001' }, expected: '40001' },
    { name: 'E02 direct 40P01', error: { code: '40P01' }, expected: '40P01' },
    { name: 'E03 P2034 backed by 40001', error: adapterError('P2034', '40001'), expected: '40001' },
    { name: 'E04 P2034 backed by 40P01', error: adapterError('P2034', '40P01'), expected: 'P2034' },
    { name: 'E05 P2034 without original code', error: { code: 'P2034' }, expected: 'P2034' },
    { name: 'E06 P2010 backed by 40001', error: adapterError('P2010', '40001'), expected: '40001' },
    { name: 'E07 P2010 backed by 23505', error: adapterError('P2010', '23505'), expected: 'P2010' },
    { name: 'E08 generic P2010', error: { code: 'P2010' }, expected: 'P2010' },
    { name: 'E09 P2010 with only meta.code', error: { code: 'P2010', meta: { code: '40001' } }, expected: 'P2010' },
    { name: 'E10 P2010 with only message text', error: { code: 'P2010', message: '40001' }, expected: 'P2010' },
    { name: 'E11 P2002 with nested 40001', error: adapterError('P2002', '40001'), expected: 'P2002' },
    { name: 'E12 P2010 with numeric original code', error: adapterError('P2010', 40001), expected: 'P2010' },
    { name: 'E13 contradictory P2034 codes', error: { ...adapterError('P2034', '40P01'), meta: { code: '40001', driverAdapterError: { cause: { kind: 'TransactionWriteConflict', originalCode: '40P01' } } } }, expected: 'P2034' },
    { name: 'E14 null', error: null, expected: 'UNKNOWN' },
    { name: 'E14 ordinary error', error: new Error('40001'), expected: 'UNKNOWN' },
    { name: 'E15 cause without adapter', error: { code: 'P2010', cause: { originalCode: '40001' } }, expected: 'P2010' },
    { name: 'E16 unrelated adapter kind', error: { code: 'P2010', meta: { driverAdapterError: { cause: { kind: 'UniqueConstraintViolation', originalCode: '40001' } } } }, expected: 'P2010' },
  ];

  it.each(cases)('$name', ({ error, expected }) => {
    expect(classifySerializationFailure(error)).toBe(expected);
  });
});
