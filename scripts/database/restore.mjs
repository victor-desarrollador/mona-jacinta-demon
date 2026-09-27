import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import {
  CA_PATH,
  MARKER_VAR,
  PROJECT_REF_PATTERN,
  TEST_VAR,
  matchesProjectRef,
  openVerifiedBackup,
  parseConnection,
  readTestConfig,
  redact,
  runPgTool,
  tableRowCounts,
} from './lib.mjs';
import { confirmed, proveInstalledMarker, safeCode } from './test-marker.mjs';

// Restore is TEST-only, always — never DEV, never production, never a default.
//
//   node scripts/database/restore.mjs --target=test --file=<test_*.dump> --confirm-project-ref=<ref>
//
// DEV-free: this file never imports scripts/check-databases.mjs / proveIdentities()
// and never reads DATABASE_URL. It connects only through TEST_DATABASE_URL (the
// pg_restore child, the row-count client, and the prisma migrate status child,
// which is given DATABASE_URL=<TEST URL> explicitly).
//
// Identity (both required, in this order, before anything destructive):
//   1. owner attestation — --confirm-project-ref must be the tenant TEST_DATABASE_URL
//      routes to (necessary, not sufficient);
//   2. live marker proof — immediately before pg_restore, this process connects to
//      that same TEST connection (verified TLS) and proves, read-only, that it holds
//      exactly the canonical mona_test_guard marker with the id pinned as
//      TEST_DATABASE_MARKER_ID in .env.development (test-marker.mjs
//      proveInstalledMarker). Any failure or error fails closed: nothing is restored.
// A public-only archive restored with --clean never drops the marker schema.

const PREFIX = '[db:restore]';
const VALUE_ARGS = ['target', 'file', 'confirm-project-ref'];
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RESTORE_FLAGS = ['--format=custom', '--no-owner', '--no-acl', '--clean', '--if-exists', '--exit-on-error', '--single-transaction'];

// Strict: every argument must be known and given once; rejected values are never echoed.
export function parseRestoreArgs(argv) {
  const values = {};
  for (const arg of argv) {
    if (!arg.startsWith('--')) return { ok: false, error: 'Unexpected positional argument' };
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    const key = eq === -1 ? null : body.slice(0, eq);
    if (!key || !VALUE_ARGS.includes(key)) return { ok: false, error: 'Unknown argument (not echoed)' };
    if (key in values) return { ok: false, error: `--${key} may be given only once` };
    values[key] = body.slice(eq + 1);
  }
  if (values.target !== 'test') {
    return { ok: false, error: '--target must be exactly "test"; restore into demo/DEV or production is not permitted through this tool' };
  }
  if (!values.file) return { ok: false, error: '--file is required: a test_*.dump produced by backup.mjs --target=test' };
  const ref = values['confirm-project-ref'];
  if (ref === undefined || !PROJECT_REF_PATTERN.test(ref)) {
    return { ok: false, error: '--confirm-project-ref=<20-character TEST project ref> is required' };
  }
  return { ok: true, file: values.file, confirmProjectRef: ref };
}

function migrateStatus(testUrl) {
  // Same env-override pattern api/tests/seed.test.ts uses to point the Prisma CLI
  // at TEST for one invocation. prisma.config.ts loads .env.development with
  // override:false, so this explicit DATABASE_URL (the TEST URL) is what it uses.
  return execFileSync(process.execPath, ['./node_modules/prisma/build/index.js', 'migrate', 'status'], {
    cwd: fileURLToPath(new URL('../../api/', import.meta.url)),
    env: { ...process.env, DATABASE_URL: testUrl },
    stdio: 'pipe',
    timeout: 30000,
  }).toString();
}

// Discrete connection fields (no connection string), verified TLS against the
// bundled CA, bounded connect and per-query time. pg errors never reach the output.
function createMarkerClient(conn) {
  const client = new pg.Client({
    host: conn.host,
    port: Number(conn.port),
    database: conn.database,
    user: conn.user,
    password: conn.password,
    ssl: { rejectUnauthorized: true, ca: readFileSync(CA_PATH, 'utf8'), servername: conn.host },
    connectionTimeoutMillis: 10000,
    query_timeout: 20000,
  });
  client.on('error', () => {
    /* Never emit credentials from pg errors; the awaited call fails closed. */
  });
  return client;
}

// Runs the live marker proof on its own short-lived connection and always closes it.
// Returns { ok: true } or { ok: false, reason } with a fixed, secret-free reason.
// Success requires the proof to pass AND the connection close to be confirmed; an
// unconfirmed close fails closed, so pg_restore never runs. A failed proof stays
// authoritative over any close failure.
async function proveLiveMarker(deps, conn, markerId, secrets) {
  const unproven = (err) => ({ ok: false, reason: `TEST identity marker could not be proven (code=${safeCode(err, secrets)})` });
  let client;
  try {
    client = deps.createMarkerClient(conn);
  } catch (err) {
    return unproven(err);
  }
  let outcome;
  try {
    await client.connect();
    const stream = client.connection?.stream;
    outcome = stream?.encrypted === true && stream?.authorized === true
      ? await proveInstalledMarker(client, markerId)
      : { ok: false, reason: 'verified TLS is required for the TEST identity marker proof' };
  } catch (err) {
    outcome = unproven(err);
  }
  const closed = await confirmed(() => client.end());
  if (!outcome.ok) return outcome;
  if (!closed) return { ok: false, reason: 'the TEST marker proof connection could not be closed cleanly (proof not trusted)' };
  return outcome;
}

const defaultDeps = {
  // Same file source as backup.mjs --target=test: .env.development in the working
  // directory, read as text without loading it into process.env.
  readEnvText: () => readFileSync('.env.development', 'utf8'),
  openBackup: (file) => openVerifiedBackup(file),
  createMarkerClient,
  runPgTool,
  tableRowCounts,
  migrateStatus,
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

export async function main(argv, overrides = {}) {
  const deps = { ...defaultDeps, ...overrides };
  const fail = (phase, detail) => {
    deps.error(`${PREFIX} FAIL: phase=${phase} — ${detail}`);
    return 1;
  };

  const parsed = parseRestoreArgs(argv);
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
  if (typeof config.pinnedMarkerId !== 'string' || !UUID_V4.test(config.pinnedMarkerId)) {
    return fail('config', `${MARKER_VAR} must be set in .env.development to the installed TEST marker id (canonical lowercase version-4 UUID; value not shown)`);
  }

  // Everything below uses the verified snapshot: the exact bytes whose digest,
  // manifest binding, archive TOC and table set were proven. The original path
  // is never read again.
  let backup;
  try {
    backup = await deps.openBackup(parsed.file);
  } catch {
    backup = { ok: false, reason: 'artifact could not be verified' };
  }
  if (!backup.ok) return fail('verify', `refusing to restore: ${backup.reason}`);

  try {
    const conn = parseConnection(config.testUrl);
    const tenant = conn.user.startsWith('postgres.') ? conn.user.slice('postgres.'.length) : '';
    const scrub = (text) => {
      let out = redact(String(text), conn);
      for (const secret of [config.testUrl, tenant]) if (secret) out = out.split(secret).join('«redacted»');
      return out.slice(0, 2000);
    };

    // Last gate before the first destructive action: the live TEST marker proof.
    const secrets = [config.testUrl, conn.password, conn.host, conn.user, tenant, conn.database, String(conn.port)];
    const proof = await proveLiveMarker(deps, conn, config.pinnedMarkerId, secrets);
    if (!proof.ok) return fail('marker', `${proof.reason}; nothing was restored`);

    try {
      await deps.runPgTool('pg_restore', [...RESTORE_FLAGS, '--dbname', conn.database, backup.snapshotPath], conn);
    } catch (err) {
      return fail('restore', `pg_restore failed: ${scrub(err?.message ?? 'unexpected error')}`);
    }

    // Post-restore logical-state verification against the verified manifest's
    // counts — never claim success from exit code alone.
    let counts;
    try {
      counts = await deps.tableRowCounts(conn, Object.keys(backup.counts));
    } catch (err) {
      return fail('counts', `post-restore row-count verification could not run: ${scrub(err?.message ?? 'unexpected error')}`);
    }
    const mismatched = Object.entries(backup.counts).some(([table, expected]) => counts[table] !== expected);
    if (mismatched) {
      return fail('counts', `post-restore row counts do not match the manifest: expected ${JSON.stringify(backup.counts)}, got ${JSON.stringify(counts)}`);
    }

    let status;
    try {
      status = deps.migrateStatus(config.testUrl);
    } catch (err) {
      const output = (err?.stdout?.toString() ?? '') + (err?.stderr?.toString() ?? err?.message ?? '');
      return fail('migrate', `prisma migrate status failed against the restored TEST target: ${scrub(output)}`);
    }
    if (!/up to date/i.test(status)) {
      return fail('migrate', `prisma migrate status did not report the restored TEST target as up to date: ${scrub(status)}`);
    }

    deps.log(`${PREFIX} OK`);
    deps.log('  target: test');
    deps.log(`  artifact: ${backup.name} (set ${backup.setId})`);
    deps.log('  manifest, sha256, archive readability and table set verified: yes');
    deps.log(`  row counts: ${JSON.stringify(counts)}`);
    deps.log('  prisma migrate status: up to date');
    deps.log(`  identity: owner project-ref attestation + live TEST marker proof (pinned ${MARKER_VAR}); TEST connection only`);
    return 0;
  } finally {
    // The outcome above is established — and pg_restore may already have changed
    // TEST — so removing the private snapshot can neither replace nor misstate it.
    // Both a synchronous throw and a rejection are contained; a leftover snapshot is
    // reported with a fixed line (no path, no error text).
    try {
      await backup.dispose();
    } catch {
      deps.error(`${PREFIX} WARNING: the private verified snapshot could not be removed (path not shown); the restore outcome above is unchanged`);
    }
  }
}

// Only run when executed directly; importing from a test never restores anything.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
