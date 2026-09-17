import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import { AppError } from '../../shared/errors.js';
import { isOwner } from '../rbac/authorization-policy.js';
import { ROLE_CODES, isProductionRoleCode, type RoleCode } from '../rbac/roles.js';
import type { AssignScopeInput } from './scope-assignment.dto.js';

// Phase 1D.4.3 (docs/superpowers/plans/2026-09-14-phase-1d-production-
// authorization.md). DTO/service only — no route/controller wiring here
// (Task 1D.4.4 owns HTTP exposure). `RequestLike` mirrors this codebase's
// existing convention (backoffice.service.ts's own `RequestLike`) rather
// than the plan's ad hoc `{ auth?: Express.AuthContext }` shape.
type RequestLike = { auth?: Express.AuthContext };
// No 'user' delegate here: the target's existence/OWNER-state read happens
// exclusively inside the transaction via the locked `tx` client (F2's
// lockTargetAndAssertMutable) — this outer type intentionally cannot offer
// an unlocked, non-authoritative fast path to the target's User row.
type ScopeAssignmentDatabase = Pick<PrismaClient, 'role' | 'userRoleScope' | '$transaction'>;

type LockedUser = { id: string };

function forbidden(message: string) {
  return new AppError(403, 'FORBIDDEN', message);
}

// Fail-closed runtime boundary (independent-audit finding F1): the DTO's
// z.enum already rejects a legacy code like MANAGER for any caller that goes
// through it, but a DTO is a request-shape check at the HTTP boundary, not a
// service-layer security boundary — this service is callable directly (by a
// future in-process caller, or by a test that intentionally bypasses the
// DTO with an unsafe cast), so it must independently refuse a non-Production
// role code before it ever reaches a Role lookup or a mutation. MANAGER
// physically remains in `Role` as legacy-only historical data
// (AGENTS.md "Roles — Production V1"; rbac/roles.ts) and must never become a
// Production UserRoleScope assignment through this service, regardless of
// how the caller obtained that string.
function assertProductionRoleCode(roleCode: string): asserts roleCode is RoleCode {
  if (!isProductionRoleCode(roleCode)) {
    throw new AppError(400, 'INVALID_ROLE_CODE', `${roleCode} no es un rol Production válido.`);
  }
}

function assertNotSelf(caller: Express.AuthContext, targetUserId: string) {
  if (targetUserId === caller.userId) {
    throw forbidden('No puede modificar su propio alcance de autorización.');
  }
}

// Independent-audit finding F2: the target's OWNER status must be
// authoritative at the instant of mutation, not merely at the instant of an
// earlier, separate read. Locks the target's `User` row (`SELECT ... FOR
// UPDATE`, project-established pattern — see sales/cancellation.service.ts,
// cash/cash.service.ts, sales/sales.service.ts, each locking their own
// mutation's row the same way) FIRST, inside the SAME transaction that goes
// on to mutate UserRoleScope. Two scope-assignment operations against the
// SAME target therefore serialize on Postgres's own row lock: whichever
// acquires it second re-reads whatever the first one just committed before
// making its own OWNER-state decision. Operations against DIFFERENT targets
// take independent locks and are never serialized against each other.
// Merely moving the OWNER read inside a transaction without this lock would
// not close the race under READ COMMITTED (the project's default isolation):
// a plain SELECT there would still return the pre-concurrent-write snapshot,
// not block on it — only an explicit row lock forces the second writer to
// wait for the first to commit before it can even read.
async function lockTargetAndAssertMutable(
  tx: Prisma.TransactionClient,
  caller: Express.AuthContext,
  targetUserId: string,
) {
  const locked = await tx.$queryRaw<LockedUser[]>`SELECT id FROM "User" WHERE id = ${targetUserId} FOR UPDATE`;
  if (locked.length === 0) throw new AppError(404, 'NOT_FOUND', 'No se encontró el usuario.');

  const currentScopes = await tx.userRoleScope.findMany({
    where: { userId: targetUserId },
    select: { role: { select: { code: true } } },
  });
  const targetIsCurrentlyOwner = currentScopes.some((scope) => scope.role.code === ROLE_CODES.OWNER);
  if (targetIsCurrentlyOwner && !isOwner(caller)) {
    throw forbidden('Sólo OWNER puede modificar el alcance de otro OWNER.');
  }
}

export function createScopeAssignmentService(database: ScopeAssignmentDatabase) {
  // Creates/replaces exactly the (targetUserId, roleCode) assignment — every
  // OTHER assignment this user independently holds (a different roleCode) is
  // never read or written by this function. This is what makes "SELLER @ A
  // survives a WAREHOUSE @ B reassignment" true by construction, not by
  // convention (AGENTS.md's Phase 1D target model: reassignment changes
  // UserRoleScope, never role identity, and never a different, independent
  // assignment).
  async function assign(req: RequestLike, targetUserId: string, input: AssignScopeInput) {
    const caller = req.auth;
    if (!caller) throw new AppError(401, 'UNAUTHORIZED', 'Se requiere autenticación.');

    // Caller-only checks first — none of these can change concurrently, so
    // none of them need the target-row lock below.
    assertNotSelf(caller, targetUserId);
    assertProductionRoleCode(input.roleCode);
    if (input.roleCode === ROLE_CODES.OWNER && !isOwner(caller)) {
      throw forbidden('Sólo OWNER puede asignar el rol OWNER.');
    }
    if ((input.roleCode === ROLE_CODES.OWNER || input.roleCode === ROLE_CODES.ADMIN) && input.scopeKind !== 'COMPANY') {
      throw forbidden(`El rol ${input.roleCode} requiere alcance COMPANY.`);
    }
    if (
      (input.roleCode === ROLE_CODES.CASHIER ||
        input.roleCode === ROLE_CODES.SELLER ||
        input.roleCode === ROLE_CODES.WAREHOUSE) &&
      input.scopeKind !== 'LOCATION'
    ) {
      throw forbidden(`El rol ${input.roleCode} requiere alcance LOCATION.`);
    }

    const role = await database.role.findUnique({ where: { code: input.roleCode } });
    if (!role) throw new AppError(500, 'ROLE_NOT_FOUND', `El rol Production ${input.roleCode} no existe en el catálogo.`);

    // Single transaction scoped to exactly (targetUserId, role.id): locks
    // the target first, re-derives OWNER status under that lock, then
    // mutates — so a concurrent OWNER grant to this same target can never
    // race past this decision. The delete and the create either both land
    // or neither does, so a LOCATION create failing (e.g. a nonexistent
    // Location id, FK-enforced) can never leave the target without their
    // prior assignment for this role.
    return database.$transaction(async (tx) => {
      await lockTargetAndAssertMutable(tx, caller, targetUserId);

      await tx.userRoleScope.deleteMany({ where: { userId: targetUserId, roleId: role.id } });
      if (input.scopeKind === 'COMPANY') {
        await tx.userRoleScope.create({
          data: { userId: targetUserId, roleId: role.id, scopeKind: 'COMPANY', locationId: null },
        });
      } else {
        await tx.userRoleScope.createMany({
          data: input.locationIds.map((locationId) => ({
            userId: targetUserId,
            roleId: role.id,
            scopeKind: 'LOCATION' as const,
            locationId,
          })),
        });
      }

      return { userId: targetUserId, roleCode: input.roleCode, scopeKind: input.scopeKind };
    });
  }

  // Revokes exactly the (targetUserId, roleCode) assignment. Any other
  // independent assignment for this user is untouched. Locks the target the
  // same way `assign` does, inside the same transaction as the mutation, so
  // assign/revoke against the same target always serialize on that lock.
  async function revoke(req: RequestLike, targetUserId: string, roleCode: RoleCode) {
    const caller = req.auth;
    if (!caller) throw new AppError(401, 'UNAUTHORIZED', 'Se requiere autenticación.');
    assertNotSelf(caller, targetUserId);
    assertProductionRoleCode(roleCode);

    const role = await database.role.findUnique({ where: { code: roleCode } });
    if (!role) throw new AppError(500, 'ROLE_NOT_FOUND', `El rol Production ${roleCode} no existe en el catálogo.`);

    return database.$transaction(async (tx) => {
      await lockTargetAndAssertMutable(tx, caller, targetUserId);
      await tx.userRoleScope.deleteMany({ where: { userId: targetUserId, roleId: role.id } });
      return { userId: targetUserId, roleCode, revoked: true };
    });
  }

  return { assign, revoke };
}
