// PILOT G12 cut-over: the app-schema references every PILOT tool compares against.
//
// SCHEMA_REFERENCES — GENERATED, never hand-written: the app-owned schema projection digest
//   (app-schema-projection.mjs) of a disposable PostgreSQL 17 cluster built from nothing with
//   EXACTLY the state's pinned migrations through `prisma migrate deploy`, produced by
//   scripts/database/pilot-schema-reference.mjs. A new or changed migration needs a new
//   generation, its review, and new manifests for the tools that pin this file.
// STATE_PROBES — REVIEWED, explicit semantic facts checked on top of the digest: objects a
//   state must have, and objects only a later migration creates (so an S4/G7 database that
//   already carries part of m5–m12 is refused with a precise reason, not only a digest
//   mismatch). pilot-schema-references.test.mjs checks every name against the migrations.
// Builtins only, no I/O.

const t = (name) => ({ kind: 'table', name });
const col = (table, name) => ({ kind: 'column', table, name });
const con = (table, name, type) => ({ kind: 'constraint', table, name, type });
const idx = (table, name) => ({ kind: 'index', table, name });
const fn = (name) => ({ kind: 'function', name });
const trg = (table, name) => ({ kind: 'trigger', table, name });
const not = (probe) => ({ ...probe, kind: `absent${probe.kind[0].toUpperCase()}${probe.kind.slice(1)}` });
const freeze = (list) => Object.freeze(list.map((p) => Object.freeze({ ...p, ...(p.labels ? { labels: Object.freeze([...p.labels]) } : {}) })));

const CORE = [
  t('Company'), t('Location'), t('Branch'), t('User'), t('Role'), t('Permission'), t('RolePermission'), t('UserRoleScope'),
  t('Product'), t('ProductVariant'), t('Inventory'), t('StockMovement'), t('StockReservation'), t('Sale'), t('SaleItem'),
  t('SalePayment'), t('CashRegister'), t('CashSession'), t('CashMovement'), t('AuditLog'),
  col('UserRoleScope', 'scopeKind'), col('Location', 'companyId'), idx('CashMovement', 'CashMovement_salePaymentId_key'),
];
// m5 (block1 pricing/wholesale) + m6 (pilot pricing v2) + m7 (CASH-1 reconciliation).
const G7_ADDS = [
  t('CompanyPricingConfig'), col('Sale', 'pricingMode'), col('Sale', 'priceMode'), col('Sale', 'paymentStartedAt'),
  col('ProductVariant', 'cashPrice'), col('ProductVariant', 'wholesalePrice'),
  col('CashSession', 'expectedCash'), col('CashSession', 'countedCash'), col('CashSession', 'difference'),
  con('Sale', 'chk_sale_wholesale_state', 'c'), con('Sale', 'Sale_wholesaleConfirmedById_fkey', 'f'),
  fn('fn_sale_payment_history'), fn('fn_sale_payment_truncate_guard'), fn('fn_sale_wholesale_frozen_after_payment'),
  trg('SalePayment', 'trg_sale_payment_history_before'), trg('SalePayment', 'trg_sale_payment_history_after'),
  trg('SalePayment', 'trg_sale_payment_truncate_guard'), trg('Sale', 'trg_sale_wholesale_frozen_after_payment'),
];
// m8 (R3 proportional checkout) + m9 (checkout attempts, functions/triggers F1–F6).
const R3_ADDS = [
  t('SaleCheckout'), t('SaleLineAllocation'), t('ExternalCollection'), t('CheckoutAttempt'), t('CheckoutAttemptTender'), t('CheckoutAttemptDeclaration'),
  col('Sale', 'pricingModel'), col('SalePayment', 'checkoutId'), col('SaleCheckout', 'attemptStatus'),
  con('Sale', 'chk_sale_proportional_cash_mode', 'c'), con('SalePayment', 'chk_payment_checkout_shape', 'c'),
  con('SalePayment', 'SalePayment_sale_pricing_model_fkey', 'f'),
  idx('ExternalCollection', 'ExternalCollection_transfer_ref_key'), idx('ExternalCollection', 'ExternalCollection_debit_ref_key'),
  idx('CheckoutAttempt', 'CheckoutAttempt_one_open_per_sale'), idx('CheckoutAttempt', 'CheckoutAttempt_reserveKey_key'),
  fn('fn_checkout_attempt_guard'), fn('fn_checkout_attempt_tender_guard'), fn('fn_checkout_attempt_commit_check'),
  fn('fn_checkout_attempt_declaration_guard'), fn('fn_checkout_declaration_commit_check'), fn('fn_external_collection_guard'),
  trg('CheckoutAttempt', 'trg_checkout_attempt_guard'), trg('CheckoutAttemptTender', 'trg_checkout_attempt_tender_guard'),
  trg('CheckoutAttempt', 'trg_checkout_attempt_commit_check'), trg('CheckoutAttemptDeclaration', 'trg_checkout_attempt_declaration_guard'),
  trg('CheckoutAttemptDeclaration', 'trg_checkout_declaration_commit_check'), trg('ExternalCollection', 'trg_external_collection_guard'),
];
// m10 (cash exits) + m11 (cash reversals).
const CASH_ADDS = [
  col('CashMovement', 'reason'), col('CashMovement', 'idempotencyKey'), col('CashMovement', 'reversesMovementId'),
  { kind: 'enumLabels', name: 'CashMovementType', labels: ['WITHDRAWAL', 'EXPENSE', 'WITHDRAWAL_REVERSAL', 'EXPENSE_REVERSAL'] },
  idx('CashMovement', 'CashMovement_sessionId_idempotencyKey_key'), idx('CashMovement', 'CashMovement_reversesMovementId_key'),
  idx('CashMovement', 'CashMovement_id_sessionId_key'),
  con('CashMovement', 'chk_cash_movement_exit_amount', 'c'), con('CashMovement', 'chk_cash_movement_exit_reason', 'c'),
  con('CashMovement', 'chk_cash_movement_exit_no_payment', 'c'), con('CashMovement', 'chk_cash_movement_reversal_link', 'c'),
  con('CashMovement', 'chk_cash_movement_reversal_shape', 'c'), con('CashMovement', 'chk_cash_movement_reversal_not_self', 'c'),
  con('CashMovement', 'CashMovement_reversesMovementId_sessionId_fkey', 'f'),
];

export const STATE_PROBES = Object.freeze({
  EXACT_S4: freeze([
    ...CORE,
    not(t('CompanyPricingConfig')), not(col('Sale', 'pricingMode')), not(col('Sale', 'priceMode')), not(col('CashSession', 'expectedCash')),
    not(fn('fn_sale_payment_history')), not(t('SaleCheckout')), not(t('CheckoutAttempt')), not(col('CashMovement', 'reason')),
    { kind: 'absentEnumLabels', name: 'CashMovementType', labels: ['WITHDRAWAL', 'EXPENSE', 'WITHDRAWAL_REVERSAL', 'EXPENSE_REVERSAL'] },
  ]),
  EXACT_G7: freeze([
    ...CORE, ...G7_ADDS,
    not(t('SaleCheckout')), not(t('CheckoutAttempt')), not(col('Sale', 'pricingModel')), not(fn('fn_checkout_attempt_guard')),
    not(col('CashMovement', 'reason')), not(col('CashMovement', 'reversesMovementId')),
    { kind: 'absentEnumLabels', name: 'CashMovementType', labels: ['WITHDRAWAL', 'EXPENSE', 'WITHDRAWAL_REVERSAL', 'EXPENSE_REVERSAL'] },
  ]),
  EXACT_G11: freeze([...CORE, ...G7_ADDS, ...R3_ADDS, ...CASH_ADDS]),
  EXACT_G12: freeze([...CORE, ...G7_ADDS, ...R3_ADDS, ...CASH_ADDS]),
});

// GENERATED by scripts/database/pilot-schema-reference.mjs through the LOCAL_TEST cut-over lab
// (local-test-cutover-lab.mjs --op=schema-reference), 2026-10-18, projection format v2, each on a FRESH disposable
// PostgreSQL 17 cluster built with exactly the state's migrations; reproduced identically on a
// second independent cluster per state (different system_identifier). Reviewed against the
// state contracts (tables 24/25/31, app functions 0/3/9, app triggers 0/4/10; all probes pass).
export const SCHEMA_REFERENCES = Object.freeze({
  EXACT_S4: Object.freeze({ digest: '8007dcd1ab599bc561112dd8c0388153c8f0d3fa3922055e3f6a586cabba6ff4', summary: Object.freeze({ tables: 24, columns: 141, enums: 8, types: 0, constraints: 63, indexes: 81, functions: 0, triggers: 0 }) }),
  EXACT_G7: Object.freeze({ digest: '070cbeea216d77de9ad37014e1991b328a881b91ee0aa21a2e15c391c771d670', summary: Object.freeze({ tables: 25, columns: 167, enums: 10, types: 0, constraints: 73, indexes: 83, functions: 3, triggers: 4 }) }),
  EXACT_G11: Object.freeze({ digest: 'd7fc76e47695591e57d96e7cebfaddb23aff3aec6b7a193ab16a929699731ad8', summary: Object.freeze({ tables: 31, columns: 293, enums: 17, types: 0, constraints: 144, indexes: 127, functions: 9, triggers: 10 }) }),
  EXACT_G12: Object.freeze({ digest: '38376b23538b71f0e848c9980711282da2ec33da9b40d9e6c2616e4ab301617e', summary: Object.freeze({ tables: 31, columns: 297, enums: 17, types: 0, constraints: 146, indexes: 128, functions: 9, triggers: 10 }) }),
});
