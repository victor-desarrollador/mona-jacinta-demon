// Mirrors the Prisma `ScopeKind` enum and the `UserRoleScope` CHECK
// constraint (docs/production-v1/05-architecture.md §5,
// 06-erd-data-model.md §5). This is a pure domain helper for validating a
// candidate scope shape before it reaches the database — it does not query
// or write `UserRoleScope`, and it is not authorization middleware (Phase 1D).
export const SCOPE_KINDS = {
  LOCATION: 'LOCATION',
  COMPANY: 'COMPANY',
} as const;

export type ScopeKind = (typeof SCOPE_KINDS)[keyof typeof SCOPE_KINDS];

export type ScopeCandidate = { scopeKind: ScopeKind; locationId: string | null };

// Same predicate as the `chk_user_role_scope_consistency` CHECK constraint:
// LOCATION requires a locationId, COMPANY forbids one.
export function isConsistentScope(candidate: ScopeCandidate): boolean {
  if (candidate.scopeKind === SCOPE_KINDS.LOCATION) return candidate.locationId !== null;
  return candidate.locationId === null;
}
