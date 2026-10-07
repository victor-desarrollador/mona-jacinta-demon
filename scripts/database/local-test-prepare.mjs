import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync as fsRealpathSync,
  writeSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { pathToFileURL } from 'node:url';
import { API_DIR, APPROVED_MIGRATION_PAYLOAD, resolvePrismaCli, verifyMigrationPayload } from './pilot-migrate.mjs';
import {
  PRE_FORMAT,
  PROTECTED_RELATION_NAMES,
  isKnownBackupRelationSet,
  authorizationStorePath,
  bindPost,
  buildConsumedMarker,
  buildWitness,
  classifyOutcome,
  consumeAuthorizationMarker,
  ensureWitnessDir,
  listWitnessFiles,
  nextAction,
  parseWitness,
  persistWitnessDurably,
  preWitnessSha256,
  readAuthorizationRecord,
  readWitnessFile,
  realWitnessFs,
} from './local-test-witness.mjs';
import { runTool } from './local-test-safe-error.mjs';

// LOCAL_TEST baseline preparation orchestrator (Task 4).
//
//   node scripts/database/local-test-prepare.mjs --dry-run --marker-id=<uuid>
//   node scripts/database/local-test-prepare.mjs --check --marker-id=<uuid>
//   node scripts/database/local-test-prepare.mjs --execute --marker-id=<uuid> \
//     --confirm-local-target=mona_local_test@127.0.0.1:5432/mona_local_test --plan=<sha256>
//   node scripts/database/local-test-prepare.mjs --dry-run|--execute ... \
//     --resume-from=POST_BACKFILL --backup-evidence=<absolute backup run directory>
//
// Backup boundary (V2.3.1 class fix; V2.3.2 OWNER decision of 2026-10-03, AGENTS.md
// "Database safety"): seed #2 deletes/transforms rows that already exist at
// POST_BACKFILL, so it requires a dry run, a durable verified backup corresponding to
// the CURRENT checkpoint and an explicit OWNER approval naming the target. The
// destructive LOCAL_TEST integration-test exception never applies to this workflow.
// The generic --execute only ever runs the additive phases (migrate, seed #1,
// backfill) and stops at POST_BACKFILL; before its first mutation it supersedes every
// current checkpoint and at POST_BACKFILL it records a new one (the checkpoint store,
// <home>/.local/state/mona-jacinta/local-test-checkpoints). Seed #2 is reachable only
// through the explicit resume, whose evidence is the local-test-backup.mjs run
// directory: files, self-hashed manifest, the archive listed by the pinned pg_restore
// --list (TOC rules and TOC sha256 bound by the manifest), backup age, and binding to
// the current, unconsumed checkpoint. It is verified before the plan (the plan binds
// it), re-verified immediately before seed #2, and the checkpoint is consumed (single
// use, O_EXCL) right before seed #2. Every mutation is driven by the live, freshly
// proven state through a fixed transition table, and its result must classify as
// exactly the expected next state. Every child process runs contained: PID 1 of its
// own PID namespace in its own process group, so no descendant outlives it.
//
// Brings the disposable LOCAL_TEST database to the canonical baseline in two
// separately approved runs: `prisma migrate deploy --config prisma.local-test.config.ts`,
// demo seed, TEST Company/Location convergence (checkpoint POST_BACKFILL); then, after
// a verified backup, the second seed and the strict final verification.
// The only target source is LOCAL_TEST_DATABASE_URL (exact canonical loopback
// text) plus the pinned LOCAL_TEST_DATABASE_MARKER_ID. Every DB step runs through
// an injected runtime whose proveIdentity() is the hardened demo-database.ts
// LOCAL_TEST proof; a mutation always follows a fresh successful proof.
//
// Never: the marker (local-test-marker.mjs owns it), databases, roles, users,
// passwords, repairs of unknown state. The approved migration pins are the
// single reviewed set in pilot-migrate.mjs. No URL or password is ever printed.
//
// GREEN6F loads the reviewed runtime only after static gates and the plan
// check. Dry runs never import it or start a process.

export const URL_VAR = 'LOCAL_TEST_DATABASE_URL';
export const MARKER_VAR = 'LOCAL_TEST_DATABASE_MARKER_ID';
export const CONFIRM_LOCAL_TARGET = 'mona_local_test@127.0.0.1:5432/mona_local_test';
export const PRISMA_CONFIG = 'prisma.local-test.config.ts';
export const COMPANY_DESCRIPTOR = 'scripts/test-company-bootstrap.ts';
export const PRISMA_MIGRATE_ARGS = Object.freeze(['migrate', 'deploy', '--config', PRISMA_CONFIG]);
// v3 (V2.3.2): no V2.2, V2.3 or V2.3.1 plan digest is ever accepted.
export const PLAN_DOMAIN = 'mona-jacinta-local-test-prepare-plan-v4';
export const PREPARE_TOOL = 'scripts/database/local-test-prepare.mjs';
export const CHILD_TIMEOUT_MS = 10 * 60 * 1000;
export const RUNTIME_MODULE = 'scripts/local-test-runtime.ts';

export const PREPARE_STATES = Object.freeze([
  'FRESH',
  'MIGRATED_EMPTY',
  'EXACT_BASELINE',
  'POST_SEED1',
  'POST_BACKFILL',
  'PARTIAL_UNSAFE',
  'OPERATIONAL_DATA',
  'MIGRATION_DRIFT',
  'UNKNOWN',
]);
export const PHASE = Object.freeze({
  MIGRATE: 'migrate',
  SEED: 'seed-demo',
  BACKFILL: 'backfill-company-locations',
  VERIFY: 'verify-baseline',
});
// Exactly two actions, each with its own plan digest. The generic --dry-run /
// --execute is the checkpoint action; seed #2 exists only in the resume action.
export const PREPARE_ACTIONS = Object.freeze({
  CHECKPOINT: 'prepare-to-post-backfill',
  RESUME: 'resume-after-verified-backup',
});
export const CHECKPOINT_STATE = 'POST_BACKFILL';
export const RESUME_FROM_VALUE = 'POST_BACKFILL';
// The only transitions prepare performs. Each step is chosen from the live,
// freshly proven state and must end in exactly `next`. No checkpoint transition
// leaves POST_BACKFILL; the single seed #2 transition belongs to the resume.
const CHECKPOINT_STEPS = Object.freeze({
  FRESH: Object.freeze({ phase: PHASE.MIGRATE, next: 'MIGRATED_EMPTY' }),
  MIGRATED_EMPTY: Object.freeze({ phase: PHASE.SEED, next: 'POST_SEED1' }),
  POST_SEED1: Object.freeze({ phase: PHASE.BACKFILL, next: CHECKPOINT_STATE }),
});
const RESUME_STEPS = Object.freeze({
  [CHECKPOINT_STATE]: Object.freeze({ phase: PHASE.SEED, next: 'EXACT_BASELINE' }),
});
const ACTION_STEPS = Object.freeze({
  [PREPARE_ACTIONS.CHECKPOINT]: Object.freeze({ steps: CHECKPOINT_STEPS, end: CHECKPOINT_STATE }),
  [PREPARE_ACTIONS.RESUME]: Object.freeze({ steps: RESUME_STEPS, end: 'EXACT_BASELINE' }),
});
// The reviewed orchestration contracts, bound into the plan digests.
export const PREPARE_PHASES = Object.freeze([
  'static-gates',
  'load-runtime',
  'prove-identity',
  'classify',
  'supersede-current-checkpoints',
  `FRESH: recheck-payload-and-config, ${PHASE.MIGRATE}, prove-identity, classify-expect-MIGRATED_EMPTY`,
  `MIGRATED_EMPTY: prove-identity, ${PHASE.SEED}, prove-identity, classify-expect-POST_SEED1`,
  `POST_SEED1: prove-identity, ${PHASE.BACKFILL}, prove-identity, classify-expect-POST_BACKFILL`,
  'record-checkpoint',
  'stop-at-POST_BACKFILL',
]);
export const RESUME_PHASES = Object.freeze([
  'static-gates',
  'verify-backup-evidence(files, age, current-checkpoint, strict pg_restore-list, embedded PRE witness)',
  'verify-owner-authorization(single-use, bound to this backup, plan and fPre)',
  'load-runtime',
  'prove-identity',
  'classify-expect-POST_BACKFILL',
  'prepare-witness-directory(owner-only, durable, before the transaction)',
  'reverify-backup-evidence',
  'protected-transaction(locks, identity, settings, domain, classify, fingerprint==fPre, consume-authorization, seed#2, transformation-verifier, state-change-guard, durable-POST-witness, final-settings, COMMIT)',
  'record-checkpoint-consumed-and-completed(after acknowledged COMMIT only)',
]);
const ACTION_PHASES = Object.freeze({
  [PREPARE_ACTIONS.CHECKPOINT]: PREPARE_PHASES,
  [PREPARE_ACTIONS.RESUME]: RESUME_PHASES,
});
const ACTION_SUMMARY = Object.freeze({
  [PREPARE_ACTIONS.CHECKPOINT]:
    'ends at state POST_BACKFILL and records a new checkpoint (every current one is superseded before the first mutation); seed #2 and verify-baseline are NOT run (they need a verified backup of this checkpoint and --resume-from=POST_BACKFILL --backup-evidence)',
  [PREPARE_ACTIONS.RESUME]:
    'requires state POST_BACKFILL, the verified backup above and a single-use OWNER authorization; seed #2 runs inside ONE protected transaction (locks first, verified against the backup fingerprint, transformation-verified, digest-witnessed durably BEFORE COMMIT); the checkpoint is recorded consumed and completed only after the acknowledged COMMIT; an unknown COMMIT outcome is never retried (--check-outcome)',
});
export const checkpointOkLine = (id) => `CHECKPOINT OK — state POST_BACKFILL, checkpoint ${id} recorded; seed #2 and verify-baseline were NOT run`;

// Backup evidence: the run directory written by local-test-backup.mjs (exactly the
// archive and its self-hashed manifest). Shared with the backup tool.
export const BACKUP_TOOL = 'scripts/database/local-test-backup.mjs';
export const BACKUP_MANIFEST_FORMAT = 'mona-local-test-backup/v4';
export const BACKUP_STATE = CHECKPOINT_STATE;
export const BACKUP_DUMP_FILE = 'local-test.dump';
export const BACKUP_MANIFEST_FILE = `${BACKUP_DUMP_FILE}.manifest.json`;
export const BACKUP_RUN_DIR = /^local-test-\d{8}T\d{6}Z-[0-9a-f]{8}$/;
// Exact key ORDER (the order the backup tool writes) and exact nested shapes: one
// byte representation per manifest, so its self-hash and sha256 are unambiguous.
// v4 (V2.3.3 R4): + the embedded digest-only PRE witness (identity of the dumped state: fPre and its bindings), its text hash,
// the TOC multiset digest and the pg_dump flag record. NOT in the manifest: a state stream, per-relation/schema digests,
// row counts or the snapshot id (evidence minimization). The run is exactly dump + manifest.
export const BACKUP_MANIFEST_KEYS = Object.freeze([
  'format', 'target', 'markerIdSha256', 'state', 'createdAt', 'run', 'checkpoint', 'dump', 'migrations', 'lock',
  'list', 'pgDump', 'pgRestore', 'tool', 'plan', 'preWitness', 'preWitnessSha256', 'tocMultisetSha256', 'dumpFlags', 'manifestSha256',
]);
export const BACKUP_DUMP_FLAGS = Object.freeze(['snapshot', 'lockWaitTimeout', 'strictNames']);
export const MAX_BACKUP_AGE_MS = 6 * 60 * 60 * 1000;
export const ARCHIVE_MAGIC = 'PGDMP';
export const PG_RESTORE_PATH = '/usr/lib/postgresql/17/bin/pg_restore';
export const DEFAULT_FORBIDDEN_ROOTS = Object.freeze(['/tmp', '/var/tmp', '/dev/shm']);
const LOCAL_DATABASE_NAME = 'mona_local_test';
const GUARD_SCHEMA = 'mona_local_test_guard';

// Checkpoint store: one owner-only directory under the invoking user's home. A
// checkpoint is a POST_BACKFILL instance recorded by the generic --execute; a backup
// binds exactly one; the resume consumes it. CURRENT = the unique record without a
// consumed marker. Anything unexpected in the store fails closed.
export const CHECKPOINT_STORE = Object.freeze(['.local', 'state', 'mona-jacinta', 'local-test-checkpoints']);
export const CHECKPOINT_STORE_LABEL = `~/${CHECKPOINT_STORE.join('/')}`;
export const CHECKPOINT_FORMAT = 'mona-local-test-checkpoint/v1';
export const CHECKPOINT_CONSUMED_FORMAT = 'mona-local-test-checkpoint-consumed/v1';
export const CHECKPOINT_COMPLETED_FORMAT = 'mona-local-test-checkpoint-completed/v1';
export const CHECKPOINT_ID = /^cp-\d{8}T\d{6}Z-[0-9a-f]{32}$/;
export const CHECKPOINT_KEYS = Object.freeze([
  'format', 'id', 'target', 'markerIdSha256', 'state', 'createdAt', 'migrations', 'lock', 'plan', 'prepare', 'recordSha256',
]);
const CHECKPOINT_ENTRY = /^(cp-\d{8}T\d{6}Z-[0-9a-f]{32})\.(checkpoint|consumed|completed)\.json$/;

// Process containment for every child of both tools: the command is PID 1 of its own
// PID namespace (an unprivileged user namespace keeps the same uid), in its own
// process group. When it exits or is killed, the kernel kills everything left in the
// namespace, so setsid or a double fork cannot outlive it.
export const CONTAIN_COMMAND = '/usr/bin/unshare';
export const CONTAIN_ARGS = Object.freeze(['--user', '--map-current-user', '--pid', '--fork', '--kill-child', '--']);
export const KILL_AFTER_MS = 10 * 1000;
export const REAP_MS = 10 * 1000;

// Presence (not truthiness) of any of these refuses before anything is loaded.
export const FORBIDDEN_ENV = Object.freeze([
  'PGOPTIONS',
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_EXTRA_CA_CERTS',
  'DEBUG',
  'DATABASE_URL',
  'DIRECT_URL',
  'SHADOW_DATABASE_URL',
  'TEST_DATABASE_URL',
  'TEST_DATABASE_MARKER_ID',
  'MONA_TEST_DATABASE_TARGET',
]);
export const FORBIDDEN_ENV_PREFIXES = Object.freeze(['PG', 'PRISMA_', 'DOTENV_']);
export const CHILD_ENV_KEYS = Object.freeze([
  'CHECKPOINT_DISABLE',
  'HOME',
  'LOCAL_TEST_DATABASE_URL',
  'NODE_ENV',
  'PATH',
  'PRISMA_HIDE_UPDATE_MESSAGE',
  'TMPDIR',
]);

const PREFIX = '[db:local-test-prepare]';
const LOCAL_HOST = '127.0.0.1';
const LOCAL_PORT = '5432';
const LOCAL_DATABASE = 'mona_local_test';
const LOCAL_USER = 'mona_local_test';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PLAN_DIGEST = /^[0-9a-f]{64}$/;
const MODES = ['dry-run', 'check', 'execute', 'check-outcome', 'reconcile-completion'];
const RESUME_FROM_ARG = `resume-from`;
const BACKUP_EVIDENCE_ARG = `backup-evidence`;
const AUTHORIZATION_ARG = 'authorization';
const VALUE_ARGS = ['marker-id', 'confirm-local-target', 'plan', RESUME_FROM_ARG, BACKUP_EVIDENCE_ARG, AUTHORIZATION_ARG];
const AUTH_ID = /^[0-9a-f]{32}$/;
// The digest-only POST witnesses of a backup run: <home>/.local/state/mona-jacinta/local-test-resume-witnesses/<run>/<authId>.post.json
export const WITNESS_ROOT = Object.freeze(['.local', 'state', 'mona-jacinta', 'local-test-resume-witnesses']);
export const witnessRootPath = (home) => path.join(home, ...WITNESS_ROOT);
const MAX_HASHED_FILE_BYTES = 1024 * 1024;

// Exactly one mode and one canonical --marker-id; --confirm-local-target and
// --plan only (and always) with --execute. --resume-from=POST_BACKFILL and
// --backup-evidence=<absolute run directory> come together or not at all, and
// only with --dry-run/--execute. Rejected values are never echoed.
export function parsePrepareArgs(argv) {
  const values = {};
  const modes = [];
  for (const arg of argv) {
    if (typeof arg !== 'string' || !arg.startsWith('--')) return { ok: false, error: 'Unexpected positional argument (not echoed)' };
    const body = arg.slice(2);
    if (MODES.includes(body)) {
      if (modes.includes(body)) return { ok: false, error: `--${body} may be given only once` };
      modes.push(body);
      continue;
    }
    const eq = body.indexOf('=');
    const key = eq === -1 ? null : body.slice(0, eq);
    if (!key || !VALUE_ARGS.includes(key)) return { ok: false, error: 'Unknown argument (not echoed)' };
    if (key in values) return { ok: false, error: `--${key} may be given only once` };
    values[key] = body.slice(eq + 1);
  }
  if (modes.length !== 1) return { ok: false, error: 'Specify exactly one of --dry-run, --check or --execute' };
  const [mode] = modes;
  const markerId = values['marker-id'];
  if (markerId === undefined || !UUID_V4.test(markerId)) {
    return { ok: false, error: '--marker-id must be a canonical lowercase version-4 UUID' };
  }
  const confirm = values['confirm-local-target'] ?? null;
  const plan = values.plan ?? null;
  const authorization = values[AUTHORIZATION_ARG] ?? null;
  const resumeFrom = values[RESUME_FROM_ARG];
  const evidence = values[BACKUP_EVIDENCE_ARG];
  if (authorization !== null && !AUTH_ID.test(authorization)) return { ok: false, error: '--authorization must be the exact 32-character lowercase hex id printed by local-test-authorize-resume.mjs (value not echoed)' };
  if (evidence !== undefined && !path.isAbsolute(evidence)) {
    return { ok: false, error: '--backup-evidence must be an absolute run directory path (value not echoed)' };
  }
  // The read-only outcome verifier and the file-side completion reconciliation (R4): they take the backup run, never a plan,
  // and never --resume-from; reconcile additionally needs the explicit target confirmation and takes no authorization.
  if (mode === 'check-outcome' || mode === 'reconcile-completion') {
    if (evidence === undefined) return { ok: false, error: `--${mode} requires --backup-evidence=<absolute run directory of the backup the resume used>` };
    if (resumeFrom !== undefined || plan !== null) return { ok: false, error: `--${mode} accepts neither --resume-from nor --plan` };
    if (mode === 'check-outcome' && confirm !== null) return { ok: false, error: '--check-outcome does not accept --confirm-local-target' };
    if (mode === 'reconcile-completion') {
      if (confirm !== CONFIRM_LOCAL_TARGET) return { ok: false, error: `--reconcile-completion requires --confirm-local-target=${CONFIRM_LOCAL_TARGET} exactly` };
      if (authorization !== null) return { ok: false, error: '--reconcile-completion creates and uses no authorization' };
    }
    return { ok: true, mode, markerId, confirm, plan: null, authorization, backupEvidence: evidence };
  }
  if (mode !== 'execute' && (confirm !== null || plan !== null)) {
    return { ok: false, error: '--confirm-local-target and --plan are accepted only with --execute' };
  }
  if (mode === 'execute' && confirm !== CONFIRM_LOCAL_TARGET) {
    return { ok: false, error: `--execute requires --confirm-local-target=${CONFIRM_LOCAL_TARGET} exactly` };
  }
  if (mode === 'execute' && (plan === null || !PLAN_DIGEST.test(plan))) {
    return { ok: false, error: '--execute requires --plan=<the exact 64-character lowercase sha256 printed by the reviewed --dry-run>' };
  }
  if ((resumeFrom !== undefined || evidence !== undefined) && mode === 'check') {
    return { ok: false, error: '--resume-from and --backup-evidence are accepted only with --dry-run or --execute' };
  }
  if (resumeFrom === undefined && evidence !== undefined) {
    return { ok: false, error: `--backup-evidence is accepted only with --resume-from=${RESUME_FROM_VALUE}` };
  }
  if (resumeFrom !== undefined && resumeFrom !== RESUME_FROM_VALUE) {
    return { ok: false, error: `--resume-from accepts only ${RESUME_FROM_VALUE} (value not echoed)` };
  }
  if (resumeFrom !== undefined && evidence === undefined) {
    return { ok: false, error: `--resume-from=${RESUME_FROM_VALUE} requires --backup-evidence=<absolute run directory of a verified LOCAL_TEST backup>` };
  }
  // The OWNER authorization belongs to the resume --execute only (created by local-test-authorize-resume.mjs, single use).
  if (authorization !== null && !(mode === 'execute' && resumeFrom !== undefined)) {
    return { ok: false, error: '--authorization is accepted only with the resume --execute (or --check-outcome)' };
  }
  if (mode === 'execute' && resumeFrom !== undefined && authorization === null) {
    return { ok: false, error: '--execute with --resume-from requires --authorization=<authId> created by local-test-authorize-resume.mjs' };
  }
  // The generic (checkpoint) action keeps the pre-V2.3 result shape (no `action` key).
  if (resumeFrom !== undefined) return { ok: true, mode, markerId, confirm, plan, action: PREPARE_ACTIONS.RESUME, backupEvidence: evidence, authorization };
  return { ok: true, mode, markerId, confirm, plan };
}

// The one target: LOCAL_TEST_DATABASE_URL, already the canonical loopback text
// (same rule as readLocalTestTarget and prisma.local-test.config.ts), plus the
// pinned marker id. Values are never echoed.
export function readPrepareEnvironment(env) {
  const fail = (reason) => ({ ok: false, reason });
  const forbidden = Object.keys(env)
    .filter((key) => env[key] !== undefined)
    .filter((key) => FORBIDDEN_ENV.includes(key) || FORBIDDEN_ENV_PREFIXES.some((prefix) => key.startsWith(prefix)))
    .sort();
  if (forbidden.length > 0) {
    return fail(`forbidden variable(s) set in the environment: ${forbidden.join(', ')}; unset them (values not shown)`);
  }
  const raw = env[URL_VAR];
  if (typeof raw !== 'string' || raw === '') return fail(`${URL_VAR} is required`);
  let url;
  try {
    url = new URL(raw);
  } catch {
    return fail(`${URL_VAR} is not a valid URL (value not shown)`);
  }
  const canonical = `${url.protocol}//${LOCAL_USER}:${url.password}@${LOCAL_HOST}:${LOCAL_PORT}/${LOCAL_DATABASE}`;
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.password || raw !== canonical) {
    return fail(`${URL_VAR} must be exactly the canonical LOCAL_TEST loopback target (value not shown)`);
  }
  const markerId = env[MARKER_VAR];
  if (typeof markerId !== 'string' || !UUID_V4.test(markerId)) {
    return fail(`${MARKER_VAR} must be a canonical lowercase version-4 UUID (value not shown)`);
  }
  return { ok: true, url: raw, markerId };
}

// Hashes one regular file through a single descriptor (no symlinked final
// component, no FIFO hang, bounded size). Read-only.
export function hashRegularFile(file) {
  let fd;
  try {
    fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch {
    return { ok: false, reason: 'is missing or is a symlink' };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { ok: false, reason: 'is not a regular file' };
    if (st.size > MAX_HASHED_FILE_BYTES) return { ok: false, reason: 'is too large' };
    return { ok: true, sha256: createHash('sha256').update(readFileSync(fd)).digest('hex') };
  } catch {
    return { ok: false, reason: 'could not be read' };
  } finally {
    closeSync(fd);
  }
}

const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');
export const canonicalBackupJson = (value) => `${JSON.stringify(value, null, 2)}\n`;
export function backupManifestSelfHash(manifest) {
  const { manifestSha256, ...rest } = manifest;
  void manifestSha256;
  return sha256Hex(JSON.stringify(rest));
}
export function checkpointRecordSelfHash(record) {
  const { recordSha256, ...rest } = record;
  void recordSha256;
  return sha256Hex(JSON.stringify(rest));
}

const inside = (child, parent) => child === parent || child.startsWith(`${parent}${path.sep}`);
const HEX64 = /^[0-9a-f]{64}$/;
const isHex64 = (v) => typeof v === 'string' && HEX64.test(v);
const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const hasKeys = (v, keys) => isObject(v) && JSON.stringify(Object.keys(v)) === JSON.stringify(keys);
// Canonical UTC ISO-8601 with milliseconds, exactly as Date#toISOString writes it.
const isIsoInstant = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)
  && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString() === v;
const isPairList = (v) => Array.isArray(v) && v.length > 0
  && v.every((p) => Array.isArray(p) && p.length === 2 && typeof p[0] === 'string' && p[0] !== '' && isHex64(p[1]));
const isPathSha = (v) => hasKeys(v, ['path', 'sha256']) && typeof v.path === 'string' && path.isAbsolute(v.path) && isHex64(v.sha256);

// One owner-only directory: absolute, canonical (no symlink component, no trailing
// slash), an existing directory owned by `uid` with no group/other permission bits,
// outside the repository and outside temporary storage. Read-only.
function checkOwnerDirectory(dir, label, { repoRoot, forbiddenRoots, uid }) {
  const fail = (reason) => ({ ok: false, reason: `${label} ${reason}` });
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) return fail('must be an absolute path');
  let real;
  try {
    real = fsRealpathSync(dir);
  } catch {
    return fail('does not exist');
  }
  if (real !== dir) return fail('must be canonical (no symlink component, no trailing slash)');
  const st = lstatSync(dir);
  if (!st.isDirectory()) return fail('must be a directory');
  if (st.uid !== uid) return fail('must be owned by the current user');
  if ((st.mode & 0o077) !== 0) return fail('must have no group/other permissions (0700)');
  const canonicalRoots = (list) => list.map((p) => {
    try {
      return fsRealpathSync(p);
    } catch {
      return path.resolve(p);
    }
  });
  if (canonicalRoots([repoRoot]).some((r) => inside(real, r))) return fail('must be outside the repository');
  if (canonicalRoots(forbiddenRoots).some((r) => inside(real, r))) return fail('must be outside temporary storage');
  return { ok: true, root: real };
}

// Backup destination policy (see checkOwnerDirectory). Read-only.
export function checkBackupRoot(root, policy) {
  return checkOwnerDirectory(root, 'output root', policy);
}

// Streams one regular, non-symlink file owned by uid with mode 0600 through sha256;
// reports whether it starts with the custom-format archive magic.
export function inspectBackupArchive(file, uid) {
  let fd;
  try {
    fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch {
    return { ok: false, reason: 'archive is missing or is a symlink' };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { ok: false, reason: 'archive is not a regular file' };
    if (st.uid !== uid) return { ok: false, reason: 'archive is not owned by the current user' };
    if ((st.mode & 0o777) !== 0o600) return { ok: false, reason: 'archive mode is not 0600' };
    if (st.size === 0) return { ok: false, reason: 'archive is empty' };
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(1024 * 1024);
    let total = 0;
    let head = Buffer.alloc(0);
    for (;;) {
      const n = readSync(fd, buffer, 0, buffer.length, null);
      if (n === 0) break;
      if (head.length < ARCHIVE_MAGIC.length) head = Buffer.concat([head, buffer.subarray(0, Math.min(n, ARCHIVE_MAGIC.length - head.length))]);
      hash.update(buffer.subarray(0, n));
      total += n;
    }
    if (total !== st.size) return { ok: false, reason: 'archive size changed while hashing' };
    return { ok: true, sha256: hash.digest('hex'), bytes: total, magic: head.toString('latin1') === ARCHIVE_MAGIC };
  } catch {
    return { ok: false, reason: 'archive could not be read' };
  } finally {
    closeSync(fd);
  }
}

// Archive TOC (`pg_restore --list`, no connection): the STRICT R4 contract (R3 BACKUP-SNAPSHOT §3). Every line must be
// a blank line, one of the fixed header comment forms, or an entry whose type is in the allow-list; anything else is
// refused. Entries are counted in a Map BEFORE any comparison (a Set would hide a duplicate TABLE or TABLE DATA line).
// Required: exactly one dbname == mona_local_test, exactly one declared `TOC Entries: N` equal to the parsed entry count,
// no marker schema, TABLE and TABLE DATA each exactly once per relation, and exactly the 26 protected relations in
// schema `public`. The result carries a TOC MULTISET digest (sorted `type\tschema\tname` lines, duplicates kept) that the
// manifest binds. Reasons are fixed strings: nothing from the archive is echoed.
const TOC_HEADER_FORMS = [
  /^;$/, /^; Archive created at .+$/, /^;     Compression: \S+$/, /^;     Dump Version: \S+$/, /^;     Format: CUSTOM$/,
  /^;     Integer: \d+ bytes$/, /^;     Offset: \d+ bytes$/, /^;     Dumped from database version: .+$/, /^;     Dumped by pg_dump version: .+$/, /^; Selected TOC Entries:$/,
];
const TOC_ENTRY = /^(\d+); (\d+) (\d+) (TABLE DATA|TABLE|SCHEMA|COMMENT|TYPE|FUNCTION|CONSTRAINT|FK CONSTRAINT|INDEX|TRIGGER) (\S+) (.+) (\S+)$/;
const TOC_HEADER_ONLY_KINDS = Object.freeze(['ENCODING', 'STDSTRINGS', 'SEARCHPATH', 'DATABASE']);
const TOC_PUBLIC_ONLY = new Set(['TABLE DATA', 'TABLE', 'TYPE', 'FUNCTION', 'CONSTRAINT', 'FK CONSTRAINT', 'INDEX', 'TRIGGER']);
// `relations` defaults to the CURRENT protected set; only a set equal to a recognised backup generation's relations is accepted
// (never one derived from the archive or supplied ad hoc).
export function checkToc(text, relations = PROTECTED_RELATION_NAMES) {
  if (!isKnownBackupRelationSet(relations)) return { ok: false, reason: 'relation contract is not a recognised backup generation' };
  if (typeof text !== 'string' || text.trim() === '') return { ok: false, reason: 'pg_restore --list printed nothing' };
  const refuse = (reason) => ({ ok: false, reason });
  if (text.includes(GUARD_SCHEMA)) return refuse(`archive contains the ${GUARD_SCHEMA} schema`);
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const dbnames = [];
  const declared = [];
  const entries = [];
  for (const line of lines) {
    if (line === '' || TOC_HEADER_FORMS.some((form) => form.test(line))) continue;
    let m = /^;     dbname: (\S+)$/.exec(line);
    if (m) { dbnames.push(m[1]); continue; }
    m = /^;     TOC Entries: (0|[1-9]\d{0,8})$/.exec(line);
    if (m) { declared.push(Number(m[1])); continue; }
    m = TOC_ENTRY.exec(line);
    if (!m) return refuse('archive listing contains a line outside the reviewed grammar');
    const [, , , , type, schema, name] = m;
    if (TOC_PUBLIC_ONLY.has(type) && schema !== 'public') return refuse('archive contains a non-public object entry');
    entries.push({ type, schema, name });
  }
  if (dbnames.length !== 1 || dbnames[0] !== LOCAL_DATABASE_NAME) return refuse('archive dbname is not mona_local_test');
  // `TOC Entries` counts EVERY archive entry; the plain `pg_restore --list` omits the header-only ones (ENCODING, STDSTRINGS,
  // SEARCHPATH, DATABASE: visible only with --verbose), each of which exists at most once and some of which depend on the version.
  // So the listed entries must be a subset-by-count: listed <= declared <= listed + (number of header-only kinds).
  if (declared.length !== 1 || declared[0] < entries.length || declared[0] > entries.length + TOC_HEADER_ONLY_KINDS.length) {
    return refuse('archive declared entry count differs from the listed entries');
  }
  const counts = (type) => {
    const map = new Map();
    for (const e of entries) if (e.type === type) map.set(e.name, (map.get(e.name) ?? 0) + 1);
    return map;
  };
  const tables = counts('TABLE');
  const data = counts('TABLE DATA');
  if ([...tables.values()].some((n) => n !== 1)) return refuse('archive lists a table more than once');
  if ([...data.values()].some((n) => n !== 1)) return refuse('archive lists TABLE DATA more than once');
  for (const name of tables.keys()) if (!data.has(name)) return refuse('archive lists a table without its TABLE DATA entry');
  for (const name of data.keys()) if (!tables.has(name)) return refuse('archive lists TABLE DATA without its table');
  if (tables.size !== relations.length || relations.some((n) => !tables.has(n))) return refuse('archive tables differ from the protected relations');
  const multiset = entries.map((e) => `${e.type}\t${e.schema}\t${e.name}`).sort().join('\n');
  return { ok: true, entries: entries.length, tables: tables.size, multisetSha256: createHash('sha256').update(`${multiset}\n`).digest('hex') };
}

// The reviewed manifest shape: exact key order, exact nested keys, typed values.
function manifestShapeError(m) {
  if (JSON.stringify(Object.keys(m)) !== JSON.stringify(BACKUP_MANIFEST_KEYS)) return 'manifest fields differ from the reviewed format';
  if (!isIsoInstant(m.createdAt)) return 'manifest createdAt is not a canonical UTC instant';
  if (!hasKeys(m.checkpoint, ['id', 'recordSha256']) || typeof m.checkpoint.id !== 'string' || !CHECKPOINT_ID.test(m.checkpoint.id) || !isHex64(m.checkpoint.recordSha256)) {
    return 'manifest checkpoint binding is malformed';
  }
  if (!hasKeys(m.dump, ['file', 'bytes', 'sha256']) || !isCount(m.dump.bytes) || !isHex64(m.dump.sha256)) return 'manifest dump entry is malformed';
  if (!isPairList(m.migrations) || !hasKeys(m.lock, ['provider', 'sha256']) || typeof m.lock.provider !== 'string' || !isHex64(m.lock.sha256)) {
    return 'manifest migration payload is malformed';
  }
  if (!hasKeys(m.list, ['sha256', 'entries', 'tables']) || !isHex64(m.list.sha256) || !isCount(m.list.entries) || !isCount(m.list.tables)) {
    return 'manifest TOC entry is malformed';
  }
  if (!isPathSha(m.pgDump) || !isPathSha(m.pgRestore)) return 'manifest tool binaries are malformed';
  if (!hasKeys(m.tool, ['file', 'sha256']) || !isHex64(m.tool.sha256) || !isHex64(m.plan) || !isHex64(m.manifestSha256)) {
    return 'manifest tool/plan fields are malformed';
  }
  if (!isHex64(m.preWitnessSha256) || !isHex64(m.tocMultisetSha256)) return 'manifest evidence digests are malformed';
  if (!hasKeys(m.dumpFlags, BACKUP_DUMP_FLAGS) || BACKUP_DUMP_FLAGS.some((k) => m.dumpFlags[k] !== true)) return 'manifest dump flags are not the reviewed ones';
  if (!isObject(m.preWitness) || m.preWitness.format !== PRE_FORMAT) return 'manifest PRE witness is malformed';
  return null;
}

// One finalized backup run directory, files only (no database, no process): exactly
// the archive and its manifest, both owner-only 0600 regular non-symlink files in an
// owner-only 0700 canonical directory; the manifest canonical, self-hashed, of the
// current format with exactly the reviewed fields in the reviewed order, naming this
// run, the LOCAL_TEST target and state POST_BACKFILL; the archive bytes/sha256 equal
// to the manifest and starting with the custom-format magic. Integrity only: the
// archive itself is validated by pg_restore --list (verifyResumeEvidence, --verify).
export function readBackupRun(runDir, uid) {
  const fail = (reason) => ({ ok: false, reason });
  if (typeof runDir !== 'string' || !path.isAbsolute(runDir) || !BACKUP_RUN_DIR.test(path.basename(runDir))) {
    return fail('run directory path is malformed');
  }
  let real;
  try {
    real = fsRealpathSync(runDir);
  } catch {
    return fail('run directory does not exist');
  }
  if (real !== runDir) return fail('run directory must be canonical');
  let text;
  try {
    const st = lstatSync(runDir);
    if (!st.isDirectory() || st.uid !== uid || (st.mode & 0o777) !== 0o700) return fail('run directory must be an owner-only 0700 directory');
    const names = readdirSync(runDir).sort();
    if (JSON.stringify(names) !== JSON.stringify([BACKUP_DUMP_FILE, BACKUP_MANIFEST_FILE])) {
      return fail('run directory must hold exactly the archive and its manifest');
    }
    const fd = openSync(path.join(runDir, BACKUP_MANIFEST_FILE), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    try {
      const mst = fstatSync(fd);
      if (!mst.isFile() || mst.uid !== uid || (mst.mode & 0o777) !== 0o600 || mst.size > MAX_HASHED_FILE_BYTES) {
        return fail('manifest must be an owner-only 0600 regular file');
      }
      text = readFileSync(fd, 'utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return fail('manifest is missing, a symlink or unreadable');
  }
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    return fail('manifest is not JSON');
  }
  if (!isObject(manifest)) return fail('manifest is not an object');
  if (text !== canonicalBackupJson(manifest) || manifest.manifestSha256 !== backupManifestSelfHash(manifest)) {
    return fail('manifest is not canonical or its self-hash does not match');
  }
  if (manifest.format !== BACKUP_MANIFEST_FORMAT) return fail(`manifest format is not ${BACKUP_MANIFEST_FORMAT} (stale or foreign backup)`);
  const shape = manifestShapeError(manifest);
  if (shape) return fail(shape);
  if (manifest.state !== BACKUP_STATE || manifest.target !== CONFIRM_LOCAL_TARGET || manifest.run !== path.basename(runDir)) {
    return fail('manifest identity fields do not match this run');
  }
  const archive = inspectBackupArchive(path.join(runDir, BACKUP_DUMP_FILE), uid);
  if (!archive.ok) return fail(archive.reason);
  const dump = manifest.dump;
  if (dump.file !== BACKUP_DUMP_FILE || dump.sha256 !== archive.sha256 || dump.bytes !== archive.bytes) {
    return fail('archive does not match the manifest');
  }
  if (!archive.magic) return fail('archive is not a PostgreSQL custom-format archive');
  // The embedded PRE witness: closed key set, per-key patterns, canonical bytes (parseWitness), bound by its text hash and by
  // the manifest's own target/marker. A passwordHash, e-mail or JSON in any slot cannot pass the slot patterns.
  const witnessText = `${JSON.stringify(manifest.preWitness)}\n`;
  const parsedWitness = parseWitness('PRE', witnessText);
  if (!parsedWitness.ok) return fail('manifest PRE witness is invalid');
  if (manifest.preWitnessSha256 !== preWitnessSha256(witnessText)) return fail('manifest PRE witness hash does not match its text');
  if (manifest.preWitness.target !== manifest.target || manifest.preWitness.markerIdSha256 !== manifest.markerIdSha256) return fail('manifest PRE witness is bound to another target or installation');
  return { ok: true, run: manifest.run, manifest, manifestSha256: sha256Hex(text), dump: { sha256: archive.sha256, bytes: archive.bytes }, preWitness: { obj: parsedWitness.obj, text: witnessText, sha256: manifest.preWitnessSha256 } };
}

// The file-only part of the resume evidence: a finalized backup run (readBackupRun)
// under a policy-valid backup root, taken for THIS marker, under THIS migration
// payload, by THIS backup tool source. Values are never echoed.
export function verifyBackupEvidence(runDir, { uid, repoRoot, forbiddenRoots, markerId, payload, backupToolSha256 }) {
  const fail = (reason) => ({ ok: false, reason: `backup evidence ${reason}` });
  const run = readBackupRun(runDir, uid);
  if (!run.ok) return fail(run.reason);
  const root = checkBackupRoot(path.dirname(runDir), { repoRoot, forbiddenRoots, uid });
  if (!root.ok) return fail(root.reason);
  const m = run.manifest;
  if (m.markerIdSha256 !== sha256Hex(markerId)) return fail('was taken for another LOCAL_TEST marker');
  const migrations = payload.migrations.map(({ name, sha256 }) => [name, sha256]);
  const lock = { provider: payload.lock.provider, sha256: payload.lock.sha256 };
  if (JSON.stringify(m.migrations) !== JSON.stringify(migrations) || JSON.stringify(m.lock) !== JSON.stringify(lock)) {
    return fail('is bound to a different migration payload');
  }
  if (m.tool.file !== BACKUP_TOOL || m.tool.sha256 !== backupToolSha256) {
    return fail(`was produced by a different ${BACKUP_TOOL} source`);
  }
  return run;
}

// --- checkpoint store ----------------------------------------------------------------

export const checkpointStorePath = (home) => path.join(home, ...CHECKPOINT_STORE);

function readOwnerFile(file, uid, maxBytes = 64 * 1024) {
  let fd;
  try {
    fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch {
    return { ok: false };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.uid !== uid || (st.mode & 0o777) !== 0o600 || st.size > maxBytes) return { ok: false };
    return { ok: true, text: readFileSync(fd, 'utf8') };
  } catch {
    return { ok: false };
  } finally {
    closeSync(fd);
  }
}

function checkpointRecordError(record, id) {
  if (!isObject(record) || JSON.stringify(Object.keys(record)) !== JSON.stringify(CHECKPOINT_KEYS)) return 'fields differ from the reviewed format';
  if (record.format !== CHECKPOINT_FORMAT || record.id !== id || record.target !== CONFIRM_LOCAL_TARGET || record.state !== CHECKPOINT_STATE) {
    return 'identity fields are wrong';
  }
  if (!isHex64(record.markerIdSha256) || !isIsoInstant(record.createdAt) || !isPairList(record.migrations) || !isHex64(record.plan)) return 'is malformed';
  if (!hasKeys(record.lock, ['provider', 'sha256']) || !hasKeys(record.prepare, ['file', 'sha256']) || record.prepare.file !== PREPARE_TOOL || !isHex64(record.prepare.sha256)) {
    return 'is malformed';
  }
  if (!isHex64(record.recordSha256) || record.recordSha256 !== checkpointRecordSelfHash(record)) return 'self-hash does not match';
  return null;
}

// Reads the whole store (files only). Every entry must be an owner-only 0600 regular
// file named for a checkpoint id; every checkpoint record canonical and self-hashed;
// consumed/completed markers only for recorded checkpoints, completed only after
// consumed. `missingOk` lets the generic --execute start from an absent store.
export function readCheckpointStore(home, { uid, repoRoot, forbiddenRoots }, { missingOk = false } = {}) {
  const fail = (reason) => ({ ok: false, reason: `checkpoint store ${reason}` });
  if (typeof home !== 'string' || !path.isAbsolute(home)) return fail('home is not an absolute path');
  let realHome;
  try {
    realHome = fsRealpathSync(home);
  } catch {
    return fail('home does not exist');
  }
  const store = checkpointStorePath(realHome);
  try {
    lstatSync(store);
  } catch {
    return missingOk ? { ok: true, store, exists: false, records: [], current: [] } : fail(`${CHECKPOINT_STORE_LABEL} does not exist (no checkpoint was ever recorded)`);
  }
  const dir = checkOwnerDirectory(store, `checkpoint store ${CHECKPOINT_STORE_LABEL}`, { repoRoot, forbiddenRoots, uid });
  if (!dir.ok) return { ok: false, reason: dir.reason };
  let names;
  try {
    names = readdirSync(store).sort();
  } catch {
    return fail('could not be listed');
  }
  const records = new Map();
  const consumed = new Set();
  const completed = new Set();
  for (const name of names) {
    const m = CHECKPOINT_ENTRY.exec(name);
    if (!m) return fail('holds an unexpected entry');
    const file = readOwnerFile(path.join(store, name), uid);
    if (!file.ok) return fail('holds an entry that is not an owner-only 0600 regular file');
    if (m[2] === 'checkpoint') {
      let record;
      try {
        record = JSON.parse(file.text);
      } catch {
        return fail('holds a checkpoint record that is not JSON');
      }
      if (file.text !== canonicalBackupJson(record)) return fail('holds a non-canonical checkpoint record');
      const error = checkpointRecordError(record, m[1]);
      if (error) return fail(`checkpoint record ${error}`);
      records.set(m[1], { record, recordSha256: record.recordSha256 });
    } else (m[2] === 'consumed' ? consumed : completed).add(m[1]);
  }
  for (const id of [...consumed, ...completed]) if (!records.has(id)) return fail('holds a marker for an unknown checkpoint');
  for (const id of completed) if (!consumed.has(id)) return fail('holds a completion without a consumption');
  const current = [...records.keys()].filter((id) => !consumed.has(id)).map((id) => records.get(id));
  return { ok: true, store, exists: true, records: [...records.values()], current, consumed };
}

// The current checkpoint for THIS marker and payload: exactly one unconsumed record.
export function readCurrentCheckpoint(home, policy, markerId, payload) {
  const store = readCheckpointStore(home, policy);
  if (!store.ok) return store;
  const fail = (reason) => ({ ok: false, reason: `checkpoint ${reason}` });
  if (store.current.length === 0) return { ok: false, reason: 'checkpoint store has no current checkpoint (all consumed or superseded); run the generic --execute to record one' };
  if (store.current.length > 1) return { ok: false, reason: 'checkpoint store has more than one current checkpoint (inconsistent); nothing is chosen' };
  const [{ record, recordSha256 }] = store.current;
  if (record.markerIdSha256 !== sha256Hex(markerId)) return fail('was recorded for another LOCAL_TEST marker');
  const migrations = payload.migrations.map(({ name, sha256 }) => [name, sha256]);
  if (JSON.stringify(record.migrations) !== JSON.stringify(migrations)
    || JSON.stringify(record.lock) !== JSON.stringify({ provider: payload.lock.provider, sha256: payload.lock.sha256 })) {
    return fail('was recorded under a different migration payload');
  }
  return { ok: true, store: store.store, record, recordSha256 };
}

// Creates one owner-only 0600 file that must not exist yet (never overwrites, never
// follows a symlink) and makes it durable.
export function writeExclusiveFile(file, text) {
  const fd = openSync(file, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

const utcStamp = (date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

// Generic --execute, before its first mutation: create the store if absent, then
// supersede every current checkpoint (the database is about to change).
export function supersedeCheckpoints(home, policy, { now, plan }) {
  const fail = (reason) => ({ ok: false, reason: `checkpoint store ${reason}` });
  let first = readCheckpointStore(home, policy, { missingOk: true });
  if (!first.ok) return first;
  if (!first.exists) {
    try {
      mkdirSync(first.store, { recursive: true, mode: 0o700 });
    } catch {
      return fail('could not be created');
    }
    first = readCheckpointStore(home, policy);
    if (!first.ok) return first;
  }
  for (const { record } of first.current) {
    const marker = { format: CHECKPOINT_CONSUMED_FORMAT, id: record.id, reason: 'superseded', at: now.toISOString(), plan };
    try {
      writeExclusiveFile(path.join(first.store, `${record.id}.consumed.json`), canonicalBackupJson(marker));
    } catch {
      return fail('could not supersede a current checkpoint');
    }
  }
  const after = readCheckpointStore(home, policy);
  if (!after.ok) return after;
  if (after.current.length !== 0) return fail('still has a current checkpoint after superseding');
  return { ok: true, superseded: first.current.length };
}

// Generic --execute at POST_BACKFILL: the one new current checkpoint.
export function recordCheckpoint(home, policy, { now, plan, markerId, payload, prepareSha256, random = () => randomBytes(16).toString('hex') }) {
  const store = readCheckpointStore(home, policy);
  if (!store.ok) return store;
  if (store.current.length !== 0) return { ok: false, reason: 'checkpoint store: a current checkpoint already exists; nothing recorded' };
  const id = `cp-${utcStamp(now)}-${random()}`;
  if (!CHECKPOINT_ID.test(id)) return { ok: false, reason: 'checkpoint id is malformed' };
  const record = {
    format: CHECKPOINT_FORMAT,
    id,
    target: CONFIRM_LOCAL_TARGET,
    markerIdSha256: sha256Hex(markerId),
    state: CHECKPOINT_STATE,
    createdAt: now.toISOString(),
    migrations: payload.migrations.map(({ name, sha256 }) => [name, sha256]),
    lock: { provider: payload.lock.provider, sha256: payload.lock.sha256 },
    plan,
    prepare: { file: PREPARE_TOOL, sha256: prepareSha256 },
  };
  record.recordSha256 = checkpointRecordSelfHash(record);
  try {
    writeExclusiveFile(path.join(store.store, `${id}.checkpoint.json`), canonicalBackupJson(record));
  } catch {
    return { ok: false, reason: 'checkpoint record could not be written' };
  }
  const current = readCurrentCheckpoint(home, policy, markerId, payload);
  if (!current.ok || current.record.id !== id) return { ok: false, reason: 'checkpoint record could not be read back as the current checkpoint' };
  return { ok: true, id, recordSha256: record.recordSha256 };
}

// Resume, immediately before seed #2: the single use. O_EXCL means a concurrent or
// repeated resume of the same checkpoint can never pass this point twice.
export function consumeCheckpoint(store, id, { now, plan, run, reason = 'resume-committed' }) {
  // R4: the checkpoint is consumed only AFTER an acknowledged COMMIT (or a verified POST_SEED_EXACT): a rolled-back resume must
  // leave it current so a fresh authorization can resume the same backup. Single use is carried by the authorization (O_EXCL)
  // and by the state itself (after a committed seed the fingerprint can never again equal fPre).
  const marker = { format: CHECKPOINT_CONSUMED_FORMAT, id, reason, at: now.toISOString(), plan, run };
  try {
    writeExclusiveFile(path.join(store, `${id}.consumed.json`), canonicalBackupJson(marker));
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

export function completeCheckpoint(store, id, { now, plan, run, evidence = {} }) {
  // digests and ids only (no row data): which exact states and which authorization the committed seed #2 relates to
  const marker = { format: CHECKPOINT_COMPLETED_FORMAT, id, outcome: 'seed #2 committed; the verified post-state was witnessed', at: now.toISOString(), plan, run, ...evidence };
  try {
    writeExclusiveFile(path.join(store, `${id}.completed.json`), canonicalBackupJson(marker));
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

// --- archive listing ------------------------------------------------------------------

export const restoreChildEnv = (home) => ({ HOME: home, LC_ALL: 'C', PATH: '/usr/bin:/bin', TZ: 'UTC' });

// `pg_restore --list <archive>` (archive only, never a connection), contained.
export async function listBackupArchive(file, deps) {
  const toc = [];
  const result = await runContained(deps, {
    label: path.basename(deps.pgRestore),
    command: deps.pgRestore,
    args: ['--list', file],
    options: { cwd: '/', stdio: ['ignore', 'pipe', 'pipe'] },
    env: restoreChildEnv(deps.home),
  }, { onOut: (line) => toc.push(line), onErr: () => undefined });
  if (!result.ok) return { ok: false, reason: result.detail };
  // LOW-10 / G26: a list that exits 0 but wrote anything to stderr is not a clean archive. The bytes are never shown.
  if (result.stderrBytes > 0) return { ok: false, reason: 'pg_restore --list wrote to stderr (refused; bytes not shown)' };
  return { ok: true, text: toc.length ? `${toc.join('\n')}\n` : '' };
}

// The complete resume evidence (V2.3.2): the file checks above, the backup age, the
// binding to the CURRENT checkpoint, the reviewed pg_restore binary and a clean
// pg_restore --list whose TOC is exactly the one the manifest recorded. Only this is
// "verified". Values are never echoed.
export async function verifyResumeEvidence(runDir, { markerId, payload, backupToolSha256 }, deps) {
  const fail = (reason) => ({ ok: false, reason: `backup evidence ${reason}` });
  const policy = { uid: deps.uid, repoRoot: deps.repoRoot, forbiddenRoots: deps.forbiddenRoots };
  const files = verifyBackupEvidence(runDir, { ...policy, markerId, payload, backupToolSha256 });
  if (!files.ok) return files;
  const m = files.manifest;
  const created = Date.parse(m.createdAt);
  const now = deps.now().getTime();
  if (!(now >= created)) return fail('is dated in the future');
  if (now - created > MAX_BACKUP_AGE_MS) return fail(`is older than ${MAX_BACKUP_AGE_MS / 3600000} h; take a fresh backup of the current checkpoint`);
  const checkpoint = readCurrentCheckpoint(deps.home, policy, markerId, payload);
  if (!checkpoint.ok) return fail(`cannot be bound: ${checkpoint.reason}`);
  if (m.checkpoint.id !== checkpoint.record.id || m.checkpoint.recordSha256 !== checkpoint.recordSha256) {
    return fail('is bound to a checkpoint that is not the current one (superseded, consumed, re-prepared or foreign)');
  }
  if (Date.parse(checkpoint.record.createdAt) > created) return fail('predates its checkpoint');
  if (deps.pgRestore !== m.pgRestore.path) return fail('was listed by a different pg_restore path');
  const binary = deps.hashBinary(deps.pgRestore);
  if (!binary.ok || binary.sha256 !== m.pgRestore.sha256) return fail('pg_restore binary differs from the one that verified the backup');
  const archiveFile = path.join(runDir, BACKUP_DUMP_FILE);
  const listed = await deps.listArchive(archiveFile, deps);
  if (!listed || !listed.ok) return fail('archive could not be listed by pg_restore --list (not a valid archive)');
  const toc = checkToc(listed.text);
  if (!toc.ok) return fail(toc.reason);
  const tocSha256 = sha256Hex(listed.text);
  if (tocSha256 !== m.list.sha256 || toc.entries !== m.list.entries || toc.tables !== m.list.tables || toc.multisetSha256 !== m.tocMultisetSha256) {
    return fail('archive TOC does not match the manifest');
  }
  const again = inspectBackupArchive(archiveFile, deps.uid);
  if (!again.ok || again.sha256 !== files.dump.sha256 || again.bytes !== files.dump.bytes) return fail('archive changed while it was being listed');
  return {
    ok: true,
    run: files.run,
    dump: files.dump,
    manifestSha256: files.manifestSha256,
    store: checkpoint.store,
    checkpoint: { id: checkpoint.record.id, recordSha256: checkpoint.recordSha256 },
    tocSha256,
    pgRestoreSha256: binary.sha256,
    toc: { entries: toc.entries, tables: toc.tables },
    ageSeconds: Math.floor((now - created) / 1000),
    createdAt: m.createdAt,
    tocMultisetSha256: toc.multisetSha256,
    // the digest-only identity of the dumped state (embedded PRE witness): what the OWNER authorization and the POST witness bind
    fPre: files.preWitness.obj.fPre,
    preWitnessSha256: files.preWitness.sha256,
  };
}

// Exact child invocation: this Node binary runs the repository-local Prisma CLI
// script with the explicit LOCAL_TEST config; argv array only, never a shell.
export function buildPrismaMigrationSpec({ execPath, prisma }) {
  return Object.freeze({
    command: execPath,
    args: Object.freeze([prisma.script, ...PRISMA_MIGRATE_ARGS]),
    options: Object.freeze({ cwd: prisma.cwd, stdio: Object.freeze(['ignore', 'pipe', 'pipe']), shell: false }),
  });
}

// Allowlisted child environment, built fresh: nothing from the invoking shell is
// inherited (any `env` passed alongside is ignored). PATH is fixed (this Node's
// directory plus system dirs); NODE_ENV=production keeps api/src/config/load-env.ts
// off .env.development; telemetry and update checks are off. The marker id is
// not passed: prisma.local-test.config.ts reads LOCAL_TEST_DATABASE_URL only.
export function buildPrismaChildEnv(url, { execPath, home, tmpdir }) {
  return {
    CHECKPOINT_DISABLE: '1',
    HOME: home,
    [URL_VAR]: url,
    NODE_ENV: 'production',
    PATH: [path.dirname(execPath), '/usr/local/bin', '/usr/bin', '/bin'].join(path.delimiter),
    PRISMA_HIDE_UPDATE_MESSAGE: '1',
    TMPDIR: tmpdir,
  };
}

export const GENERIC_AT_CHECKPOINT_REASON =
  'POST_BACKFILL is the backup checkpoint: the generic --execute never runs seed #2; take a verified backup, then use '
  + `--resume-from=${RESUME_FROM_VALUE} --backup-evidence=<run directory>; nothing is run`;

// Pure (start state, action) → the mutating phases the transition table will run.
// Unknown, unsafe, drifted or operational states refuse; nothing is ever repaired.
// The checkpoint action refuses POST_BACKFILL and EXACT_BASELINE; only the resume
// action has a transition out of POST_BACKFILL, and it ends with the verifier.
export function decidePrepareAction(state, action = PREPARE_ACTIONS.CHECKPOINT) {
  if (typeof action !== 'string' || !Object.hasOwn(ACTION_STEPS, action)) return { ok: false, reason: 'unknown prepare action; nothing is run' };
  if (action === PREPARE_ACTIONS.CHECKPOINT && state === CHECKPOINT_STATE) return { ok: false, reason: GENERIC_AT_CHECKPOINT_REASON };
  if (action === PREPARE_ACTIONS.CHECKPOINT && state === 'EXACT_BASELINE') {
    return { ok: false, reason: 'EXACT_BASELINE is beyond the backup checkpoint; nothing is run (use --check)' };
  }
  const { steps, end } = ACTION_STEPS[action];
  if (typeof state !== 'string' || !Object.hasOwn(steps, state)) {
    return {
      ok: false,
      reason: action === PREPARE_ACTIONS.RESUME
        ? 'the resume requires state POST_BACKFILL; nothing is run'
        : 'database state is not a known state before the backup checkpoint; nothing is repaired',
    };
  }
  const phases = [];
  for (let at = state; at !== end; at = steps[at].next) phases.push(steps[at].phase);
  if (action === PREPARE_ACTIONS.RESUME) phases.push(PHASE.VERIFY);
  return { ok: true, phases };
}

export function preparePhaseList() {
  return PREPARE_PHASES;
}

// Plan body: nested arrays in a fixed order (no object-key order dependence).
// Symbolic target only: never the URL, password, home, tmpdir, evidence path or
// env values. Each action binds its name, this prepare source and its phase
// contract; the resume plan also binds exactly one verified backup (run, dump
// sha256/bytes, manifest sha256, backup tool sha256, checkpoint id and record sha256,
// archive TOC sha256, pg_restore sha256), so its digest names the backup and the
// checkpoint the OWNER approves.
export function buildPreparePlan({ markerId, prisma, apiDir, configSha256, companySha256, payload, action = PREPARE_ACTIONS.CHECKPOINT, backup = null, prepareSha256 = null }) {
  if (typeof action !== 'string' || !Object.hasOwn(ACTION_PHASES, action)) throw new Error('unknown prepare action');
  if ((action === PREPARE_ACTIONS.RESUME) !== (backup !== null)) throw new Error('a resume plan binds exactly one verified backup');
  return [
    ['target', CONFIRM_LOCAL_TARGET],
    ['markerId', markerId],
    ['prisma', prisma.version, path.relative(apiDir, prisma.script).split(path.sep).join('/')],
    ['cwd', 'api/'],
    ['argv', ...PRISMA_MIGRATE_ARGS],
    ['config', PRISMA_CONFIG, configSha256],
    ['migrations', ...payload.migrations.map((m) => [m.name, m.sha256])],
    ['lock', payload.lock.provider, payload.lock.sha256],
    ['company', COMPANY_DESCRIPTOR, companySha256],
    ['childEnv', ...CHILD_ENV_KEYS],
    ['prepare', PREPARE_TOOL, prepareSha256],
    ['action', action],
    ...(backup
      ? [['backup', backup.run, backup.dumpSha256, backup.dumpBytes, backup.manifestSha256, backup.toolSha256,
        backup.checkpointId, backup.checkpointSha256, backup.tocSha256, backup.pgRestoreSha256, backup.tocMultisetSha256, backup.fPre, backup.preWitnessSha256]]
      : []),
    ['phases', ...ACTION_PHASES[action]],
    ['never', 'marker install/repair', 'database provisioning', 'role or user provisioning', 'migrate dev/reset', 'db push'],
  ];
}
export const canonicalPreparePlan = (plan) => `${PLAN_DOMAIN}\n${JSON.stringify(plan)}\n`;
export const digestPreparePlan = (plan) => createHash('sha256').update(canonicalPreparePlan(plan), 'utf8').digest('hex');

// Redacts the held URL and its password (raw, decoded, percent-encoded). The
// symbolic target identity is not a secret.
export function createRedactor(url) {
  const secrets = new Set([url]);
  try {
    const parsed = new URL(url);
    secrets.add(parsed.password);
    const decoded = decodeURIComponent(parsed.password);
    secrets.add(decoded);
    secrets.add(encodeURIComponent(decoded));
  } catch {
    /* the whole URL is still redacted */
  }
  const ordered = [...secrets].filter((s) => typeof s === 'string' && s.length >= 3).sort((a, b) => b.length - a.length);
  return (line) => ordered.reduce((out, secret) => out.split(secret).join('«redacted»'), line);
}

function lineForwarder(stream, redact, sink) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  const emit = (text) => {
    pending += text;
    const lines = pending.split('\n');
    pending = lines.pop();
    for (const line of lines) sink(redact(line.replace(/\r$/, '')));
  };
  stream?.on('data', (chunk) => emit(typeof chunk === 'string' ? chunk : decoder.write(chunk)));
  return () => {
    emit(decoder.end());
    if (pending) sink(redact(pending));
    pending = '';
  };
}

// The kernel's overflow uid: how a file owned by an unmapped uid (host root, seen
// from inside a user namespace) appears.
function overflowUid() {
  try {
    const value = Number(readFileSync('/proc/sys/kernel/overflowuid', 'utf8').trim());
    return Number.isSafeInteger(value) ? value : 65534;
  } catch {
    return 65534;
  }
}

// The containment binary must be a regular file the invoking user cannot rewrite:
// owned by root (or by an unmapped uid when this runs inside a user namespace, never
// by the invoking uid) and without group/other write.
export function checkContainerBinary(file, uid = typeof process.getuid === 'function' ? process.getuid() : -1) {
  try {
    const st = lstatSync(file);
    const owner = st.uid === 0 || (st.uid === overflowUid() && st.uid !== uid);
    if (!st.isFile() || !owner || st.uid === uid || (st.mode & 0o022) !== 0) {
      return { ok: false, reason: `${file} must be a root-owned regular file without group/other write` };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: `${file} is missing` };
  }
}

// The contained form of one command: PID 1 of a new PID namespace (same uid).
export function containedSpec(command, args, containCommand = CONTAIN_COMMAND) {
  return Object.freeze({ command: containCommand, args: Object.freeze([...CONTAIN_ARGS, command, ...args]) });
}

// Runs one child contained and settles once. Success is ONLY exit code 0 with no
// signal, before the timeout. The command is PID 1 of its own PID namespace and its
// own process group: when it ends (or is killed) the kernel kills every process left
// in the namespace, so no descendant (setsid or double fork included) outlives it.
// Timeout: SIGTERM to the whole group, SIGKILL after the kill-after delay, then the
// child is reaped (close); one that cannot be reaped is reported as outcome unknown.
// Group signals are sent only to a real child (never to a fake test pid).
export function runContained(deps, { label, command, args, options, env }, { onOut, onErr }) {
  return new Promise((settle) => {
    let child;
    const timers = [];
    let done = false;
    let timedOut = false;
    // The size of the child's stderr is reported (never its bytes): a clean archive/dump/list must have exactly none.
    let stderrBytes = 0;
    const finish = (result) => {
      if (done) return;
      done = true;
      for (const t of timers) clearTimeout(t);
      settle({ ...result, stderrBytes });
    };
    const containCommand = deps.containCommand ?? CONTAIN_COMMAND;
    const container = (deps.checkContainer ?? checkContainerBinary)(containCommand, deps.uid);
    if (!container.ok) return settle({ ok: false, started: false, stderrBytes: 0, detail: `${label} was not started: ${container.reason}` });
    const spec = containedSpec(command, args, containCommand);
    try {
      child = deps.spawn(spec.command, [...spec.args], { ...options, stdio: [...(options.stdio ?? ['ignore', 'pipe', 'pipe'])], env, shell: false, detached: true });
    } catch {
      return settle({ ok: false, started: false, stderrBytes: 0, detail: `${label} could not be started` });
    }
    if (!child || typeof child.on !== 'function') return settle({ ok: false, stderrBytes: 0, detail: `${label} child handle is unusable; outcome unknown` });
    const signalTree = (signal) => {
      try {
        if (child.pid && deps.spawn === spawn) process.kill(-child.pid, signal);
      } catch {
        /* the group is already gone */
      }
      try {
        child.kill?.(signal);
      } catch {
        /* already a failure */
      }
    };
    timers.push(setTimeout(() => {
      timedOut = true;
      signalTree('SIGTERM');
      timers.push(setTimeout(() => {
        signalTree('SIGKILL');
        timers.push(setTimeout(() => finish({ ok: false, detail: `${label} timed out and was killed, but could not be reaped; outcome unknown` }), deps.reapMs ?? REAP_MS));
      }, deps.killAfterMs ?? KILL_AFTER_MS));
    }, deps.childTimeoutMs ?? CHILD_TIMEOUT_MS));
    child.stderr?.on('data', (chunk) => { stderrBytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length; });
    const flushOut = lineForwarder(child.stdout, (line) => line, onOut);
    const flushErr = lineForwarder(child.stderr, (line) => line, onErr ?? (() => undefined));
    child.on('error', () => finish({ ok: false, detail: `${label} could not be started or failed to run` }));
    child.on('close', (code, signal) => {
      flushOut();
      flushErr();
      if (timedOut) finish({ ok: false, detail: `${label} timed out and was killed (contained process tree: TERM, then KILL; reaped)` });
      else if (code === 0 && signal === null) finish({ ok: true });
      else if (signal) finish({ ok: false, detail: `${label} was terminated by ${signal}` });
      else if (Number.isInteger(code)) finish({ ok: false, detail: `${label} exited with code ${code}` });
      else finish({ ok: false, detail: `${label} exit status is unavailable` });
    });
  });
}

// The migration child: the reviewed spec, contained, its output redacted.
function runChild(deps, spec, env, redact) {
  return runContained(deps, { label: 'prisma', command: spec.command, args: spec.args, options: spec.options, env }, {
    onOut: (line) => deps.log(`  prisma| ${redact(line)}`),
    onErr: (line) => deps.error(`  prisma| ${redact(line)}`),
  });
}

// Resolves tsx only from the real, repository-verified api directory. The
// package declaration supplies the pin; the API entry may not escape tsx.
export function resolveTsxApi(apiDir) {
  try {
    const verifiedApiDir = fsRealpathSync(apiDir);
    const apiPackage = JSON.parse(readFileSync(path.join(verifiedApiDir, 'package.json'), 'utf8'));
    const version = apiPackage.devDependencies?.tsx ?? apiPackage.dependencies?.tsx;
    if (typeof version !== 'string' || version === '') throw new Error('missing pin');
    const tsxDir = fsRealpathSync(path.join(verifiedApiDir, 'node_modules', 'tsx'));
    const tsxPackage = JSON.parse(readFileSync(path.join(tsxDir, 'package.json'), 'utf8'));
    const entry = tsxPackage.exports?.['./esm/api']?.import?.default;
    if (typeof entry !== 'string' || entry === '') throw new Error('missing entry');
    const resolvedEntry = fsRealpathSync(path.join(tsxDir, entry));
    if (!resolvedEntry.startsWith(`${tsxDir}${path.sep}`)) throw new Error('external entry');
    return { ok: true, url: pathToFileURL(resolvedEntry).href, version };
  } catch {
    return { ok: false, reason: 'the verified api tsx runtime is unavailable' };
  }
}

export async function loadLocalTestRuntime(input, deps) {
  const runtimeUrl = pathToFileURL(path.join(deps.apiDir, RUNTIME_MODULE)).href;
  let tsImport = deps.tsImport;
  if (typeof tsImport !== 'function') {
    const tsx = resolveTsxApi(deps.apiDir);
    if (!tsx.ok) throw new Error(tsx.reason);
    const api = await import(tsx.url);
    tsImport = api.tsImport;
  }
  if (typeof tsImport !== 'function') throw new Error('tsx API is unavailable');
  const runtimeModule = await tsImport(runtimeUrl, import.meta.url);
  if (!runtimeModule || typeof runtimeModule.createLocalTestRuntime !== 'function') throw new Error('runtime factory is unavailable');
  return runtimeModule.createLocalTestRuntime(input);
}

const DEFAULT_DEPS = Object.freeze({
  env: process.env,
  apiDir: API_DIR,
  execPath: process.execPath,
  // The OS account's home (passwd entry), never $HOME: the checkpoint store must be one
  // per account, so an environment change cannot point a run at a different store.
  home: os.userInfo().homedir,
  tmpdir: os.tmpdir(),
  resolvePrismaCli,
  verifyMigrationPayload,
  hashFile: hashRegularFile,
  hashBinary: hashRegularFile,
  loadRuntime: loadLocalTestRuntime,
  listArchive: listBackupArchive,
  pgRestore: PG_RESTORE_PATH,
  spawn,
  childTimeoutMs: CHILD_TIMEOUT_MS,
  now: () => new Date(),
  repoRoot: path.resolve(API_DIR, '..'),
  forbiddenRoots: [...DEFAULT_FORBIDDEN_ROOTS, os.tmpdir()],
  uid: typeof process.getuid === 'function' ? process.getuid() : -1,
  log: (line) => console.log(line),
  error: (line) => console.error(line),
});
export const DEFAULT_PREPARE_DEPS = DEFAULT_DEPS;

const storePolicy = (deps) => ({ uid: deps.uid, repoRoot: deps.repoRoot, forbiddenRoots: deps.forbiddenRoots });

// Static gates shared by every mode. Reads only repository files (and, for the
// resume, the backup run directory and the checkpoint store); no runtime, no
// database. The only process: the resume's contained pg_restore --list (archive only).
export async function staticGates(parsed, deps) {
  const target = readPrepareEnvironment(deps.env);
  if (!target.ok) return { ok: false, phase: 'config', detail: target.reason };
  if (target.markerId !== parsed.markerId) {
    return { ok: false, phase: 'config', detail: `--marker-id does not match ${MARKER_VAR} (values not shown)` };
  }
  const prisma = deps.resolvePrismaCli(deps.apiDir);
  if (!prisma.ok) return { ok: false, phase: 'prisma', detail: prisma.reason };
  const config = deps.hashFile(path.join(prisma.cwd, PRISMA_CONFIG));
  if (!config.ok) return { ok: false, phase: 'prisma', detail: `api/${PRISMA_CONFIG} ${config.reason}` };
  const payload = deps.verifyMigrationPayload(deps.apiDir);
  if (!payload.ok) return { ok: false, phase: 'payload', detail: `${payload.reason}; nothing was started` };
  const company = deps.hashFile(path.join(prisma.cwd, COMPANY_DESCRIPTOR));
  if (!company.ok) return { ok: false, phase: 'company', detail: `api/${COMPANY_DESCRIPTOR} ${company.reason}` };
  const self = deps.hashFile(path.join(deps.repoRoot, PREPARE_TOOL));
  if (!self.ok) return { ok: false, phase: 'prepare', detail: `${PREPARE_TOOL} ${self.reason}; nothing was started` };
  const action = parsed.action ?? PREPARE_ACTIONS.CHECKPOINT;
  let backup = null;
  if (action === PREPARE_ACTIONS.RESUME) {
    const tool = deps.hashFile(path.join(deps.repoRoot, BACKUP_TOOL));
    if (!tool.ok) return { ok: false, phase: 'backup-evidence', detail: `${BACKUP_TOOL} ${tool.reason}; nothing was started` };
    const evidence = await verifyResumeEvidence(parsed.backupEvidence, { markerId: parsed.markerId, payload, backupToolSha256: tool.sha256 }, deps);
    if (!evidence.ok) return { ok: false, phase: 'backup-evidence', detail: `${evidence.reason}; nothing was started` };
    backup = Object.freeze({
      path: parsed.backupEvidence,
      run: evidence.run,
      dumpSha256: evidence.dump.sha256,
      dumpBytes: evidence.dump.bytes,
      manifestSha256: evidence.manifestSha256,
      toolSha256: tool.sha256,
      checkpointId: evidence.checkpoint.id,
      checkpointSha256: evidence.checkpoint.recordSha256,
      tocSha256: evidence.tocSha256,
      pgRestoreSha256: evidence.pgRestoreSha256,
      toc: evidence.toc,
      ageSeconds: evidence.ageSeconds,
      createdAt: evidence.createdAt,
      tocMultisetSha256: evidence.tocMultisetSha256,
      fPre: evidence.fPre,
      preWitnessSha256: evidence.preWitnessSha256,
    });
  }
  const plan = buildPreparePlan({
    markerId: parsed.markerId,
    prisma,
    apiDir: prisma.cwd,
    configSha256: config.sha256,
    companySha256: company.sha256,
    payload,
    action,
    backup,
    prepareSha256: self.sha256,
  });
  const spec = buildPrismaMigrationSpec({ execPath: deps.execPath, prisma });
  return { ok: true, target, prisma, config, payload, company, self, backup, plan, digest: digestPreparePlan(plan), spec, action };
}

// The bound backup fields that must be identical when re-verified before seed #2.
const sameBackup = (a, b) => a.run === b.run && a.dump.sha256 === b.dumpSha256 && a.dump.bytes === b.dumpBytes
  && a.manifestSha256 === b.manifestSha256 && a.checkpoint.id === b.checkpointId && a.checkpoint.recordSha256 === b.checkpointSha256
  && a.tocSha256 === b.tocSha256 && a.pgRestoreSha256 === b.pgRestoreSha256
  && a.fPre === b.fPre && a.preWitnessSha256 === b.preWitnessSha256 && a.tocMultisetSha256 === b.tocMultisetSha256;

const executeFlag = (s) => (s.backup ? ` --resume-from=${RESUME_FROM_VALUE} --backup-evidence=<the run directory of backup ${s.backup.run}> --authorization=<authId printed by local-test-authorize-resume.mjs for this plan>` : '');

function dryRunLines(s) {
  const banner = s.backup
    ? `${PREFIX} DRY RUN — no database connection was opened and no runtime was loaded; the only process started was the contained pg_restore --list of the backup archive (archive only, no connection); nothing was changed`
    : `${PREFIX} DRY RUN — no database connection was opened, no runtime was loaded and nothing was executed`;
  return [
    banner,
    `  target: LOCAL_TEST ${CONFIRM_LOCAL_TARGET} (${URL_VAR} accepted; value not shown)`,
    `  marker id: ${s.target.markerId} (equals ${MARKER_VAR}; proven against the database only by --check/--execute)`,
    `  Prisma CLI: repository-local prisma ${s.prisma.version}, run with this Node binary, cwd api/`,
    `  command: prisma ${PRISMA_MIGRATE_ARGS.join(' ')}   (argv only, no shell, never --schema; contained: own PID namespace and process group)`,
    `  config: api/${PRISMA_CONFIG} sha256 ${s.config.sha256}`,
    `  migration payload: PASS — exactly ${s.payload.migrations.length} approved migrations (pins: pilot-migrate.mjs)`,
    ...s.payload.migrations.map((m, i) => `    ${i + 1}. ${m.name}  sha256 ${m.sha256}`),
    `  migration_lock.toml: PASS (provider "${s.payload.lock.provider}", sha256 ${s.payload.lock.sha256})`,
    `  TEST Company descriptor: api/${COMPANY_DESCRIPTOR} sha256 ${s.company.sha256}`,
    `  prepare source: ${PREPARE_TOOL} sha256 ${s.self.sha256}`,
    `  child environment keys: ${CHILD_ENV_KEYS.join(', ')}`,
    `  checkpoint store: ${CHECKPOINT_STORE_LABEL} (owner-only 0700, outside the repository and temporary storage)`,
    ...(s.backup
      ? [
        `  backup evidence: run ${s.backup.run} dump sha256 ${s.backup.dumpSha256} bytes ${s.backup.dumpBytes} manifest sha256 ${s.backup.manifestSha256}`,
        `  PRE witness (digest only): fPre ${s.backup.fPre} (witness sha256 ${s.backup.preWitnessSha256}; TOC multiset sha256 ${s.backup.tocMultisetSha256})`,
        `  backup verified: files + self-hashed manifest; age ${s.backup.ageSeconds}s (max ${MAX_BACKUP_AGE_MS / 1000}s); bound to the current checkpoint ${s.backup.checkpointId} (record sha256 ${s.backup.checkpointSha256}); pg_restore --list PASS (${s.backup.toc.entries} entries, ${s.backup.toc.tables} tables with TABLE DATA, TOC sha256 ${s.backup.tocSha256} = manifest; pg_restore sha256 ${s.backup.pgRestoreSha256})`,
      ]
      : []),
    `  action: ${s.action} — ${ACTION_SUMMARY[s.action]}`,
    `  phases: ${ACTION_PHASES[s.action].join(' → ')}`,
    '  never: marker install/repair, database/role/user provisioning, migrate dev/reset, db push',
    `  plan digest: ${s.digest}`,
    `  --execute requires --confirm-local-target=${CONFIRM_LOCAL_TARGET} --plan=${s.digest}${executeFlag(s)}`,
  ];
}

// A runtime method signals failure by throwing; an explicit `false` result is
// treated as a failure too, never as success.
async function must(result) {
  if ((await result) === false) throw new Error('runtime step reported failure');
}
const stateLabel = (state) => (PREPARE_STATES.includes(state) ? state : 'UNRECOGNIZED');

export async function main(argv, overrides = {}) {
  const merged = { ...DEFAULT_DEPS, ...overrides };
  // One snapshot: every target, config and child decision below reads this
  // frozen copy, never the live (mutable) environment object.
  const deps = Object.freeze({ ...merged, env: Object.freeze({ ...merged.env }) });
  const fail = (phase, detail) => {
    deps.error(`${PREFIX} FAIL: phase=${phase} — ${detail}`);
    return 1;
  };

  const parsed = parsePrepareArgs(argv);
  if (!parsed.ok) return fail('args', parsed.error);
  if (parsed.mode === 'check-outcome' || parsed.mode === 'reconcile-completion') return outcomeFlow(parsed, deps, fail);

  const s = await staticGates(parsed, deps);
  if (!s.ok) return fail(s.phase, s.detail);

  if (parsed.mode === 'dry-run') {
    for (const line of dryRunLines(s)) deps.log(line);
    return 0;
  }

  // The reviewed plan must match exactly what would run, before anything loads.
  if (parsed.mode === 'execute' && parsed.plan !== s.digest) {
    return fail('plan', '--plan does not match the plan computed now; review a fresh --dry-run (values not shown)');
  }

  let runtime;
  try {
    const approvedMigrations = Object.freeze(
      s.payload.migrations.map(({ name, sha256 }) => Object.freeze({ name, sha256 })),
    );
    runtime = await deps.loadRuntime(
      Object.freeze({ databaseUrl: s.target.url, markerId: parsed.markerId, approvedMigrations }),
      Object.freeze({ ...deps, apiDir: s.prisma.cwd }),
    );
  } catch {
    return fail('runtime', 'LOCAL_TEST baseline runtime could not be loaded; nothing was started');
  }
  let code;
  try {
    // Runtime evaluation imports the Company descriptor; re-bind the reviewed
    // bytes before any identity proof, classification, mutation or verification.
    const company = deps.hashFile(path.join(s.prisma.cwd, COMPANY_DESCRIPTOR));
    if (!company.ok || company.sha256 !== s.company.sha256) {
      code = fail('company', `api/${COMPANY_DESCRIPTOR} changed after the runtime was loaded; nothing was started`);
    } else {
      code = await (parsed.mode === 'check' ? checkWith(runtime, fail, deps) : executeWith(runtime, s, fail, deps, parsed));
    }
  } catch {
    code = fail('company', `api/${COMPANY_DESCRIPTOR} could not be rechecked after the runtime was loaded; nothing was started`);
  }
  let closed = true;
  try {
    await runtime.close();
  } catch {
    closed = false;
  }
  // A close failure never turns a failure into success nor hides the original
  // failure; after a success it is reported as its own failure.
  if (!closed && code === 0) return fail('close', 'LOCAL_TEST baseline runtime could not be closed cleanly');
  return code;
}

async function checkWith(runtime, fail, deps) {
  let phase = 'identity';
  try {
    await must(runtime.proveIdentity());
    phase = 'classify';
    const state = await runtime.classify();
    if (state === CHECKPOINT_STATE) {
      return fail('check', `state ${state}: LOCAL_TEST is not prepared; seed #2 requires a verified backup of the current checkpoint and --execute --resume-from=${RESUME_FROM_VALUE} --backup-evidence=<run directory>`);
    }
    if (state !== 'EXACT_BASELINE') {
      const decision = decidePrepareAction(state);
      if (!decision.ok) return fail('classify', `state ${stateLabel(state)}: ${decision.reason}`);
      return fail('check', `state ${state}: LOCAL_TEST is not prepared; --execute would run ${decision.phases.join(' → ')} and stop at ${CHECKPOINT_STATE}`);
    }
    phase = PHASE.VERIFY;
    await must(runtime.verifyBaseline());
    deps.log(`${PREFIX} CHECK OK — state EXACT_BASELINE, strict verification passed; nothing was changed`);
    return 0;
  } catch {
    return fail(phase, 'LOCAL_TEST check step failed (details not shown); nothing was changed');
  }
}

// ---- R4: the protected resume, the read-only outcome verifier and the completion reconciliation ----------------------------

const sha256Of = (text) => createHash('sha256').update(text).digest('hex');
const safeKind = (error) => {
  try {
    return error?.kind === 'ROLLED_BACK' || error?.kind === 'COMMIT_UNKNOWN' ? error.kind : null;
  } catch {
    return null;
  }
};
const safeStage = (error) => {
  try {
    return typeof error?.stage === 'string' && /^[a-z-]{1,20}$/.test(error.stage) ? error.stage : 'unknown';
  } catch {
    return 'unknown';
  }
};

// The OWNER authorization bound to THIS resume: a valid, unexpired, unconsumed record whose every bound field equals the
// verified evidence and the plan computed now. Returns fixed reasons only.
async function loadBoundAuthorization(authId, s, deps) {
  const dir = authorizationStorePath(deps.home);
  const read = await readAuthorizationRecord({ dir, authId, fs: realWitnessFs, now: deps.now() });
  if (!read.ok) return { ok: false, reason: `authorization refused (${read.reason})` };
  const r = read.record;
  const b = s.backup;
  const bound = r.target === CONFIRM_LOCAL_TARGET && r.markerIdSha256 === sha256Hex(s.target.markerId) && r.backupRun === b.run && r.dumpSha256 === b.dumpSha256
    && r.manifestSha256 === b.manifestSha256 && r.fPre === b.fPre && r.preWitnessSha256 === b.preWitnessSha256 && r.checkpointId === b.checkpointId
    && r.checkpointRecordSha256 === b.checkpointSha256 && r.planDigest === s.digest;
  if (!bound) return { ok: false, reason: 'authorization is bound to another backup, plan or state' };
  return { ok: true, dir, text: read.text, record: r, authorizationRecordSha256: sha256Of(read.text) };
}

// Seed #2 inside ONE protected transaction (runtime.resumeSeed2). Every file-side action the transaction needs is a callback
// built here: re-verification of the files, the single-use consumption, and the durable POST witness. No spawn, no mkdir and no
// network happen inside the transaction.
async function resumeWith(runtime, s, parsed, fail, deps) {
  const policy = storePolicy(deps);
  let phase = 'identity';
  let consumed = false;
  let witnessSha = null;
  let fPostSeen = null;
  try {
    await must(runtime.proveIdentity());
    phase = 'classify';
    const state = await runtime.classify();
    const decision = decidePrepareAction(state, s.action);
    if (!decision.ok) return fail('classify', `state ${stateLabel(state)}: ${decision.reason}`);

    phase = 'authorization';
    const auth = await loadBoundAuthorization(parsed.authorization, s, deps);
    if (!auth.ok) return fail('authorization', `${auth.reason}; seed #2 was NOT run`);

    phase = 'witness-dir';
    const wdir = await ensureWitnessDir({ root: witnessRootPath(deps.home), run: s.backup.run, fs: realWitnessFs });
    if (!wdir.ok) return fail('witness-dir', 'the witness directory could not be prepared (owner-only, durable); seed #2 was NOT run');

    // the full re-verification (including the contained, archive-only pg_restore --list) happens HERE, outside the transaction
    phase = 'backup-evidence';
    const tool = deps.hashFile(path.join(deps.repoRoot, BACKUP_TOOL));
    const again = tool.ok && tool.sha256 === s.backup.toolSha256
      ? await verifyResumeEvidence(s.backup.path, { markerId: s.target.markerId, payload: s.payload, backupToolSha256: s.backup.toolSha256 }, deps)
      : { ok: false };
    if (!again.ok || !sameBackup(again, s.backup)) {
      return fail('backup-evidence', 'the verified backup or its checkpoint changed, expired or disappeared after the plan check; seed #2 was NOT run');
    }

    phase = 'resume';
    const request = {
      expectedFPre: s.backup.fPre,
      // in-transaction file checks are FILE-LEVEL only (no process): backup files, checkpoint and authorization unchanged
      checkPreconditions: async () => {
        const files = readBackupRun(s.backup.path, deps.uid);
        if (!files.ok || files.manifestSha256 !== s.backup.manifestSha256 || files.dump.sha256 !== s.backup.dumpSha256) throw new Error('backup files changed');
        if (!(deps.now().getTime() - Date.parse(files.manifest.createdAt) <= MAX_BACKUP_AGE_MS)) throw new Error('backup expired');
        const cp = readCurrentCheckpoint(deps.home, policy, s.target.markerId, s.payload);
        if (!cp.ok || cp.record.id !== s.backup.checkpointId || cp.recordSha256 !== s.backup.checkpointSha256) throw new Error('checkpoint changed');
        const recheck = await readAuthorizationRecord({ dir: auth.dir, authId: parsed.authorization, fs: realWitnessFs, now: deps.now() });
        if (!recheck.ok || recheck.text !== auth.text) throw new Error('authorization changed');
      },
      // T11: the single use, durable, immediately before the first seed write
      consumeAuthorization: async () => {
        const marker = buildConsumedMarker({ authId: parsed.authorization, planDigest: s.digest, fPre: s.backup.fPre, backupRun: s.backup.run, at: deps.now().toISOString() });
        const r = await consumeAuthorizationMarker({ dir: auth.dir, authId: parsed.authorization, text: marker, fs: realWitnessFs });
        if (!r.durable) throw new Error('authorization could not be consumed');
        consumed = true;
      },
      // T14b: the digest-only POST witness, durable BEFORE COMMIT. The receipt echoes the transaction nonce and fPost.
      persistPostWitness: async (req) => {
        if (req.markerId !== s.target.markerId || req.fPre !== s.backup.fPre) throw new Error('witness binding mismatch');
        const text = buildWitness('POST', {
          markerIdSha256: sha256Hex(req.markerId),
          serverVersionNum: req.serverVersionNum,
          backupRun: s.backup.run,
          manifestSha256: s.backup.manifestSha256,
          dumpSha256: s.backup.dumpSha256,
          preWitnessSha256: s.backup.preWitnessSha256,
          fPre: s.backup.fPre,
          fPost: req.fPost,
          authId: parsed.authorization,
          authorizationRecordSha256: auth.authorizationRecordSha256,
          planDigest: s.digest,
          protectedDomainContractSha256: req.protectedDomainContractSha256,
          transformationContractSha256: req.transformationContractSha256,
          createdAt: deps.now().toISOString(),
        });
        const durable = await persistWitnessDurably({ dir: wdir.dir, authId: parsed.authorization, text, fs: realWitnessFs });
        if (!durable.durable) return { durable: false };
        witnessSha = durable.witnessSha256;
        fPostSeen = req.fPost;
        return { durable: true, nonce: req.nonce, fPost: req.fPost };
      },
    };
    let result;
    try {
      result = await runtime.resumeSeed2(request);
    } catch (error) {
      const kind = safeKind(error);
      if (kind === 'COMMIT_UNKNOWN') {
        return fail('commit', 'the COMMIT outcome is UNKNOWN; nothing was recorded and NO retry is attempted: run --check-outcome with this backup evidence (read-only)');
      }
      if (kind === 'ROLLED_BACK') {
        const authorization = consumed ? 'the authorization is consumed (issue a fresh one)' : 'the authorization was not consumed';
        return fail('resume', `the protected transaction was rolled back at stage ${safeStage(error)}; nothing was committed; ${authorization}; the checkpoint stays current`);
      }
      return fail('resume', 'the protected resume failed (details not shown); nothing is known to be committed: run --check-outcome with this backup evidence (read-only)');
    }

    // COMMIT acknowledged. Only now the checkpoint is consumed and completed (R3 ordering), naming the exact states and witness.
    phase = 'checkpoint';
    const store = checkpointStorePath(fsRealpathSync(deps.home));
    const when = { now: deps.now(), plan: s.digest, run: s.backup.run };
    const evidence = { fPre: s.backup.fPre, fPost: result.fPost ?? fPostSeen, authId: parsed.authorization, witnessSha256: witnessSha };
    if (!consumeCheckpoint(store, s.backup.checkpointId, when).ok || !completeCheckpoint(store, s.backup.checkpointId, { ...when, evidence }).ok) {
      return fail('checkpoint', 'seed #2 COMMITTED (acknowledged) but the checkpoint records could not be written: run --reconcile-completion with this backup evidence; do NOT run the seed again');
    }
    deps.log(`${PREFIX} RESUME OK — from POST_BACKFILL with verified backup ${s.backup.run} (dump sha256 ${s.backup.dumpSha256}, checkpoint ${s.backup.checkpointId} consumed after COMMIT, authorization ${parsed.authorization} consumed): seed #2 committed in one protected transaction; the verified post-state is witnessed (digest only)`);
    return 0;
  } catch {
    return fail(phase, 'LOCAL_TEST resume step failed (details not shown); seed #2 is not known to have run');
  }
}

// --check-outcome and --reconcile-completion: file-side evidence + ONE read-only database transaction (runtime.checkOutcome).
// Never a seed, never a restore, never an authorization. PRE evidence is the backup run; POST evidence is the digest-only
// witnesses of that run bound to consumed authorizations.
async function outcomeFlow(parsed, deps, fail) {
  const target = readPrepareEnvironment(deps.env);
  if (!target.ok) return fail('config', target.reason);
  if (target.markerId !== parsed.markerId) return fail('config', `--marker-id does not match ${MARKER_VAR} (values not shown)`);
  const prisma = deps.resolvePrismaCli(deps.apiDir);
  if (!prisma.ok) return fail('prisma', prisma.reason);
  const payload = deps.verifyMigrationPayload(deps.apiDir);
  if (!payload.ok) return fail('payload', `${payload.reason}; nothing was started`);
  const tool = deps.hashFile(path.join(deps.repoRoot, BACKUP_TOOL));
  if (!tool.ok) return fail('backup-evidence', `${BACKUP_TOOL} ${tool.reason}; nothing was started`);
  const policy = storePolicy(deps);
  const pre = verifyBackupEvidence(parsed.backupEvidence, { ...policy, markerId: parsed.markerId, payload, backupToolSha256: tool.sha256 });
  const report = (state, extra = {}) => {
    const parts = [`state=${state}`, ...Object.entries(extra).map(([k, v]) => `${k}=${v}`)];
    deps.log(`${PREFIX} OUTCOME ${parts.join(' ')}`);
  };
  if (!pre.ok) {
    report('PARTIAL_OR_UNKNOWN', { reason: 'PRE_EVIDENCE_INVALID' });
    deps.log(`${PREFIX} next=${nextAction({ state: 'PARTIAL_OR_UNKNOWN' }, false)}`);
    return 1;
  }
  const run = pre.run;
  const authDir = authorizationStorePath(deps.home);
  // consumed authorizations and their record texts (content binding, LOW-5); a missing store simply has none
  const consumedAuthIds = [];
  const authRecords = {};
  try {
    for (const name of await realWitnessFs.readdir(authDir)) {
      const m = /^([0-9a-f]{32})\.consumed\.json$/.exec(name);
      if (!m) continue;
      consumedAuthIds.push(m[1]);
      const rec = await readWitnessFile(path.join(authDir, `${m[1]}.json`), realWitnessFs);
      if (rec.ok) authRecords[m[1]] = rec.text;
    }
  } catch { /* no store: nothing consumed */ }
  if (parsed.authorization !== null && !consumedAuthIds.includes(parsed.authorization)) {
    let known = false;
    try { known = (await realWitnessFs.lstat(path.join(authDir, `${parsed.authorization}.json`))).isFile(); } catch { known = false; }
    if (!known) return fail('authorization', 'the authorization id matches no record or consumed marker; nothing was read');
  }
  let witnesses = [];
  try {
    witnesses = (await listWitnessFiles(path.join(witnessRootPath(deps.home), run), realWitnessFs)).filter((w) => w.ok).map((w) => ({ authId: w.authId, text: w.text }));
  } catch { /* no witness directory: no POST evidence */ }

  let runtime;
  try {
    runtime = await deps.loadRuntime(
      Object.freeze({ databaseUrl: target.url, markerId: parsed.markerId, approvedMigrations: Object.freeze(payload.migrations.map(({ name, sha256 }) => Object.freeze({ name, sha256 }))) }),
      Object.freeze({ ...deps, apiDir: prisma.cwd }),
    );
  } catch {
    return fail('runtime', 'LOCAL_TEST runtime could not be loaded; nothing was started');
  }
  let digests;
  let code = 1;
  try {
    await must(runtime.proveIdentity());
    digests = await runtime.checkOutcome();
  } catch (error) {
    const timeout = (() => { try { return error?.reason === 'TIMEOUT'; } catch { return false; } })();
    code = fail('outcome', `${timeout ? 'the read-only verification timed out (lock or statement timeout); ' : ''}the read-only verification failed (details not shown); nothing was changed and nothing is retried`);
    digests = null;
  }
  let closed = true;
  try { await runtime.close(); } catch { closed = false; }
  if (!digests) return code;
  void closed;

  const ctx = {
    run,
    manifestSha256: pre.manifestSha256,
    dumpSha256: pre.dump.sha256,
    preWitnessSha256: pre.preWitness.sha256,
    fPre: pre.preWitness.obj.fPre,
    markerIdSha256: sha256Hex(parsed.markerId),
    serverVersionNum: digests.serverVersionNum,
    domainSha256: digests.protectedDomainContractSha256,
    acceptedTransformationContracts: [...digests.acceptedTransformationContractSha256s],
    consumedAuthIds,
    authRecords,
  };
  const outcome = classifyOutcome({ pre: { valid: true, fPre: ctx.fPre }, ctx, witnesses, current: { pre: digests.pre, post: digests.post } });
  const consumedFlag = parsed.authorization !== null && consumedAuthIds.includes(parsed.authorization);
  const extra = {};
  if (outcome.authId) extra.authId = outcome.authId;
  if (outcome.reason) extra.reason = outcome.reason;
  if (outcome.inventory) extra.witnesses = `${outcome.inventory.valid}valid/${outcome.inventory.invalid}invalid`;
  report(outcome.state, extra);
  deps.log(`${PREFIX} next=${nextAction(outcome, consumedFlag)}`);
  if (outcome.state === 'PARTIAL_OR_UNKNOWN') return 1;
  if (parsed.mode === 'check-outcome') return 0;

  // --reconcile-completion: only after an exact POST_SEED_EXACT, only file-side facts the database itself proves; idempotent.
  if (outcome.state !== 'POST_SEED_EXACT') return fail('reconcile', `the state is ${outcome.state}; no completion is recorded (nothing was written)`);
  const store = readCheckpointStore(deps.home, policy);
  if (!store.ok) return fail('checkpoint', `${store.reason}; nothing was written`);
  const id = pre.manifest.checkpoint.id;
  const consumedFile = path.join(store.store, `${id}.consumed.json`);
  const completedFile = path.join(store.store, `${id}.completed.json`);
  const readMarker = (file) => {
    const r = readOwnerFile(file, deps.uid);
    if (!r.ok) return null;
    try { return JSON.parse(r.text); } catch { return undefined; }
  };
  const consumedMarker = readMarker(consumedFile);
  const completedMarker = readMarker(completedFile);
  const when = { now: deps.now(), plan: pre.manifest.plan, run };
  const witnessSha = (witnesses.find((w) => w.authId === outcome.authId)?.text ?? '');
  const evidence = { fPre: ctx.fPre, fPost: (() => { try { return JSON.parse(witnessSha).fPost; } catch { return null; } })(), authId: outcome.authId, witnessSha256: sha256Of(witnessSha) };
  if (completedMarker !== null) {
    // agree ⇒ no-op success; disagree ⇒ refuse
    const agrees = completedMarker && completedMarker.run === run && completedMarker.authId === evidence.authId && completedMarker.fPost === evidence.fPost && completedMarker.witnessSha256 === evidence.witnessSha256;
    if (!agrees) return fail('reconcile', 'existing completion records disagree with the verified outcome; nothing was written');
    deps.log(`${PREFIX} RECONCILE OK — completion already recorded and consistent; nothing was written`);
    return 0;
  }
  if (consumedMarker === undefined || (consumedMarker !== null && (consumedMarker.run !== run || consumedMarker.reason !== 'resume-committed'))) {
    return fail('reconcile', 'the checkpoint consumption record does not agree with the verified outcome; nothing was written');
  }
  if (consumedMarker === null && !consumeCheckpoint(store.store, id, when).ok) return fail('checkpoint', 'the checkpoint consumption could not be recorded');
  if (!completeCheckpoint(store.store, id, { ...when, evidence }).ok) return fail('checkpoint', 'the completion could not be recorded (re-run --reconcile-completion; it is idempotent)');
  deps.log(`${PREFIX} RECONCILE OK — checkpoint ${id} recorded consumed and completed for authorization ${outcome.authId}; no database state was changed`);
  return 0;
}

// Drives the action's transition table from the live state: every step is looked
// up from a freshly proven classification, every mutation follows a fresh proof,
// and every result must classify as exactly the step's `next` state. The checkpoint
// table has no transition out of POST_BACKFILL, so no generic run can reach seed #2.
// Checkpoint lifecycle: the generic run supersedes every current checkpoint before
// its first mutation and records a new one at POST_BACKFILL; the resume consumes the
// bound checkpoint (O_EXCL) immediately before seed #2 — a failure before that point
// leaves it current, anything from that point on (failure, crash) leaves it consumed.
async function executeWith(runtime, s, fail, deps, parsed) {
  if (s.action === PREPARE_ACTIONS.RESUME) return resumeWith(runtime, s, parsed, fail, deps);
  const redact = createRedactor(s.target.url);
  const { steps, end } = ACTION_STEPS[s.action];
  const policy = storePolicy(deps);
  let phase = 'identity';
  try {
    await must(runtime.proveIdentity());
    phase = 'classify';
    let state = await runtime.classify();
    const decision = decidePrepareAction(state, s.action);
    if (!decision.ok) return fail('classify', `state ${stateLabel(state)}: ${decision.reason}`);

    if (s.action === PREPARE_ACTIONS.CHECKPOINT) {
      phase = 'checkpoint';
      const superseded = supersedeCheckpoints(deps.home, policy, { now: deps.now(), plan: s.digest });
      if (!superseded.ok) return fail('checkpoint', `${superseded.reason}; no mutation was run`);
    }

    while (state !== end) {
      const step = typeof state === 'string' && Object.hasOwn(steps, state) ? steps[state] : null;
      if (!step) return fail('classify', `state ${stateLabel(state)} has no reviewed transition; no later phase was run`);
      phase = step.phase;
      if (step.phase === PHASE.MIGRATE) {
        // Immediately before the child: the approved payload and the planned
        // LOCAL config must still be exactly what the plan bound.
        const payload = deps.verifyMigrationPayload(deps.apiDir);
        if (!payload.ok) return fail('payload', `${payload.reason}; changed after the plan check — prisma was NOT started`);
        const config = deps.hashFile(path.join(s.prisma.cwd, PRISMA_CONFIG));
        if (!config.ok || config.sha256 !== s.config.sha256) {
          return fail('config', `api/${PRISMA_CONFIG} changed after the plan check — prisma was NOT started`);
        }
        const env = buildPrismaChildEnv(s.target.url, deps);
        const result = await runChild(deps, s.spec, env, redact);
        if (!result.ok) {
          const applied = result.started === false ? 'nothing was applied' : 'migrations may be partially applied';
          return fail('prisma', `${result.detail}; ${applied}; no later phase was run`);
        }
      } else {
        await must(runtime.proveIdentity());
        if (step.phase === PHASE.SEED) {
          if (s.action === PREPARE_ACTIONS.RESUME) {
            // Seed #2: the backup the plan bound must still be exactly there and
            // valid now (files, age, current checkpoint, pg_restore --list) ...
            phase = 'backup-evidence';
            const tool = deps.hashFile(path.join(deps.repoRoot, BACKUP_TOOL));
            const again = tool.ok && tool.sha256 === s.backup.toolSha256
              ? await verifyResumeEvidence(s.backup.path, { markerId: s.target.markerId, payload: s.payload, backupToolSha256: s.backup.toolSha256 }, deps)
              : { ok: false };
            if (!again.ok || !sameBackup(again, s.backup)) {
              return fail('backup-evidence', 'the verified backup or its checkpoint changed, expired or disappeared after the plan check; seed #2 was NOT run');
            }
            // ... and its checkpoint is consumed before the first destructive write.
            phase = 'checkpoint';
            if (!consumeCheckpoint(again.store, again.checkpoint.id, { now: deps.now(), plan: s.digest, run: again.run }).ok) {
              return fail('checkpoint', 'the checkpoint could not be consumed (already consumed or the store changed); seed #2 was NOT run');
            }
            phase = step.phase;
          }
          await must(runtime.seedDemo());
        } else if (step.phase === PHASE.BACKFILL) {
          await must(runtime.backfillCompanyLocations());
        } else {
          return fail('plan', 'unknown phase; nothing further was run');
        }
      }
      // A step's success is not its postcondition: prove again, then the database
      // must be exactly the step's next state.
      phase = 'identity';
      await must(runtime.proveIdentity());
      phase = 'classify';
      const after = await runtime.classify();
      if (after !== step.next) {
        return fail('classify', `after ${step.phase} the state is ${stateLabel(after)}, not ${step.next}; no later phase was run`);
      }
      state = after;
    }
    if (s.action === PREPARE_ACTIONS.RESUME) {
      phase = PHASE.VERIFY;
      await must(runtime.verifyBaseline());
      phase = 'checkpoint';
      const store = checkpointStorePath(fsRealpathSync(deps.home));
      if (!completeCheckpoint(store, s.backup.checkpointId, { now: deps.now(), plan: s.digest, run: s.backup.run }).ok) {
        return fail('checkpoint', 'seed #2 ran and strict verification passed, but the completion record could not be written (the checkpoint stays consumed)');
      }
      deps.log(`${PREFIX} RESUME OK — from POST_BACKFILL with verified backup ${s.backup.run} (dump sha256 ${s.backup.dumpSha256}, checkpoint ${s.backup.checkpointId} consumed): seed #2 ran and strict verification passed; state EXACT_BASELINE`);
      return 0;
    }
    phase = 'checkpoint';
    const recorded = recordCheckpoint(deps.home, policy, {
      now: deps.now(), plan: s.digest, markerId: s.target.markerId, payload: s.payload, prepareSha256: s.self.sha256,
    });
    if (!recorded.ok) {
      return fail('checkpoint', `state POST_BACKFILL was reached but ${recorded.reason}; no backup can be bound to it (OWNER recovery: re-provision a FRESH LOCAL_TEST)`);
    }
    deps.log(`${PREFIX} ${checkpointOkLine(recorded.id)}`);
    return 0;
  } catch {
    return fail(phase, 'LOCAL_TEST step failed; no later phase was run (details not shown)');
  }
}

// Only run when executed directly; importing from a test never loads a runtime.
// The start guard (diagnostic flags that could capture protected rows) and the fixed-code top-level handler apply to the
// executable entry. `main` stays injectable: node --test itself passes inspector/report defaults in execArgv.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runTool(() => main(process.argv.slice(2)), { prefix: PREFIX });
}
