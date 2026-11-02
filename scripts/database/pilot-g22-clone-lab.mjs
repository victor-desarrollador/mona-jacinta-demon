// LABORATORY ONLY — this tool never operates against PILOT, Supabase or any remote database. It rehearses the USER-MGMT rollout (EXACT_G20 -> EXACT_G21 -> EXACT_G22)
// on a RESTORED COPY of an authenticated PILOT G20 backup, inside a disposable PostgreSQL 17 cluster that it creates itself, reachable only through a Unix socket,
// in a network namespace that has only loopback. The operational CLI (pilot-g22-migrate.mjs) stays PILOT-only and is not touched.
//
//   unshare -U -n --map-current-user env -i PATH=/usr/bin:/bin LANG=C.UTF-8 \
//     node scripts/database/pilot-g22-clone-lab.mjs --archive=<abs>.dump --manifest=<abs>.dump.manifest.json --work-root=<abs short dir> --expected-counts='<ROLLOUT_COUNTS json>'
//
// Inputs are exactly those four. There is no URL, host, target or credential input of any kind: the only database the tool can address is the cluster it
// creates under --work-root, and every connection string it builds is derived from that cluster's own socket directory (buildCloneUrl).
//
// REUSE, NOT COPY
//   - Backup authentication AND the restore proof (HMAC under the OWNER key, pinned backup tool digest, PILOT ref and marker digests, offline archive inspection, two
//     independent restores, schema/ledger/RBAC/invariants/round-trip) are the UNMODIFIED pilot-g20-clone-restore.mjs `main`, called through its documented seam. The lab
//     proceeds only if it ends A5C_RESULT=VERIFIED, and it re-reads both files afterwards to prove they were not swapped in between.
//   - The rollout is the SAME core the PILOT tools use (pilot-g22-rollout.mjs): readSnapshotOn, assessSource, runRollout (precheck -> G21 -> witness -> re-check ->
//     G22 -> verify), verifyTarget, the frozen counts. The migration payload pins (pinsOf / LOCK_PIN), verifyG22Tree and readPinned come from the PILOT tools.
//   - New code here is only what a clone needs and PILOT must never have: the cluster lifecycle (modelled on clone-restore: socket only, pid + start-time tracking,
//     stop verification), a stager whose Prisma config accepts ONLY a local Unix-socket URL (the PILOT staged config forces Supabase TLS, which a clone has not),
//     the hard isolation guard, a content fingerprint of the business tables (a count alone cannot see an UPDATE), and the failure classification.
//
// What is restored is schema `public` only (as clone-restore does). The PILOT marker lives in a different schema, so the lab recreates a local stand-in with the same
// name and the marker id that the archive itself carries (bound to the manifest's marker digest) so that the very same snapshot code runs. That stand-in is a lab fixture.
//
// Output never carries an e-mail, hash, token, URL, row value or the content of the backup: only fixed words, counts and generation names.
// Result lines: CLONE_BACKUP_VERIFIED, CLONE_EXACT_G20_VERIFIED, CLONE_G21_WITNESS_PASS, CLONE_G22_VERIFY_PASS, CLONE_COUNTS_PRESERVED and a final
// CLONE_LAB_RESULT=VERIFIED | CLONE_BACKUP_REJECTED | CLONE_RESTORE_FAILED | CLONE_SOURCE_INVALID | CLONE_G21_FAILED | CLONE_G21_WITNESS_FAILED | CLONE_G22_FAILED |
// CLONE_G22_VERIFY_FAILED | CLONE_DATA_PRESERVATION_FAILED | CLONE_ISOLATION_REFUSED | CLONE_CLEANUP_FAILED. Nothing is ever repaired or retried.
// Exit codes: 0 VERIFIED, 1 arguments, 3 refused, 4 unexpected error, 6 any lab failure.

import { randomBytes } from 'node:crypto';
import { spawn as nodeSpawn } from 'node:child_process';
import * as nodeFs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  checkNoSymlinkComponents, checkPrivateDir, checkRuntime, isUnderAny, readPrivateFile, runChild, safePathChars, sha256,
} from './pilot-launch-command.mjs';
import * as B from './pilot-g20-backup.mjs';
import * as CR from './pilot-g20-clone-restore.mjs';
import * as R from './pilot-g22-rollout.mjs';
import { LOCK_PIN } from './pilot-migration-states.mjs';
import { pinsOf } from './pilot-migration-generations.mjs';
import { API_DIR, buildChildEnv, readPinned, resolvePrismaCli } from './pilot-migrate.mjs';
import { verifyG22Tree } from './pilot-g22-migrate.mjs';
import { readLockedFile } from './pilot-plan-binding.mjs';
import { GENERATION_SCHEMA_G22 } from './pilot-g22-schema-references.mjs';

const PREFIX = '[db:pilot-g22-clone-lab]';
const BIN = '/usr/lib/postgresql/17/bin';
const POSTGRES_BIN = `${BIN}/postgres`;
const PORT = 5432;
const MAX_SOCKET_PATH = 100;
const MAX_FILE_BYTES = 1024 * 1024 * 1024;
const CHILD_ENV = Object.freeze({ PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', PGTZ: 'UTC' });
const T = Object.freeze({ initdb: 120000, start: 90000, stop: 90000, restore: 1800000, prisma: 600000, marker: 120000 });
const EXPECTED_SOURCE = 'EXACT_G20';
const GUARD_SCHEMA = 'mona_pilot_guard';

export const FAILURES = Object.freeze({
  BACKUP_REJECTED: 'CLONE_BACKUP_REJECTED',
  RESTORE_FAILED: 'CLONE_RESTORE_FAILED',
  SOURCE_INVALID: 'CLONE_SOURCE_INVALID',
  G21_FAILED: 'CLONE_G21_FAILED',
  G21_WITNESS_FAILED: 'CLONE_G21_WITNESS_FAILED',
  G22_FAILED: 'CLONE_G22_FAILED',
  G22_VERIFY_FAILED: 'CLONE_G22_VERIFY_FAILED',
  DATA_PRESERVATION_FAILED: 'CLONE_DATA_PRESERVATION_FAILED',
  ISOLATION_REFUSED: 'CLONE_ISOLATION_REFUSED',
  CLEANUP_FAILED: 'CLONE_CLEANUP_FAILED',
});

// ---- arguments ---------------------------------------------------------------------------------------------------------------------------------

// Exactly four arguments. Anything that could address another database (--target, --url, --host, --database-url, ...) is simply not in the closed set.
export function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.length !== 4) return { ok: false };
  const values = {};
  for (const arg of argv) {
    const m = /^--(archive|manifest|work-root|expected-counts)=([\s\S]*)$/.exec(typeof arg === 'string' ? arg : '');
    if (!m || m[1] in values) return { ok: false };
    values[m[1]] = m[2];
  }
  for (const key of ['archive', 'manifest', 'work-root']) if (!safePathChars(values[key])) return { ok: false };
  if (values.manifest !== `${values.archive}.manifest.json`) return { ok: false };
  const counts = R.parseCounts(values['expected-counts']);
  if (!counts.ok) return { ok: false };
  return { ok: true, archive: values.archive, manifest: values.manifest, workRoot: values['work-root'], expectedCounts: counts.counts };
}

// ---- the only connection string the lab can build -----------------------------------------------------------------------------------------------

// A Unix-socket URL of the lab's own cluster. `socketDir` must be a normalized absolute path made of safe characters and shorter than a socket path allows.
export function buildCloneUrl(socketDir) {
  if (typeof socketDir !== 'string' || !safePathChars(socketDir) || `${socketDir}/.s.PGSQL.${PORT}`.length > MAX_SOCKET_PATH) throw new Error('unsafe socket directory');
  return `postgresql://${CR.RESTORE_ROLE}@localhost:${PORT}/${CR.CLONE_DB}?host=${socketDir}`;
}

// ---- content fingerprint (a count cannot see an UPDATE) ----------------------------------------------------------------------------------------------

// Tables whose rows no G21/G22 migration may touch (User is fingerprinted on its pre-existing columns only: migration 21 adds columns to it).
export const FINGERPRINT_TABLES = Object.freeze(['UserRoleScope', 'Sale', 'SalePayment', 'CashSession', 'Inventory', 'StockMovement', 'SaleExchange', 'SaleVoid', 'AuditLog']);
export const FINGERPRINT_SQL = Object.freeze({
  User: "SELECT count(*)::text AS n, COALESCE(md5(string_agg(concat_ws('|', \"id\"::text, \"email\", \"passwordHash\", \"isActive\"::text), E'\\n' ORDER BY \"id\"::text)), '') AS d FROM ONLY public.\"User\"",
  ...Object.fromEntries(FINGERPRINT_TABLES.map((t) => [t, `SELECT count(*)::text AS n, COALESCE(md5(string_agg(x::text, E'\\n' ORDER BY x::text)), '') AS d FROM ONLY public."${t}" x`])),
});
export async function readFingerprint(client) {
  const out = {};
  for (const [table, sql] of Object.entries(FINGERPRINT_SQL)) {
    const row = (await client.query(sql)).rows?.[0];
    out[table] = `${row?.n}:${row?.d}`;
  }
  return out;
}
export const diffFingerprint = (before, after) => Object.keys(FINGERPRINT_SQL).filter((t) => before[t] !== after[t]);

// ---- stage for one Prisma deploy (local socket only) -----------------------------------------------------------------------------------------

const LAB_CONFIG_TEXT = (configImport) => `import { defineConfig, env } from ${JSON.stringify(configImport)};

// Generated by pilot-g22-clone-lab.mjs: a private staged copy for one deploy on a disposable clone. It accepts ONLY a Unix-socket URL of the local host name,
// without a password and without any other parameter, so it can never point at Supabase or any remote server.
const raw = env('DATABASE_URL');
const url = new URL(raw);
const keys = [...url.searchParams.keys()];
if (
  !['postgres:', 'postgresql:'].includes(url.protocol) ||
  url.hostname !== 'localhost' || url.password !== '' ||
  keys.length !== 1 || keys[0] !== 'host' || !(url.searchParams.get('host') ?? '').startsWith('/')
) {
  throw new Error('the clone lab accepts only a Unix-socket DATABASE_URL');
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: { url: raw },
});
`;

function walkFiles(fs, root, rel = '') {
  const out = [];
  for (const d of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const r = rel === '' ? d.name : `${rel}/${d.name}`;
    if (d.isSymbolicLink()) throw new Error('symlink');
    if (d.isDirectory()) out.push(...walkFiles(fs, root, r)); else if (d.isFile()) out.push(r); else throw new Error('special');
  }
  return out.sort();
}

// Builds the private tree of ONE generation: config, schema, lock and the pinned migrations 1..N (bytes read through the pinned readers and re-hashed).
export function stageLabRun({ fs = nodeFs, apiDir, stageParent, generation, schemaSha256, hex = () => randomBytes(4).toString('hex') }) {
  const fail = (reason) => ({ ok: false, reason });
  let root;
  try {
    root = path.join(stageParent, `st-${hex()}`);
    fs.mkdirSync(root, { mode: 0o700 });
  } catch { return fail('the staging root could not be created exclusively'); }
  const drop = () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* private garbage inside the run directory */ } };
  try {
    const migrations = pinsOf(generation);
    const configImport = path.relative(root, path.join(apiDir, 'node_modules', 'prisma', 'config.js')).split(path.sep).join('/');
    if (configImport === '' || configImport.startsWith('/')) { drop(); return fail('the staged config import path is not representable'); }
    const expected = new Map();
    const put = (rel, bytes) => {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { mode: 0o700, recursive: true });
      fs.writeFileSync(path.join(root, rel), bytes, { mode: 0o600, flag: 'wx' });
      expected.set(rel, sha256(bytes));
    };
    put('prisma.config.ts', Buffer.from(LAB_CONFIG_TEXT(configImport)));
    const schema = readLockedFile(path.join(apiDir, 'prisma', 'schema.prisma'));
    if (!schema.ok || sha256(schema.bytes) !== schemaSha256) { drop(); return fail('the schema is not the verified copy'); }
    put('prisma/schema.prisma', schema.bytes);
    const lock = readPinned(path.join(apiDir, 'prisma', 'migrations', 'migration_lock.toml'), LOCK_PIN.bytes);
    if (!lock.ok || lock.sha256 !== LOCK_PIN.sha256) { drop(); return fail('the migration lock is not the verified copy'); }
    put('prisma/migrations/migration_lock.toml', lock.bytes);
    for (const m of migrations) {
      const one = readPinned(path.join(apiDir, 'prisma', 'migrations', m.name, 'migration.sql'), m.bytes);
      if (!one.ok || one.sha256 !== m.sha256) { drop(); return fail(`a migration is not the verified copy: ${m.name}`); }
      put(`prisma/migrations/${m.name}/migration.sql`, one.bytes);
    }
    const verify = () => {
      try {
        const found = walkFiles(fs, root);
        if (found.join('\n') !== [...expected.keys()].sort().join('\n')) return fail('the staged tree is not exactly the approved one');
        for (const [rel, sha] of expected) if (sha256(fs.readFileSync(path.join(root, rel))) !== sha) return fail('a staged file is not the verified copy');
        return { ok: true };
      } catch { return fail('the staged tree could not be read'); }
    };
    const first = verify();
    if (!first.ok) { drop(); return first; }
    return { ok: true, root, verify, cleanup: drop };
  } catch { drop(); return fail('the staging copy could not be built'); }
}

// The step runner the core orchestrator is given: verifies the repository tree, re-proves the clone's identity, stages ONE generation (verified twice) and runs one
// `prisma migrate deploy` there. Output is discarded; only the exit status is used.
export function makeLabStepRunner({ deps, prisma, cluster, stageParent, schemaSha256, childHome }) {
  return async (generation) => {
    const tree = verifyG22Tree(deps.apiDir);
    if (!tree.ok) return { ok: false, started: false, detail: `${tree.reason}; changed since the initial check` };
    if (!(await cluster.proveIdentity())) return { ok: false, started: false, detail: 'the clone identity could not be proven; prisma was NOT started' };
    const staged = stageLabRun({ fs: deps.fs, apiDir: deps.apiDir, stageParent, generation, schemaSha256, hex: deps.randomHex ? () => deps.randomHex(4) : undefined });
    if (!staged.ok) return { ok: false, started: false, detail: staged.reason };
    try {
      const again = staged.verify();
      if (!again.ok) return { ok: false, started: false, detail: again.reason };
      const env = buildChildEnv(cluster.url, { execPath: deps.execPath, home: childHome, tmpdir: stageParent });
      const r = await deps.runChild(deps.execPath, [prisma.script, 'migrate', 'deploy', '--config', path.join(staged.root, 'prisma.config.ts')], { env, timeoutMs: T.prisma });
      if (r.status === 0 && !r.timedOut && !r.spawnError) return { ok: true };
      return { ok: false, detail: `prisma exited with code ${r.status}${r.timedOut ? ' (timed out)' : ''}` };
    } finally { staged.cleanup(); }
  };
}

// ---- failure classification ------------------------------------------------------------------------------------------------------------------

// Pure. `outcome` = the core orchestrator's { result, step, detail }; `trace.applyFailed` = the generations whose Prisma step itself failed.
export function classifyOutcome(outcome, trace = { applyFailed: [] }) {
  if (outcome.result === 'MIGRATED') return null;
  const detail = String(outcome.detail ?? '');
  if (/count changed|data fingerprint changed/.test(detail)) return FAILURES.DATA_PRESERVATION_FAILED;
  if (outcome.step === 'args' || outcome.step === 'precheck') return FAILURES.SOURCE_INVALID;
  if (outcome.step === 'G21') return trace.applyFailed.includes('EXACT_G21') ? FAILURES.G21_FAILED : FAILURES.G21_WITNESS_FAILED;
  if (outcome.step === 'G21-to-G22') return FAILURES.G21_WITNESS_FAILED;
  if (outcome.step === 'G22') return trace.applyFailed.includes('EXACT_G22') ? FAILURES.G22_FAILED : FAILURES.G22_VERIFY_FAILED;
  return FAILURES.G22_VERIFY_FAILED;
}

// ---- the disposable cluster ----------------------------------------------------------------------------------------------------------------------

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

// pg_ctl's exit status is never trusted alone: stopped means every recorded postgres process (pid AND start time) is gone and the pid file, socket and lock are released.
export async function stopAndVerify({ deps, child, data, pidFile, sockFile, tracked, trackCluster }) {
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
    const r = await child(`${BIN}/pg_ctl`, ['stop', `--pgdata=${data}`, `--mode=${mode}`, '--wait', '--timeout=60', '--silent'], { timeoutMs: T.stop });
    if (r.status === 0 && !r.timedOut && await settled()) return true;
  }
  for (const pid of alive()) deps.procs.kill(pid, 'SIGKILL');
  return settled();
}

export function createCluster({ deps, runDir }) {
  const fs = deps.fs;
  const rd = path.join(runDir, 'c');
  const data = path.join(rd, 'data');
  const sock = path.join(rd, 's');
  const childHome = path.join(runDir, 'h');
  const pidFile = path.join(data, 'postmaster.pid');
  const sockFile = path.join(sock, `.s.PGSQL.${PORT}`);
  const clusterEnv = { ...CHILD_ENV, ...B.pinnedLibpqEnv(childHome) };
  const child = (file, args, extra) => deps.runChild(file, args, { env: { ...clusterEnv }, ...extra });
  const tracked = new Map();
  let started = false;
  const track = (pid) => {
    const st = deps.procs.stat(pid);
    if (st && st.exe === POSTGRES_BIN && st.state !== 'Z' && !tracked.has(pid)) tracked.set(pid, st.start);
  };
  const trackCluster = () => {
    try {
      const first = fs.readFileSync(pidFile, 'utf8').split('\n')[0];
      if (/^[1-9][0-9]{0,9}$/.test(first)) track(Number(first));
    } catch { /* no pid file yet */ }
    for (const pid of [...tracked.keys()]) for (const c of deps.procs.children(pid)) track(c);
  };
  const connect = (user = CR.ADMIN_ROLE, database = CR.CLONE_DB) => deps.connect({ host: sock, port: PORT, user, database });

  // The hard guard: this is the cluster the lab itself created (its data directory, its socket, no TCP listener, PostgreSQL 17, a Unix-socket session) and the postmaster
  // that answers is the one this lab started (pid recorded with its start time and executable). Anything else aborts BEFORE a migration is issued.
  const proveIdentity = async (database = CR.CLONE_DB) => {
    let c;
    try {
      const realData = fs.realpathSync(data);
      c = await connect(CR.ADMIN_ROLE, database);
      const id = (await c.query(CR.CLONE_SQL.identity)).rows[0] ?? {};
      const sql = id.data_directory === realData && id.listen_addresses === '' && id.unix_socket_directories === sock
        && /^17[0-9]{4}$/.test(String(id.server_version_num)) && (id.via_socket === true || id.via_socket === 't')
        && id.database === database && id.superuser === 'on';
      if (!sql) return false;
      const first = fs.readFileSync(pidFile, 'utf8').split('\n')[0];
      const pid = Number(first);
      const st = deps.procs.stat(pid);
      return tracked.get(pid) !== undefined && st !== null && st.start === tracked.get(pid) && st.exe === POSTGRES_BIN;
    } catch { return false; } finally { try { await c?.end(); } catch { /* closed */ } }
  };

  return {
    sock, data, url: buildCloneUrl(sock), childHome, connect, proveIdentity,
    async start() {
      fs.mkdirSync(childHome, { mode: 0o700 });
      fs.mkdirSync(rd, { mode: 0o700 });
      fs.mkdirSync(sock, { mode: 0o700 });
      const init = await child(CR.INITDB, [`--pgdata=${data}`, `--username=${CR.ADMIN_ROLE}`, '--auth=trust', '--encoding=UTF8', '--locale=C', '--no-instructions', '--no-sync'], { timeoutMs: T.initdb });
      if (init.status !== 0 || init.timedOut) return { ok: false, reason: 'initdb' };
      const lines = ["listen_addresses = ''", `unix_socket_directories = '${sock}'`, 'unix_socket_permissions = 0700', `port = ${PORT}`,
        'fsync = off', 'full_page_writes = off', 'synchronous_commit = off', 'jit = off', "shared_preload_libraries = ''", 'logging_collector = off'];
      const conf = path.join(data, 'postgresql.conf');
      fs.appendFileSync(conf, `\n# pilot-g22-clone-lab (disposable, socket only)\n${lines.join('\n')}\n`);
      const written = fs.readFileSync(conf, 'utf8').split('\n');
      if (!lines.every((l) => written.includes(l))) return { ok: false, reason: 'config' };
      started = true;
      const start = await child(CR.PG_CTL, ['start', `--pgdata=${data}`, '--wait', '--timeout=60', `--log=${path.join(rd, 'server.log')}`, '--silent'], { timeoutMs: T.start });
      trackCluster();
      if (start.status !== 0 || start.timedOut) return { ok: false, reason: 'start' };
      if (!(await proveIdentity('postgres'))) return { ok: false, reason: 'identity' };
      const admin = await connect(CR.ADMIN_ROLE, 'postgres');
      try { for (const s of CR.CLONE_SQL.setup) await admin.query(s); } finally { await admin.end(); }
      return { ok: true };
    },
    async restore(archive) {
      const r = await child(CR.PG_RESTORE_BIN, ['--format=custom', '--exit-on-error', '--single-transaction', '--no-owner', '--no-privileges', '--schema=public',
        `--host=${sock}`, `--port=${PORT}`, `--username=${CR.RESTORE_ROLE}`, `--dbname=${CR.CLONE_DB}`, '--no-password'], { input: archive, timeoutMs: T.restore });
      return r.status === 0 && !r.timedOut;
    },
    // The marker lives in another schema and is not restored: a local stand-in with the same name lets the same snapshot code run (a lab fixture, not an identity proof).
    async seedMarker(markerId) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(markerId)) throw new Error('marker id');
      const c = await connect();
      try {
        await c.query(`CREATE SCHEMA ${GUARD_SCHEMA}`);
        await c.query(`CREATE TABLE ${GUARD_SCHEMA}.database_identity (marker_id uuid NOT NULL, environment text NOT NULL)`);
        await c.query(`INSERT INTO ${GUARD_SCHEMA}.database_identity VALUES ('${markerId}', 'pilot')`);
      } finally { await c.end(); }
    },
    fingerprint: async (client) => readFingerprint(client),
    async stop() {
      if (!started) return true;
      return stopAndVerify({ deps, child, data, pidFile, sockFile, tracked, trackCluster });
    },
  };
}

// ---- the lab ---------------------------------------------------------------------------------------------------------------------------------

// Never throws. Returns { code } where code is 'VERIFIED' or one of FAILURES. Cleanup runs in every branch (and from `abort`, wired to SIGINT/SIGTERM by main).
export async function runLab({ deps, args, say }) {
  const fs = deps.fs;
  const out = (line) => deps.log(line);
  let runDir = null;
  let own = null;
  let cluster = null;
  // One cleanup per run, memoised WITH its result: an interrupt that races the normal exit shares the same attempt and a failed attempt is never reported as clean.
  let cleanupRun = null;
  const cleanup = () => { cleanupRun ??= doCleanup(); return cleanupRun; };
  const doCleanup = async () => {
    let stopped = true;
    try { if (cluster) stopped = await cluster.stop(); } catch { stopped = false; }
    if (!stopped) { say('check stopped=FAIL (PostgreSQL may still be running; the run directory was kept)'); return false; }
    if (runDir === null) return true;
    try {
      const now = fs.lstatSync(runDir);
      if (now.isDirectory() && !now.isSymbolicLink() && now.dev === own.dev && now.ino === own.ino) { fs.rmSync(runDir, { recursive: true }); return true; }
    } catch { /* fallthrough */ }
    say('check cleanup=FAIL (the run directory was kept, changed or could not be removed; not deleted)');
    return false;
  };
  deps.registerAbort?.(async () => { await cleanup(); });

  const finish = async (code) => {
    const clean = await cleanup();
    if (!clean) return { code: code === 'VERIFIED' ? FAILURES.CLEANUP_FAILED : code, cleanup: false };
    say('check cleanup=PASS');
    return { code, cleanup: true };
  };

  try {
    // 1. inputs, read once through the private-file reader (0600, owned, no symlink); both are re-read after the restore proof.
    const readInputs = () => {
      const ar = readPrivateFile(fs, deps.uid, args.archive, MAX_FILE_BYTES);
      const mf = readPrivateFile(fs, deps.uid, args.manifest, 1024 * 1024);
      return ar.ok && mf.ok ? { ok: true, archive: ar.bytes, manifest: mf.bytes } : { ok: false };
    };
    const first = readInputs();
    if (!first.ok) return await finish(FAILURES.BACKUP_REJECTED);
    const pm = B.parseDumpManifest(first.manifest);
    if (!pm.ok) return await finish(FAILURES.BACKUP_REJECTED);
    if (pm.manifest.ledgerState !== EXPECTED_SOURCE) return await finish(FAILURES.SOURCE_INVALID);

    // 2. the approved authentication + restore proof: the UNMODIFIED pilot-g20-clone-restore, called through its seam.
    const captured = [];
    const rc = await deps.cloneRestoreMain([`--archive=${args.archive}`, `--manifest=${args.manifest}`, `--work-root=${args.workRoot}`, `--expected-state=${EXPECTED_SOURCE}`],
      { log: (l) => captured.push(String(l)), error: (l) => captured.push(String(l)) });
    const verified = rc === 0 && captured.includes('A5C_RESULT=VERIFIED');
    if (!verified) {
      if (rc === 6) return await finish(FAILURES.RESTORE_FAILED);
      return await finish(captured.some((l) => /manifest declares|expected-state/.test(l)) ? FAILURES.SOURCE_INVALID : FAILURES.BACKUP_REJECTED);
    }
    const second = readInputs();
    if (!second.ok || !second.archive.equals(first.archive) || !second.manifest.equals(first.manifest)) return await finish(FAILURES.BACKUP_REJECTED);
    out('CLONE_BACKUP_VERIFIED');

    // 3. the lab's own run directory and cluster (exclusive, private, never reused, deleted only while it is still the same inode and after a verified stop).
    const wr = args.workRoot;
    if (isUnderAny(wr, deps.forbiddenRoots) || !checkNoSymlinkComponents(fs, wr) || !checkPrivateDir(fs, deps.uid, wr)) return await finish(FAILURES.ISOLATION_REFUSED);
    const dir = path.join(wr, `g-${deps.randomHex(4)}`);
    if (`${dir}/c/s/.s.PGSQL.${PORT}`.length > MAX_SOCKET_PATH) return await finish(FAILURES.ISOLATION_REFUSED);
    try { fs.mkdirSync(dir, { mode: 0o700 }); own = fs.lstatSync(dir); runDir = dir; } catch { return await finish(FAILURES.ISOLATION_REFUSED); }
    cluster = deps.createCluster({ deps, runDir });
    const up = await cluster.start();
    if (!up.ok) return await finish(up.reason === 'identity' ? FAILURES.ISOLATION_REFUSED : FAILURES.RESTORE_FAILED);
    if (!(await cluster.restore(first.archive))) return await finish(FAILURES.RESTORE_FAILED);
    const markerId = await deps.readMarkerId(first.archive);
    if (typeof markerId !== 'string' || B.markerDigest(markerId) !== pm.manifest.markerIdDigest) return await finish(FAILURES.BACKUP_REJECTED);
    await cluster.seedMarker(markerId);
    say('clone restored (schema public) and bound to the manifest marker digest');

    // 4. the snapshot reader the core is given: a fresh connection to the clone each time, plus the content fingerprint compared with the pre-migration one.
    let baseline = null;
    const readSnapshotNow = async (options) => {
      let client;
      try { client = await cluster.connect(); } catch { return { ok: false, reason: 'the clone could not be reached' }; }
      try {
        const snap = await R.readSnapshotOn(client, { markerId, requireTls: false, ...options });
        if (!snap.ok) return snap;
        const fp = await cluster.fingerprint(client);
        if (baseline === null) baseline = fp;
        else {
          const changed = diffFingerprint(baseline, fp);
          if (changed.length > 0) return { ok: false, reason: `data fingerprint changed: ${changed.join(', ')}` };
        }
        return snap;
      } catch { return { ok: false, reason: 'the clone snapshot could not be read' }; } finally { try { await client.end(); } catch { /* closed */ } }
    };

    // 5. pre-migration verification: nothing is migrated unless the restored copy is exactly the frozen EXACT_G20.
    if (!(await cluster.proveIdentity())) return await finish(FAILURES.ISOLATION_REFUSED);
    const pre = await readSnapshotNow({});
    if (!pre.ok) return await finish(FAILURES.SOURCE_INVALID);
    const assessed = R.assessSource(pre, deps.schema, EXPECTED_SOURCE);
    const preCounts = R.diffCounts(args.expectedCounts, pre.facts.counts);
    const sourceOk = assessed.verdict === 'READY' && assessed.ledger.ok && assessed.ledger.state === EXPECTED_SOURCE && pre.ledger.length === 20
      && assessed.schemaGeneration === EXPECTED_SOURCE && assessed.catalog?.ok === true && assessed.catalog.catalog === 'CATALOG_38'
      && pre.facts.lowerIndexDef === null && preCounts.length === 0;
    if (!sourceOk) {
      say(`pre-migration verification FAILED: ${[...assessed.reasons, ...preCounts.map((d) => `count ${d.table} ${d.before} -> ${d.after}`)].join(',') || 'not the frozen EXACT_G20'}`);
      return await finish(FAILURES.SOURCE_INVALID);
    }
    out('CLONE_EXACT_G20_VERIFIED');

    // 6. the SAME core orchestrator as PILOT.
    const trace = { applyFailed: [] };
    const prisma = deps.resolvePrisma(deps.apiDir);
    if (!prisma.ok) return await finish(FAILURES.SOURCE_INVALID);
    const schemaFile = readLockedFile(path.join(deps.apiDir, 'prisma', 'schema.prisma'));
    if (!schemaFile.ok) return await finish(FAILURES.SOURCE_INVALID);
    const stepRunner = deps.makeStepRunner({ deps, prisma, cluster, stageParent: path.join(runDir, 'h'), schemaSha256: sha256(schemaFile.bytes), childHome: path.join(runDir, 'h') });
    const outcome = await R.runRollout({
      initialState: EXPECTED_SOURCE,
      readSnapshotNow,
      applyStep: async (generation) => {
        const r = await stepRunner(generation);
        if (!r.ok && r.started !== false) trace.applyFailed.push(generation);
        return r;
      },
      log: (line) => {
        say(line);
        if (line.startsWith('G21 ok')) out('CLONE_G21_WITNESS_PASS');
        if (line.startsWith('G22 ok')) out('CLONE_G22_VERIFY_PASS');
      },
      schema: deps.schema,
      fingerprint: deps.fingerprint,
    });
    const failure = classifyOutcome(outcome, trace);
    if (failure !== null) { say(`rollout ${outcome.result} at ${outcome.step}: ${String(outcome.detail).slice(0, 300)}`); return await finish(failure); }

    // 7. final data preservation against the OWNER-frozen counts and the pre-migration content fingerprint.
    const finalCounts = R.diffCounts(args.expectedCounts, outcome.snapshot.facts.counts);
    if (finalCounts.length > 0) return await finish(FAILURES.DATA_PRESERVATION_FAILED);
    out('CLONE_COUNTS_PRESERVED');
    say(`ROLLOUT_COUNTS=${R.formatCounts(outcome.snapshot.facts.counts)}`);
    return await finish('VERIFIED');
  } catch {
    return await finish(FAILURES.RESTORE_FAILED);
  }
}

export function defaultDeps() {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const pgUrl = pathToFileURL(path.join(root, 'node_modules', 'pg', 'esm', 'index.mjs')).href;
  const aborts = [];
  const handler = (signal) => async () => {
    for (const fn of aborts) { try { await fn(); } catch { /* best effort */ } }
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  return {
    env: process.env, uid: process.getuid(), execArgv: process.execArgv, version: process.version, fs: nodeFs, root,
    execPath: process.execPath, apiDir: API_DIR, schema: GENERATION_SCHEMA_G22, fingerprint: R.EXPECTED_FINGERPRINT,
    forbiddenRoots: [root.replace(/\/$/, ''), '/tmp', '/var/tmp', '/dev/shm', '/run', '/proc', '/sys'],
    readNetDev: () => nodeFs.readFileSync('/proc/self/net/dev', 'utf8'),
    runChild: (file, args, opts) => runChild(nodeSpawn, file, args, opts),
    connect: async (cfg) => {
      const { default: pg } = await import(pgUrl);
      const client = new pg.Client({ ...cfg, connectionTimeoutMillis: 15000, query_timeout: 1800000, application_name: 'mona-pilot-g22-clone-lab' });
      await client.connect();
      return client;
    },
    procs: realProcs, stopVerifyMs: 15000, pollMs: 100,
    randomHex: (n) => randomBytes(n).toString('hex'),
    cloneRestoreMain: (argv, overrides) => CR.main(argv, overrides),
    createCluster, makeStepRunner: makeLabStepRunner, resolvePrisma: resolvePrismaCli,
    readMarkerId: async (archive) => {
      const r = await runChild(nodeSpawn, CR.PG_RESTORE_BIN, B.pgRestoreArgs('marker'), { env: { ...CHILD_ENV }, input: archive, timeoutMs: T.marker, maxStdout: 1024 * 1024 });
      const parsed = r.status === 0 ? B.parseMarkerCopy(r.stdout) : { ok: false };
      return parsed.ok ? parsed.markerId : null;
    },
    registerAbort: (fn) => {
      aborts.push(fn);
      process.once('SIGINT', handler('SIGINT'));
      process.once('SIGTERM', handler('SIGTERM'));
    },
    log: (line) => console.log(line), error: (line) => console.error(line),
  };
}

export async function main(argv, overrides = {}) {
  const deps = { ...defaultDeps(), ...overrides };
  const say = (line) => deps.log(`${PREFIX} ${line}`);
  const end = (code, rc) => { deps.log(`CLONE_LAB_RESULT=${code}`); return rc; };
  const args = parseArgs(argv);
  if (!args.ok) {
    deps.error(`${PREFIX} REFUSED: exactly --archive, --manifest (<archive>.manifest.json), --work-root (absolute, [A-Za-z0-9/._-]) and --expected-counts (the ROLLOUT_COUNTS JSON) are accepted; there is no database, host or target input (not echoed)`);
    return end('ARGUMENTS', 1);
  }
  if (deps.uid === 0) { deps.error(`${PREFIX} REFUSED: must not run as root`); return end(FAILURES.ISOLATION_REFUSED, 3); }
  const rt = checkRuntime({ env: deps.env, execArgv: deps.execArgv, version: deps.version, expectedKeys: ['LANG', 'PATH'], homedir: undefined });
  if (!rt.ok) { deps.error(`${PREFIX} REFUSED: phase=${rt.phase} — ${rt.reason}`); return end(FAILURES.ISOLATION_REFUSED, 3); }
  let net;
  try { net = CR.checkNetworkIsolation(deps.readNetDev()); } catch { net = { ok: false }; }
  if (!net.ok) { deps.error(`${PREFIX} REFUSED: the process is not in a network namespace with only loopback (launch with unshare -U -n)`); return end(FAILURES.ISOLATION_REFUSED, 3); }

  const result = await runLab({ deps, args, say });
  if (result.code === 'VERIFIED') return end('VERIFIED', 0);
  return end(result.code, 6);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).then((rc) => { process.exitCode = rc; }, () => { console.log('CLONE_LAB_RESULT=ERROR'); process.exitCode = 4; });
}
