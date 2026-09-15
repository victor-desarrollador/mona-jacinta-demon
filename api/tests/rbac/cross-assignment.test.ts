import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createRequireAuth } from '../../src/middleware/auth.js';
import { requirePermission } from '../../src/middleware/authorization.js';
import { errorHandler } from '../../src/middleware/errorHandler.js';
import { PRODUCTION_PERMISSIONS } from '../../src/modules/rbac/permissions.js';
import { bootstrapProductionRbacCatalog } from '../../src/modules/rbac/catalog.service.js';
import { createBranch, ensureTestLocation } from '../helpers/factories.js';
import { getAuthToken } from '../helpers/auth.js';
import { createTestPrismaClient, truncateAllTables } from '../helpers/test-db.js';

// Phase 1D.2.4 security proof (Cross-cutting design §B / plan's "SECURITY
// TESTS FOR TASK 1D.2.4" item B): a live route, gated by the real
// createRequireAuth -> buildAuthorizationContext -> requirePermission ->
// hasPermissionAtLocation chain over a genuinely persisted UserRoleScope
// pair, must never let a permission granted by one assignment combine with a
// location granted by a different assignment.
//
// No production business route is switched to requirePermission (Production)
// yet at this checkpoint (Phase 1D.3 does that, one route at a time) — the
// plan's own Task 1D.2.5 note ("Resolve this ordering explicitly") already
// establishes that a Production-gated live-route proof in Phase 1D.2 must be
// built as its own minimal app rather than borrowed from an unswitched
// business route, since the mechanical requireLegacyPermission rename means
// no business route reads req.auth.assignments yet. This file is that "closest
// exact repository pattern" stand-in the task instructions explicitly allow.
describe('cross-assignment composition through a live Production-gated route (Phase 1D.2.4)', () => {
  let db: Awaited<ReturnType<typeof createTestPrismaClient>>;
  let app: express.Express;

  beforeAll(async () => {
    db = await createTestPrismaClient();
  });

  beforeEach(async () => {
    await truncateAllTables(db);
    await bootstrapProductionRbacCatalog(db);

    app = express();
    app.use(express.json());
    const auth = createRequireAuth(db);
    app.get(
      '/inventory-view',
      auth,
      requirePermission(PRODUCTION_PERMISSIONS.INVENTORY_VIEW, {
        branchScope: 'own',
        resolveResourceBranch: (req) => String(req.query.branchId),
      }),
      (_req, res) => res.json({ ok: true }),
    );
    app.get(
      '/inventory-manage',
      auth,
      requirePermission(PRODUCTION_PERMISSIONS.INVENTORY_MANAGE, {
        branchScope: 'own',
        resolveResourceBranch: (req) => String(req.query.branchId),
      }),
      (_req, res) => res.json({ ok: true }),
    );
    app.use(errorHandler);
  });

  afterAll(async () => db.$disconnect());

  it('a SELLER @ A + WAREHOUSE @ B user cannot use WAREHOUSE INVENTORY_MANAGE at A, nor SELLER INVENTORY_VIEW at B', async () => {
    const branchA = await createBranch(db);
    const branchB = await createBranch(db);
    await ensureTestLocation(db, branchA.id);
    await ensureTestLocation(db, branchB.id);
    const sellerRole = await db.role.findUniqueOrThrow({ where: { code: 'SELLER' } });
    const warehouseRole = await db.role.findUniqueOrThrow({ where: { code: 'WAREHOUSE' } });
    const user = await db.user.create({
      data: { name: 'multi', email: 'multi@test.local', passwordHash: 'x' },
    });
    await db.userRoleScope.createMany({
      data: [
        { userId: user.id, roleId: sellerRole.id, scopeKind: 'LOCATION', locationId: branchA.id },
        { userId: user.id, roleId: warehouseRole.id, scopeKind: 'LOCATION', locationId: branchB.id },
      ],
    });
    const token = await getAuthToken(user);

    // SELLER's own assignment grants INVENTORY_VIEW at A — expected to succeed.
    const viewAtA = await request(app)
      .get('/inventory-view')
      .query({ branchId: branchA.id })
      .set('Authorization', `Bearer ${token}`);
    expect(viewAtA.status).toBe(200);

    // WAREHOUSE's assignment does not grant INVENTORY_VIEW at all — if this
    // succeeded, SELLER's INVENTORY_VIEW permission would have incorrectly
    // combined with WAREHOUSE's location B.
    const viewAtB = await request(app)
      .get('/inventory-view')
      .query({ branchId: branchB.id })
      .set('Authorization', `Bearer ${token}`);
    expect(viewAtB.status).toBe(403);

    // WAREHOUSE's own assignment grants INVENTORY_MANAGE at B — expected to succeed.
    const manageAtB = await request(app)
      .get('/inventory-manage')
      .query({ branchId: branchB.id })
      .set('Authorization', `Bearer ${token}`);
    expect(manageAtB.status).toBe(200);

    // SELLER's assignment does not grant INVENTORY_MANAGE at all — if this
    // succeeded, WAREHOUSE's INVENTORY_MANAGE permission would have
    // incorrectly combined with SELLER's location A.
    const manageAtA = await request(app)
      .get('/inventory-manage')
      .query({ branchId: branchA.id })
      .set('Authorization', `Bearer ${token}`);
    expect(manageAtA.status).toBe(403);
  });
});
