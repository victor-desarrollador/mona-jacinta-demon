# Backup, Restore, and Deterministic Seed Strategy

Status: Approved (Phase 0C) — **backup/restore automation is IMPLEMENTED AND VALIDATED**
(see §0 below for the real drill). Deterministic seed strategy is implemented and validated.
Scope: **Development process** — same nature as `docs/development/migrations.md`: discipline
and procedure, not a Production V1 business requirement. Nothing here changes
`api/prisma/schema.prisma`, migration history, or application code.
Related: `docs/development/database.md` (environment/connection safety, hosting model),
`docs/development/migrations.md` §23 (roll-forward vs rollback discipline boundary — this
document is what that section deferred to Phase 0C),
`docs/production-v1/08-implementation-roadmap.md` Phase 0C entry ("database backup/rollback
strategy; deterministic seed strategy").

---

## 0. Status of this phase — read this first

This phase's own instructions require: *"If PostgreSQL client tools are not available: do
not install them automatically; implement only what can be safely implemented without
fabricating validation; the final verdict must be BLOCKED if restore validation cannot be
performed."*

A prior pass of this phase found none of `pg_dump`, `pg_restore`, or `psql` installed and
correctly stopped at a designed-but-unvalidated state (see git history for that version of
this document). **PostgreSQL client tooling has since been installed by the human operator**
(`pg_dump`/`pg_restore`/`psql` 17.11, Debian package `postgresql-client-17`), unblocking this
phase. This revision records what was actually implemented and actually run:

- **Client/server version compatibility (Phase 0C §2 requirement):** `pg_dump`/`pg_restore`
  17.11 against DEV and TEST, both confirmed PostgreSQL 17.x by `npm run db:check`. Same
  major version on both ends — safe, no compatibility concern.
- **Backup and restore tooling is implemented**, at `scripts/database/backup.mjs`,
  `scripts/database/restore.mjs`, and shared helpers in `scripts/database/lib.mjs`. It reuses
  the existing identity-proof mechanism (§3) rather than duplicating it:
  `scripts/check-databases.mjs` was minimally refactored to export a `proveIdentities()`
  function with the exact same checks `npm run db:check` already ran (no behavior change —
  reconfirmed by re-running `npm run db:check` before and after the refactor with identical
  output); the CLI script now only calls it when run directly (`import.meta.url` guard), so
  importing it from the new tooling cannot trigger an unwanted second run.
- **A real backup → checksum → restore → verify drill was executed against TEST only.** DEV
  was never touched — see §11 for the full, real result. This document's §§4–11 below are no
  longer a specification; they describe what was built and confirmed working, with the one
  deviation from the original design recorded inline where it applies (§5's `--schema=public`
  scoping, discovered necessary during the drill).
- **Deterministic seed strategy** was audited and validated in the prior pass, and
  **re-validated after the restore drill** (`api/tests/seed.test.ts`, 9/9 passing both times)
  — see §12–14.

No changes were made to `api/prisma/schema.prisma`, migration history, or seed application
code. The only new files are the backup/restore tooling above, a `backups/` entry in
`.gitignore`, and two new root `package.json` scripts (`db:backup`, `db:restore`).

**A subsequent final safety review of this same tooling** (before anything was staged/
committed) found and fixed two real issues by reading the actual diff, without repeating the
destructive restore drill: an unredacted-secret path in `restore.mjs`'s `prisma migrate
status` failure handling (§9), and post-restore verification checking only a hardcoded
7-table subset instead of the full restored logical state (§8, now a dynamic 22-table
manifest comparison). Both were validated non-destructively — see §8/§9 for what changed and
how each was confirmed.

---

## 1. Scope and threat model

This document defines how database state is protected against **operational
mistakes** made while carrying out Production V1's migration lifecycle
(`docs/development/migrations.md`) — a bad backfill, a REMOVE migration run too early, a
seed/reset run against the wrong target — and how a **deterministic starting state** is
guaranteed for development, demos, and integration tests.

It does **not** cover:
- infrastructure-level disaster recovery already provided by the hosting platform (Supabase
  itself performs its own automated backups/PITR on its managed Postgres — this document is
  about an *independent, developer-controlled* backup path, not a replacement for platform
  guarantees, and makes no claim about Supabase's own retention/PITR configuration).
- security incident response (credential compromise, data breach) — out of scope here.
- Phase 0B's migration compatibility lifecycle itself — that document is the *how to change
  schema safely* half; this document is the *how to recover if something still goes wrong,
  and how to always have a known-good starting dataset* half.

**Threat model** — the failure modes this document defends against:
1. A migration or backfill run in Phase 1+ corrupts or loses data in a way that can't be
   fixed forward (accidental `TRUNCATE`, a bad batched `UPDATE`, a REMOVE run before its
   compatibility window closed).
2. A destructive operation (reset, truncate, restore) is run against the wrong database
   because of an ambiguous or misconfigured target.
3. Demo/dev data drifts from a known state and can no longer be trusted for demos or manual
   QA.
4. Integration tests need a guaranteed-clean, guaranteed-identical starting dataset on every
   run, indefinitely, without manual intervention.
5. Secrets (connection strings, passwords) leak through backup artifacts, script output, or
   commit history.

---

## 2. DEV / TEST / (future) production separation

Same model as `docs/development/database.md` §1 and `docs/development/migrations.md` §3,
extended to backup/restore:

| Environment | Today | Backup source? | Restore target? |
|---|---|---|---|
| DEV/DEMO (`DATABASE_URL`, Supabase project `mona-jacinta-demo`) | active | **yes** — the only intended backup *source* today | **no** — never an automated restore target; see §6 |
| TEST (`TEST_DATABASE_URL`, Supabase project `mona-jacinta-test`) | active | no (fully reproducible from seed + migrations; a backup of TEST has no value TEST's own reset/seed cycle doesn't already provide) | **yes** — the *only* approved automated restore-drill target |
| Production (future) | does not exist yet | will be its own backup source once it exists | restore into production is explicitly **not** designed here — it requires its own dedicated, separately-reviewed path per §6 and is out of scope for Phase 0C |

The same rules from `docs/development/migrations.md` §3 carry over unchanged: physically
distinct targets, credentials only in the untracked `.env.development` (or its future
production-equivalent, itself never introduced by this document), fail-closed on target
ambiguity, and no reliance on shell-ambient state to pick a target.

**Never restore into DEV automatically.** DEV is the backup *source*; it is not a restore
target for the drill described here. If DEV itself ever needs restoring, that is a
manually-supervised incident-response action using the same artifact/procedure — not an
automated script path, and explicitly not designed in this phase (see §6).

---

## 3. Reused safety mechanisms (do not duplicate)

Per this phase's own instruction to reuse existing identity/safety mechanisms rather than
duplicate secret-handling logic, any future backup/restore implementation must build on what
already exists and is already tested, rather than re-deriving it:

- **`scripts/check-databases.mjs`** — the existing fail-closed, multi-signal DEV/TEST
  identity-and-reachability check (parses both URLs, opens verified-TLS connections, compares
  `current_database()`/`current_user`/`inet_server_addr()`/`pg_control_system()`, requires
  PostgreSQL 16+, prints only a redacted summary). Confirmed working in this phase
  (`npm run db:check` → both reachable, both PostgreSQL 17.x, distinct identities proven).
  Minimally refactored in this phase to export its check as `proveIdentities()` (same checks,
  same output, guarded to only auto-run when the file is executed directly) so
  `scripts/database/backup.mjs`/`restore.mjs` call the exact same proof instead of a second,
  competing implementation — confirmed identical CLI output before/after the refactor.
- **`api/scripts/demo-database.ts`** (`parseTarget`, `assertDistinct`, `readDemoTargets`,
  `openSeedDatabase`) — the same style of check, scoped to the seed/reset path, requiring an
  explicit `Target` (`'demo' | 'test'`), rejecting connection-string overrides, rejecting
  non-session-pooler targets, and refusing to proceed unless both configured targets are
  live-proven distinct.
- **`api/tests/helpers/test-db.ts`** (`assertTestDatabaseIsolation`, `createTestPrismaClient`,
  `truncateAllTables`, `withTransaction`) — the TEST-only destructive-operation guard: a
  `WeakSet` of "proven" clients gates `truncateAllTables`/`withTransaction`, so a client that
  hasn't passed the isolation check cannot be used destructively even by a programming
  mistake elsewhere in test code.

A future backup/restore implementation should follow the same shape: prove identity first
(reusing or closely mirroring one of the above, not reinventing URL-parsing/comparison
logic), and gate every destructive step behind that proof — never behind a flag or
convention alone.

---

## 4. Backup artifact naming convention (implemented: `scripts/database/lib.mjs`/`backup.mjs`)

```
<environment>_<purpose>_<utc-timestamp>.<format-extension>
```

- `<environment>`: `demo` (matches the `DATABASE_URL` / `mona-jacinta-demo` project) — the
  intended routine backup source. `test` is also accepted by `backup.mjs` — used only for the
  §11 validation drill, so the drill's destructive restore never has to move DEV/demo data
  across environments — not because TEST has ongoing backup value in its own right (§1/§6).
  `prod` remains rejected outright: production does not exist yet.
- `<purpose>`: a short tag for why the backup was taken — `manual`, `pre-migration`,
  `scheduled` (scheduling itself is not implemented — see §10), or `drill` (used for §11).
- `<utc-timestamp>`: `YYYYMMDDTHHMMSSZ` (UTC, sortable, unambiguous — never local time, never
  a value that depends on the operator's timezone). Real example produced in §11:
  `test_drill_20260912T175121Z.dump`.
- `<format-extension>`: `.dump` for `pg_dump` custom format (see §5).

Example (illustrative — not a real produced artifact): `demo_pre-migration_20260401T140500Z.dump`.

**Never** include a hostname, project ref, database name beyond the fixed `<environment>` tag,
username, or any part of a connection string in the filename. The filename is metadata about
*when and why*, never *where* or *who*.

Every artifact is accompanied by a `.sha256` sidecar file (§9) with the same base name:
`demo_pre-migration_20260401T140500Z.dump.sha256`.

---

## 5. Backup format decision (implemented, confirmed)

**Decision: PostgreSQL custom format (`pg_dump --format=custom`), not plain SQL, not
directory format.**

Rationale:
- Custom format is compressed by default (unlike plain SQL) and supports selective/parallel
  restore via `pg_restore`, which plain SQL dumps do not.
- A single-file artifact (`.dump`) is simpler to name, checksum, and store than the
  directory format's multi-file layout, at this project's current data volume.
- `pg_restore` (not `psql`) is required to restore a custom-format dump — both are now
  installed (§0).

Actual `pg_dump` invocation, as implemented in `scripts/database/backup.mjs`:

```
pg_dump --format=custom --no-owner --no-acl --schema=public --file=<tmp-path> <database-name>
```

- `--no-owner --no-acl`: Supabase-hosted roles are not superuser and do not own every
  object; omitting owner/ACL statements avoids restore failures against a target whose role
  doesn't match the dump-time role.
- **`--schema=public` was found necessary during the real drill, not merely anticipated.**
  An unscoped dump of the Supabase-hosted TEST database includes six cluster-level event
  triggers Supabase provisions and owns as `supabase_admin`
  (`pgrst_ddl_watch`/`pgrst_drop_watch` for PostgREST's schema-cache notifications, plus
  `issue_pg_graphql_access`/`issue_pg_net_access`/`issue_pg_cron_access`/
  `issue_graphql_placeholder`) — event triggers are not schema-scoped, so they are captured by
  a full-database dump even with `--no-owner`. Restoring that unscoped archive with
  `--clean --if-exists` then fails outright (`pg_restore: error: could not execute query:
  ERROR: must be owner of event trigger pgrst_drop_watch`), because the connecting role isn't
  `supabase_admin` and can't drop an object it doesn't own. Scoping the dump to
  `--schema=public` (confirmed via `pg_restore --list` on both a scoped and unscoped archive)
  excludes these entirely while still capturing every application table, including
  `_prisma_migrations` — this project's schema lives entirely in `public`, so nothing is lost.
- Credentials are **never** passed as a literal connection-string argument. `pg_dump`/
  `pg_restore` are invoked via `node:child_process.spawn` with an argument array (no shell),
  and `PGHOST`/`PGPORT`/`PGDATABASE`/`PGUSER`/`PGPASSWORD`/`PGSSLMODE=verify-full`/
  `PGSSLROOTCERT=<bundled CA path>` are set as that child process's environment only —
  never the parent process's environment, never printed, and any captured stderr/stdout is
  redacted for the host/user/password substrings before being included in an error message.
  Only the (non-secret) database name — always `postgres` for this project's Supabase
  projects — appears as a literal argument.
- The **Session pooler (`:5432`)** connection already selected for this project
  (`docs/development/database.md` §5) is **confirmed working** for both `pg_dump` and
  `pg_restore` in the real drill (§11) — it behaves like a normal long-lived session, unlike
  the Transaction pooler on `:6543`.

---

## 6. Backup creation procedure (implemented: `scripts/database/backup.mjs`)

`node scripts/database/backup.mjs --target=<demo|test> [--purpose=<manual|pre-migration|scheduled|drill>]`

1. `--target` is **required** and must be exactly `demo` or `test` — no default, no
   fallback. (`prod` is rejected: production does not exist yet, per §2.)
2. Calls `proveIdentities()` (§3 — the same function `npm run db:check` uses) to verify DEV
   and TEST are both reachable and provably distinct before doing anything else. Any failure
   here aborts with no dump attempted.
3. Computes the artifact name per §4 (`<target>_<purpose>_<UTC-timestamp>.dump`).
4. Runs `pg_dump --format=custom --no-owner --no-acl --schema=public` (§5) against the
   resolved target's URL, writing to a `.tmp` path inside the gitignored `backups/database/`
   directory (§9), never a tracked path.
5. Renames `.tmp` → final path only on success; a failed `pg_dump` leaves no partial artifact
   (the `.tmp` file is deleted).
6. Computes and writes the SHA-256 `.sha256` sidecar (§9) immediately after the rename.
7. Prints only redacted metadata: target, purpose, artifact name, size in bytes, checksum —
   never a connection string, host, username, or password. Any `pg_dump` failure message has
   those same values redacted before being printed.

**§2's original design (DEV as the only backup source, TEST never a source) still holds for
routine backups.** The `test` target exists because Phase 0C's validation drill deliberately
backs up and restores TEST only, so the destructive drill never copies real DEV/demo data
across environments (§11) — it is not a statement that TEST backups have ongoing operational
value beyond the drill (§1 still applies: TEST is fully reproducible from seed + migrations).

## 7. Restore procedure (implemented: `scripts/database/restore.mjs`)

`node scripts/database/restore.mjs --target=test --file=<path-to-.dump>`

1. `--target` must be **exactly** `test` — any other value (including `demo`) is rejected
   immediately, before any database is touched. There is no automated path to restore into
   DEV or a future production target; this is enforced in code, not by convention.
2. `--file` is required and must point to an existing artifact with an existing `.sha256`
   sidecar next to it — missing either fails closed before any identity check.
3. Calls `proveIdentities()` (§3), identically to backup — refuses to proceed on any
   ambiguity.
4. Verifies the artifact's SHA-256 against its sidecar (§9) — a mismatch aborts before
   `pg_restore` ever runs.
5. Runs `pg_restore --list` against the archive (reads the table of contents only, touches no
   database) and requires at least one `TABLE DATA` entry — proves the archive is readable
   before the destructive step.
6. Runs `pg_restore --format=custom --no-owner --no-acl --clean --if-exists --exit-on-error
   --single-transaction --dbname=<database>` against the proven TEST connection only, using
   the same non-shell, env-var-only credential handling as backup (§5).
7. Runs post-restore verification (§8); any failure there is reported as an overall restore
   failure, not a passed restore with a caveat.

**Never restore into DEV or a future production target.** This is a hard rejection in
`restore.mjs` (step 1), not a documented convention someone could bypass by passing a
different flag value.

## 8. Restore verification (implemented, real result in §11)

**Revised during the Phase 0C final safety review** — the original implementation checked a
hand-picked 7-table subset against hardcoded expected counts (workable only because the drill
happened to back up a freshly-reset deterministic baseline). That doesn't generalize: a real
backup can legitimately be taken from a database with business rows in `Sale`/`CashSession`/
etc., and hardcoding "expected" counts for those would either be wrong or would have to
invent a number for state that is intentionally variable. Replaced with a manifest-based
fingerprint that never invents anything:

- `backup.mjs` captures row counts for **every table in the `public` schema** (discovered
  dynamically via `pg_tables`, not a hand-picked list — 22 tables today: all 21 application
  tables plus `_prisma_migrations`) from the **source** database immediately after the dump,
  and writes them to `<artifact>.counts.json` alongside the `.sha256` sidecar. If this capture
  fails, the whole backup is discarded (artifact + sidecar deleted) rather than left as a
  partially-verifiable success.
- `restore.mjs` **requires** that manifest to exist (fails closed before touching TEST if it's
  missing or unparseable — confirmed: restoring the pre-this-revision drill artifact, which
  predates the manifest, correctly fails with "artifact has no .counts.json manifest") and,
  after `pg_restore` returns success, re-queries the exact same tables against the restored
  TEST database and requires an **exact match** against the manifest — i.e. "the restore
  reproduced what was actually backed up," not "the restore matches some hardcoded
  expectation." This covers all 22 tables, not 7, without ever inventing a count.
- Separately, `prisma migrate status` is run against the restored TEST target (via a
  `DATABASE_URL` environment override scoped to that one child process only — the same
  pattern `api/tests/seed.test.ts` already uses to point the Prisma CLI at TEST, not a second,
  competing resolution path per `docs/development/migrations.md` §3) and requires its output
  to actually contain "up to date" — an exit code of 0 alone is never treated as success. Its
  output is redacted (§9) before ever appearing in an error message, since the child's
  `DATABASE_URL` is the real TEST connection string.

This was validated non-destructively (not by repeating the destructive restore drill): a
fresh, read-only `db:backup --target=test --purpose=drill` after this change produced a
22-table manifest against the live TEST database with the exact expected values (all business
tables at 0, all seed-fixed tables matching §14's known baseline, including `UserBranchRole`
at 9 — 6 for ADMIN's all-branch assignment + 1 each for the other three demo users — which the
prior 7-table check didn't even cover). The restore-side comparison is the same
`tableRowCounts` query the backup side already exercised live, just pointed at TEST post-
restore instead of pre-dump; re-running the full destructive drill to prove this specific
generalization was judged unnecessary risk for a change that doesn't touch `pg_restore`'s
flags or ordering (§5/§7 unchanged) — it will be exercised for real the next time this tooling
performs an actual restore.

## 9. Artifact storage rules, checksum/integrity verification, and secret handling

- **Backup files are never committed.** `backups/` was added to `.gitignore` before
  `backup.mjs` ever wrote an artifact to `backups/database/`; confirmed with `git status
  --short --ignored` and `git check-ignore -v` against a real produced artifact (§11).
- **Checksums**: every artifact gets a SHA-256 sidecar (`<artifact>.sha256`, plain text,
  standard `sha256sum`-compatible format — cross-checked against the system `sha256sum`
  binary in §11 and byte-identical) computed immediately after creation and verified
  immediately before restore. A checksum mismatch is a hard failure (§15) — never a warning.
- **Secrets**: never printed, logged, embedded in filenames, embedded in checksums'
  surrounding text, or written into this document. This repeats
  `docs/development/migrations.md` §3's rule verbatim because it is the same rule applied to
  a new surface (backup tooling) — it is not a new decision. `runPgTool` in
  `scripts/database/lib.mjs` redacts the connection's password/host/username out of any
  captured `pg_dump`/`pg_restore` output before it can appear in an error message.
  **Found and fixed during the Phase 0C final safety review:** `restore.mjs`'s `prisma
  migrate status` invocation sets that child process's `DATABASE_URL` to the real TEST
  connection string (§8) — if that command ever failed (a malformed-URL error, an
  unreachable-host message, etc.), its captured stdout/stderr was being embedded in the
  failure message **unredacted**, unlike every `pg_dump`/`pg_restore` failure path. This never
  fired in the successful drill (§11) — the invocation always succeeded — but was a genuine
  latent secret-exposure path on the failure branch. Fixed by routing that output through the
  same `redact()` helper before it can reach `fail()`/stderr; the post-restore row-count
  failure path (`tableRowCounts`, §8) was given the same treatment for consistency, since a
  `pg` client connection error can include the target host in its message (e.g. a network-
  level `ENOTFOUND`).
- **Do not invent an encryption-at-rest claim.** No encryption of backup artifacts is
  implemented in this phase. If encryption-at-rest is later required, that is a distinct,
  explicitly-scoped addition — this document does not claim artifacts are encrypted merely
  because they contain sensitive data; treat the backup directory itself as sensitive and
  access-controlled by ordinary filesystem permissions and by never being committed.

## 10. Retention guidance (designed)

No automated retention/rotation policy is implemented in this phase (that would require the
backup tooling from §§4–7 to exist first). Guidance for whoever implements it:
- Keep enough recent backups to cover the realistic window between a migration's ADD stage
  and its VERIFY stage (`docs/development/migrations.md` §5) — i.e., long enough that a
  problem discovered during VERIFY can still be recovered from a pre-migration backup.
- Prefer explicit, operator-triggered backups tied to migration phases (a `pre-migration` tag,
  §4) over a blind time-based rotation, at this project's current scale.
- Scheduling (cron, CI, etc.) is explicitly not designed here.

---

## 11. Recovery drill checklist — real result

Run once, for real, in this phase, entirely against TEST (DEV was never written to):

- [x] `pg_dump`, `pg_restore` confirmed installed (17.11) and version-compatible with
      PostgreSQL 17.x (DEV and TEST both confirmed 17.x via `npm run db:check`).
- [x] DEV and TEST identities re-verified distinct immediately before the drill (`npm run
      db:check` → `distinct identities proven: yes`, signals: `username, inet_server_addr`).
- [x] TEST was reset to the deterministic seed baseline first (`resetDemo` via
      `openSeedDatabase('test')`, the same existing seed code audited in §13 — no new seed
      tooling was written for this), establishing the known starting state the drill needed.
- [x] A backup was created **from TEST** (§6's documented deviation — chosen specifically so
      the destructive drill never copies DEV/demo data into TEST) via
      `node scripts/database/backup.mjs --target=test --purpose=drill`:
      artifact `test_drill_20260912T175121Z.dump`, 58331 bytes,
      sha256 `9fd3f249673305e690b0dbb62c231dba071a80b3e6903549927f3d4724449387`.
- [x] The backup's checksum was verified: the printed sha256 matches the system `sha256sum`
      of the artifact byte-for-byte, and separately matches the `.sha256` sidecar restore.mjs
      itself checked before restoring.
- [x] Archive readability was verified with `pg_restore --list` before the destructive step
      (per §7 step 5) — the archive's table of contents listed all 21 application tables plus
      `_prisma_migrations` as `TABLE DATA` entries, with **zero** `EVENT TRIGGER` entries
      (confirmed by comparing an unscoped test dump against the `--schema=public` dump — see
      §5's recorded finding).
- [x] The backup was restored into TEST **only**, per §7, after re-proving TEST's identity via
      the same `proveIdentities()` call: `node scripts/database/restore.mjs --target=test
      --file=backups/database/test_drill_20260912T175121Z.dump`.
- [x] Post-restore verification (§8) passed: row counts
      `{"Branch":6,"Role":4,"Permission":12,"User":4,"ProductVariant":6,"Inventory":36,
      "RolePermission":32}` matched the deterministic seed baseline exactly, and
      `prisma migrate status` against the restored TEST target reported the schema up to date.
- [x] TEST was left in a known deterministic state: `api/tests/seed.test.ts` was re-run
      against the just-restored TEST database and passed 9/9 (§14), which both re-validates
      seed invariants against the restored data and leaves TEST at its own deterministic
      baseline as that suite's normal lifecycle already does.
- [x] DEV was never connected to for any write during this drill — only read by
      `proveIdentities()`'s identity/reachability check, exactly as `npm run db:check` already
      does routinely.

**Result: PASS.** One real deviation from the original design was found and fixed during the
drill, not discovered after the fact: an unscoped `pg_dump` captures Supabase-owned,
non-schema-scoped event triggers that a non-superuser restore role cannot drop, which made the
very first restore attempt fail with `must be owner of event trigger pgrst_drop_watch`.
`--schema=public` (§5) resolved it and is now the implemented, permanent invocation — not a
one-off workaround applied only for this drill.

---

## 12. Deterministic seed requirements

Production V1's roadmap requires the demo/dev seed to be deterministic. The following
properties are required, and are audited against the existing implementation in §13:

- Repeated seeding from the same starting state produces the same logical dataset.
- Stable identifiers where tests/demo depend on them.
- No uncontrolled randomness in business-identifying data.
- No wall-clock-dependent business state unless explicitly normalized to a fixed value.
- No network/API dependency beyond the database connection itself.
- No secrets embedded in seed data.
- No environment-crossing writes (a demo-seed operation must never be reachable against
  TEST or a future production target, and vice versa).

## 13. Audit of the existing seed implementation

`api/prisma/seed.ts`, `api/scripts/demo-database.ts`, `api/scripts/seed-demo.ts`,
`api/scripts/reset-demo.ts` were read in full for this phase. Findings, against §12:

| Requirement | Status | Evidence |
|---|---|---|
| Repeatable, identical logical dataset | **Met** | Every row is `upsert`ed against a fixed, deterministic id (see next row) — re-running `seedDemo` is a no-op on already-seeded data, not an accumulation. Confirmed by a real test run in this phase (§14). |
| Stable identifiers | **Met** | `id(n) = '00000000-0000-4000-8000-' + zero-padded n` — every permission, role, branch, counter, register, user, category, brand, product, variant, and inventory row gets a fixed, code-derived UUID; nothing uses `@default(uuid())`'s random generation during seeding. |
| No uncontrolled randomness in business data | **Met, with one explicit, deliberate exception** | All business/identity fields are fixed. The **bcrypt password hash salt** is randomly generated on every seed run (`hash('demo123', 12)`) — this is intentional and documented in-line ("Random bcrypt salts are deliberate; only business values/identities are deterministic"): the hash *value* differs between runs, but it always validates the same fixed password (`demo123`), so it never affects what the deterministic-seed guarantee actually needs to hold (login behavior, not byte-for-byte hash equality). The existing test suite confirms this correctly (`compare('demo123', user.passwordHash)`), not a raw hash-string comparison. |
| No wall-clock-dependent business state | **Met** | `timestamp` is a fixed literal (`new Date('2026-01-01T00:00:00.000Z')`), used for every seeded row's `createdAt`/`updatedAt` — not `new Date()`/`now()`. |
| No network/API dependency | **Met** | `populate`/`clear`/`run` in `seed.ts` only issue Prisma queries against the already-open connection; no external calls. `openSeedDatabase` itself only opens database connections (TLS to Supabase) — no third-party API calls. |
| No secrets in seed data | **Met** | The only credential-shaped value is the shared demo password (`demo123`), explicitly a public, non-secret, demo-only value per its own naming and the plan that requested it — not a real credential. |
| No environment-crossing writes | **Met** | `openSeedDatabase(target)` requires `NODE_ENV==='test'` for the `'test'` target and refuses a `'demo'` target when `NODE_ENV` is set to anything other than `'development'`; `readDemoTargets()` reads both URLs from the untracked `.env.development` and refuses to proceed if they're equal; any shell-exported `DATABASE_URL`/`TEST_DATABASE_URL` that disagrees with the local file is rejected outright. `assertNoOperations` additionally refuses to reseed over a database that already has real business activity (`Sale`, `CashSession`, `StockMovement`, `StockReservation`, `AuditLog` rows), separating "seed a fresh demo" from "silently overwrite in-progress data." |

**No changes were made to seed.ts, demo-database.ts, seed-demo.ts, or reset-demo.ts.** The
existing implementation already satisfies every property in §12; per this phase's own
instruction to make only minimal changes required for determinism/safety, and since none
were required, none were made.

## 14. Seed reproducibility — validation result (real, performed in this phase)

`api/tests/seed.test.ts` was run in isolation (`npx vitest run tests/seed.test.ts`, from
`api/`) against the real, isolated TEST database, after its own setup
(`assertTestDatabaseIsolation`) proved TEST distinct from DEV. Result: **9/9 tests passed**.
It was run twice in this phase: once before any backup/restore tooling existed (the original
audit), and once more immediately after the §11 restore drill, against the just-restored TEST
database — 9/9 both times, with no seed code changes in between. Specifically:

- **"seeds twice without duplicates and preserves deterministic business data"** — takes a
  full logical snapshot (users, branches, variants, inventory, counters, in insertion-stable
  `orderBy: { id: 'asc' }` order, with `BigInt` normalized to string for comparison), calls
  `seedDemo` twice, and asserts the second snapshot is byte-for-byte identical (`JSON`) to the
  first. This is the literal "compare logical database state, not just command exit codes"
  requirement, exercised for real, not simulated.
- Exact branch list/order, exact user/role/branch-assignment matrix, exact permission set (12)
  and role-permission matrix (32 rows), exact BigInt prices for at least two named variants,
  exact inventory counts (36 = 6 variants × 6 branches) and invariants (`reserved === 0n`,
  `physical >= 20n`).
- Rollback-on-failure: an injected mid-transaction failure during `resetDemo` leaves the
  prior `User` rows and dependent counts (`inventory`, `rolePermission`) completely
  unchanged — proving the seed transaction is atomic, not partially applied on error.
- `seedDemo` refuses to run over a database with real business operations present (a `Sale`
  row), and `resetDemo` correctly removes that sale and its items while restoring the
  deterministic baseline (inventory count, counter `nextValue` reset to `1`).

This is genuine, executed validation, not a description of expected behavior. It required no
code changes to pass.

---

## 15. Destructive-operation safeguards (summary)

Every destructive path already in the repository, and every one designed in this document,
shares the same shape — restated here as the single governing rule for this document:

1. Identity of the target must be **proven**, not assumed, immediately before the
   destructive action (§3).
2. The proof must show the target is the *specific* environment the operation is scoped to
   (TEST for `truncateAllTables`/restore-drill; DEV/demo for `resetDemo`/backup-source) —
   never "any non-production-looking database."
3. A client/connection that has not passed that proof must be structurally incapable of
   performing the destructive action (`provenClients` WeakSet pattern in
   `test-db.ts` is the existing model; any new destructive tooling should follow the same
   shape rather than relying on convention alone).
4. Failure at any stage (§16) stops the operation — it never "continues anyway."

## 16. Rollback vs roll-forward relationship

`docs/development/migrations.md` §23 states the governing principle and explicitly defers its
implementation to this phase. Restated and completed here:

- **Roll-forward is preferred** for problems discovered after a migration's SWITCH stage,
  because the compatibility lifecycle (ADD→BACKFILL→VERIFY→SWITCH→DEPRECATE→REMOVE) keeps
  the prior representation alive through DEPRECATE — reverting the application's read/write
  switch is usually sufficient and does not require touching the database at all.
- **Restore (this document's §§4–11) is the appropriate tool** when the *data itself* — not
  just the application's chosen representation — has been corrupted or lost (a bad backfill,
  a premature REMOVE, an operator mistake), and roll-forward has no data left to point back
  to.
- **Restore point assumptions**: a restore rolls the *entire* target database back to the
  artifact's creation time — it cannot selectively undo one table's changes while preserving
  others. Any business activity recorded between the backup's creation and the restore is
  lost for that target. This is why restore is designed here only against TEST (freely
  reproducible, no real business data) and explicitly not against DEV/production as an
  automated path (§6/§7) — a DEV/production restore is a manually-supervised
  incident-response decision that accepts this data-loss tradeoff consciously, not a routine
  automated operation.
- **Database + application compatibility after a restore**: a restored database reflects
  schema state as of the backup's creation time, which may be *behind* the application code
  currently deployed if migrations have run since. Any restore must be followed by checking
  `prisma migrate status` (§8) and applying any pending migrations via `prisma migrate
  deploy` (`docs/development/migrations.md` §4) before the restored target is considered
  usable again — never assume the restored schema already matches current application
  expectations.
- **Migration-history considerations after restore**: `_prisma_migrations` itself is part of
  what gets restored — if the backup predates a migration that has since been applied, the
  restored target's migration history is genuinely behind, and `migrate deploy` is the
  correct, ordinary way to catch it up (never a manually-edited `_prisma_migrations` row).
- **Explicit prohibition**: this document does not define, and no future casual addition
  should introduce, hand-written "down" migrations (reverse DDL) as a rollback mechanism.
  Prisma does not generate down-migrations, and inventing one to "support rollback" would
  reintroduce exactly the kind of untracked, unreviewed schema change
  `docs/development/migrations.md` §2/§25 forbids. Reversing a schema change, if ever truly
  necessary, is its own new, forward-moving, reviewed migration — never a fabricated reverse
  script.

## 17. Failure policy

Same fail-closed posture as `docs/development/migrations.md` §22, applied to backup/restore
specifically. Fail closed, always, on:

- wrong or ambiguous target (identity not provably distinct/correct per §3)
- missing `pg_dump`/`pg_restore` (the state this document was originally written under,
  before client tooling was installed — see §0)
- a checksum mismatch on the artifact being restored
- an incomplete/interrupted dump (no partial artifact is ever left at the final path — write
  to a temp path, rename only on success)
- post-restore verification (§8) failing
- any attempt to restore into DEV or a future production target through the automated path

"Continue anyway" is never acceptable here either — the correct response is always to stop,
report exactly what failed, and let a human decide the next step.

## 18. Operator checklist

Before running any backup:
- [ ] `pg_dump` confirmed installed and version-appropriate.
- [ ] DEV identity verified distinct from TEST (`npm run db:check`).
- [ ] Backup destination directory exists and is gitignored.

Before running any restore:
- [ ] `pg_restore` confirmed installed and version-appropriate.
- [ ] Target is explicitly TEST — never assumed, never defaulted.
- [ ] TEST identity re-verified distinct from DEV immediately before the restore.
- [ ] Artifact checksum verified against its `.sha256` sidecar.
- [ ] Post-restore verification plan (§8) is ready to run immediately after restore.
- [ ] No secrets will be printed at any step (dry-run the command's expected output mentally
      before running it against a real target).
