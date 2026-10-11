import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { CA_PATH } from './lib.mjs';
import { parseHostedTestConfig, toConnectionString } from './hosted-test-config.mjs';
import { PROOF_BEGIN_SQL, confirmed, proveInstalledMarkerInTransaction } from './test-marker.mjs';

// D5H preflight (I1a): proves, over ONE connection and inside ONE read-only snapshot,
// (1) that the connected database holds the pinned TEST identity marker and (2) the
// exact recorded Prisma migration history for the requested phase. It writes nothing:
// the only statements it can issue are BEGIN ... READ ONLY, SET LOCAL, LOCK ... ACCESS
// SHARE, SELECT and ROLLBACK. It is incapable of a migration, backup, restore or seed.
//
//   node scripts/database/d5h-preflight.mjs --expect=pre-deploy|post-deploy
//
// Running it against the real repository configuration is a live operation that
// needs its own OWNER authorization; the tests in d5h-preflight.test.mjs use only
// injected fakes. Output is one secret-free JSON line: digests and fixed codes only.
//
// SalePayment guard risk (evidence only): the Block 1 migration adds a BEFORE TRUNCATE
// guard on "SalePayment" that refuses to truncate payments whose Sale has no
// paymentStartedAt (or a later one). Existing payments are never backfilled, so after
// the migration the suite's first truncate would be refused. Inside the SAME snapshot the
// preflight reports whether such rows exist: salePaymentGuardRisk CLEAR | PRESENT. That
// is a POST_MIGRATION_SUITE_BLOCKER, never a migration-deploy blocker, and nothing is
// cleaned up here. pre-deploy counts SalePayment rows joined to their Sale (what the
// exact predicate will match once the column exists); post-deploy runs the exact
// predicate. The CLI expectation stays authoritative: the catalog must agree with it.
//
// History proof, not schema proof: this establishes the exact recorded migration
// ledger (names + SHA-256 checksums), not that the live schema equals the migration
// SQL. Schema-drift fingerprinting is deliberately not part of D5H v1.

const { Client } = pg;

export const FORMAT = 'mona-d5h-preflight/v1';
export const EXPECTATIONS = Object.freeze(['pre-deploy', 'post-deploy']);
const ENV_FILE = new URL('../../.env.development', import.meta.url);
const HOSTED_CONNECT_TIMEOUT_MS = 30_000;

// The six migrations D5H is reviewed against: names and SHA-256 of migration.sql
// (Prisma's ledger `checksum` is that same SHA-256). The first four are the applied
// baseline, the last two are the pending Block 1 / pilot v2 migrations. Kept as D5H's
// own constants (not imported from PILOT tooling); a test pins them to the bytes on disk.
export const D5H_MIGRATIONS = Object.freeze(
  [
    ['20260907015311_init', 'a584edab13a2ae540d694578ffa3b5a622decff04e238a5cf16d3040d295e4cb'],
    ['20260912182432_add_company_location', '19c345aa92c79a0a613dc03ea01dcf10e91b5a75fd6f3535076d8d71b6f740af'],
    ['20260912191702_add_user_role_scope', '2b415411eddc1212bf60419ce49022cea38d1fc2d12cb08938ad7c953caf7f3a'],
    ['20260922210000_d3_initial_stock_and_global_audit', '62b3b169e06a48dc2e2a3f81cee11e02a809b2733db2453c5b9eef91c15f77cf'],
    ['20261002120000_block1_pricing_wholesale', '45cf8d080e8fa4ec0a8dab9c9e5d4b780eb1642f0a8992d43b57dff655250173'],
    ['20261006120000_pilot_pricing_v2', 'd948f74e9c0eed3ce959f5c0e6edea70871d7d5957275f3304922e31bab6df12'],
  ].map(([name, sha256]) => Object.freeze({ name, sha256 })),
);
const BASELINE_APPLIED = 4;

// Only what the classification needs. `logs` (free text that may contain SQL or
// connection detail) and `applied_steps_count` are deliberately never selected.
export const LEDGER_PRESENT_SQL = `SELECT to_regclass('public."_prisma_migrations"') IS NOT NULL AS present`;
export const LEDGER_ROWS_SQL =
  'SELECT migration_name, checksum, (finished_at IS NOT NULL) AS finished, (rolled_back_at IS NOT NULL) AS rolled_back ' +
  'FROM public."_prisma_migrations" ORDER BY started_at ASC, id ASC';

// Pure. `rows` are ledger rows in chronological (started_at) order. Every pinned
// migration gets exactly one status; rows that are not pinned migrations are only
// counted, never named. Distinct failure states are never collapsed.
export function classifyMigrationHistory(rows, pinned = D5H_MIGRATIONS) {
  if (!Array.isArray(rows)) throw new TypeError('ledger rows must be an array');
  const known = new Map(pinned.map((p, i) => [p.name, i]));
  const entries = pinned.map(() => []);
  let unexpected = 0;
  rows.forEach((candidate, position) => {
    const name = candidate !== null && typeof candidate === 'object' ? candidate.migration_name : undefined;
    if (typeof name !== 'string' || !known.has(name)) {
      unexpected += 1;
      return;
    }
    entries[known.get(name)].push({ row: candidate, position });
  });

  const statuses = pinned.map((p, i) => {
    const found = entries[i];
    if (found.length === 0) return 'MISSING';
    if (found.length > 1) return 'DUPLICATE';
    const { row } = found[0];
    if (row.rolled_back === true) return 'ROLLED_BACK';
    if (row.finished !== true) return 'INCOMPLETE';
    if (row.checksum !== p.sha256) return 'CHECKSUM_MISMATCH';
    return 'APPLIED_CLEAN';
  });

  let missingBefore = false;
  let latestPosition = -1;
  statuses.forEach((status, i) => {
    if (status === 'MISSING') missingBefore = true;
    if (status !== 'APPLIED_CLEAN') return;
    const { position } = entries[i][0];
    if (missingBefore || position < latestPosition) statuses[i] = 'ORDERING_GAP';
    else latestPosition = position;
  });

  return Object.freeze({
    migrations: Object.freeze(pinned.map((p, i) => Object.freeze({ name: p.name, status: statuses[i] }))),
    unexpected,
  });
}

// pre-deploy: the four baseline migrations APPLIED_CLEAN and the two pending ones
// MISSING. post-deploy: all six APPLIED_CLEAN. Nothing else passes, and there is no
// default expectation.
export function evaluateExpectation(classification, expectation) {
  if (!EXPECTATIONS.includes(expectation)) throw new TypeError('unknown expectation');
  const statuses = classification.migrations.map((m) => m.status);
  if (classification.unexpected > 0 || statuses.some((s) => s !== 'APPLIED_CLEAN' && s !== 'MISSING')) {
    return { ok: false, code: 'HISTORY_INVALID' };
  }
  const required = statuses.map((_, i) => (expectation === 'post-deploy' || i < BASELINE_APPLIED ? 'APPLIED_CLEAN' : 'MISSING'));
  return statuses.every((s, i) => s === required[i]) ? { ok: true } : { ok: false, code: 'HISTORY_EXPECTATION_MISMATCH' };
}

// Discrete fields only (no connection string), verified TLS against the bundled CA.
export function buildClientConfig(held, ca) {
  return {
    host: held.host,
    port: held.port,
    database: held.database,
    user: held.username,
    password: held.password,
    ssl: { rejectUnauthorized: true, ca },
    connectionTimeoutMillis: HOSTED_CONNECT_TIMEOUT_MS,
  };
}

// Read inside the caller's transaction (same snapshot as the marker proof).
export async function readMigrationHistory(client) {
  const present = await client.query(LEDGER_PRESENT_SQL);
  if (present?.rows?.[0]?.present !== true) return { ledger: 'ABSENT', rows: [] };
  const ledger = await client.query(LEDGER_ROWS_SQL);
  if (!Array.isArray(ledger?.rows)) throw Object.assign(new Error('ledger read returned no rows array'), { code: 'LEDGER_SHAPE' });
  return { ledger: 'PRESENT', rows: ledger.rows };
}

// Catalog + predicate probes. Read-only SELECTs; the exact form is the migration's guard
// predicate verbatim and is only issued once the catalog proves the column exists.
export const GUARD_CATALOG_SQL =
  `SELECT to_regclass('public."Sale"') IS NOT NULL AS sale_table, ` +
  `to_regclass('public."SalePayment"') IS NOT NULL AS payment_table, ` +
  `EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid = to_regclass('public."Sale"') ` +
  `AND a.attname = 'paymentStartedAt' AND a.attnum > 0 AND NOT a.attisdropped) AS column_present`;
const GUARD_JOIN_SQL = 'FROM public."SalePayment" p JOIN public."Sale" s ON s."id" = p."saleId"';
export const GUARD_EQUIVALENT_SQL = `SELECT count(*)::int AS violating ${GUARD_JOIN_SQL}`;
export const GUARD_EXACT_SQL =
  `SELECT count(*)::int AS violating ${GUARD_JOIN_SQL} WHERE s."paymentStartedAt" IS NULL OR p."paidAt" < s."paymentStartedAt"`;

// Returns { column?, predicateForm?, violatingRows?, risk? } or { column?, failure }.
// Only a count leaves this function: no ids, timestamps or row contents.
export async function probeSalePaymentGuard(client, expectation) {
  const catalog = await client.query(GUARD_CATALOG_SQL);
  const row = catalog?.rows?.[0];
  if (!row || [row.sale_table, row.payment_table, row.column_present].some((v) => typeof v !== 'boolean')) {
    return { failure: { phase: 'guard', code: 'GUARD_SHAPE' } };
  }
  if (!row.sale_table || !row.payment_table) return { failure: { phase: 'guard', code: 'GUARD_TABLES_MISSING' } };
  const column = row.column_present ? 'PRESENT' : 'ABSENT';
  if (column !== (expectation === 'post-deploy' ? 'PRESENT' : 'ABSENT')) {
    return { column, failure: { phase: 'guard', code: 'CATALOG_EXPECTATION_MISMATCH' } };
  }
  const predicateForm = expectation === 'post-deploy' ? 'exact' : 'post-migration-equivalent';
  const counted = await client.query(expectation === 'post-deploy' ? GUARD_EXACT_SQL : GUARD_EQUIVALENT_SQL);
  const violatingRows = counted?.rows?.[0]?.violating;
  if (!Number.isSafeInteger(violatingRows) || violatingRows < 0) return { column, failure: { phase: 'guard', code: 'GUARD_SHAPE' } };
  return { column, predicateForm, violatingRows, risk: violatingRows > 0 ? 'PRESENT' : 'CLEAR' };
}

const defaultDeps = {
  readConfigBytes: () => readFileSync(ENV_FILE),
  createClient: (held) => {
    const client = new Client(buildClientConfig(held, readFileSync(CA_PATH, 'utf8')));
    client.on('error', () => {
      /* Never emit credentials from pg errors; the awaited call fails closed. */
    });
    return client;
  },
  proveMarker: proveInstalledMarkerInTransaction,
  log: (line) => console.log(line),
};

// Failure codes that may leave this process: a 5-character SQLSTATE, an allow-listed
// Node/TLS code, or this module's own LEDGER_SHAPE. Anything else — including a
// well-formed code that is a case-folded fragment of a secret — becomes 'unexpected'.
// Reading `.code` can itself throw on a hostile error object; that must not escape and
// skip cleanup, so it is contained here.
const SAFE_NODE_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH',
  'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'LEDGER_SHAPE',
]);
const fold = (text) => String(text).toUpperCase().replace(/[^0-9A-Z]/g, '');
function failureCode(err, secrets) {
  try {
    const code = err !== null && typeof err === 'object' ? err.code : undefined;
    if (typeof code !== 'string') return 'unexpected';
    if (!/^[0-9A-Z]{5}$/.test(code) && !SAFE_NODE_CODES.has(code)) return 'unexpected';
    const folded = fold(code);
    if (secrets.some((secret) => typeof secret === 'string' && fold(secret).includes(folded))) return 'unexpected';
    return code;
  } catch {
    return 'unexpected';
  }
}

const NOT_EVALUATED = Object.freeze({ status: 'NOT_EVALUATED' });

// Returns the secret-free evidence object. PASS requires: the marker proved, the
// ledger matching the requested phase exactly, a CONFIRMED rollback and a CONFIRMED
// connection close, all inside one read-only snapshot.
export async function runPreflight(args, suppliedDeps = {}) {
  const deps = { ...defaultDeps, ...suppliedDeps };
  const expectation = EXPECTATIONS.includes(args?.expectation) ? args.expectation : null;
  const out = {
    format: FORMAT,
    expectation,
    result: 'FAIL',
    marker: 'NOT_EVALUATED',
    migrationHistory: NOT_EVALUATED,
    paymentStartedAtColumn: 'NOT_EVALUATED',
    salePaymentGuardRisk: 'NOT_EVALUATED',
    predicateForm: null,
    violatingRows: null,
    cleanup: { rollback: 'NOT_APPLICABLE', close: 'NOT_APPLICABLE' },
  };
  const finish = (failure) => {
    if (failure) out.failure = failure;
    out.result = failure ? 'FAIL' : 'PASS';
    return out;
  };

  if (expectation === null) return finish({ phase: 'args', code: 'EXPECTATION_INVALID' });

  let bytes;
  try {
    bytes = deps.readConfigBytes();
  } catch {
    return finish({ phase: 'config', code: 'CONFIG_UNREADABLE' });
  }
  const parsed = parseHostedTestConfig(bytes);
  if (!parsed.ok) return finish({ phase: 'config', code: parsed.code });
  const { held, evidence } = parsed;
  out.targetClass = evidence.targetClass;
  out.targetDigest = evidence.targetDigest;
  out.markerDigest = evidence.markerDigest;

  const secrets = [held.password, held.host, held.username, held.projectRef, held.markerId, toConnectionString(held)];
  const failure = (phase, err) => ({ phase, code: failureCode(err, secrets) });

  let client;
  try {
    client = deps.createClient(held);
  } catch (err) {
    return finish(failure('connect', err));
  }

  let primary = null;
  let connected = false;
  let inTransaction = false;
  try {
    await client.connect();
    connected = true;
  } catch (err) {
    primary = failure('connect', err);
  }
  if (!primary) {
    try {
      await client.query(PROOF_BEGIN_SQL);
      inTransaction = true;
    } catch (err) {
      primary = failure('begin', err);
    }
  }
  if (inTransaction) {
    let verdict = null;
    try {
      verdict = await deps.proveMarker(client, held.markerId);
    } catch (err) {
      primary = failure('proof', err);
    }
    if (!primary) {
      out.marker = verdict?.ok === true ? 'PASS' : 'FAIL';
      if (out.marker === 'FAIL') {
        primary = { phase: 'marker', code: 'MARKER_NOT_PROVEN' };
      } else {
        try {
          const history = await readMigrationHistory(client);
          const classification = classifyMigrationHistory(history.rows);
          const verdictOnHistory = evaluateExpectation(classification, expectation);
          out.migrationHistory = {
            status: verdictOnHistory.ok ? 'PASS' : 'FAIL',
            ledger: history.ledger,
            migrations: classification.migrations.map((m) => ({ name: m.name, status: m.status })),
            unexpected: classification.unexpected,
          };
          if (!verdictOnHistory.ok) primary = { phase: 'history', code: verdictOnHistory.code };
        } catch (err) {
          primary = failure('history', err);
        }
        if (!primary) {
          try {
            const guard = await probeSalePaymentGuard(client, expectation);
            if (guard.column) out.paymentStartedAtColumn = guard.column;
            if (guard.failure) {
              primary = guard.failure;
            } else {
              out.salePaymentGuardRisk = guard.risk;
              out.predicateForm = guard.predicateForm;
              out.violatingRows = guard.violatingRows;
            }
          } catch (err) {
            primary = failure('guard', err);
          }
        }
      }
    }
    const rolledBack = await confirmed(() => client.query('ROLLBACK'));
    out.cleanup.rollback = rolledBack ? 'CONFIRMED' : 'UNCONFIRMED';
  }
  const closed = await confirmed(() => client.end());
  if (connected) out.cleanup.close = closed ? 'CONFIRMED' : 'UNCONFIRMED';

  if (primary) return finish(primary);
  if (out.cleanup.rollback !== 'CONFIRMED') return finish({ phase: 'cleanup', code: 'ROLLBACK_UNCONFIRMED' });
  if (out.cleanup.close !== 'CONFIRMED') return finish({ phase: 'cleanup', code: 'CLOSE_UNCONFIRMED' });
  return finish(null);
}

// Exactly one `--expect=<mode>` and at most one `--require-guard-clear`, in any order;
// nothing else is accepted and nothing defaults.
function parseArgs(argv) {
  if (!Array.isArray(argv)) return null;
  let expectation = null;
  let expectCount = 0;
  let clearCount = 0;
  for (const token of argv) {
    const hit = /^--expect=(.*)$/.exec(token);
    if (hit) {
      expectCount += 1;
      expectation = hit[1];
    } else if (token === '--require-guard-clear') {
      clearCount += 1;
    } else {
      return null;
    }
  }
  if (expectCount !== 1 || clearCount > 1 || !EXPECTATIONS.includes(expectation)) return null;
  return { expectation, requireGuardClear: clearCount === 1 };
}

// Exit codes: 0 PASS (a PRESENT guard risk alone is still 0), 1 proof FAIL, 2 usage
// error (before any config or connection), 3 proofs valid but the guard risk is not
// CLEAR and --require-guard-clear was given.
export async function main(argv, suppliedDeps = {}) {
  const deps = { ...defaultDeps, ...suppliedDeps };
  const args = parseArgs(argv);
  if (!args) {
    const result = await runPreflight({ expectation: null }, deps);
    deps.log(JSON.stringify(result));
    return 2;
  }
  const result = await runPreflight({ expectation: args.expectation }, deps);
  deps.log(JSON.stringify(result));
  if (result.result !== 'PASS') return 1;
  return args.requireGuardClear && result.salePaymentGuardRisk !== 'CLEAR' ? 3 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
