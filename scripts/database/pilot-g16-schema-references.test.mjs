// Zero-database tests for pilot-g16-schema-references.mjs: the G15/G16 app-schema references and the reviewed probes
// of the three generations. Run with: node --test scripts/database/pilot-g16-schema-references.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCHEMA_REFERENCES } from './pilot-schema-references.mjs';
import { GENERATION_PROBES, GENERATION_SCHEMA, SCHEMA_REFERENCES_POST_G14 } from './pilot-g16-schema-references.mjs';
import { GENERATIONS } from './pilot-migration-generations.mjs';

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'api', 'prisma', 'migrations');
const sql = (name) => readFileSync(path.join(MIGRATIONS, name, 'migration.sql'), 'utf8');
const ENUM_SQL = sql('20261024120000_sale_void_enum');
const SCHEMA_SQL = sql('20261024130000_sale_void_schema');
const PINNED_G14_DIGEST = 'eb00d04bc7035723988afa16d34f21e4b07cfcb9bd3f8248159cd58b5d9f1f71';

test('SR-01 the three generations G14..G16 have a reference and probes; G14 is the pinned one, not re-declared', () => {
  // G17..G19 (sale exchange v1) are deliberately NOT here: a reference is the digest of a disposable PostgreSQL 17 cluster built from the
  // generation's migrations, and none was authorized or run for them (see the sale exchange rollout runbook).
  const g14ToG16 = Object.keys(GENERATIONS).slice(0, 3);
  assert.deepEqual(g14ToG16, ['EXACT_G14', 'EXACT_G15', 'EXACT_G16']);
  assert.deepEqual(Object.keys(SCHEMA_REFERENCES_POST_G14), g14ToG16);
  assert.deepEqual(Object.keys(GENERATION_PROBES), g14ToG16);
  assert.equal(SCHEMA_REFERENCES_POST_G14.EXACT_G14, SCHEMA_REFERENCES.EXACT_G14);
  assert.equal(SCHEMA_REFERENCES_POST_G14.EXACT_G14.digest, PINNED_G14_DIGEST);
  const digests = Object.values(SCHEMA_REFERENCES_POST_G14).map((r) => r.digest);
  for (const d of digests) assert.match(d, /^[0-9a-f]{64}$/);
  assert.equal(new Set(digests).size, 3, 'three distinct schemas');
  assert.equal(GENERATION_SCHEMA.references, SCHEMA_REFERENCES_POST_G14);
});

test('SR-02 the G16 reference summary matches the reviewed contract (33 tables, 321 columns, 171 constraints, 144 indexes, 11 functions, 12 triggers)', () => {
  assert.deepEqual(SCHEMA_REFERENCES_POST_G14.EXACT_G16.summary, { tables: 33, columns: 321, enums: 18, types: 0, constraints: 171, indexes: 144, functions: 11, triggers: 12 });
  assert.deepEqual(SCHEMA_REFERENCES_POST_G14.EXACT_G15.summary, SCHEMA_REFERENCES_POST_G14.EXACT_G14.summary, 'G15 only adds enum labels');
});

test('SR-03 every G16 delta probe names an object that the migration SQL really creates', () => {
  const g14 = new Set(GENERATION_PROBES.EXACT_G14.filter((p) => !p.kind.startsWith('absent')).map((p) => JSON.stringify(p)));
  const delta = GENERATION_PROBES.EXACT_G16.filter((p) => !g14.has(JSON.stringify(p)));
  assert.ok(delta.length >= 59, `delta probes: ${delta.length}`);
  for (const p of delta) {
    if (p.kind === 'enumLabels') { for (const label of p.labels) assert.match(ENUM_SQL, new RegExp(`'${label}'`), label); continue; }
    if (p.kind === 'column') { assert.match(SCHEMA_SQL, new RegExp(`"${p.name}"`), `${p.table}.${p.name}`); continue; }
    assert.ok(SCHEMA_SQL.includes(p.name), `${p.kind} ${p.name}`);
  }
});

test('SR-04 G14 and G15 assert the ABSENCE of every later object; G16 asserts its presence', () => {
  const kinds = (g) => new Set(GENERATION_PROBES[g].map((p) => p.kind));
  assert.ok(kinds('EXACT_G14').has('absentTable') && kinds('EXACT_G14').has('absentEnumLabels') && kinds('EXACT_G14').has('absentTrigger'));
  assert.ok(kinds('EXACT_G15').has('absentTable') && kinds('EXACT_G15').has('enumLabels'));
  assert.ok(!kinds('EXACT_G16').has('absentTable'));
  const labels = GENERATION_PROBES.EXACT_G15.filter((p) => p.kind === 'enumLabels' && p.labels.some((l) => ['SALE_REFUND', 'SALE_VOID'].includes(l)));
  assert.equal(labels.length, 2, 'G15 has both new labels');
});

test('SR-05 probes are frozen and carry no value other than object names', () => {
  for (const list of Object.values(GENERATION_PROBES)) {
    assert.ok(Object.isFrozen(list));
    for (const p of list) assert.ok(Object.isFrozen(p));
  }
});
