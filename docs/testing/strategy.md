# Testing Strategy

Mona Jacinta Demo V2 uses Vitest + Supertest for API integration coverage. The final verification recorded:

- API tests: PASS
- Test files: 25 PASS
- Tests: 232 PASS
- API typecheck: PASS
- API build: PASS
- API lint: PASS
- Client lint: PASS
- Client TypeScript: PASS
- Client build: PASS
- Admin lint: PASS
- Admin build: PASS
- Manual E2E: PASS

No coverage percentage is claimed because coverage was not measured for the final handoff.

## Database Isolation

Demo V2 integration tests use a real PostgreSQL database configured by `TEST_DATABASE_URL`. It is a physically separate hosted Supabase project from the development/demo database configured by `DATABASE_URL`.

Before any destructive operation, the test setup requires both targets, compares their non-secret parsed identities, connects to both read-only, and compares live database metadata. Failure to prove distinct identities aborts the suite. TLS uses the versioned Supabase CA with hostname verification enabled.

Database-backed tests truncate business tables before each test through a helper that accepts only a client created for the proven test target. The schema, constraints, and `_prisma_migrations` are preserved.

Vitest uses `fileParallelism: false` because all integration files share one database. Destructive cleanup is unsafe across parallel workers.

Transaction helpers are available for tests that explicitly need transaction execution, but rollback is not global HTTP isolation: Supertest requests use the application's independent database connections. HTTP tests therefore rely on per-test truncation. Destructive helpers never target the development database.

## Coverage Focus

The suite covers the Demo V2 risks that matter most:

- DB-resolved authorization and branch scope.
- SELLER/CASHIER/MANAGER/ADMIN permission boundaries.
- BigInt serialization and JSON money as decimal strings.
- Product variants and branch inventory availability.
- Draft sale creation and cart mutation.
- Send-to-cashier reservation flow.
- Stock reservation lifecycle.
- Split payments, including partial payments and exact payment to `PAID`.
- Payment idempotency with per-intent keys.
- Cash payment received/change behavior.
- Cash session open/close behavior.
- Sale completion and inventory decrement.
- Serializable transaction behavior and `SELECT FOR UPDATE` locking.
- Duplicate and concurrent completion safety.
- Transaction rollback behavior.
- Audit log persistence.
- Post-commit Socket.IO notification behavior.

Authoritative architectural details are documented in [`../architecture/mona-demo-v2.md`](../architecture/mona-demo-v2.md).

## Running the Suite Locally / Reproducibility

The integration suite talks to real, physically separate, hosted Supabase PostgreSQL
projects (`DATABASE_URL`, `TEST_DATABASE_URL`) — there is no local or Docker PostgreSQL
in this repository (see `docs/development/database.md`). Before running tests:

1. Populate the untracked `.env.development` at the repository root with distinct
   Supabase Session-pooler URLs for `DATABASE_URL` and `TEST_DATABASE_URL` (see
   `.env.example` / `api/.env.example` for the required variable names).
2. Verify both are reachable and provably distinct without touching the test suite:
   `npm run db:check` (repository root). This never prints secret values.
3. Run the suite: `cd api && npm test`.
4. No teardown step is required — the hosted test database is disposable state that
   each test truncates and reseeds itself (`tests/helpers/test-db.ts`); nothing needs to
   be started or stopped locally.

**Measured duration:** because every test's `beforeEach` truncates and reseeds the real
hosted test database over the network, and `fileParallelism: false` runs all files
sequentially (required because integration files share one database — see above), a
full single-shot run of the complete suite was measured end-to-end:

- Test files: 25 passed (25)
- Tests: 232 passed (232), 0 failed, 0 skipped
- Vitest-reported duration: 2057.48s (tests 99%, setup 1%)
- Wall-clock (`time npm test`): real 34m18.065s / user 1m19.067s / sys 0m4.404s
- Exit code: 0

The large difference between wall-clock time and local CPU time is consistent
with an I/O/network-bound integration suite against hosted Supabase PostgreSQL.
No timeout, retry, or
infrastructure failures occurred during this run; do not increase `testTimeout` or
`hookTimeout` without new evidence from an actual failure. Do not treat several minutes
of quiet output as a hang — see the fail-fast note below for how to independently confirm
the databases are reachable while a run is in progress.

**`testTimeout: 60000` / `hookTimeout: 60000` rationale:** integration tests and their
`beforeEach`/`afterEach` hooks perform real round trips (truncate, reseed, query) against
a hosted Supabase database over the network rather than a local database. Vitest's
30000ms/10000ms defaults are tuned for local-disk-speed databases and produced spurious
timeouts against this hosted target. 60000ms was chosen to give real network latency
headroom without masking genuine hangs. No test or hook exceeded the configured 60000ms
timeout during the measured run, so 60000ms was sufficient for the current suite.

**`fileParallelism: false` rationale:** all integration test files share one physical
hosted test database and each test truncates business tables in `beforeEach`. Running
files in parallel workers would let one file's truncation race another file's in-flight
test, corrupting state. Sequential execution is required for correctness, not performance;
it is part of why the full run takes tens of minutes of wall-clock time rather than being
parallelized down.

**Fail-fast on unreachable database:** `assertTestDatabaseIsolation()`
(`tests/helpers/test-db.ts`) and `openSeedDatabase()` (`api/scripts/demo-database.ts`)
both construct their `pg.Pool`s with `connectionTimeoutMillis: 10000`. This has been
verified empirically to bound a genuinely unreachable target (e.g. a non-routable host)
to a clean failure in ~10 seconds with an explicit "connection timeout" error — it does
not hang indefinitely. If `npm test` produces no output for several minutes, the suite is
most likely still running slowly (see above), not stuck; `npm run db:check` is the fast
way to independently confirm both databases are currently reachable.

## Manual E2E Verification

The complete Seller -> Cashier -> Admin scenario was manually verified using separate browser sessions after a deterministic demo reset.

Reference: [`../development/demo-e2e-verification.md`](../development/demo-e2e-verification.md)
