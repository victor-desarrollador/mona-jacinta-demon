# API Endpoints — Demo V2

Current base URL in local development:

```text
http://localhost:3001
```

Authenticated API routes are mounted under:

```text
/api/v1
```

## Money Contract

- Database: `BigInt` minor units in centavos.
- API JSON: decimal string.

Example:

```text
ARS 165.000,00 -> "16500000"
```

Do not send floating-point currency values.

## Sale Lifecycle

```text
DRAFT -> PENDING_PAYMENT -> PAID -> COMPLETED
```

`CANCELLED` is allowed for eligible draft or unpaid pending-payment sales according to the existing cancellation rules.

## Health

| Method | Path | Permission | Purpose |
| --- | --- | --- | --- |
| GET | `/health` | Public | Health check. |

## Auth

| Method | Path | Permission | Purpose |
| --- | --- | --- | --- |
| POST | `/api/v1/auth/login` | Public | Authenticate a user and return an access token plus user context. |
| GET | `/api/v1/auth/me` | Authenticated | Return the current authenticated user context. |

## Products / Variants

| Method | Path | Permission | Purpose |
| --- | --- | --- | --- |
| GET | `/api/v1/products` | `inventory.view` | List products for authorized inventory readers. |
| GET | `/api/v1/products/:id` | `inventory.view` | Get one product. |
| GET | `/api/v1/variants` | `inventory.view` | List product variants for search/browser workflows. |
| GET | `/api/v1/variants/:id` | `inventory.view` | Get one product variant. |

## Inventory

| Method | Path | Permission | Purpose |
| --- | --- | --- | --- |
| GET | `/api/v1/inventory?branchId=:branchId` | `inventory.view` with own branch scope | List inventory for a branch. |
| GET | `/api/v1/inventory/availability?branchId=:branchId&variantId=:variantId` | `inventory.view` with own branch scope | Read available stock for one or more variants in a branch. |

## Sales

| Method | Path | Permission | Purpose |
| --- | --- | --- | --- |
| GET | `/api/v1/sales` | `sale.view` | List sales visible to the authenticated user. |
| GET | `/api/v1/sales/pending` | `sale.queue.view` | List the cashier work queue: `PENDING_PAYMENT` and `PAID` sales (Pilot P0.1-C). |
| POST | `/api/v1/sales` | `sale.create` | Create a draft sale. |
| GET | `/api/v1/sales/:saleId` | `sale.view` | Get sale detail. |
| POST | `/api/v1/sales/:saleId/items` | `sale.create` | Add an item to a draft sale. |
| PATCH | `/api/v1/sales/:saleId/items/:itemId` | `sale.create` | Update item quantity in a draft sale. |
| DELETE | `/api/v1/sales/:saleId/items/:itemId` | `sale.create` | Remove an item from a draft sale. |
| POST | `/api/v1/sales/:saleId/send-to-cashier` | `sale.create` with sale branch scope | Reserve stock and transition a draft sale to pending payment. |
| POST | `/api/v1/sales/:saleId/complete` | `sale.complete` | Complete a paid sale and apply final inventory movement. Consumes only current `ACTIVE` holds, which must match the items exactly; the original `expiresAt` does not block a `PAID` sale (Pilot P0.1-C). |
| POST | `/api/v1/sales/:saleId/correct` | `SALE_CORRECT_PENDING` at the sale's location | Correct a `PENDING_PAYMENT` sale with **zero** payments: body `{ items: [{ variantId, quantity }] }` is the complete target item list (Pilot P0.2-A). |
| POST | `/api/v1/sales/:saleId/cancel` | `DRAFT`: the owning seller with `sale.create`; `PENDING_PAYMENT`: `SALE_CANCEL_PENDING` at the sale's location | Cancel an eligible draft or zero-payment pending sale. Body `{ reason, note? }` (Pilot P0.2-B). |

Pilot P0.2 contract (see [`../pilot-v1.1/00-pilot-safety-gate.md`](../pilot-v1.1/00-pilot-safety-gate.md)):

- **Correction** (`/correct`): allowed only for `PENDING_PAYMENT` with no `SalePayment` row (any payment → `409 PAYMENT_ALREADY_ACCEPTED`; other states → `409 INVALID_SALE_STATE`). The current holds must cover the items exactly and be unexpired (`409 RESERVATION_EXPIRED` / `409 INVALID_RESERVATION`). `items` must list each variant once with a positive integer quantity; an empty list is rejected (`400`), so an empty sale is impossible — cancel instead. A variant missing from the list is removed (its `SaleItem` is deleted). An increase needs available stock (`409 INSUFFICIENT_STOCK`). An unchanged list → `409 NO_CHANGES`. Only `Inventory.reserved` changes; physical stock and `StockMovement` never do, and the original hold expiry is kept. Response: `{ saleId, branchId, status, subtotal, total, items, quantities }`.
- **Cancellation** (`/cancel`): `reason` is one of `WRONG_ITEM`, `WRONG_QUANTITY`, `CUSTOMER_CHANGED_MIND`, `DUPLICATE_SALE`, `OTHER`; `note` (≤ 500 chars) is required and nonblank for `OTHER`. A `DRAFT` can be cancelled only by its own seller. Any `SalePayment` row blocks cancellation (`409 PAYMENT_ALREADY_ACCEPTED`): no refund is made and no payment or cash movement is deleted. A zero-payment pending cancellation releases the `ACTIVE` holds exactly (no `StockMovement`). There is no `PENDING_PAYMENT → DRAFT` transition.

## Cash

| Method | Path | Permission | Purpose |
| --- | --- | --- | --- |
| GET | `/api/v1/cash/register?branchId=:branchId` | Authenticated | Get the cash register for a branch. |
| GET | `/api/v1/cash/current?branchId=:branchId` | Authenticated | Get the current open cash session for a branch, if any. |
| POST | `/api/v1/cash/sessions/open` | `cash.session.open` | Open a cash session. |
| GET | `/api/v1/cash/sessions?branchId=:branchId` | `cash.session.close` at the register's location | List the most recent closed cash sessions of the branch register (CASH-1). |
| POST | `/api/v1/cash/sessions/:sessionId/close` | `cash.session.close` | Close a cash session. |

- **Close history** (`GET /cash/sessions`, CASH-1): the query accepts exactly `branchId` (UUID; any other parameter is `400`). The permission gate runs first: without `cash.session.close` the answer is `403` even for a malformed query. The service then re-checks `CASH_SESSION_CLOSE` at the register's own persisted location, so holding it at another location is still `403`; a branch without a register is `404`. The body is a JSON array (newest close first, at most 10) of `CLOSED` sessions: `sessionId`, `registerId`, `branchId`, `openedById`, `closedById`, `openedAt`, `closedAt`, `startingCash`, `status`, and the reconciliation `expectedCash`, `countedCash`, `difference` (integer centavos as strings; `difference = countedCash − expectedCash`, may be negative). Sessions closed before CASH-1 keep the three reconciliation fields `null`; they are never reconciled and never shown as a zero count.

## Payments

| Method | Path | Permission | Purpose |
| --- | --- | --- | --- |
| POST | `/api/v1/sales/:saleId/payments` | `sale.charge` | Register a payment for a pending-payment sale. Uses an idempotency key per payment intent. |
| GET | `/api/v1/sales/:saleId/payments` | `sale.view` | List payments for a sale. |

Supported payment methods:

- `CASH`
- `TRANSFER`
- `CARD_DEBIT`
- `CARD_CREDIT`
- `QR`

Cash payments support `amount`, `receivedAmount`, and backend-calculated change according to the existing payment contract.

System V2 P0-A: on this route (a `FIXED_TOTAL` sale) **only `CASH` is accepted**. `TRANSFER`, `CARD_DEBIT`, `CARD_CREDIT` and `QR` are refused with `409 NON_CASH_REQUIRES_PROPORTIONAL_CHECKOUT`, because the only valid evidence for a non-cash payment (`ExternalCollection`) exists in the proportional checkout (`POST /sales/:saleId/checkout`). The refusal writes nothing and does not consume the idempotency key. An idempotent replay of a payment recorded before this rule still returns `200` with the original payment, whatever its method. The wire contract above is unchanged; the sale's pricing model is decided by the service under the sale lock.

#### Proportional checkout (`PROPORTIONAL_V1`) — payment methods (System V2 P0-B)

Sales created under `PROPORTIONAL_V1` are paid through the checkout routes, not through `POST /sales/:saleId/payments`:

| Method | Path | Permission | Purpose |
| --- | --- | --- | --- |
| POST | `/api/v1/sales/:saleId/checkout/quote` | `sale.charge` | Price the sale for a balance method plus up to two fixed tenders (read-only). |
| POST | `/api/v1/sales/:saleId/checkout/reservations` | `sale.charge` | Reserve and seal a payment plan (price snapshot included). |
| POST | `/api/v1/sales/:saleId/checkout` | `sale.charge` | Confirm a sealed plan and settle it. |
| POST | `/api/v1/sales/:saleId/checkout/reservations/:reserveKey/close` | `sale.charge` | Declare the outcome of a reserved attempt that was not settled. |

Methods accepted in `balanceMethod` and in each tender (1 to 3 tenders, no repeated method): `CASH`, `TRANSFER`, `CARD_DEBIT`, `CARD_CREDIT` and `QR`. Any other value is `400 VALIDATION_ERROR`.

`QR` contract:

- It is priced with the company `qrAdjustmentBps` (`CompanyPricingConfig`, editable by ADMIN/OWNER only). Without a pricing configuration `QR` is `available: false` (`PRICING_CONFIG_MISSING`) in the quote and quoting it is `409 PRICING_CONFIG_MISSING`.
- The adjustment is frozen when the plan is reserved (`fullPrices.QR` in the reservation view); a later change of `qrAdjustmentBps` never alters a sealed attempt, its settlement or the resulting checkout.
- A new `QR` tender in the confirmation carries a mandatory `reference` and **no** `institution`/`institutionOther` and no `receivedAmount` (`400 VALIDATION_ERROR` otherwise); a `QR` tender backed by a recorded collection carries none of them. In the close request a `CHARGED` `QR` row carries `reference` and `evidence`, never an institution.
- The reference is unique per branch within `QR` (`409 EXTERNAL_REFERENCE_ALREADY_RECORDED`); the same text under `TRANSFER`, `CARD_DEBIT` or `CARD_CREDIT` is another namespace.
- `QR` never writes a `CashMovement` (no `SALE_INCOME`); cash-session reconciliation counts `CASH` only.
- Like every external method it is available only when `PROPORTIONAL_EXTERNAL_METHODS_ENABLED=true` (otherwise `enabledMethods` shows it unavailable with `PAYMENT_METHOD_NOT_ENABLED`), and the API refuses to start against a database older than G14 (migration `20261021140000_r3_qr`).
- `FIXED_TOTAL` sales stay cash-only (`NON_CASH_REQUIRES_PROPORTIONAL_CHECKOUT`, above).

Implementation note (not a product rule): the stored price-snapshot format is `algorithmVersion` 3 from this migration (1 = no credit price, 2 = credit price, 3 = credit and QR prices). It does not change the canonical plan text/hash: plans without `QR` keep their exact bytes and hash.

Pilot P0.1-C contract (see [`../pilot-v1.1/00-pilot-safety-gate.md`](../pilot-v1.1/00-pilot-safety-gate.md)):

- An idempotent replay (same `idempotencyKey`, same intent) is resolved first and returns `200` with the original payment, even if the sale is now `PAID`/`COMPLETED` or its hold timestamp has passed.
- A NEW payment requires exact current hold coverage: `ACTIVE` reservations on the sale's branch that match the current `SaleItem` quantities per variant. Otherwise `409 INVALID_RESERVATION`.
- With zero existing payments, every current hold must be unexpired (`expiresAt > now`), otherwise `409 RESERVATION_EXPIRED`. Once any payment exists, the original `expiresAt` no longer blocks the remaining payment.
- A rejected payment writes nothing: no `SalePayment`, `CashMovement`, status change, audit or reservation release.
- A committed payment always returns `201` (replay: `200`). A failing `sale.paid` realtime notification is logged and never turns it into an error.

`GET /api/v1/sales/pending` rows (P0.1-C, additive): `status` (`PENDING_PAYMENT` | `PAID`), `holdState` (`VALID` | `EXPIRED` | `PAYMENT_PROTECTED` | `PAID` | `COVERAGE_INVALID`) and `canAcceptPayment` (boolean). They are informational only; the payment and completion transactions re-check everything.

Pilot P0.2-C adds, per row and for the calling user: `paymentCount` (number of `SalePayment` rows), `canCorrect` (`holdState` is `VALID` and the caller holds `SALE_CORRECT_PENDING` at the sale's location) and `canCancel` (`PENDING_PAYMENT`, zero payment rows, and `SALE_CANCEL_PENDING` at the sale's location). They are informational too: `/correct` and `/cancel` re-check everything under the Sale lock. `paidAmount` and `remainingBalance` are the server's exact values; the cashier UI displays them read-only.

## Audit

| Method | Path | Permission | Purpose |
| --- | --- | --- | --- |
| GET | `/api/v1/audit` | `audit.view` | List audit log entries with pagination. |

## Backoffice

| Method | Path | Permission | Purpose |
| --- | --- | --- | --- |
| GET | `/api/v1/backoffice/dashboard` | `report.view` | Read dashboard summary metrics. |
| GET | `/api/v1/backoffice/sales` | `report.view` | List sales for reporting/history views. |
| GET | `/api/v1/backoffice/sales/:id` | `report.view` | Read one sale with items, payments, and operational detail. |
| GET | `/api/v1/backoffice/inventory` | `report.view` | List inventory rows for backoffice visibility. |
| GET | `/api/v1/backoffice/branches` | `report.view` | List branches available to the backoffice. |
| GET | `/api/v1/backoffice/users` | `user.manage` | List users, roles, and branches for admin visibility. |

## Admin Reservation Maintenance

| Method | Path | Permission | Purpose |
| --- | --- | --- | --- |
| POST | `/api/v1/admin/reservations/release-expired` | `inventory.manage` | Release expired eligible stock reservations. |

Pilot P0.1-B1 contract (see [`../pilot-v1.1/00-pilot-safety-gate.md`](../pilot-v1.1/00-pilot-safety-gate.md)):

- Scope: only locations where the caller's own assignment grants `INVENTORY_MANAGE` (never the cross-assignment location union).
- Eligible: `ACTIVE` holds with `expiresAt <= now` on `PENDING_PAYMENT` sales with zero `SalePayment` rows. Any payment row protects the hold.
- One transaction per sale, at most 100 sales per call; release writes no `StockMovement`.
- Response `200`: `{ "released": [{ "saleId", "branchId", "quantities": [{ "variantId", "quantity" }] }], "failed": [{ "saleId", "code" }] }`. A `failed` entry rolled back only that sale.
- Audit: one `RESERVATION_RELEASED` per released sale, attributed to the caller, `after.trigger = "ADMIN"`.

## Architecture References

See [`../architecture/mona-demo-v2.md`](../architecture/mona-demo-v2.md) for the authoritative design notes on BigInt money, DB-resolved authorization, JWT identity only, branch scoping, stock reservation lifecycle, payment idempotency, Serializable transactions, `SELECT FOR UPDATE`, and post-commit Socket.IO notifications.
