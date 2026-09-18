import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedDemo } from '../../prisma/seed.js';
import { createApp } from '../../src/app.js';
import { PRODUCTION_PERMISSIONS } from '../../src/modules/rbac/permissions.js';
import { createTestPrismaClient, truncateAllTables } from '../helpers/test-db.js';
import { getAuthToken, createTestUser } from '../helpers/auth.js';
import { createRole } from '../helpers/factories.js';

describe('products read API', () => {
  let prisma: Awaited<ReturnType<typeof createTestPrismaClient>>;
  let app: ReturnType<typeof createApp>;
  let sellerToken: string;
  let centroId: string;

  beforeAll(async () => {
    prisma = await createTestPrismaClient();
    app = createApp(prisma);
  });
  beforeEach(async () => {
    await truncateAllTables(prisma);
    await seedDemo(prisma);
    const [seller, centro] = await Promise.all([
      prisma.user.findUniqueOrThrow({
        where: { email: 'seller01@demo.local' },
        select: { id: true },
      }),
      prisma.branch.findUniqueOrThrow({ where: { code: 'CEN' }, select: { id: true } }),
    ]);
    sellerToken = await getAuthToken(seller);
    centroId = centro.id;
  });
  afterAll(async () => prisma.$disconnect());

  it('requires authentication and the Production INVENTORY_VIEW permission', async () => {
    expect((await request(app).get('/api/v1/products')).status).toBe(401);
    // Phase 1D.3.4 SWITCH: /products now gates on the Production
    // INVENTORY_VIEW grant (req.auth.assignments), not the legacy
    // inventory.view code — revoke the Production grant to prove that is the
    // real, live decision.
    const permission = await prisma.permission.findUniqueOrThrow({
      where: { code: PRODUCTION_PERMISSIONS.INVENTORY_VIEW },
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

  it('authorizes global product read via the Production INVENTORY_VIEW grant alone', async () => {
    const sellerRole = await prisma.role.findUniqueOrThrow({ where: { code: 'SELLER' } });
    const user = await createTestUser(prisma, sellerRole.id, centroId);
    const isolatedToken = await getAuthToken(user);
    const response = await request(app).get('/api/v1/products').set('Authorization', `Bearer ${isolatedToken}`);
    expect(response.status).toBe(200);
  });

  it('a bare COMPANY-scoped OWNER passes the global INVENTORY_VIEW product-catalog gate', async () => {
    const ownerRole = await prisma.role.findUniqueOrThrow({
      where: { code: 'OWNER' },
    });

    const owner = await prisma.user.create({
      data: {
        name: 'owner-products',
        email: 'owner-products@test.local',
        passwordHash: 'x',
      },
    });

    await prisma.userRoleScope.create({
      data: {
        userId: owner.id,
        roleId: ownerRole.id,
        scopeKind: 'COMPANY',
        locationId: null,
      },
    });

    const ownerToken = await getAuthToken(owner);

    const response = await request(app)
      .get('/api/v1/products')
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(response.status).toBe(200);
  });

  it('rejects a legacy-lowercase-only inventory.view grant on the global catalog, once switched', async () => {
    const permission = await prisma.permission.upsert({
      where: { code: 'inventory.view' },
      create: { code: 'inventory.view' },
      update: {},
    });
    const role = await createRole(prisma, 'LEGACY-ONLY-INVENTORY-VIEW-PRODUCTS');
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
    const user = await createTestUser(prisma, role.id, centroId);
    const isolatedToken = await getAuthToken(user);
    const response = await request(app).get('/api/v1/products').set('Authorization', `Bearer ${isolatedToken}`);
    expect(response.status).toBe(403);
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