// Zero-database unit tests for scripts/database/test-marker.mjs and the restore
// guard in lib.mjs. Run with: node --test scripts/database/test-marker.test.mjs
// Every config below is synthetic (*.invalid); no test reads .env.development or
// constructs a real pg client — createClient is always an injected fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  GUARD_TABLE,
  CANONICAL_MARKER,
  buildInstallStatements,
  decideInstall,
  verifyMarkerStructure,
  main,
  confirmed,
  parseCliArgs,
  proveInstalledMarker,
  readTestConfig,
  safeCode,
} from './test-marker.mjs';
import { TEST_GUARD_SCHEMA, archiveContainsTestGuardSchema } from './lib.mjs';

const MARKER = '3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b';
const OTHER = '7d1e2f3a-4b5c-4d6e-9f70-8a9b0c1d2e3f';
const REF = 'syntheticref0000000a';
const SECRET = 'S3cretPassw0rd';
const HOST = 'aws-0-synthetic.pooler.invalid';
const TEST_URL = `postgresql://postgres.${REF}:${SECRET}@${HOST}:5432/postgres`;
const LEAKS = [SECRET, HOST, REF, `postgres.${REF}`, TEST_URL, '5432', 'pooler'];

function envText(overrides = {}) {
  // `'key' in overrides` (not destructuring defaults) so an explicit undefined
  // really means "variable absent".
  const url = 'url' in overrides ? overrides.url : TEST_URL;
  const pinned = 'pinned' in overrides ? overrides.pinned : MARKER;
  const extra = overrides.extra ?? '';
  return [
    'DATABASE_URL=postgresql://postgres.devref:devpass@dev-host.invalid:5432/postgres',
    url === undefined ? '' : `TEST_DATABASE_URL=${url}`,
    pinned === undefined ? '' : `TEST_DATABASE_MARKER_ID=${pinned}`,
    extra,
  ].join('\n');
}

// Hand-written catalog facts for the canonical marker (deliberately NOT derived
// from CANONICAL_MARKER, so a drift in either is caught).
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
const row = (environment, markerId) => ({ environment, marker_id: markerId, has_installed_at: true });
const existing = (rows, facts = canonicalFacts()) => ({ schemaExists: true, tableExists: true, facts, rows });

function fakeClient({ state = { schemaExists: false, tableExists: false, rows: [] }, installedFacts = canonicalFacts(), failOn, authorized = true, endThrows = false, connectError } = {}) {
  const calls = [];
  let installed = null;
  return {
    calls,
    connection: { stream: { encrypted: authorized, authorized } },
    async connect() {
      calls.push('CONNECT');
      if (connectError !== undefined) throw connectError;
    },
    sql: [],
    async query(sql, values) {
      const text = typeof sql === 'string' ? sql : sql.text;
      const params = typeof sql === 'string' ? values : sql.values;
      this.sql.push(text);
      calls.push(text.trim().split(/\s+/).slice(0, 3).join(' '));
      if (failOn && text.includes(failOn)) {
        const err = new Error(`boom ${TEST_URL}`);
        err.code = '23514';
        throw err;
      }
      if (text.includes('to_regnamespace')) {
        const current = installed ?? state;
        return { rows: [{ schema_exists: current.schemaExists, table_exists: current.tableExists }] };
      }
      if (text.includes('json_build_object')) {
        const current = installed ?? state;
        return { rows: [{ facts: current.facts ?? null }] };
      }
      if (text.startsWith('SELECT environment')) {
        const current = installed ?? state;
        return { rows: current.rows };
      }
      if (text.startsWith('INSERT')) {
        installed = existing([row('test', params[0])], installedFacts);
      }
      return { rows: [] };
    },
    async end() {
      calls.push('END');
      if (endThrows) throw new Error(`end failed ${TEST_URL}`);
    },
  };
}

// Fake verified-backup handle; `unchanged` scripts successive assertUnchanged() results.
function fakeBackup({ ok = true, unchanged = [true, true] } = {}) {
  const handle = ok
    ? { ok: true, name: 'test_manual_20260925T000000Z.dump', setId: '0b6f2c1e-8a4d-4e6f-9b2a-1c3d5e7f9a0b', sha256: 'a'.repeat(64), checks: 0, disposed: 0 }
    : { ok: false, reason: 'dump is not a readable PostgreSQL custom archive' };
  if (ok) {
    handle.assertUnchanged = () => unchanged[handle.checks++] ?? false;
    handle.dispose = () => { handle.disposed += 1; };
  }
  return handle;
}

async function run(argv, { env = envText(), client, backupOk = true, backup = fakeBackup({ ok: backupOk }) } = {}) {
  const out = [];
  const created = [];
  const deps = {
    readEnvFile: () => env,
    createClient: (url) => {
      created.push(url);
      if (!client) throw new Error('createClient must not be called');
      return client;
    },
    openBackup: async () => backup,
    log: (line) => out.push(line),
    error: (line) => out.push(line),
  };
  const code = await main(argv, deps);
  return { code, text: out.join('\n'), created, backup };
}

const EXECUTE = ['--target=test', '--execute', `--marker-id=${MARKER}`, '--backup=backups/database/x.dump', `--confirm-project-ref=${REF}`];

function assertNoLeak(text) {
  for (const leak of LEAKS) assert.ok(!text.includes(leak), `output leaked ${JSON.stringify(leak)}`);
}

// --- CLI parsing -----------------------------------------------------------

test('parse: bare, missing target, and non-test targets fail closed', () => {
  assert.equal(parseCliArgs([]).ok, false);
  assert.equal(parseCliArgs(['--dry-run', `--marker-id=${MARKER}`]).ok, false);
  for (const target of ['demo', 'dev', 'production', 'prod', 'TEST', '', 'test ']) {
    const parsed = parseCliArgs([`--target=${target}`, '--dry-run', `--marker-id=${MARKER}`]);
    assert.equal(parsed.ok, false, target);
    if (target.trim()) assert.ok(!parsed.error.includes(target.trim()) || target.trim() === 'test', target);
  }
});

test('parse: exactly one of --dry-run / --execute', () => {
  assert.equal(parseCliArgs(['--target=test', `--marker-id=${MARKER}`]).ok, false);
  assert.equal(parseCliArgs(['--target=test', '--dry-run', '--execute', `--marker-id=${MARKER}`]).ok, false);
  assert.equal(parseCliArgs(['--target=test', '--dry-run', '--dry-run', `--marker-id=${MARKER}`]).ok, false);
});

test('parse: unknown, positional and duplicate arguments fail without echoing them', () => {
  for (const extra of [`--url=${TEST_URL}`, '--force', TEST_URL, '-x', '--target', '--dry-run=yes']) {
    const parsed = parseCliArgs(['--target=test', '--dry-run', `--marker-id=${MARKER}`, extra]);
    assert.equal(parsed.ok, false, extra);
    assertNoLeak(parsed.error);
  }
  assert.equal(parseCliArgs(['--target=test', '--target=test', '--dry-run', `--marker-id=${MARKER}`]).ok, false);
  assert.equal(parseCliArgs(['--target=test', '--dry-run', `--marker-id=${MARKER}`, `--marker-id=${MARKER}`]).ok, false);
});

test('parse: marker id must be a canonical lowercase v4 uuid', () => {
  for (const bad of ['', 'abc', MARKER.toUpperCase(), '00000000-0000-0000-0000-000000000000', '3f2b8c1e-9a4d-1e6f-8b2a-1c3d5e7f9a0b', `${MARKER}'; DROP TABLE x;--`]) {
    const parsed = parseCliArgs(['--target=test', '--dry-run', `--marker-id=${bad}`]);
    assert.equal(parsed.ok, false, bad);
    assert.ok(!bad || !parsed.error.includes(bad), 'invalid value echoed');
  }
  assert.equal(parseCliArgs(['--target=test', '--dry-run']).ok, false);
});

test('parse: valid dry-run and execute', () => {
  assert.deepEqual(parseCliArgs(['--target=test', '--dry-run', `--marker-id=${MARKER}`]), {
    ok: true, mode: 'dry-run', markerId: MARKER, backup: null, confirmProjectRef: null,
  });
  assert.deepEqual(parseCliArgs(EXECUTE), {
    ok: true, mode: 'execute', markerId: MARKER, backup: 'backups/database/x.dump', confirmProjectRef: REF,
  });
});

test('parse: execute requires --backup and --confirm-project-ref', () => {
  assert.equal(parseCliArgs(EXECUTE.filter((a) => !a.startsWith('--backup='))).ok, false);
  assert.equal(parseCliArgs(EXECUTE.filter((a) => !a.startsWith('--confirm-project-ref='))).ok, false);
});

// --- configuration ---------------------------------------------------------

test('config: reads only TEST_DATABASE_URL and the pinned marker', () => {
  const config = readTestConfig(envText());
  assert.equal(config.ok, true);
  assert.equal(config.testUrl, TEST_URL);
  assert.equal(config.pinnedMarkerId, MARKER);
  assert.deepEqual(Object.keys(config).sort(), ['ok', 'pinnedMarkerId', 'testUrl']);
});

test('config: absent or malformed TEST_DATABASE_URL fails closed', () => {
  for (const url of [
    undefined,
    '',
    'not a url',
    `mysql://postgres.${REF}:${SECRET}@${HOST}:5432/postgres`,
    `postgresql://postgres.${REF}@${HOST}:5432/postgres`,
    `postgresql://postgres.${REF}:${SECRET}@:5432/postgres`,
    `${TEST_URL}?sslmode=disable`,
    `${TEST_URL}?host=elsewhere.invalid`,
    // Quoted: parseEnv treats an unquoted '#' as the start of a comment.
    `"${TEST_URL}#frag"`,
    `postgresql://:${SECRET}@${HOST}:5432/postgres`,
    `postgresql://postgres.${REF}:${SECRET}@${HOST}:5432/`,
  ]) {
    assert.equal(readTestConfig(envText({ url })).ok, false, String(url));
  }
});

// --- dry-run ---------------------------------------------------------------

test('dry-run: prints a sanitized plan and never creates a client', async () => {
  const { code, text, created } = await run(['--target=test', '--dry-run', `--marker-id=${MARKER}`]);
  assert.equal(code, 0);
  assert.equal(created.length, 0);
  assert.match(text, /target: TEST/);
  assert.match(text, new RegExp(`${TEST_GUARD_SCHEMA}\\.${GUARD_TABLE}`));
  assert.match(text, new RegExp(MARKER));
  assert.match(text, /no database connection/i);
  assert.match(text, /backup/i);
  assert.match(text, /approval/i);
  assertNoLeak(text);
});

test('dry-run: output is deterministic', async () => {
  const argv = ['--target=test', '--dry-run', `--marker-id=${MARKER}`];
  assert.equal((await run(argv)).text, (await run(argv)).text);
});

test('dry-run: missing or malformed TEST config fails at phase=config with no client', async () => {
  for (const url of [undefined, `${TEST_URL}?sslmode=disable`]) {
    const { code, text, created } = await run(['--target=test', '--dry-run', `--marker-id=${MARKER}`], { env: envText({ url }) });
    assert.equal(code, 1);
    assert.equal(created.length, 0);
    assert.match(text, /phase=config/);
    assertNoLeak(text);
  }
});

test('bare invocation fails before reading config or creating a client', async () => {
  let read = false;
  const code = await main([], {
    readEnvFile: () => { read = true; return envText(); },
    createClient: () => { throw new Error('no'); },
    openBackup: async () => { throw new Error('must not open a backup'); },
    log: () => {},
    error: () => {},
  });
  assert.equal(code, 1);
  assert.equal(read, false);
});

// --- execute preconditions (all before any connection) ---------------------

test('execute: pinned marker must exist and equal --marker-id', async () => {
  for (const pinned of [undefined, OTHER]) {
    const { code, text, created } = await run(EXECUTE, { env: envText({ pinned }), client: fakeClient() });
    assert.equal(code, 1);
    assert.equal(created.length, 0);
    assert.match(text, /phase=config/);
  }
});

test('execute: unverifiable backup blocks before any connection', async () => {
  const { code, text, created } = await run(EXECUTE, { client: fakeClient(), backupOk: false });
  assert.equal(code, 1);
  assert.equal(created.length, 0);
  assert.match(text, /phase=backup/);
});

test('execute: project ref attestation must match TEST_DATABASE_URL, without printing it', async () => {
  const argv = EXECUTE.map((a) => (a.startsWith('--confirm-project-ref=') ? '--confirm-project-ref=otherref000000000000' : a));
  const { code, text, created } = await run(argv, { client: fakeClient() });
  assert.equal(code, 1);
  assert.equal(created.length, 0);
  assert.match(text, /phase=target/);
  assertNoLeak(text);
});

// --- execute against a fake client -----------------------------------------

test('execute: fresh database installs in one transaction and verifies', async () => {
  const client = fakeClient();
  const { code, text, created } = await run(EXECUTE, { client });
  assert.equal(code, 0, text);
  assert.deepEqual(created, [TEST_URL]);
  const ddl = client.calls.filter((c) => /^(CREATE|INSERT|COMMIT|ROLLBACK|BEGIN)/.test(c));
  assert.deepEqual(ddl, ['BEGIN', 'CREATE SCHEMA mona_test_guard', 'CREATE TABLE mona_test_guard.database_identity', 'INSERT INTO mona_test_guard.database_identity', 'COMMIT']);
  assert.equal(client.calls.at(-1), 'END');
  assert.match(text, /installed/i);
  assertNoLeak(text);
});

test('execute: matching existing marker is an idempotent no-op', async () => {
  const client = fakeClient({ state: existing([row('test', MARKER)]) });
  const { code, text } = await run(EXECUTE, { client });
  assert.equal(code, 0, text);
  const lock = client.calls.findIndex((c) => c.startsWith('LOCK TABLE'));
  const facts = client.calls.findIndex((c) => c.startsWith('SELECT json_build_object('));
  const rows = client.calls.findIndex((c) => c.startsWith('SELECT environment'));
  assert.ok(lock > 0 && lock < facts && facts < rows, `lock must precede structure and row reads: ${client.calls.join(' | ')}`);
  assert.ok(!client.calls.some((c) => /^(CREATE|INSERT|COMMIT)/.test(c)));
  assert.ok(client.calls.includes('ROLLBACK'));
  assert.match(text, /already installed/i);
});

test('execute: conflicting marker state is never overwritten', async () => {
  const states = [
    existing([row('test', OTHER)]),
    { schemaExists: true, tableExists: false, rows: [] },
    existing([]),
    existing([row('test', MARKER), row('test', OTHER)]),
    existing([row('demo', MARKER)]),
    existing([{ ...row('test', MARKER), has_installed_at: false }]),
  ];
  for (const state of states) {
    const client = fakeClient({ state });
    const { code, text } = await run(EXECUTE, { client });
    assert.equal(code, 1, JSON.stringify(state));
    assert.match(text, /phase=conflict/);
    assert.ok(!client.calls.some((c) => /^(CREATE|INSERT|COMMIT)/.test(c)), JSON.stringify(state));
    assert.ok(!text.includes(OTHER), 'foreign marker id echoed');
  }
});

test('execute: failure mid-install rolls back and never commits', async () => {
  const client = fakeClient({ failOn: 'INSERT' });
  const { code, text } = await run(EXECUTE, { client });
  assert.equal(code, 1);
  assert.match(text, /phase=install/);
  assert.match(text, /code=23514/);
  assert.ok(client.calls.includes('ROLLBACK'));
  assert.ok(!client.calls.includes('COMMIT'));
  assertNoLeak(text);
});

test('execute: connect failure reports a safe code only', async () => {
  const err = new Error(`connect ETIMEDOUT ${HOST}:5432 ${TEST_URL}`);
  err.code = 'ETIMEDOUT';
  const { code, text } = await run(EXECUTE, { client: fakeClient({ connectError: err }) });
  assert.equal(code, 1);
  assert.match(text, /phase=connect code=ETIMEDOUT/);
  assertNoLeak(text);
});

test('execute: unverified TLS stops before any query', async () => {
  const client = fakeClient({ authorized: false });
  const { code, text } = await run(EXECUTE, { client });
  assert.equal(code, 1);
  assert.match(text, /phase=connect/);
  assert.deepEqual(client.calls, ['CONNECT', 'END']);
});

test('execute: client.end() throwing does not change the outcome or leak', async () => {
  const { code, text } = await run(EXECUTE, { client: fakeClient({ endThrows: true }) });
  assert.equal(code, 0, text);
  assertNoLeak(text);
});

// --- pure helpers ----------------------------------------------------------

test('safeCode: only allowlisted, secret-free codes survive', () => {
  assert.equal(safeCode(Object.assign(new Error('x'), { code: '42P01' }), [TEST_URL]), '42P01');
  assert.equal(safeCode(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }), [TEST_URL]), 'ECONNREFUSED');
  assert.equal(safeCode('a string thrown', [TEST_URL]), 'unexpected');
  assert.equal(safeCode(undefined, [TEST_URL]), 'unexpected');
  assert.equal(safeCode({ code: TEST_URL }, [TEST_URL]), 'unexpected');
  assert.equal(safeCode({ code: 'user@host' }, [TEST_URL]), 'unexpected');
  assert.equal(safeCode({ code: 'S3CRETPASS' }, ['postgresql://u:S3CRETPASS@h.invalid/postgres']), 'unexpected');
});

test('decideInstall: only the canonical structure with one exact test row is idempotent', () => {
  assert.equal(decideInstall({ schemaExists: false, tableExists: false, rows: [] }, MARKER).action, 'install');
  assert.equal(decideInstall(existing([row('test', MARKER)]), MARKER).action, 'already-installed');
  assert.equal(decideInstall(existing([row('test', OTHER)]), MARKER).action, 'conflict');
  assert.equal(decideInstall({ schemaExists: false, tableExists: true, rows: [] }, MARKER).action, 'conflict');
  assert.equal(decideInstall(existing([{ environment: 'test' }]), MARKER).action, 'conflict');
  assert.equal(decideInstall(existing([row('test', MARKER)], null), MARKER).action, 'conflict');
});

// --- H1: structural identity of an existing marker --------------------------

function mutated(change) {
  const facts = canonicalFacts();
  change(facts);
  return facts;
}
const col = (facts, name) => facts.columns.find((c) => c.name === name);
const STRUCTURAL_MUTATIONS = {
  'marker_id is text': (f) => { col(f, 'marker_id').type = 'text'; },
  'environment nullable': (f) => { col(f, 'environment').notNull = false; },
  'installed_at nullable': (f) => { col(f, 'installed_at').notNull = false; },
  'installed_at default changed': (f) => { col(f, 'installed_at').default = "'2020-01-01 00:00:00+00'::timestamp with time zone"; },
  'installed_at is timestamp without time zone': (f) => { col(f, 'installed_at').type = 'timestamp without time zone'; },
  'singleton default false': (f) => { col(f, 'singleton').default = 'false'; },
  'generated column': (f) => { col(f, 'marker_id').generated = 's'; },
  'identity column': (f) => { col(f, 'singleton').identity = 'a'; },
  'extra column with default': (f) => { f.columns.push({ name: 'override', type: 'text', notNull: false, default: "'demo'::text", generated: '', identity: '' }); },
  'missing column': (f) => { f.columns.pop(); },
  'columns reordered': (f) => { f.columns.reverse(); },
  'missing environment CHECK': (f) => { f.constraints = f.constraints.filter((c) => !c.definition.includes('environment')); },
  'weaker environment CHECK': (f) => { f.constraints[2].definition = "CHECK ((environment = ANY (ARRAY['test'::text, 'demo'::text])))"; },
  'missing singleton CHECK': (f) => { f.constraints = f.constraints.filter((c) => c.definition !== 'CHECK (singleton)'); },
  'PK on marker_id': (f) => { f.constraints[0].definition = 'PRIMARY KEY (marker_id)'; },
  'no PK': (f) => { f.constraints = f.constraints.filter((c) => c.type !== 'p'); },
  'extra UNIQUE constraint': (f) => { f.constraints.push({ type: 'u', definition: 'UNIQUE (marker_id)' }); },
  'relation is a view': (f) => { f.table.kind = 'v'; },
  'relation is partitioned': (f) => { f.table.kind = 'p'; },
  'row-level security': (f) => { f.table.rowSecurity = true; },
  'forced row-level security': (f) => { f.table.forceRowSecurity = true; },
  'inheritance children': (f) => { f.table.hasSubclass = true; },
  // H1.3: the marker must be neither a parent nor a child in pg_inherits (this
  // covers ordinary INHERITS and declarative partitions, whatever the other
  // relation's schema, name or count).
  'external inheritance parent (schema relations still canonical)': (f) => { f.table.parents = 1; },
  'parent inside the marker schema': (f) => { f.table.parents = 1; f.relations.push({ name: 'identity_parent', kind: 'r' }); },
  'multiple parents': (f) => { f.table.parents = 2; },
  'partition child of a partitioned parent': (f) => { f.table.parents = 1; },
  'child recorded while relhassubclass is stale false': (f) => { f.table.children = 1; },
  'parent and child': (f) => { f.table.parents = 1; f.table.children = 1; f.table.hasSubclass = true; },
  'partitioned parent with a partition': (f) => { f.table.kind = 'p'; f.table.children = 1; f.table.hasSubclass = true; },
  'parents fact missing': (f) => { delete f.table.parents; },
  'children fact missing': (f) => { delete f.table.children; },
  'parents fact is a string': (f) => { f.table.parents = '0'; },
  'parents fact is null': (f) => { f.table.parents = null; },
  'parents fact is negative': (f) => { f.table.parents = -1; },
  'parents fact is fractional': (f) => { f.table.parents = 0.5; },
  'parents fact is boolean false': (f) => { f.table.parents = false; },
  'children fact is a string': (f) => { f.table.children = '0'; },
  'rules': (f) => { f.table.hasRules = true; },
  'triggers': (f) => { f.table.triggers = 1; },
  'table owned by another role': (f) => { f.table.ownerIsCurrentUser = false; },
  'schema owned by another role': (f) => { f.schemaOwnerIsCurrentUser = false; },
  'extra relation in schema': (f) => { f.relations.push({ name: 'shadow_identity', kind: 'r' }); },
  'table facts missing': (f) => { f.table = null; },
};

test('H1: canonical facts verify; every structural deviation is rejected', () => {
  assert.equal(verifyMarkerStructure(canonicalFacts()), null);
  for (const [label, change] of Object.entries(STRUCTURAL_MUTATIONS)) {
    assert.notEqual(verifyMarkerStructure(mutated(change)), null, label);
  }
});

test('H1: execute refuses a matching row in a structurally wrong table, without DDL', async () => {
  for (const [label, change] of Object.entries(STRUCTURAL_MUTATIONS)) {
    const client = fakeClient({ state: existing([row('test', MARKER)], mutated(change)) });
    const { code, text } = await run(EXECUTE, { client });
    assert.equal(code, 1, label);
    assert.match(text, /phase=conflict/, label);
    assert.ok(!client.calls.some((c) => /^(CREATE|INSERT|COMMIT|ALTER|DROP|UPDATE|DELETE)/.test(c)), label);
    assert.ok(client.calls.includes('ROLLBACK'), label);
  }
});

test('H1: a fresh install whose post-install structure does not verify is rolled back', async () => {
  const client = fakeClient({ installedFacts: mutated(STRUCTURAL_MUTATIONS['weaker environment CHECK']) });
  const { code, text } = await run(EXECUTE, { client });
  assert.equal(code, 1);
  assert.match(text, /phase=verify/);
  assert.ok(client.calls.includes('ROLLBACK'));
  assert.ok(!client.calls.includes('COMMIT'));
});

test('H1: install DDL is generated from the canonical definition', () => {
  const create = buildInstallStatements(MARKER).find((s) => s.text.startsWith('CREATE TABLE')).text;
  for (const column of CANONICAL_MARKER.columns) assert.ok(create.includes(`${column.name} ${column.ddl}`), column.name);
});

// --- M2: backup identity is re-checked at mutation time --------------------

test('M2: backup changed after verification but before the first DDL → rollback, nothing installed', async () => {
  const client = fakeClient();
  const backup = fakeBackup({ unchanged: [false] });
  const { code, text } = await run(EXECUTE, { client, backup });
  assert.equal(code, 1);
  assert.match(text, /phase=backup/);
  assert.ok(!client.calls.some((c) => /^(CREATE|INSERT|COMMIT)/.test(c)));
  assert.ok(client.calls.includes('ROLLBACK'));
  assert.equal(backup.disposed, 1);
});

test('M2: backup changed between DDL and COMMIT → rollback, never committed', async () => {
  const client = fakeClient();
  const backup = fakeBackup({ unchanged: [true, false] });
  const { code, text } = await run(EXECUTE, { client, backup });
  assert.equal(code, 1);
  assert.match(text, /phase=backup/);
  assert.ok(client.calls.includes('ROLLBACK'));
  assert.ok(!client.calls.includes('COMMIT'));
});

test('M2: the backup is checked twice on success and disposed on every path', async () => {
  const ok = await run(EXECUTE, { client: fakeClient() });
  assert.equal(ok.code, 0, ok.text);
  assert.equal(ok.backup.checks, 2);
  assert.equal(ok.backup.disposed, 1);
  const conflict = await run(EXECUTE, { client: fakeClient({ state: existing([row('test', OTHER)]) }) });
  assert.equal(conflict.code, 1);
  assert.equal(conflict.backup.disposed, 1);
  const dry = await run(['--target=test', '--dry-run', `--marker-id=${MARKER}`, '--backup=x.dump']);
  assert.equal(dry.code, 0);
  assert.match(dry.text, /backup artifact: verified/);
  assert.equal(dry.backup.disposed, 1);
  const rejected = await run(['--target=test', '--dry-run', `--marker-id=${MARKER}`, '--backup=x.dump'], { backupOk: false });
  assert.match(rejected.text, /NOT VERIFIED — dump is not a readable PostgreSQL custom archive/);
});

test('install SQL is additive only, parameterized, and credential-free', () => {
  const statements = buildInstallStatements(MARKER);
  const sql = statements.map((s) => s.text).join('\n');
  assert.ok(!/\b(DROP|TRUNCATE|DELETE|UPDATE|GRANT|REVOKE|ALTER)\b/i.test(sql));
  assert.ok(!/IF NOT EXISTS/i.test(sql), 'must fail on a pre-existing object, not skip it');
  assert.ok(!sql.includes(MARKER), 'marker must be a bound parameter');
  assert.match(sql, /PRIMARY KEY/);
  assert.match(sql, /CHECK \(singleton\)/);
  assert.match(sql, /CHECK \(environment = 'test'\)/);
  assert.match(sql, /marker_id uuid NOT NULL/);
  assert.match(sql, /installed_at timestamptz NOT NULL/);
  assert.deepEqual(statements.flatMap((s) => s.values ?? []), [MARKER]);
  assertNoLeak(sql);
});

// --- restore guard ---------------------------------------------------------

test('restore guard: archive TOC containing the marker schema is rejected', () => {
  const toc = [
    ';',
    '; Archive created at 2026-09-25 00:00:00 UTC',
    ';     dbname: postgres',
    '5; 2615 16390 SCHEMA - mona_test_guard postgres',
    '215; 1259 16391 TABLE mona_test_guard database_identity postgres',
    '3401; 0 16391 TABLE DATA mona_test_guard database_identity postgres',
  ].join('\n');
  assert.equal(archiveContainsTestGuardSchema(toc), true);
  assert.equal(archiveContainsTestGuardSchema('3401; 0 16391 TABLE DATA mona_test_guard database_identity postgres'), true);
});

test('restore guard: public-only archive and comment-only mentions are accepted', () => {
  const toc = [
    ';     dbname: mona_test_guard',
    '215; 1259 16391 TABLE public "User" postgres',
    '216; 1259 16392 TABLE public mona_test_guard_notes postgres',
    '3401; 0 16391 TABLE DATA public "User" postgres',
  ].join('\n');
  assert.equal(archiveContainsTestGuardSchema(toc), false);
});

// --- H1.2: the guard pins name resolution before reading anything ------------

test('H1.2: search_path is pinned to pg_catalog, pg_temp right after BEGIN on every path', async () => {
  const scenarios = [
    fakeClient(),
    fakeClient({ state: existing([row('test', MARKER)]) }),
    fakeClient({ state: existing([row('test', OTHER)]) }),
  ];
  for (const client of scenarios) {
    await run(EXECUTE, { client });
    const begin = client.calls.indexOf('BEGIN');
    assert.ok(begin >= 0);
    assert.equal(client.calls[begin + 1], 'SET LOCAL search_path', client.calls.join(' | '));
    assert.ok(client.sql.some((q) => q === 'SET LOCAL search_path TO pg_catalog, pg_temp'));
  }
});

test('H1.3: the catalog facts query reads pg_inherits in both directions for the marker', async () => {
  const client = fakeClient({ state: existing([row('test', MARKER)]) });
  await run(EXECUTE, { client });
  const facts = client.sql.find((text) => text.includes('json_build_object'));
  assert.ok(facts, 'facts query issued');
  assert.match(facts, /FROM pg_inherits \w+ WHERE \w+\.inhrelid = c\.oid/);
  assert.match(facts, /FROM pg_inherits \w+ WHERE \w+\.inhparent = c\.oid/);
});

test('H1.3: an existing marker with an inheritance parent is a conflict, never adopted', async () => {
  const client = fakeClient({ state: existing([row('test', MARKER)], mutated(STRUCTURAL_MUTATIONS['external inheritance parent (schema relations still canonical)'])) });
  const { code, text } = await run(EXECUTE, { client });
  assert.equal(code, 1);
  assert.match(text, /phase=conflict/);
  assert.ok(client.calls.includes('ROLLBACK'));
  assert.ok(!client.calls.some((c) => /^(CREATE|INSERT|COMMIT)/.test(c)));
});

test('H1.3: a fresh install whose post-install facts show a parent is rolled back', async () => {
  const client = fakeClient({ installedFacts: mutated(STRUCTURAL_MUTATIONS['partition child of a partitioned parent']) });
  const { code, text } = await run(EXECUTE, { client });
  assert.equal(code, 1);
  assert.match(text, /phase=verify/);
  assert.ok(client.calls.includes('ROLLBACK'));
  assert.ok(!client.calls.includes('COMMIT'));
});

test('H1.3: a failing catalog facts query fails closed without DDL', async () => {
  const client = fakeClient({ state: existing([row('test', MARKER)]), failOn: 'pg_inherits' });
  const { code, text } = await run(EXECUTE, { client });
  assert.equal(code, 1);
  assert.match(text, /phase=inspect/);
  assert.ok(!client.calls.some((c) => /^(CREATE|INSERT|COMMIT)/.test(c)));
});

// --- proveInstalledMarker: a proof is successful only if its ROLLBACK is confirmed ---

const PROOF_SECRET_URL = 'postgresql://postgres.proofref00000000000a:Pr00fSecret@proof-host.invalid:5432/postgres';
const PROOF_LEAKS = ['Pr00fSecret', 'proof-host', 'proofref00000000000a', PROOF_SECRET_URL];
function proofClient({ rows = [{ environment: 'test', marker_id: MARKER, has_installed_at: true }], facts = canonicalFacts(), lockError = null, rollback = 'ok' } = {}) {
  const sql = [];
  return {
    sql,
    query(q) {
      const text = typeof q === 'string' ? q : q.text;
      sql.push(text);
      if (text === 'ROLLBACK') {
        if (rollback === 'reject') return Promise.reject(Object.assign(new Error(`rollback failed ${PROOF_SECRET_URL}`), { code: '08006' }));
        if (rollback === 'throw') throw Object.assign(new Error(`rollback threw ${PROOF_SECRET_URL}`), { code: '08006' });
        if (rollback === 'non-error') return Promise.reject(`rollback string ${PROOF_SECRET_URL}`);
        return Promise.resolve({ rows: [] });
      }
      if (lockError && text.startsWith('LOCK')) return Promise.reject(lockError);
      if (text.includes('to_regnamespace')) return Promise.resolve({ rows: [{ schema_exists: true, table_exists: true }] });
      if (text.includes('json_build_object')) return Promise.resolve({ rows: [{ facts }] });
      if (text.startsWith('SELECT environment')) return Promise.resolve({ rows });
      return Promise.resolve({ rows: [] });
    },
  };
}
const noProofLeak = (value) => {
  const text = JSON.stringify(value);
  for (const leak of PROOF_LEAKS) assert.ok(!text.includes(leak), `leaked ${leak}`);
};

test('C12: a canonical marker with a confirmed ROLLBACK proves ok', async () => {
  const client = proofClient();
  assert.deepEqual(await proveInstalledMarker(client, MARKER), { ok: true });
  assert.equal(client.sql.at(-1), 'ROLLBACK');
});

test('C6/C7/C8/C11: a successful proof whose ROLLBACK cannot be confirmed is never ok', async () => {
  for (const rollback of ['reject', 'throw', 'non-error']) {
    const result = await proveInstalledMarker(proofClient({ rollback }), MARKER).then((r) => r, (e) => ({ thrown: e }));
    assert.notEqual(result.ok, true, `${rollback}: proof reported success despite an unconfirmed ROLLBACK`);
    assert.equal(result.thrown, undefined, `${rollback}: cleanup failure must be a fixed verdict, not a raw error`);
    assert.match(result.reason, /could not be rolled back/, rollback);
    noProofLeak(result);
  }
});

test('C9/C14: a failed verdict stays authoritative when ROLLBACK also fails', async () => {
  const wrongId = await proveInstalledMarker(proofClient({ rows: [{ environment: 'test', marker_id: OTHER, has_installed_at: true }], rollback: 'reject' }), MARKER);
  assert.deepEqual(wrongId, { ok: false, reason: 'a different marker id is already installed' });
  const facts = canonicalFacts();
  const malformed = await proveInstalledMarker(proofClient({ facts: { ...facts, table: { ...facts.table, triggers: 1 } }, rollback: 'throw' }), MARKER);
  assert.equal(malformed.ok, false);
  assert.match(malformed.reason, /rules or triggers/);
});

test('C10: a thrown proof error stays authoritative when ROLLBACK also fails', async () => {
  const primary = Object.assign(new Error(`permission denied ${PROOF_SECRET_URL}`), { code: '42501' });
  for (const rollback of ['reject', 'throw', 'non-error']) {
    await assert.rejects(proveInstalledMarker(proofClient({ lockError: primary, rollback }), MARKER), (err) => err === primary, rollback);
  }
});

test('C13: sequential proofs are independent (a failed cleanup does not taint the next proof)', async () => {
  const first = await proveInstalledMarker(proofClient({ rollback: 'reject' }), MARKER);
  assert.equal(first.ok, false);
  assert.deepEqual(await proveInstalledMarker(proofClient(), MARKER), { ok: true });
});

// --- installer cleanup: a cleanup failure never replaces an established outcome ---------
//
// `cleanupClient` wraps fakeClient with NON-async query/end, so 'throw' is a genuine
// synchronous throw at call time (the case `.catch()` cannot see), 'reject' an async
// rejection, and 'string'/'object' non-Error values. Every cleanup error carries the
// synthetic TEST URL, password and ref.
function cleanupClient(base, { rollback = 'ok', end = 'ok' } = {}) {
  const failure = (mode, what) => {
    if (mode === 'string') return `${what} ${TEST_URL}`;
    if (mode === 'object') return { message: `${what} ${TEST_URL}`, code: 'XX000' };
    return Object.assign(new Error(`${what} ${TEST_URL} ${SECRET}`), { code: '08006' });
  };
  const act = (mode, what, next) => {
    if (mode === 'ok') return next();
    if (mode === 'throw' || mode === 'throw-object') throw failure(mode === 'throw' ? 'error' : 'object', what);
    return Promise.reject(failure(mode === 'reject' ? 'error' : mode, what));
  };
  return {
    get calls() { return base.calls; },
    get sql() { return base.sql; },
    connection: base.connection,
    connect: () => base.connect(),
    query(sql, values) {
      const text = typeof sql === 'string' ? sql : sql.text;
      if (text === 'ROLLBACK') {
        base.calls.push('ROLLBACK');
        return act(rollback, 'rollback failed', () => Promise.resolve({ rows: [] }));
      }
      return base.query(sql, values);
    },
    end() {
      return act(end, 'end failed', () => base.end());
    },
  };
}
const CONFLICT_STATE = existing([row('test', OTHER)]);
const IDEMPOTENT_STATE = existing([row('test', MARKER)]);
const facts = () => canonicalFacts();
const withTriggerFacts = () => ({ ...facts(), table: { ...facts().table, triggers: 1 } });
const CLEANUP_LEAKS = ['rollback failed', 'end failed', 'XX000', '08006'];
async function installer(client, backup = fakeBackup()) {
  let result;
  try {
    result = await run(EXECUTE, { client, backup });
  } catch (err) {
    assert.fail(`main() must resolve, but an exception escaped: ${String(err?.message ?? err).slice(0, 40)}`);
  }
  assertNoLeak(result.text);
  for (const leak of CLEANUP_LEAKS) assert.ok(!result.text.includes(leak), `cleanup error leaked: ${leak}`);
  return result;
}
const MODES = ['reject', 'throw', 'string', 'object', 'throw-object'];

test('Q1/Q2/Q13: a conflict stays the conflict whatever the ROLLBACK does', async () => {
  for (const rollback of MODES) {
    const { code, text } = await installer(cleanupClient(fakeClient({ state: CONFLICT_STATE }), { rollback }));
    assert.equal(code, 1, rollback);
    assert.match(text, /phase=conflict — a different marker id is already installed; nothing was changed/, `${rollback}: ${text}`);
  }
});

test('Q3/Q4: a failed post-install verification stays authoritative; nothing is committed', async () => {
  for (const rollback of MODES) {
    const client = cleanupClient(fakeClient({ installedFacts: withTriggerFacts() }), { rollback });
    const { code, text } = await installer(client);
    assert.equal(code, 1, rollback);
    assert.match(text, /phase=verify — installed marker failed canonical verification \(marker table has inheritance children, rules or triggers\)/, `${rollback}: ${text}`);
    assert.match(text, /not committed \(ROLLBACK unconfirmed; connection closed without COMMIT\)/, `${rollback}: must not claim "rolled back"`);
    assert.ok(!/; rolled back/.test(text), rollback);
    assert.ok(!client.calls.includes('COMMIT'), `${rollback}: never committed`);
  }
});

test('Q5/Q6: a changed backup stays the backup failure at both gates; nothing is committed', async () => {
  for (const rollback of MODES) {
    for (const unchanged of [[false], [true, false]]) {
      const client = cleanupClient(fakeClient(), { rollback });
      const { code, text } = await installer(client, fakeBackup({ unchanged }));
      assert.equal(code, 1, `${rollback} ${unchanged}`);
      assert.match(text, /phase=backup — backup artifact changed after verification/, `${rollback} ${unchanged}: ${text}`);
      // Before any write the outcome is "nothing was installed"; at the commit gate
      // an unconfirmed ROLLBACK must not be reported as "rolled back".
      assert.match(text, unchanged.length === 1 ? /nothing was installed/ : /not committed \(ROLLBACK unconfirmed/, `${rollback} ${unchanged}: ${text}`);
      assert.ok(!client.calls.includes('COMMIT'));
    }
  }
});

test('Q7/Q8: a thrown install error keeps its phase and code when the cleanup ROLLBACK fails', async () => {
  for (const rollback of MODES) {
    const { code, text } = await installer(cleanupClient(fakeClient({ failOn: 'CREATE SCHEMA' }), { rollback }));
    assert.equal(code, 1, rollback);
    assert.match(text, /phase=install code=23514 — transaction not committed/, `${rollback}: ${text}`);
  }
});

test('Q9/Q10: a committed install stays a success when closing the connection fails', async () => {
  for (const end of MODES) {
    const client = cleanupClient(fakeClient(), { end });
    const { code, text } = await installer(client);
    assert.equal(code, 0, `${end}: ${text}`);
    assert.match(text, /OK — marker installed on TEST/);
    assert.ok(client.calls.includes('COMMIT'));
  }
});

test('Q11: a failure outcome is not replaced by a close failure in finally', async () => {
  for (const end of MODES) {
    const { code, text } = await installer(cleanupClient(fakeClient({ state: CONFLICT_STATE }), { end }));
    assert.equal(code, 1, end);
    assert.match(text, /phase=conflict — a different marker id is already installed/, `${end}: ${text}`);
  }
});

test('Q16/Q17: the idempotent path is unchanged when cleanup succeeds and fails closed with a fixed reason when ROLLBACK does not', async () => {
  const clean = await installer(cleanupClient(fakeClient({ state: IDEMPOTENT_STATE })));
  assert.equal(clean.code, 0);
  assert.match(clean.text, /identical canonical marker already installed on TEST; nothing changed/);
  for (const rollback of MODES) {
    const { code, text } = await installer(cleanupClient(fakeClient({ state: IDEMPOTENT_STATE }), { rollback }));
    assert.equal(code, 1, rollback);
    assert.match(text, /phase=inspect — the read transaction could not be rolled back; nothing was changed/, `${rollback}: ${text}`);
  }
});

test('Q18: a snapshot dispose failure after a success keeps the success and warns without a path', async () => {
  const backup = fakeBackup();
  backup.dispose = () => {
    throw Object.assign(new Error(`EACCES rm /tmp/mona-backup-verify-x ${TEST_URL}`), { code: 'EACCES' });
  };
  const { code, text } = await installer(cleanupClient(fakeClient()), backup);
  assert.equal(code, 0, text);
  assert.match(text, /OK — marker installed on TEST/);
  assert.match(text, /WARNING: the private verified-backup snapshot could not be removed/);
  assert.ok(!text.includes('/tmp/') && !text.includes('EACCES'));
});

test('Q14/Q15: confirmed() is lazy and fails closed on anything but a completed operation', async () => {
  assert.equal(await confirmed(() => { throw new Error('sync'); }), false);
  assert.equal(await confirmed(() => { throw 'string'; }), false);
  assert.equal(await confirmed(() => Promise.reject({ not: 'an Error' })), false);
  assert.equal(await confirmed(() => Promise.resolve()), true);
  assert.equal(await confirmed(() => undefined), true);
  // Eager misuse: a synchronous throw happens while evaluating the argument, before
  // confirmed() is ever entered, so nothing can contain it.
  const syncThrowing = () => { throw new Error('sync before entry'); };
  assert.throws(() => confirmed(syncThrowing()), /sync before entry/);
  // Eager misuse with a promise: it must never count as a confirmed cleanup.
  const rejected = Promise.reject(new Error('eager rejection'));
  rejected.catch(() => {});
  assert.equal(await confirmed(rejected), false, 'a non-function operation fails closed');
  assert.equal(await confirmed(Promise.resolve()), false, 'even a resolved promise is not a lazy operation');
});

test('Q15: production code has no eager cleanup and no swallowed .catch()', () => {
  const source = readFileSync(new URL('./test-marker.mjs', import.meta.url), 'utf8');
  const code = source.split('\n').filter((line) => !line.trimStart().startsWith('//')).join('\n');
  assert.equal((code.match(/\.catch\(/g) ?? []).length, 0, 'no .catch() cleanup');
  // Every confirmed(...) call site (not the helper's own definition) passes a lazy thunk.
  const calls = [...code.matchAll(/\bconfirmed\(/g)].map((m) => code.slice(m.index, m.index + 16));
  assert.ok(calls.length >= 4, 'the cleanup sites use confirmed()');
  for (const call of calls) assert.ok(call.startsWith('confirmed(() =>'), `eager confirmed(): ${call}`);
  // Every ROLLBACK and client.end() is contained inside a lazy confirmed() thunk.
  for (const pattern of [/client\.query\('ROLLBACK'\)/g, /client\.end\(\)/g]) {
    for (const m of code.matchAll(pattern)) {
      assert.ok(code.slice(Math.max(0, m.index - 16), m.index).endsWith('confirmed(() => '), `uncontained cleanup: ${m[0]}`);
    }
  }
});

test('Q3/Q6 control: with a confirmed ROLLBACK the verify and commit-gate failures still say "rolled back"', async () => {
  const verify = await installer(cleanupClient(fakeClient({ installedFacts: withTriggerFacts() })));
  assert.match(verify.text, /phase=verify — .*; rolled back$/m);
  const gate = await installer(cleanupClient(fakeClient()), fakeBackup({ unchanged: [true, false] }));
  assert.match(gate.text, /phase=backup — backup artifact changed after verification; rolled back$/m);
});
