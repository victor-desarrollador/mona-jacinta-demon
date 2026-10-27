// OWNER-only, PILOT-only RBAC catalog upgrade for the G11 cut-over (OWNER 2026-10-18).
//
//   node scripts/database/pilot-rbac-catalog-upgrade.mjs --target=pilot --dry-run --marker-id=<uuid>
//   node scripts/database/pilot-rbac-catalog-upgrade.mjs --target=pilot --execute --marker-id=<uuid> \
//     --confirm-project-ref=<ref> --plan=<dry-run digest>
//
// Adds exactly CASH_MOVEMENT_MANAGE (canonical id 9400/36) and its two default grants
// (ADMIN, CASHIER) to an EXACT CATALOG_35, and nothing else (pilot-rbac-catalog.mjs is
// the pinned source). Runbook step 12: only after pilot-migrate proved EXACT_G11.
//
// --dry-run opens no connection. --execute: the private PILOT URL file is read once; the
// audited pilot-marker --check proves identity on that held URL; then ONE SERIALIZABLE
// transaction with a pinned search_path and timeouts:
//   1. the PILOT marker (ACCESS SHARE lock) is the proven one;
//   2. the Prisma ledger is exactly EXACT_G11 (the schema the new grants serve);
//   3. "Role", "Permission" and "RolePermission" are locked against concurrent writers;
//   4. the complete catalog is read and classified:
//        exact CATALOG_36 → ROLLBACK, verified no-op (idempotent);
//        exact CATALOG_35 → two parameterized INSERTs (1 permission, 2 grants), the catalog
//                           is re-read in the SAME transaction and must be exactly
//                           CATALOG_36 → COMMIT;
//        anything else    → ROLLBACK, CONFLICT (nothing written, nothing repaired).
// Any error rolls back; nothing is ever retried. A COMMIT whose acknowledgement is lost is
// reported UNKNOWN: verify with A4 (read-only) before anything else. Output never carries a
// URL, host, user, password or project ref.
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import {
  PILOT_URL_FILE, createVerifiedClient, deriveProjectRef, main as pilotMarkerMain, parsePilotUrl, readPrivateUrlFile,
} from './pilot-marker.mjs';
import { PROJECT_REF_PATTERN } from './lib.mjs';
import { LEDGER_SQL, requireState } from './pilot-migration-states.mjs';
import { CATALOG_36, CATALOG_DIGESTS, CATALOG_SQL, UPGRADE_DELTA, classifyCatalog } from './pilot-rbac-catalog.mjs';
import { canonicalJson } from './app-schema-projection.mjs';
import { buildTargetBinding, buildToolingBinding, toolingFile, validateTargetBinding, validateToolingBinding } from './pilot-plan-binding.mjs';

const PREFIX = '[db:pilot-rbac-catalog-upgrade]';
const URL_FILE_LABEL = '~/.config/mona-jacinta/pilot-database-url';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const MODES = ['dry-run', 'execute'];
const VALUE_ARGS = ['target', 'marker-id', 'confirm-project-ref', 'plan'];
export const PLAN_FORMAT = 'mona-pilot-rbac-catalog-upgrade-plan/v2';

// G11-ADV-001: the tooling the upgrade plan binds by hash — the runner itself, the
// pinned RBAC catalog/delta, the audited identity-proof client, the shared ref pattern
// and ledger classifier, the plan-binding helper, and the TLS trust anchor the verified
// client reads when it connects.
export const RBAC_UPGRADE_TOOLING_FILES = Object.freeze([
  toolingFile('module', 'pilot-plan-binding.mjs'),
  toolingFile('module', 'pilot-rbac-catalog-upgrade.mjs'),
  toolingFile('module', 'pilot-rbac-catalog.mjs'),
  toolingFile('module', 'pilot-marker.mjs'),
  toolingFile('module', 'lib.mjs'),
  toolingFile('module', 'pilot-migration-states.mjs'),
  toolingFile('repo', 'scripts/certs/supabase-prod-ca-2021.crt'),
]);

export const UPGRADE_SQL = Object.freeze({
  begin: 'BEGIN ISOLATION LEVEL SERIALIZABLE',
  searchPath: 'SET LOCAL search_path = pg_catalog, pg_temp',
  timeouts: Object.freeze(["SET LOCAL statement_timeout = '60s'", "SET LOCAL lock_timeout = '10s'", "SET LOCAL idle_in_transaction_session_timeout = '120s'"]),
  lockMarker: 'LOCK TABLE mona_pilot_guard.database_identity IN ACCESS SHARE MODE',
  marker: 'SELECT marker_id::text AS marker_id, environment FROM ONLY mona_pilot_guard.database_identity',
  lockCatalog: 'LOCK TABLE public."Role", public."Permission", public."RolePermission" IN SHARE ROW EXCLUSIVE MODE',
  insertPermission: 'INSERT INTO public."Permission" (id, code) VALUES ($1, $2)',
  insertGrants: 'INSERT INTO public."RolePermission" ("roleId", "permissionId") VALUES ($1, $2), ($3, $4)',
});

export function parseCliArgs(argv) {
  const values = {};
  const modes = [];
  for (const arg of argv) {
    if (typeof arg !== 'string' || !arg.startsWith('--')) return { ok: false, error: 'Unexpected positional argument (not echoed)' };
    const body = arg.slice(2);
    if (MODES.includes(body)) { modes.push(body); continue; }
    const eq = body.indexOf('=');
    const key = eq === -1 ? null : body.slice(0, eq);
    if (!key || !VALUE_ARGS.includes(key)) return { ok: false, error: 'Unknown argument (not echoed)' };
    if (key in values) return { ok: false, error: `--${key} may be given only once` };
    values[key] = body.slice(eq + 1);
  }
  if (modes.length !== 1) return { ok: false, error: 'Specify exactly one of --dry-run or --execute' };
  const [mode] = modes;
  if (values.target !== 'pilot') return { ok: false, error: 'Exactly --target=pilot is required' };
  if (!UUID_V4.test(values['marker-id'] ?? '')) return { ok: false, error: '--marker-id must be a canonical lowercase version-4 UUID' };
  const confirmProjectRef = values['confirm-project-ref'] ?? null;
  const plan = values.plan ?? null;
  if (mode === 'dry-run' && (confirmProjectRef !== null || plan !== null)) {
    return { ok: false, error: '--confirm-project-ref and --plan are accepted only with --execute' };
  }
  if (mode === 'execute' && (confirmProjectRef === null || !PROJECT_REF_PATTERN.test(confirmProjectRef))) {
    return { ok: false, error: '--execute requires --confirm-project-ref=<20-character lowercase project ref>' };
  }
  if (mode === 'execute' && (plan === null || !HEX64.test(plan))) {
    return { ok: false, error: '--execute requires --plan=<64-hex plan digest printed by the dry run>' };
  }
  return { ok: true, mode, markerId: values['marker-id'], confirmProjectRef, plan };
}

// The plan the OWNER approves: one exact target binding and one exact tooling binding
// (G11-ADV-001), the exact delta, the exact before/after catalog digests, the required
// ledger state and the exact SQL. Builtins only; no database.
export function buildUpgradePlan({ targetBinding, toolingBinding }) {
  if (!validateTargetBinding(targetBinding)) throw new Error('the plan must carry an exact binding of the target (G11-ADV-001)');
  if (!validateToolingBinding(toolingBinding)) throw new Error('the plan must carry an exact binding of the tooling (G11-ADV-001)');
  const plan = {
    format: PLAN_FORMAT, target: 'pilot', targetBinding, toolingBinding, requiredLedger: 'EXACT_G11',
    from: { catalog: 'CATALOG_35', digest: CATALOG_DIGESTS.CATALOG_35 },
    to: { catalog: 'CATALOG_36', digest: CATALOG_DIGESTS.CATALOG_36 },
    delta: { permission: [...UPGRADE_DELTA.permission], grants: UPGRADE_DELTA.grants.map((g) => [...g]) },
    sql: { insertPermission: UPGRADE_SQL.insertPermission, insertGrants: UPGRADE_SQL.insertGrants },
  };
  return { plan, digest: createHash('sha256').update(canonicalJson(plan)).digest('hex') };
}

const defaultDeps = {
  moduleDir: path.dirname(fileURLToPath(import.meta.url)),
  repoDir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'),
  urlFile: PILOT_URL_FILE,
  readUrlFile: (file) => readPrivateUrlFile(file),
  env: process.env,
  createClient: createVerifiedClient,
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

async function readCatalog(client) {
  const rows = async (sql) => (await client.query(sql)).rows ?? null;
  return { roles: await rows(CATALOG_SQL.roles), permissions: await rows(CATALOG_SQL.permissions), grants: await rows(CATALOG_SQL.grants) };
}

// The catalog step, inside the CALLER's open transaction (after its own identity and EXACT_G11
// ledger proofs): lock the three catalog tables, classify, and for an exact CATALOG_35 insert
// exactly UPGRADE_DELTA and re-classify in the same transaction. It never commits or rolls back.
// Shared by main (PILOT) and the LOCAL_TEST cut-over lab's migration rehearsal, so the rehearsal
// runs the very statements PILOT will run.
export async function upgradeCatalogInTransaction(client) {
  await client.query(UPGRADE_SQL.lockCatalog);
  const before = classifyCatalog(await readCatalog(client));
  if (before.ok && before.catalog === 'CATALOG_36') return { outcome: 'NOOP_VERIFIED', digest: before.digest };
  if (!before.ok) return { outcome: 'CONFLICT', phase: 'catalog', reason: before.reason };
  const roleId = new Map(CATALOG_36.roles.map(([code, id]) => [code, id]));
  const [code, permissionId] = UPGRADE_DELTA.permission;
  await client.query(UPGRADE_SQL.insertPermission, [permissionId, code]);
  await client.query(UPGRADE_SQL.insertGrants, UPGRADE_DELTA.grants.flatMap(([role]) => [roleId.get(role), permissionId]));
  const after = classifyCatalog(await readCatalog(client));
  if (!after.ok || after.catalog !== 'CATALOG_36') return { outcome: 'CONFLICT', phase: 'verify', reason: 'the catalog after the insert is not exactly CATALOG_36' };
  return { outcome: 'UPGRADED', digest: after.digest };
}

export async function main(argv, deps = defaultDeps) {
  const result = (value) => deps.log(`RBAC_UPGRADE_RESULT=${value}`);
  const fail = (phase, detail, value = 'REFUSED') => {
    deps.error(`${PREFIX} FAIL: phase=${phase} — ${detail}`);
    result(value);
    return 1;
  };
  const parsed = parseCliArgs(argv);
  if (!parsed.ok) return fail('args', parsed.error);

  // The ONLY read of the private file (dry-run included: the plan binds the target).
  let file;
  try { file = deps.readUrlFile(deps.urlFile); } catch { file = { ok: false, reason: 'private URL file could not be read' }; }
  if (!file.ok) return fail('config', `${URL_FILE_LABEL}: ${file.reason}`);
  const heldUrl = typeof file.text === 'string' ? file.text.replace(/\r?\n$/, '') : '';
  const parsedUrl = parsePilotUrl(heldUrl);
  if (!parsedUrl.ok) return fail('config', `${URL_FILE_LABEL} must hold one PostgreSQL URL (value not shown)`);
  const projectRef = deriveProjectRef(parsedUrl.conn);
  if (projectRef === null) return fail('target', `${URL_FILE_LABEL} does not carry a derivable project ref; a plan cannot bind its target (nothing was started)`);

  // G11-ADV-001: one exact target binding and one exact tooling binding inside the digest.
  let targetBinding;
  let toolingBinding;
  try {
    targetBinding = buildTargetBinding({ environment: 'pilot', projectRef, host: parsedUrl.conn.host, database: parsedUrl.conn.database, markerId: parsed.markerId });
    toolingBinding = buildToolingBinding({ moduleDir: deps.moduleDir, repoDir: deps.repoDir, files: RBAC_UPGRADE_TOOLING_FILES });
  } catch (error) {
    return fail('binding', `${error?.message ?? 'the target/tooling binding could not be built'}; nothing was started`);
  }
  let planned;
  try {
    planned = buildUpgradePlan({ targetBinding, toolingBinding });
  } catch (error) {
    return fail('binding', `${error?.message ?? 'the plan could not be built'}; nothing was started`);
  }

  if (parsed.mode === 'dry-run') {
    const roleId = new Map(CATALOG_36.roles.map(([code, id]) => [code, id]));
    for (const line of [
      `${PREFIX} DRY RUN — no database connection was opened and nothing was written`,
      '  target: PILOT (private URL file read once; value never shown)',
      `  marker id: ${parsed.markerId} (proven against the database only during --execute)`,
      '  project identity: bound to the plan (project ref, host, database, marker id — values not shown); --execute requires --confirm-project-ref to match',
      '  tooling binding: bound (7 repository artifacts by SHA-256 — values not shown)',
      '  required: ledger EXACT_G11 (run only after pilot-migrate proved it), the PILOT marker, one SERIALIZABLE transaction',
      `  from CATALOG_35 (digest ${CATALOG_DIGESTS.CATALOG_35}) to CATALOG_36 (digest ${CATALOG_DIGESTS.CATALOG_36})`,
      `  + permission ${UPGRADE_DELTA.permission[0]} id ${UPGRADE_DELTA.permission[1]}`,
      ...UPGRADE_DELTA.grants.map(([role, perm]) => `  + grant ${role} (${roleId.get(role)}) → ${perm}`),
      '  exact CATALOG_36 already → verified no-op; any other catalog → CONFLICT, ROLLBACK, nothing written',
      '  never: DELETE, UPDATE, DDL, retries; an unacknowledged COMMIT is UNKNOWN (verify with A4 first)',
      `  PLAN_DIGEST=${planned.digest}`,
      '  STILL REQUIRED before --execute: explicit OWNER approval naming PILOT and this PLAN_DIGEST (--plan=…)',
    ]) deps.log(line);
    return 0;
  }
  if (parsed.plan !== planned.digest) return fail('plan', 'PLAN_BINDING_MISMATCH: --plan is not the digest of this exact plan binding (target, tooling, delta); re-run --dry-run and approve its PLAN_DIGEST; nothing was started');

  if (projectRef !== parsed.confirmProjectRef) return fail('target', '--confirm-project-ref does not match the addressed project (values not shown)');

  const proof = await pilotMarkerMain(['--target=pilot', '--check', `--marker-id=${parsed.markerId}`], {
    urlFile: deps.urlFile, readUrlFile: () => ({ ok: true, text: heldUrl }), env: deps.env, createClient: deps.createClient,
    log: () => {}, error: () => {},
  });
  if (proof !== 0) return fail('identity', 'PILOT identity proof failed; nothing was written');

  let client;
  try { client = deps.createClient(parsedUrl.conn); } catch { return fail('connect', 'client could not be created'); }
  let open = false;
  const rollback = async () => { if (!open) return; open = false; try { await client.query('ROLLBACK'); } catch { /* closed below; nothing committed */ } };
  try {
    await client.connect();
    const stream = client.connection?.stream;
    if (stream?.encrypted !== true || stream?.authorized !== true) return fail('connect', 'verified TLS is required');
    await client.query(UPGRADE_SQL.begin);
    open = true;
    await client.query(UPGRADE_SQL.searchPath);
    for (const sql of UPGRADE_SQL.timeouts) await client.query(sql);
    await client.query(UPGRADE_SQL.lockMarker);
    const marker = (await client.query(UPGRADE_SQL.marker)).rows ?? [];
    if (marker.length !== 1 || marker[0].marker_id !== parsed.markerId || marker[0].environment !== 'pilot') {
      await rollback();
      return fail('marker', 'the PILOT marker is not the proven one; nothing was written');
    }
    const ledger = requireState((await client.query(LEDGER_SQL)).rows, 'EXACT_G11');
    if (!ledger.ok) {
      await rollback();
      return fail('ledger', `${ledger.reason}; the catalog upgrade runs only on EXACT_G11; nothing was written`);
    }
    const step = await upgradeCatalogInTransaction(client);
    if (step.outcome === 'NOOP_VERIFIED') {
      await rollback();
      deps.log(`${PREFIX} OK — the catalog is already exactly CATALOG_36 (digest ${step.digest}); nothing was written`);
      result('NOOP_VERIFIED');
      return 0;
    }
    if (step.outcome === 'CONFLICT') {
      await rollback();
      return fail(step.phase, `${step.reason}; ${step.phase === 'verify' ? 'rolled back, ' : ''}nothing was written`, 'CONFLICT');
    }
    const after = step;
    open = false;
    try {
      await client.query('COMMIT');
    } catch {
      deps.error(`${PREFIX} COMMIT was not acknowledged: the outcome is UNKNOWN. Do not retry; verify read-only with A4 first.`);
      result('UNKNOWN');
      return 1;
    }
    deps.log(`${PREFIX} OK — CATALOG_35 → CATALOG_36 committed (digest ${after.digest}); 1 permission and 2 grants added`);
    result('UPGRADED');
    return 0;
  } catch {
    await rollback();
    return fail('transaction', 'a database error occurred; rolled back, nothing was written, nothing is retried');
  } finally {
    try { await client.end(); } catch { /* already closed */ }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
