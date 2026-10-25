# PILOT G16 rollout runbook — sale void v1 (EXACT_G14 + CATALOG_36 → EXACT_G16 + CATALOG_37)

Status: **PREPARED (Stage 6A), NOT EXECUTED.** OWNER-only. Nothing in this document was run against
PILOT, TEST or DEV; every tool below was proven only on a disposable local PostgreSQL 17 (see
"Local proof"). Every step that touches PILOT, Railway or Vercel is run by the OWNER, by hand, in
the order below. A step whose expected result line does not appear exactly is a **STOP**.

Release under rollout: API/client commit **`cbe0a98`** (`feat(sales): add supervised post-payment
sale void`, CI #72 green). It is the commit whose Prisma Client selects `StockMovement.saleVoidId`
and `CashMovement.refundOfSalePaymentId`.

## HARD GATE — no G14 → G16 without a verified backup and a verified clone restore

**It is FORBIDDEN to execute `pilot-g16-migrate.mjs --execute` against PILOT unless, immediately
before the cut-over (same window, after the API was stopped and the cash sessions closed, i.e. after
step 6 and before step 8), BOTH of these exist and are recorded in the private log:**

1. a verified **EXACT_G14** backup (`A5B_RESULT=VERIFIED`, `ledger=EXACT_G14`, `rbacCatalog.catalog=CATALOG_36`), and
2. a verified **cloned restore** of that very archive (`A5C_RESULT=VERIFIED`, all checks PASS).

This gate is **procedural**: `pilot-g16-migrate.mjs` cannot see backups (it is a different tool family, pinned to
G14 by four manifests) and does not check for them. The OWNER is the guard. A backup older than the window, a
backup without its restore proof, or a restore proof of another archive does not satisfy it. No backup, no window.

Consequences, stated once:

- **After G16 and before any `SaleVoid` / `SALE_REFUND` row exists:** rollback = full restore of that EXACT_G14
  backup (the migrations only add objects, nothing is lost). There is **no canonical G16 backup or incremental
  checkpoint** today: `pilot-backup`, `pilot-clone-restore` and `pilot-a4-readonly` do not know G16.
- **After the first `SaleVoid` / `SALE_REFUND` row exists:** no restore of the G14 backup (it would erase real
  voids/refunds), no downgrade of any kind. Forward-fix, or an explicit OWNER decision record plus export and
  reconciliation of every operation since the API start.

## Why the order is fixed

`cbe0a98` MUST NOT run against a G14 database: its Prisma Client selects columns that only G16
creates, so ordinary stock and cash reads fail at runtime. The API start gate (`r3_startup_gate`,
G14-strict) does **not** protect against this — a G14 ledger satisfies it. The only protection is
the order:

1. database **G14 → G16** (`pilot-g16-migrate.mjs`),
2. RBAC **CATALOG_36 → CATALOG_37** (`pilot-rbac-catalog-37-upgrade.mjs`),
3. deploy the API at `cbe0a98`, then the client.

The frozen cut-over tools (`pilot-migrate.mjs`, `pilot-a4-readonly.mjs`, `pilot-backup.mjs`,
`pilot-clone-restore.mjs`, `pilot-rbac-catalog-upgrade.mjs`) are untouched and keep their G14 /
CATALOG_36 contracts. `pilot-migrate.mjs` verifiably refuses a G16 repository tree (exact G14 tree
verifier). For the backup and restore-proof tools (hash-pinned to the G14 checkout by four manifests) this
runbook does not rely on how they behave from a G16 tree: run them from the **G14-tree checkout
(tag `pilot@9086697`)**, with `git status` clean, and run the new G16 tools from the `cbe0a98`+tools checkout.

## What changes in PILOT

| Layer | Before | After |
|---|---|---|
| Prisma ledger | EXACT_G14 (14 migrations) | EXACT_G16 (16): + `20261024120000_sale_void_enum` (604 B), + `20261024130000_sale_void_schema` (11 592 B) |
| Schema | 31 tables / 304 columns / 151 constraints / 130 indexes / 9 functions / 10 triggers | 33 / 321 / 171 / 144 / 11 / 12 (additive only) |
| RBAC | CATALOG_36 (36 permissions, 75 grants) | CATALOG_37: + permission `SALE_VOID` (id `00000000-0000-4000-9400-000000000037`) + ONE grant (ADMIN). OWNER is implicit; CASHIER/SELLER/WAREHOUSE never get it |
| Data | — | no row is rewritten (the migrations only add objects; proven by a row fingerprint, see "Local proof") |

Pins live in `scripts/database/pilot-migration-generations.mjs` (sha256 82581170…4c0f / 0f2841ca…1182d),
`pilot-rbac-catalog-generations.mjs` and `pilot-g16-schema-references.mjs`.

## New tools (all fail closed, never repair, never print a URL/host/user/password/project ref)

| Tool | Mode | What it does |
|---|---|---|
| `pilot-g16-preflight.mjs` | READ-ONLY (`--check` only) | Identity (audited `pilot-marker --check`), applied migrations, detected generation, schema digest vs the G14/G15/G16 references, G15/G16 object presence, RBAC catalog 35/36/37, fixed row counts, and a verdict: `READY_FOR_G16_MIGRATION`, `HALF_APPLIED_G15`, `G16_READY_FOR_RBAC_37`, `G16_RBAC_37_COMPLETE` (exit 0) or `BLOCKED` / `ERROR` (exit 1) |
| `pilot-g16-migrate.mjs` | dry-run / execute | G14 → G16 only. `--expected-initial-state=EXACT_G14` (or `EXACT_G15` to resume a half-applied run under a new approved plan). Exact-tree verification of the 16 pinned migrations (before the proof and again before the spawn), identity proof, read-only pre-check (ledger + schema digest + 142 probes), ONE `prisma migrate deploy` from a private staged copy, read-only post-check that must be exactly EXACT_G16. Plan digest binds target + tooling + payload + states |
| `pilot-rbac-catalog-37-upgrade.mjs` | dry-run / execute | CATALOG_36 → CATALOG_37 in ONE SERIALIZABLE transaction: ledger must be EXACT_G16, marker proven, the three RBAC tables locked, exact classification, two parameterized INSERTs, re-classification in the same transaction, COMMIT. Exact 37 → verified no-op. Anything else (35, partial, extra row, wrong id, wrong grant) → CONFLICT, ROLLBACK, nothing written. No upsert, no DELETE/UPDATE/DDL |

Result lines: `PILOT_G16_PREFLIGHT_RESULT=…`, `PILOT_G16_MIGRATE_RESULT=EXACT_G16|RESTORE_REQUIRED`,
`RBAC_UPGRADE_RESULT=UPGRADED|NOOP_VERIFIED|CONFLICT|REFUSED|UNKNOWN`.

## Hard prerequisites (any missing item = the window is not scheduled)

| ID | Prerequisite | Evidence |
|----|--------------|----------|
| G1 | The fixed release commit is `cbe0a98261f5e31f0b5b0751a847c7d8493416f9` plus the commit that contains these tools; every tool below runs from that checkout, `git status` clean. | SHA in the private log |
| G2 | DB-free gates GREEN at G1: `node --test scripts/database/*.test.mjs`, `node scripts/database/pilot-tool-manifests.mjs --check` (all four CURRENT), API lint, `tsc --noEmit`. | gate log |
| G3 | The OWNER private files exist and are private (0600 / 0700): `pilot-database-url`, `pilot-marker-id`, `pilot-backup-mac-key`. | tool gates |
| G4 | Railway `DATABASE_URL` verified (same point as cut-over step 2). | record `RAILWAY_DATABASE_URL_VERIFIED <date> <initials>` |
| G5 | A private 0700 backup directory and 0700 clone work root outside the repository and `/tmp`. | backup gates |
| G6 | PILOT is **EXACT_G14 + CATALOG_36** by `pilot-a4-readonly.mjs` (G14-tree checkout). | A4 output |

## Steps

### Before the window (no write anywhere)

1. **Freeze the toolchain.** Check out G1. Record the commit SHA and the SHA-256 of
   `pilot-g16-migrate.mjs`, `pilot-g16-preflight.mjs`, `pilot-rbac-catalog-37-upgrade.mjs`,
   `pilot-g16-schema-references.mjs`, `pilot-migration-generations.mjs`,
   `pilot-rbac-catalog-generations.mjs` in the private log.
2. **Preflight (read-only).**
   `node scripts/database/pilot-g16-preflight.mjs --target=pilot --check --marker-id=<uuid> --confirm-project-ref=<ref>`
   Required: `PILOT_G16_PREFLIGHT_RESULT=READY_FOR_G16_MIGRATION` with `ledger generation: EXACT_G14`,
   `(= EXACT_G14)` (digest `eb00d04b…1f71`), `G16 objects … missing 59`, `RBAC catalog: CATALOG_36`. Record
   the whole output (it carries the row counts used in step 9). `BLOCKED`, `HALF_APPLIED_G15`, or a
   later verdict → STOP.
3. **Announce the maintenance window.**

### Maintenance window

4. **Close every OPEN cash session normally** through the application. No force-close in the database.
5. **Freeze writes and stop the API** (Railway: 0 running instances; client in maintenance state).
6. **Preflight again** (step 2 command). Required: the same verdict and the same row counts except the
   closed sessions. Any other difference → STOP.
7. **Pre-rollout backup and restore proof — THE rollback point.** From the **G14-tree checkout**
   (`pilot@9086697`; the backup tools are G14-pinned): `pilot-backup.mjs --target=pilot --dry-run
   --output-dir=<backups> --expected-state=EXACT_G14` → `A5B_RESULT=DRY_RUN_OK`; then the exact OWNER launch
   command produced by `pilot-launch-command.mjs` (tool `pilot-backup`, `expectedState=EXACT_G14`) →
   `A5B_RESULT=VERIFIED`; then the `pilot-clone-restore` launch command (`expectedState=EXACT_G14`) →
   `A5C_RESULT=VERIFIED` with all checks PASS. Record, privately: UTC timestamp, archive name, archive
   SHA-256, `ledger=EXACT_G14`, `rbacCatalog.catalog=CATALOG_36`, table/row totals. Without
   `A5C_RESULT=VERIFIED` there is no window.
8. **G14 → G16 plan (no connection).** From the `cbe0a98` checkout:
   `node scripts/database/pilot-g16-migrate.mjs --target=pilot --dry-run --marker-id=<uuid> --expected-initial-state=EXACT_G14`.
   Required: `migration payload: PASS — exactly 16 …`, `migrations to apply: 2`,
   `FINAL_STATE=EXACT_G16 … 87ecc8d7…c7b3`, `PLAN_DIGEST=<64 hex>`. Record `PLAN_DIGEST`.
9. **Migrate.** `node scripts/database/pilot-g16-migrate.mjs --target=pilot --execute --marker-id=<uuid>
   --confirm-project-ref=<ref> --expected-initial-state=EXACT_G14 --plan=<PLAN_DIGEST>`.
   Required: `precheck ok …`, `postcheck ok — ledger EXACT_G16 … probes 142/142`,
   `PILOT_G16_MIGRATE_RESULT=EXACT_G16`. `RESTORE_REQUIRED` or any refusal → STOP, rollback R-B.
10. **RBAC plan and execute.** `node scripts/database/pilot-rbac-catalog-37-upgrade.mjs --target=pilot
    --dry-run --marker-id=<uuid>` → `PLAN_DIGEST`; then `--execute --marker-id=<uuid>
    --confirm-project-ref=<ref> --plan=<digest>`. Required: `RBAC_UPGRADE_RESULT=UPGRADED`
    (or `NOOP_VERIFIED` when a previous run already did it). `CONFLICT` / `REFUSED` → STOP (R-C).
    `UNKNOWN` → run step 11 first, then decide.
11. **Final preflight (read-only).** Required: `PILOT_G16_PREFLIGHT_RESULT=G16_RBAC_37_COMPLETE`,
    `ledger generation: EXACT_G16`, `(= EXACT_G16)`, `G16 objects … all present`, `RBAC catalog: CATALOG_37`,
    and **every `rows <Table>` count equal to step 6** (the migrations add objects only). Any difference → STOP.
    **Do not use A4 / pilot-backup after this step**: they are G14-pinned and would report a mismatch by design.

### Restart

12. **API deployment.** Re-verify G4, confirm `RESERVATION_SWEEPER_ENABLED=false` (as cut-over step 18),
    deploy the API at `cbe0a98`. Required: the process stays up, no `r3_startup_gate_failed`.
13. **Client deployment** at the same release; remove the maintenance state only after step 14.
14. **Smoke test (OWNER account, then one ADMIN, then one CASHIER).** `/auth/me` carries `SALE_VOID` for
    OWNER and ADMIN and **not** for CASHIER/SELLER/WAREHOUSE; one ordinary sale still completes; exactly
    one supervised void of a test sale (reason, cash refund in an OPEN session) and its idempotent replay.
    This is the first business write on G16 — the lossless-restore guarantee ended at step 12.
15. **Open the PILOT**, announce the end of the window.
16. **Evidence bundle** (private): both preflight outputs, the pre-rollout backup manifest and
    restore proof, the two `PLAN_DIGEST`s, the migrate / RBAC / preflight result lines, the Railway
    verification record, the SHA of the release and of the tooling files, UTC timestamps of each step.

## Required evidence (checklist)

- UTC timestamp of every step; operator initials.
- Detected generation before (`EXACT_G14`) and after (`EXACT_G16`); catalog before (`CATALOG_36`) and after (`CATALOG_37`).
- Backup/checkpoint: archive name + SHA-256 + `A5B_RESULT=VERIFIED` + `A5C_RESULT=VERIFIED` (EXACT_G14).
- Release SHA `cbe0a98261f5e31f0b5b0751a847c7d8493416f9` and the SHA of the commit with these tools.
- G16 checksums as printed by the migrate dry run (82581170…4c0f, 0f2841ca…1182d) and the reference digests (G14 `eb00d04b…`, G16 `87ecc8d7…`).
- Row counts before/after (must be identical) and the result lines listed above.

## Rollback boundary

- **Before step 9 starts**: nothing changed; stop. The previous API (`pilot@9086697`) stays the reference deployment.
- **R-B — step 9 failed or the post-check is not exactly EXACT_G16** (`RESTORE_REQUIRED`): the tool never
  resolves, retries or repairs; never `prisma migrate resolve`, never SQL by hand. Run the preflight to
  record the state. If it is an exact `HALF_APPLIED_G15` the OWNER may approve a NEW dry run with
  `--expected-initial-state=EXACT_G15`; otherwise (failed/unfinished ledger row, drift) → **full restore of the
  step-7 backup** per `11-g11-rollback-runbook.md`, then the old API keeps running. The G16 migrations create
  objects only, so no data is lost by a restore taken before the API starts.
- **R-C — step 10 `CONFLICT`/`REFUSED`**: nothing was written (the transaction rolled back). The database is G16
  with CATALOG_36: do NOT deploy `cbe0a98`; fix the cause (e.g. a CATALOG_35 must first go through the 35 → 36
  tool) and re-run, or restore the step-7 backup.
- **Last guaranteed-lossless restore point: before step 12** (API start). After the API runs, sweeper and
  users can write; from then default is FORWARD FIX.
- **After any `SALE_VOID` / `SALE_REFUND` row exists** a plain restore of the step-7 backup would drop the
  void, its refund and its stock returns while real money/stock moved: **no restore**, no destructive
  downgrade (no `DROP TABLE`, no enum label removal — PostgreSQL cannot remove labels). The only path is a
  forward fix, or an explicit OWNER decision record plus an export and reconciliation of every operation
  since step 12 (same rule as `11-g11-rollback-runbook.md`, R-D).
- To switch the feature off without a schema change, deploy the previous API **only while no SaleVoid /
  SALE_REFUND row exists**; the extra columns/tables are harmless to the old code (additive schema), but the
  old API must not be deployed over data it cannot read once voids exist (its stock/cash reconciliation does
  not know `SALE_REFUND`).

## What the checks verify — and what they do not

Verified by `pilot-g16-migrate` (pre-check and post-check) and `pilot-g16-preflight`:

- **Ledger**: exactly the 14 / 15 / 16 pinned migrations, names + checksums, all finished, none rolled back, no duplicate or unknown row.
- **App-owned schema digest** (`app-schema-projection` v2): every table/column (type, NOT NULL, default, identity, generated), enum labels in sort order, every PK/FK/UNIQUE/CHECK definition and validated flag, every index definition and validity, every app function (SHA-256 of `pg_get_functiondef`) and non-internal trigger definition and enabled state. G14 digest = the historical pinned `eb00d04b…1f71`; G15 (`111f1d04…`) differs from G14 only by the two enum labels (same summary counts); G16 (`87ecc8d7…`) adds the 2 tables, 2 columns, 2 labels, 20 constraints, 14 indexes, 2 functions, 2 triggers. Rows are sorted in JavaScript, never by PostgreSQL, and the digest was reproduced by two construction paths (plain SQL files vs Prisma deploy from a G14 base).
- **142 name-level probes** per generation (G14 base + the 59 G16 delta objects; for G14/G15 the delta's *absence*): presence/absence of tables, columns, enum labels, constraints (type + validated), indexes (valid), functions, triggers (not disabled). Probes are set-membership checks, independent of catalog row order. They add precise refusal reasons; the digest is what pins definitions.

NOT verified by any tool here (do not claim otherwise): ownership, privileges/GRANTs, RLS, comments, sequences, views, extension objects, data contents, and runtime behaviour of the guard triggers (that is covered by the API test suites, not by the rollout tools). `pilot-g16-preflight` also does not read business data beyond eight fixed `count(*)` values.

Both writing tools take the PILOT identity ONLY from the private URL file (`~/.config/mona-jacinta/pilot-database-url`, read once). An ambient `DATABASE_URL`, `TEST_DATABASE_URL` or `PG*` variable is never used as identity or fallback (tested). `--execute` exists only when typed; absence of a mode flag is an argument error, `--dry-run` opens no connection and spawns nothing (tested).

## Known gaps / risks (decided, not hidden)

1. **No post-G16 backup tool.** `pilot-backup`, `pilot-clone-restore` and `pilot-a4-readonly` are
   pinned by hash in four manifests and know only G14/CATALOG_36. Extending them requires regenerating the
   manifests with OWNER PG17 binaries and is a separate stage. Until then the pre-rollout (G14) backup is the
   only canonical checkpoint and the preflight (read-only) is the only canonical post-G16 verification.
2. **The API start gate does not refuse a G14 database for `cbe0a98`** (it is G14-strict, G16 is a superset).
   The rollout order and step 11 are the protection.
3. **The G15/G16 schema references were generated on disposable PostgreSQL 17** (same method that reproduces the
   pinned G14 digest byte for byte), not on PILOT's Supabase server. A PILOT-specific drift would show as a
   pre-check refusal (`the app schema is not the EXACT_G14 reference`) before anything is written — a safe failure.
4. **TLS / Supabase path** (verified client, pinned CA, staged `prisma.config.ts`) is exercised by unit tests with
   fakes only, like the existing tools; the local proof replaced TLS and the Prisma config with a lab shim.
5. **A failed `prisma migrate deploy` that stopped after migration 15** leaves a G15 ledger *plus* possibly a
   failed row of migration 16; the tool classifies that as `RESTORE_REQUIRED` (proven locally, see below).

## Local proof (disposable PostgreSQL 17, Docker; no remote database was touched)

Run 2026-10-24. Exact G14 database built by the old-code tree (`pilot@9086697`) with `prisma migrate
deploy` + the CI fixture; RBAC reset to the exact CATALOG_36; representative data added (3 sales: CASH,
TRANSFER, one draft; an OPEN cash session with a SALE_INCOME and a WITHDRAWAL; stock movements).

| Check | Result |
|---|---|
| Preflight on G14 | `READY_FOR_G16_MIGRATION`, digest `eb00d04b…1f71` = pinned G14 reference, `G16 objects missing 59`, CATALOG_36 |
| Current Prisma Client on G14 | 6/6 probes FAIL (`SaleVoid` table, `SaleVoidExternalRefund` table, `StockMovement.saleVoidId`, `CashMovement.refundOfSalePaymentId`, `SALE_VOID` label, `SALE_REFUND` label) — confirms why the order matters |
| `pilot-g16-migrate` dry-run + execute (real tool, real G16 tree, staged tree, real Prisma deploy) | `precheck ok … probes 142/142`, 2 migrations applied, `postcheck ok — EXACT_G16 … 87ecc8d7… = reference, probes 142/142`, `PILOT_G16_MIGRATE_RESULT=EXACT_G16` |
| Second migrate run | refused at pre-check (`the ledger is EXACT_G16, expected EXACT_G14`), Prisma not started |
| Data continuity | row-level fingerprint (md5 of every row, 12 tables) identical before/after |
| Preflight on G16 | `G16_READY_FOR_RBAC_37`; `G15 objects present`, `G16 objects all present` |
| `pilot-rbac-catalog-37-upgrade` execute ×2 | run 1 `UPGRADED` (digest `9272b06d…eabca`, 37 permissions / 76 grants, `SALE_VOID` id `…9400-000000000037` → ADMIN only); run 2 `NOOP_VERIFIED`, nothing written |
| Preflight final | `G16_RBAC_37_COMPLETE` |
| Current Prisma Client on G16 | 6/6 probes OK; `SALE_VOID` permission present |
| G16 objects | enum labels `SALE_VOID`/`SALE_REFUND`; `SaleVoid`, `SaleVoidExternalRefund`; 7 unique indexes incl. `CashMovement_refundOfSalePaymentId_key`; both guard functions/triggers; 0 unvalidated constraints |
| Focused API suites on that DB (sale-void pg/http/behavior/static, sale-refund DB guard, RBAC matrix + permission, auth/me) | 26 files, 449 passed, 25 skipped (`cash-movement.pg.test.ts` is gated off in this harness), 0 failed |
| Rollback proof | `pg_dump` taken before the migration, restored into a scratch database → preflight `READY_FOR_G16_MIGRATION`, digest = G14 reference, CATALOG_36, original row counts |
| Poisoned database (a foreign `SaleVoid` table) | refused at pre-check (`PROBE_FAILED:absentTable:SaleVoid`), Prisma never started |
| Real mid-run failure (schema `CREATE` revoked, migration 15 commits, migration 16 fails) | `PILOT_G16_MIGRATE_RESULT=RESTORE_REQUIRED`, post-failure ledger reported as unfinished, preflight `BLOCKED`; nothing retried or resolved |

## Never

- `prisma migrate resolve`, `prisma db push`, `prisma migrate reset`, `migrate dev`, or any SQL downgrade.
- Deploying `cbe0a98` before steps 9–11 are green.
- A restore onto PILOT without the rollback decision record, or any restore once a SaleVoid/SALE_REFUND exists.
- Printing or storing a URL, password, project ref or marker id.
- Running a step against DEV, hosted TEST or DEMO; running the frozen G14 tools from the G16 checkout.
