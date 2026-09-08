import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { jwtVerify } from 'jose';
import { env } from '../src/config/env.js';
import {
  assertTestDatabaseIsolation,
  createTestPrismaClient,
  truncateAllTables,
} from './helpers/test-db.js';
import { createBranch, createRole, createTestUser } from './helpers/factories.js';
import { getAuthToken } from './helpers/auth.js';

describe('integration test infrastructure', () => {
  let prisma: Awaited<ReturnType<typeof createTestPrismaClient>>;

  beforeAll(async () => {
    await assertTestDatabaseIsolation();
    prisma = await createTestPrismaClient();
  });

  beforeEach(async () => {
    await truncateAllTables(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('connects to the isolated test database and truncates fixtures', async () => {
    const branch = await createBranch(prisma);
    const role = await createRole(prisma);
    const user = await createTestUser(prisma, role, branch);
    expect(await prisma.user.count()).toBe(1);
    expect(await prisma.branch.count()).toBe(1);
    await truncateAllTables(prisma);
    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.branch.count()).toBe(0);
    expect(await prisma.$queryRaw`SELECT 1`).toBeTruthy();
    expect(user.id).toBeTruthy();
  });

  it('creates identity-only JWTs accepted by the existing middleware contract', async () => {
    const branch = await createBranch(prisma);
    const role = await createRole(prisma);
    const user = await createTestUser(prisma, role, branch);
    const token = await getAuthToken(user);
    const verified = await jwtVerify(
      token,
      new TextEncoder().encode(env.JWT_SECRET),
      { algorithms: ['HS256'] },
    );
    expect(verified.payload.sub).toBe(user.id);
    expect(verified.payload.roles).toBeUndefined();
    expect(verified.payload.branchIds).toBeUndefined();
  });
});