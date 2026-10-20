import { describe, expect, it } from 'vitest';
import {
  effectiveAvailability,
  holdExpiredByClock,
  loadReleasableExpiredHolds,
  releasableExpiredHoldWhere,
} from '../../src/modules/sales/reservation-holds.js';
import { evaluateCurrentHoldCoverage } from '../../src/modules/sales/hold-coverage.js';
import { assertPricingFinalizable, unitPriceFor } from '../../src/modules/sales/wholesale-authorization.service.js';
import { ZERO_ADJUSTMENTS } from '../../src/modules/pricing/pricing.js';

// OWNER 2026-10-20 (OPTION_B_NON_EXPIRING_COMMITMENT): a normal sale's stock
// commitment (StockReservation ACTIVE + Inventory.reserved) lives until the sale
// is CANCELLED or COMPLETED. No clock releases it and no read treats it as
// available. DB-free: the persisted-row evaluator below is deliberately strict —
// it throws on any filter it does not model, so a silently ignored clause can
// never make these tests pass.
describe('normal sale hold commitment is not released by the clock', () => {
  const NOW = new Date('2030-01-01T12:00:00.000Z');
  const LONG_AGO = new Date(NOW.getTime() - 7 * 24 * 60 * 60_000);

  type Row = { id: string; status: string; expiresAt: Date; branchId: string; variantId: string; quantity: bigint; saleStatus: string; payments: number };
  const pending = (overrides: Partial<Row> = {}): Row => ({
    id: 'r1', status: 'ACTIVE', expiresAt: LONG_AGO, branchId: 'b1', variantId: 'v1', quantity: 1n, saleStatus: 'PENDING_PAYMENT', payments: 0, ...overrides,
  });

  function matches(row: Row, where: Record<string, unknown>): boolean {
    return Object.entries(where).every(([key, condition]) => {
      const cond = condition as Record<string, unknown>;
      if (key === 'status') return row.status === condition;
      if (key === 'branchId') return (cond.in as string[]).includes(row.branchId);
      if (key === 'variantId') return (cond.in as string[]).includes(row.variantId);
      if (key === 'id') return (cond.in as string[]).includes(row.id);
      if (key === 'expiresAt') return row.expiresAt <= (cond.lte as Date);
      if (key === 'sale') {
        const sale = cond as { status: string; payments: { none: object } };
        return row.saleStatus === sale.status && Object.keys(sale.payments.none).length === 0 && row.payments === 0;
      }
      throw new Error(`unmodelled stockReservation filter: ${key}`);
    });
  }
  const fakeDb = (rows: Row[]) => ({
    stockReservation: {
      groupBy: async (args: { where: Record<string, unknown> }) => {
        const hit = rows.filter((row) => matches(row, args.where));
        const byPair = new Map<string, { branchId: string; variantId: string; quantity: bigint }>();
        for (const row of hit) {
          const key = `${row.branchId}:${row.variantId}`;
          const entry = byPair.get(key) ?? { branchId: row.branchId, variantId: row.variantId, quantity: 0n };
          entry.quantity += row.quantity;
          byPair.set(key, entry);
        }
        return [...byPair.values()].map((entry) => ({ branchId: entry.branchId, variantId: entry.variantId, _sum: { quantity: entry.quantity } }));
      },
    },
  }) as unknown as Parameters<typeof loadReleasableExpiredHolds>[0];

  it('never reports a hold as expired by the clock', () => {
    expect(holdExpiredByClock({ expiresAt: LONG_AGO }, NOW)).toBe(false);
    expect(holdExpiredByClock({ expiresAt: NOW }, NOW)).toBe(false);
  });

  it('selects no ACTIVE hold of a pending sale for clock release, however old', () => {
    expect(matches(pending(), releasableExpiredHoldWhere(NOW) as Record<string, unknown>)).toBe(false);
  });

  it('CRITICAL: physical=1 reserved=1 with an old ACTIVE hold stays unavailable (effective availability 0)', async () => {
    const releasable = await loadReleasableExpiredHolds(fakeDb([pending()]), [{ branchId: 'b1', variantId: 'v1' }], NOW);
    expect(releasable('b1', 'v1')).toBe(0n);
    expect(effectiveAvailability(1n, 1n, releasable('b1', 'v1'))).toEqual({ effectiveReserved: 1n, effectiveAvailable: 0n });
  });

  // The hold policy touches coverage only: wholesale pricing and the cashier's
  // confirmation gate are independent and unchanged.
  describe('wholesale rules are untouched by the hold policy', () => {
    it('still refuses an unconfirmed WHOLESALE sale and a variant without wholesalePrice', () => {
      expect(() => assertPricingFinalizable({ pricingMode: 'WHOLESALE', wholesaleConfirmedAt: null, wholesaleConfirmedById: null }))
        .toThrow(expect.objectContaining({ code: 'WHOLESALE_CONFIRMATION_REQUIRED' }));
      expect(() => unitPriceFor('WHOLESALE', { id: 'v1', cashPrice: 100n, wholesalePrice: null }, 'CASH', { id: null, updatedAt: null, adjustmentsBps: { ...ZERO_ADJUSTMENTS } }))
        .toThrow(expect.objectContaining({ code: 'WHOLESALE_PRICE_MISSING' }));
    });

    it('covers an old hold of a WHOLESALE sale exactly like a retail one', () => {
      const result = evaluateCurrentHoldCoverage({
        branchId: 'b1', items: [{ variantId: 'v1', quantity: 1n }],
        activeHolds: [{ variantId: 'v1', branchId: 'b1', quantity: 1n, expiresAt: LONG_AGO }],
        policy: { kind: 'FIRST_PAYMENT', now: NOW },
      });
      expect(result.ok).toBe(true);
    });
  });
});
