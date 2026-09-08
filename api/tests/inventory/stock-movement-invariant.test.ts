import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedDemo } from '../../prisma/seed.js';
import { createApp } from '../../src/app.js';
import type { Prisma, PrismaClient } from '../../src/generated/prisma/client.js';
import { createTestPrismaClient, truncateAllTables } from '../helpers/test-db.js';
import { getAuthToken } from '../helpers/auth.js';

describe('StockMovement represents physical inventory changes only', () => {
  let db: PrismaClient;
  let app: ReturnType<typeof createApp>;
  let sellerId: string;
  let cashierId: string;
  let branchId: string;
  let otherBranchId: string;
  let sellerToken: string;
  let cashierToken: string;
  let remeraId: string;
  let jeanId: string;
  let remeraProductId: string;
  let jeanProductId: string;

  beforeAll(async () => {
    db = await createTestPrismaClient();
    app = createApp(db);
  }, 120000);

  beforeEach(async () => {
    await truncateAllTables(db);
    await seedDemo(db);
    const [seller, cashier, branch, otherBranch, remera, jean] = await Promise.all([
      db.user.findUniqueOrThrow({ where: { email: 'seller01@demo.local' } }),
      db.user.findUniqueOrThrow({ where: { email: 'cashier01@demo.local' } }),
      db.branch.findUniqueOrThrow({ where: { code: 'CEN' } }),
      db.branch.findUniqueOrThrow({ where: { code: 'YB' } }),
      db.productVariant.findUniqueOrThrow({ where: { sku: 'REM-NEG-M' } }),
      db.productVariant.findUniqueOrThrow({ where: { sku: 'JEA-AZU-42' } }),
    ]);
    sellerId = seller.id;
    cashierId = cashier.id;
    branchId = branch.id;
    otherBranchId = otherBranch.id;
    sellerToken = await getAuthToken(seller);
    cashierToken = await getAuthToken(cashier);
    remeraId = remera.id;
    jeanId = jean.id;
    remeraProductId = remera.productId;
    jeanProductId = jean.productId;
  }, 120000);

  afterAll(async () => { await db?.$disconnect(); }, 120000);

  function sendToCashier(saleId: string) {
    return request(app)
      .post(`/api/v1/sales/${saleId}/send-to-cashier`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({});
  }

  function complete(saleId: string) {
    return request(app)
      .post(`/api/v1/sales/${saleId}/complete`)
      .set('Authorization', `Bearer ${cashierToken}`)
      .send({});
  }

  async function createDraftSale() {
    const response = await request(app)
      .post('/api/v1/sales')
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ branchId });
    expect(response.status).toBe(201);
    return response.body.id as string;
  }

  async function addItem(saleId: string, variantId: string, quantity: number) {
    const response = await request(app)
      .post(`/api/v1/sales/${saleId}/items`)
      .set('Authorization', `Bearer ${sellerToken}`)
      .send({ variantId, quantity });
    expect(response.status).toBe(200);
  }

  async function inventory(variantId: string) {
    return db.inventory.findUniqueOrThrow({ where: { variantId_branchId: { variantId, branchId } } });
  }

  async function createPaidSale(items: Array<{ variantId: string; productId: string; quantity: bigint }>) {
    const total = items.reduce((sum, item) => sum + item.quantity, 0n);
    const sale = await db.sale.create({ data: {
      sellerId, branchId, status: 'PAID', subtotal: total, total,
    } });
    for (const item of items) {
      const variant = await db.productVariant.findUniqueOrThrow({ where: { id: item.variantId } });
      await db.saleItem.create({ data: {
        saleId: sale.id, variantId: item.variantId, productId: item.productId,
        productName: 'Snapshot product', variantName: 'Snapshot variant', sku: variant.sku,
        quantity: item.quantity, unitPrice: variant.price, subtotal: item.quantity * variant.price,
      } });
      await db.inventory.update({
        where: { variantId_branchId: { variantId: item.variantId, branchId } },
        data: { reserved: { increment: item.quantity } },
      });
      await db.stockReservation.create({ data: {
        saleId: sale.id, variantId: item.variantId, branchId,
        quantity: item.quantity, status: 'ACTIVE',
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      } });
    }
    return sale;
  }

  async function movementTotal(saleId: string, inventoryId: string) {
    const movements = await db.stockMovement.findMany({ where: { saleId, inventoryId }, select: { quantityDelta: true } });
    return movements.reduce((sum, movement) => sum + movement.quantityDelta, 0n);
  }

  it('reservation changes reserved only and creates no StockMovement', async () => {
    const saleId = await createDraftSale();
    await addItem(saleId, remeraId, 2);
    const before = await inventory(remeraId);
    const movementCount = await db.stockMovement.count();
    expect((await sendToCashier(saleId)).status).toBe(200);
    const after = await inventory(remeraId);
    expect(after.physical).toBe(before.physical);
    expect(after.reserved).toBe(before.reserved + 2n);
    expect(await db.stockMovement.count()).toBe(movementCount);
    expect(await db.stockMovement.count({ where: { type: 'SALE' } })).toBe(0);
    expect(await db.stockReservation.count({ where: { saleId, status: 'ACTIVE' } })).toBe(1);
  });

  it('multi-variant reservation keeps physical stock unchanged and movements at zero', async () => {
    const saleId = await createDraftSale();
    await addItem(saleId, remeraId, 2);
    await addItem(saleId, jeanId, 1);
    const before = { remera: await inventory(remeraId), jean: await inventory(jeanId) };
    expect((await sendToCashier(saleId)).status).toBe(200);
    expect(await inventory(remeraId)).toMatchObject({ physical: before.remera.physical, reserved: before.remera.reserved + 2n });
    expect(await inventory(jeanId)).toMatchObject({ physical: before.jean.physical, reserved: before.jean.reserved + 1n });
    expect(await db.stockMovement.count()).toBe(0);
  });

  it('completion creates one negative SALE movement per affected inventory and matches physical deltas', async () => {
    const sale = await createPaidSale([
      { variantId: remeraId, productId: remeraProductId, quantity: 2n },
      { variantId: jeanId, productId: jeanProductId, quantity: 1n },
    ]);
    const before = { remera: await inventory(remeraId), jean: await inventory(jeanId) };
    const response = await complete(sale.id);
    expect(response.status).toBe(200);
    expect(await db.stockMovement.count({ where: { saleId: sale.id } })).toBe(2);
    const movements = await db.stockMovement.findMany({ where: { saleId: sale.id } });
    expect(movements).toEqual(expect.arrayContaining([
      expect.objectContaining({ inventoryId: before.remera.id, type: 'SALE', quantityDelta: -2n, saleId: sale.id, userId: cashierId, branchId }),
      expect.objectContaining({ inventoryId: before.jean.id, type: 'SALE', quantityDelta: -1n, saleId: sale.id, userId: cashierId, branchId }),
    ]));
    for (const movement of movements) {
      expect(movement.timestamp).toBeInstanceOf(Date);
    }
    const afterRemera = await inventory(remeraId);
    const afterJean = await inventory(jeanId);
    expect(afterRemera.physical - before.remera.physical).toBe(await movementTotal(sale.id, before.remera.id));
    expect(afterJean.physical - before.jean.physical).toBe(await movementTotal(sale.id, before.jean.id));
    expect(afterRemera).toMatchObject({ physical: 18n, reserved: 0n });
    expect(afterJean).toMatchObject({ physical: 19n, reserved: 0n });
    expect(await db.stockReservation.count({ where: { saleId: sale.id, status: 'CONSUMED' } })).toBe(2);
  });

  it('aggregates duplicate SaleItems into one physical delta and movement', async () => {
    const sale = await db.sale.create({ data: { sellerId, branchId, status: 'PAID', subtotal: 3n, total: 3n } });
    const variant = await db.productVariant.findUniqueOrThrow({ where: { id: remeraId } });
    await db.saleItem.createMany({ data: [1n, 2n].map((quantity) => ({
      saleId: sale.id, variantId: remeraId, productId: remeraProductId,
      productName: 'Snapshot', variantName: 'Snapshot', sku: variant.sku,
      quantity, unitPrice: variant.price, subtotal: quantity * variant.price,
    })) });
    await db.inventory.update({ where: { variantId_branchId: { variantId: remeraId, branchId } }, data: { reserved: 3n } });
    await db.stockReservation.create({ data: {
      saleId: sale.id, variantId: remeraId, branchId, quantity: 3n,
      status: 'ACTIVE', expiresAt: new Date(Date.now() + 1800000),
    } });
    const before = await inventory(remeraId);
    expect((await complete(sale.id)).status).toBe(200);
    const after = await inventory(remeraId);
    expect(after.physical).toBe(before.physical - 3n);
    expect(await db.stockMovement.count({ where: { saleId: sale.id } })).toBe(1);
    expect((await db.stockMovement.findFirstOrThrow({ where: { saleId: sale.id } })).quantityDelta).toBe(-3n);
  });

  it('completed replay does not create additional movements or physical changes', async () => {
    const sale = await createPaidSale([{ variantId: remeraId, productId: remeraProductId, quantity: 2n }]);
    expect((await complete(sale.id)).status).toBe(200);
    const before = { inventory: await inventory(remeraId), ids: (await db.stockMovement.findMany({ where: { saleId: sale.id }, select: { id: true } })).map(({ id }) => id) };
    expect((await complete(sale.id)).status).toBe(200);
    expect(await inventory(remeraId)).toEqual(before.inventory);
    expect((await db.stockMovement.findMany({ where: { saleId: sale.id }, select: { id: true } })).map(({ id }) => id)).toEqual(before.ids);
    expect(await db.auditLog.count({ where: { action: 'SALE_COMPLETED', entityId: sale.id } })).toBe(1);
  });

  it('concurrent completion creates exactly one movement set', async () => {
    const sale = await createPaidSale([
      { variantId: remeraId, productId: remeraProductId, quantity: 2n },
      { variantId: jeanId, productId: jeanProductId, quantity: 1n },
    ]);
    const [first, second] = await Promise.all([complete(sale.id), complete(sale.id)]);
    expect([first.status, second.status].sort()).toEqual([200, 200]);
    expect(await db.stockMovement.count({ where: { saleId: sale.id } })).toBe(2);
    expect(await db.stockMovement.aggregate({ where: { saleId: sale.id }, _sum: { quantityDelta: true } })).toEqual({ _sum: { quantityDelta: -3n } });
    expect(await db.auditLog.count({ where: { action: 'SALE_COMPLETED', entityId: sale.id } })).toBe(1);
  });

  it('failed completion creates no movement and preserves physical inventory', async () => {
    const sale = await createPaidSale([{ variantId: remeraId, productId: remeraProductId, quantity: 1n }]);
    await db.inventory.update({ where: { variantId_branchId: { variantId: remeraId, branchId } }, data: { reserved: 0n } });
    const before = await inventory(remeraId);
    const response = await complete(sale.id);
    expect(response.status).toBe(409);
    expect(await inventory(remeraId)).toEqual(before);
    expect(await db.stockMovement.count({ where: { saleId: sale.id } })).toBe(0);
    expect((await db.sale.findUniqueOrThrow({ where: { id: sale.id } })).status).toBe('PAID');
  });

  it('late transaction failure rolls back movements with all finalization writes', async () => {
    const sale = await createPaidSale([{ variantId: remeraId, productId: remeraProductId, quantity: 2n }]);
    const before = await inventory(remeraId);
    const transaction = db.$transaction.bind(db);
    vi.spyOn(db, '$transaction').mockImplementation(((callback: (tx: Prisma.TransactionClient) => Promise<unknown>, options: object) =>
      transaction(async (tx) => {
        vi.spyOn(tx.auditLog, 'create').mockRejectedValueOnce(new Error('forced audit failure'));
        return callback(tx);
      }, options)) as typeof db.$transaction);
    expect((await complete(sale.id)).status).toBe(500);
    vi.restoreAllMocks();
    expect(await inventory(remeraId)).toEqual(before);
    expect(await db.stockMovement.count({ where: { saleId: sale.id } })).toBe(0);
    expect(await db.stockReservation.count({ where: { saleId: sale.id, status: 'ACTIVE' } })).toBe(1);
    expect((await db.sale.findUniqueOrThrow({ where: { id: sale.id } })).status).toBe('PAID');
  });

  it('keeps financial and cash side effects outside physical movement finalization', async () => {
    const sale = await createPaidSale([{ variantId: remeraId, productId: remeraProductId, quantity: 1n }]);
    expect((await complete(sale.id)).status).toBe(200);
    expect(await db.salePayment.count({ where: { saleId: sale.id } })).toBe(0);
    expect(await db.cashMovement.count()).toBe(0);
    expect(await db.cashSession.count()).toBe(0);
    expect(await db.stockMovement.count({ where: { saleId: sale.id } })).toBe(1);
  });

  it('does not accept a client branch override for completion', async () => {
    const sale = await createPaidSale([{ variantId: remeraId, productId: remeraProductId, quantity: 1n }]);
    const response = await complete(sale.id);
    expect(response.status).toBe(200);
    expect((await db.stockMovement.findFirstOrThrow({ where: { saleId: sale.id } })).branchId).toBe(branchId);
    expect(otherBranchId).not.toBe(branchId);
  });
});
