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

### PHASE 0A — Baseline verification / environment
- **Objective**: verify the working Demo V2 baseline before any schema change.
- **Priority**: P0
- **Dependencies**: None
- **Entities affected**: all existing Demo V2 components.
- **Demo V2 reuse**: baseline build/test state.
- **NEW**: none; **ALTERED**: none.
- **Schema**: none.
- **Migration/backfill**: none.
- **Backend/domain**: baseline verification; environment/config review.
- **RBAC/security**: none.
- **Frontend**: none.
- **Transaction/concurrency**: none.
- **Required tests**: existing CI build, lint, typecheck pass.
- **Out of scope**: application code changes.
- **Exit criteria**: baseline is green and reproducible.
- **Commit boundary**: none.
- **Risk**: LOW

### PHASE 0B — Migration safety conventions
- **Objective**: define migration discipline before schema changes begin.
- **Priority**: P0
- **Dependencies**: 0A
- **Entities affected**: migration tooling/process.
- **Demo V2 reuse**: existing Prisma setup.
- **NEW**: migration conventions; **ALTERED**: none.
- **Schema**: none.
- **Migration/backfill**: ADD → BACKFILL → VERIFY → SWITCH → DEPRECATE → REMOVE (after validated compatibility window).
- **Backend/domain**: Prisma migration discipline; raw PostgreSQL strategy for CHECK constraints, partial unique indexes, NULLS NOT DISTINCT.
- **RBAC/security**: none.
- **Frontend**: none.
- **Transaction/concurrency**: no destructive one-shot migration.
- **Required tests**: migration convention review.
- **Out of scope**: actual schema changes.
- **Exit criteria**: migration strategy defined.
- **Commit boundary**: none.
- **Risk**: LOW

### PHASE 0C — Backup / rollback / seed strategy
- **Objective**: backup, rollback, and deterministic seed strategy.
- **Priority**: P0
- **Dependencies**: 0B
- **Entities affected**: data/backup/seed.
- **Demo V2 reuse**: existing seed data.
- **NEW**: backup/rollback scripts, seed strategy; **ALTERED**: none.
- **Schema**: none.
- **Migration/backfill**: none.
- **Backend/domain**: database backup/rollback strategy; deterministic seed strategy.
- **RBAC/security**: none.
- **Frontend**: none.
- **Transaction/concurrency**: none.
- **Required tests**: backup/restore and seed reproducibility.
- **Out of scope**: none.
- **Exit criteria**: backup/rollback/seed defined and validated.
- **Commit boundary**: none.
- **Risk**: LOW

### PHASE 0D — Production migration readiness check
- **Objective**: final readiness gate before schema changes.
- **Priority**: P0
- **Dependencies**: 0A–0C
- **Entities affected**: all.
- **Demo V2 reuse**: baseline.
- **NEW**: none; **ALTERED**: none.
- **Schema**: none.
- **Migration/backfill**: compatibility strategy while Branch is migrated toward Location; feature flags if required.
- **Backend/domain**: readiness checklist.
- **RBAC/security**: none.
- **Frontend**: none.
- **Transaction/concurrency**: none.
- **Required tests**: readiness verification.
- **Out of scope**: destructive migrations.
- **Exit criteria**: migration strategy defined, repository builds/tests clean, ready to begin schema changes.
- **Commit boundary**: readiness gate.
- **Risk**: LOW
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

### PHASE 1A — Company + Location schema
- **Objective**: create Company and Location with LocationType.
- **Priority**: P0
- **Dependencies**: PHASE 0
- **Entities affected**: Company, Location.
- **Demo V2 reuse**: Branch model.
- **NEW**: Company, Location; **ALTERED**: none.
- **Schema**: add Company, Location, LocationType (RETAIL_BRANCH | CENTRAL_WAREHOUSE).
- **Migration/backfill**: ADD → BACKFILL Branch → Location → VERIFY → SWITCH.
- **Backend/domain**: company/location services.
- **RBAC/security**: none.
- **Frontend**: none.
- **Transaction/concurrency**: none.
- **Required tests**: schema + backfill verification.
- **Out of scope**: role model (1B) and migration (1C).
- **Exit criteria**: Company/Location schema migrated.
- **Commit boundary**: company/location schema.
- **Risk**: MEDIUM

### PHASE 1B — Role / Permission / UserRoleScope
- **Objective**: production role model and scope model.
- **Priority**: P0
- **Dependencies**: 1A
- **Entities affected**: Role, Permission, RolePermission, UserRoleScope.
- **Demo V2 reuse**: none (new model).
- **NEW**: Role, Permission, RolePermission, UserRoleScope; **ALTERED**: none.
- **Schema**: add role/permission/scope tables; scopeKind LOCATION | COMPANY.
- **Migration/backfill**: none (new tables).
- **Backend/domain**: role model OWNER/ADMIN/CASHIER/SELLER/WAREHOUSE (no MANAGER); OWNER implicit company-wide; ADMIN permission + explicit scope, no implicit global; PRICE/catalog permissions require COMPANY scope.
- **RBAC/security**: DB CHECK: LOCATION → locationId required; COMPANY → locationId null.
- **Frontend**: none.
- **Transaction/concurrency**: none.
- **Required tests**: privilege escalation attempts rejected.
- **Out of scope**: authorization middleware (1D).
- **Exit criteria**: role/scope model + DB constraints.
- **Commit boundary**: role/permission/scope schema.
- **Risk**: MEDIUM

### PHASE 1C — Branch / UserBranchRole migration
- **Objective**: migrate Demo V2 Branch and UserBranchRole safely.
- **Priority**: P0
- **Dependencies**: 1B
- **Entities affected**: UserBranchRole, UserRoleScope.
- **Demo V2 reuse**: UserBranchRole data.
- **NEW**: UserRoleScope; **ALTERED**: none.
- **Schema**: ADD UserRoleScope.
- **Migration/backfill**: ADD UserRoleScope → BACKFILL from UserBranchRole → VERIFY permissions/scopes → SWITCH authorization reads/writes → DEPRECATE UserBranchRole → REMOVE only after validated compatibility window.
- **Backend/domain**: scoped authorization service.
- **RBAC/security**: scope-aware checks.
- **Frontend**: none.
- **Transaction/concurrency**: none.
- **Required tests**: migration + scope resolution tests.
- **Out of scope**: none.
- **Exit criteria**: UserRoleScope authoritative; legacy mapped without data loss.
- **Commit boundary**: user/branch migration.
- **Risk**: HIGH

### PHASE 1D — Authorization middleware/services
- **Objective**: backend-authoritative authorization.
- **Priority**: P0
- **Dependencies**: 1C
- **Entities affected**: auth middleware, guards.
- **Demo V2 reuse**: existing auth patterns.
- **NEW**: permission/scope guards; **ALTERED**: auth middleware.
- **Schema**: none.
- **Migration/backfill**: none.
- **Backend/domain**: permission + scope enforcement; branch scope enforced by backend.
- **RBAC/security**: explicit permission checks, not role-string checks.
- **Frontend**: none.
- **Transaction/concurrency**: none.
- **Required tests**: authorization unit/integration.
- **Out of scope**: none.
- **Exit criteria**: middleware enforces scope-aware permissions.
- **Commit boundary**: authorization middleware.
- **Risk**: MEDIUM

### PHASE 1E — RBAC / security tests
- **Objective**: prove RBAC correctness.
- **Priority**: P0
- **Dependencies**: 1A–1D
- **Entities affected**: all RBAC.
- **Demo V2 reuse**: migrated state.
- **NEW**: none; **ALTERED**: none.
- **Schema**: none.
- **Migration/backfill**: none.
- **Backend/domain**: none.
- **RBAC/security**: privilege escalation and scope tests.
- **Frontend**: none.
- **Transaction/concurrency**: none.
- **Required tests**: privilege escalation; LOCATION vs COMPANY scope enforcement.
- **Out of scope**: none.
- **Exit criteria**: RBAC test suite green.
- **Commit boundary**: RBAC test suite.
- **Risk**: LOW
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

### PHASE 2A — Product / catalog schema
- **Objective**: Introduce catalog entities and fields aligned to Production V1.
- **Priority**: P1
- **Dependencies**: PHASE 1
- **Entities affected**: Product, ProductVariant, Category, Brand.
- **Demo V2 reuse**: existing Product/ProductVariant/Category/Brand records.
- **NEW**: none; **ALTERED**: Product.barcode, soft-deactivation flags.
- **Schema**: add columns/enums required by ERD; DB CHECKs.
- **Migration/backfill**: ADD → BACKFILL → VERIFY → SWITCH → DEPRECATE.
- **Backend/domain**: catalog CRUD services; variant SKU uniqueness.
- **RBAC/security**: catalog mutations require PRODUCT_MANAGE with COMPANY scope.
- **Frontend**: catalog admin screens (phase-aligned).
- **Transaction/concurrency**: none beyond row locking.
- **Required tests**: catalog domain + RBAC tests.
- **Out of scope**: final SaleItem price freeze.
- **Exit criteria**: catalog schema migrates cleanly, uniqueness enforced.
- **Commit boundary**: schema + catalog service.
- **Risk**: MEDIUM

### PHASE 2B — Product barcode migration
- **Objective**: move authoritative barcode to Product.barcode safely.
- **Priority**: P1
- **Dependencies**: 2A
- **Entities affected**: Product, ProductVariant.
- **Demo V2 reuse**: ProductVariant.barcode values.
- **NEW**: canonical Product.barcode; **ALTERED**: Product.
- **Schema**: add Product.barcode.
- **Migration/backfill**: inspect single vs multiple legacy variant barcodes; choose canonical per policy; preserve legacy identifiers via approved fields; never silently discard.
- **Backend/domain**: barcode resolution service.
- **RBAC/security**: none.
- **Frontend**: none.
- **Transaction/concurrency**: row lock during canonical assignment.
- **Required tests**: one-barcode and multi-barcode legacy cases.
- **Out of scope**: inventing unapproved lookup table.
- **Exit criteria**: no identifier discarded; canonical barcode unique.
- **Commit boundary**: barcode migration + tests.
- **Risk**: HIGH

### PHASE 2C — Pricing model + global scope enforcement
- **Objective**: global pricing fields and COMPANY-scope enforcement.
- **Priority**: P1
- **Dependencies**: 2A
- **Entities affected**: Product.
- **Demo V2 reuse**: existing price fields.
- **NEW**: listPrice, cashDiscount, cashPrice, wholesalePrice, cost; **ALTERED**: Product.
- **Schema**: add price columns (integer minor units).
- **Migration/backfill**: backfill prices; verify; switch.
- **Backend/domain**: pricing service; PRICE_MANAGE permission.
- **RBAC/security**: PRICE_MANAGE = OWNER or ADMIN with COMPANY scope; LOCATION-scoped ADMIN rejected.
- **Frontend**: pricing admin.
- **Transaction/concurrency**: none.
- **Required tests**: LOCATION ADMIN cannot change global price/catalog.
- **Out of scope**: per-location pricing (FUTURE).
- **Exit criteria**: pricing globally scoped and enforced.
- **Commit boundary**: pricing + RBAC tests.
- **Risk**: MEDIUM

### PHASE 2D — ProductImage / color / size model
- **Objective**: support image metadata and color/size catalog.
- **Priority**: P1
- **Dependencies**: 2A
- **Entities affected**: ProductImage, Color, size.
- **Demo V2 reuse**: existing image/color/size references.
- **NEW**: ProductImage metadata, Color catalog, normalized size model; **ALTERED**: ProductVariant.
- **Schema**: add image/color/size tables.
- **Migration/backfill**: backfill references; verify.
- **Backend/domain**: media/attribute services.
- **RBAC/security**: none beyond catalog scope.
- **Frontend**: product form.
- **Transaction/concurrency**: none.
- **Required tests**: attribute model integrity.
- **Out of scope**: asset hosting.
- **Exit criteria**: color/size/image modeled and testable.
- **Commit boundary**: attribute model.
- **Risk**: LOW

### PHASE 2E — catalog/pricing migration + tests
- **Objective**: verify full catalog migration and run test matrix.
- **Priority**: P1
- **Dependencies**: 2A–2D
- **Entities affected**: all catalog entities.
- **Demo V2 reuse**: migrated data.
- **NEW**: none; **ALTERED**: none.
- **Schema**: none.
- **Migration/backfill**: reconciliation and verification.
- **Backend/domain**: migration scripts.
- **RBAC/security**: re-verify scopes.
- **Frontend**: none.
- **Transaction/concurrency**: none.
- **Required tests**: catalog migration + RBAC + uniqueness.
- **Out of scope**: none.
- **Exit criteria**: catalog fully migrated and tested.
- **Commit boundary**: final catalog test pass.
- **Risk**: LOW

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

### PHASE 3A — InventoryBalance migration
- **Objective**: migrate to InventoryBalance (ProductVariant × Location, onHand only).
- **Priority**: P0
- **Dependencies**: PHASE 1
- **Entities affected**: InventoryBalance.
- **Demo V2 reuse**: Inventory.physical.
- **NEW**: InventoryBalance; **ALTERED**: none.
- **Schema**: add InventoryBalance table.
- **Migration/backfill**: ADD → backfill onHand from Inventory.physical → VERIFY → SWITCH reads → DEPRECATE counter.
- **Backend/domain**: balance service; reconcile onHand = SUM(quantityDelta WHERE balanceEffect=ON_HAND).
- **RBAC/security**: none.
- **Frontend**: none.
- **Transaction/concurrency**: INITIAL_STOCK as a StockMovement; no initialOnHand baseline.
- **Required tests**: reconciliation counts.
- **Out of scope**: reserved/inTransit/temporarilyOut authoritative fields.
- **Exit criteria**: onHand authoritative and reconciled.
- **Commit boundary**: balance schema + backfill.
- **Risk**: HIGH

### PHASE 3B — StockMovement ledger
- **Objective**: append-only StockMovement with balanceEffect (ON_HAND/NONE).
- **Priority**: P0
- **Dependencies**: 3A
- **Entities affected**: StockMovement.
- **Demo V2 reuse**: none.
- **NEW**: StockMovement; **ALTERED**: none.
- **Schema**: add StockMovement ledger table.
- **Migration/backfill**: INITIAL_STOCK movements for all balances.
- **Backend/domain**: movement service; ledger reconciliation.
- **RBAC/security**: none.
- **Frontend**: none.
- **Transaction/concurrency**: append-only, row locking.
- **Required tests**: ledger reconciliation equals onHand.
- **Out of scope**: none.
- **Exit criteria**: ledger authoritative source.
- **Commit boundary**: ledger service + reconciliation tests.
- **Risk**: MEDIUM

### PHASE 3C — StockHold + effectiveSellable
- **Objective**: technical StockHold and effective sellable calculation.
- **Priority**: P0
- **Dependencies**: 3B
- **Entities affected**: StockHold.
- **Demo V2 reuse**: Inventory.reserved, StockReservation.
- **NEW**: StockHold; **ALTERED**: none.
- **Schema**: add StockHold with status/expiresAt.
- **Migration/backfill**: reconcile Inventory.reserved/StockReservation into StockHold; verify active status.
- **Backend/domain**: effectiveSellable = onHand - effective active StockHold - effective active SenaItem.
- **RBAC/security**: none.
- **Frontend**: none.
- **Transaction/concurrency**: effective active = ACTIVE AND expiresAt > now().
- **Required tests**: hold/expiry affects sellable correctly.
- **Out of scope**: SenaItem until Phase 7.
- **Exit criteria**: holds structurally correct.
- **Commit boundary**: StockHold + effectiveSellable.
- **Risk**: HIGH

### PHASE 3D — Locking / deterministic ordering
- **Objective**: concurrency-safe inventory mutations.
- **Priority**: P0
- **Dependencies**: 3C
- **Entities affected**: InventoryBalance, StockMovement.
- **Demo V2 reuse**: none.
- **NEW**: none; **ALTERED**: inventory services.
- **Schema**: none.
- **Migration/backfill**: none.
- **Backend/domain**: SELECT...FOR UPDATE in Prisma transactions; deterministic lock ordering.
- **RBAC/security**: none.
- **Frontend**: none.
- **Transaction/concurrency**: row locking, no negative stock.
- **Required tests**: mandatory concurrency tests.
- **Out of scope**: none.
- **Exit criteria**: two-seller race for last unit resolved.
- **Commit boundary**: locking hardening.
- **Risk**: VERY HIGH

### PHASE 3E — Reconciliation + concurrency tests
- **Objective**: prove inventory invariants under concurrency.
- **Priority**: P0
- **Dependencies**: 3A–3D
- **Entities affected**: all inventory entities.
- **Demo V2 reuse**: migrated state.
- **NEW**: none; **ALTERED**: none.
- **Schema**: none.
- **Migration/backfill**: none.
- **Backend/domain**: none.
- **RBAC/security**: none.
- **Frontend**: none.
- **Transaction/concurrency**: full concurrency test suite.
- **Required tests**: reconciliation, two-seller race, no negative stock.
- **Out of scope**: none.
- **Exit criteria**: all inventory concurrency tests pass.
- **Commit boundary**: inventory test suite.
- **Risk**: HIGH

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

### PHASE 4A — Customer + Supplier
- **Objective**: customer and supplier master data.
- **Priority**: P1
- **Dependencies**: PHASE 1
- **Entities affected**: Customer, Supplier, SupplierProduct.
- **Demo V2 reuse**: existing contact/customer references where present.
- **NEW**: Customer, Supplier; **ALTERED**: none.
- **Schema**: add customer/supplier tables.
- **Migration/backfill**: backfill existing records.
- **Backend/domain**: CRUD services.
- **RBAC/security**: scope-checked.
- **Frontend**: admin forms.
- **Transaction/concurrency**: none.
- **Required tests**: domain CRUD.
- **Out of scope**: none.
- **Exit criteria**: customer/supplier created.
- **Commit boundary**: customer/supplier schema + service.
- **Risk**: LOW

### PHASE 4B — GoodsReceipt schema/domain
- **Objective**: goods-receipt entity with DRAFT/IN_PROGRESS/COMPLETED.
- **Priority**: P1
- **Dependencies**: 4A
- **Entities affected**: GoodsReceipt, GoodsReceiptItem, GoodsReceiptAttachment.
- **Demo V2 reuse**: none.
- **NEW**: GoodsReceipt, GoodsReceiptItem, GoodsReceiptAttachment; **ALTERED**: none.
- **Schema**: add goods-receipt tables.
- **Migration/backfill**: none (new entity).
- **Backend/domain**: receipt service; DRAFT/IN_PROGRESS do not mutate stock.
- **RBAC/security**: receipt permissions.
- **Frontend**: receipt forms.
- **Transaction/concurrency**: no stock mutation pre-COMPLETED.
- **Required tests**: DRAFT no stock change.
- **Out of scope**: none.
- **Exit criteria**: receipt lifecycle created.
- **Commit boundary**: GoodsReceipt schema + service.
- **Risk**: MEDIUM

### PHASE 4C — GoodsReceipt completion → inventory
- **Objective**: atomic COMPLETED receipt updates inventory.
- **Priority**: P1
- **Dependencies**: 4B, PHASE 3
- **Entities affected**: GoodsReceipt, InventoryBalance, StockMovement.
- **Demo V2 reuse**: none.
- **NEW**: none; **ALTERED**: receipt completion.
- **Schema**: none.
- **Migration/backfill**: none.
- **Backend/domain**: atomic completion: onHand += receivedQuantity, StockMovement GOODS_RECEIPT, receipt immutable.
- **RBAC/security**: scope check.
- **Frontend**: completion action.
- **Transaction/concurrency**: atomic; row locked.
- **Required tests**: receipt completion exact onHand change.
- **Out of scope**: none.
- **Exit criteria**: completion atomic and idempotent.
- **Commit boundary**: receipt completion transaction.
- **Risk**: MEDIUM

### PHASE 4D — Initial CSV/XLSX import foundation
- **Objective**: Day-25 import foundation.
- **Priority**: P0
- **Dependencies**: 4B
- **Entities affected**: Product, ProductVariant, InventoryBalance, StockMovement.
- **Demo V2 reuse**: none.
- **NEW**: import mapping/validation/preview; **ALTERED**: none.
- **Schema**: none.
- **Migration/backfill**: none.
- **Backend/domain**: column mapping, validation, preview, row-level errors, explicit confirmation, audited INITIAL_STOCK movements.
- **RBAC/security**: import requires appropriate scope.
- **Frontend**: import wizard (upload, preview, confirm, errors).
- **Transaction/concurrency**: INITIAL_STOCK movements auditable.
- **Required tests**: mapping, validation, row errors, INITIAL_STOCK audit.
- **Out of scope**: final migration tooling beyond Day-25.
- **Exit criteria**: import foundation satisfies FR-IMPORT-001.
- **Commit boundary**: import foundation.
- **Risk**: HIGH

### PHASE 4E — Migration/integration tests
- **Objective**: validate Phase 4 integration.
- **Priority**: P1
- **Dependencies**: 4A–4D
- **Entities affected**: all Phase 4 entities.
- **Demo V2 reuse**: migrated data.
- **NEW**: none; **ALTERED**: none.
- **Schema**: none.
- **Migration/backfill**: none.
- **Backend/domain**: integration test coverage.
- **RBAC/security**: re-verify scopes.
- **Frontend**: none.
- **Transaction/concurrency**: none.
- **Required tests**: integration + migration tests.
- **Out of scope**: none.
- **Exit criteria**: Phase 4 integration verified.
- **Commit boundary**: Phase 4 test pass.
- **Risk**: LOW

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

### PHASE 5A — StockTransfer / TransferItem schema
- **Objective**: transfer entities and numbering.
- **Priority**: P1
- **Dependencies**: PHASE 3
- **Entities affected**: StockTransfer, TransferItem.
- **Demo V2 reuse**: none.
- **NEW**: StockTransfer, TransferItem; **ALTERED**: none.
- **Schema**: add transfer tables + quantity fields (requested/approved/dispatched/received/returned/lost).
- **Migration/backfill**: none (new entity).
- **Backend/domain**: transfer service.
- **RBAC/security**: origin/destination scope checks.
- **Frontend**: transfer UI.
- **Transaction/concurrency**: none yet.
- **Required tests**: transfer CRUD.
- **Out of scope**: none.
- **Exit criteria**: transfer schema created.
- **Commit boundary**: transfer schema.
- **Risk**: MEDIUM

### PHASE 5B — Request / approve / prepare
- **Objective**: transfer request→approve→prepare workflow.
- **Priority**: P1
- **Dependencies**: 5A
- **Entities affected**: StockTransfer, TransferItem.
- **Demo V2 reuse**: none.
- **NEW**: none; **ALTERED**: state transitions.
- **Schema**: none.
- **Migration/backfill**: none.
- **Backend/domain**: approve and prepare services.
- **RBAC/security**: approve permissions.
- **Frontend**: approve/prepare screens.
- **Transaction/concurrency**: none.
- **Required tests**: state transitions.
- **Out of scope**: none.
- **Exit criteria**: workflow stages implemented.
- **Commit boundary**: request/approve/prepare.
- **Risk**: LOW

### PHASE 5C — Dispatch
- **Objective**: dispatch decrements origin onHand once, validates effectiveSellable.
- **Priority**: P1
- **Dependencies**: 5B, PHASE 3
- **Entities affected**: InventoryBalance, StockMovement, TransferItem.
- **Demo V2 reuse**: none.
- **NEW**: none; **ALTERED**: dispatch service.
- **Schema**: none.
- **Migration/backfill**: none.
- **Backend/domain**: validate effectiveSellable before onHand decrement; origin decreases once.
- **RBAC/security**: dispatch scope.
- **Frontend**: dispatch action.
- **Transaction/concurrency**: row locked; cannot dispatch held merchandise.
- **Required tests**: dispatch cannot dispatch held units; single decrement.
- **Out of scope**: none.
- **Exit criteria**: dispatch atomic.
- **Commit boundary**: dispatch transaction.
- **Risk**: HIGH

### PHASE 5D — Receive
- **Objective**: receive increments destination onHand with actual received once.
- **Priority**: P1
- **Dependencies**: 5C
- **Entities affected**: InventoryBalance, StockMovement, TransferItem.
- **Demo V2 reuse**: none.
- **NEW**: none; **ALTERED**: receive service.
- **Schema**: none.
- **Migration/backfill**: none.
- **Backend/domain**: record receivedQty; destination increments actual received once.
- **RBAC/security**: receive scope.
- **Frontend**: receive action.
- **Transaction/concurrency**: row locked; invariant received+returned+lost <= dispatched.
- **Required tests**: partial receipt preserves outstandingTransit.
- **Out of scope**: none.
- **Exit criteria**: receive atomic.
- **Commit boundary**: receive transaction.
- **Risk**: HIGH

### PHASE 5E — TransferResolution / discrepancy handling
- **Objective**: resolve discrepancies (returned/lost/partial).
- **Priority**: P0 (minimal discrepancy resolution is Day-25 MUST)
- **Dependencies**: 5D
- **Entities affected**: TransferResolution, TransferItem.
- **Demo V2 reuse**: none.
- **NEW**: TransferResolution; **ALTERED**: TransferItem.
- **Schema**: add resolution table.
- **Migration/backfill**: none.
- **Backend/domain**: LOST_IN_TRANSIT = external custody only, no second origin decrement; returned/lost reconcile outstandingTransit.
- **RBAC/security**: resolution permissions.
- **Frontend**: discrepancy UI.
- **Transaction/concurrency**: invariant received+returned+lost <= dispatched.
- **Required tests**: LOST_IN_TRANSIT no double-decrement.
- **Out of scope**: advanced loss policy.
- **Exit criteria**: minimal discrepancy resolution works.
- **Commit boundary**: resolution service.
- **Risk**: HIGH

### PHASE 5F — Remito / numbering
- **Objective**: transfer numbering/remito.
- **Priority**: P1
- **Dependencies**: 5A
- **Entities affected**: DocumentCounter, StockTransfer.
- **Demo V2 reuse**: existing numbering.
- **NEW**: none; **ALTERED**: transfer numbering.
- **Schema**: none.
- **Migration/backfill**: none.
- **Backend/domain**: concurrency-safe numbering.
- **RBAC/security**: none.
- **Frontend**: none.
- **Transaction/concurrency**: numbering concurrency-safe.
- **Required tests**: no duplicate transfer numbers.
- **Out of scope**: none.
- **Exit criteria**: remito numbering safe.
- **Commit boundary**: numbering.
- **Risk**: MEDIUM

### PHASE 5G — Concurrency + idempotency tests
- **Objective**: prove transfer invariants.
- **Priority**: P1
- **Dependencies**: 5A–5F
- **Entities affected**: all transfer entities.
- **Demo V2 reuse**: none.
- **NEW**: none; **ALTERED**: none.
- **Schema**: none.
- **Migration/backfill**: none.
- **Backend/domain**: none.
- **RBAC/security**: none.
- **Frontend**: none.
- **Transaction/concurrency**: row-locking/idempotency tests.
- **Required tests**: dispatch held, partial receipt, LOST no double-decrement, numbering.
- **Out of scope**: none.
- **Exit criteria**: transfer concurrency tests pass.
- **Commit boundary**: transfer test suite.
- **Risk**: HIGH

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

### PHASE 6A — Sale / SaleItem migration
- **Objective**: migrate existing Sale/SaleItem safely, preserving history.
- **Priority**: P0
- **Dependencies**: PHASE 3
- **Entities affected**: Sale, SaleItem.
- **Demo V2 reuse**: existing Sale/SaleItem/SalePayment.
- **NEW**: none; **ALTERED**: Sale/SaleItem.
- **Schema**: ALTER incrementally, preserve all historical records.
- **Migration/backfill**: ADD → BACKFILL → VERIFY → SWITCH → DEPRECATE.
- **Backend/domain**: sale aggregate service.
- **RBAC/security**: sale creation permissions.
- **Frontend**: POS cart.
- **Transaction/concurrency**: none yet.
- **Required tests**: historical preservation.
- **Out of scope**: final pricing freeze.
- **Exit criteria**: Sale/SaleItem migrated with history intact.
- **Commit boundary**: Sale migration.
- **Risk**: MEDIUM

### PHASE 6B — Seller → cashier + technical StockHold
- **Objective**: seller→cashier flow with technical StockHold on send-to-cashier.
- **Priority**: P0
- **Dependencies**: 6A, PHASE 3
- **Entities affected**: Sale, StockHold.
- **Demo V2 reuse**: seller→cashier flow.
- **NEW**: none; **ALTERED**: send-to-cashier.
- **Schema**: none.
- **Migration/backfill**: none.
- **Backend/domain**: create technical StockHold when sending to cashier.
- **RBAC/security**: SELLER can send; CASHIER can charge.
- **Frontend**: POS send-to-cashier.
- **Transaction/concurrency**: hold created atomically.
- **Required tests**: hold created on send-to-cashier.
- **Out of scope**: none.
- **Exit criteria**: seller→cashier handoff with hold.
- **Commit boundary**: handoff + hold.
- **Risk**: MEDIUM

### PHASE 6C — SalePayment / split payments
- **Objective**: split payment collection (CASH/TRANSFER/CARD/QR).
- **Priority**: P0
- **Dependencies**: 6A
- **Entities affected**: SalePayment.
- **Demo V2 reuse**: existing SalePayment.
- **NEW**: none; **ALTERED**: SalePayment with transfer institution metadata and card installments.
- **Schema**: add payment fields + transfer origin (MACRO/BBVA/NACION/GALICIA/MERCADO_PAGO/OTHER).
- **Migration/backfill**: preserve payment history.
- **Backend/domain**: payment service; idempotency key.
- **RBAC/security**: CASHIER can charge.
- **Frontend**: split-payment UI.
- **Transaction/concurrency**: payment idempotent.
- **Required tests**: split payment; duplicate retry idempotent.
- **Out of scope**: none.
- **Exit criteria**: split payments work; no double-apply.
- **Commit boundary**: split payments.
- **Risk**: HIGH

### PHASE 6D — Authoritative pricing finalization
- **Objective**: freeze SaleItem monetary snapshot by payment composition.
- **Priority**: P0
- **Dependencies**: 6C, PHASE 2
- **Entities affected**: SaleItem, SalePayment.
- **Demo V2 reuse**: none.
- **NEW**: none; **ALTERED**: pricing finalization.
- **Schema**: candidate pricing on PENDING; final snapshot after composition known.
- **Migration/backfill**: none.
- **Backend/domain**: CONSUMER_FINAL (100% CASH/TRANSFER → cashPrice; ANY card/QR → listPrice; TRANSFER remains eligible even MERCADO_PAGO); WHOLESALE → wholesalePrice.
- **RBAC/security**: none.
- **Frontend**: none.
- **Transaction/concurrency**: integer minor units; no floating-point.
- **Required tests**: CASH+TRANSFER → cashPrice; CASH SEÑA + CARD → listPrice.
- **Out of scope**: per-location pricing (FUTURE).
- **Exit criteria**: final price frozen exactly once.
- **Commit boundary**: pricing finalization.
- **Risk**: HIGH

### PHASE 6E — CashRegister / CashSession / CashMovement
- **Objective**: cash handling model.
- **Priority**: P0
- **Dependencies**: 6C
- **Entities affected**: CashRegister, CashSession, CashMovement.
- **Demo V2 reuse**: existing CashSession.
- **NEW**: CashRegister; **ALTERED**: CashSession (add cashRegisterId, financial fields).
- **Schema**: ADD CashRegister; ADD CashSession.cashRegisterId + new fields; backfill; verify; switch; deprecate obsolete branch-only semantics.
- **Migration/backfill**: backfill register assignment.
- **Backend/domain**: open/close sessions; CASH payments bind to OPEN session; one OPEN per register.
- **RBAC/security**: CASHIER can open/close.
- **Frontend**: cash session UI.
- **Transaction/concurrency**: one OPEN CashSession per register.
- **Required tests**: one OPEN per register; no double movement.
- **Out of scope**: none.
- **Exit criteria**: cash model works.
- **Commit boundary**: cash model.
- **Risk**: HIGH

### PHASE 6F — DocumentCounter concurrency
- **Objective**: concurrency-safe document numbering.
- **Priority**: P0
- **Dependencies**: 6A
- **Entities affected**: DocumentCounter.
- **Demo V2 reuse**: existing counter.
- **NEW**: none; **ALTERED**: numbering allocation.
- **Schema**: none.
- **Migration/backfill**: none.
- **Backend/domain**: atomic counter allocation.
- **RBAC/security**: none.
- **Frontend**: none.
- **Transaction/concurrency**: concurrent allocation cannot duplicate.
- **Required tests**: concurrent DocumentCounter allocation.
- **Out of scope**: none.
- **Exit criteria**: unique numbers under concurrency.
- **Commit boundary**: counter service.
- **Risk**: MEDIUM

### PHASE 6G — POS integration / E2E
- **Objective**: end-to-end POS flow.
- **Priority**: P0
- **Dependencies**: 6A–6F
- **Entities affected**: all POS entities.
- **Demo V2 reuse**: migrated state.
- **NEW**: none; **ALTERED**: none.
- **Schema**: none.
- **Migration/backfill**: none.
- **Backend/domain**: atomic completion (payments validated, holds consumed, onHand decrement once, StockMovement SALE, cash movements, numbering, audit/outbox).
- **RBAC/security**: full role checks.
- **Frontend**: POS E2E.
- **Transaction/concurrency**: atomic sale completion.
- **Required tests**: E2E critical path; duplicate completion no double deduction.
- **Out of scope**: none.
- **Exit criteria**: POS E2E passes.
- **Commit boundary**: POS E2E.
- **Risk**: VERY HIGH

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

### PHASE 7A — CommercialSena / SenaItem
- **Objective**: commercial SEÑA logical commitment entity.
- **Priority**: P1
- **Dependencies**: PHASE 3
- **Entities affected**: CommercialSena, SenaItem.
- **Demo V2 reuse**: none.
- **NEW**: CommercialSena, SenaItem; **ALTERED**: none.
- **Schema**: add SEÑA tables; V1 expiry fixed 24 hours.
- **Migration/backfill**: none.
- **Backend/domain**: SEÑA creation; logical commitment only, no physical StockMovement.
- **RBAC/security**: SEÑA permissions.
- **Frontend**: SEÑA UI.
- **Transaction/concurrency**: logical commitment.
- **Required tests**: SEÑA creation/expiry no stock change.
- **Out of scope**: configurable duration (P2/FUTURE).
- **Exit criteria**: SEÑA logical model works.
- **Commit boundary**: SEÑA schema + service.
- **Risk**: MEDIUM

### PHASE 7B — SenaPayment + SENA_DEPOSIT
- **Objective**: SEÑA payments and cash deposit.
- **Priority**: P1
- **Dependencies**: 7A, PHASE 6
- **Entities affected**: SenaPayment, CashMovement.
- **Demo V2 reuse**: none.
- **NEW**: SenaPayment; **ALTERED**: none.
- **Schema**: add SenaPayment.
- **Migration/backfill**: none.
- **Backend/domain**: CASH SenaPayment → exactly one SENA_DEPOSIT CashMovement; noncash → no CashMovement.
- **RBAC/security**: CASHIER.
- **Frontend**: SEÑA payment.
- **Transaction/concurrency**: idempotent.
- **Required tests**: CASH SenaPayment creates exactly one SENA_DEPOSIT.
- **Out of scope**: none.
- **Exit criteria**: deposit correct.
- **Commit boundary**: SenaPayment + CashMovement.
- **Risk**: MEDIUM

### PHASE 7C — SenaSettlement financial application
- **Objective**: apply SEÑA deposit to sale without duplication.
- **Priority**: P1
- **Dependencies**: 7B
- **Entities affected**: SenaSettlement, Sale, SalePayment.
- **Demo V2 reuse**: none.
- **NEW**: SenaSettlement; **ALTERED**: none.
- **Schema**: add SenaSettlement.
- **Migration/backfill**: none.
- **Backend/domain**: financial invariant Sale.total = SUM(valid applied SenaSettlement.totalDepositApplied) + SUM(accepted SalePayment.amount); never duplicate SenaPayment into SalePayment; no second CashMovement.
- **RBAC/security**: CASHIER.
- **Frontend**: settlement.
- **Transaction/concurrency**: idempotent.
- **Required tests**: no duplicate SalePayment; no second CashMovement.
- **Out of scope**: none.
- **Exit criteria**: financial invariant holds.
- **Commit boundary**: SenaSettlement.
- **Risk**: HIGH

### PHASE 7D — Atomic SEÑA→Sale/StockHold handoff
- **Objective**: atomic logical→held conversion.
- **Priority**: P1
- **Dependencies**: 7C, PHASE 6
- **Entities affected**: SenaItem, Sale, StockHold.
- **Demo V2 reuse**: none.
- **NEW**: none; **ALTERED**: handoff logic.
- **Schema**: none.
- **Migration/backfill**: none.
- **Backend/domain**: preserve own entitlement; exclude own SenaItem from other commitments; atomic replacement; no unheld window; no double-held window; no StockMovement for logical hold conversion.
- **RBAC/security**: none.
- **Frontend**: none.
- **Transaction/concurrency**: atomic handoff.
- **Required tests**: own-entitlement fulfillment when general sellable = 0.
- **Out of scope**: none.
- **Exit criteria**: atomic handoff.
- **Commit boundary**: handoff transaction.
- **Risk**: VERY HIGH

### PHASE 7E — Expiry / idempotency / concurrency tests
- **Objective**: prove SEÑA invariants.
- **Priority**: P1
- **Dependencies**: 7A–7D
- **Entities affected**: all SEÑA entities.
- **Demo V2 reuse**: none.
- **NEW**: none; **ALTERED**: none.
- **Schema**: none.
- **Migration/backfill**: none.
- **Backend/domain**: none.
- **RBAC/security**: none.
- **Frontend**: none.
- **Transaction/concurrency**: expiry, idempotency, concurrency tests.
- **Required tests**: expired SEÑA excluded from sellable; own-entitlement; one SENA_DEPOSIT; no duplicate payment/movement; CASH SEÑA + CARD → listPrice; CASH SEÑA + TRANSFER → cashPrice.
- **Out of scope**: none.
- **Exit criteria**: SEÑA test matrix passes.
- **Commit boundary**: SEÑA test suite.
- **Risk**: HIGH

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

### PHASE 8A — Exchange schema/domain
- **Objective**: exchange entity linked to original sale.
- **Priority**: P1
- **Dependencies**: PHASE 6
- **Entities affected**: Exchange, ExchangeItem.
- **Demo V2 reuse**: none.
- **NEW**: Exchange, ExchangeItem; **ALTERED**: none.
- **Schema**: add exchange tables; originalSaleItemId required.
- **Migration/backfill**: none.
- **Backend/domain**: exchange service; original Sale immutable.
- **RBAC/security**: exchange permissions.
- **Frontend**: exchange UI.
- **Transaction/concurrency**: cumulative exchanged qty <= sold qty.
- **Required tests**: exchange cannot exceed originalSaleItem.quantity.
- **Out of scope**: lower-value exchange (prohibited V1).
- **Exit criteria**: exchange schema + rules.
- **Commit boundary**: exchange schema.
- **Risk**: MEDIUM

### PHASE 8B — Exchange single inventory writer
- **Objective**: exchange inventory flow without double decrement.
- **Priority**: P1
- **Dependencies**: 8A, PHASE 3
- **Entities affected**: InventoryBalance, StockMovement, ExchangeItem.
- **Demo V2 reuse**: none.
- **NEW**: none; **ALTERED**: exchange inventory.
- **Schema**: none.
- **Migration/backfill**: none.
- **Backend/domain**: accepted return enters receiving Location once; replacement exits once; no EXCHANGE_OUT + SALE double decrement; same value allowed; higher value → pay difference; cross-location supported.
- **RBAC/security**: exchange scope.
- **Frontend**: exchange actions.
- **Transaction/concurrency**: single inventory writer.
- **Required tests**: exchange replacement decremented exactly once.
- **Out of scope**: lower value (V1 prohibited).
- **Exit criteria**: single-writer flow correct.
- **Commit boundary**: exchange inventory.
- **Risk**: VERY HIGH

### PHASE 8C — PublicationCheckout / PublicationItem
- **Objective**: publication custody checkout.
- **Priority**: P1
- **Dependencies**: PHASE 3
- **Entities affected**: PublicationCheckout, PublicationItem.
- **Demo V2 reuse**: none.
- **NEW**: PublicationCheckout, PublicationItem; **ALTERED**: none.
- **Schema**: add checkout tables; checkedOutQty.
- **Migration/backfill**: none.
- **Backend/domain**: checkout decrements onHand once; validates effectiveSellable.
- **RBAC/security**: publication permissions.
- **Frontend**: checkout UI.
- **Transaction/concurrency**: single decrement.
- **Required tests**: publication checkout single decrement.
- **Out of scope**: none.
- **Exit criteria**: checkout works.
- **Commit boundary**: publication checkout.
- **Risk**: MEDIUM

### PHASE 8D — PublicationResolution
- **Objective**: resolve publication custody (return/damage/loss).
- **Priority**: P1
- **Dependencies**: 8C
- **Entities affected**: PublicationResolution, PublicationItem.
- **Demo V2 reuse**: none.
- **NEW**: PublicationResolution; **ALTERED**: PublicationItem.
- **Schema**: add resolution table with returnedGoodQty/damagedResolvedQty/lostResolvedQty.
- **Migration/backfill**: none.
- **Backend/domain**: GOOD → onHand restored; DAMAGED/LOSS → external custody only, no second onHand decrement; partial/mixed resolution.
- **RBAC/security**: resolution permissions.
- **Frontend**: resolution UI.
- **Transaction/concurrency**: invariant returned+damaged+lost <= checkedOut.
- **Required tests**: publication LOSS/DAMAGE no double-decrement.
- **Out of scope**: none.
- **Exit criteria**: resolution correct.
- **Commit boundary**: publication resolution.
- **Risk**: HIGH

### PHASE 8E — Custody / concurrency tests
- **Objective**: prove exchange + publication invariants.
- **Priority**: P1
- **Dependencies**: 8A–8D
- **Entities affected**: all exchange/publication entities.
- **Demo V2 reuse**: none.
- **NEW**: none; **ALTERED**: none.
- **Schema**: none.
- **Migration/backfill**: none.
- **Backend/domain**: none.
- **RBAC/security**: none.
- **Frontend**: none.
- **Transaction/concurrency**: concurrency + partial-resolution tests.
- **Required tests**: exchange qty bound; replacement single decrement; publication no double-decrement.
- **Out of scope**: none.
- **Exit criteria**: exchange/publication tests pass.
- **Commit boundary**: custody test suite.
- **Risk**: HIGH

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

### PHASE 9A — Labels
- **Objective**: Day-25 label printing.
- **Priority**: P1
- **Dependencies**: PHASE 2
- **Entities affected**: Product, ProductVariant.
- **Demo V2 reuse**: none.
- **NEW**: label rendering; **ALTERED**: none.
- **Schema**: none.
- **Migration/backfill**: none.
- **Backend/domain**: label generation (Code128 barcode, human-readable product code, description, variant SKU, color, size).
- **RBAC/security**: label permission.
- **Frontend**: label print UI (reprint, quantity).
- **Transaction/concurrency**: none.
- **Required tests**: label content.
- **Out of scope**: advanced margins/gaps per requirement priority.
- **Exit criteria**: ~70×37mm A4 labels printable.
- **Commit boundary**: label feature.
- **Risk**: LOW

### PHASE 9B — Notification persistence
- **Objective**: authoritative DB-persisted notifications.
- **Priority**: P1
- **Dependencies**: PHASE 6
- **Entities affected**: Notification.
- **Demo V2 reuse**: none.
- **NEW**: Notification; **ALTERED**: none.
- **Schema**: add notification table.
- **Migration/backfill**: none.
- **Backend/domain**: notification service; significant-event rules; avoid noisy normal-sale high-priority notifications.
- **RBAC/security**: notification scope.
- **Frontend**: notification list.
- **Transaction/concurrency**: none.
- **Required tests**: notification persistence.
- **Out of scope**: none.
- **Exit criteria**: DB is authoritative.
- **Commit boundary**: notification persistence.
- **Risk**: LOW

### PHASE 9C — Socket.IO realtime integration
- **Objective**: secondary realtime transport.
- **Priority**: P1
- **Dependencies**: 9B
- **Entities affected**: Notification.
- **Demo V2 reuse**: Socket.IO patterns.
- **NEW**: none; **ALTERED**: notification transport.
- **Schema**: none.
- **Migration/backfill**: none.
- **Backend/domain**: Socket.IO emits after DB persistence; no direct frontend-to-DB authorization path.
- **RBAC/security**: auth on socket.
- **Frontend**: realtime client.
- **Transaction/concurrency**: realtime is notification, DB is source of truth.
- **Required tests**: realtime event delivery.
- **Out of scope**: none.
- **Exit criteria**: realtime transport works, DB authoritative.
- **Commit boundary**: realtime integration.
- **Risk**: MEDIUM

### PHASE 9D — Reports / XLSX / PDF
- **Objective**: baseline reports.
- **Priority**: P1
- **Dependencies**: PHASE 6
- **Entities affected**: Sale, SalePayment.
- **Demo V2 reuse**: none.
- **NEW**: report generation; **ALTERED**: none.
- **Schema**: none.
- **Migration/backfill**: none.
- **Backend/domain**: reports by date, bank/origin institution, amount, aggregate total; XLSX/PDF where required.
- **RBAC/security**: report permissions.
- **Frontend**: report UI.
- **Transaction/concurrency**: none.
- **Required tests**: report totals.
- **Out of scope**: advanced reporting.
- **Exit criteria**: baseline reports generate.
- **Commit boundary**: reports.
- **Risk**: LOW

### PHASE 9E — Integration tests
- **Objective**: validate Phase 9.
- **Priority**: P1
- **Dependencies**: 9A–9D
- **Entities affected**: all Phase 9 entities.
- **Demo V2 reuse**: none.
- **NEW**: none; **ALTERED**: none.
- **Schema**: none.
- **Migration/backfill**: none.
- **Backend/domain**: none.
- **RBAC/security**: re-verify.
- **Frontend**: none.
- **Transaction/concurrency**: none.
- **Required tests**: integration tests.
- **Out of scope**: none.
- **Exit criteria**: Phase 9 integration verified.
- **Commit boundary**: Phase 9 test pass.
- **Risk**: LOW

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

### PHASE 10A — FiscalProvider + FiscalOutbox boundary
- **Objective**: establish a safe fiscal boundary where Sale completion and FiscalOutbox are written atomically.
- **Priority**: P1 (Production V1 capability)
- **Dependencies**: PHASE 6
- **Entities affected**: FiscalProvider, FiscalOutbox, FiscalResult (if defined in ERD).
- **Demo V2 reuse**: none.
- **NEW**: FiscalProvider, FiscalOutbox; **ALTERED**: none.
- **Schema**: add fiscal provider + outbox tables; outbox status/result fields.
- **Migration/backfill**: none (new entities).
- **Backend/domain**: FiscalOutbox INSERT occurs in the SAME DB transaction as authoritative Sale completion; COMMIT first; async worker runs AFTER commit; ARCA network call never inside the Sale transaction; never fake CAE.
- **RBAC/security**: fiscal boundary permissions; no direct frontend fiscal path.
- **Frontend**: none.
- **Transaction/concurrency**: FiscalOutbox must be durable and cannot be lost between Sale completion and worker.
- **Required tests**: outbox durability; outbox written in same transaction; no ARCA call inside Sale transaction.
- **Out of scope**: real ARCA homologation (P2).
- **Exit criteria**: safe provider/stub boundary per approved scope; outbox persisted atomically.
- **Commit boundary**: fiscal boundary + outbox transaction.
- **Risk**: HIGH

### PHASE 10B — ARCA async worker/provider
- **Objective**: implement the async fiscal worker/provider integration.
- **Priority**: P2 (Day 26–35 homologation when credentials/config available)
- **Dependencies**: 10A
- **Entities affected**: ARCAProvider, FiscalOutbox, FiscalResult.
- **Demo V2 reuse**: none.
- **NEW**: ARCAProvider; **ALTERED**: outbox worker.
- **Schema**: add fiscal result/status fields.
- **Migration/backfill**: none.
- **Backend/domain**: FiscalProvider interface; ARCAProvider; async FiscalOutbox worker; retry/idempotency; persisted fiscal result/status; provider failure isolation. Worker failure must not corrupt Sale/Payment/Cash/Inventory.
- **RBAC/security**: none.
- **Frontend**: none.
- **Transaction/concurrency**: ARCA work is asynchronous post-commit; never synchronous financial mutation.
- **Required tests**: outbox not lost; worker retry idempotency; failure isolation from core state.
- **Out of scope**: production homologation outside approved scope.
- **Exit criteria**: async worker robust and isolated from authoritative state.
- **Commit boundary**: ARCA worker/provider.
- **Risk**: VERY HIGH

### PHASE 10C — Security / performance / backup hardening
- **Objective**: production hardening across security, RBAC, DB, transactions, audit, performance, backup/restore.
- **Priority**: P2 where appropriate
- **Dependencies**: PHASE 9
- **Entities affected**: config, indexes, transactions, audit, backup.
- **Demo V2 reuse**: none.
- **NEW**: none; **ALTERED**: config/indexing/transaction/AuditLog.
- **Schema**: add indexes/constraints as required by performance review.
- **Migration/backfill**: none.
- **Backend/domain**: security review; RBAC verification; DB/index review; transaction review; audit review; performance review; backup/restore validation; production configuration validation.
- **RBAC/security**: full RBAC re-verification.
- **Frontend**: none.
- **Transaction/concurrency**: transaction boundary review.
- **Required tests**: security + performance + backup/restore validations.
- **Out of scope**: none.
- **Exit criteria**: hardening completed and validated.
- **Commit boundary**: hardening.
- **Risk**: MEDIUM

### PHASE 10D — Legacy compatibility cleanup
- **Objective**: remove/deprecate compatibility paths only after verification.
- **Priority**: P2
- **Dependencies**: 10A–10C
- **Entities affected**: Branch compatibility, UserBranchRole, old Inventory counters, old StockReservation semantics, old barcode semantics, branch-only CashSession assumptions.
- **Demo V2 reuse**: none.
- **NEW**: none; **ALTERED**: legacy modules.
- **Schema**: deprecate/remove only after ADD→BACKFILL→VERIFY→SWITCH.
- **Migration/backfill**: deprecate/remove after validated compatibility window; no destructive cleanup before verification.
- **Backend/domain**: remove obsolete compatibility paths.
- **RBAC/security**: none.
- **Frontend**: none.
- **Transaction/concurrency**: none.
- **Required tests**: regression and compatibility-window tests.
- **Out of scope**: none.
- **Exit criteria**: legacy cleanup completed safely without regression.
- **Commit boundary**: legacy cleanup.
- **Risk**: MEDIUM

### PHASE 10E — Production-readiness verification
- **Objective**: final production readiness gate.
- **Priority**: P1
- **Dependencies**: 10A–10D
- **Entities affected**: all.
- **Demo V2 reuse**: none.
- **NEW**: none; **ALTERED**: none.
- **Schema**: none.
- **Migration/backfill**: verify migrations reproducible and rollback/backup validated.
- **Backend/domain**: run complete acceptance verification.
- **RBAC/security**: authorization tests green.
- **Frontend**: none.
- **Transaction/concurrency**: concurrency tests green.
- **Required tests (all green)**: migrations reproducible; rollback/backup validated; authorization; inventory reconciliation; concurrency; payments/cash; SEÑA; transfer/publication/exchange; critical E2E; FiscalOutbox durability; build/lint/typecheck/tests; deployment/environment checks.
- **Out of scope**: none.
- **Exit criteria**: all gates green → production-ready.
- **Commit boundary**: release gate.
- **Risk**: MEDIUM

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

Test layers:

- unit tests
- domain/service tests
- integration tests
- DB/concurrency tests
- authorization tests
- migration tests
- E2E critical flows

Critical test matrix (all required for Production V1):

1. two sellers race for final unit — only one succeeds
2. transfer cannot dispatch held merchandise
3. partial transfer receipt preserves outstandingTransit (external custody)
4. LOST_IN_TRANSIT does not double-decrement origin
5. publication LOSS/DAMAGE does not double-decrement location
6. SEÑA fulfillment succeeds against its own entitlement even when general sellable = 0
7. expired SEÑA no longer reduces effective sellable
8. CASH SenaPayment creates exactly one SENA_DEPOSIT CashMovement
9. SenaSettlement creates no duplicate SalePayment
10. SenaSettlement creates no second CashMovement
11. CASH SEÑA + CARD payment uses listPrice
12. CASH SEÑA + TRANSFER remainder uses cashPrice
13. LOCATION-scoped ADMIN cannot mutate global pricing/catalog
14. Exchange cannot exceed originalSaleItem.quantity
15. Exchange replacement inventory decremented exactly once
16. one OPEN CashSession per CashRegister
17. duplicate payment retry is idempotent
18. concurrent DocumentCounter allocations never duplicate numbers
19. FiscalOutbox cannot be lost between Sale completion and worker

==================================================
MIGRATION STRATEGY
==================================================

Migration dependency graph. All migrations follow the discipline:

ADD → BACKFILL → VERIFY → SWITCH READS/WRITES → DEPRECATE → REMOVE (only after a validated compatibility window).

No destructive one-step replacement.

| Source | Target | Strategy |
| ------ | ------ | -------- |
| Branch | Location | ADD Location; BACKFILL from Branch; VERIFY; SWITCH reads/writes; DEPRECATE Branch; REMOVE after validated compatibility window. |
| UserBranchRole | UserRoleScope | ADD UserRoleScope; BACKFILL from UserBranchRole; VERIFY permissions/scopes; SWITCH authorization reads/writes; DEPRECATE UserBranchRole; REMOVE only after validated compatibility window. |
| ProductVariant.barcode | Product.barcode | Inspect products with one vs multiple legacy variant barcodes; choose/generate canonical Product.barcode per migration policy; preserve legacy values via approved legacy fields; flag any migration mapping as an explicit implementation decision; never silently discard identifiers. |
| Inventory.physical | InventoryBalance.onHand | ADD InventoryBalance; BACKFILL onHand from Inventory.physical; VERIFY counts; SWITCH reads/writes; DEPRECATE counter. |
| Inventory.reserved | StockHold | Reconcile/backfill reserved into StockHold; VERIFY counts/invariants; SWITCH reads/writes; DEPRECATE old counter. |
| StockReservation | StockHold | Migrate with history and active-status reconciliation; VERIFY active holds; DEPRECATE old model. |
| Sale | (altered) | ALTER incrementally; preserve all historical rows. |
| SaleItem | (altered) | ALTER incrementally; preserve historical monetary history. |
| SalePayment | (altered) | ALTER incrementally; preserve payment history. |
| CashSession | CashRegister + altered CashSession | ADD CashRegister (NEW); backfill/register assignment; ADD CashSession.cashRegisterId and new financial fields; backfill; verify; switch; deprecate obsolete branch-only semantics. Do NOT drop CashSession rows. |

==================================================
CLAUDE CODE EXECUTION MODEL
==================================================

The roadmap is structured for direct Claude Code execution. Every subphase (0A through 10E) is a focused implementation unit with:

- one clear implementation objective
- exact dependency
- touched entities/modules
- schema/migration effect
- backend/domain effect
- tests required
- completion criteria
- suggested commit boundary

Subphases are already decomposed into session-sized units. Examples follow.

Phase 1A — Company + Location schema/migration: create Company/Location tables, backfill Branch → Location, verify counts, switch reads. (Already detailed above.)

Phase 1B — Role / Permission / UserRoleScope: role model + DB CHECKs + privilege-escalation tests.

Phase 1C — Branch/UserBranchRole migration: ADD → BACKFILL → VERIFY → SWITCH → DEPRECATE.

Phase 1D — Authorization middleware/services: backend-authoritative scope-aware permission checks.

Phase 3A — InventoryBalance migration: create InventoryBalance, backfill Demo Inventory.physical, verify counts, add reconciliation tests, switch inventory reads.

The decomposition is complete in this document; Claude Code must not invent the implementation decomposition.

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