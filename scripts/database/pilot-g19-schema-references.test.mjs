// Zero-database tests for pilot-g19-schema-references.mjs: the G16..G19 reviewed probes and the references (all four pinned; the pending shape is kept for a future generation).
// Run with: node --test scripts/database/pilot-g19-schema-references.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GENERATION_PROBES as PROBES_G16, SCHEMA_REFERENCES_POST_G14 } from './pilot-g16-schema-references.mjs';
import {
  GENERATION_PROBES_G19, GENERATION_SCHEMA_G19, PENDING_REFERENCES, SCHEMA_REFERENCES_G19,
} from './pilot-g19-schema-references.mjs';

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'api', 'prisma', 'migrations');
const sql = (name) => readFileSync(path.join(MIGRATIONS, name, 'migration.sql'), 'utf8');
const ENUM_SQL = sql('20261026120000_sale_exchange_enum');
const SCHEMA_SQL = sql('20261026130000_sale_exchange_schema');
const GUARD_SQL = sql('20261026140000_sale_void_exchange_guard');
const G = ['EXACT_G16', 'EXACT_G17', 'EXACT_G18', 'EXACT_G19'];

test('S19-01 references and probes exist for G16..G19; G16 is the pinned one, reused not re-declared', () => {
  assert.deepEqual(Object.keys(SCHEMA_REFERENCES_G19), G);
  assert.deepEqual(Object.keys(GENERATION_PROBES_G19), G);
  assert.equal(SCHEMA_REFERENCES_G19.EXACT_G16, SCHEMA_REFERENCES_POST_G14.EXACT_G16);
  assert.match(SCHEMA_REFERENCES_G19.EXACT_G16.digest, /^[0-9a-f]{64}$/);
  assert.equal(GENERATION_SCHEMA_G19.references, SCHEMA_REFERENCES_G19);
  assert.equal(GENERATION_SCHEMA_G19.probes, GENERATION_PROBES_G19);
});

test('S19-02 the G17, G18 and G19 digests are PINNED: generated on PostgreSQL 17 (not typed), 64 lowercase hex, four distinct schemas, nothing pending', () => {
  assert.deepEqual(PENDING_REFERENCES, []);
  const digests = G.map((g) => SCHEMA_REFERENCES_G19[g].digest);
  for (const d of digests) assert.match(d, /^[0-9a-f]{64}$/);
  assert.equal(new Set(digests).size, 4, 'four distinct schemas');
  for (const g of G) assert.ok(Object.isFrozen(SCHEMA_REFERENCES_G19[g]) && Object.isFrozen(SCHEMA_REFERENCES_G19[g].summary), g);
  // the deltas the summaries record are exactly what the migrations add (counted from the SQL objects the probes name)
  const s = Object.fromEntries(G.map((g) => [g, SCHEMA_REFERENCES_G19[g].summary]));
  assert.deepEqual(s.EXACT_G17, s.EXACT_G16, 'G17 only adds enum labels');
  assert.deepEqual({ tables: s.EXACT_G18.tables - s.EXACT_G17.tables, columns: s.EXACT_G18.columns - s.EXACT_G17.columns, constraints: s.EXACT_G18.constraints - s.EXACT_G17.constraints,
    indexes: s.EXACT_G18.indexes - s.EXACT_G17.indexes, functions: s.EXACT_G18.functions - s.EXACT_G17.functions, triggers: s.EXACT_G18.triggers - s.EXACT_G17.triggers },
  { tables: 2, columns: 19, constraints: 19, indexes: 13, functions: 5, triggers: 9 });
  assert.deepEqual({ functions: s.EXACT_G19.functions - s.EXACT_G18.functions, triggers: s.EXACT_G19.triggers - s.EXACT_G18.triggers, tables: s.EXACT_G19.tables - s.EXACT_G18.tables }, { functions: 2, triggers: 2, tables: 0 });
  // the control: the G16 value is the one pinned before this release, reproduced byte for byte by the generator
  assert.equal(SCHEMA_REFERENCES_G19.EXACT_G16.digest, '87ecc8d780b9a7fae79de6d4bd0eaf1ecba354e6ed2e7c9e5da4da3c30c9c7b3');
});

function delta(from, to) {
  const key = (p) => JSON.stringify(p);
  const before = new Set(GENERATION_PROBES_G19[from].filter((p) => !p.kind.startsWith('absent')).map(key));
  return GENERATION_PROBES_G19[to].filter((p) => !p.kind.startsWith('absent') && !before.has(key(p)));
}

test('S19-03 every probe added by a migration names an object that the migration SQL really creates', () => {
  const code = (text) => text.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
  const check = (probes, text, label) => {
    assert.ok(probes.length > 0, label);
    for (const p of probes) {
      if (p.kind === 'enumLabels') { for (const l of p.labels) assert.match(text, new RegExp(`'${l}'`), `${label} ${l}`); continue; }
      if (p.kind === 'column') { assert.match(text, new RegExp(`"${p.name}"`), `${label} ${p.table}.${p.name}`); continue; }
      assert.ok(text.includes(p.name), `${label} ${p.kind} ${p.name}`);
    }
  };
  check(delta('EXACT_G16', 'EXACT_G17'), code(ENUM_SQL), 'G17');
  check(delta('EXACT_G17', 'EXACT_G18'), code(SCHEMA_SQL), 'G18');
  check(delta('EXACT_G18', 'EXACT_G19'), code(GUARD_SQL), 'G19');
});

test('S19-04 the probe deltas are exactly the reviewed ones: counts per kind', () => {
  const count = (list) => list.reduce((a, p) => ({ ...a, [p.kind]: (a[p.kind] ?? 0) + 1 }), {});
  assert.deepEqual(count(delta('EXACT_G16', 'EXACT_G17')), { enumLabels: 1 });
  assert.deepEqual(count(delta('EXACT_G17', 'EXACT_G18')), { table: 2, column: 19, constraint: 19, index: 13, function: 5, trigger: 9 });
  assert.deepEqual(count(delta('EXACT_G18', 'EXACT_G19')), { function: 2, trigger: 2 });
});

test('S19-05 the SQL objects are all covered: every table, index, constraint, function and trigger the G18/G19 SQL creates has a probe', () => {
  const names = new Set(GENERATION_PROBES_G19.EXACT_G19.map((p) => p.name));
  const code = [SCHEMA_SQL, GUARD_SQL].map((text) => text.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n')).join('\n');
  for (const m of code.matchAll(/CREATE (?:UNIQUE )?INDEX "(\w+)"/g)) assert.ok(names.has(m[1]), m[1]);
  for (const m of code.matchAll(/ADD CONSTRAINT "(\w+)"/g)) assert.ok(names.has(m[1]), m[1]);
  for (const m of code.matchAll(/CREATE FUNCTION public\."(\w+)"/g)) assert.ok(names.has(m[1]), m[1]);
  for (const m of code.matchAll(/CREATE (?:CONSTRAINT )?TRIGGER "(\w+)"/g)) assert.ok(names.has(m[1]), m[1]);
  for (const m of code.matchAll(/CREATE TABLE "(\w+)"/g)) assert.ok(names.has(m[1]), m[1]);
});

test('S19-06 earlier generations assert the ABSENCE of every later object; G19 asserts presence only', () => {
  const absent = (g) => GENERATION_PROBES_G19[g].filter((p) => p.kind.startsWith('absent')).map((p) => p.name);
  assert.ok(absent('EXACT_G16').includes('SaleExchange') && absent('EXACT_G16').includes('fn_sale_void_exchange_guard') && absent('EXACT_G16').includes('StockMovementType'));
  assert.ok(absent('EXACT_G17').includes('SaleExchange') && !absent('EXACT_G17').includes('StockMovementType'));
  assert.ok(absent('EXACT_G18').includes('fn_sale_void_exchange_guard') && !absent('EXACT_G18').includes('SaleExchange'));
  assert.deepEqual(absent('EXACT_G19'), []);
  // G16 here is the G16 probe set of the G16 module plus absences, never weaker
  const present = (g) => GENERATION_PROBES_G19[g].filter((p) => !p.kind.startsWith('absent'));
  assert.deepEqual(present('EXACT_G16').map((p) => JSON.stringify(p)), PROBES_G16.EXACT_G16.map((p) => JSON.stringify(p)));
});

test('S19-07 probes are frozen and carry no value other than object names', () => {
  for (const list of Object.values(GENERATION_PROBES_G19)) {
    assert.ok(Object.isFrozen(list));
    for (const p of list) assert.ok(Object.isFrozen(p));
  }
});
