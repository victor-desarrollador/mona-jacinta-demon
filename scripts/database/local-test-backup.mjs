import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { closeSync, constants as fsConstants, linkSync, mkdirSync, openSync, readFileSync, rmdirSync, unlinkSync, writeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  BACKUP_DUMP_FILE,
  BACKUP_MANIFEST_FILE,
  BACKUP_MANIFEST_FORMAT,
  BACKUP_RUN_DIR,
  BACKUP_STATE,
  BACKUP_TOOL,
  CONFIRM_LOCAL_TARGET,
  DEFAULT_FORBIDDEN_ROOTS,
  PG_RESTORE_PATH,
  backupManifestSelfHash,
  canonicalBackupJson,
  checkBackupRoot,
  checkToc,
  hashRegularFile,
  inspectBackupArchive,
  loadLocalTestRuntime,
  readBackupRun,
  readCurrentCheckpoint,
  readPrepareEnvironment,
  restoreChildEnv,
  runContained,
} from './local-test-prepare.mjs';
import { API_DIR, verifyMigrationPayload } from './pilot-migrate.mjs';
import { runTool } from './local-test-safe-error.mjs';
import { buildWitness, preWitnessSha256 } from './local-test-witness.mjs';

// LOCAL_TEST backup at the prepare checkpoint (Block 1, V2.3; V2.3.2 checkpoint binding).
//
//   node scripts/database/local-test-backup.mjs --dry-run --marker-id=<uuid> --output-root=<dir>
//   node scripts/database/local-test-backup.mjs --execute --marker-id=<uuid> --output-root=<dir> \
//     --confirm-local-target=mona_local_test@127.0.0.1:5432/mona_local_test --plan=<sha256>
//   node scripts/database/local-test-backup.mjs --verify=<run directory>
//
// The only target is the disposable LOCAL_TEST database (the exact canonical
// LOCAL_TEST_DATABASE_URL + pinned marker id, the same rules as local-test-prepare).
// --execute proves identity through the reviewed LOCAL_TEST runtime and requires the
// read-only classifier to report exactly POST_BACKFILL before AND after the dump, so
// the archive holds exactly the rows seed #2 will delete/transform. The archive is a
// custom-format, public-schema-only pg_dump (one connection, one consistent
// snapshot); the password reaches pg_dump only through its environment, never argv.
// A run is finalized only after: regular non-empty 0600 file, sha256, a clean
// `pg_restore --list` (no database connection: archive only), identity + state
// re-proven, unchanged re-hash and a self-hashed manifest. --dry-run and --verify
// never open a database connection. Nothing here restores, repairs or deletes rows.
//
// V2.3.1/V2.3.2: the finalized run directory is the evidence `local-test-prepare.mjs
// --resume-from=POST_BACKFILL --backup-evidence=<run directory>` requires before seed
// #2. A backup is taken only of the CURRENT prepare checkpoint (the unique unconsumed
// record in ~/.local/state/mona-jacinta/local-test-checkpoints, written by the generic
// prepare --execute): the plan binds it, it is re-read before the dump and before the
// manifest, and the manifest (format v3) records it. The run-directory/manifest/
// archive and TOC rules live in local-test-prepare.mjs and are shared by --verify and
// the prepare resume, which re-lists the archive itself. Every child runs contained
// (own PID namespace and process group, see runContained).

export const PREFIX = '[db:local-test-backup]';
export const PLAN_DOMAIN = 'mona-jacinta-local-test-backup-plan-v3';
export const MANIFEST_FORMAT = BACKUP_MANIFEST_FORMAT;
export const REQUIRED_STATE = BACKUP_STATE;
export const PG_DUMP_PATH = '/usr/lib/postgresql/17/bin/pg_dump';
export const DUMP_FILE = BACKUP_DUMP_FILE;
export const MANIFEST_FILE = BACKUP_MANIFEST_FILE;
export const TMP_SUFFIX = '.tmp';
export const CHILD_TIMEOUT_MS = 10 * 60 * 1000;
// R4: the dump imports the exporter's snapshot (--snapshot=<id>, appended per run: the id is never stored), waits at most 10 s
// for locks, and refuses a -n/-t pattern that matches nothing (--strict-names).
export const PG_DUMP_ARGS = Object.freeze([
  '--format=custom',
  '--no-owner',
  '--no-acl',
  '--schema=public',
  '--strict-names',
  '--lock-wait-timeout=10000',
  '--no-password',
  '--host=127.0.0.1',
  '--port=5432',
  '--username=mona_local_test',
  '--dbname=mona_local_test',
]);
export const PG_CHILD_ENV_KEYS = Object.freeze(['HOME', 'LC_ALL', 'PATH', 'PGAPPNAME', 'PGCONNECT_TIMEOUT', 'PGPASSFILE', 'PGPASSWORD', 'PGSYSCONFDIR', 'TZ']);
export { DEFAULT_FORBIDDEN_ROOTS, PG_RESTORE_PATH, checkToc };
export { checkBackupRoot as checkOutputRoot, inspectBackupArchive as inspectArchive, backupManifestSelfHash as manifestSelfHash };
const GUARD_SCHEMA = 'mona_local_test_guard';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PLAN_DIGEST = /^[0-9a-f]{64}$/;
const MODES = ['dry-run', 'execute'];
const VALUE_ARGS = ['marker-id', 'output-root', 'confirm-local-target', 'plan', 'verify'];
const RUN_DIR = BACKUP_RUN_DIR;
const SELF = fileURLToPath(import.meta.url);

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const canonicalJson = canonicalBackupJson;

export function parseBackupArgs(argv) {
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
  if (values.verify !== undefined) {
    if (modes.length > 0 || Object.keys(values).length !== 1) return { ok: false, error: '--verify=<run directory> takes no other argument' };
    return { ok: true, mode: 'verify', runDir: values.verify };
  }
  if (modes.length !== 1) return { ok: false, error: 'Specify exactly one of --dry-run, --execute or --verify=<run directory>' };
  const [mode] = modes;
  if (values['marker-id'] === undefined || !UUID_V4.test(values['marker-id'])) {
    return { ok: false, error: '--marker-id must be a canonical lowercase version-4 UUID' };
  }
  if (values['output-root'] === undefined) return { ok: false, error: '--output-root=<absolute owner-only directory> is required' };
  const confirm = values['confirm-local-target'] ?? null;
  const plan = values.plan ?? null;
  if (mode === 'dry-run' && (confirm !== null || plan !== null)) {
    return { ok: false, error: '--confirm-local-target and --plan are accepted only with --execute' };
  }
  if (mode === 'execute' && confirm !== CONFIRM_LOCAL_TARGET) {
    return { ok: false, error: `--execute requires --confirm-local-target=${CONFIRM_LOCAL_TARGET} exactly` };
  }
  if (mode === 'execute' && (plan === null || !PLAN_DIGEST.test(plan))) {
    return { ok: false, error: '--execute requires --plan=<the exact 64-character lowercase sha256 printed by the reviewed --dry-run>' };
  }
  return { ok: true, mode, markerId: values['marker-id'], outputRoot: values['output-root'], confirm, plan };
}

export function buildBackupPlan({ markerId, outputRoot, pgDump, pgRestore, checkpoint }) {
  return [
    ['target', CONFIRM_LOCAL_TARGET],
    ['markerId', markerId],
    ['requiredState', REQUIRED_STATE, 'proven inside the exporter snapshot; schema stability proven after the dump'],
    ['checkpoint', checkpoint.id, checkpoint.recordSha256, 'current before the dump and before the manifest'],
    ['pgDump', pgDump.path, pgDump.sha256],
    ['pgRestore', pgRestore.path, pgRestore.sha256],
    ['argv', ...PG_DUMP_ARGS, '--snapshot=<exporter snapshot id>', '--file', `<run>/${DUMP_FILE}${TMP_SUFFIX}`],
    ['childEnv', ...PG_CHILD_ENV_KEYS],
    ['outputRoot', outputRoot],
    ['verify', 'regular 0600 non-empty', 'sha256', 'pg_restore --list strict grammar', 'stderr exactly empty', 'dbname', 'table data', `no ${GUARD_SCHEMA}`, 'toc multiset digest', 'rehash', 'manifest v4 with PRE witness'],
    ['never', 'restore', 'repair', 'row deletion', 'marker schema in archive'],
  ];
}
export const digestBackupPlan = (plan) => sha256(`${PLAN_DOMAIN}\n${JSON.stringify(plan)}\n`);

// Runs one child contained (local-test-prepare.mjs runContained): own PID namespace
// and process group, TERM then KILL on timeout, reaped; no descendant outlives it.
function runChild(deps, command, args, env, { onOut, onErr }) {
  return runContained(deps, { label: path.basename(command), command, args, options: { cwd: '/', stdio: ['ignore', 'pipe', 'pipe'] }, env }, { onOut, onErr });
}

export function buildPgDumpEnv(password, home) {
  return {
    HOME: home,
    LC_ALL: 'C',
    PATH: '/usr/bin:/bin',
    PGAPPNAME: 'mona-local-test-backup',
    PGCONNECT_TIMEOUT: '10',
    PGPASSFILE: '/dev/null',
    PGPASSWORD: password,
    PGSYSCONFDIR: '/nonexistent',
    TZ: 'UTC',
  };
}
const RESTORE_ENV = restoreChildEnv;

const DEFAULT_DEPS = Object.freeze({
  env: process.env,
  apiDir: API_DIR,
  repoRoot: path.resolve(API_DIR, '..'),
  forbiddenRoots: [...DEFAULT_FORBIDDEN_ROOTS, os.tmpdir()],
  // The OS account's home (passwd entry), never $HOME: the checkpoint store must be one
  // per account, so an environment change cannot point a run at a different store.
  home: os.userInfo().homedir,
  pgDump: PG_DUMP_PATH,
  pgRestore: PG_RESTORE_PATH,
  hashBinary: hashRegularFile,
  verifyMigrationPayload,
  loadRuntime: loadLocalTestRuntime,
  spawn,
  childTimeoutMs: CHILD_TIMEOUT_MS,
  now: () => new Date(),
  randomSuffix: () => randomBytes(4).toString('hex'),
  afterHash: undefined,
  log: (line) => console.log(line),
  error: (line) => console.error(line),
});

// The current prepare checkpoint for this marker and payload (files only).
function currentCheckpoint(markerId, payload, deps) {
  return readCurrentCheckpoint(deps.home, { uid: process.getuid(), repoRoot: deps.repoRoot, forbiddenRoots: deps.forbiddenRoots }, markerId, payload);
}
const sameCheckpoint = (current, bound) => current.ok && current.record.id === bound.id && current.recordSha256 === bound.recordSha256;

function staticGates(parsed, deps) {
  const target = readPrepareEnvironment(deps.env);
  if (!target.ok) return { ok: false, phase: 'config', detail: target.reason };
  if (target.markerId !== parsed.markerId) return { ok: false, phase: 'config', detail: '--marker-id does not match LOCAL_TEST_DATABASE_MARKER_ID (values not shown)' };
  const root = checkBackupRoot(parsed.outputRoot, { repoRoot: deps.repoRoot, forbiddenRoots: deps.forbiddenRoots, uid: process.getuid() });
  if (!root.ok) return { ok: false, phase: 'output-root', detail: root.reason };
  const pgDump = deps.hashBinary(deps.pgDump);
  if (!pgDump.ok) return { ok: false, phase: 'pg_dump', detail: `${deps.pgDump} ${pgDump.reason}` };
  const pgRestore = deps.hashBinary(deps.pgRestore);
  if (!pgRestore.ok) return { ok: false, phase: 'pg_restore', detail: `${deps.pgRestore} ${pgRestore.reason}` };
  const payload = deps.verifyMigrationPayload(deps.apiDir);
  if (!payload.ok) return { ok: false, phase: 'payload', detail: `${payload.reason}; nothing was started` };
  const current = currentCheckpoint(parsed.markerId, payload, deps);
  if (!current.ok) return { ok: false, phase: 'checkpoint', detail: `${current.reason}; nothing was started` };
  const checkpoint = Object.freeze({ id: current.record.id, recordSha256: current.recordSha256 });
  const plan = buildBackupPlan({
    markerId: parsed.markerId,
    outputRoot: root.root,
    pgDump: { path: deps.pgDump, sha256: pgDump.sha256 },
    pgRestore: { path: deps.pgRestore, sha256: pgRestore.sha256 },
    checkpoint,
  });
  return { ok: true, target, root: root.root, pgDump, pgRestore, payload, checkpoint, plan, digest: digestBackupPlan(plan) };
}

function dryRunLines(s, deps) {
  return [
    `${PREFIX} DRY RUN — NO DB CONNECTION WAS OPENED; no runtime was loaded and nothing was executed`,
    `  target: LOCAL_TEST ${CONFIRM_LOCAL_TARGET} (LOCAL_TEST_DATABASE_URL accepted; value not shown)`,
    `  marker id: ${s.target.markerId}`,
    `  required state: ${REQUIRED_STATE} (identity, settings, domain and state proven inside the exporter snapshot; schema stability proven after the dump)`,
    `  checkpoint: ${s.checkpoint.id} record sha256 ${s.checkpoint.recordSha256} (the current prepare checkpoint; must stay current through the backup)`,
    `  pg_dump: ${deps.pgDump} sha256 ${s.pgDump.sha256}`,
    `  pg_restore: ${deps.pgRestore} sha256 ${s.pgRestore.sha256}`,
    `  command: pg_dump ${PG_DUMP_ARGS.join(' ')} --snapshot=<exporter snapshot id> --file <run>/${DUMP_FILE}${TMP_SUFFIX}   (argv only, no shell; password only in the child environment; contained: own PID namespace and process group; stderr must be empty)`,
    `  child environment keys: ${PG_CHILD_ENV_KEYS.join(', ')}`,
    `  output root: ${s.root} (owner-only; outside the repository and temporary storage; one new run directory per backup)`,
    `  verification: regular 0600 non-empty archive, sha256, pg_restore --list (strict grammar, empty stderr, dbname, TABLE DATA for every table, no ${GUARD_SCHEMA}, TOC multiset digest), unchanged re-hash, self-hashed manifest v4 with the digest-only PRE witness`,
    `  plan digest: ${s.digest}`,
    `  --execute requires --confirm-local-target=${CONFIRM_LOCAL_TARGET} --plan=${s.digest}`,
  ];
}

const stamp = (date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

function writeExclusive(file, text) {
  const fd = openSync(file, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
}

export async function main(argv, overrides = {}) {
  const deps = Object.freeze({ ...DEFAULT_DEPS, ...overrides, env: Object.freeze({ ...(overrides.env ?? DEFAULT_DEPS.env) }) });
  const fail = (phase, detail) => {
    deps.error(`${PREFIX} FAIL: phase=${phase} — ${detail}`);
    return 1;
  };
  const parsed = parseBackupArgs(argv);
  if (!parsed.ok) return fail('args', parsed.error);
  if (parsed.mode === 'verify') return verifyRun(parsed.runDir, deps, fail);

  const s = staticGates(parsed, deps);
  if (!s.ok) return fail(s.phase, s.detail);
  if (parsed.mode === 'dry-run') {
    for (const line of dryRunLines(s, deps)) deps.log(line);
    return 0;
  }
  if (parsed.plan !== s.digest) return fail('plan', '--plan does not match the plan computed now; review a fresh --dry-run (values not shown)');

  const previousUmask = process.umask(0o077);
  try {
    let runtime;
    try {
      runtime = await deps.loadRuntime(
        Object.freeze({
          databaseUrl: s.target.url,
          markerId: parsed.markerId,
          approvedMigrations: Object.freeze(s.payload.migrations.map(({ name, sha256: h }) => Object.freeze({ name, sha256: h }))),
        }),
        Object.freeze({ ...deps }),
      );
    } catch {
      return fail('runtime', 'LOCAL_TEST runtime could not be loaded; nothing was started');
    }
    let code = 1;
    try {
      code = await executeWith(runtime, s, parsed, deps, fail);
    } finally {
      try {
        await runtime.close();
      } catch {
        if (code === 0) code = fail('close', 'LOCAL_TEST runtime could not be closed cleanly');
      }
    }
    return code;
  } finally {
    process.umask(previousUmask);
  }
}

async function executeWith(runtime, s, parsed, deps, fail) {
  const uid = process.getuid();
  let phase = 'identity';
  let runDir = null;
  let started = false;
  let refusal = null;
  const created = [];
  const cleanup = () => {
    for (const file of [...created].reverse()) {
      try {
        unlinkSync(file);
      } catch {
        /* best effort; only files this run created */
      }
    }
    if (runDir) {
      try {
        rmdirSync(runDir);
      } catch {
        /* a non-empty directory is left for inspection */
      }
    }
  };
  // A proof signals failure by throwing; an explicit `false` is a failure too.
  const prove = async () => {
    if ((await runtime.proveIdentity()) === false) throw new Error('identity proof reported failure');
  };
  // A refusal inside the exporter aborts it (the exporter then rolls back) and is reported with a FIXED reason: nothing
  // from the database, the archive or a child's stderr is ever echoed.
  const refuse = (at, detail) => {
    refusal = { phase: at, detail };
    throw new Error('backup refused');
  };
  try {
    await prove();
    phase = 'checkpoint';
    if (!sameCheckpoint(currentCheckpoint(parsed.markerId, s.payload, deps), s.checkpoint)) {
      return fail('checkpoint', 'the planned checkpoint is no longer the current one; nothing was dumped');
    }

    phase = 'exporter';
    // B1–B11: the REPEATABLE READ READ ONLY exporter proves identity/settings/domain, requires POST_BACKFILL, computes fPre in
    // its snapshot, runs this driver while it stays open, commits, then proves the schema did not change (B11).
    const built = await runtime.withBackupSnapshot(async (ctx) => {
      started = true;
      phase = 'run-directory';
      const name = `local-test-${stamp(deps.now())}-${deps.randomSuffix()}`;
      if (!RUN_DIR.test(name)) refuse('run-directory', 'run directory name is malformed');
      try {
        mkdirSync(path.join(s.root, name), { mode: 0o700 });
      } catch {
        refuse('run-directory', 'run directory already exists or could not be created; nothing is overwritten');
      }
      runDir = path.join(s.root, name);
      const tmpDump = path.join(runDir, `${DUMP_FILE}${TMP_SUFFIX}`);
      created.push(tmpDump);

      phase = 'pg_dump';
      const dumped = await runChild(deps, deps.pgDump, [...PG_DUMP_ARGS, `--snapshot=${ctx.snapshotId}`, '--file', tmpDump], buildPgDumpEnv(new URL(s.target.url).password, deps.home), { onOut: () => undefined, onErr: () => undefined });
      if (!dumped.ok) refuse('pg_dump', dumped.detail);
      if (dumped.stderrBytes > 0) refuse('pg_dump', 'pg_dump wrote to stderr (refused; bytes not shown)');
      phase = 'archive';
      const first = inspectBackupArchive(tmpDump, uid);
      if (!first.ok || !first.magic) refuse('archive', first.ok ? 'archive is not a PostgreSQL custom-format archive' : first.reason);
      deps.afterHash?.(tmpDump);

      phase = 'pg_restore';
      const toc = [];
      const listed = await runChild(deps, deps.pgRestore, ['--list', tmpDump], RESTORE_ENV(deps.home), { onOut: (line) => toc.push(line), onErr: () => undefined });
      if (!listed.ok) refuse('pg_restore', listed.detail);
      if (listed.stderrBytes > 0) refuse('pg_restore', 'pg_restore --list wrote to stderr (refused; bytes not shown)');
      const tocText = toc.length ? `${toc.join('\n')}\n` : '';
      const tocCheck = checkToc(tocText);
      if (!tocCheck.ok) refuse('pg_restore', tocCheck.reason);

      phase = 'rehash';
      const second = inspectBackupArchive(tmpDump, uid);
      if (!second.ok || second.sha256 !== first.sha256 || second.bytes !== first.bytes) refuse('rehash', 'archive changed after it was hashed');
      return { first, tocText, tocCheck, tmpDump, fPre: ctx.fPre, serverVersionNum: ctx.serverVersionNum, markerId: ctx.markerId, domainSha: ctx.protectedDomainContractSha256 };
    });

    phase = 'checkpoint-after';
    if (!sameCheckpoint(currentCheckpoint(parsed.markerId, s.payload, deps), s.checkpoint)) {
      cleanup();
      return fail('checkpoint-after', 'the checkpoint was superseded or consumed during the backup; nothing was finalized');
    }
    if (built.markerId !== parsed.markerId) {
      cleanup();
      return fail('identity', 'the exporter proved another installation; nothing was finalized');
    }

    phase = 'manifest';
    const { first, tocText, tocCheck, tmpDump } = built;
    const preText = buildWitness('PRE', { markerIdSha256: sha256(parsed.markerId), serverVersionNum: built.serverVersionNum, protectedDomainContractSha256: built.domainSha, fPre: built.fPre });
    const manifest = {
      format: MANIFEST_FORMAT,
      target: CONFIRM_LOCAL_TARGET,
      markerIdSha256: sha256(parsed.markerId),
      state: REQUIRED_STATE,
      createdAt: deps.now().toISOString(),
      run: path.basename(runDir),
      checkpoint: { id: s.checkpoint.id, recordSha256: s.checkpoint.recordSha256 },
      dump: { file: DUMP_FILE, bytes: first.bytes, sha256: first.sha256 },
      migrations: s.payload.migrations.map(({ name: m, sha256: h }) => [m, h]),
      lock: { provider: s.payload.lock.provider, sha256: s.payload.lock.sha256 },
      list: { sha256: sha256(tocText), entries: tocCheck.entries, tables: tocCheck.tables },
      pgDump: { path: deps.pgDump, sha256: s.pgDump.sha256 },
      pgRestore: { path: deps.pgRestore, sha256: s.pgRestore.sha256 },
      tool: { file: BACKUP_TOOL, sha256: sha256(readFileSync(SELF)) },
      plan: s.digest,
      preWitness: JSON.parse(preText),
      preWitnessSha256: preWitnessSha256(preText),
      tocMultisetSha256: tocCheck.multisetSha256,
      dumpFlags: { snapshot: true, lockWaitTimeout: true, strictNames: true },
    };
    manifest.manifestSha256 = backupManifestSelfHash(manifest);
    const tmpManifest = path.join(runDir, `${MANIFEST_FILE}${TMP_SUFFIX}`);
    created.push(tmpManifest);
    writeExclusive(tmpManifest, canonicalJson(manifest));

    phase = 'finalize';
    // Manifest first, archive last: an interruption never leaves a final archive
    // without its manifest; links never overwrite.
    created.push(path.join(runDir, MANIFEST_FILE));
    linkSync(tmpManifest, path.join(runDir, MANIFEST_FILE));
    created.push(path.join(runDir, DUMP_FILE));
    linkSync(tmpDump, path.join(runDir, DUMP_FILE));
    unlinkSync(tmpManifest);
    unlinkSync(tmpDump);
    deps.log(`${PREFIX} LOCAL_TEST_BACKUP_OK run=${path.basename(runDir)} dump_sha256=${first.sha256} bytes=${first.bytes} toc_tables=${tocCheck.tables} state=${REQUIRED_STATE} checkpoint=${s.checkpoint.id}`);
    return 0;
  } catch {
    cleanup();
    if (refusal) return fail(refusal.phase, `${refusal.detail}; nothing was finalized`);
    // before the driver started, the only reason is the exporter's own refusal (state, identity, settings, domain, timeout)
    if (!started) return fail('classify', `the backup requires state ${REQUIRED_STATE} proven inside one consistent snapshot; nothing was dumped`);
    return fail(phase, 'LOCAL_TEST backup step failed (details not shown); nothing was finalized');
  }
}

// Re-verifies a finalized run directory with no database and no environment:
// readBackupRun (exactly the two files, both 0600 regular, canonical self-hashed v2
// manifest with the reviewed fields, archive sha/size equal to the manifest), then
// a TOC that still lists cleanly and hashes to the recorded value.
async function verifyRun(runDir, deps, fail) {
  const checked = readBackupRun(runDir, process.getuid());
  if (!checked.ok) return fail('verify', checked.reason);
  const { manifest } = checked;
  const archive = checked.dump;
  const toc = [];
  const listed = await runChild(deps, deps.pgRestore, ['--list', path.join(runDir, DUMP_FILE)], RESTORE_ENV(deps.home), {
    onOut: (line) => toc.push(line),
    onErr: () => undefined,
  });
  const tocText = toc.length ? `${toc.join('\n')}\n` : '';
  if (listed.ok && listed.stderrBytes > 0) return fail('verify', 'pg_restore --list wrote to stderr (refused; bytes not shown)');
  const tocCheck = listed.ok ? checkToc(tocText) : { ok: false, reason: listed.detail };
  if (!tocCheck.ok) return fail('verify', tocCheck.reason);
  if (sha256(tocText) !== manifest.list?.sha256 || tocCheck.multisetSha256 !== manifest.tocMultisetSha256) return fail('verify', 'archive TOC does not match the manifest');
  deps.log(`${PREFIX} VERIFY OK run=${path.basename(runDir)} dump_sha256=${archive.sha256} toc_tables=${tocCheck.tables}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runTool(() => main(process.argv.slice(2)), { prefix: PREFIX });
}
