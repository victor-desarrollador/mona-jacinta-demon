# 00-master-index

**Purpose**-Consolidate the Production V1 design baseline, capture business-level decisions, and map them to the existing Demo V2 implementation. This index guides developers from high-level intent down to concrete domain rules.

**Document map**

- `00-master-index.md`-this overview and navigation.
- `01-product-scope.md`-product model, barcode strategy, variant handling, and pricing.
- `02-functional-requirements.md`-traceable FR IDs (MUST/SHOULD/LATER) covering authentication, RBAC, POS flow, inventory, cash, transfers, suppliers, exchanges, publications, notifications, reports, and ARCA.
- `03-role-permission-matrix.md`-canonical permission list, default role grants, branch/warehouse scope, and OWNER semantics.
- `04-domain-rules.md`-invariants, state transitions, and derived vs authoritative fields for every aggregate.

**Source-of-truth hierarchy**

1. **Production V1 business requirements** (this set of documents).
2. **Demo V2 architecture**-`docs/architecture/mona-demo-v2.md` (approved baseline).
3. **Legacy code**-`../Tesis/` (read-only reference only).  
   Any conflict is resolved in favour of the Production V1 requirements.

**Current scope status**-Demo V2 has been fully implemented and verified against the architecture in `docs/architecture/mona-demo-v2.md`. Production V1 builds on that foundation but diverges in several areas:
- Demo V2 places the barcode on `ProductVariant` (unique), while Production V1 requires a single internal Code 128 barcode at **Product** level.
- Demo V2 includes roles `SELLER`, `CASHIER`, `MANAGER`, `ADMIN`; Production V1 replaces `MANAGER` with `WAREHOUSE` as an operational role (MANAGER may exist historically but is not a Production V1 business role).
- Demo V2's `StockReservation` is used for the seller→cashier technical hold; Production V1 introduces a separate commercial **SEÑA/reservation** concept (24-hour customer deposit) distinct from the technical hold.
- Demo V2 inventory model tracks `physical` and `reserved`; Production V1 additionally requires explicit **in-transit** and **temporarily-out/publication** stock dimensions for Day 25.
- Demo V2 does not yet model suppliers, transfers, exchanges, publication/photo merchandise, delivery notes/remitos, or label generation-these are Day 25 **MUST** items in Production V1.
- Demo V2 cash session includes a partial unique index for one `OPEN` session per register (already present). Production V1 retains this but adds explicit cash-movement types for manual, deposit, withdrawal, adjustment.
- Demo V2 sale numbering uses `SaleNumberCounter`; Production V1 keeps this but may extend to other document types (remito) later.
- Demo V2 does not implement ARCA; Production V1 treats ARCA as a required capability behind a `FiscalProvider` interface.
- Demo V2 uses Socket.IO for realtime; Production V1 defines the business behavior for notifications but leaves the technology choice to Architecture V1.

**Relationship to Demo V2 documentation**-Links are provided throughout each document. When a Demo V2 artifact already satisfies a Production V1 requirement, the corresponding section cites the Demo V2 implementation as the reference implementation.

**Next steps**-After these documents are reviewed, we will proceed to the Architecture / ERD work (not part of this block).
