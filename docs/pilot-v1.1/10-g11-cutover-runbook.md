# PILOT G14 cut-over runbook (S4/G7/G11 → EXACT_G14)

Status: **GENERATED, NOT EXECUTED.** OWNER-only. Every step that touches PILOT, Railway or
Vercel is run by the OWNER, by hand, in the order below. No step may be skipped or reordered;
a step whose expected result line does not appear exactly is a **STOP**. On STOP, follow
`11-g11-rollback-runbook.md`.

Scope: PILOT database cut-over from the exact initial state the OWNER observed (EXACT_S4,
EXACT_G7 or EXACT_G11 — never auto-selected) to EXACT_G14 (migrations 1–14, all finished, none
rolled back, pinned checksums; EXACT_G11 → EXACT_G14 applies exactly m12
`20261021120000_r3_card_credit`, m13 `20261021130000_warehouse_stock_adjustment` and m14
`20261021140000_r3_qr`), the RBAC catalog upgrade to CATALOG_36 (CATALOG_35 → CATALOG_36, or
NOOP_VERIFIED when the source is already CATALOG_36), and the start of the API at the reviewed
commit. EXACT_G12 and EXACT_G13 are exact ledgers but **never resumable initial states**: a
PILOT found there is a partial cut-over — restore per `11-g11-rollback-runbook.md`, never
resume (`pilot-migrate` itself refuses such a ledger and reports RESTORE_REQUIRED). The
`/auth/me` branch-aware UX is **not** part of this cut-over
(PRE-PILOT UX MINI-SLICE, tracked separately).

## Hard prerequisites (any missing item = the window is not scheduled)

| ID | Prerequisite | Evidence |
|----|--------------|----------|
| P1 | The reviewed commit is fixed; every tool below runs from that checkout. | commit SHA recorded in the private log |
| P2 | `SCHEMA_REFERENCES` holds the generated, reviewed EXACT_S4/G7/G11 entries (projection format v2), produced only through `local-test-cutover-lab.mjs --op=schema-reference`; SR-05 GREEN. The LOCAL lab evidence is GREEN at P1: `--op=backup-restore-proof` for all three states (LOCAL_RESTORE_PROOF), `--op=migration-rehearsal --from=<INITIAL>`, `--op=integration-test`. | lab evidence runs at P1 |
| P3 | The four code manifests were regenerated **after** P2 with `node scripts/database/pilot-tool-manifests.mjs --write` and `--check` prints CURRENT for all four at P1 (A4 test R01 GREEN). | `--check` output |
| P4 | DB-free gates GREEN at P1: scripts/database node tests (except the documented ENVIRONMENT / out-of-scope suites), API lint, typecheck baseline (NEW 0), focused readiness tests. | gate log |
| P5 | The OWNER private files exist and are private (0600 files, 0700 dirs): `pilot-database-url`, `pilot-marker-id`, `pilot-backup-mac-key`. | tool gates |
| P6 | **Railway `DATABASE_URL` verified** (PILOT DEPLOY BLOCKER): see step 2. | step 2 record |
| P7 | A private, 0700 backup directory and a 0700 clone work root exist outside the repository and `/tmp`. | step 8/9 gates |

## Steps

### Before the window (no write anywhere)

1. **Freeze the toolchain.** Check out P1; confirm P2–P5. Record the commit SHA and the
   SHA-256 of `pilot-migrate.mjs`, `pilot-rbac-catalog-upgrade.mjs`, the three manifests and
   `pilot-schema-references.mjs` in the private log.
2. **Railway `DATABASE_URL` verification point (deploy blocker).** In the Railway dashboard,
   open the API service variables (never copy them into the repository, a chat, a ticket or a
   log). Confirm by eye, without writing the value anywhere: the host and user carry the
   **PILOT** project (the same project as the private `pilot-database-url`), port 5432 (session
   pooler or direct), and database `postgres`. The Railway `DATABASE_URL` MUST NOT contain
   `sslmode` or other TLS query overrides: remote TLS is enforced by the application runtime
   with the pinned CA and `rejectUnauthorized: true`. Confirm no TEST/DEV/DEMO URL is configured
   in any other variable of the service. Record only `RAILWAY_DATABASE_URL_VERIFIED <date>
   <OWNER initials>`. If anything differs → STOP (no window).
3. **A4 baseline (read-only).** Run `pilot-a4-readonly.mjs --target=pilot --read-only-state`.
   Required: identity proven and `A4_STATE=EXACT_S4`, `A4_STATE=EXACT_G7` or
   `A4_STATE=EXACT_G11`, with the `cutover: ledger=… reference=MATCH probes_failed=0
   rbac=CATALOG_35|CATALOG_36` line. The printed state is the **expected initial state** used
   in every later step (`<INITIAL>`). `A4_STATE=PARTIAL`, `EXACT_G12` or `EXACT_G13` (a partial
   cut-over: restore, never resume), `EXACT_G14` (already at the target) or a reference
   MISMATCH → STOP.
4. **Announce the maintenance window** to every PILOT user (start, expected end, "do not
   sell or move cash during the window").

### Maintenance window

5. **Close every OPEN cash session normally** through the application (count, close,
   reconciliation as usual). No session may be force-closed in the database.
6. **Freeze writes and stop the API.** Stop the Railway API service (0 running
   instances; the API is the only writer). Put the client in its maintenance state. Confirm in
   Railway that no instance is running.
7. **A4 re-verification (read-only).** Same command as step 3. Required: the same
   `A4_STATE=<INITIAL>`, `reference=MATCH probes_failed=0`, and **zero OPEN cash sessions** in
   the reported counts. Any difference from step 3 other than the closed sessions → STOP.
8. **Pre-cut-over backup.** `pilot-backup.mjs --target=pilot --dry-run
   --output-dir=<backups> --expected-state=<INITIAL>` → `A5B_RESULT=DRY_RUN_OK`; then the exact
   OWNER launch command produced by `pilot-launch-command.mjs` (tool `pilot-backup`,
   `expectedState=<INITIAL>`) → `A5B_RESULT=VERIFIED`. Record the archive name, archive SHA-256,
   `ledger=<INITIAL>` and the table/row totals.
9. **Restore proof of that backup.** OWNER launch command for `pilot-clone-restore`
   (`expectedState=<INITIAL>`, network namespace) → `A5C_RESULT=VERIFIED` with `check
   ledger=PASS`, `check schema=PASS` (`reference=MATCH probes_failed=0`), `check rbac=PASS`,
   `check invariants=PASS` and `invariants open_sessions=0 …`. This archive is **the verified
   pre-cut-over backup** of the rollback runbook.
10. **Migration plan (no connection).** `pilot-migrate.mjs --target=pilot --dry-run
    --marker-id=<uuid> --expected-initial-state=<INITIAL>`. Required: `INITIAL_STATE=<INITIAL>`,
    `migrations to apply: 10` (from EXACT_S4), `7` (from EXACT_G7) or `3` (from EXACT_G11 —
    exactly m12, m13, m14), `FINAL_STATE=EXACT_G14`,
    `PLAN_DIGEST=<64 hex>`. Record `PLAN_DIGEST`.
11. **Migrate.** `pilot-migrate.mjs --target=pilot --execute --marker-id=<uuid>
    --confirm-project-ref=<ref> --expected-initial-state=<INITIAL> --plan=<PLAN_DIGEST>`.
    Required: `PILOT_MIGRATE_RESULT=EXACT_G14`. `PILOT_MIGRATE_RESULT=RESTORE_REQUIRED` (a
    deploy that stopped at G12/G13, a failed post-check, or any partial ledger — the tool never
    resolves, retries or repairs) or any refusal → STOP, rollback runbook R-B (never
    `prisma migrate resolve`, never SQL by hand).
12. **RBAC catalog upgrade.** `pilot-rbac-catalog-upgrade.mjs --target=pilot --dry-run
    --marker-id=<uuid>` → plan digest; then `--execute --marker-id=<uuid>
    --confirm-project-ref=<ref> --plan=<digest>`. Required: `RBAC_UPGRADE_RESULT=UPGRADED`
    (from CATALOG_35) or `RBAC_UPGRADE_RESULT=NOOP_VERIFIED` (already CATALOG_36). `CONFLICT`,
    `REFUSED` → STOP (rollback R-C). `UNKNOWN` → run step 13 first, then decide.
13. **A4 final-state verification (read-only).** Required: `A4_STATE=EXACT_G14` with
    `cutover: ledger=EXACT_G14 reference=MATCH probes_failed=0 rbac=CATALOG_36`.
14. **Post-cut-over backup.** As step 8 with `--expected-state=EXACT_G14` →
    `A5B_RESULT=VERIFIED`, manifest `rbacCatalog.catalog=CATALOG_36`.
15. **Restore proof of the G14 backup.** As step 9 with `expectedState=EXACT_G14` →
    `A5C_RESULT=VERIFIED`, all checks PASS, `ledger state=EXACT_G14 rows=14`.
16. **Data continuity check.** For every table present in the step-8 manifest, the step-14 row
    count must be equal, except `_prisma_migrations` (+10, +7 or +3), `Permission` (+1) and
    `RolePermission` (+2) when step 12 upgraded. Migrations 12–14 add only columns, enums,
    indexes and CHECKs (no new tables); the six R3 tables are new when `<INITIAL>`=EXACT_G7,
    and `CompanyPricingConfig` when `<INITIAL>`=EXACT_S4. Any other difference → STOP.

### Restart

17. **API deployment configuration.** Re-verify step 2 (Railway `DATABASE_URL` unchanged)
    and confirm the API deployment targets the P1 commit.
18. **Start the API.** Before starting: in the Railway dashboard, confirm the API service has
    `RESERVATION_SWEEPER_ENABLED=false` (its default; the reservation sweeper is the one
    startup writer — it releases expired holds without any HTTP request). If the variable is
    absent do NOT assume the default: set it to `false`, or record `PILOT_WRITER_RISK_ACCEPTED
    <date> <OWNER initials>` and treat step 18 as the forward-fix boundary. Then start the
    Railway service. Required: the process stays up and the log carries **no**
    `r3_startup_gate_failed` entry (the S9 gate refuses any database that is not G14-strict:
    m8–m11 present but m12/m13/m14 absent never starts, and a G12/G13 partial never starts).
    A gate failure → stop the service again, STOP (rollback R-C).
19. **Client deployment.** Deploy the client (Vercel) at the P1 commit; remove the maintenance
    state only after step 20.
20. **Smoke test (OWNER account, then one CASHIER).** Login; `/auth/me` carries
    `CASH_MOVEMENT_MANAGE` for ADMIN/CASHIER; open a cash session; one sale; one withdrawal and
    its correction (reversal); close the session with reconciliation. **Rollback boundary
    (R-C/R-D)**: see `11-g11-rollback-runbook.md` — the lossless-restore guarantee ends at
    step 18 (the API start), not here; from step 18 onward restore-vs-forward-fix follows the
    R-C conservative rule, and this step's first write is a plain forward-fix case.
21. **A4 after the smoke test (read-only).** `A4_STATE=EXACT_G14`, counts reflect the smoke
    operations only.
22. **Open the PILOT.** Remove the maintenance state; announce the end of the window.
23. **Evidence bundle.** Store privately: A4 outputs (steps 3, 7, 13, 21), both backup
    manifests and restore-proof outputs, `PLAN_DIGEST`, the migrate/RBAC result lines, the
    Railway verification record, the start log excerpt without values. Open the PRE-PILOT UX
    mini-slice (`/auth/me` branch-aware) before pilot users rely on branch switching.

## Never

- `prisma migrate resolve`, `prisma db push`, `prisma migrate reset` or any SQL downgrade.
- A restore onto PILOT without the rollback runbook decision record.
- Printing or storing a URL, password, project ref or marker id.
- Running a step against DEV, hosted TEST or DEMO.
