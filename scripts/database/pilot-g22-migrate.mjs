// OWNER-only guarded rollout of the USER-MGMT migrations on PILOT: EXACT_G20 -> EXACT_G21 -> EXACT_G22 (credentials epoch, then the user administration
// lifecycle). The sibling of pilot-g20-migrate.mjs (G16 -> G20), which is NOT modified and keeps its own contract; its staging and tree verification are
// IMPORTED, not re-implemented.
//
//   node scripts/database/pilot-g22-migrate.mjs --target=pilot --dry-run --marker-id=<uuid> --expected-initial-state=EXACT_G20
//   node scripts/database/pilot-g22-migrate.mjs --target=pilot --execute --marker-id=<uuid> --confirm-project-ref=<ref> \
//     --expected-initial-state=EXACT_G20 --plan=<dry-run digest>
//
// The NORMAL run demands EXACT_G20. EXACT_G21 is accepted only as an explicit RESUME (a previous run applied migration 21 and stopped before 22 was
// proven): it applies migration 22 alone and never re-runs migration 21. EXACT_G19 or older, EXACT_G22, a half-applied G21 or G22 and any schema drift are refused.
//
// ONE migration generation per Prisma deploy, with a read-only WITNESS in between (this is the difference with the G20 tool, which applies its whole tail
// in one deploy): the staged tree of step 1 holds migrations 1..21, the one of step 2 holds 1..22, so `prisma migrate deploy` has exactly one pending
// migration each time. Between the steps the witness must show EXACT_G21 (ledger, schema digest, probes), every existing user at mustChangePassword = false /
// credentialsChangedAt NULL, and the ten frozen business counts (AuditLog included) unchanged; the early refusals (e-mail collision, no operative OWNER) are decided
// again before migration 22 runs. After step 2 the post-check must show EXACT_G22 with the same data guarantees.
//
// SEMANTICS WHEN A STEP FAILS (PostgreSQL gives each migration its own transaction; there is NO transaction around both):
//   - step 1 fails before touching the ledger: the database is still exactly EXACT_G20 → REFUSED (nothing applied), a new plan may retry;
//   - step 1 fails otherwise, or its witness fails → RESTORE_REQUIRED;
//   - step 2 fails and the ledger is still exactly EXACT_G21 → RESUMABLE: a NEW dry run with --expected-initial-state=EXACT_G21 produces the resume plan;
//   - step 2 fails and Prisma left a failed (unfinished) G22 row → the ledger no longer classifies, and since `prisma migrate resolve` is forbidden the
//     only sanctioned path is RESTORE_REQUIRED (the verified EXACT_G20 backup). Migration 22 is one transaction: even then no partial index/table exists.
// Nothing is ever resolved, retried or repaired by this tool.
//
// --dry-run opens no database connection and spawns nothing. The child gets an allowlisted environment, runs under the same Node binary as this wrapper and its
// output is redacted line by line. No URL, host, port, user, password or project ref is printed.
import { createHash } from 'node:crypto';
import { spawn as nodeSpawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  PILOT_URL_FILE, createVerifiedClient, deriveProjectRef, parsePilotUrl, readPrivateUrlFile,
} from './pilot-marker.mjs';
import { PROJECT_REF_PATTERN } from './lib.mjs';
import { LOCK_PIN } from './pilot-migration-states.mjs';
import { pinsOf } from './pilot-migration-generations.mjs';
import { canonicalJson } from './app-schema-projection.mjs';
import { GENERATION_SCHEMA_G22 } from './pilot-g22-schema-references.mjs';
import {
  API_DIR, PRISMA_ARGS, buildChildEnv, createRedactor, resolvePrismaCli,
} from './pilot-migrate.mjs';
import { stageG20Run, verifyG20Tree } from './pilot-g20-migrate.mjs';
import {
  buildTargetBinding, buildToolingBinding, toolingFile, validateTargetBinding, validateToolingBinding,
} from './pilot-plan-binding.mjs';
import { formatCounts, proveIdentity, readSnapshot, runRollout } from './pilot-g22-rollout.mjs';

const PREFIX = '[db:pilot-g22-migrate]';
const URL_FILE_LABEL = '~/.config/mona-jacinta/pilot-database-url';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const MODES = ['dry-run', 'execute'];
const VALUE_ARGS = ['target', 'marker-id', 'confirm-project-ref', 'expected-initial-state', 'plan'];
export const PLAN_FORMAT = 'mona-pilot-g22-migrate-plan/v1';
// The normal initial state and the one explicit resume state; as literals on purpose, so a newer generation can never silently retarget this tool.
export const INITIAL_GENERATIONS = Object.freeze(['EXACT_G20', 'EXACT_G21']);
export const FINAL_GENERATION = 'EXACT_G22';
export const G22_PAYLOAD = Object.freeze({ migrations: pinsOf(FINAL_GENERATION), lock: LOCK_PIN });
const stepPayload = (generation) => Object.freeze({ migrations: pinsOf(generation), lock: LOCK_PIN });
const STAGE_CA = 'scripts/certs/supabase-prod-ca-2021.crt';

// G11-ADV-001: every artifact whose bytes can change what --execute does (this tool and everything it imports that decides or applies).
export const G22_MIGRATE_TOOLING_FILES = Object.freeze([
  toolingFile('module', 'pilot-plan-binding.mjs'),
  toolingFile('module', 'pilot-g22-migrate.mjs'),
  toolingFile('module', 'pilot-g22-rollout.mjs'),
  toolingFile('module', 'pilot-g20-migrate.mjs'),
  toolingFile('module', 'pilot-migrate.mjs'),
  toolingFile('module', 'pilot-migration-states.mjs'),
  toolingFile('module', 'pilot-migration-generations.mjs'),
  toolingFile('module', 'app-schema-projection.mjs'),
  toolingFile('module', 'pilot-schema-references.mjs'),
  toolingFile('module', 'pilot-g16-schema-references.mjs'),
  toolingFile('module', 'pilot-g19-schema-references.mjs'),
  toolingFile('module', 'pilot-g20-schema-references.mjs'),
  toolingFile('module', 'pilot-g22-schema-references.mjs'),
  toolingFile('module', 'pilot-rbac-catalog.mjs'),
  toolingFile('module', 'pilot-rbac-catalog-generations.mjs'),
  toolingFile('module', 'pilot-marker.mjs'),
  toolingFile('module', 'lib.mjs'),
  toolingFile('api', 'prisma.config.ts'),
  toolingFile('api', 'prisma/schema.prisma'),
  toolingFile('repo', STAGE_CA),
]);

// Exact-tree verification of <apiDir>/prisma/migrations against the G22 payload (the repository tree is always the complete 22; each step stages its own prefix).
export function verifyG22Tree(apiDir, payload = G22_PAYLOAD) {
  const r = verifyG20Tree(apiDir, payload);
  return r.ok ? r : { ok: false, reason: r.reason.replace(/\bG20\b/g, 'G22') };
}

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
  if (mode === 'dry-run' && (confirmProjectRef !== null || plan !== null)) return { ok: false, error: '--confirm-project-ref and --plan are accepted only with --execute' };
  if (mode === 'execute' && (confirmProjectRef === null || !PROJECT_REF_PATTERN.test(confirmProjectRef))) {
    return { ok: false, error: '--execute requires --confirm-project-ref=<20-character lowercase project ref>' };
  }
  const initialState = values['expected-initial-state'];
  if (!INITIAL_GENERATIONS.includes(initialState)) return { ok: false, error: `--expected-initial-state must be exactly one of ${INITIAL_GENERATIONS.join(' | ')} (EXACT_G21 only resumes an interrupted run)` };
  if (mode === 'execute' && (plan === null || !HEX64.test(plan))) return { ok: false, error: '--execute requires --plan=<64-hex plan digest printed by the dry run>' };
  return { ok: true, mode, markerId: values['marker-id'], confirmProjectRef, initialState, plan };
}

// The generations this run applies, in order: from EXACT_G20 both; from EXACT_G21 (resume) only EXACT_G22.
export const stepsFrom = (initialState) => (initialState === 'EXACT_G20' ? ['EXACT_G21', 'EXACT_G22'] : ['EXACT_G22']);

// The plan the OWNER approves: one exact target and tooling binding, the initial generation, the exact steps and pins to apply, the exact final ledger, the lock,
// the Prisma command and the schema reference digests of every generation it crosses. Throws when a reference or a binding is missing or malformed. No database.
export function buildPlan({ initialState, payload = G22_PAYLOAD, prismaVersion, schema = GENERATION_SCHEMA_G22, targetBinding, toolingBinding }) {
  if (!validateTargetBinding(targetBinding)) throw new Error('the plan must carry an exact binding of the target (G11-ADV-001)');
  if (!validateToolingBinding(toolingBinding)) throw new Error('the plan must carry an exact binding of the tooling (G11-ADV-001)');
  if (!INITIAL_GENERATIONS.includes(initialState)) throw new Error('unknown initial generation');
  const steps = stepsFrom(initialState);
  const references = {};
  for (const g of [initialState, ...steps]) {
    const digest = schema?.references?.[g]?.digest;
    if (!HEX64.test(String(digest))) throw new Error('schema reference missing');
    references[g] = digest;
  }
  const initial = pinsOf(initialState);
  const plan = {
    format: PLAN_FORMAT, target: 'pilot', targetBinding, toolingBinding, initialState,
    initialLedger: initial.map((m) => m.name),
    steps: steps.map((generation) => ({
      generation, apply: payload.migrations.slice(pinsOf(generation === 'EXACT_G21' ? 'EXACT_G20' : 'EXACT_G21').length, pinsOf(generation).length).map((m) => ({ name: m.name, sha256: m.sha256 })),
    })),
    finalState: FINAL_GENERATION, finalLedger: payload.migrations.map((m) => ({ name: m.name, sha256: m.sha256 })),
    lockSha256: payload.lock.sha256, prisma: { version: prismaVersion, args: [...PRISMA_ARGS] },
    schemaReferences: references,
  };
  return { plan, digest: createHash('sha256').update(canonicalJson(plan)).digest('hex') };
}

function lineForwarder(stream, redact, sink) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  const emit = (text) => {
    pending += text;
    const lines = pending.split('\n');
    pending = lines.pop();
    for (const line of lines) sink(redact(line.replace(/\r$/, '')));
  };
  stream?.on('data', (chunk) => emit(typeof chunk === 'string' ? chunk : decoder.write(chunk)));
  return () => { emit(decoder.end()); if (pending) sink(redact(pending)); pending = ''; };
}

// Resolves once; success is ONLY an observed exit code 0 with no signal.
function runChild(deps, command, args, options, redact) {
  return new Promise((settle) => {
    let child;
    try { child = deps.spawn(command, args, options); } catch { return settle({ ok: false, started: false, detail: 'prisma could not be started' }); }
    const flushOut = lineForwarder(child.stdout, redact, (line) => deps.log(`  prisma| ${line}`));
    const flushErr = lineForwarder(child.stderr, redact, (line) => deps.error(`  prisma| ${line}`));
    child.on('error', () => settle({ ok: false, detail: 'prisma could not be started or failed to run' }));
    child.on('close', (code, signal) => {
      flushOut(); flushErr();
      if (code === 0 && signal === null) settle({ ok: true });
      else if (signal) settle({ ok: false, detail: `prisma was terminated by ${signal}` });
      else if (Number.isInteger(code)) settle({ ok: false, detail: `prisma exited with code ${code}` });
      else settle({ ok: false, detail: 'prisma exit status is unavailable' });
    });
  });
}

const defaultDeps = {
  apiDir: API_DIR,
  moduleDir: path.dirname(fileURLToPath(import.meta.url)),
  urlFile: PILOT_URL_FILE,
  readUrlFile: (file) => readPrivateUrlFile(file),
  env: process.env,
  createClient: createVerifiedClient,
  spawn: nodeSpawn,
  execPath: process.execPath,
  home: os.homedir(),
  tmpdir: os.tmpdir(),
  schema: GENERATION_SCHEMA_G22,
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

// The step runner the orchestrator is given: stages the prefix tree of ONE generation (exact-tree verified twice), runs ONE `prisma migrate deploy` there and
// removes the stage. The repository tree is re-verified immediately before each spawn.
export function makeStepRunner({ deps, prisma, heldUrl, redact, toolingBinding }) {
  return async (generation) => {
    const tree = verifyG22Tree(deps.apiDir);
    if (!tree.ok) return { ok: false, started: false, detail: `${tree.reason}; changed since the initial check` };
    const staged = stageG20Run({ apiDir: deps.apiDir, tmpdir: deps.tmpdir, payload: stepPayload(generation), toolingBinding });
    if (!staged.ok) return { ok: false, started: false, detail: staged.reason };
    try {
      const reverify = staged.verify();
      if (!reverify.ok) return { ok: false, started: false, detail: reverify.reason };
      return await runChild(deps, deps.execPath, [prisma.script, ...PRISMA_ARGS], { cwd: staged.root, env: buildChildEnv(heldUrl, deps), stdio: ['ignore', 'pipe', 'pipe'], shell: false }, redact);
    } finally {
      staged.cleanup();
    }
  };
}

export async function main(argv, deps = defaultDeps) {
  const result = (value) => deps.log(`PILOT_G22_MIGRATE_RESULT=${value}`);
  const fail = (phase, detail) => { deps.error(`${PREFIX} FAIL: phase=${phase} — ${detail}`); return 1; };

  const parsed = parseCliArgs(argv);
  if (!parsed.ok) return fail('args', parsed.error);
  const prisma = resolvePrismaCli(deps.apiDir);
  if (!prisma.ok) return fail('prisma', prisma.reason);

  // The ONLY read of the private file. Everything after uses this in-memory string.
  let file;
  try { file = deps.readUrlFile(deps.urlFile); } catch { file = { ok: false, reason: 'private URL file could not be read' }; }
  if (!file.ok) return fail('config', `${URL_FILE_LABEL}: ${file.reason}`);
  const heldUrl = typeof file.text === 'string' ? file.text.replace(/\r?\n$/, '') : '';
  const parsedUrl = parsePilotUrl(heldUrl);
  if (!parsedUrl.ok) return fail('config', `${URL_FILE_LABEL} must hold one PostgreSQL URL with user, password, host and database and no query/fragment (value not shown)`);
  const payload = verifyG22Tree(deps.apiDir);
  if (!payload.ok) return fail('payload', `${payload.reason}; nothing was started`);
  const redact = createRedactor(heldUrl);

  const projectRef = deriveProjectRef(parsedUrl.conn);
  if (projectRef === null) return fail('target', `${URL_FILE_LABEL} does not carry a derivable project ref; a plan cannot bind its target (nothing was started)`);
  let targetBinding;
  let toolingBinding;
  try {
    targetBinding = buildTargetBinding({ environment: 'pilot', projectRef, host: parsedUrl.conn.host, database: parsedUrl.conn.database, markerId: parsed.markerId });
    toolingBinding = buildToolingBinding({
      moduleDir: deps.moduleDir, apiDir: deps.apiDir, repoDir: path.dirname(String(deps.apiDir).replace(/\/+$/, '')), files: G22_MIGRATE_TOOLING_FILES,
    });
  } catch (error) {
    return fail('binding', `${error?.message ?? 'the target/tooling binding could not be built'}; nothing was started`);
  }
  let planned;
  try {
    planned = buildPlan({ initialState: parsed.initialState, prismaVersion: prisma.version, schema: deps.schema, targetBinding, toolingBinding });
  } catch {
    return fail('reference', `no generated app-schema reference for ${parsed.initialState} .. ${FINAL_GENERATION} (pilot-g22-schema-references.mjs); nothing was started`);
  }

  if (parsed.mode === 'dry-run') {
    for (const line of [
      `${PREFIX} DRY RUN — no database connection was opened and no migration was executed`,
      '  target: PILOT',
      `  private URL file: accepted (${URL_FILE_LABEL}; value not shown; read once, never re-read)`,
      `  marker id: ${parsed.markerId} (syntax accepted; proven against the database only during --execute)`,
      '  project identity: bound to the plan (project ref, host, database, marker id — values not shown); --execute requires --confirm-project-ref to match',
      `  tooling binding: bound (${toolingBinding.files.length} repository artifacts by SHA-256 — values not shown)`,
      `  Prisma CLI: repository-local prisma ${prisma.version}, run with this Node binary`,
      `  migration payload: PASS — exactly ${G22_PAYLOAD.migrations.length} OWNER-approved migrations (G22), SHA-256 approval binding active`,
      ...payload.migrations.map((m, i) => `    ${i + 1}. ${m.name}  sha256 ${m.sha256}`),
      `  migration_lock.toml: PASS (provider "${payload.lock.provider}", sha256 ${payload.lock.sha256})`,
      `  INITIAL_STATE=${parsed.initialState} (explicit; the pre-check refuses any other ledger or schema${parsed.initialState === 'EXACT_G21' ? '; this is a RESUME: migration 21 is NOT run again' : ''})`,
      `    required ledger: exactly ${planned.plan.initialLedger.length} migrations; app schema reference ${planned.plan.schemaReferences[parsed.initialState]}`,
      ...planned.plan.steps.flatMap((s, i) => [
        `  STEP ${i + 1}: ${s.generation} — one \`prisma migrate deploy\` over a staged tree of ${pinsOf(s.generation).length} migrations; app schema reference ${planned.plan.schemaReferences[s.generation]}`,
        ...s.apply.map((m) => `    + ${m.name}  sha256 ${m.sha256}`),
        `    witness: read-only; ledger ${s.generation} exact, schema digest = reference, probes, every user at mustChangePassword=false / credentialsChangedAt NULL, the ten frozen counts unchanged`,
      ]),
      `  FINAL_STATE=${FINAL_GENERATION} (exactly ${G22_PAYLOAD.migrations.length} migrations; app schema reference ${planned.plan.schemaReferences[FINAL_GENERATION]})`,
      '  early refusals (before any change AND again between the steps): case-insensitive e-mail collision, no operative OWNER, schema drift, an unclassifiable ledger or catalog',
      `  post-check: read-only; anything but ${FINAL_GENERATION} with unchanged counts → PILOT_G22_MIGRATE_RESULT=RESTORE_REQUIRED (never resolve, retry or repair)`,
      `  PLAN_DIGEST=${planned.digest}`,
      '  payload is re-verified during --execute: before the identity proof AND again immediately before each spawn',
      '  child cwd: a fresh private staged copy of the approved migration bytes per step (0700/0600, exact-tree verified twice); removed after the step',
      `  command: prisma ${PRISMA_ARGS.join(' ')}`,
      '  never run: seed, reset, migrate dev, db push, migrate resolve, retries; the RBAC catalog is NOT touched by this tool',
      '  STILL REQUIRED before --execute: a verified EXACT_G20 backup + clone restore (pilot-g20-backup / pilot-g20-clone-restore with --expected-state=EXACT_G20), a clean pilot-g22-preflight and explicit OWNER approval naming PILOT and this PLAN_DIGEST (--plan=…)',
    ]) deps.log(line);
    return 0;
  }

  if (parsed.plan !== planned.digest) {
    return fail('plan', 'PLAN_BINDING_MISMATCH: --plan is not the digest of this exact plan binding (target, tooling, payload, states); re-run --dry-run and approve its PLAN_DIGEST; nothing was started');
  }
  if (projectRef !== parsed.confirmProjectRef) return fail('target', `--confirm-project-ref does not match the project addressed by ${URL_FILE_LABEL} (values not shown)`);

  const proof = await proveIdentity(deps, heldUrl, parsed.markerId, redact);
  if (proof !== 0) return fail('identity', 'PILOT identity proof failed; prisma was NOT started');

  const outcome = await runRollout({
    initialState: parsed.initialState,
    readSnapshotNow: (options) => readSnapshot(deps, parsedUrl.conn, parsed.markerId, options),
    applyStep: makeStepRunner({ deps, prisma, heldUrl, redact, toolingBinding }),
    log: (line) => deps.log(`${PREFIX} ${line}`),
    schema: deps.schema,
    fingerprint: deps.fingerprint,
  });

  if (outcome.result === 'MIGRATED') {
    deps.log(`${PREFIX} OK — PILOT is proven ${FINAL_GENERATION} (ledger, schema digest, probes) and the ten frozen counts did not change; next: pilot-g22-verify, then the API deploy`);
    deps.log(`  ROLLOUT_COUNTS=${formatCounts(outcome.snapshot.facts.counts)}`);
    result(FINAL_GENERATION);
    return 0;
  }
  if (outcome.result === 'RESUMABLE') {
    deps.error(`${PREFIX} ${outcome.step}: ${outcome.detail}`);
    deps.error('  PILOT is exactly EXACT_G21. Do not retry: a NEW --dry-run with --expected-initial-state=EXACT_G21 produces the resume plan (migration 21 is not run again).');
    result('RESUMABLE_G21');
    return 1;
  }
  if (outcome.result === 'RESTORE_REQUIRED') {
    deps.error(`${PREFIX} RESTORE_REQUIRED — PILOT is not proven ${FINAL_GENERATION}. Never run \`prisma migrate resolve\`, never retry and never repair by hand: the approved rollback is the restore of the verified EXACT_G20 backup.`);
    deps.error(`  ${outcome.step}: ${outcome.detail}`);
    result('RESTORE_REQUIRED');
    return 1;
  }
  return fail(outcome.step, `${outcome.detail}; prisma was NOT started or nothing was applied`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
