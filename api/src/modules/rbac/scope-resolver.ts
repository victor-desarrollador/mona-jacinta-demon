import type { PrismaClient } from '../../generated/prisma/client.js';

export type ResolvedRoleScope = {
  roleId: string;
  roleCode: string;
  scopeKind: 'LOCATION' | 'COMPANY';
  locationId: string | null;
};

type ScopeResolverDatabase = Pick<PrismaClient, 'userRoleScope'>;

type RawRoleScopeRow = {
  roleId: string;
  scopeKind: 'LOCATION' | 'COMPANY';
  locationId: string | null;
  role: { code: string };
};

// Pure mapping from a raw UserRoleScope row (however it was loaded) to the
// resolver's public shape. Shared by resolveUserRoleScopes below and by
// callers that already loaded UserRoleScope rows themselves via a nested
// `select`/`include` on their own query (api/src/middleware/auth.ts,
// api/src/modules/auth/auth.service.ts) — so those callers don't need to
// issue a second query for data they already have in hand.
export function mapUserRoleScopeRows(rows: RawRoleScopeRow[]): ResolvedRoleScope[] {
  return rows.map((row) => ({
    roleId: row.roleId,
    roleCode: row.role.code,
    scopeKind: row.scopeKind,
    locationId: row.locationId,
  }));
}

// Phase 1C SWITCH step (docs/production-v1/08-implementation-roadmap.md
// Phase 1C: "SWITCH authorization reads/writes"; "Backend/domain: scoped
// authorization service"). This function IS that service: the single
// authoritative reader over UserRoleScope (backfilled and VERIFYed by
// scope-backfill.service.ts) that any caller should use to learn a user's
// roles/scopes going forward.
//
// Task 6 is this resolver's only Phase 1C caller: it feeds
// api/src/modules/auth/auth.service.ts's `branchIds` (LOCATION/COMPANY scope
// resolution) — nothing else. `roles` and `permissions` in that same file
// keep reading UserBranchRole + the 12 legacy lowercase-dot codes in
// api/src/shared/permissions.ts, completely unchanged; api/src/middleware/
// authorization.ts is not modified at all. This function stays a neutral,
// general-purpose reader (it does not special-case or reject COMPANY rows,
// even though Phase 1C's backfill never creates one) so Phase 1D's actual
// permission/scope guards ("NEW: permission/scope guards", "ALTERED: auth
// middleware") can build on it unchanged for COMPANY scope too; any
// fail-closed handling of an unexpected COMPANY row for the narrower
// branchIds use case lives in Task 6's caller, not here.
//
// This DB-querying form stays for callers with no other reason to load
// UserRoleScope themselves (the CLI backfill script, scope-resolver.test.ts).
// The two request-time callers above load UserRoleScope as part of their own
// `user.findUnique` select instead and call mapUserRoleScopeRows directly, to
// avoid a second round trip per request (see effective-branch-ids.ts).
export async function resolveUserRoleScopes(
  db: ScopeResolverDatabase,
  userId: string,
): Promise<ResolvedRoleScope[]> {
  const rows = await db.userRoleScope.findMany({
    where: { userId },
    include: { role: { select: { code: true } } },
  });
  return mapUserRoleScopeRows(rows);
}
