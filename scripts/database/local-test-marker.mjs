import { pathToFileURL } from 'node:url';
import pg from 'pg';

// Installs and checks the LOCAL_TEST-only database identity marker. A separate
// tool from test-marker.mjs and pilot-marker.mjs, and from any LOCAL_TEST
// preparation: nothing that later relies on this marker as proof may create it.
//
//   node scripts/database/local-test-marker.mjs --dry-run --marker-id=<uuid>
//   node scripts/database/local-test-marker.mjs --check --marker-id=<uuid>
//   node scripts/database/local-test-marker.mjs --execute --marker-id=<uuid> \
//     --confirm-local-target=mona_local_test@127.0.0.1:5432/mona_local_test
//
// The only connection source is LOCAL_TEST_DATABASE_URL, which must be the
// exact canonical loopback text accepted by readLocalTestTarget and
// api/prisma.local-test.config.ts; --marker-id must equal the pinned
// LOCAL_TEST_DATABASE_MARKER_ID. No DEV/TEST/PILOT variable is read and PGOPTIONS
// is refused. The independent attestation before any marker exists is: the
// canonical loopback target, the operator's --confirm-local-target, and live
// facts (database, user, PostgreSQL 17+, no TEST or PILOT marker schema) read
// before any write. --dry-run opens no connection; --check is read-only;
// --execute is additive only and never repairs or overwrites an existing marker.
// No URL, password, host or port is ever printed.

const { Client } = pg;

export const GUARD_SCHEMA = 'mona_local_test_guard';
export const GUARD_TABLE = 'database_identity';
export const QUALIFIED = `${GUARD_SCHEMA}.${GUARD_TABLE}`;
export const ENVIRONMENT = 'local_test';
export const URL_VAR = 'LOCAL_TEST_DATABASE_URL';
export const MARKER_VAR = 'LOCAL_TEST_DATABASE_MARKER_ID';
export const MIN_PG_MAJOR = 17;
// The operator's independent attestation for --execute (not a secret).
export const CONFIRM_LOCAL_TARGET = 'mona_local_test@127.0.0.1:5432/mona_local_test';
const PREFIX = '[db:local-test-marker]';
const LOCAL_HOST = '127.0.0.1';
const LOCAL_PORT = 5432;
const LOCAL_DATABASE = 'mona_local_test';
const LOCAL_USER = 'mona_local_test';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MODES = ['dry-run', 'check', 'execute'];
const VALUE_ARGS = ['marker-id', 'confirm-local-target'];
const CONNECT_TIMEOUT_MS = 10000;
const QUERY_TIMEOUT_MS = 20000;
const END_TIMEOUT_MS = 5000;

// Exactly one mode, exactly one canonical --marker-id, and --confirm-local-target
// only (and always, exactly) with --execute. Rejected values are never echoed.
export function parseCliArgs(argv) {
  const values = {};
  const modes = [];
  for (const arg of argv) {
    if (typeof arg !== 'string' || !arg.startsWith('--')) return { ok: false, error: 'Unexpected positional argument (not echoed)' };
    const body = arg.slice(2);
    if (MODES.includes(body)) {
      modes.push(body);
      continue;
    }
    const eq = body.indexOf('=');
    const key = eq === -1 ? null : body.slice(0, eq);
    if (!key || !VALUE_ARGS.includes(key)) return { ok: false, error: 'Unknown argument (not echoed)' };
    if (key in values) return { ok: false, error: `--${key} may be given only once` };
    values[key] = body.slice(eq + 1);
  }
  if (modes.length !== 1) return { ok: false, error: 'Specify exactly one of --dry-run, --check or --execute' };
  const [mode] = modes;
  const markerId = values['marker-id'];
  if (markerId === undefined || !UUID_V4.test(markerId)) {
    return { ok: false, error: '--marker-id must be a canonical lowercase version-4 UUID' };
  }
  const confirm = values['confirm-local-target'];
  if (mode !== 'execute' && confirm !== undefined) {
    return { ok: false, error: '--confirm-local-target is accepted only with --execute' };
  }
  if (mode === 'execute' && confirm !== CONFIRM_LOCAL_TARGET) {
    return { ok: false, error: `--execute requires --confirm-local-target=${CONFIRM_LOCAL_TARGET} exactly` };
  }
  return { ok: true, mode, markerId, confirm: confirm ?? null };
}

// LOCAL_TEST_DATABASE_URL must already be the canonical text (the URL parser
// trims, drops tab/LF/CR, lowercases the scheme and normalizes the port, so the
// parse alone could validate a different string). pg gets discrete fields only.
export function readLocalTestMarkerConfig(env) {
  const fail = (reason) => ({ ok: false, reason });
  if (env.PGOPTIONS !== undefined) return fail('PGOPTIONS is set in the environment; unset it (value not shown)');
  const raw = env[URL_VAR];
  if (typeof raw !== 'string' || raw === '') return fail(`${URL_VAR} is required`);
  let url;
  try {
    url = new URL(raw);
  } catch {
    return fail(`${URL_VAR} is not a valid URL (value not shown)`);
  }
  const canonical = `${url.protocol}//${LOCAL_USER}:${url.password}@${LOCAL_HOST}:${LOCAL_PORT}/${LOCAL_DATABASE}`;
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.password || raw !== canonical) {
    return fail(`${URL_VAR} must be exactly the canonical LOCAL_TEST loopback target (value not shown)`);
  }
  let password;
  try {
    password = decodeURIComponent(url.password);
  } catch {
    return fail(`${URL_VAR} must be exactly the canonical LOCAL_TEST loopback target (value not shown)`);
  }
  const markerId = env[MARKER_VAR];
  if (typeof markerId !== 'string' || !UUID_V4.test(markerId)) {
    return fail(`${MARKER_VAR} must be a canonical lowercase version-4 UUID (value not shown)`);
  }
  return {
    ok: true,
    url: raw,
    markerId,
    conn: { host: LOCAL_HOST, port: LOCAL_PORT, database: LOCAL_DATABASE, user: LOCAL_USER, password },
  };
}

// Independent pre-marker facts. Anything not exactly as expected (including a
// missing or non-boolean guard observation) is refused with a fixed reason.
export function assertLiveFacts(facts) {
  if (facts === null || typeof facts !== 'object') return 'live database facts could not be read';
  if (facts.currentDatabase !== LOCAL_DATABASE) return 'connected database is not mona_local_test';
  if (facts.currentUser !== LOCAL_USER) return 'connected role is not mona_local_test';
  const match = typeof facts.version === 'string' ? /^PostgreSQL (\d+)(?:\.|\s|$)/.exec(facts.version) : null;
  const major = match ? Number(match[1]) : Number.NaN;
  if (!Number.isInteger(major) || major < MIN_PG_MAJOR) return `PostgreSQL ${MIN_PG_MAJOR} or newer is required`;
  if (facts.testGuardExists !== false) return 'a TEST marker schema exists on this database; it is not LOCAL_TEST';
  if (facts.pilotGuardExists !== false) return 'a PILOT marker schema exists on this database; it is not LOCAL_TEST';
  return null;
}

// Canonical marker definition. CREATE TABLE is generated from `ddl`; verification
// compares the catalog against `type`/`notNull`/`default`/`collation` and the
// pg_get_constraintdef renderings, so installation and verification cannot drift:
// if a rendering were wrong for the server, the install would roll back.
export const CANONICAL_MARKER = Object.freeze({
  columns: Object.freeze([
    { name: 'singleton', ddl: 'boolean PRIMARY KEY DEFAULT true CHECK (singleton)', type: 'boolean', notNull: true, default: 'true', collation: null },
    { name: 'environment', ddl: `text NOT NULL CHECK (environment = '${ENVIRONMENT}')`, type: 'text', notNull: true, default: null, collation: 'default' },
    { name: 'marker_id', ddl: 'uuid NOT NULL', type: 'uuid', notNull: true, default: null, collation: null },
    { name: 'installed_at', ddl: 'timestamptz NOT NULL DEFAULT now()', type: 'timestamp with time zone', notNull: true, default: 'now()', collation: null },
  ]),
  // Every constraint on the table except NOT NULL (checked via attnotnull).
  constraints: Object.freeze([
    { type: 'c', definition: `CHECK ((environment = '${ENVIRONMENT}'::text))` },
    { type: 'c', definition: 'CHECK (singleton)' },
    { type: 'p', definition: 'PRIMARY KEY (singleton)' },
  ]),
  // Every pg_class relation in the schema: exactly the table and its PK index.
  relations: Object.freeze([
    { name: GUARD_TABLE, kind: 'r' },
    { name: `${GUARD_TABLE}_pkey`, kind: 'i' },
  ]),
});

// Additive only. No IF NOT EXISTS: a pre-existing schema/table aborts the
// transaction instead of being silently reused. The marker id is a bound parameter.
export function buildInstallStatements(markerId) {
  const columns = CANONICAL_MARKER.columns.map((c) => `  ${c.name} ${c.ddl}`).join(',\n');
  return [
    { text: `CREATE SCHEMA ${GUARD_SCHEMA}` },
    { text: `CREATE TABLE ${QUALIFIED} (\n${columns}\n)` },
    { text: `INSERT INTO ${QUALIFIED} (environment, marker_id) VALUES ('${ENVIRONMENT}', $1)`, values: [markerId] },
  ];
}

// Pins unqualified name resolution to pg_catalog for this transaction only, then
// bounds lock waits and statements.
const PIN_SEARCH_PATH_SQL = 'SET LOCAL search_path TO pg_catalog, pg_temp';
const TIMEOUT_SQL = ["SET LOCAL lock_timeout = '5s'", "SET LOCAL statement_timeout = '15s'"];
const CHECK_BEGIN_SQL = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY';
// --execute: SHARE blocks concurrent writes and DROP/ALTER until the transaction
// ends, so structure and rows describe one table. --check: ACCESS SHARE, taken
// BEFORE the first snapshot-taking SELECT so the REPEATABLE READ snapshot
// postdates the lock.
const LOCK_SQL = { execute: `LOCK TABLE ${QUALIFIED} IN SHARE MODE`, check: `LOCK TABLE ${QUALIFIED} IN ACCESS SHARE MODE` };
// LOCK on an absent marker: undefined_table / invalid_schema_name.
const MARKER_ABSENT_CODES = new Set(['42P01', '3F000']);

export const LIVE_FACTS_SQL = `SELECT current_database() AS current_database, current_user AS current_user, version() AS version,
  to_regnamespace('mona_test_guard') IS NOT NULL AS test_guard_exists,
  to_regnamespace('mona_pilot_guard') IS NOT NULL AS pilot_guard_exists`;
export const INSPECT_SQL = `SELECT to_regnamespace('${GUARD_SCHEMA}') IS NOT NULL AS schema_exists,
  to_regclass('${QUALIFIED}') IS NOT NULL AS table_exists`;
const REL = `to_regclass('${QUALIFIED}')`;
export const MARKER_FACTS_SQL = `SELECT json_build_object(
  'schemaOwnerIsCurrentUser', (SELECT pg_get_userbyid(n.nspowner) = current_user
     FROM pg_namespace n WHERE n.nspname = '${GUARD_SCHEMA}'),
  'relations', (SELECT coalesce(json_agg(json_build_object('name', c.relname, 'kind', c.relkind)), '[]'::json)
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = '${GUARD_SCHEMA}'),
  'table', (SELECT json_build_object(
       'kind', c.relkind,
       'persistence', c.relpersistence,
       'isPartition', c.relispartition,
       'ofType', c.reloftype <> 0,
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
       'default', pg_get_expr(d.adbin, d.adrelid), 'generated', a.attgenerated, 'identity', a.attidentity,
       'collation', (SELECT co.collname FROM pg_collation co WHERE co.oid = a.attcollation))
       ORDER BY a.attnum), '[]'::json)
     FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE a.attrelid = ${REL} AND a.attnum > 0 AND NOT a.attisdropped),
  'constraints', (SELECT coalesce(json_agg(json_build_object('type', con.contype, 'definition', pg_get_constraintdef(con.oid))), '[]'::json)
     FROM pg_constraint con WHERE con.conrelid = ${REL} AND con.contype <> 'n')
) AS facts`;
export const MARKER_ROWS_SQL = `SELECT environment, marker_id::text AS marker_id, installed_at IS NOT NULL AS has_installed_at FROM ${QUALIFIED}`;

const sortKey = (entry) => JSON.stringify(entry);
function sameSet(actual, expected) {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  const a = actual.map(sortKey).sort();
  const e = expected.map(sortKey).sort();
  return a.every((value, i) => value === e[i]);
}
function canonicalColumn(column) {
  if (column === null || typeof column !== 'object') return {};
  const { name, type, notNull, default: def, generated, identity, collation } = column;
  return { name, type, notNull, default: def ?? null, generated, identity, collation };
}

// Returns null when the live catalog facts match CANONICAL_MARKER exactly,
// otherwise a fixed, secret-free reason. Every fact must have exactly the
// expected JS type and value: a missing, null or stringly fact is a mismatch.
export function verifyMarkerStructure(facts) {
  if (facts === null || typeof facts !== 'object') return 'marker structure could not be read';
  if (facts.schemaOwnerIsCurrentUser !== true) return 'marker schema is not owned by the installing role';
  const t = facts.table;
  if (t === null || typeof t !== 'object') return 'marker table is missing';
  if (t.kind !== 'r' || t.persistence !== 'p' || t.ofType !== false) return 'marker relation is not an ordinary, logged, untyped table';
  if (t.ownerIsCurrentUser !== true) return 'marker table is not owned by the installing role';
  if (t.rowSecurity !== false || t.forceRowSecurity !== false) return 'marker table has row-level security';
  if (t.hasRules !== false || t.triggers !== 0) return 'marker table has rules or triggers';
  if (t.isPartition !== false || t.hasSubclass !== false || t.parents !== 0 || t.children !== 0) {
    return 'marker table takes part in inheritance or partitioning';
  }
  const expected = CANONICAL_MARKER.columns.map(({ name, type, notNull, default: def, collation }) => ({
    name, type, notNull, default: def, generated: '', identity: '', collation,
  }));
  const columns = Array.isArray(facts.columns) ? facts.columns : [];
  const columnsMatch =
    columns.length === expected.length &&
    columns.every((column, i) => sortKey(canonicalColumn(column)) === sortKey(expected[i]));
  if (!columnsMatch) return 'marker columns do not match the canonical definition';
  if (!sameSet(facts.constraints, CANONICAL_MARKER.constraints)) return 'marker constraints do not match the canonical definition';
  if (!sameSet(facts.relations, CANONICAL_MARKER.relations)) return 'marker schema holds unexpected relations';
  return null;
}

// Only an absent marker is installable; only the canonical structure holding one
// exact LOCAL_TEST row with the intended id is an idempotent success. Everything
// else is a conflict and is never repaired or overwritten.
export function decideInstall(state, markerId) {
  if (state?.schemaExists !== true && state?.tableExists !== true) return { action: 'install' };
  if (state.schemaExists !== true || state.tableExists !== true) return { action: 'conflict', reason: 'partial marker structure' };
  const structure = verifyMarkerStructure(state.facts);
  if (structure) return { action: 'conflict', reason: structure };
  if (!Array.isArray(state.rows) || state.rows.length !== 1) return { action: 'conflict', reason: 'marker table does not hold exactly one row' };
  const [row] = state.rows;
  if (row?.environment !== ENVIRONMENT) return { action: 'conflict', reason: 'marker environment is not local_test' };
  if (row.has_installed_at !== true) return { action: 'conflict', reason: 'marker installed_at is missing' };
  if (row.marker_id !== markerId) return { action: 'conflict', reason: 'a different marker id is installed' };
  return { action: 'already-installed' };
}

// pg SQLSTATEs and Node error codes only; anything else (including a code that
// appears inside a secret) collapses to 'unexpected'. Messages are never used.
export function safeCode(err, secrets) {
  const code = err !== null && typeof err === 'object' ? err.code : undefined;
  if (typeof code !== 'string' || !/^[A-Z0-9_]{1,40}$/.test(code)) return 'unexpected';
  if (secrets.some((secret) => typeof secret === 'string' && secret.includes(code))) return 'unexpected';
  return code;
}

// Discrete fields only (no connection string), no TLS on the loopback target,
// bounded connect and per-query time.
function createLocalClient(conn) {
  const client = new Client({
    host: conn.host,
    port: conn.port,
    database: conn.database,
    user: conn.user,
    password: conn.password,
    ssl: false,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    query_timeout: QUERY_TIMEOUT_MS,
  });
  client.on('error', () => {
    /* Never emit credentials from pg errors; the awaited call fails closed. */
  });
  return client;
}

const defaultDeps = {
  env: process.env,
  createClient: createLocalClient,
  log: (line) => console.log(line),
  error: (line) => console.error(line),
  endTimeoutMs: END_TIMEOUT_MS,
};

function planLines(markerId) {
  return [
    '  planned --execute actions (one transaction, LOCAL_TEST_DATABASE_URL only):',
    `    1. BEGIN; ${PIN_SEARCH_PATH_SQL}; ${TIMEOUT_SQL.join('; ')}`,
    '    2. live facts: current_database = mona_local_test, current_user = mona_local_test,',
    `       PostgreSQL ${MIN_PG_MAJOR}+, no TEST or PILOT marker schema → otherwise ROLLBACK and refuse`,
    `    3. inspect ${QUALIFIED}; if the table exists: ${LOCK_SQL.execute}, read catalog structure and rows`,
    '    4. marker absent → execute, in order:',
    ...buildInstallStatements(markerId).flatMap((s) =>
      s.text.split('\n').map((line, i) => `         ${i === 0 ? '- ' : '  '}${line}`),
    ),
    `         ($1 = ${markerId})`,
    '       then re-read (locked): canonical structure, exactly one row, environment=local_test, same marker id → COMMIT;',
    '       anything else → ROLLBACK',
    '    5. canonical marker with the identical id already present → ROLLBACK, nothing changed (idempotent)',
    '    6. any other existing state (partial, different, non-canonical) → ROLLBACK and refuse; never repaired',
    '  never created: databases, roles or passwords; no privileges are granted or revoked',
  ];
}

export async function main(argv, deps = defaultDeps) {
  const fail = (phase, detail, code) => {
    deps.error(`${PREFIX} FAIL: phase=${phase}${code ? ` code=${code}` : ''} — ${detail}`);
    return 1;
  };

  const parsed = parseCliArgs(argv);
  if (!parsed.ok) return fail('args', parsed.error);

  let config;
  try {
    config = readLocalTestMarkerConfig(deps.env ?? {});
  } catch {
    config = { ok: false, reason: 'LOCAL_TEST configuration could not be read' };
  }
  if (!config.ok) return fail('config', config.reason);
  if (parsed.markerId !== config.markerId) {
    return fail('config', `--marker-id must equal the pinned ${MARKER_VAR}`);
  }

  if (parsed.mode === 'dry-run') {
    for (const line of [
      `${PREFIX} DRY RUN — no database connection was opened and nothing was written`,
      '  target: LOCAL_TEST (mona_local_test on 127.0.0.1:5432)',
      `  connection source: ${URL_VAR} (canonical, value not shown); no other database variable is read`,
      `  marker: ${QUALIFIED} (environment = '${ENVIRONMENT}')`,
      `  marker id to install: ${parsed.markerId} (equals the pinned ${MARKER_VAR})`,
      `  --execute requires --confirm-local-target=${CONFIRM_LOCAL_TARGET}`,
      ...planLines(parsed.markerId),
      '  no backup prerequisite for this marker install only: purely additive on a disposable LOCAL_TEST database',
    ]) deps.log(line);
    return 0;
  }

  return connectAndRun(parsed, config, deps, fail);
}

async function inspectMarker(client, lockSql) {
  const { rows } = await client.query(INSPECT_SQL);
  const state = {
    schemaExists: rows[0]?.schema_exists === true,
    tableExists: rows[0]?.table_exists === true,
    facts: null,
    rows: [],
  };
  if (state.tableExists) {
    if (lockSql) await client.query(lockSql);
    state.facts = (await client.query(MARKER_FACTS_SQL)).rows[0]?.facts ?? null;
    state.rows = (await client.query(MARKER_ROWS_SQL)).rows;
  }
  return state;
}

async function readLiveFacts(client) {
  const [row] = (await client.query(LIVE_FACTS_SQL)).rows;
  return {
    currentDatabase: row?.current_database,
    currentUser: row?.current_user,
    version: row?.version,
    testGuardExists: row?.test_guard_exists,
    pilotGuardExists: row?.pilot_guard_exists,
  };
}

async function connectAndRun(parsed, config, deps, fail) {
  const secrets = [config.url, config.conn.password];
  const check = parsed.mode === 'check';
  let client;
  try {
    client = deps.createClient(config.conn);
  } catch (err) {
    return fail('connect', 'client could not be created', safeCode(err, secrets));
  }
  let phase = 'connect';
  let inTransaction = false;
  // Cleanup ROLLBACK, lazily contained: neither a rejection nor a synchronous throw
  // can replace an already-decided outcome or escape with its (secret-bearing)
  // error. Returns whether the ROLLBACK was confirmed. An unconfirmed ROLLBACK never
  // commits anything: no COMMIT follows it and the connection is closed in finally.
  const contained = (op) => Promise.resolve().then(op).then(() => true, () => false);
  const rollback = async () => {
    const ok = await contained(() => client.query('ROLLBACK'));
    if (ok) inTransaction = false;
    return ok;
  };
  try {
    await client.connect();

    phase = 'identity';
    await client.query(check ? CHECK_BEGIN_SQL : 'BEGIN');
    inTransaction = true;
    await client.query(PIN_SEARCH_PATH_SQL);
    for (const sql of TIMEOUT_SQL) await client.query(sql);
    if (check) {
      try {
        await client.query(LOCK_SQL.check);
      } catch (err) {
        if (!MARKER_ABSENT_CODES.has(err?.code)) throw err;
        await rollback();
        return fail('identity', 'LOCAL_TEST marker is not installed; nothing was changed');
      }
    }
    const live = assertLiveFacts(await readLiveFacts(client));
    if (live) {
      await rollback();
      return fail('identity', `${live}; nothing was changed`);
    }

    phase = 'inspect';
    const lockSql = check ? null : LOCK_SQL.execute;
    const decision = decideInstall(await inspectMarker(client, lockSql), parsed.markerId);

    if (check) {
      const rolledBack = await rollback();
      if (decision.action === 'already-installed') {
        // The proof is trusted only when its read-only transaction is confirmed closed.
        if (!rolledBack) return fail('identity', 'the marker proof transaction could not be rolled back; proof not trusted; nothing was changed');
        deps.log(`${PREFIX} OK — canonical LOCAL_TEST marker verified (read-only, nothing changed)`);
        deps.log(`  marker id: ${parsed.markerId}`);
        return 0;
      }
      const reason = decision.action === 'install' ? 'LOCAL_TEST marker is not installed' : decision.reason;
      return fail('identity', `${reason}; nothing was changed`);
    }

    if (decision.action !== 'install') {
      const rolledBack = await rollback();
      if (decision.action === 'conflict') return fail('conflict', `${decision.reason}; nothing was changed`);
      if (!rolledBack) return fail('inspect', 'the read transaction could not be rolled back; nothing was changed');
      deps.log(`${PREFIX} OK — identical canonical marker already installed on LOCAL_TEST; nothing changed`);
      deps.log(`  marker id: ${parsed.markerId}`);
      return 0;
    }

    phase = 'install';
    for (const statement of buildInstallStatements(parsed.markerId)) await client.query(statement);

    phase = 'verify';
    const after = decideInstall(await inspectMarker(client, lockSql), parsed.markerId);
    if (after.action !== 'already-installed') {
      const rolledBack = await rollback();
      return fail('verify', `installed marker failed canonical verification (${after.reason ?? after.action}); ${rolledBack ? 'rolled back' : 'not committed (ROLLBACK unconfirmed; connection closed without COMMIT)'}`);
    }

    phase = 'commit';
    await client.query('COMMIT');
    inTransaction = false;
    deps.log(`${PREFIX} OK — marker installed on LOCAL_TEST`);
    deps.log(`  marker: ${QUALIFIED}`);
    deps.log(`  marker id: ${parsed.markerId}`);
    return 0;
  } catch (err) {
    // The thrown error is the outcome; the cleanup ROLLBACK can never replace it.
    if (inTransaction) await rollback();
    return fail(phase, 'transaction not committed', safeCode(err, secrets));
  } finally {
    await endBounded(client, deps.endTimeoutMs ?? END_TIMEOUT_MS);
  }
}

// client.end() can stall on a dead socket; never let it hold the outcome hostage.
async function endBounded(client, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
  try {
    await Promise.race([Promise.resolve().then(() => client.end()).catch(() => {}), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// Only run when executed directly; importing from a test never connects.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
