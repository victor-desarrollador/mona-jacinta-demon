// R3-A4.3 S1: psql invocation for the opt-in P21 tests, built so the
// connection credentials never reach argv, a shell or a log line.
//
// - psql is executed directly (absolute path, no shell): the caller passes
//   `command` and `args` to execFile, never a command string.
// - argv is fixed flags plus the SQL file; host, port, database and user go
//   through libpq environment variables and the password through a temporary
//   pass file (0600, inside a 0700 directory) that is always removed.
// - PGPASSWORD is never set; the service file is neutralized.
// - Every message built here, and redactConnectionSecrets(), keep the URL,
//   user, password, host and database out of errors and assertion output.
//
// Pure apart from the temporary directory in withPsqlInvocation(); it never
// spawns anything and never opens a database.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const PSQL_BIN = '/usr/bin/psql';

export type PsqlInvocation = {
  command: string;
  args: string[];
  env: Record<string, string>;
  pgpass: string;
};

type Target = { host: string; port: string; database: string; user: string; password: string; sslmode: string | null };

const refuse = (reason: string): never => {
  throw new Error(`psql target refused: ${reason}`);
};

function parseTarget(url: string): Target {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return refuse('not a valid URL');
  }
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') refuse('not a PostgreSQL URL');
  const keys = [...parsed.searchParams.keys()];
  if (keys.some((key) => key !== 'sslmode')) refuse('only the sslmode query parameter is accepted');
  const decode = (value: string) => {
    try {
      return decodeURIComponent(value);
    } catch {
      return refuse('undecodable URL component');
    }
  };
  const database = decode(parsed.pathname.replace(/^\//, ''));
  const user = decode(parsed.username);
  if (!parsed.hostname || !database || !user) refuse('host, database and user are required');
  if (/[\r\n]/.test(`${parsed.hostname}${database}${user}${decode(parsed.password)}`)) refuse('control characters');
  return {
    host: parsed.hostname,
    port: parsed.port || '5432',
    database,
    user,
    password: decode(parsed.password),
    sslmode: parsed.searchParams.get('sslmode'),
  };
}

// .pgpass fields escape ':' and '\'.
const pgpassField = (value: string) => value.replace(/\\/g, '\\\\').replace(/:/g, '\\:');

export function buildPsqlInvocation(url: string, sqlFile: string, workDir: string): PsqlInvocation {
  const t = parseTarget(url);
  const env: Record<string, string> = {
    PATH: '/usr/bin:/bin',
    PGHOST: t.host,
    PGPORT: t.port,
    PGDATABASE: t.database,
    PGUSER: t.user,
    PGPASSFILE: path.join(workDir, 'pgpass'),
    PGSERVICEFILE: path.join(workDir, 'no-service-file'),
  };
  if (t.sslmode !== null) env.PGSSLMODE = t.sslmode;
  env.PGCONNECT_TIMEOUT = '10';
  env.PGAPPNAME = 'r3-a43-s1-p21';
  return {
    command: PSQL_BIN,
    // -X no psqlrc, -q quiet, -w never prompt for a password.
    args: ['-X', '-q', '-w', '-v', 'ON_ERROR_STOP=1', '-f', sqlFile],
    env,
    pgpass: `${[t.host, t.port, t.database, t.user, t.password].map(pgpassField).join(':')}\n`,
  };
}

// Creates the private directory and pass file, runs `fn`, and always removes
// both (also when `fn` throws).
export async function withPsqlInvocation<T>(url: string, sqlFile: string, fn: (invocation: PsqlInvocation) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(path.join(tmpdir(), 'r3-psql-'));
  try {
    const invocation = buildPsqlInvocation(url, sqlFile, dir);
    writeFileSync(invocation.env.PGPASSFILE!, invocation.pgpass, { mode: 0o600, flag: 'wx' });
    return await fn(invocation);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Replaces every credential-bearing component of `url` in `text`.
export function redactConnectionSecrets(text: string, url: string): string {
  let secrets: string[] = [url];
  try {
    const t = parseTarget(url);
    secrets = [url, t.password, encodeURIComponent(t.password), t.user, t.host, t.database];
  } catch {
    // Unparseable URL: still redact the raw string.
  }
  let out = text;
  for (const secret of secrets.filter((s) => s.length > 0).sort((a, b) => b.length - a.length)) {
    out = out.split(secret).join('[redacted]');
  }
  return out;
}

// execFile-compatible signature, injected by the caller so this module never
// spawns anything itself (and a DB-free test can observe the exact call).
export type ExecFileLike = (
  command: string,
  args: readonly string[],
  options: { env: Record<string, string>; timeout: number },
  callback: (error: (Error & { code?: number | string | null }) | null, stdout: string | Buffer, stderr: string | Buffer) => void,
) => unknown;

// Binds psql to ONE verified target url, captured at binding time: later
// changes of the environment (e.g. LOCAL_TEST_DATABASE_URL) can never redirect
// it. Output is redacted for that same url.
export function createBoundPsqlRunner(verifiedUrl: string, exec: ExecFileLike) {
  const url = verifiedUrl;
  buildPsqlInvocation(url, '/dev/null', tmpdir()); // refuse an unusable target at binding time
  return (sqlFile: string): Promise<{ code: number; stderr: string }> =>
    withPsqlInvocation(url, sqlFile, (invocation) => new Promise((resolve) => {
      exec(invocation.command, invocation.args, { env: invocation.env, timeout: 120_000 }, (error, _stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
        resolve({ code, stderr: redactConnectionSecrets(String(stderr), url) });
      });
    }));
}
