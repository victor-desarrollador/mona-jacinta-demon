# PILOT G11 cut-over — rollback runbook

Status: **GENERATED, NOT EXECUTED.** OWNER-only. Companion of `10-g11-cutover-runbook.md`
(step numbers refer to it).

## Policy (OWNER 2026-10-18; boundary superseded 2026-10-19)

- **Rollback boundary (supersession):** the last **guaranteed-lossless restore point** is NOT
  "the first business write" — it is **before step 18 of the cut-over runbook**, the moment the
  API is started. Once an API/worker capable of writing is running, the database may change
  without any operator action: the reservation sweeper (`startReservationSweeper` in
  `api/src/server.ts`, gated only by `RESERVATION_SWEEPER_ENABLED`) releases expired holds as
  system writes at startup, with no HTTP request. Therefore:
  - **Default once step 18 has run: FORWARD FIX** (treat as R-D semantics below), even before
    the first smoke-test write.
  - **Documented exception (restore still allowed in the 18–20 window as R-C) only when all
    three have been recorded in the private log:** (a) the Railway PILOT API env was verified
    to carry `RESERVATION_SWEEPER_ENABLED=false` before the start (cut-over step 18); (b) the
    client stayed in its maintenance state until step 20; (c) no non-health HTTP request
    reached the API in the window (Railway request log checked). Any missing record → default
    (FORWARD FIX). No other "nothing could write" assumption is authorizeable.
- **Before any G14 write** (before step 18; the API never started): roll back by a **full
  restore of the verified pre-cut-over backup** (cut-over steps 8 + 9).
- **After real G14 business writes (step 20 onward):** default is **FORWARD FIX**. A restore is
  allowed only with an explicit OWNER decision record **and** an export + reconciliation of
  every post-cut-over operation (sales, payments, cash sessions, cash movements, stock
  movements, audit rows).
- **Never:** an SQL downgrade, `prisma migrate resolve`, `prisma db push`, `prisma migrate reset`,
  hand-edited ledger rows, or a silent restore.

## LOCAL_RESTORE_PROOF (closed) vs PILOT_RESTORE_EXECUTION (BLOCKED)

LOCAL_RESTORE_PROOF is closed: the LOCAL_TEST cut-over lab proves, for EXACT_S4/G7/G11, that a
`pg_dump` of the state restores into a fresh cluster with the exact ledger, the reference schema digest,
equal row counts and fingerprints, the RBAC catalog and the cash/sales invariants (`--op=backup-restore-proof`),
and pilot-clone-restore proves every real PILOT archive the same way before the window.

### PILOT_RESTORE_EXECUTION — not tooled (BLOCKER for R-B/R-C execution)

`pilot-clone-restore.mjs` restores **only into disposable local clusters** (restore proof). No
reviewed tool restores an archive **onto PILOT**. Until one exists and is reviewed, a PILOT
restore is an OWNER decision executed through the Supabase project's own restore facility
(point-in-time / backup restore to a timestamp before cut-over step 10) or into a fresh PILOT
project, followed by the A4 and restore-proof checks below. This gap must be closed (or the
OWNER must accept the Supabase-facility path in writing) **before** the window is scheduled.

## Decision tree

| Where it stopped | Writes on PILOT so far | Branch |
|------------------|------------------------|--------|
| Steps 1–10, or step 11 refused before the migration child started (phase plan/identity/precheck) | none | **R-A** |
| Step 11 `PILOT_MIGRATE_RESULT=RESTORE_REQUIRED` (migration child ran or postcheck failed) | schema/ledger possibly partial | **R-B** |
| Steps 12–17, or 18–19 with the boundary exception proven (sweeper flag false, maintenance state, no non-health requests) | schema and maybe catalog; **no business write** | **R-C** |
| Step 18 (API running) without the exception records, or step 20 onward | the API may have written (sweeper) or business data at G11 | **R-D** |

### R-A — nothing was written

1. Keep the API stopped. Run A4 (read-only): `A4_STATE` must still be `<INITIAL>` with
   `reference=MATCH`. If not → treat as R-B.
2. Either fix the cause and resume at cut-over step 7, or abort the window: restart the API at
   the **previous** reviewed commit (the one that ran against `<INITIAL>`), remove the
   maintenance state, announce.

### R-B — migration failed (RESTORE_REQUIRED)

1. Keep the API stopped (the S9 gate would refuse a partial schema anyway; do not try).
2. Run A4 (read-only) and store the output: it shows the exact ledger rows and
   `A4_STATE=PARTIAL` with flags — or `A4_STATE=EXACT_G12`/`EXACT_G13` when the deploy stopped
   on a clean but partial ledger (a partial cut-over: restore, never resume). Do **not** run
   `pilot-migrate` again and do not touch the ledger.
3. OWNER decision record: "restore PILOT to the verified pre-cut-over backup <archive SHA-256>".
4. Restore (see Known gap) to the pre-cut-over state.
5. A4 (read-only): `A4_STATE=<INITIAL>`, `reference=MATCH probes_failed=0`, counts equal to the
   step-8 manifest; cash sessions OPEN=0.
6. Abort the window as R-A step 2, or reschedule after the root cause is fixed and reviewed.

### R-C — schema at G14, no writer has run (restore window ends at step 18)

1. Keep (or put) the API stopped. If the API was started at step 18 without the three boundary
   records of the policy section, this branch does NOT apply: classify as R-D and do not
   restore without the R-D decision record.
2. A4 (read-only). `RBAC_UPGRADE_RESULT=UNKNOWN` is resolved here: `rbac=CATALOG_36` means the
   upgrade committed (continue at cut-over step 13); `rbac=CATALOG_35` means it did not (rerun
   cut-over step 12 once, with a new dry-run plan).
3. `CONFLICT` (catalog neither 35 nor 36), a G14 restore-proof failure, a continuity mismatch or
   an S9 gate refusal: STOP. Because no writer has run (R-C precondition proven), the OWNER may
   choose the full restore of the pre-cut-over backup (R-B steps 3–6) **or** a reviewed forward
   fix. Record the decision.

### R-D — the API ran without the boundary records, or business writes happened (default FORWARD FIX)

1. Do not stop for a restore by reflex. Classify the defect; if the API must stop, stop it.
2. Take a fresh `pilot-backup --expected-state=EXACT_G14` (+ restore proof) to freeze the
   current state.
3. Forward fix: a reviewed code change and/or a reviewed, additive migration 15+ applied through
   the guarded tooling (new pins, new references, new manifests) — never an edit of 1–14.
4. Only if the OWNER explicitly decides a restore: export every post-cut-over operation from the
   step-2 backup (sales, payments, cash sessions/movements, stock movements, audit), prepare the
   reconciliation (what will be re-entered, by whom, how it is verified), get the OWNER sign-off,
   then restore as R-B steps 4–5 and re-enter per the reconciliation.
