// DB-free tests for the LOCAL_TEST cut-over lab's security core (local-test-cutover-lab-core.mjs)
// and its single protected entry (local-test-cutover-lab.mjs). No process, cluster or socket is
// started: identity/isolation facts are synthetic, payload trees are temp copies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as L from './local-test-cutover-lab-core.mjs';
import * as E from './local-test-cutover-lab.mjs';
import { MIGRATION_PINS, LOCK_PIN } from './pilot-migration-states.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API = path.resolve(HERE, '..', '..', 'api');
const tmp = [];
const mkTmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-')); fs.chmodSync(d, 0o700); tmp.push(d); return d; };
process.on('exit', () => { for (const d of tmp) fs.rmSync(d, { recursive: true, force: true }); });
const SID = '7311234567890123456';
const MID = '11111111-1111-4111-8111-111111111111';

// ---------------- arguments ----------------
test('LAB-01 arguments: exactly one op; state ops need one exact state; rehearsal needs --from S4|G7; teardown needs a run id', () => {
  assert.deepEqual(L.parseLabArgs(['--op=provision', '--state=EXACT_S4']), { ok: true, op: 'provision', state: 'EXACT_S4', from: null, run: null });
  assert.deepEqual(L.parseLabArgs(['--op=schema-reference', '--state=EXACT_G11']).state, 'EXACT_G11');
  assert.deepEqual(L.parseLabArgs(['--op=migration-rehearsal', '--from=EXACT_G7']), { ok: true, op: 'migration-rehearsal', state: null, from: 'EXACT_G7', run: null });
  assert.equal(L.parseLabArgs(['--op=integration-test']).ok, true);
  assert.equal(L.parseLabArgs(['--op=teardown', '--run=lab-20261018T120000Z-0123abcd']).ok, true);
  for (const argv of [[], ['--op=provision'], ['--op=provision', '--state=EXACT_G10'], ['--op=provision', '--state=S4'], ['--op=provision', '--state=EXACT_S4', '--state=EXACT_S4'],
    ['--op=nuke', '--state=EXACT_S4'], ['--op=migration-rehearsal', '--from=EXACT_G11'], ['--op=migration-rehearsal'], ['--op=migration-rehearsal', '--from=EXACT_S4', '--state=EXACT_G11'],
    ['--op=teardown'], ['--op=teardown', '--run=../x'], ['--op=teardown', '--run=/abs'], ['--op=provision', '--state=EXACT_S4', '--url=postgres://x'], ['--op=integration-test', '--state=EXACT_S4'],
    ['provision']]) {
    assert.equal(L.parseLabArgs(argv).ok, false, JSON.stringify(argv));
  }
});

// ---------------- inherited environment ----------------
test('LAB-02 inherited database/provider variables are refused by name (values never echoed); only the wrapper\'s own variables reach children', () => {
  assert.deepEqual(L.checkInheritedEnv({ HOME: '/h', PATH: '/usr/bin', LANG: 'C.UTF-8', TERM: 'xterm' }), { ok: true, forbidden: [] });
  for (const name of ['DATABASE_URL', 'TEST_DATABASE_URL', 'DIRECT_URL', 'SHADOW_DATABASE_URL', 'PILOT_DATABASE_URL', 'PILOT_X', 'DEV_DATABASE_URL', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY',
    'LOCAL_TEST_DATABASE_URL', 'LOCAL_TEST_DATABASE_MARKER_ID', 'PGHOST', 'PGPASSWORD', 'PGOPTIONS', 'PGSERVICE', 'NODE_OPTIONS', 'MONA_TEST_DATABASE_TARGET', 'MONA_R3_PG_SYSTEM_ID']) {
    const r = L.checkInheritedEnv({ HOME: '/h', PATH: '/usr/bin', [name]: 'postgresql://secret@db.example.com/x' });
    assert.equal(r.ok, false, name); assert.deepEqual(r.forbidden, [name]);
  }
  const env = L.childEnv({ home: '/run/h', tmpdir: '/run/t', extra: { LOCAL_TEST_DATABASE_URL: 'u' } });
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'LANG', 'LOCAL_TEST_DATABASE_URL', 'PATH', 'PGTZ', 'TMPDIR', 'TZ']);
  assert.throws(() => L.childEnv({ home: '/h', tmpdir: '/t', extra: { DATABASE_URL: 'x' } }), /not a wrapper variable/);
});
test('LAB-03 the protected entry refuses an inherited DATABASE_URL before starting any namespace or process', async () => {
  const lines = []; let spawned = 0;
  const rc = await E.main(['--op=provision', '--state=EXACT_S4'], { env: { HOME: '/h', PATH: '/usr/bin', DATABASE_URL: 'postgresql://u:p@db.x.supabase.co/postgres' }, spawn: () => { spawned += 1; },
    log: (l) => lines.push(l), error: (l) => lines.push(l) });
  assert.equal(rc, 2); assert.equal(spawned, 0); assert.match(lines.join('\n'), /DATABASE_URL/); assert.ok(!lines.join('\n').includes('supabase.co'));
  assert.match(lines.at(-1), /^LAB_RESULT=REFUSED$/);
});
test('LAB-04 the protected entry refuses unknown states/ops before anything', async () => {
  for (const argv of [['--op=provision', '--state=EXACT_G9'], ['--op=x']]) {
    let spawned = 0; const lines = [];
    const rc = await E.main(argv, { env: { HOME: '/h', PATH: '/usr/bin' }, spawn: () => { spawned += 1; }, log: (l) => lines.push(l), error: (l) => lines.push(l) });
    assert.equal(rc, 1); assert.equal(spawned, 0);
  }
});

// ---------------- isolation ----------------
const NETDEV_LO = 'Inter-|   Receive\n face |bytes\n    lo: 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n';
const ROUTE_EMPTY = 'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n';
const V6_LO = '00000000000000000000000000000001 80 00000000000000000000000000000000 00 00000000000000000000000000000000 00000000 00000001 00000000 00200001       lo\n';
test('LAB-05 isolation: only lo, no IPv4 route, IPv6 routes only on lo, not root', () => {
  assert.deepEqual(L.proveIsolation({ netDev: NETDEV_LO, route: ROUTE_EMPTY, ipv6Route: V6_LO, uid: 1000 }), { ok: true });
  const bad = [
    [{ netDev: `${NETDEV_LO}  eth0: 0 0\n` }, /interface/],
    [{ route: `${ROUTE_EMPTY}eth0\t00000000\t0102A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0\n` }, /route/],
    [{ route: `${ROUTE_EMPTY}lo\t0000007F\t00000000\t0001\t0\t0\t0\t000000FF\t0\t0\t0\n` }, /route/],
    [{ ipv6Route: `${V6_LO}20010db8000000000000000000000000 20 00000000000000000000000000000000 00 fe800000000000000000000000000001 00000400 00000001 00000000 00000003     eth0\n` }, /route/],
    [{ uid: 0 }, /root/],
    [{ netDev: null }, /could not be read/],
  ];
  for (const [over, re] of bad) {
    const r = L.proveIsolation({ netDev: NETDEV_LO, route: ROUTE_EMPTY, ipv6Route: V6_LO, uid: 1000, ...over });
    assert.equal(r.ok, false); assert.match(r.reason, re);
  }
});

// ---------------- identity ----------------
const FACTS = () => ({
  currentDatabase: 'mona_local_test', currentUser: 'mona_local_test', databaseOwner: 'mona_local_test', serverVersionNum: '170006',
  serverAddr: '127.0.0.1', serverPort: 5432, listenAddresses: '127.0.0.1', systemIdentifier: SID, testGuard: false, pilotGuard: false,
  markerRows: [{ environment: 'local_test', marker_id: MID, has_installed_at: true }], markerStructureOk: true,
});
const EXPECTED = { systemIdentifier: SID, markerId: MID };
test('LAB-06 identity: the exact LOCAL_TEST tuple is proven', () => {
  assert.deepEqual(L.evaluateIdentity(FACTS(), EXPECTED), { ok: true });
});
for (const [label, over, re] of [
  ['missing marker', { markerRows: [] }, /marker/],
  ['wrong marker', { markerRows: [{ environment: 'local_test', marker_id: '22222222-2222-4222-8222-222222222222', has_installed_at: true }] }, /marker/],
  ['two markers', { markerRows: [FACTS().markerRows[0], FACTS().markerRows[0]] }, /marker/],
  ['marker structure drift', { markerStructureOk: false }, /marker/],
  ['wrong system_identifier', { systemIdentifier: '7311234567890123457' }, /system_identifier/],
  ['non-loopback listener', { listenAddresses: '*' }, /loopback/],
  ['non-loopback server address', { serverAddr: '10.0.0.5' }, /loopback/],
  ['wrong port', { serverPort: 6543 }, /loopback/],
  ['wrong database', { currentDatabase: 'postgres' }, /database/],
  ['wrong user', { currentUser: 'postgres' }, /user/],
  ['wrong owner', { databaseOwner: 'postgres' }, /owner/],
  ['PostgreSQL 16', { serverVersionNum: '160004' }, /PostgreSQL 17/],
  ['PostgreSQL 18', { serverVersionNum: '180000' }, /PostgreSQL 17/],
  ['TEST guard', { testGuard: true }, /TEST/],
  ['PILOT guard', { pilotGuard: true }, /PILOT/],
]) {
  test(`LAB-07 identity refused: ${label}`, () => {
    const r = L.evaluateIdentity({ ...FACTS(), ...over }, EXPECTED);
    assert.equal(r.ok, false); assert.match(r.reason, re); assert.ok(!r.reason.includes(MID));
  });
}
test('LAB-08 identity refuses a malformed expectation (no expected sysid / marker → never "anything goes")', () => {
  for (const exp of [{}, { systemIdentifier: SID }, { markerId: MID }, { systemIdentifier: '12', markerId: MID }]) assert.equal(L.evaluateIdentity(FACTS(), exp).ok, false);
});
test('LAB-09 the expected system_identifier comes from pg_controldata of the cluster the lab just created', () => {
  const text = 'pg_control version number:            1700\nDatabase system identifier:           7311234567890123456\nDatabase cluster state:               shut down\n';
  assert.equal(L.parseControlData(text), SID);
  assert.equal(L.parseControlData(text.replace('Database system identifier', 'Identificador de sistema')), null, 'only the C-locale label is accepted');
  assert.equal(L.parseControlData('Database system identifier: 12\n'), null);
});

// ---------------- FRESH ----------------
test('LAB-10 provision target must be FRESH: no app relation, no ledger, no foreign schema', () => {
  assert.deepEqual(L.evaluateFresh({ publicRelations: 0, ledgerExists: false, schemas: ['mona_local_test_guard', 'public'] }), { ok: true });
  for (const f of [{ publicRelations: 1, ledgerExists: false, schemas: ['mona_local_test_guard', 'public'] }, { publicRelations: 0, ledgerExists: true, schemas: ['mona_local_test_guard', 'public'] },
    { publicRelations: 0, ledgerExists: false, schemas: ['evil', 'mona_local_test_guard', 'public'] }, null]) {
    const r = L.evaluateFresh(f); assert.equal(r.ok, false); assert.match(r.reason, /FRESH/);
  }
});

// ---------------- exact payloads and plans ----------------
const NAMES = MIGRATION_PINS.map((p) => p.name);
test('LAB-11 EXACT_S4/G7/G11 plans contain exactly m1..m4 / m1..m7 / m1..m11 with pinned bytes and SHA-256, plus the pinned lock', () => {
  for (const [state, n] of [['EXACT_S4', 4], ['EXACT_G7', 7], ['EXACT_G11', 11]]) {
    const p = L.statePayload(state);
    assert.deepEqual(p.migrations.map((m) => m.name), NAMES.slice(0, n), state);
    assert.deepEqual(p.migrations, MIGRATION_PINS.slice(0, n));
    assert.deepEqual(p.lock, LOCK_PIN);
  }
  assert.throws(() => L.statePayload('EXACT_G10'));
});
test('LAB-12 the plan digest is reproducible SHA-256 over canonical JSON and changes with any input', () => {
  const base = { op: 'provision', state: 'EXACT_S4', from: null, prisma: { version: '7.10.0', script: 'node_modules/prisma/build/index.js' }, configSha256: 'a'.repeat(64) };
  const a = L.buildLabPlan(base); const b = L.buildLabPlan({ ...base });
  assert.match(a.digest, /^[0-9a-f]{64}$/); assert.equal(a.digest, b.digest);
  assert.equal(a.digest, createHash('sha256').update(L.canonicalJson(a.plan)).digest('hex'));
  assert.deepEqual(a.plan.migrations.map(([name]) => name), NAMES.slice(0, 4));
  for (const over of [{ state: 'EXACT_G7' }, { configSha256: 'b'.repeat(64) }, { prisma: { ...base.prisma, version: '7.10.1' } }]) assert.notEqual(L.buildLabPlan({ ...base, ...over }).digest, a.digest);
  const r = L.buildLabPlan({ op: 'migration-rehearsal', state: null, from: 'EXACT_S4', prisma: base.prisma, configSha256: 'c'.repeat(64) });
  assert.deepEqual(r.plan.migrations.map(([name]) => name), NAMES.slice(0, 4), 'source build');
  assert.deepEqual(r.plan.rehearsal.map(([name]) => name), NAMES.slice(4), 'S4 → G11 applies exactly m5..m11');
  assert.deepEqual(L.buildLabPlan({ op: 'migration-rehearsal', state: null, from: 'EXACT_G7', prisma: base.prisma, configSha256: 'c'.repeat(64) }).plan.rehearsal.map(([n]) => n), NAMES.slice(7));
});

// Temp copy of the reviewed tree (api/prisma/migrations), optionally mutated.
function treeCopy(mutate) {
  const root = mkTmp(); const to = path.join(root, 'api', 'prisma', 'migrations'); fs.mkdirSync(to, { recursive: true });
  for (const p of MIGRATION_PINS) { fs.mkdirSync(path.join(to, p.name)); fs.copyFileSync(path.join(API, 'prisma', 'migrations', p.name, 'migration.sql'), path.join(to, p.name, 'migration.sql')); }
  fs.copyFileSync(path.join(API, 'prisma', 'migrations', 'migration_lock.toml'), path.join(to, 'migration_lock.toml'));
  mutate?.(to);
  return path.join(root, 'api');
}
test('LAB-13 staging copies exactly the state\'s migrations byte-for-byte into a private mona-local-test-lab-XXXXXX tree and verifies it', () => {
  const stageRoot = mkTmp();
  for (const [state, n] of [['EXACT_S4', 4], ['EXACT_G7', 7], ['EXACT_G11', 11]]) {
    const s = L.stageStatePayload(treeCopy(), state, stageRoot);
    assert.equal(s.ok, true, s.reason);
    assert.match(s.migrationsDir, L.LAB_STAGED_MIGRATIONS_DIR);
    const names = fs.readdirSync(s.migrationsDir).sort();
    assert.deepEqual(names, [...NAMES.slice(0, n), 'migration_lock.toml'].sort());
    assert.equal(fs.statSync(s.root).mode & 0o777, 0o700);
    s.cleanup(); assert.equal(fs.existsSync(s.root), false);
  }
});
for (const [label, mutate] of [
  ['migration hash drift', (to) => fs.appendFileSync(path.join(to, NAMES[2], 'migration.sql'), '\n-- drift')],
  ['drift in a migration the state does not apply', (to) => fs.appendFileSync(path.join(to, NAMES[10], 'migration.sql'), '\n-- drift')],
  ['extra migration', (to) => { fs.mkdirSync(path.join(to, '20990101000000_evil')); fs.writeFileSync(path.join(to, '20990101000000_evil', 'migration.sql'), 'SELECT 1;'); }],
  ['missing migration', (to) => fs.rmSync(path.join(to, NAMES[9]), { recursive: true })],
  ['lock drift', (to) => fs.appendFileSync(path.join(to, 'migration_lock.toml'), '\n')],
  ['symlinked migration.sql', (to) => { const f = path.join(to, NAMES[1], 'migration.sql'); const real = `${f}.real`; fs.renameSync(f, real); fs.symlinkSync(real, f); }],
  ['symlinked migration directory', (to) => { const d = path.join(to, NAMES[0]); fs.renameSync(d, `${d}.real`); fs.symlinkSync(`${d}.real`, d); }],
  ['extra file in a migration directory', (to) => fs.writeFileSync(path.join(to, NAMES[0], 'notes.txt'), 'x')],
]) {
  test(`LAB-14 staging refused (nothing staged): ${label}`, () => {
    const stageRoot = mkTmp();
    const s = L.stageStatePayload(treeCopy(mutate), 'EXACT_S4', stageRoot);
    assert.equal(s.ok, false); assert.deepEqual(fs.readdirSync(stageRoot), []);
  });
}
test('LAB-15 staging refuses a symlinked or non-private staging root', () => {
  const real = mkTmp(); const link = path.join(mkTmp(), 'link'); fs.symlinkSync(real, link);
  assert.equal(L.stageStatePayload(treeCopy(), 'EXACT_S4', link).ok, false);
  const open = mkTmp(); fs.chmodSync(open, 0o755);
  assert.equal(L.stageStatePayload(treeCopy(), 'EXACT_S4', open).ok, false);
  assert.equal(L.stageStatePayload(treeCopy(), 'EXACT_G10', mkTmp()).ok, false);
});

// ---------------- lab root ----------------
test('LAB-16 lab root: real, owned, 0700, no symlinked component, outside the repository and /tmp-like storage', () => {
  const ok = mkTmp();
  assert.equal(L.checkLabRoot(ok, { forbiddenRoots: [path.resolve(HERE, '..', '..')] }).ok, true);
  const link = path.join(mkTmp(), 'l'); fs.symlinkSync(ok, link);
  assert.equal(L.checkLabRoot(link, { forbiddenRoots: [] }).ok, false);
  const open = mkTmp(); fs.chmodSync(open, 0o750);
  assert.equal(L.checkLabRoot(open, { forbiddenRoots: [] }).ok, false);
  assert.equal(L.checkLabRoot(ok, { forbiddenRoots: [path.dirname(ok)] }).ok, false);
  assert.equal(L.checkLabRoot('relative/dir', { forbiddenRoots: [] }).ok, false);
});

// ---------------- the wrapper's own variables ----------------
test('LAB-17 the LOCAL_TEST URL is built only by the wrapper from the cluster it proved (canonical loopback text, hex password)', () => {
  const url = L.localTestUrl('ab'.repeat(32));
  assert.equal(url, `postgresql://mona_local_test:${'ab'.repeat(32)}@127.0.0.1:5432/mona_local_test`);
  for (const pw of ['', 'x', 'ab'.repeat(31), `${'ab'.repeat(31)}a@`]) assert.throws(() => L.localTestUrl(pw));
});
test('LAB-18 every DB step is ordered: wrapper → identity proof → exact-state proof → command (no command without both proofs)', async () => {
  const order = [];
  const gate = L.createGate({ proveIdentity: async () => { order.push('identity'); return { ok: true }; }, proveState: async (s) => { order.push(`state:${s}`); return { ok: true }; } });
  await gate.run('migrate', { state: 'EXACT_S4' }, async () => { order.push('command'); return 'done'; });
  assert.deepEqual(order, ['identity', 'state:EXACT_S4', 'command']);
  const refused = L.createGate({ proveIdentity: async () => ({ ok: false, reason: 'x' }), proveState: async () => ({ ok: true }) });
  await assert.rejects(refused.run('dump', { state: 'EXACT_S4' }, async () => { throw new Error('must not run'); }), /LOCAL_TEST_IDENTITY_NOT_PROVEN/);
  const wrongState = L.createGate({ proveIdentity: async () => ({ ok: true }), proveState: async () => ({ ok: false, reason: 'ledger is EXACT_G7' }) });
  await assert.rejects(wrongState.run('dump', { state: 'EXACT_S4' }, async () => { throw new Error('must not run'); }), /EXACT_STATE_NOT_PROVEN/);
  const fresh = L.createGate({ proveIdentity: async () => ({ ok: true }), proveState: async (s) => { order.push(`fresh:${s}`); return { ok: true }; } });
  order.length = 0;
  await fresh.run('provision', { state: 'FRESH' }, async () => { order.push('command'); });
  assert.deepEqual(order, ['fresh:FRESH', 'command']);
});

// ---------------- operations layer (no cluster started) ----------------
import * as OPS from './local-test-cutover-lab-ops.mjs';
import { PRISMA_ARGS } from './pilot-migrate.mjs';
test('LAB-19 the rehearsal runs pilot-migrate\'s exact Prisma command; only the --config value differs (PILOT\'s pins Supabase TLS)', () => {
  assert.deepEqual(OPS.REHEARSAL_PRISMA_ARGS.slice(0, -1), PRISMA_ARGS.slice(0, -1));
  assert.equal(OPS.REHEARSAL_PRISMA_ARGS.at(-1), 'prisma.local-test.config.ts');
  assert.deepEqual(OPS.LAB_PRISMA_ARGS.slice(0, -1), PRISMA_ARGS.slice(0, -1));
  const src = fs.readFileSync(path.join(HERE, 'local-test-cutover-lab-ops.mjs'), 'utf8');
  assert.match(src, /const payload = verifyMigrationPayload\(API_DIR\);/, 'the rehearsal proves the reviewed tree with pilot-migrate\'s own verifier');
  assert.match(src, /upgradeCatalogInTransaction\(c\)/, 'the RBAC step reuses the production statements');
});
test('LAB-20 the lab Prisma config accepts exactly the staged directory pattern the core creates, and only the LOCAL_TEST URL', () => {
  const cfg = fs.readFileSync(path.join(API, 'prisma.local-test-lab.config.ts'), 'utf8');
  assert.ok(cfg.includes(L.LAB_STAGED_MIGRATIONS_DIR.source), 'same staged-directory regex');
  assert.match(cfg, /process\.env\.LOCAL_TEST_DATABASE_URL/); assert.match(cfg, /process\.env\.LOCAL_TEST_LAB_MIGRATIONS_DIR/);
  assert.doesNotMatch(cfg.replace(/LOCAL_TEST_DATABASE_URL/g, ''), /DATABASE_URL|loadRepositoryEnv|sslcert/);
});
test('LAB-21 no escape hatch: the ops module has no entry point, reads no shell database variable and names no remote host', () => {
  const src = fs.readFileSync(path.join(HERE, 'local-test-cutover-lab-ops.mjs'), 'utf8');
  assert.doesNotMatch(src, /process\.argv/);
  assert.doesNotMatch(src.replace(/LOCAL_TEST_DATABASE_URL/g, ''), /DATABASE_URL/);
  assert.doesNotMatch(src, /supabase\.co|pooler|pilot-database-url|railway/i);
  assert.doesNotMatch(src, /migrate', 'resolve'|db', 'push'|migrate resolve/);
  assert.match(src, /export function createLabContext[\s\S]*proveIsolation\(/, 'every operation re-proves the isolation');
});
test('LAB-22 the real-PG itest runs only through the lab (skips otherwise) and never invokes psql', () => {
  const src = fs.readFileSync(path.join(HERE, 'pilot-clone-restore.itest.mjs'), 'utf8');
  assert.match(src, /const skip = !viaLab \? 'BLOCKED: run only through local-test-cutover-lab\.mjs --op=integration-test'/);
  assert.doesNotMatch(src, /psql/);
  assert.match(src, /itestProvision\(\{ state, root: base \}\)/);
});
test('LAB-23 itestProvision refuses outside a lab integration-test run', async () => {
  const before = process.env.MONA_CUTOVER_LAB_RUN; delete process.env.MONA_CUTOVER_LAB_RUN;
  try { await assert.rejects(OPS.itestProvision({ state: 'EXACT_S4', root: '/nonexistent' }), /only inside a lab integration-test run/); } finally { if (before !== undefined) process.env.MONA_CUTOVER_LAB_RUN = before; }
});
test('LAB-24 the fixture is deterministic and carries the state\'s pinned catalog', () => {
  assert.deepEqual(OPS.fixtureStatements('EXACT_S4'), OPS.fixtureStatements('EXACT_S4'));
  assert.equal(OPS.fixtureStatements('EXACT_S4').join('\n').includes('9400-000000000036'), false, 'S4/G7 seed CATALOG_35');
  assert.equal(OPS.fixtureStatements('EXACT_G11').join('\n').includes('9400-000000000036'), true, 'G11 seeds CATALOG_36');
  assert.doesNotMatch(OPS.fixtureStatements('EXACT_G11').join('\n'), /"reason"|"reversesMovementId"|"pricingModel"|"expectedCash"/, 'columns of migrations 1–4 only');
});
test('LAB-25 projection diff reports object keys only, never bodies', () => {
  const p = { tables: [{ name: 'T', columns: [{ name: 'a' }] }], enums: [], types: [], constraints: [{ table: 'T', name: 'c1', definition: 'CHECK (secret)' }], indexes: [], functions: [], triggers: [] };
  const q = JSON.parse(JSON.stringify(p)); q.constraints[0].definition = 'CHECK (other)';
  assert.deepEqual(OPS.diffProjections(p, q), ['constraint:T.c1']);
});
