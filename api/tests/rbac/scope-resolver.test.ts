import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resetDemo } from '../../prisma/seed.js';
import { openSeedDatabase } from '../../scripts/demo-database.js';
import {
  backfillLocationsFromBranches,
  type CompanyBootstrap,
} from '../../src/modules/organization/organization.service.js';
import { bootstrapProductionRbacCatalog } from '../../src/modules/rbac/catalog.service.js';
import { backfillUserRoleScopeFromUserBranchRole } from '../../src/modules/rbac/scope-backfill.service.js';
import { resolveUserRoleScopes } from '../../src/modules/rbac/scope-resolver.js';

// Phase 1C SWITCH step: the authoritative UserRoleScope reader. Read-only —
// this suite proves it reflects the backfilled data correctly; it does not
// exercise any live route or middleware (none call it yet, by design).
describe('UserRoleScope resolver (Phase 1C SWITCH)', () => {
  let db: Awaited<ReturnType<typeof openSeedDatabase>>;

  const FALLBACK_COMPANY_BOOTSTRAP: CompanyBootstrap = {
    id: '00000000-0000-4000-9400-000000000001',
    name: 'Mona Jacinta (scope resolver test)',
    cuit: '00-44444444-4',
    address: 'Dirección legal test — pendiente de dato real',
  };

  async function safely<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch {
      throw new Error('Scope resolver integration operation failed (database details suppressed)');
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

  // D2.2: normal canonical seed no longer creates any UserBranchRole rows,
  // so this suite owns its historical legacy input explicitly — dedicated
  // test-local identities, never canonical seed users. Tracked here so
  // afterEach can remove exactly these fixtures (UserBranchRole -> User is
  // onDelete: Restrict, so the legacy rows go first).
  const fixtureUserIds: string[] = [];

  async function createLegacyFixtureUser(label: string, legacyRoleCode: string, branchCodes: string[]) {
    const legacyRole = await db.prisma.role.findUniqueOrThrow({ where: { code: legacyRoleCode } });
    const branches = await db.prisma.branch.findMany({ where: { code: { in: branchCodes } } });
    expect(branches).toHaveLength(branchCodes.length);
    const user = await db.prisma.user.create({
      data: { name: `scope-resolver-${label}`, email: `scope-resolver-${label}@test.local`, passwordHash: 'x' },
    });
    fixtureUserIds.push(user.id);
    await db.prisma.userBranchRole.createMany({
      data: branches.map((branch) => ({ userId: user.id, branchId: branch.id, roleId: legacyRole.id })),
    });
    return { user, branches };
  }

  afterEach(async () => {
    await safely(() => db.prisma.userRoleScope.deleteMany());
    await safely(() => db.prisma.userBranchRole.deleteMany({ where: { userId: { in: fixtureUserIds } } }));
    await safely(() => db.prisma.user.deleteMany({ where: { id: { in: fixtureUserIds } } }));
    fixtureUserIds.length = 0;
  });

  afterAll(async () => {
    if (db) await safely(() => db.close());
  });

  // D2.1 supersession (AGENTS.md "Roles — Production V1"): legacy MANAGER is
  // DEFERRED by the Phase1C backfill — it never resolves to WAREHOUSE (or
  // any other Production role), so the resolver sees no Production scope.
  it('resolves no Production scope for a legacy MANAGER user after Phase1C backfill (MANAGER is DEFERRED)', async () => {
    const { user: manager } = await createLegacyFixtureUser('manager', 'MANAGER', ['CEN']);

    const result = await backfillUserRoleScopeFromUserBranchRole(db.prisma);
    expect(result.deferredRowCount).toBe(1);
    expect(result.eligibleRowCount).toBe(0);
    expect(result.created).toBe(0);

    expect(await resolveUserRoleScopes(db.prisma, manager.id)).toEqual([]);
    // The historical input itself is left intact for later recovery.
    expect(await db.prisma.userBranchRole.count({ where: { userId: manager.id } })).toBe(1);
  });

  it('resolves all 6 LOCATION scopes for a legacy ADMIN user', async () => {
    const allBranchCodes = (await db.prisma.branch.findMany({ select: { code: true } })).map((b) => b.code);
    expect(allBranchCodes).toHaveLength(6);
    const { user: admin, branches } = await createLegacyFixtureUser('admin', 'ADMIN', allBranchCodes);

    await backfillUserRoleScopeFromUserBranchRole(db.prisma);
    const scopes = await resolveUserRoleScopes(db.prisma, admin.id);
    expect(scopes).toHaveLength(6);
    expect(scopes.every((s) => s.roleCode === 'ADMIN' && s.scopeKind === 'LOCATION')).toBe(true);
    expect(scopes.map((s) => s.locationId).sort()).toEqual(branches.map((b) => b.id).sort());
  });

  it('returns an empty list for a user with no UserRoleScope rows', async () => {
    const seller = await db.prisma.user.findFirstOrThrow({ where: { name: 'seller01' } });
    // Canonical seed provisions seller01's own SELLER CEN scope — remove it
    // explicitly rather than relying on a previous test's afterEach.
    await db.prisma.userRoleScope.deleteMany({ where: { userId: seller.id } });
    const scopes = await resolveUserRoleScopes(db.prisma, seller.id);
    expect(scopes).toEqual([]);
  });
});
