// R3-A4.3 S4 — pure projection of a durable checkout attempt (ReservationView)
// and its read-time stockState (C1–C5 §1 and §4.1). DB-free.
import { describe, expect, it } from 'vitest';
import { buildReservationView, stockStateOf } from '../../src/modules/payments/checkout-attempt-view.js';

const NOW = new Date('2026-10-16T12:00:00.000Z');
const B = 'branch-b';
const items = [{ variantId: 'v1', quantity: 2n }, { variantId: 'v2', quantity: 1n }];
const hold = (variantId: string, quantity: bigint, expiresAt: Date, branchId = B) => ({ variantId, quantity, expiresAt, branchId });
const later = new Date(NOW.getTime() + 60_000);

describe('R3-A4.3 S4 — stockStateOf (read-time, never stored)', () => {
  it('V01 exact unexpired ACTIVE coverage is VALID; stockExpiresAt is the earliest expiry', () => {
    const early = new Date(NOW.getTime() + 1);
    expect(stockStateOf({ branchId: B, items, activeHolds: [hold('v1', 2n, later), hold('v2', 1n, early)], now: NOW }))
      .toEqual({ stockState: 'VALID', stockExpiresAt: early });
  });

  it('V02 a hold past its review date is still VALID coverage (OWNER 2026-10-20: the clock never expires it); the date is informational', () => {
    expect(stockStateOf({ branchId: B, items, activeHolds: [hold('v1', 2n, later), hold('v2', 1n, NOW)], now: NOW }))
      .toEqual({ stockState: 'VALID', stockExpiresAt: NOW });
  });

  it('V03 no ACTIVE coverage, or partial coverage, is RELEASED', () => {
    expect(stockStateOf({ branchId: B, items, activeHolds: [], now: NOW })).toEqual({ stockState: 'RELEASED', stockExpiresAt: null });
    expect(stockStateOf({ branchId: B, items, activeHolds: [hold('v1', 2n, later)], now: NOW }).stockState).toBe('RELEASED');
    expect(stockStateOf({ branchId: B, items, activeHolds: [hold('v1', 1n, later), hold('v2', 1n, later)], now: NOW }).stockState).toBe('RELEASED');
  });

  it('V04 a hold of another branch or with quantity <= 0, or no items, is INCONSISTENT', () => {
    expect(stockStateOf({ branchId: B, items, activeHolds: [hold('v1', 2n, later, 'other'), hold('v2', 1n, later)], now: NOW }).stockState).toBe('INCONSISTENT');
    expect(stockStateOf({ branchId: B, items, activeHolds: [hold('v1', 0n, later), hold('v2', 1n, later)], now: NOW }).stockState).toBe('INCONSISTENT');
    expect(stockStateOf({ branchId: B, items: [], activeHolds: [], now: NOW }).stockState).toBe('INCONSISTENT');
  });
});

const attempt = (patch: Record<string, unknown> = {}) => ({
  id: 'a1', saleId: 's1', branchId: B, reserveKey: 'rk', operationKey: 'ok', planHash: 'a'.repeat(64), cashSessionId: 'cs',
  balanceMethod: 'CASH', expectedTotal: 15000n, expectedBalanceAmount: 10000n, tenderCount: 2,
  fullPriceCash: 15000n, fullPriceTransfer: 15300n, fullPriceDebit: 15500n, fullPriceCredit: null, transferAdjustmentBps: 200, debitAdjustmentBps: 300,
  pricingConfigId: 'cfg', pricingConfigUpdatedAt: NOW, algorithmVersion: 1, planSealed: true, status: 'RESERVED',
  startedById: 'u1', startedAt: NOW, recoveryReason: null, recoveryEvidence: null, confirmationHash: null, confirmedById: null,
  confirmedAt: null, confirmReason: null, confirmEvidence: null, rejectionCode: null, rejectionDetails: null, rejectedById: null,
  rejectedAt: null, abandonedById: null, abandonedAt: null, abandonReason: null, abandonEvidence: null, declaredById: null, declaredAt: null,
  ...patch,
});
const tenders = [
  { id: 't2', attemptId: 'a1', branchId: B, method: 'TRANSFER', role: 'FIXED', source: 'NEW', amount: 5000n, externalCollectionId: null },
  { id: 't1', attemptId: 'a1', branchId: B, method: 'CASH', role: 'BALANCE', source: 'NEW', amount: null, externalCollectionId: null },
];

describe('R3-A4.3 S4 — buildReservationView', () => {
  it('V10 projects the sealed plan in canonical tender order, the starter and the stock state', () => {
    const view = buildReservationView({
      attempt: attempt() as never, tenders: tenders as never, declarations: [], startedBy: { id: 'u1', name: 'Caja 1' },
      stock: { stockState: 'VALID', stockExpiresAt: later },
    });
    expect(view).toEqual({
      reserveKey: 'rk', operationKey: 'ok', status: 'RESERVED', startedBy: { id: 'u1', name: 'Caja 1' }, startedAt: NOW,
      plan: {
        cashSessionId: 'cs', balanceMethod: 'CASH', expectedTotal: 15000n, expectedBalanceAmount: 10000n, tenderCount: 2,
        tenders: [
          { method: 'CASH', role: 'BALANCE', source: 'NEW', amount: null, externalCollectionId: null },
          { method: 'TRANSFER', role: 'FIXED', source: 'NEW', amount: 5000n, externalCollectionId: null },
        ],
        fullPrices: { CASH: 15000n, TRANSFER: 15300n, CARD_DEBIT: 15500n, CARD_CREDIT: null },
      },
      recovery: null, rejection: null, declaration: null, declared: false,
      stockState: 'VALID', stockExpiresAt: later,
    });
  });

  it('V11 terminal states expose rejection / declaration and never a stock state', () => {
    const view = buildReservationView({
      attempt: attempt({ status: 'REJECTED', rejectionCode: 'NO_OPEN_CASH_SESSION', rejectionDetails: { a: 1 }, rejectedById: 'u1', rejectedAt: NOW, declaredById: 'u1', declaredAt: later }) as never,
      tenders: tenders as never,
      declarations: [{ id: 'd1', attemptId: 'a1', saleId: 's1', branchId: B, method: 'CASH', tenderSource: 'NEW', outcome: 'NONE', externalCollectionId: null, returnedAmount: null, evidence: null, declaredById: 'u1', declaredAt: later }] as never,
      startedBy: { id: 'u1', name: 'Caja 1' }, stock: { stockState: 'VALID', stockExpiresAt: later },
    });
    expect(view.rejection).toEqual({ code: 'NO_OPEN_CASH_SESSION', details: { a: 1 } });
    expect(view.declared).toBe(true);
    expect(view.declaration).toEqual({ declaredById: 'u1', declaredAt: later, rows: [{ method: 'CASH', tenderSource: 'NEW', outcome: 'NONE', externalCollectionId: null, returnedAmount: null, evidence: null }] });
    expect(view.stockState).toBeNull();
    expect(view.stockExpiresAt).toBeNull();
  });

  it('V12 the recovery justification is shown when present; a missing pricing config shows null full prices', () => {
    const view = buildReservationView({
      attempt: attempt({ recoveryReason: 'stock vencido, cupón 1', recoveryEvidence: 'cupón 1', fullPriceTransfer: null, fullPriceDebit: null }) as never,
      tenders: tenders as never, declarations: [], startedBy: { id: 'u1', name: 'Caja 1' }, stock: null,
    });
    expect(view.recovery).toEqual({ reason: 'stock vencido, cupón 1', evidence: 'cupón 1' });
    expect(view.plan.fullPrices).toEqual({ CASH: 15000n, TRANSFER: null, CARD_DEBIT: null, CARD_CREDIT: null });
    expect(view.stockState).toBeNull();
  });
});

describe('CARD_CREDIT in the reservation view', () => {
  it('V-CRED a version-2 attempt exposes its sealed credit full price next to the others', () => {
    const view = buildReservationView({
      attempt: attempt({ fullPriceCredit: 16000n }), tenders: [], declarations: [], startedBy: { id: 'u1', name: 'Ana' }, stock: null,
    });
    expect(view.plan.fullPrices).toEqual({ CASH: 15000n, TRANSFER: 15300n, CARD_DEBIT: 15500n, CARD_CREDIT: 16000n });
  });
});
