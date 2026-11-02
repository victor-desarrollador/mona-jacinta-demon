import type { Prisma } from '../../generated/prisma/client.js';
import { AppError } from '../../shared/errors.js';
import { ROLE_CODES, isOwner } from '../rbac/index.js';

// USER-MGMT-01 U3 — the ONE identity-administration policy. Both mutable HTTP paths (user-admin.service.ts: create / edit / deactivate / reactivate /
// reset password, and scope-assignment.service.ts: assign / revoke) decide through these functions, so a rule can never hold on one path and not
// on the other.
//
// Approved matrix:
//   OWNER          administers any OTHER account (OWNER and ADMIN included), subject to LAST_OWNER_PROTECTED; grants/revokes every role.
//   ADMIN COMPANY  administers accounts that hold NO OWNER/ADMIN scope; grants/revokes only CASHIER / SELLER / WAREHOUSE.
//   anyone else    (ADMIN LOCATION, operational roles, no assignment) administers nothing — also enforced here, not only by the route's USER_MANAGE gate.
//   nobody         administers THEIR OWN account through these paths (their password has /auth/change-password).
//
// "Privileged target" is decided from the target's REAL scope rows, read under the target row lock, never from the role named in the request, and
// regardless of the scope kind of the row or of the account being inactive: a malformed ADMIN @ LOCATION row or a former ADMIN kept while the account is
// inactive still makes the target privileged (fail closed). A row of such a role contributes no authority by itself (authorization-context drops it),
// but it is a marker that this account must not be handled by a non-OWNER.
//
// Denied attempts follow the repo's current policy: AppError 403, no separate security audit row. User ids are not a secret (any administrator lists
// every user with its assignments through GET /backoffice/users), so 404-vs-403 reveals nothing and the existing 404-first pattern is kept.

export type ActorPrivilege = 'OWNER' | 'ADMIN_COMPANY' | 'NONE';
export type ScopeRoleRow = { role: { code: string } };

const forbidden = (message: string) => new AppError(403, 'FORBIDDEN', message);

export function classifyActor(caller: Express.AuthContext): ActorPrivilege {
  if (isOwner(caller)) return 'OWNER';
  if (caller.assignments.some((assignment) => assignment.roleCode === ROLE_CODES.ADMIN && assignment.scopeKind === 'COMPANY')) return 'ADMIN_COMPANY';
  return 'NONE';
}

export const isPrivilegedRoleCode = (roleCode: string): boolean => roleCode === ROLE_CODES.OWNER || roleCode === ROLE_CODES.ADMIN;

export const isPrivilegedTarget = (scopes: readonly ScopeRoleRow[]): boolean => scopes.some((scope) => isPrivilegedRoleCode(scope.role.code));

export function assertCanAdminister(caller: Express.AuthContext): void {
  if (classifyActor(caller) === 'NONE') throw forbidden('No cuenta con permisos para administrar usuarios.');
}

// Granting (or revoking) a role: OWNER and ADMIN roles only by an OWNER.
export function assertCanAssignRoleCode(caller: Express.AuthContext, roleCode: string, verb: 'asignar' | 'revocar' = 'asignar'): void {
  assertCanAdminister(caller);
  if (isPrivilegedRoleCode(roleCode) && !isOwner(caller)) throw forbidden(`Sólo OWNER puede ${verb} el rol ${roleCode}.`);
}

// Acting on an existing account (its scopes read under the target row lock).
export function assertCanManageTarget(
  caller: Express.AuthContext,
  targetUserId: string,
  scopes: readonly ScopeRoleRow[],
  messages: { privileged?: (scopes: readonly ScopeRoleRow[]) => string } = {},
): void {
  assertCanAdminister(caller);
  if (targetUserId === caller.userId) throw forbidden('No puede administrar su propia cuenta desde esta operación.');
  if (isOwner(caller) || !isPrivilegedTarget(scopes)) return;
  throw forbidden(messages.privileged?.(scopes) ?? 'Sólo OWNER puede administrar a un OWNER o a un ADMIN.');
}

// ---- LAST_OWNER_PROTECTED ----------------------------------------------------------------------------------------------------------------
// An operative OWNER is an ACTIVE account holding an OWNER scope at COMPANY kind. Every mutation that can remove one (deactivating it, revoking its
// OWNER scope) first takes THIS transaction-scoped advisory lock — always BEFORE the target User row lock — and then checks that another operative
// OWNER exists. The constant lock serializes those mutations against each other, so two OWNERs deactivating one another at the same time cannot both
// pass the check; taken first and in a fixed order it cannot take part in a lock cycle.
const LAST_OWNER_ADVISORY_KEY = 7_335_210_001; // arbitrary, reserved for this guard

export async function lockLastOwnerGuard(tx: Pick<Prisma.TransactionClient, '$executeRaw'>): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LAST_OWNER_ADVISORY_KEY})`;
}

export async function assertAnotherOperativeOwner(tx: Pick<Prisma.TransactionClient, '$queryRaw'>, excludedUserId: string): Promise<void> {
  const [row] = await tx.$queryRaw<Array<{ n: number }>>`
    SELECT count(*)::int AS n
    FROM "User" u
    JOIN "UserRoleScope" s ON s."userId" = u.id
    JOIN "Role" r ON r.id = s."roleId"
    WHERE u."isActive" = true AND u.id <> ${excludedUserId} AND r.code = 'OWNER' AND s."scopeKind" = 'COMPANY'
  `;
  if (!row || Number(row.n) < 1) {
    throw new AppError(409, 'LAST_OWNER_PROTECTED', 'No se puede quitar al último OWNER operativo: el sistema quedaría sin ningún OWNER activo.');
  }
}
