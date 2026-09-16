import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedDemo } from '../../prisma/seed.js';
import { createApp } from '../../src/app.js';
import { PRODUCTION_PERMISSIONS } from '../../src/modules/rbac/permissions.js';
import { createTestPrismaClient, truncateAllTables } from '../helpers/test-db.js';
import { getAuthToken, createTestUser } from '../helpers/auth.js';
import { createRole, createBranch, ensureTestLocation } from '../helpers/factories.js';

describe('product variants read API', () => {
  let prisma: Awaited<ReturnType<typeof createTestPrismaClient>>;
  let app: ReturnType<typeof createApp>;
  let sellerToken: string;
  let centroId: string;
  let yerbaId: string;

  beforeAll(async () => {
    prisma = await createTestPrismaClient();
    app = createApp(prisma);
  });
  beforeEach(async () => {
    await truncateAllTables(prisma);
    await seedDemo(prisma);
    const [seller, centro, yerba] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { email: 'seller01@demo.local' }, select: { id: true } }),
      prisma.branch.findUniqueOrThrow({ where: { code: 'CEN' }, select: { id: true } }),
      prisma.branch.findUniqueOrThrow({ where: { code: 'YB' }, select: { id: true } }),
    ]);
    sellerToken = await getAuthToken(seller);
    centroId = centro.id;
    yerbaId = yerba.id;
  });
  afterAll(async () => prisma.$disconnect());

  it('lists variants and filters by product, search, and authorized branch', async () => {
    const product = await prisma.product.findUniqueOrThrow({
      where: { slug: 'remera-basica' },
      select: { id: true },
    });
    const response = await request(app)
      .get('/api/v1/variants')
      .query({ productId: product.id, branchId: centroId, limit: 100 })
      .set('Authorization', `Bearer ${sellerToken}`);
    expect(response.status).toBe(200);
    expect(response.body.items).toHaveLength(2);
    expect(response.body.items.every((item: { inventory: unknown[] }) => item.inventory.length === 1)).toBe(true);

    const search = await request(app)
      .get('/api/v1/variants')
      .query({ search: 'REM-NEG-M' })
      .set('Authorization', `Bearer ${sellerToken}`);
    expect(search.status).toBe(200);
    expect(search.body.items[0].sku).toBe('REM-NEG-M');
  });

  it('rejects unauthorized explicit branches instead of silently filtering them', async () => {
    const response = await request(app)
      .get('/api/v1/variants')
      .query({ branchId: yerbaId })
      .set('Authorization', `Bearer ${sellerToken}`);
    expect(response.status).toBe(403);
  });

  it('requires authentication and the Production INVENTORY_VIEW permission', async () => {
    expect((await request(app).get('/api/v1/variants')).status).toBe(401);
    // Phase 1D.3.4 SWITCH: /variants now gates on the Production
    // INVENTORY_VIEW grant (req.auth.assignments), not the legacy
    // inventory.view code — revoke the Production grant to prove that is the
    // real, live decision.
    const permission = await prisma.permission.findUniqueOrThrow({
      where: { code: PRODUCTION_PERMISSIONS.INVENTORY_VIEW },
      select: { id: true },
    });
    const role = await prisma.role.findUniqueOrThrow({ where: { code: 'SELLER' }, select: { id: true } });
    await prisma.rolePermission.delete({
      where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } },
    });
    expect(
      (await request(app).get('/api/v1/variants').set('Authorization', `Bearer ${sellerToken}`)).status,
    ).toBe(403);
  });

  it('authorizes global variant read via the Production INVENTORY_VIEW grant alone', async () => {
    const sellerRole = await prisma.role.findUniqueOrThrow({ where: { code: 'SELLER' } });
    const user = await createTestUser(prisma, sellerRole.id, centroId);
    const isolatedToken = await getAuthToken(user);
    const response = await request(app).get('/api/v1/variants').set('Authorization', `Bearer ${isolatedToken}`);
    expect(response.status).toBe(200);
  });

  it('rejects a legacy-lowercase-only inventory.view grant on the global catalog, once switched', async () => {
    const permission = await prisma.permission.upsert({
      where: { code: 'inventory.view' },
      create: { code: 'inventory.view' },
      update: {},
    });
    const role = await createRole(prisma, 'LEGACY-ONLY-INVENTORY-VIEW-VARIANTS');
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
    const user = await createTestUser(prisma, role.id, centroId);
    const isolatedToken = await getAuthToken(user);
    const response = await request(app).get('/api/v1/variants').set('Authorization', `Bearer ${isolatedToken}`);
    expect(response.status).toBe(403);
  });

  it('authorizes the explicit variant branchId filter only via Production INVENTORY_VIEW at that exact location', async () => {
    const sellerRole = await prisma.role.findUniqueOrThrow({ where: { code: 'SELLER' } });
    const user = await createTestUser(prisma, sellerRole.id, centroId);
    const isolatedToken = await getAuthToken(user);
    const response = await request(app)
      .get('/api/v1/variants')
      .query({ branchId: centroId })
      .set('Authorization', `Bearer ${isolatedToken}`);
    expect(response.status).toBe(200);
  });

  it('rejects the explicit variant branchId filter for a mismatched assignment/location', async () => {
    const sellerRole = await prisma.role.findUniqueOrThrow({ where: { code: 'SELLER' } });
    const user = await createTestUser(prisma, sellerRole.id, centroId);
    const isolatedToken = await getAuthToken(user);
    const response = await request(app)
      .get('/api/v1/variants')
      .query({ branchId: yerbaId })
      .set('Authorization', `Bearer ${isolatedToken}`);
    expect(response.status).toBe(403);
  });

  // Phase 1D.3.4 cross-assignment security: a permission granted by one
  // assignment must never combine with a location granted by a different
  // assignment (authorization-policy.ts's hasPermissionAtLocation contract).
  // SELLER carries INVENTORY_VIEW by default; WAREHOUSE does not.
  it('does not compose SELLER @ A permission with WAREHOUSE @ B location for the explicit variant branch filter', async () => {
    const sellerRole = await prisma.role.findUniqueOrThrow({ where: { code: 'SELLER' } });
    const warehouseRole = await prisma.role.findUniqueOrThrow({ where: { code: 'WAREHOUSE' } });
    const branchB = await createBranch(prisma);
    await ensureTestLocation(prisma, branchB.id);
    const multi = await prisma.user.create({ data: { name: 'multi-variant', email: 'multi-variant@test.local', passwordHash: 'x' } });
    await prisma.userRoleScope.createMany({
      data: [
        { userId: multi.id, roleId: sellerRole.id, scopeKind: 'LOCATION', locationId: centroId },
        { userId: multi.id, roleId: warehouseRole.id, scopeKind: 'LOCATION', locationId: branchB.id },
      ],
    });
    const multiToken = await getAuthToken(multi);
    expect(
      (await request(app).get('/api/v1/variants').query({ branchId: centroId }).set('Authorization', `Bearer ${multiToken}`)).status,
    ).toBe(200);
    expect(
      (await request(app).get('/api/v1/variants').query({ branchId: branchB.id }).set('Authorization', `Bearer ${multiToken}`)).status,
    ).toBe(403);
  });

  it('returns authorized inventory only and computes available as physical minus reserved', async () => {
    const variant = await prisma.productVariant.findUniqueOrThrow({
      where: { sku: 'REM-NEG-M' },
      select: { id: true, price: true },
    });
    const response = await request(app)
      .get(`/api/v1/variants/${variant.id}`)
      .set('Authorization', `Bearer ${sellerToken}`);
    expect(response.status).toBe(200);
    expect(response.body.variant.product.name).toBe('Remera Básica');
    expect(response.body.variant.price).toBe('4500000');
    expect(response.body.variant.inventory).toHaveLength(1);
    expect(response.body.variant.inventory[0]).toMatchObject({
      branchId: centroId,
      physical: '20',
      reserved: '0',
      available: '20',
    });
    expect(typeof response.body.variant.inventory[0].physical).toBe('string');
    expect(response.body.variant).not.toHaveProperty('costPrice');
  });

  it('makes the Jean Azul/42 demo variant discoverable and validates parameters', async () => {
    const response = await request(app)
      .get('/api/v1/variants')
      .query({ search: 'JEA-AZU-42' })
      .set('Authorization', `Bearer ${sellerToken}`);
    expect(response.status).toBe(200);
    expect(response.body.items[0]).toMatchObject({ sku: 'JEA-AZU-42', price: '7500000' });
    const malformed = await request(app)
      .get('/api/v1/variants')
      .query({ productId: 'invalid' })
      .set('Authorization', `Bearer ${sellerToken}`);
    expect(malformed.status).toBe(400);
  });
});