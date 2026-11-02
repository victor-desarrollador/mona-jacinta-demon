import type { PrismaClient } from '../../generated/prisma/client.js';
import { AppError } from '../../shared/errors.js';
import { isTransientTransactionError } from '../../shared/transient-transaction-error.js';
import { createAuditLog } from '../../shared/audit.js';
import {
  buildAuthorizationContext,
  type AuthorizationContextInput,
} from '../rbac/authorization-context.js';
import { toPublicUserContext, type PublicBranchLabel, type PublicSessionUser } from './user-context.dto.js';
import { hashPassword, verifyPassword } from './password.js';
import { assertPasswordPolicy } from './password-policy.js';
import { nextCredentialsEpoch } from './credentials-epoch.js';
import { signAccessToken } from './tokens.js';
import { createNoopSessionRevoker, revokeUserSessions, type SessionRevoker } from '../../realtime/session-revoker.js';
import type { LoginInput } from './dto/login.dto.js';
import type { ChangePasswordInput } from './dto/change-password.dto.js';

type AuthDatabase = Pick<PrismaClient, 'user' | 'location' | '$queryRaw'>;

type UserRow = AuthorizationContextInput & {
  name: string; email: string; isActive: boolean; passwordHash: string;
  // USER-MGMT-01 U1 (G21): the pending-change flag and the credentials epoch the token's `cc` claim must equal.
  mustChangePassword: boolean; credentialsChangedAt: Date | null;
};

const userSelect = {
  id: true,
  name: true,
  email: true,
  isActive: true,
  passwordHash: true,
  mustChangePassword: true,
  credentialsChangedAt: true,
  // Phase 1D.3.6: UserBranchRole no longer needs its permissions selected —
  // it contributes only role.code, for the roles[] display union. It can
  // never again contribute permission authority of any kind.
  branchRoles: {
    select: {
      role: {
        select: {
          code: true,
        },
      },
    },
  },
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
} as const;

// Public API contract boundary: buildAuthorizationContext's internal,
// Production-authorization-shaped AuthContext (assignments/
// effectiveLocationIds) is deliberately NOT returned to callers of
// login/resolveUserContext — see user-context.dto.ts for why. This is the
// only place the internal context and the public DTO meet.
//
// `branches` is display data for the client's branch selector (id, name, code), read for the caller's EFFECTIVE locations only and returned
// in `branchIds` order. It never feeds an authorization decision: the selector's options still come from `branchIds`.
async function contextFromUser(database: AuthDatabase, user: UserRow): Promise<PublicSessionUser> {
  const context = await buildAuthorizationContext(database, user);
  const publicContext = toPublicUserContext(user, context);
  const ids = publicContext.branchIds;
  const rows = ids.length === 0 ? [] : await database.location.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, code: true } });
  const byId = new Map(rows.filter((row) => typeof row.name === 'string' && typeof row.code === 'string').map((row) => [row.id, row]));
  const branches = ids.flatMap((id): PublicBranchLabel[] => {
    const row = byId.get(id);
    return row ? [{ id: row.id, name: row.name, code: row.code }] : [];
  });
  return { ...publicContext, branches };
}

export async function resolveUserContext(database: AuthDatabase, userId: string): Promise<PublicSessionUser> {
  const user = await database.user.findUnique({ where: { id: userId }, select: userSelect });
  if (!user) throw new AppError(401, 'UNAUTHORIZED', 'El token no es válido.');
  if (!user.isActive) throw new AppError(403, 'INACTIVE_USER', 'El usuario está inactivo.');
  return contextFromUser(database, user);
}

export async function login(database: AuthDatabase, input: LoginInput): Promise<{ accessToken: string; user: PublicSessionUser }> {
  // USER-MGMT-01 U2 (G22): e-mail is case-insensitive. lower("email") is unique (User_email_lower_key), so this finds at most one account, whatever
  // capitalisation it was stored with (historical rows keep theirs) or typed with now.
  const [match] = await database.$queryRaw<Array<{ id: string }>>`SELECT id FROM "User" WHERE lower("email") = lower(${input.email})`;
  const user = match ? await database.user.findUnique({ where: { id: match.id }, select: userSelect }) : null;
  if (!user || !(await verifyPassword(input.password, user.passwordHash)))
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Las credenciales no son válidas.');
  if (!user.isActive) throw new AppError(403, 'INACTIVE_USER', 'El usuario está inactivo.');
  const context = await contextFromUser(database, user);
  // The token carries the credentials epoch (`cc`); absent while the account never changed credentials.
  return { accessToken: await signAccessToken(user.id, user.credentialsChangedAt), user: context };
}

// USER-MGMT-01 U1 — an account changes ITS OWN password.
//
// Race-safe by construction. The new password is validated (policy) and hashed BEFORE the transaction (bcrypt is ~250 ms and must not hold
// a row lock for nothing), but the CURRENT password is verified INSIDE the transaction against the hash read UNDER the row lock
// (SELECT ... FOR NO KEY UPDATE). Two simultaneous requests with the same current password therefore cannot both win: the second one
// waits for the lock, re-reads the winner's committed hash, fails the verification (INVALID_CURRENT_PASSWORD) and writes nothing.
// READ COMMITTED (the engine default) is the right level for that: the lock makes the waiter re-read the committed row, whereas a
// Serializable transaction would answer a retryable 40001 instead of the domain refusal. Same pattern as the scope assignment service.
//
// In the same transaction: the password hash, mustChangePassword = false, the credentials epoch (nextCredentialsEpoch: strictly after the
// stored one whatever the clock does) and the USER_PASSWORD_CHANGED audit (a failing audit rolls everything back). The new access token
// is signed only AFTER the commit, with the COMMITTED epoch as `cc`; every older token fails the epoch equality on its next request.
// Nothing secret is audited, logged or returned beyond the new token.
type ChangePasswordDatabase = AuthDatabase & Pick<PrismaClient, '$transaction'>;
type LockedUser = { id: string; email: string; passwordHash: string; isActive: boolean; mustChangePassword: boolean; credentialsChangedAt: Date | null };
const MAX_TRANSACTION_ATTEMPTS = 3;

export async function changePassword(
  database: ChangePasswordDatabase,
  userId: string,
  input: ChangePasswordInput,
  sessionRevoker: SessionRevoker = createNoopSessionRevoker(),
): Promise<{ accessToken: string; user: PublicSessionUser }> {
  const known = await database.user.findUnique({ where: { id: userId }, select: { email: true, isActive: true } });
  if (!known) throw new AppError(401, 'UNAUTHORIZED', 'El token no es válido.');
  if (!known.isActive) throw new AppError(403, 'INACTIVE_USER', 'El usuario está inactivo.');
  assertPasswordPolicy({ password: input.newPassword, email: known.email, currentPassword: input.currentPassword });
  const newHash = await hashPassword(input.newPassword);

  let epoch: Date | null = null;
  for (let attempt = 1; epoch === null; attempt += 1) {
    try {
      epoch = await database.$transaction(async (tx) => {
        const [locked] = await tx.$queryRaw<LockedUser[]>`
          SELECT id, email, "passwordHash", "isActive", "mustChangePassword", "credentialsChangedAt"
          FROM "User" WHERE id = ${userId} FOR NO KEY UPDATE
        `;
        if (!locked) throw new AppError(401, 'UNAUTHORIZED', 'El token no es válido.');
        if (!locked.isActive) throw new AppError(403, 'INACTIVE_USER', 'El usuario está inactivo.');
        // The CURRENT password against the hash that is current NOW, under the lock.
        if (!(await verifyPassword(input.currentPassword, locked.passwordHash))) {
          throw new AppError(400, 'INVALID_CURRENT_PASSWORD', 'La contraseña actual no es correcta.');
        }
        assertPasswordPolicy({ password: input.newPassword, email: locked.email, currentPassword: input.currentPassword });
        const next = nextCredentialsEpoch(locked.credentialsChangedAt, new Date());
        await tx.user.update({ where: { id: userId }, data: { passwordHash: newHash, mustChangePassword: false, credentialsChangedAt: next } });
        await createAuditLog(tx, {
          userId, branchId: null, action: 'USER_PASSWORD_CHANGED', entityType: 'User', entityId: userId,
          before: { mustChangePassword: locked.mustChangePassword, credentialsChangedAt: locked.credentialsChangedAt?.toISOString() ?? null },
          after: { mustChangePassword: false, credentialsChangedAt: next.toISOString() },
        });
        return next;
      });
    } catch (error) {
      if (!isTransientTransactionError(error)) throw error;
      if (attempt >= MAX_TRANSACTION_ATTEMPTS) throw new AppError(409, 'CONCURRENCY_ERROR', 'La operación no pudo completarse por concurrencia.');
    }
  }
  // USER-MGMT-01 U4: after the COMMIT, the sockets opened with the previous credentials die (their epoch is stale); the HTTP session that made this call
  // gets the new token below and is untouched. A failing realtime layer cannot fail this call (revokeUserSessions swallows and logs).
  await revokeUserSessions(sessionRevoker, userId, 'USER_PASSWORD_CHANGED');
  return { accessToken: await signAccessToken(userId, epoch), user: await resolveUserContext(database, userId) };
}
