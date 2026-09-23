import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedDemo } from '../prisma/seed.js';
import { createRequireAuth } from '../src/middleware/auth.js';
import {
  assertBranchAccess,
  getUserBranchScope,
  requirePermission,
} from '../src/middleware/authorization.js';
import { createTestPrismaClient, truncateAllTables } from './helpers/test-db.js';
import { getAuthToken } from './helpers/auth.js';
import { PRODUCTION_PERMISSIONS } from '../src/modules/rbac/permissions.js';
import { errorHandler } from '../src/middleware/errorHandler.js';

describe('permission and branch authorization', () => {
  let prisma: Awaited<ReturnType<typeof createTestPrismaClient>>;
  let app: express.Express;
  let branchIds: Record<string, string>;

  beforeAll(async () => {
    prisma = await createTestPrismaClient();
  });

  beforeEach(async () => {
    await truncateAllTables(prisma);
    await seedDemo(prisma);
    const branches = await prisma.branch.findMany({ select: { code: true, id: true } });
    branchIds = Object.fromEntries(branches.map((branch) => [branch.code, branch.id]));

    app = express();
    app.use(express.json());
    const auth = createRequireAuth(prisma);
    app.get(
      '/permission',
      auth,
      requirePermission(PRODUCTION_PERMISSIONS.SALE_QUEUE_VIEW),
      (_req, res) => res.json({ ok: true }),
    );
    app.get(
      '/resource/:id',
      auth,
      requirePermission(PRODUCTION_PERMISSIONS.SALE_VIEW, {
        branchScope: 'own',
        resolveResourceBranch: async (req) =>
          (await prisma.branch.findUnique({
            where: { id: String(req.params.id) },
            select: { id: true },
          }))?.id,
      }),
      (_req, res) => res.json({ ok: true }),
    );
    app.get('/filter', auth, (req, res, next) => {
      try {
        assertBranchAccess(req, String(req.query.branchId ?? ''));
        res.json({ ok: true });
      } catch (error) {
        next(error);
      }
    });
    app.use(errorHandler);
  });

  afterAll(async () => prisma.$disconnect());

  async function tokenFor(name: string) {
    const user = await prisma.user.findUniqueOrThrow({
      where: { email: `${name}@demo.local` },
      select: { id: true },
    });
    return getAuthToken(user);
  }

  it('returns 401 for an unauthenticated private request', async () => {
    expect((await request(app).get('/permission')).status).toBe(401);
  });

  it('enforces the seeded queue permission by current authorization snapshot', async () => {
    const seller = await request(app)
      .get('/permission')
      .set('Authorization', `Bearer ${await tokenFor('seller01')}`);
    const cashier = await request(app)
      .get('/permission')
      .set('Authorization', `Bearer ${await tokenFor('cashier01')}`);
    const warehouse = await request(app)
      .get('/permission')
      .set('Authorization', `Bearer ${await tokenFor('warehouse01')}`);
    const admin = await request(app)
      .get('/permission')
      .set('Authorization', `Bearer ${await tokenFor('admin')}`);
    expect(seller.status).toBe(403);
    expect(cashier.status).toBe(200);
    // Phase 1D.3.6 SWITCH: this route now gates on Production
    // SALE_QUEUE_VIEW exclusively. Canonical WAREHOUSE does not carry
    // SALE_QUEUE_VIEW by default (role-permission-matrix.ts) — WAREHOUSE
    // must fail closed here.
    expect(warehouse.status).toBe(403);
    expect(admin.status).toBe(200);
  });

  it('does not allow an ADMIN role to bypass a revoked Production permission', async () => {
    const permission = await prisma.permission.findUniqueOrThrow({
      where: { code: PRODUCTION_PERMISSIONS.SALE_QUEUE_VIEW },
      select: { id: true },
    });
    const adminRole = await prisma.role.findUniqueOrThrow({
      where: { code: 'ADMIN' },
      select: { id: true },
    });
    await prisma.rolePermission.delete({
      where: { roleId_permissionId: { roleId: adminRole.id, permissionId: permission.id } },
    });
    expect(
      (
        await request(app)
          .get('/permission')
          .set('Authorization', `Bearer ${await tokenFor('admin')}`)
      ).status,
    ).toBe(403);
  });

  it('enforces own resource scope from the persisted resource branch', async () => {
    const token = await tokenFor('seller01');
    const allowed = await request(app)
      .get(`/resource/${branchIds.CEN}`)
      .set('Authorization', `Bearer ${token}`)
      .query({ branchId: branchIds.YB });
    const denied = await request(app)
      .get(`/resource/${branchIds.YB}`)
      .set('Authorization', `Bearer ${token}`)
      .query({ branchId: branchIds.CEN });
    expect(allowed.status).toBe(200);
    expect(denied.status).toBe(403);
  });

  it('validates explicit branch filters against current assignments', async () => {
    const token = await tokenFor('seller01');
    const allowed = await request(app)
      .get('/filter')
      .set('Authorization', `Bearer ${token}`)
      .query({ branchId: branchIds.CEN });
    const denied = await request(app)
      .get('/filter')
      .set('Authorization', `Bearer ${token}`)
      .query({ branchId: branchIds.YB });
    expect(allowed.status).toBe(200);
    expect(denied.status).toBe(403);
  });

  it('reflects role and branch changes on the next request without a new token', async () => {
    const token = await tokenFor('seller01');
    const seller = await prisma.user.findUniqueOrThrow({
      where: { email: 'seller01@demo.local' },
      select: { id: true },
    });
    const cashierRole = await prisma.role.findUniqueOrThrow({
      where: { code: 'CASHIER' },
      select: { id: true },
    });
    // Phase 1D.3.6 SWITCH: /permission and /resource now gate exclusively on
    // Production assignments (UserRoleScope) — UserBranchRole has zero
    // bearing on either route's outcome. Moving the user's UserRoleScope
    // role+location directly is what changes both the permission (CASHIER
    // carries SALE_QUEUE_VIEW; SELLER does not) and the location (YB) in one
    // step.
    await prisma.userRoleScope.deleteMany({ where: { userId: seller.id } });
    await prisma.userRoleScope.create({
      data: {
        userId: seller.id,
        roleId: cashierRole.id,
        scopeKind: 'LOCATION',
        locationId: branchIds.YB!,
      },
    });
    const response = await request(app)
      .get('/permission')
      .set('Authorization', `Bearer ${token}`);
    expect(response.status).toBe(200);
    expect(
      (
        await request(app)
          .get(`/resource/${branchIds.CEN}`)
          .set('Authorization', `Bearer ${token}`)
      ).status,
    ).toBe(403);
    expect(getUserBranchScope).toBeTypeOf('function');
  });

  it('denies access to a legacy branch once UserRoleScope is deliberately emptied, instead of resurrecting it from UserBranchRole (Phase 1C SWITCH)', async () => {
    const token = await tokenFor('seller01');
    const seller = await prisma.user.findUniqueOrThrow({
      where: { email: 'seller01@demo.local' },
      select: { id: true },
    });
    // D2.2: normal canonical seed no longer creates UserBranchRole rows —
    // this test's own stale legacy fixture (Centro) is created explicitly
    // here. Revoke every scope row while leaving that legacy UserBranchRole
    // assignment untouched. An empty UserRoleScope must mean zero authorized
    // branches for this user, not "not yet migrated": it must never fall
    // back to the still-present legacy assignment.
    const sellerRole = await prisma.role.findUniqueOrThrow({ where: { code: 'SELLER' } });
    await prisma.userBranchRole.create({
      data: { userId: seller.id, branchId: branchIds.CEN!, roleId: sellerRole.id },
    });
    await prisma.userRoleScope.deleteMany({ where: { userId: seller.id } });
    expect(await prisma.userBranchRole.count({ where: { userId: seller.id } })).toBeGreaterThan(0);

    const resource = await request(app)
      .get(`/resource/${branchIds.CEN}`)
      .set('Authorization', `Bearer ${token}`);
    expect(resource.status).toBe(403);
    const filter = await request(app)
      .get('/filter')
      .set('Authorization', `Bearer ${token}`)
      .query({ branchId: branchIds.CEN });
    expect(filter.status).toBe(403);
  });
});