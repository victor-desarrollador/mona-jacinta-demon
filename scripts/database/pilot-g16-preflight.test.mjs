// Zero-database unit tests for scripts/database/pilot-g16-preflight.mjs: the READ-ONLY PILOT preflight of the G16
// rollout. Run with: node --test scripts/database/pilot-g16-preflight.test.mjs
// Hermetic: synthetic *.invalid URL, injected fake pg client. The real private PILOT file is never read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as P from './pilot-g16-preflight.mjs';
import { LEDGER_SQL } from './pilot-migration-states.mjs';
import { pinsOf } from './pilot-migration-generations.mjs';
import { CATALOG_35, CATALOG_36, CATALOG_SQL } from './pilot-rbac-catalog.mjs';
import { CATALOG_37 } from './pilot-rbac-catalog-generations.mjs';
import { PROJECTION_SQL, buildProjection, projectionDigest } from './app-schema-projection.mjs';
import { SNAPSHOT_SQL } from './pilot-migrate.mjs';

const MARKER = '2b4d6f81-7a9c-4e0b-8d2f-3c5e7a9b1d0f';
const OTHER = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const REF = 'pilotsynthref0000001';
const SECRET = 'PreflightPw';
const HOST = 'aws-0-synthetic.pooler.invalid';
const URL_TEXT = `postgresql://postgres.${REF}:${SECRET}@${HOST}:6543/postgres`;
const LEAKS = [SECRET, HOST, REF, URL_TEXT, os.homedir()];
const FORBIDDEN_SQL = /\b(DROP|TRUNCATE|DELETE|UPDATE|ALTER|GRANT|REVOKE|CREATE|INSERT|COMMIT)\b/i;

const rowsOf = (def) => {
  const roleId = new Map(def.roles.map(([c, id]) => [c, id]));
  const permId = new Map(def.permissions.map(([c, id]) => [c, id]));
  return {
    roles: def.roles.map(([code, id]) => ({ id, code })),
    permissions: def.permissions.map(([code, id]) => ({ id, code })),
    grants: def.grants.map(([r, p]) => ({ roleId: roleId.get(r), permissionId: permId.get(p) })),
  };
};
const rawCatalog = (tables) => ({
  tables: tables.map((t) => ({ table: t })),
  columns: tables.map((t) => ({ table: t, column: 'id', type: 'text', not_null: true, default_expr: null, identity: '', generated: '' })),
  enums: [], types: [], constraints: [], indexes: [], functions: [], triggers: [],
});
const RAW = { EXACT_G14: rawCatalog(['Sale']), EXACT_G15: rawCatalog(['Sale', 'Enum15']), EXACT_G16: rawCatalog(['Sale', 'Enum15', 'SaleVoid']) };
const SCHEMA = {
  references: Object.fromEntries(Object.entries(RAW).map(([k, raw]) => [k, { digest: projectionDigest(buildProjection(raw)) }])),
  probes: { EXACT_G14: [], EXACT_G15: [{ kind: 'table', name: 'Enum15' }], EXACT_G16: [{ kind: 'table', name: 'Enum15' }, { kind: 'table', name: 'SaleVoid' }] },
};
const ledgerOf = (g) => pinsOf(g).map((m) => ({ migration_name: m.name, checksum: m.sha256, finished: true, rolled_back: false }));
const COUNTS = Object.fromEntries(P.COUNT_TABLES.map((t, i) => [t, String(i + 3)]));

function facts() {
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
function fakeClient({ ledger, raw, catalog, marker = MARKER, readOnly = 'on' }) {
  const sql = [];
  return {
    sql,
    connection: { stream: { encrypted: true, authorized: true } },
    async connect() {},
    async query(q) {
      const text = typeof q === 'string' ? q : q.text;
      sql.push(text);
      if (text.includes("current_setting('transaction_read_only')")) return { rows: [{ read_only: readOnly }] };
      if (text.startsWith('SELECT marker_id::text AS marker_id')) return { rows: [{ marker_id: marker, environment: 'pilot' }] };
      if (text.includes('to_regclass(\'public."_prisma_migrations"\')')) return { rows: [{ present: true }] };
      if (text === LEDGER_SQL) return { rows: ledger };
      if (text === PROJECTION_SQL.searchPath) return { rows: [{ search_path: 'pg_catalog, pg_temp' }] };
      const key = Object.keys(PROJECTION_SQL).find((k) => PROJECTION_SQL[k] === text);
      if (key) return { rows: raw[key] };
      if (text === CATALOG_SQL.roles) return { rows: catalog.roles };
      if (text === CATALOG_SQL.permissions) return { rows: catalog.permissions };
      if (text === CATALOG_SQL.grants) return { rows: catalog.grants };
      const table = P.COUNT_TABLES.find((t) => P.COUNT_SQL[t] === text);
      if (table) return { rows: [{ n: COUNTS[table] }] };
      if (text.includes('to_regnamespace')) return { rows: [{ schema_exists: true, table_exists: true, test_guard_exists: false }] };
      if (text.includes('json_build_object')) return { rows: [{ facts: facts() }] };
      if (text.startsWith('SELECT environment')) return { rows: [{ environment: 'pilot', marker_id: MARKER, has_installed_at: true }] };
      return { rows: [] };
    },
    async end() {},
  };
}
const CHECK = ['--target=pilot', '--check', `--marker-id=${MARKER}`];
async function run(argv, state = {}, env = {}) {
  const out = [];
  const created = [];
  const client = fakeClient({ ledger: ledgerOf('EXACT_G14'), raw: RAW.EXACT_G14, catalog: rowsOf(CATALOG_36), ...state });
  const code = await P.main(argv, {
    urlFile: '/nonexistent/synthetic/pilot-database-url', readUrlFile: () => ({ ok: true, text: `${URL_TEXT}\n` }), env,
    createClient: (conn) => { created.push(conn); return client; }, schema: SCHEMA,
    log: (l) => out.push(l), error: (l) => out.push(l),
  });
  const text = out.join('\n');
  for (const leak of LEAKS) assert.ok(!text.includes(leak), `leaked ${leak}`);
  for (const q of client.sql) {
    assert.ok(!FORBIDDEN_SQL.test(q) || q.startsWith('SELECT json_build_object('), `mutating SQL: ${q}`);
    if (/^LOCK\b/.test(q)) assert.match(q, /IN ACCESS SHARE MODE$/, `only the marker's read lock is allowed: ${q}`);
  }
  return { code, text, created, client };
}

test('PF-01 CLI: only --check, exactly --target=pilot, canonical marker, optional project ref; no write mode exists', () => {
  assert.deepEqual(P.parseCliArgs(CHECK), { ok: true, markerId: MARKER, confirmProjectRef: null });
  assert.equal(P.parseCliArgs([...CHECK, `--confirm-project-ref=${REF}`]).ok, true);
  for (const argv of [[], ['--target=pilot', '--execute', `--marker-id=${MARKER}`], ['--target=pilot', '--dry-run', `--marker-id=${MARKER}`],
    ['--target=test', '--check', `--marker-id=${MARKER}`], [...CHECK, '--check'], [...CHECK, '--plan=' + 'a'.repeat(64)], ['--target=pilot', '--check']]) {
    assert.equal(P.parseCliArgs(argv).ok, false, argv.join(' '));
  }
});

const VERDICTS = [
  ['EXACT_G14 + CATALOG_36', { ledger: ledgerOf('EXACT_G14'), raw: RAW.EXACT_G14, catalog: rowsOf(CATALOG_36) }, 'READY_FOR_G16_MIGRATION', 0],
  ['EXACT_G16 + CATALOG_36', { ledger: ledgerOf('EXACT_G16'), raw: RAW.EXACT_G16, catalog: rowsOf(CATALOG_36) }, 'G16_READY_FOR_RBAC_37', 0],
  ['EXACT_G16 + CATALOG_37', { ledger: ledgerOf('EXACT_G16'), raw: RAW.EXACT_G16, catalog: rowsOf(CATALOG_37) }, 'G16_RBAC_37_COMPLETE', 0],
  ['EXACT_G15 half applied', { ledger: ledgerOf('EXACT_G15'), raw: RAW.EXACT_G15, catalog: rowsOf(CATALOG_36) }, 'HALF_APPLIED_G15', 0],
  ['EXACT_G14 + CATALOG_35', { ledger: ledgerOf('EXACT_G14'), raw: RAW.EXACT_G14, catalog: rowsOf(CATALOG_35) }, 'BLOCKED', 1],
  ['EXACT_G14 + CATALOG_37', { ledger: ledgerOf('EXACT_G14'), raw: RAW.EXACT_G14, catalog: rowsOf(CATALOG_37) }, 'BLOCKED', 1],
  ['EXACT_G16 + CATALOG_35', { ledger: ledgerOf('EXACT_G16'), raw: RAW.EXACT_G16, catalog: rowsOf(CATALOG_35) }, 'BLOCKED', 1],
  ['ledger G14 but G16 schema (drift)', { ledger: ledgerOf('EXACT_G14'), raw: RAW.EXACT_G16, catalog: rowsOf(CATALOG_36) }, 'BLOCKED', 1],
  ['ledger G16 but G14 schema (drift)', { ledger: ledgerOf('EXACT_G16'), raw: RAW.EXACT_G14, catalog: rowsOf(CATALOG_36) }, 'BLOCKED', 1],
  ['unknown migration in the ledger', { ledger: [...ledgerOf('EXACT_G14'), { migration_name: '20261101000000_x', checksum: 'a'.repeat(64), finished: true, rolled_back: false }], raw: RAW.EXACT_G14, catalog: rowsOf(CATALOG_36) }, 'BLOCKED', 1],
  ['altered checksum', { ledger: ledgerOf('EXACT_G14').map((r, i) => (i === 5 ? { ...r, checksum: 'b'.repeat(64) } : r)), raw: RAW.EXACT_G14, catalog: rowsOf(CATALOG_36) }, 'BLOCKED', 1],
  ['catalog with an extra permission', { ledger: ledgerOf('EXACT_G14'), raw: RAW.EXACT_G14, catalog: { ...rowsOf(CATALOG_36), permissions: [...rowsOf(CATALOG_36).permissions, { id: 'x', code: 'X' }] } }, 'BLOCKED', 1],
];
for (const [label, state, verdict, code] of VERDICTS) {
  test(`PF-02 ${label} → ${verdict}`, async () => {
    const r = await run(CHECK, state);
    assert.equal(r.code, code, r.text);
    assert.match(r.text, new RegExp(`PILOT_G16_PREFLIGHT_RESULT=${verdict}$`, 'm'));
    assert.match(r.text, /nothing was written/);
  });
}

test('PF-03 the report states identity, migrations, generation, schema, objects, catalog and the row counts', async () => {
  const r = await run([...CHECK, `--confirm-project-ref=${REF}`], { ledger: ledgerOf('EXACT_G16'), raw: RAW.EXACT_G16, catalog: rowsOf(CATALOG_37) });
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /PILOT marker proven/);
  assert.match(r.text, /matches --confirm-project-ref/);
  assert.match(r.text, /applied migrations: 16/);
  assert.match(r.text, /20261024130000_sale_void_schema/);
  assert.match(r.text, /ledger generation: EXACT_G16/);
  assert.match(r.text, /= EXACT_G16\)/);
  assert.match(r.text, /G16 objects .*all present/);
  assert.match(r.text, /RBAC catalog: CATALOG_37/);
  for (const t of P.COUNT_TABLES) assert.match(r.text, new RegExp(`rows ${t}: \\d+`));
});

test('PF-04 G16 objects missing from a database that claims G16 are counted, not hidden', async () => {
  const half = { ...RAW.EXACT_G16, tables: RAW.EXACT_G16.tables.filter((t) => t.table !== 'SaleVoid'), columns: RAW.EXACT_G16.columns.filter((c) => c.table !== 'SaleVoid') };
  const r = await run(CHECK, { ledger: ledgerOf('EXACT_G16'), raw: half, catalog: rowsOf(CATALOG_36) });
  assert.equal(r.code, 1);
  assert.match(r.text, /G16 objects .*missing 1/);
});

test('PF-05 a wrong marker, a wrong project ref or a snapshot that is not read-only stops before anything is reported', async () => {
  for (const [label, argv, state] of [
    ['marker', CHECK, { marker: OTHER }],
    ['read-only not proven', CHECK, { readOnly: 'off' }],
    ['project ref', [...CHECK, '--confirm-project-ref=otherrefsynthetic0002'], {}],
  ]) {
    const r = await run(argv, state);
    assert.equal(r.code, 1, label);
    assert.match(r.text, /PILOT_G16_PREFLIGHT_RESULT=ERROR/, label);
    assert.doesNotMatch(r.text, /VERDICT=/, label);
  }
});

test('PF-06 only fixed SELECTs inside one READ ONLY transaction that is always rolled back; no Prisma, no pg import of its own', async () => {
  const r = await run(CHECK);
  const begins = r.client.sql.filter((q) => q.startsWith('BEGIN'));
  assert.ok(begins.length >= 1);
  for (const b of begins) assert.match(b, /READ ONLY$/, 'every transaction is READ ONLY (the marker proof included)');
  assert.ok(r.client.sql.includes('ROLLBACK'));
  assert.ok(!r.client.sql.includes('COMMIT'));
  const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'pilot-g16-preflight.mjs'), 'utf8');
  assert.doesNotMatch(source, /child_process|from 'pg'|prisma migrate/);
});

test('PF-07 an ambient DATABASE_URL is never the identity and is never used', async () => {
  const r = await run(CHECK, {}, { DATABASE_URL: 'postgresql://postgres.hostileref00000000x:hostilepw@dev-hostile.invalid:5432/postgres' });
  assert.equal(r.code, 0, r.text);
  for (const conn of r.created) assert.equal(conn.host, HOST);
  assert.ok(!r.text.includes('hostile'));
});

test('PF-08 every statement is on a fixed allowlist: SET LOCAL / SELECT / BEGIN READ ONLY / ROLLBACK / ACCESS SHARE lock only', async () => {
  for (const state of [{}, { ledger: ledgerOf('EXACT_G16'), raw: RAW.EXACT_G16, catalog: rowsOf(CATALOG_37) }]) {
    const r = await run(CHECK, state);
    for (const q of r.client.sql) {
      assert.match(q.trim(), /^(SELECT|WITH|SET LOCAL|BEGIN\b.*READ ONLY|ROLLBACK|LOCK TABLE mona_pilot_guard\.database_identity IN ACCESS SHARE MODE)/, q);
    }
  }
});

test('PF-09 statically: none of the 30 statements the preflight can send (projection, snapshot, ledger, catalog, counts) writes', () => {
  const all = [...Object.values(PROJECTION_SQL), ...Object.values(SNAPSHOT_SQL).flat(), ...Object.values(CATALOG_SQL), LEDGER_SQL, ...Object.values(P.COUNT_SQL)];
  assert.ok(all.length >= 30);
  for (const q of all) assert.doesNotMatch(q, /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|COMMIT|pg_advisory\w*)\b/i, q);
  assert.match(SNAPSHOT_SQL.begin, /READ ONLY$/);
});
