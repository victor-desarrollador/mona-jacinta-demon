import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { jwtVerify } from 'jose';
import { seedDemo } from '../../prisma/seed.js';
import { createApp } from '../../src/app.js';
import { env } from '../../src/config/env.js';
import {
  createTestPrismaClient,
  truncateAllTables,
} from '../helpers/test-db.js';

describe('POST /api/v1/auth/login', () => {
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

  it('returns an access token and current user context for valid credentials', async () => {
    const response = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'seller01@demo.local', password: 'demo123' });
    expect(response.status).toBe(200);
    expect(response.body.user).toMatchObject({
      name: 'seller01',
      email: 'seller01@demo.local',
      roles: ['SELLER'],
    });
    expect(response.body.user.branchIds).toHaveLength(1);
    expect(response.body.accessToken).toEqual(expect.any(String));
    const { payload } = await jwtVerify(
      response.body.accessToken,
      new TextEncoder().encode(env.JWT_SECRET),
      { algorithms: ['HS256'] },
    );
    expect(payload.sub).toBeTruthy();
    expect(payload.iat).toEqual(expect.any(Number));
    expect(payload.exp).toBe(payload.iat! + 900);
    expect(payload.roles).toBeUndefined();
    expect(payload.branchIds).toBeUndefined();
    expect(payload.permissions).toBeUndefined();
  });

  it('rejects invalid passwords and unknown users without account enumeration', async () => {
    const invalidPassword = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'seller01@demo.local', password: 'wrong' });
    const unknownUser = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'missing@demo.local', password: 'wrong' });
    expect(invalidPassword.status).toBe(401);
    expect(unknownUser.status).toBe(401);
    expect(invalidPassword.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(unknownUser.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('rejects an inactive user', async () => {
    await prisma.user.update({
      where: { email: 'seller01@demo.local' },
      data: { isActive: false },
    });
    const response = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'seller01@demo.local', password: 'demo123' });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('INACTIVE_USER');
  });
});