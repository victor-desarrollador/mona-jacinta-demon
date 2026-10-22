// Zero-database unit tests for scripts/database/pilot-migration-states.mjs: the single
// source of the fourteen reviewed migration pins, the six authorizable exact states
// (EXACT_S4, EXACT_G7, EXACT_G11, EXACT_G12, EXACT_G13, EXACT_G14) and the strict ledger classifier shared by every PILOT
// tool. Run with: node --test scripts/database/pilot-migration-states.test.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as states from './pilot-migration-states.mjs';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../api/prisma/migrations/', import.meta.url));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const SOURCE = readFileSync(new URL('./pilot-migration-states.mjs', import.meta.url), 'utf8');

const EXPECTED = [
  ['20260907015311_init', 17328, 'a584edab13a2ae540d694578ffa3b5a622decff04e238a5cf16d3040d295e4cb'],
  ['20260912182432_add_company_location', 1343, '19c345aa92c79a0a613dc03ea01dcf10e91b5a75fd6f3535076d8d71b6f740af'],
  ['20260912191702_add_user_role_scope', 2356, '2b415411eddc1212bf60419ce49022cea38d1fc2d12cb08938ad7c953caf7f3a'],
  ['20260922210000_d3_initial_stock_and_global_audit', 482, '62b3b169e06a48dc2e2a3f81cee11e02a809b2733db2453c5b9eef91c15f77cf'],
  ['20261002120000_block1_pricing_wholesale', 10096, '45cf8d080e8fa4ec0a8dab9c9e5d4b780eb1642f0a8992d43b57dff655250173'],
  ['20261006120000_pilot_pricing_v2', 3282, 'd948f74e9c0eed3ce959f5c0e6edea70871d7d5957275f3304922e31bab6df12'],
  ['20261012120000_cash_session_reconciliation', 390, 'd98b7ce082bff6810312866c81c26203146dff03c7a12e5f3bd6a595893fc47f'],
  ['20261016120000_r3_proportional_checkout', 15340, '217e87eb5b156a57a5edcfd73433e1e9558ce59caa019208d9df8c0268f08dc6'],
  ['20261016130000_r3_checkout_attempts', 35290, '076884120da38a05099ee00dbb16aafaa9e8c78f5846889fe7f590a8e95d9148'],
  ['20261018120000_cash_movement_withdrawals_expenses', 2732, 'e37149442d1fb82ec87877e7b3e1f2e4311b36a9d47d314a3fd1843702c5adf9'],
  ['20261018180000_cash_movement_reversals', 3366, 'd638559da376f5c4fb1f71136027c0af426906b8b8a2c582f388e73ffd1b3770'],
  ['20261021120000_r3_card_credit', 11413, 'ccec6685120cc9236c5c95a57f2922dc5bbe09cf759ff21b4c9a3635d893f6be'],
  ['20261021130000_warehouse_stock_adjustment', 3457, '819d669933639173e1b21879791c14eb3cced33c0d8417ca30dd07800fb252c0'],
  ['20261021140000_r3_qr', 13048, '32ad30fc0b0aa847d1393ba1fb77419a286470e616973c6bd48de97e6192104a'],
];
const NAMES = EXPECTED.map(([name]) => name);
const okRow = (i, patch = {}) => ({ migration_name: EXPECTED[i][0], checksum: EXPECTED[i][2], finished: true, rolled_back: false, ...patch });
const rowsFor = (n) => Array.from({ length: n }, (_, i) => okRow(i));
const classify = (rows) => states.classifyLedger(rows);

test('ST-01 the fourteen pins are the exact reviewed metadata, literal, frozen and in Prisma order', () => {
  assert.ok(Object.isFrozen(states.MIGRATION_PINS));
  assert.deepEqual(states.MIGRATION_PINS.map((m) => [m.name, m.bytes, m.sha256]), EXPECTED);
  for (const pin of states.MIGRATION_PINS) assert.ok(Object.isFrozen(pin));
  assert.deepEqual([...NAMES].sort(), NAMES);
  // Literals, never derived from disk.
  assert.doesNotMatch(SOURCE, /readdir|readFile|createHash|process\.env|import\(/);
  assert.deepEqual(states.LOCK_PIN, { bytes: 128, sha256: '99836963713b4f5b269ad49af0ed3d7b0b2e336115c2f92dc9ac683d139d0900', provider: 'postgresql' });
});

test('ST-02 the pins equal the bytes on disk, file by file (recomputed, never trusted)', () => {
  const onDisk = readdirSync(MIGRATIONS_DIR).filter((d) => /^\d{14}_/.test(d)).sort();
  assert.deepEqual(onDisk, NAMES);
  for (const [name, bytes, digest] of EXPECTED) {
    const file = readFileSync(path.join(MIGRATIONS_DIR, name, 'migration.sql'));
    assert.equal(file.length, bytes, name);
    assert.equal(sha(file), digest, name);
  }
  assert.equal(sha(readFileSync(path.join(MIGRATIONS_DIR, 'migration_lock.toml'))), states.LOCK_PIN.sha256);
});

test('ST-03 the six authorizable states are exact prefixes: S4 = 1–4, G7 = 1–7, G11 = 1–11, G12 = 1–12 and G13 = 1–13 (historical), G14 = 1–14 (final)', () => {
  assert.deepEqual(Object.keys(states.STATES), ['EXACT_S4', 'EXACT_G7', 'EXACT_G11', 'EXACT_G12', 'EXACT_G13', 'EXACT_G14']);
  assert.deepEqual(states.STATES.EXACT_S4, NAMES.slice(0, 4));
  assert.deepEqual(states.STATES.EXACT_G7, NAMES.slice(0, 7));
  assert.deepEqual(states.STATES.EXACT_G11, NAMES.slice(0, 11));
  assert.deepEqual(states.STATES.EXACT_G12, NAMES.slice(0, 12));
  assert.deepEqual(states.STATES.EXACT_G13, NAMES.slice(0, 13));
  assert.deepEqual(states.STATES.EXACT_G14, NAMES);
  assert.deepEqual(states.INITIAL_STATES, ['EXACT_S4', 'EXACT_G7']);
  assert.equal(states.FINAL_STATE, 'EXACT_G14');
  assert.ok(Object.isFrozen(states.STATES) && Object.isFrozen(states.STATES.EXACT_G14));
});

test('ST-04 pendingFor names exactly the migrations an initial state still needs, in order', () => {
  assert.deepEqual(states.pendingFor('EXACT_S4'), NAMES.slice(4));
  assert.deepEqual(states.pendingFor('EXACT_G7'), NAMES.slice(7));
  for (const bad of ['EXACT_G11', 'S4', 'G7', '', null, undefined, 'EXACT_G9']) assert.throws(() => states.pendingFor(bad), /initial state/);
});

test('ST-05 exact S4, G7, G11, G12, G13 and G14 classify as such, in any row order', () => {
  assert.deepEqual(classify(rowsFor(4)), { ok: true, state: 'EXACT_S4' });
  assert.deepEqual(classify(rowsFor(7)), { ok: true, state: 'EXACT_G7' });
  assert.deepEqual(classify(rowsFor(11)), { ok: true, state: 'EXACT_G11' });
  assert.deepEqual(classify(rowsFor(12)), { ok: true, state: 'EXACT_G12' });
  assert.deepEqual(classify(rowsFor(13)), { ok: true, state: 'EXACT_G13' });
  assert.deepEqual(classify(rowsFor(14)), { ok: true, state: 'EXACT_G14' });
  assert.deepEqual(classify(rowsFor(11).reverse()), { ok: true, state: 'EXACT_G11' });
  assert.deepEqual(classify(rowsFor(12).reverse()), { ok: true, state: 'EXACT_G12' });
  assert.deepEqual(classify(rowsFor(13).reverse()), { ok: true, state: 'EXACT_G13' });
  assert.deepEqual(classify(rowsFor(14).reverse()), { ok: true, state: 'EXACT_G14' });
});

test('ST-06 every other prefix (empty, G1–G3, G5, G6, G8, G9, G10) is not an authorizable state', () => {
  for (const n of [0, 1, 2, 3, 5, 6, 8, 9, 10]) {
    const r = classify(rowsFor(n));
    assert.equal(r.ok, false, `G${n}`);
    assert.equal(r.state, null);
    assert.match(r.reason, /not an exact S4, G7, G11, G12, G13 or G14 ledger/);
  }
});

test('ST-07 a gap or a mixed set (e.g. 1–4 + 8) is refused even though every row is valid', () => {
  for (const idx of [[0, 1, 2, 3, 7], [0, 1, 2, 4, 5, 6, 7], [1, 2, 3, 4], [0, 1, 2, 3, 4, 5, 6, 10]]) {
    assert.equal(classify(idx.map((i) => okRow(i))).ok, false, JSON.stringify(idx));
  }
});

test('ST-08 dirty rows are refused: unfinished, rolled back, checksum drift, duplicate, unknown, malformed', () => {
  const cases = {
    unfinished: [...rowsFor(6), okRow(6, { finished: false })],
    'rolled back (even with a later clean retry)': [...rowsFor(7), okRow(6, { rolled_back: true })],
    'checksum drift': [...rowsFor(6), okRow(6, { checksum: '0'.repeat(64) })],
    'duplicate clean row': [...rowsFor(7), okRow(3)],
    'unknown migration': [...rowsFor(7), { migration_name: '20261019000000_extra', checksum: 'a'.repeat(64), finished: true, rolled_back: false }],
    'name not a string': [...rowsFor(3), { ...okRow(3), migration_name: 42 }],
    'finished not boolean': [...rowsFor(3), { ...okRow(3), finished: 'true' }],
    'rolled_back missing': [...rowsFor(3), (({ rolled_back, ...rest }) => rest)(okRow(3))],
    'not an array': 'rows',
    'null row': [...rowsFor(3), null],
  };
  for (const [label, rows] of Object.entries(cases)) {
    const r = classify(rows);
    assert.equal(r.ok, false, label);
    assert.equal(r.state, null, label);
    assert.equal(typeof r.reason, 'string', label);
  }
});

test('ST-09 requireState accepts only the one explicitly expected state (never another valid one)', () => {
  assert.deepEqual(states.requireState(rowsFor(4), 'EXACT_S4'), { ok: true, state: 'EXACT_S4' });
  assert.deepEqual(states.requireState(rowsFor(12), 'EXACT_G12'), { ok: true, state: 'EXACT_G12' });
  assert.deepEqual(states.requireState(rowsFor(13), 'EXACT_G13'), { ok: true, state: 'EXACT_G13' });
  assert.deepEqual(states.requireState(rowsFor(14), 'EXACT_G14'), { ok: true, state: 'EXACT_G14' });
  const g14AsG13 = states.requireState(rowsFor(14), 'EXACT_G13');
  assert.equal(g14AsG13.ok, false);
  assert.match(g14AsG13.reason, /ledger is EXACT_G14, expected EXACT_G13/);
  const g13AsG12 = states.requireState(rowsFor(13), 'EXACT_G12');
  assert.equal(g13AsG12.ok, false);
  assert.match(g13AsG12.reason, /ledger is EXACT_G13, expected EXACT_G12/);
  const g12AsG11 = states.requireState(rowsFor(12), 'EXACT_G11');
  assert.equal(g12AsG11.ok, false);
  assert.match(g12AsG11.reason, /ledger is EXACT_G12, expected EXACT_G11/);
  const g11AsG14 = states.requireState(rowsFor(11), 'EXACT_G14');
  assert.equal(g11AsG14.ok, false);
  assert.match(g11AsG14.reason, /ledger is EXACT_G11, expected EXACT_G14/);
  const g7AsS4 = states.requireState(rowsFor(7), 'EXACT_S4');
  assert.equal(g7AsS4.ok, false);
  assert.match(g7AsS4.reason, /ledger is EXACT_G7, expected EXACT_S4/);
  assert.equal(states.requireState(rowsFor(4), 'EXACT_G7').ok, false);
  assert.equal(states.requireState(rowsFor(11), 'EXACT_G7').ok, false);
  assert.equal(states.requireState(rowsFor(9), 'EXACT_G11').ok, false);
  assert.equal(states.requireState(rowsFor(10), 'EXACT_G14').ok, false);
  for (const bad of ['S4', 'EXACT_G9', '', null]) assert.throws(() => states.requireState(rowsFor(4), bad), /state/);
});

test('ST-10 the ledger SQL is one read-only SELECT of the four needed columns, unordered', () => {
  assert.match(states.LEDGER_SQL, /^SELECT migration_name, checksum, \(finished_at IS NOT NULL\) AS finished, \(rolled_back_at IS NOT NULL\) AS rolled_back FROM ONLY public\."_prisma_migrations"$/);
});
