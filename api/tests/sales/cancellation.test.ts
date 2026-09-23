import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedDemo } from '../../prisma/seed.js';
import { createApp } from '../../src/app.js';
import type { Prisma, PrismaClient } from '../../src/generated/prisma/client.js';
import { createTestPrismaClient, truncateAllTables } from '../helpers/test-db.js';
import { getAuthToken, createTestUser } from '../helpers/auth.js';
import { createRole } from '../helpers/factories.js';

describe('Task 19: sale cancellation and expired reservation release', () => {
  let db: PrismaClient;
  let app: ReturnType<typeof createApp>;
  let sellerId: string;
  let warehouseId: string;
  let branchId: string;
  let variantId: string;
  let productId: string;
  let inventoryId: string;
  let sellerToken: string;
  let warehouseToken: string;

  beforeAll(async () => { db = await createTestPrismaClient(); app = createApp(db); }, 120000);
  beforeEach(async () => {
    await truncateAllTables(db);
    await seedDemo(db);
    const [seller, warehouse, branch, variant] = await Promise.all([
      db.user.findUniqueOrThrow({ where: { email: 'seller01@demo.local' } }),
      db.user.findUniqueOrThrow({ where: { email: 'warehouse01@demo.local' } }),
      db.branch.findUniqueOrThrow({ where: { code: 'CEN' } }),
      db.productVariant.findUniqueOrThrow({ where: { sku: 'REM-NEG-M' } }),
    ]);
    sellerId = seller.id; warehouseId = warehouse.id; branchId = branch.id; variantId = variant.id; productId = variant.productId;
    inventoryId = (await db.inventory.findUniqueOrThrow({ where: { variantId_branchId: { variantId, branchId } } })).id;
    sellerToken = await getAuthToken(seller); warehouseToken = await getAuthToken(warehouse);
  }, 120000);
  afterAll(async () => { await db?.$disconnect(); }, 120000);

  async function sale(status: 'DRAFT' | 'PENDING_PAYMENT' | 'PAID' | 'COMPLETED' | 'CANCELLED' = 'PENDING_PAYMENT') {
    return db.sale.create({ data: { sellerId, branchId, status, subtotal: 100n, total: 100n } });
  }
  async function reserve(saleId: string, quantity = 2n, expiresAt = new Date(Date.now() - 1000)) {
    await db.inventory.update({ where: { id: inventoryId }, data: { reserved: { increment: quantity } } });
    return db.stockReservation.create({ data: { saleId, variantId, branchId, quantity, expiresAt } });
  }
  async function payment(saleId: string, amount = 1n) {
    return db.salePayment.create({ data: { saleId, method: 'TRANSFER', amount, idempotencyKey: randomUUID() } });
  }
  const cancel = (saleId: string, token = sellerToken) => request(app).post(`/api/v1/sales/${saleId}/cancel`).set('Authorization', `Bearer ${token}`);
  const release = (token = warehouseToken) => request(app).post('/api/v1/admin/reservations/release-expired').set('Authorization', `Bearer ${token}`);

  it('requires authentication, SALE_CREATE, and fresh assignment/permission', async () => {
    const current = await sale('DRAFT');
    expect((await request(app).post(`/api/v1/sales/${current.id}/cancel`)).status).toBe(401);
    // Phase 1D.3.1 SWITCH: /cancel now gates on the Production SALE_CREATE grant.
    const role = await db.role.findUniqueOrThrow({ where: { code: 'SELLER' } });
    const permission = await db.permission.findUniqueOrThrow({ where: { code: 'SALE_CREATE' } });
    await db.rolePermission.delete({ where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } } });
    expect((await cancel(current.id)).status).toBe(403);
    await db.rolePermission.upsert({ where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } }, create: { roleId: role.id, permissionId: permission.id }, update: {} });
    // Branch/reassignment subcase: authoritative LOCATION scope moves to YB
    // — this asserts fresh UserRoleScope enforcement, not a re-test of the
    // permission check above.
    const yb = await db.branch.findUniqueOrThrow({ where: { code: 'YB' } });
    await db.userRoleScope.updateMany({ where: { userId: sellerId, scopeKind: 'LOCATION' }, data: { locationId: yb.id } });
    expect((await cancel(current.id)).status).toBe(403);
  });

  it('grants cancellation on a fresh UserRoleScope location despite a stale UserBranchRole', async () => {
    // Phase 1C SWITCH: UserRoleScope is the sole LOCATION authority.
    // UserBranchRole (role/permission authority) stays at CEN — only the
    // scope moves to YB — so this proves the legacy row can no longer veto
    // access to a location UserRoleScope has actually authorized. D2.2:
    // canonical seed creates no UserBranchRole, so the stale legacy row is
    // this test's own explicit fixture.
    const sellerRole = await db.role.findUniqueOrThrow({ where: { code: 'SELLER' } });
    await db.userBranchRole.create({ data: { userId: sellerId, branchId, roleId: sellerRole.id } });
    const yb = await db.branch.findUniqueOrThrow({ where: { code: 'YB' } });
    await db.userRoleScope.updateMany({ where: { userId: sellerId, scopeKind: 'LOCATION' }, data: { locationId: yb.id } });
    const current = await db.sale.create({ data: { sellerId, branchId: yb.id, status: 'DRAFT', subtotal: 100n, total: 100n } });
    const response = await cancel(current.id);
    expect(response.status).toBe(200);
    expect((await db.sale.findUniqueOrThrow({ where: { id: current.id } })).status).toBe('CANCELLED');
  });

  it('cancels DRAFT without inventory or stock movement and audits', async () => {
    const current = await sale('DRAFT');
    const response = await cancel(current.id);
    expect(response.status).toBe(200); expect(response.body.status).toBe('CANCELLED');
    expect((await db.sale.findUniqueOrThrow({ where: { id: current.id } })).status).toBe('CANCELLED');
    expect(await db.stockMovement.count()).toBe(0); expect(await db.auditLog.count()).toBe(1);
  });

  it('cancels zero-payment pending sale, releases exact duplicate-variant reservations, and preserves physical stock', async () => {
    const current = await sale(); await db.saleItem.create({ data: { saleId: current.id, variantId, productId, productName: 'x', variantName: 'x', sku: 'x', quantity: 3n, unitPrice: 1n, subtotal: 3n } });
    await reserve(current.id, 2n); await reserve(current.id, 3n);
    const before = await db.inventory.findUniqueOrThrow({ where: { id: inventoryId } });
    const response = await cancel(current.id);
    expect(response.status).toBe(200);
    const after = await db.inventory.findUniqueOrThrow({ where: { id: inventoryId } });
    expect(after.physical).toBe(before.physical); expect(after.reserved).toBe(before.reserved - 5n);
    expect(await db.stockReservation.count({ where: { saleId: current.id, status: 'RELEASED' } })).toBe(2);
    expect(await db.stockMovement.count()).toBe(0);
    expect(await db.auditLog.findFirstOrThrow()).toMatchObject({ action: 'SALE_CANCELLED', entityId: current.id, after: { status: 'CANCELLED' } });
  });

  it('rejects any accepted payment and protects all lifecycle states', async () => {
    const partial = await sale(); await reserve(partial.id); await payment(partial.id, 1n);
    expect((await cancel(partial.id)).body.error.code).toBe('PAYMENT_ALREADY_ACCEPTED');
    expect((await db.sale.findUniqueOrThrow({ where: { id: partial.id } })).status).toBe('PENDING_PAYMENT');
    expect((await db.stockReservation.findFirstOrThrow({ where: { saleId: partial.id } })).status).toBe('ACTIVE');
    for (const status of ['PAID', 'COMPLETED', 'CANCELLED'] as const) {
      const current = await sale(status); expect((await cancel(current.id)).body.error.code).toBe('INVALID_SALE_STATE');
    }
  });

  it('rejects wrong-branch reservations and insufficient reserved stock without writes', async () => {
    const current = await sale();
    const otherBranch = await db.branch.findUniqueOrThrow({ where: { code: 'YB' } });
    await db.stockReservation.create({ data: { saleId: current.id, variantId, branchId: otherBranch.id, quantity: 1n, expiresAt: new Date(Date.now() - 1000) } });
    expect((await cancel(current.id)).body.error.code).toBe('INVALID_RESERVATION');
    expect((await db.sale.findUniqueOrThrow({ where: { id: current.id } })).status).toBe('PENDING_PAYMENT');
    await db.stockReservation.deleteMany({ where: { saleId: current.id } });
    await reserve(current.id, 2n); await db.inventory.update({ where: { id: inventoryId }, data: { reserved: 0n } });
    expect((await cancel(current.id)).body.error.code).toBe('INVALID_RESERVATION');
    expect((await db.sale.findUniqueOrThrow({ where: { id: current.id } })).status).toBe('PENDING_PAYMENT'); expect(await db.auditLog.count()).toBe(0);
  });

  it('releases only eligible expired reservations and is repeat-safe', async () => {
    // release-expired only touches the caller's own effective locations. The
    // canonical warehouse01 is Production-native WAREHOUSE LOCATION DEP, so
    // this test's reservations live at DEP (branchId/inventoryId are reset
    // by beforeEach).
    const dep = await db.branch.findUniqueOrThrow({ where: { code: 'DEP' } });
    branchId = dep.id;
    inventoryId = (await db.inventory.findUniqueOrThrow({ where: { variantId_branchId: { variantId, branchId } } })).id;
    const expired = await sale(); await reserve(expired.id, 2n);
    const fresh = await sale(); await reserve(fresh.id, 1n, new Date(Date.now() + 3600000));
    const paid = await sale(); await reserve(paid.id, 1n); await payment(paid.id, 1n);
    const before = await db.inventory.findUniqueOrThrow({ where: { id: inventoryId } });
    const response = await release(); expect(response.status).toBe(200);
    expect(response.body.released).toHaveLength(1);
    expect((await db.stockReservation.findFirstOrThrow({ where: { saleId: expired.id } })).status).toBe('RELEASED');
    expect((await db.stockReservation.findFirstOrThrow({ where: { saleId: fresh.id } })).status).toBe('ACTIVE');
    expect((await db.stockReservation.findFirstOrThrow({ where: { saleId: paid.id } })).status).toBe('ACTIVE');
    const after = await db.inventory.findUniqueOrThrow({ where: { id: inventoryId } });
    expect(after.physical).toBe(before.physical); expect(await db.stockMovement.count()).toBe(0); expect(await db.auditLog.count()).toBe(1);
    expect((await release()).body.released).toHaveLength(0); expect(await db.auditLog.count()).toBe(1);
  });

  it('requires INVENTORY_MANAGE and preserves stale-role authorization', async () => {
    // Phase 1D.3.1 SWITCH: /release-expired now gates on the Production
    // INVENTORY_MANAGE grant. The canonical warehouse01's Production-native
    // UserRoleScope (WAREHOUSE LOCATION DEP) points at the WAREHOUSE Role
    // row — that row is what the Production assignment's permissions come
    // from, so revoking the grant there is what proves the live decision.
    const role = await db.role.findUniqueOrThrow({ where: { code: 'WAREHOUSE' } });
    const permission = await db.permission.findUniqueOrThrow({ where: { code: 'INVENTORY_MANAGE' } });
    await db.rolePermission.delete({ where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } } });
    expect((await release()).status).toBe(403);
    await db.rolePermission.upsert({ where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } }, create: { roleId: role.id, permissionId: permission.id }, update: {} });
    // Stale legacy role state never drives Production authority: give the
    // caller an explicit legacy MANAGER UserBranchRole (D2.2: canonical
    // seed creates none), then rename that legacy role code — authority
    // still comes solely from the WAREHOUSE UserRoleScope.
    const legacyRole = await db.role.findUniqueOrThrow({ where: { code: 'MANAGER' } });
    await db.userBranchRole.create({ data: { userId: warehouseId, branchId, roleId: legacyRole.id } });
    await db.role.update({ where: { id: legacyRole.id }, data: { code: 'ADMIN_LOOKALIKE' } });
    const current = await sale(); await reserve(current.id);
    expect((await release()).status).toBe(200);
  });

  // Phase 1D.3.1 §8: isolate the authority source explicitly for both
  // switched Cancellation gates.
  it('authorizes cancellation via the Production SALE_CREATE grant alone', async () => {
    // Isolated via a fresh user, not a fresh role: authorization-context.ts
    // validates a persisted UserRoleScope's Role.code against the canonical
    // Production catalog (isProductionRoleCode) before it can ever become an
    // assignment — an arbitrary test-only role code would be skipped
    // entirely and prove nothing. SELLER carries SALE_CREATE as its own real
    // default grant (role-permission-matrix.ts), so a brand-new SELLER user
    // with no other state still isolates "the grant alone authorizes".
    const sellerRole = await db.role.findUniqueOrThrow({ where: { code: 'SELLER' } });
    const user = await createTestUser(db, sellerRole.id, branchId);
    const isolatedToken = await getAuthToken(user);
    const current = await sale('DRAFT');
    const response = await cancel(current.id, isolatedToken);
    expect(response.status).toBe(200);
  });

  it('authorizes cancellation via a bare COMPANY-scoped OWNER assignment', async () => {
    const ownerRole = await db.role.findUniqueOrThrow({
      where: { code: 'OWNER' },
    });

    const owner = await db.user.create({
      data: {
        name: 'owner-cancel-sale',
        email: 'owner-cancel-sale@test.local',
        passwordHash: 'x',
      },
    });

    await db.userRoleScope.create({
      data: {
        userId: owner.id,
        roleId: ownerRole.id,
        scopeKind: 'COMPANY',
        locationId: null,
      },
    });

    const ownerToken = await getAuthToken(owner);
    const current = await sale('DRAFT');
    const response = await cancel(current.id, ownerToken);
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('CANCELLED');
  });

  it('rejects a legacy-lowercase-only sale.create grant on /cancel, once switched', async () => {
    const permission = await db.permission.upsert({ where: { code: 'sale.create' }, create: { code: 'sale.create' }, update: {} });
    const role = await createRole(db, 'LEGACY-ONLY-CANCEL');
    await db.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
    const user = await createTestUser(db, role.id, branchId);
    const isolatedToken = await getAuthToken(user);
    const current = await sale('DRAFT');
    const response = await cancel(current.id, isolatedToken);
    expect(response.status).toBe(403);
  });

  it('authorizes release-expired via the Production INVENTORY_MANAGE grant alone', async () => {
    // Isolated via a fresh user on the real WAREHOUSE role, not a fresh
    // role — see the SALE_CREATE isolation test above for why an arbitrary
    // test-only role code cannot be used (isProductionRoleCode fails it
    // closed). WAREHOUSE carries INVENTORY_MANAGE as its own real default
    // grant (role-permission-matrix.ts).
    const warehouseRole = await db.role.findUniqueOrThrow({ where: { code: 'WAREHOUSE' } });
    const user = await createTestUser(db, warehouseRole.id, branchId);
    const isolatedToken = await getAuthToken(user);
    const response = await release(isolatedToken);
    expect(response.status).toBe(200);
  });

  it('authorizes release-expired via a bare COMPANY-scoped OWNER assignment', async () => {
    const ownerRole = await db.role.findUniqueOrThrow({
      where: { code: 'OWNER' },
    });

    const owner = await db.user.create({
      data: {
        name: 'owner-release-expired',
        email: 'owner-release-expired@test.local',
        passwordHash: 'x',
      },
    });

    await db.userRoleScope.create({
      data: {
        userId: owner.id,
        roleId: ownerRole.id,
        scopeKind: 'COMPANY',
        locationId: null,
      },
    });

    const ownerToken = await getAuthToken(owner);
    const response = await release(ownerToken);
    expect(response.status).toBe(200);
  });

  it('rejects a legacy-lowercase-only inventory.manage grant on /release-expired, once switched', async () => {
    const permission = await db.permission.upsert({ where: { code: 'inventory.manage' }, create: { code: 'inventory.manage' }, update: {} });
    const role = await createRole(db, 'LEGACY-ONLY-RELEASE');
    await db.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
    const user = await createTestUser(db, role.id, branchId);
    const isolatedToken = await getAuthToken(user);
    const response = await release(isolatedToken);
    expect(response.status).toBe(403);
  });

  // Phase 1D.3.1 §6 cross-assignment security, through the real switched
  // /cancel route (complements tests/rbac/cross-assignment.test.ts's
  // synthetic-app proof): a permission granted by one assignment must never
  // combine with a location granted by a different assignment.
  it('SELLER @ A + WAREHOUSE @ B: cancels a sale at A via SELLER, but never at B (WAREHOUSE lacks SALE_CREATE)', async () => {
    const yb = await db.branch.findUniqueOrThrow({ where: { code: 'YB' } });
    const sellerRole = await db.role.findUniqueOrThrow({ where: { code: 'SELLER' } });
    const warehouseRole = await db.role.findUniqueOrThrow({ where: { code: 'WAREHOUSE' } });
    const multi = await db.user.create({ data: { name: 'multi', email: 'multi-cancel@test.local', passwordHash: 'x' } });
    await db.userRoleScope.createMany({
      data: [
        { userId: multi.id, roleId: sellerRole.id, scopeKind: 'LOCATION', locationId: branchId },
        { userId: multi.id, roleId: warehouseRole.id, scopeKind: 'LOCATION', locationId: yb.id },
      ],
    });
    const multiToken = await getAuthToken(multi);
    const saleAtA = await db.sale.create({ data: { sellerId, branchId, status: 'DRAFT', subtotal: 100n, total: 100n } });
    expect((await cancel(saleAtA.id, multiToken)).status).toBe(200);
    const saleAtB = await db.sale.create({ data: { sellerId, branchId: yb.id, status: 'DRAFT', subtotal: 100n, total: 100n } });
    expect((await cancel(saleAtB.id, multiToken)).status).toBe(403);
  });

  it('does not leave payment plus released reservation in a race', async () => {
    const current = await sale(); await reserve(current.id);
    // For this to be a real race at CEN, the payment caller must be able to
    // charge there (SALE_CHARGE: the canonical CASHIER @ CEN) and the release
    // caller must hold INVENTORY_MANAGE covering CEN — release-expired only
    // touches the caller's own effective locations, and warehouse01 is DEP,
    // so the canonical COMPANY-scoped ADMIN releases here.
    const [cashier, admin] = await Promise.all([
      db.user.findUniqueOrThrow({ where: { email: 'cashier01@demo.local' } }),
      db.user.findUniqueOrThrow({ where: { email: 'admin@demo.local' } }),
    ]);
    const paymentToken = await getAuthToken(cashier);
    const paymentResponse = request(app).post(`/api/v1/sales/${current.id}/payments`).set('Authorization', `Bearer ${paymentToken}`).send({ method: 'TRANSFER', amount: '1', idempotencyKey: randomUUID() });
    const releaseResponse = release(await getAuthToken(admin));
    const [paymentResult, expiryResult] = await Promise.all([paymentResponse, releaseResponse]);
    const persistedPayment = await db.salePayment.count({ where: { saleId: current.id } });
    const persistedReservation = await db.stockReservation.findFirstOrThrow({ where: { saleId: current.id } });
    expect(!(persistedPayment > 0 && persistedReservation.status === 'RELEASED')).toBe(true);
    expect([paymentResult.status, expiryResult.status]).toEqual(expect.arrayContaining([200]));
  });

  it('rolls cancellation back if the audit write fails', async () => {
    const current = await sale(); await reserve(current.id);
    const before = await db.inventory.findUniqueOrThrow({ where: { id: inventoryId } });
    const original = db.$transaction.bind(db);
    vi.spyOn(db, '$transaction').mockImplementation(((callback: (tx: Prisma.TransactionClient) => Promise<unknown>, options: object) => original(async (tx) => {
      vi.spyOn(tx.auditLog, 'create').mockRejectedValueOnce(new Error('forced audit failure')); return callback(tx);
    }, options)) as typeof db.$transaction);
    expect((await cancel(current.id)).status).toBe(500);
    expect((await db.sale.findUniqueOrThrow({ where: { id: current.id } })).status).toBe('PENDING_PAYMENT');
    expect((await db.inventory.findUniqueOrThrow({ where: { id: inventoryId } })).reserved).toBe(before.reserved);
    expect((await db.stockReservation.findFirstOrThrow({ where: { saleId: current.id } })).status).toBe('ACTIVE'); expect(await db.auditLog.count()).toBe(0);
  });
});
