import type { PrismaClient } from '../../generated/prisma/client.js';

// GC4F3 (Phase 1 Global Closeout): the canonical bootstrap OWNER identity,
// matching exactly what prisma/seed.ts's populate() provisions (same id/
// email/name) — duplicated here rather than imported, since seed.ts owns no
// exported constant for these values and this tool is deliberately
// independent of the broad seed path (see the GC4F3A design audit: seed.ts
// is out of scope for this narrow, auditable, dry-run-first mechanism).
export const CANONICAL_OWNER_USER_ID = '00000000-0000-4000-8000-000000000604';
export const CANONICAL_OWNER_EMAIL = 'owner01@demo.local';
export const CANONICAL_OWNER_NAME = 'Owner Demo';

// The advisory lock id prisma/seed.ts's run() already uses to serialize
// concurrent seed/reset invocations. Reused verbatim (never a distinct lock
// id) because seedDemo/resetDemo also creates/reconciles this exact
// canonical OWNER identity and scope — a different lock would not serialize
// these two overlapping maintenance operations against each other.
const MAINTENANCE_ADVISORY_LOCK_ID = 506005;

export type CanonicalOwnerIdentityState =
  | 'ABSENT'
  | 'EXACT_MATCH'
  | 'EMAIL_ID_MISMATCH'
  | 'CANONICAL_ID_OCCUPIED'
  | 'SPLIT_IDENTITY';

export type CanonicalOwnerAction =
  | 'CREATE_USER_AND_OWNER_SCOPE'
  | 'ADD_OWNER_SCOPE'
  | 'RECONCILE_OWNER_SCOPE'
  | 'NOOP_ALREADY_CANONICAL'
  | 'BLOCKED';

export type CanonicalOwnerScope = {
  id: string;
  scopeKind: 'LOCATION' | 'COMPANY';
  locationId: string | null;
};

export type CanonicalOwnerNonOwnerScope = CanonicalOwnerScope & { roleCode: string };

export type CanonicalOwnerLegacyRow = {
  id: string;
  roleCode: string;
  branchId: string;
  branchCode: string;
};

export type CanonicalOwnerOtherUserScope = { scopeKind: 'LOCATION' | 'COMPANY'; locationId: string | null };

export type CanonicalOwnerOtherUser = {
  userId: string;
  email: string;
  name: string;
  isActive: boolean;
  scopes: CanonicalOwnerOtherUserScope[];
};

export type CanonicalOwnerBootstrapPlan = {
  canonical: { userId: string; email: string; expectedName: string };
  ownerRole: {
    id: string | null;
    exists: boolean;
    unexpectedRolePermissionCount: number;
    unexpectedRolePermissionCodes: string[];
  };
  identityState: CanonicalOwnerIdentityState;
  existingCanonicalUser: { id: string; email: string; name: string; isActive: boolean } | null;
  existingOwnerScopes: CanonicalOwnerScope[];
  existingNonOwnerScopes: CanonicalOwnerNonOwnerScope[];
  legacyUserBranchRoleRows: CanonicalOwnerLegacyRow[];
  otherOwnerUsers: CanonicalOwnerOtherUser[];
  targetScope: { scopeKind: 'COMPANY'; locationId: null };
  action: CanonicalOwnerAction;
  passwordRequiredForExecute: boolean;
  readyForExecution: boolean;
  blockers: string[];
};

type PlanDatabase = Pick<PrismaClient, 'role' | 'rolePermission' | 'user' | 'userRoleScope' | 'userBranchRole'>;

function isCanonicalCompanyScope(scope: { scopeKind: string; locationId: string | null }): boolean {
  return scope.scopeKind === 'COMPANY' && scope.locationId === null;
}

// GC4F3 (Phase 1 Global Closeout): read-only preflight for bootstrapCanonicalOwner
// below — SELECT/find/count queries only, never create/update/delete/upsert/
// $executeRaw/a transaction. Reports exactly what the mutator would do
// against the fixed canonical demo OWNER identity, without ever exposing a
// passwordHash. See docs from the GC4F3A design audit for the frozen policy
// this planner implements: any identity ambiguity (email/id mismatch, split
// identity), an inactive existing user, a legacy UserBranchRole row, a
// missing OWNER Role, or an unexpected OWNER RolePermission grant all fail
// closed (readyForExecution: false) rather than being silently repaired.
// Non-OWNER Production scopes and other independent OWNER users are always
// preserved and surfaced as context only — this tool never mutates either.
export async function planCanonicalOwnerBootstrap(db: PlanDatabase): Promise<CanonicalOwnerBootstrapPlan> {
  const blockers: string[] = [];

  const ownerRoleRow = await db.role.findUnique({ where: { code: 'OWNER' } });
  if (!ownerRoleRow) {
    blockers.push('Production OWNER Role does not exist; run the Phase 1B RBAC catalog bootstrap first');
  }

  let unexpectedRolePermissionCodes: string[] = [];
  if (ownerRoleRow) {
    const grants = await db.rolePermission.findMany({
      where: { roleId: ownerRoleRow.id },
      select: { permission: { select: { code: true } } },
    });
    unexpectedRolePermissionCodes = grants.map((grant) => grant.permission.code).sort();
    if (unexpectedRolePermissionCodes.length > 0) {
      blockers.push(
        `OWNER Role has ${unexpectedRolePermissionCodes.length} unexpected RolePermission grant(s): ` +
          unexpectedRolePermissionCodes.join(', '),
      );
    }
  }

  // GC4F3R1 finding 2: least-privilege select — never load passwordHash (or
  // any other unrelated User column) for a read that only needs to classify
  // identity state and report id/email/name/isActive.
  const identitySelect = { id: true, email: true, name: true, isActive: true } as const;
  const userByEmail = await db.user.findUnique({ where: { email: CANONICAL_OWNER_EMAIL }, select: identitySelect });
  const userById = await db.user.findUnique({ where: { id: CANONICAL_OWNER_USER_ID }, select: identitySelect });

  let identityState: CanonicalOwnerIdentityState;
  let existingCanonicalUser: CanonicalOwnerBootstrapPlan['existingCanonicalUser'] = null;
  if (!userByEmail && !userById) {
    identityState = 'ABSENT';
  } else if (userByEmail && userById && userByEmail.id === userById.id) {
    identityState = 'EXACT_MATCH';
    existingCanonicalUser = {
      id: userByEmail.id,
      email: userByEmail.email,
      name: userByEmail.name,
      isActive: userByEmail.isActive,
    };
  } else if (userByEmail && !userById) {
    identityState = 'EMAIL_ID_MISMATCH';
  } else if (!userByEmail && userById) {
    identityState = 'CANONICAL_ID_OCCUPIED';
  } else {
    identityState = 'SPLIT_IDENTITY';
  }

  if (identityState === 'EMAIL_ID_MISMATCH') {
    blockers.push(`Canonical email ${CANONICAL_OWNER_EMAIL} belongs to a different user id; refusing to bootstrap`);
  } else if (identityState === 'CANONICAL_ID_OCCUPIED') {
    blockers.push(`Canonical user id ${CANONICAL_OWNER_USER_ID} belongs to a different email; refusing to bootstrap`);
  } else if (identityState === 'SPLIT_IDENTITY') {
    blockers.push('Canonical email and canonical user id resolve to two different users; refusing to bootstrap');
  }

  let existingOwnerScopes: CanonicalOwnerScope[] = [];
  let existingNonOwnerScopes: CanonicalOwnerNonOwnerScope[] = [];
  let legacyUserBranchRoleRows: CanonicalOwnerLegacyRow[] = [];

  if (existingCanonicalUser) {
    if (!existingCanonicalUser.isActive) {
      blockers.push('Canonical OWNER user is inactive; refusing to implicitly reactivate');
    }

    const allScopes = await db.userRoleScope.findMany({
      where: { userId: existingCanonicalUser.id },
      include: { role: { select: { code: true } } },
      orderBy: { id: 'asc' },
    });
    existingOwnerScopes = allScopes
      .filter((scope) => ownerRoleRow && scope.roleId === ownerRoleRow.id)
      .map((scope) => ({ id: scope.id, scopeKind: scope.scopeKind, locationId: scope.locationId }));
    existingNonOwnerScopes = allScopes
      .filter((scope) => !ownerRoleRow || scope.roleId !== ownerRoleRow.id)
      .map((scope) => ({
        id: scope.id,
        roleCode: scope.role.code,
        scopeKind: scope.scopeKind,
        locationId: scope.locationId,
      }));

    const legacyRows = await db.userBranchRole.findMany({
      where: { userId: existingCanonicalUser.id },
      include: { role: { select: { code: true } }, branch: { select: { id: true, code: true } } },
      orderBy: { id: 'asc' },
    });
    legacyUserBranchRoleRows = legacyRows.map((row) => ({
      id: row.id,
      roleCode: row.role.code,
      branchId: row.branch.id,
      branchCode: row.branch.code,
    }));
    if (legacyUserBranchRoleRows.length > 0) {
      blockers.push(
        `Canonical OWNER identity has ${legacyUserBranchRoleRows.length} legacy UserBranchRole row(s); ` +
          'refusing to declare it canonical without human review',
      );
    }
  }

  // GC4F3R1 finding 4: report EVERY other user holding any OWNER-role
  // UserRoleScope row, not only a COMPANY one — a malformed OWNER LOCATION
  // or mixed-scope holder is real, schema-representable state (see
  // schema.prisma's two partial unique indexes on UserRoleScope) that a
  // human reviewing a privileged bootstrap deserves to see, even though
  // authorization-policy.ts's isValidOwnerAssignment treats a non-COMPANY
  // OWNER row as contributing zero implicit authority.
  const otherOwnerScopeRows = ownerRoleRow
    ? await db.userRoleScope.findMany({
        where: { roleId: ownerRoleRow.id, userId: { not: CANONICAL_OWNER_USER_ID } },
        include: { user: { select: { id: true, email: true, name: true, isActive: true } } },
        orderBy: [{ userId: 'asc' }, { id: 'asc' }],
      })
    : [];
  const otherOwnerUsersByUserId = new Map<string, CanonicalOwnerOtherUser>();
  for (const row of otherOwnerScopeRows) {
    let entry = otherOwnerUsersByUserId.get(row.userId);
    if (!entry) {
      entry = {
        userId: row.user.id,
        email: row.user.email,
        name: row.user.name,
        isActive: row.user.isActive,
        scopes: [],
      };
      otherOwnerUsersByUserId.set(row.userId, entry);
    }
    entry.scopes.push({ scopeKind: row.scopeKind, locationId: row.locationId });
  }
  const otherOwnerUsers = [...otherOwnerUsersByUserId.values()].sort((a, b) => a.userId.localeCompare(b.userId));
  for (const user of otherOwnerUsers) {
    user.scopes.sort((a, b) => {
      if (a.scopeKind !== b.scopeKind) return a.scopeKind.localeCompare(b.scopeKind);
      return (a.locationId ?? '').localeCompare(b.locationId ?? '');
    });
  }

  let action: CanonicalOwnerAction;
  if (identityState === 'ABSENT') {
    action = 'CREATE_USER_AND_OWNER_SCOPE';
  } else if (identityState !== 'EXACT_MATCH') {
    action = 'BLOCKED';
  } else if (existingOwnerScopes.length === 0) {
    action = 'ADD_OWNER_SCOPE';
  } else if (existingOwnerScopes.length === 1 && isCanonicalCompanyScope(existingOwnerScopes[0]!)) {
    action = 'NOOP_ALREADY_CANONICAL';
  } else {
    action = 'RECONCILE_OWNER_SCOPE';
  }

  const readyForExecution = blockers.length === 0;
  if (!readyForExecution) action = 'BLOCKED';

  return {
    canonical: { userId: CANONICAL_OWNER_USER_ID, email: CANONICAL_OWNER_EMAIL, expectedName: CANONICAL_OWNER_NAME },
    ownerRole: {
      id: ownerRoleRow?.id ?? null,
      exists: Boolean(ownerRoleRow),
      unexpectedRolePermissionCount: unexpectedRolePermissionCodes.length,
      unexpectedRolePermissionCodes,
    },
    identityState,
    existingCanonicalUser,
    existingOwnerScopes,
    existingNonOwnerScopes,
    legacyUserBranchRoleRows,
    otherOwnerUsers,
    targetScope: { scopeKind: 'COMPANY', locationId: null },
    action,
    passwordRequiredForExecute: identityState === 'ABSENT',
    readyForExecution,
    blockers,
  };
}

export type BootstrapCanonicalOwnerOptions = { createPasswordHash?: string };

export type BootstrapCanonicalOwnerResult = {
  actionPerformed: CanonicalOwnerAction;
  userCreated: boolean;
  ownerScopeChanged: boolean;
  canonicalUserId: string;
};

type BootstrapDatabase = Pick<
  PrismaClient,
  'role' | 'rolePermission' | 'user' | 'userRoleScope' | 'userBranchRole' | '$transaction'
>;

type LockedCanonicalUser = { id: string; email: string; isActive: boolean };

// GC4F3 (Phase 1 Global Closeout): the narrow, auditable mutator for the
// canonical demo OWNER identity — CLI-invoked only (see
// scripts/bootstrap-canonical-owner.ts), never called from a request path,
// and never wired into prisma/seed.ts (that stays independent — see the
// GC4F3A design audit). Every safety prerequisite the planner checks is
// re-verified here, inside the single transaction that performs the write,
// never trusting a plan computed outside it (mutation-time truth always
// wins over a stale preliminary plan). Acquires the SAME maintenance
// advisory lock prisma/seed.ts's run() uses, so this can never race a
// concurrent seed/reset touching the same identity; locks the existing
// user's row FOR UPDATE (the same pattern scope-assignment.service.ts uses)
// before mutating its scope, so this also serializes against a concurrent
// scope-assignment operation on the same user. Only ever deletes/creates
// UserRoleScope rows scoped to (canonicalUserId, ownerRoleId) — never a
// whole-user deletion, so any independent non-OWNER assignment on this user
// is always preserved untouched, and never touches UserBranchRole or any
// other user's row.
export async function bootstrapCanonicalOwner(
  db: BootstrapDatabase,
  options: BootstrapCanonicalOwnerOptions = {},
): Promise<BootstrapCanonicalOwnerResult> {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(${MAINTENANCE_ADVISORY_LOCK_ID})::text`;

    const ownerRole = await tx.role.findUnique({ where: { code: 'OWNER' } });
    if (!ownerRole) {
      throw new Error('Production OWNER Role does not exist; run the Phase 1B RBAC catalog bootstrap first');
    }

    const unexpectedGrantCount = await tx.rolePermission.count({ where: { roleId: ownerRole.id } });
    if (unexpectedGrantCount > 0) {
      throw new Error(
        `OWNER Role has ${unexpectedGrantCount} unexpected RolePermission grant(s); refusing to bootstrap`,
      );
    }

    // GC4F3R1 finding 2: least-privilege select — mirrors the planner's own
    // identitySelect; never load passwordHash for a read that only needs to
    // classify identity state.
    const identitySelect = { id: true, email: true, name: true, isActive: true } as const;
    const userByEmail = await tx.user.findUnique({ where: { email: CANONICAL_OWNER_EMAIL }, select: identitySelect });
    const userById = await tx.user.findUnique({ where: { id: CANONICAL_OWNER_USER_ID }, select: identitySelect });

    let canonicalUser: LockedCanonicalUser;
    let userCreated = false;

    if (!userByEmail && !userById) {
      if (!options.createPasswordHash) {
        throw new Error(
          'Canonical OWNER user does not exist and no createPasswordHash was supplied; refusing to bootstrap',
        );
      }
      // GC4F3R2: passwordHash must still be WRITTEN here (creation requires
      // persisting it), but the create RESULT is narrowed to exactly what
      // canonicalUser needs below — a bare create() with no select would
      // otherwise load every column, including passwordHash, straight back.
      const created = await tx.user.create({
        data: {
          id: CANONICAL_OWNER_USER_ID,
          name: CANONICAL_OWNER_NAME,
          email: CANONICAL_OWNER_EMAIL,
          passwordHash: options.createPasswordHash,
        },
        select: { id: true, email: true, isActive: true },
      });
      canonicalUser = { id: created.id, email: created.email, isActive: created.isActive };
      userCreated = true;
    } else if (userByEmail && userById && userByEmail.id === userById.id) {
      // GC4F3R1 finding 1: a concurrent direct User.email change landing
      // between the identity read above and this row lock could otherwise
      // leave OWNER scope reconciliation proceeding against a
      // no-longer-canonical identity — re-verify id/email/isActive against
      // the just-locked row, never trusting the pre-lock read alone. Fails
      // closed rather than silently restoring the email or reinterpreting
      // the mismatch as safe.
      const locked = await tx.$queryRaw<LockedCanonicalUser[]>`
        SELECT id, email, "isActive" FROM "User" WHERE id = ${CANONICAL_OWNER_USER_ID} FOR UPDATE
      `;
      if (locked.length === 0) {
        throw new Error('Canonical OWNER user disappeared during bootstrap; refusing to proceed');
      }
      const row = locked[0]!;
      if (row.id !== CANONICAL_OWNER_USER_ID || row.email !== CANONICAL_OWNER_EMAIL) {
        throw new Error(
          'Canonical OWNER user email changed concurrently between the initial read and the row lock; refusing to bootstrap',
        );
      }
      if (!row.isActive) {
        throw new Error('Canonical OWNER user is inactive; refusing to implicitly reactivate');
      }
      canonicalUser = row;
    } else {
      throw new Error('Canonical OWNER identity is ambiguous (email/id mismatch or split identity); refusing to bootstrap');
    }

    const legacyRowCount = await tx.userBranchRole.count({ where: { userId: canonicalUser.id } });
    if (legacyRowCount > 0) {
      throw new Error(
        `Canonical OWNER identity has ${legacyRowCount} legacy UserBranchRole row(s); refusing to bootstrap`,
      );
    }

    const ownerScopes = await tx.userRoleScope.findMany({
      where: { userId: canonicalUser.id, roleId: ownerRole.id },
    });
    const alreadyCanonical = ownerScopes.length === 1 && isCanonicalCompanyScope(ownerScopes[0]!);

    let ownerScopeChanged = false;
    if (!alreadyCanonical) {
      // Scoped to (canonicalUser.id, ownerRole.id) ONLY — never userId
      // alone, so an independent non-OWNER assignment for this same user is
      // never touched by this deleteMany.
      await tx.userRoleScope.deleteMany({ where: { userId: canonicalUser.id, roleId: ownerRole.id } });
      await tx.userRoleScope.create({
        data: { userId: canonicalUser.id, roleId: ownerRole.id, scopeKind: 'COMPANY', locationId: null },
      });
      ownerScopeChanged = true;
    }

    const actionPerformed: CanonicalOwnerAction = userCreated
      ? 'CREATE_USER_AND_OWNER_SCOPE'
      : alreadyCanonical
        ? 'NOOP_ALREADY_CANONICAL'
        : ownerScopes.length === 0
          ? 'ADD_OWNER_SCOPE'
          : 'RECONCILE_OWNER_SCOPE';

    return {
      actionPerformed,
      userCreated,
      ownerScopeChanged: userCreated ? true : ownerScopeChanged,
      canonicalUserId: canonicalUser.id,
    };
  });
}
