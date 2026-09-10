# 04-domain-rules

## Product / ProductVariant / Barcode
- Product has a single internal Code 128 barcode. The barcode resolves to a product; the seller then selects a variant (colour+size).
- `ProductVariant` has a unique `sku`.  No barcode is generated per variant.
- Variant attributes:
  - `color`: enum of predefined colours plus `OTHER` (free-text).
  - `size`: enum families **BABY**, **CHILD**, **ADULT-LETTER**, **ADULT-NUMERIC**, **SPECIAL**.
- Pricing is stored as **minor-unit `BigInt`** (`price`, `costPrice`).  Pricing rules (`listPrice`, `cashDiscount`, `wholesalePrice`) are validated at the API layer; the UI only displays the computed amount.
- Products referenced by historical transactions must not be physically deleted; use `isActive` flag (soft-delete) to preserve audit and sale history.

## Money
- All monetary amounts are **integer minor units** (`BigInt`).  No floating-point arithmetic is used.
- At JSON boundaries, amounts are serialized as **decimal strings** using the `toJsonSafe` helper (see Demo V2 `api/src/shared/json-safe.ts`).  Clients parse strings back to `BigInt` for calculations.

## Inventory
- Inventory is scoped to a **Location** (`Branch` or `Warehouse`).  Inventory tracks:
  - `physical`-total units on hand.
  - `reserved`-units held for pending sales (technical hold from seller→cashier flow).
  - `inTransit`-units that have been dispatched from a origin location but not yet received at destination (transfer workflow).
  - `temporarilyOut`-units checked out for publication/photo merchandise, not currently sellable.
- **Sellable/available stock** is a **business invariant** derived from the above fields; the exact persistence formula is deferred to Architecture/ERD work.  It must never be stored as a standalone column if it can become inconsistent.
- Invariants (must always hold):
  1. `physical >= 0`, `reserved >= 0`, `inTransit >= 0`, `temporarilyOut >= 0`.
  2. Sellable/available stock >= 0 (computed, never negative).
  3. `reserved` never exceeds `physical` (technical hold cannot exceed on-hand stock).
  4. `inTransit` never exceeds the quantity dispatched from origin.
  5. `temporarilyOut` never exceeds the quantity checked out for publication.
- All adjustments (sale, receipt, transfer, manual, publication checkout/return) generate a `StockMovement` record with before/after snapshots for the affected dimension(s).

## StockReservation / Technical Hold (Seller → Cashier)
- Created when a seller **sends a draft sale to cashier** (technical hold, not commercial reservation).
- Tracks: `saleId`, `variantId`, `branchId`, `quantity`, `expiresAt`, `status` (`ACTIVE`/`RELEASED`/`CONSUMED`).
- Lifecycle:
  1. `ACTIVE` on creation (short-term expiry).
  2. `RELEASED` on expiry or cancellation (if no payments were made).
  3. `CONSUMED` when the sale is completed (`PAID → COMPLETED`).
- Expiration is **lazy**: the system checks for expired reservations only when a sale is accessed or a new reservation is attempted.
- Releasing a technical hold **does not** create a `StockMovement`; it merely decrements `reserved`.

## StockReservation / Commercial SEÑA (Customer Reservation)
- Separate concept from technical hold; represents a customer deposit to hold merchandise.
- Tracks: `customerId` (optional), `variantId`, `branchId`, `quantity`, `depositAmount`, `createdAt`, `expiresAt` (exactly 24 hours from creation), `status` (`ACTIVE`/`EXPIRED`/`FULFILLED`/`CANCELLED`).
- Lifecycle:
  1. `ACTIVE` on creation (deposit accepted, merchandise reserved).
  2. On expiry (`expiresAt` < now()): transitions to `EXPIRED`; operational list no longer shows it; merchandise hold is released (increases `physical` or `available` per business rules).
  3. If customer returns to complete purchase: transitions to `FULFILLED`, converts to a sale, consumes reservation.
  4. Cancellation before expiry: transitions to `CANCELLED`, releases merchandise hold; deposit may be forfeited per business policy (default non-refundable).
- Historical SEÑA records (including deposit/payment) are **never** physically deleted; they remain auditable.
- Expiration check is **lazy** (similar to technical hold).

## GoodsReceipt
- A receipt aggregates incoming goods for a **Warehouse**.
- Tracks: `supplierId`, `expectedBultos`, `receivedBultos`, `status` (`IN_PROGRESS`, `COMPLETED`), timestamps, optional media (photos/PDF).
- Editable while `IN_PROGRESS`; locked after `COMPLETED`.
- On completion:
  - Inventory `physical` is incremented for each line item.
  - `StockMovement` entries of type `GOODS_RECEIPT` are recorded.
  - The receipt becomes immutable; any correction requires a new adjustment entry.

## Transfer Workflow
- Transfer entities track movement of stock between locations.
- Tracks: `originId`, `destinationId`, `status`, timestamps, `requestedItems`, `approvedItems`, `dispatchedItems`, `receivedItems`, observations.
- At `DISPATCHED`:
  - Origin `physical` decremented (sellable stock reduced).
  - `inTransit` incremented by the dispatched quantity.
- At `RECEIVED`:
  - `inTransit` decremented by the received quantity.
  - Destination `physical` incremented by the received quantity.
- Discrepancies (`RECEIVED_WITH_DIFFERENCE`) between dispatched and received quantities are documented; whether a physical `StockMovement` adjustment is required depends on the final reconciliation design (deferred to Architecture/ERD).  At minimum, an audit entry is generated and administration/owner notified.

## Sale Lifecycle & Payments
- Sale statuses: `DRAFT`, `PENDING_PAYMENT`, `PAID`, `COMPLETED`, `CANCELLED`.
- **Transition rules**:
  - `DRAFT → PENDING_PAYMENT` via **send-to-cashier**; creates technical `StockReservation` and reserves inventory.
  - `PENDING_PAYMENT → PAID` when Σ accepted `SalePayment.amount` equals `Sale.total`.
  - `PAID → COMPLETED` via **completeSale** transaction: consumes technical reservations, decrements `physical`, creates a `StockMovement` of type `SALE`.
  - `CANCELLED` allowed only from `DRAFT` (no reservation) or `PENDING_PAYMENT` with zero payments (releases technical reservation).
- **Payments** (`SalePayment`):
  - `method` (`CASH`, `TRANSFER`, `CARD_DEBIT`, `CARD_CREDIT`).
  - `amount` (amount that counts toward sale total).
  - `receivedAmount`/`changeAmount` for cash only.
  - `idempotencyKey` (unique per sale) prevents duplicate processing.
- Payments are **idempotent**; a retry with the same `idempotencyKey` returns the existing record without side effects.

## Cash Register / Cash Session / Cash Movement
- A branch may have one or more CashRegisters; each CashRegister belongs to a branch.
- `CashSession` lifecycle: `OPEN` → `CLOSED`.  Only one `OPEN` session per register (enforced by a partial unique index).
- `CashMovement` types:
  - `OPENING`, `SALE_INCOME`, `CLOSING`, `MANUAL`, `DEPOSIT`, `WITHDRAWAL`, `ADJUSTMENT`.
- Cash movements are **auditable**; they reference the related `SalePayment` when applicable.

## Exchange / Publication Merchandise
- **Exchange**: customer may exchange original sale item for another item (same or higher price).  If replacement price higher, customer pays difference; lower-value refund is **not** an approved V1 workflow unless separately added later.
  - Creates a linked `Exchange` record referencing the original `Sale` and a new `Sale` (or sale items) for the replacement product.
  - Generates inventory movements: return increases stock (reverses original technical hold or sale), replacement decreases stock.
  - Does **not** rewrite the original sale.
  - May occur in a different branch than the original sale; system must locate original sale across branches respecting permissions.
- **Publication checkout** creates a `PublicationMovement` (type `PUBLICATION_CHECKOUT`) that reduces sellable stock and records purpose, operator, and optional media.  Returns generate a `PUBLICATION_RETURN` movement with condition (`GOOD`, `DAMAGED`, `LOSS`).

## Notifications
- Owner / Admin receive **high-priority** notifications for:
  - Manual stock adjustments (including adjustments to correct errors).
  - Write-offs (damage/loss).
  - Transfer discrepancies.
  - Completed `GoodsReceipt`.
  - Low-stock thresholds (configurable).
  - Significant price changes.
  - Sensitive inventory changes (e.g., sudden large adjustments).
- Normal sale activity generates only **low-priority** audit/events (e.g., `sale.pending_payment`, `sale.completed`); these do **not** create noisy high-priority admin notifications by default.
- Notification technology (e.g., Socket.IO, Supabase Realtime) is deferred to Architecture V1; the business requirement is the classification and triggering logic.

## AuditLog
- Every critical operation writes an `AuditLog` entry within the same DB transaction.
- Tracks: `userId`, `branchId`, `action`, `entityType`, `entityId`, `before`, `after`, `timestamp`.
- `before`/`after` are JSON objects with monetary values serialized as decimal strings via `toJsonSafe`.
- No passwords, tokens, or secret data are ever recorded.

## Reversal / Correction Concepts
- **Adjustment** entries are used to correct inventory without altering historic `StockMovement` records.  An `Adjustment` creates a `StockMovement` of type `ADJUSTMENT` with a reason note.
- **Technical reservation expiry** automatically releases `reserved` quantity; no `StockMovement` is emitted.
- **Commercial SEÑA expiry** releases the merchandise hold according to business rules; no `StockMovement` is emitted for the hold itself (the underlying stock adjustment, if any, is captured via other movements).
- **Sale cancellation** before payment releases technical reservations; after payment the sale cannot be cancelled (out of scope for Production V1).

## Derived vs Authoritative Fields
- **Authoritative** (stored): all `BigInt` monetary/quantity fields, status enums, timestamps.
 - **Derived** (computed on read): sellable/available stock is a business invariant (exact persistence deferred to Architecture/ERD). **Authoritative** (stored): saleNumber (once allocated, it is persistent and authoritative). Monetary values stored as BigInt and serialized as decimal strings at JSON boundaries.

These invariants and transitions must be enforced in the backend (transactions, row locks, validation) to guarantee data integrity across concurrent operations.
