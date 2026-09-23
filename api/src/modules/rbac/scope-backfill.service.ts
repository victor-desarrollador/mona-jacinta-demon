import type { PrismaClient } from '../../generated/prisma/client.js';
import { resolveLegacyRoleDisposition, type LegacyRoleDisposition } from './legacy-role-map.js';

type SyncDatabase = Pick<PrismaClient, 'userBranchRole' | 'role' | 'location' | 'userRoleScope'>;
type BackfillDatabase = Pick<
  PrismaClient,
  'userBranchRole' | 'role' | 'location' | 'userRoleScope' | '$transaction'
>;

export type ScopeBackfillResult = {
  legacyRowCount: number;
  eligibleRowCount: number;
  deferredRowCount: number;
  created: number;
  alreadyPresent: number;
};

// ADD -> BACKFILL step of the UserBranchRole -> UserRoleScope lifecycle
// (docs/development/migrations.md §16; docs/production-v1/08-implementation-roadmap.md
// Phase 1C). UserRoleScope itself was already added in Phase 1B — this is
// backfill only. One UserRoleScope LOCATION row is created per ELIGIBLE
// UserBranchRole row: `locationId` reuses `branchId` directly (Location.id ==
// Branch.id, set that way by organization.service.ts's Phase 1A backfill —
// docs/production-v1/06-erd-data-model.md §Location), never a lookup on a
// mutable business key.
//
// D2.1 (deferred-MANAGER, AGENTS.md "Roles — Production V1"): every legacy
// row's disposition is resolved via legacy-role-map.ts's
// resolveLegacyRoleDisposition BEFORE any mutation. ELIGIBLE rows (ADMIN/
// CASHIER/SELLER) get exactly the historical Phase1C treatment below.
// DEFERRED rows (MANAGER) never enter the Production-role lookup, never
// enter the Location prerequisite lookup, and never get a UserRoleScope
// write — they are counted, never guessed at or silently skipped. An
// unknown/unclassified legacy code still fails the whole function closed,
// exactly as before. Idempotent: converges by the natural (userId, roleId,
// LOCATION, locationId) key via `findFirst` — UserRoleScope has no
// Prisma-level `@@unique` (the uniqueness is two raw-SQL partial unique
// indexes, see schema.prisma's UserRoleScope comment), so `findUnique`
// cannot be used here. UserBranchRole itself is only ever read here, never
// mutated.
//
// Core sync operation, usable on an existing transaction client — no
// `$transaction` of its own (same split as catalog.service.ts's
// `syncProductionRbacCatalog` vs `bootstrapProductionRbacCatalog`).
export async function syncUserRoleScopeFromUserBranchRole(
  db: SyncDatabase,
): Promise<ScopeBackfillResult> {
  const legacyRows = await db.userBranchRole.findMany({
    include: { role: true },
    orderBy: { id: 'asc' },
  });

  // Resolved for every row up front — an unknown/unclassified code throws
  // here, before any Production-role or Location lookup, preserving
  // all-or-nothing fail-closed behavior.
  const dispositionByRowId = new Map<string, LegacyRoleDisposition>();
  for (const row of legacyRows) {
    dispositionByRowId.set(row.id, resolveLegacyRoleDisposition(row.role.code));
  }

  const eligibleRows = legacyRows.filter((row) => dispositionByRowId.get(row.id)!.kind === 'ELIGIBLE');
  const deferredRowCount = legacyRows.length - eligibleRows.length;

  // Production Role lookup derived ONLY from ELIGIBLE rows — a DEFERRED
  // MANAGER row never causes WAREHOUSE (or any other role) to appear here.
  const productionRoleCodes = [
    ...new Set(
      eligibleRows.map((row) => {
        const disposition = dispositionByRowId.get(row.id)!;
        return disposition.kind === 'ELIGIBLE' ? disposition.productionRoleCode : undefined;
      }),
    ),
  ].filter((code): code is NonNullable<typeof code> => code !== undefined);
  const productionRoles = await db.role.findMany({ where: { code: { in: productionRoleCodes } } });
  const productionRoleIdByCode = new Map(productionRoles.map((role) => [role.code, role.id]));
  const missingRoles = productionRoleCodes.filter((code) => !productionRoleIdByCode.has(code));
  if (missingRoles.length > 0) {
    throw new Error(
      `Production Role(s) ${missingRoles.join(', ')} do not exist yet; run the Phase 1B RBAC ` +
        `catalog bootstrap (bootstrapProductionRbacCatalog) before backfilling scope assignments`,
    );
  }

  // Location prerequisite derived ONLY from ELIGIBLE rows — a DEFERRED
  // MANAGER row's Branch is never required to have a matching Location.
  const branchIds = [...new Set(eligibleRows.map((row) => row.branchId))];
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
  for (const legacy of eligibleRows) {
    const disposition = dispositionByRowId.get(legacy.id)!;
    if (disposition.kind !== 'ELIGIBLE') continue; // narrows for TS; eligibleRows is already filtered
    const targetRoleId = productionRoleIdByCode.get(disposition.productionRoleCode)!;
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

  return {
    legacyRowCount: legacyRows.length,
    eligibleRowCount: eligibleRows.length,
    deferredRowCount,
    created,
    alreadyPresent,
  };
}

// Standalone entry point (the `db:backfill-user-role-scope` CLI, or any other
// caller without an existing transaction): opens its own transaction around
// `syncUserRoleScopeFromUserBranchRole` so backfilled rows either all land or
// none do.
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
  eligibleRowCount: number;
  deferredRowCount: number;
  scopeCount: number;
};

// VERIFY step: proves row-by-row equivalence between UserBranchRole's
// ELIGIBLE-classified rows and the legacy-derived subset of UserRoleScope
// rows, without trusting the backfill's own return value. D2.1: the parity
// denominator is ELIGIBLE rows only — a DEFERRED MANAGER row contributes no
// expected key, no missing-scope issue, and is never counted toward parity.
// `scopeCount` keeps its original, unchanged meaning: the total count of
// UserRoleScope rows read by this function, legacy-derived or not — it is
// NEVER the parity denominator (eligibleRowCount is). A legitimate
// independently-managed row (e.g. the canonical OWNER's COMPANY scope, or a
// later ADMIN COMPANY canonicalization) is simply outside this function's
// concern and never flagged — it still counts toward `scopeCount`, since
// that field's contract has always been "every UserRoleScope row read," not
// "every legacy-derived row." Duplicate detection here is defense-in-depth:
// the raw-SQL partial unique indexes (uq_user_role_scope_location /
// uq_user_role_scope_company, see schema.prisma) already make a real
// duplicate impossible to create through normal writes.
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
  let eligibleRowCount = 0;
  let deferredRowCount = 0;
  for (const legacy of legacyRows) {
    let disposition: LegacyRoleDisposition;
    try {
      disposition = resolveLegacyRoleDisposition(legacy.role.code);
    } catch {
      issues.push(`UserBranchRole ${legacy.id} has unmapped legacy role code ${legacy.role.code}`);
      continue;
    }

    if (disposition.kind === 'DEFERRED') {
      deferredRowCount += 1;
      continue;
    }

    eligibleRowCount += 1;
    const targetRoleId = roleIdByCode.get(disposition.productionRoleCode);
    if (!targetRoleId) {
      issues.push(
        `Production Role ${disposition.productionRoleCode} missing; cannot verify UserBranchRole ${legacy.id}`,
      );
      continue;
    }
    const key = `${legacy.userId}|${targetRoleId}|LOCATION|${legacy.branchId}`;
    expectedKeys.add(key);
    const count = scopeKeyCounts.get(key) ?? 0;
    if (count === 0) {
      issues.push(
        `missing UserRoleScope for UserBranchRole ${legacy.id} (user ${legacy.userId}, ` +
          `role ${legacy.role.code} -> ${disposition.productionRoleCode}, location ${legacy.branchId})`,
      );
    } else if (count > 1) {
      issues.push(`duplicate UserRoleScope for ${key}`);
    }
  }

  const legacyDerivedScopeCount = scopes.filter((scope) =>
    expectedKeys.has(`${scope.userId}|${scope.roleId}|${scope.scopeKind}|${scope.locationId}`),
  ).length;

  if (legacyDerivedScopeCount !== eligibleRowCount) {
    issues.push(
      `expected ${eligibleRowCount} UserRoleScope row(s) (one per ELIGIBLE UserBranchRole), found ${legacyDerivedScopeCount}`,
    );
  }

  return {
    ok: issues.length === 0,
    issues,
    legacyRowCount: legacyRows.length,
    eligibleRowCount,
    deferredRowCount,
    scopeCount: scopes.length,
  };
}

type PlanDatabase = Pick<PrismaClient, 'userBranchRole' | 'role' | 'location' | 'userRoleScope'>;

export type UserRoleScopeBackfillPlanRowBlocker = 'MISSING_PRODUCTION_ROLE' | 'MISSING_LOCATION';

export type UserRoleScopeBackfillPlanRowDisposition =
  | {
      kind: 'ELIGIBLE';
      target: {
        productionRoleCode: string;
        productionRoleId: string | null;
        scopeKind: 'LOCATION';
        locationId: string;
        locationCode: string | null;
        locationName: string | null;
        alreadyPresent: boolean;
        wouldCreate: boolean;
      };
      blocker: UserRoleScopeBackfillPlanRowBlocker | null;
    }
  | { kind: 'DEFERRED'; reason: 'LEGACY_MANAGER' }
  | { kind: 'BLOCKED'; blocker: 'UNMAPPED_LEGACY_ROLE' };

export type UserRoleScopeBackfillPlanRow = {
  legacyRowId: string;
  userId: string;
  name: string;
  email: string;
  isActive: boolean;
  legacyRoleCode: string;
  legacyRoleId: string;
  branchId: string;
  branchCode: string;
  branchName: string;
  disposition: UserRoleScopeBackfillPlanRowDisposition;
};

export type UserRoleScopeBackfillCoexistingScope = {
  scopeId: string;
  userId: string;
  roleCode: string;
  scopeKind: 'LOCATION' | 'COMPANY';
  locationId: string | null;
};

export type UserRoleScopeBackfillPlan = {
  legacyRowCount: number;
  eligibleRowCount: number;
  deferredRowCount: number;
  currentUserRoleScopeCount: number;
  expectedCreateCount: number;
  alreadyPresentCount: number;
  readyForExecution: boolean;
  blockers: string[];
  rows: UserRoleScopeBackfillPlanRow[];
  unmappedLegacyRoleCodes: string[];
  missingProductionRoleCodes: string[];
  missingLocationBranchIds: string[];
  coexistingScopes: UserRoleScopeBackfillCoexistingScope[];
};

// GC4F1 (Phase 1 Global Closeout) / D2.1: read-only preflight for the
// mutation above — SELECT/find/count queries only, never create/update/
// delete/upsert/$executeRaw/a transaction, and never calls
// syncUserRoleScopeFromUserBranchRole/backfillUserRoleScopeFromUserBranchRole.
// D2.1: models three semantic outcomes per row — ELIGIBLE (has a real
// LOCATION target), DEFERRED (MANAGER; no fake target of any kind), BLOCKED
// (unmapped legacy code; no fake target) — via a true discriminated union,
// rather than one shape where every row pretends to have the same target
// structure. Production-role and Location prerequisite lookups are derived
// ONLY from ELIGIBLE rows (Section 13 invariant): a DEFERRED MANAGER row
// never validates against WAREHOUSE or a target Location, and a missing
// Location belonging only to a DEFERRED row never appears in
// missingLocationBranchIds and never makes the plan unready.
export async function planUserRoleScopeBackfill(db: PlanDatabase): Promise<UserRoleScopeBackfillPlan> {
  const legacyRows = await db.userBranchRole.findMany({
    include: {
      role: { select: { id: true, code: true } },
      user: { select: { id: true, name: true, email: true, isActive: true } },
      branch: { select: { id: true, code: true, name: true } },
    },
    orderBy: { id: 'asc' },
  });

  const dispositionByLegacyRowId = new Map<string, LegacyRoleDisposition | null>();
  const unmappedLegacyRoleCodes = new Set<string>();
  for (const row of legacyRows) {
    try {
      dispositionByLegacyRowId.set(row.id, resolveLegacyRoleDisposition(row.role.code));
    } catch {
      dispositionByLegacyRowId.set(row.id, null);
      unmappedLegacyRoleCodes.add(row.role.code);
    }
  }

  const eligibleProductionRoleCodes = [
    ...new Set(
      [...dispositionByLegacyRowId.values()]
        .map((disposition) => (disposition?.kind === 'ELIGIBLE' ? disposition.productionRoleCode : null))
        .filter((code): code is NonNullable<typeof code> => code !== null),
    ),
  ];
  const productionRoles = await db.role.findMany({ where: { code: { in: eligibleProductionRoleCodes } } });
  const productionRoleByCode = new Map(productionRoles.map((role) => [role.code, role]));
  const missingProductionRoleCodes = eligibleProductionRoleCodes.filter(
    (code) => !productionRoleByCode.has(code),
  );

  // Location prerequisite derived ONLY from ELIGIBLE rows' branchIds — a
  // DEFERRED MANAGER row's branch is never looked up here (Section 13).
  const eligibleBranchIds = [
    ...new Set(
      legacyRows
        .filter((row) => dispositionByLegacyRowId.get(row.id)?.kind === 'ELIGIBLE')
        .map((row) => row.branchId),
    ),
  ];
  const locations = eligibleBranchIds.length
    ? await db.location.findMany({ where: { id: { in: eligibleBranchIds } } })
    : [];
  const locationById = new Map(locations.map((location) => [location.id, location]));
  const missingLocationBranchIds = eligibleBranchIds.filter((id) => !locationById.has(id));

  // Every (userId, targetRoleId) pair an ELIGIBLE row maps to — used to
  // fetch only the existing scopes actually relevant to this backfill.
  const targetRoleIdsByUserId = new Map<string, Set<string>>();
  for (const legacy of legacyRows) {
    const disposition = dispositionByLegacyRowId.get(legacy.id);
    if (disposition?.kind !== 'ELIGIBLE') continue;
    const role = productionRoleByCode.get(disposition.productionRoleCode);
    if (!role) continue;
    const set = targetRoleIdsByUserId.get(legacy.userId) ?? new Set<string>();
    set.add(role.id);
    targetRoleIdsByUserId.set(legacy.userId, set);
  }
  const relevantUserIds = [...targetRoleIdsByUserId.keys()];
  const existingScopes = relevantUserIds.length
    ? await db.userRoleScope.findMany({
        where: { userId: { in: relevantUserIds } },
        include: { role: { select: { code: true } } },
      })
    : [];
  const existingScopeKeySet = new Set(
    existingScopes.map((scope) => `${scope.userId}|${scope.roleId}|${scope.scopeKind}|${scope.locationId}`),
  );

  const rows: UserRoleScopeBackfillPlanRow[] = [];
  const exactTargetKeys = new Set<string>();
  let expectedCreateCount = 0;
  let alreadyPresentCount = 0;
  let eligibleRowCount = 0;
  let deferredRowCount = 0;

  for (const legacy of legacyRows) {
    const base = {
      legacyRowId: legacy.id,
      userId: legacy.user.id,
      name: legacy.user.name,
      email: legacy.user.email,
      isActive: legacy.user.isActive,
      legacyRoleCode: legacy.role.code,
      legacyRoleId: legacy.role.id,
      branchId: legacy.branch.id,
      branchCode: legacy.branch.code,
      branchName: legacy.branch.name,
    };

    const disposition = dispositionByLegacyRowId.get(legacy.id);
    if (disposition === null) {
      rows.push({ ...base, disposition: { kind: 'BLOCKED', blocker: 'UNMAPPED_LEGACY_ROLE' } });
      continue;
    }
    if (disposition!.kind === 'DEFERRED') {
      deferredRowCount += 1;
      rows.push({ ...base, disposition: { kind: 'DEFERRED', reason: disposition!.reason } });
      continue;
    }

    eligibleRowCount += 1;
    const productionRoleCode = disposition!.productionRoleCode;
    const productionRole = productionRoleByCode.get(productionRoleCode) ?? null;
    const location = locationById.get(legacy.branchId) ?? null;

    let blocker: UserRoleScopeBackfillPlanRowBlocker | null = null;
    if (!productionRole) blocker = 'MISSING_PRODUCTION_ROLE';
    else if (!location) blocker = 'MISSING_LOCATION';

    let alreadyPresent = false;
    let wouldCreate = false;
    if (!blocker && productionRole) {
      const key = `${legacy.userId}|${productionRole.id}|LOCATION|${legacy.branchId}`;
      exactTargetKeys.add(key);
      alreadyPresent = existingScopeKeySet.has(key);
      wouldCreate = !alreadyPresent;
      if (alreadyPresent) alreadyPresentCount += 1;
      else expectedCreateCount += 1;
    }

    rows.push({
      ...base,
      disposition: {
        kind: 'ELIGIBLE',
        target: {
          productionRoleCode,
          productionRoleId: productionRole?.id ?? null,
          scopeKind: 'LOCATION',
          locationId: legacy.branchId,
          locationCode: location?.code ?? null,
          locationName: location?.name ?? null,
          alreadyPresent,
          wouldCreate,
        },
        blocker,
      },
    });
  }

  const coexistingScopes: UserRoleScopeBackfillCoexistingScope[] = existingScopes
    .filter(
      (scope) => !exactTargetKeys.has(`${scope.userId}|${scope.roleId}|${scope.scopeKind}|${scope.locationId}`),
    )
    .map((scope) => ({
      scopeId: scope.id,
      userId: scope.userId,
      roleCode: scope.role.code,
      scopeKind: scope.scopeKind,
      locationId: scope.locationId,
    }));

  const blockers: string[] = [
    ...[...unmappedLegacyRoleCodes].map((code) => `unmapped legacy role code: ${code}`),
    ...missingProductionRoleCodes.map((code) => `missing Production Role: ${code}`),
    ...missingLocationBranchIds.map((id) => `missing Location for Branch id: ${id}`),
  ];

  return {
    legacyRowCount: legacyRows.length,
    eligibleRowCount,
    deferredRowCount,
    currentUserRoleScopeCount: await db.userRoleScope.count(),
    expectedCreateCount,
    alreadyPresentCount,
    readyForExecution: blockers.length === 0,
    blockers,
    rows,
    unmappedLegacyRoleCodes: [...unmappedLegacyRoleCodes],
    missingProductionRoleCodes,
    missingLocationBranchIds,
    coexistingScopes,
  };
}
