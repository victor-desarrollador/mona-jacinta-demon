// Hermetic tests for pilot-schema-reference.mjs: a fake pg client only (no database, no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as G from './pilot-schema-reference.mjs';
import * as P from './app-schema-projection.mjs';
import { LIVE_FACTS_SQL, MARKER_ROWS_SQL } from './local-test-marker.mjs';
import { LEDGER_SQL, MIGRATION_PINS, STATES } from './pilot-migration-states.mjs';
import { STATE_PROBES } from './pilot-schema-references.mjs';

const MID = '11111111-1111-4111-8111-111111111111';
const PW = 'S3cret-local';
const SID = '7311234567890123456';
const ENV = { LOCAL_TEST_DATABASE_URL: `postgresql://mona_local_test:${PW}@127.0.0.1:5432/mona_local_test`, LOCAL_TEST_DATABASE_MARKER_ID: MID };
const ARGV = (state = 'EXACT_S4', sid = SID) => ['--target=local-test', `--expected-state=${state}`, `--system-identifier=${sid}`];
const ledger = (n) => MIGRATION_PINS.slice(0, n).map((p) => ({ migration_name: p.name, checksum: p.sha256, finished: true, rolled_back: false }));

// A projection that satisfies the REAL probes of a state: built from the probe list itself.
function rawFor(state) {
  const tables = new Map(); const raw = { tables: [], columns: [], enums: [], types: [], constraints: [], indexes: [], functions: [], triggers: [] };
  const table = (name) => { if (!tables.has(name)) { tables.set(name, true); raw.tables.push({ table: name }); raw.columns.push({ table: name, column: 'id', type: 'text', not_null: true, default_expr: null, identity: '', generated: '' }); } };
  for (const p of STATE_PROBES[state]) {
    if (p.kind === 'table') table(p.name);
    if (p.kind === 'column') { table(p.table); if (p.name !== 'id') raw.columns.push({ table: p.table, column: p.name, type: 'text', not_null: false, default_expr: null, identity: '', generated: '' }); }
    if (p.kind === 'enumLabels') p.labels.forEach((label, i) => raw.enums.push({ type: p.name, label, sort_order: String(i + 1) }));
    if (p.kind === 'constraint') { table(p.table); raw.constraints.push({ table: p.table, name: p.name, type: p.type, definition: `def ${p.name}`, validated: true }); }
    if (p.kind === 'index') { table(p.table); raw.indexes.push({ table: p.table, name: p.name, definition: `CREATE INDEX ${p.name}`, valid: true }); }
    if (p.kind === 'function') raw.functions.push({ name: p.name, args: '', kind: 'f', definition: `body ${p.name}` });
    if (p.kind === 'trigger') { table(p.table); raw.triggers.push({ table: p.table, name: p.name, definition: `CREATE TRIGGER ${p.name}`, enabled: 'O' }); }
  }
  // Probe-free extras (labels of a column-only enum) are not needed; dedupe constraint/index names per table.
  return raw;
}

function fakeClient(o = {}) {
  const queries = []; let inTx = false; let sp = '"$user", public';
  return {
    queries,
    connect: async () => { if (o.connectFail) throw new Error(`connect ${PW}`); },
    end: async () => { queries.push('END'); },
    query: async (text) => {
      queries.push(text);
      if (text === LIVE_FACTS_SQL) return { rows: [{ current_database: o.db ?? 'mona_local_test', current_user: 'mona_local_test', version: 'PostgreSQL 17.6 on x86_64', test_guard_exists: o.testGuard ?? false, pilot_guard_exists: false }] };
      if (text === MARKER_ROWS_SQL) return { rows: o.markers ?? [{ environment: 'local_test', marker_id: MID, has_installed_at: true }] };
      if (text === G.REFERENCE_SQL.systemIdentifier) return { rows: [{ system_identifier: o.sid ?? SID }] };
      if (text === G.REFERENCE_SQL.begin) { inTx = true; return { rows: [] }; }
      if (text === G.REFERENCE_SQL.pinSearchPath) { if (!o.ignorePin) sp = P.PINNED_SEARCH_PATH; return { rows: [] }; }
      if (text === G.REFERENCE_SQL.rollback) { inTx = false; return { rows: [] }; }
      if (text === LEDGER_SQL) { assert.equal(inTx, true, 'ledger read inside the read-only snapshot'); return { rows: o.ledger ?? ledger(STATES[o.state ?? 'EXACT_S4'].length) }; }
      if (text === P.PROJECTION_SQL.searchPath) return { rows: [{ search_path: sp }] };
      for (const [k, sql] of Object.entries(P.PROJECTION_SQL)) if (text === sql) { assert.equal(inTx, true); return { rows: (o.raw ?? rawFor(o.state ?? 'EXACT_S4'))[k] }; }
      throw new Error(`unexpected SQL ${text}`);
    },
  };
}
async function run(argv, o = {}, env = ENV) {
  const lines = []; const client = fakeClient(o); let created = 0;
  const rc = await G.main(argv, { env, createClient: async () => { created += 1; return client; }, log: (l) => lines.push(String(l)), error: (l) => lines.push(String(l)) });
  return { rc, text: lines.join('\n'), lines, client, created };
}

test('GEN-01 args: exactly target local-test, an exact state and a decimal system identifier', async () => {
  for (const argv of [[], ARGV().slice(0, 2), [...ARGV(), '--x=1'], ['--target=pilot', ...ARGV().slice(1)], ARGV('EXACT_G10'), ARGV('EXACT_S4', '123'), ARGV('EXACT_S4', `${SID};x`),
    ['--target=local-test', '--target=local-test', `--system-identifier=${SID}`]]) {
    const r = await run(argv); assert.equal(r.rc, 1, JSON.stringify(argv)); assert.equal(r.created, 0);
  }
});
test('GEN-02 non-canonical LOCAL_TEST config → refused before any connection, nothing secret printed', async () => {
  for (const env of [{}, { ...ENV, LOCAL_TEST_DATABASE_URL: `postgresql://postgres:${PW}@db.x.supabase.co:5432/postgres` }, { ...ENV, LOCAL_TEST_DATABASE_MARKER_ID: 'x' }, { ...ENV, PGOPTIONS: '-c x=y' }]) {
    const r = await run(ARGV(), {}, env); assert.equal(r.rc, 2); assert.equal(r.created, 0); assert.ok(!r.text.includes(PW));
  }
});
test('GEN-03 identity: wrong database, TEST guard, marker mismatch/absent/duplicate, system identifier mismatch → refused before any snapshot', async () => {
  for (const o of [{ db: 'postgres' }, { testGuard: true }, { markers: [] }, { markers: [{ environment: 'local_test', marker_id: '22222222-2222-4222-8222-222222222222', has_installed_at: true }] },
    { markers: [{ environment: 'local_test', marker_id: MID, has_installed_at: true }, { environment: 'local_test', marker_id: MID, has_installed_at: true }] }, { sid: '7311234567890123457' }]) {
    const r = await run(ARGV(), o);
    assert.equal(r.rc, 2, JSON.stringify(o)); assert.ok(!r.client.queries.includes(G.REFERENCE_SQL.begin)); assert.ok(r.client.queries.includes('END'));
    assert.ok(!r.text.includes(MID));
  }
});
for (const state of ['EXACT_S4', 'EXACT_G7', 'EXACT_G11', 'EXACT_G12']) {
  test(`GEN-04 ${state}: exact ledger + real probes pass → one deterministic reference entry printed, read-only snapshot rolled back`, async () => {
    const r = await run(ARGV(state), { state });
    assert.equal(r.rc, 0, r.text); assert.equal(r.lines.at(-1), 'SCHEMA_REFERENCE_RESULT=PRINTED');
    const expected = G.renderReferenceEntry(state, P.buildProjection(rawFor(state)));
    assert.ok(r.lines.includes(expected));
    assert.match(expected, new RegExp(`^  ${state}: Object\\.freeze\\(\\{ digest: '[0-9a-f]{64}', summary: Object\\.freeze\\(\\{ tables: [0-9]+, columns: [0-9]+, enums: [0-9]+, types: [0-9]+, constraints: [0-9]+, indexes: [0-9]+, functions: [0-9]+, triggers: [0-9]+ \\}\\) \\}\\),$`));
    const q = r.client.queries;
    assert.ok(q.indexOf(G.REFERENCE_SQL.begin) < q.indexOf(G.REFERENCE_SQL.pinSearchPath) && q.indexOf(G.REFERENCE_SQL.pinSearchPath) < q.indexOf(LEDGER_SQL));
    assert.ok(q.includes(G.REFERENCE_SQL.rollback)); assert.ok(!q.some((x) => /^(COMMIT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)/i.test(x)));
    assert.match(G.REFERENCE_SQL.begin, /READ ONLY/);
  });
}
test('GEN-05 ledger of another valid state, partial, rolled back or checksum drift → refused, nothing printed', async () => {
  const drift = ledger(4); drift[3] = { ...drift[3], checksum: 'b'.repeat(64) };
  const rolled = ledger(4); rolled[1] = { ...rolled[1], rolled_back: true };
  for (const [label, rows, state] of [['G7 ledger, S4 expected', ledger(7), 'EXACT_S4'], ['G10', ledger(10), 'EXACT_G11'], ['drift', drift, 'EXACT_S4'], ['rolled back', rolled, 'EXACT_S4']]) {
    const r = await run(ARGV(state), { state, ledger: rows });
    assert.equal(r.rc, 3, label); assert.match(r.text, /phase=state/); assert.ok(!r.text.includes('digest:'), label); assert.ok(r.client.queries.includes(G.REFERENCE_SQL.rollback));
  }
});
test('GEN-06 a failing real probe (S4 database already carrying CompanyPricingConfig) → refused with the probe named, nothing printed', async () => {
  const raw = rawFor('EXACT_S4'); raw.tables.push({ table: 'CompanyPricingConfig' });
  const r = await run(ARGV('EXACT_S4'), { raw });
  assert.equal(r.rc, 3); assert.match(r.text, /PROBE_FAILED:absentTable:CompanyPricingConfig/); assert.ok(!r.text.includes('digest:'));
});
test('GEN-07 search_path not pinned → no projection, refused (error), never a reference under a foreign search_path', async () => {
  const r = await run(ARGV(), { ignorePin: true });
  assert.equal(r.rc, 4); assert.ok(!r.text.includes('digest:'));
});
test('GEN-08 connection failure → refused without echoing the error (secret-bearing)', async () => {
  const r = await run(ARGV(), { connectFail: true });
  assert.equal(r.rc, 4); assert.ok(!r.text.includes(PW));
});

// ---------------- §6 drift matrix at the generator ----------------
const entryOf = (r) => r.lines.find((l) => l.startsWith('  EXACT_G11: Object.freeze({ digest: '));
test('GEN-09 any drift of the projected schema changes the printed digest, deterministically', async () => {
  const clean = entryOf(await run(ARGV('EXACT_G11'), { state: 'EXACT_G11' }));
  const drifts = {
    'wrong column type': (r) => { r.columns.find((c) => c.column !== 'id').type = 'integer'; },
    'nullability drift': (r) => { r.columns[0].not_null = false; },
    'CHECK drift': (r) => { r.constraints.find((c) => c.type === 'c').definition = 'CHECK (false)'; },
    'unique/index drift': (r) => { r.indexes[0].definition = `${r.indexes[0].definition} WHERE (x IS NULL)`; },
    'unexpected app-owned table': (r) => { r.tables.push({ table: 'Intruder' }); },
    'unexpected app-owned function': (r) => { r.functions.push({ name: 'fn_backdoor', args: '', kind: 'f', definition: 'body' }); },
  };
  for (const [label, fn] of Object.entries(drifts)) {
    const raw = rawFor('EXACT_G11'); fn(raw);
    const a = await run(ARGV('EXACT_G11'), { state: 'EXACT_G11', raw }); const b = await run(ARGV('EXACT_G11'), { state: 'EXACT_G11', raw });
    assert.equal(a.rc, 0, `${label}: ${a.text}`); assert.notEqual(entryOf(a), clean, label); assert.equal(entryOf(a), entryOf(b), `${label} deterministic`);
  }
});
for (const [label, fn] of [
  ['missing table', (r) => { r.tables = r.tables.filter((t) => t.table !== 'SaleCheckout'); for (const k of ['columns', 'constraints', 'indexes', 'triggers']) r[k] = r[k].filter((x) => x.table !== 'SaleCheckout'); }],
  ['missing FK', (r) => { r.constraints = r.constraints.filter((c) => c.type !== 'f'); }],
  ['missing trigger', (r) => { r.triggers = r.triggers.slice(1); }],
  ['missing function', (r) => { r.functions = r.functions.slice(1); }],
  ['CHECK not validated', (r) => { r.constraints.find((c) => c.type === 'c').validated = false; }],
]) {
  test(`GEN-10 ${label} in an EXACT_G11 database → the real probes refuse, nothing printed`, async () => {
    const raw = rawFor('EXACT_G11'); fn(raw);
    const r = await run(ARGV('EXACT_G11'), { state: 'EXACT_G11', raw });
    assert.equal(r.rc, 3, label); assert.match(r.text, /PROBE_FAILED:/); assert.equal(entryOf(r), undefined);
  });
}
