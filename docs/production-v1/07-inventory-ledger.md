# 07-inventory-ledger

**Status**: Production V1 Inventory Architecture — Detailed Design (Corrected)  
**Scope**: Production V1 (Day 25–35)  
**Related**: 05-architecture, 06-erd-data-model, 04-domain-rules

---

## 1. Terminology

| Term | Definition |
|------|------------|
| **Location** | A physical place where stock exists: `RETAIL_BRANCH` or `CENTRAL_WAREHOUSE` |
| **Variant** | `ProductVariant` — the sellable unit (SKU, color, size) |
| **On-Hand (`onHand`)** | Units physically present at the location, available for any use |
| **Technical Hold** | `StockHold` record — seller→cashier short-term reservation; reduces sellable |
| **Commercial Hold** | `SenaItem` record — customer 24h reservation with deposit; reduces sellable |
| **Transfer Custody** | `StockTransfer` + `TransferItem` — authoritative for in-transit units |
| **Publication Custody** | `PublicationCheckout` + `PublicationItem` — authoritative for externally-held units |
| **Sellable** | **Derived**: `onHand - active technical holds - active commercial holds` |
| **Company Custody** | **Derived**: `SUM(all locations onHand) + SUM(outstanding transfer custody) + SUM(outstanding publication custody)` |
| **StockMovement** | Immutable ledger entry recording a PHYSICAL inventory change |
| **StockHold** | Technical POS hold (seller→cashier); authoritative for technical holds |
| **Commercial SEÑA** | Customer reservation with deposit; authoritative via `CommercialSena` + `SenaItem` |
| **SenaPayment** | Financial record for SEÑA deposit; links to `CashMovement` when cash |

---

## 2. Source of Truth

### Dual Model: Balance + Ledger

| Component | Role |
|-----------|------|
| **InventoryBalance** | Current physical on-hand per `Variant × Location`; updated atomically with ledger |
| **StockMovement** | Immutable historical ledger of every PHYSICAL change (Option A: unified ledger with `balanceEffect` flag) |

### Reconciliation Invariant (Balance ↔ Ledger)

```
For every InventoryBalance row, at any point in time:

  onHand
  ≡
  Σ StockMovement.quantityDelta (WHERE balanceEffect = 'ON_HAND')
```

Only movements with `balanceEffect = ON_HAND` affect `onHand`. `DAMAGE_WRITE_OFF` and `LOSS_WRITE_OFF` are contextual — they are `ON_HAND` when merchandise is still in a real Location (physical custody) and `NONE` when merchandise is already in external custody (transfer/publication). Movement type alone does not determine `balanceEffect`.

### External Custody Reconciliation Invariants (Separate)

**Transfer Custody Invariant:**
```
For every StockTransfer in DISPATCHED/IN_TRANSIT/RECEIVED_WITH_DIFFERENCE state:
  Σ TransferItem.outstandingTransit
  = Σ TransferItem.dispatchedQty - Σ TransferItem.receivedQty - Σ TransferItem.returnedToOriginQty - Σ TransferItem.lostInTransitQty
```
Transfer discrepancies (LATE_RECEIPT, RETURNED_TO_ORIGIN, LOST_IN_TRANSIT) must resolve `outstandingTransit` to 0 before transfer can close.

**Publication Custody Invariant:**
```
For every PublicationCheckout in OUT/PARTIAL state:
  Σ PublicationItem.publicationOutstanding
  = Σ PublicationItem.checkedOutQty - Σ PublicationItem.returnedGoodQty - Σ PublicationItem.damagedResolvedQty - Σ PublicationItem.lostResolvedQty
```
Publication returns (GOOD, DAMAGED, LOST) must resolve `publicationOutstanding` to 0 before checkout can close.

### Why Both?

| Need | Satisfied By |
|------|--------------|
| POS sellable check (sub-ms) | `InventoryBalance` indexed read + active hold queries |
| Audit trail / dispute resolution | `StockMovement` full history |
| Reconciliation / corrections | Ledger → recalc balance |
| Reporting / analytics | Ledger aggregations |
| External custody tracking | TransferItem / PublicationItem authoritative aggregates + StockMovement audit |

## 3. Current Balance Model (InventoryBalance)

```prisma
model InventoryBalance {
  id              String   @id @default(uuid())
  variantId       String
  locationId      String
  onHand          BigInt   @default(0)
  updatedAt       DateTime @updatedAt @db.Timestamptz(3)

  @@unique([variantId, locationId])
  @@index([locationId])
  @@index([variantId])
}
```

### Check Constraints (DB-Enforced)

```sql
ALTER TABLE inventory_balance ADD CONSTRAINT chk_onhand_nonneg CHECK (on_hand >= 0);
```

**No `reserved`, `inTransitOut`, `inTransitIn`, `publicationOut`, `damaged` columns.**

### Derived Fields (Computed at Read Time)

**Effective hold predicates** — a hold is "effective" (reduces sellable) only while it is both `ACTIVE` and *not expired*. Expiry is evaluated as a pure function of time, so no background sweeper is required for sellable correctness:

- effective technical hold: `StockHold.status = 'ACTIVE' AND StockHold.expiresAt > now()`
- effective commercial hold: `SenaItem.sena.status = 'ACTIVE' AND SenaItem.sena.expiresAt > now()`

```typescript
async function getEffectiveSellable(balance: InventoryBalance): Promise<BigInt> {
  const activeTechnical = await sumActiveStockHold(balance.variantId, balance.locationId);
  // Only ACTIVE AND not-yet-expired holds count
  const activeCommercial = await sumActiveSenaItem(balance.variantId, balance.locationId);
  return balance.onHand - activeTechnical - activeCommercial;
}
```

Where:

```typescript
async function sumActiveStockHold(variantId, locationId, tx) {
  return tx.stockHold.aggregate({
    where: { variantId, locationId, status: 'ACTIVE', expiresAt: { gt: now() } },
    _sum: { quantity: true },
  });
}

async function sumActiveSenaItem(variantId, locationId, tx) {
  return tx.senaItem.aggregate({
    where: {
      variantId,
      locationId,
      sena: { status: 'ACTIVE', expiresAt: { gt: now() } }, // effective SEÑA only
    },
    _sum: { quantity: true },
  });
}
```

**Operational rule (all onHand decrements preserve holds):** any transaction that reduces `onHand` for an *operational* withdrawal (`SALE`, `TRANSFER_DISPATCH`, `PUBLICATION_CHECKOUT`) must lock the `InventoryBalance` row and validate `effectiveSellable >= requestedQty` before mutating `onHand`. Concretely:

```
effectiveSellable = onHand − Σ(effective technical StockHold) − Σ(effective commercial SenaItem)
```

An operational movement must never strand an active hold (`sum(active holds) <= resulting onHand` after commit). Examples:

- `onHand = 2`, `StockHold = 2` → `effectiveSellable = 0` → dispatch 2 **fails**, checkout 1 **fails**.
- `onHand = 2`, `StockHold = 2`, customer fulfills the SEÑA that owns those 2 → the SEÑA's own 2 are *not* "other" commitments (see §10) → fulfillment succeeds.

```typescript
async function getCompanyCustody(_variantId: string): Promise<BigInt> {
  // Sum of:
  // 1. All InventoryBalance.onHand
  // 2. All outstanding transfer custody (dispatched - received - returned - lost)
  // 3. All outstanding publication custody (checkedOut - returnedGood - damagedResolved - lostResolved)
}
```

---

## 4. Movement Ledger (StockMovement)

```prisma
model StockMovement {
  id                  String   @id @default(uuid())
  inventoryBalanceId  String
  type                StockMovementType
  quantityDelta       BigInt   // SIGNED: positive = increase onHand, negative = decrease
  balanceEffect       BalanceEffect  // ON_HAND | NONE — whether this movement affects onHand
  // Before/after snapshots for reconciliation (onHand only)
  beforeOnHand        BigInt
  afterOnHand         BigInt
  // Reference
  referenceType       String   // SALE, GOODS_RECEIPT, TRANSFER_DISPATCH, etc.
  referenceId         String
  userId              String
  locationId          String
  notes               String?
  timestamp           DateTime @default(now()) @db.Timestamptz(3)

  @@index([inventoryBalanceId, timestamp])
  @@index([referenceType, referenceId])
  @@index([locationId, timestamp])
  @@index([userId, timestamp])
}

enum BalanceEffect {
  ON_HAND
  NONE
}
```

### Movement Types and Their Effects

**Critical — `balanceEffect` is contextual, not determined by movement type alone.** Whether a write-off changes `onHand` depends on whether the merchandise is still represented in a real `Location` `InventoryBalance` (physical custody) or is already outside real `onHand` (external custody):

- **Category A — merchandise still in a real Location `onHand`:** physical in-store theft/loss/damage write-off → `balanceEffect = ON_HAND`, `quantityDelta < 0`, `onHand` decreases.
- **Category B — merchandise already outside real Location `onHand`:** `LOST_IN_TRANSIT`, publication loss, publication damage write-off → `balanceEffect = NONE`, no second Location decrement; the external-custody aggregate decreases instead.

| Type | Typical balanceEffect | onHand Delta | Typical Reference |
|------|---------------|--------------|-------------------|
| `SALE` | `ON_HAND` | -qty | Sale |
| `GOODS_RECEIPT` | `ON_HAND` | +qty | GoodsReceipt |
| `TRANSFER_DISPATCH` | `ON_HAND` | -qty | StockTransfer |
| `TRANSFER_RECEIVE` | `ON_HAND` | +qty | StockTransfer |
| `TRANSFER_RETURN_TO_ORIGIN` | `ON_HAND` | +qty | TransferResolution |
| `ADJUSTMENT` | `ON_HAND` | ±qty | Manual correction |
| `DAMAGE_WRITE_OFF` | contextual | 0 **or** -qty | Publication damage (external custody: NONE) / in-store damage (physical: ON_HAND) |
| `LOSS_WRITE_OFF` | contextual | 0 **or** -qty | `LOST_IN_TRANSIT` / publication loss (external custody: NONE) / in-store loss (physical: ON_HAND) |
| `PUBLICATION_CHECKOUT` | `ON_HAND` | -qty | PublicationCheckout |
| `PUBLICATION_RETURN` | `ON_HAND` | +qty | PublicationReturn (good) |
| `EXCHANGE_RETURN` | `ON_HAND` | +qty | Exchange |
| `EXCHANGE_OUT` | `ON_HAND` | -qty | Exchange |
| `INITIAL_STOCK` | `ON_HAND` | +qty | Import/Seed |
| `INVENTORY_CORRECTION` | `ON_HAND` | ±qty | Reconciliation fix |

**Rule**: Only movements with `balanceEffect = ON_HAND` participate in the Location balance reconciliation invariant. Movements with `balanceEffect = NONE` are recorded for audit / external-custody resolution but do not reduce physical `onHand` a second time.

### Snapshot Rules

Every movement writes **before/after `onHand`**. For movements with `balanceEffect = NONE`, `beforeOnHand = afterOnHand` (no change). This enables:
- Point-in-time reconstruction
- Reconciliation without full replay
- Audit of "what changed"

**Logical hold create/release: NO StockMovement.**

---

## 5. Logical Holds

### 5.1 Technical POS Hold (StockHold)

| Property | Detail |
|----------|--------|
| **Table** | `StockHold` |
| **Created** | `DRAFT → PENDING_PAYMENT` (send to cashier) |
| **Effect** | Reduces sellable via `SUM(active StockHold.quantity)` |
| **Released** | Cancel / expiry (no payment) → status `RELEASED` |
| **Consumed** | `PAID → COMPLETED` → status `CONSUMED`, `onHand -= qty`, `StockMovement(SALE)` |
| **StockMovement?** | **No** on create/release; **Yes** on consume (type `SALE`) |
| **Lifetime** | Short (configurable, e.g., 2–4 hours) |
| **Expiry** | Effective predicate `status=ACTIVE AND expiresAt > now()`; status materialization lazy (idempotent on touch); no sweeper required for sellable correctness |

### 5.2 Commercial SEÑA

| Property | Detail |
|----------|--------|
| **Table** | `CommercialSena` + `SenaItem` |
| **Created** | Explicit customer request + deposit (recorded in `SenaPayment`) |
| **Effect** | Reduces sellable via `SUM(active SenaItem.quantity)` |
| **Released** | Expiry (exactly 24h) / cancellation → status `EXPIRED`/`CANCELLED`; effective predicate `sena.status=ACTIVE AND sena.expiresAt > now()` |
| **Fulfilled** | Status `FULFILLED` → creates Sale → normal sale flow |
| **StockMovement?** | **Never** for hold/release; only on fulfillment (type `SALE`) |
| **Deposit** | Recorded in `SenaPayment` (method, amount, origin institution if transfer) |
| **History** | Never deleted (auditable) |

### 5.3 Hold Comparison

| Aspect | Technical POS Hold | Commercial SEÑA |
|--------|-------------------|-----------------|
| **Purpose** | Prevent oversell during seller→cashier handoff | Customer commitment with deposit |
| **Initiator** | Seller (internal) | Customer (external) |
| **Duration** | Hours (configurable) | Exactly 24 hours |
| **Financial** | None | Deposit in `SenaPayment` |
| **Authority** | `StockHold` records | `SenaItem` records |
| **Release creates StockMovement?** | No | No |
| **Consume creates StockMovement?** | Yes (`SALE`) | Yes (`SALE` via fulfillment) |
| **Audit** | StockHold + AuditLog | CommercialSena + SenaItem + SenaPayment + AuditLog |

### 5.4 Sellable Formula (effective)

```
effectiveSellable = InventoryBalance.onHand
                  - SUM(effective StockHold.quantity)   -- status=ACTIVE AND expiresAt > now()
                  - SUM(effective SenaItem.quantity)     -- sena.status=ACTIVE AND sena.expiresAt > now()
```

**Transactionally enforced**: Any hold creation **and** any operational `onHand` decrement validates `effectiveSellable >= requestedQty` with the `InventoryBalance` row locked `FOR UPDATE`. Expired holds do not block inventory (see §7).

---

## 6. Company Custody Formula

```
companyCustody = 
    SUM(InventoryBalance.onHand for all locations)
  + SUM(outstandingTransit for all StockTransfers)
  + SUM(publicationOutstanding for all PublicationCheckouts)
```

Where:
- `outstandingTransit = dispatchedQty - receivedQty - returnedToOriginQty - lostInTransitQty` (per TransferItem)
- `publicationOutstanding = checkedOutQty - returnedGoodQty - damagedResolvedQty - lostResolvedQty` (per PublicationItem)

**Rules**:
- Technical holds and commercial SEÑA are **NOT added** — units remain in `onHand`
- Lost/write-off quantities are **NOT added** — custody has ended
- Every physical unit belongs to exactly ONE custody bucket at a time

---

## 7. Transfer Model — Detailed

### TransferItem Quantities

| Field | Description |
|-------|-------------|
| `requestedQty` | Initially requested |
| `approvedQty` | Approved for dispatch |
| `dispatchedQty` | Actually dispatched from origin |
| `receivedQty` | Actually received at destination |
| `returnedToOriginQty` | Returned to origin (discrepancy resolution) |
| `lostInTransitQty` | Lost in transit (discrepancy resolution) |

### Outstanding Transit

```
outstandingTransit = dispatchedQty - receivedQty - returnedToOriginQty - lostInTransitQty
```
Must never be negative.

### At Dispatch (Origin)

```typescript
// TX: lock origin InventoryBalance FOR UPDATE, Transfer
// Guard: operational withdrawal must preserve active holds (see §5.4 / item 1)
assert(originBalance.onHand - activeTechnical - activeCommercial >= dispatchedQty); // effectiveSellable
const before = originBalance.onHand;
originBalance.onHand -= dispatchedQty;
StockMovement.create({
  type: 'TRANSFER_DISPATCH',
  quantityDelta: -dispatchedQty,
  balanceEffect: 'ON_HAND',
  beforeOnHand: before, afterOnHand: originBalance.onHand,
  referenceType: 'STOCK_TRANSFER',
  referenceId: transferId,
});
```

### At Receive (Destination)

```typescript
// TX: lock destination InventoryBalance, Transfer
const before = destBalance.onHand;
destBalance.onHand += receivedQty;
StockMovement.create({
  type: 'TRANSFER_RECEIVE',
  quantityDelta: +receivedQty,
  balanceEffect: 'ON_HAND',
  beforeOnHand: before, afterOnHand: destBalance.onHand,
  referenceType: 'STOCK_TRANSFER',
  referenceId: transferId,
});
```

### Discrepancy Resolution (Explicit)

When `dispatchedQty > receivedQty`, transfer goes to `RECEIVED_WITH_DIFFERENCE`. Cannot close until resolved:

| Resolution | Action |
|------------|--------|
| `LATE_RECEIPT` | `dest.onHand += qty`, `receivedQty += qty`, `StockMovement(TRANSFER_RECEIVE)` |
| `RETURNED_TO_ORIGIN` | `origin.onHand += qty`, `returnedToOriginQty += qty`, `StockMovement(TRANSFER_RETURN_TO_ORIGIN)` |
| `LOST_IN_TRANSIT` | `lostInTransitQty += qty`, `StockMovement(LOSS_WRITE_OFF)`, audit |

Transfer cannot close while `outstandingTransit > 0`.

---

## 8. Publication Model — Detailed

### PublicationItem — authoritative quantities

`PublicationItem` supports `quantity > 1` and **partial mixed resolution** (e.g. checkout of 2 → return 1 GOOD + 1 LOSS). It carries authoritative resolution quantities mirroring the transfer pattern:

| Field | Description |
|-------|-------------|
| `checkedOutQty` | Total checked out for this variant |
| `returnedGoodQty` | Units returned in `GOOD` condition (restored to sellable) |
| `damagedResolvedQty` | Units resolved as damaged (write-off) |
| `lostResolvedQty` | Units resolved as lost (write-off) |

Derived item status (for display) is a function of the above: `OUT` while `checkedOutQty > returnedGoodQty + damagedResolvedQty + lostResolvedQty`, otherwise terminal.

### Outstanding Publication

```
publicationOutstanding = checkedOutQty - returnedGoodQty - damagedResolvedQty - lostResolvedQty
```

Invariants (always hold):

```
returnedGoodQty + damagedResolvedQty + lostResolvedQty <= checkedOutQty
publicationOutstanding >= 0
```

Cannot close a checkout while `publicationOutstanding > 0`.

### Resolution entity

Each resolution event is recorded in a dedicated **`PublicationResolution`** entity (more semantically correct than `PublicationReturn` for quantity-level resolutions), with an `idempotencyKey` for safe retries. Resolution operations must lock the `PublicationItem` row `FOR UPDATE`, validate `remainingOutstanding >= quantity`, and therefore can never double-resolve quantity.

### At Checkout

```typescript
// TX: lock InventoryBalance FOR UPDATE, PublicationCheckout
// Guard: operational withdrawal must preserve active holds (see §5.4 / item 1)
assert(balance.onHand - activeTechnical - activeCommercial >= qty); // effectiveSellable
const before = balance.onHand;
balance.onHand -= qty;
StockMovement.create({
  type: 'PUBLICATION_CHECKOUT',
  quantityDelta: -qty,
  balanceEffect: 'ON_HAND',
  beforeOnHand: before, afterOnHand: balance.onHand,
  referenceType: 'PUBLICATION_CHECKOUT',
  referenceId: checkoutId,
});
```

### Resolution GOOD

```typescript
// TX: lock InventoryBalance FOR UPDATE, PublicationItem FOR UPDATE
const before = balance.onHand;
balance.onHand += qty;
publicationItem.returnedGoodQty += qty;
publicationResolution.create({ itemId, condition: 'GOOD', quantity: qty, idempotencyKey, receivedById });
StockMovement.create({
  type: 'PUBLICATION_RETURN',
  quantityDelta: +qty,
  balanceEffect: 'ON_HAND',
  beforeOnHand: before, afterOnHand: balance.onHand,
  referenceType: 'PUBLICATION_CHECKOUT',
  referenceId: checkoutId,
  referenceSubType: 'PUBLICATION_RESOLUTION', referenceSubId: resolutionId,
  notes: 'condition=GOOD',
});
```

### Resolution DAMAGED / LOSS

```typescript
// TX: lock PublicationItem FOR UPDATE (no InventoryBalance change!)
publicationItem.damagedResolvedQty += qty; // or lostResolvedQty += qty
publicationResolution.create({ itemId, condition: 'DAMAGED'|'LOSS', quantity: qty, idempotencyKey, receivedById });
StockMovement.create({
  type: 'DAMAGE_WRITE_OFF' | 'LOSS_WRITE_OFF',
  quantityDelta: 0,  // onHand unchanged — external custody already removed at checkout
  balanceEffect: 'NONE',
  beforeOnHand: current, afterOnHand: current,
  referenceType: 'PUBLICATION_CHECKOUT',
  referenceId: checkoutId,
  referenceSubType: 'PUBLICATION_RESOLUTION', referenceSubId: resolutionId,
  notes: 'condition=DAMAGED' | 'condition=LOSS',
});
```

**Critical**: Damage/loss resolution does **not** change Location `onHand` — the unit already left `onHand` at checkout; only external publication custody decreases. This is the "no double-decrement" rule.

---

## 9. SEÑA Payment Model

### SenaPayment Entity

| Field | Type | Description |
|-------|------|-------------|
| `id` | UUID | PK |
| `senaId` | UUID | FK → CommercialSena |
| `method` | Enum | `CASH` \| `TRANSFER` \| `CARD_DEBIT` \| `CARD_CREDIT` |
| `amount` | BigInt | Minor units |
| `originInstitution` | String? | For TRANSFER: MACRO, BBVA, NACION, GALICIA, MERCADO_PAGO, OTHER + free text |
| `cashSessionId` | UUID? | FK → CashSession (when CASH) |
| `idempotencyKey` | String | Client UUID v4; unique per sena |
| `userId` | UUID | FK → User |
| `timestamp` | DateTime | Payment time |

### CASH Flow

```
SenaPayment created (method=CASH)
→ CashMovement created (type=SENA_DEPOSIT, amount>0)
→ CashMovement.senaPaymentId = SenaPayment.id
→ requires an OPEN CashSession at SenaPayment.locationId (same Location)
```

A CASH `SenaPayment` records **exactly one** positive `CashMovement` at deposit time. It must bind to an OPEN `CashSession` in the same Location as the SEÑA. When a Location has multiple `CashRegister`s / sessions, the recording operator designates the specific OPEN session (mirroring the sale-cash rule, §14).

### Non-CASH Flow

```
SenaPayment created (method ∈ TRANSFER | CARD_DEBIT | CARD_CREDIT)
→ no CashMovement
```

**SEÑA expiry NEVER deletes SenaPayment. SEÑA fulfillment NEVER creates a second CashMovement — the deposit was already captured in the drawer at deposit time.**

---

## 10. SEÑA Application / Settlement (Fulfillment to Sale)

When a customer fulfills a SEÑA (creates the sale), the following atomic operation occurs:

### SenaSettlement Entity

`SenaSettlement` represents the **financial application** of an already-collected deposit to a sale — it is **not** a new receipt of money and must never create a duplicate payment or a second `CashMovement`.

| Field | Type | Description |
|-------|------|-------------|
| `id` | UUID | PK |
| `senaId` | UUID | FK → CommercialSena (unique — one settlement per SEÑA) |
| `saleId` | UUID | FK → Sale (the created sale) |
| `totalDepositApplied` | BigInt | Sum of applied `SenaPayment.amount` for this SEÑA (0 ≤ totalDepositApplied ≤ Sale.total) |
| `balanceDue` | BigInt | `Sale.total - totalDepositApplied` (≥ 0) |
| `createdById` | UUID | FK → User (operator who completes fulfillment) |
| `createdAt` | DateTime | Settlement time |

### Financial Application Rule (authoritative)

A `Sale` becomes fully paid when:

```
Sale.total = SUM(applied SenaSettlement.totalDepositApplied) + SUM(accepted SalePayment.amount)
```

- **Do NOT** materialize an already-collected `SenaPayment` as a new `SalePayment`.
- **Do NOT** create a second `CashMovement` for a CASH `SenaPayment` at fulfillment (it already produced exactly one `SenaPayment`-linked `CashMovement` at deposit time).
- The original `SenaPayment` remains the authoritative historical payment.
- Application is **idempotent**: a `SenaPayment` may never be financially applied twice; `0 <= totalDepositApplied <= Sale.total`.

### Atomic SEÑA → Sale Handoff (Single Transaction)

Ordering is critical: the SEÑA being fulfilled **already owns** its own inventory entitlement and must be excluded from "other active commitments" during validation.

```typescript
await prisma.$transaction(async (tx) => {
  // 1. Lock affected InventoryBalance rows in deterministic order (variantId ASC, locationId ASC)
  const balances = await lockInventoryBalances(senaItems, tx);

  // 2. Lock the CommercialSena + SenaItem rows
  const sena = await lockSena(senaId, tx);

  // 3. Expire/reject if the SEÑA is no longer valid
  assert(sena.status === 'ACTIVE', 'SEÑA not active');
  assert(sena.expiresAt > now(), 'SEÑA expired');

  // 4. Compute OTHER active commitments EXCLUDING this SEÑA, against locked balances
  for (const item of sena.items) {
    const balance = balances.get(`${item.variantId}-${item.locationId}`);
    const otherTechnical = await sumActiveStockHoldExcept(balance, /* this sale's to-be holds */ [], tx);
    const otherCommercial = await sumActiveSenaItemExcluding(balance, senaId, tx);
    // The SEÑA's own quantity is entitlement, so it is NOT subtracted here
    assert(balance.onHand >= otherTechnical + otherCommercial + item.quantity,
      'SEÑA holds cannot be covered (external holds concurrent)');
  }

  // 5. Atomically replace SenaItem commitment with StockHold (no unheld, no double-held window):
  //    a) create StockHold per SenaItem (technical hold, if still required)
  //    b) in the same TX the effective commercial commit ends because status becomes FULFILLED
  // 6. Create Sale + SenaSettlement
  // 7. Mark CommercialSena FULFILLED
  // 8. AuditLog
  ...
});
```

No `StockMovement` is emitted during logical hold conversion. Additional merchandise beyond the original SEÑA entitlement must pass normal `effectiveSellable` validation.

### Sellable Formula Adjustment for SEÑA

```typescript
async function sumActiveSenaItemExcluding(variantId, locationId, excludeSenaId, tx) {
  return tx.senaItem.aggregate({
    where: {
      variantId,
      locationId,
      sena: { status: 'ACTIVE', expiresAt: { gt: now() }, id: { not: excludeSenaId } },
    },
    _sum: { quantity: true },
  });
}
```

**Critical**: The handoff from `SenaItem` (commercial hold) to `StockHold` (technical hold) is atomic within the same transaction. There is no externally visible state with no hold or a double hold — the `CommercialSena.status` flip to `FULFILLED` and `StockHold` creation happen together, so no other seller can reserve the same units in between.

---

## 11. Transaction Rules

### 10.1 Universal Principles

1. **One business operation = one DB transaction**
2. **Lock all affected `InventoryBalance` rows `FOR UPDATE` before reading**
3. **Validate invariants AFTER locks, BEFORE mutation**
4. **Write `StockMovement` with before/after `onHand` snapshots in same TX**
5. **Write `AuditLog` in same TX**
6. **No external calls (ARCA, storage, email) inside critical TX**

### 10.2 Concurrency Control

Row locks are taken via explicit SQL **through Prisma raw-SQL** (`$queryRaw`), not a Prisma `lock` API (Prisma has no `lock` option on `findMany`) and not an `@@check` (Prisma has no `@@check`). See §12 Reconciliation for the canonical SQL patterns; the Demo V2 `reservation.service.ts` already demonstrates `SELECT ... FOR UPDATE` inside `prisma.$transaction(..., { isolationLevel: 'Serializable' })`.

```typescript
await prisma.$transaction(async (tx) => {
  // 1. Lock rows in consistent order: (variantId ASC, locationId ASC)
  const balances = await tx.$queryRaw`
    SELECT id, "variantId", "locationId", "onHand"
    FROM "InventoryBalance"
    WHERE ("variantId", "locationId") IN (${pairs})
    ORDER BY "variantId" ASC, "locationId" ASC
    FOR UPDATE
  `;

  // 2. Validate invariants on locked state (effective holds)
  for (const b of balances) {
    const effectiveTechnical = await sumActiveStockHold(b.variantId, b.locationId, tx);
    const effectiveCommercial = await sumActiveSenaItem(b.variantId, b.locationId, tx);
    assert(b.onHand >= effectiveTechnical + effectiveCommercial);  // holds ≤ onHand
    assert(b.onHand >= 0);
  }

  // 3. Validate effectiveSellable against requested withdrawal before any decrement
  const effectiveSellable = b.onHand - effectiveTechnical - effectiveCommercial;
  assert(effectiveSellable >= requestedQty);

  // 4. Mutate onHand + create StockMovement + AuditLog in the same TX
});
```

### 10.3 Deadlock Prevention

- Always lock `InventoryBalance` rows in **deterministic order**: `(variantId ASC, locationId ASC)`
- Keep transactions short (no external I/O)
- Use `Prisma.TransactionIsolationLevel.Serializable` where needed

---

## 12. Reconciliation

### 12.0 Canonical StockMovement Reference Convention

Every `StockMovement.referenceType`/`referenceId` follows **one** aggregate-root convention everywhere in this document set, the reconciliation SQL, and the implementation:

| Movement type | referenceType | referenceId |
|---------------|---------------|-------------|
| `SALE` | `SALE` | `Sale.id` |
| `GOODS_RECEIPT` | `GOODS_RECEIPT` | `GoodsReceipt.id` |
| `TRANSFER_DISPATCH` / `TRANSFER_RECEIVE` / `TRANSFER_RETURN_TO_ORIGIN` | `STOCK_TRANSFER` | `StockTransfer.id` |
| `PUBLICATION_CHECKOUT` / `PUBLICATION_RETURN` | `PUBLICATION_CHECKOUT` | `PublicationCheckout.id` |
| `DAMAGE_WRITE_OFF` / `LOSS_WRITE_OFF` (publication/transfer) | `PUBLICATION_CHECKOUT` / `STOCK_TRANSFER` | aggregate id |
| `EXCHANGE_RETURN` / `EXCHANGE_OUT` | `EXCHANGE` | `Exchange.id` |
| `INITIAL_STOCK` | `INITIAL_STOCK` | import batch id |
| `ADJUSTMENT` / `INVENTORY_CORRECTION` | `ADJUSTMENT` | correction id |

Item/event-level correlation (e.g. which `TransferResolution` produced a movement) is captured via optional `referenceSubId`/`referenceSubType` fields, **never** by reinterpreting `referenceId`. All reconciliation below relies on this convention.

### 12.1 Balance ↔ Ledger Consistency (Location onHand only)

`INITIAL_STOCK` is itself a `StockMovement` with `balanceEffect = ON_HAND`; there is **no** separate `initialOnHand` baseline field. The canonical invariant is:

```
InventoryBalance.onHand = SUM(StockMovement.quantityDelta WHERE balanceEffect = 'ON_HAND' for this variant + location)
```

```sql
SELECT
  ib.variant_id,
  ib.location_id,
  ib.on_hand,
  COALESCE(SUM(CASE WHEN sm.balance_effect = 'ON_HAND' THEN sm.quantity_delta ELSE 0 END), 0) AS ledger_on_hand
FROM inventory_balance ib
LEFT JOIN stock_movement sm ON sm.inventory_balance_id = ib.id
GROUP BY ib.id
HAVING ib.on_hand != ledger_on_hand;
```

### 12.2 External Custody Reconciliation Invariants (Separate from Location balance)

External custody is reconciled against **domain quantities** (not a naive signed delta sum). Signed movement deltas are converted per-type to non-negative custody contributions.

**Transfer Custody:**

```sql
-- outstandingTransit (non-negative domain quantity) per TransferItem
--   = dispatchedQty - receivedQty - returnedToOriginQty - lostInTransitQty
-- ledger contribution (non-negative):
--   + dispatched (movement TRANSFER_DISPATCH, delta negative -> negate)
--   - received  (movement TRANSFER_RECEIVE, delta positive)
--   - returnedToOrigin (movement TRANSFER_RETURN_TO_ORIGIN, delta positive)
SELECT
  ti.id,
  ti.dispatched_qty - ti.received_qty - ti.returned_to_origin_qty - ti.lost_in_transit_qty AS outstanding_transit,
  COALESCE(SUM(CASE
    WHEN sm.type = 'TRANSFER_DISPATCH' THEN (-sm.quantity_delta)
    WHEN sm.type = 'TRANSFER_RECEIVE' THEN (-sm.quantity_delta)
    WHEN sm.type = 'TRANSFER_RETURN_TO_ORIGIN' THEN (-sm.quantity_delta)
    ELSE 0 END), 0) AS ledger_transit
FROM transfer_item ti
LEFT JOIN stock_movement sm
  ON sm.reference_type = 'STOCK_TRANSFER'
  AND sm.reference_id = ti.transfer_id
  AND sm.inventory_balance_id IN (SELECT id FROM inventory_balance WHERE variant_id = ti.variant_id)
WHERE ti.transfer_id IN (SELECT id FROM stock_transfer WHERE status IN ('DISPATCHED','IN_TRANSIT','RECEIVED_WITH_DIFFERENCE'))
GROUP BY ti.id
HAVING outstanding_transit != ledger_transit;
```

Note: `LOST_IN_TRANSIT` **does not** touch Location `onHand` (already removed at dispatch) and is therefore not a Location `ON_HAND` movement — the loss is captured by incrementing `TransferItem.lostInTransitQty`, which reduces `outstandingTransit`, plus an audit `LOSS_WRITE_OFF` movement with `balanceEffect = NONE`.

**Publication Custody:**

```sql
-- publicationOutstanding (non-negative domain quantity) per PublicationItem
--   = checkedOutQty - returnedGoodQty - damagedResolvedQty - lostResolvedQty
SELECT
  pi.id,
  pi.checked_out_qty
    - pi.returned_good_qty
    - pi.damaged_resolved_qty
    - pi.lost_resolved_qty AS publication_outstanding,
  COALESCE(SUM(CASE
    WHEN sm.type = 'PUBLICATION_CHECKOUT' THEN (-sm.quantity_delta)
    WHEN sm.type = 'PUBLICATION_RETURN' THEN (-sm.quantity_delta)
    ELSE 0 END), 0) AS ledger_publication
FROM publication_item pi
LEFT JOIN stock_movement sm
  ON sm.reference_type = 'PUBLICATION_CHECKOUT'
  AND sm.reference_id = pi.checkout_id
  AND sm.inventory_balance_id IN (SELECT id FROM inventory_balance WHERE variant_id = pi.variant_id)
WHERE pi.checkout_id IN (SELECT id FROM publication_checkout WHERE status IN ('OUT','PARTIAL'))
GROUP BY pi.id
HAVING publication_outstanding != ledger_publication;
```

`PUBLICATION_RETURN` only accrues for `GOOD` returns (which restore `onHand`). `DAMAGED`/`LOSS` resolution reduces `damagedResolvedQty`/`lostResolvedQty` with `balanceEffect = NONE` (no second Location decrement) and never appear in the Location balance invariant.

### 12.3 Correction Protocol

1. Create `INVENTORY_CORRECTION` movement with delta = `ledger - balance` (only `balanceEffect = ON_HAND`)
2. Update `InventoryBalance.onHand` to match ledger
3. Write `AuditLog` with `action: 'INVENTORY_RECONCILIATION'`
4. Notify admin/owner (HIGH priority)

**Never** delete or modify historical `StockMovement` rows.

---

## 13. Idempotency Constraints for Resolutions

### 13.1 Transfer Resolution Idempotency

Transfer resolutions (`LATE_RECEIPT`, `RETURNED_TO_ORIGIN`, `LOST_IN_TRANSIT`) must be idempotent. The `TransferResolution` entity enforces this:

| Constraint | Enforcement |
|------------|-------------|
| **One resolution per discrepancy unit** | `TransferItem` quantities (`receivedQty`, `returnedToOriginQty`, `lostInTransitQty`) are monotonically increasing. A resolution increments exactly one by `quantity`. |
| **No double-count** | Resolution validates `outstandingTransit >= quantity` before applying. After resolution, `outstandingTransit` decreases by `quantity`. |
| **Transfer cannot close with outstanding > 0** | `StockTransfer.status` transition to `CLOSED`/`COMPLETED` guarded by `outstandingTransit = 0` invariant. |

```typescript
async function resolveTransferDiscrepancy(
  transferItemId: string,
  resolutionType: 'LATE_RECEIPT' | 'RETURNED_TO_ORIGIN' | 'LOST_IN_TRANSIT',
  quantity: BigInt,
  userId: string,
  tx: PrismaClient
) {
  const item = await tx.transferItem.findUnique({ where: { id: transferItemId }, include: { transfer: true } });
  assert(item.transfer.status !== 'CANCELLED', 'Transfer cancelled');
  
  const outstanding = item.dispatchedQty - item.receivedQty - item.returnedToOriginQty - item.lostInTransitQty;
  assert(outstanding >= quantity, 'Resolution exceeds outstanding transit');
  
  const updates: Record<string, BigInt> = {};
  let movementType: StockMovementType;
  
  switch (resolutionType) {
    case 'LATE_RECEIPT':
      updates.receivedQty = { increment: quantity };
      movementType = 'TRANSFER_RECEIVE';
      break;
    case 'RETURNED_TO_ORIGIN':
      updates.returnedToOriginQty = { increment: quantity };
      movementType = 'TRANSFER_RETURN_TO_ORIGIN';
      break;
    case 'LOST_IN_TRANSIT':
      updates.lostInTransitQty = { increment: quantity };
      movementType = 'LOSS_WRITE_OFF';
      break;
  }
  
  await tx.$transaction(async (tx) => {
    // 0. Lock TransferItem row FOR UPDATE (prevents concurrent resolutions)
    const item = await lockTransferItem(transferItemId, tx);
    // 1. Update TransferItem (monotonic increment)
    await tx.transferItem.update({ where: { id: transferItemId }, data: updates });
    
    // 2. If LATE_RECEIPT or RETURNED_TO_ORIGIN: move onHand
    if (resolutionType === 'LATE_RECEIPT') {
      await tx.inventoryBalance.update({
        where: { variantId_locationId: { variantId: item.variantId, locationId: item.transfer.destinationId }},
        data: { onHand: { increment: quantity }}
      });
    } else if (resolutionType === 'RETURNED_TO_ORIGIN') {
      await tx.inventoryBalance.update({
        where: { variantId_locationId: { variantId: item.variantId, locationId: item.transfer.originId }},
        data: { onHand: { increment: quantity }}
      });
    }
    
    // 3. Write StockMovement (always, even for LOST_IN_TRANSIT with quantityDelta=0)
    //    Canonical reference convention: referenceType = 'STOCK_TRANSFER', referenceId = transferId
    const balanceId = await getBalanceId(item.variantId, resolutionType === 'LATE_RECEIPT' ? item.transfer.destinationId : item.transfer.originId, tx);
    const before = await getOnHand(balanceId, tx);
    const after = before + (resolutionType === 'LOST_IN_TRANSIT' ? 0n : quantity);
    await tx.stockMovement.create({
      data: {
        inventoryBalanceId: balanceId,
        type: movementType,
        quantityDelta: resolutionType === 'LOST_IN_TRANSIT' ? 0n : quantity,
        balanceEffect: resolutionType === 'LOST_IN_TRANSIT' ? 'NONE' : 'ON_HAND',
        beforeOnHand: before,
        afterOnHand: after,
        referenceType: 'STOCK_TRANSFER',
        referenceId: item.transferId,
        referenceSubType: 'TRANSFER_RESOLUTION',
        referenceSubId: transferItemId,
        userId,
        locationId: resolutionType === 'LATE_RECEIPT' ? item.transfer.destinationId : item.transfer.originId,
        notes: `resolution=${resolutionType}`
      }
    });
    
    // 4. Check if transfer can close
    const updated = await tx.transferItem.findUnique({ where: { id: transferItemId } });
    const newOutstanding = updated.dispatchedQty - updated.receivedQty - updated.returnedToOriginQty - updated.lostInTransitQty;
    const allItems = await tx.transferItem.findMany({ where: { transferId: item.transferId } });
    const totalOutstanding = allItems.reduce((sum, i) => sum + (i.dispatchedQty - i.receivedQty - i.returnedToOriginQty - i.lostInTransitQty), 0n);
    
    if (totalOutstanding === 0n) {
      await tx.stockTransfer.update({
        where: { id: item.transferId },
        data: { status: 'RECEIVED', receivedAt: new Date() }
      });
    }
    
    // 5. AuditLog
    await tx.auditLog.create({ data: { userId, action: 'TRANSFER_RESOLUTION', entityType: 'TransferItem', entityId: transferItemId, ... } });
  });
}
```

### 13.2 Publication Resolution Idempotency

Publication resolutions (`GOOD`, `DAMAGED`, `LOSS`), of arbitrary positive quantity, must be idempotent. The `PublicationResolution` entity (with `idempotencyKey`) enforces this; authoritative resolution quantities live on `PublicationItem` (`returnedGoodQty`, `damagedResolvedQty`, `lostResolvedQty`).

| Constraint | Enforcement |
|------------|-------------|
| **Quantity-level resolution** | `PublicationItem` resolution quantities monotonically increase; a resolution increments exactly one by `quantity`. |
| **No double-count** | Resolution validates `publicationOutstanding >= quantity` with the item row locked `FOR UPDATE`; unique `idempotencyKey` prevents replay. |
| **Checkout cannot close with outstanding > 0** | `PublicationCheckout.status` transition to `RETURNED` guarded by `publicationOutstanding = 0` for all items. |

```typescript
async function resolvePublicationReturn(
  publicationItemId: string,
  condition: 'GOOD' | 'DAMAGED' | 'LOSS',
  quantity: BigInt,
  idempotencyKey: string,
  userId: string,
  tx: PrismaClient
) {
  await tx.$transaction(async (tx) => {
    // 0. Lock PublicationItem FOR UPDATE (prevents concurrent resolutions)
    const item = await lockPublicationItem(publicationItemId, tx);
    const checkedOut = item.checkedOutQty;
    const resolved = item.returnedGoodQty + item.damagedResolvedQty + item.lostResolvedQty;
    const outstanding = checkedOut - resolved;
    assert(item.checkout.status !== 'RETURNED', 'Checkout already closed');
    assert(outstanding >= quantity, 'Resolution exceeds outstanding publication');

    // Idempotency: reuse existing resolution if the same key already resolved this quantity
    const existing = await tx.publicationResolution.findUnique({ where: { idempotencyKey } });
    if (existing) return existing;

    let movementType: StockMovementType;
    let balanceEffect: BalanceEffect;
    let onHandDelta = 0n;
    switch (condition) {
      case 'GOOD': movementType = 'PUBLICATION_RETURN'; balanceEffect = 'ON_HAND'; onHandDelta = quantity; break;
      case 'DAMAGED': movementType = 'DAMAGE_WRITE_OFF'; balanceEffect = 'NONE'; break;
      case 'LOSS': movementType = 'LOSS_WRITE_OFF'; balanceEffect = 'NONE'; break;
    }

    // 1. Increment the authoritative resolution quantity
    const field = condition === 'GOOD' ? 'returnedGoodQty' : condition === 'DAMAGED' ? 'damagedResolvedQty' : 'lostResolvedQty';
    await tx.publicationItem.update({ where: { id: publicationItemId }, data: { [field]: { increment: quantity } } });

    // 2. Create PublicationResolution record
    const resolution = await tx.publicationResolution.create({
      data: { itemId: publicationItemId, condition, quantity, idempotencyKey, receivedById: userId, receivedAt: new Date() }
    });

    // 3. If GOOD: restore onHand + StockMovement(ON_HAND)
    const balanceId = await getBalanceId(item.variantId, item.checkout.locationId, tx);
    const before = await getOnHand(balanceId, tx);
    if (condition === 'GOOD') {
      await tx.inventoryBalance.update({ where: { id: balanceId }, data: { onHand: { increment: quantity } } });
    }
    const after = condition === 'GOOD' ? before + quantity : before;
    await tx.stockMovement.create({
      data: {
        inventoryBalanceId: balanceId,
        type: movementType,
        quantityDelta: condition === 'GOOD' ? quantity : 0n,
        balanceEffect,
        beforeOnHand: before, afterOnHand: after,
        referenceType: 'PUBLICATION_CHECKOUT',
        referenceId: item.checkoutId,
        referenceSubType: 'PUBLICATION_RESOLUTION', referenceSubId: resolution.id,
        userId, locationId: item.checkout.locationId,
        notes: `condition=${condition}`
      }
    });

    // 4. Check if checkout can close
    const allItems = await tx.publicationItem.findMany({ where: { checkoutId: item.checkoutId } });
    const allResolved = allItems.every(i => i.checkedOutQty === i.returnedGoodQty + i.damagedResolvedQty + i.lostResolvedQty);
    if (allResolved) {
      await tx.publicationCheckout.update({ where: { id: item.checkoutId }, data: { status: 'RETURNED' } });
    }

    // 5. AuditLog
    await tx.auditLog.create({ data: { userId, action: 'PUBLICATION_RESOLUTION', entityType: 'PublicationItem', entityId: publicationItemId, ... } });
  });
}
```

---

## 14. Corrections / Reversals

| Scenario | Action |
|----------|--------|
| Sale completed but wrong variant | New `ADJUSTMENT` (+wrong, -correct) + `StockMovement` |
| GoodsReceipt completed with wrong qty | New `ADJUSTMENT` (delta) — never edit original receipt |
| Transfer received with discrepancy | `RECEIVED_WITH_DIFFERENCE` status; explicit resolution via LATE_RECEIPT/RETURNED_TO_ORIGIN/LOST_IN_TRANSIT |
| Publication damage/loss | `DAMAGE_WRITE_OFF` / `LOSS_WRITE_OFF` (no onHand change) |
| SEÑA deposit refund (policy change) | New `CashMovement` + reverse `SenaPayment` logic (no stock movement) |

**Rule**: Corrections are **new movements**, never historical mutations.

---

## 15. Initial Import

### 13.1 Day 25 Import Foundation (FR-IMPORT-001)

```typescript
// CSV/XLSX import flow
// 1. Parse & validate (column mapping, types, required fields)
// 2. Preview: show rows, errors, warnings
// 3. User confirms
// 4. For each valid row:
    // - Upsert Product / ProductVariant
    // - Create InventoryBalance if not exists
    // - Create StockMovement(type=INITIAL_STOCK, quantityDelta=qty)
    // - Write AuditLog

// Initial stock MUST produce INITIAL_STOCK ledger entries
```

### 13.2 Initial Balance Seeding

```sql
INSERT INTO inventory_balance (variant_id, location_id, on_hand)
VALUES (..., imported_qty);

INSERT INTO stock_movement (inventory_balance_id, type, quantity_delta, 
       before_on_hand, after_on_hand, reference_type, reference_id)
VALUES (new_balance_id, 'INITIAL_STOCK', imported_qty,
       0, imported_qty, 'INITIAL_STOCK', import_batch_id);
```

---

## 16. Worked Examples

All quantities in **units**. Only `onHand` shown for balance; holds shown separately.

### Example A: Technical Hold

**Initial**: Branch Centro, Variant `REM-NEG-M`, `onHand=10`, no active holds

| Step | Action | onHand | Active Technical | Active Commercial | Sellable | Company Custody |
|------|--------|--------|------------------|-------------------|----------|-----------------|
| 0 | Initial | 10 | 0 | 0 | **10** | 10 |
| 1 | Seller sends sale (qty=2) to cashier | 10 | **2** | 0 | **8** | 10 |
| 2 | Cashier completes sale | **8** | **0** | 0 | **8** | 8 |

**Movements**:
- Step 1: No StockMovement (StockHold created, status=ACTIVE)
- Step 2: `StockMovement(SALE, -2)` with snapshots

---

### Example B: Transfer Dispatch

**Initial**: 
- Origin (Centro): `onHand=10`
- Dest (Yerba Buena): `onHand=5`
- Transfer: 3 units dispatched

| Location | Step | onHand | Outstanding Transfer | Sellable (if no holds) | Company Custody |
|----------|------|--------|----------------------|------------------------|-----------------|
| Centro | 0 Initial | 10 | 0 | 10 | 10 |
| Centro | 1 Dispatch 3 | **7** | **3** | 7 | 10 |
| Yerba Buena | 0 Initial | 5 | 0 | 5 | 5 |
| Yerba Buena | 1 (no change yet) | 5 | 0 | 5 | 5 |

**Key**: Origin `onHand` decreased by 3. Company custody unchanged (7+3+5=15).

---

### Example C: Transfer Receive with Discrepancy

**Continuing from B**: 2 of 3 received at Yerba Buena

| Location | Step | onHand | Outstanding Transfer | Company Custody |
|----------|------|--------|----------------------|-----------------|
| Centro | 2 (no change) | 7 | **3** | 10 |
| Yerba Buena | 2 Receive 2 | **7** | **1** | 10 |

**Discrepancy**: Dispatched 3, Received 2 → `outstandingTransit = 1` → `RECEIVED_WITH_DIFFERENCE`  
**TransferItem**: `dispatchedQty=3`, `receivedQty=2`, `outstandingTransit=1`

**Resolution required** before transfer can close:
- If LATE_RECEIPT: YB `onHand += 1`, `receivedQty = 3`, `outstandingTransit = 0`
- If RETURNED_TO_ORIGIN: Centro `onHand += 1`, `returnedToOriginQty = 1`, `outstandingTransit = 0`
- If LOST_IN_TRANSIT: `lostInTransitQty = 1`, `LOSS_WRITE_OFF` movement, `outstandingTransit = 0`

**No invented stock**: Destination got exactly 2. The missing 1 stays in transfer custody until resolved.

---

### Example D: Publication Checkout + Return GOOD

**Initial**: Branch Centro, `onHand=10`

| Step | Action | onHand | Publication Outstanding | Sellable (no holds) | Company Custody |
|------|--------|--------|-------------------------|---------------------|-----------------|
| 0 | Initial | 10 | 0 | 10 | 10 |
| 1 | Checkout 1 for photo shoot | **9** | **1** | 9 | 10 |
| 2 | Return GOOD | **10** | **0** | 10 | 10 |

**Movements**:
- Step 1: `PUBLICATION_CHECKOUT (-1 onHand)`
- Step 2: `PUBLICATION_RETURN (+1 onHand)`

**No double subtraction**: Unit left `onHand` at checkout; returned to `onHand` at return.

---

### Example E: Publication Checkout + LOSS

**Initial**: Branch Centro, `onHand=10`

| Step | Action | onHand | Publication Outstanding | Company Custody |
|------|--------|--------|-------------------------|-----------------|
| 0 | Initial | 10 | 0 | 10 |
| 1 | Checkout 1 | **9** | **1** | 10 |
| 2 | Return LOSS | 9 | **0** | **9** |

**Movements**:
- Step 1: `PUBLICATION_CHECKOUT (-1 onHand)`
- Step 2: `LOSS_WRITE_OFF (0 onHand change)` — **onHand unchanged!**

**Critical**: The unit was already removed from `onHand` at checkout.  
`LOSS_WRITE_OFF` only clears publication custody. Company custody decreases by 1.

**No double-decrement**: If we did `onHand -= 1` again at LOSS, custody would be 8 (wrong).

---

### Example F: Commercial SEÑA (24-hour)

**Initial**: Branch Centro, `onHand=10`, no active holds

| Step | Action | onHand | Active Commercial | Sellable | Company Custody |
|------|--------|--------|-------------------|----------|-----------------|
| 0 | Initial | 10 | 0 | 10 | 10 |
| 1 | Customer creates SEÑA (qty=2, deposit ARS 5000) | 10 | **2** | **8** | 10 |
| 2 | 24h expiry (no fulfillment) | 10 | **0** | **10** | 10 |
| 3 | Customer fulfills (creates sale) | **8** | 0 | 8 | 8 |

**Mechanics**:
- Step 1: `CommercialSena` created, `SenaItem(qty=2)`, `SenaPayment(amount=5000)`, `CashMovement` if cash
- Sellable = `onHand - activeSenaQty = 10 - 2 = 8`
- Step 2 (expiry): `CommercialSena.status=EXPIRED`, `activeSenaQty=0`, sellable=10
- Step 3 (fulfill): `CommercialSena.status=FULFILLED` → creates Sale → normal sale flow (`onHand -= 2`)

**StockMovement**: Only on fulfillment (type `SALE`). Never on create/expiry.

---

### Example G: Concurrent Sellers — Last Unit

**Initial**: Branch Centro, `onHand=1`, no active holds

| Time | Seller A | Seller B | onHand | Active Technical | Sellable | Result |
|------|----------|----------|--------|------------------|----------|--------|
| T0 | — | — | 1 | 0 | 1 | — |
| T1 | Reads sellable=1 | — | 1 | 0 | 1 | — |
| T2 | — | Reads sellable=1 | 1 | 0 | 1 | — |
| T3 | Sends to cashier (lock, validate, create StockHold) | — | 1 | **1** | **0** | **A succeeds** |
| T4 | — | Sends to cashier (lock, validate) | 1 | 1 | 0 | **B fails** (sellable=0) |

**Locking**: Both TXs lock `InventoryBalance(variant, Centro) FOR UPDATE`.  
Second TX waits, re-reads `sellable=0`, rejects with `409 INSUFFICIENT_STOCK`.

**Validation inside TX**:
```typescript
const activeTechnical = await sumActiveStockHold(variantId, locationId, tx);
const activeCommercial = await sumActiveSenaItem(variantId, locationId, tx);
const sellable = balance.onHand - activeTechnical - activeCommercial;
if (sellable < requestedQty) throw InsufficientStockError;
```

**No oversell**: Only one reservation succeeds.

---

## 17. Global / Company Custody Calculation

```typescript
async function getCompanyStock(variantId: string): Promise<{
  totalCustody: BigInt;
  byLocation: Map<string, { onHand, sellable }>;
  transfers: Map<string, { outstandingTransit }>;
  publications: Map<string, { publicationOutstanding }>;
}> {
  // 1. Sum all onHand
  const balances = await prisma.inventoryBalance.findMany({
    where: { variantId },
    include: { location: true }
  });
  
  // 2. Sum all outstanding transfer custody
  const transferItems = await prisma.transferItem.findMany({
    where: { variantId },
    include: { transfer: true }
  });
  
  // 3. Sum all outstanding publication custody
  const pubItems = await prisma.publicationItem.findMany({
    where: { variantId },
    include: { checkout: true }
  });
  
  // Compute...
}
```

---

## 18. Concurrency Scenarios — Complete Matrix

| Scenario | Lock Order | Validation | Failure Mode |
|----------|------------|------------|--------------|
| Two sellers reserve last unit | IB(variant, loc) | `sellable >= qty` | Second gets 409 |
| Sale complete + concurrent reserve | Sale → IB | Sale=PAID, holds=ACTIVE | Reserve fails (sellable=0) |
| Two cashiers complete same sale | Sale → IB | Sale=PAID | Second gets 409 (already COMPLETED) |
| Transfer dispatch + sale at origin | IB(origin) | `onHand >= dispatchedQty` | Serialized by lock |
| Transfer receive + sale at dest | IB(dest) | N/A | Serialized |
| SEÑA create + sale reserve | IB | `sellable >= qty` | Serialized |
| Publication checkout + sale | IB | `onHand >= qty` | Serialized |
| Two adjustments same variant×loc | IB | N/A | Serialized |

**All use**: `SELECT ... FOR UPDATE` on `InventoryBalance` rows in deterministic order.

---

## 19. Idempotency Patterns

| Operation | Key | Mechanism |
|-----------|-----|-----------|
| SalePayment | `idempotencyKey` (client UUID) | `UNIQUE(saleId, idempotencyKey)` |
| GoodsReceipt completion | `receiptId` + status | `status=IN_PROGRESS` guard |
| Transfer dispatch | `transferId` + status | `status=APPROVED` guard |
| Number allocation | `DocumentCounter` row | `FOR UPDATE` + increment |
| SEÑA create | Customer + variant + location | App-level check + TX |
| SenaPayment | `idempotencyKey` | `UNIQUE(senaId, idempotencyKey)` |
| StockHold create | `saleId` + `variantId` + `locationId` | Unique per sale item |

---

## 20. Negative Stock Prevention

### Database Constraints

```sql
CHECK (on_hand >= 0)
```

### Application Validation (Before Mutation)

```typescript
async function validateSellable(balance: InventoryBalance, requestedQty: BigInt, tx): Promise<void> {
  const activeTechnical = await sumActiveStockHold(balance.variantId, balance.locationId, tx);
  const activeCommercial = await sumActiveSenaItem(balance.variantId, balance.locationId, tx);
  const sellable = balance.onHand - activeTechnical - activeCommercial;
  if (sellable < requestedQty) {
    throw new InsufficientStockError({ available: sellable, requested: requestedQty });
  }
}

function validateOnHand(balance: InventoryBalance, delta: BigInt): void {
  if (balance.onHand + delta < 0) {
    throw new NegativeStockError({ current: balance.onHand, delta });
  }
}
```

**Race condition proof**: Validation + mutation in same TX with row lock = serializable.

---

## 21. Migration from Demo V2 Inventory

### 19.1 Schema Changes

| Demo V2 Field | Production V1 Field | Migration |
|---------------|---------------------|-----------|
| `Inventory.physical` | `InventoryBalance.onHand` | RENAME + copy data |
| `Inventory.reserved` | Migrated to `StockHold` records | Backfill active reservations → StockHold; then DROP column |
| `StockReservation` | `StockHold` | RENAME table |
| `StockMovement.type` (SALE only) | 13+ types | ALTER enum, backfill |

### 19.2 Data Migration Steps

```sql
-- 1. Rename physical → on_hand
ALTER TABLE inventory RENAME COLUMN physical TO on_hand;

-- 2. Drop reserved column (after backfilling StockHold)
-- Backfill: INSERT INTO stock_hold SELECT ... FROM stock_reservation WHERE status='ACTIVE';
ALTER TABLE inventory DROP COLUMN reserved;

-- 3. Rename table
ALTER TABLE inventory RENAME TO inventory_balance;

-- 4. Add check constraint
ALTER TABLE inventory_balance ADD CONSTRAINT chk_onhand_nonneg CHECK (on_hand >= 0);

-- 5. Rename StockReservation → StockHold
ALTER TABLE stock_reservation RENAME TO stock_hold;

-- 6. Add StockMovement snapshot columns (onHand only)
ALTER TABLE stock_movement 
  ADD COLUMN before_on_hand BIGINT,
  ADD COLUMN after_on_hand BIGINT,
  ADD COLUMN reference_type VARCHAR(50),
  ADD COLUMN reference_id VARCHAR(36);

-- 7. Backfill snapshots for existing SALE movements
-- One-time script; snapshot fields nullable during migration
```

### 19.3 New Tables (No Migration Needed)

- `CommercialSena`, `SenaItem`, `SenaPayment` — NEW
- `GoodsReceipt*`, `Supplier*` — NEW
- `StockTransfer*`, `TransferItem`, `Remito` — NEW
- `Exchange*`, `Publication*` — NEW
- `ProductImage`, `PriceHistory` — NEW
- `Notification`, `FiscalOutbox` — NEW
- `UserRoleScope` — NEW (replaces UserBranchRole)

---

## 22. Remaining Decisions Intentionally Deferred

| Decision | Deferred To | Reason |
|----------|-------------|--------|
| Configurable SEÑA expiry duration (V1 policy is exactly 24h) | Day 26-35 | Business policy finalized for V1; only configurability deferred |
| Transfer discrepancy resolution richer UX / guided workflow | Day 26-35 | Minimal resolution capability (LATE_RECEIPT, RETURNED_TO_ORIGIN, LOST_IN_TRANSIT) is Day 25 MUST; polish deferred |
| Damaged goods repair/quarantine custody | Future | Out of Day 25 scope |
| Automatic SEÑA/hold expiry worker | Day 26-35 | Lazy expiry sufficient for Day 25 |
| Multi-warehouse transfer routing | Future | Single central warehouse in V1 |
| Batch/serial number tracking | Future | Not required for V1 |
| Per-location price overrides | FUTURE / NOT REQUIRED FOR PRODUCTION V1 | Authoritative pricing is global |

---

## 23. Quality Gates — Inventory-Specific Checklist

- [ ] **No double-subtraction**: Transfer/publication units removed from `onHand` at source; never subtracted again
- [ ] **Sellable = onHand - Σ(active StockHold) - Σ(active SenaItem)**: Derived, never stored
- [ ] **Technical hold ≠ SEÑA**: Separate tables, different semantics, different financial impact
- [ ] **Balance + Ledger dual write**: Every physical mutation updates both in same TX
- [ ] **Snapshots on every StockMovement**: Complete before/after `onHand`
- [ ] **Immutable ledger**: No UPDATE/DELETE on StockMovement
- [ ] **Corrections via new movements**: `ADJUSTMENT`, `INVENTORY_CORRECTION`
- [ ] **Row locking**: `FOR UPDATE` on all mutated InventoryBalance rows
- [ ] **Deterministic lock order**: `(variantId, locationId)` ASC
- [ ] **Idempotency**: Payment, receipt, transfer, numbering, SEÑA all guarded
- [ ] **Transfer resolution idempotency**: TransferResolution entity, monotonic quantities, outstanding=0 guard
- [ ] **Publication return idempotency**: PublicationReturn entity, terminal status, checkout close guard
- [ ] **SEÑA→Sale atomic handoff**: SenaSettlement + StockHold in same TX, no unheld window
- [ ] **StockMovement balanceEffect flag**: ON_HAND vs NONE correctly applied
- [ ] **Negative stock impossible**: DB constraint + TX validation
- [ ] **Company custody = Σ(onHand) + Σ(outstandingTransit) + Σ(publicationOutstanding)**: Single custody per unit
- [ ] **External custody reconciliation invariants**: Transfer + Publication custody separately verifiable against ledger
- [ ] **Worked examples A–G all pass**: Units never double-counted
- [ ] **InventoryBalance has ONLY onHand**: No inTransitOut, inTransitIn, publicationOut, damaged, reserved columns
- [ ] **SenaPayment exists**: Dedicated financial record for SEÑA deposits
- [ ] **UserRoleScope with scopeKind**: LOCATION | COMPANY (no mixed enum)
- [ ] **UserRoleScope DB check constraint**: scopeKind + locationId consistency enforced

---

## 24. Summary: Key Invariants to Enforce in Code

```typescript
// In every inventory mutation transaction:
assert(balance.onHand >= 0);

// Sellable check before reserve/SEÑA/checkout
const activeTechnical = await sumActiveStockHold(variantId, locationId, tx);
const activeCommercial = await sumActiveSenaItem(variantId, locationId, tx);
const sellable = balance.onHand - activeTechnical - activeCommercial;
assert(sellable >= requestedQty);

// Company custody conservation (for transfers/publication)
const custodyBefore = sumCompanyCustody();
const custodyAfter  = sumCompanyCustody();
assert(custodyBefore === custodyAfter);  // Except GOODS_RECEIPT, INITIAL_STOCK, LOSS_WRITE_OFF, DAMAGE_WRITE_OFF
```

---

*End of 07-inventory-ledger.md*