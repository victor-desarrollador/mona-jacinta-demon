// R3-A4.3 U2 — S7-I/T-RR: the supervised RECOVERY reservation
// (POST /sales/:saleId/checkout/reservations with a `recovery` body) on a REAL
// PostgreSQL. OPT-IN ONLY; NOT authorized and NOT executed by this slice. What
// only PostgreSQL proves: the full recovery chain on real rows — T-R seals an
// attempt, T-X abandons it and records a CHARGED collection, T-RR recovers the
// (partially released) stock in the SAME Serializable transaction that creates
// the new attempt and CLAIMS that collection, and T-C then settles the recovered
// attempt and APPLIES the collection — plus the refund/recovery exclusion in
// both interleavings (P39) and a real T-RR against T-RR overlap (P54).
//
// Requires an OWNER-authorized, DISPOSABLE, isolated LOCAL_TEST cluster with
// migrations 1–9 and the canonical baseline catalog (an oldest Company and at
// least one ProductVariant), bound by marker + system id:
//   MONA_R3_S7RR_PG=1 MONA_R3_S7RR_PG_DISPOSABLE=1 MONA_TEST_DATABASE_TARGET=local
//   LOCAL_TEST_DATABASE_URL=… LOCAL_TEST_DATABASE_MARKER_ID=…
//   MONA_R3_PG_SYSTEM_ID=<pg_control_system().system_identifier of THAT cluster>
// Writes are COMMITTED and PERMANENT by design (F1 forbids deleting a
// CheckoutAttempt, F6 an ExternalCollection), hence the explicit DISPOSABLE
// acknowledgement: the cluster is discarded afterwards, never reused.
//
// OVERLAP IS PROVEN, NOT ASSUMED (P54). The race first takes the Sale row lock
// on an independent COORDINATOR connection, starts the real recoveries on other
// independent pools, and then asks PostgreSQL (pg_stat_activity +
// pg_blocking_pids) until both backends are genuinely in the coordinator's
// lock-wait chain on the expected statement. Only then is the coordinator
// released, and every wait is bounded. The raw SQLSTATE is never asserted: the
// loser's DOMAIN code CHECKOUT_RESERVATION_OPEN is what matters, and whether it
// arrived by a fresh snapshot or a 40001-then-retry is left to the engine.
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../src/generated/prisma/client.js';
import { normalizeReferenceKey } from '../../src/modules/payments/checkout-canonical.js';
import type { PlanTenderInput } from '../../src/modules/payments/checkout-canonical.js';
import type { CheckoutConfirmationRequest, CheckoutConfirmationTender } from '../../src/modules/payments/dto/checkout.dto.js';
import type { CheckoutCloseRequest, CheckoutDeclarationRow } from '../../src/modules/payments/dto/checkout-close.dto.js';
import type { ExternalCollectionRefundRequest } from '../../src/modules/payments/dto/external-collection-refund.dto.js';
import { createCheckoutReservationService } from '../../src/modules/payments/checkout-reservation.service.js';
import { createCheckoutCloseService } from '../../src/modules/payments/checkout-close.service.js';
import { createCheckoutService } from '../../src/modules/payments/checkout.service.js';
import { createExternalCollectionsService } from '../../src/modules/payments/external-collections.service.js';
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

const enabled = process.env.MONA_R3_S7RR_PG === '1';

const BASE = 10000n;
// An arbitrary FIXED CARD_DEBIT tender; the engine derives the totals from it.
const CARD_FIXED = 3090n;
const RECOVERY = { reason: 'reconstrucción supervisada de la reserva de cobro', evidence: 'acta interna 9' };
const REFUND_REASON = 'devolución acordada con el cliente';

type Lines = Array<{ saleItemId: string; sku: string; quantity: bigint; baseUnitPrice: bigint }>;

describe.skipIf(!enabled)('R3-A4.3 S7-I — T-RR recovery reservation on PostgreSQL (migrations 1–9, disposable cluster)', () => {
  const pools: Pool[] = [];
  const clients: PrismaClient[] = [];
  let db: PrismaClient;

  beforeAll(async () => {
    if (process.env.MONA_R3_S7RR_PG_DISPOSABLE !== '1') throw new Error('S7-I PG tests write permanent rows: MONA_R3_S7RR_PG_DISPOSABLE=1 is required');
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
    await db.companyPricingConfig.upsert({
      where: { companyId: company.id },
      create: { companyId: company.id, bankTransferAdjustmentBps: 200, debitCardAdjustmentBps: 300 },
      update: {},
    });
    const variant = await db.productVariant.findFirstOrThrow({ select: { id: true, productId: true, sku: true }, orderBy: { id: 'asc' } });
    const branch = randomUUID();
    const tag = branch.slice(0, 8);
    await db.location.create({ data: { id: branch, companyId: company.id, code: `s7rr-${tag}`, name: `S7-I ${tag}`, type: 'RETAIL_BRANCH', address: 'Test', pointOfSaleNumber: pointOfSaleNumberFor('S7RR', tag) } });
    await db.branch.create({ data: { id: branch, code: `s7rr-${tag}`, name: `S7-I ${tag}`, address: 'Test', pointOfSaleNumber: 1 } });
    const users = await Promise.all([0, 1].map((n) => db.user.create({ data: { name: `S7-I ${n}`, email: `s7rr-${tag}-${n}@test.invalid`, passwordHash: 'not-used' } })));
    const register = await db.cashRegister.create({ data: { branchId: branch, name: `S7-I ${tag}` } });
    const session = await db.cashSession.create({ data: { registerId: register.id, openedById: users[0]!.id, startingCash: 0n, status: 'OPEN' } });
    const inventory = (physical: bigint, reserved: bigint) => db.inventory.create({ data: { variantId: variant.id, branchId: branch, physical, reserved } });
    const sale = async (quantity = 1n) => {
      const created = await db.sale.create({ data: { branchId: branch, sellerId: users[0]!.id, status: 'PENDING_PAYMENT', pricingModel: 'PROPORTIONAL_V1', priceMode: 'CASH', pricingMode: 'LIST', subtotal: BASE * quantity, total: BASE * quantity } });
      const item = await db.saleItem.create({ data: { saleId: created.id, variantId: variant.id, productId: variant.productId, productName: 'S7-I', variantName: 'S7-I', sku: variant.sku,
        quantity, unitPrice: BASE, subtotal: BASE * quantity, priceBaseType: 'LIST', priceMode: 'CASH', baseUnitPrice: BASE, priceAdjustmentBps: 0 } });
      const hold = await db.stockReservation.create({ data: { saleId: created.id, variantId: variant.id, branchId: branch, quantity, status: 'ACTIVE', expiresAt: new Date(Date.now() + 30 * 60_000) } });
      return { ...created, hold, lines: [{ saleItemId: item.id, sku: item.sku, quantity, baseUnitPrice: BASE }] as Lines };
    };
    let counter = 0;
    const collection = async (patch: { method?: 'CARD_DEBIT' | 'TRANSFER'; amount?: bigint; originSaleId: string }) => {
      counter += 1;
      const reference = `R3S7RREC${tag}${counter}`;
      return db.externalCollection.create({ data: {
        branchId: branch, method: patch.method ?? 'CARD_DEBIT', amount: patch.amount ?? CARD_FIXED,
        reference, referenceKey: normalizeReferenceKey(reference), status: 'UNAPPLIED', originSaleId: patch.originSaleId,
        cashSessionId: session.id, recordedById: users[0]!.id,
      } });
    };
    return { branch, users, session, variant, inventory, sale, collection };
  }

  const pricingOf = async () => {
    const snapshot = await createPricingService(db).getSnapshot();
    if (snapshot.id === null) throw new Error('S7-I fixture: the company pricing configuration is missing');
    return {
      bankTransferAdjustmentBps: snapshot.adjustmentsBps.BANK_TRANSFER!,
      debitCardAdjustmentBps: snapshot.adjustmentsBps.DEBIT_CARD!,
    };
  };

  async function debitNewPlan(lines: Lines, sessionId: string, amount: bigint, reserveKey = randomUUID()) {
    const tenders: PlanTenderInput[] = [
      { method: 'CASH', role: 'BALANCE', source: 'NEW', amount: null, externalCollectionId: null },
      { method: 'CARD_DEBIT', role: 'FIXED', source: 'NEW', amount, externalCollectionId: null },
    ];
    const quote = computeProportionalQuote({ lines, pricing: await pricingOf(), balanceMethod: 'CASH', tenders: [{ method: 'CARD_DEBIT', amount }] });
    return { reserveKey, cashSessionId: sessionId, balanceMethod: 'CASH' as const, expectedTotal: quote.total, expectedBalanceAmount: quote.balance.amount, tenders, recovery: null };
  }

  async function collectionPlan(lines: Lines, sessionId: string, collectionId: string, amount: bigint, reserveKey = randomUUID()) {
    const tenders: PlanTenderInput[] = [
      { method: 'CASH', role: 'BALANCE', source: 'NEW', amount: null, externalCollectionId: null },
      { method: 'CARD_DEBIT', role: 'FIXED', source: 'COLLECTION', amount, externalCollectionId: collectionId },
    ];
    const quote = computeProportionalQuote({ lines, pricing: await pricingOf(), balanceMethod: 'CASH', tenders: [{ method: 'CARD_DEBIT', amount }] });
    return { reserveKey, cashSessionId: sessionId, balanceMethod: 'CASH' as const, expectedTotal: quote.total, expectedBalanceAmount: quote.balance.amount, tenders, recovery: null };
  }

  const reserve = (client: PrismaClient, userId: string, branchId: string, saleId: string, request: Awaited<ReturnType<typeof debitNewPlan>>) =>
    createCheckoutReservationService(client, { externalMethodsEnabled: true })
      .reserve(actor(userId, 'CASHIER', branchId) as never, saleId, request);

  const recover = (client: PrismaClient, userId: string, saleId: string, request: Awaited<ReturnType<typeof collectionPlan>>) =>
    createCheckoutReservationService(client, { externalMethodsEnabled: true })
      .reserve(ownerActor(userId) as never, saleId, { ...request, recovery: RECOVERY });

  const closeService = (client: PrismaClient) => createCheckoutCloseService(client);
  const checkoutService = (client: PrismaClient) => createCheckoutService(client);

  const d = (method: 'CASH' | 'CARD_DEBIT', patch: Partial<CheckoutDeclarationRow> = {}): CheckoutDeclarationRow => ({
    method, outcome: 'NONE', returnedAmount: null, amount: null, reference: null, referenceKey: null,
    institution: null, institutionOther: null, evidence: null, ...patch,
  });
  const closeRequest = (declarations: CheckoutDeclarationRow[], supervisor: { reason: string; evidence: string } | null = null): CheckoutCloseRequest => ({ supervisor, declarations });

  const refundRequest = (patch: Partial<ExternalCollectionRefundRequest> = {}): ExternalCollectionRefundRequest => ({
    refundReference: `R3RRREF${randomUUID().slice(0, 8).toUpperCase().replace(/[^A-Z0-9]/g, '')}`,
    externalRefundedAt: new Date(Date.now() - 60_000), reason: REFUND_REASON, ...patch,
  });

  it('S7RPG-01 full recovery chain: T-R seals, T-X abandons and records a CHARGED collection, T-RR recovers the partial stock and claims it, T-C settles and APPLIES it', async () => {
    const f = await fixture();
    const sale = await f.sale(2n);
    await f.inventory(10n, 2n);

    // 1. T-R: a real sealed attempt with a CASH + NEW CARD_DEBIT plan.
    const { view: first } = await reserve(db, f.users[0]!.id, f.branch, sale.id, await debitNewPlan(sale.lines, f.session.id, CARD_FIXED));
    // 2. T-X: the initiator abandons it and declares the card tender CHARGED,
    //    which records an UNAPPLIED collection of the exact sealed amount.
    const reference = `R3S7RX${f.branch.slice(0, 6)}`;
    await closeService(db).close(
      actor(f.users[0]!.id, 'CASHIER', f.branch) as never, sale.id, first.reserveKey,
      closeRequest([d('CASH'), d('CARD_DEBIT', { outcome: 'CHARGED', amount: CARD_FIXED, reference, referenceKey: normalizeReferenceKey(reference), evidence: 'cupón 0001' })]),
    );
    const attempt1 = await db.checkoutAttempt.findUniqueOrThrow({ where: { reserveKey: first.reserveKey } });
    expect(attempt1.status).toBe('ABANDONED');
    const charged = await db.externalCollection.findFirstOrThrow({ where: { originAttemptId: attempt1.id } });
    expect(charged).toMatchObject({ method: 'CARD_DEBIT', amount: CARD_FIXED, status: 'UNAPPLIED', originSaleId: sale.id, claimAttemptId: null });

    // 3. The sale's stock coverage is now partial: its 2-unit hold was reduced
    //    to 1 and only 1 unit is reserved — T-RR must recover it.
    await db.stockReservation.update({ where: { id: sale.hold.id }, data: { quantity: 1n } });
    await db.inventory.updateMany({ where: { variantId: f.variant.id, branchId: f.branch }, data: { reserved: 1n } });

    // 4. T-RR: recover the stock AND claim the CHARGED collection in one unit.
    const recovered = await recover(db, f.users[1]!.id, sale.id, await collectionPlan(sale.lines, f.session.id, charged.id, CARD_FIXED));
    expect(recovered.replayed).toBe(false);
    expect(recovered.view).toMatchObject({ status: 'RESERVED', stockState: 'VALID', recovery: RECOVERY });
    const attempt2 = await db.checkoutAttempt.findUniqueOrThrow({ where: { reserveKey: recovered.view.reserveKey } });
    expect(await db.externalCollection.findUniqueOrThrow({ where: { id: charged.id } })).toMatchObject({ status: 'UNAPPLIED', claimAttemptId: attempt2.id });
    const holds = await db.stockReservation.findMany({ where: { saleId: sale.id }, orderBy: { quantity: 'asc' } });
    expect(holds.map((hold) => [hold.status, hold.quantity])).toEqual([['RELEASED', 1n], ['ACTIVE', 2n]]);
    expect(await db.inventory.findFirstOrThrow({ where: { variantId: f.variant.id, branchId: f.branch } })).toMatchObject({ physical: 10n, reserved: 2n });
    expect(await db.auditLog.count({ where: { action: 'CHECKOUT_STOCK_RECOVERED', entityId: attempt2.id } })).toBe(1);

    // 5. T-C: settle the recovered attempt with CASH + the claimed COLLECTION.
    const confirmation: CheckoutConfirmationRequest = {
      reserveKey: attempt2.reserveKey, operationKey: attempt2.operationKey,
      tenders: [
        { method: 'CASH', receivedAmount: recovered.view.plan.expectedBalanceAmount, reference: null, referenceKey: null, institution: null, institutionOther: null } as CheckoutConfirmationTender,
        { method: 'CARD_DEBIT', receivedAmount: null, reference: null, referenceKey: null, institution: null, institutionOther: null } as CheckoutConfirmationTender,
      ],
      supervisor: null,
    };
    const result = await checkoutService(db).checkout(ownerActor(f.users[1]!.id) as never, f.users[1]!.id, sale.id, confirmation);
    expect(result).toMatchObject({ status: 'COMPLETED', replayed: false, total: recovered.view.plan.expectedTotal });

    expect(await db.salePayment.count({ where: { saleId: sale.id } })).toBe(2);
    expect(await db.saleCheckout.count({ where: { saleId: sale.id } })).toBe(1);
    // The recovered collection is now APPLIED to this sale; its claim is kept
    // (T-C never clears it) and the checkout that applied it is the recovered one.
    expect(await db.externalCollection.findUniqueOrThrow({ where: { id: charged.id } }))
      .toMatchObject({ status: 'APPLIED', appliedSaleId: sale.id, claimAttemptId: attempt2.id });
    expect((await db.sale.findUniqueOrThrow({ where: { id: sale.id } })).status).toBe('COMPLETED');
    const inventory = await db.inventory.findFirstOrThrow({ where: { variantId: f.variant.id, branchId: f.branch } });
    expect(inventory).toMatchObject({ physical: 8n, reserved: 0n });
  });

  it('P39 refund/recovery exclusion: a collection refunded first is NOT_APPLICABLE to T-RR; a collection T-RR claimed first is CLAIMED against the refund', async () => {
    // (a) refund first, then recovery.
    const refunded = await fixture();
    const saleA = await refunded.sale();
    await refunded.inventory(10n, 1n);
    const ecA = await refunded.collection({ originSaleId: saleA.id });
    expect((await createExternalCollectionsService(db).refund(ownerActor(refunded.users[1]!.id) as never, ecA.id, refundRequest())).replayed).toBe(false);
    const planA = await collectionPlan(saleA.lines, refunded.session.id, ecA.id, CARD_FIXED);
    const refusedA = await errorOf(recover(db, refunded.users[1]!.id, saleA.id, planA));
    expect(refusedA).toMatchObject({ status: 409, code: 'EXTERNAL_COLLECTION_NOT_APPLICABLE' });
    expect(await db.checkoutAttempt.count({ where: { saleId: saleA.id } })).toBe(0);
    expect(await db.externalCollection.findUniqueOrThrow({ where: { id: ecA.id } })).toMatchObject({ status: 'REFUNDED', claimAttemptId: null });

    // (b) recovery claims first, then the refund is refused.
    const claimed = await fixture();
    const saleB = await claimed.sale();
    await claimed.inventory(10n, 1n);
    const ecB = await claimed.collection({ originSaleId: saleB.id });
    const recovered = await recover(db, claimed.users[1]!.id, saleB.id, await collectionPlan(saleB.lines, claimed.session.id, ecB.id, CARD_FIXED));
    const attempt = await db.checkoutAttempt.findUniqueOrThrow({ where: { reserveKey: recovered.view.reserveKey } });
    expect(await db.externalCollection.findUniqueOrThrow({ where: { id: ecB.id } })).toMatchObject({ status: 'UNAPPLIED', claimAttemptId: attempt.id });
    const refusedB = await errorOf(createExternalCollectionsService(db).refund(ownerActor(claimed.users[1]!.id) as never, ecB.id, refundRequest()));
    expect(refusedB).toMatchObject({ status: 409, code: 'EXTERNAL_COLLECTION_CLAIMED' });
    expect(await db.externalCollection.findUniqueOrThrow({ where: { id: ecB.id } })).toMatchObject({ status: 'UNAPPLIED', claimAttemptId: attempt.id });
  });

  it('P54 T-RR against a concurrent T-RR on one sale: the loser is 409 CHECKOUT_RESERVATION_OPEN and only one attempt claims the collection', async () => {
    const f = await fixture();
    const sale = await f.sale();
    await f.inventory(10n, 1n);
    const ec = await f.collection({ originSaleId: sale.id });
    const [planA, planB] = await Promise.all([
      collectionPlan(sale.lines, f.session.id, ec.id, CARD_FIXED),
      collectionPlan(sale.lines, f.session.id, ec.id, CARD_FIXED),
    ]);
    const services = [createCheckoutReservationService(clients[1]!, { externalMethodsEnabled: true }), createCheckoutReservationService(clients[2]!, { externalMethodsEnabled: true })];

    const coordinator = await holdRowLock(pools[0]!, 'Sale', sale.id);
    let race: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      race = Promise.allSettled([planA, planB].map((plan, index) => services[index]!.reserve(
        ownerActor(f.users[1]!.id) as never, sale.id, { ...plan, recovery: RECOVERY })));
      await waitForBlocked(pools[0]!, coordinator.pid, 2, /FROM "Sale" WHERE id = \$1 FOR UPDATE/);
    } finally {
      await coordinator.release();
    }
    const results = await withTimeout(race!, RACE_TIMEOUT_MS, 'P54 recoveries');
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const losers = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(losers).toHaveLength(1);
    expect(losers[0]!.reason).toMatchObject({ status: 409, code: 'CHECKOUT_RESERVATION_OPEN' });

    const attempts = await db.checkoutAttempt.findMany({ where: { saleId: sale.id } });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.status).toBe('RESERVED');
    expect(await db.externalCollection.findUniqueOrThrow({ where: { id: ec.id } })).toMatchObject({ status: 'UNAPPLIED', claimAttemptId: attempts[0]!.id });
    expect(await db.salePayment.count({ where: { saleId: sale.id } })).toBe(0);
  });
});
