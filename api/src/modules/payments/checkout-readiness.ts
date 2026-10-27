// R3-A4.3 S9 — the startup readiness gate.
//
// The API must not accept traffic with a proportional-checkout feature enabled
// against a database that does not yet carry migrations 8 and 9. This module is
// the small, stable, fail-closed check that runs once, in api/src/server.ts,
// AFTER the environment is parsed and BEFORE httpServer.listen(). If no feature
// is on it is a no-op and reads nothing.
//
// PILOT G11 cut-over (OWNER 2026-10-18), extended by the CARD_CREDIT block to G12, by
// the WAREHOUSE-MVP block to G13 and by the QR block (P0-B) to G14: the gate is STRICT. This release ships the cash movement features (exits, reversals,
// movement history; open/close read and write the m10/m11 CashMovement columns) the
// CARD_CREDIT snapshot columns (m12), the manual stock-adjustment columns (m13) and the
// QR snapshot columns (m14) unconditionally, so the gate always runs and requires m8, m9,
// m10, m11, m12, m13 AND m14 exactly, plus a bounded catalog probe of the R3, cash, credit,
// warehouse and QR objects: the API never starts on a database that has m8/m9 but not
// m10/m11/m12/m13/m14. The contract notes below about "both flags OFF" now describe the
// injected all-features-off case only.
//
// Contract (OWNER, S9):
//   - OPTION A: abort startup (no listen) when R3 is on and the database is not
//     ready; there is no polling and no retry — a connection failure or a
//     timeout is a failure.
//   - Scope: with both flags OFF the gate never touches the database.
//   - Both features (the location selector and the external methods) require
//     migrations 8 AND 9, fully applied.
//   - Readiness = the ledger proves each required migration applied with the
//     exact pinned checksum, not rolled back and finished, AND a minimal catalog
//     probe proves the objects the pilot actually uses exist (so a partially
//     applied migration cannot read as READY).
//
// The migration names and their SHA-256 are pinned LITERALS: at runtime this
// module never reads prisma/migrations from the filesystem (the built
// dist/ may not ship it). api/tests/payments/checkout-readiness.static.test.ts
// is the development drift detector that compares these pins against the real
// migration.sql bytes. This module deliberately does not import the OWNER-only
// database tooling (pilot-migrate.mjs, local-test-prepare.mjs) and does not
// reproduce the full schema fingerprint: it is a runtime gate, not tooling.
import type { PrismaClient } from '../../generated/prisma/client.js';
import type { Env } from '../../config/env.js';

// The single stable error code for a failed gate. The reason is always one of
// the closed set below; nothing else is ever produced or logged.
export const R3_DATABASE_NOT_READY = 'R3_DATABASE_NOT_READY';

export type R3ReadinessReason =
  | 'MIGRATION_MISSING'
  | 'MIGRATION_UNFINISHED'
  | 'MIGRATION_ROLLED_BACK'
  | 'MIGRATION_CHECKSUM_DRIFT'
  | 'SCHEMA_OBJECT_MISSING'
  | 'DATABASE_UNREACHABLE';

export type MigrationPin = { readonly name: string; readonly sha256: string };

// G11-ADV-004: one m9 trigger binding and one reviewed CHECK rendering.
export type TriggerBinding = { readonly table: string; readonly trigger: string };
export type CheckDefinitionPin = { readonly name: string; readonly definition: string };

// Reviewed bytes of the two R3 migrations. A change to either migration file is
// a new review and a new pin; the static test fails until they are updated.
export const R3_MIGRATION_PINS: readonly MigrationPin[] = Object.freeze([
  Object.freeze({ name: '20261016120000_r3_proportional_checkout', sha256: '217e87eb5b156a57a5edcfd73433e1e9558ce59caa019208d9df8c0268f08dc6' }),
  Object.freeze({ name: '20261016130000_r3_checkout_attempts', sha256: '076884120da38a05099ee00dbb16aafaa9e8c78f5846889fe7f590a8e95d9148' }),
]);

// The minimal catalog evidence that the R3 schema is really present. The m8
// tables (a partially applied migration 8 could create one and not the others),
// the m9 tables, and every m9 trigger function F1–F6: a tables-only probe would
// read READY on a migration 9 that created the tables but not the guards and the
// deferred commit checks the pilot's T-X / T-C / T-F paths depend on. Bounded on
// purpose: twelve names, never a column-by-column fingerprint.
export const R3_CATALOG_OBJECTS: readonly string[] = Object.freeze([
  'SaleCheckout', 'ExternalCollection', 'SaleLineAllocation',
  'CheckoutAttempt', 'CheckoutAttemptTender', 'CheckoutAttemptDeclaration',
  'fn_checkout_attempt_guard', 'fn_checkout_attempt_tender_guard', 'fn_checkout_attempt_commit_check',
  'fn_checkout_attempt_declaration_guard', 'fn_checkout_declaration_commit_check', 'fn_external_collection_guard',
]);

// PILOT G11 cut-over (OWNER 2026-10-18): the reviewed bytes of the cash-exit (m10)
// and cash-reversal (m11) migrations. Same rule as the R3 pins above.
export const CASH_MIGRATION_PINS: readonly MigrationPin[] = Object.freeze([
  Object.freeze({ name: '20261018120000_cash_movement_withdrawals_expenses', sha256: 'e37149442d1fb82ec87877e7b3e1f2e4311b36a9d47d314a3fd1843702c5adf9' }),
  Object.freeze({ name: '20261018180000_cash_movement_reversals', sha256: 'd638559da376f5c4fb1f71136027c0af426906b8b8a2c582f388e73ffd1b3770' }),
]);
// G11 strict: whenever the gate runs, all four post-G7 migrations are required.
export const G11_MIGRATION_PINS: readonly MigrationPin[] = Object.freeze([...R3_MIGRATION_PINS, ...CASH_MIGRATION_PINS]);

// CARD_CREDIT block (OWNER 2026-10-21): the reviewed bytes of migration 12, the additive
// CARD_CREDIT migration (credit snapshot columns, widened CHECKs, credit reference index,
// replaced F1). The code that writes those columns must never run on a database without
// it, so G12 = G11 + m12 is what the gate requires from now on. Same rule as every pin.
export const CREDIT_MIGRATION_PINS: readonly MigrationPin[] = Object.freeze([
  Object.freeze({ name: '20261021120000_r3_card_credit', sha256: 'ccec6685120cc9236c5c95a57f2922dc5bbe09cf759ff21b4c9a3635d893f6be' }),
]);
export const G12_MIGRATION_PINS: readonly MigrationPin[] = Object.freeze([...G11_MIGRATION_PINS, ...CREDIT_MIGRATION_PINS]);

// WAREHOUSE-MVP (OWNER 2026-10-21): the reviewed bytes of migration 13, the additive manual
// stock-adjustment migration (StockMovement ADJUSTMENT + reason/note/idempotencyKey, the
// reason enum, the idempotency unique index and three CHECKs). The inventory adjustment
// endpoint writes those columns unconditionally, so the code must never run on a database
// without it: G13 = G12 + m13 is what the gate requires from now on. Same rule as every pin.
export const WAREHOUSE_MIGRATION_PINS: readonly MigrationPin[] = Object.freeze([
  Object.freeze({ name: '20261021130000_warehouse_stock_adjustment', sha256: '819d669933639173e1b21879791c14eb3cced33c0d8417ca30dd07800fb252c0' }),
]);
export const G13_MIGRATION_PINS: readonly MigrationPin[] = Object.freeze([...G12_MIGRATION_PINS, ...WAREHOUSE_MIGRATION_PINS]);

// QR block (P0-B, OWNER 2026-10-21): the reviewed bytes of migration 14, the additive QR
// snapshot migration (fullPriceQr / qrAdjustmentBps on SaleCheckout and CheckoutAttempt, the
// widened method CHECKs, the QR reference index and the F1 guard that freezes the QR columns).
// The checkout services read and write those columns unconditionally, so the code must never
// run on a database without it: G14 = G13 + m14 is what the gate requires from now on.
export const QR_MIGRATION_PINS: readonly MigrationPin[] = Object.freeze([
  Object.freeze({ name: '20261021140000_r3_qr', sha256: '32ad30fc0b0aa847d1393ba1fb77419a286470e616973c6bd48de97e6192104a' }),
]);
export const G14_MIGRATION_PINS: readonly MigrationPin[] = Object.freeze([...G13_MIGRATION_PINS, ...QR_MIGRATION_PINS]);

// The minimal catalog evidence that m14 is really present: the four QR snapshot columns, the
// two QR snapshot CHECKs (validated) and the QR reference index.
export const QR_CATALOG_OBJECTS: readonly string[] = Object.freeze([
  'SaleCheckout.fullPriceQr', 'SaleCheckout.qrAdjustmentBps',
  'CheckoutAttempt.fullPriceQr', 'CheckoutAttempt.qrAdjustmentBps',
  'chk_checkout_qr_snapshot', 'chk_attempt_qr_snapshot', 'ExternalCollection_qr_ref_key',
]);

// The minimal catalog evidence that m13 is really present: the three adjustment columns,
// the ADJUSTMENT label and the five reason labels, the idempotency unique index and the
// three SQL-only CHECKs (validated). Names are the real ones of the migration.
export const WAREHOUSE_CATALOG_OBJECTS: readonly string[] = Object.freeze([
  'StockMovement.reason', 'StockMovement.note', 'StockMovement.idempotencyKey',
  'StockMovementType.ADJUSTMENT',
  'StockAdjustmentReason.DAMAGED', 'StockAdjustmentReason.LOST', 'StockAdjustmentReason.LOAD_ERROR',
  'StockAdjustmentReason.SURPLUS', 'StockAdjustmentReason.OTHER',
  'StockMovement_userId_idempotencyKey_key',
  'chk_stock_movement_adjustment_shape', 'chk_stock_movement_adjustment_reason_rules', 'chk_stock_movement_reason_only_adjustment',
]);

// The minimal catalog evidence that m12 is really present: the four credit snapshot
// columns, the two credit snapshot CHECKs (validated) and the credit reference index.
export const CREDIT_CATALOG_OBJECTS: readonly string[] = Object.freeze([
  'SaleCheckout.fullPriceCredit', 'SaleCheckout.creditAdjustmentBps',
  'CheckoutAttempt.fullPriceCredit', 'CheckoutAttempt.creditAdjustmentBps',
  'chk_checkout_credit_snapshot', 'chk_attempt_credit_snapshot', 'ExternalCollection_credit_ref_key',
]);

// The minimal catalog evidence that the m10/m11 cash schema is really present: the
// three CashMovement columns the cash service reads and writes, the four enum labels
// it inserts, all three unique indexes and the composite FK — plus the six SQL-only
// CHECK constraints (G11-ADV-004): a database re-created from a partial or tampered
// m10/m11 payload can never again read READY just because its columns and enums
// match, since the CHECKs and the idempotency/same-session indexes are exactly the
// invariants the pilot's cash service relies on. Bounded.
export const CASH_CATALOG_OBJECTS: readonly string[] = Object.freeze([
  'CashMovement.reason', 'CashMovement.idempotencyKey', 'CashMovement.reversesMovementId',
  'CashMovementType.WITHDRAWAL', 'CashMovementType.EXPENSE', 'CashMovementType.WITHDRAWAL_REVERSAL', 'CashMovementType.EXPENSE_REVERSAL',
  'CashMovement_reversesMovementId_key', 'CashMovement_sessionId_idempotencyKey_key', 'CashMovement_id_sessionId_key',
  'CashMovement_reversesMovementId_sessionId_fkey',
  'chk_cash_movement_exit_amount', 'chk_cash_movement_exit_reason', 'chk_cash_movement_exit_no_payment',
  'chk_cash_movement_reversal_link', 'chk_cash_movement_reversal_shape', 'chk_cash_movement_reversal_not_self',
]);

// G11-ADV-004: the six m9 trigger BINDINGS (table, trigger). Function existence
// (R3_CATALOG_OBJECTS) alone would accept a database whose trigger was (re)created
// without a table it must fire on, or whose trigger was dropped while the function
// stayed. Each entry probes the real pg_trigger row: the trigger name on THAT table,
// visible (never tgisinternal). The two DEFERRABLE CONSTRAINT triggers are covered
// the same way (a CHECK-style tgldef pin would over-bind the release). The m5 Block-1
// triggers stay out on purpose: the G9 schema fingerprint covers them tooling-side.
export const R3_TRIGGER_BINDINGS: readonly TriggerBinding[] = Object.freeze([
  Object.freeze({ table: 'CheckoutAttempt', trigger: 'trg_checkout_attempt_guard' }),
  Object.freeze({ table: 'CheckoutAttemptTender', trigger: 'trg_checkout_attempt_tender_guard' }),
  Object.freeze({ table: 'CheckoutAttempt', trigger: 'trg_checkout_attempt_commit_check' }),
  Object.freeze({ table: 'CheckoutAttemptDeclaration', trigger: 'trg_checkout_attempt_declaration_guard' }),
  Object.freeze({ table: 'CheckoutAttemptDeclaration', trigger: 'trg_checkout_declaration_commit_check' }),
  Object.freeze({ table: 'ExternalCollection', trigger: 'trg_external_collection_guard' }),
]);

// G11-ADV-004: the reviewed definition of every SQL-only cash CHECK as PostgreSQL
// itself renders it (pg_get_constraintdef, validated, so no NOT VALID suffix).
// The real probe compares the server's rendering against these, whitespace
// normalized: a weakened or rewritten constraint fails the gate. The rendering is
// proven on PostgreSQL 17 by the opt-in PG suite (S9-PG-15 keeps the extension of
// this array honest).
export const CASH_CHECK_DEFINITIONS: readonly CheckDefinitionPin[] = Object.freeze([
  // Every rendering below is PostgreSQL 17's own pg_get_constraintdef output for the
  // constraint of the same name, PROVEN on the disposable LOCAL_TEST cluster through the
  // cut-over lab's S9 PG proof (S9-PG-01/S9-PG-15) — lower-case column names render
  // unquoted, every BoolExpr and its arms render with their own wrapping pair, and the
  // enum literals carry ::text. A validated constraint deparses with no NOT VALID suffix.
  Object.freeze({
    name: 'chk_cash_movement_exit_amount',
    definition: `CHECK ((((type)::text <> ALL (ARRAY['WITHDRAWAL'::text, 'EXPENSE'::text])) OR (amount > 0)))`,
  }),
  Object.freeze({
    name: 'chk_cash_movement_exit_reason',
    definition: `CHECK ((((type)::text <> ALL (ARRAY['WITHDRAWAL'::text, 'EXPENSE'::text])) OR ((reason IS NOT NULL) AND (btrim(reason) <> ''::text))))`,
  }),
  Object.freeze({
    name: 'chk_cash_movement_exit_no_payment',
    definition: `CHECK ((((type)::text <> ALL (ARRAY['WITHDRAWAL'::text, 'EXPENSE'::text])) OR ("salePaymentId" IS NULL)))`,
  }),
  Object.freeze({
    name: 'chk_cash_movement_reversal_link',
    definition: `CHECK ((((type)::text = ANY (ARRAY['WITHDRAWAL_REVERSAL'::text, 'EXPENSE_REVERSAL'::text])) = ("reversesMovementId" IS NOT NULL)))`,
  }),
  Object.freeze({
    name: 'chk_cash_movement_reversal_shape',
    definition: `CHECK ((((type)::text <> ALL (ARRAY['WITHDRAWAL_REVERSAL'::text, 'EXPENSE_REVERSAL'::text])) OR ((amount > 0) AND (reason IS NOT NULL) AND (btrim(reason) <> ''::text) AND ("salePaymentId" IS NULL) AND ("idempotencyKey" IS NOT NULL))))`,
  }),
  Object.freeze({
    name: 'chk_cash_movement_reversal_not_self',
    definition: `CHECK ((("reversesMovementId" IS NULL) OR ("reversesMovementId" <> id)))`,
  }),
]);
export const READINESS_CATALOG_OBJECTS: readonly string[] = Object.freeze([
  ...R3_CATALOG_OBJECTS,
  ...R3_TRIGGER_BINDINGS.map((binding) => binding.trigger),
  ...CASH_CATALOG_OBJECTS,
  ...CREDIT_CATALOG_OBJECTS,
  ...WAREHOUSE_CATALOG_OBJECTS,
  ...QR_CATALOG_OBJECTS,
]);

// Feature dependencies, from the real code: the R3 location selector and external
// methods come from the two environment flags; the cash movement features (exits,
// reversals, movement history — and openSession/closeSession, which read and write the
// m10/m11 CashMovement columns) are compiled into this release unconditionally, so
// cashMovementsEnabled is always true at runtime. It is a field only so the gate's
// no-query path stays provable by injection.
export type R3Features = {
  readonly locationSelectorEnabled: boolean;
  readonly externalMethodsEnabled: boolean;
  readonly cashMovementsEnabled: boolean;
};

export function r3Required(features: R3Features): boolean {
  return features.locationSelectorEnabled || features.externalMethodsEnabled || features.cashMovementsEnabled;
}

// The required migrations: G14 strict (m8, m9, m10, m11, m12, m13, m14) whenever any feature is on;
// nothing (and no query) when every feature is off.
export function requiredR3Migrations(features: R3Features): readonly MigrationPin[] {
  return r3Required(features) ? G14_MIGRATION_PINS : [];
}

// Derives the features from the already-validated environment. The two R3 flags are
// the only inputs; the cash movement features are part of this release.
export function r3FeaturesFromEnv(
  env: Pick<Env, 'PROPORTIONAL_CHECKOUT_LOCATION_IDS' | 'PROPORTIONAL_EXTERNAL_METHODS_ENABLED'>,
): R3Features {
  return {
    locationSelectorEnabled: env.PROPORTIONAL_CHECKOUT_LOCATION_IDS.length > 0,
    externalMethodsEnabled: env.PROPORTIONAL_EXTERNAL_METHODS_ENABLED === true,
    cashMovementsEnabled: true,
  };
}

// One `_prisma_migrations` row, reduced to the four columns the gate needs.
// Prisma keeps one row per apply attempt; the evaluator understands that.
export type R3LedgerRow = {
  migration_name: string;
  checksum: string;
  finished: boolean;
  rolled_back: boolean;
};

export type R3ReadinessSnapshot = {
  ledger: readonly R3LedgerRow[];
  objects: Readonly<Record<string, boolean>>;
};

// The only database access the gate performs: a bounded, read-only snapshot.
// Injected so the DB-free suite can prove the ordering and the fail-closed
// behaviour without a driver.
export interface R3ReadinessClient {
  readSnapshot(): Promise<R3ReadinessSnapshot>;
}

export type R3ReadinessVerdict =
  | { readonly ready: true }
  | { readonly ready: false; readonly reason: R3ReadinessReason; readonly migrations: readonly string[]; readonly objects: readonly string[] };

export class R3ReadinessError extends Error {
  readonly code = R3_DATABASE_NOT_READY;
  readonly reason: R3ReadinessReason;
  readonly migrations: readonly string[];
  readonly objects: readonly string[];
  constructor(reason: R3ReadinessReason, details: { migrations?: readonly string[]; objects?: readonly string[] } = {}) {
    // The message is built from fixed words only: never a driver error, a URL,
    // a credential or row contents.
    super(`R3 database is not ready: ${reason}`);
    this.name = 'R3ReadinessError';
    this.reason = reason;
    this.migrations = details.migrations ?? [];
    this.objects = details.objects ?? [];
  }
}

// Pure. Classifies the required migrations. Precedence is deterministic and
// fail-closed: a missing migration, then any unfinished attempt, then a rolled
// back-only migration, then a checksum drift. An ambiguous state (a row that is
// both finished and rolled back, or more than one clean applied attempt) is
// treated as UNFINISHED so it can never read as READY.
function evaluateMigrations(ledger: readonly R3LedgerRow[], required: readonly MigrationPin[]): R3ReadinessVerdict | null {
  const missing: string[] = [];
  const unfinished: string[] = [];
  const rolledBack: string[] = [];
  const drifted: string[] = [];
  for (const pin of required) {
    const rows = ledger.filter((row) => row.migration_name === pin.name);
    if (rows.length === 0) {
      missing.push(pin.name);
      continue;
    }
    const dirty = rows.some((row) => row.finished === false && row.rolled_back === false);
    const impossible = rows.some((row) => row.finished === true && row.rolled_back === true);
    const applied = rows.filter((row) => row.finished === true && row.rolled_back === false);
    if (dirty || impossible || applied.length > 1) {
      unfinished.push(pin.name);
      continue;
    }
    if (applied.length === 0) {
      rolledBack.push(pin.name);
      continue;
    }
    if (applied[0]!.checksum !== pin.sha256) drifted.push(pin.name);
  }
  if (missing.length > 0) return { ready: false, reason: 'MIGRATION_MISSING', migrations: missing, objects: [] };
  if (unfinished.length > 0) return { ready: false, reason: 'MIGRATION_UNFINISHED', migrations: unfinished, objects: [] };
  if (rolledBack.length > 0) return { ready: false, reason: 'MIGRATION_ROLLED_BACK', migrations: rolledBack, objects: [] };
  if (drifted.length > 0) return { ready: false, reason: 'MIGRATION_CHECKSUM_DRIFT', migrations: drifted, objects: [] };
  return null;
}

// Pure. The whole verdict from a snapshot and the features.
export function evaluateR3Readiness(snapshot: R3ReadinessSnapshot, features: R3Features): R3ReadinessVerdict {
  const required = requiredR3Migrations(features);
  if (required.length === 0) return { ready: true };
  const ledgerVerdict = evaluateMigrations(snapshot.ledger, required);
  if (ledgerVerdict) return ledgerVerdict;
  const absent = READINESS_CATALOG_OBJECTS.filter((name) => snapshot.objects[name] !== true);
  if (absent.length > 0) return { ready: false, reason: 'SCHEMA_OBJECT_MISSING', migrations: [], objects: absent };
  return { ready: true };
}

export type R3ReadinessLogger = { error: (entry: Record<string, unknown>) => void };

// The imperative gate. No-op when no R3 feature is on (zero queries). Any read
// failure (unreachable database, timeout, permission) fails closed as
// DATABASE_UNREACHABLE, and the driver error is never inspected or re-exposed.
export async function assertR3Ready(client: R3ReadinessClient, features: R3Features): Promise<void> {
  if (requiredR3Migrations(features).length === 0) return;
  let snapshot: R3ReadinessSnapshot;
  try {
    snapshot = await client.readSnapshot();
  } catch {
    throw new R3ReadinessError('DATABASE_UNREACHABLE');
  }
  const verdict = evaluateR3Readiness(snapshot, features);
  if (!verdict.ready) {
    throw new R3ReadinessError(verdict.reason, { migrations: verdict.migrations, objects: verdict.objects });
  }
}

type LedgerRowResult = { migration_name: string; checksum: string; finished: boolean; rolled_back: boolean };

// The reviewed rendering of one SQL-only cash CHECK, whitespace normalized exactly
// like the server-side comparison; a name without a reviewed definition is a
// programming error here, never a probe.
function checkDef(name: string): string {
  const pin = CASH_CHECK_DEFINITIONS.find((entry) => entry.name === name);
  if (!pin) throw new Error(`no reviewed CHECK definition for ${name}`);
  return pin.definition.replace(/\s+/g, ' ').trim();
}

// The real client. Two bounded, read-only statements; no row contents beyond the
// four ledger columns and the boolean existence/definition probes are ever
// selected. G11-ADV-004: the six cash CHECK constraints are validated AND their
// PostgreSQL rendering equals the reviewed definition (whitespace normalized), the
// six m9 triggers are bound to their exact tables via pg_trigger, and the
// m10/m11 unique indexes plus the composite FK's column pairs and RESTRICT/RESTRICT
// SIMPLE actions are all probed, not assumed.
export function createPrismaR3ReadinessClient(database: Pick<PrismaClient, '$queryRaw'>): R3ReadinessClient {
  const names = [...G14_MIGRATION_PINS.map((pin) => pin.name)];
  return {
    async readSnapshot(): Promise<R3ReadinessSnapshot> {
      const ledger = await database.$queryRaw<LedgerRowResult[]>`
        SELECT "migration_name", "checksum", ("finished_at" IS NOT NULL) AS "finished", ("rolled_back_at" IS NOT NULL) AS "rolled_back"
        FROM "_prisma_migrations"
        WHERE "migration_name" = ANY(${names}::text[])`;
      const probe = await database.$queryRaw<Array<Record<string, boolean>>>`
        SELECT
          to_regclass('public."SaleCheckout"') IS NOT NULL AS "SaleCheckout",
          to_regclass('public."ExternalCollection"') IS NOT NULL AS "ExternalCollection",
          to_regclass('public."SaleLineAllocation"') IS NOT NULL AS "SaleLineAllocation",
          to_regclass('public."CheckoutAttempt"') IS NOT NULL AS "CheckoutAttempt",
          to_regclass('public."CheckoutAttemptTender"') IS NOT NULL AS "CheckoutAttemptTender",
          to_regclass('public."CheckoutAttemptDeclaration"') IS NOT NULL AS "CheckoutAttemptDeclaration",
          EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid = to_regclass('public."SaleCheckout"') AND a.attname = 'fullPriceCredit' AND NOT a.attisdropped) AS "SaleCheckout.fullPriceCredit",
          EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid = to_regclass('public."SaleCheckout"') AND a.attname = 'creditAdjustmentBps' AND NOT a.attisdropped) AS "SaleCheckout.creditAdjustmentBps",
          EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid = to_regclass('public."CheckoutAttempt"') AND a.attname = 'fullPriceCredit' AND NOT a.attisdropped) AS "CheckoutAttempt.fullPriceCredit",
          EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid = to_regclass('public."CheckoutAttempt"') AND a.attname = 'creditAdjustmentBps' AND NOT a.attisdropped) AS "CheckoutAttempt.creditAdjustmentBps",
          EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c WHERE c.conrelid = to_regclass('public."SaleCheckout"') AND c.conname = 'chk_checkout_credit_snapshot' AND c.contype = 'c' AND c.convalidated) AS "chk_checkout_credit_snapshot",
          EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c WHERE c.conrelid = to_regclass('public."CheckoutAttempt"') AND c.conname = 'chk_attempt_credit_snapshot' AND c.contype = 'c' AND c.convalidated) AS "chk_attempt_credit_snapshot",
          to_regclass('public."ExternalCollection_credit_ref_key"') IS NOT NULL AS "ExternalCollection_credit_ref_key",
          EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid = to_regclass('public."SaleCheckout"') AND a.attname = 'fullPriceQr' AND NOT a.attisdropped) AS "SaleCheckout.fullPriceQr",
          EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid = to_regclass('public."SaleCheckout"') AND a.attname = 'qrAdjustmentBps' AND NOT a.attisdropped) AS "SaleCheckout.qrAdjustmentBps",
          EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid = to_regclass('public."CheckoutAttempt"') AND a.attname = 'fullPriceQr' AND NOT a.attisdropped) AS "CheckoutAttempt.fullPriceQr",
          EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid = to_regclass('public."CheckoutAttempt"') AND a.attname = 'qrAdjustmentBps' AND NOT a.attisdropped) AS "CheckoutAttempt.qrAdjustmentBps",
          EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c WHERE c.conrelid = to_regclass('public."SaleCheckout"') AND c.conname = 'chk_checkout_qr_snapshot' AND c.contype = 'c' AND c.convalidated) AS "chk_checkout_qr_snapshot",
          EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c WHERE c.conrelid = to_regclass('public."CheckoutAttempt"') AND c.conname = 'chk_attempt_qr_snapshot' AND c.contype = 'c' AND c.convalidated) AS "chk_attempt_qr_snapshot",
          to_regclass('public."ExternalCollection_qr_ref_key"') IS NOT NULL AS "ExternalCollection_qr_ref_key",
          EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid = to_regclass('public."StockMovement"') AND a.attname = 'reason' AND NOT a.attisdropped) AS "StockMovement.reason",
          EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid = to_regclass('public."StockMovement"') AND a.attname = 'note' AND NOT a.attisdropped) AS "StockMovement.note",
          EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid = to_regclass('public."StockMovement"') AND a.attname = 'idempotencyKey' AND NOT a.attisdropped) AS "StockMovement.idempotencyKey",
          EXISTS (SELECT 1 FROM pg_catalog.pg_enum e WHERE e.enumtypid = to_regtype('public."StockMovementType"') AND e.enumlabel = 'ADJUSTMENT') AS "StockMovementType.ADJUSTMENT",
          EXISTS (SELECT 1 FROM pg_catalog.pg_enum e WHERE e.enumtypid = to_regtype('public."StockAdjustmentReason"') AND e.enumlabel = 'DAMAGED') AS "StockAdjustmentReason.DAMAGED",
          EXISTS (SELECT 1 FROM pg_catalog.pg_enum e WHERE e.enumtypid = to_regtype('public."StockAdjustmentReason"') AND e.enumlabel = 'LOST') AS "StockAdjustmentReason.LOST",
          EXISTS (SELECT 1 FROM pg_catalog.pg_enum e WHERE e.enumtypid = to_regtype('public."StockAdjustmentReason"') AND e.enumlabel = 'LOAD_ERROR') AS "StockAdjustmentReason.LOAD_ERROR",
          EXISTS (SELECT 1 FROM pg_catalog.pg_enum e WHERE e.enumtypid = to_regtype('public."StockAdjustmentReason"') AND e.enumlabel = 'SURPLUS') AS "StockAdjustmentReason.SURPLUS",
          EXISTS (SELECT 1 FROM pg_catalog.pg_enum e WHERE e.enumtypid = to_regtype('public."StockAdjustmentReason"') AND e.enumlabel = 'OTHER') AS "StockAdjustmentReason.OTHER",
          to_regclass('public."StockMovement_userId_idempotencyKey_key"') IS NOT NULL AS "StockMovement_userId_idempotencyKey_key",
          EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c WHERE c.conrelid = to_regclass('public."StockMovement"') AND c.conname = 'chk_stock_movement_adjustment_shape' AND c.contype = 'c' AND c.convalidated) AS "chk_stock_movement_adjustment_shape",
          EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c WHERE c.conrelid = to_regclass('public."StockMovement"') AND c.conname = 'chk_stock_movement_adjustment_reason_rules' AND c.contype = 'c' AND c.convalidated) AS "chk_stock_movement_adjustment_reason_rules",
          EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c WHERE c.conrelid = to_regclass('public."StockMovement"') AND c.conname = 'chk_stock_movement_reason_only_adjustment' AND c.contype = 'c' AND c.convalidated) AS "chk_stock_movement_reason_only_adjustment",
          to_regprocedure('public."fn_checkout_attempt_guard"()') IS NOT NULL AS "fn_checkout_attempt_guard",
          to_regprocedure('public."fn_checkout_attempt_tender_guard"()') IS NOT NULL AS "fn_checkout_attempt_tender_guard",
          to_regprocedure('public."fn_checkout_attempt_commit_check"()') IS NOT NULL AS "fn_checkout_attempt_commit_check",
          to_regprocedure('public."fn_checkout_attempt_declaration_guard"()') IS NOT NULL AS "fn_checkout_attempt_declaration_guard",
          to_regprocedure('public."fn_checkout_declaration_commit_check"()') IS NOT NULL AS "fn_checkout_declaration_commit_check",
          to_regprocedure('public."fn_external_collection_guard"()') IS NOT NULL AS "fn_external_collection_guard",
          EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid = to_regclass('public."CheckoutAttempt"') AND t.tgname = 'trg_checkout_attempt_guard' AND NOT t.tgisinternal) AS "trg_checkout_attempt_guard",
          EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid = to_regclass('public."CheckoutAttemptTender"') AND t.tgname = 'trg_checkout_attempt_tender_guard' AND NOT t.tgisinternal) AS "trg_checkout_attempt_tender_guard",
          EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid = to_regclass('public."CheckoutAttempt"') AND t.tgname = 'trg_checkout_attempt_commit_check' AND NOT t.tgisinternal) AS "trg_checkout_attempt_commit_check",
          EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid = to_regclass('public."CheckoutAttemptDeclaration"') AND t.tgname = 'trg_checkout_attempt_declaration_guard' AND NOT t.tgisinternal) AS "trg_checkout_attempt_declaration_guard",
          EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid = to_regclass('public."CheckoutAttemptDeclaration"') AND t.tgname = 'trg_checkout_declaration_commit_check' AND NOT t.tgisinternal) AS "trg_checkout_declaration_commit_check",
          EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid = to_regclass('public."ExternalCollection"') AND t.tgname = 'trg_external_collection_guard' AND NOT t.tgisinternal) AS "trg_external_collection_guard",
          EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid = to_regclass('public."CashMovement"') AND a.attname = 'reason' AND NOT a.attisdropped) AS "CashMovement.reason",
          EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid = to_regclass('public."CashMovement"') AND a.attname = 'idempotencyKey' AND NOT a.attisdropped) AS "CashMovement.idempotencyKey",
          EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid = to_regclass('public."CashMovement"') AND a.attname = 'reversesMovementId' AND NOT a.attisdropped) AS "CashMovement.reversesMovementId",
          EXISTS (SELECT 1 FROM pg_catalog.pg_enum e WHERE e.enumtypid = to_regtype('public."CashMovementType"') AND e.enumlabel = 'WITHDRAWAL') AS "CashMovementType.WITHDRAWAL",
          EXISTS (SELECT 1 FROM pg_catalog.pg_enum e WHERE e.enumtypid = to_regtype('public."CashMovementType"') AND e.enumlabel = 'EXPENSE') AS "CashMovementType.EXPENSE",
          EXISTS (SELECT 1 FROM pg_catalog.pg_enum e WHERE e.enumtypid = to_regtype('public."CashMovementType"') AND e.enumlabel = 'WITHDRAWAL_REVERSAL') AS "CashMovementType.WITHDRAWAL_REVERSAL",
          EXISTS (SELECT 1 FROM pg_catalog.pg_enum e WHERE e.enumtypid = to_regtype('public."CashMovementType"') AND e.enumlabel = 'EXPENSE_REVERSAL') AS "CashMovementType.EXPENSE_REVERSAL",
          to_regclass('public."CashMovement_reversesMovementId_key"') IS NOT NULL AS "CashMovement_reversesMovementId_key",
          to_regclass('public."CashMovement_sessionId_idempotencyKey_key"') IS NOT NULL AS "CashMovement_sessionId_idempotencyKey_key",
          to_regclass('public."CashMovement_id_sessionId_key"') IS NOT NULL AS "CashMovement_id_sessionId_key",
          EXISTS (
            SELECT 1 FROM pg_catalog.pg_constraint c
            WHERE c.conrelid = to_regclass('public."CashMovement"') AND c.conname = 'CashMovement_reversesMovementId_sessionId_fkey'
              AND c.contype = 'f' AND c.convalidated
              AND c.confrelid = to_regclass('public."CashMovement"')
              AND c.conkey = ARRAY[
                (SELECT a.attnum FROM pg_catalog.pg_attribute a WHERE a.attrelid = c.conrelid AND a.attname = 'reversesMovementId' AND NOT a.attisdropped),
                (SELECT a.attnum FROM pg_catalog.pg_attribute a WHERE a.attrelid = c.conrelid AND a.attname = 'sessionId' AND NOT a.attisdropped)]::smallint[]
              AND c.confkey = ARRAY[
                (SELECT a.attnum FROM pg_catalog.pg_attribute a WHERE a.attrelid = c.confrelid AND a.attname = 'id' AND NOT a.attisdropped),
                (SELECT a.attnum FROM pg_catalog.pg_attribute a WHERE a.attrelid = c.confrelid AND a.attname = 'sessionId' AND NOT a.attisdropped)]::smallint[]
              AND c.confdeltype = 'r' AND c.confupdtype = 'r' AND c.confmatchtype = 's'
          ) AS "CashMovement_reversesMovementId_sessionId_fkey",
          (SELECT btrim(regexp_replace(pg_catalog.pg_get_constraintdef(c.oid), '\\s+', ' ', 'g')) FROM pg_catalog.pg_constraint c WHERE c.conrelid = to_regclass('public."CashMovement"') AND c.conname = 'chk_cash_movement_exit_amount' AND c.contype = 'c' AND c.convalidated) = ${checkDef('chk_cash_movement_exit_amount')} AS "chk_cash_movement_exit_amount",
          (SELECT btrim(regexp_replace(pg_catalog.pg_get_constraintdef(c.oid), '\\s+', ' ', 'g')) FROM pg_catalog.pg_constraint c WHERE c.conrelid = to_regclass('public."CashMovement"') AND c.conname = 'chk_cash_movement_exit_reason' AND c.contype = 'c' AND c.convalidated) = ${checkDef('chk_cash_movement_exit_reason')} AS "chk_cash_movement_exit_reason",
          (SELECT btrim(regexp_replace(pg_catalog.pg_get_constraintdef(c.oid), '\\s+', ' ', 'g')) FROM pg_catalog.pg_constraint c WHERE c.conrelid = to_regclass('public."CashMovement"') AND c.conname = 'chk_cash_movement_exit_no_payment' AND c.contype = 'c' AND c.convalidated) = ${checkDef('chk_cash_movement_exit_no_payment')} AS "chk_cash_movement_exit_no_payment",
          (SELECT btrim(regexp_replace(pg_catalog.pg_get_constraintdef(c.oid), '\\s+', ' ', 'g')) FROM pg_catalog.pg_constraint c WHERE c.conrelid = to_regclass('public."CashMovement"') AND c.conname = 'chk_cash_movement_reversal_link' AND c.contype = 'c' AND c.convalidated) = ${checkDef('chk_cash_movement_reversal_link')} AS "chk_cash_movement_reversal_link",
          (SELECT btrim(regexp_replace(pg_catalog.pg_get_constraintdef(c.oid), '\\s+', ' ', 'g')) FROM pg_catalog.pg_constraint c WHERE c.conrelid = to_regclass('public."CashMovement"') AND c.conname = 'chk_cash_movement_reversal_shape' AND c.contype = 'c' AND c.convalidated) = ${checkDef('chk_cash_movement_reversal_shape')} AS "chk_cash_movement_reversal_shape",
          (SELECT btrim(regexp_replace(pg_catalog.pg_get_constraintdef(c.oid), '\\s+', ' ', 'g')) FROM pg_catalog.pg_constraint c WHERE c.conrelid = to_regclass('public."CashMovement"') AND c.conname = 'chk_cash_movement_reversal_not_self' AND c.contype = 'c' AND c.convalidated) = ${checkDef('chk_cash_movement_reversal_not_self')} AS "chk_cash_movement_reversal_not_self"`;
      return {
        ledger: ledger.map((row) => ({
          migration_name: row.migration_name,
          checksum: row.checksum,
          finished: row.finished === true,
          rolled_back: row.rolled_back === true,
        })),
        objects: probe[0] ?? {},
      };
    },
  };
}
