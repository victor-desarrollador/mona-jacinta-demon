// PILOT G16 rollout (sale void v1, Stage 6A): the app-schema references and probes of the two generations after the
// G14 cut-over. A separate module on purpose: pilot-schema-references.mjs (G7..G14) is pinned by the PILOT tool
// manifests and stays untouched; EXACT_G14 is REUSED from it, not re-declared.
//
// SCHEMA_REFERENCES_POST_G14 — GENERATED, never hand-written: the app-owned schema projection digest
//   (app-schema-projection.mjs, format v2) of a disposable PostgreSQL 17 cluster built from nothing with exactly the
//   generation's pinned migrations. The same method reproduces the pinned EXACT_G14 digest byte for byte.
// GENERATION_PROBES — REVIEWED semantic facts on top of the digest. Each G16 object is listed explicitly (the delta of
//   the two sale void migrations) and, for G14/G15, its ABSENCE, so a half-applied or foreign database is refused
//   with a precise reason and not only a digest mismatch. pilot-g16-schema-references.test.mjs checks every name
//   against the migration SQL. Builtins only, no I/O.
import { SCHEMA_REFERENCES, STATE_PROBES } from './pilot-schema-references.mjs';

const t = (name) => ({ kind: 'table', name });
const col = (table, name) => ({ kind: 'column', table, name });
const con = (table, name, type) => ({ kind: 'constraint', table, name, type });
const idx = (table, name) => ({ kind: 'index', table, name });
const fn = (name) => ({ kind: 'function', name });
const trg = (table, name) => ({ kind: 'trigger', table, name });
const not = (probe) => ({ ...probe, kind: `absent${probe.kind[0].toUpperCase()}${probe.kind.slice(1)}` });
const freeze = (list) => Object.freeze(list.map((p) => Object.freeze({ ...p, ...(p.labels ? { labels: Object.freeze([...p.labels]) } : {}) })));

// The ENUM labels alone (migration 15, sale_void_enum).
const G15_ENUM_ADDS = [
  { kind: 'enumLabels', name: 'CashMovementType', labels: ['SALE_REFUND'] },
  { kind: 'enumLabels', name: 'StockMovementType', labels: ['SALE_VOID'] },
];
// Everything migration 16 (sale_void_schema) adds: tables, columns, constraints, indexes, functions, triggers.
const G16_SCHEMA_ADDS = [
  col('CashMovement', 'refundOfSalePaymentId'),
  t('SaleVoid'),
  col('SaleVoid', 'branchId'),
  col('SaleVoid', 'id'),
  col('SaleVoid', 'idempotencyKey'),
  col('SaleVoid', 'previousStatus'),
  col('SaleVoid', 'reason'),
  col('SaleVoid', 'saleId'),
  col('SaleVoid', 'voidedAt'),
  col('SaleVoid', 'voidedById'),
  t('SaleVoidExternalRefund'),
  col('SaleVoidExternalRefund', 'amount'),
  col('SaleVoidExternalRefund', 'evidence'),
  col('SaleVoidExternalRefund', 'id'),
  col('SaleVoidExternalRefund', 'method'),
  col('SaleVoidExternalRefund', 'saleId'),
  col('SaleVoidExternalRefund', 'salePaymentId'),
  col('SaleVoidExternalRefund', 'saleVoidId'),
  col('StockMovement', 'saleVoidId'),
  con('CashMovement', 'CashMovement_refundOfSalePaymentId_fkey', 'f'),
  con('CashMovement', 'chk_cash_movement_refund_link', 'c'),
  con('CashMovement', 'chk_cash_movement_refund_shape', 'c'),
  con('SaleVoid', 'SaleVoid_branchId_fkey', 'f'),
  con('SaleVoid', 'SaleVoid_pkey', 'p'),
  con('SaleVoid', 'SaleVoid_sale_branch_fkey', 'f'),
  con('SaleVoid', 'SaleVoid_voidedById_fkey', 'f'),
  con('SaleVoid', 'chk_sale_void_idempotency_key_not_blank', 'c'),
  con('SaleVoid', 'chk_sale_void_previous_status', 'c'),
  con('SaleVoid', 'chk_sale_void_reason_length', 'c'),
  con('SaleVoid', 'chk_sale_void_reason_not_blank', 'c'),
  con('SaleVoidExternalRefund', 'SaleVoidExternalRefund_payment_fkey', 'f'),
  con('SaleVoidExternalRefund', 'SaleVoidExternalRefund_pkey', 'p'),
  con('SaleVoidExternalRefund', 'SaleVoidExternalRefund_void_sale_fkey', 'f'),
  con('SaleVoidExternalRefund', 'chk_sale_void_external_refund_amount', 'c'),
  con('SaleVoidExternalRefund', 'chk_sale_void_external_refund_evidence', 'c'),
  con('SaleVoidExternalRefund', 'chk_sale_void_external_refund_method', 'c'),
  con('StockMovement', 'StockMovement_saleVoid_sale_branch_fkey', 'f'),
  con('StockMovement', 'chk_stock_movement_sale_void_only', 'c'),
  con('StockMovement', 'chk_stock_movement_sale_void_shape', 'c'),
  idx('CashMovement', 'CashMovement_refundOfSalePaymentId_key'),
  idx('SalePayment', 'SalePayment_id_saleId_method_amount_key'),
  idx('SaleVoid', 'SaleVoid_branchId_voidedAt_idx'),
  idx('SaleVoid', 'SaleVoid_id_saleId_branchId_key'),
  idx('SaleVoid', 'SaleVoid_id_saleId_key'),
  idx('SaleVoid', 'SaleVoid_pkey'),
  idx('SaleVoid', 'SaleVoid_saleId_branchId_key'),
  idx('SaleVoid', 'SaleVoid_saleId_key'),
  idx('SaleVoid', 'SaleVoid_voidedById_idx'),
  idx('SaleVoidExternalRefund', 'SaleVoidExternalRefund_pkey'),
  idx('SaleVoidExternalRefund', 'SaleVoidExternalRefund_salePaymentId_key'),
  idx('SaleVoidExternalRefund', 'SaleVoidExternalRefund_saleVoidId_idx'),
  idx('StockMovement', 'StockMovement_saleVoidId_idx'),
  idx('StockMovement', 'StockMovement_saleVoidId_inventoryId_key'),
  fn('fn_cash_movement_refund_guard'),
  fn('fn_sale_payment_refund_frozen'),
  trg('CashMovement', 'trg_cash_movement_refund_guard'),
  trg('SalePayment', 'trg_sale_payment_refund_frozen'),
];

export const GENERATION_PROBES = Object.freeze({
  EXACT_G14: freeze([...STATE_PROBES.EXACT_G14, ...G15_ENUM_ADDS.map(not), ...G16_SCHEMA_ADDS.map(not)]),
  EXACT_G15: freeze([...STATE_PROBES.EXACT_G14, ...G15_ENUM_ADDS, ...G16_SCHEMA_ADDS.map(not)]),
  EXACT_G16: freeze([...STATE_PROBES.EXACT_G14, ...G15_ENUM_ADDS, ...G16_SCHEMA_ADDS]),
});

// Generated 2026-10-24 on fresh disposable PostgreSQL 17 clusters (see the header); EXACT_G14 is the pinned one.
export const SCHEMA_REFERENCES_POST_G14 = Object.freeze({
  EXACT_G14: SCHEMA_REFERENCES.EXACT_G14,
  EXACT_G15: Object.freeze({ digest: '111f1d0413d70d8a9ad276734907c0910850c93f06bfdf6917255cba63b78266', summary: Object.freeze({"tables": 31, "columns": 304, "enums": 18, "types": 0, "constraints": 151, "indexes": 130, "functions": 9, "triggers": 10}) }),
  EXACT_G16: Object.freeze({ digest: '87ecc8d780b9a7fae79de6d4bd0eaf1ecba354e6ed2e7c9e5da4da3c30c9c7b3', summary: Object.freeze({"tables": 33, "columns": 321, "enums": 18, "types": 0, "constraints": 171, "indexes": 144, "functions": 11, "triggers": 12}) }),
});

// The pair every tool of this rollout hands to verifySnapshot-style checks.
export const GENERATION_SCHEMA = Object.freeze({ references: SCHEMA_REFERENCES_POST_G14, probes: GENERATION_PROBES });
