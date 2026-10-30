# Hosted TEST upgrade runbook (EXACT_G6 → EXACT_G20) and Location baseline

Status: tooling implemented **and already used on hosted TEST**: the G6 state was checked, the G7→G20 upgrade was executed and verified (20/20), and the six canonical Locations were created and verified with tool B. **Hosted TEST is currently at EXACT_G20.** This document is a saved procedure for rebuilding a TEST database, or for another compatible TEST database, **not an instruction to migrate the current hosted TEST again** (see section 6). Every WRITE phase below still needs explicit, per-phase owner authorization.
Scope: development process, same nature as `docs/development/migrations.md`. Nothing here changes `schema.prisma`, applied migrations or `docs/production-v1/*`.

## 0. Why

Before this procedure was run, hosted TEST held exactly the first 6 migrations (G1–G6); the paragraph describes that starting point. The repository has 20. Business tables are empty, the RBAC catalog is already at the 38-permission level, and `Location` has 0 rows (Company `TEST_COMPANY_BOOTSTRAP`, six canonical Branches). Two dedicated, fail-closed tools bring TEST to G20 and rebuild the six Locations. No generic migration, seed, reset or bootstrap script is ever run against TEST for this.

| Tool | Path | Writes |
|---|---|---|
| A: upgrade | `scripts/database/hosted-test-upgrade.mjs` | only `prisma migrate deploy` of the 14 approved migrations, plus `wx` 0600 evidence files |
| B: Location baseline | `api/scripts/hosted-test-location-baseline.ts` | only one `backfillLocationsFromBranches` call with the TEST Company |

Shared helpers: `scripts/database/hosted-test-common.mjs`. Tests: `hosted-test-upgrade.test.mjs`, `hosted-test-common.test.mjs`, `api/tests/hosted-test-location-baseline.test.ts`.

## 1. Invariants (enforced in code and pinned by tests)

- Target = the canonical TEST configuration (`.env.development` via `hosted-test-config.mjs`) and nothing else. The environment is refused if it carries `DATABASE_URL`, `TEST_DATABASE_*`, `PG*`, `PRISMA_*`, `PILOT*`, `LOCAL_TEST_*`, `MONA_D5H*`, `NODE_OPTIONS`, …
- `--marker-id` must restate the configured marker; `--confirm-project-ref` (execute) must restate the project ref. Nothing is inferred.
- The installed TEST marker is proven inside every snapshot before anything else is read.
- Only initial state `EXACT_G6`: ledger = G1–G6 `APPLIED_CLEAN` with exact checksums, G7–G20 exactly `MISSING`, nothing unexpected, and **no object of G7–G20 present** (names derived from the pending SQL). No resume state exists.
- PostgreSQL must be 17.x (17.6 on hosted TEST is accepted and recorded as a known, non-blocking difference from the 17.11 reference). `mona_pilot_guard` / `mona_local_test_guard` schemas make the target unacceptable.
- `--dry-run` opens no database connection (it runs `pg_restore --list` on the local backup). Its plan digest binds: the 20 migration pins and lock, Prisma version and script hash, schema/CA/staged-config hashes, the G20 reference digest, tooling file digests, target and marker digests, the verified backup (file, sha256, set id, time) and the identity evidence. Any edit invalidates the plan.
- `--execute` stages the verified bytes in a private directory, runs **one** `prisma migrate deploy` (literal argv, allow-listed environment), never retries, never `migrate resolve`, never repairs. A failure writes a FAIL evidence file and reports the post-failure ledger.
- Postcheck on a fresh connection: marker, 20/20 ledger, schema projection digest equal to the pinned G20 reference, generation probes empty.
- No output ever contains a URL, host, user, password, project ref or marker id: only digests and fixed codes.
- `backup.mjs` is not modified.

## 2. Procedure (each WRITE step needs its own authorization)

Run from the repository root. `<ref>` = 20-character project ref, `<marker>` = marker id, `BK` = absolute backup directory (the same directory for the dump and the identity evidence).

1. **A `--check --evidence-out=BK/<dump>.identity.json` (read-only on the database)**
   `node scripts/database/hosted-test-upgrade.mjs --target=test --check --marker-id=<marker> --expected-initial-state=EXACT_G6 --evidence-out=BK/<dump>.identity.json`
   Expect `result: PASS`, `state: EXACT_G6`. The evidence is created exclusively (`wx`, 0600) and must exist **before** the backup: the tool rejects identity evidence observed after the backup was created. `backup.mjs` names the dump itself (`backups/database/test_pre-migration_<UTC>.dump`); the identity file only has to sit in that same directory, e.g. `backups/database/identity-<UTC>.json`, and `--backup-evidence` must then point at the dump produced afterwards.
2. **Backup (WRITE: local files only)** with the existing tool, unmodified:
   `node scripts/database/backup.mjs --target=test --purpose=pre-migration --confirm-project-ref=<ref>`, then verify the pair (`verifyBackupPair`). Dump, manifest and identity evidence must live in the same directory and be at most 6 hours old.
3. (Optional) repeat step 1 without `--evidence-out` right before the dry-run to see the state is unchanged.
4. **A `--dry-run`**
   `… --dry-run --marker-id=<marker> --expected-initial-state=EXACT_G6 --backup-evidence=BK/<dump> --identity-evidence=BK/<dump>.identity.json`
   Copy the printed `planDigest`.
5. **A `--execute` (WRITE: hosted TEST schema)**
   `… --execute … --confirm-project-ref=<ref> --plan=<planDigest>`
   Expect `finalState: EXACT_G20` and `BK/<dump>.upgrade-evidence.json` (`outcome: PASS`).
6. **B Location baseline** (after G20; `NODE_ENV=test` is required by the guarded opener):
   - `cd api && NODE_ENV=test npx tsx scripts/hosted-test-location-baseline.ts --target=test --check --marker-id=<marker>` → `ABSENT_CLEAN`
   - `… --dry-run …` → copy `planDigest`
   - `… --execute --marker-id=<marker> --confirm-project-ref=<ref> --plan=<planDigest>` → `finalState: ALREADY_CANONICAL`, `wrote: true`, protected counts unchanged. A second `--execute` is a no-op (`wrote: false`).
7. Only then re-run the hosted TEST focal suites (expected ≈102 tests; `sale-exchange-read.pg` and the LOCAL_TEST fixture suites skip or refuse outside LOCAL_TEST by design).

## 3. Refusal / failure codes

A: `ENV_FORBIDDEN`, `CONFIG_*`, `MARKER_ARG_MISMATCH`, `PROJECT_REF_MISMATCH`, `TREE_*`, `MARKER_NOT_PROVEN`, `FOREIGN_GUARD_PRESENT`, `SERVER_VERSION_UNSUPPORTED`, `LEDGER_ABSENT`, `STATE_NOT_EXACT_G6`, `STATE_ALREADY_TARGET`, `ADVANCED_OBJECTS_PRESENT`, `BACKUP_*`, `IDENTITY_EVIDENCE_*`, `PLAN_MISMATCH`, `STAGE_*`, `DEPLOY_FAILED|TIMEOUT|SPAWN_FAILED`, `POSTCHECK_LEDGER|SCHEMA_DIGEST|PROBES`, `EVIDENCE_EXISTS` (a leftover `<dump>.upgrade-evidence.json` stops the run before the deploy), `SUPPORT_FILES_UNREADABLE`, `TOOLING_UNREADABLE`, `PATH_NOT_ABSOLUTE`.
B: `ENV_FORBIDDEN`, `CONFIG_*`, `PLAN_MISMATCH`, `TOOLING_UNREADABLE`, `COMPANY_UNEXPECTED`, `COMPANY_AMBIGUOUS`, `BRANCH_STATE_UNEXPECTED`, `LOCATION_STATE_UNEXPECTED`, `VERIFY_FAILED`, `PROTECTED_COUNTS_CHANGED`, `POSTCHECK_LOCATIONS`, `MARKER_NOT_PROVEN`.
Exit codes: 0 PASS, 1 refused/failed, 2 usage. One JSON line per run on stdout.

## 4. If it fails

Do not retry or repair. Read the FAIL evidence file and the single JSON result. Restore from the backup is a **separate, explicitly authorized** operation (a restore is not a downgrade of the migration ledger). A refused precheck means the database is not in the approved initial state: stop and report.

## 5. Local test notes

- A and common: `node --test scripts/database/hosted-test-upgrade.test.mjs scripts/database/hosted-test-common.test.mjs` (no database, no network).
- B: its vitest run must go through the disposable LOCAL_TEST sandbox (the shared `setup.ts` otherwise points at hosted TEST); the test itself is all doubles and connects nowhere.

## 6. Current state and re-use

- Hosted TEST is at `EXACT_G20` with the six canonical Locations. Running tool A against it again is **not** part of the normal flow: its precheck refuses an already-migrated database with `STATE_ALREADY_TARGET` and writes nothing. Running tool B again is a no-op (`wrote: false`).
- Use this runbook only to rebuild a TEST database that is back at `EXACT_G6`, or on another TEST database that satisfies the invariants in section 1. Anything else is refused by design and must be reported, not worked around.
- The `--check` phases (tool A without `--evidence-out`, tool B) only read the database and write no file, so they are the only phases that observe the current state without a write authorization.
