import express from 'express';
import { SignJWT } from 'jose';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { env } from '../src/config/env.js';
import { requireAuth } from '../src/middleware/auth.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { sendJson } from '../src/shared/json-safe.js';

const key = new TextEncoder().encode(env.JWT_SECRET);
const now = Math.floor(Date.now() / 1000);
const app = express();
app.get('/private', requireAuth, (req, res) => {
  sendJson(res, {
    userId: req.userId,
    role: Reflect.get(req, 'role'),
    branch: Reflect.get(req, 'branch'),
  });
});
app.use(errorHandler);

describe('access JWT identity middleware', () => {
  it('attaches only identity even if the signed JWT contains authorization claims', async () => {
    const token = await new SignJWT({ roles: ['ADMIN'], branch: 'untrusted' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('test-user')
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(key);
    const response = await request(app)
      .get('/private')
      .auth(token, { type: 'bearer' });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ userId: 'test-user' });
  });

  it.each([
    ['expired', 'test-user', now - 1, 'HS256', key],
    ['missing expiry', 'test-user', undefined, 'HS256', key],
    ['blank subject', ' ', now + 300, 'HS256', key],
    ['wrong algorithm', 'test-user', now + 300, 'HS384', key],
    [
      'wrong signature',
      'test-user',
      now + 300,
      'HS256',
      new TextEncoder().encode('different-synthetic-test-signing-key'),
    ],
  ] as const)(
    'rejects %s without echoing the token',
    async (_label, sub, expiry, alg, signingKey) => {
      let jwt = new SignJWT()
        .setProtectedHeader({ alg })
        .setSubject(sub)
        .setIssuedAt(now);
      if (expiry !== undefined) jwt = jwt.setExpirationTime(expiry);
      const token = await jwt.sign(signingKey);
      const response = await request(app)
        .get('/private')
        .auth(token, { type: 'bearer' });
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe('UNAUTHORIZED');
      expect(response.text.includes(token)).toBe(false);
    },
  );

  it('rejects a missing Authorization header', async () => {
    expect((await request(app).get('/private')).status).toBe(401);
  });
});
