// PILOT G19 rollout (sale exchange v1): the app-schema references and probes of the generations after G16. A separate module on
// purpose: pilot-g16-schema-references.mjs (G14..G16) and pilot-schema-references.mjs (G7..G14) are pinned by the PILOT tool
// manifests and by the G16 tools and stay untouched; EXACT_G14, EXACT_G15 and EXACT_G16 are REUSED from them, not re-declared.
//
// GENERATION_PROBES_G19 — REVIEWED semantic facts. Each object a migration adds is listed explicitly (tables, columns, constraints,
//   indexes, functions, triggers, enum labels) and, for every earlier generation, its ABSENCE, so a half-applied or foreign database is
//   refused with a precise reason and not only with a digest mismatch. pilot-g19-schema-references.test.mjs checks every name against the
//   migration SQL (the names were extracted from the SQL, not typed from memory). Builtins only, no I/O.
//
// SCHEMA_REFERENCES_G19 — the app-owned schema projection digest (app-schema-projection.mjs, format v2) of a disposable PostgreSQL 17
//   cluster built from nothing with exactly the generation's pinned migrations. GENERATED, never hand-written: by
//   pilot-g19-schema-reference.mjs on a throwaway PostgreSQL 17.11 cluster (private network namespace, LOCAL_TEST marker), rebuilding the
//   database from nothing for each generation. EXACT_G16 is the CONTROL: the method reproduced the previously pinned digest byte for byte
//   (87ecc8d7…c7b3) before the three new values were trusted. A reference that is ever null/`pending: true` again (a future generation)
//   is refused by every tool of this rollout (fail closed) — see PENDING below, kept as the shape of that state.
import { GENERATION_PROBES as PROBES_G16, SCHEMA_REFERENCES_POST_G14 } from './pilot-g16-schema-references.mjs';

const t = (name) => ({ kind: 'table', name });
const col = (table, name) => ({ kind: 'column', table, name });
const con = (table, name, type) => ({ kind: 'constraint', table, name, type });
const idx = (table, name) => ({ kind: 'index', table, name });
const fn = (name) => ({ kind: 'function', name });
const trg = (table, name) => ({ kind: 'trigger', table, name });
const not = (probe) => ({ ...probe, kind: `absent${probe.kind[0].toUpperCase()}${probe.kind.slice(1)}` });
const freeze = (list) => Object.freeze(list.map((p) => Object.freeze({ ...p, ...(p.labels ? { labels: Object.freeze([...p.labels]) } : {}) })));

// The ENUM labels alone (migration 17, sale_exchange_enum).
const G17_ENUM_ADDS = [{ kind: 'enumLabels', name: 'StockMovementType', labels: ['SALE_EXCHANGE_IN', 'SALE_EXCHANGE_OUT'] }];
// Everything migration 18 (sale_exchange_schema) adds.
const G18_SCHEMA_ADDS = [
  t('SaleExchange'),
  col('SaleExchange', 'branchId'),
  col('SaleExchange', 'createdAt'),
  col('SaleExchange', 'createdById'),
  col('SaleExchange', 'id'),
  col('SaleExchange', 'idempotencyKey'),
  col('SaleExchange', 'reason'),
  col('SaleExchange', 'requestHash'),
  col('SaleExchange', 'saleId'),
  t('SaleExchangeLine'),
  col('SaleExchangeLine', 'branchId'),
  col('SaleExchangeLine', 'id'),
  col('SaleExchangeLine', 'originalUnitPrice'),
  col('SaleExchangeLine', 'replacementUnitPrice'),
  col('SaleExchangeLine', 'replacementVariantId'),
  col('SaleExchangeLine', 'returnQuantity'),
  col('SaleExchangeLine', 'saleExchangeId'),
  col('SaleExchangeLine', 'saleId'),
  col('SaleExchangeLine', 'saleItemId'),
  col('StockMovement', 'saleExchangeId'),
  col('StockMovement', 'saleExchangeLineId'),
  con('SaleExchange', 'SaleExchange_createdBy_fkey', 'f'),
  con('SaleExchange', 'SaleExchange_pkey', 'p'),
  con('SaleExchange', 'SaleExchange_sale_branch_fkey', 'f'),
  con('SaleExchange', 'chk_sale_exchange_idempotency_key_uuid_v4', 'c'),
  con('SaleExchange', 'chk_sale_exchange_reason', 'c'),
  con('SaleExchange', 'chk_sale_exchange_request_hash', 'c'),
  con('SaleExchangeLine', 'SaleExchangeLine_exchange_fkey', 'f'),
  con('SaleExchangeLine', 'SaleExchangeLine_pkey', 'p'),
  con('SaleExchangeLine', 'SaleExchangeLine_replacementVariant_fkey', 'f'),
  con('SaleExchangeLine', 'SaleExchangeLine_saleItem_fkey', 'f'),
  con('SaleExchangeLine', 'chk_sale_exchange_line_prices_positive', 'c'),
  con('SaleExchangeLine', 'chk_sale_exchange_line_quantity_positive', 'c'),
  con('SaleExchangeLine', 'chk_sale_exchange_line_same_value', 'c'),
  con('StockMovement', 'StockMovement_saleExchangeLine_fkey', 'f'),
  con('StockMovement', 'StockMovement_saleExchange_sale_branch_fkey', 'f'),
  con('StockMovement', 'chk_stock_movement_sale_exchange_in_positive', 'c'),
  con('StockMovement', 'chk_stock_movement_sale_exchange_only', 'c'),
  con('StockMovement', 'chk_stock_movement_sale_exchange_out_negative', 'c'),
  con('StockMovement', 'chk_stock_movement_sale_exchange_shape', 'c'),
  idx('SaleExchange', 'SaleExchange_branchId_createdAt_idx'),
  idx('SaleExchange', 'SaleExchange_createdById_idx'),
  idx('SaleExchange', 'SaleExchange_id_saleId_branchId_key'),
  idx('SaleExchange', 'SaleExchange_pkey'),
  idx('SaleExchange', 'SaleExchange_saleId_createdAt_idx'),
  idx('SaleExchange', 'SaleExchange_saleId_idempotencyKey_key'),
  idx('SaleExchangeLine', 'SaleExchangeLine_id_saleExchangeId_saleId_branchId_key'),
  idx('SaleExchangeLine', 'SaleExchangeLine_pkey'),
  idx('SaleExchangeLine', 'SaleExchangeLine_replacementVariantId_idx'),
  idx('SaleExchangeLine', 'SaleExchangeLine_saleExchangeId_saleItemId_key'),
  idx('SaleExchangeLine', 'SaleExchangeLine_saleItemId_idx'),
  idx('StockMovement', 'StockMovement_saleExchangeId_idx'),
  idx('StockMovement', 'StockMovement_saleExchangeLineId_type_key'),
  fn('fn_sale_exchange_append_only'),
  fn('fn_sale_exchange_has_lines'),
  fn('fn_sale_exchange_header_guard'),
  fn('fn_sale_exchange_ledger_check'),
  fn('fn_sale_exchange_line_remainder'),
  trg('SaleExchange', 'trg_sale_exchange_append_only'),
  trg('SaleExchange', 'trg_sale_exchange_has_lines'),
  trg('SaleExchange', 'trg_sale_exchange_header_guard'),
  trg('SaleExchangeLine', 'trg_sale_exchange_line_append_only'),
  trg('SaleExchangeLine', 'trg_sale_exchange_line_ledger_check'),
  trg('SaleExchangeLine', 'trg_sale_exchange_line_remainder'),
  trg('StockMovement', 'trg_stock_movement_sale_exchange_ledger_check'),
  trg('StockMovement', 'trg_stock_movement_sale_exchange_no_delete'),
  trg('StockMovement', 'trg_stock_movement_sale_exchange_no_update'),
];
// Everything migration 19 (sale_void_exchange_guard) adds: the two sides of the SaleVoid / SaleExchange exclusion.
const G19_GUARD_ADDS = [
  fn('fn_sale_exchange_void_guard'),
  fn('fn_sale_void_exchange_guard'),
  trg('SaleExchange', 'trg_sale_exchange_void_guard'),
  trg('SaleVoid', 'trg_sale_void_exchange_guard'),
];

// G14 and G15 are not initial or final states of the G19 tools; they are kept so the table is complete and a G14/G15 database is named.
const withAbsence = (present, absent) => freeze([...present, ...absent.map(not)]);
const G16_BASE = PROBES_G16.EXACT_G16;
export const GENERATION_PROBES_G19 = Object.freeze({
  EXACT_G16: withAbsence(G16_BASE, [...G17_ENUM_ADDS, ...G18_SCHEMA_ADDS, ...G19_GUARD_ADDS]),
  EXACT_G17: withAbsence([...G16_BASE, ...G17_ENUM_ADDS], [...G18_SCHEMA_ADDS, ...G19_GUARD_ADDS]),
  EXACT_G18: withAbsence([...G16_BASE, ...G17_ENUM_ADDS, ...G18_SCHEMA_ADDS], G19_GUARD_ADDS),
  EXACT_G19: freeze([...G16_BASE, ...G17_ENUM_ADDS, ...G18_SCHEMA_ADDS, ...G19_GUARD_ADDS]),
});

// Generated 2026-10-26 on a fresh disposable PostgreSQL 17.11 cluster (see the header); EXACT_G16 is the pinned one (control).
export const SCHEMA_REFERENCES_G19 = Object.freeze({
  EXACT_G16: SCHEMA_REFERENCES_POST_G14.EXACT_G16,
  EXACT_G17: Object.freeze({ digest: 'e216fc1ca60b1c32914338992e74058e7c3bc50ab50baac0ffe36b283a098b94', summary: Object.freeze({ tables: 33, columns: 321, enums: 18, types: 0, constraints: 171, indexes: 144, functions: 11, triggers: 12 }) }),
  EXACT_G18: Object.freeze({ digest: '3aed5a91e63935142c6b97fea5a646542699500a56910fea1cfcd270431d55df', summary: Object.freeze({ tables: 35, columns: 340, enums: 18, types: 0, constraints: 190, indexes: 157, functions: 16, triggers: 21 }) }),
  EXACT_G19: Object.freeze({ digest: '2328d43f8f779ae4db023019b354072d2afa275011810d42e7c2cfdbbbc22dad', summary: Object.freeze({ tables: 35, columns: 340, enums: 18, types: 0, constraints: 190, indexes: 157, functions: 18, triggers: 23 }) }),
});
export const PENDING_REFERENCES = Object.freeze(Object.entries(SCHEMA_REFERENCES_G19).filter(([, r]) => r.pending === true).map(([g]) => g));

// The pair every tool of this rollout hands to verifySnapshot-style checks.
export const GENERATION_SCHEMA_G19 = Object.freeze({ references: SCHEMA_REFERENCES_G19, probes: GENERATION_PROBES_G19 });
