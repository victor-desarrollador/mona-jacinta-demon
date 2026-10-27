# 03-role-permission-matrix

**Permission names**-All permissions are defined as constant strings (e.g. `SALE_CREATE`).  They are stored in the `Permission` table and referenced by `RolePermission`.

| Permission | Description | Default granted to role |
|------------|-------------|-------------------------|
| `PRICE_MANAGE` | Authorized price changes (individual, category, bulk). Price management covers individual price changes, category/group price changes, and bulk/mass price changes. Pricing is **global** (not per-location). OWNER has implicit company-wide `PRICE_MANAGE`; ADMIN is granted `PRICE_MANAGE` only with an explicit **COMPANY** scope. A LOCATION-scoped ADMIN must **not** change global Product/ProductVariant pricing. SELLER, CASHIER, and WAREHOUSE have no default price-change authority. | OWNER, ADMIN (COMPANY scope only) |
| `GOODS_RECEIPT_MANAGE` | Create/edit/complete goods receipts, create Product/Variant during receiving. | WAREHOUSE, ADMIN |
| `PRODUCT_MANAGE` | CRUD products (soft-delete), manage barcode, legacy code, primary image reference. Products are global; ADMIN requires COMPANY scope. | OWNER, ADMIN |
| `PRODUCT_VARIANT_MANAGE` | CRUD product variants (SKU, color, size, activation). Variants are global; ADMIN requires COMPANY scope. | OWNER, ADMIN |
| `LABEL_PRINT` | Generate/print product labels (barcode). | OWNER, ADMIN, WAREHOUSE, CASHIER |
| `IMPORT_RUN` | Run CSV/XLSX initial-stock import. | OWNER, ADMIN |
| `TRANSFER_RESOLVE` | Resolve transfer discrepancies (LATE_RECEIPT / RETURNED_TO_ORIGIN / LOST_IN_TRANSIT). | CASHIER, WAREHOUSE, ADMIN |
| `SENA_SETTLE` | Fulfill a SEÑA into a sale (apply deposit via `SenaSettlement`). | CASHIER, ADMIN |
| `SALE_CREATE` | Create a draft sale (seller). | SELLER, ADMIN |
| `SALE_CHARGE` | Register a payment for a sale (cashier). | CASHIER, ADMIN |
| `SALE_COMPLETE` | Complete a sale transaction (cashier). | CASHIER, ADMIN |
| `SALE_VIEW` | View own sales / drafts. | SELLER (own), CASHIER (own branch), ADMIN |
| `SALE_QUEUE_VIEW` | View pending sales queue (cashier). | CASHIER, ADMIN |
| `INVENTORY_VIEW` | View inventory for assigned branches. | SELLER, CASHIER, ADMIN |
| `INVENTORY_MANAGE` | Adjust physical stock, perform manual adjustments. | ADMIN, WAREHOUSE (central-warehouse scope) |
| `CASH_SESSION_OPEN` | Open a cash session. | CASHIER, ADMIN |
| `CASH_SESSION_CLOSE` | Close a cash session. | CASHIER, ADMIN |
| `USER_MANAGE` | CRUD users, assign roles/branches. | ADMIN |
| `REPORT_VIEW` | Access reports and analytics. | ADMIN |
| `AUDIT_VIEW` | View audit logs. | ADMIN |
| `SUPPLIER_MANAGE` | CRUD suppliers, link products. | ADMIN |
| `TRANSFER_REQUEST` | Request a stock transfer. | SELLER, CASHIER, WAREHOUSE, ADMIN |
| `TRANSFER_VIEW` | View transfer details. | SELLER, CASHIER, WAREHOUSE, ADMIN |
| `TRANSFER_APPROVE` | Approve a transfer request and modify quantities if needed. | CASHIER, WAREHOUSE, ADMIN |
| `TRANSFER_PREPARE` | Prepare items for dispatch (pick, pack). | WAREHOUSE, ADMIN |
| `TRANSFER_DISPATCH` | Dispatch transfer, update in-transit stock, generate remito. | CASHIER, WAREHOUSE, ADMIN |
| `TRANSFER_RECEIVE` | Receive transfer, reconcile in-transit, update destination stock. | CASHIER, WAREHOUSE, ADMIN |
| `EXCHANGE_MANAGE` | Process exchanges/returns. | CASHIER, ADMIN |
| `PUBLICATION_CHECKOUT` | Checkout merchandise for publication. | CASHIER, ADMIN |
| `PUBLICATION_RETURN` | Return publication merchandise. | CASHIER, ADMIN |
| `SENA_CREATE` | Create a commercial SEÑA (customer reservation). | SELLER, CASHIER, ADMIN |
| `SENA_MANAGE` | View/manage active SEÑAs, process expiry. | ADMIN |
| `PRODUCT_IMAGE_MANAGE` | Upload, replace, or remove the primary product image. | ADMIN, WAREHOUSE |

**Roles**-Roles are stored in the `Role` table (`code` values: `SELLER`, `CASHIER`, `WAREHOUSE`, `ADMIN`, `OWNER`).

- **OWNER**-Unrestricted access; all permissions granted implicitly, all branches and the central warehouse are assigned.
- **ADMIN**-Permission-based and scope-based access. Operations require the relevant granted permission and an authorized company/branch/location scope. The ADMIN role alone does not grant global access; branch restrictions still apply based on assigned scopes.
- **WAREHOUSE**-Warehouse-focused role: can request, approve, prepare, dispatch, and receive transfers; manage goods receipts and supplier interactions; no inherent financial/accounting visibility unless granted specific permissions.
- **SELLER**-Can create draft sales, search products, select variants, view own drafts, and create SEÑAs.
- **CASHIER**-Can view pending sales queue, register payments (split), complete sales, manage cash sessions, process exchanges/returns, handle publication checkout/return, fulfill SEÑAs (`SENA_SETTLE`), and resolve transfer discrepancies (`TRANSFER_RESOLVE`).

**Branch scope**-All non-OWNER users, including ADMIN, are evaluated against authoritative permissions and authorized scopes. OWNER is the only Production V1 role with unrestricted company-wide scope by business definition.

**Warehouse scope**-Transfer-related permissions (`TRANSFER_VIEW`, `TRANSFER_REQUEST`, `TRANSFER_APPROVE`, `TRANSFER_PREPARE`, `TRANSFER_DISPATCH`, `TRANSFER_RECEIVE`) are scoped to the central warehouse/depot location unless a specific branch warehouse is defined in future phases.  `SUPPLIER_MANAGE` may also be warehouse-scoped.

**Authorization source**-The **authoritative** source is the `Permission` ↔ `RolePermission` ↔ `UserBranchRole` data in PostgreSQL.  The JWT never contains role or branch information; the backend resolves it on each request.

**Adding permissions**-To add a new permission, insert a row in `Permission` and update the relevant `RolePermission` rows; no code changes are required beyond the controller usage of `requirePermission('NEW_PERMISSION')`.
