// QR inside PROPORTIONAL_V1 on a REAL PostgreSQL (P0-B). OPT-IN ONLY:
// it needs the DISPOSABLE, isolated LOCAL_TEST cluster with migrations 1–14 (the QR
// migration 20261021140000_r3_qr applied) and the canonical baseline catalog (an oldest
// Company and at least one ProductVariant), bound by marker + system id:
//   MONA_R3_QR_PG=1 MONA_R3_QR_PG_DISPOSABLE=1 MONA_TEST_DATABASE_TARGET=local
//   LOCAL_TEST_DATABASE_URL=… LOCAL_TEST_DATABASE_MARKER_ID=…
//   MONA_R3_PG_SYSTEM_ID=<pg_control_system().system_identifier of THAT cluster>
// Writes are COMMITTED and PERMANENT by design (F1 forbids deleting a CheckoutAttempt,
// F6 an ExternalCollection): the cluster is discarded afterwards, never reused.
//
// What only PostgreSQL proves: the real reserve → settle of a plan that carries QR
// (retail and wholesale) with the sealed QR snapshot, the new SQL CHECKs and the QR
// reference index, a genuine overlap of two confirmations, that QR never writes a
// CashMovement, that a later configuration change never touches a sealed attempt, and that
// rows written exactly as an N-1 API writes them (version 1/2, no QR columns) are still
// valid next to the new ones.
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../src/generated/prisma/client.js';
import { normalizeReferenceKey, type PlanTenderInput } from '../../src/modules/payments/checkout-canonical.js';
import { createCashService } from '../../src/modules/cash/cash.service.js';
import { DEFAULT_ROLE_GRANTS } from '../../src/modules/rbac/role-permission-matrix.js';
import { createCheckoutCloseService } from '../../src/modules/payments/checkout-close.service.js';
import type { CheckoutDeclarationRow } from '../../src/modules/payments/dto/checkout-close.dto.js';
import { createCheckoutReservationService } from '../../src/modules/payments/checkout-reservation.service.js';
import { createCheckoutService, type CheckoutResult } from '../../src/modules/payments/checkout.service.js';
import type { CheckoutConfirmationRequest, CheckoutConfirmationTender } from '../../src/modules/payments/dto/checkout.dto.js';
import { createPricingService } from '../../src/modules/pricing/pricing.service.js';
import { computeProportionalQuote, type ProportionalMethod } from '../../src/modules/pricing/proportional-checkout.js';
import {
  actor,
  codeOf,
  holdRowLock,
  PG_SYSTEM_ID,
  pointOfSaleNumberFor,
  RACE_TIMEOUT_MS,
  waitForBlocked,
  withTimeout,
} from '../helpers/r3-service-pg.js';

const enabled = process.env.MONA_R3_QR_PG === '1';

const BASE = 10000n; // one line, one unit, $100,00 cash base
const QR_BPS = 1200; // the fixture sets the company QR adjustment to +12%
const QR_FULL = 11200n; // 10000 * 1,12 (hand computed, never from the module)
const CREDIT_BPS = 1500; // and the credit adjustment to +15%
const CREDIT_FULL = 11500n;

type Lines = Array<{ saleItemId: string; sku: string; quantity: bigint; baseUnitPrice: bigint }>;

describe.skipIf(!enabled)('QR — proportional checkout on PostgreSQL (migrations 1–14, disposable cluster)', () => {
  const pools: Pool[] = [];
  const clients: PrismaClient[] = [];
  let db: PrismaClient;

  beforeAll(async () => {
    if (process.env.MONA_R3_QR_PG_DISPOSABLE !== '1') throw new Error('QR PG tests write permanent rows: MONA_R3_QR_PG_DISPOSABLE=1 is required');
    if (process.env.MONA_TEST_DATABASE_TARGET !== 'local') throw new Error('LOCAL_TEST selector required');
    const expectedSystemId = process.env.MONA_R3_PG_SYSTEM_ID;
    if (!expectedSystemId || !PG_SYSTEM_ID.test(expectedSystemId)) {
      throw new Error('isolated cluster binding is missing: MONA_R3_PG_SYSTEM_ID must be the decimal pg_control_system().system_identifier of the target');
    }
    const { openProvenLocalTestPool } = await import('../../scripts/demo-database.js');
    for (const max of [3, 2, 2]) {
      const { pool } = await openProvenLocalTestPool(max, process.env);
      pools.push(pool);
      clients.push(new PrismaClient({ adapter: new PrismaPg(pool, { schema: 'public' }), log: [] }));
    }
    const { rows } = await pools[0]!.query<{ system_id: string; ok: boolean }>(
      `SELECT system_identifier::text AS system_id,
              EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'CheckoutAttempt' AND column_name = 'fullPriceQr') AS ok
       FROM pg_control_system()`);
    if (rows[0]?.system_id !== expectedSystemId) throw new Error('isolated PostgreSQL cluster does not match binding');
    if (rows[0]?.ok !== true) throw new Error('the QR migration (14) is required');
    db = clients[0]!;
    const company = await db.company.findFirstOrThrow({ orderBy: { createdAt: 'asc' }, select: { id: true } });
    await db.companyPricingConfig.upsert({
      where: { companyId: company.id },
      create: { companyId: company.id, bankTransferAdjustmentBps: 200, debitCardAdjustmentBps: 300, creditCardAdjustmentBps: CREDIT_BPS, qrAdjustmentBps: QR_BPS },
      update: { creditCardAdjustmentBps: CREDIT_BPS, qrAdjustmentBps: QR_BPS },
    });
  });
  afterAll(async () => {
    for (const client of clients) await client.$disconnect();
    for (const pool of pools) await pool.end();
  });

  async function fixture(options: { wholesale?: boolean } = {}) {
    const company = await db.company.findFirstOrThrow({ orderBy: { createdAt: 'asc' }, select: { id: true } });
    const variant = await db.productVariant.findFirstOrThrow({ select: { id: true, productId: true, sku: true }, orderBy: { id: 'asc' } });
    const branch = randomUUID();
    const tag = branch.slice(0, 8);
    await db.location.create({ data: { id: branch, companyId: company.id, code: `qrpg-${tag}`, name: `QR ${tag}`, type: 'RETAIL_BRANCH', address: 'Test', pointOfSaleNumber: pointOfSaleNumberFor('QR', tag) } });
    await db.branch.create({ data: { id: branch, code: `qrpg-${tag}`, name: `QR ${tag}`, address: 'Test', pointOfSaleNumber: 1 } });
    const users = await Promise.all([0, 1].map((n) => db.user.create({ data: { name: `QR ${n}`, email: `qrpg-${tag}-${n}@test.invalid`, passwordHash: 'not-used' } })));
    const register = await db.cashRegister.create({ data: { branchId: branch, name: `QR ${tag}` } });
    const session = await db.cashSession.create({ data: { registerId: register.id, openedById: users[0]!.id, startingCash: 0n, status: 'OPEN' } });
    const inventory = (physical: bigint, reserved: bigint) => db.inventory.create({ data: { variantId: variant.id, branchId: branch, physical, reserved } });
    const sale = async (base: bigint = BASE) => {
      const wholesale = options.wholesale === true;
      const created = await db.sale.create({
        data: {
          branchId: branch, sellerId: users[0]!.id, status: 'PENDING_PAYMENT', pricingModel: 'PROPORTIONAL_V1', priceMode: 'CASH',
          pricingMode: wholesale ? 'WHOLESALE' : 'LIST', subtotal: base, total: base,
          ...(wholesale ? { wholesaleAuthorizedAt: new Date(), wholesaleConfirmedAt: new Date(), wholesaleConfirmedById: users[1]!.id } : {}),
        },
      });
      const item = await db.saleItem.create({
        data: {
          saleId: created.id, variantId: variant.id, productId: variant.productId, productName: 'QR', variantName: 'QR', sku: variant.sku,
          quantity: 1n, unitPrice: base, subtotal: base, priceBaseType: wholesale ? 'WHOLESALE' : 'LIST', priceMode: 'CASH', baseUnitPrice: base, priceAdjustmentBps: 0,
        },
      });
      await db.stockReservation.create({ data: { saleId: created.id, variantId: variant.id, branchId: branch, quantity: 1n, status: 'ACTIVE', expiresAt: new Date(Date.now() + 30 * 60_000) } });
      return { ...created, lines: [{ saleItemId: item.id, sku: item.sku, quantity: 1n, baseUnitPrice: base }] as Lines };
    };
    return { branch, tag, users, session, variant, inventory, sale };
  }

  const pricingOf = async () => {
    const snapshot = await createPricingService(db).getSnapshot();
    if (snapshot.id === null) throw new Error('QR fixture: the company pricing configuration is missing');
    return {
      bankTransferAdjustmentBps: snapshot.adjustmentsBps.BANK_TRANSFER!,
      debitCardAdjustmentBps: snapshot.adjustmentsBps.DEBIT_CARD!,
      creditCardAdjustmentBps: snapshot.adjustmentsBps.CREDIT_CARD!,
      qrAdjustmentBps: snapshot.adjustmentsBps.QR!,
    };
  };

  // A plan: `fixed` tenders (NEW) plus a balance method; amounts come from the engine (the
  // server compares them to its own quote and refuses a mismatch).
  async function plan(
    lines: Lines, sessionId: string, balanceMethod: ProportionalMethod, fixed: Array<{ method: Exclude<ProportionalMethod, never>; amount: bigint }> = [],
  ) {
    const quote = computeProportionalQuote({ lines, pricing: await pricingOf(), balanceMethod, tenders: fixed });
    const tenders: PlanTenderInput[] = [
      { method: balanceMethod, role: 'BALANCE', source: 'NEW', amount: null, externalCollectionId: null },
      ...fixed.map((tender): PlanTenderInput => ({ method: tender.method, role: 'FIXED', source: 'NEW', amount: tender.amount, externalCollectionId: null })),
    ];
    return { reserveKey: randomUUID(), cashSessionId: sessionId, balanceMethod, expectedTotal: quote.total, expectedBalanceAmount: quote.balance.amount, tenders, recovery: null, quote };
  }

  const reserve = (client: PrismaClient, userId: string, branchId: string, saleId: string, request: Awaited<ReturnType<typeof plan>>) => {
    const { quote: _quote, ...body } = request;
    void _quote;
    return createCheckoutReservationService(client, { externalMethodsEnabled: true }).reserve(actor(userId, 'CASHIER', branchId) as never, saleId, body);
  };
  const checkoutService = (client: PrismaClient) => createCheckoutService(client);

  const tender = (
    method: CheckoutConfirmationTender['method'], fields: Partial<CheckoutConfirmationTender> = {},
  ): CheckoutConfirmationTender => ({ method, receivedAmount: null, reference: null, referenceKey: null, institution: null, institutionOther: null, ...fields } as CheckoutConfirmationTender);
  const refTender = (method: 'QR' | 'CARD_CREDIT' | 'CARD_DEBIT', reference: string) =>
    tender(method, { reference, referenceKey: normalizeReferenceKey(reference) });
  const confirmation = (view: { reserveKey: string; operationKey: string }, tenders: CheckoutConfirmationTender[]): CheckoutConfirmationRequest =>
    ({ reserveKey: view.reserveKey, operationKey: view.operationKey, tenders, supervisor: null });

  const allocationsAddUp = async (saleId: string) => {
    for (const payment of await db.salePayment.findMany({ where: { saleId } })) {
      const sum = (await db.saleLineAllocation.findMany({ where: { salePaymentId: payment.id } })).reduce((total, row) => total + row.amount, 0n);
      expect(sum, `allocations of ${payment.method}`).toBe(payment.amount);
    }
  };

  it('QRPG-01 simple QR: reserve seals the QR snapshot (version 3) and the settlement writes one referenced QR payment and NO cash movement', async () => {
    const f = await fixture();
    const sale = await f.sale();
    await f.inventory(10n, 1n);
    const request = await plan(sale.lines, f.session.id, 'QR');
    expect(request.expectedTotal).toBe(QR_FULL);
    const { view } = await reserve(db, f.users[0]!.id, f.branch, sale.id, request);

    const attempt = await db.checkoutAttempt.findUniqueOrThrow({ where: { reserveKey: view.reserveKey } });
    expect(attempt).toMatchObject({
      balanceMethod: 'QR', fullPriceQr: QR_FULL, qrAdjustmentBps: QR_BPS, fullPriceCredit: CREDIT_FULL, creditAdjustmentBps: CREDIT_BPS,
      algorithmVersion: 3, expectedTotal: QR_FULL,
    });
    expect(view.plan.fullPrices.QR).toBe(QR_FULL);

    const reference = `QRPG1${f.tag}`;
    const result = await checkoutService(db).checkout(
      actor(f.users[0]!.id, 'CASHIER', f.branch) as never, f.users[0]!.id, sale.id, confirmation(view, [refTender('QR', reference)]));
    expect(result).toMatchObject({ saleId: sale.id, status: 'COMPLETED', replayed: false, total: QR_FULL, changeAmount: 0n });

    const payments = await db.salePayment.findMany({ where: { saleId: sale.id } });
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({
      method: 'QR', tenderRole: 'BALANCE', amount: QR_FULL, methodFullPrice: QR_FULL, adjustmentBps: QR_BPS,
      receivedAmount: null, changeAmount: null, pricingModel: 'PROPORTIONAL_V1',
    });
    const collection = await db.externalCollection.findUniqueOrThrow({ where: { id: payments[0]!.externalCollectionId! } });
    expect(collection).toMatchObject({ method: 'QR', amount: QR_FULL, referenceKey: normalizeReferenceKey(reference), institution: null, institutionOther: null, status: 'APPLIED' });
    expect(await db.saleCheckout.findUniqueOrThrow({ where: { saleId: sale.id } }))
      .toMatchObject({ balanceMethod: 'QR', fullPriceQr: QR_FULL, qrAdjustmentBps: QR_BPS, algorithmVersion: 3, total: QR_FULL });
    await allocationsAddUp(sale.id);
    // QR is not cash: no SALE_INCOME, no cash movement of any kind for the session.
    expect(await db.cashMovement.count({ where: { sessionId: f.session.id } })).toBe(0);
    expect(await db.inventory.findFirstOrThrow({ where: { variantId: f.variant.id, branchId: f.branch } })).toMatchObject({ physical: 9n, reserved: 0n });
    expect(await db.stockReservation.count({ where: { saleId: sale.id, status: 'CONSUMED' } })).toBe(1);
  });

  it('QRPG-02 combined CASH fixed + QR balance: exact amounts, change on the cash tender, one SALE_INCOME (cash only), allocations add up', async () => {
    const f = await fixture();
    const sale = await f.sale();
    await f.inventory(10n, 1n);
    // balance = 11.200 * (10.000 - 4.000) / 10.000 = 6.720 -> whole peso (half-up) 6.700 ; total = 10.700
    const request = await plan(sale.lines, f.session.id, 'QR', [{ method: 'CASH', amount: 4000n }]);
    expect(request.expectedBalanceAmount).toBe(6700n);
    expect(request.expectedTotal).toBe(10700n);
    const { view } = await reserve(db, f.users[0]!.id, f.branch, sale.id, request);
    const result = await checkoutService(db).checkout(actor(f.users[0]!.id, 'CASHIER', f.branch) as never, f.users[0]!.id, sale.id,
      confirmation(view, [tender('CASH', { receivedAmount: 5000n }), refTender('QR', `QRPG2${f.tag}`)]));
    expect(result).toMatchObject({ status: 'COMPLETED', total: 10700n, changeAmount: 1000n });
    const payments = (await db.salePayment.findMany({ where: { saleId: sale.id } })).sort((a, b) => (a.method < b.method ? -1 : 1));
    expect(payments.map((payment) => [payment.method, payment.amount, payment.tenderRole, payment.adjustmentBps]))
      .toEqual([['CASH', 4000n, 'FIXED', 0], ['QR', 6700n, 'BALANCE', QR_BPS]]);
    expect(payments.reduce((sum, payment) => sum + payment.amount, 0n)).toBe(10700n);
    await allocationsAddUp(sale.id);
    const movements = await db.cashMovement.findMany({ where: { sessionId: f.session.id } });
    expect(movements.map((movement) => [movement.type, movement.amount])).toEqual([['SALE_INCOME', 4000n]]);
  });

  it('QRPG-03 QR fixed + TRANSFER balance and QR fixed + CARD_CREDIT balance: distinct referenced collections, exact totals', async () => {
    const f = await fixture();
    const [saleA, saleB] = [await f.sale(), await f.sale()];
    await f.inventory(10n, 2n);
    const settle = async (sale: typeof saleA, balance: 'TRANSFER' | 'CARD_CREDIT', qrAmount: bigint, tag: string) => {
      const request = await plan(sale.lines, f.session.id, balance, [{ method: 'QR', amount: qrAmount }]);
      const { view } = await reserve(db, f.users[0]!.id, f.branch, sale.id, request);
      const balanceTender = balance === 'TRANSFER'
        ? tender('TRANSFER', { reference: `${tag}${f.tag}T`, referenceKey: normalizeReferenceKey(`${tag}${f.tag}T`), institution: 'GALICIA' })
        : refTender('CARD_CREDIT', `${tag}${f.tag}C`);
      const result = await checkoutService(db).checkout(actor(f.users[0]!.id, 'CASHIER', f.branch) as never, f.users[0]!.id, sale.id,
        confirmation(view, [refTender('QR', `${tag}${f.tag}Q`), balanceTender]));
      expect(result).toMatchObject({ status: 'COMPLETED', total: request.expectedTotal });
      return request;
    };
    await settle(saleA, 'TRANSFER', 5600n, 'QRPG3A');
    await settle(saleB, 'CARD_CREDIT', 5600n, 'QRPG3B');
    for (const [sale, other] of [[saleA, 'TRANSFER'], [saleB, 'CARD_CREDIT']] as const) {
      const collections = await db.externalCollection.findMany({ where: { appliedSaleId: sale.id } });
      expect(collections.map((row) => row.method).sort()).toEqual([other, 'QR'].sort());
      await allocationsAddUp(sale.id);
    }
    expect(await db.cashMovement.count({ where: { sessionId: f.session.id } })).toBe(0);
  });

  it('QRPG-04 wholesale: QR is priced on the wholesale base and the confirmed wholesale sale settles', async () => {
    const f = await fixture({ wholesale: true });
    const sale = await f.sale(8000n); // wholesale base $80,00 -> QR 8.000 * 1,12 = 8.960 -> whole peso (half-up) 9.000
    await f.inventory(10n, 1n);
    const request = await plan(sale.lines, f.session.id, 'QR');
    expect(request.expectedTotal).toBe(9000n);
    const { view } = await reserve(db, f.users[0]!.id, f.branch, sale.id, request);
    const result = await checkoutService(db).checkout(actor(f.users[0]!.id, 'CASHIER', f.branch) as never, f.users[0]!.id, sale.id,
      confirmation(view, [refTender('QR', `QRPG4${f.tag}`)]));
    expect(result).toMatchObject({ status: 'COMPLETED', total: 9000n });
    expect(await db.saleCheckout.findUniqueOrThrow({ where: { saleId: sale.id } })).toMatchObject({ fullPriceCash: 8000n, fullPriceQr: 9000n, qrAdjustmentBps: QR_BPS });
  });

  it('QRPG-05 two overlapping confirmations of the same QR attempt: exactly one settlement, the other replays', async () => {
    const f = await fixture();
    const sale = await f.sale();
    await f.inventory(10n, 1n);
    const { view } = await reserve(db, f.users[0]!.id, f.branch, sale.id, await plan(sale.lines, f.session.id, 'QR'));
    const request = confirmation(view, [refTender('QR', `QRPG5${f.tag}`)]);
    const services = [checkoutService(clients[1]!), checkoutService(clients[2]!)];
    const coordinator = await holdRowLock(pools[0]!, 'Sale', sale.id);
    let race: Promise<PromiseSettledResult<CheckoutResult>[]> | undefined;
    try {
      race = Promise.allSettled(services.map((service) => service.checkout(actor(f.users[0]!.id, 'CASHIER', f.branch) as never, f.users[0]!.id, sale.id, request)));
      await waitForBlocked(pools[0]!, coordinator.pid, 2, /FROM "Sale" WHERE id = \$1 FOR UPDATE/);
    } finally {
      await coordinator.release();
    }
    const results = await withTimeout(race!, RACE_TIMEOUT_MS, 'QRPG-05 confirmations');
    expect(results.filter((result) => result.status === 'rejected')).toEqual([]);
    const settled = results as PromiseFulfilledResult<CheckoutResult>[];
    expect(settled.map((result) => result.value.replayed).sort()).toEqual([false, true]);
    expect(await db.salePayment.count({ where: { saleId: sale.id } })).toBe(1);
    expect(await db.saleCheckout.count({ where: { saleId: sale.id } })).toBe(1);
    expect(await db.externalCollection.count({ where: { appliedSaleId: sale.id, method: 'QR' } })).toBe(1);
    expect(await db.inventory.findFirstOrThrow({ where: { variantId: f.variant.id, branchId: f.branch } })).toMatchObject({ physical: 9n, reserved: 0n });
  });

  it('QRPG-06 a QR reference is unique per branch in its own namespace: it never collides with a credit or a debit reference', async () => {
    const f = await fixture();
    const [saleA, saleB, saleC, saleD] = [await f.sale(), await f.sale(), await f.sale(), await f.sale()];
    await f.inventory(10n, 4n);
    const shared = `QRPG6${f.tag}`;
    const settle = async (sale: typeof saleA, method: 'QR' | 'CARD_CREDIT' | 'CARD_DEBIT') => {
      const { view } = await reserve(db, f.users[0]!.id, f.branch, sale.id, await plan(sale.lines, f.session.id, method));
      return codeOf(checkoutService(db).checkout(actor(f.users[0]!.id, 'CASHIER', f.branch) as never, f.users[0]!.id, sale.id, confirmation(view, [refTender(method, shared)])));
    };
    expect(await settle(saleA, 'QR')).toBeNull();
    expect(await settle(saleB, 'CARD_CREDIT')).toBeNull(); // same reference as a CREDIT: a different namespace
    expect(await settle(saleC, 'CARD_DEBIT')).toBeNull(); // and as a DEBIT
    expect(await settle(saleD, 'QR')).toBe('EXTERNAL_REFERENCE_ALREADY_RECORDED');
    expect(await db.externalCollection.count({ where: { branchId: f.branch, referenceKey: normalizeReferenceKey(shared) } })).toBe(3);
  });

  it('QRPG-07 the QR snapshot is frozen: changing qrAdjustmentBps after the reservation does not alter the sealed attempt, the settlement or the checkout', async () => {
    const f = await fixture();
    const sale = await f.sale();
    await f.inventory(10n, 1n);
    const { view } = await reserve(db, f.users[0]!.id, f.branch, sale.id, await plan(sale.lines, f.session.id, 'QR'));
    const company = await db.company.findFirstOrThrow({ orderBy: { createdAt: 'asc' }, select: { id: true } });
    await db.companyPricingConfig.update({ where: { companyId: company.id }, data: { qrAdjustmentBps: 3000 } });
    try {
      const result = await checkoutService(db).checkout(actor(f.users[0]!.id, 'CASHIER', f.branch) as never, f.users[0]!.id, sale.id,
        confirmation(view, [refTender('QR', `QRPG7${f.tag}`)]));
      expect(result).toMatchObject({ status: 'COMPLETED', total: QR_FULL });
      expect(await db.salePayment.findFirstOrThrow({ where: { saleId: sale.id } })).toMatchObject({ method: 'QR', amount: QR_FULL, adjustmentBps: QR_BPS });
      expect(await db.saleCheckout.findUniqueOrThrow({ where: { saleId: sale.id } })).toMatchObject({ fullPriceQr: QR_FULL, qrAdjustmentBps: QR_BPS });
      expect(await db.checkoutAttempt.findUniqueOrThrow({ where: { reserveKey: view.reserveKey } })).toMatchObject({ fullPriceQr: QR_FULL, qrAdjustmentBps: QR_BPS });
    } finally {
      await db.companyPricingConfig.update({ where: { companyId: company.id }, data: { qrAdjustmentBps: QR_BPS } });
    }
  });

  it('QRPG-13 cash reconciliation: a CASH + QR sale closes the session reconciled on the CASH only (expected = opening + cash, difference 0)', async () => {
    const f = await fixture();
    const sale = await f.sale();
    await f.inventory(10n, 1n);
    // The fixture session is created without its OPENING movement (the open service writes it): add it as the service does.
    await db.cashMovement.create({ data: { sessionId: f.session.id, type: 'OPENING', amount: 0n, salePaymentId: null, userId: f.users[0]!.id } });
    const request = await plan(sale.lines, f.session.id, 'QR', [{ method: 'CASH', amount: 4000n }]);
    const { view } = await reserve(db, f.users[0]!.id, f.branch, sale.id, request);
    await checkoutService(db).checkout(actor(f.users[0]!.id, 'CASHIER', f.branch) as never, f.users[0]!.id, sale.id,
      confirmation(view, [tender('CASH', { receivedAmount: 5000n }), refTender('QR', `QRPG13${f.tag}`)]));
    const qrPayment = await db.salePayment.findFirstOrThrow({ where: { saleId: sale.id, method: 'QR' } });
    expect(qrPayment.amount).toBe(6700n);
    const ctx = {
      userId: f.users[0]!.id, roles: ['CASHIER'], effectiveLocationIds: [f.branch],
      assignments: [{ roleId: 'CASHIER', roleCode: 'CASHIER', scopeKind: 'LOCATION', locationId: f.branch, permissions: [...DEFAULT_ROLE_GRANTS.CASHIER] }],
    } as unknown as Express.AuthContext;
    const closed = await createCashService(db).closeSession(f.session.id, ctx, 4000n);
    expect(closed).toMatchObject({ status: 'CLOSED', closingCash: 4000n });
    const session = await db.cashSession.findUniqueOrThrow({ where: { id: f.session.id } });
    expect(session).toMatchObject({ status: 'CLOSED', expectedCash: 4000n, countedCash: 4000n, difference: 0n });
    // The QR payment is neither a cash payment nor a movement: counting it as cash would have been a 6.700 difference.
    expect(await db.cashMovement.count({ where: { sessionId: f.session.id, salePaymentId: qrPayment.id } })).toBe(0);
  });

  it('QRPG-10 closing a RESERVED attempt that carried a NEW QR tender records it CHARGED as one UNAPPLIED QR collection (no cash, no stock)', async () => {
    const f = await fixture();
    const sale = await f.sale();
    await f.inventory(10n, 1n);
    const request = await plan(sale.lines, f.session.id, 'CASH', [{ method: 'QR', amount: 3000n }]);
    const { view } = await reserve(db, f.users[0]!.id, f.branch, sale.id, request);
    const reference = `QRPG10${f.tag}`;
    const row = (method: CheckoutDeclarationRow['method'], patch: Partial<CheckoutDeclarationRow> = {}): CheckoutDeclarationRow => ({
      method, outcome: 'NONE', returnedAmount: null, amount: null, reference: null, referenceKey: null, institution: null, institutionOther: null, evidence: null, ...patch,
    });
    const result = await createCheckoutCloseService(db).close(actor(f.users[0]!.id, 'CASHIER', f.branch) as never, sale.id, view.reserveKey, {
      supervisor: null,
      declarations: [row('CASH'), row('QR', { outcome: 'CHARGED', amount: 3000n, reference, referenceKey: normalizeReferenceKey(reference), evidence: 'comprobante 0010' })],
    });
    expect(result).toMatchObject({ replayed: false, checkout: null, view: { status: 'ABANDONED', declared: true } });
    const attempt = await db.checkoutAttempt.findUniqueOrThrow({ where: { reserveKey: view.reserveKey } });
    const collections = await db.externalCollection.findMany({ where: { originAttemptId: attempt.id } });
    expect(collections).toHaveLength(1);
    expect(collections[0]).toMatchObject({ method: 'QR', amount: 3000n, status: 'UNAPPLIED', institution: null, institutionOther: null, referenceKey: normalizeReferenceKey(reference) });
    expect(await db.checkoutAttemptDeclaration.findFirstOrThrow({ where: { attemptId: attempt.id, method: 'QR' } }))
      .toMatchObject({ outcome: 'CHARGED', externalCollectionId: collections[0]!.id });
    expect(await db.salePayment.count({ where: { saleId: sale.id } })).toBe(0);
    expect(await db.cashMovement.count({ where: { sessionId: f.session.id } })).toBe(0);
    expect(await db.inventory.findFirstOrThrow({ where: { variantId: f.variant.id, branchId: f.branch } })).toMatchObject({ physical: 10n, reserved: 1n });
  });

  // ------------------------------------------------------------------------------------------
  // The new SQL constraints, probed directly. Every probe runs inside one transaction that is
  // rolled back, with a SAVEPOINT per statement, so nothing persists.
  // ------------------------------------------------------------------------------------------
  describe('SQL constraints (probed directly, rolled back)', () => {
    async function withProbe(run: (probe: {
      expectViolation: (label: string, sql: string, values: unknown[], code: string, constraint?: string) => Promise<void>;
      expectOk: (label: string, sql: string, values: unknown[]) => Promise<void>;
      client: PoolClient;
    }) => Promise<void>) {
      const client = await pools[0]!.connect();
      let n = 0;
      try {
        await client.query('BEGIN');
        const expectViolation = async (label: string, sql: string, values: unknown[], code: string, constraint?: string) => {
          const name = `sp${(n += 1)}`;
          await client.query(`SAVEPOINT ${name}`);
          let caught: { code?: string; constraint?: string; message?: string } | null = null;
          try {
            await client.query(sql, values);
          } catch (error) {
            caught = error as { code?: string; constraint?: string };
          }
          await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
          expect(caught, `${label}: expected ${code}`).not.toBeNull();
          expect(caught!.code, label).toBe(code);
          if (constraint) expect(caught!.constraint, label).toBe(constraint);
        };
        const expectOk = async (label: string, sql: string, values: unknown[]) => {
          const name = `sp${(n += 1)}`;
          await client.query(`SAVEPOINT ${name}`);
          try {
            await client.query(sql, values);
          } catch (error) {
            throw new Error(`${label}: unexpected failure ${(error as { code?: string; message?: string }).code} ${(error as Error).message}`, { cause: error });
          } finally {
            await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
          }
        };
        await run({ expectViolation, expectOk, client });
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    }

    const ATTEMPT_SQL = `INSERT INTO "CheckoutAttempt"
      ("id","saleId","branchId","reserveKey","operationKey","planHash","cashSessionId","balanceMethod","expectedTotal","expectedBalanceAmount",
       "tenderCount","fullPriceCash","fullPriceTransfer","fullPriceDebit","fullPriceCredit","fullPriceQr","transferAdjustmentBps","debitAdjustmentBps",
       "creditAdjustmentBps","qrAdjustmentBps","pricingConfigId","pricingConfigUpdatedAt","algorithmVersion","startedById")
      VALUES ($1,$2,$3,$4,$5,repeat('a',64),$6,$7::"PaymentMethod",$8,$8,1,10000,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`;

    it('QRPG-08 the QR snapshot CHECK: N-1 rows (version 1 and 2) have none; version 3 has it exactly when the config snapshot exists; a QR balance needs it', async () => {
      const f = await fixture();
      const sale = await f.sale();
      const config = await db.companyPricingConfig.findFirstOrThrow();
      const row = (overrides: Partial<Record<string, unknown>> = {}) => {
        const v = {
          balanceMethod: 'CASH', transfer: 10200, debit: 10300, credit: null, qr: null, tBps: 200, dBps: 300, cBps: null, qBps: null,
          cfg: config.id, cfgAt: config.updatedAt, version: 1, ...overrides,
        };
        return [randomUUID(), sale.id, f.branch, randomUUID(), randomUUID(), f.session.id, v.balanceMethod, 10000, v.transfer, v.debit, v.credit, v.qr, v.tBps, v.dBps,
          v.cBps, v.qBps, v.cfg, v.cfgAt, v.version, f.users[0]!.id];
      };
      const none = { transfer: null, debit: null, tBps: null, dBps: null, cfg: null, cfgAt: null };
      await withProbe(async ({ expectOk, expectViolation }) => {
        // N-1 shapes: what the previous releases write, QR columns omitted (NULL) — still valid.
        await expectOk('N-1 version 1 (no credit, no QR)', ATTEMPT_SQL, row());
        await expectOk('N-1 version 2 (credit snapshot, no QR) — the CARD_CREDIT release', ATTEMPT_SQL, row({ version: 2, credit: 11500, cBps: 1500 }));
        await expectOk('N-1 version 2 CARD_CREDIT balance', ATTEMPT_SQL, row({ version: 2, balanceMethod: 'CARD_CREDIT', credit: 11500, cBps: 1500 }));
        await expectOk('version 3 with the full snapshot', ATTEMPT_SQL, row({ version: 3, credit: 11500, cBps: 1500, qr: 11200, qBps: 1200 }));
        await expectOk('version 3 without any config snapshot', ATTEMPT_SQL, row({ version: 3, ...none }));
        await expectOk('QR balance with its QR price', ATTEMPT_SQL, row({ version: 3, balanceMethod: 'QR', credit: 11500, cBps: 1500, qr: 11200, qBps: 1200 }));
        await expectOk('QR price at 0 bps', ATTEMPT_SQL, row({ version: 3, credit: 10000, cBps: 0, qr: 10000, qBps: 0 }));
        await expectViolation('version 2 with a QR price', ATTEMPT_SQL, row({ version: 2, credit: 11500, cBps: 1500, qr: 11200, qBps: 1200 }), '23514', 'chk_attempt_qr_snapshot');
        await expectViolation('version 1 with a QR price', ATTEMPT_SQL, row({ version: 1, qr: 11200, qBps: 1200 }), '23514', 'chk_attempt_qr_snapshot');
        await expectViolation('version 3 with the config snapshot but no QR', ATTEMPT_SQL, row({ version: 3, credit: 11500, cBps: 1500 }), '23514', 'chk_attempt_qr_snapshot');
        await expectViolation('version 3 with a QR price but no config snapshot', ATTEMPT_SQL, row({ version: 3, ...none, qr: 11200, qBps: 1200 }), '23514', 'chk_attempt_qr_snapshot');
        await expectViolation('QR price without its bps', ATTEMPT_SQL, row({ version: 3, credit: 11500, cBps: 1500, qr: 11200, qBps: null }), '23514', 'chk_attempt_qr_snapshot');
        await expectViolation('QR bps without its price', ATTEMPT_SQL, row({ version: 3, credit: 11500, cBps: 1500, qr: null, qBps: 1200 }), '23514', 'chk_attempt_qr_snapshot');
        await expectViolation('QR price not a whole peso', ATTEMPT_SQL, row({ version: 3, credit: 11500, cBps: 1500, qr: 11250, qBps: 1200 }), '23514', 'chk_attempt_qr_snapshot');
        await expectViolation('QR price zero', ATTEMPT_SQL, row({ version: 3, credit: 11500, cBps: 1500, qr: 0, qBps: 1200 }), '23514', 'chk_attempt_qr_snapshot');
        await expectViolation('QR bps out of range', ATTEMPT_SQL, row({ version: 3, credit: 11500, cBps: 1500, qr: 11200, qBps: 10001 }), '23514', 'chk_attempt_qr_snapshot');
        await expectViolation('QR bps negative', ATTEMPT_SQL, row({ version: 3, credit: 11500, cBps: 1500, qr: 11200, qBps: -1 }), '23514', 'chk_attempt_qr_snapshot');
        await expectViolation('QR balance without a QR price', ATTEMPT_SQL, row({ version: 3, balanceMethod: 'QR', ...none }), '23514', 'chk_attempt_qr_snapshot');
        await expectViolation('unknown algorithm version', ATTEMPT_SQL, row({ version: 4, ...none }), '23514', 'chk_attempt_plan');
        // m12 pinned the credit price to version 2; the widened credit CHECK still rejects the real violations.
        await expectViolation('version 3 with the config snapshot but no credit price', ATTEMPT_SQL, row({ version: 3, qr: 11200, qBps: 1200 }), '23514', 'chk_attempt_credit_snapshot');
        await expectViolation('version 1 with a credit price', ATTEMPT_SQL, row({ version: 1, credit: 11500, cBps: 1500 }), '23514', 'chk_attempt_credit_snapshot');
      });
    });

    it('QRPG-09 the sealed QR snapshot is immutable (F1) and QR is a valid attempt tender', async () => {
      const f = await fixture();
      const sale = await f.sale();
      await f.inventory(10n, 1n);
      const { view } = await reserve(db, f.users[0]!.id, f.branch, sale.id, await plan(sale.lines, f.session.id, 'QR'));
      const attempt = await db.checkoutAttempt.findUniqueOrThrow({ where: { reserveKey: view.reserveKey } });
      expect(attempt.fullPriceQr).toBe(QR_FULL);
      await withProbe(async ({ expectViolation }) => {
        await expectViolation('QR price update', `UPDATE "CheckoutAttempt" SET "fullPriceQr" = 20000 WHERE id = $1`, [attempt.id], '23514');
        await expectViolation('QR bps update', `UPDATE "CheckoutAttempt" SET "qrAdjustmentBps" = 0 WHERE id = $1`, [attempt.id], '23514');
        await expectViolation('QR price cleared', `UPDATE "CheckoutAttempt" SET "fullPriceQr" = NULL, "qrAdjustmentBps" = NULL WHERE id = $1`, [attempt.id], '23514');
        await expectViolation('credit price update (still frozen)', `UPDATE "CheckoutAttempt" SET "fullPriceCredit" = 20000 WHERE id = $1`, [attempt.id], '23514');
      });
      expect(await db.checkoutAttemptTender.findMany({ where: { attemptId: attempt.id } })).toMatchObject([{ method: 'QR', role: 'BALANCE', source: 'NEW' }]);
    });

    it('QRPG-11 ExternalCollection: a QR collection has a reference and no institution, and its reference is unique per branch', async () => {
      const f = await fixture();
      const sale = await f.sale();
      const insert = `INSERT INTO "ExternalCollection"
        ("id","branchId","method","amount","reference","referenceKey","institution","institutionOther","status","originSaleId","recordedById")
        VALUES ($1,$2,$3::"PaymentMethod",$4,$5,$6,$7::"TransferInstitution",$8,'UNAPPLIED',$9,$10)`;
      const row = (method: string, key: string, institution: string | null = null, other: string | null = null) =>
        [randomUUID(), f.branch, method, 1000, key, key.toUpperCase(), institution, other, sale.id, f.users[0]!.id];
      await withProbe(async ({ client, expectOk, expectViolation }) => {
        await expectOk('QR without institution', insert, row('QR', 'QR111111'));
        await expectViolation('QR with an institution', insert, row('QR', 'QR222222', 'GALICIA'), '23514', 'chk_ec_institution');
        await expectViolation('QR with a label', insert, row('QR', 'QR333333', null, 'Otra'), '23514', 'chk_ec_institution');
        await expectViolation('QR with OTHER and a label', insert, row('QR', 'QR333334', 'OTHER', 'Otra'), '23514', 'chk_ec_institution');
        await client.query(insert, row('QR', 'QR444444'));
        await expectViolation('duplicate QR reference on the branch', insert, row('QR', 'QR444444'), '23505', 'ExternalCollection_qr_ref_key');
        await expectOk('the same key as a credit is another namespace', insert, row('CARD_CREDIT', 'QR444444'));
        await expectOk('the same key as a debit is another namespace', insert, row('CARD_DEBIT', 'QR444444'));
        await expectOk('the same key on another branch is fine', insert.replace('$2', '$2'), [randomUUID(), f.branch, 'CARD_CREDIT', 1000, 'ZZ9', 'ZZ9ZZ9', null, null, sale.id, f.users[0]!.id]);
        // The existing collections keep their rules: a transfer still needs its institution, a card never has one.
        await expectViolation('TRANSFER without institution', insert, row('TRANSFER', 'QR555555'), '23514', 'chk_ec_institution');
        await expectViolation('CARD_DEBIT with an institution', insert, row('CARD_DEBIT', 'QR666666', 'BBVA'), '23514', 'chk_ec_institution');
      });
    });

    it('QRPG-12 SalePayment shape: a PROPORTIONAL_V1 QR payment is external (collection, no received/change)', async () => {
      const f = await fixture();
      const sale = await f.sale();
      const collection = await db.externalCollection.create({
        data: { branchId: f.branch, method: 'QR', amount: 1000n, reference: `QRPG12${f.tag}`, referenceKey: normalizeReferenceKey(`QRPG12${f.tag}`), status: 'UNAPPLIED', originSaleId: sale.id, recordedById: f.users[0]!.id },
      });
      const insert = `INSERT INTO "SalePayment"
        ("id","saleId","method","amount","receivedAmount","changeAmount","idempotencyKey","pricingModel","checkoutId","tenderRole","methodFullPrice","adjustmentBps","externalCollectionId","cashSessionId")
        VALUES ($1,$2,'QR'::"PaymentMethod",$3,$4,$5,$6,'PROPORTIONAL_V1'::"SalePricingModel",$7,'BALANCE'::"CheckoutTenderRole",$8,$9,$10,$11)`;
      const row = (patch: Partial<Record<'received' | 'change' | 'collection' | 'checkout', string | number | null>> = {}) => [
        randomUUID(), sale.id, 1000, patch.received ?? null, patch.change ?? null, randomUUID(), patch.checkout === undefined ? randomUUID() : patch.checkout,
        1000, 1200, patch.collection === undefined ? collection.id : patch.collection, f.session.id,
      ];
      // The row CHECK runs before any foreign key: a shape it accepts then fails ONLY on the checkout FK (23503).
      await withProbe(async ({ expectViolation }) => {
        await expectViolation('a QR proportional shape is accepted by the CHECK (the unknown checkout then fails the FK)', insert, row(), '23503', 'SalePayment_checkout_fkey');
        await expectViolation('proportional QR without an external collection', insert, row({ collection: null }), '23514', 'chk_payment_checkout_shape');
        await expectViolation('proportional QR with a received amount', insert, row({ received: 1000, change: 0 }), '23514', 'chk_payment_checkout_shape');
        await expectViolation('proportional QR without a checkout', insert, row({ checkout: null }), '23514', 'chk_payment_checkout_shape');
      });
    });
  });
});
