// Pilot P0.1-C: pure rules for a Sale's CURRENT technical-hold coverage,
// shared by payment, completion and the cashier queue. It never touches the
// database: callers load the persisted SaleItems and only the ACTIVE
// StockReservation rows (historical RELEASED/CONSUMED rows are never current
// coverage) under their own transaction/lock, then ask this module.
//
// Invariant: ACTIVE coverage == current SaleItems, per variant, on the
// Sale's own branch. How expiry applies depends on the lifecycle step and is
// stated explicitly by the caller — never a bare boolean:
//   FIRST_PAYMENT     zero SalePayment rows: every current hold must be
//                     unexpired (expiresAt > now; expiresAt <= now = expired,
//                     the same boundary as P0.1-A/B1).
//   PAYMENT_PROTECTED at least one SalePayment row (Policy A): the original
//                     expiresAt no longer blocks the remaining payment.
//   PAID_COMPLETION   Sale is PAID: expiresAt no longer blocks completion.
// Detecting expiry here never releases anything; release stays owned by
// cancellation.service.ts (P0.1-B1/B2).

export type HoldExpiryPolicy =
  | { kind: 'FIRST_PAYMENT'; now: Date }
  | { kind: 'PAYMENT_PROTECTED' }
  | { kind: 'PAID_COMPLETION' };

export type CoverageItem = { variantId: string; quantity: bigint };
export type CoverageHold = { variantId: string; branchId: string; quantity: bigint; expiresAt: Date };

export type HoldCoverageFailure =
  | 'NO_ITEMS'
  | 'INVALID_ITEM_QUANTITY'
  | 'NO_ACTIVE_HOLDS'
  | 'INVALID_HOLD'
  | 'COVERAGE_MISMATCH'
  | 'EXPIRED';

export type HoldCoverage =
  | { ok: true; requirements: Map<string, bigint> }
  | { ok: false; reason: HoldCoverageFailure; variantId?: string };

export function evaluateCurrentHoldCoverage(input: {
  branchId: string;
  items: CoverageItem[];
  activeHolds: CoverageHold[];
  policy: HoldExpiryPolicy;
}): HoldCoverage {
  if (input.items.length === 0) return { ok: false, reason: 'NO_ITEMS' };
  const requirements = new Map<string, bigint>();
  for (const item of input.items) {
    if (item.quantity <= 0n) return { ok: false, reason: 'INVALID_ITEM_QUANTITY' };
    requirements.set(item.variantId, (requirements.get(item.variantId) ?? 0n) + item.quantity);
  }

  if (input.activeHolds.length === 0) return { ok: false, reason: 'NO_ACTIVE_HOLDS' };
  const covered = new Map<string, bigint>();
  for (const hold of input.activeHolds) {
    if (hold.branchId !== input.branchId || hold.quantity <= 0n) return { ok: false, reason: 'INVALID_HOLD' };
    covered.set(hold.variantId, (covered.get(hold.variantId) ?? 0n) + hold.quantity);
  }
  // Coverage defects are reported before expiry, so corruption is never
  // disguised as an ordinary expired hold.
  for (const variantId of new Set([...requirements.keys(), ...covered.keys()])) {
    if (requirements.get(variantId) !== covered.get(variantId)) return { ok: false, reason: 'COVERAGE_MISMATCH', variantId };
  }

  if (input.policy.kind === 'FIRST_PAYMENT') {
    const now = input.policy.now.getTime();
    if (input.activeHolds.some((hold) => hold.expiresAt.getTime() <= now)) return { ok: false, reason: 'EXPIRED' };
  }
  return { ok: true, requirements };
}

// Informational cashier-queue state. The payment and completion
// transactions stay authoritative and re-check everything under the Sale
// lock. COVERAGE_INVALID is the fail-closed state for a sale whose holds do
// not honestly back its items; it is never chargeable or completable.
export type CashierHoldState = 'VALID' | 'EXPIRED' | 'PAYMENT_PROTECTED' | 'PAID' | 'COVERAGE_INVALID';

export function cashierHoldState(input: {
  status: string;
  paymentCount: number;
  branchId: string;
  items: CoverageItem[];
  activeHolds: CoverageHold[];
  now: Date;
}): CashierHoldState {
  const base = { branchId: input.branchId, items: input.items, activeHolds: input.activeHolds };
  if (input.status === 'PAID') {
    return evaluateCurrentHoldCoverage({ ...base, policy: { kind: 'PAID_COMPLETION' } }).ok ? 'PAID' : 'COVERAGE_INVALID';
  }
  if (input.status !== 'PENDING_PAYMENT') return 'COVERAGE_INVALID';
  if (input.paymentCount > 0) {
    return evaluateCurrentHoldCoverage({ ...base, policy: { kind: 'PAYMENT_PROTECTED' } }).ok ? 'PAYMENT_PROTECTED' : 'COVERAGE_INVALID';
  }
  const coverage = evaluateCurrentHoldCoverage({ ...base, policy: { kind: 'FIRST_PAYMENT', now: input.now } });
  if (coverage.ok) return 'VALID';
  // Zero-payment sale with its holds expired, or already released by the
  // B1/B2 authority (no ACTIVE rows left): not chargeable; cancel stays open.
  return coverage.reason === 'EXPIRED' || coverage.reason === 'NO_ACTIVE_HOLDS' ? 'EXPIRED' : 'COVERAGE_INVALID';
}

export function canAcceptPayment(state: CashierHoldState) {
  return state === 'VALID' || state === 'PAYMENT_PROTECTED';
}
