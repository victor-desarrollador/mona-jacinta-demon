import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedDemo } from '../../prisma/seed.js';
import { createApp } from '../../src/app.js';
import { createTestPrismaClient, truncateAllTables } from '../helpers/test-db.js';
import { getAuthToken } from '../helpers/auth.js';

// Real-DB confirmation that auth.service.ts's /login response body (used by
// GET /me too, via the same resolveEffectiveBranchIds policy) reflects the
// Phase 1C switch. Complements auth-scope-switch.test.ts, which proves the
// same policy in the actual per-request middleware path.
describe('POST /api/v1/auth/login branchIds (Phase 1C SWITCH)', () => {
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

  // D1 (Phase 1 Global Closeout): supersedes this test's pre-D1 role
  // expectation. The legacy UserBranchRole (Centro, SELLER) assignment stays
  // exactly as seeded — it is left untouched below, purely as a fixture
  // fact — but D1 means it must never be read back as EITHER a branch-scope
  // fallback (Phase 1C SWITCH, unchanged) OR a public-role fallback (D1):
  // an empty UserRoleScope is zero authorized branches AND zero public
  // Production roles, never "fall back to whatever legacy says".
  it('returns empty branchIds AND empty roles when UserRoleScope has been revoked, even though legacy UserBranchRole still has an assignment (no per-user legacy fallback for branch scope or public roles, post-SWITCH/D1)', async () => {
    const seller = await prisma.user.findUniqueOrThrow({ where: { email: 'seller01@demo.local' } });
    await prisma.userRoleScope.deleteMany({ where: { userId: seller.id } });
    // Sanity precondition: the legacy UserBranchRole SELLER row genuinely
    // still exists and is left untouched above/below.
    await prisma.userBranchRole.findFirstOrThrow({ where: { userId: seller.id } });

    const response = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'seller01@demo.local', password: 'demo123' });
    expect(response.status).toBe(200);
    expect(response.body.user.branchIds).toEqual([]);
    expect(response.body.user.roles).toEqual([]);
  });

  it('prefers UserRoleScope over legacy UserBranchRole once it has been backfilled for this user', async () => {
    const seller = await prisma.user.findUniqueOrThrow({ where: { email: 'seller01@demo.local' } });
    const sellerRole = await prisma.role.findUniqueOrThrow({ where: { code: 'SELLER' } });
    const company = await prisma.company.create({
      data: { name: 'Auth switch test company', cuit: `TEST-${randomUUID()}`, address: 'Test address' },
    });
    const extraLocation = await prisma.location.create({
      data: {
        companyId: company.id,
        name: 'Extra Location',
        code: `EXTRA-${randomUUID()}`,
        type: 'RETAIL_BRANCH',
        address: 'Test address',
        pointOfSaleNumber: Number(process.hrtime.bigint() % 1000000n),
      },
    });
    try {
      // seedDemo's beforeEach already backfilled seller01 a UserRoleScope row
      // for Centro (Phase 1C sync, once Location exists) — all existing
      // UserRoleScope rows are authoritative, so to prove the replacement
      // scope is the only one in effect, remove the user's existing scope(s)
      // first rather than merely adding to them.
      await prisma.userRoleScope.deleteMany({ where: { userId: seller.id } });
      await prisma.userRoleScope.create({
        data: {
          userId: seller.id,
          roleId: sellerRole.id,
          scopeKind: 'LOCATION',
          locationId: extraLocation.id,
        },
      });

      const response = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'seller01@demo.local', password: 'demo123' });
      expect(response.status).toBe(200);
      expect(response.body.user.branchIds).toEqual([extraLocation.id]);
    } finally {
      await prisma.location.delete({ where: { id: extraLocation.id } });
      await prisma.company.delete({ where: { id: company.id } });
    }
  });

  // D1 (Phase 1 Global Closeout): supersedes this test's pre-D1 purpose
  // ("roles preserves pre-1D.1 semantics — UserBranchRole-derived only") —
  // that is exactly the contract D1 retires. This isolates the D1 boundary
  // itself: a legacy MANAGER UserBranchRole, by itself, contributes ZERO
  // public Production roles/permissions.
  //
  // The current seed still gives manager01 a Production WAREHOUSE
  // UserRoleScope via the existing legacy MANAGER -> WAREHOUSE backfill
  // mapping (legacy-role-map.ts) — a known, separately-tracked D2 issue
  // (whether/how a legacy MANAGER should gain Production authority at all).
  // This test deliberately removes that Production assignment in the
  // isolated TEST database only, so it can prove the D1 projection boundary
  // in isolation without blessing that business-invalid mapping as D1's
  // replacement contract. Neither seed.ts nor legacy-role-map.ts is touched.
  it('projects zero public roles/permissions for a legacy MANAGER UserBranchRole with no Production assignment (D1 boundary, isolated from the D2 MANAGER->WAREHOUSE seed mapping)', async () => {
    const manager = await prisma.user.findUniqueOrThrow({ where: { email: 'manager01@demo.local' } });
    // Sanity precondition: the legacy UserBranchRole MANAGER row genuinely
    // exists as seeded.
    const managerRole = await prisma.role.findUniqueOrThrow({ where: { code: 'MANAGER' } });
    expect(
      await prisma.userBranchRole.count({ where: { userId: manager.id, roleId: managerRole.id } }),
    ).toBe(1);

    // Isolate the D1 projection boundary: remove the Production assignment
    // the current seed's MANAGER->WAREHOUSE backfill created, in TEST only.
    await prisma.userRoleScope.deleteMany({ where: { userId: manager.id } });

    const response = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'manager01@demo.local', password: 'demo123' });
    expect(response.status).toBe(200);
    expect(response.body.user.roles).toEqual([]);
    expect(response.body.user.permissions).toEqual([]);
  });

  it('never exposes internal Production authorization shapes (assignments/legacyPermissions/effectiveLocationIds) through the public login response', async () => {
    const response = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'seller01@demo.local', password: 'demo123' });
    expect(response.status).toBe(200);
    expect(response.body.user.assignments).toBeUndefined();
    expect(response.body.user.legacyPermissions).toBeUndefined();
    expect(response.body.user.effectiveLocationIds).toBeUndefined();
    expect(Object.keys(response.body.user).sort()).toEqual(
      ['branchIds', 'email', 'id', 'name', 'permissions', 'roles'].sort(),
    );
  });

  // Phase 1D.2.5 module-level OWNER proof (docs/superpowers/plans/2026-09-14-
  // phase-1d-production-authorization.md Task 1D.2.5): OWNER passes a direct
  // Production requirePermission check purely through isOwner's COMPANY
  // assignment recognition, with zero RolePermission rows anywhere. No HTTP
  // route is switched to Production requirePermission yet at this checkpoint
  // (Phase 1D.3 does that) — the plan itself defers the HTTP-route proof to
  // Task 1D.3.1 and keeps only this module-level proof here.
  it('OWNER passes requirePermission directly with zero RolePermission rows (module-level proof, HTTP proof deferred to Task 1D.3.1)', async () => {
    const { requirePermission } = await import('../../src/middleware/authorization.js');
    const middleware = requirePermission('PRICE_MANAGE' as never);
    // Same typed-fixture idiom as tests/audit/audit.test.ts's req() helper:
    // a real Express.Request only needs the .auth shape this middleware
    // actually reads, so build exactly that and assert it into the full
    // Request type rather than fabricating every unrelated Request field.
    const req = {
      auth: {
        userId: 'u1',
        roles: ['OWNER'],
        assignments: [
          { roleId: 'r', roleCode: 'OWNER', scopeKind: 'COMPANY', locationId: null, permissions: [] },
        ],
        effectiveLocationIds: [],
      },
    } as unknown as Request;
    const res = {} as unknown as Response;
    let calledNext = false;
    const next: NextFunction = (err) => {
      if (!err) calledNext = true;
    };
    await middleware(req, res, next);
    expect(calledNext).toBe(true);
  });

  // Phase 1D.3.1 §7 — the deferred HTTP proofs from Task 1D.2.5, now that
  // GET /sales/pending (SALE_QUEUE_VIEW) and GET /sales/:saleId (SALE_VIEW)
  // are real switched Production-gated routes.
  it('an OWNER user passes a live switched route (SALE_QUEUE_VIEW) with zero RolePermission rows', async () => {
    const ownerRole = await prisma.role.findUniqueOrThrow({ where: { code: 'OWNER' } });
    const owner = await prisma.user.create({ data: { name: 'Owner E2E', email: 'owner-e2e@test.local', passwordHash: 'x' } });
    await prisma.userRoleScope.create({ data: { userId: owner.id, roleId: ownerRole.id, scopeKind: 'COMPANY', locationId: null } });
    const token = await getAuthToken(owner);
    const response = await request(app).get('/api/v1/sales/pending').set('Authorization', `Bearer ${token}`);
    expect(response.status).toBe(200);
  });

  it('an ADMIN with a COMPANY assignment can view its own draft at a branch it was never explicitly LOCATION-granted', async () => {
    const adminRole = await prisma.role.findUniqueOrThrow({ where: { code: 'ADMIN' } });
    const admin = await prisma.user.create({ data: { name: 'Admin E2E', email: 'admin-e2e@test.local', passwordHash: 'x' } });
    await prisma.userRoleScope.create({ data: { userId: admin.id, roleId: adminRole.id, scopeKind: 'COMPANY', locationId: null } });
    const token = await getAuthToken(admin);
    // Never explicitly LOCATION-granted to this admin — only the COMPANY
    // assignment above authorizes it, proving ensureSaleAccess's converted
    // assertPermissionAtLocation(SALE_VIEW) honors a COMPANY assignment.
    const yb = await prisma.branch.findUniqueOrThrow({ where: { code: 'YB' } });
    const sale = await prisma.sale.create({ data: { sellerId: admin.id, branchId: yb.id, status: 'DRAFT', subtotal: 0n, total: 0n } });
    const response = await request(app).get(`/api/v1/sales/${sale.id}`).set('Authorization', `Bearer ${token}`);
    expect(response.status).toBe(200);
  });
});
