// PILOT G20 rollout: generator of the app-schema references of EXACT_G16 .. EXACT_G20 (pilot-g20-schema-references.mjs). The sibling of
// pilot-schema-reference.mjs (G7..G14 states), which is NOT modified. EXACT_G16 is the CONTROL: its pinned digest must be reproduced
// byte for byte by this method before the G17 .. G20 values it prints are trusted (G16 .. G19 are already pinned by the G19 module; G20 is the new one).
//
//   LOCAL_TEST_DATABASE_URL=… LOCAL_TEST_DATABASE_MARKER_ID=… \
//     node scripts/database/pilot-g20-schema-reference.mjs --target=local-test \
//       --expected-state=EXACT_G16|EXACT_G17|EXACT_G18|EXACT_G19|EXACT_G20 --system-identifier=<decimal>
//
// READ ONLY. It connects only to the canonical disposable LOCAL_TEST loopback target
// (local-test-marker.mjs config), proves it (live facts, exactly one canonical marker row
// with the configured id, pg_control_system().system_identifier = the OWNER-given value),
// then, inside one READ ONLY REPEATABLE READ transaction with search_path pinned, requires
// the ledger to be EXACTLY the expected state, reads the app-owned schema projection, runs
// the reviewed semantic probes (all must pass) and PRINTS the reference entry. It never
// writes the repository: the OWNER reviews the printed entry and pastes it into
// SCHEMA_REFERENCES_G20. The database must have been built from nothing with exactly the
// state's migrations by an approved recipe; this tool does not build or migrate anything.
//
// Exit codes: 0 printed, 1 arguments, 2 identity refused, 3 state/probes refused, 4 error.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertLiveFacts, LIVE_FACTS_SQL, MARKER_ROWS_SQL, readLocalTestMarkerConfig } from './local-test-marker.mjs';
import { projectionDigest, projectionSummary, readProjection, runProbes, PINNED_SEARCH_PATH } from './app-schema-projection.mjs';
import { LEDGER_SQL } from './pilot-migration-states.mjs';
import { requireGeneration } from './pilot-migration-generations.mjs';
import { GENERATION_PROBES_G20 as STATE_PROBES } from './pilot-g20-schema-references.mjs';

const PREFIX = '[db:pilot-g20-schema-reference]';
export const G20_REFERENCE_STATES = Object.freeze(['EXACT_G16', 'EXACT_G17', 'EXACT_G18', 'EXACT_G19', 'EXACT_G20']);
const SYSTEM_ID = /^[1-9][0-9]{15,20}$/;
export const REFERENCE_SQL = Object.freeze({
  systemIdentifier: 'SELECT system_identifier::text AS system_identifier FROM pg_catalog.pg_control_system()',
  begin: 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
  pinSearchPath: `SELECT pg_catalog.set_config('search_path', '${PINNED_SEARCH_PATH}', true)`,
  rollback: 'ROLLBACK',
});

export function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.length !== 3) return { ok: false };
  const out = {};
  for (const a of argv) {
    const m = /^--(target|expected-state|system-identifier)=(.*)$/.exec(a);
    if (!m || Object.hasOwn(out, m[1])) return { ok: false };
    out[m[1]] = m[2];
  }
  if (out.target !== 'local-test' || !G20_REFERENCE_STATES.includes(out['expected-state']) || !SYSTEM_ID.test(out['system-identifier'] ?? '')) return { ok: false };
  return { ok: true, expectedState: out['expected-state'], systemIdentifier: out['system-identifier'] };
}

// The printed, reviewable entry for SCHEMA_REFERENCES (one line, deterministic).
export function renderReferenceEntry(state, projection) {
  const s = projectionSummary(projection);
  const summary = Object.entries(s).map(([k, v]) => `${k}: ${v}`).join(', ');
  return `  ${state}: Object.freeze({ digest: '${projectionDigest(projection)}', summary: Object.freeze({ ${summary} }) }),`;
}

const defaultDeps = {
  env: process.env,
  createClient: async (conn) => {
    const { default: pg } = await import('pg');
    return new pg.Client({ ...conn, application_name: 'mona-pilot-g20-schema-reference', connectionTimeoutMillis: 10000, query_timeout: 60000 });
  },
  log: (l) => console.log(l),
  error: (l) => console.error(l),
};

export async function main(argv, overrides = {}) {
  const deps = { ...defaultDeps, ...overrides };
  const end = (result, rc) => { deps.log(`SCHEMA_REFERENCE_RESULT=${result}`); return rc; };
  const refuse = (phase, reason, rc) => { deps.error(`${PREFIX} REFUSED: phase=${phase} — ${reason}`); return end('REFUSED', rc); };

  const args = parseArgs(argv);
  if (!args.ok) return refuse('args', 'exactly --target=local-test, --expected-state=EXACT_G16|EXACT_G17|EXACT_G18|EXACT_G19|EXACT_G20 and a decimal --system-identifier are accepted', 1);
  const config = readLocalTestMarkerConfig(deps.env);
  if (!config.ok) return refuse('config', config.reason, 2);

  let client;
  try {
    client = await deps.createClient(config.conn);
    await client.connect();
  } catch {
    return refuse('connect', 'the LOCAL_TEST connection could not be opened (details not shown)', 4);
  }
  try {
    const [f] = (await client.query(LIVE_FACTS_SQL)).rows;
    const factsError = assertLiveFacts({ currentDatabase: f?.current_database, currentUser: f?.current_user, version: f?.version,
      testGuardExists: f?.test_guard_exists, pilotGuardExists: f?.pilot_guard_exists });
    if (factsError) return refuse('identity', factsError, 2);
    const markers = (await client.query(MARKER_ROWS_SQL)).rows;
    if (markers.length !== 1 || markers[0].environment !== 'local_test' || markers[0].marker_id !== config.markerId || markers[0].has_installed_at !== true) {
      return refuse('identity', 'the LOCAL_TEST marker is not exactly the configured one (ids not shown)', 2);
    }
    const sid = (await client.query(REFERENCE_SQL.systemIdentifier)).rows[0]?.system_identifier;
    if (sid !== args.systemIdentifier) return refuse('identity', 'pg_control_system().system_identifier differs from --system-identifier', 2);
    deps.log(`${PREFIX} identity proven (LOCAL_TEST loopback, marker, system_identifier)`);

    await client.query(REFERENCE_SQL.begin);
    try {
      await client.query(REFERENCE_SQL.pinSearchPath);
      const ledger = requireGeneration((await client.query(LEDGER_SQL)).rows, args.expectedState);
      if (!ledger.ok) return refuse('state', `ledger: ${ledger.reason}`, 3);
      const projection = await readProjection(client);
      const failed = runProbes(projection, STATE_PROBES[args.expectedState]);
      if (failed.length) { for (const x of failed) deps.error(`${PREFIX} ${x}`); return refuse('probes', `${failed.length} semantic probe(s) failed`, 3); }
      deps.log(`${PREFIX} ${args.expectedState} ledger exact, ${STATE_PROBES[args.expectedState].length} probes passed`);
      deps.log(renderReferenceEntry(args.expectedState, projection));
      return end('PRINTED', 0);
    } finally {
      await client.query(REFERENCE_SQL.rollback).catch(() => {});
    }
  } catch {
    return refuse('read', 'an unexpected error occurred while reading (details not shown)', 4);
  } finally {
    await client.end().catch(() => {});
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).then((rc) => { process.exitCode = rc; }, () => { console.log('SCHEMA_REFERENCE_RESULT=ERROR'); process.exitCode = 4; });
}
