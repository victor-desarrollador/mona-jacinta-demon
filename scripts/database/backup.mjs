import { mkdirSync, renameSync, unlinkSync, existsSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { proveIdentities } from '../check-databases.mjs';
import { ARTIFACT_DIR, artifactName, parseConnection, redact, runPgTool, sha256File, tableRowCounts } from './lib.mjs';

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

async function main() {
  const { target, purpose } = parseArgs(process.argv.slice(2));

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

await main();
