-- CASH-1 (FR-CASH-001): operational cash close with reconciliation.
-- Additive only: nullable columns, no existing row is rewritten, nothing is
-- dropped. Sessions closed before CASH-1 keep these columns NULL and must
-- never be presented as reconciled.

ALTER TABLE "CashSession"
  ADD COLUMN "expectedCash" BIGINT,
  ADD COLUMN "countedCash" BIGINT,
  ADD COLUMN "difference" BIGINT;
