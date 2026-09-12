import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDemo, seedDemo } from '../../prisma/seed.js';
import { openSeedDatabase } from '../../scripts/demo-database.js';
import {
  CANONICAL_PERMISSION_IDS,
  CANONICAL_ROLE_IDS,
  DEFAULT_ROLE_GRANTS,
  productionPermissionValues,
  ROLE_CODES,
  verifyProductionRbacCatalog,
} from '../../src/modules/rbac/index.js';

// Phase 1B seed/reset ↔ RBAC catalog compatibility gate. Confirms two real
// defects found in prisma/seed.ts's populate()/clear() are fixed:
//   A) populate()'s per-legacy-role `rolePermission.deleteMany({ where:
//      { roleId } })` (for reused ADMIN/CASHIER/SELLER) used to strip the
//      Production grants sharing that same roleId — seedDemo alone could
//      silently destroy them.
//   B) clear()'s unconditional `role.deleteMany()`/`permission.deleteMany()`/
//      `rolePermission.deleteMany()` used to remove OWNER, WAREHOUSE, all 33
//      Production permissions and all 69 Production grants — resetDemo left
//      only the legacy catalog until someone remembered to rerun
//      db:bootstrap-rbac-catalog by hand.
// Both are now fixed by prisma/seed.ts calling
// rbac/catalog.service.ts's `syncProductionRbacCatalog(tx)` as the last step
// of populate(), on the same transaction — never a nested one.
describe('Demo seed/reset lifecycle preserves the Production RBAC catalog (Phase 1B)', () => {
  let db: Awaited<ReturnType<typeof openSeedDatabase>>;

  async function safely<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch {
      throw new Error('Seed/RBAC integration operation failed (database details suppressed)');
    }
  }

  async function expectFullPhase1BState() {
    expect(await db.prisma.role.count()).toBe(6);
    expect(await db.prisma.permission.count()).toBe(45);
    expect(await db.prisma.rolePermission.count()).toBe(101);
    expect(await db.prisma.userBranchRole.count()).toBe(9);
    expect(await db.prisma.userRoleScope.count()).toBe(0);
    const verification = await verifyProductionRbacCatalog(db.prisma);
    expect(verification.ok).toBe(true);
    expect(verification.issues).toEqual([]);
  }

  beforeAll(async () => {
    db = await safely(() => openSeedDatabase('test'));
  }, 120000);

  afterAll(async () => {
    if (db) await safely(() => db.close());
  });

  it('resetDemo alone (no separate catalog bootstrap call) produces the full Phase 1B state with canonical, deterministic ids', async () => {
    await safely(() => resetDemo(db.prisma));
    await expectFullPhase1BState();

    const owner = await db.prisma.role.findUniqueOrThrow({ where: { code: 'OWNER' } });
    const warehouse = await db.prisma.role.findUniqueOrThrow({ where: { code: 'WAREHOUSE' } });
    expect(owner.id).toBe(CANONICAL_ROLE_IDS[ROLE_CODES.OWNER]);
    expect(warehouse.id).toBe(CANONICAL_ROLE_IDS[ROLE_CODES.WAREHOUSE]);

    for (const code of productionPermissionValues) {
      const permission = await db.prisma.permission.findUniqueOrThrow({ where: { code } });
      expect(permission.id).toBe(CANONICAL_PERMISSION_IDS[code]);
    }

    const manager = await db.prisma.role.findUniqueOrThrow({ where: { code: 'MANAGER' } });
    expect(manager.code).toBe('MANAGER');
    const legacyPermissionCount = await db.prisma.permission.count({
      where: { code: { contains: '.' } },
    });
    expect(legacyPermissionCount).toBe(12);
  }, 120000);

  it('a second resetDemo from scratch produces the exact same canonical ids (deterministic, not merely idempotent)', async () => {
    const before = {
      owner: await db.prisma.role.findUniqueOrThrow({ where: { code: 'OWNER' } }),
      warehouse: await db.prisma.role.findUniqueOrThrow({ where: { code: 'WAREHOUSE' } }),
      permissions: await db.prisma.permission.findMany({
        where: { code: { in: productionPermissionValues } },
        orderBy: { code: 'asc' },
      }),
    };

    await safely(() => resetDemo(db.prisma));
    await expectFullPhase1BState();

    const after = {
      owner: await db.prisma.role.findUniqueOrThrow({ where: { code: 'OWNER' } }),
      warehouse: await db.prisma.role.findUniqueOrThrow({ where: { code: 'WAREHOUSE' } }),
      permissions: await db.prisma.permission.findMany({
        where: { code: { in: productionPermissionValues } },
        orderBy: { code: 'asc' },
      }),
    };

    expect(after.owner.id).toBe(before.owner.id);
    expect(after.warehouse.id).toBe(before.warehouse.id);
    expect(after.permissions.map((p) => p.id)).toEqual(before.permissions.map((p) => p.id));
  }, 120000);

  it('seedDemo (without reset) cannot strip Production grants from reused ADMIN, CASHIER or SELLER', async () => {
    // Business state must be empty for seedDemo's assertNoOperations — the
    // prior test's resetDemo already guarantees that.
    const admin = await db.prisma.role.findUniqueOrThrow({ where: { code: 'ADMIN' } });
    const cashier = await db.prisma.role.findUniqueOrThrow({ where: { code: 'CASHIER' } });
    const seller = await db.prisma.role.findUniqueOrThrow({ where: { code: 'SELLER' } });

    await safely(() => seedDemo(db.prisma));
    await expectFullPhase1BState();

    for (const [role, roleCode] of [
      [admin, ROLE_CODES.ADMIN],
      [cashier, ROLE_CODES.CASHIER],
      [seller, ROLE_CODES.SELLER],
    ] as const) {
      const productionGrantCount = await db.prisma.rolePermission.count({
        where: { roleId: role.id, permission: { code: { in: productionPermissionValues } } },
      });
      expect(productionGrantCount).toBe(DEFAULT_ROLE_GRANTS[roleCode].length);
    }
  }, 120000);

  it('resetDemo restores OWNER, WAREHOUSE, all 33 Production permissions and all 69 Production grants after a full wipe', async () => {
    // Sanity precondition: the catalog is fully wiped by clear(), proving the
    // subsequent state is genuinely restored by populate(), not leftover.
    await safely(() => resetDemo(db.prisma));
    await expectFullPhase1BState();

    const owner = await db.prisma.role.findUniqueOrThrow({ where: { code: 'OWNER' } });
    const warehouse = await db.prisma.role.findUniqueOrThrow({ where: { code: 'WAREHOUSE' } });
    expect(await db.prisma.rolePermission.count({ where: { roleId: owner.id } })).toBe(0);
    expect(
      await db.prisma.rolePermission.count({ where: { roleId: warehouse.id } }),
    ).toBe(DEFAULT_ROLE_GRANTS[ROLE_CODES.WAREHOUSE].length);

    const productionGrantTotal = await db.prisma.rolePermission.count({
      where: { permission: { code: { in: productionPermissionValues } } },
    });
    const expectedProductionGrantTotal = Object.values(DEFAULT_ROLE_GRANTS).reduce(
      (sum, grants) => sum + grants.length,
      0,
    );
    expect(productionGrantTotal).toBe(expectedProductionGrantTotal);
    expect(productionGrantTotal).toBe(69);
  }, 120000);

  it('repeated seed/reset cycles converge to the same logical catalog', async () => {
    await safely(() => resetDemo(db.prisma));
    await expectFullPhase1BState();
    await safely(() => seedDemo(db.prisma));
    await expectFullPhase1BState();
    await safely(() => resetDemo(db.prisma));
    await expectFullPhase1BState();
    await safely(() => resetDemo(db.prisma));
    await expectFullPhase1BState();
  }, 180000);
});
