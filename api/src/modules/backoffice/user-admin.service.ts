import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import { AppError } from '../../shared/errors.js';
import { createAuditLog } from '../../shared/audit.js';
import { isTransientTransactionError } from '../../shared/transient-transaction-error.js';
import { uniqueViolation } from '../payments/prisma-unique-violation.js';
import { ROLE_CODES, type RoleCode } from '../rbac/index.js';
import { nextCredentialsEpoch } from '../auth/credentials-epoch.js';
import { hashPassword } from '../auth/password.js';
import { generateTemporaryPassword } from '../auth/temporary-password.js';
import { assertAnotherOperativeOwner, assertCanAdminister, assertCanAssignRoleCode, assertCanManageTarget, lockLastOwnerGuard } from './user-admin-policy.js';
import { assertProductionRoleCode, assertRoleScopeCompatible, lockAndAssertLocationsActive } from './scope-assignment.service.js';
import { canonicalRequestHash, normalizeEmail, normalizeName, type UserAdminOperationName } from './user-admin-request.js';
import { createNoopSessionRevoker, revokeUserSessions, type SessionRevoker } from '../../realtime/session-revoker.js';
import type { AdminOperationInput, CreateUserInput, UpdateUserInput } from './user-admin.dto.js';

// USER-MGMT-01 U2 — the administrative identity lifecycle: create, edit name/e-mail, deactivate, reactivate, reset password.
//
// ONE pattern for every operation, all inside ONE transaction (READ COMMITTED + row locks, the same discipline as scope-assignment.service.ts):
//   1. the target User row is locked FOR NO KEY UPDATE (it never conflicts with the FK KEY SHARE locks the audit/operation inserts take on
//      the actor, so two admins acting on each other cannot deadlock; it serializes every operation on the same target);
//   2. the caller's authority over THAT target is decided from the locked state (never from an earlier read);
//   3. the idempotency record (actorId, idempotencyKey) is looked up: same intent = replay (answered from the current state, NOTHING written, no
//      password), another intent = 409 IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD;
//   4. the mutation, the UserAdminOperation record and the AuditLog row are written together: any failure rolls ALL of it back.
// The temporary password is generated and bcrypt-hashed BEFORE the transaction (a ~250 ms hash must not hold a row lock), is returned exactly
// once to the caller of the operation that really issued it, and exists nowhere else: not in the record, not in the audit, not in a log.
//
// A unique violation raised by a concurrent winner (the e-mail index, the (actorId, idempotencyKey) record) or a transient serialization failure
// rolls the attempt back and the operation RETRIES from the top: the second attempt then sees the winner's committed rows and resolves to the
// domain answer (EMAIL_TAKEN, a replay, a 409) instead of leaking a raw database error.
//
// Authorization (U3): every decision comes from user-admin-policy.ts (shared with scope-assignment.service.ts) and is taken from the target's REAL scope
// rows read under its row lock, BEFORE the idempotency record is consulted — a replay never bypasses the caller's CURRENT authority. Deactivating an
// operative OWNER additionally needs another one left (LAST_OWNER_PROTECTED, advisory lock first, then the target row lock). USER_MANAGE itself stays
// the route's gate (backoffice.routes.ts is the only caller path), and the policy re-checks the actor's COMPANY authority here.

type RequestLike = { auth?: Express.AuthContext };
type UserAdminDatabase = Pick<PrismaClient, 'role' | '$transaction'>;

export type AdminUserView = {
  id: string;
  name: string;
  email: string;
  isActive: boolean;
  mustChangePassword: boolean;
  assignments: Array<{ roleCode: string; scopeKind: 'LOCATION' | 'COMPANY'; locationId: string | null }>;
};

export const REPLAY_PASSWORD_MESSAGE = 'La contraseña temporal ya fue emitida. Si no la conservaste, generá una nueva desde Resetear contraseña.';

const MAX_ATTEMPTS = 3;
const AUDIT_ENTITY_TYPE = 'User';
const OP_REUSED = 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD';

type LockedTarget = { id: string; name: string; email: string; isActive: boolean; mustChangePassword: boolean; credentialsChangedAt: Date | null };
type ScopeRow = { scopeKind: 'LOCATION' | 'COMPANY'; locationId: string | null; role: { code: string } };

const emailTaken = () => new AppError(409, 'EMAIL_TAKEN', 'Ya existe un usuario con ese email.');

function requireCaller(req: RequestLike): Express.AuthContext {
  if (!req.auth) throw new AppError(401, 'UNAUTHORIZED', 'Se requiere autenticación.');
  return req.auth;
}

// A unique violation on the User e-mail (any shape the driver reports) or on the operation record: both are resolved by retrying.
function isUniqueViolationOf(error: unknown, model: 'User' | 'UserAdminOperation'): boolean {
  const violation = uniqueViolation(error);
  if (violation === null) return false;
  // Through the pg adapter a violation can carry no model at all; a P2002 on a transaction that only writes these two tables is one of them.
  return violation.modelName === null || violation.modelName === model;
}

async function lockTarget(tx: Prisma.TransactionClient, targetId: string): Promise<LockedTarget> {
  const [locked] = await tx.$queryRaw<LockedTarget[]>`
    SELECT id, name, email, "isActive", "mustChangePassword", "credentialsChangedAt"
    FROM "User" WHERE id = ${targetId} FOR NO KEY UPDATE
  `;
  if (!locked) throw new AppError(404, 'NOT_FOUND', 'No se encontró el usuario.');
  return locked;
}

async function readScopes(tx: Prisma.TransactionClient, userId: string): Promise<ScopeRow[]> {
  return tx.userRoleScope.findMany({ where: { userId }, select: { scopeKind: true, locationId: true, role: { select: { code: true } } } });
}

// The current view of an account, read inside the transaction.
async function viewOf(tx: Prisma.TransactionClient, userId: string): Promise<AdminUserView> {
  const row = await tx.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, email: true, isActive: true, mustChangePassword: true, roleScopes: { select: { scopeKind: true, locationId: true, role: { select: { code: true } } } } },
  });
  if (!row) throw new AppError(404, 'NOT_FOUND', 'No se encontró el usuario.');
  return {
    id: row.id, name: row.name, email: row.email, isActive: row.isActive, mustChangePassword: row.mustChangePassword,
    assignments: row.roleScopes
      .map((scope) => ({ roleCode: scope.role.code, scopeKind: scope.scopeKind, locationId: scope.locationId }))
      .sort((a, b) => `${a.roleCode}:${a.locationId ?? ''}`.localeCompare(`${b.roleCode}:${b.locationId ?? ''}`)),
  };
}

type OperationRecord = { operation: string; requestHash: string; targetUserId: string };

// Looks the (actor, key) record up. Same operation + same intent = replay; anything else bound to the key = refusal.
async function findReplay(tx: Prisma.TransactionClient, actorId: string, idempotencyKey: string, operation: UserAdminOperationName, requestHash: string): Promise<OperationRecord | null> {
  const record = await tx.userAdminOperation.findUnique({
    where: { actorId_idempotencyKey: { actorId, idempotencyKey } },
    select: { operation: true, requestHash: true, targetUserId: true },
  });
  if (!record) return null;
  if (record.operation !== operation || record.requestHash !== requestHash) {
    throw new AppError(409, OP_REUSED, 'La clave de idempotencia ya se usó con otra solicitud.');
  }
  return record;
}

async function recordOperation(tx: Prisma.TransactionClient, data: { actorId: string; targetUserId: string; operation: UserAdminOperationName; idempotencyKey: string; requestHash: string }) {
  await tx.userAdminOperation.create({ data });
}

// `sessionRevoker` (U4): after the COMMIT of a deactivation, reactivation or password reset the target's live sockets are dropped
// (revokeUserSessions: post-commit, never fails the operation). Create and edit do not: a new account has no earlier session, and name/e-mail do
// not take part in authorization (the token and the socket handshake identify the account by id).
export function createUserAdminService(database: UserAdminDatabase, sessionRevoker: SessionRevoker = createNoopSessionRevoker()) {
  // Runs one operation attempt; retries from the top on a transient failure or a unique violation of a concurrent winner.
  async function attempt<T>(run: () => Promise<T>, onUniqueViolation?: (error: unknown) => Error | null): Promise<T> {
    for (let n = 1; ; n += 1) {
      try {
        return await run();
      } catch (error) {
        const retryable = isTransientTransactionError(error) || isUniqueViolationOf(error, 'User') || isUniqueViolationOf(error, 'UserAdminOperation');
        if (!retryable) throw error;
        if (n >= MAX_ATTEMPTS) {
          const mapped = onUniqueViolation?.(error);
          if (mapped) throw mapped;
          if (uniqueViolation(error) !== null) throw error;
          throw new AppError(409, 'CONCURRENCY_ERROR', 'La operación no pudo completarse por concurrencia.');
        }
      }
    }
  }

  // ---- create ------------------------------------------------------------------------------------------------------------------
  async function create(req: RequestLike, input: CreateUserInput) {
    const caller = requireCaller(req);
    const email = normalizeEmail(input.email);
    const name = normalizeName(input.name);
    const roleCode = input.roleCode;
    assertProductionRoleCode(roleCode);
    assertCanAssignRoleCode(caller, roleCode);
    assertRoleScopeCompatible(roleCode as RoleCode, input.scopeKind);
    const locationIds = input.scopeKind === 'LOCATION' ? [...new Set(input.locationIds)].sort() : [];
    const requestHash = canonicalRequestHash('CREATE_USER', { name, email, roleCode, scopeKind: input.scopeKind, locationIds });

    const role = await database.role.findUnique({ where: { code: roleCode } });
    if (!role) throw new AppError(500, 'ROLE_NOT_FOUND', `El rol Production ${roleCode} no existe en el catálogo.`);

    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await hashPassword(temporaryPassword);

    return attempt(
      () => database.$transaction(async (tx) => {
        // A replay is answered before anything else is validated against the CURRENT state of the world (an e-mail now taken by the very
        // account this key created is not a conflict).
        const replay = await findReplay(tx, caller.userId, input.idempotencyKey, 'CREATE_USER', requestHash);
        if (replay) {
          return { replayed: true as const, user: await viewOf(tx, replay.targetUserId), temporaryPassword: null, message: REPLAY_PASSWORD_MESSAGE };
        }
        const holders = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "User" WHERE lower("email") = ${email}`;
        if (holders.length > 0) throw emailTaken();
        if (input.scopeKind === 'LOCATION') await lockAndAssertLocationsActive(tx, locationIds);

        const created = await tx.user.create({ data: { name, email, passwordHash, isActive: true, mustChangePassword: true } });
        if (input.scopeKind === 'COMPANY') {
          await tx.userRoleScope.create({ data: { userId: created.id, roleId: role.id, scopeKind: 'COMPANY', locationId: null } });
        } else {
          await tx.userRoleScope.createMany({ data: locationIds.map((locationId) => ({ userId: created.id, roleId: role.id, scopeKind: 'LOCATION' as const, locationId })) });
        }
        await recordOperation(tx, { actorId: caller.userId, targetUserId: created.id, operation: 'CREATE_USER', idempotencyKey: input.idempotencyKey, requestHash });
        await createAuditLog(tx, {
          userId: caller.userId, branchId: null, action: 'USER_CREATED', entityType: AUDIT_ENTITY_TYPE, entityId: created.id,
          before: null,
          after: { name, email, isActive: true, mustChangePassword: true, roleCode, scopeKind: input.scopeKind, locationIds: input.scopeKind === 'COMPANY' ? null : locationIds },
        });
        return { replayed: false as const, user: await viewOf(tx, created.id), temporaryPassword, message: undefined };
      }),
      (error) => (isUniqueViolationOf(error, 'User') ? emailTaken() : null),
    );
  }

  // ---- edit name / e-mail --------------------------------------------------------------------------------------------------------
  async function update(req: RequestLike, targetId: string, input: UpdateUserInput) {
    const caller = requireCaller(req);
    assertCanAdminister(caller);
    return attempt(
      () => database.$transaction(async (tx) => {
        const target = await lockTarget(tx, targetId);
        assertCanManageTarget(caller, targetId, await readScopes(tx, targetId));
        const name = input.name === undefined ? target.name : normalizeName(input.name);
        const email = input.email === undefined ? target.email : normalizeEmail(input.email);
        if (name === target.name && email === target.email) return { user: await viewOf(tx, targetId) };

        if (email !== target.email) {
          const others = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "User" WHERE lower("email") = ${email} AND id <> ${targetId}`;
          if (others.length > 0) throw emailTaken();
        }
        await tx.user.update({ where: { id: targetId }, data: { name, email } });
        await createAuditLog(tx, {
          userId: caller.userId, branchId: null, action: 'USER_UPDATED', entityType: AUDIT_ENTITY_TYPE, entityId: targetId,
          before: { name: target.name, email: target.email },
          after: { name, email },
        });
        return { user: await viewOf(tx, targetId) };
      }),
      (error) => (isUniqueViolationOf(error, 'User') ? emailTaken() : null),
    );
  }

  // ---- deactivate ----------------------------------------------------------------------------------------------------------------
  async function deactivate(req: RequestLike, targetId: string, input: AdminOperationInput) {
    const caller = requireCaller(req);
    assertCanAdminister(caller);
    const requestHash = canonicalRequestHash('DEACTIVATE_USER', { targetUserId: targetId });
    const result = await attempt(() => database.$transaction(async (tx) => {
      // Fixed lock order: the last-OWNER advisory lock FIRST (it is taken even when the target turns out not to be an OWNER: the target is unknown
      // until its row is locked, and deactivation is a rare administrative act), then the target row.
      await lockLastOwnerGuard(tx);
      const target = await lockTarget(tx, targetId);
      const scopes = await readScopes(tx, targetId);
      assertCanManageTarget(caller, targetId, scopes);
      const replay = await findReplay(tx, caller.userId, input.idempotencyKey, 'DEACTIVATE_USER', requestHash);
      if (replay) return { replayed: true as const, user: await viewOf(tx, targetId) };
      if (target.isActive) {
        if (scopes.some((scope) => scope.role.code === ROLE_CODES.OWNER && scope.scopeKind === 'COMPANY')) await assertAnotherOperativeOwner(tx, targetId);
        const epoch = nextCredentialsEpoch(target.credentialsChangedAt, new Date());
        await tx.user.update({ where: { id: targetId }, data: { isActive: false, credentialsChangedAt: epoch } });
        await createAuditLog(tx, {
          userId: caller.userId, branchId: null, action: 'USER_DEACTIVATED', entityType: AUDIT_ENTITY_TYPE, entityId: targetId,
          before: { isActive: true, credentialsChangedAt: target.credentialsChangedAt?.toISOString() ?? null },
          after: { isActive: false, credentialsChangedAt: epoch.toISOString() },
        });
      }
      // Recorded even when the account was already inactive: a later replay of this key must never deactivate a re-activated account.
      await recordOperation(tx, { actorId: caller.userId, targetUserId: targetId, operation: 'DEACTIVATE_USER', idempotencyKey: input.idempotencyKey, requestHash });
      return { replayed: false as const, user: await viewOf(tx, targetId) };
    }));
    if (!result.replayed) await revokeUserSessions(sessionRevoker, targetId, 'USER_DEACTIVATED');
    return result;
  }

  // ---- reactivate / reset password: both issue a new temporary password --------------------------------------------------------------
  async function issueTemporaryPassword(req: RequestLike, targetId: string, input: AdminOperationInput, operation: 'REACTIVATE_USER' | 'RESET_PASSWORD') {
    const caller = requireCaller(req);
    assertCanAdminister(caller);
    const requestHash = canonicalRequestHash(operation, { targetUserId: targetId });
    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await hashPassword(temporaryPassword);
    const result = await attempt(() => database.$transaction(async (tx) => {
      const target = await lockTarget(tx, targetId);
      const scopes = await readScopes(tx, targetId);
      assertCanManageTarget(caller, targetId, scopes);
      const replay = await findReplay(tx, caller.userId, input.idempotencyKey, operation, requestHash);
      if (replay) return { replayed: true as const, user: await viewOf(tx, targetId), temporaryPassword: null, message: REPLAY_PASSWORD_MESSAGE };

      if (operation === 'REACTIVATE_USER') {
        if (target.isActive) throw new AppError(409, 'USER_ALREADY_ACTIVE', 'El usuario ya está activo.');
        // Existing scopes are kept; none of them may sit on a Location that has been closed meanwhile.
        await lockAndAssertLocationsActive(tx, scopes.flatMap((scope) => (scope.locationId === null ? [] : [scope.locationId])));
      } else if (!target.isActive) {
        throw new AppError(409, 'USER_INACTIVE', 'El usuario está inactivo: reactivalo antes de resetear su contraseña.');
      }

      const epoch = nextCredentialsEpoch(target.credentialsChangedAt, new Date());
      await tx.user.update({ where: { id: targetId }, data: { passwordHash, mustChangePassword: true, credentialsChangedAt: epoch, ...(operation === 'REACTIVATE_USER' ? { isActive: true } : {}) } });
      await recordOperation(tx, { actorId: caller.userId, targetUserId: targetId, operation, idempotencyKey: input.idempotencyKey, requestHash });
      await createAuditLog(tx, {
        userId: caller.userId, branchId: null, action: operation === 'REACTIVATE_USER' ? 'USER_REACTIVATED' : 'USER_PASSWORD_RESET', entityType: AUDIT_ENTITY_TYPE, entityId: targetId,
        before: { isActive: target.isActive, mustChangePassword: target.mustChangePassword, credentialsChangedAt: target.credentialsChangedAt?.toISOString() ?? null },
        after: { isActive: true, mustChangePassword: true, credentialsChangedAt: epoch.toISOString() },
      });
      return { replayed: false as const, user: await viewOf(tx, targetId), temporaryPassword, message: undefined };
    }));
    if (!result.replayed) await revokeUserSessions(sessionRevoker, targetId, operation === 'REACTIVATE_USER' ? 'USER_REACTIVATED' : 'USER_PASSWORD_RESET');
    return result;
  }

  return {
    create,
    update,
    deactivate,
    reactivate: (req: RequestLike, targetId: string, input: AdminOperationInput) => issueTemporaryPassword(req, targetId, input, 'REACTIVATE_USER'),
    resetPassword: (req: RequestLike, targetId: string, input: AdminOperationInput) => issueTemporaryPassword(req, targetId, input, 'RESET_PASSWORD'),
  };
}
