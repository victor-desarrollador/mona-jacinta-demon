// Zero-database unit tests for scripts/database/pilot-schema-references.mjs: the reviewed
// semantic probes per authorizable state and the mechanically generated app-schema
// reference digests (produced by pilot-schema-reference.mjs on disposable PostgreSQL 17
// clusters built with exactly the pinned migrations).
// Run with: node --test scripts/database/pilot-schema-references.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { STATES } from './pilot-migration-states.mjs';
import * as R from './pilot-schema-references.mjs';

const MIG = fileURLToPath(new URL('../../api/prisma/migrations/', import.meta.url));
const sqlOf = (names) => names.map((n) => readFileSync(path.join(MIG, n, 'migration.sql'), 'utf8')).join('\n');
const ALL = Object.keys(STATES);
const quoted = (name) => new RegExp(`"${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`);

test('SR-01 probes exist for exactly the four states and use only known kinds', () => {
  assert.deepEqual(Object.keys(R.STATE_PROBES), ALL);
  const kinds = new Set(['table', 'absentTable', 'column', 'absentColumn', 'enumLabels', 'absentEnumLabels', 'constraint', 'absentConstraint',
    'index', 'absentIndex', 'function', 'absentFunction', 'trigger', 'absentTrigger']);
  for (const state of ALL) {
    assert.ok(R.STATE_PROBES[state].length > 10, state);
    for (const p of R.STATE_PROBES[state]) assert.ok(kinds.has(p.kind), `${state} ${p.kind}`);
  }
});

test('SR-02 every positive probe names an object created by a migration of that state', () => {
  for (const state of ALL) {
    const sql = sqlOf(STATES[state]);
    for (const p of R.STATE_PROBES[state].filter((x) => !x.kind.startsWith('absent'))) {
      assert.match(sql, quoted(p.name), `${state} ${p.kind} ${p.name}`);
      if (p.table) assert.match(sql, quoted(p.table), `${state} ${p.kind} table ${p.table}`);
      for (const label of p.labels ?? []) assert.match(sql, new RegExp(`'${label}'`), `${state} label ${label}`);
    }
  }
});

test('SR-03 every negative probe names an object that only a LATER migration creates', () => {
  for (const state of ALL) {
    const own = sqlOf(STATES[state]);
    const later = sqlOf(STATES.EXACT_G14.slice(STATES[state].length));
    for (const p of R.STATE_PROBES[state].filter((x) => x.kind.startsWith('absent'))) {
      if (p.labels) {
        for (const label of p.labels) { assert.doesNotMatch(own, new RegExp(`ADD VALUE '${label}'`), `${state} ${label}`); assert.match(later, new RegExp(`'${label}'`)); }
        continue;
      }
      assert.match(later, quoted(p.name), `${state} ${p.kind} ${p.name} must be created later`);
      assert.doesNotMatch(own.replace(/--.*$/gm, ''), new RegExp(`(CREATE (UNIQUE )?(TABLE|INDEX|FUNCTION|TRIGGER|CONSTRAINT TRIGGER)|ADD (COLUMN|CONSTRAINT)) (public\\.)?"${p.name}"`), `${state} ${p.name} must not be created by this state`);
    }
  }
  assert.equal(R.STATE_PROBES.EXACT_G14.filter((p) => p.kind.startsWith('absent')).length, 0, 'G14 is final: nothing later to be absent');
});

test('SR-04 G11 probes cover the cut-over critical objects named by the OWNER', () => {
  const ids = new Set(R.STATE_PROBES.EXACT_G11.map((p) => `${p.kind}:${p.table ? `${p.table}.` : ''}${p.name}`));
  for (const t of ['SaleCheckout', 'SaleLineAllocation', 'ExternalCollection', 'CheckoutAttempt', 'CheckoutAttemptTender', 'CheckoutAttemptDeclaration']) assert.ok(ids.has(`table:${t}`), t);
  for (const c of ['Sale.pricingModel', 'CashMovement.reason', 'CashMovement.idempotencyKey', 'CashMovement.reversesMovementId']) assert.ok(ids.has(`column:${c}`), c);
  for (const f of ['fn_checkout_attempt_guard', 'fn_checkout_attempt_tender_guard', 'fn_checkout_attempt_commit_check', 'fn_checkout_attempt_declaration_guard',
    'fn_checkout_declaration_commit_check', 'fn_external_collection_guard']) assert.ok(ids.has(`function:${f}`), f);
  for (const t of ['CheckoutAttempt.trg_checkout_attempt_guard', 'CheckoutAttemptTender.trg_checkout_attempt_tender_guard', 'CheckoutAttempt.trg_checkout_attempt_commit_check',
    'CheckoutAttemptDeclaration.trg_checkout_attempt_declaration_guard', 'CheckoutAttemptDeclaration.trg_checkout_declaration_commit_check',
    'ExternalCollection.trg_external_collection_guard']) assert.ok(ids.has(`trigger:${t}`), t);
  for (const i of ['CashMovement.CashMovement_reversesMovementId_key', 'CashMovement.CashMovement_id_sessionId_key', 'CashMovement.CashMovement_sessionId_idempotencyKey_key']) assert.ok(ids.has(`index:${i}`), i);
  for (const c of ['CashMovement.CashMovement_reversesMovementId_sessionId_fkey', 'CashMovement.chk_cash_movement_reversal_link',
    'CashMovement.chk_cash_movement_reversal_shape', 'CashMovement.chk_cash_movement_reversal_not_self']) assert.ok(ids.has(`constraint:${c}`), c);
  const labels = R.STATE_PROBES.EXACT_G11.find((p) => p.kind === 'enumLabels' && p.name === 'CashMovementType');
  assert.deepEqual(labels.labels, ['WITHDRAWAL', 'EXPENSE', 'WITHDRAWAL_REVERSAL', 'EXPENSE_REVERSAL']);
});

test('SR-05 the generated references are complete, well-formed and pairwise distinct', () => {
  assert.deepEqual(Object.keys(R.SCHEMA_REFERENCES), ALL);
  for (const state of ALL) {
    const ref = R.SCHEMA_REFERENCES[state];
    assert.match(ref.digest, /^[0-9a-f]{64}$/, state);
    for (const k of ['tables', 'columns', 'enums', 'types', 'constraints', 'indexes', 'functions', 'triggers']) assert.ok(Number.isSafeInteger(ref.summary[k]), `${state} ${k}`);
  }
  assert.equal(new Set(ALL.map((s) => R.SCHEMA_REFERENCES[s].digest)).size, 6);
  assert.equal(R.SCHEMA_REFERENCES.EXACT_S4.summary.functions, 0);
  assert.equal(R.SCHEMA_REFERENCES.EXACT_G7.summary.functions, 3);
  assert.equal(R.SCHEMA_REFERENCES.EXACT_G11.summary.functions, 9);
  assert.equal(R.SCHEMA_REFERENCES.EXACT_G11.summary.triggers, 10);
  assert.equal(R.SCHEMA_REFERENCES.EXACT_G12.summary.columns, 297);
  assert.equal(R.SCHEMA_REFERENCES.EXACT_G12.summary.constraints, 146);
  assert.equal(R.SCHEMA_REFERENCES.EXACT_G12.summary.indexes, 128);
  assert.equal(R.SCHEMA_REFERENCES.EXACT_G12.summary.functions, 9);
  assert.equal(R.SCHEMA_REFERENCES.EXACT_G12.summary.triggers, 10);
  // m13 (warehouse stock adjustment): +3 StockMovement columns, +1 enum, +3 constraints, +1 index; no new relation, function or trigger.
  assert.equal(R.SCHEMA_REFERENCES.EXACT_G13.summary.tables, 31);
  assert.equal(R.SCHEMA_REFERENCES.EXACT_G13.summary.columns, 300);
  assert.equal(R.SCHEMA_REFERENCES.EXACT_G13.summary.enums, 18);
  assert.equal(R.SCHEMA_REFERENCES.EXACT_G13.summary.constraints, 149);
  assert.equal(R.SCHEMA_REFERENCES.EXACT_G13.summary.indexes, 129);
  assert.equal(R.SCHEMA_REFERENCES.EXACT_G13.summary.functions, 9);
  assert.equal(R.SCHEMA_REFERENCES.EXACT_G13.summary.triggers, 10);
  // m14 (QR snapshot): +4 columns (2 on SaleCheckout, 2 on CheckoutAttempt), +2 CHECKs, +1 partial unique index; no new relation, enum, function or trigger.
  assert.equal(R.SCHEMA_REFERENCES.EXACT_G14.summary.tables, 31);
  assert.equal(R.SCHEMA_REFERENCES.EXACT_G14.summary.columns, 304);
  assert.equal(R.SCHEMA_REFERENCES.EXACT_G14.summary.enums, 18);
  assert.equal(R.SCHEMA_REFERENCES.EXACT_G14.summary.constraints, 151);
  assert.equal(R.SCHEMA_REFERENCES.EXACT_G14.summary.indexes, 130);
  assert.equal(R.SCHEMA_REFERENCES.EXACT_G14.summary.functions, 9);
  assert.equal(R.SCHEMA_REFERENCES.EXACT_G14.summary.triggers, 10);
});
