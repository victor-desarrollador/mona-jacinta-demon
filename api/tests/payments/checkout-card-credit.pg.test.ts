// CARD_CREDIT inside PROPORTIONAL_V1 on a REAL PostgreSQL (OWNER block). OPT-IN ONLY:
// it needs the DISPOSABLE, isolated LOCAL_TEST cluster with migrations 1–12 (the
// CARD_CREDIT migration 20261021120000_r3_card_credit applied) and the canonical
// baseline catalog (an oldest Company and at least one ProductVariant), bound by
// marker + system id:
//   MONA_R3_CC_PG=1 MONA_R3_CC_PG_DISPOSABLE=1 MONA_TEST_DATABASE_TARGET=local
//   LOCAL_TEST_DATABASE_URL=… LOCAL_TEST_DATABASE_MARKER_ID=…
//   MONA_R3_PG_SYSTEM_ID=<pg_control_system().system_identifier of THAT cluster>
// Writes are COMMITTED and PERMANENT by design (F1 forbids deleting a CheckoutAttempt,
// F6 an ExternalCollection): the cluster is discarded afterwards, never reused.
//
// What only PostgreSQL proves: the real reserve → settle of a plan that carries
// CARD_CREDIT (retail and wholesale) with the sealed credit snapshot, the new SQL
// CHECKs and the credit reference index, a genuine overlap of two confirmations, and
// that rows written exactly as an N-1 API writes them (version 1, no credit columns)
// are still valid next to the new ones.
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../src/generated/prisma/client.js';
import { normalizeReferenceKey, type PlanTenderInput } from '../../src/modules/payments/checkout-canonical.js';
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

const enabled = process.env.MONA_R3_CC_PG === '1';

const BASE = 10000n; // one line, one unit, $100,00 cash base
const CREDIT_BPS = 1500; // the fixture sets the company credit adjustment to +15%
const CREDIT_FULL = 11500n; // 10000 * 1,15 (hand computed, never from the module)

type Lines = Array<{ saleItemId: string; sku: string; quantity: bigint; baseUnitPrice: bigint }>;

describe.skipIf(!enabled)('CARD_CREDIT — proportional checkout on PostgreSQL (migrations 1–12, disposable cluster)', () => {
  const pools: Pool[] = [];
  const clients: PrismaClient[] = [];
  let db: PrismaClient;

  beforeAll(async () => {
    if (process.env.MONA_R3_CC_PG_DISPOSABLE !== '1') throw new Error('CC PG tests write permanent rows: MONA_R3_CC_PG_DISPOSABLE=1 is required');
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
              EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'CheckoutAttempt' AND column_name = 'fullPriceCredit') AS ok
       FROM pg_control_system()`);
    if (rows[0]?.system_id !== expectedSystemId) throw new Error('isolated PostgreSQL cluster does not match binding');
    if (rows[0]?.ok !== true) throw new Error('the CARD_CREDIT migration (12) is required');
    db = clients[0]!;
    const company = await db.company.findFirstOrThrow({ orderBy: { createdAt: 'asc' }, select: { id: true } });
    await db.companyPricingConfig.upsert({
      where: { companyId: company.id },
      create: { companyId: company.id, bankTransferAdjustmentBps: 200, debitCardAdjustmentBps: 300, creditCardAdjustmentBps: CREDIT_BPS },
      update: { creditCardAdjustmentBps: CREDIT_BPS },
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
    await db.location.create({ data: { id: branch, companyId: company.id, code: `ccpg-${tag}`, name: `CC ${tag}`, type: 'RETAIL_BRANCH', address: 'Test', pointOfSaleNumber: pointOfSaleNumberFor('CC', tag) } });
    await db.branch.create({ data: { id: branch, code: `ccpg-${tag}`, name: `CC ${tag}`, address: 'Test', pointOfSaleNumber: 1 } });
    const users = await Promise.all([0, 1].map((n) => db.user.create({ data: { name: `CC ${n}`, email: `ccpg-${tag}-${n}@test.invalid`, passwordHash: 'not-used' } })));
    const register = await db.cashRegister.create({ data: { branchId: branch, name: `CC ${tag}` } });
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
          saleId: created.id, variantId: variant.id, productId: variant.productId, productName: 'CC', variantName: 'CC', sku: variant.sku,
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
    if (snapshot.id === null) throw new Error('CC fixture: the company pricing configuration is missing');
    return {
      bankTransferAdjustmentBps: snapshot.adjustmentsBps.BANK_TRANSFER!,
      debitCardAdjustmentBps: snapshot.adjustmentsBps.DEBIT_CARD!,
      creditCardAdjustmentBps: snapshot.adjustmentsBps.CREDIT_CARD!,
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
  const refTender = (method: 'CARD_CREDIT' | 'CARD_DEBIT', reference: string) =>
    tender(method, { reference, referenceKey: normalizeReferenceKey(reference) });
  const confirmation = (view: { reserveKey: string; operationKey: string }, tenders: CheckoutConfirmationTender[]): CheckoutConfirmationRequest =>
    ({ reserveKey: view.reserveKey, operationKey: view.operationKey, tenders, supervisor: null });

  const allocationsAddUp = async (saleId: string) => {
    for (const payment of await db.salePayment.findMany({ where: { saleId } })) {
      const sum = (await db.saleLineAllocation.findMany({ where: { salePaymentId: payment.id } })).reduce((total, row) => total + row.amount, 0n);
      expect(sum, `allocations of ${payment.method}`).toBe(payment.amount);
    }
  };

  it('CCPG-01 simple credit: reserve seals the credit snapshot (version 3 since the QR migration) and the settlement writes one referenced CARD_CREDIT payment', async () => {
    const f = await fixture();
    const sale = await f.sale();
    await f.inventory(10n, 1n);
    const request = await plan(sale.lines, f.session.id, 'CARD_CREDIT');
    expect(request.expectedTotal).toBe(CREDIT_FULL);
    const { view } = await reserve(db, f.users[0]!.id, f.branch, sale.id, request);

    const attempt = await db.checkoutAttempt.findUniqueOrThrow({ where: { reserveKey: view.reserveKey } });
    expect(attempt).toMatchObject({ balanceMethod: 'CARD_CREDIT', fullPriceCredit: CREDIT_FULL, creditAdjustmentBps: CREDIT_BPS, algorithmVersion: 3, expectedTotal: CREDIT_FULL });
    expect(view.plan.fullPrices.CARD_CREDIT).toBe(CREDIT_FULL);

    const reference = `CCPG1${f.tag}`;
    const result = await checkoutService(db).checkout(
      actor(f.users[0]!.id, 'CASHIER', f.branch) as never, f.users[0]!.id, sale.id, confirmation(view, [refTender('CARD_CREDIT', reference)]));
    expect(result).toMatchObject({ saleId: sale.id, status: 'COMPLETED', replayed: false, total: CREDIT_FULL, changeAmount: 0n });

    const payments = await db.salePayment.findMany({ where: { saleId: sale.id } });
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({
      method: 'CARD_CREDIT', tenderRole: 'BALANCE', amount: CREDIT_FULL, methodFullPrice: CREDIT_FULL, adjustmentBps: CREDIT_BPS,
      receivedAmount: null, changeAmount: null, pricingModel: 'PROPORTIONAL_V1',
    });
    const collection = await db.externalCollection.findUniqueOrThrow({ where: { id: payments[0]!.externalCollectionId! } });
    expect(collection).toMatchObject({ method: 'CARD_CREDIT', amount: CREDIT_FULL, referenceKey: normalizeReferenceKey(reference), institution: null, institutionOther: null, status: 'APPLIED' });
    expect(await db.saleCheckout.findUniqueOrThrow({ where: { saleId: sale.id } }))
      .toMatchObject({ balanceMethod: 'CARD_CREDIT', fullPriceCredit: CREDIT_FULL, creditAdjustmentBps: CREDIT_BPS, algorithmVersion: 3, total: CREDIT_FULL });
    await allocationsAddUp(sale.id);
    expect(await db.cashMovement.count({ where: { sessionId: f.session.id, type: 'SALE_INCOME' } })).toBe(0);
    expect(await db.inventory.findFirstOrThrow({ where: { variantId: f.variant.id, branchId: f.branch } })).toMatchObject({ physical: 9n, reserved: 0n });
    expect(await db.stockReservation.count({ where: { saleId: sale.id, status: 'CONSUMED' } })).toBe(1);
  });

  it('CCPG-02 combined CASH fixed + CARD_CREDIT balance: exact amounts, change on the cash tender, allocations add up', async () => {
    const f = await fixture();
    const sale = await f.sale();
    await f.inventory(10n, 1n);
    // balance = 11.500 * (10.000 - 4.000) / 10.000 = 6.900 ; total = 10.900
    const request = await plan(sale.lines, f.session.id, 'CARD_CREDIT', [{ method: 'CASH', amount: 4000n }]);
    expect(request.expectedBalanceAmount).toBe(6900n);
    expect(request.expectedTotal).toBe(10900n);
    const { view } = await reserve(db, f.users[0]!.id, f.branch, sale.id, request);
    const result = await checkoutService(db).checkout(actor(f.users[0]!.id, 'CASHIER', f.branch) as never, f.users[0]!.id, sale.id,
      confirmation(view, [tender('CASH', { receivedAmount: 5000n }), refTender('CARD_CREDIT', `CCPG2${f.tag}`)]));
    expect(result).toMatchObject({ status: 'COMPLETED', total: 10900n, changeAmount: 1000n });
    const payments = (await db.salePayment.findMany({ where: { saleId: sale.id } })).sort((a, b) => (a.method < b.method ? -1 : 1));
    expect(payments.map((payment) => [payment.method, payment.amount, payment.tenderRole, payment.adjustmentBps]))
      .toEqual([['CARD_CREDIT', 6900n, 'BALANCE', CREDIT_BPS], ['CASH', 4000n, 'FIXED', 0]]);
    expect(payments.reduce((sum, payment) => sum + payment.amount, 0n)).toBe(10900n);
    await allocationsAddUp(sale.id);
    expect(await db.cashMovement.count({ where: { sessionId: f.session.id, type: 'SALE_INCOME' } })).toBe(1);
  });

  it('CCPG-03 combined CARD_DEBIT fixed + CARD_CREDIT balance: two distinct referenced collections', async () => {
    const f = await fixture();
    const sale = await f.sale();
    await f.inventory(10n, 1n);
    const request = await plan(sale.lines, f.session.id, 'CARD_CREDIT', [{ method: 'CARD_DEBIT', amount: 3090n }]);
    const { view } = await reserve(db, f.users[0]!.id, f.branch, sale.id, request);
    const result = await checkoutService(db).checkout(actor(f.users[0]!.id, 'CASHIER', f.branch) as never, f.users[0]!.id, sale.id,
      confirmation(view, [refTender('CARD_DEBIT', `CCPG3D${f.tag}`), refTender('CARD_CREDIT', `CCPG3C${f.tag}`)]));
    expect(result).toMatchObject({ status: 'COMPLETED', total: request.expectedTotal });
    const collections = await db.externalCollection.findMany({ where: { appliedSaleId: sale.id } });
    expect(collections.map((row) => row.method).sort()).toEqual(['CARD_CREDIT', 'CARD_DEBIT']);
    await allocationsAddUp(sale.id);
    expect((await db.salePayment.findMany({ where: { saleId: sale.id } })).reduce((sum, payment) => sum + payment.amount, 0n)).toBe(request.expectedTotal);
  });

  it('CCPG-04 wholesale: credit is priced on the wholesale base and the confirmed wholesale sale settles', async () => {
    const f = await fixture({ wholesale: true });
    const sale = await f.sale(8000n); // wholesale base $80,00 -> credit 8.000 * 1,15 = 9.200
    await f.inventory(10n, 1n);
    const request = await plan(sale.lines, f.session.id, 'CARD_CREDIT');
    expect(request.expectedTotal).toBe(9200n);
    const { view } = await reserve(db, f.users[0]!.id, f.branch, sale.id, request);
    const result = await checkoutService(db).checkout(actor(f.users[0]!.id, 'CASHIER', f.branch) as never, f.users[0]!.id, sale.id,
      confirmation(view, [refTender('CARD_CREDIT', `CCPG4${f.tag}`)]));
    expect(result).toMatchObject({ status: 'COMPLETED', total: 9200n });
    expect(await db.saleCheckout.findUniqueOrThrow({ where: { saleId: sale.id } })).toMatchObject({ fullPriceCash: 8000n, fullPriceCredit: 9200n, creditAdjustmentBps: CREDIT_BPS });
  });

  it('CCPG-05 two overlapping confirmations of the same CARD_CREDIT attempt: exactly one settlement, the other replays', async () => {
    const f = await fixture();
    const sale = await f.sale();
    await f.inventory(10n, 1n);
    const { view } = await reserve(db, f.users[0]!.id, f.branch, sale.id, await plan(sale.lines, f.session.id, 'CARD_CREDIT'));
    const request = confirmation(view, [refTender('CARD_CREDIT', `CCPG5${f.tag}`)]);
    const services = [checkoutService(clients[1]!), checkoutService(clients[2]!)];
    const coordinator = await holdRowLock(pools[0]!, 'Sale', sale.id);
    let race: Promise<PromiseSettledResult<CheckoutResult>[]> | undefined;
    try {
      race = Promise.allSettled(services.map((service) => service.checkout(actor(f.users[0]!.id, 'CASHIER', f.branch) as never, f.users[0]!.id, sale.id, request)));
      await waitForBlocked(pools[0]!, coordinator.pid, 2, /FROM "Sale" WHERE id = \$1 FOR UPDATE/);
    } finally {
      await coordinator.release();
    }
    const results = await withTimeout(race!, RACE_TIMEOUT_MS, 'CCPG-05 confirmations');
    expect(results.filter((result) => result.status === 'rejected')).toEqual([]);
    const settled = results as PromiseFulfilledResult<CheckoutResult>[];
    expect(settled.map((result) => result.value.replayed).sort()).toEqual([false, true]);
    expect(await db.salePayment.count({ where: { saleId: sale.id } })).toBe(1);
    expect(await db.saleCheckout.count({ where: { saleId: sale.id } })).toBe(1);
    expect(await db.externalCollection.count({ where: { appliedSaleId: sale.id, method: 'CARD_CREDIT' } })).toBe(1);
    expect(await db.inventory.findFirstOrThrow({ where: { variantId: f.variant.id, branchId: f.branch } })).toMatchObject({ physical: 9n, reserved: 0n });
  });

  it('CCPG-06 a credit reference is unique per branch in its own namespace: it never collides with a debit reference', async () => {
    const f = await fixture();
    const [saleA, saleB, saleC] = [await f.sale(), await f.sale(), await f.sale()];
    await f.inventory(10n, 3n);
    const shared = `CCPG6${f.tag}`;
    const settle = async (sale: typeof saleA, method: 'CARD_CREDIT' | 'CARD_DEBIT') => {
      const { view } = await reserve(db, f.users[0]!.id, f.branch, sale.id, await plan(sale.lines, f.session.id, method));
      return codeOf(checkoutService(db).checkout(actor(f.users[0]!.id, 'CASHIER', f.branch) as never, f.users[0]!.id, sale.id, confirmation(view, [refTender(method, shared)])));
    };
    expect(await settle(saleA, 'CARD_CREDIT')).toBeNull();
    expect(await settle(saleB, 'CARD_DEBIT')).toBeNull(); // same reference as a DEBIT: a different namespace
    expect(await settle(saleC, 'CARD_CREDIT')).toBe('EXTERNAL_REFERENCE_ALREADY_RECORDED');
    expect(await db.externalCollection.count({ where: { branchId: f.branch, referenceKey: normalizeReferenceKey(shared) } })).toBe(2);
  });

  it('CCPG-10 closing a RESERVED attempt that carried a NEW CARD_CREDIT tender records it CHARGED as one UNAPPLIED credit collection', async () => {
    const f = await fixture();
    const sale = await f.sale();
    await f.inventory(10n, 1n);
    const request = await plan(sale.lines, f.session.id, 'CASH', [{ method: 'CARD_CREDIT', amount: 3000n }]);
    const { view } = await reserve(db, f.users[0]!.id, f.branch, sale.id, request);
    const reference = `CCPG10${f.tag}`;
    const row = (method: CheckoutDeclarationRow['method'], patch: Partial<CheckoutDeclarationRow> = {}): CheckoutDeclarationRow => ({
      method, outcome: 'NONE', returnedAmount: null, amount: null, reference: null, referenceKey: null, institution: null, institutionOther: null, evidence: null, ...patch,
    });
    const result = await createCheckoutCloseService(db).close(actor(f.users[0]!.id, 'CASHIER', f.branch) as never, sale.id, view.reserveKey, {
      supervisor: null,
      declarations: [row('CASH'), row('CARD_CREDIT', { outcome: 'CHARGED', amount: 3000n, reference, referenceKey: normalizeReferenceKey(reference), evidence: 'comprobante 0010' })],
    });
    expect(result).toMatchObject({ replayed: false, checkout: null, view: { status: 'ABANDONED', declared: true } });
    const attempt = await db.checkoutAttempt.findUniqueOrThrow({ where: { reserveKey: view.reserveKey } });
    const collections = await db.externalCollection.findMany({ where: { originAttemptId: attempt.id } });
    expect(collections).toHaveLength(1);
    expect(collections[0]).toMatchObject({ method: 'CARD_CREDIT', amount: 3000n, status: 'UNAPPLIED', institution: null, institutionOther: null, referenceKey: normalizeReferenceKey(reference) });
    expect(await db.checkoutAttemptDeclaration.findFirstOrThrow({ where: { attemptId: attempt.id, method: 'CARD_CREDIT' } }))
      .toMatchObject({ outcome: 'CHARGED', externalCollectionId: collections[0]!.id });
    // The close touches neither cash nor stock, as for any other external method.
    expect(await db.salePayment.count({ where: { saleId: sale.id } })).toBe(0);
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
       "tenderCount","fullPriceCash","fullPriceTransfer","fullPriceDebit","fullPriceCredit","transferAdjustmentBps","debitAdjustmentBps","creditAdjustmentBps",
       "pricingConfigId","pricingConfigUpdatedAt","algorithmVersion","startedById")
      VALUES ($1,$2,$3,$4,$5,repeat('a',64),$6,$7::"PaymentMethod",$8,$8,1,10000,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`;

    it('CCPG-07 the credit snapshot CHECK: version 1 has none; version 2 has it exactly when the config snapshot exists; a credit balance needs it', async () => {
      const f = await fixture();
      const sale = await f.sale();
      const config = await db.companyPricingConfig.findFirstOrThrow();
      const row = (overrides: Partial<Record<string, unknown>> = {}) => {
        const v = {
          balanceMethod: 'CASH', transfer: 10200, debit: 10300, credit: null, tBps: 200, dBps: 300, cBps: null,
          cfg: config.id, cfgAt: config.updatedAt, version: 1, ...overrides,
        };
        return [randomUUID(), sale.id, f.branch, randomUUID(), randomUUID(), f.session.id, v.balanceMethod, 10000, v.transfer, v.debit, v.credit, v.tBps, v.dBps, v.cBps, v.cfg, v.cfgAt, v.version, f.users[0]!.id];
      };
      await withProbe(async ({ expectOk, expectViolation }) => {
        // N-1 shape: version 1, credit columns omitted (NULL) — still valid.
        await expectOk('legacy v1 without credit', ATTEMPT_SQL, row());
        await expectOk('v2 with the full snapshot', ATTEMPT_SQL, row({ version: 2, credit: 11500, cBps: 1500 }));
        await expectOk('v2 without any config snapshot', ATTEMPT_SQL, row({ version: 2, transfer: null, debit: null, tBps: null, dBps: null, cfg: null, cfgAt: null }));
        await expectOk('CARD_CREDIT balance with its credit price', ATTEMPT_SQL, row({ version: 2, balanceMethod: 'CARD_CREDIT', credit: 11500, cBps: 1500 }));
        await expectViolation('v1 with a credit price', ATTEMPT_SQL, row({ version: 1, credit: 11500, cBps: 1500 }), '23514', 'chk_attempt_credit_snapshot');
        await expectViolation('v2 with the config snapshot but no credit', ATTEMPT_SQL, row({ version: 2 }), '23514', 'chk_attempt_credit_snapshot');
        await expectViolation('credit price without its bps', ATTEMPT_SQL, row({ version: 2, credit: 11500, cBps: null }), '23514', 'chk_attempt_credit_snapshot');
        await expectViolation('credit price not a whole peso', ATTEMPT_SQL, row({ version: 2, credit: 11550, cBps: 1500 }), '23514', 'chk_attempt_credit_snapshot');
        await expectViolation('credit bps out of range', ATTEMPT_SQL, row({ version: 2, credit: 11500, cBps: 10001 }), '23514', 'chk_attempt_credit_snapshot');
        await expectViolation('CARD_CREDIT balance without a credit price', ATTEMPT_SQL, row({ version: 2, balanceMethod: 'CARD_CREDIT', transfer: null, debit: null, tBps: null, dBps: null, cfg: null, cfgAt: null }), '23514', 'chk_attempt_credit_snapshot');
        await expectViolation('unknown algorithm version', ATTEMPT_SQL, row({ version: 4, transfer: null, debit: null, tBps: null, dBps: null, cfg: null, cfgAt: null }), '23514', 'chk_attempt_plan');
        // QR is a valid plan method since the QR migration; without its QR price it is refused by the QR snapshot CHECK.
        await expectViolation('QR as a balance method without a QR price', ATTEMPT_SQL, row({ balanceMethod: 'QR' }), '23514', 'chk_attempt_qr_snapshot');
      });
    });

    it('CCPG-08 the sealed credit snapshot is immutable (F1) and CARD_CREDIT is a valid attempt tender', async () => {
      const f = await fixture();
      const sale = await f.sale();
      await f.inventory(10n, 1n);
      const { view } = await reserve(db, f.users[0]!.id, f.branch, sale.id, await plan(sale.lines, f.session.id, 'CARD_CREDIT'));
      const attempt = await db.checkoutAttempt.findUniqueOrThrow({ where: { reserveKey: view.reserveKey } });
      expect(attempt.fullPriceCredit).toBe(CREDIT_FULL);
      await withProbe(async ({ expectViolation }) => {
        await expectViolation('credit price update', `UPDATE "CheckoutAttempt" SET "fullPriceCredit" = 20000 WHERE id = $1`, [attempt.id], '23514');
        await expectViolation('credit bps update', `UPDATE "CheckoutAttempt" SET "creditAdjustmentBps" = 0 WHERE id = $1`, [attempt.id], '23514');
      });
      expect(await db.checkoutAttemptTender.findMany({ where: { attemptId: attempt.id } })).toMatchObject([{ method: 'CARD_CREDIT', role: 'BALANCE', source: 'NEW' }]);
    });

    it('CCPG-09 ExternalCollection: a credit collection has a reference and no institution, and its reference is unique per branch', async () => {
      const f = await fixture();
      const sale = await f.sale();
      const insert = `INSERT INTO "ExternalCollection"
        ("id","branchId","method","amount","reference","referenceKey","institution","institutionOther","status","originSaleId","recordedById")
        VALUES ($1,$2,$3::"PaymentMethod",$4,$5,$6,$7::"TransferInstitution",$8,'UNAPPLIED',$9,$10)`;
      const row = (method: string, key: string, institution: string | null = null, other: string | null = null) =>
        [randomUUID(), f.branch, method, 1000, key, key.toUpperCase(), institution, other, sale.id, f.users[0]!.id];
      await withProbe(async ({ client, expectOk, expectViolation }) => {
        await expectOk('credit without institution', insert, row('CARD_CREDIT', 'CRD11111'));
        await expectViolation('credit with an institution', insert, row('CARD_CREDIT', 'CRD22222', 'GALICIA'), '23514', 'chk_ec_institution');
        await expectViolation('credit with a label', insert, row('CARD_CREDIT', 'CRD33333', null, 'Otra'), '23514', 'chk_ec_institution');
        await client.query(insert, row('CARD_CREDIT', 'CRD44444'));
        await expectViolation('duplicate credit reference on the branch', insert, row('CARD_CREDIT', 'CRD44444'), '23505', 'ExternalCollection_credit_ref_key');
        await expectOk('the same key as a debit is another namespace', insert, row('CARD_DEBIT', 'CRD44444'));
        await expectOk('QR is an external collection since the QR migration (reference, no institution)', insert, row('QR', 'CRD55555'));
        await expectViolation('QR with an institution', insert, row('QR', 'CRD66666', 'GALICIA'), '23514', 'chk_ec_institution');
      });
    });
  });
});
