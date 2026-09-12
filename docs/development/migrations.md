# Database Migration Safety Conventions

Status: Approved (Phase 0B)
Scope: **Development process** — how schema migrations are planned, written, reviewed, and
executed. This document defines discipline and technique. It does not introduce, approve,
or perform any schema change, and it does not restate or reinterpret Production V1 business
requirements.
Related: `docs/development/database.md` (environment/connection safety),
`docs/production-v1/05-architecture.md` §24/§26/§30 (approved migration decisions),
`docs/production-v1/06-erd-data-model.md` §5 (Check Constraints Summary),
`docs/production-v1/07-inventory-ledger.md` §19 (Inventory migration sketch),
`docs/production-v1/08-implementation-roadmap.md` (Phase 0B/1A/1C/2B/3A/6A/6C migration steps).

Source-of-truth hierarchy for any conflict: **Production V1 docs → approved Demo V2
architecture → existing code.** This document sits below all three: it explains *how* to
carry out decisions those documents already made. If anything here appears to conflict with
a frozen Production V1 document, the Production V1 document wins and this file must be
corrected, not the other way around.

Backup, restore, and rollback *implementation* (pg_dump/restore tooling, point-in-time
recovery, restore drills) is explicitly **out of scope** — that is Phase 0C. This document
only states the roll-forward/rollback *discipline boundary* (§23) so Phase 0C has a
contract to implement against.

---

## 1. Purpose and Scope

Production V1 requires many multi-step schema evolutions (Branch → Location,
`UserBranchRole` → `UserRoleScope`, `Inventory` → `InventoryBalance`, barcode relocation,
`StockReservation` → `StockHold`, `CashSession`/`CashRegister` restructuring — see
`08-implementation-roadmap.md` §"MIGRATION STRATEGY"). Every one of these changes existing
tables with production-shaped data already in them.

This document exists to make sure that when those phases begin, no one — human or agent —
has to invent migration discipline under time pressure. It defines:

- how schema changes are proposed, generated, and reviewed (Prisma discipline, §4)
- the compatibility lifecycle every non-trivial change must follow (§5)
- how to express, in raw SQL, PostgreSQL capabilities not represented in this project's
  currently enabled Prisma schema syntax (§12–15)
- how evolutions of renames, enums, and foreign keys are done safely (§16–18)
- what "done" and "safe to remove the old thing" mean, concretely (§9–11, §24)

This document does **not**:
- change `api/prisma/schema.prisma`
- create or edit any Prisma migration
- perform any backfill
- decide *whether* Branch becomes Location, or *how* barcodes move — those decisions are
  already made in the frozen Production V1 docs; this file only says how to execute them
  safely once that phase starts.

---

## 2. Non-negotiable migration principles

1. **No destructive one-shot migrations.** Introducing a new representation and removing
   the old one in the same migration is forbidden, even for "obviously safe" changes.
   Every destructive step (`DROP COLUMN`, `DROP TABLE`, `NOT NULL` enforcement on an
   existing column, narrowing a type) is its own migration, gated by the lifecycle in §5.
2. **Additive by default.** The default shape of any change is: add something new next to
   the old thing, not instead of it.
3. **Every migration targets a known, verified database.** See §3. A migration that cannot
   prove its target is correct must not run.
4. **Prisma migration history is the only source of schema truth.** No hand-run SQL against
   a shared database that isn't captured in `api/prisma/migrations/`. See §4 and §12.
5. **Every backfill is verified before anything switches to depend on it.** See §7–9.
6. **Roll-forward is preferred over rollback** once data has changed shape (see §23) —
   design changes so that fixing forward is nearly always possible.
7. **Nothing here silently reinterprets a Production V1 decision.** If a document listed
   above says the model is `Location`, this file never suggests a different name.

---

## 3. Environment rules

- **DEV / TEST / (future) production are physically separate targets.** Today that means
  the two Supabase projects described in `docs/development/database.md` (`DATABASE_URL` /
  `mona-jacinta-demo` for dev/demo, `TEST_DATABASE_URL` / `mona-jacinta-test` for
  Vitest/Supertest). A future production project is a third, equally distinct target, never
  a repurposed dev or test project.
- **Credentials are never exposed.** Real connection strings live only in the untracked
  `.env.development` (or the future untracked production-equivalent env file). They are
  never printed, logged, committed, or embedded in migration SQL, seed data, or this
  document. `npm run db:check` (`scripts/check-databases.mjs`) already enforces
  redacted-only output — follow the same discipline for any new migration tooling.
- **Fail closed on target ambiguity.** If a migration command cannot prove which database it
  is about to touch, it must refuse to run rather than guess. This repository already
  applies this principle at the connection layer: `scripts/check-databases.mjs` and
  `api/prisma.config.ts` both throw rather than proceed on an unparseable or
  TLS-override-tampered `DATABASE_URL`. Migration tooling must hold itself to the same bar:
  no "looks probably right, continuing anyway."
- **Migration commands must target the intended database explicitly.** Never rely on
  shell-ambient state (a previously-exported variable, a default `.env` Prisma might pick up
  implicitly) to decide the target. `api/prisma.config.ts` is the single place that resolves
  `DATABASE_URL` for the Prisma CLI; do not introduce a second, competing resolution path.
  Running any `prisma migrate *` command against TEST or a future production target must be
  a deliberate, explicit choice (explicit env selection), never an accident of shell state.
- **No network calls from inside a migration or its verification step** beyond the database
  connection itself (see §20). Migrations must be deterministic and reproducible offline.

---

## 4. Prisma migration discipline

- **`schema.prisma` is the declarative model source.** It expresses the target shape of the
  database. It is not itself the migration mechanism.
- **The Prisma migration history (`api/prisma/migrations/`) is authoritative.** The
  sequence of migration folders, in order, is the only true record of how the schema
  reached its current state. `migrate status` must agree with it before any new migration is
  written.
- **Generated migration SQL must be reviewed before it is ever applied anywhere shared.**
  `prisma migrate dev` generates `migration.sql` — read it. Confirm it contains exactly the
  intended DDL, no unexpected `DROP`, no accidental data loss, and that any manually-added
  raw SQL (§12) is present and correct.
- **`prisma db push` must never be used as a Production V1 migration mechanism.** `db push`
  has no migration history entry, is not reviewable as a diff, and cannot be part of a
  reproducible ADD→BACKFILL→...→REMOVE sequence. It exists in `api/package.json` today
  (`db:push`) purely as a fast local-prototyping convenience against the DEV database before
  a shape is finalized — it must never be run against TEST, and never against a future
  production target, and it must never be the vehicle that actually ships a schema change.
- **`prisma migrate dev` is for an approved development context only** — i.e. the developer's
  own DEV database, to author and name a new migration, or to apply already-committed
  migrations locally. It creates/uses Prisma's shadow database, so the connected role must
  be able to create a temporary database in that environment (see `docs/development/database.md`
  §5).
- **`prisma migrate deploy` is for controlled deployment contexts** (TEST bootstrap in CI, and
  the future production deploy path). It applies pending migrations from history without
  generating new ones and without a shadow database, **and it does not perform drift
  detection** (drift detection is a `migrate dev` / shadow-database behavior only) — it only
  checks that already-applied migrations' checksums are unchanged and applies whatever is
  pending. This is the only command that should ever touch TEST or a future production
  target for schema changes.
- **`prisma migrate reset` must never target production**, and should be treated as
  destructive by default everywhere: it drops and recreates the target database and reapplies
  history + seed. Safe only against DEV or against a disposable/ephemeral TEST instance,
  and only ever run against a target that has just been verified (§3) to be the intended one.
- **`prisma migrate status` / validation expectations:** before authoring a new migration,
  `migrate status` must report the target as up to date with existing history (no drift, no
  pending migrations). Before any deploy, the same check must show a clean, applied history
  plus the new migration(s) pending — never "schema drift detected."

---

## 5. Canonical compatibility lifecycle

Every schema evolution that touches existing data or an existing consumer follows exactly
this sequence (already named in `08-implementation-roadmap.md`):

```
ADD → BACKFILL → VERIFY → SWITCH → DEPRECATE → REMOVE
```

| Stage | Meaning | Exit condition |
|---|---|---|
| **ADD** | Introduce the new column/table/index/constraint additively, alongside the existing representation. Nothing yet reads or writes it. | New schema object exists in a reviewed migration, applied and visible in `migrate status`; no application code depends on it yet. |
| **BACKFILL** | Populate the new representation from the old one, for all existing rows. | Backfill has run to completion (or, for large tables, in tracked batches — see §7) against a verified target; the process is idempotent/resumable and its outcome is logged. |
| **VERIFY** | Prove the new representation is a faithful, complete substitute for the old one — before anything depends on it. | Explicit verification queries (§8) pass: no unexpected nulls, no orphaned references, no count mismatches, no duplicate violations of the new constraints. |
| **SWITCH** | Application code begins reading and writing the new representation as the source of truth. The old representation may still be written for compatibility (dual-write) if a rollback window requires it. | Application code path fully switched; both representations still present, old one now derived/redundant rather than authoritative. |
| **DEPRECATE** | Old representation becomes read-only or unused. It is not deleted yet. | No code path writes to the old representation; monitoring/tests confirm nothing depends on it; a compatibility window has been observed with no incident. |
| **REMOVE** | The old representation is dropped, in its own reviewed, separately-committed migration. | Explicit proof (grep/tests/telemetry) that nothing references the old column/table/enum value; compatibility window elapsed; destructive SQL reviewed on its own, never bundled with the ADD step. |

**REMOVE is allowed only after a validated compatibility window** — never immediately after
SWITCH, and never in the same migration that performed ADD.

---

## 6. ADD conventions

- Additive-first: every new column starts nullable, or with a default that requires no
  backfill coordination, unless the table is empty/new (a genuinely new entity — e.g. any
  table marked "NEW (No Migration Needed)" in `07-inventory-ledger.md` §19.3 may have
  required-from-birth columns, since there are no existing rows to reconcile).
- New indexes and constraints are introduced in a way that does not block writes for longer
  than necessary — see §20 for locking-aware sequencing (e.g. `CREATE INDEX CONCURRENTLY`
  outside a transaction where the migration tool allows it, or accepting a brief lock window
  explicitly and consciously for small tables).
- Never rename or remove anything in the same migration that adds the replacement. Renames
  are their own lifecycle (§16); a "rename" in Prisma's migration diff (which Prisma may
  propose as a single `ALTER ... RENAME`) must be manually decomposed into add-new /
  backfill / switch / drop-old steps for any table with production data, even though Prisma
  itself does not enforce this.

---

## 7. BACKFILL conventions

- **Deterministic**: given the same source rows, a backfill produces the same result every
  time it is run. No reliance on wall-clock time, random values, or external services for
  the values it writes (timestamps recorded *during* backfill, e.g. an audit `migratedAt`,
  are fine — the *mapping logic* itself must be deterministic).
- **Resumable / idempotent where practical**: a backfill that is interrupted (deploy
  restart, connection drop) can be re-run safely — typically by scoping each write with a
  condition like "only rows where the new column is still null" so a partial run plus a
  re-run converges to the same end state rather than double-applying.
- **Bounded/batched when required**: large tables are backfilled in chunks (e.g. by primary
  key range or a `LIMIT`/`OFFSET`-free keyset loop), not a single unbounded `UPDATE`, to
  avoid long-held locks and huge transactions (see §20). What counts as "large" is a
  judgment call at the time of each phase — the ledger/audit-heavy tables
  (`StockMovement`, `AuditLog`, `Sale`) are the ones most likely to need batching.
- **No business-state corruption**: a backfill must never guess or silently invent business
  facts. Where the source data is ambiguous (e.g. "a product's variants have different
  legacy barcodes" per `05-architecture.md` §26 "Barcode Migration"), the resolution policy
  is an explicit decision made and recorded when that phase is implemented — never a default
  picked quietly by the backfill script.
- **Traceable execution**: every backfill run's scope (which rows, how many, when) is logged
  somewhere durable enough to answer "did this actually run, and against what target" after
  the fact — at minimum, application logs; for larger backfills, a row count/summary
  captured in the commit or PR that performed it.

---

## 8. VERIFY conventions

Before SWITCH, a migration's backfill must be checked against explicit, written queries —
not "it looked right in Studio." At minimum:

- **Counts**: row count of the new representation matches the expected count derived from
  the old one (e.g. one `InventoryBalance` per prior `Inventory` row).
- **Invariants**: any check constraint about to be enforced (§13) is first confirmed to hold
  against *existing* data, before the constraint is added `NOT VALID` → validated, or before
  it is added at all if the table is small enough to validate inline.
- **Null / orphan / duplicate checks**: no unexpected nulls in newly-required-but-not-yet-enforced
  columns; no foreign keys pointing at rows that don't exist; no duplicate rows that would
  violate a unique index about to be introduced (partial or otherwise, §14).
- **Application compatibility checks**: the application still passes its existing test suite
  against the post-backfill, pre-switch schema (old code path, new data both present).
- **Migration status**: `prisma migrate status` (and, for TEST, the `migrate deploy` dry
  run/CI check) shows the target at the expected migration, with no drift.

A migration that cannot produce these answers does not proceed to SWITCH — see §22
(Failure policy).

---

## 9. SWITCH conventions

- Application code begins using the new representation **only after VERIFY has passed**,
  never before, and never speculatively "because it should be fine."
- Where a rollback safety margin is required, a **compatibility path is retained**: the
  application may dual-write both representations for a period, or the old representation
  may remain readable as a fallback, rather than an instantaneous single-commit cutover.
- **No simultaneous, uncontrolled source-of-truth ambiguity.** At any point in time it must
  be unambiguous, in code, which representation authoritative reads and writes use. "Read
  from new, but sometimes fall back to old" is acceptable only when the fallback condition
  is explicit and intentional (e.g. during a defined dual-write window), never an accident of
  partially-migrated code paths.

---

## 10. DEPRECATE conventions

- The old representation becomes **read-only or fully unused** by application code — it is
  not written to and, ideally, not read either, but it still exists in the schema.
- A **compatibility window** is observed: a period (defined per-phase when that phase is
  implemented, not pre-decided here) during which the old representation could still be
  restored to authoritative use if SWITCH revealed a problem.
- **Telemetry/logging/testing** during this window should be able to answer, on demand,
  "has anything touched the old representation since SWITCH?" — e.g. a log line or a metric
  on any code path that still references it, or a test asserting no writes occur.

---

## 11. REMOVE conventions

- REMOVE happens **only after** the compatibility window (§10) has been observed with no
  incident.
- **Explicit proof nothing depends on the old representation** is required before the
  migration is written: a repo-wide search confirming no code references the old
  column/table/enum value, plus (where feasible) a production/telemetry check that no reads
  have occurred during the deprecation window.
- **Destructive SQL is reviewed separately** from any other change — a REMOVE migration
  should contain only the removal (`DROP COLUMN`, `DROP TABLE`, tightening a constraint),
  nothing else, so the diff under review is unambiguous about what is being deleted.
- **Never combine first introduction (ADD) and destructive removal (REMOVE) in one big-bang
  migration.** If a "migration" step in a future phase's plan looks like it does both (e.g.
  the illustrative SQL sketch in `07-inventory-ledger.md` §19.2, which shows
  `RENAME COLUMN` and `DROP COLUMN` back-to-back for illustration), that sketch must be
  decomposed into separate ADD / BACKFILL / VERIFY / SWITCH / DEPRECATE / REMOVE migrations
  when the phase is actually implemented — the sketch documents the *end-to-end field
  mapping*, not the safe execution order.

---

## 12. Raw PostgreSQL inside Prisma migrations

Prisma's schema language has no declarative syntax at all for a `CHECK` constraint
(`05-architecture.md` §"PostgreSQL enforcement (not Prisma)": *"Prisma has no `@@check`"* —
this is a hard, version-independent limitation of the Prisma schema language itself, not a
capability that changes with configuration). Partial unique indexes are a narrower case:
`05-architecture.md` §24 records the project's current decision as *"Partial indexes | Raw
SQL in migrations (Prisma limitation)"*, and the existing initial migration already
establishes the pattern this repo follows on that basis — Prisma generates the declarative
DDL, and a hand-written raw-SQL block is appended for what isn't represented in this
project's Prisma schema today (`api/prisma/migrations/20260907015311_init/migration.sql`
lines 507–510, the `cash_session_one_open_per_register` partial unique index, with a
one-line comment explaining why it's raw SQL). See the "Partial UNIQUE indexes" subsection
below for the precise, non-timeless framing of that rule.

**General rule: raw SQL always lives inside the versioned Prisma migration history**
(`api/prisma/migrations/<timestamp>_<name>/migration.sql`), never as an ad hoc `.sql` file
run out-of-band against a shared database. This keeps `migrate status`/`migrate deploy`
authoritative — an out-of-band `psql` script that isn't in migration history is invisible to
Prisma and will not be reproduced on a fresh environment or in disaster recovery.

For each of the categories below:

### CHECK constraints
- **When required**: any invariant Prisma cannot express declaratively — e.g.
  `chk_onhand_nonneg CHECK (on_hand >= 0)` (`06-erd-data-model.md` §5), or the
  `UserRoleScope` scope/location consistency rule (`05-architecture.md` §"PostgreSQL
  enforcement").
- **Where it belongs**: appended to the same `migration.sql` that creates/alters the table
  it constrains, as its own clearly-commented `ALTER TABLE ... ADD CONSTRAINT ... CHECK
  (...)` block — not a separate untracked script.
- **How it is reviewed**: as part of normal migration-SQL review (§4) — confirm the
  predicate matches the invariant described in the relevant Production V1 doc section
  exactly, and that it's attached to the correct table/columns.
- **How existing rows are verified first**: before the constraint is added (or before it is
  validated — see §13), run the equivalent `SELECT count(*) ... WHERE NOT (<predicate>)`
  against the target and confirm zero violating rows.
- **How failure behaves**: if PostgreSQL rejects the constraint (existing violating rows) or
  the pre-check finds violations, the migration must not proceed — fail closed (§22), fix the
  underlying data or defer the constraint, never weaken the predicate to make data pass.
- **What actually keeps this out of Prisma's drift detection**: `prisma migrate dev`'s drift
  check compares the live database against a shadow database built by *replaying migration
  history* — not against `schema.prisma` directly. Because the raw-SQL block lives inside
  the versioned `migration.sql`, replaying history reproduces it exactly, so no drift is
  reported and no one is tempted to run `prisma migrate dev` in a way that would generate a
  *second*, competing migration attempting to "fix" a constraint Prisma never had reason to
  see as missing. A comment near the relevant model in `schema.prisma` (as already present
  for `cash_session_one_open_per_register`) is worth keeping too, but it is purely
  human-facing documentation — Prisma's tooling does not read schema comments as
  instructions, and the comment neither causes nor prevents drift by itself. The protection
  is the raw SQL being committed inside migration history; the comment is just so a human
  reading `schema.prisma` isn't surprised by a constraint the model declaration doesn't show.

### Partial UNIQUE indexes

**Do not treat "Prisma cannot express partial unique indexes" as a timeless, universal
claim.** Prisma's schema capabilities evolve across versions and preview features, and
whether a given Prisma release/configuration can express a partial index natively is a
version-and-configuration question, not a constant. The rule that actually governs this
project is narrower and does not depend on a permanent claim about Prisma's ceiling:

- The existing repository already has a raw-SQL partial unique index **precedent**
  (`cash_session_one_open_per_register`, one OPEN `CashSession` per register).
- Production V1 migration policy requires **explicit, reviewable PostgreSQL SQL** for
  database invariants that are not represented by **this project's currently enabled Prisma
  schema capabilities** (today: the plain `@@unique`/`@@index` syntax in
  `api/prisma/schema.prisma`, no partial-index preview feature enabled).
- Partial unique indexes may therefore be implemented in versioned `migration.sql` when
  required by an approved Production V1 invariant (e.g. the same *technique* is named for
  `uq_document_counter_type_location` and `uq_product_image_primary` in
  `06-erd-data-model.md` §5, once those tables exist).
- **Before implementation**, whoever writes that migration verifies the exact Prisma 7.10.x
  capability/configuration actually available in this repository at that time, rather than
  relying on a blanket "Prisma cannot do this" assumption — Prisma may have gained a native
  way to express it by then, in which case that native syntax should be evaluated (and, if
  adopted, is its own reviewed decision — not something this document authorizes).

This document does **not** enable a Prisma preview feature and does not change
`schema.prisma` or the existing migration — it only states how a partial unique index is
implemented *if and when* raw SQL turns out to still be the right vehicle.

- **Where it belongs**: same `migration.sql` as the table, as a raw
  `CREATE UNIQUE INDEX <explicit_name> ON <table>(<columns>) WHERE <condition>;` statement.
- **How it is reviewed**: confirm the `WHERE` predicate matches the intended "conditional"
  case exactly (e.g. `WHERE status = 'OPEN'`, not an inverted or overly broad condition),
  and that the index name is explicit and descriptive (never let a tool auto-generate an
  opaque name for a hand-written constraint).
- **How existing rows are verified first**: a `GROUP BY` over the would-be unique columns
  filtered by the same `WHERE` predicate, checking for any group with `count(*) > 1`, before
  the index is created.
- **How failure behaves**: `CREATE UNIQUE INDEX` fails outright on a violating data set —
  treat that failure as a signal to fix the data (or the migration's ordering relative to a
  backfill/cleanup step), never to loosen the predicate.
- **What actually keeps this out of Prisma's drift detection**: the same mechanism as CHECK
  constraints above — the raw SQL is committed inside the versioned `migration.sql`, so
  replaying migration history reproduces it and `migrate dev`/`migrate status` see no drift.
  A comment next to the relevant Prisma model documenting the index's existence is
  worthwhile for humans reading `schema.prisma` (since today's enabled schema syntax has no
  `WHERE` clause to show it there), but the comment itself is documentation, not a mechanism
  that prevents or causes drift.

### NULLS NOT DISTINCT
- **PostgreSQL version dependency**: available from **PostgreSQL 15+** (`UNIQUE NULLS NOT
  DISTINCT`). This repository's minimum supported PostgreSQL version is **16**
  (`scripts/check-databases.mjs` `MIN_PG_MAJOR = 16`, matching `docs/development/database.md`
  §5's "both report PostgreSQL 16+"), so the feature is available wherever this repo runs.
- **Why Prisma schema syntax may require `migration.sql` augmentation**: Prisma's
  `@@unique` always treats NULLs as distinct (standard SQL behavior) — it has no schema
  syntax for `NULLS NOT DISTINCT`. Where a Production V1 invariant needs "at most one row
  per scope, treating NULL as a real, comparable value" (e.g. `UserRoleScope`'s COMPANY-scope
  rows, where `locationId` is NULL for every COMPANY-scoped row, per
  `05-architecture.md`'s "NULL-handling for company-scope rows uses PostgreSQL 15+ `NULLS
  NOT DISTINCT` or an equivalent partial unique index strategy") — the constraint must be
  hand-written as raw SQL (either a `UNIQUE (...) NULLS NOT DISTINCT` constraint, or,
  per that same doc, an equivalent partial-unique-index formulation) and appended to
  `migration.sql`, with the `@@unique` in `schema.prisma` left as documentation of the
  non-NULL-differentiating part, plus a comment pointing at the raw SQL.
- **Validation before activation**: identical discipline to CHECK/partial-unique above —
  check for existing duplicate NULL-inclusive groups before creating the constraint, and
  treat a creation failure as a data problem to resolve, not a predicate to weaken.

Do **not** create any of the three constructs above in Phase 0B — this section documents the
technique so a future phase can apply it without re-deriving it.

---

## 13. PostgreSQL CHECK convention (existing-data safety)

Before a `CHECK` constraint is enforced against a table that already has rows:

1. Run the read-only equivalent of the constraint's predicate as a `SELECT count(*)` to
   confirm zero existing violations (§8, §12).
2. Prefer, for larger tables, PostgreSQL's two-phase validation: add the constraint with
   `NOT VALID` (which only enforces it against *future* writes and does not scan/lock the
   whole table), then validate existing rows separately with `ALTER TABLE ... VALIDATE
   CONSTRAINT ...` (a lighter lock than the initial `ADD CONSTRAINT` without `NOT VALID`).
   This is a standard PostgreSQL mechanism for adding constraints to populated tables
   without a long-held exclusive lock — mention it here as the available technique; whether
   a given future constraint actually needs the two-phase form is a call made when that
   migration is written, based on that table's size at the time.
3. Never add a `CHECK` constraint that is expected to fail against current data "as a way to
   find bad rows" — verification (step 1) comes first; the constraint is added only once the
   data already satisfies it.

---

## 14. Partial unique index convention

The general technique — conditional uniqueness such as "one active/open entity for a
scope" — is documented in §12 above with the shipped `cash_session_one_open_per_register`
example. This section exists only to state the boundary: **this document does not introduce
a new business invariant.** Any future partial unique index (e.g. the
`uq_document_counter_type_location` / `uq_product_image_primary` names that already appear
in `06-erd-data-model.md` §5) is created only when that table's phase is implemented, using
the technique above, against whatever exact predicate that frozen document specifies — not a
predicate invented at migration-authoring time.

---

## 15. NULLS NOT DISTINCT convention

See §12 for the full technique, version dependency, and validation approach. As with §14: no
`NULLS NOT DISTINCT` index is created in Phase 0B. When `UserRoleScope` (or any future model
with the same NULL-as-real-value uniqueness need) is implemented, its migration author reads
this document plus the relevant Production V1 doc section to write the exact constraint the
requirements describe — this document defines only the reusable *technique*.

---

## 16. Rename / model-evolution convention (expand-and-contract)

Several Production V1 changes are true renames-with-reshaping rather than pure additions —
most notably **Branch → Location** (`05-architecture.md` §26/§30,
`08-implementation-roadmap.md` Phase 1A/1C) and **`ProductVariant.barcode` →
`Product.barcode`** (§26 "Barcode Migration"). These follow the standard **expand and
contract** pattern, which is just the lifecycle in §5 applied to a rename specifically:

1. **Expand**: add the new table/column alongside the old one. Do not touch the old one yet.
   (e.g. create `Location`, leave `Branch` fully intact and still authoritative.)
2. **Dual-write / backfill**: backfill the new structure from the old one (§7). If the
   change spans a deploy boundary where old code might still write only to the old
   structure, the application may need to dual-write both during the transition — decided
   per-phase, not assumed here.
3. **Verify**: prove equivalence (§8) — every old row has a corresponding new row, referential
   integrity holds against the new table, counts match.
4. **Switch reads, then writes**: application reads switch to the new structure first
   (cheaper to reverse), then writes switch once reads have proven stable.
5. **Deprecate** the old table/column: stop writing to it, confirm nothing reads it.
6. **Remove** the old table/column in its own migration, only after the compatibility window.

**No Branch → Location migration is executed in Phase 0B** — this section documents the
pattern so Phase 1A/1C can follow it directly instead of improvising a rename strategy under
schedule pressure. The same six steps apply to any other identified rename-with-reshaping
(e.g. `StockReservation` → `StockHold`, `Inventory` → `InventoryBalance`).

---

## 17. Enum evolution convention

- **Additive evolution**: adding a new enum value is safe and non-blocking —
  `ALTER TYPE <enum> ADD VALUE '<new>'` — but in PostgreSQL this cannot run inside the same
  transaction as other DDL that *uses* the new value, and (on older PostgreSQL) cannot be
  used in the same transaction it was added in at all. Keep "add enum value" migrations
  small and, where the target Postgres version requires it, isolated from other DDL in the
  same migration. `StockMovementType` growing from `SALE`-only to 13+ values
  (`07-inventory-ledger.md` §19.1) is exactly this case — additive, one migration per
  logical batch of new values, reviewed like any other DDL.
- **Safe removal of an enum value**: PostgreSQL cannot directly drop a single enum value.
  Removing one requires: (1) confirm no row uses it (VERIFY-style check), (2) if truly
  unused, either leave it (harmless) or recreate the type without it — create a new enum
  type, migrate the column to it (`ALTER COLUMN ... TYPE <new_enum> USING ...`), drop the
  old type. This is inherently a multi-step, reviewed operation — never attempted as a
  single blind `ALTER TYPE ... DROP VALUE` (PostgreSQL doesn't even offer that verb).
- **Safe rename of an enum value**: `ALTER TYPE <enum> RENAME VALUE '<old>' TO '<new>'` is
  supported directly, but still changes what every existing row "means" instantaneously —
  treat it as a SWITCH-equivalent step: confirm (VERIFY) that the application's handling of
  the old label and new label are compatible during rollout, not just at the DB level.
- Enum changes are always reviewed for whether application code (`switch`/`match` exhaustiveness
  checks, validation schemas such as the `zod` enums used in `api/`) has been or will be
  updated in the same logical change set — an enum growing in the DB without the
  application knowing about the new values is a silent gap, not a safe migration.

---

## 18. Foreign-key evolution convention

Adding a foreign key to an existing, populated table follows its own ADD→BACKFILL→VERIFY→
SWITCH sequence:

1. **Add nullable FK first** where the referencing table already has rows: add the column
   as nullable, with no `NOT NULL` and (initially) no enforced FK constraint, or an FK
   constraint added `NOT VALID` (see §13's two-phase technique — the same mechanism applies
   to foreign keys via `ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY ... NOT VALID`, then
   `VALIDATE CONSTRAINT`).
2. **Backfill** the column for all existing rows (§7).
3. **Verify referential integrity**: an explicit query confirming every non-null value in
   the new FK column has a matching row in the referenced table, before validating/enforcing
   the constraint.
4. **Switch**: application code begins populating the FK column on new writes.
5. **Enforce non-null only after proof**: `ALTER COLUMN ... SET NOT NULL` is applied only
   after VERIFY shows zero remaining nulls that should have been populated — and, like any
   `SET NOT NULL` on a populated table, this takes a table scan/lock; consider the two-phase
   pattern here too (PostgreSQL can use an already-`VALID`ated `CHECK (col IS NOT NULL)`
   constraint to make a subsequent `SET NOT NULL` skip its own re-scan).

This is the same shape every "MIGRATE" row in `08-implementation-roadmap.md`'s migration
dependency graph already implies (e.g. `UserRoleScope` referencing `Location`).

---

## 19. Monetary / type migration convention

Production V1 uses **BigInt minor units** for all monetary amounts and stock quantities
(already the case in the current schema: `ProductVariant.price`/`costPrice`, `Sale.total`,
`Inventory.physical`/`reserved`, etc. are all `BigInt`; see `05-architecture.md` §"money/"
and `07-inventory-ledger.md`'s `BigInt` fields throughout). This section documents the
*principles* for any future type migration touching these columns — not a migration to
perform now:

- **Never silently narrow a numeric type.** Any change from `BigInt`/`bigint` to a smaller
  type (or vice versa in a way that could lose precision) is treated as a MIGRATE, not an
  ALTER: add the new-typed column, backfill with explicit, reviewed conversion logic,
  verify no value lost precision or overflowed, switch, deprecate, remove — the full
  lifecycle in §5, never an in-place `ALTER COLUMN ... TYPE` on a column already holding
  production financial or inventory data.
- **Conversions are explicit and reviewed, never implicit casts.** Where a conversion
  requires interpretation (e.g. re-scaling a value, changing units), the mapping function is
  written down, reviewed, and covered by the same determinism/idempotency rules as any other
  backfill (§7) — never left to an ORM's default numeric coercion.
- **`toJsonSafe` (BigInt → string) is a serialization concern, not a migration concern** —
  it does not change stored data and is out of scope here; it is mentioned only so a future
  reader does not confuse "how BigInt is serialized to JSON" with "how a BigInt column is
  migrated."
- **Verification for a monetary/type migration always includes an aggregate check** (e.g.
  `SUM()` of the old-typed column equals `SUM()` of the new-typed column, per meaningful
  grouping) in addition to the standard count/null/duplicate checks in §8 — a type migration
  that preserves row count but silently corrupts values is the failure mode unique to this
  category.

---

## 20. Locking / transaction awareness

- PostgreSQL DDL takes locks; some (`ADD COLUMN` with a non-volatile default, adding a
  nullable column) are fast and low-impact on modern PostgreSQL, while others
  (`ADD CONSTRAINT` without `NOT VALID`, `SET NOT NULL`, some index creation, table
  rewrites) can hold an `ACCESS EXCLUSIVE` or otherwise blocking lock for the duration of a
  full table scan.
- **Never casually combine a large backfill and blocking DDL in the same transaction/migration
  step.** A backfill that touches many rows should not be run inside the same transaction as
  a schema change that needs a table-level lock — the lock gets held for the backfill's
  entire duration, blocking normal application traffic. Prefer: schema change (ADD) first, as
  its own fast migration; backfill (a separate step, batched per §7) after, outside a single
  giant transaction; constraint validation (`VALIDATE CONSTRAINT`, `CREATE INDEX
  CONCURRENTLY` where available) as a further separate, lock-light step.
- **`CREATE INDEX CONCURRENTLY`** avoids blocking reads/writes during index creation but
  cannot run inside the same transaction as other statements — this affects how such a
  migration must be structured (its own migration, and awareness that Prisma wraps
  migrations in a transaction by default, which may require special handling when this
  technique is actually needed).
- **No network calls inside a data migration.** A backfill script must be a pure
  function of the database's own current state — no calls to external services, no reliance
  on wall-clock-dependent third-party data — so it stays deterministic (§7) and reproducible
  in any environment, including disaster recovery.

---

## 21. Data migration script conventions

Not every backfill belongs inside `migration.sql`. When a large or logic-heavy data
migration is not well expressed as pure SQL (e.g. it needs per-row branching logic, currency
conversion, or barcode-collision policy per `05-architecture.md` §26), a dedicated script is
the right vehicle instead:

- **Where it belongs**: a dedicated, version-controlled script (e.g. under `api/scripts/`,
  alongside the existing `seed-demo.ts` / `reset-demo.ts` / `demo-database.ts` conventions),
  never an ad hoc one-off run and discarded. It is committed, reviewed, and its invocation
  documented, the same as any migration SQL.
- **Idempotency/resume behavior required where practical** — same standard as §7: safe to
  re-run without double-applying, ideally by scoping writes to rows not yet migrated.
- **Explicit verification required** — the script (or a paired verification script/query)
  must produce the checks described in §8 as part of its own output, not leave verification
  to a human eyeballing row counts afterward.
- **Deterministic ordering between schema migration and data backfill**: the schema
  migration (ADD) that creates the target column/table always runs strictly before the data
  migration script that populates it, and this ordering is enforced by deployment process,
  not assumed. A data migration script must fail closed (§22) if the schema it expects is not
  yet present, rather than silently doing nothing or erroring unclearly.

**No backfill script is created in Phase 0B.** This section defines where future ones live
and what they must guarantee.

---

## 22. Failure policy

Migration tooling and process **fail closed**, always, on:

- wrong database (target identity cannot be proven — see `docs/development/database.md` §6's
  fail-closed identity check, which is the model to follow for any migration-specific target
  verification too)
- an unverifiable environment (missing/ambiguous connection info, TLS not verified,
  unexpected PostgreSQL version)
- a failed VERIFY step (§8) of any kind
- unexpected duplicates that would violate a unique/partial-unique constraint
- orphan rows that would violate a foreign key about to be enforced
- an incompatible migration state (`migrate status` shows drift, or history doesn't match
  what's expected)

**"Continue anyway" is never an acceptable response** to any of the above, for a human or an
agent. The correct response is always: stop, report exactly what failed and against what
target, and let a human decide the next step (fix data, fix migration, or explicitly and
consciously override with a documented reason — never a silent override).

---

## 23. Roll-forward vs rollback boundary

This document defines only the **discipline principle**: because the compatibility
lifecycle (§5) keeps the old representation alive through DEPRECATE, most problems
discovered after SWITCH can be fixed by **rolling forward** — reverting the application's
read/write switch back to the old representation (which is still present and valid) while a
fix is prepared — rather than by reversing the database migration itself. Migrations should
be designed, wherever practical, so this kind of forward-fix is possible (i.e. avoid
irreversible steps before the compatibility window has passed).

**Detailed backup, restore, and rollback *implementation*** (database snapshots/dumps,
point-in-time recovery, tested restore procedure, and exactly how a DB-level rollback would
be executed if one were ever truly necessary) **belongs to Phase 0C** and is explicitly not
designed or implemented here.

---

## 24. Migration review checklist

Before any future schema-change migration is written or applied, confirm every item:

- [ ] Correct DB target identified and verified (§3) — no ambiguity about DEV/TEST/production.
- [ ] Backup dependency acknowledged where appropriate (Phase 0C tooling exists and was
      considered) before running against any target holding real data.
- [ ] Migration SQL fully reviewed, including any hand-appended raw SQL (§4, §12).
- [ ] Destructive statements identified explicitly, and isolated to their own REMOVE-stage
      migration (§11) if present at all.
- [ ] Data validation (VERIFY queries, §8) prepared and, where the migration is not a
      REMOVE, planned to run before SWITCH.
- [ ] Constraints/indexes explicitly named (never left to an auto-generated opaque name for
      any hand-written raw-SQL object).
- [ ] Any raw SQL justified — which Prisma limitation (§12) required it, referenced in a
      `schema.prisma` comment.
- [ ] Compatibility path identified (dual-write? old representation still readable? for how
      long?).
- [ ] Backfill strategy defined (§7) — deterministic, resumable, batched if needed.
- [ ] VERIFY queries defined and, ideally, automatable/re-runnable (§8).
- [ ] Application SWITCH point identified precisely (which code paths, which commit/PR).
- [ ] DEPRECATE/REMOVE explicitly deferred — not bundled into this migration.
- [ ] Relevant tests selected/updated (schema + backfill + application behavior).
- [ ] Roll-forward vs rollback implications considered (§23) — is this step reversible
      before the compatibility window closes?
- [ ] No credentials/secrets present anywhere in the migration, script, or its logs.

---

## 25. Agent rules

Claude / OpenCode / Codex (or any coding agent) working on this repository must **never**:

- invent Prisma locking syntax that doesn't exist (Prisma has no `lock` option, no
  `@@check`, no native partial-index syntax — use the raw-SQL techniques in §12 exactly as
  documented, never a fabricated Prisma-native equivalent).
- use `prisma db push` to bypass migration history for any change intended to persist or be
  reproduced elsewhere (§4).
- mutate a production (or any shared, non-local) schema manually — every schema change goes
  through a reviewed migration in history, never an ad hoc `psql`/Studio edit.
- execute destructive SQL (`DROP`, `TRUNCATE`, `SET NOT NULL` on a populated column, enum
  value removal, etc.) without the explicit phase authorization that phase's own scope
  grants — Phase 0B grants none.
- place raw SQL outside the traceable Prisma migration history without a documented reason
  (§12's "general rule").
- assume a migration succeeded without running/showing the actual VERIFY step (§8) — no
  "this should have worked."
- silently edit or reinterpret the frozen Production V1 requirements documents
  (`docs/production-v1/00`–`08`) to make an implementation detail more convenient. If an
  agent believes one of those documents is wrong or ambiguous, it says so explicitly to the
  user — it does not quietly change the document or contradict it in code.
