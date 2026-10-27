// READ-ONLY PILOT preflight for the G19 rollout (sale exchange v1 + the void/exchange guard). Zero writes, zero DDL, no Prisma.
// The sibling of pilot-g16-preflight.mjs (G14 → G16), which is NOT modified and keeps its own contract.
//
//   node scripts/database/pilot-g19-preflight.mjs --target=pilot --check --marker-id=<uuid> [--confirm-project-ref=<ref>]
//
// Reports, in one REPEATABLE READ READ ONLY snapshot on a verified-TLS client (pinned search_path and timeouts, read-only
// proven, always ROLLBACK):
//   - identity: the PILOT marker is the named one (the audited pilot-marker --check runs first on the same held URL);
//   - the applied Prisma migrations and the DETECTED GENERATION (EXACT_G14 .. EXACT_G19, or the refusal);
//   - the app-owned schema against the reference of that generation, and the presence of the G17 / G18 / G19 objects. The references of
//     G16, G17, G18 and G19 are PINNED (derived on a disposable PostgreSQL 17.11, pilot-g19-schema-references.mjs). Should a reference ever be
//     null / `pending: true` (a future generation), the schema of that generation is judged by the reviewed PROBES alone (every object present,
//     every later object absent), the report says so, and it never claims a digest match it does not have;
//   - the RBAC catalog (CATALOG_35 .. CATALOG_38, or the refusal);
//   - fixed row counts of the business tables (evidence that the migration changed no data);
//   - a verdict that says which rollout step is next, or why none is.
// It never repairs and never decides: the OWNER does. Output never carries a URL, host, user, password or project ref.
import { pathToFileURL } from 'node:url';
import {
  PILOT_URL_FILE, createVerifiedClient, deriveProjectRef, main as pilotMarkerMain, parsePilotUrl, readPrivateUrlFile,
} from './pilot-marker.mjs';
import { PROJECT_REF_PATTERN } from './lib.mjs';
import { LEDGER_SQL } from './pilot-migration-states.mjs';
import { classifyGenerationLedger } from './pilot-migration-generations.mjs';
import { CATALOG_SQL } from './pilot-rbac-catalog.mjs';
import { classifyCatalogGeneration } from './pilot-rbac-catalog-generations.mjs';
import { projectionDigest, readProjection, runProbes } from './app-schema-projection.mjs';
import { GENERATION_SCHEMA_G19 as GENERATION_SCHEMA } from './pilot-g19-schema-references.mjs';
import { SNAPSHOT_SQL } from './pilot-migrate.mjs';

const PREFIX = '[db:pilot-g19-preflight]';
const URL_FILE_LABEL = '~/.config/mona-jacinta/pilot-database-url';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const VALUE_ARGS = ['target', 'marker-id', 'confirm-project-ref'];

// Business tables that exist from G14 on; fixed literals, never built from input.
export const COUNT_TABLES = Object.freeze(['Sale', 'SalePayment', 'CashSession', 'CashMovement', 'StockMovement', 'Inventory', 'AuditLog', 'User', 'SaleVoid']);
// Tables that exist only from G18 on: counted only when to_regclass proves they exist, so the same tool reads a G16 database.
export const OPTIONAL_COUNT_TABLES = Object.freeze(['SaleExchange', 'SaleExchangeLine']);
export const COUNT_SQL = Object.freeze(Object.fromEntries([...COUNT_TABLES, ...OPTIONAL_COUNT_TABLES].map((t) => [t, `SELECT count(*)::text AS n FROM ONLY public."${t}"`])));
export const PRESENT_SQL = Object.freeze(Object.fromEntries(OPTIONAL_COUNT_TABLES.map((t) => [t, `SELECT to_regclass('public."${t}"') IS NOT NULL AS present`])));

export function parseCliArgs(argv) {
  const values = {};
  let check = 0;
  for (const arg of argv) {
    if (typeof arg !== 'string' || !arg.startsWith('--')) return { ok: false, error: 'Unexpected positional argument (not echoed)' };
    const body = arg.slice(2);
    if (body === 'check') { check += 1; continue; }
    const eq = body.indexOf('=');
    const key = eq === -1 ? null : body.slice(0, eq);
    if (!key || !VALUE_ARGS.includes(key)) return { ok: false, error: 'Unknown argument (not echoed)' };
    if (key in values) return { ok: false, error: `--${key} may be given only once` };
    values[key] = body.slice(eq + 1);
  }
  if (check !== 1) return { ok: false, error: 'Specify exactly one --check (this tool has no write mode)' };
  if (values.target !== 'pilot') return { ok: false, error: 'Exactly --target=pilot is required' };
  if (!UUID_V4.test(values['marker-id'] ?? '')) return { ok: false, error: '--marker-id must be a canonical lowercase version-4 UUID' };
  const confirmProjectRef = values['confirm-project-ref'] ?? null;
  if (confirmProjectRef !== null && !PROJECT_REF_PATTERN.test(confirmProjectRef)) return { ok: false, error: '--confirm-project-ref must be a 20-character lowercase project ref' };
  return { ok: true, markerId: values['marker-id'], confirmProjectRef };
}

const defaultDeps = {
  urlFile: PILOT_URL_FILE,
  readUrlFile: (file) => readPrivateUrlFile(file),
  env: process.env,
  createClient: createVerifiedClient,
  schema: GENERATION_SCHEMA,
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

// The one read-only snapshot. Returns { ok, ledger, projection, catalog, counts } or { ok: false, reason }.
export async function readPreflightSnapshot(deps, conn, markerId) {
  const fail = (reason) => ({ ok: false, reason });
  let client;
  try { client = deps.createClient(conn); } catch { return fail('a read-only client could not be created'); }
  try {
    await client.connect();
    const stream = client.connection?.stream;
    if (stream?.encrypted !== true || stream?.authorized !== true) return fail('verified TLS is required');
    await client.query(SNAPSHOT_SQL.begin);
    try {
      await client.query(SNAPSHOT_SQL.searchPath);
      for (const sql of SNAPSHOT_SQL.timeouts) await client.query(sql);
      if ((await client.query(SNAPSHOT_SQL.readOnly)).rows?.[0]?.read_only !== 'on') return fail('the snapshot transaction is not read-only');
      const marker = (await client.query(SNAPSHOT_SQL.marker)).rows ?? [];
      if (marker.length !== 1 || marker[0].marker_id !== markerId || marker[0].environment !== 'pilot') return fail('the PILOT marker is not the named one');
      const present = (await client.query(SNAPSHOT_SQL.ledgerPresent)).rows?.[0]?.present === true;
      const ledger = present ? (await client.query(LEDGER_SQL)).rows : [];
      const projection = await readProjection(client);
      const rows = async (sql) => (await client.query(sql)).rows ?? null;
      const catalog = { roles: await rows(CATALOG_SQL.roles), permissions: await rows(CATALOG_SQL.permissions), grants: await rows(CATALOG_SQL.grants) };
      const counts = {};
      for (const table of COUNT_TABLES) counts[table] = (await client.query(COUNT_SQL[table])).rows?.[0]?.n ?? null;
      for (const table of OPTIONAL_COUNT_TABLES) {
        counts[table] = (await client.query(PRESENT_SQL[table])).rows?.[0]?.present === true ? ((await client.query(COUNT_SQL[table])).rows?.[0]?.n ?? null) : 'absent';
      }
      return { ok: true, ledger, projection, catalog, counts };
    } finally {
      try { await client.query(SNAPSHOT_SQL.rollback); } catch { /* closed below; nothing was written */ }
    }
  } catch (err) {
    return fail(typeof err?.message === 'string' && err.message.startsWith('projection: ') ? err.message : 'the read-only snapshot could not be read');
  } finally {
    try { await client.end(); } catch { /* already closed */ }
  }
}

const HEX64 = /^[0-9a-f]{64}$/;
const presentProbes = (schema, generation) => (schema.probes[generation] ?? []).filter((p) => !p.kind.startsWith('absent'));

// Pure: the report and the verdict from one snapshot. The verdict names the NEXT rollout step or the reason there is none.
export function assess(snapshot, schema = GENERATION_SCHEMA) {
  const ledger = classifyGenerationLedger(snapshot.ledger);
  const digest = projectionDigest(snapshot.projection);
  const schemaGeneration = Object.entries(schema.references).find(([, ref]) => ref.digest === digest)?.[0] ?? null;
  const missing = (generation) => runProbes(snapshot.projection, presentProbes(schema, generation));
  const g17Probes = missing('EXACT_G17');
  const g18Probes = missing('EXACT_G18').filter((p) => !presentProbes(schema, 'EXACT_G17').some((q) => JSON.stringify(q) === JSON.stringify(p)));
  const g19Probes = missing('EXACT_G19');
  const catalog = classifyCatalogGeneration(snapshot.catalog);
  const names = Array.isArray(snapshot.ledger) ? snapshot.ledger.map((r) => r?.migration_name).filter((n) => typeof n === 'string').sort() : [];

  // The schema of the ledger's generation: a digest match when its reference is pinned; the full probe set (presence AND absence) when pending.
  const reference = ledger.ok ? schema.references[ledger.state] : undefined;
  const referencePending = ledger.ok && !HEX64.test(String(reference?.digest));
  const probeFailures = ledger.ok && referencePending ? runProbes(snapshot.projection, schema.probes[ledger.state] ?? []) : [];
  const schemaMatches = ledger.ok && (referencePending ? (schema.probes[ledger.state] ?? []).length > 0 && probeFailures.length === 0 : schemaGeneration === ledger.state);

  let verdict;
  let reason;
  if (!ledger.ok) { verdict = 'BLOCKED'; reason = `ledger: ${ledger.reason}`; }
  else if (!(ledger.state in schema.references)) { verdict = 'BLOCKED'; reason = `${ledger.state} is older than G16: run the G16 rollout first (pilot-g16-migrate, from a G16 checkout)`; }
  else if (!schemaMatches) {
    verdict = 'BLOCKED';
    reason = referencePending
      ? `the app schema fails the reviewed ${ledger.state} probes (${probeFailures.length} failing; reference PENDING, probes only)`
      : `the app schema is ${schemaGeneration ?? 'not any reference'} but the ledger is ${ledger.state} (drift)`;
  }
  else if (ledger.state === 'EXACT_G17' || ledger.state === 'EXACT_G18') {
    verdict = `HALF_APPLIED_${ledger.state.slice(6)}`;
    reason = `a previous run stopped before the void guard; resume only with a new approved plan (--expected-initial-state=${ledger.state}); never resolve or repair`;
  }
  else if (!catalog.ok) { verdict = 'BLOCKED'; reason = `catalog: ${catalog.reason}`; }
  else if (ledger.state === 'EXACT_G16' && catalog.catalog === 'CATALOG_37') { verdict = 'READY_FOR_G19_MIGRATION'; reason = 'EXACT_G16 + CATALOG_37: take the verified EXACT_G16 backup and clone restore, then pilot-g19-migrate (it refuses until the G17..G19 schema references are pinned)'; }
  else if (ledger.state === 'EXACT_G16') { verdict = 'BLOCKED'; reason = `EXACT_G16 requires CATALOG_37 for this rollout (found ${catalog.catalog}); finish the G16 rollout (pilot-rbac-catalog-37-upgrade) first`; }
  else if (catalog.catalog === 'CATALOG_37') { verdict = 'G19_READY_FOR_RBAC_38'; reason = 'EXACT_G19 + CATALOG_37: next is pilot-rbac-catalog-38-upgrade, then the API deploy'; }
  else if (catalog.catalog === 'CATALOG_38') { verdict = 'G19_RBAC_38_COMPLETE'; reason = 'EXACT_G19 + CATALOG_38: database side complete; the exchange API may be deployed'; }
  else { verdict = 'BLOCKED'; reason = `EXACT_G19 requires CATALOG_37 or CATALOG_38 (found ${catalog.catalog})`; }
  return { ledger, names, digest, schemaGeneration, referencePending, g17Probes, g18Probes, g19Probes, catalog, counts: snapshot.counts, verdict, reason };
}

export async function main(argv, deps = defaultDeps) {
  const fail = (phase, detail) => { deps.error(`${PREFIX} FAIL: phase=${phase} — ${detail}`); deps.log('PILOT_G19_PREFLIGHT_RESULT=ERROR'); return 1; };
  const parsed = parseCliArgs(argv);
  if (!parsed.ok) return fail('args', parsed.error);

  let file;
  try { file = deps.readUrlFile(deps.urlFile); } catch { file = { ok: false, reason: 'private URL file could not be read' }; }
  if (!file.ok) return fail('config', `${URL_FILE_LABEL}: ${file.reason}`);
  const heldUrl = typeof file.text === 'string' ? file.text.replace(/\r?\n$/, '') : '';
  const parsedUrl = parsePilotUrl(heldUrl);
  if (!parsedUrl.ok) return fail('config', `${URL_FILE_LABEL} must hold one PostgreSQL URL (value not shown)`);
  if (parsed.confirmProjectRef !== null && deriveProjectRef(parsedUrl.conn) !== parsed.confirmProjectRef) {
    return fail('target', '--confirm-project-ref does not match the project addressed by the private URL file (values not shown)');
  }

  const proof = await pilotMarkerMain(['--target=pilot', '--check', `--marker-id=${parsed.markerId}`], {
    urlFile: deps.urlFile, readUrlFile: () => ({ ok: true, text: heldUrl }), env: deps.env, createClient: deps.createClient,
    log: () => {}, error: () => {},
  });
  if (proof !== 0) return fail('identity', 'PILOT identity proof failed; nothing else was read');

  const snapshot = await readPreflightSnapshot(deps, parsedUrl.conn, parsed.markerId);
  if (!snapshot.ok) return fail('snapshot', snapshot.reason);
  const report = assess(snapshot, deps.schema);

  for (const line of [
    `${PREFIX} READ-ONLY — nothing was written (REPEATABLE READ READ ONLY, always ROLLBACK)`,
    '  identity: PILOT marker proven (values not shown)',
    `  project ref: ${parsed.confirmProjectRef === null ? 'not checked (no --confirm-project-ref)' : 'matches --confirm-project-ref'}`,
    `  applied migrations: ${report.names.length}`,
    ...report.names.map((n, i) => `    ${i + 1}. ${n}`),
    `  ledger generation: ${report.ledger.ok ? report.ledger.state : `UNCLASSIFIED (${report.ledger.reason})`}`,
    `  app schema digest: ${report.digest} (= ${report.schemaGeneration ?? 'no known reference'}${report.referencePending ? '; the reference of this generation is PENDING, judged by probes only' : ''})`,
    `  G17 objects (enum labels): ${report.g17Probes.length === 0 ? 'present' : `missing ${report.g17Probes.length}`}`,
    `  G18 objects (tables, columns, constraints, indexes, functions, triggers): ${report.g18Probes.length === 0 ? 'all present' : `missing ${report.g18Probes.length}`}`,
    `  G19 objects (the void/exchange guards): ${report.g19Probes.length === 0 ? 'all present' : `missing ${report.g19Probes.length}`}`,
    `  RBAC catalog: ${report.catalog.ok ? `${report.catalog.catalog} (digest ${report.catalog.digest})` : `UNCLASSIFIED (${report.catalog.reason})`}`,
    ...Object.entries(report.counts).map(([table, n]) => `  rows ${table}: ${n}`),
    `  VERDICT=${report.verdict} — ${report.reason}`,
  ]) deps.log(line);
  deps.log(`PILOT_G19_PREFLIGHT_RESULT=${report.verdict}`);
  return report.verdict === 'BLOCKED' ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
