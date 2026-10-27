# Phase 1C — Legacy Scope Backfill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Backfill `UserRoleScope` (added empty in Phase 1B) 1:1 from the existing `UserBranchRole` rows, mapping the legacy `MANAGER` role explicitly to the Production `WAREHOUSE` role, prove row-by-row equivalence, make `UserRoleScope` the real, authoritative source of `branchIds`/LOCATION-COMPANY scope for every authenticated request (with a safe legacy fallback during the compatibility window), and keep it that way across every seed/reset cycle — all without implementing Phase 1D's permission/scope guards or touching `authorization.ts`.

**Architecture:** A pure domain map (`legacy-role-map.ts`) makes the legacy→Production role mapping explicit and fail-closed. A backfill/sync pair (`scope-backfill.service.ts`, split into a core `sync...` function and a standalone `backfill...` wrapper, mirroring `catalog.service.ts`) reads every `UserBranchRole` row and creates one matching `LOCATION`-scoped `UserRoleScope` row per row (`locationId` reuses `branchId` directly, since `Location.id == Branch.id` from the Phase 1A backfill). A verify function proves the invariants independently of the backfill's own return value. A read-only resolver (`scope-resolver.ts`) reads `UserRoleScope` for a user, and a shared policy function (`effective-branch-ids.ts`) built on it — **prefer `UserRoleScope` when it has been backfilled for that user, else fall back to the identical legacy `UserBranchRole`-derived set** — is imported by both real per-request consumers: `api/src/middleware/auth.ts` (builds `req.auth.branchIds` on every request — this is what `authorization.ts` actually enforces against) and `api/src/modules/auth/auth.service.ts` (`/login` and `/me` response bodies). `roles`/`permissions` in both files are untouched, still legacy. Finally, `prisma/seed.ts`'s `populate()` calls the core sync function on its own existing transaction so every seed/reset keeps `UserRoleScope` in sync with `UserBranchRole`, never regressing it. A thin CLI script and package.json entry expose the backfill the same way Phase 1A/1B's backfill scripts already do.

**Tech Stack:** TypeScript, Prisma 7 (`@prisma/adapter-pg`), Vitest, tsx (Node 22).

**Spec:** `docs/production-v1/08-implementation-roadmap.md` Phase 1C; `docs/production-v1/05-architecture.md` §5 (Role Definitions, Scope Model); `docs/production-v1/06-erd-data-model.md` §2.2 (ROLE: "codes changed: MANAGER→WAREHOUSE", USER_ROLE_SCOPE); `docs/development/migrations.md` §16 (expand-and-contract).

## Phase 1C / Phase 1D Boundary (SWITCH step)

`08-implementation-roadmap.md` lists Phase 1C's migration/backfill line as "ADD UserRoleScope → BACKFILL from UserBranchRole → VERIFY permissions/scopes → SWITCH authorization reads/writes → DEPRECATE UserBranchRole → REMOVE...", with exit criterion "UserRoleScope authoritative; legacy mapped without data loss," and separately gives Phase 1C a "Backend/domain: scoped authorization service" deliverable. Phase 1D, a dependent phase (`Dependencies: 1C`), separately owns "Authorization middleware/services": `NEW: permission/scope guards; ALTERED: auth middleware`, "explicit permission checks, not role-string checks."

Investigation of the current codebase found the real request-time path, which the first draft of this plan missed:

- `api/src/middleware/authorization.ts`'s `requirePermission`/`assertBranchAccess` only ever read `req.auth` — they never touch the database. `req.auth` itself is built **once per request** by `api/src/middleware/auth.ts`'s `createRequireAuth`, which runs its **own independent inline query** against `UserBranchRole` (duplicating, not calling, `auth.service.ts`'s logic) to compute `roles`/`branchIds`/`permissions`. This is the actual, load-bearing authorization data source for every protected route, business service branch-access re-check (`payments.service.ts`, `sales.service.ts`, `cancellation.service.ts`, `cash.service.ts`), and the `/login` + `/me` response bodies (`auth.service.ts`'s `resolveUserContext`/`login`, which duplicate the same computation a second time for display purposes). A plan that only touched `auth.service.ts` would make `UserRoleScope` "authoritative" for nothing but a JSON response field — `req.auth.branchIds`, and therefore every real permission/branch check, would still run entirely off `UserBranchRole`. This is now corrected: **Task 6 also modifies `api/src/middleware/auth.ts`** (not `authorization.ts`, which stays untouched) — the smallest change that actually makes the exit criterion true.
- **No runtime code creates, updates, or deletes `UserBranchRole`** — only `prisma/seed.ts`'s deterministic seed does. So there is no live write path that could go stale relative to `UserRoleScope` during the compatibility window: **dual-write is not required** for Phase 1C.
- A second, independent test-database bootstrap path exists (`api/tests/helpers/test-db.ts`'s `createTestPrismaClient`/`truncateAllTables`, used by `api/tests/auth/login.test.ts` and `api/tests/auth/me.test.ts`) which never creates `Company`/`Location` either, and which a naive "fail if `UserBranchRole` exists but `UserRoleScope` doesn't" switch would break immediately (a real regression this review caught before it was written). This is exactly why the switch is a **prefer-else-fallback**, not a hard cutover: `UserRoleScope` is authoritative wherever it has been backfilled, and behavior is byte-identical to today wherever it has not, in every environment and every test harness — never an ambiguous blend of both for the same user, and never a new failure mode for an unmigrated database.
- `roles` and `permissions` (`req.auth.permissions`, the 12 legacy lowercase-dot codes in `api/src/shared/permissions.ts`) are **not** touched anywhere in this plan — `UserBranchRole` + legacy `Role`/`Permission` stay their sole source, exactly preserving every user's (including `MANAGER`'s) effective permissions. Switching that vocabulary to the 33 Production uppercase codes, and building real permission/scope guards on top of `scope-resolver.ts`, is Phase 1D's "NEW: permission/scope guards" / "ALTERED: auth middleware" — this plan only touches the narrower `branchIds` computation inside the already-existing `auth.ts`/`auth.service.ts` files, never `authorization.ts`.

## Global Constraints

- No new Prisma migration: `UserRoleScope` already exists (migration `20260912191702_add_user_role_scope`) — this phase is BACKFILL + VERIFY + a SWITCH of `branchIds` resolution only, never a schema change.
- `UserBranchRole` is read-only in this phase and must remain fully intact and authoritative for `roles`/`permissions` (DEPRECATE, not REMOVE) — nothing here mutates or deletes a `UserBranchRole` row.
- `api/src/middleware/authorization.ts` is never modified. `api/src/middleware/auth.ts` and `api/src/modules/auth/auth.service.ts` ARE modified, but only their `branchIds` computation (via a shared, tested `resolveEffectiveBranchIds` policy function) — `roles`/`permissions` in both files are untouched. No dual-write is introduced (none is required — see boundary section above).
- The `branchIds` switch is prefer-`UserRoleScope`-else-legacy-fallback, never a hard cutover and never a merge of both sources for the same user — see boundary section above. **Rollout consequence to flag explicitly:** once Task 6 ships, any environment is still safe (falls back automatically) whether or not its Phase 1A/1C backfills have run yet; Task 7 ensures every `demo`/`test` seed/reset keeps them in sync going forward.
- The legacy `MANAGER` role code maps explicitly to `WAREHOUSE`; `ADMIN`/`CASHIER`/`SELLER` keep their own code. Any other legacy role code must fail closed, never be guessed. This mapping is not a heuristic — it is the frozen ERD's stated `Role` disposition (`docs/production-v1/06-erd-data-model.md` §2.2: "REUSED (codes changed: MANAGER→WAREHOUSE)").
- Every backfilled row is `LOCATION`-scoped with `locationId = branchId`; `COMPANY` scope and `OWNER` rows are never inferred, invented, or created from legacy `UserBranchRole` data during backfill (per `05-architecture.md` §5: "ADMIN role alone never implies global access"; OWNER's authority stays implicit per Phase 1B). If a `COMPANY`-scoped row is ever encountered at request time, `resolveEffectiveBranchIds` fails closed (500) rather than guessing "all branches" or "no branches" — Phase 1C's own backfill never produces one, so this can only mean an out-of-band write Phase 1D hasn't caught up to yet.
- The standalone migration tooling (`backfillUserRoleScopeFromUserBranchRole`, the CLI script, and Task 7's seed/reset integration) stays strictly fail-closed on a missing prerequisite (unmapped role code, missing Location) — that is an explicit, operator-invoked action where a loud failure is correct. The passive, always-on request-time resolver (Task 6) is deliberately the opposite (lenient, falls back) — an ordinary user's request must never fail just because some database's migration tooling hasn't been run yet. Both halves are idempotent and, where they run inside a transaction, all-or-nothing, following the existing `organization.service.ts` / `catalog.service.ts` conventions; the core sync function used by seed/reset never opens a nested transaction.
- Migration history, Phase 1A/1B invariants (`Location.id == Branch.id`, Production Role/Permission catalog), and the current clean checkpoint are preserved — no destructive operation appears anywhere in this plan.

---

### Task 1: Legacy role mapping (pure domain helper)

**Files:**
- Create: `api/src/modules/rbac/legacy-role-map.ts`
- Test: `api/tests/rbac/legacy-role-map.test.ts`

**Interfaces:**
- Consumes: `ROLE_CODES`, `RoleCode` from `api/src/modules/rbac/roles.ts` (already exist: `{ OWNER, ADMIN, CASHIER, SELLER, WAREHOUSE }`).
- Produces: `LEGACY_ROLE_CODE_TO_PRODUCTION_ROLE_CODE: Record<string, RoleCode>` and `resolveProductionRoleCodeForLegacy(legacyRoleCode: string): RoleCode` (throws on an unmapped code) — consumed by Task 2's backfill/verify functions.

- [ ] **Step 1: Write the failing test**

```ts
// api/tests/rbac/legacy-role-map.test.ts
import { describe, expect, it } from 'vitest';
import {
  LEGACY_ROLE_CODE_TO_PRODUCTION_ROLE_CODE,
  resolveProductionRoleCodeForLegacy,
} from '../../src/modules/rbac/legacy-role-map.js';

describe('legacy role mapping (Phase 1C)', () => {
  it('maps ADMIN, CASHIER, and SELLER to themselves', () => {
    expect(resolveProductionRoleCodeForLegacy('ADMIN')).toBe('ADMIN');
    expect(resolveProductionRoleCodeForLegacy('CASHIER')).toBe('CASHIER');
    expect(resolveProductionRoleCodeForLegacy('SELLER')).toBe('SELLER');
  });

  it('maps the legacy MANAGER code explicitly to WAREHOUSE', () => {
    expect(resolveProductionRoleCodeForLegacy('MANAGER')).toBe('WAREHOUSE');
  });

  it('throws on any code with no explicit mapping', () => {
    expect(() => resolveProductionRoleCodeForLegacy('GHOST')).toThrow(
      /No explicit Production role mapping/,
    );
    expect(() => resolveProductionRoleCodeForLegacy('OWNER')).toThrow();
    expect(() => resolveProductionRoleCodeForLegacy('WAREHOUSE')).toThrow();
  });

  it('covers exactly the four legacy Demo V2 role codes', () => {
    expect(Object.keys(LEGACY_ROLE_CODE_TO_PRODUCTION_ROLE_CODE).sort()).toEqual(
      ['ADMIN', 'CASHIER', 'MANAGER', 'SELLER'].sort(),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && npx vitest run tests/rbac/legacy-role-map.test.ts`
Expected: FAIL — cannot find module `../../src/modules/rbac/legacy-role-map.js`.

- [ ] **Step 3: Write the implementation**

```ts
// api/src/modules/rbac/legacy-role-map.ts
import { ROLE_CODES, type RoleCode } from './roles.js';

// Phase 1C (Production V1) explicit legacy -> Production role mapping for the
// UserBranchRole -> UserRoleScope backfill. docs/production-v1/06-erd-data-model.md
// §2.2 ROLE: "REUSED (codes changed: MANAGER→WAREHOUSE)" — ADMIN/CASHIER/SELLER
// keep their own code; MANAGER is not a Production V1 role
// (docs/production-v1/00-master-index.md) and maps to WAREHOUSE. This is the
// only place that mapping is allowed to live: the backfill must never guess a
// target role from permissions, branch, or any other heuristic (Phase 1C
// spec: "MANAGER handled explicitly, not guessed").
export const LEGACY_ROLE_CODE_TO_PRODUCTION_ROLE_CODE: Record<string, RoleCode> = {
  ADMIN: ROLE_CODES.ADMIN,
  CASHIER: ROLE_CODES.CASHIER,
  SELLER: ROLE_CODES.SELLER,
  MANAGER: ROLE_CODES.WAREHOUSE,
};

// Fails closed on any legacy Role code this map does not explicitly cover
// (e.g. OWNER/WAREHOUSE should never appear on a legacy UserBranchRole row,
// and any other unexpected code is corrupt/unplanned-for state) rather than
// silently skipping it or picking a default.
export function resolveProductionRoleCodeForLegacy(legacyRoleCode: string): RoleCode {
  const mapped = LEGACY_ROLE_CODE_TO_PRODUCTION_ROLE_CODE[legacyRoleCode];
  if (!mapped) {
    throw new Error(
      `No explicit Production role mapping for legacy UserBranchRole role code "${legacyRoleCode}"; ` +
        `refusing to guess one (Phase 1C requires an explicit mapping for every legacy role)`,
    );
  }
  return mapped;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && npx vitest run tests/rbac/legacy-role-map.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add api/src/modules/rbac/legacy-role-map.ts api/tests/rbac/legacy-role-map.test.ts
git commit -m "feat(rbac): add explicit legacy MANAGER->WAREHOUSE role mapping for Phase 1C backfill"
```

---

### Task 2: Backfill function (`UserBranchRole` → `UserRoleScope`)

**Files:**
- Create: `api/src/modules/rbac/scope-backfill.service.ts`
- Create: `api/tests/rbac/scope-backfill.test.ts`

**Interfaces:**
- Consumes: `resolveProductionRoleCodeForLegacy` (Task 1); `openSeedDatabase` from `api/scripts/demo-database.ts`; `resetDemo` from `api/prisma/seed.js`; `backfillLocationsFromBranches`, `type CompanyBootstrap` from `api/src/modules/organization/organization.service.js`; `bootstrapProductionRbacCatalog` from `api/src/modules/rbac/catalog.service.js`.
- Produces: `syncUserRoleScopeFromUserBranchRole(db): Promise<ScopeBackfillResult>` (core, no own transaction) and `backfillUserRoleScopeFromUserBranchRole(db): Promise<ScopeBackfillResult>` (standalone, opens its own transaction around the core function) where `ScopeBackfillResult = { legacyRowCount: number; created: number; alreadyPresent: number }` — the standalone function is consumed by Task 3 (same file), Task 4 (CLI script), and Task 5/6's tests; the core function is consumed by Task 7 (`prisma/seed.ts`, on its own existing transaction).

- [ ] **Step 1: Write the failing tests**

```ts
// api/tests/rbac/scope-backfill.test.ts
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resetDemo } from '../../prisma/seed.js';
import { openSeedDatabase } from '../../scripts/demo-database.js';
import {
  backfillLocationsFromBranches,
  type CompanyBootstrap,
} from '../../src/modules/organization/organization.service.js';
import { bootstrapProductionRbacCatalog } from '../../src/modules/rbac/catalog.service.js';
import { backfillUserRoleScopeFromUserBranchRole } from '../../src/modules/rbac/scope-backfill.service.js';

// Phase 1C: backfills UserRoleScope from the legacy UserBranchRole rows.
// Depends on Phase 1A's Location backfill and Phase 1B's RBAC catalog
// bootstrap having already run — both are re-run here to make this suite
// self-sufficient regardless of test execution order.
describe('UserRoleScope backfill from UserBranchRole (Phase 1C)', () => {
  let db: Awaited<ReturnType<typeof openSeedDatabase>>;

  const FALLBACK_COMPANY_BOOTSTRAP: CompanyBootstrap = {
    id: '00000000-0000-4000-9300-000000000001',
    name: 'Mona Jacinta (scope backfill test)',
    cuit: '00-33333333-3',
    address: 'Dirección legal test — pendiente de dato real',
  };

  async function safely<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch {
      throw new Error('Scope backfill integration operation failed (database details suppressed)');
    }
  }

  beforeAll(async () => {
    db = await safely(() => openSeedDatabase('test'));
    await safely(() => resetDemo(db.prisma));
    const existingCompany = await db.prisma.company.findFirst();
    const bootstrap: CompanyBootstrap = existingCompany
      ? {
          id: existingCompany.id,
          name: existingCompany.name,
          cuit: existingCompany.cuit,
          address: existingCompany.address,
        }
      : FALLBACK_COMPANY_BOOTSTRAP;
    await safely(() => backfillLocationsFromBranches(db.prisma, bootstrap));
    await safely(() => bootstrapProductionRbacCatalog(db.prisma));
  }, 120000);

  afterEach(async () => {
    await safely(() => db.prisma.userRoleScope.deleteMany());
  });

  afterAll(async () => {
    if (db) await safely(() => db.close());
  });

  it('backfills all 9 legacy UserBranchRole rows into LOCATION-scoped UserRoleScope rows, mapping MANAGER to WAREHOUSE explicitly', async () => {
    const result = await backfillUserRoleScopeFromUserBranchRole(db.prisma);
    expect(result).toEqual({ legacyRowCount: 9, created: 9, alreadyPresent: 0 });
    expect(await db.prisma.userRoleScope.count()).toBe(9);

    const manager = await db.prisma.user.findFirstOrThrow({ where: { name: 'manager01' } });
    const warehouseRole = await db.prisma.role.findFirstOrThrow({ where: { code: 'WAREHOUSE' } });
    const legacyManagerAssignment = await db.prisma.userBranchRole.findFirstOrThrow({
      where: { userId: manager.id },
    });
    const managerScope = await db.prisma.userRoleScope.findFirstOrThrow({
      where: { userId: manager.id },
    });
    expect(managerScope.roleId).toBe(warehouseRole.id);
    expect(managerScope.scopeKind).toBe('LOCATION');
    expect(managerScope.locationId).toBe(legacyManagerAssignment.branchId);

    const admin = await db.prisma.user.findFirstOrThrow({ where: { name: 'admin' } });
    const adminRole = await db.prisma.role.findFirstOrThrow({ where: { code: 'ADMIN' } });
    const adminLegacyAssignments = await db.prisma.userBranchRole.findMany({
      where: { userId: admin.id },
    });
    const adminScopes = await db.prisma.userRoleScope.findMany({ where: { userId: admin.id } });
    expect(adminScopes).toHaveLength(6);
    expect(adminScopes.every((s) => s.roleId === adminRole.id && s.scopeKind === 'LOCATION')).toBe(
      true,
    );
    expect(adminScopes.map((s) => s.locationId).sort()).toEqual(
      adminLegacyAssignments.map((a) => a.branchId).sort(),
    );
  });

  it('is idempotent: rerunning creates no duplicate rows and reports everything as already present', async () => {
    const first = await backfillUserRoleScopeFromUserBranchRole(db.prisma);
    expect(first.created).toBe(9);
    const countAfterFirst = await db.prisma.userRoleScope.count();

    const second = await backfillUserRoleScopeFromUserBranchRole(db.prisma);
    expect(second).toEqual({ legacyRowCount: 9, created: 0, alreadyPresent: 9 });
    expect(await db.prisma.userRoleScope.count()).toBe(countAfterFirst);
  });

  it('fails closed and rolls back when a legacy UserBranchRole references an unmapped role code', async () => {
    const ghostRole = await db.prisma.role.create({ data: { code: 'GHOST', name: 'GHOST' } });
    const location = await db.prisma.location.findFirstOrThrow();
    const user = await db.prisma.user.findFirstOrThrow({ where: { name: 'admin' } });
    const ghostAssignment = await db.prisma.userBranchRole.create({
      data: { userId: user.id, branchId: location.id, roleId: ghostRole.id },
    });
    try {
      await expect(backfillUserRoleScopeFromUserBranchRole(db.prisma)).rejects.toThrow(
        /No explicit Production role mapping/,
      );
      expect(await db.prisma.userRoleScope.count()).toBe(0);
    } finally {
      await db.prisma.userBranchRole.delete({ where: { id: ghostAssignment.id } });
      await db.prisma.role.delete({ where: { id: ghostRole.id } });
    }
  });

  it('fails closed and rolls back when a legacy branch has no matching Location', async () => {
    const user = await db.prisma.user.findFirstOrThrow({ where: { name: 'admin' } });
    const adminRole = await db.prisma.role.findFirstOrThrow({ where: { code: 'ADMIN' } });
    const orphanBranch = await db.prisma.branch.create({
      data: { name: 'Sucursal huérfana', code: 'ORPHAN', address: 'N/A', pointOfSaleNumber: 999 },
    });
    const orphanAssignment = await db.prisma.userBranchRole.create({
      data: { userId: user.id, branchId: orphanBranch.id, roleId: adminRole.id },
    });
    try {
      await expect(backfillUserRoleScopeFromUserBranchRole(db.prisma)).rejects.toThrow(
        /Location row\(s\) missing/,
      );
      expect(await db.prisma.userRoleScope.count()).toBe(0);
    } finally {
      await db.prisma.userBranchRole.delete({ where: { id: orphanAssignment.id } });
      await db.prisma.branch.delete({ where: { id: orphanBranch.id } });
    }
  });

  it('never mutates UserBranchRole', async () => {
    await backfillUserRoleScopeFromUserBranchRole(db.prisma);
    expect(await db.prisma.userBranchRole.count()).toBe(9);
    const managerRole = await db.prisma.role.findFirstOrThrow({ where: { code: 'MANAGER' } });
    expect(
      await db.prisma.userBranchRole.count({ where: { roleId: managerRole.id } }),
    ).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd api && NODE_ENV=test npx vitest run tests/rbac/scope-backfill.test.ts`
Expected: FAIL — cannot find module `../../src/modules/rbac/scope-backfill.service.js`.

- [ ] **Step 3: Write the implementation**

```ts
// api/src/modules/rbac/scope-backfill.service.ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd api && NODE_ENV=test npx vitest run tests/rbac/scope-backfill.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add api/src/modules/rbac/scope-backfill.service.ts api/tests/rbac/scope-backfill.test.ts
git commit -m "feat(rbac): backfill UserRoleScope from legacy UserBranchRole (Phase 1C)"
```

---

### Task 3: Verify function (row-by-row equivalence)

**Files:**
- Modify: `api/src/modules/rbac/scope-backfill.service.ts`
- Modify: `api/tests/rbac/scope-backfill.test.ts`

**Interfaces:**
- Consumes: `resolveProductionRoleCodeForLegacy` (Task 1); the same `db.prisma` fixture as Task 2 (same test file, same `describe` block).
- Produces: `verifyUserRoleScopeBackfill(db): Promise<ScopeBackfillVerification>` where `ScopeBackfillVerification = { ok: boolean; issues: string[]; legacyRowCount: number; scopeCount: number }` — consumed by Task 4's CLI script.

- [ ] **Step 1: Write the failing tests**

Append to the existing `describe` block in `api/tests/rbac/scope-backfill.test.ts` (after the `'never mutates UserBranchRole'` test), and add `verifyUserRoleScopeBackfill` to the existing import from `../../src/modules/rbac/scope-backfill.service.js`:

```ts
  it('verify: reports ok with no issues after a correct backfill', async () => {
    await backfillUserRoleScopeFromUserBranchRole(db.prisma);
    const verification = await verifyUserRoleScopeBackfill(db.prisma);
    expect(verification.ok).toBe(true);
    expect(verification.issues).toEqual([]);
    expect(verification).toMatchObject({ legacyRowCount: 9, scopeCount: 9 });
  });

  it('verify: reports a missing-assignment issue when a backfilled row is deleted', async () => {
    await backfillUserRoleScopeFromUserBranchRole(db.prisma);
    const manager = await db.prisma.user.findFirstOrThrow({ where: { name: 'manager01' } });
    const managerScope = await db.prisma.userRoleScope.findFirstOrThrow({
      where: { userId: manager.id },
    });
    await db.prisma.userRoleScope.delete({ where: { id: managerScope.id } });

    const verification = await verifyUserRoleScopeBackfill(db.prisma);
    expect(verification.ok).toBe(false);
    expect(verification.scopeCount).toBe(8);
    expect(verification.issues.some((issue) => issue.includes('missing UserRoleScope'))).toBe(
      true,
    );
    expect(
      verification.issues.some((issue) =>
        issue.includes('expected 9 UserRoleScope row(s) (one per UserBranchRole), found 8'),
      ),
    ).toBe(true);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd api && NODE_ENV=test npx vitest run tests/rbac/scope-backfill.test.ts`
Expected: FAIL — `verifyUserRoleScopeBackfill` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `api/src/modules/rbac/scope-backfill.service.ts`:

```ts
type VerifyDatabase = Pick<PrismaClient, 'userBranchRole' | 'role' | 'userRoleScope'>;

export type ScopeBackfillVerification = {
  ok: boolean;
  issues: string[];
  legacyRowCount: number;
  scopeCount: number;
};

// VERIFY step: proves row-by-row equivalence between UserBranchRole and the
// backfilled UserRoleScope rows without trusting the backfill's own return
// value. Assumes every UserRoleScope row in the database originated from this
// backfill (true as of Phase 1C: Phase 1B never writes UserRoleScope rows —
// see user-role-scope.test.ts — and OWNER's company-wide authority is
// implicit, never a row); a later phase that starts writing UserRoleScope
// rows through some other path must revisit this assumption. Duplicate
// detection here is defense-in-depth: the raw-SQL partial unique indexes
// (uq_user_role_scope_location / uq_user_role_scope_company, see
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
    if (scope.scopeKind !== 'LOCATION' || scope.locationId === null) {
      issues.push(`UserRoleScope ${scope.id} is not a LOCATION-scoped backfilled row as expected`);
    }
  }
  for (const [key, count] of scopeKeyCounts) {
    if (count > 1) issues.push(`duplicate UserRoleScope for ${key}`);
  }

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
    if (!scopeKeyCounts.has(key)) {
      issues.push(
        `missing UserRoleScope for UserBranchRole ${legacy.id} (user ${legacy.userId}, ` +
          `role ${legacy.role.code} -> ${targetRoleCode}, location ${legacy.branchId})`,
      );
    }
  }

  if (scopes.length !== legacyRows.length) {
    issues.push(
      `expected ${legacyRows.length} UserRoleScope row(s) (one per UserBranchRole), found ${scopes.length}`,
    );
  }

  return {
    ok: issues.length === 0,
    issues,
    legacyRowCount: legacyRows.length,
    scopeCount: scopes.length,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd api && NODE_ENV=test npx vitest run tests/rbac/scope-backfill.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add api/src/modules/rbac/scope-backfill.service.ts api/tests/rbac/scope-backfill.test.ts
git commit -m "feat(rbac): verify UserRoleScope backfill row-by-row equivalence (Phase 1C)"
```

---

### Task 4: CLI script, wiring, and DEPRECATE documentation

**Files:**
- Create: `api/scripts/backfill-user-role-scope.ts`
- Modify: `api/package.json`
- Modify: `api/src/modules/rbac/index.ts`
- Modify: `api/prisma/schema.prisma`
- Modify: `docs/development/getting-started.md`

**Interfaces:**
- Consumes: `backfillUserRoleScopeFromUserBranchRole`, `verifyUserRoleScopeBackfill` (Task 2/3); `openSeedDatabase` from `api/scripts/demo-database.ts`.
- Produces: `npm run db:backfill-user-role-scope -- --target=<demo|test>` CLI command; `scope-backfill.service.js` re-exported from `api/src/modules/rbac/index.ts`.

- [ ] **Step 1: Write the CLI script**

```ts
// api/scripts/backfill-user-role-scope.ts
import { openSeedDatabase } from './demo-database.js';
import {
  backfillUserRoleScopeFromUserBranchRole,
  verifyUserRoleScopeBackfill,
} from '../src/modules/rbac/scope-backfill.service.js';

type Target = 'demo' | 'test';

function parseTarget(argv: string[]): Target | null {
  const arg = argv.find((a) => a.startsWith('--target='));
  const value = arg?.split('=')[1];
  return value === 'demo' || value === 'test' ? value : null;
}

const target = parseTarget(process.argv.slice(2));
if (!target) {
  console.error('[db:backfill-user-role-scope] FAIL: --target=demo or --target=test is required');
  process.exitCode = 1;
} else {
  try {
    const db = await openSeedDatabase(target);
    try {
      const result = await backfillUserRoleScopeFromUserBranchRole(db.prisma);
      const verification = await verifyUserRoleScopeBackfill(db.prisma);
      if (!verification.ok) {
        throw new Error(`verification failed: ${verification.issues.join('; ')}`);
      }
      console.log('[db:backfill-user-role-scope] OK');
      console.log(`  target: ${target}`);
      console.log(`  legacy UserBranchRole rows: ${result.legacyRowCount}`);
      console.log(`  created: ${result.created}`);
      console.log(`  already present: ${result.alreadyPresent}`);
      console.log(`  verified UserRoleScope rows: ${verification.scopeCount}`);
    } finally {
      await db.close();
    }
  } catch (err) {
    console.error(
      `[db:backfill-user-role-scope] FAIL: ${err instanceof Error ? err.message : 'unknown error'}`,
    );
    process.exitCode = 1;
  }
}
```

- [ ] **Step 2: Wire the npm script**

In `api/package.json`, add a line right after `"db:bootstrap-rbac-catalog"`:

```json
    "db:bootstrap-rbac-catalog": "tsx scripts/bootstrap-rbac-catalog.ts",
    "db:backfill-user-role-scope": "tsx scripts/backfill-user-role-scope.ts",
```

- [ ] **Step 3: Re-export from the rbac module barrel and update its header comment**

In `api/src/modules/rbac/index.ts`, add the export and correct the now-stale "Explicitly NOT in this module" note:

```ts
// Phase 1B (Production V1) RBAC module: typed role/permission/scope
// definitions from docs/production-v1/03-role-permission-matrix.md and
// 05-architecture.md §5, plus an additive Production catalog bootstrap.
//   - typed Production role codes (roles.ts) and permission codes
//     (permissions.ts)
//   - deterministic default role -> permission grants (role-permission-matrix.ts)
//   - a scope-consistency domain helper mirroring the DB CHECK (scope.ts)
//   - additive Role/Permission/RolePermission catalog bootstrap
//     (catalog.service.ts) — creates the 5 Production roles and 33
//     permissions if absent, and persists their default grants; never
//     touches legacy `MANAGER`, legacy lowercase Permission codes, or any
//     `UserBranchRole` row
//   - Phase 1C: explicit legacy role mapping (legacy-role-map.ts) and the
//     UserRoleScope backfill/verify pair (scope-backfill.service.ts) —
//     reads UserBranchRole, never mutates it
// Explicitly NOT in this module (deferred to Phase 1D, per
// docs/production-v1/08-implementation-roadmap.md):
//   - no requirePermission-style middleware or route wiring
//   - no switch of application reads/writes from UserBranchRole to UserRoleScope
export * from './roles.js';
export * from './permissions.js';
export * from './role-permission-matrix.js';
export * from './scope.js';
export * from './catalog.service.js';
export * from './legacy-role-map.js';
export * from './scope-backfill.service.js';
```

- [ ] **Step 4: Mark `UserBranchRole` DEPRECATE in schema.prisma, precisely**

This comment is worth adding only because it documents a real, otherwise-invisible split introduced by Task 6/7, not a generic "superseded" note. In `api/prisma/schema.prisma`, add this comment directly above `model UserBranchRole {`:

```prisma
// Phase 1C (Production V1) DEPRECATE step — transitional split, not a full
// handoff: UserRoleScope (backfilled 1:1 from this table by
// api/src/modules/rbac/scope-backfill.service.ts) is now the authoritative
// source for LOCATION/COMPANY scope resolution (`req.auth.branchIds`, wired
// in api/src/middleware/auth.ts and api/src/modules/auth/auth.service.ts,
// with a fallback to this table's data where UserRoleScope has not been
// backfilled yet). This table remains the sole, unmodified source for role
// codes and the legacy permission vocabulary (`req.auth.roles`/
// `req.auth.permissions`) until Phase 1D. REMOVE happens only after that
// full compatibility window closes (docs/development/migrations.md §16).
model UserBranchRole {
```

Also append a short addendum to the existing Phase 1B comment above `model UserRoleScope {` (do not rewrite it — it correctly documents Phase 1B's own additive-only state):

```prisma
// Phase 1C addendum: UserRoleScope is now backfilled from UserBranchRole
// (scope-backfill.service.ts) and is the authoritative LOCATION/COMPANY
// scope source read at request time (api/src/modules/rbac/effective-branch-ids.ts,
// consumed by api/src/middleware/auth.ts and auth.service.ts) — falling back
// to UserBranchRole only where a user has not been backfilled yet. Role code
// and permission vocabulary resolution stay on UserBranchRole/legacy
// Role/Permission until Phase 1D.
model UserRoleScope {
```

- [ ] **Step 5: Document the command**

In `docs/development/getting-started.md`, insert a new section right after the existing "Organization Bootstrap (Company / Location — Production V1 Phase 1A)" section (before "## Startup Order"):

```markdown
## Scope Assignment Backfill (UserRoleScope — Production V1 Phase 1C)

`UserRoleScope` (added empty in Phase 1B) is backfilled 1:1 from the existing
`UserBranchRole` rows: legacy `MANAGER` assignments map explicitly to the
Production `WAREHOUSE` role (`docs/production-v1/06-erd-data-model.md` §2.2
ROLE: "codes changed: MANAGER→WAREHOUSE"); `ADMIN`/`CASHIER`/`SELLER` keep
their own code. Every backfilled row is `LOCATION`-scoped, reusing the source
`UserBranchRole.branchId` as `locationId` (`Location.id == Branch.id`, from
the Organization Bootstrap above) — `COMPANY` scope is never inferred.

Requires the Company/Location backfill above and the Phase 1B RBAC catalog
bootstrap to have already run:

```bash
cd api
npm run db:bootstrap-rbac-catalog -- --target=demo
npm run db:backfill-user-role-scope -- --target=demo
```

Expected success:

```text
[db:backfill-user-role-scope] OK
  target: demo
  legacy UserBranchRole rows: 9
  created: 9
  already present: 0
  verified UserRoleScope rows: 9
```

Idempotent and safe to rerun. `UserBranchRole` stays fully intact and is
still the source for role codes and permissions; Task 6 switches `branchIds`
(LOCATION/COMPANY scope) to read from `UserRoleScope`, falling back to
`UserBranchRole` for any user this backfill has not reached yet. Task 7 keeps
this in sync automatically on every future `demo:reset`/`db:reset` once the
Company/Location backfill above has run at least once.
```

- [ ] **Step 6: Run it against the test database and verify**

Run: `cd api && NODE_ENV=test npm run db:backfill-user-role-scope -- --target=test`
Expected: exits 0, prints `[db:backfill-user-role-scope] OK` with `legacy UserBranchRole rows: 9`, `created: 9` (or `alreadyPresent: 9` if the suite already backfilled the test DB in this run), `verified UserRoleScope rows: 9`.

- [ ] **Step 7: Run the full verification suite**

Run: `cd api && npm run typecheck && npm run lint && NODE_ENV=test npm test`
Expected: all three pass, with `api/tests/rbac/legacy-role-map.test.ts` and `api/tests/rbac/scope-backfill.test.ts` green alongside the existing suite (including `api/tests/rbac/catalog.test.ts` and `api/tests/rbac/user-role-scope.test.ts`, which must remain unaffected since neither `UserBranchRole` nor the Phase 1B catalog is touched by this phase's changes).

- [ ] **Step 8: Commit**

```bash
git add api/scripts/backfill-user-role-scope.ts api/package.json api/src/modules/rbac/index.ts api/prisma/schema.prisma docs/development/getting-started.md
git commit -m "feat(rbac): expose UserRoleScope backfill CLI and document Phase 1C DEPRECATE status"
```

---

### Task 5: Scope resolver (pure, read-only `UserRoleScope` reader)

This builds the authoritative `UserRoleScope` reader itself — the roadmap's "scoped authorization service" deliverable — as a standalone, pure module with no knowledge of HTTP, `req.auth`, or the legacy permission vocabulary. Task 6 is what actually wires it into the live request path (the runtime half of the SWITCH); this task on its own is inert (nothing imports it yet) and can be done independently of Task 4 (order between them does not matter — neither depends on the other's output).

**Files:**
- Create: `api/src/modules/rbac/scope-resolver.ts`
- Create: `api/tests/rbac/scope-resolver.test.ts`
- Modify: `api/src/modules/rbac/index.ts`

**Interfaces:**
- Consumes: the same `db.prisma` / seeded-and-backfilled fixture pattern as Task 2/3 (`openSeedDatabase`, `resetDemo`, `backfillLocationsFromBranches`, `bootstrapProductionRbacCatalog`, `backfillUserRoleScopeFromUserBranchRole`).
- Produces: `resolveUserRoleScopes(db, userId): Promise<ResolvedRoleScope[]>` where `ResolvedRoleScope = { roleId: string; roleCode: string; scopeKind: 'LOCATION' | 'COMPANY'; locationId: string | null }` — this is the function Phase 1D's guards must call; nothing in this plan calls it.

- [ ] **Step 1: Write the failing test**

```ts
// api/tests/rbac/scope-resolver.test.ts
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { resetDemo } from '../../prisma/seed.js';
import { openSeedDatabase } from '../../scripts/demo-database.js';
import {
  backfillLocationsFromBranches,
  type CompanyBootstrap,
} from '../../src/modules/organization/organization.service.js';
import { bootstrapProductionRbacCatalog } from '../../src/modules/rbac/catalog.service.js';
import { backfillUserRoleScopeFromUserBranchRole } from '../../src/modules/rbac/scope-backfill.service.js';
import { resolveUserRoleScopes } from '../../src/modules/rbac/scope-resolver.js';

// Phase 1C SWITCH step: the authoritative UserRoleScope reader. Read-only —
// this suite proves it reflects the backfilled data correctly; it does not
// exercise any live route or middleware (none call it yet, by design).
describe('UserRoleScope resolver (Phase 1C SWITCH)', () => {
  let db: Awaited<ReturnType<typeof openSeedDatabase>>;

  const FALLBACK_COMPANY_BOOTSTRAP: CompanyBootstrap = {
    id: '00000000-0000-4000-9400-000000000001',
    name: 'Mona Jacinta (scope resolver test)',
    cuit: '00-44444444-4',
    address: 'Dirección legal test — pendiente de dato real',
  };

  async function safely<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch {
      throw new Error('Scope resolver integration operation failed (database details suppressed)');
    }
  }

  beforeAll(async () => {
    db = await safely(() => openSeedDatabase('test'));
    await safely(() => resetDemo(db.prisma));
    const existingCompany = await db.prisma.company.findFirst();
    const bootstrap: CompanyBootstrap = existingCompany
      ? {
          id: existingCompany.id,
          name: existingCompany.name,
          cuit: existingCompany.cuit,
          address: existingCompany.address,
        }
      : FALLBACK_COMPANY_BOOTSTRAP;
    await safely(() => backfillLocationsFromBranches(db.prisma, bootstrap));
    await safely(() => bootstrapProductionRbacCatalog(db.prisma));
  }, 120000);

  afterEach(async () => {
    await safely(() => db.prisma.userRoleScope.deleteMany());
  });

  afterAll(async () => {
    if (db) await safely(() => db.close());
  });

  it('resolves the backfilled LOCATION scope for a legacy MANAGER user as WAREHOUSE', async () => {
    await backfillUserRoleScopeFromUserBranchRole(db.prisma);
    const manager = await db.prisma.user.findFirstOrThrow({ where: { name: 'manager01' } });
    const legacyAssignment = await db.prisma.userBranchRole.findFirstOrThrow({
      where: { userId: manager.id },
    });

    const scopes = await resolveUserRoleScopes(db.prisma, manager.id);
    expect(scopes).toHaveLength(1);
    expect(scopes[0]).toMatchObject({
      roleCode: 'WAREHOUSE',
      scopeKind: 'LOCATION',
      locationId: legacyAssignment.branchId,
    });
  });

  it('resolves all 6 LOCATION scopes for the legacy ADMIN user', async () => {
    await backfillUserRoleScopeFromUserBranchRole(db.prisma);
    const admin = await db.prisma.user.findFirstOrThrow({ where: { name: 'admin' } });
    const scopes = await resolveUserRoleScopes(db.prisma, admin.id);
    expect(scopes).toHaveLength(6);
    expect(scopes.every((s) => s.roleCode === 'ADMIN' && s.scopeKind === 'LOCATION')).toBe(true);
  });

  it('returns an empty list for a user with no UserRoleScope rows', async () => {
    const seller = await db.prisma.user.findFirstOrThrow({ where: { name: 'seller01' } });
    const scopes = await resolveUserRoleScopes(db.prisma, seller.id);
    expect(scopes).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd api && NODE_ENV=test npx vitest run tests/rbac/scope-resolver.test.ts`
Expected: FAIL — cannot find module `../../src/modules/rbac/scope-resolver.js`.

- [ ] **Step 3: Write the implementation**

```ts
// api/src/modules/rbac/scope-resolver.ts
import type { PrismaClient } from '../../generated/prisma/client.js';

export type ResolvedRoleScope = {
  roleId: string;
  roleCode: string;
  scopeKind: 'LOCATION' | 'COMPANY';
  locationId: string | null;
};

type ScopeResolverDatabase = Pick<PrismaClient, 'userRoleScope'>;

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
export async function resolveUserRoleScopes(
  db: ScopeResolverDatabase,
  userId: string,
): Promise<ResolvedRoleScope[]> {
  const rows = await db.userRoleScope.findMany({
    where: { userId },
    include: { role: { select: { code: true } } },
  });
  return rows.map((row) => ({
    roleId: row.roleId,
    roleCode: row.role.code,
    scopeKind: row.scopeKind,
    locationId: row.locationId,
  }));
}
```

Then add its export to `api/src/modules/rbac/index.ts` (`export * from './scope-resolver.js';`, alongside the `legacy-role-map.js`/`scope-backfill.service.js` exports added in Task 4).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd api && NODE_ENV=test npx vitest run tests/rbac/scope-resolver.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add api/src/modules/rbac/scope-resolver.ts api/tests/rbac/scope-resolver.test.ts api/src/modules/rbac/index.ts
git commit -m "feat(rbac): add authoritative UserRoleScope resolver (Phase 1C SWITCH step)"
```

---

### Task 6: Wire the resolver into the real request path (the runtime SWITCH)

This is the task that actually makes the exit criterion ("UserRoleScope authoritative") true at runtime, per the corrected boundary analysis above. It touches exactly two files beyond the new shared policy module — `api/src/middleware/auth.ts` (the real per-request source of `req.auth.branchIds`) and `api/src/modules/auth/auth.service.ts` (`/login` + `/me` response bodies) — and in both, only the `branchIds` line. `authorization.ts` is not touched; `roles`/`permissions` in both files are not touched.

**Files:**
- Create: `api/src/modules/rbac/effective-branch-ids.ts`
- Modify: `api/src/middleware/auth.ts`
- Modify: `api/src/modules/auth/auth.service.ts`
- Modify: `api/src/modules/rbac/index.ts`
- Create: `api/tests/auth-scope-switch.test.ts` (fast, stub-database unit test of `middleware/auth.ts`)
- Create: `api/tests/auth/login-scope-switch.test.ts` (real-DB integration test of `/login`'s response body)

**Interfaces:**
- Consumes: `resolveUserRoleScopes` (Task 5).
- Produces: `resolveEffectiveBranchIds(db, userId, legacyBranchIds): Promise<string[]>` — consumed by both `middleware/auth.ts` and `auth.service.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
// api/tests/auth-scope-switch.test.ts
import express from 'express';
import request from 'supertest';
import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { env } from '../src/config/env.js';
import { createRequireAuth } from '../src/middleware/auth.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { sendJson } from '../src/shared/json-safe.js';

const key = new TextEncoder().encode(env.JWT_SECRET);
const now = Math.floor(Date.now() / 1000);

function buildApp(database: PrismaClient) {
  const app = express();
  app.get('/private', createRequireAuth(database), (req, res) => {
    sendJson(res, { branchIds: req.auth?.branchIds, roles: req.auth?.roles });
  });
  app.use(errorHandler);
  return app;
}

async function token() {
  return new SignJWT()
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('test-user')
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(key);
}

function stubUser(branchIds: string[]) {
  return {
    id: 'test-user',
    isActive: true,
    branchRoles: branchIds.map((branchId) => ({
      branchId,
      role: { code: 'SELLER', permissions: [] },
    })),
  };
}

// Proves the real per-request path (middleware/auth.ts, which is what
// authorization.ts's assertBranchAccess/requirePermission actually enforce
// against) switches branchIds to UserRoleScope, not just auth.service.ts's
// /login and /me response bodies. Uses a stub database (same style as the
// existing api/tests/auth.test.ts) so this is fast and does not need a real
// Postgres connection.
describe('middleware/auth.ts branchIds resolution (Phase 1C SWITCH)', () => {
  it('prefers UserRoleScope over legacy UserBranchRole when it has been backfilled for this user', async () => {
    const testDatabase = {
      user: { findUnique: async () => stubUser(['legacy-branch']) },
      userRoleScope: {
        findMany: async () => [
          { roleId: 'r1', role: { code: 'SELLER' }, scopeKind: 'LOCATION', locationId: 'switched-location' },
        ],
      },
    } as unknown as PrismaClient;
    const response = await request(buildApp(testDatabase))
      .get('/private')
      .auth(await token(), { type: 'bearer' });
    expect(response.status).toBe(200);
    expect(response.body.branchIds).toEqual(['switched-location']);
  });

  it('falls back to legacy UserBranchRole-derived branchIds when UserRoleScope has not been backfilled for this user', async () => {
    const testDatabase = {
      user: { findUnique: async () => stubUser(['legacy-branch']) },
      userRoleScope: { findMany: async () => [] },
    } as unknown as PrismaClient;
    const response = await request(buildApp(testDatabase))
      .get('/private')
      .auth(await token(), { type: 'bearer' });
    expect(response.status).toBe(200);
    expect(response.body.branchIds).toEqual(['legacy-branch']);
  });

  it('fails closed (500) on an unexpected COMPANY-scoped row instead of guessing', async () => {
    const testDatabase = {
      user: { findUnique: async () => stubUser(['legacy-branch']) },
      userRoleScope: {
        findMany: async () => [
          { roleId: 'r1', role: { code: 'ADMIN' }, scopeKind: 'COMPANY', locationId: null },
        ],
      },
    } as unknown as PrismaClient;
    const response = await request(buildApp(testDatabase))
      .get('/private')
      .auth(await token(), { type: 'bearer' });
    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe('UNSUPPORTED_SCOPE');
  });
});
```

```ts
// api/tests/auth/login-scope-switch.test.ts
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { rolePermissions, seedDemo } from '../../prisma/seed.js';
import { createApp } from '../../src/app.js';
import { createTestPrismaClient, truncateAllTables } from '../helpers/test-db.js';

// Real-DB confirmation that auth.service.ts's /login response body (used by
// GET /me too, via the same resolveEffectiveBranchIds policy) reflects the
// Phase 1C switch. Complements auth-scope-switch.test.ts, which proves the
// same policy in the actual per-request middleware path.
describe('POST /api/v1/auth/login branchIds (Phase 1C SWITCH)', () => {
  let prisma: Awaited<ReturnType<typeof createTestPrismaClient>>;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    prisma = await createTestPrismaClient();
    app = createApp(prisma);
  });
  beforeEach(async () => {
    await truncateAllTables(prisma);
    await seedDemo(prisma);
  });
  afterAll(async () => prisma.$disconnect());

  it('falls back to the legacy UserBranchRole-derived branchIds when UserRoleScope has not been backfilled for this user', async () => {
    const seller = await prisma.user.findUniqueOrThrow({ where: { email: 'seller01@demo.local' } });
    await prisma.userRoleScope.deleteMany({ where: { userId: seller.id } });
    const legacyAssignment = await prisma.userBranchRole.findFirstOrThrow({
      where: { userId: seller.id },
    });

    const response = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'seller01@demo.local', password: 'demo123' });
    expect(response.status).toBe(200);
    expect(response.body.user.branchIds).toEqual([legacyAssignment.branchId]);
  });

  it('prefers UserRoleScope over legacy UserBranchRole once it has been backfilled for this user', async () => {
    const seller = await prisma.user.findUniqueOrThrow({ where: { email: 'seller01@demo.local' } });
    const sellerRole = await prisma.role.findUniqueOrThrow({ where: { code: 'SELLER' } });
    const company = await prisma.company.create({
      data: { name: 'Auth switch test company', cuit: `TEST-${randomUUID()}`, address: 'Test address' },
    });
    const extraLocation = await prisma.location.create({
      data: {
        companyId: company.id,
        name: 'Extra Location',
        code: `EXTRA-${randomUUID()}`,
        type: 'RETAIL_BRANCH',
        address: 'Test address',
        pointOfSaleNumber: Number(process.hrtime.bigint() % 1000000n),
      },
    });
    try {
      await prisma.userRoleScope.create({
        data: {
          userId: seller.id,
          roleId: sellerRole.id,
          scopeKind: 'LOCATION',
          locationId: extraLocation.id,
        },
      });

      const response = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'seller01@demo.local', password: 'demo123' });
      expect(response.status).toBe(200);
      expect(response.body.user.branchIds).toEqual([extraLocation.id]);
    } finally {
      await prisma.location.delete({ where: { id: extraLocation.id } });
      await prisma.company.delete({ where: { id: company.id } });
    }
  });

  it("does not change MANAGER's effective legacy roles or permissions", async () => {
    const response = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'manager01@demo.local', password: 'demo123' });
    expect(response.status).toBe(200);
    expect(response.body.user.roles).toEqual(['MANAGER']);
    expect(response.body.user.permissions.sort()).toEqual([...rolePermissions.MANAGER].sort());
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd api && npx vitest run tests/auth-scope-switch.test.ts` — Expected: FAIL, `resolveEffectiveBranchIds`/`effective-branch-ids.js` does not exist, `req.auth.branchIds` still computed inline from `UserBranchRole` only.
Run: `cd api && NODE_ENV=test npx vitest run tests/auth/login-scope-switch.test.ts` — Expected: the "prefers" test FAILs (branchIds still includes the legacy branch, not `extraLocation.id`); the other two pass already (today's unmodified behavior happens to satisfy them).

- [ ] **Step 3: Write the implementation**

```ts
// api/src/modules/rbac/effective-branch-ids.ts
import type { PrismaClient } from '../../generated/prisma/client.js';
import { AppError } from '../../shared/errors.js';
import { resolveUserRoleScopes } from './scope-resolver.js';

type EffectiveBranchIdsDatabase = Pick<PrismaClient, 'userRoleScope'>;

// Phase 1C SWITCH policy (docs/production-v1/08-implementation-roadmap.md
// Phase 1C: "SWITCH authorization reads/writes"). Shared by the two real
// consumers of a user's branch/location scope — api/src/middleware/auth.ts
// (builds req.auth.branchIds on every authenticated request; this is what
// api/src/middleware/authorization.ts's assertBranchAccess/requirePermission
// actually enforce against) and api/src/modules/auth/auth.service.ts (the
// /login and /me response bodies) — so this policy exists in exactly one
// place, not duplicated and at risk of drifting between the two.
//
// UserRoleScope is authoritative whenever it has been backfilled for this
// user (scope-backfill.service.ts): only its LOCATION rows are used, never
// merged with the legacy UserBranchRole-derived ids. When it has not been
// backfilled yet for this user/database — a database that has not run the
// Phase 1A Location backfill and/or the Phase 1C UserRoleScope backfill,
// including this repository's second, independent test-database bootstrap
// path (api/tests/helpers/test-db.ts's truncateAllTables, which never
// touches Company/Location) — this falls back to the exact legacy
// UserBranchRole-derived set, reproducing today's behavior exactly. This
// never fails a login or a request just because a given environment or test
// harness has not migrated yet.
//
// A COMPANY-scoped row is never produced by Phase 1C's backfill (it only
// ever writes LOCATION scope). Encountering one here would mean some other,
// not-yet-built path started writing COMPANY-scope rows before Phase 1D's
// real COMPANY/OWNER-aware scope enforcement exists to interpret them —
// this fails closed (500) rather than silently treating COMPANY as "all
// branches" or "no branches".
export async function resolveEffectiveBranchIds(
  db: EffectiveBranchIdsDatabase,
  userId: string,
  legacyBranchIds: string[],
): Promise<string[]> {
  const roleScopes = await resolveUserRoleScopes(db, userId);
  if (roleScopes.length === 0) return legacyBranchIds;

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
```

Add its export to `api/src/modules/rbac/index.ts` (`export * from './effective-branch-ids.js';`).

Then, in `api/src/middleware/auth.ts`, add the import and replace only the `branchIds` line:

```ts
import { resolveEffectiveBranchIds } from '../modules/rbac/effective-branch-ids.js';
```

```ts
      const roles = [...new Set(user.branchRoles.map(({ role }) => role.code))];
      const legacyBranchIds = [...new Set(user.branchRoles.map(({ branchId }) => branchId))];
      const branchIds = await resolveEffectiveBranchIds(database, user.id, legacyBranchIds);
      const permissions = [
        ...new Set(
          user.branchRoles.flatMap(({ role }) =>
            role.permissions.map(({ permission }) => permission.code),
          ),
        ),
      ];
```

(`roles` and `permissions` lines are otherwise byte-identical to today.)

Then, in `api/src/modules/auth/auth.service.ts`:

```ts
import type { PrismaClient } from '../../generated/prisma/client.js';
import { AppError } from '../../shared/errors.js';
import { resolveEffectiveBranchIds } from '../rbac/effective-branch-ids.js';
import { verifyPassword } from './password.js';
import { signAccessToken } from './tokens.js';
import type { LoginInput } from './dto/login.dto.js';

type AuthDatabase = Pick<PrismaClient, 'user' | 'userRoleScope'>;

type UserContext = {
  id: string;
  name: string;
  email: string;
  roles: string[];
  branchIds: string[];
  permissions: string[];
};

const userSelect = {
  id: true,
  name: true,
  email: true,
  isActive: true,
  passwordHash: true,
  branchRoles: {
    select: {
      branchId: true,
      role: {
        select: {
          code: true,
          permissions: { select: { permission: { select: { code: true } } } },
        },
      },
    },
  },
} as const;

async function contextFromUser(
  database: AuthDatabase,
  user: {
    id: string;
    name: string;
    email: string;
    branchRoles: Array<{
      branchId: string;
      role: { code: string; permissions: Array<{ permission: { code: string } }> };
    }>;
  },
): Promise<UserContext> {
  const legacyBranchIds = [...new Set(user.branchRoles.map(({ branchId }) => branchId))];
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    roles: [...new Set(user.branchRoles.map(({ role }) => role.code))],
    branchIds: await resolveEffectiveBranchIds(database, user.id, legacyBranchIds),
    permissions: [
      ...new Set(
        user.branchRoles.flatMap(({ role }) =>
          role.permissions.map(({ permission }) => permission.code),
        ),
      ),
    ],
  };
}

export async function resolveUserContext(
  database: AuthDatabase,
  userId: string,
): Promise<UserContext> {
  const user = await database.user.findUnique({ where: { id: userId }, select: userSelect });
  if (!user) throw new AppError(401, 'UNAUTHORIZED', 'El token no es válido.');
  if (!user.isActive)
    throw new AppError(403, 'INACTIVE_USER', 'El usuario está inactivo.');
  return contextFromUser(database, user);
}

export async function login(database: AuthDatabase, input: LoginInput) {
  const user = await database.user.findUnique({ where: { email: input.email }, select: userSelect });
  if (!user || !(await verifyPassword(input.password, user.passwordHash)))
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Las credenciales no son válidas.');
  if (!user.isActive)
    throw new AppError(403, 'INACTIVE_USER', 'El usuario está inactivo.');
  const context = await contextFromUser(database, user);
  return { accessToken: await signAccessToken(user.id), user: context };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd api && npx vitest run tests/auth-scope-switch.test.ts` — Expected: PASS (3 tests).
Run: `cd api && NODE_ENV=test npx vitest run tests/auth/login-scope-switch.test.ts` — Expected: PASS (3 tests).
Run: `cd api && NODE_ENV=test npx vitest run tests/auth.test.ts tests/auth/login.test.ts tests/auth/me.test.ts tests/authorization.test.ts` — Expected: PASS, unchanged (these exercise only users/paths where the fallback applies, so they must show byte-identical behavior to before this task).

- [ ] **Step 5: Commit**

```bash
git add api/src/modules/rbac/effective-branch-ids.ts api/src/modules/rbac/index.ts api/src/middleware/auth.ts api/src/modules/auth/auth.service.ts api/tests/auth-scope-switch.test.ts api/tests/auth/login-scope-switch.test.ts
git commit -m "feat(auth): switch branchIds resolution to UserRoleScope with legacy fallback (Phase 1C SWITCH)"
```

---

### Task 7: Keep `UserRoleScope` in sync on every seed/reset

Closes the regression this review found: `prisma/seed.ts`'s `clear()` deletes `User`/`Role`, which cascades away any `UserRoleScope` rows, but `populate()` never recreated them — so `resetDemo()` would silently erase an already-backfilled `UserRoleScope` state. This wires Task 2's core `syncUserRoleScopeFromUserBranchRole` into `populate()`'s own existing transaction (never a nested one), skipping only when `Location` (Phase 1A) has never been bootstrapped for this database at all — which keeps the documented first-time bootstrap order (`demo:reset` before the Location backfill exists) working, while every subsequent reset/seed — the normal case for any database that has completed Phase 1A once — always keeps `UserRoleScope` correctly in sync, and fails the whole seed/reset closed if `UserBranchRole`/`Location` are ever left in a genuinely inconsistent state.

**Files:**
- Modify: `api/prisma/seed.ts`
- Modify: `api/tests/rbac/seed-integration.test.ts`
- Create: `api/tests/rbac/scope-seed-integration.test.ts`

**Interfaces:**
- Consumes: `syncUserRoleScopeFromUserBranchRole` (Task 2, revised split); `verifyUserRoleScopeBackfill` (Task 3).
- Produces: no new exports — `resetDemo`/`seedDemo`'s existing contract is unchanged, only their effect on `UserRoleScope` is fixed.

- [ ] **Step 1: Write the failing tests**

```ts
// api/tests/rbac/scope-seed-integration.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDemo, seedDemo } from '../../prisma/seed.js';
import { openSeedDatabase } from '../../scripts/demo-database.js';
import {
  backfillLocationsFromBranches,
  type CompanyBootstrap,
} from '../../src/modules/organization/organization.service.js';
import { verifyUserRoleScopeBackfill } from '../../src/modules/rbac/scope-backfill.service.js';

// Phase 1C seed/reset <-> UserRoleScope compatibility gate, analogous to
// seed-integration.test.ts's Phase 1B gate. Confirms the regression this
// plan's review found: clear() cascades UserRoleScope to 0 via its
// User/Role deletes, but populate() never used to recreate it — resetDemo()
// would silently regress an already-backfilled UserRoleScope state back to
// empty. Fixed by populate() calling
// rbac/scope-backfill.service.ts's syncUserRoleScopeFromUserBranchRole(tx)
// as its last step, on the same transaction — never a nested one — and only
// when Location (Phase 1A) already exists for this database (see the first
// test below for the genuinely-brand-new-database case).
describe('Demo seed/reset lifecycle preserves the UserRoleScope backfill (Phase 1C)', () => {
  let db: Awaited<ReturnType<typeof openSeedDatabase>>;

  const FALLBACK_COMPANY_BOOTSTRAP: CompanyBootstrap = {
    id: '00000000-0000-4000-9500-000000000001',
    name: 'Mona Jacinta (scope seed integration test)',
    cuit: '00-55555555-5',
    address: 'Dirección legal test — pendiente de dato real',
  };

  async function safely<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch {
      throw new Error('Seed/scope integration operation failed (database details suppressed)');
    }
  }

  async function ensureLocationBootstrap() {
    const existingCompany = await db.prisma.company.findFirst();
    const bootstrap: CompanyBootstrap = existingCompany
      ? {
          id: existingCompany.id,
          name: existingCompany.name,
          cuit: existingCompany.cuit,
          address: existingCompany.address,
        }
      : FALLBACK_COMPANY_BOOTSTRAP;
    await safely(() => backfillLocationsFromBranches(db.prisma, bootstrap));
  }

  async function expectFullPhase1CState() {
    expect(await db.prisma.userBranchRole.count()).toBe(9);
    expect(await db.prisma.userRoleScope.count()).toBe(9);
    const verification = await verifyUserRoleScopeBackfill(db.prisma);
    expect(verification.ok).toBe(true);
    expect(verification.issues).toEqual([]);

    const manager = await db.prisma.user.findFirstOrThrow({ where: { name: 'manager01' } });
    const warehouseRole = await db.prisma.role.findFirstOrThrow({ where: { code: 'WAREHOUSE' } });
    const managerScope = await db.prisma.userRoleScope.findFirstOrThrow({
      where: { userId: manager.id },
    });
    expect(managerScope.roleId).toBe(warehouseRole.id);
    expect(managerScope.scopeKind).toBe('LOCATION');

    expect(await db.prisma.userRoleScope.count({ where: { scopeKind: 'COMPANY' } })).toBe(0);
    const ownerRole = await db.prisma.role.findFirst({ where: { code: 'OWNER' } });
    if (ownerRole) {
      expect(await db.prisma.userRoleScope.count({ where: { roleId: ownerRole.id } })).toBe(0);
    }
  }

  beforeAll(async () => {
    db = await safely(() => openSeedDatabase('test'));
  }, 120000);

  afterAll(async () => {
    if (db) await safely(() => db.close());
  });

  // Intentionally the first test: proves resetDemo never fails on a database
  // where Location (Phase 1A) has genuinely never been backfilled, and
  // restores Location afterward so every later test in this file can assume
  // it is present (Location is never deleted by clear()/populate(), so once
  // restored here it persists for the rest of this file's tests).
  it('resetDemo succeeds and leaves UserRoleScope empty when Location has never been backfilled yet', async () => {
    await db.prisma.location.deleteMany();
    await safely(() => resetDemo(db.prisma));
    expect(await db.prisma.location.count()).toBe(0);
    expect(await db.prisma.userBranchRole.count()).toBe(9);
    expect(await db.prisma.userRoleScope.count()).toBe(0);

    await ensureLocationBootstrap();
  }, 120000);

  it('resetDemo alone (no separate backfill call) produces the full Phase 1C scope state once Location exists', async () => {
    await safely(() => resetDemo(db.prisma));
    await expectFullPhase1CState();
  }, 120000);

  it('a second resetDemo from scratch converges to the identical logical scope mapping', async () => {
    await safely(() => resetDemo(db.prisma));
    await expectFullPhase1CState();
    const before = (await db.prisma.userRoleScope.findMany())
      .map((s) => `${s.userId}|${s.roleId}|${s.scopeKind}|${s.locationId}`)
      .sort();

    await safely(() => resetDemo(db.prisma));
    await expectFullPhase1CState();
    const after = (await db.prisma.userRoleScope.findMany())
      .map((s) => `${s.userId}|${s.roleId}|${s.scopeKind}|${s.locationId}`)
      .sort();

    expect(after).toEqual(before);
  }, 120000);

  it('seedDemo (without reset) does not duplicate or corrupt the scope state', async () => {
    await safely(() => resetDemo(db.prisma));
    await expectFullPhase1CState();
    await safely(() => seedDemo(db.prisma));
    await expectFullPhase1CState();
  }, 120000);

  it('repeated seed/reset cycles converge to the same logical scope state', async () => {
    await safely(() => resetDemo(db.prisma));
    await expectFullPhase1CState();
    await safely(() => seedDemo(db.prisma));
    await expectFullPhase1CState();
    await safely(() => resetDemo(db.prisma));
    await expectFullPhase1CState();
    await safely(() => resetDemo(db.prisma));
    await expectFullPhase1CState();
  }, 180000);
});
```

Also modify `api/tests/rbac/seed-integration.test.ts` so its own Phase 1B assertions stay correct once Location may already exist (from this new file, or any `rbac/scope-*` file — file execution order is otherwise fragile to depend on):

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDemo, seedDemo } from '../../prisma/seed.js';
import { openSeedDatabase } from '../../scripts/demo-database.js';
import {
  backfillLocationsFromBranches,
  type CompanyBootstrap,
} from '../../src/modules/organization/organization.service.js';
import {
  CANONICAL_PERMISSION_IDS,
  CANONICAL_ROLE_IDS,
  DEFAULT_ROLE_GRANTS,
  productionPermissionValues,
  ROLE_CODES,
  verifyProductionRbacCatalog,
} from '../../src/modules/rbac/index.js';

describe('Demo seed/reset lifecycle preserves the Production RBAC catalog (Phase 1B)', () => {
  let db: Awaited<ReturnType<typeof openSeedDatabase>>;

  const FALLBACK_COMPANY_BOOTSTRAP: CompanyBootstrap = {
    id: '00000000-0000-4000-9600-000000000001',
    name: 'Mona Jacinta (rbac seed integration test)',
    cuit: '00-66666666-6',
    address: 'Dirección legal test — pendiente de dato real',
  };

  async function safely<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch {
      throw new Error('Seed/RBAC integration operation failed (database details suppressed)');
    }
  }

  // This file's own Phase 1B assertions must not depend on whether some
  // other file already backfilled Location — ensure it here too (idempotent,
  // reuses an existing Company if one already exists) so
  // expectFullPhase1BState()'s UserRoleScope count is deterministic
  // regardless of test file execution order or standalone runs.
  async function ensureLocationBootstrap() {
    const existingCompany = await db.prisma.company.findFirst();
    const bootstrap: CompanyBootstrap = existingCompany
      ? {
          id: existingCompany.id,
          name: existingCompany.name,
          cuit: existingCompany.cuit,
          address: existingCompany.address,
        }
      : FALLBACK_COMPANY_BOOTSTRAP;
    await safely(() => backfillLocationsFromBranches(db.prisma, bootstrap));
  }

  async function expectFullPhase1BState() {
    expect(await db.prisma.role.count()).toBe(6);
    expect(await db.prisma.permission.count()).toBe(45);
    expect(await db.prisma.rolePermission.count()).toBe(101);
    expect(await db.prisma.userBranchRole.count()).toBe(9);
    // Phase 1C addendum: with Location bootstrapped (ensured in beforeAll
    // below), populate() now also syncs UserRoleScope on every reset/seed —
    // see scope-seed-integration.test.ts for the dedicated Phase 1C checks.
    expect(await db.prisma.userRoleScope.count()).toBe(9);
    const verification = await verifyProductionRbacCatalog(db.prisma);
    expect(verification.ok).toBe(true);
    expect(verification.issues).toEqual([]);
  }

  beforeAll(async () => {
    db = await safely(() => openSeedDatabase('test'));
    await safely(() => resetDemo(db.prisma));
    await ensureLocationBootstrap();
  }, 120000);

  afterAll(async () => {
    if (db) await safely(() => db.close());
  });

  // ... the file's five existing `it(...)` blocks are otherwise unchanged ...
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd api && NODE_ENV=test npx vitest run tests/rbac/scope-seed-integration.test.ts` — Expected: FAIL (module resolves fine, but `userRoleScope.count()` is 0 after `resetDemo()` where the test expects 9 — `populate()` does not sync yet).
Run: `cd api && NODE_ENV=test npx vitest run tests/rbac/seed-integration.test.ts` — Expected: FAIL on the same `userRoleScope.count()` expectation (now `9`, still `0` in practice).

- [ ] **Step 3: Write the implementation**

In `api/prisma/seed.ts`, add the import and one call at the very end of `populate()` (after the existing `syncProductionRbacCatalog(tx)` call, which must run first so `WAREHOUSE`/`ADMIN`/etc. Role rows exist):

```ts
import { syncProductionRbacCatalog } from '../src/modules/rbac/catalog.service.js';
import { syncUserRoleScopeFromUserBranchRole } from '../src/modules/rbac/scope-backfill.service.js';
```

```ts
  // Phase 1B (Production V1): the Production RBAC catalog (roles, permissions,
  // grants) must exist after every successful seed/reset — see
  // api/src/modules/rbac/catalog.service.ts. Runs on this same transaction
  // (never a nested one) and after the legacy role/permission loop above,
  // since that loop's `rolePermission.deleteMany({ where: { roleId } })` for
  // reused roles (ADMIN/CASHIER/SELLER share their legacy Role.id) would
  // otherwise wipe Production grants added before it ran.
  await syncProductionRbacCatalog(tx);

  // Phase 1C (Production V1): keep UserRoleScope in sync with UserBranchRole
  // on every successful seed/reset — see
  // docs/production-v1/08-implementation-roadmap.md Phase 1C and
  // api/tests/rbac/scope-seed-integration.test.ts. Skipped only when
  // Company/Location (Phase 1A) has genuinely never been backfilled yet for
  // this database (a brand-new database, before its one-time
  // `db:backfill-company-location` run) — there is nothing to keep in sync
  // yet, and failing here would break the documented first-time bootstrap
  // order (demo:reset before the Location backfill exists at all,
  // docs/development/getting-started.md). Once Location exists (the normal
  // case for any database that has completed Phase 1A/1B bootstrap once),
  // this always runs, and any partial/inconsistent state (a Branch with no
  // matching Location) still fails the whole seed/reset closed, per
  // syncUserRoleScopeFromUserBranchRole's own fail-closed checks. Runs on
  // this same transaction — never a nested one — so a synchronization
  // failure rolls back the entire seed/reset, not just this step.
  if ((await tx.location.count()) > 0) {
    await syncUserRoleScopeFromUserBranchRole(tx);
  }
```

Then apply the `seed-integration.test.ts` edit shown in Step 1 above verbatim.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd api && NODE_ENV=test npx vitest run tests/rbac/scope-seed-integration.test.ts` — Expected: PASS (5 tests).
Run: `cd api && NODE_ENV=test npx vitest run tests/rbac/seed-integration.test.ts` — Expected: PASS (5 tests, unchanged assertions otherwise).

- [ ] **Step 5: Run the full verification suite**

Run: `cd api && npm run typecheck && npm run lint && NODE_ENV=test npm test`
Expected: all pass. This is the final task, so this is also the point to confirm nothing else regressed: `api/tests/auth/login.test.ts`, `api/tests/auth/me.test.ts`, `api/tests/authorization.test.ts`, `api/tests/rbac/catalog.test.ts`, and `api/tests/rbac/user-role-scope.test.ts` must all still pass unchanged.

- [ ] **Step 6: Commit**

```bash
git add api/prisma/seed.ts api/tests/rbac/seed-integration.test.ts api/tests/rbac/scope-seed-integration.test.ts
git commit -m "fix(seed): keep UserRoleScope in sync with UserBranchRole on every seed/reset (Phase 1C)"
```

---

## Self-Review Notes

- **Spec coverage:** ADD (already done, Phase 1B) → BACKFILL (Task 2's `syncUserRoleScopeFromUserBranchRole`/`backfillUserRoleScopeFromUserBranchRole`) → VERIFY (Task 3) → SWITCH (Task 5 builds the authoritative reader; **Task 6 is the actual runtime switch** — `req.auth.branchIds`, built in `api/src/middleware/auth.ts` and consumed by `authorization.ts`'s real enforcement, now prefers `UserRoleScope`, falling back to legacy only where not yet backfilled; `authorization.ts` itself is never modified, and `roles`/`permissions` stay on the legacy vocabulary everywhere) → DEPRECATE (Task 4's schema comments, now precise about the transitional split: `UserRoleScope` owns LOCATION/COMPANY scope, `UserBranchRole` still owns role codes/permissions; no dual-write needed since nothing writes `UserBranchRole` at runtime) → REMOVE (explicitly not attempted). Task 7 closes the loop so the SWITCH stays true across every seed/reset, not just the first backfill run. MANAGER handled explicitly via Task 1's map, never guessed; ADMIN/CASHIER/SELLER keep their own code. `Location.id = Branch.id` preserved by reusing `branchId` as `locationId` directly (Task 2), never a new lookup. Row-by-row equivalence, no duplicates, no missing assignments are Task 3's three checks. OWNER is never invented and COMPANY scope is never inferred by the backfill (Task 2 only ever writes `scopeKind: 'LOCATION'`); an unexpected COMPANY row at request time fails closed (Task 6) rather than being guessed.
- **Placeholder scan:** no TODOs; every step has runnable code and exact commands.
- **Type consistency:** `ScopeBackfillResult`/`ScopeBackfillVerification`/`ResolvedRoleScope` and all function names (`syncUserRoleScopeFromUserBranchRole`, `backfillUserRoleScopeFromUserBranchRole`, `verifyUserRoleScopeBackfill`, `resolveUserRoleScopes`, `resolveEffectiveBranchIds`, `resolveProductionRoleCodeForLegacy`) are identical everywhere they are used, across Tasks 1–7.
- **Two independent test-database bootstrap paths exist in this repo** (`api/tests/rbac/*` via `openSeedDatabase('test')`+`resetDemo`, and `api/tests/auth/*`/`api/tests/authorization.test.ts` via `createTestPrismaClient`+`truncateAllTables`+`seedDemo`) — neither creates `Company`/`Location`. Task 6's fallback design and Task 7's `location.count() > 0` guard were both shaped around this so that fixing Phase 1C's `UserRoleScope` regression does not introduce a new regression in either path.
