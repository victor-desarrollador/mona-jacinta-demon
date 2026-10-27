-- Pilot Pricing V2: cash-base retail + company-global customer price modes.
-- Additive only. ProductVariant.price remains the legacy LIST price during
-- transition; ProductVariant.cashPrice is nullable until backfill/verify.

CREATE TYPE "CustomerPriceMode" AS ENUM (
  'CASH',
  'LIST',
  'CREDIT_CARD',
  'DEBIT_CARD',
  'BANK_TRANSFER',
  'QR'
);

ALTER TABLE "ProductVariant"
  ADD COLUMN "cashPrice" BIGINT;

ALTER TABLE "Sale"
  ADD COLUMN "priceMode" "CustomerPriceMode" NOT NULL DEFAULT 'LIST';

-- Existing sales were priced at list, so the backfill above stamps them LIST.
-- Every NEW sale defaults to CASH (owner decision 2026-10-06).
ALTER TABLE "Sale"
  ALTER COLUMN "priceMode" SET DEFAULT 'CASH';

ALTER TABLE "SaleItem"
  ADD COLUMN "priceBaseType" "PriceType",
  ADD COLUMN "priceMode" "CustomerPriceMode",
  ADD COLUMN "baseUnitPrice" BIGINT,
  ADD COLUMN "priceAdjustmentBps" INTEGER,
  ADD COLUMN "pricingConfigId" TEXT,
  ADD COLUMN "pricingConfigUpdatedAt" TIMESTAMPTZ(3);

CREATE TABLE "CompanyPricingConfig" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "listAdjustmentBps" INTEGER NOT NULL DEFAULT 0,
  "creditCardAdjustmentBps" INTEGER NOT NULL DEFAULT 0,
  "debitCardAdjustmentBps" INTEGER NOT NULL DEFAULT 0,
  "bankTransferAdjustmentBps" INTEGER NOT NULL DEFAULT 0,
  "qrAdjustmentBps" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "CompanyPricingConfig_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CompanyPricingConfig_companyId_key"
  ON "CompanyPricingConfig"("companyId");

ALTER TABLE "CompanyPricingConfig"
  ADD CONSTRAINT "CompanyPricingConfig_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ProductVariant"
  ADD CONSTRAINT "chk_product_variant_cash_price_positive"
  CHECK ("cashPrice" IS NULL OR "cashPrice" > 0);

-- wholesalePrice is the wholesale CASH base: never above the retail CASH base.
-- Existing rows have cashPrice NULL, so this passes trivially until backfill.
ALTER TABLE "ProductVariant"
  ADD CONSTRAINT "chk_product_variant_wholesale_not_above_cash"
  CHECK ("cashPrice" IS NULL OR "wholesalePrice" IS NULL OR "wholesalePrice" <= "cashPrice");

ALTER TABLE "SaleItem"
  ADD CONSTRAINT "chk_sale_item_pricing_snapshot_consistency"
  CHECK (
    (
      "priceBaseType" IS NULL
      AND "priceMode" IS NULL
      AND "baseUnitPrice" IS NULL
      AND "priceAdjustmentBps" IS NULL
    )
    OR
    (
      "priceBaseType" IS NOT NULL
      AND "priceMode" IS NOT NULL
      AND "baseUnitPrice" IS NOT NULL
      AND "baseUnitPrice" > 0
      AND "priceAdjustmentBps" IS NOT NULL
      AND "priceAdjustmentBps" >= 0
      AND "priceAdjustmentBps" <= 10000
    )
  );

ALTER TABLE "CompanyPricingConfig"
  ADD CONSTRAINT "chk_company_pricing_config_bps_bounds"
  CHECK (
    "listAdjustmentBps" >= 0 AND "listAdjustmentBps" <= 10000
    AND "creditCardAdjustmentBps" >= 0 AND "creditCardAdjustmentBps" <= 10000
    AND "debitCardAdjustmentBps" >= 0 AND "debitCardAdjustmentBps" <= 10000
    AND "bankTransferAdjustmentBps" >= 0 AND "bankTransferAdjustmentBps" <= 10000
    AND "qrAdjustmentBps" >= 0 AND "qrAdjustmentBps" <= 10000
  );
