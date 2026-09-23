import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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

// Phase 1C (D2.1 deferred-MANAGER): backfills UserRoleScope from legacy
// UserBranchRole rows, classifying every legacy row's disposition explicitly
// (ELIGIBLE -> ADMIN/CASHIER/SELLER, DEFERRED -> MANAGER, or fail-closed
// unknown) rather than assuming every row maps to a Production role.
//
// D2.1: this suite no longer depends on prisma/seed.ts's normal seed to
// manufacture its legacy UserBranchRole fixture — D2.2 will stop normal seed
// from creating manager01/legacy UserBranchRole rows for the canonical demo
// identities entirely. This suite owns its own explicit, self-contained
// historical fixture (createStandardHistoricalFixture below), using
// dedicated test-local user identities, independent of prisma/seed.ts's
// array/position/ids. resetDemo/openSeedDatabase('test') is still used only
// for generic baseline data (branches, RBAC catalog, Location bootstrap).
describe('UserRoleScope backfill from UserBranchRole (Phase 1C, D2.1 deferred-MANAGER)', () => {
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

  async function ensureLegacyRole(code: string) {
    const existing = await db.prisma.role.findUnique({ where: { code } });
    if (existing) return existing;
    return db.prisma.role.create({ data: { code, name: code } });
  }

  async function ensureFixtureUser(email: string, name: string) {
    return db.prisma.user.upsert({
      where: { email },
      create: { name, email, passwordHash: 'x' },
      update: {},
    });
  }

  // D2.1: this migration test owns its own historical legacy fixture — it
  // must keep passing after D2.2 removes manager01/legacy UserBranchRole
  // rows from prisma/seed.ts's normal canonical seed. Wipes ALL
  // UserBranchRole rows first (this file's own setup, same pattern this
  // file's afterEach already uses for UserRoleScope) so every test starts
  // from the exact 9-row historical shape: admin ADMIN x6 branches,
  // manager01 MANAGER @ CEN, seller01 SELLER @ CEN, cashier01 CASHIER @ CEN.
  async function createStandardHistoricalFixture() {
    await db.prisma.userBranchRole.deleteMany();

    const [adminRole, managerRole, sellerRole, cashierRole] = await Promise.all([
      ensureLegacyRole('ADMIN'),
      ensureLegacyRole('MANAGER'),
      ensureLegacyRole('SELLER'),
      ensureLegacyRole('CASHIER'),
    ]);

    const [admin, manager, seller, cashier] = await Promise.all([
      ensureFixtureUser('scope-backfill-admin@test.local', 'scope-backfill-admin'),
      ensureFixtureUser('scope-backfill-manager01@test.local', 'scope-backfill-manager01'),
      ensureFixtureUser('scope-backfill-seller01@test.local', 'scope-backfill-seller01'),
      ensureFixtureUser('scope-backfill-cashier01@test.local', 'scope-backfill-cashier01'),
    ]);

    const branches = await db.prisma.branch.findMany({ orderBy: { code: 'asc' } });
    const centralBranch = branches.find((b) => b.code === 'CEN');
    if (branches.length < 6 || !centralBranch) {
      throw new Error('expected the 6 demo branches (including CEN) from the reset baseline');
    }

    await db.prisma.userBranchRole.createMany({
      data: [
        ...branches.map((branch) => ({ userId: admin.id, branchId: branch.id, roleId: adminRole.id })),
        { userId: manager.id, branchId: centralBranch.id, roleId: managerRole.id },
        { userId: seller.id, branchId: centralBranch.id, roleId: sellerRole.id },
        { userId: cashier.id, branchId: centralBranch.id, roleId: cashierRole.id },
      ],
    });

    return { admin, manager, seller, cashier, centralBranch };
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

  beforeEach(async () => {
    // resetDemo's own populate() provisions canonical Production
    // UserRoleScope rows for ITS distinct seed users (D2.2: and no legacy
    // UserBranchRole rows at all) — unrelated to this file's dedicated
    // fixture identities, but sharing the same tables on this hosted TEST
    // database. Every test here owns a fully clean UserRoleScope starting
    // state, not just an incidentally-clean one left by a previous test's
    // afterEach.
    await db.prisma.userRoleScope.deleteMany();
    await createStandardHistoricalFixture();
  });

  afterEach(async () => {
    await safely(() => db.prisma.userRoleScope.deleteMany());
  });

  afterAll(async () => {
    if (db) await safely(() => db.close());
  });

  it('CASE 1: fresh backfill creates 8 eligible LOCATION scopes and defers MANAGER, with exact counters', async () => {
    const result = await backfillUserRoleScopeFromUserBranchRole(db.prisma);
    expect(result).toEqual({
      legacyRowCount: 9,
      eligibleRowCount: 8,
      deferredRowCount: 1,
      created: 8,
      alreadyPresent: 0,
    });
    expect(await db.prisma.userRoleScope.count()).toBe(8);

    const manager = await db.prisma.user.findUniqueOrThrow({
      where: { email: 'scope-backfill-manager01@test.local' },
    });
    expect(await db.prisma.userRoleScope.count({ where: { userId: manager.id } })).toBe(0);

    const admin = await db.prisma.user.findUniqueOrThrow({
      where: { email: 'scope-backfill-admin@test.local' },
    });
    const adminRole = await db.prisma.role.findUniqueOrThrow({ where: { code: 'ADMIN' } });
    const adminScopes = await db.prisma.userRoleScope.findMany({ where: { userId: admin.id } });
    expect(adminScopes).toHaveLength(6);
    expect(adminScopes.every((s) => s.roleId === adminRole.id && s.scopeKind === 'LOCATION')).toBe(true);
  });

  it('CASE 2: is idempotent — second execution creates nothing new and reports everything already present, MANAGER still absent', async () => {
    const first = await backfillUserRoleScopeFromUserBranchRole(db.prisma);
    expect(first).toEqual({
      legacyRowCount: 9,
      eligibleRowCount: 8,
      deferredRowCount: 1,
      created: 8,
      alreadyPresent: 0,
    });

    const second = await backfillUserRoleScopeFromUserBranchRole(db.prisma);
    expect(second).toEqual({
      legacyRowCount: 9,
      eligibleRowCount: 8,
      deferredRowCount: 1,
      created: 0,
      alreadyPresent: 8,
    });
    expect(await db.prisma.userRoleScope.count()).toBe(8);

    const manager = await db.prisma.user.findUniqueOrThrow({
      where: { email: 'scope-backfill-manager01@test.local' },
    });
    expect(await db.prisma.userRoleScope.count({ where: { userId: manager.id } })).toBe(0);
  });

  it('CASE 3: verifier reports eligible-only parity — ok true, eligibleRowCount 8, deferredRowCount 1, scopeCount 8', async () => {
    await backfillUserRoleScopeFromUserBranchRole(db.prisma);
    const verification = await verifyUserRoleScopeBackfill(db.prisma);
    expect(verification.ok).toBe(true);
    expect(verification.issues).toEqual([]);
    expect(verification).toMatchObject({
      legacyRowCount: 9,
      eligibleRowCount: 8,
      deferredRowCount: 1,
      scopeCount: 8,
    });
  });

  it('CASE 4 (MANDATORY): verifier tolerates an independent OWNER COMPANY scope without affecting eligible-only parity', async () => {
    await backfillUserRoleScopeFromUserBranchRole(db.prisma);

    const ownerRole = await db.prisma.role.findUniqueOrThrow({ where: { code: 'OWNER' } });
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
      expect(verification).toMatchObject({
        legacyRowCount: 9,
        eligibleRowCount: 8,
        deferredRowCount: 1,
        scopeCount: 9,
      });
    } finally {
      await db.prisma.userRoleScope.deleteMany({ where: { userId: owner.id } });
      await db.prisma.user.delete({ where: { id: owner.id } });
    }
  });

  it('CASE 5: planner reports the standard fixture with MANAGER explicitly DEFERRED, never a WAREHOUSE target', async () => {
    const plan = await planUserRoleScopeBackfill(db.prisma);

    expect(plan.legacyRowCount).toBe(9);
    expect(plan.eligibleRowCount).toBe(8);
    expect(plan.deferredRowCount).toBe(1);
    expect(plan.expectedCreateCount).toBe(8);
    expect(plan.alreadyPresentCount).toBe(0);
    expect(plan.readyForExecution).toBe(true);
    expect(plan.blockers).toEqual([]);
    expect(plan.rows).toHaveLength(9);

    const manager = await db.prisma.user.findUniqueOrThrow({
      where: { email: 'scope-backfill-manager01@test.local' },
    });
    const managerRow = plan.rows.find((r) => r.userId === manager.id)!;
    expect(managerRow.disposition).toEqual({ kind: 'DEFERRED', reason: 'LEGACY_MANAGER' });

    const admin = await db.prisma.user.findUniqueOrThrow({
      where: { email: 'scope-backfill-admin@test.local' },
    });
    const adminRows = plan.rows.filter((r) => r.userId === admin.id);
    expect(adminRows).toHaveLength(6);
    for (const row of adminRows) {
      expect(row.disposition.kind).toBe('ELIGIBLE');
      if (row.disposition.kind === 'ELIGIBLE') {
        expect(row.disposition.target.productionRoleCode).toBe('ADMIN');
        expect(row.disposition.target.wouldCreate).toBe(true);
      }
    }
  });

  it('CASE 6: an already-present eligible target is excluded from the create count; MANAGER is unaffected', async () => {
    const seller = await db.prisma.user.findUniqueOrThrow({
      where: { email: 'scope-backfill-seller01@test.local' },
    });
    const sellerRole = await db.prisma.role.findUniqueOrThrow({ where: { code: 'SELLER' } });
    const centralBranch = await db.prisma.branch.findFirstOrThrow({ where: { code: 'CEN' } });
    await db.prisma.userRoleScope.create({
      data: { userId: seller.id, roleId: sellerRole.id, scopeKind: 'LOCATION', locationId: centralBranch.id },
    });

    const result = await backfillUserRoleScopeFromUserBranchRole(db.prisma);
    expect(result).toEqual({
      legacyRowCount: 9,
      eligibleRowCount: 8,
      deferredRowCount: 1,
      created: 7,
      alreadyPresent: 1,
    });
  });

  it('CASE 7: an unknown legacy role code fails closed — sync throws, planner blocks, verifier fails, distinct from DEFERRED', async () => {
    const ghostRole = await db.prisma.role.create({ data: { code: 'GHOST', name: 'GHOST' } });
    const admin = await db.prisma.user.findUniqueOrThrow({
      where: { email: 'scope-backfill-admin@test.local' },
    });
    const centralBranch = await db.prisma.branch.findFirstOrThrow({ where: { code: 'CEN' } });
    const ghostAssignment = await db.prisma.userBranchRole.create({
      data: { userId: admin.id, branchId: centralBranch.id, roleId: ghostRole.id },
    });
    try {
      await expect(backfillUserRoleScopeFromUserBranchRole(db.prisma)).rejects.toThrow(
        /No explicit Production role mapping or deferral/,
      );
      expect(await db.prisma.userRoleScope.count()).toBe(0);

      const plan = await planUserRoleScopeBackfill(db.prisma);
      expect(plan.readyForExecution).toBe(false);
      expect(plan.unmappedLegacyRoleCodes).toContain('GHOST');
      const ghostRow = plan.rows.find((r) => r.legacyRowId === ghostAssignment.id)!;
      expect(ghostRow.disposition).toEqual({ kind: 'BLOCKED', blocker: 'UNMAPPED_LEGACY_ROLE' });

      const verification = await verifyUserRoleScopeBackfill(db.prisma);
      expect(verification.ok).toBe(false);
      expect(verification.issues.some((issue) => issue.includes('GHOST'))).toBe(true);
    } finally {
      await db.prisma.userBranchRole.delete({ where: { id: ghostAssignment.id } });
      await db.prisma.role.delete({ where: { id: ghostRole.id } });
    }
  });

  it('CASE 8: no MANAGER -> WAREHOUSE regression — manager01 has zero Production UserRoleScope rows after Phase1C execution, specifically no WAREHOUSE target', async () => {
    await backfillUserRoleScopeFromUserBranchRole(db.prisma);
    const manager = await db.prisma.user.findUniqueOrThrow({
      where: { email: 'scope-backfill-manager01@test.local' },
    });
    const warehouseRole = await db.prisma.role.findUniqueOrThrow({ where: { code: 'WAREHOUSE' } });
    expect(await db.prisma.userRoleScope.count({ where: { userId: manager.id } })).toBe(0);
    expect(
      await db.prisma.userRoleScope.count({ where: { userId: manager.id, roleId: warehouseRole.id } }),
    ).toBe(0);
  });

  it('CASE 9 (MANDATORY): a DEFERRED MANAGER row whose Branch has no matching Location is never MISSING_LOCATION and never blocks readiness', async () => {
    // Dedicated, isolated scenario per Sections 15/16 — not the standard
    // 9-row fixture: only one legacy row exists here (MANAGER, on a fresh
    // Branch deliberately left without a matching Location), so there are no
    // unrelated eligible-row prerequisite failures to reason about. CEN/DEP
    // Location rows are never touched.
    await db.prisma.userBranchRole.deleteMany();
    const orphanBranch = await db.prisma.branch.create({
      data: {
        name: 'Sucursal sin Location (D2.1 Case 9)',
        code: 'D21-ORPHAN',
        address: 'N/A',
        pointOfSaleNumber: 997,
      },
    });
    const locationForOrphan = await db.prisma.location.findUnique({ where: { id: orphanBranch.id } });
    expect(locationForOrphan).toBeNull(); // deliberately no matching Location

    const managerRole = await db.prisma.role.findUniqueOrThrow({ where: { code: 'MANAGER' } });
    const manager = await db.prisma.user.findUniqueOrThrow({
      where: { email: 'scope-backfill-manager01@test.local' },
    });
    const orphanAssignment = await db.prisma.userBranchRole.create({
      data: { userId: manager.id, branchId: orphanBranch.id, roleId: managerRole.id },
    });

    try {
      const plan = await planUserRoleScopeBackfill(db.prisma);
      expect(plan.legacyRowCount).toBe(1);
      expect(plan.eligibleRowCount).toBe(0);
      expect(plan.deferredRowCount).toBe(1);
      expect(plan.blockers).toEqual([]);
      expect(plan.readyForExecution).toBe(true);
      expect(plan.missingLocationBranchIds).not.toContain(orphanBranch.id);
      const managerRow = plan.rows.find((r) => r.legacyRowId === orphanAssignment.id)!;
      expect(managerRow.disposition).toEqual({ kind: 'DEFERRED', reason: 'LEGACY_MANAGER' });

      const result = await backfillUserRoleScopeFromUserBranchRole(db.prisma);
      expect(result).toEqual({
        legacyRowCount: 1,
        eligibleRowCount: 0,
        deferredRowCount: 1,
        created: 0,
        alreadyPresent: 0,
      });
      expect(await db.prisma.userRoleScope.count()).toBe(0);

      const verification = await verifyUserRoleScopeBackfill(db.prisma);
      expect(verification.ok).toBe(true);
      expect(verification.issues).toEqual([]);
    } finally {
      await db.prisma.userBranchRole.delete({ where: { id: orphanAssignment.id } });
      await db.prisma.branch.delete({ where: { id: orphanBranch.id } });
    }
  });

  it('never mutates UserBranchRole', async () => {
    await backfillUserRoleScopeFromUserBranchRole(db.prisma);
    expect(await db.prisma.userBranchRole.count()).toBe(9);
    const managerRole = await db.prisma.role.findFirstOrThrow({ where: { code: 'MANAGER' } });
    expect(await db.prisma.userBranchRole.count({ where: { roleId: managerRole.id } })).toBe(1);
  });

  it('fails closed and rolls back when an ELIGIBLE legacy branch has no matching Location', async () => {
    const admin = await db.prisma.user.findUniqueOrThrow({
      where: { email: 'scope-backfill-admin@test.local' },
    });
    const adminRole = await db.prisma.role.findUniqueOrThrow({ where: { code: 'ADMIN' } });
    const orphanBranch = await db.prisma.branch.create({
      data: { name: 'Sucursal huérfana', code: 'ORPHAN', address: 'N/A', pointOfSaleNumber: 999 },
    });
    const orphanAssignment = await db.prisma.userBranchRole.create({
      data: { userId: admin.id, branchId: orphanBranch.id, roleId: adminRole.id },
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

  it('surfaces a coexisting COMPANY scope without treating it as something Phase1C will remove', async () => {
    const admin = await db.prisma.user.findUniqueOrThrow({
      where: { email: 'scope-backfill-admin@test.local' },
    });
    const adminRole = await db.prisma.role.findUniqueOrThrow({ where: { code: 'ADMIN' } });
    await db.prisma.userRoleScope.create({
      data: { userId: admin.id, roleId: adminRole.id, scopeKind: 'COMPANY', locationId: null },
    });

    const plan = await planUserRoleScopeBackfill(db.prisma);
    const adminRows = plan.rows.filter((r) => r.userId === admin.id);
    expect(adminRows).toHaveLength(6);
    expect(plan.readyForExecution).toBe(true);

    const coexisting = plan.coexistingScopes.filter((s) => s.userId === admin.id);
    expect(coexisting).toHaveLength(1);
    expect(coexisting[0]).toMatchObject({ scopeKind: 'COMPANY', locationId: null, roleCode: 'ADMIN' });
  });
});

// GC4F1 CLI safety contract: pure argument-parsing tests, no database
// involved. Importing the script module (see the top-level import above)
// must not itself open a connection — its direct-execution guard only fires
// when the module is run as the CLI entry point, never on import.
// D2.1: unaffected — parseCliArgs's --dry-run/--execute/--target contract is
// unchanged by the deferred-MANAGER classification model.
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
