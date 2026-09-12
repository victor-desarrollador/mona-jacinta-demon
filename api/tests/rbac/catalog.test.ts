import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDemo } from '../../prisma/seed.js';
import { openSeedDatabase } from '../../scripts/demo-database.js';
import {
  bootstrapProductionRbacCatalog,
  DEFAULT_ROLE_GRANTS,
  PRODUCTION_PERMISSIONS,
  productionPermissionValues,
  ROLE_CODES,
  roleCodeValues,
  verifyProductionRbacCatalog,
} from '../../src/modules/rbac/index.js';

// Phase 1B: additive Production RBAC catalog persistence. Distinguishes
// "catalog" (Role/Permission/RolePermission rows this file covers) from
// "assignment" (UserRoleScope rows, Phase 1C — untouched here).
describe('Production RBAC catalog bootstrap (Phase 1B)', () => {
  let db: Awaited<ReturnType<typeof openSeedDatabase>>;

  const LEGACY_PERMISSION_CODES = [
    'sale.create',
    'sale.charge',
    'sale.complete',
    'sale.view',
    'sale.queue.view',
    'inventory.view',
    'inventory.manage',
    'cash.session.open',
    'cash.session.close',
    'user.manage',
    'report.view',
    'audit.view',
  ];

  async function safely<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch {
      throw new Error('RBAC catalog integration operation failed (database details suppressed)');
    }
  }

  beforeAll(async () => {
    db = await safely(() => openSeedDatabase('test'));
    await safely(() => resetDemo(db.prisma));
  }, 120000);

  afterAll(async () => {
    if (db) await safely(() => db.close());
  });

  it('persists exactly the five Production roles, reusing legacy ADMIN/CASHIER/SELLER ids and leaving MANAGER as legacy', async () => {
    const legacyAdmin = await db.prisma.role.findFirstOrThrow({ where: { code: 'ADMIN' } });
    const legacyCashier = await db.prisma.role.findFirstOrThrow({ where: { code: 'CASHIER' } });
    const legacySeller = await db.prisma.role.findFirstOrThrow({ where: { code: 'SELLER' } });
    const legacyManager = await db.prisma.role.findFirstOrThrow({ where: { code: 'MANAGER' } });

    const result = await bootstrapProductionRbacCatalog(db.prisma);
    expect(Object.keys(result.roleIds).sort()).toEqual(roleCodeValues.slice().sort());

    // Reused, not recreated.
    expect(result.roleIds[ROLE_CODES.ADMIN]).toBe(legacyAdmin.id);
    expect(result.roleIds[ROLE_CODES.CASHIER]).toBe(legacyCashier.id);
    expect(result.roleIds[ROLE_CODES.SELLER]).toBe(legacySeller.id);

    // OWNER and WAREHOUSE newly persisted.
    const owner = await db.prisma.role.findUniqueOrThrow({ where: { id: result.roleIds[ROLE_CODES.OWNER] } });
    const warehouse = await db.prisma.role.findUniqueOrThrow({
      where: { id: result.roleIds[ROLE_CODES.WAREHOUSE] },
    });
    expect(owner.code).toBe('OWNER');
    expect(warehouse.code).toBe('WAREHOUSE');

    // MANAGER is untouched legacy data, not part of the Production catalog.
    const managerStillLegacy = await db.prisma.role.findUniqueOrThrow({ where: { id: legacyManager.id } });
    expect(managerStillLegacy.code).toBe('MANAGER');
    expect(roleCodeValues).not.toContain('MANAGER');

    const allRoles = await db.prisma.role.findMany();
    expect(allRoles.map((r) => r.code).sort()).toEqual(
      ['ADMIN', 'CASHIER', 'MANAGER', 'OWNER', 'SELLER', 'WAREHOUSE'].sort(),
    );
  });

  it('persists all 33 Production permissions without touching the 12 legacy lowercase codes', async () => {
    await bootstrapProductionRbacCatalog(db.prisma);
    const all = await db.prisma.permission.findMany();
    const codes = all.map((p) => p.code);
    for (const code of productionPermissionValues) expect(codes).toContain(code);
    for (const code of LEGACY_PERMISSION_CODES) expect(codes).toContain(code);
    expect(all).toHaveLength(productionPermissionValues.length + LEGACY_PERMISSION_CODES.length);
  });

  it('grants exactly the frozen default matrix per role, and OWNER gets no RolePermission rows', async () => {
    const result = await bootstrapProductionRbacCatalog(db.prisma);
    const verification = await verifyProductionRbacCatalog(db.prisma);
    expect(verification.ok).toBe(true);
    expect(verification.issues).toEqual([]);

    for (const [roleCode, grants] of Object.entries(DEFAULT_ROLE_GRANTS)) {
      const roleId = result.roleIds[roleCode as keyof typeof result.roleIds];
      const rows = await db.prisma.rolePermission.findMany({
        where: { roleId, permission: { code: { in: productionPermissionValues } } },
        include: { permission: true },
      });
      expect(rows.map((r) => r.permission.code).sort()).toEqual(grants.slice().sort());
    }

    const ownerGrantCount = await db.prisma.rolePermission.count({
      where: { roleId: result.roleIds[ROLE_CODES.OWNER] },
    });
    expect(ownerGrantCount).toBe(0);
  });

  it('is idempotent: rerunning creates no duplicate rows and converges to the same ids', async () => {
    const first = await bootstrapProductionRbacCatalog(db.prisma);
    const roleCountBefore = await db.prisma.role.count();
    const permissionCountBefore = await db.prisma.permission.count();
    const rolePermissionCountBefore = await db.prisma.rolePermission.count();

    const second = await bootstrapProductionRbacCatalog(db.prisma);
    expect(second.roleIds).toEqual(first.roleIds);
    expect(second.permissionIds).toEqual(first.permissionIds);

    expect(await db.prisma.role.count()).toBe(roleCountBefore);
    expect(await db.prisma.permission.count()).toBe(permissionCountBefore);
    expect(await db.prisma.rolePermission.count()).toBe(rolePermissionCountBefore);

    const verification = await verifyProductionRbacCatalog(db.prisma);
    expect(verification.ok).toBe(true);
  });

  it('leaves legacy RolePermission grants (e.g. ADMIN + sale.create) untouched alongside the new Production grants', async () => {
    await bootstrapProductionRbacCatalog(db.prisma);
    const admin = await db.prisma.role.findFirstOrThrow({ where: { code: 'ADMIN' } });
    const legacySaleCreate = await db.prisma.permission.findFirstOrThrow({
      where: { code: 'sale.create' },
    });
    const legacyGrant = await db.prisma.rolePermission.findUnique({
      where: { roleId_permissionId: { roleId: admin.id, permissionId: legacySaleCreate.id } },
    });
    expect(legacyGrant).not.toBeNull();

    const productionSaleCreate = await db.prisma.permission.findFirstOrThrow({
      where: { code: PRODUCTION_PERMISSIONS.SALE_CREATE },
    });
    const productionGrant = await db.prisma.rolePermission.findUnique({
      where: { roleId_permissionId: { roleId: admin.id, permissionId: productionSaleCreate.id } },
    });
    expect(productionGrant).not.toBeNull();
  });

  it('leaves UserBranchRole (including the legacy MANAGER assignment) and UserRoleScope assignment state untouched', async () => {
    await bootstrapProductionRbacCatalog(db.prisma);
    expect(await db.prisma.userBranchRole.count()).toBe(9);
    const managerRole = await db.prisma.role.findFirstOrThrow({ where: { code: 'MANAGER' } });
    expect(await db.prisma.userBranchRole.count({ where: { roleId: managerRole.id } })).toBe(1);
    // No scope assignment is ever created by catalog bootstrap (Phase 1C's job).
    expect(await db.prisma.userRoleScope.count()).toBe(0);
  });
});
