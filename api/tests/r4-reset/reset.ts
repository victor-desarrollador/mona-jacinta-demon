// TEST-ONLY destructive reset of the canonical disposable LOCAL_TEST (V2.3.3 R4 real-DB proofs).
// One transaction on ONE proven connection: lock the marker, re-prove identity on that very transaction, pre-check, drop only
// whitelisted objects of schema public, post-check, re-prove, COMMIT. The guard schema is never touched; DDL is transactional,
// so any failure leaves the database exactly as it was.
import { readLocalTestTarget } from '../../scripts/demo-database.js';
import { APPLICATION_TABLES } from '../../scripts/local-test-baseline.js';

export const RESET_TOKEN_VAR = 'MONA_R4_RESET_LOCAL_TEST';
export const RESET_TOKEN_VALUE = 'destroy-disposable-local-test-only';
export const RESET_EXPECTED_MARKER_VAR = 'MONA_R4_RESET_EXPECTED_MARKER';
export const ROW_CEILING = 1000;

export type ResetCode = 'REFUSED_AUTH' | 'BLOCKED_TARGET_IDENTITY' | 'BLOCKED_RESET_STATE';
export class ResetRefusal extends Error {
  constructor(readonly code: ResetCode, message: string) {
    super(message);
  }
}

export type ResetClient = { query: (sql: string) => Promise<{ rows: Record<string, unknown>[] }> };
export type ResetDeps = {
  client: ResetClient;
  ownerToken: string | undefined;
  expectedMarkerId: string | undefined;
  targetMarkerId: string;
  proveIdentity: (client: ResetClient) => Promise<void>;
};
export type ResetReport = {
  outcome: 'OK' | 'ALREADY_FRESH';
  droppedTables: number;
  droppedTypes: number;
  droppedFunctions: number;
  rowCounts: Record<string, number>;
  markerDigest: string;
};

export const SQL_BEGIN = 'BEGIN';
export const SQL_SEARCH_PATH = 'SET LOCAL search_path TO pg_catalog, pg_temp';
export const SQL_LOCK_TIMEOUT = "SET LOCAL lock_timeout = '5s'";
export const SQL_LOCK_MARKER = 'LOCK TABLE mona_local_test_guard.database_identity IN SHARE MODE';
export const SQL_SESSIONS =
  'SELECT count(*)::int AS n FROM pg_catalog.pg_stat_activity WHERE datname = pg_catalog.current_database() AND pid <> pg_catalog.pg_backend_pid()';
export const SQL_FOREIGN_SCHEMAS =
  "SELECT nspname AS name FROM pg_catalog.pg_namespace WHERE nspname NOT IN ('public','mona_local_test_guard','pg_catalog','information_schema','pg_toast') AND nspname NOT LIKE 'pg\\_temp\\_%' AND nspname NOT LIKE 'pg\\_toast\\_temp\\_%'";
export const SQL_EXTENSIONS = "SELECT extname AS name FROM pg_catalog.pg_extension WHERE extname <> 'plpgsql'";
// Every user-visible object of schema public, one (kind, name) row each. Relation row types and array types are the
// implicit companions of tables/enums and are excluded; every other kind is reported so that it can be refused.
export const SQL_PUBLIC_OBJECTS = `SELECT 'rel:' || c.relkind::text AS kind, c.relname::text AS name FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'
UNION ALL SELECT 'type:' || t.typtype::text, t.typname::text FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typrelid = 0 AND NOT (t.typcategory = 'A' AND t.typelem <> 0)
UNION ALL SELECT 'proc', p.proname::text FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
UNION ALL SELECT 'operator', o.oprname::text FROM pg_catalog.pg_operator o JOIN pg_catalog.pg_namespace n ON n.oid = o.oprnamespace WHERE n.nspname = 'public'
UNION ALL SELECT 'collation', o.collname::text FROM pg_catalog.pg_collation o JOIN pg_catalog.pg_namespace n ON n.oid = o.collnamespace WHERE n.nspname = 'public'
UNION ALL SELECT 'conversion', o.conname::text FROM pg_catalog.pg_conversion o JOIN pg_catalog.pg_namespace n ON n.oid = o.connamespace WHERE n.nspname = 'public'
UNION ALL SELECT 'statistics', o.stxname::text FROM pg_catalog.pg_statistic_ext o JOIN pg_catalog.pg_namespace n ON n.oid = o.stxnamespace WHERE n.nspname = 'public'
UNION ALL SELECT 'ts', o.cfgname::text FROM pg_catalog.pg_ts_config o JOIN pg_catalog.pg_namespace n ON n.oid = o.cfgnamespace WHERE n.nspname = 'public'
UNION ALL SELECT 'opclass', o.opcname::text FROM pg_catalog.pg_opclass o JOIN pg_catalog.pg_namespace n ON n.oid = o.opcnamespace WHERE n.nspname = 'public'`;
// Digest of the marker table content AND of the guard schema's relations (oid + name + kind): a drop/recreate or an edit changes it.
export const SQL_MARKER_DIGEST = `SELECT pg_catalog.md5(
  (SELECT COALESCE(pg_catalog.string_agg(m::text, '|' ORDER BY m::text), '') FROM mona_local_test_guard.database_identity m) || '#' ||
  (SELECT COALESCE(pg_catalog.string_agg(c.oid::text || ':' || c.relname::text || ':' || c.relkind::text, '|' ORDER BY c.oid), '') FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'mona_local_test_guard')
) AS digest, (SELECT count(*)::int FROM mona_local_test_guard.database_identity) AS n`;
export const SQL_COMMIT = 'COMMIT';
export const SQL_ROLLBACK = 'ROLLBACK';
export const countSql = (table: string): string => `SELECT count(*)::int AS n FROM public."${table}"`;
export const dropTableSql = (table: string): string => `DROP TABLE public."${table}" CASCADE`;
export const dropTypeSql = (name: string): string => `DROP TYPE public."${name}"`;
// Migration 5 creates exactly these zero-argument trigger functions in public (CREATE FUNCTION public."fn_..."() RETURNS trigger).
export const KNOWN_TRIGGER_FUNCTIONS: readonly string[] = Object.freeze(['fn_sale_payment_history', 'fn_sale_payment_truncate_guard', 'fn_sale_wholesale_frozen_after_payment']);
export const dropFunctionSql = (name: string): string => `DROP FUNCTION public."${name}"()`;


const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ENUM_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TABLE_ALLOWLIST: ReadonlySet<string> = new Set<string>([...APPLICATION_TABLES, '_prisma_migrations']);
const OPERATIONAL_TABLES: readonly string[] = ['Sale', 'SaleItem', 'SalePayment', 'CashSession', 'CashMovement', 'StockMovement', 'StockReservation', 'AuditLog'];

export type ResetGateDecision = { enabled: true } | { enabled: false; reason: string };
// Pure: never opens a connection. The target must be the canonical loopback LOCAL_TEST (readLocalTestTarget) and nothing else.
export function evaluateResetGate(env: Readonly<Record<string, string | undefined>>): ResetGateDecision {
  if (env[RESET_TOKEN_VAR] !== RESET_TOKEN_VALUE) return { enabled: false, reason: 'explicit reset opt-in token missing' };
  if (env.MONA_TEST_DATABASE_TARGET !== 'local') return { enabled: false, reason: 'target selector must be exactly "local"' };
  for (const name of ['DATABASE_URL', 'TEST_DATABASE_URL']) {
    if (env[name] !== undefined && env[name] !== '') return { enabled: false, reason: `${name} must not be present` };
  }
  let target;
  try {
    target = readLocalTestTarget(env as NodeJS.ProcessEnv);
  } catch {
    return { enabled: false, reason: 'target is not the canonical LOCAL_TEST configuration' };
  }
  if (env[RESET_EXPECTED_MARKER_VAR] !== target.markerId) return { enabled: false, reason: 'expected marker differs from the configured marker' };
  return { enabled: true };
}

const refuse = (code: ResetCode, message: string): ResetRefusal => new ResetRefusal(code, message);
const num = (value: unknown): number => (typeof value === 'number' ? value : Number(value));

type Inventory = { tables: string[]; enums: string[]; functions: string[] };

async function inventory(client: ResetClient): Promise<Inventory> {
  const rows = (await client.query(SQL_PUBLIC_OBJECTS)).rows;
  const tables: string[] = [];
  const enums: string[] = [];
  const functions: string[] = [];
  for (const row of rows) {
    const kind = String(row.kind);
    const name = String(row.name);
    if (kind === 'rel:r') {
      if (!TABLE_ALLOWLIST.has(name)) throw refuse('BLOCKED_RESET_STATE', 'public holds a table outside the application allowlist');
      tables.push(name);
    } else if (kind === 'rel:i' || kind === 'rel:S') {
      // dropped together with their owning table; a leftover is caught by the post-check
    } else if (kind === 'type:e') {
      if (!ENUM_NAME.test(name)) throw refuse('BLOCKED_RESET_STATE', 'public holds an enum type with a non-plain name');
      enums.push(name);
    } else if (kind === 'proc') {
      // only the exact, known migration-5 trigger functions (exact-case names); anything else, including overloads or hostile names, is refused
      if (!KNOWN_TRIGGER_FUNCTIONS.includes(name)) throw refuse('BLOCKED_RESET_STATE', 'public holds a function outside the application allowlist');
      functions.push(name);
    } else {
      throw refuse('BLOCKED_RESET_STATE', `public holds an unsupported object kind (${kind.replace(/[^a-z:]/g, '')})`);
    }
  }
  return { tables, enums, functions };
}

async function markerDigest(client: ResetClient): Promise<string> {
  const row = (await client.query(SQL_MARKER_DIGEST)).rows[0];
  if (!row || num(row.n) !== 1 || typeof row.digest !== 'string') throw refuse('BLOCKED_TARGET_IDENTITY', 'marker digest is unreadable');
  return row.digest;
}

async function prove(deps: ResetDeps): Promise<void> {
  try {
    await deps.proveIdentity(deps.client);
  } catch {
    throw refuse('BLOCKED_TARGET_IDENTITY', 'LOCAL_TEST identity could not be proven on the reset transaction');
  }
}

export async function resetDisposableLocalTest(deps: ResetDeps): Promise<ResetReport> {
  if (deps.ownerToken !== RESET_TOKEN_VALUE) throw refuse('REFUSED_AUTH', 'owner reset token missing or wrong');
  if (typeof deps.proveIdentity !== 'function') throw refuse('REFUSED_AUTH', 'no identity prover supplied');
  if (!deps.expectedMarkerId || !UUID_V4.test(deps.expectedMarkerId) || deps.expectedMarkerId !== deps.targetMarkerId) {
    throw refuse('BLOCKED_TARGET_IDENTITY', 'expected marker is missing or differs from the target marker');
  }
  const { client } = deps;
  let phase = 'begin';
  try {
    await client.query(SQL_BEGIN);
    phase = 'lock';
    await client.query(SQL_SEARCH_PATH);
    await client.query(SQL_LOCK_TIMEOUT);
    await client.query(SQL_LOCK_MARKER);
    phase = 'prove';
    await prove(deps);
    const digestBefore = await markerDigest(client);

    phase = 'precheck';
    const sessions = num((await client.query(SQL_SESSIONS)).rows[0]?.n);
    if (sessions !== 0) throw refuse('BLOCKED_RESET_STATE', 'another session is connected to the database');
    const schemas = (await client.query(SQL_FOREIGN_SCHEMAS)).rows;
    if (schemas.length > 0) throw refuse('BLOCKED_RESET_STATE', 'a schema other than public and the LOCAL_TEST guard exists');
    const extensions = (await client.query(SQL_EXTENSIONS)).rows;
    if (extensions.length > 0) throw refuse('BLOCKED_RESET_STATE', 'an extension is installed');
    const before = await inventory(client);
    const rowCounts: Record<string, number> = {};
    let total = 0;
    for (const table of before.tables) {
      const n = num((await client.query(countSql(table))).rows[0]?.n);
      if (!Number.isSafeInteger(n) || n < 0) throw refuse('BLOCKED_RESET_STATE', 'row count unreadable');
      rowCounts[table] = n;
      total += n;
      if (n > 0 && OPERATIONAL_TABLES.includes(table)) throw refuse('BLOCKED_RESET_STATE', 'an operational table holds rows: not an example fixture');
    }
    if (total > ROW_CEILING) throw refuse('BLOCKED_RESET_STATE', 'row total exceeds the example-fixture ceiling');
    if ((await markerDigest(client)) !== digestBefore) throw refuse('BLOCKED_TARGET_IDENTITY', 'marker changed between proof and reset');

    phase = 'drop';
    for (const table of before.tables) await client.query(dropTableSql(table));
    for (const name of before.enums) await client.query(dropTypeSql(name));
    for (const name of before.functions) await client.query(dropFunctionSql(name));

    phase = 'postcheck';
    const after = await inventory(client);
    if (after.tables.length > 0 || after.enums.length > 0 || after.functions.length > 0) throw refuse('BLOCKED_RESET_STATE', 'objects remain in public after the reset');
    const digestAfter = await markerDigest(client);
    if (digestAfter !== digestBefore) throw refuse('BLOCKED_TARGET_IDENTITY', 'marker changed during the reset');
    await prove(deps);
    phase = 'commit';
    await client.query(SQL_COMMIT);
    return {
      outcome: before.tables.length === 0 && before.enums.length === 0 && before.functions.length === 0 ? 'ALREADY_FRESH' : 'OK',
      droppedTables: before.tables.length,
      droppedTypes: before.enums.length,
      droppedFunctions: before.functions.length,
      rowCounts,
      markerDigest: digestAfter,
    };
  } catch (error) {
    try {
      await client.query(SQL_ROLLBACK);
    } catch {
      /* the refusal below is the outcome either way */
    }
    // Only fixed messages leave this function: driver errors may carry connection details.
    if (error instanceof ResetRefusal) throw error;
    throw refuse('BLOCKED_RESET_STATE', `reset failed at phase=${phase}; nothing was committed`);
  }
}
