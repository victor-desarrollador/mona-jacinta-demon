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

  afterEach(async () => {
    await safely(() => db.prisma.userRoleScope.deleteMany());
  });

  afterAll(async () => {
    if (db) await safely(() => db.close());
  });

  it('resolves the backfilled LOCATION scope for a legacy MANAGER user as WAREHOUSE', async () => {
    await backfillUserRoleScopeFromUserBranchRole(db.prisma);
    const manager = await db.prisma.user.findFirstOrThrow({ where: { name: 'manager01' } });
    const legacyAssignment = await db.prisma.userBranchRole.findFirstOrThrow({
      where: { userId: manager.id },
    });

    const scopes = await resolveUserRoleScopes(db.prisma, manager.id);
    expect(scopes).toHaveLength(1);
    expect(scopes[0]).toMatchObject({
      roleCode: 'WAREHOUSE',
      scopeKind: 'LOCATION',
      locationId: legacyAssignment.branchId,
    });
  });

  it('resolves all 6 LOCATION scopes for the legacy ADMIN user', async () => {
    await backfillUserRoleScopeFromUserBranchRole(db.prisma);
    const admin = await db.prisma.user.findFirstOrThrow({ where: { name: 'admin' } });
    const scopes = await resolveUserRoleScopes(db.prisma, admin.id);
    expect(scopes).toHaveLength(6);
    expect(scopes.every((s) => s.roleCode === 'ADMIN' && s.scopeKind === 'LOCATION')).toBe(true);
  });

  it('returns an empty list for a user with no UserRoleScope rows', async () => {
    const seller = await db.prisma.user.findFirstOrThrow({ where: { name: 'seller01' } });
    const scopes = await resolveUserRoleScopes(db.prisma, seller.id);
    expect(scopes).toEqual([]);
  });
});
