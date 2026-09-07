import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedDemo } from '../../prisma/seed.js';
import { createApp } from '../../src/app.js';
import { createTestPrismaClient, truncateAllTables } from '../helpers/test-db.js';
import { getAuthToken } from '../helpers/auth.js';

describe('POST /api/v1/sales/:saleId/send-to-cashier', () => {
  let prisma: Awaited<ReturnType<typeof createTestPrismaClient>>;
  let app: ReturnType<typeof createApp>;
  let sellerToken: string;
  let otherSellerToken: string;
  let sellerId: string;
  let otherSellerId: string;
  let centroId: string;
  let yerbaId: string;
  let remeraId: string;
  let jeanId: string;

  beforeAll(async () => {
    prisma = await createTestPrismaClient();
    app = createApp(prisma);
  });

  beforeEach(async () => {
    await truncateAllTables(prisma);
    await seedDemo(prisma);
    const [seller, centro, yerba, remera, jean] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { email: 'seller01@demo.local' } }),
      prisma.branch.findUniqueOrThrow({ where: { code: 'CEN' } }),
      prisma.branch.findUniqueOrThrow({ where: { code: 'YB' } }),
      prisma.productVariant.findUniqueOrThrow({ where: { sku: 'REM-NEG-M' } }),
      prisma.productVariant.findUniqueOrThrow({ where: { sku: 'JEA-AZU-42' } }),
    ]);
    const otherSeller = await prisma.user.create({
      data: { name: 'other-seller', email: 'other@test.local', passwordHash: 'test' },
    });
    const sellerRole = await prisma.role.findUniqueOrThrow({ where: { code: 'SELLER' } });
    await prisma.userBranchRole.create({ data: { userId: otherSeller.id, branchId: centro.id, roleId: sellerRole.id } });
    sellerId = seller.id;
    otherSellerId = otherSeller.id;
    sellerToken = await getAuthToken(seller);
    otherSellerToken = await getAuthToken(otherSeller);
    centroId = centro.id;
    yerbaId = yerba.id;
    remeraId = remera.id;
    jeanId = jean.id;
  });

  afterAll(async () => prisma.$disconnect());

  async function createSale(token = sellerToken, branchId = centroId) {
    const response = await request(app)
      .post('/api/v1/sales')
      .set('Authorization', `Bearer ${token}`)
      .send({ branchId });
    expect(response.status).toBe(201);
    return response.body.id as string;
  }

  async function addItem(saleId: string, variantId: string, quantity: number, token = sellerToken) {
    const response = await request(app)
      .post(`/api/v1/sales/${saleId}/items`)
      .set('Authorization', `Bearer ${token}`)
      .send({ variantId, quantity });
    expect(response.status).toBe(200);
  }

  async function send(saleId: string, token = sellerToken) {
    return request(app)
      .post(`/api/v1/sales/${saleId}/send-to-cashier`)
      .set('Authorization', `Bearer ${token}`)
      .send({ branchId: yerbaId, saleNumber: 'CLIENT-CONTROLLED' });
  }

  it('requires authentication and SALE_CREATE', async () => {
    const saleId = await createSale();
    expect((await request(app).post(`/api/v1/sales/${saleId}/send-to-cashier`)).status).toBe(401);
    const permission = await prisma.permission.findUniqueOrThrow({ where: { code: 'sale.create' } });
    const role = await prisma.role.findUniqueOrThrow({ where: { code: 'SELLER' } });
    await prisma.rolePermission.delete({ where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } } });
    expect((await send(saleId)).status).toBe(403);
  });

  it('enforces seller ownership and persisted branch access', async () => {
    const saleId = await createSale();
    await addItem(saleId, remeraId, 1);
    expect((await send(saleId, otherSellerToken)).status).toBe(403);
    const crossBranchSale = await prisma.sale.create({ data: { sellerId, branchId: yerbaId } });
    await prisma.saleItem.create({
      data: {
        saleId: crossBranchSale.id,
        variantId: remeraId,
        productId: (await prisma.productVariant.findUniqueOrThrow({ where: { id: remeraId } })).productId,
        productName: 'Remera Básica',
        variantName: 'Negro / M',
        sku: 'REM-NEG-M',
        quantity: 1n,
        unitPrice: 4500000n,
        subtotal: 4500000n,
      },
    });
    expect((await send(crossBranchSale.id)).status).toBe(403);
    expect(sellerId).not.toBe(otherSellerId);
  });

  it('reserves aggregated variants, allocates CEN-V-000001, and keeps physical stock unchanged', async () => {
    const saleId = await createSale();
    await addItem(saleId, remeraId, 2);
    await addItem(saleId, jeanId, 1);
    const response = await send(saleId);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'PENDING_PAYMENT', saleNumber: 'CEN-V-000001', total: '16500000' });

    const sale = await prisma.sale.findUniqueOrThrow({ where: { id: saleId } });
    const reservations = await prisma.stockReservation.findMany({ where: { saleId }, orderBy: { variantId: 'asc' } });
    const inventory = await prisma.inventory.findMany({ where: { branchId: centroId, variantId: { in: [remeraId, jeanId] } } });
    const counter = await prisma.saleNumberCounter.findUniqueOrThrow({ where: { branchId: centroId } });
    expect(sale).toMatchObject({ status: 'PENDING_PAYMENT', saleNumber: 'CEN-V-000001', subtotal: 16500000n, total: 16500000n });
    expect(reservations).toHaveLength(2);
    expect(reservations.every((reservation) => reservation.status === 'ACTIVE')).toBe(true);
    expect(new Map(reservations.map((reservation) => [reservation.variantId, reservation.quantity]))).toEqual(new Map([[remeraId, 2n], [jeanId, 1n]]));
    expect(inventory).toEqual(expect.arrayContaining([
      expect.objectContaining({ variantId: remeraId, physical: 20n, reserved: 2n }),
      expect.objectContaining({ variantId: jeanId, physical: 20n, reserved: 1n }),
    ]));
    expect(counter.nextValue).toBe(2n);
    expect(await prisma.stockMovement.count()).toBe(0);
    expect(await prisma.auditLog.count({ where: { entityId: saleId, action: 'SALE_SENT_TO_CASHIER' } })).toBe(1);
  });

  it('aggregates duplicate persisted SaleItems before creating one reservation', async () => {
    const sale = await prisma.sale.create({ data: { sellerId, branchId: centroId } });
    const variant = await prisma.productVariant.findUniqueOrThrow({ where: { id: remeraId }, include: { product: true } });
    await prisma.saleItem.createMany({
      data: [1n, 2n].map((quantity) => ({
        saleId: sale.id, variantId: remeraId, productId: variant.productId,
        productName: variant.product.name, variantName: 'Negro / M', sku: variant.sku,
        quantity, unitPrice: variant.price, subtotal: quantity * variant.price,
      })),
    });
    expect((await send(sale.id)).status).toBe(200);
    expect(await prisma.stockReservation.findMany({ where: { saleId: sale.id } })).toEqual([
      expect.objectContaining({ variantId: remeraId, quantity: 3n, status: 'ACTIVE' }),
    ]);
    expect((await prisma.inventory.findUniqueOrThrow({ where: { variantId_branchId: { variantId: remeraId, branchId: centroId } } })).reserved).toBe(3n);
  });

  it('rejects empty and non-draft sales', async () => {
    const emptySale = await createSale();
    expect((await send(emptySale)).status).toBe(409);
    await prisma.sale.update({ where: { id: emptySale }, data: { status: 'PENDING_PAYMENT' } });
    expect((await send(emptySale)).status).toBe(409);
  });

  it('rolls back all state when a later item is insufficient', async () => {
    const saleId = await createSale();
    await addItem(saleId, remeraId, 2);
    await addItem(saleId, jeanId, 1);
    await prisma.inventory.update({ where: { variantId_branchId: { variantId: jeanId, branchId: centroId } }, data: { physical: 0n } });
    const beforeCounter = await prisma.saleNumberCounter.findUniqueOrThrow({ where: { branchId: centroId } });
    expect((await send(saleId)).status).toBe(409);
    const sale = await prisma.sale.findUniqueOrThrow({ where: { id: saleId } });
    const inventory = await prisma.inventory.findMany({ where: { branchId: centroId, variantId: { in: [remeraId, jeanId] } } });
    expect(sale).toMatchObject({ status: 'DRAFT', saleNumber: null });
    expect(await prisma.stockReservation.count()).toBe(0);
    expect(await prisma.saleNumberCounter.findUniqueOrThrow({ where: { branchId: centroId } })).toMatchObject({ id: beforeCounter.id, nextValue: 1n });
    expect(inventory).toEqual(expect.arrayContaining([
      expect.objectContaining({ variantId: remeraId, physical: 20n, reserved: 0n }),
      expect.objectContaining({ variantId: jeanId, physical: 0n, reserved: 0n }),
    ]));
  });

  it('rolls back when branch inventory is missing', async () => {
    const saleId = await createSale();
    await addItem(saleId, remeraId, 1);
    await prisma.inventory.delete({ where: { variantId_branchId: { variantId: remeraId, branchId: centroId } } });
    expect((await send(saleId)).status).toBe(409);
    expect(await prisma.stockReservation.count()).toBe(0);
    expect(await prisma.sale.findUniqueOrThrow({ where: { id: saleId } })).toMatchObject({ status: 'DRAFT', saleNumber: null });
    expect((await prisma.saleNumberCounter.findUniqueOrThrow({ where: { branchId: centroId } })).nextValue).toBe(1n);
  });

  it('allows only one concurrent send for the same sale', async () => {
    const saleId = await createSale();
    await addItem(saleId, remeraId, 1);
    const responses = await Promise.all([send(saleId), send(saleId)]);
    expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 409)).toHaveLength(1);
    expect(await prisma.stockReservation.count({ where: { saleId } })).toBe(1);
    expect((await prisma.inventory.findUniqueOrThrow({ where: { variantId_branchId: { variantId: remeraId, branchId: centroId } } })).reserved).toBe(1n);
    expect((await prisma.saleNumberCounter.findUniqueOrThrow({ where: { branchId: centroId } })).nextValue).toBe(2n);
  });

  it('prevents competing sales from over-reserving the same stock', async () => {
    await prisma.inventory.update({ where: { variantId_branchId: { variantId: remeraId, branchId: centroId } }, data: { physical: 2n, reserved: 0n } });
    const firstSale = await createSale();
    const secondSale = await createSale();
    await addItem(firstSale, remeraId, 2);
    await addItem(secondSale, remeraId, 2);
    const responses = await Promise.all([send(firstSale), send(secondSale)]);
    expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 409)).toHaveLength(1);
    const inventory = await prisma.inventory.findUniqueOrThrow({ where: { variantId_branchId: { variantId: remeraId, branchId: centroId } } });
    expect(inventory).toMatchObject({ physical: 2n, reserved: 2n });
    expect(await prisma.sale.count({ where: { status: 'PENDING_PAYMENT' } })).toBe(1);
  });
});