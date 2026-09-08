import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedDemo } from '../../prisma/seed.js';
import { createApp } from '../../src/app.js';
import { PERMISSIONS } from '../../src/shared/permissions.js';
import { createTestPrismaClient, truncateAllTables } from '../helpers/test-db.js';
import { getAuthToken } from '../helpers/auth.js';

describe('products read API', () => {
  let prisma: Awaited<ReturnType<typeof createTestPrismaClient>>;
  let app: ReturnType<typeof createApp>;
  let sellerToken: string;

  beforeAll(async () => {
    prisma = await createTestPrismaClient();
    app = createApp(prisma);
  });
  beforeEach(async () => {
    await truncateAllTables(prisma);
    await seedDemo(prisma);
    const seller = await prisma.user.findUniqueOrThrow({
      where: { email: 'seller01@demo.local' },
      select: { id: true },
    });
    sellerToken = await getAuthToken(seller);
  });
  afterAll(async () => prisma.$disconnect());

  it('requires authentication and inventory permission', async () => {
    expect((await request(app).get('/api/v1/products')).status).toBe(401);
    const permission = await prisma.permission.findUniqueOrThrow({
      where: { code: PERMISSIONS.INVENTORY_VIEW },
      select: { id: true },
    });
    const role = await prisma.role.findUniqueOrThrow({
      where: { code: 'SELLER' },
      select: { id: true },
    });
    await prisma.rolePermission.delete({
      where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } },
    });
    expect(
      (
        await request(app)
          .get('/api/v1/products')
          .set('Authorization', `Bearer ${sellerToken}`)
      ).status,
    ).toBe(403);
  });

  it('lists active products with pagination and name/SKU/barcode search', async () => {
    const page = await request(app)
      .get('/api/v1/products?page=1&limit=2')
      .set('Authorization', `Bearer ${sellerToken}`);
    expect(page.status).toBe(200);
    expect(page.body.items).toHaveLength(2);
    expect(page.body.pagination).toEqual({ page: 1, limit: 2, total: 3 });

    for (const search of ['Remera Básica', 'REM-NEG-M', 'DEMO-REM-NEG-M']) {
      const response = await request(app)
        .get('/api/v1/products')
        .query({ search })
        .set('Authorization', `Bearer ${sellerToken}`);
      expect(response.status).toBe(200);
      expect(response.body.items.map((item: { name: string }) => item.name)).toContain(
        'Remera Básica',
      );
    }
  });

  it('returns product detail with category, brand, variants and authorized inventory', async () => {
    const product = await prisma.product.findUniqueOrThrow({
      where: { slug: 'remera-basica' },
      select: { id: true },
    });
    const response = await request(app)
      .get(`/api/v1/products/${product.id}`)
      .set('Authorization', `Bearer ${sellerToken}`);
    expect(response.status).toBe(200);
    expect(response.body.product.category.name).toBe('Indumentaria');
    expect(response.body.product.brand.name).toBe('Mona Jacinta');
    expect(response.body.product.variants).toHaveLength(2);
    expect(response.body.product.variants[0]).not.toHaveProperty('costPrice');
    expect(response.body.product.variants[0].inventory).toHaveLength(1);
    expect(response.body.product.variants[0].inventory[0].physical).toEqual('20');
  });

  it('returns 404 for an unknown product and 400 for malformed UUID', async () => {
    const unknown = await request(app)
      .get('/api/v1/products/00000000-0000-4000-8000-000000000099')
      .set('Authorization', `Bearer ${sellerToken}`);
    const malformed = await request(app)
      .get('/api/v1/products/not-a-uuid')
      .set('Authorization', `Bearer ${sellerToken}`);
    expect(unknown.status).toBe(404);
    expect(malformed.status).toBe(400);
  });
});