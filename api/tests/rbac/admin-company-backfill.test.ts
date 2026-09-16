import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapProductionRbacCatalog } from '../../src/modules/rbac/catalog.service.js';
import { backfillAdminCompanyScope } from '../../src/modules/rbac/admin-company-backfill.service.js';
import { createBranch, createTestUser, ensureTestLocation } from '../helpers/factories.js';
import { createTestPrismaClient, truncateAllTables } from '../helpers/test-db.js';

// Phase 1D.4.1: one-time data correction converting an ADMIN user's
// Phase-1C-backfilled LOCATION UserRoleScope row(s) into a single COMPANY
// assignment (locationId: null), per AGENTS.md's Phase 1D target model
// ("ADMIN — COMPANY scope, operational authority over all branches"). Scoped
// to exactly the (userId, ADMIN roleId) pair per user — never a whole-user
// deletion, never touching another role's independent assignment for the
// same user (docs/superpowers/plans/2026-09-14-phase-1d-production-authorization.md
// Task 1D.4.1, "no one-role-per-user" invariant).
describe('backfillAdminCompanyScope (Phase 1D.4.1)', () => {
  let db: Awaited<ReturnType<typeof createTestPrismaClient>>;

  beforeAll(async () => {
    db = await createTestPrismaClient();
  });

  beforeEach(async () => {
    await truncateAllTables(db);
    await bootstrapProductionRbacCatalog(db);
  });

  afterAll(async () => db.$disconnect());

  it("converts an ADMIN user's LOCATION UserRoleScope rows into a single COMPANY assignment", async () => {
    const adminRole = await db.role.findUniqueOrThrow({ where: { code: 'ADMIN' } });
    const branchA = await createBranch(db);
    const branchB = await createBranch(db);
    // createTestUser already creates one ADMIN @ LOCATION(branchA) row.
    const admin = await createTestUser(db, adminRole.id, branchA.id);
    await ensureTestLocation(db, branchB.id);
    await db.userRoleScope.create({
      data: { userId: admin.id, roleId: adminRole.id, scopeKind: 'LOCATION', locationId: branchB.id },
    });
    expect(await db.userRoleScope.count({ where: { userId: admin.id } })).toBe(2);

    const result = await backfillAdminCompanyScope(db);

    expect(result.usersConverted).toBe(1);
    const rows = await db.userRoleScope.findMany({ where: { userId: admin.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ scopeKind: 'COMPANY', locationId: null });
  });

  it('never touches a co-existing, independent assignment for a different role on the same user', async () => {
    const adminRole = await db.role.findUniqueOrThrow({ where: { code: 'ADMIN' } });
    const cashierRole = await db.role.findUniqueOrThrow({ where: { code: 'CASHIER' } });
    const branch = await createBranch(db);
    const user = await createTestUser(db, adminRole.id, branch.id);
    await db.userRoleScope.create({
      data: { userId: user.id, roleId: cashierRole.id, scopeKind: 'LOCATION', locationId: branch.id },
    });

    await backfillAdminCompanyScope(db);

    const cashierRows = await db.userRoleScope.findMany({ where: { userId: user.id, roleId: cashierRole.id } });
    expect(cashierRows).toHaveLength(1);
    expect(cashierRows[0]!.scopeKind).toBe('LOCATION');
    expect(cashierRows[0]!.locationId).toBe(branch.id);
  });

  it('is idempotent', async () => {
    const adminRole = await db.role.findUniqueOrThrow({ where: { code: 'ADMIN' } });
    const branch = await createBranch(db);
    const admin = await createTestUser(db, adminRole.id, branch.id);

    const first = await backfillAdminCompanyScope(db);
    expect(first.usersConverted).toBe(1);

    const second = await backfillAdminCompanyScope(db);
    expect(second.usersConverted).toBe(0);

    const rows = await db.userRoleScope.findMany({ where: { userId: admin.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ scopeKind: 'COMPANY', locationId: null });
  });

  it('never touches CASHIER/SELLER/WAREHOUSE LOCATION rows', async () => {
    const cashierRole = await db.role.findUniqueOrThrow({ where: { code: 'CASHIER' } });
    const branch = await createBranch(db);
    const cashier = await createTestUser(db, cashierRole.id, branch.id);

    const result = await backfillAdminCompanyScope(db);

    expect(result.usersConverted).toBe(0);
    const rows = await db.userRoleScope.findMany({ where: { userId: cashier.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.scopeKind).toBe('LOCATION');
  });

  it('leaves an ADMIN already at COMPANY scope with no LOCATION rows unchanged', async () => {
    const adminRole = await db.role.findUniqueOrThrow({ where: { code: 'ADMIN' } });
    const user = await db.user.create({
      data: { name: 'Company admin', email: 'company-admin@test.local', passwordHash: 'test-only-hash' },
    });
    await db.userRoleScope.create({
      data: { userId: user.id, roleId: adminRole.id, scopeKind: 'COMPANY', locationId: null },
    });

    const result = await backfillAdminCompanyScope(db);

    expect(result.usersConverted).toBe(0);
    const rows = await db.userRoleScope.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ scopeKind: 'COMPANY', locationId: null });
  });
});
