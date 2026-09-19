import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDemo, seedDemo } from '../../prisma/seed.js';
import { openSeedDatabase } from '../../scripts/demo-database.js';
import {
  backfillLocationsFromBranches,
  type CompanyBootstrap,
} from '../../src/modules/organization/organization.service.js';

// Phase 1C seed/reset <-> UserRoleScope compatibility gate, analogous to
// seed-integration.test.ts's Phase 1B gate. Confirms the regression this
// plan's review found: clear() cascades UserRoleScope to 0 via its
// User/Role deletes, but populate() never used to recreate it — resetDemo()
// would silently regress an already-backfilled UserRoleScope state back to
// empty. Fixed by populate() calling
// rbac/scope-backfill.service.ts's syncUserRoleScopeFromUserBranchRole(tx)
// as its last step, on the same transaction — never a nested one — and only
// when Location (Phase 1A) already exists for this database (see the first
// test below for the genuinely-brand-new-database case).
//
// GC4F2 (Phase 1 Global Closeout) addendum: the historical Phase1C
// transitional state (6 ADMIN LOCATION rows, one per legacy branch) is no
// longer the seed's final state. Immediately after the Phase1C sync,
// populate() also runs admin-company-backfill.service.ts's
// syncAdminCompanyScope(tx) (same transaction, never nested), collapsing
// every ADMIN LOCATION row into exactly one ADMIN COMPANY row — the Phase 1D
// canonical target (AGENTS.md "Roles — Production V1"). This file therefore
// asserts the FINAL canonical scope shape (5 rows), not the intermediate
// Phase1C-only shape (10 rows) — see expectCanonicalPhase1ScopeState below.
// verifyUserRoleScopeBackfill() itself is unchanged and untouched: its
// contract is "prove Phase1C legacy-derived LOCATION parity," which the
// final canonical state deliberately no longer satisfies for ADMIN (that
// verifier's own tests live in scope-backfill.test.ts and still assert its
// original, correct semantics) — using it as this file's final-state gate
// would misuse that contract, so this file no longer does.
describe('Demo seed/reset lifecycle preserves the UserRoleScope backfill (Phase 1C) and converges ADMIN to canonical COMPANY scope (Phase 1D, GC4F2)', () => {
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

  // Asserts the FINAL canonical Phase 1 demo scope shape, once Location
  // exists: ADMIN COMPANY (never LOCATION), WAREHOUSE/SELLER/CASHIER each
  // exactly one LOCATION(CEN), OWNER exactly one COMPANY, MANAGER never a
  // Production UserRoleScope (legacy-only), and exactly 5 UserRoleScope rows
  // total. Reads actual Role/User/Location ids throughout — never assumes
  // iteration order.
  async function expectCanonicalPhase1ScopeState() {
    expect(await db.prisma.userBranchRole.count()).toBe(9);
    expect(await db.prisma.userRoleScope.count()).toBe(5);

    const centralBranch = await db.prisma.branch.findFirstOrThrow({ where: { code: 'CEN' } });

    const adminRole = await db.prisma.role.findUniqueOrThrow({ where: { code: 'ADMIN' } });
    const admin = await db.prisma.user.findFirstOrThrow({ where: { name: 'admin' } });
    const adminScopes = await db.prisma.userRoleScope.findMany({ where: { userId: admin.id } });
    expect(adminScopes).toHaveLength(1);
    expect(adminScopes[0]).toMatchObject({ roleId: adminRole.id, scopeKind: 'COMPANY', locationId: null });
    expect(
      await db.prisma.userRoleScope.count({ where: { roleId: adminRole.id, scopeKind: 'LOCATION' } }),
    ).toBe(0);

    const warehouseRole = await db.prisma.role.findUniqueOrThrow({ where: { code: 'WAREHOUSE' } });
    const manager = await db.prisma.user.findFirstOrThrow({ where: { name: 'manager01' } });
    const managerScopes = await db.prisma.userRoleScope.findMany({ where: { userId: manager.id } });
    expect(managerScopes).toHaveLength(1);
    expect(managerScopes[0]).toMatchObject({
      roleId: warehouseRole.id,
      scopeKind: 'LOCATION',
      locationId: centralBranch.id,
    });

    const sellerRole = await db.prisma.role.findUniqueOrThrow({ where: { code: 'SELLER' } });
    const seller = await db.prisma.user.findFirstOrThrow({ where: { name: 'seller01' } });
    const sellerScopes = await db.prisma.userRoleScope.findMany({ where: { userId: seller.id } });
    expect(sellerScopes).toHaveLength(1);
    expect(sellerScopes[0]).toMatchObject({
      roleId: sellerRole.id,
      scopeKind: 'LOCATION',
      locationId: centralBranch.id,
    });

    const cashierRole = await db.prisma.role.findUniqueOrThrow({ where: { code: 'CASHIER' } });
    const cashier = await db.prisma.user.findFirstOrThrow({ where: { name: 'cashier01' } });
    const cashierScopes = await db.prisma.userRoleScope.findMany({ where: { userId: cashier.id } });
    expect(cashierScopes).toHaveLength(1);
    expect(cashierScopes[0]).toMatchObject({
      roleId: cashierRole.id,
      scopeKind: 'LOCATION',
      locationId: centralBranch.id,
    });

    const ownerRole = await db.prisma.role.findUniqueOrThrow({ where: { code: 'OWNER' } });
    const owner = await db.prisma.user.findUniqueOrThrow({ where: { email: 'owner01@demo.local' } });
    const ownerScopes = await db.prisma.userRoleScope.findMany({ where: { userId: owner.id } });
    expect(ownerScopes).toHaveLength(1);
    expect(ownerScopes[0]).toMatchObject({ roleId: ownerRole.id, scopeKind: 'COMPANY', locationId: null });
    expect(await db.prisma.userBranchRole.count({ where: { userId: owner.id } })).toBe(0);

    const managerLegacyRole = await db.prisma.role.findFirstOrThrow({ where: { code: 'MANAGER' } });
    expect(await db.prisma.userRoleScope.count({ where: { roleId: managerLegacyRole.id } })).toBe(0);
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
  // restored here it persists for the rest of this file's tests). The
  // single-scope assertion below also proves GC4F2's ADMIN-company step
  // never fires when Phase1C's own Location gate is closed — it is never
  // invented directly from UserBranchRole, only from Phase1C-produced
  // UserRoleScope LOCATION rows.
  it('resetDemo succeeds and leaves only the canonical OWNER scope when Location has never been backfilled yet', async () => {
    await db.prisma.location.deleteMany();
    await safely(() => resetDemo(db.prisma));
    expect(await db.prisma.location.count()).toBe(0);
    expect(await db.prisma.userBranchRole.count()).toBe(9);
    // Phase 1D.4.2: the canonical OWNER's COMPANY UserRoleScope is
    // location-independent (see prisma/seed.ts's populate()), so it is
    // always provisioned even on a genuinely brand-new database — unlike
    // the UserBranchRole-derived LOCATION sync and the GC4F2 ADMIN-company
    // convergence step, both gated on Location existing.
    const scopes = await db.prisma.userRoleScope.findMany();
    expect(scopes).toHaveLength(1);
    expect(scopes[0]).toMatchObject({ scopeKind: 'COMPANY', locationId: null });
    const owner = await db.prisma.user.findUniqueOrThrow({ where: { email: 'owner01@demo.local' } });
    expect(scopes[0]!.userId).toBe(owner.id);
    expect(await db.prisma.userBranchRole.count({ where: { userId: owner.id } })).toBe(0);

    await ensureLocationBootstrap();
  }, 120000);

  it('resetDemo alone (no separate backfill call) produces the full canonical Phase 1 scope state once Location exists', async () => {
    await safely(() => resetDemo(db.prisma));
    await expectCanonicalPhase1ScopeState();
  }, 120000);

  it('a second resetDemo from scratch converges to the identical logical scope mapping', async () => {
    await safely(() => resetDemo(db.prisma));
    await expectCanonicalPhase1ScopeState();
    const before = (await db.prisma.userRoleScope.findMany())
      .map((s) => `${s.userId}|${s.roleId}|${s.scopeKind}|${s.locationId}`)
      .sort();

    await safely(() => resetDemo(db.prisma));
    await expectCanonicalPhase1ScopeState();
    const after = (await db.prisma.userRoleScope.findMany())
      .map((s) => `${s.userId}|${s.roleId}|${s.scopeKind}|${s.locationId}`)
      .sort();

    expect(after).toEqual(before);
  }, 120000);

  it('seedDemo (without reset) does not duplicate or corrupt the canonical scope state, and does not reintroduce ADMIN LOCATION', async () => {
    await safely(() => resetDemo(db.prisma));
    await expectCanonicalPhase1ScopeState();
    await safely(() => seedDemo(db.prisma));
    await expectCanonicalPhase1ScopeState();
  }, 120000);

  // GC4F2 regression test: this is the exact defect GC4F's design audit
  // identified — before this fix, populate() recreated the legacy
  // UserBranchRole rows and re-ran only the Phase1C LOCATION sync on every
  // seed/reset, with nothing to collapse a since-corrected ADMIN back to
  // COMPANY. A database left in canonical state after this correction could
  // therefore silently regress to mixed ADMIN LOCATION+COMPANY on the very
  // next ordinary `db:reset`/`db:seed`. This test manually recreates that
  // exact mixed state, then proves an ordinary seedDemo repairs it back to
  // canonical, not merely a one-time backfill script run out-of-band.
  it('seedDemo repairs a manually-introduced mixed ADMIN LOCATION + COMPANY state back to canonical', async () => {
    await safely(() => resetDemo(db.prisma));
    await expectCanonicalPhase1ScopeState();

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

    await expectCanonicalPhase1ScopeState();
  }, 120000);

  it('repeated seed/reset cycles converge to the same canonical logical scope state', async () => {
    await safely(() => resetDemo(db.prisma));
    await expectCanonicalPhase1ScopeState();
    await safely(() => seedDemo(db.prisma));
    await expectCanonicalPhase1ScopeState();
    await safely(() => resetDemo(db.prisma));
    await expectCanonicalPhase1ScopeState();
    await safely(() => resetDemo(db.prisma));
    await expectCanonicalPhase1ScopeState();
  }, 180000);
});
