import { describe, expect, it, vi } from 'vitest';
import { resolveEffectiveLocationIds } from '../../src/modules/rbac/effective-branch-ids.js';

// Phase 1D.2: resolveEffectiveLocationIds is a DISPLAY/FILTER CONVENIENCE
// resolver only (Cross-cutting design §C of
// docs/superpowers/plans/2026-09-14-phase-1d-production-authorization.md) —
// its output feeds Express.AuthContext.effectiveLocationIds, never
// authorization-policy.ts. A COMPANY-kind row now expands to every ACTIVE
// Location id instead of throwing UNSUPPORTED_SCOPE.
describe('resolveEffectiveLocationIds (Phase 1D.2, display/filter convenience only)', () => {
  it('unions LOCATION locationIds when no row is COMPANY-kind, without any database access', async () => {
    const db = { location: { findMany: vi.fn() } };
    const ids = await resolveEffectiveLocationIds(db, [
      { roleId: 'r1', roleCode: 'CASHIER', scopeKind: 'LOCATION', locationId: 'loc-1' },
      { roleId: 'r2', roleCode: 'SELLER', scopeKind: 'LOCATION', locationId: 'loc-2' },
    ]);
    expect(ids).toEqual(['loc-1', 'loc-2']);
    expect(db.location.findMany).not.toHaveBeenCalled();
  });

  it('dedupes repeated LOCATION locationIds across independent assignments', async () => {
    const db = { location: { findMany: vi.fn() } };
    const ids = await resolveEffectiveLocationIds(db, [
      { roleId: 'r1', roleCode: 'CASHIER', scopeKind: 'LOCATION', locationId: 'loc-1' },
      { roleId: 'r2', roleCode: 'SELLER', scopeKind: 'LOCATION', locationId: 'loc-1' },
    ]);
    expect(ids).toEqual(['loc-1']);
  });

  it('expands to every active Location id when any row is COMPANY-kind, filtered server-side by isActive, no sentinel', async () => {
    const db = {
      location: { findMany: vi.fn().mockResolvedValue([{ id: 'loc-1' }, { id: 'loc-2' }, { id: 'loc-3' }]) },
    };
    const ids = await resolveEffectiveLocationIds(db, [
      { roleId: 'r-admin', roleCode: 'ADMIN', scopeKind: 'COMPANY', locationId: null },
    ]);
    expect(ids).toEqual(['loc-1', 'loc-2', 'loc-3']);
    expect(db.location.findMany).toHaveBeenCalledWith({ where: { isActive: true }, select: { id: true } });
  });

  it('a COMPANY row alongside unrelated LOCATION rows still expands to the full active set, never merges the two', async () => {
    const db = {
      location: { findMany: vi.fn().mockResolvedValue([{ id: 'loc-1' }, { id: 'loc-2' }]) },
    };
    const ids = await resolveEffectiveLocationIds(db, [
      { roleId: 'r-cashier', roleCode: 'CASHIER', scopeKind: 'LOCATION', locationId: 'loc-9' },
      { roleId: 'r-admin', roleCode: 'ADMIN', scopeKind: 'COMPANY', locationId: null },
    ]);
    expect(ids).toEqual(['loc-1', 'loc-2']);
  });

  it('returns [] for zero rows (fail-closed, unchanged)', async () => {
    const db = { location: { findMany: vi.fn() } };
    expect(await resolveEffectiveLocationIds(db, [])).toEqual([]);
    expect(db.location.findMany).not.toHaveBeenCalled();
  });

  it('[ZERO ACTIVE LOCATIONS] a COMPANY row with zero currently-active Locations returns [] — a query/filter-convenience fact only, not a statement about the assignment\'s authority', async () => {
    const db = { location: { findMany: vi.fn().mockResolvedValue([]) } };
    const ids = await resolveEffectiveLocationIds(db, [
      { roleId: 'r-admin', roleCode: 'ADMIN', scopeKind: 'COMPANY', locationId: null },
    ]);
    expect(ids).toEqual([]);
  });

  it('excludes inactive locations from a COMPANY expansion (server-side isActive filter, never post-filtered client-side)', async () => {
    // The mock only returns what a real `where: { isActive: true }` query
    // would return — an inactive Location never appears in the result at
    // all, proving the exclusion happens at the query, not by trusting the
    // caller to filter afterwards.
    const db = { location: { findMany: vi.fn().mockResolvedValue([{ id: 'loc-active' }]) } };
    const ids = await resolveEffectiveLocationIds(db, [
      { roleId: 'r-owner', roleCode: 'OWNER', scopeKind: 'COMPANY', locationId: null },
    ]);
    expect(ids).toEqual(['loc-active']);
  });
});
