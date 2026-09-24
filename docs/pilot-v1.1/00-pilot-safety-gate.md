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
| P0.1-C | Payment, completion and cashier-queue rules against current hold coverage. |

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
| `payment_notify_failed` | warn | `saleId`, `code` (`NOTIFY_FAILED`) — P0.1-C |

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

## P0.1-C — Payment, completion and cashier queue

### Current hold coverage

A sale's **current coverage** is its `ACTIVE` `StockReservation` rows only.
Historical `RELEASED` and `CONSUMED` rows are never current coverage. They
are ignored, never matched and never consumed again. Coverage is exact
when:

- every `ACTIVE` row is on the sale's own branch with a positive quantity;
- per variant, the `ACTIVE` quantity equals the sum of the current
  `SaleItem` quantities;
- no required variant is missing and no unexpected `ACTIVE` variant exists.

A sale with no items has no valid coverage. Nothing is repaired
implicitly.

### Payment

1. An idempotent replay (same key, same intent) is resolved **first** and
   returns the original payment, even after `PAID`/`COMPLETED` or after
   `expiresAt`. A different new payment on a `PAID` sale is still rejected
   (`INVALID_SALE_STATE`).
2. A NEW payment needs a `PENDING_PAYMENT` sale with exact current coverage
   (otherwise `INVALID_RESERVATION`).
3. **First payment (zero `SalePayment` rows):** every current hold must be
   unexpired, `expiresAt > now`. `expiresAt <= now` is expired, the same
   boundary as P0.1-A/B1. An expired hold is rejected with
   `RESERVATION_EXPIRED`.
4. **Later payments (Policy A):** any existing `SalePayment` row, whatever
   its amount, protects the holds. The remaining balance may be paid after
   `expiresAt`, but exact current coverage is still required.
5. Remaining = `Sale.total − SUM(SalePayment.amount)` in exact BigInt.
   Equal → `PAID`, below → stays `PENDING_PAYMENT`, above → `OVERPAYMENT`.
6. A rejected payment writes nothing: no payment, cash movement, status
   change or audit.

The payment path reads the wall clock itself, once per decision. It only
**detects** expiry: it never decrements `Inventory.reserved`, never marks a
hold `RELEASED` and never writes `RESERVATION_RELEASED`. Release stays owned
by P0.1-B1/B2. There is no automatic refund or reversal for an abandoned
partial payment. It stays a manual operational case for the Pilot (P0.2).

### Payment vs expiry release

Both lock the `Sale` row first, so whichever commits first decides:

- If payment commits first, the release then sees a `SalePayment` row and
  returns `PAYMENT_PROTECTED`. The hold stays `ACTIVE`.
- If the release commits first, the hold becomes `RELEASED` and `reserved`
  is decremented. The payment then finds no current coverage and is
  rejected.

No state can hold both an accepted payment and an expiry-released hold for
that sale.

### Completion

Completion needs a `PAID` sale with exact current coverage. It consumes only
the current `ACTIVE` holds and **ignores `expiresAt`**, so a sale paid while
its hold was valid stays completable later (the sweeper never touches
`PAID`). The lock order is `Sale → StockReservation (ACTIVE, id ASC) →
Inventory (id ASC)`, the same prefix as the B1 release and cancellation.

### Cashier queue

`GET /api/v1/sales/pending` (`SALE_QUEUE_VIEW`) lists `PENDING_PAYMENT`
**and** `PAID` sales, so a fully paid sale stays visible until it is
completed. Each row adds `status`, `holdState` and `canAcceptPayment`:

| `holdState` | Meaning | `canAcceptPayment` |
| --- | --- | --- |
| `VALID` | Pending, zero payments, exact unexpired coverage | yes |
| `EXPIRED` | Pending, zero payments, holds expired or already released | no (cancellation remains possible) |
| `PAYMENT_PROTECTED` | Pending, at least one payment, exact coverage | yes (remaining balance) |
| `PAID` | Paid, exact coverage; complete it | no |
| `COVERAGE_INVALID` | Coverage does not back the items (fail closed) | no |

The queue is informational only. Payment and completion re-check everything
under the Sale lock.

### Payment realtime

The `sale.paid` notification is sent only after the payment transaction has
committed. If it throws, the error is logged as `payment_notify_failed` and
the response stays the committed payment's `201`. It is never turned into an
HTTP error that could read as "not charged". An idempotent replay never
notifies again and never duplicates the payment, audit or cash movement.

### [PILOT DECISION / TRANSITIONAL DIVERGENCE] Policy A vs the frozen sellable formula

The frozen Production V1 documents release a technical hold on expiry only
when no payment was made (`04-domain-rules.md`: "RELEASED on expiry or
cancellation (if no payments were made)"; `07-inventory-ledger.md` §5.1:
"Cancel / expiry (no payment)"). Policy A follows this.

The frozen sellable formula (`07-inventory-ledger.md` §5.4) counts a hold
only while `status = ACTIVE AND expiresAt > now()`, with no payment
exception. Under that formula, the merchandise of a partially paid sale
would become sellable again after `expiresAt` even though its hold is never
released. The Pilot deliberately does **not** do this. A payment-protected
hold keeps reducing availability (P0.1-A) and keeps backing the remaining
payment and the completion (P0.1-C). This is the more conservative choice:
it can never oversell.

The frozen lazy "update the status when a transaction touches an expired
record" rule (`04-domain-rules.md`) is also applied differently. The payment
path only detects expiry. Materializing `RELEASED` stays with the single B1/B2
release authority.

The frozen documents are unchanged. The Production `StockHold` phase (3C/6B)
must reconcile this explicitly.

## Known limitations (follow-ups)

- Starvation: batches are ordered by sale id. Enough permanently corrupt
  low-id sales could occupy every batch slot. Each one is logged on every
  tick, and hardening is deferred to P0.5.
- Pending correction/cancellation of partially paid or expired sales and
  their cashier UX are P0.2.
