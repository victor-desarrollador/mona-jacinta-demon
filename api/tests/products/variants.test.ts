import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedDemo } from '../../prisma/seed.js';
import { createApp } from '../../src/app.js';
import { createTestPrismaClient, truncateAllTables } from '../helpers/test-db.js';
import { getAuthToken } from '../helpers/auth.js';

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