// Zero-database unit tests for scripts/database/pilot-migration-generations.mjs: the migration generations
// G14 (frozen cut-over target), G15 (intermediate) and G16 (latest, sale void v1).
// Run with: node --test scripts/database/pilot-migration-generations.test.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import * as generations from './pilot-migration-generations.mjs';
import * as states from './pilot-migration-states.mjs';

const SOURCE = readFileSync(new URL('./pilot-migration-generations.mjs', import.meta.url), 'utf8');
const MIGRATIONS_DIR = fileURLToPath(new URL('../../api/prisma/migrations/', import.meta.url));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const row = (pin, patch = {}) => ({ migration_name: pin.name, checksum: pin.sha256, finished: true, rolled_back: false, ...patch });
const ledger = (generation) => generations.pinsOf(generation).map((pin) => row(pin));

const ENUM = '20261024120000_sale_void_enum';
const SCHEMA = '20261024130000_sale_void_schema';

test('GN-01 the two new pins are the exact bytes on disk (size and SHA-256), file by file', () => {
  assert.deepEqual(generations.POST_G14_MIGRATION_PINS.map((p) => p.name), [ENUM, SCHEMA]);
  for (const pin of generations.POST_G14_MIGRATION_PINS) {
    assert.ok(Object.isFrozen(pin), pin.name);
    const bytes = readFileSync(path.join(MIGRATIONS_DIR, pin.name, 'migration.sql'));
    assert.equal(bytes.length, pin.bytes, pin.name);
    assert.equal(sha(bytes), pin.sha256, pin.name);
  }
});

test('GN-02 G14 is the frozen set of the cut-over module, untouched and a strict prefix of G15 and G16', () => {
  assert.equal(states.MIGRATION_PINS.length, 14);
  assert.deepEqual(generations.GENERATIONS.EXACT_G14, states.STATES.EXACT_G14);
  assert.deepEqual(generations.GENERATION_MIGRATION_PINS.slice(0, 14), states.MIGRATION_PINS);
  assert.deepEqual(generations.GENERATIONS.EXACT_G15, [...states.STATES.EXACT_G14, ENUM]);
  assert.deepEqual(generations.GENERATIONS.EXACT_G16, [...states.STATES.EXACT_G14, ENUM, SCHEMA]);
  assert.equal(generations.CUTOVER_TARGET_GENERATION, states.FINAL_STATE);
  assert.equal(generations.LATEST_GENERATION, 'EXACT_G16');
  assert.deepEqual(generations.INTERMEDIATE_GENERATIONS, ['EXACT_G15']);
  assert.ok(Object.isFrozen(generations.GENERATIONS) && Object.isFrozen(generations.GENERATION_MIGRATION_PINS));
});

test('GN-03 the cut-over module is NOT extended: its final state, its pins and its states stay G14', () => {
  assert.equal(states.FINAL_STATE, 'EXACT_G14');
  assert.deepEqual(Object.keys(states.STATES), ['EXACT_S4', 'EXACT_G7', 'EXACT_G11', 'EXACT_G12', 'EXACT_G13', 'EXACT_G14']);
  assert.equal(states.classifyLedger([...ledger('EXACT_G16')]).ok, false, 'a G16 ledger is an unknown migration to every G14 cut-over tool');
  assert.equal(states.classifyLedger(ledger('EXACT_G14')).state, 'EXACT_G14');
});

test('GN-04 the ledgers of G14, G15 and G16 classify as exactly themselves', () => {
  for (const generation of ['EXACT_G14', 'EXACT_G15', 'EXACT_G16']) {
    assert.deepEqual(generations.classifyGenerationLedger(ledger(generation)), { ok: true, state: generation }, generation);
  }
});

test('GN-05 row order does not matter', () => {
  assert.equal(generations.classifyGenerationLedger(ledger('EXACT_G16').reverse()).state, 'EXACT_G16');
});

test('GN-06 fail closed: older prefixes, a gap, an unknown migration, a missing one and the empty ledger are refused', () => {
  const g16 = ledger('EXACT_G16');
  const refused = (rows) => assert.equal(generations.classifyGenerationLedger(rows).ok, false);
  for (const generation of ['EXACT_S4', 'EXACT_G7', 'EXACT_G11', 'EXACT_G12', 'EXACT_G13']) refused(states.STATES[generation].map((name) => row(states.MIGRATION_PINS.find((p) => p.name === name))));
  refused(g16.filter((r) => r.migration_name !== ENUM)); // the schema migration without the enum one
  refused(g16.filter((r) => r.migration_name !== SCHEMA && r.migration_name !== states.MIGRATION_PINS[3].name));
  refused([...g16, row({ name: '20261030000000_unreviewed', sha256: 'a'.repeat(64) })]);
  refused([]);
});

test('GN-07 fail closed: a changed checksum, a duplicate, a rolled-back or unfinished attempt and malformed rows are refused', () => {
  const g16 = ledger('EXACT_G16');
  const refused = (rows, pattern) => {
    const r = generations.classifyGenerationLedger(rows);
    assert.equal(r.ok, false);
    assert.match(r.reason, pattern);
  };
  refused(g16.map((r) => (r.migration_name === SCHEMA ? { ...r, checksum: 'b'.repeat(64) } : r)), /checksum differs/);
  refused([...g16, g16[0]], /more than one row/);
  refused(g16.map((r) => (r.migration_name === ENUM ? { ...r, rolled_back: true } : r)), /rolled-back/);
  refused(g16.map((r) => (r.migration_name === ENUM ? { ...r, finished: false } : r)), /unfinished/);
  refused([...g16, null], /malformed/);
  refused([...g16, { migration_name: 1 }], /malformed/);
  refused('not rows', /could not be read/);
  assert.ok(!JSON.stringify(generations.classifyGenerationLedger(g16.map((r) => ({ ...r, checksum: 'SECRET-VALUE' })))).includes('SECRET-VALUE'));
});

test('GN-08 requireGeneration names exactly one generation: another valid one is a refusal and an unknown name throws', () => {
  assert.equal(generations.requireGeneration(ledger('EXACT_G16'), 'EXACT_G16').ok, true);
  const mismatch = generations.requireGeneration(ledger('EXACT_G15'), 'EXACT_G16');
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.reason, /ledger is EXACT_G15, expected EXACT_G16/);
  assert.throws(() => generations.requireGeneration([], 'EXACT_G17'), /unknown expected generation/);
  assert.throws(() => generations.pinsOf('G16'), /unknown generation/);
});

test('GN-09 the real migration tree is exactly G16 on disk (the latest), and its first fourteen directories are the G14 pins', () => {
  const onDisk = readdirSync(MIGRATIONS_DIR).filter((d) => /^\d{14}_/.test(d)).sort();
  assert.deepEqual(onDisk, generations.GENERATIONS.EXACT_G16);
  assert.deepEqual(onDisk.slice(0, 14), generations.GENERATIONS.EXACT_G14);
  for (const pin of generations.GENERATION_MIGRATION_PINS) {
    assert.equal(sha(readFileSync(path.join(MIGRATIONS_DIR, pin.name, 'migration.sql'))), pin.sha256, pin.name);
  }
});

test('GN-10 literals only: the module reads no disk, environment or process and imports only the cut-over pins', () => {
  assert.doesNotMatch(SOURCE, /readdir|readFile|createHash|process\.|import\(|require\(|node:fs/);
  const specifiers = [...SOURCE.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  assert.deepEqual(specifiers, ['./pilot-migration-states.mjs']);
});
