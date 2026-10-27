// Hermetic tests for pilot-g19-backup.mjs (the G19 sibling of pilot-backup.mjs). Fakes and temp fixtures only: synthetic project refs and
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
import * as T from './pilot-g19-backup.mjs';
import * as B14 from './pilot-backup.mjs';
import * as marker from './pilot-marker.mjs';
import * as GEN from './pilot-migration-generations.mjs';
import * as RBAC from './pilot-rbac-catalog.mjs';
import * as RBACG from './pilot-rbac-catalog-generations.mjs';
import * as REFS19 from './pilot-g19-schema-references.mjs';

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
const R3 = ['CheckoutAttempt', 'CheckoutAttemptDeclaration', 'CheckoutAttemptTender', 'ExternalCollection', 'SaleCheckout', 'SaleLineAllocation'];
const VOID_TABLES = ['SaleVoid', 'SaleVoidExternalRefund'];
const EXCH_TABLES = ['SaleExchange', 'SaleExchangeLine'];
const G16_TABLES = [...CORE, LEDGER, 'CompanyPricingConfig', ...R3, ...VOID_TABLES];
const G19_TABLES = [...G16_TABLES, ...EXCH_TABLES];
const MIGS = GEN.pinsOf('EXACT_G19').map((p) => p.name);
// The ledger checksum of each migration is the pinned SHA-256 of its reviewed migration.sql.
const MIG_SHA = Object.fromEntries(GEN.GENERATION_MIGRATION_PINS.map((p) => [p.name, p.sha256]));
const REPO_SHA = new Map(MIGS.map((m) => [`api/prisma/migrations/${m}/migration.sql`, MIG_SHA[m]]));
const LEDGER_COLS = 'id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count';
const ledgerRow = (m, { checksum = MIG_SHA[m], finished = true, rolledBack = false, steps = '1', id = `id-${m}` } = {}) => [id, checksum,
  finished ? '2026-09-27 03:00:00+00' : '\\N', m, '\\N', rolledBack ? '2026-09-27 03:01:00+00' : '\\N', '2026-09-27 02:59:00+00', steps];
const G14_LEDGER = MIGS.slice(0, 14).map((m) => ledgerRow(m));
const G16_LEDGER = MIGS.slice(0, 16).map((m) => ledgerRow(m));
const G17_LEDGER = MIGS.slice(0, 17).map((m) => ledgerRow(m));
const G18_LEDGER = MIGS.slice(0, 18).map((m) => ledgerRow(m));
const G19_LEDGER = MIGS.map((m) => ledgerRow(m));
const FN_TRG = ['95; 1255 17005 FUNCTION public fn_sale_payment_history() postgres', '96; 1255 17006 FUNCTION public fn_sale_payment_truncate_guard() postgres',
  '97; 1255 17007 FUNCTION public fn_sale_wholesale_frozen_after_payment() postgres',
  '98; 2620 17008 TRIGGER public SalePayment trg_sale_payment_history_before postgres', '99; 2620 17009 TRIGGER public SalePayment trg_sale_payment_history_after postgres',
  '100; 2620 17010 TRIGGER public SalePayment trg_sale_payment_truncate_guard postgres', '101; 2620 17011 TRIGGER public Sale trg_sale_wholesale_frozen_after_payment postgres'];
const R3_FN_TRG = ['110; 1255 17020 FUNCTION public fn_checkout_attempt_commit_check() postgres', '111; 1255 17021 FUNCTION public fn_checkout_attempt_declaration_guard() postgres',
  '112; 1255 17022 FUNCTION public fn_checkout_attempt_guard() postgres', '113; 1255 17023 FUNCTION public fn_checkout_attempt_tender_guard() postgres',
  '114; 1255 17024 FUNCTION public fn_checkout_declaration_commit_check() postgres', '115; 1255 17025 FUNCTION public fn_external_collection_guard() postgres',
  '116; 2620 17026 TRIGGER public CheckoutAttempt trg_checkout_attempt_commit_check postgres', '117; 2620 17027 TRIGGER public CheckoutAttempt trg_checkout_attempt_guard postgres',
  '118; 2620 17028 TRIGGER public CheckoutAttemptDeclaration trg_checkout_attempt_declaration_guard postgres',
  '119; 2620 17029 TRIGGER public CheckoutAttemptDeclaration trg_checkout_declaration_commit_check postgres',
  '120; 2620 17030 TRIGGER public CheckoutAttemptTender trg_checkout_attempt_tender_guard postgres', '121; 2620 17031 TRIGGER public ExternalCollection trg_external_collection_guard postgres'];
const VOID_FN_TRG = ['130; 1255 17040 FUNCTION public fn_cash_movement_refund_guard() postgres', '131; 1255 17041 FUNCTION public fn_sale_payment_refund_frozen() postgres',
  '132; 2620 17042 TRIGGER public CashMovement trg_cash_movement_refund_guard postgres', '133; 2620 17043 TRIGGER public SalePayment trg_sale_payment_refund_frozen postgres'];
const EXCH_FUNCTIONS = ['fn_sale_exchange_append_only', 'fn_sale_exchange_has_lines', 'fn_sale_exchange_header_guard', 'fn_sale_exchange_ledger_check',
  'fn_sale_exchange_line_remainder', 'fn_sale_exchange_void_guard', 'fn_sale_void_exchange_guard'];
const EXCH_TRIGGERS = [['SaleExchange', 'trg_sale_exchange_append_only'], ['SaleExchange', 'trg_sale_exchange_has_lines'], ['SaleExchange', 'trg_sale_exchange_header_guard'],
  ['SaleExchange', 'trg_sale_exchange_void_guard'], ['SaleExchangeLine', 'trg_sale_exchange_line_append_only'], ['SaleExchangeLine', 'trg_sale_exchange_line_ledger_check'],
  ['SaleExchangeLine', 'trg_sale_exchange_line_remainder'], ['SaleVoid', 'trg_sale_void_exchange_guard'], ['StockMovement', 'trg_stock_movement_sale_exchange_ledger_check'],
  ['StockMovement', 'trg_stock_movement_sale_exchange_no_delete'], ['StockMovement', 'trg_stock_movement_sale_exchange_no_update']];
const EXCH_FN_TRG = [...EXCH_FUNCTIONS.map((f, i) => `${140 + i}; 1255 ${17050 + i} FUNCTION public ${f}() postgres`),
  ...EXCH_TRIGGERS.map(([t, n], i) => `${160 + i}; 2620 ${17070 + i} TRIGGER public ${t} ${n} postgres`)];
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
const CAT37 = catalogRows(RBACG.CATALOG_37);
const CAT38 = catalogRows(RBACG.CATALOG_38);
const COLS = { Role: 'id, code, description', Permission: 'id, code, description', RolePermission: '"roleId", "permissionId"' };
// Synthetic generated references: both states pinned; the real G19 reference is pinned (tested against the real module below).
const SYN_REFS = { SCHEMA_REFERENCES_G19: { EXACT_G16: { digest: 'a'.repeat(64) }, EXACT_G17: { digest: null, pending: true }, EXACT_G18: { digest: null, pending: true }, EXACT_G19: { digest: 'f'.repeat(64) } } };


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
const ROWS = { Company: [['c1', 'Mona', '20-1-2', 'Calle 1', 't', '2026-09-27 03:38:00+00']], Sale: [['s2', 'x'], ['s1', 'y']], [LEDGER]: G16_LEDGER, ...CAT37 };
const qi = (t) => (/^[a-z_][a-z0-9_]*$/.test(t) ? t : `"${t}"`);
function dataText(tables = [...CORE, LEDGER], rows = ROWS) {
  const out = ['--', '-- PostgreSQL database dump', '--', '', '\\restrict k3y', "SELECT pg_catalog.set_config('search_path', '', false);", ''];
  for (const t of tables) out.push(`COPY public.${qi(t)} (${t === LEDGER ? LEDGER_COLS : (COLS[t] ?? '"id", "v"')}) FROM stdin;`, ...(rows[t] ?? []).map((r) => r.join('\t')), '\\.', '');
  out.push("SELECT pg_catalog.setval('public.\"x_seq\"', 1, false);", '\\unrestrict k3y', '');
  return out.join('\n');
}
const DDL = ['--', '-- PostgreSQL database dump', '--', '', '\\restrict k3y', "SELECT pg_catalog.set_config('search_path', '', false);", '',
  'CREATE TABLE public."Sale" (id text NOT NULL);', '', '\\unrestrict k3y', ''].join('\n');
// Exact-state pg_restore options: the TOC objects and COPY data of each state (catalog per argument).
const G16 = (o = {}) => ({ tocOpts: { tables: G16_TABLES, extra: [...FN_TRG, ...R3_FN_TRG, ...VOID_FN_TRG] }, data: dataText(G16_TABLES, { ...ROWS, [LEDGER]: o.ledger ?? G16_LEDGER, ...(o.catalog ?? CAT37) }) });
const G19 = (o = {}) => ({ tocOpts: { tables: G19_TABLES, extra: [...FN_TRG, ...R3_FN_TRG, ...VOID_FN_TRG, ...EXCH_FN_TRG] }, data: dataText(G19_TABLES, { ...ROWS, [LEDGER]: o.ledger ?? G19_LEDGER, ...(o.catalog ?? CAT38) }) });
const fakePgRestore = (o = {}) => (kind) => {
  o.hook?.(kind);
  if (kind === 'list') return { status: 0, stdout: o.toc ?? tocText(o.tocOpts) };
  if (kind === 'marker') return { status: 0, stdout: o.copy ?? markerCopy(o.copyOpts) };
  if (kind === 'data') return { status: 0, stdout: o.data ?? dataText(o.tocOpts?.tables) };
  if (kind === 'ddl') return { status: 0, stdout: o.ddl ?? DDL };
  throw new Error(`unexpected pg_restore kind ${kind}`);
};

async function run({ argv, state = 'EXACT_G16', references = SYN_REFS, importShared, defaultPg = true, home = buildHome(), out = buildOut(), env, spawnOpts = {}, pgOpts = {}, statfs, forbiddenRoots, verifyManifest, fsWrap, now = new Date('2026-10-15T01:02:03Z'), hex = 'abcdef0123456789abcdef0123456789', timeoutMs = 2000, killGraceMs = 20 } = {}) {
  const outLines = [];
  let imports = 0;
  const fake = fakeSpawnFactory(spawnOpts);
  const deps = {
    env: env ?? { HOME: home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, homedir: home, uid: process.getuid(), execArgv: [], version: 'v24.20.0',
    root: path.resolve(HERE, '..', '..'), fs: fsWrap ? fsWrap(realFs) : realFs,
    verifyManifest: verifyManifest ?? (() => ({ ok: true, repoSha: REPO_SHA })),
    importMarker: async () => { imports += 1; return marker; },
    importShared: importShared ?? (async () => T.adaptShared({ generations: GEN, references, rbac: RBACG })),
    spawn: fake.spawn, pgRestore: fakePgRestore(defaultPg && Object.keys(pgOpts).length === 0 ? (state === 'EXACT_G19' ? G19() : G16()) : pgOpts),
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

const NAMES = T.artifactNames({ now: new Date('2026-10-15T01:02:03Z'), hex: 'abcdef01' });
const manifestOf = (r) => T.parseDumpManifest(realFs.readFileSync(path.join(r.out, NAMES.manifest)));
const REAL_SHARED = async () => T.adaptShared({ generations: GEN, references: REFS19, rbac: RBACG });

// ---------------- arguments, gates ----------------
for (const argv of [[], ['--target=pilot'], ['--target=pilot', '--execute'], ['--target=test', '--execute', '--output-dir=/x', '--expected-state=EXACT_G16'],
  ['--target=pilot', '--execute', '--output-dir=relative', '--expected-state=EXACT_G16'], ['--target=pilot', '--execute', '--dry-run', '--output-dir=/x', '--expected-state=EXACT_G16'],
  ['--target=pilot', '--execute', '--output-dir=/x', '--expected-state=EXACT_G16', '--sql=1'], ['--target=pilot', '--execute', '--output-dir=/x', '--expected-state=EXACT_G16', '--expected-state=EXACT_G19'],
  ...['EXACT_S4', 'EXACT_G7', 'EXACT_G11', 'EXACT_G14', 'EXACT_G15', 'EXACT_G17', 'EXACT_G18', 'EXACT_G20', 'G19', ''].map((s) => ['--target=pilot', '--execute', '--output-dir=/x', `--expected-state=${s}`])]) {
  test(`G19BK args refused: ${JSON.stringify(argv)}`, async () => {
    const r = await run({ argv }); assert.equal(r.rc, 1); assert.match(r.text, /phase=args/); assert.equal(r.calls.length, 0); assert.equal(r.last, 'A5B_RESULT=REFUSED');
  });
}
test('G19BK the two states are the only ones: EXACT_G16 and EXACT_G19 (the G14-era tool keeps its own six, untouched)', () => {
  assert.deepEqual([...T.BACKUP_STATES], ['EXACT_G16', 'EXACT_G19']);
  assert.deepEqual([...B14.BACKUP_STATES], ['EXACT_S4', 'EXACT_G7', 'EXACT_G11', 'EXACT_G12', 'EXACT_G13', 'EXACT_G14']);
  assert.equal(T.MAC_KEY_FILE, B14.MAC_KEY_FILE, 'the OWNER key file is the same; the MAC domain is not');
});
for (const extra of ['PGHOST', 'PGPORT', 'PGUSER', 'PGDATABASE', 'PGSERVICE', 'PGOPTIONS', 'NODE_OPTIONS']) {
  test(`G19BK parent env with ${extra} → refused before anything`, async () => {
    const home = buildHome();
    const r = await run({ home, env: { HOME: home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', [extra]: 'x' } });
    assert.equal(r.rc, 3); assert.match(r.text, /phase=env/); assert.equal(r.imports, 0); assert.equal(r.calls.length, 0);
  });
}
test('G19BK integrity failure → refused before pilot-marker is imported', async () => {
  const r = await run({ verifyManifest: () => ({ ok: false, reason: 'x' }) });
  assert.equal(r.rc, 3); assert.match(r.text, /phase=integrity/); assert.equal(r.imports, 0); assert.equal(r.calls.length, 0);
});
for (const [name, url] of [['forbidden ref 1', urlFor({ user: `postgres.${FORBIDDEN[0]}` })], ['forbidden ref 3', urlFor({ user: `postgres.${FORBIDDEN[2]}` })],
  ['unknown ref', urlFor({ user: 'postgres.uuuuvvvvwwwwxxxxyyyy' })], ['host outside contract', urlFor({ host: 'evil.example.com' })], ['port 6543', urlFor({ port: 6543 })]]) {
  test(`G19BK ${name} → refused before spawn, no identity leak`, async () => {
    const r = await run({ home: buildHome({ url }) });
    assert.equal(r.rc, 3); assert.match(r.text, /phase=(target|config)/); assert.equal(r.calls.length, 0); assert.deepEqual(leaks(r.text), []);
  });
}
test('G19BK output dir mode 0750 and insufficient free space → refused before spawn', async () => {
  const a = await run({ out: buildOut(0o750) }); assert.equal(a.rc, 3); assert.match(a.text, /phase=output/); assert.equal(a.calls.length, 0);
  const b = await run({ statfs: () => ({ bavail: 10n, bsize: 4096n }) }); assert.equal(b.rc, 3); assert.equal(b.calls.length, 0);
});

// ---------------- the reference gate (a pending reference is refused) ----------------
test('G19BK the REAL references are pinned for both states: the reference gate passes; a reference that is pending (null) is refused at that gate before any key, URL, marker or process', async () => {
  const out = buildOut();
  for (const state of ['EXACT_G16', 'EXACT_G19']) {
    const ok = await run({ importShared: REAL_SHARED, out, argv: ['--target=pilot', '--dry-run', `--output-dir=${out}`, `--expected-state=${state}`] });
    assert.equal(ok.rc, 0, ok.text); assert.equal(ok.last, 'A5B_RESULT=DRY_RUN_OK'); assert.match(ok.text, new RegExp(`expected state ${state}`));
  }
  const pendingShared = async () => T.adaptShared({ generations: GEN, rbac: RBACG,
    references: { SCHEMA_REFERENCES_G19: { ...REFS19.SCHEMA_REFERENCES_G19, EXACT_G19: { digest: null, pending: true } } } });
  const pending = await run({ importShared: pendingShared, out, argv: ['--target=pilot', '--dry-run', `--output-dir=${out}`, '--expected-state=EXACT_G19'] });
  assert.equal(pending.rc, 3, pending.text);
  assert.match(pending.text, /phase=reference/); assert.match(pending.text, /PENDING/);
  assert.equal(pending.calls.length, 0); assert.equal(pending.last, 'A5B_RESULT=REFUSED'); assert.deepEqual(pending.listing, []);
});
test('G19BK dry-run with pinned references performs every gate and spawns nothing', async () => {
  const out = buildOut();
  const r = await run({ out, argv: ['--target=pilot', '--dry-run', `--output-dir=${out}`, '--expected-state=EXACT_G19'] });
  assert.equal(r.rc, 0); assert.equal(r.last, 'A5B_RESULT=DRY_RUN_OK'); assert.equal(r.calls.length, 0); assert.deepEqual(r.listing, []);
});

// ---------------- pg_dump invocation ----------------
test('G19BK pg_dump: absolute binary, connection only through an allowlisted child env, nothing secret in argv', async () => {
  const r = await run();
  assert.equal(r.calls.length, 1);
  const { file, args, options } = r.calls[0];
  assert.equal(file, '/usr/lib/postgresql/17/bin/pg_dump');
  const fileArg = args.find((a) => a.startsWith('--file='));
  assert.deepEqual(args.filter((a) => a !== fileArg), ['--format=custom', '--schema=public', '--schema=mona_pilot_guard', '--no-owner', '--no-privileges', '--no-password', '--lock-wait-timeout=30s']);
  assert.deepEqual(leaks(args.join(' ')), []);
  assert.equal(options.env.PGAPPNAME, 'mona-pilot-g19-backup');
  assert.equal(options.env.PGSSLMODE, 'verify-full'); assert.equal(options.env.PGPASSWORD, PW);
});

// ---------------- happy paths ----------------
for (const [state, tables, ledger, catalog, refDigest0, pg] of [
  ['EXACT_G16', G16_TABLES, 'EXACT_G16', 'CATALOG_37', 'a'.repeat(64), G16()],
  ['EXACT_G16', G16_TABLES, 'EXACT_G16', 'CATALOG_36', 'a'.repeat(64), G16({ catalog: CAT36 })],
  ['EXACT_G19', G19_TABLES, 'EXACT_G19', 'CATALOG_38', 'f'.repeat(64), G19()],
  ['EXACT_G19', G19_TABLES, 'EXACT_G19', 'CATALOG_37', 'f'.repeat(64), G19({ catalog: CAT37 })],
]) {
  test(`G19BK ${state} + ${catalog}: verified archive and canonical manifest published 0600, MAC over the G19 domain, nothing secret`, async () => {
    const r = await run({ state, pgOpts: pg });
    assert.equal(r.rc, 0, r.text); assert.equal(r.last, 'A5B_RESULT=VERIFIED');
    assert.deepEqual(r.listing, [NAMES.dump, NAMES.manifest].sort());
    for (const n of r.listing) assert.equal(realFs.statSync(path.join(r.out, n)).mode & 0o777, 0o600);
    const mBytes = realFs.readFileSync(path.join(r.out, NAMES.manifest));
    const parsed = T.parseDumpManifest(mBytes);
    assert.equal(parsed.ok, true, parsed.reason);
    const m = parsed.manifest;
    assert.equal(m.format, 'mona-pilot-backup-g19/v1');
    assert.equal(m.ledgerState, ledger);
    assert.equal(m.rbacCatalog.catalog, catalog);
    assert.deepEqual(Object.keys(m.tables), [...tables].sort());
    assert.equal(m.schemaReferenceDigest, refDigest0);
    assert.equal(m.archive.sha256, sha(realFs.readFileSync(path.join(r.out, NAMES.dump))));
    const { mac, format, ...rest } = m;
    assert.equal(mac, createHmac('sha256', Buffer.from(KEY, 'hex')).update(`mona-pilot-backup-g19/v1 mac\n${T.canonicalManifestBody(rest)}`).digest('hex'));
    assert.equal(T.verifyManifestMac(KEY, m), true);
    assert.equal(B14.verifyManifestMac(KEY, m), false, 'a G19 manifest never verifies as a G14 one');
    assert.deepEqual(leaks(mBytes.toString()), []); assert.deepEqual(leaks(r.text), []); assert.ok(!mBytes.toString().includes(KEY));
  });
}

// ---------------- the exact-state contract: every mismatch is refused, nothing published ----------------
const refusals = [
  ['G16 expected, G19 archive (exchange tables are outside the G16 set)', 'EXACT_G16', G19(), /outside the EXACT_G16 set|outside the EXACT_G16 allowlist/],
  ['G19 expected, G16 archive (exchange tables missing)', 'EXACT_G19', G16(), /does not contain table SaleExchange|lacks app functions/],
  ['G19 expected, G16 ledger inside a G19 archive', 'EXACT_G19', G19({ ledger: G16_LEDGER }), /ledger/],
  ['G19 expected, G17 ledger (intermediate)', 'EXACT_G19', G19({ ledger: G17_LEDGER }), /ledger/],
  ['G19 expected, G18 ledger (intermediate)', 'EXACT_G19', G19({ ledger: G18_LEDGER }), /ledger/],
  ['G16 expected, G17 ledger', 'EXACT_G16', G16({ ledger: G17_LEDGER }), /ledger/],
  ['G16 expected, G14 ledger', 'EXACT_G16', G16({ ledger: G14_LEDGER }), /ledger/],
  ['G19 expected, one altered checksum', 'EXACT_G19', G19({ ledger: G19_LEDGER.map((row, i) => (i === 18 ? [row[0], sha('tampered'), ...row.slice(2)] : row)) }), /ledger/],
  ['G19 expected, a rolled-back migration', 'EXACT_G19', G19({ ledger: G19_LEDGER.map((row, i) => (i === 17 ? ledgerRow(MIGS[17], { rolledBack: true }) : row)) }), /ledger/],
  ['G19 expected, CATALOG_36', 'EXACT_G19', G19({ catalog: CAT36 }), /requires CATALOG_37 or CATALOG_38/],
  ['G16 expected, CATALOG_38 (catalog ahead of the schema)', 'EXACT_G16', G16({ catalog: CAT38 }), /requires CATALOG_36 or CATALOG_37/],
  ['G16 expected, CATALOG_35', 'EXACT_G16', G16({ catalog: CAT35 }), /rbac/],
  ['G19 expected, a missing exchange function', 'EXACT_G19', { ...G19(), tocOpts: { ...G19().tocOpts, extra: G19().tocOpts.extra.filter((l) => !l.includes('fn_sale_exchange_void_guard')) } }, /lacks app functions\/triggers/],
  ['G19 expected, a missing void-exchange trigger', 'EXACT_G19', { ...G19(), tocOpts: { ...G19().tocOpts, extra: G19().tocOpts.extra.filter((l) => !l.includes('trg_sale_void_exchange_guard')) } }, /lacks app functions\/triggers/],
  ['G19 expected, an unknown trigger on SaleExchange', 'EXACT_G19', { ...G19(), tocOpts: { ...G19().tocOpts, extra: [...G19().tocOpts.extra, '199; 2620 17999 TRIGGER public SaleExchange evil_trg postgres'] } }, /outside the EXACT_G19 allowlist/],
  ['G19 expected, an unknown function', 'EXACT_G19', { ...G19(), tocOpts: { ...G19().tocOpts, extra: [...G19().tocOpts.extra, '198; 1255 17998 FUNCTION public evil() postgres'] } }, /outside the EXACT_G19 allowlist/],
  ['G19 expected, SaleExchange data missing', 'EXACT_G19', { ...G19(), tocOpts: { ...G19().tocOpts, dropData: ['SaleExchange'] } }, /table data for SaleExchange/],
];
for (const [name, state, pgOpts, pattern] of refusals) {
  test(`G19BK ${name} → refused, nothing published`, async () => {
    const r = await run({ state, pgOpts });
    assert.notEqual(r.rc, 0, r.text); assert.deepEqual(r.listing, []); assert.match(r.text, pattern);
  });
}

// ---------------- manifest strictness and isolation ----------------
const goodFields = () => ({ setId: 'abcdef01-0000-4000-8000-000000000000', createdAt: '2026-10-15T01:02:03.000Z', toolSha256: 'a'.repeat(64),
  pgDumpVersion: '17.11', serverVersion: '17.4', archive: { file: 'pilot_x.dump', bytes: 10, sha256: 'b'.repeat(64) }, tocSha256: 'c'.repeat(64),
  schemas: ['mona_pilot_guard', 'public'], tables: { Sale: { rows: 2, copySha256: 'f'.repeat(64) } }, refDigest: 'd'.repeat(64), markerIdDigest: 'e'.repeat(64),
  ledgerState: 'EXACT_G19', rbacCatalog: { catalog: 'CATALOG_38', digest: '8'.repeat(64), permissions: 38, grants: 77 }, schemaReferenceDigest: '7'.repeat(64), mac: '9'.repeat(64) });
test('G19BK parseDumpManifest is strict and closed to the two states and their catalogs', () => {
  const good = T.buildDumpManifest(goodFields());
  assert.equal(T.parseDumpManifest(Buffer.from(good)).ok, true);
  assert.equal(B14.parseDumpManifest(Buffer.from(good)).ok, false, 'the G14 parser refuses a G19 manifest');
  const swap = (a, b) => Buffer.from(good.replace(a, b));
  assert.equal(T.parseDumpManifest(swap('mona-pilot-backup-g19/v1', 'mona-pilot-backup/v2')).ok, false, 'a G14 format never parses here');
  for (const state of ['EXACT_G14', 'EXACT_G17', 'EXACT_G18', 'EXACT_S4', 'PARTIAL']) assert.equal(T.parseDumpManifest(swap('"EXACT_G19"', `"${state}"`)).ok, false, state);
  assert.equal(T.parseDumpManifest(swap('CATALOG_38', 'CATALOG_36')).ok, false, 'G19 with CATALOG_36');
  assert.equal(T.parseDumpManifest(Buffer.from(good.replace('"EXACT_G19"', '"EXACT_G16"').replace('CATALOG_38', 'CATALOG_36'))).ok, true, 'G16 with CATALOG_36');
  assert.equal(T.parseDumpManifest(swap('"EXACT_G19"', '"EXACT_G16"')).ok, false, 'G16 with CATALOG_38');
  assert.equal(T.parseDumpManifest(Buffer.from(JSON.stringify({ ...JSON.parse(good), extra: 1 }) + '\n')).ok, false);
  assert.equal(T.parseDumpManifest(Buffer.from(JSON.stringify(JSON.parse(good), null, 2) + '\n')).ok, false, 'non-canonical');
});

// ---------------- the constants are the reviewed ones ----------------
test('G19BK STATE_OBJECTS equal hand-written sets (G16 = G14 + sale void; G19 = G16 + sale exchange)', () => {
  assert.deepEqual([...T.STATE_OBJECTS.EXACT_G16.tables], [...G16_TABLES].sort());
  assert.deepEqual([...T.STATE_OBJECTS.EXACT_G19.tables], [...G19_TABLES].sort());
  const fnNames = (lines) => lines.filter((l) => l.includes(' FUNCTION ')).map((l) => l.split(' ')[5]).sort();
  assert.deepEqual([...T.STATE_OBJECTS.EXACT_G19.functions], [...fnNames([...FN_TRG, ...R3_FN_TRG, ...VOID_FN_TRG, ...EXCH_FN_TRG])]);
  assert.deepEqual([...T.STATE_OBJECTS.EXACT_G16.functions], [...fnNames([...FN_TRG, ...R3_FN_TRG, ...VOID_FN_TRG])]);
  assert.equal(T.STATE_OBJECTS.EXACT_G19.triggers.length, 4 + 6 + 2 + 11);
  assert.deepEqual([...T.STATE_OBJECTS.EXACT_G16.catalogs], ['CATALOG_36', 'CATALOG_37']);
  assert.deepEqual([...T.STATE_OBJECTS.EXACT_G19.catalogs], ['CATALOG_37', 'CATALOG_38']);
});
test('G19BK MIGRATIONS are the nineteen of pilot-migration-generations.mjs and every required repo file exists on disk', () => {
  assert.deepEqual([...T.MIGRATIONS], GEN.GENERATIONS.EXACT_G19);
  assert.equal(T.MIGRATIONS.length, 19);
  const root = path.resolve(HERE, '..', '..');
  for (const rel of T.REQUIRED_REPO_FILES) assert.ok(realFs.existsSync(path.join(root, rel)), rel);
  for (const needed of ['scripts/database/pilot-g19-launch-command.mjs', 'scripts/database/pilot-launch-command.mjs', 'scripts/database/pilot-g19-schema-references.mjs',
    'scripts/database/pilot-g16-schema-references.mjs', 'scripts/database/pilot-rbac-catalog-generations.mjs', 'scripts/database/pilot-rbac-catalog.mjs',
    'scripts/database/pilot-migration-generations.mjs', 'scripts/database/pilot-migration-states.mjs', 'scripts/database/pilot-schema-references.mjs']) {
    assert.ok(T.REQUIRED_REPO_FILES.includes(needed), needed);
  }
  assert.ok(!T.REQUIRED_REPO_FILES.includes('scripts/database/pilot-backup.mjs'), 'the G14 tool is not part of this tool identity');
});
test('G19BK adaptShared builds exactly the shape verifyArchiveBytes consumes, from the generation modules', () => {
  const shared = T.adaptShared({ generations: GEN, references: REFS19, rbac: RBACG });
  assert.equal(shared.states.requireState(G19_LEDGER.map((r) => ({ migration_name: r[3], checksum: r[1], finished: true, rolled_back: false })), 'EXACT_G19').ok, true);
  assert.equal(shared.states.requireState([], 'EXACT_G19').ok, false);
  assert.match(shared.references.SCHEMA_REFERENCES.EXACT_G19.digest, /^[0-9a-f]{64}$/);
  assert.equal(shared.rbac.classifyCatalog({ roles: [], permissions: [], grants: [] }).ok, false);
});

// ---------------- failures ----------------
test('G19BK pg_dump timeout → SIGTERM then SIGKILL, temp removed, ERROR', async () => {
  const r = await run({ spawnOpts: { hang: true, ignoreTerm: true }, timeoutMs: 30, killGraceMs: 20 });
  assert.equal(r.rc, 4); assert.equal(r.last, 'A5B_RESULT=ERROR'); assert.deepEqual(r.calls[0].child.kills, ['SIGTERM', 'SIGKILL']); assert.deepEqual(r.listing, []);
});
test('G19BK pg_dump failure with secrets in stderr → only a fixed code, nothing persisted', async () => {
  const r = await run({ spawnOpts: { exitCode: 1, stderr: `connection to ${POOLER} user postgres.${REF} password ${PW} failed` } });
  assert.equal(r.rc, 4); assert.deepEqual(leaks(r.text), []); assert.deepEqual(r.listing, []);
});
test('G19BK marker in archive of another id → identity refused (exit 2), nothing published, ids never printed', async () => {
  const r = await run({ pgOpts: { ...G16(), copyOpts: { rows: [['t', 'pilot', OTHER, '2026-09-27 03:38:00+00']] } } });
  assert.equal(r.rc, 2); assert.deepEqual(r.listing, []); assert.ok(!r.text.includes(MID)); assert.ok(!r.text.includes(OTHER));
});
test('G19BK final name collision → refused, existing file untouched', async () => {
  const out = buildOut();
  put(path.join(out, NAMES.dump), 'EXISTING', 0o600);
  const r = await run({ out });
  assert.equal(r.rc, 5); assert.equal(realFs.readFileSync(path.join(out, NAMES.dump), 'utf8'), 'EXISTING'); assert.ok(!r.listing.includes(NAMES.manifest));
});
