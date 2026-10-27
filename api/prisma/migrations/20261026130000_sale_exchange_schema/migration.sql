-- Sale exchange v1 (G18), step B of 2: SaleExchange, SaleExchangeLine and the StockMovement links.
--
-- Additive only; depends on step A (20261026120000_sale_exchange_enum) being committed.
-- Every existing row is untouched: the two new StockMovement columns stay NULL, so the unique
-- index (NULLs distinct), both composite FKs (MATCH SIMPLE: a NULL column skips the check) and
-- every CHECK (text guard, `type::text NOT IN (...) OR ...`) accept all historical and N-1 rows.
-- No applied migration is rewritten, no existing column is altered, no table is rebuilt.
--
-- An exchange swaps garments on a COMPLETED sale at EQUAL value per line: it moves no money and
-- leaves no debt. Nothing here updates or deletes a Sale, SaleItem, SalePayment, CashMovement or
-- ExternalCollection. The CHECKs and triggers are SQL-only (Prisma has no @@check); the tables,
-- indexes and FKs are mirrored exactly in schema.prisma.
--
-- What the DATABASE enforces (proved by tests/sales/sale-exchange.pg.test.ts):
--   * shape: reason / key / hash text, quantity > 0, prices > 0 and EQUAL;
--   * links: a line belongs to an exchange of the SAME sale and branch, and to a SaleItem OF that
--     sale; a stock movement belongs to a line of ITS OWN exchange, sale and branch;
--   * ledger (deferred, checked at COMMIT): every line has exactly one SALE_EXCHANGE_IN (+N, on the
--     inventory of the ORIGINAL variant) and one SALE_EXCHANGE_OUT (-N, on the inventory of the
--     REPLACEMENT variant), same branch, written by the exchange actor; every exchange has a line;
--   * the sale is COMPLETED when the exchange is created (Sale row locked FOR UPDATE), and the
--     units exchanged per SaleItem never exceed the units sold;
--   * the history is append-only (UPDATE / DELETE refused on both tables and on the exchange rows
--     of StockMovement).
-- What stays with the SERVICE: authorization, availability (physical - reserved) of the
-- replacement, the CURRENT price of the replacement, that Inventory.physical really moves with
-- the ledger rows, idempotent replay, retries and the audit row. TRUNCATE is deliberately not
-- guarded: the test cleanup (TRUNCATE ... CASCADE) must keep working, and no application role
-- holds TRUNCATE.

-- 1. Tables ------------------------------------------------------------------------
CREATE TABLE "SaleExchange" (
  "id" TEXT NOT NULL,
  "saleId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "createdById" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "requestHash" CHAR(64) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "SaleExchange_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SaleExchangeLine" (
  "id" TEXT NOT NULL,
  "saleExchangeId" TEXT NOT NULL,
  "saleId" TEXT NOT NULL,
  "branchId" TEXT NOT NULL,
  "saleItemId" TEXT NOT NULL,
  "replacementVariantId" TEXT NOT NULL,
  "returnQuantity" BIGINT NOT NULL,
  "originalUnitPrice" BIGINT NOT NULL,
  "replacementUnitPrice" BIGINT NOT NULL,

  CONSTRAINT "SaleExchangeLine_pkey" PRIMARY KEY ("id")
);

-- 2. Columns on the stock ledger -------------------------------------------------------
ALTER TABLE "StockMovement" ADD COLUMN "saleExchangeId" TEXT;
ALTER TABLE "StockMovement" ADD COLUMN "saleExchangeLineId" TEXT;

-- 3. Indexes ---------------------------------------------------------------------------
-- Idempotency is per (sale, key).
CREATE UNIQUE INDEX "SaleExchange_saleId_idempotencyKey_key" ON "SaleExchange"("saleId", "idempotencyKey");
-- Candidate key of the SaleExchangeLine and StockMovement composite FKs.
CREATE UNIQUE INDEX "SaleExchange_id_saleId_branchId_key" ON "SaleExchange"("id", "saleId", "branchId");
CREATE INDEX "SaleExchange_saleId_createdAt_idx" ON "SaleExchange"("saleId", "createdAt");
CREATE INDEX "SaleExchange_branchId_createdAt_idx" ON "SaleExchange"("branchId", "createdAt");
CREATE INDEX "SaleExchange_createdById_idx" ON "SaleExchange"("createdById");

-- One line per SaleItem in an exchange.
CREATE UNIQUE INDEX "SaleExchangeLine_saleExchangeId_saleItemId_key" ON "SaleExchangeLine"("saleExchangeId", "saleItemId");
-- Candidate key of the StockMovement composite FK.
CREATE UNIQUE INDEX "SaleExchangeLine_id_saleExchangeId_saleId_branchId_key" ON "SaleExchangeLine"("id", "saleExchangeId", "saleId", "branchId");
CREATE INDEX "SaleExchangeLine_saleItemId_idx" ON "SaleExchangeLine"("saleItemId");
CREATE INDEX "SaleExchangeLine_replacementVariantId_idx" ON "SaleExchangeLine"("replacementVariantId");

-- At most one IN and one OUT per line. NULL saleExchangeLineId is distinct, so SALE /
-- INITIAL_STOCK / ADJUSTMENT / SALE_VOID rows never conflict.
CREATE UNIQUE INDEX "StockMovement_saleExchangeLineId_type_key" ON "StockMovement"("saleExchangeLineId", "type");
CREATE INDEX "StockMovement_saleExchangeId_idx" ON "StockMovement"("saleExchangeId");

-- 4. Foreign keys (all RESTRICT / RESTRICT: history is never cascaded away) -----------------
-- Same-branch link, pattern of SaleVoid.
ALTER TABLE "SaleExchange" ADD CONSTRAINT "SaleExchange_sale_branch_fkey"
  FOREIGN KEY ("saleId", "branchId") REFERENCES "Sale"("id", "branchId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "SaleExchange" ADD CONSTRAINT "SaleExchange_createdBy_fkey"
  FOREIGN KEY ("createdById") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- A line belongs to an exchange of the SAME sale and branch, and to a SaleItem of that sale.
ALTER TABLE "SaleExchangeLine" ADD CONSTRAINT "SaleExchangeLine_exchange_fkey"
  FOREIGN KEY ("saleExchangeId", "saleId", "branchId") REFERENCES "SaleExchange"("id", "saleId", "branchId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "SaleExchangeLine" ADD CONSTRAINT "SaleExchangeLine_saleItem_fkey"
  FOREIGN KEY ("saleItemId", "saleId") REFERENCES "SaleItem"("id", "saleId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "SaleExchangeLine" ADD CONSTRAINT "SaleExchangeLine_replacementVariant_fkey"
  FOREIGN KEY ("replacementVariantId") REFERENCES "ProductVariant"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- An exchange movement can only belong to the line (and exchange) of ITS OWN sale and branch.
-- The line FK already implies the exchange one (the line carries a FK to the same exchange);
-- both are kept so Prisma can navigate each relation.
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_saleExchangeLine_fkey"
  FOREIGN KEY ("saleExchangeLineId", "saleExchangeId", "saleId", "branchId") REFERENCES "SaleExchangeLine"("id", "saleExchangeId", "saleId", "branchId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_saleExchange_sale_branch_fkey"
  FOREIGN KEY ("saleExchangeId", "saleId", "branchId") REFERENCES "SaleExchange"("id", "saleId", "branchId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- 5. CHECKs ----------------------------------------------------------------------------
-- The new tables are empty, so their CHECKs validate immediately.
ALTER TABLE "SaleExchange" ADD CONSTRAINT "chk_sale_exchange_reason"
  CHECK ("reason" = btrim("reason", E' \t\r\n') AND char_length("reason") BETWEEN 1 AND 200);
ALTER TABLE "SaleExchange" ADD CONSTRAINT "chk_sale_exchange_idempotency_key_uuid_v4"
  CHECK ("idempotencyKey" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$');
ALTER TABLE "SaleExchange" ADD CONSTRAINT "chk_sale_exchange_request_hash"
  CHECK ("requestHash" ~ '^[0-9a-f]{64}$');

ALTER TABLE "SaleExchangeLine" ADD CONSTRAINT "chk_sale_exchange_line_quantity_positive"
  CHECK ("returnQuantity" > 0);
ALTER TABLE "SaleExchangeLine" ADD CONSTRAINT "chk_sale_exchange_line_prices_positive"
  CHECK ("originalUnitPrice" > 0 AND "replacementUnitPrice" > 0);
-- V1 moves no money: only equal value per line.
ALTER TABLE "SaleExchangeLine" ADD CONSTRAINT "chk_sale_exchange_line_same_value"
  CHECK ("originalUnitPrice" = "replacementUnitPrice");

-- StockMovement already holds rows: NOT VALID, then VALIDATE. Text guard on "type" (see step A).
-- An exchange row is complete (exchange + line + sale) and signed; only an exchange row may carry
-- the exchange ids.
ALTER TABLE "StockMovement" ADD CONSTRAINT "chk_stock_movement_sale_exchange_shape"
  CHECK ("type"::text NOT IN ('SALE_EXCHANGE_IN', 'SALE_EXCHANGE_OUT')
         OR ("saleExchangeId" IS NOT NULL AND "saleExchangeLineId" IS NOT NULL AND "saleId" IS NOT NULL)) NOT VALID;
ALTER TABLE "StockMovement" ADD CONSTRAINT "chk_stock_movement_sale_exchange_only"
  CHECK ("type"::text IN ('SALE_EXCHANGE_IN', 'SALE_EXCHANGE_OUT')
         OR ("saleExchangeId" IS NULL AND "saleExchangeLineId" IS NULL)) NOT VALID;
ALTER TABLE "StockMovement" ADD CONSTRAINT "chk_stock_movement_sale_exchange_in_positive"
  CHECK ("type"::text <> 'SALE_EXCHANGE_IN' OR "quantityDelta" > 0) NOT VALID;
ALTER TABLE "StockMovement" ADD CONSTRAINT "chk_stock_movement_sale_exchange_out_negative"
  CHECK ("type"::text <> 'SALE_EXCHANGE_OUT' OR "quantityDelta" < 0) NOT VALID;

-- 6. Guards -----------------------------------------------------------------------------
-- Convention of the earlier guards (R3, sale void): SECURITY INVOKER, search_path pinned to
-- pg_catalog + pg_temp, every relation schema-qualified, no dynamic SQL, check_violation (23514).

-- 6.1 Header: the sale must be COMPLETED. The Sale row is locked FOR UPDATE here (the service
--     already holds it), so two writers of the SAME sale serialize on it; that is what makes the
--     deferred remainder check below race-free. A missing sale is left to the composite FK.
CREATE FUNCTION public."fn_sale_exchange_header_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  sale_status text;
BEGIN
  SELECT s."status"::text INTO sale_status FROM public."Sale" s WHERE s."id" = NEW."saleId" FOR UPDATE;
  IF FOUND AND sale_status <> 'COMPLETED' THEN
    RAISE EXCEPTION 'chk_sale_exchange_sale_completed: only a COMPLETED sale can be exchanged'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "trg_sale_exchange_header_guard" BEFORE INSERT
ON public."SaleExchange" FOR EACH ROW
EXECUTE FUNCTION public."fn_sale_exchange_header_guard"();

-- 6.2 Deferred, at COMMIT: an exchange has at least one line.
CREATE FUNCTION public."fn_sale_exchange_has_lines"() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public."SaleExchangeLine" l WHERE l."saleExchangeId" = NEW."id") THEN
    RAISE EXCEPTION 'chk_sale_exchange_has_lines: an exchange needs at least one line'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER "trg_sale_exchange_has_lines" AFTER INSERT
ON public."SaleExchange" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION public."fn_sale_exchange_has_lines"();

-- 6.3 Deferred, at COMMIT: the units exchanged of a SaleItem never exceed the units sold.
CREATE FUNCTION public."fn_sale_exchange_line_remainder"() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  sold bigint;
  used numeric;
BEGIN
  SELECT si."quantity" INTO sold FROM public."SaleItem" si WHERE si."id" = NEW."saleItemId";
  SELECT COALESCE(sum(l."returnQuantity"), 0) INTO used FROM public."SaleExchangeLine" l WHERE l."saleItemId" = NEW."saleItemId";
  IF used > sold THEN
    RAISE EXCEPTION 'chk_sale_exchange_line_remainder: the units exchanged of a SaleItem exceed the units sold'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER "trg_sale_exchange_line_remainder" AFTER INSERT
ON public."SaleExchangeLine" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION public."fn_sale_exchange_line_remainder"();

-- 6.4 Deferred, at COMMIT: the ledger of a line. Fired by the line itself (the ledger must be
--     there by commit) AND by each exchange movement (a movement added later is re-checked).
--     Exactly one IN and one OUT per line is already guaranteed by UNIQUE(line, type) and the
--     movement CHECKs; this proves they exist, have the line's magnitude, sit on the right
--     inventory (IN: original variant of the SaleItem; OUT: replacement variant), in the line's
--     branch, and were written by the exchange actor.
CREATE FUNCTION public."fn_sale_exchange_ledger_check"() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  line_id text;
  line_row record;
  in_row record;
  out_row record;
BEGIN
  IF TG_TABLE_NAME = 'SaleExchangeLine' THEN
    line_id := NEW."id";
  ELSE
    line_id := NEW."saleExchangeLineId";
  END IF;

  SELECT l."branchId", l."returnQuantity", l."replacementVariantId", si."variantId" AS original_variant_id, x."createdById"
    INTO line_row
    FROM public."SaleExchangeLine" l
    JOIN public."SaleExchange" x ON x."id" = l."saleExchangeId"
    JOIN public."SaleItem" si ON si."id" = l."saleItemId"
   WHERE l."id" = line_id;
  IF NOT FOUND THEN
    RETURN NULL; -- the composite FKs refuse a movement without its line
  END IF;

  SELECT m."quantityDelta", m."userId", i."variantId", i."branchId"
    INTO in_row
    FROM public."StockMovement" m
    JOIN public."Inventory" i ON i."id" = m."inventoryId"
   WHERE m."saleExchangeLineId" = line_id AND m."type"::text = 'SALE_EXCHANGE_IN';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'chk_sale_exchange_ledger: the line has no SALE_EXCHANGE_IN movement'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT m."quantityDelta", m."userId", i."variantId", i."branchId"
    INTO out_row
    FROM public."StockMovement" m
    JOIN public."Inventory" i ON i."id" = m."inventoryId"
   WHERE m."saleExchangeLineId" = line_id AND m."type"::text = 'SALE_EXCHANGE_OUT';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'chk_sale_exchange_ledger: the line has no SALE_EXCHANGE_OUT movement'
      USING ERRCODE = 'check_violation';
  END IF;

  IF in_row."quantityDelta" <> line_row."returnQuantity" OR out_row."quantityDelta" <> -line_row."returnQuantity" THEN
    RAISE EXCEPTION 'chk_sale_exchange_ledger: the IN / OUT magnitude must equal the returned quantity'
      USING ERRCODE = 'check_violation';
  END IF;
  IF in_row."variantId" <> line_row.original_variant_id OR in_row."branchId" <> line_row."branchId" THEN
    RAISE EXCEPTION 'chk_sale_exchange_ledger: the IN must be on the inventory of the original variant, in the sale branch'
      USING ERRCODE = 'check_violation';
  END IF;
  IF out_row."variantId" <> line_row."replacementVariantId" OR out_row."branchId" <> line_row."branchId" THEN
    RAISE EXCEPTION 'chk_sale_exchange_ledger: the OUT must be on the inventory of the replacement variant, in the sale branch'
      USING ERRCODE = 'check_violation';
  END IF;
  IF in_row."userId" <> line_row."createdById" OR out_row."userId" <> line_row."createdById" THEN
    RAISE EXCEPTION 'chk_sale_exchange_ledger: the movements must be written by the exchange actor'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER "trg_sale_exchange_line_ledger_check" AFTER INSERT
ON public."SaleExchangeLine" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION public."fn_sale_exchange_ledger_check"();

CREATE CONSTRAINT TRIGGER "trg_stock_movement_sale_exchange_ledger_check" AFTER INSERT
ON public."StockMovement" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
WHEN (NEW."type"::text IN ('SALE_EXCHANGE_IN', 'SALE_EXCHANGE_OUT'))
EXECUTE FUNCTION public."fn_sale_exchange_ledger_check"();

-- 6.5 Append-only history: no UPDATE and no DELETE of an exchange, a line, or an exchange
--     movement (nor turning another movement into one). Statements that match no row fire nothing.
CREATE FUNCTION public."fn_sale_exchange_append_only"() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'trg_sale_exchange_append_only: % on % is not allowed (append-only history)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
  RETURN NULL;
END $$;

CREATE TRIGGER "trg_sale_exchange_append_only" BEFORE UPDATE OR DELETE
ON public."SaleExchange" FOR EACH ROW
EXECUTE FUNCTION public."fn_sale_exchange_append_only"();

CREATE TRIGGER "trg_sale_exchange_line_append_only" BEFORE UPDATE OR DELETE
ON public."SaleExchangeLine" FOR EACH ROW
EXECUTE FUNCTION public."fn_sale_exchange_append_only"();

CREATE TRIGGER "trg_stock_movement_sale_exchange_no_update" BEFORE UPDATE
ON public."StockMovement" FOR EACH ROW
WHEN (OLD."type"::text IN ('SALE_EXCHANGE_IN', 'SALE_EXCHANGE_OUT') OR NEW."type"::text IN ('SALE_EXCHANGE_IN', 'SALE_EXCHANGE_OUT'))
EXECUTE FUNCTION public."fn_sale_exchange_append_only"();

CREATE TRIGGER "trg_stock_movement_sale_exchange_no_delete" BEFORE DELETE
ON public."StockMovement" FOR EACH ROW
WHEN (OLD."type"::text IN ('SALE_EXCHANGE_IN', 'SALE_EXCHANGE_OUT'))
EXECUTE FUNCTION public."fn_sale_exchange_append_only"();

ALTER TABLE "StockMovement" VALIDATE CONSTRAINT "chk_stock_movement_sale_exchange_shape";
ALTER TABLE "StockMovement" VALIDATE CONSTRAINT "chk_stock_movement_sale_exchange_only";
ALTER TABLE "StockMovement" VALIDATE CONSTRAINT "chk_stock_movement_sale_exchange_in_positive";
ALTER TABLE "StockMovement" VALIDATE CONSTRAINT "chk_stock_movement_sale_exchange_out_negative";
