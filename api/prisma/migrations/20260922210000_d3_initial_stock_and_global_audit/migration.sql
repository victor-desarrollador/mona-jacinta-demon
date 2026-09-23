-- D3 (Demo Operativa V1): additive only. Existing SALE rows and existing
-- AuditLog rows are untouched; no data rewrite, no dropped value/column.

-- AlterEnum: INITIAL_STOCK is not used by any statement in this migration.
ALTER TYPE "StockMovementType" ADD VALUE 'INITIAL_STOCK';

-- AlterTable: global COMPANY-scoped catalogue audits carry no Location. The
-- foreign key to Branch is kept for every non-null value.
ALTER TABLE "AuditLog" ALTER COLUMN "branchId" DROP NOT NULL;
