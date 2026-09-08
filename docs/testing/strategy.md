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

## Manual E2E Verification

The complete Seller -> Cashier -> Admin scenario was manually verified using separate browser sessions after a deterministic demo reset.

Reference: [`../development/demo-e2e-verification.md`](../development/demo-e2e-verification.md)
