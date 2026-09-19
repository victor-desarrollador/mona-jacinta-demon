import type { PrismaClient } from '../../generated/prisma/client.js';
import { ROLE_CODES } from './roles.js';
import { COMPANY_SCOPE_REQUIRED_FOR_ADMIN, productionPermissionValues, type ProductionPermission } from './permissions.js';

type Database = Pick<
  PrismaClient,
  'role' | 'userRoleScope' | 'rolePermission' | 'location' | 'user' | '$transaction'
>;

export type AdminCompanyBackfillResult = { usersConverted: number };

export type AdminCompanyBackfillPlanLocation = {
  locationId: string;
  locationCode: string;
  locationName: string;
  locationActive: boolean;
};

export type AdminCompanyBackfillPlanUser = {
  userId: string;
  name: string;
  email: string;
  isActive: boolean;
  locationAssignments: AdminCompanyBackfillPlanLocation[];
  alreadyHasCompanyAssignment: boolean;
  targetState: { scopeKind: 'COMPANY'; locationId: null };
};

export type AdminCompanyBackfillPlan = {
  adminRoleId: string;
  canonicalAdminPermissionCodes: ProductionPermission[];
  productionPermissionCount: number;
  actualAdminPermissionCodes: ProductionPermission[];
  catalogMatchesExpected: boolean;
  companyRequiredPermissionCodes: ProductionPermission[];
  totalAdminLocationRows: number;
  affectedUserCount: number;
  affectedUsers: AdminCompanyBackfillPlanUser[];
  usersWithMultipleLocationRows: number;
  usersAlreadyMixedLocationAndCompany: number;
  companyOnlyAdminUsers: { userId: string; name: string; email: string }[];
  activeLocations: { locationId: string; code: string; name: string }[];
  readyForExecution: boolean;
};

// Phase 1D.4.1 one-time data correction (AGENTS.md's Checkpoint /
// docs/superpowers/plans/2026-09-14-phase-1d-production-authorization.md
// Task 1D.4.1): Phase 1C's UserBranchRole -> UserRoleScope backfill gave
// every ADMIN a LOCATION row per branch, but the Phase 1D target model
// (AGENTS.md "Roles — Production V1") makes ADMIN a COMPANY-scoped role.
// This converts each affected user's ADMIN assignment(s) into exactly one
// COMPANY row (locationId: null), scoped strictly to (userId, ADMIN
// roleId) per user — it never deletes by userId alone, so a co-existing,
// independent assignment for that user under a different role (e.g.
// CASHIER) is left completely untouched. CLI-invoked only (see
// scripts/backfill-admin-company-scope.ts); never called from a request
// path.
export async function backfillAdminCompanyScope(db: Database): Promise<AdminCompanyBackfillResult> {
  const adminRole = await db.role.findUnique({ where: { code: ROLE_CODES.ADMIN } });
  if (!adminRole) {
    throw new Error(
      'Production ADMIN Role does not exist; run the Phase 1B RBAC catalog bootstrap ' +
        '(bootstrapProductionRbacCatalog) first',
    );
  }

  const affectedUserIds = [
    ...new Set(
      (
        await db.userRoleScope.findMany({
          where: { roleId: adminRole.id, scopeKind: 'LOCATION' },
          select: { userId: true },
        })
      ).map((row) => row.userId),
    ),
  ];

  let usersConverted = 0;
  for (const userId of affectedUserIds) {
    await db.$transaction(async (tx) => {
      // Scoped to (userId, adminRole.id) ONLY — never userId alone, so an
      // independent assignment for the same user under a different roleId
      // is never touched by this deleteMany.
      await tx.userRoleScope.deleteMany({ where: { userId, roleId: adminRole.id } });
      await tx.userRoleScope.create({
        data: { userId, roleId: adminRole.id, scopeKind: 'COMPANY', locationId: null },
      });
    });
    usersConverted += 1;
  }

  return { usersConverted };
}

// GC4A (Phase 1 Global Closeout): read-only preflight for the mutation above —
// SELECT/find queries only, never create/update/delete/upsert/$executeRaw/a
// transaction. Lets a human review exactly which ADMIN users and permissions
// backfillAdminCompanyScope would touch before the CLI's --execute path ever
// runs (see scripts/backfill-admin-company-scope.ts). Derives every
// permission list from the canonical productionPermissionValues /
// COMPANY_SCOPE_REQUIRED_FOR_ADMIN constants rather than a second
// hand-maintained list, and filters actual RolePermission grants down to
// those canonical codes so a legacy lowercase Demo V2 grant on the reused
// ADMIN Role can never be miscounted as Production authority.
export async function planAdminCompanyBackfill(db: Database): Promise<AdminCompanyBackfillPlan> {
  const adminRole = await db.role.findUnique({ where: { code: ROLE_CODES.ADMIN } });
  if (!adminRole) {
    throw new Error(
      'Production ADMIN Role does not exist; run the Phase 1B RBAC catalog bootstrap ' +
        '(bootstrapProductionRbacCatalog) first',
    );
  }

  const grants = await db.rolePermission.findMany({
    where: { roleId: adminRole.id },
    select: { permission: { select: { code: true } } },
  });
  const actualGrantedCodes = new Set(grants.map((grant) => grant.permission.code));
  const canonicalAdminPermissionCodes = [...productionPermissionValues];
  const actualAdminPermissionCodes = canonicalAdminPermissionCodes.filter((code) =>
    actualGrantedCodes.has(code),
  );
  // Catalog drift must fail closed: actualAdminPermissionCodes is already a
  // subset of canonicalAdminPermissionCodes (filtered above), so matching
  // lengths here proves every canonical code is actually granted — anything
  // short of that means a real grant is missing and the plan is not ready.
  const catalogMatchesExpected = actualAdminPermissionCodes.length === canonicalAdminPermissionCodes.length;

  const locationRows = await db.userRoleScope.findMany({
    where: { roleId: adminRole.id, scopeKind: 'LOCATION' },
    select: {
      userId: true,
      user: { select: { id: true, name: true, email: true, isActive: true } },
      location: { select: { id: true, code: true, name: true, isActive: true } },
    },
  });

  const companyRows = await db.userRoleScope.findMany({
    where: { roleId: adminRole.id, scopeKind: 'COMPANY' },
    select: { userId: true },
  });
  const companyUserIds = new Set(companyRows.map((row) => row.userId));

  const affectedByUserId = new Map<string, AdminCompanyBackfillPlanUser>();
  for (const row of locationRows) {
    // The DB-level CHECK constraint (chk_user_role_scope_consistency)
    // guarantees a LOCATION row always carries a locationId, so `location`
    // is never null here; this narrows the type for TS.
    if (!row.location) continue;
    let entry = affectedByUserId.get(row.userId);
    if (!entry) {
      entry = {
        userId: row.user.id,
        name: row.user.name,
        email: row.user.email,
        isActive: row.user.isActive,
        locationAssignments: [],
        alreadyHasCompanyAssignment: companyUserIds.has(row.userId),
        targetState: { scopeKind: 'COMPANY', locationId: null },
      };
      affectedByUserId.set(row.userId, entry);
    }
    entry.locationAssignments.push({
      locationId: row.location.id,
      locationCode: row.location.code,
      locationName: row.location.name,
      locationActive: row.location.isActive,
    });
  }

  const affectedUsers = [...affectedByUserId.values()]
    .map((user) => ({
      ...user,
      locationAssignments: [...user.locationAssignments].sort((a, b) =>
        a.locationCode.localeCompare(b.locationCode),
      ),
    }))
    .sort((a, b) => a.userId.localeCompare(b.userId));

  const companyOnlyUserIds = [...companyUserIds].filter((userId) => !affectedByUserId.has(userId));
  const companyOnlyRows = companyOnlyUserIds.length
    ? await db.user.findMany({
        where: { id: { in: companyOnlyUserIds } },
        select: { id: true, name: true, email: true },
      })
    : [];
  const companyOnlyAdminUsers = companyOnlyRows
    .map((user) => ({ userId: user.id, name: user.name, email: user.email }))
    .sort((a, b) => a.userId.localeCompare(b.userId));

  const activeLocationRows = await db.location.findMany({
    where: { isActive: true },
    select: { id: true, code: true, name: true },
  });
  const activeLocations = activeLocationRows
    .map((location) => ({ locationId: location.id, code: location.code, name: location.name }))
    .sort((a, b) => a.code.localeCompare(b.code));

  return {
    adminRoleId: adminRole.id,
    canonicalAdminPermissionCodes,
    productionPermissionCount: canonicalAdminPermissionCodes.length,
    actualAdminPermissionCodes,
    catalogMatchesExpected,
    companyRequiredPermissionCodes: [...COMPANY_SCOPE_REQUIRED_FOR_ADMIN],
    totalAdminLocationRows: locationRows.length,
    affectedUserCount: affectedUsers.length,
    affectedUsers,
    usersWithMultipleLocationRows: affectedUsers.filter((user) => user.locationAssignments.length > 1).length,
    usersAlreadyMixedLocationAndCompany: affectedUsers.filter((user) => user.alreadyHasCompanyAssignment).length,
    companyOnlyAdminUsers,
    activeLocations,
    readyForExecution: catalogMatchesExpected,
  };
}
