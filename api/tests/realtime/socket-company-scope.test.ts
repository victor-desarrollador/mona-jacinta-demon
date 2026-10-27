// SECURITY-RBAC-01a — Socket.IO room membership derives from
// effectiveLocationIds, which buildAuthorizationContext must compute from valid
// rows only: COMPANY is valid only for OWNER/ADMIN. An invalid CASHIER +
// COMPANY row must not join every branch room nor unlock branch:join for
// another branch. DB-free: the token is signed here with jose (same claims as
// tests/helpers/auth.ts) so this file never imports the database helpers.
import { createServer } from 'node:http';
import { SignJWT } from 'jose';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { env } from '../../src/config/env.js';
import { createRealtime } from '../../src/realtime/socket.js';

const userId = 'user-realtime-rbac01';
const centroId = 'branch-centro';
const yerbaId = 'branch-yerba';
const database = { user: { findUnique: vi.fn() }, location: { findMany: vi.fn() } };
const server = createServer();
const realtime = createRealtime(server, database as never);
const clients: ClientSocket[] = [];
let port: number;

async function token() {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT()
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(new TextEncoder().encode(env.JWT_SECRET));
}

function connected(client: ClientSocket) {
  return new Promise<void>((resolve, reject) => {
    client.once('connect', () => resolve());
    client.once('connect_error', reject);
    client.connect();
  });
}

beforeAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      port = (server.address() as { port: number }).port;
      resolve();
    });
  });
});

afterAll(async () => {
  for (const client of clients) client.close();
  await new Promise<void>((resolve) => realtime.io.close(() => resolve()));
  server.close();
});

describe('Socket.IO rooms — COMPANY only for OWNER/ADMIN (SECURITY-RBAC-01a)', () => {
  it('an invalid CASHIER + COMPANY row joins no extra room and branch:join to another branch is FORBIDDEN', async () => {
    database.location.findMany.mockResolvedValue([{ id: centroId }, { id: yerbaId }]);
    database.user.findUnique.mockResolvedValue({
      id: userId,
      isActive: true,
      branchRoles: [],
      roleScopes: [
        { roleId: 'role-cashier', scopeKind: 'LOCATION', locationId: centroId, role: { code: 'CASHIER', permissions: [{ permission: { code: 'SALE_CHARGE' } }] } },
        { roleId: 'role-cashier', scopeKind: 'COMPANY', locationId: null, role: { code: 'CASHIER', permissions: [{ permission: { code: 'SALE_CHARGE' } }] } },
      ],
    });
    const client = connect(`http://127.0.0.1:${port}`, { auth: { token: await token() }, autoConnect: false, reconnection: false });
    clients.push(client);
    await connected(client);
    const serverSocket = realtime.io.sockets.sockets.get(client.id!);
    expect([...serverSocket?.rooms ?? []].sort()).toEqual([`branch:${centroId}`, client.id].sort());
    expect(database.location.findMany).not.toHaveBeenCalled();

    const error = new Promise<unknown>((resolve) => client.once('realtime.error', resolve));
    client.emit('branch:join', yerbaId);
    await expect(error).resolves.toEqual({ code: 'FORBIDDEN' });
    expect(serverSocket?.rooms.has(`branch:${yerbaId}`)).toBe(false);
  });
});
