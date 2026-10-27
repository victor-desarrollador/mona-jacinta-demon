-- Sale exchange v1 (G20): ONE central, snapshot-independent claim that makes SaleVoid and SaleExchange mutually exclusive per sale.
--
-- WHY (independent audit H3, reproduced on PostgreSQL 17.11): the G19 guards lock the Sale row FOR UPDATE and then run an EXISTS on the OTHER table.
-- Under SERIALIZABLE that EXISTS reads the snapshot the transaction took BEFORE it waited for the lock, and the first writer only LOCKED the Sale row (never
-- updated it), so no 40001 is raised either: a READ COMMITTED writer followed by a SERIALIZABLE one left a sale with BOTH a SaleVoid and a SaleExchange.
-- G19 and G18 are NOT modified; their guards stay (they still refuse the common case early, with their own messages) and this migration adds the
-- claim that does not depend on any snapshot.
--
-- DESIGN: "SalePostSaleGuard" has ONE row per sale that ever had a post-sale operation: (saleId PK, mode 'VOID' | 'EXCHANGE', createdAt). Both writers CLAIM
-- the same saleId through the SAME primary-key index:
--     INSERT ... ON CONFLICT ("saleId") DO UPDATE SET "mode" = "SalePostSaleGuard"."mode" RETURNING "mode"
-- The no-op UPDATE is intentional: it creates a REAL conflict on the same tuple, so
--   * READ COMMITTED  : waits for the other transaction; once it commits, the row is locked, updated and its mode returned; a different mode is refused (23514);
--   * SERIALIZABLE    : a row committed after the snapshot cannot be updated -> 40001 (the services retry it; the retry then sees the committed row and gets the
--                       domain answer: SALE_HAS_EXCHANGES / INVALID_SALE_STATE);
--   * the same mode again (several exchanges of one sale, an exchange after an exchange) is allowed.
-- A rolled-back writer rolls its claim back with it. A claimed sale stays claimed for good (a sale never changes family); the FK is RESTRICT / RESTRICT.
--
-- BACKFILL, atomic with the objects: BEFORE anything is written, a sale present in BOTH families aborts the migration with an explicit error (it never picks a
-- mode silently); then SaleVoid -> VOID and SaleExchange -> EXCHANGE. Both tables are locked (SHARE ROW EXCLUSIVE) so no row can appear between the
-- backfill and the triggers. Additive only: one table, one function, two triggers; no existing object is altered, no existing row is rewritten, and N-1
-- writers (the sale void release) keep working: their SaleVoid insert simply claims the sale.
--
-- Trigger order (by name, BEFORE ROW): SaleVoid    trg_sale_void_exchange_guard (G19: Sale FOR UPDATE + EXISTS), then trg_sale_void_post_sale_claim (this file);
--                                      SaleExchange trg_sale_exchange_append_only, trg_sale_exchange_header_guard (G18: Sale FOR UPDATE + COMPLETED),
--                                                   trg_sale_exchange_post_sale_claim (this file), trg_sale_exchange_void_guard (G19).
-- The claim itself also locks the Sale row first, so the lock order is Sale -> SalePostSaleGuard on every path and nothing can deadlock with the services.

LOCK TABLE public."SaleVoid", public."SaleExchange" IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE "SalePostSaleGuard" (
  "saleId" TEXT NOT NULL,
  "mode" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SalePostSaleGuard_pkey" PRIMARY KEY ("saleId"),
  CONSTRAINT "chk_sale_post_sale_guard_mode" CHECK ("mode" IN ('VOID', 'EXCHANGE')),
  CONSTRAINT "SalePostSaleGuard_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

DO $$
DECLARE
  conflicting integer;
BEGIN
  SELECT count(*) INTO conflicting
    FROM public."SaleVoid" v
   WHERE EXISTS (SELECT 1 FROM public."SaleExchange" x WHERE x."saleId" = v."saleId");
  IF conflicting > 0 THEN
    RAISE EXCEPTION 'sale_post_sale_guard backfill aborted: % sale(s) have BOTH a SaleVoid and a SaleExchange; no mode is chosen silently, resolve them first', conflicting
      USING ERRCODE = 'check_violation';
  END IF;
END $$;

INSERT INTO "SalePostSaleGuard" ("saleId", "mode") SELECT DISTINCT "saleId", 'VOID' FROM "SaleVoid";
INSERT INTO "SalePostSaleGuard" ("saleId", "mode") SELECT DISTINCT "saleId", 'EXCHANGE' FROM "SaleExchange";

CREATE FUNCTION public."fn_sale_post_sale_claim"() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  wanted text := TG_ARGV[0];
  claimed text;
BEGIN
  PERFORM 1 FROM public."Sale" s WHERE s."id" = NEW."saleId" FOR UPDATE;
  INSERT INTO public."SalePostSaleGuard" AS g ("saleId", "mode") VALUES (NEW."saleId", wanted)
    ON CONFLICT ("saleId") DO UPDATE SET "mode" = g."mode"
    RETURNING g."mode" INTO claimed;
  IF claimed IS DISTINCT FROM wanted THEN
    IF wanted = 'VOID' THEN
      RAISE EXCEPTION 'chk_sale_post_sale_guard: a sale with exchanges cannot be voided' USING ERRCODE = 'check_violation';
    END IF;
    RAISE EXCEPTION 'chk_sale_post_sale_guard: a voided sale cannot be exchanged' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "trg_sale_void_post_sale_claim" BEFORE INSERT OR UPDATE OF "saleId"
ON public."SaleVoid" FOR EACH ROW
EXECUTE FUNCTION public."fn_sale_post_sale_claim"('VOID');

CREATE TRIGGER "trg_sale_exchange_post_sale_claim" BEFORE INSERT OR UPDATE OF "saleId"
ON public."SaleExchange" FOR EACH ROW
EXECUTE FUNCTION public."fn_sale_post_sale_claim"('EXCHANGE');
