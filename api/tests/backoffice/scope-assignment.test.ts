import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestPrismaClient, truncateAllTables } from '../helpers/test-db.js';
import { createBranch, createTestUser, ensureTestLocation } from '../helpers/factories.js';
import { getAuthToken } from '../helpers/auth.js';
import { bootstrapProductionRbacCatalog } from '../../src/modules/rbac/catalog.service.js';
import { createScopeAssignmentService } from '../../src/modules/backoffice/scope-assignment.service.js';
import { createApp } from '../../src/app.js';
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

  afterAll(async () => db?.$disconnect());

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

  // GC2 (Phase 1 Global Closeout): the canonical, non-transitional ADMIN
  // shape — exactly one UserRoleScope row, scopeKind COMPANY, locationId
  // null, and deliberately no legacy UserBranchRole row (unlike
  // createTestUser, which always creates a LOCATION row). Used wherever an
  // HTTP test needs a real ADMIN caller for a USER_MANAGE-gated route now
  // that USER_MANAGE requires COMPANY scope.
  async function createCompanyAdmin(email: string) {
    const adminRole = await findRole('ADMIN');
    const admin = await db.user.create({ data: { name: 'company-admin', email, passwordHash: 'x' } });
    await db.userRoleScope.create({
      data: { userId: admin.id, roleId: adminRole.id, scopeKind: 'COMPANY', locationId: null },
    });
    return admin;
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

  // Phase 1D.4.4: HTTP exposure of the already-approved Task 1D.4.3 service.
  // Nested inside the outer describe so it reuses the single test-database
  // client and the outer beforeEach's truncate+bootstrap — this file's own
  // established convention (no test file in this repo opens two independent
  // createTestPrismaClient() pools). Only the HTTP-specific concerns this
  // task actually adds are covered here: route registration, USER_MANAGE
  // gating, request/response wiring, and validate() middleware — every
  // authorization/business invariant already has direct-service coverage
  // above and is deliberately not re-proven end-to-end here (Task 1D.4.5
  // owns the dedicated privilege-escalation suite).
  describe('HTTP exposure (Phase 1D.4.4)', () => {
    let app: ReturnType<typeof createApp>;

    beforeAll(() => {
      app = createApp(db);
    });

    it('POST /api/v1/backoffice/users/:userId/scope: a CASHIER caller (no USER_MANAGE) gets 403 and creates no assignment', async () => {
      const branch = await createBranch(db);
      await ensureTestLocation(db, branch.id);
      const cashier = await createTestUser(db, (await findRole('CASHIER')).id, branch.id);
      const target = await createTestUser(db, (await findRole('SELLER')).id, branch.id);
      const before = await db.userRoleScope.findMany({ where: { userId: target.id } });

      const res = await request(app)
        .post(`/api/v1/backoffice/users/${target.id}/scope`)
        .set('Authorization', `Bearer ${await getAuthToken(cashier)}`)
        .send({ roleCode: 'WAREHOUSE', scopeKind: 'LOCATION', locationIds: [branch.id] });

      expect(res.status).toBe(403);
      const after = await db.userRoleScope.findMany({ where: { userId: target.id } });
      expect(after).toEqual(before);
    });

    // GC2 (Phase 1 Global Closeout, security regression coverage): USER_MANAGE
    // is now COMPANY-required (permissions.ts's COMPANY_SCOPE_REQUIRED_FOR_ADMIN),
    // precisely because this route has no location dimension at all — it never
    // resolves or checks a branch. Before GC2, a transitional LOCATION-scoped
    // ADMIN passed this route's global USER_MANAGE gate and could reassign any
    // user to any location, including one the caller had no assignment to
    // (this exact fixture, previously asserting `res.status).toBeLessThan(300)`
    // for a branchA-only ADMIN reassigning a target to branchB). That gap is
    // now closed: this must stay 403 to prevent the regression, not merely to
    // pass once.
    it('POST /api/v1/backoffice/users/:userId/scope: a transitional ADMIN LOCATION caller is denied USER_MANAGE, even for an eligible non-self, non-OWNER target at an unrelated location', async () => {
      const branchA = await createBranch(db);
      const branchB = await createBranch(db);
      await ensureTestLocation(db, branchA.id);
      await ensureTestLocation(db, branchB.id);
      const admin = await createTestUser(db, (await findRole('ADMIN')).id, branchA.id);
      const sellerRole = await findRole('SELLER');
      const warehouseRole = await findRole('WAREHOUSE');
      const target = await db.user.create({ data: { name: 'http-multi-1', email: 'http-multi-1@test.local', passwordHash: 'x' } });
      await db.userRoleScope.create({ data: { userId: target.id, roleId: sellerRole.id, scopeKind: 'LOCATION', locationId: branchA.id } });
      await db.userRoleScope.create({ data: { userId: target.id, roleId: warehouseRole.id, scopeKind: 'LOCATION', locationId: branchA.id } });
      const before = await db.userRoleScope.findMany({ where: { userId: target.id } });

      const res = await request(app)
        .post(`/api/v1/backoffice/users/${target.id}/scope`)
        .set('Authorization', `Bearer ${await getAuthToken(admin)}`)
        .send({ roleCode: 'SELLER', scopeKind: 'LOCATION', locationIds: [branchB.id] });

      expect(res.status).toBe(403);
      const after = await db.userRoleScope.findMany({ where: { userId: target.id } });
      expect(after).toEqual(before);
    });

    // GC2 companion proof: the canonical, non-transitional ADMIN COMPANY
    // caller retains the exact legitimate cross-location capability the
    // denial test above proves a LOCATION-scoped ADMIN no longer has.
    it('POST /api/v1/backoffice/users/:userId/scope: an ADMIN COMPANY caller reassigns SELLER to Location B without disturbing an independent WAREHOUSE @ Location A assignment', async () => {
      const branchA = await createBranch(db);
      const branchB = await createBranch(db);
      await ensureTestLocation(db, branchA.id);
      await ensureTestLocation(db, branchB.id);
      const admin = await createCompanyAdmin('company-admin-scope-1@test.local');
      const sellerRole = await findRole('SELLER');
      const warehouseRole = await findRole('WAREHOUSE');
      const target = await db.user.create({ data: { name: 'http-multi-1b', email: 'http-multi-1b@test.local', passwordHash: 'x' } });
      await db.userRoleScope.create({ data: { userId: target.id, roleId: sellerRole.id, scopeKind: 'LOCATION', locationId: branchA.id } });
      await db.userRoleScope.create({ data: { userId: target.id, roleId: warehouseRole.id, scopeKind: 'LOCATION', locationId: branchA.id } });

      const res = await request(app)
        .post(`/api/v1/backoffice/users/${target.id}/scope`)
        .set('Authorization', `Bearer ${await getAuthToken(admin)}`)
        .send({ roleCode: 'SELLER', scopeKind: 'LOCATION', locationIds: [branchB.id] });

      expect(res.status).toBeLessThan(300);
      expect(res.body).toMatchObject({ userId: target.id, roleCode: 'SELLER', scopeKind: 'LOCATION' });

      const sellerRows = await db.userRoleScope.findMany({ where: { userId: target.id, roleId: sellerRole.id } });
      expect(sellerRows).toHaveLength(1);
      expect(sellerRows[0]!.locationId).toBe(branchB.id);

      const warehouseRows = await db.userRoleScope.findMany({ where: { userId: target.id, roleId: warehouseRole.id } });
      expect(warehouseRows).toHaveLength(1);
      expect(warehouseRows[0]!.locationId).toBe(branchA.id);
    });

    it('DELETE /api/v1/backoffice/users/:userId/scope/:roleCode removes exactly that assignment and preserves an independent one', async () => {
      const branchA = await createBranch(db);
      const branchB = await createBranch(db);
      await ensureTestLocation(db, branchA.id);
      await ensureTestLocation(db, branchB.id);
      // GC2: USER_MANAGE now requires COMPANY scope; this test is about
      // revoke's independent-assignment behavior, not the USER_MANAGE gate
      // itself, so its incidental caller must be a real ADMIN COMPANY.
      const admin = await createCompanyAdmin('company-admin-scope-2@test.local');
      const sellerRole = await findRole('SELLER');
      const warehouseRole = await findRole('WAREHOUSE');
      const target = await db.user.create({ data: { name: 'http-multi-2', email: 'http-multi-2@test.local', passwordHash: 'x' } });
      await db.userRoleScope.create({ data: { userId: target.id, roleId: sellerRole.id, scopeKind: 'LOCATION', locationId: branchA.id } });
      await db.userRoleScope.create({ data: { userId: target.id, roleId: warehouseRole.id, scopeKind: 'LOCATION', locationId: branchB.id } });

      const res = await request(app)
        .delete(`/api/v1/backoffice/users/${target.id}/scope/WAREHOUSE`)
        .set('Authorization', `Bearer ${await getAuthToken(admin)}`);

      expect(res.status).toBeLessThan(300);
      expect(res.body).toMatchObject({ userId: target.id, roleCode: 'WAREHOUSE', revoked: true });

      expect(await db.userRoleScope.count({ where: { userId: target.id, roleId: warehouseRole.id } })).toBe(0);
      const sellerRows = await db.userRoleScope.findMany({ where: { userId: target.id, roleId: sellerRole.id } });
      expect(sellerRows).toHaveLength(1);
      expect(sellerRows[0]!.locationId).toBe(branchA.id);
    });

    // Mandatory per Task 1D.4.4: proves the target's NEXT /me call rebuilds
    // authorization context from current DB state (src/middleware/auth.ts's
    // createRequireAuth re-queries roleScopes on every request — the JWT
    // itself carries only `sub`), not a stale in-memory object.
    it("the target user's next GET /api/v1/auth/me reflects a revoke via effectiveLocationIds (branchIds), while the remaining assignment stays reachable", async () => {
      const branchA = await createBranch(db);
      const branchB = await createBranch(db);
      await ensureTestLocation(db, branchA.id);
      await ensureTestLocation(db, branchB.id);
      // GC2: USER_MANAGE now requires COMPANY scope; this test is about the
      // /me projection reflecting a revoke, not the USER_MANAGE gate itself,
      // so its incidental caller must be a real ADMIN COMPANY.
      const admin = await createCompanyAdmin('company-admin-scope-3@test.local');
      const sellerRole = await findRole('SELLER');
      const warehouseRole = await findRole('WAREHOUSE');
      const target = await db.user.create({ data: { name: 'http-me-target', email: 'http-me-target@test.local', passwordHash: 'x' } });
      await db.userRoleScope.create({ data: { userId: target.id, roleId: sellerRole.id, scopeKind: 'LOCATION', locationId: branchA.id } });
      await db.userRoleScope.create({ data: { userId: target.id, roleId: warehouseRole.id, scopeKind: 'LOCATION', locationId: branchB.id } });
      const targetToken = await getAuthToken(target);

      const before = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${targetToken}`);
      expect(before.status).toBe(200);
      expect([...before.body.user.branchIds].sort()).toEqual([branchA.id, branchB.id].sort());

      const revokeRes = await request(app)
        .delete(`/api/v1/backoffice/users/${target.id}/scope/WAREHOUSE`)
        .set('Authorization', `Bearer ${await getAuthToken(admin)}`);
      expect(revokeRes.status).toBeLessThan(300);

      const after = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${targetToken}`);
      expect(after.status).toBe(200);
      expect(after.body.user.branchIds).toEqual([branchA.id]);
    });

    it('DELETE .../scope/MANAGER is rejected by params validation before it can reach the service, with zero mutation', async () => {
      const branch = await createBranch(db);
      await ensureTestLocation(db, branch.id);
      const admin = await createTestUser(db, (await findRole('ADMIN')).id, branch.id);
      const target = await createTestUser(db, (await findRole('SELLER')).id, branch.id);
      const before = await db.userRoleScope.findMany({ where: { userId: target.id } });

      const res = await request(app)
        .delete(`/api/v1/backoffice/users/${target.id}/scope/MANAGER`)
        .set('Authorization', `Bearer ${await getAuthToken(admin)}`);

      expect(res.status).toBe(400);
      expect(await db.userRoleScope.findMany({ where: { userId: target.id } })).toEqual(before);
    });

    it('POST .../scope rejects a COMPANY body carrying a stray locationIds field before it can reach the service, with zero mutation', async () => {
      const branch = await createBranch(db);
      await ensureTestLocation(db, branch.id);
      const admin = await createTestUser(db, (await findRole('ADMIN')).id, branch.id);
      const target = await createTestUser(db, (await findRole('SELLER')).id, branch.id);
      const before = await db.userRoleScope.findMany({ where: { userId: target.id } });

      const res = await request(app)
        .post(`/api/v1/backoffice/users/${target.id}/scope`)
        .set('Authorization', `Bearer ${await getAuthToken(admin)}`)
        .send({ roleCode: 'ADMIN', scopeKind: 'COMPANY', locationIds: [branch.id] });

      expect(res.status).toBe(400);
      expect(await db.userRoleScope.findMany({ where: { userId: target.id } })).toEqual(before);
    });
  });

  // SEC-A (MJ-ADMIN-ADM-02-SEC-A-IMPLEMENT-01, owner-approved 2026-10-17).
  // The three approved policies under test:
  //   1. a NEW LOCATION assignment over an inactive Location is rejected
  //      with 400 LOCATION_INACTIVE (nonexistent ids keep the FK 409 path);
  //   2. exactly one AuditLog row per EFFECTIVE mutation, written inside
  //      the mutation's own transaction (authenticated actor, branchId
  //      null, before/after scope-shape snapshots, never credentials);
  //   3. an idempotent revoke that removes zero rows writes no AuditLog.
  describe('SEC-A: F-01 transactional audit + F-02 inactive locations', () => {
    let app: ReturnType<typeof createApp>;

    beforeAll(() => {
      app = createApp(db);
    });

    async function createInactiveLocation(): Promise<string> {
      const branch = await createBranch(db);
      await ensureTestLocation(db, branch.id);
      await db.location.update({ where: { id: branch.id }, data: { isActive: false } });
      return branch.id;
    }

    function auditRows(targetId: string) {
      return db.auditLog.findMany({
        where: { entityId: targetId, entityType: 'UserRoleScope' },
      });
    }

    async function ownerCaller(email: string) {
      const owner = await createOwnerUser(email);
      const ctx = ownerCtx(owner.id, (await findRole('OWNER')).id);
      return { owner, ctx };
    }

    async function freshTarget(name: string) {
      return db.user.create({ data: { name, email: `${name}@test.local`, passwordHash: 'x' } });
    }

    it('F-01: an effective assign writes exactly one AuditLog row in the same transaction (actor, branchId null, USER_SCOPE_ASSIGNED, before null, after snapshot)', async () => {
      const branch = await createBranch(db);
      await ensureTestLocation(db, branch.id);
      const { owner, ctx } = await ownerCaller('sec-a-owner-1@test.local');
      const target = await freshTarget('sec-a-1');

      await service.assign(ctx, target.id, {
        roleCode: 'SELLER',
        scopeKind: 'LOCATION',
        locationIds: [branch.id],
      });

      const rows = await auditRows(target.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        userId: owner.id,
        branchId: null,
        action: 'USER_SCOPE_ASSIGNED',
        entityType: 'UserRoleScope',
        entityId: target.id,
      });
      expect(rows[0]!.before).toBeNull();
      expect(rows[0]!.after).toMatchObject({
        roleCode: 'SELLER',
        scopeKind: 'LOCATION',
        locationIds: [branch.id],
      });
      // Snapshot hygiene: the audit row carries the scope shape only — never credentials.
      expect(JSON.stringify(rows)).not.toContain('passwordHash');
    });

    it('F-01: a replacement captures the previous assignment shape as the before snapshot', async () => {
      const branchA = await createBranch(db);
      const branchB = await createBranch(db);
      await ensureTestLocation(db, branchA.id);
      await ensureTestLocation(db, branchB.id);
      const { ctx } = await ownerCaller('sec-a-owner-2@test.local');
      const target = await freshTarget('sec-a-2');

      await service.assign(ctx, target.id, { roleCode: 'SELLER', scopeKind: 'LOCATION', locationIds: [branchA.id] });
      await service.assign(ctx, target.id, { roleCode: 'SELLER', scopeKind: 'LOCATION', locationIds: [branchB.id] });

      const rows = await auditRows(target.id);
      expect(rows).toHaveLength(2);
      const initial = rows.find((row) => row.action === 'USER_SCOPE_ASSIGNED' && row.before === null);
      const replacement = rows.find((row) => row.action === 'USER_SCOPE_ASSIGNED' && row.before !== null);
      expect(initial).toBeDefined();
      expect(replacement).toBeDefined();
      expect(replacement!.before).toMatchObject({
        roleCode: 'SELLER',
        scopeKind: 'LOCATION',
        locationIds: [branchA.id],
      });
      expect(replacement!.after).toMatchObject({
        roleCode: 'SELLER',
        scopeKind: 'LOCATION',
        locationIds: [branchB.id],
      });
    });

    it('F-01: an effective revoke writes exactly one AuditLog row with the removed shape as before and after null', async () => {
      const branch = await createBranch(db);
      await ensureTestLocation(db, branch.id);
      const { owner, ctx } = await ownerCaller('sec-a-owner-3@test.local');
      const target = await freshTarget('sec-a-3');

      await service.assign(ctx, target.id, { roleCode: 'SELLER', scopeKind: 'LOCATION', locationIds: [branch.id] });
      await service.revoke(ctx, target.id, 'SELLER');

      const rows = await auditRows(target.id);
      expect(rows).toHaveLength(2);
      const revoked = rows.find((row) => row.action === 'USER_SCOPE_REVOKED');
      expect(revoked).toBeDefined();
      expect(revoked).toMatchObject({
        userId: owner.id,
        branchId: null,
        entityId: target.id,
      });
      expect(revoked!.before).toMatchObject({
        roleCode: 'SELLER',
        scopeKind: 'LOCATION',
        locationIds: [branch.id],
      });
      expect(revoked!.after).toBeNull();
    });

    it('F-01 policy 3: an idempotent revoke that removes zero rows writes no AuditLog', async () => {
      const branch = await createBranch(db);
      await ensureTestLocation(db, branch.id);
      const { ctx } = await ownerCaller('sec-a-owner-4@test.local');
      const target = await freshTarget('sec-a-4');

      await service.assign(ctx, target.id, { roleCode: 'SELLER', scopeKind: 'LOCATION', locationIds: [branch.id] });
      const result = await service.revoke(ctx, target.id, 'WAREHOUSE');

      expect(result).toMatchObject({ userId: target.id, roleCode: 'WAREHOUSE', revoked: true });
      const rows = await auditRows(target.id);
      expect(rows).toHaveLength(1); // the assign only — the zero-row revoke audited nothing
      expect(rows[0]!.action).toBe('USER_SCOPE_ASSIGNED');
    });

    it('F-02: a LOCATION assignment over an inactive Location is rejected with LOCATION_INACTIVE, with zero mutation and zero audit', async () => {
      const inactiveId = await createInactiveLocation();
      const { ctx } = await ownerCaller('sec-a-owner-5@test.local');
      const target = await freshTarget('sec-a-5');

      await expect(
        service.assign(ctx, target.id, { roleCode: 'SELLER', scopeKind: 'LOCATION', locationIds: [inactiveId] }),
      ).rejects.toThrow(/inactiv/i);

      expect(await db.userRoleScope.findMany({ where: { userId: target.id } })).toHaveLength(0);
      expect(await auditRows(target.id)).toHaveLength(0);
    });

    it('F-02: a mixed active+inactive locationIds assign is rejected atomically and the prior assignment survives', async () => {
      const activeBranch = await createBranch(db);
      await ensureTestLocation(db, activeBranch.id);
      const inactiveId = await createInactiveLocation();
      const { ctx } = await ownerCaller('sec-a-owner-6@test.local');
      const sellerRole = await findRole('SELLER');
      const target = await freshTarget('sec-a-6');

      await service.assign(ctx, target.id, { roleCode: 'SELLER', scopeKind: 'LOCATION', locationIds: [activeBranch.id] });
      await expect(
        service.assign(ctx, target.id, {
          roleCode: 'SELLER',
          scopeKind: 'LOCATION',
          locationIds: [activeBranch.id, inactiveId],
        }),
      ).rejects.toThrow(/inactiv/i);

      const sellerRows = await db.userRoleScope.findMany({ where: { userId: target.id, roleId: sellerRole.id } });
      expect(sellerRows).toHaveLength(1);
      expect(sellerRows[0]!.locationId).toBe(activeBranch.id);
      expect(await auditRows(target.id)).toHaveLength(1); // only the first assign audited
    });

    it('SEC-A keeps the FK semantics: a nonexistent Location still fails with no partial state and no audit row (atomic rollback)', async () => {
      const { ctx } = await ownerCaller('sec-a-owner-7@test.local');
      const target = await freshTarget('sec-a-7');

      await expect(
        service.assign(ctx, target.id, {
          roleCode: 'SELLER',
          scopeKind: 'LOCATION',
          locationIds: ['00000000-0000-4000-9999-000000000003'],
        }),
      ).rejects.toThrow();

      expect(await db.userRoleScope.findMany({ where: { userId: target.id } })).toHaveLength(0);
      expect(await auditRows(target.id)).toHaveLength(0);
    });

    it('F-01: COMPANY assign/revoke audits carry locationIds null and branchId null, never an arbitrary Location', async () => {
      const { ctx } = await ownerCaller('sec-a-owner-8@test.local');
      const target = await freshTarget('sec-a-8');

      await service.assign(ctx, target.id, { roleCode: 'ADMIN', scopeKind: 'COMPANY' });
      await service.revoke(ctx, target.id, 'ADMIN');

      const rows = await auditRows(target.id);
      expect(rows).toHaveLength(2);
      const assigned = rows.find((row) => row.action === 'USER_SCOPE_ASSIGNED');
      const revoked = rows.find((row) => row.action === 'USER_SCOPE_REVOKED');
      expect(assigned).toBeDefined();
      expect(assigned!.branchId).toBeNull();
      expect(assigned!.after).toMatchObject({ roleCode: 'ADMIN', scopeKind: 'COMPANY', locationIds: null });
      expect(revoked).toBeDefined();
      expect(revoked!.branchId).toBeNull();
      expect(revoked!.before).toMatchObject({ roleCode: 'ADMIN', scopeKind: 'COMPANY', locationIds: null });
      expect(revoked!.after).toBeNull();
    });

    it('HTTP F-02: POST with an inactive location returns 400 LOCATION_INACTIVE and writes nothing', async () => {
      const inactiveId = await createInactiveLocation();
      const admin = await createCompanyAdmin('sec-a-http-admin-1@test.local');
      const target = await freshTarget('sec-a-h1');

      const res = await request(app)
        .post(`/api/v1/backoffice/users/${target.id}/scope`)
        .set('Authorization', `Bearer ${await getAuthToken(admin)}`)
        .send({ roleCode: 'SELLER', scopeKind: 'LOCATION', locationIds: [inactiveId] });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatchObject({ code: 'LOCATION_INACTIVE' });
      expect(await db.userRoleScope.findMany({ where: { userId: target.id } })).toHaveLength(0);
      expect(await auditRows(target.id)).toHaveLength(0);
    });

    it('HTTP F-01: a successful POST audits the authenticated caller; a held-role DELETE audits the revoke; a repeated idempotent DELETE adds no further audit row', async () => {
      const branch = await createBranch(db);
      await ensureTestLocation(db, branch.id);
      const admin = await createCompanyAdmin('sec-a-http-admin-2@test.local');
      const target = await freshTarget('sec-a-h2');

      const assignRes = await request(app)
        .post(`/api/v1/backoffice/users/${target.id}/scope`)
        .set('Authorization', `Bearer ${await getAuthToken(admin)}`)
        .send({ roleCode: 'SELLER', scopeKind: 'LOCATION', locationIds: [branch.id] });
      expect(assignRes.status).toBeLessThan(300);

      const warehouseRes = await request(app)
        .post(`/api/v1/backoffice/users/${target.id}/scope`)
        .set('Authorization', `Bearer ${await getAuthToken(admin)}`)
        .send({ roleCode: 'WAREHOUSE', scopeKind: 'LOCATION', locationIds: [branch.id] });
      expect(warehouseRes.status).toBeLessThan(300);

      const firstDelete = await request(app)
        .delete(`/api/v1/backoffice/users/${target.id}/scope/WAREHOUSE`)
        .set('Authorization', `Bearer ${await getAuthToken(admin)}`);
      expect(firstDelete.status).toBeLessThan(300);

      const secondDelete = await request(app)
        .delete(`/api/v1/backoffice/users/${target.id}/scope/WAREHOUSE`)
        .set('Authorization', `Bearer ${await getAuthToken(admin)}`);
      expect(secondDelete.status).toBeLessThan(300);
      expect(secondDelete.body).toMatchObject({ revoked: true });

      const rows = await auditRows(target.id);
      expect(rows).toHaveLength(3); // SELLER assign + WAREHOUSE assign + the effective WAREHOUSE revoke; the idempotent DELETE audited nothing
      expect([...rows.map((row) => row.action)].sort()).toEqual([
        'USER_SCOPE_ASSIGNED',
        'USER_SCOPE_ASSIGNED',
        'USER_SCOPE_REVOKED',
      ]);
      expect(rows.every((row) => row.userId === admin.id)).toBe(true);
      expect(rows.every((row) => row.branchId === null)).toBe(true);
    });

    // ---------------------------------------------------------------------
    // SEC-A REVIEW-FIXES (MJ-ADMIN-ADM-02-SEC-A-REVIEW-FIXES-01, owner-
    // approved 2026-10-17). Approved policies H-04/H-05/H-06 + the Location
    // `FOR SHARE` serialization. Each case states its expected classification
    // (RED before the fix / GREEN-guard) as a comment BEFORE its assertions.
    // No pre-existing assertion above was modified or weakened.
    // ---------------------------------------------------------------------

    // A UUID that is structurally valid (v4 shape) but matches no Location
    // row: proves the FK path (P2003 -> 409) is untouched by the new guard.
    const MISSING_LOCATION_ID = '00000000-0000-4000-8000-0000000000ff';
    // A valid UUID matching no User: makes the AuditLog userId FK fail, which
    // rolls the whole mutation transaction back.
    const MISSING_ACTOR_ID = '00000000-0000-4000-8000-0000000000aa';

    it('REVIEW-FIX H-05 (was RED): a logically identical SELLER@A re-assign is a no-op — same physical row, no rewrite, no second AuditLog', async () => {
      const branch = await createBranch(db);
      await ensureTestLocation(db, branch.id);
      const { ctx } = await ownerCaller('sec-a-rf-owner-01@test.local');
      const sellerRole = await findRole('SELLER');
      const target = await freshTarget('sec-a-rf-01');

      await service.assign(ctx, target.id, { roleCode: 'SELLER', scopeKind: 'LOCATION', locationIds: [branch.id] });
      const firstRows = await db.userRoleScope.findMany({ where: { userId: target.id, roleId: sellerRole.id } });
      expect(firstRows).toHaveLength(1);

      const res = await service.assign(ctx, target.id, {
        roleCode: 'SELLER',
        scopeKind: 'LOCATION',
        locationIds: [branch.id],
      });

      expect(res).toEqual({ userId: target.id, roleCode: 'SELLER', scopeKind: 'LOCATION' });
      const after = await db.userRoleScope.findMany({ where: { userId: target.id, roleId: sellerRole.id } });
      expect(after).toHaveLength(1);
      // A rewrite (delete+create) would mint a new row id; identity proves none happened.
      expect(after[0]!.id).toBe(firstRows[0]!.id);
      expect(await auditRows(target.id)).toHaveLength(1); // the first assign only
    });

    it('REVIEW-FIX H-05 (was RED): SELLER@[A,B] then SELLER@[B,A] is logically identical — input order neither rewrites rows nor audits', async () => {
      const branchA = await createBranch(db);
      const branchB = await createBranch(db);
      await ensureTestLocation(db, branchA.id);
      await ensureTestLocation(db, branchB.id);
      const { ctx } = await ownerCaller('sec-a-rf-owner-02@test.local');
      const sellerRole = await findRole('SELLER');
      const target = await freshTarget('sec-a-rf-02');

      await service.assign(ctx, target.id, {
        roleCode: 'SELLER',
        scopeKind: 'LOCATION',
        locationIds: [branchA.id, branchB.id],
      });
      const firstIds = (await db.userRoleScope.findMany({ where: { userId: target.id, roleId: sellerRole.id } }))
        .map((row) => row.id)
        .sort();

      await service.assign(ctx, target.id, {
        roleCode: 'SELLER',
        scopeKind: 'LOCATION',
        locationIds: [branchB.id, branchA.id],
      });

      const afterIds = (await db.userRoleScope.findMany({ where: { userId: target.id, roleId: sellerRole.id } }))
        .map((row) => row.id)
        .sort();
      expect(afterIds).toEqual(firstIds);
      expect(await auditRows(target.id)).toHaveLength(1);
    });

    it('REVIEW-FIX H-05 (was RED): an identical COMPANY re-assign is a no-op with a single AuditLog', async () => {
      const { ctx } = await ownerCaller('sec-a-rf-owner-03@test.local');
      const adminRole = await findRole('ADMIN');
      const target = await freshTarget('sec-a-rf-03');

      await service.assign(ctx, target.id, { roleCode: 'ADMIN', scopeKind: 'COMPANY' });
      await service.assign(ctx, target.id, { roleCode: 'ADMIN', scopeKind: 'COMPANY' });

      expect(await db.userRoleScope.findMany({ where: { userId: target.id, roleId: adminRole.id } })).toHaveLength(1);
      expect(await auditRows(target.id)).toHaveLength(1);
    });

    it('REVIEW-FIX H-05 (GREEN-guard): A->B is NOT logically identical — it stays an effective, audited replacement', async () => {
      const branchA = await createBranch(db);
      const branchB = await createBranch(db);
      await ensureTestLocation(db, branchA.id);
      await ensureTestLocation(db, branchB.id);
      const { ctx } = await ownerCaller('sec-a-rf-owner-04@test.local');
      const sellerRole = await findRole('SELLER');
      const target = await freshTarget('sec-a-rf-04');

      await service.assign(ctx, target.id, { roleCode: 'SELLER', scopeKind: 'LOCATION', locationIds: [branchA.id] });
      await service.assign(ctx, target.id, { roleCode: 'SELLER', scopeKind: 'LOCATION', locationIds: [branchB.id] });

      const rows = await db.userRoleScope.findMany({ where: { userId: target.id, roleId: sellerRole.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.locationId).toBe(branchB.id);
      expect(await auditRows(target.id)).toHaveLength(2);
    });

    it('REVIEW-FIX H-05 (GREEN-guard): a duplicated-id request is NOT logically identical — it still fails on the unique index', async () => {
      const branch = await createBranch(db);
      await ensureTestLocation(db, branch.id);
      const { ctx } = await ownerCaller('sec-a-rf-owner-05@test.local');
      const sellerRole = await findRole('SELLER');
      const target = await freshTarget('sec-a-rf-05');

      await service.assign(ctx, target.id, { roleCode: 'SELLER', scopeKind: 'LOCATION', locationIds: [branch.id] });

      const err = await service
        .assign(ctx, target.id, { roleCode: 'SELLER', scopeKind: 'LOCATION', locationIds: [branch.id, branch.id] })
        .then(() => null, (error) => error as { code?: string });
      expect(err?.code).toBe('P2002'); // unique-index violation: the multiset differs from the prior single row

      const rows = await db.userRoleScope.findMany({ where: { userId: target.id, roleId: sellerRole.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.locationId).toBe(branch.id);
      expect(await auditRows(target.id)).toHaveLength(1);
    });

    it('REVIEW-FIX H-06 (was RED): an anomalous COMPANY+LOCATION state fails closed on assign with no mutation and no audit', async () => {
      const branch = await createBranch(db);
      await ensureTestLocation(db, branch.id);
      const { ctx } = await ownerCaller('sec-a-rf-owner-06@test.local');
      const sellerRole = await findRole('SELLER');
      const target = await freshTarget('sec-a-rf-06');
      // The DB permits this shape (per-kind unique indexes + a per-row CHECK).
      await db.userRoleScope.create({
        data: { userId: target.id, roleId: sellerRole.id, scopeKind: 'COMPANY', locationId: null },
      });
      await db.userRoleScope.create({
        data: { userId: target.id, roleId: sellerRole.id, scopeKind: 'LOCATION', locationId: branch.id },
      });
      const before = await db.userRoleScope.findMany({ where: { userId: target.id, roleId: sellerRole.id } });

      const err = await service
        .assign(ctx, target.id, { roleCode: 'SELLER', scopeKind: 'LOCATION', locationIds: [branch.id] })
        .then(() => null, (error) => error as { code?: string; status?: number });

      expect(err?.code).toBe('SCOPE_STATE_INCONSISTENT');
      expect(err?.status).toBe(409);
      const after = await db.userRoleScope.findMany({ where: { userId: target.id, roleId: sellerRole.id } });
      expect(after.map((row) => row.id).sort()).toEqual(before.map((row) => row.id).sort());
      expect(await auditRows(target.id)).toHaveLength(0);
    });

    it('REVIEW-FIX H-06 (was RED): the same anomalous state fails closed on revoke with no delete and no audit', async () => {
      const branch = await createBranch(db);
      await ensureTestLocation(db, branch.id);
      const { ctx } = await ownerCaller('sec-a-rf-owner-07@test.local');
      const sellerRole = await findRole('SELLER');
      const target = await freshTarget('sec-a-rf-07');
      await db.userRoleScope.create({
        data: { userId: target.id, roleId: sellerRole.id, scopeKind: 'COMPANY', locationId: null },
      });
      await db.userRoleScope.create({
        data: { userId: target.id, roleId: sellerRole.id, scopeKind: 'LOCATION', locationId: branch.id },
      });

      const err = await service
        .revoke(ctx, target.id, 'SELLER')
        .then(() => null, (error) => error as { code?: string; status?: number });

      expect(err?.code).toBe('SCOPE_STATE_INCONSISTENT');
      expect(err?.status).toBe(409);
      expect(await db.userRoleScope.findMany({ where: { userId: target.id, roleId: sellerRole.id } })).toHaveLength(2);
      expect(await auditRows(target.id)).toHaveLength(0);
    });

    it('REVIEW-FIX H-06: the anomalous state also surfaces through HTTP as 409 SCOPE_STATE_INCONSISTENT, leaving both rows intact', async () => {
      const branch = await createBranch(db);
      await ensureTestLocation(db, branch.id);
      const admin = await createCompanyAdmin('sec-a-rf-http-admin-06@test.local');
      const sellerRole = await findRole('SELLER');
      const target = await freshTarget('sec-a-rf-06h');
      await db.userRoleScope.create({
        data: { userId: target.id, roleId: sellerRole.id, scopeKind: 'COMPANY', locationId: null },
      });
      await db.userRoleScope.create({
        data: { userId: target.id, roleId: sellerRole.id, scopeKind: 'LOCATION', locationId: branch.id },
      });

      const res = await request(app)
        .post(`/api/v1/backoffice/users/${target.id}/scope`)
        .set('Authorization', `Bearer ${await getAuthToken(admin)}`)
        .send({ roleCode: 'SELLER', scopeKind: 'LOCATION', locationIds: [branch.id] });

      expect(res.status).toBe(409);
      expect(res.body.error).toMatchObject({ code: 'SCOPE_STATE_INCONSISTENT' });
      expect(await db.userRoleScope.findMany({ where: { userId: target.id, roleId: sellerRole.id } })).toHaveLength(2);
      expect(await auditRows(target.id)).toHaveLength(0);
    });

    it('REVIEW-FIX (was RED): a failing AuditLog rolls back the whole transaction — new assign, replacement and revoke all revert', async () => {
      const branchA = await createBranch(db);
      const branchB = await createBranch(db);
      await ensureTestLocation(db, branchA.id);
      await ensureTestLocation(db, branchB.id);
      const ownerRoleId = (await findRole('OWNER')).id;
      const brokenCtx = ownerCtx(MISSING_ACTOR_ID, ownerRoleId); // valid OWNER caller, no User row -> AuditLog FK P2003
      const sellerRole = await findRole('SELLER');
      const target = await freshTarget('sec-a-rf-08');

      // (1) NEW assign: the scope row is created, the audit fails, the whole tx rolls back.
      const newErr = await service
        .assign(brokenCtx, target.id, { roleCode: 'SELLER', scopeKind: 'LOCATION', locationIds: [branchA.id] })
        .then(() => null, (error) => error as { code?: string });
      expect(newErr?.code).toBe('P2003');
      expect(await db.userRoleScope.findMany({ where: { userId: target.id, roleId: sellerRole.id } })).toHaveLength(0);
      expect(await auditRows(target.id)).toHaveLength(0);

      // Establish a real assignment, then a failing REPLACEMENT must leave it intact.
      const { ctx } = await ownerCaller('sec-a-rf-owner-08@test.local');
      await service.assign(ctx, target.id, { roleCode: 'SELLER', scopeKind: 'LOCATION', locationIds: [branchA.id] });
      const replaceErr = await service
        .assign(brokenCtx, target.id, { roleCode: 'SELLER', scopeKind: 'LOCATION', locationIds: [branchB.id] })
        .then(() => null, (error) => error as { code?: string });
      expect(replaceErr?.code).toBe('P2003');
      const afterReplace = await db.userRoleScope.findMany({ where: { userId: target.id, roleId: sellerRole.id } });
      expect(afterReplace).toHaveLength(1);
      expect(afterReplace[0]!.locationId).toBe(branchA.id); // the delete+recreate reverted
      expect(await auditRows(target.id)).toHaveLength(1); // only the successful assign

      // (3) REVOKE: the delete lands, the audit fails, the delete rolls back.
      const revokeErr = await service
        .revoke(brokenCtx, target.id, 'SELLER')
        .then(() => null, (error) => error as { code?: string });
      expect(revokeErr?.code).toBe('P2003');
      const afterRevoke = await db.userRoleScope.findMany({ where: { userId: target.id, roleId: sellerRole.id } });
      expect(afterRevoke).toHaveLength(1);
      expect(afterRevoke[0]!.locationId).toBe(branchA.id);
      expect(await auditRows(target.id)).toHaveLength(1);
    });

    it('REVIEW-FIX (GREEN-guard): a nonexistent Location fails precisely — service P2003, HTTP 409 DATABASE_CONFLICT, no partial state', async () => {
      const { ctx } = await ownerCaller('sec-a-rf-owner-09@test.local');
      const target = await freshTarget('sec-a-rf-09');

      const err = await service
        .assign(ctx, target.id, { roleCode: 'SELLER', scopeKind: 'LOCATION', locationIds: [MISSING_LOCATION_ID] })
        .then(() => null, (error) => error as { code?: string });
      expect(err?.code).toBe('P2003');
      expect(await db.userRoleScope.findMany({ where: { userId: target.id } })).toHaveLength(0);
      expect(await auditRows(target.id)).toHaveLength(0);

      const admin = await createCompanyAdmin('sec-a-rf-http-admin-09@test.local');
      const httpTarget = await freshTarget('sec-a-rf-09h');
      const res = await request(app)
        .post(`/api/v1/backoffice/users/${httpTarget.id}/scope`)
        .set('Authorization', `Bearer ${await getAuthToken(admin)}`)
        .send({ roleCode: 'SELLER', scopeKind: 'LOCATION', locationIds: [MISSING_LOCATION_ID] });

      expect(res.status).toBe(409);
      expect(res.body.error).toMatchObject({ code: 'DATABASE_CONFLICT' });
      expect(await db.userRoleScope.findMany({ where: { userId: httpTarget.id } })).toHaveLength(0);
    });

    it('REVIEW-FIX (GREEN-guard): assign/revoke snapshots are exactly the scope shape, carrying no sensitive fields', async () => {
      const branch = await createBranch(db);
      await ensureTestLocation(db, branch.id);
      const { ctx } = await ownerCaller('sec-a-rf-owner-10@test.local');
      const target = await freshTarget('sec-a-rf-10');

      await service.assign(ctx, target.id, { roleCode: 'SELLER', scopeKind: 'LOCATION', locationIds: [branch.id] });
      await service.revoke(ctx, target.id, 'SELLER');

      const rows = await auditRows(target.id);
      expect(rows).toHaveLength(2);
      const assigned = rows.find((row) => row.action === 'USER_SCOPE_ASSIGNED')!;
      const revoked = rows.find((row) => row.action === 'USER_SCOPE_REVOKED')!;
      expect(assigned.before).toBeNull();
      expect(assigned.after).toEqual({ roleCode: 'SELLER', scopeKind: 'LOCATION', locationIds: [branch.id] });
      expect(revoked.before).toEqual({ roleCode: 'SELLER', scopeKind: 'LOCATION', locationIds: [branch.id] });
      expect(revoked.after).toBeNull();

      const serialized = JSON.stringify(rows);
      for (const sensitive of ['passwordHash', 'password', 'token', 'secret']) {
        expect(serialized).not.toContain(sensitive);
      }
    });

    it('REVIEW-FIX (GREEN-guard): revoking a held role twice removes rows once and audits once', async () => {
      const branch = await createBranch(db);
      await ensureTestLocation(db, branch.id);
      const { ctx } = await ownerCaller('sec-a-rf-owner-11@test.local');
      const sellerRole = await findRole('SELLER');
      const target = await freshTarget('sec-a-rf-11');

      await service.assign(ctx, target.id, { roleCode: 'SELLER', scopeKind: 'LOCATION', locationIds: [branch.id] });
      const first = await service.revoke(ctx, target.id, 'SELLER');
      const second = await service.revoke(ctx, target.id, 'SELLER');

      expect(first).toEqual({ userId: target.id, roleCode: 'SELLER', revoked: true });
      expect(second).toEqual({ userId: target.id, roleCode: 'SELLER', revoked: true });
      expect(await db.userRoleScope.findMany({ where: { userId: target.id, roleId: sellerRole.id } })).toHaveLength(0);
      expect(await auditRows(target.id)).toHaveLength(2); // assign + the one EFFECTIVE revoke
    });

    it('REVIEW-FIX H-04 (was RED): an assignment on a Location deactivated afterwards is preserved; a NEW assignment to it is refused; cleanup revoke still works', async () => {
      const branchA = await createBranch(db);
      const branchB = await createBranch(db);
      await ensureTestLocation(db, branchA.id);
      await ensureTestLocation(db, branchB.id);
      const { ctx } = await ownerCaller('sec-a-rf-owner-12@test.local');
      const sellerRole = await findRole('SELLER');
      const cashierRole = await findRole('CASHIER');
      const target = await freshTarget('sec-a-rf-12');

      await service.assign(ctx, target.id, { roleCode: 'SELLER', scopeKind: 'LOCATION', locationIds: [branchA.id] });
      const historicalBefore = await db.userRoleScope.findMany({ where: { userId: target.id, roleId: sellerRole.id } });
      await db.location.update({ where: { id: branchA.id }, data: { isActive: false } }); // deactivated AFTER the fact

      // An unrelated assignment must not disturb the historical one.
      await service.assign(ctx, target.id, { roleCode: 'WAREHOUSE', scopeKind: 'LOCATION', locationIds: [branchB.id] });
      const historicalAfter = await db.userRoleScope.findMany({ where: { userId: target.id, roleId: sellerRole.id } });
      expect(historicalAfter.map((row) => row.id)).toEqual(historicalBefore.map((row) => row.id));
      expect(historicalAfter[0]!.locationId).toBe(branchA.id);

      // A NEW assignment targeting the now-inactive Location is refused.
      const err = await service
        .assign(ctx, target.id, { roleCode: 'CASHIER', scopeKind: 'LOCATION', locationIds: [branchA.id] })
        .then(() => null, (error) => error as { code?: string });
      expect(err?.code).toBe('LOCATION_INACTIVE');
      expect(await db.userRoleScope.findMany({ where: { userId: target.id, roleId: cashierRole.id } })).toHaveLength(0);
      expect(await db.userRoleScope.findMany({ where: { userId: target.id, roleId: sellerRole.id } })).toHaveLength(1);

      // Cleanup of the historical assignment remains available.
      await service.revoke(ctx, target.id, 'SELLER');
      expect(await db.userRoleScope.findMany({ where: { userId: target.id, roleId: sellerRole.id } })).toHaveLength(0);
    });

    it('REVIEW-FIX (GREEN-guard): the HTTP response contracts are unchanged — exact assign and revoke bodies', async () => {
      const branch = await createBranch(db);
      await ensureTestLocation(db, branch.id);
      const admin = await createCompanyAdmin('sec-a-rf-http-admin-13@test.local');
      const target = await freshTarget('sec-a-rf-13');

      const assigned = await request(app)
        .post(`/api/v1/backoffice/users/${target.id}/scope`)
        .set('Authorization', `Bearer ${await getAuthToken(admin)}`)
        .send({ roleCode: 'SELLER', scopeKind: 'LOCATION', locationIds: [branch.id] });
      expect(assigned.status).toBe(200);
      expect(assigned.body).toEqual({ userId: target.id, roleCode: 'SELLER', scopeKind: 'LOCATION' });

      const revoked = await request(app)
        .delete(`/api/v1/backoffice/users/${target.id}/scope/SELLER`)
        .set('Authorization', `Bearer ${await getAuthToken(admin)}`);
      expect(revoked.status).toBe(200);
      expect(revoked.body).toEqual({ userId: target.id, roleCode: 'SELLER', revoked: true });
    });
  });
});

// ---------------------------------------------------------------------------
// SEC-A deadlock-fix (MJ-ADMIN-ADM-02-SEC-A-DEADLOCK-FIX-01, owner-approved
// 2026-10-17; approved alternative "C1": the target lock changes from
// `FOR UPDATE` to `FOR NO KEY UPDATE`).
//
// The mutual-administration deadlock (A modifies B while B modifies A) can only
// be reproduced with TWO independent PostgreSQL connections driving two
// concurrent transactions. This single-connection Prisma harness cannot express
// it, so no deadlock reproduction is asserted here and none is claimed to pass;
// the adversarial matrix to be executed against LOCAL_TEST later (with expected
// classifications recorded before execution) is:
//
//   #   scenario                                       expected
//   1   A modifies B while B modifies A (LOCATION)     pre-fix 40P01; post-fix both commit
//   2   A modifies B while B modifies A (COMPANY)      pre-fix 40P01; post-fix both commit
//   3   assign(A->B) concurrent with revoke(B->A)      pre-fix 40P01; post-fix both commit
//   4   A->B concurrent with C->B (one shared target)  both commit, serialized on User(B)
//   5   A->B concurrent with C->D (independent)        both commit, never serialized
//   6   A->B(LOCATION) concurrent with deactivate L    both commit, serialized (FOR SHARE vs UPDATE)
//   7   three-administrator cycle A->B->C->A           pre-fix 40P01; post-fix all commit
//   8   two operations on the SAME target              both commit, serialized
//   9   AuditLog FK records the correct actor          unchanged: actor = authenticated caller
//   10  AuditLog writer error                          full rollback (covered above)
//   11  Location locks still block deactivation        unchanged (FOR SHARE)
//   12  self-assignment prohibition                    unchanged (403 before any lock)
//
// Scenarios 9-12 are already covered by the REVIEW-FIX cases above. What can be
// asserted here WITHOUT opening a connection is the lock MODE itself, which is
// the entire content of the C1 fix; the guard below is DB-free (no client is
// created in this describe) and protects the choice against regression.
describe('scope-assignment.service target lock mode (SEC-A deadlock-fix C1)', () => {
  it('locks the target User row with FOR NO KEY UPDATE (not FOR UPDATE), keeps Location FOR SHARE, and takes User before Location', () => {
    const source = readFileSync(
      new URL('../../src/modules/backoffice/scope-assignment.service.ts', import.meta.url),
      'utf8',
    );

    // The C1 change: exactly the target-lock statement uses FOR NO KEY UPDATE.
    expect(source).toContain('"User" WHERE id = ${targetUserId} FOR NO KEY UPDATE');
    // The deadlock-prone mode must not be reintroduced on the target row.
    expect(source).not.toContain('"User" WHERE id = ${targetUserId} FOR UPDATE');
    // The Location guard stays on FOR SHARE, ordered for deterministic locking.
    expect(source).toContain('FROM "Location" WHERE id IN (${Prisma.join(ids)}) ORDER BY id FOR SHARE');

    // Acquisition-order invariant: the User lock statement must precede the
    // Location lock statement in the source (User -> Location -> writes).
    const userLock = source.indexOf('"User" WHERE id = ${targetUserId} FOR NO KEY UPDATE');
    const locationLock = source.indexOf('FROM "Location" WHERE id IN');
    expect(userLock).toBeGreaterThan(-1);
    expect(locationLock).toBeGreaterThan(-1);
    expect(userLock).toBeLessThan(locationLock);
  });
});
