-- Block 1 (Production V1 pricing / sale-scoped wholesale): additive only.
-- No existing row is rewritten and nothing is dropped. Existing Sale rows
-- read as LIST through a constant column default (metadata-only ADD COLUMN),
-- which matches how every existing sale was priced; SaleItem is untouched
-- (Sale.pricingMode is the single price-mode fact for all of a sale's lines).
-- ProductVariant.wholesalePrice starts NULL ("no wholesale price"): no
-- backfill, so wholesale stays unavailable until an OWNER/ADMIN with
-- PRICE_MANAGE sets a price. Sale.paymentStartedAt starts NULL for every
-- existing row with no backfill: a pre-migration paid Sale is protected by
-- the triggers below while its payments exist, is marked from its own
-- SalePayment.paidAt before the last one can be deleted or moved away, and
-- its payments cannot be TRUNCATEd away unrecorded.
-- NOT YET APPLIED to any database.

-- CreateEnum
CREATE TYPE "PriceType" AS ENUM ('LIST', 'WHOLESALE');

-- AlterTable
ALTER TABLE "ProductVariant" ADD COLUMN "wholesalePrice" BIGINT;

-- AlterTable
ALTER TABLE "Sale" ADD COLUMN "pricingMode" "PriceType" NOT NULL DEFAULT 'LIST',
ADD COLUMN "wholesaleAuthorizedAt" TIMESTAMPTZ(3),
ADD COLUMN "wholesaleConfirmedById" TEXT,
ADD COLUMN "wholesaleConfirmedAt" TIMESTAMPTZ(3),
ADD COLUMN "paymentStartedAt" TIMESTAMPTZ(3);

-- AddForeignKey
ALTER TABLE "Sale" ADD CONSTRAINT "Sale_wholesaleConfirmedById_fkey" FOREIGN KEY ("wholesaleConfirmedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Database-level invariants (not expressible in schema.prisma). Every
-- existing row satisfies all three: wholesalePrice is NULL everywhere, and
-- every Sale is LIST with all wholesale columns NULL. The services enforce
-- the same rules first with specific 409s; these hold even for an older
-- application version or direct SQL. Every referenced column is NOT NULL
-- except the ones explicitly tested with IS NULL, so no comparison can
-- evaluate to NULL and slip through a CHECK.

-- A wholesale price is positive and never above the list price, whichever
-- column a later UPDATE changes.
ALTER TABLE "ProductVariant" ADD CONSTRAINT "chk_product_variant_wholesale_price" CHECK (
  "wholesalePrice" IS NULL OR ("wholesalePrice" > 0 AND "wholesalePrice" <= "price")
);

-- LIST sales carry no wholesale state; a WHOLESALE sale was authorized, and
-- its cashier confirmation is recorded with both actor and time or neither.
ALTER TABLE "Sale" ADD CONSTRAINT "chk_sale_wholesale_state" CHECK (
  ("pricingMode" = 'LIST'
    AND "wholesaleAuthorizedAt" IS NULL
    AND "wholesaleConfirmedAt" IS NULL
    AND "wholesaleConfirmedById" IS NULL)
  OR
  ("pricingMode" = 'WHOLESALE'
    AND "wholesaleAuthorizedAt" IS NOT NULL
    AND ("wholesaleConfirmedAt" IS NULL) = ("wholesaleConfirmedById" IS NULL))
);

-- A WHOLESALE sale can never be PAID or COMPLETED (the SaleStatus values
-- written by the final payment and by completion) without a recorded
-- cashier confirmation. CANCELLED stays allowed: an unconfirmed wholesale
-- sale must remain cancellable, and cancellation requires zero payments.
ALTER TABLE "Sale" ADD CONSTRAINT "chk_sale_wholesale_confirmed_when_paid" CHECK (
  "pricingMode" = 'LIST'
  OR "status" NOT IN ('PAID', 'COMPLETED')
  OR ("wholesaleConfirmedAt" IS NOT NULL AND "wholesaleConfirmedById" IS NOT NULL)
);

-- WHOLESALE_PAYMENT_REQUIRES_CASHIER_CONFIRMATION + durable payment history.
-- Sale.paymentStartedAt means: the earliest persisted SalePayment.paidAt this
-- Sale has ever been known to have. It is maintained ONLY from SalePayment
-- evidence, may move earlier when older evidence appears, and never moves
-- later or back to NULL. Spans two tables (no CHECK/FK can express it):
--
-- SalePayment, BEFORE INSERT / UPDATE OF saleId / DELETE (row):
--   * locks every touched Sale FOR UPDATE, in id order (no lock cycle
--     between two opposite moves);
--   * SOURCE Sale (DELETE, or a move away): recorded from its current
--     payments while the departing row is still visible;
--   * TARGET Sale (INSERT, or a move to it): must be eligible — LIST, or
--     WHOLESALE authorized and cashier-confirmed.
-- SalePayment, AFTER INSERT / UPDATE OF saleId, paidAt (row): the TARGET Sale
--   is recorded from its current payments, now including the new row.
-- SalePayment, BEFORE TRUNCATE (statement): read-only guard. TRUNCATE is
--   refused while any current payment is not yet reflected in its Sale's
--   marker (only possible for rows paid before this migration). It writes
--   nothing and takes no row locks, so it cannot invert lock order with a
--   payment transaction; history survives as the refused rows.
-- Sale, BEFORE INSERT (row): a Sale is always created without a marker; a
--   non-NULL paymentStartedAt on INSERT is refused (no payment can exist yet).
-- Sale, BEFORE UPDATE OF the protected columns (row): pricingMode and the
--   wholesale columns are frozen once the Sale has payment history (marker
--   set, or legacy current payments); the marker may only take the value
--   LEAST(old marker, earliest current paidAt) — so, with the INSERT rule, it
--   can be neither fabricated, nor moved later, nor cleared.
-- All writes happen in the same statement/transaction as the payment change,
-- so they roll back with it. Hardening: every relation is schema-qualified
-- (public, the only schema this project's Prisma/migrations use); each
-- function pins search_path to pg_catalog, pg_temp; SECURITY INVOKER
-- (default); no dynamic SQL. Errors are check_violation (SQLSTATE 23514).

CREATE FUNCTION public."fn_sale_payment_history"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  source_id text;
  target_id text;
  eligible boolean;
BEGIN
  IF TG_WHEN = 'AFTER' THEN
    UPDATE public."Sale" s
       SET "paymentStartedAt" = h.first_paid
      FROM (SELECT min(p."paidAt") AS first_paid FROM public."SalePayment" p WHERE p."saleId" = NEW."saleId") h
     WHERE s."id" = NEW."saleId"
       AND h.first_paid IS NOT NULL
       AND (s."paymentStartedAt" IS NULL OR h.first_paid < s."paymentStartedAt");
    RETURN NULL;
  END IF;

  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    source_id := OLD."saleId";
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    target_id := NEW."saleId";
  END IF;

  PERFORM 1
     FROM public."Sale" s
    WHERE s."id" IN (source_id, target_id)
    ORDER BY s."id"
      FOR UPDATE;

  IF source_id IS NOT NULL THEN
    UPDATE public."Sale" s
       SET "paymentStartedAt" = h.first_paid
      FROM (SELECT min(p."paidAt") AS first_paid FROM public."SalePayment" p WHERE p."saleId" = source_id) h
     WHERE s."id" = source_id
       AND h.first_paid IS NOT NULL
       AND (s."paymentStartedAt" IS NULL OR h.first_paid < s."paymentStartedAt");
  END IF;

  IF target_id IS NOT NULL THEN
    SELECT s."pricingMode" = 'LIST'
        OR (s."wholesaleAuthorizedAt" IS NOT NULL
            AND s."wholesaleConfirmedAt" IS NOT NULL
            AND s."wholesaleConfirmedById" IS NOT NULL)
      INTO eligible
      FROM public."Sale" s
     WHERE s."id" = target_id;
    IF eligible IS NOT TRUE THEN
      RAISE EXCEPTION 'SalePayment requires a cashier-confirmed wholesale sale'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "trg_sale_payment_history_before"
BEFORE INSERT OR UPDATE OF "saleId" OR DELETE ON public."SalePayment"
FOR EACH ROW EXECUTE FUNCTION public."fn_sale_payment_history"();

CREATE TRIGGER "trg_sale_payment_history_after"
AFTER INSERT OR UPDATE OF "saleId", "paidAt" ON public."SalePayment"
FOR EACH ROW EXECUTE FUNCTION public."fn_sale_payment_history"();

CREATE FUNCTION public."fn_sale_payment_truncate_guard"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public."SalePayment" p
      JOIN public."Sale" s ON s."id" = p."saleId"
     WHERE s."paymentStartedAt" IS NULL
        OR p."paidAt" < s."paymentStartedAt"
  ) THEN
    RAISE EXCEPTION 'SalePayment TRUNCATE would erase payment history not yet recorded on its Sale'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER "trg_sale_payment_truncate_guard"
BEFORE TRUNCATE ON public."SalePayment"
FOR EACH STATEMENT EXECUTE FUNCTION public."fn_sale_payment_truncate_guard"();

CREATE FUNCTION public."fn_sale_wholesale_frozen_after_payment"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  earliest timestamptz(3);
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."paymentStartedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'Sale paymentStartedAt cannot be set when the sale is created'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  SELECT min(p."paidAt") INTO earliest FROM public."SalePayment" p WHERE p."saleId" = OLD."id";
  IF (OLD."paymentStartedAt" IS NOT NULL OR earliest IS NOT NULL)
     AND (NEW."pricingMode", NEW."wholesaleAuthorizedAt", NEW."wholesaleConfirmedAt", NEW."wholesaleConfirmedById")
         IS DISTINCT FROM
         (OLD."pricingMode", OLD."wholesaleAuthorizedAt", OLD."wholesaleConfirmedAt", OLD."wholesaleConfirmedById") THEN
    RAISE EXCEPTION 'Sale pricing mode and wholesale confirmation are frozen once a payment was accepted'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."paymentStartedAt" IS DISTINCT FROM OLD."paymentStartedAt"
     AND NEW."paymentStartedAt" IS DISTINCT FROM LEAST(OLD."paymentStartedAt", earliest) THEN
    RAISE EXCEPTION 'Sale paymentStartedAt may only record the earliest persisted SalePayment.paidAt'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "trg_sale_wholesale_frozen_after_payment"
BEFORE INSERT OR UPDATE OF "paymentStartedAt", "pricingMode", "wholesaleAuthorizedAt", "wholesaleConfirmedAt", "wholesaleConfirmedById" ON public."Sale"
FOR EACH ROW EXECUTE FUNCTION public."fn_sale_wholesale_frozen_after_payment"();
