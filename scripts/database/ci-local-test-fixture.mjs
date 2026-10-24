import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_PREPARE_DEPS,
  MARKER_VAR,
  PREPARE_ACTIONS,
  URL_VAR,
  buildPrismaChildEnv,
  createRedactor,
  readPrepareEnvironment,
  runContained,
  staticGates,
} from './local-test-prepare.mjs';
import { runTool } from './local-test-safe-error.mjs';

// CI-only LOCAL_TEST fixture. Prepares the job-local, disposable PostgreSQL 17 of
// GitHub Actions so the API integration tests can run; it is NOT the human
// local-test-prepare workflow and shares none of its authorization flow.
//
//   node scripts/database/ci-local-test-fixture.mjs --marker-id=<uuid>
//
// It fails closed unless every one of these holds, checked before any database
// connection or process is started:
//   - CI === "true" and GITHUB_ACTIONS === "true"; RUNNER_TEMP is an absolute,
//     normalized path;
//   - the environment carries no TEST, DEV, PILOT or hosted-database variable, and
//     LOCAL_TEST_DATABASE_URL is exactly the canonical
//     mona_local_test@127.0.0.1:5432/mona_local_test text (readPrepareEnvironment);
//   - the reviewed migration payload and Prisma config pins pass (staticGates).
// Then, against the live database: the LOCAL_TEST marker is proven by the reviewed
// runtime (database, role, PostgreSQL 17+, no TEST/PILOT marker, marker id), and the
// state must classify exactly FRESH (no application schema, no migration history).
//
// The only mutations are the versioned migrations (the same pinned payload and
// contained `prisma migrate deploy` as local-test-prepare) followed by the minimal
// bootstrap listed in BOOTSTRAP_STEPS; each is bracketed by a fresh identity proof
// and must classify as exactly the expected next state. There is no option other
// than --marker-id: no force, skip or bypass of any kind.
const PREFIX = '[db:ci-local-test-fixture]';
const MARKER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// The reviewed transitions after the migrations: [runtime method, state it must reach].
export const BOOTSTRAP_STEPS = Object.freeze([
  ['seedDemo', 'POST_SEED1'],
  ['backfillCompanyLocations', 'POST_BACKFILL'],
]);

// Variables that name any other database identity. LOCAL_TEST_* are the only ones allowed.
const ALLOWED_IDENTITY_VARS = new Set([URL_VAR, MARKER_VAR]);
const IDENTITY_VAR = /(^|_)(DATABASE|DB|PG|POSTGRES|SUPABASE|PILOT|DEV|DEVELOPMENT|PROD|PRODUCTION|DEMO|STAGING)(_|$)|^TEST_|^MONA_TEST_|^DIRECT_URL$|^SHADOW_/i;

export function parseCiArgs(argv) {
  if (!Array.isArray(argv) || argv.length !== 1) return { ok: false, error: 'Exactly one argument is accepted: --marker-id=<uuid>' };
  const [arg] = argv;
  if (typeof arg !== 'string' || !arg.startsWith('--marker-id=')) return { ok: false, error: 'Unknown argument (not echoed); only --marker-id=<uuid> is accepted' };
  const markerId = arg.slice('--marker-id='.length);
  if (!MARKER_ID.test(markerId)) return { ok: false, error: '--marker-id must be a canonical lowercase version-4 UUID' };
  return { ok: true, markerId };
}

// CI-only gate: GitHub Actions, a normalized absolute RUNNER_TEMP, and no other
// database identity in the environment. Pure; reasons never echo values.
export function checkCiGate(env) {
  if (env.CI !== 'true') return 'CI must be exactly "true"';
  if (env.GITHUB_ACTIONS !== 'true') return 'GITHUB_ACTIONS must be exactly "true"';
  const temp = env.RUNNER_TEMP;
  if (typeof temp !== 'string' || temp === '' || temp.includes('\0') || !path.isAbsolute(temp) || path.normalize(temp) !== temp || temp === path.parse(temp).root) {
    return 'RUNNER_TEMP must be an absolute, normalized, non-root path';
  }
  const foreign = Object.keys(env)
    .filter((key) => env[key] !== undefined && !ALLOWED_IDENTITY_VARS.has(key) && IDENTITY_VAR.test(key))
    .sort();
  if (foreign.length > 0) return `the environment names another database identity: ${foreign.join(', ')} (values not shown)`;
  return null;
}

const must = async (result) => {
  if ((await result) === false) throw new Error('runtime step reported failure');
};

async function migrate(deps, gates) {
  const redact = createRedactor(gates.target.url);
  const env = buildPrismaChildEnv(gates.target.url, deps);
  return runContained(deps, { label: 'prisma', command: gates.spec.command, args: gates.spec.args, options: gates.spec.options, env }, {
    onOut: (line) => deps.log(`  prisma| ${redact(line)}`),
    onErr: (line) => deps.error(`  prisma| ${redact(line)}`),
  });
}

export async function main(argv, overrides = {}) {
  const merged = { ...DEFAULT_PREPARE_DEPS, staticGates, runMigration: migrate, ...overrides };
  const deps = Object.freeze({ ...merged, env: Object.freeze({ ...merged.env }) });
  const fail = (phase, detail) => {
    deps.error(`${PREFIX} FAIL: phase=${phase} — ${detail}`);
    return 1;
  };

  const parsed = parseCiArgs(argv);
  if (!parsed.ok) return fail('args', parsed.error);
  const gate = checkCiGate(deps.env);
  if (gate) return fail('ci-gate', gate);

  // Exact canonical loopback target and pinned marker id, before anything else runs.
  const target = readPrepareEnvironment(deps.env);
  if (!target.ok) return fail('config', target.reason);
  if (target.markerId !== parsed.markerId) return fail('config', `--marker-id does not match ${MARKER_VAR} (values not shown)`);

  const gates = await deps.staticGates({ markerId: parsed.markerId, action: PREPARE_ACTIONS.CHECKPOINT }, deps);
  if (!gates.ok) return fail(gates.phase, gates.detail);

  let runtime;
  let phase = 'runtime';
  try {
    runtime = await deps.loadRuntime(
      { databaseUrl: gates.target.url, markerId: gates.target.markerId, approvedMigrations: gates.payload.migrations },
      deps,
    );
    phase = 'identity';
    await must(runtime.proveIdentity());
    phase = 'classify';
    const initial = await runtime.classify();
    if (initial !== 'FRESH') return fail('classify', `state ${typeof initial === 'string' ? initial : 'UNRECOGNIZED'} is not FRESH; nothing was run`);

    phase = 'prisma';
    const applied = await deps.runMigration(deps, gates);
    if (!applied.ok) return fail('prisma', `${applied.detail}; no later phase was run`);
    const steps = [['migrate', null, 'MIGRATED_EMPTY'], ...BOOTSTRAP_STEPS.map(([method, next]) => [method, method, next])];
    for (const [label, method, next] of steps) {
      phase = 'identity';
      await must(runtime.proveIdentity());
      if (method) {
        phase = label;
        await must(runtime[method]());
        phase = 'identity';
        await must(runtime.proveIdentity());
      }
      phase = 'classify';
      const after = await runtime.classify();
      if (after !== next) return fail('classify', `after ${label} the state is not ${next}; no later phase was run`);
    }
    deps.log(`${PREFIX} OK — disposable CI LOCAL_TEST prepared: exactly ${gates.payload.migrations.length} approved migrations${BOOTSTRAP_STEPS.length ? ` and bootstrap ${BOOTSTRAP_STEPS.map(([m]) => m).join(' → ')}` : ''}`);
    return 0;
  } catch {
    return fail(phase, 'CI LOCAL_TEST step failed; no later phase was run (details not shown)');
  } finally {
    await runtime?.close?.().catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runTool(() => main(process.argv.slice(2)), { prefix: PREFIX });
}
