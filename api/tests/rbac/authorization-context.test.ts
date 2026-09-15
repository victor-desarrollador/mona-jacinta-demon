import type { Request, Response } from 'express';
import { describe, expect, it } from 'vitest';
import { buildAuthorizationContext } from '../../src/modules/rbac/authorization-context.js';

function userFixture(overrides: Partial<Parameters<typeof buildAuthorizationContext>[0]> = {}) {
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
    const ctx = await buildAuthorizationContext(userFixture());
    expect(ctx.legacyPermissions).toEqual(['cash.session.open']);
    expect(ctx.assignments).toEqual([
      { roleId: 'role-cashier', roleCode: 'CASHIER', scopeKind: 'LOCATION', locationId: 'loc-1', permissions: ['CASH_SESSION_OPEN'] },
    ]);
  });

  it('a Role carrying BOTH vocabularies reached only via UserBranchRole never leaks the uppercase code (Cross-cutting §D)', async () => {
    const ctx = await buildAuthorizationContext(
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
  });

  it('produces one independent assignment per UserRoleScope row — never merged (Cross-cutting §B)', async () => {
    const ctx = await buildAuthorizationContext(
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
    const ctx = await buildAuthorizationContext(userFixture({ roleScopes: [] }));
    expect(ctx.assignments).toEqual([]);
  });

  it('still throws on a COMPANY-kind UserRoleScope row (Phase 1D.2 implements this)', async () => {
    await expect(
      buildAuthorizationContext(
        userFixture({
          roleScopes: [
            { roleId: 'role-admin', scopeKind: 'COMPANY' as const, locationId: null, role: { code: 'ADMIN', permissions: [] } },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_SCOPE' });
  });

  it('resolves a legacy MANAGER-backfilled user to WAREHOUSE Production permissions via its own assignment (closes the audit-found desync)', async () => {
    const ctx = await buildAuthorizationContext(
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
