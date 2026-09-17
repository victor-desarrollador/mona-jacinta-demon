import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestPrismaClient, truncateAllTables } from '../helpers/test-db.js';
import { createBranch, createTestUser, ensureTestLocation } from '../helpers/factories.js';
import { getAuthToken } from '../helpers/auth.js';
import { bootstrapProductionRbacCatalog } from '../../src/modules/rbac/catalog.service.js';
import { buildAuthorizationContext } from '../../src/modules/rbac/authorization-context.js';
import { hasPermission } from '../../src/modules/rbac/authorization-policy.js';
import { PRODUCTION_PERMISSIONS } from '../../src/modules/rbac/permissions.js';
import { createApp } from '../../src/app.js';
import type { PrismaClient } from '../../src/generated/prisma/client.js';

// Phase 1D.4.5 (docs/superpowers/plans/2026-09-14-phase-1d-production-
// authorization.md): the canonical Phase 1D privilege-escalation checklist.
// Composes ALREADY-APPROVED behavior from Tasks 1D.2.3-1D.2.4, 1D.3.6, and
// 1D.4.3-1D.4.4 — this is a regression-consolidation suite, not new
// implementation. Expected GREEN on first run if those tasks are correctly
// merged; a genuine failure here means an earlier task regressed, not that
// this suite needs a runtime fix.
describe('Privilege escalation (Phase 1D.4/1E checklist)', () => {
  let db: PrismaClient;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    db = await createTestPrismaClient();
    app = createApp(db);
  }, 120000);

  beforeEach(async () => {
    await truncateAllTables(db);
    await bootstrapProductionRbacCatalog(db);
  }, 120000);

  afterAll(async () => db.$disconnect());

  async function findRole(code: 'OWNER' | 'ADMIN' | 'CASHIER' | 'SELLER' | 'WAREHOUSE') {
    return db.role.findUniqueOrThrow({ where: { code } });
  }

  async function createOwnerUser(email: string) {
    const ownerRole = await findRole('OWNER');
    const owner = await db.user.create({ data: { name: 'owner', email, passwordHash: 'x' } });
    await db.userRoleScope.create({
      data: { userId: owner.id, roleId: ownerRole.id, scopeKind: 'COMPANY', locationId: null },
    });
    return { owner, ownerRole };
  }

  // Real DB-backed authorization context, built the exact way
  // src/middleware/auth.ts does (same select shape), not a fabricated
  // object — proves the actual policy/context composition, not a stand-in.
  async function loadContext(userId: string) {
    const user = await db.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        id: true,
        branchRoles: { select: { role: { select: { code: true } } } },
        roleScopes: {
          select: {
            roleId: true,
            scopeKind: true,
            locationId: true,
            role: { select: { code: true, permissions: { select: { permission: { select: { code: true } } } } } },
          },
        },
      },
    });
    return buildAuthorizationContext(db, user);
  }

  // --- Case A: ADMIN cannot grant OWNER (end-to-end HTTP, approved route + service composition) ---
  it('Case A: ADMIN cannot grant OWNER through the HTTP scope-assignment route', async () => {
    const branch = await createBranch(db);
    await ensureTestLocation(db, branch.id);
    const admin = await createTestUser(db, (await findRole('ADMIN')).id, branch.id);
    const sellerRole = await findRole('SELLER');
    const target = await createTestUser(db, sellerRole.id, branch.id);

    const res = await request(app)
      .post(`/api/v1/backoffice/users/${target.id}/scope`)
      .set('Authorization', `Bearer ${await getAuthToken(admin)}`)
      .send({ roleCode: 'OWNER', scopeKind: 'COMPANY' });

    expect(res.status).toBe(403);

    const ownerRole = await findRole('OWNER');
    expect(await db.userRoleScope.count({ where: { userId: target.id, roleId: ownerRole.id } })).toBe(0);
    const sellerRows = await db.userRoleScope.findMany({ where: { userId: target.id, roleId: sellerRole.id } });
    expect(sellerRows).toHaveLength(1);
    expect(sellerRows[0]!.locationId).toBe(branch.id);
  });

  // --- Case B: low-privilege roles cannot reach scope mutation (USER_MANAGE gate) ---
  it.each(['CASHIER', 'SELLER', 'WAREHOUSE'] as const)(
    'Case B: %s (real Production assignment, no USER_MANAGE) gets 403 on POST scope, no mutation',
    async (roleCode) => {
      const branch = await createBranch(db);
      await ensureTestLocation(db, branch.id);
      const caller = await createTestUser(db, (await findRole(roleCode)).id, branch.id);
      const sellerRole = await findRole('SELLER');
      const target = await createTestUser(db, sellerRole.id, branch.id);
      const before = await db.userRoleScope.findMany({ where: { userId: target.id } });

      const res = await request(app)
        .post(`/api/v1/backoffice/users/${target.id}/scope`)
        .set('Authorization', `Bearer ${await getAuthToken(caller)}`)
        .send({ roleCode: 'SELLER', scopeKind: 'LOCATION', locationIds: [branch.id] });

      expect(res.status).toBe(403);
      const after = await db.userRoleScope.findMany({ where: { userId: target.id } });
      expect(after).toEqual(before);
    },
  );

  // --- Case C: empty Production scope fails closed despite stale UserBranchRole ---
  it('Case C: revoking UserRoleScope fails Production authority closed even though the legacy UserBranchRole row remains', async () => {
    const branch = await createBranch(db);
    await ensureTestLocation(db, branch.id);
    const sellerRole = await findRole('SELLER');
    const user = await createTestUser(db, sellerRole.id, branch.id);
    // Production scope revoked; the legacy UserBranchRole is deliberately
    // left in place — it must never restore authority (AGENTS.md's Phase 1C
    // checkpoint: UserRoleScope is sole Production authority, no fallback).
    await db.userRoleScope.deleteMany({ where: { userId: user.id } });
    expect(await db.userBranchRole.count({ where: { userId: user.id } })).toBe(1);

    const res = await request(app)
      .get(`/api/v1/inventory?branchId=${branch.id}`)
      .set('Authorization', `Bearer ${await getAuthToken(user)}`);

    expect(res.status).toBe(403);
    expect(await db.userBranchRole.count({ where: { userId: user.id } })).toBe(1);
  });

  // --- Case D: a stale UserBranchRole cannot grant uppercase Production authority, even when its Role genuinely carries a Production Permission row ---
  it('Case D: a legacy UserBranchRole whose Role carries both sale.view AND SALE_VIEW grants zero authority once UserRoleScope is gone', async () => {
    const branch = await createBranch(db);
    await ensureTestLocation(db, branch.id);
    const legacySaleView = await db.permission.create({ data: { code: 'sale.view' } });
    const productionSaleView = await db.permission.findUniqueOrThrow({ where: { code: 'SALE_VIEW' } });
    const mixedRole = await db.role.create({ data: { code: 'MIXED-STALE', name: 'MIXED-STALE' } });
    await db.rolePermission.createMany({
      data: [
        { roleId: mixedRole.id, permissionId: legacySaleView.id },
        { roleId: mixedRole.id, permissionId: productionSaleView.id },
      ],
    });
    const user = await createTestUser(db, mixedRole.id, branch.id);
    await db.userRoleScope.deleteMany({ where: { userId: user.id } });

    const res = await request(app)
      .get('/api/v1/sales')
      .set('Authorization', `Bearer ${await getAuthToken(user)}`);

    expect(res.status).toBe(403);
    const legacyRows = await db.userBranchRole.findMany({ where: { userId: user.id }, include: { role: true } });
    expect(legacyRows).toHaveLength(1);
    expect(legacyRows[0]!.role.code).toBe('MIXED-STALE');
  });

  // --- Case E: two Production assignments cannot cross-compose permission + location ---
  it('Case E: SELLER @ A + WAREHOUSE @ B cannot combine into SALE_CREATE @ B (same-assignment composition only)', async () => {
    const branchA = await createBranch(db);
    const branchB = await createBranch(db);
    await ensureTestLocation(db, branchA.id);
    await ensureTestLocation(db, branchB.id);
    const sellerRole = await findRole('SELLER');
    const warehouseRole = await findRole('WAREHOUSE');
    const user = await db.user.create({ data: { name: 'cross-compose', email: 'cross-compose@test.local', passwordHash: 'x' } });
    await db.userRoleScope.create({ data: { userId: user.id, roleId: sellerRole.id, scopeKind: 'LOCATION', locationId: branchA.id } });
    await db.userRoleScope.create({ data: { userId: user.id, roleId: warehouseRole.id, scopeKind: 'LOCATION', locationId: branchB.id } });

    // Current createDraftSaleDto is `{ branchId: z.uuid().optional() }.strict()`
    // — no `items` field exists on this DTO (the plan's stale sample body
    // included one, which would 400 before authorization ever runs; omitted
    // here to keep the failure reason authorization, not validation).
    const res = await request(app)
      .post('/api/v1/sales')
      .set('Authorization', `Bearer ${await getAuthToken(user)}`)
      .send({ branchId: branchB.id });

    expect(res.status).toBe(403);
    expect(await db.sale.count({ where: { branchId: branchB.id } })).toBe(0);
  });

  // --- Case F: COMPANY-required permission fails closed for a LOCATION assignment, succeeds for COMPANY ---
  it('Case F: PRODUCT_MANAGE requires a COMPANY-scoped assignment — a LOCATION ADMIN fails, a COMPANY ADMIN succeeds', async () => {
    const branch = await createBranch(db);
    await ensureTestLocation(db, branch.id);
    const adminRole = await findRole('ADMIN');
    const locationAdmin = await createTestUser(db, adminRole.id, branch.id);
    const locationCtx = await loadContext(locationAdmin.id);
    expect(hasPermission(locationCtx, PRODUCTION_PERMISSIONS.PRODUCT_MANAGE)).toBe(false);

    const companyAdmin = await db.user.create({ data: { name: 'company-admin', email: 'company-admin@test.local', passwordHash: 'x' } });
    await db.userRoleScope.create({ data: { userId: companyAdmin.id, roleId: adminRole.id, scopeKind: 'COMPANY', locationId: null } });
    const companyCtx = await loadContext(companyAdmin.id);
    expect(hasPermission(companyCtx, PRODUCTION_PERMISSIONS.PRODUCT_MANAGE)).toBe(true);
  });

  // --- Case G: OWNER centralized implicit authority (zero explicit RolePermission grants) ---
  it('Case G: OWNER passes USER_MANAGE through centralized implicit authority, not RolePermission rows', async () => {
    const { owner, ownerRole } = await createOwnerUser('owner-implicit@test.local');
    expect(await db.rolePermission.count({ where: { roleId: ownerRole.id } })).toBe(0);

    const branch = await createBranch(db);
    await ensureTestLocation(db, branch.id);
    const target = await createTestUser(db, (await findRole('SELLER')).id, branch.id);

    const res = await request(app)
      .post(`/api/v1/backoffice/users/${target.id}/scope`)
      .set('Authorization', `Bearer ${await getAuthToken(owner)}`)
      .send({ roleCode: 'ADMIN', scopeKind: 'COMPANY' });

    expect(res.status).toBeLessThan(300);
    const adminRole = await findRole('ADMIN');
    const rows = await db.userRoleScope.findMany({ where: { userId: target.id, roleId: adminRole.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ scopeKind: 'COMPANY', locationId: null });
  });

  // --- Case H: ADMIN cannot manage an OWNER target in any way ---
  it('Case H: ADMIN cannot assign a new role to, nor revoke any assignment from, a target that currently holds OWNER', async () => {
    const branch = await createBranch(db);
    await ensureTestLocation(db, branch.id);
    const admin = await createTestUser(db, (await findRole('ADMIN')).id, branch.id);
    const { owner: target, ownerRole } = await createOwnerUser('owner-target-h@test.local');
    const warehouseRole = await findRole('WAREHOUSE');
    await db.userRoleScope.create({ data: { userId: target.id, roleId: warehouseRole.id, scopeKind: 'LOCATION', locationId: branch.id } });

    const assignRes = await request(app)
      .post(`/api/v1/backoffice/users/${target.id}/scope`)
      .set('Authorization', `Bearer ${await getAuthToken(admin)}`)
      .send({ roleCode: 'SELLER', scopeKind: 'LOCATION', locationIds: [branch.id] });
    expect(assignRes.status).toBe(403);

    const revokeRes = await request(app)
      .delete(`/api/v1/backoffice/users/${target.id}/scope/WAREHOUSE`)
      .set('Authorization', `Bearer ${await getAuthToken(admin)}`);
    expect(revokeRes.status).toBe(403);

    const ownerRows = await db.userRoleScope.findMany({ where: { userId: target.id, roleId: ownerRole.id } });
    expect(ownerRows).toHaveLength(1);
    expect(ownerRows[0]).toMatchObject({ scopeKind: 'COMPANY', locationId: null });
    const warehouseRows = await db.userRoleScope.findMany({ where: { userId: target.id, roleId: warehouseRole.id } });
    expect(warehouseRows).toHaveLength(1);
    expect(warehouseRows[0]!.locationId).toBe(branch.id);
    const sellerRole = await findRole('SELLER');
    expect(await db.userRoleScope.count({ where: { userId: target.id, roleId: sellerRole.id } })).toBe(0);
  });
});
