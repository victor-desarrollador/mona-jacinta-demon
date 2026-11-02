import { logger } from '../shared/logger.js';

// USER-MGMT-01 U4 — realtime session revocation.
//
// A Socket.IO connection captures its authorization once, at the handshake. When an administrative or self-service mutation changes what that
// account may do (deactivated, reactivated, password reset or changed, scope assigned or revoked), the sockets that captured the OLD authorization
// must die so that a reconnect re-reads the CURRENT state. Domain services never see `io`: they receive this small contract, call it strictly AFTER
// their transaction commits (through revokeUserSessions below) and keep working when it is the no-op default.

// The ONLY places a room name is built.
export const userRoom = (userId: string): string => `user:${userId}`;
export const branchRoom = (branchId: string): string => `branch:${branchId}`;

export interface SessionRevoker {
  disconnectUser(userId: string): Promise<void> | void;
}

export function createNoopSessionRevoker(): SessionRevoker {
  return { disconnectUser: () => undefined };
}

// The post-commit side effect, in ONE place. The database change is already durable: a failing realtime layer must neither roll it back nor turn the
// HTTP answer into an error, so a failure is logged (fixed event, ids and the error TYPE only — never a token, a password or an error message that
// could carry one) and swallowed. Never call this inside a transaction.
export async function revokeUserSessions(revoker: SessionRevoker, userId: string, operation: string): Promise<void> {
  try {
    await revoker.disconnectUser(userId);
  } catch (error) {
    logger.error({ event: 'realtime_user_disconnect_failed', userId, operation, errorType: error instanceof Error ? error.name : typeof error });
  }
}
