import type { ResolvedRoleScope } from './scope-resolver.js';

// Phase 1D.2: the narrowest explicit database interface this module needs —
// exactly the one Location.findMany call shape used below, not the full
// Location delegate (create/update/delete/etc.), not the whole PrismaClient,
// and not even PrismaClient['location']['findMany'] (whose generic,
// PrismaPromise-branded return type only matches other Prisma-derived types,
// not a plain test double). A real PrismaClient satisfies this narrower
// shape structurally, with no cast. Reused by authorization-context.ts as
// its own AuthorizationContextDatabase, since that module's only database
// need is this same lookup.
export type LocationLookupDatabase = {
  location: {
    findMany(args: { where: { isActive: true }; select: { id: true } }): Promise<Array<{ id: string }>>;
  };
};

// Phase 1D.2 (docs/superpowers/plans/2026-09-14-phase-1d-production-
// authorization.md Cross-cutting design §C): DISPLAY/FILTER CONVENIENCE
// ONLY. The return value feeds authorization-context.ts's
// effectiveLocationIds field, consumed only by direct list/room-join call
// sites (backoffice.service.ts's scopeBranches, socket.ts's room-join loop).
// authorization-policy.ts NEVER calls this function or reads its result —
// permission+location decisions go through hasPermissionAtLocation over
// assignments instead, never over this array. A COMPANY-kind row expands to
// every ACTIVE Location id (never a sentinel, never an inactive location),
// but that expansion happening here is explicitly NOT the same fact as
// "this row is a qualifying assignment for a given permission" — that fact
// lives only in the ProductionAssignment entry itself
// (authorization-context.ts).
export async function resolveEffectiveLocationIds(
  db: LocationLookupDatabase,
  roleScopes: ResolvedRoleScope[],
): Promise<string[]> {
  const hasCompanyScope = roleScopes.some((scope) => scope.scopeKind === 'COMPANY');
  if (!hasCompanyScope) {
    return [
      ...new Set(
        roleScopes.map((scope) => scope.locationId).filter((id): id is string => id !== null),
      ),
    ];
  }

  const locations = await db.location.findMany({ where: { isActive: true }, select: { id: true } });
  return locations.map((location) => location.id);
}
