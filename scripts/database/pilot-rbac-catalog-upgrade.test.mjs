// Zero-database unit tests for scripts/database/pilot-rbac-catalog-upgrade.mjs: the OWNER-only,
// PILOT-only, transactional RBAC catalog upgrade CATALOG_35 → CATALOG_36 (CASH_MOVEMENT_MANAGE
// plus its two default grants), idempotent on an exact CATALOG_36, CONFLICT + rollback on
// anything else. Hermetic: synthetic *.invalid URL, injected fake pg client.
// Run with: node --test scripts/database/pilot-rbac-catalog-upgrade.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { CATALOG_35, CATALOG_36, CATALOG_SQL, UPGRADE_DELTA } from './pilot-rbac-catalog.mjs';
import { LEDGER_SQL, MIGRATION_PINS, STATES } from './pilot-migration-states.mjs';
import * as U from './pilot-rbac-catalog-upgrade.mjs';
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
const ledgerOf = (state) => STATES[state].map((name) => ({ migration_name: name, checksum: MIGRATION_PINS.find((m) => m.name === name).sha256, finished: true, rolled_back: false }));

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
function fakeDb({ catalog = rowsOf(CATALOG_35), ledger = ledgerOf('EXACT_G11'), marker = MARKER, failOn, afterInsert, commitThrows = false } = {}) {
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

async function run(argv, db = fakeDb(), { urlText = `${URL_TEXT}\n`, moduleDir = MODULE_DIR, repoDir = REPO_DIR } = {}) {
  const out = [];
  const created = [];
  const code = await U.main(argv, {
    moduleDir, repoDir,
    urlFile: '/nonexistent/synthetic/pilot-database-url', readUrlFile: () => ({ ok: true, text: urlText }), env: {},
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

test('RU-01 CLI: exactly --target=pilot, one mode, canonical marker; execute needs the project ref and the plan digest', () => {
  assert.deepEqual(U.parseCliArgs(dry), { ok: true, mode: 'dry-run', markerId: MARKER, confirmProjectRef: null, plan: null });
  assert.equal(U.parseCliArgs(exec()).ok, true);
  for (const argv of [[], ['--target=test', '--dry-run', `--marker-id=${MARKER}`], [...dry, `--plan=${planDigest}`],
    ['--target=pilot', '--execute', `--marker-id=${MARKER}`, `--confirm-project-ref=${REF}`], exec('nothex'), [...dry, '--extra=1']]) {
    assert.equal(U.parseCliArgs(argv).ok, false, argv.join(' '));
  }
});

test('RU-02 dry-run opens no client and states the exact delta, the before/after digests and the plan digest', async () => {
  const r = await run(dry);
  assert.equal(r.code, 0, r.text);
  assert.equal(r.created.length, 0);
  assert.match(r.text, /no database connection was opened/i);
  assert.match(r.text, /private URL file read once/);
  assert.match(r.text, /project identity: bound to the plan/);
  assert.match(r.text, /tooling binding: bound/);
  assert.match(r.text, /CASH_MOVEMENT_MANAGE/);
  assert.match(r.text, new RegExp(`PLAN_DIGEST=${planDigest}`));
  const targetBinding = buildTargetBinding({ environment: 'pilot', projectRef: 'pilotsynthref0000001', host: HOST, database: 'postgres', markerId: MARKER });
  const toolingBinding = buildToolingBinding({ moduleDir: MODULE_DIR, repoDir: REPO_DIR, files: U.RBAC_UPGRADE_TOOLING_FILES });
  const built = U.buildUpgradePlan({ targetBinding, toolingBinding });
  assert.equal(built.digest, planDigest, 'an identical binding rebuilds the identical digest');
  assert.deepEqual(built.plan.delta, { permission: [...UPGRADE_DELTA.permission], grants: UPGRADE_DELTA.grants.map((g) => [...g]) });
});

test('RU-03 execute with a foreign plan digest is refused before any client', async () => {
  const r = await run(exec('a'.repeat(64)));
  assert.notEqual(r.code, 0);
  assert.match(r.text, /phase=plan/);
  assert.equal(r.created.length, 0);
});

test('RU-04 exact CATALOG_35 → exactly one permission and two grants inserted, verified CATALOG_36 in the same transaction, committed', async () => {
  const db = fakeDb();
  const r = await run(exec(), db);
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /RBAC_UPGRADE_RESULT=UPGRADED/);
  const after = db.committed();
  assert.equal(after.permissions.length, 36);
  assert.equal(after.grants.length, 75);
  assert.equal(db.sql.filter((q) => q === U.UPGRADE_SQL.insertPermission).length, 1);
  assert.equal(db.sql.filter((q) => q === U.UPGRADE_SQL.insertGrants).length, 1);
  const order = db.sql.filter((q) => [U.UPGRADE_SQL.begin, U.UPGRADE_SQL.lockCatalog, U.UPGRADE_SQL.insertPermission, 'COMMIT'].includes(q));
  assert.deepEqual(order, [U.UPGRADE_SQL.begin, U.UPGRADE_SQL.lockCatalog, U.UPGRADE_SQL.insertPermission, 'COMMIT']);
});

test('RU-05 exact CATALOG_36 → verified no-op: nothing inserted, ROLLBACK, success', async () => {
  const db = fakeDb({ catalog: rowsOf(CATALOG_36) });
  const r = await run(exec(), db);
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /RBAC_UPGRADE_RESULT=NOOP_VERIFIED/);
  assert.ok(!db.sql.includes(U.UPGRADE_SQL.insertPermission));
  assert.ok(!db.sql.includes('COMMIT'));
});

test('RU-06 any other catalog → CONFLICT, ROLLBACK, nothing written', async () => {
  const r35 = rowsOf(CATALOG_35);
  const r36 = rowsOf(CATALOG_36);
  for (const [label, catalog] of [
    ['partial upgrade (permission, no grants)', { ...r35, permissions: r36.permissions }],
    ['extra role', { ...r35, roles: [...r35.roles, { id: 'x', code: 'MANAGER' }] }],
    ['missing grant', { ...r35, grants: r35.grants.slice(1) }],
    ['empty', { roles: [], permissions: [], grants: [] }],
  ]) {
    const db = fakeDb({ catalog });
    const r = await run(exec(), db);
    assert.notEqual(r.code, 0, label);
    assert.match(r.text, /RBAC_UPGRADE_RESULT=CONFLICT/, label);
    assert.ok(!db.sql.includes(U.UPGRADE_SQL.insertPermission), label);
    assert.ok(!db.sql.includes('COMMIT'), label);
    assert.deepEqual(db.committed(), catalog, label);
  }
});

test('RU-07 the ledger must already be EXACT_G11 and the marker the proven one; else refused before any write', async () => {
  for (const [label, db] of [
    ['ledger G7', fakeDb({ ledger: ledgerOf('EXACT_G7') })],
    ['ledger S4', fakeDb({ ledger: ledgerOf('EXACT_S4') })],
    ['marker changed', fakeDb({ marker: OTHER })],
  ]) {
    const r = await run(exec(), db);
    assert.notEqual(r.code, 0, label);
    assert.match(r.text, /RBAC_UPGRADE_RESULT=REFUSED/, label);
    assert.ok(!db.sql.includes(U.UPGRADE_SQL.insertPermission), label);
    assert.equal(db.committed().permissions.length, 35, label);
  }
});

test('RU-08 a post-insert verification that is not exactly CATALOG_36 rolls back (no partial write)', async () => {
  const db = fakeDb({ afterInsert: (w) => { w.grants.pop(); } });
  const r = await run(exec(), db);
  assert.notEqual(r.code, 0);
  assert.match(r.text, /RBAC_UPGRADE_RESULT=CONFLICT/);
  assert.ok(!db.sql.includes('COMMIT'));
  assert.equal(db.committed().permissions.length, 35);
});

test('RU-09 a database error mid-transaction rolls back and is never retried; an unacknowledged COMMIT is UNKNOWN (verify with A4)', async () => {
  const db = fakeDb({ failOn: 'INSERT INTO public."RolePermission"' });
  const r = await run(exec(), db);
  assert.notEqual(r.code, 0);
  assert.match(r.text, /RBAC_UPGRADE_RESULT=REFUSED/);
  assert.equal(db.sql.filter((q) => q === U.UPGRADE_SQL.begin).length, 1, 'never retried');
  assert.equal(db.committed().permissions.length, 35);
  const lost = fakeDb({ commitThrows: true });
  const r2 = await run(exec(), lost);
  assert.notEqual(r2.code, 0);
  assert.match(r2.text, /RBAC_UPGRADE_RESULT=UNKNOWN/);
  assert.match(r2.text, /A4/);
});

test('RU-10 the only writes are the two parameterized INSERTs; the transaction is SERIALIZABLE with a pinned search_path', () => {
  assert.equal(U.UPGRADE_SQL.begin, 'BEGIN ISOLATION LEVEL SERIALIZABLE');
  assert.equal(U.UPGRADE_SQL.insertPermission, 'INSERT INTO public."Permission" (id, code) VALUES ($1, $2)');
  assert.equal(U.UPGRADE_SQL.insertGrants, 'INSERT INTO public."RolePermission" ("roleId", "permissionId") VALUES ($1, $2), ($3, $4)');
  assert.equal(U.UPGRADE_SQL.lockCatalog, 'LOCK TABLE public."Role", public."Permission", public."RolePermission" IN SHARE ROW EXCLUSIVE MODE');
  const all = Object.values(U.UPGRADE_SQL).flat().join('\n');
  assert.doesNotMatch(all, /\b(DELETE|UPDATE|DROP|TRUNCATE|ALTER|GRANT|REVOKE|CREATE)\b/);
});

// --- G11-ADV-001 applied to the RBAC upgrade plan -------------------------------------

test('RU-B1 determinism: consecutive dry runs print the identical PLAN_DIGEST', async () => {
  assert.equal(await dryDigest(), planDigest);
});

test('RU-B2 the same plan against another marker id is refused as PLAN_BINDING_MISMATCH before any client', async () => {
  const argv = ['--target=pilot', '--execute', `--marker-id=${OTHER}`, `--confirm-project-ref=${REF}`, `--plan=${planDigest}`];
  const r = await run(argv);
  assert.equal(r.code, 1);
  assert.match(r.text, /phase=plan/);
  assert.match(r.text, /PLAN_BINDING_MISMATCH/);
  assert.equal(r.created.length, 0);
});

test('RU-B3 the same plan against another project, host or database of the pooler is refused (target binding)', async () => {
  for (const urlText of [
    `postgresql://postgres.othersynthref0000002:${SECRET}@${HOST}:6543/postgres\n`,
    `postgresql://postgres.${REF}:${SECRET}@aws-1-synthetic.pooler.invalid:6543/postgres\n`,
    `postgresql://postgres.${REF}:${SECRET}@${HOST}:6543/pilotdb\n`,
  ]) {
    const r = await run(exec(), fakeDb(), { urlText });
    assert.equal(r.code, 1, urlText);
    assert.match(r.text, /PLAN_BINDING_MISMATCH/);
    assert.equal(r.created.length, 0, urlText);
  }
});

test('RU-B4 an underivable project ref fails closed even at dry-run (a plan cannot bind its target)', async () => {
  const r = await run(dry, fakeDb(), { urlText: `postgresql://postgres:${SECRET}@${HOST}:6543/postgres\n` });
  assert.equal(r.code, 1);
  assert.match(r.text, /phase=target/);
  assert.match(r.text, /does not carry a derivable project ref/);
  assert.equal(r.created.length, 0);
});

test('RU-B5 a tooling byte changed after the dry run invalidates the plan (injected module root, RBAC module mutated)', async () => {
  const TMP = mkdtempSync(path.join(os.tmpdir(), 'rbac-bind-'));
  process.on('exit', () => rmSync(TMP, { recursive: true, force: true }));
  const moduleDir = path.join(TMP, 'modules');
  mkdirSync(moduleDir, { recursive: true });
  mkdirSync(path.join(TMP, 'scripts', 'certs'), { recursive: true });
  writeFileSync(path.join(TMP, 'scripts', 'certs', 'supabase-prod-ca-2021.crt'), 'FAKE-PILOT-CA\n');
  for (const { path: rel, root } of U.RBAC_UPGRADE_TOOLING_FILES) {
    if (root === 'module') cpSync(path.join(MODULE_DIR, rel), path.join(moduleDir, rel));
  }
  const plan = await dryDigest(dry, { moduleDir, repoDir: TMP });
  const target = path.join(moduleDir, 'pilot-rbac-catalog.mjs');
  cpSync(target, `${target}.bak`);
  const bytes = readFileSync(target);
  writeFileSync(target, Buffer.concat([Buffer.from('// tampered\n'), bytes]));
  const r = await run(exec(plan), fakeDb(), { moduleDir, repoDir: TMP });
  assert.equal(r.code, 1);
  assert.match(r.text, /PLAN_BINDING_MISMATCH/);
  assert.equal(r.created.length, 0);
});
