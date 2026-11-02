// USER-MGMT-01 U4.1 — the REAL server assembly (server.ts assembleServer, the function main() runs): Express and Socket.IO share one http.Server and a
// request under /socket.io/ belongs to Engine.IO ONLY. DB-free (in-memory stub), real loopback HTTP, real Socket.IO clients over polling and websocket.
//   SA-01..SA-03  /socket.io/ polling and a whole polling session never reach Express and leave no ERR_HTTP_HEADERS_SENT behind
//   SA-04         a WebSocket-only client connects
//   SA-05..SA-06  Express is untouched: /health, an API route, a normal 404 — and a path that merely looks like Socket.IO's
//   SA-07         U4 on the assembled server: user room, handshake auth, HTTP deactivate -> the live socket is cut, scope revoke
import { hash } from 'bcryptjs';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RequestListener } from 'node:http';
import { createApp } from '../../src/app.js';
import { signAccessToken } from '../../src/modules/auth/tokens.js';
import { userRoom } from '../../src/realtime/session-revoker.js';
import { assembleServer } from '../../src/server.js';
import { createUserAdminStub } from '../helpers/user-admin-stub.js';

const OWNER = '00000000-0000-4000-8000-0000000000a1';
const WORKER = '00000000-0000-4000-8000-0000000000a3';
const LOC = '11111111-1111-4111-8111-111111111111';
const clients: ClientSocket[] = [];
const expressSaw: string[] = []; // every request URL the Express app was invoked for
const failures: string[] = [];   // uncaught exceptions / unhandled rejections raised while the suite runs
const onFailure = (e: unknown) => failures.push((e as { code?: string })?.code ?? String(e));
let base = '';
let port = 0;
let assembled: ReturnType<typeof assembleServer>;
let ownerHeader: { Authorization: string };

beforeAll(async () => {
  process.on('uncaughtException', onFailure);
  process.on('unhandledRejection', onFailure);
  const passwordHash = await hash('current-password-123', 4);
  const row = (id: string) => ({ id, name: `U ${id.slice(-2)}`, email: `u${id.slice(-2)}@example.com`, isActive: true, passwordHash, mustChangePassword: false, credentialsChangedAt: null });
  const stub = createUserAdminStub({
    users: [row(OWNER), row(WORKER)],
    scopes: [{ userId: OWNER, roleCode: 'OWNER', scopeKind: 'COMPANY', locationId: null }, { userId: WORKER, roleCode: 'SELLER', scopeKind: 'LOCATION', locationId: LOC }],
    locations: [{ id: LOC, name: 'Local', code: 'L', isActive: true }],
  });
  // a probe around the REAL app: it records which requests Express is asked to handle, then hands them over untouched
  const probed: typeof createApp = (database, emitter, revoker) => {
    const app = createApp(database, emitter, revoker);
    const listener: RequestListener = (req, res) => { expressSaw.push(req.url ?? ''); app(req, res); };
    return listener as unknown as ReturnType<typeof createApp>;
  };
  assembled = assembleServer(stub.db, probed);
  await new Promise<void>((resolve, reject) => {
    assembled.server.once('error', reject);
    assembled.server.listen(0, '127.0.0.1', () => { assembled.server.off('error', reject); port = (assembled.server.address() as { port: number }).port; resolve(); });
  });
  base = `http://127.0.0.1:${port}`;
  ownerHeader = { Authorization: `Bearer ${await signAccessToken(OWNER, null)}` };
});
afterAll(async () => {
  for (const c of clients) c.close();
  await new Promise<void>((resolve) => assembled.realtime.io.close(() => resolve()));
  process.off('uncaughtException', onFailure);
  process.off('unhandledRejection', onFailure);
});

const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));
const socketIoRequests = () => expressSaw.filter((u) => u.startsWith('/socket.io/'));
async function client(userId: string, transports: Array<'polling' | 'websocket'>): Promise<ClientSocket> {
  const c = connect(base, { auth: { token: await signAccessToken(userId, null) }, transports, reconnection: false, autoConnect: false });
  clients.push(c);
  return c;
}
const connected = (c: ClientSocket) => new Promise<void>((resolve, reject) => { c.once('connect', () => resolve()); c.once('connect_error', reject); c.connect(); });
const dropped = (c: ClientSocket) => new Promise<string>((resolve) => c.once('disconnect', resolve));

describe('/socket.io/ belongs to Engine.IO only (SA-01..SA-04)', () => {
  it('SA-01 a raw polling handshake is answered by Engine.IO and Express is never asked', async () => {
    const before = expressSaw.length;
    const res = await fetch(`${base}/socket.io/?EIO=4&transport=polling`);
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/^0\{"sid":/);
    await settle();
    expect(expressSaw.slice(before)).toEqual([]);
    expect(failures).toEqual([]);
  });

  it('SA-02 a whole polling session — connect, ping, disconnect, reconnect — reaches Express zero times and raises no ERR_HTTP_HEADERS_SENT', async () => {
    const c = await client(WORKER, ['polling']);
    await connected(c);
    expect(c.io.engine.transport.name).toBe('polling');
    await settle(600);
    c.close();
    await settle();
    const again = await client(WORKER, ['polling']);
    await connected(again);
    again.close();
    await settle();
    expect(socketIoRequests()).toEqual([]);
    expect(failures).toEqual([]);
  });

  it('SA-03 the polling transport can upgrade to WebSocket on the assembled server', async () => {
    const c = await client(WORKER, ['polling', 'websocket']);
    await connected(c);
    await new Promise<void>((resolve) => { if (c.io.engine.transport.name === 'websocket') resolve(); else c.io.engine.once('upgrade', () => resolve()); });
    expect(c.io.engine.transport.name).toBe('websocket');
    expect(socketIoRequests()).toEqual([]);
    expect(failures).toEqual([]);
  });

  it('SA-04 a WebSocket-only client connects', async () => {
    const c = await client(WORKER, ['websocket']);
    await connected(c);
    expect(c.io.engine.transport.name).toBe('websocket');
    expect(failures).toEqual([]);
  });
});

describe('Express is untouched (SA-05..SA-06)', () => {
  it('SA-05 /health, an authenticated-route refusal and a normal 404 are still Express answers, each seen exactly once', async () => {
    const before = expressSaw.length;
    const health = await fetch(`${base}/health`);
    expect([health.status, await health.json()]).toEqual([200, { status: 'ok' }]);
    const me = await fetch(`${base}/api/v1/auth/me`);
    expect(me.status).toBe(401);
    const missing = await fetch(`${base}/api/v1/does-not-exist`, { headers: ownerHeader });
    expect([missing.status, (await missing.json()).error.code]).toEqual([404, 'NOT_FOUND']);
    expect(expressSaw.slice(before)).toEqual(['/health', '/api/v1/auth/me', '/api/v1/does-not-exist']);
    expect(failures).toEqual([]);
  });

  it('SA-06 only the exact Engine.IO path is carved out: `/socket.io` without the slash and a look-alike path are ordinary Express 404s', async () => {
    const before = expressSaw.length;
    for (const path of ['/socket.io', '/socket.iox/', '/api/socket.io/']) {
      const res = await fetch(`${base}${path}`);
      expect(res.status, path).toBe(404);
      expect((await res.json()).error.code, path).toBe('NOT_FOUND');
    }
    expect(expressSaw.slice(before)).toEqual(['/socket.io', '/socket.iox/', '/api/socket.io/']);
  });
});

describe('U4 on the assembled server (SA-07)', () => {
  it('SA-07 handshake -> user room -> an HTTP deactivation cuts THAT user\'s live socket; the next handshake is refused INACTIVE_USER', async () => {
    const c = await client(WORKER, ['polling', 'websocket']);
    await connected(c);
    expect(assembled.realtime.io.sockets.sockets.get(c.id!)!.rooms.has(userRoom(WORKER))).toBe(true);
    const gone = dropped(c);
    const res = await fetch(`${base}/api/v1/backoffice/users/${WORKER}/deactivate`, { method: 'POST', headers: { ...ownerHeader, 'Content-Type': 'application/json' }, body: JSON.stringify({ idempotencyKey: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1' }) });
    expect(res.status).toBe(200);
    expect(await gone).toBe('io server disconnect');
    const again = await client(WORKER, ['polling']);
    const denied = await new Promise<Error & { data?: { code?: string } }>((resolve, reject) => { again.once('connect_error', resolve); again.once('connect', () => reject(new Error('connected'))); again.connect(); });
    expect(denied.data?.code).toBe('INACTIVE_USER');
    expect(failures).toEqual([]);
  });
});
