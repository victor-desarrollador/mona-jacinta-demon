// USER-MGMT-01 U4 — Socket.IO session semantics, against a REAL Socket.IO server on loopback and a stubbed database (DB-free).
//   SS-H*  the handshake re-reads the CURRENT user and applies the SAME rules as HTTP (active, no pending password change, credentials epoch)
//   SS-R*  every socket also joins `user:<id>` taken from the verified token — never from the client
//   SS-D*  the Socket.IO SessionRevoker disconnects exactly one user's sockets; a reconnect re-reads the CURRENT scopes
import { createServer } from 'node:http';
import { SignJWT } from 'jose';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../../src/config/env.js';
import { signAccessToken } from '../../src/modules/auth/tokens.js';
import { createRealtime, REALTIME_EVENTS } from '../../src/realtime/socket.js';
import { branchRoom, userRoom } from '../../src/realtime/session-revoker.js';

const BRANCH_A = 'branch-a';
const BRANCH_B = 'branch-b';
const EPOCH = new Date(1_700_000_000_123);
const database = { user: { findUnique: vi.fn() }, location: { findMany: vi.fn() } };
const server = createServer();
const realtime = createRealtime(server, database as never);
const clients: ClientSocket[] = [];
let port: number;

type Row = { id: string; isActive: boolean; mustChangePassword: boolean; credentialsChangedAt: Date | null; locations: string[] };
const row = (id: string, patch: Partial<Row> = {}): Row => ({ id, isActive: true, mustChangePassword: false, credentialsChangedAt: null, locations: [BRANCH_A], ...patch });
const dbRow = (r: Row) => ({
  id: r.id, isActive: r.isActive, mustChangePassword: r.mustChangePassword, credentialsChangedAt: r.credentialsChangedAt, branchRoles: [],
  roleScopes: r.locations.map((locationId) => ({ roleId: 'role-cashier', scopeKind: 'LOCATION' as const, locationId, role: { code: 'CASHIER', permissions: [{ permission: { code: 'CASH_SESSION_OPEN' } }] } })),
});
const users = new Map<string, Row>();

function client(token?: string) {
  const c = connect(`http://127.0.0.1:${port}`, { auth: token ? { token } : undefined, autoConnect: false, reconnection: false });
  clients.push(c);
  return c;
}
const connected = (c: ClientSocket) => new Promise<void>((resolve, reject) => { c.once('connect', () => resolve()); c.once('connect_error', reject); c.connect(); });
const refused = (c: ClientSocket) => new Promise<Error & { data?: unknown }>((resolve, reject) => { c.once('connect_error', resolve); c.once('connect', () => reject(new Error('connected but should have been refused'))); c.connect(); });
const serverSide = (c: ClientSocket) => realtime.io.sockets.sockets.get(c.id!)!;
const disconnected = (c: ClientSocket) => new Promise<string>((resolve) => c.once('disconnect', resolve));
async function tokenWith(userId: string, claims: Record<string, unknown> = {}, iat = Math.floor(Date.now() / 1000)) {
  return new SignJWT(claims).setProtectedHeader({ alg: 'HS256' }).setSubject(userId).setIssuedAt(iat).setExpirationTime(iat + env.JWT_ACCESS_TTL_SECONDS).sign(new TextEncoder().encode(env.JWT_SECRET));
}

beforeAll(async () => {
  database.user.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => { const r = users.get(where.id); return r ? dbRow(r) : null; });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); port = (server.address() as { port: number }).port; resolve(); });
  });
});
beforeEach(() => { users.clear(); });
afterAll(async () => {
  for (const c of clients) c.close();
  await new Promise<void>((resolve) => realtime.io.close(() => resolve()));
  server.close();
});

describe('the handshake applies the HTTP session rules (SS-H*)', () => {
  it('SS-H01 an active account with the right credentials epoch connects', async () => {
    users.set('u1', row('u1', { credentialsChangedAt: EPOCH }));
    const c = client(await signAccessToken('u1', EPOCH));
    await connected(c);
    expect(serverSide(c).data.userId).toBe('u1');
  });

  it('SS-H02 an INACTIVE account is refused with the HTTP code INACTIVE_USER', async () => {
    users.set('u1', row('u1', { isActive: false }));
    const error = await refused(client(await signAccessToken('u1')));
    expect(error.message).toBe('UNAUTHORIZED');
    expect(error.data).toMatchObject({ code: 'INACTIVE_USER' });
  });

  it('SS-H03 a pending password change (mustChangePassword) is refused with PASSWORD_CHANGE_REQUIRED', async () => {
    users.set('u1', row('u1', { mustChangePassword: true }));
    const error = await refused(client(await signAccessToken('u1')));
    expect(error.data).toMatchObject({ code: 'PASSWORD_CHANGE_REQUIRED' });
  });

  it('SS-H04 an OLD credentials epoch (cc) is refused — one millisecond off, either way', async () => {
    users.set('u1', row('u1', { credentialsChangedAt: EPOCH }));
    for (const cc of [EPOCH.getTime() - 1, EPOCH.getTime() + 1]) {
      const error = await refused(client(await tokenWith('u1', { cc })));
      expect(error.message, String(cc)).toBe('UNAUTHORIZED');
      expect(error.data).toMatchObject({ code: 'UNAUTHORIZED' });
    }
  });

  it('SS-H05 a legacy token (no cc) connects while the stored epoch is NULL, and is refused once an epoch is stored', async () => {
    users.set('u1', row('u1'));
    await connected(client(await signAccessToken('u1')));
    users.set('u1', row('u1', { credentialsChangedAt: EPOCH }));
    await refused(client(await signAccessToken('u1')));
  });

  it('SS-H06 an expired token, a stale one, a missing one and an unknown account are refused', async () => {
    users.set('u1', row('u1'));
    const old = Math.floor(Date.now() / 1000) - 2 * env.JWT_ACCESS_TTL_SECONDS - 60;
    await refused(client(await tokenWith('u1', {}, old)));
    await refused(client());
    await refused(client(await signAccessToken('nobody')));
  });
});

describe('every socket joins its own user room (SS-R*)', () => {
  it('SS-R01 a connected socket is in its branch rooms AND user:<id>; another user is not in that room', async () => {
    users.set('u1', row('u1', { locations: [BRANCH_A, BRANCH_B] }));
    users.set('u2', row('u2'));
    const a = client(await signAccessToken('u1')); const b = client(await signAccessToken('u2'));
    await connected(a); await connected(b);
    expect([...serverSide(a).rooms].sort()).toEqual([a.id, branchRoom(BRANCH_A), branchRoom(BRANCH_B), userRoom('u1')].sort());
    expect(serverSide(b).rooms.has(userRoom('u1'))).toBe(false);
    expect(serverSide(b).rooms.has(userRoom('u2'))).toBe(true);
    expect([userRoom('u1'), branchRoom('x')]).toEqual(['user:u1', 'branch:x']);
  });

  it('SS-R02 the user room never comes from the client: a forged auth field or query userId does not change it, and `branch:join` cannot enter a user room', async () => {
    users.set('u1', row('u1'));
    users.set('u2', row('u2'));
    const c = connect(`http://127.0.0.1:${port}`, { auth: { token: await signAccessToken('u1'), userId: 'u2' }, query: { userId: 'u2' }, autoConnect: false, reconnection: false });
    clients.push(c);
    await connected(c);
    expect(serverSide(c).rooms.has(userRoom('u2'))).toBe(false);
    expect(serverSide(c).rooms.has(userRoom('u1'))).toBe(true);
    const error = new Promise<unknown>((resolve) => c.once('realtime.error', resolve));
    c.emit('branch:join', userRoom('u2'));
    await expect(error).resolves.toEqual({ code: 'FORBIDDEN' });
    expect(serverSide(c).rooms.has(userRoom('u2'))).toBe(false);
  });
});

describe('the Socket.IO SessionRevoker (SS-D*)', () => {
  it('SS-D01 disconnectUser drops ALL of that user\'s sockets and nobody else\'s', async () => {
    users.set('ud1', row('ud1')); users.set('ud2', row('ud2'));
    const a1 = client(await signAccessToken('ud1')); const a2 = client(await signAccessToken('ud1')); const b = client(await signAccessToken('ud2'));
    await Promise.all([connected(a1), connected(a2), connected(b)]);
    const gone = Promise.all([disconnected(a1), disconnected(a2)]);
    await realtime.sessionRevoker.disconnectUser('ud1');
    expect(await gone).toEqual(['io server disconnect', 'io server disconnect']);
    expect(b.connected).toBe(true);
    expect(await realtime.io.in(userRoom('ud1')).fetchSockets()).toHaveLength(0);
    expect(await realtime.io.in(userRoom('ud2')).fetchSockets()).toHaveLength(1);
  });

  it('SS-D02 a user with no sockets is a harmless no-op', async () => {
    await expect(Promise.resolve(realtime.sessionRevoker.disconnectUser('nobody'))).resolves.toBeUndefined();
  });

  it('SS-D03 scope revocation: after the disconnect, a reconnect with a current token reads the CURRENT scopes and never re-enters the lost branch room', async () => {
    users.set('u1', row('u1', { locations: [BRANCH_A, BRANCH_B] }));
    const token = await signAccessToken('u1');
    const first = client(token);
    await connected(first);
    expect(serverSide(first).rooms.has(branchRoom(BRANCH_A))).toBe(true);
    const gone = disconnected(first);
    users.set('u1', row('u1', { locations: [BRANCH_B] })); // the scope on A was revoked (committed)
    await realtime.sessionRevoker.disconnectUser('u1');
    await gone;
    const second = client(token);
    await connected(second);
    expect(serverSide(second).rooms.has(branchRoom(BRANCH_A))).toBe(false);
    expect(serverSide(second).rooms.has(branchRoom(BRANCH_B))).toBe(true);
    // and a business event for the lost branch no longer reaches it
    const received: unknown[] = [];
    second.on(REALTIME_EVENTS.saleCompleted, (p) => received.push(p));
    realtime.emitter.emit(REALTIME_EVENTS.saleCompleted, { branchId: BRANCH_A, saleId: 's1' });
    realtime.emitter.emit(REALTIME_EVENTS.saleCompleted, { branchId: BRANCH_B, saleId: 's2' });
    await new Promise((r) => setTimeout(r, 100));
    expect(received).toEqual([{ branchId: BRANCH_B, saleId: 's2' }]);
  });
});
