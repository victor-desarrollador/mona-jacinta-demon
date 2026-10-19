// LOCAL_TEST cut-over lab — the security core shared by every lab operation
// (local-test-cutover-lab.mjs is the ONE protected entry; this module has no entry point).
//
// What it decides, with no side effect of its own except the private payload staging:
//   * the argument contract (op, exact state, rehearsal source, run id);
//   * inherited-environment refusal: no DATABASE_URL / TEST_DATABASE_URL / PILOT_* / DEV_* /
//     SUPABASE_* / LOCAL_TEST_* / PG* / NODE_OPTIONS / MONA_* is ever accepted from the shell;
//     children receive only childEnv(): variables the wrapper itself built;
//   * network isolation (only lo, no IPv4 route, IPv6 routes only on lo, not root);
//   * the LOCAL_TEST identity tuple (database/user/owner, PostgreSQL 17, loopback listener,
//     marker, and the system_identifier read by pg_controldata from the cluster the lab created);
//   * FRESH-target evaluation before a provision;
//   * the exact per-state payloads (pilot-migration-states.mjs pins) and the plan digest;
//   * the gate every DB command passes: identity proof → exact-state proof → command.
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { checkNoSymlinkComponents, checkPrivateDir, isUnderAny } from './pilot-launch-command.mjs';
import { readPinned } from './pilot-migrate.mjs';
import { LOCK_PIN, MIGRATION_PINS, STATES } from './pilot-migration-states.mjs';
import { verifyMigrationTree } from './local-test-migration-payload.mjs';

export const LAB_OPS = Object.freeze(['provision', 'schema-reference', 'backup-restore-proof', 'migration-rehearsal', 'integration-test', 'teardown']);
export const LAB_STATES = Object.freeze(Object.keys(STATES));
export const REHEARSAL_SOURCES = Object.freeze(['EXACT_S4', 'EXACT_G7']);
export const PLAN_FORMAT = 'mona-local-test-cutover-lab-plan/v1';
export const RUN_ID = /^lab-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$/;
export const LOCAL_TEST = Object.freeze({ host: '127.0.0.1', port: 5432, database: 'mona_local_test', user: 'mona_local_test' });
const STATE_OPS = new Set(['provision', 'schema-reference', 'backup-restore-proof']);
const STAGE_PREFIX = 'mona-local-test-lab-';
export const LAB_STAGED_MIGRATIONS_DIR = /^(?:\/(?!\.\.?(?:\/|$))[^/\p{Cc}]+)*\/mona-local-test-lab-[A-Za-z0-9]{6}\/prisma\/migrations$/u;
const MIGRATION_FILE = 'migration.sql';
const LOCK_FILE = 'migration_lock.toml';

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

// ---------------- arguments ----------------
export function parseLabArgs(argv) {
  const no = { ok: false };
  if (!Array.isArray(argv) || argv.length < 1 || argv.length > 2) return no;
  const v = {};
  for (const a of argv) {
    const m = /^--(op|state|from|run)=(.*)$/.exec(String(a));
    if (!m || Object.hasOwn(v, m[1])) return no;
    v[m[1]] = m[2];
  }
  if (!LAB_OPS.includes(v.op)) return no;
  const out = { ok: true, op: v.op, state: null, from: null, run: null };
  if (STATE_OPS.has(v.op)) {
    if (!LAB_STATES.includes(v.state) || argv.length !== 2) return no;
    out.state = v.state;
  } else if (v.op === 'migration-rehearsal') {
    if (!REHEARSAL_SOURCES.includes(v.from) || argv.length !== 2) return no;
    out.from = v.from;
  } else if (v.op === 'teardown') {
    if (!RUN_ID.test(v.run ?? '') || argv.length !== 2) return no;
    out.run = v.run;
  } else if (argv.length !== 1) {
    return no; // integration-test takes nothing else
  }
  return out;
}

// ---------------- environment ----------------
const FORBIDDEN_ENV = /^(?:DATABASE_URL|TEST_DATABASE_URL|DIRECT_URL|SHADOW_DATABASE_URL|PILOT_.*|DEV_.*|SUPABASE_.*|LOCAL_TEST_.*|PG.*|NODE_OPTIONS|NODE_PG_FORCE_NATIVE|MONA_.*)$/;
export function checkInheritedEnv(env) {
  const forbidden = Object.keys(env ?? {}).filter((k) => FORBIDDEN_ENV.test(k)).sort();
  return { ok: forbidden.length === 0, forbidden };
}
// The only variables a lab child ever receives: a fixed base plus the wrapper's own LOCAL_TEST values.
const WRAPPER_VARS = new Set(['LOCAL_TEST_DATABASE_URL', 'LOCAL_TEST_DATABASE_MARKER_ID', 'LOCAL_TEST_LAB_MIGRATIONS_DIR', 'PGPASSFILE', 'NODE_ENV',
  'CHECKPOINT_DISABLE', 'PRISMA_HIDE_UPDATE_MESSAGE', 'MONA_A5_ITEST_ROOT', 'MONA_CUTOVER_LAB_RUN',
  // G11-ADV-004: the S9 startup-gate PG proof's four opt-in binding variables (selector,
  // disposable acknowledgement, suite selector and the cluster's pinned system_identifier).
  'MONA_TEST_DATABASE_TARGET', 'MONA_R3_S9_PG', 'MONA_R3_S9_PG_DISPOSABLE', 'MONA_R3_PG_SYSTEM_ID']);
export function childEnv({ home, tmpdir, path: pathVar = '/usr/bin:/bin', extra = {} }) {
  for (const k of Object.keys(extra)) if (!WRAPPER_VARS.has(k)) throw new Error(`${k} is not a wrapper variable`);
  return { PATH: pathVar, HOME: home, TMPDIR: tmpdir, LANG: 'C.UTF-8', TZ: 'UTC', PGTZ: 'UTC', ...extra };
}
export function localTestUrl(passwordHex) {
  if (typeof passwordHex !== 'string' || !/^[0-9a-f]{64}$/.test(passwordHex)) throw new Error('the LOCAL_TEST password must be 64 lowercase hex characters');
  return `postgresql://${LOCAL_TEST.user}:${passwordHex}@${LOCAL_TEST.host}:${LOCAL_TEST.port}/${LOCAL_TEST.database}`;
}

// ---------------- isolation ----------------
export function proveIsolation({ netDev, route, ipv6Route, uid }) {
  const no = (reason) => ({ ok: false, reason });
  if (typeof netDev !== 'string' || typeof route !== 'string' || typeof ipv6Route !== 'string') return no('the network namespace could not be read');
  if (uid === 0) return no('must not run as root inside the namespace (initdb/postgres refuse it)');
  const ifaces = netDev.split('\n').slice(2).map((l) => l.split(':')[0].trim()).filter(Boolean);
  if (ifaces.length !== 1 || ifaces[0] !== 'lo') return no(`network interface other than lo present (${ifaces.length} interfaces)`);
  const v4 = route.split('\n').slice(1).filter((l) => l.trim());
  if (v4.length > 0) return no('an IPv4 route exists (zero external routes required)');
  const v6 = ipv6Route.split('\n').filter((l) => l.trim());
  if (v6.some((l) => l.trim().split(/\s+/).at(-1) !== 'lo')) return no('an IPv6 route on a non-loopback interface exists');
  return { ok: true };
}

// ---------------- identity ----------------
const SYSTEM_ID = /^[1-9][0-9]{15,20}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function evaluateIdentity(f, expected) {
  const no = (reason) => ({ ok: false, reason });
  if (!SYSTEM_ID.test(String(expected?.systemIdentifier ?? '')) || !UUID_V4.test(String(expected?.markerId ?? ''))) return no('the expected identity (system_identifier, marker) is not defined');
  if (f === null || typeof f !== 'object') return no('identity facts could not be read');
  if (f.currentDatabase !== LOCAL_TEST.database) return no('connected database is not mona_local_test');
  if (f.currentUser !== LOCAL_TEST.user) return no('connected user is not mona_local_test');
  if (f.databaseOwner !== LOCAL_TEST.user) return no('database owner is not mona_local_test');
  if (!/^17[0-9]{4}$/.test(String(f.serverVersionNum))) return no('PostgreSQL 17 is required');
  if (f.listenAddresses !== LOCAL_TEST.host || f.serverAddr !== LOCAL_TEST.host || Number(f.serverPort) !== LOCAL_TEST.port) return no('the server is not a loopback-only 127.0.0.1:5432 listener');
  if (f.testGuard !== false) return no('a TEST marker schema exists');
  if (f.pilotGuard !== false) return no('a PILOT marker schema exists');
  if (f.markerStructureOk !== true) return no('the LOCAL_TEST marker structure is not canonical');
  const rows = Array.isArray(f.markerRows) ? f.markerRows : [];
  if (rows.length !== 1 || rows[0].environment !== 'local_test' || rows[0].has_installed_at !== true || rows[0].marker_id !== expected.markerId) {
    return no('the LOCAL_TEST marker is missing or not the expected one');
  }
  if (String(f.systemIdentifier) !== expected.systemIdentifier) return no('system_identifier differs from the cluster the lab created');
  return { ok: true };
}
// pg_controldata output (C locale): the one "Database system identifier" line.
export function parseControlData(text) {
  const m = /^Database system identifier:\s+([0-9]+)$/m.exec(String(text));
  return m && SYSTEM_ID.test(m[1]) ? m[1] : null;
}

// ---------------- FRESH ----------------
export function evaluateFresh(f) {
  const no = (reason) => ({ ok: false, reason: `the provision target is not FRESH: ${reason}` });
  if (f === null || typeof f !== 'object') return no('facts could not be read');
  if (f.publicRelations !== 0) return no('schema public already holds relations');
  if (f.ledgerExists !== false) return no('a migration ledger already exists');
  if (!Array.isArray(f.schemas) || f.schemas.join(',') !== 'mona_local_test_guard,public') return no('unexpected schemas exist');
  return { ok: true };
}

// ---------------- payloads and plans ----------------
export function statePayload(state) {
  if (!LAB_STATES.includes(state)) throw new Error('unknown state');
  return Object.freeze({ migrations: MIGRATION_PINS.slice(0, STATES[state].length), lock: LOCK_PIN });
}
const pinRow = (m) => [m.name, m.bytes, m.sha256];
export function buildLabPlan({ op, state, from, prisma, configSha256 }) {
  const build = state ?? from;
  const plan = {
    format: PLAN_FORMAT, op, state, from,
    migrations: statePayload(build).migrations.map(pinRow),
    lock: [LOCK_PIN.bytes, LOCK_PIN.sha256, LOCK_PIN.provider],
    rehearsal: from ? MIGRATION_PINS.slice(STATES[from].length).map(pinRow) : [],
    prisma: { version: prisma?.version ?? null, script: prisma?.script ?? null }, configSha256: configSha256 ?? null,
  };
  return { plan, digest: sha256(canonicalJson(plan)) };
}

// A fresh owner-only copy of exactly the state's migrations + lock: <stageRoot>/mona-local-test-lab-XXXXXX/prisma/migrations.
// The WHOLE source tree must first be exactly the eleven reviewed pins (drift anywhere refuses); every byte copied is the
// one readPinned verified; the copy is verified again as an exact tree of the state. Nothing is left behind on failure.
export function stageStatePayload(apiDir, state, stageRoot) {
  const fail = (reason) => ({ ok: false, reason });
  if (!LAB_STATES.includes(state)) return fail('unknown state');
  if (typeof stageRoot !== 'string' || !path.isAbsolute(stageRoot)) return fail('the staging root must be absolute');
  try {
    const st = lstatSync(stageRoot);
    if (!st.isDirectory() || (st.mode & 0o077) !== 0 || st.uid !== process.getuid()) return fail('the staging root must be a real private directory');
  } catch { return fail('the staging root must be a real private directory'); }
  const source = verifyMigrationTree(apiDir, { migrations: MIGRATION_PINS, lock: LOCK_PIN });
  if (!source.ok) return fail(`${source.reason}; nothing was staged`);
  const payload = statePayload(state);
  let root = null;
  const cleanup = () => { if (root !== null) rmSync(root, { recursive: true, force: true }); };
  try {
    root = mkdtempSync(path.join(realpathSync(stageRoot), STAGE_PREFIX));
    chmodSync(root, 0o700);
    const from = path.join(realpathSync(apiDir), 'prisma', 'migrations');
    const to = path.join(root, 'prisma', 'migrations');
    mkdirSync(to, { recursive: true, mode: 0o700 });
    for (const m of payload.migrations) {
      const file = readPinned(path.join(from, m.name, MIGRATION_FILE), m.bytes);
      if (!file.ok || file.sha256 !== m.sha256) throw new Error('source changed while staging');
      mkdirSync(path.join(to, m.name), { mode: 0o700 });
      writeFileSync(path.join(to, m.name, MIGRATION_FILE), file.bytes, { mode: 0o600, flag: 'wx' });
    }
    const lock = readPinned(path.join(from, LOCK_FILE), LOCK_PIN.bytes);
    if (!lock.ok || lock.sha256 !== LOCK_PIN.sha256) throw new Error('source changed while staging');
    writeFileSync(path.join(to, LOCK_FILE), lock.bytes, { mode: 0o600, flag: 'wx' });
    const staged = verifyMigrationTree(root, payload);
    if (!staged.ok || !LAB_STAGED_MIGRATIONS_DIR.test(to)) throw new Error('staged copy not exact');
    return { ok: true, root, migrationsDir: to, cleanup };
  } catch {
    cleanup();
    return fail('the state payload could not be staged; nothing was left behind');
  }
}

// ---------------- lab root ----------------
export function checkLabRoot(dir, { forbiddenRoots }) {
  const no = (reason) => ({ ok: false, reason });
  if (typeof dir !== 'string' || !path.isAbsolute(dir) || path.normalize(dir) !== dir) return no('the lab root must be an absolute normalized path');
  if (isUnderAny(dir, forbiddenRoots)) return no('the lab root lies inside the repository or temporary/system storage');
  if (!checkNoSymlinkComponents({ lstatSync }, dir)) return no('the lab root has a symlinked component');
  if (!checkPrivateDir({ lstatSync }, process.getuid(), dir)) return no('the lab root must be a real directory owned by this user with mode 0700');
  return { ok: true };
}

// ---------------- the gate ----------------
// wrapper → identity proof → exact-state proof → DB command. A provision of a FRESH database proves
// FRESH instead of identity first: the marker is installed by that provision (then proven before migrate).
export function createGate({ proveIdentity, proveState }) {
  return {
    async run(label, { state }, command) {
      if (state !== 'FRESH') {
        const id = await proveIdentity();
        if (!id?.ok) throw new Error(`LOCAL_TEST_IDENTITY_NOT_PROVEN before ${label}: ${id?.reason ?? 'no proof'}`);
      }
      const st = await proveState(state);
      if (!st?.ok) throw new Error(`EXACT_STATE_NOT_PROVEN before ${label}: ${st?.reason ?? 'no proof'}`);
      return command();
    },
  };
}
