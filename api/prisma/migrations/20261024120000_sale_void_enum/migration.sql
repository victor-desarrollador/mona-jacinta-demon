-- Sale void v1 (post-payment void), step A of 2: the two enum labels only.
--
-- A label added by `ALTER TYPE ... ADD VALUE` cannot be USED as an enum value in the
-- transaction that adds it (same rule documented in 20261018180000_cash_movement_reversals).
-- Step B (20261024130000_sale_void_schema) therefore runs as its own migration, and its
-- CHECKs compare "type"::text, never the new labels as enum values.
-- Nothing else lives here. Additive: no row, table or constraint is touched.
ALTER TYPE "CashMovementType" ADD VALUE 'SALE_REFUND';
ALTER TYPE "StockMovementType" ADD VALUE 'SALE_VOID';
