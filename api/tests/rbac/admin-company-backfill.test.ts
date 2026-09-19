import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapProductionRbacCatalog } from '../../src/modules/rbac/catalog.service.js';
import {
  backfillAdminCompanyScope,
  planAdminCompanyBackfill,
} from '../../src/modules/rbac/admin-company-backfill.service.js';
import { createBranch, createTestUser, ensureTestLocation } from '../helpers/factories.js';
import { createTestPrismaClient, truncateAllTables } from '../helpers/test-db.js';
import { parseCliArgs } from '../../scripts/backfill-admin-company-scope.js';

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

// GC4A (Phase 1 Global Closeout): read-only preflight planner for the
// mutation above. Every test here asserts zero UserRoleScope mutation by
// comparing an exact before/after snapshot, proving planAdminCompanyBackfill
// never calls create/update/delete/upsert.
describe('planAdminCompanyBackfill (GC4A read-only preflight)', () => {
  let db: Awaited<ReturnType<typeof createTestPrismaClient>>;

  beforeAll(async () => {
    db = await createTestPrismaClient();
  });

  beforeEach(async () => {
    await truncateAllTables(db);
    await bootstrapProductionRbacCatalog(db);
  });

  afterAll(async () => db.$disconnect());

  it('plans a single ADMIN LOCATION user for conversion without mutating anything', async () => {
    const adminRole = await db.role.findUniqueOrThrow({ where: { code: 'ADMIN' } });
    const branch = await createBranch(db);
    const admin = await createTestUser(db, adminRole.id, branch.id);
    // createTestUser's ensureTestLocation creates a Location row sharing the
    // Branch's id but with its own generated code/name (Location and Branch
    // are separate models) — read the actual Location row rather than
    // assuming it mirrors Branch.code.
    const location = await db.location.findUniqueOrThrow({ where: { id: branch.id } });
    const before = await db.userRoleScope.findMany({ where: { userId: admin.id }, orderBy: { id: 'asc' } });

    const plan = await planAdminCompanyBackfill(db);

    expect(plan.adminRoleId).toBe(adminRole.id);
    expect(plan.affectedUserCount).toBe(1);
    const user = plan.affectedUsers[0]!;
    expect(user.userId).toBe(admin.id);
    expect(user.locationAssignments).toEqual([
      { locationId: location.id, locationCode: location.code, locationName: location.name, locationActive: location.isActive },
    ]);
    expect(user.alreadyHasCompanyAssignment).toBe(false);
    expect(user.targetState).toEqual({ scopeKind: 'COMPANY', locationId: null });
    expect(plan.canonicalAdminPermissionCodes).toHaveLength(33);

    const after = await db.userRoleScope.findMany({ where: { userId: admin.id }, orderBy: { id: 'asc' } });
    expect(after).toEqual(before);
  });

  it('collapses two ADMIN LOCATION rows into one affected user with two source rows, without mutating', async () => {
    const adminRole = await db.role.findUniqueOrThrow({ where: { code: 'ADMIN' } });
    const branchA = await createBranch(db);
    const branchB = await createBranch(db);
    const admin = await createTestUser(db, adminRole.id, branchA.id);
    await ensureTestLocation(db, branchB.id);
    await db.userRoleScope.create({
      data: { userId: admin.id, roleId: adminRole.id, scopeKind: 'LOCATION', locationId: branchB.id },
    });
    const before = await db.userRoleScope.count();

    const plan = await planAdminCompanyBackfill(db);

    expect(plan.affectedUserCount).toBe(1);
    expect(plan.affectedUsers[0]!.locationAssignments).toHaveLength(2);
    expect(plan.usersWithMultipleLocationRows).toBe(1);
    expect(plan.totalAdminLocationRows).toBe(2);
    expect(await db.userRoleScope.count()).toBe(before);
  });

  it('surfaces mixed LOCATION+COMPANY state for a user without mutating it', async () => {
    const adminRole = await db.role.findUniqueOrThrow({ where: { code: 'ADMIN' } });
    const branch = await createBranch(db);
    const admin = await createTestUser(db, adminRole.id, branch.id);
    await db.userRoleScope.create({
      data: { userId: admin.id, roleId: adminRole.id, scopeKind: 'COMPANY', locationId: null },
    });
    const before = await db.userRoleScope.findMany({ where: { userId: admin.id }, orderBy: { id: 'asc' } });

    const plan = await planAdminCompanyBackfill(db);

    expect(plan.affectedUserCount).toBe(1);
    expect(plan.affectedUsers[0]!.alreadyHasCompanyAssignment).toBe(true);
    expect(plan.usersAlreadyMixedLocationAndCompany).toBe(1);
    const after = await db.userRoleScope.findMany({ where: { userId: admin.id }, orderBy: { id: 'asc' } });
    expect(after).toEqual(before);
  });

  it('does not include an ADMIN already at COMPANY scope with no LOCATION rows as a conversion target', async () => {
    const adminRole = await db.role.findUniqueOrThrow({ where: { code: 'ADMIN' } });
    const user = await db.user.create({
      data: { name: 'Company admin', email: 'company-admin-plan@test.local', passwordHash: 'test-only-hash' },
    });
    await db.userRoleScope.create({
      data: { userId: user.id, roleId: adminRole.id, scopeKind: 'COMPANY', locationId: null },
    });

    const plan = await planAdminCompanyBackfill(db);

    expect(plan.affectedUserCount).toBe(0);
    expect(plan.companyOnlyAdminUsers.map((u) => u.userId)).toContain(user.id);
  });

  it('reports zero affected users when there are no ADMIN LOCATION rows', async () => {
    const plan = await planAdminCompanyBackfill(db);

    expect(plan.affectedUserCount).toBe(0);
    expect(plan.affectedUsers).toEqual([]);
    expect(plan.totalAdminLocationRows).toBe(0);
  });

  it('does not include non-ADMIN assignments', async () => {
    const cashierRole = await db.role.findUniqueOrThrow({ where: { code: 'CASHIER' } });
    const branch = await createBranch(db);
    await createTestUser(db, cashierRole.id, branch.id);

    const plan = await planAdminCompanyBackfill(db);

    expect(plan.affectedUserCount).toBe(0);
    expect(plan.totalAdminLocationRows).toBe(0);
  });

  it('reports the exact canonical Production ADMIN permission set, excluding a legacy lowercase grant', async () => {
    const adminRole = await db.role.findUniqueOrThrow({ where: { code: 'ADMIN' } });
    const legacyPermission = await db.permission.create({ data: { code: 'sale.create.legacy-test' } });
    await db.rolePermission.create({ data: { roleId: adminRole.id, permissionId: legacyPermission.id } });

    const plan = await planAdminCompanyBackfill(db);

    expect(plan.productionPermissionCount).toBe(33);
    expect(plan.actualAdminPermissionCodes).toHaveLength(33);
    expect(plan.actualAdminPermissionCodes).not.toContain('sale.create.legacy-test');
    expect(plan.catalogMatchesExpected).toBe(true);
    expect(plan.readyForExecution).toBe(true);
  });

  it('flags catalog drift as not ready when an expected ADMIN grant is missing', async () => {
    const adminRole = await db.role.findUniqueOrThrow({ where: { code: 'ADMIN' } });
    const priceManage = await db.permission.findUniqueOrThrow({ where: { code: 'PRICE_MANAGE' } });
    await db.rolePermission.delete({
      where: { roleId_permissionId: { roleId: adminRole.id, permissionId: priceManage.id } },
    });

    const plan = await planAdminCompanyBackfill(db);

    expect(plan.catalogMatchesExpected).toBe(false);
    expect(plan.readyForExecution).toBe(false);
    expect(plan.actualAdminPermissionCodes).not.toContain('PRICE_MANAGE');
  });

  it('derives the COMPANY-required permission list from the canonical constant, including USER_MANAGE', async () => {
    const plan = await planAdminCompanyBackfill(db);

    expect(plan.companyRequiredPermissionCodes).toEqual([
      'PRICE_MANAGE',
      'PRODUCT_MANAGE',
      'PRODUCT_VARIANT_MANAGE',
      'USER_MANAGE',
    ]);
  });
});

// GC4A CLI safety contract: pure argument-parsing tests, no database
// involved. Importing the script module (see the top-level import above)
// must not itself open a connection — its direct-execution guard only fires
// when the module is run as the CLI entry point, never on import.
describe('parseCliArgs (GC4A CLI safety contract)', () => {
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

  it('rejects a bare --target with no execution mode (removes the old implicit-mutation default)', () => {
    expect(parseCliArgs(['--target=test']).ok).toBe(false);
  });

  it('rejects both --dry-run and --execute together', () => {
    expect(parseCliArgs(['--target=test', '--dry-run', '--execute']).ok).toBe(false);
  });

  it('rejects --dry-run with no --target', () => {
    expect(parseCliArgs(['--dry-run']).ok).toBe(false);
  });

  it('rejects an invalid --target value', () => {
    expect(parseCliArgs(['--target=production', '--dry-run']).ok).toBe(false);
  });

  it('rejects an unknown safety-relevant argument instead of silently ignoring it', () => {
    expect(parseCliArgs(['--target=test', '--dry-run', '--force']).ok).toBe(false);
  });
});
