-- PILOT cash movement reversals (migration 11): WITHDRAWAL_REVERSAL and
-- EXPENSE_REVERSAL, append-only compensating movements for a mistaken
-- WITHDRAWAL / EXPENSE (OWNER R1–R5, 2026-10-18).
--
-- Additive only. Every existing row is untouched: the new column stays NULL,
-- so the unique index (NULLs distinct), the composite FK (MATCH SIMPLE: a NULL
-- link is never checked) and every CHECK (text guard) accept it. No applied
-- migration is rewritten. The original movement is never updated or deleted:
-- a reversal is a new row pointing at it.
--
-- Same-session is a database invariant (OWNER R5): the composite FK
-- (reversesMovementId, sessionId) -> CashMovement(id, sessionId) makes a
-- reversal of a movement of another session impossible. It needs the candidate
-- key UNIQUE(id, sessionId). The original's type and amount correspondence is
-- protected by the service and by the fail-closed reconciliation (no
-- cross-row trigger for PILOT).
--
-- PostgreSQL rule (migration 10 precedent): a label added by
-- `ALTER TYPE ... ADD VALUE` cannot be USED as an enum value in the same
-- migration while the type change is uncommitted, so the CHECKs cast `type` to
-- text and compare text literals. The CHECKs are SQL-only (Prisma has no
-- @@check); the column, both unique indexes and the FK are mirrored exactly in
-- schema.prisma.

-- 1. Enum ---------------------------------------------------------------------
ALTER TYPE "CashMovementType" ADD VALUE 'WITHDRAWAL_REVERSAL';
ALTER TYPE "CashMovementType" ADD VALUE 'EXPENSE_REVERSAL';

-- 2. Column -------------------------------------------------------------------
ALTER TABLE "CashMovement" ADD COLUMN "reversesMovementId" TEXT;

-- 3. One reversal per original ------------------------------------------------
CREATE UNIQUE INDEX "CashMovement_reversesMovementId_key" ON "CashMovement"("reversesMovementId");

-- 4. Same session: candidate key + composite FK --------------------------------
CREATE UNIQUE INDEX "CashMovement_id_sessionId_key" ON "CashMovement"("id", "sessionId");
ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_reversesMovementId_sessionId_fkey"
  FOREIGN KEY ("reversesMovementId", "sessionId") REFERENCES "CashMovement"("id", "sessionId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- 5. Conditional integrity for the reversal types ------------------------------
-- A reversal type <=> a link; a link never appears on any other type.
ALTER TABLE "CashMovement" ADD CONSTRAINT "chk_cash_movement_reversal_link"
  CHECK (("type"::text IN ('WITHDRAWAL_REVERSAL', 'EXPENSE_REVERSAL')) = ("reversesMovementId" IS NOT NULL)) NOT VALID;
ALTER TABLE "CashMovement" ADD CONSTRAINT "chk_cash_movement_reversal_shape"
  CHECK ("type"::text NOT IN ('WITHDRAWAL_REVERSAL', 'EXPENSE_REVERSAL')
         OR ("amount" > 0 AND "reason" IS NOT NULL AND btrim("reason") <> ''
             AND "salePaymentId" IS NULL AND "idempotencyKey" IS NOT NULL)) NOT VALID;
ALTER TABLE "CashMovement" ADD CONSTRAINT "chk_cash_movement_reversal_not_self"
  CHECK ("reversesMovementId" IS NULL OR "reversesMovementId" <> "id") NOT VALID;

ALTER TABLE "CashMovement" VALIDATE CONSTRAINT "chk_cash_movement_reversal_link";
ALTER TABLE "CashMovement" VALIDATE CONSTRAINT "chk_cash_movement_reversal_shape";
ALTER TABLE "CashMovement" VALIDATE CONSTRAINT "chk_cash_movement_reversal_not_self";
