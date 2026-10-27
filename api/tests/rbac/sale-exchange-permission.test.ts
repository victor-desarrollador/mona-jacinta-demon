// Sale exchange v1 — RED contract: the dedicated SALE_EXCHANGE permission (database-free), RBAC catalog 38.
//
// Decisions pinned (OWNER, sale-exchange-v1):
//   - the exchange has ITS OWN permission, never SALE_VOID / SALE_CANCEL_PENDING;
//   - default grant: ADMIN only; OWNER through its implicit authority (no RolePermission row);
//     CASHIER / SELLER / WAREHOUSE are never granted it;
//   - the canonical id follows the 9400/NN sequence (the next one after SALE_VOID = 37);
//   - the service authorizes through actsAsSupervisorAtLocation (OWNER, or a COMPANY-scoped ADMIN): a
//     LOCATION-scoped ADMIN holding the permission is still refused.
import { describe, expect, it } from 'vitest';
import { DEFAULT_ROLE_GRANTS, PRODUCTION_PERMISSIONS, ownerHasImplicitAuthority } from '../../src/modules/rbac/index.js';
import { actsAsSupervisorAtLocation } from '../../src/modules/rbac/authorization-policy.js';
import { CANONICAL_PERMISSION_IDS } from '../../src/modules/rbac/catalog.service.js';

type Ctx = Parameters<typeof actsAsSupervisorAtLocation>[0];
const ctxOf = (assignments: unknown[]) => ({ userId: 'u1', roles: [], effectiveLocationIds: ['branch-1'], assignments }) as unknown as Ctx;

describe('sale exchange v1 — SALE_EXCHANGE permission (RBAC catalog 38)', () => {
  it('RX01 SALE_EXCHANGE is a Production permission constant', () => {
    expect((PRODUCTION_PERMISSIONS as Record<string, string>).SALE_EXCHANGE).toBe('SALE_EXCHANGE');
  });

  it('RX02 SALE_EXCHANGE is distinct from SALE_VOID and SALE_CANCEL_PENDING', () => {
    const permissions = PRODUCTION_PERMISSIONS as Record<string, string>;
    expect(permissions.SALE_EXCHANGE).toBeDefined();
    expect(permissions.SALE_EXCHANGE).not.toBe(permissions.SALE_VOID);
    expect(permissions.SALE_EXCHANGE).not.toBe(permissions.SALE_CANCEL_PENDING);
  });

  it('RX03 default grants: ADMIN holds SALE_EXCHANGE; CASHIER, SELLER and WAREHOUSE never do', () => {
    expect(DEFAULT_ROLE_GRANTS.ADMIN).toContain('SALE_EXCHANGE');
    for (const role of ['CASHIER', 'SELLER', 'WAREHOUSE'] as const) {
      expect(DEFAULT_ROLE_GRANTS[role], role).not.toContain('SALE_EXCHANGE');
    }
  });

  // GUARD (passes today, keeps passing): OWNER never depends on a RolePermission row.
  it('RX04 OWNER holds no default grants and supervises through its implicit authority', () => {
    expect(ownerHasImplicitAuthority).toBe(true);
    expect((DEFAULT_ROLE_GRANTS as Record<string, unknown>).OWNER).toBeUndefined();
    const owner = ctxOf([{ roleId: 'r1', roleCode: 'OWNER', scopeKind: 'COMPANY', locationId: null, permissions: [] }]);
    expect(actsAsSupervisorAtLocation(owner, ['SALE_EXCHANGE'], 'branch-1')).toBe(true);
  });

  it('RX05 SALE_EXCHANGE has the canonical permission id 9400/38 and no other permission shares it', () => {
    const ids = CANONICAL_PERMISSION_IDS as Record<string, string>;
    expect(ids.SALE_EXCHANGE).toBe('00000000-0000-4000-9400-000000000038');
    expect(Object.values(ids).filter((id) => id === ids.SALE_EXCHANGE)).toHaveLength(1);
  });

  it('RX06 the catalog stays contiguous: SALE_VOID is 37 and SALE_EXCHANGE is the only new row', () => {
    const ids = CANONICAL_PERMISSION_IDS as Record<string, string>;
    expect(ids.SALE_VOID).toBe('00000000-0000-4000-9400-000000000037');
    expect(Object.keys(ids)).toHaveLength(Object.keys(PRODUCTION_PERMISSIONS).length);
    expect(Object.keys(PRODUCTION_PERMISSIONS)).toHaveLength(38);
  });

  // GUARD on the policy (passes today): the location-scoped ADMIN is never a supervisor, whatever it holds.
  it('RX07 a COMPANY ADMIN holding SALE_EXCHANGE supervises; a LOCATION ADMIN holding it, or a COMPANY ADMIN without it, does not', () => {
    const company = ctxOf([{ roleId: 'r2', roleCode: 'ADMIN', scopeKind: 'COMPANY', locationId: null, permissions: ['SALE_EXCHANGE'] }]);
    const withoutIt = ctxOf([{ roleId: 'r3', roleCode: 'ADMIN', scopeKind: 'COMPANY', locationId: null, permissions: ['SALE_VOID'] }]);
    const location = ctxOf([{ roleId: 'r4', roleCode: 'ADMIN', scopeKind: 'LOCATION', locationId: 'branch-1', permissions: ['SALE_EXCHANGE'] }]);
    expect(actsAsSupervisorAtLocation(company, ['SALE_EXCHANGE'], 'branch-1')).toBe(true);
    expect(actsAsSupervisorAtLocation(withoutIt, ['SALE_EXCHANGE'], 'branch-1')).toBe(false);
    expect(actsAsSupervisorAtLocation(location, ['SALE_EXCHANGE'], 'branch-1')).toBe(false);
  });
});
