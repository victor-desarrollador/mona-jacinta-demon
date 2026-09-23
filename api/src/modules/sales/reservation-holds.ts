import type { Prisma, PrismaClient } from '../../generated/prisma/client.js';

// Pilot P0.1 transitional technical-hold semantics (seller -> cashier).
// Inventory.reserved is still a persisted denormalized counter; this module
// owns only the rules that decide which of its contributions are expired
// and releasable. It never writes; the authoritative release lives in
// cancellation.service.ts. Production V1's StockHold model
// (docs/production-v1/07-inventory-ledger.md §5) replaces it later.

export const TECHNICAL_HOLD_TTL_MS = 30 * 60 * 1000;

type HoldDatabase = Pick<PrismaClient, 'stockReservation'>;
type BranchVariant = { branchId: string; variantId: string };

const pairKey = (branchId: string, variantId: string) => `${branchId}:${variantId}`;

// Releasable = ACTIVE, expired (expiresAt <= now), on a PENDING_PAYMENT sale
// with zero SalePayment rows. Payment existence, not a monetary sum, is the
// deliberately conservative Policy A test. Every other ACTIVE row (unexpired,
// payment-protected, PAID, or an unexpected sale state) stays held. The read
// projection and the authoritative release discovery share this predicate.
export function releasableExpiredHoldWhere(now: Date) {
  return {
    status: 'ACTIVE',
    expiresAt: { lte: now },
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
