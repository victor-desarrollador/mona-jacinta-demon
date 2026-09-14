# Phase 1D — Production Authorization Switch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Revision note (this version):** rewritten after a security review of the first draft found a cross-assignment privilege-escalation risk in the original flattened `permissions[]`/`branchIds[]` context shape, plus a leak where a stale `UserBranchRole` row could grant a Production uppercase permission through a shared `Role` row. See "What changed" at the very end of this document for the itemized diff against the first draft. The overall `1D.1 → 1D.5` slicing is unchanged; only the internal design of the authorization context/policy, the scope-assignment service, and the `cash` GET decision changed.

**Goal:** Make `UserRoleScope` + the Production `RolePermission` catalog the sole runtime authority for role, permission, and scope (LOCATION + COMPANY) decisions — retiring `UserBranchRole` from every live authorization path (permission dimension; the location dimension was already retired in Phase 1C) — while keeping `UserBranchRole`, the legacy `MANAGER` role, and the 12 legacy lowercase permission codes physically present (DEPRECATE, not REMOVE), and adding the minimal OWNER/ADMIN-only endpoint needed to assign, reassign, and revoke individual `UserRoleScope` assignments, **without** ever allowing a permission granted by one assignment to combine with a location granted by a different assignment.

**Architecture:** One new shared module, `api/src/modules/rbac/authorization-context.ts`, replaces the three duplicated inline blocks in `middleware/auth.ts`, `modules/auth/auth.service.ts`, and `realtime/socket.ts` that each independently compute an authorization shape from the database. Its output is **assignment-shaped**, not flattened: `Express.AuthContext.assignments` is an array of `{ roleId, roleCode, scopeKind, locationId, permissions }`, one entry per `UserRoleScope` row, each carrying only the Production `RolePermission` grants that row's own `Role` carries — never merged across assignments, never merged with the legacy vocabulary. A separate `legacyPermissions: string[]` field, filtered to contain only codes from the legacy lowercase catalog, is the sole contribution `UserBranchRole` makes during the compatibility window (removed entirely once Phase 1D.3 finishes). A second new module, `api/src/modules/rbac/authorization-policy.ts`, is the single place OWNER's implicit authority is recognized and the single place a permission+location pair is evaluated together against the *same* qualifying assignment (`hasPermissionAtLocation`) — `middleware/authorization.ts` and every manual service-level branch recheck that is actually standing in for a permission decision call into it, never inlining their own check. `effectiveLocationIds` exists only as a derived, non-authoritative convenience field for direct list/room-join consumers (`backoffice.service.ts`, `socket.ts`) — it is never read by the policy module.

**Tech Stack:** TypeScript, Express, Prisma 7 (`@prisma/adapter-pg`), Vitest + Supertest, `jose` (JWT), Socket.IO, `zod`.

**Spec:** `docs/production-v1/08-implementation-roadmap.md` Phase 1D (1D–1E); `docs/production-v1/03-role-permission-matrix.md`; `docs/production-v1/00-master-index.md`; `.claude/claude-security-guidance.md`; `AGENTS.md`'s Checkpoint section; the Phase 1D read-only audit completed earlier in this conversation; the security-correction review that produced this revision (not a separate file — its 8 numbered corrections are addressed by file:line/task throughout, and summarized in "What changed" at the end).

## Business-model correction carried into this plan

`docs/production-v1/03-role-permission-matrix.md:44,49` (frozen, not edited) describes ADMIN as permission-**and**-scope-based with no fixed scope kind. **This plan supersedes that specific detail** per the explicit business decision: **ADMIN's canonical Production assignment is COMPANY-scoped**, operating every retail branch plus the central warehouse, and is never assigned a LOCATION-only scope going forward. This is represented as a single qualifying assignment — `{ roleCode: 'ADMIN', scopeKind: 'COMPANY', permissions: [...] }` — never as an expanded list of individual location ids standing in for "company-wide" (see Cross-cutting design §C). OWNER remains COMPANY-scoped with unrestricted implicit authority, recognized only in `authorization-policy.ts`.

## Global Constraints

- TDD for every behavioral slice: write the failing test before the implementation in every task below. Phase 1E (described, not implemented) is the comprehensive RBAC/security hardening gate — it does not replace per-slice TDD here.
- **No cross-assignment privilege composition, ever.** A permission and a location authorize an action only when the **same** `UserRoleScope`-derived assignment grants both. The frozen ERD permits multiple `UserRoleScope` rows per user and does not enforce one role per user — this plan does not invent that invariant, and does not solve the composition problem by pretending it doesn't exist.
- **`UserBranchRole` may only ever contribute legacy lowercase permission codes**, filtered explicitly against the legacy catalog (`shared/permissions.ts`'s `permissionValues`) — never a Production uppercase code, even though the same underlying `Role` row may carry both vocabularies via `RolePermission`.
- OWNER's implicit authority is recognized in exactly one place: `api/src/modules/rbac/authorization-policy.ts`'s `isOwner()`. No route, controller, service, or DTO outside that file and its direct callers may compare a role code string to `'OWNER'`.
- Do not invent a `CASH_VIEW` (or any other) permission not in the approved 33-permission Production catalog. `cash` `GET /register`/`GET /current` keep their current behavior — authenticated + authorized-location-scoped reads, no permission gate — as an explicit, documented Phase 1D decision (Task 1D.5.3), not an open question.
- ADMIN is COMPANY-scoped per the business-model correction above. ADMIN can never manage an OWNER's scope in any way (assign, reassign, or revoke) and can never grant/create OWNER authority for anyone, including itself. Self-modification of `UserRoleScope` is denied for **every** actor, including OWNER — OWNER's own assignment is provisioned only through seed/bootstrap tooling, never through the self-service assignment endpoint.
- Scope reassignment operates on one `(user, roleCode)` assignment at a time and never disturbs the user's other, independent assignments (e.g. reassigning a user's `WAREHOUSE @ Location B` locations must not touch their separate `SELLER @ Location A` assignment). This plan does not impose "one role per user."
- Never physically remove `UserBranchRole`, the legacy `MANAGER` `Role` row, or the 12 legacy lowercase `Permission` rows/`shared/permissions.ts` constants. Every task below is SWITCH or DEPRECATE, never REMOVE.
- No Prisma migration in this plan — every schema object this plan needs (`UserRoleScope`, `ScopeKind.COMPANY`, `Role`/`Permission`/`RolePermission`) already exists.
- The ADMIN → COMPANY data-correction tool (Task 1D.4.1) is built and tested in TEST only; it is never automatically executed against DEV — any DEV run is a separate, explicit, human-approved action outside this document.
- Never touch TEST or DEV outside the normal `NODE_ENV=test` Vitest run of each task's own focused tests. No full-suite run until every phase 1D.1–1D.5 task is green.
- Do not commit or push at any point in this plan.

---

## Cross-cutting design (read before Phase 1D.1)

### A. `AuthorizationContext` shape — assignments, not flattened sets

```ts
// api/src/types/express.d.ts (target shape; Task 1D.1.2 introduces most of it,
// Task 1D.2.2 adds effectiveLocationIds)
interface ProductionAssignment {
  roleId: string;
  roleCode: 'OWNER' | 'ADMIN' | 'CASHIER' | 'SELLER' | 'WAREHOUSE';
  scopeKind: 'LOCATION' | 'COMPANY';
  locationId: string | null;       // set for LOCATION, always null for COMPANY
  permissions: string[];            // Production uppercase only, THIS assignment's own Role.permissions
}

interface AuthContext {
  userId: string;
  roles: string[];                  // display-only union (legacy UserBranchRole codes ∪ assignment role codes) — NEVER read by authorization-policy.ts
  legacyPermissions: string[];      // legacy lowercase only, compatibility window (removed entirely at Task 1D.3.6)
  assignments: ProductionAssignment[]; // AUTHORITATIVE — one entry per UserRoleScope row
  effectiveLocationIds: string[];   // derived convenience only — NEVER read by authorization-policy.ts, see §C
}
```

Each `UserRoleScope` row becomes exactly one `ProductionAssignment`, carrying only that row's own `role.permissions` (already filtered to Production uppercase codes — §D below). A user with `SELLER @ Location A` and `WAREHOUSE @ Location B` has **two** entries in `assignments`, never one merged entry — this is what makes the example in Cross-cutting design §B provably correct rather than accidentally correct.

### B. `authorization-policy.ts` — how cross-composition AND COMPANY-required permissions are enforced

**Explicit semantics (this is the exact, final rule — supersedes any looser description elsewhere in this document):** a `ProductionAssignment` qualifies for a `(permission, locationId)` check if and only if:
1. that assignment's own `permissions` array includes the requested permission; **AND**
2. that assignment covers the requested location, through either:
   - `scopeKind === 'COMPANY'`; or
   - `scopeKind === 'LOCATION'` with `assignment.locationId === locationId`.

Permission and scope always come from the **same** assignment — never two different assignments each satisfying one half. **In addition**, a fixed set of permissions (currently `PRICE_MANAGE`, `PRODUCT_MANAGE`, `PRODUCT_VARIANT_MANAGE` — reused unchanged from the existing, already-approved `COMPANY_SCOPE_REQUIRED_FOR_ADMIN` domain constant in `rbac/permissions.ts`, not a new invented list) can **only** be satisfied by a `scopeKind === 'COMPANY'` assignment — a `LOCATION` assignment can never qualify for one of these, regardless of whether its `locationId` matches, and regardless of whether its `permissions` array happens to include the code (which it structurally does for every ADMIN assignment today, since ADMIN's `RolePermission` grant is unconditional — this is exactly the gap that would otherwise let a not-yet-backfilled, LOCATION-scoped ADMIN exercise COMPANY-only authority). OWNER remains a single centralized special case, layered on top of both rules, recognized only by `isOwner`.

```ts
// api/src/modules/rbac/authorization-policy.ts (target shape; built in Phase 1D.2)
import { ROLE_CODES } from './roles.js';
import { COMPANY_SCOPE_REQUIRED_FOR_ADMIN } from './permissions.js';

// The one centralized scope-requirement lookup this plan's correction calls
// for ("Design one centralized mechanism... Do not scatter permission-
// specific role/scope checks in routes"). Reuses the frozen domain list
// already defined in rbac/permissions.ts — no new list, no new permission.
// Role-agnostic by construction: it is a property of the PERMISSION, not of
// which role currently holds it (ADMIN is the only role the default grants
// give it to today, but the rule itself does not special-case ADMIN).
const COMPANY_REQUIRED_PERMISSIONS = new Set<string>(COMPANY_SCOPE_REQUIRED_FOR_ADMIN);

export function requiresCompanyScope(permission: string): boolean {
  return COMPANY_REQUIRED_PERMISSIONS.has(permission);
}

// The ONLY place OWNER's implicit authority is recognized.
export function isOwner(ctx: Pick<Express.AuthContext, 'assignments'>): boolean {
  return ctx.assignments.some((a) => a.roleCode === ROLE_CODES.OWNER);
}

// Single internal predicate both exported functions delegate to — this is
// what makes the COMPANY-required rule impossible to apply inconsistently
// between a "global" check and a location-paired check.
function assignmentQualifies(
  assignment: Express.ProductionAssignment,
  permission: string,
  locationId?: string,
): boolean {
  if (!assignment.permissions.includes(permission)) return false;
  if (requiresCompanyScope(permission)) {
    // A LOCATION assignment can never satisfy a COMPANY-required permission
    // — not even one whose locationId happens to match the request. The
    // location argument is irrelevant here: the permission is inherently
    // company-wide, never tied to one resource's location. This is what
    // keeps "a LOCATION-scoped ADMIN must not gain COMPANY/global authority
    // merely because the ADMIN Role has that RolePermission grant" true
    // unconditionally, including during the compatibility window before
    // Task 1D.4.1's ADMIN->COMPANY backfill has run for a given user.
    return assignment.scopeKind === 'COMPANY';
  }
  if (locationId === undefined) return true; // "global" check: ANY qualifying assignment, no location requirement
  return assignment.scopeKind === 'COMPANY' || assignment.locationId === locationId;
}

// No location involved — "does ANY assignment grant this permission at
// all," respecting the COMPANY-required rule above. Correct for
// branchScope:'global' routes whose permission is NOT company-required
// (catalog reads, audit, reports, user management) — for a company-required
// permission, this still correctly demands a COMPANY assignment even though
// no specific location is in play, since assignmentQualifies enforces that
// regardless of whether locationId is supplied.
export function hasPermission(ctx: Pick<Express.AuthContext, 'assignments'>, permission: string): boolean {
  if (isOwner(ctx)) return true;
  return ctx.assignments.some((a) => assignmentQualifies(a, permission));
}

// THE fix for cross-assignment composition: permission and location must be
// satisfied by the SAME assignment, AND (via assignmentQualifies) a
// COMPANY-required permission still only qualifies through a COMPANY
// assignment even when a location argument is supplied.
export function hasPermissionAtLocation(
  ctx: Pick<Express.AuthContext, 'assignments'>,
  permission: string,
  locationId: string,
): boolean {
  if (!locationId) return false;
  if (isOwner(ctx)) return true;
  return ctx.assignments.some((a) => assignmentQualifies(a, permission, locationId));
}

// Coarse membership only — "is this location within ANY assignment, in ANY
// capacity" — no permission attached, and therefore not subject to the
// COMPANY-required rule at all (there is no permission to check it
// against). Legitimate only for the small set of call sites with no
// specific permission behind them (Task 1D.5.3's cash GET routes are the
// only ones this plan keeps in that category).
export function hasBranchAccess(ctx: Pick<Express.AuthContext, 'assignments'>, locationId: string): boolean {
  if (!locationId) return false;
  if (isOwner(ctx)) return true;
  return ctx.assignments.some((a) => a.scopeKind === 'COMPANY' || a.locationId === locationId);
}
```

`middleware/authorization.ts`'s `requirePermission` (Phase 1D.2) calls `hasPermission` for `branchScope: 'global'` and `hasPermissionAtLocation` for `branchScope: 'own'`/`'any'` — never `hasPermission` followed by a separate `assertBranchAccess`. Both exported functions delegate to the single `assignmentQualifies` predicate, so the COMPANY-required rule is applied identically regardless of which one a caller uses — there is exactly one place this logic can drift, and it is inside this file, never a route.

**Worked example 1 — cross-assignment composition (unchanged from the prior revision, still holds under the corrected implementation):**
- `SELLER @ A` → `{ roleCode: 'SELLER', scopeKind: 'LOCATION', locationId: 'A', permissions: ['SALE_CREATE', ...] }`
- `WAREHOUSE @ B` → `{ roleCode: 'WAREHOUSE', scopeKind: 'LOCATION', locationId: 'B', permissions: ['INVENTORY_MANAGE', ...] }`
- `hasPermissionAtLocation(ctx, 'SALE_CREATE', 'A')` → `true`. `hasPermissionAtLocation(ctx, 'SALE_CREATE', 'B')` → `false`. `hasPermissionAtLocation(ctx, 'INVENTORY_MANAGE', 'B')` → `true`. `hasPermissionAtLocation(ctx, 'INVENTORY_MANAGE', 'A')` → `false`. (Neither permission is company-required, so `assignmentQualifies` falls through to plain location matching, identical to the prior revision.)

**Worked example 2 — COMPANY-required permission, the exact scenario this correction targets:**
- `ADMIN @ LOCATION 'X'` → `{ roleCode: 'ADMIN', scopeKind: 'LOCATION', locationId: 'X', permissions: [...all 33 codes, including 'PRICE_MANAGE'...] }` — this is exactly what an ADMIN's Phase-1C-backfilled assignment looks like **before** Task 1D.4.1's correction has run for that user.
- `hasPermission(ctx, 'PRICE_MANAGE')` → `assignmentQualifies` sees `PRICE_MANAGE` is in `assignment.permissions` (true) but `requiresCompanyScope('PRICE_MANAGE')` is true and `assignment.scopeKind !== 'COMPANY'` → **`false`**, correctly denied, even though the permission string is literally present in that assignment's grant list.
- `hasPermissionAtLocation(ctx, 'PRICE_MANAGE', 'X')` → same reasoning, still **`false`** — matching `locationId` does not help, because `requiresCompanyScope` bypasses the location-matching branch entirely for this permission.
- Now `ADMIN @ COMPANY` (post-backfill) → `{ roleCode: 'ADMIN', scopeKind: 'COMPANY', locationId: null, permissions: [...same 33 codes...] }` — `hasPermission(ctx, 'PRICE_MANAGE')` → `true`. `hasPermissionAtLocation(ctx, 'PRICE_MANAGE', 'anything')` → `true` (the `scopeKind === 'COMPANY'` clause qualifies for any location, since this is the ADMIN's own qualifying assignment granting `PRICE_MANAGE`).

### C. COMPANY semantics — a qualifying assignment, never a sentinel, never collapsed into LOCATION

A COMPANY-kind `UserRoleScope` row becomes a `ProductionAssignment` with `scopeKind: 'COMPANY'` and `locationId: null` — this fact is preserved exactly as-is in `assignments`; it is never rewritten into a `LOCATION` entry and never given a fabricated location id. `hasPermissionAtLocation`'s `a.scopeKind === 'COMPANY'` clause is what makes `ADMIN + COMPANY + PRICE_MANAGE` a qualifying assignment for *any* location — the authorization decision is always traceable to that one specific assignment, auditable as "this ADMIN's COMPANY assignment granted this," not "some branch id happened to be in a list."

`effectiveLocationIds` (Task 1D.2.1) is a **separate, clearly-named, non-authoritative** field, computed once per request for the handful of direct consumers that need a real, literal location-id list for query filtering or room-joining (`backoffice.service.ts`'s `scopeBranches`, `socket.ts`'s room-join loop) — for a user holding a COMPANY assignment, it is populated with every active `Location.id` (still no sentinel: real ids, not a magic value), but `authorization-policy.ts` never reads this field. Renamed from the first draft's `branchIds` specifically so a reader can never mistake "the list a display/filter query uses" for "the source of an authorization decision."

### C.1. Global route classification — every `branchScope:'global'`/no-location permission check in this plan's route set, audited

The correction requires that "global" never silently mean "skip scope checks," and that the policy — not the route — be the source of these semantics. Every route below is gated by a plain `requirePermission(CODE)` (global) or `requirePermission(CODE, { branchScope: 'own', resolveResourceBranch })` call; the "Real decision" column names whichever of `hasPermission`/`hasPermissionAtLocation`/`hasBranchAccess` actually determines the outcome, including where a route-level global gate is a coarse pre-check and a service-level `assertPermissionAtLocation`/bulk filter is the operative one.

| Route | Permission | Classification | Real decision |
|---|---|---|---|
| `GET /sales`, `GET /sales/pending` | `SALE_VIEW`, `SALE_QUEUE_VIEW` | **ANY** authorized assignment | route gate (`hasPermission`) + bulk-filtered to caller's own `effectiveLocationIds` (`listDrafts`/`listPendingSales`) — never company-wide unless a COMPANY assignment is held |
| `GET /sales/:saleId`, item mutation routes (`POST/PATCH/DELETE /sales/:saleId/items...`) | `SALE_VIEW`/`SALE_CREATE` | **LOCATION** assignment for the concrete sale's branch (or COMPANY) | route gate is coarse (global); `ensureSaleAccess`'s `assertPermissionAtLocation` is the real decision |
| `POST /sales` | `SALE_CREATE` | **LOCATION** assignment for the concrete requested branch (or COMPANY) | route gate is coarse (global); `createDraftSale`'s `assertPermissionAtLocation` is the real decision (identified by this audit — see Task 1D.3.1's expanded conversion list) |
| `POST /sales/:saleId/send-to-cashier` | `SALE_CREATE` | **LOCATION** assignment for the concrete sale's branch | route-level `requirePermission({branchScope:'own', resolveResourceBranch})` already IS the real decision — no service-level gap |
| `POST /sales/:saleId/complete` | `SALE_COMPLETE` | **LOCATION** assignment for the concrete sale's branch | route gate coarse; `completeSaleInTransaction`'s inline `hasPermissionAtLocation` check is the real decision |
| `POST /sales/:saleId/cancel` | `SALE_CREATE` | **LOCATION** assignment for the concrete sale's branch | route gate coarse; `cancelSale`'s `assertPermissionAtLocation` (converted from `branchAssignment`) is the real decision |
| `POST /admin/reservations/release-expired` | `INVENTORY_MANAGE` | **ANY** authorized assignment | route gate + bulk-filtered to caller's own `effectiveLocationIds` (`releaseExpiredReservations`) — a WAREHOUSE-held location-only assignment only releases holds at that location, never company-wide unless COMPANY |
| `POST /sales/:saleId/payments` | `SALE_CHARGE` | **LOCATION** assignment for the concrete sale's branch | route gate coarse; `registerPayment`'s `assertCurrentBranch` (converted to `assertPermissionAtLocation`) is the real decision |
| `GET /sales/:saleId/payments` | `SALE_VIEW` | **LOCATION** assignment for the concrete sale's branch | route gate coarse; `listPayments`'s `assertPermissionAtLocation` is the real decision |
| `POST /cash/sessions/open`, `POST /cash/sessions/:id/close` | `CASH_SESSION_OPEN`/`CLOSE` | **LOCATION** assignment for the register's/session's branch | route gate coarse; `openSession`/`closeSession`'s `assertPermissionAtLocation` is the real decision (controller must pass the full `req`/`req.auth`, not a bare array — see Task 1D.3.3's expanded conversion) |
| `GET /cash/register`, `GET /cash/current` | *(none — firm decision, Task 1D.5.3)* | coarse membership only, no permission dimension | `hasBranchAccess` only |
| `GET /inventory`, `GET /inventory/availability` | `INVENTORY_VIEW` | **LOCATION** assignment for the queried branch (or COMPANY) | route-level `requirePermission({branchScope:'own', resolveResourceBranch})` already IS the real decision |
| `GET /products`, `GET /products/:id`, `GET /variants`, `GET /variants/:id` | `INVENTORY_VIEW` | **ANY** authorized assignment (the catalog itself is a global entity, not owned by a location) | route gate (`hasPermission`, `branchScope:'global'`) — genuinely global, correct as designed; nested inventory figures separately bulk-filtered to `effectiveLocationIds` |
| `GET /variants?branchId=...` (optional filter) | `INVENTORY_VIEW` | **LOCATION** assignment for the specific requested branch, layered on top of the global catalog gate above | `listVariants`'s `assertPermissionAtLocation` (converted from `assertBranchAccess`) |
| `GET /backoffice/dashboard`, `/sales`, `/inventory`, `/branches` | `REPORT_VIEW` | **ANY** authorized assignment | route gate + bulk-filtered to caller's own `effectiveLocationIds` (`scopeBranches`) |
| `GET /backoffice/sales/:id` | `REPORT_VIEW` | **LOCATION** assignment for the concrete sale's branch (or COMPANY) | route gate coarse; `getSale`'s `assertPermissionAtLocation` (converted from `assertBranchAccess`) is the real decision |
| `GET /backoffice/users` | `USER_MANAGE` | **ANY** authorized assignment | route gate + bulk-filtered (shows users whose assignments overlap the caller's `effectiveLocationIds`, or who hold a COMPANY assignment) |
| `POST /backoffice/users/:userId/scope`, `DELETE .../scope/:roleCode` | `USER_MANAGE` | **ANY** authorized assignment — **⚠ identified, not decided, see below** | route gate; `scope-assignment.service.ts`'s own escalation guards (self-modification, ADMIN-cannot-manage-OWNER) are a *separate* set of checks layered on top, not a location pairing at all — this action has no location dimension by nature (it targets a user, not a branch-owned resource) |
| `GET /audit` | `AUDIT_VIEW` | **ANY** authorized assignment, genuinely and deliberately unfiltered (every `AUDIT_VIEW` holder sees every log company-wide, by the existing, unchanged design) | route gate only, no location dimension by design |
| `PRICE_MANAGE`, `PRODUCT_MANAGE`, `PRODUCT_VARIANT_MANAGE` | *(no route exists yet in this plan's 9 files)* | **COMPANY** assignment required, always | mechanism built now (`requiresCompanyScope`); first real route is Phase 2's catalog-mutation work, out of this plan's scope |
| Every route above, regardless of row | — | **OWNER** implicit authority | layered on top of every classification above via `isOwner`'s short-circuit inside `hasPermission`/`hasPermissionAtLocation`/`hasBranchAccess` — never a separate route-level case |

**⚠ Identified but not decided — `USER_MANAGE` and the scope-assignment endpoint:** `USER_MANAGE` is **not** in `COMPANY_SCOPE_REQUIRED_FOR_ADMIN` today (only `PRICE_MANAGE`/`PRODUCT_MANAGE`/`PRODUCT_VARIANT_MANAGE` are, per the frozen matrix doc). Under the "ANY authorized assignment" classification above, this means a LOCATION-scoped ADMIN — i.e., an ADMIN whose Task 1D.4.1 backfill has **not yet run** — can reach `POST/DELETE /backoffice/users/:userId/scope` today, since their assignment's `permissions` array includes `USER_MANAGE` regardless of `scopeKind`. Whether user/scope management should be added to the COMPANY-required set (given it is arguably as inherently company-wide an action as pricing/catalog management) is a genuine open question this audit surfaces but does not resolve — per the Global Constraints, this plan does not invent a new COMPANY requirement not stated in the frozen doc. Flagged in Deliverable F for an explicit decision.

### D. Legacy/Production permission-vocabulary isolation

Because `catalog.service.ts` additively attaches Production uppercase `RolePermission` rows onto the **same, reused** `Role` row that already carries a legacy role's lowercase grants (`ADMIN`/`CASHIER`/`SELLER`), reading "all of `role.permissions`" through **either** join table would leak the other vocabulary. `authorization-context.ts` therefore filters both sides explicitly against their own canonical code list:

```ts
import { permissionValues } from '../../shared/permissions.js';       // legacy lowercase catalog
import { productionPermissionValues } from './permissions.js';         // Production uppercase catalog

const legacySet = new Set(permissionValues);
const productionSet = new Set(productionPermissionValues);

// UserBranchRole -> Role -> RolePermission -> Permission.code, filtered to
// ONLY legacy lowercase codes — even if the same Role also carries
// Production uppercase RolePermission rows.
const legacyPermissions = [...new Set(
  user.branchRoles.flatMap((row) => row.role.permissions.map((p) => p.permission.code)),
)].filter((code) => legacySet.has(code));

// UserRoleScope -> Role -> RolePermission -> Permission.code, per assignment,
// filtered to ONLY Production uppercase codes.
const assignments = user.roleScopes.map((scope) => ({
  roleId: scope.roleId,
  roleCode: scope.role.code,
  scopeKind: scope.scopeKind,
  locationId: scope.locationId,
  permissions: scope.role.permissions
    .map((p) => p.permission.code)
    .filter((code) => productionSet.has(code)),
}));
```

This is what makes "stale `UserBranchRole` cannot grant an uppercase Production permission" provably true rather than incidentally true: even a `Role` row whose `RolePermission` set contains both `sale.view` and `SALE_VIEW` can only ever contribute `sale.view` through the `UserBranchRole` path and only ever contribute `SALE_VIEW` through a `UserRoleScope` row that actually exists for that user — the two paths are filtered independently, at the source, not merged and then hoped to stay separate.

### E. Legacy → Production permission mapping

All 12 legacy lowercase codes (`api/src/shared/permissions.ts`) map 1:1 to an identically-scoped Production uppercase code (`api/src/modules/rbac/permissions.ts`):

| Legacy (`shared/permissions.ts`) | Production (`rbac/permissions.ts`) |
|---|---|
| `sale.create` | `SALE_CREATE` |
| `sale.charge` | `SALE_CHARGE` |
| `sale.complete` | `SALE_COMPLETE` |
| `sale.view` | `SALE_VIEW` |
| `sale.queue.view` | `SALE_QUEUE_VIEW` |
| `inventory.view` | `INVENTORY_VIEW` |
| `inventory.manage` | `INVENTORY_MANAGE` |
| `cash.session.open` | `CASH_SESSION_OPEN` |
| `cash.session.close` | `CASH_SESSION_CLOSE` |
| `user.manage` | `USER_MANAGE` |
| `report.view` | `REPORT_VIEW` |
| `audit.view` | `AUDIT_VIEW` |

### F. UserBranchRole uses expected to remain after Phase 1D

After 1D.5: `rbac/scope-backfill.service.ts`, `rbac/legacy-role-map.ts` (category E, migration/backfill only, unchanged); test factories (category F, `tests/helpers/factories.ts`'s `createTestUser` continues creating both rows); `authorization-context.ts`'s `roles` display union and its `legacyPermissions` field (both explicitly filtered per §D, both removed entirely — `legacyPermissions` field and its computation deleted outright — at Task 1D.3.6, since every route has switched by then); the physical `UserBranchRole`/`Role`(`MANAGER`)/legacy `Permission` rows themselves (DEPRECATE only). Zero runtime reads of `UserBranchRole` contribute to a Production-uppercase-permission decision at any point in this plan, by construction (§D), not merely by the end state.

---

## PHASE 1D.1 — Production Authorization Context

**Objective:** introduce the assignment-shaped context builder, additively (existing legacy-vocabulary routes are unaffected — `legacyPermissions` is exactly the old flattened legacy permission set, filtered; `assignments` is new and unused by any route yet), and delete the three duplicated inline implementations.

**Invariants preserved:** empty `UserRoleScope` still yields `assignments: []` (fail-closed, unchanged); a `COMPANY`-kind row still throws `500 UNSUPPORTED_SCOPE` at context-build time (unchanged — Phase 1D.2 is the only phase that changes this); JWT still carries only `sub`; every currently-passing test keeps passing unmodified; **a stale `UserBranchRole` row can never populate `assignments[].permissions` with a Production uppercase code**, proven by a dedicated test in this phase, before any consumer exists to exploit it.

**Exact files expected to change:**
- Create: `api/src/modules/rbac/authorization-context.ts`
- Create: `api/tests/rbac/authorization-context.test.ts`
- Modify: `api/src/types/express.d.ts`
- Modify: `api/src/middleware/auth.ts`
- Modify: `api/src/modules/auth/auth.service.ts`
- Modify: `api/src/realtime/socket.ts`
- Modify: `api/src/modules/rbac/index.ts`

**Dependencies:** none (first slice).

**Security checks:** the isolation test from Cross-cutting design §D (a `Role` with both vocabularies attached, reached only via `UserBranchRole`, must not surface the uppercase code anywhere in the context); a user with two independent `UserRoleScope` rows produces two independent `assignments` entries, never merged; the MANAGER→WAREHOUSE permission desync the earlier audit found resolves automatically, verified via `assignments`, not via a flattened array.

**Rollback/safety considerations:** every step ships behind existing tests; reverting this phase's four modified files restores the exact prior inline implementations, since nothing downstream depends on the new module's existence until 1D.2.

### Task 1D.1.1: `authorization-context.ts` — assignment-shaped builder (COMPANY still throws)

**Files:**
- Create: `api/src/modules/rbac/authorization-context.ts`
- Test: `api/tests/rbac/authorization-context.test.ts`

**Interfaces:**
- Produces: `ProductionAssignment`, `AuthorizationContextInput`, `AuthorizationContextDatabase`, `buildAuthorizationContext(db, user): Promise<Express.AuthContext>` — consumed by Tasks 1D.1.3–1D.1.5, extended by Phase 1D.2.

- [ ] **Step 1: Write the failing tests**

```ts
// api/tests/rbac/authorization-context.test.ts
import { describe, expect, it } from 'vitest';
import { buildAuthorizationContext } from '../../src/modules/rbac/authorization-context.js';

const noopDb = { location: { findMany: async () => [] } };

function userFixture(overrides: Partial<Parameters<typeof buildAuthorizationContext>[1]> = {}) {
  return {
    id: 'user-1',
    branchRoles: [
      { role: { code: 'CASHIER', permissions: [{ permission: { code: 'cash.session.open' } }] } },
    ],
    roleScopes: [
      {
        roleId: 'role-cashier',
        scopeKind: 'LOCATION' as const,
        locationId: 'loc-1',
        role: { code: 'CASHIER', permissions: [{ permission: { code: 'CASH_SESSION_OPEN' } }] },
      },
    ],
    ...overrides,
  };
}

describe('buildAuthorizationContext (Phase 1D.1)', () => {
  it('keeps legacyPermissions and assignments as separate vocabularies, never merged', async () => {
    const ctx = await buildAuthorizationContext(noopDb, userFixture());
    expect(ctx.legacyPermissions).toEqual(['cash.session.open']);
    expect(ctx.assignments).toEqual([
      { roleId: 'role-cashier', roleCode: 'CASHIER', scopeKind: 'LOCATION', locationId: 'loc-1', permissions: ['CASH_SESSION_OPEN'] },
    ]);
  });

  it('a Role carrying BOTH vocabularies reached only via UserBranchRole never leaks the uppercase code (Cross-cutting §D)', async () => {
    const ctx = await buildAuthorizationContext(
      noopDb,
      userFixture({
        branchRoles: [
          {
            role: {
              code: 'MIXED',
              permissions: [
                { permission: { code: 'sale.view' } },
                { permission: { code: 'SALE_VIEW' } }, // same Role row also carries the Production grant
              ],
            },
          },
        ],
        roleScopes: [], // no UserRoleScope row for this user at all — stale/never-migrated
      }),
    );
    expect(ctx.legacyPermissions).toEqual(['sale.view']);
    expect(ctx.assignments).toEqual([]);
    // The critical assertion: SALE_VIEW must not be reachable through any field.
    expect(JSON.stringify(ctx)).not.toContain('SALE_VIEW');
  });

  it('produces one independent assignment per UserRoleScope row — never merged (Cross-cutting §B)', async () => {
    const ctx = await buildAuthorizationContext(
      noopDb,
      userFixture({
        branchRoles: [],
        roleScopes: [
          {
            roleId: 'role-seller', scopeKind: 'LOCATION' as const, locationId: 'loc-a',
            role: { code: 'SELLER', permissions: [{ permission: { code: 'SALE_CREATE' } }] },
          },
          {
            roleId: 'role-warehouse', scopeKind: 'LOCATION' as const, locationId: 'loc-b',
            role: { code: 'WAREHOUSE', permissions: [{ permission: { code: 'INVENTORY_MANAGE' } }] },
          },
        ],
      }),
    );
    expect(ctx.assignments).toHaveLength(2);
    expect(ctx.assignments[0]).toMatchObject({ roleCode: 'SELLER', locationId: 'loc-a', permissions: ['SALE_CREATE'] });
    expect(ctx.assignments[1]).toMatchObject({ roleCode: 'WAREHOUSE', locationId: 'loc-b', permissions: ['INVENTORY_MANAGE'] });
  });

  it('is fail-closed for a user with zero UserRoleScope rows, even with a UserBranchRole row', async () => {
    const ctx = await buildAuthorizationContext(noopDb, userFixture({ roleScopes: [] }));
    expect(ctx.assignments).toEqual([]);
  });

  it('still throws on a COMPANY-kind UserRoleScope row (Phase 1D.2 implements this)', async () => {
    await expect(
      buildAuthorizationContext(
        noopDb,
        userFixture({
          roleScopes: [
            { roleId: 'role-admin', scopeKind: 'COMPANY' as const, locationId: null, role: { code: 'ADMIN', permissions: [] } },
          ],
        }),
      ),
    ).rejects.toThrow('UNSUPPORTED_SCOPE');
  });

  it('resolves a legacy MANAGER-backfilled user to WAREHOUSE Production permissions via its own assignment (closes the audit-found desync)', async () => {
    const ctx = await buildAuthorizationContext(
      noopDb,
      userFixture({
        branchRoles: [{ role: { code: 'MANAGER', permissions: [{ permission: { code: 'inventory.manage' } }] } }],
        roleScopes: [
          {
            roleId: 'role-warehouse', scopeKind: 'LOCATION' as const, locationId: 'loc-1',
            role: { code: 'WAREHOUSE', permissions: [{ permission: { code: 'INVENTORY_MANAGE' } }, { permission: { code: 'GOODS_RECEIPT_MANAGE' } }] },
          },
        ],
      }),
    );
    expect(ctx.assignments[0]!.permissions).toContain('GOODS_RECEIPT_MANAGE');
    expect(ctx.roles).toEqual(['MANAGER', 'WAREHOUSE']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && npx vitest run tests/rbac/authorization-context.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write the implementation**

```ts
// api/src/modules/rbac/authorization-context.ts
import type { PrismaClient } from '../../generated/prisma/client.js';
import { permissionValues } from '../../shared/permissions.js';
import { productionPermissionValues } from './permissions.js';
import { resolveEffectiveBranchIds } from './effective-branch-ids.js';
import { mapUserRoleScopeRows } from './scope-resolver.js';

const LEGACY_PERMISSION_CODES = new Set<string>(permissionValues);
const PRODUCTION_PERMISSION_CODES = new Set<string>(productionPermissionValues);

type PermissionRow = { permission: { code: string } };
type LegacyBranchRoleRow = { role: { code: string; permissions: PermissionRow[] } };
type ProductionRoleScopeRow = {
  roleId: string;
  scopeKind: 'LOCATION' | 'COMPANY';
  locationId: string | null;
  role: { code: string; permissions: PermissionRow[] };
};

export type AuthorizationContextInput = {
  id: string;
  branchRoles: LegacyBranchRoleRow[];
  roleScopes: ProductionRoleScopeRow[];
};

// Unused until Phase 1D.2's COMPANY expansion — accepted now so Tasks
// 1D.1.3-1D.1.5's three call sites need touching exactly once, not once per
// phase.
export type AuthorizationContextDatabase = Pick<PrismaClient, 'location'>;

// Phase 1D.1 (assignment-shaped, per the post-review architecture
// correction — see this plan's Cross-cutting design §A/§B/§D): single shared
// source for req.auth/socket.data. `legacyPermissions` and `assignments` are
// built from independently-filtered code sets (§D) so a Role row that
// carries BOTH the legacy lowercase and Production uppercase RolePermission
// grants for the same permission concept can never leak the wrong vocabulary
// through the wrong join table. `assignments` holds one entry per
// UserRoleScope row, untouched/unmerged, so a caller with multiple
// assignments (e.g. SELLER @ A + WAREHOUSE @ B) can never have a permission
// from one assignment combine with a location from another — see
// authorization-policy.ts's hasPermissionAtLocation (Phase 1D.2), the only
// function allowed to reason about permission+location together.
export async function buildAuthorizationContext(
  _db: AuthorizationContextDatabase,
  user: AuthorizationContextInput,
): Promise<Express.AuthContext> {
  const roles = [
    ...new Set([
      ...user.roleScopes.map((scope) => scope.role.code),
      ...user.branchRoles.map((row) => row.role.code),
    ]),
  ];

  const legacyPermissions = [
    ...new Set(
      user.branchRoles.flatMap((row) => row.role.permissions.map((p) => p.permission.code)),
    ),
  ].filter((code) => LEGACY_PERMISSION_CODES.has(code));

  // Still throws on COMPANY (Phase 1C behavior, unchanged) — Phase 1D.2
  // replaces this call with the COMPANY-aware resolver and builds the
  // COMPANY ProductionAssignment entry itself.
  resolveEffectiveBranchIds(mapUserRoleScopeRows(user.roleScopes));

  const assignments = user.roleScopes.map((scope) => ({
    roleId: scope.roleId,
    roleCode: scope.role.code as Express.AuthContext['assignments'][number]['roleCode'],
    scopeKind: scope.scopeKind,
    locationId: scope.locationId,
    permissions: scope.role.permissions
      .map((p) => p.permission.code)
      .filter((code) => PRODUCTION_PERMISSION_CODES.has(code)),
  }));

  return { userId: user.id, roles, legacyPermissions, assignments, effectiveLocationIds: [] };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && npx vitest run tests/rbac/authorization-context.test.ts --reporter=verbose`
Expected: all 6 PASS. (`npx tsc --noEmit` will not be clean until Task 1D.1.2 adds the type — run it after that task, not here.)

- [ ] **Step 5: Commit**

```bash
git add api/src/modules/rbac/authorization-context.ts api/tests/rbac/authorization-context.test.ts
git commit -m "feat(rbac): add assignment-shaped authorization context builder (Phase 1D.1)"
```

### Task 1D.1.2: extend `Express.AuthContext` with the assignment shape

**Files:**
- Modify: `api/src/types/express.d.ts`

- [ ] **Step 1: Edit the type**

```ts
// api/src/types/express.d.ts
export {};

declare global {
  namespace Express {
    interface ProductionAssignment {
      roleId: string;
      roleCode: 'OWNER' | 'ADMIN' | 'CASHIER' | 'SELLER' | 'WAREHOUSE';
      scopeKind: 'LOCATION' | 'COMPANY';
      locationId: string | null;
      permissions: string[];
    }

    interface AuthContext {
      userId: string;
      roles: string[];
      legacyPermissions: string[];
      assignments: ProductionAssignment[];
      effectiveLocationIds: string[];
    }

    interface Request {
      userId?: string;
      auth?: AuthContext;
    }
  }
}
```

- [ ] **Step 2: Run the type checker**

Run: `cd api && npx tsc --noEmit`
Expected: FAIL at this point — `auth.ts`/`auth.service.ts`/`socket.ts` still build the old shape inline (pre-Task-1D.1.3). Expected RED, turned GREEN by Tasks 1D.1.3–1D.1.5.

- [ ] **Step 3:** commit alongside Task 1D.1.3 (no independent meaning standalone).

### Task 1D.1.3: wire `middleware/auth.ts`

**Files:**
- Modify: `api/src/middleware/auth.ts`
- Test: extend `api/tests/rbac/authorization-context.test.ts`

- [ ] **Step 1: Write the failing regression test**

```ts
describe('middleware/auth.ts wiring (Phase 1D.1)', () => {
  it('sets req.auth.assignments from a Production-only grant with no legacy UserBranchRole row', async () => {
    const { createRequireAuth } = await import('../../src/middleware/auth.js');
    const { createTestPrismaClient, truncateAllTables } = await import('../helpers/test-db.js');
    const { createBranch, createTestUser, ensureTestLocation } = await import('../helpers/factories.js');
    const { bootstrapProductionRbacCatalog } = await import('../../src/modules/rbac/catalog.service.js');
    const { getAuthToken } = await import('../helpers/auth.js');
    const db = await createTestPrismaClient();
    await truncateAllTables(db);
    await bootstrapProductionRbacCatalog(db);
    const branch = await createBranch(db);
    await ensureTestLocation(db, branch.id);
    const cashierRole = await db.role.findUniqueOrThrow({ where: { code: 'CASHIER' } });
    const user = await db.user.create({ data: { name: 'no-legacy-user', email: 'no-legacy@test.local', passwordHash: 'x' } });
    await db.userRoleScope.create({
      data: { userId: user.id, roleId: cashierRole.id, scopeKind: 'LOCATION', locationId: branch.id },
    });
    const token = await getAuthToken({ id: user.id });
    const middleware = createRequireAuth(db);
    const req: any = { headers: { authorization: `Bearer ${token}` } };
    await new Promise<void>((resolve, reject) => middleware(req, {} as any, (err?: unknown) => (err ? reject(err) : resolve())));
    expect(req.auth.assignments).toEqual([
      { roleId: cashierRole.id, roleCode: 'CASHIER', scopeKind: 'LOCATION', locationId: branch.id, permissions: expect.arrayContaining(['CASH_SESSION_OPEN']) },
    ]);
    await db.$disconnect();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && npx vitest run tests/rbac/authorization-context.test.ts --reporter=verbose`
Expected: FAIL — `auth.ts` does not yet call `buildAuthorizationContext`.

- [ ] **Step 3: Rewrite `middleware/auth.ts`**

```ts
// api/src/middleware/auth.ts
import type { RequestHandler } from 'express';
import { jwtVerify } from 'jose';
import type { PrismaClient } from '../generated/prisma/client.js';
import { env } from '../config/env.js';
import { prisma as defaultPrisma } from '../config/prisma.js';
import { AppError } from '../shared/errors.js';
import { buildAuthorizationContext } from '../modules/rbac/authorization-context.js';

const key = new TextEncoder().encode(env.JWT_SECRET);

const userSelect = {
  id: true,
  isActive: true,
  branchRoles: {
    select: { role: { select: { code: true, permissions: { select: { permission: { select: { code: true } } } } } } },
  },
  roleScopes: {
    select: {
      roleId: true, scopeKind: true, locationId: true,
      role: { select: { code: true, permissions: { select: { permission: { select: { code: true } } } } } },
    },
  },
} as const;

export function createRequireAuth(database: PrismaClient = defaultPrisma): RequestHandler {
  return async (req, _res, next) => {
    const match = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization ?? '');
    if (!match?.[1]) {
      next(new AppError(401, 'UNAUTHORIZED', 'Se requiere un token de acceso válido.'));
      return;
    }
    try {
      const { payload } = await jwtVerify(match[1], key, {
        algorithms: ['HS256'], requiredClaims: ['sub', 'iat', 'exp'], maxTokenAge: 900,
      });
      if (typeof payload.sub !== 'string' || payload.sub.trim().length === 0) throw new Error('Missing token subject');

      const user = await database.user.findUnique({ where: { id: payload.sub }, select: userSelect });
      if (!user) throw new AppError(401, 'UNAUTHORIZED', 'El token no es válido.');
      if (!user.isActive) throw new AppError(403, 'INACTIVE_USER', 'El usuario está inactivo.');

      req.userId = user.id;
      req.auth = await buildAuthorizationContext(database, user);
      next();
    } catch (error) {
      if (error instanceof AppError) { next(error); return; }
      next(new AppError(401, 'UNAUTHORIZED', 'El token de acceso no es válido o expiró.'));
    }
  };
}

export const requireAuth = createRequireAuth();
```

- [ ] **Step 4: Run**

Run: `cd api && npx vitest run tests/rbac/authorization-context.test.ts tests/auth tests/sales tests/payments tests/cash tests/inventory tests/products tests/backoffice tests/audit --reporter=verbose`
Expected: all PASS — legacy-vocabulary routes are unaffected since `legacyPermissions` is exactly the old set, just relocated.

- [ ] **Step 5: Commit**

```bash
git add api/src/middleware/auth.ts api/src/types/express.d.ts api/tests/rbac/authorization-context.test.ts
git commit -m "feat(auth): wire middleware/auth.ts to the assignment-shaped authorization context (Phase 1D.1)"
```

### Task 1D.1.4: wire `modules/auth/auth.service.ts`

**Files:**
- Modify: `api/src/modules/auth/auth.service.ts`
- Test: extend `api/tests/auth/login-scope-switch.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('exposes assignments in the login response, never a flattened cross-assignment permission/branch pair', async () => {
  const response = await request(app).post('/api/v1/auth/login').send({ email: 'seller01@demo.local', password: 'demo123' });
  expect(response.status).toBe(200);
  expect(Array.isArray(response.body.user.assignments)).toBe(true);
  for (const assignment of response.body.user.assignments) {
    expect(assignment).toHaveProperty('roleCode');
    expect(assignment).toHaveProperty('scopeKind');
    expect(assignment).toHaveProperty('permissions');
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && npx vitest run tests/auth/login-scope-switch.test.ts --reporter=verbose`
Expected: FAIL.

- [ ] **Step 3: Rewrite `auth.service.ts`**

```ts
// api/src/modules/auth/auth.service.ts
import type { PrismaClient } from '../../generated/prisma/client.js';
import { AppError } from '../../shared/errors.js';
import { buildAuthorizationContext } from '../rbac/authorization-context.js';
import { verifyPassword } from './password.js';
import { signAccessToken } from './tokens.js';
import type { LoginInput } from './dto/login.dto.js';

type AuthDatabase = Pick<PrismaClient, 'user' | 'location'>;

const userSelect = {
  id: true, name: true, email: true, isActive: true, passwordHash: true,
  branchRoles: {
    select: { role: { select: { code: true, permissions: { select: { permission: { select: { code: true } } } } } } },
  },
  roleScopes: {
    select: {
      roleId: true, scopeKind: true, locationId: true,
      role: { select: { code: true, permissions: { select: { permission: { select: { code: true } } } } } },
    },
  },
} as const;

async function contextFromUser(database: AuthDatabase, user: { id: string; name: string; email: string } & Parameters<typeof buildAuthorizationContext>[1]) {
  const context = await buildAuthorizationContext(database, user);
  return { ...context, name: user.name, email: user.email };
}

export async function resolveUserContext(database: AuthDatabase, userId: string) {
  const user = await database.user.findUnique({ where: { id: userId }, select: userSelect });
  if (!user) throw new AppError(401, 'UNAUTHORIZED', 'El token no es válido.');
  if (!user.isActive) throw new AppError(403, 'INACTIVE_USER', 'El usuario está inactivo.');
  return contextFromUser(database, user);
}

export async function login(database: AuthDatabase, input: LoginInput) {
  const user = await database.user.findUnique({ where: { email: input.email }, select: userSelect });
  if (!user || !(await verifyPassword(input.password, user.passwordHash)))
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Las credenciales no son válidas.');
  if (!user.isActive) throw new AppError(403, 'INACTIVE_USER', 'El usuario está inactivo.');
  const context = await contextFromUser(database, user);
  return { accessToken: await signAccessToken(user.id), user: context };
}
```

- [ ] **Step 4: Run** — `cd api && npx vitest run tests/auth --reporter=verbose` — PASS.
- [ ] **Step 5: Commit**

```bash
git add api/src/modules/auth/auth.service.ts api/tests/auth/login-scope-switch.test.ts
git commit -m "feat(auth): wire auth.service.ts to the assignment-shaped authorization context (Phase 1D.1)"
```

### Task 1D.1.5: wire `realtime/socket.ts`

**Files:**
- Modify: `api/src/realtime/socket.ts`
- Test: extend `api/tests/realtime/socket.test.ts`

- [ ] **Step 1–2: failing test, same shape-assertion pattern as Task 1D.1.4, targeting `socket.data.assignments` instead of a response body** (mirror the existing `userWithBranches` fixture, extended with `roleScopes` carrying `role.permissions`).

- [ ] **Step 3: Rewrite `authenticateSocket`**

```ts
// api/src/realtime/socket.ts (authenticateSocket only)
import { buildAuthorizationContext } from '../modules/rbac/authorization-context.js';

const socketUserSelect = {
  id: true, isActive: true,
  branchRoles: {
    select: { role: { select: { code: true, permissions: { select: { permission: { select: { code: true } } } } } } },
  },
  roleScopes: {
    select: {
      roleId: true, scopeKind: true, locationId: true,
      role: { select: { code: true, permissions: { select: { permission: { select: { code: true } } } } } },
    },
  },
} as const;

async function authenticateSocket(socket: Socket, database: PrismaClient) {
  const token = tokenFromSocket(socket);
  if (!token) throw new Error('UNAUTHORIZED');
  const { payload } = await jwtVerify(token, new TextEncoder().encode(env.JWT_SECRET), {
    algorithms: ['HS256'], requiredClaims: ['sub', 'iat', 'exp'], maxTokenAge: 900,
  });
  if (typeof payload.sub !== 'string' || payload.sub.length === 0) throw new Error('UNAUTHORIZED');
  const user = await database.user.findUnique({ where: { id: payload.sub }, select: socketUserSelect });
  if (!user || !user.isActive) throw new Error('UNAUTHORIZED');
  const context = await buildAuthorizationContext(database, user);
  socket.data.userId = context.userId;
  socket.data.assignments = context.assignments;
  socket.data.effectiveLocationIds = context.effectiveLocationIds;
}
```

(`connection`/`branch:join` handlers keep working off `socket.data.effectiveLocationIds` — Task 1D.2.1 is what populates it correctly for a COMPANY-scoped connection; until then it is `[]` for anyone with a COMPANY assignment, same fail-closed posture as today.)

- [ ] **Step 4: Run** — `cd api && npx vitest run tests/realtime --reporter=verbose` — PASS.
- [ ] **Step 5: Commit**

```bash
git add api/src/realtime/socket.ts api/tests/realtime/socket.test.ts
git commit -m "feat(realtime): wire socket.ts to the assignment-shaped authorization context (Phase 1D.1)"
```

### Task 1D.1.6: rename every direct `req.auth.branchIds` consumer to `req.auth.effectiveLocationIds`

**Why this must happen inside Phase 1D.1, not later:** Task 1D.1.2 already removed `branchIds` from `Express.AuthContext` (replaced by `effectiveLocationIds`). Several controllers/services still read `req.auth.branchIds`/a `branchIds` field on a locally-constructed scope object directly, for **bulk list-filtering** (not a specific permission+location decision — those are separately handled by `hasPermissionAtLocation`/`assertPermissionAtLocation`, Phase 1D.2/1D.3). Left unrenamed, these fail `tsc --noEmit` immediately — Task 1D.1.7's gate below would not actually pass. This task is a pure, mechanical rename — no behavior change, no permission semantics involved (that's Phase 1D.2/1D.3's job).

**Scope is exhaustive, not limited to the list below:** Step 1's grep is the actual source of truth — rename every match it returns, including any not explicitly named here (e.g. `sales.service.ts`'s `completeSaleInTransaction` inline check, `payments.service.ts`'s `assertCurrentBranch`, `cash.service.ts`'s internal checks). The list below highlights the files with the most significant downstream implications for later tasks.

**Files (identified by `grep -rn "\.branchIds" src/modules`):**
- `api/src/modules/sales/sales.controller.ts` (`pending`, `list`, `sendToCashier` — pass the array into `listPendingSales`/`listDrafts`/`sendToCashier`)
- `api/src/modules/sales/sales.service.ts` (`createDraftSale`'s single-branch default inference only — its `assertBranchAccess` two lines later is a *separate*, permission-shaped conversion, handled in Task 1D.3.1, not here)
- `api/src/modules/sales/cancellation.controller.ts` (constructs `{ userId, branchIds }` for `cancelSale`/`releaseExpiredReservations` — rename the field; `cancelSale`'s internal use of it is a permission-shaped conversion for Task 1D.3.1, `releaseExpiredReservations`'s is a bulk filter, renamed here)
- `api/src/modules/payments/payments.service.ts` (`AuthScope` type's `branchIds` field — its *use* inside `assertCurrentBranch`/`listPayments` is a permission-shaped conversion for Task 1D.3.2; rename the field/type here so it compiles in the meantime)
- `api/src/modules/cash/cash.controller.ts` (4 call sites passing the array into `getRegister`/`getCurrentSession`/`openSession`/`closeSession` — Task 1D.3.3 changes these call sites to pass `req.auth` instead of a bare array; rename here only as an interim compile-fix if Task 1D.3.3 is not done in the same pass)
- `api/src/modules/products/products.controller.ts`, `api/src/modules/products/products.service.ts` (`listVariants`'s no-filter default — its `if (branchId) assertBranchAccess(...)` case is Task 1D.3.4's conversion)
- `api/src/modules/backoffice/backoffice.service.ts` (`scopeBranches`'s no-filter branch — its `assertBranchAccess(req, branchId)` case is Task 1D.4.6's conversion)

- [ ] **Step 1: Run the discovery grep**

```bash
cd api && grep -rn "\.branchIds" src/modules
```

- [ ] **Step 2: Rename every match to `.effectiveLocationIds`** (field renames on locally-defined `AuthScope`-style types too, not just `req.auth.branchIds` reads).

- [ ] **Step 3: Run**

```bash
cd api && npx tsc --noEmit && NODE_ENV=test npx vitest run tests/sales tests/payments tests/cash tests/inventory tests/products tests/backoffice --reporter=verbose
```
Expected: `tsc` clean; every existing test still passes (pure rename, `effectiveLocationIds` at this point in the plan is populated identically to the old `branchIds` for every LOCATION-only fixture used by current tests — the COMPANY-expansion difference doesn't land until Phase 1D.2).

- [ ] **Step 4: Commit**

```bash
git add api/src/modules/sales api/src/modules/payments api/src/modules/cash api/src/modules/products api/src/modules/backoffice
git commit -m "refactor: rename req.auth.branchIds consumers to effectiveLocationIds (Phase 1D.1)"
```

### Task 1D.1.7: export and run the Phase 1D.1 focused gate

**Files:**
- Modify: `api/src/modules/rbac/index.ts` (`export * from './authorization-context.js';`)

- [ ] **Step 1:** add the export.
- [ ] **Step 2: Run**

```bash
cd api
NODE_ENV=test npx vitest run tests/rbac tests/auth tests/realtime tests/sales tests/payments tests/cash tests/inventory tests/products tests/backoffice tests/audit --reporter=verbose
npx tsc --noEmit
npm run lint
```

- [ ] **Step 3: Commit**

```bash
git add api/src/modules/rbac/index.ts
git commit -m "feat(rbac): export authorization-context from the rbac module index (Phase 1D.1 complete)"
```

**Exit criteria:** `authorization-context.ts` is the sole source of `req.auth`/`socket.data` on all three call sites, in the assignment shape; the legacy/Production isolation test and the two-independent-assignments test both pass; every existing test passes unmodified; `tsc --noEmit` is clean with zero remaining `req.auth.branchIds` references anywhere.

**Commit boundary:** 7 commits.

**Risk: MEDIUM-HIGH** (raised from the first draft's MEDIUM) — the shape itself is now the security-critical artifact; get the isolation and non-merging tests exactly right here, since every later phase trusts this shape.

---

## PHASE 1D.2 — COMPANY + OWNER / ADMIN policy

**Objective:** make `COMPANY` scope resolve as a qualifying assignment (not a thrown error), build `authorization-policy.ts`'s three functions (`isOwner`, `hasPermission`, `hasPermissionAtLocation`, plus the coarse `hasBranchAccess`), and wire `middleware/authorization.ts` to call `hasPermissionAtLocation` — never `hasPermission` followed by a separate branch check — for every location-scoped route.

**Invariants preserved:** LOCATION-scoped users are unaffected — `hasPermissionAtLocation` degrades to exactly the old per-route behavior for a user with a single LOCATION assignment (which is what every currently-tested user fixture has). No route's permission constant changes in this phase — only how the existing checks are evaluated.

**Exact files expected to change:**
- Modify: `api/src/modules/rbac/effective-branch-ids.ts` (COMPANY-aware `effectiveLocationIds` expansion only — no longer feeds `assignments`)
- Create: `api/tests/rbac/effective-branch-ids.test.ts`
- Modify: `api/src/modules/rbac/authorization-context.ts` (COMPANY produces a `ProductionAssignment`; `effectiveLocationIds` populated)
- Create: `api/src/modules/rbac/authorization-policy.ts`
- Create: `api/tests/rbac/authorization-policy.test.ts`
- Modify: `api/src/middleware/authorization.ts`
- Modify: `api/src/modules/rbac/index.ts`
- Modify: `api/tests/auth/login-scope-switch.test.ts`
- Modify: `api/tests/realtime/socket.test.ts`

**Dependencies:** Phase 1D.1 complete.

**Security checks (explicit per correction):**
1. `SELLER @ A` + `WAREHOUSE @ B` → `SALE_CREATE @ A` allowed, `SALE_CREATE @ B` denied, `INVENTORY_MANAGE @ B` allowed, `INVENTORY_MANAGE @ A` denied — the exact matrix from Cross-cutting design §B, exercised through `authorization-policy.ts`'s unit tests AND through a live route in this phase's integration test.
2. `ADMIN + COMPANY` grants a permission only if that specific COMPANY assignment's own `permissions` includes it — an ADMIN who (hypothetically, mid-migration) also holds an unrelated LOCATION assignment for a different role must not have that LOCATION assignment's permissions bleed into the COMPANY assignment's reach, or vice versa.
3. OWNER passes every check with zero `RolePermission` rows, via `isOwner`, never via a populated `permissions` array.
4. A stale `UserBranchRole`-only grant (Task 1D.1.1's isolation test, replayed here end-to-end through `requirePermission`) authorizes nothing once a route is switched (this end-to-end version is completed properly in Phase 1D.3.6 — this phase's job is only to prove the isolation still holds through the live `assignments` path, not to flip any route yet).

**Rollback/safety considerations:** `effective-branch-ids.ts`'s change is isolated to the `effectiveLocationIds` computation — it no longer participates in building `assignments` at all (Task 1D.1.1 already stopped feeding it into anything but a discard-the-result COMPANY-throw check), so reverting this phase's diff restores the exact 1D.1 end-state.

### Task 1D.2.1: `effective-branch-ids.ts` — COMPANY-aware `effectiveLocationIds` only (never an assignment source)

**Files:**
- Modify: `api/src/modules/rbac/effective-branch-ids.ts`
- Create: `api/tests/rbac/effective-branch-ids.test.ts`

**Interfaces:**
- Produces: `resolveEffectiveLocationIds(db, roleScopes): Promise<string[]>` — a pure **display/filter convenience** computation, consumed only by `authorization-context.ts`'s `effectiveLocationIds` field. Renamed from the first draft's `resolveEffectiveScope` to make unmistakable that its return value is not fed into `assignments` and is never read by `authorization-policy.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// api/tests/rbac/effective-branch-ids.test.ts
import { describe, expect, it, vi } from 'vitest';
import { resolveEffectiveLocationIds } from '../../src/modules/rbac/effective-branch-ids.js';

describe('resolveEffectiveLocationIds (Phase 1D.2, display/filter convenience only)', () => {
  it('unions LOCATION locationIds when no row is COMPANY-kind', async () => {
    const db = { location: { findMany: vi.fn() } };
    const ids = await resolveEffectiveLocationIds(db, [
      { roleId: 'r1', roleCode: 'CASHIER', scopeKind: 'LOCATION', locationId: 'loc-1' },
      { roleId: 'r2', roleCode: 'SELLER', scopeKind: 'LOCATION', locationId: 'loc-2' },
    ]);
    expect(ids).toEqual(['loc-1', 'loc-2']);
    expect(db.location.findMany).not.toHaveBeenCalled();
  });

  it('expands to every active Location id when any row is COMPANY-kind, no sentinel', async () => {
    const db = { location: { findMany: vi.fn().mockResolvedValue([{ id: 'loc-1' }, { id: 'loc-2' }, { id: 'loc-3' }]) } };
    const ids = await resolveEffectiveLocationIds(db, [
      { roleId: 'r-admin', roleCode: 'ADMIN', scopeKind: 'COMPANY', locationId: null },
    ]);
    expect(ids).toEqual(['loc-1', 'loc-2', 'loc-3']);
    expect(db.location.findMany).toHaveBeenCalledWith({ where: { isActive: true }, select: { id: true } });
  });

  it('returns [] for zero rows (fail-closed, unchanged)', async () => {
    const db = { location: { findMany: vi.fn() } };
    expect(await resolveEffectiveLocationIds(db, [])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && npx vitest run tests/rbac/effective-branch-ids.test.ts --reporter=verbose`
Expected: FAIL — `resolveEffectiveLocationIds` does not exist.

- [ ] **Step 3: Rewrite `effective-branch-ids.ts`**

```ts
// api/src/modules/rbac/effective-branch-ids.ts
import type { PrismaClient } from '../../generated/prisma/client.js';
import type { ResolvedRoleScope } from './scope-resolver.js';

type LocationDatabase = Pick<PrismaClient, 'location'>;

// Phase 1D.2: DISPLAY/FILTER CONVENIENCE ONLY (Cross-cutting design §C) — the
// return value feeds authorization-context.ts's effectiveLocationIds field,
// consumed only by direct list/room-join call sites
// (backoffice.service.ts's scopeBranches, socket.ts's room-join loop).
// authorization-policy.ts NEVER calls this function or reads its result —
// permission+location decisions go through hasPermissionAtLocation over
// req.auth.assignments instead, never over this array. A COMPANY-kind row
// expands to every active Location id (never a sentinel), but that
// expansion happening here is explicitly NOT the same fact as "this row is a
// qualifying assignment for a given permission" — that fact lives only in
// the ProductionAssignment entry itself (authorization-context.ts).
export async function resolveEffectiveLocationIds(
  db: LocationDatabase,
  roleScopes: ResolvedRoleScope[],
): Promise<string[]> {
  const hasCompanyScope = roleScopes.some((scope) => scope.scopeKind === 'COMPANY');
  if (!hasCompanyScope) {
    return [...new Set(roleScopes.map((scope) => scope.locationId).filter((id): id is string => id !== null))];
  }
  const locations = await db.location.findMany({ where: { isActive: true }, select: { id: true } });
  return locations.map((location) => location.id);
}
```

(The old sync, throw-on-COMPANY `resolveEffectiveBranchIds` is deleted outright — its only remaining caller after this task is nowhere, since Task 1D.2.2 replaces `authorization-context.ts`'s use of it.)

- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit**

```bash
git add api/src/modules/rbac/effective-branch-ids.ts api/tests/rbac/effective-branch-ids.test.ts
git commit -m "feat(rbac): make effective-branch-ids a COMPANY-aware display-only resolver (Phase 1D.2)"
```

### Task 1D.2.2: `authorization-context.ts` — COMPANY becomes a qualifying assignment

**Files:**
- Modify: `api/src/modules/rbac/authorization-context.ts`
- Modify: `api/tests/rbac/authorization-context.test.ts` (flip the "still throws" test)

- [ ] **Step 1: Replace the "still throws on COMPANY" test** with:

```ts
it('a COMPANY-kind UserRoleScope row becomes its own qualifying assignment, locationId stays null (Phase 1D.2, Cross-cutting §C)', async () => {
  const db = { location: { findMany: async () => [{ id: 'loc-1' }, { id: 'loc-2' }] } };
  const ctx = await buildAuthorizationContext(
    db,
    userFixture({
      roleScopes: [
        { roleId: 'role-admin', scopeKind: 'COMPANY' as const, locationId: null, role: { code: 'ADMIN', permissions: [{ permission: { code: 'PRICE_MANAGE' } }] } },
      ],
    }),
  );
  expect(ctx.assignments).toEqual([
    { roleId: 'role-admin', roleCode: 'ADMIN', scopeKind: 'COMPANY', locationId: null, permissions: ['PRICE_MANAGE'] },
  ]);
  expect(ctx.effectiveLocationIds.sort()).toEqual(['loc-1', 'loc-2']);
});

it('a COMPANY assignment coexisting with an unrelated LOCATION assignment never cross-composes (Cross-cutting §B security check 2)', async () => {
  const db = { location: { findMany: async () => [{ id: 'loc-1' }] } };
  const { hasPermissionAtLocation } = await import('../../src/modules/rbac/authorization-policy.js');
  const ctx = await buildAuthorizationContext(
    db,
    userFixture({
      branchRoles: [],
      roleScopes: [
        { roleId: 'role-admin', scopeKind: 'COMPANY' as const, locationId: null, role: { code: 'ADMIN', permissions: [{ permission: { code: 'PRICE_MANAGE' } }] } },
        { roleId: 'role-cashier', scopeKind: 'LOCATION' as const, locationId: 'loc-9', role: { code: 'CASHIER', permissions: [{ permission: { code: 'CASH_SESSION_OPEN' } }] } },
      ],
    }),
  );
  expect(hasPermissionAtLocation(ctx, 'PRICE_MANAGE', 'anywhere')).toBe(true); // COMPANY assignment covers it
  expect(hasPermissionAtLocation(ctx, 'CASH_SESSION_OPEN', 'loc-9')).toBe(true); // LOCATION assignment covers it
  expect(hasPermissionAtLocation(ctx, 'PRICE_MANAGE', 'loc-9')).toBe(true); // COMPANY still covers PRICE_MANAGE anywhere
  expect(hasPermissionAtLocation(ctx, 'CASH_SESSION_OPEN', 'anywhere')).toBe(false); // CASHIER assignment is LOCATION-only, not COMPANY
});
```

(The second test forward-references `authorization-policy.ts`, written next in Task 1D.2.3 — sequence Task 1D.2.2 and 1D.2.3's commits together if running strict RED/GREEN per-task; both are small enough this plan treats them as one coherent commit pair.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && npx vitest run tests/rbac/authorization-context.test.ts --reporter=verbose`
Expected: FAIL — `buildAuthorizationContext` still throws on COMPANY; `authorization-policy.ts` does not exist yet.

- [ ] **Step 3: Update `authorization-context.ts`**

```ts
// api/src/modules/rbac/authorization-context.ts (changed parts only)
import { resolveEffectiveLocationIds } from './effective-branch-ids.js';
// remove: import { resolveEffectiveBranchIds } from './effective-branch-ids.js';
// remove: import { mapUserRoleScopeRows } from './scope-resolver.js';

export async function buildAuthorizationContext(
  db: AuthorizationContextDatabase, // rename from _db
  user: AuthorizationContextInput,
): Promise<Express.AuthContext> {
  const roles = [...new Set([...user.roleScopes.map((s) => s.role.code), ...user.branchRoles.map((r) => r.role.code)])];

  const legacyPermissions = [...new Set(user.branchRoles.flatMap((row) => row.role.permissions.map((p) => p.permission.code)))]
    .filter((code) => LEGACY_PERMISSION_CODES.has(code));

  const assignments = user.roleScopes.map((scope) => ({
    roleId: scope.roleId,
    roleCode: scope.role.code as Express.AuthContext['assignments'][number]['roleCode'],
    scopeKind: scope.scopeKind,
    locationId: scope.locationId, // stays null for COMPANY — never fabricated
    permissions: scope.role.permissions.map((p) => p.permission.code).filter((code) => PRODUCTION_PERMISSION_CODES.has(code)),
  }));

  const effectiveLocationIds = await resolveEffectiveLocationIds(
    db,
    user.roleScopes.map((scope) => ({ roleId: scope.roleId, roleCode: scope.role.code, scopeKind: scope.scopeKind, locationId: scope.locationId })),
  );

  return { userId: user.id, roles, legacyPermissions, assignments, effectiveLocationIds };
}
```

- [ ] **Step 4: Run** (after Task 1D.2.3's `authorization-policy.ts` exists — run both tasks' tests together) — `cd api && npx vitest run tests/rbac --reporter=verbose` — PASS.
- [ ] **Step 5: Commit**

```bash
git add api/src/modules/rbac/authorization-context.ts api/tests/rbac/authorization-context.test.ts
git commit -m "feat(rbac): COMPANY becomes a qualifying assignment in authorization-context (Phase 1D.2)"
```

### Task 1D.2.3: `authorization-policy.ts` — `isOwner` / `hasPermission` / `hasPermissionAtLocation` / `hasBranchAccess`

**Files:**
- Create: `api/src/modules/rbac/authorization-policy.ts`
- Create: `api/tests/rbac/authorization-policy.test.ts`

**Interfaces:**
- Consumes: `Express.AuthContext.assignments` (Task 1D.1.2).
- Produces: `isOwner`, `hasPermission`, `hasPermissionAtLocation`, `hasBranchAccess` — consumed by Task 1D.2.4 and Phase 1D.4's scope-assignment service.

- [ ] **Step 1: Write the failing tests**

```ts
// api/tests/rbac/authorization-policy.test.ts
import { describe, expect, it } from 'vitest';
import { hasBranchAccess, hasPermission, hasPermissionAtLocation, isOwner } from '../../src/modules/rbac/authorization-policy.js';

function ctx(assignments: Express.AuthContext['assignments']): Pick<Express.AuthContext, 'assignments'> {
  return { assignments };
}

const seller = { roleId: 'r1', roleCode: 'SELLER' as const, scopeKind: 'LOCATION' as const, locationId: 'A', permissions: ['SALE_CREATE'] };
const warehouse = { roleId: 'r2', roleCode: 'WAREHOUSE' as const, scopeKind: 'LOCATION' as const, locationId: 'B', permissions: ['INVENTORY_MANAGE'] };
const owner = { roleId: 'r3', roleCode: 'OWNER' as const, scopeKind: 'COMPANY' as const, locationId: null, permissions: [] };
const adminCompany = { roleId: 'r4', roleCode: 'ADMIN' as const, scopeKind: 'COMPANY' as const, locationId: null, permissions: ['PRICE_MANAGE'] };
// Simulates the EXACT pre-backfill shape of a real ADMIN assignment: the
// Production catalog grants ADMIN all 33 permissions unconditionally
// (DEFAULT_ROLE_GRANTS), including PRICE_MANAGE, regardless of scopeKind —
// so this fixture's `permissions` array genuinely contains 'PRICE_MANAGE'
// even though it is LOCATION-scoped. This is the fixture the correction's
// "ADMIN @ LOCATION before the COMPANY correction" case is built on.
const adminLocation = { roleId: 'r5', roleCode: 'ADMIN' as const, scopeKind: 'LOCATION' as const, locationId: 'X', permissions: ['PRICE_MANAGE', 'SALE_VIEW'] };

describe('authorization-policy (Phase 1D.2)', () => {
  it('isOwner is true only when an assignment has roleCode OWNER', () => {
    expect(isOwner(ctx([seller]))).toBe(false);
    expect(isOwner(ctx([owner]))).toBe(true);
  });

  it('hasPermission checks across all assignments, no location involved, for a non-company-required permission', () => {
    expect(hasPermission(ctx([seller, warehouse]), 'SALE_CREATE')).toBe(true);
    expect(hasPermission(ctx([seller, warehouse]), 'PRICE_MANAGE')).toBe(false); // neither assignment grants it at all
  });

  it('hasPermission is unconditionally true for OWNER with zero permissions anywhere', () => {
    expect(hasPermission(ctx([owner]), 'PRICE_MANAGE')).toBe(true);
  });

  it('REQUIRED BY CORRECTION: ADMIN @ LOCATION + PRICE_MANAGE RolePermission does NOT satisfy a COMPANY-required check, even via the global hasPermission path', () => {
    expect(hasPermission(ctx([adminLocation]), 'PRICE_MANAGE')).toBe(false);
  });

  it('REQUIRED BY CORRECTION: ADMIN @ LOCATION + PRICE_MANAGE does NOT satisfy it at its own matching location either — no location can rescue a COMPANY-required permission', () => {
    expect(hasPermissionAtLocation(ctx([adminLocation]), 'PRICE_MANAGE', 'X')).toBe(false);
  });

  it('REQUIRED BY CORRECTION: ADMIN @ COMPANY + PRICE_MANAGE DOES satisfy it', () => {
    expect(hasPermission(ctx([adminCompany]), 'PRICE_MANAGE')).toBe(true);
    expect(hasPermissionAtLocation(ctx([adminCompany]), 'PRICE_MANAGE', 'literally-any-uuid')).toBe(true);
  });

  it('REQUIRED BY CORRECTION: an ADMIN @ LOCATION assignment does not accidentally gain global/company Production authority for a NON-company-required permission — hasPermission (global, no location) still says yes, but hasPermissionAtLocation correctly still requires THIS assignment\'s own matching location, never a different one', () => {
    expect(hasPermission(ctx([adminLocation]), 'SALE_VIEW')).toBe(true); // SALE_VIEW is not company-required, so ANY assignment holding it qualifies for a location-less/global check
    expect(hasPermissionAtLocation(ctx([adminLocation]), 'SALE_VIEW', 'X')).toBe(true); // matches its own assigned location
    expect(hasPermissionAtLocation(ctx([adminLocation]), 'SALE_VIEW', 'some-other-location')).toBe(false); // does NOT match a location this assignment was never granted
  });

  it('SELLER @ A + WAREHOUSE @ B — the exact matrix required by the correction', () => {
    const twoAssignments = ctx([seller, warehouse]);
    expect(hasPermissionAtLocation(twoAssignments, 'SALE_CREATE', 'A')).toBe(true);
    expect(hasPermissionAtLocation(twoAssignments, 'SALE_CREATE', 'B')).toBe(false);
    expect(hasPermissionAtLocation(twoAssignments, 'INVENTORY_MANAGE', 'B')).toBe(true);
    expect(hasPermissionAtLocation(twoAssignments, 'INVENTORY_MANAGE', 'A')).toBe(false);
  });

  it('a COMPANY assignment qualifies for its own permission at any location', () => {
    expect(hasPermissionAtLocation(ctx([adminCompany]), 'PRICE_MANAGE', 'anywhere')).toBe(true);
    expect(hasPermissionAtLocation(ctx([adminCompany]), 'PRICE_MANAGE', 'literally-any-uuid')).toBe(true);
  });

  it('a COMPANY assignment does NOT qualify for a permission it does not itself grant, even if a co-existing LOCATION assignment grants it elsewhere', () => {
    expect(hasPermissionAtLocation(ctx([adminCompany, seller]), 'SALE_CREATE', 'B')).toBe(false); // COMPANY assignment lacks SALE_CREATE; SELLER assignment is scoped to A only
  });

  it('hasPermissionAtLocation is unconditionally true for OWNER regardless of location', () => {
    expect(hasPermissionAtLocation(ctx([owner]), 'PRICE_MANAGE', 'anything')).toBe(true);
  });

  it('hasPermissionAtLocation rejects an empty locationId even for OWNER', () => {
    expect(hasPermissionAtLocation(ctx([owner]), 'PRICE_MANAGE', '')).toBe(false);
  });

  it('hasBranchAccess is coarse membership only, no permission attached', () => {
    expect(hasBranchAccess(ctx([seller]), 'A')).toBe(true);
    expect(hasBranchAccess(ctx([seller]), 'B')).toBe(false);
    expect(hasBranchAccess(ctx([adminCompany]), 'literally-anything')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — module does not exist.

- [ ] **Step 3: Write the implementation**

```ts
// api/src/modules/rbac/authorization-policy.ts
import { ROLE_CODES } from './roles.js';
import { COMPANY_SCOPE_REQUIRED_FOR_ADMIN } from './permissions.js';

type Ctx = Pick<Express.AuthContext, 'assignments'>;

// Reuses the existing, already-approved frozen domain list unchanged — no
// new list, no new permission. Role-agnostic: it is a property of the
// permission, not of which role currently holds it.
const COMPANY_REQUIRED_PERMISSIONS = new Set<string>(COMPANY_SCOPE_REQUIRED_FOR_ADMIN);

export function requiresCompanyScope(permission: string): boolean {
  return COMPANY_REQUIRED_PERMISSIONS.has(permission);
}

// Phase 1D.2: the ONLY place OWNER's implicit authority is recognized
// (Cross-cutting design §B/§D of this plan). No other file may compare a
// role code to ROLE_CODES.OWNER for an authorization decision.
export function isOwner(ctx: Ctx): boolean {
  return ctx.assignments.some((a) => a.roleCode === ROLE_CODES.OWNER);
}

// Single internal predicate both exported functions delegate to — see
// Cross-cutting design §B for the full rationale. A COMPANY-required
// permission (PRICE_MANAGE/PRODUCT_MANAGE/PRODUCT_VARIANT_MANAGE today) can
// only ever be satisfied by a scopeKind:'COMPANY' assignment, regardless of
// whether a location argument is supplied and regardless of whether that
// assignment's own locationId would otherwise have matched.
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
// Still enforces the COMPANY-required rule even though no location is
// supplied (see the "ADMIN @ LOCATION + PRICE_MANAGE" test above).
export function hasPermission(ctx: Ctx, permission: string): boolean {
  if (isOwner(ctx)) return true;
  return ctx.assignments.some((a) => assignmentQualifies(a, permission));
}

// THE cross-composition guard: permission and location must be satisfied by
// the SAME assignment. Never split this into two independent checks.
export function hasPermissionAtLocation(ctx: Ctx, permission: string, locationId: string): boolean {
  if (!locationId) return false;
  if (isOwner(ctx)) return true;
  return ctx.assignments.some((a) => assignmentQualifies(a, permission, locationId));
}

// Coarse membership only, no permission attached — legitimate only for the
// small set of call sites with no specific permission behind them (see
// Task 1D.5.3). Not subject to the COMPANY-required rule (there is no
// permission to check it against). Prefer hasPermissionAtLocation everywhere
// a permission is known.
export function hasBranchAccess(ctx: Ctx, locationId: string): boolean {
  if (!locationId) return false;
  if (isOwner(ctx)) return true;
  return ctx.assignments.some((a) => a.scopeKind === 'COMPANY' || a.locationId === locationId);
}
```

- [ ] **Step 4: Run** — all tests PASS, including the new COMPANY-required cases.
- [ ] **Step 5: Commit**

```bash
git add api/src/modules/rbac/authorization-policy.ts api/tests/rbac/authorization-policy.test.ts
git commit -m "feat(rbac): add assignment-scoped authorization policy with COMPANY-required permission enforcement (Phase 1D.2)"
```

### Task 1D.2.4: wire `middleware/authorization.ts` to `hasPermission`/`hasPermissionAtLocation`

**Files:**
- Modify: `api/src/middleware/authorization.ts`
- Test: extend `api/tests/cash/cash-session.test.ts`; add a new live-route cross-composition test to `api/tests/sales` or `api/tests/inventory` (whichever already has a `resolveResourceBranch`-based route wired — `inventory.routes.ts` does).

- [ ] **Step 1: Write the failing tests**

Add to `api/tests/cash/cash-session.test.ts` (OWNER case, same as the first draft):

```ts
it('grants an OWNER-coded caller access with zero explicit RolePermission grants', async () => {
  await db.role.update({ where: { id: roleId }, data: { code: 'OWNER' } });
  await db.rolePermission.deleteMany({ where: { roleId } });
  const session = await open();
  expect(session.status).toBe(201);
});
```

Add a new file `api/tests/inventory/cross-assignment.test.ts` proving the correction's exact matrix through a live route:

```ts
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { createTestPrismaClient, truncateAllTables } from '../helpers/test-db.js';
import { createBranch, ensureTestLocation } from '../helpers/factories.js';
import { bootstrapProductionRbacCatalog } from '../../src/modules/rbac/catalog.service.js';
import { getAuthToken } from '../helpers/auth.js';

describe('cross-assignment composition (Phase 1D.2 security correction)', () => {
  let db: Awaited<ReturnType<typeof createTestPrismaClient>>;
  let app: ReturnType<typeof createApp>;
  beforeAll(async () => { db = await createTestPrismaClient(); app = createApp(db); });
  beforeEach(async () => { await truncateAllTables(db); await bootstrapProductionRbacCatalog(db); });
  afterAll(async () => db.$disconnect());

  it('a SELLER @ A + WAREHOUSE @ B user cannot use WAREHOUSE INVENTORY_MANAGE at A, nor SELLER-only access at B for a permission SELLER lacks', async () => {
    const branchA = await createBranch(db);
    const branchB = await createBranch(db);
    await ensureTestLocation(db, branchA.id);
    await ensureTestLocation(db, branchB.id);
    const sellerRole = await db.role.findUniqueOrThrow({ where: { code: 'SELLER' } });
    const warehouseRole = await db.role.findUniqueOrThrow({ where: { code: 'WAREHOUSE' } });
    const user = await db.user.create({ data: { name: 'multi', email: 'multi@test.local', passwordHash: 'x' } });
    await db.userRoleScope.createMany({
      data: [
        { userId: user.id, roleId: sellerRole.id, scopeKind: 'LOCATION', locationId: branchA.id },
        { userId: user.id, roleId: warehouseRole.id, scopeKind: 'LOCATION', locationId: branchB.id },
      ],
    });
    const token = await getAuthToken(user);

    // SELLER only grants INVENTORY_VIEW, not INVENTORY_MANAGE — this route
    // requires only INVENTORY_VIEW (branchScope:'own'), which SELLER DOES
    // hold at A, so this specific call is expected to succeed; the negative
    // assertion below is what actually proves the fix.
    const atA = await request(app).get('/api/v1/inventory').query({ branchId: branchA.id }).set('Authorization', `Bearer ${token}`);
    expect(atA.status).toBe(200);

    // WAREHOUSE does not hold INVENTORY_VIEW by default grant (it holds
    // INVENTORY_MANAGE) — if this call succeeded, it would prove the SELLER
    // assignment's INVENTORY_VIEW permission incorrectly combined with the
    // WAREHOUSE assignment's location B, which is exactly the bug this phase
    // fixes.
    const atB = await request(app).get('/api/v1/inventory').query({ branchId: branchB.id }).set('Authorization', `Bearer ${token}`);
    expect(atB.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && npx vitest run tests/cash/cash-session.test.ts tests/inventory/cross-assignment.test.ts --reporter=verbose`
Expected: FAIL — `requirePermission` still checks `req.auth.permissions`/`branchIds` (pre-1D.2 shape doesn't even exist anymore post-1D.1, so this actually fails to compile/run until this task's rewrite lands — that TS failure IS this task's RED).

- [ ] **Step 3: Rewrite `middleware/authorization.ts`**

```ts
// api/src/middleware/authorization.ts
import type { RequestHandler } from 'express';
import { AppError } from '../shared/errors.js';
import type { ProductionPermission } from '../modules/rbac/permissions.js';
import { hasBranchAccess, hasPermission, hasPermissionAtLocation } from '../modules/rbac/authorization-policy.js';

export type BranchScope = 'own' | 'any' | 'global';
export type ResourceBranchResolver = (
  req: Parameters<RequestHandler>[0],
) => string | undefined | Promise<string | undefined>;

export type PermissionOptions = { branchScope?: BranchScope; resolveResourceBranch?: ResourceBranchResolver };

function forbidden(message = 'No cuenta con permisos para esta operación.') {
  return new AppError(403, 'FORBIDDEN', message);
}

// Coarse membership only — no permission attached. Kept for the small set of
// legitimate no-permission-behind-it call sites (Task 1D.5.3's cash GET
// routes). NEVER use this as a stand-in for a permission decision — pair
// with assertPermissionAtLocation instead wherever a specific permission is
// known (see Phase 1D.3's manual-recheck conversion steps).
export function assertBranchAccess(req: Parameters<RequestHandler>[0], branchId: string): void {
  if (!req.auth) throw new AppError(401, 'UNAUTHORIZED', 'Se requiere autenticación.');
  if (!hasBranchAccess(req.auth, branchId)) throw forbidden();
}

// The permission-paired equivalent, for manual service-level rechecks that
// are actually standing in for a route's location-scoped permission gate.
export function assertPermissionAtLocation(
  req: Parameters<RequestHandler>[0],
  permission: ProductionPermission,
  branchId: string,
): void {
  if (!req.auth) throw new AppError(401, 'UNAUTHORIZED', 'Se requiere autenticación.');
  if (!hasPermissionAtLocation(req.auth, permission, branchId)) throw forbidden();
}

export function requirePermission(permission: ProductionPermission, options: PermissionOptions = {}): RequestHandler {
  const branchScope = options.branchScope ?? 'global';
  return async (req, _res, next) => {
    try {
      if (!req.auth) throw new AppError(401, 'UNAUTHORIZED', 'Se requiere autenticación.');

      if (branchScope === 'global') {
        if (!hasPermission(req.auth, permission)) throw forbidden();
        next();
        return;
      }

      if (!options.resolveResourceBranch) throw forbidden('No se pudo resolver el alcance de la sucursal.');
      const resourceBranchId = await options.resolveResourceBranch(req);
      if (!resourceBranchId) throw forbidden('No se pudo resolver el alcance de la sucursal.');
      if (!hasPermissionAtLocation(req.auth, permission, resourceBranchId)) throw forbidden();
      next();
    } catch (error) {
      next(error instanceof AppError ? error : forbidden());
    }
  };
}
```

Note: this task also tightens `requirePermission`'s type param straight to `ProductionPermission` (the first draft did this as a separate Task 1D.3.7 at the *end* of Phase 1D.3 — here it happens now, in 1D.2, because `hasPermission`/`hasPermissionAtLocation` only ever operate on `assignments` regardless of legacy/Production origin, so there is no reason to keep accepting a legacy `Permission` string through this function at all; **not-yet-switched routes still pass their legacy `PERMISSIONS.X` string through a separate, explicit `requireLegacyPermission` shim** — see Task 1D.2.5.

- [ ] **Step 4: `requireLegacyPermission` shim (compatibility window only)**

Not-yet-switched routes (everything until their Task 1D.3.* lands) must keep working against `legacyPermissions`. Add a second, explicitly-named export so this compatibility path can never be mistaken for the Production one:

```ts
// api/src/middleware/authorization.ts (append)
import type { Permission } from '../shared/permissions.js';

// Compatibility-window only (Cross-cutting design §D) — checks
// req.auth.legacyPermissions, NEVER req.auth.assignments. Every call site
// using this is switched to requirePermission (Production) in Phase 1D.3,
// one route at a time; this export is deleted outright at Task 1D.3.6, not
// merely stopped being called.
export function requireLegacyPermission(permission: Permission): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth) { next(new AppError(401, 'UNAUTHORIZED', 'Se requiere autenticación.')); return; }
    if (!req.auth.legacyPermissions.includes(permission)) { next(forbidden()); return; }
    next();
  };
}
```

- [ ] **Step 5: Update every not-yet-switched route file to call `requireLegacyPermission` instead of the old `requirePermission`**

This is a mechanical rename-only pass (9 route files, same import-and-call-site pattern as the first draft's Task 1D.3.1–1D.3.5, but now `requireLegacyPermission(PERMISSIONS.X)` instead of `requirePermission(PERMISSIONS.X)`) — done here, once, so the codebase is never in a state where `requirePermission` silently accepts a legacy string. Phase 1D.3's job becomes purely "swap `requireLegacyPermission(PERMISSIONS.X)` → `requirePermission(PRODUCTION_PERMISSIONS.X)`" per route, a strictly smaller/safer diff per file than the first draft's approach.

- [ ] **Step 6: Run the full existing route-level regression suite**

Run: `cd api && NODE_ENV=test npx vitest run tests/cash tests/sales tests/payments tests/inventory tests/products tests/backoffice tests/audit tests/rbac tests/auth tests/realtime --reporter=verbose`
Expected: all PASS — every route still checks the legacy vocabulary (via the new `requireLegacyPermission` name), behavior unchanged; the new OWNER and cross-assignment tests also PASS.

- [ ] **Step 7: Commit**

```bash
git add api/src/middleware/authorization.ts api/src/modules/sales api/src/modules/payments api/src/modules/cash api/src/modules/inventory api/src/modules/products api/src/modules/backoffice api/src/modules/audit api/tests/cash/cash-session.test.ts api/tests/inventory/cross-assignment.test.ts
git commit -m "feat(authz): split requirePermission (Production) from requireLegacyPermission (compat-only), fix cross-assignment composition (Phase 1D.2)"
```

### Task 1D.2.5: end-to-end OWNER and ADMIN-COMPANY route tests

**Files:**
- Modify: `api/tests/auth/login-scope-switch.test.ts`

- [ ] **Step 1–3:** same structure as the first draft's Task 1D.2.5 — seed an OWNER user via a COMPANY `UserRoleScope` row + `bootstrapProductionRbacCatalog`, hit a `requirePermission`-gated route not yet switched to Production... **note:** since no route is switched to `requirePermission`(Production) until Phase 1D.3, this phase's e2e OWNER test must target a route already exercised through `requirePermission` directly in a unit-style call (mirror Task 1D.2.4's `cash-session.test.ts` OWNER case, which already proves this end-to-end for `CASH_SESSION_OPEN` via the *legacy* route once it's using `requireLegacyPermission`... **correction:** `requireLegacyPermission` does NOT special-case OWNER (§D — legacy vocabulary is compatibility-only, not policy-aware) — so the OWNER route-level proof must use a call to `requirePermission` directly (not through an HTTP route, since none are switched yet) or wait until Phase 1D.3's first switched route. **Resolve this ordering explicitly:** move this task's OWNER/ADMIN-COMPANY end-to-end HTTP proof to Phase 1D.3's Task 1D.3.1 (the first route actually switched to `requirePermission`), and keep only the module-level proof here:

```ts
it('OWNER passes requirePermission directly with zero RolePermission rows (module-level proof, HTTP proof lands in Task 1D.3.1)', async () => {
  const { requirePermission } = await import('../../src/middleware/authorization.js');
  const middleware = requirePermission('PRICE_MANAGE' as never);
  const req: any = { auth: { userId: 'u1', roles: ['OWNER'], legacyPermissions: [], assignments: [{ roleId: 'r', roleCode: 'OWNER', scopeKind: 'COMPANY', locationId: null, permissions: [] }], effectiveLocationIds: [] } };
  let calledNext = false;
  await middleware(req, {} as any, ((err?: unknown) => { if (!err) calledNext = true; }) as never);
  expect(calledNext).toBe(true);
});
```

- [ ] **Step 4: Run** — `cd api && npx vitest run tests/auth --reporter=verbose` — PASS.
- [ ] **Step 5: Commit**

```bash
git add api/tests/auth/login-scope-switch.test.ts
git commit -m "test(auth): module-level OWNER proof through requirePermission (Phase 1D.2; HTTP proof deferred to 1D.3.1)"
```

### Task 1D.2.6: socket COMPANY-scope connection test

**Files:**
- Modify: `api/tests/realtime/socket.test.ts`

- [ ] **Step 1–4:** same structure as the first draft's Task 1D.2.6, using `socket.data.effectiveLocationIds` (not `branchIds`) as the room-join source, and a mocked `database.location.findMany` for the COMPANY expansion. Assert a COMPANY-scoped connection joins every active location's room via `effectiveLocationIds`, exactly mirroring `backoffice.service.ts`'s consumption pattern — this is a display/room-membership convenience, not a permission decision, consistent with Cross-cutting design §C.

- [ ] **Step 5: Commit**

```bash
git add api/tests/realtime/socket.test.ts
git commit -m "test(realtime): prove COMPANY-scoped sockets join every active location room via effectiveLocationIds (Phase 1D.2)"
```

**Exit criteria:** OWNER passes every check via `isOwner`; a COMPANY assignment qualifies for its own permissions at any location, never for another assignment's permissions; the `SELLER @ A + WAREHOUSE @ B` matrix passes through a live route; `requirePermission` and `requireLegacyPermission` are two distinct, non-interchangeable exports.

**Commit boundary:** 6 commits (reordered from the first draft — the legacy/Production split into two named middleware functions happens here instead of at the end of 1D.3, per the correction's emphasis on this being the point most likely to leak).

**Risk: HIGH** — this phase both grants OWNER/ADMIN real authority for the first time AND is the phase that closes the cross-composition hole; `authorization-policy.ts`'s 9 unit tests plus the live cross-assignment route test are the load-bearing proof for the rest of this plan.

---

## PHASE 1D.3 — Production Permission Switch

**Objective:** now that `requirePermission` (Production, via `assignments`) and `requireLegacyPermission` (legacy, via `legacyPermissions`) are two distinct functions (Phase 1D.2, Task 1D.2.4), switch every route's call site from the latter to the former — a strictly mechanical, per-route rename — and convert every manual service-level branch recheck that was actually standing in for a permission decision from `assertBranchAccess` to `assertPermissionAtLocation`. Finish by deleting `requireLegacyPermission`, the `legacyPermissions` field, and its computation entirely.

**Invariants preserved:** no role-name bypasses anywhere (unchanged — every switched route is still a plain `requirePermission(CODE)`/`requirePermission(CODE, options)` call). `assertPermissionAtLocation` conversions never change *which* permission gates a route, only *how* its location half is checked — each conversion pairs the manual recheck with the exact permission the surrounding route already enforces.

**Exact files expected to change:**
- Modify: `api/src/modules/sales/sales.routes.ts`, `api/src/modules/sales/cancellation.routes.ts`, `api/src/modules/sales/sales.service.ts`, `api/src/modules/sales/cancellation.service.ts`
- Modify: `api/src/modules/payments/payments.routes.ts`, `api/src/modules/payments/payments.service.ts`
- Modify: `api/src/modules/cash/cash.routes.ts`, `api/src/modules/cash/cash.service.ts` (open/close paths only — `GET /register`/`GET /current` explicitly untouched, see Task 1D.5.3)
- Modify: `api/src/modules/inventory/inventory.routes.ts` (no manual service-level recheck exists here — `resolveResourceBranch` already routes through `requirePermission`)
- Modify: `api/src/modules/products/products.routes.ts`, `api/src/modules/products/products.service.ts`
- Modify: `api/src/modules/backoffice/backoffice.routes.ts`, `api/src/modules/backoffice/backoffice.service.ts`
- Modify: `api/src/modules/audit/audit.routes.ts`
- Modify: `api/src/modules/rbac/authorization-context.ts` (delete `legacyPermissions` entirely)
- Modify: `api/src/middleware/authorization.ts` (delete `requireLegacyPermission`)

**Dependencies:** Phase 1D.2 complete.

**Security checks:** for every one of the 12 mapped permissions, a test proves a caller holding **only** the Production uppercase grant is authorized through the switched route; Task 1D.3.6 proves a caller holding **only** the legacy lowercase grant is rejected everywhere, in one pass, once `requireLegacyPermission` no longer exists for any route to call; every converted manual recheck (sales view/complete, cancellation, payments charge/view, cash open/close, products variant filter, backoffice sale detail) is proven to require the *same* permission the route's own `requirePermission` already enforces, not merely branch membership — closing the same class of bug Task 1D.2.4's `cross-assignment.test.ts` proved at the route-resolver level, now at the service-internals level too.

**Rollback/safety considerations:** each route-file task is independently revertible. Task 1D.3.6 (deleting `requireLegacyPermission`/`legacyPermissions`) is the last task, run only after every route file is confirmed switched — `tsc --noEmit` fails loudly if any route file still imports the deleted function, which is the intended safety net.

### Task 1D.3.1: worked example — `sales.routes.ts` + `cancellation.routes.ts` (+ the deferred OWNER/ADMIN-COMPANY HTTP proof from Task 1D.2.5)

**Files:**
- Modify: `api/src/modules/sales/sales.routes.ts`, `api/src/modules/sales/cancellation.routes.ts`
- Modify: `api/src/modules/sales/sales.service.ts` (`createDraftSale`'s `assertBranchAccess`, `ensureSaleAccess`, `completeSaleInTransaction`'s inline check — **three** conversions, not two; `createDraftSale`'s was missed in the prior revision and is added here by this correction's global-route audit, Cross-cutting §C.1)
- Modify: `api/src/modules/sales/cancellation.service.ts` (`branchAssignment`, used by `cancelSale` — permission-paired conversion; `releaseExpiredReservations` stays a bulk filter, already renamed to `effectiveLocationIds` in Task 1D.1.6, no further change here)
- Modify: `api/src/modules/sales/cancellation.controller.ts` (pass `req.auth` through to `cancelSale` instead of the constructed `{ userId, branchIds }` scope object, so it can call `assertPermissionAtLocation`/`hasPermissionAtLocation` internally)
- Test: extend `api/tests/sales/*.test.ts`; add the OWNER/ADMIN-COMPANY HTTP test deferred from Task 1D.2.5.

- [ ] **Step 1: Write the failing tests**

```ts
// api/tests/sales/pending-queue.test.ts (add)
it('authorizes the pending-queue route via the Production SALE_QUEUE_VIEW grant alone, once switched', async () => {
  const productionPermission = await db.permission.upsert({ where: { code: 'SALE_QUEUE_VIEW' }, create: { code: 'SALE_QUEUE_VIEW' }, update: {} });
  const productionRole = await createRole(db, 'PRODUCTION-ONLY-ROLE');
  await db.rolePermission.create({ data: { roleId: productionRole.id, permissionId: productionPermission.id } });
  const user = await createTestUser(db, productionRole.id, branchId);
  const token = await getAuthToken(user);
  const response = await request(app).get('/api/v1/sales/pending').set('Authorization', `Bearer ${token}`);
  expect(response.status).toBe(200);
});

it('rejects a legacy-lowercase-only grant on the pending-queue route once switched', async () => {
  const legacyPermission = await db.permission.upsert({ where: { code: 'sale.queue.view' }, create: { code: 'sale.queue.view' }, update: {} });
  const legacyRole = await createRole(db, 'LEGACY-ONLY-ROLE');
  await db.rolePermission.create({ data: { roleId: legacyRole.id, permissionId: legacyPermission.id } });
  const user = await createTestUser(db, legacyRole.id, branchId);
  const token = await getAuthToken(user);
  const response = await request(app).get('/api/v1/sales/pending').set('Authorization', `Bearer ${token}`);
  expect(response.status).toBe(403);
});
```

```ts
// api/tests/auth/login-scope-switch.test.ts (the HTTP proof deferred from Task 1D.2.5)
it('an OWNER user passes a live switched route (SALE_QUEUE_VIEW) with zero RolePermission rows', async () => {
  const { bootstrapProductionRbacCatalog } = await import('../../src/modules/rbac/catalog.service.js');
  await bootstrapProductionRbacCatalog(prisma);
  const ownerRole = await prisma.role.findUniqueOrThrow({ where: { code: 'OWNER' } });
  const owner = await prisma.user.create({ data: { name: 'Owner E2E', email: 'owner-e2e@test.local', passwordHash: 'x' } });
  await prisma.userRoleScope.create({ data: { userId: owner.id, roleId: ownerRole.id, scopeKind: 'COMPANY', locationId: null } });
  const { getAuthToken } = await import('../helpers/auth.js');
  const token = await getAuthToken({ id: owner.id });
  const response = await request(app).get('/api/v1/sales/pending').set('Authorization', `Bearer ${token}`);
  expect(response.status).toBe(200);
});

it('an ADMIN with a COMPANY assignment can view a sale at a branch it was never explicitly LOCATION-granted', async () => {
  const { bootstrapProductionRbacCatalog } = await import('../../src/modules/rbac/catalog.service.js');
  await bootstrapProductionRbacCatalog(prisma);
  const adminRole = await prisma.role.findUniqueOrThrow({ where: { code: 'ADMIN' } });
  const admin = await prisma.user.create({ data: { name: 'Admin E2E', email: 'admin-e2e@test.local', passwordHash: 'x' } });
  await prisma.userRoleScope.create({ data: { userId: admin.id, roleId: adminRole.id, scopeKind: 'COMPANY', locationId: null } });
  const { getAuthToken } = await import('../helpers/auth.js');
  const token = await getAuthToken({ id: admin.id });
  const seller = await prisma.user.findUniqueOrThrow({ where: { email: 'seller01@demo.local' } });
  const sale = await prisma.sale.findFirstOrThrow({ where: { sellerId: seller.id } });
  const response = await request(app).get(`/api/v1/sales/${sale.id}`).set('Authorization', `Bearer ${token}`);
  expect(response.status).toBe(200); // proves ensureSaleAccess's converted assertPermissionAtLocation(SALE_VIEW) honors the COMPANY assignment
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && npx vitest run tests/sales tests/auth/login-scope-switch.test.ts --reporter=verbose`
Expected: FAIL — routes still call `requireLegacyPermission`; `sales.service.ts` still calls `assertBranchAccess` (coarse, no permission attached — would in fact currently ALSO pass the ADMIN-COMPANY test today since `hasBranchAccess` already honors COMPANY assignments, but would NOT distinguish a permission-less grant, which the rejection test above catches instead).

- [ ] **Step 3: Switch the routes**

```ts
// api/src/modules/sales/sales.routes.ts (diff)
- import { PERMISSIONS } from '../../shared/permissions.js';
- import { requireLegacyPermission } from '../../middleware/authorization.js';
+ import { PRODUCTION_PERMISSIONS } from '../rbac/permissions.js';
+ import { requirePermission } from '../../middleware/authorization.js';
  ...
-  const createPermission = requireLegacyPermission(PERMISSIONS.SALE_CREATE);
-  const viewPermission = requireLegacyPermission(PERMISSIONS.SALE_VIEW);
-  const sendPermission = requireLegacyPermission(PERMISSIONS.SALE_CREATE, {
+  const createPermission = requirePermission(PRODUCTION_PERMISSIONS.SALE_CREATE);
+  const viewPermission = requirePermission(PRODUCTION_PERMISSIONS.SALE_VIEW);
+  const sendPermission = requirePermission(PRODUCTION_PERMISSIONS.SALE_CREATE, {
     branchScope: 'own',
     resolveResourceBranch: async (req) => ...
   });
   router.get('/pending', requirePermission(PRODUCTION_PERMISSIONS.SALE_QUEUE_VIEW), controller.pending);
   router.post('/:saleId/complete', validate(saleIdDto, 'params'), requirePermission(PRODUCTION_PERMISSIONS.SALE_COMPLETE), controller.complete);
```

```ts
// api/src/modules/sales/cancellation.routes.ts — same pattern, PRODUCTION_PERMISSIONS.SALE_CREATE / INVENTORY_MANAGE
```

- [ ] **Step 4: Convert the manual rechecks in `sales.service.ts` and `cancellation.service.ts`**

```ts
// api/src/modules/sales/sales.service.ts (createDraftSale — diff; the conversion Task 1D.1.6 deliberately left for here)
  import { assertPermissionAtLocation } from '../../middleware/authorization.js';
  import { PRODUCTION_PERMISSIONS } from '../rbac/permissions.js';
  async function createDraftSale(req, userId, requestedBranchId) {
    const branchId = requestedBranchId ?? (req.auth?.effectiveLocationIds.length === 1 ? req.auth.effectiveLocationIds[0] : undefined);
    if (!branchId) throw new AppError(400, 'BRANCH_REQUIRED', 'Debe indicar una sucursal autorizada.');
-   assertBranchAccess(req, branchId);
+   assertPermissionAtLocation(req, PRODUCTION_PERMISSIONS.SALE_CREATE, branchId);
    ...
  }
```

```ts
// api/src/modules/sales/sales.service.ts (ensureSaleAccess — diff)
- import { assertBranchAccess } from '../../middleware/authorization.js';
+ import { assertPermissionAtLocation } from '../../middleware/authorization.js';
  function ensureSaleAccess(req, sale) {
-   assertBranchAccess(req, sale.branchId);
+   assertPermissionAtLocation(req, PRODUCTION_PERMISSIONS.SALE_VIEW, sale.branchId);
    if (sale.sellerId !== req.userId) throw ...
  }
```

```ts
// api/src/modules/sales/sales.service.ts (completeSaleInTransaction's inline check — diff; note this line already reads
// .effectiveLocationIds by this point, per Task 1D.1.6's exhaustive rename — this converts it from a bare array
// check to the permission-paired policy call)
  import { hasPermissionAtLocation } from '../rbac/authorization-policy.js';
- if (!req.auth?.effectiveLocationIds.includes(sale.branchId)) throw forbidden();
+ if (!req.auth || !hasPermissionAtLocation(req.auth, 'SALE_COMPLETE', sale.branchId)) throw forbidden();
```

```ts
// api/src/modules/sales/cancellation.controller.ts (diff — pass req.auth through instead of a constructed scope object)
- const result = await service.cancelSale(String(req.params.saleId), { userId: req.auth!.userId, branchIds: req.auth!.effectiveLocationIds });
+ const result = await service.cancelSale(req, String(req.params.saleId));
```

```ts
// api/src/modules/sales/cancellation.service.ts (branchAssignment, called from cancelSale — diff)
- if (!scope.branchIds.includes(branchId)) throw forbidden();
+ assertPermissionAtLocation(req, PRODUCTION_PERMISSIONS.SALE_CREATE, branchId); // cancel route is gated on SALE_CREATE, matches cancellation.routes.ts
// cancelSale's signature changes from (saleId, scope: AuthScope) to (req, saleId) accordingly — releaseExpiredReservations
// keeps its existing (scope: AuthScope) signature and bulk-filters via scope.effectiveLocationIds (renamed in Task
// 1D.1.6, unchanged here — it is a listing filter, not a permission-paired decision, per Cross-cutting §C.1).
```

- [ ] **Step 5: Run**

Run: `cd api && npx vitest run tests/sales tests/auth --reporter=verbose && npx tsc --noEmit`
Expected: all PASS, including the rejection test and both e2e OWNER/ADMIN tests.

- [ ] **Step 6: Commit**

```bash
git add api/src/modules/sales api/tests/sales api/tests/auth/login-scope-switch.test.ts
git commit -m "feat(sales): switch to Production permissions and pair manual rechecks with the route's own permission (Phase 1D.3)"
```

### Task 1D.3.2: `payments.routes.ts` + `payments.service.ts`

**Files:**
- Modify: `api/src/modules/payments/payments.routes.ts`, `api/src/modules/payments/payments.service.ts` (`assertCurrentBranch`, `listPayments`'s `assertBranchAccess`)
- Test: extend `api/tests/payments/*.test.ts` with Production-grant + legacy-rejection pairs (same shape as Task 1D.3.1 Step 1), plus a converted-recheck proof.

| Route | Before | After | Manual recheck converted to |
|---|---|---|---|
| `POST /:saleId/payments` | `requireLegacyPermission(PERMISSIONS.SALE_CHARGE)` | `requirePermission(PRODUCTION_PERMISSIONS.SALE_CHARGE)` | `assertPermissionAtLocation(req, SALE_CHARGE, branchId)` in `assertCurrentBranch` |
| `GET /:saleId/payments` | `requireLegacyPermission(PERMISSIONS.SALE_VIEW)` | `requirePermission(PRODUCTION_PERMISSIONS.SALE_VIEW)` | `listPayments`'s `assertBranchAccess` → `assertPermissionAtLocation(req, SALE_VIEW, branchId)` |

- [ ] **Steps 1–6:** same structure as Task 1D.3.1 (write Production-grant + legacy-rejection tests, confirm they fail, apply the route swap, convert both manual rechecks, run, commit).

```bash
git add api/src/modules/payments api/tests/payments
git commit -m "feat(payments): switch to Production permissions and pair manual rechecks (Phase 1D.3)"
```

### Task 1D.3.3: `cash.routes.ts` + `cash.service.ts` + `cash.controller.ts`

**Correction to the prior revision:** `cash.controller.ts` does not call `assertBranchAccess(req, ...)` at all — it passes a **bare `branchIds` array** positionally into every `cash.service.ts` function (`getRegister(branchId, branchIds)`, `getCurrentSession(branchId, branchIds)`, `openSession(registerId, userId, branchIds, startingCash)`, `closeSession(sessionId, userId, branchIds, closingCash)`), which then do their own inline `.includes()` checks. There is no `req` object available inside `cash.service.ts` to call `assertPermissionAtLocation(req, ...)` with. This task therefore changes the **controller-to-service call signature**, not just the route constant.

**Files:**
- Modify: `api/src/modules/cash/cash.routes.ts` (route constant swap, open/close only)
- Modify: `api/src/modules/cash/cash.controller.ts` (all 4 handlers: pass `req.auth` instead of `req.auth!.branchIds`/`.effectiveLocationIds`)
- Modify: `api/src/modules/cash/cash.service.ts` (`getRegister`/`getCurrentSession`/`openSession`/`closeSession` signatures change from `(..., branchIds: string[], ...)` to `(..., ctx: Express.AuthContext, ...)`)

| Route | Before | After | Internal check |
|---|---|---|---|
| `POST /sessions/open` | `requireLegacyPermission(PERMISSIONS.CASH_SESSION_OPEN)` | `requirePermission(PRODUCTION_PERMISSIONS.CASH_SESSION_OPEN)` | `openSession` now calls `hasPermissionAtLocation(ctx, 'CASH_SESSION_OPEN', branchId)`, throws `forbidden()` if false |
| `POST /sessions/:sessionId/close` | `requireLegacyPermission(PERMISSIONS.CASH_SESSION_CLOSE)` | `requirePermission(PRODUCTION_PERMISSIONS.CASH_SESSION_CLOSE)` | `closeSession` now calls `hasPermissionAtLocation(ctx, 'CASH_SESSION_CLOSE', branchId)`, throws `forbidden()` if false |
| `GET /register`, `GET /current` | *(no permission gate — unchanged, Task 1D.5.3's firm decision)* | *(unchanged)* | `getRegister`/`getCurrentSession` now call `hasBranchAccess(ctx, branchId)` instead of their own inline `.includes()` on a bare array — **no behavior change for any non-OWNER caller**, but this routes the check through the centralized policy so OWNER's implicit authority (and a COMPANY assignment) is honored here too, rather than being scattered as a bespoke array check that bypasses `authorization-policy.ts` entirely |

```ts
// api/src/modules/cash/cash.controller.ts (diff, all 4 handlers)
- sendJson(res, await service.getRegister(String(req.query.branchId), req.auth!.branchIds));
+ sendJson(res, await service.getRegister(String(req.query.branchId), req.auth!));
- sendJson(res, await service.getCurrentSession(String(req.query.branchId), req.auth!.branchIds));
+ sendJson(res, await service.getCurrentSession(String(req.query.branchId), req.auth!));
- sendJson(res.status(201), await service.openSession(req.body.registerId, req.auth!.userId, req.auth!.branchIds, req.body.startingCash));
+ sendJson(res.status(201), await service.openSession(req.body.registerId, req.auth!, req.body.startingCash));
- sendJson(res, await service.closeSession(String(req.params.sessionId), req.auth!.userId, req.auth!.branchIds, req.body.closingCash));
+ sendJson(res, await service.closeSession(String(req.params.sessionId), req.auth!, req.body.closingCash));
```

```ts
// api/src/modules/cash/cash.service.ts (diff, illustrative — signatures now take ctx instead of userId+branchIds separately)
import { hasBranchAccess, hasPermissionAtLocation } from '../rbac/authorization-policy.js';
import { forbidden } from '../../middleware/authorization.js'; // or a local AppError(403,...) — match existing error-construction convention in this file

async function getRegister(branchId: string, ctx: Express.AuthContext) {
  if (!hasBranchAccess(ctx, branchId)) throw forbidden();
  // ...unchanged query logic...
}

async function openSession(registerId: string, ctx: Express.AuthContext, startingCash: bigint) {
  const register = await database.cashRegister.findUniqueOrThrow({ where: { id: registerId } });
  if (!hasPermissionAtLocation(ctx, 'CASH_SESSION_OPEN', register.branchId)) throw forbidden();
  // ...unchanged open logic, ctx.userId replaces the old separate userId parameter...
}
```

- [ ] **Steps 1–6:** write the Production-grant + legacy-rejection tests for open/close (same pattern as prior tasks), confirm they fail, apply the diffs above, run, commit. The existing `it.each(['CASHIER', 'MANAGER', 'ADMIN'])`/`'allows explicit permissions independently of role names'` tests need no change (they operate via `revoke(code)` on explicit `Permission.code` literals, orthogonal to this signature change).

```bash
git add api/src/modules/cash api/tests/cash
git commit -m "feat(cash): switch session open/close to Production permissions, route all cash checks through the centralized policy (Phase 1D.3)"
```

### Task 1D.3.4: `inventory.routes.ts` + `products.routes.ts` (+ `products.service.ts`)

**Files:**
- Modify: `api/src/modules/inventory/inventory.routes.ts` (no manual recheck to convert — `resolveResourceBranch` already routes through `requirePermission`, fixed centrally in Task 1D.2.4)
- Modify: `api/src/modules/products/products.routes.ts`, `api/src/modules/products/products.service.ts` (`listVariants`'s `if (branchId) assertBranchAccess(req, branchId)`)

| File | Route | Before | After |
|---|---|---|---|
| `inventory.routes.ts` | `GET /`, `GET /availability` | `requireLegacyPermission(PERMISSIONS.INVENTORY_VIEW)` | `requirePermission(PRODUCTION_PERMISSIONS.INVENTORY_VIEW)` |
| `products.routes.ts` (both routers) | `GET /`, `GET /:id` | `requireLegacyPermission(PERMISSIONS.INVENTORY_VIEW)` | `requirePermission(PRODUCTION_PERMISSIONS.INVENTORY_VIEW, { branchScope: 'global' })` |

```ts
// api/src/modules/products/products.service.ts (listVariants — diff)
- if (branchId) assertBranchAccess(req, branchId);
+ if (branchId) assertPermissionAtLocation(req, PRODUCTION_PERMISSIONS.INVENTORY_VIEW, branchId);
```

- [ ] **Steps 1–6:** same structure.

```bash
git add api/src/modules/inventory api/src/modules/products api/tests/inventory api/tests/products
git commit -m "feat(inventory,products): switch to Production permissions and pair the manual recheck (Phase 1D.3)"
```

### Task 1D.3.5: `backoffice.routes.ts` + `audit.routes.ts` (+ `backoffice.service.ts`)

**Files:**
- Modify: `api/src/modules/backoffice/backoffice.routes.ts`, `api/src/modules/backoffice/backoffice.service.ts` (`getSale`'s `assertBranchAccess`)
- Modify: `api/src/modules/audit/audit.routes.ts`

| File | Route | Before | After |
|---|---|---|---|
| `backoffice.routes.ts` | `/dashboard`, `/sales`, `/sales/:id`, `/inventory`, `/branches` | `requireLegacyPermission(PERMISSIONS.REPORT_VIEW)` | `requirePermission(PRODUCTION_PERMISSIONS.REPORT_VIEW)` |
| `backoffice.routes.ts` | `/users` | `requireLegacyPermission(PERMISSIONS.USER_MANAGE)` | `requirePermission(PRODUCTION_PERMISSIONS.USER_MANAGE)` |
| `audit.routes.ts` | `GET /` | `requireLegacyPermission(PERMISSIONS.AUDIT_VIEW)` | `requirePermission(PRODUCTION_PERMISSIONS.AUDIT_VIEW)` |

```ts
// api/src/modules/backoffice/backoffice.service.ts (getSale — diff)
- assertBranchAccess(req, sale.branchId);
+ assertPermissionAtLocation(req, PRODUCTION_PERMISSIONS.REPORT_VIEW, sale.branchId);
```

`scopeBranches()` (used by `dashboard`/`listSales`/`inventory`/`branches`) stays on `req.auth.effectiveLocationIds` for its no-specific-permission "list everything I can see" case — those routes are already `branchScope: 'global'` at the route level (`REPORT_VIEW` gates the whole endpoint, not a specific resource), so there is no single resource permission to pair per-row here; this is a legitimate, reviewed use of the display-only convenience field for filtering, not an authorization decision.

- [ ] **Steps 1–6:** same structure.

```bash
git add api/src/modules/backoffice api/src/modules/audit api/tests/backoffice api/tests/audit
git commit -m "feat(backoffice,audit): switch to Production permissions and pair the manual recheck (Phase 1D.3)"
```

### Task 1D.3.6: delete `requireLegacyPermission` and `legacyPermissions` entirely (REMOVE the read, not the table)

**Files:**
- Modify: `api/src/modules/rbac/authorization-context.ts` (delete `legacyPermissions` field and its computation)
- Modify: `api/src/middleware/authorization.ts` (delete `requireLegacyPermission`)
- Modify: `api/src/types/express.d.ts` (remove `legacyPermissions` from `AuthContext`)
- Modify: every test file that still exercises a legacy-only grant via a now-deleted code path (should be none by this point — Tasks 1D.3.1–1D.3.5 already added explicit legacy-rejection tests per route).

- [ ] **Step 1: Verify no route still imports `requireLegacyPermission`**

Run: `cd api && grep -rn "requireLegacyPermission" src/modules`
Expected: zero hits outside `middleware/authorization.ts` itself. If any hit remains, that route was missed in Tasks 1D.3.1–1D.3.5 — fix it there, not here.

- [ ] **Step 2: Delete the function and the field**

```ts
// api/src/middleware/authorization.ts — delete requireLegacyPermission and its `Permission` import entirely.
```

```ts
// api/src/modules/rbac/authorization-context.ts — delete legacyPermissions computation and LEGACY_PERMISSION_CODES,
// and its import of permissionValues from shared/permissions.js. branchRoles stays (still feeds `roles` display union).
```

```ts
// api/src/types/express.d.ts — remove legacyPermissions from AuthContext.
```

- [ ] **Step 3: Run the full Phase 1D.3 regression gate**

```bash
cd api
NODE_ENV=test npx vitest run tests/rbac tests/auth tests/realtime tests/sales tests/payments tests/cash tests/inventory tests/products tests/backoffice tests/audit --reporter=verbose
npx tsc --noEmit
npm run lint
```
Expected: every Production-grant test PASS; every legacy-only-grant test (added per-route in Tasks 1D.3.1–1D.3.5) PASS as a rejection; `tsc` fails loudly if any file still references the deleted symbols, which is the point.

- [ ] **Step 4: Commit**

```bash
git add api/src/modules/rbac/authorization-context.ts api/src/middleware/authorization.ts api/src/types/express.d.ts
git commit -m "feat(rbac): delete requireLegacyPermission/legacyPermissions, Production switch complete (Phase 1D.3.6)"
```

**Exit criteria:** every route checks a `PRODUCTION_PERMISSIONS.*` constant via `requirePermission`; every manual service-level recheck that was standing in for a permission decision now pairs that same permission with the location via `assertPermissionAtLocation`; `requireLegacyPermission`/`legacyPermissions` no longer exist as code (the underlying `UserBranchRole`/legacy `Permission` rows remain, untouched, per the Global Constraints); a legacy-lowercase-only grant authorizes nothing anywhere.

**Commit boundary:** 6 commits (5 route-group switches-with-recheck-conversion, then the final deletion).

**Risk: HIGH** — Task 1D.3.6 is the one place this plan removes rather than adds a code path; MEDIUM for the per-route tasks, since each now also converts a manual recheck, not just a route constant.

---

## PHASE 1D.4 — User / Scope Management

**Objective:** give OWNER/ADMIN a real endpoint to assign, reassign, and revoke **individual `(user, roleCode)` assignments** — never a whole-profile replace — so a user's independent assignments (e.g. `SELLER @ A` and `WAREHOUSE @ B`) can be managed separately without disturbing each other; correct existing ADMIN users' Phase-1C-backfilled `LOCATION` rows to a single `COMPANY` assignment; seed a canonical OWNER user (bootstrap-only, never self-service); fix `backoffice/users` to report live `UserRoleScope` assignments.

**Invariants preserved (per the correction, restated as hard invariants):**
- The frozen ERD permits multiple `UserRoleScope` rows per user — this plan never collapses them or enforces one role per user. Reassigning a user's `WAREHOUSE @ B` assignment never touches their separate `SELLER @ A` assignment.
- Self-modification of `UserRoleScope` is denied for **every** actor, including OWNER, unconditionally.
- ADMIN can never manage an OWNER's scope in any way — not "cannot escalate," not "cannot grant OWNER-role," but cannot assign, reassign, or revoke **any** assignment belonging to a user who currently holds, or is being given, the OWNER role.
- OWNER's own assignment is provisioned only by seed/bootstrap tooling (Task 1D.4.2) — the HTTP endpoint structurally cannot create the first OWNER, since it can never target the caller themselves and an ADMIN can never grant OWNER to anyone else.

**Exact files expected to change:**
- Create: `api/src/modules/backoffice/scope-assignment.dto.ts`
- Create: `api/src/modules/backoffice/scope-assignment.service.ts`
- Create: `api/tests/backoffice/scope-assignment.test.ts`
- Create: `api/tests/rbac/privilege-escalation.test.ts`
- Modify: `api/src/modules/backoffice/backoffice.controller.ts`
- Modify: `api/src/modules/backoffice/backoffice.routes.ts`
- Modify: `api/src/modules/backoffice/backoffice.service.ts` (`users()`)
- Modify: `api/tests/backoffice/backoffice.test.ts`
- Create: `api/src/modules/rbac/admin-company-backfill.service.ts`
- Create: `api/tests/rbac/admin-company-backfill.test.ts`
- Create: `api/scripts/backfill-admin-company-scope.ts`
- Modify: `api/package.json`
- Modify: `api/prisma/seed.ts` (canonical OWNER seed user)

**Dependencies:** Phase 1D.3 complete (this phase's route uses `PRODUCTION_PERMISSIONS.USER_MANAGE` from the start).

**Security checks:** ADMIN cannot assign `roleCode: 'OWNER'` to anyone; ADMIN cannot reassign or revoke any assignment belonging to a user who holds OWNER; no caller can assign/reassign/revoke their own assignment (OWNER included); `roleCode: 'CASHIER'|'SELLER'|'WAREHOUSE'` is rejected with `scopeKind: 'COMPANY'`; `roleCode: 'ADMIN'|'OWNER'` is rejected with `scopeKind: 'LOCATION'`; reassigning one `(user, roleCode)` assignment leaves every other independent assignment for that user completely untouched — the direct test for the correction's own example (`SELLER @ A` survives a `WAREHOUSE @ B` reassignment); a non-OWNER/ADMIN caller gets `403` before any service-layer guard runs; revoke targets one `roleCode` at a time, never the user's entire assignment set.

**Rollback/safety considerations:** the assignment/revoke service always operates inside a single `$transaction`, scoped to exactly one `(userId, roleId)` pair — never a broader delete; the ADMIN→COMPANY backfill script is idempotent and re-runnable; it is never auto-executed against DEV.

### Task 1D.4.1: ADMIN → COMPANY one-time scope correction

**Files:**
- Create: `api/src/modules/rbac/admin-company-backfill.service.ts`
- Create: `api/tests/rbac/admin-company-backfill.test.ts`
- Create: `api/scripts/backfill-admin-company-scope.ts`
- Modify: `api/package.json`

**Interfaces:**
- Produces: `backfillAdminCompanyScope(db): Promise<{ usersConverted: number }>` — CLI-invoked only, never called from a request path.

- [ ] **Step 1: Write the failing tests**

```ts
// api/tests/rbac/admin-company-backfill.test.ts
import { describe, expect, it, beforeAll, beforeEach, afterAll } from 'vitest';
import { createTestPrismaClient, truncateAllTables } from '../helpers/test-db.js';
import { createBranch, createTestUser, ensureTestLocation } from '../helpers/factories.js';
import { bootstrapProductionRbacCatalog } from '../../src/modules/rbac/catalog.service.js';
import { backfillAdminCompanyScope } from '../../src/modules/rbac/admin-company-backfill.service.js';

describe('backfillAdminCompanyScope (Phase 1D.4)', () => {
  let db: Awaited<ReturnType<typeof createTestPrismaClient>>;
  beforeAll(async () => { db = await createTestPrismaClient(); });
  beforeEach(async () => { await truncateAllTables(db); await bootstrapProductionRbacCatalog(db); });
  afterAll(async () => db.$disconnect());

  it('converts an ADMIN user\'s LOCATION UserRoleScope rows into a single COMPANY assignment', async () => {
    const adminRole = await db.role.findUniqueOrThrow({ where: { code: 'ADMIN' } });
    const branchA = await createBranch(db);
    const branchB = await createBranch(db);
    const admin = await createTestUser(db, adminRole.id, branchA.id);
    await ensureTestLocation(db, branchB.id);
    await db.userRoleScope.create({ data: { userId: admin.id, roleId: adminRole.id, scopeKind: 'LOCATION', locationId: branchB.id } });
    expect(await db.userRoleScope.count({ where: { userId: admin.id } })).toBe(2);

    const result = await backfillAdminCompanyScope(db);
    expect(result.usersConverted).toBe(1);
    const rows = await db.userRoleScope.findMany({ where: { userId: admin.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ scopeKind: 'COMPANY', locationId: null });
  });

  it('never touches a co-existing, independent assignment for a different role on the same user', async () => {
    const adminRole = await db.role.findUniqueOrThrow({ where: { code: 'ADMIN' } });
    const cashierRole = await db.role.findUniqueOrThrow({ where: { code: 'CASHIER' } });
    const branch = await createBranch(db);
    const user = await createTestUser(db, adminRole.id, branch.id);
    await db.userRoleScope.create({ data: { userId: user.id, roleId: cashierRole.id, scopeKind: 'LOCATION', locationId: branch.id } }); // an independent CASHIER assignment for the same user
    await backfillAdminCompanyScope(db);
    const cashierRows = await db.userRoleScope.findMany({ where: { userId: user.id, roleId: cashierRole.id } });
    expect(cashierRows).toHaveLength(1);
    expect(cashierRows[0]!.scopeKind).toBe('LOCATION'); // untouched
  });

  it('is idempotent', async () => {
    const adminRole = await db.role.findUniqueOrThrow({ where: { code: 'ADMIN' } });
    const branch = await createBranch(db);
    const admin = await createTestUser(db, adminRole.id, branch.id);
    await backfillAdminCompanyScope(db);
    const second = await backfillAdminCompanyScope(db);
    expect(second.usersConverted).toBe(0);
  });

  it('never touches CASHIER/SELLER/WAREHOUSE LOCATION rows', async () => {
    const cashierRole = await db.role.findUniqueOrThrow({ where: { code: 'CASHIER' } });
    const branch = await createBranch(db);
    const cashier = await createTestUser(db, cashierRole.id, branch.id);
    await backfillAdminCompanyScope(db);
    const rows = await db.userRoleScope.findMany({ where: { userId: cashier.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.scopeKind).toBe('LOCATION');
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — module does not exist.

- [ ] **Step 3: Write the implementation**

```ts
// api/src/modules/rbac/admin-company-backfill.service.ts
import type { PrismaClient } from '../../generated/prisma/client.js';
import { ROLE_CODES } from './roles.js';

type Database = Pick<PrismaClient, 'role' | 'userRoleScope' | '$transaction'>;
export type AdminCompanyBackfillResult = { usersConverted: number };

// Phase 1D.4 one-time data correction (AGENTS.md's Checkpoint, this plan's
// Business-model correction section). Scoped to exactly the ADMIN
// (userId, roleId) pair per user — never touches any other role's
// independent assignment for the same user, per this plan's Global
// Constraints ("no one-role-per-user").
export async function backfillAdminCompanyScope(db: Database): Promise<AdminCompanyBackfillResult> {
  const adminRole = await db.role.findUnique({ where: { code: ROLE_CODES.ADMIN } });
  if (!adminRole) throw new Error('Production ADMIN Role does not exist; run the Phase 1B RBAC catalog bootstrap first');

  const adminUserIds = [
    ...new Set(
      (await db.userRoleScope.findMany({ where: { roleId: adminRole.id, scopeKind: 'LOCATION' }, select: { userId: true } })).map((row) => row.userId),
    ),
  ];
  let usersConverted = 0;
  for (const userId of adminUserIds) {
    await db.$transaction(async (tx) => {
      // Scoped to (userId, adminRole.id) ONLY — an unrelated assignment for
      // the same user under a different roleId is never touched.
      await tx.userRoleScope.deleteMany({ where: { userId, roleId: adminRole.id } });
      await tx.userRoleScope.create({ data: { userId, roleId: adminRole.id, scopeKind: 'COMPANY', locationId: null } });
    });
    usersConverted += 1;
  }
  return { usersConverted };
}
```

- [ ] **Step 4: Run** — all 4 PASS.

- [ ] **Step 5: Add the CLI wrapper and package.json entry**

```ts
// api/scripts/backfill-admin-company-scope.ts
import { openSeedDatabase } from './demo-database.js';
import { backfillAdminCompanyScope } from '../src/modules/rbac/admin-company-backfill.service.js';

type Target = 'demo' | 'test';
function parseTarget(argv: string[]): Target | null {
  const arg = argv.find((a) => a.startsWith('--target='));
  const value = arg?.split('=')[1];
  return value === 'demo' || value === 'test' ? value : null;
}

const target = parseTarget(process.argv.slice(2));
if (!target) {
  console.error('[db:backfill-admin-company-scope] FAIL: --target=demo or --target=test is required');
  process.exitCode = 1;
} else {
  try {
    const db = await openSeedDatabase(target);
    try {
      const result = await backfillAdminCompanyScope(db.prisma);
      console.log('[db:backfill-admin-company-scope] OK');
      console.log(`  target: ${target}`);
      console.log(`  ADMIN users converted to COMPANY scope: ${result.usersConverted}`);
    } finally {
      await db.close();
    }
  } catch (err) {
    console.error(`[db:backfill-admin-company-scope] FAIL: ${err instanceof Error ? err.message : 'unknown error'}`);
    process.exitCode = 1;
  }
}
```

```json
"db:backfill-admin-company-scope": "tsx scripts/backfill-admin-company-scope.ts",
```

- [ ] **Step 6: Commit**

```bash
git add api/src/modules/rbac/admin-company-backfill.service.ts api/tests/rbac/admin-company-backfill.test.ts api/scripts/backfill-admin-company-scope.ts api/package.json
git commit -m "feat(rbac): add ADMIN LOCATION->COMPANY one-time scope backfill, scoped per-assignment (Phase 1D.4)"
```

**Note — do not run this script against DEV or TEST as part of this plan.** Invoking it against either shared database is a separate, explicit, human-approved action outside this document's scope, per the Global Constraints.

### Task 1D.4.2: canonical OWNER seed user (bootstrap-only, never self-service)

**Files:**
- Modify: `api/prisma/seed.ts`

- [ ] **Step 1: Write the failing test**

Add to `api/tests/rbac/seed-integration.test.ts` (inspect its existing `beforeAll`/`describe` structure before writing this step, to match exactly):

```ts
it('seeds a canonical OWNER user with exactly one COMPANY UserRoleScope assignment and zero legacy UserBranchRole rows', async () => {
  const owner = await db.prisma.user.findUniqueOrThrow({ where: { email: 'owner01@demo.local' } });
  const ownerRole = await db.prisma.role.findUniqueOrThrow({ where: { code: 'OWNER' } });
  const scopes = await db.prisma.userRoleScope.findMany({ where: { userId: owner.id } });
  expect(scopes).toHaveLength(1);
  expect(scopes[0]).toMatchObject({ roleId: ownerRole.id, scopeKind: 'COMPANY', locationId: null });
  expect(await db.prisma.userBranchRole.count({ where: { userId: owner.id } })).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails** — no `owner01@demo.local` user exists yet.

- [ ] **Step 3: Extend `prisma/seed.ts`'s `populate()`**

```ts
// prisma/seed.ts (inside populate(), after the RBAC catalog + scope backfill sync calls already present — match the surrounding block's exact tx/hash-helper names before writing this edit)
const ownerRole = await tx.role.findUniqueOrThrow({ where: { code: 'OWNER' } });
const owner = await tx.user.upsert({
  where: { email: 'owner01@demo.local' },
  create: { name: 'Owner Demo', email: 'owner01@demo.local', passwordHash: await hashPassword('demo123') },
  update: {},
});
await tx.userRoleScope.deleteMany({ where: { userId: owner.id } });
await tx.userRoleScope.create({ data: { userId: owner.id, roleId: ownerRole.id, scopeKind: 'COMPANY', locationId: null } });
// Deliberately no UserBranchRole row — OWNER never existed as a legacy role
// code, and this is the ONLY place OWNER's assignment is ever provisioned
// (bootstrap/seed), never through the self-service scope-assignment
// endpoint (Task 1D.4.3 structurally cannot create it — self-modification
// is denied and no other caller may grant OWNER).
```

- [ ] **Step 4: Run** — `cd api && npx vitest run tests/rbac/seed-integration.test.ts tests/rbac/scope-seed-integration.test.ts --reporter=verbose` — PASS (adjust any exact-row-count assertion in the second file by +1 `UserRoleScope` if it counts totals; the `UserBranchRole` total is unaffected since OWNER gets none).

- [ ] **Step 5: Commit**

```bash
git add api/prisma/seed.ts api/tests/rbac/seed-integration.test.ts
git commit -m "feat(seed): add canonical OWNER demo user, bootstrap-only provisioning (Phase 1D.4)"
```

### Task 1D.4.3: `scope-assignment` DTO + service — per-`(user, roleCode)` assignment operations

**Files:**
- Create: `api/src/modules/backoffice/scope-assignment.dto.ts`
- Create: `api/src/modules/backoffice/scope-assignment.service.ts`
- Test: `api/tests/backoffice/scope-assignment.test.ts` (Part 1 — service-level guards).

**Interfaces:**
- Consumes: `isOwner` (Task 1D.2.3).
- Produces: `assignScopeDto`, `userIdParamsDto`, `roleCodeParamsDto`, `AssignScopeInput`; `createScopeAssignmentService(database).assign(req, targetUserId, input)` / `.revoke(req, targetUserId, roleCode)` — the revoke signature now takes `roleCode`, matching the per-assignment model.

- [ ] **Step 1: Write the failing tests**

```ts
// api/tests/backoffice/scope-assignment.test.ts (Part 1)
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { createTestPrismaClient, truncateAllTables } from '../helpers/test-db.js';
import { createBranch, createTestUser, ensureTestLocation } from '../helpers/factories.js';
import { bootstrapProductionRbacCatalog } from '../../src/modules/rbac/catalog.service.js';
import { createScopeAssignmentService } from '../../src/modules/backoffice/scope-assignment.service.js';

describe('scope-assignment.service (Phase 1D.4)', () => {
  let db: Awaited<ReturnType<typeof createTestPrismaClient>>;
  let service: ReturnType<typeof createScopeAssignmentService>;
  beforeAll(async () => { db = await createTestPrismaClient(); service = createScopeAssignmentService(db); });
  beforeEach(async () => { await truncateAllTables(db); await bootstrapProductionRbacCatalog(db); });
  afterAll(async () => db.$disconnect());

  function authAs(userId: string, assignments: Express.AuthContext['assignments']): { auth: Express.AuthContext } {
    return { auth: { userId, roles: assignments.map((a) => a.roleCode), legacyPermissions: [], assignments, effectiveLocationIds: [] } };
  }
  const adminCtx = (userId: string) => authAs(userId, [{ roleId: 'r', roleCode: 'ADMIN', scopeKind: 'COMPANY', locationId: null, permissions: [] }]);

  it('rejects an ADMIN caller assigning roleCode OWNER to anyone', async () => {
    const branch = await createBranch(db);
    const admin = await createTestUser(db, (await db.role.findUniqueOrThrow({ where: { code: 'ADMIN' } })).id, branch.id);
    const target = await createTestUser(db, (await db.role.findUniqueOrThrow({ where: { code: 'CASHIER' } })).id, branch.id);
    await expect(service.assign(adminCtx(admin.id), target.id, { roleCode: 'OWNER', scopeKind: 'COMPANY' })).rejects.toThrow(/Sólo OWNER puede asignar el rol OWNER/);
  });

  it('rejects an ADMIN caller assigning/revoking ANY role for a user who currently holds OWNER', async () => {
    const branch = await createBranch(db);
    const admin = await createTestUser(db, (await db.role.findUniqueOrThrow({ where: { code: 'ADMIN' } })).id, branch.id);
    const ownerRole = await db.role.findUniqueOrThrow({ where: { code: 'OWNER' } });
    const owner = await db.user.create({ data: { name: 'o', email: 'o1@test.local', passwordHash: 'x' } });
    await db.userRoleScope.create({ data: { userId: owner.id, roleId: ownerRole.id, scopeKind: 'COMPANY', locationId: null } });
    await expect(service.assign(adminCtx(admin.id), owner.id, { roleCode: 'ADMIN', scopeKind: 'COMPANY' })).rejects.toThrow(/Sólo OWNER puede modificar el alcance de otro OWNER/);
    await expect(service.revoke(adminCtx(admin.id), owner.id, 'OWNER')).rejects.toThrow(/Sólo OWNER puede modificar el alcance de otro OWNER/);
  });

  it('REQUIRED BY CORRECTION (item 5): the first concrete OWNER-only privilege boundary — ADMIN -> manage OWNER = denied (above), OWNER -> manage an eligible (non-OWNER) subject = allowed', async () => {
    const branch = await createBranch(db);
    const ownerRole = await db.role.findUniqueOrThrow({ where: { code: 'OWNER' } });
    const owner = await db.user.create({ data: { name: 'owner-caller', email: 'owner-caller@test.local', passwordHash: 'x' } });
    await db.userRoleScope.create({ data: { userId: owner.id, roleId: ownerRole.id, scopeKind: 'COMPANY', locationId: null } });
    const ownerCtx = authAs(owner.id, [{ roleId: ownerRole.id, roleCode: 'OWNER', scopeKind: 'COMPANY', locationId: null, permissions: [] }]);
    const target = await createTestUser(db, (await db.role.findUniqueOrThrow({ where: { code: 'CASHIER' } })).id, branch.id);

    // Deliberately not a fabricated business endpoint — this IS the first
    // real, concrete OWNER-only privilege boundary the codebase has (Phase
    // 1E can broaden to a real business action once one exists, per this
    // plan's Deliverable F).
    const result = await service.assign(ownerCtx, target.id, { roleCode: 'ADMIN', scopeKind: 'COMPANY' });
    expect(result).toMatchObject({ userId: target.id, roleCode: 'ADMIN', scopeKind: 'COMPANY' });
    const rows = await db.userRoleScope.findMany({ where: { userId: target.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ scopeKind: 'COMPANY', locationId: null });
  });

  it('rejects any caller, OWNER included, assigning/revoking their own assignment', async () => {
    const branch = await createBranch(db);
    const admin = await createTestUser(db, (await db.role.findUniqueOrThrow({ where: { code: 'ADMIN' } })).id, branch.id);
    await expect(service.assign(adminCtx(admin.id), admin.id, { roleCode: 'ADMIN', scopeKind: 'COMPANY' })).rejects.toThrow(/No puede modificar su propio alcance/);
    await expect(service.revoke(adminCtx(admin.id), admin.id, 'ADMIN')).rejects.toThrow(/No puede modificar su propio alcance/);
  });

  it.each(['CASHIER', 'SELLER', 'WAREHOUSE'])('rejects scopeKind COMPANY for roleCode %s', async (roleCode) => {
    const branch = await createBranch(db);
    const admin = await createTestUser(db, (await db.role.findUniqueOrThrow({ where: { code: 'ADMIN' } })).id, branch.id);
    const target = await createTestUser(db, (await db.role.findUniqueOrThrow({ where: { code: 'CASHIER' } })).id, branch.id);
    await expect(service.assign(adminCtx(admin.id), target.id, { roleCode: roleCode as never, scopeKind: 'COMPANY' })).rejects.toThrow(new RegExp(`El rol ${roleCode} requiere alcance LOCATION`));
  });

  it.each(['ADMIN', 'OWNER'])('rejects scopeKind LOCATION for roleCode %s', async (roleCode) => {
    const branch = await createBranch(db);
    await ensureTestLocation(db, branch.id);
    const admin = await createTestUser(db, (await db.role.findUniqueOrThrow({ where: { code: 'ADMIN' } })).id, branch.id);
    const target = await createTestUser(db, (await db.role.findUniqueOrThrow({ where: { code: 'CASHIER' } })).id, branch.id);
    await expect(
      service.assign(adminCtx(admin.id), target.id, { roleCode: roleCode as never, scopeKind: 'LOCATION', locationIds: [branch.id] } as never),
    ).rejects.toThrow(new RegExp(`El rol ${roleCode} requiere alcance COMPANY`));
  });

  it('reassigning one (user, roleCode) assignment never disturbs an independent assignment for a different role on the same user — the correction\'s own example', async () => {
    const branchA = await createBranch(db);
    const branchB = await createBranch(db);
    await ensureTestLocation(db, branchB.id);
    const admin = await createTestUser(db, (await db.role.findUniqueOrThrow({ where: { code: 'ADMIN' } })).id, branchA.id);
    const sellerRole = await db.role.findUniqueOrThrow({ where: { code: 'SELLER' } });
    const warehouseRole = await db.role.findUniqueOrThrow({ where: { code: 'WAREHOUSE' } });
    const user = await db.user.create({ data: { name: 'multi', email: 'multi2@test.local', passwordHash: 'x' } });
    await db.userRoleScope.create({ data: { userId: user.id, roleId: sellerRole.id, scopeKind: 'LOCATION', locationId: branchA.id } });
    await db.userRoleScope.create({ data: { userId: user.id, roleId: warehouseRole.id, scopeKind: 'LOCATION', locationId: branchA.id } });

    await service.assign(adminCtx(admin.id), user.id, { roleCode: 'WAREHOUSE', scopeKind: 'LOCATION', locationIds: [branchB.id] });

    const sellerRows = await db.userRoleScope.findMany({ where: { userId: user.id, roleId: sellerRole.id } });
    expect(sellerRows).toHaveLength(1);
    expect(sellerRows[0]!.locationId).toBe(branchA.id); // untouched

    const warehouseRows = await db.userRoleScope.findMany({ where: { userId: user.id, roleId: warehouseRole.id } });
    expect(warehouseRows).toHaveLength(1);
    expect(warehouseRows[0]!.locationId).toBe(branchB.id); // reassigned
  });

  it('revoke targets exactly one roleCode, leaving other assignments intact', async () => {
    const branch = await createBranch(db);
    const admin = await createTestUser(db, (await db.role.findUniqueOrThrow({ where: { code: 'ADMIN' } })).id, branch.id);
    const sellerRole = await db.role.findUniqueOrThrow({ where: { code: 'SELLER' } });
    const warehouseRole = await db.role.findUniqueOrThrow({ where: { code: 'WAREHOUSE' } });
    const user = await db.user.create({ data: { name: 'multi', email: 'multi3@test.local', passwordHash: 'x' } });
    await db.userRoleScope.create({ data: { userId: user.id, roleId: sellerRole.id, scopeKind: 'LOCATION', locationId: branch.id } });
    await db.userRoleScope.create({ data: { userId: user.id, roleId: warehouseRole.id, scopeKind: 'LOCATION', locationId: branch.id } });

    await service.revoke(adminCtx(admin.id), user.id, 'WAREHOUSE');

    expect(await db.userRoleScope.count({ where: { userId: user.id, roleId: warehouseRole.id } })).toBe(0);
    expect(await db.userRoleScope.count({ where: { userId: user.id, roleId: sellerRole.id } })).toBe(1); // untouched
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — neither module exists.

- [ ] **Step 3: Write `scope-assignment.dto.ts`**

```ts
// api/src/modules/backoffice/scope-assignment.dto.ts
import { z } from 'zod';
import { roleCodeValues } from '../rbac/roles.js';

const roleCodeSchema = z.enum(roleCodeValues as [string, ...string[]]);

export const userIdParamsDto = z.object({ userId: z.uuid() }).strict();
export const userRoleParamsDto = z.object({ userId: z.uuid(), roleCode: roleCodeSchema }).strict();

export const assignScopeDto = z.discriminatedUnion('scopeKind', [
  z.object({ roleCode: roleCodeSchema, scopeKind: z.literal('LOCATION'), locationIds: z.array(z.uuid()).min(1) }).strict(),
  z.object({ roleCode: roleCodeSchema, scopeKind: z.literal('COMPANY') }).strict(),
]);

export type AssignScopeInput = z.infer<typeof assignScopeDto>;
```

- [ ] **Step 4: Write `scope-assignment.service.ts`**

```ts
// api/src/modules/backoffice/scope-assignment.service.ts
import type { PrismaClient } from '../../generated/prisma/client.js';
import { AppError } from '../../shared/errors.js';
import { isOwner } from '../rbac/authorization-policy.js';
import { ROLE_CODES, type RoleCode } from '../rbac/roles.js';
import type { AssignScopeInput } from './scope-assignment.dto.js';

type RequestLike = { auth?: Express.AuthContext };
type ScopeAssignmentDatabase = Pick<PrismaClient, 'user' | 'role' | 'userRoleScope' | '$transaction'>;

function forbidden(message: string) {
  return new AppError(403, 'FORBIDDEN', message);
}

async function guardAgainstSelfAndOwnerTarget(
  database: ScopeAssignmentDatabase,
  caller: Express.AuthContext,
  targetUserId: string,
) {
  if (targetUserId === caller.userId) throw forbidden('No puede modificar su propio alcance de autorización.');
  const targetUser = await database.user.findUnique({
    where: { id: targetUserId },
    select: { id: true, roleScopes: { select: { role: { select: { code: true } } } } },
  });
  if (!targetUser) throw new AppError(404, 'NOT_FOUND', 'No se encontró el usuario.');
  const targetIsCurrentlyOwner = targetUser.roleScopes.some((s) => s.role.code === ROLE_CODES.OWNER);
  if (targetIsCurrentlyOwner && !isOwner(caller)) {
    throw forbidden('Sólo OWNER puede modificar el alcance de otro OWNER.');
  }
}

export function createScopeAssignmentService(database: ScopeAssignmentDatabase) {
  // Creates/replaces exactly the (targetUserId, roleCode) assignment — every
  // OTHER assignment this user independently holds (a different roleCode) is
  // never read or written by this function. This is what makes "SELLER @ A
  // survives a WAREHOUSE @ B reassignment" true by construction, not by
  // convention.
  async function assign(req: RequestLike, targetUserId: string, input: AssignScopeInput) {
    const caller = req.auth;
    if (!caller) throw new AppError(401, 'UNAUTHORIZED', 'Se requiere autenticación.');

    if (input.roleCode === ROLE_CODES.OWNER && !isOwner(caller)) {
      throw forbidden('Sólo OWNER puede asignar el rol OWNER.');
    }
    if ((input.roleCode === ROLE_CODES.OWNER || input.roleCode === ROLE_CODES.ADMIN) && input.scopeKind !== 'COMPANY') {
      throw forbidden(`El rol ${input.roleCode} requiere alcance COMPANY.`);
    }
    if (
      (input.roleCode === ROLE_CODES.CASHIER || input.roleCode === ROLE_CODES.SELLER || input.roleCode === ROLE_CODES.WAREHOUSE) &&
      input.scopeKind !== 'LOCATION'
    ) {
      throw forbidden(`El rol ${input.roleCode} requiere alcance LOCATION.`);
    }

    await guardAgainstSelfAndOwnerTarget(database, caller, targetUserId);

    const role = await database.role.findUnique({ where: { code: input.roleCode } });
    if (!role) throw new AppError(500, 'ROLE_NOT_FOUND', `El rol Production ${input.roleCode} no existe en el catálogo.`);

    await database.$transaction(async (tx) => {
      await tx.userRoleScope.deleteMany({ where: { userId: targetUserId, roleId: role.id } }); // scoped to this role ONLY
      if (input.scopeKind === 'COMPANY') {
        await tx.userRoleScope.create({ data: { userId: targetUserId, roleId: role.id, scopeKind: 'COMPANY', locationId: null } });
      } else {
        await tx.userRoleScope.createMany({
          data: input.locationIds.map((locationId) => ({ userId: targetUserId, roleId: role.id, scopeKind: 'LOCATION' as const, locationId })),
        });
      }
    });

    return { userId: targetUserId, roleCode: input.roleCode, scopeKind: input.scopeKind };
  }

  // Revokes exactly the (targetUserId, roleCode) assignment. Any other
  // independent assignment for this user is untouched.
  async function revoke(req: RequestLike, targetUserId: string, roleCode: RoleCode) {
    const caller = req.auth;
    if (!caller) throw new AppError(401, 'UNAUTHORIZED', 'Se requiere autenticación.');
    await guardAgainstSelfAndOwnerTarget(database, caller, targetUserId);
    const role = await database.role.findUnique({ where: { code: roleCode } });
    if (!role) throw new AppError(500, 'ROLE_NOT_FOUND', `El rol Production ${roleCode} no existe en el catálogo.`);
    await database.userRoleScope.deleteMany({ where: { userId: targetUserId, roleId: role.id } });
    return { userId: targetUserId, roleCode, revoked: true };
  }

  return { assign, revoke };
}
```

- [ ] **Step 5: Run** — all PASS.
- [ ] **Step 6: Commit**

```bash
git add api/src/modules/backoffice/scope-assignment.dto.ts api/src/modules/backoffice/scope-assignment.service.ts api/tests/backoffice/scope-assignment.test.ts
git commit -m "feat(backoffice): add per-assignment scope service, ADMIN cannot manage OWNER, no self-modification (Phase 1D.4)"
```

### Task 1D.4.4: wire the HTTP endpoint

**Files:**
- Modify: `api/src/modules/backoffice/backoffice.controller.ts`
- Modify: `api/src/modules/backoffice/backoffice.routes.ts`
- Modify: `api/tests/backoffice/scope-assignment.test.ts` (append Part 2 — HTTP-level)

- [ ] **Step 1: Write the failing HTTP-level tests** (same shape as the DTO/service tests above, over `POST /api/v1/backoffice/users/:userId/scope` and `DELETE /api/v1/backoffice/users/:userId/scope/:roleCode`) — include: a CASHIER caller gets `403`; an ADMIN caller can reassign a `SELLER`'s LOCATION scope without disturbing a co-existing `WAREHOUSE` assignment for the same target; `DELETE .../scope/WAREHOUSE` removes only that assignment and the target's next `/me` call reflects it via `effectiveLocationIds` while any other assignment's locations remain reachable.

- [ ] **Step 2: Run test to verify it fails** — `404` on both routes.

- [ ] **Step 3: Wire the routes/controller**

```ts
// api/src/modules/backoffice/backoffice.controller.ts (add two handlers)
import { createScopeAssignmentService } from './scope-assignment.service.js';
import type { AssignScopeInput } from './scope-assignment.dto.js';
import type { RoleCode } from '../rbac/roles.js';

export function createBackofficeController(database: PrismaClient) {
  const service = createBackofficeService(database);
  const scopeAssignmentService = createScopeAssignmentService(database);
  return {
    // ...existing handlers unchanged...
    assignScope: (async (req, res) => {
      sendJson(res, await scopeAssignmentService.assign(req, String(req.params.userId), req.body as AssignScopeInput));
    }) as RequestHandler,
    revokeScope: (async (req, res) => {
      sendJson(res, await scopeAssignmentService.revoke(req, String(req.params.userId), req.params.roleCode as RoleCode));
    }) as RequestHandler,
  };
}
```

```ts
// api/src/modules/backoffice/backoffice.routes.ts (add imports + two routes)
import { assignScopeDto, userIdParamsDto, userRoleParamsDto } from './scope-assignment.dto.js';
// ...
  const userManage = requirePermission(PRODUCTION_PERMISSIONS.USER_MANAGE);
  // ...existing routes unchanged...
  router.post('/users/:userId/scope', validate(userIdParamsDto, 'params'), validate(assignScopeDto), userManage, controller.assignScope);
  router.delete('/users/:userId/scope/:roleCode', validate(userRoleParamsDto, 'params'), userManage, controller.revokeScope);
```

- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit**

```bash
git add api/src/modules/backoffice/backoffice.controller.ts api/src/modules/backoffice/backoffice.routes.ts api/tests/backoffice/scope-assignment.test.ts
git commit -m "feat(backoffice): expose per-assignment POST scope / DELETE scope/:roleCode endpoints (Phase 1D.4)"
```

### Task 1D.4.5: dedicated privilege-escalation regression suite

**Files:**
- Create: `api/tests/rbac/privilege-escalation.test.ts`

Composes already-implemented behavior from Tasks 1D.2.3–1D.2.4 and 1D.4.3–1D.4.4 into one canonical checklist suite, including the correction's own required cases: cross-assignment composition, stale-`UserBranchRole`-cannot-grant-uppercase (replayed end-to-end post-1D.3.6), multiple-`UserRoleScope`-rows-cannot-cross-compose, COMPANY-permission-must-come-from-a-COMPANY-assignment-that-grants-it, OWNER centralized authority, ADMIN-cannot-manage-OWNER, empty-scope-fail-closed.

- [ ] **Step 1: Write the tests**

```ts
// api/tests/rbac/privilege-escalation.test.ts
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { createTestPrismaClient, truncateAllTables } from '../helpers/test-db.js';
import { createBranch, createTestUser } from '../helpers/factories.js';
import { getAuthToken } from '../helpers/auth.js';
import { bootstrapProductionRbacCatalog } from '../../src/modules/rbac/catalog.service.js';

describe('Privilege escalation (Phase 1D.4/1E checklist)', () => {
  let db: Awaited<ReturnType<typeof createTestPrismaClient>>;
  let app: ReturnType<typeof createApp>;
  beforeAll(async () => { db = await createTestPrismaClient(); app = createApp(db); });
  beforeEach(async () => { await truncateAllTables(db); await bootstrapProductionRbacCatalog(db); });
  afterAll(async () => db.$disconnect());

  it('ADMIN cannot grant OWNER to another user via the scope endpoint', async () => {
    const branch = await createBranch(db);
    const admin = await createTestUser(db, (await db.role.findUniqueOrThrow({ where: { code: 'ADMIN' } })).id, branch.id);
    const target = await createTestUser(db, (await db.role.findUniqueOrThrow({ where: { code: 'CASHIER' } })).id, branch.id);
    const token = await getAuthToken(admin);
    const response = await request(app).post(`/api/v1/backoffice/users/${target.id}/scope`).set('Authorization', `Bearer ${token}`).send({ roleCode: 'OWNER', scopeKind: 'COMPANY' });
    expect(response.status).toBe(403);
  });

  it.each(['CASHIER', 'SELLER', 'WAREHOUSE'])('%s cannot reach the scope-assignment endpoint at all', async (roleCode) => {
    const branch = await createBranch(db);
    const caller = await createTestUser(db, (await db.role.findUniqueOrThrow({ where: { code: roleCode } })).id, branch.id);
    const target = await createTestUser(db, (await db.role.findUniqueOrThrow({ where: { code: 'SELLER' } })).id, branch.id);
    const token = await getAuthToken(caller);
    const response = await request(app).post(`/api/v1/backoffice/users/${target.id}/scope`).set('Authorization', `Bearer ${token}`).send({ roleCode: 'SELLER', scopeKind: 'LOCATION', locationIds: [branch.id] });
    expect(response.status).toBe(403);
  });

  it('an empty UserRoleScope (revoked) authorizes nothing, even with a stale UserBranchRole row present', async () => {
    const branch = await createBranch(db);
    const user = await createTestUser(db, (await db.role.findUniqueOrThrow({ where: { code: 'SELLER' } })).id, branch.id);
    await db.userRoleScope.deleteMany({ where: { userId: user.id } });
    const token = await getAuthToken(user);
    const response = await request(app).get('/api/v1/inventory').query({ branchId: branch.id }).set('Authorization', `Bearer ${token}`);
    expect(response.status).toBe(403);
    expect(await db.userBranchRole.count({ where: { userId: user.id } })).toBe(1);
  });

  it('a stale UserBranchRole-only permission grant authorizes nothing post-1D.3.6, even for a Role carrying BOTH vocabularies', async () => {
    const branch = await createBranch(db);
    const role = await db.role.create({ data: { code: 'MIXED-STALE', name: 'MIXED-STALE' } });
    const legacyPermission = await db.permission.upsert({ where: { code: 'sale.view' }, create: { code: 'sale.view' }, update: {} });
    const productionPermission = await db.permission.upsert({ where: { code: 'SALE_VIEW' }, create: { code: 'SALE_VIEW' }, update: {} });
    await db.rolePermission.create({ data: { roleId: role.id, permissionId: legacyPermission.id } });
    await db.rolePermission.create({ data: { roleId: role.id, permissionId: productionPermission.id } }); // same Role carries both
    const user = await createTestUser(db, role.id, branch.id); // attaches via UserBranchRole AND a matching UserRoleScope row (factory default)
    await db.userRoleScope.deleteMany({ where: { userId: user.id } }); // strip the UserRoleScope row — only the stale UserBranchRole remains
    const token = await getAuthToken(user);
    const response = await request(app).get('/api/v1/sales').set('Authorization', `Bearer ${token}`);
    expect(response.status).toBe(403);
  });

  it('two independent UserRoleScope assignments cannot cross-compose a permission+location neither grants alone', async () => {
    const branchA = await createBranch(db);
    const branchB = await createBranch(db);
    const { ensureTestLocation } = await import('../helpers/factories.js');
    await ensureTestLocation(db, branchB.id);
    const sellerRole = await db.role.findUniqueOrThrow({ where: { code: 'SELLER' } });
    const warehouseRole = await db.role.findUniqueOrThrow({ where: { code: 'WAREHOUSE' } });
    const user = await db.user.create({ data: { name: 'multi', email: 'multi-escalation@test.local', passwordHash: 'x' } });
    await db.userRoleScope.createMany({
      data: [
        { userId: user.id, roleId: sellerRole.id, scopeKind: 'LOCATION', locationId: branchA.id },
        { userId: user.id, roleId: warehouseRole.id, scopeKind: 'LOCATION', locationId: branchB.id },
      ],
    });
    const token = await getAuthToken(user);
    // SELLER holds SALE_CREATE but only at A; WAREHOUSE holds a location at
    // B but not SALE_CREATE. Neither assignment grants SALE_CREATE @ B.
    const response = await request(app).post('/api/v1/sales').set('Authorization', `Bearer ${token}`).send({ branchId: branchB.id, items: [] });
    expect(response.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run** — expected GREEN immediately if Tasks 1D.2–1D.4 are all merged (composes existing behavior); any RED is a gap in an earlier task, fix there.

- [ ] **Step 3: Commit**

```bash
git add api/tests/rbac/privilege-escalation.test.ts
git commit -m "test(rbac): consolidate privilege-escalation regression suite, including cross-assignment cases (Phase 1D.4)"
```

### Task 1D.4.6: `backoffice/users` reads live `UserRoleScope` assignments

**Files:**
- Modify: `api/src/modules/backoffice/backoffice.service.ts`
- Modify: `api/tests/backoffice/backoffice.test.ts`

- [ ] **Step 1–2:** same RED pattern as the first draft — a revoked target must show `assignments: []`, not a stale legacy role/branch.

- [ ] **Step 3: Rewrite `backoffice.service.ts`'s `users()`**

```ts
async function users(req: RequestLike) {
  const locationIds = scopeBranches(req); // effectiveLocationIds-derived, display filter only
  const rows = await database.user.findMany({
    where: { roleScopes: { some: { OR: [{ locationId: { in: locationIds } }, { scopeKind: 'COMPANY' }] } } },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
    select: {
      id: true, name: true, email: true, isActive: true,
      roleScopes: {
        select: { scopeKind: true, locationId: true, role: { select: { id: true, code: true, name: true } }, location: { select: branchSelect } },
        orderBy: [{ role: { code: 'asc' } }],
      },
    },
  });
  return {
    items: rows.map((user) => ({
      id: user.id, name: user.name, email: user.email, isActive: user.isActive,
      assignments: user.roleScopes.map((scope) => ({ roleCode: scope.role.code, scopeKind: scope.scopeKind, location: scope.location })),
    })),
  };
}
```

- [ ] **Step 4: Run** — PASS; update any pre-existing `users()` test asserting the old `roles`/`branches` shape to the new `assignments` shape as part of this same task.
- [ ] **Step 5: Commit**

```bash
git add api/src/modules/backoffice/backoffice.service.ts api/tests/backoffice/backoffice.test.ts
git commit -m "fix(backoffice): read live per-assignment UserRoleScope state in GET /backoffice/users (Phase 1D.4)"
```

**Exit criteria:** OWNER/ADMIN can assign, reassign, and revoke one `(user, roleCode)` assignment at a time, without disturbing any other independent assignment for that user; every escalation vector named in `.claude/claude-security-guidance.md` and this correction has a passing test; `backoffice/users` shows live, per-assignment state.

**Commit boundary:** 7 commits.

**Risk: HIGH** — this is the phase that lets a human actually change who has what authority; the per-assignment isolation tests in Task 1D.4.3 (the "correction's own example" test) are the single most load-bearing test in this plan.

---

## PHASE 1D.5 — Realtime + legacy deprecation cleanup

**Objective:** verify (not implement) that nothing runtime still depends on `UserBranchRole` for a Production-permission decision; confirm the socket connection-time-snapshot limitation is documented, not silently fixed; document the `cash` `GET /register`/`GET /current` decision as **firmly resolved** — preserve current behavior, no permission invented, no option table.

**Invariants preserved:** no hot socket-revocation implemented; `UserBranchRole`/`MANAGER`/legacy `Permission` rows remain physically present.

**Dependencies:** Phase 1D.4 complete.

### Task 1D.5.1: repo-wide verification sweep + final A–F classification

**Files:** none modified — verification only, result appended to this plan's Cross-cutting design §F as a checked fact.

- [ ] **Step 1: Run**

```bash
cd api
grep -rn "UserBranchRole\|branchRoles" src --include="*.ts" | grep -v "src/generated/"
```

- [ ] **Step 2: Classify every hit.** Expected result set: only `rbac/scope-backfill.service.ts`, `rbac/legacy-role-map.ts` (category E), the Prisma schema comment block, and `rbac/authorization-context.ts`'s `roles` display-union read of `branchRoles[].role.code` (informational only, never an authorization decision input — `legacyPermissions` itself no longer exists after Task 1D.3.6, so there is no permission-shaped hit to find at all). If any hit appears inside `middleware/`, a `*.routes.ts`/`*.service.ts` outside `rbac/`, or `realtime/socket.ts` and is not a comment, that is a Phase 1D regression — fix it before declaring this phase done.

- [ ] **Step 3: No commit** (verification only; fix and re-run if Step 2 finds a real regression).

### Task 1D.5.2: socket connection-time snapshot — confirm documented, do not fix

**Files:**
- Modify: `api/src/realtime/socket.ts` (comment only, if not already present post-1D.1/1D.2 rewrite)

- [ ] **Step 1: Verify** existing reconnect-only test coverage still passes; confirm no test in this plan added live mid-connection revocation.
- [ ] **Step 2:** add the documentation comment to the `connection` handler if missing (same text as the first draft's Task 1D.5.2 — connection-time snapshot of `assignments`/`effectiveLocationIds`, not fixed in Phase 1D since no frozen requirement calls for it).
- [ ] **Step 3: Commit (only if the comment was missing)**

```bash
git add api/src/realtime/socket.ts
git commit -m "docs(realtime): document the connection-time authorization snapshot limitation (Phase 1D.5)"
```

### Task 1D.5.3: `cash` `GET /register`/`GET /current` — firm decision, documented, not implemented as a change

**Files:** none — no *behavioral* change. This is the corrected, final decision (replacing the first draft's open two-option table).

**Decision (per the security correction, item 6):** for Phase 1D, `GET /cash/register` and `GET /cash/current` **keep their current behavior exactly as-is** — authenticated + authorized-location-scoped reads, no specific permission attached, consistent with the approved 33-permission Production catalog, which defines no dedicated "view register/session" permission. **No `CASH_VIEW` or any other new permission is introduced**, and no `requirePermission` gate is added to either route. This is a deliberate Phase 1D decision, not an open question deferred to the user. The only change either route receives anywhere in this plan is the mechanical one already made in Task 1D.3.3 (the inline `branchIds.includes(...)` check inside `getRegister`/`getCurrentSession` was routed through the centralized `hasBranchAccess(ctx, branchId)` instead — same outcome for every non-OWNER caller, but consistent with "the policy, not the route, must be the source of these semantics" and correct for OWNER/a COMPANY assignment too) — no *new* code lands here in Task 1D.5.3 itself.

- [ ] **No steps to execute** — this task's deliverable is the paragraph above; the only related code change (Task 1D.3.3's `hasBranchAccess` routing) already happened earlier in Phase 1D.3.

**Exit criteria for Phase 1D.5:** Task 1D.5.1's sweep finds zero non-comment, non-`rbac/`-backfill runtime read of `UserBranchRole` contributing to any decision; the socket snapshot limitation is documented in code; the cash-permission decision is recorded, not open.

**Commit boundary:** 0–1 commits (only if Task 1D.5.1 finds a real regression, or Task 1D.5.2's comment was missing).

**Risk: LOW.**

---

## PHASE 1E — Security/RBAC hardening boundary (described only — NOT implemented by this plan)

Phase 1E runs after Phase 1D.1–1D.5 are all green and covers, per `08-implementation-roadmap.md` and this project's standing workflow:

- **OWNER COMPANY authority** — Task 1D.2.5/1D.3.1's e2e tests are a starting point; Phase 1E broadens to every permission-gated route.
- **ADMIN COMPANY authority** — same broadening across every module, including the COMPANY-required permissions (`PRICE_MANAGE`/`PRODUCT_MANAGE`/`PRODUCT_VARIANT_MANAGE`) once Phase 2 gives them a real route.
- **ADMIN cannot perform an OWNER-only action** — Task 1D.4.3's "OWNER -> manage an eligible subject = allowed / ADMIN -> manage OWNER = denied" pair is now the first concrete, real privilege boundary (per the second security correction, item 5) — Phase 1E broadens this to any additional OWNER-only business action once one exists in the product, rather than needing to invent a placeholder.
- **CASHIER/SELLER/WAREHOUSE LOCATION isolation** — largely covered by Task 1D.2.3/1D.2.4's cross-assignment matrix; Phase 1E audits for gaps across every module, not just the routes this plan directly touched.
- **Privilege escalation attempts** — Task 1D.4.5 is the canonical suite; Phase 1E broadens coverage, ideally with an independent reviewer.
- **Empty scope fail-closed** — covered throughout; Phase 1E re-verifies post-full-switch, including a mid-session revocation case (JWT stays valid up to 15 minutes, but every request re-reads the DB, so this should already hold by construction — worth an explicit regression test).
- **Stale UserBranchRole cannot grant/veto access** — Task 1D.1.1's isolation test (permission dimension) and the existing Phase 1C suites (location dimension) both re-verified end-to-end once more post-1D.3.6.
- **Multiple UserRoleScope rows cannot cross-compose privileges** — Task 1D.2.3/1D.2.4/1D.4.5's matrix is the implementation and its direct proof; Phase 1E runs an exhaustive per-role × per-permission × per-assignment-combination matrix rather than the representative cases this plan covers.
- **COMPANY permission must come from a COMPANY assignment that grants it** — Task 1D.2.2/1D.2.3's tests are the direct proof; Phase 1E broadens across every module.
- **Production uppercase permission enforcement** — Task 1D.3's per-route tests are the per-module proof; Phase 1E runs the full role × permission matrix.
- **JWT identity-only** — unchanged throughout this plan; Phase 1E adds an explicit assertion that the JWT payload never contains `roles`/`assignments`/`permissions`/`effectiveLocationIds` claims.
- **Socket.IO authorization** — Task 1D.2.6/1D.5.2 cover connect-time behavior and document the snapshot limitation; Phase 1E should not attempt to fix the snapshot limitation absent a frozen requirement change.
- **The `cash` `GET /register`/`GET /current` decision** (Task 1D.5.3) is now firmly resolved by this correction — Phase 1E confirms the decision is still correctly reflected in code, it does not reopen it.

Phase 1E is explicitly not started, planned in task-by-task detail, or implemented by this document.

---

## Deliverables A–G (consolidated, post-correction)

**A. Exact shared authorization abstraction:** `api/src/modules/rbac/authorization-context.ts` (state: `assignments[]`, one per `UserRoleScope` row, plus the compatibility-window-only `legacyPermissions` — deleted at Task 1D.3.6 — and the non-authoritative `effectiveLocationIds`) and `api/src/modules/rbac/authorization-policy.ts` (decisions: `isOwner`/`hasPermission`/`hasPermissionAtLocation`/`hasBranchAccess`, all delegating to one internal `assignmentQualifies` predicate that also enforces the COMPANY-required-permission rule via `requiresCompanyScope`, itself reading the existing `COMPANY_SCOPE_REQUIRED_FOR_ADMIN` domain list). `middleware/authorization.ts` is the only caller of the policy module for routes; manual service-level rechecks that stand in for a permission decision call `assertPermissionAtLocation`/`hasPermissionAtLocation` directly (Phase 1D.3) — never their own inline array check.

**B. OWNER representation:** `authorization-policy.ts`'s `isOwner(ctx)` — checks `ctx.assignments.some(a => a.roleCode === 'OWNER')` — is the single comparison of a role code to `'OWNER'` in the codebase. `scope-assignment.service.ts`'s escalation guards call this same helper on the caller's context; they never re-derive the comparison.

**C. COMPANY vs LOCATION representation:** each `UserRoleScope` row becomes its own `ProductionAssignment` with `scopeKind`/`locationId` preserved exactly (COMPANY's `locationId` stays `null`, never fabricated). `hasPermissionAtLocation` treats `scopeKind === 'COMPANY'` as qualifying for *that assignment's own* permissions at any location — never for another assignment's permissions. `effectiveLocationIds` is a separate, clearly-named, non-authoritative convenience field (real location ids, never a sentinel) for the small set of direct list/room-join consumers; `authorization-policy.ts` never reads it.

**D. How cross-role/cross-scope privilege composition is prevented:** by construction, not by convention — `assignments` is never flattened into independent `permissions[]`/`locationIds[]` sets at any point in this plan. `hasPermissionAtLocation` is the only function allowed to evaluate a permission+location pair, and it always requires both to be satisfied by the *same* array entry. Proven at three layers: unit tests on `authorization-policy.ts` (Task 1D.2.3), a live HTTP route test (Task 1D.2.4/1D.3.1), and the consolidated escalation suite (Task 1D.4.5).

**E. How legacy lowercase compatibility is isolated:** `legacyPermissions` and `assignments[].permissions` are computed from two independently-filtered code sets (`shared/permissions.ts`'s `permissionValues` vs `rbac/permissions.ts`'s `productionPermissionValues`) even though the same underlying `Role` row may carry both vocabularies via `RolePermission` — so a stale `UserBranchRole` grant can never surface a Production uppercase code, proven directly in Task 1D.1.1 before any consumer exists to exploit it, and end-to-end in Task 1D.4.5 after the full switch. `requireLegacyPermission` (Task 1D.2.4) and `requirePermission` are two distinct, non-interchangeable middleware functions during the compatibility window; the former is deleted outright, not merely unused, at Task 1D.3.6.

**F. Unresolved decisions remaining:**
1. **The ADMIN→COMPANY backfill (Task 1D.4.1) must be explicitly run against TEST, and separately against DEV with human approval**, after Phase 1D.1–1D.4 ship — until then, existing ADMIN users keep their Phase-1C-backfilled `LOCATION` assignment. This is now provably **safe, not a regression**: `authorization-policy.ts`'s COMPANY-required rule (second security correction) guarantees such an ADMIN cannot exercise `PRICE_MANAGE`/`PRODUCT_MANAGE`/`PRODUCT_VARIANT_MANAGE` company-wide authority in the meantime, closing the gap the first revision only asserted informally.
2. **Whether `USER_MANAGE` (and by extension the scope-assignment endpoint) should be added to the COMPANY-required set** — identified by this correction's global-route audit (Cross-cutting §C.1): a LOCATION-scoped, pre-backfill ADMIN can reach `POST/DELETE /backoffice/users/:userId/scope` today, since `USER_MANAGE` is not in the frozen `COMPANY_SCOPE_REQUIRED_FOR_ADMIN` list. Surfaced, not resolved — this plan does not invent a new COMPANY requirement the frozen doc doesn't state.
3. **The exact wire format for the scope-assignment endpoint's `locationIds` vs `roleCode` pairing** is specified in this plan's DTO (Task 1D.4.3) but has not been reviewed against `admin/` frontend expectations, since `AGENTS.md` notes `admin/`'s current Production-readiness is unverified — a frontend integration pass is out of this plan's scope.

*(Resolved from the first revision: "no concrete OWNER-only business action" is now answered — Task 1D.4.3's OWNER-manages-an-eligible-subject / ADMIN-cannot-manage-OWNER pair is the first real boundary, per the second correction's item 5.)*

**G. Confirmation no other files changed:** this revision touched only `docs/superpowers/plans/2026-09-14-phase-1d-production-authorization.md`. No runtime code, test, schema, or migration file was modified; TEST/DEV were not touched; nothing was committed or pushed — confirmed by the `git status --short`/`git diff --check` output run immediately after this revision (see below).

---

**Global exit criteria for Phase 1D as a whole:** every task's own exit criteria above are met; the full focused-test gate, `npx tsc --noEmit`, and `npm run lint` are all green; the full suite is run once, only after all of the above, per CLAUDE.md's testing policy.

---

## What changed in this revision (itemized against the first draft)

1. **`UserBranchRole` can no longer contribute a Production uppercase permission.** First draft: `authorization-context.ts` unioned `UserBranchRole → Role → RolePermission` and `UserRoleScope → Role → RolePermission` into one flat `permissions[]`, which would have let a stale `UserBranchRole` row leak a Production grant through a shared `Role` row. Now: `legacyPermissions` (from `UserBranchRole`) and `assignments[].permissions` (from `UserRoleScope`) are each filtered against their own canonical code set (Cross-cutting design §D), proven by a dedicated test in Task 1D.1.1 before any consumer exists.
2. **`AuthorizationContext` is assignment-shaped, not flattened.** First draft: independent `permissions: string[]` and `branchIds: string[]` fields, checkable independently — this allowed a permission from one `UserRoleScope` row to combine with a location from a different row for the same user (the `SELLER @ A` + `WAREHOUSE @ B` → `SALE_CREATE @ B` bug). Now: `assignments: ProductionAssignment[]`, one entry per `UserRoleScope` row, and `hasPermissionAtLocation` requires both the permission and the location to be satisfied by the *same* entry.
3. **COMPANY is a qualifying assignment, never expanded into the authoritative source.** First draft: a COMPANY row was expanded into a real `branchIds` array that then had to be trusted directly by `hasBranchAccess`. Now: the COMPANY assignment's `locationId` stays `null`, `scopeKind: 'COMPANY'` is the explicit qualifier `hasPermissionAtLocation` checks, and the expanded id list moved to a separately-named, non-authoritative `effectiveLocationIds` field that the policy module never reads.
4. **OWNER stays centralized in `authorization-policy.ts`**, unchanged in spirit from the first draft, now expressed over `assignments` instead of a flat `roles[]` array.
5. **"One role per user" is no longer assumed anywhere.** First draft's scope-assignment service deleted *all* of a user's `UserRoleScope` rows on any reassignment. Now: every operation is scoped to exactly one `(userId, roleId)` pair — proven by a dedicated test replaying the correction's own `SELLER @ A` / `WAREHOUSE @ B` example. Self-modification is denied for every actor including OWNER (unchanged from the first draft, restated as a hard invariant). ADMIN cannot manage *any* assignment belonging to a user who holds OWNER (broadened from the first draft's narrower "cannot grant OWNER").
6. **`cash` `GET /register`/`GET /current` is now a firm, documented decision** (preserve current behavior, no permission invented), replacing the first draft's open two-option table — per the correction, this was already decided and should not have been left as a question.
7. **`requirePermission` (Production) and `requireLegacyPermission` (legacy) are two distinct, separately-named functions**, split out in Phase 1D.2 rather than the first draft's single `requirePermission` reading a unioned array — makes the compatibility window's boundary an explicit type-level fact, not an implicit one.
8. **Manual service-level `assertBranchAccess` call sites that were actually standing in for a permission decision** (`sales.service.ts`'s view/complete checks, `cancellation.service.ts`, `payments.service.ts`, `products.service.ts`'s variant filter, `backoffice.service.ts`'s `getSale`) are converted to the new `assertPermissionAtLocation` during Phase 1D.3, per route — the first draft did not identify or fix these, which would have left the cross-composition bug reachable through several existing manual rechecks even after the route-level fix landed.

Task-count/phase-boundary changes: the legacy/Production middleware split moved from the end of Phase 1D.3 (first draft) to Phase 1D.2 (this revision), since it's the mechanism the cross-composition fix depends on; Phase 1D.3's route tasks gained an explicit manual-recheck-conversion step each; the OWNER/ADMIN-COMPANY HTTP proof moved from Task 1D.2.5 to Task 1D.3.1 (the first route actually switched to `requirePermission`), since no route can prove it end-to-end before at least one is switched. The `1D.1 → 1D.5` slice boundaries themselves are unchanged.

---

## What changed in the final authorization-policy correction (this revision)

1. **`hasPermissionAtLocation` semantics made explicit and literal**, per correction item 1: a qualifying assignment must itself grant the permission AND cover the location via `scopeKind === 'COMPANY'` OR `scopeKind === 'LOCATION'` with a matching `locationId` — both from the *same* assignment. (The prior revision already implemented this correctly; this revision states it as the canonical rule in Cross-cutting design §B and re-derives the implementation from that statement, rather than leaving the rule implicit in code comments.)
2. **`hasPermission`/`hasPermissionAtLocation` no longer treat "any assignment contains the permission" as sufficient for COMPANY-required permissions.** New internal predicate `assignmentQualifies`, and a new exported `requiresCompanyScope(permission)` reading the existing, unchanged `COMPANY_SCOPE_REQUIRED_FOR_ADMIN` domain constant (`PRICE_MANAGE`, `PRODUCT_MANAGE`, `PRODUCT_VARIANT_MANAGE` — no new permission invented). A LOCATION-scoped ADMIN's assignment can no longer exercise these three permissions globally or at its own location, even though its `permissions` array literally contains them (ADMIN's grant is unconditional in the catalog). This is now proven by dedicated tests using a fixture that reproduces the exact pre-backfill shape of a real ADMIN assignment (Task 1D.2.3), so "until the ADMIN→COMPANY correction runs, existing ADMIN remains at today's LOCATION access" is a tested guarantee, not an assertion.
3. **Every `branchScope:'global'` route in the plan's 9 route files is now classified** (Cross-cutting design §C.1) as ANY-authorized-assignment, LOCATION-for-a-concrete-resource, COMPANY-required, or OWNER-implicit — with the real decision point named for each (route-level gate alone, vs. route gate + a service-level `assertPermissionAtLocation`/bulk filter). This audit surfaced three real gaps the prior revision missed:
   - `sales.service.ts`'s `createDraftSale` had an unconverted `assertBranchAccess` call (now added to Task 1D.3.1).
   - `cash.controller.ts` passes a bare `branchIds` array into `cash.service.ts`, not `req` — Task 1D.3.3 was rewritten to change the controller-to-service call signature (pass `req.auth`, not an array) so `getRegister`/`getCurrentSession`/`openSession`/`closeSession` can call the centralized policy functions instead of a bespoke inline `.includes()`.
   - The `Express.AuthContext.branchIds → effectiveLocationIds` rename (introduced by the *first* correction) was never actually swept across its ~15 direct call sites (`sales.controller.ts`, `sales.service.ts`, `cancellation.controller.ts`/`.service.ts`, `payments.service.ts`, `cash.controller.ts`, `products.controller.ts`/`.service.ts`, `backoffice.service.ts`) — left as-is, Phase 1D.1's own `tsc --noEmit` gate would have failed. New Task 1D.1.6 fixes this as an explicit, compiler-driven, exhaustive rename sweep, run before Phase 1D.1's gate (Task 1D.1.7, renumbered).
   - Identified (not resolved): `USER_MANAGE` is not in the COMPANY-required set, so a LOCATION-scoped, pre-backfill ADMIN can reach the scope-assignment endpoint today — flagged in Deliverable F, not silently fixed.
4. **New RED test cases added before any implementation**, per correction item 4: `ADMIN @ LOCATION + PRICE_MANAGE` fails both the global and location-paired check; `ADMIN @ COMPANY + PRICE_MANAGE` passes both; a non-company-required permission still requires the *same* assignment's own matching location (`ADMIN @ LOCATION 'X'` does not qualify at location `'Y'`) — all added to Task 1D.2.3, alongside the already-present cross-assignment, COMPANY-qualifying-assignment, and OWNER-centralization cases.
5. **OWNER-only test uses a real privilege boundary, not a fabricated endpoint**, per correction item 5: Task 1D.4.3 gained an explicit "OWNER can assign a COMPANY-scoped ADMIN to an eligible subject" test, paired with the already-present "ADMIN cannot manage OWNER" test, as the first concrete OWNER-only boundary — Phase 1E's description updated accordingly (no more "no concrete OWNER-only action exists" gap).
