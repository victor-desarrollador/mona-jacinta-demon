import { SignJWT } from 'jose';
import { env } from '../../src/config/env.js';
import type { PrismaClient, User, Role, Branch } from '../../src/generated/prisma/client.js';
import { createTestUser } from './factories.js';

export { createTestUser };

export type TestIdentity = Pick<User, 'id'> & {
  role?: Pick<Role, 'code'>;
  branch?: Pick<Branch, 'id'>;
};

export async function getAuthToken(user: Pick<User, 'id'>): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT()
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuedAt(now)
    .setExpirationTime(now + env.JWT_ACCESS_TTL_SECONDS)
    .sign(new TextEncoder().encode(env.JWT_SECRET));
}

export type AuthFactoryClient = PrismaClient;