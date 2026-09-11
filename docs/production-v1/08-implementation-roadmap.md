MONA JACINTA PRODUCTION V1
BLOCK 3 — IMPLEMENTATION ROADMAP

Repository branch:
feat/production-v1

Current approved baseline:

docs/production-v1/00-master-index.md
docs/production-v1/01-product-scope.md
docs/production-v1/02-functional-requirements.md
docs/production-v1/03-role-permission-matrix.md
docs/production-v1/04-domain-rules.md
docs/production-v1/05-architecture.md
docs/production-v1/06-erd-data-model.md
docs/production-v1/07-inventory-ledger.md

Block 1 and Block 2 are APPROVED and FROZEN.

Current baseline commit:

8a73ab7
docs: define Production V1 architecture and inventory model

==================================================
GOAL
==================================================

Create:

docs/production-v1/08-implementation-roadmap.md

This document must convert the approved Production V1 architecture into an
EXECUTABLE DEVELOPMENT PLAN.

Do NOT redesign the product.
Do NOT change requirements.
Do NOT change architecture.
Do NOT reopen Block 1 or Block 2 decisions.

Do NOT modify application code.
Do NOT modify Prisma schema.
Do NOT create migrations.
Do NOT modify tests.
Do NOT stage.
Do NOT commit.
Do NOT push.

==================================================
IMPLEMENTATION PHILOSOPHY
==================================================

Priority:

data integrity
> security
> business rules
> traceability
> architecture
> tests
> performance
> UX
> aesthetics

Implementation must proceed incrementally.

Each phase must leave the repository in a valid, testable state.

Avoid "big bang" migrations.

Production V1 must evolve safely from the existing Demo V2 implementation.

==================================================
ROADMAP STRUCTURE
==================================================

Create these implementation phases unless a dependency requires a minor
ordering adjustment.

PHASE 0 — PRODUCTION FOUNDATION / MIGRATION SAFETY

Purpose:
Prepare Demo V2 for incremental Production V1 migration without breaking the
working baseline.

Include:

- baseline verification
- database backup / rollback strategy
- migration conventions
- raw PostgreSQL migration strategy for:
  - CHECK constraints
  - partial unique indexes
  - NULLS NOT DISTINCT where required
- Prisma migration discipline
- environment/config review
- seed strategy
- compatibility strategy while Branch is migrated toward Location
- feature flags / temporary compatibility paths if required
- no destructive migrations without explicit validation

Exit criteria:
repository builds/tests clean and migration strategy is defined before schema
changes begin.

--------------------------------------------------

PHASE 1 — COMPANY + LOCATION + RBAC SCOPES

Implement:

Company
Location
LocationType:
- RETAIL_BRANCH
- CENTRAL_WAREHOUSE

Migration from Demo V2 Branch model.

Implement Production role model exactly:

OWNER
ADMIN
CASHIER
SELLER
WAREHOUSE

Implement:

Role
Permission
RolePermission
UserRoleScope

scopeKind:
- LOCATION
- COMPANY

Rules:

OWNER implicit company-wide authority.

ADMIN:
permission + explicit scope.
No implicit global access.

Database constraint:

LOCATION → locationId required
COMPANY → locationId null

PostgreSQL CHECK through explicit SQL migration.

Global catalog/pricing permissions require COMPANY scope.

Include migration of existing users / branch assignments.

Tests must cover privilege escalation attempts.

--------------------------------------------------

PHASE 2 — CATALOG + BARCODE + PRICING

Implement/migrate:

Product
ProductVariant
Category
Brand
Color catalog
size model
ProductImage metadata

Move authoritative barcode:

ProductVariant.barcode
→ Product.barcode

Migration must safely handle products whose variants currently have different
barcodes.

Do not arbitrarily destroy legacy identifiers.

Include:

legacyCode
variant SKU uniqueness
soft deactivation
no destructive delete of historically referenced products

Pricing:

listPrice
cashDiscount
cashPrice
wholesalePrice
cost

Global pricing only.

PRICE_MANAGE:
OWNER
or ADMIN with explicit COMPANY scope.

Backend-authoritative pricing.

Do not implement final SaleItem payment-composition finalization until Sale /
Payments phase, but prepare candidate price structures correctly.

Include Code128 label data requirements.

--------------------------------------------------

PHASE 3 — INVENTORY CORE

Implement:

InventoryBalance
StockMovement
StockHold

InventoryBalance:

ProductVariant × Location
onHand only

No authoritative:

reserved
inTransit
temporarilyOut

Implement:

effectiveSellable =
onHand
- active technical StockHold
- active commercial SenaItem where applicable later

For Phase 3, StockHold portion must already be structurally correct.

Implement:

balanceEffect:
ON_HAND
NONE

StockMovement append-only semantics.

Row locking:

SELECT ... FOR UPDATE

inside Prisma transactions using raw SQL where necessary.

Deterministic lock ordering.

No negative stock.

Canonical reconciliation:

InventoryBalance.onHand =
SUM(quantityDelta WHERE balanceEffect = ON_HAND)

Implement INITIAL_STOCK movement support.

Concurrency tests are mandatory.

--------------------------------------------------

PHASE 4 — CUSTOMER + SUPPLIER + GOODS RECEIPT + INITIAL IMPORT

Implement:

Customer
Supplier
SupplierProduct if required by ERD
GoodsReceipt
GoodsReceiptItem
GoodsReceiptAttachment

GoodsReceipt:

DRAFT / IN_PROGRESS
→ no stock mutation

COMPLETED
→ atomic:
InventoryBalance.onHand += receivedQuantity
StockMovement GOODS_RECEIPT
receipt immutable

Implement initial CSV/XLSX import foundation:

mapping
validation
preview
row-level errors
explicit confirmation
auditable INITIAL_STOCK movements

Do not overbuild final migration tooling beyond approved Day-25 scope.

--------------------------------------------------

PHASE 5 — STOCK TRANSFERS

Implement:

StockTransfer
TransferItem
TransferResolution
transfer numbering/remito

Workflow:

request
approve
prepare
dispatch
in transit
receive
difference
resolve
close/cancel where allowed

Quantities:

requestedQty
approvedQty
dispatchedQty
receivedQty
returnedToOriginQty
lostInTransitQty

Invariant:

received
+ returned
+ lost
<= dispatched

outstandingTransit =
dispatched
- received
- returned
- lost

Dispatch:
origin onHand decreases once.

Receive:
destination onHand increases actual received once.

LOST_IN_TRANSIT:
external custody resolution only
no second origin decrement.

Day-25 MUST:
minimal discrepancy resolution.

Include permission/scope checks for origin/destination.

Include concurrency + idempotency tests.

--------------------------------------------------

PHASE 6 — POS + SALE + PAYMENTS + CASH

Migrate/extend:

Sale
SaleItem
SalePayment
CashRegister
CashSession
CashMovement
DocumentCounter

Implement seller → cashier flow.

Technical StockHold created when sending to cashier.

Payment methods:

CASH
TRANSFER
CARD_DEBIT
CARD_CREDIT
QR where approved by baseline

Split payments.

Transfer institution metadata:

MACRO
BBVA
NACION
GALICIA
MERCADO_PAGO
OTHER

Card installments.

Cash payment must bind to a specific OPEN CashSession.

At most one OPEN CashSession per register.

Sale payment idempotency.

Document numbering concurrency-safe.

Implement authoritative payment-finalization pricing:

CONSUMER_FINAL:
100% CASH / TRANSFER
→ cashPrice

ANY card / QR component
→ listPrice

WHOLESALE
→ wholesalePrice

SaleItem final monetary snapshot immutable after finalization.

Complete Sale atomically:

payments validated
holds consumed
onHand decremented exactly once
StockMovement SALE
cash movements
sale numbering/state
audit/outbox as applicable

--------------------------------------------------

PHASE 7 — COMMERCIAL SEÑA

Implement:

CommercialSena
SenaItem
SenaPayment
SenaSettlement

Exact V1 expiry:

24 hours

SenaItem is a logical inventory commitment.

No physical StockMovement when SEÑA is created/released/expired.

CASH SenaPayment:
exactly one SENA_DEPOSIT CashMovement.

Noncash:
no fake CashMovement.

Fulfillment:

atomic conversion from SenaItem commitment to Sale/StockHold commitment.

No unheld window.
No double-held window.

Financial rule:

Sale.total =
applied SenaSettlement
+
accepted SalePayments

SenaPayment never duplicated into SalePayment.

No second CashMovement.

Applied SenaPayment methods participate in final pricing composition.

Mandatory idempotency tests.

--------------------------------------------------

PHASE 8 — EXCHANGE + PUBLICATION

Exchange:

Exchange
ExchangeItem

Original Sale immutable.

originalSaleItemId required.

Cumulative exchanged quantity cannot exceed sold quantity.

Returned acceptable merchandise enters receiving Location once.

Replacement exits once.

No:

EXCHANGE_OUT
+
SALE decrement

for same physical unit.

Same value allowed.
Higher value → pay difference.
Lower value prohibited V1.
Cross-location supported.

Publication:

PublicationCheckout
PublicationItem
PublicationResolution

Checkout:
onHand decreases once.

Resolution quantities:

checkedOutQty
returnedGoodQty
damagedResolvedQty
lostResolvedQty

GOOD:
onHand restores.

DAMAGED / LOSS:
external custody resolution only;
no second onHand decrement.

Support partial and mixed resolution.

--------------------------------------------------

PHASE 9 — LABELS + NOTIFICATIONS + REPORTS

Implement Day-25 labels:

approximately 70×37mm A4 adhesive

must visibly contain:

barcode
human-readable product code
description
variant SKU
color
size

Support reprint and quantity.

Advanced margins/gaps/start position according to requirement priority.

Notifications:

DB persisted authoritative Notification.

Socket.IO:
secondary realtime transport.

Reports baseline:

date
bank/origin institution
amount
aggregate total
XLSX/PDF where required

Include significant-event notification rules.

Avoid noisy normal-sale high-priority notifications.

--------------------------------------------------

PHASE 10 — FISCAL PROVIDER / ARCA + HARDENING

Implement:

FiscalProvider
ARCAProvider
FiscalOutbox
FiscalResult if defined in ERD

When fiscalization is required:

FiscalOutbox inserted in SAME DB transaction as authoritative Sale completion.

ARCA network call occurs AFTER commit via async worker.

Never fake CAE.

Day-25:
interface / safe stub according to approved scope.

Day 26–35:
real homologation if credentials/config available.

Also include:

security hardening
audit review
performance review
migration cleanup
legacy compatibility removal
production deployment checks
backup/restore validation

==================================================
FOR EACH PHASE
==================================================

For every phase include a structured section with:

1. Objective
2. Entities affected
3. Existing Demo V2 artifacts reused
4. Entities/components NEW
5. Entities/components ALTERED
6. Schema/migration work
7. Backend/domain work
8. Authorization/RBAC work
9. Frontend work
10. Concurrency/transaction requirements
11. Required tests
12. Data migration requirements
13. Dependencies
14. Explicitly OUT OF SCOPE
15. Exit criteria
16. Suggested commit boundary

==================================================
TEST STRATEGY
==================================================

Define test layers:

- unit tests
- domain/service tests
- integration tests
- DB/concurrency tests
- authorization tests
- migration tests
- E2E critical flows

Explicitly identify critical tests such as:

- two sellers race for last unit
- transfer cannot dispatch held merchandise
- partial transfer receipt keeps outstanding custody
- lost-in-transit doesn't double-decrement
- publication loss doesn't double-decrement
- SEÑA last-unit fulfillment succeeds
- expired SEÑA doesn't block sellable
- SEÑA CASH deposit creates exactly one CashMovement
- SEÑA settlement does not duplicate payment/cash
- mixed SEÑA/card payment uses listPrice
- global PRICE_MANAGE rejected for LOCATION-scoped ADMIN
- exchange cannot exchange same sold quantity twice
- exchange replacement decremented exactly once
- only one OPEN CashSession per register
- duplicate payment retry is idempotent
- DocumentCounter concurrent allocation doesn't duplicate numbers
- FiscalOutbox cannot be lost between Sale completion and worker

==================================================
MIGRATION STRATEGY
==================================================

Add a migration dependency graph.

Important existing Demo V2 concepts include:

Branch
UserBranchRole
Inventory.physical
Inventory.reserved
ProductVariant.barcode
Sale
SaleItem
SalePayment
CashSession
StockReservation

Document how each is migrated safely.

Prefer:

add
→ backfill
→ verify
→ switch reads/writes
→ remove/deprecate

instead of destructive one-step replacement.

==================================================
CLAUDE CODE EXECUTION MODEL
==================================================

The roadmap must be suitable for execution by Claude Code.

Each future implementation task should be small enough to fit one focused
development session.

Recommend subdivision within phases where necessary.

Example:

Phase 1A:
Company + Location schema/migration

Phase 1B:
UserRoleScope + permissions

Phase 1C:
authorization middleware + migration

Phase 1D:
tests + cleanup

Do not create implementation code now.

==================================================
DAY-25 PRIORITY
==================================================

Explicitly mark:

P0 — blocks operational Day 25
P1 — required for Production V1 but can follow core dependency
P2 — hardening / Day 26–35
FUTURE — not Production V1

Do NOT change MUST requirements.

Priority labels describe implementation sequencing, not business requirement
downgrades.

==================================================
ROADMAP SUMMARY
==================================================

At the beginning of the document provide a compact dependency chain:

Phase 0
→ Phase 1
→ Phase 2
→ Phase 3
→ Phase 4
→ Phase 5
→ Phase 6
→ Phase 7
→ Phase 8
→ Phase 9
→ Phase 10

If some phases can proceed in parallel after dependencies are met, explicitly
show that.

Also provide an estimated implementation risk:

LOW
MEDIUM
HIGH
VERY HIGH

for each phase.

Do NOT provide fake hour estimates.

==================================================
FINAL VERIFICATION
==================================================

After creating ONLY:

docs/production-v1/08-implementation-roadmap.md

run:

git diff --check
git status --short
git diff --name-only

Verify:

- only 08-implementation-roadmap.md is new/modified
- no application code changed
- no Prisma schema changed
- no migrations changed
- no tests changed
- nothing staged
- nothing committed
- nothing pushed

Final report:

BLOCK 3 IMPLEMENTATION ROADMAP READY FOR REVIEW

or

BLOCK 3 NOT READY

STOP.