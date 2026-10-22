// Zero-database unit tests for the G14 cut-over contract of scripts/database/pilot-migrate.mjs:
// approved tree = exact G14, an EXPLICIT expected initial state (EXACT_S4 | EXACT_G7 | EXACT_G11,
// never auto-selected), a plan digest the OWNER approves, a read-only pre-check (marker, exact
// ledger, app-schema digest + probes) before Prisma, and a read-only post-check that accepts
// only EXACT_G14 — a failed post-check reports RESTORE_REQUIRED and never repairs.
// Hermetic: fake api/ tree, fake pg client, fake spawn, synthetic schema references.
// Run with: node --test scripts/database/pilot-migrate-g11.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { API_DIR, APPROVED_MIGRATION_PAYLOAD, main, parseCliArgs, verifyMigrationPayload } from './pilot-migrate.mjs';
import { LOCK_PIN, MIGRATION_PINS, STATES, LEDGER_SQL } from './pilot-migration-states.mjs';
import { PROJECTION_SQL, buildProjection, projectionDigest } from './app-schema-projection.mjs';
import { fileURLToPath } from 'node:url';

const MARKER = '2b4d6f81-7a9c-4e0b-8d2f-3c5e7a9b1d0f';
const OTHER = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const REF = 'pilotsynthref0000001';
const SECRET = 'Mig5ecretPw';
const HOST = 'aws-0-synthetic.pooler.invalid';
const URL_TEXT = `postgresql://postgres.${REF}:${SECRET}@${HOST}:6543/postgres`;
const LEAKS = [SECRET, HOST, REF, URL_TEXT];
const FORBIDDEN_SQL = /\b(DROP|TRUNCATE|DELETE|UPDATE|ALTER|GRANT|REVOKE|CREATE|INSERT|COMMIT|resolve)\b/i;

// --- synthetic schema references ------------------------------------------------
const table = (name) => ({ table: name });
const column = (t, c) => ({ table: t, column: c, type: 'text', not_null: true, default_expr: null, identity: '', generated: '' });
function rawCatalog(tables) {
  return {
    tables: tables.map(table), columns: tables.map((t) => column(t, 'id')), enums: [], types: [],
    constraints: [], indexes: [], functions: [], triggers: [],
  };
}
const RAW = { EXACT_S4: rawCatalog(['Sale']), EXACT_G7: rawCatalog(['Sale', 'CompanyPricingConfig']), EXACT_G11: rawCatalog(['Sale', 'CompanyPricingConfig', 'SaleCheckout']), EXACT_G12: rawCatalog(['Sale', 'CompanyPricingConfig', 'SaleCheckout']), EXACT_G13: rawCatalog(['Sale', 'CompanyPricingConfig', 'SaleCheckout']), EXACT_G14: rawCatalog(['Sale', 'CompanyPricingConfig', 'SaleCheckout']) };
const SCHEMA = {
  references: Object.fromEntries(Object.entries(RAW).map(([s, r]) => [s, { digest: projectionDigest(buildProjection(r)) }])),
  probes: {
    EXACT_S4: [{ kind: 'absentTable', name: 'CompanyPricingConfig' }, { kind: 'absentTable', name: 'SaleCheckout' }],
    EXACT_G7: [{ kind: 'table', name: 'CompanyPricingConfig' }, { kind: 'absentTable', name: 'SaleCheckout' }],
    EXACT_G11: [{ kind: 'table', name: 'SaleCheckout' }],
    EXACT_G12: [{ kind: 'table', name: 'SaleCheckout' }],
    EXACT_G13: [{ kind: 'table', name: 'SaleCheckout' }],
    EXACT_G14: [{ kind: 'table', name: 'SaleCheckout' }],
  },
};
const ledgerOf = (state) => STATES[state].map((name) => ({ migration_name: name, checksum: MIGRATION_PINS.find((m) => m.name === name).sha256, finished: true, rolled_back: false }));

// --- fake api/ tree: an exact copy of the eleven reviewed migrations + lock ------
const TMP = mkdtempSync(path.join(os.tmpdir(), 'pilot-migrate-g11-test-'));
process.on('exit', () => rmSync(TMP, { recursive: true, force: true }));
// G11-ADV-001/002 fixture support: the repo-root TLS trust anchor (TMP is the repo
// root of every fake api/ tree created below).
mkdirSync(path.join(TMP, 'scripts', 'certs'), { recursive: true });
writeFileSync(path.join(TMP, 'scripts', 'certs', 'supabase-prod-ca-2021.crt'), 'FAKE-PILOT-CA\n');
function fakeApi() {
  const root = mkdtempSync(path.join(TMP, 'api-'));
  mkdirSync(path.join(root, 'node_modules', 'prisma', 'build'), { recursive: true });
  writeFileSync(path.join(root, 'node_modules', 'prisma', 'build', 'index.js'), '// synthetic\n');
  writeFileSync(path.join(root, 'node_modules', 'prisma', 'package.json'), JSON.stringify({ name: 'prisma', version: '7.10.0' }));
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ devDependencies: { prisma: '7.10.0' } }));
  mkdirSync(path.join(root, 'node_modules', '.bin'));
  symlinkSync(path.join(root, 'node_modules', 'prisma', 'build', 'index.js'), path.join(root, 'node_modules', '.bin', 'prisma'));
  writeFileSync(path.join(root, 'prisma.config.ts'), 'export default {}\n');
  const from = path.join(API_DIR, 'prisma', 'migrations');
  const to = path.join(root, 'prisma', 'migrations');
  mkdirSync(to, { recursive: true });
  for (const { name } of MIGRATION_PINS) cpSync(path.join(from, name), path.join(to, name), { recursive: true });
  cpSync(path.join(from, 'migration_lock.toml'), path.join(to, 'migration_lock.toml'));
  // The api schema lives next to the migrated tree; the tooling binding and the
  // staging copy both read and hash it.
  writeFileSync(path.join(root, 'prisma', 'schema.prisma'), 'mock schema the tooling binding hashes\n');
  return root;
}
const API = fakeApi();

// --- fake pg client: the pilot-marker --check protocol + the read-only snapshot ---
function canonicalFacts() {
  return {
    schemaOwnerIsCurrentUser: true,
    relations: [{ name: 'database_identity_pkey', kind: 'i' }, { name: 'database_identity', kind: 'r' }],
    table: { kind: 'r', persistence: 'p', isPartition: false, ofType: false, ownerIsCurrentUser: true, rowSecurity: false, forceRowSecurity: false, hasSubclass: false, parents: 0, children: 0, hasRules: false, triggers: 0 },
    columns: [
      { name: 'singleton', type: 'boolean', notNull: true, default: 'true', generated: '', identity: '', collation: null },
      { name: 'environment', type: 'text', notNull: true, default: null, generated: '', identity: '', collation: 'default' },
      { name: 'marker_id', type: 'uuid', notNull: true, default: null, generated: '', identity: '', collation: null },
      { name: 'installed_at', type: 'timestamp with time zone', notNull: true, default: 'now()', generated: '', identity: '', collation: null },
    ],
    constraints: [{ type: 'p', definition: 'PRIMARY KEY (singleton)' }, { type: 'c', definition: 'CHECK (singleton)' }, { type: 'c', definition: "CHECK ((environment = 'pilot'::text))" }],
  };
}
// `phases` = the database as each successive read-only snapshot sees it (pre, post, …).
function fakeDb({ phases, readOnly = 'on', snapshotMarker = MARKER, searchPath = 'pg_catalog, pg_temp' } = {}) {
  const sql = [];
  let snapshot = -1;
  const clients = [];
  const create = () => {
    const client = {
      connection: { stream: { encrypted: true, authorized: true } },
      async connect() {},
      async query(q) {
        const text = typeof q === 'string' ? q : q.text;
        sql.push(text);
        if (text.includes('to_regnamespace')) return { rows: [{ schema_exists: true, table_exists: true, test_guard_exists: false }] };
        if (text.includes('json_build_object')) return { rows: [{ facts: canonicalFacts() }] };
        if (text.startsWith('SELECT environment')) return { rows: [{ environment: 'pilot', marker_id: MARKER, has_installed_at: true }] };
        if (text === 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY') { snapshot += 1; return { rows: [] }; }
        const db = phases[Math.min(snapshot, phases.length - 1)] ?? {};
        if (text.includes("current_setting('transaction_read_only')")) return { rows: [{ read_only: readOnly }] };
        if (text.startsWith('SELECT marker_id::text AS marker_id')) return { rows: [{ marker_id: snapshotMarker, environment: 'pilot' }] };
        if (text.includes("to_regclass('public.\"_prisma_migrations\"')")) return { rows: [{ present: db.ledger !== null }] };
        if (text === LEDGER_SQL) return { rows: db.ledger ?? [] };
        if (text === PROJECTION_SQL.searchPath) return { rows: [{ search_path: searchPath }] };
        const key = Object.keys(PROJECTION_SQL).find((k) => PROJECTION_SQL[k] === text);
        if (key) return { rows: db.raw[key] };
        return { rows: [] };
      },
      async end() {},
    };
    clients.push(client);
    return client;
  };
  return { create, sql, snapshots: () => snapshot + 1 };
}

function fakeSpawn({ code = 0, onSpawn } = {}) {
  const spawned = [];
  const spawn = (command, args, options) => {
    spawned.push({ command, args, options });
    onSpawn?.();
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    setImmediate(() => { child.stdout.end(); child.stderr.end(); setImmediate(() => child.emit('close', code, null)); });
    return child;
  };
  return { spawn, spawned };
}

const payload = () => verifyMigrationPayload(API);
const dry = (state = 'EXACT_S4') => ['--target=pilot', '--dry-run', `--marker-id=${MARKER}`, `--expected-initial-state=${state}`];

async function run(argv, { db = fakeDb({ phases: [{ ledger: ledgerOf('EXACT_S4'), raw: RAW.EXACT_S4 }, { ledger: ledgerOf('EXACT_G11'), raw: RAW.EXACT_G11 }] }), spawner = fakeSpawn(), schema = SCHEMA } = {}) {
  const out = [];
  const created = [];
  const code = await main(argv, {
    apiDir: API, moduleDir: path.dirname(fileURLToPath(import.meta.url)),
    urlFile: '/nonexistent/synthetic/pilot-database-url',
    readUrlFile: () => ({ ok: true, text: `${URL_TEXT}\n` }), env: {},
    createClient: (conn) => { created.push(conn); return db.create(); },
    spawn: spawner.spawn, execPath: '/opt/synthetic/node/bin/node', home: '/home/synthetic', tmpdir: TMP,
    schema, log: (l) => out.push(l), error: (l) => out.push(l),
  });
  const text = out.join('\n');
  for (const leak of LEAKS) assert.ok(!text.includes(leak), `leaked ${leak}`);
  for (const q of db.sql) assert.ok(!FORBIDDEN_SQL.test(q) || q.startsWith('SELECT json_build_object('), `mutating SQL issued: ${q}`);
  return { code, text, created, spawned: spawner.spawned, db };
}

// G11-ADV-001: the plan binds target+tooling, so the digest comes from the tool's own
// dry run for this fixture (determinism is asserted by construction here).
async function planFor(state) {
  const r = await run(dry(state));
  assert.equal(r.code, 0, r.text);
  const found = /PLAN_DIGEST=([0-9a-f]{64})/.exec(r.text);
  assert.ok(found, `no PLAN_DIGEST for ${state}: ${r.text}`);
  return found[1];
}
const PLAN_S4 = await planFor('EXACT_S4');
const PLAN_G7 = await planFor('EXACT_G7');
const PLAN_G11 = await planFor('EXACT_G11');
const PLANS = { EXACT_S4: PLAN_S4, EXACT_G7: PLAN_G7, EXACT_G11: PLAN_G11 };
const exec = (state = 'EXACT_S4', plan = null) => ['--target=pilot', '--execute', `--marker-id=${MARKER}`, `--confirm-project-ref=${REF}`, `--expected-initial-state=${state}`, `--plan=${plan ?? PLANS[state]}`];

// --- payload ------------------------------------------------------------------------

test('MG-01 the approved payload is the exact G14 tree from the shared pins (14 migrations + lock)', () => {
  assert.deepEqual(APPROVED_MIGRATION_PAYLOAD.migrations, MIGRATION_PINS);
  assert.deepEqual(APPROVED_MIGRATION_PAYLOAD.lock, LOCK_PIN);
  const real = verifyMigrationPayload(API_DIR);
  assert.equal(real.ok, true, real.reason);
  assert.equal(real.migrations.length, 14);
});

// --- CLI ------------------------------------------------------------------------------

test('MG-02 the expected initial state is mandatory, explicit and only EXACT_S4 | EXACT_G7 | EXACT_G11; execute also needs a hex plan digest', () => {
  assert.deepEqual(parseCliArgs(dry('EXACT_S4')), { ok: true, mode: 'dry-run', markerId: MARKER, confirmProjectRef: null, initialState: 'EXACT_S4', plan: null });
  assert.equal(parseCliArgs(dry('EXACT_G7')).initialState, 'EXACT_G7');
  assert.equal(parseCliArgs(dry('EXACT_G11')).initialState, 'EXACT_G11');
  for (const argv of [
    ['--target=pilot', '--dry-run', `--marker-id=${MARKER}`],
    dry('EXACT_G12'), dry('EXACT_G13'), dry('EXACT_G14'), dry('G11'), dry('S4'), dry('G7'), dry(''), dry('exact_s4'), dry('exact_g11'),
    [...dry('EXACT_S4'), '--expected-initial-state=EXACT_G7'],
    exec('EXACT_S4', 'notahex'), ['--target=pilot', '--execute', `--marker-id=${MARKER}`, `--confirm-project-ref=${REF}`, '--expected-initial-state=EXACT_S4'],
    [...dry('EXACT_S4'), `--plan=${'a'.repeat(64)}`],
  ]) assert.equal(parseCliArgs(argv).ok, false, argv.join(' '));
});

// --- dry-run --------------------------------------------------------------------------

test('MG-03 dry-run states INITIAL_STATE, the exact migrations to apply, EXACT_G14 and the plan digest; no client, no child', async () => {
  for (const [state, pending, digest] of [['EXACT_S4', 10, PLAN_S4], ['EXACT_G7', 7, PLAN_G7], ['EXACT_G11', 3, PLAN_G11]]) {
    const r = await run(dry(state));
    assert.equal(r.code, 0, r.text);
    assert.equal(r.created.length, 0);
    assert.equal(r.spawned.length, 0);
    assert.match(r.text, new RegExp(`INITIAL_STATE=${state}`));
    assert.match(r.text, /FINAL_STATE=EXACT_G14/);
    assert.match(r.text, new RegExp(`migrations to apply: ${pending}`));
    for (const name of STATES.EXACT_G14.slice(STATES[state].length)) assert.ok(r.text.includes(name), name);
    assert.match(r.text, new RegExp(`PLAN_DIGEST=${digest}`));
  }
  assert.equal(new Set([PLAN_S4, PLAN_G7, PLAN_G11]).size, 3);
});

test('MG-04 a missing schema reference for the initial or final state refuses dry-run and execute', async () => {
  for (const missing of ['EXACT_S4', 'EXACT_G14']) {
    const schema = { ...SCHEMA, references: { ...SCHEMA.references, [missing]: undefined } };
    const r = await run(dry('EXACT_S4'), { schema });
    assert.notEqual(r.code, 0);
    assert.match(r.text, /phase=reference/);
  }
});

// --- execute: plan + pre-check ------------------------------------------------------------

test('MG-05 execute with a plan digest that is not the dry-run plan is refused before any client', async () => {
  for (const plan of [PLAN_G7, 'f'.repeat(64)]) {
    const r = await run(exec('EXACT_S4', plan));
    assert.notEqual(r.code, 0);
    assert.match(r.text, /phase=plan/);
    assert.equal(r.created.length, 0);
    assert.equal(r.spawned.length, 0);
  }
});

test('MG-06 the happy path: proof, read-only pre-check (exact initial state), ONE prisma deploy, read-only post-check (EXACT_G14)', async () => {
  for (const state of ['EXACT_S4', 'EXACT_G7', 'EXACT_G11']) {
    const db = fakeDb({ phases: [{ ledger: ledgerOf(state), raw: RAW[state] }, { ledger: ledgerOf('EXACT_G14'), raw: RAW.EXACT_G14 }] });
    const r = await run(exec(state), { db });
    assert.equal(r.code, 0, r.text);
    assert.equal(r.spawned.length, 1);
    assert.deepEqual(r.spawned[0].args.slice(1), ['migrate', 'deploy', '--config', 'prisma.config.ts']);
    assert.equal(db.snapshots(), 2);
    assert.match(r.text, new RegExp(`precheck ok — ledger ${state}`));
    assert.match(r.text, /postcheck ok — ledger EXACT_G14/);
    assert.match(r.text, /PILOT_MIGRATE_RESULT=EXACT_G14/);
  }
});

test('MG-07 the pre-check accepts ONLY the expected state: every other ledger is refused before Prisma', async () => {
  const pin = (i) => ({ migration_name: MIGRATION_PINS[i].name, checksum: MIGRATION_PINS[i].sha256, finished: true, rolled_back: false });
  const prefix = (n) => Array.from({ length: n }, (_, i) => pin(i));
  const cases = {
    'G7 while S4 expected': prefix(7), 'G5': prefix(5), 'G6': prefix(6), 'G8': prefix(8), 'G9': prefix(9), 'G10': prefix(10), 'G11': prefix(11), 'G12': prefix(12), 'G13': prefix(13), 'G14 while S4 expected': prefix(14),
    'empty': [], 'no ledger table': null,
    'partial (failed m4)': [...prefix(3), { ...pin(3), finished: false }],
    'rolled back': [...prefix(4), { ...pin(3), rolled_back: true }],
    'unknown migration': [...prefix(4), { migration_name: '20261019000000_extra', checksum: 'b'.repeat(64), finished: true, rolled_back: false }],
    'checksum drift': [...prefix(3), { ...pin(3), checksum: 'c'.repeat(64) }],
    'duplicate row': [...prefix(4), pin(0)],
  };
  for (const [label, ledger] of Object.entries(cases)) {
    const db = fakeDb({ phases: [{ ledger, raw: RAW.EXACT_S4 }] });
    const r = await run(exec('EXACT_S4'), { db });
    assert.notEqual(r.code, 0, label);
    assert.match(r.text, /phase=precheck/, label);
    assert.equal(r.spawned.length, 0, label);
  }
});

test('MG-08 an exact ledger whose schema is not the reference (e.g. G11 objects already present) is refused before Prisma', async () => {
  const intruder = rawCatalog(['Sale', 'SaleCheckout']);
  const db = fakeDb({ phases: [{ ledger: ledgerOf('EXACT_S4'), raw: intruder }] });
  const r = await run(exec('EXACT_S4'), { db });
  assert.notEqual(r.code, 0);
  assert.match(r.text, /phase=precheck — the app schema is not the EXACT_S4 reference/);
  assert.match(r.text, /PROBE_FAILED:absentTable:SaleCheckout/);
  assert.equal(r.spawned.length, 0);
});

test('MG-09 the pre-check snapshot must be read-only, pinned and on the same marker', async () => {
  for (const [label, db] of [
    ['not read-only', fakeDb({ phases: [{ ledger: ledgerOf('EXACT_S4'), raw: RAW.EXACT_S4 }], readOnly: 'off' })],
    ['marker changed', fakeDb({ phases: [{ ledger: ledgerOf('EXACT_S4'), raw: RAW.EXACT_S4 }], snapshotMarker: OTHER })],
    ['search_path not pinned', fakeDb({ phases: [{ ledger: ledgerOf('EXACT_S4'), raw: RAW.EXACT_S4 }], searchPath: '"$user", public' })],
  ]) {
    const r = await run(exec('EXACT_S4'), { db });
    assert.notEqual(r.code, 0, label);
    assert.match(r.text, /phase=precheck/, label);
    assert.equal(r.spawned.length, 0, label);
  }
});

// --- execute: post-check -----------------------------------------------------------------

test('MG-10 a post-check that is not exactly G14 reports RESTORE_REQUIRED and never repairs (one deploy, no resolve)', async () => {
  const pin = (i) => ({ migration_name: MIGRATION_PINS[i].name, checksum: MIGRATION_PINS[i].sha256, finished: true, rolled_back: false });
  const prefix = (n) => Array.from({ length: n }, (_, i) => pin(i));
  for (const [label, post] of [
    ['G13 only', { ledger: prefix(13), raw: RAW.EXACT_G13 }],
    ['G12 only', { ledger: prefix(12), raw: RAW.EXACT_G12 }],
    ['G10 only', { ledger: prefix(10), raw: RAW.EXACT_G11 }],
    ['failed m14', { ledger: [...prefix(13), { ...pin(13), finished: false }], raw: RAW.EXACT_G11 }],
    ['schema differs', { ledger: prefix(11), raw: RAW.EXACT_G7 }],
  ]) {
    const db = fakeDb({ phases: [{ ledger: ledgerOf('EXACT_S4'), raw: RAW.EXACT_S4 }, post] });
    const r = await run(exec('EXACT_S4'), { db });
    assert.notEqual(r.code, 0, label);
    assert.match(r.text, /phase=postcheck/, label);
    assert.match(r.text, /PILOT_MIGRATE_RESULT=RESTORE_REQUIRED/, label);
    assert.match(r.text, /never run `prisma migrate resolve`/, label);
    assert.equal(r.spawned.length, 1, label);
  }
});

test('MG-11 a failed prisma deploy reports RESTORE_REQUIRED after a read-only inspection; nothing is retried', async () => {
  const pin = (i) => ({ migration_name: MIGRATION_PINS[i].name, checksum: MIGRATION_PINS[i].sha256, finished: true, rolled_back: false });
  const db = fakeDb({ phases: [{ ledger: ledgerOf('EXACT_S4'), raw: RAW.EXACT_S4 }, { ledger: [...ledgerOf('EXACT_S4'), { ...pin(4), finished: false }], raw: RAW.EXACT_S4 }] });
  const r = await run(exec('EXACT_S4'), { db, spawner: fakeSpawn({ code: 1 }) });
  assert.notEqual(r.code, 0);
  assert.equal(r.spawned.length, 1);
  assert.match(r.text, /phase=prisma/);
  assert.match(r.text, /PILOT_MIGRATE_RESULT=RESTORE_REQUIRED/);
  assert.equal(db.snapshots(), 2, 'the post-failure state is read (read-only) for the report');
});

// --- EXACT_G11 initial state: partial G12/G13 ledgers ----------------------------------

test('MG-12 from EXACT_G11 a partial G12/G13 ledger (an interrupted earlier attempt) is refused before Prisma, never resumed', async () => {
  const pin = (i) => ({ migration_name: MIGRATION_PINS[i].name, checksum: MIGRATION_PINS[i].sha256, finished: true, rolled_back: false });
  const prefix = (n) => Array.from({ length: n }, (_, i) => pin(i));
  for (const [label, ledger, raw] of [
    ['G12', prefix(12), RAW.EXACT_G12],
    ['G13', prefix(13), RAW.EXACT_G13],
    ['failed m12', [...prefix(11), { ...pin(11), finished: false }], RAW.EXACT_G11],
    ['rolled-back m13', [...prefix(12), { ...pin(12), rolled_back: true }], RAW.EXACT_G12],
    ['G14 while G11 expected', prefix(14), RAW.EXACT_G14],
    ['G7 while G11 expected', prefix(7), RAW.EXACT_G7],
  ]) {
    const db = fakeDb({ phases: [{ ledger, raw }] });
    const r = await run(exec('EXACT_G11'), { db });
    assert.notEqual(r.code, 0, label);
    assert.match(r.text, /phase=precheck/, label);
    assert.equal(r.spawned.length, 0, label);
    assert.doesNotMatch(r.text, /PILOT_MIGRATE_RESULT=EXACT_G14/, label);
  }
});

test('MG-13 from EXACT_G11 a deploy that stops at G12/G13 reports RESTORE_REQUIRED (one deploy, no resolve)', async () => {
  const pin = (i) => ({ migration_name: MIGRATION_PINS[i].name, checksum: MIGRATION_PINS[i].sha256, finished: true, rolled_back: false });
  const prefix = (n) => Array.from({ length: n }, (_, i) => pin(i));
  for (const [label, post, code] of [
    ['post G12', { ledger: prefix(12), raw: RAW.EXACT_G12 }, 0],
    ['post G13', { ledger: prefix(13), raw: RAW.EXACT_G13 }, 0],
    ['failed m13', { ledger: [...prefix(12), { ...pin(12), finished: false }], raw: RAW.EXACT_G12 }, 1],
    ['failed m14', { ledger: [...prefix(13), { ...pin(13), finished: false }], raw: RAW.EXACT_G13 }, 1],
  ]) {
    const db = fakeDb({ phases: [{ ledger: ledgerOf('EXACT_G11'), raw: RAW.EXACT_G11 }, post] });
    const r = await run(exec('EXACT_G11'), { db, spawner: fakeSpawn({ code }) });
    assert.notEqual(r.code, 0, label);
    assert.match(r.text, /precheck ok — ledger EXACT_G11/, label);
    assert.match(r.text, code === 0 ? /phase=postcheck/ : /phase=prisma/, label);
    assert.match(r.text, /PILOT_MIGRATE_RESULT=RESTORE_REQUIRED/, label);
    assert.equal(r.spawned.length, 1, label);
  }
});
