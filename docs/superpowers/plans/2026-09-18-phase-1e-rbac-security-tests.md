# Phase 1E — RBAC/Security Test Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining, concretely-identified RBAC/security test coverage gaps left after Phase 1D's authorization implementation, per `docs/production-v1/08-implementation-roadmap.md`'s Phase 1E entry — test-only, no production behavior change.

**Architecture:** No new production code. Extend existing per-module HTTP integration test files with the one authorization dimension they currently omit (OWNER COMPANY authority), complete an existing JWT-issuance test with its missing assertions, and add one new pure-unit canonical role×permission×scope matrix file. Everything reuses the existing test helper/fixture patterns already established in Phase 1D's own test suite.

**Tech Stack:** Vitest, Supertest, Prisma (hosted Supabase TEST via `TEST_DATABASE_URL`), `jose` for JWT.

**Spec:** `docs/production-v1/08-implementation-roadmap.md` Phase 1E entry (lines 307-324); `docs/superpowers/plans/2026-09-14-phase-1d-production-authorization.md` lines 2600-2618 ("PHASE 1E — Security/RBAC hardening boundary (described only)"); `AGENTS.md` Roles/Authorization checkpoint sections; `CLAUDE.md` testing policy.

## Global Constraints

- Roadmap Phase 1E: Schema changes: none. Migration changes: none. Backend/domain changes: none. Frontend changes: none. (`08-implementation-roadmap.md:313-318`)
- Roadmap Phase 1E exit criteria: "RBAC test suite green." Commit boundary: "RBAC test suite." Risk: LOW. (`08-implementation-roadmap.md:322-324`)
- Required categories per roadmap: privilege escalation; LOCATION vs COMPANY scope enforcement. (`08-implementation-roadmap.md:320`)
- `USER_MANAGE` COMPANY-required status stays unresolved — do not decide it in any Phase 1E task (`authorization-policy.test.ts:64`, confirmed unresolved as of Phase 1D close).
- `PRICE_MANAGE`/`PRODUCT_MANAGE`/`PRODUCT_VARIANT_MANAGE` have **no live HTTP route yet** — `products.routes.ts` only exposes `INVENTORY_VIEW`-gated GETs (Phase 2 not started). No Phase 1E task may add a new route to exercise these at HTTP level; COMPANY-required enforcement for them stays proven at the policy/unit level only, by `role-permission-matrix.test.ts:119`, `authorization-policy.test.ts` RED10/RED11, and Task 7's ADMIN COMPANY-vs-LOCATION case below.
- If any task discovers it needs a production-source change to be testable, STOP and mark that task **DESIGN ESCALATION REQUIRED** instead of implementing it.
- Every task is test-only. No task may touch `api/src/**`, `api/prisma/migrations/**`, `docs/production-v1/**`, or `opencode.json`.

---

## Existing coverage inventory (do not duplicate)

Extensive pre-existing coverage means most of the roadmap's "required categories" are already closed. Full inventory is in the accompanying diagnosis report; summary of what is already **PRESENT** and must NOT be re-tested:

- Privilege escalation: `api/tests/rbac/privilege-escalation.test.ts` (Cases A-H, explicitly titled "Phase 1D.4/1E checklist"), `api/tests/backoffice/scope-assignment.test.ts` (self-mod denial, ADMIN→OWNER-target denial, OWNER→non-self-target allowed, ADMIN cannot grant OWNER, first-OWNER-not-bootstrappable-via-HTTP is a structural consequence of the universal `isOwner(caller)` gate).
- LOCATION vs COMPANY enforcement: `api/tests/rbac/authorization-policy.test.ts`, `api/tests/rbac/cross-assignment.test.ts`, `api/tests/rbac/role-permission-matrix.test.ts`.
- Cross-assignment non-composition: `authorization-policy.test.ts` RED 7/8, `cross-assignment.test.ts`, `privilege-escalation.test.ts` Case E, plus per-module dual-assignment tests in `tests/payments/split-payment.test.ts` and `tests/inventory/inventory.test.ts`.
- Stale `UserBranchRole` cannot grant/veto: `authorization-context.test.ts`, `privilege-escalation.test.ts` Cases C/D, `tests/sales/cancellation.test.ts`.
- Empty scope fail-closed: throughout `authorization-policy.test.ts` (every `[RED 15]` case).
- JWT trust boundary (middleware ignores forged claims): `tests/auth.test.ts:40-52`.
- Socket.IO connection-time snapshot: `tests/realtime/socket.test.ts` (9 `it(...)` cases, verified by direct count — corrected from an earlier miscount of 8) — already fully proves the frozen behavior; no new task needed.
- Cash GET location-membership-only reads: `tests/cash/cash-session.test.ts:45,150-154,157,203,216,229` — 401/403/200 matrix already present.
- Public compatibility projections cannot leak authority: `tests/auth/user-context-dto.test.ts`, `tests/auth/login-scope-switch.test.ts:108`.

## Concretely identified gaps (what this plan closes)

1. **No module outside `sales`(queue)/`auth`/`backoffice` USER_MANAGE has an HTTP-level test proving OWNER succeeds.** Grep of `OWNER` across `tests/sales/*.test.ts`, `tests/payments/*.test.ts`, `tests/cash/*.test.ts`, `tests/inventory/*.test.ts`, `tests/products/*.test.ts`, and `tests/backoffice/backoffice.test.ts` returns **zero** hits each; `tests/audit/audit.test.ts` has 2 hits but both are a comment explaining SELLER was picked as an arbitrary non-OWNER placeholder — no actual OWNER test exists there either. This is exactly roadmap item "OWNER COMPANY authority... Phase 1E broadens to every permission-gated route" (`2026-09-14-phase-1d-production-authorization.md:2604`). Closed by Tasks 2-6 and 6B below.
2. **JWT issuance coverage is real but incomplete, not absent.** Correction: `api/tests/auth/login.test.ts:44-54` already decodes and verifies the actual token issued by `POST /api/v1/auth/login` (via `jose`'s `jwtVerify`, the same library `tokens.ts` uses to sign) and already asserts `sub`/`iat`/`exp` are present with the correct 900s lifetime, and that `roles`/`branchIds`/`permissions` are absent. `tests/auth.test.ts:40-52` separately proves the middleware ignores a forged claim (trust boundary, different concern). What is genuinely missing from the existing issuance test: no assertion that `jti` is present, no assertion that `assignments`/`effectiveLocationIds` are absent, and no single assertion that the payload's key set is closed to exactly `{sub, iat, exp, jti}`. This is exactly `2026-09-14-phase-1d-production-authorization.md:2614`, scoped to the actual residual gap rather than the whole issuance surface.
3. **No exhaustive role × permission × assignment-shape matrix exists.** Current coverage is representative (RED-numbered cases), by design (`authorization-policy.ts` comments call out the "single internal predicate" pattern). The Phase 1D plan doc explicitly defers the exhaustive version: "Phase 1E runs an exhaustive per-role × per-permission × per-assignment-combination matrix rather than the representative cases this plan covers" (`2026-09-14-phase-1d-production-authorization.md:2611`, restated at `:2613`) (scoped to canonical Production assignment shapes in Task 7; malformed shapes remain covered at their existing fail-closed/creation boundaries).

Everything else in the user's 20-point target list (self-mod, ADMIN-can't-manage-OWNER, cross-assignment, empty-scope, stale-UBR, MANAGER fail-closed, public projections, cash reads, Socket.IO) is already PRESENT per the inventory above — adding more tests for those would violate this plan's own "do not duplicate" test design principle and the roadmap's LOW risk rating.

---

## Task 1: JWT issuance contract completion (regression lock)

**Files:**
- Modify: `api/tests/auth/login.test.ts` (extend the existing real-token test at lines 26-55 — do not add a duplicate top-level `it`)

**Interfaces:**
- Consumes: the file's own existing `jwtVerify` import (`login.test.ts:3`) and `env.JWT_SECRET` (`login.test.ts:6`) — the exact pattern the test already uses at lines 44-48. No manual base64url parsing; no new import.
- Produces: nothing consumed by later tasks.

Correction (per OpenCode audit LOW-1): this is NOT the first proof of real-token issuance — `login.test.ts:44-54` already verifies the real issued token via `jwtVerify` and already asserts `sub`/`iat`/`exp` (with the exact 900s lifetime) and the absence of `roles`/`branchIds`/`permissions`. This task only adds the three assertions that test doesn't yet make: `jti` presence, `assignments`/`effectiveLocationIds` absence, and a closed-key-set check.

- [ ] **Step 1: Add the regression assertions**

Extend the existing `it('returns an access token and current user context for valid credentials', ...)` block in `api/tests/auth/login.test.ts`, immediately after its existing line `expect(payload.permissions).toBeUndefined();` (line 54) — do not create a new `it`:

```ts
    expect(payload.jti).toEqual(expect.any(String));
    expect(payload.assignments).toBeUndefined();
    expect(payload.effectiveLocationIds).toBeUndefined();
    expect(Object.keys(payload).sort()).toEqual(['exp', 'iat', 'jti', 'sub']);
```

This reuses the same `payload` object the existing assertions already decoded via `jwtVerify` two lines above (line 44) — no new request, no new token issuance, no new fixture.

- [ ] **Step 2: Run the extended test**

Run: `cd api && NODE_ENV=test npx vitest run tests/auth/login.test.ts -t "returns an access token and current user context for valid credentials" --reporter=verbose`

Expected: **PASS** — `tokens.ts:8-17` already sets only `sub`/`iat`/`exp`/`jti` via `SignJWT`, so this is a regression-lock over already-correct code, not a bugfix. If it fails, STOP and report the exact payload keys found; do not modify `tokens.ts` (a production-source change is outside this plan's scope — mark DESIGN ESCALATION REQUIRED instead).

- [ ] **Step 3: Commit**

```bash
git add api/tests/auth/login.test.ts
git commit -m "test(auth): complete JWT issuance identity-only assertions — jti, assignments, effectiveLocationIds, closed key set (Phase 1E)"
```

---

## Task 2: OWNER COMPANY authority — sales module

**Files:**
- Modify: `api/tests/sales/draft-sale.test.ts` (create + view)
- Modify: `api/tests/sales/complete-sale.test.ts` (complete)
- Modify: `api/tests/sales/cancellation.test.ts` (cancel + release-expired)

**Explicitly excluded — already covered, no duplicate added:**
`GET /api/v1/sales/pending` (`SALE_QUEUE_VIEW`, global gate) already has a real HTTP OWNER proof at `api/tests/auth/login-scope-switch.test.ts:157-162` ("an OWNER user passes a live switched route (SALE_QUEUE_VIEW) with zero RolePermission rows"). Adding another one here would duplicate that proof merely to raise a route count, which this plan's own "do not duplicate" principle forbids.

**Interfaces:**
- Consumes: each file's existing `db`/`app`/token-issuance helpers (`createTestUser`, `getAuthToken` from `tests/helpers/`); the bare-COMPANY-OWNER pattern already used in `tests/cash/cash-session.test.ts:66-74` (`db.user.create({ data: { name, email, passwordHash: 'x' } })` + `db.userRoleScope.create({ data: { userId, roleId: ownerRole.id, scopeKind: 'COMPANY', locationId: null } })`, `ownerRole = await db.role.findUniqueOrThrow({ where: { code: 'OWNER' } })`) and `tests/audit/audit.test.ts:199-207`.
- Produces: nothing consumed by later tasks.

**Why each remaining test exists (distinct wiring pattern, not one-per-URL):**
- `draft-sale.test.ts` create+view: permission check paired with a **user-supplied** `branchId` on create, then the **persisted resource's** `branchId` on view — two different location-derivation points in the same flow.
- `complete-sale.test.ts`: `SALE_COMPLETE` is a **global** gate (no location argument at all) — proves OWNER's COMPANY assignment satisfies a global permission check, distinct from the location-bound cases above.
- `cancellation.test.ts` cancel: permission check paired with the **persisted sale's** location (same pattern as view, kept because cancellation is a distinct mutating route, not a read).
- `cancellation.test.ts` release-expired: mounted on a **separate router** (`/api/v1/admin`, not `/api/v1/sales`) gated by `INVENTORY_MANAGE` with **no location argument at all** — proves OWNER's implicit authority reaches a second, differently-mounted global-gate router, not just the `/sales` router.

- [ ] **Step 1: Add the regression tests**

In each file, add one test per route the file already exercises, following the exact existing setup pattern in that file (do not invent a new bootstrap — copy the file's own `beforeEach`/fixture creation for branch/user/sale, then additionally create a *fresh bare user* with only the OWNER COMPANY `UserRoleScope` row, per the pattern above — do not call `createTestUser` for the OWNER identity, since `tests/helpers/factories.ts:88-113`'s `createTestUser` always creates a matching `UserRoleScope` LOCATION row and cannot produce a bare COMPANY-only OWNER):

`draft-sale.test.ts` (near its existing SELLER create/view tests):
```ts
it('an OWNER (COMPANY scope, no location assignment) can create and view a draft sale at any branch', async () => {
  const ownerRole = await prisma.role.findUniqueOrThrow({ where: { code: 'OWNER' } });
  const owner = await prisma.user.create({ data: { name: 'owner-sales', email: 'owner-sales@test.local', passwordHash: 'x' } });
  await prisma.userRoleScope.create({
    data: { userId: owner.id, roleId: ownerRole.id, scopeKind: 'COMPANY', locationId: null },
  });
  const token = await getAuthToken(owner);
  const createResponse = await request(app)
    .post('/api/v1/sales')
    .set('Authorization', `Bearer ${token}`)
    .send({ branchId: centroId });
  expect(createResponse.status).toBe(201);
  const viewResponse = await request(app)
    .get(`/api/v1/sales/${createResponse.body.id}`)
    .set('Authorization', `Bearer ${token}`);
  expect(viewResponse.status).toBe(200);
});
```

`complete-sale.test.ts`: same bare-OWNER pattern, but the fixture is an already-`PENDING_PAYMENT`/paid sale (copy the file's own setup for the happy-path complete test), asserting `POST /api/v1/sales/:saleId/complete` → the file's existing success status for that route (check the file's own happy-path assertion and use that literal status — do not guess between alternatives).

`cancellation.test.ts`: two tests, both using the currently-established statuses from this file's own neighboring tests, not a guessed alternative:
- OWNER can `POST /api/v1/sales/:saleId/cancel` on a draft at any branch — `200` (matches this file's existing cancel-success assertions, e.g. line 85: `expect(response.body.status).toBe('CANCELLED')` after a `200`).
- OWNER can `POST /api/v1/admin/reservations/release-expired` (**not** `/api/v1/sales/reservations/release-expired` — that route does not exist; `createCancellationRouter` mounts `/:saleId/cancel` under `/api/v1/sales`, while `release-expired` is owned by the admin router mounted at `/api/v1/admin`, `src/app.ts:58` / `src/modules/sales/cancellation.routes.ts:20`), gated by `INVENTORY_MANAGE` — `200` (matches every existing call in this file, e.g. lines 78, 130, 158, 200).

- [ ] **Step 2: Run per-file**

```bash
cd api
NODE_ENV=test npx vitest run tests/sales/draft-sale.test.ts --reporter=verbose
NODE_ENV=test npx vitest run tests/sales/complete-sale.test.ts --reporter=verbose
NODE_ENV=test npx vitest run tests/sales/cancellation.test.ts --reporter=verbose
```

Expected: all new tests PASS (this proves existing production code already handles OWNER correctly across sales — it should, since `hasPermission`/`hasPermissionAtLocation` already special-case OWNER centrally). Any FAIL here is a genuine Phase 1D gap discovered by testing, not a Phase 1E implementation task — STOP, do not fix `src/`, report the exact failure and mark DESIGN ESCALATION REQUIRED for follow-up triage.

- [ ] **Step 3: Commit**

```bash
git add api/tests/sales/draft-sale.test.ts api/tests/sales/complete-sale.test.ts api/tests/sales/cancellation.test.ts
git commit -m "test(sales): prove OWNER COMPANY authority across the sales route family (Phase 1E)"
```

---

## Task 3: OWNER COMPANY authority — payments module

**Files:**
- Modify: `api/tests/payments/split-payment.test.ts`

**Interfaces:**
- Consumes: same bare-COMPANY-OWNER pattern as Task 2.

**Authorization boundary (per Codex correction item 9):** `SALE_CHARGE` (register) / `SALE_VIEW` (list) are checked against the **persisted sale's** `branchId` via `hasPermissionAtLocation` — the same "permission + persisted-resource-location" pattern as `draft-sale.test.ts`'s view case. OWNER's COMPANY assignment satisfies this regardless of which branch the sale belongs to; the test below deliberately does not need to pick a specific branch for that reason.

**Literal data types (verified against the file, not invented):** every existing `pay(...)` call in `split-payment.test.ts` sends `amount` as a **string literal** (e.g. `'1'`, `'10000000'`), `method` as one of `'TRANSFER'`/`'CARD_DEBIT'`/`'CASH'`, and `idempotencyKey: randomUUID()` (see e.g. lines 58, 152-153, 203). The snippet below follows that exact convention. Implementation must use the existing test fixture/request-body representation verbatim — do not introduce a numeric or bigint literal for `amount`.

**Correction (per Codex audit MEDIUM-1):** the previous revision referenced `sale.id` without creating that sale in the same test, and used a comment placeholder (`/* bare user ... per Task 2's pattern */`) instead of literal code. Both are fixed below using this file's own real conventions, confirmed directly from `split-payment.test.ts:10-45`: the database variable is `db` (not `prisma`); `async function createSale(total = 16500000n, status = 'PENDING_PAYMENT')` already exists and returns the created `Sale` row; `pay(saleId: string, body: object, accessToken = token)` already exists. Do not use `createTestUser` for the OWNER identity — per this correction, that helper intentionally creates LOCATION-oriented legacy/test state (a matching `UserRoleScope` LOCATION row) and would weaken the bare-OWNER proof; create the OWNER user directly instead, exactly as Task 2's pattern already does.

- [ ] **Step 1: Add the regression test**

```ts
it('allows a bare COMPANY-scoped OWNER to register and list payments for a sale at any branch', async () => {
  const ownerRole = await db.role.findUniqueOrThrow({ where: { code: 'OWNER' } });
  const owner = await db.user.create({
    data: { name: 'owner-payments', email: 'owner-payments@test.local', passwordHash: 'x' },
  });
  await db.userRoleScope.create({
    data: { userId: owner.id, roleId: ownerRole.id, scopeKind: 'COMPANY', locationId: null },
  });
  const ownerToken = await getAuthToken(owner);
  const sale = await createSale(1n);

  const payResponse = await pay(sale.id, { method: 'TRANSFER', amount: '1', idempotencyKey: randomUUID() }, ownerToken);
  expect(payResponse.status).toBe(201);

  const listResponse = await request(app)
    .get(`/api/v1/sales/${sale.id}/payments`)
    .set('Authorization', `Bearer ${ownerToken}`);
  expect(listResponse.status).toBe(200);
});
```

`createSale(1n)` uses the file's own default `status: 'PENDING_PAYMENT'` and creates a sale with `total: 1n` — its own default `sellerId`/`branchId` (set in this file's `beforeEach`) are irrelevant to OWNER's COMPANY authority, which is exactly the point of the test. `amount: '1'` exactly matches that total, so the payment is expected to fully settle it (`201`), consistent with this file's own full-payment happy-path assertions (e.g. lines 152-153).

- [ ] **Step 2: Run**

`cd api && NODE_ENV=test npx vitest run tests/payments/split-payment.test.ts --reporter=verbose` — expect PASS.

- [ ] **Step 3: Commit**

```bash
git add api/tests/payments/split-payment.test.ts
git commit -m "test(payments): prove OWNER COMPANY authority on payment routes (Phase 1E)"
```

---

## Task 4: OWNER COMPANY authority — cash module

**Files:**
- Modify: `api/tests/cash/cash-session.test.ts`

**Interfaces:**
- Consumes: the file *already has* one COMPANY-scoped ADMIN test at line 66-74 to copy from directly (just swap the role to OWNER and drop the `RolePermission` grant entirely, since OWNER needs none).

**Why this test exists:** covers two genuinely distinct wiring patterns in one task — `open`/`close` are a permission check paired with a **request-body-supplied** resource (the register/session, not yet persisted at check time), while `register`/`current` are membership-only GETs with **no permission constant at all** (see this plan's "Existing coverage inventory" section, cash GET row). Kept as one test because both already exist side-by-side in this file's own ADMIN case.

**Correction (per OpenCode audit MEDIUM-3):** the file's real helper signatures, read directly from `cash-session.test.ts:38-40`, are:
```ts
const open = (body: object = { registerId, startingCash: exact }, accessToken = token) => ...
const close = (id: string, body: object = { closingCash: exact }, accessToken = token) => ...
const read = (route: string, query: object = { branchId }, accessToken = token) => ...
```
`close`'s second parameter is the request **body**, not the token — the token is the *third* parameter. Passing `ownerToken` as the second argument would silently become the close request body (`send(ownerToken)`), producing a spurious authorization/validation failure unrelated to OWNER's actual authority. The existing ADMIN test already demonstrates the correct call shape at line 73: `close(session.body.sessionId, undefined, adminToken)` — passing `undefined` for body falls through to the real default `{ closingCash: exact }` already used by every passing test in this file (no new `closingCash` representation invented).

**Correction (per Codex audit MEDIUM-1):** the previous revision's fixture was a comment placeholder (`/* bare user, per Task 2's pattern */`) and incorrectly assumed `db.role.findUniqueOrThrow({ where: { code: 'OWNER' } })` would resolve — but, confirmed directly from `cash-session.test.ts:15-30`, this file's `beforeEach` never calls `seedDemo`; it builds its own minimal fixtures directly (`createRole(db, 'CASHIER')`, `createBranch(db)`, etc.), so no `OWNER` `Role` row exists yet in this file's database state. Use the file's own already-imported `createRole` helper (`tests/helpers/factories.ts:81-86`, a plain `prisma.role.create({ data: { code, name: code } })` — no `RolePermission` rows, exactly what an implicit-authority OWNER proof needs) to create it, exactly as this file's own existing tests create `CASHIER`/`ADMIN` roles.

- [ ] **Step 1: Add the regression test**

```ts
it('authorizes cash session open/close and register/current reads for a COMPANY-scoped OWNER assignment, with zero RolePermission rows', async () => {
  const ownerRole = await createRole(db, 'OWNER');
  const owner = await db.user.create({
    data: { name: 'owner-cash', email: 'owner-cash@test.local', passwordHash: 'x' },
  });
  await db.userRoleScope.create({
    data: { userId: owner.id, roleId: ownerRole.id, scopeKind: 'COMPANY', locationId: null },
  });
  const ownerToken = await getAuthToken(owner);
  expect((await read('register', {}, ownerToken)).status).toBe(200);
  expect((await read('current', {}, ownerToken)).status).toBe(200);
  const openResponse = await open(undefined, ownerToken);
  expect(openResponse.status).toBe(201);
  expect((await close(openResponse.body.sessionId, undefined, ownerToken)).status).toBe(200);
});
```

Matches the file's actual `read`/`open`/`close` helper signatures exactly as declared at `cash-session.test.ts:38-40`, and the exact call shape already proven correct by the existing ADMIN test at line 73. No `RolePermission` rows and no `UserBranchRole` row are created for OWNER — the point of the test is implicit COMPANY authority alone.

- [ ] **Step 2: Run**

`cd api && NODE_ENV=test npx vitest run tests/cash/cash-session.test.ts --reporter=verbose` — expect PASS.

- [ ] **Step 3: Commit**

```bash
git add api/tests/cash/cash-session.test.ts
git commit -m "test(cash): prove OWNER COMPANY authority on session and register/current routes (Phase 1E)"
```

---

## Task 5: OWNER COMPANY authority — inventory and products modules

**Files:**
- Modify: `api/tests/inventory/inventory.test.ts`
- Modify: `api/tests/products/products.test.ts`
- Modify: `api/tests/products/variants.test.ts`

**Interfaces:**
- Consumes: the bare-COMPANY-OWNER pattern, adapted per file to its own real variable (`prisma`, not `db` — all three files use `prisma`, confirmed from each file's own `let prisma: Awaited<ReturnType<typeof createTestPrismaClient>>;` declaration and `seedDemo(prisma)` call in `beforeEach`, so `OWNER` already exists as a `Role` row via the catalog sync — use `prisma.role.findUniqueOrThrow`, not `createRole`, unlike Task 4).

**Correction (per Codex audit MEDIUM-2): these three files do NOT share one authorization shape.** Confirmed directly from source — three genuinely distinct patterns, corrected below instead of flattened into one description:

**3A. `inventory.test.ts` — query-supplied LOCATION-bound.** `inventory.routes.ts`: `requirePermission(INVENTORY_VIEW, { branchScope: 'own', resolveResourceBranch: (req) => String(req.query.branchId) })` on both `GET /` and `GET /availability`. This is a real `hasPermissionAtLocation` check against the query's `branchId`. The file already has a `yerbaId` fixture (`inventory.test.ts:29`, resolved from branch code `YB`) — use it as the OWNER's target branch, proving COMPANY reach at a location distinct from `centroId`, not coincidental single-branch overlap.

**3B. `products.test.ts` — GLOBAL route-level gate.** `products.routes.ts:13-17`: `requirePermission(INVENTORY_VIEW, { branchScope: 'global' })` — no `resolveResourceBranch` at all. `GET /api/v1/products` takes no `branchId` and needs none; the test must not invent one.

**3C. `variants.test.ts` — GLOBAL route-level gate, plus an optional service-level location check.** `products.routes.ts:24-28`'s `createVariantsRouter` uses the same `branchScope: 'global'` `requirePermission(INVENTORY_VIEW)` at the route. But `listVariants` (`products.service.ts`, called from `products.controller.ts:21-22`) additionally calls `assertPermissionAtLocation(req, INVENTORY_VIEW, branchId)` when the query supplies a `branchId` (confirmed: `products.controller.ts` imports `assertPermissionAtLocation` and `listVariants`'s existing test at `variants.test.ts:35-42` already passes `branchId: centroId` in its query). This is a genuinely different, two-layer wiring from both 3A and 3B — the plan tests it with an explicit `branchId` for that reason, not merely for parity with 3A.

- [ ] **Step 1: Add the regression tests**

`inventory.test.ts` (3A — query-supplied LOCATION-bound):
```ts
it('a bare COMPANY-scoped OWNER passes the query-supplied INVENTORY_VIEW location check', async () => {
  const ownerRole = await prisma.role.findUniqueOrThrow({ where: { code: 'OWNER' } });
  const owner = await prisma.user.create({
    data: { name: 'owner-inventory', email: 'owner-inventory@test.local', passwordHash: 'x' },
  });
  await prisma.userRoleScope.create({
    data: { userId: owner.id, roleId: ownerRole.id, scopeKind: 'COMPANY', locationId: null },
  });
  const ownerToken = await getAuthToken(owner);
  const response = await request(app)
    .get('/api/v1/inventory')
    .query({ branchId: yerbaId })
    .set('Authorization', `Bearer ${ownerToken}`);
  expect(response.status).toBe(200);
});
```

`products.test.ts` (3B — GLOBAL route-level gate, no `branchId`):
```ts
it('a bare COMPANY-scoped OWNER passes the global INVENTORY_VIEW product-catalog gate', async () => {
  const ownerRole = await prisma.role.findUniqueOrThrow({ where: { code: 'OWNER' } });
  const owner = await prisma.user.create({
    data: { name: 'owner-products', email: 'owner-products@test.local', passwordHash: 'x' },
  });
  await prisma.userRoleScope.create({
    data: { userId: owner.id, roleId: ownerRole.id, scopeKind: 'COMPANY', locationId: null },
  });
  const ownerToken = await getAuthToken(owner);
  const response = await request(app)
    .get('/api/v1/products')
    .set('Authorization', `Bearer ${ownerToken}`);
  expect(response.status).toBe(200);
});
```
Do not invent a `PRICE_MANAGE`/`PRODUCT_MANAGE` mutation route here — none exists yet (Phase 2).

`variants.test.ts` (3C — GLOBAL route gate + service-level `branchId` check):
```ts
it('a bare COMPANY-scoped OWNER passes both the global route gate and the service-level branchId check', async () => {
  const ownerRole = await prisma.role.findUniqueOrThrow({ where: { code: 'OWNER' } });
  const owner = await prisma.user.create({
    data: { name: 'owner-variants', email: 'owner-variants@test.local', passwordHash: 'x' },
  });
  await prisma.userRoleScope.create({
    data: { userId: owner.id, roleId: ownerRole.id, scopeKind: 'COMPANY', locationId: null },
  });
  const ownerToken = await getAuthToken(owner);
  const response = await request(app)
    .get('/api/v1/variants')
    .query({ branchId: yerbaId })
    .set('Authorization', `Bearer ${ownerToken}`);
  expect(response.status).toBe(200);
});
```

- [ ] **Step 2: Run**

```bash
cd api
NODE_ENV=test npx vitest run tests/inventory/inventory.test.ts --reporter=verbose
NODE_ENV=test npx vitest run tests/products/products.test.ts --reporter=verbose
NODE_ENV=test npx vitest run tests/products/variants.test.ts --reporter=verbose
```

Expect PASS on all three.

- [ ] **Step 3: Commit**

```bash
git add api/tests/inventory/inventory.test.ts api/tests/products/products.test.ts api/tests/products/variants.test.ts
git commit -m "test(inventory,products): prove OWNER COMPANY authority on inventory/product reads (Phase 1E)"
```

---

## Task 6: OWNER COMPANY authority — audit module

**Files:**
- Modify: `api/tests/audit/audit.test.ts`

**Interfaces:**
- Consumes: the file already has a COMPANY-scoped ADMIN test at line 199-207 (`'authorizes via a COMPANY-scoped ADMIN assignment'`) to copy directly — swap role to OWNER, drop the RolePermission grant.

**Correction (per Codex audit item 5): `AUDIT_VIEW` is GLOBALLY gated, not location-bound.** `audit.routes.ts`: `router.get('/', requirePermission(PRODUCTION_PERMISSIONS.AUDIT_VIEW), ...)` — no `branchScope`/`resolveResourceBranch` option at all, so `requirePermission`'s own default (`authorization.ts`: `const branchScope = options.branchScope ?? 'global';`) applies: a plain `hasPermission` check, no location argument. The purpose of this test is to prove OWNER's implicit COMPANY authority passes a GLOBAL `requirePermission(AUDIT_VIEW)` HTTP gate — not a location match. (The file's own two `OWNER` text hits are only a comment explaining SELLER was picked as an arbitrary non-OWNER placeholder for unrelated fixtures — no actual OWNER authorization case existed before this task.)

- [ ] **Step 1: Add the regression test**

Confirmed directly from `audit.test.ts:1-60`: the database variable is `db`; `beforeEach` calls `seedDemo(db)` (line 60), so the `OWNER` `Role` row already exists via the catalog sync — use `db.role.findUniqueOrThrow`, not `createRole`; the file's own `get = (accessToken = token, query = '') => request(createApp(db)).get(\`/api/v1/audit${query}\`)...` helper (line 55) is reused as-is, matching the file's own existing COMPANY-scoped ADMIN test (lines 199-207) exactly, with the role swapped to OWNER and the `RolePermission` grant dropped entirely:

```ts
it('authorizes audit read for a bare COMPANY-scoped OWNER', async () => {
  const ownerRole = await db.role.findUniqueOrThrow({ where: { code: 'OWNER' } });
  const owner = await db.user.create({
    data: { name: 'owner-audit', email: 'owner-audit@test.local', passwordHash: 'x' },
  });
  await db.userRoleScope.create({
    data: { userId: owner.id, roleId: ownerRole.id, scopeKind: 'COMPANY', locationId: null },
  });
  const ownerToken = await getAuthToken(owner);
  expect((await get(ownerToken)).status).toBe(200);
});
```

No `createTestUser`, no `UserBranchRole`, no `RolePermission` grant, no `locationId` on the OWNER assignment.

- [ ] **Step 2: Run**

`cd api && NODE_ENV=test npx vitest run tests/audit/audit.test.ts --reporter=verbose` — expect PASS.

- [ ] **Step 3: Commit**

```bash
git add api/tests/audit/audit.test.ts
git commit -m "test(audit): prove OWNER COMPANY authority on the audit route (Phase 1E)"
```

---

## Task 6B: OWNER COMPANY authority — Backoffice REPORT_VIEW

**Files:**
- Modify: `api/tests/backoffice/backoffice.test.ts`

**Interfaces:**
- Consumes: the bare-COMPANY-OWNER pattern from Task 2 (`db.user.create({ data: { name, email, passwordHash: 'x' } })` + `db.userRoleScope.create({ data: { userId, roleId: ownerRole.id, scopeKind: 'COMPANY', locationId: null } })`), and `getAuthToken` from `tests/helpers/auth.js` (both already imported in this file). Route wiring confirmed directly from `src/modules/backoffice/backoffice.routes.ts:35`: `const reportView = requirePermission(PRODUCTION_PERMISSIONS.REPORT_VIEW)` — called with **no options object**, so `requirePermission`'s own default (`authorization.ts`: `const branchScope = options.branchScope ?? 'global';`) applies: this is a **GLOBAL** `hasPermission` gate, not a location check. It is the exact middleware instance passed to `GET /dashboard`, `/sales`, `/sales/:id`, `/inventory`, and `/branches` alike — one shared closure, not five separate checks.
- Produces: nothing consumed by later tasks.

**Why one representative endpoint is sufficient (per this correction):** all five REPORT_VIEW routes share the identical `reportView` middleware instance created once at `backoffice.routes.ts:34` and reused as-is on every route registration (`backoffice.routes.ts:35-39`) — there is exactly one authorization-wiring decision to prove, not five. `GET /dashboard` is the representative case, matching the file's own existing pattern for proving a Production-grant-alone case (`'authorizes Backoffice REPORT_VIEW reads via the Production grant alone'`, line 187, which also uses `/dashboard` as its representative route). The other four routes' own service logic, filters, resource scoping, and validation are already independently covered by this file's existing non-OWNER tests (e.g. lines 220-248, 279-332) — this task proves authorization wiring only, not per-route business logic, so it does not duplicate those.

- [ ] **Step 1: Add the regression test**

Add to `api/tests/backoffice/backoffice.test.ts`, alongside the existing `'authorizes Backoffice REPORT_VIEW reads via the Production grant alone'` test (line 187):

```ts
it('authorizes GET /api/v1/backoffice/dashboard via a COMPANY-scoped OWNER assignment, with zero RolePermission rows', async () => {
  const ownerRole = await prisma.role.findUniqueOrThrow({ where: { code: 'OWNER' } });
  const owner = await prisma.user.create({ data: { name: 'owner-backoffice', email: 'owner-backoffice@test.local', passwordHash: 'x' } });
  await prisma.userRoleScope.create({
    data: { userId: owner.id, roleId: ownerRole.id, scopeKind: 'COMPANY', locationId: null },
  });
  const ownerToken = await getAuthToken(owner);
  const response = await request(app)
    .get('/api/v1/backoffice/dashboard')
    .set('Authorization', `Bearer ${ownerToken}`);
  expect(response.status).toBe(200);
});
```

This proves: the caller is a bare user with zero `UserBranchRole` rows and zero `RolePermission` grants of its own; its only authorization state is exactly one `UserRoleScope` row (`OWNER`, `COMPANY`, `locationId: null`); the issued token is a normal identity-only access token from the same `getAuthToken` helper every other test in this file already uses (no special-cased token minting); and the shared `requirePermission(REPORT_VIEW)` wiring recognizes OWNER's centralized implicit authority (`isOwner`/`hasPermission` in `authorization-policy.ts`) rather than requiring an explicit grant.

- [ ] **Step 2: Run**

`cd api && NODE_ENV=test npx vitest run tests/backoffice/backoffice.test.ts --reporter=verbose` — expect PASS.

Expected: **PASS** — this is a regression-lock over already-correct Phase 1D code (the same centralized `isOwner`/`hasPermission` path already proven against sales/payments/cash/inventory/products/audit in Tasks 2-6). A FAIL here is a genuine Phase 1D gap discovered by testing, not a Phase 1E implementation task — STOP, do not fix `src/`, report the exact failure and mark DESIGN ESCALATION REQUIRED.

- [ ] **Step 3: Commit**

```bash
git add api/tests/backoffice/backoffice.test.ts
git commit -m "test(backoffice): prove OWNER COMPANY authority on the shared REPORT_VIEW route wiring (Phase 1E)"
```

---

## Backoffice OWNER coverage — disposition

Reviewed per the OpenCode audit's request to explicitly account for backoffice, alongside Tasks 2-6:

- **`GET /backoffice/dashboard,/sales,/sales/:id,/inventory,/branches` (REPORT_VIEW):** was a genuine gap (zero `OWNER` hits in `tests/backoffice/backoffice.test.ts`) — now closed by Task 6B above, via one representative test on the shared `reportView` middleware instance. The other four routes are not independently re-tested for OWNER, since they share the identical middleware closure (see Task 6B's rationale) and adding four more would duplicate the same authorization-wiring proof without adding coverage value.
- **`GET /backoffice/users`, `POST/DELETE .../backoffice/users/:userId/scope[/:roleCode]` (USER_MANAGE):** no new OWNER test added, and none is needed. `POST`/`DELETE` scope-management routes already have real HTTP OWNER proof — `tests/backoffice/scope-assignment.test.ts:117-152` ("OWNER can manage an eligible non-self, non-OWNER target", "an already-bootstrapped OWNER may grant OWNER to a different, non-self target") and `:153-160` (self-modification denied, OWNER included) — this is the privilege-escalation suite itself. `GET /backoffice/users`'s live-`UserRoleScope`-projection semantics (not authorization) are independently covered by the Phase 1D.4.6 tests at `backoffice.test.ts:348-421`. Adding another OWNER USER_MANAGE HTTP test here would duplicate an already-proven authorization path merely to raise a route count, which this plan's own "do not duplicate" principle forbids.

With Task 6B, every currently-existing distinct permission-gated route family (sales, payments, cash, inventory, products, audit, backoffice REPORT_VIEW, backoffice USER_MANAGE) now has a real HTTP OWNER COMPANY authorization proof, either newly added by this plan or already present from Phase 1D (sales queue view, USER_MANAGE scope-management). `PRICE_MANAGE`/`PRODUCT_MANAGE`/`PRODUCT_VARIANT_MANAGE` remain correctly deferred to Phase 2, since no route exists yet to exercise them at HTTP level.

---

## Task 7: Canonical role × permission × scope authorization matrix (pure unit, no DB)

**Files:**
- Create: `api/tests/rbac/role-permission-scope-matrix.test.ts`

**Interfaces:**
- Consumes: `hasPermission`, `hasPermissionAtLocation`, `isOwner` from `../../src/modules/rbac/authorization-policy.js`; `DEFAULT_ROLE_GRANTS` from `../../src/modules/rbac/role-permission-matrix.js`; `productionPermissionValues`, `COMPANY_SCOPE_REQUIRED_FOR_ADMIN` from `../../src/modules/rbac/permissions.js`; `ROLE_CODES` from `../../src/modules/rbac/roles.js`. All pure, synchronous, in-memory — no Prisma, no `TEST_DATABASE_URL`.
- Produces: nothing consumed by later tasks.

**Correction (per OpenCode audit MEDIUM-2):** this task was previously titled "Exhaustive role × permission × assignment-shape matrix". Renamed because its literal matrix (below) covers every **canonical** (currently-valid) role/scope combination across all 33 permissions, but does not — and must not — invent coverage for every malformed or hypothetical assignment shape. It proves the Phase 1D plan doc's own deferred item — "Phase 1E runs an exhaustive per-role × per-permission × per-assignment-combination matrix rather than the representative cases this plan covers" (`2026-09-14-phase-1d-production-authorization.md:2611,2613`) — scoped to canonical shapes only (malformed shapes remain covered at their existing fail-closed/creation boundaries). Malformed shapes are handled by reference to existing coverage, not by new tests here, per the breakdown below.

**Canonical vs. malformed/transitional scope, by role:**

- **OWNER — canonical is COMPANY only.** The matrix below tests OWNER + COMPANY: `isOwner` true, implicit authority independent of any `RolePermission` row (`permissions: []`), global checks succeed, concrete-location checks succeed at every location. OWNER + LOCATION is malformed data that must never be producible through the supported scope-assignment API (`tests/backoffice/scope-assignment.test.ts:204`, `'rejects scopeKind LOCATION for roleCode OWNER'`) and is already proven fail-closed at the policy level by `authorization-policy.test.ts` RED2 (`isOwner` false for a LOCATION-scoped OWNER row) and its `hasPermission`/`hasPermissionAtLocation`/`hasBranchAccess` RED2/FIX-1 siblings. Not re-tested here — would duplicate existing coverage without adding value.
- **ADMIN — canonical future state is COMPANY; LOCATION is an accepted transitional state, not malformed.** The matrix below tests both: ADMIN + COMPANY grants every catalogued permission at every location (including the COMPANY-required trio); ADMIN + LOCATION is explicitly **not** treated as malformed — it can still exist before the ADMIN→COMPANY one-time backfill is executed (Global Closeout item B below) — so the matrix asserts its real, current, non-degraded behavior: ordinary (non-COMPANY-required) granted permissions work at the assignment's own matching location and fail at an unrelated location, while `PRICE_MANAGE`/`PRODUCT_MANAGE`/`PRODUCT_VARIANT_MANAGE` fail everywhere regardless of location match. New assignments of ADMIN + LOCATION are rejected by the scope-management API going forward (`scope-assignment.test.ts:182`, `'rejects scopeKind LOCATION for roleCode ADMIN'`) — that creation-time rejection is not re-tested here, only the policy-level behavior of an ADMIN + LOCATION row that already exists.
- **CASHIER/SELLER/WAREHOUSE — canonical is LOCATION only.** The matrix tests each role's exact default grants, matching-location access, unrelated-location denial, and denial of permissions outside its default grant set. CASHIER/SELLER/WAREHOUSE + COMPANY are invalid shapes under the current scope-assignment model and are already rejected at creation by `scope-assignment.test.ts:173` (`it.each(['CASHIER','SELLER','WAREHOUSE'])('rejects scopeKind COMPANY for roleCode %s', ...)`) — no new policy-level "what if COMPANY" expectation is invented here; if implementation work later reveals behavior contradicting this frozen contract, STOP and mark DESIGN ESCALATION REQUIRED rather than adding an ad hoc case.
- **Legacy MANAGER / unknown role codes — never a valid Production assignment.** Not fabricated as a matrix entry. Existing coverage already proves this: `legacy-role-map.test.ts` (MANAGER maps to WAREHOUSE only at backfill time, never survives as a Production role code) and `scope-assignment.test.ts:339,364` (`'F1: assign/revoke rejects a legacy MANAGER roleCode even when the Role row genuinely exists'`). The matrix's cross-assignment case below (independent LOCATION-only-role pairs) separately reconfirms that a sibling valid assignment is never disturbed by an adjacent invalid one, which is the only MANAGER-adjacent property this task needs to touch.

**Type shape (resolved from source, not left as an implementer guess):** `api/src/types/express.d.ts:5-11` declares `Express.ProductionAssignment` flat — `{ roleId: string; roleCode: 'OWNER'|'ADMIN'|'CASHIER'|'SELLER'|'WAREHOUSE'; scopeKind: 'LOCATION'|'COMPANY'; locationId: string | null; permissions: string[] }` — and `authorization-policy.ts:26` declares its policy `Ctx` as `Pick<Express.AuthContext, 'assignments'>`. The field is `roleCode` (flat), not a nested `role.code` — the snippet below already uses that shape and needs no adjustment. `OWNER` has no `DEFAULT_ROLE_GRANTS` entry (`role-permission-matrix.ts`'s comment: "OWNER intentionally has no entry above"), so OWNER fixtures below correctly use `permissions: []` to prove implicit-authority independence from any grant list.

- [ ] **Step 1: Add the regression test**

```ts
import { describe, expect, it } from 'vitest';
import {
  hasPermission,
  hasPermissionAtLocation,
  isOwner,
} from '../../src/modules/rbac/authorization-policy.js';
import { DEFAULT_ROLE_GRANTS } from '../../src/modules/rbac/role-permission-matrix.js';
import { COMPANY_SCOPE_REQUIRED_FOR_ADMIN, productionPermissionValues } from '../../src/modules/rbac/permissions.js';
import { ROLE_CODES } from '../../src/modules/rbac/roles.js';

const LOCATION_A = 'location-a';
const LOCATION_B = 'location-b';
const COMPANY_REQUIRED = new Set(COMPANY_SCOPE_REQUIRED_FOR_ADMIN);
const LOCATION_ONLY_ROLES = [ROLE_CODES.CASHIER, ROLE_CODES.SELLER, ROLE_CODES.WAREHOUSE] as const;

describe('canonical role x permission x scope authorization matrix (Phase 1E)', () => {
  it.each(LOCATION_ONLY_ROLES)('%s: LOCATION assignment at A grants exactly its default permissions at A, never at B', (roleCode) => {
    const ctx = {
      assignments: [
        { roleId: 'r', roleCode, permissions: DEFAULT_ROLE_GRANTS[roleCode], scopeKind: 'LOCATION' as const, locationId: LOCATION_A },
      ],
    };
    for (const permission of productionPermissionValues) {
      const expected = DEFAULT_ROLE_GRANTS[roleCode].includes(permission);
      expect(hasPermissionAtLocation(ctx, permission, LOCATION_A)).toBe(expected);
      expect(hasPermissionAtLocation(ctx, permission, LOCATION_B)).toBe(false);
    }
  });

  it('ADMIN: COMPANY assignment grants every catalogued permission at every location; LOCATION assignment fails every COMPANY-required permission everywhere', () => {
    const companyCtx = {
      assignments: [{ roleId: 'r', roleCode: ROLE_CODES.ADMIN, permissions: DEFAULT_ROLE_GRANTS.ADMIN, scopeKind: 'COMPANY' as const, locationId: null }],
    };
    const locationCtx = {
      assignments: [{ roleId: 'r', roleCode: ROLE_CODES.ADMIN, permissions: DEFAULT_ROLE_GRANTS.ADMIN, scopeKind: 'LOCATION' as const, locationId: LOCATION_A }],
    };
    for (const permission of productionPermissionValues) {
      expect(hasPermissionAtLocation(companyCtx, permission, LOCATION_A)).toBe(true);
      expect(hasPermissionAtLocation(companyCtx, permission, LOCATION_B)).toBe(true);
      expect(hasPermission(companyCtx, permission)).toBe(true);
      if (COMPANY_REQUIRED.has(permission)) {
        expect(hasPermissionAtLocation(locationCtx, permission, LOCATION_A)).toBe(false);
        expect(hasPermission(locationCtx, permission)).toBe(false);
      } else {
        expect(hasPermissionAtLocation(locationCtx, permission, LOCATION_A)).toBe(true);
        expect(hasPermissionAtLocation(locationCtx, permission, LOCATION_B)).toBe(false);
      }
    }
  });

  it('OWNER: COMPANY assignment grants every catalogued permission at every location, even with an empty explicit permissions array', () => {
    const ctx = {
      assignments: [{ roleId: 'r', roleCode: ROLE_CODES.OWNER, permissions: [], scopeKind: 'COMPANY' as const, locationId: null }],
    };
    expect(isOwner(ctx)).toBe(true);
    for (const permission of productionPermissionValues) {
      expect(hasPermission(ctx, permission)).toBe(true);
      expect(hasPermissionAtLocation(ctx, permission, LOCATION_A)).toBe(true);
      expect(hasPermissionAtLocation(ctx, permission, LOCATION_B)).toBe(true);
    }
  });

  it.each(LOCATION_ONLY_ROLES.flatMap((a) => LOCATION_ONLY_ROLES.map((b) => [a, b] as const)))(
    '%s @ A + %s @ B never cross-composes: only each role\'s own default grants apply, only at its own location',
    (roleA, roleB) => {
      const ctx = {
        assignments: [
          { roleId: 'ra', roleCode: roleA, permissions: DEFAULT_ROLE_GRANTS[roleA], scopeKind: 'LOCATION' as const, locationId: LOCATION_A },
          { roleId: 'rb', roleCode: roleB, permissions: DEFAULT_ROLE_GRANTS[roleB], scopeKind: 'LOCATION' as const, locationId: LOCATION_B },
        ],
      };
      for (const permission of productionPermissionValues) {
        expect(hasPermissionAtLocation(ctx, permission, LOCATION_A)).toBe(DEFAULT_ROLE_GRANTS[roleA].includes(permission));
        expect(hasPermissionAtLocation(ctx, permission, LOCATION_B)).toBe(DEFAULT_ROLE_GRANTS[roleB].includes(permission));
      }
    },
  );
});
```

The `ctx`/assignment shape above already matches `Express.ProductionAssignment` and `authorization-policy.ts`'s `Ctx` type exactly (confirmed above, not left as a guess) — no adjustment needed before running.

- [ ] **Step 2: Run**

`cd api && NODE_ENV=test npx vitest run tests/rbac/role-permission-scope-matrix.test.ts --reporter=verbose`

Expected: PASS (this is a regression-lock over already-correct policy code, not a bugfix). A FAIL here is a genuine Phase 1D policy defect discovered by this canonical-matrix testing — STOP, do not modify `src/`, report exact failing `(role, permission, location)` triple and mark DESIGN ESCALATION REQUIRED.

- [ ] **Step 3: Commit**

```bash
git add api/tests/rbac/role-permission-scope-matrix.test.ts
git commit -m "test(rbac): add canonical role x permission x scope authorization matrix (Phase 1E)"
```

---

## Task 8: Phase 1E focused security gate

**Files:** none (verification-only task)

**Full-repository-suite policy (per OpenCode audit item 12):** no full suite is required at Phase 1E closure, and none is run below merely by habit. Rationale: the roadmap scopes Phase 1E's exit criteria to "RBAC test suite green" and commit boundary to "RBAC test suite" (`08-implementation-roadmap.md:322-323`) — narrower than Phase 1D, which owned the authorization middleware itself. Phase 1E's Global Constraints (this plan's header) are schema/migration/backend/frontend: none, so no non-RBAC test file's behavior can regress. The only conditions that would require a full suite are: (a) production source changes occur after an approved DESIGN ESCALATION (none are planned here), or (b) an independent reviewer (OpenCode/Codex) finds a concrete reason requiring it — not assumed in advance.

- [ ] **Step 1: Run the complete Phase 1E RBAC/security focused gate (affected module security tests) once**

```bash
cd api
NODE_ENV=test npx vitest run \
  tests/rbac tests/auth tests/auth.test.ts tests/auth-scope-switch.test.ts tests/authorization.test.ts \
  tests/backoffice tests/realtime \
  tests/sales tests/payments tests/cash tests/inventory tests/products tests/audit \
  --reporter=verbose
```

Record: files passed/failed, tests passed/failed/skipped, duration.

- [ ] **Step 2: Typecheck and lint**

```bash
cd api
npx tsc --noEmit
npm run typecheck   # if the project's current package.json script still requires this separately from tsc --noEmit
npm run lint
```

- [ ] **Step 3: Diff review**

```bash
git status --short
git diff --check
git diff -- api/tests
```

Confirm: only files listed in Tasks 1-7 and 6B changed; no `api/src/**` diff; no whitespace errors.

- [ ] **Step 4: Independent review**

Submit the resulting diff for OpenCode independent audit, then Codex high-rigor review, per this project's established cross-agent workflow — before any push. Neither review is a Phase 1E task deliverable in itself; both gate the commit boundary.

- [ ] **Step 5: Commit boundary**

No new commit here — this task is the closure gate for the commits already made in Tasks 1-7 and 6B. If Steps 1-4 are all green, Phase 1E is ready to move from "independent review" to "cleared to push."

---

## Self-review notes

- **Spec coverage:** every roadmap-required category (privilege escalation, LOCATION vs COMPANY) already has deep pre-existing coverage; this plan's tasks close the three concretely-identified residual gaps (OWNER-per-module HTTP proof, JWT-issuance completion, canonical role×permission×scope matrix) without duplicating anything already PRESENT.
- **No placeholders:** every task step above shows exact file paths, exact reused fixtures/helpers, and either literal test code or an explicit "copy lines X-Y from file Z and swap the role" instruction naming the exact source.
- **Type consistency:** Task 7's `ctx`/`ProductionAssignment` shape is now confirmed directly from `api/src/types/express.d.ts:5-11` and `authorization-policy.ts:26`, not left as an implementer guess.
- **COMPANY-required permissions (`PRICE_MANAGE`/`PRODUCT_MANAGE`/`PRODUCT_VARIANT_MANAGE`) intentionally have no HTTP-level task** — no route exists yet (Phase 2). This is a deliberate scope boundary, not a gap.
- **Post-audit corrections applied (across revisions):** wrong `release-expired` route/mount corrected in Task 2; `cash-session.test.ts` `close()` call corrected to its real 3-arg signature in Task 4; Task 7 reframed from "exhaustive" to "canonical", with malformed/transitional shapes handled by reference to existing coverage instead of new invented cases; duplicate OWNER pending-queue sub-test removed from Task 2 (cited existing proof instead); Task 1 reframed as completing existing real-token issuance coverage rather than introducing it; Socket.IO case count corrected 8→9; RED/"failing test" headings replaced with "regression test"/"Expected: PASS" wording throughout, since Phase 1E introduces no new production behavior; dangling "Coverage Inventory §J/§O" references replaced with concrete citations; backoffice OWNER coverage explicitly reviewed — its REPORT_VIEW gap is now closed by Task 6B (one representative `/dashboard` test, since all five REPORT_VIEW routes share the identical `reportView` middleware instance), while USER_MANAGE is confirmed to need no new test (already proven by the existing scope-assignment privilege-escalation suite). **Codex executability pass:** T3's `sale.id` reference now creates that sale locally via `createSale(1n)`; T4 and T6's comment placeholders (`/* bare user, per Task 2's pattern */`) replaced with literal, paste-executable fixture code, and T4's OWNER `Role` lookup corrected from `db.role.findUniqueOrThrow` (wrong — this file never seeds it) to `createRole(db, 'OWNER')`; T5 split from one flattened "all location-bound" description into three verified-distinct patterns (inventory: query-supplied LOCATION-bound; products: GLOBAL route gate; variants: GLOBAL route gate + service-level `branchId` check), each with its own literal executable fixture using the files' real `prisma` variable; T6's rationale corrected from "location-bound" to GLOBAL (`AUDIT_VIEW` has no `branchScope` option, defaulting to `'global'`); T6B's rationale updated to state explicitly that `REPORT_VIEW` is also a GLOBAL gate; one remaining code-block placeholder in Task 2's `draft-sale.test.ts` snippet (`/* whatever minimal body ... */`) replaced with the file's real literal (`{ branchId: centroId }`), confirmed against the file's own existing create-sale assertions.

---

## Phase 1 Global Closeout Tracking

This section is tracking only. It is **not** part of Phase 1E implementation or its exit gate (Task 8) — nothing here blocks Phase 1E from closing, and none of these items are to be worked during Phase 1E. It exists so these items survive agent/session context changes rather than disappearing between phases.

- **A. `USER_MANAGE` COMPANY-scope decision** — unresolved (`authorization-policy.test.ts:64`). Must be decided before declaring Phase 1 globally complete. Not decided during Phase 1E planning or implementation.
- **B. ADMIN LOCATION → COMPANY one-time backfill on TEST** — tooling already implemented (`admin-company-backfill.service.ts`). Not yet executed. Requires explicit human approval before running against the TEST database.
- **C. Verify TEST backfill result** — after B runs, verify its outcome before proceeding to D.
- **D. ADMIN LOCATION → COMPANY one-time backfill on DEV** — only after C's verification. Requires a separate, explicit human approval — approval for TEST does not carry over to DEV.
- **E. Verify DEV backfill result** — after D runs.
- **F. Admin frontend integration with the per-assignment scope-management API** — required before Production V1 release; not Phase 1E backend scope.
- **G. Socket.IO hot mid-connection revocation** — current connection-time snapshot behavior is accepted as-is (documented, commit `8ebf9d4`); this is a future enhancement only if a requirement changes, not a defect.
- **H. `pg` `client.query()` deprecation warning** — non-blocking technical debt today; should be resolved before any incompatible `pg` upgrade.
- **I. Documentation refresh** — `docs/working/production-v1-status-and-next-steps.md` is dated/stale (see "docs/working strategy" below); `CLAUDE.md` contains stale backoffice/users debt wording. Refresh both at Phase 1 global closeout, not during Phase 1E.
- **J. Frozen-doc reconciliation review** — older Production V1 docs may still describe `UserBranchRole` as an authority source. Do not casually rewrite frozen requirements docs to match current code. Reconcile and document deliberately at Phase 1 closeout, as its own reviewed change.

---

## docs/working strategy

`docs/working/production-v1-status-and-next-steps.md` is a dated recovery/status document, not a frozen spec (unlike `docs/production-v1/**`). It currently contains stale post-1D information, including: a 2026-09-14 checkpoint reference, Phase 1C described as current and Phase 1D as next, old test counts, `backoffice/users` debt already resolved by Phase 1D.4.6, and an outdated HEAD/next-work section.

**Decision: do not modify `docs/working/**` during Phase 1E planning or implementation.** Reason: Phase 1E is itself another short-lived phase — updating this doc mid-Phase-1E would likely make it stale again within the same work cycle, producing repeated low-value edits instead of one accurate refresh. Refresh it exactly once, at Phase 1 global closeout, with: final Phase 1 state, the actual checkpoint, final test evidence, the operational backfill state (Global Closeout items B-E), accepted limitations (items F-G), and remaining release work.
