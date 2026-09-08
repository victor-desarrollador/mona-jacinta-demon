import type { Server as HttpServer } from 'node:http';
import { jwtVerify } from 'jose';
import { Server, type Socket } from 'socket.io';
import type { PrismaClient } from '../generated/prisma/client.js';
import { env } from '../config/env.js';
import { toJsonSafe } from '../shared/json-safe.js';

export const REALTIME_EVENTS = {
  salePendingPayment: 'sale.pending_payment',
  salePaid: 'sale.paid',
  saleCompleted: 'sale.completed',
  saleCancelled: 'sale.cancelled',
  inventoryUpdated: 'inventory.updated',
} as const;

export type RealtimePayload = {
  branchId: string;
  saleId?: string;
  saleNumber?: string | null;
  status?: string;
  [key: string]: unknown;
};

export type RealtimeEmitter = { emit(event: string, payload: RealtimePayload): void };

export function createNoopRealtimeEmitter(): RealtimeEmitter {
  return { emit: () => undefined };
}

function tokenFromSocket(socket: Socket): string | undefined {
  const authToken = socket.handshake.auth?.token;
  if (typeof authToken === 'string') return authToken.replace(/^Bearer\s+/i, '');
  const authorization = socket.handshake.headers.authorization;
  return typeof authorization === 'string' ? authorization.replace(/^Bearer\s+/i, '') : undefined;
}

async function authenticateSocket(socket: Socket, database: PrismaClient) {
  const token = tokenFromSocket(socket);
  if (!token) throw new Error('UNAUTHORIZED');
  const { payload } = await jwtVerify(token, new TextEncoder().encode(env.JWT_SECRET), {
    algorithms: ['HS256'], requiredClaims: ['sub', 'iat', 'exp'], maxTokenAge: 900,
  });
  if (typeof payload.sub !== 'string' || payload.sub.length === 0) throw new Error('UNAUTHORIZED');
  const user = await database.user.findUnique({
    where: { id: payload.sub },
    select: {
      id: true, isActive: true,
      branchRoles: {
        select: {
          branchId: true,
          role: { select: { permissions: { select: { permission: { select: { code: true } } } } } },
        },
      },
    },
  });
  if (!user || !user.isActive) throw new Error('UNAUTHORIZED');
  socket.data.userId = user.id;
  socket.data.branchIds = [...new Set(user.branchRoles.map(({ branchId }) => branchId))];
  socket.data.permissions = [...new Set(user.branchRoles.flatMap(({ role }) =>
    role.permissions.map(({ permission }) => permission.code),
  ))];
}

export function createRealtime(httpServer: HttpServer, database: PrismaClient): { io: Server; emitter: RealtimeEmitter } {
  const io = new Server(httpServer, { cors: { origin: env.CORS_ORIGINS } });
  io.use((socket, next) => {
    authenticateSocket(socket, database).then(() => next()).catch(() => next(new Error('UNAUTHORIZED')));
  });
  io.on('connection', (socket) => {
    const branchIds = socket.data.branchIds as string[];
    for (const branchId of branchIds) socket.join(`branch:${branchId}`);
    socket.on('branch:join', (branchId: unknown) => {
      if (typeof branchId === 'string' && branchIds.includes(branchId)) socket.join(`branch:${branchId}`);
      else socket.emit('realtime.error', { code: 'FORBIDDEN' });
    });
  });
  return {
    io,
    emitter: { emit: (event, payload) => io.to(`branch:${payload.branchId}`).emit(event, toJsonSafe(payload)) },
  };
}