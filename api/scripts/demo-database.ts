import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import { Pool, type PoolConfig } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';

type Target = 'demo' | 'test';
type Identity = { host: string; username: string };
type Metadata = {
  db: string;
  username: string;
  address: string | null;
  version: string;
};

// The ignored repository file is the explicit local target configuration. Inherited
// shell URLs cannot redirect a demo reset; tests read it without changing process.env.
export function readDemoTargets() {
  const local = parse(
    readFileSync(new URL('../../.env.development', import.meta.url)),
  );
  const demo = local.DATABASE_URL;
  const test = local.TEST_DATABASE_URL;
  if (!demo || !test || demo === test)
    throw new Error('Distinct local demo/test configuration required');
  parseTarget(demo);
  parseTarget(test);
  return { demo, test };
}

export function parseTarget(raw: string): Identity {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Invalid database target');
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !url.hostname.endsWith('.pooler.supabase.com') ||
    url.port !== '5432' ||
    url.pathname !== '/postgres' ||
    url.search ||
    url.hash ||
    !decodeURIComponent(url.username).startsWith('postgres.') ||
    !url.password
  ) {
    throw new Error(
      'Expected Supabase session target without connection overrides',
    );
  }
  return { host: url.hostname, username: decodeURIComponent(url.username) };
}

export function assertDistinct(
  a: Identity,
  b: Identity,
  x: Metadata,
  y: Metadata,
) {
  const staticDistinct = a.host !== b.host || a.username !== b.username;
  const liveDistinct =
    x.username !== y.username ||
    (x.address !== null && y.address !== null && x.address !== y.address);
  const supported = [x, y].every(
    (m) => Number(m.version.match(/^PostgreSQL (\d+)/)?.[1]) >= 16,
  );
  if (
    !staticDistinct ||
    !liveDistinct ||
    !supported ||
    x.db !== 'postgres' ||
    y.db !== 'postgres'
  ) {
    throw new Error('Database isolation could not be proven; refusing writes');
  }
}

export type SeedDatabase = {
  prisma: PrismaClient;
  pool: Pool;
  targetUrl: string;
  close: () => Promise<void>;
};

export async function openSeedDatabase(target: Target): Promise<SeedDatabase> {
  if (
    target === 'demo' &&
    process.env.NODE_ENV &&
    process.env.NODE_ENV !== 'development'
  ) {
    throw new Error('Demo commands require a development environment');
  }
  if (target === 'test' && process.env.NODE_ENV !== 'test') {
    throw new Error('Test target is available only to automated tests');
  }
  // TEST-H1: TEST is proven by its own marker only; DATABASE_URL is never read.
  if (target === 'test') return openProvenTestDatabase();
  const urls = readDemoTargets();
  if (
    (process.env.DATABASE_URL && process.env.DATABASE_URL !== urls.demo) ||
    (process.env.TEST_DATABASE_URL &&
      process.env.TEST_DATABASE_URL !== urls.test)
  )
    throw new Error(
      'Shell database overrides do not match local demo configuration',
    );

  const ca = readFileSync(
    new URL('../../scripts/certs/supabase-prod-ca-2021.crt', import.meta.url),
    'utf8',
  );
  const pools = [urls.demo, urls.test].map((connectionString) => {
    const pool = new Pool({
      connectionString,
      ssl: { ca, rejectUnauthorized: true },
      max: 1,
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 0,
    });
    pool.on('error', () => {
      /* Never emit credentials from pg errors. Queries fail closed. */
    });
    return pool;
  });
  const demo = pools[0]!;
  const test = pools[1]!;
  try {
    const metadata: Metadata[] = [];
    for (const pool of pools) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN READ ONLY');
        const result =
          await client.query<Metadata>(`SELECT current_database() AS db,
          current_user AS username, host(inet_server_addr()) AS address, version() AS version`);
        metadata.push(result.rows[0]!);
        await client.query('COMMIT');
      } finally {
        client.release();
      }
    }
    assertDistinct(
      parseTarget(urls.demo),
      parseTarget(urls.test),
      metadata[0]!,
      metadata[1]!,
    );
    await test.end();
    const prisma = new PrismaClient({ adapter: new PrismaPg(demo), log: [] });
    return {
      prisma,
      pool: demo,
      targetUrl: urls.demo,
      close: async () => {
        await prisma.$disconnect();
        await demo.end();
      },
    };
  } catch {
    await Promise.allSettled(pools.map((pool) => pool.end()));
    throw new Error(
      'Seed database safety/connection check failed; no writes authorized',
    );
  }
}

// --- TEST-H1: TEST identity from the TEST marker alone ------------------------
// The only runtime proof that a connection is the authorized TEST database is the
// out-of-band marker installed by scripts/database/test-marker.mjs, compared with
// the id pinned in the ignored .env.development. Only TEST_DATABASE_URL and
// TEST_DATABASE_MARKER_ID are looked up; DATABASE_URL (DEV/DEMO) is never read,
// parsed or connected to, and nothing is compared against another database.

export const TEST_GUARD_MESSAGE =
  'Test database safety/connection check failed; no destructive write authorized';

export type TestGuardPhase =
  | 'config'
  | 'connect'
  | 'identity'
  | 'structure'
  | 'mismatch'
  | 'client-create'
  | 'cleanup';

// Carries only secret-free fields: never a message, cause or stack from pg.
export class TestDatabaseGuardError extends Error {
  readonly target = 'TEST';
  constructor(
    readonly phase: TestGuardPhase,
    readonly code: string | undefined,
    readonly elapsedMs: number,
    readonly cleanupFailed: boolean,
  ) {
    super(
      `${TEST_GUARD_MESSAGE} [target=TEST phase=${phase}${code ? ` code=${code}` : ''} elapsedMs=${elapsedMs}${cleanupFailed ? ' cleanupFailed=true' : ''}]`,
    );
    this.name = 'TestDatabaseGuardError';
  }
}

const TEST_MARKER_VAR = 'TEST_DATABASE_MARKER_ID';
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const GUARD_SCHEMA = 'mona_test_guard';
const GUARD_TABLE = 'database_identity';
const QUALIFIED = `${GUARD_SCHEMA}.${GUARD_TABLE}`;

// Node/TLS error codes that describe a connection failure without carrying data.
const SAFE_NODE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

// A SQLSTATE or an allowlisted Node code; anything else (or anything that also
// occurs inside the connection URL) collapses to 'unexpected'. Never a message.
function safeCode(error: unknown, secrets: string[]): string | undefined {
  const code =
    error !== null && typeof error === 'object'
      ? (error as { code?: unknown }).code
      : undefined;
  if (typeof code !== 'string') return undefined;
  if (!/^[0-9A-Z]{5}$/.test(code) && !SAFE_NODE_CODES.has(code))
    return 'unexpected';
  if (secrets.some((secret) => secret.includes(code))) return 'unexpected';
  return code;
}

type TestTarget = { url: string; markerId: string };

// Reads the ignored repository file (inherited shell URLs cannot redirect TEST).
// Well-formedness only; identity is proven by proveTestMarker below.
function readTestTarget(): TestTarget {
  const local = parse(
    readFileSync(new URL('../../.env.development', import.meta.url)),
  );
  const url = local.TEST_DATABASE_URL;
  const markerId = local[TEST_MARKER_VAR];
  if (!url || !markerId || !UUID_V4.test(markerId))
    throw new Error('TEST configuration missing or malformed');
  parseTarget(url);
  return { url, markerId };
}

export function testPoolConfig(url: string, max: number): PoolConfig {
  return {
    connectionString: url,
    ssl: {
      ca: readFileSync(
        new URL('../../scripts/certs/supabase-prod-ca-2021.crt', import.meta.url),
        'utf8',
      ),
      rejectUnauthorized: true,
    },
    max,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 0,
  };
}

// Must stay identical to CANONICAL_MARKER in scripts/database/test-marker.mjs
// (tests/test-db-guard.test.ts cross-checks both verifiers). Any drift fails
// closed: the live marker would then match neither.
const CANONICAL_COLUMNS = [
  { name: 'singleton', type: 'boolean', notNull: true, default: 'true', generated: '', identity: '' },
  { name: 'environment', type: 'text', notNull: true, default: null, generated: '', identity: '' },
  { name: 'marker_id', type: 'uuid', notNull: true, default: null, generated: '', identity: '' },
  { name: 'installed_at', type: 'timestamp with time zone', notNull: true, default: 'now()', generated: '', identity: '' },
];
const CANONICAL_CONSTRAINTS = [
  { type: 'c', definition: "CHECK ((environment = 'test'::text))" },
  { type: 'c', definition: 'CHECK (singleton)' },
  { type: 'p', definition: 'PRIMARY KEY (singleton)' },
];
const CANONICAL_RELATIONS = [
  { name: GUARD_TABLE, kind: 'r' },
  { name: `${GUARD_TABLE}_pkey`, kind: 'i' },
];

// Same statements as the installer's post-install verification, read-only.
const REL = `to_regclass('${QUALIFIED}')`;
const INSPECT_SQL = `SELECT to_regnamespace('${GUARD_SCHEMA}') IS NOT NULL AS schema_exists,
  ${REL} IS NOT NULL AS table_exists`;
// ACCESS SHARE (the strongest mode a READ ONLY transaction may take) blocks
// DROP/ALTER of the marker until COMMIT, so structure and rows describe one table.
const LOCK_SQL = `LOCK TABLE ${QUALIFIED} IN ACCESS SHARE MODE`;
// Must equal MARKER_FACTS_SQL in scripts/database/test-marker.mjs (asserted by
// tests/test-db-guard.test.ts).
export const MARKER_FACTS_SQL = `SELECT json_build_object(
  'schemaOwnerIsCurrentUser', (SELECT pg_get_userbyid(n.nspowner) = current_user
     FROM pg_namespace n WHERE n.nspname = '${GUARD_SCHEMA}'),
  'relations', (SELECT coalesce(json_agg(json_build_object('name', c.relname, 'kind', c.relkind)), '[]'::json)
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = '${GUARD_SCHEMA}'),
  'table', (SELECT json_build_object(
       'kind', c.relkind,
       'ownerIsCurrentUser', pg_get_userbyid(c.relowner) = current_user,
       'rowSecurity', c.relrowsecurity,
       'forceRowSecurity', c.relforcerowsecurity,
       'hasSubclass', c.relhassubclass,
       'parents', (SELECT count(*) FROM pg_inherits i WHERE i.inhrelid = c.oid),
       'children', (SELECT count(*) FROM pg_inherits i WHERE i.inhparent = c.oid),
       'hasRules', c.relhasrules,
       'triggers', (SELECT count(*) FROM pg_trigger t WHERE t.tgrelid = c.oid))
     FROM pg_class c WHERE c.oid = ${REL}),
  'columns', (SELECT coalesce(json_agg(json_build_object(
       'name', a.attname, 'type', format_type(a.atttypid, a.atttypmod), 'notNull', a.attnotnull,
       'default', pg_get_expr(d.adbin, d.adrelid), 'generated', a.attgenerated, 'identity', a.attidentity)
       ORDER BY a.attnum), '[]'::json)
     FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE a.attrelid = ${REL} AND a.attnum > 0 AND NOT a.attisdropped),
  'constraints', (SELECT coalesce(json_agg(json_build_object('type', con.contype, 'definition', pg_get_constraintdef(con.oid))), '[]'::json)
     FROM pg_constraint con WHERE con.conrelid = ${REL} AND con.contype <> 'n')
) AS facts`;
const ROWS_SQL = `SELECT environment, marker_id::text AS marker_id, installed_at IS NOT NULL AS has_installed_at FROM ${QUALIFIED}`;

const sortKey = (entry: unknown) => JSON.stringify(entry);
function sameSet(actual: unknown, expected: unknown[]): boolean {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  const a = actual.map(sortKey).sort();
  const e = expected.map(sortKey).sort();
  return a.every((value, i) => value === e[i]);
}
function columnKey(column: unknown): string {
  if (column === null || typeof column !== 'object') return '';
  const c = column as Record<string, unknown>;
  return sortKey({
    name: c.name,
    type: c.type,
    notNull: c.notNull,
    default: c.default ?? null,
    generated: c.generated,
    identity: c.identity,
  });
}

// Null when the catalog facts are exactly the canonical marker. A table that
// merely has the right row (a view, extra/retyped columns, a missing CHECK or
// key, RLS, rules, triggers, an inheritance parent or child, a foreign owner,
// extra relations) fails.
export function verifyTestMarkerFacts(facts: unknown): string | null {
  if (facts === null || typeof facts !== 'object') return 'unreadable';
  const f = facts as Record<string, unknown>;
  if (f.schemaOwnerIsCurrentUser !== true) return 'schema owner';
  const table = f.table as Record<string, unknown> | null;
  if (table === null || typeof table !== 'object') return 'table missing';
  if (table.kind !== 'r' || table.ownerIsCurrentUser !== true) return 'table';
  if (table.rowSecurity !== false || table.forceRowSecurity !== false)
    return 'row security';
  if (
    table.hasSubclass !== false ||
    table.hasRules !== false ||
    table.triggers !== 0
  )
    return 'children, rules or triggers';
  // pg_inherits in both directions: neither a child (INHERITS or partition, any
  // parent schema/name/count) nor a parent. Only the number 0 is accepted.
  if (table.parents !== 0 || table.children !== 0) return 'inheritance';
  const columns = Array.isArray(f.columns) ? f.columns : [];
  if (
    columns.length !== CANONICAL_COLUMNS.length ||
    !columns.every((c, i) => columnKey(c) === columnKey(CANONICAL_COLUMNS[i]))
  )
    return 'columns';
  if (!sameSet(f.constraints, CANONICAL_CONSTRAINTS)) return 'constraints';
  if (!sameSet(f.relations, CANONICAL_RELATIONS)) return 'relations';
  return null;
}

type GuardClient = {
  query: (text: string) => Promise<{ rows: Array<Record<string, unknown>> }>;
};
class PhaseFailure {
  constructor(readonly phase: TestGuardPhase) {}
}

// Runs inside one READ ONLY transaction with search_path pinned to pg_catalog,
// so no user-defined function/operator/type can be resolved by the proof.
async function proveTestMarker(
  client: GuardClient,
  markerId: string,
  setPhase: (phase: TestGuardPhase) => void,
): Promise<void> {
  setPhase('identity');
  await client.query('BEGIN READ ONLY');
  await client.query('SET LOCAL search_path TO pg_catalog, pg_temp');
  const inspect = (await client.query(INSPECT_SQL)).rows[0];
  if (inspect?.schema_exists !== true || inspect?.table_exists !== true)
    throw new PhaseFailure('identity');
  await client.query(LOCK_SQL);
  setPhase('structure');
  const facts = (await client.query(MARKER_FACTS_SQL)).rows[0]?.facts ?? null;
  if (verifyTestMarkerFacts(facts) !== null) throw new PhaseFailure('structure');
  setPhase('identity');
  const { rows } = await client.query(ROWS_SQL);
  if (rows.length !== 1) throw new PhaseFailure('identity');
  const [row] = rows;
  if (row?.environment !== 'test' || row?.has_installed_at !== true)
    throw new PhaseFailure('identity');
  if (row.marker_id !== markerId) throw new PhaseFailure('mismatch');
  await client.query('COMMIT');
}

// Opens a TEST pool and proves the marker on it. On success the caller owns the
// returned pool; on any failure the pool is closed here and a sanitized
// TestDatabaseGuardError is thrown.
export async function openProvenTestPool(
  max: number,
): Promise<{ pool: Pool; target: TestTarget; fail: FailFn }> {
  const started = Date.now();
  let secrets: string[] = [];
  const fail: FailFn = (phase, error, cleanupFailed = false) =>
    new TestDatabaseGuardError(
      phase,
      error instanceof PhaseFailure ? undefined : safeCode(error, secrets),
      Date.now() - started,
      cleanupFailed,
    );
  let target: TestTarget;
  try {
    target = readTestTarget();
  } catch {
    throw fail('config', undefined);
  }
  secrets = [target.url];
  let phase: TestGuardPhase = 'connect';
  let pool: Pool;
  try {
    pool = new Pool(testPoolConfig(target.url, max));
    pool.on('error', () => {
      /* Never emit credentials from pg errors. Queries fail closed. */
    });
  } catch (error) {
    throw fail('connect', error);
  }
  try {
    const client = await pool.connect();
    let released = false;
    try {
      await proveTestMarker(client, target.markerId, (next) => (phase = next));
    } catch (error) {
      // Mid-transaction: destroy the connection instead of reusing it.
      client.release(true);
      released = true;
      throw error;
    } finally {
      if (!released) client.release();
    }
  } catch (error) {
    const reported = error instanceof PhaseFailure ? error.phase : phase;
    const cleanupFailed = await pool.end().then(
      () => false,
      () => true,
    );
    throw fail(reported, error, cleanupFailed);
  }
  return { pool, target, fail };
}

type FailFn = (
  phase: TestGuardPhase,
  error: unknown,
  cleanupFailed?: boolean,
) => TestDatabaseGuardError;

// openSeedDatabase('test'): this helper owns the pool (seed tests query it
// directly), Prisma only borrows it; close() is idempotent and ends it once.
async function openProvenTestDatabase(): Promise<SeedDatabase> {
  const { pool, target, fail } = await openProvenTestPool(1);
  let prisma: PrismaClient;
  try {
    prisma = new PrismaClient({ adapter: new PrismaPg(pool), log: [] });
  } catch (error) {
    const cleanupFailed = await pool.end().then(
      () => false,
      () => true,
    );
    throw fail('client-create', error, cleanupFailed);
  }
  let closing: Promise<void> | null = null;
  return {
    prisma,
    pool,
    targetUrl: target.url,
    close: () =>
      (closing ??= (async () => {
        try {
          await prisma.$disconnect();
        } finally {
          await pool.end();
        }
      })()),
  };
}
