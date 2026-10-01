import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { closeSync, constants as fsConstants, fstatSync, openSync, readFileSync, realpathSync as fsRealpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { pathToFileURL } from 'node:url';
import { API_DIR, APPROVED_MIGRATION_PAYLOAD, resolvePrismaCli, verifyMigrationPayload } from './pilot-migrate.mjs';

// LOCAL_TEST baseline preparation orchestrator (Task 4).
//
//   node scripts/database/local-test-prepare.mjs --dry-run --marker-id=<uuid>
//   node scripts/database/local-test-prepare.mjs --check --marker-id=<uuid>
//   node scripts/database/local-test-prepare.mjs --execute --marker-id=<uuid> \
//     --confirm-local-target=mona_local_test@127.0.0.1:5432/mona_local_test --plan=<sha256>
//
// Brings the disposable LOCAL_TEST database to the canonical baseline:
// `prisma migrate deploy --config prisma.local-test.config.ts`, demo seed,
// TEST Company/Location convergence, second seed, strict final verification.
// The only target source is LOCAL_TEST_DATABASE_URL (exact canonical loopback
// text) plus the pinned LOCAL_TEST_DATABASE_MARKER_ID. Every DB step runs through
// an injected runtime whose proveIdentity() is the hardened demo-database.ts
// LOCAL_TEST proof; a mutation always follows a fresh successful proof.
//
// Never: the marker (local-test-marker.mjs owns it), databases, roles, users,
// passwords, repairs of unknown state. The approved migration pins are the
// single reviewed set in pilot-migrate.mjs. No URL or password is ever printed.
//
// GREEN6F loads the reviewed runtime only after static gates and the plan
// check. Dry runs never import it or start a process.

export const URL_VAR = 'LOCAL_TEST_DATABASE_URL';
export const MARKER_VAR = 'LOCAL_TEST_DATABASE_MARKER_ID';
export const CONFIRM_LOCAL_TARGET = 'mona_local_test@127.0.0.1:5432/mona_local_test';
export const PRISMA_CONFIG = 'prisma.local-test.config.ts';
export const COMPANY_DESCRIPTOR = 'scripts/test-company-bootstrap.ts';
export const PRISMA_MIGRATE_ARGS = Object.freeze(['migrate', 'deploy', '--config', PRISMA_CONFIG]);
export const PLAN_DOMAIN = 'mona-jacinta-local-test-prepare-plan-v1';
export const CHILD_TIMEOUT_MS = 10 * 60 * 1000;
export const RUNTIME_MODULE = 'scripts/local-test-runtime.ts';

export const PREPARE_STATES = Object.freeze([
  'FRESH',
  'MIGRATED_EMPTY',
  'EXACT_BASELINE',
  'POST_SEED1',
  'POST_BACKFILL',
  'PARTIAL_UNSAFE',
  'OPERATIONAL_DATA',
  'MIGRATION_DRIFT',
  'UNKNOWN',
]);
export const PHASE = Object.freeze({
  MIGRATE: 'migrate',
  SEED: 'seed-demo',
  BACKFILL: 'backfill-company-locations',
  VERIFY: 'verify-baseline',
});
// The reviewed orchestration contract, bound into the plan digest. A state
// decision executes a suffix of the mutating phases; every mutation is preceded
// by a fresh identity proof and every run ends with the strict verifier.
export const PREPARE_PHASES = Object.freeze([
  'static-gates',
  'load-runtime',
  'prove-identity',
  'classify',
  'recheck-payload-and-config',
  PHASE.MIGRATE,
  'prove-identity',
  'classify-expect-MIGRATED_EMPTY',
  'prove-identity',
  PHASE.SEED,
  'prove-identity',
  PHASE.BACKFILL,
  'prove-identity',
  PHASE.SEED,
  PHASE.VERIFY,
]);
// Presence (not truthiness) of any of these refuses before anything is loaded.
export const FORBIDDEN_ENV = Object.freeze([
  'PGOPTIONS',
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_EXTRA_CA_CERTS',
  'DEBUG',
  'DATABASE_URL',
  'DIRECT_URL',
  'SHADOW_DATABASE_URL',
  'TEST_DATABASE_URL',
  'TEST_DATABASE_MARKER_ID',
  'MONA_TEST_DATABASE_TARGET',
]);
export const FORBIDDEN_ENV_PREFIXES = Object.freeze(['PG', 'PRISMA_', 'DOTENV_']);
export const CHILD_ENV_KEYS = Object.freeze([
  'CHECKPOINT_DISABLE',
  'HOME',
  'LOCAL_TEST_DATABASE_URL',
  'NODE_ENV',
  'PATH',
  'PRISMA_HIDE_UPDATE_MESSAGE',
  'TMPDIR',
]);

const PREFIX = '[db:local-test-prepare]';
const LOCAL_HOST = '127.0.0.1';
const LOCAL_PORT = '5432';
const LOCAL_DATABASE = 'mona_local_test';
const LOCAL_USER = 'mona_local_test';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PLAN_DIGEST = /^[0-9a-f]{64}$/;
const MODES = ['dry-run', 'check', 'execute'];
const VALUE_ARGS = ['marker-id', 'confirm-local-target', 'plan'];
const MAX_HASHED_FILE_BYTES = 1024 * 1024;

// Exactly one mode and one canonical --marker-id; --confirm-local-target and
// --plan only (and always) with --execute. Rejected values are never echoed.
export function parsePrepareArgs(argv) {
  const values = {};
  const modes = [];
  for (const arg of argv) {
    if (typeof arg !== 'string' || !arg.startsWith('--')) return { ok: false, error: 'Unexpected positional argument (not echoed)' };
    const body = arg.slice(2);
    if (MODES.includes(body)) {
      if (modes.includes(body)) return { ok: false, error: `--${body} may be given only once` };
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
  const confirm = values['confirm-local-target'] ?? null;
  const plan = values.plan ?? null;
  if (mode !== 'execute' && (confirm !== null || plan !== null)) {
    return { ok: false, error: '--confirm-local-target and --plan are accepted only with --execute' };
  }
  if (mode === 'execute' && confirm !== CONFIRM_LOCAL_TARGET) {
    return { ok: false, error: `--execute requires --confirm-local-target=${CONFIRM_LOCAL_TARGET} exactly` };
  }
  if (mode === 'execute' && (plan === null || !PLAN_DIGEST.test(plan))) {
    return { ok: false, error: '--execute requires --plan=<the exact 64-character lowercase sha256 printed by the reviewed --dry-run>' };
  }
  return { ok: true, mode, markerId, confirm, plan };
}

// The one target: LOCAL_TEST_DATABASE_URL, already the canonical loopback text
// (same rule as readLocalTestTarget and prisma.local-test.config.ts), plus the
// pinned marker id. Values are never echoed.
export function readPrepareEnvironment(env) {
  const fail = (reason) => ({ ok: false, reason });
  const forbidden = Object.keys(env)
    .filter((key) => env[key] !== undefined)
    .filter((key) => FORBIDDEN_ENV.includes(key) || FORBIDDEN_ENV_PREFIXES.some((prefix) => key.startsWith(prefix)))
    .sort();
  if (forbidden.length > 0) {
    return fail(`forbidden variable(s) set in the environment: ${forbidden.join(', ')}; unset them (values not shown)`);
  }
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
  const markerId = env[MARKER_VAR];
  if (typeof markerId !== 'string' || !UUID_V4.test(markerId)) {
    return fail(`${MARKER_VAR} must be a canonical lowercase version-4 UUID (value not shown)`);
  }
  return { ok: true, url: raw, markerId };
}

// Hashes one regular file through a single descriptor (no symlinked final
// component, no FIFO hang, bounded size). Read-only.
export function hashRegularFile(file) {
  let fd;
  try {
    fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch {
    return { ok: false, reason: 'is missing or is a symlink' };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { ok: false, reason: 'is not a regular file' };
    if (st.size > MAX_HASHED_FILE_BYTES) return { ok: false, reason: 'is too large' };
    return { ok: true, sha256: createHash('sha256').update(readFileSync(fd)).digest('hex') };
  } catch {
    return { ok: false, reason: 'could not be read' };
  } finally {
    closeSync(fd);
  }
}

// Exact child invocation: this Node binary runs the repository-local Prisma CLI
// script with the explicit LOCAL_TEST config; argv array only, never a shell.
export function buildPrismaMigrationSpec({ execPath, prisma }) {
  return Object.freeze({
    command: execPath,
    args: Object.freeze([prisma.script, ...PRISMA_MIGRATE_ARGS]),
    options: Object.freeze({ cwd: prisma.cwd, stdio: Object.freeze(['ignore', 'pipe', 'pipe']), shell: false }),
  });
}

// Allowlisted child environment, built fresh: nothing from the invoking shell is
// inherited (any `env` passed alongside is ignored). PATH is fixed (this Node's
// directory plus system dirs); NODE_ENV=production keeps api/src/config/load-env.ts
// off .env.development; telemetry and update checks are off. The marker id is
// not passed: prisma.local-test.config.ts reads LOCAL_TEST_DATABASE_URL only.
export function buildPrismaChildEnv(url, { execPath, home, tmpdir }) {
  return {
    CHECKPOINT_DISABLE: '1',
    HOME: home,
    [URL_VAR]: url,
    NODE_ENV: 'production',
    PATH: [path.dirname(execPath), '/usr/local/bin', '/usr/bin', '/bin'].join(path.delimiter),
    PRISMA_HIDE_UPDATE_MESSAGE: '1',
    TMPDIR: tmpdir,
  };
}

// Pure state → action. Unknown, unsafe, drifted or operational states refuse;
// nothing is ever repaired.
// Every convergent path ends with the strict verifier, EXACT_BASELINE included.
const DECISIONS = Object.freeze({
  FRESH: Object.freeze([PHASE.MIGRATE, PHASE.SEED, PHASE.BACKFILL, PHASE.SEED, PHASE.VERIFY]),
  MIGRATED_EMPTY: Object.freeze([PHASE.SEED, PHASE.BACKFILL, PHASE.SEED, PHASE.VERIFY]),
  EXACT_BASELINE: Object.freeze([PHASE.VERIFY]),
  POST_SEED1: Object.freeze([PHASE.BACKFILL, PHASE.SEED, PHASE.VERIFY]),
  POST_BACKFILL: Object.freeze([PHASE.SEED, PHASE.VERIFY]),
});
export function decidePrepareAction(state) {
  if (typeof state !== 'string' || !Object.hasOwn(DECISIONS, state)) {
    return { ok: false, reason: 'database state is not a known convergent LOCAL_TEST state; nothing is repaired' };
  }
  return { ok: true, phases: [...DECISIONS[state]] };
}

export function preparePhaseList() {
  return PREPARE_PHASES;
}

// Plan body: nested arrays in a fixed order (no object-key order dependence).
// Symbolic target only: never the URL, password, home, tmpdir or env values.
export function buildPreparePlan({ markerId, prisma, apiDir, configSha256, companySha256, payload }) {
  return [
    ['target', CONFIRM_LOCAL_TARGET],
    ['markerId', markerId],
    ['prisma', prisma.version, path.relative(apiDir, prisma.script).split(path.sep).join('/')],
    ['cwd', 'api/'],
    ['argv', ...PRISMA_MIGRATE_ARGS],
    ['config', PRISMA_CONFIG, configSha256],
    ['migrations', ...payload.migrations.map((m) => [m.name, m.sha256])],
    ['lock', payload.lock.provider, payload.lock.sha256],
    ['company', COMPANY_DESCRIPTOR, companySha256],
    ['childEnv', ...CHILD_ENV_KEYS],
    ['phases', ...PREPARE_PHASES],
    ['never', 'marker install/repair', 'database provisioning', 'role or user provisioning', 'migrate dev/reset', 'db push'],
  ];
}
export const canonicalPreparePlan = (plan) => `${PLAN_DOMAIN}\n${JSON.stringify(plan)}\n`;
export const digestPreparePlan = (plan) => createHash('sha256').update(canonicalPreparePlan(plan), 'utf8').digest('hex');

// Redacts the held URL and its password (raw, decoded, percent-encoded). The
// symbolic target identity is not a secret.
export function createRedactor(url) {
  const secrets = new Set([url]);
  try {
    const parsed = new URL(url);
    secrets.add(parsed.password);
    const decoded = decodeURIComponent(parsed.password);
    secrets.add(decoded);
    secrets.add(encodeURIComponent(decoded));
  } catch {
    /* the whole URL is still redacted */
  }
  const ordered = [...secrets].filter((s) => typeof s === 'string' && s.length >= 3).sort((a, b) => b.length - a.length);
  return (line) => ordered.reduce((out, secret) => out.split(secret).join('«redacted»'), line);
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
  return () => {
    emit(decoder.end());
    if (pending) sink(redact(pending));
    pending = '';
  };
}

// Settles once. Success is ONLY exit code 0 with no signal, before the timeout.
function runChild(deps, spec, env, redact) {
  return new Promise((settle) => {
    let child;
    let timer;
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      settle(result);
    };
    try {
      child = deps.spawn(spec.command, [...spec.args], { ...spec.options, stdio: [...spec.options.stdio], env });
    } catch {
      return settle({ ok: false, started: false, detail: 'prisma could not be started' });
    }
    if (!child || typeof child.on !== 'function') {
      return settle({ ok: false, detail: 'prisma child handle is unusable; outcome unknown' });
    }
    timer = setTimeout(() => {
      try {
        child.kill?.('SIGKILL');
      } catch {
        /* the outcome is already a failure */
      }
      finish({ ok: false, detail: 'prisma timed out and was killed' });
    }, deps.childTimeoutMs ?? CHILD_TIMEOUT_MS);
    const flushOut = lineForwarder(child.stdout, redact, (line) => deps.log(`  prisma| ${line}`));
    const flushErr = lineForwarder(child.stderr, redact, (line) => deps.error(`  prisma| ${line}`));
    child.on('error', () => finish({ ok: false, detail: 'prisma could not be started or failed to run' }));
    child.on('close', (code, signal) => {
      flushOut();
      flushErr();
      if (code === 0 && signal === null) finish({ ok: true });
      else if (signal) finish({ ok: false, detail: `prisma was terminated by ${signal}` });
      else if (Number.isInteger(code)) finish({ ok: false, detail: `prisma exited with code ${code}` });
      else finish({ ok: false, detail: 'prisma exit status is unavailable' });
    });
  });
}

// Resolves tsx only from the real, repository-verified api directory. The
// package declaration supplies the pin; the API entry may not escape tsx.
export function resolveTsxApi(apiDir) {
  try {
    const verifiedApiDir = fsRealpathSync(apiDir);
    const apiPackage = JSON.parse(readFileSync(path.join(verifiedApiDir, 'package.json'), 'utf8'));
    const version = apiPackage.devDependencies?.tsx ?? apiPackage.dependencies?.tsx;
    if (typeof version !== 'string' || version === '') throw new Error('missing pin');
    const tsxDir = fsRealpathSync(path.join(verifiedApiDir, 'node_modules', 'tsx'));
    const tsxPackage = JSON.parse(readFileSync(path.join(tsxDir, 'package.json'), 'utf8'));
    const entry = tsxPackage.exports?.['./esm/api']?.import?.default;
    if (typeof entry !== 'string' || entry === '') throw new Error('missing entry');
    const resolvedEntry = fsRealpathSync(path.join(tsxDir, entry));
    if (!resolvedEntry.startsWith(`${tsxDir}${path.sep}`)) throw new Error('external entry');
    return { ok: true, url: pathToFileURL(resolvedEntry).href, version };
  } catch {
    return { ok: false, reason: 'the verified api tsx runtime is unavailable' };
  }
}

async function loadRuntime(input, deps) {
  const runtimeUrl = pathToFileURL(path.join(deps.apiDir, RUNTIME_MODULE)).href;
  let tsImport = deps.tsImport;
  if (typeof tsImport !== 'function') {
    const tsx = resolveTsxApi(deps.apiDir);
    if (!tsx.ok) throw new Error(tsx.reason);
    const api = await import(tsx.url);
    tsImport = api.tsImport;
  }
  if (typeof tsImport !== 'function') throw new Error('tsx API is unavailable');
  const runtimeModule = await tsImport(runtimeUrl, import.meta.url);
  if (!runtimeModule || typeof runtimeModule.createLocalTestRuntime !== 'function') throw new Error('runtime factory is unavailable');
  return runtimeModule.createLocalTestRuntime(input);
}

const DEFAULT_DEPS = Object.freeze({
  env: process.env,
  apiDir: API_DIR,
  execPath: process.execPath,
  home: os.homedir(),
  tmpdir: os.tmpdir(),
  resolvePrismaCli,
  verifyMigrationPayload,
  hashFile: hashRegularFile,
  loadRuntime,
  spawn,
  childTimeoutMs: CHILD_TIMEOUT_MS,
  log: (line) => console.log(line),
  error: (line) => console.error(line),
});

// Static gates shared by every mode. Reads only repository files; no runtime,
// no database, no process.
function staticGates(parsed, deps) {
  const target = readPrepareEnvironment(deps.env);
  if (!target.ok) return { ok: false, phase: 'config', detail: target.reason };
  if (target.markerId !== parsed.markerId) {
    return { ok: false, phase: 'config', detail: `--marker-id does not match ${MARKER_VAR} (values not shown)` };
  }
  const prisma = deps.resolvePrismaCli(deps.apiDir);
  if (!prisma.ok) return { ok: false, phase: 'prisma', detail: prisma.reason };
  const config = deps.hashFile(path.join(prisma.cwd, PRISMA_CONFIG));
  if (!config.ok) return { ok: false, phase: 'prisma', detail: `api/${PRISMA_CONFIG} ${config.reason}` };
  const payload = deps.verifyMigrationPayload(deps.apiDir);
  if (!payload.ok) return { ok: false, phase: 'payload', detail: `${payload.reason}; nothing was started` };
  const company = deps.hashFile(path.join(prisma.cwd, COMPANY_DESCRIPTOR));
  if (!company.ok) return { ok: false, phase: 'company', detail: `api/${COMPANY_DESCRIPTOR} ${company.reason}` };
  const plan = buildPreparePlan({
    markerId: parsed.markerId,
    prisma,
    apiDir: prisma.cwd,
    configSha256: config.sha256,
    companySha256: company.sha256,
    payload,
  });
  const spec = buildPrismaMigrationSpec({ execPath: deps.execPath, prisma });
  return { ok: true, target, prisma, config, payload, company, plan, digest: digestPreparePlan(plan), spec };
}

function dryRunLines(s) {
  return [
    `${PREFIX} DRY RUN — no database connection was opened, no runtime was loaded and nothing was executed`,
    `  target: LOCAL_TEST ${CONFIRM_LOCAL_TARGET} (${URL_VAR} accepted; value not shown)`,
    `  marker id: ${s.target.markerId} (equals ${MARKER_VAR}; proven against the database only by --check/--execute)`,
    `  Prisma CLI: repository-local prisma ${s.prisma.version}, run with this Node binary, cwd api/`,
    `  command: prisma ${PRISMA_MIGRATE_ARGS.join(' ')}   (argv only, no shell, never --schema)`,
    `  config: api/${PRISMA_CONFIG} sha256 ${s.config.sha256}`,
    `  migration payload: PASS — exactly ${s.payload.migrations.length} approved migrations (pins: pilot-migrate.mjs)`,
    ...s.payload.migrations.map((m, i) => `    ${i + 1}. ${m.name}  sha256 ${m.sha256}`),
    `  migration_lock.toml: PASS (provider "${s.payload.lock.provider}", sha256 ${s.payload.lock.sha256})`,
    `  TEST Company descriptor: api/${COMPANY_DESCRIPTOR} sha256 ${s.company.sha256}`,
    `  child environment keys: ${CHILD_ENV_KEYS.join(', ')}`,
    `  phases: ${PREPARE_PHASES.join(' → ')}`,
    '  never: marker install/repair, database/role/user provisioning, migrate dev/reset, db push',
    `  plan digest: ${s.digest}`,
    `  --execute requires --confirm-local-target=${CONFIRM_LOCAL_TARGET} --plan=${s.digest}`,
  ];
}

// A runtime method signals failure by throwing; an explicit `false` result is
// treated as a failure too, never as success.
async function must(result) {
  if ((await result) === false) throw new Error('runtime step reported failure');
}
const stateLabel = (state) => (PREPARE_STATES.includes(state) ? state : 'UNRECOGNIZED');

export async function main(argv, overrides = {}) {
  const merged = { ...DEFAULT_DEPS, ...overrides };
  // One snapshot: every target, config and child decision below reads this
  // frozen copy, never the live (mutable) environment object.
  const deps = Object.freeze({ ...merged, env: Object.freeze({ ...merged.env }) });
  const fail = (phase, detail) => {
    deps.error(`${PREFIX} FAIL: phase=${phase} — ${detail}`);
    return 1;
  };

  const parsed = parsePrepareArgs(argv);
  if (!parsed.ok) return fail('args', parsed.error);

  const s = staticGates(parsed, deps);
  if (!s.ok) return fail(s.phase, s.detail);

  if (parsed.mode === 'dry-run') {
    for (const line of dryRunLines(s)) deps.log(line);
    return 0;
  }

  // The reviewed plan must match exactly what would run, before anything loads.
  if (parsed.mode === 'execute' && parsed.plan !== s.digest) {
    return fail('plan', '--plan does not match the plan computed now; review a fresh --dry-run (values not shown)');
  }

  let runtime;
  try {
    const approvedMigrations = Object.freeze(
      s.payload.migrations.map(({ name, sha256 }) => Object.freeze({ name, sha256 })),
    );
    runtime = await deps.loadRuntime(
      Object.freeze({ databaseUrl: s.target.url, markerId: parsed.markerId, approvedMigrations }),
      Object.freeze({ ...deps, apiDir: s.prisma.cwd }),
    );
  } catch {
    return fail('runtime', 'LOCAL_TEST baseline runtime could not be loaded; nothing was started');
  }
  let code;
  try {
    // Runtime evaluation imports the Company descriptor; re-bind the reviewed
    // bytes before any identity proof, classification, mutation or verification.
    const company = deps.hashFile(path.join(s.prisma.cwd, COMPANY_DESCRIPTOR));
    if (!company.ok || company.sha256 !== s.company.sha256) {
      code = fail('company', `api/${COMPANY_DESCRIPTOR} changed after the runtime was loaded; nothing was started`);
    } else {
      code = await (parsed.mode === 'check' ? checkWith(runtime, fail, deps) : executeWith(runtime, s, fail, deps));
    }
  } catch {
    code = fail('company', `api/${COMPANY_DESCRIPTOR} could not be rechecked after the runtime was loaded; nothing was started`);
  }
  let closed = true;
  try {
    await runtime.close();
  } catch {
    closed = false;
  }
  // A close failure never turns a failure into success nor hides the original
  // failure; after a success it is reported as its own failure.
  if (!closed && code === 0) return fail('close', 'LOCAL_TEST baseline runtime could not be closed cleanly');
  return code;
}

async function checkWith(runtime, fail, deps) {
  let phase = 'identity';
  try {
    await must(runtime.proveIdentity());
    phase = 'classify';
    const state = await runtime.classify();
    const decision = decidePrepareAction(state);
    if (!decision.ok) return fail('classify', `state ${stateLabel(state)}: ${decision.reason}`);
    if (state !== 'EXACT_BASELINE') {
      return fail('check', `state ${state}: LOCAL_TEST is not prepared; --execute would run ${decision.phases.join(' → ')}`);
    }
    phase = PHASE.VERIFY;
    await must(runtime.verifyBaseline());
    deps.log(`${PREFIX} CHECK OK — state EXACT_BASELINE, strict verification passed; nothing was changed`);
    return 0;
  } catch {
    return fail(phase, 'LOCAL_TEST check step failed (details not shown); nothing was changed');
  }
}

async function executeWith(runtime, s, fail, deps) {
  const redact = createRedactor(s.target.url);
  let phase = 'identity';
  try {
    await must(runtime.proveIdentity());
    phase = 'classify';
    const state = await runtime.classify();
    const decision = decidePrepareAction(state);
    if (!decision.ok) return fail('classify', `state ${stateLabel(state)}: ${decision.reason}`);

    for (const step of decision.phases) {
      phase = step;
      if (step === PHASE.MIGRATE) {
        // Immediately before the child: the approved payload and the planned
        // LOCAL config must still be exactly what the plan bound.
        const payload = deps.verifyMigrationPayload(deps.apiDir);
        if (!payload.ok) return fail('payload', `${payload.reason}; changed after the plan check — prisma was NOT started`);
        const config = deps.hashFile(path.join(s.prisma.cwd, PRISMA_CONFIG));
        if (!config.ok || config.sha256 !== s.config.sha256) {
          return fail('config', `api/${PRISMA_CONFIG} changed after the plan check — prisma was NOT started`);
        }
        const env = buildPrismaChildEnv(s.target.url, deps);
        const result = await runChild(deps, s.spec, env, redact);
        if (!result.ok) {
          const applied = result.started === false ? 'nothing was applied' : 'migrations may be partially applied';
          return fail('prisma', `${result.detail}; ${applied}; no later phase was run`);
        }
        // Migration success is not identity: prove again, then the database must
        // be exactly the freshly migrated empty state.
        phase = 'identity';
        await must(runtime.proveIdentity());
        phase = 'classify';
        const after = await runtime.classify();
        if (after !== 'MIGRATED_EMPTY') {
          return fail('classify', `after migration the state is ${stateLabel(after)}, not MIGRATED_EMPTY; no later phase was run`);
        }
      } else if (step === PHASE.SEED) {
        await must(runtime.proveIdentity());
        await must(runtime.seedDemo());
      } else if (step === PHASE.BACKFILL) {
        await must(runtime.proveIdentity());
        await must(runtime.backfillCompanyLocations());
      } else if (step === PHASE.VERIFY) {
        await must(runtime.verifyBaseline());
      } else {
        return fail('plan', 'unknown phase; nothing further was run');
      }
    }
    deps.log(`${PREFIX} OK — LOCAL_TEST baseline prepared and strictly verified`);
    return 0;
  } catch {
    return fail(phase, 'LOCAL_TEST step failed; no later phase was run (details not shown)');
  }
}

// Only run when executed directly; importing from a test never loads a runtime.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
