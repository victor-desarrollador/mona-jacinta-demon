import { createHash } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Client } = pg;

// Local, gitignored artifact directory (see .gitignore) — never a tracked path.
export const ARTIFACT_DIR = fileURLToPath(new URL('../../backups/database/', import.meta.url));
export const CA_PATH = fileURLToPath(new URL('../certs/supabase-prod-ca-2021.crt', import.meta.url));

export function utcTimestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

export function artifactName(environment, purpose) {
  return `${environment}_${purpose}_${utcTimestamp()}.dump`;
}

// Only what pg_dump/pg_restore need as libpq environment variables — never the
// raw connection string, and never passed as a literal CLI argument.
export function parseConnection(raw) {
  const url = new URL(raw);
  return {
    host: url.hostname,
    port: url.port || '5432',
    database: decodeURIComponent(url.pathname.replace(/^\//, '')),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  };
}

function pgEnv(conn) {
  return {
    PATH: process.env.PATH,
    PGHOST: conn.host,
    PGPORT: conn.port,
    PGDATABASE: conn.database,
    PGUSER: conn.user,
    PGPASSWORD: conn.password,
    PGSSLMODE: 'verify-full',
    PGSSLROOTCERT: CA_PATH,
  };
}

export function redact(text, conn) {
  let out = text;
  for (const secret of [conn.password, conn.host, conn.user]) {
    if (secret) out = out.split(secret).join('«redacted»');
  }
  return out;
}

// Runs pg_dump/pg_restore with credentials only via env (never argv, never a
// connection string), and never echoes unredacted output on failure.
export function runPgTool(bin, args, conn) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env: pgEnv(conn), stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let stdout = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.on('error', (err) => {
      reject(new Error(`${bin} failed to start: ${err.code ?? err.message}`));
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout: redact(stdout, conn) });
      } else {
        reject(new Error(`${bin} exited with code ${code}: ${redact(stderr, conn).slice(0, 4000)}`));
      }
    });
  });
}

// Same verified-TLS shape as scripts/check-databases.mjs's clientFor: rejectUnauthorized
// plus an explicit trusted CA gives certificate *and* hostname verification (Node's tls
// module runs its default checkServerIdentity unless overridden, which this doesn't do).
async function withVerifiedClient(conn, fn) {
  const client = new Client({
    host: conn.host,
    port: Number(conn.port),
    database: conn.database,
    user: conn.user,
    password: conn.password,
    ssl: { rejectUnauthorized: true, ca: readFileSync(CA_PATH, 'utf8') },
    connectionTimeoutMillis: 10000,
  });
  try {
    await client.connect();
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

// Row counts for `tables` (or, if omitted, every table in the `public` schema,
// discovered dynamically — never a hand-picked/hardcoded subset). Used by both
// backup.mjs (to capture a logical-state manifest at backup time) and restore.mjs
// (to verify the restored state matches that manifest exactly).
export async function tableRowCounts(conn, tables) {
  return withVerifiedClient(conn, async (client) => {
    let names = tables;
    if (!names) {
      const result = await client.query(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
      );
      names = result.rows.map((row) => row.tablename);
    }
    const counts = {};
    for (const name of names) {
      const result = await client.query(`SELECT count(*)::int AS n FROM "${name}"`);
      counts[name] = result.rows[0].n;
    }
    return counts;
  });
}

export function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}
