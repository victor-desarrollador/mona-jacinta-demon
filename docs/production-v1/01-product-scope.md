# 01-product-scope

**Business objective**-Provide a clear, production-grade product model that supports the Mona Jacinta retail workflow while remaining simple enough for the Day 25 demo.

Operational users – `OWNER`, `ADMIN`, `CASHIER`, `SELLER`, `WAREHOUSE` interact with products via the POS, inventory, and back‑office. (Note: `MANAGER` is not a Production V1 operational role; branch‑scoped management falls to `ADMIN` or future role splits. Demo V2 included a `MANAGER` role; Production V1 does not.)

**Locations**-Products are global (company-wide) and have a **single internal Code 128 barcode** at the **Product** level. Variants (SKU) are identified by colour/size combos and have their own SKU; they do **not** have separate barcodes.

**Production V1 scope**

- One barcode per **Product** (internal Code 128), stored on the `Product` table.  
  The barcode resolves to a product; the seller then selects the exact variant (colour + size) before adding to a sale.
- **ProductVariant** holds:
  - `sku` (unique string, e.g. `JEA-OXF-AZU-42`).
  - `color` (enumerated, plus free-text `OTHER`).
  - `size` (enumerated families: **BABY**, **CHILD**, **ADULT-LETTER**, **ADULT-NUMERIC**, **SPECIAL**).
  - `price` (minor-unit `BigInt`).
  - `costPrice` (minor-unit `BigInt`).
  - `isActive` flag.
- **Optional primary image**-A Product may have zero or one primary image (binary data stored externally, e.g. object storage). Authorized users may upload, replace, or remove the image. UI shows a neutral placeholder when no image exists. Product creation/receiving must not fail due to missing image.
- **Pricing / customer codes**-Two pricing tiers:
  - `01 = CONSUMER_FINAL`-`listPrice` → optional `cashDiscount` (percentage or fixed monetary amount) → `cashPrice` (computed).
  - `02 = WHOLESALE`-`wholesalePrice` (direct).
  - Pricing rules are validated in the backend; the UI only displays the applicable price.
- **Category / Brand**-Simple lookup tables, read-only for the demo; they are scoped to the company, not to branches.
- **Product lifecycle**-Products referenced by historical transactions must not be physically deleted; use `isActive` flag (soft-delete) to preserve audit and sale history.

**Day 25 committed milestone**-Product CRUD (soft-delete only) and read-only endpoints, variant lookup, barcode scanning, pricing calculation, and optional product image upload/replacement/removal are fully functional.

**Day 26-35 completion milestone**-Supplier-linked product import, bulk price updates, and barcode label generation are added (future work, not covered here).

**Explicit non-goals**-No multi-barcode per variant, no external barcode generation service, no EAN-13 handling.

**Assumptions / dependencies**-Relies on the `Product` / `ProductVariant` tables defined in the Prisma schema (see Demo V2 `schema.prisma`). The single barcode constraint is enforced by a unique index on `Product.barcode`.
