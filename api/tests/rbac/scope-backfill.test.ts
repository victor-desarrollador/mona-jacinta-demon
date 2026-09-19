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
  planUserRoleScopeBackfill,
  verifyUserRoleScopeBackfill,
} from '../../src/modules/rbac/scope-backfill.service.js';
import { parseCliArgs } from '../../scripts/backfill-user-role-scope.js';

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

  it('verify: an unrelated non-legacy COMPANY UserRoleScope (e.g. OWNER) does not fail verification', async () => {
    await backfillUserRoleScopeFromUserBranchRole(db.prisma);
    const ownerRole = await db.prisma.role.findFirstOrThrow({ where: { code: 'OWNER' } });
    const owner = await db.prisma.user.create({
      data: { name: 'owner-verify-test', email: 'owner-verify-test@test.local', passwordHash: 'x' },
    });
    try {
      await db.prisma.userRoleScope.create({
        data: { userId: owner.id, roleId: ownerRole.id, scopeKind: 'COMPANY', locationId: null },
      });
      const verification = await verifyUserRoleScopeBackfill(db.prisma);
      expect(verification.ok).toBe(true);
      expect(verification.issues).toEqual([]);
      expect(verification).toMatchObject({ legacyRowCount: 9, scopeCount: 10 });
    } finally {
      await db.prisma.userRoleScope.deleteMany({ where: { userId: owner.id } });
      await db.prisma.user.delete({ where: { id: owner.id } });
    }
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

  // GC4F1 (Phase 1 Global Closeout): read-only preflight planner for the
  // mutation above. Every test asserts zero UserRoleScope mutation via an
  // exact before/after snapshot, and the planner never calls
  // syncUserRoleScopeFromUserBranchRole/backfillUserRoleScopeFromUserBranchRole.
  it('plans the full 9-row legacy fixture with zero mutation', async () => {
    const before = await db.prisma.userRoleScope.findMany();
    expect(before).toHaveLength(0);

    const plan = await planUserRoleScopeBackfill(db.prisma);

    expect(plan.legacyRowCount).toBe(9);
    expect(plan.currentUserRoleScopeCount).toBe(0);
    expect(plan.expectedCreateCount).toBe(9);
    expect(plan.alreadyPresentCount).toBe(0);
    expect(plan.readyForExecution).toBe(true);
    expect(plan.blockers).toEqual([]);
    expect(plan.rows).toHaveLength(9);

    const admin = await db.prisma.user.findFirstOrThrow({ where: { name: 'admin' } });
    const adminRows = plan.rows.filter((r) => r.userId === admin.id);
    expect(adminRows).toHaveLength(6);
    for (const row of adminRows) {
      expect(row.legacyRoleCode).toBe('ADMIN');
      expect(row.target.productionRoleCode).toBe('ADMIN');
      expect(row.target.scopeKind).toBe('LOCATION');
      expect(row.target.locationId).toBe(row.branchId);
      expect(row.target.alreadyPresent).toBe(false);
      expect(row.target.wouldCreate).toBe(true);
      expect(row.blocker).toBeNull();
    }

    const manager = await db.prisma.user.findFirstOrThrow({ where: { name: 'manager01' } });
    const managerRows = plan.rows.filter((r) => r.userId === manager.id);
    expect(managerRows).toHaveLength(1);
    expect(managerRows[0]!.legacyRoleCode).toBe('MANAGER');
    expect(managerRows[0]!.target.productionRoleCode).toBe('WAREHOUSE');

    const seller = await db.prisma.user.findFirstOrThrow({ where: { name: 'seller01' } });
    const sellerRows = plan.rows.filter((r) => r.userId === seller.id);
    expect(sellerRows).toHaveLength(1);
    expect(sellerRows[0]!.target.productionRoleCode).toBe('SELLER');

    const cashier = await db.prisma.user.findFirstOrThrow({ where: { name: 'cashier01' } });
    const cashierRows = plan.rows.filter((r) => r.userId === cashier.id);
    expect(cashierRows).toHaveLength(1);
    expect(cashierRows[0]!.target.productionRoleCode).toBe('CASHIER');

    const after = await db.prisma.userRoleScope.findMany();
    expect(after).toHaveLength(0);
  });

  it('reports an already-present exact target row and excludes it from the create count', async () => {
    const manager = await db.prisma.user.findFirstOrThrow({ where: { name: 'manager01' } });
    const warehouseRole = await db.prisma.role.findFirstOrThrow({ where: { code: 'WAREHOUSE' } });
    const legacyManagerAssignment = await db.prisma.userBranchRole.findFirstOrThrow({
      where: { userId: manager.id },
    });
    await db.prisma.userRoleScope.create({
      data: {
        userId: manager.id,
        roleId: warehouseRole.id,
        scopeKind: 'LOCATION',
        locationId: legacyManagerAssignment.branchId,
      },
    });
    const before = await db.prisma.userRoleScope.findMany();

    const plan = await planUserRoleScopeBackfill(db.prisma);

    expect(plan.legacyRowCount).toBe(9);
    expect(plan.expectedCreateCount).toBe(8);
    expect(plan.alreadyPresentCount).toBe(1);
    const managerRow = plan.rows.find((r) => r.userId === manager.id)!;
    expect(managerRow.target.alreadyPresent).toBe(true);
    expect(managerRow.target.wouldCreate).toBe(false);

    const after = await db.prisma.userRoleScope.findMany();
    expect(after).toEqual(before);
  });

  it('surfaces a coexisting COMPANY scope without treating it as something Phase1C will remove', async () => {
    const admin = await db.prisma.user.findFirstOrThrow({ where: { name: 'admin' } });
    const adminRole = await db.prisma.role.findFirstOrThrow({ where: { code: 'ADMIN' } });
    await db.prisma.userRoleScope.create({
      data: { userId: admin.id, roleId: adminRole.id, scopeKind: 'COMPANY', locationId: null },
    });
    const before = await db.prisma.userRoleScope.findMany();

    const plan = await planUserRoleScopeBackfill(db.prisma);

    const adminRows = plan.rows.filter((r) => r.userId === admin.id);
    expect(adminRows).toHaveLength(6);
    expect(adminRows.every((r) => r.target.wouldCreate)).toBe(true);
    expect(plan.readyForExecution).toBe(true);

    const coexisting = plan.coexistingScopes.filter((s) => s.userId === admin.id);
    expect(coexisting).toHaveLength(1);
    expect(coexisting[0]).toMatchObject({ scopeKind: 'COMPANY', locationId: null, roleCode: 'ADMIN' });

    const after = await db.prisma.userRoleScope.findMany();
    expect(after).toEqual(before);
  });

  it('returns NOT READY and reports an unmapped legacy role code, without mutating', async () => {
    const ghostRole = await db.prisma.role.create({ data: { code: 'GHOST', name: 'GHOST' } });
    const branch = await db.prisma.branch.findFirstOrThrow();
    const location = await db.prisma.location.findUniqueOrThrow({ where: { id: branch.id } });
    expect(location.id).toBe(branch.id);
    const user = await db.prisma.user.findFirstOrThrow({ where: { name: 'admin' } });
    const ghostAssignment = await db.prisma.userBranchRole.create({
      data: { userId: user.id, branchId: branch.id, roleId: ghostRole.id },
    });
    try {
      const plan = await planUserRoleScopeBackfill(db.prisma);
      expect(plan.readyForExecution).toBe(false);
      expect(plan.unmappedLegacyRoleCodes).toContain('GHOST');
      const ghostRow = plan.rows.find((r) => r.legacyRowId === ghostAssignment.id)!;
      expect(ghostRow.target.wouldCreate).toBe(false);
      expect(ghostRow.blocker).toBe('UNMAPPED_LEGACY_ROLE');
      expect(await db.prisma.userRoleScope.count()).toBe(0);
    } finally {
      await db.prisma.userBranchRole.delete({ where: { id: ghostAssignment.id } });
      await db.prisma.role.delete({ where: { id: ghostRole.id } });
    }
  });

  it('returns NOT READY and reports a missing Location, without mutating', async () => {
    const user = await db.prisma.user.findFirstOrThrow({ where: { name: 'admin' } });
    const adminRole = await db.prisma.role.findFirstOrThrow({ where: { code: 'ADMIN' } });
    const orphanBranch = await db.prisma.branch.create({
      data: { name: 'Sucursal huérfana (GC4F1)', code: 'ORPHAN-GC4F1', address: 'N/A', pointOfSaleNumber: 998 },
    });
    const orphanAssignment = await db.prisma.userBranchRole.create({
      data: { userId: user.id, branchId: orphanBranch.id, roleId: adminRole.id },
    });
    try {
      const plan = await planUserRoleScopeBackfill(db.prisma);
      expect(plan.readyForExecution).toBe(false);
      expect(plan.missingLocationBranchIds).toContain(orphanBranch.id);
      const orphanRow = plan.rows.find((r) => r.legacyRowId === orphanAssignment.id)!;
      expect(orphanRow.target.wouldCreate).toBe(false);
      expect(orphanRow.blocker).toBe('MISSING_LOCATION');
      expect(await db.prisma.userRoleScope.count()).toBe(0);
    } finally {
      await db.prisma.userBranchRole.delete({ where: { id: orphanAssignment.id } });
      await db.prisma.branch.delete({ where: { id: orphanBranch.id } });
    }
  });

  it('returns NOT READY and reports a missing target Production role, without mutating', async () => {
    const warehouseRole = await db.prisma.role.findFirstOrThrow({ where: { code: 'WAREHOUSE' } });
    await db.prisma.rolePermission.deleteMany({ where: { roleId: warehouseRole.id } });
    await db.prisma.role.delete({ where: { id: warehouseRole.id } });
    try {
      const plan = await planUserRoleScopeBackfill(db.prisma);
      expect(plan.readyForExecution).toBe(false);
      expect(plan.missingProductionRoleCodes).toContain('WAREHOUSE');
      const managerRow = plan.rows.find((r) => r.legacyRoleCode === 'MANAGER')!;
      expect(managerRow.target.wouldCreate).toBe(false);
      expect(managerRow.blocker).toBe('MISSING_PRODUCTION_ROLE');
      expect(await db.prisma.userRoleScope.count()).toBe(0);
    } finally {
      await bootstrapProductionRbacCatalog(db.prisma);
    }
  });
});

// GC4F1 CLI safety contract: pure argument-parsing tests, no database
// involved. Importing the script module (see the top-level import above)
// must not itself open a connection — its direct-execution guard only fires
// when the module is run as the CLI entry point, never on import.
describe('parseCliArgs (GC4F1 CLI safety contract)', () => {
  it('accepts --target=test --dry-run', () => {
    expect(parseCliArgs(['--target=test', '--dry-run'])).toEqual({ ok: true, target: 'test', mode: 'dry-run' });
  });

  it('accepts --target=demo --dry-run', () => {
    expect(parseCliArgs(['--target=demo', '--dry-run'])).toEqual({ ok: true, target: 'demo', mode: 'dry-run' });
  });

  it('accepts --target=test --execute', () => {
    expect(parseCliArgs(['--target=test', '--execute'])).toEqual({ ok: true, target: 'test', mode: 'execute' });
  });

  it('accepts --target=demo --execute', () => {
    expect(parseCliArgs(['--target=demo', '--execute'])).toEqual({ ok: true, target: 'demo', mode: 'execute' });
  });

  it('rejects a bare --target=test with no mode', () => {
    expect(parseCliArgs(['--target=test']).ok).toBe(false);
  });

  it('rejects a bare --target=demo with no mode', () => {
    expect(parseCliArgs(['--target=demo']).ok).toBe(false);
  });

  it('rejects --dry-run with no target', () => {
    expect(parseCliArgs(['--dry-run']).ok).toBe(false);
  });

  it('rejects --execute with no target', () => {
    expect(parseCliArgs(['--execute']).ok).toBe(false);
  });

  it('rejects both --dry-run and --execute together', () => {
    expect(parseCliArgs(['--target=test', '--dry-run', '--execute']).ok).toBe(false);
  });

  it('rejects an invalid --target value', () => {
    expect(parseCliArgs(['--target=production', '--dry-run']).ok).toBe(false);
  });

  it('rejects conflicting duplicate --target arguments', () => {
    expect(parseCliArgs(['--target=test', '--target=demo', '--dry-run']).ok).toBe(false);
  });

  it('rejects duplicate identical --target arguments', () => {
    expect(parseCliArgs(['--target=test', '--target=test', '--dry-run']).ok).toBe(false);
  });

  it('rejects duplicate identical mode flags', () => {
    expect(parseCliArgs(['--target=test', '--dry-run', '--dry-run']).ok).toBe(false);
  });

  it('rejects an unknown flag instead of silently ignoring it', () => {
    expect(parseCliArgs(['--target=test', '--dry-run', '--force']).ok).toBe(false);
  });

  it('rejects an unexpected positional argument instead of silently ignoring it', () => {
    expect(parseCliArgs(['--target=test', '--dry-run', 'extra']).ok).toBe(false);
  });
});
