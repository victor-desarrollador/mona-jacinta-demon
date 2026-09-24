import { describe, expect, it } from 'vitest';
import { cashierHoldState, evaluateCurrentHoldCoverage } from '../../src/modules/sales/hold-coverage.js';

// Pilot P0.1-C: pure current-hold coverage rules shared by payment,
// completion and the cashier queue. No database access.
describe('current technical-hold coverage (Pilot P0.1-C, pure)', () => {
  const NOW = new Date('2030-01-01T12:00:00.000Z');
  const before = new Date(NOW.getTime() - 60_000);
  const after = new Date(NOW.getTime() + 60_000);
  const BRANCH = 'branch-a';
  const hold = (variantId: string, quantity: bigint, expiresAt = after, branchId = BRANCH) => ({ variantId, branchId, quantity, expiresAt });
  const item = (variantId: string, quantity: bigint) => ({ variantId, quantity });
  const first = { kind: 'FIRST_PAYMENT', now: NOW } as const;

  it('accepts exact unexpired coverage for a first payment and aggregates duplicate items', () => {
    const result = evaluateCurrentHoldCoverage({
      branchId: BRANCH, items: [item('v1', 1n), item('v1', 2n), item('v2', 1n)],
      activeHolds: [hold('v1', 3n), hold('v2', 1n)], policy: first,
    });
    expect(result).toEqual({ ok: true, requirements: new Map([['v1', 3n], ['v2', 1n]]) });
  });

  it('aggregates several ACTIVE rows of one variant', () => {
    expect(evaluateCurrentHoldCoverage({
      branchId: BRANCH, items: [item('v1', 3n)], activeHolds: [hold('v1', 1n), hold('v1', 2n)], policy: first,
    }).ok).toBe(true);
  });

  it('treats expiresAt == now as expired and expiresAt > now as valid for a first payment', () => {
    expect(evaluateCurrentHoldCoverage({ branchId: BRANCH, items: [item('v1', 1n)], activeHolds: [hold('v1', 1n, NOW)], policy: first }))
      .toEqual({ ok: false, reason: 'EXPIRED' });
    expect(evaluateCurrentHoldCoverage({ branchId: BRANCH, items: [item('v1', 1n)], activeHolds: [hold('v1', 1n, before)], policy: first }))
      .toEqual({ ok: false, reason: 'EXPIRED' });
    expect(evaluateCurrentHoldCoverage({ branchId: BRANCH, items: [item('v1', 1n)], activeHolds: [hold('v1', 1n, new Date(NOW.getTime() + 1))], policy: first }).ok)
      .toBe(true);
  });

  it('rejects a first payment when any one of several holds is expired', () => {
    expect(evaluateCurrentHoldCoverage({
      branchId: BRANCH, items: [item('v1', 1n), item('v2', 1n)], activeHolds: [hold('v1', 1n), hold('v2', 1n, before)], policy: first,
    })).toEqual({ ok: false, reason: 'EXPIRED' });
  });

  it.each([
    { policy: { kind: 'PAYMENT_PROTECTED' } as const },
    { policy: { kind: 'PAID_COMPLETION' } as const },
  ])('ignores the expiry timestamp under $policy.kind but still requires exact coverage', ({ policy }) => {
    expect(evaluateCurrentHoldCoverage({ branchId: BRANCH, items: [item('v1', 1n)], activeHolds: [hold('v1', 1n, before)], policy }).ok).toBe(true);
    expect(evaluateCurrentHoldCoverage({ branchId: BRANCH, items: [item('v1', 1n)], activeHolds: [], policy }))
      .toEqual({ ok: false, reason: 'NO_ACTIVE_HOLDS' });
  });

  it('fails closed on every coverage defect, whatever the policy', () => {
    const cases: Array<[Parameters<typeof evaluateCurrentHoldCoverage>[0]['items'], Parameters<typeof evaluateCurrentHoldCoverage>[0]['activeHolds'], string]> = [
      [[], [], 'NO_ITEMS'],
      [[], [hold('v1', 1n)], 'NO_ITEMS'],
      [[item('v1', 0n)], [hold('v1', 0n)], 'INVALID_ITEM_QUANTITY'],
      [[item('v1', 1n)], [], 'NO_ACTIVE_HOLDS'],
      [[item('v1', 1n)], [hold('v1', 1n, after, 'branch-b')], 'INVALID_HOLD'],
      [[item('v1', 1n)], [hold('v1', 0n), hold('v1', 1n)], 'INVALID_HOLD'],
      [[item('v1', 2n)], [hold('v1', 1n)], 'COVERAGE_MISMATCH'],
      [[item('v1', 1n)], [hold('v1', 2n)], 'COVERAGE_MISMATCH'],
      [[item('v1', 1n)], [hold('v1', 1n), hold('v2', 1n)], 'COVERAGE_MISMATCH'],
      [[item('v1', 1n), item('v2', 1n)], [hold('v1', 1n)], 'COVERAGE_MISMATCH'],
    ];
    for (const policy of [first, { kind: 'PAYMENT_PROTECTED' } as const, { kind: 'PAID_COMPLETION' } as const]) {
      for (const [items, activeHolds, reason] of cases) {
        const result = evaluateCurrentHoldCoverage({ branchId: BRANCH, items, activeHolds, policy });
        expect(result.ok, `${policy.kind} ${reason}`).toBe(false);
        expect(result.ok ? undefined : result.reason, `${policy.kind}`).toBe(reason);
      }
    }
  });

  it('reports a coverage defect before expiry, so corruption is never disguised as expiry', () => {
    expect(evaluateCurrentHoldCoverage({ branchId: BRANCH, items: [item('v1', 2n)], activeHolds: [hold('v1', 1n, before)], policy: first }))
      .toMatchObject({ ok: false, reason: 'COVERAGE_MISMATCH' });
  });

  describe('cashier queue hold state', () => {
    const base = { branchId: BRANCH, items: [item('v1', 1n)], now: NOW };

    // Titles use plain labels: the inputs carry BigInt quantities, which
    // Vitest's JSON-based %j title formatting cannot serialize.
    it.each([
      ['VALID', 'pending, zero payments, unexpired exact hold', { status: 'PENDING_PAYMENT', paymentCount: 0, activeHolds: [hold('v1', 1n)] }],
      ['EXPIRED', 'pending, zero payments, hold expired before now', { status: 'PENDING_PAYMENT', paymentCount: 0, activeHolds: [hold('v1', 1n, before)] }],
      ['EXPIRED', 'pending, zero payments, hold expiring exactly at now', { status: 'PENDING_PAYMENT', paymentCount: 0, activeHolds: [hold('v1', 1n, NOW)] }],
      ['EXPIRED', 'pending, zero payments, no ACTIVE hold left (released)', { status: 'PENDING_PAYMENT', paymentCount: 0, activeHolds: [] }],
      ['PAYMENT_PROTECTED', 'pending, one payment, exact hold past expiry', { status: 'PENDING_PAYMENT', paymentCount: 1, activeHolds: [hold('v1', 1n, before)] }],
      ['PAID', 'paid, exact hold past expiry', { status: 'PAID', paymentCount: 1, activeHolds: [hold('v1', 1n, before)] }],
      ['COVERAGE_INVALID', 'pending, zero payments, mismatched quantity', { status: 'PENDING_PAYMENT', paymentCount: 0, activeHolds: [hold('v1', 2n)] }],
      ['COVERAGE_INVALID', 'pending, one payment, no ACTIVE hold', { status: 'PENDING_PAYMENT', paymentCount: 1, activeHolds: [] }],
      ['COVERAGE_INVALID', 'paid, no ACTIVE hold', { status: 'PAID', paymentCount: 1, activeHolds: [] }],
    ] as const)('reports %s for %s', (expected, _label, input) => {
      expect(cashierHoldState({ ...base, ...input, activeHolds: [...input.activeHolds] })).toBe(expected);
    });

    it('reports COVERAGE_INVALID for a sale without items', () => {
      expect(cashierHoldState({ ...base, items: [], status: 'PENDING_PAYMENT', paymentCount: 0, activeHolds: [] })).toBe('COVERAGE_INVALID');
    });
  });
});
