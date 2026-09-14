import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resetDemo } from '../../prisma/seed.js';
import { openSeedDatabase } from '../../scripts/demo-database.js';
import {
  backfillLocationsFromBranches,
  type CompanyBootstrap,
} from '../../src/modules/organization/organization.service.js';
import { bootstrapProductionRbacCatalog } from '../../src/modules/rbac/catalog.service.js';
import {
  backfillUserRoleScopeFromUserBranchRole,
  verifyUserRoleScopeBackfill,
} from '../../src/modules/rbac/scope-backfill.service.js';

// Phase 1C: backfills UserRoleScope from the legacy UserBranchRole rows.
// Depends on Phase 1A's Location backfill and Phase 1B's RBAC catalog
// bootstrap having already run — both are re-run here to make this suite
// self-sufficient regardless of test execution order.
describe('UserRoleScope backfill from UserBranchRole (Phase 1C)', () => {
  let db: Awaited<ReturnType<typeof openSeedDatabase>>;

  const FALLBACK_COMPANY_BOOTSTRAP: CompanyBootstrap = {
    id: '00000000-0000-4000-9300-000000000001',
    name: 'Mona Jacinta (scope backfill test)',
    cuit: '00-33333333-3',
    address: 'Dirección legal test — pendiente de dato real',
  };

  async function safely<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch {
      throw new Error('Scope backfill integration operation failed (database details suppressed)');
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
    await safely(() => bootstrapProductionRbacCatalog(db.prisma));
  }, 120000);

  afterEach(async () => {
    await safely(() => db.prisma.userRoleScope.deleteMany());
  });

  afterAll(async () => {
    if (db) await safely(() => db.close());
  });

  it('backfills all 9 legacy UserBranchRole rows into LOCATION-scoped UserRoleScope rows, mapping MANAGER to WAREHOUSE explicitly', async () => {
    // resetDemo's own seed/reset synchronization (Phase 1C, once Location
    // exists — which this suite's beforeAll guarantees) may already have
    // populated UserRoleScope from the freshly-reset UserBranchRole rows.
    // This test is specifically about the backfill function creating all 9
    // rows from scratch, so arrange an intentionally empty starting fixture
    // rather than relying on incidental ordering with other suites sharing
    // this test database.
    await db.prisma.userRoleScope.deleteMany();
    const result = await backfillUserRoleScopeFromUserBranchRole(db.prisma);
    expect(result).toEqual({ legacyRowCount: 9, created: 9, alreadyPresent: 0 });
    expect(await db.prisma.userRoleScope.count()).toBe(9);

    const manager = await db.prisma.user.findFirstOrThrow({ where: { name: 'manager01' } });
    const warehouseRole = await db.prisma.role.findFirstOrThrow({ where: { code: 'WAREHOUSE' } });
    const legacyManagerAssignment = await db.prisma.userBranchRole.findFirstOrThrow({
      where: { userId: manager.id },
    });
    const managerScope = await db.prisma.userRoleScope.findFirstOrThrow({
      where: { userId: manager.id },
    });
    expect(managerScope.roleId).toBe(warehouseRole.id);
    expect(managerScope.scopeKind).toBe('LOCATION');
    expect(managerScope.locationId).toBe(legacyManagerAssignment.branchId);

    const admin = await db.prisma.user.findFirstOrThrow({ where: { name: 'admin' } });
    const adminRole = await db.prisma.role.findFirstOrThrow({ where: { code: 'ADMIN' } });
    const adminLegacyAssignments = await db.prisma.userBranchRole.findMany({
      where: { userId: admin.id },
    });
    const adminScopes = await db.prisma.userRoleScope.findMany({ where: { userId: admin.id } });
    expect(adminScopes).toHaveLength(6);
    expect(adminScopes.every((s) => s.roleId === adminRole.id && s.scopeKind === 'LOCATION')).toBe(
      true,
    );
    expect(adminScopes.map((s) => s.locationId).sort()).toEqual(
      adminLegacyAssignments.map((a) => a.branchId).sort(),
    );
  });

  it('is idempotent: rerunning creates no duplicate rows and reports everything as already present', async () => {
    const first = await backfillUserRoleScopeFromUserBranchRole(db.prisma);
    expect(first.created).toBe(9);
    const countAfterFirst = await db.prisma.userRoleScope.count();

    const second = await backfillUserRoleScopeFromUserBranchRole(db.prisma);
    expect(second).toEqual({ legacyRowCount: 9, created: 0, alreadyPresent: 9 });
    expect(await db.prisma.userRoleScope.count()).toBe(countAfterFirst);
  });

  it('fails closed and rolls back when a legacy UserBranchRole references an unmapped role code', async () => {
    const ghostRole = await db.prisma.role.create({ data: { code: 'GHOST', name: 'GHOST' } });
    // Pick a currently-live Branch from this file's own reset fixture (never
    // an arbitrary Location — Location isn't truncated per file, so an
    // unfiltered lookup can return a row an earlier file left behind whose
    // matching Branch is already gone). Location.id == Branch.id (Phase 1A),
    // and this suite's beforeAll has already backfilled every current Branch
    // into a Location, so the explicit lookup below is guaranteed to resolve.
    const branch = await db.prisma.branch.findFirstOrThrow();
    const location = await db.prisma.location.findUniqueOrThrow({ where: { id: branch.id } });
    expect(location.id).toBe(branch.id);
    const user = await db.prisma.user.findFirstOrThrow({ where: { name: 'admin' } });
    const ghostAssignment = await db.prisma.userBranchRole.create({
      data: { userId: user.id, branchId: branch.id, roleId: ghostRole.id },
    });
    try {
      await expect(backfillUserRoleScopeFromUserBranchRole(db.prisma)).rejects.toThrow(
        /No explicit Production role mapping/,
      );
      expect(await db.prisma.userRoleScope.count()).toBe(0);
    } finally {
      await db.prisma.userBranchRole.delete({ where: { id: ghostAssignment.id } });
      await db.prisma.role.delete({ where: { id: ghostRole.id } });
    }
  });

  it('fails closed and rolls back when a legacy branch has no matching Location', async () => {
    const user = await db.prisma.user.findFirstOrThrow({ where: { name: 'admin' } });
    const adminRole = await db.prisma.role.findFirstOrThrow({ where: { code: 'ADMIN' } });
    const orphanBranch = await db.prisma.branch.create({
      data: { name: 'Sucursal huérfana', code: 'ORPHAN', address: 'N/A', pointOfSaleNumber: 999 },
    });
    const orphanAssignment = await db.prisma.userBranchRole.create({
      data: { userId: user.id, branchId: orphanBranch.id, roleId: adminRole.id },
    });
    try {
      await expect(backfillUserRoleScopeFromUserBranchRole(db.prisma)).rejects.toThrow(
        /Location row\(s\) missing/,
      );
      expect(await db.prisma.userRoleScope.count()).toBe(0);
    } finally {
      await db.prisma.userBranchRole.delete({ where: { id: orphanAssignment.id } });
      await db.prisma.branch.delete({ where: { id: orphanBranch.id } });
    }
  });

  it('never mutates UserBranchRole', async () => {
    await backfillUserRoleScopeFromUserBranchRole(db.prisma);
    expect(await db.prisma.userBranchRole.count()).toBe(9);
    const managerRole = await db.prisma.role.findFirstOrThrow({ where: { code: 'MANAGER' } });
    expect(
      await db.prisma.userBranchRole.count({ where: { roleId: managerRole.id } }),
    ).toBe(1);
  });

  it('verify: reports ok with no issues after a correct backfill', async () => {
    await backfillUserRoleScopeFromUserBranchRole(db.prisma);
    const verification = await verifyUserRoleScopeBackfill(db.prisma);
    expect(verification.ok).toBe(true);
    expect(verification.issues).toEqual([]);
    expect(verification).toMatchObject({ legacyRowCount: 9, scopeCount: 9 });
  });

  it('verify: reports a missing-assignment issue when a backfilled row is deleted', async () => {
    await backfillUserRoleScopeFromUserBranchRole(db.prisma);
    const manager = await db.prisma.user.findFirstOrThrow({ where: { name: 'manager01' } });
    const managerScope = await db.prisma.userRoleScope.findFirstOrThrow({
      where: { userId: manager.id },
    });
    await db.prisma.userRoleScope.delete({ where: { id: managerScope.id } });

    const verification = await verifyUserRoleScopeBackfill(db.prisma);
    expect(verification.ok).toBe(false);
    expect(verification.scopeCount).toBe(8);
    expect(verification.issues.some((issue) => issue.includes('missing UserRoleScope'))).toBe(
      true,
    );
    expect(
      verification.issues.some((issue) =>
        issue.includes('expected 9 UserRoleScope row(s) (one per UserBranchRole), found 8'),
      ),
    ).toBe(true);
  });
});
