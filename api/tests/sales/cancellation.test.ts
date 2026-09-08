import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedDemo } from '../../prisma/seed.js';
import { createApp } from '../../src/app.js';
import type { Prisma, PrismaClient } from '../../src/generated/prisma/client.js';
import { createTestPrismaClient, truncateAllTables } from '../helpers/test-db.js';
import { getAuthToken } from '../helpers/auth.js';

describe('Task 19: sale cancellation and expired reservation release', () => {
  let db: PrismaClient;
  let app: ReturnType<typeof createApp>;
  let sellerId: string;
  let managerId: string;
  let branchId: string;
  let variantId: string;
  let productId: string;
  let inventoryId: string;
  let sellerToken: string;
  let managerToken: string;

  beforeAll(async () => { db = await createTestPrismaClient(); app = createApp(db); }, 120000);
  beforeEach(async () => {
    await truncateAllTables(db);
    await seedDemo(db);
    const [seller, manager, branch, variant] = await Promise.all([
      db.user.findUniqueOrThrow({ where: { email: 'seller01@demo.local' } }),
      db.user.findUniqueOrThrow({ where: { email: 'manager01@demo.local' } }),
      db.branch.findUniqueOrThrow({ where: { code: 'CEN' } }),
      db.productVariant.findUniqueOrThrow({ where: { sku: 'REM-NEG-M' } }),
    ]);
    sellerId = seller.id; managerId = manager.id; branchId = branch.id; variantId = variant.id; productId = variant.productId;
    inventoryId = (await db.inventory.findUniqueOrThrow({ where: { variantId_branchId: { variantId, branchId } } })).id;
    sellerToken = await getAuthToken(seller); managerToken = await getAuthToken(manager);
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
  const release = (token = managerToken) => request(app).post('/api/v1/admin/reservations/release-expired').set('Authorization', `Bearer ${token}`);

  it('requires authentication, SALE_CREATE, and fresh assignment/permission', async () => {
    const current = await sale('DRAFT');
    expect((await request(app).post(`/api/v1/sales/${current.id}/cancel`)).status).toBe(401);
    const role = await db.role.findUniqueOrThrow({ where: { code: 'SELLER' } });
    const permission = await db.permission.findUniqueOrThrow({ where: { code: 'sale.create' } });
    await db.rolePermission.delete({ where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } } });
    expect((await cancel(current.id)).status).toBe(403);
    await db.rolePermission.upsert({ where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } }, create: { roleId: role.id, permissionId: permission.id }, update: {} });
    await db.userBranchRole.updateMany({ where: { userId: sellerId }, data: { branchId: (await db.branch.findUniqueOrThrow({ where: { code: 'YB' } })).id } });
    expect((await cancel(current.id)).status).toBe(403);
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
    const role = await db.role.findUniqueOrThrow({ where: { code: 'MANAGER' } });
    const permission = await db.permission.findUniqueOrThrow({ where: { code: 'inventory.manage' } });
    await db.rolePermission.delete({ where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } } });
    expect((await release()).status).toBe(403);
    await db.rolePermission.upsert({ where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } }, create: { roleId: role.id, permissionId: permission.id }, update: {} });
    await db.role.update({ where: { id: role.id }, data: { code: 'ADMIN_LOOKALIKE' } });
    const current = await sale(); await reserve(current.id);
    expect((await release()).status).toBe(200);
  });

  it('does not leave payment plus released reservation in a race', async () => {
    const current = await sale(); await reserve(current.id);
    const paymentToken = await getAuthToken({ id: managerId });
    const paymentResponse = request(app).post(`/api/v1/sales/${current.id}/payments`).set('Authorization', `Bearer ${paymentToken}`).send({ method: 'TRANSFER', amount: '1', idempotencyKey: randomUUID() });
    const releaseResponse = release();
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
