// R3-A4.3 U2 — S6/T-X: the close/declaration of a durable charge reservation
// (POST /sales/:saleId/checkout/reservations/:reserveKey/close) on a REAL
// PostgreSQL. OPT-IN ONLY; NOT authorized and NOT executed by this slice. What
// only PostgreSQL proves: the F4/F6 triggers accepting the DOCUMENT 4 write
// order (declarations -> declaredAt -> claim release), the ABANDONED attempt
// carrying its declaration, the CHARGED ExternalCollection the declaration
// creates, the F2 idempotent replay writing nothing, and the ONE real
// contention signal of T-X — `Sale FOR UPDATE NOWAIT` raising 55P03, mapped to
// 409 CHECKOUT_RESERVATION_BUSY — both against a plain holder and against a
// REAL concurrent T-C (P55).
//
// Requires an OWNER-authorized, DISPOSABLE, isolated LOCAL_TEST cluster with
// migrations 1–9 and the canonical baseline catalog (an oldest Company and at
// least one ProductVariant), bound by marker + system id:
//   MONA_R3_S6_PG=1 MONA_R3_S6_PG_DISPOSABLE=1 MONA_TEST_DATABASE_TARGET=local
//   LOCAL_TEST_DATABASE_URL=… LOCAL_TEST_DATABASE_MARKER_ID=…
//   MONA_R3_PG_SYSTEM_ID=<pg_control_system().system_identifier of THAT cluster>
// Writes are COMMITTED and PERMANENT by design (F1 forbids deleting a
// CheckoutAttempt, F6 an ExternalCollection), hence the explicit DISPOSABLE
// acknowledgement: the cluster is discarded afterwards, never reused.
//
// OVERLAP IS PROVEN, NOT ASSUMED. Every race first takes the contended row lock
// on an independent COORDINATOR connection, starts the real service calls on
// other independent pools, and then asks PostgreSQL (pg_stat_activity +
// pg_blocking_pids) until the racing backend is genuinely in the coordinator's
// lock-wait chain on the expected statement. Only then is the coordinator
// released. The raw SQLSTATE is never asserted: T-X's DOMAIN code
// CHECKOUT_RESERVATION_BUSY is what matters, and the point of the case is that
// a veritable PostgreSQL 55P03 produced it.
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../src/generated/prisma/client.js';
import { normalizeReferenceKey } from '../../src/modules/payments/checkout-canonical.js';
import type { PlanTenderInput } from '../../src/modules/payments/checkout-canonical.js';
import type { CheckoutConfirmationRequest, CheckoutConfirmationTender } from '../../src/modules/payments/dto/checkout.dto.js';
import type { CheckoutCloseRequest, CheckoutDeclarationRow } from '../../src/modules/payments/dto/checkout-close.dto.js';
import { createCheckoutReservationService } from '../../src/modules/payments/checkout-reservation.service.js';
import { createCheckoutCloseService } from '../../src/modules/payments/checkout-close.service.js';
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

const enabled = process.env.MONA_R3_S6_PG === '1';

const BASE = 10000n;
// A FIXED CARD_DEBIT tender of 3090 centavos: the amount the sealed plan fixes
// and the amount a CHARGED declaration must reproduce exactly.
const DEBIT_FIXED = 3090n;

type Lines = Array<{ saleItemId: string; sku: string; quantity: bigint; baseUnitPrice: bigint }>;

describe.skipIf(!enabled)('R3-A4.3 S6 — T-X close on PostgreSQL (migrations 1–9, disposable cluster)', () => {
  const pools: Pool[] = [];
  const clients: PrismaClient[] = [];
  let db: PrismaClient;

  beforeAll(async () => {
    if (process.env.MONA_R3_S6_PG_DISPOSABLE !== '1') throw new Error('S6 PG tests write permanent rows: MONA_R3_S6_PG_DISPOSABLE=1 is required');
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
    await db.companyPricingConfig.upsert({
      where: { companyId: company.id },
      create: { companyId: company.id, bankTransferAdjustmentBps: 200, debitCardAdjustmentBps: 300 },
      update: {},
    });
    const variant = await db.productVariant.findFirstOrThrow({ select: { id: true, productId: true, sku: true }, orderBy: { id: 'asc' } });
    const branch = randomUUID();
    const tag = branch.slice(0, 8);
    await db.location.create({ data: { id: branch, companyId: company.id, code: `s6pg-${tag}`, name: `S6 ${tag}`, type: 'RETAIL_BRANCH', address: 'Test', pointOfSaleNumber: pointOfSaleNumberFor('S6', tag) } });
    await db.branch.create({ data: { id: branch, code: `s6pg-${tag}`, name: `S6 ${tag}`, address: 'Test', pointOfSaleNumber: 1 } });
    const users = await Promise.all([0, 1].map((n) => db.user.create({ data: { name: `S6 ${n}`, email: `s6pg-${tag}-${n}@test.invalid`, passwordHash: 'not-used' } })));
    const register = await db.cashRegister.create({ data: { branchId: branch, name: `S6 ${tag}` } });
    const session = await db.cashSession.create({ data: { registerId: register.id, openedById: users[0]!.id, startingCash: 0n, status: 'OPEN' } });
    const inventory = (physical: bigint, reserved: bigint) => db.inventory.create({ data: { variantId: variant.id, branchId: branch, physical, reserved } });
    const sale = async (quantity = 1n) => {
      const created = await db.sale.create({ data: { branchId: branch, sellerId: users[0]!.id, status: 'PENDING_PAYMENT', pricingModel: 'PROPORTIONAL_V1', priceMode: 'CASH', pricingMode: 'LIST', subtotal: BASE * quantity, total: BASE * quantity } });
      const item = await db.saleItem.create({ data: { saleId: created.id, variantId: variant.id, productId: variant.productId, productName: 'S6', variantName: 'S6', sku: variant.sku,
        quantity, unitPrice: BASE, subtotal: BASE * quantity, priceBaseType: 'LIST', priceMode: 'CASH', baseUnitPrice: BASE, priceAdjustmentBps: 0 } });
      await db.stockReservation.create({ data: { saleId: created.id, variantId: variant.id, branchId: branch, quantity, status: 'ACTIVE', expiresAt: new Date(Date.now() + 30 * 60_000) } });
      return { ...created, lines: [{ saleItemId: item.id, sku: item.sku, quantity, baseUnitPrice: BASE }] as Lines };
    };
    let counter = 0;
    const collection = async (patch: { method?: 'TRANSFER' | 'CARD_DEBIT'; amount?: bigint; originSaleId: string }) => {
      counter += 1;
      const reference = `R3S6EC${tag}${counter}`;
      return db.externalCollection.create({ data: {
        branchId: branch, method: patch.method ?? 'CARD_DEBIT', amount: patch.amount ?? DEBIT_FIXED,
        reference, referenceKey: normalizeReferenceKey(reference), status: 'UNAPPLIED', originSaleId: patch.originSaleId,
        cashSessionId: session.id, recordedById: users[0]!.id,
      } });
    };
    return { branch, users, session, variant, inventory, sale, collection };
  }

  const pricingOf = async () => {
    const snapshot = await createPricingService(db).getSnapshot();
    if (snapshot.id === null) throw new Error('S6 fixture: the company pricing configuration is missing');
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

  async function transferPlan(lines: Lines, sessionId: string, amount: bigint, reserveKey = randomUUID()) {
    const tenders: PlanTenderInput[] = [
      { method: 'CASH', role: 'BALANCE', source: 'NEW', amount: null, externalCollectionId: null },
      { method: 'TRANSFER', role: 'FIXED', source: 'NEW', amount, externalCollectionId: null },
    ];
    const quote = computeProportionalQuote({ lines, pricing: await pricingOf(), balanceMethod: 'CASH', tenders: [{ method: 'TRANSFER', amount }] });
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

  const reserve = (client: PrismaClient, userId: string, branchId: string, saleId: string, request: Awaited<ReturnType<typeof cashPlan>>) =>
    createCheckoutReservationService(client, { externalMethodsEnabled: true }).reserve(actor(userId, 'CASHIER', branchId) as never, saleId, request);

  const closeService = (client: PrismaClient) => createCheckoutCloseService(client);
  const checkoutService = (client: PrismaClient) => createCheckoutService(client);

  const d = (method: 'CASH' | 'TRANSFER' | 'CARD_DEBIT', patch: Partial<CheckoutDeclarationRow> = {}): CheckoutDeclarationRow => ({
    method, outcome: 'NONE', returnedAmount: null, amount: null, reference: null, referenceKey: null,
    institution: null, institutionOther: null, evidence: null, ...patch,
  });
  const closeRequest = (declarations: CheckoutDeclarationRow[], supervisor: { reason: string; evidence: string } | null = null): CheckoutCloseRequest => ({ supervisor, declarations });
  const JUSTIFICATION = { reason: 'declaración supervisada del cierre de la reserva', evidence: 'cupón fílmico 12' };

  it('S6PG-01 initiator close of a RESERVED attempt (CASH NONE + NEW TRANSFER CHARGED): ABANDONED + declared, ONE UNAPPLIED collection, no cash/stock write; identical replay writes nothing', async () => {
    const f = await fixture();
    const sale = await f.sale();
    await f.inventory(10n, 1n);
    const { view } = await reserve(db, f.users[0]!.id, f.branch, sale.id, await transferPlan(sale.lines, f.session.id, DEBIT_FIXED));

    const reference = `R3S6CHG${f.branch.slice(0, 6)}`;
    const result = await closeService(db).close(
      actor(f.users[0]!.id, 'CASHIER', f.branch) as never, sale.id, view.reserveKey,
      closeRequest([d('CASH'), d('TRANSFER', { outcome: 'CHARGED', amount: DEBIT_FIXED, reference, referenceKey: normalizeReferenceKey(reference), institution: 'GALICIA', evidence: 'comprobante 0001' })]),
    );
    expect(result).toMatchObject({ replayed: false, checkout: null, view: { status: 'ABANDONED', declared: true } });

    const attempt = await db.checkoutAttempt.findUniqueOrThrow({ where: { reserveKey: view.reserveKey } });
    expect(attempt).toMatchObject({ status: 'ABANDONED', abandonedById: f.users[0]!.id, declaredById: f.users[0]!.id });
    expect(attempt.declaredAt).not.toBeNull();
    expect(result.view.declaration!.rows.map((row) => [row.method, row.tenderSource, row.outcome]))
      .toEqual([['CASH', 'NEW', 'NONE'], ['TRANSFER', 'NEW', 'CHARGED']]);

    const collections = await db.externalCollection.findMany({ where: { originAttemptId: attempt.id } });
    expect(collections).toHaveLength(1);
    expect(collections[0]).toMatchObject({
      branchId: f.branch, method: 'TRANSFER', amount: DEBIT_FIXED, status: 'UNAPPLIED', claimAttemptId: null,
      originSaleId: sale.id, cashSessionId: attempt.cashSessionId, recordedById: f.users[0]!.id, reference,
    });
    const declaration = await db.checkoutAttemptDeclaration.findFirstOrThrow({ where: { attemptId: attempt.id, method: 'TRANSFER' } });
    expect(declaration).toMatchObject({ outcome: 'CHARGED', externalCollectionId: collections[0]!.id, declaredById: f.users[0]!.id });

    // S6 touches neither cash nor stock.
    expect(await db.salePayment.count({ where: { saleId: sale.id } })).toBe(0);
    expect(await db.saleCheckout.count({ where: { saleId: sale.id } })).toBe(0);
    expect(await db.cashMovement.count({ where: { sessionId: f.session.id } })).toBe(0);
    expect(await db.inventory.findFirstOrThrow({ where: { variantId: f.variant.id, branchId: f.branch } })).toMatchObject({ physical: 10n, reserved: 1n });
    expect(await db.stockReservation.count({ where: { saleId: sale.id, status: 'ACTIVE' } })).toBe(1);
    expect((await db.sale.findUniqueOrThrow({ where: { id: sale.id } })).status).toBe('PENDING_PAYMENT');
    // P2-A: the three T-X rows share one transaction_timestamp(), so their
    // relative order is not observable here (it is proven DB-free by S6W-01..04).
    // Compare the multiset; order only across transactions: T-R before T-X.
    const audits = await db.auditLog.findMany({ where: { branchId: f.branch }, select: { action: true, timestamp: true } });
    expect(audits.map((row) => row.action).sort())
      .toEqual(['CHECKOUT_DECLARATION_RECORDED', 'CHECKOUT_RESERVATION_ABANDONED', 'CHECKOUT_RESERVED', 'EXTERNAL_COLLECTION_RECORDED']);
    const reserved = audits.find((row) => row.action === 'CHECKOUT_RESERVED')!;
    for (const row of audits) expect(row.timestamp.getTime()).toBeGreaterThanOrEqual(reserved.timestamp.getTime());

    // F2: an identical replay is a 200 with ZERO writes (no new declaration,
    // collection or audit; the attempt keeps its declaredAt).
    const auditsBefore = await db.auditLog.count({ where: { branchId: f.branch } });
    const replay = await closeService(db).close(
      actor(f.users[0]!.id, 'CASHIER', f.branch) as never, sale.id, view.reserveKey,
      closeRequest([d('CASH'), d('TRANSFER', { outcome: 'CHARGED', amount: DEBIT_FIXED, reference, referenceKey: normalizeReferenceKey(reference), institution: 'GALICIA', evidence: 'comprobante 0001' })]),
    );
    expect(replay).toMatchObject({ replayed: true, checkout: null, view: { status: 'ABANDONED' } });
    expect(await db.checkoutAttemptDeclaration.count({ where: { attemptId: attempt.id } })).toBe(2);
    expect(await db.externalCollection.count({ where: { originAttemptId: attempt.id } })).toBe(1);
    expect(await db.auditLog.count({ where: { branchId: f.branch } })).toBe(auditsBefore);
    expect((await db.checkoutAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).declaredAt?.toISOString()).toBe(attempt.declaredAt!.toISOString());
  });

  it('S6PG-02 a REAL 55P03 on the Sale lock: the close is 409 CHECKOUT_RESERVATION_BUSY with zero writes and zero retries', async () => {
    const f = await fixture();
    const sale = await f.sale();
    await f.inventory(10n, 1n);
    const { view } = await reserve(db, f.users[0]!.id, f.branch, sale.id, await cashPlan(sale.lines, f.session.id));
    const updatedAtBefore = (await db.sale.findUniqueOrThrow({ where: { id: sale.id } })).updatedAt;

    const coordinator = await holdRowLock(pools[0]!, 'Sale', sale.id);
    try {
      const failure = await errorOf(closeService(clients[1]!).close(
        actor(f.users[0]!.id, 'CASHIER', f.branch) as never, sale.id, view.reserveKey, closeRequest([d('CASH')]),
      ));
      expect(failure).toMatchObject({ status: 409, code: 'CHECKOUT_RESERVATION_BUSY' });
    } finally {
      await coordinator.release();
    }

    const attempt = await db.checkoutAttempt.findUniqueOrThrow({ where: { reserveKey: view.reserveKey } });
    expect(attempt).toMatchObject({ status: 'RESERVED', declaredAt: null });
    expect(await db.checkoutAttemptDeclaration.count({ where: { attemptId: attempt.id } })).toBe(0);
    expect(await db.auditLog.count({ where: { action: 'CHECKOUT_RESERVATION_ABANDONED', entityId: attempt.id } })).toBe(0);
    expect(await db.externalCollection.count({ where: { branchId: f.branch } })).toBe(0);
    expect((await db.sale.findUniqueOrThrow({ where: { id: sale.id } })).updatedAt.toISOString()).toBe(updatedAtBefore.toISOString());
  });

  it('S6PG-03 an OWNER-supervised close of a COLLECTION (CARD_DEBIT) tender declared NONE releases the claim only after declaredAt', async () => {
    const f = await fixture();
    const sale = await f.sale();
    await f.inventory(10n, 1n);
    const ec = await f.collection({ method: 'CARD_DEBIT', amount: DEBIT_FIXED, originSaleId: sale.id });
    const { view } = await reserve(db, f.users[0]!.id, f.branch, sale.id, await collectionPlan(sale.lines, f.session.id, ec.id, DEBIT_FIXED));
    expect((await db.externalCollection.findUniqueOrThrow({ where: { id: ec.id } })).claimAttemptId)
      .toBe((await db.checkoutAttempt.findUniqueOrThrow({ where: { reserveKey: view.reserveKey } })).id);

    const result = await closeService(db).close(
      ownerActor(f.users[1]!.id) as never, sale.id, view.reserveKey,
      closeRequest([d('CASH', { evidence: JUSTIFICATION.evidence }), d('CARD_DEBIT', { evidence: JUSTIFICATION.evidence })], JUSTIFICATION),
    );
    expect(result).toMatchObject({ replayed: false, checkout: null, view: { status: 'ABANDONED', declared: true } });

    const attempt = await db.checkoutAttempt.findUniqueOrThrow({ where: { reserveKey: view.reserveKey } });
    expect(attempt).toMatchObject({ status: 'ABANDONED', abandonedById: f.users[1]!.id, declaredById: f.users[1]!.id, abandonReason: JUSTIFICATION.reason, abandonEvidence: JUSTIFICATION.evidence });
    const collection = await db.externalCollection.findUniqueOrThrow({ where: { id: ec.id } });
    expect(collection).toMatchObject({ status: 'UNAPPLIED', claimAttemptId: null });
    expect(await db.auditLog.count({ where: { action: 'EXTERNAL_COLLECTION_CLAIM_RELEASED', entityId: ec.id } })).toBe(1);
    // A COLLECTION tender is never CHARGED: no collection was created for the
    // attempt, and the plan's own collection was the only one touched.
    expect(await db.externalCollection.count({ where: { originAttemptId: attempt.id } })).toBe(0);
  });

  it('P55 a REAL T-C holding the Sale lock while blocked on its plan collection: T-X gets 409 CHECKOUT_RESERVATION_BUSY and T-C then commits CONFIRMED', async () => {
    const f = await fixture();
    const sale = await f.sale();
    await f.inventory(10n, 1n);
    const ec = await f.collection({ method: 'CARD_DEBIT', amount: DEBIT_FIXED, originSaleId: sale.id });
    const plan = await collectionPlan(sale.lines, f.session.id, ec.id, DEBIT_FIXED);
    const { view } = await reserve(db, f.users[0]!.id, f.branch, sale.id, plan);

    const confirmation: CheckoutConfirmationRequest = {
      reserveKey: view.reserveKey, operationKey: view.operationKey,
      tenders: [
        { method: 'CASH', receivedAmount: plan.expectedBalanceAmount, reference: null, referenceKey: null, institution: null, institutionOther: null } as CheckoutConfirmationTender,
        // A COLLECTION tender carries no new reference or institution.
        { method: 'CARD_DEBIT', receivedAmount: null, reference: null, referenceKey: null, institution: null, institutionOther: null } as CheckoutConfirmationTender,
      ],
      supervisor: null,
    };

    // The coordinator holds the plan's collection row. T-C locks the Sale, then
    // blocks at step 5 on that collection; T-X's NOWAIT Sale lock then fails.
    const coordinator = await holdRowLock(pools[0]!, 'ExternalCollection', ec.id);
    let checkout: Promise<CheckoutResult> | undefined;
    try {
      checkout = withTimeout(
        checkoutService(clients[1]!).checkout(actor(f.users[0]!.id, 'CASHIER', f.branch) as never, f.users[0]!.id, sale.id, confirmation),
        RACE_TIMEOUT_MS, 'P55 T-C',
      );
      await waitForBlocked(pools[0]!, coordinator.pid, 1, /FROM "ExternalCollection"/);
      const busy = await errorOf(closeService(clients[2]!).close(
        actor(f.users[0]!.id, 'CASHIER', f.branch) as never, sale.id, view.reserveKey,
        closeRequest([d('CASH'), d('CARD_DEBIT')]),
      ));
      expect(busy).toMatchObject({ status: 409, code: 'CHECKOUT_RESERVATION_BUSY' });
    } finally {
      await coordinator.release();
    }

    const result = await checkout!;
    expect(result).toMatchObject({ status: 'COMPLETED', replayed: false });
    expect(await db.salePayment.count({ where: { saleId: sale.id } })).toBe(2);
    expect(await db.checkoutAttemptDeclaration.count({ where: { saleId: sale.id } })).toBe(0);
    expect(await db.auditLog.count({ where: { action: 'CHECKOUT_RESERVATION_ABANDONED', entityId: (await db.checkoutAttempt.findUniqueOrThrow({ where: { reserveKey: view.reserveKey } })).id } })).toBe(0);
    expect(await db.externalCollection.findUniqueOrThrow({ where: { id: ec.id } })).toMatchObject({ status: 'APPLIED', appliedSaleId: sale.id, claimAttemptId: (await db.checkoutAttempt.findUniqueOrThrow({ where: { reserveKey: view.reserveKey } })).id });
    expect((await db.checkoutAttempt.findUniqueOrThrow({ where: { reserveKey: view.reserveKey } })).status).toBe('CONFIRMED');
  });

  // R-2 (OWNER 2026-10-18): T-X CHARGED with an external reference already
  // recorded on the branch. Sequential: the read-only pre-check answers 409
  // EXTERNAL_REFERENCE_ALREADY_RECORDED before the first write.
  it('S6PG-04 R-2 duplicate TRANSFER reference, no race: 409 EXTERNAL_REFERENCE_ALREADY_RECORDED from the pre-check with ZERO writes', async () => {
    const f = await fixture();
    const sale = await f.sale();
    await f.inventory(10n, 1n);
    const reference = `R3S6DUP${f.branch.slice(0, 6)}`;
    const key = normalizeReferenceKey(reference);
    const other = await f.sale();
    await db.externalCollection.create({ data: {
      branchId: f.branch, method: 'TRANSFER', amount: DEBIT_FIXED, reference, referenceKey: key, institution: 'GALICIA',
      status: 'UNAPPLIED', originSaleId: other.id, cashSessionId: f.session.id, recordedById: f.users[0]!.id,
    } });
    const { view } = await reserve(db, f.users[0]!.id, f.branch, sale.id, await transferPlan(sale.lines, f.session.id, DEBIT_FIXED));
    const attempt = await db.checkoutAttempt.findUniqueOrThrow({ where: { reserveKey: view.reserveKey } });
    const saleBefore = await db.sale.findUniqueOrThrow({ where: { id: sale.id } });
    const auditsBefore = await db.auditLog.count({ where: { branchId: f.branch } });

    const refused = await errorOf(closeService(db).close(
      actor(f.users[0]!.id, 'CASHIER', f.branch) as never, sale.id, view.reserveKey,
      closeRequest([d('CASH'), d('TRANSFER', { outcome: 'CHARGED', amount: DEBIT_FIXED, reference, referenceKey: key, institution: 'GALICIA', evidence: 'comprobante 0002' })]),
    ));
    expect(refused).toMatchObject({ status: 409, code: 'EXTERNAL_REFERENCE_ALREADY_RECORDED' });

    expect(await db.checkoutAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).toMatchObject({ status: 'RESERVED', declaredAt: null });
    expect(await db.checkoutAttemptDeclaration.count({ where: { attemptId: attempt.id } })).toBe(0);
    expect(await db.externalCollection.count({ where: { branchId: f.branch, referenceKey: key } })).toBe(1);
    expect(await db.externalCollection.count({ where: { originAttemptId: attempt.id } })).toBe(0);
    expect((await db.sale.findUniqueOrThrow({ where: { id: sale.id } })).updatedAt.toISOString()).toBe(saleBefore.updatedAt.toISOString());
    expect(await db.auditLog.count({ where: { branchId: f.branch } })).toBe(auditsBefore);
    expect(await db.cashMovement.count({ where: { sessionId: f.session.id } })).toBe(0);
  });

  // R-2: a peer records the SAME reference after T-X's pre-check. The peer's
  // INSERT is uncommitted while T-X runs (READ COMMITTED: the pre-check cannot
  // see it), so T-X's own INSERT waits on the partial unique index — proven by
  // the lock-wait chain — and fails with a REAL 23505 once the peer commits. The
  // adapter-pg P2002 must become the same 409, and T-X rolls back completely.
  it('S6PG-05 R-2 race after the pre-check: the REAL adapter-pg P2002 of ExternalCollection_transfer_ref_key is 409 EXTERNAL_REFERENCE_ALREADY_RECORDED; full rollback', async () => {
    const f = await fixture();
    const sale = await f.sale();
    await f.inventory(10n, 1n);
    const other = await f.sale();
    const reference = `R3S6RACE${f.branch.slice(0, 6)}`;
    const key = normalizeReferenceKey(reference);
    const { view } = await reserve(db, f.users[0]!.id, f.branch, sale.id, await transferPlan(sale.lines, f.session.id, DEBIT_FIXED));
    const attempt = await db.checkoutAttempt.findUniqueOrThrow({ where: { reserveKey: view.reserveKey } });
    const auditsBefore = await db.auditLog.count({ where: { branchId: f.branch } });

    let releasePeer!: () => void;
    const gate = new Promise<void>((resolve) => { releasePeer = resolve; });
    let peerPid = 0;
    let peerReady!: () => void;
    const ready = new Promise<void>((resolve) => { peerReady = resolve; });
    const peer = db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      peerPid = rows[0]!.pid;
      await tx.externalCollection.create({ data: {
        branchId: f.branch, method: 'TRANSFER', amount: DEBIT_FIXED, reference, referenceKey: key, institution: 'GALICIA',
        status: 'UNAPPLIED', originSaleId: other.id, cashSessionId: f.session.id, recordedById: f.users[1]!.id,
      } });
      peerReady();
      await gate;
    }, { timeout: RACE_TIMEOUT_MS, maxWait: RACE_TIMEOUT_MS });
    let close: Promise<unknown> | undefined;
    try {
      await withTimeout(ready, RACE_TIMEOUT_MS, 'S6PG-05 peer insert');
      close = errorOf(closeService(clients[1]!).close(
        actor(f.users[0]!.id, 'CASHIER', f.branch) as never, sale.id, view.reserveKey,
        closeRequest([d('CASH'), d('TRANSFER', { outcome: 'CHARGED', amount: DEBIT_FIXED, reference, referenceKey: key, institution: 'GALICIA', evidence: 'comprobante 0003' })]),
      ));
      // T-X passed its pre-check and is now waiting on the peer's index entry.
      await waitForBlocked(pools[0]!, peerPid, 1, /INSERT INTO .*"ExternalCollection"/);
    } finally {
      releasePeer();
    }
    await peer;
    const refused = await withTimeout(close!, RACE_TIMEOUT_MS, 'S6PG-05 close');
    expect(refused).toMatchObject({ status: 409, code: 'EXTERNAL_REFERENCE_ALREADY_RECORDED' });

    expect(await db.checkoutAttempt.findUniqueOrThrow({ where: { id: attempt.id } })).toMatchObject({ status: 'RESERVED', declaredAt: null });
    expect(await db.checkoutAttemptDeclaration.count({ where: { attemptId: attempt.id } })).toBe(0);
    expect(await db.externalCollection.count({ where: { originAttemptId: attempt.id } })).toBe(0);
    expect(await db.externalCollection.count({ where: { branchId: f.branch, referenceKey: key } })).toBe(1);
    // only the peer's own write survives; T-X wrote no audit and no cash
    expect(await db.auditLog.count({ where: { branchId: f.branch } })).toBe(auditsBefore);
    expect(await db.cashMovement.count({ where: { sessionId: f.session.id } })).toBe(0);
  });
});
