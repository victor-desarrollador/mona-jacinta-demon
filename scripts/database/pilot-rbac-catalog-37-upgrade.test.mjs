// Zero-database unit tests for scripts/database/pilot-rbac-catalog-37-upgrade.mjs: the OWNER-only,
// PILOT-only, transactional RBAC catalog upgrade CATALOG_36 → CATALOG_37 (SALE_VOID plus its single
// ADMIN grant), idempotent on an exact CATALOG_37, CONFLICT + rollback on anything else. Requires the
// ledger EXACT_G16. Hermetic: synthetic *.invalid URL, injected fake pg client.
// Run with: node --test scripts/database/pilot-rbac-catalog-37-upgrade.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { CATALOG_35, CATALOG_36, CATALOG_SQL } from './pilot-rbac-catalog.mjs';
import { CATALOG_37, UPGRADE_DELTA_37 } from './pilot-rbac-catalog-generations.mjs';
import { LEDGER_SQL } from './pilot-migration-states.mjs';
import { pinsOf } from './pilot-migration-generations.mjs';
import * as U from './pilot-rbac-catalog-37-upgrade.mjs';
import { buildTargetBinding, buildToolingBinding } from './pilot-plan-binding.mjs';

const MARKER = '2b4d6f81-7a9c-4e0b-8d2f-3c5e7a9b1d0f';
const OTHER = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const REF = 'pilotsynthref0000001';
const SECRET = 'Rbac5ecretPw';
const HOST = 'aws-0-synthetic.pooler.invalid';
const URL_TEXT = `postgresql://postgres.${REF}:${SECRET}@${HOST}:6543/postgres`;
const LEAKS = [SECRET, HOST, REF, URL_TEXT];

function rowsOf(def) {
  const roleId = new Map(def.roles.map(([code, id]) => [code, id]));
  const permId = new Map(def.permissions.map(([code, id]) => [code, id]));
  return {
    roles: def.roles.map(([code, id]) => ({ id, code })),
    permissions: def.permissions.map(([code, id]) => ({ id, code })),
    grants: def.grants.map(([r, p]) => ({ roleId: roleId.get(r), permissionId: permId.get(p) })),
  };
}
const ledgerOf = (generation) => pinsOf(generation).map((m) => ({ migration_name: m.name, checksum: m.sha256, finished: true, rolled_back: false }));

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

// A transactional fake: the catalog is copied at BEGIN and only published on COMMIT.
function fakeDb({ catalog = rowsOf(CATALOG_36), ledger = ledgerOf('EXACT_G16'), marker = MARKER, failOn, afterInsert, commitThrows = false } = {}) {
  let committed = structuredClone(catalog);
  let working = null;
  const sql = [];
  const create = () => ({
    connection: { stream: { encrypted: true, authorized: true } },
    async connect() {},
    async query(q, params = []) {
      const text = typeof q === 'string' ? q : q.text;
      sql.push(text);
      if (failOn && text.includes(failOn)) throw Object.assign(new Error(`boom ${URL_TEXT}`), { code: '40001' });
      // pilot-marker --check protocol
      if (text.includes('to_regnamespace')) return { rows: [{ schema_exists: true, table_exists: true, test_guard_exists: false }] };
      if (text.includes('json_build_object')) return { rows: [{ facts: canonicalFacts() }] };
      if (text.startsWith('SELECT environment')) return { rows: [{ environment: 'pilot', marker_id: MARKER, has_installed_at: true }] };
      // upgrade transaction
      if (text === U.UPGRADE_SQL.begin) { working = structuredClone(committed); return { rows: [] }; }
      if (text === U.UPGRADE_SQL.marker) return { rows: [{ marker_id: marker, environment: 'pilot' }] };
      if (text === LEDGER_SQL) return { rows: ledger };
      if (text === CATALOG_SQL.roles) return { rows: working.roles };
      if (text === CATALOG_SQL.permissions) return { rows: working.permissions };
      if (text === CATALOG_SQL.grants) return { rows: working.grants };
      if (text === U.UPGRADE_SQL.insertPermission) { working.permissions.push({ id: params[0], code: params[1] }); return { rows: [], rowCount: 1 }; }
      if (text === U.UPGRADE_SQL.insertGrants) {
        for (let i = 0; i < params.length; i += 2) working.grants.push({ roleId: params[i], permissionId: params[i + 1] });
        afterInsert?.(working);
        return { rows: [], rowCount: params.length / 2 };
      }
      if (text === 'COMMIT') { if (commitThrows) throw new Error('connection lost'); committed = working; working = null; return { rows: [] }; }
      if (text === 'ROLLBACK') { working = null; return { rows: [] }; }
      return { rows: [] };
    },
    async end() {},
  });
  return { create, sql, committed: () => committed };
}

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.resolve(MODULE_DIR, '..', '..');

const dry = ['--target=pilot', '--dry-run', `--marker-id=${MARKER}`];
const exec = (plan = planDigest) => ['--target=pilot', '--execute', `--marker-id=${MARKER}`, `--confirm-project-ref=${REF}`, `--plan=${plan}`];

async function run(argv, db = fakeDb(), { urlText = `${URL_TEXT}\n`, moduleDir = MODULE_DIR, repoDir = REPO_DIR, env = {} } = {}) {
  const out = [];
  const created = [];
  const code = await U.main(argv, {
    moduleDir, repoDir,
    urlFile: '/nonexistent/synthetic/pilot-database-url', readUrlFile: () => ({ ok: true, text: urlText }), env,
    createClient: (conn) => { created.push(conn); return db.create(); },
    log: (l) => out.push(l), error: (l) => out.push(l),
  });
  const text = out.join('\n');
  for (const leak of LEAKS) assert.ok(!text.includes(leak), `leaked ${leak}`);
  return { code, text, created, db };
}

// G11-ADV-001: the plan binds target+tooling, so the digest comes from the tool's own
// dry run for this fixture.
async function dryDigest(argv = dry, opts = {}) {
  const r = await run(argv, fakeDb(), opts);
  assert.equal(r.code, 0, r.text);
  const found = /PLAN_DIGEST=([0-9a-f]{64})/.exec(r.text);
  assert.ok(found, `no PLAN_DIGEST printed: ${r.text}`);
  return found[1];
}
const planDigest = await dryDigest();


const r36 = rowsOf(CATALOG_36);
const r37 = rowsOf(CATALOG_37);
const SALE_VOID_ID = UPGRADE_DELTA_37.permission[1];
const ADMIN_ID = CATALOG_36.roles.find(([code]) => code === 'ADMIN')[1];
const CASHIER_ID = CATALOG_36.roles.find(([code]) => code === 'CASHIER')[1];
const insertsOf = (db) => db.sql.filter((q) => q === U.UPGRADE_SQL.insertPermission || q === U.UPGRADE_SQL.insertGrants);

test('R37-01 CLI: exactly --target=pilot, one mode, canonical marker; execute needs the project ref and the plan digest', () => {
  assert.deepEqual(U.parseCliArgs(dry), { ok: true, mode: 'dry-run', markerId: MARKER, confirmProjectRef: null, plan: null });
  assert.equal(U.parseCliArgs(exec()).ok, true);
  for (const argv of [[], ['--target=test', '--dry-run', `--marker-id=${MARKER}`], [...dry, `--plan=${planDigest}`],
    ['--target=pilot', '--execute', `--marker-id=${MARKER}`, `--confirm-project-ref=${REF}`], exec('nothex'), [...dry, '--extra=1']]) {
    assert.equal(U.parseCliArgs(argv).ok, false, argv.join(' '));
  }
});

test('R37-02 dry-run opens no client, states the exact delta and digests, binds target and tooling', async () => {
  const r = await run(dry);
  assert.equal(r.code, 0, r.text);
  assert.equal(r.created.length, 0);
  assert.match(r.text, /no database connection was opened/i);
  assert.match(r.text, /SALE_VOID/);
  assert.match(r.text, /EXACT_G16/);
  assert.match(r.text, new RegExp(`PLAN_DIGEST=${planDigest}`));
  const targetBinding = buildTargetBinding({ environment: 'pilot', projectRef: REF, host: HOST, database: 'postgres', markerId: MARKER });
  const toolingBinding = buildToolingBinding({ moduleDir: MODULE_DIR, repoDir: REPO_DIR, files: U.RBAC_37_UPGRADE_TOOLING_FILES });
  const built = U.buildUpgradePlan({ targetBinding, toolingBinding });
  assert.equal(built.digest, planDigest);
  assert.equal(built.plan.requiredLedger, 'EXACT_G16');
  assert.deepEqual(built.plan.delta, { permission: [...UPGRADE_DELTA_37.permission], grants: UPGRADE_DELTA_37.grants.map((g) => [...g]) });
});

test('R37-03 execute with a foreign plan digest or another marker/project is refused before any client', async () => {
  for (const argv of [exec('a'.repeat(64)), ['--target=pilot', '--execute', `--marker-id=${OTHER}`, `--confirm-project-ref=${REF}`, `--plan=${planDigest}`]]) {
    const r = await run(argv);
    assert.equal(r.code, 1);
    assert.match(r.text, /phase=plan/);
    assert.equal(r.created.length, 0);
  }
  const r = await run(exec(), fakeDb(), { urlText: `postgresql://postgres.${REF}:${SECRET}@${HOST}:6543/pilotdb\n` });
  assert.match(r.text, /PLAN_BINDING_MISMATCH/);
  assert.equal(r.created.length, 0);
});

// ---- the ten mandatory cases -------------------------------------------------------------------

test('R37-M1 exact CATALOG_36 → one permission + one ADMIN grant inserted, verified CATALOG_37 in the same transaction, committed', async () => {
  const db = fakeDb();
  const r = await run(exec(), db);
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /RBAC_UPGRADE_RESULT=UPGRADED/);
  const after = db.committed();
  assert.equal(after.permissions.length, 37);
  assert.equal(after.grants.length, 76);
  assert.deepEqual(after.permissions.find((p) => p.code === 'SALE_VOID'), { id: SALE_VOID_ID, code: 'SALE_VOID' });
  assert.deepEqual(after.grants.filter((g) => g.permissionId === SALE_VOID_ID), [{ roleId: ADMIN_ID, permissionId: SALE_VOID_ID }]);
  assert.deepEqual(insertsOf(db), [U.UPGRADE_SQL.insertPermission, U.UPGRADE_SQL.insertGrants]);
  const order = db.sql.filter((q) => [U.UPGRADE_SQL.begin, U.UPGRADE_SQL.lockCatalog, U.UPGRADE_SQL.insertPermission, 'COMMIT'].includes(q));
  assert.deepEqual(order, [U.UPGRADE_SQL.begin, U.UPGRADE_SQL.lockCatalog, U.UPGRADE_SQL.insertPermission, 'COMMIT']);
});

test('R37-M2 exact CATALOG_37 → verified no-op: nothing inserted, ROLLBACK, success', async () => {
  const db = fakeDb({ catalog: r37 });
  const r = await run(exec(), db);
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /RBAC_UPGRADE_RESULT=NOOP_VERIFIED/);
  assert.equal(insertsOf(db).length, 0);
  assert.ok(!db.sql.includes('COMMIT'));
  assert.deepEqual(db.committed(), r37);
});

const conflictCases = () => [
  ['M3 exact CATALOG_35 (the 35→36 step has not run)', rowsOf(CATALOG_35)],
  ['M4 incomplete CATALOG_36 (missing grant)', { ...r36, grants: r36.grants.slice(1) }],
  ['M4 incomplete CATALOG_36 (missing permission)', { ...r36, permissions: r36.permissions.slice(1) }],
  ['M5 CATALOG_36 plus an extra permission row', { ...r36, permissions: [...r36.permissions, { id: 'x', code: 'EXTRA' }] }],
  ['M5 CATALOG_36 plus an extra role', { ...r36, roles: [...r36.roles, { id: 'x', code: 'MANAGER' }] }],
  ['M6 partial 37: permission without its grant', { ...r36, permissions: r37.permissions }],
  ['M6 partial 37: grant without its permission', { ...r36, grants: r37.grants }],
  ['M7 SALE_VOID with a wrong id', { ...r37, permissions: r37.permissions.map((p) => (p.code === 'SALE_VOID' ? { ...p, id: '00000000-0000-4000-9400-0000000000ff' } : p)) }],
  ['M8 SALE_VOID granted to the wrong role (CASHIER instead of ADMIN)', { ...r37, grants: r37.grants.map((g) => (g.permissionId === SALE_VOID_ID ? { roleId: CASHIER_ID, permissionId: SALE_VOID_ID } : g)) }],
  ['M8 SALE_VOID granted to ADMIN and CASHIER', { ...r37, grants: [...r37.grants, { roleId: CASHIER_ID, permissionId: SALE_VOID_ID }] }],
  ['empty catalog', { roles: [], permissions: [], grants: [] }],
];
for (const [label, catalog] of conflictCases()) {
  test(`R37-${label.split(' ')[0]} ${label.slice(label.indexOf(' ') + 1)} → CONFLICT, ROLLBACK, nothing written`, async () => {
    const db = fakeDb({ catalog });
    const r = await run(exec(), db);
    assert.notEqual(r.code, 0, label);
    assert.match(r.text, /RBAC_UPGRADE_RESULT=CONFLICT/, label);
    assert.equal(insertsOf(db).length, 0, label);
    assert.ok(!db.sql.includes('COMMIT'), label);
    assert.deepEqual(db.committed(), catalog, label);
  });
}

test('R37-M9 a failure while writing the grant rolls the permission back too (full rollback, never retried)', async () => {
  const db = fakeDb({ failOn: 'INSERT INTO public."RolePermission"' });
  const r = await run(exec(), db);
  assert.notEqual(r.code, 0);
  assert.match(r.text, /RBAC_UPGRADE_RESULT=REFUSED/);
  assert.equal(db.sql.filter((q) => q === U.UPGRADE_SQL.insertPermission).length, 1, 'the permission was attempted');
  assert.equal(db.sql.filter((q) => q === U.UPGRADE_SQL.begin).length, 1, 'never retried');
  assert.ok(db.sql.includes('ROLLBACK'));
  assert.ok(!db.sql.includes('COMMIT'));
  assert.deepEqual(db.committed(), r36, 'the permission insert did not survive');
});

test('R37-M10 a second run after the upgrade is a no-op: no duplicates, catalog unchanged', async () => {
  const db = fakeDb();
  const first = await run(exec(), db);
  assert.match(first.text, /RBAC_UPGRADE_RESULT=UPGRADED/);
  const afterFirst = structuredClone(db.committed());
  const second = await run(exec(), db);
  assert.equal(second.code, 0, second.text);
  assert.match(second.text, /RBAC_UPGRADE_RESULT=NOOP_VERIFIED/);
  assert.deepEqual(db.committed(), afterFirst);
  assert.equal(db.committed().permissions.filter((p) => p.code === 'SALE_VOID').length, 1);
  assert.equal(db.committed().grants.filter((g) => g.permissionId === SALE_VOID_ID).length, 1);
  assert.equal(insertsOf(db).length, 2, 'only the first run wrote');
});

// ---- guards -------------------------------------------------------------------------------------

test('R37-L1 the ledger must be exactly EXACT_G16 and the marker the proven one; else refused before any write', async () => {
  for (const [label, db] of [
    ['ledger G14', fakeDb({ ledger: ledgerOf('EXACT_G14') })],
    ['ledger G15', fakeDb({ ledger: ledgerOf('EXACT_G15') })],
    ['ledger altered checksum', fakeDb({ ledger: ledgerOf('EXACT_G16').map((row, i) => (i === 15 ? { ...row, checksum: 'f'.repeat(64) } : row)) })],
    ['marker changed', fakeDb({ marker: OTHER })],
  ]) {
    const r = await run(exec(), db);
    assert.notEqual(r.code, 0, label);
    assert.match(r.text, /RBAC_UPGRADE_RESULT=REFUSED/, label);
    assert.equal(insertsOf(db).length, 0, label);
    assert.equal(db.committed().permissions.length, 36, label);
  }
});

test('R37-L2 a post-insert verification that is not exactly CATALOG_37 rolls back (no partial write)', async () => {
  const db = fakeDb({ afterInsert: (w) => { w.grants.pop(); } });
  const r = await run(exec(), db);
  assert.notEqual(r.code, 0);
  assert.match(r.text, /RBAC_UPGRADE_RESULT=CONFLICT/);
  assert.ok(!db.sql.includes('COMMIT'));
  assert.equal(db.committed().permissions.length, 36);
});

test('R37-L3 an unacknowledged COMMIT is UNKNOWN (verify read-only before anything else)', async () => {
  const r = await run(exec(), fakeDb({ commitThrows: true }));
  assert.notEqual(r.code, 0);
  assert.match(r.text, /RBAC_UPGRADE_RESULT=UNKNOWN/);
});

test('R37-L4 the only writes are the two parameterized INSERTs; SERIALIZABLE with a pinned search_path; no permissive upsert', () => {
  assert.equal(U.UPGRADE_SQL.begin, 'BEGIN ISOLATION LEVEL SERIALIZABLE');
  assert.equal(U.UPGRADE_SQL.insertPermission, 'INSERT INTO public."Permission" (id, code) VALUES ($1, $2)');
  assert.equal(U.UPGRADE_SQL.insertGrants, 'INSERT INTO public."RolePermission" ("roleId", "permissionId") VALUES ($1, $2)');
  assert.equal(U.UPGRADE_SQL.lockCatalog, 'LOCK TABLE public."Role", public."Permission", public."RolePermission" IN SHARE ROW EXCLUSIVE MODE');
  const all = Object.values(U.UPGRADE_SQL).flat().join('\n');
  assert.doesNotMatch(all, /\b(DELETE|UPDATE|DROP|TRUNCATE|ALTER|GRANT|REVOKE|CREATE|CONFLICT)\b/i);
});

test('R37-L5 determinism and tooling binding: consecutive dry runs print the identical digest; a changed tooling byte invalidates the plan', async () => {
  assert.equal(await dryDigest(), planDigest);
  const TMP = mkdtempSync(path.join(os.tmpdir(), 'rbac37-bind-'));
  process.on('exit', () => rmSync(TMP, { recursive: true, force: true }));
  const moduleDir = path.join(TMP, 'modules');
  mkdirSync(moduleDir, { recursive: true });
  mkdirSync(path.join(TMP, 'scripts', 'certs'), { recursive: true });
  writeFileSync(path.join(TMP, 'scripts', 'certs', 'supabase-prod-ca-2021.crt'), 'FAKE-PILOT-CA\n');
  for (const { path: rel, root } of U.RBAC_37_UPGRADE_TOOLING_FILES) if (root === 'module') cpSync(path.join(MODULE_DIR, rel), path.join(moduleDir, rel));
  const plan = await dryDigest(dry, { moduleDir, repoDir: TMP });
  const target = path.join(moduleDir, 'pilot-rbac-catalog-generations.mjs');
  writeFileSync(target, Buffer.concat([Buffer.from('// tampered\n'), readFileSync(target)]));
  const r = await run(exec(plan), fakeDb(), { moduleDir, repoDir: TMP });
  assert.equal(r.code, 1);
  assert.match(r.text, /PLAN_BINDING_MISMATCH/);
  assert.equal(r.created.length, 0);
});

test('R37-L6 the tool binds the generation modules it imports', () => {
  const files = U.RBAC_37_UPGRADE_TOOLING_FILES.map((f) => f.path);
  for (const needed of ['pilot-rbac-catalog-37-upgrade.mjs', 'pilot-rbac-catalog-generations.mjs', 'pilot-migration-generations.mjs', 'pilot-rbac-catalog.mjs', 'pilot-migration-states.mjs', 'pilot-marker.mjs', 'pilot-plan-binding.mjs']) {
    assert.ok(files.includes(needed), needed);
  }
});

test('R37-G1 no mode flag never means execute; dry-run never connects; an ambient DATABASE_URL is never the identity', async () => {
  const AMBIENT = { DATABASE_URL: 'postgresql://postgres.hostileref00000000x:hostilepw@dev-hostile.invalid:5432/postgres', TEST_DATABASE_URL: 'postgresql://postgres.hostileref00000000x:hostilepw@dev-hostile.invalid:5432/postgres' };
  assert.equal(U.parseCliArgs(['--target=pilot', `--marker-id=${MARKER}`]).ok, false);
  assert.equal(U.parseCliArgs(['--target=pilot', `--marker-id=${MARKER}`, `--confirm-project-ref=${REF}`, `--plan=${planDigest}`]).ok, false);
  const dryRun = await run(dry, fakeDb(), { env: AMBIENT });
  assert.equal(dryRun.created.length, 0);
  const db = fakeDb();
  const r = await run(exec(), db, { env: AMBIENT });
  assert.equal(r.code, 0, r.text);
  for (const conn of r.created) assert.equal(conn.host, HOST);
  assert.ok(!r.text.includes('hostile'));
  const none = await run(exec(), fakeDb(), { env: AMBIENT, urlText: '' });
  assert.equal(none.code, 1, 'an unusable private file never falls back to DATABASE_URL');
  assert.equal(none.created.length, 0);
});

test('R37-G2 the identity proof is mandatory: a database whose marker check fails is never written', async () => {
  const db = fakeDb();
  const orig = db.create;
  db.create = () => { const c = orig(); const q = c.query.bind(c); c.query = async (text, ...a) => (String(text).startsWith('SELECT environment') ? { rows: [{ environment: 'test', marker_id: MARKER, has_installed_at: true }] } : q(text, ...a)); return c; };
  const r = await run(exec(), db);
  assert.equal(r.code, 1);
  assert.match(r.text, /phase=identity/);
  assert.equal(insertsOf(db).length, 0);
  assert.ok(!db.sql.includes(U.UPGRADE_SQL.begin));
});
