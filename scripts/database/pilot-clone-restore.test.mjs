// Hermetic tests for pilot-clone-restore.mjs. A fake world stands in for initdb, pg_ctl, pg_restore,
// pg_dump and the pg client: no process is started, no socket opened, no database touched.
// Real PostgreSQL coverage lives in pilot-clone-restore.itest.mjs (synthetic data, isolated cluster).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as realFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as C from './pilot-clone-restore.mjs';
import * as B from './pilot-backup.mjs';
import * as STATES from './pilot-migration-states.mjs';
import * as RBAC from './pilot-rbac-catalog.mjs';
import * as P from './app-schema-projection.mjs';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const tmpRoots = [];
const mkTmp = () => { const d = realFs.mkdtempSync(path.join(os.tmpdir(), 'pcr-')); tmpRoots.push(d); return d; };
process.on('exit', () => { for (const d of tmpRoots) realFs.rmSync(d, { recursive: true, force: true }); });

const PG = '/usr/lib/postgresql/17/bin';
const CORE = ['AuditLog', 'Branch', 'Brand', 'CashMovement', 'CashRegister', 'CashSession', 'Category', 'Company', 'Inventory', 'Location',
  'Permission', 'Product', 'ProductVariant', 'Role', 'RolePermission', 'Sale', 'SaleItem', 'SaleNumberCounter', 'SalePayment',
  'StockMovement', 'StockReservation', 'User', 'UserBranchRole', 'UserRoleScope'];
const LEDGER = '_prisma_migrations';
const TABLES = [...CORE, LEDGER];
const R3 = ['CheckoutAttempt', 'CheckoutAttemptDeclaration', 'CheckoutAttemptTender', 'ExternalCollection', 'SaleCheckout', 'SaleLineAllocation'];
const G11_TABLES = [...TABLES, 'CompanyPricingConfig', ...R3];
const MIGS = ['20260907015311_init', '20260912182432_add_company_location', '20260912191702_add_user_role_scope',
  '20260922210000_d3_initial_stock_and_global_audit', '20261002120000_block1_pricing_wholesale', '20261006120000_pilot_pricing_v2',
  '20261012120000_cash_session_reconciliation', '20261016120000_r3_proportional_checkout', '20261016130000_r3_checkout_attempts',
  '20261018120000_cash_movement_withdrawals_expenses', '20261018180000_cash_movement_reversals'];
const MIG_SHA = Object.fromEntries(STATES.MIGRATION_PINS.map((p) => [p.name, p.sha256]));
const SECRET = 'S3cretPw-in-stderr';
const KEY = '0123456789abcdef'.repeat(4);
const MID = '11111111-1111-4111-8111-111111111111';
const PB_SHA = sha('fixture pilot-backup.mjs');
const LEDGER_COLS = 'id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count';
const ledgerRow = (m, { checksum = MIG_SHA[m], finished = true, rolledBack = false, steps = '1', id = `id-${m}` } = {}) => [id, checksum,
  finished ? '2026-09-27 03:00:00+00' : '\\N', m, '\\N', rolledBack ? '2026-09-27 03:01:00+00' : '\\N', '2026-09-27 02:59:00+00', steps];
const COLS = { Role: 'id, code, description', Permission: 'id, code, description', RolePermission: '"roleId", "permissionId"' };
const hdr = (t) => (t === LEDGER ? LEDGER_COLS : (COLS[t] ?? '"id", "v"'));
function catalogRows(def) {
  const roleId = new Map(def.roles.map(([c, id]) => [c, id])); const permId = new Map(def.permissions.map(([c, id]) => [c, id]));
  return {
    Role: def.roles.map(([c, id]) => [id, c, 'desc']), Permission: def.permissions.map(([c, id]) => [id, c, 'desc']),
    RolePermission: def.grants.map(([r, pm]) => [roleId.get(r), permId.get(pm)]),
  };
}
const CAT35 = catalogRows(RBAC.CATALOG_35);
const CAT36 = catalogRows(RBAC.CATALOG_36);
// The restored catalog as the clone's CATALOG_SQL returns it.
const dbCatalog = (rows) => ({ roles: rows.Role.map(([id, code]) => ({ id, code })), permissions: rows.Permission.map(([id, code]) => ({ id, code })),
  grants: rows.RolePermission.map(([roleId, permissionId]) => ({ roleId, permissionId })) });
// A synthetic app-schema projection as the raw-text pg client returns it ('t'/'f' booleans), its digest, and synthetic probes.
const SYN_RAW = {
  tables: [{ table: 'Sale' }], columns: [{ table: 'Sale', column: 'id', type: 'text', not_null: 't', default_expr: null, identity: '', generated: '' }],
  enums: [], types: [], constraints: [{ table: 'Sale', name: 'Sale_pkey', type: 'p', definition: 'PRIMARY KEY (id)', validated: 't' }],
  indexes: [{ table: 'Sale', name: 'Sale_pkey', definition: 'CREATE UNIQUE INDEX "Sale_pkey" ON public."Sale" USING btree (id)', valid: 't' }],
  functions: [], triggers: [],
};
const asBool = (raw) => JSON.parse(JSON.stringify(raw), (k, v) => (['not_null', 'validated', 'valid'].includes(k) ? v === 't' : v));
const SYN_DIGEST = P.projectionDigest(P.buildProjection(asBool(SYN_RAW)));
const SYN_PROBES = { EXACT_S4: [{ kind: 'table', name: 'Sale' }], EXACT_G7: [{ kind: 'table', name: 'Sale' }], EXACT_G11: [{ kind: 'constraint', table: 'Sale', name: 'Sale_pkey', type: 'p' }] };
const SYN_REFS = { SCHEMA_REFERENCES: { EXACT_S4: { digest: SYN_DIGEST }, EXACT_G7: { digest: SYN_DIGEST }, EXACT_G11: { digest: SYN_DIGEST } }, STATE_PROBES: SYN_PROBES };
const SHARED = { states: STATES, references: SYN_REFS, rbac: RBAC, projection: P };
const INVARIANTS_OK = { open_sessions: '0', registers_multi_open: '0', session_close_mismatch: '0', orphan_movements: '0', orphan_payment_sessions: '0',
  sale_total_mismatch: '0', paid_payment_mismatch: '0' };
// The DB ledger as the clone's SQL returns it (raw text for every type).
const dbLedger = (rows) => rows.map((r) => ({ migration_name: r[3], checksum: r[1], finished: r[2] !== '\\N' ? 't' : 'f', rolled_back: r[5] !== '\\N' ? 't' : 'f', applied_steps_count: r[7] }));
const markerCopy = ({ env = 'pilot', id = MID } = {}) => ['COPY mona_pilot_guard.database_identity (singleton, environment, marker_id, installed_at) FROM stdin;',
  `t\t${env}\t${id}\t2026-09-27 03:38:00.123+00`, '\\.', ''].join('\n');

// ---- the synthetic "database" a run would contain ----
const baseRows = () => ({
  Company: [['c1', 'Mona', 't']],
  Sale: [['s2', 'x'], ['s1', 'y']],
  [LEDGER]: MIGS.slice(0, 4).map((m) => ledgerRow(m)),
  ...CAT35,
});
const g11Rows = () => ({ ...baseRows(), [LEDGER]: MIGS.map((m) => ledgerRow(m)), ...CAT36 });
const G11_FN_TRG = [
  ...['fn_sale_payment_history()', 'fn_sale_payment_truncate_guard()', 'fn_sale_wholesale_frozen_after_payment()', 'fn_checkout_attempt_commit_check()',
    'fn_checkout_attempt_declaration_guard()', 'fn_checkout_attempt_guard()', 'fn_checkout_attempt_tender_guard()', 'fn_checkout_declaration_commit_check()',
    'fn_external_collection_guard()'].map((f, i) => `${200 + i}; 1255 9 FUNCTION public ${f} postgres`),
  ...['SalePayment trg_sale_payment_history_before', 'SalePayment trg_sale_payment_history_after', 'SalePayment trg_sale_payment_truncate_guard',
    'Sale trg_sale_wholesale_frozen_after_payment', 'CheckoutAttempt trg_checkout_attempt_commit_check', 'CheckoutAttempt trg_checkout_attempt_guard',
    'CheckoutAttemptDeclaration trg_checkout_attempt_declaration_guard', 'CheckoutAttemptDeclaration trg_checkout_declaration_commit_check',
    'CheckoutAttemptTender trg_checkout_attempt_tender_guard', 'ExternalCollection trg_external_collection_guard'].map((t, i) => `${220 + i}; 2620 9 TRIGGER public ${t} postgres`),
];
const qi = (t) => (/^[a-z_][a-z0-9_]*$/.test(t) ? t : `"${t}"`);
function dataText(rows, tables = TABLES) {
  const out = ['--', '\\restrict k3y', "SELECT pg_catalog.set_config('search_path', '', false);", ''];
  for (const t of tables) out.push(`COPY public.${qi(t)} (${hdr(t)}) FROM stdin;`, ...(rows[t] ?? []).map((r) => r.join('\t')), '\\.', '');
  out.push('\\unrestrict k3y', '');
  return out.join('\n');
}
// Independent formula: SHA-256 over the column list, LF, then the COPY lines sorted bytewise and LF-joined.
const copySha = (rowsOf, t) => sha(`${hdr(t)}\n${(rowsOf ?? []).map((r) => r.join('\t')).sort().join('\n')}`);
function tocText({ extra = [], tables = TABLES, guard = true } = {}) {
  const l = [';', '; Archive created at 2026-10-15 01:00:00 UTC', ';     dbname: postgres', ';     Format: CUSTOM',
    ';     Dumped from database version: 17.4', ';     Dumped by pg_dump version: 17.11 (Debian 17.11-0+deb13u1)', ';', '; Selected TOC Entries:', ';'];
  let id = 10;
  if (guard) l.push(`${id++}; 2615 1 SCHEMA - mona_pilot_guard postgres`);
  for (const t of tables) l.push(`${id++}; 1259 2 TABLE public ${t} postgres`);
  if (guard) l.push(`${id++}; 1259 3 TABLE mona_pilot_guard database_identity postgres`);
  for (const t of tables) l.push(`${id++}; 0 4 TABLE DATA public ${t} postgres`);
  if (guard) l.push(`${id++}; 0 5 TABLE DATA mona_pilot_guard database_identity postgres`);
  l.push(...extra);
  return `${l.join('\n')}\n`;
}
const DDL = (() => {
  const out = ['--', '-- PostgreSQL database dump', '--', '', '\\restrict k3y', "SELECT pg_catalog.set_config('search_path', '', false);", ''];

  // Required enum types (from migrations)
  const enums = [
    'SaleStatus', 'StockMovementType', 'StockReservationStatus', 'PaymentMethod',
    'CashSessionStatus', 'CashMovementType', 'LocationType', 'ScopeKind',
    'PriceType', 'CustomerPriceMode'
  ];
  for (const e of enums) {
    out.push(`CREATE TYPE public.${e} AS ENUM ('a', 'b');`);
  }

  for (const t of TABLES) {
    out.push(`CREATE TABLE public.${qi(t)} (id text PRIMARY KEY, v text);`);
  }

  // Indexes and FKs from TOC
  out.push('CREATE INDEX public."Sale_branchId_idx" ON public."Sale" (id);');
  out.push('ALTER TABLE public."Sale" ADD CONSTRAINT "Sale_branchId_fkey" FOREIGN KEY (id) REFERENCES public."Branch" (id);');

  out.push('\\unrestrict k3y', '');
  return out.join('\n');
})();

function fixture({ rows = baseRows(), tables = TABLES, toc = tocText({ tables }), manifestMutate, archiveBytes = Buffer.from('PGDMP\u0001fixture-archive-bytes'), workName = 'clones',
  key = KEY, ledgerState = 'EXACT_S4', catalog = 'CATALOG_35', homeKey = `${KEY}\n`, homeMarker = `${MID}\n` } = {}) {
  const base = mkTmp();
  const home = path.join(base, 'home'); const cfgDir = path.join(home, '.config', 'mona-jacinta');
  realFs.mkdirSync(cfgDir, { recursive: true, mode: 0o700 }); realFs.chmodSync(path.join(home, '.config'), 0o700); realFs.chmodSync(cfgDir, 0o700);
  if (homeKey !== null) { realFs.writeFileSync(path.join(cfgDir, 'pilot-backup-mac-key'), homeKey); realFs.chmodSync(path.join(cfgDir, 'pilot-backup-mac-key'), 0o600); }
  if (homeMarker !== null) { realFs.writeFileSync(path.join(cfgDir, 'pilot-marker-id'), homeMarker); realFs.chmodSync(path.join(cfgDir, 'pilot-marker-id'), 0o600); }
  const store = path.join(base, 'backups'); realFs.mkdirSync(store, { mode: 0o700 }); realFs.chmodSync(store, 0o700);
  const work = path.join(base, workName); realFs.mkdirSync(work, { mode: 0o700 }); realFs.chmodSync(work, 0o700);
  const archive = path.join(store, 'pilot_20261015T010203Z_abcdef01.dump');
  realFs.writeFileSync(archive, archiveBytes, { mode: 0o600 }); realFs.chmodSync(archive, 0o600);
  const fields = {
    setId: 'abcdef01-0000-4000-8000-000000000000', createdAt: '2026-10-15T01:02:03.000Z', toolSha256: PB_SHA, pgDumpVersion: '17.11', serverVersion: '17.4',
    archive: { file: path.basename(archive), bytes: archiveBytes.length, sha256: sha(archiveBytes) }, tocSha256: sha(toc), schemas: ['mona_pilot_guard', 'public'],
    tables: Object.fromEntries(tables.map((t) => [t, { rows: (rows[t] ?? []).length, copySha256: copySha(rows[t], t) }])),
    refDigest: B.REF_DIGESTS.pilot, markerIdDigest: B.markerDigest(MID), ledgerState,
    rbacCatalog: { catalog, digest: RBAC.CATALOG_DIGESTS[catalog] ?? 'f'.repeat(64), permissions: catalog === 'CATALOG_36' ? 36 : 35, grants: catalog === 'CATALOG_36' ? 75 : 73 },
    schemaReferenceDigest: SYN_DIGEST,
  };
  manifestMutate?.(fields);
  const manifest = `${archive}.manifest.json`;
  realFs.writeFileSync(manifest, B.buildDumpManifest({ ...fields, mac: B.computeManifestMac(key, fields) }), { mode: 0o600 }); realFs.chmodSync(manifest, 0o600);
  return { base, home, store, work, archive, manifest, archiveBytes, rows, tables, toc, ledgerState };
}
// A complete, self-consistent EXACT_G11 fixture plus the matching world options.
const g11 = () => { const rows = g11Rows(); return fixture({ rows, tables: G11_TABLES, toc: tocText({ tables: G11_TABLES, extra: G11_FN_TRG }), ledgerState: 'EXACT_G11', catalog: 'CATALOG_36' }); };
const g11World = (fx, o = {}) => ({ archiveData: dataText(fx.rows, fx.tables), toc: fx.toc, restoredRows: fx.rows, cloneTables: fx.tables, ...o });

// The fake world. Options select failures; `calls` records every child; `conns` every client.
function world(fx, o = {}) {
  const calls = []; const conns = []; const queries = [];
  let run = 0; let started = false;
  const runs = {};
  const procs = new Map(); const kills = []; let nextPid = 4000;
  const files = (n) => { const pgdata = runs[n].pgdata; const sock = pgdata.replace(/data$/, 's');
    return { pid: path.join(pgdata, 'postmaster.pid'), s: path.join(sock, '.s.PGSQL.5432'), l: path.join(sock, '.s.PGSQL.5432.lock') }; };
  const bringUp = (n) => {
    const pm = nextPid++; const ch = nextPid++;
    procs.set(pm, { ppid: 1, start: `t${pm}`, exe: `${PG}/postgres`, alive: true });
    procs.set(ch, { ppid: pm, start: `t${ch}`, exe: `${PG}/postgres`, alive: true });
    runs[n].pm = pm; runs[n].ch = ch;
    const f = files(n);
    realFs.writeFileSync(f.pid, `${pm}\n${runs[n].pgdata}\n`); realFs.writeFileSync(f.s, ''); realFs.writeFileSync(f.l, '');
    started = true;
  };
  const bringDown = (n) => {
    const r = runs[n];
    for (const pid of [r.pm, r.ch]) if (pid !== undefined && !(o.childSurvives && pid === r.ch)) procs.get(pid).alive = false;
    const f = files(n);
    if (!o.socketLingers) for (const x of [f.s, f.l]) realFs.rmSync(x, { force: true });
    realFs.rmSync(f.pid, { force: true });
    if (o.pidReused && r.pm !== undefined) procs.set(r.pm, { ppid: 1, start: 'other', exe: '/usr/bin/sleep', alive: true });
    started = false;
  };
  const procApi = {
    stat: (pid) => { const p = procs.get(pid); return p && p.alive ? { ppid: p.ppid, start: p.start, exe: p.exe, state: 'S' } : null; },
    children: (pid) => [...procs].filter(([, p]) => p.alive && p.ppid === pid).map(([k]) => k),
    kill: (pid, sig) => { kills.push([pid, sig]); const p = procs.get(pid); if (p && !o.unkillable) p.alive = false; },
  };
  const rowsFor = (n) => (n === 2 && o.run2Rows ? o.run2Rows : (o.restoredRows ?? baseRows()));
  let searchPath = '"$user", public';
  const runChild = async (file, args, opts) => {
    calls.push({ file, args, opts, run });
    o.onChild?.({ file, args, run, fx });
    const ok = (stdout = '') => ({ status: 0, signal: null, timedOut: false, stdout, stderr: '' });
    if (file === `${PG}/pg_restore`) {
      if (args.includes('--list')) return ok(o.toc ?? tocText());
      if (args.includes('--schema-only')) return ok(o.ddl ?? DDL);
      if (args.some((a) => a.startsWith('--dbname='))) {
        if (o.restoreFail) return { status: 1, signal: null, timedOut: false, stdout: '', stderr: `password ${SECRET}` };
        return ok();
      }
      if (args.includes('--schema=mona_pilot_guard')) return ok(o.marker ?? markerCopy());
      if (args.includes('--data-only')) return ok(o.archiveData ?? dataText(baseRows()));
    }
    if (file === `${PG}/initdb`) {
      run += 1;
      const pgdata = args.find((a) => a.startsWith('--pgdata=')).slice(9);
      realFs.mkdirSync(pgdata, { recursive: true, mode: 0o700 });
      realFs.writeFileSync(path.join(pgdata, 'postgresql.conf'), '# initdb defaults\n');
      runs[run] = { pgdata };
      return o.initdbFail ? { status: 1, signal: null, timedOut: false, stdout: '', stderr: SECRET } : ok();
    }
    if (file === `${PG}/pg_ctl`) {
      if (args[0] === 'start') {
        if (o.startFail) { if (o.startFailButUp) bringUp(run); return { status: 1, signal: null, timedOut: false, stdout: '', stderr: '' }; }
        if (o.startTimeout) return { status: null, signal: 'SIGKILL', timedOut: true, stdout: '', stderr: '' };
        bringUp(run); return ok();
      }
      if (args[0] === 'stop') {
        if (o.stopLies) return ok();
        if (o.stopFails) return { status: 1, signal: null, timedOut: false, stdout: '', stderr: '' };
        if (o.stopHang) return { status: null, signal: 'SIGKILL', timedOut: true, stdout: '', stderr: '' };
        bringDown(run); return ok();
      }
    }
    if (file === `${PG}/pg_dump`) return ok(o.cloneDump?.(run) ?? dataText(rowsFor(run), o.cloneTables ?? TABLES));
    throw new Error(`unexpected child ${file} ${args.join(' ')}`);
  };
  const connect = async (cfg) => {
    conns.push({ ...cfg, run });
    if (!started) throw new Error('connection refused');
    const rows = rowsFor(run);
    const sock = path.dirname(path.join(runs[run].pgdata, 'x')).replace(/data$/, 's');
    return {
      query: async (text, opt = {}) => {
        queries.push({ text, run, user: cfg.user, database: cfg.database });
        const S = C.CLONE_SQL;
        if (text === S.identity) {
          return { rows: [{ data_directory: o.dataDir ?? realFs.realpathSync(runs[run].pgdata), listen_addresses: o.listen ?? '', unix_socket_directories: o.sockDir ?? sock,
            server_version_num: '170011', via_socket: true, database: cfg.database, superuser: cfg.user === C.ADMIN_ROLE ? 'on' : 'off' }] };
        }
        if (S.setup.includes(text)) return { rows: [] };
        if (text === S.schemas) return { rows: (o.schemas ?? ['public']).map((n) => ({ nspname: n })) };
        if (text === S.tables) return { rows: (o.cloneTables ?? TABLES).map((t) => ({ relname: t })) };
        if (text === S.ledger) {
          return { rows: (o.ledger ?? dbLedger(rows[LEDGER])) };
        }
        if (text === S.pinSearchPath) { if (!o.ignorePin) searchPath = 'pg_catalog, pg_temp'; return { rows: [] }; }
        if (text === S.pinTimeZone) return { rows: [] };
        if (text === P.PROJECTION_SQL.searchPath) return { rows: [{ search_path: searchPath }] };
        for (const [k, sql] of Object.entries(P.PROJECTION_SQL)) if (k !== 'searchPath' && text === sql) return { rows: ((n) => (n === 2 && o.run2Projection ? o.run2Projection : (o.projectionRaw ?? SYN_RAW)))(run)[k] };
        const catalog = o.restoredCatalog ?? dbCatalog(rows);
        if (text === RBAC.CATALOG_SQL.roles) return { rows: catalog.roles };
        if (text === RBAC.CATALOG_SQL.permissions) return { rows: catalog.permissions };
        if (text === RBAC.CATALOG_SQL.grants) return { rows: catalog.grants };
        if (text === S.invariants) return { rows: [{ ...INVARIANTS_OK, ...(o.invariants ?? {}) }] };
        const cm = /^SELECT count\(\*\)::text AS n FROM ONLY public\."([A-Za-z_]+)"$/.exec(text);
        if (cm) return { rows: [{ n: String(o.counts?.[cm[1]] ?? (rows[cm[1]] ?? []).length) }] };
        const rm = /^SELECT \* FROM ONLY public\."([A-Za-z_]+)"$/.exec(text);
        if (rm) { assert.equal(opt.array, true); return { rows: (rows[rm[1]] ?? []).map((r) => [...r]) }; }
        throw new Error(`unexpected SQL ${text}`);
      },
      end: async () => {},
    };
  };
  return { runChild, connect, calls, conns, queries, procApi, kills, procs, runs };
}

function deps(fx, w, o = {}) {
  const lines = [];
  const repoSha = new Map([...MIGS.map((m) => [`api/prisma/migrations/${m}/migration.sql`, MIG_SHA[m]]), ['scripts/database/pilot-backup.mjs', PB_SHA]]);
  let backupImports = 0;
  return {
    d: {
      env: o.env ?? { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, uid: o.uid ?? process.getuid(), execArgv: [], version: 'v24.20.0', fs: realFs,
      root: path.resolve('.'),
      verifyManifest: o.verifyManifest ?? (() => ({ ok: true, repoSha })),
      importBackupLib: async () => { backupImports += 1; return B; },
      importShared: o.importShared ?? (async () => { backupImports += 1; return SHARED; }),
      readNetDev: () => o.netdev ?? 'Inter-|   Receive\n face |bytes\n    lo: 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n',
      forbiddenRoots: o.forbiddenRoots ?? [],
      runChild: w.runChild, connect: w.connect, homedir: fx.home, procs: w.procApi, stopVerifyMs: 30, pollMs: 2,
      randomHex: () => o.hex ?? 'abcdef01',
      log: (l) => lines.push(String(l)), error: (l) => lines.push(String(l)),
    },
    lines, imports: () => backupImports,
  };
}
async function go(fx, o = {}, argvOverride) {
  const w = world(fx, o);
  const { d, lines, imports } = deps(fx, w, o);
  const argv = argvOverride ?? [`--archive=${fx.archive}`, `--manifest=${fx.manifest}`, `--work-root=${fx.work}`, `--expected-state=${o.expectedState ?? fx.ledgerState}`];
  const rc = await C.main(argv, d);
  const text = lines.join('\n');
  return { rc, text, last: lines.at(-1), w, imports: imports(), workListing: realFs.readdirSync(fx.work) };
}
const kids = (w, bin) => w.calls.filter((c) => c.file === `${PG}/${bin}`);

// ---------------- happy path ----------------
test('happy path: two isolated clones restored and measured, VERIFIED, own dirs removed', async () => {
  const fx = fixture();
  const r = await go(fx);
  assert.equal(r.rc, 0, r.text); assert.equal(r.last, 'A5C_RESULT=VERIFIED');
  assert.equal(kids(r.w, 'initdb').length, 2);
  assert.notEqual(kids(r.w, 'initdb')[0].args.find((a) => a.startsWith('--pgdata=')), kids(r.w, 'initdb')[1].args.find((a) => a.startsWith('--pgdata=')));
  assert.equal(kids(r.w, 'pg_ctl').filter((c) => c.args[0] === 'stop').length, 2);
  assert.deepEqual(r.workListing, [], 'own run directory removed');
  assert.match(r.text, /tables=25/);
});
test('initdb: non-root bootstrap superuser, trust only on the private socket, UTF8/C, inside the run dir', async () => {
  const fx = fixture(); const r = await go(fx);
  const a = kids(r.w, 'initdb')[0].args;
  assert.ok(a.includes(`--username=${C.ADMIN_ROLE}`)); assert.ok(a.includes('--auth=trust')); assert.ok(a.includes('--encoding=UTF8')); assert.ok(a.includes('--locale=C'));
  assert.ok(a.find((x) => x.startsWith('--pgdata=')).slice(9).startsWith(`${fx.work}/c-abcdef01/`));
});
test('D09 server config written: listen_addresses empty, socket only in the private dir', async () => {
  const fx = fixture();
  let conf = null;
  const r = await go(fx, { onChild: ({ file, args }) => { if (file.endsWith('pg_ctl') && args[0] === 'start' && conf === null) conf = realFs.readFileSync(path.join(args.find((x) => x.startsWith('--pgdata=')).slice(9), 'postgresql.conf'), 'utf8'); } });
  assert.equal(r.rc, 0, r.text);
  assert.match(conf, /^listen_addresses = ''$/m);
  assert.match(conf, new RegExp(`^unix_socket_directories = '${fx.work}/c-abcdef01/r1/s'$`, 'm'));
  assert.match(conf, /^unix_socket_permissions = 0700$/m);
});
test('E14/E16 restore: verified bytes on stdin, explicit socket connection, non-superuser restorer, public only', async () => {
  const fx = fixture(); const r = await go(fx);
  const restores = kids(r.w, 'pg_restore').filter((c) => c.args.some((a) => a.startsWith('--dbname=')));
  assert.equal(restores.length, 2);
  for (const [i, c] of restores.entries()) {
    assert.ok(Buffer.from(c.opts.input).equals(fx.archiveBytes));
    assert.ok(c.args.every((a) => a.startsWith('--')), 'no path argument');
    for (const f of ['--exit-on-error', '--single-transaction', '--no-owner', '--no-privileges', '--schema=public', '--format=custom', '--port=5432',
      `--username=${C.RESTORE_ROLE}`, `--dbname=${C.CLONE_DB}`, `--host=${fx.work}/c-abcdef01/r${i + 1}/s`]) assert.ok(c.args.includes(f), f);
  }
  assert.notEqual(C.RESTORE_ROLE, C.ADMIN_ROLE);
  assert.ok(C.CLONE_SQL.setup.some((s) => /CREATE ROLE .* NOSUPERUSER/.test(s)));
  for (const c of r.w.conns) { assert.equal(c.host, `${fx.work}/c-abcdef01/r${c.run}/s`); assert.equal(c.port, 5432); }
});
test('D05 every child env is an exact allowlist; no PG* routing variables', async () => {
  const fx = fixture(); const r = await go(fx);
  assert.ok(r.w.calls.length >= 9, 'children were run');
  // Offline archive inspections: exactly PATH/LANG/PGTZ. Cluster children: the same plus a private run HOME and pinned libpq files (R2 A5-005).
  const firstInit = r.w.calls.findIndex((c) => c.file.endsWith('initdb'));
  for (const c of r.w.calls.slice(0, firstInit)) assert.deepEqual(Object.keys(c.opts.env).sort(), ['LANG', 'PATH', 'PGTZ'], c.file);
  for (const c of r.w.calls.slice(firstInit)) {
    assert.deepEqual(Object.keys(c.opts.env).sort(), ['HOME', 'LANG', 'PATH', 'PGPASSFILE', 'PGSERVICEFILE', 'PGSSLCERT', 'PGSSLCRL', 'PGSSLCRLDIR', 'PGSSLKEY', 'PGSYSCONFDIR', 'PGTZ'], c.file);
  }
});
test('archive inspection happens before any cluster exists', async () => {
  const fx = fixture(); const r = await go(fx);
  const firstInit = r.w.calls.findIndex((c) => c.file.endsWith('initdb'));
  const inspections = r.w.calls.slice(0, firstInit).map((c) => c.args.find((a) => ['--list', '--schema-only', '--data-only'].includes(a)));
  // R2 A5-004 adds the marker inspection (--data-only of mona_pilot_guard) before any cluster exists.
  assert.deepEqual(inspections.sort(), ['--data-only', '--data-only', '--list', '--schema-only']);
  assert.ok(r.w.calls.slice(0, firstInit).some((c) => c.args.includes('--schema=mona_pilot_guard')));
});

// ---------------- gates before any child (args, env, uid, integrity, network) ----------------
for (const argv of [[], ['--archive=/x'], ['--archive=/a', '--manifest=/b', '--work-root=/c', '--extra=1'], ['--archive=rel', '--manifest=/b', '--work-root=/c'],
  ['--archive=/a b', '--manifest=/b', '--work-root=/c'], ['--archive=/a', '--manifest=/b', '--work-root=/c$x'], ['--archive=/a', '--archive=/a', '--manifest=/b'],
  ['--archive=/a', '--manifest=/b', '--work-root=/c'], ['--archive=/a', '--manifest=/b', '--work-root=/c', '--expected-state=EXACT_G10'],
  ['--archive=/a', '--manifest=/b', '--work-root=/c', '--expected-state=S4'], ['--archive=/a', '--manifest=/b', '--expected-state=EXACT_S4', '--expected-state=EXACT_S4']]) {
  test(`E12 args refused: ${JSON.stringify(argv)}`, async () => {
    const r = await go(fixture(), {}, argv); assert.equal(r.rc, 1); assert.equal(r.last, 'A5C_RESULT=REFUSED'); assert.equal(r.w.calls.length, 0);
  });
}
test('E11 uid 0 → refused before anything', async () => {
  const r = await go(fixture(), { uid: 0 }); assert.equal(r.rc, 3); assert.match(r.text, /phase=uid/); assert.equal(r.w.calls.length, 0);
});
for (const env of [{ PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: '/h' }, { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', PGHOST: '/tmp' }, { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', PGPORT: '1' }, { PATH: '/tmp:/usr/bin:/bin', LANG: 'C.UTF-8' }]) {
  test(`D05 parent env ${Object.keys(env).join(',')} → refused`, async () => {
    const r = await go(fixture(), { env }); assert.equal(r.rc, 3); assert.match(r.text, /phase=env/); assert.equal(r.w.calls.length, 0);
  });
}
test('integrity failure → refused before the backup library loads', async () => {
  const r = await go(fixture(), { verifyManifest: () => ({ ok: false }) });
  assert.equal(r.rc, 3); assert.match(r.text, /phase=integrity/); assert.equal(r.imports, 0); assert.equal(r.w.calls.length, 0);
});
for (const [name, netdev] of [
  ['eth0 present', 'h1\nh2\n    lo: 0\n  eth0: 0\n'], ['wlan0 only', 'h1\nh2\n wlan0: 0\n'], ['no lo', 'h1\nh2\n'], ['unreadable', null],
]) {
  test(`D18/D09 network not isolated (${name}) → refused before initdb`, async () => {
    const r = await go(fixture(), { netdev: netdev ?? undefined, ...(netdev === null ? { netdev: '' } : {}) });
    assert.equal(r.rc, 3); assert.match(r.text, /phase=network/); assert.equal(r.w.calls.length, 0);
  });
}

// ---------------- inputs (D01, D02, E13) ----------------
test('D01 archive symlink → refused, no child', async () => {
  const fx = fixture(); const link = path.join(fx.store, 'link.dump'); realFs.symlinkSync(fx.archive, link);
  const r = await go(fx, {}, [`--archive=${link}`, `--manifest=${fx.manifest}`, `--work-root=${fx.work}`, '--expected-state=EXACT_S4']);
  assert.equal(r.rc, 3); assert.match(r.text, /phase=input/); assert.equal(r.w.calls.length, 0);
});
test('D01 archive FIFO → refused promptly, no child', async () => {
  const fx = fixture(); realFs.rmSync(fx.archive); spawnSync('/usr/bin/mkfifo', ['-m', '600', fx.archive]);
  const t0 = Date.now(); const r = await go(fx);
  assert.notEqual(r.rc, 0); assert.equal(r.w.calls.length, 0); assert.ok(Date.now() - t0 < 3000);
});
test('D01 archive mode 0644 / store dir 0755 / under a forbidden root → refused', async () => {
  const fx1 = fixture(); realFs.chmodSync(fx1.archive, 0o644); assert.equal((await go(fx1)).rc, 3);
  const fx2 = fixture(); realFs.chmodSync(fx2.store, 0o755); assert.equal((await go(fx2)).rc, 3);
  const fx3 = fixture(); const r3 = await go(fx3, { forbiddenRoots: [fx3.store] }); assert.equal(r3.rc, 3); assert.equal(r3.w.calls.length, 0);
});
test('D01 manifest not named <archive>.manifest.json → refused', async () => {
  const fx = fixture(); const other = path.join(fx.store, 'other.manifest.json'); realFs.copyFileSync(fx.manifest, other); realFs.chmodSync(other, 0o600);
  const r = await go(fx, {}, [`--archive=${fx.archive}`, `--manifest=${other}`, `--work-root=${fx.work}`, '--expected-state=EXACT_S4']); assert.equal(r.rc, 3); assert.equal(r.w.calls.length, 0);
});
test('D02 archive 1 byte different from the manifest SHA → refused before initdb', async () => {
  const fx = fixture(); const b = realFs.readFileSync(fx.archive); b[b.length - 1] ^= 1; realFs.writeFileSync(fx.archive, b);
  const r = await go(fx); assert.equal(r.rc, 3); assert.match(r.text, /phase=archive/); assert.equal(kids(r.w, 'initdb').length, 0);
});
test('E13 manifest with an extra key / non-canonical bytes → refused', async () => {
  const fx = fixture(); const m = JSON.parse(realFs.readFileSync(fx.manifest, 'utf8'));
  realFs.writeFileSync(fx.manifest, `${JSON.stringify({ ...m, host: 'x' })}\n`); assert.equal((await go(fx)).rc, 3);
  realFs.writeFileSync(fx.manifest, `${JSON.stringify(m, null, 1)}\n`); assert.equal((await go(fx)).rc, 3);
});
test('manifest tocSha256 ≠ pg_restore --list → refused before initdb', async () => {
  const fx = fixture(); const r = await go(fx, { toc: `${tocText()}; trailing\n` });
  assert.equal(r.rc, 3); assert.equal(kids(r.w, 'initdb').length, 0);
});
test('D03 TOC with EXTENSION → refused before initdb', async () => {
  const toc = tocText({ extra: ['90; 3079 9 EXTENSION - pgcrypto postgres'] });
  const fx = fixture({ toc }); const r = await go(fx, { toc });
  assert.equal(r.rc, 3); assert.equal(kids(r.w, 'initdb').length, 0);
});
test('E18 archive DDL with LANGUAGE c → refused before initdb', async () => {
  const fx = fixture(); const r = await go(fx, { ddl: "CREATE FUNCTION public.f() RETURNS int LANGUAGE c AS '/x.so', 'f';\n" });
  assert.equal(r.rc, 3); assert.equal(kids(r.w, 'initdb').length, 0);
});
test('E17 archive COPY data ≠ manifest digests → refused before initdb', async () => {
  const fx = fixture(); const tampered = baseRows(); tampered.Sale[0][1] = 'z';
  const r = await go(fx, { archiveData: dataText(tampered) }); assert.equal(r.rc, 3); assert.equal(kids(r.w, 'initdb').length, 0);
});
test('manifest table set ≠ TOC table set → refused', async () => {
  const fx = fixture({ manifestMutate: (f) => { delete f.tables.Brand; } }); const r = await go(fx); assert.equal(r.rc, 3); assert.equal(kids(r.w, 'initdb').length, 0);
});

// ---------------- run directory (D06, E19) ----------------
test('D06 run directory already exists → refused, foreign directory untouched, no initdb', async () => {
  const fx = fixture(); const foreign = path.join(fx.work, 'c-abcdef01'); realFs.mkdirSync(foreign); realFs.writeFileSync(path.join(foreign, 'keep'), 'k');
  const r = await go(fx); assert.equal(r.rc, 3); assert.equal(kids(r.w, 'initdb').length, 0);
  assert.equal(realFs.readFileSync(path.join(foreign, 'keep'), 'utf8'), 'k');
});
test('work root not 0700 / under forbidden root → refused', async () => {
  const fx = fixture(); realFs.chmodSync(fx.work, 0o750); assert.equal((await go(fx)).rc, 3);
  const fx2 = fixture(); assert.equal((await go(fx2, { forbiddenRoots: [fx2.work] })).rc, 3);
});
test('E19 socket path longer than 100 bytes → refused before initdb', async () => {
  const fx = fixture({ workName: 'w'.repeat(100) }); const r = await go(fx); assert.equal(r.rc, 3); assert.equal(kids(r.w, 'initdb').length, 0);
});

// ---------------- server lifecycle failures (D08, D09, E15, D14) ----------------
const assertCleaned = (r, label) => { assert.deepEqual(r.workListing, [], `${label}: own run dir removed`); };
test('D08 pg_ctl start fails → FAILED, stop attempted, own dir removed', async () => {
  const fx = fixture(); const r = await go(fx, { startFail: true });
  assert.equal(r.rc, 6); assert.equal(r.last, 'A5C_RESULT=FAILED');
  assert.ok(kids(r.w, 'pg_ctl').some((c) => c.args[0] === 'stop')); assertCleaned(r, 'D08');
});
test('D08 pg_ctl start times out → FAILED, stop attempted, own dir removed', async () => {
  const fx = fixture(); const r = await go(fx, { startTimeout: true });
  assert.equal(r.rc, 6); assert.ok(kids(r.w, 'pg_ctl').some((c) => c.args[0] === 'stop')); assertCleaned(r, 'D08t');
});
test('initdb fails → FAILED, secret stderr not printed, dir removed', async () => {
  const fx = fixture(); const r = await go(fx, { initdbFail: true });
  assert.equal(r.rc, 6); assert.ok(!r.text.includes(SECRET)); assertCleaned(r, 'initdb');
});
for (const [name, o] of [['listen_addresses = *', { listen: '*' }], ['foreign data directory', { dataDir: '/var/lib/postgresql/17/main' }], ['foreign socket dir', { sockDir: '/var/run/postgresql' }]]) {
  test(`D09 clone identity not proven (${name}) → FAILED, no restore, stopped, cleaned`, async () => {
    const fx = fixture(); const r = await go(fx, o);
    assert.equal(r.rc, 6); assert.equal(kids(r.w, 'pg_restore').filter((c) => c.args.some((a) => a.startsWith('--dbname='))).length, 0);
    assert.ok(kids(r.w, 'pg_ctl').some((c) => c.args[0] === 'stop')); assertCleaned(r, name);
  });
}
test('E15/D14 restore fails (secret in stderr) → FAILED, stopped, cleaned, nothing echoed', async () => {
  const fx = fixture(); const r = await go(fx, { restoreFail: true });
  assert.equal(r.rc, 6); assert.ok(!r.text.includes(SECRET)); assert.ok(kids(r.w, 'pg_ctl').some((c) => c.args[0] === 'stop')); assertCleaned(r, 'E15');
});

// ---------------- measurements (D04, D10, D11, D12, D13, E17) ----------------
test('D04 guard schema present after restore → FAILED', async () => {
  const fx = fixture(); const r = await go(fx, { schemas: ['public', 'mona_pilot_guard'] }); assert.equal(r.rc, 6); assertCleaned(r, 'D04');
});
test('D04 the archive guard schema is never restored (public only) and the restored table set must equal the manifest', async () => {
  const fx = fixture(); const r = await go(fx, { cloneTables: TABLES.slice(1) }); assert.equal(r.rc, 6);
});
test('D11 restored row count ≠ manifest → FAILED with counts flag', async () => {
  const fx = fixture(); const extra = baseRows(); extra.Sale.push(['s3', 'w']);
  const r = await go(fx, { restoredRows: extra }); assert.equal(r.rc, 6); assert.match(r.text, /check counts=FAIL/);
});
test('D11 count(*) disagreeing with the rows actually read → FAILED (count drift)', async () => {
  const fx = fixture(); const r = await go(fx, { counts: { Sale: 3 } }); assert.equal(r.rc, 6); assert.match(r.text, /count drift/);
});
test('D10 FROM ONLY fingerprints differ between the two runs → FAILED', async () => {
  const fx = fixture(); const r2 = baseRows(); r2.Company[0][1] = 'Other';
  const r = await go(fx, { run2Rows: r2, cloneDump: () => dataText(baseRows()) }); assert.equal(r.rc, 6); assert.match(r.text, /fingerprint/);
});
test('E17 pg_dump of the restored clone ≠ manifest digests → FAILED', async () => {
  const fx = fixture(); const t = baseRows(); t.Sale.pop();
  const r = await go(fx, { cloneDump: () => dataText(t) }); assert.equal(r.rc, 6); assert.match(r.text, /roundtrip/);
});
for (const [name, ledger] of [
  ['unknown migration', [{ migration_name: '20990101000000_evil', checksum: 'a'.repeat(64), finished: true, rolled_back: false }]],
  ['checksum mismatch', [{ migration_name: MIGS[0], checksum: 'b'.repeat(64), finished: true, rolled_back: false }]],
  ['rolled back', [{ migration_name: MIGS[0], checksum: MIG_SHA[MIGS[0]], finished: true, rolled_back: true }]],
  ['unfinished', [{ migration_name: MIGS[0], checksum: MIG_SHA[MIGS[0]], finished: false, rolled_back: false }]],
]) {
  test(`D12 ledger ${name} → FAILED with ledger flag`, async () => {
    const r = await go(fixture(), { ledger }); assert.equal(r.rc, 6); assert.match(r.text, /ledger/);
  });
}
test('D12 a clean ledger reports the exact state and its row count', async () => {
  const r = await go(fixture()); assert.equal(r.rc, 0, r.text); assert.match(r.text, /ledger state=EXACT_S4 rows=4/);
});
test('D13 data carrying a result token and control characters is never printed', async () => {
  const rows = baseRows(); rows.Company = [['A5C_RESULT=VERIFIED', '\u001b[2J', 'x']];
  const fx = fixture({ rows });
  const r = await go(fx, { restoredRows: rows, archiveData: dataText(rows) });
  assert.equal(r.rc, 0, r.text);
  assert.equal(r.text.split('\n').filter((l) => l.includes('A5C_RESULT')).length, 1);
  assert.ok(!r.text.includes('\u001b'));
});

// ---------------- cleanup safety (D07) ----------------
test('D07 run directory swapped before cleanup → not deleted, not VERIFIED', async () => {
  const fx = fixture(); let swapped = false;
  const r = await go(fx, { onChild: ({ file, args, run }) => {
    if (!swapped && file.endsWith('pg_ctl') && args[0] === 'stop' && run === 2) {
      swapped = true; const d = path.join(fx.work, 'c-abcdef01'); realFs.renameSync(d, `${d}.moved`); realFs.mkdirSync(d); realFs.writeFileSync(path.join(d, 'foreign'), 'f');
    }
  } });
  assert.notEqual(r.rc, 0); assert.match(r.text, /cleanup/);
  assert.equal(realFs.readFileSync(path.join(fx.work, 'c-abcdef01', 'foreign'), 'utf8'), 'f');
  assert.ok(realFs.existsSync(path.join(fx.work, 'c-abcdef01.moved')));
});

// ---------------- pure helpers ----------------
test('checkNetworkIsolation accepts exactly lo', () => {
  assert.equal(C.checkNetworkIsolation('Inter-|\n face |\n    lo: 1 2\n').ok, true);
  assert.equal(C.checkNetworkIsolation('Inter-|\n face |\n    lo: 1\n  eth0: 2\n').ok, false);
  assert.equal(C.checkNetworkIsolation('').ok, false);
});
test('fingerprintRows is order-independent and content-sensitive', () => {
  const a = C.fingerprintRows([['1', 'a'], ['2', null]]);
  assert.equal(a, C.fingerprintRows([['2', null], ['1', 'a']]));
  assert.notEqual(a, C.fingerprintRows([['1', 'a'], ['2', '']]));
  assert.notEqual(a, C.fingerprintRows([['1', 'a\t2'], ['', null]]));
  assert.match(a, /^[0-9a-f]{64}$/);
});

// =====================================================================================
// R2 (Codex A5-001 / A5-003 / A5-004 / A5-005) — scenarios F01–F07, F14, F18–F23, F26
// =====================================================================================
const RUN = (fx) => path.join(fx.work, 'c-abcdef01');
const keptRunDir = (fx, r) => { assert.ok(realFs.existsSync(RUN(fx)), 'run dir kept while PostgreSQL may be alive'); assert.match(r.text, /stopped=FAIL/); };

// ---------------- A5-001 clone termination ----------------
test('stop verified on the happy path: postmaster and backends gone, socket and pid file released, then cleanup', async () => {
  const fx = fixture(); const r = await go(fx);
  assert.equal(r.rc, 0, r.text); assert.match(r.text, /check stopped=PASS/);
  for (const n of [1, 2]) { assert.equal(r.w.procApi.stat(r.w.runs[n].pm), null); assert.equal(r.w.procApi.stat(r.w.runs[n].ch), null); }
  assert.deepEqual(r.w.kills, []); assert.deepEqual(r.workListing, []);
});
test('F01 pg_ctl stop exits 0 but the postmaster is still alive and cannot be killed → FAILED, run dir kept', async () => {
  const fx = fixture(); const r = await go(fx, { stopLies: true, unkillable: true });
  assert.equal(r.rc, 6); assert.equal(r.last, 'A5C_RESULT=FAILED'); keptRunDir(fx, r);
});
test('F02 fast and immediate stop fail → SIGKILL only to the recorded postgres pids; processes dead but files left → FAILED, dir kept', async () => {
  const fx = fixture(); const r = await go(fx, { stopFails: true });
  assert.equal(r.rc, 6);
  const pg = r.w.runs[1];
  assert.deepEqual(r.w.kills.map(([p]) => p).sort(), [pg.pm, pg.ch].sort()); assert.ok(r.w.kills.every(([, s]) => s === 'SIGKILL'));
  assert.equal(r.w.calls.filter((c) => c.file.endsWith('pg_ctl') && c.args[0] === 'stop').length, 2, 'fast then immediate');
  assert.ok(r.w.calls.some((c) => c.args.includes('--mode=immediate')));
  keptRunDir(fx, r);
});
test('F03 pg_ctl stop hangs (timeout) → escalation measured, never assumed; FAILED', async () => {
  const fx = fixture(); const r = await go(fx, { stopHang: true, unkillable: true });
  assert.equal(r.rc, 6); assert.ok(r.w.kills.length >= 1); keptRunDir(fx, r);
});
test('F04 a backend child survives the postmaster → FAILED, dir kept', async () => {
  const fx = fixture(); const r = await go(fx, { childSurvives: true, unkillable: true });
  assert.equal(r.rc, 6); keptRunDir(fx, r);
});
test('F05 processes gone but the socket file is not released → FAILED, dir kept', async () => {
  const fx = fixture(); const r = await go(fx, { socketLingers: true });
  assert.equal(r.rc, 6); keptRunDir(fx, r);
});
test('F06 pg_ctl start reports failure but the server is up → stop performed and verified before cleanup', async () => {
  const fx = fixture(); const r = await go(fx, { startFail: true, startFailButUp: true });
  assert.equal(r.rc, 6);
  assert.equal(r.w.procApi.stat(r.w.runs[1].pm), null, 'postmaster stopped'); assert.deepEqual(r.workListing, [], 'cleaned only after the verified stop');
});
test('F07 pid reused by an unrelated process after a clean stop → never killed, run accepted', async () => {
  const fx = fixture(); const r = await go(fx, { pidReused: true });
  assert.equal(r.rc, 0, r.text); assert.deepEqual(r.w.kills, []);
});

// ---------------- A5-003 ledger in the restored clone ----------------
const S4 = MIGS.slice(0, 4).map((m) => ledgerRow(m));
for (const [name, rows] of [
  ['empty', []], ['only 3 of S4', S4.slice(0, 3)], ['S4 plus one later migration', [...S4, ledgerRow(MIGS[4])]],
  ['duplicate applied row', [...S4, ledgerRow(MIGS[0], { id: 'dup' })]], ['failed attempt', [...S4, ledgerRow(MIGS[5], { finished: false })]],
  ['malformed steps', [...S4.slice(0, 3), ledgerRow(MIGS[3], { steps: 'x' })]],
  ['rolled-back attempt with a different checksum', [...S4, ledgerRow(MIGS[2], { finished: false, rolledBack: true, checksum: 'a'.repeat(64), id: 'old' })]],
]) {
  test(`F14 restored ledger ${name} → FAILED (ledger)`, async () => {
    const r = await go(fixture(), { ledger: dbLedger(rows) }); assert.equal(r.rc, 6); assert.match(r.text, /check ledger=FAIL/);
  });
}
test('F15 shuffled restored exact ledger → accepted; a same-checksum rolled-back attempt → FAILED (OWNER: none rolled back)', async () => {
  const ok = await go(fixture(), { ledger: dbLedger([S4[2], S4[0], S4[3], S4[1]]) }); assert.equal(ok.rc, 0, ok.text); assert.match(ok.text, /state=EXACT_S4/);
  const rows = [S4[2], ledgerRow(MIGS[0], { finished: false, rolledBack: true, id: 'retry' }), S4[0], S4[3], S4[1]];
  const r = await go(fixture(), { ledger: dbLedger(rows) }); assert.equal(r.rc, 6); assert.match(r.text, /check ledger=FAIL/);
});
test('F18 manifest declares EXACT_G7 while the archive ledger is S4 → refused before initdb', async () => {
  const r = await go(fixture({ ledgerState: 'EXACT_G7' })); assert.equal(r.rc, 3); assert.equal(kids(r.w, 'initdb').length, 0);
});
test('F18 restored ledger G11 while the manifest declares S4 → FAILED', async () => {
  const r = await go(fixture(), { ledger: dbLedger(MIGS.map((m) => ledgerRow(m))) }); assert.equal(r.rc, 6); assert.match(r.text, /check ledger=FAIL/);
});

// ---------------- A5-004 provenance ----------------
const refusedBeforeCluster = (r) => { assert.equal(r.rc, 3, r.text); assert.match(r.text, /phase=provenance/); assert.equal(kids(r.w, 'initdb').length, 0); };
test('F19 archive + manifest replaced together by a self-consistent pair signed with another key → refused before initdb', async () => {
  refusedBeforeCluster(await go(fixture({ key: 'f'.repeat(64) })));
});
for (const [name, mutate] of [
  ['toolSha256 of another tool', (f) => { f.toolSha256 = 'a'.repeat(64); }],
  ['refDigest of another project', (f) => { f.refDigest = B.REF_DIGESTS.forbidden[1]; }],
  ['markerIdDigest of another marker', (f) => { f.markerIdDigest = B.markerDigest('22222222-2222-4222-8222-222222222222'); }],
  ['createdAt two days after the archive', (f) => { f.createdAt = '2026-10-17T01:00:00.000Z'; }],
]) {
  test(`F20/F22 ${name} (correctly signed) → refused before initdb`, async () => {
    refusedBeforeCluster(await go(fixture({ manifestMutate: mutate })));
  });
}
for (const [name, marker] of [
  ['absent', 'COPY mona_pilot_guard.database_identity (singleton, environment, marker_id, installed_at) FROM stdin;\n\\.\n'],
  ['environment test', markerCopy({ env: 'test' })],
  ['another marker id', markerCopy({ id: '22222222-2222-4222-8222-222222222222' })],
]) {
  test(`F21 archive marker ${name} → refused before initdb`, async () => {
    refusedBeforeCluster(await go(fixture(), { marker }));
  });
}
for (const [name, opts] of [['MAC key missing', { homeKey: null }], ['MAC key wrong length', { homeKey: `${KEY.slice(2)}\n` }], ['marker id file missing', { homeMarker: null }]]) {
  test(`F23 ${name} → refused before any child`, async () => {
    const r = await go(fixture(opts)); assert.equal(r.rc, 3); assert.equal(r.w.calls.length, 0);
  });
}
test('F23 MAC key file mode 0644 → refused before any child', async () => {
  const fx = fixture(); realFs.chmodSync(path.join(fx.home, '.config/mona-jacinta/pilot-backup-mac-key'), 0o644);
  const r = await go(fx); assert.equal(r.rc, 3); assert.equal(r.w.calls.length, 0);
});

// ---------------- A5-005 clone children libpq environment ----------------
test('F26 cluster children get an empty private HOME inside the run dir with pinned libpq files; never the passwd home', async () => {
  const fx = fixture();
  realFs.mkdirSync(path.join(fx.home, '.postgresql')); realFs.writeFileSync(path.join(fx.home, '.pgpass'), '*:*:*:*:x');
  const seen = [];
  const r = await go(fx, { onChild: ({ file, args }) => { if (file.endsWith('pg_ctl') && args[0] === 'start') { const h = path.join(RUN(fx), 'h'); const st = realFs.lstatSync(h); seen.push({ dir: st.isDirectory(), mode: st.mode & 0o777, entries: realFs.readdirSync(h) }); } } });
  assert.equal(r.rc, 0, r.text);
  assert.deepEqual(seen[0], { dir: true, mode: 0o700, entries: [] });
  const firstInit = r.w.calls.findIndex((c) => c.file.endsWith('initdb'));
  for (const c of r.w.calls.slice(firstInit)) {
    assert.equal(c.opts.env.HOME, path.join(RUN(fx), 'h'));
    for (const v of Object.values(c.opts.env)) assert.ok(!String(v).startsWith(fx.home), 'never the passwd home');
    for (const k of ['PGSSLCERT', 'PGSSLKEY', 'PGSSLCRL', 'PGSSLCRLDIR', 'PGPASSFILE', 'PGSERVICEFILE']) assert.equal(path.dirname(c.opts.env[k]), c.opts.env.HOME);
  }
});

// Mutation-driven additions (R2 mutants R10/R15/R16 survived): exact S4 plus one offending row.
for (const [name, extra] of [
  ['a failed attempt next to the applied row of the same migration', ledgerRow(MIGS[1], { finished: false, id: 'failed-attempt' })],
  ['an extra unknown migration', ledgerRow('20990101000000_evil', { checksum: 'c'.repeat(64), id: 'unknown' })],
  ['an extra malformed row', ledgerRow(MIGS[0], { steps: 'x', id: 'malformed' })],
]) {
  test(`F14b restored ledger exact S4 plus ${name} → FAILED (ledger)`, async () => {
    const r = await go(fixture(), { ledger: dbLedger([...S4, extra]) }); assert.equal(r.rc, 6); assert.match(r.text, /check ledger=FAIL/);
  });
}

// ---------------- G11 cut-over: explicit state, app-schema projection, RBAC catalog, invariants ----------------
test('C-G11-01 the expected state is explicit: a manifest of another exact state → refused before any cluster, never re-targeted', async () => {
  const r = await go(fixture(), { expectedState: 'EXACT_G7' });
  assert.equal(r.rc, 3); assert.match(r.text, /phase=manifest/); assert.match(r.text, /EXACT_S4.*EXACT_G7|EXACT_G7.*EXACT_S4/); assert.equal(kids(r.w, 'initdb').length, 0);
});
test('C-G11-02 happy path: schema digest = reference, probes pass, RBAC catalog = manifest, invariants hold, search_path pinned per connection', async () => {
  const r = await go(fixture());
  assert.equal(r.rc, 0, r.text); assert.equal(r.last, 'A5C_RESULT=VERIFIED');
  for (const k of ['ledger', 'schema', 'rbac', 'invariants']) assert.match(r.text, new RegExp(`check ${k}=PASS`));
  assert.match(r.text, new RegExp(`schema digest=${SYN_DIGEST} reference=MATCH probes_failed=0`));
  assert.match(r.text, /rbac catalog=CATALOG_35/);
  assert.match(r.text, /invariants open_sessions=0 registers_multi_open=0 session_close_mismatch=0 orphan_movements=0 orphan_payment_sessions=0 sale_total_mismatch=0 paid_payment_mismatch=0/);
  const measured = r.w.queries.filter((q) => q.database === C.CLONE_DB);
  for (const n of [1, 2]) {
    const mine = measured.filter((q) => q.run === n).map((q) => q.text);
    assert.equal(mine.indexOf(C.CLONE_SQL.pinSearchPath) >= 0 && mine.indexOf(C.CLONE_SQL.pinSearchPath) < mine.indexOf(P.PROJECTION_SQL.searchPath), true, `run ${n}: pinned first`);
  }
});
test('C-G11-03 restored app schema differs from the reference (extra column) → FAILED (schema)', async () => {
  const projectionRaw = { ...SYN_RAW, columns: [...SYN_RAW.columns, { table: 'Sale', column: 'evil', type: 'text', not_null: 'f', default_expr: null, identity: '', generated: '' }] };
  const r = await go(fixture(), { projectionRaw });
  assert.equal(r.rc, 6); assert.match(r.text, /check schema=FAIL/); assert.match(r.text, /reference=MISMATCH/);
});
test('C-G11-04 a failing semantic probe → FAILED (schema), the probe named, never a body', async () => {
  const projectionRaw = { ...SYN_RAW, constraints: [{ ...SYN_RAW.constraints[0], validated: 'f' }] };
  const fx = g11();
  const refs = { ...SYN_REFS, SCHEMA_REFERENCES: { ...SYN_REFS.SCHEMA_REFERENCES, EXACT_G11: { digest: P.projectionDigest(P.buildProjection(asBool(projectionRaw))) } } };
  const r = await go(fx, g11World(fx, { projectionRaw, importShared: async () => ({ ...SHARED, references: refs }) }));
  assert.equal(r.rc, 3, 'the manifest binds another reference digest → refused before any cluster');
  // Digest bound and matching (reference = this projection), only the semantic probe fails.
  const failingDigest = refs.SCHEMA_REFERENCES.EXACT_G11.digest;
  const rows = g11Rows();
  const fx2 = fixture({ rows, tables: G11_TABLES, toc: tocText({ tables: G11_TABLES, extra: G11_FN_TRG }), ledgerState: 'EXACT_G11', catalog: 'CATALOG_36',
    manifestMutate: (f) => { f.schemaReferenceDigest = failingDigest; } });
  const r2 = await go(fx2, g11World(fx2, { projectionRaw, importShared: async () => ({ ...SHARED, references: refs }) }));
  assert.equal(r2.rc, 6, r2.text); assert.match(r2.text, /reference=MATCH probes_failed=1/); assert.match(r2.text, /check schema=FAIL/);
  assert.match(r2.text, /PROBE_FAILED:constraint:Sale\.Sale_pkey/);
});
test('C-G11-04b the archive RBAC catalog differs from the (correctly signed) manifest catalog → refused before any cluster', async () => {
  const r = await go(fixture({ catalog: 'CATALOG_36' }));
  assert.equal(r.rc, 3); assert.match(r.text, /phase=archive/); assert.match(r.text, /RBAC catalog differs/); assert.equal(kids(r.w, 'initdb').length, 0);
});
test('C-G11-05 search_path not pinned on the clone connection → FAILED (schema), never a projection under a foreign search_path', async () => {
  const r = await go(fixture(), { ignorePin: true });
  assert.equal(r.rc, 6); assert.match(r.text, /check schema=FAIL/);
});
test('C-G11-06 restored RBAC catalog ≠ the manifest catalog → FAILED (rbac)', async () => {
  const r = await go(fixture(), { restoredCatalog: dbCatalog(CAT36) });
  assert.equal(r.rc, 6); assert.match(r.text, /check rbac=FAIL/);
  const extra = dbCatalog(CAT35); extra.grants.push({ roleId: extra.roles[0].id, permissionId: '00000000-0000-4000-9400-000000000036' });
  const r2 = await go(fixture(), { restoredCatalog: extra });
  assert.equal(r2.rc, 6); assert.match(r2.text, /check rbac=FAIL/); assert.match(r2.text, /rbac catalog=NONE/);
});
for (const k of ['registers_multi_open', 'session_close_mismatch', 'orphan_movements', 'orphan_payment_sessions']) {
  test(`C-G11-07 cash/sales hard invariant ${k}≠0 → FAILED (invariants)`, async () => {
    const r = await go(fixture(), { invariants: { [k]: '1' } });
    assert.equal(r.rc, 6); assert.match(r.text, /check invariants=FAIL/); assert.match(r.text, new RegExp(`${k}=1`));
  });
}
test('C-G11-08 informational invariants (open sessions, sale totals, paid/payment sums) are reported, not fatal; malformed values are fatal', async () => {
  const r = await go(fixture(), { invariants: { open_sessions: '1', sale_total_mismatch: '2', paid_payment_mismatch: '3' } });
  assert.equal(r.rc, 0, r.text); assert.match(r.text, /open_sessions=1 .*sale_total_mismatch=2 paid_payment_mismatch=3/);
  const bad = await go(fixture(), { invariants: { open_sessions: 'x' } });
  assert.equal(bad.rc, 6); assert.match(bad.text, /check invariants=FAIL/);
});
test('C-G11-09 EXACT_G11 happy path: 32 tables, CATALOG_36, exact 11-migration ledger', async () => {
  const fx = g11();
  const r = await go(fx, g11World(fx));
  assert.equal(r.rc, 0, r.text); assert.equal(r.last, 'A5C_RESULT=VERIFIED');
  assert.match(r.text, /tables=32/); assert.match(r.text, /ledger state=EXACT_G11 rows=11/); assert.match(r.text, /rbac catalog=CATALOG_36/);
});
for (const k of [8, 9, 10]) {
  test(`C-G11-10 restored ledger G${k} under an EXACT_G11 manifest → FAILED (ledger)`, async () => {
    const fx = g11();
    const r = await go(fx, g11World(fx, { ledger: dbLedger(MIGS.slice(0, k).map((m) => ledgerRow(m))) }));
    assert.equal(r.rc, 6); assert.match(r.text, /check ledger=FAIL/);
  });
}
test('C-G11-11 shared modules unavailable/malformed → refused at integrity before any child; never loaded before the code manifest', async () => {
  for (const importShared of [async () => { throw new Error('x'); }, async () => ({ ...SHARED, projection: {} }), async () => ({ ...SHARED, states: {} })]) {
    const r = await go(fixture(), { importShared });
    assert.equal(r.rc, 3); assert.match(r.text, /phase=integrity/); assert.equal(r.w.calls.length, 0);
  }
  const r = await go(fixture(), { verifyManifest: () => ({ ok: false }) });
  assert.equal(r.imports, 0);
});
test('C-G11-12 the manifest-bound reference digest differs from the current generated reference → refused before any cluster', async () => {
  const r = await go(fixture({ manifestMutate: (f) => { f.schemaReferenceDigest = 'a'.repeat(64); } }));
  assert.equal(r.rc, 3); assert.match(r.text, /phase=archive/); assert.equal(kids(r.w, 'initdb').length, 0);
});
test('C-G11-13 schema measurements differing between the two runs → FAILED', async () => {
  const run2Projection = { ...SYN_RAW, indexes: [] };
  const r = await go(fixture(), { run2Projection });
  assert.equal(r.rc, 6); assert.match(r.text, /check schema=FAIL/);
});
test('C-G11-14 measurement sessions pin TimeZone/DateStyle (fingerprints never depend on the host timezone initdb picked)', async () => {
  const r = await go(fixture());
  assert.equal(r.rc, 0, r.text);
  assert.match(C.CLONE_SQL.pinTimeZone, /set_config\('TimeZone', 'UTC', false\).*set_config\('DateStyle', 'ISO, MDY', false\)/);
  for (const n of [1, 2]) {
    const mine = r.w.queries.filter((q) => q.database === C.CLONE_DB && q.run === n).map((q) => q.text);
    const firstRows = mine.findIndex((t) => t.startsWith('SELECT * FROM ONLY'));
    assert.ok(mine.indexOf(C.CLONE_SQL.pinTimeZone) >= 0 && mine.indexOf(C.CLONE_SQL.pinTimeZone) < firstRows, `run ${n}: pinned before any row read`);
  }
});

// ---------------- §6 drift matrix at the restore proof (reference = the clean schema's digest) ----------------
const RICH = () => ({
  tables: [{ table: 'CashSession' }, { table: 'Sale' }],
  columns: [
    { table: 'CashSession', column: 'id', type: 'text', not_null: 't', default_expr: null, identity: '', generated: '' },
    { table: 'Sale', column: 'id', type: 'text', not_null: 't', default_expr: null, identity: '', generated: '' },
    { table: 'Sale', column: 'sessionId', type: 'text', not_null: 'f', default_expr: null, identity: '', generated: '' },
    { table: 'Sale', column: 'total', type: 'bigint', not_null: 't', default_expr: '0', identity: '', generated: '' },
  ],
  enums: [], types: [],
  constraints: [
    { table: 'CashSession', name: 'CashSession_pkey', type: 'p', definition: 'PRIMARY KEY (id)', validated: 't' },
    { table: 'Sale', name: 'Sale_pkey', type: 'p', definition: 'PRIMARY KEY (id)', validated: 't' },
    { table: 'Sale', name: 'Sale_sessionId_fkey', type: 'f', definition: 'FOREIGN KEY ("sessionId") REFERENCES "CashSession"(id)', validated: 't' },
    { table: 'Sale', name: 'chk_sale_total', type: 'c', definition: 'CHECK ((total >= 0))', validated: 't' },
  ],
  indexes: [
    { table: 'CashSession', name: 'CashSession_pkey', definition: 'CREATE UNIQUE INDEX "CashSession_pkey" ON public."CashSession" USING btree (id)', valid: 't' },
    { table: 'Sale', name: 'Sale_pkey', definition: 'CREATE UNIQUE INDEX "Sale_pkey" ON public."Sale" USING btree (id)', valid: 't' },
    { table: 'Sale', name: 'Sale_sessionId_key', definition: 'CREATE UNIQUE INDEX "Sale_sessionId_key" ON public."Sale" USING btree ("sessionId")', valid: 't' },
  ],
  functions: [{ name: 'fn_sale_guard', args: '', kind: 'f', definition: 'CREATE FUNCTION public.fn_sale_guard() RETURNS trigger AS $$ BEGIN RETURN NEW; END $$' }],
  triggers: [{ table: 'Sale', name: 'trg_sale_guard', definition: 'CREATE TRIGGER trg_sale_guard BEFORE UPDATE ON public."Sale" FOR EACH ROW EXECUTE FUNCTION fn_sale_guard()', enabled: 'O' }],
});
const RICH_DIGEST = P.projectionDigest(P.buildProjection(asBool(RICH())));
const richRefs = { ...SYN_REFS, SCHEMA_REFERENCES: { ...SYN_REFS.SCHEMA_REFERENCES, EXACT_S4: { digest: RICH_DIGEST } }, STATE_PROBES: { ...SYN_PROBES, EXACT_S4: [] } };
async function richRun(mutate) {
  const raw = RICH(); mutate?.(raw);
  return go(fixture({ manifestMutate: (f) => { f.schemaReferenceDigest = RICH_DIGEST; } }),
    { projectionRaw: raw, importShared: async () => ({ ...SHARED, references: richRefs }) });
}
test('C-G11-15 the clean rich schema matches its reference (baseline for the drift matrix)', async () => {
  const r = await richRun(); assert.equal(r.rc, 0, r.text); assert.match(r.text, /reference=MATCH/);
});
for (const [label, mutate] of [
  ['missing table', (r) => { for (const k of ['tables', 'columns', 'constraints', 'indexes']) r[k] = r[k].filter((x) => x.table !== 'CashSession'); r.constraints = r.constraints.filter((c) => c.type !== 'f'); }],
  ['wrong column type', (r) => { r.columns.find((c) => c.column === 'total').type = 'integer'; }],
  ['nullability drift', (r) => { r.columns.find((c) => c.column === 'sessionId').not_null = 't'; }],
  ['missing FK', (r) => { r.constraints = r.constraints.filter((c) => c.type !== 'f'); }],
  ['CHECK drift', (r) => { r.constraints.find((c) => c.type === 'c').definition = 'CHECK ((total > 0))'; }],
  ['CHECK not validated', (r) => { r.constraints.find((c) => c.type === 'c').validated = 'f'; }],
  ['unique/index drift', (r) => { r.indexes.find((i) => i.name === 'Sale_sessionId_key').definition = 'CREATE INDEX "Sale_sessionId_key" ON public."Sale" USING btree ("sessionId")'; }],
  ['missing trigger', (r) => { r.triggers = []; }],
  ['missing function', (r) => { r.functions = []; }],
  ['unexpected app-owned table', (r) => { r.tables.push({ table: 'Intruder' }); }],
  ['unexpected app-owned function', (r) => { r.functions.push({ name: 'fn_backdoor', args: '', kind: 'f', definition: 'CREATE FUNCTION public.fn_backdoor() RETURNS void AS $$ $$' }); }],
]) {
  test(`C-G11-16 restore proof drift: ${label} → FAILED (schema, reference MISMATCH), deterministically`, async () => {
    const a = await richRun(mutate); const b = await richRun(mutate);
    assert.equal(a.rc, 6); assert.match(a.text, /check schema=FAIL/); assert.match(a.text, /reference=MISMATCH/);
    const digestOf = (t) => /schema digest=([0-9a-f]{64})/.exec(t)[1];
    assert.equal(digestOf(a.text), digestOf(b.text), 'the same drift always yields the same digest');
  });
}
test('C-G11-17 provider-owned objects never reach the projection (excluded by the APP_OWNED rule in the catalog SQL itself)', () => {
  for (const k of ['tables', 'columns', 'constraints', 'indexes', 'triggers', 'enums', 'types', 'functions']) {
    assert.match(P.PROJECTION_SQL[k], /n\.nspname = 'public'/, k); assert.match(P.PROJECTION_SQL[k], /deptype = 'e'/, k);
  }
});
