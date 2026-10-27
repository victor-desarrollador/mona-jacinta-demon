-- PILOT manual cash exits (migration 10): WITHDRAWAL and EXPENSE.
--
-- Additive only. Every existing row (OPENING / SALE_INCOME / CLOSING / MANUAL)
-- is untouched: the two new columns stay NULL and the unique index treats NULL
-- keys as distinct. No applied migration is rewritten.
--
-- PostgreSQL rule (already documented in 20260922210000_d3_initial_stock_and_
-- global_audit): a label added by `ALTER TYPE ... ADD VALUE` cannot be USED as an
-- enum value in the same migration while the type change is uncommitted. The
-- conditional CHECK constraints below therefore never compare the column to an
-- enum constant: they cast `type` to text and compare text literals, which is
-- safe under any transaction wrapping. The enum labels themselves are proven
-- present by the LOCAL_TEST suite, not by these statements.
--
-- Prisma mirrors this migration: the columns and the unique index are reproduced
-- exactly by `prisma migrate diff` against schema.prisma. The CHECK constraints
-- are SQL-only (Prisma has no @@check), as with the chk_* precedents. Every CHECK
-- is NULL-safe: the text guard short-circuits a historical row to TRUE.

-- 1. Enum ---------------------------------------------------------------------
ALTER TYPE "CashMovementType" ADD VALUE 'WITHDRAWAL';
ALTER TYPE "CashMovementType" ADD VALUE 'EXPENSE';

-- 2. Columns ------------------------------------------------------------------
ALTER TABLE "CashMovement" ADD COLUMN "reason" TEXT;
ALTER TABLE "CashMovement" ADD COLUMN "idempotencyKey" TEXT;

-- 3. Idempotency guard --------------------------------------------------------
-- At most one movement per (session, key). NULLs are distinct in PostgreSQL, so
-- historical and income rows (NULL key) are never in conflict.
CREATE UNIQUE INDEX "CashMovement_sessionId_idempotencyKey_key"
  ON "CashMovement"("sessionId", "idempotencyKey");

-- 4. Conditional integrity for WITHDRAWAL / EXPENSE only ---------------------
ALTER TABLE "CashMovement" ADD CONSTRAINT "chk_cash_movement_exit_amount"
  CHECK ("type"::text NOT IN ('WITHDRAWAL', 'EXPENSE') OR "amount" > 0) NOT VALID;
ALTER TABLE "CashMovement" ADD CONSTRAINT "chk_cash_movement_exit_reason"
  CHECK ("type"::text NOT IN ('WITHDRAWAL', 'EXPENSE')
         OR ("reason" IS NOT NULL AND btrim("reason") <> '')) NOT VALID;
ALTER TABLE "CashMovement" ADD CONSTRAINT "chk_cash_movement_exit_no_payment"
  CHECK ("type"::text NOT IN ('WITHDRAWAL', 'EXPENSE') OR "salePaymentId" IS NULL) NOT VALID;

ALTER TABLE "CashMovement" VALIDATE CONSTRAINT "chk_cash_movement_exit_amount";
ALTER TABLE "CashMovement" VALIDATE CONSTRAINT "chk_cash_movement_exit_reason";
ALTER TABLE "CashMovement" VALIDATE CONSTRAINT "chk_cash_movement_exit_no_payment";
