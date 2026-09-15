import { AppError } from '../../shared/errors.js';
import type { ResolvedRoleScope } from './scope-resolver.js';

// Phase 1C SWITCH policy (docs/production-v1/08-implementation-roadmap.md
// Phase 1C: "SWITCH authorization reads/writes"). As of Phase 1D.1, this is
// called from exactly one place — api/src/modules/rbac/authorization-context.ts
// — which builds req.auth.effectiveLocationIds/socket.data.effectiveLocationIds
// on every authenticated request/connection; this is what
// api/src/middleware/authorization.ts's assertBranchAccess/requirePermission
// actually enforce against. Consolidating the three previously-duplicated
// call sites (middleware/auth.ts, modules/auth/auth.service.ts,
// realtime/socket.ts) into that one shared builder is Phase 1D.1's job.
//
// Pure: authorization-context.ts's caller already loads UserRoleScope as
// part of its own `user.findUnique` select (nested `roleScopes`, mapped via
// scope-resolver.ts's mapUserRoleScopeRows) rather than this function
// querying it itself — one fewer authorization DB round trip per request
// than the earlier version, which called resolveUserRoleScopes internally.
//
// UserRoleScope is authoritative post-SWITCH, full stop — including an empty
// result. There is no legacy-UserBranchRole fallback here: the Phase 1C
// backfill is all-or-nothing and verified globally *before* the SWITCH ships
// (verifyUserRoleScopeBackfill), so by the time this runtime code is live,
// every legacy assignment that should carry scope already has a UserRoleScope
// row. An earlier version of this function fell back to the legacy
// UserBranchRole-derived set whenever a given user had zero UserRoleScope
// rows — but "zero rows" is genuinely ambiguous per user (never migrated vs.
// intentionally revoked), and treating it as "never migrated" let an
// administrator's explicit revocation (delete every UserRoleScope row for a
// user) silently resurrect their old UserBranchRole-derived branches on the
// very next request. UserBranchRole physically stays in place through the
// compatibility window (Phase 1D still needs its legacy role/permission
// vocabulary), but it must never be read back as a branch-scope fallback.
// Environments that have genuinely never run the Phase 1A/1C backfill (a
// brand-new database, or a from-scratch test fixture) are expected to
// provision matching UserRoleScope rows for any user they create — see
// prisma/seed.ts's populate() and tests/helpers/factories.ts's
// createTestUser — not to rely on this function inferring that state from an
// empty per-user scope set.
//
// A COMPANY-scoped row is never produced by Phase 1C's backfill (it only
// ever writes LOCATION scope). Encountering one here would mean some other,
// not-yet-built path started writing COMPANY-scope rows before Phase 1D's
// real COMPANY/OWNER-aware scope enforcement exists to interpret them —
// this fails closed (500) rather than silently treating COMPANY as "all
// branches" or "no branches".
export function resolveEffectiveBranchIds(roleScopes: ResolvedRoleScope[]): string[] {
  const hasCompanyScope = roleScopes.some((scope) => scope.scopeKind === 'COMPANY');
  if (hasCompanyScope) {
    throw new AppError(
      500,
      'UNSUPPORTED_SCOPE',
      'La resolución de alcance COMPANY aún no está implementada.',
    );
  }

  return [
    ...new Set(
      roleScopes.map((scope) => scope.locationId).filter((id): id is string => id !== null),
    ),
  ];
}
