import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDemo, seedDemo } from '../../prisma/seed.js';
import { openSeedDatabase } from '../../scripts/demo-database.js';
import {
  backfillLocationsFromBranches,
  type CompanyBootstrap,
} from '../../src/modules/organization/organization.service.js';

// Seed/reset <-> UserRoleScope gate.
//
// D2.2 (Phase 1 Global Closeout, supersedes the Phase1C/GC4F2 design this
// file used to assert): normal canonical seed is Production-native. It no
// longer creates legacy UserBranchRole rows, no longer runs the historical
// Phase1C UserBranchRole -> UserRoleScope sync, and no longer runs the GC4F2
// ADMIN-company convergence step. populate() provisions the five canonical
// identities' Production assignments directly:
//   OWNER COMPANY, ADMIN COMPANY (always),
//   SELLER LOCATION CEN, CASHIER LOCATION CEN, WAREHOUSE LOCATION DEP (only
//   once Location exists; missing/inconsistent CEN or DEP fails closed).
// Legacy MANAGER is never converted to any Production role (D2.1: DEFERRED),
// and seedDemo on a database that still carries historical migration input
// (a legacy manager01 + UserBranchRole rows) must leave that input intact —
// retiring it is a separate, human-approved recovery step.
describe('Demo seed/reset lifecycle provisions canonical Production UserRoleScope directly (D2.2)', () => {
  let db: Awaited<ReturnType<typeof openSeedDatabase>>;

  const FALLBACK_COMPANY_BOOTSTRAP: CompanyBootstrap = {
    id: '00000000-0000-4000-9500-000000000001',
    name: 'Mona Jacinta (scope seed integration test)',
    cuit: '00-55555555-5',
    address: 'Dirección legal test — pendiente de dato real',
  };

  async function safely<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch {
      throw new Error('Seed/scope integration operation failed (database details suppressed)');
    }
  }

  async function ensureLocationBootstrap() {
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
  }

  // Asserts the canonical Production scope shape for the five canonical
  // identities, once Location exists. Reads actual Role/User/Location ids
  // throughout — never assumes iteration order. Global UserBranchRole /
  // UserRoleScope totals are asserted by the clean-reset callers only (see
  // expectCleanCanonicalState), since the historical-preservation test below
  // deliberately carries extra legacy input.
  async function expectCanonicalPhase1ScopeState() {
    const centralLocation = await db.prisma.location.findUniqueOrThrow({ where: { code: 'CEN' } });
    const depotLocation = await db.prisma.location.findUniqueOrThrow({ where: { code: 'DEP' } });
    const centralBranch = await db.prisma.branch.findUniqueOrThrow({ where: { code: 'CEN' } });
    const depotBranch = await db.prisma.branch.findUniqueOrThrow({ where: { code: 'DEP' } });
    expect(centralLocation.id).toBe(centralBranch.id);
    expect(depotLocation.id).toBe(depotBranch.id);

    const expectSingleScope = async (
      email: string,
      roleCode: string,
      scope: { scopeKind: 'COMPANY' | 'LOCATION'; locationId: string | null },
    ) => {
      const role = await db.prisma.role.findUniqueOrThrow({ where: { code: roleCode } });
      const user = await db.prisma.user.findUniqueOrThrow({ where: { email } });
      const scopes = await db.prisma.userRoleScope.findMany({ where: { userId: user.id } });
      expect(scopes).toHaveLength(1);
      expect(scopes[0]).toMatchObject({ roleId: role.id, ...scope });
    };

    await expectSingleScope('owner01@demo.local', 'OWNER', { scopeKind: 'COMPANY', locationId: null });
    await expectSingleScope('admin@demo.local', 'ADMIN', { scopeKind: 'COMPANY', locationId: null });
    await expectSingleScope('seller01@demo.local', 'SELLER', { scopeKind: 'LOCATION', locationId: centralLocation.id });
    await expectSingleScope('cashier01@demo.local', 'CASHIER', { scopeKind: 'LOCATION', locationId: centralLocation.id });
    await expectSingleScope('warehouse01@demo.local', 'WAREHOUSE', { scopeKind: 'LOCATION', locationId: depotLocation.id });

    const adminRole = await db.prisma.role.findUniqueOrThrow({ where: { code: 'ADMIN' } });
    expect(
      await db.prisma.userRoleScope.count({ where: { roleId: adminRole.id, scopeKind: 'LOCATION' } }),
    ).toBe(0);
    // No manager-derived WAREHOUSE: warehouse01 is the only WAREHOUSE holder.
    const warehouseRole = await db.prisma.role.findUniqueOrThrow({ where: { code: 'WAREHOUSE' } });
    expect(await db.prisma.userRoleScope.count({ where: { roleId: warehouseRole.id } })).toBe(1);
    const managerLegacyRole = await db.prisma.role.findUniqueOrThrow({ where: { code: 'MANAGER' } });
    expect(await db.prisma.userRoleScope.count({ where: { roleId: managerLegacyRole.id } })).toBe(0);
  }

  // Clean resetDemo/seedDemo-on-clean state: exactly the five canonical
  // users, no manager01, no legacy UserBranchRole, exactly 5 scopes.
  async function expectCleanCanonicalState() {
    expect(await db.prisma.user.count()).toBe(5);
    expect(await db.prisma.user.findUnique({ where: { email: 'manager01@demo.local' } })).toBeNull();
    expect(await db.prisma.userBranchRole.count()).toBe(0);
    expect(await db.prisma.userRoleScope.count()).toBe(5);
    await expectCanonicalPhase1ScopeState();
  }

  beforeAll(async () => {
    db = await safely(() => openSeedDatabase('test'));
  }, 120000);

  afterAll(async () => {
    if (db) await safely(() => db.close());
  });

  // Intentionally the first test: proves resetDemo never fails on a database
  // where Location (Phase 1A) has genuinely never been backfilled, and
  // restores Location afterward so every later test in this file can assume
  // it is present (Location is never deleted by clear()/populate(), so once
  // restored here it persists for the rest of this file's tests). Without
  // Location, only the location-independent COMPANY assignments (OWNER,
  // ADMIN) are provisioned — never an invented Company/Location, never a
  // partial LOCATION assignment.
  it('resetDemo succeeds with only OWNER and ADMIN COMPANY scopes when Location has never been backfilled yet', async () => {
    await db.prisma.location.deleteMany();
    await safely(() => resetDemo(db.prisma));
    expect(await db.prisma.location.count()).toBe(0);
    expect(await db.prisma.user.count()).toBe(5);
    expect(await db.prisma.userBranchRole.count()).toBe(0);

    const scopes = await db.prisma.userRoleScope.findMany({ include: { role: true, user: true } });
    expect(scopes).toHaveLength(2);
    expect(scopes.every((s) => s.scopeKind === 'COMPANY' && s.locationId === null)).toBe(true);
    expect(scopes.map((s) => `${s.user.email}|${s.role.code}`).sort()).toEqual([
      'admin@demo.local|ADMIN',
      'owner01@demo.local|OWNER',
    ]);
    expect(await db.prisma.userRoleScope.count({ where: { scopeKind: 'LOCATION' } })).toBe(0);

    await ensureLocationBootstrap();
  }, 120000);

  it('resetDemo alone (no separate backfill call) produces the full canonical Phase 1 scope state once Location exists', async () => {
    await safely(() => resetDemo(db.prisma));
    await expectCleanCanonicalState();
  }, 120000);

  it('a second resetDemo from scratch converges to the identical logical scope mapping', async () => {
    await safely(() => resetDemo(db.prisma));
    await expectCleanCanonicalState();
    const before = (await db.prisma.userRoleScope.findMany())
      .map((s) => `${s.userId}|${s.roleId}|${s.scopeKind}|${s.locationId}`)
      .sort();

    await safely(() => resetDemo(db.prisma));
    await expectCleanCanonicalState();
    const after = (await db.prisma.userRoleScope.findMany())
      .map((s) => `${s.userId}|${s.roleId}|${s.scopeKind}|${s.locationId}`)
      .sort();

    expect(after).toEqual(before);
  }, 120000);

  it('seedDemo (without reset) does not duplicate or corrupt the canonical scope state, and does not reintroduce ADMIN LOCATION', async () => {
    await safely(() => resetDemo(db.prisma));
    await expectCleanCanonicalState();
    await safely(() => seedDemo(db.prisma));
    await expectCleanCanonicalState();
  }, 120000);

  // GC4F2 regression test (kept under D2.2): a database carrying mixed ADMIN
  // LOCATION+COMPANY state must be converged back to ADMIN COMPANY only by
  // an ordinary seedDemo, not merely by a one-time backfill script run
  // out-of-band. D2.2 converges the canonical users' scopes directly.
  it('seedDemo repairs a manually-introduced mixed ADMIN LOCATION + COMPANY state back to canonical', async () => {
    await safely(() => resetDemo(db.prisma));
    await expectCleanCanonicalState();

    const adminRole = await db.prisma.role.findUniqueOrThrow({ where: { code: 'ADMIN' } });
    const admin = await db.prisma.user.findFirstOrThrow({ where: { name: 'admin' } });
    const branches = await db.prisma.branch.findMany({ orderBy: { code: 'asc' }, take: 2 });
    await db.prisma.userRoleScope.createMany({
      data: branches.map((branch) => ({
        userId: admin.id,
        roleId: adminRole.id,
        scopeKind: 'LOCATION' as const,
        locationId: branch.id,
      })),
    });
    expect(
      await db.prisma.userRoleScope.count({
        where: { userId: admin.id, roleId: adminRole.id, scopeKind: 'LOCATION' },
      }),
    ).toBe(2);
    expect(
      await db.prisma.userRoleScope.count({
        where: { userId: admin.id, roleId: adminRole.id, scopeKind: 'COMPANY' },
      }),
    ).toBe(1);

    await safely(() => seedDemo(db.prisma));

    await expectCleanCanonicalState();
  }, 120000);

  it('repeated seed/reset cycles converge to the same canonical logical scope state', async () => {
    await safely(() => resetDemo(db.prisma));
    await expectCleanCanonicalState();
    await safely(() => seedDemo(db.prisma));
    await expectCleanCanonicalState();
    await safely(() => resetDemo(db.prisma));
    await expectCleanCanonicalState();
    await safely(() => resetDemo(db.prisma));
    await expectCleanCanonicalState();
  }, 180000);
  // D2.2 DEV-recovery input invariant: seedDemo on an existing database that
  // still carries historical migration input (legacy manager01 + its
  // MANAGER UserBranchRole, plus a legacy UserBranchRole on a canonical user)
  // must NOT delete any of it — it only converges the canonical Production
  // assignments. Retirement of that historical input is a separate,
  // human-approved recovery checkpoint.
  it('seedDemo preserves existing historical manager01 and legacy UserBranchRole input while converging canonical scopes', async () => {
    await safely(() => resetDemo(db.prisma));
    await expectCleanCanonicalState();

    const managerRole = await db.prisma.role.findUniqueOrThrow({ where: { code: 'MANAGER' } });
    const adminLegacyRole = await db.prisma.role.findUniqueOrThrow({ where: { code: 'ADMIN' } });
    const central = await db.prisma.branch.findUniqueOrThrow({ where: { code: 'CEN' } });
    const historicalManager = await db.prisma.user.create({
      data: {
        id: '00000000-0000-4000-8000-000000000601',
        name: 'manager01',
        email: 'manager01@demo.local',
        passwordHash: 'x',
      },
    });
    const admin = await db.prisma.user.findUniqueOrThrow({ where: { email: 'admin@demo.local' } });
    await db.prisma.userBranchRole.createMany({
      data: [
        { userId: historicalManager.id, branchId: central.id, roleId: managerRole.id },
        { userId: admin.id, branchId: central.id, roleId: adminLegacyRole.id },
      ],
    });
    const legacyBefore = await db.prisma.userBranchRole.findMany({ orderBy: { id: 'asc' } });
    expect(legacyBefore).toHaveLength(2);

    await safely(() => seedDemo(db.prisma));

    expect(await db.prisma.user.findUnique({ where: { id: historicalManager.id } })).not.toBeNull();
    expect(await db.prisma.userBranchRole.findMany({ orderBy: { id: 'asc' } })).toEqual(legacyBefore);
    // Historical MANAGER input never becomes a Production assignment.
    expect(await db.prisma.userRoleScope.count({ where: { userId: historicalManager.id } })).toBe(0);
    await expectCanonicalPhase1ScopeState();
    expect(await db.prisma.userRoleScope.count()).toBe(5);

    // Clean reset (not seedDemo) is what removes it — via clear(), not populate().
    await safely(() => resetDemo(db.prisma));
    await expectCleanCanonicalState();
  }, 180000);

  // D2.2 fail-closed: once any Location exists, the canonical CEN and DEP
  // Locations must both resolve (with Location.id == Branch.id). A missing
  // one fails the whole seed/reset closed and rolls it back — never a
  // silently partial authorization state.
  for (const missingCode of ['DEP', 'CEN'] as const) {
    it(`resetDemo and seedDemo fail closed and roll back when the canonical ${missingCode} Location is missing`, async () => {
      await safely(() => resetDemo(db.prisma));
      await expectCleanCanonicalState();
      const scopeCountBefore = await db.prisma.userRoleScope.count();
      try {
        // Cascades that Location's own UserRoleScope rows away with it.
        await db.prisma.location.delete({ where: { code: missingCode } });
        expect(await db.prisma.location.count()).toBeGreaterThan(0);
        const scopesAfterDelete = (await db.prisma.userRoleScope.findMany())
          .map((s) => `${s.userId}|${s.roleId}|${s.scopeKind}|${s.locationId}`)
          .sort();
        expect(scopesAfterDelete.length).toBeLessThan(scopeCountBefore);

        await expect(resetDemo(db.prisma)).rejects.toThrow();
        await expect(seedDemo(db.prisma)).rejects.toThrow();

        // Rolled back: nothing about the pre-attempt state changed.
        expect(
          (await db.prisma.userRoleScope.findMany())
            .map((s) => `${s.userId}|${s.roleId}|${s.scopeKind}|${s.locationId}`)
            .sort(),
        ).toEqual(scopesAfterDelete);
        expect(await db.prisma.user.count()).toBe(5);
      } finally {
        await ensureLocationBootstrap();
      }
      await safely(() => resetDemo(db.prisma));
      await expectCleanCanonicalState();
    }, 180000);
  }
});
