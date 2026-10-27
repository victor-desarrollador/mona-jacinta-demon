-- Sale exchange v1 (G19): a sale with at least one SaleExchange cannot be voided.
--
-- WHY: the post-payment void (SaleVoid) rebuilds the stock it gives back from the original SALE
-- StockMovement rows. After an exchange the original variant already came back (SALE_EXCHANGE_IN)
-- and the replacement already left (SALE_EXCHANGE_OUT), so the void would return the original
-- variant a second time and never the replacement. V1 therefore refuses the void.
-- The sale-void service answers 409 SALE_HAS_EXCHANGES before touching anything; this migration
-- makes the DATABASE refuse it too, for any writer that skips the service.
--
-- Depends on 20261026130000_sale_exchange_schema (SaleExchange and its index on (saleId, createdAt)).
-- Additive only: two functions and two triggers. No table, column, constraint, index or row is
-- created, altered or written, so nothing is rewritten and N-1 writers (which never create a
-- SaleExchange) are unaffected: for them the guard is one index probe that finds nothing.
--
-- The exclusion is SYMMETRIC and lives entirely here (G18 is not modified): SaleVoid and SaleExchange of the same sale are
-- mutually exclusive at the database, for ANY writer, even one that never updates Sale.status.
--   * trg_sale_void_exchange_guard     (SaleVoid INSERT / UPDATE OF saleId):     Sale FOR UPDATE, then refuse if a SaleExchange exists;
--   * trg_sale_exchange_void_guard     (SaleExchange INSERT / UPDATE OF saleId): Sale FOR UPDATE, then refuse if a SaleVoid exists.
-- Both take the Sale row FIRST and nothing else before it, so they cannot deadlock with each other or with the services (Sale is also the
-- first lock of sale-void and sale-exchange). Whoever holds the Sale lock decides; the other waits and, at READ COMMITTED, then sees the
-- committed row and is refused. The sale-void and sale-exchange services run SERIALIZABLE, where the rw-dependency between "no exchange
-- (void) yet" and "exchange (void) written" is also caught by SSI (40001, retried).
-- Order of firing on SaleExchange INSERT (by trigger name): trg_sale_exchange_append_only (UPDATE/DELETE only), trg_sale_exchange_header_guard
-- (G18: Sale FOR UPDATE + must be COMPLETED), trg_sale_exchange_void_guard (this file). UPDATE OF saleId on SaleExchange is already refused
-- by the G18 append-only trigger; the guard is kept anyway so the exclusion does not depend on that other trigger.
-- Residual, documented: a Serializable transaction that waited for the lock while a READ COMMITTED raw writer committed the opposite row
-- does not see it in its own snapshot (SSI only tracks Serializable transactions). No application path does that.

CREATE FUNCTION public."fn_sale_void_exchange_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM 1 FROM public."Sale" s WHERE s."id" = NEW."saleId" FOR UPDATE;
  IF EXISTS (SELECT 1 FROM public."SaleExchange" x WHERE x."saleId" = NEW."saleId") THEN
    RAISE EXCEPTION 'chk_sale_void_has_exchanges: a sale with exchanges cannot be voided'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "trg_sale_void_exchange_guard" BEFORE INSERT OR UPDATE OF "saleId"
ON public."SaleVoid" FOR EACH ROW
EXECUTE FUNCTION public."fn_sale_void_exchange_guard"();

-- Opposite side: the same exclusion when the EXCHANGE is the second to arrive.
CREATE FUNCTION public."fn_sale_exchange_void_guard"() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  PERFORM 1 FROM public."Sale" s WHERE s."id" = NEW."saleId" FOR UPDATE;
  IF EXISTS (SELECT 1 FROM public."SaleVoid" v WHERE v."saleId" = NEW."saleId") THEN
    RAISE EXCEPTION 'chk_sale_exchange_has_void: a voided sale cannot be exchanged'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "trg_sale_exchange_void_guard" BEFORE INSERT OR UPDATE OF "saleId"
ON public."SaleExchange" FOR EACH ROW
EXECUTE FUNCTION public."fn_sale_exchange_void_guard"();
