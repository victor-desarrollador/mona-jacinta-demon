import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { rolePermissions, seedDemo } from '../../prisma/seed.js';
import { createApp } from '../../src/app.js';
import { createTestPrismaClient, truncateAllTables } from '../helpers/test-db.js';

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

  it('returns empty branchIds when UserRoleScope has been revoked, even though legacy UserBranchRole still has an assignment (no per-user legacy fallback post-SWITCH)', async () => {
    const seller = await prisma.user.findUniqueOrThrow({ where: { email: 'seller01@demo.local' } });
    await prisma.userRoleScope.deleteMany({ where: { userId: seller.id } });
    // The legacy UserBranchRole (Centro) assignment stays exactly as seeded —
    // Phase 1D still needs it as the role/permission source — but it must
    // never be read back as a branch-scope fallback: an empty UserRoleScope
    // is zero authorized branches, not "not yet migrated".
    await prisma.userBranchRole.findFirstOrThrow({ where: { userId: seller.id } });

    const response = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'seller01@demo.local', password: 'demo123' });
    expect(response.status).toBe(200);
    expect(response.body.user.branchIds).toEqual([]);
    expect(response.body.user.roles).toEqual(['SELLER']);
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

  it("does not change MANAGER's effective legacy roles or permissions", async () => {
    const response = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'manager01@demo.local', password: 'demo123' });
    expect(response.status).toBe(200);
    // Public contract (Phase 1D.1 compatibility fix): `roles` preserves its
    // pre-1D.1 semantics — UserBranchRole-derived only, not the internal
    // legacy+Production union (the desync fix lives in the internal
    // AuthContext.assignments — see authorization-context.test.ts — and is
    // deliberately not surfaced through this public field).
    expect(response.body.user.roles).toEqual(['MANAGER']);
    expect(response.body.user.permissions.sort()).toEqual([...rolePermissions.MANAGER].sort());
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
        legacyPermissions: [],
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
});
