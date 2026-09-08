import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedDemo } from '../../prisma/seed.js';
import { createApp } from '../../src/app.js';
import type { Prisma, PrismaClient } from '../../src/generated/prisma/client.js';
import { createTestPrismaClient, truncateAllTables } from '../helpers/test-db.js';
import { getAuthToken } from '../helpers/auth.js';

describe('POST /api/v1/sales/:saleId/complete', () => {
  let db: PrismaClient;
  let app: ReturnType<typeof createApp>;
  let cashierId: string;
  let sellerId: string;
  let branchId: string;
  let otherBranchId: string;
  let remeraId: string;
  let jeanId: string;
  let remeraProductId: string;
  let jeanProductId: string;
  let token: string;

  beforeAll(async () => {
    db = await createTestPrismaClient();
    app = createApp(db);
  }, 120000);

  beforeEach(async () => {
    await truncateAllTables(db);
    await seedDemo(db);
    const [cashier, seller, branch, otherBranch, remera, jean] = await Promise.all([
      db.user.findUniqueOrThrow({ where: { email: 'cashier01@demo.local' } }),
      db.user.findUniqueOrThrow({ where: { email: 'seller01@demo.local' } }),
      db.branch.findUniqueOrThrow({ where: { code: 'CEN' } }),
      db.branch.findUniqueOrThrow({ where: { code: 'YB' } }),
      db.productVariant.findUniqueOrThrow({ where: { sku: 'REM-NEG-M' } }),
      db.productVariant.findUniqueOrThrow({ where: { sku: 'JEA-AZU-42' } }),
    ]);
    cashierId = cashier.id;
    sellerId = seller.id;
    branchId = branch.id;
    otherBranchId = otherBranch.id;
    remeraId = remera.id;
    jeanId = jean.id;
    remeraProductId = remera.productId;
    jeanProductId = jean.productId;
    token = await getAuthToken(cashier);
  }, 120000);

  afterAll(async () => { await db?.$disconnect(); }, 120000);

  function complete(saleId: string, accessToken = token, body: object = {}) {
    return request(app)
      .post(`/api/v1/sales/${saleId}/complete`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send(body);
  }

  async function createSale(status: 'PAID' | 'DRAFT' | 'PENDING_PAYMENT' | 'COMPLETED' | 'CANCELLED' = 'PAID') {
    return db.sale.create({
      data: { sellerId, branchId, status, subtotal: 0n, total: 0n },
    });
  }

  async function addItem(saleId: string, variantId: string, productId: string, quantity: bigint) {
    const variant = await db.productVariant.findUniqueOrThrow({ where: { id: variantId } });
    return db.saleItem.create({
      data: {
        saleId, variantId, productId, productName: 'Snapshot product',
        variantName: 'Snapshot variant', sku: variant.sku,
        quantity, unitPrice: variant.price, subtotal: quantity * variant.price,
      },
    });
  }

  async function reserve(saleId: string, variantId: string, quantity: bigint, overrides: Partial<{
    branchId: string;
    status: 'ACTIVE' | 'RELEASED' | 'CONSUMED';
  }> = {}) {
    const reservationBranchId = overrides.branchId ?? branchId;
    await db.inventory.update({
      where: { variantId_branchId: { variantId, branchId: reservationBranchId } },
      data: { reserved: { increment: quantity } },
    });
    return db.stockReservation.create({
      data: {
        saleId, variantId, branchId: reservationBranchId, quantity,
        status: overrides.status ?? 'ACTIVE',
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      },
    });
  }

  async function createReservedSale(items: Array<{ variantId: string; productId: string; quantity: bigint }>) {
    const total = items.reduce((sum, item) => sum + item.quantity, 0n);
    const sale = await db.sale.create({
      data: { sellerId, branchId, status: 'PAID', subtotal: total, total },
    });
    for (const item of items) {
      await addItem(sale.id, item.variantId, item.productId, item.quantity);
      await reserve(sale.id, item.variantId, item.quantity);
    }
    return sale;
  }

  async function inventory(variantId: string, selectedBranchId = branchId) {
    return db.inventory.findUniqueOrThrow({ where: { variantId_branchId: { variantId, branchId: selectedBranchId } } });
  }

  it('requires authentication, SALE_COMPLETE, fresh permission and fresh branch authorization', async () => {
    const sale = await createReservedSale([{ variantId: remeraId, productId: remeraProductId, quantity: 1n }]);
    expect((await request(app).post(`/api/v1/sales/${sale.id}/complete`)).status).toBe(401);

    const role = await db.role.findUniqueOrThrow({ where: { code: 'CASHIER' } });
    const permission = await db.permission.findUniqueOrThrow({ where: { code: 'sale.complete' } });
    await db.rolePermission.delete({ where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } } });
    expect((await complete(sale.id)).status).toBe(403);

    await db.role.update({ where: { id: role.id }, data: { code: 'ADMIN_LOOKALIKE' } });
    expect((await complete(sale.id)).status).toBe(403);

    await db.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
    await db.userBranchRole.updateMany({ where: { userId: cashierId }, data: { branchId: otherBranchId } });
    expect((await complete(sale.id)).status).toBe(403);
  });

  it('returns 404 for an unknown sale and rejects invalid lifecycle states', async () => {
    expect((await complete(randomUUID())).status).toBe(404);
    for (const status of ['DRAFT', 'PENDING_PAYMENT', 'CANCELLED'] as const) {
      const sale = await createSale(status);
      const response = await complete(sale.id);
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('INVALID_SALE_STATE');
    }
  });

  it('finalizes two variants atomically with exact physical/reserved deltas and audit', async () => {
    const sale = await createReservedSale([
      { variantId: remeraId, productId: remeraProductId, quantity: 2n },
      { variantId: jeanId, productId: jeanProductId, quantity: 1n },
    ]);
    const before = { remera: await inventory(remeraId), jean: await inventory(jeanId) };
    const response = await complete(sale.id);
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('COMPLETED');
    expect(await inventory(remeraId)).toMatchObject({ physical: before.remera.physical - 2n, reserved: before.remera.reserved - 2n });
    expect(await inventory(jeanId)).toMatchObject({ physical: before.jean.physical - 1n, reserved: before.jean.reserved - 1n });
    expect(await db.stockReservation.findMany({ where: { saleId: sale.id } })).toEqual([
      expect.objectContaining({ variantId: remeraId, quantity: 2n, status: 'CONSUMED' }),
      expect.objectContaining({ variantId: jeanId, quantity: 1n, status: 'CONSUMED' }),
    ]);
    expect(await db.stockMovement.findMany({ where: { saleId: sale.id }, orderBy: { inventoryId: 'asc' } })).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'SALE', quantityDelta: -2n, saleId: sale.id, userId: cashierId, branchId }),
      expect.objectContaining({ type: 'SALE', quantityDelta: -1n, saleId: sale.id, userId: cashierId, branchId }),
    ]));
    expect(await db.auditLog.count({ where: { action: 'SALE_COMPLETED', entityType: 'Sale', entityId: sale.id } })).toBe(1);
    expect(await db.salePayment.count({ where: { saleId: sale.id } })).toBe(0);
    expect(await db.cashMovement.count()).toBe(0);
    expect(await db.cashSession.count({ where: { status: 'OPEN' } })).toBe(0);
  });

  it('aggregates duplicate SaleItems into one inventory decrement and movement', async () => {
    const sale = await createSale();
    await addItem(sale.id, remeraId, remeraProductId, 1n);
    await addItem(sale.id, remeraId, remeraProductId, 2n);
    await reserve(sale.id, remeraId, 3n);
    const before = await inventory(remeraId);
    expect((await complete(sale.id)).status).toBe(200);
    expect(await inventory(remeraId)).toMatchObject({ physical: before.physical - 3n, reserved: before.reserved - 3n });
    expect(await db.stockMovement.count({ where: { saleId: sale.id } })).toBe(1);
    expect((await db.stockMovement.findFirstOrThrow({ where: { saleId: sale.id } })).quantityDelta).toBe(-3n);
  });

  it('replays COMPLETED safely with no duplicate inventory, reservations, movements or audit', async () => {
    const sale = await createReservedSale([{ variantId: remeraId, productId: remeraProductId, quantity: 2n }]);
    expect((await complete(sale.id)).status).toBe(200);
    const snapshot = {
      inventory: await inventory(remeraId),
      reservations: await db.stockReservation.count({ where: { saleId: sale.id } }),
      movements: await db.stockMovement.count({ where: { saleId: sale.id } }),
      audits: await db.auditLog.count({ where: { action: 'SALE_COMPLETED', entityId: sale.id } }),
    };
    const replay = await complete(sale.id, token, { branchId: otherBranchId });
    expect(replay.status).toBe(200);
    expect(replay.body.status).toBe('COMPLETED');
    expect(await inventory(remeraId)).toEqual(snapshot.inventory);
    expect(await db.stockReservation.count({ where: { saleId: sale.id } })).toBe(snapshot.reservations);
    expect(await db.stockMovement.count({ where: { saleId: sale.id } })).toBe(snapshot.movements);
    expect(await db.auditLog.count({ where: { action: 'SALE_COMPLETED', entityId: sale.id } })).toBe(snapshot.audits);
  });

  it('serializes concurrent completion requests without double finalization', async () => {
    const sale = await createReservedSale([
      { variantId: remeraId, productId: remeraProductId, quantity: 2n },
      { variantId: jeanId, productId: jeanProductId, quantity: 1n },
    ]);
    const [first, second] = await Promise.all([complete(sale.id), complete(sale.id)]);
    expect([first.status, second.status].sort()).toEqual([200, 200]);
    expect(first.body.status).toBe('COMPLETED');
    expect(second.body.status).toBe('COMPLETED');
    expect(await db.stockMovement.count({ where: { saleId: sale.id } })).toBe(2);
    expect(await db.auditLog.count({ where: { action: 'SALE_COMPLETED', entityId: sale.id } })).toBe(1);
    expect((await inventory(remeraId)).physical).toBe(18n);
    expect((await inventory(remeraId)).reserved).toBe(0n);
    expect((await inventory(jeanId)).physical).toBe(19n);
    expect((await inventory(jeanId)).reserved).toBe(0n);
  });

  it.each([
    ['missing inventory', async (saleId: string) => {
      await db.inventory.delete({ where: { variantId_branchId: { variantId: remeraId, branchId } } });
      return saleId;
    }],
    ['insufficient physical', async (saleId: string) => {
      await db.inventory.update({ where: { variantId_branchId: { variantId: remeraId, branchId } }, data: { physical: 0n } });
      return saleId;
    }],
    ['insufficient reserved', async (saleId: string) => {
      await db.inventory.update({ where: { variantId_branchId: { variantId: remeraId, branchId } }, data: { reserved: 0n } });
      return saleId;
    }],
  ])('rejects %s without partial writes', async (_label, mutate) => {
    const sale = await createReservedSale([{ variantId: remeraId, productId: remeraProductId, quantity: 1n }]);
    await mutate(sale.id);
    const response = await complete(sale.id);
    expect(response.status).toBe(409);
    expect((await db.sale.findUniqueOrThrow({ where: { id: sale.id } })).status).toBe('PAID');
    expect(await db.stockMovement.count({ where: { saleId: sale.id } })).toBe(0);
    expect(await db.auditLog.count({ where: { action: 'SALE_COMPLETED', entityId: sale.id } })).toBe(0);
  });

  it('rejects missing, non-active, wrong-branch and mismatched reservations', async () => {
    const cases = [
      async () => { /* no reservation */ },
      async (saleId: string) => { await reserve(saleId, remeraId, 1n, { status: 'RELEASED' }); },
      async (saleId: string) => { await reserve(saleId, remeraId, 1n, { branchId: otherBranchId }); },
      async (saleId: string) => { await reserve(saleId, remeraId, 2n); },
    ];
    for (const prepare of cases) {
      const sale = await createSale();
      await addItem(sale.id, remeraId, remeraProductId, 1n);
      await prepare(sale.id);
      expect((await complete(sale.id)).status).toBe(409);
      expect((await db.sale.findUniqueOrThrow({ where: { id: sale.id } })).status).toBe('PAID');
      expect(await db.stockMovement.count({ where: { saleId: sale.id } })).toBe(0);
      await truncateAllTables(db);
      await seedDemo(db);
      const [cashier, seller, branch, otherBranch, remera, jean] = await Promise.all([
        db.user.findUniqueOrThrow({ where: { email: 'cashier01@demo.local' } }),
        db.user.findUniqueOrThrow({ where: { email: 'seller01@demo.local' } }),
        db.branch.findUniqueOrThrow({ where: { code: 'CEN' } }),
        db.branch.findUniqueOrThrow({ where: { code: 'YB' } }),
        db.productVariant.findUniqueOrThrow({ where: { sku: 'REM-NEG-M' } }),
        db.productVariant.findUniqueOrThrow({ where: { sku: 'JEA-AZU-42' } }),
      ]);
      cashierId = cashier.id; sellerId = seller.id; branchId = branch.id; otherBranchId = otherBranch.id;
      remeraId = remera.id; jeanId = jean.id; remeraProductId = remera.productId; jeanProductId = jean.productId;
      token = await getAuthToken(cashier);
    }
  });

  it('rolls back every completion write when the late audit write fails', async () => {
    const sale = await createReservedSale([
      { variantId: remeraId, productId: remeraProductId, quantity: 2n },
      { variantId: jeanId, productId: jeanProductId, quantity: 1n },
    ]);
    const beforeRemera = await inventory(remeraId);
    const beforeJean = await inventory(jeanId);
    const transaction = db.$transaction.bind(db);
    vi.spyOn(db, '$transaction').mockImplementation(((callback: (tx: Prisma.TransactionClient) => Promise<unknown>, options: object) =>
      transaction(async (tx) => {
        vi.spyOn(tx.auditLog, 'create').mockRejectedValueOnce(new Error('forced completion audit failure'));
        return callback(tx);
      }, options)) as typeof db.$transaction);
    expect((await complete(sale.id)).status).toBe(500);
    vi.restoreAllMocks();
    expect((await db.sale.findUniqueOrThrow({ where: { id: sale.id } })).status).toBe('PAID');
    expect(await inventory(remeraId)).toEqual(beforeRemera);
    expect(await inventory(jeanId)).toEqual(beforeJean);
    expect(await db.stockReservation.findMany({ where: { saleId: sale.id } })).toEqual([
      expect.objectContaining({ status: 'ACTIVE' }), expect.objectContaining({ status: 'ACTIVE' }),
    ]);
    expect(await db.stockMovement.count({ where: { saleId: sale.id } })).toBe(0);
    expect(await db.auditLog.count({ where: { action: 'SALE_COMPLETED', entityId: sale.id } })).toBe(0);
  });
});
