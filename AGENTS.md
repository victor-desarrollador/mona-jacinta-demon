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
- A separate **PILOT** database is addressed only by the OWNER-only tooling in
  `scripts/database/pilot-*.mjs`. It reads its connection from a private file
  outside the repository, never from `.env*`, `DATABASE_URL` or
  `TEST_DATABASE_URL`, and has no fallback to TEST or DEV. No runtime code in
  `api/src`, `client/` or `admin/` imports it.

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

`MANAGER` is **not** a Production V1 role. It survives only as legacy Demo V2
migration input (`UserBranchRole` codes), where applicable.

Historical Phase 1C migration semantics mapped legacy `MANAGER` rows
automatically to `WAREHOUSE`. That interpretation is **superseded** by an
explicit human-approved decision (2026-09-20). Current legacy migration
classification:

```
ADMIN   -> ELIGIBLE -> ADMIN
CASHIER -> ELIGIBLE -> CASHIER
SELLER  -> ELIGIBLE -> SELLER
MANAGER -> DEFERRED -> no automatic Production role
```

A deferred `MANAGER` row gets no automatic `WAREHOUSE` conversion, no
automatic `OWNER` conversion, and no automatic `UserRoleScope` from Phase 1C
— it remains visible as an explicit legacy/deferred migration row, handled
later through explicit retirement/re-provisioning decisions. `WAREHOUSE` is
provisioned independently, as a native Production V1 role/assignment, never
derived from `MANAGER`. **This supersession changes migration identity
semantics only; it does not remove WAREHOUSE from Production V1.**

Older wording in frozen `docs/production-v1/06-erd-data-model.md` and
`docs/production-v1/00-master-index.md` describing "MANAGER→WAREHOUSE" is
historical Production V1 baseline text, not the current legacy-migration
rule; those frozen files are not edited by this note. Broader reconciliation
of frozen Production V1 documentation against this supersession remains
deferred to Phase 1 global closeout.

Do not use `MANAGER` in new code, docs, or examples.

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
- **Phase 1D** — implemented and pushed (`ca4547569bb3a4b3778a9b6b3ed2c94d8472c52d`).
  Owns the final Production authorization switch. Target business model:

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

- Destructive integration tests run only against a marker-proven test
  database, checked read-only before any test file runs:
  - hosted **TEST** — the default target, proven by its own identity marker
    (`mona_test_guard.database_identity`);
  - **LOCAL_TEST** — only when explicitly selected with
    `MONA_TEST_DATABASE_TARGET=local`: the disposable loopback database
    `mona_local_test@127.0.0.1:5432/mona_local_test` (CI job `local-postgres`,
    or an owner-provisioned local PostgreSQL 17+), proven by
    `mona_local_test_guard.database_identity`.
  Any other selector value fails closed, and neither target ever falls back to
  the other or to DEV. The `api/` test harness never reads or connects to
  `DATABASE_URL` (DEV); DEV is never a destructive test target. A missing,
  copied or malformed marker fails closed. The LOCAL_TEST marker and baseline
  are installed only by `scripts/database/local-test-marker.mjs` and
  `scripts/database/local-test-prepare.mjs` (`--dry-run`/`--check`/`--execute`).
- **2026-10-03 — OWNER decision: LOCAL_TEST prepare/resume backup boundary**
  (explicit OWNER policy decision; durable record
  `~/.local/share/mona-jacinta/handoff/owner-decision-local-test-destructive-policy-20261003T184509Z.md`).
  - Production-style LOCAL_TEST prepare/resume operations that delete or
    transform existing rows (`scripts/database/local-test-prepare.mjs`,
    including Block 1 seed #2 at `POST_BACKFILL`) require: a prior dry-run;
    a durable verified backup corresponding to the current checkpoint; and
    explicit OWNER authorization naming the target.
  - Destructive integration tests against the explicitly disposable
    LOCAL_TEST fixture (the permission above) are a separate testing
    exception.
  - That testing exception does **not** authorize the `local-test-prepare`
    destructive resume, migration tooling, production-style data
    preparation, any backup bypass, or any DEV/TEST/DEMO/PILOT operation.
  - This resolves the ambiguity between the LOCAL_TEST integration-test
    permission above and the prepare/resume backup rule.
  - **Supersedes:** any interpretation that the LOCAL_TEST destructive-test
    permission also exempts prepare/resume from the backup boundary.
  - **Does not supersede:** the existing permission for disposable
    LOCAL_TEST integration-test fixtures, provided they remain within their
    dedicated test harness and guards (`MONA_TEST_DATABASE_TARGET=local`,
    the marker proof, `api/tests/helpers/test-db.ts`).
  - DEV, TEST, DEMO and PILOT are not covered by this decision.
- **2026-10-11 — OWNER decisions D1–D7: D5H-I1c durable TEST backup design**
  (explicit OWNER approval of the D5H-I1c read-only preflight recommendations).
  These are **APPROVED DESIGN only**: nothing is implemented, and neither
  I1c-a nor I1c-b is authorized by this record — each needs its own owner
  authorization. Details, evidence and status: Living Blueprint §16
  "D5H-I1c owner design decisions".
  - **D1 — target and binding.** The D5H backup takes its hosted TEST target
    only from the canonical TEST configuration through the I1a parser
    (`scripts/database/hosted-test-config.mjs`), and must demonstrably bind it
    to the specific owner-authorized D5H operation and to the TEST subject the
    later suite expects. Mismatch, missing binding proof, malformed
    configuration, an ambiguous selector or any fallback fails closed. Never
    `DATABASE_URL`, `LOCAL_TEST_*`, the legacy DEMO selection or an ambient
    fallback. The I1b pinned target (`MONA_D5H_PINNED_TEST_TARGET`) is a
    process-local test-harness mechanism; no cross-process inheritance is
    assumed — I1c must establish and verify the binding explicitly.
  - **D2 — identity proof.** The dedicated D5H backup path must prove the
    expected TEST marker inside a verified read-only transaction, bound to the
    exact snapshot the dump consumes (a proof on one connection does not prove
    what a separate `pg_dump` process reached). Identity, transaction
    confirmation or snapshot binding that cannot be established fails closed.
  - **D3 — artifact format.** The existing `mona-test-backup/v1` set format is
    kept unchanged; the durable D5H copy must stay consumable by the existing
    restore verifier with no change to `scripts/database/restore.mjs`,
    demonstrated DB-free before any live restore drill.
  - **D4 — storage.** `OUTSIDE_WORKTREE_SAME_HOST`: an owner-controlled
    directory outside the current worktree, the main checkout, every sibling
    worktree or other checkout of this repository, and temporary/ephemeral
    storage; symlink escapes and unsafe paths are refused. Contract: directory
    `0700`, files `0600`, exclusive create (no overwrite), safe
    temporary-to-final publication, file and directory sync, destination
    re-verification, refusal on any incomplete, ambiguous or unverifiable
    state. A same-host recovery point, **not** off-machine disaster recovery.
    No path is fixed by this decision.
  - **D5 — evidence.** A separate digest-only D5H sidecar (minimum: `setId`,
    backup SHA-256, `targetDigest`, `markerDigest`); no URL, credential,
    password, connection string or other sensitive source material. Exact
    serialization, canonicalization and the I2 binding/verification rules are
    deferred to the implementation slice; I2 is not implemented.
  - **D6 — tooling integrity.** D5H execution never resolves `pg_dump` (or
    `pg_restore` where a later authorized workflow needs it) from an
    uncontrolled `PATH`: explicitly verified absolute binaries, version
    compatibility checks, fixed-code refusal when missing, substituted or
    incompatible. No binary path or PostgreSQL version is assumed here.
  - **D7 — slices.** I1c is split into **I1c-a** (DB-free: canonical config
    ingestion, binding contract at the DB-free boundary, destination-root
    policy, durable exclusive publication, backup-pair verification, a
    connection-free `--dry-run`) and **I1c-b** (verified TLS, read-only
    REPEATABLE READ transaction, marker proof, exported snapshot,
    snapshot-bound `pg_dump`, snapshot-consistent counts without the
    `count(*)::int` capacity defect, the D5 sidecar; DB-free fakes). Proposed
    files `scripts/database/d5h-backup.mjs` + `.test.mjs` are proposals, not
    permission. Each slice needs its own authorization, valid RED/GREEN,
    independent adversarial cases, Codex review and checkpoint approval.
  - **Unchanged:** `scripts/database/backup.mjs` (its pre-marker,
    attestation-only bootstrap TEST path and its legacy DEMO path),
    `scripts/database/restore.mjs`, `scripts/database/lib.mjs`, the
    `mona-test-backup/v1` manifest schema, DEV isolation (no D5H path reads
    `DATABASE_URL` or reaches DEV), and the frozen `docs/production-v1/*`.
    Nothing is superseded.
  - **Unverified, each needing its own explicit owner authorization:**
    snapshot import through the hosted Supabase session pooler, the installed
    `pg_dump`/`pg_restore` binaries and versions, server-version
    compatibility, any live backup, and any restore drill of a durable copy.
- **DEV** must never be reset, backfilled, or otherwise mutated without
  explicit human approval.
- **PILOT** tooling (marker, migrate, bootstrap, catalog bootstrap) is
  OWNER-only. It refuses a TEST marker and uses an explicit
  `--dry-run`/`--execute` split. Migrate, bootstrap and catalog bootstrap
  also require the PILOT marker proof and a plan digest (migrate: a pinned
  migration payload). Agents never execute it against a live database.
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

### Dated supersessions of frozen requirements

The frozen files themselves are never edited; a supersession is recorded
here, dated, with its exact scope. Anything not listed stays in force.

**2026-10-02 — Block 1: retail list price and sale-scoped wholesale**
(explicit owner business decision).

- **Superseded — retail price.** The cash-price model: the
  `01 = CONSUMER_FINAL` tier "`listPrice` → optional `cashDiscount` →
  `cashPrice`" (`01-product-scope.md`, Pricing / customer codes);
  FR-PRIC-002; the CONSUMER_FINAL part of FR-PRIC-005 (100% CASH/TRANSFER →
  `cashPrice`, any card/QR → `listPrice`, prices never frozen before the final
  payment composition, PENDING candidate snapshots
  `listPrice`/`cashPrice`/`wholesalePrice`/`cost`); `cashDiscount` within
  FR-PRIC-006 and `04-domain-rules.md`'s pricing-rule list; the
  `cashDiscount`/`cashDiscountType` fields and the `calculatePrice` cash
  branch (`05-architecture.md` pricing section, `06-erd-data-model.md`
  ProductVariant); `08-implementation-roadmap.md` PHASE 2C's
  `cashDiscount`/`cashPrice`, PHASE 6D's CONSUMER_FINAL composition pricing
  and its required tests, and the `cashPrice` expectations of PHASE 7E and of
  the adversarial list items 11–12.
  **Replacement:** an ordinary retail sale uses the LIST price
  (`ProductVariant.price`), chosen by the backend and snapshotted into
  `SaleItem.unitPrice` when the line is written; no cash-price mode exists.
- **Superseded — wholesale access.** Selecting wholesale through a customer
  code: FR-PRIC-001's `02 = WHOLESALE` customer-code selection, the
  `01`/`02` customer-code tiers (`01-product-scope.md`), `Sale.customerCode`
  (`05-architecture.md` Sale row, `06-erd-data-model.md` Sale), and
  `SaleItem.priceType` (`LIST`|`CASH`|`WHOLESALE`, `06-erd-data-model.md`).
  **Replacement:** the sale's own SELLER submits a wholesale authorization
  code for ONE DRAFT sale; the server verifies it against a configured bcrypt
  hash (`WHOLESALE_AUTH_CODE_HASH`; the code is never stored, logged, audited
  or returned) and sets `Sale.pricingMode = WHOLESALE`, repricing every line
  from `ProductVariant.wholesalePrice` (NULL = unavailable, fails closed;
  `0 < wholesalePrice <= price`). A CASHIER — a persisted CASHIER LOCATION
  assignment at the sale's location, never company ADMIN/OWNER authority
  alone, never the sale's own seller — must confirm before any payment;
  a WHOLESALE sale can never be PAID or COMPLETED without that confirmation
  (also a DB CHECK). `Sale.pricingMode` is the single price-mode fact for all
  of a sale's lines. FR-PRIC-003 (wholesale price = `wholesalePrice`) stays.
- **NOT superseded:** the frozen documents themselves; immutable historical
  sale-price snapshots; FR-PRIC-004 (backend-authoritative prices, client
  prices never authoritative); FR-PRIC-006's PRICE_MANAGE / scope rule for
  `listPrice` and `wholesalePrice`; global (not per-location) pricing; every
  data-integrity, audit (FR-AUDIT-001), authorization and location-scope
  requirement; the SEÑA domain except its cash-price expectations.
- **Raised, not resolved:** the frozen sources name the list price
  inconsistently (`listPrice`/`cost` in `05`/`06`, `price`/`costPrice` in
  `04` and the schema); this supersession does not rename anything.

**2026-10-06 — Pilot Pricing V2: CASH base + company price modes**
(explicit owner business decision; target pricing supersession for the Monday
pilot).

- **Supersedes the 2026-10-02 retail LIST-base target for new pricing.**
  `ProductVariant.price` remains the legacy LIST representation during
  migration, but the canonical retail base going forward is CASH. The
  migration rule is ADD → BACKFILL → VERIFY → SWITCH → DEPRECATE → REMOVE:
  do not destructively reinterpret existing real data in place.
- **Replacement model:** `ProductVariant.cashPrice` is the explicit retail
  CASH base. `ProductVariant.wholesalePrice` is the WHOLESALE CASH base.
  Wholesale activation still chooses the sale's wholesale base tier; the
  selected customer-facing price mode is then applied on top.
- **PILOT price modes:** CASH, LIST, CREDIT_CARD, DEBIT_CARD, BANK_TRANSFER
  and QR. CASH is 0%; LIST/CREDIT_CARD/DEBIT_CARD/BANK_TRANSFER/QR use
  company-global configurable non-negative integer basis-point adjustments
  (bounded to 0..10000 for the pilot), rounded half-up to integer centavos.
  QR is its own mode and is not mapped to card pricing.
- **PILOT sale lifecycle:** one price mode per sale. The total is fixed before
  payment collection; existing multiple `SalePayment` rows settle that fixed
  total and do not imply proportional mixed pricing. Payments that conflict
  with the selected mode fail closed except explicit LIST mode, which is a
  standalone configured customer-facing list price.
  OWNER ratification 2026-10-06: LIST is an independent configured customer
  price; a LIST sale may be settled with any supported payment method, the
  method never reprices it, and LIST is exempt from the 1:1 price-mode/payment-
  method mapping. This is not mixed proportional pricing; the total stays fixed.
- **Final product deferred requirement:** mixed payment methods with
  proportional price adjustment are REQUIRED later (for example, 50% CASH at
  0% plus 50% CREDIT_CARD at +20%), but are out of scope for this pilot slice.
  Current architecture must preserve a path for that future lifecycle,
  allocation, refunds/cancellations, reporting, audit and cashier UI work.
- **Implementation decisions (2026-10-06):** a new draft Sale defaults to
  `priceMode = CASH` (OWNER decision 2026-10-06: an unselected choice must not
  silently add the LIST adjustment; LIST stays a valid, explicitly selected
  mode). The server sets it in `createDraftSale` and the DB default is CASH;
  sales that existed before the migration were backfilled LIST because they
  were priced at list. The mode
  is selectable only while the Sale is DRAFT, by its own seller; after
  send-to-cashier or any payment it is immutable. Changing mode reprices all
  lines atomically from the current bases and company config and snapshots
  base, tier, mode, adjustment bps and config provenance on every `SaleItem`
  (`unitPrice` stays the authoritative money snapshot). Existing variants have
  `cashPrice = NULL` until an owner/admin backfills it; selling such a variant
  fails closed (`CASH_PRICE_MISSING`). `wholesalePrice` may never exceed
  `cashPrice` when both exist. Payment methods map CASH, TRANSFER, CARD_DEBIT,
  CARD_CREDIT and QR to CASH, BANK_TRANSFER, DEBIT_CARD, CREDIT_CARD and QR;
  a conflicting method is refused; LIST accepts any method. The migration was
  applied (2026-10-06) only to the disposable LOCAL_TEST database through the
  repository prepare/resume lifecycle and validated there; it is NOT applied to
  DEV, TEST, DEMO or PILOT. On 2026-10-06 the OWNER authorized pinning exactly the
  reviewed `20261006120000_pilot_pricing_v2/migration.sql` (3282 bytes) in the
  fixed `APPROVED_MIGRATION_PAYLOAD` of `scripts/database/pilot-migrate.mjs`
  (shared by `local-test-prepare`); the pin is a literal, never derived from
  disk, and does not authorize executing it against any database.
- **UI semantics (2026-10-06):** `cashPrice` is the only commercial base the
  UIs present and edit. LIST is DERIVED (`cashPrice` + the company LIST
  adjustment, half-up to the centavo) and the admin shows it read-only, only
  where the PRICE_MANAGE-gated pricing config is readable; no API field carries
  a derived LIST price today, so the seller client computes none. Legacy
  `ProductVariant.price` is shown only as "legacy/transitional" to price
  managers (and stays a required API input, defaulted to the CASH base when the
  admin leaves it empty); it is never a display or sellability fallback. A
  variant with `cashPrice = NULL` is shown as "no configurado" and cannot be
  added in the seller UI (the server rejects it with `CASH_PRICE_MISSING`).
  The server stays the only price authority.
- **NOT superseded:** frozen `docs/production-v1/*` files themselves;
  backend-authoritative pricing; immutable sale item money snapshots;
  PRICE_MANAGE / COMPANY-scope authorization; wholesale seller activation,
  cashier confirmation and raw-code confidentiality; global pricing only for
  the pilot; audit and location-scope requirements.

**2026-10-11 — OWNER decisions C1–C4: pilot target, pilot database, employee
current accounts, Block A / Block B organization** (explicit owner decisions;
documentation only — nothing is implemented, deployed or migrated by them).
Roadmap and status detail: Living Blueprint §1.5 and §23 rows 44–64.

- **C1 — the one-store pilot runs on Production V1.** CONFIRMS the existing
  pilot definition: the controlled one-store pilot runs the Production V1
  codebase with the Pilot V1.1 safety overlay (`docs/pilot-v1.1/*`, Blueprint
  §1.3) and the Pilot Pricing V2 rules above. Demo V2 stays the historical,
  completed and superseded predecessor (History below); it is **not**
  reinstated as a pilot or as a second active implementation track on
  `feat/demo-v2`. The pilot is a controlled validation scenario: it is not
  evidence that Production V1 is complete, not permission to deploy to a real
  store and not authorization to touch any database.
  **Supersedes:** only the recently PROPOSED (never approved) interpretation
  that Demo V2 would become the active one-store pilot. **Does not supersede:**
  the Demo V2 history, Pilot V1.1, Pilot Pricing V2, the Production V1
  authorization design or the frozen requirements.
- **C2 — the pilot database target is PILOT.** The pilot uses the existing
  Production V1 PILOT environment and only its repository-defined OWNER-only
  tooling and safety contracts (Database safety above). DEMO is **not** the
  pilot target; DEMO and PILOT are never interchangeable, and no pilot
  operation is ever routed through the legacy Demo V2 database selection. DEV
  isolation is unchanged. A PILOT configuration existing proves nothing about
  its readiness, schema, migration state or isolation. Every future PILOT
  operation still needs the applicable in-process identity proof, Production
  V1 schema/migration compatibility, the pilot safety gates, explicit owner
  authorization for that operation, a dry-run where required, and a backup
  plus human approval if existing rows would be deleted or transformed. No
  PILOT location, credential or readiness is asserted here.
- **C3 — employee current accounts (future product scope).** ADDS to the final
  product vision and future roadmap a distinct bounded capability: employee
  current accounts for clothing purchases, settled or deducted through salary
  under approved commercial, payroll and legal rules. It is **not** customer
  accounts receivable. Status: **OWNER-APPROVED FUTURE SCOPE — NOT IMPLEMENTED
  — ACCEPTANCE CRITERIA PENDING.** It does **not** rewrite the frozen
  requirements, does **not** change any frozen MUST/SHOULD priority, does
  **not** make the module part of a completed Production V1, and is **not**
  required in the one-store pilot. Its release milestone and contractual
  priority remain subject to owner approval. No deduction percentage, consent
  rule, payroll period, accounting entry or legal requirement is decided here.
- **C4 — Block A / Block B product organization.** The final integrated
  product is organized into **Block A — Operational / Commercial** and
  **Block B — Administration, Accounting and ARCA** (scope lists and the
  mapping to the frozen phase IDs and FR IDs: Blueprint §1.5). The blocks are
  a product-organization and delivery-planning view: they do **not** replace
  the frozen phase IDs (0A–10E) or MUST/SHOULD classifications, and they claim
  no implementation status beyond the Blueprint's verified evidence. Block B
  capabilities not in the frozen requirements are future scope.
- **Pricing stages (restated, unchanged).** The pilot keeps one price mode per
  sale (Pilot Pricing V2). The final product still requires mixed-payment
  proportional repricing (the "Final product deferred requirement" above); it
  is not implemented, and its precision, rounding, rate precedence, tender
  composition, refund and reversal-accounting rules need owner approval.
- **Not authorized by C1–C4:** any implementation, schema change, database
  operation (DEV/TEST/LOCAL_TEST/DEMO/PILOT/production), deployment, branch
  switch, OS change, or work on `feat/demo-v2`.

**2026-10-16 — R3-A4.3 proportional checkout: S1–S4 statically approved
(registration, not a supersession).** The proportional (mixed-payment) checkout
increment R3-A4.3 is implemented and undeployed: not released, not applied to
any database. Its exact status:

```
IMPLEMENTADO PARCIALMENTE — S1–S4 APROBADOS ESTÁTICAMENTE — NO DESPLEGADO — PostgreSQL PENDIENTE
```

- **Design approved.** Codex returned APPROVED as a **static design review**
  after the final normative corrections F6, T-X and P21b. That verdict does not
  validate the S1 implementation and does not validate PostgreSQL behaviour.
- **Approved slice sequence:** S1 → S2 → S3 → S4 → S5 → S6 → S-REF → S7 (T-S and
  T-RR) → S8 (guards) → S9 (gate and cut-over) → S10 (client and admin) → S11
  (R3-T). **S1–S4 are approved statically; S5–S11 (and S-REF) are pending.**
- **Two R3 migrations**, both additive: R3-A2
  `20261016120000_r3_proportional_checkout` (15340 bytes, sha256
  `217e87eb5b156a57a5edcfd73433e1e9558ce59caa019208d9df8c0268f08dc6`) and
  R3-A4.3 S1 `20261016130000_r3_checkout_attempts` (35290 bytes, sha256
  `076884120da38a05099ee00dbb16aafaa9e8c78f5846889fe7f590a8e95d9148`). The
  joined pin over the nine migration files of the reviewed tree is
  `1ca60b06b0f74e74713448900d2b3b5a6c6887a805f4f88695020b4198888137`. R3-A2 is
  never touched; no already-applied migration is rewritten.
- **G9 protected contract** (`api/scripts/local-test-fingerprint.ts`) now pins
  **298 columns / 32 relations / 17 enums / 9 protected functions / 3 jsonb**,
  `checked` = 290. Of the nine protected functions, **six are new** in the ninth
  migration (F1–F6), including `fn_external_collection_guard`; the three
  pre-existing are `fn_sale_payment_history`, `fn_sale_payment_truncate_guard`
  and `fn_sale_wholesale_frozen_after_payment`.
  `scripts/database/d5h-preflight.test.mjs` recognizes the two R3 migrations as
  reviewed-tree entries only; `D5H_MIGRATIONS` keeps its six pins, and
  `scripts/database/pilot-migrate.mjs` keeps `APPROVED_MIGRATION_PAYLOAD`
  at G7. No R3 migration is enabled for application by any D5H or pilot path.
- **Recorded documentary limits** (`docs/architecture/r3-a4.3-checkout-contract.md`
  §12): the approved contract package is outside the repository; the pasted
  source carries contradictory review-tail markers; this slice repins the
  G9-affected contract observers: the mirrored-constant drift guard
  (`api/tests/protected-capability-static.test.ts`), the baseline count pins
  (`api/tests/local-test-baseline.test.ts`, now 298; the six new relations
  classified `PRESERVED_FROM_BACKUP`) and the runtime count pins
  (`api/tests/protected-capability-runtime.test.ts`: `LOCKED_TABLES` now derives
  from `PROTECTED_RELATIONS.length`, with an explicit G9 pin of 32 relations,
  and its lock-count, SQL-order and snapshot assertions stay
  regression-sensitive). All of these DB-free suites pass. The operational G7
  witness (`scripts/database/local-test-witness.mjs`) stays at 26 relations and
  `BACKUP_SCHEMA_GENERATIONS` is not extended; G9 is not enabled in
  `pilot-migrate.mjs` or `local-test-prepare.mjs`. No global green gate is
  claimed beyond the suites actually executed, and no PostgreSQL evidence exists
  (P21–P55 NOT RUN).
- **The PILOT gate `PROPORTIONAL_EXTERNAL_METHODS_ENABLED` is NOT implemented**
  (it belongs to S-REF). The implemented fail-closed gate is
  `PROPORTIONAL_CHECKOUT_LOCATION_IDS`, read only in `createDraftSale`.
- **Authorizes nothing.** No database operation (DEV/TEST/LOCAL_TEST/DEMO/PILOT/
  production), no migration execution, no backup bypass, no commit, no
  deployment and no `feat/demo-v2` work. **Supersedes nothing:** the frozen
  `docs/production-v1/*` requirements, Pilot Pricing V2, the authorization
  model and the Database safety rules all stay in force.

**Living Blueprint**: `docs/blueprint/MONA-JACINTA-SYSTEM-BLUEPRINT.md` is
the persistent implementation/status/failure/lessons ledger. Read it before
substantial work; update it after implementation, review, checkpoint, and
major decision blocks. It does **not** override frozen `docs/production-v1/*`
requirements, and repository/git reality outranks stale Blueprint state.

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

**Current integrated baseline:**
`829b8d39ed4bcf43a6c479df4f4bf0414085364d` on `feat/production-v1`
("feat(r3): implement checkout close and external refund flow"). It is
pushed to `origin/feat/production-v1`. The temporary
`feat/production-v1-pricing-wholesale-t4` branch (at `9a3243f`) has already
been fast-forward integrated into Production V1.

This baseline includes P0.2, TEST/PILOT safety tooling A1→D, Task 4
LOCAL_TEST tooling, Block 1 sale-scoped wholesale, R4 LOCAL_TEST safety proof
tooling, authorization read-scope hardening, and Pilot Pricing V2.

- **Pricing V2 status:** committed and pushed on Production V1. It adds the
  CASH retail base, WHOLESALE cash base, company-global price modes, sale
  price-mode lifecycle, server-side pricing authority, minimal admin/client UI,
  and PILOT/LOCAL_TEST tooling compatibility. The frozen `docs/production-v1/*`
  files remain historical; the dated supersessions above are the current rule.
- **LOCAL_TEST validation:** Pricing V2 was validated on the disposable
  LOCAL_TEST database with a focused real-DB suite: **439/439 PASS**, return to
  `EXACT_BASELINE`. The Pricing V2 migration was applied there only; it has not
  been applied to DEV, TEST, DEMO or PILOT.
- **Frontend validation:** admin lint plus `tsc -b && vite build` passed;
  client lint, Vitest **5 files / 44 tests**, and `next build` passed. No
  browser/E2E validation is claimed.
- **Not yet done:** PILOT has not received Production V1, the live PILOT
  database has not been migrated, real customer data has not been imported, and
  AC-211 restore proof remains **NOT RUN / deferred**. Mixed proportional
  payment pricing remains a required later feature, not implemented.
- **Preservation:** the old dirty worktree was preserved to durable external
  storage under `~/.local/share/mona-jacinta/preservation/old-worktree-20261007`;
  that artifact is not the source of truth.

Full evidence and ledgers are in
`docs/blueprint/MONA-JACINTA-SYSTEM-BLUEPRINT.md` (§2, §3, §16, §22, §25).

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
