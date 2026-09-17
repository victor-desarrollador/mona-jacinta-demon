import type { PrismaClient } from '../../generated/prisma/client.js';
import { resolveProductionRoleCodeForLegacy } from './legacy-role-map.js';

type SyncDatabase = Pick<PrismaClient, 'userBranchRole' | 'role' | 'location' | 'userRoleScope'>;
type BackfillDatabase = Pick<
  PrismaClient,
  'userBranchRole' | 'role' | 'location' | 'userRoleScope' | '$transaction'
>;

export type ScopeBackfillResult = {
  legacyRowCount: number;
  created: number;
  alreadyPresent: number;
};

// ADD -> BACKFILL step of the UserBranchRole -> UserRoleScope lifecycle
// (docs/development/migrations.md §16; docs/production-v1/08-implementation-roadmap.md
// Phase 1C). UserRoleScope itself was already added in Phase 1B — this is
// backfill only. One UserRoleScope LOCATION row is created per existing
// UserBranchRole row: `locationId` reuses `branchId` directly (Location.id ==
// Branch.id, set that way by organization.service.ts's Phase 1A backfill —
// docs/production-v1/06-erd-data-model.md §Location), never a lookup on a
// mutable business key. The target role code comes only from
// legacy-role-map.ts's explicit table — this function never infers COMPANY
// scope or a different role from permissions, branch count, or any other
// heuristic (per the Phase 1C spec: "MANAGER handled explicitly, not
// guessed"). Idempotent: converges by the natural (userId, roleId, LOCATION,
// locationId) key via `findFirst` — UserRoleScope has no Prisma-level
// `@@unique` (the uniqueness is two raw-SQL partial unique indexes, see
// schema.prisma's UserRoleScope comment), so `findUnique` cannot be used
// here. UserBranchRole itself is only ever read here, never mutated — it
// stays fully available (DEPRECATE, not REMOVE; the SWITCH this phase does
// perform is scoped to LOCATION/COMPANY resolution only — see Task 6 — and
// REMOVE is a much-later phase).
//
// Core sync operation, usable on an existing transaction client — no
// `$transaction` of its own (same split as catalog.service.ts's
// `syncProductionRbacCatalog` vs `bootstrapProductionRbacCatalog`). This is
// what Task 7 wires into prisma/seed.ts's populate(), on its own already-open
// transaction, so a successful seed/reset can never leave UserRoleScope
// stale relative to UserBranchRole: never a nested interactive transaction.
export async function syncUserRoleScopeFromUserBranchRole(
  db: SyncDatabase,
): Promise<ScopeBackfillResult> {
  const legacyRows = await db.userBranchRole.findMany({
    include: { role: true },
    orderBy: { id: 'asc' },
  });

  const productionRoleCodes = [
    ...new Set(legacyRows.map((row) => resolveProductionRoleCodeForLegacy(row.role.code))),
  ];
  const productionRoles = await db.role.findMany({
    where: { code: { in: productionRoleCodes } },
  });
  const productionRoleIdByCode = new Map(productionRoles.map((role) => [role.code, role.id]));
  const missingRoles = productionRoleCodes.filter((code) => !productionRoleIdByCode.has(code));
  if (missingRoles.length > 0) {
    throw new Error(
      `Production Role(s) ${missingRoles.join(', ')} do not exist yet; run the Phase 1B RBAC ` +
        `catalog bootstrap (bootstrapProductionRbacCatalog) before backfilling scope assignments`,
    );
  }

  const branchIds = [...new Set(legacyRows.map((row) => row.branchId))];
  const locations = await db.location.findMany({ where: { id: { in: branchIds } } });
  const locationIds = new Set(locations.map((location) => location.id));
  const missingLocations = branchIds.filter((id) => !locationIds.has(id));
  if (missingLocations.length > 0) {
    throw new Error(
      `Location row(s) missing for Branch id(s) ${missingLocations.join(', ')}; run the ` +
        `Phase 1A Branch -> Location backfill (backfillLocationsFromBranches) first`,
    );
  }

  let created = 0;
  let alreadyPresent = 0;
  for (const legacy of legacyRows) {
    const targetRoleCode = resolveProductionRoleCodeForLegacy(legacy.role.code);
    const targetRoleId = productionRoleIdByCode.get(targetRoleCode)!;
    const existing = await db.userRoleScope.findFirst({
      where: {
        userId: legacy.userId,
        roleId: targetRoleId,
        scopeKind: 'LOCATION',
        locationId: legacy.branchId,
      },
    });
    if (existing) {
      alreadyPresent += 1;
      continue;
    }
    await db.userRoleScope.create({
      data: {
        userId: legacy.userId,
        roleId: targetRoleId,
        scopeKind: 'LOCATION',
        locationId: legacy.branchId,
      },
    });
    created += 1;
  }

  return { legacyRowCount: legacyRows.length, created, alreadyPresent };
}

// Standalone entry point (the `db:backfill-user-role-scope` CLI, or any other
// caller without an existing transaction): opens its own transaction around
// `syncUserRoleScopeFromUserBranchRole` so backfilled rows either all land or
// none do. This is the function Tasks 3/4/5's tests and the CLI script call;
// Task 7's seed/reset integration calls the core `sync...` function above
// directly on its own transaction instead.
export async function backfillUserRoleScopeFromUserBranchRole(
  db: BackfillDatabase,
): Promise<ScopeBackfillResult> {
  return db.$transaction((tx) => syncUserRoleScopeFromUserBranchRole(tx));
}

type VerifyDatabase = Pick<PrismaClient, 'userBranchRole' | 'role' | 'userRoleScope'>;

export type ScopeBackfillVerification = {
  ok: boolean;
  issues: string[];
  legacyRowCount: number;
  scopeCount: number;
};

// VERIFY step: proves row-by-row equivalence between UserBranchRole and the
// legacy-derived subset of UserRoleScope rows, without trusting the
// backfill's own return value. Deliberately verifies only that subset — an
// expected `userId|roleId|LOCATION|branchId` key per legacy row — rather
// than asserting every UserRoleScope row in the database is legacy-derived.
// As of Phase 1D.4.2, a legitimate independently-managed row can coexist
// (e.g. the canonical OWNER's COMPANY scope, seeded outside this backfill);
// such rows are simply outside this function's concern and never flagged.
// Duplicate detection here is defense-in-depth: the raw-SQL partial unique
// indexes (uq_user_role_scope_location / uq_user_role_scope_company, see
// schema.prisma) already make a real duplicate impossible to create through
// normal writes.
export async function verifyUserRoleScopeBackfill(
  db: VerifyDatabase,
): Promise<ScopeBackfillVerification> {
  const issues: string[] = [];
  const [legacyRows, roles, scopes] = await Promise.all([
    db.userBranchRole.findMany({ include: { role: true } }),
    db.role.findMany(),
    db.userRoleScope.findMany(),
  ]);
  const roleIdByCode = new Map(roles.map((role) => [role.code, role.id]));

  const scopeKeyCounts = new Map<string, number>();
  for (const scope of scopes) {
    const key = `${scope.userId}|${scope.roleId}|${scope.scopeKind}|${scope.locationId}`;
    scopeKeyCounts.set(key, (scopeKeyCounts.get(key) ?? 0) + 1);
  }

  const expectedKeys = new Set<string>();
  for (const legacy of legacyRows) {
    let targetRoleCode;
    try {
      targetRoleCode = resolveProductionRoleCodeForLegacy(legacy.role.code);
    } catch {
      issues.push(`UserBranchRole ${legacy.id} has unmapped legacy role code ${legacy.role.code}`);
      continue;
    }
    const targetRoleId = roleIdByCode.get(targetRoleCode);
    if (!targetRoleId) {
      issues.push(
        `Production Role ${targetRoleCode} missing; cannot verify UserBranchRole ${legacy.id}`,
      );
      continue;
    }
    const key = `${legacy.userId}|${targetRoleId}|LOCATION|${legacy.branchId}`;
    expectedKeys.add(key);
    const count = scopeKeyCounts.get(key) ?? 0;
    if (count === 0) {
      issues.push(
        `missing UserRoleScope for UserBranchRole ${legacy.id} (user ${legacy.userId}, ` +
          `role ${legacy.role.code} -> ${targetRoleCode}, location ${legacy.branchId})`,
      );
    } else if (count > 1) {
      issues.push(`duplicate UserRoleScope for ${key}`);
    }
  }

  const legacyDerivedScopeCount = scopes.filter((scope) =>
    expectedKeys.has(`${scope.userId}|${scope.roleId}|${scope.scopeKind}|${scope.locationId}`),
  ).length;

  if (legacyDerivedScopeCount !== legacyRows.length) {
    issues.push(
      `expected ${legacyRows.length} UserRoleScope row(s) (one per UserBranchRole), found ${legacyDerivedScopeCount}`,
    );
  }

  return {
    ok: issues.length === 0,
    issues,
    legacyRowCount: legacyRows.length,
    scopeCount: scopes.length,
  };
}
