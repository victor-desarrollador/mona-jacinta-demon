-- WAREHOUSE-MVP: manual stock adjustment (StockMovement type ADJUSTMENT).
--
-- Additive only. Every existing StockMovement (SALE / INITIAL_STOCK) is
-- untouched: the three new columns stay NULL, the unique index treats NULL keys
-- as distinct, and no applied migration is rewritten. Inventory is NOT touched:
-- a global physical/reserved non-negativity CHECK needs a prior inspection of the
-- PILOT data and is deliberately out of scope here.
--
-- ONE migration instead of two (the "new enum label cannot be USED in the same
-- transaction" rule, already documented in 20260922210000_d3_initial_stock_and_
-- global_audit and 20261018120000_cash_movement_withdrawals_expenses): no
-- statement below uses the new 'ADJUSTMENT' label as an enum value. The CHECK
-- constraints cast "type" and "reason" to text and compare text literals, which
-- is safe under any transaction wrapping. StockAdjustmentReason is created in
-- this very migration, so its column may be added in the same transaction.
--
-- Prisma mirrors this migration: the enum, the columns and the unique index are
-- reproduced by `prisma migrate diff` against schema.prisma. The CHECK
-- constraints are SQL-only (Prisma has no @@check). Every CHECK is NULL-safe: the
-- text guard short-circuits a historical row to TRUE.

-- 1. Enums --------------------------------------------------------------------
ALTER TYPE "StockMovementType" ADD VALUE 'ADJUSTMENT';
CREATE TYPE "StockAdjustmentReason" AS ENUM ('DAMAGED', 'LOST', 'LOAD_ERROR', 'SURPLUS', 'OTHER');

-- 2. Columns ------------------------------------------------------------------
ALTER TABLE "StockMovement" ADD COLUMN "reason" "StockAdjustmentReason";
ALTER TABLE "StockMovement" ADD COLUMN "note" TEXT;
ALTER TABLE "StockMovement" ADD COLUMN "idempotencyKey" TEXT;

-- 3. Idempotency guard --------------------------------------------------------
-- At most one movement per (user, key). NULLs are distinct in PostgreSQL, so
-- historical SALE / INITIAL_STOCK rows (NULL key) never conflict.
CREATE UNIQUE INDEX "StockMovement_userId_idempotencyKey_key"
  ON "StockMovement"("userId", "idempotencyKey");

-- 4. Conditional integrity for manual adjustments only -------------------------
ALTER TABLE "StockMovement" ADD CONSTRAINT "chk_stock_movement_adjustment_shape"
  CHECK ("type"::text <> 'ADJUSTMENT'
         OR ("reason" IS NOT NULL
             AND "idempotencyKey" IS NOT NULL AND char_length(btrim("idempotencyKey")) > 0
             AND "quantityDelta" <> 0
             AND abs("quantityDelta") <= 100)) NOT VALID;
ALTER TABLE "StockMovement" ADD CONSTRAINT "chk_stock_movement_adjustment_reason_rules"
  CHECK ("type"::text <> 'ADJUSTMENT'
         OR ("reason"::text IN ('DAMAGED', 'LOST') AND "quantityDelta" < 0)
         OR ("reason"::text = 'SURPLUS' AND "quantityDelta" > 0)
         OR "reason"::text = 'LOAD_ERROR'
         OR ("reason"::text = 'OTHER' AND "note" IS NOT NULL AND char_length(btrim("note")) >= 10)) NOT VALID;
-- Only an ADJUSTMENT may carry a reason.
ALTER TABLE "StockMovement" ADD CONSTRAINT "chk_stock_movement_reason_only_adjustment"
  CHECK ("type"::text = 'ADJUSTMENT' OR "reason" IS NULL) NOT VALID;

ALTER TABLE "StockMovement" VALIDATE CONSTRAINT "chk_stock_movement_adjustment_shape";
ALTER TABLE "StockMovement" VALIDATE CONSTRAINT "chk_stock_movement_adjustment_reason_rules";
ALTER TABLE "StockMovement" VALIDATE CONSTRAINT "chk_stock_movement_reason_only_adjustment";
