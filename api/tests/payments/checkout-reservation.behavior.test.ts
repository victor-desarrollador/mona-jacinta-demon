// R3-A4.3 S4 — T-R (POST /sales/:saleId/checkout/reservations) and the two
// per-sale reads, against the DB-free double (tests/helpers/
// checkout-reservation-fake-db.ts). Approved design S4 + closure (D1–D5).
// What PostgreSQL alone can prove (F1–F6, CHECKs, the partial index under real
// concurrency) lives in checkout-reservation.pg.test.ts (opt-in).
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { DEFAULT_ROLE_GRANTS } from '../../src/modules/rbac/role-permission-matrix.js';
import { planHash, type PlanTenderInput } from '../../src/modules/payments/checkout-canonical.js';
import { computeProportionalQuote } from '../../src/modules/pricing/proportional-checkout.js';
import { createCheckoutReservationService } from '../../src/modules/payments/checkout-reservation.service.js';
import type { CheckoutReservationRequest } from '../../src/modules/payments/dto/checkout-reservation.dto.js';
import { AppError } from '../../src/shared/errors.js';
import { createCheckoutReservationFakeDb, p2002, type Row } from '../helpers/checkout-reservation-fake-db.js';

const NOW = new Date('2026-10-16T12:00:00.000Z');
const LATER = new Date(NOW.getTime() + 20 * 60_000);
const OP_KEYS = ['0f8fad5b-d9cb-469f-a165-70867728950e', '7c9e6679-7425-40de-944b-e07fc1f90ae7', 'e4eaaaf2-d142-41b9-a1d4-3b6c1b6e0f0b'];
const uuid = () => randomUUID();

type Role = 'CASHIER' | 'SELLER' | 'ADMIN' | 'OWNER';
function auth(userId: string, role: Role, locationId: string | null) {
  const permissions = role === 'OWNER' ? [] : [...DEFAULT_ROLE_GRANTS[role]];
  return {
    auth: {
      userId, roles: [role], effectiveLocationIds: locationId ? [locationId] : [],
      assignments: [{ roleId: role, roleCode: role, scopeKind: locationId ? 'LOCATION' : 'COMPANY', locationId, permissions }],
    },
  } as never;
}

function setup(options: { pricing?: boolean; holdsExpireAt?: Date } = {}) {
  const db = createCheckoutReservationFakeDb({ now: () => NOW });
  const branch = uuid();
  const cashier = db.insert('user', { id: uuid(), name: 'Caja 1' });
  const other = db.insert('user', { id: uuid(), name: 'Caja 2' });
  db.insert('company', { id: uuid(), createdAt: new Date(0) });
  if (options.pricing !== false) {
    db.insert('companyPricingConfig', {
      id: uuid(), companyId: db.table('company')[0]!.id, updatedAt: new Date('2026-10-01T00:00:00Z'), listAdjustmentBps: 0,
      creditCardAdjustmentBps: 0, debitCardAdjustmentBps: 300, bankTransferAdjustmentBps: 200, qrAdjustmentBps: 0,
    });
  }
  const register = db.insert('cashRegister', { id: uuid(), branchId: branch });
  const session = db.insert('cashSession', { id: uuid(), registerId: register.id, status: 'OPEN' });
  const sale = db.insert('sale', {
    id: uuid(), branchId: branch, status: 'PENDING_PAYMENT', saleNumber: 'B-0001', pricingMode: 'LIST', priceMode: 'CASH',
    pricingModel: 'PROPORTIONAL_V1', paymentStartedAt: null, wholesaleConfirmedAt: null, wholesaleConfirmedById: null, updatedAt: new Date(0),
  });
  const items = [
    db.insert('saleItem', { id: '00000000-0000-4000-8000-000000000001', saleId: sale.id, variantId: 'v1', sku: 'SKU1', quantity: 2n, baseUnitPrice: 5000n, priceMode: 'CASH', priceBaseType: 'LIST' }),
    db.insert('saleItem', { id: '00000000-0000-4000-8000-000000000002', saleId: sale.id, variantId: 'v2', sku: 'SKU2', quantity: 1n, baseUnitPrice: 5000n, priceMode: 'CASH', priceBaseType: 'LIST' }),
  ];
  for (const item of items) {
    db.insert('stockReservation', { id: uuid(), saleId: sale.id, variantId: item.variantId, branchId: branch, quantity: item.quantity, status: 'ACTIVE', expiresAt: options.holdsExpireAt ?? LATER });
  }
  let next = 0;
  const service = createCheckoutReservationService(db.client as unknown as PrismaClient, { now: () => NOW, operationKey: () => OP_KEYS[next++ % OP_KEYS.length]! });
  const pricing = options.pricing === false ? null : { bankTransferAdjustmentBps: 200, debitCardAdjustmentBps: 300 };
  const lines = items.map((item) => ({ saleItemId: item.id as string, sku: item.sku as string, quantity: item.quantity as bigint, baseUnitPrice: item.baseUnitPrice as bigint }));
  function request(tenders: PlanTenderInput[], patch: Partial<CheckoutReservationRequest> = {}): CheckoutReservationRequest {
    const balance = tenders.find((t) => t.role === 'BALANCE')!.method;
    const quote = computeProportionalQuote({
      lines, pricing, balanceMethod: balance,
      tenders: tenders.filter((t) => t.role === 'FIXED').map((t) => ({ method: t.method, amount: t.amount! })),
    });
    return {
      reserveKey: uuid(), cashSessionId: session.id as string, balanceMethod: balance,
      expectedTotal: quote.total, expectedBalanceAmount: quote.balance.amount, tenders, recovery: null, ...patch,
    };
  }
  const cashOnly = () => request([{ method: 'CASH', role: 'BALANCE', source: 'NEW', amount: null, externalCollectionId: null }]);
  const collection = (patch: Row = {}) => db.insert('externalCollection', {
    id: uuid(), branchId: branch, method: 'TRANSFER', amount: 5000n, status: 'UNAPPLIED', claimAttemptId: null, originSaleId: sale.id, ...patch,
  });
  return { db, service, branch, cashier, other, sale, session, register, request, cashOnly, collection, asCashier: auth(cashier.id as string, 'CASHIER', branch) };
}

const codeOf = async (promise: Promise<unknown>) => {
  try { await promise; return null; } catch (error) {
    if (!(error instanceof AppError)) throw error;
    return { status: error.status, code: error.code, details: error.details };
  }
};

describe('R3-A4.3 S4 — T-R reservation', () => {
  it('R01 a valid reservation: 201 view; one READ COMMITTED transaction; lock order; attempt unsealed → tenders → claim → sealed → audit', async () => {
    const t = setup();
    const ec = t.collection({ method: 'CARD_DEBIT', amount: 4000n });
    const req = t.request([
      { method: 'CASH', role: 'BALANCE', source: 'NEW', amount: null, externalCollectionId: null },
      { method: 'TRANSFER', role: 'FIXED', source: 'NEW', amount: 3000n, externalCollectionId: null },
      { method: 'CARD_DEBIT', role: 'FIXED', source: 'COLLECTION', amount: 4000n, externalCollectionId: ec.id as string },
    ]);
    const result = await t.service.reserve(t.asCashier, t.sale.id as string, req);
    expect(result.replayed).toBe(false);
    expect(result.view).toMatchObject({ reserveKey: req.reserveKey, operationKey: OP_KEYS[0], status: 'RESERVED', startedBy: { id: t.cashier.id, name: 'Caja 1' }, stockState: 'VALID' });
    expect(t.db.transactions).toEqual([{ isolationLevel: 'ReadCommitted', timeout: 30_000 }]);
    const sequence = t.db.ops.filter((op) => op.kind !== 'begin' && op.kind !== 'commit').map((op) => `${op.kind}:${op.model}`);
    expect(sequence).toEqual([
      'lock:Sale', 'lock:ExternalCollection', 'lock:CashSession', 'lock:StockReservation', 'touch:Sale',
      'create:checkoutAttempt', 'create:checkoutAttemptTender', 'create:checkoutAttemptTender', 'create:checkoutAttemptTender',
      'updateMany:externalCollection', 'update:checkoutAttempt', 'create:auditLog',
    ]);
    const [attempt] = t.db.table('checkoutAttempt');
    expect(attempt).toMatchObject({
      saleId: t.sale.id, branchId: t.branch, reserveKey: req.reserveKey, operationKey: OP_KEYS[0], planSealed: true, status: 'RESERVED',
      startedById: t.cashier.id, planHash: planHash({ saleId: t.sale.id as string, ...req }), tenderCount: 3, algorithmVersion: 1,
      expectedTotal: req.expectedTotal, expectedBalanceAmount: req.expectedBalanceAmount, cashSessionId: t.session.id,
      transferAdjustmentBps: 200, debitAdjustmentBps: 300, pricingConfigId: t.db.table('companyPricingConfig')[0]!.id,
    });
    // The attempt was written unsealed first; the seal is a later update.
    expect(t.db.ops.find((op) => op.kind === 'create' && op.model === 'checkoutAttempt')!.detail).not.toHaveProperty('planSealed', true);
    expect(t.db.table('externalCollection')[0]).toMatchObject({ claimAttemptId: attempt!.id, status: 'UNAPPLIED' });
    const [audit] = t.db.table('auditLog');
    expect(audit).toMatchObject({ action: 'CHECKOUT_RESERVED', entityType: 'CheckoutAttempt', entityId: attempt!.id, userId: t.cashier.id, branchId: t.branch });
    expect(audit!.after).toMatchObject({ saleId: t.sale.id, reserveKey: req.reserveKey, operationKey: OP_KEYS[0], expectedTotal: String(req.expectedTotal), claimedCollectionIds: [ec.id] });
    expect(t.db.table('sale')[0]!.updatedAt).toEqual(NOW);
  });

  it('R02 lost response: the same reserveKey and plan → 200 with the SAME operationKey; no write, no audit, updatedAt untouched', async () => {
    const t = setup();
    const req = t.cashOnly();
    const first = await t.service.reserve(t.asCashier, t.sale.id as string, req);
    t.db.table('sale')[0]!.updatedAt = new Date(1);
    const mark = t.db.ops.length;
    const second = await t.service.reserve(t.asCashier, t.sale.id as string, { ...req, tenders: [...req.tenders].reverse() });
    expect(second.replayed).toBe(true);
    expect(second.view.operationKey).toBe(first.view.operationKey);
    expect(t.db.writesSince(mark)).toEqual([]);
    expect(t.db.table('auditLog')).toHaveLength(1);
    expect(t.db.table('sale')[0]!.updatedAt).toEqual(new Date(1));
  });

  it('R03 D1: a replay is returned even after the sale moved on (COMPLETED), but only after the permission check', async () => {
    const t = setup();
    const req = t.cashOnly();
    await t.service.reserve(t.asCashier, t.sale.id as string, req);
    t.db.table('sale')[0]!.status = 'COMPLETED';
    expect((await t.service.reserve(t.asCashier, t.sale.id as string, req)).replayed).toBe(true);
    const foreign = auth(t.other.id as string, 'CASHIER', uuid());
    expect(await codeOf(t.service.reserve(foreign, t.sale.id as string, req))).toMatchObject({ status: 403, code: 'FORBIDDEN' });
  });

  it('R04 reserveKey reused with another plan, or for ANOTHER sale → the same generic 409, no details, no writes', async () => {
    const t = setup();
    const req = t.cashOnly();
    await t.service.reserve(t.asCashier, t.sale.id as string, req);
    const otherSale = t.db.insert('sale', { ...t.sale, id: uuid(), saleNumber: 'B-0002' });
    const mark = t.db.ops.length;
    const otherPlan = await codeOf(t.service.reserve(t.asCashier, t.sale.id as string, { ...req, cashSessionId: uuid() }));
    const otherSaleResult = await codeOf(t.service.reserve(t.asCashier, otherSale.id as string, req));
    for (const result of [otherPlan, otherSaleResult]) {
      expect(result).toEqual({ status: 409, code: 'RESERVE_KEY_REUSED_WITH_DIFFERENT_PLAN', details: undefined });
    }
    expect(t.db.writesSince(mark)).toEqual([]);
  });

  it('R05 two terminals: the second reservation of the same sale gets CHECKOUT_RESERVATION_OPEN with who holds it', async () => {
    const t = setup();
    await t.service.reserve(t.asCashier, t.sale.id as string, t.cashOnly());
    const second = await codeOf(t.service.reserve(auth(t.other.id as string, 'CASHIER', t.branch), t.sale.id as string, t.cashOnly()));
    expect(second).toMatchObject({ status: 409, code: 'CHECKOUT_RESERVATION_OPEN' });
    expect(second!.details).toEqual({ open: { reserveKey: t.db.table('checkoutAttempt')[0]!.reserveKey, status: 'RESERVED', startedBy: { id: t.cashier.id, name: 'Caja 1' } } });
    expect(t.db.table('checkoutAttempt')).toHaveLength(1);
    // A REJECTED attempt not yet declared still blocks; a declared one does not.
    t.db.table('checkoutAttempt')[0]!.status = 'REJECTED';
    expect((await codeOf(t.service.reserve(t.asCashier, t.sale.id as string, t.cashOnly())))?.code).toBe('CHECKOUT_RESERVATION_OPEN');
    t.db.table('checkoutAttempt')[0]!.declaredAt = NOW;
    expect((await t.service.reserve(t.asCashier, t.sale.id as string, t.cashOnly())).replayed).toBe(false);
  });

  it('R06 race: the peer commits the SAME reserveKey first → P2002 → fresh re-read → 200 with the peer operationKey', async () => {
    const t = setup();
    const req = t.cashOnly();
    const peerKey = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    t.db.concurrently('checkoutAttempt', 'create', () => {
      t.db.insert('checkoutAttempt', { saleId: t.sale.id, branchId: t.branch, reserveKey: req.reserveKey, operationKey: peerKey, planHash: planHash({ saleId: t.sale.id as string, ...req }),
        cashSessionId: t.session.id, balanceMethod: 'CASH', expectedTotal: req.expectedTotal, expectedBalanceAmount: req.expectedBalanceAmount, tenderCount: 1,
        fullPriceCash: req.expectedTotal, algorithmVersion: 1, planSealed: true, startedById: t.other.id });
      t.db.insert('checkoutAttemptTender', { attemptId: t.db.table('checkoutAttempt').at(-1)!.id, branchId: t.branch, method: 'CASH', role: 'BALANCE', source: 'NEW', amount: null, externalCollectionId: null });
    });
    const result = await t.service.reserve(t.asCashier, t.sale.id as string, req);
    expect(result).toMatchObject({ replayed: true, view: { operationKey: peerKey } });
    expect(t.db.table('checkoutAttempt')).toHaveLength(1);
    expect(t.db.table('auditLog')).toHaveLength(0); // the peer's audit is the peer's
  });

  it('R07 race: a peer commits ANOTHER open attempt first → P2002 one-open-per-sale → CHECKOUT_RESERVATION_OPEN; unknown P2002 is rethrown', async () => {
    const t = setup();
    t.db.concurrently('checkoutAttempt', 'create', () => {
      t.db.insert('checkoutAttempt', { saleId: t.sale.id, branchId: t.branch, reserveKey: uuid(), operationKey: uuid(), planHash: 'b'.repeat(64), cashSessionId: t.session.id,
        balanceMethod: 'CASH', expectedTotal: 15000n, expectedBalanceAmount: 15000n, tenderCount: 1, fullPriceCash: 15000n, algorithmVersion: 1, planSealed: true, startedById: t.other.id });
    });
    expect((await codeOf(t.service.reserve(t.asCashier, t.sale.id as string, t.cashOnly())))?.code).toBe('CHECKOUT_RESERVATION_OPEN');

    const u = setup();
    const unknown = p2002(['somethingElse'], 'AuditLog');
    u.db.failOn('auditLog', 'create', () => unknown);
    await expect(u.service.reserve(u.asCashier, u.sale.id as string, u.cashOnly())).rejects.toBe(unknown);
  });

  it('R08 permissions on the persisted sale.branchId: SALE_CHARGE and SALE_COMPLETE there; nothing is read beyond the sale before', async () => {
    const t = setup();
    const cases = [
      auth(uuid(), 'CASHIER', uuid()),            // another branch
      auth(uuid(), 'SELLER', t.branch),           // no SALE_CHARGE / SALE_COMPLETE
    ];
    for (const actor of cases) {
      const mark = t.db.ops.length;
      expect(await codeOf(t.service.reserve(actor, t.sale.id as string, t.cashOnly()))).toMatchObject({ status: 403, code: 'FORBIDDEN' });
      expect(t.db.ops.slice(mark).filter((op) => op.kind === 'lock').map((op) => op.model)).toEqual(['Sale']);
    }
    expect((await t.service.reserve(auth(uuid(), 'ADMIN', null), t.sale.id as string, t.cashOnly())).replayed).toBe(false);
    expect(await codeOf(t.service.reserve(t.asCashier, uuid(), t.cashOnly()))).toMatchObject({ status: 404 });
  });

  it('R09 sale state: model, status, prior payments, payment history marker and unconfirmed wholesale are refused', async () => {
    for (const [patch, code] of [
      [{ pricingModel: 'FIXED_TOTAL' }, 'INVALID_SALE_STATE'],
      [{ status: 'DRAFT' }, 'INVALID_SALE_STATE'],
      [{ status: 'COMPLETED' }, 'INVALID_SALE_STATE'],
      [{ paymentStartedAt: NOW }, 'INVALID_SALE_STATE'],
      [{ pricingMode: 'WHOLESALE' }, 'WHOLESALE_CONFIRMATION_REQUIRED'],
      [{ priceMode: 'LIST' }, 'PRICING_SNAPSHOT_INCONSISTENT'],
    ] as const) {
      const t = setup();
      Object.assign(t.db.table('sale')[0]!, patch);
      expect((await codeOf(t.service.reserve(t.asCashier, t.sale.id as string, t.cashOnly())))?.code, JSON.stringify(patch)).toBe(code);
      expect(t.db.table('checkoutAttempt')).toHaveLength(0);
    }
    const t = setup();
    t.db.insert('salePayment', { saleId: t.sale.id, amount: 1n });
    expect((await codeOf(t.service.reserve(t.asCashier, t.sale.id as string, t.cashOnly())))?.code).toBe('INVALID_SALE_STATE');
  });

  it('R10 cash session: missing or CLOSED → NO_OPEN_CASH_SESSION; another branch → CASH_SESSION_BRANCH_MISMATCH', async () => {
    const t = setup();
    expect((await codeOf(t.service.reserve(t.asCashier, t.sale.id as string, { ...t.cashOnly(), cashSessionId: uuid() })))?.code).toBe('NO_OPEN_CASH_SESSION');
    t.db.table('cashSession')[0]!.status = 'CLOSED';
    expect((await codeOf(t.service.reserve(t.asCashier, t.sale.id as string, t.cashOnly())))?.code).toBe('NO_OPEN_CASH_SESSION');
    t.db.table('cashSession')[0]!.status = 'OPEN';
    t.db.table('cashRegister')[0]!.branchId = uuid();
    expect((await codeOf(t.service.reserve(t.asCashier, t.sale.id as string, t.cashOnly())))?.code).toBe('CASH_SESSION_BRANCH_MISMATCH');
    expect(t.db.table('checkoutAttempt')).toHaveLength(0);
  });

  it('R11 stock (D4): expired → STOCK_HOLD_EXPIRED; released or partial → STOCK_HOLD_RELEASED; defective hold → 500; nothing written', async () => {
    const expired = setup({ holdsExpireAt: NOW });
    expect((await codeOf(expired.service.reserve(expired.asCashier, expired.sale.id as string, expired.cashOnly())))?.code).toBe('STOCK_HOLD_EXPIRED');
    const released = setup();
    released.db.table('stockReservation').forEach((hold) => { hold.status = 'RELEASED'; });
    expect((await codeOf(released.service.reserve(released.asCashier, released.sale.id as string, released.cashOnly())))?.code).toBe('STOCK_HOLD_RELEASED');
    const partial = setup();
    partial.db.table('stockReservation')[0]!.status = 'RELEASED';
    expect((await codeOf(partial.service.reserve(partial.asCashier, partial.sale.id as string, partial.cashOnly())))?.code).toBe('STOCK_HOLD_RELEASED');
    const defective = setup();
    defective.db.table('stockReservation')[0]!.branchId = uuid();
    expect(await codeOf(defective.service.reserve(defective.asCashier, defective.sale.id as string, defective.cashOnly()))).toMatchObject({ status: 500, code: 'CHECKOUT_STATE_INCONSISTENT' });
    for (const t of [expired, released, partial, defective]) {
      expect(t.db.table('checkoutAttempt')).toHaveLength(0);
      expect(t.db.table('auditLog')).toHaveLength(0);
    }
  });

  it('R12 the server quote is the authority: a different expectedTotal or balance → CHECKOUT_QUOTE_CHANGED, no row; the price snapshot is sealed', async () => {
    const t = setup();
    const req = t.request([
      { method: 'TRANSFER', role: 'BALANCE', source: 'NEW', amount: null, externalCollectionId: null },
      { method: 'CASH', role: 'FIXED', source: 'NEW', amount: 2000n, externalCollectionId: null },
    ]);
    for (const patch of [{ expectedTotal: req.expectedTotal + 100n }, { expectedBalanceAmount: req.expectedBalanceAmount - 100n }]) {
      const result = await codeOf(t.service.reserve(t.asCashier, t.sale.id as string, { ...req, ...patch }));
      expect(result).toMatchObject({ status: 409, code: 'CHECKOUT_QUOTE_CHANGED' });
    }
    expect(t.db.table('checkoutAttempt')).toHaveLength(0);
    const ok = await t.service.reserve(t.asCashier, t.sale.id as string, req);
    expect(ok.view.plan.fullPrices.TRANSFER).not.toBeNull();
    expect(t.db.table('checkoutAttempt')[0]).toMatchObject({ fullPriceTransfer: ok.view.plan.fullPrices.TRANSFER, fullPriceDebit: ok.view.plan.fullPrices.CARD_DEBIT });
    // No pricing configuration: CASH only; a TRANSFER tender cannot be quoted.
    const bare = setup({ pricing: false });
    const cash = await bare.service.reserve(bare.asCashier, bare.sale.id as string, bare.cashOnly());
    expect(bare.db.table('checkoutAttempt')[0]).toMatchObject({ pricingConfigId: null, pricingConfigUpdatedAt: null, fullPriceTransfer: null, transferAdjustmentBps: null });
    expect(cash.view.plan.fullPrices).toMatchObject({ TRANSFER: null, CARD_DEBIT: null });
  });

  it('R13 external collections: claimed, not UNAPPLIED, other branch/method/amount, missing, or an origin collection left out → refused before any write', async () => {
    const plan = (ec: Row | { id: string }, amount = 5000n, method: 'TRANSFER' | 'CARD_DEBIT' = 'TRANSFER'): PlanTenderInput[] => [
      { method: 'CASH', role: 'BALANCE', source: 'NEW', amount: null, externalCollectionId: null },
      { method, role: 'FIXED', source: 'COLLECTION', amount, externalCollectionId: ec.id as string },
    ];
    const cases: Array<[(t: ReturnType<typeof setup>) => PlanTenderInput[], string]> = [
      [(t) => plan(t.collection({ claimAttemptId: uuid() })), 'EXTERNAL_COLLECTION_CLAIMED'],
      [(t) => plan(t.collection({ status: 'REFUNDED' })), 'EXTERNAL_COLLECTION_NOT_APPLICABLE'],
      [(t) => plan(t.collection({ branchId: uuid(), originSaleId: null })), 'EXTERNAL_COLLECTION_NOT_APPLICABLE'],
      [(t) => plan(t.collection({ method: 'CARD_DEBIT' })), 'EXTERNAL_COLLECTION_NOT_APPLICABLE'],
      [(t) => plan(t.collection(), 4999n), 'EXTERNAL_COLLECTION_NOT_APPLICABLE'],
      [() => plan({ id: uuid() }), 'EXTERNAL_COLLECTION_NOT_APPLICABLE'],
      [(t) => { t.collection(); return t.cashOnly().tenders; }, 'UNAPPLIED_EXTERNAL_COLLECTION_PENDING'],
    ];
    for (const [build, code] of cases) {
      const t = setup();
      const tenders = build(t);
      const req = t.request(tenders);
      const mark = t.db.ops.length;
      expect((await codeOf(t.service.reserve(t.asCashier, t.sale.id as string, req)))?.code, code).toBe(code);
      expect(t.db.writesSince(mark)).toEqual([]);
    }
  });

  it('R14 an audit failure rolls the whole reservation back (attempt, tenders, claim, seal, updatedAt)', async () => {
    const t = setup();
    const ec = t.collection();
    t.db.failOn('auditLog', 'create', () => new Error('audit down'));
    const req = t.request([
      { method: 'CASH', role: 'BALANCE', source: 'NEW', amount: null, externalCollectionId: null },
      { method: 'TRANSFER', role: 'FIXED', source: 'COLLECTION', amount: 5000n, externalCollectionId: ec.id as string },
    ]);
    await expect(t.service.reserve(t.asCashier, t.sale.id as string, req)).rejects.toThrow('audit down');
    expect(t.db.table('checkoutAttempt')).toHaveLength(0);
    expect(t.db.table('checkoutAttemptTender')).toHaveLength(0);
    expect(t.db.table('externalCollection')[0]!.claimAttemptId).toBeNull();
    expect(t.db.table('sale')[0]!.updatedAt).toEqual(new Date(0));
  });

  it('R15 D2: a recovery body is refused with RECOVERY_RESERVATION_NOT_ENABLED before any transaction', async () => {
    const t = setup();
    const result = await codeOf(t.service.reserve(t.asCashier, t.sale.id as string, { ...t.cashOnly(), recovery: { reason: 'motivo suficiente', evidence: 'cupón 1' } }));
    expect(result).toMatchObject({ status: 409, code: 'RECOVERY_RESERVATION_NOT_ENABLED' });
    expect(t.db.transactions).toHaveLength(0);
  });

  it('R16 transient failures retry up to 3 times, then CONCURRENCY_ERROR; a retry that succeeds writes once', async () => {
    const t = setup();
    const deadlock = () => Object.assign(new Error('deadlock detected 40P01'), { code: 'P2034' });
    t.db.failOn('sale', 'touch', deadlock);
    expect((await t.service.reserve(t.asCashier, t.sale.id as string, t.cashOnly())).replayed).toBe(false);
    expect(t.db.table('checkoutAttempt')).toHaveLength(1);
    expect(t.db.transactions).toHaveLength(2);
    const u = setup();
    u.db.failOn('sale', 'touch', deadlock, false);
    expect((await codeOf(u.service.reserve(u.asCashier, u.sale.id as string, u.cashOnly())))?.code).toBe('CONCURRENCY_ERROR');
    expect(u.db.transactions).toHaveLength(3);
  });
});

describe('R3-A4.3 S4 — per-sale reads', () => {
  it('G01 GET list: {open, recent (last 10)}, any sale status, permission on the sale branch', async () => {
    const t = setup();
    await t.service.reserve(t.asCashier, t.sale.id as string, t.cashOnly());
    t.db.table('sale')[0]!.status = 'COMPLETED';
    const list = await t.service.listForSale(t.asCashier, t.sale.id as string);
    expect(list.open).toMatchObject({ status: 'RESERVED' });
    expect(list.recent).toHaveLength(1);
    expect(await codeOf(t.service.listForSale(auth(uuid(), 'CASHIER', uuid()), t.sale.id as string))).toMatchObject({ status: 403 });
    expect(await codeOf(t.service.listForSale(t.asCashier, uuid()))).toMatchObject({ status: 404 });
  });

  it('G02 GET by reserveKey: the view of THIS sale only; a reserveKey of another sale is 404 like an unknown one', async () => {
    const t = setup();
    const req = t.cashOnly();
    await t.service.reserve(t.asCashier, t.sale.id as string, req);
    expect((await t.service.getForSale(t.asCashier, t.sale.id as string, req.reserveKey)).view.reserveKey).toBe(req.reserveKey);
    const otherSale = t.db.insert('sale', { ...t.sale, id: uuid() });
    for (const [saleId, key] of [[otherSale.id as string, req.reserveKey], [t.sale.id as string, uuid()]] as Array<[string, string]>) {
      expect(await codeOf(t.service.getForSale(t.asCashier, saleId, key))).toMatchObject({ status: 404, code: 'NOT_FOUND', details: undefined });
    }
    expect(await codeOf(t.service.getForSale(auth(uuid(), 'CASHIER', uuid()), t.sale.id as string, req.reserveKey))).toMatchObject({ status: 403 });
  });

  it('G03 GET by reserveKey of a CONFIRMED attempt returns the committed checkout result (lost confirmation response)', async () => {
    const t = setup();
    const req = t.cashOnly();
    const { view } = await t.service.reserve(t.asCashier, t.sale.id as string, req);
    const attempt = t.db.table('checkoutAttempt')[0]!;
    Object.assign(attempt, { status: 'CONFIRMED', confirmationHash: 'c'.repeat(64), confirmedById: t.cashier.id, confirmedAt: NOW });
    Object.assign(t.db.table('sale')[0]!, { status: 'COMPLETED' });
    const checkout = t.db.insert('saleCheckout', { saleId: t.sale.id, branchId: t.branch, operationKey: view.operationKey, attemptStatus: 'CONFIRMED', requestHash: 'c'.repeat(64), total: 15000n, changeAmount: 0n, completedAt: NOW });
    t.db.insert('salePayment', { saleId: t.sale.id, checkoutId: checkout.id, method: 'CASH', tenderRole: 'BALANCE', amount: 15000n, methodFullPrice: 15000n, adjustmentBps: 0, externalCollectionId: null, receivedAmount: 15000n, changeAmount: 0n, paidAt: NOW });
    const result = await t.service.getForSale(t.asCashier, t.sale.id as string, req.reserveKey);
    expect(result.view.status).toBe('CONFIRMED');
    expect(result.checkout).toMatchObject({ checkoutId: checkout.id, total: 15000n, status: 'COMPLETED', payments: [{ method: 'CASH', amount: 15000n }] });
  });
});

// --------------------------------------------------------------- S4 REVISE
// A CONFIRMED attempt is only ever shown with a coherent committed checkout:
// the SaleCheckout of its operationKey, of the same sale, branch and hash
// (SaleCheckout_attempt_fkey), the sale's ONLY checkout, and a COMPLETED sale.
// Anything else is 500 CHECKOUT_STATE_INCONSISTENT on every read path.
const HASH = 'c'.repeat(64);
async function confirmed(t: ReturnType<typeof setup>) {
  const req = t.cashOnly();
  const { view } = await t.service.reserve(t.asCashier, t.sale.id as string, req);
  Object.assign(t.db.table('checkoutAttempt')[0]!, { status: 'CONFIRMED', confirmationHash: HASH, confirmedById: t.cashier.id, confirmedAt: NOW });
  t.db.table('sale')[0]!.status = 'COMPLETED';
  const checkout = t.db.insert('saleCheckout', { saleId: t.sale.id, branchId: t.branch, operationKey: view.operationKey, attemptStatus: 'CONFIRMED', requestHash: HASH, total: 15000n, changeAmount: 0n, completedAt: NOW });
  return { req, view, checkout };
}
const paths = (t: ReturnType<typeof setup>, req: CheckoutReservationRequest) => ({
  getForSale: () => t.service.getForSale(t.asCashier, t.sale.id as string, req.reserveKey),
  listForSale: () => t.service.listForSale(t.asCashier, t.sale.id as string),
  replay: () => t.service.reserve(t.asCashier, t.sale.id as string, req),
});

describe('R3-A4.3 S4 REVISE — a CONFIRMED attempt never comes back without a coherent checkout', () => {
  const corruptions: Array<[string, (t: ReturnType<typeof setup>, c: Awaited<ReturnType<typeof confirmed>>) => void]> = [
    ['checkout missing', (t) => { t.db.tables.saleCheckout = []; }],
    ['checkout of another sale', (_t, c) => { c.checkout.saleId = randomUUID(); Object.assign(_t.db.table('saleCheckout')[0]!, { saleId: c.checkout.saleId }); }],
    ['the sale checkout belongs to another operation', (t) => { t.db.table('saleCheckout')[0]!.operationKey = randomUUID(); }],
    ['checkout hash differs from the confirmation hash', (t) => { t.db.table('saleCheckout')[0]!.requestHash = 'd'.repeat(64); }],
    ['checkout of another branch', (t) => { t.db.table('saleCheckout')[0]!.branchId = randomUUID(); }],
    ['a second checkout for the same sale', (t) => { t.db.insert('saleCheckout', { saleId: t.sale.id, branchId: t.branch, operationKey: randomUUID(), attemptStatus: 'CONFIRMED', requestHash: HASH, total: 1n, changeAmount: 0n, completedAt: NOW }); }],
    ['sale not COMPLETED', (t) => { t.db.table('sale')[0]!.status = 'PAID'; }],
  ];
  for (const [label, corrupt] of corruptions) {
    it(`I-${label}: 500 CHECKOUT_STATE_INCONSISTENT on GET by reserveKey, GET by sale and replay`, async () => {
      const t = setup();
      const c = await confirmed(t);
      corrupt(t, c);
      for (const [name, run] of Object.entries(paths(t, c.req))) {
        expect(await codeOf(run()), `${label} via ${name}`).toMatchObject({ status: 500, code: 'CHECKOUT_STATE_INCONSISTENT' });
      }
    });
  }

  it('I-valid: the coherent checkout is returned with ITS payments only; a payment of another operation is never mixed in', async () => {
    const t = setup();
    const c = await confirmed(t);
    t.db.insert('salePayment', { saleId: t.sale.id, checkoutId: c.checkout.id, method: 'CASH', tenderRole: 'BALANCE', amount: 15000n, methodFullPrice: 15000n, adjustmentBps: 0, externalCollectionId: null, receivedAmount: 15000n, changeAmount: 0n, paidAt: NOW });
    t.db.insert('salePayment', { saleId: t.sale.id, checkoutId: randomUUID(), method: 'TRANSFER', amount: 999n, externalCollectionId: null, paidAt: NOW });
    t.db.insert('salePayment', { saleId: t.sale.id, checkoutId: null, method: 'CASH', amount: 1n, externalCollectionId: null, paidAt: NOW });
    const result = await t.service.getForSale(t.asCashier, t.sale.id as string, c.req.reserveKey);
    expect(result.checkout).not.toBeNull();
    expect(result.checkout!.payments.map((payment) => [payment.method, payment.amount])).toEqual([['CASH', 15000n]]);
    expect((await t.service.listForSale(t.asCashier, t.sale.id as string)).recent[0]!.status).toBe('CONFIRMED');
    expect((await t.service.reserve(t.asCashier, t.sale.id as string, c.req)).view.status).toBe('CONFIRMED');
  });

  it('I-other states: RESERVED, REJECTED and ABANDONED keep their behaviour (no checkout required, checkout null)', async () => {
    for (const patch of [{}, { status: 'REJECTED', rejectionCode: 'NO_OPEN_CASH_SESSION' }, { status: 'ABANDONED', declaredAt: NOW, declaredById: 'u' }]) {
      const t = setup();
      const req = t.cashOnly();
      await t.service.reserve(t.asCashier, t.sale.id as string, req);
      Object.assign(t.db.table('checkoutAttempt')[0]!, patch);
      const result = await t.service.getForSale(t.asCashier, t.sale.id as string, req.reserveKey);
      expect(result.checkout, JSON.stringify(patch)).toBeNull();
      expect((await t.service.listForSale(t.asCashier, t.sale.id as string)).recent).toHaveLength(1);
    }
  });
});
