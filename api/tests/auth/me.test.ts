import { SignJWT } from 'jose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedDemo } from '../../prisma/seed.js';
import { createApp } from '../../src/app.js';
import { env } from '../../src/config/env.js';
import { createTestPrismaClient, truncateAllTables } from '../helpers/test-db.js';
import { createTestUser, getAuthToken } from '../helpers/auth.js';

describe('GET /api/v1/auth/me', () => {
  let prisma: Awaited<ReturnType<typeof createTestPrismaClient>>;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    prisma = await createTestPrismaClient();
    app = createApp(prisma);
  });
  beforeEach(async () => {
    await truncateAllTables(prisma);
    await seedDemo(prisma);
  });
  afterAll(async () => prisma.$disconnect());

  async function sellerToken() {
    const seller = await prisma.user.findUniqueOrThrow({
      where: { email: 'seller01@demo.local' },
      select: { id: true },
    });
    return getAuthToken(seller);
  }

  it('returns current user context for a valid token', async () => {
    const response = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${await sellerToken()}`);
    expect(response.status).toBe(200);
    expect(response.body.user).toMatchObject({
      name: 'seller01',
      email: 'seller01@demo.local',
      roles: ['SELLER'],
    });
    // Compatibility contract (Phase 1D.1): internal AuthContext shapes must
    // never leak through the public /me response.
    expect(response.body.user.assignments).toBeUndefined();
    expect(response.body.user.legacyPermissions).toBeUndefined();
    expect(response.body.user.effectiveLocationIds).toBeUndefined();
  });

  // D1 (Phase 1 Global Closeout): owner01@demo.local has zero legacy
  // UserBranchRole rows and exactly one OWNER COMPANY UserRoleScope row
  // (prisma/seed.ts's populate()) — before D1, this exact user's public
  // roles was [] (the confirmed compatibility bug).
  it('projects OWNER for the canonical owner01@demo.local user via /me, which has zero legacy UserBranchRole rows', async () => {
    const owner = await prisma.user.findUniqueOrThrow({ where: { email: 'owner01@demo.local' }, select: { id: true } });
    const response = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${await getAuthToken(owner)}`);
    expect(response.status).toBe(200);
    expect(response.body.user.roles).toEqual(['OWNER']);
  });

  it('rejects missing and expired tokens', async () => {
    const missing = await request(app).get('/api/v1/auth/me');
    const now = Math.floor(Date.now() / 1000);
    const expired = await new SignJWT()
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('00000000-0000-4000-8000-000000000600')
      .setIssuedAt(now - 1200)
      .setExpirationTime(now - 600)
      .sign(new TextEncoder().encode(env.JWT_SECRET));
    const expiredResponse = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${expired}`);
    expect(missing.status).toBe(401);
    expect(expiredResponse.status).toBe(401);
  });

  // D1 (Phase 1 Global Closeout): RETIRES — does not merely re-value — the
  // pre-D1 version of this test. The old test's entire PURPOSE was to prove
  // "public roles derive from UserBranchRole only," which D1 deliberately
  // makes untrue; keeping its name/mutation-target and only flipping the
  // expected string would have silently erased that historical intent. The
  // replacement proves the opposite, equally load-bearing fact:
  //   - the JWT carries identity only (`sub`) — it is never re-issued here
  //   - GET /auth/me rebuilds authorization from the LIVE database on every
  //     request, exactly as before
  //   - public `roles` now follows live Production UserRoleScope
  //     assignments, not the legacy UserBranchRole table
  // The legacy UserBranchRole SELLER row is deliberately left in place and
  // now contradicts UserRoleScope (UBR: SELLER, URS: CASHIER) — asserting
  // both directly proves the DTO is reading UserRoleScope, not UBR, for
  // Production roles.
  it('rebuilds public roles from live Production UserRoleScope on every /auth/me request, even while a contradictory legacy UserBranchRole row remains (UserBranchRole no longer governs public Production roles)', async () => {
    const token = await sellerToken();
    const seller = await prisma.user.findUniqueOrThrow({
      where: { email: 'seller01@demo.local' },
      select: { id: true },
    });
    const sellerRole = await prisma.role.findUniqueOrThrow({ where: { code: 'SELLER' } });
    const cashierRole = await prisma.role.findUniqueOrThrow({ where: { code: 'CASHIER' } });
    const centro = await prisma.branch.findUniqueOrThrow({
      where: { code: 'CEN' },
      select: { id: true },
    });

    // D2.2: normal canonical seed no longer creates UserBranchRole rows —
    // this test's own contradictory legacy fixture is created explicitly
    // here and left untouched below.
    await prisma.userBranchRole.create({
      data: { userId: seller.id, branchId: centro.id, roleId: sellerRole.id },
    });
    expect(
      await prisma.userBranchRole.count({ where: { userId: seller.id, roleId: sellerRole.id } }),
    ).toBe(1);

    // Mutate ONLY the Production authority table — swap the caller's real
    // SELLER assignment for a CASHIER LOCATION assignment at CEN.
    await prisma.userRoleScope.deleteMany({ where: { userId: seller.id, roleId: sellerRole.id } });
    await prisma.userRoleScope.create({
      data: { userId: seller.id, roleId: cashierRole.id, scopeKind: 'LOCATION', locationId: centro.id },
    });

    const response = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${token}`);
    expect(response.status).toBe(200);
    expect(response.body.user.roles).toEqual(['CASHIER']);

    // The legacy row is still there, still saying SELLER — public roles
    // said CASHIER anyway, proving UserBranchRole no longer governs this.
    expect(
      await prisma.userBranchRole.count({ where: { userId: seller.id, roleId: sellerRole.id } }),
    ).toBe(1);
  });

  // GC2 (Phase 1 Global Closeout): USER_MANAGE is now COMPANY-required
  // (permissions.ts), so a LOCATION-scoped ADMIN must still project
  // report.view but no longer user.manage. GC4F2 converged seedDemo's own
  // admin@demo.local to canonical ADMIN COMPANY, so it no longer represents
  // this transitional shape — this test uses its own purpose-built
  // transitional ADMIN LOCATION fixture instead (createTestUser gives it a
  // real UserRoleScope LOCATION row at CEN, matching what admin@demo.local
  // used to look like pre-GC4F2).
  it('projects report.view but not user.manage for a purpose-built transitional ADMIN LOCATION fixture', async () => {
    const adminRole = await prisma.role.findUniqueOrThrow({ where: { code: 'ADMIN' } });
    const centro = await prisma.branch.findUniqueOrThrow({ where: { code: 'CEN' }, select: { id: true } });
    const locationAdmin = await createTestUser(prisma, adminRole.id, centro.id);
    const response = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${await getAuthToken(locationAdmin)}`);
    expect(response.status).toBe(200);
    expect(response.body.user.permissions).toContain('report.view');
    expect(response.body.user.permissions).not.toContain('user.manage');
  });

  // GC2 companion proof: a canonical, non-transitional ADMIN COMPANY
  // assignment retains the exact user.manage projection the transitional
  // LOCATION seed fixture above no longer has. Direct user + real ADMIN role
  // + one UserRoleScope (COMPANY, locationId null) — UserBranchRole grants no
  // authorization here.
  it('projects user.manage for a canonical ADMIN COMPANY caller', async () => {
    const adminRole = await prisma.role.findUniqueOrThrow({ where: { code: 'ADMIN' } });
    const companyAdmin = await prisma.user.create({
      data: { name: 'company-admin-me', email: 'company-admin-me@test.local', passwordHash: 'x' },
    });
    await prisma.userRoleScope.create({
      data: { userId: companyAdmin.id, roleId: adminRole.id, scopeKind: 'COMPANY', locationId: null },
    });
    const response = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${await getAuthToken(companyAdmin)}`);
    expect(response.status).toBe(200);
    expect(response.body.user.permissions).toContain('user.manage');
    expect(response.body.user.permissions).toContain('report.view');
  });

  it('excludes report.view/user.manage/audit.view for canonical WAREHOUSE (lacks them)', async () => {
    const warehouse = await prisma.user.findUniqueOrThrow({ where: { email: 'warehouse01@demo.local' }, select: { id: true } });
    const response = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${await getAuthToken(warehouse)}`);
    expect(response.status).toBe(200);
    expect(response.body.user.permissions).not.toContain('report.view');
    expect(response.body.user.permissions).not.toContain('user.manage');
    expect(response.body.user.permissions).not.toContain('audit.view');
  });

  it('reflects a revoked Production permission in the public permissions field on the next request, without issuing a new token', async () => {
    const admin = await prisma.user.findUniqueOrThrow({ where: { email: 'admin@demo.local' }, select: { id: true } });
    const token = await getAuthToken(admin);
    const before = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`);
    expect(before.body.user.permissions).toContain('report.view');
    const adminRole = await prisma.role.findUniqueOrThrow({ where: { code: 'ADMIN' } });
    const permission = await prisma.permission.findUniqueOrThrow({ where: { code: 'REPORT_VIEW' } });
    await prisma.rolePermission.delete({ where: { roleId_permissionId: { roleId: adminRole.id, permissionId: permission.id } } });
    const after = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`);
    expect(after.status).toBe(200);
    expect(after.body.user.permissions).not.toContain('report.view');
  });

  it('rejects an inactive user even with a previously issued token', async () => {
    const token = await sellerToken();
    await prisma.user.update({
      where: { email: 'seller01@demo.local' },
      data: { isActive: false },
    });
    const response = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${token}`);
    expect(response.status).toBe(403);
  });
});