// Hermetic tests for pilot-backup.mjs. Fakes and temp fixtures only: synthetic project refs and
// passwords, fake pg_dump child, fake pg_restore output. No credentials, no database, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import * as realFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import * as T from './pilot-backup.mjs';
import * as marker from './pilot-marker.mjs';
import * as STATES from './pilot-migration-states.mjs';
import * as RBAC from './pilot-rbac-catalog.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sha = (b) => createHash('sha256').update(b).digest('hex');
const refDigest = (r) => sha(`mona-pilot-project-ref\n${r}`);
const tmpRoots = [];
const mkTmp = () => { const d = realFs.mkdtempSync(path.join(os.tmpdir(), 'pbk-')); tmpRoots.push(d); return d; };
const put = (f, data, mode = 0o644) => { realFs.mkdirSync(path.dirname(f), { recursive: true }); realFs.writeFileSync(f, data); realFs.chmodSync(f, mode); };
process.on('exit', () => { for (const d of tmpRoots) realFs.rmSync(d, { recursive: true, force: true }); });

const REF = 'aaaabbbbccccddddeeee';
const FORBIDDEN = ['ffffgggghhhhiiiijjjj', 'kkkkllllmmmmnnnnoooo', 'ppppqqqqrrrrsssstttt'];
const PW = 'S3cretPw';
const POOLER = 'aws-0-sa-east-1.pooler.supabase.com';
const MID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const urlFor = ({ user = `postgres.${REF}`, host = POOLER, port = 5432, db = 'postgres' } = {}) => `postgresql://${user}:${PW}@${host}:${port}/${db}`;
const SECRETS = [PW, POOLER, `postgres.${REF}`, REF, MID];

// Literal, hand-written lists (independent of the tool's constants).
const CORE = ['AuditLog', 'Branch', 'Brand', 'CashMovement', 'CashRegister', 'CashSession', 'Category', 'Company', 'Inventory', 'Location',
  'Permission', 'Product', 'ProductVariant', 'Role', 'RolePermission', 'Sale', 'SaleItem', 'SaleNumberCounter', 'SalePayment',
  'StockMovement', 'StockReservation', 'User', 'UserBranchRole', 'UserRoleScope'];
const LEDGER = '_prisma_migrations';
const KEY = '0123456789abcdef'.repeat(4);
const MIGS = ['20260907015311_init', '20260912182432_add_company_location', '20260912191702_add_user_role_scope',
  '20260922210000_d3_initial_stock_and_global_audit', '20261002120000_block1_pricing_wholesale', '20261006120000_pilot_pricing_v2',
  '20261012120000_cash_session_reconciliation', '20261016120000_r3_proportional_checkout', '20261016130000_r3_checkout_attempts',
  '20261018120000_cash_movement_withdrawals_expenses', '20261018180000_cash_movement_reversals'];
// The ledger checksum of each migration is the pinned SHA-256 of its reviewed migration.sql.
const MIG_SHA = Object.fromEntries(STATES.MIGRATION_PINS.map((p) => [p.name, p.sha256]));
const REPO_SHA = new Map(MIGS.map((m) => [`api/prisma/migrations/${m}/migration.sql`, MIG_SHA[m]]));
const LEDGER_COLS = 'id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count';
const ledgerRow = (m, { checksum = MIG_SHA[m], finished = true, rolledBack = false, steps = '1', id = `id-${m}` } = {}) => [id, checksum,
  finished ? '2026-09-27 03:00:00+00' : '\\N', m, '\\N', rolledBack ? '2026-09-27 03:01:00+00' : '\\N', '2026-09-27 02:59:00+00', steps];
const S4_LEDGER = MIGS.slice(0, 4).map((m) => ledgerRow(m));
const G7_LEDGER = MIGS.slice(0, 7).map((m) => ledgerRow(m));
const G11_LEDGER = MIGS.map((m) => ledgerRow(m));
const FN_TRG = ['95; 1255 17005 FUNCTION public fn_sale_payment_history() postgres', '96; 1255 17006 FUNCTION public fn_sale_payment_truncate_guard() postgres',
  '97; 1255 17007 FUNCTION public fn_sale_wholesale_frozen_after_payment() postgres',
  '98; 2620 17008 TRIGGER public SalePayment trg_sale_payment_history_before postgres', '99; 2620 17009 TRIGGER public SalePayment trg_sale_payment_history_after postgres',
  '100; 2620 17010 TRIGGER public SalePayment trg_sale_payment_truncate_guard postgres', '101; 2620 17011 TRIGGER public Sale trg_sale_wholesale_frozen_after_payment postgres'];
const R3 = ['CheckoutAttempt', 'CheckoutAttemptDeclaration', 'CheckoutAttemptTender', 'ExternalCollection', 'SaleCheckout', 'SaleLineAllocation'];
const R3_FN_TRG = ['110; 1255 17020 FUNCTION public fn_checkout_attempt_commit_check() postgres', '111; 1255 17021 FUNCTION public fn_checkout_attempt_declaration_guard() postgres',
  '112; 1255 17022 FUNCTION public fn_checkout_attempt_guard() postgres', '113; 1255 17023 FUNCTION public fn_checkout_attempt_tender_guard() postgres',
  '114; 1255 17024 FUNCTION public fn_checkout_declaration_commit_check() postgres', '115; 1255 17025 FUNCTION public fn_external_collection_guard() postgres',
  '116; 2620 17026 TRIGGER public CheckoutAttempt trg_checkout_attempt_commit_check postgres', '117; 2620 17027 TRIGGER public CheckoutAttempt trg_checkout_attempt_guard postgres',
  '118; 2620 17028 TRIGGER public CheckoutAttemptDeclaration trg_checkout_attempt_declaration_guard postgres',
  '119; 2620 17029 TRIGGER public CheckoutAttemptDeclaration trg_checkout_declaration_commit_check postgres',
  '120; 2620 17030 TRIGGER public CheckoutAttemptTender trg_checkout_attempt_tender_guard postgres', '121; 2620 17031 TRIGGER public ExternalCollection trg_external_collection_guard postgres'];
// RBAC catalog COPY rows (pg_dump column order id, code, ... / roleId, permissionId) of a pinned catalog.
function catalogRows(def) {
  const roleId = new Map(def.roles.map(([c, id]) => [c, id])); const permId = new Map(def.permissions.map(([c, id]) => [c, id]));
  return {
    Role: def.roles.map(([c, id]) => [id, c, 'desc']), Permission: def.permissions.map(([c, id]) => [id, c, 'desc']),
    RolePermission: def.grants.map(([r, pm]) => [roleId.get(r), permId.get(pm)]),
  };
}
const CAT35 = catalogRows(RBAC.CATALOG_35);
const CAT36 = catalogRows(RBAC.CATALOG_36);
const COLS = { Role: 'id, code, description', Permission: 'id, code, description', RolePermission: '"roleId", "permissionId"' };
// Synthetic generated references (the generator needs LOCAL_TEST; only the digest binding is exercised here).
const SYN_REFS = { SCHEMA_REFERENCES: { EXACT_S4: { digest: '4'.repeat(64) }, EXACT_G7: { digest: '7'.repeat(64) }, EXACT_G11: { digest: 'b'.repeat(64) } } };

function tocText({ dbname = 'postgres', server = '17.4', dumpv = '17.11 (Debian 17.11-0+deb13u1)', tables = [...CORE, LEDGER], dropData = [], extra = [], guard = true } = {}) {
  const lines = [';', '; Archive created at 2026-10-15 01:00:00 UTC', `;     dbname: ${dbname}`, ';     TOC Entries: 99', ';     Compression: gzip',
    ';     Dump Version: 1.16-0', ';     Format: CUSTOM', ';     Integer: 4 bytes', ';     Offset: 8 bytes',
    `;     Dumped from database version: ${server}`, `;     Dumped by pg_dump version: ${dumpv}`, ';', ';', '; Selected TOC Entries:', ';'];
  let id = 10; let oid = 16400;
  if (guard) { lines.push(`${id++}; 2615 ${oid++} SCHEMA - mona_pilot_guard postgres`, `${id++}; 0 0 COMMENT - SCHEMA mona_pilot_guard postgres`); }
  lines.push(`${id++}; 1247 ${oid++} TYPE public SaleStatus postgres`);
  for (const t of tables) lines.push(`${id++}; 1259 ${oid++} TABLE public ${t} postgres`);
  if (guard) lines.push(`${id++}; 1259 ${oid++} TABLE mona_pilot_guard database_identity postgres`);
  for (const t of tables) if (!dropData.includes(t)) lines.push(`${id++}; 0 ${oid++} TABLE DATA public ${t} postgres`);
  if (guard && !dropData.includes('database_identity')) lines.push(`${id++}; 0 ${oid++} TABLE DATA mona_pilot_guard database_identity postgres`);
  lines.push(`${id++}; 2606 ${oid++} CONSTRAINT public Sale Sale_pkey postgres`, `${id++}; 1259 ${oid++} INDEX public Sale_branchId_idx postgres`,
    `${id++}; 2606 ${oid++} FK CONSTRAINT public Sale Sale_branchId_fkey postgres`);
  lines.push(...extra);
  return `${lines.join('\n')}\n`;
}
function markerCopy({ rows = [['t', 'pilot', MID, '2026-09-27 03:38:00.123+00']] } = {}) {
  return ['--', '-- PostgreSQL database dump', '--', '', '\\restrict k3y', '',
    'COPY mona_pilot_guard.database_identity (singleton, environment, marker_id, installed_at) FROM stdin;',
    ...rows.map((r) => r.join('\t')), '\\.', '', '\\unrestrict k3y', ''].join('\n');
}

function buildHome({ url = urlFor(), markerId = `${MID}\n`, macKey = `${KEY}\n` } = {}) {
  const home = mkTmp();
  const dir = path.join(home, '.config', 'mona-jacinta');
  realFs.mkdirSync(dir, { recursive: true }); realFs.chmodSync(path.join(home, '.config'), 0o700); realFs.chmodSync(dir, 0o700);
  put(path.join(dir, 'pilot-database-url'), url, 0o600); put(path.join(dir, 'pilot-marker-id'), markerId, 0o600);
  if (macKey !== null) put(path.join(dir, 'pilot-backup-mac-key'), macKey, 0o600);
  return home;
}
function buildOut(mode = 0o700) { const base = mkTmp(); const out = path.join(base, 'pilot-backups'); realFs.mkdirSync(out); realFs.chmodSync(out, mode); return out; }

// Fake pg_dump: writes the --file it is given, then exits; may hang, leak stderr, or skip writing.
function fakeSpawnFactory(o = {}) {
  const calls = [];
  const spawn = (file, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kills = [];
    const home = options?.env?.HOME;
    let homeState = null;
    try { const st = realFs.lstatSync(home); homeState = { dir: st.isDirectory(), mode: st.mode & 0o777, entries: realFs.readdirSync(home) }; } catch { homeState = null; }
    calls.push({ file, args, options, child, homeState });
    child.kill = (sig) => { child.kills.push(sig); if (sig === 'SIGKILL' || (sig === 'SIGTERM' && !o.ignoreTerm)) setImmediate(() => child.emit('close', null, sig)); return true; };
    if (o.hang) return child;
    setImmediate(() => {
      const fileArg = args.find((a) => a.startsWith('--file='))?.slice(7);
      if (fileArg && o.write !== false) {
        // R2: the tool pre-creates the temp file exclusively; a "symlink" result now models a replaced path.
        if (o.symlink) { realFs.rmSync(fileArg, { force: true }); realFs.symlinkSync('/etc/hostname', fileArg); }
        else { realFs.writeFileSync(fileArg, o.bytes ?? Buffer.from('PGDMP\u0001\u000efixture-archive')); realFs.chmodSync(fileArg, o.mode ?? 0o600); }
      }
      if (o.stderr) child.stderr.write(o.stderr);
      child.stdout.end(); child.stderr.end();
      child.emit('close', o.exitCode ?? 0, null);
    });
    return child;
  };
  return { spawn, calls };
}
// Public data as pg_restore --data-only writes it: one COPY block per table, quoted mixed-case names.
const ROWS = { Company: [['c1', 'Mona', '20-1-2', 'Calle 1', 't', '2026-09-27 03:38:00+00']], Sale: [['s2', 'x'], ['s1', 'y']], [LEDGER]: S4_LEDGER, ...CAT35 };
const qi = (t) => (/^[a-z_][a-z0-9_]*$/.test(t) ? t : `"${t}"`);
function dataText(tables = [...CORE, LEDGER], rows = ROWS) {
  const out = ['--', '-- PostgreSQL database dump', '--', '', '\\restrict k3y', "SELECT pg_catalog.set_config('search_path', '', false);", ''];
  for (const t of tables) out.push(`COPY public.${qi(t)} (${t === LEDGER ? LEDGER_COLS : (COLS[t] ?? '"id", "v"')}) FROM stdin;`, ...(rows[t] ?? []).map((r) => r.join('\t')), '\\.', '');
  out.push("SELECT pg_catalog.setval('public.\"x_seq\"', 1, false);", '\\unrestrict k3y', '');
  return out.join('\n');
}
const G7_TABLES = [...CORE, LEDGER, 'CompanyPricingConfig'];
const G11_TABLES = [...G7_TABLES, ...R3];
const DDL = ['--', '-- PostgreSQL database dump', '--', '', '\\restrict k3y', "SELECT pg_catalog.set_config('search_path', '', false);", '',
  'CREATE TABLE public."Sale" (id text NOT NULL);', '', '\\unrestrict k3y', ''].join('\n');
// Exact-state pg_restore options: the TOC objects and COPY data of each state (catalog per argument).
const G7 = (o = {}) => ({ tocOpts: { tables: G7_TABLES, extra: FN_TRG }, data: dataText(G7_TABLES, { ...ROWS, [LEDGER]: G7_LEDGER, ...(o.catalog ?? CAT35) }) });
const G11 = (o = {}) => ({ tocOpts: { tables: G11_TABLES, extra: [...FN_TRG, ...R3_FN_TRG] }, data: dataText(G11_TABLES, { ...ROWS, [LEDGER]: G11_LEDGER, ...(o.catalog ?? CAT36) }) });
const fakePgRestore = (o = {}) => (kind) => {
  o.hook?.(kind);
  if (kind === 'list') return { status: 0, stdout: o.toc ?? tocText(o.tocOpts) };
  if (kind === 'marker') return { status: 0, stdout: o.copy ?? markerCopy(o.copyOpts) };
  if (kind === 'data') return { status: 0, stdout: o.data ?? dataText(o.tocOpts?.tables) };
  if (kind === 'ddl') return { status: 0, stdout: o.ddl ?? DDL };
  throw new Error(`unexpected pg_restore kind ${kind}`);
};

async function run({ argv, state = 'EXACT_S4', references = SYN_REFS, importShared, home = buildHome(), out = buildOut(), env, spawnOpts = {}, pgOpts = {}, statfs, forbiddenRoots, verifyManifest, fsWrap, now = new Date('2026-10-15T01:02:03Z'), hex = 'abcdef0123456789abcdef0123456789', timeoutMs = 2000, killGraceMs = 20 } = {}) {
  const outLines = [];
  let imports = 0;
  const fake = fakeSpawnFactory(spawnOpts);
  const deps = {
    env: env ?? { HOME: home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, homedir: home, uid: process.getuid(), execArgv: [], version: 'v24.20.0',
    root: path.resolve(HERE, '..', '..'), fs: fsWrap ? fsWrap(realFs) : realFs,
    verifyManifest: verifyManifest ?? (() => ({ ok: true, repoSha: REPO_SHA })),
    importMarker: async () => { imports += 1; return marker; },
    importShared: importShared ?? (async () => ({ states: STATES, references, rbac: RBAC })),
    spawn: fake.spawn, pgRestore: fakePgRestore(pgOpts),
    refDigests: { pilot: refDigest(REF), forbidden: FORBIDDEN.map(refDigest) },
    forbiddenRoots: forbiddenRoots ?? [path.resolve(HERE, '..', '..')],
    statfs: statfs ?? (() => ({ bavail: 10n ** 9n, bsize: 4096n })),
    now: () => now, randomHex: (n) => hex.slice(0, n * 2).padEnd(n * 2, '0'),
    timeoutMs, killGraceMs,
    log: (l) => outLines.push(String(l)), error: (l) => outLines.push(String(l)),
  };
  const rc = await T.main(argv ?? ['--target=pilot', '--execute', `--output-dir=${out}`, `--expected-state=${state}`], deps);
  const text = outLines.join('\n');
  const listing = realFs.existsSync(out) ? realFs.readdirSync(out).sort() : [];
  return { rc, text, out, home, calls: fake.calls, imports, listing, last: outLines.at(-1) };
}
const leaks = (s) => SECRETS.filter((x) => s.includes(x));

// ---------------- arguments, gates ----------------
for (const argv of [[], ['--target=pilot'], ['--target=pilot', '--execute'], ['--target=test', '--execute', '--output-dir=/x'], ['--target=pilot', '--execute', '--output-dir=relative'],
  ['--target=pilot', '--execute', '--dry-run', '--output-dir=/x'], ['--target=pilot', '--execute', '--output-dir=/x', '--output-dir=/y'], ['--target=pilot', '--execute', '--output-dir=/x', '--sql=1'],
  ['--target=pilot', '--execute', '--output-dir=/x'], ['--target=pilot', '--execute', '--output-dir=/x', '--expected-state=EXACT_G10'],
  ['--target=pilot', '--execute', '--output-dir=/x', '--expected-state=S4'], ['--target=pilot', '--execute', '--output-dir=/x', '--expected-state='],
  ['--target=pilot', '--execute', '--expected-state=EXACT_S4', '--expected-state=EXACT_G7'],
  ['--target=pilot', '--execute', '--output-dir=/x', '--expected-state=EXACT_S4', '--expected-state=EXACT_G7']]) {
  test(`args refused: ${JSON.stringify(argv)}`, async () => {
    const r = await run({ argv }); assert.equal(r.rc, 1); assert.match(r.text, /phase=args/); assert.equal(r.calls.length, 0); assert.equal(r.last, 'A5B_RESULT=REFUSED');
  });
}
for (const extra of ['PGHOST', 'PGPORT', 'PGUSER', 'PGDATABASE', 'PGSERVICE', 'PGOPTIONS', 'NODE_OPTIONS']) {
  test(`D05 parent env with ${extra} → refused before anything`, async () => {
    const home = buildHome();
    const r = await run({ home, env: { HOME: home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', [extra]: 'x' } });
    assert.equal(r.rc, 3); assert.match(r.text, /phase=env/); assert.equal(r.imports, 0); assert.equal(r.calls.length, 0);
  });
}
test('integrity failure → refused before pilot-marker is imported', async () => {
  const r = await run({ verifyManifest: () => ({ ok: false, reason: 'x' }) });
  assert.equal(r.rc, 3); assert.match(r.text, /phase=integrity/); assert.equal(r.imports, 0); assert.equal(r.calls.length, 0);
});
for (const [name, url] of [
  ['forbidden ref 1', urlFor({ user: `postgres.${FORBIDDEN[0]}` })], ['forbidden ref 2', urlFor({ user: `postgres.${FORBIDDEN[1]}` })],
  ['forbidden ref 3', urlFor({ user: `postgres.${FORBIDDEN[2]}` })], ['unknown ref', urlFor({ user: 'postgres.uuuuvvvvwwwwxxxxyyyy' })],
  ['host outside contract', urlFor({ host: 'evil.example.com' })], ['port 6543', urlFor({ port: 6543 })], ['database other', urlFor({ db: 'other' })],
  ['direct host with pooler user', urlFor({ host: `db.${REF}.supabase.co` })],
]) {
  test(`E08 ${name} → refused before spawn, no identity leak`, async () => {
    const r = await run({ home: buildHome({ url }) });
    assert.equal(r.rc, 3); assert.match(r.text, /phase=(target|config)/); assert.equal(r.calls.length, 0);
    assert.deepEqual(leaks(r.text), []);
  });
}
test('E08 forbidden ref reported as FORBIDDEN', async () => {
  const r = await run({ home: buildHome({ url: urlFor({ user: `postgres.${FORBIDDEN[1]}` }) }) });
  assert.match(r.text, /FORBIDDEN/);
});
test('config: marker-id file not a UUIDv4 → refused', async () => {
  const r = await run({ home: buildHome({ markerId: 'nope\n' }) }); assert.equal(r.rc, 3); assert.match(r.text, /phase=config/); assert.equal(r.calls.length, 0);
});

// ---------------- output directory (D15) and disk ----------------
test('D15 output dir under a forbidden root → refused', async () => {
  const out = buildOut();
  const r = await run({ out, forbiddenRoots: [path.dirname(out)] }); assert.equal(r.rc, 3); assert.match(r.text, /phase=output/); assert.equal(r.calls.length, 0);
});
test('D15 output dir mode 0750 → refused', async () => {
  const r = await run({ out: buildOut(0o750) }); assert.equal(r.rc, 3); assert.match(r.text, /phase=output/);
});
test('D15 output dir through a symlinked component → refused', async () => {
  const out = buildOut(); const link = path.join(mkTmp(), 'link'); realFs.symlinkSync(path.dirname(out), link);
  const r = await run({ argv: ['--target=pilot', '--execute', `--output-dir=${path.join(link, 'pilot-backups')}`, '--expected-state=EXACT_S4'] }); assert.equal(r.rc, 3); assert.match(r.text, /phase=output/);
});
test('D15 missing output dir → refused (never created implicitly)', async () => {
  const out = path.join(mkTmp(), 'absent');
  const r = await run({ argv: ['--target=pilot', '--execute', `--output-dir=${out}`, '--expected-state=EXACT_S4'] }); assert.equal(r.rc, 3); assert.equal(realFs.existsSync(out), false);
});
test('insufficient free space → refused before spawn', async () => {
  const r = await run({ statfs: () => ({ bavail: 10n, bsize: 4096n }) }); assert.equal(r.rc, 3); assert.match(r.text, /phase=output/); assert.equal(r.calls.length, 0);
});
test('dry-run performs every gate and spawns nothing', async () => {
  const out = buildOut();
  const r = await run({ out, argv: ['--target=pilot', '--dry-run', `--output-dir=${out}`, '--expected-state=EXACT_G7'] });
  assert.equal(r.rc, 0); assert.equal(r.last, 'A5B_RESULT=DRY_RUN_OK'); assert.equal(r.calls.length, 0); assert.deepEqual(r.listing, []);
  assert.match(r.text, /expected state EXACT_G7/);
});

// ---------------- pg_dump invocation (E01, E02) ----------------
test('E01/E02 pg_dump: absolute binary, connection only through an allowlisted child env, nothing secret in argv', async () => {
  const r = await run();
  assert.equal(r.calls.length, 1);
  const { file, args, options } = r.calls[0];
  assert.equal(file, '/usr/lib/postgresql/17/bin/pg_dump');
  const fileArg = args.find((a) => a.startsWith('--file='));
  assert.ok(fileArg && path.dirname(fileArg.slice(7)) === r.out, 'temporary output inside the output dir');
  assert.deepEqual(args.filter((a) => a !== fileArg), ['--format=custom', '--schema=public', '--schema=mona_pilot_guard', '--no-owner', '--no-privileges', '--no-password', '--lock-wait-timeout=30s']);
  assert.deepEqual(leaks(args.join(' ')), []);
  assert.deepEqual(Object.keys(options.env).sort(), ['HOME', 'LANG', 'PATH', 'PGAPPNAME', 'PGCONNECT_TIMEOUT', 'PGDATABASE', 'PGHOST', 'PGPASSFILE', 'PGPASSWORD', 'PGPORT',
    'PGSERVICEFILE', 'PGSSLCERT', 'PGSSLCRL', 'PGSSLCRLDIR', 'PGSSLKEY', 'PGSSLMODE', 'PGSSLROOTCERT', 'PGSYSCONFDIR', 'PGTZ', 'PGUSER']);
  assert.equal(options.env.PGHOST, POOLER); assert.equal(options.env.PGPORT, '5432'); assert.equal(options.env.PGUSER, `postgres.${REF}`);
  assert.equal(options.env.PGDATABASE, 'postgres'); assert.equal(options.env.PGPASSWORD, PW); assert.equal(options.env.PGSSLMODE, 'verify-full');
  assert.equal(options.env.PATH, '/usr/bin:/bin');
  assert.ok(options.env.PGSSLROOTCERT.endsWith('scripts/certs/supabase-prod-ca-2021.crt'));
});

// ---------------- happy path and publication ----------------
test('happy path: verified archive and canonical dump manifest published 0600, temps gone, nothing secret', async () => {
  const r = await run();
  assert.equal(r.rc, 0, r.text); assert.equal(r.last, 'A5B_RESULT=VERIFIED');
  const names = T.artifactNames({ now: new Date('2026-10-15T01:02:03Z'), hex: 'abcdef01' });
  assert.deepEqual(r.listing, [names.dump, names.manifest].sort());
  for (const n of r.listing) assert.equal(realFs.statSync(path.join(r.out, n)).mode & 0o777, 0o600);
  const mBytes = realFs.readFileSync(path.join(r.out, names.manifest));
  const parsed = T.parseDumpManifest(mBytes);
  assert.equal(parsed.ok, true, parsed.reason);
  const m = parsed.manifest;
  assert.equal(m.format, 'mona-pilot-backup/v2');
  assert.equal(m.archive.file, names.dump);
  assert.equal(m.archive.sha256, sha(realFs.readFileSync(path.join(r.out, names.dump))));
  assert.equal(m.serverVersion, '17.4');
  assert.deepEqual(Object.keys(m.tables), [...CORE, LEDGER].sort());
  assert.equal(m.tables.Sale.rows, 2); assert.equal(m.tables.Branch.rows, 0);
  const sorted = ['s1\ty', 's2\tx'].join('\n');
  assert.equal(m.tables.Sale.copySha256, sha(`"id", "v"\n${sorted}`), 'columns + sorted COPY lines');
  assert.equal(m.tables.Branch.copySha256, sha('"id", "v"\n'));
  assert.equal(m.refDigest, refDigest(REF));
  assert.equal(m.markerIdDigest, sha(`mona-pilot-marker-id\n${MID}`));
  assert.equal(m.ledgerState, 'EXACT_S4');
  assert.deepEqual(m.rbacCatalog, { catalog: 'CATALOG_35', digest: RBAC.CATALOG_DIGESTS.CATALOG_35, permissions: 35, grants: 73 });
  assert.equal(m.schemaReferenceDigest, '4'.repeat(64));
  const { mac, format, ...rest } = m;
  assert.equal(format, 'mona-pilot-backup/v2');
  assert.equal(mac, createHmac('sha256', Buffer.from(KEY, 'hex')).update(`mona-pilot-backup/v2 mac\n${T.canonicalManifestBody(rest)}`).digest('hex'), 'HMAC over the canonical body');
  assert.deepEqual(leaks(mBytes.toString()), []); assert.deepEqual(leaks(r.text), []); assert.ok(!mBytes.toString().includes(KEY));
});
test('G11-B01 EXACT_S4 never tolerates CompanyPricingConfig (no optional tables any more)', async () => {
  const r = await run({ pgOpts: { tocOpts: { tables: G7_TABLES }, data: dataText(G7_TABLES) } });
  assert.notEqual(r.rc, 0); assert.deepEqual(r.listing, []); assert.match(r.text, /outside the EXACT_S4 set/);
});

// ---------------- failures (E03, E04, D14, D16, D17) ----------------
test('E03 pg_dump timeout → SIGTERM then SIGKILL, temp removed, ERROR', async () => {
  const r = await run({ spawnOpts: { hang: true, ignoreTerm: true }, timeoutMs: 30, killGraceMs: 20 });
  assert.equal(r.rc, 4); assert.equal(r.last, 'A5B_RESULT=ERROR');
  assert.deepEqual(r.calls[0].child.kills, ['SIGTERM', 'SIGKILL']);
  assert.deepEqual(r.listing, []);
});
test('D14 pg_dump failure with secrets in stderr → only a fixed code, nothing persisted', async () => {
  const r = await run({ spawnOpts: { exitCode: 1, stderr: `connection to ${POOLER} user postgres.${REF} password ${PW} failed` } });
  assert.equal(r.rc, 4); assert.deepEqual(leaks(r.text), []); assert.deepEqual(r.listing, []);
});
for (const [name, spawnOpts] of [['no file', { write: false }], ['empty file', { bytes: Buffer.alloc(0) }], ['mode 0644', { mode: 0o644 }], ['symlink', { symlink: true }], ['not a pg archive', { bytes: Buffer.from('NOTPGDMP') }]]) {
  test(`E04 pg_dump exit 0 but ${name} → ERROR, nothing published`, async () => {
    const r = await run({ spawnOpts });
    assert.equal(r.rc, 4); assert.ok(!r.listing.some((n) => n.endsWith('.dump') && !n.startsWith('.')), r.listing.join(','));
    assert.ok(!r.listing.some((n) => n.endsWith('.manifest.json')));
  });
}
test('D16 TABLE DATA missing for a required table → not published, temp removed', async () => {
  const r = await run({ pgOpts: { tocOpts: { dropData: ['SalePayment'] } } });
  assert.equal(r.rc, 4); assert.deepEqual(r.listing, []);
});
test('D16 marker TABLE DATA missing → not published', async () => {
  const r = await run({ pgOpts: { tocOpts: { dropData: ['database_identity'] } } });
  assert.notEqual(r.rc, 0); assert.deepEqual(r.listing, []);
});
for (const [name, extra] of [
  ['EXTENSION', '90; 3079 17000 EXTENSION - pgcrypto postgres'], ['EVENT TRIGGER', '91; 3466 17001 EVENT TRIGGER - evt postgres'],
  ['POLICY', '92; 3256 17002 POLICY public Sale p1 postgres'], ['VIEW', '93; 1259 17003 VIEW public v1 postgres'],
  ['foreign schema', '94; 2615 17004 SCHEMA - evil postgres'], ['unknown FUNCTION', '95; 1255 17005 FUNCTION public evil() postgres'],
  ['unknown TRIGGER', '96; 2620 17006 TRIGGER public Sale evil_trg postgres'], ['TEST guard', '97; 2615 17007 SCHEMA - mona_test_guard postgres'],
  ['unknown table', '98; 1259 17008 TABLE public Evil postgres'],
]) {
  test(`D03/E06 archive TOC with ${name} → refused`, async () => {
    const r = await run({ pgOpts: { tocOpts: { extra: [extra] } } });
    assert.notEqual(r.rc, 0); assert.deepEqual(r.listing, []);
  });
}
test('G11-B02 EXACT_G7: block1 functions and triggers are accepted when G7 is the expected state', async () => {
  const r = await run({ state: 'EXACT_G7', pgOpts: G7() });
  assert.equal(r.rc, 0, r.text); assert.equal(r.last, 'A5B_RESULT=VERIFIED');
  const m = T.parseDumpManifest(realFs.readFileSync(path.join(r.out, NAMES.manifest))).manifest;
  assert.equal(m.ledgerState, 'EXACT_G7'); assert.equal(m.schemaReferenceDigest, '7'.repeat(64));
  assert.deepEqual(Object.keys(m.tables), [...G7_TABLES].sort());
});
test('E05 TOC dbname ≠ postgres → refused', async () => {
  const r = await run({ pgOpts: { tocOpts: { dbname: 'other' } } }); assert.notEqual(r.rc, 0); assert.deepEqual(r.listing, []);
});
for (const [name, tocOpts] of [['pg_dump not 17.11', { dumpv: '16.4' }], ['server major 18', { server: '18.0' }]]) {
  test(`version gate: ${name} → refused`, async () => {
    const r = await run({ pgOpts: { tocOpts } }); assert.notEqual(r.rc, 0); assert.deepEqual(r.listing, []);
  });
}
for (const [name, rows] of [
  ['two rows', [['t', 'pilot', MID, '2026-09-27 03:38:00+00'], ['t', 'pilot', MID, '2026-09-27 03:38:00+00']]],
  ['environment test', [['t', 'test', MID, '2026-09-27 03:38:00+00']]],
  ['other marker id', [['t', 'pilot', OTHER, '2026-09-27 03:38:00+00']]],
  ['null installed_at', [['t', 'pilot', MID, '\\N']]],
]) {
  test(`E07 marker in archive: ${name} → identity refused (exit 2), nothing published, ids never printed`, async () => {
    const r = await run({ pgOpts: { copyOpts: { rows } } });
    assert.equal(r.rc, 2); assert.deepEqual(r.listing, []); assert.ok(!r.text.includes(MID)); assert.ok(!r.text.includes(OTHER));
  });
}
test('D17 final name collision → refused, existing file untouched', async () => {
  const out = buildOut();
  const names = T.artifactNames({ now: new Date('2026-10-15T01:02:03Z'), hex: 'abcdef01' });
  put(path.join(out, names.dump), 'EXISTING', 0o600);
  const r = await run({ out });
  assert.equal(r.rc, 5); assert.equal(realFs.readFileSync(path.join(out, names.dump), 'utf8'), 'EXISTING');
  assert.ok(!r.listing.includes(names.manifest)); assert.ok(!r.listing.some((n) => n.startsWith('.')), 'own temp removed');
});

// ---------------- pure parsers ----------------
test('parseToc reads header and entries (multi-word types, tags with spaces)', () => {
  const t = T.parseToc(tocText());
  assert.equal(t.dbname, 'postgres'); assert.equal(t.serverVersion, '17.4'); assert.equal(t.dumpVersion, '17.11 (Debian 17.11-0+deb13u1)');
  assert.ok(t.entries.some((e) => e.type === 'TABLE DATA' && e.schema === 'public' && e.name === 'Sale'));
  assert.ok(t.entries.some((e) => e.type === 'FK CONSTRAINT' && e.name === 'Sale Sale_branchId_fkey'));
  assert.ok(t.entries.some((e) => e.type === 'SCHEMA' && e.schema === '-' && e.name === 'mona_pilot_guard'));
});
test('parseMarkerCopy: exactly one well-formed row', () => {
  assert.deepEqual(T.parseMarkerCopy(markerCopy()), { ok: true, environment: 'pilot', markerId: MID });
  assert.equal(T.parseMarkerCopy(markerCopy({ rows: [] })).ok, false);
  assert.equal(T.parseMarkerCopy('COPY other.table (a) FROM stdin;\n1\n\\.\n').ok, false);
});
test('E13 parseDumpManifest is strict: extra key, non-canonical bytes, secret-bearing field, wrong format', () => {
  const good = T.buildDumpManifest({ setId: 'abcdef01-0000-4000-8000-000000000000', createdAt: '2026-10-15T01:02:03.000Z', toolSha256: 'a'.repeat(64),
    pgDumpVersion: '17.11', serverVersion: '17.4', archive: { file: 'pilot_x.dump', bytes: 10, sha256: 'b'.repeat(64) }, tocSha256: 'c'.repeat(64),
    schemas: ['mona_pilot_guard', 'public'], tables: { Sale: { rows: 2, copySha256: 'f'.repeat(64) } }, refDigest: 'd'.repeat(64), markerIdDigest: 'e'.repeat(64),
    ledgerState: 'EXACT_S4', rbacCatalog: { catalog: 'CATALOG_35', digest: '8'.repeat(64), permissions: 35, grants: 73 }, schemaReferenceDigest: '7'.repeat(64),
    mac: '9'.repeat(64) });
  assert.equal(T.parseDumpManifest(Buffer.from(good)).ok, true);
  const obj = JSON.parse(good);
  assert.equal(T.parseDumpManifest(Buffer.from(JSON.stringify({ ...obj, extra: 1 }) + '\n')).ok, false);
  assert.equal(T.parseDumpManifest(Buffer.from(JSON.stringify(obj, null, 2) + '\n')).ok, false, 'non-canonical');
  assert.equal(T.parseDumpManifest(Buffer.from(good.replace('"bytes":10', '"bytes":10,"password":"x"'))).ok, false);
  assert.equal(T.parseDumpManifest(Buffer.from(good.replace('mona-pilot-backup/v2', 'other'))).ok, false);
  assert.equal(T.parseDumpManifest(Buffer.from(good.replace('mona-pilot-backup/v2', 'mona-pilot-backup/v1'))).ok, false, 'a v1 manifest is refused');
  for (const legacy of ['S4', 'S7', 'EXACT_G10', 'PARTIAL']) assert.equal(T.parseDumpManifest(Buffer.from(good.replace('"EXACT_S4"', `"${legacy}"`))).ok, false, legacy);
  assert.equal(T.parseDumpManifest(Buffer.from(good.replace('"EXACT_S4"', '"EXACT_G11"'))).ok, false, 'G11 with CATALOG_35');
  assert.equal(T.parseDumpManifest(Buffer.from(good.replace('"EXACT_S4"', '"EXACT_G11"').replace('CATALOG_35', 'CATALOG_36'))).ok, true);
  assert.equal(T.parseDumpManifest(Buffer.from(good.replace('CATALOG_35', 'CATALOG_99'))).ok, false);
  assert.equal(T.parseDumpManifest(Buffer.from(good.replace(`"schemaReferenceDigest":"${'7'.repeat(64)}"`, '"schemaReferenceDigest":"x"'))).ok, false);
});

for (const [name, ddl] of [
  ['LANGUAGE c', "CREATE FUNCTION public.fn_sale_payment_history() RETURNS trigger\n    LANGUAGE c\n    AS '/tmp/x.so', 'f';\n"],
  ['LANGUAGE plpython3u', 'CREATE FUNCTION public.fn_sale_payment_history() RETURNS trigger\n    LANGUAGE plpython3u\n    AS $$ x $$;\n'],
  ['COPY TO PROGRAM in a body', "CREATE FUNCTION public.fn_sale_payment_history() RETURNS trigger\n    LANGUAGE plpgsql\n    AS $$ BEGIN COPY x TO PROGRAM 'id'; END $$;\n"],
  ['server file read', 'CREATE FUNCTION public.fn_sale_payment_history() RETURNS trigger\n    LANGUAGE sql\n    AS $$ SELECT pg_read_file(\'/etc/passwd\') $$;\n'],
]) {
  test(`E18 archive DDL with ${name} → refused, nothing published`, async () => {
    const r = await run({ pgOpts: { ddl } });
    assert.notEqual(r.rc, 0); assert.deepEqual(r.listing, []);
  });
}
test('E17 data COPY block for a table missing from the TOC, or a TOC table without a COPY block → refused', async () => {
  const r1 = await run({ pgOpts: { data: dataText([...CORE, LEDGER, 'Evil']) } }); assert.notEqual(r1.rc, 0); assert.deepEqual(r1.listing, []);
  const r2 = await run({ pgOpts: { data: dataText(CORE) } }); assert.notEqual(r2.rc, 0); assert.deepEqual(r2.listing, []);
});
test('D13 data with control characters / result tokens is never echoed', async () => {
  const rows = { ...ROWS, Company: [['A5B_RESULT=VERIFIED', '\u001b[31mred']] };
  const r = await run({ pgOpts: { data: dataText(undefined, rows) } });
  assert.equal(r.rc, 0, r.text);
  assert.equal(r.text.split('\n').filter((l) => l.includes('A5B_RESULT=')).length, 1);
  assert.ok(!r.text.includes('\u001b'));
});
test('E18 verifyDdl accepts the exact pg_dump preamble but refuses set_config anywhere else (found by ITEST S4)', () => {
  const preamble = "SET statement_timeout = 0;\nSELECT pg_catalog.set_config('search_path', '', false);\nSET check_function_bodies = false;\n";
  const fn = "CREATE FUNCTION public.fn_sale_payment_history() RETURNS trigger\n    LANGUAGE plpgsql\n    AS $$ BEGIN RETURN NEW; END $$;\n";
  assert.equal(T.verifyDdl(`${preamble}${fn}`).ok, true);
  assert.equal(T.verifyDdl(`${preamble}CREATE FUNCTION public.fn_sale_payment_history() RETURNS trigger\n    LANGUAGE plpgsql\n    AS $$ BEGIN PERFORM set_config('x', 'y', false); RETURN NEW; END $$;\n`).ok, false);
  assert.equal(T.verifyDdl("SELECT pg_catalog.set_config('search_path', 'evil', false);\n").ok, false);
});

// =====================================================================================
// R2 (Codex A5-002 / A5-003 / A5-004 / A5-005) — scenarios F08–F25 registered before these tests
// =====================================================================================
const NAMES = T.artifactNames({ now: new Date('2026-10-15T01:02:03Z'), hex: 'abcdef01' });
const finals = (listing) => listing.filter((n) => n === NAMES.dump || n === NAMES.manifest);
// fs wrapper that knows which path each descriptor was opened for.
function trackingFs(over) {
  return (fs) => {
    const paths = new Map();
    const w = { ...fs };
    w.openSync = (p, ...rest) => { const fd = fs.openSync(p, ...rest); paths.set(fd, String(p)); return fd; };
    w.closeSync = (fd) => { const p = paths.get(fd); paths.delete(fd); return over.closeSync ? over.closeSync(fs, fd, p) : fs.closeSync(fd); };
    if (over.writeSync) w.writeSync = (fd, ...rest) => over.writeSync(fs, fd, paths.get(fd), ...rest);
    if (over.fsyncSync) w.fsyncSync = (fd) => over.fsyncSync(fs, fd, paths.get(fd));
    return w;
  };
}

test('F08 temp archive replaced after verification → not deleted, nothing published, ERROR', async () => {
  const out = buildOut(); const temp = path.join(out, NAMES.temp);
  const r = await run({ out, pgOpts: { hook: (kind) => { if (kind === 'data') { realFs.renameSync(temp, `${temp}.moved`); put(temp, 'FOREIGN', 0o600); } } } });
  assert.equal(r.rc, 4); assert.equal(r.last, 'A5B_RESULT=ERROR');
  assert.deepEqual(finals(r.listing), []);
  assert.equal(realFs.readFileSync(temp, 'utf8'), 'FOREIGN', 'the foreign inode is not deleted');
  assert.ok(realFs.existsSync(`${temp}.moved`));
});
test('F09 a write that makes no progress → ERROR, own artifacts withdrawn', async () => {
  const r = await run({ fsWrap: trackingFs({ writeSync: (fs, fd, p, ...rest) => (p?.endsWith('.dump') || p?.endsWith('.dump.partial') ? 0 : fs.writeSync(fd, ...rest)) }) });
  assert.equal(r.rc, 4); assert.deepEqual(finals(r.listing), []);
  const r2 = await run({ fsWrap: trackingFs({ writeSync: (fs, fd, p, ...rest) => (p?.endsWith('.manifest.json') || p?.endsWith('.manifest.json.partial') ? 0 : fs.writeSync(fd, ...rest)) }) });
  assert.equal(r2.rc, 4); assert.deepEqual(finals(r2.listing), [], 'archive withdrawn when the manifest write fails');
});
test('F09 short (partial) writes are completed by the write loop → VERIFIED with exact bytes', async () => {
  const r = await run({ fsWrap: trackingFs({ writeSync: (fs, fd, p, buf, off, len, pos) => fs.writeSync(fd, buf, off, Math.min(len ?? buf.length, 3), pos) }) });
  assert.equal(r.rc, 0, r.text);
  assert.equal(realFs.readFileSync(path.join(r.out, NAMES.dump)).toString('latin1'), 'PGDMP\u0001\u000efixture-archive');
  assert.equal(T.parseDumpManifest(realFs.readFileSync(path.join(r.out, NAMES.manifest))).ok, true);
});
for (const [name, over] of [
  ['archive fsync fails', { fsyncSync: (fs, fd, p) => { if (p?.endsWith('.dump') || p?.endsWith('.dump.partial')) throw new Error('EIO'); return fs.fsyncSync(fd); } }],
  ['manifest fsync fails', { fsyncSync: (fs, fd, p) => { if (p?.endsWith('.manifest.json') || p?.endsWith('.manifest.json.partial')) throw new Error('EIO'); return fs.fsyncSync(fd); } }],
  ['directory fsync fails', { fsyncSync: (fs, fd, p) => { if (p && !p.endsWith('.dump') && !p.endsWith('.json') && !p.endsWith('.partial')) throw new Error('EIO'); return fs.fsyncSync(fd); } }],
  ['archive close fails', { closeSync: (fs, fd, p) => { fs.closeSync(fd); if (p?.endsWith('.dump') || p?.endsWith('.dump.partial')) throw new Error('EIO'); } }],
]) {
  test(`F10 ${name} → ERROR, never VERIFIED, own artifacts withdrawn`, async () => {
    const r = await run({ fsWrap: trackingFs(over) });
    assert.equal(r.rc, 4, r.text); assert.notEqual(r.last, 'A5B_RESULT=VERIFIED'); assert.deepEqual(finals(r.listing), []);
  });
}
test('F11 manifest name taken between the pre-check and publication → refused, foreign file untouched, own archive withdrawn', async () => {
  const out = buildOut();
  const r = await run({ out, pgOpts: { hook: (kind) => { if (kind === 'data') put(path.join(out, NAMES.manifest), 'FOREIGN', 0o600); } } });
  assert.equal(r.rc, 5); assert.equal(realFs.readFileSync(path.join(out, NAMES.manifest), 'utf8'), 'FOREIGN');
  assert.equal(realFs.existsSync(path.join(out, NAMES.dump)), false);
});
test('F11 archive name taken between the pre-check and publication → refused, foreign file untouched', async () => {
  const out = buildOut();
  const r = await run({ out, pgOpts: { hook: (kind) => { if (kind === 'data') put(path.join(out, NAMES.dump), 'FOREIGN', 0o600); } } });
  assert.equal(r.rc, 5); assert.equal(realFs.readFileSync(path.join(out, NAMES.dump), 'utf8'), 'FOREIGN');
  assert.equal(realFs.existsSync(path.join(out, NAMES.manifest)), false);
});
test('F12 published archive differs on reread → ERROR, withdrawn', async () => {
  const r = await run({ fsWrap: trackingFs({ closeSync: (fs, fd, p) => { fs.closeSync(fd); if (p?.endsWith(NAMES.dump) || p?.endsWith(NAMES.dump + '.partial')) fs.appendFileSync(p, 'x'); } }) });
  assert.equal(r.rc, 4); assert.deepEqual(finals(r.listing), []);
});

// =====================================================================================
// G11-ADV-005 — the publication TAIL is strict: marker removal checked, final fsync
// mandatory, published finals re-verified by inode+sha before VERIFIED, and every tail
// failure KEEPS the evidence (dump, manifest and commit marker all stay on disk; only
// the VERIFIED verdict is withheld). The commit marker inside a published set is the
// restore-verifier's signal of an INCOMPLETE set, so keeping it on failure is correct.
// =====================================================================================
const markerName = (out) => realFs.readdirSync(out).find((n) => n.startsWith('.commit-') && n.length > 40);

test('F26 a successful publication leaves no commit marker, no WARNING, and VERIFIED', async () => {
  const r = await run();
  assert.equal(r.rc, 0, r.text);
  assert.equal(markerName(r.out), undefined, 'the commit marker is gone after a clean publication');
  assert.ok(!r.text.includes('WARNING'), r.text);
  assert.equal(r.last, 'A5B_RESULT=VERIFIED');
});

test('F26 unlink of the commit marker failing → ERROR, evidence kept (dump, manifest, marker)', async () => {
  const out = buildOut();
  const r = await run({ out, fsWrap: (fs) => {
    const w = { ...fs };
    w.unlinkSync = (p) => {
      if (String(p).includes('.commit-')) throw Object.assign(new Error('EPERM injected'), { code: 'EPERM' });
      return fs.unlinkSync(p);
    };
    return w;
  } });
  assert.equal(r.rc, 4, r.text);
  assert.equal(r.last, 'A5B_RESULT=ERROR');
  assert.match(r.text, /phase=publish — the commit marker could not be removed/);
  assert.deepEqual(finals(r.listing).sort(), [NAMES.dump, NAMES.manifest].sort(), 'the evidence is kept');
  assert.ok(markerName(out), 'the commit marker stays so the set cannot read as complete');
});

test('F26 the commit marker replaced before removal → ERROR, evidence kept', async () => {
  const out = buildOut();
  let markerLstat = 0;
  const r = await run({ out, fsWrap: (fs) => {
    const w = { ...fs };
    w.lstatSync = (p) => {
      const s = fs.lstatSync(p);
      if (String(p).includes('.commit-')) {
        markerLstat += 1;
        if (markerLstat === 2) return { isFile: () => true, isSymbolicLink: () => false, isDirectory: () => false, dev: s.dev + 1, ino: s.ino + 1, mode: s.mode, size: s.size };
      }
      return s;
    };
    return w;
  } });
  assert.equal(r.rc, 4);
  assert.equal(r.last, 'A5B_RESULT=ERROR');
  assert.match(r.text, /the commit marker was replaced before its removal/);
  assert.deepEqual(finals(r.listing).sort(), [NAMES.dump, NAMES.manifest].sort());
  assert.ok(markerName(out));
});

test('F26 final fsync failing after the marker removal → ERROR, evidence kept (never VERIFIED)', async () => {
  let dirFsyncs = 0;
  const r = await run({ fsWrap: trackingFs({ fsyncSync: (fs, fd, p) => {
    if (p && !/\.(dump|json)/.test(String(p)) && !String(p).includes('.partial') && !String(p).includes('.commit-')) {
      dirFsyncs += 1;
      if (dirFsyncs === 4) throw new Error('EIO injected');
    }
    return fs.fsyncSync(fd);
  } }) });
  assert.equal(r.rc, 4, r.text);
  assert.notEqual(r.last, 'A5B_RESULT=VERIFIED');
  assert.match(r.text, /the output directory could not be synced after the commit marker removal/);
  assert.ok(dirFsyncs >= 4);
});

test('F26 a published final changed between the link and the tail → ERROR, evidence kept', async () => {
  const out = buildOut();
  let finalLstat = 0;
  const r = await run({ out, fsWrap: (fs) => {
    const w = { ...fs };
    w.lstatSync = (p) => {
      const s = fs.lstatSync(p);
      if (String(p) === path.join(out, NAMES.dump)) {
        finalLstat += 1;
        if (finalLstat === 2) realFs.appendFileSync(String(p), 'x');
      }
      return s;
    };
    return w;
  } });
  assert.equal(r.rc, 4, r.text);
  assert.notEqual(r.last, 'A5B_RESULT=VERIFIED');
  assert.match(r.text, /did not re-verify against the bytes this run produced/);
  assert.deepEqual(finals(r.listing).sort(), [NAMES.dump, NAMES.manifest].sort(), 'the corrupted set is kept as evidence, not withdrawn');
});
test('F13 older backups in the output directory are never touched (success and failure)', async () => {
  for (const pgOpts of [{}, { tocOpts: { dropData: ['SalePayment'] } }]) {
    const out = buildOut();
    const old = ['pilot_20260101T000000Z_00000000.dump', 'pilot_20260101T000000Z_00000000.dump.manifest.json'];
    for (const n of old) put(path.join(out, n), `OLD ${n}`, 0o600);
    await run({ out, pgOpts });
    for (const n of old) assert.equal(realFs.readFileSync(path.join(out, n), 'utf8'), `OLD ${n}`);
  }
});

// ---------------- A5-003 ledger ----------------
const withLedger = (ledger, tables = [...CORE, LEDGER]) => ({ tocOpts: { tables }, data: dataText(tables, { ...ROWS, [LEDGER]: ledger }) });
for (const [name, ledger] of [
  ['empty', []],
  ['only 3 of S4', S4_LEDGER.slice(0, 3)],
  ['S4 plus one later migration', [...S4_LEDGER, ledgerRow(MIGS[4])]],
  ['G11 ledger plus an unknown migration', [...G11_LEDGER, ledgerRow('20990101000000_evil', { checksum: 'c'.repeat(64) })]],
  ['duplicate applied row', [...S4_LEDGER, ledgerRow(MIGS[0], { id: 'dup' })]],
  ['failed attempt (unfinished, not rolled back)', [...S4_LEDGER, ledgerRow(MIGS[4], { finished: false })]],
  ['applied with the wrong checksum', [...S4_LEDGER.slice(0, 3), ledgerRow(MIGS[3], { checksum: 'b'.repeat(64) })]],
  ['malformed checksum', [...S4_LEDGER.slice(0, 3), ledgerRow(MIGS[3], { checksum: 'XYZ' })]],
  ['malformed applied_steps_count', [...S4_LEDGER.slice(0, 3), ledgerRow(MIGS[3], { steps: 'x' })]],
  ['only a rolled-back attempt for one S4 migration', [...S4_LEDGER.slice(0, 3), ledgerRow(MIGS[3], { finished: false, rolledBack: true })]],
]) {
  test(`F14 archive ledger ${name} → refused, nothing published`, async () => {
    const r = await run({ pgOpts: withLedger(ledger) });
    assert.notEqual(r.rc, 0); assert.deepEqual(finals(r.listing), []); assert.match(r.text, /ledger/);
  });
}
test('F15 shuffled exact S4 ledger → EXACT_S4 VERIFIED; any rolled-back attempt (even same checksum) → refused (OWNER: none rolled back)', async () => {
  const ok = await run({ pgOpts: withLedger([S4_LEDGER[3], S4_LEDGER[1], S4_LEDGER[0], S4_LEDGER[2]]) });
  assert.equal(ok.rc, 0, ok.text);
  assert.equal(T.parseDumpManifest(realFs.readFileSync(path.join(ok.out, NAMES.manifest))).manifest.ledgerState, 'EXACT_S4');
  const r = await run({ pgOpts: withLedger([...S4_LEDGER, ledgerRow(MIGS[1], { finished: false, rolledBack: true, id: 'retry' })]) });
  assert.notEqual(r.rc, 0); assert.deepEqual(finals(r.listing), []); assert.match(r.text, /ledger/);
});
test('F16 rolled-back attempt with a DIFFERENT checksum before success → refused (conservative)', async () => {
  const ledger = [...S4_LEDGER, ledgerRow(MIGS[1], { finished: false, rolledBack: true, checksum: 'a'.repeat(64), id: 'old' })];
  const r = await run({ pgOpts: withLedger(ledger) }); assert.notEqual(r.rc, 0); assert.deepEqual(finals(r.listing), []);
});
test('F17 the expected state binds ledger AND objects: every mismatch is refused, never re-classified', async () => {
  const no = async (o, label) => { const r = await run(o); assert.notEqual(r.rc, 0, label); assert.deepEqual(finals(r.listing), [], label); return r; };
  await no({ pgOpts: withLedger(S4_LEDGER, G7_TABLES) }, 'S4 with CompanyPricingConfig');
  await no({ pgOpts: { ...withLedger(S4_LEDGER), tocOpts: { extra: FN_TRG } } }, 'S4 with block1 functions');
  await no({ state: 'EXACT_G7', pgOpts: { ...G7(), tocOpts: { tables: G7_TABLES, extra: FN_TRG.slice(1) } } }, 'G7 missing a function');
  await no({ state: 'EXACT_G7', pgOpts: { ...G7(), tocOpts: { tables: G7_TABLES, extra: FN_TRG.slice(0, 6) } } }, 'G7 missing a trigger');
  await no({ state: 'EXACT_G7', pgOpts: withLedger(S4_LEDGER) }, 'G7 expected, S4 archive');
  const s4AsG7 = await no({ state: 'EXACT_S4', pgOpts: { ...G7(), tocOpts: { tables: [...CORE, LEDGER] }, data: dataText(undefined, { ...ROWS, [LEDGER]: G7_LEDGER }) } }, 'S4 expected, G7 ledger');
  assert.match(s4AsG7.text, /ledger: the ledger is EXACT_G7, expected EXACT_S4/);
  await no({ state: 'EXACT_G11', pgOpts: G7() }, 'G11 expected, G7 archive');
  await no({ state: 'EXACT_G7', pgOpts: G11() }, 'G7 expected, G11 archive');
  await no({ state: 'EXACT_G11', pgOpts: { ...G11(), tocOpts: { tables: G11_TABLES, extra: [...FN_TRG, ...R3_FN_TRG.slice(1)] } } }, 'G11 missing an R3 function');
  await no({ state: 'EXACT_G11', pgOpts: { ...G11(), tocOpts: { tables: G11_TABLES.filter((t) => t !== 'SaleCheckout'), extra: [...FN_TRG, ...R3_FN_TRG] } } }, 'G11 missing an R3 table');
  for (const k of [7, 8, 9]) { // G8, G9, G10
    const partial = MIGS.slice(0, k + 1).map((m) => ledgerRow(m));
    await no({ state: 'EXACT_G11', pgOpts: { ...G11(), data: dataText(G11_TABLES, { ...ROWS, [LEDGER]: partial, ...CAT36 }) } }, `G11 objects, ledger with ${k + 1} migrations`);
  }
});

// ---------------- G11 cut-over: explicit state, RBAC catalog, generated reference ----------------
test('G11-B03 EXACT_G11 happy path: 32 tables, 9 functions, 10 triggers, CATALOG_36, reference digest bound', async () => {
  const r = await run({ state: 'EXACT_G11', pgOpts: G11() });
  assert.equal(r.rc, 0, r.text); assert.equal(r.last, 'A5B_RESULT=VERIFIED');
  const m = T.parseDumpManifest(realFs.readFileSync(path.join(r.out, NAMES.manifest))).manifest;
  assert.equal(m.ledgerState, 'EXACT_G11'); assert.equal(m.schemaReferenceDigest, 'b'.repeat(64));
  assert.deepEqual(m.rbacCatalog, { catalog: 'CATALOG_36', digest: RBAC.CATALOG_DIGESTS.CATALOG_36, permissions: 36, grants: 75 });
  assert.equal(Object.keys(m.tables).length, 32);
  assert.match(r.text, /ledger=EXACT_G11/);
});
test('G11-B04 RBAC catalog: G11 requires CATALOG_36; S4/G7 accept 35 or 36; any other catalog → refused', async () => {
  const g11With35 = await run({ state: 'EXACT_G11', pgOpts: G11({ catalog: CAT35 }) });
  assert.notEqual(g11With35.rc, 0); assert.deepEqual(finals(g11With35.listing), []); assert.match(g11With35.text, /rbac: the RBAC catalog is CATALOG_35, EXACT_G11 requires CATALOG_36/);
  assert.equal((await run({ state: 'EXACT_G7', pgOpts: G7({ catalog: CAT36 }) })).rc, 0, 'G7 with 36');
  assert.equal((await run({ pgOpts: { data: dataText(undefined, { ...ROWS, ...CAT36 }) } })).rc, 0, 'S4 with 36');
  const extraGrant = { ...CAT35, RolePermission: [...CAT35.RolePermission, [CAT35.Role[0][0], '00000000-0000-4000-9400-000000000036']] };
  const missingPerm = { ...CAT35, Permission: CAT35.Permission.slice(1) };
  const dupRole = { ...CAT35, Role: [...CAT35.Role, CAT35.Role[0]] };
  const nullCode = { ...CAT35, Permission: [...CAT35.Permission.slice(1), [CAT35.Permission[0][0], '\\N', 'desc']] };
  for (const [label, cat] of [['extra grant', extraGrant], ['missing permission', missingPerm], ['duplicate role', dupRole], ['NULL code', nullCode]]) {
    const r = await run({ pgOpts: { data: dataText(undefined, { ...ROWS, ...cat }) } });
    assert.notEqual(r.rc, 0, label); assert.deepEqual(finals(r.listing), [], label); assert.match(r.text, /rbac/, label);
  }
});
test('G11-B05 no generated reference for the expected state → refused before pg_dump (nothing started)', async () => {
  for (const references of [{ SCHEMA_REFERENCES: {} }, { SCHEMA_REFERENCES: { EXACT_S4: { digest: 'nope' } } }, {}]) {
    const r = await run({ references });
    assert.equal(r.rc, 3); assert.match(r.text, /phase=reference/); assert.equal(r.calls.length, 0); assert.deepEqual(r.listing, []);
  }
});
test('G11-B06 shared modules unavailable or malformed → refused at integrity, after the manifest, before pg_dump', async () => {
  for (const importShared of [async () => { throw new Error('x'); }, async () => ({ states: {}, references: SYN_REFS, rbac: RBAC }), async () => ({ states: STATES, references: SYN_REFS, rbac: {} })]) {
    const r = await run({ importShared });
    assert.equal(r.rc, 3); assert.match(r.text, /phase=integrity/); assert.equal(r.calls.length, 0);
  }
  let loaded = 0;
  const r = await run({ verifyManifest: () => ({ ok: false, reason: 'x' }), importShared: async () => { loaded += 1; return { states: STATES, references: SYN_REFS, rbac: RBAC }; } });
  assert.equal(r.rc, 3); assert.equal(loaded, 0, 'never imported before the code manifest verified');
});
test('G11-B07 state model literals: per-state table/function/trigger counts and the 11 shared migration pins', () => {
  assert.deepEqual(T.BACKUP_STATES, ['EXACT_S4', 'EXACT_G7', 'EXACT_G11']);
  assert.deepEqual(['EXACT_S4', 'EXACT_G7', 'EXACT_G11'].map((k) => [T.STATE_OBJECTS[k].tables.length, T.STATE_OBJECTS[k].functions.length, T.STATE_OBJECTS[k].triggers.length]),
    [[25, 0, 0], [26, 3, 4], [32, 9, 10]]);
  assert.deepEqual(T.MIGRATIONS, MIGS); assert.deepEqual(STATES.MIGRATION_PINS.map((p) => p.name), MIGS);
  assert.deepEqual([...T.STATE_OBJECTS.EXACT_G11.tables].sort(), [...G11_TABLES].sort());
});
test('G11-B08 catalogFromCopy locates the catalog columns by the COPY column list and refuses NULLs and missing blocks', () => {
  const text = dataText(undefined, { ...ROWS, ...CAT36 });
  const c = T.catalogFromCopy(text);
  assert.equal(c.ok, true); assert.equal(RBAC.classifyCatalog(c.catalog).catalog, 'CATALOG_36');
  const reordered = text.replace('COPY public."Role" (id, code, description)', 'COPY public."Role" (description, id, code)');
  assert.notEqual(RBAC.classifyCatalog(T.catalogFromCopy(reordered).catalog).catalog, 'CATALOG_36', 'columns located by name, not position');
  assert.equal(T.catalogFromCopy(text.replace('COPY public."RolePermission"', 'COPY public."RolePermissionX"')).ok, false);
  assert.equal(T.catalogFromCopy(text.replace('COPY public."Permission" (id, code, description)', 'COPY public."Permission" (id, description)')).ok, false);
});

// ---------------- A5-004 provenance inputs ----------------
for (const [name, now] of [['a day after the archive', new Date('2026-10-16T01:00:00Z')], ['ten minutes before the archive', new Date('2026-10-15T00:50:00Z')]]) {
  test(`F22 manifest time ${name} → refused`, async () => {
    const r = await run({ now }); assert.notEqual(r.rc, 0); assert.deepEqual(finals(r.listing), []);
  });
}
for (const [name, setup] of [
  ['missing', { macKey: null }], ['wrong length', { macKey: `${KEY.slice(1)}\n` }], ['uppercase', { macKey: `${KEY.toUpperCase()}\n` }],
]) {
  test(`F23 MAC key file ${name} → refused before pg_dump`, async () => {
    const r = await run({ home: buildHome(setup) }); assert.equal(r.rc, 3); assert.match(r.text, /phase=config/); assert.equal(r.calls.length, 0);
  });
}
test('F23 MAC key file symlink / mode 0644 → refused before pg_dump', async () => {
  const h1 = buildHome(); const k1 = path.join(h1, '.config/mona-jacinta/pilot-backup-mac-key');
  const real = path.join(h1, 'real-key'); put(real, `${KEY}\n`, 0o600); realFs.rmSync(k1); realFs.symlinkSync(real, k1);
  const r1 = await run({ home: h1 }); assert.equal(r1.rc, 3); assert.equal(r1.calls.length, 0);
  const h2 = buildHome(); realFs.chmodSync(path.join(h2, '.config/mona-jacinta/pilot-backup-mac-key'), 0o644);
  const r2 = await run({ home: h2 }); assert.equal(r2.rc, 3); assert.equal(r2.calls.length, 0);
});

// ---------------- A5-005 libpq environment ----------------
test('F24 pg_dump runs with a fresh, empty, private HOME that is removed afterwards; libpq files pinned inside it', async () => {
  const r = await run();
  assert.equal(r.rc, 0, r.text);
  const { options, homeState } = r.calls[0];
  const h = options.env.HOME;
  assert.notEqual(h, r.home); assert.equal(path.dirname(h), r.out); assert.ok(path.basename(h).startsWith('.'));
  assert.deepEqual(homeState, { dir: true, mode: 0o700, entries: [] }, 'existed, private and empty while pg_dump ran');
  assert.equal(realFs.existsSync(h), false, 'removed afterwards');
  for (const k of ['PGSSLCERT', 'PGSSLKEY', 'PGSSLCRL', 'PGSSLCRLDIR', 'PGPASSFILE', 'PGSERVICEFILE']) assert.equal(path.dirname(options.env[k]), h, k);
  assert.equal(options.env.PGSYSCONFDIR, h); assert.equal(options.env.PGSSLMODE, 'verify-full');
});
test('F25 contaminated passwd home (~/.postgresql, ~/.pgpass, ~/.pg_service.conf) is never referenced by the child', async () => {
  const home = buildHome();
  put(path.join(home, '.postgresql/postgresql.crt'), 'CERT', 0o600); put(path.join(home, '.postgresql/postgresql.key'), 'KEY', 0o600);
  put(path.join(home, '.pgpass'), '*:*:*:*:other', 0o600); put(path.join(home, '.pg_service.conf'), '[x]\nhost=evil', 0o600);
  const r = await run({ home });
  assert.equal(r.rc, 0, r.text);
  for (const [k, v] of Object.entries(r.calls[0].options.env)) assert.ok(!String(v).startsWith(home), `${k} must not point into the passwd home`);
});
test('F24 the private HOME is removed on failure paths too', async () => {
  const r = await run({ spawnOpts: { exitCode: 1 } });
  assert.equal(r.rc, 4); assert.deepEqual(r.listing, []);
});

// Mutation-driven additions (R2 mutants R10/R15/R16 survived): each case below is an otherwise EXACT S4 ledger
// with S4 objects, so only the specific ledger rule can refuse it.
for (const [name, extra] of [
  ['a failed attempt next to the applied row of the same migration', ledgerRow(MIGS[1], { finished: false, id: 'failed-attempt' })],
  ['an extra unknown migration', ledgerRow('20990101000000_evil', { checksum: 'c'.repeat(64), id: 'unknown' })],
  ['an extra malformed row', ledgerRow(MIGS[0], { steps: 'x', id: 'malformed' })],
]) {
  test(`F14b archive ledger exact S4 plus ${name} → refused, nothing published`, async () => {
    const r = await run({ pgOpts: withLedger([...S4_LEDGER, extra]) });
    assert.notEqual(r.rc, 0); assert.deepEqual(finals(r.listing), []); assert.match(r.text, /ledger/);
  });
}
test('G11-B09 the G11 table/function/trigger sets are exactly what the reviewed migrations create (derived from the SQL, not hand-copied)', () => {
  const sql = MIGS.map((m) => realFs.readFileSync(path.resolve(HERE, '..', '..', 'api/prisma/migrations', m, 'migration.sql'), 'utf8')).join('\n');
  const tables = [...sql.matchAll(/CREATE TABLE "([A-Za-z]+)"/g)].map((x) => x[1]);
  const functions = [...sql.matchAll(/CREATE (?:OR REPLACE )?FUNCTION (?:public\.)?"?([a-z_]+)"?\(\)/g)].map((x) => `${x[1]}()`);
  const triggers = [...sql.matchAll(/CREATE (?:CONSTRAINT )?TRIGGER "?([a-z_]+)"?[\s\S]*?\bON (?:public\.)?"([A-Za-z]+)"/g)].map((x) => `${x[2]} ${x[1]}`);
  assert.deepEqual([...new Set(tables), LEDGER].sort(), [...T.STATE_OBJECTS.EXACT_G11.tables].sort());
  assert.deepEqual([...new Set(functions)].sort(), [...T.STATE_OBJECTS.EXACT_G11.functions].sort());
  assert.deepEqual([...new Set(triggers)].sort(), [...T.STATE_OBJECTS.EXACT_G11.triggers].sort());
});
test('G11-B10 §6 drift matrix offline: missing table/function/trigger, unexpected app object, ledger drift and RBAC drift all refuse; nothing published', async () => {
  const no = async (o, label) => { const r = await run(o); assert.notEqual(r.rc, 0, label); assert.deepEqual(finals(r.listing), [], label); };
  await no({ state: 'EXACT_G11', pgOpts: { ...G11(), tocOpts: { tables: G11_TABLES.filter((t) => t !== 'ExternalCollection'), extra: [...FN_TRG, ...R3_FN_TRG] } } }, 'missing table');
  await no({ state: 'EXACT_G11', pgOpts: { ...G11(), tocOpts: { tables: G11_TABLES, extra: [...FN_TRG, ...R3_FN_TRG].filter((l) => !l.includes('fn_external_collection_guard')) } } }, 'missing function');
  await no({ state: 'EXACT_G11', pgOpts: { ...G11(), tocOpts: { tables: G11_TABLES, extra: [...FN_TRG, ...R3_FN_TRG].filter((l) => !l.includes('trg_checkout_attempt_guard ')) } } }, 'missing trigger');
  await no({ state: 'EXACT_G11', pgOpts: { ...G11(), tocOpts: { tables: [...G11_TABLES, 'Intruder'], extra: [...FN_TRG, ...R3_FN_TRG] } } }, 'unexpected app table');
  await no({ state: 'EXACT_G11', pgOpts: { ...G11(), tocOpts: { tables: G11_TABLES, extra: [...FN_TRG, ...R3_FN_TRG, '130; 1255 17040 FUNCTION public fn_backdoor() postgres'] } } }, 'unexpected app function');
  const drift = G11_LEDGER.map((row, i) => (i === 10 ? ledgerRow(MIGS[10], { checksum: 'e'.repeat(64) }) : row));
  await no({ state: 'EXACT_G11', pgOpts: { ...G11(), data: dataText(G11_TABLES, { ...ROWS, [LEDGER]: drift, ...CAT36 }) } }, 'ledger checksum drift');
  const rbacDrift = { ...CAT36, RolePermission: CAT36.RolePermission.slice(1) };
  await no({ state: 'EXACT_G11', pgOpts: { ...G11(), data: dataText(G11_TABLES, { ...ROWS, [LEDGER]: G11_LEDGER, ...rbacDrift }) } }, 'RBAC catalog drift');
});
