-- QR inside PROPORTIONAL_V1 (P0-B, OWNER decision OR-002, 2026-10-21).
--
-- ADDITIVE and N-1 safe, same recipe as m12 (CARD_CREDIT). Nothing existing is rewritten:
--   * four NULLable columns (full price and adjustment bps of QR) on SaleCheckout and
--     CheckoutAttempt; every historical row keeps NULL there;
--   * the CHECK constraints that listed the four proportional methods are dropped and
--     re-created with QR added (a strict widening: every row that satisfied the old
--     constraint satisfies the new one);
--   * algorithmVersion 1 (no credit snapshot) and 2 (credit snapshot, no QR snapshot: what the
--     N-1 API, the CARD_CREDIT release, writes) stay valid; version 3 is the snapshot WITH QR;
--   * the two credit-snapshot CHECKs are re-created because m12 pinned a credit price to
--     "algorithmVersion = 2": a version-3 row also carries one, so the pin becomes ">= 2"
--     (the other terms are unchanged, so every m12 row still satisfies it);
--   * one partial unique index for QR references and one replaced immutability function.
--     No enum change (PaymentMethod already has QR), no data change, no FK change.
-- An N-1 instance keeps writing version-2 rows with NULL QR columns and never QR: all of
-- that still satisfies every constraint below.

-- Atomic: every statement, the LOCK included, runs inside the explicit BEGIN ... COMMIT
-- below, so a failed ADD CONSTRAINT can never leave a table without the constraint it
-- replaces. Every DROP CONSTRAINT is paired with an ADD CONSTRAINT of the same name.

BEGIN;

LOCK TABLE "SaleCheckout", "CheckoutAttempt", "SalePayment", "ExternalCollection",
  "CheckoutAttemptTender", "CheckoutAttemptDeclaration" IN ACCESS EXCLUSIVE MODE;

-- 1. Columns ---------------------------------------------------------------------
ALTER TABLE "SaleCheckout"
  ADD COLUMN "fullPriceQr" BIGINT,
  ADD COLUMN "qrAdjustmentBps" INTEGER;

ALTER TABLE "CheckoutAttempt"
  ADD COLUMN "fullPriceQr" BIGINT,
  ADD COLUMN "qrAdjustmentBps" INTEGER;

-- 2. SaleCheckout ------------------------------------------------------------------
ALTER TABLE "SaleCheckout" DROP CONSTRAINT "chk_checkout_model";
ALTER TABLE "SaleCheckout" ADD CONSTRAINT "chk_checkout_model"
  CHECK ("pricingModel" = 'PROPORTIONAL_V1' AND "algorithmVersion" IN (1, 2, 3));

ALTER TABLE "SaleCheckout" DROP CONSTRAINT "chk_checkout_balance_method";
ALTER TABLE "SaleCheckout" ADD CONSTRAINT "chk_checkout_balance_method"
  CHECK ("balanceMethod" IN ('CASH', 'TRANSFER', 'CARD_DEBIT', 'CARD_CREDIT', 'QR'));

-- The credit snapshot (m12) with the version pin widened from "= 2" to ">= 2".
ALTER TABLE "SaleCheckout" DROP CONSTRAINT "chk_checkout_credit_snapshot";
ALTER TABLE "SaleCheckout" ADD CONSTRAINT "chk_checkout_credit_snapshot" CHECK (
  (("fullPriceCredit" IS NULL) = ("creditAdjustmentBps" IS NULL))
  AND ("algorithmVersion" >= 2 OR "fullPriceCredit" IS NULL)
  AND ("algorithmVersion" = 1 OR ("fullPriceCredit" IS NULL) = ("pricingConfigId" IS NULL))
  AND ("fullPriceCredit" IS NULL
    OR ("fullPriceCredit" > 0 AND "fullPriceCredit" % 100 = 0 AND "creditAdjustmentBps" BETWEEN 0 AND 10000))
  AND ("balanceMethod" <> 'CARD_CREDIT' OR "fullPriceCredit" IS NOT NULL));

-- The QR snapshot: both columns together or none; absent before version 3; in version 3
-- present exactly when the pricing-config snapshot is; a whole-peso positive full price and
-- a bounded adjustment; a QR balance needs it.
ALTER TABLE "SaleCheckout" ADD CONSTRAINT "chk_checkout_qr_snapshot" CHECK (
  (("fullPriceQr" IS NULL) = ("qrAdjustmentBps" IS NULL))
  AND ("algorithmVersion" = 3 OR "fullPriceQr" IS NULL)
  AND ("algorithmVersion" < 3 OR ("fullPriceQr" IS NULL) = ("pricingConfigId" IS NULL))
  AND ("fullPriceQr" IS NULL
    OR ("fullPriceQr" > 0 AND "fullPriceQr" % 100 = 0 AND "qrAdjustmentBps" BETWEEN 0 AND 10000))
  AND ("balanceMethod" <> 'QR' OR "fullPriceQr" IS NOT NULL));

-- 3. CheckoutAttempt -----------------------------------------------------------------
ALTER TABLE "CheckoutAttempt" DROP CONSTRAINT "chk_attempt_plan";
ALTER TABLE "CheckoutAttempt" ADD CONSTRAINT "chk_attempt_plan"
  CHECK ("balanceMethod" IN ('CASH', 'TRANSFER', 'CARD_DEBIT', 'CARD_CREDIT', 'QR')
    AND "expectedTotal" > 0 AND "expectedBalanceAmount" >= 100 AND "expectedBalanceAmount" % 100 = 0
    AND "tenderCount" BETWEEN 1 AND 3 AND "fullPriceCash" > 0 AND "fullPriceCash" % 100 = 0
    AND "algorithmVersion" IN (1, 2, 3));

ALTER TABLE "CheckoutAttempt" DROP CONSTRAINT "chk_attempt_credit_snapshot";
ALTER TABLE "CheckoutAttempt" ADD CONSTRAINT "chk_attempt_credit_snapshot" CHECK (
  (("fullPriceCredit" IS NULL) = ("creditAdjustmentBps" IS NULL))
  AND ("algorithmVersion" >= 2 OR "fullPriceCredit" IS NULL)
  AND ("algorithmVersion" = 1 OR ("fullPriceCredit" IS NULL) = ("pricingConfigId" IS NULL))
  AND ("fullPriceCredit" IS NULL
    OR ("fullPriceCredit" > 0 AND "fullPriceCredit" % 100 = 0 AND "creditAdjustmentBps" BETWEEN 0 AND 10000))
  AND ("balanceMethod" <> 'CARD_CREDIT' OR "fullPriceCredit" IS NOT NULL));

ALTER TABLE "CheckoutAttempt" ADD CONSTRAINT "chk_attempt_qr_snapshot" CHECK (
  (("fullPriceQr" IS NULL) = ("qrAdjustmentBps" IS NULL))
  AND ("algorithmVersion" = 3 OR "fullPriceQr" IS NULL)
  AND ("algorithmVersion" < 3 OR ("fullPriceQr" IS NULL) = ("pricingConfigId" IS NULL))
  AND ("fullPriceQr" IS NULL
    OR ("fullPriceQr" > 0 AND "fullPriceQr" % 100 = 0 AND "qrAdjustmentBps" BETWEEN 0 AND 10000))
  AND ("balanceMethod" <> 'QR' OR "fullPriceQr" IS NOT NULL));

-- 4. SalePayment: a QR checkout payment is an external, referenced collection exactly like
--    TRANSFER, CARD_DEBIT and CARD_CREDIT (reference required, no received/change). It is
--    never cash: the shape forbids receivedAmount/changeAmount for it.
ALTER TABLE "SalePayment" DROP CONSTRAINT "chk_payment_checkout_shape";
ALTER TABLE "SalePayment" ADD CONSTRAINT "chk_payment_checkout_shape" CHECK (
  ("pricingModel" = 'FIXED_TOTAL'
    AND "checkoutId" IS NULL AND "tenderRole" IS NULL AND "methodFullPrice" IS NULL
    AND "adjustmentBps" IS NULL AND "externalCollectionId" IS NULL)
  OR ("pricingModel" = 'PROPORTIONAL_V1'
    AND "checkoutId" IS NOT NULL AND "tenderRole" IS NOT NULL AND "cashSessionId" IS NOT NULL
    AND "methodFullPrice" IS NOT NULL AND "methodFullPrice" > 0 AND "methodFullPrice" % 100 = 0
    AND "adjustmentBps" IS NOT NULL AND "adjustmentBps" BETWEEN 0 AND 10000
    AND (("method" = 'CASH' AND "externalCollectionId" IS NULL
        AND "receivedAmount" IS NOT NULL AND "changeAmount" IS NOT NULL)
      OR ("method" IN ('TRANSFER', 'CARD_DEBIT', 'CARD_CREDIT', 'QR') AND "externalCollectionId" IS NOT NULL
        AND "receivedAmount" IS NULL AND "changeAmount" IS NULL))));

-- 5. ExternalCollection: a QR collection carries a reference and NO institution (the
--    institution is the origin bank of a TRANSFER only), like a card; its reference is
--    unique per branch in its own partial index.
ALTER TABLE "ExternalCollection" DROP CONSTRAINT "chk_ec_institution";
ALTER TABLE "ExternalCollection" ADD CONSTRAINT "chk_ec_institution" CHECK (
  ("method" IN ('CARD_DEBIT', 'CARD_CREDIT', 'QR') AND "institution" IS NULL AND "institutionOther" IS NULL)
  OR ("method" = 'TRANSFER' AND "institution" IS NOT NULL AND "institution" <> 'OTHER'
    AND "institutionOther" IS NULL)
  OR ("method" = 'TRANSFER' AND "institution" IS NOT NULL AND "institution" = 'OTHER'
    AND "institutionOther" IS NOT NULL AND char_length(btrim("institutionOther")) BETWEEN 1 AND 60));

CREATE UNIQUE INDEX "ExternalCollection_qr_ref_key"
  ON "ExternalCollection"("branchId", "referenceKey") WHERE "method" = 'QR';

-- 6. Attempt tenders and declarations ---------------------------------------------------
ALTER TABLE "CheckoutAttemptTender" DROP CONSTRAINT "chk_tender_shape";
ALTER TABLE "CheckoutAttemptTender" ADD CONSTRAINT "chk_tender_shape"
  CHECK ("method" IN ('CASH', 'TRANSFER', 'CARD_DEBIT', 'CARD_CREDIT', 'QR') AND (
    ("role" = 'BALANCE' AND "source" = 'NEW' AND "amount" IS NULL AND "externalCollectionId" IS NULL)
    OR ("role" = 'FIXED' AND "source" = 'NEW' AND "amount" IS NOT NULL AND "amount" > 0
      AND "externalCollectionId" IS NULL)
    OR ("role" = 'FIXED' AND "source" = 'COLLECTION' AND "method" IN ('TRANSFER', 'CARD_DEBIT', 'CARD_CREDIT', 'QR')
      AND "amount" IS NOT NULL AND "amount" > 0 AND "externalCollectionId" IS NOT NULL)));

ALTER TABLE "CheckoutAttemptDeclaration" DROP CONSTRAINT "chk_declaration_shape";
ALTER TABLE "CheckoutAttemptDeclaration" ADD CONSTRAINT "chk_declaration_shape" CHECK (
  ("method" = 'CASH' AND "tenderSource" = 'NEW' AND "outcome" = 'NONE'
    AND "externalCollectionId" IS NULL AND "returnedAmount" IS NULL)
  OR ("method" = 'CASH' AND "tenderSource" = 'NEW' AND "outcome" = 'RETURNED'
    AND "externalCollectionId" IS NULL AND "returnedAmount" IS NOT NULL AND "returnedAmount" > 0
    AND "evidence" IS NOT NULL)
  OR ("method" IN ('TRANSFER', 'CARD_DEBIT', 'CARD_CREDIT', 'QR') AND "outcome" = 'NONE'
    AND "externalCollectionId" IS NULL AND "returnedAmount" IS NULL)
  OR ("method" IN ('TRANSFER', 'CARD_DEBIT', 'CARD_CREDIT', 'QR') AND "tenderSource" = 'NEW' AND "outcome" = 'CHARGED'
    AND "externalCollectionId" IS NOT NULL AND "returnedAmount" IS NULL AND "evidence" IS NOT NULL));

-- 7. F1: the sealed plan and pricing snapshot are immutable, now including the QR
--    snapshot. The body is the m12 F1 with the two QR columns added to the frozen tuple;
--    nothing else changes.
CREATE OR REPLACE FUNCTION public."fn_checkout_attempt_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'CheckoutAttempt rows are permanent' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."id", NEW."saleId", NEW."branchId", NEW."reserveKey", NEW."operationKey", NEW."planHash",
      NEW."cashSessionId", NEW."balanceMethod", NEW."expectedTotal", NEW."expectedBalanceAmount",
      NEW."tenderCount", NEW."fullPriceCash", NEW."fullPriceTransfer", NEW."fullPriceDebit",
      NEW."fullPriceCredit", NEW."fullPriceQr", NEW."transferAdjustmentBps", NEW."debitAdjustmentBps",
      NEW."creditAdjustmentBps", NEW."qrAdjustmentBps", NEW."pricingConfigId",
      NEW."pricingConfigUpdatedAt", NEW."algorithmVersion", NEW."startedById", NEW."startedAt",
      NEW."recoveryReason", NEW."recoveryEvidence")
     IS DISTINCT FROM
     (OLD."id", OLD."saleId", OLD."branchId", OLD."reserveKey", OLD."operationKey", OLD."planHash",
      OLD."cashSessionId", OLD."balanceMethod", OLD."expectedTotal", OLD."expectedBalanceAmount",
      OLD."tenderCount", OLD."fullPriceCash", OLD."fullPriceTransfer", OLD."fullPriceDebit",
      OLD."fullPriceCredit", OLD."fullPriceQr", OLD."transferAdjustmentBps", OLD."debitAdjustmentBps",
      OLD."creditAdjustmentBps", OLD."qrAdjustmentBps", OLD."pricingConfigId",
      OLD."pricingConfigUpdatedAt", OLD."algorithmVersion", OLD."startedById", OLD."startedAt",
      OLD."recoveryReason", OLD."recoveryEvidence") THEN
    RAISE EXCEPTION 'CheckoutAttempt plan is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."planSealed" IS DISTINCT FROM OLD."planSealed"
     AND NOT (OLD."planSealed" = false AND NEW."planSealed" = true
              AND OLD."status" = 'RESERVED' AND NEW."status" = 'RESERVED') THEN
    RAISE EXCEPTION 'planSealed only goes false to true while RESERVED' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status"
     AND NOT (OLD."status" = 'RESERVED' AND NEW."status" IN ('CONFIRMED','REJECTED','ABANDONED')) THEN
    RAISE EXCEPTION 'CheckoutAttempt status transition not allowed' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" <> 'RESERVED'
     AND (NEW."confirmationHash", NEW."confirmedById", NEW."confirmedAt", NEW."confirmReason",
          NEW."confirmEvidence", NEW."rejectionCode", NEW."rejectionDetails", NEW."rejectedById",
          NEW."rejectedAt", NEW."abandonedById", NEW."abandonedAt", NEW."abandonReason",
          NEW."abandonEvidence")
         IS DISTINCT FROM
         (OLD."confirmationHash", OLD."confirmedById", OLD."confirmedAt", OLD."confirmReason",
          OLD."confirmEvidence", OLD."rejectionCode", OLD."rejectionDetails", OLD."rejectedById",
          OLD."rejectedAt", OLD."abandonedById", OLD."abandonedAt", OLD."abandonReason",
          OLD."abandonEvidence") THEN
    RAISE EXCEPTION 'CheckoutAttempt outcome is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."declaredById", NEW."declaredAt") IS DISTINCT FROM (OLD."declaredById", OLD."declaredAt") THEN
    IF OLD."declaredById" IS NOT NULL OR OLD."declaredAt" IS NOT NULL
       OR NEW."declaredById" IS NULL OR NEW."declaredAt" IS NULL
       OR NEW."status" NOT IN ('REJECTED','ABANDONED') THEN
      RAISE EXCEPTION 'CheckoutAttempt declaration is written once, only when terminal' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

COMMIT;
