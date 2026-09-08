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
| GET | `/api/v1/sales/pending` | `sale.queue.view` | List pending-payment sales for cashier queue workflows. |
| POST | `/api/v1/sales` | `sale.create` | Create a draft sale. |
| GET | `/api/v1/sales/:saleId` | `sale.view` | Get sale detail. |
| POST | `/api/v1/sales/:saleId/items` | `sale.create` | Add an item to a draft sale. |
| PATCH | `/api/v1/sales/:saleId/items/:itemId` | `sale.create` | Update item quantity in a draft sale. |
| DELETE | `/api/v1/sales/:saleId/items/:itemId` | `sale.create` | Remove an item from a draft sale. |
| POST | `/api/v1/sales/:saleId/send-to-cashier` | `sale.create` with sale branch scope | Reserve stock and transition a draft sale to pending payment. |
| POST | `/api/v1/sales/:saleId/complete` | `sale.complete` | Complete a paid sale and apply final inventory movement. |
| POST | `/api/v1/sales/:saleId/cancel` | `sale.create` | Cancel an eligible draft or unpaid pending-payment sale. |

## Cash

| Method | Path | Permission | Purpose |
| --- | --- | --- | --- |
| GET | `/api/v1/cash/register?branchId=:branchId` | Authenticated | Get the cash register for a branch. |
| GET | `/api/v1/cash/current?branchId=:branchId` | Authenticated | Get the current open cash session for a branch, if any. |
| POST | `/api/v1/cash/sessions/open` | `cash.session.open` | Open a cash session. |
| POST | `/api/v1/cash/sessions/:sessionId/close` | `cash.session.close` | Close a cash session. |

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

## Architecture References

See [`../architecture/mona-demo-v2.md`](../architecture/mona-demo-v2.md) for the authoritative design notes on BigInt money, DB-resolved authorization, JWT identity only, branch scoping, stock reservation lifecycle, payment idempotency, Serializable transactions, `SELECT FOR UPDATE`, and post-commit Socket.IO notifications.
