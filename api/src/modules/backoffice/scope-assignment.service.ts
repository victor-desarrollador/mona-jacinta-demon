import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import { AppError } from '../../shared/errors.js';
import { createAuditLog } from '../../shared/audit.js';
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
// NO KEY UPDATE`, project-established pattern — see sales/cancellation.service.ts,
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
//
// SEC-A deadlock-fix (MJ-ADMIN-ADM-02-SEC-A-DEADLOCK-FIX-01, owner-approved
// 2026-10-17; approved alternative "C1"): the mode is FOR NO KEY UPDATE, NOT
// FOR UPDATE. The AuditLog insert below takes an implicit FK `FOR KEY SHARE`
// lock on the ACTOR's User row (and the UserRoleScope insert takes one on the
// target's). A `FOR UPDATE` target lock CONFLICTS with `FOR KEY SHARE`
// (PostgreSQL "Explicit Locking", Table 13.3), so two mutually-modifying
// admins (A modifies B while B modifies A) would each hold FOR UPDATE on the
// other's target and each wait for the other's KEY SHARE: a classic 40P01
// deadlock. `FOR NO KEY UPDATE` is still self-conflicting, so same-target
// serialization (the F2 guarantee above) is unchanged, but it does NOT
// conflict with `FOR KEY SHARE`, so the actor-side FK check never waits and
// the cycle cannot form. It still conflicts with `FOR UPDATE` and
// `FOR SHARE`, so a concurrent User UPDATE or DELETE of the target remains
// blocked.
async function lockTargetAndAssertMutable(
  tx: Prisma.TransactionClient,
  caller: Express.AuthContext,
  targetUserId: string,
) {
  const locked = await tx.$queryRaw<LockedUser[]>`SELECT id FROM "User" WHERE id = ${targetUserId} FOR NO KEY UPDATE`;
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

// SEC-A (MJ-ADMIN-ADM-02-SEC-A-IMPLEMENT-01, owner-approved 2026-10-17):
// F-01 — every EFFECTIVE (state-changing) assign/revoke writes exactly one
// AuditLog row, inside the SAME transaction as the mutation it describes,
// attributed to the authenticated caller, with branchId null (a scope
// mutation is user-level authority, possibly multi-location — never an
// arbitrary Location; the catalog-admin D3 precedent) and before/after
// snapshots of the scope SHAPE only (role/scopeKind/location ids — never
// credentials, never whole user rows). An idempotent revoke that removes
// zero rows changes no state and therefore writes no audit row.
// F-02 — a NEW LOCATION assignment may no longer target an inactive
// Location (400 LOCATION_INACTIVE). Historical rows are never rewritten;
// revoke stays available for cleanup. Ids matching no Location row keep
// the existing FK semantics (P2003 -> 409 DATABASE_CONFLICT): this guard
// adds a business rule, not an existence pre-check.
const AUDIT_ACTION_ASSIGNED = 'USER_SCOPE_ASSIGNED';
const AUDIT_ACTION_REVOKED = 'USER_SCOPE_REVOKED';
const AUDIT_ENTITY_TYPE = 'UserRoleScope';

// Snapshot of exactly the (target, roleCode) assignment shape this service
// mutates — ids and codes only, so an audit row can never carry secrets.
type ScopeSnapshot = {
  roleCode: RoleCode;
  scopeKind: 'LOCATION' | 'COMPANY';
  locationIds: string[] | null;
};

type ScopeRow = { scopeKind: 'LOCATION' | 'COMPANY'; locationId: string | null };

function snapshotRows(rows: ScopeRow[], roleCode: RoleCode): ScopeSnapshot | null {
  if (rows.length === 0) return null;
  if (rows.some((row) => row.scopeKind === 'COMPANY')) {
    return { roleCode, scopeKind: 'COMPANY', locationIds: null };
  }
  return {
    roleCode,
    scopeKind: 'LOCATION',
    // LOCATION rows always carry a non-null locationId (the DB's
    // chk_user_role_scope_consistency CHECK); the guard only narrows the type.
    locationIds: rows
      .map((row) => row.locationId)
      .filter((locationId): locationId is string => locationId !== null)
      .sort(),
  };
}

// SEC-A review-fixes B (MJ-ADMIN-ADM-02-SEC-A-REVIEW-FIXES-01, owner-approved
// 2026-10-17; policy H-06): a (userId, roleId) pair must never simultaneously
// hold COMPANY and LOCATION rows. The DB permits that anomalous shape — the
// migration's CHECK constrains each ROW's scopeKind/locationId pairing and
// the partial unique indexes are per-kind, so nothing forbids one row of each
// kind for the same (user, role). The service would otherwise silently
// destroy the anomaly, because both assign and revoke delete EVERY row for
// (userId, roleId) before rewriting. Per the approved policy we neither
// normalize nor repair historical data: we fail closed, before any mutation,
// on both routes. snapshotRows() would also be lossy here (it collapses a
// mixed set to COMPANY and drops every locationId), which is precisely the
// silent corruption this guard prevents.
function assertNotMixedScopeState(rows: ScopeRow[], roleCode: RoleCode): void {
  const hasCompany = rows.some((row) => row.scopeKind === 'COMPANY');
  const hasLocation = rows.some((row) => row.scopeKind === 'LOCATION');
  if (hasCompany && hasLocation) {
    throw new AppError(
      409,
      'SCOPE_STATE_INCONSISTENT',
      `El alcance del rol ${roleCode} para este usuario está en un estado inconsistente (COMPANY y LOCATION coexistentes) y no se modifica automáticamente.`,
    );
  }
}

// SEC-A review-fixes A (owner-approved 2026-10-17; policy H-05): compare the
// LOGICAL state, not the request's ordering. Re-issuing exactly the
// assignment the target already holds (same scopeKind and, for LOCATION, the
// same multiset of ids regardless of their order in the request) is a no-op:
// no delete, no create, no AuditLog. Duplicates are compared as a multiset on
// purpose — a request that repeats an id is NOT logically identical to a
// prior single-row assignment, so it still takes the normal mutation path and
// its unique-index violation, preserving the pre-existing duplicate-
// locationIds failure semantics. Mixed state is rejected before this runs.
function isLogicallyIdenticalAssign(input: AssignScopeInput, priorRows: ScopeRow[]): boolean {
  if (priorRows.length === 0) return false;
  if (input.scopeKind === 'COMPANY') {
    return priorRows.length === 1 && priorRows[0]!.scopeKind === 'COMPANY';
  }
  if (priorRows.some((row) => row.scopeKind !== 'LOCATION')) return false;
  const priorIds = priorRows
    .map((row) => row.locationId)
    .filter((locationId): locationId is string => locationId !== null)
    .sort();
  const requestedIds = [...input.locationIds].sort();
  return priorIds.length === requestedIds.length && priorIds.every((id, index) => id === requestedIds[index]);
}

// SEC-A review-fixes C (owner-approved 2026-10-17): reject inactive Locations
// for NEW assignments AND serialize that check against a concurrent
// deactivation. The prior unlocked `findMany` could observe `isActive = true`
// and then commit an assignment after another transaction had deactivated the
// same Location (a TOCTOU window — the earlier read proves nothing at commit
// time). We therefore take `FOR SHARE` row locks on the affected Locations,
// inside the SAME transaction as the mutation, in a deterministic order
// (`ORDER BY id`) so two concurrent assignments that overlap on locations
// acquire those locks in the same sequence and cannot deadlock each other.
// `FOR SHARE` is deliberate: it conflicts with the row lock a concurrent
// `isActive` UPDATE needs, while still letting two `FOR SHARE` readers proceed
// in parallel. Lock order remains User (FOR NO KEY UPDATE, taken first,
// unchanged) ->
// Location (FOR SHARE) -> UserRoleScope writes.
// Ids that match no Location row are deliberately not flagged here — they
// keep failing later on the locationId FK (P2003 -> 409 DATABASE_CONFLICT),
// preserving the documented nonexistent-location semantics.
async function lockAndAssertLocationsActive(
  tx: Prisma.TransactionClient,
  locationIds: readonly string[],
): Promise<void> {
  // Dedupe + sort so identical id sets always lock in the same order; a
  // request repeating an id does not attempt to lock the same row twice.
  const ids = [...new Set(locationIds)].sort();
  if (ids.length === 0) return; // defensive: nothing requested to lock or validate
  const locations = await tx.$queryRaw<Array<{ id: string; isActive: boolean }>>`
    SELECT id, "isActive" FROM "Location" WHERE id IN (${Prisma.join(ids)}) ORDER BY id FOR SHARE
  `;
  if (locations.some((location) => !location.isActive)) {
    throw new AppError(400, 'LOCATION_INACTIVE', 'No se puede asignar alcance sobre ubicaciones inactivas.');
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
    // A2-FIX-CODE-01/C1: a property-access narrowing does not survive the
    // transactional closure below, so the validated value is captured in a
    // local const first (the same pattern `revoke` already uses for its own
    // parameter) and the narrowed const is what the closure reads.
    const roleCode = input.roleCode;
    assertProductionRoleCode(roleCode);
    if (roleCode === ROLE_CODES.OWNER && !isOwner(caller)) {
      throw forbidden('Sólo OWNER puede asignar el rol OWNER.');
    }
    if ((roleCode === ROLE_CODES.OWNER || roleCode === ROLE_CODES.ADMIN) && input.scopeKind !== 'COMPANY') {
      throw forbidden(`El rol ${roleCode} requiere alcance COMPANY.`);
    }
    if (
      (roleCode === ROLE_CODES.CASHIER ||
        roleCode === ROLE_CODES.SELLER ||
        roleCode === ROLE_CODES.WAREHOUSE) &&
      input.scopeKind !== 'LOCATION'
    ) {
      throw forbidden(`El rol ${roleCode} requiere alcance LOCATION.`);
    }

    const role = await database.role.findUnique({ where: { code: roleCode } });
    if (!role) throw new AppError(500, 'ROLE_NOT_FOUND', `El rol Production ${roleCode} no existe en el catálogo.`);

    // Single transaction scoped to exactly (targetUserId, role.id): locks
    // the target first, re-derives OWNER status under that lock, then
    // mutates — so a concurrent OWNER grant to this same target can never
    // race past this decision. The delete and the create either both land
    // or neither does, so a LOCATION create failing (e.g. a nonexistent
    // Location id, FK-enforced) can never leave the target without their
    // prior assignment for this role.
    return database.$transaction(async (tx) => {
      await lockTargetAndAssertMutable(tx, caller, targetUserId);

      // Before-snapshot read under the same target lock the mutation uses,
      // so the audited shape is exactly the pre-mutation state. It is also
      // the read both the H-06 integrity guard and the H-05 equivalence
      // check need, so it happens once, before anything is written.
      const priorRows = await tx.userRoleScope.findMany({
        where: { userId: targetUserId, roleId: role.id },
        select: { scopeKind: true, locationId: true },
      });

      // H-06: fail closed on a COMPANY+LOCATION anomaly before any mutation.
      assertNotMixedScopeState(priorRows, roleCode);

      // H-05: a logically identical re-issue is a no-op — no delete, no
      // create, no AuditLog — and returns the same response an effective
      // assign would. Deliberately checked BEFORE the inactive-Location
      // guard: this is not a NEW assignment (it changes nothing), so it can
      // neither create authority nor trip the new-assignment rule, and it
      // preserves historical rows on now-inactive Locations (H-04).
      if (isLogicallyIdenticalAssign(input, priorRows)) {
        return { userId: targetUserId, roleCode, scopeKind: input.scopeKind };
      }

      if (input.scopeKind === 'LOCATION') {
        await lockAndAssertLocationsActive(tx, input.locationIds);
      }

      const before = snapshotRows(priorRows, roleCode);

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

      // F-01: assign is a replace-by-construction, so it is always an
      // effective mutation and always audits — atomically with the write
      // it describes (a failing create rolls the audit back with it).
      await createAuditLog(tx, {
        userId: caller.userId,
        branchId: null,
        action: AUDIT_ACTION_ASSIGNED,
        entityType: AUDIT_ENTITY_TYPE,
        entityId: targetUserId,
        before,
        after: {
          roleCode,
          scopeKind: input.scopeKind,
          locationIds: input.scopeKind === 'COMPANY' ? null : [...input.locationIds].sort(),
        },
      });

      return { userId: targetUserId, roleCode, scopeKind: input.scopeKind };
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

      // Before-snapshot read under the same target lock the mutation uses.
      const priorRows = await tx.userRoleScope.findMany({
        where: { userId: targetUserId, roleId: role.id },
        select: { scopeKind: true, locationId: true },
      });

      // H-06: revoke deletes every row for (userId, roleId), so it is just as
      // capable of destroying a COMPANY+LOCATION anomaly as assign is — the
      // same fail-closed guard runs here, before the delete.
      assertNotMixedScopeState(priorRows, roleCode);

      const removed = await tx.userRoleScope.deleteMany({ where: { userId: targetUserId, roleId: role.id } });

      // F-01, approved policy 3: only an EFFECTIVE revoke (rows actually
      // removed) audits — an idempotent revoke changes no state and adds no
      // AuditLog row, while the response stays { revoked: true }.
      if (removed.count > 0) {
        await createAuditLog(tx, {
          userId: caller.userId,
          branchId: null,
          action: AUDIT_ACTION_REVOKED,
          entityType: AUDIT_ENTITY_TYPE,
          entityId: targetUserId,
          before: snapshotRows(priorRows, roleCode),
          after: null,
        });
      }

      return { userId: targetUserId, roleCode, revoked: true };
    });
  }

  return { assign, revoke };
}
