import type { Request, Response } from 'express';
import { describe, expect, it } from 'vitest';
import { buildAuthorizationContext } from '../../src/modules/rbac/authorization-context.js';
import { hasPermissionAtLocation } from '../../src/modules/rbac/authorization-policy.js';

// Phase 1D.2: buildAuthorizationContext now takes an explicit db argument
// (the narrowest interface it needs — see effective-branch-ids.ts's
// LocationLookupDatabase) so a COMPANY-kind row can resolve
// effectiveLocationIds instead of throwing. Most fixtures never touch a
// COMPANY row, so this stub never has findMany called on it.
const noopDb = { location: { findMany: async () => [] } };

function userFixture(overrides: Partial<Parameters<typeof buildAuthorizationContext>[1]> = {}) {
  return {
    id: 'user-1',
    branchRoles: [
      { role: { code: 'CASHIER', permissions: [{ permission: { code: 'cash.session.open' } }] } },
    ],
    roleScopes: [
      {
        roleId: 'role-cashier',
        scopeKind: 'LOCATION' as const,
        locationId: 'loc-1',
        role: { code: 'CASHIER', permissions: [{ permission: { code: 'CASH_SESSION_OPEN' } }] },
      },
    ],
    ...overrides,
  };
}

describe('buildAuthorizationContext (Phase 1D.1)', () => {
  it('keeps legacyPermissions and assignments as separate vocabularies, never merged', async () => {
    const ctx = await buildAuthorizationContext(noopDb, userFixture());
    expect(ctx.legacyPermissions).toEqual(['cash.session.open']);
    expect(ctx.assignments).toEqual([
      { roleId: 'role-cashier', roleCode: 'CASHIER', scopeKind: 'LOCATION', locationId: 'loc-1', permissions: ['CASH_SESSION_OPEN'] },
    ]);
  });

  it('a Role carrying BOTH vocabularies reached only via UserBranchRole never leaks the uppercase code (Cross-cutting §D)', async () => {
    const ctx = await buildAuthorizationContext(
      noopDb,
      userFixture({
        branchRoles: [
          {
            role: {
              code: 'MIXED',
              permissions: [
                { permission: { code: 'sale.view' } },
                { permission: { code: 'SALE_VIEW' } }, // same Role row also carries the Production grant
              ],
            },
          },
        ],
        roleScopes: [], // no UserRoleScope row for this user at all — stale/never-migrated
      }),
    );
    expect(ctx.legacyPermissions).toEqual(['sale.view']);
    expect(ctx.assignments).toEqual([]);
    // The critical assertion: SALE_VIEW must not be reachable through any field.
    expect(JSON.stringify(ctx)).not.toContain('SALE_VIEW');
    // [RED 18] stale UserBranchRole cannot influence Production policy either
    // — a stale MIXED role's legacy sale.view grant must not translate into
    // SALE_VIEW authority anywhere the policy module can see.
    expect(hasPermissionAtLocation(ctx, 'SALE_VIEW', 'anywhere')).toBe(false);
  });

  it('produces one independent assignment per UserRoleScope row — never merged (Cross-cutting §B)', async () => {
    const ctx = await buildAuthorizationContext(
      noopDb,
      userFixture({
        branchRoles: [],
        roleScopes: [
          {
            roleId: 'role-seller', scopeKind: 'LOCATION' as const, locationId: 'loc-a',
            role: { code: 'SELLER', permissions: [{ permission: { code: 'SALE_CREATE' } }] },
          },
          {
            roleId: 'role-warehouse', scopeKind: 'LOCATION' as const, locationId: 'loc-b',
            role: { code: 'WAREHOUSE', permissions: [{ permission: { code: 'INVENTORY_MANAGE' } }] },
          },
        ],
      }),
    );
    expect(ctx.assignments).toHaveLength(2);
    expect(ctx.assignments[0]).toMatchObject({ roleCode: 'SELLER', locationId: 'loc-a', permissions: ['SALE_CREATE'] });
    expect(ctx.assignments[1]).toMatchObject({ roleCode: 'WAREHOUSE', locationId: 'loc-b', permissions: ['INVENTORY_MANAGE'] });
  });

  it('is fail-closed for a user with zero UserRoleScope rows, even with a UserBranchRole row', async () => {
    const ctx = await buildAuthorizationContext(noopDb, userFixture({ roleScopes: [] }));
    expect(ctx.assignments).toEqual([]);
  });

  it('[FIX 2 / 5] a UserRoleScope row whose Role.code is the legacy MANAGER code never becomes a ProductionAssignment', async () => {
    const ctx = await buildAuthorizationContext(
      noopDb,
      userFixture({
        branchRoles: [],
        roleScopes: [
          {
            roleId: 'role-manager', scopeKind: 'LOCATION' as const, locationId: 'loc-1',
            role: { code: 'MANAGER', permissions: [{ permission: { code: 'INVENTORY_MANAGE' } }] },
          },
        ],
      }),
    );
    expect(ctx.assignments).toEqual([]);
  });

  it('[FIX 2 / 6] a UserRoleScope row with an unknown/invalid role code never becomes a ProductionAssignment', async () => {
    const ctx = await buildAuthorizationContext(
      noopDb,
      userFixture({
        branchRoles: [],
        roleScopes: [
          {
            roleId: 'role-bogus', scopeKind: 'LOCATION' as const, locationId: 'loc-1',
            role: { code: 'TOTALLY_MADE_UP', permissions: [{ permission: { code: 'SALE_CREATE' } }] },
          },
        ],
      }),
    );
    expect(ctx.assignments).toEqual([]);
  });

  it('[FIX 2 / 7] a valid WAREHOUSE row still creates its normal assignment, alongside a rejected MANAGER row on the same user', async () => {
    const ctx = await buildAuthorizationContext(
      noopDb,
      userFixture({
        branchRoles: [],
        roleScopes: [
          {
            roleId: 'role-manager', scopeKind: 'LOCATION' as const, locationId: 'loc-1',
            role: { code: 'MANAGER', permissions: [{ permission: { code: 'INVENTORY_MANAGE' } }] },
          },
          {
            roleId: 'role-warehouse', scopeKind: 'LOCATION' as const, locationId: 'loc-2',
            role: { code: 'WAREHOUSE', permissions: [{ permission: { code: 'INVENTORY_MANAGE' } }] },
          },
        ],
      }),
    );
    expect(ctx.assignments).toEqual([
      { roleId: 'role-warehouse', roleCode: 'WAREHOUSE', scopeKind: 'LOCATION', locationId: 'loc-2', permissions: ['INVENTORY_MANAGE'] },
    ]);
  });

  it('[Phase 1D.2] a COMPANY-kind UserRoleScope row becomes its own qualifying assignment, locationId stays null (Cross-cutting §C) — no longer throws UNSUPPORTED_SCOPE', async () => {
    const db = { location: { findMany: async () => [{ id: 'loc-1' }, { id: 'loc-2' }] } };
    const ctx = await buildAuthorizationContext(
      db,
      userFixture({
        roleScopes: [
          {
            roleId: 'role-admin', scopeKind: 'COMPANY' as const, locationId: null,
            role: { code: 'ADMIN', permissions: [{ permission: { code: 'PRICE_MANAGE' } }] },
          },
        ],
      }),
    );
    expect(ctx.assignments).toEqual([
      { roleId: 'role-admin', roleCode: 'ADMIN', scopeKind: 'COMPANY', locationId: null, permissions: ['PRICE_MANAGE'] },
    ]);
    // [RED 19] COMPANY context can derive active effectiveLocationIds for
    // compatibility/filtering — never authorization authority.
    expect(ctx.effectiveLocationIds.slice().sort()).toEqual(['loc-1', 'loc-2']);
  });

  it('[ZERO ACTIVE LOCATIONS] a COMPANY assignment retains full authority even when the Location lookup returns zero active locations — assignments are authority, effectiveLocationIds is a separate query/filter convenience (M1 contract)', async () => {
    const db = { location: { findMany: async () => [] } };
    const ctx = await buildAuthorizationContext(
      db,
      userFixture({
        roleScopes: [
          {
            roleId: 'role-admin', scopeKind: 'COMPANY' as const, locationId: null,
            role: { code: 'ADMIN', permissions: [{ permission: { code: 'PRICE_MANAGE' } }] },
          },
        ],
      }),
    );
    expect(ctx.effectiveLocationIds).toEqual([]);
    expect(ctx.assignments).toEqual([
      { roleId: 'role-admin', roleCode: 'ADMIN', scopeKind: 'COMPANY', locationId: null, permissions: ['PRICE_MANAGE'] },
    ]);
    // Policy authority is evaluated purely from the assignment — it is
    // completely indifferent to effectiveLocationIds being empty.
    expect(hasPermissionAtLocation(ctx, 'PRICE_MANAGE', 'any-location-even-though-effectiveLocationIds-is-empty')).toBe(true);
  });

  it('[RED 9 / security check 2] a COMPANY assignment coexisting with an unrelated LOCATION assignment never cross-composes', async () => {
    const db = { location: { findMany: async () => [{ id: 'loc-1' }] } };
    const ctx = await buildAuthorizationContext(
      db,
      userFixture({
        branchRoles: [],
        roleScopes: [
          {
            roleId: 'role-admin', scopeKind: 'COMPANY' as const, locationId: null,
            role: { code: 'ADMIN', permissions: [{ permission: { code: 'PRICE_MANAGE' } }] },
          },
          {
            roleId: 'role-cashier', scopeKind: 'LOCATION' as const, locationId: 'loc-9',
            role: { code: 'CASHIER', permissions: [{ permission: { code: 'CASH_SESSION_OPEN' } }] },
          },
        ],
      }),
    );
    expect(hasPermissionAtLocation(ctx, 'PRICE_MANAGE', 'anywhere')).toBe(true); // COMPANY assignment covers it
    expect(hasPermissionAtLocation(ctx, 'CASH_SESSION_OPEN', 'loc-9')).toBe(true); // LOCATION assignment covers it
    expect(hasPermissionAtLocation(ctx, 'PRICE_MANAGE', 'loc-9')).toBe(true); // COMPANY still covers PRICE_MANAGE anywhere
    expect(hasPermissionAtLocation(ctx, 'CASH_SESSION_OPEN', 'anywhere')).toBe(false); // CASHIER assignment is LOCATION-only, not COMPANY
  });

  it('resolves a legacy MANAGER-backfilled user to WAREHOUSE Production permissions via its own assignment (closes the audit-found desync)', async () => {
    const ctx = await buildAuthorizationContext(
      noopDb,
      userFixture({
        branchRoles: [{ role: { code: 'MANAGER', permissions: [{ permission: { code: 'inventory.manage' } }] } }],
        roleScopes: [
          {
            roleId: 'role-warehouse', scopeKind: 'LOCATION' as const, locationId: 'loc-1',
            role: { code: 'WAREHOUSE', permissions: [{ permission: { code: 'INVENTORY_MANAGE' } }, { permission: { code: 'GOODS_RECEIPT_MANAGE' } }] },
          },
        ],
      }),
    );
    expect(ctx.assignments[0]!.permissions).toContain('GOODS_RECEIPT_MANAGE');
    expect(ctx.roles).toEqual(['MANAGER', 'WAREHOUSE']);
  });
});

describe('middleware/auth.ts wiring (Phase 1D.1)', () => {
  it('sets req.auth.assignments from a Production-only grant with no legacy UserBranchRole row', async () => {
    const { createRequireAuth } = await import('../../src/middleware/auth.js');
    const { createTestPrismaClient, truncateAllTables } = await import('../helpers/test-db.js');
    const { createBranch, ensureTestLocation } = await import('../helpers/factories.js');
    const { bootstrapProductionRbacCatalog } = await import('../../src/modules/rbac/catalog.service.js');
    const { getAuthToken } = await import('../helpers/auth.js');
    const db = await createTestPrismaClient();
    await truncateAllTables(db);
    await bootstrapProductionRbacCatalog(db);
    const branch = await createBranch(db);
    await ensureTestLocation(db, branch.id);
    const cashierRole = await db.role.findUniqueOrThrow({ where: { code: 'CASHIER' } });
    const user = await db.user.create({
      data: { name: 'no-legacy-user', email: 'no-legacy@test.local', passwordHash: 'x' },
    });
    await db.userRoleScope.create({
      data: { userId: user.id, roleId: cashierRole.id, scopeKind: 'LOCATION', locationId: branch.id },
    });
    const token = await getAuthToken({ id: user.id });
    const middleware = createRequireAuth(db);
    const req = { headers: { authorization: `Bearer ${token}` } } as unknown as Request;
    await new Promise<void>((resolve, reject) =>
      middleware(req, {} as Response, (err?: unknown) => (err ? reject(err) : resolve())),
    );
    if (!req.auth) {
      throw new Error('Expected auth context');
    }
    expect(req.auth.assignments).toEqual([
      {
        roleId: cashierRole.id,
        roleCode: 'CASHIER',
        scopeKind: 'LOCATION',
        locationId: branch.id,
        permissions: expect.arrayContaining(['CASH_SESSION_OPEN']),
      },
    ]);
    await db.$disconnect();
  });
});
