// Zero-database unit tests for scripts/database/local-test-marker.mjs.
// Run with: node --test scripts/database/local-test-marker.test.mjs
// Every connection below is an injected fake: no test constructs a real pg
// client, opens a socket or reads the real environment. Hostile DEV/TEST URLs
// are synthetic (*.invalid) and must never influence the target.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CONFIRM_LOCAL_TARGET,
  ENVIRONMENT,
  GUARD_SCHEMA,
  GUARD_TABLE,
  INSPECT_SQL,
  LIVE_FACTS_SQL,
  MARKER_FACTS_SQL,
  MARKER_ROWS_SQL,
  MARKER_VAR,
  MIN_PG_MAJOR,
  QUALIFIED,
  URL_VAR,
  assertLiveFacts,
  buildInstallStatements,
  decideInstall,
  main,
  parseCliArgs,
  readLocalTestMarkerConfig,
  verifyMarkerStructure,
} from './local-test-marker.mjs';

const MARKER = '6d2f9a41-8c3b-4e5d-9f7a-1b2c3d4e5f60';
const OTHER = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const SECRET = 'L0calS3cret-pw';
const URL_TEXT = `postgresql://mona_local_test:${SECRET}@127.0.0.1:5432/mona_local_test`;
const CONFIRMATION = 'mona_local_test@127.0.0.1:5432/mona_local_test';
const HOSTILE_DEV = 'postgresql://postgres.devhostileaaaaaaaaaa:DevHostilePw@dev-hostile.invalid:5432/postgres';
const HOSTILE_TEST = 'postgresql://postgres.testhostileaaaaaaaaa:TestHostilePw@test-hostile.invalid:5432/postgres';
const LEAKS = [SECRET, URL_TEXT, 'DevHostilePw', 'TestHostilePw', 'dev-hostile.invalid', 'test-hostile.invalid'];
const ENV = Object.freeze({ [URL_VAR]: URL_TEXT, [MARKER_VAR]: MARKER });
const CONN = Object.freeze({ host: '127.0.0.1', port: 5432, database: 'mona_local_test', user: 'mona_local_test', password: SECRET });

const DRY = ['--dry-run', `--marker-id=${MARKER}`];
const CHECK = ['--check', `--marker-id=${MARKER}`];
const EXECUTE = ['--execute', `--marker-id=${MARKER}`, `--confirm-local-target=${CONFIRMATION}`];

// Every SQL class the installer must never send (marker replacement, cleanup,
// hidden partial state, role/database provisioning, privileges).
const FORBIDDEN_SQL =
  /\b(DROP|DELETE|UPDATE|TRUNCATE|GRANT|REVOKE|MERGE)\b|\bON\s+CONFLICT\b|\bIF\s+NOT\s+EXISTS\b|\bCREATE\s+(DATABASE|ROLE|USER)\b|\bALTER\b/i;
const WRITE_SQL = /^\s*(CREATE|INSERT|COMMENT)\b/i;
const READ_ONLY_SQL = /^\s*(BEGIN\b.*READ ONLY|SET LOCAL\b|SELECT\b|LOCK TABLE\b.*ACCESS SHARE MODE|ROLLBACK)\b/is;

function assertNoLeak(text) {
  for (const leak of LEAKS) assert.ok(!text.includes(leak), 'output leaked a secret or a hostile target');
}

// Hand-written catalog facts for the canonical LOCAL_TEST marker (not derived
// from the module, so drift on either side is caught).
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
      { type: 'c', definition: "CHECK ((environment = 'local_test'::text))" },
    ],
  };
}
const row = (environment, markerId, hasInstalledAt = true) => ({ environment, marker_id: markerId, has_installed_at: hasInstalledAt });
const ABSENT = { schemaExists: false, tableExists: false, rows: [] };
const existing = (rows, facts = canonicalFacts()) => ({ schemaExists: true, tableExists: true, facts, rows });
const LIVE = Object.freeze({
  current_database: 'mona_local_test',
  current_user: 'mona_local_test',
  version: 'PostgreSQL 17.6 (Debian 17.6-1.pgdg130+1) on x86_64-pc-linux-gnu, 64-bit',
  test_guard_exists: false,
  pilot_guard_exists: false,
});
const liveFacts = (overrides = {}) => ({
  currentDatabase: 'mona_local_test',
  currentUser: 'mona_local_test',
  version: 'PostgreSQL 17.6 (Debian 17.6-1.pgdg130+1) on x86_64-pc-linux-gnu, 64-bit',
  testGuardExists: false,
  pilotGuardExists: false,
  ...overrides,
});

// A scripted connection: answers the module's exported read SQL by exact text,
// records every statement, and becomes "installed" after an INSERT.
function fakeClient({
  live = LIVE,
  state = ABSENT,
  installedFacts = canonicalFacts(),
  failOn,
  failCode = '23514',
  connectError,
  rollbackThrows = false,
  commitThrows = false,
  endThrows = false,
} = {}) {
  const calls = [];
  const sql = [];
  let installed = null;
  const current = () => installed ?? state;
  const boom = (label, code = '57014') => Object.assign(new Error(`${label} ${URL_TEXT}`), { code });
  return {
    calls,
    sql,
    current,
    async connect() {
      calls.push('CONNECT');
      if (connectError !== undefined) throw connectError;
    },
    async query(q, values) {
      const text = typeof q === 'string' ? q : q.text;
      const params = typeof q === 'string' ? values : q.values;
      sql.push(text);
      calls.push(text.trim().split(/\s+/).slice(0, 2).join(' '));
      if (failOn && text.includes(failOn)) throw boom('boom', failCode);
      if (text === 'ROLLBACK' && rollbackThrows) throw boom('rollback');
      if (text === 'COMMIT' && commitThrows) throw boom('commit');
      if (text === LIVE_FACTS_SQL) return { rows: [live] };
      if (text === INSPECT_SQL) return { rows: [{ schema_exists: current().schemaExists, table_exists: current().tableExists }] };
      // Real PostgreSQL: LOCK on an absent relation fails (42P01 table, 3F000 schema).
      if (/^LOCK TABLE/.test(text) && !current().tableExists) throw boom('missing', current().schemaExists ? '42P01' : '3F000');
      if (text === MARKER_FACTS_SQL) return { rows: [{ facts: current().facts ?? null }] };
      if (text === MARKER_ROWS_SQL) return { rows: current().rows };
      if (/^INSERT\b/.test(text)) installed = existing([row(ENVIRONMENT, params?.[0])], installedFacts);
      return { rows: [] };
    },
    async end() {
      calls.push('END');
      if (endThrows) throw boom('end');
    },
  };
}

async function run(argv, { env = ENV, client = fakeClient(), createThrows } = {}) {
  const out = [];
  const err = [];
  const created = [];
  const code = await main(argv, {
    env,
    createClient: (conn) => {
      created.push(conn);
      if (createThrows) throw createThrows;
      return client;
    },
    log: (line) => out.push(line),
    error: (line) => err.push(line),
  });
  const text = [...out, ...err].join('\n');
  return { code, out: out.join('\n'), err: err.join('\n'), text, created, client };
}

const indexOf = (sql, predicate) => sql.findIndex(predicate);
const writes = (sql) => sql.filter((s) => WRITE_SQL.test(s));

// ---------------------------------------------------------------------------
// Module surface

test('exports the LOCAL_TEST marker identity constants', () => {
  assert.equal(GUARD_SCHEMA, 'mona_local_test_guard');
  assert.equal(GUARD_TABLE, 'database_identity');
  assert.equal(QUALIFIED, 'mona_local_test_guard.database_identity');
  assert.equal(ENVIRONMENT, 'local_test');
  assert.equal(URL_VAR, 'LOCAL_TEST_DATABASE_URL');
  assert.equal(MARKER_VAR, 'LOCAL_TEST_DATABASE_MARKER_ID');
  assert.equal(MIN_PG_MAJOR, 17);
});

test('the --execute attestation is the fixed, non-secret LOCAL_TEST target string', () => {
  assert.equal(CONFIRM_LOCAL_TARGET, CONFIRMATION);
});

test('the module source loads no DEV/TEST target, prepare, Prisma or subprocess code', () => {
  const source = readFileSync(new URL('./local-test-marker.mjs', import.meta.url), 'utf8');
  const specifiers = [...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]|\brequire\s*\(\s*['"]([^'"]+)['"]/g)]
    .map((m) => m[1] ?? m[2] ?? m[3]);
  assert.deepEqual(specifiers.filter((s) => !s.startsWith('node:') && s !== 'pg'), []);
  assert.ok(!specifiers.includes('node:child_process'), 'no subprocess module');
  assert.doesNotMatch(source, /local-test-prepare|demo-database|@prisma|generated\/prisma/);
  // Target selectors of other environments are never read, whatever the accessor.
  const other = 'DATABASE_URL|TEST_DATABASE_URL|DIRECT_URL|MONA_TEST_DATABASE_TARGET|PGHOST|PGPORT|PGUSER|PGPASSWORD|PGDATABASE|PGSSLMODE';
  assert.doesNotMatch(source, new RegExp(`\\.(${other})\\b|\\[\\s*['"](${other})['"]\\s*\\]`));
});

// ---------------------------------------------------------------------------
// Argument / mode contract

test('parseCliArgs accepts exactly one mode with a canonical marker id, and the confirmation only with --execute', () => {
  assert.deepEqual(parseCliArgs(DRY), { ok: true, mode: 'dry-run', markerId: MARKER, confirm: null });
  assert.deepEqual(parseCliArgs(CHECK), { ok: true, mode: 'check', markerId: MARKER, confirm: null });
  assert.deepEqual(parseCliArgs(EXECUTE), { ok: true, mode: 'execute', markerId: MARKER, confirm: CONFIRMATION });
});

for (const [label, argv] of [
  ['no mode', [`--marker-id=${MARKER}`]],
  ['two different modes', ['--dry-run', '--execute', `--marker-id=${MARKER}`, `--confirm-local-target=${CONFIRMATION}`]],
  ['the same mode twice', ['--execute', '--execute', `--marker-id=${MARKER}`, `--confirm-local-target=${CONFIRMATION}`]],
  ['an unknown argument', [...DRY, '--target=local']],
  ['a positional argument', [...DRY, 'extra']],
  ['a space-separated marker id', ['--dry-run', '--marker-id', MARKER]],
  ['a missing --marker-id', ['--dry-run']],
  ['an empty --marker-id', ['--dry-run', '--marker-id=']],
  ['a non-v4 --marker-id', ['--dry-run', '--marker-id=6d2f9a41-8c3b-1e5d-9f7a-1b2c3d4e5f60']],
  ['an uppercase --marker-id', ['--dry-run', `--marker-id=${MARKER.toUpperCase()}`]],
  ['a duplicated --marker-id', [...DRY, `--marker-id=${MARKER}`]],
  ['--execute without the confirmation', ['--execute', `--marker-id=${MARKER}`]],
  ['--execute with an empty confirmation', ['--execute', `--marker-id=${MARKER}`, '--confirm-local-target=']],
  ['--execute confirming another database', ['--execute', `--marker-id=${MARKER}`, '--confirm-local-target=mona_local_test@127.0.0.1:5432/postgres']],
  ['--execute confirming localhost', ['--execute', `--marker-id=${MARKER}`, '--confirm-local-target=mona_local_test@localhost:5432/mona_local_test']],
  ['--execute with a padded confirmation', ['--execute', `--marker-id=${MARKER}`, `--confirm-local-target=${CONFIRMATION} `]],
  ['--execute with an uppercase confirmation', ['--execute', `--marker-id=${MARKER}`, `--confirm-local-target=${CONFIRMATION.toUpperCase()}`]],
  ['--execute confirming with the marker id', ['--execute', `--marker-id=${MARKER}`, `--confirm-local-target=${MARKER}`]],
  ['--execute with a duplicated confirmation', [...EXECUTE, `--confirm-local-target=${CONFIRMATION}`]],
  ['the confirmation with --dry-run', [...DRY, `--confirm-local-target=${CONFIRMATION}`]],
  ['the confirmation with --check', [...CHECK, `--confirm-local-target=${CONFIRMATION}`]],
]) {
  test(`parseCliArgs refuses ${label}`, () => {
    const parsed = parseCliArgs(argv);
    assert.equal(parsed.ok, false);
    assert.equal(typeof parsed.error, 'string');
    assert.ok(!parsed.error.includes(MARKER.toUpperCase()), 'rejected values are not echoed');
  });
}

// ---------------------------------------------------------------------------
// LOCAL_TEST URL and marker-id configuration contract

for (const [label, url, password] of [
  ['canonical postgresql:', URL_TEXT, SECRET],
  ['canonical postgres:', URL_TEXT.replace(/^postgresql:/, 'postgres:'), SECRET],
  ['a valid percent-encoded password', URL_TEXT.replace(SECRET, 'p%40ss%2Fw%20rd'), 'p@ss/w rd'],
]) {
  test(`readLocalTestMarkerConfig accepts ${label} and yields discrete loopback fields`, () => {
    const config = readLocalTestMarkerConfig({ ...ENV, [URL_VAR]: url });
    assert.equal(config.ok, true);
    assert.equal(config.markerId, MARKER);
    assert.deepEqual(config.conn, { ...CONN, password });
  });
}

test('readLocalTestMarkerConfig ignores DATABASE_URL, TEST_DATABASE_URL, DIRECT_URL, MONA_TEST_DATABASE_TARGET and PG*', () => {
  const config = readLocalTestMarkerConfig({
    ...ENV,
    DATABASE_URL: HOSTILE_DEV,
    TEST_DATABASE_URL: HOSTILE_TEST,
    TEST_DATABASE_MARKER_ID: OTHER,
    DIRECT_URL: HOSTILE_DEV,
    MONA_TEST_DATABASE_TARGET: 'test',
    PGHOST: 'dev-hostile.invalid',
    PGPORT: '6543',
    PGUSER: 'postgres',
    PGPASSWORD: 'DevHostilePw',
    PGDATABASE: 'postgres',
    PGSSLMODE: 'require',
  });
  assert.equal(config.ok, true);
  assert.equal(config.markerId, MARKER);
  assert.deepEqual(config.conn, CONN);
});

for (const [label, env] of [
  ['a missing URL', { [MARKER_VAR]: MARKER }],
  ['a missing URL with hostile DATABASE_URL/TEST_DATABASE_URL', { [MARKER_VAR]: MARKER, DATABASE_URL: HOSTILE_DEV, TEST_DATABASE_URL: HOSTILE_TEST }],
  ['an empty URL', { ...ENV, [URL_VAR]: '' }],
  ['an unparsable URL', { ...ENV, [URL_VAR]: 'not a url' }],
  ['a remote host', { ...ENV, [URL_VAR]: URL_TEXT.replace('127.0.0.1', 'db.example.invalid') }],
  ['a hosted Supabase target', { ...ENV, [URL_VAR]: HOSTILE_TEST }],
  ['a localhost alias', { ...ENV, [URL_VAR]: URL_TEXT.replace('127.0.0.1', 'localhost') }],
  ['IPv6 loopback', { ...ENV, [URL_VAR]: URL_TEXT.replace('127.0.0.1', '[::1]') }],
  ['a wrong port', { ...ENV, [URL_VAR]: URL_TEXT.replace(':5432/', ':5433/') }],
  ['a wrong database', { ...ENV, [URL_VAR]: URL_TEXT.replace(/\/mona_local_test$/, '/postgres') }],
  ['a wrong user', { ...ENV, [URL_VAR]: URL_TEXT.replace('//mona_local_test:', '//postgres:') }],
  ['a missing password', { ...ENV, [URL_VAR]: 'postgresql://mona_local_test@127.0.0.1:5432/mona_local_test' }],
  ['an empty password', { ...ENV, [URL_VAR]: 'postgresql://mona_local_test:@127.0.0.1:5432/mona_local_test' }],
  ['a query string', { ...ENV, [URL_VAR]: `${URL_TEXT}?sslmode=disable` }],
  ['a fragment', { ...ENV, [URL_VAR]: `${URL_TEXT}#x` }],
  ['a leading space', { ...ENV, [URL_VAR]: ` ${URL_TEXT}` }],
  ['a trailing newline', { ...ENV, [URL_VAR]: `${URL_TEXT}\n` }],
  ['an embedded tab', { ...ENV, [URL_VAR]: URL_TEXT.replace('127.0.0.1', '127.0.\t0.1') }],
  ['an uppercase scheme', { ...ENV, [URL_VAR]: URL_TEXT.replace(/^postgresql:/, 'POSTGRESQL:') }],
  ['a zero-padded port', { ...ENV, [URL_VAR]: URL_TEXT.replace(':5432/', ':05432/') }],
  ['a percent-encoded username', { ...ENV, [URL_VAR]: URL_TEXT.replace('//mona_local_test:', '//mona%5Flocal%5Ftest:') }],
  ['a missing marker id', { [URL_VAR]: URL_TEXT }],
  ['a non-v4 marker id', { ...ENV, [MARKER_VAR]: '6d2f9a41-8c3b-1e5d-9f7a-1b2c3d4e5f60' }],
  ['an uppercase marker id', { ...ENV, [MARKER_VAR]: MARKER.toUpperCase() }],
  ['a padded marker id', { ...ENV, [MARKER_VAR]: ` ${MARKER}` }],
  ['PGOPTIONS set', { ...ENV, PGOPTIONS: '-c search_path=evil' }],
  ['PGOPTIONS set but empty', { ...ENV, PGOPTIONS: '' }],
]) {
  test(`readLocalTestMarkerConfig refuses ${label} without echoing it`, () => {
    const config = readLocalTestMarkerConfig(env);
    assert.equal(config.ok, false);
    assert.equal(typeof config.reason, 'string');
    assertNoLeak(config.reason);
  });
}

// ---------------------------------------------------------------------------
// Independent live facts (before any marker exists)

for (const version of ['PostgreSQL 17.0', 'PostgreSQL 17.6 (Debian 17.6-1.pgdg130+1) on x86_64-pc-linux-gnu, 64-bit', 'PostgreSQL 18.1']) {
  test(`assertLiveFacts accepts the canonical LOCAL_TEST facts on ${JSON.stringify(version)}`, () => {
    assert.equal(assertLiveFacts(liveFacts({ version })), null);
  });
}

for (const [label, overrides] of [
  ['a wrong current_database', { currentDatabase: 'postgres' }],
  ['a wrong current_user', { currentUser: 'postgres' }],
  ['PostgreSQL 16', { version: 'PostgreSQL 16.9 (Debian 16.9-1) on x86_64-pc-linux-gnu, 64-bit' }],
  ['PostgreSQL 15', { version: 'PostgreSQL 15.14' }],
  ['an unparseable version', { version: 'unknown' }],
  ['a padded version', { version: ' PostgreSQL 17.6' }],
  ['a TEST guard schema', { testGuardExists: true }],
  ['a PILOT guard schema', { pilotGuardExists: true }],
  ['an unknown TEST guard state', { testGuardExists: undefined }],
  ['an unknown PILOT guard state', { pilotGuardExists: null }],
]) {
  test(`assertLiveFacts refuses ${label}`, () => {
    const reason = assertLiveFacts(liveFacts(overrides));
    assert.equal(typeof reason, 'string');
  });
}

// ---------------------------------------------------------------------------
// Canonical structure and the install decision matrix

test('verifyMarkerStructure accepts the canonical LOCAL_TEST marker structure', () => {
  assert.equal(verifyMarkerStructure(canonicalFacts()), null);
});

for (const [label, mutate] of [
  ['unreadable facts', () => null],
  ['a schema owned by another role', (f) => ({ ...f, schemaOwnerIsCurrentUser: false })],
  ['a table owned by another role', (f) => ({ ...f, table: { ...f.table, ownerIsCurrentUser: false } })],
  ['row-level security', (f) => ({ ...f, table: { ...f.table, rowSecurity: true } })],
  ['a trigger', (f) => ({ ...f, table: { ...f.table, triggers: 1 } })],
  ['an unlogged table', (f) => ({ ...f, table: { ...f.table, persistence: 'u' } })],
  ['a view instead of a table', (f) => ({ ...f, table: { ...f.table, kind: 'v' } })],
  ['an extra column', (f) => ({ ...f, columns: [...f.columns, { name: 'note', type: 'text', notNull: false, default: null, generated: '', identity: '', collation: 'default' }] })],
  ['a text marker_id', (f) => ({ ...f, columns: f.columns.map((c) => (c.name === 'marker_id' ? { ...c, type: 'text', collation: 'default' } : c)) })],
  ['the TEST environment check', (f) => ({ ...f, constraints: f.constraints.map((c) => (c.type === 'c' && c.definition.includes('environment') ? { ...c, definition: "CHECK ((environment = 'test'::text))" } : c)) })],
  ['a missing primary key', (f) => ({ ...f, constraints: f.constraints.filter((c) => c.type !== 'p') })],
  ['an extra relation in the schema', (f) => ({ ...f, relations: [...f.relations, { name: 'shadow', kind: 'v' }] })],
]) {
  test(`verifyMarkerStructure refuses ${label}`, () => {
    assert.equal(typeof verifyMarkerStructure(mutate(canonicalFacts())), 'string');
  });
}

test('decideInstall installs only when the schema and table are both absent', () => {
  assert.deepEqual(decideInstall(ABSENT, MARKER), { action: 'install' });
});

test('decideInstall treats the exact canonical marker as an idempotent no-op', () => {
  assert.equal(decideInstall(existing([row('local_test', MARKER)]), MARKER).action, 'already-installed');
});

for (const [label, state] of [
  ['a schema without the table', { schemaExists: true, tableExists: false, rows: [] }],
  ['a table without the schema flag', { schemaExists: false, tableExists: true, facts: canonicalFacts(), rows: [row('local_test', MARKER)] }],
  ['a different marker id', existing([row('local_test', OTHER)])],
  ['the TEST environment', existing([row('test', MARKER)])],
  ['the PILOT environment', existing([row('pilot', MARKER)])],
  ['two rows', existing([row('local_test', MARKER), row('local_test', MARKER)])],
  ['zero rows', existing([])],
  ['a missing installed_at', existing([row('local_test', MARKER, false)])],
  ['a non-canonical structure', existing([row('local_test', MARKER)], { ...canonicalFacts(), schemaOwnerIsCurrentUser: false })],
]) {
  test(`decideInstall refuses ${label} as a conflict`, () => {
    const decision = decideInstall(state, MARKER);
    assert.equal(decision.action, 'conflict');
    assert.equal(typeof decision.reason, 'string');
  });
}

// ---------------------------------------------------------------------------
// Install plan / SQL safety

test('buildInstallStatements is the additive canonical plan with the marker id as a bound parameter', () => {
  const plan = buildInstallStatements(MARKER);
  const texts = plan.map((s) => s.text);
  assert.equal(texts[0], 'CREATE SCHEMA mona_local_test_guard');
  assert.match(texts[1], /^CREATE TABLE mona_local_test_guard\.database_identity \(/);
  for (const ddl of [
    'singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton)',
    "environment text NOT NULL CHECK (environment = 'local_test')",
    'marker_id uuid NOT NULL',
    'installed_at timestamptz NOT NULL DEFAULT now()',
  ]) assert.ok(texts[1].includes(ddl), `canonical column: ${ddl}`);
  const insert = plan.find((s) => /^INSERT\b/.test(s.text));
  assert.equal(insert?.text, "INSERT INTO mona_local_test_guard.database_identity (environment, marker_id) VALUES ('local_test', $1)");
  assert.deepEqual(insert?.values, [MARKER]);
  for (const text of texts) assert.ok(!text.includes(MARKER), 'the marker id is never interpolated into SQL');
});

test('the install plan contains only additive marker SQL', () => {
  const plan = buildInstallStatements(MARKER);
  assert.ok(plan.length >= 3, 'the plan is non-empty');
  for (const { text } of plan) {
    assert.doesNotMatch(text, FORBIDDEN_SQL);
    assert.match(text, WRITE_SQL);
    assert.ok(text.includes(GUARD_SCHEMA), 'every write targets the LOCAL_TEST guard schema only');
  }
});

// ---------------------------------------------------------------------------
// --dry-run

test('--dry-run with any arguments never creates a database client (scaffold safety)', async () => {
  for (const argv of [DRY, [...DRY, `--confirm-local-target=${CONFIRMATION}`], ['--dry-run']]) {
    const result = await run(argv);
    assert.equal(result.created.length, 0);
  }
});

test('--dry-run validates everything, prints the plan and the marker id, and connects nothing', async () => {
  const result = await run(DRY);
  assert.equal(result.code, 0);
  assert.equal(result.created.length, 0);
  assert.match(result.out, /DRY RUN/);
  assert.ok(result.out.includes(MARKER), 'the marker id is a printable identity token');
  assert.ok(result.out.includes('CREATE SCHEMA mona_local_test_guard'), 'the plan is shown');
  assertNoLeak(result.text);
});

test('--dry-run refuses an invalid configuration without connecting', async () => {
  const result = await run(DRY, { env: { ...ENV, [URL_VAR]: HOSTILE_TEST } });
  assert.equal(result.code, 1);
  assert.equal(result.created.length, 0);
  assertNoLeak(result.text);
});

// ---------------------------------------------------------------------------
// --check (read-only)

test('--check proves an exact marker read-only and never writes or commits', async () => {
  const client = fakeClient({ state: existing([row('local_test', MARKER)]) });
  const result = await run(CHECK, { client });
  assert.equal(result.code, 0);
  assert.deepEqual(result.created, [CONN]);
  assert.match(client.sql[0], /^BEGIN\b.*READ ONLY/);
  for (const text of client.sql) assert.match(text, READ_ONLY_SQL);
  assert.ok(client.sql.includes(LIVE_FACTS_SQL), 'live facts are checked');
  assert.equal(client.sql.at(-1), 'ROLLBACK');
  assert.ok(client.calls.includes('END'));
  assertNoLeak(result.text);
});

for (const [label, options] of [
  ['an absent marker', { state: ABSENT }],
  ['a different marker id', { state: existing([row('local_test', OTHER)]) }],
  ['a foreign TEST guard', { state: existing([row('local_test', MARKER)]), live: { ...LIVE, test_guard_exists: true } }],
  ['PostgreSQL 16', { state: existing([row('local_test', MARKER)]), live: { ...LIVE, version: 'PostgreSQL 16.9' } }],
]) {
  test(`--check fails for ${label} and still writes nothing`, async () => {
    const client = fakeClient(options);
    const result = await run(CHECK, { client });
    assert.equal(result.code, 1);
    assert.ok(client.sql.length > 0, 'the check actually ran');
    for (const text of client.sql) assert.match(text, READ_ONLY_SQL);
    assert.ok(!client.sql.includes('COMMIT'));
    assertNoLeak(result.text);
  });
}

// ---------------------------------------------------------------------------
// --execute: gates before any connection

for (const [label, argv, env] of [
  ['a missing confirmation', ['--execute', `--marker-id=${MARKER}`], ENV],
  ['a wrong confirmation', ['--execute', `--marker-id=${MARKER}`, '--confirm-local-target=mona_local_test@127.0.0.1:5432/postgres'], ENV],
  ['a CLI marker id that differs from the pinned env marker id', ['--execute', `--marker-id=${OTHER}`, `--confirm-local-target=${CONFIRMATION}`], ENV],
  ['a missing pinned env marker id', EXECUTE, { [URL_VAR]: URL_TEXT }],
  ['a non-canonical URL', EXECUTE, { ...ENV, [URL_VAR]: ` ${URL_TEXT}` }],
  ['a remote URL', EXECUTE, { ...ENV, [URL_VAR]: HOSTILE_DEV }],
  ['PGOPTIONS set', EXECUTE, { ...ENV, PGOPTIONS: '-c search_path=evil' }],
]) {
  test(`--execute refuses ${label} before creating any client`, async () => {
    const result = await run(argv, { env });
    assert.equal(result.code, 1);
    assert.equal(result.created.length, 0);
    assertNoLeak(result.text);
  });
}

// ---------------------------------------------------------------------------
// --execute: transaction sequencing

test('--execute on an absent marker: facts, then inspection, then install, re-verify and COMMIT, in order', async () => {
  const client = fakeClient({ state: ABSENT });
  const result = await run(EXECUTE, { client });
  assert.equal(result.code, 0);
  assert.deepEqual(result.created, [CONN]);
  const { sql } = client;
  assert.equal(client.calls[0], 'CONNECT');
  const begin = indexOf(sql, (s) => /^BEGIN\b/.test(s));
  const facts = sql.indexOf(LIVE_FACTS_SQL);
  const inspect = sql.indexOf(INSPECT_SQL);
  const schema = indexOf(sql, (s) => /^CREATE SCHEMA\b/.test(s));
  const table = indexOf(sql, (s) => /^CREATE TABLE\b/.test(s));
  const insert = indexOf(sql, (s) => /^INSERT\b/.test(s));
  const reverify = sql.findIndex((s, i) => i > insert && s === MARKER_ROWS_SQL);
  const commit = sql.indexOf('COMMIT');
  assert.ok(begin === 0, 'BEGIN is the first statement');
  assert.ok(begin < facts && facts < inspect, 'independent live facts precede marker inspection');
  assert.ok(inspect < schema && schema < table && table < insert, 'install only after inspection');
  assert.ok(insert < reverify && reverify < commit, 're-verified before COMMIT');
  assert.equal(commit, sql.length - 1, 'COMMIT is last');
  assert.equal(sql.filter((s) => s === 'COMMIT').length, 1);
  assert.ok(sql.includes(MARKER_FACTS_SQL), 'structure is verified');
  assert.ok(client.calls.includes('END'));
  assert.ok(result.out.includes(MARKER));
  assertNoLeak(result.text);
});

test('--execute on the exact canonical marker is an idempotent no-op: no write, no COMMIT', async () => {
  const client = fakeClient({ state: existing([row('local_test', MARKER)]), endThrows: true });
  const result = await run(EXECUTE, { client });
  assert.equal(result.code, 0);
  assert.ok(client.sql.length > 0, 'the marker was actually inspected');
  assert.deepEqual(writes(client.sql), []);
  assert.ok(!client.sql.includes('COMMIT'));
  assert.equal(client.sql.at(-1), 'ROLLBACK');
  assertNoLeak(result.text);
});

test('a second --execute after a successful install is a no-op on the same database', async () => {
  const first = fakeClient({ state: ABSENT });
  assert.equal((await run(EXECUTE, { client: first })).code, 0);
  const second = fakeClient({ state: first.current() });
  const result = await run(EXECUTE, { client: second });
  assert.equal(result.code, 0);
  assert.ok(second.sql.length > 0);
  assert.deepEqual(writes(second.sql), []);
  assert.ok(!second.sql.includes('COMMIT'));
});

for (const [label, options] of [
  ['PostgreSQL 16', { live: { ...LIVE, version: 'PostgreSQL 16.9' } }],
  ['a wrong current_database', { live: { ...LIVE, current_database: 'postgres' } }],
  ['a wrong current_user', { live: { ...LIVE, current_user: 'postgres' } }],
  ['a foreign TEST guard', { live: { ...LIVE, test_guard_exists: true } }],
  ['a foreign PILOT guard', { live: { ...LIVE, pilot_guard_exists: true } }],
]) {
  test(`--execute refuses ${label} from live facts before any write`, async () => {
    const client = fakeClient(options);
    const result = await run(EXECUTE, { client });
    assert.equal(result.code, 1);
    assert.ok(client.sql.includes(LIVE_FACTS_SQL), 'live facts were read');
    assert.deepEqual(writes(client.sql), []);
    assert.ok(!client.sql.includes('COMMIT'));
    assert.ok(client.sql.includes('ROLLBACK'));
    assertNoLeak(result.text);
  });
}

for (const [label, options] of [
  ['a different installed marker id', { state: existing([row('local_test', OTHER)]) }],
  ['the TEST environment', { state: existing([row('test', MARKER)]) }],
  ['two marker rows', { state: existing([row('local_test', MARKER), row('local_test', MARKER)]) }],
  ['a partial schema without the table', { state: { schemaExists: true, tableExists: false, rows: [] } }],
  ['a non-canonical table structure', { state: existing([row('local_test', MARKER)], { ...canonicalFacts(), table: { ...canonicalFacts().table, triggers: 1 } }) }],
  ['a conflict whose ROLLBACK also fails', { state: existing([row('local_test', OTHER)]), rollbackThrows: true }],
]) {
  test(`--execute refuses ${label}: never overwritten, no write, no COMMIT`, async () => {
    const client = fakeClient(options);
    const result = await run(EXECUTE, { client });
    assert.equal(result.code, 1);
    assert.ok(client.sql.includes(INSPECT_SQL), 'the marker state was inspected');
    assert.deepEqual(writes(client.sql), []);
    assert.ok(!client.sql.includes('COMMIT'));
    assertNoLeak(result.text);
  });
}

for (const [label, options] of [
  ['the INSERT fails', { state: ABSENT, failOn: 'INSERT' }],
  ['CREATE TABLE fails', { state: ABSENT, failOn: 'CREATE TABLE' }],
  ['the re-verification finds a non-canonical structure', { state: ABSENT, installedFacts: { ...canonicalFacts(), schemaOwnerIsCurrentUser: false } }],
]) {
  test(`--execute rolls back when ${label}, and never commits`, async () => {
    const client = fakeClient(options);
    const result = await run(EXECUTE, { client });
    assert.equal(result.code, 1);
    assert.ok(writes(client.sql).length > 0, 'the install had started');
    assert.ok(!client.sql.includes('COMMIT'));
    assert.equal(client.sql.at(-1), 'ROLLBACK');
    assertNoLeak(result.text);
  });
}

test('--execute reports a failed COMMIT as a failure without leaking the error', async () => {
  const client = fakeClient({ state: ABSENT, commitThrows: true });
  const result = await run(EXECUTE, { client });
  assert.equal(result.code, 1);
  assertNoLeak(result.text);
});

test('--execute reports a connection error by safe code only', async () => {
  const connectError = Object.assign(new Error(`connect ECONNREFUSED ${URL_TEXT}`), { code: 'ECONNREFUSED' });
  const client = fakeClient({ connectError });
  const result = await run(EXECUTE, { client });
  assert.equal(result.code, 1);
  assert.deepEqual(client.sql, []);
  assert.match(result.err, /ECONNREFUSED/);
  assertNoLeak(result.text);
});

test('--execute connects with discrete LOCAL_TEST fields only, whatever hostile variables are set', async () => {
  const client = fakeClient({ state: ABSENT });
  const result = await run(EXECUTE, {
    client,
    env: { ...ENV, DATABASE_URL: HOSTILE_DEV, TEST_DATABASE_URL: HOSTILE_TEST, DIRECT_URL: HOSTILE_DEV, PGHOST: 'dev-hostile.invalid', PGPASSWORD: 'DevHostilePw' },
  });
  assert.equal(result.code, 0);
  assert.deepEqual(result.created, [CONN]);
  assertNoLeak(result.text);
});

test('every statement sent in any --execute or --check scenario is allowed SQL', async () => {
  const sent = [];
  for (const [argv, options] of [
    [EXECUTE, { state: ABSENT }],
    [EXECUTE, { state: existing([row('local_test', MARKER)]) }],
    [EXECUTE, { state: existing([row('local_test', OTHER)]) }],
    [EXECUTE, { state: ABSENT, failOn: 'INSERT' }],
    [CHECK, { state: existing([row('local_test', MARKER)]) }],
    [CHECK, { state: ABSENT }],
  ]) {
    const client = fakeClient(options);
    await run(argv, { client });
    sent.push(...client.sql);
  }
  assert.ok(sent.some((s) => /^INSERT\b/.test(s)), 'the scenarios exercised an install');
  for (const text of sent) assert.doesNotMatch(text, FORBIDDEN_SQL);
});
