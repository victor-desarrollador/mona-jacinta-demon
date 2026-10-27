import type { Prisma, PrismaClient } from '../../generated/prisma/client.js';

// Pilot P0.1 transitional technical-hold semantics (seller -> cashier).
// Inventory.reserved is still a persisted denormalized counter; this module
// owns only the rules that decide which of its contributions are expired
// and releasable. It never writes; the authoritative release lives in
// cancellation.service.ts. Production V1's StockHold model
// (docs/production-v1/07-inventory-ledger.md §5) replaces it later.

// OWNER 2026-10-20 (OPTION_B_NON_EXPIRING_COMMITMENT): a normal sale's hold is a
// stock COMMITMENT (StockReservation ACTIVE + Inventory.reserved) that lives until
// the sale is CANCELLED or COMPLETED. No clock ends it: expiresAt is only the
// historical review date stamped when the hold is written (the column stays NOT
// NULL until a schema change is authorised) and decides nothing about validity.
// Double-sell protection never relied on the clock — it is the Inventory.reserved
// counter taken under row locks — so removing the clock keeps it intact. A future
// deposit hold (Seña) is a separate concept with its own expiry, not this one.
//
// The ONE place that states the rule. Every site that used to compare expiresAt
// with the clock (coverage, queue state, expired-hold discovery, the release
// itself, stock recovery) asks this module instead of repeating it.
export const NORMAL_SALE_HOLD_EXPIRES_BY_CLOCK: boolean = false;

// Review date stamped on a new hold (30 minutes). Informational only.
export const TECHNICAL_HOLD_TTL_MS = 30 * 60 * 1000;

export function holdExpiredByClock(hold: { expiresAt: Date }, now: Date): boolean {
  return NORMAL_SALE_HOLD_EXPIRES_BY_CLOCK && hold.expiresAt.getTime() <= now.getTime();
}

// Upper bound of one authoritative reconciliation batch (B1). Lives in this
// dependency-free module so env validation can bound the sweeper batch size.
export const EXPIRED_HOLD_RELEASE_BATCH_LIMIT = 100;

// Interactive latency bound for the seller -> cashier pre-send step: at most
// this many candidate Sales (one transaction each) before the target's own
// reservation. A separate concern from the maintenance batch above.
export const PRE_SEND_RECONCILE_LIMIT = 10;

type HoldDatabase = Pick<PrismaClient, 'stockReservation'>;
type BranchVariant = { branchId: string; variantId: string };

const pairKey = (branchId: string, variantId: string) => `${branchId}:${variantId}`;

// Releasable = ACTIVE, expired by the clock (holdExpiredByClock), on a
// PENDING_PAYMENT sale with zero SalePayment rows. Payment existence, not a
// monetary sum, is the deliberately conservative Policy A test. Every other
// ACTIVE row (payment-protected, PAID, or an unexpected sale state) stays held.
// While normal sale holds do not expire by the clock this selects NOTHING
// (an empty id set), so neither the sweeper, the pre-send reconciliation, the
// manual release nor the availability projection can touch a normal sale's
// commitment. The read projection and the authoritative release discovery share
// this predicate.
export function releasableExpiredHoldWhere(now: Date) {
  return {
    status: 'ACTIVE',
    ...(NORMAL_SALE_HOLD_EXPIRES_BY_CLOCK ? { expiresAt: { lte: now } } : { id: { in: [] as string[] } }),
    sale: { status: 'PENDING_PAYMENT', payments: { none: {} } },
  } satisfies Prisma.StockReservationWhereInput;
}

export async function loadReleasableExpiredHolds(
  database: HoldDatabase,
  pairs: BranchVariant[],
  now: Date,
): Promise<(branchId: string, variantId: string) => bigint> {
  const requested = new Set(pairs.map(({ branchId, variantId }) => pairKey(branchId, variantId)));
  if (requested.size === 0) return () => 0n;
  const branchIds = [...new Set(pairs.map(({ branchId }) => branchId))];
  const variantIds = [...new Set(pairs.map(({ variantId }) => variantId))];
  const groups = await database.stockReservation.groupBy({
    by: ['branchId', 'variantId'],
    where: {
      branchId: { in: branchIds },
      variantId: { in: variantIds },
      ...releasableExpiredHoldWhere(now),
    },
    _sum: { quantity: true },
  });
  const releasable = new Map<string, bigint>();
  for (const group of groups) {
    const key = pairKey(group.branchId, group.variantId);
    // The IN x IN filter can return unrequested pairs; keep only the caller's.
    if (requested.has(key)) releasable.set(key, group._sum.quantity ?? 0n);
  }
  return (branchId, variantId) => releasable.get(pairKey(branchId, variantId)) ?? 0n;
}

// Read-only projection. The raw counter stays the returned `reserved`; only
// `available` becomes expiry-aware, and it never exceeds physical.
export function effectiveAvailability(physical: bigint, reserved: bigint, releasableExpired: bigint) {
  const effectiveReserved = reserved > releasableExpired ? reserved - releasableExpired : 0n;
  return { effectiveReserved, effectiveAvailable: physical - effectiveReserved };
}
