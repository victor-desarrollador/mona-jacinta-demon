import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import {
  CA_PATH,
  MARKER_VAR,
  PROJECT_REF_PATTERN,
  TEST_GUARD_SCHEMA,
  matchesProjectRef,
  readTestConfig,
  openVerifiedBackup,
} from './lib.mjs';

// Re-exported so existing callers/tests keep one import site for the installer.
export { MARKER_VAR, readTestConfig };

// Installs the TEST-only database identity marker that the test harness will use
// to prove "this connection is the authorized TEST database" from TEST alone,
// without ever opening DATABASE_URL (DEV/DEMO) for comparison.
//
//   node scripts/database/test-marker.mjs --target=test --dry-run --marker-id=<uuid>
//   node scripts/database/test-marker.mjs --target=test --execute --marker-id=<uuid> \
//     --backup=<test_*.dump> --confirm-project-ref=<ref>
//
// --dry-run opens no database connection. --execute connects only through
// TEST_DATABASE_URL, is additive only, and never overwrites an existing marker.
// No URL, host, port, username, password or project ref is ever printed.

const { Client } = pg;

export const GUARD_TABLE = 'database_identity';
const TEST_VAR = 'TEST_DATABASE_URL';
const ENV_FILE = new URL('../../.env.development', import.meta.url);
const CONNECT_TIMEOUT_MS = 10000;
const PREFIX = '[db:test-marker]';
const QUALIFIED = `${TEST_GUARD_SCHEMA}.${GUARD_TABLE}`;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const VALUE_ARGS = ['target', 'marker-id', 'backup', 'confirm-project-ref'];
const FLAG_ARGS = ['dry-run', 'execute'];

// Same shape as api/scripts/bootstrap-system-actor.ts: exactly one --target and
// exactly one of --dry-run/--execute; anything ambiguous fails before any file
// or database is touched. Rejected values are never echoed back.
export function parseCliArgs(argv) {
  const values = {};
  const flags = { 'dry-run': 0, execute: 0 };
  for (const arg of argv) {
    if (!arg.startsWith('--')) return { ok: false, error: 'Unexpected positional argument' };
    const body = arg.slice(2);
    if (FLAG_ARGS.includes(body)) {
      flags[body] += 1;
      continue;
    }
    const eq = body.indexOf('=');
    const key = eq === -1 ? null : body.slice(0, eq);
    if (!key || !VALUE_ARGS.includes(key)) return { ok: false, error: 'Unknown argument (not echoed)' };
    if (key in values) return { ok: false, error: `--${key} may be given only once` };
    values[key] = body.slice(eq + 1);
  }
  if (flags['dry-run'] + flags.execute !== 1) {
    return { ok: false, error: 'Specify exactly one of --dry-run or --execute' };
  }
  if (values.target === undefined) return { ok: false, error: '--target=test is required exactly once' };
  if (values.target !== 'test') return { ok: false, error: 'Only --target=test is accepted' };
  if (values['marker-id'] === undefined || !UUID_V4.test(values['marker-id'])) {
    return { ok: false, error: '--marker-id must be a canonical lowercase version-4 UUID' };
  }
  const mode = flags.execute === 1 ? 'execute' : 'dry-run';
  const backup = values.backup ?? null;
  const confirmProjectRef = values['confirm-project-ref'] ?? null;
  if (backup === '') return { ok: false, error: '--backup must name an artifact file' };
  if (confirmProjectRef !== null && !PROJECT_REF_PATTERN.test(confirmProjectRef)) {
    return { ok: false, error: '--confirm-project-ref must be a 20-character lowercase project ref' };
  }
  if (mode === 'execute' && (backup === null || confirmProjectRef === null)) {
    return { ok: false, error: '--execute requires --backup=<verified TEST artifact> and --confirm-project-ref=<ref>' };
  }
  return { ok: true, mode, markerId: values['marker-id'], backup, confirmProjectRef };
}

// Canonical marker definition. The CREATE TABLE is generated from `ddl`, and the
// catalog verification compares against the `type`/`notNull`/`default` columns and
// the pg_get_constraintdef renderings below, so installation and verification
// cannot drift apart. The post-install check in the same transaction runs the
// same verification against what was just created: if any rendering here were
// wrong for the server, the install would roll back instead of committing.
export const CANONICAL_MARKER = Object.freeze({
  columns: Object.freeze([
    { name: 'singleton', ddl: 'boolean PRIMARY KEY DEFAULT true CHECK (singleton)', type: 'boolean', notNull: true, default: 'true' },
    { name: 'environment', ddl: "text NOT NULL CHECK (environment = 'test')", type: 'text', notNull: true, default: null },
    { name: 'marker_id', ddl: 'uuid NOT NULL', type: 'uuid', notNull: true, default: null },
    { name: 'installed_at', ddl: 'timestamptz NOT NULL DEFAULT now()', type: 'timestamp with time zone', notNull: true, default: 'now()' },
  ]),
  // Every constraint on the table except NOT NULL (checked via attnotnull).
  constraints: Object.freeze([
    { type: 'c', definition: "CHECK ((environment = 'test'::text))" },
    { type: 'c', definition: 'CHECK (singleton)' },
    { type: 'p', definition: 'PRIMARY KEY (singleton)' },
  ]),
  // Every pg_class relation in the schema (tables, indexes, sequences, views,
  // materialized views, composite types, foreign tables): exactly the table and
  // its primary-key index. Non-relation objects are covered by the policy below.
  relations: Object.freeze([
    { name: GUARD_TABLE, kind: 'r' },
    { name: `${GUARD_TABLE}_pkey`, kind: 'i' },
  ]),
});

// Marker schema policy — identity-critical exactness (not "nothing else exists").
// The proof reads only the fully-qualified table via LOCK/SELECT and pg_catalog
// views, with search_path pinned to `pg_catalog, pg_temp` for the transaction, so
// no function, operator, type or collation outside pg_catalog can be resolved by
// name. What can still change what those statements see is enforced exactly:
// schema and table ownership, relation kind (not a view: no SELECT rewrite), rules,
// row-level security, inheritance parents and children (pg_inherits), triggers, every pg_class relation in
// the schema, the canonical columns (types rendered under the pinned search_path,
// so a shadow type shows up schema-qualified), defaults, constraints (a shadow
// operator renders as OPERATOR(schema.=)), and the one canonical row. Other
// schema-scoped objects (functions, types, operators, comments, statistics...)
// are not identity-bearing: nothing in the proof resolves or invokes them.

// Additive only. No IF NOT EXISTS: a pre-existing schema/table aborts the
// transaction instead of being silently reused. The marker is a bound parameter.
export function buildInstallStatements(markerId) {
  const columns = CANONICAL_MARKER.columns.map((c) => `  ${c.name} ${c.ddl}`).join(',\n');
  return [
    { text: `CREATE SCHEMA ${TEST_GUARD_SCHEMA}` },
    { text: `CREATE TABLE ${QUALIFIED} (\n${columns}\n)` },
    {
      text: `COMMENT ON SCHEMA ${TEST_GUARD_SCHEMA} IS 'TEST-only database identity marker. Never copy to another environment.'`,
    },
    { text: `INSERT INTO ${QUALIFIED} (environment, marker_id) VALUES ('test', $1)`, values: [markerId] },
  ];
}

// Pins unqualified name resolution to pg_catalog for this transaction only.
const PIN_SEARCH_PATH_SQL = 'SET LOCAL search_path TO pg_catalog, pg_temp';
const INSPECT_SQL = `SELECT to_regnamespace('${TEST_GUARD_SCHEMA}') IS NOT NULL AS schema_exists,
  to_regclass('${QUALIFIED}') IS NOT NULL AS table_exists`;
// SHARE mode blocks concurrent writes and DROP/ALTER (and any recreate) until the
// transaction ends, so the structure and the rows read below describe one table.
const LOCK_SQL = `LOCK TABLE ${QUALIFIED} IN SHARE MODE`;
const REL = `to_regclass('${QUALIFIED}')`;
const FACTS_SQL = `SELECT json_build_object(
  'schemaOwnerIsCurrentUser', (SELECT pg_get_userbyid(n.nspowner) = current_user
     FROM pg_namespace n WHERE n.nspname = '${TEST_GUARD_SCHEMA}'),
  'relations', (SELECT coalesce(json_agg(json_build_object('name', c.relname, 'kind', c.relkind)), '[]'::json)
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = '${TEST_GUARD_SCHEMA}'),
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
// Shared verbatim with the runtime TEST guard (api/scripts/demo-database.ts);
// api/tests/test-db-guard.test.ts asserts both texts stay identical.
export { FACTS_SQL as MARKER_FACTS_SQL };
const ROWS_SQL = `SELECT environment, marker_id::text AS marker_id, installed_at IS NOT NULL AS has_installed_at FROM ${QUALIFIED}`;

// `lockSql` null: the caller already holds the table lock (proveInstalledMarker).
async function inspectMarker(client, lockSql = LOCK_SQL) {
  const { rows } = await client.query(INSPECT_SQL);
  const state = {
    schemaExists: rows[0]?.schema_exists === true,
    tableExists: rows[0]?.table_exists === true,
    facts: null,
    rows: [],
  };
  if (state.tableExists) {
    if (lockSql) await client.query(lockSql);
    state.facts = (await client.query(FACTS_SQL)).rows[0]?.facts ?? null;
    state.rows = (await client.query(ROWS_SQL)).rows;
  }
  return state;
}

const sortKey = (entry) => JSON.stringify(entry);
function sameSet(actual, expected) {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  const a = actual.map(sortKey).sort();
  const e = expected.map(sortKey).sort();
  return a.every((value, i) => value === e[i]);
}

// Returns null when the live catalog facts match CANONICAL_MARKER exactly,
// otherwise a fixed, secret-free reason.
export function verifyMarkerStructure(facts) {
  if (facts === null || typeof facts !== 'object') return 'marker structure could not be read';
  if (facts.schemaOwnerIsCurrentUser !== true) return 'marker schema is not owned by the installing role';
  const table = facts.table;
  if (table === null || typeof table !== 'object') return 'marker table is missing';
  if (table.kind !== 'r') return 'marker relation is not an ordinary table';
  if (table.ownerIsCurrentUser !== true) return 'marker table is not owned by the installing role';
  if (table.rowSecurity !== false || table.forceRowSecurity !== false) return 'marker table has row-level security';
  if (table.hasSubclass !== false || table.hasRules !== false || table.triggers !== 0) {
    return 'marker table has inheritance children, rules or triggers';
  }
  // pg_inherits in both directions: the marker is nobody's child (INHERITS or a
  // partition, whatever the parent's schema, name or count) and nobody's parent.
  if (table.parents !== 0 || table.children !== 0) return 'marker table takes part in inheritance or partitioning';
  const expectedColumns = CANONICAL_MARKER.columns.map(({ name, type, notNull, default: def }) => ({
    name, type, notNull, default: def, generated: '', identity: '',
  }));
  const columns = Array.isArray(facts.columns) ? facts.columns : [];
  const columnsMatch =
    columns.length === expectedColumns.length &&
    columns.every((column, i) => sortKey(canonicalColumn(column)) === sortKey(expectedColumns[i]));
  if (!columnsMatch) return 'marker columns do not match the canonical definition';
  if (!sameSet(facts.constraints, CANONICAL_MARKER.constraints)) return 'marker constraints do not match the canonical definition';
  if (!sameSet(facts.relations, CANONICAL_MARKER.relations)) return 'marker schema holds unexpected relations';
  return null;
}

function canonicalColumn(column) {
  if (column === null || typeof column !== 'object') return {};
  const { name, type, notNull, default: def, generated, identity } = column;
  return { name, type, notNull, default: def ?? null, generated, identity };
}

// Only an absent marker is installable; only the canonical structure holding one
// TEST row with the intended id is an idempotent success. Everything else is a
// conflict and is never repaired, altered or overwritten.
export function decideInstall(state, markerId) {
  if (!state.schemaExists && !state.tableExists) return { action: 'install' };
  if (!state.schemaExists || !state.tableExists) return { action: 'conflict', reason: 'partial marker structure' };
  const structure = verifyMarkerStructure(state.facts);
  if (structure) return { action: 'conflict', reason: structure };
  if (state.rows.length !== 1) return { action: 'conflict', reason: 'marker table does not hold exactly one row' };
  const [row] = state.rows;
  if (row.environment !== 'test') return { action: 'conflict', reason: 'marker environment is not test' };
  if (row.has_installed_at !== true) return { action: 'conflict', reason: 'marker installed_at is missing' };
  if (row.marker_id !== markerId) return { action: 'conflict', reason: 'a different marker id is already installed' };
  return { action: 'already-installed' };
}

// Read-only proof that `client` is connected to the TEST database holding exactly
// the canonical marker with `markerId` — the gate for destructive TEST tooling
// (restore.mjs) once the marker exists. One REPEATABLE READ READ ONLY transaction,
// always rolled back: ACCESS SHARE is taken BEFORE the first snapshot-taking SELECT
// (BEGIN/SET/LOCK take none), so structure and rows are one snapshot that postdates
// the lock and no DROP/ALTER can commit in between. Same pattern as the runtime
// TEST guard (api/scripts/demo-database.ts) and pilot-marker.mjs --check. Returns
// { ok: true } or { ok: false, reason } with a fixed, secret-free reason; any other
// database error is thrown for the caller to report by safe code only.
const PROOF_BEGIN_SQL = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY';
const PROOF_TIMEOUT_SQL = ["SET LOCAL lock_timeout = '5s'", "SET LOCAL statement_timeout = '15s'"];
const PROOF_LOCK_SQL = `LOCK TABLE ${QUALIFIED} IN ACCESS SHARE MODE`;
// LOCK on an absent marker: undefined_table / invalid_schema_name.
const MARKER_ABSENT_CODES = new Set(['42P01', '3F000']);

// Resolves true only when the operation completed; any failure — rejection,
// synchronous throw or non-Error value — is false. The value itself is never
// kept, so no cleanup error text can reach the output. `operation` must be a lazy
// thunk (`() => client.end()`): an eager call would throw synchronously before this
// helper is entered, and `.then()` would ignore a non-function and report success,
// so anything that is not a function fails closed.
export const confirmed = (operation) =>
  typeof operation !== 'function'
    ? Promise.resolve(false)
    : Promise.resolve().then(operation).then(() => true, () => false);

async function markerVerdict(client, markerId) {
  await client.query(PIN_SEARCH_PATH_SQL);
  for (const sql of PROOF_TIMEOUT_SQL) await client.query(sql);
  try {
    await client.query(PROOF_LOCK_SQL);
  } catch (err) {
    if (MARKER_ABSENT_CODES.has(err?.code)) return { ok: false, reason: 'TEST identity marker is not installed' };
    throw err;
  }
  const decision = decideInstall(await inspectMarker(client, null), markerId);
  if (decision.action === 'already-installed') return { ok: true };
  return { ok: false, reason: decision.action === 'install' ? 'TEST identity marker is not installed' : decision.reason };
}

// A proof is successful only if the read-only verdict passed AND its ROLLBACK is
// confirmed: an unconfirmed ROLLBACK means the session state behind the verdict is
// unknown, so it fails closed. The primary outcome stays authoritative: a thrown
// proof error is re-thrown and a failed verdict is returned unchanged, whatever
// happened to the ROLLBACK.
export async function proveInstalledMarker(client, markerId) {
  if (typeof markerId !== 'string' || !UUID_V4.test(markerId)) return { ok: false, reason: 'pinned marker id is not a canonical version-4 UUID' };
  await client.query(PROOF_BEGIN_SQL);
  let verdict;
  let primaryError = null;
  try {
    verdict = await markerVerdict(client, markerId);
  } catch (err) {
    primaryError = { err };
  }
  const rolledBack = await confirmed(() => client.query('ROLLBACK'));
  if (primaryError) throw primaryError.err;
  if (!verdict.ok) return verdict;
  if (!rolledBack) return { ok: false, reason: 'the marker proof transaction could not be rolled back (proof not trusted)' };
  return verdict;
}

// pg SQLSTATEs and Node error codes only; anything else (including a code that
// appears inside a secret) collapses to 'unexpected'. Messages are never used.
export function safeCode(err, secrets) {
  const code = err !== null && typeof err === 'object' ? err.code : undefined;
  if (typeof code !== 'string' || !/^[A-Z0-9_]{1,40}$/.test(code)) return 'unexpected';
  if (secrets.some((secret) => typeof secret === 'string' && secret.includes(code))) return 'unexpected';
  return code;
}

const defaultDeps = {
  readEnvFile: () => readFileSync(ENV_FILE, 'utf8'),
  createClient: (testUrl) => {
    const client = new Client({
      connectionString: testUrl,
      ssl: { rejectUnauthorized: true, ca: readFileSync(CA_PATH, 'utf8') },
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    });
    client.on('error', () => {
      /* Never emit credentials from pg errors; the awaited call fails closed. */
    });
    return client;
  },
  openBackup: (file) => openVerifiedBackup(file),
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

function planLines(markerId) {
  return [
    '  planned actions (one transaction, TEST_DATABASE_URL only):',
    '    1. BEGIN; SET LOCAL search_path TO pg_catalog, pg_temp; inspect; if the table exists: LOCK TABLE … IN SHARE MODE, read catalog structure and rows',
    '    2. marker absent → re-check the verified backup is unchanged, then execute, in order:',
    ...buildInstallStatements(markerId).flatMap((s) =>
      s.text.split('\n').map((line, i) => `         ${i === 0 ? '- ' : '  '}${line}`),
    ),
    `         ($1 = ${markerId})`,
    '       then re-read: canonical structure, exactly one row, environment=test, same marker id;',
    '       re-check the verified backup is unchanged → COMMIT',
    '    3. canonical marker with the identical id already present → ROLLBACK, nothing changed (idempotent)',
    '    4. any other existing state, including a structurally different table → ROLLBACK and refuse',
    '  never executed: DROP, TRUNCATE, DELETE, UPDATE, ALTER, GRANT, REVOKE; application data untouched',
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
    config = readTestConfig(deps.readEnvFile());
  } catch {
    config = { ok: false };
  }
  if (!config.ok) return fail('config', `${TEST_VAR} is missing or malformed in .env.development (value not shown)`);

  let backup = null;
  if (parsed.backup !== null) {
    try {
      backup = await deps.openBackup(parsed.backup);
    } catch {
      backup = { ok: false, reason: 'artifact could not be verified' };
    }
  }
  try {
    return await run(parsed, config, backup, deps, fail);
  } finally {
    // Local cleanup never replaces the installer's outcome; a leftover private
    // snapshot is reported with a fixed line (no path, no error text).
    if (backup?.ok && !(await confirmed(() => backup.dispose()))) {
      deps.error(`${PREFIX} WARNING: the private verified-backup snapshot could not be removed (path not shown)`);
    }
  }
}

async function run(parsed, config, backup, deps, fail) {
  const { markerId } = parsed;
  const pinned = config.pinnedMarkerId;
  const refMatches = parsed.confirmProjectRef === null ? null : matchesProjectRef(config.testUrl, parsed.confirmProjectRef);

  if (parsed.mode === 'dry-run') {
    const pinnedStatus =
      pinned === undefined ? `NOT SET — add ${MARKER_VAR}=${markerId} to .env.development before --execute`
        : pinned === markerId ? 'matches --marker-id'
          : 'DIFFERS from --marker-id (execute will refuse)';
    const backupStatus =
      backup === null ? 'not supplied (required for --execute)'
        : backup.ok ? `verified (${backup.name}, set ${backup.setId}, sha256 ${backup.sha256}, archive readable, tables match manifest)`
          : `NOT VERIFIED — ${backup.reason} (execute will refuse)`;
    const refStatus =
      refMatches === null ? 'not supplied (required for --execute)'
        : refMatches ? `matches ${TEST_VAR}`
          : `DOES NOT MATCH ${TEST_VAR} (execute will refuse)`;
    for (const line of [
      `${PREFIX} DRY RUN — no database connection was opened and nothing was written`,
      '  target: TEST',
      `  connection source: ${TEST_VAR} in .env.development (present, well-formed, value not shown); DATABASE_URL is never read`,
      `  marker: ${QUALIFIED}`,
      `  marker id to install: ${markerId}`,
      `  pinned ${MARKER_VAR}: ${pinnedStatus}`,
      `  backup artifact: ${backupStatus}`,
      `  project-ref attestation: ${refStatus}`,
      ...planLines(markerId),
      '  STILL REQUIRED before --execute: a verified TEST backup and explicit owner approval naming the TEST target',
    ]) deps.log(line);
    return 0;
  }

  if (pinned !== markerId) return fail('config', `${MARKER_VAR} in .env.development must be set and equal --marker-id`);
  if (!backup?.ok) return fail('backup', `backup artifact is not a verified TEST backup set: ${backup?.reason ?? 'not supplied'}`);
  if (!refMatches) return fail('target', `--confirm-project-ref does not match ${TEST_VAR} (value not shown)`);

  const secrets = [config.testUrl];
  const client = deps.createClient(config.testUrl);
  let phase = 'connect';
  let inTransaction = false;
  // Cleanup ROLLBACK on a path whose outcome is already decided (conflict, verify,
  // backup, thrown error): lazy and contained, so neither a rejection nor a
  // synchronous throw can replace that outcome. Returns whether it was confirmed.
  // An unconfirmed ROLLBACK never commits anything: no COMMIT is ever sent after it,
  // and the connection is closed in finally.
  const rollback = async () => {
    const ok = await confirmed(() => client.query('ROLLBACK'));
    if (ok) inTransaction = false;
    return ok;
  };
  try {
    await client.connect();
    const stream = client.connection?.stream;
    if (!stream?.encrypted || !stream?.authorized) return fail('connect', 'verified TLS is required');

    phase = 'inspect';
    await client.query('BEGIN');
    inTransaction = true;
    await client.query(PIN_SEARCH_PATH_SQL);
    const decision = decideInstall(await inspectMarker(client), markerId);
    if (decision.action !== 'install') {
      const rolledBack = await rollback();
      if (decision.action === 'conflict') return fail('conflict', `${decision.reason}; nothing was changed`);
      // Idempotent success is reported only when its read transaction is confirmed closed.
      if (!rolledBack) return fail('inspect', 'the read transaction could not be rolled back; nothing was changed');
      deps.log(`${PREFIX} OK — identical canonical marker already installed on TEST; nothing changed`);
      return 0;
    }

    // The gate is "a verified durable backup exists when TEST is mutated": the
    // backup must still be the exact verified inodes, unmodified, at both the
    // first mutation and the commit.
    phase = 'backup';
    if (!backup.assertUnchanged()) {
      await rollback();
      return fail('backup', 'backup artifact changed after verification; nothing was installed');
    }

    phase = 'install';
    for (const statement of buildInstallStatements(markerId)) await client.query(statement);

    phase = 'verify';
    const after = decideInstall(await inspectMarker(client), markerId);
    if (after.action !== 'already-installed') {
      const rolledBack = await rollback();
      return fail('verify', `installed marker failed canonical verification (${after.reason ?? after.action}); ${rolledBack ? 'rolled back' : 'not committed (ROLLBACK unconfirmed; connection closed without COMMIT)'}`);
    }

    phase = 'backup';
    if (!backup.assertUnchanged()) {
      const rolledBack = await rollback();
      return fail('backup', `backup artifact changed after verification; ${rolledBack ? 'rolled back' : 'not committed (ROLLBACK unconfirmed; connection closed without COMMIT)'}`);
    }

    phase = 'commit';
    await client.query('COMMIT');
    inTransaction = false;
    deps.log(`${PREFIX} OK — marker installed on TEST`);
    deps.log(`  marker: ${QUALIFIED}`);
    deps.log(`  marker id: ${markerId}`);
    deps.log(`  backup set: ${backup.name} (${backup.setId})`);
    return 0;
  } catch (err) {
    // The thrown error is the outcome; the cleanup ROLLBACK can never replace it.
    if (inTransaction) await rollback();
    return fail(phase, 'transaction not committed', safeCode(err, secrets));
  } finally {
    // The outcome (including a committed install) is already established; closing
    // the connection can neither replace nor downgrade it.
    await confirmed(() => client.end());
  }
}

// Only run when executed directly; importing from a test never connects.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
