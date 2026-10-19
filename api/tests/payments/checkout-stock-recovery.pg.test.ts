// R3-A4.3 U2 — S7/T-S: the supervised stock recovery
// (POST /sales/:saleId/checkout/stock-recovery) on a REAL PostgreSQL. OPT-IN
// ONLY; NOT authorized and NOT executed by this slice. What only PostgreSQL
// proves: the ONE Serializable unit that rewrites Inventory, the row locks the
// service really takes (Sale → CheckoutAttempt → StockReservation → Inventory,
// never NOWAIT), the fragmented-coverage recovery consolidating several ACTIVE
// holds into one, the fail-closed no-overselling check (reserved is never pushed
// over physical) with a total rollback, the real serialization ordering of two
// overlapping recoveries, and a GENUINE 40001 transient that the retry loop
// re-runs from the Sale lock.
//
// Requires an OWNER-authorized, DISPOSABLE, isolated LOCAL_TEST cluster with
// migrations 1–9 and the canonical baseline catalog (an oldest Company and at
// least one ProductVariant), bound by marker + system id:
//   MONA_R3_S7_PG=1 MONA_R3_S7_PG_DISPOSABLE=1 MONA_TEST_DATABASE_TARGET=local
//   LOCAL_TEST_DATABASE_URL=… LOCAL_TEST_DATABASE_MARKER_ID=…
//   MONA_R3_PG_SYSTEM_ID=<pg_control_system().system_identifier of THAT cluster>
// Writes are COMMITTED and PERMANENT by design (F1 forbids deleting a
// CheckoutAttempt), hence the explicit DISPOSABLE acknowledgement: the cluster
// is discarded afterwards, never reused.
//
// OVERLAP IS PROVEN, NOT ASSUMED. The concurrency case first takes the Sale row
// lock on an independent COORDINATOR connection, starts the real recoveries on
// other independent pools, and then asks PostgreSQL (pg_stat_activity +
// pg_blocking_pids) until both backends are genuinely in the coordinator's
// lock-wait chain on the expected statement. Only then is the coordinator
// released, and every wait is bounded. The raw SQLSTATE is never asserted: only
// the domain result (changed / 409 / 500) matters, and whether a loser arrived
// by a fresh snapshot or by a 40001-then-retry is deliberately left to the
// engine.
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../src/generated/prisma/client.js';
import type { PlanTenderInput } from '../../src/modules/payments/checkout-canonical.js';
import { createCheckoutReservationService } from '../../src/modules/payments/checkout-reservation.service.js';
import { createCheckoutStockRecoveryService, inStockRecoveryTransaction } from '../../src/modules/payments/checkout-stock-recovery.service.js';
import { createPricingService } from '../../src/modules/pricing/pricing.service.js';
import { computeProportionalQuote } from '../../src/modules/pricing/proportional-checkout.js';
import {
  actor,
  errorOf,
  holdRowLock,
  ownerActor,
  PG_SYSTEM_ID,
  pointOfSaleNumberFor,
  RACE_TIMEOUT_MS,
  waitForBlocked,
  withTimeout,
} from '../helpers/r3-service-pg.js';

const enabled = process.env.MONA_R3_S7_PG === '1';

// One unit sold at 10000 centavos; a sale of `quantity` units totals the exact
// multiple, so the sealed CASH full price is deterministic.
const BASE = 10000n;
const REASON = 'recuperación de stock supervisada de la reserva';
const EVIDENCE = 'acta interna 7';

type Lines = Array<{ saleItemId: string; sku: string; quantity: bigint; baseUnitPrice: bigint }>;

describe.skipIf(!enabled)('R3-A4.3 S7 — T-S stock recovery on PostgreSQL (migrations 1–9, disposable cluster)', () => {
  const pools: Pool[] = [];
  const clients: PrismaClient[] = [];
  let db: PrismaClient;

  beforeAll(async () => {
    if (process.env.MONA_R3_S7_PG_DISPOSABLE !== '1') throw new Error('S7 PG tests write permanent rows: MONA_R3_S7_PG_DISPOSABLE=1 is required');
    if (process.env.MONA_TEST_DATABASE_TARGET !== 'local') throw new Error('LOCAL_TEST selector required');
    const expectedSystemId = process.env.MONA_R3_PG_SYSTEM_ID;
    if (!expectedSystemId || !PG_SYSTEM_ID.test(expectedSystemId)) {
      throw new Error('isolated cluster binding is missing: MONA_R3_PG_SYSTEM_ID must be the decimal pg_control_system().system_identifier of the target');
    }
    const { openProvenLocalTestPool } = await import('../../scripts/demo-database.js');
    // pools[0]: coordinator + observer + fixtures; pools[1]/pools[2]: racers.
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

  async function fixture() {
    const company = await db.company.findFirstOrThrow({ orderBy: { createdAt: 'asc' }, select: { id: true } });
    // A real pricing configuration for the oldest company, so T-R seals a whole
    // snapshot and PRICING_CONFIG_MISSING can never be an accidental baseline
    // absence.
    await db.companyPricingConfig.upsert({
      where: { companyId: company.id },
      create: { companyId: company.id, bankTransferAdjustmentBps: 200, debitCardAdjustmentBps: 300 },
      update: {},
    });
    const variant = await db.productVariant.findFirstOrThrow({ select: { id: true, productId: true, sku: true }, orderBy: { id: 'asc' } });
    const branch = randomUUID();
    const tag = branch.slice(0, 8);
    await db.location.create({ data: { id: branch, companyId: company.id, code: `s7pg-${tag}`, name: `S7 ${tag}`, type: 'RETAIL_BRANCH', address: 'Test', pointOfSaleNumber: pointOfSaleNumberFor('S7', tag) } });
    await db.branch.create({ data: { id: branch, code: `s7pg-${tag}`, name: `S7 ${tag}`, address: 'Test', pointOfSaleNumber: 1 } });
    const users = await Promise.all([0, 1].map((n) => db.user.create({ data: { name: `S7 ${n}`, email: `s7pg-${tag}-${n}@test.invalid`, passwordHash: 'not-used' } })));
    const register = await db.cashRegister.create({ data: { branchId: branch, name: `S7 ${tag}` } });
    const session = await db.cashSession.create({ data: { registerId: register.id, openedById: users[0]!.id, startingCash: 0n, status: 'OPEN' } });
    const inventory = (physical: bigint, reserved: bigint) => db.inventory.create({ data: { variantId: variant.id, branchId: branch, physical, reserved } });
    // The sale plus its ACTIVE technical hold, exactly covering the lines so T-R
    // (FIRST_PAYMENT coverage) accepts it.
    const sale = async (quantity = 1n) => {
      const created = await db.sale.create({ data: { branchId: branch, sellerId: users[0]!.id, status: 'PENDING_PAYMENT', pricingModel: 'PROPORTIONAL_V1', priceMode: 'CASH', pricingMode: 'LIST', subtotal: BASE * quantity, total: BASE * quantity } });
      const item = await db.saleItem.create({ data: { saleId: created.id, variantId: variant.id, productId: variant.productId, productName: 'S7', variantName: 'S7', sku: variant.sku,
        quantity, unitPrice: BASE, subtotal: BASE * quantity, priceBaseType: 'LIST', priceMode: 'CASH', baseUnitPrice: BASE, priceAdjustmentBps: 0 } });
      const hold = await db.stockReservation.create({ data: { saleId: created.id, variantId: variant.id, branchId: branch, quantity, status: 'ACTIVE', expiresAt: new Date(Date.now() + 30 * 60_000) } });
      return { ...created, hold, lines: [{ saleItemId: item.id, sku: item.sku, quantity, baseUnitPrice: BASE }] as Lines };
    };
    return { branch, users, session, variant, inventory, sale };
  }

  // The contractual pricing T-R reads (the oldest company's unique config).
  const pricingOf = async () => {
    const snapshot = await createPricingService(db).getSnapshot();
    if (snapshot.id === null) throw new Error('S7 fixture: the company pricing configuration is missing');
    return {
      bankTransferAdjustmentBps: snapshot.adjustmentsBps.BANK_TRANSFER!,
      debitCardAdjustmentBps: snapshot.adjustmentsBps.DEBIT_CARD!,
    };
  };

  // A CASH-only plan: the balance is the whole cash full price. T-S never looks
  // at the tender mix, only at the sealed full prices it re-derives.
  async function cashPlan(lines: Lines, sessionId: string, reserveKey = randomUUID()) {
    const quote = computeProportionalQuote({ lines, pricing: await pricingOf(), balanceMethod: 'CASH', tenders: [] });
    return {
      reserveKey, cashSessionId: sessionId, balanceMethod: 'CASH' as const,
      expectedTotal: quote.total, expectedBalanceAmount: quote.balance.amount,
      tenders: [{ method: 'CASH', role: 'BALANCE', source: 'NEW', amount: null, externalCollectionId: null }] as PlanTenderInput[],
      recovery: null,
    };
  }

  // Seals a real RESERVED attempt through T-R (the only flow that can legally
  // produce one), on the CASHIER actor's own authority.
  const reserve = (client: PrismaClient, userId: string, branchId: string, saleId: string, request: Awaited<ReturnType<typeof cashPlan>>) =>
    createCheckoutReservationService(client, { externalMethodsEnabled: true })
      .reserve(actor(userId, 'CASHIER', branchId) as never, saleId, request);

  const recoveryService = (client: PrismaClient) => createCheckoutStockRecoveryService(client);
  const request = (view: { reserveKey: string }) => ({ reserveKey: view.reserveKey, reason: REASON, evidence: EVIDENCE });

  it('P43 fragmented coverage is consolidated: two ACTIVE holds (1 + 1) for a 2-unit line become ONE ACTIVE hold of 2, reserved stays within physical, one audit', async () => {
    const f = await fixture();
    const sale = await f.sale(2n);
    await f.inventory(10n, 2n);
    const { view } = await reserve(db, f.users[0]!.id, f.branch, sale.id, await cashPlan(sale.lines, f.session.id));

    // Fragment THIS sale's coverage: the single 2-unit hold becomes two 1-unit
    // ACTIVE holds (the same total own reservation). Inventory.reserved is
    // untouched: it still counts exactly the sale's 2 units.
    await db.stockReservation.update({ where: { id: sale.hold.id }, data: { quantity: 1n } });
    await db.stockReservation.create({ data: { saleId: sale.id, variantId: f.variant.id, branchId: f.branch, quantity: 1n, status: 'ACTIVE', expiresAt: new Date(Date.now() + 30 * 60_000) } });
    const attempt = await db.checkoutAttempt.findUniqueOrThrow({ where: { reserveKey: view.reserveKey } });

    const result = await recoveryService(db).recover(ownerActor(f.users[1]!.id) as never, sale.id, request(view));
    expect(result.changed).toBe(true);
    expect(result.view).toMatchObject({ status: 'RESERVED', stockState: 'VALID' });

    // Exactly one ACTIVE hold remains, of the full required quantity; the two
    // fragmented rows are RELEASED (never deleted).
    const holds = await db.stockReservation.findMany({ where: { saleId: sale.id }, orderBy: { quantity: 'asc' } });
    expect(holds.map((hold) => [hold.status, hold.quantity])).toEqual([['RELEASED', 1n], ['RELEASED', 1n], ['ACTIVE', 2n]]);
    const inventory = await db.inventory.findFirstOrThrow({ where: { variantId: f.variant.id, branchId: f.branch } });
    expect(inventory).toMatchObject({ physical: 10n, reserved: 2n });
    expect(inventory.reserved <= inventory.physical).toBe(true);

    const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'CHECKOUT_STOCK_RECOVERED', entityId: attempt.id } });
    // AuditLog JSON is written through toJsonSafe: BigInt quantities are decimal strings.
    expect((audit.after as unknown as { created: Array<{ quantity: string }> }).created.map((row) => row.quantity)).toEqual(['2']);
    expect(await db.auditLog.count({ where: { action: 'CHECKOUT_STOCK_RECOVERED', entityId: attempt.id } })).toBe(1);
    // T-S writes nothing else: the attempt, tenders and the sale state are intact.
    expect(await db.salePayment.count({ where: { saleId: sale.id } })).toBe(0);
    expect((await db.checkoutAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).status).toBe('RESERVED');
    expect((await db.sale.findUniqueOrThrow({ where: { id: sale.id } })).status).toBe('PENDING_PAYMENT');
  });

  it('P44 no overselling: when recovery would push reserved over physical it is 409 INSUFFICIENT_STOCK {variantId} and NOTHING is written', async () => {
    const f = await fixture();
    const sale = await f.sale(2n);
    // Two units are reserved by ANOTHER sale; the sweeper already released THIS
    // sale's own hold, so own = 0. physical is 2: recovering this sale's 2 units
    // would make reserved 4 > physical 2 — an oversell. T-S must refuse.
    await f.inventory(2n, 2n);
    const { view } = await reserve(db, f.users[0]!.id, f.branch, sale.id, await cashPlan(sale.lines, f.session.id));
    await db.stockReservation.update({ where: { id: sale.hold.id }, data: { status: 'RELEASED' } });
    const attempt = await db.checkoutAttempt.findUniqueOrThrow({ where: { reserveKey: view.reserveKey } });
    const before = await db.inventory.findFirstOrThrow({ where: { variantId: f.variant.id, branchId: f.branch } });
    // T-R legitimately bumped Sale.updatedAt (visibility rule): the no-write
    // reference is the sale as it stands right before T-S.
    const saleBefore = await db.sale.findUniqueOrThrow({ where: { id: sale.id } });

    const refused = await errorOf(recoveryService(db).recover(ownerActor(f.users[1]!.id) as never, sale.id, request(view)));
    expect(refused).toMatchObject({ status: 409, code: 'INSUFFICIENT_STOCK' });
    expect(refused?.details).toMatchObject({ variantId: f.variant.id });

    // T-S never wrote: the released hold stays RELEASED, no new ACTIVE hold
    // appears, Inventory.reserved is unchanged (still <= physical), and no audit
    // or Sale bump happened.
    const holds = await db.stockReservation.findMany({ where: { saleId: sale.id } });
    expect(holds.map((hold) => [hold.status, hold.quantity])).toEqual([['RELEASED', 2n]]);
    const after = await db.inventory.findFirstOrThrow({ where: { variantId: f.variant.id, branchId: f.branch } });
    expect(after).toMatchObject({ physical: before.physical, reserved: before.reserved });
    expect(after.reserved <= after.physical).toBe(true);
    expect(await db.auditLog.count({ where: { action: 'CHECKOUT_STOCK_RECOVERED', entityId: attempt.id } })).toBe(0);
    expect((await db.sale.findUniqueOrThrow({ where: { id: sale.id } })).updatedAt.toISOString()).toBe(saleBefore.updatedAt.toISOString());
  });

  it('S7PG-02 two overlapping recoveries of one attempt serialise on the Sale lock: exactly one changes (true) while the other is a clean no-op (false), one new hold and one audit', async () => {
    const f = await fixture();
    const sale = await f.sale(2n);
    await f.inventory(10n, 2n);
    const { view } = await reserve(db, f.users[0]!.id, f.branch, sale.id, await cashPlan(sale.lines, f.session.id));
    // Make the coverage fragmented so the first recovery MUST write.
    await db.stockReservation.update({ where: { id: sale.hold.id }, data: { quantity: 1n } });
    await db.stockReservation.create({ data: { saleId: sale.id, variantId: f.variant.id, branchId: f.branch, quantity: 1n, status: 'ACTIVE', expiresAt: new Date(Date.now() + 30 * 60_000) } });
    const attempt = await db.checkoutAttempt.findUniqueOrThrow({ where: { reserveKey: view.reserveKey } });

    const services = [recoveryService(clients[1]!), recoveryService(clients[2]!)];
    const coordinator = await holdRowLock(pools[0]!, 'Sale', sale.id);
    let race: Promise<PromiseSettledResult<{ changed: boolean }>[]> | undefined;
    try {
      race = Promise.allSettled(services.map((service) => service.recover(ownerActor(f.users[1]!.id) as never, sale.id, request(view))));
      await waitForBlocked(pools[0]!, coordinator.pid, 2, /FROM "Sale" WHERE id = \$1 FOR UPDATE/);
    } finally {
      await coordinator.release();
    }
    const results = await withTimeout(race!, RACE_TIMEOUT_MS, 'S7PG-02 recoveries');
    expect(results.filter((result) => result.status === 'rejected')).toEqual([]);
    const changed = (results as PromiseFulfilledResult<{ changed: boolean }>[]).map((result) => result.value.changed).sort();
    expect(changed).toEqual([false, true]);

    // The second call wrote nothing: one ACTIVE hold, one audit, one bump.
    const holds = await db.stockReservation.findMany({ where: { saleId: sale.id, status: 'ACTIVE' } });
    expect(holds).toHaveLength(1);
    expect(holds[0]).toMatchObject({ quantity: 2n, variantId: f.variant.id });
    expect(await db.auditLog.count({ where: { action: 'CHECKOUT_STOCK_RECOVERED', entityId: attempt.id } })).toBe(1);
    const inventory = await db.inventory.findFirstOrThrow({ where: { variantId: f.variant.id, branchId: f.branch } });
    expect(inventory).toMatchObject({ physical: 10n, reserved: 2n });
  });

  it('S7PG-03 a REAL 40001 on the Inventory write is retried from the Sale lock in a new Serializable transaction and then succeeds', async () => {
    const f = await fixture();
    const inventory = await f.inventory(10n, 1n);
    let attempts = 0;

    // The coordinator takes the Inventory row lock FIRST, so the run cannot slip
    // its UPDATE in before the overlap exists.
    const coordinator = await holdRowLock(pools[0]!, 'Inventory', inventory.id);
    let run: Promise<{ attempt: number; reserved: bigint }> | undefined;
    try {
      // A plain read establishes the snapshot; the UPDATE then blocks on the
      // coordinator's row lock, so the overlap is real and observable.
      run = inStockRecoveryTransaction(db, async (tx) => {
        attempts += 1;
        await tx.$queryRaw`SELECT id, "reserved" FROM "Inventory" WHERE id = ${inventory.id}`;
        await tx.$executeRaw`UPDATE "Inventory" SET "reserved" = "reserved" + 1 WHERE id = ${inventory.id}`;
        const [row] = await tx.$queryRaw<Array<{ reserved: bigint }>>`SELECT "reserved" FROM "Inventory" WHERE id = ${inventory.id}`;
        return { attempt: attempts, reserved: row!.reserved };
      });
      await waitForBlocked(pools[0]!, coordinator.pid, 1, /UPDATE "Inventory"/);
      // Committing a change to a row the run read after its snapshot forces a
      // real serialization failure (40001) in the run, which the loop retries.
      await coordinator.commit(async (client) => {
        await client.query(`UPDATE "Inventory" SET "reserved" = "reserved" + 1 WHERE id = $1`, [inventory.id]);
      });
    } finally {
      await coordinator.release();
    }

    const result = await withTimeout(run!, RACE_TIMEOUT_MS, 'S7PG-03 retry');
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(result.attempt).toBe(attempts);
    // The coordinator's committed +1 and the retry's single +1 survive; the
    // aborted first attempt left nothing behind.
    const stored = await db.inventory.findUniqueOrThrow({ where: { id: inventory.id } });
    expect(stored.reserved).toBe(3n);
  });
});
