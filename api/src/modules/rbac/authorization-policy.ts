import { ROLE_CODES } from './roles.js';
import { COMPANY_SCOPE_REQUIRED_FOR_ADMIN } from './permissions.js';

// Phase 1D.2 (docs/superpowers/plans/2026-09-14-phase-1d-production-
// authorization.md's Cross-cutting design §B) — this module is THE single
// centralized Production authorization policy layer. Every decision here is
// made exclusively from Express.AuthContext.assignments — never from
// ctx.roles (display-only union), ctx.legacyPermissions (compatibility
// window only), UserBranchRole, or a JWT claim. Permission and scope always
// come from the SAME ProductionAssignment entry; a permission granted by one
// assignment can never combine with a location granted by a different one.
//
// Contract (review correction, M1): this module is a PURE authority
// evaluator over `locationId` strings it is handed — it never consults
// `effectiveLocationIds` and never checks whether a `locationId` corresponds
// to a real, active Location row. For a COMPANY assignment,
// `hasPermissionAtLocation`/`hasBranchAccess` return `true` for literally any
// non-empty `locationId` string, including one that does not exist. This is
// intentional: the caller is responsible for supplying a `locationId` that
// already represents a persisted/validated location or a resource's own
// persisted location (e.g. a sale's `branchId`). Phase 1D.3's route
// integration is where existence/active validation of a user-supplied
// `locationId` must happen, before it ever reaches this module.
// `effectiveLocationIds` (authorization-context.ts) must never become a
// second authorization authority feeding these checks.
type Ctx = Pick<Express.AuthContext, 'assignments'>;

// Reuses the existing, already-approved frozen domain list unchanged — no
// new list, no new permission (rbac/permissions.ts's
// COMPANY_SCOPE_REQUIRED_FOR_ADMIN). Role-agnostic by construction: it is a
// property of the PERMISSION, not of which role currently holds it.
const COMPANY_REQUIRED_PERMISSIONS = new Set<string>(COMPANY_SCOPE_REQUIRED_FOR_ADMIN);

export function requiresCompanyScope(permission: string): boolean {
  return COMPANY_REQUIRED_PERMISSIONS.has(permission);
}

// An OWNER assignment is only ever valid COMPANY-scoped (AGENTS.md's Phase
// 1D target model; docs/working/production-v1-status-and-next-steps.md §6).
// A LOCATION-scoped OWNER row is malformed data — it must never happen if
// scope assignment is enforced correctly upstream — and this fails closed
// rather than silently granting (or denying only part of) OWNER's implicit
// authority. OWNER's implicit authority never depends on this assignment's
// `permissions` array being populated; RolePermission rows are irrelevant.
function isValidOwnerAssignment(assignment: Express.ProductionAssignment): boolean {
  return assignment.roleCode === ROLE_CODES.OWNER && assignment.scopeKind === 'COMPANY';
}

// Phase 1D.2: the ONLY place OWNER's implicit authority is recognized. No
// route, controller, service, or DTO outside this file and its direct
// callers may compare a role code string to 'OWNER' for an authorization
// decision.
export function isOwner(ctx: Ctx): boolean {
  return ctx.assignments.some(isValidOwnerAssignment);
}

// Single internal predicate every exported check delegates to — this is what
// makes the COMPANY-required rule impossible to apply inconsistently between
// a "global" (no location) check and a location-paired check. A
// COMPANY-required permission (PRICE_MANAGE/PRODUCT_MANAGE/
// PRODUCT_VARIANT_MANAGE today) can only ever be satisfied by a
// scopeKind:'COMPANY' assignment, regardless of whether a location argument
// is supplied and regardless of whether that assignment's own locationId
// would otherwise have matched — a LOCATION assignment can never qualify for
// one of these, even when its permissions array structurally contains the
// code (e.g. a not-yet-backfilled LOCATION-scoped ADMIN, whose RolePermission
// grant is unconditional).
function assignmentQualifies(
  assignment: Express.ProductionAssignment,
  permission: string,
  locationId?: string,
): boolean {
  if (!assignment.permissions.includes(permission)) return false;
  if (requiresCompanyScope(permission)) return assignment.scopeKind === 'COMPANY';
  if (locationId === undefined) return true;
  return assignment.scopeKind === 'COMPANY' || assignment.locationId === locationId;
}

// Global check, no location — correct for branchScope:'global' routes.
// "Global" never means "skip scope checks": for a COMPANY-required
// permission this still correctly demands a COMPANY assignment even though
// no specific location is in play, since assignmentQualifies enforces that
// regardless of whether locationId is supplied.
export function hasPermission(ctx: Ctx, permission: string): boolean {
  if (isOwner(ctx)) return true;
  return ctx.assignments.some((assignment) => assignmentQualifies(assignment, permission));
}

// THE cross-assignment composition guard: permission and location must be
// satisfied by the SAME assignment, never split into two independent checks
// (e.g. "does any assignment hold this permission" AND separately "does any
// assignment cover this location"). Pure authority check, not existence
// validation — see the module contract above: `locationId` must already be a
// validated/persisted value; this function never checks that against
// `effectiveLocationIds` or the database.
export function hasPermissionAtLocation(ctx: Ctx, permission: string, locationId: string): boolean {
  if (!locationId) return false;
  if (isOwner(ctx)) return true;
  return ctx.assignments.some((assignment) => assignmentQualifies(assignment, permission, locationId));
}

// Coarse membership only — "is this location within ANY assignment, in ANY
// capacity" — no permission attached, and therefore not subject to the
// COMPANY-required rule at all (there is no permission to check it
// against). Not a Production permission decision; legitimate only for the
// small set of call sites with no specific permission behind them.
//
// Fix (review correction): if isOwner(ctx) is false, every remaining
// OWNER-coded assignment in this loop is, by definition, malformed (not
// COMPANY-scoped — see isValidOwnerAssignment). Such a row must contribute
// ZERO branch access, per assignment — it must never fall through to the
// generic scopeKind/locationId membership check below, which does not
// otherwise care which role holds the assignment. This is evaluated per
// assignment, not per user: an unrelated valid assignment on the same user
// (e.g. a real SELLER@B row) is unaffected and still grants B normally.
export function hasBranchAccess(ctx: Ctx, locationId: string): boolean {
  if (!locationId) return false;
  if (isOwner(ctx)) return true;
  return ctx.assignments.some((assignment) => {
    if (assignment.roleCode === ROLE_CODES.OWNER) return false;
    return assignment.scopeKind === 'COMPANY' || assignment.locationId === locationId;
  });
}
