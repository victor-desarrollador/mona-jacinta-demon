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
Bootstrap tests supply synthetic configuration and make no PostgreSQL connections.
The Task 5 seed integration test uses the dedicated test database as described below.

`GET http://localhost:3001/health` returns `200 {"status":"ok"}`. The health endpoint
does not check the database. Socket.IO uses this same HTTP server; it has no domain
events, branch rooms or authentication integration yet. JWT middleware verifies
HS256 access tokens with `sub`, `iat` and `exp`, attaches only `userId`, and leaves
database authorization to later tasks.

## Prisma and TLS

`prisma.config.ts` owns the datasource URL. Task 4 added the 21 domain models and
the initial migration. The generated
TypeScript client lives in ignored `src/generated/prisma/`; build emits it into
ignored `dist/generated/prisma/`.

The plain singleton uses `PrismaPg` with `pg` pool configuration and
`ssl: { rejectUnauthorized: true, ca }`. Both source and compiled execution load
the existing root `scripts/certs/supabase-prod-ca-2021.crt`; the CA is not duplicated.
Hostname verification remains enabled. Environment validation rejects TLS URL query
options that could replace the explicit SSL configuration. URLs are never rewritten.
See the approved [database safety documentation](../docs/development/database.md).

The Prisma migration CLI uses the same CA with its native engine's
`sslmode=require`, `sslaccept=strict`, and `sslcert` options.

## Task 5 demo seed and reset

From `api/`, run `npm run db:seed` to populate/repeat the deterministic seed, or
`npm run db:reset` to delete domain rows in FK order and seed in one transaction.
Stop the API before maintenance. Reset preserves the schema and migration history.
Seed refuses existing sales, cash sessions, stock movements, reservations or audit
history so it cannot silently rewind operational stock/counters; use reset explicitly.

These local maintenance commands read both URLs directly from the ignored root
`.env.development`. They reject conflicting shell URL overrides and non-development
`NODE_ENV`. Before writing, they require the configured Supabase session endpoints,
verified TLS, distinct parsed identities and distinct live server identities. An
unreachable or ambiguous target fails closed. Keep the local file's DEV/TEST labels
correct: configuration is the operator's source of target identity.

Demo logins are `admin@demo.local`, `manager01@demo.local`, `seller01@demo.local`
and `cashier01@demo.local`, all with the public **demo-only** password `demo123`.
Only bcrypt hashes are stored. User-approved point-of-sale metadata is 1–6 in
the documented branch order. ADMIN has all 12 permissions and all six demo branch
assignments; global authorization resolution remains Task 8's responsibility.

Seed creates six variants, 36 inventory rows (20 physical units per branch/variant,
50 at Depósito Central, zero reserved), six registers and six counters starting at 1.
Remera Negro/M costs 4500000 centavos; Jean Azul/42 costs 7500000 centavos, making
the demo sale total exactly 16500000 centavos. IDs and business values are stable;
bcrypt salts intentionally vary. Demo catalog identifiers must not be repurposed.

`npm test` now requires both configured databases for read-only isolation checks.
Only `tests/seed.test.ts` writes, exclusively to TEST. If TEST is empty it applies
the existing initial migration with `migrate deploy` after isolation succeeds;
otherwise it requires matching migration history. It then transactionally clears
and seeds TEST. Do not run concurrent integration-test processes. No global Task 6
test bootstrap, shadow database or development-data test setup is introduced.

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
