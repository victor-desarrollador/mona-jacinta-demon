import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestPrismaClient, truncateAllTables } from '../helpers/test-db.js';
import { createBranch, createTestUser, ensureTestLocation } from '../helpers/factories.js';
import { bootstrapProductionRbacCatalog } from '../../src/modules/rbac/catalog.service.js';
import { createScopeAssignmentService } from '../../src/modules/backoffice/scope-assignment.service.js';
import type { RoleCode } from '../../src/modules/rbac/roles.js';
import type { PrismaClient } from '../../src/generated/prisma/client.js';

// Phase 1D.4.3 (docs/superpowers/plans/2026-09-14-phase-1d-production-
// authorization.md): per-(user, roleCode) scope assignment operations.
// Service-level only — no route/controller wiring exists yet (Task 1D.4.4
// owns that), so every call here goes directly through
// createScopeAssignmentService, never Supertest/createApp.
describe('scope-assignment.service (Phase 1D.4.3)', () => {
  let db: PrismaClient;
  let service: ReturnType<typeof createScopeAssignmentService>;

  beforeAll(async () => {
    db = await createTestPrismaClient();
    service = createScopeAssignmentService(db);
  }, 120000);

  beforeEach(async () => {
    await truncateAllTables(db);
    await bootstrapProductionRbacCatalog(db);
  }, 120000);

  afterAll(async () => db.$disconnect());

  // The plan's own pseudocode `authAs` includes a `legacyPermissions: []`
  // field that Express.AuthContext no longer has — Phase 1D.3.6 (already
  // completed, checkpoint cefc70d) deleted `legacyPermissions` outright from
  // the auth context shape (src/types/express.d.ts). Built against the
  // CURRENT AuthContext, not the plan's pre-1D.3.6 pseudocode.
  function authAs(
    userId: string,
    assignments: Express.AuthContext['assignments'],
  ): { auth: Express.AuthContext } {
    return {
      auth: { userId, roles: assignments.map((a) => a.roleCode), assignments, effectiveLocationIds: [] },
    };
  }

  const adminCtx = (userId: string) =>
    authAs(userId, [{ roleId: 'r', roleCode: 'ADMIN', scopeKind: 'COMPANY', locationId: null, permissions: [] }]);

  async function findRole(code: 'OWNER' | 'ADMIN' | 'CASHIER' | 'SELLER' | 'WAREHOUSE') {
    return db.role.findUniqueOrThrow({ where: { code } });
  }

  // MANAGER is legacy-only historical data (AGENTS.md, rbac/roles.ts) — the
  // normal test bootstrap (bootstrapProductionRbacCatalog) never creates it,
  // so F1's regression fixtures persist it explicitly to prove the service
  // fails closed even when a legacy Role row genuinely exists in the
  // catalog, not merely because the code is unrecognized.
  async function createManagerRole() {
    return db.role.upsert({
      where: { code: 'MANAGER' },
      create: { code: 'MANAGER', name: 'MANAGER' },
      update: {},
    });
  }

  async function createOwnerUser(email: string) {
    const ownerRole = await findRole('OWNER');
    const owner = await db.user.create({
      data: { name: 'owner', email, passwordHash: 'x' },
    });
    await db.userRoleScope.create({
      data: { userId: owner.id, roleId: ownerRole.id, scopeKind: 'COMPANY', locationId: null },
    });
    return owner;
  }

  function ownerCtx(userId: string, roleId: string) {
    return authAs(userId, [{ roleId, roleCode: 'OWNER', scopeKind: 'COMPANY', locationId: null, permissions: [] }]);
  }

  it('rejects a caller with no auth context (401)', async () => {
    const branch = await createBranch(db);
    const target = await createTestUser(db, (await findRole('CASHIER')).id, branch.id);
    await expect(
      service.assign({ auth: undefined } as never, target.id, { roleCode: 'CASHIER', scopeKind: 'LOCATION', locationIds: [branch.id] }),
    ).rejects.toThrow(/autenticaci/i);
    await expect(service.revoke({ auth: undefined } as never, target.id, 'CASHIER')).rejects.toThrow(/autenticaci/i);
  });

  it('rejects an ADMIN caller assigning roleCode OWNER to anyone', async () => {
    const branch = await createBranch(db);
    const admin = await createTestUser(db, (await findRole('ADMIN')).id, branch.id);
    const target = await createTestUser(db, (await findRole('CASHIER')).id, branch.id);
    await expect(
      service.assign(adminCtx(admin.id), target.id, { roleCode: 'OWNER', scopeKind: 'COMPANY' }),
    ).rejects.toThrow(/Sólo OWNER puede asignar el rol OWNER/);
  });

  it('rejects an ADMIN caller assigning/reassigning ANY role for a user who currently holds OWNER', async () => {
    const branch = await createBranch(db);
    const admin = await createTestUser(db, (await findRole('ADMIN')).id, branch.id);
    const owner = await createOwnerUser('owner-target-1@test.local');
    await expect(
      service.assign(adminCtx(admin.id), owner.id, { roleCode: 'ADMIN', scopeKind: 'COMPANY' }),
    ).rejects.toThrow(/Sólo OWNER puede modificar el alcance de otro OWNER/);
  });

  it('rejects an ADMIN caller revoking ANY role from a user who currently holds OWNER', async () => {
    const admin = await createTestUser(db, (await findRole('ADMIN')).id, (await createBranch(db)).id);
    const owner = await createOwnerUser('owner-target-2@test.local');
    await expect(service.revoke(adminCtx(admin.id), owner.id, 'OWNER')).rejects.toThrow(
      /Sólo OWNER puede modificar el alcance de otro OWNER/,
    );
  });

  it('REQUIRED BY CORRECTION (item 5): OWNER can manage an eligible non-self, non-OWNER target', async () => {
    const branch = await createBranch(db);
    const ownerRole = await findRole('OWNER');
    const owner = await createOwnerUser('owner-caller-1@test.local');
    const target = await createTestUser(db, (await findRole('CASHIER')).id, branch.id);

    const result = await service.assign(ownerCtx(owner.id, ownerRole.id), target.id, {
      roleCode: 'ADMIN',
      scopeKind: 'COMPANY',
    });
    expect(result).toMatchObject({ userId: target.id, roleCode: 'ADMIN', scopeKind: 'COMPANY' });
    // Target keeps its independent, pre-existing CASHIER @ branch assignment
    // (from createTestUser) untouched — this call only ever wrote the ADMIN
    // roleId's row, per the multi-assignment invariant.
    const adminRows = await db.userRoleScope.findMany({
      where: { userId: target.id, roleId: (await findRole('ADMIN')).id },
    });
    expect(adminRows).toHaveLength(1);
    expect(adminRows[0]).toMatchObject({ scopeKind: 'COMPANY', locationId: null });
  });

  it('an already-bootstrapped OWNER may grant OWNER to a different, non-self target', async () => {
    const ownerRole = await findRole('OWNER');
    const owner = await createOwnerUser('owner-caller-2@test.local');
    const target = await createTestUser(db, (await findRole('CASHIER')).id, (await createBranch(db)).id);

    const result = await service.assign(ownerCtx(owner.id, ownerRole.id), target.id, {
      roleCode: 'OWNER',
      scopeKind: 'COMPANY',
    });
    expect(result).toMatchObject({ userId: target.id, roleCode: 'OWNER', scopeKind: 'COMPANY' });
    const rows = await db.userRoleScope.findMany({ where: { userId: target.id, roleId: ownerRole.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ scopeKind: 'COMPANY', locationId: null });
  });

  it('rejects any caller, OWNER included, assigning/revoking their own assignment', async () => {
    const branch = await createBranch(db);
    const admin = await createTestUser(db, (await findRole('ADMIN')).id, branch.id);
    await expect(
      service.assign(adminCtx(admin.id), admin.id, { roleCode: 'ADMIN', scopeKind: 'COMPANY' }),
    ).rejects.toThrow(/No puede modificar su propio alcance/);
    await expect(service.revoke(adminCtx(admin.id), admin.id, 'ADMIN')).rejects.toThrow(
      /No puede modificar su propio alcance/,
    );

    const ownerRole = await findRole('OWNER');
    const owner = await createOwnerUser('owner-self-1@test.local');
    await expect(
      service.assign(ownerCtx(owner.id, ownerRole.id), owner.id, { roleCode: 'ADMIN', scopeKind: 'COMPANY' }),
    ).rejects.toThrow(/No puede modificar su propio alcance/);
    await expect(service.revoke(ownerCtx(owner.id, ownerRole.id), owner.id, 'OWNER')).rejects.toThrow(
      /No puede modificar su propio alcance/,
    );
  });

  it.each(['CASHIER', 'SELLER', 'WAREHOUSE'] as const)('rejects scopeKind COMPANY for roleCode %s', async (roleCode) => {
    const branch = await createBranch(db);
    const admin = await createTestUser(db, (await findRole('ADMIN')).id, branch.id);
    const target = await createTestUser(db, (await findRole('CASHIER')).id, branch.id);
    await expect(
      service.assign(adminCtx(admin.id), target.id, { roleCode, scopeKind: 'COMPANY' } as never),
    ).rejects.toThrow(new RegExp(`El rol ${roleCode} requiere alcance LOCATION`));
  });

  it('rejects scopeKind LOCATION for roleCode ADMIN', async () => {
    const branch = await createBranch(db);
    await ensureTestLocation(db, branch.id);
    const admin = await createTestUser(db, (await findRole('ADMIN')).id, branch.id);
    const target = await createTestUser(db, (await findRole('CASHIER')).id, branch.id);
    await expect(
      service.assign(adminCtx(admin.id), target.id, {
        roleCode: 'ADMIN',
        scopeKind: 'LOCATION',
        locationIds: [branch.id],
      } as never),
    ).rejects.toThrow(/El rol ADMIN requiere alcance COMPANY/);
  });

  // Deliberately an OWNER caller, not adminCtx — see this task's
  // implementation report for a plan discrepancy this isolates: the plan's
  // own sample service code checks "who may assign OWNER" before checking
  // role/scope compatibility, so an ADMIN caller assigning roleCode OWNER
  // with scopeKind LOCATION fails on the authority guard first ("Sólo OWNER
  // puede asignar el rol OWNER"), never reaching the scope-mismatch message
  // the plan's own sample test for this exact combination expects. An OWNER
  // caller isolates the scope-validation behavior on its own.
  it('rejects scopeKind LOCATION for roleCode OWNER', async () => {
    const branch = await createBranch(db);
    await ensureTestLocation(db, branch.id);
    const ownerRole = await findRole('OWNER');
    const owner = await createOwnerUser('owner-scope-check@test.local');
    const target = await createTestUser(db, (await findRole('CASHIER')).id, branch.id);
    await expect(
      service.assign(ownerCtx(owner.id, ownerRole.id), target.id, {
        roleCode: 'OWNER',
        scopeKind: 'LOCATION',
        locationIds: [branch.id],
      } as never),
    ).rejects.toThrow(/El rol OWNER requiere alcance COMPANY/);
  });

  it("reassigning WAREHOUSE @ A -> WAREHOUSE @ B never disturbs an independent SELLER @ A assignment for the same user (the correction's own example)", async () => {
    const branchA = await createBranch(db);
    const branchB = await createBranch(db);
    await ensureTestLocation(db, branchA.id);
    await ensureTestLocation(db, branchB.id);
    const admin = await createTestUser(db, (await findRole('ADMIN')).id, branchA.id);
    const sellerRole = await findRole('SELLER');
    const warehouseRole = await findRole('WAREHOUSE');
    const user = await db.user.create({ data: { name: 'multi', email: 'multi1@test.local', passwordHash: 'x' } });
    await db.userRoleScope.create({ data: { userId: user.id, roleId: sellerRole.id, scopeKind: 'LOCATION', locationId: branchA.id } });
    await db.userRoleScope.create({ data: { userId: user.id, roleId: warehouseRole.id, scopeKind: 'LOCATION', locationId: branchA.id } });

    await service.assign(adminCtx(admin.id), user.id, {
      roleCode: 'WAREHOUSE',
      scopeKind: 'LOCATION',
      locationIds: [branchB.id],
    });

    const sellerRows = await db.userRoleScope.findMany({ where: { userId: user.id, roleId: sellerRole.id } });
    expect(sellerRows).toHaveLength(1);
    expect(sellerRows[0]!.locationId).toBe(branchA.id);

    const warehouseRows = await db.userRoleScope.findMany({ where: { userId: user.id, roleId: warehouseRole.id } });
    expect(warehouseRows).toHaveLength(1);
    expect(warehouseRows[0]!.locationId).toBe(branchB.id);
  });

  it('revoke(target, WAREHOUSE) removes WAREHOUSE only and preserves an independent SELLER assignment', async () => {
    const branch = await createBranch(db);
    const admin = await createTestUser(db, (await findRole('ADMIN')).id, branch.id);
    const sellerRole = await findRole('SELLER');
    const warehouseRole = await findRole('WAREHOUSE');
    const user = await db.user.create({ data: { name: 'multi', email: 'multi2@test.local', passwordHash: 'x' } });
    await db.userRoleScope.create({ data: { userId: user.id, roleId: sellerRole.id, scopeKind: 'LOCATION', locationId: branch.id } });
    await db.userRoleScope.create({ data: { userId: user.id, roleId: warehouseRole.id, scopeKind: 'LOCATION', locationId: branch.id } });

    await service.revoke(adminCtx(admin.id), user.id, 'WAREHOUSE');

    expect(await db.userRoleScope.count({ where: { userId: user.id, roleId: warehouseRole.id } })).toBe(0);
    expect(await db.userRoleScope.count({ where: { userId: user.id, roleId: sellerRole.id } })).toBe(1);
  });

  it('fails with 404 when the target user does not exist', async () => {
    const branch = await createBranch(db);
    const admin = await createTestUser(db, (await findRole('ADMIN')).id, branch.id);
    await expect(
      service.assign(adminCtx(admin.id), '00000000-0000-4000-9999-000000000001', {
        roleCode: 'CASHIER',
        scopeKind: 'LOCATION',
        locationIds: [branch.id],
      }),
    ).rejects.toThrow(/No se encontr/);
  });

  it('cannot silently create a nonexistent Production role: assign fails instead of fabricating a Role row', async () => {
    const branch = await createBranch(db);
    const admin = await createTestUser(db, (await findRole('ADMIN')).id, branch.id);
    const cashierRole = await findRole('CASHIER');
    const target = await db.user.create({ data: { name: 'no-cashier-role', email: 'no-cashier-role@test.local', passwordHash: 'x' } });
    const rolesBefore = await db.role.count();
    // Simulate a catalog gap: the Production CASHIER Role row is gone (e.g. a
    // partial/failed bootstrap). RolePermission.roleId is FK onDelete:
    // Restrict (schema.prisma), so its default-grant rows must go first.
    await db.rolePermission.deleteMany({ where: { roleId: cashierRole.id } });
    await db.role.delete({ where: { id: cashierRole.id } });

    await expect(
      service.assign(adminCtx(admin.id), target.id, {
        roleCode: 'CASHIER',
        scopeKind: 'LOCATION',
        locationIds: [branch.id],
      }),
    ).rejects.toThrow(/no existe en el catálogo/);
    expect(await db.role.count()).toBe(rolesBefore - 1);
  });

  it('LOCATION assignment against a nonexistent Location fails closed (FK-enforced per the plan; no pre-check invented here)', async () => {
    const branch = await createBranch(db);
    const admin = await createTestUser(db, (await findRole('ADMIN')).id, branch.id);
    const target = await createTestUser(db, (await findRole('CASHIER')).id, branch.id);
    const nonexistentLocationId = '00000000-0000-4000-9999-000000000002';
    await expect(
      service.assign(adminCtx(admin.id), target.id, {
        roleCode: 'CASHIER',
        scopeKind: 'LOCATION',
        locationIds: [nonexistentLocationId],
      }),
    ).rejects.toThrow();
    // No partial mutation: the delete+create is one transaction, so the
    // target's prior CASHIER assignment (from createTestUser) must survive.
    const rows = await db.userRoleScope.findMany({ where: { userId: target.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.locationId).toBe(branch.id);
  });

  it('duplicate locationIds in the same assign() call fail atomically without disturbing the prior assignment', async () => {
    const branch = await createBranch(db);
    await ensureTestLocation(db, branch.id);
    const admin = await createTestUser(db, (await findRole('ADMIN')).id, branch.id);
    const target = await createTestUser(db, (await findRole('CASHIER')).id, branch.id);
    await expect(
      service.assign(adminCtx(admin.id), target.id, {
        roleCode: 'CASHIER',
        scopeKind: 'LOCATION',
        locationIds: [branch.id, branch.id],
      }),
    ).rejects.toThrow();
    const rows = await db.userRoleScope.findMany({ where: { userId: target.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.locationId).toBe(branch.id);
  });

  // Independent-audit finding F1: the DTO's z.enum already rejects MANAGER
  // for any caller going through it, but that's an HTTP-boundary shape
  // check, not a service-layer security boundary. These two tests
  // deliberately bypass the DTO with an unsafe runtime cast — exactly what a
  // future in-process caller (or a route handler doing an unchecked
  // `req.params.roleCode as RoleCode` cast, as Task 1D.4.4's own planned
  // controller code does) could hand the service — to prove
  // assertProductionRoleCode fails closed independently of the DTO.
  it('F1: assign rejects a legacy MANAGER roleCode even when the Role row genuinely exists, and never mutates', async () => {
    await createManagerRole();
    const branch = await createBranch(db);
    await ensureTestLocation(db, branch.id);
    const admin = await createTestUser(db, (await findRole('ADMIN')).id, branch.id);
    const cashierRole = await findRole('CASHIER');
    const target = await createTestUser(db, cashierRole.id, branch.id);

    await expect(
      service.assign(adminCtx(admin.id), target.id, {
        roleCode: 'MANAGER',
        scopeKind: 'LOCATION',
        locationIds: [branch.id],
      } as never),
    ).rejects.toThrow(/no es un rol Production válido/);

    const managerRole = await db.role.findUniqueOrThrow({ where: { code: 'MANAGER' } });
    expect(await db.userRoleScope.count({ where: { userId: target.id, roleId: managerRole.id } })).toBe(0);
    // The target's pre-existing, legitimate CASHIER assignment (from
    // createTestUser) survives untouched.
    const cashierRows = await db.userRoleScope.findMany({ where: { userId: target.id, roleId: cashierRole.id } });
    expect(cashierRows).toHaveLength(1);
    expect(cashierRows[0]!.locationId).toBe(branch.id);
  });

  it('F1: revoke rejects a legacy MANAGER roleCode even when a MANAGER UserRoleScope fixture genuinely exists, and never mutates it', async () => {
    const managerRole = await createManagerRole();
    const branch = await createBranch(db);
    await ensureTestLocation(db, branch.id);
    const admin = await createTestUser(db, (await findRole('ADMIN')).id, branch.id);
    const target = await db.user.create({ data: { name: 'manager-fixture', email: 'manager-fixture@test.local', passwordHash: 'x' } });
    // Schema permits this structurally: UserRoleScope.roleId is a plain FK to
    // any Role row — the DB has no constraint tying a roleId to a
    // "Production-only" set, so a legacy MANAGER assignment can genuinely
    // persist (e.g. pre-Phase-1B historical data) for this fixture.
    await db.userRoleScope.create({
      data: { userId: target.id, roleId: managerRole.id, scopeKind: 'LOCATION', locationId: branch.id },
    });

    await expect(
      service.revoke(adminCtx(admin.id), target.id, 'MANAGER' as RoleCode),
    ).rejects.toThrow(/no es un rol Production válido/);

    const rows = await db.userRoleScope.findMany({ where: { userId: target.id, roleId: managerRole.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.locationId).toBe(branch.id);
  });
});
