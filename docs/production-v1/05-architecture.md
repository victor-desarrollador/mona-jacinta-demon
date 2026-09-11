# 05-architecture

**Status**: Production V1 Architecture Baseline  
**Scope**: Production V1 (Day 25–35)  
**Related**: 00-master-index, 01-product-scope, 02-functional-requirements, 03-role-permission-matrix, 04-domain-rules, 06-erd-data-model, 07-inventory-ledger

---

## 1. Architecture Goals

| Goal | Description |
|------|-------------|
| Data integrity | PostgreSQL transactions, row locks, invariants enforced at DB layer |
| Security | Permission + scope authorization on every request; no client-trusted role/branch |
| Business rules | Domain logic in services, not controllers; immutable audit trail |
| Traceability | Every critical operation writes AuditLog in same transaction |
| Testability | Vitest + Supertest against isolated test DB; deterministic seed |
| Clarity | Modular monolith with explicit bounded contexts |
| No overengineering | Single company deployment; no SaaS tenancy; no microservices |

---

## 2. System Context

```text
┌─────────────────────────────────────────────────────────────┐
│                      Mona Jacinta Company                    │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │ 5 Retail     │  │ 5 Retail     │  │ Central          │   │
│  │ Branches     │  │ Branches     │  │ Warehouse/Depot  │   │
│  │ (SELLER/     │  │ (SELLER/     │  │ (WAREHOUSE)      │   │
│  │  CASHIER)    │  │  CASHIER)    │  │                  │   │
│  └──────┬───────┘  └──────┬───────┘  └────────┬─────────┘   │
│         │                 │                     │            │
│         └─────────────────┼─────────────────────┘            │
│                           ▼                                   │
│              ┌────────────────────────┐                      │
│              │   Express API (api/)   │                      │
│              │  Modular Monolith      │                      │
│              │  TypeScript + Prisma   │                      │
│              └───────────┬────────────┘                      │
│                          │                                    │
│              ┌───────────▼────────────┐                      │
│              │  Supabase PostgreSQL   │                      │
│              │  (Primary DB)          │                      │
│              └───────────┬────────────┘                      │
│                          │                                    │
│              ┌───────────▼────────────┐  ┌────────────────┐  │
│              │  Supabase Storage      │  │  Supabase      │  │
│              │  (Product images,      │  │  Realtime      │  │
│              │   GoodsReceipt docs)   │  │  (Notifications)│  │
│              └────────────────────────┘  └────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

**Frontend** (deployed separately):
- `client/` — Next.js 16 App Router → Operations (SELLER, CASHIER)
- `admin/` — React 19 + Vite → Backoffice (ADMIN, OWNER)

**Backend** — Express + TypeScript + Prisma + PostgreSQL (single deployed service)

---

## 3. Deployment Topology

| Component | Target | Notes |
|-----------|--------|-------|
| Frontend (client/admin) | Vercel | Static + SSR |
| API (Express) | Container / VM | Long-lived process for Socket.IO / Realtime |
| PostgreSQL | Supabase | Hosted; two projects: demo + test |
| Object Storage | Supabase Storage | Product images, GoodsReceipt attachments |
| Realtime | Supabase Realtime Broadcast | Notifications; fallback to Socket.IO if needed |
| Secrets | Server-only env vars | Never exposed to frontend |

**Key constraint**: The Express API must be a long-lived process (not serverless) to support:
- WebSocket connections for realtime notifications
- Row-level locking (`SELECT ... FOR UPDATE`) requiring persistent connections
- Transactional consistency across inventory mutations

---

## 4. Modular Monolith — Bounded Contexts

```
api/src/
├── modules/
│   ├── identity/           # Users, Authentication, JWT
│   ├── rbac/               # Roles, Permissions, RolePermission
│   ├── organization/       # Company, Location (Branch/Warehouse)
│   ├── catalog/            # Product, ProductVariant, Category, Brand, ProductImage
│   ├── pricing/            # Price rules, discounts, bulk operations
│   ├── inventory/          # InventoryBalance, StockMovement, StockHold
│   ├── goods-receiving/    # GoodsReceipt, GoodsReceiptItem, Supplier
│   ├── suppliers/          # Supplier, supplied products, purchase history
│   ├── transfers/          # StockTransfer, TransferItem, Remito
│   ├── pos/                # Sale, SaleItem, SalePayment, SaleNumberCounter
│   ├── payments/           # Payment processing, idempotency, cash logic
│   ├── cash/               # CashRegister, CashSession, CashMovement
│   ├── sena/               # CommercialSena, SenaItem
│   ├── exchanges/          # Exchange, ExchangeItem
│   ├── publication/        # PublicationCheckout, PublicationItem, PublicationReturn
│   ├── documents/          # Numbering sequences (sale, remito, etc.)
│   ├── notifications/      # Notification, NotificationPreference
│   ├── audit/              # AuditLog
│   ├── reporting/          # Report queries, exports
│   ├── fiscal/             # FiscalProvider, ARCAProvider (interface + impl)
│   └── storage/            # Media metadata, upload/replacement/deletion
├── shared/
│   ├── db/                 # Prisma client, transaction helpers
│   ├── auth/               # JWT, password hashing
│   ├── money/              # BigInt minor units, toJsonSafe
│   ├── errors/             # Domain errors, HTTP mapping
│   ├── validation/         # Zod schemas
│   └── realtime/           # Notification emitter (transport-agnostic)
├── middleware/
│   ├── auth.ts             # JWT validation, user context
│   ├── rbac.ts             # Permission + scope enforcement
│   └── idempotency.ts      # Idempotency key handling
└── app.ts / server.ts      # Express bootstrap
```

### Module Dependency Rules

```
identity, rbac, organization
        │
        ▼
catalog, pricing, inventory ──────► goods-receiving, suppliers
        │                                  │
        ▼                                  ▼
pos, payments, cash            transfers
        │                                  │
        ▼                                  ▼
sena, exchanges, publication
        │
        ▼
documents, notifications, audit, reporting
        │
        ▼
fiscal (consumes completed Sale + Payment)
storage (consumed by catalog, goods-receiving)
```

**Rules**:
- Modules only depend **downward** (no cycles)
- `identity`, `rbac`, `organization` are foundation modules — no dependencies on business modules
- `fiscal` only reads completed transactions; never mutates core state
- `storage` is infrastructure; domain modules reference media by key, not binary data
- Cross-module queries go through service layer, not direct Prisma across contexts

---

## 5. Security / RBAC Architecture

### Authorization Formula

```
authorization = permission
              + authorized scope (Location(s))
              + resource state / business rule
```

### Role Definitions

| Role | Default Scope | Permissions (key) |
|------|---------------|-------------------|
| OWNER | Company-wide (all locations) | All (implicit) |
| ADMIN | Explicitly assigned locations | Granted permissions + scope |
| CASHIER | Assigned retail branches | SALE_CHARGE, SALE_COMPLETE, CASH_SESSION_*, EXCHANGE_MANAGE, PUBLICATION_*, SENA_CREATE, TRANSFER_REQUEST, TRANSFER_VIEW, TRANSFER_APPROVE, TRANSFER_DISPATCH, TRANSFER_RECEIVE |
| SELLER | Assigned retail branches | SALE_CREATE, SALE_VIEW (own), INVENTORY_VIEW, SENA_CREATE, TRANSFER_REQUEST, TRANSFER_VIEW |
| WAREHOUSE | Central warehouse (+ explicit branches) | TRANSFER_*, GOODS_RECEIPT, SUPPLIER_MANAGE, INVENTORY_MANAGE, PRODUCT_IMAGE_MANAGE |

### Scope Model

```prisma
model UserRoleScope {
  id        String @id @default(uuid())
  userId    String
  roleId    String
  // Scope kind determines how locationId is interpreted
  scopeKind ScopeKind @default(LOCATION)  // LOCATION | COMPANY
  locationId String?  // Required when scopeKind = LOCATION; must be null when scopeKind = COMPANY
  
  @@unique([userId, roleId, scopeKind, locationId])
}
```

> **PostgreSQL enforcement (not Prisma):** Prisma has no `@@check`. The scope/location consistency rule below is enforced via an explicit PostgreSQL `CHECK` constraint in a raw-SQL migration, and the `scopeKind + locationId` uniqueness is enforced by a PostgreSQL unique index (the existing `@@unique` covers the non-null rows; NULL-handling for company-scope rows uses PostgreSQL 15+ `NULLS NOT DISTINCT` or an equivalent partial unique index strategy).

```prisma
enum ScopeKind {
  LOCATION
  COMPANY
}
```

- Replaces Demo V2 `UserBranchRole` with unified location/company scope
- **LOCATION scope**: `locationId` required → user authorized for that specific Location
- **COMPANY scope**: `locationId` must be null → user authorized company-wide
- OWNER: implicit COMPANY scope (enforced in middleware; no row required)
- ADMIN: may receive COMPANY scope only through explicit `UserRoleScope` row; ADMIN role alone never implies global access
- SELLER / CASHIER / WAREHOUSE: normally LOCATION-scoped
- A user may have different roles with different scopes where legitimately required

### Enforcement

- Middleware resolves `userId` from JWT → loads permissions + scopes from DB
- Every mutating endpoint: `requirePermission('PERMISSION_CODE', requiredScope)`
- Resource branch/location derived from persisted entity (e.g., `Sale.locationId`), never from request
- Frontend visibility ≠ security boundary

### Scope Sensitivities for Global Resources

- Pricing and catalog are **global** (not per-location). `PRICE_MANAGE`, `PRODUCT_MANAGE`, and `PRODUCT_VARIANT_MANAGE` therefore require **COMPANY** scope (or OWNER implicit scope); a LOCATION-scoped ADMIN must not alter global Product/ProductVariant pricing or the global catalog. Per-location pricing remains deferred.

---

## 6. Transaction Strategy

| Operation | Transaction Boundary | Locking |
|-----------|---------------------|---------|
| Send to cashier (DRAFT→PENDING) | Single TX | Sale row, Inventory rows, SaleNumberCounter |
| Register payment | Single TX | Sale row (FOR UPDATE) |
| Complete sale (PAID→COMPLETED) | Single TX | Sale row, Inventory rows, StockReservation rows |
| GoodsReceipt completion | Single TX | Inventory rows, GoodsReceipt row |
| Transfer dispatch | Single TX | Origin Inventory rows, Transfer row |
| Transfer receive | Single TX | Destination Inventory rows, Transfer row |
| SEÑA creation | Single TX | Inventory row (validate available) |
| Exchange | Single TX | Both branch Inventory rows, original Sale |
| Publication checkout/return | Single TX | Inventory row |
| Number allocation | Single TX | Counter row (FOR UPDATE) |

**Principles**:
- One DB transaction per business operation
- `SELECT ... FOR UPDATE` on inventory/counter rows before mutation
- No external calls (ARCA, email, storage) inside critical TX
- Outbox pattern for ARCA (see §21)
- AuditLog written in same TX

---

## 7. Concurrency Strategy

| Scenario | Mechanism |
|----------|-----------|
| Two sellers reserve last unit | Row lock on Inventory + validate `available >= qty` in same TX |
| Double sale completion | Sale status check (`require PAID`) + row lock |
| Concurrent payments | Sale row `FOR UPDATE` + re-validate remaining |
| SEÑA on last unit | Inventory row lock + validate available |
| Transfer dispatch/receive | Inventory row locks on origin/destination |
| Number allocation | Counter row `FOR UPDATE` |

**Idempotency**:
- SalePayment: `unique(saleId, idempotencyKey)` — client UUID v4
- GoodsReceipt completion: status guard (`IN_PROGRESS` → `COMPLETED` once)
- Number allocation: counter increment inside TX

---

## 8. Product / Variant / Barcode Architecture

### Barcode Migration (Demo V2 → Production V1)

**Demo V2**: `barcode` on `ProductVariant` (unique)  
**Production V1**: `barcode` on `Product` (unique, Code 128)

Migration path:
1. Add `barcode` to `Product` (unique, nullable during migration)
2. Backfill: for each Product, pick one variant's barcode as Product barcode (or generate new)
3. Drop `barcode` from `ProductVariant`
4. Add unique index on `Product.barcode`

### Product Image / Object Storage

- **Metadata** in DB: `ProductImage` table (belongs to Product, not Variant)
- **Binary data** in Supabase Storage: key = `products/{productId}/{uuid}.{ext}`
- One primary image per Product (enforced by unique partial index on `isPrimary=true`)
- MIME validation: `image/jpeg`, `image/png`, `image/webp`
- Size limit: configurable (default 5MB)
- Placeholder: served from CDN / static assets when no image
- Audit: image upload/replace/remove writes AuditLog

---

## 9. Pricing Model

**Persistence**: On `ProductVariant` (sellable entity)

| Field | Type | Description |
|-------|------|-------------|
| listPrice | BigInt | Base consumer price (minor units) |
| cashDiscount | BigInt | Discount value |
| cashDiscountType | Enum | `PERCENT` \| `FIXED` |
| wholesalePrice | BigInt | Direct wholesale price |
| cost | BigInt | Unit cost for margin calc |

**Calculation** (backend authoritative):

```typescript
function calculatePrice(variant: ProductVariant, customerCode: '01' | '02', paymentMethods: PaymentMethod[]): BigInt {
  if (customerCode === '02') return variant.wholesalePrice;
  
  // CONSUMER_FINAL (01)
  const allCashEligible = paymentMethods.every(m => isCashEligible(m));
  if (allCashEligible) {
    if (variant.cashDiscountType === 'PERCENT') {
      return variant.listPrice - (variant.listPrice * variant.cashDiscount / 100);
    }
    return variant.listPrice - variant.cashDiscount;
  }
  return variant.listPrice;
}
```

**Bulk/category price changes**: Batch service operation; each variant change writes AuditLog with before/after.

---

## 10. Inventory — Critical Design (Summary)

**Full detail in `07-inventory-ledger.md`**

### Core Decision: On-Hand Balance + Immutable Ledger (Option A)

| Component | Purpose |
|-----------|---------|
| `InventoryBalance` | Current fast-read physical on-hand per `ProductVariant × Location` |
| `StockMovement` | Immutable historical ledger of every physical change (unified ledger with `balanceEffect` flag) |

### InventoryBalance Fields

```
onHand        BigInt   // physically present at this real location
```

**Note**: The `reserved` field is REMOVED from InventoryBalance. Technical POS hold quantities are authoritative in the `StockHold` aggregate, not as a cached counter.

### Sellable Calculation (Derived, Never Stored)

```
sellable = InventoryBalance.onHand
         - SUM(active StockHold.quantity for variant × location)
         - SUM(active SenaItem.quantity for variant × location WHERE CommercialSena.status = 'ACTIVE')
```

**Critical invariants**:
- Total active holds (technical + commercial) ≤ onHand
- No negative `onHand` (DB check constraint)

### StockMovement balanceEffect

| balanceEffect | Movements | Participates in onHand Reconciliation? |
|---------------|-----------|----------------------------------------|
| `ON_HAND` | SALE, GOODS_RECEIPT, TRANSFER_DISPATCH, TRANSFER_RECEIVE, TRANSFER_RETURN_TO_ORIGIN, ADJUSTMENT, PUBLICATION_CHECKOUT, PUBLICATION_RETURN (GOOD), EXCHANGE_RETURN, EXCHANGE_OUT, INITIAL_STOCK, INVENTORY_CORRECTION, DAMAGE_WRITE_OFF (in-store), LOSS_WRITE_OFF (in-store) | **Yes** |
| `NONE` | DAMAGE_WRITE_OFF (publication/transfer), LOSS_WRITE_OFF (publication/transfer/LOST_IN_TRANSIT) | **No** (audit-only for external custody resolution) |

**Rule**: `balanceEffect` is contextual — it depends on whether the merchandise is still in a real Location `onHand` (Category A: physical custody) or already outside (Category B: external custody). Movement type alone does not determine `balanceEffect`.

### Logical Holds (Separate from Physical)

| Hold Type | Table | Creates StockMovement? | Financial Impact |
|-----------|-------|------------------------|------------------|
| Technical POS hold | `StockHold` | No (affects sellable via query) | None |
| Commercial SEÑA | `CommercialSena` + `SenaItem` | No (affects sellable via query) | Deposit recorded in `SenaPayment` |

### SEÑA Payment Model

`CommercialSena.depositAmount` is not sufficient as payment history.

Dedicated entity: **`SenaPayment`**

| Field | Purpose |
|-------|---------|
| `senaId` | Reference to CommercialSena |
| `method` | `CASH` \| `TRANSFER` \| `CARD_DEBIT` \| `CARD_CREDIT` |
| `amount` | Payment amount (minor units) |
| `originInstitution` | For TRANSFER: MACRO, BBVA, NACION, GALICIA, MERCADO_PAGO, OTHER + free text |
| `cashSessionId` | For CASH: links to CashSession |
| `idempotencyKey` | Client UUID v4; prevents duplicate processing |
| `userId` | User who recorded payment |
| `timestamp` | Payment time |

**CASH flow**: `SenaPayment` → creates/links `CashMovement` (drawer effect). `SenaPayment` is the business record.

**Non-cash flow**: `SenaPayment` recorded; **no fake CashMovement** created.

SEÑA expiry **never deletes** `SenaPayment`. Default non-refundable policy means expiration retains financial record per policy.

### SEÑA Application / Settlement

When a customer fulfills a SEÑA (creates the sale), the following atomic operation occurs in a single transaction:

1. **Validate** SEÑA is ACTIVE and not expired; validate sellable covers SenaItem quantities
2. **Create Sale** (status = PENDING_PAYMENT) with items from SenaItem
3. **Create SenaSettlement** linking SEÑA → Sale, recording total deposit applied and balance due
4. **Update CommercialSena** status → FULFILLED
5. **Atomic inventory handoff**: Create `StockHold` (technical hold) for each SenaItem in same transaction — no window where units are unheld. The `CommercialSena.status = FULFILLED` flip and `StockHold` creation happen together.
6. **Write AuditLog**

The `SenaSettlement` entity is the authoritative record of SEÑA→Sale application.

---

## 11. Goods Receiving

- `GoodsReceipt` (status: `DRAFT` → `IN_PROGRESS` → `COMPLETED`)
- Editable while `IN_PROGRESS`; **no stock mutation**
- On `COMPLETED`: single TX → `onHand += qty`, `StockMovement(type=GOODS_RECEIPT)`, immutable
- Attachments: `GoodsReceiptAttachment` → Supabase Storage keys
- Progressive loading: add items incrementally while `IN_PROGRESS`
- Authorized WAREHOUSE users may create Product/Variant during receiving

---

## 12. Stock Transfers

**States**: `REQUESTED` → `APPROVED` → `PREPARING` → `DISPATCHED` → `IN_TRANSIT` → `RECEIVED` / `RECEIVED_WITH_DIFFERENCE` → `CANCELLED`

**Quantities tracked independently per item**:
- `requestedQty`
- `approvedQty`
- `dispatchedQty`
- `receivedQty`
- `returnedToOriginQty`
- `lostInTransitQty`

**Outstanding transit quantity**:
```
outstandingTransit = dispatchedQty - receivedQty - returnedToOriginQty - lostInTransitQty
```
Must never be negative.

**At dispatch** (origin):
- `InventoryBalance.onHand -= dispatchedQty`
- `StockMovement(type=TRANSFER_DISPATCH, balanceEffect=ON_HAND, delta=-dispatchedQty)`

**At receipt** (destination):
- `InventoryBalance.onHand += actualReceivedQty`
- `StockMovement(type=TRANSFER_RECEIVE, balanceEffect=ON_HAND, delta=+actualReceivedQty)`
- `receivedQty += actualReceivedQty`

**Discrepancy resolution** (explicit, required for closure):
| Resolution | Action | StockMovement |
|------------|--------|---------------|
| `LATE_RECEIPT` | Destination `onHand += qty`, `receivedQty += qty` | `TRANSFER_RECEIVE` (ON_HAND) |
| `RETURNED_TO_ORIGIN` | Origin `onHand += qty`, `returnedToOriginQty += qty` | `TRANSFER_RETURN_TO_ORIGIN` (ON_HAND) |
| `LOST_IN_TRANSIT` | `lostInTransitQty += qty` | `LOSS_WRITE_OFF` (NONE) + audit |

Transfer cannot close while `outstandingTransit > 0`.

**Idempotency**: `TransferResolution` entity records each resolution. `TransferItem` quantities (`receivedQty`, `returnedToOriginQty`, `lostInTransitQty`) are monotonically increasing. Resolution validates `outstandingTransit >= quantity` before applying. Transfer status transition to `RECEIVED` guarded by `outstandingTransit = 0` for all items.

**Remito**: Generated at dispatch with sequential number from `DocumentCounter`

---

## 13. Transfer RBAC Architecture

Authorization considers:
1. Permission (`TRANSFER_REQUEST`, `TRANSFER_APPROVE`, etc.)
2. User's authorized scopes (`UserRoleScope`)
3. Transfer origin/destination location types
4. Transfer status

| Role | Can Request | Can Approve | Can Prepare | Can Dispatch | Can Receive |
|------|-------------|-------------|-------------|--------------|-------------|
| SELLER | Own LOCATION scope → any | No | No | No | No |
| CASHIER | Own LOCATION scope → any | **Destination** LOCATION scope (store-to-store) | No | **Origin** LOCATION scope (outgoing) | **Destination** LOCATION scope (incoming) |
| WAREHOUSE | CENTRAL_WAREHOUSE LOCATION scope → any | CENTRAL_WAREHOUSE LOCATION scope (warehouse-originated) | CENTRAL_WAREHOUSE LOCATION scope | CENTRAL_WAREHOUSE LOCATION scope | CENTRAL_WAREHOUSE LOCATION scope |
| ADMIN | Per explicit scope (LOCATION or COMPANY) | Per explicit scope | Per explicit scope | Per explicit scope | Per explicit scope |

**Key principle**: CASHIER approves **incoming** to their assigned location; WAREHOUSE approves **warehouse-originated** transfers. No universal approver. COMPANY scope grants all locations.

---

## 14. Document Numbering

| Document | Sequence Scope | Format |
|----------|----------------|--------|
| Sale | Branch | `{BRANCH_CODE}-V-{SEQ}` (e.g., `CEN-V-000154`) |
| Remito (Transfer) | Company | `REM-{SEQ}` (e.g., `REM-001234`) |
| GoodsReceipt | Company | `GR-{SEQ}` |
| SEÑA | Company | `SEN-{SEQ}` |
| Exchange | Company | `EXC-{SEQ}` |

**Allocation**: `DocumentCounter` table, row `FOR UPDATE` in same TX as document creation. Persistent, never recomputed.

---

## 15. Labels

- One label per `ProductVariant` (printed on demand)
- Label includes: Product barcode (Code 128), human-readable barcode, Product short description, Variant SKU, color, size, black frame
- Target: ~70mm × 37mm on A4 self-adhesive sheets
- Configurable: quantity, margins, gaps, start position
- Generated server-side (PDF or image); printed from browser

---

## 16. Sales / Payments

**Sale Lifecycle**: `DRAFT` → `PENDING_PAYMENT` → `PAID` → `COMPLETED` (+ `CANCELLED`)

**Payment Methods**: `CASH`, `TRANSFER`, `CARD_DEBIT`, `CARD_CREDIT`, `QR`

**Split Payments**: N payments until `Σ amount = Sale.total`

**TRANSFER metadata**: `originInstitution` (MACRO, BBVA, NACION, GALICIA, MERCADO_PAGO, OTHER + free text)

**Card**: `CARD_DEBIT` / `CARD_CREDIT` + optional installments (stored on SalePayment)

**Idempotency**: Every payment intent carries `idempotencyKey` (client UUID); unique constraint prevents duplicates

---

## 17. Cash

- Multiple `CashRegister` per branch (seed 1–2)
- `CashSession`: `OPEN` → `CLOSED`; max one `OPEN` per register (partial unique index)
- Movements: `OPENING`, `SALE_INCOME`, `CLOSING`, `MANUAL`, `DEPOSIT`, `WITHDRAWAL`, `ADJUSTMENT`
- Appendix-only, auditable; `SALE_INCOME` linked to `SalePayment`
- Treasury separate from drawer cash

---

## 18. Exchanges

- `Exchange` references original `Sale` (immutable) + new `Sale` (or items) for replacement
- Same or higher price; difference = normal payment flow
- Returned item: `onHand += 1` at receiving branch
- Replacement: `onHand -= 1` at receiving branch
- Cross-branch: permissions checked for both locations

---

## 19. Publication / Photo Merchandise

- `PublicationCheckout`: removes from `InventoryBalance.onHand` (qty)
- `PublicationItem` becomes authoritative for outstanding externally-held quantity
- Tracks: variant, qty, origin branch, person, authorized user, purpose, media, status
- Return `GOOD`: Destination `onHand += qty`, `StockMovement(PUBLICATION_RETURN, balanceEffect=ON_HAND)`
- Return `DAMAGED`: `PublicationItem` resolved, `StockMovement(DAMAGE_WRITE_OFF, balanceEffect=NONE)` — **no onHand change** (already removed at checkout)
- Return `LOSS`: `PublicationItem` resolved, `StockMovement(LOSS_WRITE_OFF, balanceEffect=NONE)` — **no onHand change**

**Outstanding publication quantity**:
```
publicationOutstanding = checkedOutQty - returnedGoodQty - damagedResolvedQty - lostResolvedQty
```

**Idempotency**: `PublicationReturn` entity records each return. `PublicationItem.status` transitions: `OUT` → `RETURNED_GOOD` | `RETURNED_DAMAGED` | `LOST` (terminal). Return creation validates `status = 'OUT'`. Checkout status transition to `RETURNED` guarded by all items terminal.

**Critical**: Damage/loss resolution does **not** decrement `onHand` — the unit was already removed at checkout. Written-off damaged/loss units leave company custody entirely.

---

## 20. Notifications + Audit

**Notifications**:
- Persisted in `Notification` table (DB is source of truth)
- Realtime delivery via Supabase Realtime Broadcast (secondary)
- Classification: `HIGH` (admin/owner) vs `LOW` (audit/events)
- Triggers: manual adjustments, write-offs, discrepancies, receipts, low stock, price changes, SEÑA expiry, large sales (>500k ARS)

**Audit**:
- `AuditLog` in same TX as critical operation
- Fields: userId, locationId, action, entityType, entityId, before/after (JSON, bigint→string), timestamp
- No secrets

---

## 21. Company Custody Formula

**Conceptual company physical custody**:
```
companyCustody = 
    SUM(InventoryBalance.onHand for all locations)
  + SUM(outstandingTransit for all transfers)
  + SUM(publicationOutstanding for all publication checkouts)
```

**Rules**:
- Technical holds (StockHold) and commercial SEÑA are **NOT added** — units remain in `onHand`
- Lost/write-off quantities are **NOT added** — custody has ended
- Every physical unit belongs to exactly ONE custody bucket at a time

---

## 22. Reconciliation Invariants

### Balance ↔ Ledger (onHand)

```
For every InventoryBalance:
  onHand ≡ Σ StockMovement.quantityDelta (WHERE balanceEffect = 'ON_HAND')
```

Only movements with `balanceEffect = ON_HAND` participate in this invariant.

### External Custody Reconciliation Invariants (Separate)

**Transfer Custody Invariant:**
```
For every StockTransfer in DISPATCHED/IN_TRANSIT/RECEIVED_WITH_DIFFERENCE:
  Σ TransferItem.outstandingTransit
  = Σ TransferItem.dispatchedQty - Σ TransferItem.receivedQty - Σ TransferItem.returnedToOriginQty - Σ TransferItem.lostInTransitQty
```
Transfer discrepancies (LATE_RECEIPT, RETURNED_TO_ORIGIN, LOST_IN_TRANSIT) must resolve `outstandingTransit` to 0 before transfer can close.

**Publication Custody Invariant:**
```
For every PublicationCheckout in OUT/PARTIAL:
  Σ PublicationItem.publicationOutstanding
  = Σ PublicationItem.checkedOutQty - Σ PublicationItem.returnedGoodQty - Σ PublicationItem.damagedResolvedQty - Σ PublicationItem.lostResolvedQty
```
Publication returns (GOOD, DAMAGED, LOST) must resolve `publicationOutstanding` to 0 before checkout can close.

**StockMovement** is the immutable PHYSICAL inventory ledger. Types:
```
INITIAL_STOCK
GOODS_RECEIPT
SALE
TRANSFER_DISPATCH
TRANSFER_RECEIVE
TRANSFER_RETURN_TO_ORIGIN
PUBLICATION_CHECKOUT
PUBLICATION_RETURN
EXCHANGE_RETURN
EXCHANGE_OUT
ADJUSTMENT
DAMAGE_WRITE_OFF
LOSS_WRITE_OFF
```

Logical hold create/release: **NO physical StockMovement**.
StockMovement entries are never edited/deleted.
Corrections produce compensating movements.
InventoryBalance and physical StockMovement update atomically.

---

## 23. ARCA Boundary

```typescript
interface FiscalProvider {
  generateCAE(sale: Sale, payments: SalePayment[]): Promise<FiscalResult>;
  queryCAE(fiscalNumber: string): Promise<FiscalStatus>;
}

class ARCAProvider implements FiscalProvider { ... }
```

- **Decoupled**: Core sale completion never calls ARCA
- **Outbox**: `FiscalOutbox` table — inserted in the SAME database transaction as authoritative Sale completion. The asynchronous fiscal worker processes the outbox only AFTER that transaction commits. No ARCA network call occurs inside the Sale transaction.
- **Worker**: Separate process reads outbox → calls ARCA → stores CAE/result
- **Failure**: Does not corrupt Sale/Payment/Cash/Inventory
- **Day 25**: Interface + stub implementation; **Day 26-35**: Real ARCA homologation

---

## 24. PostgreSQL / Prisma / Deployment Decisions

| Decision | Choice |
|----------|--------|
| ORM | Prisma (schema-first) |
| Migrations | Prisma Migrate (SQL output reviewed) |
| Connection pooling | PgBouncer (Supabase) |
| Row locking | `SELECT ... FOR UPDATE` via Prisma `$transaction` |
| JSON serialization | Custom `toJsonSafe` for BigInt→string |
| Partial indexes | Raw SQL in migrations (Prisma limitation) |
| Realtime | Supabase Realtime Broadcast (channels = location-scoped) |

**Serverless vs Long-lived**: API deployed as container/VM (not serverless) for WebSocket + locking.

---

## 25. Concurrency / Idempotency — Detailed Rules

| Operation | TX Boundary | Locked Resources | Invariant Checked | Idempotency |
|-----------|-------------|------------------|-------------------|-------------|
| Reserve stock (send to cashier) | Single | Inventory(variant,location), Sale | `sellable >= qty` | Sale status guard |
| Complete sale | Single | Sale, Inventory(variant,location), StockHold | `Sale=PAID`, holds ACTIVE, `onHand>=qty` | Sale status (`COMPLETED` = done) |
| Create SEÑA | Single | Inventory(variant,location) | `sellable >= qty` | Unique SEÑA per customer/variant? |
| Expire/release hold | Single | Inventory(variant,location), Hold | Hold ACTIVE, expired | Status guard |
| Complete GoodsReceipt | Single | Inventory(variant,location), GoodsReceipt | `status=IN_PROGRESS` | Status guard |
| Dispatch Transfer | Single | Origin Inventory, Transfer | `onHand >= dispatchedQty` | Status guard |
| Receive Transfer | Single | Dest Inventory, Transfer | `inTransitIn >= receivedQty` | Status guard |
| Exchange | Single | Both branch Inventory, original Sale | Original sale COMPLETED, replacement available | Exchange ID unique |
| Publication checkout | Single | Inventory(variant,location) | `onHand >= qty` | Checkout ID unique |
| Publication return | Single | Inventory(variant,location) | `publicationOut >= qty` | Return ID unique |
| Cash payment retry | Single | Sale, CashSession | `Sale=PENDING/PAID`, session OPEN | IdempotencyKey |
| Number allocation | Single | DocumentCounter | N/A | Counter increment |

---

## 26. Migration Strategy (Demo V2 → Production V1)

See detailed mapping in §27 of this document and `07-inventory-ledger.md`.

### Key Structural Changes

| Area | Demo V2 | Production V1 | Migration Type |
|------|---------|---------------|----------------|
| Location | `Branch` only | `Location` (type: RETAIL_BRANCH \| CENTRAL_WAREHOUSE) | ALTER |
| Barcode | ProductVariant.barcode | Product.barcode | MIGRATE |
| Inventory | physical, reserved | onHand | MIGRATE |
| StockReservation | Single table | Split: StockHold (technical) + CommercialSena | NEW + MIGRATE |
| StockMovement | SALE only | 15+ types | ALTER |
| UserBranchRole | Branch-scoped | Location-scoped + scopeType | MIGRATE |
| ProductImage | None | ProductImage table + Storage | NEW |
| Supplier/Purchasing | None | Supplier, GoodsReceipt, PurchaseOrder* | NEW |
| Transfers | None | StockTransfer, TransferItem, Remito | NEW |
| Exchanges | None | Exchange, ExchangeItem | NEW |
| Publication | None | PublicationCheckout, PublicationItem, PublicationReturn | NEW |
| SEÑA | None | CommercialSena, SenaItem | NEW |
| Document numbering | SaleNumberCounter | DocumentCounter (multi-type) | ALTER |
| Notifications | Socket.IO events | Notification table + Realtime | ALTER |
| Fiscal | None | FiscalProvider, FiscalOutbox | NEW |

*Day 26-35

---

## 27. Day 25 vs Day 26-35 Architecture Scope

### Day 25 (MUST — Operational Milestone)

- Core modules: identity, rbac, organization, catalog, pricing, inventory, pos, payments, cash, sena (technical hold), documents, audit, notifications (DB only)
- GoodsReceipt (warehouse receiving)
- Transfers (REQUESTED → RECEIVED workflow)
- Labels (generation + print)
- Basic reporting (sales, inventory, cash, transfers)
- Supplier operational foundation (identity, GoodsReceipt link)
- Import foundation (CSV/XLSX → initial stock)
- Realtime: Supabase Realtime for notifications

### Day 26-35 (SHOULD — Completion/Hardening)

- Exchanges (cross-branch)
- Publication/photo merchandise
- Supplier financial depth: PurchaseOrder, SupplierInvoice, SupplierPayment, AccountsPayable
- ARCA real homologation
- Advanced import/migration tooling
- Treasury / operational accounting
- Training / production prep
- Configurable notification thresholds
- Label layout advanced config

---

## 28. Explicit Architectural Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Location model | Single `Location` with `type` enum | Avoids competing hierarchies; retail + warehouse unified. `Location.type`: `RETAIL_BRANCH` \| `CENTRAL_WAREHOUSE` |
| Inventory source of truth | Balance + Ledger (dual) | Fast reads + full audit; reconciliation invariant |
| Sellable formula | `onHand - reserved` | In-transit and publication already removed from onHand |
| Technical hold vs SEÑA | Separate tables | Different financial semantics; SEÑA has deposit |
| ADMIN global access | No — explicit scope required | Principle of least privilege |
| WAREHOUSE universal approver | No — scope-aware | Business flow: store-to-store approved by destination CASHIER |
| ARCA in critical path | No — outbox pattern | Failure isolation; Day 25 not blocked |
| Binary images in DB | No — Supabase Storage | Performance, cost, separation of concerns |
| Realtime transport | Supabase Realtime Broadcast | Native to DB hosting; fallback Socket.IO if needed |
| Number allocation | DocumentCounter table | Concurrency-safe, persistent, auditable |

---

## 29. Rejected Alternatives

| Alternative | Rejected Because |
|-------------|------------------|
| Separate `Branch` + `Warehouse` tables | Duplicate inventory logic; harder cross-location queries |
| Single `Inventory` with `inTransitOut`/`inTransitIn`/`publicationOut`/`damaged` as counters | Double-subtraction risk; external custody belongs to domain aggregates (StockTransfer, PublicationCheckout), not balance columns |
| ADMIN = global by role | Security violation; scope must be data-driven |
| Per-variant barcode | Business requirement: one barcode per Product |
| Serverless API (Vercel Functions) | WebSockets + row locking require persistent connections |
| Embedded ARCA in sale completion | Corrupts core state on ARCA failure |
| Soft-delete StockMovement | Audit integrity; corrections via new movements |
| Computed sellable stored as column | Inconsistency risk; derived at read time |

---

## 30. Migration Gap Analysis (Demo V2 → Production V1)

| Demo V2 Entity/Concept | Production V1 Disposition | Details |
|------------------------|---------------------------|---------|
| `Branch` | **ALTER** → `Location` with `type` | Add `type` enum, migrate 6 branches |
| `UserBranchRole` | **MIGRATE** → `UserLocationRole` + `scopeType` | Add scopeType, backfill |
| `ProductVariant.barcode` | **MIGRATE** → `Product.barcode` | Move, unique index, drop from Variant |
| `Product` | **ALTER** | Add `barcode`, `legacyCode?`, `primaryImageId?` |
| `Inventory` | **MIGRATE** | Rename `physical`→`onHand`; `reserved` removed (migrated to `StockHold`); no new counter fields |
| `StockReservation` (technical) | **ALTER** → `StockHold` | Rename, keep for POS flow |
| Commercial SEÑA | **NEW** | `CommercialSena`, `SenaItem` |
| `StockMovementType` | **ALTER** | Add 14+ types (RECEIPT, TRANSFER_*, ADJUSTMENT, DAMAGE, LOSS, PUBLICATION_*, EXCHANGE_*, SEÑA_*) |
| `Sale` | **KEEP** + extend | Add `customerCode`, `priceSnapshot` fields |
| `SaleItem` | **KEEP** | Already has price snapshot |
| `SalePayment` | **ALTER** | Add `originInstitution`, `installments`, `cardBrand?` |
| `CashRegister` | **KEEP** | Already supports multi-register |
| `CashSession` | **KEEP** | Partial unique index exists |
| `CashMovementType` | **ALTER** | Add `DEPOSIT`, `WITHDRAWAL`, `ADJUSTMENT` |
| `Supplier` | **NEW** | Day 25 operational + Day 26-35 financial |
| `GoodsReceipt` | **NEW** | Day 25 MUST |
| `StockTransfer` | **NEW** | Day 25 MUST |
| `Exchange` | **NEW** | Day 25 MUST |
| `PublicationCheckout` | **NEW** | Day 25 MUST |
| `ProductImage` | **NEW** | Day 25 MUST |
| `DocumentCounter` | **ALTER** | Extend SaleNumberCounter to multi-type |
| `Notification` | **NEW** | Replace Socket.IO-only events |
| `AuditLog` | **KEEP** | Extend entityType coverage |
| `FiscalProvider` | **NEW** | Interface + ARCAProvider stub Day 25 |
| `FiscalOutbox` | **NEW** | Day 26-35 |

---

## 31. Quality Gates — Self-Review Checklist

- [ ] No double-subtraction of in-transit inventory (inTransitOut removed from onHand at dispatch)
- [ ] No double-subtraction of publication inventory (publicationOut removed at checkout)
- [ ] Logical holds (technical + SEÑA) never create physical StockMovement
- [ ] Technical POS hold ≠ Commercial SEÑA (separate tables, different semantics)
- [ ] ADMIN never globally authorized without explicit scope
- [ ] WAREHOUSE not universal transfer approver (destination CASHIER approves store-to-store)
- [ ] Barcode on Product, not ProductVariant
- [ ] Document numbers never recomputed (persistent counter)
- [ ] No fake CAE (outbox + worker, decoupled)
- [ ] No hard deletion of financial/inventory history (soft-delete only)
- [ ] Negative stock prevented (DB constraints + TX validation)
- [ ] Idempotency on all payment/number/receipt operations
- [ ] Transfer resolution idempotency (TransferResolution entity, monotonic quantities, outstanding=0 guard)
- [ ] Publication return idempotency (PublicationReturn entity, terminal status, checkout close guard)
- [ ] SEÑA→Sale atomic handoff (SenaSettlement + StockHold in same TX, no unheld window)
- [ ] StockMovement balanceEffect flag (ON_HAND vs NONE) correctly applied
- [ ] UserRoleScope DB check constraint (scopeKind + locationId consistency)
- [ ] Reconciliation invariants: onHand + external custody (transfer + publication) separately verifiable
- [ ] Schema scoped to 20–35 day delivery (no speculative entities)

---

*End of 05-architecture.md*