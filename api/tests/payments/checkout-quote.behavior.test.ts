// R3-A4.1 (R3 rev. 2 §5 "POST /sales/:saleId/checkout/quote") — DB-FREE suite.
//
// The REAL quote service, the REAL checkout quote DTO and the REAL payments
// router run against an in-memory double built on tests/helpers/in-memory-sales-db.ts
// (sales/cash/audit subset) plus the ONE R3 table the helper does not model and
// the quote reads: ExternalCollection (read-only). No query reaches a database.
//
// The quote is a READ-ONLY projection of the same pricing authority the real
// checkout uses: it must reuse the R3-A1 engine (never a second pricing model),
// take every price from the PERSISTED sale, and leave no row and no lock behind.
//
// FIDELITY LIMITS (documented for reviewers):
//   * `$transaction` runs callbacks serially; it models neither RepeatableRead
//     nor a real snapshot, so "no lock" is proven STRUCTURALLY (zero raw query,
//     no FOR UPDATE in the source) and not by a real planner.
//   * The fake returns every column of the ExternalCollection row regardless of
//     the service's `select`, so the response mapping is asserted to pick fields
//     explicitly (no referenceKey/status leak).
//   * PostgreSQL-only guarantees are NOT proven here: real RepeatableRead
//     snapshots, real CHECK/partial-index enforcement, real concurrent /checkout
//     interleavings.
//
// PRE-REGISTERED EXPECTATIONS (written before checkout-quote.service.ts existed)
//   Fixture: 2 lines, CASH base 20000 + 30000 = 50000; TRANSFER +1000 bps
//            -> 55000; CARD_DEBIT +500 bps -> 52500.
//   F1 balance CASH, no fixed      -> total 50000, balance 50000, lines [20000, 30000]
//   F2 balance TRANSFER            -> total 55000, balance 55000, lines [22000, 33000]
//   F3 balance CARD_DEBIT          -> total 52500, balance 52500, lines [21000, 31500]
//   F4 enabledMethods              -> CASH/TRANSFER/CARD_DEBIT, all available
//   F5 CASH 20000 fixed + CARD_DEBIT balance -> balance 31500, total 51500,
//                                     lines [8000+12600, 12000+18900] = [20600, 30900]
//   C1 CASH 20037 cents fixed + TRANSFER balance -> CASH allocated exactly
//                                     [8015, 12022] (Hamilton residue to line 1),
//                                     balance 33000 (rounded to the peso),
//                                     total 53037, lines [21215, 31822]
//   C2 FIXED_TENDERS_COVER_SALE when the fixed transfer is the whole 55000
//   C3 BALANCE_TOO_SMALL when the rounded balance lands under one peso
//   S1 unappliedCollections: exactly {id, method, amount, reference, institution,
//                                     institutionOther}, nothing else
//   S2 reservationExpiresAt: earliest ACTIVE hold; null when none
//   S3 the answer builds a /checkout request the real DTO accepts
//   P1 no SALE_CHARGE at the branch -> 403  P2 SALE_CHARGE elsewhere -> 403
//   P3 SALE_CHARGE without SALE_COMPLETE -> ALLOWED (the quote is lighter)
//   P4 the route gate itself demands SALE_CHARGE -> 403
//   R1 FIXED_TOTAL -> 409 INVALID_SALE_STATE (the approved sibling code)
//   R2 not PENDING_PAYMENT / R3 payment history -> 409 INVALID_SALE_STATE
//   R4 unknown sale -> 404
//   R5 LIST price mode / R6 line base mismatch / R7 no lines -> 409 snapshot
//   R8 WHOLESALE unconfirmed -> 409 WHOLESALE_CONFIRMATION_REQUIRED
//   R9 engine rules reused: DUPLICATE_TENDER_METHOD, BALANCE_METHOD_ALSO_FIXED,
//      PAYMENT_METHOD_NOT_ENABLED, AMOUNT_OVERFLOW
//   R10 no pricing config -> only CASH available; a non-CASH tender -> 409
//   N1/N2 no SalePayment/SaleCheckout/SaleLineAllocation/ExternalCollection/
//         CashMovement/StockMovement/AuditLog row, no reservation consumed,
//         no raw query at all, after a success and after every rejection
//   N3 no Socket.IO event over the real route
//   H1 200 + the exact JSON shape, money as decimal strings
//   H2 DTO 400s: CARD_CREDIT, QR, amount '0', three tenders, unknown key,
//      non-uuid saleId, missing balanceMethod
//   H3 the service reads NO other request field than balanceMethod/tenders, and
//      no price ever comes from the client
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import express, { type Request } from 'express';
import supertest from 'supertest';
import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { parseEnv } from '../../src/config/env.js';
import { AppError } from '../../src/shared/errors.js';
import { errorHandler } from '../../src/middleware/errorHandler.js';
import { DEFAULT_ROLE_GRANTS } from '../../src/modules/rbac/role-permission-matrix.js';
import { PRODUCTION_PERMISSIONS } from '../../src/modules/rbac/permissions.js';
import { createSalesService } from '../../src/modules/sales/sales.service.js';
import { createPaymentsRouter } from '../../src/modules/payments/payments.routes.js';
import {
  createCheckoutQuoteService,
  type CheckoutQuoteRequest,
} from '../../src/modules/payments/checkout-quote.service.js';
import { checkoutRequestDto } from '../../src/modules/payments/dto/checkout.dto.js';
import { createInMemorySalesDb, type Row } from '../helpers/in-memory-sales-db.js';

const QUOTE_SERVICE_SOURCE = readFileSync(new URL('../../src/modules/payments/checkout-quote.service.ts', import.meta.url), 'utf8');
const QUOTE_CONTROLLER_SOURCE = readFileSync(new URL('../../src/modules/payments/checkout-quote.controller.ts', import.meta.url), 'utf8');
const ROUTES_SOURCE = readFileSync(new URL('../../src/modules/payments/payments.routes.ts', import.meta.url), 'utf8');

const BRANCH = '11111111-1111-4111-8111-111111111111';
const OTHER_BRANCH = '99999999-9999-4999-8999-999999999999';

// S-REF.1: the minimum accepted environment, the SAME shape tests/env.test.ts
// and the composition in app.ts use. PROPORTIONAL_EXTERNAL_METHODS_ENABLED is
// deliberately ABSENT: the env default is what is under test.
const ENV_BASE = {
  DATABASE_URL: 'postgresql://test:test@demo.invalid:5432/bootstrap',
  TEST_DATABASE_URL: 'postgresql://test:test@test.invalid:5432/bootstrap',
  JWT_SECRET: 'synthetic-test-key-not-for-real-authentication',
  JWT_ACCESS_TTL_SECONDS: '900',
  CORS_ORIGINS: 'http://localhost:3000',
};

const RESPONSE_KEYS = [
  'balance', 'enabledMethods', 'fullPrices', 'lines', 'pricingModel', 'reservationExpiresAt',
  'saleId', 'saleNumber', 'tenders', 'total', 'unappliedCollections',
];

type Role = 'SELLER' | 'CASHIER' | 'WAREHOUSE';

function assignment(role: Role, locationId: string | null, permissions?: readonly string[]): Express.ProductionAssignment {
  return {
    roleId: role, roleCode: role,
    scopeKind: locationId ? 'LOCATION' : 'COMPANY', locationId,
    permissions: (permissions ?? (role === 'WAREHOUSE' ? DEFAULT_ROLE_GRANTS.WAREHOUSE : DEFAULT_ROLE_GRANTS[role])) as Express.ProductionAssignment['permissions'],
  };
}

function requestFor(userId: string, assignments: Express.ProductionAssignment[]): Request {
  const effectiveLocationIds = assignments.flatMap(({ locationId }) => (locationId ? [locationId] : []));
  return { auth: { userId, roles: assignments.map(({ roleCode }) => roleCode), assignments, effectiveLocationIds } } as unknown as Request;
}

// ---------------------------------------------------------------------------
// Double: the base store plus a read-only ExternalCollection table.
// ---------------------------------------------------------------------------
type AnyArgs = Record<string, unknown>;

function delegate(store: Row[]) {
  const where = (args: AnyArgs) => args.where as Record<string, unknown> | undefined;
  const matches = (row: Row, filter: Record<string, unknown> | undefined) => {
    if (!filter) return true;
    return Object.entries(filter).every(([key, value]) => (value === undefined ? true : row[key] === value));
  };
  return {
    findMany: async (args: AnyArgs = {}) => store.filter((row) => matches(row, where(args))).map((row) => ({ ...row })),
    findFirst: async (args: AnyArgs = {}) => store.filter((row) => matches(row, where(args))).map((row) => ({ ...row }))[0] ?? null,
    create: async (args: AnyArgs) => {
      const row: Row = { id: randomUUID(), ...(args.data as Row) };
      store.push(row);
      return { ...row };
    },
  };
}

function createQuoteDb() {
  const base = createInMemorySalesDb();
  const externalCollection: Row[] = [];
  (base.client as Record<string, unknown>).externalCollection = delegate(externalCollection);
  return { ...base, externalCollection };
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------
function setup(options: { pricing?: boolean; transferBps?: number; debitBps?: number; creditBps?: number; qrBps?: number } = {}) {
  const db = createQuoteDb();
  db.insert('company', { name: 'Mona Jacinta', cuit: '00000000000', address: 'Demo', isActive: true, createdAt: new Date() });
  const companyId = db.table('company')[0]!.id as string;
  if (options.pricing !== false) {
    db.insert('companyPricingConfig', {
      companyId,
      listAdjustmentBps: 0,
      bankTransferAdjustmentBps: options.transferBps ?? 1000,
      debitCardAdjustmentBps: options.debitBps ?? 500,
      creditCardAdjustmentBps: options.creditBps ?? 0,
      qrAdjustmentBps: options.qrBps ?? 0,
    });
  }
  db.insert('location', { id: BRANCH, isActive: true });
  db.insert('branch', { id: BRANCH, code: 'S1', name: 'Sucursal 1' });
  db.insert('saleNumberCounter', { branchId: BRANCH, nextValue: 1n });
  const user = (name: string) => db.insert('user', { name, email: `${name}@test.invalid`, isActive: true }).id as string;
  const ids = { seller: user('seller'), cashier: user('cashier'), warehouse: user('warehouse') };
  const product = db.insert('product', { name: 'Remera', isActive: true }).id as string;
  const variant = (cashPrice: bigint, sku: string) => db.insert('productVariant', {
    productId: product, sku, barcode: sku, cashPrice, price: cashPrice, wholesalePrice: null, costPrice: 1000n, color: 'Negro', size: sku,
  }).id as string;
  const V1 = variant(20000n, 'V1');
  const V2 = variant(30000n, 'V2');
  for (const variantId of [V1, V2]) db.insert('inventory', { branchId: BRANCH, variantId, physical: 100n, reserved: 0n });

  const reqs = {
    seller: requestFor(ids.seller, [assignment('SELLER', BRANCH)]),
    cashier: requestFor(ids.cashier, [assignment('CASHIER', BRANCH)]),
    cashierElsewhere: requestFor(ids.cashier, [assignment('CASHIER', OTHER_BRANCH)]),
    noCharge: requestFor(ids.warehouse, [assignment('WAREHOUSE', BRANCH)]),
    chargeOnly: requestFor(ids.warehouse, [assignment('CASHIER', BRANCH, [PRODUCTION_PERMISSIONS.SALE_CHARGE])]),
  };
  const client = db.client as unknown as PrismaClient;
  const sales = createSalesService(client, { proportionalCheckoutLocationIds: [BRANCH] });
  const quotes = createCheckoutQuoteService(client, { externalMethodsEnabled: true });

  const draft = async (options: { items?: Array<[string, bigint]> | null; send?: boolean } = {}) => {
    const created = await sales.createDraftSale(reqs.seller, ids.seller, BRANCH);
    for (const [variantId, quantity] of options.items ?? [[V1, 1n], [V2, 1n]] as Array<[string, bigint]>) {
      await sales.addItem(reqs.seller, ids.seller, created.id, { variantId, quantity });
    }
    if (options.send !== false) await sales.sendToCashier(created.id, ids.seller, [BRANCH]);
    return created.id;
  };
  // A row written straight into the store, for states the real services refuse
  // to produce (a FIXED_TOTAL sale, a PENDING_PAYMENT sale without lines, ...).
  const rawSale = (data: Row = {}) => db.insert('sale', {
    sellerId: ids.seller, branchId: BRANCH, status: 'PENDING_PAYMENT', saleNumber: `Q-${randomUUID()}`,
    subtotal: 50000n, discountTotal: 0n, total: 50000n, pricingMode: 'LIST', priceMode: 'CASH', pricingModel: 'PROPORTIONAL_V1',
    ...data,
  }).id as string;
  const saleRow = (saleId: string) => db.table('sale').find((row) => row.id === saleId)!;
  const linesOf = (saleId: string) => db.table('saleItem').filter((row) => row.saleId === saleId);
  const tables = () => db.allTables();
  const countRows = () => ({
    ...Object.fromEntries(Object.entries(tables()).map(([model, rows]) => [model, rows.length])),
    externalCollection: db.externalCollection.length,
  });
  const noFixed = (balanceMethod: CheckoutQuoteRequest['balanceMethod'] = 'CASH'): CheckoutQuoteRequest => ({ balanceMethod, tenders: [] });
  const cashFixed = (amount: bigint): CheckoutQuoteRequest => ({ balanceMethod: 'TRANSFER', tenders: [{ method: 'CASH', amount }] });
  return {
    db, ids, reqs, sales, quotes, V1, V2, draft, rawSale, saleRow, linesOf, countRows, noFixed, cashFixed,
    quote: (saleId: string, request: CheckoutQuoteRequest, req: Request = reqs.cashier) => quotes.quote(req, saleId, request),
    quoteOf: async (saleId: string) => quotes.quote(reqs.cashier, saleId, noFixed('CASH')),
  };
}

async function expectAppError(promise: Promise<unknown>, status: number, code: string) {
  const error = await promise.then(() => null, (cause: unknown) => cause);
  expect(error, `expected AppError ${status} ${code}`).toBeInstanceOf(AppError);
  expect({ status: (error as AppError).status, code: (error as AppError).code }).toEqual({ status, code });
}

// Line ids are random UUIDs, so the order is the persisted `id ASC` one, not the
// insertion order: the per-line amounts are asserted by sku, never by index.
function bySku(quote: { lines: Array<{ sku: string; finalAmount: bigint }> }) {
  return Object.fromEntries(quote.lines.map((line) => [line.sku, line.finalAmount]));
}

describe('F — the quote prices the same methods and amounts as the real checkout', () => {
  it('F1 balance CASH: no fixed tender, whole-peso lines, all three full prices', async () => {
    const t = setup();
    const saleId = await t.draft();
    const quote = await t.quoteOf(saleId);
    expect(quote).toMatchObject({
      saleId, saleNumber: t.saleRow(saleId).saleNumber, pricingModel: 'PROPORTIONAL_V1',
      fullPrices: { CASH: 50000n, TRANSFER: 55000n, CARD_DEBIT: 52500n, CARD_CREDIT: 50000n, QR: 50000n },
      tenders: [], balance: { method: 'CASH', amount: 50000n }, total: 50000n,
    });
    expect(bySku(quote)).toEqual({ V1: 20000n, V2: 30000n });
    expect(quote.lines.map((entry) => entry.sku).sort()).toEqual(['V1', 'V2']);
    expect(quote.lines.every((entry) => entry.quantity === 1n)).toBe(true);
    expect(quote.reservationExpiresAt).toBeInstanceOf(Date);
  });

  it('F2 balance TRANSFER carries the transfer adjustment', async () => {
    const t = setup();
    const quote = await t.quote(await t.draft(), t.noFixed('TRANSFER'));
    expect(quote).toMatchObject({ balance: { method: 'TRANSFER', amount: 55000n }, total: 55000n });
    expect(bySku(quote)).toEqual({ V1: 22000n, V2: 33000n });
  });

  it('F3 balance CARD_DEBIT carries the debit adjustment', async () => {
    const t = setup();
    const quote = await t.quote(await t.draft(), t.noFixed('CARD_DEBIT'));
    expect(quote).toMatchObject({ balance: { method: 'CARD_DEBIT', amount: 52500n }, total: 52500n });
    expect(bySku(quote)).toEqual({ V1: 21000n, V2: 31500n });
  });

  it('F4 enabledMethods lists the five proportional methods, all available', async () => {
    const t = setup();
    const quote = await t.quoteOf(await t.draft());
    expect(quote.enabledMethods).toEqual([
      { method: 'CASH', available: true },
      { method: 'TRANSFER', available: true },
      { method: 'CARD_DEBIT', available: true },
      { method: 'CARD_CREDIT', available: true },
      { method: 'QR', available: true },
    ]);
  });

  it('F5 one fixed tender plus a balance: the total is the sum of the parts', async () => {
    const t = setup();
    const saleId = await t.draft();
    const before = t.linesOf(saleId).map((row) => ({ ...row }));
    const quote = await t.quote(saleId, { balanceMethod: 'CARD_DEBIT', tenders: [{ method: 'CASH', amount: 20000n }] });
    expect(quote).toMatchObject({
      tenders: [{ method: 'CASH', role: 'FIXED', amount: 20000n }],
      balance: { method: 'CARD_DEBIT', amount: 31500n },
      total: 51500n,
    });
    expect(bySku(quote)).toEqual({ V1: 20600n, V2: 30900n });
    // The persisted sale is only read: its own snapshots and total never move.
    expect(t.linesOf(saleId)).toEqual(before);
    expect(t.saleRow(saleId).total).toBe(50000n);
  });
});

describe('C — centavos stay exact; the round-to-peso only applies to the computed part', () => {
  it('C1 a fixed tender with centavos is allocated exactly and the balance is rounded', async () => {
    const t = setup();
    const saleId = await t.draft();
    const quote = await t.quote(saleId, t.cashFixed(20037n));
    // Fixed money is carried to the centavo; only the computed balance is rounded.
    expect(quote.tenders).toEqual([{ method: 'CASH', role: 'FIXED', amount: 20037n }]);
    expect(quote).toMatchObject({ balance: { method: 'TRANSFER', amount: 33000n }, total: 53037n });
    // The Hamilton residue (one centavo) goes to the largest remainder.
    expect(bySku(quote)).toEqual({ V1: 21215n, V2: 31822n });
    expect(quote.lines.reduce((sum, entry) => sum + entry.finalAmount, 0n)).toBe(quote.total);
  });

  it('C1b every fixed centavo is preserved for each method of the request', async () => {
    const t = setup();
    const saleId = await t.draft();
    const quote = await t.quote(saleId, t.cashFixed(1n));
    expect(quote.tenders).toEqual([{ method: 'CASH', role: 'FIXED', amount: 1n }]);
    expect(quote.total % 100n).toBe(1n);
  });

  it('C2 fixed tenders that cover the sale are refused', async () => {
    const t = setup();
    await expectAppError(t.quote(await t.draft(), { balanceMethod: 'CASH', tenders: [{ method: 'TRANSFER', amount: 55000n }] }), 409, 'FIXED_TENDERS_COVER_SALE');
  });

  it('C3 a balance that rounds under one peso is refused', async () => {
    const t = setup();
    await expectAppError(t.quote(await t.draft(), { balanceMethod: 'CASH', tenders: [{ method: 'TRANSFER', amount: 54999n }] }), 409, 'BALANCE_TOO_SMALL');
  });

  it('C4 the engine normalises the whole-peso intermediate, not the tender', async () => {
    const t = setup();
    const quote = await t.quote(await t.draft(), t.cashFixed(10050n));
    expect(quote.total).toBe(quote.tenders[0]!.amount + quote.balance.amount);
    expect(quote.balance.amount % 100n).toBe(0n);
    expect(quote.balance.amount).toBeGreaterThanOrEqual(100n);
  });
});

describe('S — the answer carries everything a later checkout request needs', () => {
  it('S1 only the sale own UNAPPLIED collections of its branch are listed, with exactly the display fields', async () => {
    const t = setup();
    const saleId = await t.draft();
    const otherSaleId = await t.draft();
    const collection = (data: Record<string, unknown>) => ({
      reference: 'OP 88000', referenceKey: 'OP88000', amount: 11000n, method: 'TRANSFER',
      institution: 'GALICIA', institutionOther: null, appliedCheckoutId: null, appliedSaleId: null,
      createdAt: new Date(), ...data,
    });
    // The only one that must be listed: same sale, same branch, still UNAPPLIED.
    const included = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    t.db.externalCollection.push(collection({ id: included, originSaleId: saleId, branchId: BRANCH, status: 'UNAPPLIED', reference: 'OP 88123', referenceKey: 'OP88123' }));
    // Adversarial neighbours that must never appear.
    const applied = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    t.db.externalCollection.push(collection({ id: applied, originSaleId: saleId, branchId: BRANCH, status: 'APPLIED', reference: 'OP 88124' }));
    const otherSale = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    t.db.externalCollection.push(collection({ id: otherSale, originSaleId: otherSaleId, branchId: BRANCH, status: 'UNAPPLIED', reference: 'OP 88125' }));
    const otherBranch = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    t.db.externalCollection.push(collection({ id: otherBranch, originSaleId: saleId, branchId: OTHER_BRANCH, status: 'UNAPPLIED', reference: 'OP 88126' }));

    const quote = await t.quoteOf(saleId);
    expect(quote.unappliedCollections).toEqual([{
      id: included, method: 'TRANSFER', amount: 11000n,
      reference: 'OP 88123', institution: 'GALICIA', institutionOther: null,
    }]);
    // Nothing internal leaks: no reference key, no status, no origin sale.
    expect(Object.keys(quote.unappliedCollections[0]!).sort()).toEqual(['amount', 'id', 'institution', 'institutionOther', 'method', 'reference']);
    expect(quote.unappliedCollections[0]).not.toHaveProperty('referenceKey');
    // Nor does anything at all about an excluded collection reach the caller.
    const serialized = JSON.stringify(quote, (_key, value) => (typeof value === 'bigint' ? value.toString() : value));
    for (const excluded of [applied, otherSale, otherBranch, 'OP 88124', 'OP 88125', 'OP 88126', OTHER_BRANCH]) {
      expect(serialized).not.toContain(excluded);
    }
  });

  it('S2 reservationExpiresAt is the earliest ACTIVE hold and null without holds', async () => {
    const t = setup();
    const saleId = await t.draft();
    const holds = t.db.table('stockReservation').filter((row) => row.saleId === saleId && row.status === 'ACTIVE');
    expect(holds.length).toBeGreaterThan(0);
    const expected = new Date(Math.min(...holds.map((row) => (row.expiresAt as Date).getTime())));
    expect((await t.quoteOf(saleId)).reservationExpiresAt).toEqual(expected);

    // A quotable sale with a line but with no hold at all.
    const bare = t.rawSale();
    t.db.insert('saleItem', {
      saleId: bare, productId: t.db.table('product')[0]!.id, variantId: t.V1,
      productName: 'Remera', variantName: 'V1', sku: 'V1', quantity: 1n,
      unitPrice: 20000n, subtotal: 20000n, baseUnitPrice: 20000n,
      priceBaseType: 'LIST', priceMode: 'CASH', priceAdjustmentBps: 0,
    });
    expect(t.db.table('stockReservation').filter((row) => row.saleId === bare)).toEqual([]);
    expect((await t.quoteOf(bare)).reservationExpiresAt).toBeNull();
  });

  it('S3 the quote output builds a checkout request the real DTO accepts', async () => {
    const t = setup();
    const quote = await t.quote(await t.draft(), { balanceMethod: 'CARD_DEBIT', tenders: [{ method: 'CASH', amount: 20000n }] });
    const request = {
      operationKey: randomUUID(),
      cashSessionId: randomUUID(),
      balanceMethod: quote.balance.method,
      expectedTotal: quote.total.toString(),
      expectedBalanceAmount: quote.balance.amount.toString(),
      tenders: [
        { method: 'CASH', role: 'FIXED', amount: quote.tenders[0]!.amount.toString(), receivedAmount: '20000' },
        { method: 'CARD_DEBIT', role: 'BALANCE', reference: 'D009' },
      ],
    };
    const parsed = checkoutRequestDto.safeParse(request);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(parsed.data!.expectedTotal).toBe(quote.total);
    expect(parsed.data!.expectedBalanceAmount).toBe(quote.balance.amount);
  });

  it('S4 the response has exactly the approved keys', async () => {
    const t = setup();
    const quote = await t.quoteOf(await t.draft());
    expect(Object.keys(quote).sort()).toEqual(RESPONSE_KEYS);
    expect(Object.keys(quote.fullPrices).sort()).toEqual(['CARD_CREDIT', 'CARD_DEBIT', 'CASH', 'QR', 'TRANSFER']);
    expect(Object.keys(quote.balance).sort()).toEqual(['amount', 'method']);
  });
});

describe('P — permissions', () => {
  it('P1 a caller without SALE_CHARGE at the sale branch is refused', async () => {
    const t = setup();
    await expectAppError(t.quote(await t.draft(), t.noFixed(), t.reqs.noCharge), 403, 'FORBIDDEN');
  });

  it('P2 SALE_CHARGE in another branch is not enough', async () => {
    const t = setup();
    await expectAppError(t.quote(await t.draft(), t.noFixed(), t.reqs.cashierElsewhere), 403, 'FORBIDDEN');
  });

  it('P3 SALE_CHARGE alone is enough: the quote does not demand SALE_COMPLETE', async () => {
    const t = setup();
    const quote = await t.quote(await t.draft(), t.noFixed(), t.reqs.chargeOnly);
    expect(quote.total).toBe(50000n);
  });

  it('P4 the route itself demands SALE_CHARGE', async () => {
    const t = setup();
    const saleId = await t.draft();
    const { app } = httpHarness(t);
    const response = await supertest(app)
      .post(`/api/v1/sales/${saleId}/checkout/quote`)
      .set('X-Test-User', 'no-charge')
      .send({ balanceMethod: 'CASH', tenders: [] });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
  });
});

describe('R — a sale that is not quotable is refused with a stable code', () => {
  it('R1 a FIXED_TOTAL sale is refused with the approved sibling code', async () => {
    const t = setup();
    const saleId = await t.draft();
    t.saleRow(saleId).pricingModel = 'FIXED_TOTAL';
    await expectAppError(t.quoteOf(saleId), 409, 'INVALID_SALE_STATE');
  });

  it('R2 a sale that is not pending payment is refused', async () => {
    const t = setup();
    const saleId = await t.draft();
    t.saleRow(saleId).status = 'DRAFT';
    await expectAppError(t.quoteOf(saleId), 409, 'INVALID_SALE_STATE');
  });

  it('R3 a sale whose payment history already started is refused', async () => {
    const t = setup();
    const saleId = await t.draft();
    t.saleRow(saleId).paymentStartedAt = new Date();
    await expectAppError(t.quoteOf(saleId), 409, 'INVALID_SALE_STATE');
  });

  it('R4 an unknown sale is a 404', async () => {
    const t = setup();
    await expectAppError(t.quoteOf('77777777-7777-4777-8777-777777777777'), 404, 'NOT_FOUND');
  });

  it('R5 a line not priced in cash is an inconsistent snapshot', async () => {
    const t = setup();
    const saleId = await t.draft();
    t.linesOf(saleId)[0]!.priceMode = 'LIST';
    await expectAppError(t.quoteOf(saleId), 409, 'PRICING_SNAPSHOT_INCONSISTENT');
  });

  it('R6 a line whose base does not match the sale is an inconsistent snapshot', async () => {
    const t = setup();
    const saleId = await t.draft();
    t.linesOf(saleId)[0]!.priceBaseType = 'WHOLESALE';
    await expectAppError(t.quoteOf(saleId), 409, 'PRICING_SNAPSHOT_INCONSISTENT');
  });

  it('R7 a sale without lines is an inconsistent snapshot', async () => {
    const t = setup();
    await expectAppError(t.quoteOf(t.rawSale()), 409, 'PRICING_SNAPSHOT_INCONSISTENT');
  });

  it('R8 an unconfirmed WHOLESALE sale keeps its own code, like the checkout', async () => {
    const t = setup();
    const saleId = await t.draft();
    Object.assign(t.saleRow(saleId), { pricingMode: 'WHOLESALE', wholesaleConfirmedAt: null, wholesaleConfirmedById: null });
    await expectAppError(t.quoteOf(saleId), 409, 'WHOLESALE_CONFIRMATION_REQUIRED');
  });

  it('R9 the engine rules are reused rather than re-implemented', async () => {
    const t = setup();
    const saleId = await t.draft();
    await expectAppError(t.quote(saleId, { balanceMethod: 'CASH', tenders: [{ method: 'TRANSFER', amount: 1000n }, { method: 'TRANSFER', amount: 2000n }] }), 409, 'DUPLICATE_TENDER_METHOD');
    await expectAppError(t.quote(saleId, { balanceMethod: 'CASH', tenders: [{ method: 'CASH', amount: 1000n }] }), 409, 'BALANCE_METHOD_ALSO_FIXED');
    // The engine's own method guard is 400 (the approved A3.2 behaviour); the
    // HTTP edge rejects an unknown method earlier as 400 VALIDATION_ERROR. `as
    // never` models the out-of-enum value a JS consumer or a bad cast can hand
    // the engine, which is exactly what its public-boundary guard is for.
    await expectAppError(t.quote(saleId, { balanceMethod: 'PAYPAL' as never, tenders: [] }), 400, 'PAYMENT_METHOD_NOT_ENABLED');
    await expectAppError(t.quote(saleId, { balanceMethod: 'CASH', tenders: [{ method: 'TRANSFER', amount: 9223372036854775808n }] }), 409, 'AMOUNT_OVERFLOW');
  });

  it('R10 without a pricing configuration only CASH is available', async () => {
    const t = setup({ pricing: false });
    const saleId = await t.draft();
    const quote = await t.quoteOf(saleId);
    expect(quote.enabledMethods).toEqual([
      { method: 'CASH', available: true },
      { method: 'TRANSFER', available: false, reason: 'PRICING_CONFIG_MISSING' },
      { method: 'CARD_DEBIT', available: false, reason: 'PRICING_CONFIG_MISSING' },
      { method: 'CARD_CREDIT', available: false, reason: 'PRICING_CONFIG_MISSING' },
      { method: 'QR', available: false, reason: 'PRICING_CONFIG_MISSING' },
    ]);
    expect(quote.fullPrices).toEqual({ CASH: 50000n, TRANSFER: null, CARD_DEBIT: null, CARD_CREDIT: null, QR: null });
    expect(quote.total).toBe(50000n);
    await expectAppError(t.quote(saleId, t.noFixed('TRANSFER')), 409, 'PRICING_CONFIG_MISSING');
  });
});

describe('N — the quote has no side effect at all', () => {
  it('N1 a successful quote writes nothing, locks nothing and consumes no hold', async () => {
    const t = setup();
    const saleId = await t.draft();
    const before = t.countRows();
    const holds = t.db.table('stockReservation').map((row) => ({ ...row }));
    const inventory = t.db.table('inventory').map((row) => ({ ...row }));
    t.db.rawQueries.length = 0;

    await t.quote(saleId, { balanceMethod: 'CARD_DEBIT', tenders: [{ method: 'CASH', amount: 20037n }] });

    expect(t.countRows()).toEqual(before);
    expect(t.db.table('stockReservation')).toEqual(holds);
    expect(t.db.table('inventory')).toEqual(inventory);
    // Read-only means no row lock: the service never emits a raw query.
    expect(t.db.rawQueries).toEqual([]);
  });

  it('N2 every rejection is equally without effect', async () => {
    const t = setup();
    const saleId = await t.draft();
    const before = t.countRows();
    const cashOnly = { balanceMethod: 'PAYPAL' as never, tenders: [] };
    const attempts = [
      t.quote(saleId, cashOnly),
      t.quote(saleId, { balanceMethod: 'CASH', tenders: [{ method: 'TRANSFER', amount: 55000n }] }),
      t.quote(saleId, t.cashFixed(20037n)).then(() => t.quote(saleId, cashOnly)),
      t.quote(saleId, t.noFixed(), t.reqs.noCharge),
    ];
    for (const attempt of attempts) await attempt.catch(() => undefined);
    expect(t.countRows()).toEqual(before);
  });

  it('N3 the route emits no realtime event', async () => {
    const t = setup();
    const saleId = await t.draft();
    const { app, events } = httpHarness(t);
    const response = await supertest(app)
      .post(`/api/v1/sales/${saleId}/checkout/quote`)
      .set('X-Test-User', 'cashier')
      .send({ balanceMethod: 'CASH', tenders: [] });
    expect(response.status).toBe(200);
    expect(events).toEqual([]);
  });
});

describe('H — HTTP contract of POST /sales/:saleId/checkout/quote', () => {
  it('H1 answers 200 with money as decimal strings and the approved shape', async () => {
    const t = setup();
    const saleId = await t.draft();
    const { app } = httpHarness(t);
    const response = await supertest(app)
      .post(`/api/v1/sales/${saleId}/checkout/quote`)
      .set('X-Test-User', 'cashier')
      .send({ balanceMethod: 'CARD_DEBIT', tenders: [{ method: 'CASH', amount: '20037' }] });

    expect(response.status).toBe(200);
    expect(Object.keys(response.body).sort()).toEqual(RESPONSE_KEYS);
    // CASH fixed 20037 (centavos exactos) + CARD_DEBIT balance: the balance is
    // round-to-peso of 52500 * (50000-20037)/50000 = 31461.15 -> 31500, so the
    // total keeps the fixed centavos: 20037 + 31500 = 51537.
    expect(response.body).toMatchObject({
      saleId, pricingModel: 'PROPORTIONAL_V1',
      fullPrices: { CASH: '50000', TRANSFER: '55000', CARD_DEBIT: '52500', CARD_CREDIT: '50000', QR: '50000' },
      tenders: [{ method: 'CASH', role: 'FIXED', amount: '20037' }],
      balance: { method: 'CARD_DEBIT', amount: '31500' },
      total: '51537',
    });
    expect((response.body.lines as Array<{ sku: string; quantity: string; finalAmount: string }>)
      .map((entry) => [entry.sku, entry.quantity, entry.finalAmount]).sort())
      .toEqual([['V1', '1', '20615'], ['V2', '1', '30922']]);
  });

  it('H2 malformed bodies die at the edge with 400', async () => {
    const t = setup();
    const saleId = await t.draft();
    const { app } = httpHarness(t);
    const post = (body: object) => supertest(app)
      .post(`/api/v1/sales/${saleId}/checkout/quote`)
      .set('X-Test-User', 'cashier')
      .send(body);
    const bodies = [
      { balanceMethod: 'PAYPAL', tenders: [] },
      { balanceMethod: 'CASH', tenders: [{ method: 'CASH', amount: '0' }] },
      { balanceMethod: 'CASH', tenders: [{ method: 'TRANSFER', amount: '1' }, { method: 'CARD_DEBIT', amount: '1' }, { method: 'CASH', amount: '1' }] },
      { balanceMethod: 'CASH', tenders: [], expectedTotal: '1' },
      { tenders: [] },
      { balanceMethod: 'CASH', tenders: [{ method: 'CASH', amount: '1', receivedAmount: '1' }] },
    ];
    for (const body of bodies) {
      const response = await post(body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    }
    const badId = await supertest(app)
      .post('/api/v1/sales/not-a-uuid/checkout/quote')
      .set('X-Test-User', 'cashier')
      .send({ balanceMethod: 'CASH', tenders: [] });
    expect(badId.status).toBe(400);
    // CARD_CREDIT and QR are valid proportional methods (CARD_CREDIT and QR blocks); only unknown ones are 400.
    const credit = await post({ balanceMethod: 'CASH', tenders: [{ method: 'CARD_CREDIT', amount: '100' }] });
    expect(credit.status).toBe(200);
    const qr = await post({ balanceMethod: 'CASH', tenders: [{ method: 'QR', amount: '100' }] });
    expect(qr.status).toBe(200);
    const unknown = await post({ balanceMethod: 'CASH', tenders: [{ method: 'PAYPAL', amount: '100' }] });
    expect(unknown.status).toBe(400);
  });

  it('H3 a rejection keeps its stable code through the real error handler', async () => {
    const t = setup();
    const saleId = await t.draft();
    t.saleRow(saleId).pricingModel = 'FIXED_TOTAL';
    const { app } = httpHarness(t);
    const response = await supertest(app)
      .post(`/api/v1/sales/${saleId}/checkout/quote`)
      .set('X-Test-User', 'cashier')
      .send({ balanceMethod: 'CASH', tenders: [] });
    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: { code: 'INVALID_SALE_STATE', message: expect.any(String) } });
  });

  it('H4 the route is mounted and the service reads no price from the client', async () => {
    expect(ROUTES_SOURCE).toMatch(/router\.post\(\s*'\/:saleId\/checkout\/quote'/);
    // The only request fields the service ever reads: the method and the amounts.
    const used = [...QUOTE_SERVICE_SOURCE.matchAll(/request\.(\w+)/g)].map((match) => match[1]!);
    expect([...new Set(used)].sort()).toEqual(['balanceMethod', 'tenders']);
    // The single pricing authority is the R3-A1 engine.
    expect(QUOTE_SERVICE_SOURCE).toMatch(/computeProportionalQuote\(/);
    expect(QUOTE_SERVICE_SOURCE).toMatch(/baseUnitPrice: item\.baseUnitPrice/);
    // No write, no audit, no lock, no event, no branch policy, no second model.
    expect(QUOTE_SERVICE_SOURCE).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/);
    expect(QUOTE_SERVICE_SOURCE).not.toMatch(/createAuditLog/);
    expect(QUOTE_SERVICE_SOURCE).not.toMatch(/FOR UPDATE/);
    expect(QUOTE_SERVICE_SOURCE).not.toMatch(/\$queryRaw/);
    expect(QUOTE_SERVICE_SOURCE).not.toMatch(/emit|realtime|REALTIME_EVENTS/);
    expect(QUOTE_SERVICE_SOURCE).not.toMatch(/PROPORTIONAL_CHECKOUT_LOCATION_IDS|env\./);
    expect(QUOTE_CONTROLLER_SOURCE).not.toMatch(/emit|realtime/i);
  });
});

// ---------------------------------------------------------------------------
// HTTP harness: the REAL router and middlewares, fake auth, real quote service.
// ---------------------------------------------------------------------------
function httpHarness(t: ReturnType<typeof setup>) {
  const events: Array<{ event: string; payload: unknown }> = [];
  const realtime = { emit: (event: string, payload: unknown) => { events.push({ event, payload }); } };
  const router = createPaymentsRouter(t.db.client as unknown as PrismaClient, realtime as never, { checkoutQuoteService: t.quotes });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    // The JWT middleware is out of scope: only req.auth is faked, keyed by a header.
    const key = String(req.headers['x-test-user'] ?? 'cashier');
    const source = key === 'no-charge' ? t.reqs.noCharge : t.reqs.cashier;
    req.auth = (source as unknown as { auth: Express.AuthContext }).auth;
    next();
  });
  app.use('/api/v1/sales', router);
  app.use(errorHandler);
  return { app, events };
}

// ---------------------------------------------------------------------------
// S-REF gate: PROPORTIONAL_EXTERNAL_METHODS_ENABLED, quote side.
// ---------------------------------------------------------------------------
describe('GATE — PROPORTIONAL_EXTERNAL_METHODS_ENABLED (S-REF, quote)', () => {
  const disabled = (t: ReturnType<typeof setup>) =>
    createCheckoutQuoteService(t.db.client as unknown as PrismaClient, { externalMethodsEnabled: false });

  it('GATE-01 gate OFF: TRANSFER/CARD_DEBIT are unavailable with PAYMENT_METHOD_NOT_ENABLED; CASH stays available', async () => {
    const t = setup();
    const saleId = await t.draft();
    const quote = await disabled(t).quote(t.reqs.cashier, saleId, t.noFixed('CASH'));
    expect(quote.enabledMethods).toEqual([
      { method: 'CASH', available: true },
      { method: 'TRANSFER', available: false, reason: 'PAYMENT_METHOD_NOT_ENABLED' },
      { method: 'CARD_DEBIT', available: false, reason: 'PAYMENT_METHOD_NOT_ENABLED' },
      { method: 'CARD_CREDIT', available: false, reason: 'PAYMENT_METHOD_NOT_ENABLED' },
      { method: 'QR', available: false, reason: 'PAYMENT_METHOD_NOT_ENABLED' },
    ]);
  });

  it('GATE-02 gate OFF wins over a missing pricing configuration: the reason is the gate, never the config', async () => {
    const t = setup({ pricing: false });
    const saleId = await t.draft();
    const quote = await disabled(t).quote(t.reqs.cashier, saleId, t.noFixed('CASH'));
    expect(quote.enabledMethods).toEqual([
      { method: 'CASH', available: true },
      { method: 'TRANSFER', available: false, reason: 'PAYMENT_METHOD_NOT_ENABLED' },
      { method: 'CARD_DEBIT', available: false, reason: 'PAYMENT_METHOD_NOT_ENABLED' },
      { method: 'CARD_CREDIT', available: false, reason: 'PAYMENT_METHOD_NOT_ENABLED' },
      { method: 'QR', available: false, reason: 'PAYMENT_METHOD_NOT_ENABLED' },
    ]);
  });

  it('GATE-03 gate ON: the external methods are available', async () => {
    const t = setup();
    const saleId = await t.draft();
    const on = await createCheckoutQuoteService(t.db.client as unknown as PrismaClient, { externalMethodsEnabled: true })
      .quote(t.reqs.cashier, saleId, t.noFixed('CASH'));
    expect(on.enabledMethods).toEqual([
      { method: 'CASH', available: true },
      { method: 'TRANSFER', available: true },
      { method: 'CARD_DEBIT', available: true },
      { method: 'CARD_CREDIT', available: true },
      { method: 'QR', available: true },
    ]);
  });

  // S-REF.1 (A1/A4): the omission of the option must NEVER enable the external
  // methods. The old `?? true` fallback was a fail-open defect.
  it('SREF-F01 a quote service built WITHOUT the option defaults to externals OFF, never ON', async () => {
    const t = setup();
    const saleId = await t.draft();
    const detached = await createCheckoutQuoteService(t.db.client as unknown as PrismaClient)
      .quote(t.reqs.cashier, saleId, t.noFixed('CASH'));
    expect(detached.enabledMethods).toEqual([
      { method: 'CASH', available: true },
      { method: 'TRANSFER', available: false, reason: 'PAYMENT_METHOD_NOT_ENABLED' },
      { method: 'CARD_DEBIT', available: false, reason: 'PAYMENT_METHOD_NOT_ENABLED' },
      { method: 'CARD_CREDIT', available: false, reason: 'PAYMENT_METHOD_NOT_ENABLED' },
      { method: 'QR', available: false, reason: 'PAYMENT_METHOD_NOT_ENABLED' },
    ]);
  });

  it('GATE-04 the gate OFF hides the recorded collection candidates too: never a consumable option while external methods are off; prices/lines/totals stay byte-identical', async () => {
    const t = setup();
    const saleId = await t.draft();
    t.db.externalCollection.push({
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', originSaleId: saleId, branchId: BRANCH, status: 'UNAPPLIED',
      reference: 'OP 88123', referenceKey: 'OP88123', amount: 11000n, method: 'TRANSFER', institution: 'GALICIA',
      institutionOther: null, appliedCheckoutId: null, appliedSaleId: null, createdAt: new Date(),
    });
    const off = await disabled(t).quote(t.reqs.cashier, saleId, t.noFixed('CASH'));
    const on = await createCheckoutQuoteService(t.db.client as unknown as PrismaClient, { externalMethodsEnabled: true })
      .quote(t.reqs.cashier, saleId, t.noFixed('CASH'));
    // The same collection the ON answer lists is NOT offered while OFF: T-R
    // would refuse it, so the quote never presents it as usable.
    expect(on.unappliedCollections).toHaveLength(1);
    expect(off.unappliedCollections).toEqual([]);
    expect({ ...off, enabledMethods: null, unappliedCollections: null })
      .toEqual({ ...on, enabledMethods: null, unappliedCollections: null });
    expect(off.total).toBe(on.total);
  });

  // S-REF.1 (A1/A4): real wiring evidence through the REAL payments router. The
  // gate value comes from parseEnv exactly as app.ts injects
  // env.PROPORTIONAL_EXTERNAL_METHODS_ENABLED — the chain env -> router option ->
  // controller -> service -> answer is exercised over HTTP (no injected service).
  function gateApp(t: ReturnType<typeof setup>, externalMethodsEnabled: boolean) {
    const router = createPaymentsRouter(t.db.client as unknown as PrismaClient, undefined, { externalMethodsEnabled });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.auth = (t.reqs.cashier as unknown as { auth: Express.AuthContext }).auth;
      next();
    });
    app.use('/api/v1/sales', router);
    app.use(errorHandler);
    return app;
  }

  it('SREF-F03 the env default (variable omitted) is false and reaches the quote through the real router: externals unavailable', async () => {
    const gate = parseEnv({ ...ENV_BASE }).PROPORTIONAL_EXTERNAL_METHODS_ENABLED;
    expect(gate).toBe(false);
    const t = setup();
    const saleId = await t.draft();
    const response = await supertest(gateApp(t, gate))
      .post(`/api/v1/sales/${saleId}/checkout/quote`)
      .send({ balanceMethod: 'CASH', tenders: [] });
    expect(response.status).toBe(200);
    expect(response.body.enabledMethods).toEqual([
      { method: 'CASH', available: true },
      { method: 'TRANSFER', available: false, reason: 'PAYMENT_METHOD_NOT_ENABLED' },
      { method: 'CARD_DEBIT', available: false, reason: 'PAYMENT_METHOD_NOT_ENABLED' },
      { method: 'CARD_CREDIT', available: false, reason: 'PAYMENT_METHOD_NOT_ENABLED' },
      { method: 'QR', available: false, reason: 'PAYMENT_METHOD_NOT_ENABLED' },
    ]);
  });

  it('SREF-F05 an explicit env=true preserves the previous external behaviour through the real router', async () => {
    const gate = parseEnv({ ...ENV_BASE, PROPORTIONAL_EXTERNAL_METHODS_ENABLED: 'true' }).PROPORTIONAL_EXTERNAL_METHODS_ENABLED;
    expect(gate).toBe(true);
    const t = setup();
    const saleId = await t.draft();
    t.db.externalCollection.push({
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', originSaleId: saleId, branchId: BRANCH, status: 'UNAPPLIED',
      reference: 'OP 88123', referenceKey: 'OP88123', amount: 11000n, method: 'TRANSFER', institution: 'GALICIA',
      institutionOther: null, appliedCheckoutId: null, appliedSaleId: null, createdAt: new Date(),
    });
    const response = await supertest(gateApp(t, gate))
      .post(`/api/v1/sales/${saleId}/checkout/quote`)
      .send({ balanceMethod: 'CASH', tenders: [] });
    expect(response.status).toBe(200);
    expect(response.body.enabledMethods).toEqual([
      { method: 'CASH', available: true },
      { method: 'TRANSFER', available: true },
      { method: 'CARD_DEBIT', available: true },
      { method: 'CARD_CREDIT', available: true },
      { method: 'QR', available: true },
    ]);
    expect(response.body.unappliedCollections).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// CARD_CREDIT (OWNER block): the quote prices Crédito from the credit adjustment of
// the company configuration, on the same line base as the other methods. Expected
// values are computed by hand: V1 $200 + V2 $300 (centavos x100 in the store are
// pesos here, as in the rest of this file); credit +15% -> V1 230, V2 345.
// ---------------------------------------------------------------------------
describe('CARD_CREDIT — quote', () => {
  it('CRED-Q1 retail: fullPrices carries the credit price (cash base + credit bps, one rounding per unit)', async () => {
    const t = setup({ creditBps: 1500 });
    const quote = await t.quoteOf(await t.draft());
    expect(quote.fullPrices).toEqual({ CASH: 50000n, TRANSFER: 55000n, CARD_DEBIT: 52500n, CARD_CREDIT: 57500n, QR: 50000n });
  });

  it('CRED-Q2 simple credit (no fixed tenders): total is the credit full price, lines add up', async () => {
    const t = setup({ creditBps: 1500 });
    const quote = await t.quote(await t.draft(), t.noFixed('CARD_CREDIT'));
    expect(quote).toMatchObject({ balance: { method: 'CARD_CREDIT', amount: 57500n }, total: 57500n });
    expect(bySku(quote)).toEqual({ V1: 23000n, V2: 34500n });
  });

  it('CRED-Q3 combined: CASH 20.000 fixed + balance CARD_CREDIT', async () => {
    const t = setup({ creditBps: 1500 });
    const quote = await t.quote(await t.draft(), { balanceMethod: 'CARD_CREDIT', tenders: [{ method: 'CASH', amount: 20000n }] });
    // balance = 57.500 * (50.000 - 20.000) / 50.000 = 34.500
    expect(quote).toMatchObject({ balance: { method: 'CARD_CREDIT', amount: 34500n }, total: 54500n });
    expect(Object.values(bySku(quote)).reduce((sum, value) => sum + value, 0n)).toBe(54500n);
  });

  it('CRED-Q4 combined: TRANSFER and CARD_DEBIT fixed against a CARD_CREDIT balance', async () => {
    const t = setup({ creditBps: 1500 });
    const saleId = await t.draft();
    const transfer = await t.quote(saleId, { balanceMethod: 'CARD_CREDIT', tenders: [{ method: 'TRANSFER', amount: 27500n }] });
    // 57.500 * 27.500 / 55.000 = 28.750 centavos-pesos -> half-up to the whole peso = 28.800
    expect(transfer).toMatchObject({ balance: { method: 'CARD_CREDIT', amount: 28800n }, total: 56300n });
    const debit = await t.quote(saleId, { balanceMethod: 'CARD_CREDIT', tenders: [{ method: 'CARD_DEBIT', amount: 26250n }] });
    expect(debit).toMatchObject({ balance: { method: 'CARD_CREDIT', amount: 28800n }, total: 55050n });
  });

  it('CRED-Q5 wholesale: credit is priced on the wholesale base lines', async () => {
    const t = setup({ creditBps: 1500 });
    const saleId = await t.draft();
    Object.assign(t.saleRow(saleId), { pricingMode: 'WHOLESALE', wholesaleAuthorizedAt: new Date(), wholesaleConfirmedAt: new Date(), wholesaleConfirmedById: t.ids.cashier });
    const bases: Record<string, bigint> = { V1: 15000n, V2: 25000n };
    for (const line of t.linesOf(saleId)) {
      line.priceBaseType = 'WHOLESALE';
      line.baseUnitPrice = bases[line.sku as string]!;
    }
    const quote = await t.quote(saleId, t.noFixed('CARD_CREDIT'));
    // 15.000 * 1,15 = 17.250 -> 17.300 ; 25.000 * 1,15 = 28.750 -> 28.800 (half-up per unit, whole peso)
    expect(quote.fullPrices).toMatchObject({ CASH: 40000n, CARD_CREDIT: 46100n });
    expect(bySku(quote)).toEqual({ V1: 17300n, V2: 28800n });
  });

  it('CRED-Q6 without a pricing configuration CARD_CREDIT is unavailable and quoting it fails closed', async () => {
    const t = setup({ pricing: false });
    const saleId = await t.draft();
    const quote = await t.quoteOf(saleId);
    expect(quote.enabledMethods).toContainEqual({ method: 'CARD_CREDIT', available: false, reason: 'PRICING_CONFIG_MISSING' });
    await expectAppError(t.quote(saleId, t.noFixed('CARD_CREDIT')), 409, 'PRICING_CONFIG_MISSING');
  });
});

// ---------------------------------------------------------------------------
// QR (P0-B): the quote prices QR from qrAdjustmentBps of the company configuration, on
// the same line base as the other methods. Same fixture as CARD_CREDIT: V1 $200 + V2
// $300 (the store keeps pesos x100 here); QR +12% -> V1 224, V2 336, total 560.
// ---------------------------------------------------------------------------
describe('QR — quote', () => {
  it('QR-Q1 retail: fullPrices carries the QR price (cash base + qrAdjustmentBps, one rounding per unit)', async () => {
    const t = setup({ qrBps: 1200 });
    const quote = await t.quoteOf(await t.draft());
    expect(quote.fullPrices).toEqual({ CASH: 50000n, TRANSFER: 55000n, CARD_DEBIT: 52500n, CARD_CREDIT: 50000n, QR: 56000n });
    expect(quote.enabledMethods).toContainEqual({ method: 'QR', available: true });
  });

  it('QR-Q2 simple QR (no fixed tenders): total is the QR full price, lines add up', async () => {
    const t = setup({ qrBps: 1200 });
    const quote = await t.quote(await t.draft(), t.noFixed('QR'));
    expect(quote).toMatchObject({ balance: { method: 'QR', amount: 56000n }, total: 56000n });
    expect(bySku(quote)).toEqual({ V1: 22400n, V2: 33600n });
  });

  it('QR-Q3 combined: CASH 20.000 fixed + balance QR', async () => {
    const t = setup({ qrBps: 1200 });
    const quote = await t.quote(await t.draft(), { balanceMethod: 'QR', tenders: [{ method: 'CASH', amount: 20000n }] });
    // balance = 56.000 * (50.000 - 20.000) / 50.000 = 33.600
    expect(quote).toMatchObject({ balance: { method: 'QR', amount: 33600n }, total: 53600n });
    expect(Object.values(bySku(quote)).reduce((sum, value) => sum + value, 0n)).toBe(53600n);
  });

  it('QR-Q4 combined: TRANSFER and CARD_DEBIT fixed against a QR balance, and QR fixed against a CASH balance', async () => {
    const t = setup({ qrBps: 1200 });
    const saleId = await t.draft();
    const transfer = await t.quote(saleId, { balanceMethod: 'QR', tenders: [{ method: 'TRANSFER', amount: 27500n }] });
    expect(transfer).toMatchObject({ balance: { method: 'QR', amount: 28000n }, total: 55500n });
    const debit = await t.quote(saleId, { balanceMethod: 'QR', tenders: [{ method: 'CARD_DEBIT', amount: 26250n }] });
    expect(debit).toMatchObject({ balance: { method: 'QR', amount: 28000n }, total: 54250n });
    const qrFixed = await t.quote(saleId, { balanceMethod: 'CASH', tenders: [{ method: 'QR', amount: 28000n }] });
    expect(qrFixed).toMatchObject({ balance: { method: 'CASH', amount: 25000n }, total: 53000n });
  });

  it('QR-Q5 wholesale: QR is priced on the wholesale base lines', async () => {
    const t = setup({ qrBps: 1200 });
    const saleId = await t.draft();
    Object.assign(t.saleRow(saleId), { pricingMode: 'WHOLESALE', wholesaleAuthorizedAt: new Date(), wholesaleConfirmedAt: new Date(), wholesaleConfirmedById: t.ids.cashier });
    const bases: Record<string, bigint> = { V1: 15000n, V2: 25000n };
    for (const line of t.linesOf(saleId)) {
      line.priceBaseType = 'WHOLESALE';
      line.baseUnitPrice = bases[line.sku as string]!;
    }
    const quote = await t.quote(saleId, t.noFixed('QR'));
    expect(quote.fullPrices).toMatchObject({ CASH: 40000n, QR: 44800n });
    expect(bySku(quote)).toEqual({ V1: 16800n, V2: 28000n });
  });

  it('QR-Q6 a change of qrAdjustmentBps changes the next quote only (the configuration is read, never cached)', async () => {
    const t = setup({ qrBps: 1200 });
    const saleId = await t.draft();
    expect((await t.quote(saleId, t.noFixed('QR'))).total).toBe(56000n);
    t.db.table('companyPricingConfig')[0]!.qrAdjustmentBps = 2000;
    expect((await t.quote(saleId, t.noFixed('QR'))).total).toBe(60000n);
  });

  it('QR-Q7 without a pricing configuration QR is unavailable and quoting it fails closed', async () => {
    const t = setup({ pricing: false });
    const saleId = await t.draft();
    const quote = await t.quoteOf(saleId);
    expect(quote.enabledMethods).toContainEqual({ method: 'QR', available: false, reason: 'PRICING_CONFIG_MISSING' });
    await expectAppError(t.quote(saleId, t.noFixed('QR')), 409, 'PRICING_CONFIG_MISSING');
  });

  it('QR-Q8 HTTP: QR is accepted by the edge as a balance and as a fixed tender; strings carry the money', async () => {
    const t = setup({ qrBps: 1200 });
    const saleId = await t.draft();
    const { app } = httpHarness(t);
    const response = await supertest(app)
      .post(`/api/v1/sales/${saleId}/checkout/quote`)
      .set('X-Test-User', 'cashier')
      .send({ balanceMethod: 'QR', tenders: [{ method: 'CASH', amount: '20000' }] });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ balance: { method: 'QR', amount: '33600' }, total: '53600', fullPrices: { QR: '56000' } });
    const fixed = await supertest(app)
      .post(`/api/v1/sales/${saleId}/checkout/quote`)
      .set('X-Test-User', 'cashier')
      .send({ balanceMethod: 'CASH', tenders: [{ method: 'QR', amount: '28000' }] });
    expect(fixed.status).toBe(200);
  });
});
