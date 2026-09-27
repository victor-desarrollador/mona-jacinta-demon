import * as nodeFs from 'node:fs';
import { mkdirSync, renameSync, unlinkSync, existsSync, writeFileSync, statSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  ARTIFACT_DIR,
  PROJECT_REF_PATTERN,
  TEST_VAR,
  artifactName,
  buildBackupManifest,
  manifestPathFor,
  matchesProjectRef,
  parseConnection,
  readTestConfig,
  redact,
  runPgTool,
  sha256File,
  tableRowCounts,
  verifyBackupPair,
} from './lib.mjs';

// Backup sources this tool supports today. Production does not exist yet and is
// never accepted (see docs/development/backup-restore-seed.md §2).
const TARGETS = ['demo', 'test'];
const PURPOSES = ['manual', 'pre-migration', 'scheduled', 'drill'];

function parseArgs(argv) {
  const args = { target: null, purpose: 'manual' };
  for (const arg of argv) {
    const [key, value] = arg.replace(/^--/, '').split('=');
    if (key === 'target') args.target = value;
    else if (key === 'purpose') args.purpose = value;
  }
  return args;
}

function fail(message) {
  console.error(`[db:backup] FAIL: ${message}`);
  process.exitCode = 1;
}

// DEMO (and any non-test --target) keeps the original flow unchanged, including
// the comparative DEV/TEST identity proof, which is loaded only on this path.
async function legacyMain(argv) {
  const { target, purpose } = parseArgs(argv);

  // Fail closed on missing/ambiguous target — never a default, never a fallback.
  if (!target || !TARGETS.includes(target)) {
    fail(`--target is required and must be exactly one of: ${TARGETS.join(', ')} (no default is ever assumed)`);
    return;
  }
  if (!PURPOSES.includes(purpose)) {
    fail(`--purpose must be one of: ${PURPOSES.join(', ')}`);
    return;
  }

  let identities;
  try {
    const { proveIdentities } = await import('../check-databases.mjs');
    identities = await proveIdentities();
  } catch (err) {
    fail(`identity proof failed; refusing to proceed: ${err.message}`);
    return;
  }

  const url = target === 'demo' ? identities.devUrl : identities.testUrl;
  const conn = parseConnection(url);

  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const finalName = artifactName(target, purpose);
  const finalPath = path.join(ARTIFACT_DIR, finalName);
  const tmpPath = `${finalPath}.tmp`;

  try {
    // --schema=public scopes the dump to application-owned objects only. Supabase
    // provisions cluster-level event triggers (PostgREST/pg_graphql/pg_cron/pg_net
    // schema-cache notifications) owned by supabase_admin, not our role — they are
    // not schema-scoped and are correctly excluded by --schema=public, which also
    // means a later --clean restore never attempts to drop an object our role
    // doesn't own (confirmed: an unscoped dump fails restore with "must be owner
    // of event trigger pgrst_drop_watch").
    await runPgTool(
      'pg_dump',
      ['--format=custom', '--no-owner', '--no-acl', '--schema=public', '--file', tmpPath, conn.database],
      conn,
    );
  } catch (err) {
    if (existsSync(tmpPath)) unlinkSync(tmpPath);
    fail(`pg_dump failed; no artifact was left behind: ${err.message}`);
    return;
  }

  // Rename only on success — never leave a partial/corrupt artifact at the final path.
  renameSync(tmpPath, finalPath);
  const checksum = await sha256File(finalPath);
  writeFileSync(`${finalPath}.sha256`, `${checksum}  ${finalName}\n`);
  const size = statSync(finalPath).size;

  // Captures the SOURCE database's actual row counts for every public table, not a
  // hand-picked/hardcoded subset — this becomes the manifest restore.mjs compares
  // the restored state against, so verification never has to invent an expected
  // count for a table whose state is legitimately variable (e.g. business tables
  // with real rows in them); it just requires "restored matches what was backed up."
  // restore.mjs hard-requires this manifest, so a backup without one is not usable —
  // treat a failure here as a failed backup, not a partially-successful one.
  let counts;
  try {
    counts = await tableRowCounts(conn);
  } catch (err) {
    unlinkSync(finalPath);
    unlinkSync(`${finalPath}.sha256`);
    fail(`could not capture the post-dump row-count manifest; backup discarded: ${redact(err.message, conn)}`);
    return;
  }
  writeFileSync(`${finalPath}.counts.json`, `${JSON.stringify(counts, null, 2)}\n`);

  console.log('[db:backup] OK');
  console.log(`  environment: ${target}`);
  console.log(`  purpose: ${purpose}`);
  console.log(`  artifact: ${finalName}`);
  console.log(`  size bytes: ${size}`);
  console.log(`  sha256: ${checksum}`);
  console.log(`  tables captured: ${Object.keys(counts).length}`);
}

// --- TEST-only path ---------------------------------------------------------
// `--target=test` never reads DATABASE_URL, never imports check-databases.mjs /
// proveIdentities(), and opens connections only through TEST_DATABASE_URL (the
// pg_dump child and the row-count client). Before the TEST identity marker exists
// the target is bound by owner attestation (--confirm-project-ref); after it is
// installed, TEST tooling should move to marker-based proof.

const PREFIX = '[db:backup]';
const TEST_VALUE_ARGS = ['target', 'purpose', 'confirm-project-ref'];
const DUMP_FLAGS = ['--format=custom', '--no-owner', '--no-acl', '--schema=public'];

// Any --target=test* argument selects the strict TEST path, so an ambiguous
// `--target=demo --target=test` is rejected there instead of running a demo backup.
export function isTestInvocation(argv) {
  return argv.some((arg) => arg.startsWith('--target=test'));
}

// Strict: every argument must be known and given once; rejected values are never echoed.
export function parseTestBackupArgs(argv) {
  const values = {};
  for (const arg of argv) {
    if (!arg.startsWith('--')) return { ok: false, error: 'Unexpected positional argument' };
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    const key = eq === -1 ? null : body.slice(0, eq);
    if (!key || !TEST_VALUE_ARGS.includes(key)) return { ok: false, error: 'Unknown argument (not echoed)' };
    if (key in values) return { ok: false, error: `--${key} may be given only once` };
    values[key] = body.slice(eq + 1);
  }
  if (values.target !== 'test') return { ok: false, error: 'Only --target=test is accepted on this path' };
  const purpose = values.purpose ?? 'manual';
  if (!PURPOSES.includes(purpose)) return { ok: false, error: `--purpose must be one of: ${PURPOSES.join(', ')}` };
  const ref = values['confirm-project-ref'];
  if (ref === undefined || !PROJECT_REF_PATTERN.test(ref)) {
    return { ok: false, error: '--confirm-project-ref=<20-character TEST project ref> is required for --target=test' };
  }
  return { ok: true, purpose, confirmProjectRef: ref };
}

function scrub(text, secrets) {
  let out = String(text);
  for (const secret of secrets) if (secret) out = out.split(secret).join('«redacted»');
  return out;
}

export async function backupTest(argv, deps) {
  const fsOps = { ...nodeFs, ...deps.fs };
  const fail = (phase, detail) => {
    deps.error(`${PREFIX} FAIL: phase=${phase} — ${detail}`);
    return 1;
  };

  const parsed = parseTestBackupArgs(argv);
  if (!parsed.ok) return fail('args', parsed.error);

  let config;
  try {
    config = readTestConfig(deps.readEnvText());
  } catch {
    config = { ok: false };
  }
  if (!config.ok) return fail('config', `${TEST_VAR} is missing or malformed in .env.development (value not shown)`);
  if (!matchesProjectRef(config.testUrl, parsed.confirmProjectRef)) {
    return fail('target', `--confirm-project-ref does not match ${TEST_VAR} (value not shown)`);
  }

  const conn = parseConnection(config.testUrl);
  const tenant = conn.user.startsWith('postgres.') ? conn.user.slice('postgres.'.length) : '';
  const secrets = [config.testUrl, conn.password, conn.host, conn.user, tenant, `:${conn.port}`];
  const clean = (err) => scrub(redact(String(err?.message ?? 'unexpected error'), conn), secrets).slice(0, 2000);

  const finalName = deps.artifactName('test', parsed.purpose);
  const finalPath = path.join(deps.artifactDir, finalName);
  const files = {
    dump: { tmp: `${finalPath}.tmp`, final: finalPath },
    manifest: { tmp: `${finalPath}.manifest.json.tmp`, final: manifestPathFor(finalPath) },
  };
  const all = Object.values(files).flatMap((f) => [f.tmp, f.final]);
  if (all.some((p) => fsOps.existsSync(p))) {
    return fail('finalize', 'an artifact or temp file with this name already exists; refusing to overwrite');
  }

  const created = [];
  const cleanup = () => {
    for (const p of created) {
      try {
        fsOps.unlinkSync(p);
      } catch {
        /* Best effort; the primary failure is what gets reported. */
      }
    }
  };
  const failClean = (phase, detail) => {
    cleanup();
    return fail(phase, detail);
  };

  let phase = 'prepare';
  try {
    fsOps.mkdirSync(deps.artifactDir, { recursive: true });

    phase = 'dump';
    created.push(files.dump.tmp);
    try {
      await deps.runPgTool('pg_dump', [...DUMP_FLAGS, '--file', files.dump.tmp, conn.database], conn);
    } catch (err) {
      return failClean('dump', `pg_dump failed; no artifact was left behind: ${clean(err)}`);
    }

    phase = 'verify';
    if (!fsOps.existsSync(files.dump.tmp) || fsOps.statSync(files.dump.tmp).size === 0) {
      return failClean('verify', 'pg_dump produced no data');
    }

    phase = 'checksum';
    const checksum = await deps.sha256File(files.dump.tmp);

    phase = 'counts';
    let counts;
    try {
      counts = await deps.tableRowCounts(conn);
    } catch (err) {
      return failClean('counts', `could not capture the row-count manifest: ${clean(err)}`);
    }
    if (!counts || Object.keys(counts).length === 0) return failClean('counts', 'row-count manifest is empty');

    phase = 'manifest';
    created.push(files.manifest.tmp);
    const setId = deps.randomUUID();
    fsOps.writeFileSync(
      files.manifest.tmp,
      buildBackupManifest({
        setId,
        createdAt: deps.now().toISOString(),
        purpose: parsed.purpose,
        file: finalName,
        bytes: fsOps.statSync(files.dump.tmp).size,
        sha256: checksum,
        counts,
      }),
      { flag: 'wx' },
    );

    // The producer runs the exact consumer check (manifest binding, snapshot
    // digest, pg_restore --list, TABLE DATA == counts, no marker schema) before
    // anything is finalized.
    phase = 'verify';
    const verified = await verifyBackupPair(
      { dumpPath: files.dump.tmp, manifestPath: files.manifest.tmp, expectedFile: finalName },
      { runPgTool: deps.runPgTool, tmpRoot: deps.tmpRoot },
    );
    if (!verified.ok) return failClean('verify', verified.reason);
    verified.dispose();

    phase = 'finalize';
    // linkSync never overwrites (EEXIST). The .dump is linked last: it is the
    // commit point, so an interruption before it leaves no .dump at the final path.
    for (const key of ['manifest', 'dump']) {
      fsOps.linkSync(files[key].tmp, files[key].final);
      created.push(files[key].final);
    }
    for (const key of ['manifest', 'dump']) {
      try {
        fsOps.unlinkSync(files[key].tmp);
      } catch {
        /* A leftover .tmp is never accepted as an artifact. */
      }
    }

    deps.log(`${PREFIX} OK`);
    deps.log('  environment: test');
    deps.log(`  purpose: ${parsed.purpose}`);
    deps.log(`  artifact: ${finalName}`);
    deps.log(`  size bytes: ${fsOps.statSync(files.dump.final).size}`);
    deps.log(`  manifest: ${path.basename(files.manifest.final)}`);
    deps.log(`  set id: ${setId}`);
    deps.log(`  sha256: ${checksum}`);
    deps.log(`  tables captured: ${Object.keys(counts).length}`);
    deps.log('  identity: owner project-ref attestation (bootstrap); TEST connection only');
    return 0;
  } catch (err) {
    const code = typeof err?.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(err.code) ? ` (${err.code})` : '';
    return failClean(phase, `step failed${code}; nothing was finalized`);
  }
}

const defaultTestDeps = {
  // Same file source the legacy path uses (process.loadEnvFile('.env.development')
  // in check-databases.mjs, relative to the working directory), read without
  // loading it into process.env.
  readEnvText: () => readFileSync('.env.development', 'utf8'),
  artifactDir: ARTIFACT_DIR,
  artifactName,
  runPgTool,
  sha256File,
  tableRowCounts,
  randomUUID,
  now: () => new Date(),
  tmpRoot: undefined,
  fs: {},
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

export async function main(argv, deps = defaultTestDeps) {
  if (isTestInvocation(argv)) return backupTest(argv, { ...defaultTestDeps, ...deps });
  await legacyMain(argv);
  return process.exitCode ?? 0;
}

// Only run when executed directly; importing from a test never runs a backup.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
