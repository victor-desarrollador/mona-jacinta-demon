// R3-A4.3 S4 — T-R and the recovery reads on a REAL PostgreSQL. OPT-IN ONLY;
// NOT authorized yet and NOT executed. What only PostgreSQL proves: the real
// sale lock serialising two terminals (P6), the reserveKey unique key under a
// genuine race (P7, P2002-real), F2/F3/F6 accepting the claim + seal written by
// T-R, and P25 (recent shows a CONFIRMED attempt of a COMPLETED sale).
//
// Requires an OWNER-authorized, DISPOSABLE, isolated LOCAL_TEST cluster with
// migrations 1–9 and the canonical baseline catalog (a Company and at least one
// ProductVariant), bound by marker + system id:
//   MONA_R3_S4_PG=1 MONA_R3_S4_PG_DISPOSABLE=1 MONA_TEST_DATABASE_TARGET=local
//   LOCAL_TEST_DATABASE_URL=… LOCAL_TEST_DATABASE_MARKER_ID=…
//   MONA_R3_PG_SYSTEM_ID=<pg_control_system().system_identifier of THAT cluster>
// Writes are COMMITTED and partly PERMANENT by design (F1 forbids deleting a
// CheckoutAttempt, F6 an ExternalCollection), hence the explicit DISPOSABLE
// acknowledgement: the cluster is discarded afterwards, never reused.
//
// OVERLAP IS PROVEN, NOT ASSUMED. Starting two promises proves nothing: each
// race case first takes the contended row lock on an independent COORDINATOR
// connection, starts both reservations on two other independent pools, and
// then asks PostgreSQL (pg_stat_activity + pg_blocking_pids) until BOTH
// reservation backends are waiting (wait_event_type 'Lock') on that row in the
// lock-wait chain rooted at the coordinator, running the expected statement.
// Only then is the coordinator released. This tells apart:
//   - a row-lock wait: a backend exists, wait_event_type = 'Lock', and it is in
//     the chain of the coordinator (the first waiter waits on the coordinator's
//     transaction, a later one on the first waiter's tuple lock);
//   - a pool wait: no backend at all is executing the statement (not counted);
//   - a unique-index wait: a backend blocked by ANOTHER reservation backend's
//     uncommitted insert, outside the coordinator chain and on an INSERT (not
//     counted as the precondition; the P2002 case relies on it AFTER release).
// Every wait is bounded and every coordinator is released in `finally`.
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../src/generated/prisma/client.js';
import { DEFAULT_ROLE_GRANTS } from '../../src/modules/rbac/role-permission-matrix.js';
import { computeProportionalQuote } from '../../src/modules/pricing/proportional-checkout.js';
import { attemptCollision, createCheckoutReservationService } from '../../src/modules/payments/checkout-reservation.service.js';
import { createCheckoutAttemptsRecentService } from '../../src/modules/payments/checkout-attempts-recent.service.js';
import type { PlanTenderInput } from '../../src/modules/payments/checkout-canonical.js';
import { AppError } from '../../src/shared/errors.js';

const enabled = process.env.MONA_R3_S4_PG === '1';
const WAIT_FOR_BLOCKED_MS = 10_000;
const RACE_TIMEOUT_MS = 45_000;

type Role = 'CASHIER' | 'OWNER';
const actor = (userId: string, role: Role, branchId: string) => ({
  auth: {
    userId, roles: [role], effectiveLocationIds: [branchId],
    assignments: [role === 'OWNER'
      ? { roleId: role, roleCode: role, scopeKind: 'COMPANY', locationId: null, permissions: [] }
      : { roleId: role, roleCode: role, scopeKind: 'LOCATION', locationId: branchId, permissions: [...DEFAULT_ROLE_GRANTS.CASHIER] }],
  },
}) as never;

const codeOf = async (promise: Promise<unknown>) => {
  try { await promise; return null; } catch (error) {
    if (error instanceof AppError) return error.code;
    throw error;
  }
};
const sleep = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); });
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

describe.skipIf(!enabled)('R3-A4.3 S4 — T-R on PostgreSQL (migrations 1–9, disposable cluster)', () => {
  // pools[0]: coordinator + observer + fixtures; pools[1] and pools[2]: the two
  // independent "terminals". Each pool is its own set of backends.
  const pools: Pool[] = [];
  const clients: PrismaClient[] = [];
  let db: PrismaClient;

  beforeAll(async () => {
    if (process.env.MONA_R3_S4_PG_DISPOSABLE !== '1') throw new Error('S4 PG tests write permanent rows: MONA_R3_S4_PG_DISPOSABLE=1 is required');
    if (process.env.MONA_TEST_DATABASE_TARGET !== 'local') throw new Error('LOCAL_TEST selector required');
    const expectedSystemId = process.env.MONA_R3_PG_SYSTEM_ID;
    if (!expectedSystemId || !/^[1-9][0-9]{15,20}$/.test(expectedSystemId)) throw new Error('isolated cluster binding is missing');
    const { openProvenLocalTestPool } = await import('../../scripts/demo-database.js');
    for (const max of [3, 2, 2]) {
      const { pool } = await openProvenLocalTestPool(max, process.env);
      pools.push(pool);
      clients.push(new PrismaClient({ adapter: new PrismaPg(pool, { schema: 'public' }), log: [] }));
    }
    const { rows } = await pools[0]!.query<{ system_id: string; ok: boolean }>(
      `SELECT system_identifier::text AS system_id, to_regclass('public."CheckoutAttempt"') IS NOT NULL AS ok FROM pg_control_system()`);
    if (rows[0]?.system_id !== expectedSystemId) throw new Error('isolated PostgreSQL cluster does not match binding');
    if (rows[0]?.ok !== true) throw new Error('migration 9 is required');
    db = clients[0]!;
  });
  afterAll(async () => {
    for (const client of clients) await client.$disconnect();
    for (const pool of pools) await pool.end();
  });

  // Holds `SELECT … FOR UPDATE` on one row of `table` in an open transaction on
  // its own connection until release().
  async function holdRowLock(table: 'Sale' | 'CashSession', id: string) {
    const client: PoolClient = await pools[0]!.connect();
    let released = false;
    try {
      await client.query('BEGIN');
      await client.query(`SELECT id FROM "${table}" WHERE id = $1 FOR UPDATE`, [id]);
      const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      return {
        pid: rows[0]!.pid,
        release: async () => {
          if (released) return;
          released = true;
          try { await client.query('ROLLBACK'); } finally { client.release(); }
        },
      };
    } catch (error) {
      released = true;
      client.release(true);
      throw error;
    }
  }

  // Polls until `count` backends are in the lock-wait chain rooted at `holderPid`
  // (directly, or behind another waiter of the chain), each with
  // wait_event_type 'Lock' and a statement matching `statement`.
  async function waitForBlocked(holderPid: number, count: number, statement: RegExp) {
    const deadline = Date.now() + WAIT_FOR_BLOCKED_MS;
    let last: unknown[] = [];
    while (Date.now() < deadline) {
      const { rows } = await pools[0]!.query<{ pid: number; blockers: number[]; wait_event_type: string | null; wait_event: string | null; query: string }>(
        `SELECT pid, pg_blocking_pids(pid) AS blockers, wait_event_type, wait_event, query
           FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()`);
      const chain = new Set<number>([holderPid]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const row of rows) {
          if (!chain.has(row.pid) && row.blockers.some((blocker) => chain.has(blocker))) { chain.add(row.pid); grew = true; }
        }
      }
      const waiting = rows.filter((row) => row.pid !== holderPid && chain.has(row.pid) && row.wait_event_type === 'Lock' && statement.test(row.query));
      last = waiting.map((row) => ({ pid: row.pid, wait_event: row.wait_event, blockers: row.blockers }));
      if (waiting.length >= count) return waiting;
      await sleep(25);
    }
    throw new Error(`expected ${count} backends waiting on the coordinator lock, saw ${JSON.stringify(last)}`);
  }

  async function fixture() {
    const company = await db.company.findFirstOrThrow({ orderBy: { createdAt: 'asc' }, select: { id: true } });
    const variant = await db.productVariant.findFirstOrThrow({ select: { id: true, productId: true, sku: true }, orderBy: { id: 'asc' } });
    const branch = randomUUID();
    const tag = branch.slice(0, 8);
    await db.location.create({ data: { id: branch, companyId: company.id, code: `r3s4-${tag}`, name: `R3 S4 ${tag}`, type: 'RETAIL_BRANCH', address: 'Test', pointOfSaleNumber: 3_000_000 + parseInt(tag.slice(0, 5), 16) } });
    await db.branch.create({ data: { id: branch, code: `r3s4-${tag}`, name: `R3 S4 ${tag}`, address: 'Test', pointOfSaleNumber: 1 } });
    const users = await Promise.all([1, 2].map((n) => db.user.create({ data: { name: `R3 S4 ${n}`, email: `r3s4-${tag}-${n}@test.invalid`, passwordHash: 'not-used' } })));
    const register = await db.cashRegister.create({ data: { branchId: branch, name: `R3 S4 ${tag}` } });
    const session = await db.cashSession.create({ data: { registerId: register.id, openedById: users[0]!.id, startingCash: 0n, status: 'OPEN' } });
    const sale = async () => {
      const created = await db.sale.create({ data: { branchId: branch, sellerId: users[0]!.id, status: 'PENDING_PAYMENT', pricingModel: 'PROPORTIONAL_V1', priceMode: 'CASH', pricingMode: 'LIST', subtotal: 10000n, total: 10000n } });
      const item = await db.saleItem.create({ data: { saleId: created.id, variantId: variant.id, productId: variant.productId, productName: 'R3 S4', variantName: 'R3 S4', sku: variant.sku,
        quantity: 1n, unitPrice: 10000n, subtotal: 10000n, priceBaseType: 'LIST', priceMode: 'CASH', baseUnitPrice: 10000n, priceAdjustmentBps: 0 } });
      await db.stockReservation.create({ data: { saleId: created.id, variantId: variant.id, branchId: branch, quantity: 1n, status: 'ACTIVE', expiresAt: new Date(Date.now() + 30 * 60_000) } });
      return { ...created, lines: [{ saleItemId: item.id, sku: item.sku, quantity: 1n, baseUnitPrice: 10000n }] };
    };
    return { branch, users, session, sale };
  }

  const pricingOf = async () => {
    const config = await db.companyPricingConfig.findFirst();
    return config ? { bankTransferAdjustmentBps: config.bankTransferAdjustmentBps, debitCardAdjustmentBps: config.debitCardAdjustmentBps } : null;
  };
  const cashRequest = async (sale: { lines: Array<{ saleItemId: string; sku: string; quantity: bigint; baseUnitPrice: bigint }> }, sessionId: string, tenders?: PlanTenderInput[], reserveKey = randomUUID()) => {
    const plan: PlanTenderInput[] = tenders ?? [{ method: 'CASH', role: 'BALANCE', source: 'NEW', amount: null, externalCollectionId: null }];
    const quote = computeProportionalQuote({ lines: sale.lines, pricing: await pricingOf(), balanceMethod: 'CASH',
      tenders: plan.filter((t) => t.role === 'FIXED').map((t) => ({ method: t.method, amount: t.amount! })) });
    return { reserveKey, cashSessionId: sessionId, balanceMethod: 'CASH' as const, expectedTotal: quote.total, expectedBalanceAmount: quote.balance.amount, tenders: plan, recovery: null };
  };

  // Captures every error a REAL checkoutAttempt.create raises, unchanged.
  function capturing(client: PrismaClient, captured: unknown[]): PrismaClient {
    return client.$extends({
      query: {
        checkoutAttempt: {
          async create({ args, query }) {
            try { return await query(args); } catch (error) { captured.push(error); throw error; }
          },
        },
      },
    }) as unknown as PrismaClient;
  }

  it('P6 two terminals, overlap proven on the Sale row lock: exactly one 201, the other CHECKOUT_RESERVATION_OPEN; one open attempt; one audit', async () => {
    const f = await fixture();
    const sale = await f.sale();
    const [a, b] = [
      createCheckoutReservationService(clients[1]!, { externalMethodsEnabled: true }),
      createCheckoutReservationService(clients[2]!, { externalMethodsEnabled: true }),
    ];
    const requests = [await cashRequest(sale, f.session.id), await cashRequest(sale, f.session.id)];
    const coordinator = await holdRowLock('Sale', sale.id);
    let race: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      race = Promise.allSettled([
        a.reserve(actor(f.users[0]!.id, 'CASHIER', f.branch), sale.id, requests[0]!),
        b.reserve(actor(f.users[1]!.id, 'CASHIER', f.branch), sale.id, requests[1]!),
      ]);
      await waitForBlocked(coordinator.pid, 2, /FROM "Sale" WHERE id = \$1 FOR UPDATE/);
    } finally {
      await coordinator.release();
    }
    const results = await withTimeout(race!, RACE_TIMEOUT_MS, 'P6 reservations');
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map((r) => (r.reason as AppError).code)).toEqual(['CHECKOUT_RESERVATION_OPEN']);
    expect(await db.checkoutAttempt.count({ where: { saleId: sale.id, declaredAt: null, status: { in: ['RESERVED', 'REJECTED'] } } })).toBe(1);
    expect(await db.auditLog.count({ where: { action: 'CHECKOUT_RESERVED', branchId: f.branch } })).toBe(1);
  });

  it('P7 the same reserveKey from two terminals, overlap proven on the Sale row lock: one row, the same operationKey in both answers, one audit', async () => {
    const f = await fixture();
    const sale = await f.sale();
    const request = await cashRequest(sale, f.session.id);
    const services = [
      createCheckoutReservationService(clients[1]!, { externalMethodsEnabled: true }),
      createCheckoutReservationService(clients[2]!, { externalMethodsEnabled: true }),
    ];
    const coordinator = await holdRowLock('Sale', sale.id);
    let race: Promise<Array<{ replayed: boolean; view: { operationKey: string } }>> | undefined;
    try {
      race = Promise.all(services.map((service) => service.reserve(actor(f.users[0]!.id, 'CASHIER', f.branch), sale.id, request)));
      await waitForBlocked(coordinator.pid, 2, /FROM "Sale" WHERE id = \$1 FOR UPDATE/);
    } finally {
      await coordinator.release();
    }
    const [first, second] = await withTimeout(race!, RACE_TIMEOUT_MS, 'P7 reservations');
    expect(first!.view.operationKey).toBe(second!.view.operationKey);
    expect([first!.replayed, second!.replayed].sort()).toEqual([false, true]);
    expect(await db.checkoutAttempt.count({ where: { reserveKey: request.reserveKey } })).toBe(1);
    expect(await db.auditLog.count({ where: { action: 'CHECKOUT_RESERVED', branchId: f.branch } })).toBe(1);
  });

  it('P7b REAL P2002: the same reserveKey on two DIFFERENT sales (no shared sale lock); Prisma metadata classified as reserveKey; authorised re-read → generic 409', async () => {
    const f = await fixture();
    const [saleA, saleB] = [await f.sale(), await f.sale()];
    const reserveKey = randomUUID();
    const captured: unknown[] = [];
    const services = [
      createCheckoutReservationService(capturing(clients[1]!, captured), { externalMethodsEnabled: true }),
      createCheckoutReservationService(capturing(clients[2]!, captured), { externalMethodsEnabled: true }),
    ];
    const requests = [await cashRequest(saleA, f.session.id, undefined, reserveKey), await cashRequest(saleB, f.session.id, undefined, reserveKey)];
    // Both pass their OWN sale lock and the reserveKey lookup (still absent),
    // then queue on the shared cash session row held by the coordinator.
    const coordinator = await holdRowLock('CashSession', f.session.id);
    let race: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      race = Promise.allSettled([
        services[0]!.reserve(actor(f.users[0]!.id, 'CASHIER', f.branch), saleA.id, requests[0]!),
        services[1]!.reserve(actor(f.users[0]!.id, 'CASHIER', f.branch), saleB.id, requests[1]!),
      ]);
      await waitForBlocked(coordinator.pid, 2, /FROM "CashSession" cs JOIN "CashRegister" r/);
    } finally {
      await coordinator.release();
    }
    const results = await withTimeout(race!, RACE_TIMEOUT_MS, 'P7b reservations');
    // Exactly one winner; the loser hit the unique key AFTER the winner committed.
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const losers = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(losers).toHaveLength(1);
    expect(losers[0]!.reason).toBeInstanceOf(AppError);
    expect(losers[0]!.reason).toMatchObject({ status: 409, code: 'RESERVE_KEY_REUSED_WITH_DIFFERENT_PLAN', details: undefined });
    // The collision was a real P2002 from PostgreSQL, classified by the service rule.
    expect(captured).toHaveLength(1);
    const real = captured[0] as { code?: string; meta?: { modelName?: string; target?: unknown } };
    expect(real.code, JSON.stringify(real.meta ?? null)).toBe('P2002');
    expect(real.meta?.modelName).toBe('CheckoutAttempt');
    expect(attemptCollision(real), `meta.target = ${JSON.stringify(real.meta?.target)}`).toBe('reserveKey');
    // One attempt for that key, on the winner's sale only; the loser's sale has none.
    const rows = await db.checkoutAttempt.findMany({ where: { reserveKey } });
    expect(rows).toHaveLength(1);
    const loserSale = rows[0]!.saleId === saleA.id ? saleB.id : saleA.id;
    expect(await db.checkoutAttempt.count({ where: { saleId: loserSale } })).toBe(0);
  });

  it('T-R through F2/F3/F6: a COLLECTION tender is claimed and sealed at COMMIT; another sale cannot claim it (EXTERNAL_COLLECTION_CLAIMED)', async () => {
    const f = await fixture();
    const sale = await f.sale();
    const ec = await db.externalCollection.create({ data: { branchId: f.branch, method: 'CARD_DEBIT', amount: 2000n, reference: `R3S4${sale.id.slice(0, 6)}`, referenceKey: `R3S4${sale.id.slice(0, 6).toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`,
      status: 'UNAPPLIED', originSaleId: sale.id, cashSessionId: f.session.id, recordedById: f.users[0]!.id } });
    const tenders: PlanTenderInput[] = [
      { method: 'CASH', role: 'BALANCE', source: 'NEW', amount: null, externalCollectionId: null },
      { method: 'CARD_DEBIT', role: 'FIXED', source: 'COLLECTION', amount: 2000n, externalCollectionId: ec.id },
    ];
    const service = createCheckoutReservationService(db, { externalMethodsEnabled: true });
    const { view } = await service.reserve(actor(f.users[0]!.id, 'CASHIER', f.branch), sale.id, await cashRequest(sale, f.session.id, tenders));
    const attempt = await db.checkoutAttempt.findUniqueOrThrow({ where: { reserveKey: view.reserveKey } });
    expect(attempt).toMatchObject({ planSealed: true, status: 'RESERVED', tenderCount: 2 });
    expect(await db.externalCollection.findUniqueOrThrow({ where: { id: ec.id } })).toMatchObject({ claimAttemptId: attempt.id, status: 'UNAPPLIED' });
    const other = await f.sale();
    expect(await codeOf(service.reserve(actor(f.users[0]!.id, 'CASHIER', f.branch), other.id, await cashRequest(other, f.session.id, tenders)))).toBe('EXTERNAL_COLLECTION_CLAIMED');
  });

  it('P25 recent: a CONFIRMED attempt of a COMPLETED sale is visible to its cashier (mine), not to a colleague (mine), to a supervisor (branch); another branch is 403', async () => {
    const f = await fixture();
    const sale = await f.sale();
    const { view } = await createCheckoutReservationService(db, { externalMethodsEnabled: true }).reserve(actor(f.users[0]!.id, 'CASHIER', f.branch), sale.id, await cashRequest(sale, f.session.id));
    // S4 fixture of a confirmation (T-C is S5): CONFIRMED attempt + its SaleCheckout + COMPLETED sale, one transaction.
    await db.$transaction(async (tx) => {
      const attempt = await tx.checkoutAttempt.update({ where: { reserveKey: view.reserveKey }, data: { status: 'CONFIRMED', confirmationHash: 'c'.repeat(64), confirmedById: f.users[0]!.id, confirmedAt: new Date() } });
      await tx.saleCheckout.create({ data: { saleId: sale.id, branchId: f.branch, pricingModel: 'PROPORTIONAL_V1', operationKey: attempt.operationKey, requestHash: 'c'.repeat(64), cashSessionId: f.session.id,
        userId: f.users[0]!.id, balanceMethod: 'CASH', referenceSubtotal: 10000n, total: attempt.expectedTotal, fullPriceCash: attempt.fullPriceCash, algorithmVersion: 1 } });
      await tx.sale.update({ where: { id: sale.id }, data: { status: 'COMPLETED' } });
    });
    const recent = createCheckoutAttemptsRecentService(db);
    const query = { branchId: f.branch, scope: 'mine' as const, limit: 20, since: null };
    const mine = await recent.recent(actor(f.users[0]!.id, 'CASHIER', f.branch), query);
    expect(mine.items.map((item) => [item.attempt.reserveKey, item.attempt.status, item.sale.status, item.confirmed !== null])).toEqual([[view.reserveKey, 'CONFIRMED', 'COMPLETED', true]]);
    expect((await recent.recent(actor(f.users[1]!.id, 'CASHIER', f.branch), query)).items).toEqual([]);
    expect((await recent.recent(actor(randomUUID(), 'OWNER', f.branch), { ...query, scope: 'branch' })).items).toHaveLength(1);
    expect(await codeOf(recent.recent(actor(f.users[0]!.id, 'CASHIER', randomUUID()), { ...query, branchId: f.branch }))).toBe('FORBIDDEN');
  });

  it.todo('visibility rule: a Serializable cancellation waiting on the sale lock gets 40001 and then sees the open attempt (S8, with the cancellation guard)');
});
