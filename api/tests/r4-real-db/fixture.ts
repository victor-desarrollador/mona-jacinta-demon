import { spawn } from 'node:child_process';
import type { Pool, PoolClient } from 'pg';
import { openProvenLocalTestPool, openProvenLocalTestPrisma, proveIdentityOnTransaction } from '../../scripts/demo-database.js';
import { proveDomainOnTransaction, proveSettingsOnTransaction, readStateOnTransaction, type ProtectedTx } from '../../scripts/local-test-fingerprint.js';
import { protectTx, type ProtectedSteps } from '../../scripts/local-test-runtime.js';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { CANARY_PREFIX } from './evidence.js';
import { LOCAL_MARKER_VAR, LOCAL_URL_VAR } from './gate.js';

export const MIGRATION_5 = '20261002120000_block1_pricing_wholesale';
export const PG_DUMP = '/usr/lib/postgresql/17/bin/pg_dump';
export const PG_RESTORE_LIST_ONLY = '/usr/lib/postgresql/17/bin/pg_restore';

export type Target = Readonly<{
  prisma: PrismaClient;
  pool: Pool;
  markerId: string;
  url: URL;
  close: () => Promise<void>;
}>;

// Opens the target ONLY through the repository's in-process LOCAL_TEST guards (marker proof on both the pool and the
// Prisma client). Only the two LOCAL_TEST variables handed in by the gate are ever used.
export async function openTarget(env: Readonly<Record<string, string | undefined>>): Promise<Target> {
  const source = { [LOCAL_URL_VAR]: env[LOCAL_URL_VAR] as string, [LOCAL_MARKER_VAR]: env[LOCAL_MARKER_VAR] as string } as NodeJS.ProcessEnv;
  const { pool } = await openProvenLocalTestPool(4, source);
  let proven;
  try {
    proven = await openProvenLocalTestPrisma(source);
  } catch (error) {
    await pool.end();
    throw error;
  }
  return {
    prisma: proven.prisma,
    pool,
    markerId: source[LOCAL_MARKER_VAR] as string,
    url: new URL(source[LOCAL_URL_VAR] as string),
    close: async () => {
      await proven.close();
      await pool.end();
    },
  };
}

// Without migration 5 the protected contract cannot hold: fail loudly, never skip.
export async function requireMigration5(pool: Pool): Promise<void> {
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM public."_prisma_migrations" WHERE migration_name = $1 AND finished_at IS NOT NULL AND rolled_back_at IS NULL', [MIGRATION_5]);
  if (rows[0]?.n !== 1) throw new Error(`BLOCKED_MIGRATION_5: ${MIGRATION_5} is not applied on the proven LOCAL_TEST target`);
}

// The real in-transaction steps (the ones the runtime wires), with the destructive ones replaced by inert stand-ins.
export function harnessSteps(markerId: string, overrides: Partial<ProtectedSteps> = {}): ProtectedSteps {
  return {
    proveIdentity: (tx) => proveIdentityOnTransaction(tx, markerId),
    assertSettings: (tx, profile) => proveSettingsOnTransaction(tx, profile),
    proveDomain: (tx) => proveDomainOnTransaction(tx),
    classify: async () => {
      throw new Error('classify is not wired in this proof');
    },
    readState: (tx, sinks, keepRows) => readStateOnTransaction(tx, sinks, keepRows),
    seed: async () => undefined,
    verifyTransformation: () => undefined,
    ...overrides,
  };
}

export function classifySequence(...labels: string[]): ProtectedSteps['classify'] {
  let i = 0;
  return async () => {
    const label = labels[Math.min(i, labels.length - 1)] as string;
    i += 1;
    return label;
  };
}

type Reader = { $queryRawUnsafe: (sql: string) => Promise<unknown[]> };
export const rawOf = (tx: ProtectedTx): Reader => tx as unknown as Reader;

export async function backendPid(tx: ProtectedTx): Promise<number> {
  const rows = (await rawOf(tx).$queryRawUnsafe('SELECT pg_catalog.pg_backend_pid() AS pid')) as { pid: number }[];
  return Number(rows[0]?.pid);
}

// Wraps every step so that it first records the backend pid of the protected transaction.
export function withPidProbe(steps: ProtectedSteps, pids: number[]): ProtectedSteps {
  const probe = async (tx: ProtectedTx) => {
    pids.push(await backendPid(tx));
  };
  return {
    proveIdentity: async (tx) => { await probe(tx); return steps.proveIdentity(tx); },
    assertSettings: async (tx, p) => { await probe(tx); return steps.assertSettings(tx, p); },
    proveDomain: async (tx) => { await probe(tx); return steps.proveDomain(tx); },
    classify: async (tx) => { await probe(tx); return steps.classify(tx); },
    readState: async (tx, s, k) => { await probe(tx); return steps.readState(tx, s, k); },
    seed: async (tx, h) => { await probe(tx); return steps.seed(tx, h); },
    verifyTransformation: (pre, post) => steps.verifyTransformation(pre, post),
  };
}

// A protected-capability view over a plain pg client (so the REAL step functions run against a real session).
export function clientAsTx(client: PoolClient): ProtectedTx {
  const raw = {
    $queryRawUnsafe: async (sql: string) => (await client.query(sql)).rows,
    $executeRawUnsafe: async (sql: string) => (await client.query(sql)).rowCount ?? 0,
  };
  return protectTx(raw, { id: 'r4-harness', phase: 'locked', statements: [] });
}

// The owner's fixed setup block (local-test-runtime.ts OWNER_SETUP) replayed on a plain session for the settings proofs.
export const OWNER_SETUP_REPLAY = Object.freeze([
  'SET LOCAL search_path = pg_catalog, pg_temp',
  "SET LOCAL lock_timeout = '10s'",
  "SET LOCAL statement_timeout = '120s'",
  "SET LOCAL idle_in_transaction_session_timeout = '180s'",
  'SET LOCAL synchronous_commit = on',
  "SET LOCAL timezone = 'UTC'",
]);

export async function inRolledBackTx<T>(pool: Pool, body: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    return await body(client);
  } finally {
    try {
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  }
}

// A competing session: runs `sql` with a short lock_timeout; returns the SQLSTATE (or 'ok') and the session's backend pid.
export async function competingAttempt(pool: Pool, sql: string): Promise<{ outcome: string; pid: number }> {
  const client = await pool.connect();
  try {
    const pid = Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid);
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '1500ms'");
    try {
      await client.query(sql);
      return { outcome: 'ok', pid };
    } catch (error) {
      return { outcome: String((error as { code?: unknown }).code ?? 'error'), pid };
    }
  } finally {
    try {
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  }
}

export async function insertCanary(pool: Pool, id: string): Promise<void> {
  if (!id.startsWith(CANARY_PREFIX)) throw new Error('refusing a non-canary id');
  await pool.query('INSERT INTO public."Brand" (id, name) VALUES ($1, $1)', [id]);
}

// The single DELETE of the harness: synthetic canaries only (id prefix bound), never any other row.
export async function removeCanary(pool: Pool, id: string): Promise<void> {
  if (!id.startsWith(CANARY_PREFIX)) throw new Error('refusing a non-canary id');
  await pool.query(`DELETE FROM public."Brand" WHERE id = $1 AND id LIKE '${CANARY_PREFIX}%'`, [id]);
}

export async function sweepCanaries(pool: Pool): Promise<void> {
  await pool.query(`DELETE FROM public."Brand" WHERE id LIKE '${CANARY_PREFIX}%'`);
}

export function pgChildEnv(url: URL): NodeJS.ProcessEnv {
  return { PATH: '/usr/lib/postgresql/17/bin:/usr/bin:/bin', HOME: process.env.HOME, LC_ALL: 'C', PGPASSWORD: decodeURIComponent(url.password) };
}

export const pgConnArgs = (url: URL): string[] => [
  `--host=${url.hostname}`,
  `--port=${url.port}`,
  `--username=${decodeURIComponent(url.username)}`,
  `--dbname=${decodeURIComponent(url.pathname.slice(1))}`,
  '--no-password',
];

export function runTool(bin: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: Buffer; stderrBytes: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let err = 0;
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => { err += chunk.length; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout: Buffer.concat(out), stderrBytes: err }));
  });
}
