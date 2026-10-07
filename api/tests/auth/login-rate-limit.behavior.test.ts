// Pre-pilot fix 2A: dedicated login failure limiter (10 failed logins per
// normalized email per 15 minutes, in-memory, per app instance). DB-free:
// the real app/router/service run against a minimal stub database exposing
// only the two calls login needs (user.findUnique, location.findMany).
//
// Preregistered cases (A01-A15, B01-B10) were written before the first run.
import { hash } from 'bcryptjs';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import type { PrismaClient } from '../../src/generated/prisma/client.js';

const LOGIN = '/api/v1/auth/login';
const PASSWORD = 'correct-horse-battery-staple';
const WRONG = 'wrong-password-secret-marker';

type StubUser = { id: string; name: string; email: string; isActive: boolean; passwordHash: string };

let users: StubUser[] = [];

beforeAll(async () => {
  // Low cost factor keeps the fixture fast; compare() reads rounds from the hash.
  const passwordHash = await hash(PASSWORD, 4);
  users = [
    { id: 'user-a', name: 'Seller A', email: 'seller@example.com', isActive: true, passwordHash },
    { id: 'user-b', name: 'Seller B', email: 'other@example.com', isActive: true, passwordHash },
    { id: 'user-c', name: 'Inactive', email: 'inactive@example.com', isActive: false, passwordHash },
  ];
});

function stubDatabase() {
  return {
    user: {
      // PostgreSQL text equality: exact, case-sensitive match.
      findUnique: async ({ where }: { where: { email?: string; id?: string } }) => {
        const user = users.find((u) => (where.email !== undefined ? u.email === where.email : u.id === where.id));
        return user ? { ...user, branchRoles: [], roleScopes: [] } : null;
      },
    },
    location: { findMany: async () => [] },
  } as unknown as PrismaClient;
}

function newApp() {
  return createApp(stubDatabase());
}

type App = ReturnType<typeof newApp>;

function login(app: App, body: unknown, headers: Record<string, string> = {}) {
  const req = request(app).post(LOGIN);
  for (const [name, value] of Object.entries(headers)) req.set(name, value);
  return req.send(body as object);
}

async function fail(app: App, times: number, email = 'seller@example.com') {
  for (let i = 0; i < times; i++) {
    const res = await login(app, { email, password: WRONG });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  }
}

function globalRemaining(res: request.Response): number {
  const header = String(res.headers.ratelimit ?? '');
  const match = /"120-in-1min"; r=(\d+)/.exec(header);
  if (!match) throw new Error(`global RateLimit header missing: ${header}`);
  return Number(match[1]);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('login failure limiter — threshold (A01-A06)', () => {
  it('A01-A04: ten failures are answered normally, the eleventh is RATE_LIMITED', async () => {
    const app = newApp();
    const first = await login(app, { email: 'seller@example.com', password: WRONG });
    expect(first.status).toBe(401);
    expect(first.body.error.code).toBe('INVALID_CREDENTIALS');
    await fail(app, 8); // A02: nine total
    await fail(app, 1); // A03: tenth consumes the final slot
    const eleventh = await login(app, { email: 'seller@example.com', password: WRONG });
    expect(eleventh.status).toBe(429);
    expect(eleventh.body.error.code).toBe('RATE_LIMITED');
  });

  it('A05: successful logins do not consume the failure budget', async () => {
    const app = newApp();
    for (let i = 0; i < 5; i++) {
      const ok = await login(app, { email: 'seller@example.com', password: PASSWORD });
      expect(ok.status).toBe(200);
      expect(typeof ok.body.accessToken).toBe('string');
    }
    await fail(app, 10);
    const limited = await login(app, { email: 'seller@example.com', password: WRONG });
    expect(limited.status).toBe(429);
  });

  it('A06: the correct password is refused while the account limiter is active', async () => {
    const app = newApp();
    await fail(app, 10);
    const res = await login(app, { email: 'seller@example.com', password: PASSWORD });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
    expect(res.body.accessToken).toBeUndefined();
  });
});

describe('login failure limiter — account key (A07-A09, A13, A14, B01, B08)', () => {
  it('A07: another account is unaffected once the first is limited', async () => {
    const app = newApp();
    await fail(app, 10);
    expect((await login(app, { email: 'seller@example.com', password: WRONG })).status).toBe(429);
    const wrong = await login(app, { email: 'other@example.com', password: WRONG });
    expect(wrong.status).toBe(401);
    const ok = await login(app, { email: 'other@example.com', password: PASSWORD });
    expect(ok.status).toBe(200);
  });

  it('A08: case variations of one email share a bucket', async () => {
    const app = newApp();
    const variants = ['seller@example.com', 'Seller@Example.COM', 'SELLER@EXAMPLE.COM', 'sElLeR@eXaMpLe.CoM'];
    for (let i = 0; i < 10; i++) {
      const res = await login(app, { email: variants[i % variants.length], password: WRONG });
      expect(res.status).toBe(401);
    }
    const res = await login(app, { email: 'Seller@Example.COM', password: WRONG });
    expect(res.status).toBe(429);
  });

  it('A09: surrounding whitespace shares the trimmed bucket', async () => {
    const app = newApp();
    await fail(app, 5, '  seller@example.com  ');
    await fail(app, 5, '\tseller@example.com');
    const res = await login(app, { email: 'seller@example.com   ', password: WRONG });
    expect(res.status).toBe(429);
  });

  it('A13: different X-Forwarded-For / User-Agent values still share the account bucket', async () => {
    const app = newApp();
    for (let i = 0; i < 10; i++) {
      const res = await login(app, { email: 'seller@example.com', password: WRONG }, {
        'X-Forwarded-For': `203.0.113.${i + 1}`,
        'User-Agent': `agent-${i}`,
      });
      expect(res.status).toBe(401);
    }
    const res = await login(app, { email: 'seller@example.com', password: WRONG }, {
      'X-Forwarded-For': '198.51.100.77',
      'User-Agent': 'fresh-agent',
    });
    expect(res.status).toBe(429);
  });

  it('A14: two createApp instances keep independent in-memory counters', async () => {
    const app1 = newApp();
    const app2 = newApp();
    await fail(app1, 10);
    expect((await login(app1, { email: 'seller@example.com', password: WRONG })).status).toBe(429);
    const res = await login(app2, { email: 'seller@example.com', password: WRONG });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('B01: unknown emails are limited the same way (no enumeration signal)', async () => {
    const app = newApp();
    await fail(app, 10, 'nobody@example.com');
    const res = await login(app, { email: 'nobody@example.com', password: WRONG });
    expect(res.status).toBe(429);
  });

  it('B08: extra body fields cannot influence the bucket', async () => {
    const app = newApp();
    for (let i = 0; i < 10; i++) {
      const res = await login(app, { email: 'seller@example.com', password: WRONG, key: `k${i}`, username: `u${i}` });
      expect(res.status).toBe(401);
    }
    const res = await login(app, { email: 'seller@example.com', password: WRONG, key: 'fresh' });
    expect(res.status).toBe(429);
  });
});

describe('login failure limiter — validation runs first (A10-A12, B09)', () => {
  const invalidBodies: Array<[string, unknown]> = [
    ['A10 malformed email', { email: 'not-an-email', password: WRONG }],
    ['A11 missing email', { password: WRONG }],
    ['A12 missing password', { email: 'seller@example.com' }],
    ['A12 empty password', { email: 'seller@example.com', password: '' }],
    ['B09 numeric email', { email: 12345, password: WRONG }],
    ['B09 object email', { email: { $ne: null }, password: WRONG }],
  ];

  it.each(invalidBodies)('%s -> 400 VALIDATION_ERROR and no limiter consumption', async (_name, body) => {
    const app = newApp();
    for (let i = 0; i < 15; i++) {
      const res = await login(app, body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
    await fail(app, 10);
    const res = await login(app, { email: 'seller@example.com', password: WRONG });
    expect(res.status).toBe(429);
  });
});

describe('login failure limiter — interaction with other limiters/routes (A15, B06, B10)', () => {
  it('A15: the dedicated limiter trips well before the global 120/min limiter', async () => {
    const app = newApp();
    await fail(app, 10);
    const res = await login(app, { email: 'seller@example.com', password: WRONG });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
    expect(globalRemaining(res)).toBeGreaterThanOrEqual(109);
  });

  it('B06: the global limiter is still active (121st request in a minute -> 429)', async () => {
    const app = newApp();
    for (let i = 0; i < 120; i++) expect((await request(app).get('/health')).status).toBe(200);
    const res = await request(app).get('/health');
    expect(res.status).toBe(429);
    expect(res.body.error).toEqual({
      code: 'RATE_LIMITED',
      message: 'Demasiadas solicitudes. Intentá nuevamente en un minuto.',
    });
  });

  it('B10: /auth/me is not throttled by the login limiter', async () => {
    const app = newApp();
    await fail(app, 10);
    const res = await request(app).get('/api/v1/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });
});

describe('login failure limiter — response contract and window (B02-B05)', () => {
  it('B02: an inactive account counts its 403 responses as failures', async () => {
    const app = newApp();
    for (let i = 0; i < 10; i++) {
      const res = await login(app, { email: 'inactive@example.com', password: PASSWORD });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('INACTIVE_USER');
    }
    expect((await login(app, { email: 'inactive@example.com', password: PASSWORD })).status).toBe(429);
  });

  it('B03/B04: RATE_LIMITED never echoes email or password and carries the login policy', async () => {
    const app = newApp();
    await fail(app, 10, 'Seller@Example.com');
    const res = await login(app, { email: 'Seller@Example.com', password: WRONG });
    expect(res.status).toBe(429);
    expect(res.body).toEqual({
      error: {
        code: 'RATE_LIMITED',
        message: 'Demasiados intentos de inicio de sesión. Intentá nuevamente más tarde.',
      },
    });
    const raw = `${res.text}\n${JSON.stringify(res.headers)}`.toLowerCase();
    expect(raw.includes('seller@example.com')).toBe(false);
    expect(raw.includes('seller')).toBe(false);
    expect(raw.includes(WRONG)).toBe(false);
    expect(String(res.headers.ratelimit)).toContain('"10-in-15min"');
  });

  it('B05: the bucket resets after the 15-minute window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-07T12:00:00Z'));
    const app = newApp();
    await fail(app, 10);
    expect((await login(app, { email: 'seller@example.com', password: WRONG })).status).toBe(429);
    vi.setSystemTime(new Date('2026-10-07T12:14:00Z'));
    expect((await login(app, { email: 'seller@example.com', password: WRONG })).status).toBe(429);
    vi.setSystemTime(new Date('2026-10-07T12:15:01Z'));
    const res = await login(app, { email: 'seller@example.com', password: WRONG });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });
});
