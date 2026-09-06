# Mona Jacinta Demo V2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Mona Jacinta Demo V2 vertical slice — a multiuser, multibranch POS system where a SELLER creates a draft sale, sends it to a CASHIER, the CASHIER registers split payments and finalizes the sale, and PostgreSQL transactionally updates inventory, stock movements, and audit logs with realtime notifications.

**Architecture:** Clean bootstrap of three apps in this repository: `api/` (Express + TypeScript + PostgreSQL + Prisma), `client/` (Next.js 16 App Router + React 19 + Tailwind 4), `admin/` (React 19 + Vite 7 + TypeScript + Tailwind 4). Legacy code in `../Tesis/` is read-only reference; selectively port UI primitives and POS interaction patterns only. Money is integer minor units (cents) as `BigInt` across database, API, and frontend. Demo V2 scope is strictly the vertical flow in AGENTS.md §"Demo V2 Main Scenario".

**Tech Stack:** Node.js 22 LTS (minimum 22.12), PostgreSQL 16+ hosted on Supabase (two physically isolated projects — development/demo and integration test; see Task 2), Prisma 7.10.x (pinned; do not float to Prisma 8/latest; datasource URL configured via `prisma.config.ts`), Express 5, TypeScript 5, Zod, JWT (jose), bcrypt, Socket.IO, Vitest, Supertest, Next.js 16, React 19, Tailwind 4, Vite 7, Radix UI, Zustand, React Hook Form.

**Spec:** `docs/architecture/mona-demo-v2.md` (approved), `AGENTS.md` (root)

## Global Constraints

- Runtime/versions: Node.js 22 LTS (minimum 22.12) for every app; PostgreSQL 16+ hosted on Supabase (physically isolated development/demo and test projects — no local or Docker PostgreSQL; see Task 2); Prisma pinned at 7.10.x; Next.js 16; React 19.
- PostgreSQL is the source of truth; MongoDB legacy backend is frozen in `../Tesis/`.
- Money: integer **minor units (centavos)** as `BigInt` in Prisma/PostgreSQL. Examples: ARS 165,000.00 = `16500000` cents; ARS 100,000.00 = `10000000` cents; ARS 65,000.00 = `6500000` cents. JSON transport uses string representation (`"16500000"`); frontend parses to `bigint` for all arithmetic and formats for display only.
- No floating-point arithmetic for money anywhere.
- JSON boundaries: money crosses every JSON boundary as a **decimal string**. A single recursive helper (`api/src/shared/json-safe.ts`, `toJsonSafe(value)`) is used at all JSON boundaries — API responses, Socket.IO payloads, and Prisma `Json` columns such as `AuditLog.before/after`: `bigint` → decimal string, arrays/objects → recursively normalized, `Date` → ISO string, `null`/`undefined` → unchanged. Native `bigint` is never handed to `JSON.stringify`, an Express response, a socket payload, or `prisma.*.create` for a `Json` field. Frontend parses monetary strings to `bigint` for arithmetic and formats for display only.
- Authentication is access-token-only for Demo V2: short-lived JWT (`sub`/`iat`/`exp`/optional `jti`), login again on expiry; **no refresh tokens** (no model, no rotation, no refresh endpoint, no refresh cookie).
- Two independently installable apps per audience plus API: `api/`, `client/`, `admin/` each keep their own `package.json`. No Turborepo, pnpm workspaces, shared ESLint packages, Husky, lint-staged, or mandatory ADR process. CI is optional/minimal and never blocks the business vertical slice.
- JWT is **not** an authorization source: it carries only `sub` (userId), `iat`, `exp`, and optional `jti`. Every authorized request (HTTP or Socket.IO) resolves roles, permissions, and branches fresh from PostgreSQL (`UserBranchRole` → `Role` → `RolePermission` → `Permission`).
- Branch-scoped authorization enforced in backend; frontend visibility is not a security boundary. A client-provided `branchId` (body/query/params) is never trusted on its own: the resource branch (e.g. `Sale.branchId`) is derived server-side from the loaded row, and explicit branch filters are validated against the user's current DB assignments.
- All critical operations use Prisma interactive transactions (`$transaction` with `isolationLevel: 'Serializable'` where needed).
- Row locking uses raw SQL inside the interactive transaction — `tx.$queryRaw`/`tx.$executeRaw` with `SELECT ... FOR UPDATE` in **deterministic order** (e.g. `ORDER BY id ASC`) — or a proven atomic conditional `UPDATE`. Prisma Client model queries expose **no row-locking option** (there is no such API; do not invent one).
- Realtime events are emitted **after** the transaction has committed: services return an event descriptor from the awaited `$transaction` and the caller emits via Socket.IO outside the transaction. Emit failure never rolls back committed state. No outbox table in Demo V2 (outbox is a future pattern for durable external integrations such as ARCA).
- No external network calls inside database transactions.
- Payment idempotency: `registerPayment` requires a client-generated UUID v4 key, stored with **sale-scoped** uniqueness (`SalePayment @@unique([saleId, idempotencyKey])`); `completeSale` needs **no** client key — its idempotency comes from the locked persisted status transition (`PAID → COMPLETED`).
- Sale numbers: branch-scoped, allocated from a `SaleNumberCounter` row locked `FOR UPDATE` inside the send-to-cashier transaction (never derived by scanning past sales); final DB guard is `Sale @@unique([branchId, saleNumber])`. Commercial numbering is independent from future ARCA (`pointOfSaleNumber`, `voucherNumber`, `CAE`).
- Test isolation: physically separate hosted Supabase PostgreSQL test database (`TEST_DATABASE_URL`, conceptual project `mona-jacinta-test`) with `TRUNCATE ... RESTART IDENTITY CASCADE` per test. DB-backed integration tests run **sequentially** (Vitest `fileParallelism: false`); truncation isolation is not safe across parallel workers. Destructive operations run against `TEST_DATABASE_URL` only, after a multi-signal, fail-closed identity check proves it is a different database than `DATABASE_URL` (see Tasks 2 and 6). `DATABASE_URL` and `TEST_DATABASE_URL` are server-only secrets and are never exposed as `NEXT_PUBLIC_*`/`VITE_*` variables.
- Deterministic seed/reset via `prisma/seed.ts` and `scripts/reset-demo.ts`.
- No production secrets committed; `.env.example` with placeholders only.
- Code identifiers in English; UI strings in Spanish.
- Demo V2 scope only — no ARCA, suppliers, purchasing, transfers, warehouses, ecommerce, mobile, advanced reporting, microservices, Kubernetes.

---

### Task 1: Repository Hygiene and Environment Scaffolding

**Objective:** Stop tracking secrets/generated files and provide `.env.example` placeholders. The three apps stay independently installable/runnable — Demo V2 deliberately uses **no** monorepo tooling.

**Dependencies:** None (first task).

**Files/Directories:**
- Create: `.env.example`
- Modify: `.gitignore` (add `.env*`, `.next`, `dist`, `build`, `coverage`, `*.log`, `node_modules`)
- Optional: minimal root `package.json` with convenience verification scripts only (no workspaces, no devDependencies pulling tooling into root).

**Implementation Steps:**
- [ ] Improve `.gitignore` to exclude all generated files, secrets, IDE folders.
- [ ] Create `.env.example` with placeholder values for all required variables (see Task 2/Task 3).
- [ ] Optionally add a minimal root `package.json` with scripts like `verify:api` / `verify:client` / `verify:admin` that run each app's own checks. Each app keeps its own `package.json`, `.eslintrc`/flat config, and Prettier config, created in Tasks 3, 22, 25.
- [ ] Do **not** add: Turborepo, `pnpm-workspace.yaml` restructuring, shared ESLint config packages, Husky, lint-staged, or an ADR directory/process. GitHub Actions (or any CI) is optional and minimal for Demo V2; verification is via local per-app commands and must never block the business vertical slice.

**Tests:** None (hygiene only).

**Verification Commands:**
```bash
git status --short       # only intended files; no secrets or generated output
test -f .env.example     # exists with placeholders
git check-ignore -v node_modules api/dist 2>/dev/null || true
```

**Expected Result:** Clean repository hygiene; apps remain independent; zero monorepo infrastructure.

**Acceptance Criteria:**
- `.env.example` exists with placeholder values for all required env vars; no real values.
- `.gitignore` covers `.env*`, `.next`, `dist`, `build`, `coverage`, `*.log`, `node_modules`.
- No Turborepo/pnpm-workspace/Husky/lint-staged/shared-ESLint-config/ADR files introduced.

**Suggested Commit:** `chore(repo): sanitize environment files and gitignore`

---

### Task 2: Supabase PostgreSQL Environment and Connection Safety

**Objective:** Provide two physically isolated hosted Supabase PostgreSQL projects — development/demo (`DATABASE_URL`, conceptual project `mona-jacinta-demo`) and integration test (`TEST_DATABASE_URL`, conceptual project `mona-jacinta-test`) — with a server-only environment contract, a documented hosted-database workflow, and proven connection safety (reachability, supported PostgreSQL version, and multi-signal fail-closed dev/test isolation) before any schema or test work begins. No local or Docker PostgreSQL is used. Supabase provides hosted PostgreSQL **only** — no Supabase Auth, Realtime, Storage, Edge Functions, or client SDKs; Express + Prisma is the only database client. Prisma CLI connectivity is **not** part of this task: Task 2 runs before `api/`, `prisma/schema.prisma`, and `prisma.config.ts` exist, so connection verification here uses only the Node.js + `pg` safety script; Task 4's first `prisma migrate dev` is the authoritative Prisma migration-compatibility gate.

**Dependencies:** Task 1 (`.gitignore` already excludes `.env*`; `.env.example` exists).

**Files/Directories:**
- Modify: `.env.example` (placeholder `DATABASE_URL` / `TEST_DATABASE_URL` only — no real host, project reference, or password)
- Create (untracked, local): `.env.development` — real connection strings; never committed
- Create: `docs/development/database.md`
- Create: `scripts/check-databases.mjs`; modify root `package.json` (`db:check` script + `pg` devDependency)
- Explicitly do **not** create: `docker-compose.yml`, `docker-compose.test.yml`, `scripts/wait-for-db.sh`, any Docker or local-PostgreSQL artifact, any Supabase SDK/Auth/Realtime/Storage/Edge-Functions code

**Implementation Steps:**
- [ ] Create two separate Supabase projects (conceptual names `mona-jacinta-demo` and `mona-jacinta-test`) in the Supabase dashboard.
- [ ] Copy each project's PostgreSQL connection string into the untracked `.env.development` (`DATABASE_URL` = demo project, `TEST_DATABASE_URL` = test project). Credentials never leave the local untracked file.
- [ ] Update `.env.example` (placeholder DB vars only, marked server-only — no real host, project reference, or password).
- [ ] Write `docs/development/database.md` documenting: (a) one Supabase project for development/demo and a physically separate one for integration tests; (b) where connection info is obtained (Supabase project connection settings); (c) credentials live only in untracked local env files, never in Git; (d) Prisma (via the Express `api/`) is the only database client — frontends never talk to PostgreSQL; (e) the chosen connection URL must work with Prisma migrations and a persistent Express server — if the Supabase dashboard offers multiple connection modes, the selection must be verified, never silently assumed (Task 2 verifies reachability/identity/version via the Node script; Task 4's first `prisma migrate dev` in Prisma 7.10.x is the authoritative migration-compatibility gate); (f) destructive-test safety: `TEST_DATABASE_URL` only, behind the fail-closed isolation check (reused by Task 6).
- [ ] Implement `scripts/check-databases.mjs` (Node 22 built-ins + `pg` as a root devDependency) — the **only** database connectivity proof in this task. The script must, in order:
  1. Fail fast unless both `DATABASE_URL` and `TEST_DATABASE_URL` exist.
  2. Require the raw strings to differ.
  3. Parse both PostgreSQL URLs and compare normalized, non-secret identity components — hostname, port, database name, and username (including the project-qualified username when the Supabase connection mode encodes one). Never print passwords, full URLs, or secret query parameters.
  4. Open live connections to **both** and query safe metadata: `current_database()`, `current_user`, `inet_server_addr()`, `inet_server_port()`, `version()`; compare the resulting tuples.
  5. If a reliable cluster/system identifier (e.g. from `pg_control_system()`) is readable with the available permissions, use it as an **additional** signal; the check must never depend on privileged access being available.
  6. **Fail closed** (exit non-zero) whenever it cannot establish that the two configured connections represent distinct Supabase project/database identities — no single signal is trusted alone, and pooled connection modes that mask server metadata must produce failure, not a pass.
  7. Verify both servers report a PostgreSQL version supported by Prisma 7.10.x (16+).
  8. Print only a redacted summary (host, port, database name, username, server version) per side.
- [ ] Run `npm run db:check` and record the successful result (both connections reachable; distinct identities proven; supported versions).

**Tests:** None in this task (the Task 6 destructive-test bootstrap reuses this same isolation check before any `TRUNCATE`).

**Verification Commands:**
```bash
npm run db:check      # exit 0 only if BOTH DBs reachable, identities proven distinct, versions supported
git status --short    # .env.development is ignored; no docker-compose files; no new tracked secrets
```

**Expected Result:** Two physically isolated Supabase PostgreSQL databases are provisioned and reachable; their distinct identities are proven by multiple independent signals; both run a supported PostgreSQL version; the environment contract is documented and placeholder-only in Git.

**Acceptance Criteria:**
- No Docker/local-PostgreSQL artifacts or instructions remain (`docker-compose*`, `wait-for-db.sh`, `postgres:16`, `localhost:5432`/`localhost:5433`, Docker healthchecks, local-install requirements).
- `.env.example` holds placeholder-only `DATABASE_URL` / `TEST_DATABASE_URL`; no real host/ref/secret; no `NEXT_PUBLIC_DATABASE_URL` / `VITE_DATABASE_URL` exists anywhere.
- `docs/development/database.md` covers the six documentation points above.
- `npm run db:check` exits 0 only when both connections respond, distinct identities are proven via multiple independent signals, and versions are supported (PostgreSQL 16+, compatible with Prisma 7.10.x); it fails closed otherwise.
- No Prisma CLI connectivity is required in this task (Prisma 7 reads its datasource URL from `prisma.config.ts`, which does not exist yet); Task 4 is the authoritative Prisma migration gate.
- The checker never logs passwords, full connection URLs, or secret query parameters.

**Suggested Commit:** `chore(db): add Supabase PostgreSQL environment and connection safety`

---

### Task 3: API Bootstrap — Express + TypeScript + Prisma

**Objective:** Create the `api/` application skeleton with Express 5, TypeScript, Prisma, Zod, and project structure per architecture.

**Dependencies:** Task 1, Task 2.

**Files/Directories:**
- Create: `api/package.json`, `api/tsconfig.json`, `api/.env.example`, `api/prisma.config.ts` (Prisma 7 datasource URL comes from here — `DATABASE_URL` from the server-only env), `api/src/app.ts`, `api/src/server.ts`, `api/src/config/env.ts`, `api/src/config/prisma.ts`, `api/src/middleware/errorHandler.ts`, `api/src/middleware/validation.ts`, `api/src/middleware/auth.ts`, `api/src/middleware/rateLimit.ts`, `api/src/shared/json-safe.ts`, `api/src/shared/errors.ts`, `api/src/modules/` (directory), `api/prisma/schema.prisma`, `api/vitest.config.ts`, `api/.eslintrc.cjs`, `api/.prettierrc`

**Implementation Steps:**
- [ ] Initialize `api/` with `npm init`; set `"engines": { "node": ">=22.12" }`. Install dependencies: `express`, `zod`, `@prisma/client@7.10.0` (exact 7.10.x — do not install `latest`), `prisma@7.10.0` (dev), `typescript`, `tsx` (dev), `vitest`, `supertest`, `@types/supertest`, `@types/express`, `jose`, `bcryptjs`, `socket.io`, `cors`, `helmet`, `pino`, `pino-pretty`, `dotenv`.
- [ ] Configure TypeScript (ESM, strict, path aliases `@/*`).
- [ ] Create `api/src/config/env.ts` with Zod-validated env schema (all required vars; `DATABASE_URL` and `TEST_DATABASE_URL` are server-only and are never exposed to `client/` or `admin/` environment variables).
- [ ] Create `api/src/config/prisma.ts` exporting plain singleton `PrismaClient` (no per-model serialization extension).
- [ ] Implement `api/src/shared/json-safe.ts` — the **single** recursive JSON-boundary normalizer:

    ```typescript
    export function toJsonSafe(value: unknown): unknown {
      if (typeof value === 'bigint') return value.toString();            // 16500000n -> "16500000"
      if (value instanceof Date) return value;                           // JSON-serializable (ISO)
      if (Array.isArray(value)) return value.map(toJsonSafe);
      if (value !== null && typeof value === 'object') {
        return Object.fromEntries(
          Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, toJsonSafe(v)]),
        );
      }
      return value; // string/number/boolean/null/undefined pass through
    }
    ```

  - Applied wherever data crosses a JSON boundary: an Express response helper (`sendJson(res, data)` calls `res.json(toJsonSafe(data))`), Socket.IO payloads before emit, and Prisma `Json` column writes (AuditLog, Task 20). Native `bigint` never reaches `JSON.stringify`, Express, Socket.IO, or a Prisma `Json` field.
- [ ] Create `api/src/shared/errors.ts` with `AppError` class and error codes.
- [ ] Create `api/src/middleware/errorHandler.ts` for centralized error handling (Zod, Prisma, AppError, unknown).
- [ ] Create `api/src/middleware/validation.ts` with `validate(schema)` helper for Zod body/query/params.
- [ ] Create `api/src/middleware/auth.ts` skeleton (JWT verification with `jose`, attaches `userId` to request).
- [ ] Create `api/src/middleware/rateLimit.ts` with basic rate limiting.
- [ ] Create `api/src/app.ts` Express app factory with middleware stack, health check endpoint `GET /health`.
- [ ] Create `api/src/server.ts` entry point: start HTTP server + Socket.IO server on same port.
- [ ] Add npm scripts: `dev`, `build`, `start`, `test`, `typecheck`, `lint`, `db:generate`, `db:push`, `db:migrate`, `db:seed`, `db:studio`.

**Tests:**
- [ ] `api/tests/health.test.ts`: `GET /health` returns 200 with `{ status: 'ok' }`.

**Verification Commands:**
```bash
cd api && npm run dev          # starts on port 3001 (or configured)
curl http://localhost:3001/health  # {"status":"ok"}
cd api && npm run typecheck    # passes
cd api && npm run lint         # passes
```

**Expected Result:** API server runs, health check responds, TypeScript compiles, lint passes.

**Acceptance Criteria:**
- Express + TypeScript compiles without errors.
- Prisma Client generated and connectable.
- `toJsonSafe` unit-tested: nested object/array with `bigint`, `Date`, `null` → all money as decimal strings, dates intact (test with a route returning a BigInt).
- JWT middleware skeleton in place.
- Socket.IO server attached to HTTP server.

**Suggested Commit:** `feat(api): bootstrap Express + TypeScript + Prisma foundation`

---

### Task 4: Prisma Schema and First Migration

**Objective:** Define the complete Demo V2 Prisma schema per `docs/architecture/mona-demo-v2.md` §4 and create the initial migration.

**Dependencies:** Task 3.

**Files/Directories:**
- Modify: `api/prisma/schema.prisma`
- Create: `api/prisma/migrations/.../migration.sql` (generated)

**Implementation Steps:**
- [ ] Define all models in `schema.prisma` exactly per architecture §4, plus the Demo V2 corrections below:
  - `User`, `Role`, `Permission`, `RolePermission`
  - `Branch` (add `code` String unique — short commercial prefix used in sale numbers, e.g. `CEN`, `YB`), `UserBranchRole`
  - `Category`, `Brand`, `Product`, `ProductVariant`
  - `Inventory` (unique on `variantId`, `branchId`; `physical` and `reserved` as `BigInt`)
  - `StockMovement`, `StockReservation`
  - `Sale` with `@@unique([branchId, saleNumber])` (branch-scoped commercial number), `SaleItem`
  - `SalePayment` with `idempotencyKey String` and `@@unique([saleId, idempotencyKey])` — sale-scoped idempotency, present from the **initial** migration
  - `SaleNumberCounter`: `id`, `branchId` (`@unique` relation to `Branch`), `nextValue BigInt @default(1)` — the per-branch counter behind sale numbers (never derived by scanning `Sale` rows)
  - `CashRegister`, `CashSession`, `CashMovement`
  - `AuditLog`
- [ ] Use `BigInt` for all money fields (`price`, `costPrice`, `subtotal`, `discountTotal`, `total`, `amount`, `receivedAmount`, `changeAmount`, `startingCash`, `quantityDelta`, `quantity`).
- [ ] Use `String` for UUIDs (`@id @default(uuid())`).
- [ ] Add indexes for common queries (e.g., `Sale.branchId`, `Sale.status`, `Inventory.variantId_branchId`).
- [ ] Prisma schema cannot express a **partial** unique index, so enforce "at most one OPEN `CashSession` per `CashRegister`" by appending raw SQL to the generated initial migration (document this in the migration header comment):
  ```sql
  CREATE UNIQUE INDEX cash_session_one_open_per_register
    ON "CashSession" ("registerId")
    WHERE "status" = 'OPEN';
  ```
  Keep the Prisma schema as the structural source of truth; this index is the one intentional hand-written SQL addition. Future `prisma migrate dev` runs must not try to drop it (verify with `prisma migrate diff` if drift is suspected).
- [ ] The commercial sale number (`<BRANCH_CODE>-V-<SEQ>`, e.g. `CEN-V-000154`) is purely internal: it has no relationship to future ARCA concepts (`pointOfSaleNumber`, `voucherNumber`, `CAE`), which are out of scope for Demo V2.
- [ ] Run `npx prisma migrate dev --name init` to create the migration. Prisma 7 reads the datasource URL from `prisma.config.ts` (created in Task 3), i.e. the hosted `DATABASE_URL` provisioned in Task 2. **This first migration against the hosted development/demo database is the authoritative Prisma migration-compatibility gate** for the chosen Supabase connection; if it fails, fix the connection mode per `docs/development/database.md` — never silently switch to a different endpoint mode.
- [ ] Run `npx prisma generate` to regenerate client.
- [ ] **Migration verification (Prisma 7.10.x):** use `npx prisma validate` (schema), `npx prisma generate`, `npx prisma migrate status` (migration state), and the automated tests. Do **not** run `prisma db pull` to verify migrations — introspection is not migration verification, and re-introspecting would also lose the hand-written SQL below.
- [ ] Every field referenced by later tasks exists **in this initial schema**: `Branch.code`; `SaleNumberCounter.{branchId,nextValue}`; `Sale.saleNumber` + `@@unique([branchId, saleNumber])`; `SalePayment.idempotencyKey` + `@@unique([saleId, idempotencyKey])`; `CashSession.{registerId,status}` (backing the partial unique index); all BigInt monetary/quantity fields. No later task references a column that does not exist here — the only hand-written SQL is the partial unique index above.

**Tests:** None (schema only).

**Verification Commands:**
```bash
cd api && npx prisma validate
cd api && npx prisma migrate dev --name init
cd api && npx prisma generate
cd api && npx prisma migrate status   # confirms migration applied; no db pull
```

**Expected Result:** Migration created, Prisma Client generated, schema matches architecture §4 plus the corrections above, and the custom partial unique index survives migration regeneration.

**Acceptance Criteria:**
- **Exactly 21 models** — the final initial schema count: `User`, `Role`, `Permission`, `RolePermission`, `Branch`, `UserBranchRole`, `Category`, `Brand`, `Product`, `ProductVariant`, `Inventory`, `StockMovement`, `StockReservation`, `Sale`, `SaleItem`, `SalePayment`, `CashRegister`, `CashSession`, `CashMovement`, `AuditLog`, `SaleNumberCounter`. (No `RefreshToken` — Demo V2 auth is access-token-only.)
- `BigInt` used for all monetary and quantity fields.
- Unique constraints: `Inventory(variantId, branchId)`, `ProductVariant.sku`, `ProductVariant.barcode`, `Sale @@unique([branchId, saleNumber])`, `SalePayment @@unique([saleId, idempotencyKey])`, `SaleNumberCounter.branchId` unique, `Branch.code` unique.
- Partial unique index `cash_session_one_open_per_register` (one OPEN session per register) exists in the initial migration SQL.
- Enum types for `Sale.status`, `StockReservation.status`, `CashSession.status`, `CashMovement.type`, `SalePayment.method`.
- Migration applies cleanly to empty database.

**Suggested Commit:** `feat(db): add initial Prisma schema with all Demo V2 models`

---

### Task 5: Deterministic Seed / Reset

**Objective:** Create idempotent seed script and reset script for reproducible Demo V2 data.

**Dependencies:** Task 4.

**Files/Directories:**
- Create: `api/prisma/seed.ts`, `api/scripts/reset-demo.ts`, `api/scripts/seed-demo.ts`

**Implementation Steps:**
- [ ] Implement `prisma/seed.ts` with deterministic data per architecture §12:
  - Roles: SELLER, CASHIER, MANAGER, ADMIN with permissions.
  - Permissions (12): `sale.create`, `sale.charge`, `sale.complete`, `sale.view`, `sale.queue.view`, `inventory.view`, `inventory.manage`, `cash.session.open`, `cash.session.close`, `user.manage`, `report.view`, `audit.view`.
  - RolePermission mapping per authorization matrix — explicitly: `sale.queue.view` is granted to **CASHIER, MANAGER, ADMIN** and **not** to SELLER (viewing the cashier queue and charging are separate capabilities).
  - Branches: Centro (`code: 'CEN'`), Yerba Buena (`YB`), Tafí Viejo (`TV`), Banda (`BAN`), Concepción (`CON`), Depósito Central (`DEP`) — each with `pointOfSaleNumber`.
  - One `SaleNumberCounter` per branch (`nextValue` starting at 1).
  - Demo users: `admin` (ADMIN, global), `manager01` (MANAGER, Centro), `seller01` (SELLER, Centro), `cashier01` (CASHIER, Centro) — all with bcrypt-hashed password `demo123`.
  - Categories/Brands minimal.
  - Products: Remera Básica, Jean Slim, Campera Jean with color/size variants, SKU, barcode, price (minor units / centavos as BigInt). Prices must make the demo scenario arithmetic exact, e.g. Remera Básica `4500000` (ARS 45,000.00) and Jean Slim `7500000` (ARS 75,000.00), so 2× Remera Negro/M + 1× Jean Azul/42 totals `16500000` centavos (ARS 165,000.00). Never write `165000` as if it meant ARS 165,000.
  - Inventory per branch per variant (physical stock, reserved = 0).
  - One `CashRegister` per branch.
- [ ] Implement `scripts/reset-demo.ts`: drops all data (in FK order) and re-runs seed.
- [ ] Implement `scripts/seed-demo.ts`: runs seed only (idempotent via upsert).
- [ ] Add npm scripts: `db:seed` (runs seed.ts), `db:reset` (runs reset-demo.ts).

**Tests:**
- [ ] `api/tests/seed.test.ts`: run seed twice, verify no duplicates, all entities exist with correct relations.

**Verification Commands:**
```bash
cd api && npm run db:seed
cd api && npx prisma studio  # verify data
cd api && npm run db:reset
cd api && npm run test -- tests/seed.test.ts
```

**Expected Result:** Deterministic seed produces identical database state every run; reset works cleanly.

**Acceptance Criteria:**
- Running seed twice produces no unique constraint violations.
- All 6 branches exist with correct `pointOfSaleNumber`.
- 4 demo users with correct roles/branches.
- 3 products with variants (color/size), SKU, barcode, prices in minor units (centavos) consistent with the demo scenario total of `16500000`.
- Inventory rows for each variant × branch.
- CashRegister per branch.
- `SaleNumberCounter` per branch (nextValue = 1).
- Roles/Permissions/RolePermissions fully populated per matrix.

**Suggested Commit:** `feat(db): add deterministic seed and reset scripts`

---

### Task 6: Vitest + Supertest Infrastructure

**Objective:** Configure Vitest with Supertest for API integration tests, using a real PostgreSQL test database with per-test truncation strategy.

**Dependencies:** Task 3, Task 4, Task 5.

**Files/Directories:**
- Modify: `api/vitest.config.ts`, `api/package.json`
- Create: `api/tests/setup.ts`, `api/tests/helpers/test-db.ts`, `api/tests/helpers/auth.ts`, `api/tests/helpers/factories.ts`

**Implementation Steps:**
- [ ] Configure `vitest.config.ts`: `environment: 'node'`, `setupFiles: ['tests/setup.ts']`, `testTimeout: 30000`, coverage config.
- [ ] **Chosen configuration (explicit):** set `fileParallelism: false` in `api/vitest.config.ts`. All DB-backed integration test files run sequentially in a single process, because every test truncates and reseeds the same test database. `TRUNCATE`-based isolation is **not** safe across parallel workers/files, so we do not enable workers; pure unit tests that never touch PostgreSQL may still live in the same suite — they will simply also run sequentially (acceptable at Demo V2 size). Document this exact choice in `docs/testing/strategy.md`.
- [ ] Create `tests/setup.ts`: set `process.env.NODE_ENV = 'test'`, load test `.env`, and run the fail-closed dev/test isolation guard (next step) **before any database mutation**.
- [ ] Create `tests/helpers/test-db.ts`:
  - Export `createTestPrismaClient()` pointing to `TEST_DATABASE_URL` (the physically separate test project — never `DATABASE_URL`).
  - Export `truncateAllTables(prisma)` using raw `TRUNCATE ... CASCADE` in FK order (or `DELETE` with `ON DELETE CASCADE`). Every destructive/reset helper accepts only the `TEST_DATABASE_URL`-backed client.
  - Export `withTransaction(prisma, fn)` for tests needing transaction (not for HTTP tests).
- [ ] Implement the fail-closed dev/test isolation guard (same multi-signal design as `scripts/check-databases.mjs` from Task 2), executed before any `TRUNCATE`:
  1. `TEST_DATABASE_URL` and `DATABASE_URL` must both exist.
  2. Their raw strings must differ.
  3. Parse both URLs (without logging secrets) and compare normalized non-secret identity components (hostname, port, database name, username/project-qualified username).
  4. Connect to BOTH and compare live metadata tuples (`current_database()`, `current_user`, `inet_server_addr()`, `inet_server_port()`, `version()`); a cluster/system identifier is an optional extra signal, never a privileged dependency.
  5. If distinct Supabase project/database identities cannot be established, throw and abort the entire suite — fail closed. No destructive operation may ever target the development/demo database.
- [ ] Create `tests/helpers/auth.ts`: `createTestUser(role, branch)`, `getAuthToken(user)` returning JWT for test requests.
- [ ] Create `tests/helpers/factories.ts`: factory functions for creating test entities (branch, product, variant, inventory, sale, etc.) via Prisma.
- [ ] Document test isolation strategy in `docs/testing/strategy.md`: **per-test truncation** (not transaction rollback) because Supertest makes real HTTP requests outside the test's transaction. Each test truncates all tables before/after. Document the fail-closed multi-signal dev/test isolation guard in the same file.

**Tests:**
- [ ] `api/tests/infrastructure.test.ts`: verify test DB connection, truncation works, auth helper produces valid JWT.

**Verification Commands:**
```bash
cd api && npm run test          # all tests pass
cd api && npm run test:coverage # coverage report generated
```

**Expected Result:** Test infrastructure ready; per-test truncation isolates tests; auth helpers work.

**Acceptance Criteria:**
- Vitest runs with Supertest against real test PostgreSQL.
- `vitest.config.ts` sets `fileParallelism: false`; DB-backed integration test files run sequentially in one process.
- `truncateAllTables` leaves DB empty between tests; `beforeEach` truncates and the test creates only the fixtures it needs.
- Destructive truncation is impossible without proven isolation: the suite fails closed when `TEST_DATABASE_URL` is missing, equals `DATABASE_URL`, or resolves to the same database identity as the development/demo database.
- `createTestUser` + `getAuthToken` allows authenticated requests in tests.
- Factories create valid entities with correct relations.

**Suggested Commit:** `test(api): add Vitest + Supertest infrastructure with per-test truncation`

---

### Task 7: Authentication — JWT Login (Access Token Only)

**Objective:** Implement employee authentication with short-lived JWT access tokens, returning user context with roles and branches. **Explicit Demo V2 decision: access-token-only — no refresh tokens** (no model, no storage/hashing, no rotation, no `POST /auth/refresh`, no refresh cookie). On expiry the user logs in again.

**Dependencies:** Task 3, Task 4, Task 5, Task 6.

**Files/Directories:**
- Create: `api/src/modules/auth/` directory with:
  - `auth.routes.ts`, `auth.controller.ts`, `auth.service.ts`
  - `dto/login.dto.ts`
  - `tokens.ts` (JWT sign/verify with `jose`)
  - `password.ts` (bcrypt hash/verify)
- Modify: `api/src/middleware/auth.ts` (complete implementation), `api/src/app.ts` (mount auth routes)

**Implementation Steps:**
- [ ] Define Zod schema in `dto/login.dto.ts` (email, password).
- [ ] Implement `password.ts`: `hashPassword`, `verifyPassword` using `bcryptjs` (cost 12).
- [ ] Implement `tokens.ts`:
  - `signAccessToken(userId)`: 15-min expiry. Payload contains **only** identity claims: `sub: userId`, `iat`, `exp`, optional `jti` (session identifier). **No `roles[]` or `branchIds[]` in the JWT — it is never the source of authorization data.**
  - `verifyAccessToken(token)` using `jose`.
  - (No `signRefreshToken`/`verifyRefreshToken` — they do not exist in Demo V2.)
- [ ] Implement `auth.service.ts`:
  - `login(email, password)`: find user, verify password, check `isActive`, resolve `UserBranchRole` with roles/branches from PostgreSQL, sign access token, return `{ accessToken, user: { id, name, email, roles, branches } }` (the context object is informational; every later request re-resolves authorization from the DB).
  - `me(userId)`: return the current user context resolved from PostgreSQL.
  - No refresh/logout-with-invalidation endpoints: logout is client-side token discard (stateless JWT).
- [ ] Implement `auth.controller.ts` with `POST /api/v1/auth/login` and `GET /api/v1/auth/me`.
- [ ] Complete `auth.middleware.ts`: extract Bearer token, verify with `jose`, take `sub` as `userId`, then load the **current** authorization snapshot from PostgreSQL (`User`, `UserBranchRole` → `Role` → `RolePermission` → `Permission`) and attach `req.auth = { userId, roles, branchIds, permissions }` for this request only. Role/branch/permission changes take effect on the next request without re-login. Expired token → 401 and the frontend returns to login.
- [ ] Mount routes at `/api/v1/auth`.

**Tests (write first):**
- [ ] `api/tests/auth/login.test.ts`: valid credentials → 200 + accessToken + user context; invalid → 401; inactive user → 403.
- [ ] `api/tests/auth/me.test.ts`: `GET /auth/me` with valid accessToken → user context; without/with expired token → 401.
- [ ] Token payload inspection test: decoded JWT contains `sub`/`iat`/`exp` and **no** `roles`/`branchIds` claims.

**Verification Commands:**
```bash
cd api && npm run test -- tests/auth/
cd api && npm run dev  # manual test with curl
```

**Expected Result:** Login returns a short-lived access token + user context; middleware validates the token and attaches a DB-resolved authorization context on every request.

**Acceptance Criteria:**
- Access token expires in 15 min; on expiry the user logs in again (no refresh flow exists — no `RefreshToken` model, table, hash storage, rotation, endpoint, or cookie anywhere).
- User context (login response and `GET /auth/me`) includes `roles[]` and `branchIds[]` resolved from PostgreSQL; the JWT itself carries only `sub`/`iat`/`exp`/optional `jti` and is never used as an authorization source.
- Bcrypt cost ≥ 12.
- No passwords in logs.

**Suggested Commit:** `feat(auth): implement JWT login (access-token-only)`

---

### Task 8: RBAC and Branch-Scoped Authorization

**Objective:** Implement permission-based authorization middleware with branch scoping per the authorization matrix.

**Dependencies:** Task 7.

**Files/Directories:**
- Create: `api/src/middleware/authorization.ts`, `api/src/shared/permissions.ts`, `api/src/modules/auth/permissions.ts` (permission constants)
- Modify: `api/src/app.ts` (apply auth middleware globally)

**Implementation Steps:**
- [ ] Define permission constants in `permissions.ts` (e.g., `SALE_CREATE`, `SALE_CHARGE`, `SALE_COMPLETE`, `SALE_VIEW`, `SALE_QUEUE_VIEW`, `INVENTORY_VIEW`, `INVENTORY_MANAGE`, `CASH_SESSION_OPEN`, `CASH_SESSION_CLOSE`, `USER_MANAGE`, `REPORT_VIEW`, `AUDIT_VIEW`).
- [ ] Create `authorization.ts` middleware factory:
  - `requirePermission(permission: string, options?: { branchScope?: 'own' | 'any' | 'global' })`
  - Uses the per-request `req.auth` snapshot resolved from PostgreSQL (Task 7) — never JWT claims and never client-supplied role/branch values.
  - For `branchScope: 'own'` (resource routes like `/sales/:id/...`): the route provides a `resolveResourceBranch(req)` hook that loads the target resource (e.g. `Sale` by `:id`) and derives its branch **server-side** (`sale.branchId`); access requires the permission AND that derived branch in the user's DB-assigned `branchIds`. A `branchId` taken from body/query/params is never used as the authorization input for an existing resource.
  - For explicit branch filters (list endpoints, e.g. `GET /variants?branchId=`): validate the requested `branchId` against the user's current DB assignments before executing the query; reject with 403 if outside them.
  - For `branchScope: 'any'`: user must have permission AND at least one branch match.
  - For `branchScope: 'global'` (ADMIN): permission check only — ADMIN's global access is itself a **permission**, not a special role check.
  - Returns 403 if denied.
- [ ] Create helper `getUserBranchScope(req)` returning the user's DB-resolved branch IDs, and `assertBranchAccess(req, branchId)` for explicit filters.
- [ ] Apply `auth` middleware globally in `app.ts` (except `/health`, `/auth/login`).

**Tests (write first):**
- [ ] `api/tests/auth/rbac.test.ts`:
  - SELLER on `POST /sales` (SALE_CREATE, own branch) → 201.
  - SELLER on `POST /sales/:id/charge` (SALE_CHARGE) → 403.
  - CASHIER on `POST /sales` → 403.
  - CASHIER on `POST /sales/:id/charge` (own branch) → 200.
  - MANAGER on `GET /inventory` (own branch) → 200; other branch → 403.
  - ADMIN on any endpoint → 200.
  - Sale route: cashier of another branch on `GET /sales/:id` → 403 even when guessing/forging the id (branch derived from the loaded `Sale` row, not from the request).
  - Explicit filter: user passes `?branchId=<other branch>` → 403.
  - Queue permission split: SELLER (has `SALE_VIEW`) on `GET /sales/pending` → 403; same route under CASHIER (`SALE_QUEUE_VIEW`) → 200. No `role === 'CASHIER'` checks anywhere.
  - Revocation: after removing a `UserBranchRole` assignment, the user's next request with the **same** (still valid) JWT → 403 without re-login.

**Verification Commands:**
```bash
cd api && npm run test -- tests/auth/rbac.test.ts
```

**Expected Result:** Authorization middleware enforces permissions and branch scope correctly.

**Acceptance Criteria:**
- All 12 permissions defined and mapped to roles per matrix (incl. `SALE_QUEUE_VIEW`: CASHIER/MANAGER/ADMIN yes; SELLER no).
- `requirePermission` factory works for route-level protection.
- Branch scope enforcement: SELLER/CASHIER/MANAGER restricted to their DB-assigned branches; ADMIN global **via permission**.
- Authorization data (roles, permissions, branches) always resolved from PostgreSQL per request; JWT claims never drive authorization.
- Existing-resource branch always derived from the persisted row (e.g. `Sale.branchId`); client-provided `branchId` only ever validated as a filter against DB assignments.
- No `user.role === 'admin'` checks in codebase.

**Suggested Commit:** `feat(rbac): add permission-based branch-scoped authorization`

---

### Task 9: Products and ProductVariants CRUD

**Objective:** Implement read-only (for Demo V2) product and variant endpoints with branch-scoped visibility.

**Dependencies:** Task 4, Task 5, Task 8.

**Files/Directories:**
- Create: `api/src/modules/products/` with `products.routes.ts`, `products.controller.ts`, `products.service.ts`, `dto/product.dto.ts`, `dto/variant.dto.ts`
- Modify: `api/src/app.ts` (mount routes)

**Implementation Steps:**
- [ ] Define Zod schemas for query params (pagination, search, branchId filter).
- [ ] Implement `products.service.ts`:
  - `listProducts(query)`: filter by `isActive`, search by name/SKU/barcode, paginate.
  - `getProduct(id)`: include variants, category, brand.
  - `listVariants(query)`: filter by productId, isActive; optional `branchId` filter (join inventory for stock) — validate the requested branch against the caller's DB assignments via `assertBranchAccess` (Task 8) before querying.
  - `getVariant(id)`: include product, inventory per branch.
- [ ] Implement controllers with `requirePermission(INVENTORY_VIEW, { branchScope: 'own' })` for list; `requirePermission(INVENTORY_VIEW, { branchScope: 'any' })` for get.
- [ ] Mount at `/api/v1/products`, `/api/v1/variants`.
- [ ] Ensure BigInt serialization: prices returned as strings.

**Tests (write first):**
- [ ] `api/tests/products/products.test.ts`: list products, search, pagination, variant stock per branch.
- [ ] `api/tests/products/variants.test.ts`: list variants with inventory, filter by branch.

**Verification Commands:**
```bash
cd api && npm run test -- tests/products/
curl -H "Authorization: Bearer <token>" http://localhost:3001/api/v1/variants?branchId=<id>
```

**Expected Result:** Products and variants queryable with branch-scoped inventory data.

**Acceptance Criteria:**
- Product/Variant list supports search, pagination, branch filter.
- Variant response includes `inventory` array with `physical`, `reserved`, `available` (computed).
- Prices serialized as strings of minor units (e.g., `"16500000"` = ARS 165,000.00).
- Authorization: SELLER/CASHIER see only their branch inventory; MANAGER/ADMIN see all.

**Suggested Commit:** `feat(products): add product and variant read endpoints with inventory`

---

### Task 10: Branch Inventory — Read + Availability

**Objective:** Implement inventory endpoints showing available stock per variant per branch.

**Dependencies:** Task 9.

**Files/Directories:**
- Create: `api/src/modules/inventory/` with `inventory.routes.ts`, `inventory.controller.ts`, `inventory.service.ts`
- Modify: `api/src/app.ts` (mount routes)

**Implementation Steps:**
- [ ] Implement `inventory.service.ts`:
  - `getAvailability(branchId, variantIds?)`: returns `[{ variantId, physical, reserved, available }]` where `available = physical - reserved`. The requested `branchId` is validated against the caller's DB-assigned branches before querying.
  - `getInventoryByBranch(branchId)`: full inventory list for branch.
  - `checkAvailability(branchId, items: { variantId, quantity }[])`: throws if any `available < quantity`.
- [ ] Implement controller with `requirePermission(INVENTORY_VIEW, { branchScope: 'own' })`.
- [ ] Mount at `/api/v1/inventory`.

**Tests (write first):**
- [ ] `api/tests/inventory/inventory.test.ts`: availability calculation, concurrent check (see Task 13), branch isolation.

**Verification Commands:**
```bash
cd api && npm run test -- tests/inventory/
```

**Expected Result:** Inventory availability computed correctly (`available = physical - reserved`), branch-scoped.

**Acceptance Criteria:**
- `available` is computed field, never stored.
- Concurrent availability checks use row locks (see Task 13).
- Branch isolation enforced.

**Suggested Commit:** `feat(inventory): add branch inventory availability endpoints`

---

### Task 11: Sale and SaleItem — Draft Creation

**Objective:** Implement draft sale creation and cart management (add/remove items, update quantities) for SELLER.

**Dependencies:** Task 8, Task 9.

**Files/Directories:**
- Create: `api/src/modules/sales/` with `sales.routes.ts`, `sales.controller.ts`, `sales.service.ts`, `dto/sale.dto.ts`, `dto/sale-item.dto.ts`
- Modify: `api/src/app.ts` (mount routes)

**Implementation Steps:**
- [ ] Define Zod schemas: `createDraftSaleDto` (no client `branchId` trusted — the branch is resolved from the seller's DB assignment; if the user holds roles in multiple branches, a requested branch must be validated with `assertBranchAccess`), `addSaleItemDto` (variantId, quantity), `updateSaleItemDto` (quantity).
- [ ] Implement `sales.service.ts`:
  - `createDraftSale(userId, branchId)`: creates `Sale` with `status: 'DRAFT'`, `subtotal=0`, `discountTotal=0`, `total=0`, `sellerId=userId`.
  - `addItem(saleId, variantId, quantity)`: validates variant exists/active, checks inventory availability (read-only for draft), creates/updates `SaleItem`, recalculates totals.
  - `updateItem(saleId, itemId, quantity)`: updates quantity, recalculates.
  - `removeItem(saleId, itemId)`: removes item, recalculates.
  - `getDraftSale(saleId)`: returns sale with items, variant details, totals.
  - `listDraftSales(userId)`: seller's own drafts.
- [ ] Implement controllers with `requirePermission(SALE_CREATE, { branchScope: 'own' })` for create/add/update/remove; `requirePermission(SALE_VIEW, { branchScope: 'own' })` for get/list.
- [ ] Mount at `/api/v1/sales` (draft operations under `/draft` or status-filtered).

**Tests (write first):**
- [ ] `api/tests/sales/draft.test.ts`: create draft, add items, update qty, remove item, totals recalc correctly, branch isolation.

**Verification Commands:**
```bash
cd api && npm run test -- tests/sales/draft.test.ts
```

**Expected Result:** SELLER can create draft sale, add variant items with quantities, see running total.

**Acceptance Criteria:**
- Draft sale created with `status: 'DRAFT'`.
- Items reference `ProductVariant` with snapshot of `productName`, `variantName`, `sku`, `unitPrice`.
- Totals (`subtotal`, `discountTotal`, `total`) stored as BigInt cents, recalculated on each change.
- SELLER only sees/manages own drafts in own branch.
- No inventory reservation yet (draft only).

**Suggested Commit:** `feat(sales): implement seller draft sale flow`

---

### Task 12: Transactional Send-to-Cashier + StockReservation

**Objective:** Implement `POST /sales/:id/send-to-cashier` — validates availability, creates `StockReservation(ACTIVE)`, increments `Inventory.reserved`, transitions sale to `PENDING_PAYMENT`, generates branch-scoped sale number. `physical` stock is untouched and **no `StockMovement` is created**: a reservation is a logical hold, not a physical movement.

**Dependencies:** Task 11.

**Files/Directories:**
- Modify: `api/src/modules/sales/sales.service.ts`, `sales.controller.ts`, `sales.routes.ts`
- Create: `api/src/modules/sales/reservation.service.ts`

**Implementation Steps:**
- [ ] Implement `reservation.service.ts`:
  - `reserveStockForSale(saleId, userId)`: runs in a Prisma interactive transaction, exactly in this order:

    ```text
    BEGIN  (prisma.$transaction with isolationLevel: 'Serializable')
      1. Lock the Sale row via raw SQL and require DRAFT:
         const [sale] = await tx.$queryRaw`
           SELECT id, "branchId", status FROM "Sale" WHERE id = ${saleId} FOR UPDATE`;
         if (sale.status !== 'DRAFT') throw new SaleNotDraftError();
      2. Load the sale's SaleItem rows from the DB (never trust a client-sent item list).
      3. Lock the required Inventory rows in DETERMINISTIC order (sorted by inventory id)
         to reduce deadlock risk:
         await tx.$queryRaw`
           SELECT id, physical, reserved FROM "Inventory"
           WHERE id IN (${Prisma.join(sortedIds)})
           ORDER BY id ASC
           FOR UPDATE`;
      4. For each item: available = physical - reserved; require available >= quantity,
         else throw InsufficientStockError.
      5. Increment Inventory.reserved per item:
         tx.inventory.update({ where: { id }, data: { reserved: { increment: qty } } }).
         (physical is NOT modified.)
      6. Create StockReservation(status: 'ACTIVE', expiresAt: now() + 30 min) per item.
         (NO StockMovement is created.)
      7. Allocate the branch-scoped sale number from SaleNumberCounter
         (never derived by scanning existing Sale rows):
         const [counter] = await tx.$queryRaw`
           SELECT id, "nextValue" FROM "SaleNumberCounter"
           WHERE "branchId" = ${sale.branchId} FOR UPDATE`;
         const saleNumber = `${branchCode}-V-${String(counter.nextValue).padStart(6, '0')}`;
            // e.g. CEN-V-000154
         await tx.saleNumberCounter.update({
           where: { id: counter.id }, data: { nextValue: { increment: 1 } } });
         (The FOR UPDATE row lock serializes allocation per branch; Sale
         @@unique([branchId, saleNumber]) remains the final DB guard.)
      8. Update Sale: status: 'PENDING_PAYMENT', saleNumber, subtotal, total.
      9. Write AuditLog: action 'SALE_SENT_TO_CASHIER'.
    COMMIT
    ```

- [ ] Implement `generateSaleNumber(branchId, branchCode, tx)` exactly as above: lock the branch's `SaleNumberCounter` row `FOR UPDATE`, read `nextValue`, compose `<BRANCH_CODE>-V-<SEQ>` (e.g. `CEN-V-000154`), increment `nextValue` in the same transaction. Formatting rule: convert the BigInt counter to a **decimal string** and pad the string (`String(counter.nextValue).padStart(6, '0')`); never coerce the counter through `Number()` — large values must stay exact. Retries exist only for Serializable/deadlock failures of the whole transaction — not for guessing numbers. This number is independent from any future ARCA numbering.
- [ ] Add `sendToCashier` endpoint in controller with `requirePermission(SALE_CREATE, { branchScope: 'own' })`; the branch check resolves against the `Sale.branchId` of the row loaded in step 1 — never a client-provided branch value.
- [ ] Handle errors: `InsufficientStockError` (409, rollback — no reservation, inventory untouched), `SaleNotDraftError` (409), serialization/deadlock failure → retry the transaction wrapper up to 3 times, then `ConcurrencyError` (409).
- [ ] Prisma Client exposes no row-locking option on model queries — all row locks use raw SQL as shown. An atomic conditional `UPDATE` (e.g. `UPDATE "Inventory" SET reserved = reserved + $q WHERE id = $id AND physical - reserved >= $q` and verify row count) is an acceptable alternative for step 5, but the availability read in step 4 must still happen under the row lock.

**Tests (write first):**
- [ ] `api/tests/sales/send-to-cashier.test.ts`:
  - Happy path: draft → PENDING_PAYMENT, reservations created, `reserved` incremented, `physical` unchanged, **zero `StockMovement` rows**, sale number generated.
  - Insufficient stock → 409, no reservation, inventory fully unchanged, sale stays DRAFT.
  - Concurrency: two sellers send-to-cashier for the last physical unit → exactly one succeeds; no oversell (`physical - reserved` never negative).
  - Sale number uniqueness under concurrency.

**Verification Commands:**
```bash
cd api && npm run test -- tests/sales/send-to-cashier.test.ts
```

**Expected Result:** Send-to-cashier atomically reserves stock, generates sale number, transitions status — with no physical stock change and no StockMovement.

**Acceptance Criteria:**
- All operations in one Prisma interactive transaction (`Serializable`), with the Sale row and Inventory rows locked via raw `SELECT ... FOR UPDATE` in deterministic ascending-id order.
- `Inventory.reserved` incremented, `physical` unchanged, **no `StockMovement` created**.
- `StockReservation` created with `ACTIVE` status and `expiresAt`.
- Sale number allocated from the branch's `SaleNumberCounter` row lock (never derived by scanning past sales); format `<BRANCH_CODE>-V-<SEQ>` (e.g., `CEN-V-000154`); `Sale @@unique([branchId, saleNumber])` is the final database guard.
- AuditLog written in same transaction.
- Concurrency-safe: only one seller can reserve the last unit; concurrent allocations get distinct sequential sale numbers.
- Authorization: branch derived from the persisted `Sale` row, not from request data.

**Suggested Commit:** `feat(sales): add transactional send-to-cashier with stock reservation`

---

### Task 13: Cashier Pending-Sales Queue

**Objective:** Implement `GET /sales/pending` for CASHIER — lists `PENDING_PAYMENT` sales in their branch with items and totals.

**Dependencies:** Task 12.

**Files/Directories:**
- Modify: `api/src/modules/sales/sales.service.ts`, `sales.controller.ts`, `sales.routes.ts`

**Implementation Steps:**
- [ ] Add `listPendingSales(cashierId)` in service: resolve the cashier's branch from their DB assignment (`UserBranchRole`), then filter `Sale` where `status = 'PENDING_PAYMENT'` and `branchId` equals that branch; include `SaleItem` with variant/product snapshots, compute remaining balance. A client-supplied `branchId` is not needed and, if present, must be validated against DB assignments.
- [ ] Add endpoint `GET /sales/pending` guarded by `requirePermission(SALE_QUEUE_VIEW, { branchScope: 'own' })` — a dedicated permission held by CASHIER/MANAGER/ADMIN, **not** SELLER. Do not gate the queue on `SALE_VIEW` (SELLER also has it for their own sales) and never on a role string.
- [ ] Response includes: saleId, saleNumber, sellerName, items[], subtotal, total, paidAmount (sum of SalePayment), remainingBalance.

**Tests (write first):**
- [ ] `api/tests/sales/pending-queue.test.ts`: cashier sees pending sales in branch; SELLER → 403 (lacks `SALE_QUEUE_VIEW`, even though they hold `SALE_VIEW`); other branch not visible.

**Verification Commands:**
```bash
cd api && npm run test -- tests/sales/pending-queue.test.ts
```

**Expected Result:** Cashier sees queue of pending sales with all details needed for payment.

**Acceptance Criteria:**
- Only `PENDING_PAYMENT` sales shown.
- Guarded by `SALE_QUEUE_VIEW` (CASHIER/MANAGER/ADMIN); SELLER denied despite holding `SALE_VIEW`.
- Branch-scoped: cashier sees only their branch.
- Response includes computed `paidAmount` and `remainingBalance`.
- Items include variant snapshot (name, sku, price at time of sale).

**Suggested Commit:** `feat(sales): add cashier pending-sales queue`

---

### Task 14: CashRegister and CashSession

**Objective:** Implement cash register and session management — open/close session, validate OPEN session for cash payments.

**Dependencies:** Task 5 (seed creates registers), Task 8.

**Files/Directories:**
- Create: `api/src/modules/cash/` with `cash.routes.ts`, `cash.controller.ts`, `cash.service.ts`, `dto/cash-session.dto.ts`
- Modify: `api/src/app.ts` (mount routes)

**Implementation Steps:**
- [ ] Implement `cash.service.ts`:
  - `getRegister(branchId)`: returns the `CashRegister` for branch (seeded 1 per branch).
  - `openSession(registerId, userId, startingCash)`: runs in a transaction that first locks the `CashRegister` row (`tx.$queryRaw` `SELECT ... FROM "CashRegister" WHERE id = ${registerId} FOR UPDATE`) to serialize open attempts per register, then validates no existing `OPEN` session, creates `CashSession(status: 'OPEN')`, creates `CashMovement(type: 'OPENING', amount: startingCash)`, writes `AuditLog`.
  - The find-then-create check is **not** the race protection: the final guard is the database-level partial unique index `cash_session_one_open_per_register` created in the initial migration (Task 4) — `UNIQUE ("registerId") WHERE status = 'OPEN'`. A concurrent loser hits Prisma `P2002`; handle it explicitly and return 409 `CASH_SESSION_ALREADY_OPEN`.
  - `closeSession(sessionId, userId, closingCash)`: validates session `OPEN`, creates `CashMovement(type: 'CLOSING', amount: closingCash)`, updates session `status: 'CLOSED'`, `closedAt`, `closedById`, writes `AuditLog`.
  - `getCurrentSession(branchId)`: returns `OPEN` session for branch's register or null.
- [ ] Implement controllers with `requirePermission(CASH_SESSION_OPEN, { branchScope: 'own' })` for open; `CASH_SESSION_CLOSE` for close.
- [ ] Mount at `/api/v1/cash`.

**Tests (write first):**
- [ ] `api/tests/cash/cash-session.test.ts`: open session, cannot open twice (409), close session, cash movements created, audit logged.
  - Concurrency: two `openSession` requests for the same register fired in parallel → exactly one `OPEN` `CashSession` exists afterwards; the loser receives 409 `CASH_SESSION_ALREADY_OPEN`.

**Verification Commands:**
```bash
cd api && npm run test -- tests/cash/
```

**Expected Result:** Cashier can open/close session; OPEN session required for cash payments.

**Acceptance Criteria:**
- At most one `OPEN` session per `CashRegister`, guaranteed by the partial unique index `cash_session_one_open_per_register` (not by app-level checks alone); concurrent race resolves to exactly one session.
- `OPENING` and `CLOSING` cash movements created with correct amounts.
- AuditLog entries for open/close.
- CASHIER/MANAGER/ADMIN can open/close; SELLER cannot.

**Suggested Commit:** `feat(cash): add CashRegister and CashSession management`

---

### Task 15: Idempotent Split Payments — registerPayment

**Objective:** Implement `POST /sales/:id/payments` — register a payment (CASH, TRANSFER, CARD_DEBIT, CARD_CREDIT, QR), idempotent via idempotency key, creates `SalePayment`, for CASH creates `CashMovement(SALE_INCOME)`, transitions sale to `PAID` when accepted total == sale total.

**Dependencies:** Task 12, Task 14.

**Files/Directories:**
- Create: `api/src/modules/payments/` with `payments.routes.ts`, `payments.controller.ts`, `payments.service.ts`, `dto/payment.dto.ts`
- Modify: `api/src/modules/sales/sales.service.ts` (add payment recalculation), `api/src/app.ts` (mount routes)

**Implementation Steps:**
- [ ] Define Zod schema: `registerPaymentDto` with `method`, `amount` (string of minor units, e.g. `"10000000"` = ARS 100,000.00), `receivedAmount?` (string, required for CASH), `idempotencyKey` (required, UUID v4).
- [ ] Implement `payments.service.ts`:
  - `registerPayment(saleId, dto, userId)`: runs in **one** Prisma interactive transaction (`isolationLevel: 'Serializable'`, limited retry — max 3 — on serialization failure). Financial acceptance for a Sale is serialized by the Sale row lock, so two concurrent payment requests can never both consume the same remaining balance:

    ```text
    BEGIN
      1. Lock the Sale row and read its authoritative state:
         const [sale] = await tx.$queryRaw`
           SELECT id, "branchId", status, total FROM "Sale"
           WHERE id = ${saleId} FOR UPDATE`;
         require sale.status === 'PENDING_PAYMENT' (else 409 INVALID_SALE_STATE).
         branchId always comes from this locked persisted row — never from the client.
      2. Idempotency check (sale-scoped):
         existing = tx.salePayment.findUnique({
           where: { saleId_idempotencyKey: { saleId, idempotencyKey } } })
         — see idempotency rules below (same payload -> return existing; different -> 409).
      3. Recalculate acceptedPaymentTotal = SUM(SalePayment.amount) for this sale
         INSIDE the transaction (after the lock, so it is serialized).
      4. remaining = sale.total - acceptedPaymentTotal.
         Validate: amount > 0 AND amount <= remaining (else 409 OVERPAYMENT / 400).
      5. If method === 'CASH':
           require receivedAmount present and receivedAmount >= amount;
           locate the OPEN CashSession for the register of sale.branchId (persisted branch);
           if none -> 409 NO_OPEN_CASH_SESSION;
           changeAmount = receivedAmount - amount.
      6. Create SalePayment{ method, amount, receivedAmount?, changeAmount?, idempotencyKey,
         cashSessionId?, paidAt: now() }.
      7. If method === 'CASH': create CashMovement{ type: 'SALE_INCOME',
         amount: salePayment.amount,   // the amount applied to the sale — NEVER receivedAmount
         salePaymentId, cashSessionId, userId }.
      8. Recalculate acceptedPaymentTotal; if acceptedPaymentTotal === sale.total:
         transition Sale: PENDING_PAYMENT -> PAID.
      9. Write AuditLog (payment registered; status change if any).
    COMMIT
    ```

  - Exact arithmetic example: remaining = `6500000` (ARS 65,000.00); payment `amount = "6500000"`, `receivedAmount = "7000000"` → `changeAmount = "500000"`; the `CashMovement.amount` is `"6500000"` (returned change is not revenue).
- [ ] **Idempotency design (sale-scoped, race-safe):**
  - Schema (Task 4): `SalePayment @@unique([saleId, idempotencyKey])`.
  - The frontend generates one UUID v4 **per payment intent** (one click); retries reuse the same key.
  - Inside the locked transaction: `findUnique` on `(saleId, idempotencyKey)`:
    - found and `method`, `amount`, `receivedAmount` all match → return the already-accepted authoritative payment (200); create nothing.
    - found but any of those fields differ → `409 IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD`.
    - not found → proceed to create.
  - The `findUnique`-then-create is **not** the race protection — the database constraint is: on concurrent creation with the same key, one transaction wins and the other gets Prisma's `P2002` unique-violation error. Handle `P2002` on `SalePayment(saleId, idempotencyKey)` by re-reading the row inside a fresh retry (or the same transaction after rollback-to-retry) and applying the same-payload / different-payload rules above (return existing or 409). Document this exact handling path in code comments.
- [ ] Add endpoint `POST /sales/:id/payments` with `requirePermission(SALE_CHARGE, { branchScope: 'own' })`.
- [ ] Add `GET /sales/:id/payments` to list payments.

**Tests (write first):**
- [ ] `api/tests/payments/split-payment.test.ts`:
  - Split payment (minor units): `"10000000"` + `"6500000"` = `"16500000"` → sale becomes PAID.
  - Partial: `"10000000"` + `"6000000"` (`16000000` < `16500000`) → sale remains PENDING_PAYMENT.
  - Idempotency: same key + same payload twice → 200 with the single existing payment; exactly one `SalePayment` row and one `CashMovement` row.
  - Idempotency conflict: same key + different `amount`/`method`/`receivedAmount` → 409 `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD`; no new rows.
  - Idempotency race: two concurrent requests with the same key → exactly one `SalePayment` persisted (the loser resolves via `P2002` → returns existing or 409 per payload comparison).
  - **Concurrency: `Sale.total = "16500000"`, already paid `"10000000"`, remaining = `"6500000"`. Two concurrent requests of `"6500000"` → only one accepted (201/200); the other gets a safe conflict/retry result (409 or retried-then-conflict); `Sale.total` is never exceeded; `SUM(SalePayment.amount) <= Sale.total` always.**
  - CASH: requires OPEN session for the sale's persisted branch, creates `SALE_INCOME` movement whose `amount` equals the payment `amount` (not `receivedAmount`); change example above (`received "7000000"` → `changeAmount "500000"`, movement `"6500000"`).
  - Non-CASH: no CashMovement, no session required.
  - Invalid method/amount (`0`, negative, non-numeric) → 400; overpayment beyond remaining → 409.
  - Payment on non-PENDING_PAYMENT sale → 409.

**Verification Commands:**
```bash
cd api && npm run test -- tests/payments/
```

**Expected Result:** Split payments work serialized per sale, idempotent by sale-scoped key, CASH creates CashMovement with the applied amount, sale transitions to PAID exactly when total matched.

**Acceptance Criteria:**
- `SalePayment @@unique([saleId, idempotencyKey])` (from the initial migration) is the final race protection; `P2002` on it is handled explicitly (return existing or 409).
- Same key + same payload returns the existing payment; same key + different payload → 409 `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD`.
- Concurrent payments for the same remaining balance are serialized by the Sale row lock: exactly one wins, `Sale.total` never exceeded.
- CASH payments: `amount` = revenue, `receivedAmount` = gross, `changeAmount` = difference; `CashMovement.amount = amount` (not receivedAmount).
- Sale becomes `PAID` only when `SUM(SalePayment.amount) === Sale.total`.
- All operations in single transaction (`Serializable`, max 3 retries).
- AuditLog for each payment and status transition.

**Suggested Commit:** `feat(payments): implement idempotent split payments with cash handling`

---

### Task 16: PENDING_PAYMENT → PAID Transition (Integration)

**Objective:** Ensure the sale status transition from `PENDING_PAYMENT` to `PAID` works correctly as part of `registerPayment` (covered in Task 15) and add explicit transition endpoint for testing.

**Dependencies:** Task 15.

**Files/Directories:**
- Modify: `api/src/modules/sales/sales.service.ts` (ensure transition logic is tested in isolation)
- Create: `api/tests/sales/paid-transition.test.ts`

**Implementation Steps:**
- [ ] No new code — transition logic is in `payments.service.ts` (Task 15).
- [ ] Write integration tests verifying the transition:
  - Multiple payments summing to total → PAID.
  - Overpayment not allowed (amount > remaining).
  - Payment on non-PENDING_PAYMENT sale → 409.

**Tests (write first):**
- [ ] `api/tests/sales/paid-transition.test.ts`: as above.

**Verification Commands:**
```bash
cd api && npm run test -- tests/sales/paid-transition.test.ts
```

**Expected Result:** Sale transitions to PAID exactly when accepted payments equal total.

**Acceptance Criteria:**
- Covered by Task 15 tests; this task ensures explicit test coverage for the transition invariant.

**Suggested Commit:** `test(sales): cover PAID transition invariant`

---

### Task 17: PAID → COMPLETED — Transactional Inventory Finalization

**Objective:** Implement `POST /sales/:id/complete` — only for `PAID` sales, locks inventory, decrements `physical` and `reserved`, consumes reservations, creates `StockMovement(SALE)`, transitions to `COMPLETED`.

**Dependencies:** Task 12, Task 15.

**Files/Directories:**
- Modify: `api/src/modules/sales/sales.service.ts`, `sales.controller.ts`, `sales.routes.ts`
- Create: `api/src/modules/sales/completion.service.ts`

**Implementation Steps:**
- [ ] Implement `completion.service.ts`:
  - `completeSale(saleId, userId)`: runs in Prisma interactive transaction (`isolationLevel: 'Serializable'`):
    1. Lock the `Sale` row via raw SQL (`tx.$queryRaw` `SELECT ... FROM "Sale" WHERE id = ${saleId} FOR UPDATE`), then load `SaleItem` and `StockReservation` where `saleId` and `status = 'ACTIVE'`; lock the required `Inventory` rows via raw SQL `SELECT ... FOR UPDATE` in deterministic order (`ORDER BY id ASC`), same pattern as Task 12.
    2. Status gate **under the row lock**:
       - `status === 'PAID'` → proceed with finalization.
       - `status === 'COMPLETED'` → commit and return the persisted, already-completed sale verbatim; perform **zero** inventory changes, **zero** reservation changes, **zero** new `StockMovement` rows.
       - any other state (`DRAFT`, `PENDING_PAYMENT`, `CANCELLED`) → 409 invalid transition.
    3. Validate all `StockReservation` are `ACTIVE` (not expired/consumed — `expiresAt` is ignored for PAID sales; see Task 19).
    4. For each item: validate `Inventory.reserved >= quantity` and `Inventory.physical >= quantity`.
    5. Decrement: `Inventory.physical -= quantity`, `Inventory.reserved -= quantity`.
    6. Update `StockReservation`: `status = 'CONSUMED'`.
    7. Create `StockMovement` for each item: `type: 'SALE'`, `quantityDelta: -quantity`, `saleId`, `userId`, `branchId`. This is the **only** step in Demo V2 where a `StockMovement` is written (see Task 18 invariant).
    8. Update `Sale`: `status = 'COMPLETED'`.
    9. Write `AuditLog`: `action: 'SALE_COMPLETED'`.
- [ ] **Critical:** If transaction fails (e.g., concurrent modification, insufficient stock after lock), sale remains `PAID`, payments persist, reservations remain `ACTIVE`, inventory unchanged. Cashier retries `completeSale`.
- [ ] Add endpoint `POST /sales/:id/complete` with `requirePermission(SALE_COMPLETE, { branchScope: 'own' })`.
- [ ] Idempotency: **no client-generated key**. Business safety comes from the locked persisted `Sale.status`: the first transaction that flips `PAID → COMPLETED` holds the `FOR UPDATE` row lock, so any duplicate/concurrent call blocks, then observes `COMPLETED` and returns the authoritative sale without touching inventory, reservations, or stock movements. Exactly one physical finalization can ever occur per sale.

**Tests (write first):**
- [ ] `api/tests/sales/completion.test.ts`:
  - Happy path: PAID → COMPLETED, physical/reserved decremented, reservations CONSUMED, StockMovement created.
  - Sequential duplicate: second `completeSale` call → returns the already-COMPLETED sale (200); inventory unchanged on the second call, no extra `StockMovement`, reservations stay `CONSUMED`.
  - Concurrent completion: N parallel `completeSale` calls → exactly one performs finalization; the rest return the COMPLETED sale; `physical`/`reserved` decremented exactly once; exactly one `StockMovement` set exists.
  - Failure mid-transaction: sale remains PAID, inventory unchanged, retry works.
  - Expired reservation: if reservation `expiresAt < now()` but status `ACTIVE` → still consumable (PAID sale must not lose reservation due to expiry).

**Verification Commands:**
```bash
cd api && npm run test -- tests/sales/completion.test.ts
```

**Expected Result:** Complete sale atomically finalizes inventory, consumes reservations, creates movements.

**Acceptance Criteria:**
- Single transaction with `Serializable` isolation + row locks.
- `physical` and `reserved` both decremented by quantity.
- `StockReservation` → `CONSUMED`.
- `StockMovement` type `SALE` with negative delta.
- Sale → `COMPLETED`.
- Exactly one physical finalization per sale: duplicate (sequential or concurrent) calls return the already-COMPLETED sale with zero inventory/reservation/movement changes.
- **PAID sale reservations never auto-expire** — `expiresAt` only for `PENDING_PAYMENT` cleanup; completion consumes regardless of `expiresAt`.

**Suggested Commit:** `feat(sales): implement transactional sale completion with inventory finalization`

---

### Task 18: StockMovement Invariant — Physical Changes Only

**Objective:** Enforce the StockMovement invariant: a `StockMovement` row represents a **physical** stock change. In Demo V2 the **only** operation that creates one is `completeSale` (Task 17, `type = SALE`, `quantityDelta = -quantity`).
Reservation lifecycle changes (Task 12 reserve; Task 19 cancel/expiry; transitions to `ACTIVE`/`RELEASED`/`CONSUMED`) touch `reserved` only, keep `physical` unchanged, and are traced via `StockReservation` status plus `AuditLog`.
Those paths must never write `StockMovement` rows.

**Dependencies:** Task 17.

**Files/Directories:**
- Verify: `api/src/modules/sales/completion.service.ts` creates `StockMovement` exactly once per item.
- Verify: `api/src/modules/sales/reservation.service.ts` (Task 12) and `cancellation.service.ts` (Task 19) create **no** `StockMovement`.

**Implementation Steps:**
- [ ] Verify `StockMovement(type: 'SALE', quantityDelta: -qty)` is created in `completeSale` (Task 17) exactly once per item.
- [ ] Verify the reservation paths — `reserveStockForSale` (Task 12), `cancelSale`, and the expiry sweeper (Task 19) —
      create zero `StockMovement` rows, asserting row counts in their tests.
- [ ] No separate endpoint — movements are side effects of operations.
- [ ] Add `GET /inventory/movements` for audit/history (optional for Demo V2, but useful for admin).

**Tests:** Covered by Task 12, Task 17, and Task 19 tests (all assert StockMovement counts explicitly).

**Verification Commands:**
```bash
cd api && npm run test -- tests/sales/completion.test.ts tests/sales/send-to-cashier.test.ts tests/sales/cancellation.test.ts
```

**Expected Result:** Every **physical** inventory change has a corresponding `StockMovement`; reservation lifecycle events never do.

**Acceptance Criteria:**
- `StockMovement` is created **only** by `completeSale` (Task 17).
- Reservation creation, cancellation, and expiry paths (Tasks 12, 19) write none — their auditability comes from `StockReservation` status + `AuditLog`.
- Fields: `inventoryId`, `type`, `quantityDelta`, `saleId?`, `userId`, `branchId`, `timestamp`.

**Suggested Commit:** `feat(inventory): enforce StockMovement invariant for physical changes only`

---

### Task 19: Reservation Cancellation / Release

**Objective:** Implement cancellation/expiry handling for reservations — decrements `Inventory.reserved`, marks
`StockReservation.RELEASED`, writes `AuditLog` in the same transaction.
`physical` is untouched and **no `StockMovement` is created** (lifting a hold is not a physical movement — see Task 18 invariant).

**Dependencies:** Task 12, Task 17.

**Files/Directories:**
- Create: `api/src/modules/sales/cancellation.service.ts`
- Modify: `api/src/modules/sales/sales.service.ts`, `sales.controller.ts`, `sales.routes.ts`

**Implementation Steps:**
- [ ] Implement `cancellation.service.ts`:
  - `cancelSale(saleId, userId)`: transaction:
    1. Lock the `Sale` row (`tx.$queryRaw` `SELECT ... FOR UPDATE`) and compute `acceptedPaymentTotal = SUM(SalePayment.amount)` for the sale — both inside the transaction.
    2. Cancellation matrix (persisted locked state only):
       - `DRAFT` → allowed (no reservations exist; nothing to release).
       - `PENDING_PAYMENT` **and** `acceptedPaymentTotal == 0` → allowed; release `ACTIVE` reservations.
       - `PENDING_PAYMENT` **and** `acceptedPaymentTotal > 0` → **409 `PAYMENT_ALREADY_ACCEPTED`**; nothing changes.
       - `PAID`, `COMPLETED`, `CANCELLED` → 409 invalid transition.
    3. When allowed on a `PENDING_PAYMENT` sale: for each `ACTIVE` reservation decrement `Inventory.reserved` and set `StockReservation.status = 'RELEASED'` (`physical` untouched; no stock movement written).
    4. Update `Sale.status = 'CANCELLED'`.
    5. Write `AuditLog`: `action: 'SALE_CANCELLED'` (include released quantities).
  - **Invariant:** a sale that has any accepted `SalePayment` can never reach `CANCELLED`. Refunds, reversals, chargebacks, and any payment compensation are **out of scope** for Demo V2 — a partially paid sale can only move forward (complete after full payment), never be cancelled.
- [ ] Implement `releaseExpiredReservations()` (manual, for admin/script): releases a reservation only when **all** hold — `StockReservation.status == 'ACTIVE'`, `expiresAt < now()`, parent `Sale.status == 'PENDING_PAYMENT'`, and the sale's `acceptedPaymentTotal == 0` (lock each candidate's Sale row `FOR UPDATE` before mutating; skip if any condition fails).
  - A `PENDING_PAYMENT` sale with **any** accepted `SalePayment` → never released by expiry.
  - A `PAID` sale → never released by expiry; its `ACTIVE` reservation remains valid for `completeSale` regardless of a past `expiresAt`, and completion consumes it (`ACTIVE` → `CONSUMED`, Task 17).
- [ ] Add endpoints: `POST /sales/:id/cancel` (SELLER/MANAGER/ADMIN), `POST /admin/reservations/release-expired` (ADMIN).
- [ ] **Important:** A `PAID` sale's reservations are **never** released by expiry — they are only consumed by `completeSale` (Task 17).

**Tests (write first):**
- [ ] `api/tests/sales/cancellation.test.ts`:
  - Cancel `DRAFT` → allowed, no reservations involved.
  - Cancel `PENDING_PAYMENT` with zero accepted payments → allowed; reservations become `RELEASED`, `reserved` decremented, `physical` unchanged, sale becomes `CANCELLED`.
  - Cancel `PENDING_PAYMENT` with an accepted partial payment → 409 `PAYMENT_ALREADY_ACCEPTED`; sale, reservations, and inventory all unchanged.
  - Cancel `PAID` → 409; cancel `COMPLETED` → 409.
  - Invariant assertion: after every cancellation scenario, no `CANCELLED` sale exists with any `SalePayment` row.
  - Expiry sweep on `PENDING_PAYMENT` + zero payments + `expiresAt < now()` → reservation released.
  - Expiry sweep on `PENDING_PAYMENT` + partial payment + `expiresAt < now()` → **not** released; reservation stays `ACTIVE`.
  - Expiry sweep on `PAID` reservation past `expiresAt` → **not** released.
  - `PAID` sale past `expiresAt` followed by `completeSale` → succeeds; reservation ends `CONSUMED` (Task 17 interplay).

**Verification Commands:**
```bash
cd api && npm run test -- tests/sales/cancellation.test.ts
```

**Expected Result:** Reservations released correctly on cancellation; PAID sales immune to expiry.

**Acceptance Criteria:**
- Cancellation only from `DRAFT`, or from `PENDING_PAYMENT` with zero accepted payments; partial payments block cancellation with 409 `PAYMENT_ALREADY_ACCEPTED`.
- On cancel/expiry, `reserved` decreases and `physical` stays untouched.
- `StockReservation` → `RELEASED`.
- AuditLog written (same transaction).
- Cancellation/expiry writes **no `StockMovement` rows** (asserted in tests).
- Expiry sweep never touches sales with accepted payments or `PAID` sales.
- PAID sale reservations remain ACTIVE until completion.

**Suggested Commit:** `feat(sales): add reservation cancellation and manual expiry release`

---

### Task 20: AuditLog for Critical Operations

**Objective:** Ensure all critical operations write `AuditLog` entries in the same transaction (already partially done; verify and complete).

**Dependencies:** Task 7, Task 12, Task 15, Task 17, Task 19.

**Files/Directories:**
- Create: `api/src/shared/audit.ts` (audit helper)
- Verify: All service files write audit in their transactions.

**Implementation Steps:**
- [ ] Create `audit.ts` helper: `createAuditLog(prisma, { userId, branchId, action, entityType, entityId, before?, after? })` — uses `prisma.auditLog.create()`.
- [ ] Verify AuditLog written in same transaction for:
  - User login (Task 7) — optional.
  - Sale created (DRAFT) — Task 11.
  - Sale sent to cashier (PENDING_PAYMENT) — Task 12.
  - Payment registered — Task 15.
  - Sale completed (COMPLETED) — Task 17.
  - Sale cancelled — Task 19.
  - Reservation released — Task 19.
  - Cash session opened/closed — Task 14.
  - Inventory changed (manual adjustments — out of scope, but completion creates movement).
- [ ] Ensure `before`/`after` are run through `toJsonSafe` **before** `prisma.auditLog.create(...)`: `AuditLog.before/after` are Prisma `Json` columns and must never receive native `bigint` (monetary values are stored as decimal strings inside the JSON).
- [ ] Add `GET /audit` endpoint (ADMIN only) for viewing logs.

**Tests (write first):**
- [ ] `api/tests/audit/audit.test.ts`: verify audit entries exist for each critical operation with correct fields.

**Verification Commands:**
```bash
cd api && npm run test -- tests/audit/
```

**Expected Result:** All critical operations have audit trail in same transaction.

**Acceptance Criteria:**
- AuditLog entries created atomically with business operation.
- Fields: `userId`, `branchId`, `action`, `entityType`, `entityId`, `before`, `after`, `timestamp`.
- No secrets in audit.
- BigInt serialized as strings in JSON.

**Suggested Commit:** `feat(audit): ensure AuditLog for all critical operations`

---

### Task 21: Socket.IO Branch Rooms and Post-Commit Notifications

**Objective:** Implement Socket.IO server with branch-scoped rooms, emit events after database commit for realtime UI updates.

**Dependencies:** Task 3 (Socket.IO server), Task 7 (auth), Task 12, Task 15, Task 17.

**Files/Directories:**
- Create: `api/src/realtime/socket.ts`, `api/src/realtime/events.ts`, `api/src/realtime/guards.ts`
- Modify: `api/src/server.ts` (initialize Socket.IO), `api/src/modules/sales/completion.service.ts`, `payments.service.ts`, `cancellation.service.ts` (emit after commit)

**Implementation Steps:**
- [ ] Define event types in `events.ts`: `sale.pending_payment`, `sale.paid`, `sale.completed`, `sale.cancelled`, `inventory.updated`.
- [ ] Implement `socket.ts`:
  - Initialize Socket.IO on HTTP server.
  - Authentication: client sends `Authorization` header or auth token in handshake; verify JWT, take `sub` as `userId`, then **resolve the user's current roles and branches from PostgreSQL** (`UserBranchRole` + permissions) before joining any room. The JWT alone never authorizes room membership.
  - Room joining: `socket.join('branch:<branchId>')` only for branches present in that DB-resolved set (ADMIN with the global permission may join any branch room).
  - Authorization guard: a client-requested room name is never trusted — membership comes exclusively from the DB-resolved branch set.
- [ ] **Post-commit emission pattern (the only Demo V2 mechanism):** every transactional service returns an event descriptor from the awaited transaction; the HTTP handler (outside the transaction) emits it. Because `await prisma.$transaction(...)` only resolves after COMMIT has succeeded, the emission below is guaranteed post-commit:

    ```typescript
    // Inside the service
    const result = await prisma.$transaction(async (tx) => {
      // ...transactional business operation...
      return { branchId, eventType: 'sale.paid', payload: { saleId, saleNumber, status: 'PAID' } };
    }, { isolationLevel: 'Serializable' });
    // Transaction has COMMITTED here.
    io.to(`branch:${result.branchId}`).emit(result.eventType, result.payload);
    ```

  - Explicitly **not** used: `prisma.$on('query')`-style fake post-commit hooks, network calls inside a transaction, or a persisted outbox table. The outbox is a **future** pattern reserved for durable external integrations (e.g. ARCA), not for Demo V2 socket notifications.
  - Emit failure handling: if `io.emit` throws or no client receives the event, nothing is rolled back and no business state is mutated — PostgreSQL is already committed and authoritative; clients recover by REST refetch. Events are notification/invalidation hints only.
- [ ] Emit events in callers **after** transaction commits:
  - `sendToCashier` → `sale.pending_payment` to `branch:<branchId>`.
  - `registerPayment` (when PAID) → `sale.paid` to `branch:<branchId>`.
  - `completeSale` → `sale.completed` + `inventory.updated` to `branch:<branchId>`.
  - `cancelSale` → `sale.cancelled` + `inventory.updated`.
- [ ] Payload includes minimal info: `saleId`, `saleNumber`, `branchId`, `status`, `items[]` (for inventory updates); every payload passes through `toJsonSafe` before emit, so money arrives as decimal strings and no native `bigint` crosses the socket boundary.

**Tests (write first):**
- [ ] `api/tests/realtime/socket.test.ts`: connect with valid token, join branch room, receive event after operation.
- [ ] `api/tests/realtime/auth.test.ts`: invalid token → disconnect; user cannot join other branch room.

**Verification Commands:**
```bash
cd api && npm run test -- tests/realtime/
```

**Expected Result:** Realtime events emitted after commit to authorized branch rooms.

**Acceptance Criteria:**
- Socket.IO handshake authenticates via JWT (`sub` only) and then resolves roles/branches from PostgreSQL.
- Users join only their DB-resolved branch rooms (ADMIN all, via permission).
- Events emitted **after** DB commit (not during transaction).
- Events: `sale.pending_payment`, `sale.paid`, `sale.completed`, `sale.cancelled`, `inventory.updated`.
- Emission happens strictly outside the committed transaction (awaited `$transaction` return → `io.to(...).emit(...)`).
- Emit failure never rolls back or mutates committed state; a missed/delayed event is recovered by client REST refetch.

**Suggested Commit:** `feat(realtime): add Socket.IO branch rooms and post-commit notifications`

---

### Task 22: SELLER UI in client/ — Bootstrap + Draft Sale Flow

**Objective:** Bootstrap clean Next.js 16 App Router app and implement SELLER screens: login, branch selection, product/variant search, draft sale cart, send-to-cashier.

**Dependencies:** Task 1, Task 3 (API running), Task 11 (draft API), Task 12 (send-to-cashier API).

**Files/Directories:**
- Create: `client/` (Next.js 16 app via `create-next-app` or manual), `client/src/app/(auth)/login/page.tsx`, `client/src/app/(seller)/layout.tsx`, `client/src/app/(seller)/pos/page.tsx`, `client/src/app/(seller)/sales/page.tsx`, `client/src/components/ui/*` (port from legacy), `client/src/lib/api.ts`, `client/src/lib/auth.ts`, `client/src/lib/utils.ts` (port `cn`), `client/src/hooks/useSale.ts`, `client/src/hooks/useAuth.ts`, `client/src/store/saleStore.ts` (Zustand), `client/src/types/api.ts`
- Port from `../Tesis/client/src/components/ui/*`: button, input, select, dialog, badge, card, table, tooltip, skeleton, label, checkbox, separator, avatar, popover, tabs, switch, radio-group, collapsible, alert-dialog, sonner.
- Port from `../Tesis/client/src/lib/utils.ts`: `cn()`.
- Port currency formatting from `../Tesis/client/src/components/common/PriceContainer.tsx` or similar.

**Implementation Steps:**
- [ ] Bootstrap `client/` with Next.js 16, TypeScript, Tailwind 4, ESLint, Prettier.
- [ ] Install deps: `next@16`, `react@19`, `react-dom@19`, `tailwindcss@4`, `@radix-ui/*`, `zustand`, `react-hook-form`, `@hookform/resolvers`, `zod`, `sonner`, `lucide-react`, `date-fns`, `clsx`, `tailwind-merge`, `class-variance-authority`.
- [ ] Copy shadcn UI primitives from `../Tesis/client/src/components/ui/` to `client/src/components/ui/`.
- [ ] Copy `cn` utility.
- [ ] Implement auth: login page calls `POST /auth/login`, stores the access token in memory (React context) only — no refresh cookie, no refresh flow. On any 401 (expired/invalid token) the client discards the token and returns the user to the login screen.
- [ ] Implement seller layout: branch display (from user context), logout.
- [ ] Implement POS page (`/pos`):
  - Search bar (SKU, barcode, name) → calls `GET /variants?search=...&branchId=...`.
  - Variant selector modal (port from `../Tesis/admin/src/pages/POS.tsx`): color/size grid, stock badges.
  - Cart sidebar: items, quantities, subtotal, total.
  - "ENVIAR A CAJA" button → calls `POST /sales/:id/send-to-cashier`.
  - Real-time: listen for `sale.pending_payment` to confirm.
- [ ] Implement sales history page (`/sales`): list own drafts and sent sales with status.
- [ ] Socket.IO client connection with auth token, join branch room.

**Tests (write first):**
- [ ] `client/tests/pos.test.tsx`: (component tests with React Testing Library) — search, add to cart, send to cashier.
- [ ] E2E test (Playwright or manual): two-browser demo flow.

**Verification Commands:**
```bash
cd client && npm run dev         # starts on port 3000
cd client && npm run build       # compiles
cd client && npm run lint        # passes
```

**Expected Result:** SELLER can login, search products, build cart, send to cashier.

**Acceptance Criteria:**
- Clean Next.js 16 build, no ecommerce routes.
- Shadcn UI primitives work.
- POS interaction mirrors legacy admin/POS.tsx flow but backed by API.
- Draft sale persists on server.
- Send-to-cashier triggers reservation and realtime event.
- Money displayed as ARS with cents: minor units formatted for display (e.g. `16500000` centavos → `$165.000,00`).

**Suggested Commit:** `feat(client): bootstrap Next.js 16 + SELLER POS flow`

---

### Task 23: CASHIER UI in client/ — Pending Queue + Split Payments + Completion

**Objective:** Implement CASHIER screens in the same `client/` app: pending sales queue, payment modal with split payments, cash change calculation, sale completion.

**Dependencies:** Task 22, Task 13, Task 15, Task 17.

**Files/Directories:**
- Create: `client/src/app/(cashier)/layout.tsx`, `client/src/app/(cashier)/queue/page.tsx`, `client/src/app/(cashier)/payment/[saleId]/page.tsx`, `client/src/hooks/useCashier.ts`, `client/src/components/cashier/*`
- Reuse: `client/src/components/ui/*`, `client/src/lib/*`

**Implementation Steps:**
- [ ] Cashier layout: branch display, open cash session button (if not open), logout.
- [ ] Queue page (`/queue`): list `GET /sales/pending` with realtime updates (`sale.pending_payment`, `sale.paid`, `sale.completed`).
- [ ] Payment page (`/payment/:saleId`):
  - Shows sale details, items, total, paid amount, remaining.
  - Payment method selector: Efectivo, Transferencia, Débito, Crédito, QR.
  - For Efectivo: input `receivedAmount`, auto-calculate `changeAmount = receivedAmount - remaining`.
  - Add payment button → `POST /sales/:id/payments` with idempotency key (generate UUID client-side).
  - Payment list shows registered payments.
  - When remaining = 0: enable "FINALIZAR VENTA" → `POST /sales/:id/complete`.
  - Realtime: listen for `sale.paid`, `sale.completed`.
- [ ] Cash session management: open/close session modals.

**Tests (write first):**
- [ ] `client/tests/cashier.test.tsx`: queue loads, payment modal, split payment, cash change, completion.

**Verification Commands:**
```bash
cd client && npm run dev
# Manual two-browser test: SELLER creates sale → CASHIER pays → completes
```

**Expected Result:** CASHIER can process pending sales with split payments and complete them.

**Acceptance Criteria:**
- Queue shows real-time pending sales.
- Split payments: multiple methods, amounts sum to total.
- Cash: receivedAmount ≥ amount, changeAmount calculated and shown.
- Payment idempotency: retry same payment doesn't duplicate.
- Complete button only enabled when fully paid.
- Completion triggers inventory finalization.
- Realtime updates reflect status changes.

**Suggested Commit:** `feat(client): add CASHIER queue, split payments, and completion`

---

### Task 24: Backoffice Read API (admin/ data dependencies)

**Objective:** Implement the minimum read-only backend endpoints the `admin/` frontend consumes — explicitly defined before the admin UI, which must reference only endpoints that already exist here. No CRUD.

**Dependencies:** Task 8, Task 9, Task 10, Task 13, Task 15, Task 17.

**Files/Directories:**
- Create: `api/src/modules/backoffice/` with `backoffice.routes.ts`, `backoffice.controller.ts`, `backoffice.service.ts`
- Modify: `api/src/app.ts` (mount routes)

**Implementation Steps:**
- [ ] Implement `backoffice.service.ts`:
  - `listSales(query)`: recent/completed sales with filters (date range, branchId, sellerId) and pagination; includes payment summary.
  - `getSale(id)`: sale detail with items, payments (and cash movements where applicable).
  - `getInventory(query)`: per-branch stock (`physical`, `reserved`, computed `available`).
  - `listBranches()`: read-only branch list.
  - `listUsers()`: read-only user list with roles/branches (never credentials or hashes).
  - `getDashboardSummary()`: minimal aggregates (sales today, pending count, revenue today, low-stock count).
- [ ] Routes, mounted under `/api/v1/backoffice`:
  - `GET /api/v1/backoffice/sales` — `REPORT_VIEW`
  - `GET /api/v1/backoffice/sales/:id` — `REPORT_VIEW` (branch derived from the persisted `Sale` row)
  - `GET /api/v1/backoffice/inventory` — `REPORT_VIEW`
  - `GET /api/v1/backoffice/branches` — `REPORT_VIEW`
  - `GET /api/v1/backoffice/users` — `USER_MANAGE` (ADMIN only in Demo V2 seed)
  - `GET /api/v1/backoffice/dashboard` — `REPORT_VIEW`
- [ ] Branch scoping: optional `branchId` filter validated via `assertBranchAccess` (Task 8); without it, results are restricted to the caller's DB-resolved branches. MANAGER sees only assigned branch(es); ADMIN sees all **via permission**. A client `branchId` is never trusted on its own.
- [ ] All payloads pass through `toJsonSafe` (money as decimal strings).

**Tests (write first):**
- [ ] `api/tests/backoffice/backoffice.test.ts`: MANAGER restricted to own branch (extra `branchId` → 403); ADMIN global; SELLER/CASHIER → 403 (no `REPORT_VIEW`); `/users` requires `USER_MANAGE`; sale detail for another branch → 403.

**Verification Commands:**
```bash
cd api && npm run test -- tests/backoffice/
```

**Expected Result:** Every `admin/` screen maps to an existing, permission-guarded read endpoint.

**Acceptance Criteria:**
- The six routes above exist and respond with JSON-safe payloads.
- Read-only module: no write endpoints.
- MANAGER branch-limited, ADMIN global — both resolved from PostgreSQL.
- Demo V2 admin screens (Dashboard, SalesHistory, Inventory, Users, Branches) are fully backed by these routes.

**Suggested Commit:** `feat(backoffice): add read-only reporting endpoints for admin`

---

### Task 25: Minimum MANAGER/ADMIN Backoffice in admin/

**Objective:** Bootstrap clean Vite + React + TypeScript app and implement read-only admin views: dashboard, sales history, inventory, users/branches (read-only).

**Dependencies:** Task 1, Task 3, Task 7, Task 24.

**Files/Directories:**
- Create: `admin/` (Vite + React + TS via `npm create vite@latest`), `admin/src/App.tsx`, `admin/src/main.tsx`, `admin/src/components/Sidebar.tsx` (port from legacy), `admin/src/components/Header.tsx` (port), `admin/src/components/ErrorBoundary.tsx` (port), `admin/src/components/ui/*` (port shadcn from legacy admin), `admin/src/lib/utils.ts` (port `cn`), `admin/src/lib/api.ts`, `admin/src/lib/auth.ts`, `admin/src/hooks/useAuth.ts`, `admin/src/pages/Dashboard.tsx`, `admin/src/pages/SalesHistory.tsx`, `admin/src/pages/Inventory.tsx`, `admin/src/pages/Users.tsx`, `admin/src/pages/Branches.tsx`, `admin/src/pages/Login.tsx`
- Port from `../Tesis/admin/src/components/ui/*`: button, card, table, dialog, input, select, badge, label, tabs, skeleton, sonner, form, separator, checkbox, textarea, alert-dialog.
- Port from `../Tesis/admin/src/components/Sidebar.tsx`, `Header.tsx`, `ErrorBoundary.tsx`.
- Retire: `mockData.ts`, `useSalesStore`, `useStockStore`, `useAuthStore` (replace with API-bound state).

**Implementation Steps:**
- [ ] Bootstrap `admin/` with Vite 7, React 19, TypeScript, Tailwind 4.
- [ ] Install deps: `react@19`, `react-dom@19`, `react-router@7`, `zustand`, `react-hook-form`, `@hookform/resolvers`, `zod`, `@radix-ui/*`, `sonner`, `lucide-react`, `recharts`, `clsx`, `tailwind-merge`, `class-variance-authority`, `axios` or fetch wrapper.
- [ ] Copy UI primitives from `../Tesis/admin/src/components/ui/`.
- [ ] Copy `Sidebar`, `Header`, `ErrorBoundary`, `App` shell — adapt for new roles (MANAGER/ADMIN) and API endpoints.
- [ ] Implement auth: login page → `POST /auth/login`, store tokens.
- [ ] Dashboard → consumes `GET /api/v1/backoffice/dashboard` (summary cards).
- [ ] Sales History → `GET /api/v1/backoffice/sales` (+ `GET /api/v1/backoffice/sales/:id` detail); filters: date, branch, seller; pagination.
- [ ] Inventory → `GET /api/v1/backoffice/inventory` (per-branch stock, search/filter).
- [ ] Users → `GET /api/v1/backoffice/users` (hide/disable screen when 403/permission missing); Branches → `GET /api/v1/backoffice/branches`.
- [ ] No other API endpoints may be called from this app — especially not the operations routes under `/api/v1/sales` or `/api/v1/inventory`.
- [ ] Role-based route guards: MANAGER sees own branch; ADMIN sees all (server remains authoritative regardless).

**Tests:**
- [ ] `admin/tests/` — component tests for key pages (optional for Demo V2).

**Verification Commands:**
```bash
cd admin && npm run dev      # starts on port 5173
cd admin && npm run build    # compiles
cd admin && npm run lint     # passes
```

**Expected Result:** Admin backoffice shows completed sales, inventory, basic dashboard.

**Acceptance Criteria:**
- Clean Vite build, no localStorage stores, no mockData.
- Shell (Sidebar/Header) portable from legacy.
- MANAGER scoped to branch; ADMIN global.
- Sales history shows completed sales with items, payments, totals.
- Inventory shows per-branch availability.
- Every screen consumes only Task 24 backoffice endpoints.
- Realtime updates optional but nice.

**Suggested Commit:** `feat(admin): bootstrap Vite + MANAGER/ADMIN backoffice`

---

### Task 26: Deterministic Demo V2 Reset Script

**Objective:** Create a single command to reset the entire Demo V2 environment (database + seed) for reproducible demos.

**Dependencies:** Task 5, Task 22, Task 23, Task 25.

**Files/Directories:**
- Create: `scripts/demo-reset.sh`, `scripts/demo-seed.sh` (root level), or add to `api/scripts/`.

**Implementation Steps:**
- [ ] Create root `scripts/demo-reset.sh`:
  - Stops any running dev servers (optional).
  - Runs `cd api && npm run db:reset`.
  - Optionally clears client/admin build caches.
- [ ] Create `scripts/demo-seed.sh` for seed only.
- [ ] Document in `README.md` and `docs/development/demo-reset.md`.
- [ ] Verify reset works from clean state.

**Tests:** Manual verification.

**Verification Commands:**
```bash
./scripts/demo-reset.sh
cd api && npx prisma studio  # verify clean seed state
```

**Expected Result:** One command resets database to known Demo V2 state.

**Acceptance Criteria:**
- `demo-reset.sh` runs without errors.
- Database matches seed exactly.
- Demo users can login immediately after reset.

**Suggested Commit:** `chore(demo): add deterministic reset and seed scripts`

---

### Task 27: Two-Browser End-to-End Demo Scenario

**Objective:** Verify the complete Demo V2 main scenario works across two browser sessions.

**Dependencies:** Task 22, Task 23, Task 25, Task 26.

**Files/Directories:** None (verification only).

**Implementation Steps:**
- [ ] Start API (`cd api && npm run dev`).
- [ ] Start Client (`cd client && npm run dev`).
- [ ] Start Admin (`cd admin && npm run dev`).
- [ ] **Browser A (SELLER):** Open `http://localhost:3000`, login `seller01` / `demo123`, branch Centro.
  - Search "Remera Básica", select Negro/M, qty 2.
  - Search "Jean Slim", select Azul/42, qty 1.
  - Verify total: ARS 165.000,00 (minor units: `16500000`).
  - Press "ENVIAR A CAJA".
  - Verify sale shows as `PENDING_PAYMENT` in seller's history.
- [ ] **Browser B (CASHIER):** Open `http://localhost:3000`, login `cashier01` / `demo123`, branch Centro.
  - Open cash session (starting cash ARS 100.000,00 = `10000000` minor units).
  - Queue shows the pending sale.
  - Open sale, register Transfer ARS 100.000,00 (`"10000000"` in the API payload).
  - Register Cash ARS 65.000,00 (`"6500000"`; received 65.000,00, change 0).
  - Verify sale becomes `PAID`.
  - Press "FINALIZAR VENTA".
  - Verify sale becomes `COMPLETED`.
- [ ] **Browser A (SELLER):** Refresh history — sale shows `COMPLETED`, stock updated.
- [ ] **Browser C (ADMIN):** Open `http://localhost:5173`, login `admin` / `demo123`.
  - Dashboard shows sale completed.
  - Inventory shows decremented stock.
  - Audit log shows full trail.

**Tests:** Manual E2E verification (documented).

**Verification Commands:** As above.

**Expected Result:** Complete vertical flow works end-to-end with persisted PostgreSQL state.

**Acceptance Criteria:** All steps in AGENTS.md "Demo V2 Main Scenario" work exactly as specified.

**Suggested Commit:** `docs: verify Demo V2 end-to-end scenario`

---

### Task 28: Final Verification — Automated Test Suite + Build + Lint

**Objective:** Run full test suite, build all apps, lint, typecheck to certify Demo V2 readiness.

**Dependencies:** All previous tasks.

**Files/Directories:** None.

**Implementation Steps:**
- [ ] Run `api` tests: `cd api && npm run test` — all pass.
- [ ] Run `client` build/lint: `cd client && npm run build && npm run lint && npm run typecheck`.
- [ ] Run `admin` build/lint: `cd admin && npm run build && npm run lint`.
- [ ] If the optional minimal root `package.json` exists (Task 1), run its aggregate verification script; otherwise the per-app commands above are sufficient. No CI gate is required for Demo V2.
- [ ] Verify no secrets in codebase: `git grep -r "password\|secret\|key" -- "*.ts" "*.tsx" "*.json" | grep -v ".example" | grep -v "test" | grep -v "placeholder"`.

**Tests:** Full test suites.

**Verification Commands:**
```bash
cd api && npm run test
cd client && npm run build && npm run lint
cd admin && npm run build && npm run lint
git status --short  # verify no untracked secrets/generated files
```

**Expected Result:** All tests pass, all builds succeed, no lint/type errors, no secrets committed.

**Acceptance Criteria:**
- API: 100% critical path test coverage (auth, RBAC, sales, payments, completion, concurrency).
- Client: builds, lints, typechecks.
- Admin: builds, lints.
- No `.env`, `.next`, `dist`, `node_modules` tracked.
- Demo V2 scenario verified manually.

**Suggested Commit:** `chore: final verification — all tests pass, builds clean`

---

### Task 29: Documentation and Handoff

**Objective:** Finalize documentation for the Demo V2 implementation.

**Dependencies:** Task 28.

**Files/Directories:**
- Create/Update: `README.md`, `docs/development/getting-started.md`, `docs/testing/strategy.md`, `docs/api/endpoints.md`

**Implementation Steps:**
- [ ] Update root `README.md` with: project overview, architecture diagram, quick start (Supabase database setup per `docs/development/database.md`, seed, run all three apps independently), demo credentials, two-browser test instructions.
- [ ] Document API endpoints in `docs/api/endpoints.md` (or OpenAPI/Swagger if added).
- [ ] Document test strategy in `docs/testing/strategy.md`.
- [ ] Key architectural decisions are already recorded in `docs/architecture/mona-demo-v2.md` and its amendments — no separate ADR process is introduced.

**Tests:** None.

**Verification Commands:**
```bash
cat README.md  # verify completeness
```

**Expected Result:** Complete documentation for onboarding and maintenance.

**Acceptance Criteria:**
- README has working quick-start.
- API endpoints documented.
- Test strategy documented.
- Key decisions (BigInt minor-unit money, reservation lifecycle, payment idempotency, DB-resolved authorization) are documented in `docs/architecture/` — no ADR infrastructure required.

**Suggested Commit:** `docs: finalize Demo V2 documentation`

---

## Technical Risk Mitigation Summary

| Risk | Mitigation in Plan |
|------|-------------------|
| PostgreSQL transaction boundaries | Tasks 12, 15, 17 use Prisma `$transaction` with `isolationLevel: 'Serializable'` |
| SELECT ... FOR UPDATE / safe concurrency | Tasks 12, 15, 17: raw SQL `SELECT ... FOR UPDATE` in deterministic order (`ORDER BY id ASC`) inside Prisma interactive transactions; Prisma Client model queries expose no row-lock API, so none is used |
| Overselling protection | Task 12 validates `available >= qty` under lock; Task 17 re-validates |
| Duplicate completeSale | Task 17: Sale row locked `FOR UPDATE`; `COMPLETED` → return authoritative sale with zero changes; exactly one physical finalization |
| registerPayment idempotency | Task 15: `SalePayment @@unique([saleId, idempotencyKey])` (initial migration); same key+payload → existing row, different payload → 409; `P2002` race handled explicitly |
| Payment concurrency on remaining balance | Task 15: Sale row lock serializes acceptance; `amount <= remaining` validated post-lock; `Sale.total` never exceeded |
| Payment idempotency key design | Task 15: client-generated UUID v4 per payment intent, sale-scoped uniqueness |
| BigInt JSON serialization | Task 3: `json-safe.ts` recursive `toJsonSafe` at every JSON boundary (HTTP, Socket.IO, Prisma Json) |
| BigInt-safe AuditLog serialization | Task 20: `toJsonSafe` normalization of `before`/`after` before `auditLog.create` |
| Branch-scoped authorization | Task 8: `requirePermission` + server-derived resource branch (`Sale.branchId` from DB); client `branchId` never trusted |
| JWT carrying stale roles/branches | Task 7/8/21: JWT holds only `sub`; authorization resolved from PostgreSQL per request and per socket handshake |
| OPEN CashSession validation | Task 15: `registerPayment` requires OPEN session for CASH |
| Cash movement in registerPayment, not completeSale | Task 15: `CashMovement(SALE_INCOME)` created at payment time |
| Reservation lifecycle | Task 12 (create ACTIVE), Task 17 (CONSUMED), Task 19 (RELEASED) |
| Expired reservation behavior | Task 19: manual release only; PAID sales immune |
| PAID sale must not lose reservation | Task 17: completion consumes regardless of `expiresAt` |
| Socket.IO emission after commit | Task 21: awaited `$transaction` returns event descriptor; `io.emit` outside the transaction; emit failure never affects committed state |
| WebSocket room authorization | Task 21: handshake auth (JWT `sub`) + DB-resolved branch room guard |
| No network calls in transactions | All tasks: external calls only after commit |
| Sale-number concurrency | Task 12: `SaleNumberCounter` row locked `FOR UPDATE` per branch + `Sale @@unique([branchId, saleNumber])` guard |
| Single OPEN cash session | Task 14 + Task 4: partial unique index `cash_session_one_open_per_register`; `P2002` → 409 |
| Test DB races | Task 6: `fileParallelism: false`; integration tests sequential against a physically isolated, identity-checked Supabase test database |

---

## Money Representation Detail

Money is stored as integer **minor units (centavos)**: the last two digits are decimals. ARS 165,000.00 = `16500000`; ARS 100,000.00 = `10000000`; ARS 65,000.00 = `6500000`. The statement "`165000` means ARS 165,000" is **wrong** and must never appear in code, seeds, tests, or docs.

- **Database (PostgreSQL/Prisma):** `BigInt` minor units. e.g., `16500000` for ARS 165,000.00.
- **API JSON Transport:** **String** (`"16500000"`). Native JSON cannot serialize `BigInt`.
- **Frontend (TypeScript):** Parse string → `bigint` for all arithmetic; convert to `Number` ÷ 100 only at the formatting boundary (safe far beyond Demo V2 amounts: 2^53-1 centavos ≈ ARS 9×10^13). Authoritative arithmetic is always `bigint`.
- **Serialization Helper:** `api/src/shared/json-safe.ts` — one recursive `toJsonSafe(value)` normalizer applied at every JSON boundary (HTTP responses, Socket.IO payloads, Prisma `Json` writes). It handles arbitrarily nested structures, so there is no per-model field list to keep in sync:

```typescript
// toJsonSafe behavior (unit-tested in Task 3)
16500000n                      -> "16500000"      // bigint -> decimal string
[{ total: 16500000n }]         -> [{ total: "16500000" }]
{ at: new Date("2026-01-01") } -> { at: Date }    // preserved; JSON.stringify renders ISO
null / undefined               -> null / undefined
```

The same helper guards `AuditLog.before/after` (Task 20) and Socket.IO payloads (Task 21): native `bigint` must never reach Prisma `Json` fields or `socket.emit`.

---

## Test Isolation Strategy (Documented)

**Problem:** Supertest makes real HTTP requests to the Express server, which uses its own Prisma Client connection pool. A test's Prisma transaction cannot wrap the HTTP request's transaction.

**Solution:** Per-test database truncation plus **sequential execution** of DB-backed tests.
- `vitest.config.ts` sets `fileParallelism: false` (Vitest's explicit switch to run test **files** sequentially in a single process). Rationale: every integration test truncates shared tables; truncation-based isolation is **not** safe if two test files run against the same database concurrently — so they never do.
- `beforeEach`: `await truncateAllTables(testPrisma)` — `TRUNCATE ... RESTART IDENTITY CASCADE` — then create only the fixtures that test needs.
- The test database is a physically separate hosted Supabase PostgreSQL project (`mona-jacinta-test`), never the development/demo project; the test bootstrap proves the two are different database identities via a multi-signal check and fails closed otherwise. It exists for dev/test separation, not parallelism.
- Pure unit tests that never touch PostgreSQL get no special treatment for Demo V2 (they simply run sequentially too); if the suite grows, a separate `vitest.unit.config.ts` without DB setup may re-enable parallelism for pure tests only.
- This ensures full isolation at cost of ~50-100ms per test — acceptable for Demo V2 scope.

**Implementation:** `api/tests/helpers/test-db.ts` exports `truncateAllTables(prisma)` using raw SQL:
```sql
TRUNCATE TABLE "AuditLog", "CashMovement", "CashSession", "CashRegister",
  "SalePayment", "SaleItem", "Sale", "StockReservation", "StockMovement",
  "Inventory", "ProductVariant", "Product", "Category", "Brand",
  "UserBranchRole", "Branch", "RolePermission", "Permission", "Role", "User",
  "SaleNumberCounter" RESTART IDENTITY CASCADE;
```
(Adjust order for FK constraints; `CASCADE` handles dependencies.)

---

## Implementation Order Summary

1. **Repository Hygiene** (Task 1)
2. **Supabase PostgreSQL + Connection Safety** (Task 2)
3. **API Bootstrap** (Task 3)
4. **Prisma Schema** (Task 4)
5. **Seed/Reset** (Task 5)
6. **Test Infrastructure** (Task 6)
7. **Authentication** (Task 7)
8. **RBAC/Branch Scope** (Task 8)
9. **Products/Variants** (Task 9)
10. **Inventory** (Task 10)
11. **Draft Sales** (Task 11)
12. **Send-to-Cashier + Reservation** (Task 12)
13. **Cashier Queue** (Task 13)
14. **Cash Register/Session** (Task 14)
15. **Split Payments** (Task 15)
16. **PAID Transition** (Task 16)
17. **Completion + Inventory Finalization** (Task 17)
18. **StockMovement** (Task 18)
19. **Reservation Release** (Task 19)
20. **AuditLog** (Task 20)
21. **Socket.IO Realtime** (Task 21)
22. **SELLER UI** (Task 22)
23. **CASHIER UI** (Task 23)
24. **Backoffice Read API** (Task 24)
25. **Admin Backoffice** (Task 25)
26. **Demo Reset Scripts** (Task 26)
27. **E2E Demo Verification** (Task 27)
28. **Final Verification** (Task 28)
29. **Documentation** (Task 29)

---

## Out of Scope Reminders

Do NOT implement in this plan:
- ARCA/CAE integration
- Supplier management
- Purchasing module
- Transfers/warehouses
- `inTransit` inventory
- Public ecommerce storefront
- Mobile app
- Advanced reporting
- Microservices/Kubernetes
- Historical MongoDB migration
- Seller discount workflows (field exists, no UI/auth)
- Full Users/Roles/Branches CRUD (read-only OK)
- Refunds, reversals, chargebacks, or any payment compensation (a sale with accepted payments can never be cancelled in Demo V2)
- Outbox-based event delivery (future pattern reserved for durable external integrations such as ARCA; socket events here are post-commit hints only)
- Monorepo tooling: Turborepo, pnpm workspace restructuring, shared ESLint packages, Husky, lint-staged
- Mandatory ADR infrastructure or CI pipelines that gate the vertical slice

---

## Verification After Plan Write

```bash
test -f docs/plans/mona-demo-v2-implementation.md && echo "IMPLEMENTATION_PLAN_EXISTS"
wc -l docs/plans/mona-demo-v2-implementation.md
git status --short
```