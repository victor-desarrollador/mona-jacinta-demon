// Sale void v1 — RED contract: the cash drawer after a SALE_REFUND (database-free, pure functions).
//
// Decision pinned (OWNER, sale-void-v1): a post-payment void of a sale with CASH payments returns the
// money through a NEW append-only CashMovement of type SALE_REFUND in an OPEN session of the same
// branch (never a CLOSED one). SALE_INCOME and SalePayment are never deleted.
//
//   expectedCash = startingCash
//                + SALE_INCOME
//                - WITHDRAWAL - EXPENSE
//                + WITHDRAWAL_REVERSAL + EXPENSE_REVERSAL
//                - SALE_REFUND
//
// The refund points at the CASH SalePayment it returns through a dedicated link column. The name used
// here, `refundOfSalePaymentId`, is PROVISIONAL (the implementation may choose another; these tests
// then follow it). It cannot be `salePaymentId`: that column is UNIQUE and already owned by the
// SALE_INCOME of the same payment. The refund may live in a LATER session than the income (the
// original session may be CLOSED), so reconcileCashSession cannot pair it with an income of its own
// session: it validates the refund by shape (link present, no salePaymentId, positive, no duplicate
// payment link) — the cross-session 1:1 with the original payment is the service/DB guarantee.
//
// Convention for malformed rows: the same reasons the cash exits already use
// (PAYMENT_MOVEMENT_MISMATCH for linkage, AMOUNT_OVERFLOW for non-positive / out-of-range amounts).
// Every assertion on a refused row names its reason, so none of them can pass today by
// MOVEMENT_TYPE_NOT_ALLOWED (what an unknown type yields before the implementation).
import { describe, expect, it } from 'vitest';
import { projectExpectedCash, reconcileCashSession } from '../../src/modules/cash/cash.service.js';

const MAX = 9223372036854775807n;
type Movement = Record<string, unknown> & { type: string; amount: bigint; salePaymentId: string | null };
const m = (fields: Movement): never => ({ reversesMovementId: null, refundOfSalePaymentId: null, ...fields }) as never;

const opening = (amount: bigint, id = 'o1') => m({ id, type: 'OPENING', amount, salePaymentId: null });
const income = (id: string, paymentId: string, amount: bigint) => m({ id, type: 'SALE_INCOME', amount, salePaymentId: paymentId });
const refund = (id: string, paymentId: string, amount: bigint, extra: Record<string, unknown> = {}) =>
  m({ id, type: 'SALE_REFUND', amount, salePaymentId: null, refundOfSalePaymentId: paymentId, ...extra });

describe('sale void v1 — cash reconciliation with SALE_REFUND', () => {
  it('CR01 same session: expectedCash = starting + SALE_INCOME - SALE_REFUND, the close reconciles', () => {
    const result = reconcileCashSession({
      startingCash: 1_000n,
      movements: [opening(1_000n), income('i1', 'p1', 5_000n), refund('r1', 'p1', 5_000n)],
      cashPayments: [{ id: 'p1', amount: 5_000n }],
      countedCash: 1_000n,
    });
    expect(result).toEqual({ ok: true, expectedCash: 1_000n, difference: 0n });
  });

  it('CR02 later session: the refund of a payment collected in another session subtracts from THIS drawer', () => {
    // Session B holds only its opening and the refund; the income belongs to the (closed) session A.
    const result = reconcileCashSession({
      startingCash: 20_000n,
      movements: [opening(20_000n), refund('r1', 'pA', 5_000n)],
      cashPayments: [],
      countedCash: 15_000n,
    });
    expect(result).toEqual({ ok: true, expectedCash: 15_000n, difference: 0n });
  });

  it('CR03 the full formula: income, exits, exit reversals and refund together', () => {
    const result = reconcileCashSession({
      startingCash: 10_000n,
      movements: [
        opening(10_000n),
        income('i1', 'p1', 8_000n),
        m({ id: 'w1', type: 'WITHDRAWAL', amount: 2_000n, salePaymentId: null }),
        m({ id: 'e1', type: 'EXPENSE', amount: 1_000n, salePaymentId: null }),
        m({ id: 'w1r', type: 'WITHDRAWAL_REVERSAL', amount: 2_000n, salePaymentId: null, reversesMovementId: 'w1' }),
        m({ id: 'e1r', type: 'EXPENSE_REVERSAL', amount: 1_000n, salePaymentId: null, reversesMovementId: 'e1' }),
        refund('r1', 'pX', 3_000n),
      ],
      cashPayments: [{ id: 'p1', amount: 8_000n }],
      countedCash: 15_000n,
    });
    // 10_000 + 8_000 - 2_000 - 1_000 + 2_000 + 1_000 - 3_000
    expect(result).toEqual({ ok: true, expectedCash: 15_000n, difference: 0n });
  });

  it('CR04 a counted amount below / above the expected one keeps the signed difference', () => {
    const base = { startingCash: 10_000n, movements: [opening(10_000n), refund('r1', 'pA', 4_000n)], cashPayments: [] };
    expect(reconcileCashSession({ ...base, countedCash: 5_000n })).toEqual({ ok: true, expectedCash: 6_000n, difference: -1_000n });
    expect(reconcileCashSession({ ...base, countedCash: 7_500n })).toEqual({ ok: true, expectedCash: 6_000n, difference: 1_500n });
  });

  it('CR05 two refunds of two different payments both subtract, in any order', () => {
    const rows = [opening(50_000n), refund('r1', 'pA', 7_000n), refund('r2', 'pB', 3_000n)];
    const forward = reconcileCashSession({ startingCash: 50_000n, movements: rows, cashPayments: [], countedCash: 40_000n });
    const backward = reconcileCashSession({ startingCash: 50_000n, movements: [...rows].reverse(), cashPayments: [], countedCash: 40_000n });
    expect(forward).toEqual({ ok: true, expectedCash: 40_000n, difference: 0n });
    expect(backward).toEqual(forward);
  });

  it('CR06 a refund carrying a salePaymentId is corrupt (that column belongs to SALE_INCOME) -> PAYMENT_MOVEMENT_MISMATCH', () => {
    const result = reconcileCashSession({
      startingCash: 0n,
      movements: [opening(0n), m({ id: 'r1', type: 'SALE_REFUND', amount: 1n, salePaymentId: 'p1', refundOfSalePaymentId: 'p1' })],
      cashPayments: [], countedCash: 0n,
    });
    expect(result).toEqual({ ok: false, reason: 'PAYMENT_MOVEMENT_MISMATCH' });
  });

  it('CR07 a refund without the link to the payment it returns -> PAYMENT_MOVEMENT_MISMATCH', () => {
    const result = reconcileCashSession({
      startingCash: 0n,
      movements: [opening(0n), m({ id: 'r1', type: 'SALE_REFUND', amount: 1n, salePaymentId: null, refundOfSalePaymentId: null })],
      cashPayments: [], countedCash: 0n,
    });
    expect(result).toEqual({ ok: false, reason: 'PAYMENT_MOVEMENT_MISMATCH' });
  });

  it('CR08 two refunds of the SAME payment in one session -> PAYMENT_MOVEMENT_MISMATCH (no double refund)', () => {
    const result = reconcileCashSession({
      startingCash: 10_000n,
      movements: [opening(10_000n), refund('r1', 'pA', 1_000n), refund('r2', 'pA', 1_000n)],
      cashPayments: [], countedCash: 8_000n,
    });
    expect(result).toEqual({ ok: false, reason: 'PAYMENT_MOVEMENT_MISMATCH' });
  });

  it('CR09 a zero or negative refund amount fails closed (AMOUNT_OVERFLOW, the exits convention)', () => {
    for (const amount of [0n, -1n]) {
      const result = reconcileCashSession({
        startingCash: 0n, movements: [opening(0n), refund('r1', 'pA', amount)], cashPayments: [], countedCash: 0n,
      });
      expect(result, String(amount)).toEqual({ ok: false, reason: 'AMOUNT_OVERFLOW' });
    }
  });

  it('CR10 BIGINT bounds: a refund that pushes expectedCash below the signed minimum fails closed', () => {
    const result = reconcileCashSession({
      startingCash: -MAX, movements: [opening(-MAX), refund('r1', 'pA', 2n)], cashPayments: [], countedCash: 0n,
    });
    expect(result).toEqual({ ok: false, reason: 'AMOUNT_OVERFLOW' });
  });

  it('CR11 BIGINT bounds: the sum of refunds beyond the signed maximum fails closed', () => {
    const result = reconcileCashSession({
      startingCash: 0n,
      movements: [opening(0n), refund('r1', 'pA', MAX), refund('r2', 'pB', MAX)],
      cashPayments: [], countedCash: 0n,
    });
    expect(result).toEqual({ ok: false, reason: 'AMOUNT_OVERFLOW' });
  });

  it('CR12 the SALE_INCOME 1:1 rule is untouched: a payment without its income still mismatches even with a refund present', () => {
    const result = reconcileCashSession({
      startingCash: 0n, movements: [opening(0n), refund('r1', 'p1', 100n)],
      cashPayments: [{ id: 'p1', amount: 100n }], countedCash: -100n,
    });
    expect(result).toEqual({ ok: false, reason: 'PAYMENT_MOVEMENT_MISMATCH' });
  });

  it('CR13 projectExpectedCash (the exits floor) subtracts SALE_REFUND too', () => {
    const projected = projectExpectedCash({
      startingCash: 10_000n,
      movements: [opening(10_000n), income('i1', 'p1', 5_000n), refund('r1', 'p1', 5_000n), refund('r2', 'pX', 2_000n)],
    });
    expect(projected).toEqual({ ok: true, projectedExpectedCash: 8_000n });
  });

  it('CR14 projectExpectedCash refuses a malformed refund exactly like the reconciliation', () => {
    const projected = projectExpectedCash({
      startingCash: 0n,
      movements: [opening(0n), m({ id: 'r1', type: 'SALE_REFUND', amount: 1n, salePaymentId: null, refundOfSalePaymentId: null })],
    });
    expect(projected).toEqual({ ok: false, reason: 'PAYMENT_MOVEMENT_MISMATCH' });
  });
});
