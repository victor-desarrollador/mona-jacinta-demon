// Zero-database unit tests for scripts/database/restore.mjs (TEST-only, DEV-free).
// Run with: node --test scripts/database/restore.test.mjs
// Config is synthetic (*.invalid); pg_restore, row counts, prisma migrate status and
// the TEST marker-proof pg client are injected fakes; artifacts live in throwaway
// temp directories. Nothing opens a socket.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main, parseRestoreArgs } from './restore.mjs';
import { buildBackupManifest, LIST_CONN, openVerifiedBackup } from './lib.mjs';

const REF = 'syntheticref0000000a';
const SECRET = 'S3cretPassw0rd';
const HOST = 'aws-0-synthetic.pooler.invalid';
const TEST_URL = `postgresql://postgres.${REF}:${SECRET}@${HOST}:5432/postgres`;
const DEV_URL = 'postgresql://postgres.devref00000000000000:DevPassw0rd@dev-host.pooler.invalid:5432/postgres';
const LEAKS = [SECRET, HOST, REF, `postgres.${REF}`, TEST_URL, 'DevPassw0rd', 'dev-host', 'devref'];
const MARKER = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const OTHER_MARKER = '0f8fad5b-d9cb-469f-a165-70867728950e';
const ENV = `TEST_DATABASE_URL=${TEST_URL}\nTEST_DATABASE_MARKER_ID=${MARKER}\n`;
const NAME = 'test_drill_20260925T120000Z.dump';
const COUNTS = { User: 1, Branch: 2 };
const TOC = ['3401; 0 16391 TABLE DATA public User postgres', '3402; 0 16392 TABLE DATA public Branch postgres'].join('\n');
const archive = (toc = TOC) => `ARCHIVE:${toc}`;

async function fakeList(bin, args, conn) {
  assert.deepEqual(conn, LIST_CONN);
  const content = readFileSync(args[1], 'utf8');
  if (!content.startsWith('ARCHIVE:')) throw new Error('pg_restore: error: input file does not appear to be a valid archive');
  return { stdout: content.slice('ARCHIVE:'.length) };
}

let dir;
let snapRoot;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'mona-restore-test-'));
  snapRoot = mkdtempSync(path.join(os.tmpdir(), 'mona-restore-snap-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(snapRoot, { recursive: true, force: true });
});

function writeSet(name = NAME, { dump = archive(), counts = COUNTS, dumpForManifest = dump } = {}) {
  const p = path.join(dir, name);
  writeFileSync(p, dump);
  writeFileSync(`${p}.manifest.json`, buildBackupManifest({
    setId: '0b6f2c1e-8a4d-4e6f-9b2a-1c3d5e7f9a0b',
    createdAt: '2026-09-25T12:00:00.000Z',
    purpose: 'drill',
    file: name,
    bytes: Buffer.byteLength(dumpForManifest),
    sha256: createHash('sha256').update(dumpForManifest).digest('hex'),
    counts,
  }));
  return p;
}

// Canonical live marker catalog facts (same shape the installer verifies).
function canonicalFacts() {
  return {
    schemaOwnerIsCurrentUser: true,
    relations: [
      { name: 'database_identity_pkey', kind: 'i' },
      { name: 'database_identity', kind: 'r' },
    ],
    table: { kind: 'r', ownerIsCurrentUser: true, rowSecurity: false, forceRowSecurity: false, hasSubclass: false, parents: 0, children: 0, hasRules: false, triggers: 0 },
    columns: [
      { name: 'singleton', type: 'boolean', notNull: true, default: 'true', generated: '', identity: '' },
      { name: 'environment', type: 'text', notNull: true, default: null, generated: '', identity: '' },
      { name: 'marker_id', type: 'uuid', notNull: true, default: null, generated: '', identity: '' },
      { name: 'installed_at', type: 'timestamp with time zone', notNull: true, default: 'now()', generated: '', identity: '' },
    ],
    constraints: [
      { type: 'p', definition: 'PRIMARY KEY (singleton)' },
      { type: 'c', definition: 'CHECK (singleton)' },
      { type: 'c', definition: "CHECK ((environment = 'test'::text))" },
    ],
  };
}

// Fake pg client for the in-process marker proof. It answers the proof's reads
// from `marker` and records every statement, connection field and lifecycle call.
function fakeMarkerClient(record, conn, {
  facts = canonicalFacts(),
  rows = [{ environment: 'test', marker_id: MARKER, has_installed_at: true }],
  authorized = true,
  failOn = null,
  connectError = null,
  rollback = 'ok',
  end = 'ok',
} = {}) {
  record.conn = conn;
  record.sql = [];
  record.ended = 0;
  return {
    connection: { stream: { encrypted: authorized, authorized } },
    async connect() {
      if (connectError) throw connectError;
    },
    async query(q) {
      const text = typeof q === 'string' ? q : q.text;
      record.sql.push(text);
      if (text === 'ROLLBACK' && rollback === 'reject') throw Object.assign(new Error(`rollback failed ${TEST_URL} ${SECRET}`), { code: '08006' });
      if (failOn && failOn.match.test(text)) throw failOn.error;
      if (text.includes('to_regnamespace')) return { rows: [{ schema_exists: true, table_exists: true }] };
      if (text.includes('json_build_object')) return { rows: [{ facts }] };
      if (text.startsWith('SELECT environment')) return { rows };
      return { rows: [] };
    },
    end() {
      record.ended += 1;
      if (end === 'reject') return Promise.reject(Object.assign(new Error(`close failed ${TEST_URL} ${HOST} ${SECRET}`), { code: 'ECONNRESET' }));
      if (end === 'throw') throw Object.assign(new Error(`close threw ${TEST_URL} ${SECRET}`), { code: 'ECONNRESET' });
      if (end === 'non-error') return Promise.reject(`close string ${TEST_URL} ${SECRET}`);
      return Promise.resolve();
    },
  };
}

function makeDeps(overrides = {}, marker = {}) {
  const calls = [];
  const out = [];
  const markerRecord = {};
  return {
    calls,
    out,
    markerRecord,
    readEnvText: () => ENV,
    createMarkerClient: (conn) => {
      calls.push({ step: 'marker', host: conn.host });
      return fakeMarkerClient(markerRecord, conn, marker);
    },
    openBackup: (file) => {
      calls.push({ step: 'openBackup' });
      return openVerifiedBackup(file, { runPgTool: fakeList, tmpRoot: snapRoot });
    },
    runPgTool: async (bin, args, conn) => {
      calls.push({ step: bin, args, host: conn.host, database: conn.database, snapshotContent: readFileSync(args.at(-1), 'utf8') });
      return { stdout: '' };
    },
    tableRowCounts: async (conn, tables) => {
      calls.push({ step: 'counts', host: conn.host, tables });
      return { ...COUNTS };
    },
    migrateStatus: (url) => {
      calls.push({ step: 'migrate', isTestUrl: url === TEST_URL });
      return 'Database schema is up to date!';
    },
    log: (line) => out.push(line),
    error: (line) => out.push(line),
    ...overrides,
  };
}

const ARGS = (file) => ['--target=test', `--file=${file}`, `--confirm-project-ref=${REF}`];
const text = (deps) => deps.out.join('\n');
function assertNoLeak(value) {
  for (const leak of LEAKS) assert.ok(!value.includes(leak), `leaked ${JSON.stringify(leak)}`);
}
const steps = (deps) => deps.calls.map((c) => c.step);

// --- arguments ---------------------------------------------------------------

test('parse: strict TEST-only arguments, never echoed', () => {
  assert.deepEqual(parseRestoreArgs(ARGS('x.dump')), { ok: true, file: 'x.dump', confirmProjectRef: REF });
  const bad = [
    ['--target=demo', '--file=x.dump', `--confirm-project-ref=${REF}`],
    ['--target=demo', '--target=test', '--file=x.dump', `--confirm-project-ref=${REF}`],
    ['--target=test', '--target=test', '--file=x.dump', `--confirm-project-ref=${REF}`],
    ['--target=test', `--confirm-project-ref=${REF}`],
    ['--target=test', '--file=', `--confirm-project-ref=${REF}`],
    ['--target=test', '--file=x.dump'],
    [...ARGS('x.dump'), `--url=${TEST_URL}`],
    [...ARGS('x.dump'), TEST_URL],
    [...ARGS('x.dump'), '--clean'],
  ];
  for (const argv of bad) {
    const parsed = parseRestoreArgs(argv);
    assert.equal(parsed.ok, false, argv.join(' '));
    assertNoLeak(parsed.error);
  }
});

// --- H2: DEV-free --------------------------------------------------------------

test('H2: restore succeeds with DATABASE_URL absent, malformed or poisoned, touching only TEST', async () => {
  for (const devLine of ['', 'DATABASE_URL=not a url\n', `DATABASE_URL=${DEV_URL}\n`]) {
    const p = writeSet();
    const deps = makeDeps({ readEnvText: () => `${devLine}${ENV}` });
    assert.equal(await main(ARGS(p), deps), 0, text(deps));
    assert.deepEqual(steps(deps), ['openBackup', 'marker', 'pg_restore', 'counts', 'migrate']);
    for (const call of deps.calls.filter((c) => c.host !== undefined)) assert.equal(call.host, HOST);
    assert.equal(deps.calls.find((c) => c.step === 'migrate').isTestUrl, true);
    assert.ok(!text(deps).includes('DATABASE_URL'));
    assertNoLeak(text(deps));
    rmSync(p);
    rmSync(`${p}.manifest.json`);
  }
});

test('H2: restore source never imports check-databases / proveIdentities and never reads DATABASE_URL', () => {
  const source = readFileSync(fileURLToPath(new URL('./restore.mjs', import.meta.url)), 'utf8');
  const code = source.split('\n').filter((line) => !line.trimStart().startsWith('//')).join('\n');
  assert.ok(!/check-databases/.test(code));
  assert.ok(!/proveIdentities/.test(code));
  assert.ok(!/loadEnvFile/.test(code));
  // The only DATABASE_URL occurrence is the explicit TEST assignment for the prisma child.
  assert.deepEqual(code.match(/DATABASE_URL[^_]/g), ['DATABASE_URL:']);
  assert.match(code, /env: \{ \.\.\.process\.env, DATABASE_URL: testUrl \}/);
});

// --- preconditions before any database work ------------------------------------

test('config / attestation failures stop before the backup is even opened', async () => {
  const p = writeSet();
  for (const env of ['', `TEST_DATABASE_URL=${TEST_URL}?sslmode=disable\nTEST_DATABASE_MARKER_ID=${MARKER}\n`, `DATABASE_URL=${DEV_URL}\n`]) {
    const deps = makeDeps({ readEnvText: () => env });
    assert.equal(await main(ARGS(p), deps), 1);
    assert.match(text(deps), /phase=config/);
    assert.deepEqual(deps.calls, []);
  }
  const deps = makeDeps();
  assert.equal(await main(['--target=test', `--file=${p}`, '--confirm-project-ref=otherref000000000000'], deps), 1);
  assert.match(text(deps), /phase=target/);
  assert.deepEqual(deps.calls, []);
  assertNoLeak(text(deps));
});

// --- verified input only ---------------------------------------------------------

test('unverifiable archives are refused before pg_restore touches TEST', async () => {
  const cases = [
    writeSet('test_drill_20260925T120001Z.dump', { dump: 'PGDMP arbitrary bytes' }),
    writeSet('test_drill_20260925T120002Z.dump', { dump: archive(`${TOC}\n5; 2615 16390 SCHEMA - mona_test_guard postgres`) }),
    writeSet('test_drill_20260925T120003Z.dump', { dumpForManifest: archive(`${TOC}\n`) }),
    writeSet('test_drill_20260925T120004Z.dump', { counts: { User: 1 } }),
  ];
  for (const p of cases) {
    const deps = makeDeps();
    assert.equal(await main(ARGS(p), deps), 1, p);
    assert.match(text(deps), /phase=verify/);
    assert.deepEqual(steps(deps), ['openBackup']);
  }
  const legacy = path.join(dir, 'test_drill_20260925T120005Z.dump');
  writeFileSync(legacy, archive());
  writeFileSync(`${legacy}.sha256`, `${createHash('sha256').update(archive()).digest('hex')}  ${path.basename(legacy)}\n`);
  writeFileSync(`${legacy}.counts.json`, JSON.stringify(COUNTS));
  const deps = makeDeps();
  assert.equal(await main(ARGS(legacy), deps), 1);
  assert.match(text(deps), /phase=verify/);
  assert.deepEqual(readdirSync(snapRoot), []);
});

test('pg_restore restores the verified snapshot into TEST with the original flags', async () => {
  const p = writeSet();
  const deps = makeDeps();
  assert.equal(await main(ARGS(p), deps), 0, text(deps));
  const restore = deps.calls.find((c) => c.step === 'pg_restore');
  assert.deepEqual(restore.args.slice(0, -1), ['--format=custom', '--no-owner', '--no-acl', '--clean', '--if-exists', '--exit-on-error', '--single-transaction', '--dbname', 'postgres']);
  assert.ok(restore.args.at(-1).startsWith(snapRoot), 'must restore from the private snapshot');
  assert.notEqual(restore.args.at(-1), p);
  assert.equal(restore.snapshotContent, archive());
  assert.deepEqual(deps.calls.find((c) => c.step === 'counts').tables, Object.keys(COUNTS));
  assert.deepEqual(readdirSync(snapRoot), [], 'snapshot disposed');
});

test('post-verification substitution of the original cannot change what is restored', async () => {
  const p = writeSet();
  const deps = makeDeps({
    runPgTool: async (bin, args, conn) => {
      writeFileSync(p, 'SWAPPED AFTER VERIFICATION');
      deps.calls.push({ step: bin, content: readFileSync(args.at(-1), 'utf8'), host: conn.host });
      return { stdout: '' };
    },
  });
  assert.equal(await main(ARGS(p), deps), 0, text(deps));
  assert.equal(deps.calls.find((c) => c.step === 'pg_restore').content, archive());
});

// --- post-restore verification and redaction -----------------------------------

test('failures after restore are reported with redaction and the snapshot is disposed', async () => {
  const p = writeSet();
  const leakyError = new Error(`pg_restore: error: connection to server at "${HOST}" user "postgres.${REF}" password ${SECRET} tenant ${REF} failed`);
  const scenarios = [
    [{ runPgTool: async () => { throw leakyError; } }, 'restore'],
    [{ tableRowCounts: async () => ({ User: 1, Branch: 3 }) }, 'counts'],
    [{ tableRowCounts: async () => { throw new Error(`count failed ${TEST_URL}`); } }, 'counts'],
    [{ migrateStatus: () => `Following migration have not yet been applied on ${HOST} for postgres.${REF}` }, 'migrate'],
    [{ migrateStatus: () => { throw Object.assign(new Error('x'), { stderr: Buffer.from(`P1001 ${TEST_URL}`) }); } }, 'migrate'],
  ];
  for (const [overrides, phase] of scenarios) {
    const deps = makeDeps(overrides);
    assert.equal(await main(ARGS(p), deps), 1, phase);
    assert.match(text(deps), new RegExp(`phase=${phase}`));
    assertNoLeak(text(deps));
    assert.deepEqual(readdirSync(snapRoot), []);
  }
});

// --- live TEST marker proof before any destructive step -------------------------

const DESTRUCTIVE_SQL = /\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|TRUNCATE|GRANT|REVOKE|COMMIT)\b/i;

test('M1/M16: the live TEST marker is proven read-only, after artifact verification and before pg_restore', async () => {
  const p = writeSet();
  const deps = makeDeps();
  assert.equal(await main(ARGS(p), deps), 0, text(deps));
  assert.deepEqual(steps(deps), ['openBackup', 'marker', 'pg_restore', 'counts', 'migrate']);
  const { sql, conn, ended } = deps.markerRecord;
  assert.equal(sql[0], 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.equal(sql[1], 'SET LOCAL search_path TO pg_catalog, pg_temp');
  const lock = sql.findIndex((q) => /LOCK TABLE mona_test_guard\.database_identity IN ACCESS SHARE MODE/.test(q));
  const firstSelect = sql.findIndex((q) => q.startsWith('SELECT'));
  assert.ok(lock > 1 && lock < firstSelect, 'ACCESS SHARE is taken before the first snapshot-taking SELECT');
  assert.equal(sql.at(-1), 'ROLLBACK');
  for (const q of sql) assert.ok(!DESTRUCTIVE_SQL.test(q.replace(/'[^']*'/g, '')), `non-read-only statement in the proof: ${q.slice(0, 60)}`);
  assert.equal(ended, 1, 'proof connection closed');
  assert.deepEqual(
    { host: conn.host, user: conn.user, database: conn.database, port: conn.port },
    { host: HOST, user: `postgres.${REF}`, database: 'postgres', port: '5432' },
  );
  assert.match(text(deps), /identity: owner project-ref attestation \+ live TEST marker proof/);
  assertNoLeak(text(deps));
});

test('M2/M3/M4/M8/M10/M15: a marker that is not exactly the pinned canonical TEST marker stops before pg_restore', async () => {
  const facts = canonicalFacts();
  const withTrigger = { ...facts, table: { ...facts.table, triggers: 1 } };
  const extraColumn = { ...facts, columns: [...facts.columns, { name: 'x', type: 'text', notNull: false, default: null, generated: '', identity: '' }] };
  const cases = {
    'M2 different marker id': { rows: [{ environment: 'test', marker_id: OTHER_MARKER, has_installed_at: true }] },
    'M3 no marker row': { rows: [] },
    'M4 extra trigger': { facts: withTrigger },
    'M4 extra column': { facts: extraColumn },
    'M8 two rows': { rows: [{ environment: 'test', marker_id: MARKER, has_installed_at: true }, { environment: 'test', marker_id: MARKER, has_installed_at: true }] },
    'M10 non-test environment': { rows: [{ environment: 'dev', marker_id: MARKER, has_installed_at: true }] },
    'M15 unverified TLS': { authorized: false },
  };
  for (const [label, marker] of Object.entries(cases)) {
    const p = writeSet();
    const deps = makeDeps({}, marker);
    assert.equal(await main(ARGS(p), deps), 1, label);
    assert.match(text(deps), /phase=marker/, label);
    assert.match(text(deps), /nothing was restored/, label);
    assert.deepEqual(steps(deps), ['openBackup', 'marker'], `${label}: pg_restore must never be spawned`);
    assert.equal(deps.markerRecord.ended, 1, `${label}: proof connection closed`);
    assert.ok(!text(deps).includes(OTHER_MARKER), label);
    assertNoLeak(text(deps));
    assert.deepEqual(readdirSync(snapRoot), [], `${label}: snapshot disposed`);
    rmSync(p);
    rmSync(`${p}.manifest.json`);
  }
});

test('M7/M12: proof errors fail closed with a sanitized code, never the error text', async () => {
  const leaky = (code) => Object.assign(new Error(`FATAL for ${TEST_URL} at ${HOST} password ${SECRET}`), { code });
  const cases = {
    'permission denied on LOCK': [{ failOn: { match: /^LOCK/, error: leaky('42501') } }, 'code=42501'],
    'marker absent (undefined_table)': [{ failOn: { match: /^LOCK/, error: leaky('42P01') } }, /TEST identity marker is not installed/],
    'marker schema absent': [{ failOn: { match: /^LOCK/, error: leaky('3F000') } }, /TEST identity marker is not installed/],
    'connect refused': [{ connectError: leaky('ECONNREFUSED') }, 'code=ECONNREFUSED'],
    // '0000000' is a literal substring of the synthetic tenant ref, so printing it would leak part of it.
    'code hidden in a secret': [{ connectError: leaky('0000000') }, 'code=unexpected'],
    'no code': [{ failOn: { match: /json_build_object/, error: new Error(`boom ${TEST_URL}`) } }, 'code=unexpected'],
  };
  for (const [label, [marker, expected]] of Object.entries(cases)) {
    const p = writeSet();
    const deps = makeDeps({}, marker);
    assert.equal(await main(ARGS(p), deps), 1, label);
    assert.match(text(deps), /phase=marker/, label);
    if (typeof expected === 'string') assert.ok(text(deps).includes(expected), `${label}: ${text(deps)}`);
    else assert.match(text(deps), expected, label);
    assert.deepEqual(steps(deps), ['openBackup', 'marker'], `${label}: pg_restore must never be spawned`);
    assert.equal(deps.markerRecord.ended, 1, `${label}: proof connection closed`);
    assertNoLeak(text(deps));
    assert.ok(!/FATAL|boom|password/.test(text(deps)), `${label}: error text leaked`);
    rmSync(p);
    rmSync(`${p}.manifest.json`);
  }
});

test('M6: a missing or non-canonical pinned TEST_DATABASE_MARKER_ID stops before the artifact or TEST is touched', async () => {
  const p = writeSet();
  for (const markerLine of ['', 'TEST_DATABASE_MARKER_ID=\n', `TEST_DATABASE_MARKER_ID=${MARKER.toUpperCase()}\n`, 'TEST_DATABASE_MARKER_ID=6d1e3f5a-2b4c-1d6e-8f0a-1b2c3d4e5f60\n']) {
    const deps = makeDeps({ readEnvText: () => `TEST_DATABASE_URL=${TEST_URL}\n${markerLine}` });
    assert.equal(await main(ARGS(p), deps), 1, JSON.stringify(markerLine));
    assert.match(text(deps), /phase=config/);
    assert.match(text(deps), /TEST_DATABASE_MARKER_ID/);
    assert.deepEqual(deps.calls, [], 'neither the artifact nor TEST is touched');
    assertNoLeak(text(deps));
  }
});

test('M5/M9/M11: attestation and artifact failures stop before any marker client is created', async () => {
  const p = writeSet();
  const wrongRef = makeDeps();
  assert.equal(await main(['--target=test', `--file=${p}`, '--confirm-project-ref=otherref000000000000'], wrongRef), 1);
  assert.match(text(wrongRef), /phase=target/);
  assert.deepEqual(wrongRef.calls, []);
  const legacy = path.join(dir, 'test_drill_20260925T120009Z.dump');
  writeFileSync(legacy, archive());
  writeFileSync(`${legacy}.sha256`, `${createHash('sha256').update(archive()).digest('hex')}  ${path.basename(legacy)}\n`);
  writeFileSync(`${legacy}.counts.json`, JSON.stringify(COUNTS));
  const bad = writeSet('test_drill_20260925T120010Z.dump', { dump: 'PGDMP arbitrary bytes' });
  for (const file of [legacy, bad]) {
    const deps = makeDeps();
    assert.equal(await main(ARGS(file), deps), 1);
    assert.match(text(deps), /phase=verify/);
    assert.deepEqual(steps(deps), ['openBackup'], 'no marker client, no pg_restore');
  }
});

test('M14: a poisoned DATABASE_URL never reaches the marker proof connection', async () => {
  const p = writeSet();
  const deps = makeDeps({ readEnvText: () => `DATABASE_URL=${DEV_URL}\n${ENV}` });
  const saved = process.env.DATABASE_URL;
  process.env.DATABASE_URL = DEV_URL;
  try {
    assert.equal(await main(ARGS(p), deps), 0, text(deps));
  } finally {
    if (saved === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = saved;
  }
  assert.equal(deps.markerRecord.conn.host, HOST);
  assert.ok(!JSON.stringify(deps.markerRecord.conn).includes('dev'));
});

// --- proof cleanup must be confirmed before pg_restore --------------------------------

const pgRestoreCount = (deps) => steps(deps).filter((x) => x === 'pg_restore').length;

test('C1/C2/C3/C11 (P1): a successful proof whose connection close fails refuses before pg_restore', async () => {
  for (const end of ['reject', 'throw', 'non-error']) {
    const p = writeSet();
    const deps = makeDeps({}, { end });
    assert.equal(await main(ARGS(p), deps), 1, `${end}: ${text(deps)}`);
    assert.equal(pgRestoreCount(deps), 0, `${end}: pg_restore must never run`);
    assert.match(text(deps), /phase=marker/);
    assert.match(text(deps), /proof connection could not be closed/);
    assert.match(text(deps), /nothing was restored/);
    assert.ok(!/close failed|close threw|close string/.test(text(deps)), `${end}: raw close error leaked`);
    assertNoLeak(text(deps));
    assert.deepEqual(readdirSync(snapRoot), []);
    rmSync(p);
    rmSync(`${p}.manifest.json`);
  }
});

test('C6/C11 (P2): a successful proof whose ROLLBACK fails refuses before pg_restore', async () => {
  const p = writeSet();
  const deps = makeDeps({}, { rollback: 'reject' });
  assert.equal(await main(ARGS(p), deps), 1, text(deps));
  assert.equal(pgRestoreCount(deps), 0);
  assert.match(text(deps), /phase=marker/);
  assert.match(text(deps), /could not be rolled back/);
  assert.equal(deps.markerRecord.ended, 1, 'the connection is still closed');
  assert.ok(!/rollback failed/.test(text(deps)));
  assertNoLeak(text(deps));
});

test('C4/C5/C14: the primary proof failure stays authoritative over close/ROLLBACK failures', async () => {
  const facts = canonicalFacts();
  const primary = Object.assign(new Error(`denied ${TEST_URL}`), { code: '42501' });
  const cases = {
    'C4 wrong id + close rejects': [{ rows: [{ environment: 'test', marker_id: OTHER_MARKER, has_installed_at: true }], end: 'reject' }, /different marker id/],
    'C4b wrong id + ROLLBACK and close fail': [{ rows: [{ environment: 'test', marker_id: OTHER_MARKER, has_installed_at: true }], rollback: 'reject', end: 'throw' }, /different marker id/],
    'C5 LOCK error + close rejects': [{ failOn: { match: /^LOCK/, error: primary }, end: 'reject' }, /code=42501/],
    'C5b LOCK error + ROLLBACK and close fail': [{ failOn: { match: /^LOCK/, error: primary }, rollback: 'reject', end: 'non-error' }, /code=42501/],
    'C14 malformed marker + cleanup fails': [{ facts: { ...facts, table: { ...facts.table, triggers: 1 } }, rollback: 'reject', end: 'reject' }, /rules or triggers/],
    'TLS failure + close rejects': [{ authorized: false, end: 'reject' }, /verified TLS is required/],
  };
  for (const [label, [marker, reason]] of Object.entries(cases)) {
    const p = writeSet();
    const deps = makeDeps({}, marker);
    assert.equal(await main(ARGS(p), deps), 1, label);
    assert.equal(pgRestoreCount(deps), 0, label);
    assert.match(text(deps), reason, `${label}: ${text(deps)}`);
    assert.ok(!/could not be closed|could not be rolled back/.test(text(deps)), `${label}: cleanup failure masked the primary failure`);
    assertNoLeak(text(deps));
    rmSync(p);
    rmSync(`${p}.manifest.json`);
  }
});

test('C12/C13: sequential restores with clean proofs each proceed; a failed-cleanup run does not taint the next', async () => {
  const p = writeSet();
  const bad = makeDeps({}, { end: 'reject' });
  assert.equal(await main(ARGS(p), bad), 1);
  for (let i = 0; i < 2; i += 1) {
    const ok = makeDeps();
    assert.equal(await main(ARGS(p), ok), 0, text(ok));
    assert.equal(pgRestoreCount(ok), 1);
    assert.equal(ok.markerRecord.sql.at(-1), 'ROLLBACK');
    assert.equal(ok.markerRecord.ended, 1);
  }
});

// --- post-outcome snapshot cleanup never replaces or misstates the restore outcome -------
//
// The production dispose (lib.mjs verifyBackupPair `release`) is synchronous: its
// rmSync can throw synchronously. These tests make the real dispose run (so the
// snapshot is removed) and then throw, carrying a path, URL and ref.
function throwingDispose(mode = 'error') {
  const record = { disposes: 0 };
  const openBackup = async (file) => {
    const handle = await openVerifiedBackup(file, { runPgTool: fakeList, tmpRoot: snapRoot });
    if (!handle.ok) return handle;
    const real = handle.dispose;
    handle.dispose = () => {
      record.disposes += 1;
      real();
      if (mode === 'string') throw `EACCES rm ${snapRoot}/mona-backup-verify-x ${TEST_URL}`;
      throw Object.assign(new Error(`EACCES: permission denied, rmdir '${snapRoot}/mona-backup-verify-x' ${TEST_URL} ${REF}`), { code: 'EACCES' });
    };
    return handle;
  };
  return { record, openBackup };
}
async function restoreRun(overrides, marker) {
  const deps = makeDeps(overrides, marker);
  let code;
  try {
    code = await main(ARGS(writeSet()), deps);
  } catch (err) {
    assert.fail(`main() must resolve; a cleanup exception escaped: ${String(err?.message ?? err).slice(0, 30)}`);
  }
  const out = text(deps);
  assertNoLeak(out);
  assert.ok(!/EACCES|permission denied|mona-backup-verify/.test(out), 'raw cleanup error or path leaked');
  return { code, deps, out };
}
const SNAPSHOT_WARNING = /WARNING: the private verified snapshot could not be removed \(path not shown\); the restore outcome above is unchanged/;

test('V1/V7/V8/V14: a completed restore stays successful when snapshot cleanup throws', async () => {
  for (const mode of ['error', 'string']) {
    const { record, openBackup } = throwingDispose(mode);
    const { code, deps, out } = await restoreRun({ openBackup });
    assert.equal(code, 0, `${mode}: ${out}`);
    assert.match(out, /\[db:restore\] OK/);
    assert.equal(pgRestoreCount(deps), 1, 'pg_restore ran exactly once');
    assert.match(out, SNAPSHOT_WARNING);
    assert.ok(!/nothing was restored/.test(out));
    assert.equal(record.disposes, 1, 'cleanup exactly once');
  }
});

test('V2/V5/V6: a post-pg_restore failure stays authoritative and never claims nothing was restored', async () => {
  const cases = {
    'V2 pg_restore failed': [{ runPgTool: async () => { throw new Error('pg_restore: exited 1'); } }, /phase=restore/, 1],
    'V5 counts failed': [{ tableRowCounts: async () => { throw new Error('count failed'); } }, /phase=counts/, 1],
    'V6 migrate failed': [{ migrateStatus: () => 'Following migrations have not yet been applied' }, /phase=migrate/, 1],
  };
  for (const [label, [overrides, phase, restores]] of Object.entries(cases)) {
    const { record, openBackup } = throwingDispose();
    const { code, deps, out } = await restoreRun({ ...overrides, openBackup });
    assert.equal(code, 1, label);
    assert.match(out, phase, `${label}: ${out}`);
    assert.ok(!/nothing was restored/.test(out), `${label}: pg_restore may have run; must not claim nothing was restored`);
    assert.match(out, SNAPSHOT_WARNING, label);
    assert.equal(record.disposes, 1, label);
    if (label.startsWith('V5') || label.startsWith('V6')) assert.equal(pgRestoreCount(deps), restores, label);
  }
});

test('V4: a marker failure stays authoritative (truthfully nothing restored) when cleanup throws', async () => {
  const { record, openBackup } = throwingDispose();
  const { code, deps, out } = await restoreRun({ openBackup }, { rows: [] });
  assert.equal(code, 1);
  assert.match(out, /phase=marker — marker table does not hold exactly one row; nothing was restored/);
  assert.equal(pgRestoreCount(deps), 0);
  assert.match(out, SNAPSHOT_WARNING);
  assert.equal(record.disposes, 1);
});

test('V15: a restore after a cleanup failure is independent and clean', async () => {
  const { openBackup } = throwingDispose();
  await restoreRun({ openBackup });
  const { code, out } = await restoreRun({});
  assert.equal(code, 0, out);
  assert.ok(!/WARNING/.test(out));
});

test('V14: the snapshot is disposed exactly once per run, on success and on failure', async () => {
  const cases = { success: [{}, 0], 'marker failure': [{}, 1, { rows: [] }], 'counts failure': [{ tableRowCounts: async () => { throw new Error('x'); } }, 1] };
  for (const [label, [overrides, expectedCode, marker]] of Object.entries(cases)) {
    let disposes = 0;
    const openBackup = async (file) => {
      const handle = await openVerifiedBackup(file, { runPgTool: fakeList, tmpRoot: snapRoot });
      const real = handle.dispose;
      handle.dispose = () => {
        disposes += 1;
        real();
      };
      return handle;
    };
    const { code } = await restoreRun({ ...overrides, openBackup }, marker);
    assert.equal(code, expectedCode, label);
    assert.equal(disposes, 1, `${label}: disposed ${disposes} times`);
    assert.deepEqual(readdirSync(snapRoot), [], label);
  }
});
