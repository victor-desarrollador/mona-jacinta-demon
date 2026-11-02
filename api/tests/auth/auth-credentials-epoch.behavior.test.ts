// USER-MGMT-01 U1 — credentials epoch + mustChangePassword through the REAL app (middleware, login, /auth/me). DB-free: the real
// router/middleware/service run against the in-memory stub of tests/helpers/user-credentials-stub.ts.
//
// The access token carries the credentials epoch as `cc` (integer milliseconds, ABSENT while the account never changed credentials)
// and a request is valid only when `cc` EQUALS User.credentialsChangedAt. `iat` is never compared. A pending password change
// (mustChangePassword) blocks every authenticated endpoint except /auth/me and /auth/change-password, in the BACKEND.
//
//   AE-01..AE-02  login signs the epoch
//   AE-03..AE-08  middleware: legacy token, missing/old/1 ms-off epoch, iat irrelevance, inactive user
//   AM-01..AM-06  mustChangePassword: blocked / allowed endpoints, login, /auth/me exposure
import { hash } from 'bcryptjs';
import { SignJWT, decodeJwt } from 'jose';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { env } from '../../src/config/env.js';
import { signAccessToken } from '../../src/modules/auth/tokens.js';
import { createCredentialsStub, type StubUser } from '../helpers/user-credentials-stub.js';

const PASSWORD = 'correct-horse-battery-staple';
const EPOCH = new Date(1_700_000_000_123);
const BLOCKED_ROUTE = '/api/v1/cash/register?branchId=00000000-0000-4000-8000-000000000000';
const key = new TextEncoder().encode(env.JWT_SECRET);

let passwordHash = '';
beforeAll(async () => {
  passwordHash = await hash(PASSWORD, 4);
});

const user = (patch: Partial<StubUser> = {}): StubUser => ({
  id: 'user-1', name: 'Maria Lopez', email: 'maria@example.com', isActive: true, passwordHash,
  mustChangePassword: false, credentialsChangedAt: null, ...patch,
});

const appWith = (users: StubUser[]) => createApp(createCredentialsStub(users).db);
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const me = (app: ReturnType<typeof createApp>, token: string) => request(app).get('/api/v1/auth/me').set(bearer(token));

// A token with an arbitrary cc / iat, signed with the real key (what the real signer would never produce for a stale epoch).
async function tokenWith(userId: string, claims: Record<string, unknown>, issuedAt = Math.floor(Date.now() / 1000)) {
  return new SignJWT(claims).setProtectedHeader({ alg: 'HS256' }).setSubject(userId).setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + env.JWT_ACCESS_TTL_SECONDS).setJti('t').sign(key);
}

describe('login signs the credentials epoch (AE-01..AE-02)', () => {
  it('AE-01 an account that never changed credentials gets a token WITHOUT cc', async () => {
    const res = await request(appWith([user()])).post('/api/v1/auth/login').send({ email: 'maria@example.com', password: PASSWORD });
    expect(res.status).toBe(200);
    expect(decodeJwt(res.body.accessToken)).not.toHaveProperty('cc');
  });

  it('AE-02 an account with an epoch gets cc = that epoch in exact milliseconds', async () => {
    const res = await request(appWith([user({ credentialsChangedAt: EPOCH })])).post('/api/v1/auth/login').send({ email: 'maria@example.com', password: PASSWORD });
    expect(res.status).toBe(200);
    expect(decodeJwt(res.body.accessToken).cc).toBe(1_700_000_000_123);
  });
});

describe('the middleware validates the epoch by EQUALITY (AE-03..AE-08)', () => {
  it('AE-03 a legacy token (no cc) is valid while the stored epoch is NULL', async () => {
    const app = appWith([user()]);
    expect((await me(app, await signAccessToken('user-1'))).status).toBe(200);
  });

  it('AE-04 a token without cc is INVALID once an epoch is stored (the previous credentials)', async () => {
    const app = appWith([user({ credentialsChangedAt: EPOCH })]);
    const res = await me(app, await signAccessToken('user-1'));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('AE-05 a token whose cc equals the stored epoch is valid', async () => {
    const app = appWith([user({ credentialsChangedAt: EPOCH })]);
    expect((await me(app, await signAccessToken('user-1', EPOCH))).status).toBe(200);
  });

  it('AE-06 a cc that differs by ONE millisecond is invalid, either way', async () => {
    const app = appWith([user({ credentialsChangedAt: EPOCH })]);
    for (const cc of [EPOCH.getTime() - 1, EPOCH.getTime() + 1]) {
      const res = await me(app, await tokenWith('user-1', { cc }));
      expect(res.status, String(cc)).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHORIZED');
    }
  });

  it('AE-07 iat plays no part: a token issued AFTER the epoch with an old cc is invalid; one issued BEFORE it with the right cc is valid', async () => {
    const epoch = new Date((Math.floor(Date.now() / 1000) - 5) * 1000 + 250);
    const app = appWith([user({ credentialsChangedAt: epoch })]);
    const now = Math.floor(Date.now() / 1000);
    expect((await me(app, await tokenWith('user-1', { cc: epoch.getTime() - 1 }, now))).status).toBe(401);
    expect((await me(app, await tokenWith('user-1', { cc: epoch.getTime() }, Math.floor(epoch.getTime() / 1000) - 10))).status).toBe(200);
  });

  it('AE-07b a malformed cc (string, float) is invalid', async () => {
    const app = appWith([user({ credentialsChangedAt: EPOCH })]);
    for (const cc of ['1700000000123', 1_700_000_000_123.5]) {
      expect((await me(app, await tokenWith('user-1', { cc }))).status, String(cc)).toBe(401);
    }
  });

  it('AE-08 an inactive account still answers 403 INACTIVE_USER (never reclassified as an expired token)', async () => {
    const app = appWith([user({ isActive: false, credentialsChangedAt: EPOCH })]);
    const res = await me(app, await signAccessToken('user-1'));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('INACTIVE_USER');
  });
});

describe('mustChangePassword is enforced in the backend (AM-01..AM-06)', () => {
  it('AM-01 any other authenticated endpoint answers 403 PASSWORD_CHANGE_REQUIRED before its handler runs', async () => {
    const app = appWith([user({ mustChangePassword: true })]);
    const res = await request(app).get(BLOCKED_ROUTE).set(bearer(await signAccessToken('user-1')));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    expect(res.body.error.message).toMatch(/contraseña/i);
  });

  it('AM-01b a write endpoint is blocked the same way, whatever its body', async () => {
    const app = appWith([user({ mustChangePassword: true })]);
    const res = await request(app).post('/api/v1/cash/sessions/open').set(bearer(await signAccessToken('user-1'))).send({});
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
  });

  it('AM-02 /auth/me is allowed and tells the client that a change is pending', async () => {
    const app = appWith([user({ mustChangePassword: true })]);
    const res = await me(app, await signAccessToken('user-1'));
    expect(res.status).toBe(200);
    expect(res.body.user.mustChangePassword).toBe(true);
  });

  it('AM-03 POST /auth/change-password is allowed through the middleware (it reaches its own handler, not the block)', async () => {
    const app = appWith([user({ mustChangePassword: true })]);
    const res = await request(app).post('/api/v1/auth/change-password').set(bearer(await signAccessToken('user-1'))).send({});
    expect(res.status).toBe(400); // the strict body schema refuses {} — never PASSWORD_CHANGE_REQUIRED, never 404
    expect(res.body.error.code).not.toBe('PASSWORD_CHANGE_REQUIRED');
  });

  it('AM-03b adversarial: the allowance is a per-route option, not a URL comparison — look-alike paths, prefixes, trailing parts and query strings that merely MENTION the two routes stay blocked', async () => {
    const app = appWith([user({ mustChangePassword: true })]);
    const token = await signAccessToken('user-1');
    const lookalikes = [
      '/api/v1/auth/mex', '/api/v1/auth/me2', '/api/v1/auth/change-password-x', '/api/v1/auth/me/extra',
      '/api/v1/sales/auth/me', '/api/v1/products?next=/api/v1/auth/me', '/api/v1/cash/register?branchId=00000000-0000-4000-8000-000000000000&x=/auth/me',
      '/api/v1/auth/%6De', '/api/v1//auth/me/../../cash/register',
    ];
    for (const path of lookalikes) {
      const res = await request(app).get(path).set(bearer(token));
      expect(res.body.error?.code, path).toBe('PASSWORD_CHANGE_REQUIRED');
    }
    // the real routes keep working with a query string or a trailing slash (Express matches them as the same route; the option travels with the route)
    expect((await request(app).get('/api/v1/auth/me?x=1').set(bearer(token))).status).toBe(200);
    expect((await request(app).get('/api/v1/auth/me/').set(bearer(token))).status).toBe(200);
  });

  it('AM-04 without a pending change the same endpoint is NOT blocked by this rule', async () => {
    const app = appWith([user({ mustChangePassword: false })]);
    const res = await request(app).get(BLOCKED_ROUTE).set(bearer(await signAccessToken('user-1')));
    expect(res.body.error?.code).not.toBe('PASSWORD_CHANGE_REQUIRED');
  });

  it('AM-05 login still works for an account with a pending change, and says so', async () => {
    const app = appWith([user({ mustChangePassword: true })]);
    const res = await request(app).post('/api/v1/auth/login').send({ email: 'maria@example.com', password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.user.mustChangePassword).toBe(true);
    expect(typeof res.body.accessToken).toBe('string');
  });

  it('AM-06 /auth/me and login expose mustChangePassword and NEVER the epoch, cc or any hash/secret', async () => {
    const app = appWith([user({ credentialsChangedAt: EPOCH })]);
    const login = await request(app).post('/api/v1/auth/login').send({ email: 'maria@example.com', password: PASSWORD });
    const profile = await me(app, login.body.accessToken as string);
    for (const body of [login.body.user, profile.body.user]) {
      expect(body.mustChangePassword).toBe(false);
      const text = JSON.stringify(body);
      expect(text).not.toMatch(/credentialsChangedAt|passwordHash|"cc"/);
      expect(text).not.toContain(passwordHash);
      expect(text).not.toContain('1700000000123');
    }
  });
});
