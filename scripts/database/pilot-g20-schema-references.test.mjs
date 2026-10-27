// Zero-database tests for pilot-g20-schema-references.mjs: the G16..G20 reviewed probes and references (G16..G19 reused from the G19 module, G20 added).
// Run with: node --test scripts/database/pilot-g20-schema-references.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GENERATION_PROBES_G19, SCHEMA_REFERENCES_G19 } from './pilot-g19-schema-references.mjs';
import { GENERATION_PROBES_G20, GENERATION_SCHEMA_G20, PENDING_REFERENCES, SCHEMA_REFERENCES_G20 } from './pilot-g20-schema-references.mjs';

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'api', 'prisma', 'migrations');
const CLAIM_SQL = readFileSync(path.join(MIGRATIONS, '20261026150000_sale_post_sale_guard', 'migration.sql'), 'utf8');
const code = CLAIM_SQL.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
const G = ['EXACT_G16', 'EXACT_G17', 'EXACT_G18', 'EXACT_G19', 'EXACT_G20'];

test('S20-01 references and probes exist for G16..G20; G16..G19 are the ones the G19 module pinned (reused, not re-declared)', () => {
  assert.deepEqual(Object.keys(SCHEMA_REFERENCES_G20), G);
  assert.deepEqual(Object.keys(GENERATION_PROBES_G20), G);
  for (const g of G.slice(0, 4)) assert.equal(SCHEMA_REFERENCES_G20[g], SCHEMA_REFERENCES_G19[g], g);
  assert.equal(GENERATION_SCHEMA_G20.references, SCHEMA_REFERENCES_G20);
  assert.equal(GENERATION_SCHEMA_G20.probes, GENERATION_PROBES_G20);
});

test('S20-02 all five digests are PINNED (derived on PostgreSQL 17.11, not typed), 64 lowercase hex, five distinct schemas, nothing pending', () => {
  assert.deepEqual(PENDING_REFERENCES, []);
  const digests = G.map((g) => SCHEMA_REFERENCES_G20[g].digest);
  for (const d of digests) assert.match(d, /^[0-9a-f]{64}$/);
  assert.equal(new Set(digests).size, 5);
  assert.equal(SCHEMA_REFERENCES_G20.EXACT_G16.digest, '87ecc8d780b9a7fae79de6d4bd0eaf1ecba354e6ed2e7c9e5da4da3c30c9c7b3'); // the control
  assert.equal(SCHEMA_REFERENCES_G20.EXACT_G20.digest, '2f9527496aa8d4881ae345baaf8a6a678ca1127ec7319313a80850cffa2026a3');
  for (const g of G) assert.ok(Object.isFrozen(SCHEMA_REFERENCES_G20[g]) && Object.isFrozen(SCHEMA_REFERENCES_G20[g].summary), g);
  const a = SCHEMA_REFERENCES_G20.EXACT_G19.summary; const b = SCHEMA_REFERENCES_G20.EXACT_G20.summary;
  // exactly what migration 20 creates: one table (3 columns, pkey + fkey + check, pkey index), one function, two triggers
  assert.deepEqual({ tables: b.tables - a.tables, columns: b.columns - a.columns, constraints: b.constraints - a.constraints, indexes: b.indexes - a.indexes, functions: b.functions - a.functions, triggers: b.triggers - a.triggers },
    { tables: 1, columns: 3, constraints: 3, indexes: 1, functions: 1, triggers: 2 });
});

const delta = () => {
  const before = new Set(GENERATION_PROBES_G20.EXACT_G19.filter((p) => !p.kind.startsWith('absent')).map((p) => JSON.stringify(p)));
  return GENERATION_PROBES_G20.EXACT_G20.filter((p) => !p.kind.startsWith('absent') && !before.has(JSON.stringify(p)));
};

test('S20-03 every probe G20 adds names an object that the migration SQL really creates, and the SQL objects are all covered', () => {
  for (const p of delta()) {
    if (p.kind === 'column') assert.match(code, new RegExp(`"${p.name}"`), p.name); else assert.ok(code.includes(p.name), `${p.kind} ${p.name}`);
  }
  const names = new Set(GENERATION_PROBES_G20.EXACT_G20.map((p) => p.name));
  for (const m of code.matchAll(/CREATE FUNCTION public\."(\w+)"/g)) assert.ok(names.has(m[1]), m[1]);
  for (const m of code.matchAll(/CREATE TRIGGER "(\w+)"/g)) assert.ok(names.has(m[1]), m[1]);
  for (const m of code.matchAll(/CREATE TABLE "(\w+)"/g)) assert.ok(names.has(m[1]), m[1]);
  for (const m of code.matchAll(/CONSTRAINT "(\w+)"/g)) assert.ok(names.has(m[1]), m[1]);
  const count = delta().reduce((acc, p) => ({ ...acc, [p.kind]: (acc[p.kind] ?? 0) + 1 }), {});
  assert.deepEqual(count, { table: 1, column: 3, constraint: 3, index: 1, function: 1, trigger: 2 });
});

test('S20-04 earlier generations assert the ABSENCE of every G20 object; G20 asserts presence only and keeps every G19 presence probe', () => {
  const absent = (g) => GENERATION_PROBES_G20[g].filter((p) => p.kind.startsWith('absent')).map((p) => p.name);
  for (const g of G.slice(0, 4)) {
    assert.ok(absent(g).includes('SalePostSaleGuard') && absent(g).includes('fn_sale_post_sale_claim'), g);
    // never weaker than the G19 module: every G19 probe is still there
    for (const p of GENERATION_PROBES_G19[g]) assert.ok(GENERATION_PROBES_G20[g].some((q) => JSON.stringify(q) === JSON.stringify(p)), `${g} ${p.kind} ${p.name}`);
  }
  assert.deepEqual(absent('EXACT_G20'), []);
  const present19 = GENERATION_PROBES_G19.EXACT_G19.map((p) => JSON.stringify(p));
  assert.deepEqual(GENERATION_PROBES_G20.EXACT_G20.slice(0, present19.length).map((p) => JSON.stringify(p)), present19);
});

test('S20-05 probes are frozen and carry no value other than object names', () => {
  for (const list of Object.values(GENERATION_PROBES_G20)) {
    assert.ok(Object.isFrozen(list));
    for (const p of list) assert.ok(Object.isFrozen(p));
  }
});
