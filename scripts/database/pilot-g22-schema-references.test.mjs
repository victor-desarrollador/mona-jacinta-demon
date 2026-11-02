// Zero-database tests for pilot-g22-schema-references.mjs: the G16..G22 reviewed probes and references (G16..G20 reused from the G20 module, G21 and G22 added).
// Run with: node --test scripts/database/pilot-g22-schema-references.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GENERATION_PROBES_G20, SCHEMA_REFERENCES_G20 } from './pilot-g20-schema-references.mjs';
import {
  G21_CREDENTIALS_ADDS, G22_LIFECYCLE_ADDS, GENERATION_PROBES_G22, GENERATION_SCHEMA_G22, PENDING_REFERENCES, SCHEMA_REFERENCES_G22,
} from './pilot-g22-schema-references.mjs';

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'api', 'prisma', 'migrations');
const strip = (sql) => sql.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
const G21_SQL = strip(readFileSync(path.join(MIGRATIONS, '20261101120000_user_credentials_epoch', 'migration.sql'), 'utf8'));
const G22_SQL = strip(readFileSync(path.join(MIGRATIONS, '20261101130000_user_admin_lifecycle', 'migration.sql'), 'utf8'));
const G = ['EXACT_G16', 'EXACT_G17', 'EXACT_G18', 'EXACT_G19', 'EXACT_G20', 'EXACT_G21', 'EXACT_G22'];

test('S22-01 references and probes exist for G16..G22; G16..G20 are the ones the G20 module pinned (reused, not re-declared)', () => {
  assert.deepEqual(Object.keys(SCHEMA_REFERENCES_G22), G);
  assert.deepEqual(Object.keys(GENERATION_PROBES_G22), G);
  for (const g of G.slice(0, 5)) assert.equal(SCHEMA_REFERENCES_G22[g], SCHEMA_REFERENCES_G20[g], g);
  assert.equal(GENERATION_SCHEMA_G22.references, SCHEMA_REFERENCES_G22);
  assert.equal(GENERATION_SCHEMA_G22.probes, GENERATION_PROBES_G22);
});

test('S22-02 all seven digests are PINNED (derived on PostgreSQL 17.11, not typed), 64 lowercase hex, seven distinct schemas, nothing pending', () => {
  assert.deepEqual(PENDING_REFERENCES, []);
  const digests = G.map((g) => SCHEMA_REFERENCES_G22[g].digest);
  for (const d of digests) assert.match(d, /^[0-9a-f]{64}$/);
  assert.equal(new Set(digests).size, 7);
  assert.equal(SCHEMA_REFERENCES_G22.EXACT_G20.digest, '2f9527496aa8d4881ae345baaf8a6a678ca1127ec7319313a80850cffa2026a3'); // the control: also what PILOT holds
  assert.equal(SCHEMA_REFERENCES_G22.EXACT_G21.digest, 'eef8c81a5c5f3b484a6232b62350e0eb8fc493dfa28d66b43780ebab48f1788b');
  assert.equal(SCHEMA_REFERENCES_G22.EXACT_G22.digest, 'adbff646732d9896473c328c317bd44b9dc837cb3411d6dd41807ca2183e1e92');
  for (const g of G) assert.ok(Object.isFrozen(SCHEMA_REFERENCES_G22[g]) && Object.isFrozen(SCHEMA_REFERENCES_G22[g].summary), g);
});

test('S22-03 the summaries are exactly what the migrations add: G21 = two columns and nothing else; G22 = one table, 7 columns, 6 constraints, 4 indexes, no relation change other than the new table', () => {
  const s = (g) => SCHEMA_REFERENCES_G22[g].summary;
  const diff = (a, b) => Object.fromEntries(Object.keys(s(b)).map((k) => [k, s(b)[k] - s(a)[k]]));
  assert.deepEqual(diff('EXACT_G20', 'EXACT_G21'), { tables: 0, columns: 2, enums: 0, types: 0, constraints: 0, indexes: 0, functions: 0, triggers: 0 });
  assert.deepEqual(diff('EXACT_G21', 'EXACT_G22'), { tables: 1, columns: 7, enums: 0, types: 0, constraints: 6, indexes: 4, functions: 0, triggers: 0 });
  // the local-test fingerprint counts the Prisma ledger too: 352 + 8 ledger columns = 360, 37 + 1 ledger = 38 relations
  assert.equal(s('EXACT_G22').columns + 8, 360);
  assert.equal(s('EXACT_G22').tables + 1, 38);
});

const presentOf = (list) => list.filter((p) => !p.kind.startsWith('absent'));
const delta = (from, to) => {
  const before = new Set(presentOf(GENERATION_PROBES_G22[from]).map((p) => JSON.stringify(p)));
  return presentOf(GENERATION_PROBES_G22[to]).filter((p) => !before.has(JSON.stringify(p)));
};

test('S22-04 every probe G21 adds names an object migration 21 really creates, and the SQL creates nothing else', () => {
  const d = delta('EXACT_G20', 'EXACT_G21');
  assert.deepEqual(d, [...G21_CREDENTIALS_ADDS]);
  for (const p of d) assert.match(G21_SQL, new RegExp(`ADD COLUMN "${p.name}"`), p.name);
  assert.equal([...G21_SQL.matchAll(/ADD COLUMN/g)].length, d.length);
  assert.doesNotMatch(G21_SQL, /CREATE (TABLE|INDEX|UNIQUE|FUNCTION|TRIGGER)/);
});

test('S22-05 every probe G22 adds names an object migration 22 really creates, and every object the SQL creates is covered', () => {
  const d = delta('EXACT_G21', 'EXACT_G22');
  assert.deepEqual(d, [...G22_LIFECYCLE_ADDS]);
  for (const p of d) {
    if (p.kind === 'column') assert.match(G22_SQL, new RegExp(`"${p.name}"`), p.name); else assert.ok(G22_SQL.includes(p.name), `${p.kind} ${p.name}`);
  }
  const names = new Set(GENERATION_PROBES_G22.EXACT_G22.map((p) => p.name));
  for (const m of G22_SQL.matchAll(/CREATE TABLE "(\w+)"/g)) assert.ok(names.has(m[1]), m[1]);
  for (const m of G22_SQL.matchAll(/CONSTRAINT "(\w+)"/g)) assert.ok(names.has(m[1]), m[1]);
  for (const m of G22_SQL.matchAll(/CREATE (?:UNIQUE )?INDEX "(\w+)"/g)) assert.ok(names.has(m[1]), m[1]);
  const count = d.reduce((acc, p) => ({ ...acc, [p.kind]: (acc[p.kind] ?? 0) + 1 }), {});
  assert.deepEqual(count, { index: 4, table: 1, column: 7, constraint: 6 });
});

test('S22-06 earlier generations assert the ABSENCE of every G21/G22 object; G21 asserts the G22 absence; G22 asserts presence only and keeps every G20 presence probe', () => {
  const absent = (g) => GENERATION_PROBES_G22[g].filter((p) => p.kind.startsWith('absent')).map((p) => p.name);
  for (const g of G.slice(0, 5)) {
    assert.ok(absent(g).includes('mustChangePassword') && absent(g).includes('credentialsChangedAt'), g);
    assert.ok(absent(g).includes('UserAdminOperation') && absent(g).includes('User_email_lower_key'), g);
    for (const p of GENERATION_PROBES_G20[g]) assert.ok(GENERATION_PROBES_G22[g].some((q) => JSON.stringify(q) === JSON.stringify(p)), `${g} ${p.kind} ${p.name}`);
  }
  assert.ok(!absent('EXACT_G21').includes('mustChangePassword'));
  assert.ok(absent('EXACT_G21').includes('UserAdminOperation') && absent('EXACT_G21').includes('User_email_lower_key'));
  assert.ok(presentOf(GENERATION_PROBES_G22.EXACT_G21).some((p) => p.name === 'credentialsChangedAt'));
  assert.deepEqual(absent('EXACT_G22'), []);
  assert.deepEqual(presentOf(GENERATION_PROBES_G22.EXACT_G22).slice(0, presentOf(GENERATION_PROBES_G20.EXACT_G20).length).map((p) => JSON.stringify(p)), presentOf(GENERATION_PROBES_G20.EXACT_G20).map((p) => JSON.stringify(p)));
});

test('S22-07 probes are frozen and carry no value other than object names', () => {
  for (const list of Object.values(GENERATION_PROBES_G22)) {
    assert.ok(Object.isFrozen(list));
    for (const p of list) assert.ok(Object.isFrozen(p));
  }
  assert.ok(Object.isFrozen(G21_CREDENTIALS_ADDS) && Object.isFrozen(G22_LIFECYCLE_ADDS));
});
