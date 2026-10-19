// OWNER-only restore proof for a PILOT backup produced by pilot-backup.mjs (A5-1). It never
// contacts any remote database: it restores the archive TWICE into disposable PostgreSQL 17
// clusters it creates itself, inside a network namespace that has only loopback, reachable
// only through a Unix socket in its own 0700 directory, and compares measurements.
//
//   unshare -U -n --map-current-user env -i PATH=/usr/bin:/bin LANG=C.UTF-8 \
//     node scripts/database/pilot-clone-restore.mjs --archive=<abs> --manifest=<abs>.manifest.json --work-root=<abs dir> \
//       --expected-state=EXACT_S4|EXACT_G7|EXACT_G11
//   (the exact OWNER command is produced by pilot-launch-command.mjs; it pins this file)
//
// Gates before any process: arguments ([A-Za-z0-9/._-] absolute paths), not root, exact env
// (PATH/LANG only), code-integrity manifest (repo files incl. migrations, npm closure, the five
// PostgreSQL binaries), only `lo` in /proc/self/net/dev. Inputs: archive and manifest are
// private 0600 regular files (no symlink/FIFO) in a private 0700 symlink-free directory outside
// repository and temporary storage; the manifest is <archive>.manifest.json, canonical and
// strict, and pins the archive size and SHA-256. Before any cluster exists, the archive is
// inspected offline over stdin: TOC digest = manifest, object allowlist, DDL without untrusted
// languages or program/file access, and every public table's COPY data = manifest digests.
//
// Provenance before any cluster: the manifest must carry a valid HMAC under the OWNER key
// (~/.config/mona-jacinta/pilot-backup-mac-key), the pinned pilot-backup.mjs digest, the PILOT ref
// digest and the private marker's digest; the archive marker row must match; the manifest state must
// be the OWNER-named --expected-state (never re-targeted) and the archive must be exactly that state
// (ledger, tables, functions, triggers, RBAC catalog); the manifest-bound app-schema reference digest
// must be the current generated reference; the manifest time must fit the archive creation time.
//
// Each run (exclusive run directory c-<random>, never reused, and deleted only while it is
// still the same inode and only after every run was verifiably stopped): initdb (bootstrap superuser, trust on the private socket only), config
// listen_addresses='' + socket in the run dir, pg_ctl start, clone identity proven
// (data_directory, empty listen_addresses, socket dir, PostgreSQL 17, Unix-socket session),
// a NON-superuser restorer role owning a fresh database, pg_restore of schema public only
// (--exit-on-error --single-transaction --no-owner --no-privileges, archive bytes on stdin),
// then measurements: no schema but public, table set = manifest, FROM ONLY counts = manifest,
// FROM ONLY row fingerprints, the ledger exactly at the expected state (shared strict classifier), the
// app-owned schema projection (search_path pinned) whose digest must equal the generated reference and
// whose semantic probes must pass, the RBAC catalog = the manifest's, the cash/sales invariants, and a
// pg_dump of the restored data whose COPY digests must equal the manifest (round trip).
// Children get an empty private HOME with pinned libpq files. pg_ctl stop always runs and is never
// trusted alone: every recorded postgres process (pid + start time) must be gone and the pid file,
// socket and socket lock released (escalation: fast, immediate, SIGKILL of recorded processes only);
// otherwise the run is FAILED and its directory kept. The verdict comes only from these booleans. Child stderr and the
// server log are never printed; no row value is ever printed.
//
// Exit codes: 0 VERIFIED, 1 arguments, 3 gate refused, 4 unexpected error, 6 FAILED.

import { randomBytes } from 'node:crypto';
import { spawn as nodeSpawn } from 'node:child_process';
import * as nodeFs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  canonicalJson, checkNoSymlinkComponents, checkPrivateDir, checkRuntime, isUnderAny, readPrivateFile, runChild,
  safePathChars, sha256, verifyCodeManifest,
} from './pilot-launch-command.mjs';

const PREFIX = '[db:pilot-clone]';
const BIN = '/usr/lib/postgresql/17/bin';
export const INITDB = `${BIN}/initdb`;
export const PG_CTL = `${BIN}/pg_ctl`;
export const PG_RESTORE_BIN = `${BIN}/pg_restore`;
const PG_DUMP_BIN = `${BIN}/pg_dump`;
const POSTGRES_BIN = `${BIN}/postgres`;
const MANIFEST_REL = 'scripts/database/pilot-clone-restore.manifest.json';
export const ADMIN_ROLE = 'mona_clone_admin';
export const RESTORE_ROLE = 'mona_clone_restorer';
export const CLONE_DB = 'mona_clone';
const PORT = 5432;
const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const MAX_DUMP_MANIFEST_BYTES = 1024 * 1024;
const MAX_SOCKET_PATH = 100;
const ROW_CAP = 5_000_000;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CHILD_ENV = Object.freeze({ PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', PGTZ: 'UTC' });
const T = Object.freeze({ initdb: 120000, start: 90000, stop: 90000, inspect: 600000, restore: 1800000, dump: 1800000 });

const MIGRATIONS = Object.freeze([
  '20260907015311_init', '20260912182432_add_company_location', '20260912191702_add_user_role_scope',
  '20260922210000_d3_initial_stock_and_global_audit', '20261002120000_block1_pricing_wholesale',
  '20261006120000_pilot_pricing_v2', '20261012120000_cash_session_reconciliation',
  '20261016120000_r3_proportional_checkout', '20261016130000_r3_checkout_attempts',
  '20261018120000_cash_movement_withdrawals_expenses', '20261018180000_cash_movement_reversals',
]);
// The builtins-only shared cut-over modules: pinned by the manifest, imported only after it verified.
const SHARED_MODULES = Object.freeze({
  states: 'scripts/database/pilot-migration-states.mjs',
  references: 'scripts/database/pilot-schema-references.mjs',
  rbac: 'scripts/database/pilot-rbac-catalog.mjs',
  projection: 'scripts/database/app-schema-projection.mjs',
});
const EXACT_STATES = Object.freeze(['EXACT_S4', 'EXACT_G7', 'EXACT_G11']);
const PACKAGE_CLOSURE = Object.freeze(['pg', 'pg-connection-string', 'pg-pool', 'pg-protocol', 'pg-types', 'pgpass',
  'split2', 'pg-int8', 'postgres-array', 'postgres-bytea', 'postgres-date', 'postgres-interval', 'pg-cloudflare', 'xtend']);
export const REQUIRED_REPO_FILES = Object.freeze(['scripts/database/pilot-backup.mjs', 'scripts/database/pilot-launch-command.mjs',
  ...Object.values(SHARED_MODULES), ...MIGRATIONS.map((m) => `api/prisma/migrations/${m}/migration.sql`)]);
// Cash/sales invariants over columns present in every exact state. HARD ones must be 0; the others are
// reported (and must agree between the two runs) — the cut-over runbook decides on them.
export const HARD_INVARIANTS = Object.freeze(['registers_multi_open', 'session_close_mismatch', 'orphan_movements', 'orphan_payment_sessions']);
export const INFO_INVARIANTS = Object.freeze(['open_sessions', 'sale_total_mismatch', 'paid_payment_mismatch']);

// Every statement the tool sends; table names are interpolated only after IDENT validation.
export const CLONE_SQL = Object.freeze({
  identity: "SELECT current_setting('data_directory') AS data_directory, current_setting('listen_addresses') AS listen_addresses, "
    + "current_setting('unix_socket_directories') AS unix_socket_directories, current_setting('server_version_num') AS server_version_num, "
    + 'inet_server_addr() IS NULL AS via_socket, current_database() AS database, '
    + "current_setting('is_superuser') AS superuser",
  setup: Object.freeze([
    `CREATE ROLE ${RESTORE_ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
    `CREATE DATABASE ${CLONE_DB} OWNER ${RESTORE_ROLE} TEMPLATE template0 ENCODING 'UTF8' LOCALE 'C'`,
  ]),
  schemas: "SELECT nspname FROM pg_catalog.pg_namespace WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema' ORDER BY nspname",
  tables: "SELECT c.relname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' "
    + "AND c.relkind IN ('r', 'p', 'v', 'm', 'f') ORDER BY c.relname",
  ledger: 'SELECT migration_name, checksum, finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS rolled_back, applied_steps_count::text AS applied_steps_count '
    + 'FROM ONLY public."_prisma_migrations"',
  // Every measuring session pins search_path first (the projection's format_type/pg_get_*def depend on it).
  pinSearchPath: "SELECT pg_catalog.set_config('search_path', 'pg_catalog, pg_temp', false)",
  // Value rendering of every measured row is pinned too: fingerprints never depend on the timezone initdb took from the host.
  pinTimeZone: "SELECT pg_catalog.set_config('TimeZone', 'UTC', false), pg_catalog.set_config('DateStyle', 'ISO, MDY', false)",
  invariants: 'SELECT '
    + `(SELECT count(*) FROM ONLY public."CashSession" WHERE status = 'OPEN')::text AS open_sessions, `
    + `(SELECT count(*) FROM (SELECT "registerId" FROM ONLY public."CashSession" WHERE status = 'OPEN' GROUP BY "registerId" HAVING count(*) > 1) x)::text AS registers_multi_open, `
    + `(SELECT count(*) FROM ONLY public."CashSession" WHERE (status = 'OPEN') <> ("closedAt" IS NULL))::text AS session_close_mismatch, `
    + '(SELECT count(*) FROM ONLY public."CashMovement" m WHERE NOT EXISTS (SELECT 1 FROM ONLY public."CashSession" s WHERE s.id = m."sessionId"))::text AS orphan_movements, '
    + '(SELECT count(*) FROM ONLY public."SalePayment" p WHERE p."cashSessionId" IS NOT NULL '
    + 'AND NOT EXISTS (SELECT 1 FROM ONLY public."CashSession" s WHERE s.id = p."cashSessionId"))::text AS orphan_payment_sessions, '
    + '(SELECT count(*) FROM ONLY public."Sale" WHERE total <> subtotal - "discountTotal")::text AS sale_total_mismatch, '
    + `(SELECT count(*) FROM ONLY public."Sale" s WHERE s.status IN ('PAID', 'COMPLETED') `
    + 'AND s.total <> COALESCE((SELECT sum(p.amount) FROM ONLY public."SalePayment" p WHERE p."saleId" = s.id), 0))::text AS paid_payment_mismatch',
  count: (t) => `SELECT count(*)::text AS n FROM ONLY public."${t}"`,
  rows: (t) => `SELECT * FROM ONLY public."${t}"`,
});

export function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.length !== 4) return { ok: false };
  const out = {};
  for (const a of argv) {
    const m = /^--(archive|manifest|work-root|expected-state)=(.*)$/.exec(a);
    if (!m || Object.hasOwn(out, m[1])) return { ok: false };
    if (m[1] === 'expected-state' ? !EXACT_STATES.includes(m[2]) : !safePathChars(m[2])) return { ok: false };
    out[m[1]] = m[2];
  }
  if (Object.keys(out).length !== 4) return { ok: false };
  return { ok: true, archive: out.archive, manifest: out.manifest, workRoot: out['work-root'], expectedState: out['expected-state'] };
}

// The raw-text client returns booleans as 't'/'f'. Only the named fields are converted; anything else refuses.
const PG_BOOL = (v) => (v === true || v === 't' ? true : v === false || v === 'f' ? false : null);
export function boolFields(rows, fields) {
  return rows.map((r) => {
    const out = { ...r };
    for (const f of fields) { const b = PG_BOOL(r[f]); if (b === null) throw new Error('malformed boolean'); out[f] = b; }
    return out;
  });
}
// The restored ledger in the shared classifier's shape; applied_steps_count must be a plain integer.
export function cloneLedgerRows(rows) {
  if (!rows.every((r) => /^[0-9]{1,9}$/.test(String(r.applied_steps_count)))) return null;
  try { return boolFields(rows, ['finished', 'rolled_back']).map(({ migration_name, checksum, finished, rolled_back }) => ({ migration_name, checksum, finished, rolled_back })); } catch { return null; }
}
export function checkInvariants(row) {
  const values = {};
  for (const k of [...INFO_INVARIANTS, ...HARD_INVARIANTS]) {
    const v = row?.[k];
    if (typeof v !== 'string' || !/^[0-9]{1,12}$/.test(v)) return { ok: false, values: null };
    values[k] = Number(v);
  }
  return { ok: HARD_INVARIANTS.every((k) => values[k] === 0), values };
}

// /proc/self/net/dev of this process's network namespace must list exactly one interface: lo.
export function checkNetworkIsolation(text) {
  if (typeof text !== 'string') return { ok: false };
  const names = text.split('\n').slice(2).map((l) => l.split(':')[0].trim()).filter(Boolean);
  return { ok: names.length === 1 && names[0] === 'lo', interfaces: names.length };
}

// Order-independent digest of rows (arrays of raw text or null).
export function fingerprintRows(rows) {
  return sha256(rows.map((r) => JSON.stringify(r)).sort().join('\n'));
}

export function compareMeasurements(a, b) {
  return { equal: canonicalJson(a) === canonicalJson(b) };
}

// Real process view of this user namespace (/proc): state, parent, start time (clock ticks since boot) and
// executable. A pid is "the same process" only while its start time is unchanged (pid-reuse safe).
const realProcs = {
  stat: (pid) => {
    try {
      const raw = nodeFs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const rest = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
      let exe = null;
      try { exe = nodeFs.readlinkSync(`/proc/${pid}/exe`); } catch { exe = null; }
      return { state: rest[0], ppid: Number(rest[1]), start: rest[19], exe };
    } catch { return null; }
  },
  children: (pid) => {
    const out = [];
    for (const d of nodeFs.readdirSync('/proc')) {
      if (!/^[0-9]+$/.test(d)) continue;
      const st = realProcs.stat(Number(d));
      if (st && st.ppid === pid) out.push(Number(d));
    }
    return out;
  },
  kill: (pid, sig) => { try { process.kill(pid, sig); } catch { /* already gone */ } },
};

function defaultDeps() {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const pgUrl = pathToFileURL(path.join(root, 'node_modules', 'pg', 'esm', 'index.mjs')).href;
  return {
    env: process.env, uid: process.getuid(), execArgv: process.execArgv, version: process.version, fs: nodeFs, root,
    homedir: os.userInfo().homedir,
    verifyManifest: () => verifyCodeManifest({
      root, manifestRel: MANIFEST_REL, fs: nodeFs, tool: 'pilot-clone-restore', requiredRepoFiles: REQUIRED_REPO_FILES,
      packageClosure: PACKAGE_CLOSURE, binaries: [INITDB, PG_CTL, PG_RESTORE_BIN, PG_DUMP_BIN, POSTGRES_BIN],
      resolvePg: () => fileURLToPath(import.meta.resolve('pg')),
    }),
    importBackupLib: () => import(pathToFileURL(path.join(root, 'scripts', 'database', 'pilot-backup.mjs')).href),
    importShared: async () => {
      const entries = await Promise.all(Object.entries(SHARED_MODULES).map(async ([k, rel]) => [k, await import(pathToFileURL(path.join(root, rel)).href)]));
      return Object.fromEntries(entries);
    },
    readNetDev: () => nodeFs.readFileSync('/proc/self/net/dev', 'utf8'),
    forbiddenRoots: [root.replace(/\/$/, ''), '/tmp', '/var/tmp', '/dev/shm', '/run', '/proc', '/sys'],
    runChild: (file, args, opts) => runChild(nodeSpawn, file, args, opts),
    connect: async (cfg) => {
      const { default: pg } = await import(pgUrl);
      // Raw text for every type: fingerprints see exactly what the server printed.
      const raw = { getTypeParser: () => (v) => v };
      const client = new pg.Client({ ...cfg, types: raw, connectionTimeoutMillis: 15000, query_timeout: 1800000, application_name: 'mona-pilot-clone' });
      await client.connect();
      return {
        query: (text, opt = {}) => client.query(opt.array ? { text, rowMode: 'array' } : { text }),
        end: () => client.end(),
      };
    },
    procs: realProcs, stopVerifyMs: 15000, pollMs: 100,
    randomHex: (n) => randomBytes(n).toString('hex'),
    log: (line) => console.log(line), error: (line) => console.error(line),
  };
}

export async function main(argv, overrides = {}) {
  const deps = { ...defaultDeps(), ...overrides };
  const fs = deps.fs;
  const say = (line) => deps.log(`${PREFIX} ${line}`);
  const end = (result, rc) => { deps.log(`A5C_RESULT=${result}`); return rc; };
  const refuse = (phase, reason, rc = 3) => { deps.error(`${PREFIX} REFUSED: phase=${phase} — ${reason}`); return end('REFUSED', rc); };

  const args = parseArgs(argv);
  if (!args.ok) return refuse('args', `exactly --archive, --manifest, --work-root (absolute, [A-Za-z0-9/._-]) and --expected-state=${EXACT_STATES.join('|')} are accepted (not echoed)`, 1);
  if (deps.uid === 0) return refuse('uid', 'must not run as root (initdb/postgres refuse it; the clone runs as the invoking user)');
  const rt = checkRuntime({ env: deps.env, execArgv: deps.execArgv, version: deps.version, expectedKeys: ['LANG', 'PATH'], homedir: undefined });
  if (!rt.ok) return refuse(rt.phase, rt.reason);
  const integrity = deps.verifyManifest();
  if (!integrity?.ok) return refuse('integrity', integrity?.reason ?? 'code manifest verification failed');
  let net;
  try { net = checkNetworkIsolation(deps.readNetDev()); } catch { net = { ok: false }; }
  if (!net.ok) return refuse('network', 'the process is not in a network namespace with only loopback (launch with unshare -U -n)');
  let B;
  try { B = await deps.importBackupLib(); } catch { return refuse('integrity', 'pilot-backup.mjs could not be loaded'); }
  let shared;
  try {
    shared = await deps.importShared();
    if (typeof shared?.states?.requireState !== 'function' || typeof shared?.rbac?.classifyCatalog !== 'function'
      || typeof shared?.projection?.readProjection !== 'function' || typeof shared?.projection?.runProbes !== 'function') throw new Error('shape');
  } catch {
    return refuse('integrity', 'the shared cut-over modules could not be loaded');
  }
  const reference = shared.references?.SCHEMA_REFERENCES?.[args.expectedState]?.digest;
  const probes = shared.references?.STATE_PROBES?.[args.expectedState];
  if (!/^[0-9a-f]{64}$/.test(String(reference)) || !Array.isArray(probes)) return refuse('reference', `no generated app-schema reference/probes for ${args.expectedState}`);
  const backupToolSha = integrity.repoSha?.get?.('scripts/database/pilot-backup.mjs');
  if (typeof backupToolSha !== 'string') return refuse('integrity', 'the pinned backup tool digest is not available');

  // ---- OWNER provenance material (passwd home; never the URL file) ----
  const cfg = path.join(deps.homedir, '.config');
  const cdir = path.join(cfg, 'mona-jacinta');
  const cfgOk = (() => { try { const s = fs.lstatSync(cfg); return s.isDirectory() && !s.isSymbolicLink() && s.uid === deps.uid && (s.mode & 0o022) === 0; } catch { return false; } })();
  if (!cfgOk || !checkPrivateDir(fs, deps.uid, cdir)) return refuse('provenance', 'private configuration directories must be real, owned and private');
  const keyFile = readPrivateFile(fs, deps.uid, path.join(cdir, B.MAC_KEY_FILE), 4096);
  const macKey = keyFile.ok ? B.parseMacKey(keyFile.bytes) : null;
  if (macKey === null) return refuse('provenance', `${B.MAC_KEY_FILE} must be a private 0600 file with 64 lowercase hex characters`);
  const idFile = readPrivateFile(fs, deps.uid, path.join(cdir, 'pilot-marker-id'), 4096);
  const markerId = idFile.ok ? idFile.bytes.toString('utf8').replace(/\n$/, '') : '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(markerId)) return refuse('provenance', 'pilot-marker-id must be a private file with one version-4 UUID');

  // ---- inputs ----
  const store = path.dirname(args.archive);
  if (args.manifest !== `${args.archive}.manifest.json`) return refuse('input', 'the manifest must be <archive>.manifest.json');
  if (isUnderAny(args.archive, deps.forbiddenRoots)) return refuse('input', 'the archive lies inside the repository or temporary/system storage');
  if (!checkNoSymlinkComponents(fs, store) || !checkPrivateDir(fs, deps.uid, store)) return refuse('input', 'the archive directory must be real, owned and mode 0700');
  const mf = readPrivateFile(fs, deps.uid, args.manifest, MAX_DUMP_MANIFEST_BYTES);
  if (!mf.ok) return refuse('input', `manifest: ${mf.reason}`);
  const ar = readPrivateFile(fs, deps.uid, args.archive, MAX_ARCHIVE_BYTES);
  if (!ar.ok) return refuse('input', `archive: ${ar.reason}`);
  const pm = B.parseDumpManifest(mf.bytes);
  if (!pm.ok) return refuse('manifest', pm.reason);
  const m = pm.manifest;
  const archive = ar.bytes;
  if (m.archive.file !== path.basename(args.archive) || m.archive.bytes !== archive.length || m.archive.sha256 !== sha256(archive)) {
    return refuse('archive', 'the archive does not match the size/SHA-256 pinned by its manifest');
  }
  // A SHA-256 binds the pair, not who made it: the manifest must carry the OWNER key's HMAC and the audited contract.
  if (!B.verifyManifestMac(macKey, m)) return refuse('provenance', 'the manifest is not authenticated by the OWNER backup key (foreign or replaced pair)');
  if (m.toolSha256 !== backupToolSha) return refuse('provenance', 'the backup was not produced by the pinned pilot-backup.mjs');
  if (m.refDigest !== B.REF_DIGESTS.pilot) return refuse('provenance', 'the backup is not bound to the PILOT project digest');
  if (m.markerIdDigest !== B.markerDigest(markerId)) return refuse('provenance', 'the backup is bound to another environment marker');
  if (m.ledgerState !== args.expectedState) return refuse('manifest', `the manifest declares ${m.ledgerState}, the OWNER expected ${args.expectedState}; nothing started`);
  const tables = Object.keys(m.tables).sort();
  if (!tables.every((t) => IDENT.test(t))) return refuse('manifest', 'table name outside the identifier contract');

  // ---- offline inspection, before any cluster exists (the backup tool's own verifier) ----
  const inspect = async (kind) => deps.runChild(PG_RESTORE_BIN, B.pgRestoreArgs(kind),
    { env: { ...CHILD_ENV }, input: archive, timeoutMs: T.inspect, maxStdout: MAX_ARCHIVE_BYTES })
    .then((r) => (r.status === 0 && !r.timedOut && !r.overflow ? r : { status: 1, stdout: null }));
  const v = await B.verifyArchiveBytes({ bytes: archive, pgRestore: inspect, markerId, expectedState: args.expectedState, shared });
  if (!v.ok) return refuse(v.identity ? 'provenance' : 'archive', v.reason);
  if (v.tocSha256 !== m.tocSha256) return refuse('archive', 'pg_restore --list differs from the manifest TOC digest');
  if (v.publicTables.join(',') !== tables.join(',')) return refuse('archive', 'the manifest table set differs from the archive');
  if (canonicalJson(v.tables) !== canonicalJson(m.tables)) return refuse('archive', 'the archive COPY data differs from the manifest digests');
  if (v.ledgerState !== m.ledgerState) return refuse('archive', `the archive ledger is ${v.ledgerState}, the manifest declares ${m.ledgerState}`);
  if (canonicalJson(v.rbacCatalog) !== canonicalJson(m.rbacCatalog)) return refuse('archive', 'the archive RBAC catalog differs from the manifest');
  if (m.schemaReferenceDigest !== reference || v.schemaReferenceDigest !== reference) {
    return refuse('archive', 'the manifest-bound app-schema reference differs from the current generated reference');
  }
  if (v.serverVersion !== m.serverVersion) return refuse('archive', 'the archive server version differs from the manifest');
  if (!B.withinArchiveWindow(m.createdAt, v.archiveCreatedAt)) return refuse('provenance', 'the manifest time is not consistent with the archive creation time');
  say(`phase=archive ok tables=${tables.length} ledger=${v.ledgerState} (authenticated, offline inspection over stdin)`);

  // ---- run directory ----
  const wr = args.workRoot;
  if (isUnderAny(wr, deps.forbiddenRoots)) return refuse('workdir', 'the work root lies inside the repository or temporary/system storage');
  if (!checkNoSymlinkComponents(fs, wr) || !checkPrivateDir(fs, deps.uid, wr)) return refuse('workdir', 'the work root must exist, be real, owned and mode 0700');
  const runDir = path.join(wr, `c-${deps.randomHex(4)}`);
  if (`${runDir}/r1/s/.s.PGSQL.${PORT}`.length > MAX_SOCKET_PATH) return refuse('workdir', 'the socket path would exceed 100 bytes; use a shorter work root');
  let own;
  try { fs.mkdirSync(runDir, { mode: 0o700 }); own = fs.lstatSync(runDir); } catch { return refuse('workdir', 'the run directory could not be created exclusively (exists?); nothing reused or deleted'); }
  // Empty private HOME for every cluster child (libpq never reads the operator's files).
  const childHome = path.join(runDir, 'h');
  fs.mkdirSync(childHome, { mode: 0o700 });
  const clusterEnv = { ...CHILD_ENV, ...B.pinnedLibpqEnv(childHome) };

  const runs = [];
  for (const n of [1, 2]) {
    const r = await cloneRun({ deps, fs, B, shared, expectedState: args.expectedState, probes, n, runDir, archive, tables, clusterEnv, say });
    runs.push(r);
    if (!r.ok || !r.stopped) break;
  }
  // Never delete while PostgreSQL may still be running; only the directory this run created, same inode.
  const allStopped = runs.every((r) => r.stopped);
  let cleanupOk = false;
  if (allStopped) {
    try {
      const now = fs.lstatSync(runDir);
      if (now.isDirectory() && !now.isSymbolicLink() && now.dev === own.dev && now.ino === own.ino) { fs.rmSync(runDir, { recursive: true }); cleanupOk = true; }
    } catch { cleanupOk = false; }
  }
  const ok = (b) => (b ? 'PASS' : 'FAIL');
  say(`check stopped=${ok(allStopped)}${allStopped ? '' : ' (PostgreSQL may still be running; run directory kept)'}`);
  if (!cleanupOk) say('check cleanup=FAIL (the run directory was kept, changed, or could not be removed; not deleted)');
  const failed = runs.find((r) => !r.ok);
  if (failed) { say(`check run=FAIL step=${failed.reason}`); return end('FAILED', 6); }
  if (!allStopped || runs.length !== 2) { say('check run=FAIL step=stop (not every run was verifiably stopped)'); return end('FAILED', 6); }
  const [r1, r2] = runs;
  const checks = {
    stopped: allStopped,
    schemas: r1.schemasOk && r2.schemasOk,
    tables: r1.tablesOk && r2.tablesOk,
    counts: [r1, r2].every((r) => tables.every((t) => r.counts[t] === m.tables[t].rows)),
    fingerprint: r1.fingerprint === r2.fingerprint,
    roundtrip: [r1, r2].every((r) => r.roundtrip !== null && canonicalJson(r.roundtrip) === canonicalJson(m.tables)),
    ledger: [r1, r2].every((r) => r.ledger.ok && r.ledger.state === m.ledgerState) && compareMeasurements(r1.ledger, r2.ledger).equal,
    schema: [r1, r2].every((r) => r.schema.digest === reference && r.schema.probesFailed.length === 0),
    rbac: [r1, r2].every((r) => r.rbac.ok && r.rbac.catalog === m.rbacCatalog.catalog && r.rbac.digest === m.rbacCatalog.digest),
    invariants: [r1, r2].every((r) => r.invariants.ok) && compareMeasurements(r1.invariants, r2.invariants).equal,
    cleanup: cleanupOk,
  };
  for (const [k, val] of Object.entries(checks)) if (k !== 'stopped') say(`check ${k}=${ok(val)}`);
  say(`ledger state=${r1.ledger.state ?? 'NONE'} rows=${r1.ledgerRows}${r1.ledger.ok ? '' : ` reason=${r1.ledger.reason}`}`);
  say(`schema digest=${r1.schema.digest ?? 'NONE'} reference=${r1.schema.digest === reference ? 'MATCH' : 'MISMATCH'} probes_failed=${r1.schema.probesFailed.length}`);
  for (const f of r1.schema.probesFailed) say(`schema ${f}`);
  say(`rbac catalog=${r1.rbac.ok ? r1.rbac.catalog : 'NONE'}`);
  const iv = r1.invariants.values;
  say(iv ? `invariants ${[...INFO_INVARIANTS.slice(0, 1), ...HARD_INVARIANTS, ...INFO_INVARIANTS.slice(1)].map((k) => `${k}=${iv[k]}`).join(' ')}` : 'invariants malformed');
  const total = tables.reduce((s, t) => s + (r1.counts[t] ?? 0), 0);
  say(`tables=${tables.length} rows=${total} fingerprint=${r1.fingerprint}`);
  for (const t of tables) say(`table ${t} rows=${r1.counts[t]}`);
  const verified = Object.values(checks).every(Boolean);
  return end(verified ? 'VERIFIED' : 'FAILED', verified ? 0 : 6);
}

async function cloneRun({ deps, fs, B, shared, expectedState, probes, n, runDir, archive, tables, clusterEnv, say }) {
  const rd = path.join(runDir, `r${n}`);
  const data = path.join(rd, 'data');
  const sock = path.join(rd, 's');
  fs.mkdirSync(rd, { mode: 0o700 });
  fs.mkdirSync(sock, { mode: 0o700 });
  const child = (file, args, extra) => deps.runChild(file, args, { env: { ...clusterEnv }, ...extra });
  const fail = (reason) => ({ ok: false, reason });

  const init = await child(INITDB, [`--pgdata=${data}`, `--username=${ADMIN_ROLE}`, '--auth=trust', '--encoding=UTF8', '--locale=C', '--no-instructions', '--no-sync'],
    { timeoutMs: T.initdb });
  if (init.status !== 0 || init.timedOut) return { ...fail('initdb'), stopped: true };
  const conf = path.join(data, 'postgresql.conf');
  const lines = ["listen_addresses = ''", `unix_socket_directories = '${sock}'`, 'unix_socket_permissions = 0700', `port = ${PORT}`,
    'fsync = off', 'full_page_writes = off', 'synchronous_commit = off', 'jit = off', "shared_preload_libraries = ''", 'logging_collector = off'];
  fs.appendFileSync(conf, `\n# pilot-clone-restore (disposable, socket only)\n${lines.join('\n')}\n`);
  const written = fs.readFileSync(conf, 'utf8').split('\n');
  if (!lines.every((l) => written.includes(l))) return { ...fail('config'), stopped: true };

  // Every postgres process of this cluster, recorded by pid AND start time (never a reused pid).
  const pidFile = path.join(data, 'postmaster.pid');
  const sockFile = path.join(sock, `.s.PGSQL.${PORT}`);
  const tracked = new Map();
  const track = (pid) => {
    const st = deps.procs.stat(pid);
    if (st && st.exe === POSTGRES_BIN && st.state !== 'Z' && !tracked.has(pid)) tracked.set(pid, st.start);
  };
  const trackCluster = () => {
    try {
      const first = fs.readFileSync(pidFile, 'utf8').split('\n')[0];
      if (/^[1-9][0-9]{0,9}$/.test(first)) track(Number(first));
    } catch { /* no pid file */ }
    for (const pid of [...tracked.keys()]) for (const c of deps.procs.children(pid)) track(c);
  };

  let result;
  try {
    result = await (async () => {
      const start = await child(PG_CTL, ['start', `--pgdata=${data}`, '--wait', '--timeout=60', `--log=${path.join(rd, 'server.log')}`, '--silent'], { timeoutMs: T.start });
      trackCluster();
      if (start.status !== 0 || start.timedOut) return fail('start');

      const realData = fs.realpathSync(data);
      const proveIdentity = async (c, database) => {
        const id = (await c.query(CLONE_SQL.identity)).rows[0] ?? {};
        return id.data_directory === realData && id.listen_addresses === '' && id.unix_socket_directories === sock
          && /^17[0-9]{4}$/.test(String(id.server_version_num)) && (id.via_socket === true || id.via_socket === 't')
          && id.database === database && id.superuser === 'on';
      };
      const admin = await deps.connect({ host: sock, port: PORT, user: ADMIN_ROLE, database: 'postgres' });
      try {
        if (!(await proveIdentity(admin, 'postgres'))) return fail('identity');
        for (const s of CLONE_SQL.setup) await admin.query(s);
      } finally { await admin.end(); }
      say(`run=${n} clone identity proven (own data dir, socket only, PostgreSQL 17)`);

      const restore = await child(PG_RESTORE_BIN, ['--format=custom', '--exit-on-error', '--single-transaction', '--no-owner', '--no-privileges', '--schema=public',
        `--host=${sock}`, `--port=${PORT}`, `--username=${RESTORE_ROLE}`, `--dbname=${CLONE_DB}`, '--no-password'], { input: archive, timeoutMs: T.restore });
      if (restore.status !== 0 || restore.timedOut) return fail('restore');

      const out = { ok: true, counts: {}, fingerprints: {} };
      const c = await deps.connect({ host: sock, port: PORT, user: ADMIN_ROLE, database: CLONE_DB });
      try {
        if (!(await proveIdentity(c, CLONE_DB))) return fail('identity');
        await c.query(CLONE_SQL.pinSearchPath);
        await c.query(CLONE_SQL.pinTimeZone);
        const schemas = (await c.query(CLONE_SQL.schemas)).rows.map((r) => r.nspname);
        out.schemasOk = schemas.length === 1 && schemas[0] === 'public';
        const rels = (await c.query(CLONE_SQL.tables)).rows.map((r) => r.relname).sort();
        out.tablesOk = rels.join(',') === tables.join(',');
        for (const t of tables) {
          const cnt = Number((await c.query(CLONE_SQL.count(t))).rows[0]?.n);
          if (!Number.isSafeInteger(cnt) || cnt < 0 || cnt > ROW_CAP) return fail('row cap');
          out.counts[t] = cnt;
          const rows = (await c.query(CLONE_SQL.rows(t), { array: true })).rows;
          if (rows.length !== cnt) return fail('count drift');
          out.fingerprints[t] = fingerprintRows(rows);
        }
        out.fingerprint = sha256(canonicalJson(out.fingerprints));
        const ledgerRaw = tables.includes('_prisma_migrations') ? (await c.query(CLONE_SQL.ledger)).rows : [];
        const ledgerRows = cloneLedgerRows(ledgerRaw);
        out.ledgerRows = ledgerRaw.length;
        out.ledger = ledgerRows === null ? { ok: false, state: null, reason: 'a restored ledger row is malformed' } : shared.states.requireState(ledgerRows, expectedState);
        // App-owned schema projection: booleans of the raw-text client converted field by field.
        const projClient = { query: async (text) => {
          const r = await c.query(text);
          return { rows: boolFields(r.rows, ['not_null', 'validated', 'valid'].filter((f) => r.rows.length > 0 && Object.hasOwn(r.rows[0], f))) };
        } };
        try {
          const projection = await shared.projection.readProjection(projClient);
          out.schema = { digest: shared.projection.projectionDigest(projection), probesFailed: shared.projection.runProbes(projection, probes) };
        } catch {
          out.schema = { digest: null, probesFailed: ['PROJECTION_UNREADABLE'] };
        }
        const cat = {};
        for (const k of ['roles', 'permissions', 'grants']) cat[k] = (await c.query(shared.rbac.CATALOG_SQL[k])).rows;
        out.rbac = shared.rbac.classifyCatalog(cat);
        out.invariants = checkInvariants((await c.query(CLONE_SQL.invariants)).rows[0]);
      } finally { await c.end(); }

      const dump = await child(PG_DUMP_BIN, [`--host=${sock}`, `--port=${PORT}`, `--username=${ADMIN_ROLE}`, `--dbname=${CLONE_DB}`, '--data-only', '--schema=public',
        '--format=plain', '--no-password'], { timeoutMs: T.dump, maxStdout: MAX_ARCHIVE_BYTES });
      const rt = dump.status === 0 && !dump.timedOut && !dump.overflow ? B.copyDigests(dump.stdout) : { ok: false };
      out.roundtrip = rt.ok ? rt.tables : null;
      say(`run=${n} restored and measured`);
      return out;
    })();
  } catch {
    result = fail('unexpected');
  }
  result.stopped = await stopAndVerify({ deps, child, data, pidFile, sockFile, tracked, trackCluster });
  return result;
}

// pg_ctl's own exit status is never trusted alone: the run is stopped only when every recorded postgres
// process (same pid AND start time) is gone and the pid file, socket and socket lock are released.
// Escalation: fast stop → immediate stop → SIGKILL of recorded live processes only.
async function stopAndVerify({ deps, child, data, pidFile, sockFile, tracked, trackCluster }) {
  const fs = deps.fs;
  const exists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
  const alive = () => [...tracked].filter(([pid, start]) => { const st = deps.procs.stat(pid); return st !== null && st.start === start && st.state !== 'Z'; }).map(([pid]) => pid);
  const released = () => ![pidFile, sockFile, `${sockFile}.lock`].some(exists);
  const settled = async () => {
    const until = Date.now() + deps.stopVerifyMs;
    for (;;) {
      if (alive().length === 0 && released()) return true;
      if (Date.now() >= until) return false;
      await new Promise((r) => { setTimeout(r, deps.pollMs); });
    }
  };
  try { trackCluster(); } catch { /* best effort */ }
  for (const mode of ['fast', 'immediate']) {
    const r = await child(PG_CTL, ['stop', `--pgdata=${data}`, `--mode=${mode}`, '--wait', '--timeout=60', '--silent'], { timeoutMs: T.stop });
    if (r.status === 0 && !r.timedOut && await settled()) return true;
  }
  for (const pid of alive()) deps.procs.kill(pid, 'SIGKILL');
  // Even after a successful kill the run is not "stopped": pid file / socket may be stale, so nothing is deleted.
  return settled();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).then((rc) => { process.exitCode = rc; }, () => { console.log('A5C_RESULT=ERROR'); process.exitCode = 4; });
}
