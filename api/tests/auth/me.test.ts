import { SignJWT } from 'jose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedDemo } from '../../prisma/seed.js';
import { createApp } from '../../src/app.js';
import { env } from '../../src/config/env.js';
import { createTestPrismaClient, truncateAllTables } from '../helpers/test-db.js';
import { getAuthToken } from '../helpers/auth.js';

describe('GET /api/v1/auth/me', () => {
  let prisma: Awaited<ReturnType<typeof createTestPrismaClient>>;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    prisma = await createTestPrismaClient();
    app = createApp(prisma);
  });
  beforeEach(async () => {
    await truncateAllTables(prisma);
    await seedDemo(prisma);
  });
  afterAll(async () => prisma.$disconnect());

  async function sellerToken() {
    const seller = await prisma.user.findUniqueOrThrow({
      where: { email: 'seller01@demo.local' },
      select: { id: true },
    });
    return getAuthToken(seller);
  }

  it('returns current user context for a valid token', async () => {
    const response = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${await sellerToken()}`);
    expect(response.status).toBe(200);
    expect(response.body.user).toMatchObject({
      name: 'seller01',
      email: 'seller01@demo.local',
      roles: ['SELLER'],
    });
  });

  it('rejects missing and expired tokens', async () => {
    const missing = await request(app).get('/api/v1/auth/me');
    const now = Math.floor(Date.now() / 1000);
    const expired = await new SignJWT()
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('00000000-0000-4000-8000-000000000600')
      .setIssuedAt(now - 1200)
      .setExpirationTime(now - 600)
      .sign(new TextEncoder().encode(env.JWT_SECRET));
    const expiredResponse = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${expired}`);
    expect(missing.status).toBe(401);
    expect(expiredResponse.status).toBe(401);
  });

  it('reflects role changes in the database without issuing a new token', async () => {
    const token = await sellerToken();
    const cashierRole = await prisma.role.findUniqueOrThrow({
      where: { code: 'CASHIER' },
      select: { id: true },
    });
    const seller = await prisma.user.findUniqueOrThrow({
      where: { email: 'seller01@demo.local' },
      select: { id: true },
    });
    await prisma.userBranchRole.deleteMany({ where: { userId: seller.id } });
    const centro = await prisma.branch.findUniqueOrThrow({
      where: { code: 'CEN' },
      select: { id: true },
    });
    await prisma.userBranchRole.create({
      data: { userId: seller.id, branchId: centro.id, roleId: cashierRole.id },
    });
    const response = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${token}`);
    expect(response.status).toBe(200);
    expect(response.body.user.roles).toEqual(['CASHIER']);
  });

  it('rejects an inactive user even with a previously issued token', async () => {
    const token = await sellerToken();
    await prisma.user.update({
      where: { email: 'seller01@demo.local' },
      data: { isActive: false },
    });
    const response = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${token}`);
    expect(response.status).toBe(403);
  });
});