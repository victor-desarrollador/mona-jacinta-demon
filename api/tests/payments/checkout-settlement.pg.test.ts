// R3-A4.3 U2 — S5/T-C: the ONE real settlement path
// (POST /sales/:saleId/checkout) on a REAL PostgreSQL. OPT-IN ONLY; NOT
// authorized and NOT executed by this slice. What only PostgreSQL proves: the
// real Serializable settlement end to end (payments, per-line allocations, the
// net cash movement, the shared PAID -> COMPLETED finalizer), the partial
// EXTERNAL reference indexes under a genuine cross-sale race, the persisted
// terminal REJECTED outcome plus its F2 replay with zero writes, and the F6
// origin immutability a service-level double can never see.
//
// Requires an OWNER-authorized, DISPOSABLE, isolated LOCAL_TEST cluster with
// migrations 1–9 and the canonical baseline catalog (an oldest Company and at
// least one ProductVariant), bound by marker + system id:
//   MONA_R3_S5_PG=1 MONA_R3_S5_PG_DISPOSABLE=1 MONA_TEST_DATABASE_TARGET=local
//   LOCAL_TEST_DATABASE_URL=… LOCAL_TEST_DATABASE_MARKER_ID=…
//   MONA_R3_PG_SYSTEM_ID=<pg_control_system().system_identifier of THAT cluster>
// Writes are COMMITTED and PERMANENT by design (F1 forbids deleting a
// CheckoutAttempt, F6 an ExternalCollection), hence the explicit DISPOSABLE
// acknowledgement: the cluster is discarded afterwards, never reused.
//
// OVERLAP IS PROVEN, NOT ASSUMED. Each race first takes the contended row lock
// on an independent COORDINATOR connection, starts the real service calls on
// other independent pools, and then asks PostgreSQL (pg_stat_activity +
// pg_blocking_pids) until the racing backends are genuinely in the coordinator's
// lock-wait chain on the expected statement. Only then is the coordinator
// released. Every wait is bounded; every coordinator is released in `finally`.
// The classification is never asserted on a raw SQLSTATE: the loser's DOMAIN
// code is what matters, and whether it arrived as a real P2002 or as a
// 40001-then-retry is deliberately left to the engine.
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../src/generated/prisma/client.js';
import { normalizeReferenceKey } from '../../src/modules/payments/checkout-canonical.js';
import type { CheckoutConfirmationRequest, CheckoutConfirmationTender } from '../../src/modules/payments/dto/checkout.dto.js';
import type { PlanTenderInput } from '../../src/modules/payments/checkout-canonical.js';
import { createCheckoutReservationService } from '../../src/modules/payments/checkout-reservation.service.js';
import { createCheckoutService, type CheckoutResult } from '../../src/modules/payments/checkout.service.js';
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

const enabled = process.env.MONA_R3_S5_PG === '1';

// The sold base: 10000 centavos, one line, one unit. CARD_DEBIT carries +300 bps
// (fixture configuration), so a fixed 3090 debits exactly 30% of the 10300 full
// price and leaves a 7000 whole-peso CASH balance (total 10090) — a proportional
// total that is deliberately NOT the flat cash price.
const BASE = 10000n;
const DEBIT_FIXED = 3090n;
const DEBIT_TOTAL = 10090n;
const DEBIT_BALANCE = 7000n;

type Lines = Array<{ saleItemId: string; sku: string; quantity: bigint; baseUnitPrice: bigint }>;

describe.skipIf(!enabled)('R3-A4.3 S5 — T-C settlement on PostgreSQL (migrations 1–9, disposable cluster)', () => {
  const pools: Pool[] = [];
  const clients: PrismaClient[] = [];
  let db: PrismaClient;

  beforeAll(async () => {
    if (process.env.MONA_R3_S5_PG_DISPOSABLE !== '1') throw new Error('S5 PG tests write permanent rows: MONA_R3_S5_PG_DISPOSABLE=1 is required');
    if (process.env.MONA_TEST_DATABASE_TARGET !== 'local') throw new Error('LOCAL_TEST selector required');
    const expectedSystemId = process.env.MONA_R3_PG_SYSTEM_ID;
    if (!expectedSystemId || !PG_SYSTEM_ID.test(expectedSystemId)) {
      throw new Error('isolated cluster binding is missing: MONA_R3_PG_SYSTEM_ID must be the decimal pg_control_system().system_identifier of the target');
    }
    const { openProvenLocalTestPool } = await import('../../scripts/demo-database.js');
    // pools[0]: coordinator + observer + fixtures; pools[1]/pools[2]: terminals.
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
    // Guarantee a real pricing configuration for the oldest company (the same one
    // `createPricingService().getSnapshot()` and T-R read), so PRICING_CONFIG_MISSING
    // can never be an accidental baseline absence.
    await db.companyPricingConfig.upsert({
      where: { companyId: company.id },
      create: { companyId: company.id, bankTransferAdjustmentBps: 200, debitCardAdjustmentBps: 300 },
      update: {},
    });
    const variant = await db.productVariant.findFirstOrThrow({ select: { id: true, productId: true, sku: true }, orderBy: { id: 'asc' } });
    const branch = randomUUID();
    const tag = branch.slice(0, 8);
    await db.location.create({ data: { id: branch, companyId: company.id, code: `s5pg-${tag}`, name: `S5 ${tag}`, type: 'RETAIL_BRANCH', address: 'Test', pointOfSaleNumber: pointOfSaleNumberFor('S5', tag) } });
    await db.branch.create({ data: { id: branch, code: `s5pg-${tag}`, name: `S5 ${tag}`, address: 'Test', pointOfSaleNumber: 1 } });
    const users = await Promise.all([0, 1].map((n) => db.user.create({ data: { name: `S5 ${n}`, email: `s5pg-${tag}-${n}@test.invalid`, passwordHash: 'not-used' } })));
    const register = await db.cashRegister.create({ data: { branchId: branch, name: `S5 ${tag}` } });
    const session = await db.cashSession.create({ data: { registerId: register.id, openedById: users[0]!.id, startingCash: 0n, status: 'OPEN' } });
    const inventory = (physical: bigint, reserved: bigint) => db.inventory.create({ data: { variantId: variant.id, branchId: branch, physical, reserved } });
    const sale = async (quantity = 1n) => {
      const created = await db.sale.create({ data: { branchId: branch, sellerId: users[0]!.id, status: 'PENDING_PAYMENT', pricingModel: 'PROPORTIONAL_V1', priceMode: 'CASH', pricingMode: 'LIST', subtotal: BASE * quantity, total: BASE * quantity } });
      const item = await db.saleItem.create({ data: { saleId: created.id, variantId: variant.id, productId: variant.productId, productName: 'S5', variantName: 'S5', sku: variant.sku,
        quantity, unitPrice: BASE, subtotal: BASE * quantity, priceBaseType: 'LIST', priceMode: 'CASH', baseUnitPrice: BASE, priceAdjustmentBps: 0 } });
      await db.stockReservation.create({ data: { saleId: created.id, variantId: variant.id, branchId: branch, quantity, status: 'ACTIVE', expiresAt: new Date(Date.now() + 30 * 60_000) } });
      return { ...created, lines: [{ saleItemId: item.id, sku: item.sku, quantity, baseUnitPrice: BASE }] as Lines };
    };
    return { branch, users, session, variant, inventory, sale };
  }

  // The contractual pricing the reservation service reads (the oldest company's
  // unique configuration). A null snapshot is a fixture defect: fail loudly
  // instead of quoting with "no pricing".
  const pricingOf = async () => {
    const snapshot = await createPricingService(db).getSnapshot();
    if (snapshot.id === null) throw new Error('S5 fixture: the company pricing configuration is missing');
    return {
      bankTransferAdjustmentBps: snapshot.adjustmentsBps.BANK_TRANSFER!,
      debitCardAdjustmentBps: snapshot.adjustmentsBps.DEBIT_CARD!,
    };
  };

  async function cashPlan(lines: Lines, sessionId: string, reserveKey = randomUUID()) {
    const quote = computeProportionalQuote({ lines, pricing: await pricingOf(), balanceMethod: 'CASH', tenders: [] });
    return {
      reserveKey, cashSessionId: sessionId, balanceMethod: 'CASH' as const,
      expectedTotal: quote.total, expectedBalanceAmount: quote.balance.amount,
      tenders: [{ method: 'CASH', role: 'BALANCE', source: 'NEW', amount: null, externalCollectionId: null }] as PlanTenderInput[],
      recovery: null,
    };
  }

  async function debitPlan(lines: Lines, sessionId: string, amount: bigint, reserveKey = randomUUID()) {
    const tenders: PlanTenderInput[] = [
      { method: 'CASH', role: 'BALANCE', source: 'NEW', amount: null, externalCollectionId: null },
      { method: 'CARD_DEBIT', role: 'FIXED', source: 'NEW', amount, externalCollectionId: null },
    ];
    const quote = computeProportionalQuote({ lines, pricing: await pricingOf(), balanceMethod: 'CASH', tenders: [{ method: 'CARD_DEBIT', amount }] });
    return {
      reserveKey, cashSessionId: sessionId, balanceMethod: 'CASH' as const,
      expectedTotal: quote.total, expectedBalanceAmount: quote.balance.amount, tenders, recovery: null,
    };
  }

  const reserve = (client: PrismaClient, userId: string, branchId: string, saleId: string, request: Awaited<ReturnType<typeof cashPlan>>) =>
    createCheckoutReservationService(client, { externalMethodsEnabled: true })
      .reserve(actor(userId, 'CASHIER', branchId) as never, saleId, request);

  const checkoutService = (client: PrismaClient) => createCheckoutService(client);

  const cashConfirmation = (view: { reserveKey: string; operationKey: string }, receivedAmount: bigint): CheckoutConfirmationRequest => ({
    reserveKey: view.reserveKey, operationKey: view.operationKey,
    tenders: [{ method: 'CASH', receivedAmount, reference: null, referenceKey: null, institution: null, institutionOther: null } as CheckoutConfirmationTender],
    supervisor: null,
  });

  const debitConfirmation = (
    view: { reserveKey: string; operationKey: string },
    receivedAmount: bigint | null,
    reference: string | null,
  ): CheckoutConfirmationRequest => ({
    reserveKey: view.reserveKey, operationKey: view.operationKey,
    tenders: [
      { method: 'CASH', receivedAmount, reference: null, referenceKey: null, institution: null, institutionOther: null } as CheckoutConfirmationTender,
      { method: 'CARD_DEBIT', receivedAmount: null, reference, referenceKey: reference === null ? null : normalizeReferenceKey(reference), institution: null, institutionOther: null } as CheckoutConfirmationTender,
    ],
    supervisor: null,
  });

  it('S5PG-01 CASH-only settlement: COMPLETED with one payment, one allocation, one SALE_INCOME movement, holds consumed and stock deducted', async () => {
    const f = await fixture();
    const sale = await f.sale();
    await f.inventory(10n, 1n);
    const { view } = await reserve(db, f.users[0]!.id, f.branch, sale.id, await cashPlan(sale.lines, f.session.id));

    const result = await checkoutService(db).checkout(
      actor(f.users[0]!.id, 'CASHIER', f.branch) as never, f.users[0]!.id, sale.id, cashConfirmation(view, BASE));
    expect(result).toMatchObject({ saleId: sale.id, status: 'COMPLETED', replayed: false, total: BASE, changeAmount: 0n });
    expect(await db.sale.findUniqueOrThrow({ where: { id: sale.id } })).toMatchObject({ status: 'COMPLETED', total: BASE });

    const payments = await db.salePayment.findMany({ where: { saleId: sale.id } });
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ method: 'CASH', tenderRole: 'BALANCE', amount: BASE, receivedAmount: BASE, changeAmount: 0n, pricingModel: 'PROPORTIONAL_V1' });
    expect(await db.saleLineAllocation.count({ where: { saleId: sale.id } })).toBe(1);
    expect(await db.cashMovement.count({ where: { sessionId: f.session.id, salePaymentId: payments[0]!.id, type: 'SALE_INCOME' } })).toBe(1);

    const inventory = await db.inventory.findFirstOrThrow({ where: { variantId: f.variant.id, branchId: f.branch } });
    expect(inventory).toMatchObject({ physical: 9n, reserved: 0n });
    expect(await db.stockReservation.count({ where: { saleId: sale.id, status: 'ACTIVE' } })).toBe(0);
    expect(await db.stockReservation.count({ where: { saleId: sale.id, status: 'CONSUMED' } })).toBe(1);
    expect(await db.auditLog.count({ where: { action: 'SALE_COMPLETED', entityId: sale.id } })).toBe(1);
    expect(await db.auditLog.count({ where: { action: 'PAYMENT_REGISTERED', entityId: payments[0]!.id } })).toBe(1);
  });

  it('S5PG-02 mixed CASH+CARD_DEBIT settled by an OWNER supervisor: proportional total, one APPLIED new collection, change, supervisor evidence recorded', async () => {
    const f = await fixture();
    const sale = await f.sale();
    await f.inventory(10n, 1n);
    const plan = await debitPlan(sale.lines, f.session.id, DEBIT_FIXED);
    expect(plan.expectedTotal).toBe(DEBIT_TOTAL);
    expect(plan.expectedBalanceAmount).toBe(DEBIT_BALANCE);
    // The attempt is opened by the CASHIER; a DIFFERENT actor (the OWNER) then
    // confirms it through the supervisor path with a justification.
    const { view } = await reserve(db, f.users[0]!.id, f.branch, sale.id, plan);

    const reference = `R3S5MIX${f.branch.slice(0, 6)}`;
    const key = normalizeReferenceKey(reference);
    const request: CheckoutConfirmationRequest = {
      ...debitConfirmation(view, BASE, reference),
      supervisor: { reason: 'cobro asistido por el encargado de turno', evidence: 'autorizacion verbal registrada' },
    };
    const result = await checkoutService(db).checkout(ownerActor(f.users[1]!.id) as never, f.users[1]!.id, sale.id, request);
    expect(result).toMatchObject({ status: 'COMPLETED', replayed: false, total: DEBIT_TOTAL, changeAmount: BASE - DEBIT_BALANCE });

    // PostgreSQL orders the PaymentMethod enum by declaration, not by name: sort by name here.
    const payments = (await db.salePayment.findMany({ where: { saleId: sale.id } }))
      .sort((a, b) => (a.method < b.method ? -1 : a.method > b.method ? 1 : 0));
    expect(payments.map((payment) => [payment.method, payment.amount, payment.tenderRole, payment.adjustmentBps]))
      .toEqual([['CARD_DEBIT', DEBIT_FIXED, 'FIXED', 300], ['CASH', DEBIT_BALANCE, 'BALANCE', 0]]);
    expect(await db.saleLineAllocation.count({ where: { saleId: sale.id } })).toBe(2);

    const collections = await db.externalCollection.findMany({ where: { branchId: f.branch, method: 'CARD_DEBIT' } });
    expect(collections).toHaveLength(1);
    expect(collections[0]).toMatchObject({ amount: DEBIT_FIXED, reference, referenceKey: key, institution: null, status: 'APPLIED', originSaleId: sale.id, appliedSaleId: sale.id, claimAttemptId: null });
    expect(await db.cashMovement.count({ where: { sessionId: f.session.id, type: 'SALE_INCOME' } })).toBe(1);

    const attempt = await db.checkoutAttempt.findUniqueOrThrow({ where: { reserveKey: view.reserveKey } });
    expect(attempt).toMatchObject({ status: 'CONFIRMED', confirmedById: f.users[1]!.id, confirmReason: request.supervisor!.reason, confirmEvidence: request.supervisor!.evidence });
    // The settlement audit is about the SaleCheckout (as in S5PG-03), not the attempt.
    const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'SALE_CHECKOUT_COMPLETED', entityType: 'SaleCheckout', entityId: result.checkoutId } });
    expect((audit.after as { supervisor: { byId: string } | null }).supervisor?.byId).toBe(f.users[1]!.id);
    const inventory = await db.inventory.findFirstOrThrow({ where: { variantId: f.variant.id, branchId: f.branch } });
    expect(inventory).toMatchObject({ physical: 9n, reserved: 0n });
  });

  it('S5PG-03 two overlapping confirmations of the same attempt: exactly one real settlement, the other replays; one payment, one checkout, one cash movement', async () => {
    const f = await fixture();
    const sale = await f.sale();
    await f.inventory(10n, 1n);
    const { view } = await reserve(db, f.users[0]!.id, f.branch, sale.id, await cashPlan(sale.lines, f.session.id));
    const services = [checkoutService(clients[1]!), checkoutService(clients[2]!)];

    const coordinator = await holdRowLock(pools[0]!, 'Sale', sale.id);
    let race: Promise<PromiseSettledResult<CheckoutResult>[]> | undefined;
    try {
      race = Promise.allSettled(services.map((service) => service.checkout(
        actor(f.users[0]!.id, 'CASHIER', f.branch) as never, f.users[0]!.id, sale.id, cashConfirmation(view, BASE))));
      await waitForBlocked(pools[0]!, coordinator.pid, 2, /FROM "Sale" WHERE id = \$1 FOR UPDATE/);
    } finally {
      await coordinator.release();
    }
    const results = await withTimeout(race!, RACE_TIMEOUT_MS, 'S5PG-03 confirmations');
    expect(results.filter((result) => result.status === 'rejected')).toEqual([]);
    const settled = results as PromiseFulfilledResult<CheckoutResult>[];
    expect(settled.map((result) => result.value.replayed).sort()).toEqual([false, true]);
    expect(settled.every((result) => result.value.saleId === sale.id && result.value.checkoutId === settled[0]!.value.checkoutId)).toBe(true);

    // The duplicate-payment invariant: a second settlement would double every row.
    expect(await db.salePayment.count({ where: { saleId: sale.id } })).toBe(1);
    expect(await db.saleLineAllocation.count({ where: { saleId: sale.id } })).toBe(1);
    expect(await db.saleCheckout.count({ where: { saleId: sale.id } })).toBe(1);
    expect(await db.cashMovement.count({ where: { sessionId: f.session.id, type: 'SALE_INCOME' } })).toBe(1);
    expect(await db.auditLog.count({ where: { action: 'SALE_CHECKOUT_COMPLETED', entityId: settled[0]!.value.checkoutId } })).toBe(1);
    const inventory = await db.inventory.findFirstOrThrow({ where: { variantId: f.variant.id, branchId: f.branch } });
    expect(inventory).toMatchObject({ physical: 9n, reserved: 0n });
    expect((await db.sale.findUniqueOrThrow({ where: { id: sale.id } })).status).toBe('COMPLETED');
  });

  it('S5PG-04 reference race across two sales on one branch/session: one settlement, the loser 409 EXTERNAL_REFERENCE_ALREADY_RECORDED, one collection row', async () => {
    const f = await fixture();
    const [saleA, saleB] = [await f.sale(), await f.sale()];
    await f.inventory(10n, 1n);
    const [planA, planB] = [await debitPlan(saleA.lines, f.session.id, DEBIT_FIXED), await debitPlan(saleB.lines, f.session.id, DEBIT_FIXED)];
    const [attemptA, attemptB] = await Promise.all([
      reserve(db, f.users[0]!.id, f.branch, saleA.id, planA),
      reserve(db, f.users[0]!.id, f.branch, saleB.id, planB),
    ]);
    const reference = `R3S5DUP${f.branch.slice(0, 6)}`;
    const requests = [attemptA.view, attemptB.view].map((view) => debitConfirmation(view, BASE, reference));
    const services = [checkoutService(clients[1]!), checkoutService(clients[2]!)];

    // Both sales pass their OWN sale lock and the step-5 reference pre-check (the
    // reference is still absent), then queue on the shared cash session row.
    const coordinator = await holdRowLock(pools[0]!, 'CashSession', f.session.id);
    let race: Promise<PromiseSettledResult<CheckoutResult>[]> | undefined;
    try {
      race = Promise.allSettled([
        services[0]!.checkout(actor(f.users[0]!.id, 'CASHIER', f.branch) as never, f.users[0]!.id, saleA.id, requests[0]!),
        services[1]!.checkout(actor(f.users[0]!.id, 'CASHIER', f.branch) as never, f.users[0]!.id, saleB.id, requests[1]!),
      ]);
      await waitForBlocked(pools[0]!, coordinator.pid, 2, /FROM "CashSession" cs/);
    } finally {
      await coordinator.release();
    }
    const results = await withTimeout(race!, RACE_TIMEOUT_MS, 'S5PG-04 confirmations');
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const losers = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(losers).toHaveLength(1);
    expect(losers[0]!.reason).toMatchObject({ status: 409, code: 'EXTERNAL_REFERENCE_ALREADY_RECORDED' });

    // The partial indexes (branchId, referenceKey) hold under a real race: one row,
    // and only the winner's sale settled.
    const collections = await db.externalCollection.findMany({ where: { branchId: f.branch, method: 'CARD_DEBIT', referenceKey: normalizeReferenceKey(reference) } });
    expect(collections).toHaveLength(1);
    expect(collections[0]).toMatchObject({ status: 'APPLIED' });
    expect(await db.sale.count({ where: { id: { in: [saleA.id, saleB.id] }, status: 'COMPLETED' } })).toBe(1);
    const loserSaleId = collections[0]!.appliedSaleId === saleA.id ? saleB.id : saleA.id;
    expect(await db.salePayment.count({ where: { saleId: loserSaleId } })).toBe(0);
    expect(await db.saleCheckout.count({ where: { saleId: loserSaleId } })).toBe(0);
    expect((await db.sale.findUniqueOrThrow({ where: { id: loserSaleId } })).status).toBe('PENDING_PAYMENT');
  });

  it('S5PG-05 terminal INSUFFICIENT_PHYSICAL: the attempt is COMMITTED REJECTED with no charge, and the same key replays the rejection with zero writes', async () => {
    const f = await fixture();
    const sale = await f.sale();
    // T-R locks no Inventory (D5): a hold may exist while the physical stock does not.
    await f.inventory(0n, 1n);
    const { view } = await reserve(db, f.users[0]!.id, f.branch, sale.id, await cashPlan(sale.lines, f.session.id));
    const request = cashConfirmation(view, BASE);

    const rejected = await errorOf(checkoutService(db).checkout(actor(f.users[0]!.id, 'CASHIER', f.branch) as never, f.users[0]!.id, sale.id, request));
    expect(rejected).toMatchObject({ status: 409, code: 'INSUFFICIENT_PHYSICAL' });
    expect(rejected?.details).toMatchObject({ variantId: f.variant.id });

    const attempt = await db.checkoutAttempt.findUniqueOrThrow({ where: { reserveKey: view.reserveKey } });
    expect(attempt).toMatchObject({ status: 'REJECTED', rejectionCode: 'INSUFFICIENT_PHYSICAL', declaredAt: null });
    expect(await db.salePayment.count({ where: { saleId: sale.id } })).toBe(0);
    expect(await db.saleCheckout.count({ where: { saleId: sale.id } })).toBe(0);
    expect(await db.cashMovement.count({ where: { sessionId: f.session.id } })).toBe(0);
    expect((await db.sale.findUniqueOrThrow({ where: { id: sale.id } })).status).toBe('PENDING_PAYMENT');
    expect(await db.auditLog.count({ where: { action: 'CHECKOUT_RESERVATION_REJECTED', entityId: attempt.id } })).toBe(1);

    // F2: the persisted rejection is idempotent — same reserveKey, same
    // operationKey, the same 409, and not one more row.
    const replay = await errorOf(checkoutService(db).checkout(actor(f.users[0]!.id, 'CASHIER', f.branch) as never, f.users[0]!.id, sale.id, request));
    expect(replay).toMatchObject({ status: 409, code: 'INSUFFICIENT_PHYSICAL' });
    expect(await db.auditLog.count({ where: { action: 'CHECKOUT_RESERVATION_REJECTED', entityId: attempt.id } })).toBe(1);
    expect(await db.salePayment.count({ where: { saleId: sale.id } })).toBe(0);
    expect((await db.checkoutAttempt.findUniqueOrThrow({ where: { reserveKey: view.reserveKey } })).status).toBe('REJECTED');
  });

  it('S5PG-06 SECURITY-R3: F6 refuses an originSaleId mutation, and T-R refuses to claim another sale\'s collection', async () => {
    const f = await fixture();
    const [saleA, saleB] = [await f.sale(), await f.sale()];
    await f.inventory(10n, 2n);
    const reference = `R3S5XS${f.branch.slice(0, 6)}`;
    const ec = await db.externalCollection.create({
      data: {
        branchId: f.branch, method: 'CARD_DEBIT', amount: DEBIT_FIXED, reference, referenceKey: normalizeReferenceKey(reference),
        status: 'UNAPPLIED', originSaleId: saleA.id, cashSessionId: f.session.id, recordedById: f.users[0]!.id,
      },
    });

    // (a) The DATABASE, not the service, refuses moving the origin of a recorded
    // collection — the last line of defense against moving money between sales.
    const failure = await pools[0]!.query(`UPDATE "ExternalCollection" SET "originSaleId" = $2 WHERE "id" = $1`, [ec.id, saleB.id])
      .then(() => null, (cause: unknown) => cause as { code?: string; message?: string });
    expect(failure?.code).toBe('23514');
    expect(failure?.message).toContain('ExternalCollection financial and origin data are immutable');
    expect((await db.externalCollection.findUniqueOrThrow({ where: { id: ec.id } })).originSaleId).toBe(saleA.id);

    // (b) A sale can never claim a collection another sale originated, whatever the
    // method and amount match.
    const collectionTenders: PlanTenderInput[] = [
      { method: 'CASH', role: 'BALANCE', source: 'NEW', amount: null, externalCollectionId: null },
      { method: 'CARD_DEBIT', role: 'FIXED', source: 'COLLECTION', amount: ec.amount, externalCollectionId: ec.id },
    ];
    const quote = computeProportionalQuote({ lines: saleB.lines, pricing: await pricingOf(), balanceMethod: 'CASH', tenders: [{ method: 'CARD_DEBIT', amount: ec.amount }] });
    const refused = await errorOf(createCheckoutReservationService(db, { externalMethodsEnabled: true }).reserve(
      actor(f.users[0]!.id, 'CASHIER', f.branch) as never, saleB.id,
      { reserveKey: randomUUID(), cashSessionId: f.session.id, balanceMethod: 'CASH', expectedTotal: quote.total, expectedBalanceAmount: quote.balance.amount, tenders: collectionTenders, recovery: null },
    ));
    expect(refused).toMatchObject({ status: 409, code: 'EXTERNAL_COLLECTION_NOT_APPLICABLE' });
    expect((await db.externalCollection.findUniqueOrThrow({ where: { id: ec.id } })).claimAttemptId).toBeNull();
    expect(await db.checkoutAttempt.count({ where: { saleId: saleB.id } })).toBe(0);
  });
});
