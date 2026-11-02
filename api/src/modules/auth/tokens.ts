import { randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { env } from '../../config/env.js';
import { credentialsEpochClaim } from './credentials-epoch.js';

const ACCESS_TOKEN_SECONDS = env.JWT_ACCESS_TTL_SECONDS;
const key = new TextEncoder().encode(env.JWT_SECRET);

// `credentialsChangedAt` is the user's stored credentials epoch (credentials-epoch.ts): it becomes the `cc` claim, and is ABSENT
// while the user has never changed credentials (a legacy-shaped token). Invalidation compares `cc` for equality, never `iat`.
export function signAccessToken(userId: string, credentialsChangedAt: Date | null = null): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const cc = credentialsEpochClaim(credentialsChangedAt);
  return new SignJWT(cc === null ? {} : { cc })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt(now)
    .setExpirationTime(now + ACCESS_TOKEN_SECONDS)
    .setJti(randomUUID())
    .sign(key);
}

export function verifyAccessToken(token: string): Promise<{ payload: JWTPayload }> {
  return jwtVerify(token, key, {
    algorithms: ['HS256'],
    requiredClaims: ['sub', 'iat', 'exp'],
    maxTokenAge: ACCESS_TOKEN_SECONDS,
  });
}

export { ACCESS_TOKEN_SECONDS };