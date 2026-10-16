-- R3 proportional checkout (design rev. 2): additive schema.
--
-- Additive only: it adds columns with defaults, new tables, indexes and FKs. It
-- never rewrites rows, drops anything or touches an applied migration, and it
-- adds no functions or triggers (the protected function set is unchanged).
--
-- Prisma mirrors this migration: the tables, columns, unique indexes and foreign
-- keys below are reproduced exactly by `prisma migrate diff
-- --from-schema <previous> --to-schema prisma/schema.prisma`. The CHECK
-- constraints and the partial unique indexes are SQL-only (Prisma has no
-- @@check and no partial-index syntax), as with the cash_session_one_open_
-- per_register / uq_user_role_scope_* precedents.
--
-- Every CHECK is NULL-safe: each alternative guards with IS NULL / IS NOT NULL
-- every nullable column, so an invalid row can never evaluate to NULL and slip
-- through the control.

-- 1. Enums ---------------------------------------------------------------------
CREATE TYPE "SalePricingModel" AS ENUM ('FIXED_TOTAL', 'PROPORTIONAL_V1');
CREATE TYPE "CheckoutTenderRole" AS ENUM ('FIXED', 'BALANCE');
CREATE TYPE "TransferInstitution" AS ENUM ('MACRO', 'BBVA', 'NACION', 'GALICIA', 'MERCADO_PAGO', 'OTHER');
CREATE TYPE "ExternalCollectionStatus" AS ENUM ('APPLIED', 'UNAPPLIED', 'REFUNDED');

-- 2. Sale: durable checkout-path selector --------------------------------------
-- Existing rows and any write from an N-1 API receive FIXED_TOTAL by default.
ALTER TABLE "Sale" ADD COLUMN "pricingModel" "SalePricingModel" NOT NULL DEFAULT 'FIXED_TOTAL';

-- A proportional sale may only be priced CASH (one price mode per sale).
ALTER TABLE "Sale" ADD CONSTRAINT "chk_sale_proportional_cash_mode"
  CHECK ("pricingModel" = 'FIXED_TOTAL' OR "priceMode" = 'CASH');

-- 3. SaleCheckout --------------------------------------------------------------
CREATE TABLE "SaleCheckout" (
  "id" TEXT NOT NULL,
  "saleId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "pricingModel" "SalePricingModel" NOT NULL,
  "operationKey" UUID NOT NULL,
  "requestHash" CHAR(64) NOT NULL,
  "cashSessionId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "balanceMethod" "PaymentMethod" NOT NULL,
  "referenceSubtotal" BIGINT NOT NULL,
  "total" BIGINT NOT NULL,
  "changeAmount" BIGINT NOT NULL DEFAULT 0,
  "fullPriceCash" BIGINT NOT NULL,
  "fullPriceTransfer" BIGINT,
  "fullPriceDebit" BIGINT,
  "transferAdjustmentBps" INTEGER,
  "debitAdjustmentBps" INTEGER,
  "pricingConfigId" TEXT,
  "pricingConfigUpdatedAt" TIMESTAMPTZ(3),
  "algorithmVersion" INTEGER NOT NULL,
  "completedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "SaleCheckout_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "chk_checkout_model" CHECK ("pricingModel" = 'PROPORTIONAL_V1' AND "algorithmVersion" = 1),
  CONSTRAINT "chk_checkout_hash" CHECK ("requestHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "chk_checkout_balance_method" CHECK ("balanceMethod" IN ('CASH', 'TRANSFER', 'CARD_DEBIT')),
  -- total/changeAmount keep exact centavos (a fixed tender may carry them); the
  -- CASH full price is a calculated value and always lands on whole pesos.
  CONSTRAINT "chk_checkout_amounts" CHECK ("total" > 0 AND "changeAmount" >= 0 AND "referenceSubtotal" > 0
    AND "fullPriceCash" > 0 AND "fullPriceCash" % 100 = 0),
  -- Whole pricing-config snapshot or nothing: the six provenance fields are all
  -- NULL together, or all present and in range. No partial snapshots.
  CONSTRAINT "chk_checkout_config_snapshot" CHECK (
    ("pricingConfigId" IS NULL AND "pricingConfigUpdatedAt" IS NULL
      AND "fullPriceTransfer" IS NULL AND "transferAdjustmentBps" IS NULL
      AND "fullPriceDebit" IS NULL AND "debitAdjustmentBps" IS NULL)
    OR ("pricingConfigId" IS NOT NULL AND "pricingConfigUpdatedAt" IS NOT NULL
      AND "fullPriceTransfer" IS NOT NULL AND "transferAdjustmentBps" IS NOT NULL
      AND "fullPriceDebit" IS NOT NULL AND "debitAdjustmentBps" IS NOT NULL
      AND "fullPriceTransfer" > 0 AND "fullPriceTransfer" % 100 = 0
      AND "fullPriceDebit" > 0 AND "fullPriceDebit" % 100 = 0
      AND "transferAdjustmentBps" BETWEEN 0 AND 10000
      AND "debitAdjustmentBps" BETWEEN 0 AND 10000))
);

-- 4. ExternalCollection --------------------------------------------------------
CREATE TABLE "ExternalCollection" (
  "id" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "method" "PaymentMethod" NOT NULL,
  -- Exact centavos received (a transfer with cents is applied as-is).
  "amount" BIGINT NOT NULL,
  "reference" TEXT NOT NULL,
  "referenceKey" TEXT NOT NULL,
  "institution" "TransferInstitution",
  "institutionOther" TEXT,
  "status" "ExternalCollectionStatus" NOT NULL,
  -- Sale where the incident happened; may be cancelled and re-applied later.
  "originSaleId" TEXT,
  "cashSessionId" TEXT,
  -- Sale the collection was finally applied to.
  "appliedCheckoutId" TEXT,
  "appliedSaleId" TEXT,
  "recordedById" TEXT NOT NULL,
  "recordedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "incidentReason" TEXT,
  "resolvedById" TEXT,
  "resolvedAt" TIMESTAMPTZ(3),
  "refundReference" TEXT,
  "resolutionNote" TEXT,

  CONSTRAINT "ExternalCollection_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "chk_ec_amount" CHECK ("amount" > 0),
  CONSTRAINT "chk_ec_reference" CHECK (char_length("reference") BETWEEN 1 AND 64
    AND "referenceKey" ~ '^[A-Z0-9]{3,40}$'),
  -- Three explicit NULL-safe forms. Implies method IN (TRANSFER, CARD_DEBIT):
  -- debit carries no institution; a normal transfer carries one (never OTHER);
  -- an OTHER transfer carries a non-blank free-text label.
  CONSTRAINT "chk_ec_institution" CHECK (
    ("method" = 'CARD_DEBIT' AND "institution" IS NULL AND "institutionOther" IS NULL)
    OR ("method" = 'TRANSFER' AND "institution" IS NOT NULL AND "institution" <> 'OTHER'
      AND "institutionOther" IS NULL)
    OR ("method" = 'TRANSFER' AND "institution" IS NOT NULL AND "institution" = 'OTHER'
      AND "institutionOther" IS NOT NULL AND char_length(btrim("institutionOther")) BETWEEN 1 AND 60)),
  -- APPLIED points at a checkout and sale and has no resolution; UNAPPLIED has
  -- neither; REFUNDED carries the full resolution but no application.
  CONSTRAINT "chk_ec_status" CHECK (
    ("status" = 'APPLIED' AND "appliedCheckoutId" IS NOT NULL AND "appliedSaleId" IS NOT NULL
      AND "resolvedById" IS NULL AND "resolvedAt" IS NULL AND "refundReference" IS NULL)
    OR ("status" = 'UNAPPLIED' AND "appliedCheckoutId" IS NULL AND "appliedSaleId" IS NULL
      AND "resolvedById" IS NULL AND "resolvedAt" IS NULL AND "refundReference" IS NULL)
    OR ("status" = 'REFUNDED' AND "appliedCheckoutId" IS NULL AND "appliedSaleId" IS NULL
      AND "resolvedById" IS NOT NULL AND "resolvedAt" IS NOT NULL
      AND "refundReference" IS NOT NULL AND char_length(btrim("refundReference")) BETWEEN 1 AND 64))
);

-- 5. SalePayment: checkout shape + N-1-safe pricing model ----------------------
ALTER TABLE "SalePayment"
  ADD COLUMN "pricingModel" "SalePricingModel" NOT NULL DEFAULT 'FIXED_TOTAL',
  ADD COLUMN "checkoutId" TEXT,
  ADD COLUMN "tenderRole" "CheckoutTenderRole",
  ADD COLUMN "methodFullPrice" BIGINT,
  ADD COLUMN "adjustmentBps" INTEGER,
  ADD COLUMN "externalCollectionId" TEXT;

-- Historical shape (FIXED_TOTAL, all checkout columns NULL) or checkout shape
-- (PROPORTIONAL_V1, all present; CASH is the balance tender with received/change,
-- TRANSFER/CARD_DEBIT are fixed and tied to an external collection).
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
      OR ("method" IN ('TRANSFER', 'CARD_DEBIT') AND "externalCollectionId" IS NOT NULL
        AND "receivedAmount" IS NULL AND "changeAmount" IS NULL))));

-- The balance is a calculated value and always lands on whole pesos.
ALTER TABLE "SalePayment" ADD CONSTRAINT "chk_payment_balance_whole_peso"
  CHECK ("tenderRole" IS DISTINCT FROM 'BALANCE' OR "amount" % 100 = 0);

-- 6. SaleLineAllocation --------------------------------------------------------
CREATE TABLE "SaleLineAllocation" (
  "id" TEXT NOT NULL,
  "checkoutId" TEXT NOT NULL,
  "saleId" TEXT NOT NULL,
  "saleItemId" TEXT NOT NULL,
  "salePaymentId" TEXT NOT NULL,
  "method" "PaymentMethod" NOT NULL,
  "quantity" BIGINT NOT NULL,
  "baseUnitPrice" BIGINT NOT NULL,
  "unitPrice" BIGINT NOT NULL,
  "lineFullPrice" BIGINT NOT NULL,
  "amount" BIGINT NOT NULL,

  CONSTRAINT "SaleLineAllocation_pkey" PRIMARY KEY ("id"),
  -- unitPrice and lineFullPrice are calculated; amount is the exact allocatable
  -- share of that line for the payment and never exceeds it.
  CONSTRAINT "chk_alloc" CHECK ("quantity" > 0 AND "baseUnitPrice" > 0 AND "unitPrice" > 0
    AND "unitPrice" % 100 = 0 AND "lineFullPrice" = "quantity" * "unitPrice"
    AND "amount" >= 0 AND "amount" <= "lineFullPrice")
);

-- 7. Unique and plain indexes (FK targets + domain uniqueness) ------------------
CREATE UNIQUE INDEX "Sale_id_branchId_key" ON "Sale"("id", "branchId");
CREATE UNIQUE INDEX "Sale_id_pricingModel_key" ON "Sale"("id", "pricingModel");
CREATE UNIQUE INDEX "Sale_id_branchId_pricingModel_key" ON "Sale"("id", "branchId", "pricingModel");
CREATE UNIQUE INDEX "SaleItem_id_saleId_key" ON "SaleItem"("id", "saleId");

CREATE UNIQUE INDEX "SaleCheckout_saleId_key" ON "SaleCheckout"("saleId");
CREATE UNIQUE INDEX "SaleCheckout_operationKey_key" ON "SaleCheckout"("operationKey");
CREATE UNIQUE INDEX "SaleCheckout_id_saleId_key" ON "SaleCheckout"("id", "saleId");
CREATE UNIQUE INDEX "SaleCheckout_id_saleId_cashSessionId_key" ON "SaleCheckout"("id", "saleId", "cashSessionId");
CREATE UNIQUE INDEX "SaleCheckout_id_saleId_branchId_key" ON "SaleCheckout"("id", "saleId", "branchId");

CREATE UNIQUE INDEX "ExternalCollection_id_applied_key" ON "ExternalCollection"("id", "appliedSaleId", "method", "amount");

CREATE UNIQUE INDEX "SalePayment_externalCollectionId_key" ON "SalePayment"("externalCollectionId");
CREATE UNIQUE INDEX "SalePayment_checkoutId_method_key" ON "SalePayment"("checkoutId", "method");
CREATE UNIQUE INDEX "SalePayment_id_checkoutId_method_key" ON "SalePayment"("id", "checkoutId", "method");

CREATE UNIQUE INDEX "SaleLineAllocation_payment_item_key" ON "SaleLineAllocation"("salePaymentId", "saleItemId");
CREATE INDEX "SaleLineAllocation_checkoutId_idx" ON "SaleLineAllocation"("checkoutId");
CREATE INDEX "SaleLineAllocation_saleItemId_idx" ON "SaleLineAllocation"("saleItemId");

-- 8. Partial unique reference indexes (SQL-only) --------------------------------
-- A debit reference is unique per branch; a transfer reference is unique per
-- branch and institution. No enum-to-text cast in the index predicate.
CREATE UNIQUE INDEX "ExternalCollection_debit_ref_key"
  ON "ExternalCollection"("branchId", "referenceKey") WHERE "method" = 'CARD_DEBIT';
CREATE UNIQUE INDEX "ExternalCollection_transfer_ref_key"
  ON "ExternalCollection"("branchId", "institution", "referenceKey") WHERE "method" = 'TRANSFER';

-- 9. Composite foreign keys (integrity across sale, branch, checkout, payment,
--    line and external collection). All immediate, all MATCH SIMPLE: a row with
--    any NULL column in the key is not checked (historical/fixed-total rows have
--    NULL checkout columns; UNAPPLIED collections have NULL application columns).
ALTER TABLE "SaleCheckout" ADD CONSTRAINT "SaleCheckout_sale_branch_model_fkey"
  FOREIGN KEY ("saleId", "branchId", "pricingModel") REFERENCES "Sale"("id", "branchId", "pricingModel")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "SaleCheckout" ADD CONSTRAINT "SaleCheckout_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SaleCheckout" ADD CONSTRAINT "SaleCheckout_cashSessionId_fkey"
  FOREIGN KEY ("cashSessionId") REFERENCES "CashSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SaleCheckout" ADD CONSTRAINT "SaleCheckout_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ExternalCollection" ADD CONSTRAINT "ExternalCollection_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ExternalCollection" ADD CONSTRAINT "ExternalCollection_origin_sale_fkey"
  FOREIGN KEY ("originSaleId", "branchId") REFERENCES "Sale"("id", "branchId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ExternalCollection" ADD CONSTRAINT "ExternalCollection_applied_fkey"
  FOREIGN KEY ("appliedCheckoutId", "appliedSaleId", "branchId") REFERENCES "SaleCheckout"("id", "saleId", "branchId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "ExternalCollection" ADD CONSTRAINT "ExternalCollection_cashSessionId_fkey"
  FOREIGN KEY ("cashSessionId") REFERENCES "CashSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ExternalCollection" ADD CONSTRAINT "ExternalCollection_recordedById_fkey"
  FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ExternalCollection" ADD CONSTRAINT "ExternalCollection_resolvedById_fkey"
  FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The payment belongs to the same sale, checkout and cash session.
ALTER TABLE "SalePayment" ADD CONSTRAINT "SalePayment_sale_pricing_model_fkey"
  FOREIGN KEY ("saleId", "pricingModel") REFERENCES "Sale"("id", "pricingModel")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "SalePayment" ADD CONSTRAINT "SalePayment_checkout_fkey"
  FOREIGN KEY ("checkoutId", "saleId", "cashSessionId") REFERENCES "SaleCheckout"("id", "saleId", "cashSessionId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
-- The external collection has the same applied sale, method and exact amount.
ALTER TABLE "SalePayment" ADD CONSTRAINT "SalePayment_external_collection_fkey"
  FOREIGN KEY ("externalCollectionId", "saleId", "method", "amount") REFERENCES "ExternalCollection"("id", "appliedSaleId", "method", "amount")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- The allocation belongs to the payment, the checkout, the method and the line.
ALTER TABLE "SaleLineAllocation" ADD CONSTRAINT "SaleLineAllocation_checkout_fkey"
  FOREIGN KEY ("checkoutId", "saleId") REFERENCES "SaleCheckout"("id", "saleId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "SaleLineAllocation" ADD CONSTRAINT "SaleLineAllocation_payment_fkey"
  FOREIGN KEY ("salePaymentId", "checkoutId", "method") REFERENCES "SalePayment"("id", "checkoutId", "method")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "SaleLineAllocation" ADD CONSTRAINT "SaleLineAllocation_item_fkey"
  FOREIGN KEY ("saleItemId", "saleId") REFERENCES "SaleItem"("id", "saleId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
