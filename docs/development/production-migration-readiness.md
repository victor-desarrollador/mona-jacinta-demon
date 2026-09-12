# Production V1 Migration Readiness (Phase 0D Gate)

Evidence snapshot recorded 2026-09-12 at Git checkpoint `ed2300b` on
`feat/production-v1`. This document is a readiness record, not an
architecture document — see the frozen sources it links to for design
detail.

## 1. Phase 0A — Baseline verification

Status: **PASS**, evidence in [`../testing/strategy.md`](../testing/strategy.md).

- Test files: 25/25 passed
- Tests: 232/232 passed, 0 failed, 0 skipped
- API lint / typecheck / build: PASS
- Client lint / TypeScript / build: PASS
- Admin lint / build: PASS
- Full-suite wall clock: `real 34m18.065s` (documented; not a ritual re-run target)

## 2. Phase 0B — Migration safety conventions

Status: **PASS**, evidence in [`migrations.md`](./migrations.md).

- ADD → BACKFILL → VERIFY → SWITCH → DEPRECATE → REMOVE lifecycle defined (§ "ADD → BACKFILL...").
- Prisma migration discipline defined; `DATABASE_URL` is the single resolution path for the Prisma CLI (no competing target resolution).
- Raw-PostgreSQL strategy defined for CHECK constraints (§12/§"CHECK constraints"), partial unique indexes (§"Partial UNIQUE indexes", existing `cash_session_one_open_per_register` precedent), and `NULLS NOT DISTINCT` (§15).

## 3. Phase 0C — Backup / restore / deterministic seed

Status: **PASS**, evidence in [`backup-restore-seed.md`](./backup-restore-seed.md).

- Backup tooling: `scripts/database/backup.mjs` (targets `demo`/`test`, purposes `manual`/`pre-migration`/`scheduled`/`drill`).
- Restore tooling: `scripts/database/restore.mjs` — hard-restricted to `--target=test` (`restore.mjs:27-28`); refuses DEV/demo/production restore.
- Backup artifacts ignored: `backups/` in `.gitignore`.
- SHA-256 checksum sidecar per artifact; mismatch is a hard failure, never a warning.
- Fail-closed identity checking present in both `check-databases.mjs` and `restore.mjs` (throws/exits rather than proceeding on ambiguous identity).
- Deterministic seed validated before and after the restore drill (`api/tests/seed.test.ts`, 9/9 passing both times).
- A real backup → checksum → restore → verify drill was executed against TEST only; DEV/demo was never touched. Findings from the drill (e.g. `--schema=public` necessity) are folded into the tooling and doc.

This gate did **not** rerun the destructive restore drill, per instruction.

## 4. Current Git checkpoint

- Branch: `feat/production-v1`
- HEAD: `ed2300b` — "feat: add safe database backup and restore workflow"
- Working tree: clean at gate entry

## 5. DEV/TEST DB readiness

`npm run db:check` output:

```
[db:check] OK
  DEV/DEMO reachable: yes
  TEST reachable: yes
  TLS certificate and hostname verification: enabled (both connections authorized)
  PostgreSQL versions: DEV=17.x TEST=17.x
  distinct identities proven: yes
  signals used: username, inet_server_addr
```

Local client tool versions (major 17 required, confirmed):

- `pg_dump (PostgreSQL) 17.11 (Debian 17.11-0+deb13u1)`
- `pg_restore (PostgreSQL) 17.11 (Debian 17.11-0+deb13u1)`
- `psql (PostgreSQL) 17.11 (Debian 17.11-0+deb13u1)`

## 6. Migration baseline

- `api/prisma/schema.prisma` is still the Demo V2 baseline: `Branch` / `UserBranchRole` present; no `Company`, `Location`, `LocationType`, or `UserRoleScope` models exist yet.
- `api/prisma/migrations/`: exactly one migration, `20260907015311_init`; `migration_lock.toml` present; no uncommitted/dirty changes under `api/prisma/` (`git status --short api/prisma/` empty).
- `npx prisma validate` — schema valid.
- `npx prisma migrate status` (against `DATABASE_URL`, the approved DEV target per `migrations.md`) — **"Database schema is up to date!"**. Read-only command only; no `migrate dev`/`deploy`/`db push`/`reset` run.

## 7. Delta since f10cffe (last full-suite checkpoint) and suite-rerun decision

`git diff --name-status f10cffe..HEAD`:

```
M  .gitignore
A  docs/development/backup-restore-seed.md
A  docs/development/migrations.md
M  package.json                         (adds db:backup / db:restore scripts only)
M  scripts/check-databases.mjs
A  scripts/database/backup.mjs
A  scripts/database/lib.mjs
A  scripts/database/restore.mjs
```

None of these touch API runtime/domain behavior, `schema.prisma`, migrations, test files, or frontend runtime code. All changes are documentation and standalone database-tooling scripts outside the application/test code paths.

**Decision: full 34-minute integration suite rerun is NOT required.** The 232/232 evidence from Phase 0A-R1 remains applicable. This gate instead ran the focused validations below (Step 5) plus Phase 0C's own drill evidence.

## 8. Fast quality gates (this session)

- `api` lint: PASS (0 warnings, `--max-warnings 0`)
- `api` typecheck: PASS
- `api` build: PASS
- `node --check scripts/check-databases.mjs`: OK
- `node --check scripts/database/lib.mjs`: OK
- `node --check scripts/database/backup.mjs`: OK
- `node --check scripts/database/restore.mjs`: OK

## 9. Branch → Location compatibility readiness

Frozen source: [`../production-v1/06-erd-data-model.md`](../production-v1/06-erd-data-model.md) §LOCATION/COMPANY/USER_ROLE_SCOPE, [`../production-v1/08-implementation-roadmap.md`](../production-v1/08-implementation-roadmap.md) PHASE 1A/1B/1C.

Confirmed lifecycle matches the expected pattern:

1. **PHASE 1A** (this gate's next phase): ADD `Company` + `Location` (+ `LocationType`) — additive only, `ALTERED: none`. BACKFILL Branch → Location. VERIFY counts/mapping. SWITCH is scoped to the new company/location backend services, not to production-facing authorization or frontend (`RBAC/security: none`, `Frontend: none` per roadmap). `Branch` is **not removed** in 1A.
2. **PHASE 1B**: new Role/Permission/UserRoleScope tables (no migration/backfill — net-new).
3. **PHASE 1C**: ADD `UserRoleScope` → BACKFILL from `UserBranchRole` → VERIFY → SWITCH authorization reads/writes → DEPRECATE `UserBranchRole` → REMOVE only after a validated compatibility window.

This is compatible with the ADD→BACKFILL→VERIFY→SWITCH→DEPRECATE→REMOVE convention in `migrations.md`. Nothing here requires redesign.

## 10. Feature flag decision for Phase 1A

**No feature flag is required for Phase 1A.**

Phase 1A is additive-only schema (new `Company`/`Location`/`LocationType`, `ALTERED: none`), with `RBAC/security: none` and `Frontend: none` per the roadmap. Branch remains the live, authoritative source for existing consumers throughout 1A; nothing user-facing is switched. Additive schema + a backfill/compatibility mapping (Branch → Location) is sufficient on its own — there is no toggle-able behavior change in 1A that a flag would need to guard. (A flag becomes relevant only if/when authorization reads actually switch consumers in Phase 1C; that decision is deferred to that phase's own gate, not invented here.)

## 11. Mandatory Phase 1A pre-migration sequence

Before the first real Phase 1A schema migration is generated or applied:

1. Clean Git checkpoint (working tree clean, intended commit boundary only).
2. `npm run db:check` — confirm DEV/TEST reachable, distinct, TLS-verified, versions as expected.
3. Pre-migration DEV backup: `npm run db:backup -- --target=demo --purpose=pre-migration`.
4. Verify the backup artifact's SHA-256 checksum sidecar before trusting it as a rollback point.
5. Generate the Prisma migration and review the generated SQL by hand (raw-SQL sections per `migrations.md` conventions where Prisma can't express the constraint).
6. Apply and validate against TEST first (`prisma migrate deploy`/equivalent against `TEST_DATABASE_URL`, then `prisma migrate status` confirming up to date) before any wider use.
7. Run backfill and verify row-count/mapping correctness (Branch → Location) against TEST.
8. Run focused tests covering the new schema/backfill path (not necessarily the full 34-minute suite, per the same delta-based judgment used in this gate).
9. No legacy removal: `Branch` stays; only ADD/BACKFILL/VERIFY/SWITCH scope for 1A, per §10 above.

## 12. Security readiness

- No secrets tracked: only `.env.example` / `api/.env.example` templates are in Git; `git ls-files` shows no `.env`, credential, or secret files.
- Backup artifacts ignored (`backups/` in `.gitignore`).
- Destructive restore is hard-restricted to `--target=test` in `scripts/database/restore.mjs` (refuses DEV/demo/production).
- DB identity checks fail closed in both `scripts/check-databases.mjs` and `scripts/database/restore.mjs` (throw/exit on ambiguous or unproven identity rather than proceeding).
- Database connection verification remains strict: TLS required, hostname verification enabled, no TLS-override query params permitted on `DATABASE_URL`/`TEST_DATABASE_URL`.
- RBAC/security implementation remains deferred to its own roadmap phase (1B/1D); not started here.
- No expensive full LLM security review was invoked for this gate, per instruction.

## 13. Remaining risks / blockers

- None blocking. Prisma major-version update notice (7.10.0 → 8.0.0-rc.14) surfaced during `migrate status` is informational only; no action taken or required for this gate.
- Phase 1A's actual migration SQL, backfill script, and verification queries do not exist yet — they are Phase 1A implementation work, correctly out of scope here.
- Feature-flag need for Phase 1C's authorization SWITCH step should be re-evaluated at that phase's own gate, not assumed now either way.

## 14. Final decision

**PHASE 0D PRODUCTION MIGRATION READINESS GO**
