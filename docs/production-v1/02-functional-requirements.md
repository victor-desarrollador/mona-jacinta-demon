# 02-functional-requirements

The following functional requirements (FR) are **traceable**, **testable**, and prioritized for Production V1.  Each FR includes a unique identifier, a brief description, and a priority flag.

| ID | Description | Priority |
|----|-------------|----------|
| **FR-AUTH-001** | Employee login via email + password, returning a short-lived JWT (15 min) and user context (roles, branch assignments). | MUST |
| **FR-AUTH-002** | Logout is client-side token discard; no server-side revocation required. | MUST |
| **FR-RBAC-001** | Permission-based authorization middleware resolves roles/permissions per request from PostgreSQL; JWT carries only `sub`. | MUST |
| **FR-RBAC-002** | Branch-scoped permission enforcement: users may only act on resources belonging to branches they are assigned to. | MUST |
| **FR-RBAC-003** | Warehouse-scoped permission enforcement: users with `WAREHOUSE` role may only act on resources belonging to the central warehouse/depot (unless granted additional permissions). | MUST |
| **FR-ORG-001** | System maintains company entity (Mona Jacinta) and supports five retail branches plus one central warehouse/depot. | MUST |
| **FR-PROD-001** | Create, read, update, delete (soft-delete) for `Product` (global) with a unique internal barcode (Code 128). | MUST |
| **FR-PROD-002** | CRUD for `ProductVariant` (branch-agnostic) with unique SKU, colour, size attributes. | MUST |
| **FR-PROD-003** | Product barcode resolution: scanning barcode returns product; user then selects exact variant (colour/size). | MUST |
| **FR-IMG-001** | Product may have an optional primary image. Product creation, editing, goods receiving, POS, and inventory workflows MUST continue to work when the Product has no image. | MUST |
| **FR-IMG-002** | Authorized users may upload, replace, and remove the Product primary image. Removing an image must not delete or affect the Product itself. | MUST |
| **FR-IMG-003** | Product image uploads must be validated server-side. Validation must include permitted image media type, permitted maximum file size, rejection of unsupported/invalid uploads. Exact limits and storage provider are deferred to Architecture/ERD. | MUST |
| **FR-IMG-004** | Image upload/replacement/removal is protected by the PRODUCT_IMAGE_MANAGE permission. | MUST |
| **FR-PRIC-001** | Pricing calculation based on customer code (01 = CONSUMER_FINAL, 02 = WHOLESALE). | MUST |
| **FR-PRIC-002** | For CONSUMER_FINAL: `listPrice` minus `cashDiscount` (percentage or fixed monetary amount) equals `cashPrice`. | MUST |
| **FR-PRIC-003** | For WHOLESALE: price equals `wholesalePrice`. | MUST |
| **FR-PRIC-004** | Pricing rules are validated in the backend; frontend-provided totals/prices are never authoritative. | MUST |
| **FR-INV-001** | Inventory is tracked per `ProductVariant` × `Location` (Branch or Warehouse). Fields: `physical` (BigInt) and `reserved` (BigInt). | MUST |
| **FR-INV-002** | Compute `available = physical - reserved` on read; never store `available`. | MUST |
| **FR-INV-003** | Explicitly track additional stock dimensions: `inTransit` (stock in transit between locations) and `temporarilyOut` (stock checked out for publication/photo merchandise). | MUST |
| **FR-INV-004** | Sellable/available stock = `physical - reserved - inTransit - temporarilyOut` (never stored, computed on read). | MUST |
| **FR-INV-005** | Inventory history (`StockMovement`) records every adjustment with: company, location, variant, qty change, before/after, operation type, related document, user, timestamp, notes. | MUST |
| **FR-REC-001** | Warehouse creates a **Goods Receipt** before completion, attaching supplier, package count, photos/PDFs, and line items. Receipt is editable while `status = IN_PROGRESS`. | MUST |
| **FR-REC-002** | Upon receipt `COMPLETED`, inventory is updated (`physical` increased), `StockMovement` entries of type `GOODS_RECEIPT` are generated, and the receipt becomes immutable. | MUST |
| **FR-REC-003** | Goods receipt supports progressive loading of merchandise during receiving. | MUST |
| **FR-SUP-001** | Supplier entity with identity, contact data, product catalog (supplied products), and payable balance. | MUST |
| **FR-SUP-002** | Supplier invoices are recorded and linked to payments; supplier account movements are auditable. | MUST |
| **FR-SUP-003** | Basic import foundation: ability to create new Products and Variants during goods receipt. | MUST |
| **FR-TRANS-001** | Transfer workflow states: REQUESTED → APPROVED → PREPARING → DISPATCHED → RECEIVED → (RECEIVED_WITH_DIFFERENCE) → CANCELLED. | MUST |
| **FR-TRANS-002** | Transfer tracks: requesting user, origin, destination, requested quantities, approved quantities, dispatched quantities, received quantities, timestamps, observations. | MUST |
| **FR-TRANS-003** | At `DISPATCHED`: decrement origin `physical` stock, increment `inTransit`. | MUST |
| **FR-TRANS-004** | At `RECEIVED`: decrement `inTransit`, increment destination `physical`. | MUST |
| **FR-TRANS-005** | Transfer discrepancies (`RECEIVED_WITH_DIFFERENCE`) are recorded, generate audit entry, and notify administration/owner. | MUST |
| **FR-REMITO-001** | Transfer dispatch generates a delivery note/remito with: sequential number, origin, destination, items, quantities, date/time, responsible users, and link to transfer. | MUST |
| **FR-LABEL-001** | Label generation for products: includes Code 128 barcode (product-level), human-readable barcode value, short product description, black border, approximately 70 mm × 37 mm. | MUST |
| **FR-LABEL-002** | Labels print on ordinary self-adhesive A4 sheets, manual guillotine cutting, configurable quantity, reprinting allowed. | MUST |
| **FR-LABEL-003** | Label layout supports configuration of top margin, lateral margin, horizontal gap, vertical gap, starting position (where feasible). | SHOULD |
| **FR-POS-001** | Seller POS: scan product barcode (or search by name/SKU/legacyCode), select exact variant by colour/size, build sale cart, send to cashier. | MUST |
| **FR-POS-002** | Seller can view own draft sales and status. | MUST |
| **FR-PAY-001** | Split payments supported: cash, transfer, card debit, card credit. Each `SalePayment` stores `method`, `amount`, optional `receivedAmount` / `changeAmount` (cash), and a unique `idempotencyKey`. | MUST |
| **FR-PAY-002** | Sale transitions to `PAID` only when Σ accepted payments equals sale total; partial sums never mark as paid. | MUST |
| **FR-PAY-003** | For cash payments: `SalePayment` distinguishes `amount` (counts toward sale), `receivedAmount` (gross handed over), and `changeAmount` (received − amount). Returned change is not revenue. | MUST |
| **FR-CASH-001** | Cash register (`CashRegister`) per branch; cash sessions (`OPEN`/`CLOSE`) track opening amount, expected amount, counted amount, and difference. | MUST |
| **FR-CASH-002** | Cash movements include `SALE_INCOME`, `MANUAL`, `DEPOSIT`, `WITHDRAWAL`, `ADJUSTMENT`. Each movement is auditable. | MUST |
| **FR-CASH-003** | At most one `OPEN` cash session per `CashRegister` (enforced by partial unique index). | MUST |
| **FR-SENA-001** | Commercial SEÑA (customer reservation): exact duration 24 hours from creation, deposit amount free/manual, merchandise becomes unavailable for normal sale while held. | MUST |
| **FR-SENA-002** | SEÑA default initial business policy: non-refundable (future policy may be configurable). | MUST |
| **FR-SENA-003** | On expiry, SEÑA transitions from `ACTIVE` to `EXPIRED`; operational active list no longer shows it; reserved merchandise is released. Historical SEÑA/audit remains. | MUST |
| **FR-SENA-004** | If deposit was accepted, financial movement/history must remain auditable. | MUST |
| **FR-EXCH-001** | Exchange: link to original sale (even if sold at another branch), record returned item, create replacement sale item, handle price difference payment (customer pays difference if replacement price higher). | MUST |
| **FR-EXCH-002** | Exchange does NOT rewrite original sale; generates inventory movements (return increases stock, replacement decreases stock). | MUST |
| **FR-EXCH-003** | Exchange may occur in a different branch than the original sale; system must locate original sale across branches respecting permissions. | MUST |
| **FR-PUB-001** | Publication / photo merchandise checkout: `PUBLICATION_CHECKOUT` reduces sellable stock, records purpose, operator, notes, optional media. | MUST |
| **FR-PUB-002** | Publication return: `PUBLICATION_RETURN` with condition `GOOD` (stock becomes sellable again), `DAMAGED` (auditable damage/write-off), `LOSS` (auditable loss/missing). | MUST |
| **FR-NOTIF-001** | Owner / Admin receive high-priority notifications for: manual stock adjustments, write-offs, damage/loss, transfer discrepancies, completed goods receipts, low stock (configurable), significant price modifications, sensitive inventory changes. | MUST |
| **FR-NOTIF-002** | Normal sale activity generates only low-priority audit/events (e.g., `sale.pending_payment`, `sale.completed`); these do NOT create noisy high-priority admin notifications by default. | MUST |
| **FR-AUDIT-001** | Audit log records: user, role, branch, operation, entity type, entity id, timestamp, relevant before/after state (when appropriate). No passwords, tokens, secrets stored. | MUST |
| **FR-DASH-001** | Essential dashboard/reports: sales summary, inventory alerts, cash session status, pending transfers. | MUST |
| **FR-REPORT-001** | Transfer payment report filterable by date range and bank; export to XLSX or PDF. | MUST |
| **FR-REPORT-002** | Report includes at minimum columns: date, bank, amount. | MUST |
| **FR-ARCA-001** | ARCA integration capability: fiscal provider interface decoupled via FiscalProvider → ARCAProvider. ARCA is a required Production V1 project capability; it is not on the critical path for the Day 25 operational milestone; Day 26-35 targets real ARCA homologation when credentials/configuration are available. Never fabricate CAE; never begin testing against ARCA production. ARCA failure must not corrupt Sale, Payment, Cash, or Inventory state. | SHOULD
| **FR-ARCA-002** | ARCA homologation testing with provided credentials (Day 26-35). | SHOULD |
| **FR-TREAS-001** | Treasury, accounts receivable/payable, operational accounting (Day 26-35). | SHOULD |
| **FR-TRAIN-001** | Training and production preparation (Day 26-35). | SHOULD |
 
**Notes**-All `MUST` items are required for the Day 25 milestone and must have automated tests. `SHOULD` items are targeted for the Day 26-35 milestone. `LATER` items are out of scope for the current release.
