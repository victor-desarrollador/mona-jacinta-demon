# PILOT G20 rollout runbook — sale exchange v1 (EXACT_G16 + CATALOG_37 → EXACT_G20 + CATALOG_38)

(The file keeps its historical name `21-g19-…`; the rollout target is now **G20**. The G19 tools stay in the repository as a historical, literal target.)

Status: **`READY_FOR_COMMIT_AND_CI`** (pre-rollout). The THIRD independent audit APPROVED (`READY_FOR_FINAL_GATE`); the final gate passed (below). **PILOT has not been touched.** The HTTP route, the realtime event, the G17 / G18 / G19 / **G20** migrations, `CATALOG_38`, the schema references and the exchange
service were validated on a real, isolated, disposable PostgreSQL 17.11 (LOCAL_TEST). The independent audit (REVISE) was answered: H1, H2, H3, M1, M2 and L1 are fixed
and proven, H4 is formalized as an OWNER trust boundary (architecture A).
The SECOND audit (REVISE) found: `initial-stock` / `cash` retries on a weaker local classifier (H-01), `initial-stock` not Serializable (H-02), the HTTP representation of
`returnQuantity` still accepting JSON numbers (M-01), a stale `pilot-g19-preflight` in the CATALOG_38 COMMIT-UNKNOWN recovery (M-02) and stale comments (L-01). Round R6 closed all five
(table below) and added PostgreSQL proofs of reservations, crossed inventories, same-sale concurrency, replay after a state change and BIGINT aggregation. The third audit approved. What remains is: commit, CI, and then the OWNER's own PILOT window.

> **VALIDATED ON LOCAL_TEST != DEPLOYED TO PILOT.**
> Nothing here was applied to DEV, PILOT, Railway or Vercel. G17 / G18 / G19 / G20 and `CATALOG_38` are prepared and tested, **NOT applied to PILOT**.
> `POST /api/v1/sales/:saleId/exchanges` (201 new / 200 replay) and the post-commit `inventory.updated` exist in code, **not deployed**.
> **PILOT is still untouched.** The next steps are commit + CI; any PILOT step is the OWNER's, by hand, in the order below, after CI is green.

Every step that touches PILOT, Railway or Vercel is run by the OWNER, by hand, in the order below. A step whose expected result line does not appear exactly is a **STOP**.

## Trust boundary (H4, OWNER decision A for V1)

**Raw SQL DML is NOT a supported commercial writer.** The supported writer of an exchange is exactly one path:

`HTTP route → service → ONE Serializable transaction → Inventory + StockMovement ledger + AuditLog (+ the SaleExchange rows)`

What the database guarantees on its own (for any writer): every exchange has lines; every line has its IN and OUT ledger rows with the line's magnitude, on the
right inventories and branch, written by the exchange actor; the exchange ledger is append-only; the remainder per `SaleItem` is never exceeded; the sale is
`COMPLETED`; a sale never has both a `SaleVoid` and a `SaleExchange` (G19 + G20).
What it does **not** guarantee: that `Inventory.physical` moved by the ledger. A raw writer can commit a complete ledger without touching `Inventory` (measured:
`sale-exchange-ledger-balance.pg.test.ts` LB02/LB03 — kept as documentation of the limit, **not** a gate to turn green with triggers). Nobody in the application holds
that path; no trigger updates `Inventory`; G18 is not redesigned (option B was not chosen).
The supported path's atomicity is proven in `sale-exchange.integrity.pg.test.ts`: a failing `StockMovement` insert, a failing `AuditLog` insert (the last write, after the
Inventory update) and a failure on the SECOND line each roll back everything (Inventory, ledger, lines, exchange, claim, audit); a committed cross-swap leaves every
`Inventory.physical` equal to its value before plus the sum of ITS exchange movements; and a `pg_dump -Fc` / `pg_restore --clean` round trip keeps that balance.

## Final gate (LOCAL_TEST, disposable PostgreSQL 17.11 — then torn down)

| Gate | Result |
|---|---|
| Full API suite on LOCAL_TEST (20 migrations + seed) | **4404 passed, 0 failed, 249 skipped, 7 todo** (173 files passed, 19 skipped, 192); 4 min 47 s |
| Focal PostgreSQL | 83/83 in 8 files: service 7, concurrency 7, integrity 5, post-sale guard 7, void/exchange guard 12, exchange 23, N-1 8, fixture 14 |
| Database state | ledger = 20 finished migrations, last `20261026150000_sale_post_sale_guard` (G20); `SALE_EXCHANGE` = `00000000-0000-4000-9400-000000000038`, granted to ADMIN only (CATALOG_38); `SalePostSaleGuard` and `fn_sale_post_sale_claim` present |
| Static | `npm run lint --prefix api` clean (`--max-warnings 0`), `tsc --noEmit` 0, `npm run build --prefix api` OK, `git diff --check` clean |
| `scripts/database` | 2252 tests: 2247 pass, 3 fail (pre-existing `local1-preflight`), 2 skipped (uid-0-only) |
| Environment | the disposable cluster, its namespace, socket, data directory and temporaries were removed; the system PostgreSQL, Supabase and Docker were not touched |

## Evidence obtained (LOCAL_TEST, disposable PostgreSQL 17.11)

Target: a throwaway PG 17.11 cluster inside a private network namespace (loopback only), database `mona_local_test` with a proven LOCAL_TEST marker, NOSUPERUSER
application role, every command under `env -i` with only `LOCAL_TEST_*` variables. The system Postgres on 127.0.0.1:5432 and the OWNER's LOCAL_TEST checkpoints were
not touched. The disposable fixture of the CI job (`ci-local-test-fixture.mjs`, now exactly 20 migrations) was used instead of `local-test-prepare`, which would have replaced those checkpoints.

| Item | Result |
|---|---|
| Control | G16 rebuilt from nothing reproduces the pinned digest `87ecc8d780b9a7fae79de6d4bd0eaf1ecba354e6ed2e7c9e5da4da3c30c9c7b3` byte for byte |
| Schema references (rebuilt from nothing per generation, marker + `system_identifier` proven; 225 probes each) | G17 `e216fc1ca60b1c32914338992e74058e7c3bc50ab50baac0ffe36b283a098b94`; G18 `3aed5a91e63935142c6b97fea5a646542699500a56910fea1cfcd270431d55df`; G19 `2328d43f8f779ae4db023019b354072d2afa275011810d42e7c2cfdbbbc22dad` (all three re-derived: identical); **G20 `2f9527496aa8d4881ae345baaf8a6a678ca1127ec7319313a80850cffa2026a3`** (36 tables, 343 columns, 193 constraints, 158 indexes, 19 functions, 25 triggers; derived twice, and again on the CI-fixture database: identical). Pinned in `pilot-g20-schema-references.mjs` (G16..G19 reused from the G19 module); generator `pilot-g20-schema-reference.mjs` |
| Code manifests | `pilot-g20-backup` and `pilot-g20-clone-restore` generated: `CURRENT`; the two G19 manifests regenerated after the generation module gained G20: `CURRENT`; the four historical G14 manifests: `CURRENT` |
| `CATALOG_37 -> CATALOG_38` | rehearsed on a scratch copy holding exactly `CATALOG_37`: `UPGRADED`, digest = pin; second run `NOOP_VERIFIED`; 38 permissions, 77 grants |
| H3 (mixed isolation) | **FIXED by G20.** The 8 races: 8/8 end without coexistence (table below); also 8/8 with the two G19 guards DISABLED (the claim alone) |
| G20 structure / backfill / conflict | `sale-post-sale-guard.pg.test.ts` 7/7: structure, claim VOID / EXCHANGE, exchange 2 of the same sale allowed (one claim row), rollback leaves no claim, void service replay unchanged, backfill VOID and EXCHANGE (the migration SQL itself run in a rolled-back transaction), a sale in BOTH families aborts the migration (23514, explicit message, nothing written) |
| Third-round PG proofs (`sale-exchange.concurrency.pg.test.ts` 7/7, `p2002-constraints.pg.test.ts` 3/3) | a reservation growing / shrinking `reserved` while the exchange waits (retry, committed availability); crossed inventories A/B vs B/A (8 rounds, no deadlock, all commit); two exchanges of different SaleItems of one sale (both commit, one EXCHANGE claim); replay after the sale left COMPLETED and the stock moved (no write at all); BIGINT sums (overflow refused, exactly-the-limit accepted); initial-stock first-row race and cash double opening with the real services |
| Third-round summary | `initial-stock` runs in ONE Serializable transaction (options captured in IS01); P2002 understood only for `Inventory_variantId_branchId_key` (initial-stock) and `cash_session_one_open_per_register` (cash), both read from real adapter-pg errors; `returnQuantity` is HTTP string-only (textual body `1e3` → 400); concurrency CR01–CR07 7/7; round state `READY_FOR_THIRD_AUDIT` |
| Other PostgreSQL proofs | `sale-exchange.pg` 23/23; `sale-void-exchange-guard.pg` 12/12; `sale-exchange-n1.pg` 8/8; `sale-exchange.service.pg` 7/7 (real races; `inventories` equals the committed rows); `sale-exchange.localtest-fixture.pg` 14/14; `sale-exchange.integrity.pg` 5/5 (rollbacks, balance, dump/restore); `sale-exchange-ledger-balance.pg` 3/3 (the documented limit) |
| N-1 | commit `42b91c7a3698156d687ceb372f1a4d424e6847f4` in an isolated worktree, unmodified. sales / cash / inventory integration against **G20**: 786 passed, 133 skipped (its SaleVoid insert now also claims the sale; nothing else changes for it). Against G19 its server also started and `/health` answered with `PROPORTIONAL_EXTERNAL_METHODS_ENABLED` false and true |
| Fixture | synthetic: 5 branches + a Depot, each with its own distinct Branch + Location, 6 users by role/scope, 12 variants, 18 sales |
| Cleanup | PostgreSQL stopped, namespace gone, temporaries / dump / credentials deleted, N-1 worktree removed |

`pilot-g20-preflight`, `pilot-g20-backup` and `pilot-g20-clone-restore`: DB-free tests GREEN. They were **not** run against LOCAL_TEST, correctly: they demand a PILOT
marker, verified TLS and the private PILOT URL file. This is by design, not a failure; their first real run is the OWNER's, in the PILOT window.

Known unrelated results of `node --test scripts/database/*.test.mjs` (2252 tests: 2247 pass, 3 fail, 2 skipped):
- 3 FAIL, pre-existing: `scripts/database/local1-preflight.test.mjs` — "offline result is blocked for every remote fact, especially drift and recovery", "pinned local migration payload is verified without treating it as drift proof", "serialized offline report remains parseable and omits ambient secrets". The file and its tool are untracked and pin the migration payload to the 7-migration G7 tree (`PINNED_PAYLOAD`), so they answer `LOCAL_PAYLOAD_UNAVAILABLE` / `UNVERIFIED` on any later tree. Reproduced identically on a clean `HEAD` (42b91c7, 16 migrations) with those two untracked files copied in: the same 3 fail. Not introduced by any round of this work.
- 2 SKIPPED (not failures): `d5h-backup.test.mjs` TOOL-01 and TOOL-04, `skip: !IS_ROOT` — they need a uid-0 fixture and are skipped for every non-root user, before and after.

This document does not replace `20-g16-sale-void-rollout-runbook.md`; that one stays the record of G14 → G16.

## What this release adds

| Generation | Migration | Content |
|---|---|---|
| `EXACT_G17` (intermediate, never a target) | `20261026120000_sale_exchange_enum` (670 B) | `StockMovementType` + `SALE_EXCHANGE_IN`, `SALE_EXCHANGE_OUT` |
| `EXACT_G18` (intermediate, never a target) | `20261026130000_sale_exchange_schema` (17 418 B) | `SaleExchange`, `SaleExchangeLine`, `StockMovement.saleExchangeId/saleExchangeLineId`, 7 FKs (all RESTRICT), 10 CHECKs, 5 unique indexes, ledger / remainder / append-only triggers |
| `EXACT_G19` (intermediate for the G20 rollout; the G19 tools still target it literally) | `20261026140000_sale_void_exchange_guard` (4 050 B) | `SaleVoid` and `SaleExchange` exclude each other with a Sale lock + `EXISTS` (kept; it refuses the common case early) |
| `EXACT_G20` (**latest**) | `20261026150000_sale_post_sale_guard` (5 396 B) | the snapshot-independent claim `SalePostSaleGuard` (below) |

### G20 — exact SQL design (`20261026150000_sale_post_sale_guard`)

```sql
LOCK TABLE "SaleVoid", "SaleExchange" IN SHARE ROW EXCLUSIVE MODE;          -- nothing can appear between backfill and triggers
CREATE TABLE "SalePostSaleGuard" (
  "saleId" TEXT NOT NULL, "mode" TEXT NOT NULL, "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SalePostSaleGuard_pkey" PRIMARY KEY ("saleId"),
  CONSTRAINT "chk_sale_post_sale_guard_mode" CHECK ("mode" IN ('VOID', 'EXCHANGE')),
  CONSTRAINT "SalePostSaleGuard_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE RESTRICT ON UPDATE RESTRICT);
-- BEFORE anything is written: a sale present in BOTH families aborts the migration (check_violation, explicit message, no mode chosen silently)
INSERT ... SELECT DISTINCT "saleId", 'VOID' FROM "SaleVoid";   INSERT ... SELECT DISTINCT "saleId", 'EXCHANGE' FROM "SaleExchange";
CREATE FUNCTION fn_sale_post_sale_claim() RETURNS trigger ... AS $$   -- TG_ARGV[0] = 'VOID' | 'EXCHANGE'
  PERFORM 1 FROM "Sale" WHERE id = NEW."saleId" FOR UPDATE;           -- Sale lock first, like every writer
  INSERT INTO "SalePostSaleGuard" AS g ("saleId","mode") VALUES (NEW."saleId", wanted)
    ON CONFLICT ("saleId") DO UPDATE SET "mode" = g."mode" RETURNING g."mode" INTO claimed;   -- the no-op UPDATE is intentional: a REAL conflict on the same tuple
  IF claimed IS DISTINCT FROM wanted THEN RAISE EXCEPTION '…' USING ERRCODE = 'check_violation'; END IF;
$$;
CREATE TRIGGER trg_sale_void_post_sale_claim     BEFORE INSERT OR UPDATE OF "saleId" ON "SaleVoid"     FOR EACH ROW EXECUTE FUNCTION fn_sale_post_sale_claim('VOID');
CREATE TRIGGER trg_sale_exchange_post_sale_claim BEFORE INSERT OR UPDATE OF "saleId" ON "SaleExchange" FOR EACH ROW EXECUTE FUNCTION fn_sale_post_sale_claim('EXCHANGE');
```

Behaviour: the same mode again (several exchanges of one sale) is allowed; the other mode is refused. READ COMMITTED waits, then sees the committed row (`23514`); a
SERIALIZABLE transaction whose snapshot predates the other writer's commit cannot update the row that writer wrote (`40001`, which both services retry and which then
becomes the domain answer `SALE_HAS_EXCHANGES` / `INVALID_SALE_STATE`). A rolled-back writer rolls its claim back. A claimed sale stays claimed for good. Additive only: one table,
one function, two triggers; G18 and G19 are untouched; N-1 writers keep working (their `SaleVoid` insert simply claims the sale).

### H3 — the 8 races after G20 (`sale-void-exchange-isolation.pg.test.ts`)

T1 writes its row and holds the transaction open; T2 runs `SELECT 1` (snapshot), writes the opposite row and is observed blocked on the Sale lock; T1 commits.

| T1 (first, commits) | T2 (second, snapshot older than T1's commit) | T1 | T2 | Rows left |
|---|---|---|---|---|
| SaleVoid READ COMMITTED | SaleExchange READ COMMITTED | COMMIT | ROLLBACK 23514 | Void only |
| SaleVoid READ COMMITTED | SaleExchange SERIALIZABLE | COMMIT | ROLLBACK **40001** (was COMMIT: both rows) | Void only |
| SaleVoid SERIALIZABLE | SaleExchange READ COMMITTED | COMMIT | ROLLBACK 23514 | Void only |
| SaleVoid SERIALIZABLE | SaleExchange SERIALIZABLE | COMMIT | ROLLBACK 40001 | Void only |
| SaleExchange READ COMMITTED | SaleVoid READ COMMITTED | COMMIT | ROLLBACK 23514 | Exchange only |
| SaleExchange READ COMMITTED | SaleVoid SERIALIZABLE | COMMIT | ROLLBACK **40001** (was COMMIT: both rows) | Exchange only |
| SaleExchange SERIALIZABLE | SaleVoid READ COMMITTED | COMMIT | ROLLBACK 23514 | Exchange only |
| SaleExchange SERIALIZABLE | SaleVoid SERIALIZABLE | COMMIT | ROLLBACK 40001 | Exchange only |

Before G20 the two bold rows committed BOTH rows (reproduced on 17.11: the G19 guard read the Serializable snapshot of T2, taken before T1 committed, and T1 had only LOCKED the
Sale row). The same 8 races were also run with the two G19 triggers disabled, to prove the claim does not depend on them.

## Generations the tooling recognises (history is kept, nothing was replaced)

| Module | Recognised |
|---|---|
| `pilot-migration-generations.mjs` | `EXACT_G14` .. `EXACT_G20` (`LATEST_GENERATION`); intermediates `G15`, `G17`, `G18`, `G19` |
| `pilot-rbac-catalog-generations.mjs` (+ base `pilot-rbac-catalog.mjs`) | `CATALOG_35`, `36`, `37` (historical, still valid), `38` (`LATEST_CATALOG`) |
| `local-test-migration-payload.mjs` | payloads G14..G20, an exact-tree verifier each; the LOCAL_TEST tooling applies and verifies **G20** |
| `local-test-witness.mjs` backup generations | `G1-5` .. `G1-14`, `G1-16` (34 relations), `G1-19` (36 relations, still recognised), **`G1-20`** (37 relations, current) |
| `api/scripts/local-test-fingerprint.ts` / `local-test-baseline.ts` | 351 columns / 37 relations / 19 protected functions (`fn_sale_post_sale_claim` and the symmetric `fn_sale_exchange_void_guard`, which the G19 list had omitted, are now listed); the exchange and claim relations are `PRESERVED_FROM_BACKUP` |
| `pilot-bootstrap.mjs` | canonical catalog `CATALOG_38`; an existing exact `CATALOG_36` / `CATALOG_37` stops with `CATALOG_38_UPGRADE_REQUIRED` (nothing written) |

Historical tools, **untouched and still CURRENT** (`node scripts/database/pilot-tool-manifests.mjs --check` → four `CURRENT`):
`pilot-migration-states.mjs`, `pilot-rbac-catalog.mjs`, `pilot-migrate.mjs`, `pilot-backup.mjs`, `pilot-clone-restore.mjs`, `pilot-a4-readonly.mjs`,
`pilot-launch-command.mjs`, `pilot-g16-migrate.mjs`, `pilot-g16-preflight.mjs`, `pilot-g16-schema-references.mjs`, `pilot-rbac-catalog-37-upgrade.mjs`.
The G16 migrate tool pins its target to the literal `EXACT_G16`, the G19 tools to the literal `EXACT_G19`, the G20 tools to the literal `EXACT_G20`: a newer generation
never retargets an older tool. A historical tool verifies an exact tree of ITS generation, so it only runs from a checkout of it (the G19 tools refuse this 20-migration tree).

## Tools of this rollout (all fail closed, never repair, never print a URL/host/user/password/project ref)

| Tool | Does | Test (DB-free) |
|---|---|---|
| `pilot-g20-schema-references.mjs` | reviewed probes of G16..G20 (G16..G19 reused from the G19 module, G20 added with the absence of its objects in every earlier generation) and the references: all five pinned | `pilot-g20-schema-references.test.mjs` (5) |
| `pilot-g20-schema-reference.mjs` | LOCAL_TEST-only generator of a reference digest from a database rebuilt from nothing (marker + `system_identifier` proven) | `pilot-g20-schema-reference.test.mjs` (10) |
| `pilot-g20-preflight.mjs` | READ-ONLY: ledger generation, schema vs reference, catalog 35..38, row counts (incl. `SalePostSaleGuard`); verdict `READY_FOR_G20_MIGRATION` / `HALF_APPLIED_G17|G18|G19` / `G20_READY_FOR_RBAC_38` / `G20_RBAC_38_COMPLETE` / `BLOCKED` | `pilot-g20-preflight.test.mjs` (38) |
| `pilot-g20-migrate.mjs` | the G16 → G20 `prisma migrate deploy` (initial state `EXACT_G16`, or `EXACT_G17|G18|G19` to resume): exact-tree (20 pins), plan digest, staged copy, one deploy, read-only post-check; refuses to print a plan while any reference is pending (none is) | `pilot-g20-migrate.test.mjs` (13) |
| `pilot-rbac-catalog-38-upgrade.mjs` | OWNER-only `CATALOG_37 → CATALOG_38` (one permission, one ADMIN grant), SERIALIZABLE, requires ledger `EXACT_G20`, idempotent | `pilot-rbac-catalog-38-upgrade.test.mjs` (27) |
| `pilot-g20-backup.mjs` | logical backup at `EXACT_G16` or `EXACT_G20`; own manifest format (`mona-pilot-backup-g20/v1`) and MAC domain; exact table / function / trigger sets per state | `pilot-g20-backup.test.mjs` (68) |
| `pilot-g20-clone-restore.mjs` | the restore proof for those backups, same isolation as the G14 one | `pilot-g20-clone-restore.test.mjs` (16) |
| `pilot-g20-launch-command.mjs` | the OWNER launch command for the two tools above (state enum closed to G16 / G20; chain of digests incl. both launch modules) | `pilot-g20-launch-command.test.mjs` (6) |
| `pilot-g20-tool-manifests.mjs` | generates / checks the two code manifests (`--check` read-only, `--write`) | `pilot-g20-tool-manifests.test.mjs` (5) |

The G19 counterparts (`pilot-g19-*`) remain as the historical G19 target.

## What is still open before PILOT (nothing here was invented)

1. Commit and CI (the hosted TEST owner gate is item 4).
2. The first real run of `pilot-g20-preflight`, `pilot-g20-backup`, `pilot-g20-clone-restore` and `pilot-g20-migrate` against PILOT: OWNER only, in the window.
3. The two code manifests `pilot-g20-backup.manifest.json` / `pilot-g20-clone-restore.manifest.json` are `CURRENT`. They pin every file the tools read: **any change of a
   pinned file makes them `STALE`**, so `pilot-g20-tool-manifests.mjs --check` is a gate before every use and `--write` is re-run, and its diff reviewed, after each change.
4. The hosted TEST owner gate (the full suite against hosted Supabase TEST) is not replaced by the LOCAL_TEST run.

## Rollout order (only after commit + CI, and when the OWNER authorizes PILOT)

The API at the exchange release selects `StockMovement.saleExchangeId` and uses `SaleExchange`; it must never run against a G16 database
(the start gate does not protect against that). Therefore:

1. `pilot-g20-preflight --check` → `READY_FOR_G20_MIGRATION`;
2. **HARD GATE** (same as G16: no backup, no window): a verified EXACT_G16 backup (`pilot-g20-backup --expected-state=EXACT_G16`) AND a verified
   clone restore of that very archive (`pilot-g20-clone-restore --expected-state=EXACT_G16`), recorded in the private log, in the same window,
   after the API was stopped and the cash sessions closed;
3. `pilot-g20-migrate` (dry run, OWNER approval of the plan digest, execute) → `PILOT_G20_MIGRATE_RESULT=EXACT_G20`; anything else is
   `RESTORE_REQUIRED` — never `prisma migrate resolve`, never a retry. The G20 backfill aborts, with an explicit error and nothing written, if any sale already has both a `SaleVoid` and a `SaleExchange` (none can exist on a G16 PILOT);
4. `pilot-g20-preflight --check` → `G20_READY_FOR_RBAC_38`;
5. `pilot-rbac-catalog-38-upgrade` (dry run, OWNER approval, execute) → `RBAC_UPGRADE_RESULT=UPGRADED`;
6. `pilot-g20-preflight --check` → `G20_RBAC_38_COMPLETE`; deploy the API, then the client.

The old API (N-1, the sale void release) keeps working against G20, so steps 3–5 may precede the deploy by any time.

### HTTP and realtime (part of this release)

`POST /api/v1/sales/:saleId/exchanges` (`sale-exchange.http.test.ts`): 201 + `replayed:false` for a new exchange, 200 + `replayed:true` for an idempotent replay (the body is
identical apart from `replayed`; every BigInt is a decimal string); every `AppError` of the service keeps its status and code. Body: `reason` (1..200), `idempotencyKey`
(UUID v4), `lines` (**1..100**, a `saleItemId` once) with `returnQuantity` as a **canonical positive decimal STRING** (`^[1-9][0-9]*$`, ≤ 19 digits, ≤ signed BIGINT
max) and nothing else: **any JSON number is 400** (`1`, `1000`, `1e3`, `9007199254740993`), as are `true`, `[1]`, `{}`, `"01"`, `"+1"`, `"1e3"`, `" 1"`, `"0x10"`. No raw-body
parsing: the edge removes Number altogether. Two schemas over one builder: `exchangeSaleHttpDto` (route) and `exchangeSaleDto` (the domain input the service validates again, a BigInt). The route `saleId` and every body UUID are lower-cased before any query or hash.
After the commit, and only for a new exchange, ONE `inventory.updated` is emitted to the sale's branch room with
`{ branchId, saleId, exchangeId, inventories: [{ inventoryId, variantId, physical, reserved }] }` — the final state of every Inventory the exchange modified,
deduplicated by id. A replay or a refusal emits nothing; a failing socket never turns the committed exchange into an error.

## N-1 proof (what is proven, what is not)

Proven by design and by static tests: the migrations add objects only (two enum labels, three tables, two nullable columns without default, functions and
triggers); no existing row is rewritten; every CHECK compares `"type"::text`; the exchange triggers on `StockMovement` fire only for exchange rows, and the
`SaleVoid` guards are one lock the void service already holds plus an index probe and one claim insert for a sale N-1 voids.

Run on LOCAL_TEST (see Evidence): `sale-exchange-n1.pg.test.ts` 8/8; the N-1 API (`42b91c7a3698156d687ceb372f1a4d424e6847f4`) sales / cash / inventory integration against
G20 passed (786 passed, 133 skipped).
Residual N-1 risk: a client that maps `StockMovementType` to a closed set could fail to read a `SALE_EXCHANGE_*` row — none exists until the feature is used.

## Independent audit findings (REVISE) — status

| Id | Finding | Status |
|---|---|---|
| H1 / M-01 | `z.coerce.bigint()` accepted `true`, `[1]`, `" 1"`, `0x10`, …; then JSON numbers were still accepted | **FIXED, final contract: string only** (above); `sale-exchange.dto.test.ts`, HX05/HX06/HX08 (textual bodies `1e3`, `9007199254740993`) |
| H2 | the exchange retry classifier missed the `@prisma/adapter-pg` shapes | **FIXED**: one shared classifier `src/shared/transient-transaction-error.ts`. Audit of the critical money / stock services that retry a Serializable transaction — **migrated** (same semantics, now full shape coverage): `sale-void`, `sale-exchange`, `inventory-adjustment`, `cancellation`, `pending-correction`, `sales` (completion), `reservation`, `payments`, `checkout`, `checkout-reservation`, `checkout-stock-recovery`; `initial-stock` and `cash` joined in the third round (H-01, below). `tests/architecture/transient-classifier.test.ts` pins the list; 3 attempts then `409 CONCURRENCY_ERROR`, no driver detail leaks (SX45, SX61–SX63, SV50b, SV51b) |
| H3 | SaleVoid <-> SaleExchange exclusion under mixed isolation | **CONFIRMED on 17.11, then FIXED by G20** (8/8 above) |
| H4 | the database does not tie the exchange ledger to `Inventory.physical` | **CONFIRMED (measured), decided: architecture A** — see "Trust boundary". G18 not redesigned |
| M1 | UUID spelling | **FIXED**: lower-cased before any query / hash (SX64–SX66, HX20, dto tests). Persisted rows untouched |
| M2 | stale "references pending" text | **FIXED** in this runbook and in the comments of the G19 tools |
| H-01 (2nd audit) | `initial-stock` and `cash` kept a local, weaker classifier | **FIXED**: both use the shared classifier and keep ONLY their exact P2002. initial-stock: `Inventory_variantId_branchId_key` (the first Inventory row of a (variant, branch)); cash: `cash_session_one_open_per_register` (the partial unique index of migration 1 behind `CASH_SESSION_ALREADY_OPEN`). Both names were read from real adapter-pg errors (`p2002-constraints.pg.test.ts`). Any other P2002 is neither retried nor translated. `initial-stock.behavior.test.ts`, `cash-open-session.behavior.test.ts` |
| H-02 (2nd audit) | `initial-stock` ran at the default isolation | **FIXED**: ONE `$transaction` with `isolationLevel: 'Serializable'` (+ 30 s timeout), same locks, atomic Inventory + StockMovement + AuditLog, max 3 attempts (IS01 captures the options) |
| M-02 (2nd audit) | CATALOG_38 COMMIT-UNKNOWN recovery named `pilot-g19-preflight` | **FIXED**: `pilot-g20-preflight`; exact-message test R38-L3 and a source test R38-L3b |
| L-01 (2nd audit) | stale comments | **FIXED**: `local-test-prepare.mjs` (the TOC doc said 26 relations), `pilot-g16-migrate.mjs`, `sale-exchange.http.test.ts`, the `NOT EXECUTED` headers of the exchange PG tests, the "not in the catalog yet" note of the behavior test. No executable target was touched |
| L1 | cap on lines per request | **FIXED**: `lines.max(100)` (the closest precedent in the system is `pending-correction.dto` `items.max(100)`); 100 accepted, 101 → 400 before any work, the duplicate `saleItemId` rule still applies at the limit |

## Rollback boundary

- **Before any `SaleExchange` row exists:** full restore of the EXACT_G16 backup (the migrations only add objects).
- **After the first `SaleExchange` row exists:** no restore (it would erase real exchanges and stock movements) and no downgrade. Forward-fix only, or an
  explicit OWNER decision record with export and reconciliation.

## Known gaps / risks (decided, not hidden)

- Raw SQL DML is not a supported writer (trust boundary above): the database does not tie the exchange ledger to `Inventory.physical`.
- `TRUNCATE` is not guarded on the exchange tables or on `SalePostSaleGuard` (the test cleanup needs `TRUNCATE … CASCADE`); no application role holds it.
- A `SaleVoid` / `SaleExchange` re-pointed with `UPDATE OF "saleId"` claims the new sale and does not release the old claim (conservative: a claimed sale stays claimed).
- The restore proof does not yet measure exchange-specific invariants (a line without its ledger rows); the deferred DB triggers enforce them at write time.
- The G14-era `pilot-a4-readonly` audit tool and the LOCAL1 tool do not know G16..G20.
- `initial-stock` and `cash` keep their own transient rule (they also handle `P2002`).

## Never

No `prisma migrate dev/deploy/resolve` against TEST/DEV/PILOT from this document; no edit of an applied migration; no edit of `docs/production-v1/*`.
