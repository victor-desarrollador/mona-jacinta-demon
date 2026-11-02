// USER-MGMT-01 U4 — the opt-in PostgreSQL + Socket.IO end-to-end gate: a REAL HTTP server with the real app, the real Socket.IO server wired as the
// SessionRevoker, and a real disposable database. OPT-IN ONLY; same environment contract as user-admin.pg.test.ts
// (MONA_USER_ADMIN_PG=1 MONA_USER_ADMIN_PG_DISPOSABLE=1 MONA_TEST_DATABASE_TARGET=local LOCAL_TEST_DATABASE_URL=… LOCAL_TEST_DATABASE_MARKER_ID=…
// MONA_USER_ADMIN_PG_SYSTEM_ID=…). Fixtures are committed and permanent (unique e-mails/codes); the cluster is discarded afterwards.
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import type { Pool } from 'pg';
import request from 'supertest';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assembleServer } from '../../src/server.js';
import { PrismaClient } from '../../src/generated/prisma/client.js';
import { hashPassword } from '../../src/modules/auth/password.js';
import { signAccessToken } from '../../src/modules/auth/tokens.js';
import type { createRealtime } from '../../src/realtime/socket.js';
import { REALTIME_EVENTS } from '../../src/realtime/socket.js';
import { branchRoom, userRoom } from '../../src/realtime/session-revoker.js';
import { PG_SYSTEM_ID, RACE_TIMEOUT_MS } from '../helpers/r3-service-pg.js';

const enabled = process.env.MONA_USER_ADMIN_PG === '1';
const BASE = '/api/v1/backoffice/users';
const CURRENT = 'current-password-123';
const posFor = (tag: string) => 17 * 10_000_000 + parseInt(tag.slice(0, 5), 16);

describe.skipIf(!enabled)('USER-MGMT-01 U4 on PostgreSQL + Socket.IO — session revocation end to end (disposable cluster)', () => {
  let pool: Pool;
  let db: PrismaClient;
  let realtime: ReturnType<typeof createRealtime>;
  let server: import('node:http').Server;
  const clients: ClientSocket[] = [];
  let port = 0;
  let currentHash = '';
  const roleId: Record<string, string> = {};
  let companyId = '';
  let ownerId = '';
  let ownerHeader: { Authorization: string };

  beforeAll(async () => {
    if (process.env.MONA_USER_ADMIN_PG_DISPOSABLE !== '1') throw new Error('this suite writes permanent rows: MONA_USER_ADMIN_PG_DISPOSABLE=1 is required');
    if (process.env.MONA_TEST_DATABASE_TARGET !== 'local') throw new Error('LOCAL_TEST selector required');
    const expectedSystemId = process.env.MONA_USER_ADMIN_PG_SYSTEM_ID;
    if (!expectedSystemId || !PG_SYSTEM_ID.test(expectedSystemId)) throw new Error('isolated cluster binding is missing');
    const { openProvenLocalTestPool } = await import('../../scripts/demo-database.js');
    ({ pool } = await openProvenLocalTestPool(8, process.env));
    db = new PrismaClient({ adapter: new PrismaPg(pool, { schema: 'public' }), log: [] });
    const { rows } = await pool.query<{ system_id: string }>('SELECT system_identifier::text AS system_id FROM pg_control_system()');
    if (rows[0]?.system_id !== expectedSystemId) throw new Error('isolated PostgreSQL cluster does not match binding');
    currentHash = await hashPassword(CURRENT);
    for (const code of ['OWNER', 'CASHIER', 'SELLER']) roleId[code] = (await db.role.findUniqueOrThrow({ where: { code } })).id;
    companyId = (await db.company.findFirstOrThrow()).id;
    // The REAL assembly of server.ts (U4.1): the request listener is installed before Socket.IO attaches, so /socket.io/ is Engine.IO's alone.
    ({ server, realtime } = assembleServer(db));
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); port = (server.address() as { port: number }).port; resolve(); }); });
    ownerId = randomUUID();
    await db.user.create({ data: { id: ownerId, name: 'U4 Owner', email: `u4-owner-${ownerId.slice(0, 8)}@test.invalid`, passwordHash: currentHash } });
    await db.userRoleScope.create({ data: { userId: ownerId, roleId: roleId.OWNER!, scopeKind: 'COMPANY', locationId: null } });
    ownerHeader = { Authorization: `Bearer ${await signAccessToken(ownerId, null)}` };
  });

  afterAll(async () => {
    for (const c of clients) c.close();
    await new Promise<void>((resolve) => realtime.io.close(() => resolve()));
    server.close();
    await db.$disconnect();
    await pool.end();
  });

  const tag = () => randomUUID().replace(/-/g, '').slice(0, 10);
  const key = () => randomUUID();
  async function makeLocation(): Promise<string> {
    const t = tag();
    return (await db.location.create({ data: { companyId, name: `U4 ${t}`, code: `U4-${t}`, type: 'RETAIL_BRANCH', address: 'u4', pointOfSaleNumber: posFor(t) } })).id;
  }
  async function makeSeller(locations: string[]): Promise<{ id: string; email: string }> {
    const id = randomUUID();
    const email = `u4-seller-${id.slice(0, 8)}@test.invalid`;
    await db.user.create({ data: { id, name: `U4 ${id.slice(0, 6)}`, email, passwordHash: currentHash } });
    for (const locationId of locations) await db.userRoleScope.create({ data: { userId: id, roleId: roleId.SELLER!, scopeKind: 'LOCATION', locationId } });
    return { id, email };
  }
  function client(token: string): ClientSocket {
    const c = connect(`http://127.0.0.1:${port}`, { auth: { token }, autoConnect: false, reconnection: false });
    clients.push(c);
    return c;
  }
  const connected = (c: ClientSocket) => new Promise<void>((resolve, reject) => { c.once('connect', () => resolve()); c.once('connect_error', reject); c.connect(); });
  const refused = (c: ClientSocket) => new Promise<{ message: string; data?: { code?: string } }>((resolve, reject) => { c.once('connect_error', resolve); c.once('connect', () => reject(new Error('connected'))); c.connect(); });
  const dropped = (c: ClientSocket) => new Promise<string>((resolve) => c.once('disconnect', resolve));
  const settled = () => new Promise((r) => setTimeout(r, 150));

  it('PG-U4-01 deactivate over HTTP: the committed change cuts the target\'s socket (and only its), the next handshake is INACTIVE_USER, a bystander stays connected', async () => {
    const loc = await makeLocation();
    const victim = await makeSeller([loc]); const bystander = await makeSeller([loc]);
    const vSocket = client(await signAccessToken(victim.id, null)); const bSocket = client(await signAccessToken(bystander.id, null));
    await Promise.all([connected(vSocket), connected(bSocket)]);
    const gone = dropped(vSocket);
    const res = await request(`http://127.0.0.1:${port}`).post(`${BASE}/${victim.id}/deactivate`).set(ownerHeader).send({ idempotencyKey: key() });
    expect(res.status).toBe(200);
    expect(await gone).toBe('io server disconnect');
    expect(bSocket.connected).toBe(true);
    expect((await db.user.findUniqueOrThrow({ where: { id: victim.id } })).isActive).toBe(false);
    const again = await refused(client(await signAccessToken(victim.id, null)));
    expect(again.data?.code).toBe('INACTIVE_USER');
  }, RACE_TIMEOUT_MS);

  it('PG-U4-02 reset over HTTP: the socket dies; neither the old token nor the temporary-password token (pending change) can reconnect; after the forced change the NEW token can', async () => {
    const loc = await makeLocation();
    const target = await makeSeller([loc]);
    const oldToken = await signAccessToken(target.id, null);
    const s = client(oldToken);
    await connected(s);
    const gone = dropped(s);
    const reset = await request(`http://127.0.0.1:${port}`).post(`${BASE}/${target.id}/reset-password`).set(ownerHeader).send({ idempotencyKey: key() });
    expect(reset.status).toBe(200);
    await gone;
    expect((await refused(client(oldToken))).data?.code).toBe('UNAUTHORIZED'); // the epoch moved
    const login = await request(`http://127.0.0.1:${port}`).post('/api/v1/auth/login').send({ email: target.email, password: reset.body.temporaryPassword });
    expect(login.status).toBe(200);
    expect((await refused(client(login.body.accessToken))).data?.code).toBe('PASSWORD_CHANGE_REQUIRED');
    const changed = await request(`http://127.0.0.1:${port}`).post('/api/v1/auth/change-password').set({ Authorization: `Bearer ${login.body.accessToken}` }).send({ currentPassword: reset.body.temporaryPassword, newPassword: 'definitive-password-789' });
    expect(changed.status).toBe(200);
    await connected(client(changed.body.accessToken));
  }, RACE_TIMEOUT_MS);

  it('PG-U4-03 own password change: the OLD socket dies, the new token returned by the very same request connects', async () => {
    const loc = await makeLocation();
    const me = await makeSeller([loc]);
    const oldToken = await signAccessToken(me.id, null);
    const s = client(oldToken);
    await connected(s);
    const gone = dropped(s);
    const res = await request(`http://127.0.0.1:${port}`).post('/api/v1/auth/change-password').set({ Authorization: `Bearer ${oldToken}` }).send({ currentPassword: CURRENT, newPassword: 'definitive-password-789' });
    expect(res.status).toBe(200);
    await gone;
    await connected(client(res.body.accessToken));
  }, RACE_TIMEOUT_MS);

  it('PG-U4-04 scope revoke over HTTP: the socket on branch A dies; the reconnect reads the CURRENT scopes (no branch:A room, no sale events from A)', async () => {
    const a = await makeLocation(); const b = await makeLocation();
    const worker = await makeSeller([a, b]);
    const token = await signAccessToken(worker.id, null);
    const first = client(token);
    await connected(first);
    const gone = dropped(first);
    // revoke the whole SELLER scope, then give back only B (two effective mutations, two disconnects of whatever is connected)
    expect((await request(`http://127.0.0.1:${port}`).delete(`${BASE}/${worker.id}/scope/SELLER`).set(ownerHeader)).status).toBe(200);
    await gone;
    expect((await request(`http://127.0.0.1:${port}`).post(`${BASE}/${worker.id}/scope`).set(ownerHeader).send({ roleCode: 'SELLER', scopeKind: 'LOCATION', locationIds: [b] })).status).toBe(200);
    const second = client(token);
    await connected(second);
    const server_ = realtime.io.sockets.sockets.get(second.id!)!;
    expect(server_.rooms.has(branchRoom(a))).toBe(false);
    expect(server_.rooms.has(branchRoom(b))).toBe(true);
    expect(server_.rooms.has(userRoom(worker.id))).toBe(true);
    const seen: unknown[] = [];
    second.on(REALTIME_EVENTS.saleCompleted, (p) => seen.push(p));
    realtime.emitter.emit(REALTIME_EVENTS.saleCompleted, { branchId: a, saleId: 'from-a' });
    realtime.emitter.emit(REALTIME_EVENTS.saleCompleted, { branchId: b, saleId: 'from-b' });
    await settled();
    expect(seen).toEqual([{ branchId: b, saleId: 'from-b' }]);
  }, RACE_TIMEOUT_MS);

  it('PG-U4-05 reactivate over HTTP leaves no residual socket; create and edit do not touch a live one', async () => {
    const loc = await makeLocation();
    const worker = await makeSeller([loc]);
    const s = client(await signAccessToken(worker.id, null));
    await connected(s);
    expect((await request(`http://127.0.0.1:${port}`).patch(`${BASE}/${worker.id}`).set(ownerHeader).send({ name: 'Nuevo Nombre', email: `u4-renamed-${tag()}@test.invalid` })).status).toBe(200);
    await settled();
    expect(s.connected).toBe(true); // name/e-mail do not take part in authorization
    const created = await request(`http://127.0.0.1:${port}`).post(BASE).set(ownerHeader).send({ name: 'Nueva Persona', email: `u4-new-${tag()}@test.invalid`, roleCode: 'SELLER', scopeKind: 'LOCATION', locationIds: [loc], idempotencyKey: key() });
    expect(created.status).toBe(201);
    await settled();
    expect(s.connected).toBe(true);
    await db.user.update({ where: { id: worker.id }, data: { isActive: false } }); // an account that was deactivated by some other means keeps a stale socket
    const gone = dropped(s);
    expect((await request(`http://127.0.0.1:${port}`).post(`${BASE}/${worker.id}/reactivate`).set(ownerHeader).send({ idempotencyKey: key() })).status).toBe(200);
    await gone;
  }, RACE_TIMEOUT_MS);
});
