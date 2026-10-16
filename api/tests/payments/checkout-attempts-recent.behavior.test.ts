// R3-A4.3 S4 — GET /checkout-attempts/recent (C1–C5 §4.1, correction C4):
// reload recovery independent of /sales/pending, including attempts whose sale
// is already COMPLETED. DB-free double.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { createCheckoutAttemptsRecentService } from '../../src/modules/payments/checkout-attempts-recent.service.js';
import { DEFAULT_ROLE_GRANTS } from '../../src/modules/rbac/role-permission-matrix.js';
import { AppError } from '../../src/shared/errors.js';
import { createCheckoutReservationFakeDb } from '../helpers/checkout-reservation-fake-db.js';

const NOW = new Date('2026-10-16T12:00:00.000Z');
const HOUR = 3_600_000;
const uuid = () => randomUUID();

function actor(userId: string, roleCode: 'CASHIER' | 'ADMIN' | 'OWNER', scope: { location?: string; effective: string[] }) {
  const company = roleCode !== 'CASHIER';
  return { auth: { userId, roles: [roleCode], effectiveLocationIds: scope.effective,
    assignments: [{ roleId: roleCode, roleCode, scopeKind: company ? 'COMPANY' : 'LOCATION', locationId: company ? null : scope.location!,
      permissions: roleCode === 'OWNER' ? [] : [...DEFAULT_ROLE_GRANTS[roleCode]] }] } } as never;
}

function setup() {
  const db = createCheckoutReservationFakeDb({ now: () => NOW });
  const branch = uuid();
  const otherBranch = uuid();
  const cashier = db.insert('user', { id: uuid(), name: 'Caja 1' });
  const colleague = db.insert('user', { id: uuid(), name: 'Caja 2' });
  const sale = (status: string, branchId = branch) => db.insert('sale', { id: uuid(), branchId, status, saleNumber: `B-${Math.random()}` });
  const attempt = (saleRow: Record<string, unknown>, startedById: unknown, ageMs: number, patch: Record<string, unknown> = {}) => {
    const row = db.insert('checkoutAttempt', {
      saleId: saleRow.id, branchId: saleRow.branchId, reserveKey: uuid(), operationKey: uuid(), planHash: 'a'.repeat(64), cashSessionId: uuid(),
      balanceMethod: 'CASH', expectedTotal: 15000n, expectedBalanceAmount: 15000n, tenderCount: 1, fullPriceCash: 15000n, algorithmVersion: 1,
      planSealed: true, startedById, startedAt: new Date(NOW.getTime() - ageMs), ...patch,
    });
    db.insert('checkoutAttemptTender', { attemptId: row.id, branchId: saleRow.branchId, method: 'CASH', role: 'BALANCE', source: 'NEW', amount: null, externalCollectionId: null });
    return row;
  };
  const service = createCheckoutAttemptsRecentService(db.client as unknown as PrismaClient, { now: () => NOW });
  return { db, branch, otherBranch, cashier, colleague, sale, attempt, service };
}

const codeOf = async (promise: Promise<unknown>) => {
  try { await promise; return null; } catch (error) {
    if (!(error instanceof AppError)) throw error;
    return { status: error.status, code: error.code };
  }
};

describe('R3-A4.3 S4 — recent checkout attempts', () => {
  it('C01 (P25 shape) a CONFIRMED attempt whose sale is already COMPLETED is returned with checkout id, total and payment references', async () => {
    const t = setup();
    const completed = t.sale('COMPLETED');
    const a = t.attempt(completed, t.cashier.id, HOUR, { status: 'CONFIRMED', confirmationHash: 'c'.repeat(64), confirmedById: t.cashier.id, confirmedAt: NOW });
    const ec = t.db.insert('externalCollection', { id: uuid(), branchId: t.branch, method: 'TRANSFER', amount: 5000n, referenceKey: 'OP123', institution: 'BBVA', status: 'APPLIED' });
    const checkout = t.db.insert('saleCheckout', { saleId: completed.id, branchId: t.branch, operationKey: a.operationKey, attemptStatus: 'CONFIRMED', requestHash: 'c'.repeat(64), total: 15000n, completedAt: NOW });
    t.db.insert('salePayment', { saleId: completed.id, checkoutId: checkout.id, method: 'CASH', amount: 10000n, externalCollectionId: null, paidAt: new Date(NOW.getTime() - 2) });
    t.db.insert('salePayment', { saleId: completed.id, checkoutId: checkout.id, method: 'TRANSFER', amount: 5000n, externalCollectionId: ec.id, paidAt: new Date(NOW.getTime() - 1) });
    const { items } = await t.service.recent(actor(t.cashier.id as string, 'CASHIER', { location: t.branch, effective: [t.branch] }), { branchId: t.branch, scope: 'mine', limit: 20, since: null });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      attempt: { reserveKey: a.reserveKey, status: 'CONFIRMED', stockState: null },
      sale: { saleNumber: completed.saleNumber, status: 'COMPLETED' },
      confirmed: { checkoutId: checkout.id, total: 15000n, completedAt: NOW },
    });
    expect(items[0]!.confirmed!.payments).toEqual([
      { method: 'CASH', amount: 10000n, referenceKey: null, institution: null },
      { method: 'TRANSFER', amount: 5000n, referenceKey: 'OP123', institution: 'BBVA' },
    ]);
  });

  it('C02 scope=mine shows only the actor\'s attempts of that branch, newest first, within since (default 24 h)', async () => {
    const t = setup();
    const s = t.sale('PENDING_PAYMENT');
    const mine1 = t.attempt(s, t.cashier.id, HOUR, { status: 'ABANDONED', declaredAt: NOW });
    const mine2 = t.attempt(t.sale('PENDING_PAYMENT'), t.cashier.id, 2 * HOUR, { status: 'ABANDONED', declaredAt: NOW });
    t.attempt(t.sale('PENDING_PAYMENT'), t.colleague.id, HOUR);                      // someone else
    t.attempt(t.sale('PENDING_PAYMENT'), t.cashier.id, 25 * HOUR);                   // older than 24 h
    t.attempt(t.sale('PENDING_PAYMENT', t.otherBranch), t.cashier.id, HOUR);         // other branch
    const asCashier = actor(t.cashier.id as string, 'CASHIER', { location: t.branch, effective: [t.branch] });
    const { items } = await t.service.recent(asCashier, { branchId: t.branch, scope: 'mine', limit: 20, since: null });
    expect(items.map((item) => item.attempt.reserveKey)).toEqual([mine1.reserveKey, mine2.reserveKey]);
    const one = await t.service.recent(asCashier, { branchId: t.branch, scope: 'mine', limit: 1, since: null });
    expect(one.items).toHaveLength(1);
    const wide = await t.service.recent(asCashier, { branchId: t.branch, scope: 'mine', limit: 20, since: new Date(NOW.getTime() - 48 * HOUR) });
    expect(wide.items).toHaveLength(3);
  });

  it('C03 scope=branch needs a supervisor (OWNER or COMPANY ADMIN); a CASHIER with SALE_CANCEL_PENDING is refused', async () => {
    const t = setup();
    t.attempt(t.sale('PENDING_PAYMENT'), t.cashier.id, HOUR);
    t.attempt(t.sale('PENDING_PAYMENT'), t.colleague.id, HOUR);
    const query = { branchId: t.branch, scope: 'branch' as const, limit: 20, since: null };
    expect(await codeOf(t.service.recent(actor(t.cashier.id as string, 'CASHIER', { location: t.branch, effective: [t.branch] }), query))).toMatchObject({ status: 403 });
    for (const role of ['OWNER', 'ADMIN'] as const) {
      expect((await t.service.recent(actor(uuid(), role, { effective: [t.branch, t.otherBranch] }), query)).items).toHaveLength(2);
    }
    // The supervisor's own scope=mine excludes others' attempts.
    expect((await t.service.recent(actor(uuid(), 'OWNER', { effective: [t.branch] }), { ...query, scope: 'mine' })).items).toHaveLength(0);
  });

  it('C04 another branch, or a branch outside effectiveLocationIds (existence proof), is 403', async () => {
    const t = setup();
    const asCashier = actor(t.cashier.id as string, 'CASHIER', { location: t.branch, effective: [t.branch] });
    expect(await codeOf(t.service.recent(asCashier, { branchId: t.otherBranch, scope: 'mine', limit: 20, since: null }))).toMatchObject({ status: 403 });
    const owner = actor(uuid(), 'OWNER', { effective: [t.branch] });
    expect(await codeOf(t.service.recent(owner, { branchId: uuid(), scope: 'branch', limit: 20, since: null }))).toMatchObject({ status: 403 });
  });

  it('C05 since must be within the last 7 days and not in the future', async () => {
    const t = setup();
    const asCashier = actor(t.cashier.id as string, 'CASHIER', { location: t.branch, effective: [t.branch] });
    for (const since of [new Date(NOW.getTime() - 7 * 24 * HOUR - 1), new Date(NOW.getTime() + 1)]) {
      expect(await codeOf(t.service.recent(asCashier, { branchId: t.branch, scope: 'mine', limit: 20, since }))).toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
    }
    expect((await t.service.recent(asCashier, { branchId: t.branch, scope: 'mine', limit: 20, since: new Date(NOW.getTime() - 7 * 24 * HOUR) })).items).toEqual([]);
  });

  it('C06 RESERVED attempts carry stockState; REJECTED not declared shows declared:false', async () => {
    const t = setup();
    const s = t.sale('PENDING_PAYMENT');
    t.db.insert('saleItem', { saleId: s.id, variantId: 'v1', quantity: 1n });
    t.db.insert('stockReservation', { saleId: s.id, variantId: 'v1', branchId: t.branch, quantity: 1n, status: 'ACTIVE', expiresAt: new Date(NOW.getTime() + HOUR) });
    t.attempt(s, t.cashier.id, HOUR);
    t.attempt(t.sale('PENDING_PAYMENT'), t.cashier.id, 2 * HOUR, { status: 'REJECTED', rejectionCode: 'NO_OPEN_CASH_SESSION', rejectedById: t.cashier.id, rejectedAt: NOW });
    const { items } = await t.service.recent(actor(t.cashier.id as string, 'CASHIER', { location: t.branch, effective: [t.branch] }), { branchId: t.branch, scope: 'mine', limit: 20, since: null });
    expect(items.map((item) => [item.attempt.status, item.attempt.stockState, item.attempt.declared])).toEqual([
      ['RESERVED', 'VALID', false],
      ['REJECTED', null, false],
    ]);
  });
});

describe('R3-A4.3 S4 REVISE — recent never returns a CONFIRMED attempt with confirmed: null', () => {
  const build = () => {
    const t = setup();
    const completed = t.sale('COMPLETED');
    const a = t.attempt(completed, t.cashier.id, HOUR, { status: 'CONFIRMED', confirmationHash: 'c'.repeat(64), confirmedById: t.cashier.id, confirmedAt: NOW });
    const checkout = t.db.insert('saleCheckout', { saleId: completed.id, branchId: t.branch, operationKey: a.operationKey, attemptStatus: 'CONFIRMED', requestHash: 'c'.repeat(64), total: 15000n, completedAt: NOW });
    const asCashier = actor(t.cashier.id as string, 'CASHIER', { location: t.branch, effective: [t.branch] });
    return { t, completed, checkout, run: () => t.service.recent(asCashier, { branchId: t.branch, scope: 'mine', limit: 20, since: null }) };
  };
  const corruptions: Array<[string, (b: ReturnType<typeof build>) => void]> = [
    ['checkout missing', (b) => { b.t.db.tables.saleCheckout = []; }],
    ['checkout of another sale', (b) => { b.checkout.saleId = uuid(); b.t.db.table('saleCheckout')[0]!.saleId = b.checkout.saleId; }],
    ['checkout of another operation', (b) => { b.t.db.table('saleCheckout')[0]!.operationKey = uuid(); }],
    ['hash differs', (b) => { b.t.db.table('saleCheckout')[0]!.requestHash = 'd'.repeat(64); }],
    ['sale not COMPLETED', (b) => { b.t.db.table('sale').find((row) => row.id === b.completed.id)!.status = 'PAID'; }],
  ];
  for (const [label, corrupt] of corruptions) {
    it(`C07 ${label} → 500 CHECKOUT_STATE_INCONSISTENT`, async () => {
      const b = build();
      corrupt(b);
      expect(await codeOf(b.run())).toMatchObject({ status: 500, code: 'CHECKOUT_STATE_INCONSISTENT' });
    });
  }

  it('C08 payments are those of THIS checkout only', async () => {
    const b = build();
    b.t.db.insert('salePayment', { saleId: b.completed.id, checkoutId: b.checkout.id, method: 'CASH', amount: 15000n, externalCollectionId: null, paidAt: NOW });
    b.t.db.insert('salePayment', { saleId: b.completed.id, checkoutId: uuid(), method: 'TRANSFER', amount: 999n, externalCollectionId: null, paidAt: NOW });
    const { items } = await b.run();
    expect(items[0]!.confirmed!.payments).toEqual([{ method: 'CASH', amount: 15000n, referenceKey: null, institution: null }]);
  });
});
