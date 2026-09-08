# Database Hosting and Connection Safety

Status: Approved
Scope: Demo V2 — Supabase PostgreSQL environment (Task 2)
Related: `docs/architecture/mona-demo-v2.md` §18, `scripts/check-databases.mjs`, `.env.example`

---

## 1. Two physically isolated projects

Mona Jacinta Demo V2 uses **hosted Supabase PostgreSQL** only — no local or Docker
PostgreSQL exists anywhere in this repository. Supabase plays the same infrastructure
role MongoDB Atlas played in the legacy Tesis project:

```text
client/admin -> Express (api/) -> Prisma -> Supabase PostgreSQL
```

Two physically separate Supabase projects are provisioned:

| Environment variable | Conceptual Supabase project | Purpose |
| -------------------- | --------------------------- | ------- |
| `DATABASE_URL`       | `mona-jacinta-demo`         | Development and deterministic demo data |
| `TEST_DATABASE_URL`  | `mona-jacinta-test`         | Vitest + Supertest integration tests; destructive `TRUNCATE ... RESTART IDENTITY CASCADE` targets only this database |

The two projects must always remain physically isolated. They are proven distinct by a
multi-signal, fail-closed identity check (see §§5–6) before any destructive operation is
allowed.

---

## 2. Where connection information is obtained

Each project's PostgreSQL connection string is obtained from the Supabase dashboard:

- Open the project in the Supabase dashboard → **Project Settings → Database** (or
  **Connect**).
- Select the **Session pooler** connection string (port `5432`) for each project. Copy it
  into the local, untracked environment file (see §3) under the matching variable name.

Never copy these strings into documentation, `.env.example`, commits, or any file tracked
by Git. `client/` and `admin/` never receive these URLs — they are server-only.

---

## 3. Credentials live only in untracked local env files

`DATABASE_URL` and `TEST_DATABASE_URL` are **server-only** secrets:

- Real values live only in the local, **untracked** `.env.development` file (excluded by
  `.gitignore`).
- `.env.example` contains **placeholder-only** values and a server-only warning — no real
  host, project reference, or password.
- The variables must never be exposed as `NEXT_PUBLIC_*` / `VITE_*` variables and must
  never be reachable from `client/` or `admin/`. Only the `api/` backend may read them.

`.env.development` is **not** loaded automatically by Node.js. `npm run db:check` runs
`scripts/check-databases.mjs`, which loads it explicitly with the Node 22 built-in
`process.loadEnvFile('.env.development')` (a relative path resolved from the working
directory). The file is never renamed to `.env` and its values are never duplicated into
any other tracked or untracked file.

---

## 4. Express + Prisma is the only database client

Supabase provides PostgreSQL hosting **only**. There is no Supabase Auth, Realtime,
Storage, Edge Functions, client SDK, or direct frontend-to-database access.

The sole application database client is **Prisma**, used exclusively by the Express
`api/` backend:

- Frontends (`client/`, `admin/`) never talk to PostgreSQL directly — they call the
  Express API over HTTPS.
- All database access flows through `api/` → Prisma → Supabase PostgreSQL.

---

## 5. The chosen connection URL must be verified, never silently assumed

A Supabase project exposes more than one connection mode (direct connection, session
pooler, transaction pooler, IPv4/IPv6, etc.). The selected connection URL must work for
both **Prisma migrations** and a **persistent Express server**.

**Selected development/demo mode:** Supabase **Supavisor Session pooler on port 5432**.
This is the connection mode used for `DATABASE_URL` and `TEST_DATABASE_URL` on the Windows
development machine. It supports a persistent Express server and safe read-only metadata
inspection for the identity check.

- **Session pooler (`:5432`)** — selected. Persistent server + identity check both work.
- **Direct connection (IPv4/IPv6)** — may be used only when direct/IPv6 connectivity is
  suitable for the environment; it is not the current development/demo selection.
- **Transaction pooler (`:6543`)** — **not** the selected persistent development backend
  mode. It is designed for short-lived serverless workloads and is not used for Demo V2.

The chosen mode is **verified, never assumed**; the current Session-pooler selection is
what makes `npm run db:check` pass. A later `prisma migrate dev` run needs
migration-compatible credentials — the Prisma **shadow database** is created and dropped
by `prisma migrate dev`, so the configured role must be able to create a temporary
database (or the shadow database must be configured) when that gate runs in Task 4.

**TLS: certificate and hostname verification required.** Both Session pooler connections
work with Node.js 22.23.2 + `pg` using the official Supabase root CA:

```js
ssl: { rejectUnauthorized: true, ca }
```

The checker reads `ca` from `scripts/certs/supabase-prod-ca-2021.crt`, relative to the
script via `import.meta.url` (portable across Windows and other platforms). `pg` supplies
the connection hostname to Node TLS; the default hostname check remains enabled. The
checker also requires an encrypted, authorized socket before querying metadata.

The previous `SELF_SIGNED_CERT_IN_CHAIN` failure meant Node could not build a trusted
chain to **Supabase Root 2021 CA** using its default roots. Supplying the official CA
fixes that trust configuration; disabling certificate verification is not required.
Encryption without server authentication leaves connections vulnerable to an active
man-in-the-middle attack. It is not merely a decision about certificate pinning.

Certificate provenance and maintenance:

- Official UI: **Database Settings → SSL Configuration → Download certificate**, as
  documented by [Supabase SSL enforcement](https://supabase.com/docs/guides/platform/ssl-enforcement)
  and the [Session pooler SSL example](https://supabase.com/docs/guides/database/psql).
- The [dashboard download configuration](https://github.com/supabase/supabase/blob/master/apps/studio/hooks/custom-content/custom-content.json)
  points to the [public production CA download](https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt).
- This PEM contains only a public CA certificate, no private key, credentials or project
  identifiers. Keep it versioned with the checker for reproducibility; no machine-specific
  CA path, Windows trust-store change or additional environment variable is needed.
- SHA-256 fingerprint:
  `80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA`.
  Valid until **2031-04-26 10:56:53 UTC**. Obtain rotations through the official dashboard
  or its authenticated HTTPS download, review the replacement and rerun `db:check` for
  both databases. Never trust a certificate merely because an unverified peer sends it.

Keep TLS configuration in the explicit `ssl` object. Per
[node-postgres](https://node-postgres.com/features/ssl), URL TLS options can replace that
object and discard `ca`. The checker rejects `ssl`, `sslmode`, `sslcert`, `sslkey`,
`sslrootcert` and `uselibpqcompat` query options rather than rewriting either URL. If this
guard fails, review the local connection string and configure TLS through the checker.
There is no fallback to unverified TLS or plaintext.

This verifies the Node-to-Supavisor TLS connection. Task 4 must separately verify the
Prisma migration connection with certificate and hostname verification enabled; this
Task 2 result does not certify Prisma connectivity or inspect Supavisor's upstream TLS.

The selection is **verified, never assumed**, in two stages:

1. **Task 2 (reachability / identity / version):** `npm run db:check`
   (`scripts/check-databases.mjs`, Node.js + `pg` only) proves that both configured
   connections are reachable, that their identities are provably distinct, and that both
   report PostgreSQL 16+.
2. **Task 4 (authoritative Prisma gate):** the first `prisma migrate dev` in Prisma
   7.10.x — `npx prisma validate`, `npx prisma generate`, `npx prisma migrate dev
   --name init`, `npx prisma migrate status` — is the **authoritative**
   migration-compatibility gate. Prisma 7 reads its datasource URL from
   `prisma.config.ts` (which does not exist yet; it is created when `api/` is
   bootstrapped).

The Node script in Task 2 runs **before** `api/`, `prisma/schema.prisma`, and
`prisma.config.ts` exist, so it does not use the Prisma CLI. A connection mode that the
script cannot verify (for example one that masks server metadata — see §6) must never be
treated as working.

---

## 6. Destructive-test safety: fail-closed isolation

Integration tests run against `TEST_DATABASE_URL` only. Before any destructive operation
(`TRUNCATE ... RESTART IDENTITY CASCADE`), the test bootstrap runs the **same**
multi-signal, fail-closed isolation check used by Task 2 and reused verbatim by Task 6.

The check, in order:

1. Fail fast unless both `DATABASE_URL` and `TEST_DATABASE_URL` exist.
2. Require the raw strings to differ.
3. Parse both PostgreSQL URLs and compare, **internally only**, the normalized
   non-secret identity components — hostname, port, database name, and username
   (including the project-qualified username/project ref where the connection mode
   encodes one). Passwords, full URLs, secret query parameters, full project refs, and
   full project-qualified usernames are never printed.
4. Open live connections to both and compare safe metadata — `current_database()`,
   `current_user`, `inet_server_addr()`, `inet_server_port()`, `version()`.
5. Optionally use a cluster/system identifier (e.g. from `pg_control_system()`) as an
   additional signal when readable with the available permissions. The check never
   depends on privileged access being available.
6. **Fail closed** (exit non-zero) when distinct Supabase project/database identities
   cannot be established. No single signal is trusted alone: at least one distinct parsed
   identity component **and** one distinct live server-identity signal are required.
   Pooled connection modes that mask server metadata must produce failure, not a pass.
7. Verify both servers report PostgreSQL 16+ (supported by Prisma 7.10.x).
8. Print only a minimal, redacted summary: which side is reachable, the PostgreSQL major
   version of each side, whether distinct identities were proven, and the **names** of the
   identity signals used (e.g. `username`, `inet_server_addr`). It never prints passwords,
   full connection URLs, query parameters, full project refs, full project-qualified
   usernames, or the values of the identity signals themselves.
