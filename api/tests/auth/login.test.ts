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
    // Compatibility contract (Phase 1D.1): internal AuthContext shapes must
    // never leak through the public /login response — admin/client only
    // know the baseline { id, name, email, roles, branchIds, permissions }.
    expect(response.body.user.assignments).toBeUndefined();
    expect(response.body.user.legacyPermissions).toBeUndefined();
    expect(response.body.user.effectiveLocationIds).toBeUndefined();
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
    expect(payload.jti).toEqual(expect.any(String));
    expect(payload.assignments).toBeUndefined();
    expect(payload.effectiveLocationIds).toBeUndefined();
    expect(Object.keys(payload).sort()).toEqual(['exp', 'iat', 'jti', 'sub']);
  });

  // D1 (Phase 1 Global Closeout): owner01@demo.local is seed.ts's canonical
  // OWNER — zero legacy UserBranchRole rows, exactly one OWNER COMPANY
  // UserRoleScope row (see prisma/seed.ts's populate()). Before D1, this
  // exact user publicly showed roles: [] (the confirmed compatibility bug —
  // the pre-D1 projection derived roles from UserBranchRole only). This is
  // the real end-to-end proof that the public contract now derives roles
  // from Production assignments.
  it('projects OWNER for the canonical owner01@demo.local user, which has zero legacy UserBranchRole rows', async () => {
    const response = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'owner01@demo.local', password: 'demo123' });
    expect(response.status).toBe(200);
    expect(response.body.user.roles).toEqual(['OWNER']);
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