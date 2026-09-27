// Zero-database unit tests for scripts/database/pilot-migrate.mjs.
// Run with: node --test scripts/database/pilot-migrate.test.mjs
// Hermetic: synthetic *.invalid URLs, an injected fake pg client, an injected fake
// spawn (no child process is ever started), and a throwaway fake `api/` tree in a
// temp directory. The real private PILOT files are never read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  API_DIR, APPROVED_MIGRATION_PAYLOAD, PRISMA_ARGS, buildChildEnv, createRedactor, main, parseCliArgs, readPinned, resolvePrismaCli,
  verifyMigrationPayload,
} from './pilot-migrate.mjs';
import { createVerifiedClient, parsePilotUrl, readPrivateUrlFile } from './pilot-marker.mjs';

const MARKER = '2b4d6f81-7a9c-4e0b-8d2f-3c5e7a9b1d0f';
const OTHER = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const REF = 'pilotsynthref0000001';
const REF_B = 'othersynthref0000002';
const SECRET = 'Mig5ecretPw';
const USER = `postgres.${REF}`;
const HOST = 'aws-0-synthetic.pooler.invalid';
const URL_TEXT = `postgresql://${USER}:${SECRET}@${HOST}:6543/postgres`;
const LEAKS = [SECRET, HOST, REF, USER, URL_TEXT, `${HOST}:6543`, os.homedir()];
const HOSTILE_URL = 'postgresql://postgres.hostileref00000000x:hostilepw@dev-hostile.invalid:5432/postgres';

const DRY = ['--target=pilot', '--dry-run', `--marker-id=${MARKER}`];
const EXECUTE = ['--target=pilot', '--execute', `--marker-id=${MARKER}`, `--confirm-project-ref=${REF}`];
const FORBIDDEN_SQL = /\b(DROP|TRUNCATE|DELETE|UPDATE|ALTER|GRANT|REVOKE|CREATE|INSERT|COMMIT)\b/i;

function assertNoLeak(text) {
  for (const leak of LEAKS) assert.ok(!text.includes(leak), `output leaked ${JSON.stringify(leak)}`);
}

// --- fake api/ tree ----------------------------------------------------------

const TMP = mkdtempSync(path.join(os.tmpdir(), 'pilot-migrate-test-'));
process.on('exit', () => rmSync(TMP, { recursive: true, force: true }));
let fixtureCount = 0;
function fakeApi({ bin = 'link', version = '7.10.0', pinned = '7.10.0', config = 'file', pkgName = 'prisma' } = {}) {
  const root = path.join(TMP, `api-${fixtureCount++}`);
  const pkg = path.join(root, 'node_modules', 'prisma');
  mkdirSync(path.join(pkg, 'build'), { recursive: true });
  mkdirSync(path.join(root, 'node_modules', '.bin'), { recursive: true });
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ devDependencies: { prisma: pinned } }));
  writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: pkgName, version }));
  writeFileSync(path.join(pkg, 'build', 'index.js'), '#!/usr/bin/env node\n');
  const binPath = path.join(root, 'node_modules', '.bin', 'prisma');
  if (bin === 'link') symlinkSync('../prisma/build/index.js', binPath);
  if (bin === 'outside') {
    const elsewhere = path.join(TMP, `global-prisma-${fixtureCount}`);
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(path.join(elsewhere, 'index.js'), '#!/usr/bin/env node\n');
    symlinkSync(path.join(elsewhere, 'index.js'), binPath);
  }
  if (bin === 'file') writeFileSync(binPath, '#!/bin/sh\n');
  const configPath = path.join(root, 'prisma.config.ts');
  if (config === 'file') writeFileSync(configPath, 'export default {}\n');
  if (config === 'symlink') {
    const other = path.join(TMP, `other-config-${fixtureCount}.ts`);
    writeFileSync(other, 'export default {}\n');
    symlinkSync(other, configPath);
  }
  // Byte-exact copy of the real approved migrations tree (read-only source).
  cpSync(path.join(API_DIR, 'prisma', 'migrations'), path.join(root, 'prisma', 'migrations'), { recursive: true });
  return root;
}
const API = fakeApi();

// --- fake pg client speaking the --check protocol -----------------------------

function canonicalFacts() {
  return {
    schemaOwnerIsCurrentUser: true,
    relations: [{ name: 'database_identity_pkey', kind: 'i' }, { name: 'database_identity', kind: 'r' }],
    table: {
      kind: 'r', persistence: 'p', isPartition: false, ofType: false, ownerIsCurrentUser: true, rowSecurity: false,
      forceRowSecurity: false, hasSubclass: false, parents: 0, children: 0, hasRules: false, triggers: 0,
    },
    columns: [
      { name: 'singleton', type: 'boolean', notNull: true, default: 'true', generated: '', identity: '', collation: null },
      { name: 'environment', type: 'text', notNull: true, default: null, generated: '', identity: '', collation: 'default' },
      { name: 'marker_id', type: 'uuid', notNull: true, default: null, generated: '', identity: '', collation: null },
      { name: 'installed_at', type: 'timestamp with time zone', notNull: true, default: 'now()', generated: '', identity: '', collation: null },
    ],
    constraints: [
      { type: 'p', definition: 'PRIMARY KEY (singleton)' },
      { type: 'c', definition: 'CHECK (singleton)' },
      { type: 'c', definition: "CHECK ((environment = 'pilot'::text))" },
    ],
  };
}
const row = (environment, markerId) => ({ environment, marker_id: markerId, has_installed_at: true });
const CANONICAL = { schemaExists: true, tableExists: true, testGuardExists: false, facts: canonicalFacts(), rows: [row('pilot', MARKER)] };

function secretError(label) {
  const err = new Error(`${label} ${URL_TEXT}`);
  Object.assign(err, { code: '28P01', detail: `password ${SECRET} for ${USER}`, hint: `host ${HOST}`, cause: new Error(URL_TEXT) });
  err.stack = `Error: ${URL_TEXT}\n    at ${HOST}`;
  return err;
}

function fakeClient({ state = CANONICAL, authorized = true, connectError, failOn, order, onQuery, onEnd } = {}) {
  const calls = [];
  const sql = [];
  return {
    calls,
    sql,
    connection: { stream: { encrypted: authorized, authorized } },
    async connect() {
      calls.push('CONNECT');
      if (connectError) throw connectError;
    },
    async query(q) {
      const text = typeof q === 'string' ? q : q.text;
      onQuery?.(text);
      sql.push(text);
      calls.push(text.trim().split(/\s+/).slice(0, 3).join(' '));
      if (failOn && text.includes(failOn)) throw secretError('query failed');
      if (text.startsWith('LOCK TABLE') && !state.tableExists) {
        throw Object.assign(new Error(URL_TEXT), { code: state.schemaExists ? '42P01' : '3F000' });
      }
      if (text.includes('to_regnamespace')) {
        return { rows: [{ schema_exists: state.schemaExists, table_exists: state.tableExists, test_guard_exists: state.testGuardExists }] };
      }
      if (text.includes('json_build_object')) return { rows: [{ facts: state.facts }] };
      if (text.startsWith('SELECT environment')) return { rows: state.rows };
      return { rows: [] };
    },
    async end() {
      calls.push('END');
      order?.push('proof-end');
      onEnd?.();
    },
  };
}

// --- fake spawn ----------------------------------------------------------------

function fakeSpawn({ code = 0, signal = null, stdout = [], stderr = [], emitError, throwSync, errorThenClose, onSpawn, order } = {}) {
  const spawned = [];
  const spawn = (command, args, options) => {
    spawned.push({ command, args, options });
    order?.push('spawn');
    onSpawn?.({ command, args, options });
    if (throwSync) throw Object.assign(new Error(`spawn failed ${URL_TEXT}`), { code: 'EACCES' });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    setImmediate(() => {
      if (emitError) {
        child.emit('error', Object.assign(new Error(`spawn ${command} ENOENT ${URL_TEXT}`), { code: 'ENOENT' }));
        if (!errorThenClose) return;
      }
      for (const chunk of stdout) child.stdout.write(chunk);
      for (const chunk of stderr) child.stderr.write(chunk);
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit('close', code, signal));
    });
    return child;
  };
  return { spawn, spawned };
}

async function run(argv, opts = {}) {
  const out = [];
  const created = [];
  const reads = [];
  const client = opts.client ?? fakeClient({ order: opts.order });
  const spawner = opts.spawner ?? fakeSpawn({ order: opts.order });
  const deps = {
    apiDir: opts.apiDir ?? API,
    urlFile: opts.urlFile ?? '/nonexistent/synthetic/pilot-database-url',
    readUrlFile: (file) => {
      reads.push(file);
      if (opts.readUrlFile) return opts.readUrlFile(file);
      return opts.fileResult ?? { ok: true, text: opts.urlText ?? `${URL_TEXT}\n` };
    },
    env: opts.env ?? {},
    createClient: (conn) => {
      created.push(conn);
      return client;
    },
    spawn: spawner.spawn,
    execPath: '/opt/synthetic/node/bin/node',
    home: '/home/synthetic',
    tmpdir: '/tmp/synthetic',
    log: (line) => out.push(line),
    error: (line) => out.push(line),
  };
  const code = await main(argv, deps);
  for (const q of client.sql ?? []) assert.ok(!FORBIDDEN_SQL.test(q) || q.startsWith('SELECT json_build_object('), `mutating SQL issued: ${q}`);
  return { code, text: out.join('\n'), out, created, reads, client, spawned: spawner.spawned };
}

// --- CLI -------------------------------------------------------------------------

test('parse: the two canonical invocations', () => {
  assert.deepEqual(parseCliArgs(DRY), { ok: true, mode: 'dry-run', markerId: MARKER, confirmProjectRef: null });
  assert.deepEqual(parseCliArgs(EXECUTE), { ok: true, mode: 'execute', markerId: MARKER, confirmProjectRef: REF });
});

test('M1-M4/M6/M8: every non-canonical CLI fails closed without echoing values', () => {
  const bad = [
    [], ['--dry-run', `--marker-id=${MARKER}`],
    ['--target=test', '--dry-run', `--marker-id=${MARKER}`],
    ['--target=dev', '--dry-run', `--marker-id=${MARKER}`],
    ['--target=PILOT', '--dry-run', `--marker-id=${MARKER}`],
    ['--target=pilot ', '--dry-run', `--marker-id=${MARKER}`],
    ['--Target=pilot', '--dry-run', `--marker-id=${MARKER}`],
    ['--target', 'pilot', '--dry-run', `--marker-id=${MARKER}`],
    ['--target=pilot', '--dry-run', '--dry-run', `--marker-id=${MARKER}`],
    ['--target=pilot', '--dry-run', '--execute', `--marker-id=${MARKER}`, `--confirm-project-ref=${REF}`],
    ['--target=pilot', '--check', `--marker-id=${MARKER}`],
    ['--target=pilot', '--dry-run', `--marker-id=${MARKER}`, `--marker-id=${MARKER}`],
    ['--target=pilot', '--dry-run', `--marker-id=${MARKER.toUpperCase()}`],
    ['--target=pilot', '--dry-run', '--marker-id=5c7e2a91-3b4d-1f6a-9c8e-0d1f2a3b4c5d'],
    ['--target=pilot', '--dry-run', `--marker-id={${MARKER}}`],
    ['--target=pilot', '--dry-run', `--marker-id=${MARKER}';--`],
    ['--target=pilot', '--execute', `--marker-id=${MARKER}`],
    ['--target=pilot', '--execute', `--marker-id=${MARKER}`, `--confirm-project-ref=${REF.toUpperCase()}`],
    ['--target=pilot', '--execute', `--marker-id=${MARKER}`, `--confirm-project-ref=${REF} `],
    ['--target=pilot', '--dry-run', `--marker-id=${MARKER}`, `--confirm-project-ref=${REF}`],
    ['--target=pilot', '--dry-run', `--marker-id=${MARKER}`, '--schema=other.prisma'],
    ['--target=pilot', '--dry-run', `--marker-id=${MARKER}`, `--url=${URL_TEXT}`],
    ['--target=pilot', '--dry-run', `--marker-id=${MARKER}`, 'migrate', 'reset'],
  ];
  for (const argv of bad) {
    const parsed = parseCliArgs(argv);
    assert.equal(parsed.ok, false, argv.join(' '));
    assertNoLeak(parsed.error);
    assert.ok(!parsed.error.includes('hostile'));
  }
});

test('M1: an invalid CLI touches nothing', async () => {
  const r = await run(['--target=test', '--execute', `--marker-id=${MARKER}`, `--confirm-project-ref=${REF}`]);
  assert.equal(r.code, 1);
  assert.match(r.text, /phase=args/);
  assert.equal(r.reads.length, 0);
  assert.equal(r.created.length, 0);
  assert.equal(r.spawned.length, 0);
});

// --- repository-local Prisma CLI -------------------------------------------------------

test('resolvePrismaCli: the real repository resolves to its pinned local Prisma (files only, nothing run)', () => {
  const real = resolvePrismaCli(API_DIR);
  assert.equal(real.ok, true, real.reason);
  assert.equal(real.cwd, realpathSync(API_DIR));
  assert.equal(real.script, realpathSync(path.join(API_DIR, 'node_modules', 'prisma', 'build', 'index.js')));
  assert.equal(real.version, '7.10.0');
});

test('M20-M22/M24: missing, foreign, unpinned or symlinked Prisma inputs are refused', () => {
  for (const [label, api] of Object.entries({
    'M20 .bin/prisma missing': fakeApi({ bin: 'none' }),
    'M21 .bin/prisma resolves outside the local package': fakeApi({ bin: 'outside' }),
    'M21 .bin/prisma is a standalone file': fakeApi({ bin: 'file' }),
    'M22 version differs from the pin': fakeApi({ version: '7.9.0' }),
    'M22 pin is a range': fakeApi({ pinned: '^7.10.0' }),
    'M22 package is not prisma': fakeApi({ pkgName: 'not-prisma' }),
    'M24 prisma.config.ts missing': fakeApi({ config: 'none' }),
    'M24 prisma.config.ts is a symlink': fakeApi({ config: 'symlink' }),
  })) {
    assert.equal(resolvePrismaCli(api).ok, false, label);
  }
});

test('M20: execute and dry-run both refuse without a verified local Prisma, before any client', async () => {
  for (const argv of [DRY, EXECUTE]) {
    const r = await run(argv, { apiDir: fakeApi({ bin: 'none' }) });
    assert.equal(r.code, 1);
    assert.match(r.text, /phase=prisma/);
    assert.equal(r.created.length, 0);
    assert.equal(r.spawned.length, 0);
  }
});

// --- dry-run ---------------------------------------------------------------------

test('M38: dry-run opens no client, spawns nothing, and prints the sanitized plan', async () => {
  const r = await run(DRY);
  assert.equal(r.code, 0, r.text);
  assert.equal(r.created.length, 0);
  assert.equal(r.spawned.length, 0);
  assert.equal(r.reads.length, 1);
  for (const needle of [
    /target: PILOT/, /private URL file: accepted/, new RegExp(`marker id: ${MARKER}`), /project identity: derivable/,
    /Prisma CLI: repository-local prisma 7\.10\.0/, /cwd: api\//, /command: prisma migrate deploy --config prisma\.config\.ts/,
    /identity proof: mandatory during --execute/, /no database connection was opened/i, /no migration was executed/i,
    /explicit OWNER approval/,
  ]) assert.match(r.text, needle);
  assertNoLeak(r.text);
});

test('dry-run: an underivable project identity is reported (execute would refuse)', async () => {
  const r = await run(DRY, { urlText: `postgresql://postgres:${SECRET}@${HOST}:6543/postgres` });
  assert.equal(r.code, 0);
  assert.match(r.text, /project identity: NOT derivable/);
  assertNoLeak(r.text);
});

// --- private URL file ------------------------------------------------------------

test('M10/M41: missing, insecure or malformed URL file fails before any client, even with DATABASE_URL set', async () => {
  for (const opts of [
    { fileResult: { ok: false, reason: 'private URL file is missing' } },
    { fileResult: { ok: false, reason: 'private URL file must not be a symlink' } },
    { urlText: `${URL_TEXT}?sslmode=disable` },
  ]) {
    for (const argv of [DRY, EXECUTE]) {
      const r = await run(argv, { ...opts, env: { DATABASE_URL: HOSTILE_URL, TEST_DATABASE_URL: HOSTILE_URL } });
      assert.equal(r.code, 1);
      assert.match(r.text, /phase=config/);
      assert.equal(r.created.length, 0);
      assert.equal(r.spawned.length, 0);
      assert.ok(!r.text.includes('hostile'));
    }
  }
});

test('M10: real private-file checks apply (symlink / 0640 refused)', async () => {
  const dir = mkdtempSync(path.join(TMP, 'urlfile-'));
  const real = path.join(dir, 'real');
  writeFileSync(real, `${URL_TEXT}\n`);
  chmodSync(real, 0o600);
  const link = path.join(dir, 'link');
  symlinkSync(real, link);
  const loose = path.join(dir, 'loose');
  writeFileSync(loose, `${URL_TEXT}\n`);
  chmodSync(loose, 0o640);
  for (const file of [link, loose]) {
    const r = await run(EXECUTE, { urlFile: file, readUrlFile: readPrivateUrlFile });
    assert.equal(r.code, 1, file);
    assert.match(r.text, /phase=config/);
    assert.equal(r.spawned.length, 0);
  }
});

test('M9: the URL file is read exactly once; a replacement after the read is never used', async () => {
  const dir = mkdtempSync(path.join(TMP, 'urlfile-'));
  const file = path.join(dir, 'pilot-database-url');
  writeFileSync(file, `${URL_TEXT}\n`);
  chmodSync(file, 0o600);
  const replacement = 'postgresql://postgres.swappedref0000000000:swappedpw@swapped.invalid:5432/postgres\n';
  const client = fakeClient();
  const origQuery = client.query.bind(client);
  // Swap the file on disk mid-proof and again at spawn time.
  client.query = async (q) => {
    writeFileSync(file, replacement);
    return origQuery(q);
  };
  const spawner = fakeSpawn({ onSpawn: () => writeFileSync(file, replacement) });
  const r = await run(EXECUTE, { urlFile: file, readUrlFile: readPrivateUrlFile, client, spawner });
  assert.equal(r.code, 0, r.text);
  assert.equal(r.reads.length, 1);
  assert.equal(r.spawned[0].options.env.DATABASE_URL, URL_TEXT);
  assert.deepEqual(r.created, [parsePilotUrl(URL_TEXT).conn]);
});

// --- project ref ------------------------------------------------------------------

test('M7: wrong project confirmation fails before any client or child, without printing refs', async () => {
  const argv = EXECUTE.map((a) => (a.startsWith('--confirm-project-ref=') ? `--confirm-project-ref=${REF_B}` : a));
  const r = await run(argv);
  assert.equal(r.code, 1);
  assert.match(r.text, /phase=target/);
  assert.equal(r.created.length, 0);
  assert.equal(r.spawned.length, 0);
  assert.ok(!r.text.includes(REF_B));
  assertNoLeak(r.text);
});

test('M7: an underivable project identity fails execute before any client', async () => {
  const r = await run(EXECUTE, { urlText: `postgresql://postgres:${SECRET}@${HOST}:6543/postgres` });
  assert.equal(r.code, 1);
  assert.match(r.text, /phase=target/);
  assert.equal(r.created.length, 0);
});

// --- identity proof ---------------------------------------------------------------------

test('M45: identity is proven by the audited --check path before Prisma is spawned', async () => {
  const order = [];
  const r = await run(EXECUTE, { order });
  assert.equal(r.code, 0, r.text);
  assert.equal(r.client.sql[0], 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.ok(r.client.sql.includes('LOCK TABLE mona_pilot_guard.database_identity IN ACCESS SHARE MODE'));
  assert.equal(r.client.sql.at(-1), 'ROLLBACK');
  // M37: the proof connection is closed before the child starts.
  assert.deepEqual(order, ['proof-end', 'spawn']);
});

test('M5/M25-M28: every failed identity proof stops before Prisma', async () => {
  const cases = {
    'M5 different marker id installed': { client: fakeClient({ state: { ...CANONICAL, rows: [row('pilot', OTHER)] } }) },
    'M25 marker absent (no schema)': { client: fakeClient({ state: { schemaExists: false, tableExists: false, testGuardExists: false, rows: [] } }) },
    'M25 marker absent (no table)': { client: fakeClient({ state: { schemaExists: true, tableExists: false, testGuardExists: false, rows: [] } }) },
    'M26 non-canonical structure': { client: fakeClient({ state: { ...CANONICAL, facts: { ...canonicalFacts(), relations: [...canonicalFacts().relations, { name: 'x', kind: 'r' }] } } }) },
    'M26 wrong environment': { client: fakeClient({ state: { ...CANONICAL, rows: [row('test', MARKER)] } }) },
    'M27 TEST marker present': { client: fakeClient({ state: { ...CANONICAL, testGuardExists: true } }) },
    'M28 TLS unauthorized': { client: fakeClient({ authorized: false }) },
  };
  for (const [label, opts] of Object.entries(cases)) {
    const r = await run(EXECUTE, opts);
    assert.equal(r.code, 1, label);
    assert.match(r.text, /phase=identity/, label);
    assert.equal(r.spawned.length, 0, label);
    assert.doesNotMatch(r.text, /migrations applied|SUCCESS/i, label);
    assert.ok(!r.text.includes(OTHER), label);
    assertNoLeak(r.text);
  }
});

test('M29/M30: connect and query errors carrying secrets (message/detail/hint/cause/stack) stay sanitized', async () => {
  for (const client of [fakeClient({ connectError: secretError('connect') }), fakeClient({ failOn: 'json_build_object' })]) {
    const r = await run(EXECUTE, { client });
    assert.equal(r.code, 1);
    assert.equal(r.spawned.length, 0);
    assertNoLeak(r.text);
  }
});

test('M16: hostile PGOPTIONS fails closed before any client or child', async () => {
  const r = await run(EXECUTE, { env: { PGOPTIONS: '-c search_path=hostile' } });
  assert.equal(r.code, 1);
  assert.equal(r.created.length, 0);
  assert.equal(r.spawned.length, 0);
  assert.ok(!r.text.includes('hostile'));
});

// --- child process binding ----------------------------------------------------------------

const HOSTILE_ENV = {
  DATABASE_URL: HOSTILE_URL, TEST_DATABASE_URL: HOSTILE_URL, TEST_DATABASE_MARKER_ID: OTHER, DIRECT_URL: HOSTILE_URL,
  SHADOW_DATABASE_URL: HOSTILE_URL, PGHOST: 'hostile.invalid', PGPORT: '1', PGUSER: 'hostile', PGPASSWORD: 'hostile',
  PGDATABASE: 'hostile', PGSERVICE: 'hostile', PGSERVICEFILE: '/hostile', PGSSLMODE: 'disable', PGSSLROOTCERT: '/hostile',
  PGAPPNAME: 'hostile', PGPASSFILE: '/hostile', NODE_OPTIONS: '--require /hostile.js', NODE_TLS_REJECT_UNAUTHORIZED: '0',
  NODE_EXTRA_CA_CERTS: '/hostile.pem', NODE_PATH: '/hostile', DEBUG: '*', DOTENV_KEY: 'hostile', DOTENV_CONFIG_PATH: '/hostile',
  DOTENV_CONFIG_OVERRIDE: 'true', PRISMA_SCHEMA_ENGINE_BINARY: '/hostile', PRISMA_ENGINES_MIRROR: 'http://hostile.invalid',
  PRISMA_CLI_BINARY_TARGETS: 'hostile', HTTPS_PROXY: 'http://hostile.invalid', HTTP_PROXY: 'http://hostile.invalid',
  PATH: '/hostile/bin:/usr/bin', HOME: '/hostile-home', NODE_ENV: 'development', LD_PRELOAD: '/hostile.so',
};

test('M11-M15/M17-M19/M23/M44: hostile parent env never reaches the proof or Prisma; child env is exactly the allowlist', async () => {
  const r = await run(EXECUTE, { env: HOSTILE_ENV });
  assert.equal(r.code, 0, r.text);
  assert.deepEqual(r.created, [parsePilotUrl(URL_TEXT).conn]);
  const [{ command, args, options }] = r.spawned;
  assert.deepEqual(options.env, {
    PATH: '/opt/synthetic/node/bin:/usr/local/bin:/usr/bin:/bin',
    HOME: '/home/synthetic',
    TMPDIR: '/tmp/synthetic',
    NODE_ENV: 'production',
    DATABASE_URL: URL_TEXT,
    CHECKPOINT_DISABLE: '1',
    PRISMA_HIDE_UPDATE_MESSAGE: '1',
  });
  for (const value of Object.values(options.env)) assert.ok(!value.includes('hostile'));
  // Binding invariant: Prisma's URL denotes exactly the connection the proof used.
  assert.deepEqual(parsePilotUrl(options.env.DATABASE_URL).conn, r.created[0]);
  assert.equal(command, '/opt/synthetic/node/bin/node');
  assert.ok(path.isAbsolute(args[0]));
});

test('buildChildEnv: allowlist only, ignores the parent environment entirely', () => {
  const saved = process.env.DATABASE_URL;
  process.env.DATABASE_URL = HOSTILE_URL;
  try {
    const env = buildChildEnv(URL_TEXT, { execPath: '/x/bin/node', home: '/h', tmpdir: '/t' });
    assert.deepEqual(Object.keys(env).sort(), ['CHECKPOINT_DISABLE', 'DATABASE_URL', 'HOME', 'NODE_ENV', 'PATH', 'PRISMA_HIDE_UPDATE_MESSAGE', 'TMPDIR']);
    assert.equal(env.DATABASE_URL, URL_TEXT);
    assert.equal(env.NODE_ENV, 'production');
  } finally {
    if (saved === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = saved;
  }
});

test('M39/M40/M42: exactly one argv-array child: node <verified prisma script> migrate deploy --config prisma.config.ts, in api/', async () => {
  const r = await run(EXECUTE);
  assert.equal(r.spawned.length, 1);
  const [{ command, args, options }] = r.spawned;
  const resolved = resolvePrismaCli(API);
  assert.equal(command, '/opt/synthetic/node/bin/node');
  assert.deepEqual(args, [resolved.script, 'migrate', 'deploy', '--config', 'prisma.config.ts']);
  assert.deepEqual([...PRISMA_ARGS], ['migrate', 'deploy', '--config', 'prisma.config.ts']);
  assert.equal(options.cwd, realpathSync(API));
  assert.ok(options.shell === undefined || options.shell === false);
  assert.ok(!args.some((a) => /seed|reset|push|\bdev\b|--force|--accept-data-loss/.test(a)));
  assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
});

// --- child outcome -------------------------------------------------------------------------

test('M32-M34: the failure reason names what actually happened', async () => {
  for (const [spawner, reason] of [
    [fakeSpawn({ code: 3 }), /prisma exited with code 3; migrations may be partially applied/],
    [fakeSpawn({ code: null, signal: 'SIGKILL' }), /prisma was terminated by SIGKILL/],
    [fakeSpawn({ code: 0, signal: 'SIGTERM' }), /prisma was terminated by SIGTERM/],
    [fakeSpawn({ code: null, signal: null }), /prisma exit status is unavailable/],
    [fakeSpawn({ throwSync: true }), /prisma could not be started; nothing was applied/],
  ]) {
    const r = await run(EXECUTE, { spawner });
    assert.equal(r.code, 1);
    assert.match(r.text, reason);
  }
});

test('M36: success only on an observed zero exit', async () => {
  const r = await run(EXECUTE, { spawner: fakeSpawn({ code: 0, stdout: ['All migrations have been successfully applied.\n'] }) });
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /OK — prisma migrate deploy exited 0/);
});

test('M31-M35: spawn failure, nonzero exit, signal, unknown status and error-then-close all fail', async () => {
  const cases = {
    'M31 spawn throws': fakeSpawn({ throwSync: true }),
    'M31 spawn error event': fakeSpawn({ emitError: true }),
    'M32 exit 1': fakeSpawn({ code: 1 }),
    'M32 exit 3': fakeSpawn({ code: 3 }),
    'M33 SIGKILL': fakeSpawn({ code: null, signal: 'SIGKILL' }),
    'M33 SIGTERM with code 0': fakeSpawn({ code: 0, signal: 'SIGTERM' }),
    'M34 no code, no signal': fakeSpawn({ code: null, signal: null }),
    'M35 error then close 0': fakeSpawn({ emitError: true, errorThenClose: true, code: 0 }),
  };
  for (const [label, spawner] of Object.entries(cases)) {
    const r = await run(EXECUTE, { spawner });
    assert.equal(r.code, 1, label);
    assert.match(r.text, /phase=prisma/, label);
    assert.doesNotMatch(r.text, /\[db:pilot-migrate\] OK/, label);
    assert.equal(r.spawned.length, 1, `${label}: never retried`);
    assertNoLeak(r.text);
  }
});

test('M43: Prisma output is redacted line by line, including secrets split across chunks', async () => {
  const stdout = [
    `Datasource "db": PostgreSQL database "postgres", schema "public" at "${HOST}:6543"\n`,
    `url ${URL_TEXT.slice(0, 20)}`, `${URL_TEXT.slice(20)} done\n`,
    `pw ${SECRET.slice(0, 4)}`, `${SECRET.slice(4)}\n`,
    `user ${USER} ref ${REF}\n`,
    'trailing line without newline ', `${SECRET}`,
  ];
  const stderr = [`Error: P1001: Can't reach database server at \`${HOST}\`:\`6543\`\n`];
  const r = await run(EXECUTE, { spawner: fakeSpawn({ code: 1, stdout, stderr }) });
  assert.equal(r.code, 1);
  assertNoLeak(r.text);
  assert.match(r.text, /Datasource "db": PostgreSQL database "postgres", schema "public" at "«redacted»"/);
  assert.match(r.text, /trailing line without newline «redacted»/);
});

test('createRedactor: longest secrets first, all occurrences, encoded password too', () => {
  const pw = 'p@ss/word';
  const url = `postgresql://${USER}:${encodeURIComponent(pw)}@${HOST}:6543/postgres`;
  const redact = createRedactor(url);
  const out = redact(`${url} | ${pw} | ${encodeURIComponent(pw)} | ${HOST} | ${USER} | ${REF} | ok`);
  for (const s of [pw, encodeURIComponent(pw), HOST, USER, REF]) assert.ok(!out.includes(s), s);
  assert.match(out, /\| ok$/);
});

// --- pilot-marker export used for the proof ------------------------------------------------------

test('M46: createVerifiedClient builds a TLS-verified, discrete-field pg client (constructed, never connected)', () => {
  const conn = parsePilotUrl(URL_TEXT).conn;
  const client = createVerifiedClient(conn);
  const p = client.connectionParameters;
  assert.equal(p.host, HOST);
  assert.equal(p.port, 6543);
  assert.equal(p.user, USER);
  assert.equal(p.database, 'postgres');
  assert.equal(p.ssl.rejectUnauthorized, true);
  assert.match(p.ssl.ca, /BEGIN CERTIFICATE/);
  assert.equal(p.ssl.servername, HOST);
  assert.equal(client._connectionTimeoutMillis, 10000);
});

// --- H1: the exact OWNER-approved migration payload is bound ----------------------------------

const migDir = (api) => path.join(api, 'prisma', 'migrations');
const NAMES = APPROVED_MIGRATION_PAYLOAD.migrations.map((m) => m.name);
const sqlOf = (api, i) => path.join(migDir(api), NAMES[i], 'migration.sql');
const lockOf = (api) => path.join(migDir(api), 'migration_lock.toml');
const flipByte = (file) => {
  const bytes = readFileSync(file);
  bytes[bytes.length - 2] ^= 0x01;
  writeFileSync(file, bytes);
};
const outside = (label) => mkdtempSync(path.join(TMP, `outside-${label}-`));

test('H1/P30: the pinned manifest is self-consistent and in Prisma (lexicographic) order', () => {
  assert.deepEqual(NAMES, [
    '20260907015311_init',
    '20260912182432_add_company_location',
    '20260912191702_add_user_role_scope',
    '20260922210000_d3_initial_stock_and_global_audit',
  ]);
  assert.deepEqual([...NAMES].sort(), NAMES);
  for (const m of APPROVED_MIGRATION_PAYLOAD.migrations) assert.match(m.sha256, /^[0-9a-f]{64}$/);
  assert.match(APPROVED_MIGRATION_PAYLOAD.lock.sha256, /^[0-9a-f]{64}$/);
  assert.equal(APPROVED_MIGRATION_PAYLOAD.lock.provider, 'postgresql');
  assert.ok(Object.isFrozen(APPROVED_MIGRATION_PAYLOAD) && Object.isFrozen(APPROVED_MIGRATION_PAYLOAD.migrations));
});

test('H1/P27: the real repository payload verifies against the pinned digests (files only)', () => {
  const result = verifyMigrationPayload(API_DIR);
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(result.migrations.map((m) => [m.name, m.sha256]), APPROVED_MIGRATION_PAYLOAD.migrations.map((m) => [m.name, m.sha256]));
  assert.equal(result.lock.sha256, APPROVED_MIGRATION_PAYLOAD.lock.sha256);
});

test('H1/P1: dry-run validates the payload and prints the names, digests and PASS lines', async () => {
  const r = await run(DRY);
  assert.equal(r.code, 0, r.text);
  assert.equal(r.created.length, 0);
  assert.equal(r.spawned.length, 0);
  assert.match(r.text, /migration payload: PASS — exactly 4 OWNER-approved migrations, SHA-256 approval binding active/);
  for (const m of APPROVED_MIGRATION_PAYLOAD.migrations) assert.ok(r.text.includes(`${m.name}  sha256 ${m.sha256}`), m.name);
  assert.match(r.text, new RegExp(`migration_lock\\.toml: PASS \\(provider "postgresql", sha256 ${APPROVED_MIGRATION_PAYLOAD.lock.sha256}\\)`));
  assertNoLeak(r.text);
});

const PAYLOAD_MUTATIONS = {
  'P2 fifth migration directory': (api) => {
    mkdirSync(path.join(migDir(api), '20260930000000_extra'));
    writeFileSync(path.join(migDir(api), '20260930000000_extra', 'migration.sql'), 'SELECT 1;\n');
  },
  'P3 first migration missing': (api) => rmSync(path.join(migDir(api), NAMES[0]), { recursive: true }),
  'P4 middle migration missing': (api) => rmSync(path.join(migDir(api), NAMES[2]), { recursive: true }),
  'P5 migration renamed': (api) => renameSync(path.join(migDir(api), NAMES[1]), path.join(migDir(api), '20260912182432_add_company_locations')),
  'P6 case drift': (api) => renameSync(path.join(migDir(api), NAMES[0]), path.join(migDir(api), '20260907015311_Init')),
  'P7 order drift (earlier timestamp, same content)': (api) =>
    renameSync(path.join(migDir(api), NAMES[1]), path.join(migDir(api), '20260901000000_add_company_location')),
  'P8 one-byte SQL mutation': (api) => flipByte(sqlOf(api, 1)),
  'P9 appended SQL comment': (api) => appendFileSync(sqlOf(api, 3), '-- harmless?\n'),
  'P10 empty migration.sql': (api) => writeFileSync(sqlOf(api, 2), ''),
  'P11 migration.sql symlink to an identical copy': (api) => {
    const copy = path.join(outside('sql'), 'migration.sql');
    cpSync(sqlOf(api, 0), copy);
    rmSync(sqlOf(api, 0));
    symlinkSync(copy, sqlOf(api, 0));
  },
  'P12 migration dir symlink to an identical copy': (api) => {
    const copy = path.join(outside('dir'), NAMES[3]);
    cpSync(path.join(migDir(api), NAMES[3]), copy, { recursive: true });
    rmSync(path.join(migDir(api), NAMES[3]), { recursive: true });
    symlinkSync(copy, path.join(migDir(api), NAMES[3]));
  },
  'P16 lock one-byte mutation': (api) => flipByte(lockOf(api)),
  'P16b lock comment byte mutation (provider still valid)': (api) => {
    const bytes = readFileSync(lockOf(api));
    bytes[3] ^= 0x01;
    writeFileSync(lockOf(api), bytes);
  },
  'P17 lock provider changed': (api) =>
    writeFileSync(lockOf(api), readFileSync(lockOf(api), 'utf8').replace('provider = "postgresql"', 'provider = "mysql"')),
  'P18 lock missing': (api) => rmSync(lockOf(api)),
  'P19 lock symlink to an identical copy': (api) => {
    const copy = path.join(outside('lock'), 'migration_lock.toml');
    cpSync(lockOf(api), copy);
    rmSync(lockOf(api));
    symlinkSync(copy, lockOf(api));
  },
  'P20 unrelated file under the migrations root': (api) => writeFileSync(path.join(migDir(api), 'README.md'), 'notes\n'),
  'P21 extra file inside an approved migration dir': (api) => writeFileSync(path.join(migDir(api), NAMES[1], 'down.sql'), 'DROP TABLE x;\n'),
  'P23 migrations root is a symlink to an identical tree': (api) => {
    const copy = path.join(outside('root'), 'migrations');
    cpSync(migDir(api), copy, { recursive: true });
    rmSync(migDir(api), { recursive: true });
    symlinkSync(copy, migDir(api));
  },
  'P24 api/prisma is a symlink to an identical tree': (api) => {
    const copy = path.join(outside('prisma'), 'prisma');
    cpSync(path.join(api, 'prisma'), copy, { recursive: true });
    rmSync(path.join(api, 'prisma'), { recursive: true });
    symlinkSync(copy, path.join(api, 'prisma'));
  },
  'P25 migration.sql is a directory': (api) => {
    rmSync(sqlOf(api, 0));
    mkdirSync(sqlOf(api, 0));
  },
  'P26 oversize migration.sql': (api) => writeFileSync(sqlOf(api, 3), Buffer.alloc(4 * 1024 * 1024, 0x41)),
};

test('H1: every payload deviation fails verification (class: exact tree + fd-pinned digests)', () => {
  assert.equal(verifyMigrationPayload(fakeApi()).ok, true);
  for (const [label, mutate] of Object.entries(PAYLOAD_MUTATIONS)) {
    const api = fakeApi();
    mutate(api);
    const result = verifyMigrationPayload(api);
    assert.equal(result.ok, false, label);
    assert.match(result.reason, EXPECTED_REASON[label], label);
  }
});

// Each deviation must be caught by the layer meant for it (not by a later one).
const EXPECTED_REASON = {
  'P2 fifth migration directory': /does not hold exactly the OWNER-approved migrations/,
  'P3 first migration missing': /does not hold exactly the OWNER-approved migrations/,
  'P4 middle migration missing': /does not hold exactly the OWNER-approved migrations/,
  'P5 migration renamed': /does not hold exactly the OWNER-approved migrations/,
  'P6 case drift': /does not hold exactly the OWNER-approved migrations/,
  'P7 order drift (earlier timestamp, same content)': /does not hold exactly the OWNER-approved migrations/,
  'P8 one-byte SQL mutation': /add_company_location\/migration\.sql does not match its approved SHA-256/,
  'P9 appended SQL comment': /d3_initial_stock_and_global_audit\/migration\.sql size differs/,
  'P10 empty migration.sql': /add_user_role_scope\/migration\.sql size differs/,
  'P11 migration.sql symlink to an identical copy': /20260907015311_init must contain exactly one regular migration\.sql/,
  'P12 migration dir symlink to an identical copy': /d3_initial_stock_and_global_audit is not a real directory/,
  'P16 lock one-byte mutation': /migration_lock\.toml does not match its approved SHA-256/,
  'P16b lock comment byte mutation (provider still valid)': /migration_lock\.toml does not match its approved SHA-256/,
  'P17 lock provider changed': /migration_lock\.toml size differs/,
  'P18 lock missing': /does not hold exactly the OWNER-approved migrations/,
  'P19 lock symlink to an identical copy': /migration_lock\.toml is not a regular file/,
  'P20 unrelated file under the migrations root': /does not hold exactly the OWNER-approved migrations/,
  'P21 extra file inside an approved migration dir': /add_company_location must contain exactly one regular migration\.sql/,
  'P23 migrations root is a symlink to an identical tree': /prisma\/migrations must be a real directory, not a symlink/,
  'P24 api/prisma is a symlink to an identical tree': /^prisma must be a real directory, not a symlink/,
  'P25 migration.sql is a directory': /20260907015311_init must contain exactly one regular migration\.sql/,
  'P26 oversize migration.sql': /d3_initial_stock_and_global_audit\/migration\.sql size differs/,
};

test('H1/P17b: a lock with the approved size and a different provider fails the provider check', () => {
  const api = fakeApi();
  // Same byte length as "postgresql", so only the provider semantics can catch it.
  writeFileSync(lockOf(api), readFileSync(lockOf(api), 'utf8').replace('"postgresql"', '"sqlserver_"'));
  const result = verifyMigrationPayload(api);
  assert.equal(result.ok, false);
  assert.match(result.reason, /migration_lock\.toml (does not match its approved SHA-256|provider is not exactly)/);
});

// The race layer: what protects a read if a swap slips past the directory listing.
test('H1/readPinned: final-component symlink, symlinked parent, non-regular, FIFO and size are refused per layer', { timeout: 5000 }, () => {
  const dir = mkdtempSync(path.join(TMP, 'pinned-'));
  const real = path.join(dir, 'real.sql');
  writeFileSync(real, 'SELECT 1;\n');
  const ok = readPinned(real, 10);
  assert.equal(ok.ok, true);
  assert.equal(ok.sha256, createHash('sha256').update('SELECT 1;\n').digest('hex'));
  assert.equal(ok.bytes.toString(), 'SELECT 1;\n');
  const link = path.join(dir, 'link.sql');
  symlinkSync(real, link);
  assert.deepEqual(readPinned(link, 10), { ok: false, reason: 'is missing or is a symlink' });
  const realDir = path.join(dir, 'realdir');
  mkdirSync(realDir);
  writeFileSync(path.join(realDir, 'migration.sql'), 'SELECT 1;\n');
  symlinkSync(realDir, path.join(dir, 'linkdir'));
  assert.deepEqual(readPinned(path.join(dir, 'linkdir', 'migration.sql'), 10), { ok: false, reason: 'does not resolve to its canonical path' });
  assert.deepEqual(readPinned(realDir, 10), { ok: false, reason: 'is not a regular file' });
  const fifo = path.join(dir, 'fifo.sql');
  execFileSync('mkfifo', [fifo]);
  assert.deepEqual(readPinned(fifo, 10), { ok: false, reason: 'is not a regular file' });
  assert.deepEqual(readPinned(real, 9), { ok: false, reason: 'size differs from the approved file' });
  assert.deepEqual(readPinned(path.join(dir, 'absent.sql'), 10), { ok: false, reason: 'is missing or is a symlink' });
});

test('H1/P2-P26 dry-run: any payload deviation fails at phase=payload with no client or child', async () => {
  for (const [label, mutate] of Object.entries(PAYLOAD_MUTATIONS)) {
    const api = fakeApi();
    mutate(api);
    const r = await run(DRY, { apiDir: api });
    assert.equal(r.code, 1, label);
    assert.match(r.text, /phase=payload/, label);
    assert.equal(r.created.length, 0, label);
    assert.equal(r.spawned.length, 0, label);
    assertNoLeak(r.text);
  }
});

test('H1/P2-P26 execute: a locally detectable deviation fails before any DB client or child', async () => {
  for (const [label, mutate] of Object.entries(PAYLOAD_MUTATIONS)) {
    const api = fakeApi();
    mutate(api);
    const r = await run(EXECUTE, { apiDir: api });
    assert.equal(r.code, 1, label);
    assert.match(r.text, /phase=payload/, label);
    assert.equal(r.created.length, 0, `${label}: DB client created`);
    assert.equal(r.spawned.length, 0, `${label}: prisma spawned`);
    assertNoLeak(r.text);
  }
});

test('H1/P13-P15: payload changed during or after the identity proof → final validation stops Prisma', async () => {
  const late = {
    'P13 SQL replaced during the proof': (api) => ({ onQuery: once(() => flipByte(sqlOf(api, 0))) }),
    'P14 fifth migration created during the proof': (api) => ({ onQuery: once(() => PAYLOAD_MUTATIONS['P2 fifth migration directory'](api)) }),
    'P15 lock changed after the proof connection closed': (api) => ({ onEnd: () => flipByte(lockOf(api)) }),
    'P15 SQL changed after the proof connection closed': (api) => ({ onEnd: () => appendFileSync(sqlOf(api, 2), '-- late\n') }),
  };
  for (const [label, hooks] of Object.entries(late)) {
    const api = fakeApi();
    const r = await run(EXECUTE, { apiDir: api, client: fakeClient(hooks(api)) });
    assert.equal(r.code, 1, label);
    assert.equal(r.created.length, 1, `${label}: proof should have run`);
    assert.match(r.text, /canonical PILOT marker verified/, label);
    assert.match(r.text, /phase=payload/, label);
    assert.equal(r.spawned.length, 0, `${label}: prisma spawned after a late payload change`);
  }
});

function once(fn) {
  let done = false;
  return () => {
    if (!done) {
      done = true;
      fn();
    }
  };
}

test('H1/P22: a change restored before the final validation still passes (final state is what is bound)', async () => {
  const api = fakeApi();
  const original = readFileSync(sqlOf(api, 0));
  const r = await run(EXECUTE, {
    apiDir: api,
    client: fakeClient({ onQuery: once(() => flipByte(sqlOf(api, 0))), onEnd: () => writeFileSync(sqlOf(api, 0), original) }),
  });
  assert.equal(r.code, 0, r.text);
  assert.equal(r.spawned.length, 1);
});

test('H1/P1/P28: the approved payload still reaches the proof and exactly the unchanged child', async () => {
  const order = [];
  const r = await run(EXECUTE, { order });
  assert.equal(r.code, 0, r.text);
  assert.deepEqual(order, ['proof-end', 'spawn']);
  const [{ command, args, options }] = r.spawned;
  assert.equal(command, '/opt/synthetic/node/bin/node');
  assert.deepEqual(args, [resolvePrismaCli(API).script, 'migrate', 'deploy', '--config', 'prisma.config.ts']);
  assert.equal(options.cwd, realpathSync(API));
  assert.equal(options.shell, false);
  assert.equal(options.env.DATABASE_URL, URL_TEXT);
});

// --- K17: a cleanup failure inside the identity proof can neither escape nor spawn Prisma --------

test('K17: a proof whose ROLLBACK throws synchronously resolves at phase=identity and never spawns Prisma', async () => {
  for (const mode of ['throw', 'reject']) {
    const base = fakeClient();
    const client = {
      ...base,
      calls: base.calls,
      sql: base.sql,
      connection: base.connection,
      connect: () => base.connect(),
      end: () => base.end(),
      query(q) {
        const text = typeof q === 'string' ? q : q.text;
        if (text === 'ROLLBACK') {
          base.sql.push(text);
          if (mode === 'throw') throw secretError('rollback threw');
          return Promise.reject(secretError('rollback rejected'));
        }
        return base.query(q);
      },
    };
    let r;
    try {
      r = await run(EXECUTE, { client });
    } catch (err) {
      assert.fail(`pilot-migrate main() must resolve; an exception escaped: ${String(err?.message ?? err).slice(0, 16)}`);
    }
    assert.equal(r.code, 1, mode);
    assert.match(r.text, /phase=identity — PILOT identity proof failed; prisma was NOT started/, `${mode}: ${r.text}`);
    assert.equal(r.spawned.length, 0, `${mode}: Prisma must never be spawned`);
    for (const leak of LEAKS) assert.ok(!r.text.includes(leak), `${mode}: leaked ${leak}`);
  }
});
