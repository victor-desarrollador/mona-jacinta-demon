import { createServer } from 'node:http';
import { io as connect, type Socket as ClientSocket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getAuthToken } from '../helpers/auth.js';
import { createRealtime, REALTIME_EVENTS } from '../../src/realtime/socket.js';

type SocketDatabase = {
  user: { findUnique: ReturnType<typeof vi.fn> };
};

const userId = 'user-realtime';
const centroId = 'branch-centro';
const yerbaId = 'branch-yerba';
const database: SocketDatabase = { user: { findUnique: vi.fn() } };
const server = createServer();
const realtime = createRealtime(server, database as never);
let port: number;
let token: string;
const clients: ClientSocket[] = [];

// scopeBranchIds defaults to branchIds so existing call sites keep both
// authorities in sync (matching tests/helpers/factories.ts's createTestUser).
// Phase 1C SWITCH: only roleScopes (UserRoleScope) should determine
// socket.data.effectiveLocationIds — branchRoles (UserBranchRole) stays
// role/permission only — so passing a different scopeBranchIds lets a test
// prove the two authorities are no longer conflated here. Phase 1D.1: each
// roleScopes row's role now also carries `permissions` (Production
// uppercase) so buildAuthorizationContext can build its per-assignment
// permissions array without crashing on a stub fixture.
function userWithBranches(branchIds: string[], scopeBranchIds: string[] = branchIds) {
  return {
    id: userId,
    isActive: true,
    branchRoles: branchIds.map((branchId) => ({
      branchId,
      role: { code: 'CASHIER', permissions: [{ permission: { code: 'sale.view' } }] },
    })),
    roleScopes: scopeBranchIds.map((locationId) => ({
      roleId: 'role-cashier',
      scopeKind: 'LOCATION' as const,
      locationId,
      role: { code: 'CASHIER', permissions: [{ permission: { code: 'CASH_SESSION_OPEN' } }] },
    })),
  };
}

function connectClient(authToken?: string) {
  const client = connect(`http://127.0.0.1:${port}`, {
    auth: authToken ? { token: authToken } : undefined,
    autoConnect: false,
    reconnection: false,
  });
  clients.push(client);
  return client;
}

function connected(client: ClientSocket) {
  return new Promise<void>((resolve, reject) => {
    client.once('connect', () => resolve());
    client.once('connect_error', reject);
    client.connect();
  });
}

beforeAll(async () => {
  database.user.findUnique.mockResolvedValue(userWithBranches([centroId]));
  token = await getAuthToken({ id: userId });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => {
    port = (server.address() as { port: number }).port;
    resolve();
  }));
});

afterAll(async () => {
  for (const client of clients) client.close();
  await new Promise<void>((resolve) => realtime.io.close(() => resolve()));
  server.close();
});

describe('Socket.IO realtime', () => {
  it('rechaza sockets sin autenticación', async () => {
    const client = connectClient();
    await expect(connected(client)).rejects.toMatchObject({ message: 'UNAUTHORIZED' });
  });

  it('conecta usuarios válidos y limita rooms a sucursales autorizadas', async () => {
    const client = connectClient(token);
    await connected(client);
    const serverSocket = realtime.io.sockets.sockets.get(client.id!);
    expect(serverSocket?.rooms.has(`branch:${centroId}`)).toBe(true);

    const error = new Promise<unknown>((resolve) => client.once('realtime.error', resolve));
    client.emit('branch:join', yerbaId);
    await expect(error).resolves.toEqual({ code: 'FORBIDDEN' });
    expect(serverSocket?.rooms.has(`branch:${yerbaId}`)).toBe(false);
  });

  it('respeta el acceso revocado al reconectar', async () => {
    const client = connectClient(token);
    await connected(client);
    client.disconnect();
    database.user.findUnique.mockResolvedValue(userWithBranches([]));
    await connected(client);
    const serverSocket = realtime.io.sockets.sockets.get(client.id!);
    expect([...serverSocket?.rooms ?? []]).toEqual([client.id]);
  });

  it('deriva las branch rooms desde UserRoleScope, no desde UserBranchRole legado', async () => {
    // UserBranchRole (legacy role/permission source) still says Centro;
    // UserRoleScope (Phase 1C authoritative LOCATION source) says Yerba
    // Buena only. The socket must join Yerba Buena, never Centro.
    database.user.findUnique.mockResolvedValue(userWithBranches([centroId], [yerbaId]));
    const client = connectClient(token);
    await connected(client);
    const serverSocket = realtime.io.sockets.sockets.get(client.id!);
    expect(serverSocket?.rooms.has(`branch:${yerbaId}`)).toBe(true);
    expect(serverSocket?.rooms.has(`branch:${centroId}`)).toBe(false);
  });

  it('produce cero branch rooms con UserRoleScope vacío aunque UserBranchRole siga vigente', async () => {
    database.user.findUnique.mockResolvedValue(userWithBranches([centroId], []));
    const client = connectClient(token);
    await connected(client);
    const serverSocket = realtime.io.sockets.sockets.get(client.id!);
    expect([...serverSocket?.rooms ?? []]).toEqual([client.id]);
  });

  it('expone socket.data.assignments con la forma de asignación, nunca aplanada (Phase 1D.1)', async () => {
    database.user.findUnique.mockResolvedValue(userWithBranches([centroId]));
    const client = connectClient(token);
    await connected(client);
    const serverSocket = realtime.io.sockets.sockets.get(client.id!);
    expect(serverSocket?.data.assignments).toEqual([
      {
        roleId: 'role-cashier',
        roleCode: 'CASHIER',
        scopeKind: 'LOCATION',
        locationId: centroId,
        permissions: ['CASH_SESSION_OPEN'],
      },
    ]);
  });

  it('emite solo después de una operación comprometida y serializa BigInt', async () => {
    database.user.findUnique.mockResolvedValue(userWithBranches([centroId]));
    const client = connectClient(token);
    await connected(client);
    const received = new Promise<unknown>((resolve) => client.once(REALTIME_EVENTS.salePaid, resolve));
    const failedEmitter = vi.fn(realtime.emitter.emit);
    try {
      await Promise.reject(new Error('rollback'));
    } catch {
      // A failed transaction has no post-commit emission.
    }
    expect(failedEmitter).not.toHaveBeenCalled();
    realtime.emitter.emit(REALTIME_EVENTS.salePaid, {
      branchId: centroId,
      saleId: 'sale-1',
      status: 'PAID',
      amount: 16500000n,
    });
    await expect(received).resolves.toEqual({
      branchId: centroId,
      saleId: 'sale-1',
      status: 'PAID',
      amount: '16500000',
    });
  });
});
