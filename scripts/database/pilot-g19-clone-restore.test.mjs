// Hermetic tests for pilot-g19-clone-restore.mjs (the G19 sibling of pilot-clone-restore.mjs). A fake world stands in for initdb, pg_ctl, pg_restore,
// pg_dump and the pg client: no process is started, no socket opened, no database touched.
// Real PostgreSQL coverage (an isolated cluster built from the 19 migrations) is NOT run: it is the derivation that pins the EXACT_G19 reference.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as realFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as C from './pilot-g19-clone-restore.mjs';
import * as B from './pilot-g19-backup.mjs';
import * as GEN from './pilot-migration-generations.mjs';
import * as RBACG from './pilot-rbac-catalog-generations.mjs';
import * as REFS19 from './pilot-g19-schema-references.mjs';
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
const G16_TABLES = [...TABLES, 'CompanyPricingConfig', ...R3, 'SaleVoid', 'SaleVoidExternalRefund'];
const G19_TABLES = [...G16_TABLES, 'SaleExchange', 'SaleExchangeLine'];
const MIGS = GEN.pinsOf('EXACT_G19').map((p) => p.name);
const MIG_SHA = Object.fromEntries(GEN.GENERATION_MIGRATION_PINS.map((p) => [p.name, p.sha256]));
const SECRET = 'S3cretPw-in-stderr';
const KEY = '0123456789abcdef'.repeat(4);
const MID = '11111111-1111-4111-8111-111111111111';
const PB_SHA = sha('fixture pilot-g19-backup.mjs');
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
const CAT37 = catalogRows(RBACG.CATALOG_37);
const CAT38 = catalogRows(RBACG.CATALOG_38);
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
const SYN_PROBES = { EXACT_G16: [{ kind: 'table', name: 'Sale' }], EXACT_G19: [{ kind: 'constraint', table: 'Sale', name: 'Sale_pkey', type: 'p' }] };
const SYN_REFS = { SCHEMA_REFERENCES_G19: { EXACT_G16: { digest: SYN_DIGEST }, EXACT_G19: { digest: SYN_DIGEST } }, GENERATION_PROBES_G19: SYN_PROBES };
const SHARED = C.adaptShared({ generations: GEN, references: SYN_REFS, rbac: RBACG, rbacBase: RBAC, projection: P });
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
  [LEDGER]: MIGS.slice(0, 16).map((m) => ledgerRow(m)),
  ...CAT37,
});
const g19Rows = () => ({ ...baseRows(), [LEDGER]: MIGS.map((m) => ledgerRow(m)), ...CAT38 });
const fnLines = (names, from) => names.map((f, i) => `${from + i}; 1255 9 FUNCTION public ${f} postgres`);
const trgLines = (names, from) => names.map((t, i) => `${from + i}; 2620 9 TRIGGER public ${t} postgres`);
const G14_FN = ['fn_sale_payment_history()', 'fn_sale_payment_truncate_guard()', 'fn_sale_wholesale_frozen_after_payment()', 'fn_checkout_attempt_commit_check()',
  'fn_checkout_attempt_declaration_guard()', 'fn_checkout_attempt_guard()', 'fn_checkout_attempt_tender_guard()', 'fn_checkout_declaration_commit_check()', 'fn_external_collection_guard()'];
const G14_TRG = ['SalePayment trg_sale_payment_history_before', 'SalePayment trg_sale_payment_history_after', 'SalePayment trg_sale_payment_truncate_guard',
  'Sale trg_sale_wholesale_frozen_after_payment', 'CheckoutAttempt trg_checkout_attempt_commit_check', 'CheckoutAttempt trg_checkout_attempt_guard',
  'CheckoutAttemptDeclaration trg_checkout_attempt_declaration_guard', 'CheckoutAttemptDeclaration trg_checkout_declaration_commit_check',
  'CheckoutAttemptTender trg_checkout_attempt_tender_guard', 'ExternalCollection trg_external_collection_guard'];
const VOID_FN = ['fn_cash_movement_refund_guard()', 'fn_sale_payment_refund_frozen()'];
const VOID_TRG = ['CashMovement trg_cash_movement_refund_guard', 'SalePayment trg_sale_payment_refund_frozen'];
const EXCH_FN = ['fn_sale_exchange_append_only()', 'fn_sale_exchange_has_lines()', 'fn_sale_exchange_header_guard()', 'fn_sale_exchange_ledger_check()',
  'fn_sale_exchange_line_remainder()', 'fn_sale_exchange_void_guard()', 'fn_sale_void_exchange_guard()'];
const EXCH_TRG = ['SaleExchange trg_sale_exchange_append_only', 'SaleExchange trg_sale_exchange_has_lines', 'SaleExchange trg_sale_exchange_header_guard',
  'SaleExchange trg_sale_exchange_void_guard', 'SaleExchangeLine trg_sale_exchange_line_append_only', 'SaleExchangeLine trg_sale_exchange_line_ledger_check',
  'SaleExchangeLine trg_sale_exchange_line_remainder', 'SaleVoid trg_sale_void_exchange_guard', 'StockMovement trg_stock_movement_sale_exchange_ledger_check',
  'StockMovement trg_stock_movement_sale_exchange_no_delete', 'StockMovement trg_stock_movement_sale_exchange_no_update'];
const G16_FN_TRG = [...fnLines([...G14_FN, ...VOID_FN], 200), ...trgLines([...G14_TRG, ...VOID_TRG], 240)];
const G19_FN_TRG = [...fnLines([...G14_FN, ...VOID_FN, ...EXCH_FN], 200), ...trgLines([...G14_TRG, ...VOID_TRG, ...EXCH_TRG], 240)];
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

function fixture({ rows = baseRows(), tables = G16_TABLES, toc = tocText({ tables, extra: G16_FN_TRG }), manifestMutate, archiveBytes = Buffer.from('PGDMP\u0001fixture-archive-bytes'), workName = 'clones',
  key = KEY, ledgerState = 'EXACT_G16', catalog = 'CATALOG_37', homeKey = `${KEY}\n`, homeMarker = `${MID}\n` } = {}) {
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
    rbacCatalog: { catalog, digest: RBACG.CATALOG_GENERATION_DIGESTS[catalog], permissions: { CATALOG_36: 36, CATALOG_37: 37, CATALOG_38: 38 }[catalog], grants: { CATALOG_36: 75, CATALOG_37: 76, CATALOG_38: 77 }[catalog] },
    schemaReferenceDigest: SYN_DIGEST,
  };
  manifestMutate?.(fields);
  const manifest = `${archive}.manifest.json`;
  realFs.writeFileSync(manifest, B.buildDumpManifest({ ...fields, mac: B.computeManifestMac(key, fields) }), { mode: 0o600 }); realFs.chmodSync(manifest, 0o600);
  return { base, home, store, work, archive, manifest, archiveBytes, rows, tables, toc, ledgerState };
}
// Complete, self-consistent EXACT_G16 / EXACT_G19 fixtures plus the matching world options.
const g16 = () => fixture();
const g19 = () => { const rows = g19Rows(); return fixture({ rows, tables: G19_TABLES, toc: tocText({ tables: G19_TABLES, extra: G19_FN_TRG }), ledgerState: 'EXACT_G19', catalog: 'CATALOG_38' }); };
const worldOf = (fx, o = {}) => ({ archiveData: dataText(fx.rows, fx.tables), toc: fx.toc, restoredRows: fx.rows, cloneTables: fx.tables, ...o });

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
  const repoSha = new Map([...MIGS.map((m) => [`api/prisma/migrations/${m}/migration.sql`, MIG_SHA[m]]), ['scripts/database/pilot-g19-backup.mjs', PB_SHA]]);
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
const kids = (w, bin) => w.calls.filter((c) => c.file === `${PG}/${bin}`);const keptRunDir = (fx, r) => { assert.ok(r.workListing.some((n) => n.startsWith('c-')), 'the run directory is kept for inspection'); };
const REAL_SHARED = async () => C.adaptShared({ generations: GEN, references: REFS19, rbac: RBACG, rbacBase: RBAC, projection: P });

// ---------------- arguments ----------------
test('G19CL args: only EXACT_G16 and EXACT_G19, absolute safe paths, exact shape', () => {
  const ok = (state) => C.parseArgs(['--archive=/a/b.dump', '--manifest=/a/b.dump.manifest.json', '--work-root=/w', `--expected-state=${state}`]);
  assert.equal(ok('EXACT_G16').ok, true); assert.equal(ok('EXACT_G19').ok, true);
  for (const s of ['EXACT_S4', 'EXACT_G7', 'EXACT_G11', 'EXACT_G14', 'EXACT_G15', 'EXACT_G17', 'EXACT_G18', 'EXACT_G20', '']) assert.equal(ok(s).ok, false, s);
  assert.equal(C.parseArgs(['--archive=rel', '--manifest=/a', '--work-root=/w', '--expected-state=EXACT_G19']).ok, false);
  assert.equal(C.parseArgs([]).ok, false);
});

// ---------------- happy paths ----------------
test('G19CL EXACT_G16: two isolated clones restored and measured, VERIFIED, own dirs removed', async () => {
  const fx = g16();
  const r = await go(fx, worldOf(fx));
  assert.equal(r.rc, 0, r.text); assert.equal(r.last, 'A5C_RESULT=VERIFIED');
  assert.equal(kids(r.w, 'initdb').length, 2);
  assert.equal(kids(r.w, 'pg_ctl').filter((c) => c.args[0] === 'stop').length, 2);
  assert.deepEqual(r.workListing, []);
  assert.match(r.text, /tables=34/); assert.match(r.text, /ledger state=EXACT_G16 rows=16/); assert.match(r.text, /rbac catalog=CATALOG_37/);
});
test('G19CL EXACT_G19 (with synthetic pinned references): 36 tables, exact 19-migration ledger, CATALOG_38', async () => {
  const fx = g19();
  const r = await go(fx, worldOf(fx));
  assert.equal(r.rc, 0, r.text); assert.equal(r.last, 'A5C_RESULT=VERIFIED');
  assert.match(r.text, /tables=36/); assert.match(r.text, /ledger state=EXACT_G19 rows=19/); assert.match(r.text, /rbac catalog=CATALOG_38/);
});
test('G19CL EXACT_G19 with CATALOG_37 (the RBAC upgrade not yet run) is a valid state of the proof', async () => {
  const rows = { ...g19Rows(), ...CAT37 };
  const fx = fixture({ rows, tables: G19_TABLES, toc: tocText({ tables: G19_TABLES, extra: G19_FN_TRG }), ledgerState: 'EXACT_G19', catalog: 'CATALOG_37' });
  const r = await go(fx, worldOf(fx));
  assert.equal(r.rc, 0, r.text); assert.match(r.text, /rbac catalog=CATALOG_37/);
});

// ---------------- the reference gate (a pending reference is refused) ----------------
test('G19CL the REAL references are pinned: the reference gate passes for both states; a reference that is pending (null) is refused BEFORE any cluster, input or child', async () => {
  const pendingShared = async () => C.adaptShared({ generations: GEN, rbac: RBACG, rbacBase: RBAC, projection: P,
    references: { ...REFS19, SCHEMA_REFERENCES_G19: { ...REFS19.SCHEMA_REFERENCES_G19, EXACT_G19: { digest: null, pending: true } } } });
  const fx = g19();
  const r = await go(fx, worldOf(fx, { importShared: pendingShared }));
  assert.equal(r.rc, 3, r.text); assert.match(r.text, /phase=reference/); assert.match(r.text, /PENDING/);
  assert.equal(r.w.calls.length, 0, 'no child at all'); assert.equal(r.last, 'A5C_RESULT=REFUSED'); assert.deepEqual(r.workListing, []);
  for (const make of [g16, g19]) {
    const f = make();
    const real = await go(f, worldOf(f, { importShared: REAL_SHARED }));
    assert.doesNotMatch(real.text, /phase=reference/, 'a pinned reference passes the gate (a later gate may still stop this synthetic fixture)');
  }
});

// ---------------- provenance: only a G19 backup of the OWNER ----------------
test('G19CL a manifest declaring another state than the OWNER named is refused before any cluster', async () => {
  const fx = g19();
  const r = await go(fx, worldOf(fx), [`--archive=${fx.archive}`, `--manifest=${fx.manifest}`, `--work-root=${fx.work}`, '--expected-state=EXACT_G16']);
  assert.equal(r.rc, 3); assert.match(r.text, /declares EXACT_G19, the OWNER expected EXACT_G16/); assert.equal(kids(r.w, 'initdb').length, 0);
});
test('G19CL a G14-format manifest (pilot-backup.mjs) is refused as a manifest; a foreign MAC key, another tool digest and another marker are refused as provenance', async () => {
  const fx = g16();
  realFs.writeFileSync(fx.manifest, realFs.readFileSync(fx.manifest, 'utf8').replace('mona-pilot-backup-g19/v1', 'mona-pilot-backup/v2'));
  const a = await go(fx, worldOf(fx)); assert.equal(a.rc, 3); assert.match(a.text, /phase=manifest/); assert.equal(a.w.calls.length, 0);
  const foreign = await go(fixture({ key: 'ab'.repeat(32) })); assert.equal(foreign.rc, 3); assert.match(foreign.text, /phase=provenance/);
  const tool = await go(fixture({ manifestMutate: (f) => { f.toolSha256 = 'c'.repeat(64); } })); assert.equal(tool.rc, 3); assert.match(tool.text, /pinned pilot-g19-backup\.mjs/);
  const mk = await go(fixture({ homeMarker: '99999999-9999-4999-8999-999999999999\n' })); assert.equal(mk.rc, 3); assert.match(mk.text, /phase=provenance/);
});

// ---------------- archive / measurement refusals ----------------
test('G19CL the archive disagreeing with its manifest or the expected state is refused before any cluster', async () => {
  // manifest says CATALOG_37 for G16 but the archive carries CATALOG_38; and the other way: G19 manifest, archive without the exchange objects
  const rows38 = { ...baseRows(), ...CAT38 };
  const fx = fixture({ rows: rows38, catalog: 'CATALOG_37' });
  const a = await go(fx, worldOf(fx)); assert.equal(a.rc, 3); assert.match(a.text, /phase=archive/); assert.equal(kids(a.w, 'initdb').length, 0);
  const g = g19();
  const b = await go(g, worldOf(g, { toc: tocText({ tables: G16_TABLES, extra: G16_FN_TRG }) })); assert.equal(b.rc, 3); assert.equal(kids(b.w, 'initdb').length, 0);
});
test('G19CL the restored ledger, catalog and invariants are judged: a G18 ledger under a G19 manifest, a wrong catalog and a hard invariant → FAILED', async () => {
  const fx = g19();
  const ledger = await go(fx, worldOf(fx, { ledger: dbLedger(MIGS.slice(0, 18).map((m) => ledgerRow(m))) }));
  assert.equal(ledger.rc, 6); assert.match(ledger.text, /check ledger=FAIL/);
  const extra = dbCatalog(CAT37); extra.grants.push({ roleId: extra.roles[0].id, permissionId: '00000000-0000-4000-9400-000000000038' });
  const rbac = await go(fx, worldOf(fx, { restoredCatalog: extra })); assert.equal(rbac.rc, 6); assert.match(rbac.text, /check rbac=FAIL/);
  for (const k of ['registers_multi_open', 'orphan_movements']) {
    const r = await go(fx, worldOf(fx, { invariants: { [k]: '1' } })); assert.equal(r.rc, 6); assert.match(r.text, /check invariants=FAIL/);
  }
});
test('G19CL schema/fingerprint drift between the two runs is FAILED', async () => {
  const fx = g19();
  const s = await go(fx, worldOf(fx, { run2Projection: { ...SYN_RAW, indexes: [] } })); assert.equal(s.rc, 6); assert.match(s.text, /check schema=FAIL/);
  const r2 = g19Rows(); r2.Company[0][1] = 'Other';
  const f = await go(fx, worldOf(fx, { run2Rows: r2, cloneDump: () => dataText(fx.rows, fx.tables) })); assert.equal(f.rc, 6); assert.match(f.text, /fingerprint/);
});

// ---------------- isolation and the stop proof (unchanged behavior, exercised on the G19 states) ----------------
test('G19CL initdb: non-root bootstrap superuser, trust only on the private socket, UTF8/C, inside the run dir; listen_addresses empty', async () => {
  const fx = g19();
  let conf = null;
  const r = await go(fx, worldOf(fx, { onChild: ({ file, args }) => { if (file.endsWith('pg_ctl') && args[0] === 'start' && conf === null) conf = realFs.readFileSync(path.join(args.find((x) => x.startsWith('--pgdata=')).slice(9), 'postgresql.conf'), 'utf8'); } }));
  assert.equal(r.rc, 0, r.text);
  const a = kids(r.w, 'initdb')[0].args;
  assert.ok(a.includes(`--username=${C.ADMIN_ROLE}`) && a.includes('--auth=trust') && a.includes('--encoding=UTF8') && a.includes('--locale=C'));
  assert.ok(a.find((x) => x.startsWith('--pgdata=')).slice(9).startsWith(`${fx.work}/c-abcdef01/`));
  assert.match(conf, /^listen_addresses = ''$/m);
});
test('G19CL pg_ctl stop that lies / a surviving backend / a lingering socket → FAILED and the run directory is kept', async () => {
  for (const o of [{ stopLies: true, unkillable: true }, { childSurvives: true, unkillable: true }, { socketLingers: true }]) {
    const fx = g19();
    const r = await go(fx, worldOf(fx, o));
    assert.equal(r.rc, 6); assert.equal(r.last, 'A5C_RESULT=FAILED'); keptRunDir(fx, r);
  }
});
test('G19CL network isolation and root are refused before anything', async () => {
  const fx = g16();
  const net = await go(fx, worldOf(fx, { netdev: 'Inter-|   Receive\n face |bytes\n    lo: 0\n  eth0: 1\n' })); assert.equal(net.rc, 3); assert.match(net.text, /phase=network/); assert.equal(net.w.calls.length, 0);
  const root = await go(fx, worldOf(fx, { uid: 0 })); assert.equal(root.rc, 3); assert.match(root.text, /phase=uid/);
});
test('G19CL shared modules unavailable or malformed → refused at integrity before any child', async () => {
  for (const importShared of [async () => { throw new Error('x'); }, async () => ({ ...SHARED, projection: {} }), async () => ({ ...SHARED, states: {} })]) {
    const fx = g16();
    const r = await go(fx, worldOf(fx, { importShared }));
    assert.equal(r.rc, 3); assert.match(r.text, /phase=integrity/); assert.equal(r.w.calls.length, 0);
  }
});

// ---------------- the constants are the reviewed ones ----------------
test('G19CL REQUIRED_REPO_FILES pin the G19 backup (not the G14 one), both launch modules, the generation modules and the nineteen migrations — all present on disk', () => {
  const root = path.resolve('.');
  for (const rel of C.REQUIRED_REPO_FILES) assert.ok(realFs.existsSync(path.join(root, rel)), rel);
  for (const needed of ['scripts/database/pilot-g19-backup.mjs', 'scripts/database/pilot-launch-command.mjs', 'scripts/database/pilot-g19-launch-command.mjs',
    'scripts/database/pilot-migration-generations.mjs', 'scripts/database/pilot-g19-schema-references.mjs', 'scripts/database/pilot-rbac-catalog-generations.mjs',
    'scripts/database/pilot-rbac-catalog.mjs', 'scripts/database/app-schema-projection.mjs']) assert.ok(C.REQUIRED_REPO_FILES.includes(needed), needed);
  assert.ok(!C.REQUIRED_REPO_FILES.includes('scripts/database/pilot-backup.mjs'));
  assert.equal(C.REQUIRED_REPO_FILES.filter((f) => f.startsWith('api/prisma/migrations/')).length, 19);
});
test('G19CL adaptShared exposes the shape the proof consumes; the G19 reference is pinned in the repository', () => {
  const shared = REAL_SHARED();
  return shared.then((s) => {
    assert.equal(typeof s.states.requireState, 'function'); assert.equal(typeof s.rbac.classifyCatalog, 'function'); assert.ok(s.rbac.CATALOG_SQL.roles);
    assert.match(s.references.SCHEMA_REFERENCES.EXACT_G19.digest, /^[0-9a-f]{64}$/);
    assert.ok(Array.isArray(s.references.STATE_PROBES.EXACT_G19));
    assert.match(s.references.SCHEMA_REFERENCES.EXACT_G16.digest, /^[0-9a-f]{64}$/);
  });
});
