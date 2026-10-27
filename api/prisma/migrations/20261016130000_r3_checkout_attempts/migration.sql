-- R3-A4.3 (S1): durable checkout attempts, external-collection claim and refund
-- fields. Ninth migration; R3-A2 (20261016120000) is not touched.
--
-- Atomic: every statement, the LOCK and the preflight included, runs inside
-- the explicit BEGIN … COMMIT below. On any failure PostgreSQL aborts the whole
-- transaction and no object of this migration remains.
--
-- Additive only: new enums, tables, columns (nullable, or with a default),
-- CHECK constraints, indexes, FKs, functions and triggers. It never rewrites,
-- deletes or moves rows; the preflight refuses to run over rows written by a
-- build with R3-A2 only.
--
-- Prisma mirrors the tables, columns, unique/plain indexes and FKs. SQL-only
-- (no Prisma syntax): the CHECK constraints, the two partial unique indexes
-- (CheckoutAttempt_one_open_per_sale, CheckoutAttemptTender_one_balance), the
-- six functions and their triggers.
--
-- Every function is plpgsql, SECURITY INVOKER, SET search_path = pg_catalog,
-- pg_temp, without dynamic SQL, and raises check_violation (23514). There is no
-- TRUNCATE guard: test cleanup uses TRUNCATE … CASCADE.

BEGIN;

-- 1. Preflight (fail closed) ------------------------------------------------------
LOCK TABLE "SaleCheckout", "SalePayment", "ExternalCollection" IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "SaleCheckout") THEN
    RAISE EXCEPTION 'R3-A4.3 preflight: SaleCheckout must be empty' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM "SalePayment" WHERE "checkoutId" IS NOT NULL OR "pricingModel" <> 'FIXED_TOTAL') THEN
    RAISE EXCEPTION 'R3-A4.3 preflight: proportional payments exist' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM "ExternalCollection") THEN
    RAISE EXCEPTION 'R3-A4.3 preflight: ExternalCollection must be empty' USING ERRCODE = 'check_violation';
  END IF;
END $$;

-- 2. Enums ----------------------------------------------------------------------
CREATE TYPE "CheckoutAttemptStatus" AS ENUM ('RESERVED','CONFIRMED','REJECTED','ABANDONED');
CREATE TYPE "CheckoutTenderSource" AS ENUM ('NEW','COLLECTION');
CREATE TYPE "CheckoutDeclarationOutcome" AS ENUM ('NONE','CHARGED','RETURNED');

-- 3. CheckoutAttempt --------------------------------------------------------------
-- The charge reservation never expires. Open = RESERVED, or REJECTED with
-- declaredAt NULL; at most one open attempt per sale (partial index below).
CREATE TABLE "CheckoutAttempt" (
  "id" TEXT NOT NULL,
  "saleId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "reserveKey" UUID NOT NULL,
  "operationKey" UUID NOT NULL,
  "planHash" CHAR(64) NOT NULL,
  "cashSessionId" TEXT NOT NULL,
  "balanceMethod" "PaymentMethod" NOT NULL,
  "expectedTotal" BIGINT NOT NULL,
  "expectedBalanceAmount" BIGINT NOT NULL,
  "tenderCount" INTEGER NOT NULL,
  "fullPriceCash" BIGINT NOT NULL,
  "fullPriceTransfer" BIGINT,
  "fullPriceDebit" BIGINT,
  "transferAdjustmentBps" INTEGER,
  "debitAdjustmentBps" INTEGER,
  "pricingConfigId" TEXT,
  "pricingConfigUpdatedAt" TIMESTAMPTZ(3),
  "algorithmVersion" INTEGER NOT NULL,
  "planSealed" BOOLEAN NOT NULL DEFAULT false,
  "status" "CheckoutAttemptStatus" NOT NULL DEFAULT 'RESERVED',
  "startedById" TEXT NOT NULL,
  "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Supervised recovery reservation (T-RR) justification; immutable (F1).
  "recoveryReason" TEXT,
  "recoveryEvidence" TEXT,
  "confirmationHash" CHAR(64),
  "confirmedById" TEXT,
  "confirmedAt" TIMESTAMPTZ(3),
  "confirmReason" TEXT,
  "confirmEvidence" TEXT,
  "rejectionCode" TEXT,
  "rejectionDetails" JSONB,
  "rejectedById" TEXT,
  "rejectedAt" TIMESTAMPTZ(3),
  "abandonedById" TEXT,
  "abandonedAt" TIMESTAMPTZ(3),
  "abandonReason" TEXT,
  "abandonEvidence" TEXT,
  "declaredById" TEXT,
  "declaredAt" TIMESTAMPTZ(3),

  CONSTRAINT "CheckoutAttempt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "chk_attempt_hashes" CHECK ("planHash" ~ '^[0-9a-f]{64}$'
    AND ("confirmationHash" IS NULL OR "confirmationHash" ~ '^[0-9a-f]{64}$')),
  CONSTRAINT "chk_attempt_plan" CHECK ("balanceMethod" IN ('CASH','TRANSFER','CARD_DEBIT')
    AND "expectedTotal" > 0 AND "expectedBalanceAmount" >= 100 AND "expectedBalanceAmount" % 100 = 0
    AND "tenderCount" BETWEEN 1 AND 3 AND "fullPriceCash" > 0 AND "fullPriceCash" % 100 = 0
    AND "algorithmVersion" = 1),
  -- Whole pricing-config snapshot or nothing (same shape as SaleCheckout).
  CONSTRAINT "chk_attempt_pricing_snapshot" CHECK (
    ("pricingConfigId" IS NULL AND "pricingConfigUpdatedAt" IS NULL
      AND "fullPriceTransfer" IS NULL AND "transferAdjustmentBps" IS NULL
      AND "fullPriceDebit" IS NULL AND "debitAdjustmentBps" IS NULL)
    OR ("pricingConfigId" IS NOT NULL AND "pricingConfigUpdatedAt" IS NOT NULL
      AND "fullPriceTransfer" IS NOT NULL AND "transferAdjustmentBps" IS NOT NULL
      AND "fullPriceDebit" IS NOT NULL AND "debitAdjustmentBps" IS NOT NULL
      AND "fullPriceTransfer" > 0 AND "fullPriceTransfer" % 100 = 0
      AND "fullPriceDebit" > 0 AND "fullPriceDebit" % 100 = 0
      AND "transferAdjustmentBps" BETWEEN 0 AND 10000 AND "debitAdjustmentBps" BETWEEN 0 AND 10000)),
  CONSTRAINT "chk_attempt_texts" CHECK (
    ("confirmReason" IS NULL OR char_length(btrim("confirmReason")) BETWEEN 10 AND 500)
    AND ("abandonReason" IS NULL OR char_length(btrim("abandonReason")) BETWEEN 10 AND 500)
    AND ("confirmEvidence" IS NULL OR char_length(btrim("confirmEvidence")) BETWEEN 3 AND 200)
    AND ("abandonEvidence" IS NULL OR char_length(btrim("abandonEvidence")) BETWEEN 3 AND 200)),
  -- Fields of each status. NULL-safe: every nullable column is guarded in each alternative.
  CONSTRAINT "chk_attempt_status_fields" CHECK (
    ("status" = 'RESERVED'
      AND "confirmationHash" IS NULL AND "confirmedById" IS NULL AND "confirmedAt" IS NULL
      AND "confirmReason" IS NULL AND "confirmEvidence" IS NULL
      AND "rejectionCode" IS NULL AND "rejectionDetails" IS NULL AND "rejectedById" IS NULL AND "rejectedAt" IS NULL
      AND "abandonedById" IS NULL AND "abandonedAt" IS NULL AND "abandonReason" IS NULL AND "abandonEvidence" IS NULL
      AND "declaredById" IS NULL AND "declaredAt" IS NULL)
    OR ("status" = 'CONFIRMED' AND "planSealed"
      AND "confirmationHash" IS NOT NULL AND "confirmedById" IS NOT NULL AND "confirmedAt" IS NOT NULL
      AND (("confirmedById" = "startedById" AND "confirmReason" IS NULL AND "confirmEvidence" IS NULL)
        OR ("confirmedById" <> "startedById" AND "confirmReason" IS NOT NULL AND "confirmEvidence" IS NOT NULL))
      AND "rejectionCode" IS NULL AND "rejectionDetails" IS NULL AND "rejectedById" IS NULL AND "rejectedAt" IS NULL
      AND "abandonedById" IS NULL AND "abandonedAt" IS NULL AND "abandonReason" IS NULL AND "abandonEvidence" IS NULL
      AND "declaredById" IS NULL AND "declaredAt" IS NULL)
    OR ("status" = 'REJECTED' AND "planSealed"
      AND "rejectionCode" IS NOT NULL AND "rejectionCode" ~ '^[A-Z][A-Z_]{2,63}$'
      AND "rejectedById" IS NOT NULL AND "rejectedAt" IS NOT NULL
      AND "confirmationHash" IS NULL AND "confirmedById" IS NULL AND "confirmedAt" IS NULL
      AND "confirmReason" IS NULL AND "confirmEvidence" IS NULL
      AND "abandonedById" IS NULL AND "abandonedAt" IS NULL AND "abandonReason" IS NULL AND "abandonEvidence" IS NULL
      AND (("declaredById" IS NULL AND "declaredAt" IS NULL) OR ("declaredById" IS NOT NULL AND "declaredAt" IS NOT NULL)))
    OR ("status" = 'ABANDONED' AND "planSealed"
      AND "abandonedById" IS NOT NULL AND "abandonedAt" IS NOT NULL
      AND ("abandonedById" = "startedById" OR ("abandonReason" IS NOT NULL AND "abandonEvidence" IS NOT NULL))
      AND "confirmationHash" IS NULL AND "confirmedById" IS NULL AND "confirmedAt" IS NULL
      AND "confirmReason" IS NULL AND "confirmEvidence" IS NULL
      AND "rejectionCode" IS NULL AND "rejectionDetails" IS NULL AND "rejectedById" IS NULL AND "rejectedAt" IS NULL
      AND (("declaredById" IS NULL AND "declaredAt" IS NULL) OR ("declaredById" IS NOT NULL AND "declaredAt" IS NOT NULL)))),
  CONSTRAINT "chk_attempt_recovery" CHECK (
    ("recoveryReason" IS NULL AND "recoveryEvidence" IS NULL)
    OR ("recoveryReason" IS NOT NULL AND char_length(btrim("recoveryReason")) BETWEEN 10 AND 500
      AND "recoveryEvidence" IS NOT NULL AND char_length(btrim("recoveryEvidence")) BETWEEN 3 AND 200))
);

CREATE UNIQUE INDEX "CheckoutAttempt_reserveKey_key" ON "CheckoutAttempt"("reserveKey");
CREATE UNIQUE INDEX "CheckoutAttempt_operationKey_key" ON "CheckoutAttempt"("operationKey");
CREATE UNIQUE INDEX "CheckoutAttempt_id_branchId_key" ON "CheckoutAttempt"("id","branchId");
CREATE UNIQUE INDEX "CheckoutAttempt_id_saleId_branchId_key" ON "CheckoutAttempt"("id","saleId","branchId");
CREATE UNIQUE INDEX "CheckoutAttempt_confirmation_key"
  ON "CheckoutAttempt"("operationKey","saleId","status","confirmationHash");
-- At most one open attempt per sale (RESERVED, or REJECTED not yet declared).
CREATE UNIQUE INDEX "CheckoutAttempt_one_open_per_sale" ON "CheckoutAttempt"("saleId")
  WHERE "status" IN ('RESERVED','REJECTED') AND "declaredAt" IS NULL;
-- Recent attempts per employee and branch (C4), independent of /sales/pending.
CREATE INDEX "CheckoutAttempt_branch_starter_time_idx" ON "CheckoutAttempt"("branchId","startedById","startedAt" DESC);
CREATE INDEX "CheckoutAttempt_branch_time_idx" ON "CheckoutAttempt"("branchId","startedAt" DESC);

ALTER TABLE "CheckoutAttempt" ADD CONSTRAINT "CheckoutAttempt_sale_branch_fkey"
  FOREIGN KEY ("saleId","branchId") REFERENCES "Sale"("id","branchId") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "CheckoutAttempt" ADD CONSTRAINT "CheckoutAttempt_cashSessionId_fkey"
  FOREIGN KEY ("cashSessionId") REFERENCES "CashSession"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "CheckoutAttempt" ADD CONSTRAINT "CheckoutAttempt_startedById_fkey"
  FOREIGN KEY ("startedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "CheckoutAttempt" ADD CONSTRAINT "CheckoutAttempt_confirmedById_fkey"
  FOREIGN KEY ("confirmedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "CheckoutAttempt" ADD CONSTRAINT "CheckoutAttempt_rejectedById_fkey"
  FOREIGN KEY ("rejectedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "CheckoutAttempt" ADD CONSTRAINT "CheckoutAttempt_abandonedById_fkey"
  FOREIGN KEY ("abandonedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "CheckoutAttempt" ADD CONSTRAINT "CheckoutAttempt_declaredById_fkey"
  FOREIGN KEY ("declaredById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- 4. ExternalCollection: origin attempt, claim and external refund ----------------
ALTER TABLE "ExternalCollection" ADD COLUMN "originAttemptId" TEXT;
ALTER TABLE "ExternalCollection" ADD COLUMN "claimAttemptId" TEXT;
ALTER TABLE "ExternalCollection" ADD COLUMN "externalRefundedAt" TIMESTAMPTZ(3);

-- Without originSaleId the origin FK would not be checked (MATCH SIMPLE).
ALTER TABLE "ExternalCollection" ADD CONSTRAINT "chk_ec_origin_attempt"
  CHECK ("originAttemptId" IS NULL OR "originSaleId" IS NOT NULL);
-- A claimed collection can never be REFUNDED.
ALTER TABLE "ExternalCollection" ADD CONSTRAINT "chk_ec_claim_state"
  CHECK ("status" <> 'REFUNDED' OR "claimAttemptId" IS NULL);
-- chk_ec_status (R3-A2) already requires resolvedById, resolvedAt and
-- refundReference on REFUNDED; this adds the reason, the external refund date
-- and the unclaimed state.
ALTER TABLE "ExternalCollection" ADD CONSTRAINT "chk_ec_refund_fields" CHECK (
  ("status" <> 'REFUNDED' AND "externalRefundedAt" IS NULL)
  OR ("status" = 'REFUNDED' AND "externalRefundedAt" IS NOT NULL AND "resolvedAt" IS NOT NULL
    AND "externalRefundedAt" <= "resolvedAt"
    AND "resolutionNote" IS NOT NULL AND char_length(btrim("resolutionNote")) BETWEEN 10 AND 500
    AND "claimAttemptId" IS NULL));

-- FK targets: a COLLECTION tender is the same collection (branch, method, exact
-- amount); a CHARGED declaration is the collection it recorded.
CREATE UNIQUE INDEX "ExternalCollection_id_branch_method_amount_key"
  ON "ExternalCollection"("id","branchId","method","amount");
CREATE UNIQUE INDEX "ExternalCollection_id_origin_attempt_key"
  ON "ExternalCollection"("id","originAttemptId","originSaleId","branchId","method");
CREATE INDEX "ExternalCollection_claimAttemptId_idx" ON "ExternalCollection"("claimAttemptId");

ALTER TABLE "ExternalCollection" ADD CONSTRAINT "ExternalCollection_origin_attempt_fkey"
  FOREIGN KEY ("originAttemptId","originSaleId","branchId")
  REFERENCES "CheckoutAttempt"("id","saleId","branchId") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ExternalCollection" ADD CONSTRAINT "ExternalCollection_claim_fkey"
  FOREIGN KEY ("claimAttemptId","branchId") REFERENCES "CheckoutAttempt"("id","branchId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- 5. CheckoutAttemptTender (the sealed plan) ----------------------------------------
CREATE TABLE "CheckoutAttemptTender" (
  "id" TEXT NOT NULL,
  "attemptId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "method" "PaymentMethod" NOT NULL,
  "role" "CheckoutTenderRole" NOT NULL,
  "source" "CheckoutTenderSource" NOT NULL,
  "amount" BIGINT,
  "externalCollectionId" TEXT,

  CONSTRAINT "CheckoutAttemptTender_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "chk_tender_shape" CHECK ("method" IN ('CASH','TRANSFER','CARD_DEBIT') AND (
    ("role" = 'BALANCE' AND "source" = 'NEW' AND "amount" IS NULL AND "externalCollectionId" IS NULL)
    OR ("role" = 'FIXED' AND "source" = 'NEW' AND "amount" IS NOT NULL AND "amount" > 0
      AND "externalCollectionId" IS NULL)
    OR ("role" = 'FIXED' AND "source" = 'COLLECTION' AND "method" IN ('TRANSFER','CARD_DEBIT')
      AND "amount" IS NOT NULL AND "amount" > 0 AND "externalCollectionId" IS NOT NULL)))
);

CREATE UNIQUE INDEX "CheckoutAttemptTender_attempt_method_key" ON "CheckoutAttemptTender"("attemptId","method");
CREATE UNIQUE INDEX "CheckoutAttemptTender_attempt_method_source_key"
  ON "CheckoutAttemptTender"("attemptId","method","source");
CREATE UNIQUE INDEX "CheckoutAttemptTender_one_balance" ON "CheckoutAttemptTender"("attemptId") WHERE "role" = 'BALANCE';

ALTER TABLE "CheckoutAttemptTender" ADD CONSTRAINT "CheckoutAttemptTender_attempt_fkey"
  FOREIGN KEY ("attemptId","branchId") REFERENCES "CheckoutAttempt"("id","branchId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- A COLLECTION tender is the same collection: same branch, method and exact amount.
ALTER TABLE "CheckoutAttemptTender" ADD CONSTRAINT "CheckoutAttemptTender_collection_fkey"
  FOREIGN KEY ("externalCollectionId","branchId","method","amount")
  REFERENCES "ExternalCollection"("id","branchId","method","amount") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- 6. CheckoutAttemptDeclaration ---------------------------------------------------
-- One row per tender of a terminal (REJECTED/ABANDONED) attempt. CASH: NONE or
-- RETURNED; TRANSFER/CARD_DEBIT: NONE, or CHARGED only for a NEW tender (C2: a
-- COLLECTION tender is never CHARGED).
CREATE TABLE "CheckoutAttemptDeclaration" (
  "id" TEXT NOT NULL,
  "attemptId" TEXT NOT NULL,
  "saleId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "method" "PaymentMethod" NOT NULL,
  "tenderSource" "CheckoutTenderSource" NOT NULL,
  "outcome" "CheckoutDeclarationOutcome" NOT NULL,
  "externalCollectionId" TEXT,
  "returnedAmount" BIGINT,
  "evidence" TEXT,
  "declaredById" TEXT NOT NULL,
  "declaredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CheckoutAttemptDeclaration_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "chk_declaration_shape" CHECK (
    ("method" = 'CASH' AND "tenderSource" = 'NEW' AND "outcome" = 'NONE'
      AND "externalCollectionId" IS NULL AND "returnedAmount" IS NULL)
    OR ("method" = 'CASH' AND "tenderSource" = 'NEW' AND "outcome" = 'RETURNED'
      AND "externalCollectionId" IS NULL AND "returnedAmount" IS NOT NULL AND "returnedAmount" > 0
      AND "evidence" IS NOT NULL)
    OR ("method" IN ('TRANSFER','CARD_DEBIT') AND "outcome" = 'NONE'
      AND "externalCollectionId" IS NULL AND "returnedAmount" IS NULL)
    OR ("method" IN ('TRANSFER','CARD_DEBIT') AND "tenderSource" = 'NEW' AND "outcome" = 'CHARGED'
      AND "externalCollectionId" IS NOT NULL AND "returnedAmount" IS NULL AND "evidence" IS NOT NULL)),
  CONSTRAINT "chk_declaration_evidence" CHECK ("evidence" IS NULL OR char_length(btrim("evidence")) BETWEEN 3 AND 200)
);

CREATE UNIQUE INDEX "CheckoutAttemptDeclaration_attempt_method_key" ON "CheckoutAttemptDeclaration"("attemptId","method");
CREATE UNIQUE INDEX "CheckoutAttemptDeclaration_externalCollectionId_key" ON "CheckoutAttemptDeclaration"("externalCollectionId");

-- The declared tender, with its source (C2).
ALTER TABLE "CheckoutAttemptDeclaration" ADD CONSTRAINT "CheckoutAttemptDeclaration_tender_fkey"
  FOREIGN KEY ("attemptId","method","tenderSource")
  REFERENCES "CheckoutAttemptTender"("attemptId","method","source") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "CheckoutAttemptDeclaration" ADD CONSTRAINT "CheckoutAttemptDeclaration_attempt_fkey"
  FOREIGN KEY ("attemptId","saleId","branchId") REFERENCES "CheckoutAttempt"("id","saleId","branchId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- CHARGED: same attempt, sale, branch and method as the collection it recorded.
ALTER TABLE "CheckoutAttemptDeclaration" ADD CONSTRAINT "CheckoutAttemptDeclaration_collection_fkey"
  FOREIGN KEY ("externalCollectionId","attemptId","saleId","branchId","method")
  REFERENCES "ExternalCollection"("id","originAttemptId","originSaleId","branchId","method")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "CheckoutAttemptDeclaration" ADD CONSTRAINT "CheckoutAttemptDeclaration_declaredById_fkey"
  FOREIGN KEY ("declaredById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- 7. SaleCheckout ↔ attempt -------------------------------------------------------
-- No checkout without a CONFIRMED attempt carrying the same hash; ON UPDATE
-- RESTRICT (and F1) freezes that attempt.
ALTER TABLE "SaleCheckout" ADD COLUMN "attemptStatus" "CheckoutAttemptStatus" NOT NULL DEFAULT 'CONFIRMED';
ALTER TABLE "SaleCheckout" ADD CONSTRAINT "chk_checkout_attempt_status" CHECK ("attemptStatus" = 'CONFIRMED');
CREATE UNIQUE INDEX "SaleCheckout_attempt_link_key"
  ON "SaleCheckout"("operationKey","saleId","attemptStatus","requestHash");
ALTER TABLE "SaleCheckout" ADD CONSTRAINT "SaleCheckout_attempt_fkey"
  FOREIGN KEY ("operationKey","saleId","attemptStatus","requestHash")
  REFERENCES "CheckoutAttempt"("operationKey","saleId","status","confirmationHash")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- 8. Functions and triggers -------------------------------------------------------

-- F1: no delete; the plan, the pricing snapshot and the recovery justification
-- never change; planSealed only false → true while RESERVED; status only
-- RESERVED → CONFIRMED | REJECTED | ABANDONED; the outcome columns are frozen
-- once out of RESERVED; the declaration is written once, only when terminal
-- (REJECTED or ABANDONED).
CREATE FUNCTION public."fn_checkout_attempt_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'CheckoutAttempt rows are permanent' USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW."id", NEW."saleId", NEW."branchId", NEW."reserveKey", NEW."operationKey", NEW."planHash",
      NEW."cashSessionId", NEW."balanceMethod", NEW."expectedTotal", NEW."expectedBalanceAmount",
      NEW."tenderCount", NEW."fullPriceCash", NEW."fullPriceTransfer", NEW."fullPriceDebit",
      NEW."transferAdjustmentBps", NEW."debitAdjustmentBps", NEW."pricingConfigId",
      NEW."pricingConfigUpdatedAt", NEW."algorithmVersion", NEW."startedById", NEW."startedAt",
      NEW."recoveryReason", NEW."recoveryEvidence")
     IS DISTINCT FROM
     (OLD."id", OLD."saleId", OLD."branchId", OLD."reserveKey", OLD."operationKey", OLD."planHash",
      OLD."cashSessionId", OLD."balanceMethod", OLD."expectedTotal", OLD."expectedBalanceAmount",
      OLD."tenderCount", OLD."fullPriceCash", OLD."fullPriceTransfer", OLD."fullPriceDebit",
      OLD."transferAdjustmentBps", OLD."debitAdjustmentBps", OLD."pricingConfigId",
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

CREATE TRIGGER "trg_checkout_attempt_guard" BEFORE UPDATE OR DELETE
ON public."CheckoutAttempt" FOR EACH ROW EXECUTE FUNCTION public."fn_checkout_attempt_guard"();

-- F2: tenders are insert-only, and only into an unsealed RESERVED attempt
-- (no late tenders).
CREATE FUNCTION public."fn_checkout_attempt_tender_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE a_status public."CheckoutAttemptStatus"; a_sealed boolean;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'CheckoutAttemptTender rows are immutable' USING ERRCODE = 'check_violation';
  END IF;
  SELECT "status", "planSealed" INTO a_status, a_sealed
    FROM public."CheckoutAttempt" WHERE "id" = NEW."attemptId" FOR UPDATE;
  IF a_status IS DISTINCT FROM 'RESERVED' OR a_sealed IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'Tenders are added only to an unsealed RESERVED attempt' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "trg_checkout_attempt_tender_guard" BEFORE INSERT OR UPDATE OR DELETE
ON public."CheckoutAttemptTender" FOR EACH ROW EXECUTE FUNCTION public."fn_checkout_attempt_tender_guard"();

-- F3: deferred to COMMIT; rereads the current row. Sealed and complete plan
-- with one BALANCE in balanceMethod; ABANDONED implies declared; a declaration
-- covers every tender by one actor, and its CHARGED collections were recorded
-- by that actor for this attempt; the claim state of the COLLECTION tenders
-- matches the status.
CREATE FUNCTION public."fn_checkout_attempt_commit_check"() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE a public."CheckoutAttempt"%ROWTYPE; n_tenders bigint; n_balance bigint; n_decl bigint; n_bad bigint;
BEGIN
  SELECT * INTO a FROM public."CheckoutAttempt" WHERE "id" = NEW."id";
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT count(*), count(*) FILTER (WHERE "role" = 'BALANCE' AND "method" = a."balanceMethod")
    INTO n_tenders, n_balance FROM public."CheckoutAttemptTender" WHERE "attemptId" = a."id";
  IF a."planSealed" IS NOT TRUE OR n_tenders <> a."tenderCount" OR n_balance <> 1 THEN
    RAISE EXCEPTION 'CheckoutAttempt plan incomplete at commit' USING ERRCODE = 'check_violation';
  END IF;
  IF a."status" = 'ABANDONED' AND a."declaredAt" IS NULL THEN
    RAISE EXCEPTION 'ABANDONED attempt requires a declaration' USING ERRCODE = 'check_violation';
  END IF;
  IF a."declaredAt" IS NOT NULL THEN
    SELECT count(*) INTO n_decl FROM public."CheckoutAttemptDeclaration" WHERE "attemptId" = a."id";
    SELECT count(*) INTO n_bad
      FROM public."CheckoutAttemptDeclaration" d
      LEFT JOIN public."ExternalCollection" e ON e."id" = d."externalCollectionId"
     WHERE d."attemptId" = a."id"
       AND (d."declaredById" <> a."declaredById"
            OR (d."outcome" = 'CHARGED'
                AND (e."id" IS NULL OR e."recordedById" <> a."declaredById"
                     OR e."originAttemptId" IS DISTINCT FROM a."id")));
    IF n_decl <> a."tenderCount" OR n_bad <> 0 THEN
      RAISE EXCEPTION 'Declaration must cover every tender, by the declaring actor' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  -- Claim state of the COLLECTION tenders.
  IF a."status" = 'RESERVED' OR (a."status" = 'REJECTED' AND a."declaredAt" IS NULL) THEN
    SELECT count(*) INTO n_bad
      FROM public."CheckoutAttemptTender" t
      LEFT JOIN public."ExternalCollection" e ON e."id" = t."externalCollectionId"
     WHERE t."attemptId" = a."id" AND t."source" = 'COLLECTION'
       AND (e."id" IS NULL OR e."claimAttemptId" IS DISTINCT FROM a."id" OR e."status" <> 'UNAPPLIED');
    IF n_bad <> 0 THEN
      RAISE EXCEPTION 'An open attempt must hold an UNAPPLIED claim on each COLLECTION tender' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF a."status" = 'CONFIRMED' THEN
    SELECT count(*) INTO n_bad
      FROM public."CheckoutAttemptTender" t
      LEFT JOIN public."ExternalCollection" e ON e."id" = t."externalCollectionId"
     WHERE t."attemptId" = a."id" AND t."source" = 'COLLECTION'
       AND (e."id" IS NULL OR e."claimAttemptId" IS DISTINCT FROM a."id" OR e."status" <> 'APPLIED');
    IF n_bad <> 0 THEN
      RAISE EXCEPTION 'A CONFIRMED attempt must have applied each claimed COLLECTION tender' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM public."ExternalCollection" WHERE "claimAttemptId" = a."id") THEN
      RAISE EXCEPTION 'A declared terminal attempt must not hold any claim' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER "trg_checkout_attempt_commit_check" AFTER INSERT OR UPDATE
ON public."CheckoutAttempt" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public."fn_checkout_attempt_commit_check"();

-- F4: declarations are insert-only, only into a terminal attempt not yet
-- declared; a non-initiator needs evidence; CHARGED needs an UNAPPLIED
-- collection recorded by the declarer. Lock order: attempt → collection.
CREATE FUNCTION public."fn_checkout_attempt_declaration_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE a_status public."CheckoutAttemptStatus"; a_declared timestamptz; a_starter text;
        e_status public."ExternalCollectionStatus"; e_recorder text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'CheckoutAttemptDeclaration rows are immutable' USING ERRCODE = 'check_violation';
  END IF;
  SELECT "status", "declaredAt", "startedById" INTO a_status, a_declared, a_starter
    FROM public."CheckoutAttempt" WHERE "id" = NEW."attemptId" FOR UPDATE;
  IF a_status IS NULL OR a_status NOT IN ('REJECTED','ABANDONED') OR a_declared IS NOT NULL THEN
    RAISE EXCEPTION 'CheckoutAttempt is not open for declaration' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."declaredById" <> a_starter AND NEW."evidence" IS NULL THEN
    RAISE EXCEPTION 'A non-initiator declaration requires evidence' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."outcome" = 'CHARGED' THEN
    SELECT "status", "recordedById" INTO e_status, e_recorder
      FROM public."ExternalCollection" WHERE "id" = NEW."externalCollectionId" FOR UPDATE;
    IF e_status IS DISTINCT FROM 'UNAPPLIED' OR e_recorder IS DISTINCT FROM NEW."declaredById" THEN
      RAISE EXCEPTION 'CHARGED requires an UNAPPLIED collection recorded by the declarer' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "trg_checkout_attempt_declaration_guard" BEFORE INSERT OR UPDATE OR DELETE
ON public."CheckoutAttemptDeclaration" FOR EACH ROW EXECUTE FUNCTION public."fn_checkout_attempt_declaration_guard"();

-- F5: deferred to COMMIT; no loose declaration without its attempt's declaredAt.
CREATE FUNCTION public."fn_checkout_declaration_commit_check"() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE a_declared timestamptz;
BEGIN
  SELECT "declaredAt" INTO a_declared FROM public."CheckoutAttempt" WHERE "id" = NEW."attemptId";
  IF a_declared IS NULL THEN
    RAISE EXCEPTION 'A declaration requires its attempt to be declared at commit' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER "trg_checkout_declaration_commit_check" AFTER INSERT
ON public."CheckoutAttemptDeclaration" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public."fn_checkout_declaration_commit_check"();

-- F6: ExternalCollection rows are permanent; financial and origin data are
-- immutable; the resolution is written once (with the status change); status
-- only UNAPPLIED → APPLIED (by the checkout of the claiming attempt) or
-- UNAPPLIED → REFUNDED (unclaimed; terminal). The claim (claimAttemptId) only
-- changes while UNAPPLIED: NULL → X from X's own unsealed RESERVED plan that
-- holds this collection as COLLECTION; X → NULL once X is terminal and
-- declared; never X → Y.
CREATE FUNCTION public."fn_external_collection_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ExternalCollection rows are permanent' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" NOT IN ('APPLIED','UNAPPLIED') THEN
      RAISE EXCEPTION 'A collection starts APPLIED or UNAPPLIED' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."claimAttemptId" IS NOT NULL THEN
      RAISE EXCEPTION 'A collection is never inserted claimed' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."originAttemptId" IS NOT NULL AND (NEW."status" <> 'UNAPPLIED' OR NEW."appliedCheckoutId" IS NOT NULL) THEN
      RAISE EXCEPTION 'A declared collection starts UNAPPLIED' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW."id", NEW."branchId", NEW."method", NEW."amount", NEW."reference", NEW."referenceKey",
      NEW."institution", NEW."institutionOther", NEW."originSaleId", NEW."originAttemptId",
      NEW."cashSessionId", NEW."recordedById", NEW."recordedAt", NEW."incidentReason")
     IS DISTINCT FROM
     (OLD."id", OLD."branchId", OLD."method", OLD."amount", OLD."reference", OLD."referenceKey",
      OLD."institution", OLD."institutionOther", OLD."originSaleId", OLD."originAttemptId",
      OLD."cashSessionId", OLD."recordedById", OLD."recordedAt", OLD."incidentReason") THEN
    RAISE EXCEPTION 'ExternalCollection financial and origin data are immutable' USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."claimAttemptId" IS DISTINCT FROM OLD."claimAttemptId" THEN
    IF OLD."status" <> 'UNAPPLIED' OR NEW."status" <> 'UNAPPLIED' THEN
      RAISE EXCEPTION 'Claim changes only while UNAPPLIED' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD."claimAttemptId" IS NULL THEN
      -- NULL → X: only the transaction creating X, before sealing its plan, and
      -- only if X's plan holds THIS collection as a COLLECTION tender.
      IF NOT EXISTS (
        SELECT 1
          FROM public."CheckoutAttempt" a
          JOIN public."CheckoutAttemptTender" t ON t."attemptId" = a."id"
         WHERE a."id" = NEW."claimAttemptId"
           AND a."status" = 'RESERVED'
           AND a."planSealed" = false
           AND t."source" = 'COLLECTION'
           AND t."externalCollectionId" = NEW."id")
      THEN
        RAISE EXCEPTION 'Claim requires an unsealed RESERVED plan with this collection as COLLECTION'
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF NEW."claimAttemptId" IS NULL THEN
      -- X → NULL: only once X is terminal (not confirmed) AND already declared.
      IF NOT EXISTS (
        SELECT 1 FROM public."CheckoutAttempt" a
         WHERE a."id" = OLD."claimAttemptId"
           AND a."status" IN ('REJECTED','ABANDONED')
           AND a."declaredAt" IS NOT NULL)
      THEN
        RAISE EXCEPTION 'Claim release requires a completed declaration' USING ERRCODE = 'check_violation';
      END IF;
    ELSE
      RAISE EXCEPTION 'Claim cannot move between attempts' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW."status" IS DISTINCT FROM OLD."status" THEN
    IF NOT (OLD."status" = 'UNAPPLIED' AND NEW."status" IN ('APPLIED','REFUNDED')) THEN
      RAISE EXCEPTION 'ExternalCollection status transition not allowed' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" = 'APPLIED' AND NOT EXISTS (
      SELECT 1
        FROM public."SaleCheckout" sc
        JOIN public."CheckoutAttempt" a ON a."id" = OLD."claimAttemptId"
       WHERE sc."id" = NEW."appliedCheckoutId"
         AND sc."operationKey" = a."operationKey")
    THEN
      RAISE EXCEPTION 'Only the checkout of the claiming attempt applies a collection' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."status" = 'REFUNDED' AND (OLD."claimAttemptId" IS NOT NULL OR NEW."claimAttemptId" IS NOT NULL) THEN
      RAISE EXCEPTION 'A claimed collection cannot be refunded' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF (NEW."appliedCheckoutId", NEW."appliedSaleId", NEW."resolvedById", NEW."resolvedAt",
         NEW."refundReference", NEW."resolutionNote", NEW."externalRefundedAt")
        IS DISTINCT FROM
        (OLD."appliedCheckoutId", OLD."appliedSaleId", OLD."resolvedById", OLD."resolvedAt",
         OLD."refundReference", OLD."resolutionNote", OLD."externalRefundedAt") THEN
    RAISE EXCEPTION 'ExternalCollection resolution is write-once' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "trg_external_collection_guard" BEFORE INSERT OR UPDATE OR DELETE
ON public."ExternalCollection" FOR EACH ROW EXECUTE FUNCTION public."fn_external_collection_guard"();

COMMIT;
