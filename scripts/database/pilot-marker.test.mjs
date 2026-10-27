// Zero-database unit tests for scripts/database/pilot-marker.mjs.
// Run with: node --test scripts/database/pilot-marker.test.mjs
// Every URL below is synthetic (*.invalid). No test reads the real private URL
// file (~/.config/mona-jacinta/pilot-database-url), constructs a real pg client,
// or opens a socket: readUrlFile and createClient are always injected fakes, and
// the private-file checks run against throwaway files in a fresh temp directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CANONICAL_MARKER,
  GUARD_SCHEMA,
  GUARD_TABLE,
  PILOT_URL_FILE,
  buildInstallStatements,
  decideInstall,
  deriveProjectRef,
  main,
  parseCliArgs,
  parsePilotUrl,
  readPrivateUrlFile,
  safeCode,
  verifyMarkerStructure,
} from './pilot-marker.mjs';

const MARKER = '5c7e2a91-3b4d-4f6a-9c8e-0d1f2a3b4c5d';
const OTHER = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const REF = 'pilotsynthref0000001';
const REF_B = 'othersynthref0000002';
const SECRET = 'Pi1otS3cretPw';
const HOST = 'aws-0-synthetic.pooler.invalid';
const URL_TEXT = `postgresql://postgres.${REF}:${SECRET}@${HOST}:6543/postgres`;
const LEAKS = [SECRET, HOST, REF, `postgres.${REF}`, URL_TEXT, '6543', 'pooler', os.homedir()];
const QUALIFIED = `${GUARD_SCHEMA}.${GUARD_TABLE}`;
const CHECK_BEGIN = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY';
const CHECK_LOCK = `LOCK TABLE ${QUALIFIED} IN ACCESS SHARE MODE`;
const isRead = (q) => /^\s*SELECT\b/.test(q);

const DRY = ['--target=pilot', '--dry-run', `--marker-id=${MARKER}`];
const EXECUTE = ['--target=pilot', '--execute', `--marker-id=${MARKER}`, `--confirm-project-ref=${REF}`];
const CHECK = ['--target=pilot', '--check', `--marker-id=${MARKER}`];
const FORBIDDEN_SQL = /\b(DROP|TRUNCATE|DELETE|UPDATE|ALTER|GRANT|REVOKE)\b|IF NOT EXISTS/i;

function assertNoLeak(text) {
  for (const leak of LEAKS) assert.ok(!text.includes(leak), `output leaked ${JSON.stringify(leak)}`);
}

// Hand-written catalog facts for the canonical PILOT marker (deliberately NOT
// derived from CANONICAL_MARKER, so drift in either is caught).
function canonicalFacts() {
  return {
    schemaOwnerIsCurrentUser: true,
    relations: [
      { name: 'database_identity_pkey', kind: 'i' },
      { name: 'database_identity', kind: 'r' },
    ],
    table: {
      kind: 'r', persistence: 'p', isPartition: false, ofType: false,
      ownerIsCurrentUser: true, rowSecurity: false, forceRowSecurity: false,
      hasSubclass: false, parents: 0, children: 0, hasRules: false, triggers: 0,
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
const ABSENT = { schemaExists: false, tableExists: false, testGuardExists: false, rows: [] };
const existing = (rows, facts = canonicalFacts()) => ({ schemaExists: true, tableExists: true, testGuardExists: false, facts, rows });

function fakeClient({
  state = ABSENT,
  installedFacts = canonicalFacts(),
  failOn,
  failCode = '23514',
  authorized = true,
  encrypted = authorized,
  connectError,
  rollbackThrows = false,
  commitThrows = false,
  endThrows = false,
  endHangs = false,
} = {}) {
  const calls = [];
  const sql = [];
  let installed = null;
  const current = () => installed ?? state;
  const boom = (label) => Object.assign(new Error(`${label} ${URL_TEXT}`), { code: '57014' });
  return {
    calls,
    sql,
    connection: { stream: { encrypted, authorized } },
    async connect() {
      calls.push('CONNECT');
      if (connectError !== undefined) throw connectError;
    },
    async query(q, values) {
      const text = typeof q === 'string' ? q : q.text;
      const params = typeof q === 'string' ? values : q.values;
      sql.push(text);
      calls.push(text.trim().split(/\s+/).slice(0, 3).join(' '));
      if (failOn && text.includes(failOn)) throw Object.assign(new Error(`boom ${URL_TEXT}`), { code: failCode });
      // Real PostgreSQL: LOCK on an absent relation fails (42P01 table, 3F000 schema).
      if (text.startsWith('LOCK TABLE') && !current().tableExists) {
        throw Object.assign(new Error(`missing ${URL_TEXT}`), { code: current().schemaExists ? '42P01' : '3F000' });
      }
      if (text === 'ROLLBACK' && rollbackThrows) throw boom('rollback');
      if (text === 'COMMIT' && commitThrows) throw boom('commit');
      if (text.includes('to_regnamespace')) {
        const s = current();
        return { rows: [{ schema_exists: s.schemaExists, table_exists: s.tableExists, test_guard_exists: s.testGuardExists ?? false }] };
      }
      if (text.includes('json_build_object')) return { rows: [{ facts: current().facts ?? null }] };
      if (text.startsWith('SELECT environment')) return { rows: current().rows };
      if (text.startsWith('INSERT')) installed = existing([row('pilot', params[0])], installedFacts);
      return { rows: [] };
    },
    end() {
      calls.push('END');
      if (endHangs) return new Promise(() => {});
      return endThrows ? Promise.reject(new Error(`end failed ${URL_TEXT}`)) : Promise.resolve();
    },
  };
}

async function run(argv, { urlText = URL_TEXT, fileResult, client, env = {}, createThrows } = {}) {
  const out = [];
  const created = [];
  const reads = [];
  const deps = {
    urlFile: '/nonexistent/synthetic/pilot-database-url',
    readUrlFile: (p) => {
      reads.push(p);
      return fileResult ?? { ok: true, text: urlText };
    },
    env,
    createClient: (conn) => {
      created.push(conn);
      if (createThrows) throw new Error(`cannot build client for ${URL_TEXT}`);
      if (!client) throw new Error('createClient must not be called');
      return client;
    },
    log: (line) => out.push(line),
    error: (line) => out.push(line),
    endTimeoutMs: 50,
  };
  const code = await main(argv, deps);
  const text = out.join('\n');
  if (client) for (const q of client.sql) assert.ok(!FORBIDDEN_SQL.test(q), `forbidden SQL issued: ${q}`);
  return { code, text, created, reads };
}

// --- CLI -------------------------------------------------------------------

test('parse: the three canonical invocations', () => {
  assert.deepEqual(parseCliArgs(DRY), { ok: true, mode: 'dry-run', markerId: MARKER, confirmProjectRef: null });
  assert.deepEqual(parseCliArgs(EXECUTE), { ok: true, mode: 'execute', markerId: MARKER, confirmProjectRef: REF });
  assert.deepEqual(parseCliArgs(CHECK), { ok: true, mode: 'check', markerId: MARKER, confirmProjectRef: null });
  // Order does not matter.
  assert.equal(parseCliArgs([...EXECUTE].reverse()).ok, true);
});

test('parse: bare, missing target, and every non-pilot target fail closed without echo', () => {
  assert.equal(parseCliArgs([]).ok, false);
  assert.equal(parseCliArgs(['--dry-run', `--marker-id=${MARKER}`]).ok, false);
  for (const target of ['test', 'dev', 'demo', 'prod', 'production', 'PILOT', 'Pilot', '', 'pilot ', ' pilot', 'pilot\n']) {
    const parsed = parseCliArgs([`--target=${target}`, '--dry-run', `--marker-id=${MARKER}`]);
    assert.equal(parsed.ok, false, JSON.stringify(target));
    if (target.trim() && target.trim().toLowerCase() !== 'pilot') assert.ok(!parsed.error.includes(target.trim()), target);
  }
});

test('A1/A3/A5: alternate argument spellings and mode combinations fail closed', () => {
  const bad = [
    ['--target', 'pilot', '--dry-run', `--marker-id=${MARKER}`],
    ['--target=pilot', '--dry-run=true', `--marker-id=${MARKER}`],
    ['--target=pilot', '--execute=true', `--marker-id=${MARKER}`, `--confirm-project-ref=${REF}`],
    ['--target=pilot', '--check=1', `--marker-id=${MARKER}`],
    ['--target=pilot', `--marker-id=${MARKER}`],
    ['--target=pilot', '--dry-run', '--check', `--marker-id=${MARKER}`],
    ['--target=pilot', '--execute', '--check', `--marker-id=${MARKER}`, `--confirm-project-ref=${REF}`],
    ['--target=pilot', '--dry-run', '--dry-run', `--marker-id=${MARKER}`],
    ['--target=pilot', '--target=pilot', '--dry-run', `--marker-id=${MARKER}`],
    ['--target=pilot', '--dry-run', `--marker-id=${MARKER}`, `--marker-id=${MARKER}`],
    ['-t=pilot', '--dry-run', `--marker-id=${MARKER}`],
    ['--=pilot', '--dry-run', `--marker-id=${MARKER}`],
    ['--', '--target=pilot', '--dry-run', `--marker-id=${MARKER}`],
    ['--Target=pilot', '--dry-run', `--marker-id=${MARKER}`],
    ['--target=pilot', '--DRY-RUN', `--marker-id=${MARKER}`],
    ['--target=pilot', '--dry-run', `--marker-id=${MARKER}`, `--url=${URL_TEXT}`],
    ['--target=pilot', '--dry-run', `--marker-id=${MARKER}`, URL_TEXT],
    ['--target=pilot', '--dry-run', `--marker-id=${MARKER}`, '--backup=x.dump'],
  ];
  for (const argv of bad) {
    const parsed = parseCliArgs(argv);
    assert.equal(parsed.ok, false, argv.join(' '));
    assertNoLeak(parsed.error);
  }
});

test('A4/A6: --confirm-project-ref belongs to --execute only, and is mandatory there', () => {
  assert.equal(parseCliArgs([...CHECK, `--confirm-project-ref=${REF}`]).ok, false);
  assert.equal(parseCliArgs([...DRY, `--confirm-project-ref=${REF}`]).ok, false);
  assert.equal(parseCliArgs(EXECUTE.filter((a) => !a.startsWith('--confirm-project-ref='))).ok, false);
  for (const ref of ['', 'short', REF.toUpperCase(), `${REF}x`, `${REF.slice(0, 19)}-`, `${REF}'--`]) {
    const parsed = parseCliArgs(EXECUTE.map((a) => (a.startsWith('--confirm-project-ref=') ? `--confirm-project-ref=${ref}` : a)));
    assert.equal(parsed.ok, false, ref);
    if (ref) assert.ok(!parsed.error.includes(ref), 'ref echoed');
  }
});

test('parse: marker id must be a canonical lowercase version-4 UUID', () => {
  for (const bad of ['', 'abc', MARKER.toUpperCase(), '00000000-0000-0000-0000-000000000000',
    '5c7e2a91-3b4d-1f6a-9c8e-0d1f2a3b4c5d', '5c7e2a91-3b4d-4f6a-7c8e-0d1f2a3b4c5d', `{${MARKER}}`, `${MARKER}'; DROP TABLE x;--`]) {
    const parsed = parseCliArgs(['--target=pilot', '--dry-run', `--marker-id=${bad}`]);
    assert.equal(parsed.ok, false, bad);
    if (bad) assert.ok(!parsed.error.includes(bad), 'invalid value echoed');
  }
  assert.equal(parseCliArgs(['--target=pilot', '--dry-run']).ok, false);
});

test('bare invocation fails before reading the URL file or creating a client', async () => {
  const { code, reads, created, text } = await run([]);
  assert.equal(code, 1);
  assert.equal(reads.length, 0);
  assert.equal(created.length, 0);
  assert.match(text, /phase=args/);
});

// --- private URL file (real fs, synthetic temp files) ------------------------

function withTempDir(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pilot-marker-test-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const writePrivate = (dir, name, text, mode = 0o600) => {
  const file = path.join(dir, name);
  writeFileSync(file, text);
  chmodSync(file, mode);
  return file;
};

test('private file: a 0600 regular file owned by this user is read', () => {
  withTempDir((dir) => {
    const result = readPrivateUrlFile(writePrivate(dir, 'u', `${URL_TEXT}\n`));
    assert.deepEqual(result, { ok: true, text: `${URL_TEXT}\n` });
  });
});

test('A7/A8/A9: symlinked, group/world-readable, directory, missing, empty and oversize files are refused', () => {
  withTempDir((dir) => {
    const target = writePrivate(dir, 'real', URL_TEXT);
    const link = path.join(dir, 'link');
    symlinkSync(target, link);
    const sub = path.join(dir, 'sub');
    mkdirSync(sub, { mode: 0o700 });
    const cases = {
      symlink: link,
      'mode 0640': writePrivate(dir, 'g', URL_TEXT, 0o640),
      'mode 0604': writePrivate(dir, 'o', URL_TEXT, 0o604),
      'mode 0660': writePrivate(dir, 'gw', URL_TEXT, 0o660),
      directory: sub,
      missing: path.join(dir, 'absent'),
      empty: writePrivate(dir, 'e', ''),
      oversize: writePrivate(dir, 'big', `${URL_TEXT}${'x'.repeat(5000)}`),
    };
    for (const [label, file] of Object.entries(cases)) {
      const result = readPrivateUrlFile(file);
      assert.equal(result.ok, false, label);
      assertNoLeak(result.reason);
      assert.ok(!result.reason.includes(dir), `${label}: path echoed`);
    }
  });
});

test('default URL source is the private PILOT file and nothing else', () => {
  assert.equal(PILOT_URL_FILE, path.join(os.homedir(), '.config', 'mona-jacinta', 'pilot-database-url'));
});

// --- URL parsing and project-ref derivation ----------------------------------

test('URL: well-formed pooler and direct URLs parse to discrete fields; one trailing newline allowed (A10)', () => {
  for (const text of [URL_TEXT, `${URL_TEXT}\n`, `${URL_TEXT}\r\n`]) {
    const parsed = parsePilotUrl(text);
    assert.equal(parsed.ok, true, JSON.stringify(text));
    assert.deepEqual(parsed.conn, { host: HOST, port: 6543, database: 'postgres', user: `postgres.${REF}`, password: SECRET });
  }
  const direct = parsePilotUrl(`postgres://postgres:${SECRET}@db.${REF}.supabase.invalid/postgres`);
  assert.equal(direct.ok, true);
  assert.equal(direct.conn.port, 5432);
  const encoded = parsePilotUrl(`postgresql://postgres.${REF}:p%40ss%2Fword@${HOST}:6543/postgres`);
  assert.equal(encoded.conn.password, 'p@ss/word');
});

test('A9/A11/A12: malformed, overriding and non-DNS-host URLs are refused', () => {
  const bad = [
    '', 'not a url', `${URL_TEXT}\n\n`, `${URL_TEXT}\nsecond`, ` ${URL_TEXT}`, `${URL_TEXT} `, `${URL_TEXT}\t`,
    `mysql://postgres.${REF}:${SECRET}@${HOST}:6543/postgres`,
    `postgresql://postgres.${REF}@${HOST}:6543/postgres`,
    `postgresql://:${SECRET}@${HOST}:6543/postgres`,
    `postgresql://postgres.${REF}:${SECRET}@${HOST}:6543/`,
    `postgresql://postgres.${REF}:${SECRET}@${HOST}:6543`,
    `postgresql://postgres.${REF}:${SECRET}@${HOST}:6543/postgres/extra`,
    `${URL_TEXT}?sslmode=disable`,
    `${URL_TEXT}?sslmode=verify-full`,
    `${URL_TEXT}?options=-csearch_path%3Devil`,
    `${URL_TEXT}?host=elsewhere.invalid`,
    `${URL_TEXT}?`,
    `${URL_TEXT}#frag`,
    `postgresql://postgres.${REF}:${SECRET}@%2Ftmp:6543/postgres`,
    `postgresql://postgres.${REF}:${SECRET}@[::1]:6543/postgres`,
    `postgresql://postgres.${REF}:${SECRET}@127.0.0.1:6543/postgres`,
    `postgresql://postgres.${REF}:${SECRET}@localhost:6543/postgres`,
    `postgresql://postgres.${REF}:${SECRET}@:6543/postgres`,
    `postgresql://postgres.${REF}:${SECRET}@${HOST}:0/postgres`,
  ];
  for (const text of bad) assert.equal(parsePilotUrl(text).ok, false, JSON.stringify(text));
});

test('A13-A16: the project ref comes only from an unambiguous Supabase identity', () => {
  const conn = (user, host = HOST) => ({ host, port: 6543, database: 'postgres', user, password: SECRET });
  assert.equal(deriveProjectRef(conn(`postgres.${REF}`)), REF);
  assert.equal(deriveProjectRef(conn('postgres', `db.${REF}.supabase.invalid`)), REF);
  assert.equal(deriveProjectRef(conn(`postgres.${REF}`, `db.${REF}.supabase.invalid`)), REF);
  assert.equal(deriveProjectRef(conn(`postgres.${REF_B}`, `db.${REF}.supabase.invalid`)), null, 'contradictory');
  assert.equal(deriveProjectRef(conn('postgres')), null, 'no ref derivable');
  assert.equal(deriveProjectRef(conn(`postgres.${REF}.extra`)), null);
  assert.equal(deriveProjectRef(conn(`postgres.${REF.toUpperCase()}`)), null);
  assert.equal(deriveProjectRef(conn(`admin.${REF}`)), null);
  assert.equal(deriveProjectRef(conn(`postgres.${REF}`, `db.${REF}x.supabase.invalid`)), REF, 'non-ref db label is ignored');
});

// --- dry-run ---------------------------------------------------------------

test('dry-run: sanitized exact plan, zero clients, owner approval still required', async () => {
  const { code, text, created, reads } = await run(DRY);
  assert.equal(code, 0, text);
  assert.equal(created.length, 0);
  assert.deepEqual(reads, ['/nonexistent/synthetic/pilot-database-url']);
  assert.match(text, /no database connection was opened/i);
  assert.match(text, /target: PILOT/);
  assert.match(text, new RegExp(QUALIFIED.replace('.', '\\.')));
  assert.match(text, new RegExp(MARKER));
  for (const statement of buildInstallStatements(MARKER)) {
    assert.ok(text.includes(statement.text.split('\n')[0]), `plan lists: ${statement.text.split('\n')[0]}`);
  }
  assert.match(text, /explicit OWNER approval naming PILOT/);
  assert.match(text, /--execute/);
  assertNoLeak(text);
});

test('dry-run: reports whether a project ref is derivable (yes/no only, never the value)', async () => {
  const derivable = await run(DRY);
  assert.match(derivable.text, /project identity: derivable from the URL/);
  const underivable = await run(DRY, { urlText: `postgresql://postgres:${SECRET}@${HOST}:6543/postgres` });
  assert.equal(underivable.code, 0);
  assert.match(underivable.text, /project identity: NOT derivable from the URL — --execute will refuse/);
  assertNoLeak(derivable.text + underivable.text);
});

test('dry-run: deterministic output', async () => {
  assert.equal((await run(DRY)).text, (await run(DRY)).text);
});

test('A32: dry-run with a missing/insecure/malformed URL file fails at phase=config with no client', async () => {
  for (const opts of [
    { fileResult: { ok: false, reason: 'private URL file is missing' } },
    { fileResult: { ok: false, reason: 'private URL file must not be readable by group or others' } },
    { urlText: `${URL_TEXT}?sslmode=disable` },
  ]) {
    const { code, text, created } = await run(DRY, opts);
    assert.equal(code, 1);
    assert.equal(created.length, 0);
    assert.match(text, /phase=config/);
    assertNoLeak(text);
  }
});

// --- execute preconditions (all before any client) ---------------------------

test('A13: wrong --confirm-project-ref fails at phase=target before any client, refs not printed', async () => {
  const argv = EXECUTE.map((a) => (a.startsWith('--confirm-project-ref=') ? `--confirm-project-ref=${REF_B}` : a));
  const { code, text, created } = await run(argv, { client: fakeClient() });
  assert.equal(code, 1);
  assert.equal(created.length, 0);
  assert.match(text, /phase=target/);
  assertNoLeak(text);
  assert.ok(!text.includes(REF_B));
});

test('A14/A15: contradictory or underivable project identity fails before any client', async () => {
  for (const urlText of [
    `postgresql://postgres.${REF_B}:${SECRET}@db.${REF}.supabase.invalid:5432/postgres`,
    `postgresql://postgres:${SECRET}@${HOST}:6543/postgres`,
  ]) {
    const { code, text, created } = await run(EXECUTE, { urlText, client: fakeClient() });
    assert.equal(code, 1, urlText);
    assert.equal(created.length, 0);
    assert.match(text, /phase=target/);
    assertNoLeak(text);
  }
});

test('A17: PGOPTIONS in the environment is refused before any client (execute and check)', async () => {
  for (const argv of [EXECUTE, CHECK]) {
    const { code, text, created } = await run(argv, { client: fakeClient(), env: { PGOPTIONS: '-c search_path=evil' } });
    assert.equal(code, 1);
    assert.equal(created.length, 0);
    assert.match(text, /phase=config/);
    assert.ok(!text.includes('evil'));
  }
});

test('A33: other database variables in the environment are never used', async () => {
  const client = fakeClient();
  const env = {
    DATABASE_URL: 'postgresql://postgres.devref:devpass@dev.invalid:5432/postgres',
    TEST_DATABASE_URL: 'postgresql://postgres.testref:testpass@test.invalid:5432/postgres',
    PGHOST: 'pghost.invalid', PGPASSWORD: 'pgpass', PGUSER: 'pguser', PGDATABASE: 'pgdb',
  };
  const { code, created, text } = await run(EXECUTE, { client, env });
  assert.equal(code, 0, text);
  assert.deepEqual(created, [{ host: HOST, port: 6543, database: 'postgres', user: `postgres.${REF}`, password: SECRET }]);
});

test('A28: createClient throwing (with the URL in its message) fails sanitized', async () => {
  const { code, text } = await run(EXECUTE, { createThrows: true });
  assert.equal(code, 1);
  assert.match(text, /phase=connect/);
  assertNoLeak(text);
});

// --- execute against a fake client -----------------------------------------

test('execute: fresh PILOT installs additively in one transaction, in the exact order', async () => {
  const client = fakeClient();
  const { code, text } = await run(EXECUTE, { client });
  assert.equal(code, 0, text);
  const expected = [
    'CONNECT',
    'BEGIN',
    'SET LOCAL search_path',
    'SET LOCAL lock_timeout',
    'SET LOCAL statement_timeout',
    "SELECT to_regnamespace('mona_pilot_guard')",
    'CREATE SCHEMA mona_pilot_guard',
    'CREATE TABLE mona_pilot_guard.database_identity',
    'COMMENT ON SCHEMA',
    'INSERT INTO mona_pilot_guard.database_identity',
    "SELECT to_regnamespace('mona_pilot_guard')",
    'LOCK TABLE mona_pilot_guard.database_identity',
    'SELECT json_build_object(',
    'SELECT environment, marker_id::text',
    'COMMIT',
    'END',
  ];
  assert.equal(client.calls.length, expected.length, client.calls.join(' | '));
  expected.forEach((prefix, i) => assert.ok(client.calls[i].startsWith(prefix), `#${i}: ${client.calls[i]} !~ ${prefix}`));
  assert.equal(client.calls[1], 'BEGIN');
  assert.ok(client.sql.includes('SET LOCAL search_path TO pg_catalog, pg_temp'));
  assert.ok(client.sql.some((q) => q === `LOCK TABLE ${QUALIFIED} IN SHARE MODE`));
  assert.match(text, /installed on PILOT/);
  assertNoLeak(text);
});

test('execute: identical canonical marker is an idempotent no-op (lock before reads, no DDL)', async () => {
  const client = fakeClient({ state: existing([row('pilot', MARKER)]) });
  const { code, text } = await run(EXECUTE, { client });
  assert.equal(code, 0, text);
  const lock = client.calls.findIndex((c) => c.startsWith('LOCK TABLE'));
  const facts = client.calls.findIndex((c) => c.startsWith('SELECT json_build_object('));
  const rows = client.calls.findIndex((c) => c.startsWith('SELECT environment'));
  assert.ok(lock > 0 && lock < facts && facts < rows, client.calls.join(' | '));
  assert.ok(!client.calls.some((c) => /^(CREATE|INSERT|COMMIT|COMMENT)/.test(c)));
  assert.equal(client.calls.at(-2), 'ROLLBACK');
  assert.equal(client.calls.at(-1), 'END');
  assert.match(text, /already installed/i);
});

const CONFLICT_STATES = {
  'different marker id': existing([row('pilot', OTHER)]),
  'partial: schema without table': { ...ABSENT, schemaExists: true },
  'partial: table without schema flag': { ...ABSENT, tableExists: true },
  'empty table': existing([]),
  'multiple rows': existing([row('pilot', MARKER), row('pilot', OTHER)]),
  'wrong environment test': existing([row('test', MARKER)]),
  'A23 environment with trailing space': existing([row('pilot ', MARKER)]),
  'A23 environment uppercase': existing([row('PILOT', MARKER)]),
  'missing installed_at': existing([{ ...row('pilot', MARKER), has_installed_at: false }]),
  'marker id uppercase text': existing([row('pilot', MARKER.toUpperCase())]),
  'unreadable structure': existing([row('pilot', MARKER)], null),
  'A22 TEST marker schema present on the target': { ...existing([row('pilot', MARKER)]), testGuardExists: true },
  'A22 TEST marker present on an otherwise fresh target': { ...ABSENT, testGuardExists: true },
};

test('execute: every non-canonical existing state is a conflict, never repaired or overwritten', async () => {
  for (const [label, state] of Object.entries(CONFLICT_STATES)) {
    const client = fakeClient({ state });
    const { code, text } = await run(EXECUTE, { client });
    assert.equal(code, 1, label);
    assert.match(text, /phase=conflict/, label);
    assert.ok(!client.calls.some((c) => /^(CREATE|INSERT|COMMIT|COMMENT)/.test(c)), label);
    assert.ok(client.calls.includes('ROLLBACK'), label);
    assert.equal(client.calls.at(-1), 'END', label);
    assert.ok(!text.includes(OTHER), 'foreign marker id echoed');
    assertNoLeak(text);
  }
});

// --- structural identity ---------------------------------------------------

function mutated(change) {
  const facts = canonicalFacts();
  change(facts);
  return facts;
}
const col = (facts, name) => facts.columns.find((c) => c.name === name);
const STRUCTURAL_MUTATIONS = {
  'marker_id is text': (f) => { col(f, 'marker_id').type = 'text'; },
  'environment varchar': (f) => { col(f, 'environment').type = 'character varying'; },
  'environment nullable': (f) => { col(f, 'environment').notNull = false; },
  'installed_at nullable': (f) => { col(f, 'installed_at').notNull = false; },
  'installed_at default changed': (f) => { col(f, 'installed_at').default = "'2020-01-01 00:00:00+00'::timestamp with time zone"; },
  'installed_at without time zone': (f) => { col(f, 'installed_at').type = 'timestamp without time zone'; },
  'environment gets a default': (f) => { col(f, 'environment').default = "'pilot'::text"; },
  'singleton default false': (f) => { col(f, 'singleton').default = 'false'; },
  'generated column': (f) => { col(f, 'marker_id').generated = 's'; },
  'identity column': (f) => { col(f, 'singleton').identity = 'a'; },
  'A20 environment with a custom collation': (f) => { col(f, 'environment').collation = 'und-x-icu-ci'; },
  'collation fact missing': (f) => { delete col(f, 'environment').collation; },
  'extra column': (f) => { f.columns.push({ name: 'override', type: 'text', notNull: false, default: null, generated: '', identity: '', collation: 'default' }); },
  'missing column': (f) => { f.columns.pop(); },
  'columns reordered': (f) => { f.columns.reverse(); },
  'renamed column': (f) => { col(f, 'marker_id').name = 'marker'; },
  'missing environment CHECK': (f) => { f.constraints = f.constraints.filter((c) => !c.definition.includes('environment')); },
  'TEST environment CHECK': (f) => { f.constraints[2].definition = "CHECK ((environment = 'test'::text))"; },
  'weaker environment CHECK': (f) => { f.constraints[2].definition = "CHECK ((environment = ANY (ARRAY['pilot'::text, 'test'::text])))"; },
  'NOT VALID environment CHECK': (f) => { f.constraints[2].definition = "CHECK ((environment = 'pilot'::text)) NOT VALID"; },
  'missing singleton CHECK': (f) => { f.constraints = f.constraints.filter((c) => c.definition !== 'CHECK (singleton)'); },
  'deferrable PK': (f) => { f.constraints[0].definition = 'PRIMARY KEY (singleton) DEFERRABLE'; },
  'PK on marker_id': (f) => { f.constraints[0].definition = 'PRIMARY KEY (marker_id)'; },
  'no PK': (f) => { f.constraints = f.constraints.filter((c) => c.type !== 'p'); },
  'extra UNIQUE': (f) => { f.constraints.push({ type: 'u', definition: 'UNIQUE (marker_id)' }); },
  'extra exclusion constraint': (f) => { f.constraints.push({ type: 'x', definition: 'EXCLUDE USING btree (marker_id WITH =)' }); },
  'view': (f) => { f.table.kind = 'v'; },
  'partitioned table': (f) => { f.table.kind = 'p'; },
  'foreign table': (f) => { f.table.kind = 'f'; },
  'A18 unlogged': (f) => { f.table.persistence = 'u'; },
  'A19 typed table': (f) => { f.table.ofType = true; },
  'A21 partition with stale parents=0': (f) => { f.table.isPartition = true; },
  'RLS enabled': (f) => { f.table.rowSecurity = true; },
  'RLS forced': (f) => { f.table.forceRowSecurity = true; },
  'rules': (f) => { f.table.hasRules = true; },
  'triggers': (f) => { f.table.triggers = 1; },
  'trigger count as string': (f) => { f.table.triggers = '0'; },
  'inheritance parent': (f) => { f.table.parents = 1; },
  'inheritance child': (f) => { f.table.children = 1; },
  'relhassubclass set': (f) => { f.table.hasSubclass = true; },
  'parents fact missing': (f) => { delete f.table.parents; },
  'children fact null': (f) => { f.table.children = null; },
  'isPartition fact missing': (f) => { delete f.table.isPartition; },
  'persistence fact missing': (f) => { delete f.table.persistence; },
  'table owned by another role': (f) => { f.table.ownerIsCurrentUser = false; },
  'schema owned by another role': (f) => { f.schemaOwnerIsCurrentUser = false; },
  'schema owner fact missing': (f) => { delete f.schemaOwnerIsCurrentUser; },
  'extra table in schema': (f) => { f.relations.push({ name: 'shadow_identity', kind: 'r' }); },
  'extra index in schema': (f) => { f.relations.push({ name: 'database_identity_marker_idx', kind: 'i' }); },
  'extra sequence in schema': (f) => { f.relations.push({ name: 's', kind: 'S' }); },
  'pkey index missing': (f) => { f.relations = f.relations.filter((r) => r.kind !== 'i'); },
  'table facts missing': (f) => { f.table = null; },
};

test('structure: canonical facts verify; every deviation is rejected', () => {
  assert.equal(verifyMarkerStructure(canonicalFacts()), null);
  for (const [label, change] of Object.entries(STRUCTURAL_MUTATIONS)) {
    assert.notEqual(verifyMarkerStructure(mutated(change)), null, label);
  }
});

test('structure: execute refuses a matching row in a structurally wrong table, without DDL', async () => {
  for (const [label, change] of Object.entries(STRUCTURAL_MUTATIONS)) {
    const client = fakeClient({ state: existing([row('pilot', MARKER)], mutated(change)) });
    const { code, text } = await run(EXECUTE, { client });
    assert.equal(code, 1, label);
    assert.match(text, /phase=conflict/, label);
    assert.ok(!client.calls.some((c) => /^(CREATE|INSERT|COMMIT)/.test(c)), label);
    assert.ok(client.calls.includes('ROLLBACK'), label);
  }
});

test('structure: a fresh install that does not verify afterwards is rolled back', async () => {
  for (const label of ['weaker environment CHECK', 'inheritance parent', 'A18 unlogged']) {
    const client = fakeClient({ installedFacts: mutated(STRUCTURAL_MUTATIONS[label]) });
    const { code, text } = await run(EXECUTE, { client });
    assert.equal(code, 1, label);
    assert.match(text, /phase=verify/, label);
    assert.ok(client.calls.includes('ROLLBACK'), label);
    assert.ok(!client.calls.includes('COMMIT'), label);
  }
});

test('structure: facts query pins every identity-bearing catalog fact', async () => {
  const client = fakeClient({ state: existing([row('pilot', MARKER)]) });
  await run(EXECUTE, { client });
  const facts = client.sql.find((q) => q.includes('json_build_object'));
  assert.ok(facts);
  for (const needle of [
    /FROM pg_inherits \w+ WHERE \w+\.inhrelid = c\.oid/,
    /FROM pg_inherits \w+ WHERE \w+\.inhparent = c\.oid/,
    /relpersistence/, /relispartition/, /reloftype/, /attcollation/, /relrowsecurity/, /relforcerowsecurity/,
    /relhasrules/, /pg_trigger/, /pg_get_constraintdef/, /format_type/, /attgenerated/, /attidentity/, /nspowner/, /relowner/,
    new RegExp(`n\\.nspname = '${GUARD_SCHEMA}'`),
  ]) assert.match(facts, needle);
  const inspect = client.sql.find((q) => q.includes('to_regnamespace'));
  assert.match(inspect, /to_regnamespace\('mona_test_guard'\)/);
});

test('install DDL is generated from the canonical definition, additive and parameterized', () => {
  const statements = buildInstallStatements(MARKER);
  const sql = statements.map((s) => s.text).join('\n');
  const create = statements.find((s) => s.text.startsWith('CREATE TABLE')).text;
  for (const column of CANONICAL_MARKER.columns) assert.ok(create.includes(`${column.name} ${column.ddl}`), column.name);
  assert.ok(!FORBIDDEN_SQL.test(sql));
  assert.ok(!sql.includes(MARKER), 'marker must be a bound parameter');
  assert.match(sql, /singleton boolean PRIMARY KEY DEFAULT true CHECK \(singleton\)/);
  assert.match(sql, /environment text NOT NULL CHECK \(environment = 'pilot'\)/);
  assert.match(sql, /marker_id uuid NOT NULL/);
  assert.match(sql, /installed_at timestamptz NOT NULL DEFAULT now\(\)/);
  assert.match(sql, /INSERT INTO mona_pilot_guard\.database_identity \(environment, marker_id\) VALUES \('pilot', \$1\)/);
  assert.ok(!/'test'|mona_test_guard/.test(sql), 'no TEST identity in PILOT DDL');
  assert.deepEqual(statements.flatMap((s) => s.values ?? []), [MARKER]);
  assertNoLeak(sql);
});

test('decideInstall: only the canonical structure with one exact pilot row is idempotent', () => {
  assert.equal(decideInstall(ABSENT, MARKER).action, 'install');
  assert.equal(decideInstall(existing([row('pilot', MARKER)]), MARKER).action, 'already-installed');
  for (const [label, state] of Object.entries(CONFLICT_STATES)) assert.equal(decideInstall(state, MARKER).action, 'conflict', label);
});

// --- failures, TLS, cleanup ------------------------------------------------

test('A24: TLS encrypted-but-unauthorized or unencrypted stops before any query', async () => {
  for (const opts of [{ authorized: false, encrypted: true }, { authorized: false, encrypted: false }, { authorized: true, encrypted: false }]) {
    for (const argv of [EXECUTE, CHECK]) {
      const client = fakeClient(opts);
      const { code, text } = await run(argv, { client });
      assert.equal(code, 1);
      assert.match(text, /phase=connect/);
      assert.deepEqual(client.calls, ['CONNECT', 'END']);
    }
  }
});

test('connect failure reports only a safe code', async () => {
  const err = Object.assign(new Error(`connect ETIMEDOUT ${HOST}:6543 ${URL_TEXT}`), { code: 'ETIMEDOUT' });
  const { code, text } = await run(EXECUTE, { client: fakeClient({ connectError: err }) });
  assert.equal(code, 1);
  assert.match(text, /phase=connect code=ETIMEDOUT/);
  assertNoLeak(text);
});

test('failure mid-install rolls back, never commits, and stays sanitized', async () => {
  for (const failOn of ['CREATE SCHEMA', 'CREATE TABLE', 'COMMENT ON', 'INSERT', 'LOCK TABLE', 'pg_inherits']) {
    const client = fakeClient({ failOn });
    const { code, text } = await run(EXECUTE, { client });
    assert.equal(code, 1, failOn);
    assert.match(text, /code=23514/, failOn);
    assert.ok(client.calls.includes('ROLLBACK'), failOn);
    assert.ok(!client.calls.includes('COMMIT'), failOn);
    assert.equal(client.calls.at(-1), 'END', failOn);
    assertNoLeak(text);
  }
});

test('A25: ROLLBACK throwing on the conflict path still ends the client, exits 1, sanitized', async () => {
  const client = fakeClient({ state: existing([row('pilot', OTHER)]), rollbackThrows: true });
  const { code, text } = await run(EXECUTE, { client });
  assert.equal(code, 1);
  assert.ok(!client.calls.includes('COMMIT'));
  assert.equal(client.calls.at(-1), 'END');
  assertNoLeak(text);
});

test('A26: COMMIT throwing → phase=commit, rollback attempted, client ended, sanitized', async () => {
  const client = fakeClient({ commitThrows: true });
  const { code, text } = await run(EXECUTE, { client });
  assert.equal(code, 1);
  assert.match(text, /phase=commit code=57014/);
  assert.ok(client.calls.lastIndexOf('ROLLBACK') > client.calls.indexOf('COMMIT'));
  assert.equal(client.calls.at(-1), 'END');
  assertNoLeak(text);
});

test('A27: a client.end() that never resolves does not hang main or change the outcome', { timeout: 3000 }, async () => {
  const started = Date.now();
  const { code, text } = await run(EXECUTE, { client: fakeClient({ endHangs: true }) });
  assert.equal(code, 0, text);
  assert.ok(Date.now() - started < 2000);
  const rejected = await run(EXECUTE, { client: fakeClient({ endThrows: true }) });
  assert.equal(rejected.code, 0, rejected.text);
  assertNoLeak(rejected.text);
});

test('A29: safeCode keeps only allowlisted, secret-free codes', () => {
  const secrets = [URL_TEXT, SECRET, HOST];
  assert.equal(safeCode(Object.assign(new Error('x'), { code: '42P01' }), secrets), '42P01');
  assert.equal(safeCode(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }), secrets), 'ECONNREFUSED');
  assert.equal(safeCode({ code: 'S3CRETPW' }, ['postgresql://u:S3CRETPW@h.invalid/postgres']), 'unexpected');
  assert.equal(safeCode({ code: 'P' }, secrets), 'unexpected', 'a code inside the password');
  assert.equal(safeCode({ code: 'user@host' }, secrets), 'unexpected');
  assert.equal(safeCode('thrown string', secrets), 'unexpected');
  assert.equal(safeCode(undefined, secrets), 'unexpected');
});

// --- check mode -------------------------------------------------------------

test('A30: --check proves the canonical marker read-only and never mutates', async () => {
  const client = fakeClient({ state: existing([row('pilot', MARKER)]) });
  const { code, text, created } = await run(CHECK, { client });
  assert.equal(code, 0, text);
  assert.equal(created.length, 1);
  assert.equal(client.sql[0], CHECK_BEGIN);
  assert.equal(client.calls[2], 'SET LOCAL search_path');
  assert.ok(client.sql.includes(`LOCK TABLE ${QUALIFIED} IN ACCESS SHARE MODE`));
  assert.ok(!client.calls.some((c) => /^(CREATE|INSERT|COMMIT|COMMENT)/.test(c)));
  assert.deepEqual(client.calls.slice(-2), ['ROLLBACK', 'END']);
  assert.match(text, /verified/i);
  assertNoLeak(text);
});

test('A31: --check fails on a missing marker and on every conflict state', async () => {
  for (const [label, state] of Object.entries({ 'A31 missing marker': ABSENT, ...CONFLICT_STATES })) {
    const client = fakeClient({ state });
    const { code, text } = await run(CHECK, { client });
    assert.equal(code, 1, label);
    assert.match(text, /phase=identity/, label);
    assert.ok(!client.calls.some((c) => /^(CREATE|INSERT|COMMIT|COMMENT)/.test(c)), label);
    assert.equal(client.calls.at(-1), 'END', label);
    assert.ok(!text.includes(OTHER));
    assertNoLeak(text);
  }
  for (const [label, change] of Object.entries(STRUCTURAL_MUTATIONS)) {
    const client = fakeClient({ state: existing([row('pilot', MARKER)], mutated(change)) });
    const { code } = await run(CHECK, { client });
    assert.equal(code, 1, label);
  }
});

test('--check needs no project ref and rejects a different expected marker id', async () => {
  const argv = CHECK.map((a) => (a.startsWith('--marker-id=') ? `--marker-id=${OTHER}` : a));
  const { code, text } = await run(argv, { client: fakeClient({ state: existing([row('pilot', MARKER)]) }) });
  assert.equal(code, 1);
  assert.match(text, /phase=identity/);
  assert.ok(!text.includes(MARKER), 'installed id echoed');
});

// --- L1: --check is one REPEATABLE READ READ ONLY snapshot, locked before it is taken ---
// What these tests prove is STRUCTURAL: statement text and order on a fake client.
// That the reads then share one snapshot, and that LOCK/SET take no snapshot, is
// PostgreSQL behaviour the fake cannot reproduce; it is relied on, not simulated.

test('L1/C1/C16: --check opens REPEATABLE READ READ ONLY and runs in the exact order', async () => {
  const client = fakeClient({ state: existing([row('pilot', MARKER)]) });
  const { code, text } = await run(CHECK, { client });
  assert.equal(code, 0, text);
  const expected = [
    'CONNECT', 'BEGIN ISOLATION LEVEL', 'SET LOCAL search_path', 'SET LOCAL lock_timeout', 'SET LOCAL statement_timeout',
    'LOCK TABLE mona_pilot_guard.database_identity', "SELECT to_regnamespace('mona_pilot_guard')",
    'SELECT json_build_object(', 'SELECT environment, marker_id::text', 'ROLLBACK', 'END',
  ];
  assert.equal(client.calls.length, expected.length, client.calls.join(' | '));
  expected.forEach((prefix, i) => assert.ok(client.calls[i].startsWith(prefix), `#${i}: ${client.calls[i]} !~ ${prefix}`));
  assert.equal(client.sql[0], CHECK_BEGIN);
  assert.equal(client.sql[4], CHECK_LOCK);
});

test('L1/C2: the ACCESS SHARE lock precedes the first snapshot-taking statement', async () => {
  const client = fakeClient({ state: existing([row('pilot', MARKER)]) });
  await run(CHECK, { client });
  const lock = client.sql.indexOf(CHECK_LOCK);
  const firstRead = client.sql.findIndex(isRead);
  assert.ok(lock > 0 && firstRead > lock, client.sql.map((q) => q.split('\n')[0]).join(' | '));
  // Everything before the first read is BEGIN, SET LOCAL or LOCK (none takes a snapshot).
  for (const q of client.sql.slice(0, firstRead)) assert.match(q, /^(BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY|SET LOCAL |LOCK TABLE )/);
});

test('L1/C3/C4: all three identity reads happen inside one transaction, which is rolled back', async () => {
  const client = fakeClient({ state: existing([row('pilot', MARKER)]) });
  await run(CHECK, { client });
  const reads = client.sql.map((q, i) => (isRead(q) ? i : -1)).filter((i) => i >= 0);
  assert.equal(reads.length, 3);
  const between = client.sql.slice(reads[0], reads.at(-1) + 1);
  assert.ok(!between.some((q) => /^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|SET TRANSACTION)/.test(q)), 'transaction boundary between reads');
  assert.equal(client.sql.filter((q) => q.startsWith('BEGIN')).length, 1);
  assert.equal(client.sql.at(-1), 'ROLLBACK');
  assert.ok(!client.sql.some((q) => /^(COMMIT|INSERT|CREATE|COMMENT)/.test(q)));
});

test('L1/C5/C14: a foreign row read after canonical facts fails identity without echoing it', async () => {
  const client = fakeClient({ state: existing([row('pilot', OTHER)]) });
  const { code, text } = await run(CHECK, { client });
  assert.equal(code, 1);
  assert.match(text, /phase=identity/);
  assert.ok(!text.includes(OTHER));
  assert.deepEqual(client.calls.slice(-2), ['ROLLBACK', 'END']);
});

test('L1/C8/C9: a failing (isolation-setting) BEGIN is fatal, never retried at a weaker level', async () => {
  for (const failCode of ['0A000', '25001', '08006']) {
    const client = fakeClient({ state: existing([row('pilot', MARKER)]), failOn: 'BEGIN', failCode });
    const { code, text } = await run(CHECK, { client });
    assert.equal(code, 1, failCode);
    assert.match(text, new RegExp(`phase=inspect code=${failCode}`));
    assert.deepEqual(client.calls, ['CONNECT', 'BEGIN ISOLATION LEVEL', 'END'], failCode);
    assertNoLeak(text);
  }
});

test('L1/C10: a failing search_path pin rolls back before any read', async () => {
  const client = fakeClient({ state: existing([row('pilot', MARKER)]), failOn: 'search_path' });
  const { code } = await run(CHECK, { client });
  assert.equal(code, 1);
  assert.ok(!client.sql.some(isRead));
  assert.deepEqual(client.calls.slice(-2), ['ROLLBACK', 'END']);
});

test('L1/C11: an absent marker (LOCK → 42P01 / 3F000) is reported as not installed', async () => {
  for (const state of [ABSENT, { ...ABSENT, schemaExists: true }]) {
    const client = fakeClient({ state });
    const { code, text } = await run(CHECK, { client });
    assert.equal(code, 1);
    assert.match(text, /phase=identity .*not installed/);
    assert.ok(!client.sql.some(isRead));
    assert.deepEqual(client.calls.slice(-2), ['ROLLBACK', 'END']);
    assertNoLeak(text);
  }
});

test('L1/C12: any other LOCK failure (e.g. lock_timeout) is NOT misreported as "not installed"', async () => {
  const client = fakeClient({ state: existing([row('pilot', MARKER)]), failOn: 'LOCK TABLE', failCode: '55P03' });
  const { code, text } = await run(CHECK, { client });
  assert.equal(code, 1);
  assert.match(text, /phase=inspect code=55P03/);
  assert.doesNotMatch(text, /not installed/);
});

test('L1/C13: ROLLBACK failing after an otherwise canonical check fails closed', async () => {
  const client = fakeClient({ state: existing([row('pilot', MARKER)]), rollbackThrows: true });
  const { code, text } = await run(CHECK, { client });
  assert.equal(code, 1);
  assert.doesNotMatch(text, /OK/);
  assert.equal(client.calls.at(-1), 'END');
  assertNoLeak(text);
});

test('L1/C15: a TEST marker schema on the target fails --check', async () => {
  const client = fakeClient({ state: { ...existing([row('pilot', MARKER)]), testGuardExists: true } });
  const { code, text } = await run(CHECK, { client });
  assert.equal(code, 1);
  assert.match(text, /phase=identity/);
});

test('L1/C17: --execute keeps its READ COMMITTED transaction with the SHARE lock after inspect', async () => {
  for (const state of [ABSENT, existing([row('pilot', MARKER)]), existing([row('pilot', OTHER)])]) {
    const client = fakeClient({ state });
    await run(EXECUTE, { client });
    assert.equal(client.sql[0], 'BEGIN');
    assert.ok(!client.sql.some((q) => /REPEATABLE READ|READ ONLY|ACCESS SHARE/.test(q)));
    const firstRead = client.sql.findIndex(isRead);
    const lock = client.sql.indexOf(`LOCK TABLE ${QUALIFIED} IN SHARE MODE`);
    if (lock !== -1) assert.ok(lock > firstRead, 'execute lock stays after inspect');
  }
});

// --- cleanup never replaces an established outcome ----------------------------------------
//
// `cleanupWrapped` makes ROLLBACK a NON-async call so 'throw' is a genuine
// synchronous throw (the case an eager `.catch()` cannot see); 'reject' is an async
// rejection and 'string' a non-Error value. Every cleanup error carries the URL.
function cleanupWrapped(base, rollback) {
  return {
    ...base,
    calls: base.calls,
    sql: base.sql,
    connection: base.connection,
    connect: () => base.connect(),
    end: () => base.end(),
    query(q, values) {
      const text = typeof q === 'string' ? q : q.text;
      if (text === 'ROLLBACK') {
        base.calls.push('ROLLBACK');
        if (rollback === 'throw') throw Object.assign(new Error(`rollback threw ${URL_TEXT}`), { code: '08006' });
        if (rollback === 'reject') return Promise.reject(Object.assign(new Error(`rollback rejected ${URL_TEXT}`), { code: '08006' }));
        if (rollback === 'string') return Promise.reject(`rollback string ${URL_TEXT}`);
        return Promise.resolve({ rows: [] });
      }
      return base.query(q, values);
    },
  };
}
const RB_MODES = ['reject', 'throw', 'string'];
async function contained(argv, client) {
  let result;
  try {
    result = await run(argv, { client });
  } catch (err) {
    assert.fail(`main() must resolve; a cleanup exception escaped: ${String(err?.message ?? err).slice(0, 24)}`);
  }
  assertNoLeak(result.text);
  assert.ok(!/rollback (threw|rejected|string)|08006/.test(result.text), 'cleanup error surfaced');
  return result;
}

test('K16b: an --execute conflict keeps its reason whatever the ROLLBACK does', async () => {
  for (const rb of RB_MODES) {
    const { code, text } = await contained(EXECUTE, cleanupWrapped(fakeClient({ state: existing([row('pilot', OTHER)]) }), rb));
    assert.equal(code, 1, rb);
    assert.match(text, /phase=conflict — a different marker id is installed; nothing was changed/, `${rb}: ${text}`);
  }
});

test('K16c: a thrown install error keeps its phase and code when the cleanup ROLLBACK fails', async () => {
  for (const rb of RB_MODES) {
    const { code, text } = await contained(EXECUTE, cleanupWrapped(fakeClient({ failOn: 'CREATE SCHEMA', failCode: '42P07' }), rb));
    assert.equal(code, 1, rb);
    assert.match(text, /phase=install code=42P07 — transaction not committed/, `${rb}: ${text}`);
  }
});

test('K16d: a failed post-install verification stays authoritative and never claims "rolled back" unconfirmed', async () => {
  const bad = { ...canonicalFacts(), table: { ...canonicalFacts().table, triggers: 1 } };
  for (const rb of RB_MODES) {
    const client = cleanupWrapped(fakeClient({ installedFacts: bad }), rb);
    const { code, text } = await contained(EXECUTE, client);
    assert.equal(code, 1, rb);
    assert.match(text, /phase=verify — installed marker failed canonical verification/, `${rb}: ${text}`);
    assert.match(text, /not committed \(ROLLBACK unconfirmed; connection closed without COMMIT\)/, rb);
    assert.ok(!client.calls.includes('COMMIT'));
  }
});

test('K16a: --check and idempotent --execute are trusted only with a confirmed ROLLBACK', async () => {
  for (const rb of RB_MODES) {
    const check = await contained(CHECK, cleanupWrapped(fakeClient({ state: existing([row('pilot', MARKER)]) }), rb));
    assert.equal(check.code, 1, rb);
    assert.match(check.text, /phase=identity — the marker proof transaction could not be rolled back; proof not trusted; nothing was changed/, `${rb}: ${check.text}`);
    const idem = await contained(EXECUTE, cleanupWrapped(fakeClient({ state: existing([row('pilot', MARKER)]) }), rb));
    assert.equal(idem.code, 1, rb);
    assert.match(idem.text, /phase=inspect — the read transaction could not be rolled back; nothing was changed/, `${rb}: ${idem.text}`);
  }
  const ok = await contained(CHECK, cleanupWrapped(fakeClient({ state: existing([row('pilot', MARKER)]) }), 'ok'));
  assert.equal(ok.code, 0, 'control: a confirmed ROLLBACK keeps the verified check');
});

test('K16e: an absent marker on --check stays "not installed" whatever the ROLLBACK does', async () => {
  for (const rb of RB_MODES) {
    const { code, text } = await contained(CHECK, cleanupWrapped(fakeClient({ state: { ...ABSENT, schemaExists: true } }), rb));
    assert.equal(code, 1, rb);
    assert.match(text, /phase=identity — PILOT marker is not installed; nothing was changed/, `${rb}: ${text}`);
  }
});

test('K16f: every ROLLBACK is lazily contained in the source (no bare or eager cleanup)', () => {
  const source = readFileSync(new URL('./pilot-marker.mjs', import.meta.url), 'utf8');
  const code = source.split('\n').filter((line) => !line.trimStart().startsWith('//')).join('\n');
  for (const m of code.matchAll(/client\.query\('ROLLBACK'\)/g)) {
    assert.ok(code.slice(Math.max(0, m.index - 20), m.index).endsWith('contained(() => '), 'uncontained ROLLBACK');
  }
  assert.ok(!/\.query\([^)]*\)\.catch\(/.test(code), 'no eager query(...).catch()');
});
