import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDemo, seedDemo } from '../../prisma/seed.js';
import { openSeedDatabase } from '../../scripts/demo-database.js';
import {
  backfillLocationsFromBranches,
  type CompanyBootstrap,
} from '../../src/modules/organization/organization.service.js';
import { verifyUserRoleScopeBackfill } from '../../src/modules/rbac/scope-backfill.service.js';

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
describe('Demo seed/reset lifecycle preserves the UserRoleScope backfill (Phase 1C)', () => {
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

  async function expectFullPhase1CState() {
    expect(await db.prisma.userBranchRole.count()).toBe(9);
    expect(await db.prisma.userRoleScope.count()).toBe(9);
    const verification = await verifyUserRoleScopeBackfill(db.prisma);
    expect(verification.ok).toBe(true);
    expect(verification.issues).toEqual([]);

    const manager = await db.prisma.user.findFirstOrThrow({ where: { name: 'manager01' } });
    const warehouseRole = await db.prisma.role.findFirstOrThrow({ where: { code: 'WAREHOUSE' } });
    const managerScope = await db.prisma.userRoleScope.findFirstOrThrow({
      where: { userId: manager.id },
    });
    expect(managerScope.roleId).toBe(warehouseRole.id);
    expect(managerScope.scopeKind).toBe('LOCATION');

    expect(await db.prisma.userRoleScope.count({ where: { scopeKind: 'COMPANY' } })).toBe(0);
    const ownerRole = await db.prisma.role.findFirst({ where: { code: 'OWNER' } });
    if (ownerRole) {
      expect(await db.prisma.userRoleScope.count({ where: { roleId: ownerRole.id } })).toBe(0);
    }
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
  // restored here it persists for the rest of this file's tests).
  it('resetDemo succeeds and leaves UserRoleScope empty when Location has never been backfilled yet', async () => {
    await db.prisma.location.deleteMany();
    await safely(() => resetDemo(db.prisma));
    expect(await db.prisma.location.count()).toBe(0);
    expect(await db.prisma.userBranchRole.count()).toBe(9);
    expect(await db.prisma.userRoleScope.count()).toBe(0);

    await ensureLocationBootstrap();
  }, 120000);

  it('resetDemo alone (no separate backfill call) produces the full Phase 1C scope state once Location exists', async () => {
    await safely(() => resetDemo(db.prisma));
    await expectFullPhase1CState();
  }, 120000);

  it('a second resetDemo from scratch converges to the identical logical scope mapping', async () => {
    await safely(() => resetDemo(db.prisma));
    await expectFullPhase1CState();
    const before = (await db.prisma.userRoleScope.findMany())
      .map((s) => `${s.userId}|${s.roleId}|${s.scopeKind}|${s.locationId}`)
      .sort();

    await safely(() => resetDemo(db.prisma));
    await expectFullPhase1CState();
    const after = (await db.prisma.userRoleScope.findMany())
      .map((s) => `${s.userId}|${s.roleId}|${s.scopeKind}|${s.locationId}`)
      .sort();

    expect(after).toEqual(before);
  }, 120000);

  it('seedDemo (without reset) does not duplicate or corrupt the scope state', async () => {
    await safely(() => resetDemo(db.prisma));
    await expectFullPhase1CState();
    await safely(() => seedDemo(db.prisma));
    await expectFullPhase1CState();
  }, 120000);

  it('repeated seed/reset cycles converge to the same logical scope state', async () => {
    await safely(() => resetDemo(db.prisma));
    await expectFullPhase1CState();
    await safely(() => seedDemo(db.prisma));
    await expectFullPhase1CState();
    await safely(() => resetDemo(db.prisma));
    await expectFullPhase1CState();
    await safely(() => resetDemo(db.prisma));
    await expectFullPhase1CState();
  }, 180000);
});
