import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedDemo } from '../../prisma/seed.js';
import { createApp } from '../../src/app.js';
import { createTestPrismaClient, truncateAllTables } from '../helpers/test-db.js';
import { getAuthToken, createTestUser } from '../helpers/auth.js';

// D3 (Demo Operativa V1): admin catalogue writes. Products, variants and
// pricing are global (docs/production-v1/03-role-permission-matrix.md), so
// PRODUCT_MANAGE / PRODUCT_VARIANT_MANAGE / PRICE_MANAGE are COMPANY-scope
// required (rbac/permissions.ts COMPANY_SCOPE_REQUIRED_FOR_ADMIN): the
// canonical ADMIN COMPANY and OWNER (implicit) succeed; a LOCATION-scoped
// ADMIN and any caller without the grant fail closed. Every write is
// audited with branchId null (global entity, no location).
describe('admin catalogue API (D3)', () => {
  let prisma: Awaited<ReturnType<typeof createTestPrismaClient>>;
  let app: ReturnType<typeof createApp>;
  let adminToken: string;
  let ownerToken: string;
  let sellerToken: string;
  let locationAdminToken: string;
  let adminId: string;
  let categoryId: string;
  let brandId: string;
  let productId: string;

  beforeAll(async () => {
    prisma = await createTestPrismaClient();
    app = createApp(prisma);
  });
  beforeEach(async () => {
    await truncateAllTables(prisma);
    await seedDemo(prisma);
    const [admin, owner, seller, centro, adminRole, category, brand, product] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { email: 'admin@demo.local' } }),
      prisma.user.findUniqueOrThrow({ where: { email: 'owner01@demo.local' } }),
      prisma.user.findUniqueOrThrow({ where: { email: 'seller01@demo.local' } }),
      prisma.branch.findUniqueOrThrow({ where: { code: 'CEN' } }),
      prisma.role.findUniqueOrThrow({ where: { code: 'ADMIN' } }),
      prisma.category.findUniqueOrThrow({ where: { name: 'Indumentaria' } }),
      prisma.brand.findUniqueOrThrow({ where: { name: 'Mona Jacinta' } }),
      prisma.product.findUniqueOrThrow({ where: { slug: 'remera-basica' } }),
    ]);
    // Transitional LOCATION-scoped ADMIN: createTestUser creates exactly one
    // ADMIN LOCATION(CEN) UserRoleScope.
    const locationAdmin = await createTestUser(prisma, adminRole.id, centro.id);
    adminId = admin.id;
    adminToken = await getAuthToken(admin);
    ownerToken = await getAuthToken(owner);
    sellerToken = await getAuthToken(seller);
    locationAdminToken = await getAuthToken(locationAdmin);
    categoryId = category.id;
    brandId = brand.id;
    productId = product.id;
  });
  afterAll(async () => prisma.$disconnect());

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  describe('reference data reads', () => {
    it('lists categories and brands for an authenticated INVENTORY_VIEW caller', async () => {
      const categories = await request(app).get('/api/v1/categories').set(auth(adminToken));
      expect(categories.status).toBe(200);
      expect(categories.body.items).toEqual([{ id: categoryId, name: 'Indumentaria' }]);
      const brands = await request(app).get('/api/v1/brands').set(auth(sellerToken));
      expect(brands.status).toBe(200);
      expect(brands.body.items).toEqual([{ id: brandId, name: 'Mona Jacinta' }]);
    });

    it('requires authentication', async () => {
      expect((await request(app).get('/api/v1/categories')).status).toBe(401);
      expect((await request(app).get('/api/v1/brands')).status).toBe(401);
    });
  });

  describe('POST /api/v1/products', () => {
    const body = () => ({ name: 'Vestido Lino', slug: 'vestido-lino', categoryId, brandId });

    it('creates a product for ADMIN COMPANY and audits it globally', async () => {
      const response = await request(app).post('/api/v1/products').set(auth(adminToken)).send(body());
      expect(response.status).toBe(201);
      expect(response.body.product).toMatchObject({
        name: 'Vestido Lino', slug: 'vestido-lino', categoryId, brandId, isActive: true,
      });
      const persisted = await prisma.product.findUniqueOrThrow({ where: { slug: 'vestido-lino' } });
      expect(persisted.id).toBe(response.body.product.id);
      const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityType: 'Product', entityId: persisted.id } });
      expect(audit).toMatchObject({ action: 'PRODUCT_CREATED', userId: adminId, branchId: null });
      expect(audit.after).toMatchObject({ name: 'Vestido Lino', slug: 'vestido-lino', categoryId, brandId });
    });

    it('creates a product for OWNER through implicit authority', async () => {
      const response = await request(app).post('/api/v1/products').set(auth(ownerToken)).send(body());
      expect(response.status).toBe(201);
    });

    it('denies a LOCATION-scoped ADMIN (PRODUCT_MANAGE is COMPANY-required) and a caller without the grant, without writing', async () => {
      expect((await request(app).post('/api/v1/products').set(auth(locationAdminToken)).send(body())).status).toBe(403);
      expect((await request(app).post('/api/v1/products').set(auth(sellerToken)).send(body())).status).toBe(403);
      expect(await prisma.product.count({ where: { slug: 'vestido-lino' } })).toBe(0);
      expect(await prisma.auditLog.count()).toBe(0);
    });

    it('rejects an unknown category or brand with 404 and no write', async () => {
      const unknown = '00000000-0000-4000-8000-999999999999';
      const badCategory = await request(app).post('/api/v1/products').set(auth(adminToken)).send({ ...body(), categoryId: unknown });
      expect(badCategory.status).toBe(404);
      const badBrand = await request(app).post('/api/v1/products').set(auth(adminToken)).send({ ...body(), brandId: unknown });
      expect(badBrand.status).toBe(404);
      expect(await prisma.product.count({ where: { slug: 'vestido-lino' } })).toBe(0);
    });

    it('rejects a duplicate slug with 409 and no audit', async () => {
      const response = await request(app).post('/api/v1/products').set(auth(adminToken)).send({ ...body(), slug: 'remera-basica' });
      expect(response.status).toBe(409);
      expect(await prisma.auditLog.count()).toBe(0);
    });

    it('rejects malformed bodies with 400', async () => {
      for (const invalid of [
        { ...body(), name: '' },
        { ...body(), slug: 'Not A Slug' },
        { ...body(), categoryId: 'not-a-uuid' },
        { ...body(), unexpected: true },
      ]) {
        expect((await request(app).post('/api/v1/products').set(auth(adminToken)).send(invalid)).status).toBe(400);
      }
    });
  });

  describe('POST /api/v1/variants', () => {
    const body = () => ({
      productId, sku: 'REM-ROJ-L', barcode: 'DEMO-REM-ROJ-L', color: 'Rojo', size: 'L',
      price: '9007199254740993', costPrice: '2500000',
    });

    it('creates a variant for ADMIN COMPANY with exact BigInt cents and audits it globally', async () => {
      const response = await request(app).post('/api/v1/variants').set(auth(adminToken)).send(body());
      expect(response.status).toBe(201);
      // Beyond Number.MAX_SAFE_INTEGER: proves no floating-point conversion.
      expect(response.body.variant).toMatchObject({
        productId, sku: 'REM-ROJ-L', barcode: 'DEMO-REM-ROJ-L', color: 'Rojo', size: 'L',
        price: '9007199254740993', costPrice: '2500000', isActive: true,
      });
      const persisted = await prisma.productVariant.findUniqueOrThrow({ where: { sku: 'REM-ROJ-L' } });
      expect(persisted.price).toBe(9007199254740993n);
      expect(persisted.costPrice).toBe(2500000n);
      const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityType: 'ProductVariant', entityId: persisted.id } });
      expect(audit).toMatchObject({ action: 'PRODUCT_VARIANT_CREATED', userId: adminId, branchId: null });
      expect(audit.after).toMatchObject({ sku: 'REM-ROJ-L', price: '9007199254740993', costPrice: '2500000' });
    });

    it('creates a variant for OWNER through implicit authority', async () => {
      expect((await request(app).post('/api/v1/variants').set(auth(ownerToken)).send(body())).status).toBe(201);
    });

    it('denies a LOCATION-scoped ADMIN and a caller without the grant, without writing', async () => {
      expect((await request(app).post('/api/v1/variants').set(auth(locationAdminToken)).send(body())).status).toBe(403);
      expect((await request(app).post('/api/v1/variants').set(auth(sellerToken)).send(body())).status).toBe(403);
      expect(await prisma.productVariant.count({ where: { sku: 'REM-ROJ-L' } })).toBe(0);
    });

    it('rejects a duplicate sku or barcode with 409', async () => {
      expect((await request(app).post('/api/v1/variants').set(auth(adminToken)).send({ ...body(), sku: 'REM-NEG-M' })).status).toBe(409);
      expect((await request(app).post('/api/v1/variants').set(auth(adminToken)).send({ ...body(), barcode: 'DEMO-REM-NEG-M' })).status).toBe(409);
      expect(await prisma.auditLog.count()).toBe(0);
    });

    it('rejects an unknown product with 404', async () => {
      const response = await request(app).post('/api/v1/variants').set(auth(adminToken))
        .send({ ...body(), productId: '00000000-0000-4000-8000-999999999999' });
      expect(response.status).toBe(404);
    });

    it('rejects non-integer, negative, zero-price or numeric (non-string) money with 400', async () => {
      for (const invalid of [
        { ...body(), price: '45.50' },
        { ...body(), price: '-1' },
        { ...body(), price: '0' },
        { ...body(), price: 4500000 },
        { ...body(), costPrice: '1e3' },
      ]) {
        expect((await request(app).post('/api/v1/variants').set(auth(adminToken)).send(invalid)).status).toBe(400);
      }
      expect(await prisma.productVariant.count({ where: { sku: 'REM-ROJ-L' } })).toBe(0);
    });
  });

  describe('PATCH /api/v1/variants/:id/price', () => {
    let variantId: string;
    beforeEach(async () => {
      variantId = (await prisma.productVariant.findUniqueOrThrow({ where: { sku: 'REM-NEG-M' } })).id;
    });
    const patch = (token: string, id: string, body: unknown) =>
      request(app).patch(`/api/v1/variants/${id}/price`).set(auth(token)).send(body as object);

    it('changes only the sell price for ADMIN COMPANY and audits before/after', async () => {
      const response = await patch(adminToken, variantId, { price: '4990000' });
      expect(response.status).toBe(200);
      expect(response.body.variant).toMatchObject({ id: variantId, price: '4990000', costPrice: '2500000' });
      const persisted = await prisma.productVariant.findUniqueOrThrow({ where: { id: variantId } });
      expect(persisted.price).toBe(4990000n);
      expect(persisted.costPrice).toBe(2500000n);
      const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityType: 'ProductVariant', entityId: variantId } });
      expect(audit).toMatchObject({ action: 'PRODUCT_VARIANT_PRICE_CHANGED', userId: adminId, branchId: null });
      expect(audit.before).toEqual({ price: '4500000' });
      expect(audit.after).toEqual({ price: '4990000' });
    });

    it('allows OWNER through implicit authority', async () => {
      expect((await patch(ownerToken, variantId, { price: '4990000' })).status).toBe(200);
    });

    it('denies a LOCATION-scoped ADMIN and a caller without PRICE_MANAGE, leaving the price unchanged', async () => {
      expect((await patch(locationAdminToken, variantId, { price: '1' })).status).toBe(403);
      expect((await patch(sellerToken, variantId, { price: '1' })).status).toBe(403);
      expect((await prisma.productVariant.findUniqueOrThrow({ where: { id: variantId } })).price).toBe(4500000n);
      expect(await prisma.auditLog.count()).toBe(0);
    });

    it('returns 404 for an unknown variant and 400 for a malformed id or money', async () => {
      expect((await patch(adminToken, '00000000-0000-4000-8000-999999999999', { price: '1' })).status).toBe(404);
      expect((await patch(adminToken, 'not-a-uuid', { price: '1' })).status).toBe(400);
      for (const invalid of [{ price: '1.5' }, { price: '0' }, { price: '-3' }, { price: 100 }, {}, { price: '1', costPrice: '1' }]) {
        expect((await patch(adminToken, variantId, invalid)).status).toBe(400);
      }
      expect((await prisma.productVariant.findUniqueOrThrow({ where: { id: variantId } })).price).toBe(4500000n);
    });
  });
});
