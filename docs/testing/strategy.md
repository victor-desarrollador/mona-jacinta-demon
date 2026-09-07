# Testing Strategy

Demo V2 integration tests use a real PostgreSQL database configured by
`TEST_DATABASE_URL`. It is a physically separate Supabase project from the
development/demo database configured by `DATABASE_URL`.

Before any destructive operation, the test setup requires both targets, compares
their non-secret parsed identities, connects to both read-only, and compares live
database metadata. Failure to prove distinct identities aborts the suite. TLS uses
the versioned Supabase CA with hostname verification enabled.

Database-backed tests truncate business tables before each test through a helper
that accepts only a client created for the proven test target. The schema,
constraints, and `_prisma_migrations` are preserved. Vitest uses
`fileParallelism: false` because all integration files share this one test
database.

Transaction helpers are available for tests that explicitly need transaction
execution, but rollback is not global HTTP isolation: Supertest requests use the
application's independent database connections. HTTP tests therefore rely on
per-test truncation. Destructive helpers never target the development database.