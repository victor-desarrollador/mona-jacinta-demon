// R3-A4.3 S6 — T-X (POST /sales/:saleId/checkout/reservations/:reserveKey/close)
// and its DB-free declaration contract, against tests/helpers/
// checkout-reservation-fake-db.ts. Approved design S6 + owner decisions
// 2026-10-16 (READ COMMITTED, Sale FOR UPDATE NOWAIT -> 55P03, no retries, the
// DOCUMENT 4 order: declarations -> declaredAt -> claim release).
//
// What PostgreSQL alone can prove (the F1–F6 triggers, the CHECK constraints,
// the partial unique indexes, real 55P03, the lock order under contention)
// stays in the opt-in *.pg.test.ts files: P52 in particular (release claimed
// only after declaredAt) is NOT proven here.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { AppError } from '../../src/shared/errors.js';
import { DEFAULT_ROLE_GRANTS } from '../../src/modules/rbac/role-permission-matrix.js';
import { type PlanTenderInput } from '../../src/modules/payments/checkout-canonical.js';
import { computeProportionalQuote } from '../../src/modules/pricing/proportional-checkout.js';
import { createCheckoutReservationService } from '../../src/modules/payments/checkout-reservation.service.js';
import { createCheckoutCloseService } from '../../src/modules/payments/checkout-close.service.js';
import { createCheckoutService } from '../../src/modules/payments/checkout.service.js';
import type { CheckoutReservationRequest } from '../../src/modules/payments/dto/checkout-reservation.dto.js';
import type { CheckoutCloseRequest, CheckoutDeclarationRow } from '../../src/modules/payments/dto/checkout-close.dto.js';
import type { CheckoutConfirmationRequest } from '../../src/modules/payments/dto/checkout.dto.js';
import { createCheckoutReservationFakeDb, p2002, p2002Adapter, type Row } from '../helpers/checkout-reservation-fake-db.js';

const NOW = new Date('2026-10-16T12:00:00.000Z');
const LATER = new Date(NOW.getTime() + 20 * 60_000);
const OP_KEYS = ['0f8fad5b-d9cb-469f-a165-70867728950e', '7c9e6679-7425-40de-944b-e07fc1f90ae7', 'e4eaaaf2-d142-41b9-a1d4-3b6c1b6e0f0b'];
const SERVICE_PATH = new URL('../../src/modules/payments/checkout-close.service.ts', import.meta.url);
const CONTROLLER_PATH = new URL('../../src/modules/payments/checkout-close.controller.ts', import.meta.url);
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
  const admin = db.insert('user', { id: uuid(), name: 'Admin' });
  const other = db.insert('user', { id: uuid(), name: 'Caja 2' });
  db.insert('company', { id: uuid(), createdAt: new Date(0) });
  if (options.pricing !== false) {
    db.insert('companyPricingConfig', {
      id: uuid(), companyId: db.table('company')[0]!.id, updatedAt: new Date('2026-10-01T00:00:00Z'), listAdjustmentBps: 0,
      creditCardAdjustmentBps: 0, debitCardAdjustmentBps: 300, bankTransferAdjustmentBps: 200, qrAdjustmentBps: 0,
    });
  }
  const register = db.insert('cashRegister', { id: uuid(), branchId: branch });
  const session = db.insert('cashSession', { id: uuid(), registerId: register.id, status: 'OPEN', expectedCash: 0n });
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
  const client = db.client as unknown as PrismaClient;
  const reservation = createCheckoutReservationService(client, { now: () => NOW, operationKey: () => OP_KEYS[next++ % OP_KEYS.length]!, externalMethodsEnabled: true });
  const close = createCheckoutCloseService(client, { now: () => NOW });
  const pricing = options.pricing === false ? null : { bankTransferAdjustmentBps: 200, debitCardAdjustmentBps: 300, creditCardAdjustmentBps: 0 };
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
    id: uuid(), branchId: branch, method: 'TRANSFER', amount: 5000n, reference: 'OP REF', referenceKey: 'OPREF', institution: 'GALICIA',
    institutionOther: null, status: 'UNAPPLIED', claimAttemptId: null, originSaleId: sale.id, recordedById: cashier.id, ...patch,
  });
  return {
    db, branch, cashier, admin, other, sale, session, register, reservation, close, request, cashOnly, collection,
    asCashier: auth(cashier.id as string, 'CASHIER', branch),
    asSupervisor: auth(admin.id as string, 'ADMIN', null),
    asOtherCashier: auth(other.id as string, 'CASHIER', branch),
  };
}

// A close request row: every field is explicit (the DTO always delivers them).
function d(method: 'CASH' | 'TRANSFER' | 'CARD_DEBIT' | 'CARD_CREDIT', patch: Partial<CheckoutDeclarationRow> = {}): CheckoutDeclarationRow {
  return {
    method, outcome: 'NONE', returnedAmount: null, amount: null, reference: null, referenceKey: null,
    institution: null, institutionOther: null, evidence: null, ...patch,
  };
}
const closeRequest = (declarations: CheckoutDeclarationRow[], supervisor: { reason: string; evidence: string } | null = null): CheckoutCloseRequest => ({ supervisor, declarations });
const JUSTIFICATION = { reason: 'motivo suficiente para la operación', evidence: 'cupón 1' };

const codeOf = async (promise: Promise<unknown>) => {
  try { await promise; return null; } catch (error) {
    if (!(error instanceof AppError)) throw error;
    return { status: error.status, code: error.code, details: error.details };
  }
};

// Reserve a plan and return the created attempt + the request that produced it.
async function reserved(t: ReturnType<typeof setup>, tenders?: PlanTenderInput[]) {
  const req = t.request(tenders ?? [{ method: 'CASH', role: 'BALANCE', source: 'NEW', amount: null, externalCollectionId: null }]);
  await t.reservation.reserve(t.asCashier, t.sale.id as string, req);
  return { req, attempt: t.db.table('checkoutAttempt')[0]! };
}

describe('R3-A4.3 S6 — T-X close/declaration', () => {
  it('S6-01 RESERVED -> ABANDONED by the initiator: one READ COMMITTED transaction, full declaration, audit; no stock/cash write', async () => {
    const t = setup();
    await reserved(t);
    const mark = t.db.ops.length;
    const result = await t.close.close(t.asCashier, t.sale.id as string, t.db.table('checkoutAttempt')[0]!.reserveKey as string, closeRequest([d('CASH')]));
    expect(result.replayed).toBe(false);
    expect(result.checkout).toBeNull();
    expect(result.view.status).toBe('ABANDONED');
    expect(result.view.declaration).toMatchObject({ declaredById: t.cashier.id, rows: [{ method: 'CASH', tenderSource: 'NEW', outcome: 'NONE' }] });
    expect(t.db.transactions.at(-1)).toEqual({ isolationLevel: 'ReadCommitted', timeout: 30_000 });
    const attempt = t.db.table('checkoutAttempt')[0]!;
    expect(attempt).toMatchObject({ status: 'ABANDONED', abandonedById: t.cashier.id, declaredById: t.cashier.id });
    expect(attempt.abandonedAt).toEqual(NOW);
    expect(attempt.declaredAt).toEqual(NOW);
    const actions = t.db.table('auditLog').slice(-2).map((row) => row.action);
    expect(actions).toEqual(['CHECKOUT_RESERVATION_ABANDONED', 'CHECKOUT_DECLARATION_RECORDED']);
    expect(t.db.table('auditLog').at(-1)).toMatchObject({ entityType: 'CheckoutAttempt', entityId: attempt.id, userId: t.cashier.id, branchId: t.branch });
    // The close touches neither stock nor cash.
    const after = t.db.writesSince(mark);
    expect(after.some((op) => op.model === 'stockReservation' || op.model === 'cashSession')).toBe(false);
  });

  it('S6-02 REJECTED without declaration -> declared, status stays REJECTED; no ABANDONED audit', async () => {
    const t = setup();
    await reserved(t);
    Object.assign(t.db.table('checkoutAttempt')[0]!, { status: 'REJECTED', rejectionCode: 'INVALID_SALE_STATE', rejectionDetails: { a: 1 }, rejectedById: t.cashier.id, rejectedAt: NOW });
    const result = await t.close.close(t.asCashier, t.sale.id as string, t.db.table('checkoutAttempt')[0]!.reserveKey as string, closeRequest([d('CASH')]));
    expect(result).toMatchObject({ replayed: false, checkout: null });
    expect(t.db.table('checkoutAttempt')[0]).toMatchObject({ status: 'REJECTED', declaredById: t.cashier.id });
    expect(t.db.table('checkoutAttempt')[0]!.declaredAt).toEqual(NOW);
    expect(t.db.table('auditLog').slice(1).map((row) => row.action)).toEqual(['CHECKOUT_DECLARATION_RECORDED']);
  });

  it('S6-03 a CONFIRMED attempt is immutable: replay its committed checkout with zero writes', async () => {
    const t = setup();
    const { req } = await reserved(t);
    const hash = 'c'.repeat(64);
    Object.assign(t.db.table('checkoutAttempt')[0]!, { status: 'CONFIRMED', confirmationHash: hash, confirmedById: t.cashier.id, confirmedAt: NOW });
    t.db.table('sale')[0]!.status = 'COMPLETED';
    const checkout = t.db.insert('saleCheckout', { saleId: t.sale.id, branchId: t.branch, operationKey: OP_KEYS[0], attemptStatus: 'CONFIRMED', requestHash: hash, total: 15000n, changeAmount: 0n, completedAt: NOW });
    t.db.insert('salePayment', { saleId: t.sale.id, checkoutId: checkout.id, method: 'CASH', tenderRole: 'BALANCE', amount: 15000n, methodFullPrice: 15000n, adjustmentBps: 0, externalCollectionId: null, receivedAmount: 15000n, changeAmount: 0n, paidAt: NOW });
    const mark = t.db.ops.length;
    const result = await t.close.close(t.asCashier, t.sale.id as string, req.reserveKey, closeRequest([d('CASH'), d('TRANSFER')]));
    expect(result.replayed).toBe(true);
    expect(result.checkout).toMatchObject({ checkoutId: checkout.id, total: 15000n, status: 'COMPLETED' });
    expect(result.view.status).toBe('CONFIRMED');
    expect(t.db.writesSince(mark)).toEqual([]);
  });

  it('S6-04 a foreign close without a supervisor is refused with 403 and writes nothing', async () => {
    const t = setup();
    await reserved(t);
    const mark = t.db.ops.length;
    expect(await codeOf(t.close.close(t.asOtherCashier, t.sale.id as string, t.db.table('checkoutAttempt')[0]!.reserveKey as string, closeRequest([d('CASH')]))))
      .toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect(t.db.writesSince(mark)).toEqual([]);
    expect(t.db.table('checkoutAttempt')[0]).toMatchObject({ status: 'RESERVED', declaredAt: null });
  });

  it('S6-05 a valid COMPANY-scoped ADMIN supervisor closes with reason/evidence (ABANDONED)', async () => {
    const t = setup();
    await reserved(t);
    const result = await t.close.close(t.asSupervisor, t.sale.id as string, t.db.table('checkoutAttempt')[0]!.reserveKey as string, closeRequest([d('CASH', { evidence: JUSTIFICATION.evidence })], JUSTIFICATION));
    expect(result.view.status).toBe('ABANDONED');
    expect(t.db.table('checkoutAttempt')[0]).toMatchObject({
      status: 'ABANDONED', abandonedById: t.admin.id, abandonReason: JUSTIFICATION.reason, abandonEvidence: JUSTIFICATION.evidence, declaredById: t.admin.id,
    });
    expect(t.db.table('auditLog').find((row) => row.action === 'CHECKOUT_RESERVATION_ABANDONED'))
      .toMatchObject({ entityType: 'CheckoutAttempt', after: { abandonReason: JUSTIFICATION.reason } });
  });

  it('S6-06 an invalid supervisor, a missing justification and a supervised row without evidence are refused', async () => {
    // A foreign CASHIER is not a supervisor.
    const invalid = setup();
    await reserved(invalid);
    expect(await codeOf(invalid.close.close(invalid.asOtherCashier, invalid.sale.id as string, invalid.db.table('checkoutAttempt')[0]!.reserveKey as string, closeRequest([d('CASH', { evidence: 'x' })], JUSTIFICATION))))
      .toMatchObject({ status: 403 });
    // A valid supervisor without the justification object.
    const missing = setup();
    await reserved(missing);
    expect(await codeOf(missing.close.close(missing.asSupervisor, missing.sale.id as string, missing.db.table('checkoutAttempt')[0]!.reserveKey as string, closeRequest([d('CASH')]))))
      .toMatchObject({ status: 403 });
    // A supervisor row without evidence is a 400 (F4).
    const noEvidence = setup();
    await reserved(noEvidence);
    expect(await codeOf(noEvidence.close.close(noEvidence.asSupervisor, noEvidence.sale.id as string, noEvidence.db.table('checkoutAttempt')[0]!.reserveKey as string, closeRequest([d('CASH')], JUSTIFICATION))))
      .toMatchObject({ status: 400, code: 'CHECKOUT_DECLARATION_EVIDENCE_REQUIRED' });
    expect(noEvidence.db.table('checkoutAttempt')[0]).toMatchObject({ status: 'RESERVED', declaredAt: null });
  });

  it('S6-07 the branch is the sale.branchId read under the sale lock; only a COMPANY ADMIN qualifies', async () => {
    const t = setup();
    const ec = t.collection({ method: 'CARD_DEBIT', amount: 4000n });
    await reserved(t, [
      { method: 'CASH', role: 'BALANCE', source: 'NEW', amount: null, externalCollectionId: null },
      { method: 'TRANSFER', role: 'FIXED', source: 'NEW', amount: 3000n, externalCollectionId: null },
      { method: 'CARD_DEBIT', role: 'FIXED', source: 'COLLECTION', amount: 4000n, externalCollectionId: ec.id as string },
    ]);
    const mark = t.db.ops.length;
    await t.close.close(t.asSupervisor, t.sale.id as string, t.db.table('checkoutAttempt')[0]!.reserveKey as string, closeRequest([d('CASH', { evidence: 'e' }), d('TRANSFER', { evidence: 'e' }), d('CARD_DEBIT', { evidence: 'e' })], JUSTIFICATION));
    expect(t.db.ops.slice(mark).filter((op) => op.kind === 'lock').map((op) => op.model)).toEqual(['Sale', 'CheckoutAttempt', 'ExternalCollection']);
    // A LOCATION-scoped ADMIN at the branch never qualifies as a supervisor.
    const loc = setup();
    await reserved(loc);
    const locationAdmin = auth(loc.admin.id as string, 'ADMIN', loc.branch);
    expect(await codeOf(loc.close.close(locationAdmin, loc.sale.id as string, loc.db.table('checkoutAttempt')[0]!.reserveKey as string, closeRequest([d('CASH', { evidence: 'e' })], JUSTIFICATION))))
      .toMatchObject({ status: 403 });
    // The initiator whose assignment is at another branch is refused.
    const other = setup();
    await reserved(other);
    const foreignAssignment = auth(other.cashier.id as string, 'CASHIER', uuid());
    expect(await codeOf(other.close.close(foreignAssignment, other.sale.id as string, other.db.table('checkoutAttempt')[0]!.reserveKey as string, closeRequest([d('CASH')]))))
      .toMatchObject({ status: 403 });
  });

  it('S6-08 the COLLECTION claim is released AFTER declarations and AFTER declaredAt', async () => {
    const t = setup();
    const ec = t.collection({ method: 'CARD_DEBIT', amount: 4000n });
    await reserved(t, [
      { method: 'CASH', role: 'BALANCE', source: 'NEW', amount: null, externalCollectionId: null },
      { method: 'CARD_DEBIT', role: 'FIXED', source: 'COLLECTION', amount: 4000n, externalCollectionId: ec.id as string },
    ]);
    const attemptId = t.db.table('checkoutAttempt')[0]!.id;
    expect(t.db.table('externalCollection')[0]!.claimAttemptId).toBe(attemptId);
    const mark = t.db.ops.length;
    await t.close.close(t.asCashier, t.sale.id as string, t.db.table('checkoutAttempt')[0]!.reserveKey as string, closeRequest([d('CASH'), d('CARD_DEBIT')]));
    const ops = t.db.ops.slice(mark);
    const abandonedAt = ops.findIndex((op) => op.kind === 'update' && op.model === 'checkoutAttempt' && (op.detail as Row).data && ((op.detail as Row).data as Row).status === 'ABANDONED');
    const declarationAt = ops.findIndex((op) => op.kind === 'create' && op.model === 'checkoutAttemptDeclaration');
    const declaredAt = ops.findIndex((op) => op.kind === 'update' && op.model === 'checkoutAttempt' && Boolean(((op.detail as Row).data as Row).declaredAt));
    const releaseAt = ops.findIndex((op) => op.kind === 'updateMany' && op.model === 'externalCollection');
    expect(abandonedAt).toBeGreaterThanOrEqual(0);
    expect(abandonedAt).toBeLessThan(declarationAt);
    expect(declarationAt).toBeLessThan(declaredAt);
    expect(declaredAt).toBeLessThan(releaseAt);
    expect(t.db.table('externalCollection')[0]!.claimAttemptId).toBeNull();
  });

  it('S6-09 a COLLECTION tender is never CHARGED (409, no write)', async () => {
    const t = setup();
    const ec = t.collection({ method: 'CARD_DEBIT', amount: 4000n });
    await reserved(t, [
      { method: 'CASH', role: 'BALANCE', source: 'NEW', amount: null, externalCollectionId: null },
      { method: 'CARD_DEBIT', role: 'FIXED', source: 'COLLECTION', amount: 4000n, externalCollectionId: ec.id as string },
    ]);
    const mark = t.db.ops.length;
    expect(await codeOf(t.close.close(t.asCashier, t.sale.id as string, t.db.table('checkoutAttempt')[0]!.reserveKey as string, closeRequest([
      d('CASH'), d('CARD_DEBIT', { outcome: 'CHARGED', amount: 4000n, reference: 'OP 9', referenceKey: 'OP9', evidence: 'cupon' }),
    ])))).toMatchObject({ status: 409, code: 'CHECKOUT_DECLARATION_MISMATCH' });
    expect(t.db.writesSince(mark)).toEqual([]);
    expect(t.db.table('checkoutAttempt')[0]).toMatchObject({ status: 'RESERVED', declaredAt: null });
    expect(t.db.table('externalCollection')[0]!.claimAttemptId).toBe(t.db.table('checkoutAttempt')[0]!.id);
  });

  it('S6-10 the declaration covers every tender with the sealed source; extra/missing methods are refused', async () => {
    const t = setup();
    const ec = t.collection({ method: 'CARD_DEBIT', amount: 4000n });
    await reserved(t, [
      { method: 'CASH', role: 'BALANCE', source: 'NEW', amount: null, externalCollectionId: null },
      { method: 'TRANSFER', role: 'FIXED', source: 'NEW', amount: 3000n, externalCollectionId: null },
      { method: 'CARD_DEBIT', role: 'FIXED', source: 'COLLECTION', amount: 4000n, externalCollectionId: ec.id as string },
    ]);
    const result = await t.close.close(t.asCashier, t.sale.id as string, t.db.table('checkoutAttempt')[0]!.reserveKey as string, closeRequest([d('CASH'), d('TRANSFER'), d('CARD_DEBIT')]));
    expect(result.view.declaration!.rows.map((row) => [row.method, row.tenderSource, row.outcome])).toEqual([
      ['CASH', 'NEW', 'NONE'], ['TRANSFER', 'NEW', 'NONE'], ['CARD_DEBIT', 'COLLECTION', 'NONE'],
    ]);
    const missing = setup();
    const ec2 = missing.collection({ method: 'CARD_DEBIT', amount: 4000n });
    await reserved(missing, [
      { method: 'CASH', role: 'BALANCE', source: 'NEW', amount: null, externalCollectionId: null },
      { method: 'CARD_DEBIT', role: 'FIXED', source: 'COLLECTION', amount: 4000n, externalCollectionId: ec2.id as string },
    ]);
    expect(await codeOf(missing.close.close(missing.asCashier, missing.sale.id as string, missing.db.table('checkoutAttempt')[0]!.reserveKey as string, closeRequest([d('CASH')]))))
      .toMatchObject({ status: 409, code: 'CHECKOUT_DECLARATION_MISMATCH' });
  });

  it('S6-11 every declaration row carries the actor as declaredById (single actor)', async () => {
    const t = setup();
    await reserved(t, [
      { method: 'CASH', role: 'BALANCE', source: 'NEW', amount: null, externalCollectionId: null },
      { method: 'TRANSFER', role: 'FIXED', source: 'NEW', amount: 3000n, externalCollectionId: null },
    ]);
    await t.close.close(t.asCashier, t.sale.id as string, t.db.table('checkoutAttempt')[0]!.reserveKey as string, closeRequest([d('CASH'), d('TRANSFER')]));
    expect(t.db.table('checkoutAttemptDeclaration').map((row) => row.declaredById)).toEqual([t.cashier.id, t.cashier.id]);
    expect(t.db.table('checkoutAttempt')[0]!.declaredById).toBe(t.cashier.id);
  });

  it('S6-12 CASH RETURNED keeps the BigInt amount and audits CHECKOUT_ATTEMPT_CASH_RETURNED', async () => {
    const t = setup();
    await reserved(t);
    const result = await t.close.close(t.asCashier, t.sale.id as string, t.db.table('checkoutAttempt')[0]!.reserveKey as string, closeRequest([d('CASH', { outcome: 'RETURNED', returnedAmount: 500n, evidence: 'vuelto' })]));
    expect(result.view.declaration!.rows[0]).toMatchObject({ outcome: 'RETURNED', returnedAmount: 500n, evidence: 'vuelto' });
    const declaration = t.db.table('checkoutAttemptDeclaration')[0]!;
    expect(declaration).toMatchObject({ returnedAmount: 500n, declaredById: t.cashier.id });
    expect(t.db.table('auditLog')).toContainEqual(expect.objectContaining({ action: 'CHECKOUT_ATTEMPT_CASH_RETURNED', entityType: 'CheckoutAttemptDeclaration', entityId: declaration.id }));
  });

  it('S6-13 an identical replay is a 200 with zero writes, zero audits', async () => {
    const t = setup();
    await reserved(t);
    const key = t.db.table('checkoutAttempt')[0]!.reserveKey as string;
    await t.close.close(t.asCashier, t.sale.id as string, key, closeRequest([d('CASH')]));
    const mark = t.db.ops.length;
    const audits = t.db.table('auditLog').length;
    const replay = await t.close.close(t.asCashier, t.sale.id as string, key, closeRequest([d('CASH')]));
    expect(replay).toMatchObject({ replayed: true, checkout: null });
    expect(replay.view.status).toBe('ABANDONED');
    expect(t.db.writesSince(mark)).toEqual([]);
    expect(t.db.table('auditLog')).toHaveLength(audits);
  });

  it('S6-13b a replay with different content is 409 CHECKOUT_DECLARATION_ALREADY_RECORDED', async () => {
    const t = setup();
    await reserved(t);
    const key = t.db.table('checkoutAttempt')[0]!.reserveKey as string;
    await t.close.close(t.asCashier, t.sale.id as string, key, closeRequest([d('CASH')]));
    const mark = t.db.ops.length;
    expect(await codeOf(t.close.close(t.asCashier, t.sale.id as string, key, closeRequest([d('CASH', { outcome: 'RETURNED', returnedAmount: 500n, evidence: 'x' })]))))
      .toMatchObject({ status: 409, code: 'CHECKOUT_DECLARATION_ALREADY_RECORDED' });
    expect(t.db.writesSince(mark)).toEqual([]);
  });

  it('S6-13c a replay by another (valid) actor is 409 CHECKOUT_DECLARATION_ALREADY_RECORDED', async () => {
    const t = setup();
    await reserved(t);
    const key = t.db.table('checkoutAttempt')[0]!.reserveKey as string;
    await t.close.close(t.asCashier, t.sale.id as string, key, closeRequest([d('CASH')]));
    const mark = t.db.ops.length;
    expect(await codeOf(t.close.close(t.asSupervisor, t.sale.id as string, key, closeRequest([d('CASH', { evidence: 'e' })], JUSTIFICATION))))
      .toMatchObject({ status: 409, code: 'CHECKOUT_DECLARATION_ALREADY_RECORDED' });
    expect(t.db.writesSince(mark)).toEqual([]);
  });

  it('S6-14 a NOWAIT lock failure (55P03) becomes 409 CHECKOUT_RESERVATION_BUSY, with no retry', async () => {
    const busy = () => Object.assign(new Error('could not obtain lock on row in relation "Sale"'), { code: 'P2010', meta: { code: '55P03' } });
    const t = setup();
    await reserved(t);
    t.db.failOn('sale', 'lock', busy);
    expect(await codeOf(t.close.close(t.asCashier, t.sale.id as string, t.db.table('checkoutAttempt')[0]!.reserveKey as string, closeRequest([d('CASH')]))))
      .toMatchObject({ status: 409, code: 'CHECKOUT_RESERVATION_BUSY' });
    expect(t.db.transactions).toHaveLength(2); // the reservation + ONE close attempt: no retry
    const messageOnly = setup();
    await reserved(messageOnly);
    messageOnly.db.failOn('sale', 'lock', () => new Error('deadlock 55P03 in Sale'));
    expect(await codeOf(messageOnly.close.close(messageOnly.asCashier, messageOnly.sale.id as string, messageOnly.db.table('checkoutAttempt')[0]!.reserveKey as string, closeRequest([d('CASH')]))))
      .toMatchObject({ status: 409, code: 'CHECKOUT_RESERVATION_BUSY' });
  });

  it('S6-15 a failing write rolls back the whole close (status, declarations, audits, claim)', async () => {
    const t = setup();
    const ec = t.collection({ method: 'CARD_DEBIT', amount: 4000n });
    await reserved(t, [
      { method: 'CASH', role: 'BALANCE', source: 'NEW', amount: null, externalCollectionId: null },
      { method: 'CARD_DEBIT', role: 'FIXED', source: 'COLLECTION', amount: 4000n, externalCollectionId: ec.id as string },
    ]);
    const attemptId = t.db.table('checkoutAttempt')[0]!.id;
    t.db.failOn('auditLog', 'create', () => new Error('audit down'), false);
    await expect(t.close.close(t.asCashier, t.sale.id as string, t.db.table('checkoutAttempt')[0]!.reserveKey as string, closeRequest([d('CASH'), d('CARD_DEBIT')]))).rejects.toThrow('audit down');
    expect(t.db.table('checkoutAttempt')[0]).toMatchObject({ status: 'RESERVED', declaredAt: null });
    expect(t.db.table('checkoutAttemptDeclaration')).toHaveLength(0);
    expect(t.db.table('auditLog')).toHaveLength(1); // only CHECKOUT_RESERVED survives
    expect(t.db.table('externalCollection')[0]!.claimAttemptId).toBe(attemptId);
  });

  it('S6-16 the audit rows share one transaction with the close, on the sale branch', async () => {
    const t = setup();
    await reserved(t);
    await t.close.close(t.asCashier, t.sale.id as string, t.db.table('checkoutAttempt')[0]!.reserveKey as string, closeRequest([d('CASH')]));
    const closeAudits = t.db.table('auditLog').slice(1);
    expect(closeAudits.map((row) => row.action)).toEqual(['CHECKOUT_RESERVATION_ABANDONED', 'CHECKOUT_DECLARATION_RECORDED']);
    for (const audit of closeAudits) expect(audit).toMatchObject({ userId: t.cashier.id, branchId: t.branch });
  });

  it('S6-17 the close service and controller never emit realtime', () => {
    for (const path of [SERVICE_PATH, CONTROLLER_PATH]) {
      const source = readFileSync(path, 'utf8');
      expect(source).not.toMatch(/RealtimeEmitter|realtime\/socket|from '.*realtime|\.emit\(/);
    }
  });

  it('S6-18 a CHARGED amount must be exactly the sealed plan amount (FIXED tender and BALANCE alike)', async () => {
    const t = setup();
    await reserved(t, [
      { method: 'CASH', role: 'FIXED', source: 'NEW', amount: 2000n, externalCollectionId: null },
      { method: 'TRANSFER', role: 'BALANCE', source: 'NEW', amount: null, externalCollectionId: null },
    ]);
    const sealed = t.db.table('checkoutAttempt')[0]!.expectedBalanceAmount as bigint;
    const result = await t.close.close(t.asCashier, t.sale.id as string, t.db.table('checkoutAttempt')[0]!.reserveKey as string, closeRequest([
      d('CASH'), d('TRANSFER', { outcome: 'CHARGED', amount: sealed, reference: 'OP 123', referenceKey: 'OP123', institution: 'GALICIA', evidence: 'comprobante' }),
    ]));
    expect(result.view.status).toBe('ABANDONED');
    expect(t.db.table('externalCollection').filter((row) => row.originAttemptId === t.db.table('checkoutAttempt')[0]!.id)[0]).toMatchObject({ amount: sealed });
  });

  it('S6-18b a CHARGED amount that is not the sealed amount is 409 CHECKOUT_DECLARATION_AMOUNT_MISMATCH', async () => {
    const t = setup();
    await reserved(t, [
      { method: 'CASH', role: 'FIXED', source: 'NEW', amount: 2000n, externalCollectionId: null },
      { method: 'TRANSFER', role: 'BALANCE', source: 'NEW', amount: null, externalCollectionId: null },
    ]);
    const sealed = t.db.table('checkoutAttempt')[0]!.expectedBalanceAmount as bigint;
    const mark = t.db.ops.length;
    expect(await codeOf(t.close.close(t.asCashier, t.sale.id as string, t.db.table('checkoutAttempt')[0]!.reserveKey as string, closeRequest([
      d('CASH'), d('TRANSFER', { outcome: 'CHARGED', amount: sealed + 100n, reference: 'OP 123', referenceKey: 'OP123', institution: 'GALICIA', evidence: 'comprobante' }),
    ])))).toMatchObject({ status: 409, code: 'CHECKOUT_DECLARATION_AMOUNT_MISMATCH' });
    expect(t.db.writesSince(mark)).toEqual([]);
  });

  it('S6-19 a CHARGED row creates an UNAPPLIED ExternalCollection bound to the attempt/sale/branch/method/actor', async () => {
    const t = setup();
    await reserved(t, [
      { method: 'CASH', role: 'FIXED', source: 'NEW', amount: 2000n, externalCollectionId: null },
      { method: 'TRANSFER', role: 'BALANCE', source: 'NEW', amount: null, externalCollectionId: null },
    ]);
    const attempt = t.db.table('checkoutAttempt')[0]!;
    await t.close.close(t.asCashier, t.sale.id as string, attempt.reserveKey as string, closeRequest([
      d('CASH'), d('TRANSFER', { outcome: 'CHARGED', amount: attempt.expectedBalanceAmount as bigint, reference: 'OP 123', referenceKey: 'OP123', institution: 'GALICIA', evidence: 'comprobante' }),
    ]));
    const created = t.db.table('externalCollection').find((row) => row.originAttemptId === attempt.id);
    expect(created).toMatchObject({
      status: 'UNAPPLIED', branchId: t.branch, method: 'TRANSFER', originSaleId: t.sale.id, originAttemptId: attempt.id,
      recordedById: t.cashier.id, reference: 'OP 123', referenceKey: 'OP123', institution: 'GALICIA',
    });
    expect(created!.claimAttemptId ?? null).toBeNull();
    const declaration = t.db.table('checkoutAttemptDeclaration').find((row) => row.method === 'TRANSFER');
    expect(declaration).toMatchObject({ outcome: 'CHARGED', externalCollectionId: created!.id, declaredById: t.cashier.id });
  });

  it('S6-19c a CHARGED CARD_CREDIT row creates one UNAPPLIED CARD_CREDIT collection with a reference and no institution', async () => {
    const t = setup();
    await reserved(t, [
      { method: 'CASH', role: 'FIXED', source: 'NEW', amount: 2000n, externalCollectionId: null },
      { method: 'CARD_CREDIT', role: 'BALANCE', source: 'NEW', amount: null, externalCollectionId: null },
    ]);
    const attempt = t.db.table('checkoutAttempt')[0]!;
    expect(attempt).toMatchObject({ balanceMethod: 'CARD_CREDIT', algorithmVersion: 2, creditAdjustmentBps: 0 });
    await t.close.close(t.asCashier, t.sale.id as string, attempt.reserveKey as string, closeRequest([
      d('CASH'), d('CARD_CREDIT', { outcome: 'CHARGED', amount: attempt.expectedBalanceAmount as bigint, reference: 'CRD 123', referenceKey: 'CRD123', evidence: 'cupón' }),
    ]));
    const created = t.db.table('externalCollection').filter((row) => row.originAttemptId === attempt.id);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      status: 'UNAPPLIED', branchId: t.branch, method: 'CARD_CREDIT', amount: attempt.expectedBalanceAmount,
      reference: 'CRD 123', referenceKey: 'CRD123', institution: null, institutionOther: null,
    });
  });

  it('S6-20c a recorded CARD_CREDIT reference of the branch is 409 EXTERNAL_REFERENCE_ALREADY_RECORDED with no write; a debit with the same key is another namespace', async () => {
    const tenders: PlanTenderInput[] = [
      { method: 'CASH', role: 'FIXED', source: 'NEW', amount: 2000n, externalCollectionId: null },
      { method: 'CARD_CREDIT', role: 'BALANCE', source: 'NEW', amount: null, externalCollectionId: null },
    ];
    const clash = setup();
    await reserved(clash, tenders);
    clash.collection({ method: 'CARD_CREDIT', amount: 100n, reference: 'CRD 123', referenceKey: 'CRD123', institution: null });
    const attempt = clash.db.table('checkoutAttempt')[0]!;
    const row = d('CARD_CREDIT', { outcome: 'CHARGED', amount: attempt.expectedBalanceAmount as bigint, reference: 'crd-123', referenceKey: 'CRD123', evidence: 'cupón' });
    expect(await codeOf(clash.close.close(clash.asCashier, clash.sale.id as string, attempt.reserveKey as string, closeRequest([d('CASH'), row]))))
      .toMatchObject({ status: 409, code: 'EXTERNAL_REFERENCE_ALREADY_RECORDED' });
    expect(clash.db.table('checkoutAttempt')[0]).toMatchObject({ status: 'RESERVED', declaredAt: null });
    expect(clash.db.table('checkoutAttemptDeclaration')).toHaveLength(0);
    expect(clash.db.table('externalCollection')).toHaveLength(1);

    const other = setup();
    await reserved(other, tenders);
    other.collection({ method: 'CARD_DEBIT', amount: 100n, reference: 'CRD 123', referenceKey: 'CRD123', institution: null });
    const attempt2 = other.db.table('checkoutAttempt')[0]!;
    await other.close.close(other.asCashier, other.sale.id as string, attempt2.reserveKey as string, closeRequest([
      d('CASH'), d('CARD_CREDIT', { outcome: 'CHARGED', amount: attempt2.expectedBalanceAmount as bigint, reference: 'CRD 123', referenceKey: 'CRD123', evidence: 'cupón' }),
    ]));
    expect(other.db.table('externalCollection').filter((r) => r.method === 'CARD_CREDIT')).toHaveLength(1);
  });

  it('S6-20 a partial-reference P2002 maps to 409 EXTERNAL_REFERENCE_ALREADY_RECORDED and rolls the close back; an unrelated P2002 is rethrown', async () => {
    const referenceCollision = setup();
    await reserved(referenceCollision, [
      { method: 'CASH', role: 'FIXED', source: 'NEW', amount: 2000n, externalCollectionId: null },
      { method: 'TRANSFER', role: 'BALANCE', source: 'NEW', amount: null, externalCollectionId: null },
    ]);
    const attempt = referenceCollision.db.table('checkoutAttempt')[0]!;
    referenceCollision.db.failOn('externalCollection', 'create', () => p2002('ExternalCollection_transfer_ref_key'));
    expect(await codeOf(referenceCollision.close.close(referenceCollision.asCashier, referenceCollision.sale.id as string, attempt.reserveKey as string, closeRequest([
      d('CASH'), d('TRANSFER', { outcome: 'CHARGED', amount: attempt.expectedBalanceAmount as bigint, reference: 'OP 123', referenceKey: 'OP123', institution: 'GALICIA', evidence: 'comprobante' }),
    ])))).toMatchObject({ status: 409, code: 'EXTERNAL_REFERENCE_ALREADY_RECORDED' });
    expect(referenceCollision.db.table('checkoutAttempt')[0]).toMatchObject({ status: 'RESERVED', declaredAt: null });
    expect(referenceCollision.db.table('checkoutAttemptDeclaration')).toHaveLength(0);

    const unrelated = setup();
    await reserved(unrelated, [
      { method: 'CASH', role: 'FIXED', source: 'NEW', amount: 2000n, externalCollectionId: null },
      { method: 'TRANSFER', role: 'BALANCE', source: 'NEW', amount: null, externalCollectionId: null },
    ]);
    const attempt2 = unrelated.db.table('checkoutAttempt')[0]!;
    const raw = p2002(['unrelated_target']);
    unrelated.db.failOn('externalCollection', 'create', () => raw);
    await expect(unrelated.close.close(unrelated.asCashier, unrelated.sale.id as string, attempt2.reserveKey as string, closeRequest([
      d('CASH'), d('TRANSFER', { outcome: 'CHARGED', amount: attempt2.expectedBalanceAmount as bigint, reference: 'OP 123', referenceKey: 'OP123', institution: 'GALICIA', evidence: 'comprobante' }),
    ]))).rejects.toBe(raw);
  });

  it('S6-21 releasing a COLLECTION claim is audited as EXTERNAL_COLLECTION_CLAIM_RELEASED', async () => {
    const t = setup();
    const ec = t.collection({ method: 'CARD_DEBIT', amount: 4000n });
    await reserved(t, [
      { method: 'CASH', role: 'BALANCE', source: 'NEW', amount: null, externalCollectionId: null },
      { method: 'CARD_DEBIT', role: 'FIXED', source: 'COLLECTION', amount: 4000n, externalCollectionId: ec.id as string },
    ]);
    await t.close.close(t.asCashier, t.sale.id as string, t.db.table('checkoutAttempt')[0]!.reserveKey as string, closeRequest([d('CASH'), d('CARD_DEBIT')]));
    expect(t.db.table('auditLog')).toContainEqual(expect.objectContaining({
      action: 'EXTERNAL_COLLECTION_CLAIM_RELEASED', entityType: 'ExternalCollection', entityId: ec.id,
      before: { claimAttemptId: t.db.table('checkoutAttempt')[0]!.id }, after: { claimAttemptId: null },
    }));
  });

  it('S6-22 a CASH RETURNED writes no CashMovement and no cash-session row', async () => {
    const t = setup();
    await reserved(t);
    const mark = t.db.ops.length;
    await t.close.close(t.asCashier, t.sale.id as string, t.db.table('checkoutAttempt')[0]!.reserveKey as string, closeRequest([d('CASH', { outcome: 'RETURNED', returnedAmount: 500n, evidence: 'vuelto' })]));
    const writes = t.db.writesSince(mark);
    expect(writes.some((op) => op.model === 'cashSession' || op.model === 'cashMovement')).toBe(false);
    expect(t.db.table('salePayment')).toHaveLength(0);
  });

  it('S6-23 a CASH RETURNED does not change expectedCash and leaves the sale PENDING_PAYMENT', async () => {
    const t = setup();
    t.db.table('cashSession')[0]!.expectedCash = 1234n;
    await reserved(t);
    await t.close.close(t.asCashier, t.sale.id as string, t.db.table('checkoutAttempt')[0]!.reserveKey as string, closeRequest([d('CASH', { outcome: 'RETURNED', returnedAmount: 500n, evidence: 'vuelto' })]));
    expect(t.db.table('cashSession')[0]!.expectedCash).toBe(1234n);
    expect(t.db.table('sale')[0]!.status).toBe('PENDING_PAYMENT');
  });

  it('S6-24 the close writes no StockReservation and no Inventory', async () => {
    const t = setup();
    const ec = t.collection({ method: 'CARD_DEBIT', amount: 4000n });
    await reserved(t, [
      { method: 'CASH', role: 'BALANCE', source: 'NEW', amount: null, externalCollectionId: null },
      { method: 'CARD_DEBIT', role: 'FIXED', source: 'COLLECTION', amount: 4000n, externalCollectionId: ec.id as string },
    ]);
    const mark = t.db.ops.length;
    await t.close.close(t.asCashier, t.sale.id as string, t.db.table('checkoutAttempt')[0]!.reserveKey as string, closeRequest([d('CASH'), d('CARD_DEBIT')]));
    const writes = t.db.writesSince(mark);
    expect(writes.some((op) => op.model === 'stockReservation' || op.model === 'inventory' || op.model === 'stockMovement')).toBe(false);
    expect(t.db.table('stockReservation').every((row) => row.status === 'ACTIVE')).toBe(true);
  });

  // S6-25: DB-free contract test only. The PostgreSQL proof is P55 (a T-X
  // racing a T-C on the same attempt), which stays NOT RUN.
  it('S6-25 T-C never confirms a closed (ABANDONED) attempt: 409 CHECKOUT_RESERVATION_CLOSED', async () => {
    const t = setup();
    const { req } = await reserved(t);
    await t.close.close(t.asCashier, t.sale.id as string, req.reserveKey, closeRequest([d('CASH')]));
    expect(t.db.table('checkoutAttempt')[0]!.status).toBe('ABANDONED');
    const confirmation: CheckoutConfirmationRequest = { reserveKey: req.reserveKey, operationKey: OP_KEYS[0], tenders: [], supervisor: null };
    const checkout = createCheckoutService(t.db.client as unknown as PrismaClient);
    expect(await codeOf(checkout.checkout(t.asCashier, t.cashier.id as string, t.sale.id as string, confirmation)))
      .toMatchObject({ status: 409, code: 'CHECKOUT_RESERVATION_CLOSED' });
    expect(t.db.table('salePayment')).toHaveLength(0);
  });

  it('the close service is deterministic: no source path ever reads a secret or a real DB', () => {
    const source = readFileSync(SERVICE_PATH, 'utf8');
    expect(source).not.toMatch(/process\.env|DATABASE_URL|TEST_DATABASE_URL/);
    expect(source).not.toMatch(/Number\(|parseFloat|parseInt|toFixed|Math\./);
  });
});

// ---------------------------------------------------------------------------
// R3-A4.3 S6.1 — review fixes S6-B01..S6-B04 and the T-C/T-X
// CHECKOUT_RESERVATION_CLOSED gap. DB-free (in-memory double) only.
// ---------------------------------------------------------------------------
const EPOCH = new Date(0);
const touches = (ops: Array<{ kind: string; model?: string }>) => ops.filter((op) => op.kind === 'touch' && op.model === 'Sale');
const reject = (t: ReturnType<typeof setup>) => Object.assign(t.db.table('checkoutAttempt')[0]!, {
  status: 'REJECTED', rejectionCode: 'INVALID_SALE_STATE', rejectionDetails: { a: 1 }, rejectedById: t.cashier.id, rejectedAt: NOW,
});
// CASH (BALANCE, NEW) + TRANSFER (FIXED 3000, NEW) + CARD_DEBIT (FIXED 4000, COLLECTION).
async function fullPlan(t: ReturnType<typeof setup>) {
  const ec = t.collection({ method: 'CARD_DEBIT', amount: 4000n });
  await reserved(t, [
    { method: 'CASH', role: 'BALANCE', source: 'NEW', amount: null, externalCollectionId: null },
    { method: 'TRANSFER', role: 'FIXED', source: 'NEW', amount: 3000n, externalCollectionId: null },
    { method: 'CARD_DEBIT', role: 'FIXED', source: 'COLLECTION', amount: 4000n, externalCollectionId: ec.id as string },
  ]);
  const declarations = [
    d('CASH', { outcome: 'RETURNED', returnedAmount: 500n, evidence: 'vuelto' }),
    d('TRANSFER', { outcome: 'CHARGED', amount: 3000n, reference: 'OP 123', referenceKey: 'OP123', institution: 'GALICIA', evidence: 'comprobante' }),
    d('CARD_DEBIT'),
  ];
  return { ec, declarations, attempt: t.db.table('checkoutAttempt')[0]! };
}
const chargedTransfer = async (t: ReturnType<typeof setup>) => {
  await reserved(t, [
    { method: 'CASH', role: 'FIXED', source: 'NEW', amount: 2000n, externalCollectionId: null },
    { method: 'TRANSFER', role: 'BALANCE', source: 'NEW', amount: null, externalCollectionId: null },
  ]);
  const attempt = t.db.table('checkoutAttempt')[0]!;
  return {
    attempt,
    declarations: [d('CASH'), d('TRANSFER', { outcome: 'CHARGED', amount: attempt.expectedBalanceAmount as bigint, reference: 'OP 123', referenceKey: 'OP123', institution: 'GALICIA', evidence: 'comprobante' })],
  };
};
const supervisedRejected = async (t: ReturnType<typeof setup>) => {
  await reserved(t);
  reject(t);
  const key = t.db.table('checkoutAttempt')[0]!.reserveKey as string;
  await t.close.close(t.asSupervisor, t.sale.id as string, key, closeRequest([d('CASH', { evidence: JUSTIFICATION.evidence })], JUSTIFICATION));
  return key;
};

describe('R3-A4.3 S6.1 — S6-B01 visibility bump', () => {
  it('S6F-01 a fresh RESERVED close bumps Sale.updatedAt after the locks and before any attempt write', async () => {
    const t = setup();
    await reserved(t);
    t.db.table('sale')[0]!.updatedAt = EPOCH;
    const mark = t.db.ops.length;
    await t.close.close(t.asCashier, t.sale.id as string, t.db.table('checkoutAttempt')[0]!.reserveKey as string, closeRequest([d('CASH')]));
    expect(t.db.table('sale')[0]!.updatedAt).toEqual(NOW);
    const ops = t.db.ops.slice(mark);
    expect(touches(ops)).toHaveLength(1);
    const touchAt = ops.findIndex((op) => op.kind === 'touch');
    const attemptLockAt = ops.findIndex((op) => op.kind === 'lock' && op.model === 'CheckoutAttempt');
    const firstWriteAt = ops.findIndex((op) => ['create', 'update', 'updateMany'].includes(op.kind));
    expect(attemptLockAt).toBeLessThan(touchAt);
    expect(touchAt).toBeLessThan(firstWriteAt);
    expect(ops[firstWriteAt]).toMatchObject({ kind: 'update', model: 'checkoutAttempt' });
  });

  it('S6F-02 a fresh REJECTED declaration bumps Sale.updatedAt before the first declaration', async () => {
    const t = setup();
    await reserved(t);
    reject(t);
    t.db.table('sale')[0]!.updatedAt = EPOCH;
    const mark = t.db.ops.length;
    await t.close.close(t.asCashier, t.sale.id as string, t.db.table('checkoutAttempt')[0]!.reserveKey as string, closeRequest([d('CASH')]));
    expect(t.db.table('sale')[0]!.updatedAt).toEqual(NOW);
    const ops = t.db.ops.slice(mark);
    expect(touches(ops)).toHaveLength(1);
    expect(ops.findIndex((op) => op.kind === 'touch')).toBeLessThan(ops.findIndex((op) => op.kind === 'create' && op.model === 'checkoutAttemptDeclaration'));
  });

  it('S6F-03 no replay bumps: identical ABANDONED replay, identical declared REJECTED replay, CONFIRMED replay', async () => {
    const abandoned = setup();
    await reserved(abandoned);
    const key = abandoned.db.table('checkoutAttempt')[0]!.reserveKey as string;
    await abandoned.close.close(abandoned.asCashier, abandoned.sale.id as string, key, closeRequest([d('CASH')]));
    abandoned.db.table('sale')[0]!.updatedAt = EPOCH;
    let mark = abandoned.db.ops.length;
    expect((await abandoned.close.close(abandoned.asCashier, abandoned.sale.id as string, key, closeRequest([d('CASH')]))).replayed).toBe(true);
    expect(touches(abandoned.db.ops.slice(mark))).toEqual([]);
    expect(abandoned.db.table('sale')[0]!.updatedAt).toEqual(EPOCH);

    const rejected = setup();
    const rejectedKey = await supervisedRejected(rejected);
    rejected.db.table('sale')[0]!.updatedAt = EPOCH;
    mark = rejected.db.ops.length;
    expect((await rejected.close.close(rejected.asSupervisor, rejected.sale.id as string, rejectedKey, closeRequest([d('CASH', { evidence: JUSTIFICATION.evidence })], JUSTIFICATION))).replayed).toBe(true);
    expect(touches(rejected.db.ops.slice(mark))).toEqual([]);
    expect(rejected.db.table('sale')[0]!.updatedAt).toEqual(EPOCH);

    const confirmed = setup();
    const { req } = await reserved(confirmed);
    Object.assign(confirmed.db.table('checkoutAttempt')[0]!, { status: 'CONFIRMED', confirmationHash: 'c'.repeat(64), confirmedById: confirmed.cashier.id, confirmedAt: NOW });
    const checkout = confirmed.db.insert('saleCheckout', { saleId: confirmed.sale.id, branchId: confirmed.branch, operationKey: OP_KEYS[0], attemptStatus: 'CONFIRMED', requestHash: 'c'.repeat(64), total: 15000n, changeAmount: 0n, completedAt: NOW });
    confirmed.db.insert('salePayment', { saleId: confirmed.sale.id, checkoutId: checkout.id, method: 'CASH', tenderRole: 'BALANCE', amount: 15000n, methodFullPrice: 15000n, adjustmentBps: 0, externalCollectionId: null, receivedAmount: 15000n, changeAmount: 0n, paidAt: NOW });
    Object.assign(confirmed.db.table('sale')[0]!, { status: 'COMPLETED', updatedAt: EPOCH });
    mark = confirmed.db.ops.length;
    await confirmed.close.close(confirmed.asCashier, confirmed.sale.id as string, req.reserveKey, closeRequest([d('CASH')]));
    expect(touches(confirmed.db.ops.slice(mark))).toEqual([]);
    expect(confirmed.db.table('sale')[0]!.updatedAt).toEqual(EPOCH);
  });

  it('S6F-04 a failure after the bump rolls Sale.updatedAt back', async () => {
    const t = setup();
    await reserved(t);
    t.db.table('sale')[0]!.updatedAt = EPOCH;
    t.db.failOn('checkoutAttemptDeclaration', 'create', () => new Error('declaration down'));
    const mark = t.db.ops.length;
    await expect(t.close.close(t.asCashier, t.sale.id as string, t.db.table('checkoutAttempt')[0]!.reserveKey as string, closeRequest([d('CASH')]))).rejects.toThrow('declaration down');
    // The bump DID run inside T-X, and the rollback undid it.
    expect(touches(t.db.ops.slice(mark))).toHaveLength(1);
    expect(t.db.ops.at(-1)).toEqual({ kind: 'rollback' });
    expect(t.db.table('sale')[0]!.updatedAt).toEqual(EPOCH);
    expect(t.db.table('checkoutAttempt')[0]).toMatchObject({ status: 'RESERVED', declaredAt: null });
  });

  it('S6F-05 a 55P03 on the Sale lock leaves no bump and no retry', async () => {
    const t = setup();
    await reserved(t);
    t.db.table('sale')[0]!.updatedAt = EPOCH;
    t.db.failOn('sale', 'lock', () => Object.assign(new Error('could not obtain lock on row in relation "Sale"'), { code: 'P2010', meta: { code: '55P03' } }));
    const mark = t.db.ops.length;
    expect(await codeOf(t.close.close(t.asCashier, t.sale.id as string, t.db.table('checkoutAttempt')[0]!.reserveKey as string, closeRequest([d('CASH')]))))
      .toMatchObject({ status: 409, code: 'CHECKOUT_RESERVATION_BUSY' });
    expect(touches(t.db.ops.slice(mark))).toEqual([]);
    expect(t.db.table('sale')[0]!.updatedAt).toEqual(EPOCH);
    expect(t.db.transactions).toHaveLength(2);
  });
});

describe('R3-A4.3 S6.1 — S6-B02 supervisor justification on REJECTED', () => {
  it('S6F-06 a supervisor closes a REJECTED attempt: reason/evidence are durable in the declaration audit; no abandon* column is written', async () => {
    const t = setup();
    await supervisedRejected(t);
    const attempt = t.db.table('checkoutAttempt')[0]!;
    expect(attempt).toMatchObject({ status: 'REJECTED', declaredById: t.admin.id, abandonReason: null, abandonEvidence: null });
    const audit = t.db.table('auditLog').filter((row) => row.action === 'CHECKOUT_DECLARATION_RECORDED' && row.entityId === attempt.id);
    expect(audit).toHaveLength(1);
    expect((audit[0]!.after as Row).supervisor).toEqual(JUSTIFICATION);
  });

  it('S6F-07 an identical supervised REJECTED replay is 200 with zero writes; another actor is 409', async () => {
    const t = setup();
    const key = await supervisedRejected(t);
    const mark = t.db.ops.length;
    const replay = await t.close.close(t.asSupervisor, t.sale.id as string, key, closeRequest([d('CASH', { evidence: JUSTIFICATION.evidence })], JUSTIFICATION));
    expect(replay).toMatchObject({ replayed: true, checkout: null });
    expect(t.db.writesSince(mark)).toEqual([]);
    expect(await codeOf(t.close.close(t.asCashier, t.sale.id as string, key, closeRequest([d('CASH')]))))
      .toMatchObject({ status: 409, code: 'CHECKOUT_DECLARATION_ALREADY_RECORDED' });
    expect(t.db.writesSince(mark)).toEqual([]);
  });

  it('S6F-08 a supervised REJECTED replay with a changed reason is 409, zero writes', async () => {
    const t = setup();
    const key = await supervisedRejected(t);
    const mark = t.db.ops.length;
    expect(await codeOf(t.close.close(t.asSupervisor, t.sale.id as string, key, closeRequest([d('CASH', { evidence: JUSTIFICATION.evidence })], { ...JUSTIFICATION, reason: 'otro motivo suficiente distinto' }))))
      .toMatchObject({ status: 409, code: 'CHECKOUT_DECLARATION_ALREADY_RECORDED' });
    expect(t.db.writesSince(mark)).toEqual([]);
  });

  it('S6F-09 a supervised REJECTED replay with a changed supervisor evidence is 409, zero writes', async () => {
    const t = setup();
    const key = await supervisedRejected(t);
    const mark = t.db.ops.length;
    expect(await codeOf(t.close.close(t.asSupervisor, t.sale.id as string, key, closeRequest([d('CASH', { evidence: JUSTIFICATION.evidence })], { ...JUSTIFICATION, evidence: 'cupón 2' }))))
      .toMatchObject({ status: 409, code: 'CHECKOUT_DECLARATION_ALREADY_RECORDED' });
    expect(t.db.writesSince(mark)).toEqual([]);
  });

  it('S6F-10 the declaration audit carries the exact supervisor reason/evidence, actor and branch', async () => {
    const t = setup();
    await supervisedRejected(t);
    const attempt = t.db.table('checkoutAttempt')[0]!;
    expect(t.db.table('auditLog').find((row) => row.action === 'CHECKOUT_DECLARATION_RECORDED')).toMatchObject({
      userId: t.admin.id, branchId: t.branch, entityType: 'CheckoutAttempt', entityId: attempt.id,
      after: { status: 'REJECTED', declaredById: t.admin.id, supervisor: { reason: JUSTIFICATION.reason, evidence: JUSTIFICATION.evidence } },
    });
  });

  it('S6F-10b a supervised REJECTED replay whose declaration audit is missing or duplicated fails closed (500), zero writes', async () => {
    const missing = setup();
    const key = await supervisedRejected(missing);
    missing.db.tables.auditLog = missing.db.table('auditLog').filter((row) => row.action !== 'CHECKOUT_DECLARATION_RECORDED');
    let mark = missing.db.ops.length;
    expect(await codeOf(missing.close.close(missing.asSupervisor, missing.sale.id as string, key, closeRequest([d('CASH', { evidence: JUSTIFICATION.evidence })], JUSTIFICATION))))
      .toMatchObject({ status: 500, code: 'CHECKOUT_STATE_INCONSISTENT' });
    expect(missing.db.writesSince(mark)).toEqual([]);

    const duplicated = setup();
    const key2 = await supervisedRejected(duplicated);
    const original = duplicated.db.table('auditLog').find((row) => row.action === 'CHECKOUT_DECLARATION_RECORDED')!;
    duplicated.db.insert('auditLog', { ...original, id: uuid() });
    mark = duplicated.db.ops.length;
    expect(await codeOf(duplicated.close.close(duplicated.asSupervisor, duplicated.sale.id as string, key2, closeRequest([d('CASH', { evidence: JUSTIFICATION.evidence })], JUSTIFICATION))))
      .toMatchObject({ status: 500, code: 'CHECKOUT_STATE_INCONSISTENT' });
    expect(duplicated.db.writesSince(mark)).toEqual([]);
  });
});

describe('R3-A4.3 S6.1 — S6-B03 CHARGED cashSessionId', () => {
  it('S6F-11 a CHARGED ExternalCollection carries attempt.cashSessionId (and the rest of its binding)', async () => {
    const t = setup();
    const { attempt, declarations } = await chargedTransfer(t);
    await t.close.close(t.asCashier, t.sale.id as string, attempt.reserveKey as string, closeRequest(declarations));
    expect(t.db.table('externalCollection').find((row) => row.originAttemptId === attempt.id)).toMatchObject({
      cashSessionId: attempt.cashSessionId, status: 'UNAPPLIED', originAttemptId: attempt.id, originSaleId: t.sale.id,
      branchId: t.branch, method: 'TRANSFER', recordedById: t.cashier.id,
    });
    expect(attempt.cashSessionId).toBe(t.session.id);
  });

  it('S6F-12 an identical replay keeps the same single collection and session', async () => {
    const t = setup();
    const { attempt, declarations } = await chargedTransfer(t);
    await t.close.close(t.asCashier, t.sale.id as string, attempt.reserveKey as string, closeRequest(declarations));
    const before = t.db.table('externalCollection').filter((row) => row.originAttemptId === attempt.id);
    expect((await t.close.close(t.asCashier, t.sale.id as string, attempt.reserveKey as string, closeRequest(declarations))).replayed).toBe(true);
    const after = t.db.table('externalCollection').filter((row) => row.originAttemptId === attempt.id);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: before[0]!.id, cashSessionId: t.session.id });
  });

  it('S6F-13 a request-borne cashSessionId never reaches the collection', async () => {
    const t = setup();
    const { attempt, declarations } = await chargedTransfer(t);
    const forged = { ...closeRequest(declarations), cashSessionId: uuid() } as unknown as CheckoutCloseRequest;
    await t.close.close(t.asCashier, t.sale.id as string, attempt.reserveKey as string, forged);
    expect(t.db.table('externalCollection').find((row) => row.originAttemptId === attempt.id)!.cashSessionId).toBe(attempt.cashSessionId);
  });
});

describe('R3-A4.3 S6.1 — S6-B04 audit after every business write', () => {
  const auditIndexes = (ops: Array<{ kind: string; model?: string }>) => ops.flatMap((op, index) => (op.kind === 'create' && op.model === 'auditLog' ? [index] : []));
  const declaredIndex = (ops: Array<{ kind: string; model?: string; detail?: unknown }>) => ops.findIndex((op) => op.kind === 'update' && op.model === 'checkoutAttempt' && Boolean(((op.detail as Row).data as Row).declaredAt));
  const releaseIndex = (ops: Array<{ kind: string; model?: string }>) => ops.findIndex((op) => op.kind === 'updateMany' && op.model === 'externalCollection');

  it('S6F-14 no AuditLog is written before declaredAt is fixed', async () => {
    const t = setup();
    const { declarations, attempt } = await fullPlan(t);
    const mark = t.db.ops.length;
    await t.close.close(t.asCashier, t.sale.id as string, attempt.reserveKey as string, closeRequest(declarations));
    const ops = t.db.ops.slice(mark);
    expect(declaredIndex(ops)).toBeGreaterThanOrEqual(0);
    expect(Math.min(...auditIndexes(ops))).toBeGreaterThan(declaredIndex(ops));
  });

  it('S6F-15 no AuditLog is written before the COLLECTION claim is released', async () => {
    const t = setup();
    const { declarations, attempt } = await fullPlan(t);
    const mark = t.db.ops.length;
    await t.close.close(t.asCashier, t.sale.id as string, attempt.reserveKey as string, closeRequest(declarations));
    const ops = t.db.ops.slice(mark);
    expect(releaseIndex(ops)).toBeGreaterThanOrEqual(0);
    expect(Math.min(...auditIndexes(ops))).toBeGreaterThan(releaseIndex(ops));
  });

  it('S6F-16 every expected audit action follows the release, in business order', async () => {
    const t = setup();
    const { declarations, attempt, ec } = await fullPlan(t);
    const mark = t.db.ops.length;
    await t.close.close(t.asCashier, t.sale.id as string, attempt.reserveKey as string, closeRequest(declarations));
    const ops = t.db.ops.slice(mark);
    const audits = auditIndexes(ops).map((index) => ops[index]!.detail as Row);
    expect(audits.map((row) => row.action)).toEqual([
      'CHECKOUT_RESERVATION_ABANDONED', 'EXTERNAL_COLLECTION_RECORDED', 'CHECKOUT_ATTEMPT_CASH_RETURNED',
      'CHECKOUT_DECLARATION_RECORDED', 'EXTERNAL_COLLECTION_CLAIM_RELEASED',
    ]);
    const created = t.db.table('externalCollection').find((row) => row.originAttemptId === attempt.id)!;
    const cashRow = t.db.table('checkoutAttemptDeclaration').find((row) => row.method === 'CASH')!;
    expect(audits[1]).toMatchObject({ entityType: 'ExternalCollection', entityId: created.id });
    expect(audits[2]).toMatchObject({ entityType: 'CheckoutAttemptDeclaration', entityId: cashRow.id, after: { returnedAmount: '500' } });
    expect(audits[4]).toMatchObject({ entityId: ec.id, before: { claimAttemptId: attempt.id }, after: { claimAttemptId: null } });
    for (const audit of audits) expect(audit).toMatchObject({ userId: t.cashier.id, branchId: t.branch });
    expect(auditIndexes(ops)[0]).toBeGreaterThan(releaseIndex(ops));
  });

  it('S6F-17 a failure before the release leaves zero durable audits and attempts none', async () => {
    const t = setup();
    const { declarations, attempt } = await fullPlan(t);
    t.db.failOn('externalCollection', 'updateMany', () => new Error('release down'));
    const mark = t.db.ops.length;
    await expect(t.close.close(t.asCashier, t.sale.id as string, attempt.reserveKey as string, closeRequest(declarations))).rejects.toThrow('release down');
    expect(auditIndexes(t.db.ops.slice(mark))).toEqual([]);
    expect(t.db.table('auditLog').map((row) => row.action)).toEqual(['CHECKOUT_RESERVED']);
    expect(t.db.table('checkoutAttempt')[0]).toMatchObject({ status: 'RESERVED', declaredAt: null });
  });

  it('S6F-18 an audit failure (after the release) rolls the entire T-X back', async () => {
    const t = setup();
    const { declarations, attempt, ec } = await fullPlan(t);
    t.db.table('sale')[0]!.updatedAt = EPOCH;
    const collections = t.db.table('externalCollection').length;
    t.db.failOn('auditLog', 'create', () => new Error('audit down'));
    const mark = t.db.ops.length;
    await expect(t.close.close(t.asCashier, t.sale.id as string, attempt.reserveKey as string, closeRequest(declarations))).rejects.toThrow('audit down');
    // The release ran before the (first) audit, and still rolled back.
    expect(releaseIndex(t.db.ops.slice(mark))).toBeGreaterThanOrEqual(0);
    expect(t.db.table('checkoutAttempt')[0]).toMatchObject({ status: 'RESERVED', declaredAt: null, declaredById: null });
    expect(t.db.table('checkoutAttemptDeclaration')).toHaveLength(0);
    expect(t.db.table('externalCollection')).toHaveLength(collections);
    expect(t.db.table('externalCollection').find((row) => row.id === ec.id)!.claimAttemptId).toBe(attempt.id);
    expect(t.db.table('auditLog').map((row) => row.action)).toEqual(['CHECKOUT_RESERVED']);
    expect(t.db.table('sale')[0]!.updatedAt).toEqual(EPOCH);
  });
});

describe('R3-A4.3 S6.1 — T-C on a closed attempt', () => {
  it('S6F-19 ABANDONED (by T-X) then T-C is 409 CHECKOUT_RESERVATION_CLOSED', async () => {
    const t = setup();
    const { req } = await reserved(t);
    await t.close.close(t.asCashier, t.sale.id as string, req.reserveKey, closeRequest([d('CASH')]));
    const operationKey = t.db.table('checkoutAttempt')[0]!.operationKey as string;
    const checkout = createCheckoutService(t.db.client as unknown as PrismaClient);
    const confirmation: CheckoutConfirmationRequest = { reserveKey: req.reserveKey, operationKey, tenders: [], supervisor: null };
    expect(await codeOf(checkout.checkout(t.asCashier, t.cashier.id as string, t.sale.id as string, confirmation)))
      .toMatchObject({ status: 409, code: 'CHECKOUT_RESERVATION_CLOSED' });
  });

  it('S6F-20 the closed-attempt confirmation writes nothing (no attempt change, no checkout/payment/audit)', async () => {
    const t = setup();
    const { req } = await reserved(t);
    await t.close.close(t.asCashier, t.sale.id as string, req.reserveKey, closeRequest([d('CASH')]));
    const attemptBefore = { ...t.db.table('checkoutAttempt')[0]! };
    const audits = t.db.table('auditLog').length;
    const mark = t.db.ops.length;
    const checkout = createCheckoutService(t.db.client as unknown as PrismaClient);
    const confirmation: CheckoutConfirmationRequest = { reserveKey: req.reserveKey, operationKey: attemptBefore.operationKey as string, tenders: [], supervisor: null };
    await codeOf(checkout.checkout(t.asCashier, t.cashier.id as string, t.sale.id as string, confirmation));
    expect(t.db.writesSince(mark)).toEqual([]);
    expect(t.db.table('checkoutAttempt')[0]).toEqual(attemptBefore);
    expect(t.db.table('saleCheckout')).toHaveLength(0);
    expect(t.db.table('salePayment')).toHaveLength(0);
    expect(t.db.table('auditLog')).toHaveLength(audits);
  });

  it('S6F-23 a REJECTED attempt DECLARED by T-X is 409 CHECKOUT_RESERVATION_CLOSED to T-C', async () => {
    const t = setup();
    const { req } = await reserved(t);
    reject(t);
    await t.close.close(t.asCashier, t.sale.id as string, req.reserveKey, closeRequest([d('CASH')]));
    expect(t.db.table('checkoutAttempt')[0]).toMatchObject({ status: 'REJECTED' });
    expect(t.db.table('checkoutAttempt')[0]!.declaredAt).not.toBeNull();
    const operationKey = t.db.table('checkoutAttempt')[0]!.operationKey as string;
    const checkout = createCheckoutService(t.db.client as unknown as PrismaClient);
    const confirmation: CheckoutConfirmationRequest = { reserveKey: req.reserveKey, operationKey, tenders: [], supervisor: null };
    expect(await codeOf(checkout.checkout(t.asCashier, t.cashier.id as string, t.sale.id as string, confirmation)))
      .toMatchObject({ status: 409, code: 'CHECKOUT_RESERVATION_CLOSED' });
  });

  it('S6F-24 an UNDECLARED REJECTED attempt still replays its original rejection to T-C', async () => {
    const t = setup();
    const { req } = await reserved(t);
    reject(t);
    expect(t.db.table('checkoutAttempt')[0]!.declaredAt).toBeNull();
    const operationKey = t.db.table('checkoutAttempt')[0]!.operationKey as string;
    const checkout = createCheckoutService(t.db.client as unknown as PrismaClient);
    const confirmation: CheckoutConfirmationRequest = { reserveKey: req.reserveKey, operationKey, tenders: [], supervisor: null };
    expect(await codeOf(checkout.checkout(t.asCashier, t.cashier.id as string, t.sale.id as string, confirmation)))
      .toMatchObject({ status: 409, code: 'INVALID_SALE_STATE', details: { a: 1 } });
  });

  it('S6F-25 both REJECTED paths write nothing: declared -> CLOSED, undeclared -> replay', async () => {
    // Declared REJECTED (closed by T-X): 409 CHECKOUT_RESERVATION_CLOSED, zero writes.
    const declared = setup();
    const first = await reserved(declared);
    reject(declared);
    await declared.close.close(declared.asCashier, declared.sale.id as string, first.req.reserveKey, closeRequest([d('CASH')]));
    const declaredAttempt = { ...declared.db.table('checkoutAttempt')[0]! };
    const declaredAudits = declared.db.table('auditLog').length;
    let mark = declared.db.ops.length;
    const checkoutA = createCheckoutService(declared.db.client as unknown as PrismaClient);
    expect(await codeOf(checkoutA.checkout(declared.asCashier, declared.cashier.id as string, declared.sale.id as string, {
      reserveKey: first.req.reserveKey, operationKey: declaredAttempt.operationKey as string, tenders: [], supervisor: null,
    }))).toMatchObject({ status: 409, code: 'CHECKOUT_RESERVATION_CLOSED' });
    expect(declared.db.writesSince(mark)).toEqual([]);
    expect(declared.db.table('checkoutAttempt')[0]).toEqual(declaredAttempt);
    expect(declared.db.table('auditLog')).toHaveLength(declaredAudits);
    expect(declared.db.table('salePayment')).toHaveLength(0);

    // Undeclared REJECTED: the rejection replay, zero writes.
    const replay = setup();
    const second = await reserved(replay);
    reject(replay);
    const replayAttempt = { ...replay.db.table('checkoutAttempt')[0]! };
    const replayAudits = replay.db.table('auditLog').length;
    mark = replay.db.ops.length;
    const checkoutB = createCheckoutService(replay.db.client as unknown as PrismaClient);
    expect(await codeOf(checkoutB.checkout(replay.asCashier, replay.cashier.id as string, replay.sale.id as string, {
      reserveKey: second.req.reserveKey, operationKey: replayAttempt.operationKey as string, tenders: [], supervisor: null,
    }))).toMatchObject({ status: 409, code: 'INVALID_SALE_STATE' });
    expect(replay.db.writesSince(mark)).toEqual([]);
    expect(replay.db.table('checkoutAttempt')[0]).toEqual(replayAttempt);
    expect(replay.db.table('auditLog')).toHaveLength(replayAudits);
    expect(replay.db.table('salePayment')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// R3-A4.3 S6.3 — S6-B05/DOC-S6-01 write-order fix. A FRESH close must insert
// the ExternalCollection of EVERY CHARGED row BEFORE ANY
// CheckoutAttemptDeclaration: two canonical-order phases (8b collections,
// 8c declarations), never one interleaved collection+declaration loop.
// DB-free (in-memory double) only; the F4/F6 trigger order stays PENDING.
// ---------------------------------------------------------------------------
// CASH (FIXED, declared NONE) + TRANSFER (FIXED, declared CHARGED) +
// CARD_DEBIT (BALANCE, declared CHARGED): two CHARGED methods, so the op log
// proves the phase separation and the canonical order inside each phase.
async function twoChargedPlan(t: ReturnType<typeof setup>) {
  await reserved(t, [
    { method: 'CASH', role: 'FIXED', source: 'NEW', amount: 2000n, externalCollectionId: null },
    { method: 'TRANSFER', role: 'FIXED', source: 'NEW', amount: 3000n, externalCollectionId: null },
    { method: 'CARD_DEBIT', role: 'BALANCE', source: 'NEW', amount: null, externalCollectionId: null },
  ]);
  const attempt = t.db.table('checkoutAttempt')[0]!;
  const declarations = [
    d('CASH'),
    d('TRANSFER', { outcome: 'CHARGED', amount: 3000n, reference: 'OP 123', referenceKey: 'OP123', institution: 'GALICIA', evidence: 'comprobante' }),
    d('CARD_DEBIT', { outcome: 'CHARGED', amount: attempt.expectedBalanceAmount as bigint, reference: 'OP 124', referenceKey: 'OP124', evidence: 'ticket' }),
  ];
  return { attempt, declarations };
}

describe('R3-A4.3 S6.3 — S6-B05 write order: every CHARGED collection before any declaration', () => {
  const createIndexes = (ops: Array<{ kind: string; model?: string }>, model: string) =>
    ops.flatMap((op, index) => (op.kind === 'create' && op.model === model ? [index] : []));

  it('S6W-01 all CHARGED collections precede ANY declaration: max(collection create) < min(declaration create)', async () => {
    const t = setup();
    const { attempt, declarations } = await twoChargedPlan(t);
    const mark = t.db.ops.length;
    await t.close.close(t.asCashier, t.sale.id as string, attempt.reserveKey as string, closeRequest(declarations));
    const ops = t.db.ops.slice(mark);
    const collections = createIndexes(ops, 'externalCollection');
    const createdDeclarations = createIndexes(ops, 'checkoutAttemptDeclaration');
    // Two CHARGED rows => two collections; three sealed tenders => three declarations.
    expect(collections).toHaveLength(2);
    expect(createdDeclarations).toHaveLength(3);
    // The invariant: EVERY CHARGED collection exists before ANY declaration is
    // inserted — stronger than "each collection before its own declaration".
    expect(Math.max(...collections)).toBeLessThan(Math.min(...createdDeclarations));
    // The two-phase write keeps the S6/S6.1 semantics intact for BOTH charged rows.
    const transferCollection = t.db.table('externalCollection').find((row) => row.method === 'TRANSFER' && row.originAttemptId === attempt.id)!;
    const debitCollection = t.db.table('externalCollection').find((row) => row.method === 'CARD_DEBIT' && row.originAttemptId === attempt.id)!;
    expect(transferCollection).toMatchObject({ amount: 3000n, status: 'UNAPPLIED', cashSessionId: attempt.cashSessionId });
    expect(debitCollection).toMatchObject({ amount: attempt.expectedBalanceAmount, status: 'UNAPPLIED', cashSessionId: attempt.cashSessionId });
    const rows = t.db.table('checkoutAttemptDeclaration');
    expect(rows.find((row) => row.method === 'TRANSFER')).toMatchObject({ outcome: 'CHARGED', externalCollectionId: transferCollection.id });
    expect(rows.find((row) => row.method === 'CARD_DEBIT')).toMatchObject({ outcome: 'CHARGED', externalCollectionId: debitCollection.id });
    expect(rows.find((row) => row.method === 'CASH')).toMatchObject({ outcome: 'NONE', externalCollectionId: null });
  });

  it('S6W-02 canonical order guard: TRANSFER collection, CARD_DEBIT collection, only then the CASH/TRANSFER/CARD_DEBIT declarations', async () => {
    const t = setup();
    const { attempt, declarations } = await twoChargedPlan(t);
    const mark = t.db.ops.length;
    await t.close.close(t.asCashier, t.sale.id as string, attempt.reserveKey as string, closeRequest(declarations));
    const labels = t.db.ops.slice(mark)
      .filter((op) => op.kind === 'create' && (op.model === 'externalCollection' || op.model === 'checkoutAttemptDeclaration'))
      .map((op) => `${op.model === 'externalCollection' ? 'collection' : 'declaration'}:${(op.detail as Row).method}`);
    expect(labels).toEqual([
      'collection:TRANSFER',
      'collection:CARD_DEBIT',
      'declaration:CASH',
      'declaration:TRANSFER',
      'declaration:CARD_DEBIT',
    ]);
  });

  // GAP-1: the declaredAt fix (F6) must follow EVERY declaration, not only the
  // first one (S6-08 only checked the first). Multi-method plan.
  it('S6W-03 (GAP-1) declaredAt is fixed only after EVERY declaration: max(declaration create) < declaredAt update', async () => {
    const t = setup();
    const { attempt, declarations } = await twoChargedPlan(t);
    const mark = t.db.ops.length;
    await t.close.close(t.asCashier, t.sale.id as string, attempt.reserveKey as string, closeRequest(declarations));
    const ops = t.db.ops.slice(mark);
    const declarationIndexes = createIndexes(ops, 'checkoutAttemptDeclaration');
    expect(declarationIndexes).toHaveLength(3);
    const declaredAtIndex = ops.findIndex((op) => op.kind === 'update' && op.model === 'checkoutAttempt'
      && Boolean(((op.detail as Row).data as Row).declaredAt));
    expect(declaredAtIndex).toBeGreaterThanOrEqual(0);
    // The LAST declaration still precedes declaredAt — not just the first.
    expect(Math.max(...declarationIndexes)).toBeLessThan(declaredAtIndex);
  });

  // GAP-2: the terminal attempt mutation must precede EVERY CHARGED collection.
  // For a RESERVED attempt that mutation is RESERVED -> ABANDONED (F4); the
  // invariant is checked against the LAST declaration/collection edge, not the
  // first. Multi-method plan with two CHARGED rows.
  it('S6W-04 (GAP-2) the terminal attempt mutation precedes EVERY CHARGED collection: ABANDONED < min(collection create)', async () => {
    const t = setup();
    const { attempt, declarations } = await twoChargedPlan(t);
    const mark = t.db.ops.length;
    await t.close.close(t.asCashier, t.sale.id as string, attempt.reserveKey as string, closeRequest(declarations));
    const ops = t.db.ops.slice(mark);
    const abandonedAt = ops.findIndex((op) => op.kind === 'update' && op.model === 'checkoutAttempt'
      && ((op.detail as Row).data as Row).status === 'ABANDONED');
    const collectionIndexes = createIndexes(ops, 'externalCollection');
    expect(abandonedAt).toBeGreaterThanOrEqual(0);
    expect(collectionIndexes).toHaveLength(2);
    // RESERVED -> ABANDONED first, then every CHARGED collection.
    expect(abandonedAt).toBeLessThan(Math.min(...collectionIndexes));
  });
});

// R-2 (R3 PG gate, OWNER 2026-10-18): T-X CHARGED with an external reference that
// is ALREADY recorded on the branch. A read-only pre-check (T-C's step-5 pattern,
// mirroring the two partial unique indexes) answers 409
// EXTERNAL_REFERENCE_ALREADY_RECORDED before the first write; the P2002 of the
// partial index — in the real adapter-pg 7.10 shape — stays the final authority
// for a race after the pre-check. No new lock, no retry: READ COMMITTED + NOWAIT.
describe('R-2 — T-X duplicate external reference: pre-check fast path + adapter-shaped P2002 defense', () => {
  const transferPlan: PlanTenderInput[] = [
    { method: 'CASH', role: 'FIXED', source: 'NEW', amount: 2000n, externalCollectionId: null },
    { method: 'TRANSFER', role: 'BALANCE', source: 'NEW', amount: null, externalCollectionId: null },
  ];
  const debitPlan: PlanTenderInput[] = [
    { method: 'CASH', role: 'FIXED', source: 'NEW', amount: 2000n, externalCollectionId: null },
    { method: 'CARD_DEBIT', role: 'BALANCE', source: 'NEW', amount: null, externalCollectionId: null },
  ];
  const chargedTransfer = (attempt: Row, institution: CheckoutDeclarationRow['institution'] = 'GALICIA') => closeRequest([
    d('CASH'), d('TRANSFER', { outcome: 'CHARGED', amount: attempt.expectedBalanceAmount as bigint, reference: 'OP 123', referenceKey: 'OP123', institution, evidence: 'comprobante' }),
  ]);
  const chargedDebit = (attempt: Row) => closeRequest([
    d('CASH'), d('CARD_DEBIT', { outcome: 'CHARGED', amount: attempt.expectedBalanceAmount as bigint, reference: 'CUP 9', referenceKey: 'CUP9', evidence: 'cupón' }),
  ]);

  it('R2-01 TRANSFER: a recorded (branch, institution, referenceKey) is 409 EXTERNAL_REFERENCE_ALREADY_RECORDED with ZERO writes', async () => {
    for (const status of ['UNAPPLIED', 'APPLIED', 'REFUNDED']) {
      const t = setup();
      await reserved(t, transferPlan);
      t.collection({ method: 'TRANSFER', referenceKey: 'OP123', institution: 'GALICIA', status, originSaleId: null });
      const attempt = t.db.table('checkoutAttempt')[0]!;
      const collectionsBefore = t.db.table('externalCollection').length;
      const mark = t.db.ops.length;
      expect(await codeOf(t.close.close(t.asCashier, t.sale.id as string, attempt.reserveKey as string, chargedTransfer(attempt))), status)
        .toMatchObject({ status: 409, code: 'EXTERNAL_REFERENCE_ALREADY_RECORDED' });
      expect(t.db.writesSince(mark), status).toEqual([]);
      expect(t.db.table('checkoutAttempt')[0]).toMatchObject({ status: 'RESERVED', declaredAt: null });
      expect(t.db.table('checkoutAttemptDeclaration')).toHaveLength(0);
      expect(t.db.table('externalCollection')).toHaveLength(collectionsBefore);
      expect(t.db.table('auditLog').filter((row) => String(row.action).startsWith('CHECKOUT_DECLARATION') || row.action === 'EXTERNAL_COLLECTION_RECORDED')).toHaveLength(0);
    }
  });

  it('R2-02 CARD_DEBIT: a recorded (branch, referenceKey) is 409 with ZERO writes, whatever its institution', async () => {
    const t = setup();
    await reserved(t, debitPlan);
    t.collection({ method: 'CARD_DEBIT', referenceKey: 'CUP9', institution: null, originSaleId: null });
    const attempt = t.db.table('checkoutAttempt')[0]!;
    const mark = t.db.ops.length;
    expect(await codeOf(t.close.close(t.asCashier, t.sale.id as string, attempt.reserveKey as string, chargedDebit(attempt))))
      .toMatchObject({ status: 409, code: 'EXTERNAL_REFERENCE_ALREADY_RECORDED' });
    expect(t.db.writesSince(mark)).toEqual([]);
  });

  it('R2-03 no false positive: another institution, another method or another branch does not block the close', async () => {
    for (const other of [
      { method: 'TRANSFER', referenceKey: 'OP123', institution: 'NACION' },
      { method: 'CARD_DEBIT', referenceKey: 'OP123', institution: null },
      { method: 'TRANSFER', referenceKey: 'OP123', institution: 'GALICIA', branchId: uuid() },
    ]) {
      const t = setup();
      await reserved(t, transferPlan);
      t.collection({ ...other, originSaleId: null });
      const attempt = t.db.table('checkoutAttempt')[0]!;
      const result = await t.close.close(t.asCashier, t.sale.id as string, attempt.reserveKey as string, chargedTransfer(attempt));
      expect(result.view, JSON.stringify(other)).toMatchObject({ status: 'ABANDONED', declared: true });
    }
  });

  it('R2-04 a race AFTER the pre-check: the real adapter-shaped P2002 of either partial index maps to the same 409 and the close rolls back', async () => {
    for (const [plan, index, request] of [
      [transferPlan, 'ExternalCollection_transfer_ref_key', chargedTransfer],
      [debitPlan, 'ExternalCollection_debit_ref_key', chargedDebit],
    ] as const) {
      const t = setup();
      await reserved(t, plan);
      const attempt = t.db.table('checkoutAttempt')[0]!;
      t.db.failOn('externalCollection', 'create', () => p2002Adapter({ index }, 'ExternalCollection'));
      expect(await codeOf(t.close.close(t.asCashier, t.sale.id as string, attempt.reserveKey as string, request(attempt))), index)
        .toMatchObject({ status: 409, code: 'EXTERNAL_REFERENCE_ALREADY_RECORDED' });
      expect(t.db.table('checkoutAttempt')[0]).toMatchObject({ status: 'RESERVED', declaredAt: null });
      expect(t.db.table('checkoutAttemptDeclaration')).toHaveLength(0);
      expect(t.db.table('externalCollection')).toHaveLength(0);
      expect(t.db.table('auditLog').filter((row) => row.action === 'EXTERNAL_COLLECTION_RECORDED' || row.action === 'CHECKOUT_DECLARATION_RECORDED')).toHaveLength(0);
    }
  });

  it('R2-05 an adapter-shaped P2002 of an UNRELATED constraint, or with no constraint metadata, is rethrown untouched', async () => {
    for (const raw of [
      p2002Adapter({ index: 'ExternalCollection_id_applied_key' }, 'ExternalCollection'),
      Object.assign(new Error('Unique constraint failed'), { code: 'P2002', meta: { modelName: 'ExternalCollection', driverAdapterError: { cause: { kind: 'UniqueConstraintViolation' } } } }),
    ]) {
      const t = setup();
      await reserved(t, transferPlan);
      const attempt = t.db.table('checkoutAttempt')[0]!;
      t.db.failOn('externalCollection', 'create', () => raw);
      await expect(t.close.close(t.asCashier, t.sale.id as string, attempt.reserveKey as string, chargedTransfer(attempt))).rejects.toBe(raw);
    }
  });
});
