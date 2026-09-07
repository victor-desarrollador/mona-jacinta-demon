# Mona Jacinta API — Task 3 bootstrap

Independent ESM npm package. Verified with Node **22.23.2**, npm **10.9.8** and
Prisma **7.10.0**. Use that Node version for development (ESLint 10 requires at least
Node 22.13 on the Node 22 line). Exact dependency versions are in `package.json`
and `package-lock.json`.

## Local setup

Run these commands from `api/`:

```sh
npm ci
npm run db:generate
npm run dev
```

Keep real values only in the existing repository-root `../.env.development`.
Use `api/.env.example` as a variable reference; do not create `api/.env` or copy
database credentials. Add your own random `JWT_SECRET` (at least 32 characters),
`JWT_ACCESS_TTL_SECONDS` and `CORS_ORIGINS` to the root development environment.
`API_PORT` defaults to 3001. Example placeholder secrets are rejected.

Development loads that root file relative to the module, independent of the current
directory. Existing process environment values always win. Production and tests use
process environment only. Configuration errors report variable names, never values.
Tests supply synthetic configuration and make no PostgreSQL connections.

`GET http://localhost:3001/health` returns `200 {"status":"ok"}`. The health endpoint
does not check the database. Socket.IO uses this same HTTP server; it has no domain
events, branch rooms or authentication integration yet. JWT middleware verifies
HS256 access tokens with `sub`, `iat` and `exp`, attaches only `userId`, and leaves
database authorization to later tasks.

## Prisma and TLS

`prisma.config.ts` owns the datasource URL. The schema contains only the ESM client
generator and PostgreSQL datasource, with no models or migrations. The generated
TypeScript client lives in ignored `src/generated/prisma/`; build emits it into
ignored `dist/generated/prisma/`.

The plain singleton uses `PrismaPg` with `pg` pool configuration and
`ssl: { rejectUnauthorized: true, ca }`. Both source and compiled execution load
the existing root `scripts/certs/supabase-prod-ca-2021.crt`; the CA is not duplicated.
Hostname verification remains enabled. Environment validation rejects TLS URL query
options that could replace the explicit SSL configuration. URLs are never rewritten.
See the approved [database safety documentation](../docs/development/database.md).

Only `prisma validate` and `prisma generate` are Task 3 CLI operations. The
`db:push`, `db:migrate`, `db:seed` and `db:studio` scripts are future entrypoints;
they were not executed. Seed configuration/implementation is intentionally absent.
Task 4 owns domain models and the first migration.

## Verification

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run db:generate
npx prisma validate
```

`npm start` runs compiled `dist/server.js`. SIGINT/SIGTERM close Socket.IO, HTTP and
Prisma, with a bounded shutdown timeout. On Windows, verify the `tsx watch` parent
also exits when stopping `npm run dev`; stopping only its server child allows a
later file change to restart the server.

`.eslintrc.cjs` is an explicit **flat-config** entrypoint for ESLint 10; the lint
script selects it with `--config`. Runtime TypeScript imports use relative `.js`
paths; the `@/*` mapping does not require a runtime alias loader.

Task 3 verification recorded:

- RED: health and JSON tests failed because their implementation modules did not exist.
- GREEN: 47 tests passed, including health, BigInt/Date serialization, JWT rejection
  cases, environment/TLS-option validation and sanitized errors.
- Dev health: HTTP 200; Socket.IO polling handshake on the same port: PASS.
- Exactly one Prisma `SELECT 1` against development/demo, from compiled output: PASS.
  The underlying pg socket was encrypted and authorized. No database writes occurred.
- Root `npm run db:check`: PASS with both connections authorized and distinct identities.
- Local JWT/CORS settings were missing during verification. Server checks used a
  temporary random signing key and other process-only settings; no secrets were saved.

Dependency review: `npm audit` reports findings through the explicitly pinned
Prisma 7.10.0 tooling: `deepmerge-ts` 7.1.5
([recursive merge exhaustion](https://github.com/advisories/GHSA-ggr8-5vv4-36mx)) and
`mysql2` 3.15.3
([authentication downgrade](https://github.com/advisories/GHSA-3f6p-5ww8-9rcr),
[compressed protocol exhaustion](https://github.com/advisories/GHSA-rgwj-5xj2-c3m3)).
This bootstrap uses static Prisma configuration and the PostgreSQL adapter; it
does not connect to MySQL. Findings remain for dependency review. No forced audit
fix, transitive major-version override or change to the mandated Prisma version
was applied.
