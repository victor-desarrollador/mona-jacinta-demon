# Mona Jacinta — Demo V2 Architecture

Status: Approved
Scope: Demo V2 (migration foundation)
Related: AGENTS.md (root), `docs/plans/` (implementation plan, to be written next)

---

## 1. Purpose and scope

This document defines the target architecture for **Mona Jacinta Demo V2**, moving the
repository from a legacy e-commerce codebase toward a centralized multiuser and
multibranch commercial management system.

Demo V2 proves a single vertical business flow against persisted PostgreSQL state:

```text
SELLER   login → create draft sale → add variants → send to cashier
CASHIER  receives pending sale → register split payments → finalize sale
SYSTEM   commits inventory transactionally → persists stock movements + audit → notifies via realtime
```

Everything outside this flow is explicitly out of scope for Demo V2 (see §16).

---

## 2. Application responsibilities and reuse

The Demo V2 target lives entirely in **this** repository (`mona-jacinta-demon/`). The legacy
implementation lives in the **read-only** reference repository `../Tesis/` and is treated
as reference material only; it is never modified and does not run inside this repository.

```text
mona-jacinta-demon/              ← clean Demo V2 target (this repo)
  client/  → new Operations application (SELLER / CASHIER)
  admin/   → new Backoffice (MANAGER / ADMIN)
  api/     → new Express + TypeScript + PostgreSQL backend

../Tesis/                       ← read-only legacy reference
  client/  → legacy e-commerce Next.js app
  admin/   → legacy React/Vite admin (contains experimental POS)
  server/  → legacy Express + MongoDB/Mongoose backend
```

| App        | Target role                  | Reuse from existing code |
| ---------- | ---------------------------- | ------------------------ |
| `client/`  | new Operations — SELLER, CASHIER | `components/ui/*` primitives, `cn`/`lib/utils`, currency formatting. Replaces e-commerce routes with POS + cashier screens. Ports the legacy `admin/POS.tsx` interaction structure (barcode/SKU search → variant selector → cart → send-to-cashier) but backs it with `api/` instead of mock data. |
| `admin/`   | new Backoffice — MANAGER, ADMIN  | Shell (Sidebar/Header/App), UI kit, charts. Ports `SalesHistory`/inventory views onto `api/`. Retires `mockData.ts` and localStorage stores (`useSalesStore`, `useStockStore`). |
| `server/` (legacy, `../Tesis/`)  | Legacy, frozen               | Read-only reference only. No new feature work. Nothing copied one-to-one. |
| `api/`     | new source of truth          | Fresh build. Express + TypeScript + Prisma + PostgreSQL + Zod + JWT + bcrypt + Socket.IO + Vitest + Supertest. |

**Stack decisions (confirmed):**

- `client/` stays on **Next.js 16 App Router**.
- Money is **integer minor units (cents)** as `BigInt` across PostgreSQL, API, frontend, and tests.
- Demo V2 includes a **minimal cash session** (see §6).

### Reusable from the admin POS experiment

The experimental `admin/src/pages/POS.tsx` in the **legacy `../Tesis/admin/`** is **not** backed by a backend — it uses
`mockData.ts` and Zustand stores persisted to `localStorage`. It is a genuinely useful
**UI/interaction blueprint** (search by barcode/SKU/name, color+size variant selector,
cart quantity management, payment modal), but:

- `mockData.ts` — retired (in-browser data is an anti-pattern for a server-authoritative system).
- `useSalesStore` / `useStockStore` (localStorage) — retired.
- The interaction flow is **ported** into the new `client/`, bound to `api/`.

---

## 3. E-commerce assumptions discarded

| Legacy assumption | Disposition |
| ----------------- | ----------- |
| `Order` with `deliveryMethod`, `shippingAddress`, Stripe/MercadoPago | Replaced by `Sale` + `SaleItem` + `SalePayment`. No shipping. |
| Single `paymentMethod` enum on the order | Replaced by `SalePayment[]` collection supporting split payments. |
| `Product.stock` (global single number) | Replaced by `Inventory` per `ProductVariant` × `Branch`. |
| `variants[]` as "options" (tono/talle/fragancia strings) | Replaced by `ProductVariant` as the sellable entity (SKU, barcode, color, size). |
| User `role ∈ {cliente, admin}` | Replaced by `User` + `Role` + `Permission`, scoped via `UserBranchRole`. |
| Checkout/Stripe/MercadoPago flows | Out of scope for Demo V2. |
| Frontend POS in legacy `admin/` with localStorage stores | Retired; superseded by server-authoritative POS in the new `client/`. |

---

## 4. PostgreSQL domain model

Identifiers are UUIDs; money values are `BigInt` **minor units (centavos)** — ARS 165,000.00 is `16500000`, never `165000`. At JSON boundaries money is a decimal string (`"16500000"`); a single recursive `toJsonSafe` helper converts `bigint` → string (arrays/objects recursively, `Date` preserved) for API responses, Socket.IO payloads, and Prisma `Json` fields such as `AuditLog.before/after` — native `bigint` never crosses a JSON boundary.

Core tables (Prisma) — exactly **21 models**:

- **User** — id, name, email (unique), passwordHash, isActive, timestamps.
- **Role** — id, code (`SELLER`, `CASHIER`, `MANAGER`, `ADMIN`), name.
- **Permission** — id, code (e.g. `sale.create`, `sale.charge`, `inventory.manage`).
- **RolePermission** — (role, permission) join.
- **Branch** — id, name, `code` (unique short commercial prefix used in sale numbers, e.g. `CEN`), address, pointOfSaleNumber.
- **UserBranchRole** — (user, branch, role). A user may hold roles across branches.
- **Product** — id, name, slug, description, categoryId, brandId, isActive.
- **Category** / **Brand** — minimal catalogs.
- **ProductVariant** — id, productId, sku (unique), barcode (unique), color (nullable), size (nullable), price (cents), costPrice (cents), isActive.
- **Inventory** — id, variantId, branchId, physical (BigInt), reserved (BigInt); unique (variantId, branchId).
- **StockMovement** — id, inventoryId, type (`SALE`), quantityDelta, saleId?, userId, branchId, timestamp.
- **StockReservation** — id, saleId, variantId, branchId, quantity, expiresAt, status (`ACTIVE` | `RELEASED` | `CONSUMED`).
- **Sale** — id, saleNumber (branch-scoped; `unique(branchId, saleNumber)`), branchId, sellerId, status (`DRAFT` | `PENDING_PAYMENT` | `PAID` | `COMPLETED` | `CANCELLED`), subtotal, discountTotal, total (cents), timestamps.
- **SaleNumberCounter** — id, branchId (unique FK to Branch), nextValue (BigInt, starts at 1). The per-branch persisted counter behind `saleNumber`; its row is locked `FOR UPDATE` during send-to-cashier, read, and incremented in the same transaction. The next number is **never** derived by scanning previous sales.
- **SaleItem** — id, saleId, variantId, productId, productName (snapshot), variantName, sku, quantity, unitPrice (cents), subtotal (cents).
- **SalePayment** — id, saleId, method (`CASH` | `TRANSFER` | `CARD_DEBIT` | `CARD_CREDIT` | `QR`), amount (cents), receivedAmount?, changeAmount?, cashSessionId?, `idempotencyKey` (client UUID v4 per payment intent; `unique(saleId, idempotencyKey)` — sale-scoped; the constraint is the final race guard), paidAt.
- **CashRegister** — id, branchId, name.
- **CashSession** — id, registerId, openedById, openedAt, closedById?, closedAt?, startingCash, status (`OPEN` | `CLOSED`).
- **CashMovement** — id, sessionId, type (`OPENING` | `SALE_INCOME` | `CLOSING` | `MANUAL`), amount (cents), salePaymentId?, userId, timestamp.
- **AuditLog** — id, userId, branchId, action, entityType, entityId, before/after (JSON; bigint values normalized to decimal strings via `toJsonSafe` before write), timestamp.

**Deliberately absent in Demo V2:** there is no refresh-token model/table — authentication is access-token-only (see §8).

**Inventory invariants:**

- `physical` and `reserved` only. **No `inTransit`** — it belongs to the future transfer/warehouse domain.
- `available = physical − reserved`, computed at read time, never stored.
- Inventory references `ProductVariant`, never `Product`.

---

## 5. Sale lifecycle and transaction boundaries

Lifecycle: `DRAFT → PENDING_PAYMENT → PAID → COMPLETED`, plus `CANCELLED` (from `DRAFT` or `PENDING_PAYMENT`).

### 5.1 Send to cashier — `DRAFT → PENDING_PAYMENT`

```
BEGIN
  require Sale = DRAFT
  validate available >= qty for all items
  increment Inventory.reserved
  create StockReservation(ACTIVE) per item
  allocate branch-scoped sale number from the SaleNumberCounter row
    (locked FOR UPDATE in this same transaction; increment nextValue)
  transition Sale: DRAFT -> PENDING_PAYMENT
  write AuditLog
COMMIT
```

A reservation is a **logical hold**, not a physical movement: `physical` stays unchanged,
`reserved` increases, and no `StockMovement` is created.

### 5.2 Register payment — `PENDING_PAYMENT → PAID`

```
BEGIN
  require Sale = PENDING_PAYMENT
  validate payment (method, amount)

  create SalePayment

  if method = CASH:
    require an OPEN CashSession (for the register/branch)
    create CashMovement(SALE_INCOME)
    link CashMovement to SalePayment and CashSession

  recalculate accepted payment total

  if accepted total == Sale.total:
    transition Sale: PENDING_PAYMENT -> PAID

  write AuditLog
COMMIT
```

- A sale becomes `PAID` **only** when `Σ accepted payments = total`. Partial sums never mark it paid.
- For `CASH`, `SalePayment` distinguishes `amount` (what counts toward the sale), `receivedAmount` (gross handed over), and `changeAmount` (received − amount). Returned change is not revenue; the sale revenue is `amount`.
- `registerPayment` must be idempotent by design: a retry of the same accepted payment must not create a second `CashMovement(SALE_INCOME)` or double-count the accepted total. Mechanism: client-generated `idempotencyKey` with `unique(saleId, idempotencyKey)`; same key + same payload returns the existing accepted payment, same key + different payload is rejected (`409 IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD`); the unique constraint — not a find-then-create check — is the final race protection.
- Financial acceptance is serialized per sale by locking the `Sale` row (`SELECT ... FOR UPDATE`) and re-validating `amount <= remaining` inside that transaction, so concurrent payments can never exceed `Sale.total`.

### 5.3 Complete sale — `PAID → COMPLETED`

```
BEGIN
  require Sale = PAID
  validate ACTIVE reservations present
  lock required Inventory rows
  validate inventory/reservation invariants

  decrement Inventory.physical
  decrement Inventory.reserved

  mark StockReservation = CONSUMED

  create StockMovement(type=SALE, quantityDelta=-qty)

  transition Sale: PAID -> COMPLETED

  write AuditLog
COMMIT
```

`completeSale` accepts **only** a Sale in `PAID`. It is the single atomic point where
physical inventory is actually decremented. Payment (`PAID`) and inventory finalization
(`COMPLETED`) are intentionally separated.

The Sale row is locked `FOR UPDATE` first. If the status is already `COMPLETED`, the call
returns the authoritative persisted sale with **zero** further changes (no repeated
physical/reserved decrement, no second `StockMovement`, reservations stay `CONSUMED`) —
exactly one physical finalization can ever occur, and no client idempotency key is needed.

### 5.4 Failure / compensation behavior

If payment succeeds but `completeSale` fails:

- Sale remains `PAID`.
- `SalePayment` remains persisted.
- `CashMovement` remains persisted (when applicable).
- `StockReservation` remains `ACTIVE`.
- Physical inventory remains unchanged.
- The cashier may retry `completeSale`.
- The customer must **not** be charged again.

Semantics: **PAID = financial obligation satisfied. COMPLETED = operational/inventory finalization committed.**

### 5.5 Cancellation / reservation release

Cancellation is payment-gated:

- `DRAFT` → cancellation allowed (no reservations exist yet).
- `PENDING_PAYMENT` with `acceptedPaymentTotal == 0` → allowed; reservations are released.
- `PENDING_PAYMENT` with any accepted payment → **forbidden** (`409 PAYMENT_ALREADY_ACCEPTED`).
- `PAID` / `COMPLETED` → never cancelled in Demo V2.
- A sale that holds accepted payments can therefore never reach `CANCELLED`; refunds, reversals, and chargebacks are out of scope.

On cancellation, or when an operation detects an expired active reservation (see §7):

- `physical` stays unchanged.
- `reserved` decreases.
- `StockReservation` transitions to `RELEASED`.
- The release is audited (AuditLog in the same transaction), but **not** represented as a physical stock movement.

---

## 6. Cash register / session

- Model: `Branch → CashRegister → CashSession`.
- `CashRegister` is an explicit entity (not "one session per branch"), so a branch can later have multiple registers without schema redesign.
- Seed **one** `CashRegister` per branch for Demo V2.
- At most **one** `CashSession` with status `OPEN` per `CashRegister` at a time, enforced at the database level by a partial unique index `UNIQUE ("registerId") WHERE status = 'OPEN'` (hand-written SQL in the initial migration; Prisma schema cannot express partial indexes). Concurrent opens are resolved by the database, not by a find-then-create check.
- `CashMovement` types: `OPENING`, `SALE_INCOME`, `CLOSING`, `MANUAL`.

---

## 7. Reservations

- `StockReservation(saleId, variantId, branchId, quantity, expiresAt, status)`.
- Lifecycle: `ACTIVE → RELEASED` (cancel/expiry) or `ACTIVE → CONSUMED` (completeSale).
- Expiration is **manual/lazy** for Demo V2: there is **no cron/worker**. A lazy release is applied only when **all** hold: parent sale is `PENDING_PAYMENT`, that sale's `acceptedPaymentTotal == 0`, the reservation is `ACTIVE`, and `expiresAt < now()`.
- A `PENDING_PAYMENT` sale with any accepted payment is never touched by expiry. A `PAID` sale's `ACTIVE` reservation is never released because `expiresAt` elapsed — `completeSale` consumes it (`ACTIVE → CONSUMED`) regardless of the timestamp.

---

## 8. RBAC and branch-scoped authorization

- JWT carries **identity only** (`sub`, `iat`, `exp`, optional `jti`) — never roles, permissions, or branch lists. The backend resolves roles, permissions, and branches from PostgreSQL on **every** HTTP request, and from PostgreSQL again at each Socket.IO connection before joining branch rooms. Client-provided role/branch values are **never** trusted; a resource's branch (e.g. `Sale.branchId`) is derived from the persisted row.
- Demo V2 uses **short-lived access tokens only** — no refresh tokens, no rotation, no refresh endpoint or cookie. On expiry the user logs in again.
- Authorization via explicit permission checks (`requirePermission(perm, branchScope)`) → 403. Avoid scattered `if (user.role === "admin")`.
- Branch scope: SELLER/CASHIER scoped to their branch; MANAGER to their branch(es); ADMIN global.
- The authorization matrix in `AGENTS.md` is authoritative.
- Frontend visibility is never a security boundary; the backend is always authoritative.

---

## 9. Concurrency strategy

- `completeSale` runs in a single Prisma interactive `$transaction`.
- Inventory rows are locked (`SELECT … FOR UPDATE`) to serialize concurrent completion and reservation.
- The `require Sale = PAID` status check is the idempotency guard against double-completion.
- Reservation validation uses row locks so two sellers cannot reserve the last physical unit.
- No slow external network calls inside a transaction.
- Sale numbers are allocated within the send-to-cashier transaction by locking the branch's `SaleNumberCounter` row (`SELECT ... FOR UPDATE`), reading `nextValue`, and incrementing it; `unique(branchId, saleNumber)` on `Sale` is the final database guard. The counter's BigInt is formatted via decimal string padding, never coerced through JavaScript `Number`.

---

## 10. Realtime (Socket.IO)

- Rooms keyed by `branch:<id>`; room membership is authorized from the user's current DB-resolved branches (ADMIN via global permission) — never from a client-requested room name.
- Events: `sale.pending_payment`, `sale.paid`, `sale.completed`, `inventory.updated`.
- Events are **notifications**, emitted **after commit** with the simplest reliable mechanism: the service awaits the transaction promise (which resolves only after COMMIT, returning an event descriptor), and the caller then emits `io.to(branch:*).emit(...)` outside the transaction. No fake ORM "after commit" hooks; no outbox table for Demo V2 realtime (outbox remains the future pattern for durable external integrations such as ARCA).
- A failed or missed emit never rolls back or mutates committed state. PostgreSQL remains the source of truth; clients refetch authoritative API state after receiving an event.
- The system must function correctly if an event is delayed, duplicated, or missed.

---

## 11. Audit strategy

- `AuditLog` rows are written **in the same transaction** as the critical operation for: sale created, sale sent to cashier, payment registered, sale completed, inventory changed, reservation released, cash session opened/closed.
- Fields: userId, branchId, action, entityType, entityId, before/after, timestamp.
- No passwords, tokens, secrets, or unnecessary sensitive values are written to audit.

---

## 12. Seed / demo data

- `prisma/seed.ts` is deterministic and idempotent.
- Branches: Centro (`CEN`), Yerba Buena (`YB`), Tafí Viejo (`TV`), Banda (`BAN`), Concepción (`CON`), Depósito Central (`DEP`); one `SaleNumberCounter` per branch (`nextValue = 1`).
- Roles and permissions for SELLER/CASHIER/MANAGER/ADMIN.
- Demo users: `admin` (ADMIN), `manager01` (MANAGER, Centro), `seller01` (SELLER, Centro), `cashier01` (CASHIER, Centro).
- Products/variants: Remera Básica, Jean Slim, Campera Jean (with color/size variants, SKU, barcode).
- Per-branch inventory; one `CashRegister` per branch.
- Demo-only passwords; no production secrets.
- A `reset` script drops and re-seeds.

---

## 13. Testing strategy

- Tools: Vitest + Supertest.
- Runs against a dedicated PostgreSQL test database with per-test `TRUNCATE ... RESTART IDENTITY CASCADE` (not transaction rollback — Supertest performs real HTTP requests against the app's own connections). DB-backed test files run **sequentially** (`fileParallelism: false`): truncation isolation is unsafe across parallel workers.
- Priority coverage (money in minor units / centavos):
  - Authorization: SELLER on cashier-only endpoint → 403; SELLER on the cashier queue (`sale.queue.view`) → 403; CASHIER on admin-only endpoint → 403.
  - Split payment: `"10000000" + "6000000"` (of `"16500000"`) → not paid; `"10000000" + "6500000"` → paid.
  - Payment concurrency: two concurrent payments for the same remaining balance → exactly one accepted; total never exceeded.
  - Duplicate completion: sequential and concurrent `completeSale` calls → exactly one physical finalization.
  - Stock concurrency: available = 1, two reservations → only one succeeds.
  - Transaction rollback: a mid-transaction failure leaves consistent persisted state.
  - `registerPayment` idempotency: no duplicate `CashMovement(SALE_INCOME)`; key reuse with a different payload → 409.

---

## 14. Sale numbering

- Branch-scoped internal commercial number, e.g. `CEN-V-000154`, `YB-V-000087` — `<BRANCH.code>-V-<SEQ>`.
- Sequence comes from the persisted per-branch `SaleNumberCounter` (row locked `FOR UPDATE`, incremented inside the send-to-cashier transaction); `unique(branchId, saleNumber)` is the final guard.
- This is **not** an ARCA fiscal voucher number.
- Commercial numbering stays separated from future fiscal numbering (`pointOfSaleNumber`, `voucherNumber`, `CAE`).

---

## 15. Migration strategy (MongoDB → PostgreSQL)

- Demo V2 seeds PostgreSQL deterministically; it does **not** migrate live MongoDB data.
- The legacy `../Tesis/server/` remains available as read-only reference during migration; it is outside this repository and never modified.
- Future `scripts/migrate-mongo-to-postgres.ts` (in this repository) maps Mongo `Product → Product/Variant/Inventory` and `User → User/Role/Branch`, treated as a separate concern.
- No live data migration in Demo V2.

---

## 16. Out of scope (Demo V2)

- Production ARCA/CAE integration and fiscal tax breakdown.
- Supplier management, purchasing, transfers, warehouses.
- `inTransit` inventory.
- Seller discount workflows (a `discountTotal` field may exist, defaulting to zero; no authorization or UI required).
- Full Users/Roles/Branches CRUD (read-only views are acceptable if inexpensive).
- Commercial reservations/señas, exchanges/returns, marketing loans.
- Refunds, reversals, chargebacks, or any payment compensation flow.
- Mobile app.
- Advanced reporting.
- Public ecommerce storefront.
- Monorepo/workspace restructuring, microservices, Kubernetes.

---

## 17. Open decisions carried forward (non-blocking)

These are intentionally deferred to later phases and do **not** block Demo V2:

- Automatic reservation-expiration worker/job.
- `inTransit` inventory and the transfer/warehouse domain.
- ARCA fiscal numbering, voucher, CAE, and tax breakdown.
- Multi-register cash handling beyond the single-register-per-branch seed.
- Seller discount authorization workflow.
- MongoDB → PostgreSQL historical data migration.