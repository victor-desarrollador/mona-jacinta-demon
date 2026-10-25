-- Sale void v1 (post-payment void), step B of 2: SaleVoid, SaleVoidExternalRefund and the
-- CashMovement / StockMovement links.
--
-- Additive only; depends on step A (20261024120000_sale_void_enum) being committed.
-- Every existing row is untouched: the two new columns stay NULL, so the unique indexes
-- (NULLs distinct), the composite FK (MATCH SIMPLE: a NULL column skips the check) and every
-- CHECK (text guard, `type::text <> '<new label>' OR ...`) accept all historical and N-1 rows.
-- No applied migration is rewritten.
--
-- A void is append-only history: nothing here updates or deletes a SalePayment, a SALE_INCOME
-- CashMovement, a SALE StockMovement or an ExternalCollection. The CHECKs are SQL-only (Prisma
-- has no @@check); the tables, indexes and FKs are mirrored exactly in schema.prisma.
--
-- Database guard of a cash refund (section 6): the payment a SALE_REFUND points at must be a CASH
-- payment with EXACTLY the refund's amount, and a refunded payment can no longer change method or
-- amount. A foreign key alone only proves the payment exists, and the pair (method, amount) cannot
-- be a composite FK without a redundant column, so two row triggers do it (same SECURITY INVOKER /
-- fixed search_path convention as the R3 guards). Rows of every other CashMovement type never fire
-- it (WHEN on the new type). What stays with the void service: that the payment belongs to the
-- voided sale, and that the refund lands in an OPEN session of the sale's branch.
-- Idempotency has no key of its own: it is resolved against the sale's single SaleVoid
-- (UNIQUE(saleId)).

-- 1. Tables ------------------------------------------------------------------------
CREATE TABLE "SaleVoid" (
  "id" TEXT NOT NULL,
  "saleId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "previousStatus" "SaleStatus" NOT NULL,
  "reason" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "voidedById" TEXT NOT NULL,
  "voidedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "SaleVoid_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SaleVoidExternalRefund" (
  "id" TEXT NOT NULL,
  "saleVoidId" TEXT NOT NULL,
  "saleId" TEXT NOT NULL,
  "salePaymentId" TEXT NOT NULL,
  "method" "PaymentMethod" NOT NULL,
  "amount" BIGINT NOT NULL,
  "evidence" TEXT NOT NULL,

  CONSTRAINT "SaleVoidExternalRefund_pkey" PRIMARY KEY ("id")
);

-- 2. Columns on the two ledgers -------------------------------------------------------
ALTER TABLE "StockMovement" ADD COLUMN "saleVoidId" TEXT;
ALTER TABLE "CashMovement" ADD COLUMN "refundOfSalePaymentId" TEXT;

-- 3. Indexes ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "SaleVoid_saleId_key" ON "SaleVoid"("saleId");
CREATE UNIQUE INDEX "SaleVoid_saleId_branchId_key" ON "SaleVoid"("saleId", "branchId");
-- Candidate keys of the StockMovement and SaleVoidExternalRefund composite FKs.
CREATE UNIQUE INDEX "SaleVoid_id_saleId_branchId_key" ON "SaleVoid"("id", "saleId", "branchId");
CREATE UNIQUE INDEX "SaleVoid_id_saleId_key" ON "SaleVoid"("id", "saleId");
CREATE INDEX "SaleVoid_branchId_voidedAt_idx" ON "SaleVoid"("branchId", "voidedAt");
CREATE INDEX "SaleVoid_voidedById_idx" ON "SaleVoid"("voidedById");

-- A payment is evidenced at most once.
CREATE UNIQUE INDEX "SaleVoidExternalRefund_salePaymentId_key" ON "SaleVoidExternalRefund"("salePaymentId");
CREATE INDEX "SaleVoidExternalRefund_saleVoidId_idx" ON "SaleVoidExternalRefund"("saleVoidId");
-- Candidate key of SaleVoidExternalRefund_payment_fkey (same sale, same method, same amount).
CREATE UNIQUE INDEX "SalePayment_id_saleId_method_amount_key" ON "SalePayment"("id", "saleId", "method", "amount");

-- At most one return movement per inventory row per void. NULL saleVoidId is distinct, so
-- SALE / INITIAL_STOCK / ADJUSTMENT rows never conflict.
CREATE UNIQUE INDEX "StockMovement_saleVoidId_inventoryId_key" ON "StockMovement"("saleVoidId", "inventoryId");
CREATE INDEX "StockMovement_saleVoidId_idx" ON "StockMovement"("saleVoidId");

-- At most one cash refund per payment. NULL is distinct: every other movement is unaffected.
CREATE UNIQUE INDEX "CashMovement_refundOfSalePaymentId_key" ON "CashMovement"("refundOfSalePaymentId");

-- 4. Foreign keys ----------------------------------------------------------------------
ALTER TABLE "SaleVoid" ADD CONSTRAINT "SaleVoid_sale_branch_fkey"
  FOREIGN KEY ("saleId", "branchId") REFERENCES "Sale"("id", "branchId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "SaleVoid" ADD CONSTRAINT "SaleVoid_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SaleVoid" ADD CONSTRAINT "SaleVoid_voidedById_fkey"
  FOREIGN KEY ("voidedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The evidence belongs to a void of the SAME sale, and to a payment of that sale whose method
-- and amount it snapshots (the payment is never edited).
ALTER TABLE "SaleVoidExternalRefund" ADD CONSTRAINT "SaleVoidExternalRefund_void_sale_fkey"
  FOREIGN KEY ("saleVoidId", "saleId") REFERENCES "SaleVoid"("id", "saleId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "SaleVoidExternalRefund" ADD CONSTRAINT "SaleVoidExternalRefund_payment_fkey"
  FOREIGN KEY ("salePaymentId", "saleId", "method", "amount") REFERENCES "SalePayment"("id", "saleId", "method", "amount")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- A return movement can only belong to the void of ITS OWN sale and branch.
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_saleVoid_sale_branch_fkey"
  FOREIGN KEY ("saleVoidId", "saleId", "branchId") REFERENCES "SaleVoid"("id", "saleId", "branchId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- A cash refund points at the payment it returns.
ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_refundOfSalePaymentId_fkey"
  FOREIGN KEY ("refundOfSalePaymentId") REFERENCES "SalePayment"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- 5. CHECKs ----------------------------------------------------------------------------
ALTER TABLE "SaleVoid" ADD CONSTRAINT "chk_sale_void_previous_status"
  CHECK ("previousStatus"::text IN ('PAID', 'COMPLETED')) NOT VALID;
ALTER TABLE "SaleVoid" ADD CONSTRAINT "chk_sale_void_reason_not_blank"
  CHECK (btrim("reason") <> '') NOT VALID;
ALTER TABLE "SaleVoid" ADD CONSTRAINT "chk_sale_void_reason_length"
  CHECK (char_length("reason") <= 200) NOT VALID;
ALTER TABLE "SaleVoid" ADD CONSTRAINT "chk_sale_void_idempotency_key_not_blank"
  CHECK (btrim("idempotencyKey") <> '') NOT VALID;

-- Cash goes back as SALE_REFUND, never as external evidence.
ALTER TABLE "SaleVoidExternalRefund" ADD CONSTRAINT "chk_sale_void_external_refund_method"
  CHECK ("method"::text <> 'CASH') NOT VALID;
ALTER TABLE "SaleVoidExternalRefund" ADD CONSTRAINT "chk_sale_void_external_refund_amount"
  CHECK ("amount" > 0) NOT VALID;
ALTER TABLE "SaleVoidExternalRefund" ADD CONSTRAINT "chk_sale_void_external_refund_evidence"
  CHECK (btrim("evidence") <> '' AND char_length("evidence") <= 200) NOT VALID;

-- A SALE_VOID row is a positive return tied to a void AND to the original sale; only a
-- SALE_VOID may carry a saleVoidId.
ALTER TABLE "StockMovement" ADD CONSTRAINT "chk_stock_movement_sale_void_shape"
  CHECK ("type"::text <> 'SALE_VOID'
         OR ("saleVoidId" IS NOT NULL AND "saleId" IS NOT NULL AND "quantityDelta" > 0)) NOT VALID;
ALTER TABLE "StockMovement" ADD CONSTRAINT "chk_stock_movement_sale_void_only"
  CHECK ("type"::text = 'SALE_VOID' OR "saleVoidId" IS NULL) NOT VALID;

-- A SALE_REFUND <=> a link to the refunded payment; a refund is a positive amount and never
-- carries salePaymentId (that unique column belongs to the payment's SALE_INCOME).
ALTER TABLE "CashMovement" ADD CONSTRAINT "chk_cash_movement_refund_link"
  CHECK (("type"::text = 'SALE_REFUND') = ("refundOfSalePaymentId" IS NOT NULL)) NOT VALID;
ALTER TABLE "CashMovement" ADD CONSTRAINT "chk_cash_movement_refund_shape"
  CHECK ("type"::text <> 'SALE_REFUND' OR ("amount" > 0 AND "salePaymentId" IS NULL)) NOT VALID;

-- 6. Database guard of SALE_REFUND -----------------------------------------------------
-- The referenced SalePayment must exist, be CASH and have amount = the refund's amount. The row
-- is locked FOR SHARE so a concurrent change of that payment waits for this transaction. The
-- shape CHECKs above still run (missing link, salePaymentId, non-positive amount).
CREATE FUNCTION public."fn_cash_movement_refund_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  payment_method text;
  payment_amount bigint;
BEGIN
  IF NEW."refundOfSalePaymentId" IS NULL THEN
    RETURN NEW; -- chk_cash_movement_refund_link refuses a refund without its link
  END IF;
  SELECT p."method"::text, p."amount" INTO payment_method, payment_amount
  FROM public."SalePayment" p WHERE p."id" = NEW."refundOfSalePaymentId" FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'chk_cash_movement_refund_payment: the refunded SalePayment does not exist'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF payment_method <> 'CASH' THEN
    RAISE EXCEPTION 'chk_cash_movement_refund_payment: a SALE_REFUND may only return a CASH payment'
      USING ERRCODE = 'check_violation';
  END IF;
  IF payment_amount <> NEW."amount" THEN
    RAISE EXCEPTION 'chk_cash_movement_refund_payment: the refund amount must equal the payment amount'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "trg_cash_movement_refund_guard" BEFORE INSERT OR UPDATE
ON public."CashMovement" FOR EACH ROW WHEN (NEW."type"::text = 'SALE_REFUND')
EXECUTE FUNCTION public."fn_cash_movement_refund_guard"();

-- Once a payment has been refunded its method and amount are frozen, so the guard above cannot be
-- bypassed by editing the payment afterwards. Other columns (and unrefunded payments) stay editable.
CREATE FUNCTION public."fn_sale_payment_refund_frozen"() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public."CashMovement" m WHERE m."refundOfSalePaymentId" = OLD."id") THEN
    RAISE EXCEPTION 'trg_sale_payment_refund_frozen: a refunded SalePayment cannot change method or amount'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "trg_sale_payment_refund_frozen" BEFORE UPDATE OF "method", "amount"
ON public."SalePayment" FOR EACH ROW
WHEN (OLD."method" IS DISTINCT FROM NEW."method" OR OLD."amount" IS DISTINCT FROM NEW."amount")
EXECUTE FUNCTION public."fn_sale_payment_refund_frozen"();

ALTER TABLE "SaleVoid" VALIDATE CONSTRAINT "chk_sale_void_previous_status";
ALTER TABLE "SaleVoid" VALIDATE CONSTRAINT "chk_sale_void_reason_not_blank";
ALTER TABLE "SaleVoid" VALIDATE CONSTRAINT "chk_sale_void_reason_length";
ALTER TABLE "SaleVoid" VALIDATE CONSTRAINT "chk_sale_void_idempotency_key_not_blank";
ALTER TABLE "SaleVoidExternalRefund" VALIDATE CONSTRAINT "chk_sale_void_external_refund_method";
ALTER TABLE "SaleVoidExternalRefund" VALIDATE CONSTRAINT "chk_sale_void_external_refund_amount";
ALTER TABLE "SaleVoidExternalRefund" VALIDATE CONSTRAINT "chk_sale_void_external_refund_evidence";
ALTER TABLE "StockMovement" VALIDATE CONSTRAINT "chk_stock_movement_sale_void_shape";
ALTER TABLE "StockMovement" VALIDATE CONSTRAINT "chk_stock_movement_sale_void_only";
ALTER TABLE "CashMovement" VALIDATE CONSTRAINT "chk_cash_movement_refund_link";
ALTER TABLE "CashMovement" VALIDATE CONSTRAINT "chk_cash_movement_refund_shape";
