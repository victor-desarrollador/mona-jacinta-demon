import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parse } from 'dotenv';
import { Pool, type ClientConfig, type PoolClient, type PoolConfig } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import {
  LOCAL_TEST_LIVE_FACTS_SQL,
  LOCAL_TEST_MARKER_FACTS_SQL,
  LOCAL_TEST_MARKER_SQL,
  readProtectedRows,
  type ProtectedTx,
} from './local-test-fingerprint.js';

export const AUTOMATED_TEST_TARGET_VAR = 'MONA_TEST_DATABASE_TARGET';
export type AutomatedTestTarget = 'test' | 'local';

export const LOCAL_TEST_URL_VAR = 'LOCAL_TEST_DATABASE_URL';
export const LOCAL_TEST_MARKER_VAR = 'LOCAL_TEST_DATABASE_MARKER_ID';

export type LocalTestTarget = {
  url: string;
  markerId: string;
};

const LOCAL_TEST_HOST = '127.0.0.1';
const LOCAL_TEST_PORT = '5432';
const LOCAL_TEST_DATABASE = 'mona_local_test';
const LOCAL_TEST_USERNAME = 'mona_local_test';
const LOCAL_TEST_MARKER_UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function readLocalTestTarget(
  source: NodeJS.ProcessEnv = process.env,
): LocalTestTarget {
  const raw = source[LOCAL_TEST_URL_VAR];
  if (!raw) {
    throw new Error(`${LOCAL_TEST_URL_VAR} is required`);
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${LOCAL_TEST_URL_VAR} must be a valid PostgreSQL URL`);
  }

  // The raw value must already be the canonical text: the URL parser trims,
  // drops tab/LF/CR, lowercases the scheme and normalizes the port, so a check
  // on the parse alone would accept a different string than the one returned.
  // Same rule as prisma.local-test.config.ts.
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    url.hostname !== LOCAL_TEST_HOST ||
    url.port !== LOCAL_TEST_PORT ||
    url.pathname !== `/${LOCAL_TEST_DATABASE}` ||
    decodeURIComponent(url.username) !== LOCAL_TEST_USERNAME ||
    !url.password ||
    url.search !== '' ||
    url.hash !== '' ||
    raw !==
      `${url.protocol}//${LOCAL_TEST_USERNAME}:${url.password}@${LOCAL_TEST_HOST}:${LOCAL_TEST_PORT}/${LOCAL_TEST_DATABASE}`
  ) {
    throw new Error(
      `${LOCAL_TEST_URL_VAR} must target the dedicated LOCAL_TEST loopback database`,
    );
  }

  const markerId = source[LOCAL_TEST_MARKER_VAR];
  if (!markerId || !LOCAL_TEST_MARKER_UUID_V4.test(markerId)) {
    throw new Error(
      `${LOCAL_TEST_MARKER_VAR} must be a canonical lowercase version-4 UUID`,
    );
  }

  return { url: raw, markerId };
}

export type LocalTestIdentityFacts = {
  currentDatabase: string;
  currentUser: string;
  version: string;
  markerRows: Array<{
    environment: string;
    markerId: string;
    hasInstalledAt: boolean;
  }>;
};

const LOCAL_TEST_MIN_PG_MAJOR = 17;
const LOCAL_TEST_IDENTITY_REFUSAL =
  'LOCAL_TEST identity could not be proven; refusing destructive writes';

export function assertLocalTestIdentityFacts(
  facts: LocalTestIdentityFacts,
  expectedMarkerId: string,
): void {
  const fail = () => {
    throw new Error(LOCAL_TEST_IDENTITY_REFUSAL);
  };

  if (!LOCAL_TEST_MARKER_UUID_V4.test(expectedMarkerId)) fail();

  const versionMatch = facts.version.match(/^PostgreSQL\s+(\d+)/i);
  const major = versionMatch ? Number(versionMatch[1]) : Number.NaN;

  if (
    facts.currentDatabase !== LOCAL_TEST_DATABASE ||
    facts.currentUser !== LOCAL_TEST_USERNAME ||
    !Number.isInteger(major) ||
    major < LOCAL_TEST_MIN_PG_MAJOR ||
    facts.markerRows.length !== 1
  ) {
    fail();
  }

  const marker = facts.markerRows[0];

  if (
    marker?.environment !== 'local_test' ||
    marker.markerId !== expectedMarkerId ||
    marker.hasInstalledAt !== true
  ) {
    fail();
  }
}

export type LocalTestGuardClient = {
  query: (
    text: string,
  ) => Promise<{ rows: Array<Record<string, unknown>> }>;
};

// Task 4 (LTP1): the proof SQL and canonical marker definition are TS-local
// copies of scripts/database/local-test-marker.mjs (the installer), which the
// runtime never imports; tests/test-db-guard.test.ts pins them byte-for-byte and
// behaviorally to the installer.
const LOCAL_GUARD_SCHEMA = 'mona_local_test_guard';
const LOCAL_GUARD_TABLE = 'database_identity';
const LOCAL_QUALIFIED = `${LOCAL_GUARD_SCHEMA}.${LOCAL_GUARD_TABLE}`;
// ACCESS SHARE (the strongest mode a READ ONLY transaction may take) blocks
// DROP/ALTER of the marker; taken before the first snapshot-taking SELECT so the
// REPEATABLE READ snapshot postdates it.
const LOCAL_TEST_LOCK_SQL = `LOCK TABLE ${LOCAL_QUALIFIED} IN ACCESS SHARE MODE`;

const LOCAL_TEST_CANONICAL_COLUMNS = [
  { name: 'singleton', type: 'boolean', notNull: true, default: 'true', generated: '', identity: '', collation: null },
  { name: 'environment', type: 'text', notNull: true, default: null, generated: '', identity: '', collation: 'default' },
  { name: 'marker_id', type: 'uuid', notNull: true, default: null, generated: '', identity: '', collation: null },
  { name: 'installed_at', type: 'timestamp with time zone', notNull: true, default: 'now()', generated: '', identity: '', collation: null },
];
const LOCAL_TEST_CANONICAL_CONSTRAINTS = [
  { type: 'c', definition: "CHECK ((environment = 'local_test'::text))" },
  { type: 'c', definition: 'CHECK (singleton)' },
  { type: 'p', definition: 'PRIMARY KEY (singleton)' },
];
const LOCAL_TEST_CANONICAL_RELATIONS = [
  { name: LOCAL_GUARD_TABLE, kind: 'r' },
  { name: `${LOCAL_GUARD_TABLE}_pkey`, kind: 'i' },
];

const isLocalObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const localSortKey = (entry: unknown) => JSON.stringify(entry);
const localSameSet = (actual: unknown, expected: readonly unknown[]) => {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  const a = actual.map(localSortKey).sort();
  const e = expected.map(localSortKey).sort();
  return a.every((value, i) => value === e[i]);
};
const localCanonicalColumn = (column: unknown) => {
  if (!isLocalObject(column)) return {};
  const { name, type, notNull, default: def, generated, identity, collation } = column;
  return { name, type, notNull, default: def ?? null, generated, identity, collation };
};

// Same acceptance as the installer's verifyMarkerStructure: null only for the
// exact canonical marker (schema and table owned by current_user; an ordinary,
// logged, untyped table without RLS, rules, triggers, inheritance or
// partitioning; exact columns, constraints and relations). Any missing,
// null or wrongly typed fact is a mismatch, never coerced.
export function verifyLocalTestMarkerStructure(facts: unknown): string | null {
  if (!isLocalObject(facts)) return 'marker structure could not be read';
  if (facts.schemaOwnerIsCurrentUser !== true) return 'marker schema is not owned by the connected role';
  const t = facts.table;
  if (!isLocalObject(t)) return 'marker table is missing';
  if (t.kind !== 'r' || t.persistence !== 'p' || t.ofType !== false) return 'marker relation is not an ordinary, logged, untyped table';
  if (t.ownerIsCurrentUser !== true) return 'marker table is not owned by the connected role';
  if (t.rowSecurity !== false || t.forceRowSecurity !== false) return 'marker table has row-level security';
  if (t.hasRules !== false || t.triggers !== 0) return 'marker table has rules or triggers';
  if (t.isPartition !== false || t.hasSubclass !== false || t.parents !== 0 || t.children !== 0) {
    return 'marker table takes part in inheritance or partitioning';
  }
  const columns = Array.isArray(facts.columns) ? facts.columns : [];
  const columnsMatch =
    columns.length === LOCAL_TEST_CANONICAL_COLUMNS.length &&
    columns.every((column, i) => localSortKey(localCanonicalColumn(column)) === localSortKey(LOCAL_TEST_CANONICAL_COLUMNS[i]));
  if (!columnsMatch) return 'marker columns do not match the canonical definition';
  if (!localSameSet(facts.constraints, LOCAL_TEST_CANONICAL_CONSTRAINTS)) return 'marker constraints do not match the canonical definition';
  if (!localSameSet(facts.relations, LOCAL_TEST_CANONICAL_RELATIONS)) return 'marker schema holds unexpected relations';
  return null;
}

// Non-strings become '' so they fail the identity checks instead of throwing.
const asText = (value: unknown) => (typeof value === 'string' ? value : '');

// Proves LOCAL_TEST identity on the given connection inside one REPEATABLE READ
// READ ONLY transaction with search_path pinned to pg_catalog: ACCESS SHARE on the
// marker first, then live facts (database, user, PostgreSQL 17+, no TEST/PILOT
// marker schema), canonical marker structure and ownership, and the exact marker
// row, all from one snapshot. Nothing is ever written. Any failure after BEGIN
// attempts ROLLBACK and surfaces only the sanitized refusal: query errors may
// carry connection details, and a failed ROLLBACK must not mask the refusal.
type IdentityRows = Array<Record<string, unknown>>;

// The verification shared by the connection-level proof and the in-transaction proof: live facts, canonical marker
// structure and ownership, and the exact marker row. Throws only the constant refusal.
function assertLocalTestIdentityRows(metadata: IdentityRows, structure: IdentityRows, markers: IdentityRows, expectedMarkerId: string): void {
  if (metadata.length !== 1) throw new Error(LOCAL_TEST_IDENTITY_REFUSAL);
  const [meta] = metadata;
  if (meta?.test_guard_exists !== false || meta?.pilot_guard_exists !== false) {
    throw new Error(LOCAL_TEST_IDENTITY_REFUSAL);
  }
  if (structure.length !== 1 || verifyLocalTestMarkerStructure(structure[0]?.facts) !== null) {
    throw new Error(LOCAL_TEST_IDENTITY_REFUSAL);
  }
  assertLocalTestIdentityFacts(
    {
      currentDatabase: asText(meta?.current_database),
      currentUser: asText(meta?.current_user),
      version: asText(meta?.version),
      markerRows: markers.map((row) => ({
        environment: asText(row.environment),
        markerId: asText(row.marker_id),
        hasInstalledAt: row.has_installed_at === true,
      })),
    },
    expectedMarkerId,
  );
}

export async function proveLocalTestIdentity(
  client: LocalTestGuardClient,
  expectedMarkerId: string,
): Promise<void> {
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query('SET LOCAL search_path TO pg_catalog, pg_temp');
    await client.query(LOCAL_TEST_LOCK_SQL);

    const metadata = (await client.query(LOCAL_TEST_LIVE_FACTS_SQL)).rows;
    const structure = (await client.query(LOCAL_TEST_MARKER_FACTS_SQL)).rows;
    const markers = (await client.query(LOCAL_TEST_MARKER_SQL)).rows;
    assertLocalTestIdentityRows(metadata, structure, markers, expectedMarkerId);

    await client.query('COMMIT');
  } catch {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* The refusal below is the outcome either way. */
    }
    throw new Error(LOCAL_TEST_IDENTITY_REFUSAL);
  }
}

// R4: the same proof on a SUPPLIED protected transaction. It issues SELECTs only — never BEGIN, COMMIT, ROLLBACK, SET
// or LOCK — because the transaction (isolation, search_path, locks) belongs to its owner (local-test-runtime.ts): the
// connection-level wrapper above would COMMIT the protected transaction early. Any failure is the constant refusal;
// the owner rolls back. The marker structure facts are accepted as an object or as a JSON string (adapter-dependent).
export async function proveIdentityOnTransaction(tx: ProtectedTx, expectedMarkerId: string): Promise<void> {
  try {
    const metadata = await readProtectedRows(tx, { kind: 'identity', query: 'liveFacts' }) as IdentityRows;
    const structure = (await readProtectedRows(tx, { kind: 'identity', query: 'markerFacts' })).map((row) => ({
      ...row,
      facts: typeof row.facts === 'string' ? (JSON.parse(row.facts) as unknown) : row.facts,
    }));
    const markers = await readProtectedRows(tx, { kind: 'identity', query: 'markerRows' }) as IdentityRows;
    assertLocalTestIdentityRows(metadata, structure, markers, expectedMarkerId);
  } catch {
    throw new Error(LOCAL_TEST_IDENTITY_REFUSAL);
  }
}

// Hosted TEST remains the default. LOCAL_TEST is opt-in only through the exact
// selector value. Any other explicit value fails closed rather than silently
// choosing another database target.
export function resolveAutomatedTestTarget(
  source: NodeJS.ProcessEnv = process.env,
): AutomatedTestTarget {
  const value = source[AUTOMATED_TEST_TARGET_VAR];

  if (value === undefined || value === 'test') return 'test';
  if (value === 'local') return 'local';

  throw new Error(
    `${AUTOMATED_TEST_TARGET_VAR} must be exactly "test" or "local" when set`,
  );
}
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

export type SeedDatabaseTarget =
  | 'demo'
  | 'test'
  | 'local-test'
  | 'automated-test';

// Task 4: 'demo', 'test' and 'local-test' are explicit and never consult the
// selector; `source` pins only the LOCAL_TEST configuration. 'automated-test'
// resolves the selector from `source` exactly once and delegates to the explicit
// branch, inheriting its guards. Any other runtime value fails closed before any
// configuration is read or connection is opened: there is no default branch.
export async function openSeedDatabase(
  target: SeedDatabaseTarget,
  source: NodeJS.ProcessEnv = process.env,
): Promise<SeedDatabase> {
  switch (target) {
    case 'automated-test':
      return openSeedDatabase(
        resolveAutomatedTestTarget(source) === 'local' ? 'local-test' : 'test',
        source,
      );
    case 'test':
      if (process.env.NODE_ENV !== 'test') {
        throw new Error('Test target is available only to automated tests');
      }
      // TEST-H1: TEST is proven by its own marker only; DATABASE_URL is never read.
      return openProvenTestDatabase();
    case 'local-test':
      return openProvenLocalTestDatabase(source);
    case 'demo':
      if (process.env.NODE_ENV && process.env.NODE_ENV !== 'development') {
        throw new Error('Demo commands require a development environment');
      }
      return openDemoDatabase();
    default:
      throw new Error(
        'Unknown seed database target; no database connection attempted',
      );
  }
}

async function openDemoDatabase(): Promise<SeedDatabase> {
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

type LocalTestGuardPhase =
  | 'config'
  | 'connect'
  | 'identity'
  | 'client-create'
  | 'cleanup';

// LOCAL_TEST PGOPTIONS policy (parity with scripts/database/local-test-marker.mjs):
// PGOPTIONS must be absent, by presence (so '' refuses too), in the pinned
// `source` and in process.env. pg reads process.env.PGOPTIONS whenever it builds
// a Client, and a falsy config.options never overrides it, so the check runs at
// every LOCAL_TEST boundary instead of once. The value is never echoed.
const LOCAL_TEST_PGOPTIONS_REFUSAL = `${LOCAL_TEST_IDENTITY_REFUSAL} [target=LOCAL_TEST phase=config]`;

function assertNoLocalTestPgOptions(source?: NodeJS.ProcessEnv): void {
  if (source?.PGOPTIONS !== undefined || process.env.PGOPTIONS !== undefined) {
    throw new Error(LOCAL_TEST_PGOPTIONS_REFUSAL);
  }
}

// pg is CommonJS and its ESM entry re-exports this same lib/index.js instance,
// so PgClient is the Client that `import ... from 'pg'` exposes. It is loaded
// through require because the DB-free guard tests replace the ESM 'pg' import
// with a Pool-only fake, while this per-connection guard must wrap the real one.
const { Client: PgClient } = createRequire(import.meta.url)('pg') as typeof import('pg');

// Every LOCAL_TEST pool (the proof pool, the PrismaPg adapter's lazy pool and
// each reconnect) builds its connections through this class; pg-pool honours
// `config.Client`. The policy is checked before super(), i.e. before pg's
// ConnectionParameters can read PGOPTIONS.
class LocalTestClient extends PgClient {
  constructor(config?: string | ClientConfig) {
    assertNoLocalTestPgOptions();
    super(config);
  }
}

// Loopback only (readLocalTestTarget pins 127.0.0.1): no Supabase CA, and an
// explicit ssl:false so a shell PGSSLMODE cannot change the transport.
export function localTestPoolConfig(url: string, max: number): PoolConfig {
  assertNoLocalTestPgOptions();
  return {
    Client: LocalTestClient,
    connectionString: url,
    ssl: false,
    max,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 0,
  };
}

// LOCAL_TEST counterpart of openProvenTestPool: validates configuration before
// building any pool, then proves identity on one dedicated connection. On
// success the caller owns the returned pool; on any failure the pool is closed
// here and only a phase-tagged refusal is thrown (never a pg message or URL).
export async function openProvenLocalTestPool(
  max: number,
  source: NodeJS.ProcessEnv = process.env,
): Promise<{
  pool: Pool;
  target: LocalTestTarget;
  fail: (phase: LocalTestGuardPhase) => Error;
}> {
  const fail = (phase: LocalTestGuardPhase) =>
    new Error(
      `${LOCAL_TEST_IDENTITY_REFUSAL} [target=LOCAL_TEST phase=${phase}]`,
    );
  let target: LocalTestTarget;
  try {
    assertNoLocalTestPgOptions(source);
    target = readLocalTestTarget(source);
  } catch {
    throw fail('config');
  }
  let pool: Pool;
  try {
    pool = new Pool(localTestPoolConfig(target.url, max));
    pool.on('error', () => {
      /* Never emit credentials from pg errors. Queries fail closed. */
    });
  } catch {
    throw fail('connect');
  }
  let phase: LocalTestGuardPhase = 'connect';
  try {
    const client = await pool.connect();
    phase = 'identity';
    try {
      await proveLocalTestIdentity(client, target.markerId);
    } catch (error) {
      // Possibly mid-transaction: destroy the connection instead of reusing it.
      client.release(true);
      throw error;
    }
    client.release();
  } catch {
    await pool.end().catch(() => undefined);
    throw fail(phase);
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

// The one LOCAL_TEST Prisma lifecycle: proves identity on a fresh max-1 pool
// (openProvenLocalTestPool; its proof client is released before it returns),
// then builds PrismaPg on that exact pg.Pool — never on a config, which would
// make the adapter build a second, unproven pool — and PrismaClient on that
// adapter. The adapter only borrows the pool (no disposeExternalPool): close()
// disconnects Prisma, then ends the pool, once. Re-proof checks out a client of
// the same pool and proves again; a failed proof destroys that client. Any
// construction failure ends the proven pool before the sanitized refusal.
async function openProvenLocalTestLifecycle(source: NodeJS.ProcessEnv) {
  const { pool, target, fail } = await openProvenLocalTestPool(1, source);
  let prisma: PrismaClient;
  try {
    // R4: the adapter reports schema `public`, so Prisma qualifies every relation and enum cast as "public"."X"; the
    // protected search_path is `pg_catalog, pg_temp` (public omitted), so an unqualified reference fails closed. `log: []`
    // keeps query/parameter logging off (protected rows can appear in parameters).
    prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema: 'public' }), log: [] });
  } catch {
    await pool.end().catch(() => undefined);
    throw fail('client-create');
  }
  let closing: Promise<void> | null = null;
  const close = () =>
    (closing ??= (async () => {
      try {
        await prisma.$disconnect();
      } finally {
        await pool.end();
      }
    })());
  const proveIdentity = async () => {
    // A connection opened for this proof must also refuse PGOPTIONS; checked
    // here too because an idle, already-proven connection is reused as is.
    try {
      assertNoLocalTestPgOptions(source);
    } catch {
      throw fail('config');
    }
    let client: PoolClient;
    try {
      client = await pool.connect();
    } catch {
      throw fail('connect');
    }
    try {
      await proveLocalTestIdentity(client, target.markerId);
    } catch {
      // Possibly mid-transaction: destroy the connection instead of reusing it.
      client.release(true);
      throw fail('identity');
    }
    client.release();
  };
  return { prisma, pool, target, close, proveIdentity };
}

export type ProvenLocalTestPrisma = {
  prisma: PrismaClient;
  proveIdentity: () => Promise<void>;
  close: () => Promise<void>;
};

// Task 4: the LOCAL_TEST prepare runtime's opener. Explicit source only (no
// process.env fallback for the target) and no NODE_ENV gate: it can reach only
// the canonical LOCAL_TEST loopback database, proven by its marker. The pool is
// never handed out; the caller owns it only through close().
export async function openProvenLocalTestPrisma(
  source: NodeJS.ProcessEnv,
): Promise<ProvenLocalTestPrisma> {
  const { prisma, proveIdentity, close } = await openProvenLocalTestLifecycle(source);
  return { prisma, proveIdentity, close };
}

// openSeedDatabase('local-test'): LOCAL_TEST counterpart of openProvenTestDatabase.
// `source` lets the caller pin the configuration it resolved once, so a later
// call cannot be redirected by a changed process.env. Prisma borrows the pool
// the identity was proven on; close() is idempotent and ends it once.
async function openProvenLocalTestDatabase(
  source: NodeJS.ProcessEnv = process.env,
): Promise<SeedDatabase> {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('Test target is available only to automated tests');
  }
  const { prisma, pool, target, close } = await openProvenLocalTestLifecycle(source);
  return { prisma, pool, targetUrl: target.url, close };
}
