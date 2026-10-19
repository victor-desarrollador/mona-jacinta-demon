import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  D5H_MIGRATIONS,
  EXPECTATIONS,
  buildClientConfig,
  classifyMigrationHistory,
  evaluateExpectation,
  main,
  runPreflight,
} from './d5h-preflight.mjs';
import { parseHostedTestConfig, toConnectionString } from './hosted-test-config.mjs';

// DB-free by construction: every client here is an in-memory fake injected through
// `deps`; the default dependencies (which would open a file and a socket) are never
// used. All hostnames, passwords and ids are synthetic.

const REF = 'abcdefghij0123456789';
const HOST = 'aws-0-us-east-1.pooler.supabase.com';
const PASSWORD = 'Syn7hetic-Passw0rd';
const MARKER = '3f2b8c1e-5d4a-4b6f-8a7c-1d2e3f4a5b6c';
const OTHER_MARKER = '9c1d2e3f-0a1b-4c2d-9e3f-a1b2c3d4e5f6';
const SECRET_URL = `postgresql://postgres.${REF}:${PASSWORD}@${HOST}:5432/postgres`;
const LEAKS = [PASSWORD, HOST, REF, `postgres.${REF}`, SECRET_URL, MARKER];
const CONFIG = Buffer.from(`TEST_DATABASE_URL=${SECRET_URL}\nTEST_DATABASE_MARKER_ID=${MARKER}\n`);

const EXPECTED_PINS = [
  ['20260907015311_init', 'a584edab13a2ae540d694578ffa3b5a622decff04e238a5cf16d3040d295e4cb'],
  ['20260912182432_add_company_location', '19c345aa92c79a0a613dc03ea01dcf10e91b5a75fd6f3535076d8d71b6f740af'],
  ['20260912191702_add_user_role_scope', '2b415411eddc1212bf60419ce49022cea38d1fc2d12cb08938ad7c953caf7f3a'],
  ['20260922210000_d3_initial_stock_and_global_audit', '62b3b169e06a48dc2e2a3f81cee11e02a809b2733db2453c5b9eef91c15f77cf'],
  ['20261002120000_block1_pricing_wholesale', '45cf8d080e8fa4ec0a8dab9c9e5d4b780eb1642f0a8992d43b57dff655250173'],
  ['20261006120000_pilot_pricing_v2', 'd948f74e9c0eed3ce959f5c0e6edea70871d7d5957275f3304922e31bab6df12'],
];
// Repository-tree compatibility only. D5H v1's operational ledger contract
// remains the six independent EXPECTED_PINS above.
const CASH1_TREE_ENTRY = Object.freeze({
  name: '20261012120000_cash_session_reconciliation',
  bytes: 390,
  sha256: 'd98b7ce082bff6810312866c81c26203146dff03c7a12e5f3bd6a595893fc47f',
});
// Reviewed repository-tree entries. D5H v1's operational ledger contract stays the
// six independent EXPECTED_PINS above; every reviewed migration (CASH-1, the two R3
// migrations, the cash-exit migration 10 and the cash-reversal migration 11) is recognized here only so the tree pin
// does not drift. None widens D5H_MIGRATIONS, and none authorizes a D5H backup over
// a subject carrying them.
const R3_TREE_ENTRIES = Object.freeze([
  Object.freeze({
    name: '20261016120000_r3_proportional_checkout',
    bytes: 15340,
    sha256: '217e87eb5b156a57a5edcfd73433e1e9558ce59caa019208d9df8c0268f08dc6',
  }),
  Object.freeze({
    name: '20261016130000_r3_checkout_attempts',
    bytes: 35290,
    sha256: '076884120da38a05099ee00dbb16aafaa9e8c78f5846889fe7f590a8e95d9148',
  }),
]);
const CASH_MOVEMENT_TREE_ENTRY = Object.freeze({
  name: '20261018120000_cash_movement_withdrawals_expenses',
  bytes: 2732,
  sha256: 'e37149442d1fb82ec87877e7b3e1f2e4311b36a9d47d314a3fd1843702c5adf9',
});
const CASH_REVERSAL_TREE_ENTRY = Object.freeze({
  name: '20261018180000_cash_movement_reversals',
  bytes: 3366,
  sha256: 'd638559da376f5c4fb1f71136027c0af426906b8b8a2c582f388e73ffd1b3770',
});
const REVIEWED_TREE_ENTRIES = Object.freeze([CASH1_TREE_ENTRY, ...R3_TREE_ENTRIES, CASH_MOVEMENT_TREE_ENTRY, CASH_REVERSAL_TREE_ENTRY]);
const REVIEWED_TREE_MESSAGE = 'the migrations directory holds exactly the six D5H pins, CASH-1, the two R3 migrations, the cash-exit migration 10 and the cash-reversal migration 11';
const REVIEWED_TREE_NAMES = Object.freeze([...EXPECTED_PINS.map(([name]) => name), ...REVIEWED_TREE_ENTRIES.map((e) => e.name)]);
const NAMES = EXPECTED_PINS.map(([name]) => name);
const row = (i, patch = {}) => ({ migration_name: EXPECTED_PINS[i][0], checksum: EXPECTED_PINS[i][1], finished: true, rolled_back: false, ...patch });
const applied = (n) => Array.from({ length: n }, (_, i) => row(i));
const statuses = (c) => c.migrations.map((m) => m.status);

const noLeak = (value) => {
  const text = JSON.stringify(value);
  for (const leak of LEAKS) assert.ok(!text.includes(leak), `leaked ${leak}`);
};

// --- pins -------------------------------------------------------------------------------

function assertReviewedMigrationTree(root, list = readdirSync, read = readFileSync) {
  const onDisk = list(root).filter((name) => name !== 'migration_lock.toml').sort();
  assert.deepEqual(onDisk, [...REVIEWED_TREE_NAMES].sort(), REVIEWED_TREE_MESSAGE);
  for (const [name, sha] of EXPECTED_PINS) {
    const bytes = read(path.join(root, name, 'migration.sql'));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), sha, name);
  }
  for (const entry of REVIEWED_TREE_ENTRIES) {
    const sql = read(path.join(root, entry.name, 'migration.sql'));
    assert.equal(sql.length, entry.bytes, entry.name);
    assert.equal(createHash('sha256').update(sql).digest('hex'), entry.sha256, entry.name);
  }
}

test('D5H v1 keeps six independent pins and verifies the eleven-directory tree (no drift)', () => {
  assert.equal(D5H_MIGRATIONS.length, 6);
  assert.deepEqual(D5H_MIGRATIONS.map((m) => [m.name, m.sha256]), EXPECTED_PINS);
  const root = fileURLToPath(new URL('../../api/prisma/migrations/', import.meta.url));
  assertReviewedMigrationTree(root);
  assert.ok(Object.isFrozen(D5H_MIGRATIONS));
});

test('the reviewed-tree drift guard rejects an unapproved entry, a rename, a missing entry and changed SQL bytes', () => {
  const root = fileURLToPath(new URL('../../api/prisma/migrations/', import.meta.url));
  const names = [...REVIEWED_TREE_NAMES, 'migration_lock.toml'];
  const r3Name = R3_TREE_ENTRIES[0].name;
  for (const entries of [
    [...names, '20270101000000_unapproved'],
    [...names, 'README.md'],
    names.filter((name) => name !== CASH1_TREE_ENTRY.name),
    names.filter((name) => name !== r3Name),
    names.map((name) => name === CASH1_TREE_ENTRY.name ? '20261012120000_cash_session_reconciliations' : name),
    names.map((name) => name === r3Name ? `${r3Name}_renamed` : name),
  ]) {
    assert.throws(() => assertReviewedMigrationTree(root, () => entries), {
      name: 'AssertionError', message: new RegExp(REVIEWED_TREE_MESSAGE),
    });
  }
  const changed = (name, transform) => (file) => {
    const bytes = readFileSync(file);
    if (file !== path.join(root, name, 'migration.sql')) return bytes;
    return transform(bytes);
  };
  for (const name of [CASH1_TREE_ENTRY.name, r3Name, CASH_MOVEMENT_TREE_ENTRY.name, CASH_REVERSAL_TREE_ENTRY.name]) {
    assert.throws(() => assertReviewedMigrationTree(root, () => names, changed(name, (bytes) => {
      const altered = Buffer.from(bytes);
      altered[0] ^= 1;
      return altered;
    })), { name: 'AssertionError', message: new RegExp(name) });
    assert.throws(() => assertReviewedMigrationTree(root, () => names, changed(name, (bytes) => bytes.subarray(1))), {
      name: 'AssertionError', message: new RegExp(name),
    });
  }
  assert.throws(() => assertReviewedMigrationTree(root, () => names, changed(NAMES[0], (bytes) => {
    const altered = Buffer.from(bytes);
    altered[0] ^= 1;
    return altered;
  })), { name: 'AssertionError', message: new RegExp(NAMES[0]) });
});

test('the expectations are exactly pre-deploy and post-deploy', () => {
  assert.deepEqual([...EXPECTATIONS], ['pre-deploy', 'post-deploy']);
});

// --- classifier -------------------------------------------------------------------------

test('classifier: four applied and two missing; all six applied; empty ledger', () => {
  assert.deepEqual(statuses(classifyMigrationHistory(applied(4))), ['APPLIED_CLEAN', 'APPLIED_CLEAN', 'APPLIED_CLEAN', 'APPLIED_CLEAN', 'MISSING', 'MISSING']);
  assert.deepEqual(statuses(classifyMigrationHistory(applied(6))), Array(6).fill('APPLIED_CLEAN'));
  assert.deepEqual(statuses(classifyMigrationHistory([])), Array(6).fill('MISSING'));
  assert.deepEqual(classifyMigrationHistory(applied(6)).migrations.map((m) => m.name), NAMES);
  assert.equal(classifyMigrationHistory(applied(6)).unexpected, 0);
});

test('classifier: a wrong, uppercased, padded or null checksum is CHECKSUM_MISMATCH', () => {
  for (const checksum of ['0'.repeat(64), EXPECTED_PINS[2][1].toUpperCase(), ` ${EXPECTED_PINS[2][1]}`, `${EXPECTED_PINS[2][1]}\n`, null, '', EXPECTED_PINS[2][1].slice(1)]) {
    const rows = applied(6);
    rows[2] = row(2, { checksum });
    const c = classifyMigrationHistory(rows);
    assert.equal(c.migrations[2].status, 'CHECKSUM_MISMATCH', String(checksum));
    assert.equal(c.migrations[1].status, 'APPLIED_CLEAN');
  }
});

test('classifier: unfinished is INCOMPLETE, rolled back is ROLLED_BACK, and neither is ever clean', () => {
  const rows = applied(6);
  rows[3] = row(3, { finished: false });
  assert.equal(classifyMigrationHistory(rows).migrations[3].status, 'INCOMPLETE');
  rows[3] = row(3, { finished: false, rolled_back: true });
  assert.equal(classifyMigrationHistory(rows).migrations[3].status, 'ROLLED_BACK');
  rows[3] = row(3, { finished: true, rolled_back: true });
  assert.equal(classifyMigrationHistory(rows).migrations[3].status, 'ROLLED_BACK');
  rows[3] = row(3, { finished: 'true' });
  assert.equal(classifyMigrationHistory(rows).migrations[3].status, 'INCOMPLETE', 'a non-boolean flag is not finished');
});

test('classifier: any repeated row for a migration is DUPLICATE (including a rolled-back plus applied pair)', () => {
  const doubled = [...applied(4), row(3)];
  assert.equal(classifyMigrationHistory(doubled).migrations[3].status, 'DUPLICATE');
  const pair = [row(0), row(1), row(2), row(3, { finished: false, rolled_back: true }), row(3)];
  assert.equal(classifyMigrationHistory(pair).migrations[3].status, 'DUPLICATE');
});

test('classifier: unexpected rows are counted (never named) and do not disturb the pinned statuses', () => {
  const rows = [...applied(4), { migration_name: '20270101000000_secret_name_zz', checksum: 'f'.repeat(64), finished: true, rolled_back: false }, { migration_name: null, checksum: null, finished: true, rolled_back: false }, { migration_name: NAMES[0].toUpperCase(), checksum: EXPECTED_PINS[0][1], finished: true, rolled_back: false }];
  const c = classifyMigrationHistory(rows);
  assert.equal(c.unexpected, 3);
  assert.deepEqual(statuses(c).slice(0, 4), Array(4).fill('APPLIED_CLEAN'));
  assert.ok(!JSON.stringify(c).includes('secret_name_zz'));
});

test('classifier: a later migration applied while an earlier one is missing is ORDERING_GAP', () => {
  const rows = [row(0), row(1), row(2), row(4)];
  const c = classifyMigrationHistory(rows);
  assert.deepEqual(statuses(c), ['APPLIED_CLEAN', 'APPLIED_CLEAN', 'APPLIED_CLEAN', 'MISSING', 'ORDERING_GAP', 'MISSING']);
  assert.equal(classifyMigrationHistory([row(5)]).migrations[5].status, 'ORDERING_GAP');
});

test('classifier: applying migrations out of chronological order is ORDERING_GAP', () => {
  const rows = [row(1), row(0), row(2), row(3), row(4), row(5)];
  const c = classifyMigrationHistory(rows);
  assert.ok(statuses(c).includes('ORDERING_GAP'));
  assert.ok(!statuses(c).every((s) => s === 'APPLIED_CLEAN'));
});

test('classifier: garbage input never classifies as clean', () => {
  for (const bad of [undefined, null, 'rows', {}, [null], [undefined], [42], ['x'], [[]]]) {
    let c;
    try {
      c = classifyMigrationHistory(bad);
    } catch {
      continue;
    }
    assert.ok(!statuses(c).every((s) => s === 'APPLIED_CLEAN'), JSON.stringify(bad));
  }
});

// --- expectations -----------------------------------------------------------------------

test('pre-deploy passes only for four clean + two missing; post-deploy only for six clean', () => {
  const four = classifyMigrationHistory(applied(4));
  const six = classifyMigrationHistory(applied(6));
  const none = classifyMigrationHistory([]);
  const five = classifyMigrationHistory(applied(5));
  assert.equal(evaluateExpectation(four, 'pre-deploy').ok, true);
  assert.equal(evaluateExpectation(six, 'post-deploy').ok, true);
  assert.equal(evaluateExpectation(six, 'pre-deploy').ok, false, 'a deployed ledger can never pass pre-deploy');
  assert.equal(evaluateExpectation(four, 'post-deploy').ok, false, 'an undeployed ledger can never pass post-deploy');
  for (const c of [none, five]) {
    assert.equal(evaluateExpectation(c, 'pre-deploy').ok, false);
    assert.equal(evaluateExpectation(c, 'post-deploy').ok, false);
  }
  assert.equal(evaluateExpectation(four, 'pre-deploy').code, undefined);
  assert.equal(evaluateExpectation(six, 'pre-deploy').code, 'HISTORY_EXPECTATION_MISMATCH');
});

test('an unexpected row or any non-clean status fails both expectations', () => {
  const extra = classifyMigrationHistory([...applied(4), { migration_name: 'zzz', checksum: 'a'.repeat(64), finished: true, rolled_back: false }]);
  assert.equal(evaluateExpectation(extra, 'pre-deploy').ok, false);
  assert.equal(evaluateExpectation(extra, 'pre-deploy').code, 'HISTORY_INVALID');
  const bad = applied(6);
  bad[5] = row(5, { checksum: 'e'.repeat(64) });
  assert.equal(evaluateExpectation(classifyMigrationHistory(bad), 'post-deploy').code, 'HISTORY_INVALID');
  const half = applied(4);
  half.push(row(4, { finished: false }));
  assert.equal(evaluateExpectation(classifyMigrationHistory(half), 'pre-deploy').ok, false);
});

test('an unknown expectation is refused by the evaluator rather than defaulting', () => {
  const c = classifyMigrationHistory(applied(4));
  for (const bad of [undefined, null, '', 'predeploy', 'PRE-DEPLOY', 'both', 'auto', 42]) {
    assert.throws(() => evaluateExpectation(c, bad), /expectation/i, String(bad));
  }
});

// --- client config ----------------------------------------------------------------------

test('the proof connection uses discrete fields and verified TLS, never a connection string', () => {
  const held = parseHostedTestConfig(CONFIG).held;
  const config = buildClientConfig(held, 'CA-PEM');
  assert.equal(config.connectionString, undefined);
  assert.deepEqual({ host: config.host, port: config.port, database: config.database, user: config.user, password: config.password }, { host: HOST, port: 5432, database: 'postgres', user: `postgres.${REF}`, password: PASSWORD });
  assert.equal(config.ssl.rejectUnauthorized, true);
  assert.equal(config.ssl.ca, 'CA-PEM');
  assert.ok(Number.isInteger(config.connectionTimeoutMillis) && config.connectionTimeoutMillis > 0);
  assert.ok(!Object.keys(config).some((k) => /^(options|application_name|statement_timeout|service)$/i.test(k)));
});

// --- the preflight flow -----------------------------------------------------------------

function canonicalFacts() {
  return {
    schemaOwnerIsCurrentUser: true,
    relations: [{ name: 'database_identity_pkey', kind: 'i' }, { name: 'database_identity', kind: 'r' }],
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

const boom = (message, code) => Object.assign(new Error(`${message} ${SECRET_URL}`), code ? { code } : {});

function fakeDb(o = {}) {
  const {
    markerRows = [{ environment: 'test', marker_id: MARKER, has_installed_at: true }],
    ledger = true,
    rows = applied(4),
    rollback = 'ok',
    end = 'ok',
    connect = 'ok',
    failOn = null,
    failCode = '57014',
    failBegin = false,
    paymentColumn = rows.length >= 6,
    saleTables = true,
    guardCount = 0,
    guardExtra = {},
    catalogRow = null,
  } = o;
  const sql = [];
  const events = [];
  const client = {
    sql,
    events,
    on() {},
    connect() {
      events.push('connect');
      return connect === 'ok' ? Promise.resolve() : Promise.reject(boom('connect failed', '28P01'));
    },
    query(q) {
      const text = typeof q === 'string' ? q : q.text;
      sql.push(text);
      if (failBegin && text.startsWith('BEGIN')) return Promise.reject(boom('begin failed', '08006'));
      if (text === 'ROLLBACK') {
        if (rollback === 'reject') return Promise.reject(boom('rollback failed', '08006'));
        if (rollback === 'throw') throw boom('rollback threw', '08006');
        return Promise.resolve({ rows: [] });
      }
      if (failOn && text.includes(failOn)) return Promise.reject(boom('statement failed', failCode));
      if (text.includes('pg_attribute') && text.includes('paymentStartedAt')) {
        return Promise.resolve({ rows: [catalogRow ?? { sale_table: saleTables, payment_table: saleTables, column_present: paymentColumn }] });
      }
      if (text.includes('"SalePayment"') && text.includes('JOIN')) return Promise.resolve({ rows: [{ violating: guardCount, ...guardExtra }] });
      if (text.includes('_prisma_migrations') && text.includes('migration_name')) return Promise.resolve({ rows });
      if (text.includes('_prisma_migrations')) return Promise.resolve({ rows: [{ present: ledger }] });
      if (text.includes('to_regnamespace')) return Promise.resolve({ rows: [{ schema_exists: true, table_exists: true }] });
      if (text.includes('json_build_object')) return Promise.resolve({ rows: [{ facts: canonicalFacts() }] });
      if (text.startsWith('SELECT environment')) return Promise.resolve({ rows: markerRows });
      return Promise.resolve({ rows: [] });
    },
    end() {
      events.push('end');
      if (end === 'reject') return Promise.reject(boom('end failed'));
      if (end === 'throw') throw boom('end threw');
      return Promise.resolve();
    },
  };
  return client;
}

function harness(dbOptions = {}, extra = {}) {
  const db = fakeDb(dbOptions);
  const calls = { read: 0, create: [], logs: [] };
  const deps = {
    readConfigBytes: () => {
      calls.read += 1;
      return extra.config ?? CONFIG;
    },
    createClient: (held) => {
      calls.create.push(held);
      return db;
    },
    log: (line) => calls.logs.push(line),
    ...extra.deps,
  };
  return { db, calls, deps };
}

const READ_ONLY_SQL = [/^BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY$/, /^SET LOCAL /, /^LOCK TABLE [\w."]+ IN ACCESS SHARE MODE$/, /^SELECT /, /^ROLLBACK$/];

test('pre-deploy PASS: config read once, one connection from the held target, ONE read-only snapshot holding marker and ledger', async () => {
  const { db, calls, deps } = harness({ rows: applied(4) });
  const result = await runPreflight({ expectation: 'pre-deploy' }, deps);
  assert.equal(result.result, 'PASS');
  assert.equal(result.format, 'mona-d5h-preflight/v1');
  assert.equal(result.expectation, 'pre-deploy');
  assert.equal(result.marker, 'PASS');
  assert.equal(result.migrationHistory.status, 'PASS');
  assert.deepEqual(result.migrationHistory.migrations.map((m) => m.status), ['APPLIED_CLEAN', 'APPLIED_CLEAN', 'APPLIED_CLEAN', 'APPLIED_CLEAN', 'MISSING', 'MISSING']);
  assert.deepEqual(result.cleanup, { rollback: 'CONFIRMED', close: 'CONFIRMED' });
  assert.equal(calls.read, 1);
  assert.equal(calls.create.length, 1);
  const held = parseHostedTestConfig(CONFIG);
  assert.equal(result.targetDigest, held.evidence.targetDigest);
  assert.equal(result.markerDigest, held.evidence.markerDigest);
  assert.equal(toConnectionString(calls.create[0]), SECRET_URL, 'the client is built from the held parser output');
  const begins = db.sql.filter((s) => s.startsWith('BEGIN'));
  assert.equal(begins.length, 1, 'exactly one transaction: marker proof and ledger share it');
  assert.equal(db.sql[0], 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  assert.equal(db.sql.at(-1), 'ROLLBACK');
  assert.equal(db.sql.filter((s) => s === 'ROLLBACK').length, 1);
  const lock = db.sql.findIndex((s) => s.startsWith('LOCK TABLE'));
  const markerRead = db.sql.findIndex((s) => s.startsWith('SELECT environment'));
  const ledgerRead = db.sql.findIndex((s) => s.includes('migration_name'));
  assert.ok(lock > 0 && markerRead > lock && ledgerRead > markerRead, 'ACCESS SHARE lock, then the marker read, then the ledger read — all before ROLLBACK');
  assert.ok(db.sql.every((s) => READ_ONLY_SQL.some((re) => re.test(s))), `a non read-only statement was issued: ${db.sql.join(' | ')}`);
  assert.ok(!db.sql.some((s) => /\b(COMMIT|INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE|GRANT|REVOKE|COPY)\b/i.test(s)));
  noLeak(result);
});

test('post-deploy PASS with six clean migrations, and the ledger query never selects logs or step counters', async () => {
  const { db, deps } = harness({ rows: applied(6) });
  const result = await runPreflight({ expectation: 'post-deploy' }, deps);
  assert.equal(result.result, 'PASS');
  const ledgerSql = db.sql.filter((s) => s.includes('_prisma_migrations'));
  assert.ok(ledgerSql.length >= 1);
  for (const s of ledgerSql) {
    assert.ok(!/\blogs\b|applied_steps_count|\*/.test(s), s);
    assert.ok(/^SELECT /.test(s));
  }
});

test('D5H v1 post-deploy rejects CASH-1 ledger rows without naming the unexpected migration', async () => {
  const cashRow = { migration_name: CASH1_TREE_ENTRY.name, checksum: CASH1_TREE_ENTRY.sha256, finished: true, rolled_back: false };
  const cases = [
    { rows: [...applied(6), cashRow], unexpected: 1 },
    { rows: [...applied(6), cashRow, cashRow], unexpected: 2 },
    { rows: [...applied(6), { ...cashRow, checksum: '0'.repeat(64) }], unexpected: 1 },
    { rows: [cashRow, ...applied(6)], unexpected: 1 },
    { rows: [row(1), row(0), ...applied(6).slice(2), cashRow], unexpected: 1 },
  ];
  for (const { rows, unexpected } of cases) {
    const result = await runPreflight({ expectation: 'post-deploy' }, harness({ rows }).deps);
    assert.equal(result.result, 'FAIL');
    assert.equal(result.marker, 'PASS');
    assert.equal(result.migrationHistory.status, 'FAIL');
    assert.equal(result.migrationHistory.unexpected, unexpected);
    assert.deepEqual(result.failure, { phase: 'history', code: 'HISTORY_INVALID' });
    assert.ok(!JSON.stringify(result).includes(CASH1_TREE_ENTRY.name));
    noLeak(result);
  }
});

test('the phases cannot be reversed silently: pre-deploy against a deployed ledger and post-deploy against an undeployed one both FAIL', async () => {
  const a = await runPreflight({ expectation: 'pre-deploy' }, harness({ rows: applied(6) }).deps);
  assert.equal(a.result, 'FAIL');
  assert.equal(a.marker, 'PASS');
  assert.equal(a.migrationHistory.status, 'FAIL');
  assert.deepEqual(a.failure, { phase: 'history', code: 'HISTORY_EXPECTATION_MISMATCH' });
  const b = await runPreflight({ expectation: 'post-deploy' }, harness({ rows: applied(4) }).deps);
  assert.equal(b.result, 'FAIL');
  assert.deepEqual(b.failure, { phase: 'history', code: 'HISTORY_EXPECTATION_MISMATCH' });
});

test('a valid marker cannot hide invalid history', async () => {
  const bad = applied(4);
  bad[1] = row(1, { checksum: 'c'.repeat(64) });
  const result = await runPreflight({ expectation: 'pre-deploy' }, harness({ rows: bad }).deps);
  assert.equal(result.marker, 'PASS');
  assert.equal(result.result, 'FAIL');
  assert.deepEqual(result.failure, { phase: 'history', code: 'HISTORY_INVALID' });
  assert.equal(result.migrationHistory.migrations[1].status, 'CHECKSUM_MISMATCH');
});

test('valid history cannot substitute for the marker proof; history is not even read', async () => {
  const { db, deps } = harness({ markerRows: [{ environment: 'test', marker_id: OTHER_MARKER, has_installed_at: true }], rows: applied(4) });
  const result = await runPreflight({ expectation: 'pre-deploy' }, deps);
  assert.equal(result.result, 'FAIL');
  assert.equal(result.marker, 'FAIL');
  assert.equal(result.migrationHistory.status, 'NOT_EVALUATED');
  assert.deepEqual(result.failure, { phase: 'marker', code: 'MARKER_NOT_PROVEN' });
  assert.ok(!db.sql.some((s) => s.includes('migration_name')));
  assert.equal(db.sql.at(-1), 'ROLLBACK');
  noLeak(result);
});

test('an absent migration ledger is reported as such and fails both expectations', async () => {
  for (const expectation of EXPECTATIONS) {
    const result = await runPreflight({ expectation }, harness({ ledger: false, rows: [] }).deps);
    assert.equal(result.result, 'FAIL');
    assert.equal(result.migrationHistory.ledger, 'ABSENT');
    assert.deepEqual(result.migrationHistory.migrations.map((m) => m.status), Array(6).fill('MISSING'));
  }
});

test('cleanup failure can never become PASS: unconfirmed ROLLBACK or unconfirmed close', async () => {
  for (const rollback of ['reject', 'throw']) {
    const result = await runPreflight({ expectation: 'pre-deploy' }, harness({ rollback }).deps);
    assert.equal(result.result, 'FAIL', rollback);
    assert.equal(result.cleanup.rollback, 'UNCONFIRMED');
    assert.equal(result.failure.phase, 'cleanup');
    noLeak(result);
  }
  for (const end of ['reject', 'throw']) {
    const result = await runPreflight({ expectation: 'pre-deploy' }, harness({ end }).deps);
    assert.equal(result.result, 'FAIL', end);
    assert.equal(result.cleanup.close, 'UNCONFIRMED');
    noLeak(result);
  }
});

test('operational errors surface only a fixed phase and a safe code, never message text', async () => {
  const connect = await runPreflight({ expectation: 'pre-deploy' }, harness({ connect: 'reject' }).deps);
  assert.deepEqual(connect.failure, { phase: 'connect', code: '28P01' });
  assert.equal(connect.marker, 'NOT_EVALUATED');
  noLeak(connect);

  const begin = harness({ failBegin: true });
  const beginResult = await runPreflight({ expectation: 'pre-deploy' }, begin.deps);
  assert.equal(beginResult.failure.phase, 'begin');
  assert.ok(!begin.db.sql.some((s) => s.startsWith('LOCK')), 'nothing runs after a failed BEGIN');
  noLeak(beginResult);

  const mid = harness({ failOn: 'LOCK TABLE', failCode: '42501' });
  const midResult = await runPreflight({ expectation: 'pre-deploy' }, mid.deps);
  assert.deepEqual(midResult.failure, { phase: 'proof', code: '42501' });
  assert.equal(mid.db.sql.at(-1), 'ROLLBACK', 'a failed proof is still rolled back');
  assert.equal(midResult.cleanup.rollback, 'CONFIRMED');
  noLeak(midResult);

  const hist = await runPreflight({ expectation: 'pre-deploy' }, harness({ failOn: 'migration_name', failCode: '57014' }).deps);
  assert.deepEqual(hist.failure, { phase: 'history', code: '57014' });
  noLeak(hist);

  const sneaky = await runPreflight({ expectation: 'pre-deploy' }, harness({ failOn: 'LOCK TABLE', failCode: 'XX-' + PASSWORD.slice(0, 6) }).deps);
  assert.equal(sneaky.failure.code, 'unexpected', 'a code that is not a plain SQLSTATE is never echoed');
});

test('a bad expectation fails before the config is read or any client exists', async () => {
  for (const expectation of [undefined, null, '', 'predeploy', 'both', 'auto', 'PRE-DEPLOY', 7]) {
    const { calls, deps } = harness();
    const result = await runPreflight({ expectation }, deps);
    assert.equal(result.result, 'FAIL', String(expectation));
    assert.deepEqual(result.failure, { phase: 'args', code: 'EXPECTATION_INVALID' });
    assert.equal(calls.read, 0);
    assert.equal(calls.create.length, 0);
  }
});

test('a bad config fails before any client exists, with the parser code and no input text', async () => {
  const bad = [
    Buffer.from(`TEST_DATABASE_URL=${SECRET_URL}\nTEST_DATABASE_URL=${SECRET_URL}\nTEST_DATABASE_MARKER_ID=${MARKER}\n`),
    Buffer.from(`DATABASE_URL=${SECRET_URL}\nTEST_DATABASE_MARKER_ID=${MARKER}\n`),
    Buffer.from(`TEST_DATABASE_URL="${SECRET_URL}"\nTEST_DATABASE_MARKER_ID=${MARKER}\n`),
  ];
  for (const config of bad) {
    const { calls, deps } = harness({}, { config });
    const result = await runPreflight({ expectation: 'pre-deploy' }, deps);
    assert.equal(result.result, 'FAIL');
    assert.equal(result.failure.phase, 'config');
    assert.match(result.failure.code, /^CONFIG_[A-Z_]+$/);
    assert.equal(calls.create.length, 0);
    assert.equal(calls.read, 1);
    noLeak(result);
  }
  const unreadable = harness({}, { deps: { readConfigBytes: () => { throw boom('ENOENT', 'ENOENT'); } } });
  const r = await runPreflight({ expectation: 'pre-deploy' }, unreadable.deps);
  assert.deepEqual(r.failure, { phase: 'config', code: 'CONFIG_UNREADABLE' });
  noLeak(r);
});

test('ambient DATABASE_URL / PG* / TEST variables cannot influence the held target or the result', async () => {
  const saved = { ...process.env };
  try {
    Object.assign(process.env, { DATABASE_URL: 'postgresql://poison:poison@dev.invalid:5432/dev', PGHOST: 'poison.invalid', PGUSER: 'poison', PGPASSWORD: 'poison', TEST_DATABASE_URL: 'poison', MONA_TEST_DATABASE_TARGET: 'local', PGOPTIONS: '-c search_path=evil' });
    const { calls, deps } = harness();
    const result = await runPreflight({ expectation: 'pre-deploy' }, deps);
    assert.equal(result.result, 'PASS');
    assert.equal(toConnectionString(calls.create[0]), SECRET_URL);
    assert.ok(!Object.keys(buildClientConfig(calls.create[0], 'CA')).some((k) => /options|service/i.test(k)));
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test('the result has a closed key set and contains no URL, host, ref, user, password or marker id in any outcome', async () => {
  const outcomes = [
    await runPreflight({ expectation: 'pre-deploy' }, harness().deps),
    await runPreflight({ expectation: 'post-deploy' }, harness().deps),
    await runPreflight({ expectation: 'pre-deploy' }, harness({ connect: 'reject' }).deps),
    await runPreflight({ expectation: 'pre-deploy' }, harness({ failOn: 'LOCK TABLE' }).deps),
    await runPreflight({ expectation: 'pre-deploy' }, harness({ rollback: 'reject' }).deps),
    await runPreflight({ expectation: 'nope' }, harness().deps),
  ];
  const allowed = new Set(['format', 'expectation', 'result', 'targetClass', 'targetDigest', 'markerDigest', 'marker', 'migrationHistory', 'paymentStartedAtColumn', 'salePaymentGuardRisk', 'predicateForm', 'violatingRows', 'cleanup', 'failure']);
  for (const o of outcomes) {
    assert.ok(Object.keys(o).every((k) => allowed.has(k)), Object.keys(o).join(','));
    noLeak(o);
  }
});

// --- CLI --------------------------------------------------------------------------------

function cli(argv, dbOptions = {}) {
  const h = harness(dbOptions);
  return main(argv, h.deps).then((code) => ({ code, ...h }));
}

test('CLI: --expect=<mode> exactly once; PASS exits 0 and prints one JSON line, FAIL exits 1', async () => {
  const pass = await cli(['--expect=pre-deploy']);
  assert.equal(pass.code, 0);
  assert.equal(pass.calls.logs.length, 1);
  assert.equal(JSON.parse(pass.calls.logs[0]).result, 'PASS');
  const fail = await cli(['--expect=post-deploy'], { rows: applied(4) });
  assert.equal(fail.code, 1);
  assert.equal(JSON.parse(fail.calls.logs[0]).result, 'FAIL');
});

test('CLI: missing, repeated, empty, spaced, unknown or extra arguments exit 2 before config or connection', async () => {
  const bad = [[], ['--expect'], ['--expect='], ['--expect=nope'], ['--expect', 'pre-deploy'], ['--expect=pre-deploy', '--expect=post-deploy'], ['--expect=pre-deploy', '--expect=pre-deploy'], ['--expect=pre-deploy', '--live'], ['pre-deploy'], ['--EXPECT=pre-deploy'], ['--expect=pre-deploy', 'extra']];
  for (const argv of bad) {
    const r = await cli(argv);
    assert.equal(r.code, 2, argv.join(' '));
    assert.equal(r.calls.read, 0);
    assert.equal(r.calls.create.length, 0);
    assert.equal(JSON.parse(r.calls.logs[0]).failure.phase, 'args');
  }
});

// --- failure codes (found by adversarial case S3: a code derived from a secret) ------------

test('failure codes are SQLSTATE or allow-listed Node codes only, and never derived from a secret', async () => {
  const codeOf = async (code) => {
    const { db: _db, deps } = harness({}, { deps: { proveMarker: async () => { throw Object.assign(new Error(`x ${SECRET_URL}`), { code }); } } });
    const result = await runPreflight({ expectation: 'pre-deploy' }, deps);
    noLeak(result);
    assert.equal(result.cleanup.rollback, 'CONFIRMED', `cleanup still ran for ${String(code)}`);
    return result.failure.code;
  };
  assert.equal(await codeOf('28P01'), '28P01');
  assert.equal(await codeOf('ECONNREFUSED'), 'ECONNREFUSED');
  for (const hostile of ['SYN7HETICPASSW0RD', 'ABCDE', 'POOLER', 'AWS0USEAST1POOLERSUPABASECOM', 'econnrefused', 'A'.repeat(41), 'HAS-HYPHEN', 'HAS SPACE', '', 12345, null, {}, ['28P01']]) {
    assert.equal(await codeOf(hostile), 'unexpected', JSON.stringify(hostile));
  }
});

test('an error whose code getter throws still gets full cleanup and a safe result', async () => {
  const hostile = { get code() { throw new Error(`getter ${SECRET_URL}`); } };
  const { db, deps } = harness({}, { deps: { proveMarker: async () => { throw hostile; } } });
  const result = await runPreflight({ expectation: 'pre-deploy' }, deps);
  assert.equal(result.result, 'FAIL');
  assert.deepEqual(result.failure, { phase: 'proof', code: 'unexpected' });
  assert.equal(result.cleanup.rollback, 'CONFIRMED');
  assert.equal(db.sql.at(-1), 'ROLLBACK');
  assert.deepEqual(db.events.at(-1), 'end');
  noLeak(result);
});

// --- D5H-I1a.1: SalePayment guard-risk evidence (same snapshot, read-only) -----------------

const guardOf = (r) => ({ risk: r.salePaymentGuardRisk, form: r.predicateForm, rows: r.violatingRows, column: r.paymentStartedAtColumn });
const MIGRATION_SQL = readFileSync(fileURLToPath(new URL('../../api/prisma/migrations/20261002120000_block1_pricing_wholesale/migration.sql', import.meta.url)), 'utf8');
const isPredicate = (s) => s.includes('FROM public."SalePayment" p JOIN');
const squash = (text) => text.replace(/\s+/g, ' ').trim();

test('pre-deploy: column absent and no SalePayment rows -> CLEAR with the post-migration-equivalent form', async () => {
  const result = await runPreflight({ expectation: 'pre-deploy' }, harness({ rows: applied(4), guardCount: 0 }).deps);
  assert.equal(result.result, 'PASS');
  assert.deepEqual(guardOf(result), { risk: 'CLEAR', form: 'post-migration-equivalent', rows: 0, column: 'ABSENT' });
});

test('pre-deploy: a SalePayment joined to its Sale -> PRESENT, and the proofs still PASS (risk is not a proof failure)', async () => {
  const result = await runPreflight({ expectation: 'pre-deploy' }, harness({ rows: applied(4), guardCount: 3 }).deps);
  assert.equal(result.result, 'PASS');
  assert.equal(result.failure, undefined);
  assert.deepEqual(guardOf(result), { risk: 'PRESENT', form: 'post-migration-equivalent', rows: 3, column: 'ABSENT' });
});

test('post-deploy: exact predicate false -> CLEAR; true -> PRESENT; both keep result PASS', async () => {
  const clear = await runPreflight({ expectation: 'post-deploy' }, harness({ rows: applied(6), guardCount: 0 }).deps);
  assert.equal(clear.result, 'PASS');
  assert.deepEqual(guardOf(clear), { risk: 'CLEAR', form: 'exact', rows: 0, column: 'PRESENT' });
  const present = await runPreflight({ expectation: 'post-deploy' }, harness({ rows: applied(6), guardCount: 2 }).deps);
  assert.equal(present.result, 'PASS');
  assert.deepEqual(guardOf(present), { risk: 'PRESENT', form: 'exact', rows: 2, column: 'PRESENT' });
});

test('mode and catalog must agree: pre-deploy with the column present, or post-deploy with it absent, FAILS closed without running a predicate', async () => {
  const a = harness({ rows: applied(4), paymentColumn: true, guardCount: 9 });
  const pre = await runPreflight({ expectation: 'pre-deploy' }, a.deps);
  assert.equal(pre.result, 'FAIL');
  assert.deepEqual(pre.failure, { phase: 'guard', code: 'CATALOG_EXPECTATION_MISMATCH' });
  assert.equal(pre.salePaymentGuardRisk, 'NOT_EVALUATED');
  assert.equal(pre.paymentStartedAtColumn, 'PRESENT');
  assert.ok(!a.db.sql.some(isPredicate), 'no predicate after a contradicting catalog');
  const b = harness({ rows: applied(6), paymentColumn: false, guardCount: 9 });
  const post = await runPreflight({ expectation: 'post-deploy' }, b.deps);
  assert.equal(post.result, 'FAIL');
  assert.deepEqual(post.failure, { phase: 'guard', code: 'CATALOG_EXPECTATION_MISMATCH' });
  assert.equal(post.paymentStartedAtColumn, 'ABSENT');
  assert.equal(post.salePaymentGuardRisk, 'NOT_EVALUATED');
  assert.ok(!b.db.sql.some(isPredicate));
});

test('the guard probe shares the ONE snapshot: one client, one BEGIN, after marker and ledger, before the single ROLLBACK', async () => {
  const { db, calls, deps } = harness({ rows: applied(4), guardCount: 1 });
  await runPreflight({ expectation: 'pre-deploy' }, deps);
  assert.equal(calls.create.length, 1);
  assert.equal(db.sql.filter((s) => s.startsWith('BEGIN')).length, 1);
  assert.equal(db.sql.filter((s) => s === 'ROLLBACK').length, 1);
  const idx = (re) => db.sql.findIndex((s) => re.test(s));
  const marker = idx(/^SELECT environment/);
  const ledger = idx(/migration_name/);
  const catalog = idx(/AS column_present/);
  const predicate = idx(/FROM public\."SalePayment" p JOIN/);
  assert.ok(marker > 0 && ledger > marker && catalog > ledger && predicate > catalog && predicate < db.sql.length - 1, db.sql.join(' | '));
  assert.equal(db.sql.at(-1), 'ROLLBACK');
  assert.ok(db.sql.every((s) => READ_ONLY_SQL.some((re) => re.test(s))));
  assert.ok(!db.sql.some((s) => /\b(COMMIT|INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE|CALL|GRANT|REVOKE|COPY)\b/i.test(s)));
});

test('the exact predicate matches the Block 1 migration guard; the pre-deploy form never names the absent column', async () => {
  const post = harness({ rows: applied(6) });
  await runPreflight({ expectation: 'post-deploy' }, post.deps);
  const exact = post.db.sql.find(isPredicate);
  const migration = squash(MIGRATION_SQL);
  const predicate = 'WHERE s."paymentStartedAt" IS NULL OR p."paidAt" < s."paymentStartedAt"';
  const join = 'FROM public."SalePayment" p JOIN public."Sale" s ON s."id" = p."saleId"';
  assert.ok(migration.includes(predicate) && migration.includes(join), 'migration text changed: re-review the probe');
  assert.ok(squash(exact).includes(predicate) && squash(exact).includes(join));
  const pre = harness({ rows: applied(4) });
  await runPreflight({ expectation: 'pre-deploy' }, pre.deps);
  const equivalent = pre.db.sql.find(isPredicate);
  assert.ok(squash(equivalent).includes(join));
  assert.ok(!equivalent.includes('paymentStartedAt') && !equivalent.includes('paidAt'), 'column absent before the migration');
});

test('guard output is a count only: no row data, ids, timestamps or secrets even if the server returned more', async () => {
  const result = await runPreflight({ expectation: 'post-deploy' }, harness({ rows: applied(6), guardCount: 4, guardExtra: { saleId: 'sale-secret-id', paidAt: '2026-10-01T00:00:00Z', password: PASSWORD } }).deps);
  const text = JSON.stringify(result);
  for (const leak of ['sale-secret-id', '2026-10-01', PASSWORD]) assert.ok(!text.includes(leak), leak);
  assert.equal(result.violatingRows, 4);
  noLeak(result);
});

test('a malformed guard answer fails closed: tables missing, non-boolean catalog flag, bad count', async () => {
  const missing = await runPreflight({ expectation: 'pre-deploy' }, harness({ rows: applied(4), saleTables: false }).deps);
  assert.deepEqual(missing.failure, { phase: 'guard', code: 'GUARD_TABLES_MISSING' });
  const weird = await runPreflight({ expectation: 'pre-deploy' }, harness({ rows: applied(4), catalogRow: { sale_table: true, payment_table: true, column_present: 'f' } }).deps);
  assert.deepEqual(weird.failure, { phase: 'guard', code: 'GUARD_SHAPE' });
  for (const guardCount of [-1, 1.5, '3', null, Symbol.for('x'), Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, [], {}, true]) {
    const r = await runPreflight({ expectation: 'pre-deploy' }, harness({ rows: applied(4), guardCount }).deps);
    assert.equal(r.result, 'FAIL', String(guardCount));
    assert.deepEqual(r.failure, { phase: 'guard', code: 'GUARD_SHAPE' }, String(guardCount));
    assert.equal(r.salePaymentGuardRisk, 'NOT_EVALUATED');
    assert.equal(r.violatingRows, null);
  }
  const absent = await runPreflight({ expectation: 'pre-deploy' }, harness({ rows: applied(4), guardExtra: { violating: undefined } }).deps);
  assert.deepEqual(absent.failure, { phase: 'guard', code: 'GUARD_SHAPE' }, 'a missing count is never read as zero');
});

test('the guard is not evaluated when the marker or the ledger already failed', async () => {
  const marker = harness({ markerRows: [{ environment: 'test', marker_id: OTHER_MARKER, has_installed_at: true }], rows: applied(4), guardCount: 5 });
  const a = await runPreflight({ expectation: 'pre-deploy' }, marker.deps);
  assert.equal(a.salePaymentGuardRisk, 'NOT_EVALUATED');
  assert.ok(!marker.db.sql.some((s) => isPredicate(s) || s.includes('paymentStartedAt')));
  const ledger = harness({ rows: applied(6), guardCount: 5 });
  const b = await runPreflight({ expectation: 'pre-deploy' }, ledger.deps);
  assert.equal(b.failure.phase, 'history');
  assert.equal(b.salePaymentGuardRisk, 'NOT_EVALUATED');
  assert.ok(!ledger.db.sql.some(isPredicate));
});

test('a guard query error surfaces only a safe code, is rolled back, and leaks nothing', async () => {
  const h = harness({ rows: applied(4), failOn: 'AS violating', failCode: '42501' });
  const r = await runPreflight({ expectation: 'pre-deploy' }, h.deps);
  assert.deepEqual(r.failure, { phase: 'guard', code: '42501' });
  assert.equal(r.salePaymentGuardRisk, 'NOT_EVALUATED');
  assert.equal(r.cleanup.rollback, 'CONFIRMED');
  assert.equal(h.db.sql.at(-1), 'ROLLBACK');
  noLeak(r);
});

test('PRESENT never rescues an unconfirmed rollback: cleanup failure is still FAIL', async () => {
  const r = await runPreflight({ expectation: 'post-deploy' }, harness({ rows: applied(6), guardCount: 1, rollback: 'reject' }).deps);
  assert.equal(r.result, 'FAIL');
  assert.equal(r.failure.phase, 'cleanup');
});

test('every non-guard outcome reports the guard as NOT_EVALUATED with null detail', async () => {
  for (const r of [await runPreflight({ expectation: 'nope' }, harness().deps), await runPreflight({ expectation: 'pre-deploy' }, harness({ connect: 'reject' }).deps)]) {
    assert.equal(r.salePaymentGuardRisk, 'NOT_EVALUATED');
    assert.equal(r.predicateForm, null);
    assert.equal(r.violatingRows, null);
    assert.equal(r.paymentStartedAtColumn, 'NOT_EVALUATED');
  }
});

test('CLI exit codes: PRESENT is exit 0 alone, exit 3 with --require-guard-clear; proof failure 1; usage 2', async () => {
  const present = { rows: applied(4), guardCount: 2 };
  assert.equal((await cli(['--expect=pre-deploy'], present)).code, 0);
  assert.equal((await cli(['--expect=pre-deploy', '--require-guard-clear'], present)).code, 3);
  assert.equal((await cli(['--require-guard-clear', '--expect=pre-deploy'], present)).code, 3, 'option order is free');
  const clear = { rows: applied(4), guardCount: 0 };
  assert.equal((await cli(['--expect=pre-deploy', '--require-guard-clear'], clear)).code, 0);
  const proofFails = { rows: applied(6), guardCount: 2 };
  assert.equal((await cli(['--expect=pre-deploy', '--require-guard-clear'], proofFails)).code, 1, 'a proof failure is 1 even when the guard would be PRESENT');
  const contradicts = { rows: applied(4), paymentColumn: true, guardCount: 2 };
  assert.equal((await cli(['--expect=pre-deploy', '--require-guard-clear'], contradicts)).code, 1);
  for (const argv of [['--require-guard-clear'], ['--expect=pre-deploy', '--require-guard-clear', '--require-guard-clear'], ['--expect=pre-deploy', '--require-guard-clear=true'], ['--expect=pre-deploy', '--require-guard'], ['--expect=pre-deploy', '--require-guard-clear', 'x']]) {
    const r = await cli(argv, present);
    assert.equal(r.code, 2, argv.join(' '));
    assert.equal(r.calls.read, 0);
    assert.equal(r.calls.create.length, 0);
  }
  const printed = JSON.parse((await cli(['--expect=pre-deploy', '--require-guard-clear'], present)).calls.logs[0]);
  assert.equal(printed.result, 'PASS');
  assert.equal(printed.salePaymentGuardRisk, 'PRESENT');
});
