import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resetDemo } from '../../prisma/seed.js';
import { openSeedDatabase } from '../../scripts/demo-database.js';
import { backfillLocationsFromBranches, type CompanyBootstrap } from '../../src/modules/organization/organization.service.js';

// Phase 1B DB/schema invariant tests for UserRoleScope, run against the
// dedicated TEST_DATABASE_URL (migration 20260912191702_add_user_role_scope
// must already be applied — see the Phase 1B report). These are
// persistence/domain invariant tests, distinct from request-level
// authorization tests (Phase 1D/1E) which do not exist yet: no
// requirePermission-style middleware is exercised here.
describe('UserRoleScope schema invariants (Phase 1B)', () => {
  let db: Awaited<ReturnType<typeof openSeedDatabase>>;
  let userId: string;
  let adminRoleId: string;
  let cashierRoleId: string;
  let locationId: string;
  let otherLocationId: string;

  // Fallback bootstrap, only used if no Company row exists yet in TEST. If
  // another suite (e.g. company-location-backfill.test.ts) already backfilled
  // one, that existing identity is reused instead — Company is
  // immutable-after-creation, so this test must never try to create a second,
  // conflicting one (see organization.service.ts's fail-closed ensureCompany).
  const FALLBACK_COMPANY_BOOTSTRAP: CompanyBootstrap = {
    id: '00000000-0000-4000-9200-000000000001',
    name: 'Mona Jacinta (rbac test)',
    cuit: '00-22222222-2',
    address: 'Dirección legal test — pendiente de dato real',
  };

  async function safely<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch {
      throw new Error('RBAC scope integration operation failed (database details suppressed)');
    }
  }

  beforeAll(async () => {
    db = await safely(() => openSeedDatabase('test'));
    await safely(() => resetDemo(db.prisma));
    const existingCompany = await db.prisma.company.findFirst();
    const bootstrap: CompanyBootstrap = existingCompany
      ? {
          id: existingCompany.id,
          name: existingCompany.name,
          cuit: existingCompany.cuit,
          address: existingCompany.address,
        }
      : FALLBACK_COMPANY_BOOTSTRAP;
    await safely(() => backfillLocationsFromBranches(db.prisma, bootstrap));

    const user = await db.prisma.user.findFirstOrThrow({ where: { name: 'admin' } });
    const adminRole = await db.prisma.role.findFirstOrThrow({ where: { code: 'ADMIN' } });
    const cashierRole = await db.prisma.role.findFirstOrThrow({ where: { code: 'CASHIER' } });
    const locations = await db.prisma.location.findMany({ orderBy: { code: 'asc' }, take: 2 });
    userId = user.id;
    adminRoleId = adminRole.id;
    cashierRoleId = cashierRole.id;
    locationId = locations[0]!.id;
    otherLocationId = locations[1]!.id;
  }, 120000);

  afterEach(async () => {
    // Each test cleans up its own rows; this is a defensive backstop so one
    // test's leftover row can never leak into the next test's uniqueness
    // assertions.
    await safely(() => db.prisma.userRoleScope.deleteMany());
  });

  afterAll(async () => {
    if (db) await safely(() => db.close());
  });

  it('rejects LOCATION scope with a null locationId (CHECK constraint)', async () => {
    await expect(
      db.prisma.userRoleScope.create({
        data: { userId, roleId: adminRoleId, scopeKind: 'LOCATION', locationId: null },
      }),
    ).rejects.toThrow();
  });

  it('rejects COMPANY scope with a non-null locationId (CHECK constraint)', async () => {
    await expect(
      db.prisma.userRoleScope.create({
        data: { userId, roleId: adminRoleId, scopeKind: 'COMPANY', locationId },
      }),
    ).rejects.toThrow();
  });

  it('accepts LOCATION scope with a valid locationId', async () => {
    const row = await db.prisma.userRoleScope.create({
      data: { userId, roleId: adminRoleId, scopeKind: 'LOCATION', locationId },
    });
    expect(row.scopeKind).toBe('LOCATION');
    expect(row.locationId).toBe(locationId);
  });

  it('accepts COMPANY scope with a null locationId', async () => {
    const row = await db.prisma.userRoleScope.create({
      data: { userId, roleId: adminRoleId, scopeKind: 'COMPANY', locationId: null },
    });
    expect(row.scopeKind).toBe('COMPANY');
    expect(row.locationId).toBeNull();
  });

  it('rejects a duplicate LOCATION scope for the same user/role/location', async () => {
    await db.prisma.userRoleScope.create({
      data: { userId, roleId: adminRoleId, scopeKind: 'LOCATION', locationId },
    });
    await expect(
      db.prisma.userRoleScope.create({
        data: { userId, roleId: adminRoleId, scopeKind: 'LOCATION', locationId },
      }),
    ).rejects.toThrow();
    // A different location for the same user/role is not a duplicate.
    await expect(
      db.prisma.userRoleScope.create({
        data: { userId, roleId: adminRoleId, scopeKind: 'LOCATION', locationId: otherLocationId },
      }),
    ).resolves.toBeTruthy();
  });

  it('rejects a duplicate COMPANY scope despite both rows having a NULL locationId', async () => {
    await db.prisma.userRoleScope.create({
      data: { userId, roleId: adminRoleId, scopeKind: 'COMPANY', locationId: null },
    });
    await expect(
      db.prisma.userRoleScope.create({
        data: { userId, roleId: adminRoleId, scopeKind: 'COMPANY', locationId: null },
      }),
    ).rejects.toThrow();
    // A different role's COMPANY scope for the same user is not a duplicate.
    await expect(
      db.prisma.userRoleScope.create({
        data: { userId, roleId: cashierRoleId, scopeKind: 'COMPANY', locationId: null },
      }),
    ).resolves.toBeTruthy();
  });

  it('rejects a non-existent User FK', async () => {
    await expect(
      db.prisma.userRoleScope.create({
        data: { userId: randomUUID(), roleId: adminRoleId, scopeKind: 'LOCATION', locationId },
      }),
    ).rejects.toThrow();
  });

  it('rejects a non-existent Role FK', async () => {
    await expect(
      db.prisma.userRoleScope.create({
        data: { userId, roleId: randomUUID(), scopeKind: 'LOCATION', locationId },
      }),
    ).rejects.toThrow();
  });

  it('rejects a non-existent Location FK', async () => {
    await expect(
      db.prisma.userRoleScope.create({
        data: { userId, roleId: adminRoleId, scopeKind: 'LOCATION', locationId: randomUUID() },
      }),
    ).rejects.toThrow();
  });

  it('does not require or fabricate a UserRoleScope row for OWNER, and creates no implicit scope for ADMIN', async () => {
    // Nothing in Phase 1B writes UserRoleScope rows automatically: seeding/
    // backfilling Company+Location+Role/Permission/Branch data does not, by
    // itself, create any scope row for any role, OWNER or ADMIN included.
    // OWNER's implicit company-wide authority is domain policy
    // (rbac/role-permission-matrix.ts), never a fabricated row here.
    expect(await db.prisma.userRoleScope.count()).toBe(0);
  });

  // D2.2: normal canonical seed no longer manufactures legacy
  // UserBranchRole rows, so this suite owns an explicit, minimal legacy
  // fixture (a dedicated MANAGER + SELLER legacy user) instead of relying on
  // a global seed-produced count. The invariant is unchanged: UserRoleScope
  // writes/deletes (this suite's Phase 1B schema surface) never fabricate,
  // modify or destroy legacy UserBranchRole assignment state.
  it('leaves UserBranchRole (including legacy MANAGER assignments) fully intact', async () => {
    const managerRole = await db.prisma.role.findUniqueOrThrow({ where: { code: 'MANAGER' } });
    const sellerRole = await db.prisma.role.findUniqueOrThrow({ where: { code: 'SELLER' } });
    const legacyUser = await db.prisma.user.create({
      data: {
        name: 'user-role-scope-legacy',
        email: `user-role-scope-legacy-${randomUUID()}@test.local`,
        passwordHash: 'x',
      },
    });
    const [central, yerbaBuena] = await Promise.all([
      db.prisma.branch.findUniqueOrThrow({ where: { code: 'CEN' } }),
      db.prisma.branch.findUniqueOrThrow({ where: { code: 'YB' } }),
    ]);
    try {
      await db.prisma.userBranchRole.createMany({
        data: [
          { userId: legacyUser.id, branchId: central.id, roleId: managerRole.id },
          { userId: legacyUser.id, branchId: yerbaBuena.id, roleId: sellerRole.id },
        ],
      });
      const snapshot = () => db.prisma.userBranchRole.findMany({ orderBy: { id: 'asc' } });
      const before = await snapshot();
      expect(before.filter((row) => row.userId === legacyUser.id)).toHaveLength(2);

      await db.prisma.userRoleScope.create({
        data: { userId: legacyUser.id, roleId: cashierRoleId, scopeKind: 'LOCATION', locationId },
      });
      await db.prisma.userRoleScope.create({
        data: { userId: legacyUser.id, roleId: adminRoleId, scopeKind: 'COMPANY', locationId: null },
      });
      await db.prisma.userRoleScope.deleteMany({ where: { userId: legacyUser.id } });

      expect(await snapshot()).toEqual(before);
      expect(
        await db.prisma.userBranchRole.count({ where: { userId: legacyUser.id, roleId: managerRole.id } }),
      ).toBe(1);
    } finally {
      await db.prisma.userRoleScope.deleteMany({ where: { userId: legacyUser.id } });
      await db.prisma.userBranchRole.deleteMany({ where: { userId: legacyUser.id } });
      await db.prisma.user.delete({ where: { id: legacyUser.id } });
    }
  });
});
