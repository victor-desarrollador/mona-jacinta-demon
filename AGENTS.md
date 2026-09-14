# AGENTS.md

Mona Jacinta — sistema comercial multiusuario y multisucursal. Tool-agnostic
project constitution: applies to Claude Code, OpenCode, Codex, and any other
agent working in this repository. Claude Code has an additional, narrower
`CLAUDE.md` for its own operating instructions; it does not repeat what is
here.

---

## Repository

This repository (`mona-jacinta-demon/`) is the live Mona Jacinta codebase,
currently on **Production V1**. `api/`, `client/`, and `admin/` all exist and
are operational — do not assume otherwise.

- `api/` — Express + TypeScript backend. Source of truth for business logic
  and the database.
- `client/` — Operations application (Next.js 16 / React 19), used by
  branch-level staff.
- `admin/` — Backoffice (React 19 + Vite), used by OWNER/ADMIN.

Do not claim `client/` or `admin/` have been fully migrated to the Production
V1 role model (below) unless you have verified their current source — their
Demo V2-era code may still predate that migration.

The legacy e-commerce implementation (historically "Babymart" / "L&V tienda")
lives at `../Tesis/` and is **read-only reference material**. Never modify
it. Legacy code may only be inspected and selectively ported after review;
do not assume its structure reflects Mona Jacinta's target architecture.

---

## Backend architecture

- Express + TypeScript, Prisma 7, PostgreSQL.
- Modular monolith (`api/src/modules/{auth,rbac,organization,products,
  inventory,sales,payments,cash,audit,backoffice,...}`).
- Hosted PostgreSQL via two separate Supabase projects: DEV and TEST. Supabase
  provides infrastructure only — no Supabase Auth/Realtime/Storage/Edge
  Functions, no client SDKs, no direct frontend→database access.
- Express + Prisma are the **sole** database boundary. `client/` and `admin/`
  never see `DATABASE_URL`/`TEST_DATABASE_URL` and never talk to Postgres
  directly.

---

## Roles — Production V1

Exactly five roles exist. Do not invent or reintroduce others:

```
OWNER
ADMIN
CASHIER
SELLER
WAREHOUSE
```

`MANAGER` is **not** a Production V1 role. It survives only as a legacy
`UserBranchRole` code from Demo V2, explicitly mapped to `WAREHOUSE` by
Phase 1C's backfill (`api/src/modules/rbac/legacy-role-map.ts`). Do not use
`MANAGER` in new code, docs, or examples.

Canonical role/permission definitions: `docs/production-v1/03-role-permission-matrix.md`.

---

## Authorization checkpoint

- **Phase 1A** — `Company`/`Location` foundation. `Location.id == Branch.id`
  is the migration identity invariant; treat it as load-bearing everywhere a
  branch/location id is compared.
- **Phase 1B** — Production RBAC catalog (`Role`/`Permission`/
  `RolePermission`) and empty `UserRoleScope` foundation.
- **Phase 1C** (closed — see Checkpoint below) — `UserRoleScope` is
  authoritative for effective LOCATION scope. An empty `UserRoleScope` means
  **zero** authorized locations — there is **no** fallback to
  `UserBranchRole` for location authority. `COMPANY` scope remains
  **fail-closed** until Phase 1D. `UserBranchRole` is retained temporarily,
  solely for legacy role/permission compatibility (not location scope).
- **Phase 1D** (next, not started) — owns the final Production authorization
  switch. Target business model:

  - **OWNER** — COMPANY scope, full authority.
  - **ADMIN** — COMPANY scope, operational authority over all branches and
    the central warehouse; cannot escalate to OWNER or perform OWNER-only
    sensitive actions.
  - **CASHIER** — LOCATION scope(s), cash/POS duties only.
  - **SELLER** — LOCATION scope(s), sales duties only.
  - **WAREHOUSE** — LOCATION scope(s), inventory/warehouse duties only.
  - OWNER/ADMIN assign and reassign employee location scopes.
  - Reassigning an employee changes their `UserRoleScope`, **never** their
    role.

Full phase-by-phase detail: `docs/production-v1/08-implementation-roadmap.md`.

---

## Priorities

When trade-offs are required, in this exact order:

```
data integrity
> security
> business rules
> traceability
> architecture
> tests
> performance
> UX
> aesthetics
```

---

## Cross-agent workflow

- **Claude Code** — primary controlled implementer.
- **OpenCode** — broad/transversal read-only audit.
- **Codex** — independent, high-rigor final diff review.

Never let multiple agents edit the same working tree concurrently.

Development workflow for any non-trivial change:

1. inspect the affected area completely;
2. identify all equivalent/repeated patterns;
3. use systematic debugging for defects (never speculative fixes);
4. use TDD for behavior changes;
5. implement the smallest coherent change;
6. run focused verification;
7. review the complete diff;
8. get independent review for critical changes;
9. run the expensive full test suite only as the final gate.

---

## Database safety

- Destructive integration tests run only against **TEST**.
- **DEV** must never be reset, backfilled, or otherwise mutated without
  explicit human approval.
- Never print, log, or commit `DATABASE_URL`, `TEST_DATABASE_URL`, or any
  other credential. Use `.env.example` with placeholder values only.
- Never rewrite an already-applied Prisma migration.
- Do not use `git add .`/`git add -A` blindly; inspect staged files before
  committing, since generated or secret-bearing files may be present.

---

## Frozen documentation

`docs/production-v1/*` is the authoritative source for Production V1
architecture and requirements. Production requirements outrank legacy
implementation and outrank existing code whenever they conflict. Do not edit
`docs/production-v1/*` merely to make it agree with current code — raise the
conflict instead.

`docs/development/getting-started.md` and `docs/development/database.md`
document the actual current setup/workflow commands; prefer them over
inference from code when they exist.

---

## Evergreen engineering rules

These remain valid regardless of phase:

- **Money**: integer minor units (centavos) everywhere — database, API,
  frontend, tests. Never use floating-point arithmetic as the authoritative
  monetary representation, and never mix representations across layers.
- **Transactions/concurrency**: operations touching multiple critical
  records (sale completion, inventory mutation, cash movements) use explicit
  PostgreSQL transactions and must guard against insufficient stock,
  duplicate completion, duplicated stock deductions, and partial writes. No
  partially-completed business state may ever persist.
- **Realtime**: Socket.IO events are notifications only — PostgreSQL is
  always the source of truth. The system must behave correctly if an event
  is delayed, duplicated, or missed; clients refetch authoritative state.
- **Security/secrets**: never expose secret values in chat, logs, plans,
  README files, commits, screenshots, examples, or tests. Frontend
  visibility is never a security boundary — the backend is the sole
  authorization enforcement point.
- **Validation**: Zod at input boundaries.
- **Service layering**: prefer services/use-cases for business logic; avoid
  large controllers containing business rules; isolate infrastructure
  concerns; keep critical transactions explicit; avoid hidden side effects.
- **Language**: UI-facing strings in Spanish; code identifiers in English;
  comments in either, but clear.
- **Inspect before modifying**: do not assume current file placement is
  intentional target architecture; do not silently expand or change scope
  or architecture.
- **Honesty**: never claim tests passed, builds passed, or a migration
  succeeded without actually having run/verified it. State blockers
  clearly. Prefer root-cause fixes over patches.

---

## Git conventions

- Small, meaningful commits; do not stage secrets or generated build output.
- Inspect `git diff --staged` before committing.
- Do not force-push or rewrite history unless explicitly approved.
- Current active branch: `feat/production-v1`.

---

## Checkpoint

Phase 1C closed and pushed at `7d0c2b6` ("feat: switch legacy branch scopes
to UserRoleScope"). Gate at that commit: 37/37 test files, 310/310 tests,
`VITEST_EXIT=0`. Phase 1D (authorization middleware/services) is next; see
`docs/production-v1/08-implementation-roadmap.md`.

Do not use this section as a phase diary — update it in place at each
checkpoint rather than appending history. Full history lives in `git log`.

---

## History

Demo V2 (employee auth, branches, products/variants, seller draft → cashier
→ paid → completed sale, split payments, cash sessions, audit, realtime) was
designed, implemented, and verified in full before Production V1 began; its
roles (`SELLER/CASHIER/MANAGER/ADMIN`) and phase plan are superseded by the
Production V1 model above and by `docs/production-v1/08-implementation-roadmap.md`.
Do not treat any old Demo V2 planning content as current. For that history,
see `git log` (commits before `11bf379`, "docs: define Mona Jacinta
Production V1 requirements") and `docs/architecture/mona-demo-v2.md`.
