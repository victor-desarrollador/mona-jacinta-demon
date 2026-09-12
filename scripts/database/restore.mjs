import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { proveIdentities } from '../check-databases.mjs';
import { parseConnection, redact, runPgTool, sha256File, tableRowCounts } from './lib.mjs';

function parseArgs(argv) {
  const args = { target: null, file: null };
  for (const arg of argv) {
    const [key, value] = arg.replace(/^--/, '').split('=');
    if (key === 'target') args.target = value;
    else if (key === 'file') args.file = value;
  }
  return args;
}

function fail(message) {
  console.error(`[db:restore] FAIL: ${message}`);
  process.exitCode = 1;
}

async function main() {
  const { target, file } = parseArgs(process.argv.slice(2));

  // Restore is TEST-only, always — never DEV, never production, never a default.
  if (target !== 'test') {
    fail('--target must be exactly "test"; restore into demo/DEV or production is not permitted through this tool');
    return;
  }
  if (!file) {
    fail('--file is required: path to a .dump artifact produced by scripts/database/backup.mjs');
    return;
  }

  const artifactPath = path.resolve(file);
  const sidecarPath = `${artifactPath}.sha256`;
  const manifestPath = `${artifactPath}.counts.json`;
  if (!existsSync(artifactPath) || !existsSync(sidecarPath)) {
    fail('artifact or its .sha256 sidecar is missing; refusing to restore an unverifiable file');
    return;
  }
  if (!existsSync(manifestPath)) {
    fail('artifact has no .counts.json manifest (written by scripts/database/backup.mjs); refusing to restore without a way to verify the full restored state matches what was backed up');
    return;
  }
  let expectedCounts;
  try {
    expectedCounts = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    fail('artifact .counts.json manifest is not valid JSON; refusing to treat any restore as verified');
    return;
  }

  let identities;
  try {
    identities = await proveIdentities();
  } catch (err) {
    fail(`identity proof failed; refusing to proceed: ${err.message}`);
    return;
  }

  const expected = readFileSync(sidecarPath, 'utf8').trim().split(/\s+/)[0];
  const actual = await sha256File(artifactPath);
  if (expected !== actual) {
    fail('checksum mismatch against .sha256 sidecar; refusing to restore a modified or corrupted artifact');
    return;
  }

  // pg_restore -l lists the archive's table of contents without touching any
  // database — proves the archive is readable before any destructive step.
  let toc;
  const listConn = { host: '', port: '', database: '', user: '', password: '' };
  try {
    toc = await runPgTool('pg_restore', ['--list', artifactPath], listConn);
  } catch (err) {
    fail(`archive is not readable by pg_restore; refusing to restore: ${err.message}`);
    return;
  }
  if (!toc.stdout.includes('TABLE DATA')) {
    fail('archive table of contents contains no table data; refusing to restore');
    return;
  }

  const conn = parseConnection(identities.testUrl);

  try {
    await runPgTool(
      'pg_restore',
      [
        '--format=custom', '--no-owner', '--no-acl', '--clean', '--if-exists',
        '--exit-on-error', '--single-transaction', '--dbname', conn.database,
        artifactPath,
      ],
      conn,
    );
  } catch (err) {
    fail(`pg_restore failed: ${err.message}`);
    return;
  }

  // Post-restore logical-state verification — never claim success from exit code alone.
  // Compares against the manifest backup.mjs captured from the SOURCE database at
  // backup time (every public table, not a hand-picked subset) — this proves the
  // restored state matches what was actually backed up, without inventing an
  // expected count for any table whose state is legitimately variable.
  let counts;
  try {
    counts = await tableRowCounts(conn, Object.keys(expectedCounts));
  } catch (err) {
    fail(`post-restore row-count verification could not run: ${redact(err.message, conn)}`);
    return;
  }

  const mismatches = Object.entries(expectedCounts).filter(([table, expectedCount]) => counts[table] !== expectedCount);
  if (mismatches.length > 0) {
    fail(`post-restore row counts do not match the backup-time manifest: expected ${JSON.stringify(expectedCounts)}, got ${JSON.stringify(counts)}`);
    return;
  }

  // Reuses the exact env-override pattern api/tests/seed.test.ts already uses to
  // point the Prisma CLI at TEST for one invocation — no second resolution path.
  let migrateStatusOutput = '';
  try {
    migrateStatusOutput = execFileSync(
      process.execPath,
      ['./node_modules/prisma/build/index.js', 'migrate', 'status'],
      {
        cwd: fileURLToPath(new URL('../../api/', import.meta.url)),
        env: { ...process.env, DATABASE_URL: identities.testUrl },
        stdio: 'pipe',
        timeout: 30000,
      },
    ).toString();
  } catch (err) {
    const output = (err.stdout?.toString() ?? '') + (err.stderr?.toString() ?? err.message);
    // The child's DATABASE_URL is the raw TEST connection string (identities.testUrl),
    // so any error text it prints (a malformed-URL error, an unreachable-host message,
    // etc.) could otherwise echo it back — redact before this ever reaches fail()/stderr.
    fail(`prisma migrate status failed against the restored TEST target: ${redact(output, conn).slice(0, 2000)}`);
    return;
  }

  const upToDate = /up to date/i.test(migrateStatusOutput);
  if (!upToDate) {
    fail(`prisma migrate status did not report the restored TEST target as up to date: ${redact(migrateStatusOutput, conn).slice(0, 2000)}`);
    return;
  }

  console.log('[db:restore] OK');
  console.log('  target: test');
  console.log(`  artifact: ${path.basename(artifactPath)}`);
  console.log('  checksum verified: yes');
  console.log('  archive readable (pg_restore --list): yes');
  console.log(`  row counts: ${JSON.stringify(counts)}`);
  console.log('  prisma migrate status: up to date');
}

await main();
