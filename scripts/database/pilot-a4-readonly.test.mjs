// Hermetic tests for pilot-a4-readonly.mjs. Fakes and temporary fixtures only: no real
// credentials, no ~/.config, no .env, no socket. Run under a no-network namespace.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as realFs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as T from './pilot-a4-readonly.mjs';
import * as marker from './pilot-marker.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL_URL = pathToFileURL(path.join(HERE, 'pilot-a4-readonly.mjs')).href;
const REAL_ROOT = path.resolve(HERE, '..', '..');

// Every socket attempt in this process is counted (Y28).
let netAttempts = 0;
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function counted(...args) { netAttempts += 1; return originalConnect.apply(this, args); };

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const refDigest = (ref) => sha256(`mona-pilot-project-ref\n${ref}`);

// Synthetic identities (never the real project refs: the repository is public).
const REF = 'aaaabbbbccccddddeeee';
const FORBIDDEN = ['ffffgggghhhhiiiijjjj', 'kkkkllllmmmmnnnnoooo', 'ppppqqqqrrrrsssstttt'];
const UNKNOWN_REF = 'uuuuvvvvwwwwxxxxyyyy';
const PASSWORD = 'S3cretPw';
const POOLER = 'aws-0-sa-east-1.pooler.supabase.com';
const MID = '11111111-1111-4111-8111-111111111111';
const OTHER_MID = '22222222-2222-4222-8222-222222222222';
const urlFor = ({ user = `postgres.${REF}`, host = POOLER, port = 5432, db = 'postgres', extra = '' } = {}) =>
  `postgresql://${user}:${PASSWORD}@${host}:${port}/${db}${extra}`;
const SECRETS = [PASSWORD, POOLER, `postgres.${REF}`, REF, MID, OTHER_MID];

const PACKAGES = [
  ['pg', '8.23.0'], ['pg-connection-string', '2.14.0'], ['pg-pool', '3.14.0'], ['pg-protocol', '1.16.0'],
  ['pg-types', '2.2.0'], ['pgpass', '1.0.5'], ['split2', '4.2.0'], ['pg-int8', '1.0.1'], ['postgres-array', '2.0.0'],
  ['postgres-bytea', '1.0.1'], ['postgres-date', '1.0.7'], ['postgres-interval', '1.2.0'], ['pg-cloudflare', '1.4.0'], ['xtend', '4.0.2'],
];
const MIGRATIONS = [
  '20260907015311_init', '20260912182432_add_company_location', '20260912191702_add_user_role_scope',
  '20260922210000_d3_initial_stock_and_global_audit', '20261002120000_block1_pricing_wholesale',
  '20261006120000_pilot_pricing_v2', '20261012120000_cash_session_reconciliation',
];
const TABLES = ['Company', 'CompanyPricingConfig', 'Location', 'Branch', 'User', 'Role', 'Permission', 'RolePermission',
  'UserRoleScope', 'UserBranchRole', 'CashRegister', 'SaleNumberCounter', 'Category', 'Brand', 'Product', 'ProductVariant',
  'Inventory', 'StockMovement', 'StockReservation', 'Sale', 'SaleItem', 'SalePayment', 'CashSession', 'CashMovement', 'AuditLog'];
const PROBES = [['Sale', 'pricingMode'], ['Sale', 'paymentStartedAt'], ['Sale', 'wholesaleConfirmedById'], ['ProductVariant', 'wholesalePrice'],
  ['ProductVariant', 'cashPrice'], ['Sale', 'priceMode'], ['SaleItem', 'priceMode'], ['SaleItem', 'baseUnitPrice'], ['CompanyPricingConfig', 'listAdjustmentBps'],
  ['CashSession', 'expectedCash'], ['CashSession', 'countedCash'], ['CashSession', 'difference']];

// Canonical column-type contract rows (literal, hand-derived from api/prisma/schema.prisma
// and Prisma's _prisma_migrations DDL): [table, column, type schema, type name, typtype].
// Collatable (text/varchar) columns carry the pg_catalog "default" collation; others none.
const COLLATABLE = new Set(['varchar', 'text']);
const TYPE_ROWS = [
  ['_prisma_migrations', 'migration_name', 'pg_catalog', 'varchar', 'b'], ['_prisma_migrations', 'checksum', 'pg_catalog', 'varchar', 'b'],
  ['_prisma_migrations', 'finished_at', 'pg_catalog', 'timestamptz', 'b'], ['_prisma_migrations', 'rolled_back_at', 'pg_catalog', 'timestamptz', 'b'],
  ['_prisma_migrations', 'started_at', 'pg_catalog', 'timestamptz', 'b'], ['_prisma_migrations', 'applied_steps_count', 'pg_catalog', 'int4', 'b'],
  ['Location', 'code', 'pg_catalog', 'text', 'b'], ['Location', 'type', 'public', 'LocationType', 'e'], ['Location', 'isActive', 'pg_catalog', 'bool', 'b'],
  ['Company', 'cuit', 'pg_catalog', 'text', 'b'], ['Sale', 'status', 'public', 'SaleStatus', 'e'],
  ['CashSession', 'status', 'public', 'CashSessionStatus', 'e'], ['User', 'isActive', 'pg_catalog', 'bool', 'b'],
];

// ---------- fixture builders ----------
const tmpRoots = [];
function mkTmp() { const d = realFs.mkdtempSync(path.join(os.tmpdir(), 'a4ro-')); tmpRoots.push(d); return d; }
function put(file, data, mode = 0o644) { realFs.mkdirSync(path.dirname(file), { recursive: true }); realFs.writeFileSync(file, data); realFs.chmodSync(file, mode); }

function buildRoot({ manifestMutator, lockMutator, after } = {}) {
  const root = mkTmp();
  const repoFiles = ['scripts/database/pilot-marker.mjs', 'scripts/database/lib.mjs', 'scripts/certs/supabase-prod-ca-2021.crt',
    ...MIGRATIONS.map((m) => `api/prisma/migrations/${m}/migration.sql`)];
  for (const f of repoFiles) put(path.join(root, f), `fixture ${f}\n`);
  const packages = [];
  const lock = { lockfileVersion: 3, packages: { '': { name: 'fixture' } } };
  for (const [name, version] of PACKAGES) {
    const files = [`node_modules/${name}/package.json`, `node_modules/${name}/index.js`];
    if (name === 'pg') files.push('node_modules/pg/esm/index.mjs', 'node_modules/pg/lib/client.js');
    for (const f of files) put(path.join(root, f), `fixture ${f}\n`);
    const integrity = `sha512-${Buffer.from(sha256(name) + sha256(version)).toString('base64').slice(0, 86)}==`;
    lock.packages[`node_modules/${name}`] = { version, integrity };
    packages.push({ name, version, integrity, files: files.sort().map((f) => ({ path: f, sha256: sha256(realFs.readFileSync(path.join(root, f))) })) });
  }
  lockMutator?.(lock);
  put(path.join(root, 'package-lock.json'), JSON.stringify(lock));
  const manifest = {
    format: 'mona-pilot-a4-manifest/v1', node: 'v24.20.0',
    repoFiles: repoFiles.map((f) => ({ path: f, sha256: sha256(realFs.readFileSync(path.join(root, f))) })),
    packages,
  };
  manifestMutator?.(manifest);
  put(path.join(root, 'scripts/database/pilot-a4-readonly.manifest.json'), JSON.stringify(manifest));
  after?.(root);
  return root;
}

function buildHome({ url = urlFor(), markerId = `${MID}\n`, after } = {}) {
  const home = mkTmp();
  const cfg = path.join(home, '.config');
  const dir = path.join(cfg, 'mona-jacinta');
  realFs.mkdirSync(dir, { recursive: true });
  realFs.chmodSync(cfg, 0o700); realFs.chmodSync(dir, 0o700);
  put(path.join(dir, 'pilot-database-url'), url, 0o600);
  put(path.join(dir, 'pilot-marker-id'), markerId, 0o600);
  after?.({ home, cfg, dir });
  return home;
}

function canonicalFacts() {
  return {
    schemaOwnerIsCurrentUser: true,
    table: { kind: 'r', persistence: 'p', isPartition: false, ofType: false, ownerIsCurrentUser: true, rowSecurity: false, forceRowSecurity: false, hasSubclass: false, parents: 0, children: 0, hasRules: false, triggers: 0 },
    columns: [
      { name: 'singleton', type: 'boolean', notNull: true, default: 'true', generated: '', identity: '', collation: null },
      { name: 'environment', type: 'text', notNull: true, default: null, generated: '', identity: '', collation: 'default' },
      { name: 'marker_id', type: 'uuid', notNull: true, default: null, generated: '', identity: '', collation: null },
      { name: 'installed_at', type: 'timestamp with time zone', notNull: true, default: 'now()', generated: '', identity: '', collation: null },
    ],
    constraints: [{ type: 'c', definition: "CHECK ((environment = 'pilot'::text))" }, { type: 'c', definition: 'CHECK (singleton)' }, { type: 'p', definition: 'PRIMARY KEY (singleton)' }],
    relations: [{ name: 'database_identity', kind: 'r' }, { name: 'database_identity_pkey', kind: 'i' }],
  };
}

// Statement classification by SQL shape (independent of the tool's constants).
function classify(sql) {
  if (sql === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY') return 'begin';
  if (/^SET LOCAL /.test(sql)) return 'set';
  if (/transaction_read_only/.test(sql)) return 'ro';
  if (/to_regnamespace\('mona_test_guard'\)/.test(sql)) return 'guards';
  if (sql === 'LOCK TABLE mona_pilot_guard.database_identity IN ACCESS SHARE MODE') return 'lock';
  if (/AS facts/.test(sql)) return 'facts';
  if (/AS heap_am/.test(sql) && /database_identity/.test(sql)) return 'markerAccess';
  if (/FROM mona_pilot_guard\.database_identity/.test(sql)) return 'markerRows';
  if (/relrowsecurity/.test(sql) && /AS owned/.test(sql)) return 'relations';
  if (/pg_type/.test(sql) && /AS type_kind/.test(sql)) return 'columnTypes';
  if (sql === 'SELECT count(*)::text AS n FROM ONLY public._prisma_migrations') return 'countLedger';
  if (/FROM (ONLY )?public\._prisma_migrations/.test(sql)) return 'ledger';
  if (/pg_attribute/.test(sql) && /AS present/.test(sql)) return 'columns';
  if (/pg_trigger/.test(sql)) return 'triggers';
  const c = /^SELECT count\(\*\)::text AS n FROM (?:ONLY )?public\."([A-Za-z]+)"$/.exec(sql);
  if (c) return `count:${c[1]}`;
  if (/FROM (ONLY )?public\."Location"/.test(sql)) return 'locations';
  if (/FROM (ONLY )?public\."Company"/.test(sql)) return 'company';
  if (/FROM (ONLY )?public\."Sale"( |$)/.test(sql)) return 'salesByStatus';
  if (/FROM (ONLY )?public\."CashSession"( |$)/.test(sql)) return 'cashByStatus';
  if (/FROM (ONLY )?public\."User"( |$)/.test(sql)) return 'users';
  if (sql === 'ROLLBACK') return 'rollback';
  return 'UNKNOWN';
}

function fakeClient(root, o = {}) {
  const log = [];
  const state = { destroyed: false, ended: false };
  const migrationSha = (m) => sha256(realFs.readFileSync(path.join(root, `api/prisma/migrations/${m}/migration.sql`)));
  const ledgerRows = () => o.ledger ?? MIGRATIONS.map((m) => ({ migration_name: m, checksum: o.badChecksum === m ? 'deadbeef' : migrationSha(m), finished: true, rolled_back: o.rolledBack === m, applied_steps_count: 1 }));
  const responses = {
    ro: () => [{ ro: o.ro ?? 'on' }],
    guards: () => o.guards ?? [{ test_guard: !!o.testGuard, pilot_schema: o.pilotSchema ?? true, pilot_table: o.pilotTable ?? true }],
    facts: () => [{ facts: o.facts ?? canonicalFacts() }],
    markerRows: () => o.markerRows ?? [{ environment: o.environment ?? 'pilot', marker_id: o.markerId ?? MID, has_installed_at: true }],
    columnTypes: () => TYPE_ROWS.map(([t, c, schema, name, kind]) => {
      const k = `${t}.${c}`;
      if (o.types && k in o.types) return { table_name: t, column_name: c, ...(o.types[k] ?? { type_schema: null, type_name: null, type_kind: null }) };
      return { table_name: t, column_name: c, type_schema: schema, type_name: name, type_kind: kind,
        coll_schema: COLLATABLE.has(name) ? 'pg_catalog' : null, coll_name: COLLATABLE.has(name) ? 'default' : null, out_builtin: true };
    }),
    relations: () => [...TABLES, '_prisma_migrations'].map((name) => ({ name, kind: o.kinds?.[name] ?? 'r', rls: o.rls?.[name] ?? false, force_rls: false, rules: o.rules?.[name] ?? false, owned: o.owned?.[name] ?? true,
      heap_am: o.heapAm?.[name] ?? true, indexes_builtin: o.indexesBuiltin?.[name] ?? true, has_subclass: o.hasSubclass?.[name] ?? false, is_partition: o.isPartition?.[name] ?? false })),
    markerAccess: () => [{ heap_am: o.markerHeap ?? true, indexes_builtin: o.markerIndexes ?? true }],
    ledger: () => ledgerRows(),
    countLedger: () => [{ n: 'ledgerCount' in o ? o.ledgerCount : String(ledgerRows().length) }],
    columns: () => PROBES.map(([t, c]) => ({ table_name: t, column_name: c, present: true })),
    triggers: () => [{ n: '4' }],
    locations: () => o.locations ?? [{ code: 'PCEN', type: 'RETAIL_BRANCH', active: true }, { code: 'PDEP', type: 'CENTRAL_WAREHOUSE', active: true }],
    // Old aggregated shapes (R2 statements) and new raw shapes (R3 statements) are both served.
    company: (sql) => (/PILOT-NO-FISCAL/.test(sql) ? [{ sentinel: '1', total: '1' }] : (o.companyRows ?? [{ cuit: 'PILOT-NO-FISCAL' }])),
    salesByStatus: (sql) => (/GROUP BY/.test(sql) ? [{ s: 'COMPLETED', n: '3' }] : (o.saleRows ?? [{ status: 'COMPLETED' }, { status: 'COMPLETED' }, { status: 'COMPLETED' }])),
    cashByStatus: (sql) => (/GROUP BY/.test(sql) ? [{ s: 'CLOSED', n: '1' }] : (o.cashRows ?? [{ status: 'CLOSED' }])),
    users: (sql) => (/FILTER/.test(sql) ? [{ active: '5', inactive: '1' }] : (o.userRows ?? [true, true, true, true, true, false].map((active) => ({ active })))),
  };
  const client = {
    log, state,
    connection: { stream: { encrypted: o.tls !== false, authorized: o.tls !== false, destroy() { state.destroyed = true; } } },
    async connect() { if (o.connectError) throw o.connectError; },
    async end() { state.ended = true; if (o.endHangs) await new Promise(() => {}); },
    async query(sql) {
      const text = typeof sql === 'string' ? sql : sql?.text;
      log.push(text);
      const kind = classify(text);
      if (kind === 'rollback' && o.rollbackFails) throw Object.assign(new Error('rollback failed'), { code: 'XX000' });
      if (kind === 'lock' && o.lockError) throw Object.assign(new Error('lock'), { code: o.lockError });
      if (kind.startsWith('count:')) return { rows: [{ n: o.countValue?.[kind.slice(6)] ?? (kind === 'count:Sale' ? '3' : kind === 'count:CashSession' ? '1' : kind === 'count:User' ? '6' : '7') }] };
      return { rows: responses[kind]?.(text) ?? [] };
    },
  };
  return client;
}

function recordingFs(paths) {
  const wrap = (name) => (p, ...rest) => { if (typeof p === 'string') paths.push(p); return realFs[name](p, ...rest); };
  return { lstatSync: wrap('lstatSync'), openSync: wrap('openSync'), readdirSync: wrap('readdirSync'), fstatSync: realFs.fstatSync, readFileSync: (p, ...r) => { if (typeof p === 'string') paths.push(p); return realFs.readFileSync(p, ...r); }, closeSync: realFs.closeSync, constants: realFs.constants };
}

async function run({ root = buildRoot(), home = buildHome(), env, execArgv = [], version = 'v24.20.0', fake = {}, argv = ['--target=pilot', '--read-only-state'], resolvePg, endTimeoutMs = 50, fsWrap } = {}) {
  const out = [];
  const fsPaths = [];
  let imports = 0;
  let clients = 0;
  let client;
  const deps = {
    env: env ?? { HOME: home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    homedir: home, uid: process.getuid(), execArgv, version, root,
    fs: fsWrap ? fsWrap(recordingFs(fsPaths)) : recordingFs(fsPaths),
    resolvePg: resolvePg ?? (() => path.join(root, 'node_modules/pg/esm/index.mjs')),
    importMarker: async () => { imports += 1; return marker; },
    createClient: () => { clients += 1; client = fakeClient(root, fake); return client; },
    refDigests: { pilot: refDigest(REF), forbidden: FORBIDDEN.map(refDigest) },
    log: (l) => out.push(String(l)), error: (l) => out.push(String(l)), endTimeoutMs,
  };
  const rc = await T.main(argv, deps);
  return { rc, out, text: out.join('\n'), imports, clients, client, log: client?.log ?? [], kinds: (client?.log ?? []).map(classify), fsPaths, root, home };
}
const OPERATIONAL = (k) => k === 'markerRows' || k === 'relations' || k === 'columnTypes' || k === 'countLedger' || k === 'ledger' || k === 'columns' || k === 'triggers' || k.startsWith('count:') || ['locations', 'company', 'salesByStatus', 'cashByStatus', 'users'].includes(k);
const leaks = (text) => SECRETS.filter((s) => text.includes(s));
const lastLine = (r) => r.out.at(-1);

// ---------- Y01 import side effects (child process, module-load hooks) ----------
test('Y01 importing the tool and refusing on env loads no pg/pilot-marker/lib and opens no socket', () => {
  const code = `
    import { registerHooks } from 'node:module';
    import net from 'node:net';
    const seen = [];
    registerHooks({ resolve(spec, ctx, next) { seen.push(spec); return next(spec, ctx); } });
    let n = 0; const o = net.Socket.prototype.connect; net.Socket.prototype.connect = function (...a) { n += 1; return o.apply(this, a); };
    const T = await import(${JSON.stringify(TOOL_URL)});
    const out = [];
    const rc = await T.main(['--target=pilot', '--read-only-state'], { env: { HOME: '/nonexistent-home', PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', NODE_OPTIONS: '--import=x' }, homedir: '/nonexistent-home', execArgv: [], version: 'v24.20.0', root: '/nonexistent-root', log: (l) => out.push(l), error: (l) => out.push(l) });
    console.log(JSON.stringify({ rc, seen, n }));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
  assert.equal(r.status, 0, r.stderr);
  const { rc, seen, n } = JSON.parse(r.stdout.trim().split('\n').at(-1));
  assert.equal(rc, 3);
  assert.equal(n, 0);
  const nonBuiltin = seen.filter((s) => !s.startsWith('node:') && s !== TOOL_URL);
  assert.deepEqual(nonBuiltin, [], `unexpected module resolutions: ${nonBuiltin.join(', ')}`);
});

// ---------- Y02–Y07, Z16 environment / runtime ----------
for (const [id, envPatch] of [
  ['Y02 NODE_OPTIONS', { NODE_OPTIONS: '--require=/tmp/x.js' }],
  ['Y03 PGOPTIONS', { PGOPTIONS: '-c default_transaction_read_only=off' }],
  ['Y03 PGREPLICATION', { PGREPLICATION: 'database' }],
  ['Y03 PGSSLMODE', { PGSSLMODE: 'disable' }],
  ['Y03 PGAPPNAME', { PGAPPNAME: 'x' }],
  ['Y03 PGSSLNEGOTIATION', { PGSSLNEGOTIATION: 'direct' }],
  ['Y03 PGCLIENTENCODING', { PGCLIENTENCODING: 'LATIN1' }],
  ['Y03 NODE_PG_FORCE_NATIVE', { NODE_PG_FORCE_NATIVE: '1' }],
  ['Y05 DATABASE_URL', { DATABASE_URL: 'postgresql://dev' }],
  ['Y05 TEST_DATABASE_URL', { TEST_DATABASE_URL: 'postgresql://test' }],
  ['Y05 LD_PRELOAD', { LD_PRELOAD: '/tmp/x.so' }],
  ['Y05 NODE_PATH', { NODE_PATH: '/tmp' }],
  ['Z16 LANG differs', { LANG: 'en_US.UTF-8' }],
  ['Z16 PATH differs', { PATH: '/tmp:/usr/bin:/bin' }],
]) {
  test(`${id} → refused at env before any import or client`, async () => {
    const home = buildHome();
    const r = await run({ home, env: { HOME: home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', ...envPatch } });
    assert.equal(r.rc, 3);
    assert.match(r.text, /phase=env/);
    assert.equal(r.imports, 0);
    assert.equal(r.clients, 0);
    assert.equal(lastLine(r), 'A4_RESULT=REFUSED');
  });
}
test('Y04 HOME differs from the passwd home → refused at env', async () => {
  const r = await run({ env: { HOME: '/tmp/other-home', PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } });
  assert.equal(r.rc, 3); assert.match(r.text, /phase=env/); assert.equal(r.imports, 0);
});
test('Y06 non-empty execArgv (--import/--require) → refused at runtime', async () => {
  const r = await run({ execArgv: ['--import=/tmp/x.mjs'] });
  assert.equal(r.rc, 3); assert.match(r.text, /phase=runtime/); assert.equal(r.imports, 0);
});
test('Y07 wrong Node version → refused at runtime', async () => {
  const r = await run({ version: 'v20.19.2' });
  assert.equal(r.rc, 3); assert.match(r.text, /phase=runtime/); assert.equal(r.imports, 0);
});

// ---------- Y08, Y09, Z03–Z07 integrity ----------
const integrityCases = [
  ['Y08 one byte changed in a pinned package file', { after: (root) => realFs.appendFileSync(path.join(root, 'node_modules/pg/lib/client.js'), 'x') }],
  ['Y08 pinned repo file changed (pilot-marker.mjs)', { after: (root) => realFs.appendFileSync(path.join(root, 'scripts/database/pilot-marker.mjs'), '//') }],
  ['Y08 CA file changed', { after: (root) => realFs.appendFileSync(path.join(root, 'scripts/certs/supabase-prod-ca-2021.crt'), 'x') }],
  ['Y09 listed file missing', { after: (root) => realFs.rmSync(path.join(root, 'node_modules/pg/lib/client.js')) }],
  ['Y09 unlisted extra file in a pinned package', { after: (root) => put(path.join(root, 'node_modules/pg/lib/evil.js'), 'x') }],
  ['Y09 symlink inside a pinned package', { after: (root) => realFs.symlinkSync('/etc/hostname', path.join(root, 'node_modules/pg/lib/link.js')) }],
  ['Y09 package missing from the manifest', { manifestMutator: (m) => { m.packages = m.packages.filter((p) => p.name !== 'pgpass'); } }],
  ['Z03 absolute path in manifest', { manifestMutator: (m) => { m.repoFiles[0].path = '/etc/passwd'; } }],
  ['Z03 traversal path in manifest', { manifestMutator: (m) => { m.repoFiles[0].path = 'scripts/../../etc/passwd'; } }],
  ['Z04 manifest is a symlink', { after: (root) => { const p = path.join(root, 'scripts/database/pilot-a4-readonly.manifest.json'); realFs.renameSync(p, `${p}.real`); realFs.symlinkSync(`${p}.real`, p); } }],
  ['Z06 lockfile version differs', { lockMutator: (l) => { l.packages['node_modules/pg'].version = '8.24.0'; } }],
  ['Z06 lockfile integrity differs', { lockMutator: (l) => { l.packages['node_modules/pg-protocol'].integrity = 'sha512-AAAA'; } }],
  ['Z07 native addon in a pinned package', { after: (root) => put(path.join(root, 'node_modules/pg/lib/native.node'), 'x') }],
  ['manifest node version differs', { manifestMutator: (m) => { m.node = 'v20.0.0'; } }],
  ['manifest wrong format', { manifestMutator: (m) => { m.format = 'other'; } }],
  ['manifest lacks a migration file', { manifestMutator: (m) => { m.repoFiles = m.repoFiles.filter((f) => !f.path.includes('cash_session')); } }],
];
for (const [id, opts] of integrityCases) {
  test(`${id} → refused at integrity, pilot-marker never imported`, async () => {
    const r = await run({ root: buildRoot(opts) });
    assert.equal(r.rc, 3);
    assert.match(r.text, /phase=integrity/);
    assert.equal(r.imports, 0);
    assert.equal(r.clients, 0);
  });
}
test('Z05 pg resolves to a shadow copy → refused at integrity', async () => {
  const r = await run({ resolvePg: () => '/tmp/shadow/node_modules/pg/esm/index.mjs' });
  assert.equal(r.rc, 3); assert.match(r.text, /phase=integrity/); assert.equal(r.imports, 0);
});

// ---------- Y10, Z08 config ----------
const configCases = [
  ['Y10 ~/.config is a symlink', { after: ({ home, cfg }) => { realFs.renameSync(cfg, `${cfg}-real`); realFs.symlinkSync(`${cfg}-real`, cfg); } }],
  ['Y10 mona-jacinta dir group-accessible', { after: ({ dir }) => realFs.chmodSync(dir, 0o750) }],
  ['Y10 ~/.config group-writable', { after: ({ cfg }) => realFs.chmodSync(cfg, 0o770) }],
  ['Y10 URL file mode 0644', { after: ({ dir }) => realFs.chmodSync(path.join(dir, 'pilot-database-url'), 0o644) }],
  ['Y10 URL file is a symlink', { after: ({ dir }) => { const p = path.join(dir, 'pilot-database-url'); realFs.renameSync(p, `${p}.r`); realFs.symlinkSync(`${p}.r`, p); } }],
  ['Y10 URL file missing', { after: ({ dir }) => realFs.rmSync(path.join(dir, 'pilot-database-url')) }],
  ['Z08 marker id not a UUIDv4', { markerId: 'not-a-uuid\n' }],
  ['Z08 marker id two lines', { markerId: `${MID}\n${OTHER_MID}\n` }],
  ['Z08 marker id file 0644', { after: ({ dir }) => realFs.chmodSync(path.join(dir, 'pilot-marker-id'), 0o644) }],
  ['Z08 marker id file symlink', { after: ({ dir }) => { const p = path.join(dir, 'pilot-marker-id'); realFs.renameSync(p, `${p}.r`); realFs.symlinkSync(`${p}.r`, p); } }],
];
for (const [id, opts] of configCases) {
  test(`${id} → refused at config, no client`, async () => {
    const r = await run({ home: buildHome(opts) });
    assert.equal(r.rc, 3); assert.match(r.text, /phase=config/); assert.equal(r.clients, 0);
    assert.deepEqual(leaks(r.text), []);
  });
}

// ---------- Y11–Y15, Z09 target ----------
const targetCases = [
  ['Y11 host outside contract', urlFor({ host: 'evil.example.com' })],
  ['Y12 unknown (DEV-like) project ref on the pooler', urlFor({ user: `postgres.${UNKNOWN_REF}` })],
  ['Y14 direct host ref differs from user ref', urlFor({ user: `postgres.${REF}`, host: `db.${UNKNOWN_REF}.supabase.co` })],
  ['Y15 port 6543', urlFor({ port: 6543 })],
  ['Y15 database not postgres', urlFor({ db: 'other' })],
  ['Y15 query string', urlFor({ extra: '?sslmode=disable' })],
  ['Y15 IP literal host', urlFor({ host: '10.0.0.1' })],
  ['Z09 direct host with pooler-style user', urlFor({ user: `postgres.${REF}`, host: `db.${REF}.supabase.co` })],
];
for (const [id, url] of targetCases) {
  test(`${id} → refused before any client`, async () => {
    const r = await run({ home: buildHome({ url }) });
    assert.equal(r.rc, 3); assert.match(r.text, /phase=(target|config)/); assert.equal(r.clients, 0);
    assert.deepEqual(leaks(r.text), []);
  });
}
for (const [i, ref] of FORBIDDEN.entries()) {
  test(`Y13 forbidden ref #${i + 1} → FORBIDDEN before any client`, async () => {
    const r = await run({ home: buildHome({ url: urlFor({ user: `postgres.${ref}` }) }) });
    assert.equal(r.rc, 3); assert.match(r.text, /FORBIDDEN/); assert.equal(r.clients, 0);
    assert.ok(!r.text.includes(ref));
  });
}
test('direct host with matching ref and user postgres is inside the contract (reaches the client)', async () => {
  const r = await run({ home: buildHome({ url: urlFor({ user: 'postgres', host: `db.${REF}.supabase.co` }) }) });
  assert.equal(r.clients, 1); assert.equal(r.rc, 0);
});

// ---------- Y16–Y19, Z11, Z12 identity ----------
test('Y16 TLS not verified → refused, zero queries', async () => {
  const r = await run({ fake: { tls: false } });
  assert.equal(r.rc, 4); assert.deepEqual(r.log, []); assert.equal(lastLine(r), 'A4_RESULT=REFUSED');
});
test('Y17 marker relation is a VIEW → refused at structure, row never read, no operational query', async () => {
  const facts = canonicalFacts(); facts.table.kind = 'v';
  const r = await run({ fake: { facts } });
  assert.equal(r.rc, 2); assert.ok(!r.kinds.includes('markerRows')); assert.ok(!r.kinds.some(OPERATIONAL));
  assert.ok(r.kinds.includes('rollback'));
});
test('Y18 two marker rows → refused, no operational query', async () => {
  const row = { environment: 'pilot', marker_id: MID, has_installed_at: true };
  const r = await run({ fake: { markerRows: [row, { ...row }] } });
  assert.equal(r.rc, 2); assert.ok(!r.kinds.some((k) => OPERATIONAL(k) && k !== 'markerRows'));
});
for (const [id, fake] of [
  ['Y19 environment test', { environment: 'test' }],
  ['Y19 wrong marker id', { markerId: OTHER_MID }],
  ['Y19 TEST guard present', { testGuard: true }],
  ['Y19 partial structure (no table)', { pilotTable: false }],
  ['Y19 marker absent at LOCK (42P01)', { lockError: '42P01' }],
  ['Z11 guards query returns no row', { guards: [] }],
  ['Z12 transaction not read-only', { ro: 'off' }],
]) {
  test(`${id} → refused, no operational query, ROLLBACK issued`, async () => {
    const r = await run({ fake });
    assert.equal(r.rc, 2);
    assert.ok(!r.kinds.some((k) => OPERATIONAL(k) && k !== 'markerRows'));
    assert.ok(r.kinds.includes('rollback'));
    assert.equal(lastLine(r), 'A4_RESULT=REFUSED');
  });
}
test('Z12 read-only off → refused before LOCK', async () => {
  const r = await run({ fake: { ro: 'off' } });
  assert.equal(r.rc, 2);
  assert.ok(r.kinds.includes('ro'), 'the read-only check must have run');
  assert.ok(!r.kinds.includes('lock'));
});
test('Z15 wrong marker id → neither id appears in the output', async () => {
  const r = await run({ fake: { markerId: OTHER_MID } });
  assert.equal(r.rc, 2);
  assert.ok(r.kinds.includes('markerRows'), 'the marker row must have been compared');
  assert.ok(!r.text.includes(MID)); assert.ok(!r.text.includes(OTHER_MID));
});

// ---------- Y20–Y22, Y29, Z10, Z13 state ----------
test('Y20 operational relation that is a view / has RLS / rules / foreign owner is never selected', async () => {
  const r = await run({ fake: { kinds: { Sale: 'v' }, rls: { Product: true }, rules: { Inventory: true }, owned: { AuditLog: false } } });
  assert.equal(r.rc, 0);
  for (const t of ['Sale', 'Product', 'Inventory', 'AuditLog']) assert.ok(!r.kinds.includes(`count:${t}`), t);
  assert.ok(!r.kinds.includes('salesByStatus'));
  assert.match(r.text, /UNVERIFIED_RELATION/);
  assert.match(r.text, /A4_STATE=PARTIAL/);
});
test('Y20 unverified _prisma_migrations → ledger never read', async () => {
  const r = await run({ fake: { kinds: { _prisma_migrations: 'v' } } });
  assert.ok(!r.kinds.includes('ledger')); assert.match(r.text, /A4_STATE=PARTIAL/);
});
test('Y21 unknown ledger name with control characters is printed as UNKNOWN(digest), no control byte', async () => {
  const r = await run({ fake: { ledger: [{ migration_name: '\u001b[2Jevil', checksum: 'x', finished: true, rolled_back: false, applied_steps_count: 1 }] } });
  assert.match(r.text, /UNKNOWN\([0-9a-f]{12}\)/);
  assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f]/.test(r.text));
  assert.ok(!r.text.includes('evil'));
});
test('Y22 location code / type outside the allowlist are never printed raw', async () => {
  const r = await run({ fake: { locations: [{ code: 'PCEN; DROP TABLE x', type: 'EVIL_TYPE', active: true }] } });
  assert.ok(!r.text.includes('DROP')); assert.ok(!r.text.includes('EVIL_TYPE'));
  assert.match(r.text, /A4_STATE=PARTIAL/);
});
test('Y29 ledger checksum ≠ repo → identity VERIFIED, MIGRATION_DRIFT, PARTIAL', async () => {
  const r = await run({ fake: { badChecksum: '20261006120000_pilot_pricing_v2' } });
  assert.equal(r.rc, 0);
  assert.match(r.text, /20261006120000_pilot_pricing_v2: .*checksum_matches_repo=false/);
  assert.match(r.text, /MIGRATION_DRIFT/); assert.match(r.text, /A4_STATE=PARTIAL/);
  assert.match(r.text, /A4_IDENTITY=VERIFIED/);
});
test('Z10 rolled-back pending migration → MIGRATION_INCOMPLETE, PARTIAL', async () => {
  const r = await run({ fake: { rolledBack: '20261012120000_cash_session_reconciliation' } });
  assert.equal(r.rc, 0); assert.match(r.text, /MIGRATION_INCOMPLETE/); assert.match(r.text, /A4_STATE=PARTIAL/);
});
test('ledger missing the three pending migrations → NOT RECORDED, PARTIAL (expected real PILOT shape)', async () => {
  const root = buildRoot();
  const fourOnly = MIGRATIONS.slice(0, 4).map((m) => ({ migration_name: m, checksum: sha256(realFs.readFileSync(path.join(root, `api/prisma/migrations/${m}/migration.sql`))), finished: true, rolled_back: false, applied_steps_count: 1 }));
  const r = await run({ root, fake: { ledger: fourOnly } });
  assert.equal(r.rc, 0);
  for (const m of MIGRATIONS.slice(4)) assert.match(r.text, new RegExp(`${m}: NOT_RECORDED`));
  assert.match(r.text, /A4_STATE=PARTIAL/);
});
test('Z13 non-numeric count → INVALID, PARTIAL', async () => {
  const r = await run({ fake: { countValue: { Product: 'abc' } } });
  assert.match(r.text, /count Product: INVALID/); assert.match(r.text, /A4_STATE=PARTIAL/);
});

// ---------- Y23 statement gate ----------
test('Y23 every statement is a frozen, single, read-only statement', () => {
  const entries = Object.entries(T.STATEMENTS);
  assert.ok(Object.isFrozen(T.STATEMENTS));
  assert.ok(entries.length >= 20, `only ${entries.length} statements`);
  const allowedStart = /^(BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY$|SET LOCAL |LOCK TABLE mona_pilot_guard\.database_identity IN ACCESS SHARE MODE$|SELECT |ROLLBACK$)/;
  const forbidden = /;|\b(INSERT|UPDATE|DELETE|MERGE|CREATE|DROP|ALTER|TRUNCATE|GRANT|REVOKE|COMMIT|COPY|CALL|DO|FOR UPDATE|FOR SHARE|FOR NO KEY|FOR KEY SHARE)\b|nextval|setval|set_config|pg_advisory|dblink|pg_sleep|lo_|pg_read|pg_ls|pg_stat_file|pg_terminate|pg_cancel/i;
  for (const [id, sql] of entries) {
    assert.equal(typeof sql, 'string', id);
    assert.match(sql, allowedStart, id);
    if (id !== 'BEGIN' && id !== 'ROLLBACK' && !sql.startsWith('SET LOCAL ') && !sql.startsWith('LOCK TABLE ')) assert.doesNotMatch(sql, forbidden, id);
  }
});
test('Y23 a full run only issues statements from the frozen map', async () => {
  const r = await run();
  const allowed = new Set(Object.values(T.STATEMENTS));
  assert.ok(r.log.length > 0);
  for (const s of r.log) assert.ok(allowed.has(s), `statement outside the frozen map: ${s.slice(0, 60)}`);
});
test('Z01 an extra argument (--sql=...) is refused before anything else', async () => {
  const r = await run({ argv: ['--target=pilot', '--read-only-state', '--sql=SELECT 1'] });
  assert.equal(r.rc, 1); assert.match(r.text, /phase=args/); assert.equal(r.imports, 0); assert.equal(r.clients, 0);
});
for (const argv of [['--target=pilot', '--target=pilot', '--read-only-state'], ['--target=pilot'], ['--target=test', '--read-only-state'], []]) {
  test(`Z02 bad argv ${JSON.stringify(argv)} → refused`, async () => {
    const r = await run({ argv }); assert.equal(r.rc, 1); assert.match(r.text, /phase=args/); assert.equal(r.clients, 0);
  });
}

// ---------- Y24–Y26, Z14 cleanup and secrets ----------
test('Y24 ROLLBACK fails → exit 5, socket destroyed, never VERIFIED', async () => {
  const r = await run({ fake: { rollbackFails: true } });
  assert.equal(r.rc, 5); assert.ok(r.client, 'a client must have been created'); assert.equal(r.client.state.destroyed, true);
  assert.equal(lastLine(r), 'A4_RESULT=ERROR'); assert.doesNotMatch(r.text, /A4_RESULT=VERIFIED/);
});
test('Y25 end() never resolves → bounded, socket destroyed', async () => {
  const started = Date.now();
  const r = await run({ fake: { endHangs: true }, endTimeoutMs: 30 });
  assert.ok(Date.now() - started < 2000);
  assert.ok(r.client, 'a client must have been created');
  assert.equal(r.client.state.destroyed, true);
});
test('Y26 connect error embedding URL parts → only a code, no secret', async () => {
  const err = Object.assign(new Error(`connect failed ${urlFor()}`), { code: 'ECONNREFUSED' });
  const r = await run({ fake: { connectError: err } });
  assert.equal(r.rc, 4); assert.match(r.text, /code=ECONNREFUSED/); assert.deepEqual(leaks(r.text), []);
});
test('Z14 error code contained in the password → code=unexpected', async () => {
  const err = Object.assign(new Error('x'), { code: 'S3CRET' });
  const home = buildHome({ url: urlFor().replace(PASSWORD, 'aS3CRETb') });
  const r = await run({ home, fake: { connectError: err } });
  assert.match(r.text, /code=unexpected/); assert.ok(!r.text.includes('S3CRET'));
});

// ---------- Y27 happy path ----------
test('Y27 canonical fake → VERIFIED, COMPLETE, read-only statements, clean output', async () => {
  const r = await run();
  assert.equal(r.rc, 0, r.text);
  assert.equal(r.kinds[0], 'begin');
  assert.equal(r.kinds.at(-1), 'rollback');
  assert.ok(!r.kinds.includes('UNKNOWN'));
  const iLock = r.kinds.indexOf('lock'); const iFacts = r.kinds.indexOf('facts'); const iRow = r.kinds.indexOf('markerRows'); const iRel = r.kinds.indexOf('relations');
  assert.ok(iLock < iFacts && iFacts < iRow && iRow < iRel, 'identity must precede operational reads');
  assert.match(r.text, /A4_IDENTITY=VERIFIED/); assert.match(r.text, /A4_STATE=COMPLETE/);
  assert.equal(lastLine(r), 'A4_RESULT=VERIFIED');
  assert.deepEqual(leaks(r.text), []);
  assert.match(r.text, /locations: PCEN\/RETAIL_BRANCH\/active=true, PDEP\/CENTRAL_WAREHOUSE\/active=true/);
});

// ---------- Y28 hermeticity ----------
test('Y28 every filesystem path the tool touches is inside the temporary fixtures', async () => {
  const r = await run();
  assert.ok(r.fsPaths.length > 0);
  const tmp = realFs.realpathSync(os.tmpdir());
  for (const p of r.fsPaths) assert.ok(p.startsWith(tmp) || p.startsWith(os.tmpdir()), `outside fixtures: ${p}`);
});

// ---------- Y30 owner handoff chain ----------
test('Y30 a wrong digest stops the owner chain before node starts; the right one lets it run', () => {
  const dir = mkTmp(); const f = path.join(dir, 'tool.mjs'); put(f, 'tool\n');
  const good = sha256(realFs.readFileSync(f));
  const chain = (digest) => spawnSync('/bin/sh', ['-c', `printf '%s  %s\\n' '${digest}' '${f}' | sha256sum --check --strict >/dev/null 2>&1 && echo STARTED`], { encoding: 'utf8' });
  assert.equal(chain('0'.repeat(64)).stdout.includes('STARTED'), false);
  assert.equal(chain(good).stdout.trim(), 'STARTED');
});


// ======================= R2: HIGH-1 owner command (W01–W07) =======================
// In a user namespace (unshare -r) root-owned files show the overflow uid; the trust
// check is exercised against the uid this environment really observes for root files.
const TRUST_UID = realFs.statSync('/usr/bin/stat').uid;
const TRUSTED = { env: '/usr/bin/env', sh: '/bin/sh', sha256sum: '/usr/bin/sha256sum', getent: '/usr/bin/getent', id: '/usr/bin/id', cut: '/usr/bin/cut', stat: '/usr/bin/stat' };
function ownerFixture() {
  const base = mkTmp();
  const repo = path.join(base, 'repo dir');
  // Fixture tool run by the REAL node binary: records exactly what the launch chain passed.
  put(path.join(repo, 'scripts/database/pilot-a4-readonly.mjs'),
    "import { writeFileSync } from 'node:fs';\nwriteFileSync(new URL('../../ran.json', import.meta.url), JSON.stringify({ env: process.env, argv: process.argv.slice(2), execArgv: process.execArgv }));\n");
  put(path.join(repo, 'scripts/database/pilot-a4-readonly.manifest.json'), '{}\n');
  // The real Node binary behind a path with a space (exercises quoting); no shell interpreter.
  const nodeDir = path.join(base, 'node bin');
  const node = path.join(nodeDir, 'node');
  realFs.mkdirSync(nodeDir, { recursive: true });
  realFs.symlinkSync(process.execPath, node);
  const fakeDir = path.join(base, 'fakebin');
  for (const u of ['sha256sum', 'env', 'getent', 'id', 'cut', 'stat', 'sh']) put(path.join(fakeDir, u), `#!/bin/sh\n: > '${fakeDir}/INVOKED-${u}'\necho OK\nexit 0\n`, 0o755);
  const digests = {
    toolSha256: sha256(realFs.readFileSync(path.join(repo, 'scripts/database/pilot-a4-readonly.mjs'))),
    manifestSha256: sha256(realFs.readFileSync(path.join(repo, 'scripts/database/pilot-a4-readonly.manifest.json'))),
    nodeSha256: sha256(realFs.readFileSync(node)),
  };
  return { base, repo, node, nodeDir, fakeDir, digests, ranFile: path.join(repo, 'ran.json') };
}
// The production builder takes no utility paths and no identity. Tests only TRANSFORM the
// generated text: (a) the uid-0 trust literal to the uid this user namespace shows for root
// files — asserted to occur exactly once; (b) optionally one utility path, to prove the
// script's own checks — asserted to occur exactly twice (trust loop + point of use). A
// structural change of the command therefore fails the tests.
const TRUST_LITERAL = 'case "$s" in 0:[0-7][0145][0145])';
function transformOnce(text, from, to) {
  const parts = text.split(from);
  assert.equal(parts.length - 1, 1, `transform anchor must occur exactly once: ${from}`);
  return parts.join(to);
}
function runOwner(fx, { digests = {}, replaceUtil, adversarialPath = false, keepRootUid = false, extraEnv = {} } = {}) {
  realFs.rmSync(fx.ranFile, { force: true });
  let cmd = T.buildOwnerCommand({ repoDir: fx.repo, nodePath: fx.node, ...fx.digests, ...digests });
  if (!keepRootUid && TRUST_UID !== 0) cmd = transformOnce(cmd, TRUST_LITERAL, `case "$s" in ${TRUST_UID}:[0-7][0145][0145])`);
  if (replaceUtil) {
    // A utility appears in the trust loop AND at its point of use: sha256sum legitimately twice.
    assert.equal(cmd.split(`"${replaceUtil[0]}"`).length - 1, 2, `${replaceUtil[0]} must occur exactly twice`);
    cmd = cmd.split(`"${replaceUtil[0]}"`).join(`"${replaceUtil[1]}"`);
  }
  const r = spawnSync('/bin/sh', ['-c', cmd], { encoding: 'utf8', env: { PATH: adversarialPath ? `${fx.fakeDir}:/usr/bin:/bin` : '/usr/bin:/bin', HOME: '/tmp', ...extraEnv }, timeout: 10000 });
  const ran = realFs.existsSync(fx.ranFile);
  return { status: r.status, ran, record: ran ? JSON.parse(realFs.readFileSync(fx.ranFile, 'utf8')) : null, stderr: r.stderr, cmd };
}
test('W01 adversarial PATH with fake utilities: correct digests still run the real chain, a wrong tool digest stops it', () => {
  const fx = ownerFixture();
  const ok = runOwner(fx, { adversarialPath: true });
  assert.equal(ok.ran, true, 'positive control: the chain must run with correct digests');
  const bad = runOwner(fx, { adversarialPath: true, digests: { toolSha256: '0'.repeat(64) } });
  assert.equal(bad.ran, false); assert.notEqual(bad.status, 0);
});
test('W02 a substituted (user-owned) sha256sum is refused by the trust check; the real one runs', () => {
  const fx = ownerFixture();
  assert.equal(runOwner(fx).ran, true, 'positive control');
  const r = runOwner(fx, { replaceUtil: ['/usr/bin/sha256sum', path.join(fx.fakeDir, 'sha256sum')] });
  assert.equal(r.ran, false); assert.notEqual(r.status, 0);
});
test('W02b with the default trusted owner (root, uid 0), utilities owned by any other uid are refused', () => {
  const fx = ownerFixture();
  const r = runOwner(fx, { keepRootUid: true });
  if (TRUST_UID === 0) assert.equal(r.ran, true, 'outside a user namespace the real root-owned utilities are trusted');
  else { assert.equal(r.ran, false, 'root is not observable here: nothing may be trusted'); assert.equal(r.status, 71); }
});
test('W03 a missing trusted dependency stops the chain', () => {
  const fx = ownerFixture();
  assert.equal(runOwner(fx).ran, true, 'positive control');
  const r = runOwner(fx, { replaceUtil: ['/usr/bin/sha256sum', '/nonexistent/sha256sum'] });
  assert.equal(r.ran, false); assert.notEqual(r.status, 0);
});
test('W04 a wrong manifest digest stops the chain', () => {
  const fx = ownerFixture();
  assert.equal(runOwner(fx).ran, true, 'positive control');
  assert.equal(runOwner(fx, { digests: { manifestSha256: 'f'.repeat(64) } }).ran, false);
});
test('W05 a wrong node digest stops the chain', () => {
  const fx = ownerFixture();
  assert.equal(runOwner(fx).ran, true, 'positive control');
  assert.equal(runOwner(fx, { digests: { nodeSha256: 'a'.repeat(64) } }).ran, false);
});
test('W06 correct digests run the tool once with exactly HOME/PATH/LANG and the pinned arguments', () => {
  const fx = ownerFixture();
  const r = runOwner(fx, { adversarialPath: true });
  assert.equal(r.ran, true); assert.equal(r.status, 0);
  const { env, argv, execArgv } = r.record;
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'LANG', 'PATH']);
  assert.equal(env.PATH, '/usr/bin:/bin'); assert.equal(env.LANG, 'C.UTF-8'); assert.equal(env.HOME, os.userInfo().homedir);
  assert.deepEqual(argv, ['--target=pilot', '--read-only-state']);
  assert.deepEqual(execArgv, []);
});
test('W07 the command builder rejects unsafe or malformed inputs', () => {
  const fx = ownerFixture();
  const good = { repoDir: fx.repo, nodePath: fx.node, ...fx.digests };
  for (const [field, value] of [['repoDir', "/tmp/x'y"], ['repoDir', '/tmp/x"y'], ['repoDir', '/tmp/$HOME'], ['repoDir', '/tmp/`id`'], ['repoDir', '/tmp/a\\b'], ['repoDir', '/tmp/a\nb'], ['repoDir', 'relative/dir'], ['nodePath', 'node'], ['toolSha256', 'xyz'], ['nodeSha256', 'A'.repeat(64)]]) {
    assert.throws(() => T.buildOwnerCommand({ ...good, [field]: value }), undefined, `${field}=${JSON.stringify(value)}`);
  }
  assert.equal(typeof T.buildOwnerCommand(good), 'string');
});

// ======================= R2: HIGH-2 column type contract (W08–W16) =======================
const VALUE_READS = ['ledger', 'locations', 'company', 'salesByStatus', 'cashByStatus', 'users'];
for (const [id, types, blocked, flag] of [
  ['W08 _prisma_migrations.checksum is a domain', { '_prisma_migrations.checksum': { type_schema: 'public', type_name: 'checksum_dom', type_kind: 'd' } }, 'ledger', 'TYPE_CONTRACT:_prisma_migrations'],
  ['W09 Location.type is a user base type in public', { 'Location.type': { type_schema: 'public', type_name: 'LocationType', type_kind: 'b' } }, 'locations', 'TYPE_CONTRACT:Location'],
  ['W10 Sale.status enum with an unexpected name', { 'Sale.status': { type_schema: 'public', type_name: 'EvilStatus', type_kind: 'e' } }, 'salesByStatus', 'TYPE_CONTRACT:Sale'],
  ['W11 Company.cuit column absent', { 'Company.cuit': null }, 'company', 'TYPE_CONTRACT:Company'],
  ['W12 User.isActive is a composite type', { 'User.isActive': { type_schema: 'public', type_name: 'bool', type_kind: 'c' } }, 'users', 'TYPE_CONTRACT:User'],
  ['W13 CashSession.status enum outside public', { 'CashSession.status': { type_schema: 'evil', type_name: 'CashSessionStatus', type_kind: 'e' } }, 'cashByStatus', 'TYPE_CONTRACT:CashSession'],
]) {
  test(`${id} → its value read is never issued; other value reads still run`, async () => {
    const r = await run({ fake: { types } });
    assert.equal(r.rc, 0, r.text);
    assert.ok(r.kinds.includes('columnTypes'), 'the type contract must have been read');
    assert.ok(!r.kinds.includes(blocked), `${blocked} must not be issued`);
    for (const other of VALUE_READS.filter((k) => k !== blocked)) assert.ok(r.kinds.includes(other), `${other} must still be issued (W16 isolation)`);
    assert.ok(r.text.includes(flag), flag);
    assert.match(r.text, /A4_STATE=PARTIAL/);
  });
}
test('W14 canonical types → every value read issued and COMPLETE', async () => {
  const r = await run();
  assert.ok(r.kinds.includes('columnTypes'));
  for (const k of VALUE_READS) assert.ok(r.kinds.includes(k), k);
  assert.match(r.text, /A4_STATE=COMPLETE/);
});
test('W15 the type contract is read after RELATIONS and before the ledger and every value read', async () => {
  const r = await run();
  const iTypes = r.kinds.indexOf('columnTypes');
  assert.ok(iTypes > r.kinds.indexOf('relations') && iTypes >= 0);
  for (const k of VALUE_READS) assert.ok(r.kinds.indexOf(k) > iTypes, k);
});
test('W16 a failed type contract does not suppress counts', async () => {
  const r = await run({ fake: { types: { 'Sale.status': null } } });
  assert.ok(r.kinds.includes('count:Sale'));
});

// ======================= R2: MEDIUM-1 private files (W17–W24) =======================
function childPrivateRun({ root, home, fifoAt, lstatFrom }) {
  const code = `
    import * as fs from 'node:fs';
    const T = await import(${JSON.stringify(TOOL_URL)});
    const marker = await import(${JSON.stringify(pathToFileURL(path.join(HERE, 'pilot-marker.mjs')).href)});
    const a = JSON.parse(process.argv[1]);
    let clients = 0;
    const wrapped = { ...fs, lstatSync: (p, ...r) => (a.lstatFrom && p === a.fifoAt ? fs.lstatSync(a.lstatFrom, ...r) : fs.lstatSync(p, ...r)) };
    const out = [];
    const rc = await T.main(['--target=pilot', '--read-only-state'], { env: { HOME: a.home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, homedir: a.home, uid: process.getuid(), execArgv: [], version: 'v24.20.0', root: a.root, fs: wrapped,
      resolvePg: () => a.root + '/node_modules/pg/esm/index.mjs', importMarker: async () => marker, createClient: () => { clients += 1; throw Object.assign(new Error('x'), { code: 'NOPE' }); },
      refDigests: a.refDigests, log: (l) => out.push(l), error: (l) => out.push(l), endTimeoutMs: 20 });
    console.log(JSON.stringify({ rc, clients, out }));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code, JSON.stringify({ root, home, fifoAt, lstatFrom, refDigests: { pilot: refDigest(REF), forbidden: FORBIDDEN.map(refDigest) } })], { encoding: 'utf8', timeout: 4000, env: { PATH: '/usr/bin:/bin' } });
  return { killed: r.signal !== null || r.status === null, result: r.stdout.trim() ? JSON.parse(r.stdout.trim().split('\n').at(-1)) : null, stderr: r.stderr };
}
test('W17 a FIFO as the URL file is refused without blocking', () => {
  const root = buildRoot();
  const home = buildHome({ after: ({ dir }) => { const p = path.join(dir, 'pilot-database-url'); realFs.rmSync(p); spawnSync('/usr/bin/mkfifo', ['-m', '600', p]); } });
  const r = childPrivateRun({ root, home });
  assert.equal(r.killed, false, 'the tool blocked on a FIFO');
  assert.equal(r.result.rc, 3); assert.equal(r.result.clients, 0); assert.match(r.result.out.join('\n'), /phase=config/);
});
test('W18 a Unix socket as the URL file is refused', async () => {
  let server;
  const home = buildHome({ after: ({ dir }) => { realFs.rmSync(path.join(dir, 'pilot-database-url')); } });
  const sock = path.join(home, '.config/mona-jacinta/pilot-database-url');
  await new Promise((res) => { server = net.createServer().listen(sock, res); });
  try {
    const r = await run({ home });
    assert.equal(r.rc, 3); assert.match(r.text, /phase=config/); assert.equal(r.clients, 0);
  } finally { server.close(); }
});
test('W19 marker-id file mode 0400 is refused (exactly 0600 required)', async () => {
  const r = await run({ home: buildHome({ after: ({ dir }) => realFs.chmodSync(path.join(dir, 'pilot-marker-id'), 0o400) }) });
  assert.equal(r.rc, 3); assert.match(r.text, /phase=config/); assert.equal(r.clients, 0);
});
test('W20 URL file mode 0700 is refused', async () => {
  const r = await run({ home: buildHome({ after: ({ dir }) => realFs.chmodSync(path.join(dir, 'pilot-database-url'), 0o700) }) });
  assert.equal(r.rc, 3); assert.match(r.text, /phase=config/); assert.equal(r.clients, 0);
});
test('W21 0600 regular private files are accepted (positive control)', async () => {
  const r = await run();
  assert.equal(r.clients, 1); assert.equal(r.rc, 0);
});
test('W22 a file swapped between lstat and open (different inode) is refused', async () => {
  const home = buildHome();
  const decoy = path.join(home, 'decoy-url'); put(decoy, urlFor(), 0o600);
  const urlPath = path.join(home, '.config/mona-jacinta/pilot-database-url');
  const fsWrap = (fs) => ({ ...fs, openSync: (p, ...r) => fs.openSync(p === urlPath ? decoy : p, ...r) });
  const r = await run({ home, fsWrap });
  assert.equal(r.rc, 3); assert.match(r.text, /phase=config/); assert.equal(r.clients, 0);
});
test('W23 lstat says regular but the opened object is a FIFO → refused without blocking', () => {
  const root = buildRoot();
  const home = buildHome();
  const urlPath = path.join(home, '.config/mona-jacinta/pilot-database-url');
  const regularCopy = path.join(home, 'regular-copy'); put(regularCopy, urlFor(), 0o600);
  realFs.rmSync(urlPath); spawnSync('/usr/bin/mkfifo', ['-m', '600', urlPath]);
  const r = childPrivateRun({ root, home, fifoAt: urlPath, lstatFrom: regularCopy });
  assert.equal(r.killed, false, 'the tool blocked on a FIFO');
  assert.equal(r.result.rc, 3); assert.equal(r.result.clients, 0);
});
test('W24 lstat failing (EACCES) on a private file is refused', async () => {
  const home = buildHome();
  const idPath = path.join(home, '.config/mona-jacinta/pilot-marker-id');
  const fsWrap = (fs) => ({ ...fs, lstatSync: (p, ...r) => { if (p === idPath) throw Object.assign(new Error('denied'), { code: 'EACCES' }); return fs.lstatSync(p, ...r); } });
  const r = await run({ home, fsWrap });
  assert.equal(r.rc, 3); assert.match(r.text, /phase=config/); assert.equal(r.clients, 0);
});

test('W28 lstat reporting a non-regular object (simulated character device) is refused without ever opening it', async () => {
  const home = buildHome();
  const urlPath = path.join(home, '.config/mona-jacinta/pilot-database-url');
  let opened = 0;
  const fsWrap = (fs) => ({
    ...fs,
    lstatSync: (p, ...r) => {
      const st = fs.lstatSync(p, ...r);
      if (p !== urlPath) return st;
      return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { isFile: () => false, isCharacterDevice: () => true, isSymbolicLink: () => false });
    },
    openSync: (p, ...r) => { if (p === urlPath) opened += 1; return fs.openSync(p, ...r); },
  });
  const r = await run({ home, fsWrap });
  assert.equal(r.rc, 3); assert.match(r.text, /phase=config/); assert.equal(r.clients, 0);
  assert.equal(opened, 0, 'a non-regular private path must never be opened');
});

// ======================= R3: HIGH-1 trust bootstrap (V01–V08) =======================
test('V01 the production builder refuses alternative utility paths', () => {
  const fx = ownerFixture();
  assert.throws(() => T.buildOwnerCommand({ repoDir: fx.repo, nodePath: fx.node, ...fx.digests, utils: { ...TRUSTED } }));
  assert.throws(() => T.buildOwnerCommand({ repoDir: fx.repo, nodePath: fx.node, ...fx.digests, utils: { ...TRUSTED, stat: path.join(fx.fakeDir, 'stat') } }));
});
test('V02 the production builder has no identity parameter (trustedUid refused, even 0)', () => {
  const fx = ownerFixture();
  for (const trustedUid of [1000, 65534, 0]) assert.throws(() => T.buildOwnerCommand({ repoDir: fx.repo, nodePath: fx.node, ...fx.digests, trustedUid }), undefined, String(trustedUid));
});
test('V03 unknown or missing builder keys are refused', () => {
  const fx = ownerFixture();
  const good = { repoDir: fx.repo, nodePath: fx.node, ...fx.digests };
  assert.throws(() => T.buildOwnerCommand({ ...good, extra: 'x' }));
  for (const k of Object.keys(good)) { const g = { ...good }; delete g[k]; assert.throws(() => T.buildOwnerCommand(g), undefined, k); }
});
test('V04 a contaminated owner PATH never reaches any fake utility; the chain still runs', () => {
  const fx = ownerFixture();
  const r = runOwner(fx, { adversarialPath: true });
  assert.equal(r.ran, true, r.stderr);
  const invoked = realFs.readdirSync(fx.fakeDir).filter((f) => f.startsWith('INVOKED-'));
  assert.deepEqual(invoked, []);
});
test('V05 ENV/BASH_ENV in the owner environment are never sourced', () => {
  const fx = ownerFixture();
  const evil = path.join(fx.base, 'evil.sh'); const mark = path.join(fx.base, 'EVIL-RAN');
  put(evil, `: > '${mark}'\n`, 0o755);
  const r = runOwner(fx, { extraEnv: { ENV: evil, BASH_ENV: evil } });
  assert.equal(r.ran, true, r.stderr);
  assert.equal(realFs.existsSync(mark), false);
});
test('V06 every executable path in the command is a fixed utility, the repo or the node path', () => {
  const fx = ownerFixture();
  const cmd = T.buildOwnerCommand({ repoDir: fx.repo, nodePath: fx.node, ...fx.digests });
  const quoted = [...cmd.matchAll(/"(\/[^"]*)"/g)].map((m) => m[1]);
  const allowed = new Set([...Object.values(TRUSTED), fx.repo, fx.node]);
  assert.ok(quoted.length > 0);
  for (const q of quoted) assert.ok(allowed.has(q), `unexpected path ${q}`);
  assert.doesNotMatch(cmd, /\$PATH|\$\{PATH/);
  for (const u of ['sha256sum', 'getent', 'stat', 'cut']) {
    const bare = cmd.split(`"/usr/bin/${u}"`).join('').match(new RegExp(`(^|[^/a-z0-9])${u}\\b`, 'g')) ?? [];
    assert.deepEqual(bare, [], `${u} referenced without its absolute path`);
  }
});
test('V07 the unmodified command cannot be satisfied by a substitute identity: where root is unobservable it refuses', () => {
  const fx = ownerFixture();
  const r = runOwner(fx, { keepRootUid: true });
  if (TRUST_UID === 0) assert.equal(r.ran, true);
  else { assert.equal(r.ran, false); assert.equal(r.status, 71); }
  assert.throws(() => T.buildOwnerCommand({ repoDir: fx.repo, nodePath: fx.node, ...fx.digests, trustedUid: TRUST_UID }));
});
test('V08 the uid-0 trust pattern occurs exactly once', () => {
  const fx = ownerFixture();
  const cmd = T.buildOwnerCommand({ repoDir: fx.repo, nodePath: fx.node, ...fx.digests });
  assert.equal(cmd.split(TRUST_LITERAL).length - 1, 1);
});

// ======================= R3: HIGH-2 SQL read safety (V09–V18) =======================
test('V09 every table read is FROM ONLY with no database-side ordering, grouping, filtering, comparison or column cast', () => {
  const reads = Object.entries(T.STATEMENTS).filter(([, sql]) => /FROM (ONLY )?public\./.test(sql));
  assert.ok(reads.length >= 25 + 6, `only ${reads.length} table reads`);
  for (const [id, sql] of reads) {
    assert.match(sql, /FROM ONLY public\./, id);
    assert.doesNotMatch(sql, /\b(ORDER BY|GROUP BY|WHERE|JOIN|DISTINCT|FILTER|LIKE|ILIKE|IN|HAVING|UNION|LIMIT|OFFSET)\b|[=<>~]/, id);
    assert.equal(sql.replaceAll('count(*)::text', '').includes('::'), false, `${id}: column cast`);
  }
});
test('V10 index paths and JIT are disabled before any table is read', async () => {
  const r = await run();
  const firstRead = r.kinds.findIndex((k) => k === 'markerRows' || k.startsWith('count:') || VALUE_READS.includes(k));
  for (const sql of ['SET LOCAL enable_indexscan = off', 'SET LOCAL enable_indexonlyscan = off', 'SET LOCAL enable_bitmapscan = off', 'SET LOCAL jit = off']) {
    const i = r.log.indexOf(sql);
    assert.ok(i >= 0 && i < firstRead, `${sql} missing or late`);
  }
});
for (const [id, fake, table, flag, reads] of [
  ['V11 non-heap table access method', { heapAm: { Product: false } }, 'Product', 'ACCESS_METHOD:Product', []],
  ['V11 non-heap access method on a value table', { heapAm: { Sale: false } }, 'Sale', 'ACCESS_METHOD:Sale', ['salesByStatus']],
  ['V12 table with inheritance children', { hasSubclass: { Sale: true } }, 'Sale', 'INHERITANCE:Sale', ['salesByStatus']],
  ['V12 partition table', { isPartition: { User: true } }, 'User', 'INHERITANCE:User', ['users']],
  ['V13 index with a non-built-in access method or operator class', { indexesBuiltin: { CashSession: false } }, 'CashSession', 'INDEX_CONTRACT:CashSession', ['cashByStatus']],
]) {
  test(`${id} → no count and no value read for ${table}; flagged; PARTIAL`, async () => {
    const r = await run({ fake });
    assert.equal(r.rc, 0, r.text);
    assert.ok(!r.kinds.includes(`count:${table}`), `count:${table} issued`);
    for (const k of reads) assert.ok(!r.kinds.includes(k), `${k} issued`);
    assert.ok(r.text.includes(flag), flag);
    assert.match(r.text, /A4_STATE=PARTIAL/);
  });
}
for (const [id, types] of [
  ['V14 non-default collation on a text column', { 'Location.code': { type_schema: 'pg_catalog', type_name: 'text', type_kind: 'b', coll_schema: 'pg_catalog', coll_name: 'C', out_builtin: true } }],
  ['V14 collation outside pg_catalog', { 'Location.code': { type_schema: 'pg_catalog', type_name: 'text', type_kind: 'b', coll_schema: 'public', coll_name: 'default', out_builtin: true } }],
  ['V15 non-built-in output function', { 'Location.isActive': { type_schema: 'pg_catalog', type_name: 'bool', type_kind: 'b', coll_schema: null, coll_name: null, out_builtin: false } }],
]) {
  test(`${id} → value read skipped, count still allowed`, async () => {
    const r = await run({ fake: { types } });
    assert.ok(!r.kinds.includes('locations'));
    assert.ok(r.kinds.includes('count:Location'));
    assert.match(r.text, /TYPE_CONTRACT:Location/);
  });
}
for (const [id, fake] of [['V16 marker table not heap', { markerHeap: false }], ['V16 marker index AM not built-in', { markerIndexes: false }]]) {
  test(`${id} → identity refused before the marker row; no operational statement`, async () => {
    const r = await run({ fake });
    assert.equal(r.rc, 2);
    assert.ok(r.kinds.includes('markerAccess'));
    assert.ok(!r.kinds.includes('markerRows'));
    assert.ok(!r.kinds.some((k) => OPERATIONAL(k) && k !== 'markerRows'));
  });
}
test('V17 ordering, grouping and the sentinel comparison happen in JavaScript, exactly', async () => {
  const r = await run({ fake: {
    saleRows: [{ status: 'PAID' }, { status: 'COMPLETED' }, { status: 'PAID' }, { status: 'DRAFT' }],
    cashRows: [{ status: 'OPEN' }, { status: 'CLOSED' }, { status: 'CLOSED' }],
    companyRows: [{ cuit: 'OTHER' }, { cuit: 'PILOT-NO-FISCAL' }],
    userRows: [{ active: false }, { active: true }, { active: true }],
    locations: [{ code: 'PDEP', type: 'CENTRAL_WAREHOUSE', active: true }, { code: 'PCEN', type: 'RETAIL_BRANCH', active: false }],
    countValue: { Sale: '4', CashSession: '3', User: '3', Company: '2', Location: '2' },
  } });
  assert.match(r.text, /sales by status: COMPLETED=1, DRAFT=1, PAID=2\n/);
  assert.match(r.text, /cash sessions by status: CLOSED=2, OPEN=1\n/);
  assert.match(r.text, /company rows with PILOT-NO-FISCAL sentinel: 1\/2\n/);
  assert.match(r.text, /users active\/inactive \(counts only\): 2\/1\n/);
  assert.match(r.text, /locations: PCEN\/RETAIL_BRANCH\/active=false, PDEP\/CENTRAL_WAREHOUSE\/active=true\n/);
  const bad = await run({ fake: { saleRows: [{ status: 'EVIL' }], countValue: { Sale: '1' } } });
  assert.match(bad.text, /sales by status: INVALID\([0-9a-f]{12}\)=1/);
  assert.match(bad.text, /INVALID_VALUE:Sale/);
});
test('V18 a status table above the row cap is not read', async () => {
  const r = await run({ fake: { countValue: { Sale: '100001' } } });
  assert.ok(!r.kinds.includes('salesByStatus'));
  assert.match(r.text, /ROWS_TOO_MANY:Sale/);
  assert.ok(r.kinds.includes('cashByStatus'));
});

// ======================= R4: Prisma ledger history (U01–U18) =======================
const M = '20261006120000_pilot_pricing_v2';
function cleanLedger(root) {
  return MIGRATIONS.map((m) => ({ migration_name: m, checksum: sha256(realFs.readFileSync(path.join(root, `api/prisma/migrations/${m}/migration.sql`))), finished: true, rolled_back: false, applied_steps_count: 1 }));
}
// Replaces the rows of migration M with `rows(goodChecksum)`.
async function runHistory(rowsFor, extraFake = {}, root = buildRoot()) {
  const base = cleanLedger(root);
  const good = base.find((r) => r.migration_name === M).checksum;
  const ledger = [...base.filter((r) => r.migration_name !== M), ...rowsFor(good)];
  return run({ root, fake: { ledger, ...extraFake } });
}
const lineFor = (r, name = M) => r.text.split('\n').find((l) => l.startsWith(`  ledger ${name}:`));
const row = (checksum, finished, rolledBack, steps = 1) => ({ migration_name: M, checksum, finished, rolled_back: rolledBack, applied_steps_count: steps });
function permutations(xs) { return xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p])); }

test('U01 a single failed attempt → FAILED, never COMPLETE', async () => {
  const r = await runHistory((g) => [row(g, false, false, 0)]);
  assert.match(lineFor(r), /status=FAILED/); assert.match(r.text, /MIGRATION_FAILED/); assert.match(r.text, /MIGRATION_INCOMPLETE/); assert.match(r.text, /A4_STATE=PARTIAL/);
});
test('U02 failed attempt rolled back, then a success (both orders) → APPLIED and COMPLETE', async () => {
  for (const order of [0, 1]) {
    const r = await runHistory((g) => { const rows = [row(g, false, true, 0), row(g, true, false, 1)]; return order ? rows.reverse() : rows; });
    assert.match(lineFor(r), /status=APPLIED /); assert.match(r.text, /A4_STATE=COMPLETE/);
  }
});
test('U03 failed attempt NOT rolled back plus a success (both orders) → FAILED, never COMPLETE', async () => {
  for (const order of [0, 1]) {
    const r = await runHistory((g) => { const rows = [row(g, false, false, 0), row(g, true, false, 1)]; return order ? rows.reverse() : rows; });
    assert.match(lineFor(r), /status=FAILED/); assert.match(r.text, /A4_STATE=PARTIAL/);
  }
});
test('U04 two successful rows for one migration (both orders) → AMBIGUOUS', async () => {
  for (const order of [0, 1]) {
    const r = await runHistory((g) => { const rows = [row(g, true, false, 1), row('deadbeef', true, false, 1)]; return order ? rows.reverse() : rows; });
    assert.match(lineFor(r), /status=AMBIGUOUS/); assert.match(r.text, /MIGRATION_AMBIGUOUS/); assert.match(r.text, /A4_STATE=PARTIAL/);
  }
});
test('U05 only rolled-back attempts → ROLLED_BACK (pending)', async () => {
  const r = await runHistory((g) => [row(g, false, true, 0), row(g, false, true, 0)]);
  assert.match(lineFor(r), /status=ROLLED_BACK/); assert.match(r.text, /A4_STATE=PARTIAL/);
});
test('U06 finished AND rolled back on one row → AMBIGUOUS', async () => {
  const r = await runHistory((g) => [row(g, true, true, 1)]);
  assert.match(lineFor(r), /status=AMBIGUOUS/);
});
test('U07 applied row matches but a rolled-back attempt had another checksum → APPLIED_AFTER_CHANGED_RECOVERY, not COMPLETE', async () => {
  const r = await runHistory((g) => [row('deadbeef', false, true, 0), row(g, true, false, 1)]);
  assert.match(lineFor(r), /status=APPLIED_AFTER_CHANGED_RECOVERY/); assert.match(r.text, /MIGRATION_HISTORY_DRIFT/); assert.match(r.text, /A4_STATE=PARTIAL/);
});
test('U08 single applied row with a different checksum → DRIFT', async () => {
  const r = await runHistory(() => [row('deadbeef', true, false, 1)]);
  assert.match(lineFor(r), /status=DRIFT/); assert.match(lineFor(r), /checksum_matches_repo=false/); assert.match(r.text, /MIGRATION_DRIFT/); assert.match(r.text, /A4_STATE=PARTIAL/);
});
for (const [label, bad] of [['finished null', { finished: null }], ['rolled_back string', { rolled_back: 'false' }]]) {
  test(`U09 malformed flag (${label}) → AMBIGUOUS`, async () => {
    const r = await runHistory((g) => [{ ...row(g, true, false, 1), ...bad }]);
    assert.match(lineFor(r), /status=AMBIGUOUS/); assert.match(r.text, /A4_STATE=PARTIAL/);
  });
}
for (const steps of [1.5, -1, '1', null]) {
  test(`U10 applied_steps_count ${JSON.stringify(steps)} → AMBIGUOUS`, async () => {
    const r = await runHistory((g) => [row(g, true, false, steps)]);
    assert.match(lineFor(r), /status=AMBIGUOUS/);
  });
}
for (const [label, shape, expected] of [
  ['recovered', (g) => [row(g, false, true, 0), row(g, false, true, 0), row(g, true, false, 1)], 'APPLIED'],
  ['failed + success', (g) => [row(g, false, true, 0), row(g, false, false, 0), row(g, true, false, 1)], 'FAILED'],
  ['double success', (g) => [row(g, false, true, 0), row(g, true, false, 1), row(g, true, false, 1)], 'AMBIGUOUS'],
]) {
  test(`U11 every permutation of a 3-row ${label} history gives the same result (${expected})`, async () => {
    const root = buildRoot();
    const outputs = new Set();
    for (const perm of permutations([0, 1, 2])) {
      const r = await runHistory((g) => { const rows = shape(g); return perm.map((i) => rows[i]); }, {}, root);
      outputs.add(`${lineFor(r)}|${r.text.match(/A4_STATE=\w+/)[0]}`);
    }
    assert.equal(outputs.size, 1, [...outputs].join('\n'));
    assert.match([...outputs][0], new RegExp(`status=${expected}[ |]`));
  });
}
test('U12 a ledger count exactly at the cap (1000) is read', async () => {
  const r = await run({ fake: { ledgerCount: '1000' } });
  assert.ok(r.kinds.includes('ledger')); assert.doesNotMatch(r.text, /ROWS_TOO_MANY:_prisma_migrations/);
});
test('U13 a ledger count above the cap (1001) is not read', async () => {
  const r = await run({ fake: { ledgerCount: '1001' } });
  assert.ok(!r.kinds.includes('ledger')); assert.match(r.text, /ROWS_TOO_MANY:_prisma_migrations/); assert.match(r.text, /A4_STATE=PARTIAL/);
});
for (const bad of ['abc', '', '-1', null]) {
  test(`U14 malformed ledger count ${JSON.stringify(bad)} → not read`, async () => {
    const r = await run({ fake: { ledgerCount: bad } });
    assert.ok(!r.kinds.includes('ledger')); assert.match(r.text, /ROWS_UNKNOWN:_prisma_migrations/); assert.match(r.text, /A4_STATE=PARTIAL/);
  });
}
test('U15 rows returned differ from the snapshot count → LEDGER_COUNT_MISMATCH, never COMPLETE', async () => {
  const r = await run({ fake: { ledgerCount: '8' } });
  assert.match(r.text, /LEDGER_COUNT_MISMATCH/); assert.match(r.text, /A4_STATE=PARTIAL/);
});
test('U16 a non-string migration name is digested, flagged and does not crash', async () => {
  const root = buildRoot();
  const r = await run({ root, fake: { ledger: [...cleanLedger(root), { migration_name: 42, checksum: 'x', finished: true, rolled_back: false, applied_steps_count: 1 }, { migration_name: null, checksum: 'x', finished: true, rolled_back: false, applied_steps_count: 1 }] } });
  assert.equal(r.rc, 0, r.text); assert.match(r.text, /ledger UNKNOWN\([0-9a-f]{12}\)/); assert.match(r.text, /UNKNOWN_MIGRATION/);
});
test('U17 the ledger count is issued after RELATIONS and COLUMN_TYPES and before the ledger read', async () => {
  const r = await run();
  const i = (k) => r.kinds.indexOf(k);
  assert.ok(i('relations') < i('columnTypes') && i('columnTypes') < i('countLedger') && i('countLedger') < i('ledger') && i('relations') >= 0);
});
test('U18 the generated command uses /usr/bin/sha256sum exactly twice (trust loop + digest check)', () => {
  const fx = ownerFixture();
  const cmd = T.buildOwnerCommand({ repoDir: fx.repo, nodePath: fx.node, ...fx.digests });
  assert.equal(cmd.split('"/usr/bin/sha256sum"').length - 1, 2);
});

// ---------- R01 committed manifest matches the installed tree ----------
test('R01 the committed manifest verifies against this repository (no credentials read)', () => {
  const res = T.verifyIntegrity({ root: REAL_ROOT, fs: realFs, resolvePg: () => fileURLToPath(import.meta.resolve('pg')) });
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.packages, 14);
  assert.ok(res.files >= 138 + 10, `files verified: ${res.files}`);
});

test('Y28 no socket was attempted anywhere in this test process', () => {
  assert.equal(netAttempts, 0);
});

process.on('exit', () => { for (const d of tmpRoots) realFs.rmSync(d, { recursive: true, force: true }); });
