// Sale void v1 — RED contract: the dedicated SALE_VOID permission (database-free).
//
// Decisions pinned (OWNER, sale-void-v1):
//   - the post-payment void has ITS OWN permission, never SALE_CANCEL_PENDING;
//   - default grant: ADMIN only; OWNER through its implicit authority (no RolePermission row);
//     CASHIER / SELLER / WAREHOUSE are never granted it;
//   - the canonical id follows the 9400/NN sequence (the next one after CASH_MOVEMENT_MANAGE = 36).
//
// GREEN-time note: tests/rbac/role-permission-matrix.test.ts pins the exact permission list and
// the grant counts; adding SALE_VOID there is part of the implementation step, not of this file.
import { describe, expect, it } from 'vitest';
import { DEFAULT_ROLE_GRANTS, PRODUCTION_PERMISSIONS, ownerHasImplicitAuthority } from '../../src/modules/rbac/index.js';
import { actsAsSupervisorAtLocation } from '../../src/modules/rbac/authorization-policy.js';
import { CANONICAL_PERMISSION_IDS } from '../../src/modules/rbac/catalog.service.js';

describe('sale void v1 — SALE_VOID permission', () => {
  it('RB01 SALE_VOID is a Production permission constant', () => {
    expect((PRODUCTION_PERMISSIONS as Record<string, string>).SALE_VOID).toBe('SALE_VOID');
  });

  it('RB02 SALE_VOID is distinct from the pre-payment SALE_CANCEL_PENDING', () => {
    const permissions = PRODUCTION_PERMISSIONS as Record<string, string>;
    expect(permissions.SALE_VOID).toBeDefined();
    expect(permissions.SALE_VOID).not.toBe(permissions.SALE_CANCEL_PENDING);
  });

  it('RB03 default grants: ADMIN holds SALE_VOID; CASHIER, SELLER and WAREHOUSE never do', () => {
    expect(DEFAULT_ROLE_GRANTS.ADMIN).toContain('SALE_VOID');
    for (const role of ['CASHIER', 'SELLER', 'WAREHOUSE'] as const) {
      expect(DEFAULT_ROLE_GRANTS[role], role).not.toContain('SALE_VOID');
    }
  });

  // GUARD (passes today, keeps passing): OWNER never depends on a RolePermission row.
  it('RB04 OWNER holds no default grants and supervises through its implicit authority', () => {
    expect(ownerHasImplicitAuthority).toBe(true);
    expect((DEFAULT_ROLE_GRANTS as Record<string, unknown>).OWNER).toBeUndefined();
    const owner = {
      userId: 'u1', roles: ['OWNER'], effectiveLocationIds: [],
      assignments: [{ roleId: 'r1', roleCode: 'OWNER', scopeKind: 'COMPANY', locationId: null, permissions: [] }],
    } as unknown as Parameters<typeof actsAsSupervisorAtLocation>[0];
    expect(actsAsSupervisorAtLocation(owner, ['SALE_VOID'], 'branch-1')).toBe(true);
  });

  it('RB05 SALE_VOID has the canonical permission id 9400/37 and no other permission shares it', () => {
    const ids = CANONICAL_PERMISSION_IDS as Record<string, string>;
    expect(ids.SALE_VOID).toBe('00000000-0000-4000-9400-000000000037');
    expect(Object.values(ids).filter((id) => id === ids.SALE_VOID)).toHaveLength(1);
  });
});
