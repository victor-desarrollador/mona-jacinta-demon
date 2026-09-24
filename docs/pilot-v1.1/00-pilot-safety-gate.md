# Pilot Safety Gate P0.1 — Technical-Hold Expiry (Pilot overlay)

Pilot-specific operational overlay. It does not modify the frozen
`docs/production-v1/*` requirements: Production V1's `StockHold` model
(`docs/production-v1/07-inventory-ledger.md` §5) still replaces this
transitional mechanism later.

## Scope

Seller → cashier technical holds (`StockReservation`, TTL 30 minutes,
`TECHNICAL_HOLD_TTL_MS`). `Inventory.reserved` remains a persisted counter.

| Slice | What it adds |
| --- | --- |
| P0.1-A | Read-side effective availability ignores releasable expired holds. The raw `reserved` value is still returned. |
| P0.1-B1 | Authoritative, idempotent per-sale release; system audit actor; manual endpoint. |
| P0.1-B2 | Targeted release before send-to-cashier; opt-in background sweeper. |

## Expiry rule

A hold is releasable only when **all** hold:

- `StockReservation.status = ACTIVE`
- `expiresAt <= now`
- `Sale.status = PENDING_PAYMENT`
- the sale has **zero** `SalePayment` rows

Partial-payment sales are payment-protected: any `SalePayment` row,
whatever its amount, keeps every hold of that sale `ACTIVE`. Automatic and
manual expiry never touch `DRAFT`, `PAID`, `COMPLETED` or `CANCELLED` sales.

Release decrements `Inventory.reserved` by the exact held quantity, marks
the holds `RELEASED`, writes one `RESERVATION_RELEASED` audit per sale, and
writes **no `StockMovement`** (physical stock never changed).

## Release paths and audit attribution

| Path | Trigger (`after.trigger`) | `AuditLog.userId` |
| --- | --- | --- |
| `POST /api/v1/admin/reservations/release-expired` | `ADMIN` | the invoking human (`INVENTORY_MANAGE`) |
| Before send-to-cashier | `SEND_TO_CASHIER` | system actor; `after.triggeredByUserId` = the seller (context only, grants nothing) |
| Background sweeper | `SYSTEM` | system actor |

The automatic paths read the wall clock themselves. Callers cannot supply
the current time.

### Before send-to-cashier

1. A read-only preflight on the target sale uses the same checks and errors
   as the reservation transaction: not found, not the seller's or out of
   branch scope, not `DRAFT`, or empty. If any check fails, the send stops
   and **no** cleanup runs.
2. Candidate sales are released one transaction per sale, before the
   target transaction opens. At most `PRE_SEND_RECONCILE_LIMIT` (10) are
   processed per send, which bounds the extra wait at the counter.
   Candidates beyond the cap stay eligible for the next send or sweeper tick.
   The sweeper's and manual endpoint's 100-sale batch is a separate limit.
   - **Discovery scope:** a sale is nominated only if it has a releasable
     hold on the target sale's **branch** and one of its exact **variants**.
   - **Release scope:** once nominated, the candidate goes through B1's
     per-sale release unit. **All** of that sale's currently expired,
     `ACTIVE` holds are released together (the sale has zero payments),
     including holds of variants the target does not need. Release, audit
     (one `RESERVATION_RELEASED` listing every released quantity) and
     rollback are all per sale, so a sale is never left half-released. This
     is the same valid maintenance the sweeper would perform on that sale.
     Unexpired holds and payment-protected sales are never touched.
3. The existing locked `physical - reserved >= requested` check alone
   decides. Failed maintenance (corrupt candidate, missing system actor,
   transient error) is logged as `reservation_pre_reconcile_failed`, and
   the send continues to that check. The result may be a conservative
   `INSUFFICIENT_STOCK`, but it can never oversell.

## Background sweeper (opt-in)

Disabled by default. Starting the API never enables it implicitly.

| Variable | Default | Rule |
| --- | --- | --- |
| `RESERVATION_SWEEPER_ENABLED` | `false` | exactly `true` or `false` |
| `RESERVATION_SWEEP_INTERVAL_MS` | `60000` | integer ≥ 1000 |
| `RESERVATION_SWEEP_BATCH_SIZE` | `100` | integer 1–100 |

When enabled it runs one boot sweep after the server starts listening,
then one bounded batch per tick. The next tick is armed only after the
current run finishes, so runs never overlap. Shutdown stops the sweeper and
waits for any in-flight run before the database disconnects. Several API
instances may sweep at once; B1's per-sale locking makes that safe.

It is started only by the server process, never by `createApp()`, so tests
and supertest never create timers.

### Prerequisite: system actor

The system audit actor must exist **before** enabling the sweeper. It is
created explicitly (never at startup, never by the seed). Run from `api/`:

```bash
npx tsx scripts/bootstrap-system-actor.ts --target=<target> --dry-run
npx tsx scripts/bootstrap-system-actor.ts --target=<target> --execute
```

If the actor is missing or tampered with (active, has scopes or legacy
roles, identity mismatch), automatic releases fail closed. There are no
writes, `reservation_sweep_failed` is logged with code
`SYSTEM_ACTOR_UNAVAILABLE`, the process stays up, and later ticks retry.

## Operational log events

All events carry only fixed names, sale ids, stable codes and counts. They
never include raw errors, credentials or personal data. Unknown errors map
to `RELEASE_FAILED`.

| Event | Level | Fields |
| --- | --- | --- |
| `reservation_sweeper_enabled` / `reservation_sweeper_disabled` | info | — |
| `reservation_sweep_completed` | info | `released`, `failed`, `batchSize`, `durationMs` |
| `reservation_sweep_sale_failed` | warn | `saleId`, `code` |
| `reservation_sweep_notify_failed` | warn | `saleId` |
| `reservation_sweep_failed` | error | `code`, `durationMs` |
| `reservation_pre_reconcile_failed` | warn | `code`, optional `saleId` |
| `reservation_pre_reconcile_notify_failed` | warn | `saleId`, `code` (`NOTIFY_FAILED`) |

`reservation_pre_reconcile_failed` covers real reconciliation/maintenance
failures only. `reservation_pre_reconcile_notify_failed` means the realtime
`inventory.updated` notification for one pre-send release failed **after**
that release had already committed. In that case:

- the committed database release stays valid; nothing is rolled back;
- the sale is not added to the reconciliation `failed[]` list;
- notifications for later releases in the same pre-send step still go out;
- the target send still reaches its authoritative reservation transaction;
- the event is never reported as `reservation_pre_reconcile_failed`.

Like every event here, it logs no raw error object or error message, and no
secrets, credentials, personal data or payment data.

## Realtime

Committed automatic and pre-send releases emit the existing
`inventory.updated` event to the sale's branch room, with the same payload as
the manual endpoint (`saleId`, `branchId`, `quantities`). Emission happens
only after commit. Failed, no-op and payment-protected sales emit nothing.
Realtime is advisory: a failed notification never changes, retries or rolls
back an inventory or reservation write (see
`reservation_pre_reconcile_notify_failed` and
`reservation_sweep_notify_failed` above).

## Known limitations (follow-ups)

- Starvation: batches are ordered by sale id. Enough permanently corrupt
  low-id sales could occupy every batch slot. Each one is logged on every
  tick, and hardening is deferred to P0.5.
- Payment TTL enforcement and completion hold rules are P0.1-C.
