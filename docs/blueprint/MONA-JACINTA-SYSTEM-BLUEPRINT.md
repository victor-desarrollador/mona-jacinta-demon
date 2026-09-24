# Mona Jacinta — Living System Blueprint

> **MANDATORY UPDATE PROTOCOL.** A future block is not complete until it has
> updated, where applicable:
> Current Resume Pointer (§2) · Git Checkpoint Ledger (§3) · Capability Matrix (§14) ·
> File Responsibility Index (§15) · Block Change Ledger (§16) ·
> Failure & Learning Registry (§17) · Prevention Rules (§18) · Known Debt (§19) ·
> Open Risks (§20) · Audit Trail (§22) · Next Work Queue (§23) · Blueprint Update Log (§25).
>
> Update after: (1) meaningful implementation, (2) a significant failure/root
> cause, (3) an OpenCode review, (4) a Codex review, (5) a local checkpoint,
> (6) an owner full-suite result, (7) push/deployment, (8) a major
> architecture/business decision.
>
> **Git always outranks stale Blueprint status.** Verify before trusting.

Status tags used throughout:

| Tag | Meaning |
| --- | --- |
| `[FROZEN REQUIREMENT]` | From `docs/production-v1/*`. Target, not necessarily implemented. |
| `[CURRENT IMPLEMENTATION]` | Verified in source/schema/tests at the HEAD in §2. |
| `[PILOT DECISION]` | From `docs/pilot-v1.1/*`. Pilot-only overlay. |
| `[TRANSITIONAL]` | Implemented, but scheduled to be replaced by the frozen target. |
| `[UNVERIFIED — NEEDS CONFIRMATION]` | Could not be proven from the repository. Do not rely on it. |

---

## 0. Blueprint Protocol

### 0.1 Purpose

This file is the persistent engineering memory of Mona Jacinta: implementation
state, checkpoints, module map, invariants, failures, root causes, lessons,
deferred work, and the exact resume point. A future engineer or agent should be
able to read it, verify it against git, and continue without rebuilding the
project history from chat logs.

It is a **ledger and map**, not a requirements document.

### 0.2 Source-of-truth precedence

1. `docs/production-v1/*` — `[FROZEN REQUIREMENT]`. The authoritative
   Production V1 requirements and target architecture.
2. Verified current source, schema, and tests — `[CURRENT IMPLEMENTATION]`.
   What the system actually does.
3. `docs/pilot-v1.1/*` — `[PILOT DECISION]`. The Pilot operational overlay.
   It never modifies (1).
4. `docs/blueprint/MONA-JACINTA-SYSTEM-BLUEPRINT.md` (this file) —
   `[LIVING IMPLEMENTATION LEDGER]`. Status, map, checkpoints, lessons,
   failures, handoff, and resume pointer.
5. Older working and demo documents (`docs/working/*`, `docs/plans/*`,
   `docs/architecture/mona-demo-v2.md`, `docs/superpowers/plans/*`) —
   `[HISTORICAL]`.

`AGENTS.md` (the tool-agnostic constitution) and `CLAUDE.md` (Claude Code
operating rules) are process rules. They sit alongside this hierarchy and
govern how work is done.

**Never rewrite a frozen requirement to match transitional code.** When the
frozen target and the implementation differ, record four things: the frozen
target, the current implementation, the gap, and the intended future phase.
§5, §6 and §14 do this.

### 0.3 Verification-before-trust rule

- Every status in this file was true at the HEAD recorded in §2, and only then.
- Before acting on any statement here, check it against `git log`,
  `git status`, and the named source files.
- If this file disagrees with git or source, **git and source win**. Fix this
  file in the same block and add an entry to §25.
- Memory tools and earlier chat context are orientation only.

### 0.4 Update requirements

- Update in place. Keep the major section numbers 0–25 stable.
- §3, §16, §17, §18, §19, §22 and §25 are append-mostly. Mark obsolete rows
  `SUPERSEDED`/`CLOSED` instead of deleting them.
- Give every failure (`F-###`), rule (`RULE-###`) and debt item (`DEBT-###`) a
  stable ID. Never reuse an ID.
- Use full SHAs in the ledgers where they are verified. Never invent a SHA.

### 0.5 No-secrets rule

Never write any of the following into this file: `DATABASE_URL`,
`TEST_DATABASE_URL`, `DIRECT_URL`, JWT secrets, passwords (including deployed
demo passwords), API keys, tokens, connection strings, Supabase project refs
or hosts, or customer PII. Environment *names*, non-secret file paths and
checksums are allowed.

### 0.6 Frozen-doc rule

`docs/production-v1/*` is frozen. Do not edit it to agree with code. Raise the
conflict and record it here (§5/§6/§14 gap columns).

### 0.7 Failure / learning policy

A failed attempt is valuable project information when it teaches a reusable
lesson.

**Register in §17:** correctness defects; authorization defects; stock or
financial invariant problems; concurrency mistakes; unsafe
automation/deployment assumptions; review findings that changed the
architecture; recurring infrastructure traps; errors likely to recur.

**Do not register:** trivial typos, formatting corrections, harmless TypeScript
typos fixed at once, or local command typos with no reusable lesson.

---

## 1. Executive System Definition

### 1.1 Business purpose `[FROZEN REQUIREMENT]`

Mona Jacinta is a multi-user, multi-branch retail commercial system for a
single company (no SaaS tenancy). It covers the in-store POS flow (seller →
cashier), inventory across branches and a central warehouse, cash sessions,
audit, and realtime notifications. Later phases add catalog/pricing tiers,
transfers, suppliers/goods receipts, commercial SEÑA holds,
exchanges/publications, labels, reports, and ARCA fiscal integration
(`docs/production-v1/01..08`).

### 1.2 Operational flow `[CURRENT IMPLEMENTATION]`

```text
SELLER builds a DRAFT sale (cart)  ──send-to-cashier──►  PENDING_PAYMENT
   (technical hold: StockReservation ACTIVE, TTL 30 min; Inventory.reserved += qty)
CASHIER registers payment(s) (split allowed; CASH needs an OPEN cash session)
   ──sum == total──►  PAID
CASHIER completes  ──►  COMPLETED (physical -= qty, reserved -= qty,
                                   StockMovement SALE, holds CONSUMED)
Cancel (DRAFT / PENDING_PAYMENT with no accepted payment) ──► CANCELLED
Expired zero-payment holds ──authoritative release──► RELEASED (Sale stays PENDING_PAYMENT)
```

### 1.3 Pilot objective `[PILOT DECISION]`

Pilot V1.1 is an operational safety overlay. It makes the transitional
seller → cashier technical hold safe to run in a real store before the frozen
`StockHold` model exists. P0.1 is technical-hold expiry
(`docs/pilot-v1.1/00-pilot-safety-gate.md`).

### 1.4 Production V1 direction `[FROZEN REQUIREMENT]`

- Five roles (OWNER, ADMIN, CASHIER, SELLER, WAREHOUSE) with COMPANY/LOCATION
  scopes (`03-role-permission-matrix.md`).
- Dual balance + ledger inventory: `InventoryBalance.onHand` plus
  `StockMovement`, with logical holds (`StockHold`, `SenaItem`) and
  `effectiveSellable` computed at read time (`07-inventory-ledger.md` §3, §5).
- Product-level Code 128 barcode, consumer/wholesale pricing tiers
  (`01-product-scope.md`).
- Phase roadmap 0A–10E (`08-implementation-roadmap.md`).

The current implementation is a Production V1 authorization foundation layered
over the Demo V2 commerce core. See §5 for the separation.

---

## 2. Current Resume Pointer

> THIS SECTION MUST ALWAYS BE CURRENT. Re-verify it with git before acting.

| Field | Value |
| --- | --- |
| Last verified | 2026-09-24T20:31Z (UTC), during the P0.1 final closeout |
| Branch | `feat/production-v1` |
| HEAD (full) | The P0.1 closeout commit `docs(project): close P0.1 pilot reservation safety` (read its SHA from `git log -1`), directly on top of `59e629f988e469c623a792f9867a8cf4f7a949b3` (P0.1-C Blueprint record). |
| HEAD (short) | P0.1 closeout commit, on top of `59e629f` — `docs(project): record P0.1-C checkpoint` |
| Origin branch | `origin/feat/production-v1` |
| Origin HEAD | `6aa8143069f5d4ac1558e9ee87bdf61c159bd475` (D3; verified via local remote-tracking ref, not a fresh fetch) |
| Ahead / behind | `git rev-list --left-right --count origin/feat/production-v1...HEAD` → `0 7` before push (behind 0, ahead 7: `8e9699a`, `ab728be`, `e7b6cc7`, `4eb8101`, `421b584`, `59e629f`, P0.1 closeout). Expected `0 0` once the approved push completes; re-verify with git. |
| Current phase | Pilot V1.1 — P0 safety gates (overlay on Production V1 Phase 1 closeout) |
| Last completed engineering block | **P0.1 (aggregate A + B1 + B2 + C) — COMPLETE / CLOSED LOCALLY.** Slices: A `8e9699a`, B1 `ab728be`, B2 `e7b6cc7`, C `421b584`; Blueprint `4eb8101`, `59e629f`. |
| Current engineering block | None in progress. Next product block: **P0.2** — cashier correction / cancellation / payment UX (not started). |
| P0.1-C status | **IMPLEMENTED · FOCUSED TESTS GREEN (9/9 files, 211/211) · STATIC GATES GREEN · OPENCODE REVIEWED (LOW resolved) · CODEX APPROVED (final 0/0/0/0) · LOCALLY CHECKPOINTED** at `421b58453b7de667cb3ad6a3467a051a14dd61f7` · OWNER FULL SUITE GREEN (aggregate). Evidence: §16 P0.1-C. |
| Current P0.1 aggregate status | **COMPLETE / CLOSED LOCALLY** — technical/block closeout complete. A (`8e9699a`), B1 (`ab728be`), B2 (`e7b6cc7`) and C (`421b584`) are committed locally and audited (A/B1/B2 per owner; C in §22: OpenCode complete, Codex final 0/0/0/0). Final technical gate passed: OWNER full suite: **55/55 test files passed, 855/855 tests passed, 0 failed** (start 15:07:14 local terminal time, duration 7777.98s). Focused P0.1-C evidence stays 9/9 files, 211/211. **Remote synchronization is a separate step** (see Push status). |
| Working tree exceptions | `opencode.json` is modified: legitimate **local-only** configuration. Never inspect, diff, modify, restore, stage or commit it. |
| Full-suite status | **GREEN for the final P0.1 aggregate** at `59e629f` — OWNER full suite: **55/55 test files passed, 855/855 tests passed, 0 failed** (start 15:07:14 local terminal time, duration 7777.98s). Run manually by the OWNER (`cd api && NODE_ENV=test npx vitest run --reporter=verbose`); **no agent ran it**. The captured output shows the Vitest summary only; no separate `VITEST_EXIT` line was captured, so none is recorded. Only the known non-failing `pg` concurrent-query DeprecationWarning appeared (DEBT-009). Previous owner gate: Phase 1C at `7d0c2b6` (37 files / 310 tests / `VITEST_EXIT=0`). |
| Full-suite ownership | **REPOSITORY OWNER ONLY** (§12). Agents never run it. |
| Push status | At the time of this closeout commit, the 7 P0.1 commits (`8e9699a`, `ab728be`, `e7b6cc7`, `4eb8101`, `421b584`, `59e629f`, P0.1 closeout) are **local only, approved for push**. The push is the next step and is **not** claimed here; verify with `git rev-list --left-right --count origin/feat/production-v1...HEAD` (`0 0` = synchronized). |
| Push gate | P0.1-C checkpointed **(done)** **+** independently audited (OpenCode + Codex) **(done)** **+** owner-run final P0.1 full suite green **(done: 55/55, 855/855)**. Gate satisfied: push the approved local P0.1 work (non-force). |
| Exact next action | Push `feat/production-v1` to origin (non-force) and verify `0 0`. Then start **P0.2** (cashier correction / cancellation / payment UX) with its own requirements review — not started. |
---

## 3. Git Checkpoint Ledger

Chronological. The block labels come from commit messages, test comments,
`AGENTS.md`, and `docs/working/*`. The audit column records only what the
repository proves. `pushed` means the commit is an ancestor of
`origin/feat/production-v1` (`6aa8143`).

| Block | Commit | Commit message | Purpose | Audit status | Local/remote | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Demo V2 close | `a5b7b1b` | docs: finalize Demo V2 documentation | End of Demo V2 baseline | — | pushed | Demo V2 history ends before `11bf379` |
| PV1 requirements | `11bf379` → `c7d381e` | docs: define/refine/finalize Production V1 requirements | Frozen requirements baseline | — | pushed | `docs/production-v1/00..04` |
| PV1 architecture | `8a73ab7` → `6c6ab29` | docs: architecture, inventory model, roadmap | Frozen 05–08 | — | pushed | |
| Phase 0 infra | `f10cffe` | test: stabilize hosted database integration suite | Remote-DB suite stability | — | pushed | See F-008 |
| Phase 0B | `683be9c` | docs: define Production V1 migration safety conventions | Migration discipline | — | pushed | |
| Phase 0C | `ed2300b` | feat: add safe database backup and restore workflow | Backup/restore tooling | — | pushed | |
| Phase 0D | `66dd4c0` | docs: approve Production V1 migration readiness | Readiness gate | — | pushed | |
| Phase 1A | `f1fdbfe` | feat: add company and location foundation | Company/Location; `Location.id == Branch.id` | — | pushed | |
| Phase 1B | `5fd4048` | feat: add Production V1 RBAC scope foundation | Role/Permission/UserRoleScope catalog | — | pushed | |
| Phase 1C | `7d0c2b637c07c4911d1d042651a1d8b16c28b96e` | feat: switch legacy branch scopes to UserRoleScope | UserRoleScope becomes the location authority | OpenCode done; Codex 0 blockers; full suite 37/37 files, 310/310 tests | pushed | Per `docs/working/production-v1-status-and-next-steps.md` |
| Context | `d48c622`, `997645c`, `2b4f93d`, `d2bf230` | docs: AI context, security guidance, status, 1D plan | Agent context | — | pushed | |
| Phase 1D | `20d6ce3` → `cefc70d` | Production authorization context/policy/switch | Assignment-based authorization; legacy permissions deleted | [UNVERIFIED — NEEDS CONFIRMATION] | pushed | `e7ac788 "fg"` was reverted by `1d4bb77` (no net effect) |
| Phase 1D.4–1D.5 | `4c382e6` → `8ebf9d4` | ADMIN COMPANY backfill, scope assignment service/endpoints, escalation suite, socket snapshot doc | Scope management | [UNVERIFIED — NEEDS CONFIRMATION] | pushed | |
| Phase 1E | `053f0b4` → `4eed1db` | RBAC/security test plan and matrix | Role × permission × scope proof | [UNVERIFIED — NEEDS CONFIRMATION] | pushed | |
| Phase 1 closeout fixes | `25832de`, `42367c3`, `c74b218`, `7a8e38f`, `c31e25f` | USER_MANAGE COMPANY scope; dry-run preflights; seed convergence; owner bootstrap | Closeout hardening | [UNVERIFIED — NEEDS CONFIRMATION] | pushed | `25832de` = GC2 (F-006) |
| Phase 1D (AGENTS.md checkpoint) | `ca4547569bb3a4b3778a9b6b3ed2c94d8472c52d` | fix(auth): project public roles from production scopes | **D1**: public roles projected from Production assignments only | [UNVERIFIED — NEEDS CONFIRMATION] | pushed | `AGENTS.md` names this SHA as "Phase 1D implemented and pushed". Test comments label it D1 (F-007). |
| A0.1 (?) | `f9f6b5b`, `30b1589` | chore/fix(tooling): Claude project guardrails / harden safety hooks | Tooling guardrails (`.claude/hooks`, `stage-review`) | [UNVERIFIED — NEEDS CONFIRMATION] | pushed | The label "A0.1" appears nowhere in the repository. Mapping these commits to A0.1 is **unverified**. |
| D2.1 | `db7e8a0457dfe5ec6b8cb5a8f0e18506b0dbe1b6` | docs(rbac): record deferred legacy manager decision | MANAGER → DEFERRED governance decision (2026-09-20) | [UNVERIFIED — NEEDS CONFIRMATION] | pushed | `AGENTS.md` "Roles — Production V1" |
| D2.2 | `b592d56ee6f462d697055f5c819ea163202acfcf` | fix(rbac): defer legacy manager and seed canonical scopes | Canonical-first seed; no UserBranchRole from seed | [UNVERIFIED — NEEDS CONFIRMATION] | pushed | |
| D3 | `6aa8143069f5d4ac1558e9ee87bdf61c159bd475` | feat(demo): add admin catalog and initial stock flow | "Demo Operativa V1": admin catalog writes and additive `INITIAL_STOCK` | [UNVERIFIED — NEEDS CONFIRMATION] | **pushed (= origin HEAD)** | Migration `20260922210000_d3_initial_stock_and_global_audit` |
| P0.1-A | `8e9699a585cea727c03cfd15c3ed61b9b233b752` | feat(pilot): add expiry-aware effective availability | Read-side effective availability | OpenCode/Codex: [UNVERIFIED — NEEDS CONFIRMATION]; covered by the P0.1 owner full suite (55/55, 855/855) | **local only (push approved)** | |
| P0.1-B1 | `ab728be6bc78e42918998b1de53f81395865170c` | fix(pilot): make reservation expiry authoritative | Authoritative per-Sale release, system actor | OpenCode/Codex: [UNVERIFIED — NEEDS CONFIRMATION]; covered by the P0.1 owner full suite (55/55, 855/855) | **local only (push approved)** | |
| P0.1-B2 | `e7b6cc7e17f551396efb89aae8f9a52862ff41a3` | feat(pilot): automate expired reservation reconciliation | Pre-send reconciliation plus opt-in sweeper | OpenCode/Codex: [UNVERIFIED — NEEDS CONFIRMATION]; covered by the P0.1 owner full suite (55/55, 855/855) | **local only (push approved)** | |
| Living Blueprint | `4eb8101d1abe1599314f7ed641748c47798fa5c4` | docs(project): add living system blueprint | This ledger + `AGENTS.md` pointer (documentation only) | OpenCode approved for local checkpoint (per owner; not recorded in repo) | **local only (push approved)** | Written at `e7b6cc7`, committed on top of it |
| P0.1-C | `421b58453b7de667cb3ad6a3467a051a14dd61f7` | feat(pilot): enforce payment and completion hold safety | Payment/completion/queue current-hold semantics | OpenCode reviewed (LOW test-evidence finding resolved); Codex: initial review (1 LOW documentation finding, corrected) + narrow recheck → final 0 BLOCKER / 0 HIGH / 0 MEDIUM / 0 LOW, `PILOT P0.1-C CODEX APPROVED FOR LOCAL CHECKPOINT`; P0.1 owner full suite 55/55, 855/855 | **local only (push approved)** | See §16 P0.1-C |
| P0.1-C Blueprint record | `59e629f988e469c623a792f9867a8cf4f7a949b3` | docs(project): record P0.1-C checkpoint | Records the P0.1-C checkpoint and audit state (documentation only) | — | **local only (push approved)** | On top of `421b584`; owner full suite ran at this commit |
| P0.1 closeout | *(this commit; SHA via `git log -1`)* | docs(project): close P0.1 pilot reservation safety | Records the owner aggregate full suite and closes P0.1 (documentation only) | Owner full suite 55/55, 855/855 | **local only at commit time (HEAD); push approved** | On top of `59e629f` |

---

## 4. Repository / Module Map

| Path | Responsibility | Important files | Current state |
| --- | --- | --- | --- |
| `api/` | Express + TypeScript backend; the only database boundary | `src/app.ts`, `src/server.ts` | Operational |
| `admin/` | Backoffice (React 19 + Vite) for OWNER/ADMIN | `src/pages/Products.tsx`, `src/pages/Inventory.tsx`, `src/lib/api.ts` | D3 added catalog, price and initial-stock forms. Full Production V1 role migration not verified. |
| `client/` | Operations POS (Next.js 16 / React 19) for SELLER/CASHIER | `src/app/page.tsx` | Demo V2-era seller/cashier UI; D1 changed role projection handling |
| `api/prisma/` | Schema, migrations, deterministic seed | `schema.prisma`, `seed.ts`, `migrations/` (4) | Transitional inventory model (§6) |
| `api/scripts/` | Explicit operator scripts (dry-run/execute) | `bootstrap-system-actor.ts`, `bootstrap-canonical-owner.ts`, `bootstrap-rbac-catalog.ts`, `backfill-*.ts`, `reset-demo.ts`, `seed-demo.ts`, `demo-database.ts` | Never run implicitly |
| `scripts/database/` (root) | Backup/restore with identity proof | `backup.mjs`, `restore.mjs`, `lib.mjs` | Manual only (Phase 0C) |
| `api/src/config/` | Environment parsing, Prisma client | `env.ts`, `load-env.ts`, `prisma.ts` | Zod env; sweeper variables are opt-in |
| `api/src/middleware/` | Auth, authorization gate, validation, rate limiting, errors | `auth.ts`, `authorization.ts`, `validation.ts`, `rateLimit.ts` | Production-only `requirePermission` |
| `api/src/modules/auth/` | Login, `/me`, JWT, public user-context DTO | `auth.service.ts`, `tokens.ts`, `user-context.dto.ts` | Identity-only JWT (15 min); no refresh |
| `api/src/modules/rbac/` | Authorization context/policy, role/permission catalog, scope tooling | `authorization-context.ts`, `authorization-policy.ts`, `permissions.ts`, `role-permission-matrix.ts`, `legacy-role-map.ts` | Production authority = UserRoleScope |
| `api/src/modules/organization/` | Company/Location | `organization.service.ts` | Single company |
| `api/src/modules/products/` | Catalog reads; D3 admin catalog writes | `products.service.ts`, `catalog-admin.service.ts` | Variant-level barcode and price `[TRANSITIONAL]` |
| `api/src/modules/inventory/` | Availability reads/prechecks; initial stock | `inventory.service.ts`, `initial-stock.service.ts` | Expiry-aware reads (P0.1-A) |
| `api/src/modules/sales/` | Draft/cart, send-to-cashier, holds, expiry, completion, cancellation | `sales.service.ts`, `reservation.service.ts`, `reservation-holds.ts`, `cancellation.service.ts`, `reservation-sweeper.ts` | P0.1-A/B1/B2 complete |
| `api/src/modules/payments/` | Split payments, idempotency | `payments.service.ts` | P0.1-C gaps (§10) |
| `api/src/modules/cash/` | Cash register/session open/close | `cash.service.ts` | Demo V2 level |
| `api/src/modules/audit/` | Audit read route; system actor | `audit.routes.ts`, `system-actor.service.ts` | `shared/audit.ts` writes in-transaction |
| `api/src/modules/backoffice/` | Reports, users, scope assignment | `backoffice.service.ts`, `scope-assignment.service.ts` | Partly legacy presentation (DEBT-011) |
| `api/src/realtime/` | Socket.IO rooms/events (advisory) | `socket.ts` | Connection-time scope snapshot (DEBT-010) |
| `api/src/shared/` | Errors, audit writer, logger, JSON-safe BigInt | `audit.ts`, `logger.ts`, `json-safe.ts` | |
| `api/tests/` | Vitest + Supertest against hosted TEST | `setup.ts`, `globalSetup.ts`, `helpers/test-db.ts`, `sales/reservation-*.test.ts` | Slow remote suite (§12) |
| `docs/production-v1/` | Frozen requirements | `00`–`08` | FROZEN |
| `docs/pilot-v1.1/` | Pilot overlay | `00-pilot-safety-gate.md` | P0.1-A/B1/B2 documented |
| `docs/api/` | Endpoint reference | `endpoints.md` | Includes the P0.1-B1/B2 contract |
| `docs/development/` | Setup, database, migrations, backup | `getting-started.md`, `database.md`, `backup-restore-seed.md`, `migrations.md` | Authoritative for commands |
| `.claude/` | Claude Code guardrails | `hooks/guard-dangerous-bash.mjs`, `hooks/protect-opencode.mjs`, `commands/stage-review.md`, `claude-security-guidance.md` | Active |

---

## 5. Runtime Architecture

| Concern | `[CURRENT IMPLEMENTATION]` | `[FROZEN/TARGET PRODUCTION V1]` | Gap / phase |
| --- | --- | --- | --- |
| Frontends | `client/` (Next.js) and `admin/` (Vite) call the API over HTTP; no DB access | Same; deployed on Vercel (`05-architecture.md` §3) | Deployment not verified in repo |
| API | One Express process (`server.ts`); `createApp()` has no timers | Long-lived container/VM (not serverless) | Deployment `[UNVERIFIED — NEEDS CONFIRMATION]` |
| PostgreSQL | Hosted Supabase: `mona-jacinta-demo` (`DATABASE_URL`) and `mona-jacinta-test` (`TEST_DATABASE_URL`) | Supabase; demo + test (+ production later) | Production DB does not exist yet (`backup-restore-seed.md`) |
| Prisma | Prisma 7 with the `pg` adapter; raw `SELECT … FOR UPDATE` for locks | Same | — |
| Realtime | Socket.IO rooms per branch; events `sale.pending_payment`, `sale.paid`, `sale.completed`, `sale.cancelled`, `inventory.updated`; emitted after commit; advisory only | Notifications persisted (Phase 9B) + realtime (9C) | Notification persistence missing |
| Auth | Login → HS256 JWT, identity-only (`sub`, `iat`, `exp`, `jti`), 15 min; every request rebuilds context from the DB | Same principle | No refresh token (DEBT-008) |
| Authorization | `requirePermission` + `authorization-policy.ts` over `req.auth.assignments` (UserRoleScope) | Same (Phase 1D target) | Legacy `UserBranchRole` still read for the internal `roles` union only `[TRANSITIONAL]` |
| Inventory | `Inventory.physical` / `Inventory.reserved` counters + `StockReservation` rows `[TRANSITIONAL]` | `InventoryBalance.onHand` + `StockMovement` ledger + `StockHold`/`SenaItem` | Phases 3A–3E (DEBT-012) |
| Sales | DRAFT → PENDING_PAYMENT → PAID → COMPLETED / CANCELLED (§8) | Same states + StockHold, pricing finalization (6D) | Phases 6A–6G |
| Payments | `SalePayment` split payments, idempotency key, CASH needs an open session | + transfer institution / installments (6C) | Phase 6C; P0.1-C gaps (§10) |
| Audit | `AuditLog` written inside the business transaction; `branchId` nullable for COMPANY operations (D3); system actor for automation | Same principle | — |
| Background maintenance | P0.1-B2 in-process sweeper, **opt-in, default OFF** `[PILOT DECISION]` | Frozen §5.1: "no sweeper required for sellable correctness"; lazy materialization | Sweeper is Pilot-only liveness, not a correctness dependency |

Transitional components: the `Inventory`/`StockReservation` model, the
variant-level barcode and price, `UserBranchRole` (legacy compatibility), and
`Branch` (co-identified with `Location`, where `Location.id == Branch.id`).

---

## 6. Data / Inventory Model

### 6.1 Current transitional model `[CURRENT IMPLEMENTATION]` `[TRANSITIONAL]`

From `api/prisma/schema.prisma`:

- `Inventory { variantId, branchId, physical BigInt, reserved BigInt }`, unique on
  `(variantId, branchId)`.
- `StockReservation { saleId, variantId, branchId, quantity, expiresAt timestamptz(3), status ACTIVE|RELEASED|CONSUMED }`,
  indexed on `(status, expiresAt)`, `(saleId, status)` and `(variantId, branchId)`.
- `StockMovement` types: `SALE`, `INITIAL_STOCK` (D3). A movement is written only
  when physical stock changes.
- `SaleStatus`: `DRAFT`, `PENDING_PAYMENT`, `PAID`, `COMPLETED`, `CANCELLED`.
- Money is a `BigInt` in integer minor units everywhere.

Stock semantics:

- Raw available = `physical − reserved`.
- `reserved` is a **persisted denormalized counter**. It includes contributions
  from holds that have expired but are not yet released.
- **Effective availability (P0.1-A), read side only:**

```text
releasableExpired = SUM(StockReservation.quantity) WHERE status = ACTIVE
                    AND expiresAt <= now AND sale.status = PENDING_PAYMENT
                    AND sale has zero SalePayment rows      (per branch, variant)
effectiveReserved  = max(reserved − releasableExpired, 0)
effectiveAvailable = physical − effectiveReserved           (never exceeds physical)
```

The raw `reserved` value is still returned for diagnostics.

### 6.2 Frozen target model `[FROZEN REQUIREMENT]`

From `07-inventory-ledger.md` §3 and §5:

- `InventoryBalance { variantId, locationId, onHand }`, with `CHECK onHand >= 0`.
  It has **no** `reserved` column.
- `effectiveSellable = onHand − SUM(effective StockHold) − SUM(effective SenaItem)`,
  where "effective" means `status = ACTIVE AND expiresAt > now()`.
- Hold creation and any operational `onHand` decrement validate
  `effectiveSellable >= qty` with the balance row locked `FOR UPDATE`.
- Technical hold lifetime: "configurable, e.g. 2–4 hours". The Pilot uses
  30 minutes (`TECHNICAL_HOLD_TTL_MS`). This is a recorded divergence, and
  target phase 3C/6B decides it.

### 6.3 Critical invariants

1. **Final stock authority is the locked raw check.** Send-to-cashier reserves
   only when `physical − reserved >= requested` holds under `Inventory … FOR UPDATE`
   (`reservation.service.ts`). Effective availability is advisory UX and a
   pre-check only.
2. Releasing a hold decrements `reserved` by the **exact** held quantity. It
   never clamps and writes no `StockMovement`.
3. Completion decrements `physical` and `reserved` by the same quantity, writes
   `StockMovement(SALE)`, and marks the holds `CONSUMED`. The ACTIVE holds must
   match the sale items exactly.
4. `INITIAL_STOCK` is additive (`physical += qty`), leaves `reserved` alone, and
   writes exactly one movement and one audit row.
5. `Location.id == Branch.id` (Phase 1A migration identity).
6. No partial business state is ever committed. Multi-record operations run in
   Serializable transactions with a bounded retry.

---

## 7. Authentication & Authorization

`[CURRENT IMPLEMENTATION]`, verified in `api/src/modules/rbac/*`,
`api/src/middleware/*` and `api/src/modules/auth/*`.

- **Roles:** exactly `OWNER`, `ADMIN`, `CASHIER`, `SELLER`, `WAREHOUSE`
  (`rbac/roles.ts`). `isProductionRoleCode` filters persisted rows at runtime,
  so a `MANAGER` or unknown `UserRoleScope` row never becomes an assignment
  (fail-closed per row).
- **MANAGER:** legacy only. Classified `DEFERRED` with no automatic Production
  role (`rbac/legacy-role-map.ts`; decision dated 2026-09-20, `AGENTS.md`). Not
  seeded (D2.2).
- **Scope kinds:** `COMPANY` (`locationId = null`) and `LOCATION`.
- **Authority:** `UserRoleScope` is the sole Production role, permission and
  location authority. An empty `UserRoleScope` means zero locations. There is
  no fallback to `UserBranchRole`.
- **Same-assignment rule:** `hasPermissionAtLocation` requires the permission
  and the location to come from the **same** assignment
  (`authorization-policy.ts`).
- **COMPANY-required permissions:** `PRICE_MANAGE`, `PRODUCT_MANAGE`,
  `PRODUCT_VARIANT_MANAGE`, `USER_MANAGE` (`COMPANY_SCOPE_REQUIRED_FOR_ADMIN`).
  A LOCATION assignment never qualifies for these.
- **OWNER:** implicit authority, recognized only in `authorization-policy.ts`
  (`isOwner`), and only for a COMPANY-scoped OWNER assignment. A
  LOCATION-scoped OWNER row is malformed and grants nothing.
- **Policy contract:** the policy is a pure evaluator. Callers must pass a
  persisted or validated `locationId`. A COMPANY assignment matches any
  non-empty string. `effectiveLocationIds` is a display/filter convenience and
  never an authorization authority.
- **UserBranchRole:** legacy compatibility only. It adds `role.code` to the
  internal `roles` union and grants no permission (a type-level guarantee
  since 1D.3.6). Public roles are projected only from assignments
  (`user-context.dto.ts`, D1).
- **JWT:** identity-only (`sub`, `iat`, `exp`, `jti`), HS256, 15-minute
  lifetime (`tokens.ts`). Each authenticated request rebuilds the authorization
  context from the DB (`buildAuthorizationContext`), so revocations take effect
  on the next HTTP request.
- **Realtime exception:** Socket.IO computes scope once per connection and
  keeps it until reconnect (DEBT-010).
- **System actor:** an inactive `User` with zero scopes and zero legacy roles.
  Login refuses it, and it resolves no permissions (§9.2).

---

## 8. Sale Lifecycle

`[CURRENT IMPLEMENTATION]` (`sales.service.ts`, `reservation.service.ts`,
`payments.service.ts`, `cancellation.service.ts`).

| State / transition | Who (permission) | Stock / hold effect | Payment requirement | Audit | Known Pilot limitation |
| --- | --- | --- | --- | --- | --- |
| → `DRAFT` (create) | `SALE_CREATE` at a validated active location | None | — | `SALE_CREATED` | — |
| `DRAFT` cart edits | Owning seller (`SALE_CREATE` route; `SALE_VIEW` at the branch; `sellerId` match) | None; advisory `checkAvailability` uses effective availability (P0.1-A) | — | — | Advisory only; the reserve step decides |
| `DRAFT` → `PENDING_PAYMENT` (send-to-cashier) | Owning seller; `SALE_CREATE` at the sale's branch | P0.1-B2 pre-send reconciliation, then a locked raw check; `reserved += qty`; `StockReservation` ACTIVE with TTL 30 min; sale number allocated | — | `SALE_SENT_TO_CASHIER` (+ `RESERVATION_RELEASED` per reconciled candidate) | Conservative `INSUFFICIENT_STOCK` if maintenance fails |
| `PENDING_PAYMENT` payment (partial) | `SALE_CHARGE` at the branch | None (payment never releases or reserves) | Idempotent replay first; then exact current ACTIVE coverage; **first payment needs unexpired holds** (`RESERVATION_EXPIRED`); later payments may follow `expiresAt` (Policy A); amount ≤ remaining; CASH needs an OPEN session | `PAYMENT_REGISTERED` (none on rejection) | Abandoned partial payment stays manual (P0.2) |
| `PENDING_PAYMENT` → `PAID` | `SALE_CHARGE` | None | Accepted sum == total | `PAYMENT_REGISTERED` | `sale.paid` notification failure is isolated (P0.1-C) |
| Expired-hold release (Sale stays `PENDING_PAYMENT`) | System actor (sweeper / pre-send) or a human with `INVENTORY_MANAGE` (manual endpoint) | Holds `RELEASED`; `reserved −= qty`; no `StockMovement` | Only when the sale has **zero** `SalePayment` rows | `RESERVATION_RELEASED` | Sale stays `PENDING_PAYMENT` and in the queue as `holdState: EXPIRED` (`canAcceptPayment: false`); payment is refused (`INVALID_RESERVATION`). Cancellation works; broader resolution is P0.2. |
| `PAID` → `COMPLETED` | `SALE_COMPLETE` at the branch | `physical −= qty`, `reserved −= qty`; `StockMovement SALE`; holds `CONSUMED` | Must be `PAID`; idempotent if already `COMPLETED`; exact current ACTIVE coverage; `expiresAt` ignored (P0.1-C) | `SALE_COMPLETED` | Consumes only current ACTIVE holds; historical rows ignored. The PAID sale stays in the cashier queue until completed (P0.1-C). |
| `DRAFT`/`PENDING_PAYMENT` → `CANCELLED` | `SALE_CREATE` at the sale's branch (no `sellerId` check in `cancelSale`) | Releases all ACTIVE holds (expired or not) | Refused if the accepted payment sum > 0 | `SALE_CANCELLED` | Cancel after a partial payment is not possible (P0.2 pending correction/cancel) |

---

## 9. Technical Reservation / Expiry Architecture

`[PILOT DECISION]` overlay, all three slices `[CURRENT IMPLEMENTATION]`. The
normative Pilot text is `docs/pilot-v1.1/00-pilot-safety-gate.md`.

**Shared releasable predicate** (`reservation-holds.ts`, `releasableExpiredHoldWhere`):
`StockReservation.status = ACTIVE ∧ expiresAt <= now ∧ Sale.status = PENDING_PAYMENT ∧ Sale has zero SalePayment rows`
(Policy A: payment *row existence*, not the monetary sum). The read projection
and release discovery both use it.

### P0.1-A — Effective availability

- **Commit:** `8e9699a585cea727c03cfd15c3ed61b9b233b752`
- **Formula:** §6.1. `effectiveAvailability(physical, reserved, releasableExpired)`.
- **Files:** `reservation-holds.ts` (new: TTL constant, predicate,
  `loadReleasableExpiredHolds` with one grouped query over exact
  `(branch, variant)` pairs, and the projection), `inventory.service.ts`
  (`getInventoryByBranch`, `getAvailability`, `checkAvailability`),
  `products.service.ts` (seller catalog), `backoffice.service.ts` (inventory report).
- **Rules:** read-only (no writes on read or pre-check); raw `reserved` still
  returned; the authoritative reserve transaction still uses raw
  `physical − reserved`.
- **Tests:** `tests/inventory/effective-availability.test.ts`, plus additions
  in `products/variants.test.ts` and `backoffice/backoffice.test.ts`.

### P0.1-B1 — Authoritative expiry release

- **Commit:** `ab728be6bc78e42918998b1de53f81395865170c`
- **Unit:** `releaseExpiredSaleHolds(saleId, { actor, now, branchIds? })` runs
  **one Sale per Serializable transaction** with a 3-attempt transient retry
  and a 30 s timeout.
- **Lock order:** `Sale FOR UPDATE` → `StockReservation (id ASC) FOR UPDATE` →
  `Inventory (id ASC) FOR UPDATE`. This is the same prefix as cancel and
  payments. Send-to-cashier locks `Sale` → `Inventory (id ASC)` →
  `SaleNumberCounter`.
- **Checks under lock:** found → in scope (`OUT_OF_SCOPE`) → `PENDING_PAYMENT`
  (`NOT_PENDING`) → zero payments (`PAYMENT_PROTECTED`) → expired ACTIVE rows
  exist (`NOTHING_EXPIRED`) → same branch → quantity > 0 → inventory exists
  and `reserved >= qty`. Any invariant failure throws and rolls back the whole
  Sale. Writes are never clamped.
- **Writes:** `reserved: { decrement: qty }` for each variant;
  `updateMany ACTIVE → RELEASED` guarded by `status = ACTIVE` (the updated
  count must equal the locked count); one `RESERVATION_RELEASED` audit per
  Sale with `after = { saleId, reason: 'EXPIRED', trigger, triggeredByUserId?, released }`;
  no `StockMovement`.
- **Batch orchestration** (`reconcile`): discovery runs outside any
  transaction with `groupBy saleId`, `ORDER BY saleId ASC`, and
  `take = limit ?? 100` (`EXPIRED_HOLD_RELEASE_BATCH_LIMIT`). Each candidate is
  released in its own transaction. A failure is recorded as `failed[]` with a
  safe code and never blocks other Sales.
- **Actors:** `ADMIN` = the invoking human; `SYSTEM` = the system actor;
  `SEND_TO_CASHIER` = the system actor + `triggeredByUserId` (context only,
  grants nothing). HTTP input never chooses the actor.
- **System actor** (`audit/system-actor.service.ts`): fixed id/email/name,
  inactive, zero `UserRoleScope`, zero `UserBranchRole`, unusable password
  hash. `resolveSystemActorId` fails closed with
  `503 SYSTEM_ACTOR_UNAVAILABLE` if the actor is absent or tampered with.
  Bootstrap is explicit only (`scripts/bootstrap-system-actor.ts --target=<t> --dry-run|--execute`),
  takes the maintenance advisory lock `506005`, and never repairs.
- **Manual endpoint:** `POST /api/v1/admin/reservations/release-expired`,
  gated by `requirePermission(INVENTORY_MANAGE)`. The controller narrows
  `effectiveLocationIds` to locations where the **same assignment** grants
  `INVENTORY_MANAGE` (F-002). It emits `inventory.updated` for each released Sale.
- **Clock ownership:** `releaseExpiredHoldsAsSystem` and `reconcileBeforeSend`
  read `new Date()` themselves and take no clock parameter (F-003). The manual
  endpoint also uses the server clock.
- **TTL:** `TECHNICAL_HOLD_TTL_MS = 30 min`, shared by reservation creation
  (no duplicated literal).
- **Tests:** `tests/sales/reservation-expiry.test.ts` (B1 section),
  `tests/audit/system-actor.test.ts`.

### P0.1-B2 — Automatic reconciliation

- **Commit:** `e7b6cc7e17f551396efb89aae8f9a52862ff41a3`
- **Pre-send read-only preflight** (`reservation.service.ts` `preflight`): the
  same checks and errors as the locked transaction (not found, not the
  seller's or out of scope, not `DRAFT`, empty). If any fails, the send stops
  and **no** cleanup runs.
- **Targeted discovery:** the target sale's branch plus its exact variant ids.
- **Sale-level release:** each nominated candidate goes through the B1 unit.
  **All** of its expired ACTIVE holds are released together, including
  variants the target does not need. Discovery scope and release scope are
  distinct (RULE-007).
- **Limits:** `PRE_SEND_RECONCILE_LIMIT = 10` for the interactive path.
  `EXPIRED_HOLD_RELEASE_BATCH_LIMIT = 100` for the sweeper and manual endpoint
  (`RESERVATION_SWEEP_BATCH_SIZE` ≤ 100). Candidates beyond the cap stay
  eligible.
- **Failure degradation:** reconciliation failures are logged as
  `reservation_pre_reconcile_failed` (`code`, optional `saleId`), and the send
  continues to the authoritative locked check. The worst outcome is a
  conservative `INSUFFICIENT_STOCK`, never an oversell.
- **Post-commit realtime:** `sales.service.ts` emits `inventory.updated` for
  each committed pre-send release. An emitter throw is logged as
  `reservation_pre_reconcile_notify_failed` (`code: NOTIFY_FAILED`). It is not
  added to `failed[]`, later notifications still go out, and the send proceeds
  (F-005).
- **Sweeper** (`reservation-sweeper.ts`):
  - opt-in (`enabled=false` → inert, no timer);
  - one boot sweep, then a chained `setTimeout` armed only after each run
    settles, so runs never overlap; the timer is `unref`'d;
  - no process-global state;
  - `stop()` clears the timer and awaits any in-flight run;
  - per-Sale failures log `reservation_sweep_sale_failed`;
  - notify failures log `reservation_sweep_notify_failed`;
  - a whole-run failure logs `reservation_sweep_failed` with a safe code, and
    scheduling continues;
  - `reservation_sweep_completed` logs `released`, `failed`, `batchSize` and
    `durationMs`.
- **Lifecycle** (`server.ts`): the server starts the sweeper after `listen`,
  never `createApp()`, so tests and supertest create no timers. It logs
  `reservation_sweeper_enabled|disabled`. Shutdown (SIGINT/SIGTERM, with a 10 s
  timeout) awaits `sweeper.stop()`, then `io.close`, then `prisma.$disconnect()`.
- **Environment** (`config/env.ts`):

  | Variable | Default | Rule |
  | --- | --- | --- |
  | `RESERVATION_SWEEPER_ENABLED` | `false` | exactly `true` or `false` |
  | `RESERVATION_SWEEP_INTERVAL_MS` | `60000` | integer ≥ 1000 |
  | `RESERVATION_SWEEP_BATCH_SIZE` | `100` | integer 1–100 |

- **Multi-instance:** safe through B1's Sale lock plus the guarded
  `ACTIVE → RELEASED` update.
- **Logging:** fixed event names, sale ids, stable codes and counts only. No
  raw error objects or messages, and no PII.
- **Tests:** `tests/sales/reservation-sweeper.test.ts` (DB-free lifecycle +
  static wiring), `tests/sales/reservation-expiry.test.ts` (pre-send section),
  `tests/env.test.ts` (sweeper settings).
- **Known limitation:** batch starvation from permanently corrupt low-id Sales,
  deferred to P0.5 (DEBT-003).

### P0.1-C — Payment / completion / queue current-hold semantics

- **Status:** implemented, audited (OpenCode + Codex), **locally checkpointed** at `421b584`.
- **Pure evaluator** (`hold-coverage.ts`): `evaluateCurrentHoldCoverage` and
  `cashierHoldState`. They take no DB and no global clock, and have no side
  effects.
  - **Coverage rule:** ACTIVE holds only, compared with the SaleItems per
    variant. Holds must be on the sale's own branch and have a positive
    quantity. No missing variant and no extra ACTIVE variant.
  - **Check order:** coverage defects are reported before expiry.
  - **Explicit expiry policy:**
    - `FIRST_PAYMENT { now }`: every hold must satisfy `expiresAt > now`.
    - `PAYMENT_PROTECTED`: expiry is ignored.
    - `PAID_COMPLETION`: expiry is ignored.
- **Callers:** payment (plain reads under the Sale lock), completion (ACTIVE
  rows locked `FOR UPDATE`, `id ASC`) and the queue (informational only).
- **Release authority:** unchanged. Only B1/B2 (and cancellation) release
  holds. Payment only **detects** expiry.
- **[PILOT DECISION / TRANSITIONAL DIVERGENCE]:** Policy A keeps a
  payment-protected hold counted and backing the sale after `expiresAt`.
  - Frozen 04 ("RELEASED on expiry … if no payments were made") and 07 §5.1
    agree that such a hold is not released.
  - Frozen 07 §5.4's sellable formula has no payment exception, so it would
    make the merchandise sellable again after `expiresAt`.
  - The Pilot is the more conservative of the two (it cannot oversell). The
    frozen docs are unchanged; Phase 3C/6B must reconcile this (DEBT-017).

---

## 10. Payment / Cashier Model

### 10.1 `[CURRENT IMPLEMENTATION]` (`payments.service.ts`, `payments.controller.ts`, `sales.service.ts`) — includes P0.1-C (`421b584`)

- `POST /api/v1/sales/:saleId/payments` (`SALE_CHARGE`, re-checked against the
  sale's own branch under the Sale lock). Methods: `CASH`, `TRANSFER`,
  `CARD_DEBIT`, `CARD_CREDIT`, `QR`. Amount > 0. `receivedAmount` is required
  (≥ amount) only for CASH.
- **Order inside the transaction:**
  1. `Sale FOR UPDATE`.
  2. Authorization.
  3. **Idempotent replay** (same key, same intent → `200` with the original
     payment, in any status and after any expiry; a different payload →
     `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD`).
  4. Status must be `PENDING_PAYMENT` (else `INVALID_SALE_STATE`).
  5. **Current coverage** (P0.1-C). Failure → `INVALID_RESERVATION`.
     - Zero `SalePayment` rows: every current hold must be unexpired,
       otherwise `RESERVATION_EXPIRED`.
     - At least one row (Policy A, row existence): expiry is ignored.
  6. `OVERPAYMENT` check.
  7. CASH session check.
  8. Insert the payment (+ `CashMovement`), `PAID` on exact equality, audit.
- **Reserved error codes:**
  - `RESERVATION_EXPIRED` (new, P0.1-C).
  - `INVALID_RESERVATION` (existing code; message now "La venta no tiene
    reservas vigentes que respalden sus artículos.").
- **Clock:** `new Date()` inside the transaction, once per new-payment
  decision. It never comes from the request.
- **Rejected payment:** writes nothing (no payment, cash movement, status
  change, audit or release).
- **Realtime:** `sale.paid` is emitted after commit, only for a new payment
  that made the sale PAID. An emitter throw is logged as
  `payment_notify_failed` (`saleId`, `NOTIFY_FAILED`), and the response stays
  `201` (F-013).
- **Cashier queue:** `GET /api/v1/sales/pending` (`SALE_QUEUE_VIEW`).
  - Rows: `PENDING_PAYMENT` **and** `PAID` in `effectiveLocationIds`, ordered
    by `createdAt ASC, id ASC`.
  - Fields: `paidAmount` and exact BigInt `remainingBalance` (never clamped),
    plus `status`, `holdState` (`VALID` | `EXPIRED` | `PAYMENT_PROTECTED` |
    `PAID` | `COVERAGE_INVALID`) and `canAcceptPayment`.
  - Read-only, with a constant query count.
- **Completion:** `POST /api/v1/sales/:saleId/complete` (`SALE_COMPLETE`); see
  §8. Lock order: Sale → ACTIVE StockReservation (`id ASC`) → Inventory
  (`id ASC`). The consumed count must equal the locked count.
- **Client** (`client/src/app/page.tsx`):
  - The payment action is disabled when `canAcceptPayment === false`, with a
    Spanish note for EXPIRED and COVERAGE_INVALID.
  - A PAID row stays selected, and completion uses the existing `isPaid`
    logic.

### 10.2 P0.1-C decisions (implemented)

| Topic | Implemented behavior | Evidence |
| --- | --- | --- |
| Active-current hold validation before payment | Exact ACTIVE coverage required for every new payment | `paid-transition` "rejects a first payment with …" |
| Zero-payment expired behavior | First payment rejected (`RESERVATION_EXPIRED`); no release from payment; queue `EXPIRED` | `paid-transition`, `pending-queue` |
| Payment-protected behavior | Remaining payment allowed after `expiresAt`; coverage still exact | `paid-transition` Policy A cases |
| Stale protection (`expectedSaleUpdatedAt` / `expectedRemaining`) | **Not implemented**: P0.2 or later | — |
| Paid-before-expiry / completion-after-expiry | PAID completion ignores `expiresAt` | `complete-sale` P0.1-C cases |
| PAID cashier queue visibility | PAID included; client keeps it selected | `pending-queue`, `client/src/app/cashier-queue.test.tsx` |
| Payment remaining calculation | `total − SUM(amount)`, exact BigInt, unclamped | `pending-queue`, `paid-transition` |
| Idempotency | Replay resolved before new-payment checks, also after PAID/COMPLETED/expiry | `paid-transition` replay cases |

### 10.3 `[P0.2 LATER]` — from the owner's brief; no repository doc yet `[UNVERIFIED — NEEDS CONFIRMATION]`

Pending correction, pending cancel (a partially-paid sale cannot be cancelled
today because of `PAYMENT_ALREADY_ACCEPTED`), correction/cancel permissions,
and cashier UX.

---

## 11. Database & Environment Safety

> ⚠️ **READ BEFORE ANY DATABASE-TOUCHING COMMAND.** No credentials appear here.
> They live only in untracked local env files (`.env*` is gitignored).

| Environment | Identification (non-secret) | May | Must never |
| --- | --- | --- | --- |
| **Historical DEV / DEMO** | `DATABASE_URL`; Supabase project `mona-jacinta-demo` (`docs/development/database.md`) | Read-only inspection; the only intended backup *source* | Reset, seed, backfill, migrate, bootstrap or otherwise mutate it **without explicit human approval in the current conversation**; be an automated restore target |
| **TEST** | `TEST_DATABASE_URL`; Supabase project `mona-jacinta-test` | Destructive integration tests (truncate per test), restore drills | Be used for anything the suite does not own; run two vitest processes at once (both truncate TEST) |
| **DEMO / Pilot deployment DB** | `getting-started.md` refers to "the dedicated DEMO database", seeded with `DEMO_SEED_PASSWORD`. Untracked local files `.env.development.demo-candidate` and `.env.development.dev-backup.correct` exist (never read them). | [UNVERIFIED — NEEDS CONFIRMATION]: whether a distinct Pilot DB exists and which file targets it | Mutate without explicit approval; seed it with the public local/TEST demo credential |
| **Production** | Does not exist yet (`backup-restore-seed.md` §2) | — | — |

Immutable operational rules:

1. Never seed, reset, migrate, backfill or bootstrap without first proving the
   target identity. Scripts take an explicit `--target` and a
   `--dry-run`/`--execute` split.
2. **TEST is the only destructive target.** `tests/setup.ts` runs
   `assertTestDatabaseIsolation()` before any test file. It proves, read-only,
   that DEV and TEST are distinct (parsed identity + live metadata) and fails
   closed.
3. Side effect to know: every `api/` vitest run (`setupFiles` + `globalSetup`)
   opens **read-only** metadata connections to DEV as well as TEST, even for
   DB-free test files. When a task forbids contacting DEV, do not run vitest
   with the repo config.
4. The system actor is bootstrapped explicitly, per target, and never at
   startup or by the seed. Its bootstrap status on any environment is
   [UNVERIFIED — NEEDS CONFIRMATION].
5. Migration discipline: never modify an applied migration. Follow
   ADD → BACKFILL → VERIFY → SWITCH → DEPRECATE → REMOVE
   (`docs/development/migrations.md`). Applied migrations: `20260907015311_init`,
   `20260912182432_add_company_location`, `20260912191702_add_user_role_scope`,
   `20260922210000_d3_initial_stock_and_global_audit`.
6. Seeds: Local/TEST seeds use a demo-only credential that is documented in the
   repository's onboarding documentation; its value is intentionally not
   reproduced in this Blueprint. A public demo must use
   `DEMO_SEED_PASSWORD` (never recorded anywhere).

Local backup artifacts (gitignored `backups/database/`; manual Phase 0C
tooling; SHA-256 from their sidecars):

| Artifact | SHA-256 |
| --- | --- |
| `test_drill_20260912T180544Z.dump` | `c9917ee129ec82a950d1a7e7fcfaac32d4ab787b604b5d6eef4c5742ba8427d7` |
| `demo_pre-migration_20260912T182246Z.dump` | `c1a4bc1b1682159aa943f370f523d0c92c174e59082fdf9eba8235929e7c2358` |
| `demo_pre-migration_20260912T191459Z.dump` | `5e72315836b0578aba94c6cd2ff313b226623d0b3a8a4700715f9f2ff1484b7f` |
| `demo_manual_20260912T202029Z.dump` | `32a083ebda9bc111404d01f6e5a6ae9ce15bcf48d7ab904ebb9674df9af22cc6` |

No backup newer than 2026-09-12 is present locally. D3's migration
(2026-09-22) has no matching local `pre-migration` artifact
[UNVERIFIED — NEEDS CONFIRMATION whether one was taken elsewhere].

---

## 12. Testing / Verification Strategy

- **Focused tests first:**
  `cd api && NODE_ENV=test npx vitest run tests/<file>.test.ts --reporter=verbose`.
- **Static gates:** `npm run lint`, `npx tsc --noEmit`, `npm run build`,
  `git diff --check`.
- **Pure/DB-free tests** that must not contact DEV: use a scratch vitest config
  outside the repo with no `setupFiles`/`globalSetup` and synthetic env.
- **Independent review:** OpenCode (broad, read-only, transversal audit), then
  Codex (independent, adversarial final diff review).
- **Local checkpoint:** an exact-file commit once reviews are resolved. Each
  slice of an aggregate (e.g. P0.1-A, -B1, -B2, -C) gets its own local
  checkpoint; none is pushed on its own.
- **Owner full suite (aggregate gate):** run by the owner only once the
  **whole aggregate** (for P0.1: A + B1 + B2 + C) is complete and
  independently audited. `NODE_ENV=test npx vitest run --reporter=verbose`.
  About 58m41s for 310 tests at `7d0c2b6`; 7777.98s (~2h10m) for 55 files /
  855 tests at `59e629f` (P0.1 aggregate). It is slow because it runs against
  hosted TEST (~100 ms/round-trip, `fileParallelism: false`). Slow is not hung.
- **Push** the aggregate's local checkpoints only after that owner full suite is green.

> **FULL-SUITE GATE: OWNER ONLY.** Agents must not run the full suite unless the
> repository owner explicitly changes this rule. (`CLAUDE.md` describes when
> the suite runs. This Blueprint records the owner's rule for who runs it.)

**Infrastructure behavior (not an application failure)**
`[OPERATIONAL OBSERVATION — NOT REPOSITORY-VERIFIED]`: in prior development
sessions, the existing read-only database safety/isolation check has
intermittently timed out during focused test runs, and retries subsequently
passed. No repository artifact records this. Probe reachability before blaming
a change. See F-009.

---

## 13. Development Workflow

```text
inspect → understand source of truth → adversarial cases → RED
→ minimal implementation → focused GREEN → static gates → full diff review
→ OpenCode audit → Codex review → exact local checkpoint → Blueprint update
→ (next slice of the same aggregate, same loop)
→ when the whole aggregate is complete and audited:
  OWNER-ONLY full suite → push (only if green) → remote verification → Blueprint update
```

For P0.1 the aggregate is P0.1-A + P0.1-B1 + P0.1-B2 + P0.1-C. The full suite
and push come after P0.1-C, never between slices.

- One editor at a time. Never run concurrent editing agents on the same working tree.
- Never `git add .` / `-A` / `--all`. Stage exact files only (`.claude/commands/stage-review.md`).
- No commit or push without an explicit request. No push before the approved gate.
- `systematic-debugging` for defects, TDD for behavior changes,
  `verification-before-completion` before any claim.
- `opencode.json` is never staged (see also `383355f`, "exclude opencode config").

---

## 14. Capability Matrix

| Capability | Implemented | Pilot-ready | Production target | Evidence/files | Known gap | Next phase |
| --- | --- | --- | --- | --- | --- | --- |
| Authentication | YES | YES | Same | `auth.service.ts`, `tokens.ts` | 15-min token, no refresh | DEBT-008 |
| RBAC (5 roles, COMPANY/LOCATION) | YES | YES | Same | `rbac/authorization-*.ts`, Phase 1E tests | Socket snapshot; legacy UBR read | DEBT-010/011 |
| Catalog (products) | YES | PARTIAL | Product-level barcode, category/brand | `catalog-admin.service.ts` (D3) | Barcode on variant | 2A/2B |
| Variants | YES | PARTIAL | Enumerated color/size families | `variant.dto.ts` | Free-text color/size | 2D |
| Pricing | TRANSITIONAL | PARTIAL | CONSUMER_FINAL / WHOLESALE tiers | `ProductVariant.price`, `PriceEditor.tsx` | Single price | 2C / DEBT-013 |
| Initial stock | YES | YES | `INITIAL_STOCK` movement | `initial-stock.service.ts` (`IMPORT_RUN`) | Single-row API, no file import | 4D |
| Inventory availability | YES (expiry-aware) | YES | `effectiveSellable` over `InventoryBalance` | `reservation-holds.ts`, `inventory.service.ts` | Transitional counters | 3A–3C |
| Seller draft/cart | YES | YES | Same | `sales.service.ts` | — | — |
| Send-to-cashier | YES | YES | StockHold | `reservation.service.ts` | — | 6B |
| Technical reservations | TRANSITIONAL | YES | `StockHold` | `StockReservation` | Model migration | 3C/6B |
| Expiry reads | YES | YES | Effective predicate | P0.1-A | — | — |
| Authoritative expiry release | YES | YES | Lazy materialization | P0.1-B1 | — | — |
| Pre-send reconciliation | YES | YES | n/a (Pilot) | P0.1-B2 | — | — |
| Background sweeper | YES (opt-in, default OFF) | PARTIAL — needs system actor + explicit enable | Not required by the frozen design | `reservation-sweeper.ts`, `server.ts` | Starvation; not enabled anywhere verified | P0.5 / DEBT-003 |
| Payments (split, idempotent) | YES (P0.1-C, `421b584`) | YES (audited; P0.1 owner full suite green) | + transfer/installment metadata | `payments.service.ts`, `hold-coverage.ts` | Stale-correction guards are P0.2 | 6C |
| Cashier queue | YES (P0.1-C, `421b584`) | YES (audited; P0.1 owner full suite green) | — | `listPendingSales`, `hold-coverage.ts` | Released/expired rows stay until cancelled | P0.2 |
| Completion | YES (P0.1-C, `421b584`) | YES (audited; P0.1 owner full suite green) | + pricing finalization | `completeSaleInTransaction` | — | 6D |
| Cancellation | PARTIAL | PARTIAL | — | `cancelSale` | No cancel after partial payment | P0.2 |
| Cashier correction | NO | NO | — | — | — | P0.2 |
| Audit | YES | YES | Same | `shared/audit.ts`, `AuditLog` | — | — |
| Realtime | YES (advisory) | YES | + persisted notifications | `realtime/socket.ts` | Scope snapshot | 9B/9C |
| Cash session | YES (Demo V2 level) | PARTIAL | + deposit/withdrawal/adjustment types | `cash.service.ts` | Movement types | 6E |
| Session refresh | NO | NO | [UNVERIFIED — NEEDS CONFIRMATION] | `tokens.ts` | `JWT_ACCESS_TTL_SECONDS` is validated in `env.ts` but not read by `tokens.ts` (hardcoded 15 min); config and token lifetime are disconnected | DEBT-008 |
| Backup automation | PARTIAL (manual tooling) | PARTIAL | Hardening in 10C | `scripts/database/*` | No scheduling | DEBT-006 |
| Logging/observability | PARTIAL | PARTIAL | — | `shared/logger.ts`, fixed-code events | No aggregation or alerting | DEBT-004/005 |
| Split payment | YES | YES | 6C metadata | `SalePayment` | — | 6C |
| Import (CSV/XLSX) | NO | NO | Phase 4D | — | — | 4D |
| Transfers, suppliers, SEÑA, exchanges, publications, labels, reports, ARCA | NO | NO | Phases 4–10 | — | — | Roadmap |

---

## 15. File Responsibility Index

| File | Responsibility | Critical invariants | Introduced/changed by block |
| --- | --- | --- | --- |
| `api/src/modules/sales/reservation-holds.ts` | TTL, batch limits, releasable predicate, read projection | Never writes; one predicate for reads and discovery; `effectiveAvailable ≤ physical` | P0.1-A (new), B2 (`PRE_SEND_RECONCILE_LIMIT`) |
| `api/src/modules/sales/reservation.service.ts` | Send-to-cashier: preflight, pre-send hook, locked reserve | The locked raw `physical − reserved` check alone decides; lock order Sale → Inventory → Counter | Demo V2; B1 (TTL constant); B2 (preflight + hook) |
| `api/src/modules/sales/cancellation.service.ts` | Cancel, per-Sale expiry release, reconcile, SYSTEM/pre-send/manual entries | One Sale per transaction; exact decrement; no clamping; guarded status update; automation owns its clock | Demo V2; B1 (rewrite); B2 (`reconcileBeforeSend`, variant filter, limit) |
| `api/src/modules/sales/cancellation.controller.ts` | Cancel and manual release HTTP | Manual scope = same-assignment `INVENTORY_MANAGE` locations | B1 |
| `api/src/modules/sales/reservation-sweeper.ts` | Opt-in scheduler | Inert when disabled; no overlap; `stop` awaits in-flight run; no global state | B2 (new) |
| `api/src/modules/sales/hold-coverage.ts` | Pure current-coverage evaluator + cashier hold state | No DB, no global clock; explicit expiry policy; coverage defects before expiry; ACTIVE rows only | P0.1-C (new, `421b584`) |
| `api/src/modules/sales/sales.service.ts` | Draft/cart, queue, completion; wires pre-send + notifications | Emit only after commit; emit failure isolated; completion consumes exactly the locked ACTIVE rows; queue read-only and PENDING_PAYMENT + PAID | B2 (wiring); P0.1-C (completion, queue) |
| `api/src/modules/sales/sales.controller.ts` | Sales HTTP | Queue accepts no client filters | B2 (options passthrough) |
| `api/src/modules/audit/system-actor.service.ts` | System actor classify/bootstrap/resolve | Inactive, scope-less; fail closed; never repair | B1 (new) |
| `api/scripts/bootstrap-system-actor.ts` | Operator CLI | Explicit `--target`, `--dry-run`/`--execute`; never prints the secret | B1 (new) |
| `api/src/modules/payments/payments.service.ts` | Payments | Sale lock; replay before new-payment checks; exact current coverage; first payment unexpired; never releases; no overpayment | Demo V2; 1D.3.2; P0.1-C |
| `api/src/modules/payments/payments.controller.ts` | Payments HTTP | Committed payment result is never changed by a realtime failure | P0.1-C |
| `client/src/app/page.tsx` (cashier workspace) | Cashier queue/payment/completion UI | Payment action honors `canAcceptPayment`; server stays authoritative | P0.1-C |
| `api/src/modules/rbac/authorization-context.ts` | Builds `req.auth` from the DB | Assignments only from valid Production role codes | 1D; D1 |
| `api/src/modules/rbac/authorization-policy.ts` | The only permission/scope decision point | Same-assignment rule; OWNER only COMPANY; COMPANY-required set | 1D; GC2 |
| `api/src/middleware/authorization.ts` | `requirePermission`, `assertPermissionAtLocation` | Production permissions only | 1D |
| `api/src/modules/auth/user-context.dto.ts` | Public user projection | Public roles from assignments only | D1, D3 |
| `api/src/server.ts` | Process runtime, sweeper lifecycle, shutdown | Sweeper started only here, after listen; stopped before disconnect | B2 |
| `api/src/app.ts` | Express composition | No timers; routes mounted after `requireAuth` | Demo V2; B1 (`/admin` router) |
| `api/src/config/env.ts` | Zod env | Sweeper opt-in, exact booleans, bounded values; errors name variables only | D3; B2 |
| `api/src/modules/inventory/inventory.service.ts` | Availability reads and pre-checks | Read-only; expiry-aware | P0.1-A |
| `api/src/modules/inventory/initial-stock.service.ts` | Additive initial stock | `physical += qty` only; one movement + audit | D3 |
| `api/tests/setup.ts`, `api/tests/helpers/test-db.ts` | DB isolation proof, truncation | Fail closed; destructive only on TEST | Phase 0 |

---

## 16. Block Change Ledger

### P0.1-A — Expiry-aware effective availability

| Field | Value |
| --- | --- |
| Goal | Stop expired, unpaid technical holds from hiding sellable stock in reads and pre-checks |
| Start → end | `6aa8143` → `8e9699a585cea727c03cfd15c3ed61b9b233b752` |
| Files | `reservation-holds.ts` (new); `inventory.service.ts`, `products.service.ts`, `backoffice.service.ts`; 3 test files |
| Behavior added | Effective availability (§6.1); raw `reserved` preserved |
| Explicitly excluded | Any write; changes to the authoritative reserve check |
| Tests | `inventory/effective-availability.test.ts` (+ variants, backoffice) |
| OpenCode / Codex | [UNVERIFIED — NEEDS CONFIRMATION] |
| Deferred | Authoritative release (B1), automation (B2) |
| Commit / push | `8e9699a` / local only |

### P0.1-B1 — Authoritative expiry release

| Field | Value |
| --- | --- |
| Goal | One idempotent, auditable, per-Sale release; attribution for automation |
| Start → end | `8e9699a` → `ab728be6bc78e42918998b1de53f81395865170c` |
| Files | `cancellation.service.ts` (rewrite), `cancellation.controller.ts`, `reservation.service.ts`, `system-actor.service.ts` (new), `scripts/bootstrap-system-actor.ts` (new); tests |
| Behavior added | §9 B1. Replaced the Demo V2 single-transaction batch (F-004); same-assignment manual scope (F-002); clock-free SYSTEM entry (F-003); `<=` expiry boundary |
| Explicitly excluded | Scheduling; pre-send; payment/completion rules |
| Tests | `sales/reservation-expiry.test.ts` (B1), `audit/system-actor.test.ts` |
| OpenCode / Codex | [UNVERIFIED — NEEDS CONFIRMATION] |
| Deferred | B2; P0.1-C |
| Commit / push | `ab728be` / local only |

### P0.1-B2 — Automatic reconciliation

| Field | Value |
| --- | --- |
| Goal | Reclaim expired holds automatically without risking oversell or latency |
| Start → end | `ab728be` → `e7b6cc7e17f551396efb89aae8f9a52862ff41a3` |
| Files | `reservation-sweeper.ts` (new), `reservation.service.ts`, `cancellation.service.ts`, `reservation-holds.ts`, `sales.service.ts`, `sales.controller.ts`, `server.ts`, `env.ts`, `api/.env.example`; `docs/pilot-v1.1/00-pilot-safety-gate.md` (new), `docs/api/endpoints.md`; tests |
| Behavior added | §9 B2 |
| Explicitly excluded | Enabling the sweeper by default; bootstrapping the actor; starvation hardening; payment TTL |
| Tests | `sales/reservation-sweeper.test.ts`, `sales/reservation-expiry.test.ts` (pre-send), `env.test.ts`, `inventory/effective-availability.test.ts` |
| OpenCode / Codex | [UNVERIFIED — NEEDS CONFIRMATION] |
| Deferred | P0.1-C; P0.5 starvation |
| Commit / push | `e7b6cc7` / local only |

### Living Blueprint (documentation checkpoint)

| Field | Value |
| --- | --- |
| Goal | Persistent implementation/status/failure ledger + `AGENTS.md` pointer |
| Start → end | `e7b6cc7` → `4eb8101d1abe1599314f7ed641748c47798fa5c4` |
| Files | `docs/blueprint/MONA-JACINTA-SYSTEM-BLUEPRINT.md` (new), `AGENTS.md` (+6 lines) |
| OpenCode | Approved for local checkpoint (per owner; not recorded in repo) |
| Commit / push | `4eb8101` / local only |

### P0.1-C — Payment / completion / cashier-queue hold semantics

| Field | Value |
| --- | --- |
| Goal | Close the expiry → payment → PAID → completion boundary without weakening stock authority |
| Start → end | `4eb8101` → `421b584` (`421b58453b7de667cb3ad6a3467a051a14dd61f7`) |
| Files (source) | `api/src/modules/sales/hold-coverage.ts` (new), `api/src/modules/payments/payments.service.ts`, `api/src/modules/payments/payments.controller.ts`, `api/src/modules/sales/sales.service.ts`, `client/src/app/page.tsx` |
| Files (tests) | `api/tests/sales/hold-coverage.test.ts` (new), `api/tests/sales/paid-transition.test.ts`, `api/tests/payments/split-payment.test.ts`, `api/tests/sales/complete-sale.test.ts`, `api/tests/sales/pending-queue.test.ts`, `client/src/app/cashier-queue.test.tsx` (new) |
| Files (docs) | `docs/pilot-v1.1/00-pilot-safety-gate.md`, `docs/api/endpoints.md`, this Blueprint |
| Behavior added | §9 P0.1-C and §10.1: exact current coverage; first-payment expiry; Policy A later payments; replay first; PAID completion after expiry; ACTIVE-only completion; PAID in queue + hold states; client payment gating; payment realtime isolation |
| Explicitly excluded | P0.2 correction/cancel, stale-correction guards, any release from payment, schema/RBAC/seed changes |
| Fixture note | Payment tests that paid item-less, hold-less sales now build a realistic held sale (item + matching ACTIVE hold); their assertions are unchanged. Item-less sales now fail closed. |
| Tests (RED) | 23 API tests failed for the expected reasons, plus 1 client test (EXPIRED payment button); realtime isolation RED (`500` instead of `201`) |
| Tests (GREEN) | **Authoritative final focused run** (API, on the final source, 2026-09-24 16:02:58Z start, 3044.86s, `VITEST_EXIT=0`; counts taken from the Vitest JSON reporter by file identity): **9/9 files passed, 211/211 tests passed, 0 failed, 0 skipped** — `tests/sales/hold-coverage.test.ts` 18, `tests/sales/paid-transition.test.ts` 39, `tests/payments/split-payment.test.ts` 24, `tests/sales/complete-sale.test.ts` 23, `tests/sales/pending-queue.test.ts` 25, `tests/sales/reservation-expiry.test.ts` 38, `tests/sales/cancellation.test.ts` 17, `tests/audit/audit.test.ts` 16, `tests/inventory/stock-movement-invariant.test.ts` 11. No infrastructure timeout occurred. Earlier run (superseded): 211 tests, 210 passed, 1 failed — a pre-existing order-dependent assertion (`findMany` without `orderBy` in "finalizes two variants atomically…": identical rows, swapped order), fixed with an explicit `orderBy` (RULE-017). Its per-file breakdown was mis-transcribed (`cancellation` recorded as 19 instead of 17, so the parts summed to 213); that was OpenCode's LOW bookkeeping finding, now **resolved** by the reporter-derived counts above. Client `src/app`: 10/10 (separate client run; not part of the API run above). |
| Static gates | API lint, `tsc --noEmit`, `typecheck`, `build`: PASS. Client lint, `tsc --noEmit`, `build`: PASS. `git diff --check`: PASS. |
| Pure-test validity | The evaluator tests were proven to catch mutants (boundary `<` vs `<=`, dropped branch check, released→EXPIRED mapping, expiry applied to protected sales) with a DB-free harness |
| OpenCode / Codex | OpenCode: reviewed (per owner); LOW test-count bookkeeping finding resolved (see Tests (GREEN)). Codex: initial adversarial read-only review — BLOCKER 0, HIGH 0, MEDIUM 0, LOW 1 (documentation only: stale §3 audit state), no runtime/test change required; LOW corrected; narrow recheck completed → final **0 BLOCKER / 0 HIGH / 0 MEDIUM / 0 LOW**, verdict `PILOT P0.1-C CODEX APPROVED FOR LOCAL CHECKPOINT`. |
| Commit / push | `421b58453b7de667cb3ad6a3467a051a14dd61f7` + Blueprint record `59e629f` + P0.1 closeout commit / local at closeout time, push approved. |
| Owner aggregate gate (P0.1) | **GREEN** — OWNER full suite: **55/55 test files passed, 855/855 tests passed, 0 failed** (start 15:07:14 local terminal time, duration 7777.98s). Run manually by the OWNER at `59e629f`; no agent ran it; no separate `VITEST_EXIT` line captured, so none recorded. Known non-failing `pg` DeprecationWarning only (DEBT-009). **P0.1 COMPLETE / CLOSED LOCALLY.** |

### Older blocks (summary; strong evidence only)

| Block | Commit(s) | Goal | Push |
| --- | --- | --- | --- |
| Phase 1C | `7d0c2b6` | UserRoleScope location authority; full gate 310/310 | pushed |
| Phase 1D | `20d6ce3` → `cefc70d`, `ca45475` | Production authorization switch; legacy permissions deleted | pushed |
| Phase 1E | `053f0b4` → `4eed1db` | RBAC/security test matrix | pushed |
| D1 | `ca45475` | Public roles from Production assignments | pushed |
| D2.1 / D2.2 | `db7e8a0`, `b592d56` | MANAGER deferred; canonical-first seed | pushed |
| D3 | `6aa8143` | Admin catalog, price edit, additive initial stock, nullable `AuditLog.branchId`, `DEMO_SEED_PASSWORD` | pushed |

---

## 17. Failure & Learning Registry

Evidence labels: `[VERIFIED]` = supported by current source/git/tests/docs;
`[OPERATIONAL OBSERVATION]` = supported only by development-session evidence;
`[UNVERIFIED]` = precise provenance cannot currently be established. A defect
can be `[VERIFIED]` from before/after git evidence even when the reviewer who
first reported it is unknown.

Only failures verified from git, code or tests are listed. When the *detection
source* (for example, which reviewer found an issue) is not in the repository,
it is marked unverified. The defect and its fix are still verified.

### F-001 — Stale expired holds reduced reported availability `[VERIFIED]`

- **Block:** P0.1-A · **Severity:** HIGH (operational: sellable stock appeared unavailable)
- **Symptom:** a hold stayed counted in `Inventory.reserved` after its TTL until something released it, so reads and pre-checks under-reported stock.
- **Evidence:** `[VERIFIED]` — pre-A reads used raw `physical − reserved`; P0.1-A diff and regression tests.
- **Detection source:** exact detector/reviewer unverified; defect and remediation verified from git and tests.
- **Root cause:** `reserved` is a persisted counter. Expiry had no read-side meaning.
- **Impact:** false "no stock" at the seller catalog, inventory and backoffice.
- **Fix:** the expiry-aware read projection (§6.1).
- **Regression tests:** `effective-availability.test.ts` ("reports a unit held only by an expired zero-payment hold as available", "lets checkAvailability pass when the counter is stale only because of a releasable hold").
- **Prevention:** RULE-001, RULE-009 · **Status:** CLOSED · **Commit:** `8e9699a`.

### F-002 — Manual expiry release used cross-assignment location union `[VERIFIED]`

- **Block:** P0.1-B1 · **Severity:** HIGH (authorization)
- **Symptom:** before `ab728be`, the controller passed `req.auth.effectiveLocationIds` (the union across all assignments) to the release. A user with `INVENTORY_MANAGE` at location A and any other role at location B could release holds at B.
- **Evidence:** `[VERIFIED]` — before/after in the `git show ab728be` diff of `cancellation.controller.ts`.
- **Detection source:** exact detector/reviewer unverified; defect and remediation verified from git.
- **Root cause:** a location list was used as authority instead of the centralized same-assignment policy.
- **Fix:** filter with `hasPermissionAtLocation(auth, INVENTORY_MANAGE, id)`, plus a scope recheck under the Sale lock (`OUT_OF_SCOPE`).
- **Regression tests:** `reservation-expiry.test.ts` › "manual endpoint scope" (3 cases).
- **Prevention:** RULE-004 · **Status:** CLOSED · **Files:** `cancellation.controller.ts`, `cancellation.service.ts`.

### F-003 — Automatic release must not accept a caller clock `[VERIFIED remediation · UNVERIFIED provenance]`

- **Block:** P0.1-B1 · **Severity:** HIGH (stock integrity)
- **Symptom (risk):** a SYSTEM entry that accepted `now` could release unexpired holds.
- **Evidence:** remediation `[VERIFIED]` in source and a dedicated regression test. The pre-fix defect is `[UNVERIFIED]`: B1 landed as one commit, so no git state shows a clock-accepting SYSTEM entry.
- **Detection source:** unverified.
- **Fix:** `releaseExpiredHoldsAsSystem` and `reconcileBeforeSend` read the wall clock internally and take no clock parameter.
- **Regression tests:** "never lets a SYSTEM caller supply the clock: a smuggled future now cannot release unexpired holds"; sweeper "passing exactly { limit: batchSize } and no clock".
- **Prevention:** RULE-002 · **Status:** CLOSED.

### F-004 — Demo V2 expiry batch: one transaction, sum-based protection, `<` boundary `[VERIFIED]`

- **Block:** P0.1-B1 (fixing `c15cb67`, Demo V2) · **Severity:** HIGH (liveness/consistency)
- **Symptom (verified in `ab728be^`):**
  - All candidate Sales were released in **one** transaction, so one corrupt Sale rolled back every release.
  - Discovery was unbounded.
  - Payment protection used the accepted **sum > 0**.
  - Expiry used `expiresAt < now`.
  - No system actor existed.
- **Evidence:** `[VERIFIED]` — `git show ab728be^:api/src/modules/sales/cancellation.service.ts` versus current source.
- **Detection source:** exact detector/reviewer unverified; defect and remediation verified from git.
- **Root cause:** the demo-grade maintenance design had no per-unit isolation.
- **Fix:** one Sale per Serializable transaction; bounded (100) deterministic discovery; Policy A row existence; the `<=` boundary shared with P0.1-A; hardened guarded status update.
- **Regression tests:** "isolates a corrupt sale: healthy sales before and after it still commit", "treats expiresAt == now as releasable", "does not release … when any SalePayment row exists — even a zero-amount corrupt row".
- **Prevention:** RULE-005, RULE-007 · **Status:** CLOSED.

### F-005 — Pre-send realtime failure must not be classified as reconciliation failure `[VERIFIED remediation · UNVERIFIED provenance]`

- **Block:** P0.1-B2 · **Severity:** MEDIUM (observability correctness)
- **Symptom (risk):** a throwing emitter after a committed release could be reported as `reservation_pre_reconcile_failed`, stop later notifications, or abort the send.
- **Evidence:** remediation `[VERIFIED]` in `sales.service.ts`, the Pilot doc contract and a regression test. The pre-fix defect is `[UNVERIFIED]`: B2 landed as one commit.
- **Detection source:** unverified.
- **Fix:** a per-release `try/catch` in `sales.service.ts` logs `reservation_pre_reconcile_notify_failed`. Nothing is rolled back, nothing goes into `failed[]`, and the send continues.
- **Regression test:** "isolates a throwing realtime emit: later notifications still go out and the send proceeds"; sweeper "keeps sweeping when a realtime notification throws".
- **Prevention:** RULE-006 · **Status:** CLOSED · **Commit:** `e7b6cc7`.

### F-006 — LOCATION-scoped ADMIN could manage any user company-wide (GC2) `[VERIFIED]`

- **Block:** Phase 1 global closeout · **Severity:** HIGH (authorization)
- **Symptom:** a transitional LOCATION-scoped ADMIN passed the global `USER_MANAGE` gate.
- **Evidence:** `[VERIFIED]` — `25832de` diff and its commit comment in `permissions.ts`.
- **Detection source:** exact detector/reviewer unverified; defect and remediation verified from git.
- **Root cause:** `USER_MANAGE` has no location dimension but was not in the COMPANY-required set.
- **Fix:** added `USER_MANAGE` to `COMPANY_SCOPE_REQUIRED_FOR_ADMIN` (commit comment in `permissions.ts`).
- **Regression tests:** `rbac/privilege-escalation.test.ts`, `backoffice/scope-assignment.test.ts`, `backoffice/backoffice.test.ts`.
- **Prevention:** RULE-004 · **Status:** CLOSED · **Commit:** `25832de53a4945f7219a69831bc88e6918270f41`.

### F-007 — Public roles projected from legacy UserBranchRole `[VERIFIED]`

- **Block:** D1 · **Severity:** MEDIUM (authorization presentation / UX correctness)
- **Symptom:** a canonical Production user with zero `UserBranchRole` rows did not publicly project their real role (test comment in `auth/user-context-dto.test.ts`).
- **Evidence:** `[VERIFIED]` — `ca45475` diff and D1 test comments.
- **Detection source:** exact detector/reviewer unverified; defect and remediation verified from git.
- **Root cause:** the public DTO derived roles from the legacy-inclusive internal `roles` union.
- **Fix:** public roles are projected only from Production `assignments`.
- **Regression tests:** `auth/user-context-dto.test.ts`, `auth/me.test.ts`, `auth/login-scope-switch.test.ts`, `client/src/app/page.test.tsx`.
- **Prevention:** RULE-004, RULE-010 · **Status:** CLOSED · **Commit:** `ca4547569bb3a4b3778a9b6b3ed2c94d8472c52d`.

### F-008 — Full suite appeared hung (remote TEST latency) `[VERIFIED]`

- **Block:** Phase 0 / 1C · **Severity:** LOW (infrastructure trap, recurring)
- **Symptom:** a full `vitest run` showed no output for many minutes.
- **Root cause:** hosted TEST at ~100 ms/round-trip, sequential fixture awaits, and `fileParallelism: false`. The suite was slow, not stuck.
- **Evidence:** `[VERIFIED]` — `f10cffe`, `docs/working/production-v1-status-and-next-steps.md` §11, `CLAUDE.md` testing policy.
- **Fix:** `f10cffe` (config + `docs/testing/strategy.md`); use `--reporter=verbose`.
- **Prevention:** RULE-011 · **Status:** MITIGATED (DEBT-015 performance).

### F-009 — Intermittent safety/isolation-check timeout during focused test runs `[OPERATIONAL OBSERVATION — NOT REPOSITORY-VERIFIED]`

- **Evidence strength:** prior development-session observations only. No repository artifact (commit, test, doc) records it. Do not treat it as repository-verified.
- **Block:** observed during P0.1 development (session date 2026-09-23) · **Severity:** LOW (infrastructure, not application)
- **Observation:** the existing read-only database safety/isolation check has intermittently timed out during focused test runs, and retries subsequently passed.
- **Verified context:** `api/tests/setup.ts` runs `assertTestDatabaseIsolation()` before every test file, and `docs/testing/strategy.md` states that the setup connects read-only to both targets and aborts if it cannot prove distinct identities. A timeout there therefore fails closed before any test runs.
- **Mitigation:** retry; probe reachability before blaming a change; never run two vitest processes at once.
- **Prevention:** RULE-011 · **Status:** OPEN (infrastructure).

### F-010 — First payment accepted on an expired zero-payment hold `[VERIFIED]`

- **Block:** P0.1-C · **Severity:** HIGH (stock integrity: an expired hold became payment-protected and outlived its TTL)
- **Evidence:** `[VERIFIED]` — the pre-P0.1-C `payments.service.ts` (at `4eb8101`) checked only `status = ACTIVE`, never `expiresAt`. RED test observed.
- **Detection source:** Blueprint §10.2 gap analysis and the P0.1-C RED run.
- **Symptom:** if no pre-send or sweeper release had touched the sale, a cashier could take the first payment after the TTL. Under Policy A that payment then protected the stale hold indefinitely.
- **Root cause:** payment validated reservation *status*, not *current validity*. Expiry had meaning only for the release paths.
- **Fix:** `FIRST_PAYMENT` policy (`expiresAt > now`, own clock) → `RESERVATION_EXPIRED`, with no side effects.
- **Regression tests:** `paid-transition` "rejects a first payment on an expired zero-payment hold …"; `hold-coverage` boundary tests.
- **Prevention:** RULE-013, RULE-015 · **Status:** FIXED (`421b584`, audited) · **Files:** `payments.service.ts`, `hold-coverage.ts`.

### F-011 — Historical reservation rows treated as current coverage (payment and completion) `[VERIFIED]`

- **Block:** P0.1-C · **Severity:** MEDIUM (false rejection; correctly covered sales could not be paid or completed)
- **Evidence:** `[VERIFIED]` — at `4eb8101`, payment rejected on *any* non-ACTIVE row, and completion locked all rows and threw on any non-ACTIVE row. RED tests observed for both.
- **Symptom:** a `RELEASED` or `CONSUMED` row next to correct ACTIVE coverage blocked payment and completion.
- **Root cause:** the code reasoned over *all* reservation rows of the sale instead of the current ACTIVE set.
- **Fix:** both paths read ACTIVE rows only and use the shared evaluator. Completion consumes exactly the locked ACTIVE ids.
- **Regression tests:** `paid-transition` "ignores a historical RELEASED row …"; `complete-sale` "ignores a historical RELEASED/CONSUMED row … and never re-consumes it".
- **Prevention:** RULE-009 (extended), RULE-014 · **Status:** FIXED (`421b584`) · **Files:** `payments.service.ts`, `sales.service.ts`.

### F-012 — PAID sale disappeared from the cashier queue `[VERIFIED]`

- **Block:** P0.1-C · **Severity:** MEDIUM (operational: a paid sale could be left uncompleted with its stock reserved)
- **Evidence:** `[VERIFIED]` — at `4eb8101`, `listPendingSales` filtered `status: 'PENDING_PAYMENT'`. The client re-selects only rows present in the refreshed queue. RED test observed.
- **Symptom:** after the final payment, the queue refresh dropped the sale. If it was the last row, the cashier lost the completion action.
- **Root cause:** the queue was modelled as "awaiting payment", not as the cashier's work (payment + completion).
- **Fix:** the queue includes `PAID`, with `status`/`holdState`/`canAcceptPayment`.
- **Regression tests:** `pending-queue` inclusion, hold-state and live-scope cases; client `cashier-queue.test.tsx` "keeps the sale selected and completable …".
- **Prevention:** RULE-016 · **Status:** FIXED (`421b584`).

### F-013 — Realtime failure turned a committed payment into HTTP 500 `[VERIFIED]`

- **Block:** P0.1-C · **Severity:** MEDIUM (financial ambiguity at the counter)
- **Evidence:** `[VERIFIED]` — `payments.controller.ts` at `4eb8101` called `realtime.emit` unguarded after commit. Express 5.2.1 routes the rejection to `errorHandler`. The RED test got `500` for a persisted payment.
- **Symptom:** the cashier sees an error for money actually taken and may charge the customer again. A different-key retry is rejected (sale PAID); a same-key retry replays safely.
- **Root cause:** the B2 realtime-isolation rule (RULE-006) had not been applied to the payment controller.
- **Fix:** `try/catch` around the emit; `payment_notify_failed` warn log with a safe code; the response stays `201`.
- **Regression test:** `paid-transition` "keeps a committed final payment successful when the sale.paid notification throws".
- **Prevention:** RULE-006 (extended) · **Status:** FIXED (`421b584`). Other post-commit emits (send-to-cashier, complete, cancel, manual release) still have the pattern: DEBT-018.

### Review-history candidates not registered as failures

"Interactive pre-send inherited the 100-Sale batch" and "batch starvation"
were named as possible entries. The first is reflected only in the final
design (`PRE_SEND_RECONCILE_LIMIT = 10`, and the Pilot doc: "a separate
limit"). No intermediate commit shows the defect, so it is recorded as
RULE-008 and not as a failure. Starvation is an acknowledged limitation
(DEBT-003), not an observed failure. The PAID cashier-queue gap later became
F-012 when P0.1-C reproduced it in a RED test.

---

## 18. Prevention Rules / Engineering Lessons

| ID | Rule | Why | Enforced by | Related |
| --- | --- | --- | --- | --- |
| RULE-001 | Final stock authority is the **locked raw** `physical − reserved >= qty` check. Effective/expiry-aware values are advisory. | Reads can be stale, and maintenance can fail | `reserveInTransaction`; test "keeps the authoritative reserve transaction on raw physical - reserved" | F-001 |
| RULE-002 | Automatic maintenance owns its production clock. No caller-supplied `now` on automated entries. | A smuggled clock releases live holds | Signatures of `releaseExpiredHoldsAsSystem`/`reconcileBeforeSend`; clock test | F-003 |
| RULE-003 | Automatic writers default **OFF** and need an explicit opt-in (`=== 'true'`). They start only from the server runtime, never `createApp()`. | Tests and deployments must not mutate data implicitly | `env.ts`, `server.ts`, sweeper static wiring tests | — |
| RULE-004 | Authorization goes through the centralized policy (`hasPermission`/`hasPermissionAtLocation`) with permission and location from the **same assignment**. `effectiveLocationIds` is never authority. | Cross-assignment unions leak authority | `authorization-policy.ts`; escalation + scope tests | F-002, F-006, F-007 |
| RULE-005 | Maintenance isolates units and degrades conservatively. One Sale per transaction, failures logged with safe codes, and the business path continues to its authoritative check. | One bad row must not block every release, and failures must never oversell | `reconcile`, `reconcileBeforeSend` | F-004 |
| RULE-006 | Realtime failure never changes, retries or rolls back committed DB state, **and never changes the HTTP result of a committed operation**. It is logged separately from DB failures. | PostgreSQL is the source of truth, and realtime is advisory | Per-release `try/catch` in `sales.service.ts`, the sweeper, `payments.controller.ts` | F-005, F-013 |
| RULE-007 | Candidate discovery scope and Sale-level release scope are distinct: discovery may be narrow, but release is always the whole Sale's expired set. | Prevents half-released Sales and keeps one audit per Sale | B2 test "releases a nominated candidate Sale atomically…" | F-004 |
| RULE-008 | Interactive maintenance needs a stricter latency bound than background work (10 vs 100). | Counter wait time | `PRE_SEND_RECONCILE_LIMIT`; cap test | — |
| RULE-009 | Historical rows (`RELEASED`, `CONSUMED`, or ACTIVE on non-pending sales) never count as current releasable coverage. | Conservative availability | `releasableExpiredHoldWhere`; A tests | F-001 |
| RULE-010 | Frozen requirements are not rewritten to match transitional code. Record the gap instead. | Keeps the target stable | `AGENTS.md`, `CLAUDE.md`, §0.6 | — |
| RULE-011 | Treat test-infrastructure latency or timeouts as infrastructure first: use a verbose reporter, probe reachability, retry, and run only one vitest process. | Avoids false root causes | `CLAUDE.md` testing policy, §12 | F-008, F-009 |
| RULE-013 | A payment that creates financial protection (the first payment) must validate that the stock protection it inherits is still current (`expiresAt > now`), using its own clock. | Otherwise a stale hold becomes permanent | `FIRST_PAYMENT` policy; `paid-transition` | F-010 |
| RULE-014 | Current coverage is always the ACTIVE set compared exactly with the current items. History (RELEASED/CONSUMED) is neither coverage nor a blocker, and is never consumed again. | Historical rows coexist legitimately | `hold-coverage.ts`; payment + completion tests | F-011 |
| RULE-015 | Expiry policy is explicit per lifecycle step (first payment / payment-protected / paid completion), never a bare boolean. Only B1/B2/cancel release holds; other paths only detect. | One release authority; no hidden semantics | `HoldExpiryPolicy`; "never writes a release … from the payment path" | F-010 |
| RULE-016 | A work queue shows every state that still needs an action from its user (for the cashier: PENDING_PAYMENT **and** PAID), with a fail-closed state for corrupt rows. | Work must not vanish between steps | `listPendingSales`; queue + client tests | F-012 |
| RULE-017 | Tests that assert an ordered list of DB rows must request an explicit `ORDER BY`. PostgreSQL row order is unspecified, and updates can change it. | Order-dependent assertions flake nondeterministically | `complete-sale` two-variant test (`orderBy: { variantId: 'asc' }`) | — (P0.1-C final run) |
| RULE-012 | Privileged technical identities (the system actor) are inactive and scope-less, created only by explicit bootstrap, and fail closed when tampered. They are never repaired automatically. | Audit attribution without granting authority | `system-actor.service.ts`; system-actor tests | — |

---

## 19. Known Debt / Deferred Work

| ID | Item | Why deferred | Risk | Target phase | Pilot blocker? | Status |
| --- | --- | --- | --- | --- | --- | --- |
| DEBT-001 | P0.1-C payment/completion hold rules (§10.2) | — | — | P0.1-C | Was YES | **CLOSED** — `421b584`, audited (OpenCode + Codex 0/0/0/0), P0.1 owner full suite green (55/55, 855/855) |
| DEBT-002 | Cashier pending correction / pending cancel / permissions / UX | Scoped after P0.1 | Partially paid or released sales cannot be resolved | P0.2 | [UNVERIFIED — NEEDS CONFIRMATION] | OPEN |
| DEBT-003 | Sweeper batch starvation (id-ordered; permanently corrupt low-id Sales) | Pilot doc defers it | Healthy expired holds wait for pre-send or manual release | P0.5 | No | OPEN |
| DEBT-004 | Log aggregation / rate limiting of repeated failure logs | Not in P0.1 scope | Log noise every tick | [UNVERIFIED — NEEDS CONFIRMATION] | No | OPEN |
| DEBT-005 | Broader observability (metrics, alerting) | Not scoped | Silent degradation | 10C [UNVERIFIED — NEEDS CONFIRMATION] | [UNVERIFIED] | OPEN |
| DEBT-006 | Backup automation / scheduling | `backup-restore-seed.md` §10: scheduling not implemented | Stale backups; the latest local backup is 2026-09-12 | 10C | [UNVERIFIED — NEEDS CONFIRMATION] | OPEN |
| DEBT-007 | Pre-migration backup for D3 not evidenced locally | — | Recovery gap | — | [UNVERIFIED] | TO CONFIRM |
| DEBT-008 | Session refresh absent. `env.JWT_ACCESS_TTL_SECONDS` is parsed and validated by the Zod env schema (`env.ts`), but `tokens.ts` never reads it (it imports `env` only for `JWT_SECRET`); it owns its own hardcoded 15-minute constant (`ACCESS_TOKEN_SECONDS`). The configured value and the actual token lifetime are therefore disconnected. | Not scoped | Users logged out mid-shift; config confusion | [UNVERIFIED — NEEDS CONFIRMATION] | [UNVERIFIED] | OPEN |
| DEBT-009 | `createTestPrismaClient()` pool lifecycle; `pg` concurrent-query deprecation warning | Pre-existing (`CLAUDE.md`) | Test resource leaks; the warning ("removed in pg@9.0") becomes an error on a `pg@9` upgrade | — | No (warning appeared, non-failing, in the P0.1 owner full suite 55/55, 855/855) | OPEN |
| DEBT-010 | Socket.IO scope is a connection-time snapshot | Documented in 1D.5 | Revoked user keeps receiving room events until reconnect | 9C | No | OPEN |
| DEBT-011 | `backoffice/users` legacy `UserBranchRole` presentation; deferred MANAGER rows retirement | Phase 1 closeout | Confusing admin view | 10D | No | OPEN |
| DEBT-012 | Target `InventoryBalance`/`StockMovement`/`StockHold` migration | Roadmap order | Transitional counters | 3A–3E, 6B | No | OPEN |
| DEBT-013 | Pricing tiers (CONSUMER_FINAL / WHOLESALE, cash discount) | Roadmap | Single price only | 2C | [UNVERIFIED] | OPEN |
| DEBT-014 | Product-level barcode (currently unique per variant) | Roadmap | Label/scan model mismatch | 2B | [UNVERIFIED] | OPEN |
| DEBT-015 | Test suite performance (~59 min at 310 tests; 7777.98s ≈ 2h10m at 855 tests for P0.1) | Correctness first | Slow gates | — | No | OPEN |
| DEBT-016 | `AGENTS.md` "Checkpoint" section is stale (names D2 as current work) | This block was limited to adding a minimal pointer | Misleads agents | Next docs touch, with owner approval | No | OPEN |
| DEBT-017 | [PILOT DECISION / TRANSITIONAL DIVERGENCE] Policy A vs frozen 07 §5.4 sellable formula (no payment exception) and frozen lazy on-touch release | Pilot keeps one conservative release authority | Target design must decide explicitly | 3C/6B | No | OPEN |
| DEBT-018 | Other post-commit realtime emits (send-to-cashier, complete, cancel, manual release) can still turn a committed result into HTTP 500 if the emitter throws | Outside P0.1-C payment scope; same-key/replay retries are idempotent | Misleading error after commit | Next realtime/POS hardening block | [UNVERIFIED — NEEDS CONFIRMATION] | OPEN |
| DEBT-019 | Expiry decisions use each API instance's wall clock (payment, B1/B2, queue) | Pre-existing design (B1) | Clock skew shifts the boundary between instances; all paths still serialize on the Sale lock, so no double outcome | Deployment hardening | No | OPEN |

---

## 20. Current Open Risks

| Risk | Trigger | Impact | Existing mitigation | Next action |
| --- | --- | --- | --- | --- |
| ~~Payment accepted on an expired-but-unreleased hold~~ | — | — | **CLOSED in P0.1-C (`421b584`; F-010)**; owner full suite green | — |
| ~~Paid sale disappears from the cashier queue~~ | — | — | **CLOSED in P0.1-C (`421b584`; F-012)**; owner full suite green | — |
| Released/expired sale lingers in PENDING_PAYMENT | Expiry release or expired zero-payment hold | Queue clutter; now shown as `EXPIRED`, not chargeable | Cancel works (no payments) | P0.2 |
| Abandoned partial payment | Customer leaves after a partial payment | Hold stays protected indefinitely (Policy A); stock stays reserved | Visible as `PAYMENT_PROTECTED`; manual handling | P0.2 |
| PAID sale with corrupt coverage | Manual data damage | Cannot complete (`INVALID_RESERVATION`); shown as `COVERAGE_INVALID` | Fail closed; audit trail | Manual/P0.2 |
| ~~Uncommitted P0.1-C work~~ | — | — | **CLOSED** (`421b584`) | — |
| Unpushed local checkpoints | 7 P0.1 commits only on this machine at closeout time | Loss of work | Local git; push gate now satisfied | Push (non-force) and verify `0 0`; close this risk once origin = HEAD |
| Sweeper enabled without a system actor | Env flag set before bootstrap | No releases; error logs each tick (fail closed, process stays up) | Fail-closed resolution | Bootstrap before enabling (§21) |
| Wrong-target DB mutation | Operator error with multiple local env files | Data loss on DEV/DEMO | Identity proofs, dry-run/execute, `.claude/hooks` | Keep explicit approval discipline |

---

## 21. Environment / Deployment State

- **Environments:** see §11. Credentials are never recorded.
- **Deployment architecture:** the frozen target is Vercel for the frontends
  and a long-lived container/VM for the API (`05-architecture.md` §3). The
  repository has no deployment configuration, and the current deployment state
  is [UNVERIFIED — NEEDS CONFIRMATION].
- **Sweeper:** the implementation is at `e7b6cc7`. It is **disabled by
  default**. **The B2 implementation and checkpoint do NOT mean the sweeper is
  enabled in any deployment.** No environment is verified to have
  `RESERVATION_SWEEPER_ENABLED=true`.
- **System actor prerequisite:** run
  `npx tsx scripts/bootstrap-system-actor.ts --target=<target> --dry-run`, then
  `--execute`, from `api/` **before** enabling the sweeper. Without it, the
  pre-send step and sweeper fail closed (no cleanup writes). Bootstrap state per
  environment: [UNVERIFIED — NEEDS CONFIRMATION].
- **Push/deploy status:** origin is at D3 (`6aa8143`). P0.1-A/B1/B2 are
  intentionally not pushed. They wait for the P0.1 aggregate push gate
  (P0.1-C completed and audited, then the owner full suite green). Nothing is
  deployed by this work.

---

## 22. Audit Trail

| Block | Reviewer | Verdict | Material findings | Resolution | Checkpoint |
| --- | --- | --- | --- | --- | --- |
| Phase 1C | OpenCode | Completed | Runtime fixes (Claude Code TDD) | Fixed before gate | `7d0c2b6` |
| Phase 1C | Codex | 0 blockers | — | — | `7d0c2b6` |
| P0.1-A | OpenCode | [UNVERIFIED — NEEDS CONFIRMATION] | — | — | `8e9699a` |
| P0.1-A | Codex | [UNVERIFIED — NEEDS CONFIRMATION] | — | — | `8e9699a` |
| P0.1-B1 | OpenCode | [UNVERIFIED — NEEDS CONFIRMATION] | Likely F-002/F-003 (unverified attribution) | Fixed in commit | `ab728be` |
| P0.1-B1 | Codex | [UNVERIFIED — NEEDS CONFIRMATION] | — | — | `ab728be` |
| P0.1-B2 | OpenCode | [UNVERIFIED — NEEDS CONFIRMATION] | Likely F-005 / RULE-008 (unverified attribution) | Fixed in commit | `e7b6cc7` |
| P0.1-B2 | Codex | [UNVERIFIED — NEEDS CONFIRMATION] | — | — | `e7b6cc7` |
| Living Blueprint | OpenCode | Approved for local checkpoint (per owner; 1 MEDIUM wording fix applied: DEBT-008) | DEBT-008 wording | Fixed before checkpoint | `4eb8101` |
| P0.1-C | OpenCode | Reviewed; approved for Codex (per owner) | LOW: §16 focused-test per-file counts inconsistent (summed to 213 vs 211) | Resolved: counts re-derived from the completed run's JSON reporter output (211/211, exit 0) | `421b584` |
| P0.1-C | Codex | Initial review: CHANGES REQUIRED (documentation only) — BLOCKER 0, HIGH 0, MEDIUM 0, LOW 1. Narrow recheck: **APPROVED** — final 0 BLOCKER / 0 HIGH / 0 MEDIUM / 0 LOW, `PILOT P0.1-C CODEX APPROVED FOR LOCAL CHECKPOINT` | LOW: §3 ledger still said "Pending OpenCode + Codex" | Corrected (§2, §3, §16, §22, §23); no runtime/test change required; recheck confirmed | `421b584` |
| P0.1 aggregate | OWNER full suite (manual; not an agent) | **GREEN** — 55/55 files, 855/855 tests, 0 failed (start 15:07:14 local, 7777.98s) | None; known non-failing `pg` DeprecationWarning (DEBT-009) | — | `59e629f` |

The owner states that P0.1-A, P0.1-B1 and P0.1-B2 were each independently
audited (OpenCode and Codex) before their local checkpoints. The verdict
details are not recorded in the repository, so the rows above stay
unverified until the owner fills them in from the review records. Future
blocks must record reviewer verdicts here at review time.

---

## 23. Next Work Queue

| # | Block | Goal | Dependencies | Status | Exit condition |
| --- | --- | --- | --- | --- | --- |
| 1 | Living Blueprint review | Finish review; local documentation checkpoint | — | **DONE** (`4eb8101`) | — |
| 2 | **P0.1-C implementation** | Payment/completion/queue hold semantics (§9, §10) | P0.1-B2 | **DONE** | RED → focused GREEN; static gates; diff review; adversarial review |
| 3 | OpenCode audit of P0.1-C | Independent transversal review | 2 | **DONE** — LOW test-count bookkeeping finding resolved (§16) | Findings resolved |
| 4 | Codex audit of P0.1-C | Independent adversarial review | 3 | **DONE** — initial review (1 LOW documentation finding, corrected) + narrow recheck: final 0/0/0/0, APPROVED FOR LOCAL CHECKPOINT | Findings resolved; Codex approval recorded in §22 |
| 5 | Local P0.1-C checkpoint | Exact-file commit | 4 | **DONE** (`421b584` + Blueprint record commit) | P0.1 aggregate (A + B1 + B2 + C) complete and audited |
| 6 | **OWNER ONLY:** final P0.1 full-suite gate | Full suite over the whole P0.1 aggregate | 5 | **DONE — GREEN** (owner, manual): 55/55 files, 855/855 tests, 0 failed, 7777.98s; no separate `VITEST_EXIT` line captured | Owner records a green result here |
| 7 | Push approved local P0.1 work | Push only if step 6 is green | 6 | **NEXT** (approved; not yet pushed at closeout commit) | origin = local HEAD; remote verified; Blueprint updated |
| 8 | Later Pilot safety gates | **P0.2 — cashier correction / cancellation / payment UX (next product block, per owner; not started; no repo requirements doc yet)**; P0.3/P0.4 (no repository source) [UNVERIFIED — NEEDS CONFIRMATION]; P0.5 (includes sweeper starvation hardening, per Pilot doc) | 7 | PLANNED | Per verified project decisions; acceptance criteria not yet defined |

---

## 24. Resume Instructions for Next Agent

1. Read `AGENTS.md`.
2. Read `CLAUDE.md` (or your tool's equivalent).
3. Read this Blueprint, especially §2, §10, §19–§23.
4. Read the frozen requirements for the current block (`docs/production-v1/*`)
   and the Pilot overlay (`docs/pilot-v1.1/*`).
5. Run:
   `git branch --show-current`, `git rev-parse HEAD`, `git log -8 --oneline`,
   `git status --short`, `git diff --check`,
   `git rev-list --left-right --count origin/feat/production-v1...HEAD`.
6. Compare the results with §2 and §3.
7. Where they differ, trust git and source over this file.
8. Resolve discrepancies before editing. Record them in §25.
9. Continue from §2 "Exact next action".
10. Update this Blueprint (see the Mandatory Update Protocol at the top) before
    declaring the block complete.

Never inspect, modify, stage or commit `opencode.json`. Never touch
DEV/DEMO data without explicit approval. Never run the full suite (owner only).

---

## 25. Blueprint Update Log

Append-only.

| Date (UTC) | Block/event | HEAD | Sections updated | Reason |
| --- | --- | --- | --- | --- |
| 2026-09-24 | Blueprint creation | `e7b6cc7e17f551396efb89aae8f9a52862ff41a3` | All (0–25) | Initial ledger at the verified P0.1-B2 local checkpoint; documentation only |
| 2026-09-24 | Pre-review correction pass | `e7b6cc7e17f551396efb89aae8f9a52862ff41a3` | §2, §11, §12, §13, §17, §20, §21, §22, §23 | Corrected the P0.1 workflow order (P0.1-C next; owner full suite and push only after the whole P0.1 aggregate is audited); removed a demo credential value; added evidence labels to F-001–F-009 (F-009 is an operational observation) |
| 2026-09-24 | P0.1-C implemented (uncommitted) | `4eb8101d1abe1599314f7ed641748c47798fa5c4` | §2, §3, §8, §9, §10, §14, §15, §16, §17, §18, §19, §20, §22, §23, §25 | Reconciled the `4eb8101` documentation checkpoint; recorded P0.1-C behavior, F-010–F-013, RULE-013–RULE-016, DEBT-017–DEBT-019, the Policy A transitional divergence, and review readiness |
| 2026-09-24 | P0.1-C focused-test evidence reconciled (uncommitted) | `4eb8101d1abe1599314f7ed641748c47798fa5c4` | §2, §16, §22, §23, §25 | Resolved OpenCode's LOW test-count bookkeeping finding. Counts now come from the Vitest JSON reporter of the final focused API run (9/9 files, 211/211 tests, exit 0; `cancellation` is 17, not 19). A Claude Code/API connectivity interruption (`ECONNREFUSED`) occurred after the focused Vitest process had already completed with exit code 0; it did not affect test execution or application behavior, and is not a product F-###. The focused run was not repeated. |
| 2026-09-24 | P0.1-C Codex initial review recorded; LOW corrected (uncommitted) | `4eb8101d1abe1599314f7ed641748c47798fa5c4` | §2, §3, §16, §22, §23, §25 | Codex adversarial read-only review: BLOCKER 0, HIGH 0, MEDIUM 0, LOW 1 (documentation only). The LOW was the stale §3 P0.1-C audit state ("Pending OpenCode + Codex"); corrected here. No runtime/test change required; focused-test evidence (9/9 files, 211/211) unchanged; no tests run. Final Codex approval not yet given: narrow recheck pending. |
| 2026-09-24 | P0.1-C local checkpoint | `421b58453b7de667cb3ad6a3467a051a14dd61f7` | §2, §3, §9, §10, §14, §15, §16, §17, §20, §22, §23, §25 | Codex narrow recheck completed: final 0 BLOCKER / 0 HIGH / 0 MEDIUM / 0 LOW, `PILOT P0.1-C CODEX APPROVED FOR LOCAL CHECKPOINT`. Exact-file implementation commit `421b584` (13 files: source, tests, API/Pilot docs; Blueprint and `opencode.json` excluded), then this Blueprint record commit. Focused evidence unchanged (9/9 files, 211/211, 0 failed, 0 skipped, exit 0); no tests run. P0.1 is checkpointed locally but **not formally closed**: the owner final aggregate full suite is pending. Nothing pushed. |
| 2026-09-24 | P0.1 final closeout | `59e629f988e469c623a792f9867a8cf4f7a949b3` | §2, §3, §12, §14, §16, §19, §20, §22, §23, §25 | OWNER ran the final aggregate P0.1 full suite manually (agents did not): 55/55 files, 855/855 tests, 0 failed, start 15:07:14 local, 7777.98s; no separate `VITEST_EXIT` line captured, so none recorded. Known non-failing `pg` DeprecationWarning (existing DEBT-009). OpenCode and Codex (final 0/0/0/0) complete; focused P0.1-C evidence unchanged (9/9, 211/211). **P0.1 COMPLETE / CLOSED LOCALLY**; push approved, remote synchronization pending at commit time. Next product block: P0.2. |
