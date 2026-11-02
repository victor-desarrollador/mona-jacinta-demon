import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import type { PrismaClient } from '../generated/prisma/client.js';
import { env } from '../config/env.js';
import { toJsonSafe } from '../shared/json-safe.js';
import { buildAuthorizationContext } from '../modules/rbac/authorization-context.js';
import { verifyAccessToken } from '../modules/auth/tokens.js';
import { isCredentialsEpochCurrent } from '../modules/auth/credentials-epoch.js';
import { branchRoom, userRoom, type SessionRevoker } from './session-revoker.js';

export const REALTIME_EVENTS = {
  salePendingPayment: 'sale.pending_payment',
  salePaid: 'sale.paid',
  saleCompleted: 'sale.completed',
  saleCancelled: 'sale.cancelled',
  // Sale void v1: a PAID | COMPLETED sale was voided after payment. A different event from the
  // pre-payment saleCancelled on purpose: its consumers must not read a void as a cancel.
  saleVoided: 'sale.voided',
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

// The handshake refusal. The message stays the generic 'UNAUTHORIZED' (what clients already match); `data.code` carries the SAME code the HTTP
// middleware answers for the same condition.
class HandshakeRefusal extends Error {
  constructor(readonly code: 'UNAUTHORIZED' | 'INACTIVE_USER' | 'PASSWORD_CHANGE_REQUIRED') {
    super('UNAUTHORIZED');
  }
}

// USER-MGMT-01 U4: the handshake applies the SAME session rules as middleware/auth.ts and through the SAME helpers — the access-token verifier of
// modules/auth/tokens.ts (signature, claims and the one canonical lifetime ACCESS_TOKEN_SECONDS) and isCredentialsEpochCurrent — against the CURRENT
// database row: the account exists, is active, has no pending password change, and the token's credentials epoch (`cc`) equals the stored one.
async function authenticateSocket(socket: Socket, database: PrismaClient) {
  const token = tokenFromSocket(socket);
  if (!token) throw new HandshakeRefusal('UNAUTHORIZED');
  const { payload } = await verifyAccessToken(token);
  if (typeof payload.sub !== 'string' || payload.sub.length === 0) throw new HandshakeRefusal('UNAUTHORIZED');
  const user = await database.user.findUnique({
    where: { id: payload.sub },
    select: {
      id: true, isActive: true, mustChangePassword: true, credentialsChangedAt: true,
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
  if (!user) throw new HandshakeRefusal('UNAUTHORIZED');
  if (!user.isActive) throw new HandshakeRefusal('INACTIVE_USER');
  if (!isCredentialsEpochCurrent(payload.cc, user.credentialsChangedAt)) throw new HandshakeRefusal('UNAUTHORIZED');
  if (user.mustChangePassword) throw new HandshakeRefusal('PASSWORD_CHANGE_REQUIRED');
  const context = await buildAuthorizationContext(database, user);
  socket.data.userId = context.userId;
  socket.data.assignments = context.assignments;
  socket.data.effectiveLocationIds = context.effectiveLocationIds;
}

export function createRealtime(httpServer: HttpServer, database: PrismaClient): { io: Server; emitter: RealtimeEmitter; sessionRevoker: SessionRevoker } {
  const io = new Server(httpServer, { cors: { origin: env.CORS_ORIGINS } });
  io.use((socket, next) => {
    authenticateSocket(socket, database).then(() => next()).catch((error: unknown) => {
      const refusal = new Error('UNAUTHORIZED') as Error & { data?: { code: string } };
      refusal.data = { code: error instanceof HandshakeRefusal ? error.code : 'UNAUTHORIZED' };
      next(refusal);
    });
  });
  io.on('connection', (socket) => {
    // Phase 1D.5.2: socket authorization is a connection-time snapshot.
    // authenticateSocket resolves assignments/effectiveLocationIds once
    // during the handshake; this connection keeps that snapshot for room
    // membership and branch:join authorization below. UserRoleScope changes
    // are NOT hot-applied to an already-connected socket. Reconnecting
    // re-authenticates and rebuilds the context from current DB state.
    // USER-MGMT-01 U4: the snapshot is no longer immortal. Every socket also joins `user:<id>` (the id of the VERIFIED token's account, never a
    // client-supplied value), and the SessionRevoker below drops that room's sockets after any mutation that changes the account's authorization
    // (deactivate, reactivate, password reset/change, scope assign/revoke); the client reconnects and the handshake rebuilds the context.
    const effectiveLocationIds = socket.data.effectiveLocationIds as string[];
    socket.join(userRoom(socket.data.userId as string));
    for (const branchId of effectiveLocationIds) socket.join(branchRoom(branchId));
    socket.on('branch:join', (branchId: unknown) => {
      if (typeof branchId === 'string' && effectiveLocationIds.includes(branchId)) socket.join(branchRoom(branchId));
      else socket.emit('realtime.error', { code: 'FORBIDDEN' });
    });
  });
  return {
    io,
    emitter: { emit: (event, payload) => io.to(branchRoom(payload.branchId)).emit(event, toJsonSafe(payload)) },
    // Single-instance only: the room lives in this process's in-memory adapter. Scaling out needs a distributed adapter (e.g. Redis).
    sessionRevoker: { disconnectUser: (userId) => { io.in(userRoom(userId)).disconnectSockets(true); } },
  };
}