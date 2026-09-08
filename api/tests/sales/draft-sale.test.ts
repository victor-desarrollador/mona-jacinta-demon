import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedDemo } from '../../prisma/seed.js';
import { createApp } from '../../src/app.js';
import { createTestPrismaClient, truncateAllTables } from '../helpers/test-db.js';
import { getAuthToken } from '../helpers/auth.js';

describe('seller draft sales', () => {
  let prisma: Awaited<ReturnType<typeof createTestPrismaClient>>;
  let app: ReturnType<typeof createApp>;
  let token: string;
  let otherSellerToken: string;
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
    const [seller, otherSeller, centro, yerba, remera, jean] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { email: 'seller01@demo.local' } }),
      prisma.user.create({ data: { name: 'other-seller', email: 'other@test.local', passwordHash: 'test' } }),
      prisma.branch.findUniqueOrThrow({ where: { code: 'CEN' } }),
      prisma.branch.findUniqueOrThrow({ where: { code: 'YB' } }),
      prisma.productVariant.findUniqueOrThrow({ where: { sku: 'REM-NEG-M' } }),
      prisma.productVariant.findUniqueOrThrow({ where: { sku: 'JEA-AZU-42' } }),
    ]);
    const sellerRole = await prisma.role.findUniqueOrThrow({ where: { code: 'SELLER' } });
    await prisma.userBranchRole.create({ data: { userId: otherSeller.id, branchId: centro.id, roleId: sellerRole.id } });
    token = await getAuthToken(seller);
    otherSellerToken = await getAuthToken(otherSeller);
    centroId = centro.id;
    yerbaId = yerba.id;
    remeraId = remera.id;
    jeanId = jean.id;
  });

  afterAll(async () => prisma.$disconnect());

  const postSale = (body: Record<string, unknown> = {}) =>
    request(app).post('/api/v1/sales').set('Authorization', `Bearer ${token}`).send(body);

  it('requires authentication and SALE_CREATE', async () => {
    expect((await request(app).post('/api/v1/sales').send({})).status).toBe(401);
    const permission = await prisma.permission.findUniqueOrThrow({ where: { code: 'sale.create' } });
    const role = await prisma.role.findUniqueOrThrow({ where: { code: 'SELLER' } });
    await prisma.rolePermission.delete({ where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } } });
    expect((await postSale()).status).toBe(403);
  });

  it('creates a draft with server identity and null sale number', async () => {
    const response = await postSale({ branchId: centroId });
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ status: 'DRAFT', saleNumber: null, subtotal: '0', discountTotal: '0', total: '0' });
    const seller = await prisma.user.findUniqueOrThrow({ where: { email: 'seller01@demo.local' } });
    expect(response.body.sellerId).toBe(seller.id);
    expect((await postSale({ sellerId: 'client-controlled', branchId: centroId })).status).toBe(400);
  });

  it('rejects a branch outside the seller assignment', async () => {
    expect((await postSale({ branchId: yerbaId })).status).toBe(403);
  });

  it('adds and merges items, recalculates totals, and keeps inventory unchanged', async () => {
    const sale = await postSale();
    const saleId = sale.body.id;
    const addRemera = () => request(app).post(`/api/v1/sales/${saleId}/items`).set('Authorization', `Bearer ${token}`).send({ variantId: remeraId, quantity: 1 });
    expect((await addRemera()).status).toBe(200);
    expect((await addRemera()).body.total).toBe('9000000');
    const final = await request(app).post(`/api/v1/sales/${saleId}/items`).set('Authorization', `Bearer ${token}`).send({ variantId: jeanId, quantity: 1 });
    expect(final.body.total).toBe('16500000');
    expect(final.body.items).toHaveLength(2);
    expect(final.body.items.find((item: { variantId: string }) => item.variantId === remeraId).quantity).toBe('2');
    const inventory = await prisma.inventory.findMany({ where: { branchId: centroId, variantId: { in: [remeraId, jeanId] } } });
    expect(inventory).toEqual(expect.arrayContaining([
      expect.objectContaining({ physical: 20n, reserved: 0n }),
      expect.objectContaining({ physical: 20n, reserved: 0n }),
    ]));
  });

  it('rejects inactive, unknown, and insufficient variants', async () => {
    const sale = await postSale();
    const path = `/api/v1/sales/${sale.body.id}/items`;
    expect((await request(app).post(path).set('Authorization', `Bearer ${token}`).send({ variantId: remeraId, quantity: 21 })).status).toBe(409);
    expect((await request(app).post(path).set('Authorization', `Bearer ${token}`).send({ variantId: '00000000-0000-4000-8000-000000000001', quantity: 1 })).status).toBe(404);
    await prisma.productVariant.update({ where: { id: remeraId }, data: { isActive: false } });
    expect((await request(app).post(path).set('Authorization', `Bearer ${token}`).send({ variantId: remeraId, quantity: 1 })).status).toBe(404);
  });

  it('updates and removes items, and protects another seller draft', async () => {
    const sale = await postSale();
    const added = await request(app).post(`/api/v1/sales/${sale.body.id}/items`).set('Authorization', `Bearer ${token}`).send({ variantId: remeraId, quantity: 2 });
    const itemId = added.body.items[0].id;
    const updated = await request(app).patch(`/api/v1/sales/${sale.body.id}/items/${itemId}`).set('Authorization', `Bearer ${token}`).send({ quantity: 3 });
    expect(updated.body.total).toBe('13500000');
    expect((await request(app).patch(`/api/v1/sales/${sale.body.id}/items/${itemId}`).set('Authorization', `Bearer ${token}`).send({ quantity: 21 })).status).toBe(409);
    const removed = await request(app).delete(`/api/v1/sales/${sale.body.id}/items/${itemId}`).set('Authorization', `Bearer ${token}`);
    expect(removed.body.total).toBe('0');
    const otherSale = await request(app).post('/api/v1/sales').set('Authorization', `Bearer ${otherSellerToken}`).send({ branchId: centroId });
    expect((await request(app).post(`/api/v1/sales/${otherSale.body.id}/items`).set('Authorization', `Bearer ${token}`).send({ variantId: remeraId, quantity: 1 })).status).toBe(403);
    expect((await request(app).get(`/api/v1/sales/${otherSale.body.id}`).set('Authorization', `Bearer ${token}`)).status).toBe(403);
  });

  it('rejects access to a draft in another branch', async () => {
    const admin = await prisma.user.findUniqueOrThrow({ where: { email: 'admin@demo.local' } });
    const otherSale = await prisma.sale.create({ data: { sellerId: admin.id, branchId: yerbaId, status: 'DRAFT' } });
    expect((await request(app).get(`/api/v1/sales/${otherSale.id}`).set('Authorization', `Bearer ${token}`)).status).toBe(403);
  });

  it('returns only accessible seller drafts with item details and string money', async () => {
    const sale = await postSale();
    await request(app).post(`/api/v1/sales/${sale.body.id}/items`).set('Authorization', `Bearer ${token}`).send({ variantId: remeraId, quantity: 2 });
    const fetched = await request(app).get(`/api/v1/sales/${sale.body.id}`).set('Authorization', `Bearer ${token}`);
    expect(fetched.body.items[0].variant.product.name).toBe('Remera Básica');
    expect(fetched.body.items[0].unitPrice).toBe('4500000');
    expect(fetched.body.total).toBe('9000000');
    const list = await request(app).get('/api/v1/sales').set('Authorization', `Bearer ${token}`);
    expect(list.body.items.map((item: { id: string }) => item.id)).toContain(sale.body.id);
    expect(list.body.items.every((item: { sellerId: string }) => item.sellerId === sale.body.sellerId)).toBe(true);
  });
});