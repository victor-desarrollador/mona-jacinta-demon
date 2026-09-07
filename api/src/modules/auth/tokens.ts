import { randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { env } from '../../config/env.js';

const ACCESS_TOKEN_SECONDS = 15 * 60;
const key = new TextEncoder().encode(env.JWT_SECRET);

export function signAccessToken(userId: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT()
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