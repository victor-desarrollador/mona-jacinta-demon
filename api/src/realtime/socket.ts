import type { Server as HttpServer } from 'node:http';
import { jwtVerify } from 'jose';
import { Server, type Socket } from 'socket.io';
import type { PrismaClient } from '../generated/prisma/client.js';
import { env } from '../config/env.js';
import { toJsonSafe } from '../shared/json-safe.js';
import { buildAuthorizationContext } from '../modules/rbac/authorization-context.js';

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
      // Phase 1D.3.6: UserBranchRole no longer needs its permissions
      // selected — it contributes only role.code, for the roles[] display
      // union. It can never again contribute permission authority of any
      // kind.
      branchRoles: {
        select: {
          role: {
            select: {
              code: true,
            },
          },
        },
      },
      // Phase 1C SWITCH: LOCATION branch scope comes exclusively from
      // UserRoleScope, same as the HTTP path (middleware/auth.ts) — never
      // from branchRoles (UserBranchRole), which stays role/permission only.
      roleScopes: {
        select: {
          roleId: true,
          scopeKind: true,
          locationId: true,
          role: {
            select: {
              code: true,
              permissions: { select: { permission: { select: { code: true } } } },
            },
          },
        },
      },
    },
  });
  if (!user || !user.isActive) throw new Error('UNAUTHORIZED');
  const context = await buildAuthorizationContext(database, user);
  socket.data.userId = context.userId;
  socket.data.assignments = context.assignments;
  socket.data.effectiveLocationIds = context.effectiveLocationIds;
}

export function createRealtime(httpServer: HttpServer, database: PrismaClient): { io: Server; emitter: RealtimeEmitter } {
  const io = new Server(httpServer, { cors: { origin: env.CORS_ORIGINS } });
  io.use((socket, next) => {
    authenticateSocket(socket, database).then(() => next()).catch(() => next(new Error('UNAUTHORIZED')));
  });
  io.on('connection', (socket) => {
    // Phase 1D.5.2: socket authorization is a connection-time snapshot.
    // authenticateSocket resolves assignments/effectiveLocationIds once
    // during the handshake; this connection keeps that snapshot for room
    // membership and branch:join authorization below. UserRoleScope changes
    // are NOT hot-applied to an already-connected socket. Reconnecting
    // re-authenticates and rebuilds the context from current DB state.
    // Phase 1D deliberately does not implement live mid-connection
    // revocation because no frozen requirement calls for it.
    const effectiveLocationIds = socket.data.effectiveLocationIds as string[];
    for (const branchId of effectiveLocationIds) socket.join(`branch:${branchId}`);
    socket.on('branch:join', (branchId: unknown) => {
      if (typeof branchId === 'string' && effectiveLocationIds.includes(branchId)) socket.join(`branch:${branchId}`);
      else socket.emit('realtime.error', { code: 'FORBIDDEN' });
    });
  });
  return {
    io,
    emitter: { emit: (event, payload) => io.to(`branch:${payload.branchId}`).emit(event, toJsonSafe(payload)) },
  };
}