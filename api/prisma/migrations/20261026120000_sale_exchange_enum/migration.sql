-- Sale exchange v1 (G17), step A of 2: the two enum labels only.
--
-- A label added by `ALTER TYPE ... ADD VALUE` cannot be USED as an enum value in the
-- transaction that adds it (same rule documented in 20261018180000_cash_movement_reversals and
-- 20261024120000_sale_void_enum). Step B (20261026130000_sale_exchange_schema) therefore runs as
-- its own migration, and its CHECKs / trigger conditions compare "type"::text, never the new
-- labels as enum values.
-- Nothing else lives here. Additive: no row, table or constraint is touched.
ALTER TYPE "StockMovementType" ADD VALUE 'SALE_EXCHANGE_IN';
ALTER TYPE "StockMovementType" ADD VALUE 'SALE_EXCHANGE_OUT';
