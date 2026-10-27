// Pre-pilot fix 2B: client key of the global limiter. Default 'socket' keeps
// the TCP peer address; 'x-real-ip' is an explicit opt-in for a trusted edge
// (Railway) that overwrites X-Real-IP. X-Forwarded-For is never read and
// Express trust proxy stays unset. DB-free: bare Express apps and createApp()
// without any database call (/health only).
//
// Preregistered cases (E01-E04, K01-K12, H01-H07) were written before the first run.
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { errorHandler } from '../../src/middleware/errorHandler.js';
import { clientRateLimitKey, createRateLimiter } from '../../src/middleware/rateLimit.js';

const RATE_LIMITED_BODY = {
  error: { code: 'RATE_LIMITED', message: 'Demasiadas solicitudes. Intentá nuevamente en un minuto.' },
};

type FakeRequest = Parameters<typeof clientRateLimitKey>[0];

// remoteAddress null = the socket has no address (a destroyed socket reports undefined).
function fakeReq(header: unknown, remoteAddress: string | null = '10.0.0.1'): FakeRequest {
  const headers = header === undefined ? {} : { 'x-real-ip': header };
  return { headers, socket: { remoteAddress: remoteAddress ?? undefined } } as unknown as FakeRequest;
}

function limitedApp(clientIpSource: 'socket' | 'x-real-ip') {
  const app = express();
  app.use(createRateLimiter({ clientIpSource }));
  app.get('/', (_req, res) => {
    res.json({ ok: true });
  });
  app.use(errorHandler);
  return app;
}

type App = ReturnType<typeof limitedApp>;

async function send(app: App, count: number, headers: (i: number) => Record<string, string>) {
  const statuses: number[] = [];
  for (let i = 0; i < count; i++) {
    const req = request(app).get('/');
    for (const [name, value] of Object.entries(headers(i))) req.set(name, value);
    statuses.push((await req).status);
  }
  return statuses;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('client key — x-real-ip opt-in (K01-K08, K12)', () => {
  it('K01: a valid IPv4 X-Real-IP is the key', () => {
    expect(clientRateLimitKey(fakeReq('203.0.113.9'), 'x-real-ip')).toBe('203.0.113.9');
  });

  it('K02/K03: IPv6 is grouped by /56', () => {
    const a = clientRateLimitKey(fakeReq('2001:db8:abcd:12::1'), 'x-real-ip');
    const b = clientRateLimitKey(fakeReq('2001:db8:abcd:ff:ffff::9'), 'x-real-ip');
    const c = clientRateLimitKey(fakeReq('2001:db8:abce::1'), 'x-real-ip');
    expect(a).toBe('2001:db8:abcd::/56');
    expect(b).toBe(a);
    expect(c).not.toBe(a);
  });

  it('K04: surrounding whitespace is trimmed', () => {
    expect(clientRateLimitKey(fakeReq('  203.0.113.9  '), 'x-real-ip')).toBe('203.0.113.9');
  });

  it.each(['abc', '999.1.1.1', '203.0.113.9/24', '', '   ', '203.0.113.9, 198.51.100.7', '203.0.113.9 198.51.100.7'])(
    'K05/K06: malformed or list value %j falls back to the socket address',
    (value) => {
      expect(clientRateLimitKey(fakeReq(value), 'x-real-ip')).toBe('10.0.0.1');
    },
  );

  it('K07: an array header falls back to the socket address', () => {
    expect(clientRateLimitKey(fakeReq(['203.0.113.9', '198.51.100.7']), 'x-real-ip')).toBe('10.0.0.1');
  });

  it('K08: a missing header falls back to the socket address', () => {
    expect(clientRateLimitKey(fakeReq(undefined), 'x-real-ip')).toBe('10.0.0.1');
  });

  it('K12: an IPv6 zone id never throws and yields a deterministic key', () => {
    const first = clientRateLimitKey(fakeReq('fe80::1%eth0'), 'x-real-ip');
    const second = clientRateLimitKey(fakeReq('fe80::1%eth0'), 'x-real-ip');
    expect(typeof first).toBe('string');
    expect(second).toBe(first);
  });
});

describe('client key — socket default and fail-closed fallback (K09-K11)', () => {
  it('K09: socket mode ignores X-Real-IP', () => {
    expect(clientRateLimitKey(fakeReq('203.0.113.9'), 'socket')).toBe('10.0.0.1');
  });

  it('K10: no usable address yields one stable bucket', () => {
    expect(clientRateLimitKey(fakeReq(undefined, null), 'socket')).toBe('unknown-client');
    expect(clientRateLimitKey(fakeReq('not-an-ip', null), 'x-real-ip')).toBe('unknown-client');
    expect(clientRateLimitKey(fakeReq('', ''), 'x-real-ip')).toBe('unknown-client');
  });

  it('K11: an IPv4-mapped socket address is normalized to IPv4', () => {
    expect(clientRateLimitKey(fakeReq(undefined, '::ffff:127.0.0.1'), 'socket')).toBe('127.0.0.1');
  });
});

describe('global limiter over HTTP (H01-H05, H07)', () => {
  it('H01/H05: 120 allowed per X-Real-IP client, the 121st is RATE_LIMITED; another client is independent', async () => {
    const app = limitedApp('x-real-ip');
    const first = await send(app, 120, () => ({ 'X-Real-IP': '203.0.113.9' }));
    expect(first.every((status) => status === 200)).toBe(true);
    const limited = await request(app).get('/').set('X-Real-IP', '203.0.113.9');
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual(RATE_LIMITED_BODY);
    expect(String(limited.headers.ratelimit)).toContain('"120-in-1min"');
    const other = await request(app).get('/').set('X-Real-IP', '198.51.100.7');
    expect(other.status).toBe(200);
  });

  it('H02: rotating X-Forwarded-For cannot rotate the key', async () => {
    const app = limitedApp('x-real-ip');
    const statuses = await send(app, 121, (i) => ({
      'X-Real-IP': '203.0.113.9',
      'X-Forwarded-For': `198.51.100.${i % 250}, 192.0.2.${i % 250}`,
    }));
    expect(statuses.slice(0, 120).every((status) => status === 200)).toBe(true);
    expect(statuses[120]).toBe(429);
  });

  it('H03: rotating malformed X-Real-IP values share the socket bucket', async () => {
    const app = limitedApp('x-real-ip');
    const statuses = await send(app, 121, (i) => ({ 'X-Real-IP': `not-an-ip-${i}` }));
    expect(statuses[119]).toBe(200);
    expect(statuses[120]).toBe(429);
  });

  it('H04: socket mode ignores rotating valid X-Real-IP values', async () => {
    const app = limitedApp('socket');
    const statuses = await send(app, 121, (i) => ({ 'X-Real-IP': `203.0.113.${i % 250}` }));
    expect(statuses[119]).toBe(200);
    expect(statuses[120]).toBe(429);
  });

  it('H07: the global limiter does not log the unexpected X-Forwarded-For warning', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = limitedApp('x-real-ip');
    await request(app).get('/').set('X-Forwarded-For', '198.51.100.1').set('X-Real-IP', '203.0.113.9');
    const logged = [...errors.mock.calls, ...warnings.mock.calls].map((call) => String(call[0]?.code ?? call[0])).join('\n');
    expect(logged).not.toContain('ERR_ERL_UNEXPECTED_X_FORWARDED_FOR');
  });
});

describe('createApp default (H06)', () => {
  it('H06: /health stays globally limited with the default socket source', async () => {
    const app = createApp();
    for (let i = 0; i < 120; i++) {
      expect((await request(app).get('/health').set('X-Real-IP', `203.0.113.${i % 250}`)).status).toBe(200);
    }
    const res = await request(app).get('/health').set('X-Real-IP', '198.51.100.7');
    expect(res.status).toBe(429);
    expect(res.body).toEqual(RATE_LIMITED_BODY);
  });
});
