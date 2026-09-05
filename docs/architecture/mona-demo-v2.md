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

Identifiers are UUIDs; money values are `BigInt` cents.

Core tables (Prisma):

- **User** — id, name, email (unique), passwordHash, isActive, timestamps.
- **Role** — id, code (`SELLER`, `CASHIER`, `MANAGER`, `ADMIN`), name.
- **Permission** — id, code (e.g. `sale.create`, `sale.charge`, `inventory.manage`).
- **RolePermission** — (role, permission) join.
- **Branch** — id, name, address, pointOfSaleNumber.
- **UserBranchRole** — (user, branch, role). A user may hold roles across branches.
- **Product** — id, name, slug, description, categoryId, brandId, isActive.
- **Category** / **Brand** — minimal catalogs.
- **ProductVariant** — id, productId, sku (unique), barcode (unique), color (nullable), size (nullable), price (cents), costPrice (cents), isActive.
- **Inventory** — id, variantId, branchId, physical (BigInt), reserved (BigInt); unique (variantId, branchId).
- **StockMovement** — id, inventoryId, type (`SALE`), quantityDelta, saleId?, userId, branchId, timestamp.
- **StockReservation** — id, saleId, variantId, branchId, quantity, expiresAt, status (`ACTIVE` | `RELEASED` | `CONSUMED`).
- **Sale** — id, saleNumber (branch-scoped), branchId, sellerId, status (`DRAFT` | `PENDING_PAYMENT` | `PAID` | `COMPLETED` | `CANCELLED`), subtotal, discountTotal, total (cents), timestamps.
- **SaleItem** — id, saleId, variantId, productId, productName (snapshot), variantName, sku, quantity, unitPrice (cents), subtotal (cents).
- **SalePayment** — id, saleId, method (`CASH` | `TRANSFER` | `CARD_DEBIT` | `CARD_CREDIT` | `QR`), amount (cents), receivedAmount?, changeAmount?, cashSessionId?, paidAt.
- **CashRegister** — id, branchId, name.
- **CashSession** — id, registerId, openedById, openedAt, closedById?, closedAt?, startingCash, status (`OPEN` | `CLOSED`).
- **CashMovement** — id, sessionId, type (`OPENING` | `SALE_INCOME` | `CLOSING` | `MANUAL`), amount (cents), salePaymentId?, userId, timestamp.
- **AuditLog** — id, userId, branchId, action, entityType, entityId, before/after (JSON), timestamp.

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
  generate branch-scoped sale number (concurrency-safe)
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
- `registerPayment` must be idempotent by design: a retry of the same accepted payment must not create a second `CashMovement(SALE_INCOME)` or double-count the accepted total.

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

On cancellation, or when an operation detects an expired active reservation:

- `physical` stays unchanged.
- `reserved` decreases.
- `StockReservation` transitions to `RELEASED`.
- The release is audited, but **not** represented as a physical stock movement.

---

## 6. Cash register / session

- Model: `Branch → CashRegister → CashSession`.
- `CashRegister` is an explicit entity (not "one session per branch"), so a branch can later have multiple registers without schema redesign.
- Seed **one** `CashRegister` per branch for Demo V2.
- At most **one** `CashSession` with status `OPEN` per `CashRegister` at a time.
- `CashMovement` types: `OPENING`, `SALE_INCOME`, `CLOSING`, `MANUAL`.

---

## 7. Reservations

- `StockReservation(saleId, variantId, branchId, quantity, expiresAt, status)`.
- Lifecycle: `ACTIVE → RELEASED` (cancel/expiry) or `ACTIVE → CONSUMED` (completeSale).
- Expiration is **manual/lazy** for Demo V2: the `expiresAt` field exists, released on cancellation or when an expired active reservation is detected. **No cron/worker.** Automatic expiration is a future enhancement.

---

## 8. RBAC and branch-scoped authorization

- JWT carries `userId`; the backend resolves roles and branches for the authenticated user on each request. Client-provided role/branch values are **never** trusted.
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
- Sale numbers are generated safely under concurrency (per-branch sequence with a unique constraint and retry, within the send-to-cashier transaction).

---

## 10. Realtime (Socket.IO)

- Rooms keyed by `branch:<id>`.
- Events: `sale.pending_payment`, `sale.paid`, `sale.completed`, `inventory.updated`.
- Events are **notifications**, emitted **after commit** (out-of-band or post-commit hook).
- PostgreSQL remains the source of truth. Clients refetch authoritative API state after receiving an event.
- The system must function correctly if an event is delayed, duplicated, or missed.

---

## 11. Audit strategy

- `AuditLog` rows are written **in the same transaction** as the critical operation for: sale created, sale sent to cashier, payment registered, sale completed, inventory changed, reservation released, cash session opened/closed.
- Fields: userId, branchId, action, entityType, entityId, before/after, timestamp.
- No passwords, tokens, secrets, or unnecessary sensitive values are written to audit.

---

## 12. Seed / demo data

- `prisma/seed.ts` is deterministic and idempotent.
- Branches: Centro, Yerba Buena, Tafí Viejo, Banda, Concepción, Depósito Central.
- Roles and permissions for SELLER/CASHIER/MANAGER/ADMIN.
- Demo users: `admin` (ADMIN), `manager01` (MANAGER, Centro), `seller01` (SELLER, Centro), `cashier01` (CASHIER, Centro).
- Products/variants: Remera Básica, Jean Slim, Campera Jean (with color/size variants, SKU, barcode).
- Per-branch inventory; one `CashRegister` per branch.
- Demo-only passwords; no production secrets.
- A `reset` script drops and re-seeds.

---

## 13. Testing strategy

- Tools: Vitest + Supertest.
- Runs against a real PostgreSQL test database with per-test transaction rollback.
- Priority coverage:
  - Authorization: SELLER on cashier-only endpoint → 403; CASHIER on admin-only endpoint → 403.
  - Split payment: `100000 + 60000` (of `165000`) → not paid; `100000 + 65000` → paid.
  - Duplicate completion: two `completeSale` calls deduct stock only once.
  - Stock concurrency: available = 1, two reservations → only one succeeds.
  - Transaction rollback: a mid-transaction failure leaves consistent persisted state.
  - `registerPayment` idempotency: no duplicate `CashMovement(SALE_INCOME)`.

---

## 14. Sale numbering

- Branch-scoped internal commercial number, e.g. `CEN-V-000154`, `YB-V-000087`.
- This is **not** an ARCA fiscal voucher number.
- Commercial numbering stays separated from future fiscal numbering (`pointOfSaleNumber`, `voucherNumber`, `CAE`).
- Generated safely under concurrency.

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