// Sale void v1 — RED contract on REAL PostgreSQL: races, lock order, atomic rollback, BigInt overflow.
//
// Standard destructive integration test (same harness as complete-sale.test.ts): createTestPrismaClient()
// proves the marker-proven test database (LOCAL_TEST in CI; hosted TEST is an OWNER-only gate), truncateAllTables
// + seedDemo give a known base, and every fixture is built through the REAL services (registerPayment,
// completeSale) so the sale/stock/cash rows are exactly what the production lifecycle leaves — nothing is
// hand-assembled that the code does not itself produce.
//
// WHY EACH TEST FAILS TODAY: src/modules/sales/sale-void.service.ts does not exist (the module is loaded
// lazily inside each test, so each test fails on its own with "sale-void service is not implemented"; the fixtures
// and the interleaving instruments run first and are proven by PG00).
//
// Race technique (from the CASH-1 proof): a client wrapper pauses the HOLDER's transaction right after it took a
// row lock; the WAITER is started; pg_blocking_pids proves the waiter is blocked on that very lock; only then the
// holder is released. No sleeps decide an outcome.
//
// Lock order pinned (see sale-void.behavior.test.ts SV53–SV56): Sale -> CashSession -> StockReservation ->
// Inventory. It is a strict prefix-compatible extension of payments (Sale -> CashSession), sale-finalization
// (Sale -> StockReservation -> Inventory), cancellation (Sale -> StockReservation -> Inventory) and the checkout
// (Sale -> CheckoutAttempt -> ExternalCollection -> CashSession -> StockReservation -> Inventory); the cash close
// takes only the CashSession. No cycle is possible.
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedDemo } from '../../prisma/seed.js';
import type { Prisma, PrismaClient } from '../../src/generated/prisma/client.js';
import { AppError } from '../../src/shared/errors.js';
import { createCashService } from '../../src/modules/cash/cash.service.js';
import { createPaymentsService } from '../../src/modules/payments/payments.service.js';
import { createSalesService } from '../../src/modules/sales/sales.service.js';
import { DEFAULT_ROLE_GRANTS } from '../../src/modules/rbac/role-permission-matrix.js';
import { createTestPrismaClient, truncateAllTables } from '../helpers/test-db.js';

type VoidInput = { reason: string; idempotencyKey: string; cashSessionId?: string; externalRefunds?: Array<{ salePaymentId: string; evidence: string }> };
type VoidResult = { voidId: string; replayed: boolean; status: string; previousStatus: string; cashRefund: null | { cashSessionId: string; total: bigint } };
type VoidService = { voidSale: (req: Request, saleId: string, input: VoidInput) => Promise<VoidResult> };

async function loadService(client: PrismaClient): Promise<VoidService> {
  let mod: { createSaleVoidService?: (database: PrismaClient) => VoidService };
  try {
    mod = (await import('../../src/modules/sales/sale-void.service.js')) as typeof mod;
  } catch {
    throw new Error('sale-void service is not implemented: src/modules/sales/sale-void.service.ts does not exist yet');
  }
  if (typeof mod.createSaleVoidService !== 'function') throw new Error('sale-void service is not implemented: createSaleVoidService is not exported');
  return mod.createSaleVoidService(client);
}

const REASON = 'Error de carga: producto equivocado';
const STARTING = 10_000n;
const UNIT = 15_000n;
const QTY = 2n;
const CHARGE = UNIT * QTY; // 30_000
const MAX_BIGINT = 9223372036854775807n;

// ---- interleaving instruments ---------------------------------------------------------------------------------------

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
type Gate = { arrived: ReturnType<typeof deferred<number>>; release: ReturnType<typeof deferred<void>> };
const gate = (): Gate => ({ arrived: deferred<number>(), release: deferred<void>() });
type Trace = { pids: number[]; isolation: string[]; started: ReturnType<typeof deferred<number>> };
const trace = (): Trace => ({ pids: [], isolation: [], started: deferred<number>() });
type TxOptions = { isolationLevel?: Prisma.TransactionIsolationLevel; timeout?: number };

// Records the backend PID (and isolation level) of every transaction; when `paused` is given, the FIRST attempt stops
// right after the row lock on `lockTable` was granted until the gate is released.
function instrument(base: PrismaClient, t: Trace, paused?: Gate, lockTable?: 'Sale' | 'CashSession') {
  const transaction = base.$transaction.bind(base) as <T>(callback: (tx: Prisma.TransactionClient) => Promise<T>, options?: TxOptions) => Promise<T>;
  return new Proxy(base, {
    get(target, property, receiver) {
      if (property !== '$transaction') return Reflect.get(target, property, receiver);
      return async <T>(callback: (tx: Prisma.TransactionClient) => Promise<T>, options?: TxOptions) =>
        transaction(async (tx) => {
          const pidRows = await tx.$queryRaw<{ pid: number; isolation: string }[]>`SELECT pg_backend_pid() AS pid, current_setting('transaction_isolation') AS isolation`;
          const pid = pidRows[0]?.pid;
          if (!pid) throw new Error('backend PID unavailable');
          t.pids.push(pid);
          t.isolation.push(pidRows[0]!.isolation);
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
    },
  }) as PrismaClient;
}

function failAtAudit(base: PrismaClient): PrismaClient {
  const transaction = base.$transaction.bind(base) as <T>(callback: (tx: Prisma.TransactionClient) => Promise<T>, options?: TxOptions) => Promise<T>;
  return new Proxy(base, {
    get(target, property, receiver) {
      if (property !== '$transaction') return Reflect.get(target, property, receiver);
      return <T>(callback: (tx: Prisma.TransactionClient) => Promise<T>, options?: TxOptions) =>
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

// Canonical inline acquisition (tests/test-cleanup.test.ts, form B): each client is released in the finally that
// immediately follows its acquisition. Callers get N independent connections (one per actor of a race).
async function acquire<T>(count: number, fn: (clients: PrismaClient[]) => Promise<T>, held: PrismaClient[]): Promise<T> {
  if (count === 0) return fn(held);
  const client = await createTestPrismaClient();
  try {
    return await acquire(count - 1, fn, [...held, client]);
  } finally {
    await client.$disconnect();
  }
}
function withClients<T>(count: 1, fn: (clients: [PrismaClient]) => Promise<T>): Promise<T>;
function withClients<T>(count: 2, fn: (clients: [PrismaClient, PrismaClient]) => Promise<T>): Promise<T>;
function withClients<T>(count: number, fn: (clients: never) => Promise<T>): Promise<T> {
  return acquire(count, fn as (clients: PrismaClient[]) => Promise<T>, []);
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

async function appError(promise: Promise<unknown>) {
  const error = await promise.then(() => null, (cause: unknown) => cause);
  expect(error, 'expected an AppError').toBeInstanceOf(AppError);
  return { status: (error as AppError).status, code: (error as AppError).code };
}

// ---- world --------------------------------------------------------------------------------------------------------------

describe('sale void v1 — PostgreSQL: lifecycle fixtures, races, rollback, overflow', () => {
  let db: PrismaClient;
  let branchId: string;
  let variantId: string;
  let productId: string;
  let inventoryId: string;
  let registerId: string;
  let ids: { seller: string; cashier: string; owner: string; admin: string };

  const ctxFor = (userId: string, assignment: Express.ProductionAssignment): Express.AuthContext => ({
    userId, roles: [assignment.roleCode], assignments: [assignment], effectiveLocationIds: assignment.locationId ? [assignment.locationId] : [],
  }) as Express.AuthContext;
  const reqOf = (ctx: Express.AuthContext) => ({ auth: ctx }) as unknown as Request;
  const cashierCtx = () => ctxFor(ids.cashier, { roleId: 'cashier', roleCode: 'CASHIER', scopeKind: 'LOCATION', locationId: branchId, permissions: [...DEFAULT_ROLE_GRANTS.CASHIER] });
  const ownerCtx = () => ctxFor(ids.owner, { roleId: 'owner', roleCode: 'OWNER', scopeKind: 'COMPANY', locationId: null, permissions: [] });
  const adminCtx = () => ctxFor(ids.admin, { roleId: 'admin', roleCode: 'ADMIN', scopeKind: 'COMPANY', locationId: null, permissions: [...DEFAULT_ROLE_GRANTS.ADMIN] });

  beforeAll(async () => {
    db = await createTestPrismaClient();
  }, 120000);

  beforeEach(async () => {
    await truncateAllTables(db);
    await seedDemo(db);
    const [seller, cashier, owner, admin, branch, variant] = await Promise.all([
      db.user.findUniqueOrThrow({ where: { email: 'seller01@demo.local' } }),
      db.user.findUniqueOrThrow({ where: { email: 'cashier01@demo.local' } }),
      db.user.findUniqueOrThrow({ where: { email: 'owner01@demo.local' } }),
      db.user.findUniqueOrThrow({ where: { email: 'admin@demo.local' } }),
      db.branch.findUniqueOrThrow({ where: { code: 'CEN' } }),
      db.productVariant.findUniqueOrThrow({ where: { sku: 'REM-NEG-M' } }),
    ]);
    ids = { seller: seller.id, cashier: cashier.id, owner: owner.id, admin: admin.id };
    branchId = branch.id;
    variantId = variant.id;
    productId = variant.productId;
    inventoryId = (await db.inventory.findUniqueOrThrow({ where: { variantId_branchId: { variantId, branchId } } })).id;
    await db.inventory.update({ where: { id: inventoryId }, data: { physical: 50n, reserved: 0n } });
    registerId = (await db.cashRegister.findFirstOrThrow({ where: { branchId }, orderBy: { id: 'asc' } })).id;
  }, 120000);

  afterAll(async () => {
    await db?.$disconnect();
  }, 120000);

  async function openSession(startingCash = STARTING) {
    const session = await db.cashSession.create({ data: { registerId, openedById: ids.cashier, startingCash, status: 'OPEN' } });
    await db.cashMovement.create({ data: { sessionId: session.id, type: 'OPENING', amount: startingCash, salePaymentId: null, userId: ids.cashier } });
    return session.id;
  }

  // The REAL lifecycle of the legacy FIXED_TOTAL path: PENDING_PAYMENT + ACTIVE hold + Inventory.reserved ->
  // registerPayment(CASH) = PAID (+ SALE_INCOME) -> completeSale = COMPLETED (physical consumed, SALE movement).
  async function makeCashSale(options: { client?: PrismaClient; complete: boolean; sessionId?: string }) {
    const sessionId = options.sessionId ?? (await openSession());
    const sale = await db.sale.create({ data: {
      sellerId: ids.seller, branchId, status: 'PENDING_PAYMENT', priceMode: 'CASH', pricingMode: 'LIST',
      subtotal: CHARGE, discountTotal: 0n, total: CHARGE,
    } });
    await db.saleItem.create({ data: {
      saleId: sale.id, variantId, productId, productName: 'Remera', variantName: 'Negro M', sku: 'REM-NEG-M',
      quantity: QTY, unitPrice: UNIT, subtotal: CHARGE,
    } });
    await db.inventory.update({ where: { id: inventoryId }, data: { reserved: { increment: QTY } } });
    await db.stockReservation.create({ data: {
      saleId: sale.id, variantId, branchId, quantity: QTY, expiresAt: new Date(Date.now() + 3_600_000), status: 'ACTIVE',
    } });
    const cashier = cashierCtx();
    const payments = createPaymentsService(options.client ?? db);
    const paid = await payments.registerPayment(reqOf(cashier), ids.cashier, sale.id, {
      method: 'CASH', amount: CHARGE, receivedAmount: CHARGE, idempotencyKey: randomUUID(),
    });
    expect(paid.resultingStatus).toBe('PAID');
    if (options.complete) {
      await createSalesService(options.client ?? db).completeSale(reqOf(cashier), ids.cashier, sale.id);
    }
    return { saleId: sale.id, sessionId, paymentId: paid.payment.id, cashier };
  }

  const state = async (saleId: string, sessionId: string) => ({
    sale: await db.sale.findUniqueOrThrow({ where: { id: saleId } }),
    inventory: await db.inventory.findUniqueOrThrow({ where: { id: inventoryId } }),
    reservations: await db.stockReservation.findMany({ where: { saleId }, orderBy: { id: 'asc' } }),
    stockMovements: await db.stockMovement.findMany({ where: { saleId }, orderBy: { id: 'asc' } }),
    cashMovements: await db.cashMovement.findMany({ where: { sessionId }, orderBy: { id: 'asc' } }),
    payments: await db.salePayment.findMany({ where: { saleId }, orderBy: { id: 'asc' } }),
    audits: await db.auditLog.findMany({ where: { OR: [{ entityId: saleId }, { action: 'SALE_VOIDED' }] }, orderBy: { id: 'asc' } }),
  });
  const voidRows = async (saleId: string) => (db as unknown as { saleVoid: { findMany: (args: object) => Promise<Array<Record<string, unknown>>> } }).saleVoid.findMany({ where: { saleId } });
  const req = (ctx: Express.AuthContext) => reqOf(ctx);
  const input = (extra: Partial<VoidInput> = {}): VoidInput => ({ reason: REASON, idempotencyKey: randomUUID(), ...extra });

  // ---- PG00: the fixtures and instruments themselves (pass today) -----------------------------------------------------------

  it('PG00 harness sanity (passes today): the real services leave the PAID and COMPLETED lifecycle the void contract assumes', async () => {
    await withClients(1, async ([c1]) => {
    const paid = await makeCashSale({ complete: false });
    let s = await state(paid.saleId, paid.sessionId);
    expect(s.sale.status).toBe('PAID');
    expect(s.inventory).toMatchObject({ physical: 50n, reserved: QTY }); // PAID: stock still HELD, physical not consumed
    expect(s.reservations.map((r) => r.status)).toEqual(['ACTIVE']);
    expect(s.stockMovements).toHaveLength(0);
    expect(s.cashMovements.map((m) => m.type).sort()).toEqual(['OPENING', 'SALE_INCOME']);

    await createSalesService(db).completeSale(reqOf(paid.cashier), ids.cashier, paid.saleId);
    s = await state(paid.saleId, paid.sessionId);
    expect(s.sale.status).toBe('COMPLETED');
    expect(s.inventory).toMatchObject({ physical: 50n - QTY, reserved: 0n }); // COMPLETED: physical consumed
    expect(s.reservations.map((r) => r.status)).toEqual(['CONSUMED']);
    expect(s.stockMovements.map((m) => [m.type, m.quantityDelta])).toEqual([['SALE', -QTY]]);

    // the instrument records pid and isolation, and the lock gate really holds a transaction
    const t = trace();
    const g = gate();
    const holder = instrument(c1, t, g, 'Sale');
    const paidAgain = await makeCashSale({ complete: false, sessionId: paid.sessionId });
    const completing = createSalesService(holder).completeSale(reqOf(paidAgain.cashier), ids.cashier, paidAgain.saleId);
    const holderPid = await requireSignal(g.arrived.promise, completing);
    expect(holderPid).toBe(t.pids[0]);
    expect(t.isolation[0]).toBe('serializable');
    g.release.resolve();
    await completing;
    });
  }, 120000);

  // ---- PG01-PG02: double void -----------------------------------------------------------------------------------------------

  it('PG01 two supervisors void the SAME sale at once with DIFFERENT keys: exactly one wins, the other gets SALE_ALREADY_VOIDED; stock and cash move once', async () => {
    await withClients(2, async ([c1, c2]) => {
    const sale = await makeCashSale({ complete: true });
    const [a, b] = [c1, c2];
    const settled = await Promise.allSettled([
      (await loadService(a)).voidSale(req(ownerCtx()), sale.saleId, input({ cashSessionId: sale.sessionId })),
      (await loadService(b)).voidSale(req(adminCtx()), sale.saleId, input({ cashSessionId: sale.sessionId })),
    ]);
    const fulfilled = settled.filter((r) => r.status === 'fulfilled');
    const rejected = settled.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatchObject({ status: 409, code: 'SALE_ALREADY_VOIDED' });
    const s = await state(sale.saleId, sale.sessionId);
    expect(await voidRows(sale.saleId)).toHaveLength(1);
    expect(s.sale.status).toBe('CANCELLED');
    expect(s.inventory).toMatchObject({ physical: 50n, reserved: 0n });
    expect(s.stockMovements.filter((m) => String(m.type) === 'SALE_VOID')).toHaveLength(1);
    expect(s.cashMovements.filter((m) => String(m.type) === 'SALE_REFUND')).toHaveLength(1);
    expect(s.audits.filter((row) => row.action === 'SALE_VOIDED')).toHaveLength(1);
    });
  }, 120000);

  it('PG02 the SAME key and payload sent twice at once: one creates, the other replays; one set of effects', async () => {
    await withClients(2, async ([c1, c2]) => {
    const sale = await makeCashSale({ complete: true });
    const [a, b] = [c1, c2];
    const request = input({ cashSessionId: sale.sessionId });
    const [first, second] = await Promise.all([
      (await loadService(a)).voidSale(req(ownerCtx()), sale.saleId, request),
      (await loadService(b)).voidSale(req(ownerCtx()), sale.saleId, request),
    ]);
    expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
    expect(first.voidId).toBe(second.voidId);
    const s = await state(sale.saleId, sale.sessionId);
    expect(await voidRows(sale.saleId)).toHaveLength(1);
    expect(s.cashMovements.filter((m) => String(m.type) === 'SALE_REFUND')).toHaveLength(1);
    expect(s.stockMovements.filter((m) => String(m.type) === 'SALE_VOID')).toHaveLength(1);
    expect(s.inventory.physical).toBe(50n);
    });
  }, 120000);

  // ---- PG03: void vs payment ------------------------------------------------------------------------------------------------

  it('PG03 void vs payment: a payment holding the Sale lock completes first; the void waits on that lock, then voids the now-PAID sale (income + refund, holds released)', async () => {
    await withClients(2, async ([c1, c2]) => {
    const sessionId = await openSession();
    const sale = await db.sale.create({ data: {
      sellerId: ids.seller, branchId, status: 'PENDING_PAYMENT', priceMode: 'CASH', pricingMode: 'LIST', subtotal: CHARGE, discountTotal: 0n, total: CHARGE,
    } });
    await db.saleItem.create({ data: { saleId: sale.id, variantId, productId, productName: 'Remera', variantName: 'Negro M', sku: 'REM-NEG-M', quantity: QTY, unitPrice: UNIT, subtotal: CHARGE } });
    await db.inventory.update({ where: { id: inventoryId }, data: { reserved: QTY } });
    await db.stockReservation.create({ data: { saleId: sale.id, variantId, branchId, quantity: QTY, expiresAt: new Date(Date.now() + 3_600_000), status: 'ACTIVE' } });

    const payGate = gate();
    const payTrace = trace();
    const voidTrace = trace();
    const pay = createPaymentsService(instrument(c1, payTrace, payGate, 'Sale'));
    const voiding = await loadService(instrument(c2, voidTrace));
    const payment = pay.registerPayment(reqOf(cashierCtx()), ids.cashier, sale.id, { method: 'CASH', amount: CHARGE, receivedAmount: CHARGE, idempotencyKey: randomUUID() });
    let voided: Promise<VoidResult> | undefined;
    try {
      const holderPid = await requireSignal(payGate.arrived.promise, payment);
      voided = voiding.voidSale(req(ownerCtx()), sale.id, input({ cashSessionId: sessionId }));
      const waiterPid = await requireSignal(voidTrace.started.promise, voided);
      expect(waiterPid).not.toBe(holderPid);
      await proveBlocked(db, waiterPid, holderPid, 'Sale');
    } finally {
      payGate.release.resolve();
      await Promise.allSettled([payment, voided]);
    }
    expect((await payment).resultingStatus).toBe('PAID');
    expect(await voided).toMatchObject({ status: 'CANCELLED', previousStatus: 'PAID', replayed: false });
    const s = await state(sale.id, sessionId);
    expect(s.sale.status).toBe('CANCELLED');
    expect(s.reservations.map((r) => r.status)).toEqual(['RELEASED']);
    expect(s.inventory).toMatchObject({ physical: 50n, reserved: 0n });
    expect(s.cashMovements.map((m) => m.type).sort()).toEqual(['OPENING', 'SALE_INCOME', 'SALE_REFUND']);
    expect(s.payments).toHaveLength(1);
    });
  }, 120000);

  // ---- PG04: void vs complete -----------------------------------------------------------------------------------------------

  it('PG04a void vs complete (complete first): the void waits on the Sale lock, then voids the COMPLETED sale and restores the physical stock once', async () => {
    await withClients(2, async ([c1, c2]) => {
    const sale = await makeCashSale({ complete: false });
    const completeGate = gate();
    const completeTrace = trace();
    const voidTrace = trace();
    const complete = createSalesService(instrument(c1, completeTrace, completeGate, 'Sale')).completeSale(reqOf(sale.cashier), ids.cashier, sale.saleId);
    const voiding = await loadService(instrument(c2, voidTrace));
    let voided: Promise<VoidResult> | undefined;
    try {
      const holderPid = await requireSignal(completeGate.arrived.promise, complete);
      voided = voiding.voidSale(req(ownerCtx()), sale.saleId, input({ cashSessionId: sale.sessionId }));
      const waiterPid = await requireSignal(voidTrace.started.promise, voided);
      await proveBlocked(db, waiterPid, holderPid, 'Sale');
    } finally {
      completeGate.release.resolve();
      await Promise.allSettled([complete, voided]);
    }
    await complete;
    expect(await voided).toMatchObject({ status: 'CANCELLED', previousStatus: 'COMPLETED' });
    const s = await state(sale.saleId, sale.sessionId);
    expect(s.inventory).toMatchObject({ physical: 50n, reserved: 0n }); // consumed by the completion, restored once by the void
    expect(s.stockMovements.map((m) => m.type).sort()).toEqual(['SALE', 'SALE_VOID']);
    expect(s.stockMovements.find((m) => String(m.type) === 'SALE')!.quantityDelta).toBe(-QTY);
    });
  }, 120000);

  it('PG04b void vs complete (void first): the completion waits, then finds a CANCELLED sale and fails; no stock is ever consumed', async () => {
    await withClients(2, async ([c1, c2]) => {
    const sale = await makeCashSale({ complete: false });
    const voidGate = gate();
    const voidTrace = trace();
    const completeTrace = trace();
    const voiding = await loadService(instrument(c1, voidTrace, voidGate, 'Sale'));
    const voided = voiding.voidSale(req(ownerCtx()), sale.saleId, input({ cashSessionId: sale.sessionId }));
    let completing: Promise<unknown> | undefined;
    try {
      const holderPid = await requireSignal(voidGate.arrived.promise, voided);
      completing = createSalesService(instrument(c2, completeTrace)).completeSale(reqOf(sale.cashier), ids.cashier, sale.saleId);
      const waiterPid = await requireSignal(completeTrace.started.promise, completing);
      await proveBlocked(db, waiterPid, holderPid, 'Sale');
    } finally {
      voidGate.release.resolve();
      await Promise.allSettled([voided, completing]);
    }
    expect(await voided).toMatchObject({ status: 'CANCELLED', previousStatus: 'PAID' });
    expect(await appError(completing!)).toEqual({ status: 409, code: 'INVALID_SALE_STATE' });
    const s = await state(sale.saleId, sale.sessionId);
    expect(s.inventory).toMatchObject({ physical: 50n, reserved: 0n });
    expect(s.stockMovements).toHaveLength(0);
    expect(s.reservations.map((r) => r.status)).toEqual(['RELEASED']);
    });
  }, 120000);

  // ---- PG05: void vs cash close ---------------------------------------------------------------------------------------------

  it('PG05a void vs cash close (close first): the void takes the Sale lock, waits on the CashSession lock, and once the session is CLOSED it is refused 409 CASH_SESSION_ALREADY_CLOSED with nothing written', async () => {
    await withClients(2, async ([c1, c2]) => {
    const sale = await makeCashSale({ complete: true });
    const closeGate = gate();
    const closeTrace = trace();
    const voidTrace = trace();
    const close = createCashService(instrument(c1, closeTrace, closeGate, 'CashSession')).closeSession(sale.sessionId, sale.cashier, STARTING + CHARGE);
    const voiding = await loadService(instrument(c2, voidTrace));
    let voided: Promise<VoidResult> | undefined;
    try {
      const holderPid = await requireSignal(closeGate.arrived.promise, close);
      voided = voiding.voidSale(req(ownerCtx()), sale.saleId, input({ cashSessionId: sale.sessionId }));
      const waiterPid = await requireSignal(voidTrace.started.promise, voided);
      await proveBlocked(db, waiterPid, holderPid, 'CashSession');
    } finally {
      closeGate.release.resolve();
      await Promise.allSettled([close, voided]);
    }
    expect(await close).toMatchObject({ status: 'CLOSED', expectedCash: STARTING + CHARGE, difference: 0n });
    expect(await appError(voided!)).toEqual({ status: 409, code: 'CASH_SESSION_ALREADY_CLOSED' });
    const s = await state(sale.saleId, sale.sessionId);
    expect(s.sale.status).toBe('COMPLETED');
    expect(await voidRows(sale.saleId)).toHaveLength(0);
    expect(s.cashMovements.filter((m) => String(m.type) === 'SALE_REFUND')).toHaveLength(0);
    expect(s.inventory).toMatchObject({ physical: 50n - QTY, reserved: 0n });
    });
  }, 120000);

  it('PG05b void vs cash close (void first): the close waits for the session lock and then reconciles WITH the refund — the drawer closes at the opening amount', async () => {
    await withClients(2, async ([c1, c2]) => {
    const sale = await makeCashSale({ complete: true });
    const voidGate = gate();
    const voidTrace = trace();
    const closeTrace = trace();
    const voiding = await loadService(instrument(c1, voidTrace, voidGate, 'CashSession'));
    const voided = voiding.voidSale(req(ownerCtx()), sale.saleId, input({ cashSessionId: sale.sessionId }));
    let closing: Promise<unknown> | undefined;
    try {
      const holderPid = await requireSignal(voidGate.arrived.promise, voided);
      closing = createCashService(instrument(c2, closeTrace)).closeSession(sale.sessionId, sale.cashier, STARTING);
      const waiterPid = await requireSignal(closeTrace.started.promise, closing);
      await proveBlocked(db, waiterPid, holderPid, 'CashSession');
    } finally {
      voidGate.release.resolve();
      await Promise.allSettled([voided, closing]);
    }
    expect(await voided).toMatchObject({ status: 'CANCELLED', cashRefund: { cashSessionId: sale.sessionId, total: CHARGE } });
    expect(await closing).toMatchObject({ status: 'CLOSED', expectedCash: STARTING, difference: 0n });
    const closed = await db.cashSession.findUniqueOrThrow({ where: { id: sale.sessionId } });
    expect(closed).toMatchObject({ status: 'CLOSED', expectedCash: STARTING, countedCash: STARTING, difference: 0n });
    });
  }, 120000);

  // ---- PG06-PG08: rollback, overflow, isolation -----------------------------------------------------------------------------

  it('PG06 an AuditLog failure rolls the whole void back on real PostgreSQL (sale, SaleVoid, stock, SALE_VOID and SALE_REFUND)', async () => {
    await withClients(1, async ([c1]) => {
    const sale = await makeCashSale({ complete: true });
    const before = await state(sale.saleId, sale.sessionId);
    const failing = failAtAudit(c1);
    await expect((await loadService(failing)).voidSale(req(ownerCtx()), sale.saleId, input({ cashSessionId: sale.sessionId }))).rejects.toThrow();
    expect(await state(sale.saleId, sale.sessionId)).toEqual(before);
    expect(await voidRows(sale.saleId)).toHaveLength(0);
    });
  }, 120000);

  it('PG07 BigInt overflow: a physical stock that cannot take the returned units fails closed as 409 SALE_VOID_STOCK_INCONSISTENT (never a raw 500) and writes nothing', async () => {
    await withClients(1, async ([c1]) => {
    const sale = await makeCashSale({ complete: true });
    await db.inventory.update({ where: { id: inventoryId }, data: { physical: MAX_BIGINT } });
    const before = await state(sale.saleId, sale.sessionId);
    expect(await appError((await loadService(c1)).voidSale(req(ownerCtx()), sale.saleId, input({ cashSessionId: sale.sessionId }))))
      .toEqual({ status: 409, code: 'SALE_VOID_STOCK_INCONSISTENT' });
    expect(await state(sale.saleId, sale.sessionId)).toEqual(before);
    expect(await voidRows(sale.saleId)).toHaveLength(0);
    });
  }, 120000);

  it('PG08 the void runs in a SERIALIZABLE transaction', async () => {
    await withClients(1, async ([c1]) => {
    const sale = await makeCashSale({ complete: true });
    const t = trace();
    await (await loadService(instrument(c1, t))).voidSale(req(ownerCtx()), sale.saleId, input({ cashSessionId: sale.sessionId }));
    expect(t.isolation).toEqual(['serializable']);
    });
  }, 120000);
});

// pg_blocking_pids is the only evidence: the waiter is blocked on a Lock held by the holder, in a query that names the table.
async function proveBlocked(observer: PrismaClient, waiterPid: number, holderPid: number, table: 'Sale' | 'CashSession') {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const rows = await observer.$queryRaw<Array<{ wait_event_type: string | null; query: string; blockers: number[] }>>`
      SELECT a.wait_event_type, a.query, pg_blocking_pids(a.pid) AS blockers
      FROM pg_stat_activity a WHERE a.pid = ${waiterPid} AND a.datname = current_database()`;
    const row = rows[0];
    if (row?.wait_event_type === 'Lock' && row.blockers.includes(holderPid)) {
      expect(row.query).toContain(`"${table}"`);
      expect(row.query).toContain('FOR UPDATE');
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`the ${table} lock relationship was not observed`);
}
