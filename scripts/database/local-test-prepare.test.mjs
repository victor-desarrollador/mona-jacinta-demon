// Zero-database unit tests for scripts/database/local-test-prepare.mjs.
// Run with: node --test scripts/database/local-test-prepare.test.mjs
// Hermetic: synthetic loopback URL, injected fake static checks, an injected fake
// LOCAL_TEST runtime (or, for the default loadRuntime, an injected fake tsImport
// returning a fake api/scripts/local-test-runtime.ts module) and an injected fake
// spawn: no database, no Prisma, no real tsx import and no child process. Only A6
// and A8 read the real repository tree, read-only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CHILD_ENV_KEYS,
  CONFIRM_LOCAL_TARGET,
  PREPARE_PHASES,
  PREPARE_STATES,
  PRISMA_CONFIG,
  PRISMA_MIGRATE_ARGS,
  buildPrismaChildEnv,
  buildPrismaMigrationSpec,
  buildPreparePlan,
  canonicalPreparePlan,
  createRedactor,
  decidePrepareAction,
  digestPreparePlan,
  hashRegularFile,
  main,
  parsePrepareArgs,
  preparePhaseList,
  readPrepareEnvironment,
} from './local-test-prepare.mjs';
// RED6F: exports the GREEN6F orchestrator adds are looked up on the namespace, so
// their absence is an assertion failure, never a module link error.
import * as prepareModule from './local-test-prepare.mjs';
import { APPROVED_MIGRATION_PAYLOAD } from './pilot-migrate.mjs';

const SOURCE = readFileSync(new URL('./local-test-prepare.mjs', import.meta.url), 'utf8');
// Code lines only (comments may cite the marker tool or SQL for documentation).
const CODE = SOURCE.split('\n').filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line)).join('\n');

const MARKER = 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f';
const OTHER = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const SECRET = 'Loc4lPrepS3cret';
const URL_TEXT = `postgresql://mona_local_test:${SECRET}@127.0.0.1:5432/mona_local_test`;
const ENV = Object.freeze({ LOCAL_TEST_DATABASE_URL: URL_TEXT, LOCAL_TEST_DATABASE_MARKER_ID: MARKER });
const CANARY = 'prep-hostile-canary';
const HOSTILE_URL = `postgresql://postgres:${CANARY}@10.9.9.9:5432/postgres`;
const API = '/synthetic/api';
const SCRIPT = `${API}/node_modules/prisma/build/index.js`;
const EXEC = '/synthetic/node/bin/node';
const HOME = '/synthetic/home';
const TMP = '/synthetic/tmp';
const CONFIG_HASH = `hash:${PRISMA_CONFIG}`;
const COMPANY_HASH = 'hash:test-company-bootstrap.ts';
const COMPANY_FILE = 'test-company-bootstrap.ts';
// The default loadRuntime imports this file (under the verified api/ directory)
// with this module as the tsImport parent.
const RUNTIME_URL = pathToFileURL(path.join(API, 'scripts', 'local-test-runtime.ts')).href;
const PREPARE_URL = new URL('./local-test-prepare.mjs', import.meta.url).href;
const REAL_API_DIR = fileURLToPath(new URL('../../api/', import.meta.url));
const LEAKS = [SECRET, URL_TEXT, CANARY, HOSTILE_URL, HOME, TMP];

const DRY = ['--dry-run', `--marker-id=${MARKER}`];
const CHECK = ['--check', `--marker-id=${MARKER}`];
const EXECUTE = (plan) => ['--execute', `--marker-id=${MARKER}`, `--confirm-local-target=${CONFIRM_LOCAL_TARGET}`, `--plan=${plan}`];
const sha = (label) => createHash('sha256').update(label).digest('hex');
const ANY_PLAN = sha('any syntactically valid plan');

function assertNoLeak(text) {
  for (const leak of LEAKS) assert.ok(!text.includes(leak), `output leaked ${JSON.stringify(leak)}`);
}

// --- fakes ------------------------------------------------------------------------

const fakePayload = () => ({
  ok: true,
  migrations: APPROVED_MIGRATION_PAYLOAD.migrations.map((m) => ({ name: m.name, sha256: m.sha256 })),
  lock: { sha256: APPROVED_MIGRATION_PAYLOAD.lock.sha256, provider: APPROVED_MIGRATION_PAYLOAD.lock.provider },
});
// Everything the runtime is given, and nothing else: the held URL, the pinned
// marker and the approved {name, sha256} projection of the verified payload.
const expectedRuntimeInput = () => ({
  databaseUrl: URL_TEXT,
  markerId: MARKER,
  approvedMigrations: fakePayload().migrations.map(({ name, sha256 }) => ({ name, sha256 })),
});

// Fake LOCAL_TEST runtime. classify() walks `states` (the last one repeats);
// `failOn.<name>` lists the 1-based calls that throw (with the URL in the message).
function fakeRuntime(order, { states = ['FRESH', 'MIGRATED_EMPTY'], failOn = {} } = {}) {
  const counts = {};
  const call = (name) => {
    order.push(name);
    counts[name] = (counts[name] ?? 0) + 1;
    if ((failOn[name] ?? []).includes(counts[name])) throw new Error(`${name} failed on ${URL_TEXT}`);
    return counts[name];
  };
  return {
    counts,
    runtime: {
      proveIdentity: async () => {
        call('prove');
      },
      classify: async () => states[Math.min(call('classify'), states.length) - 1],
      seedDemo: async () => {
        call('seed');
      },
      backfillCompanyLocations: async () => {
        call('backfill');
      },
      verifyBaseline: async () => {
        call('verify');
      },
      close: async () => {
        call('close');
      },
    },
  };
}

function fakeSpawn(order, { code = 0, signal = null, stdout = [], stderr = [], emitError, throwSync, errorThenClose, hang } = {}) {
  const spawned = [];
  const killed = [];
  const spawn = (command, args, options) => {
    spawned.push({ command, args, options });
    order.push('spawn');
    if (throwSync) throw Object.assign(new Error(`spawn failed ${URL_TEXT}`), { code: 'EACCES' });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = (sig) => {
      killed.push(sig);
      return true;
    };
    if (hang) return child;
    setImmediate(() => {
      if (emitError) {
        child.emit('error', Object.assign(new Error(`spawn ${command} ENOENT ${URL_TEXT}`), { code: 'ENOENT' }));
        if (!errorThenClose) return;
      }
      for (const chunk of stdout) child.stdout.write(chunk);
      for (const chunk of stderr) child.stderr.write(chunk);
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit('close', code, signal));
    });
    return child;
  };
  return { spawn, spawned, killed };
}

// One orchestrator run with every dependency faked. `hashes[name]` and
// `payloads` are per-call result lists (the last entry repeats).
async function run(argv, opts = {}) {
  const order = [];
  const out = [];
  const loaded = [];
  const hashCalls = {};
  let payloadCalls = 0;
  const pick = (list, n) => (list && list.length ? list[Math.min(n, list.length) - 1] : undefined);
  const { runtime, counts } = fakeRuntime(order, opts.runtime);
  const spawner = fakeSpawn(order, opts.spawn);
  const deps = {
    env: opts.env ?? { ...ENV },
    apiDir: API,
    execPath: EXEC,
    home: HOME,
    tmpdir: TMP,
    resolvePrismaCli: () => {
      order.push('resolve');
      return opts.prisma ?? { ok: true, cwd: API, script: SCRIPT, version: '7.10.0' };
    },
    verifyMigrationPayload: () => {
      order.push('payload');
      payloadCalls += 1;
      return pick(opts.payloads, payloadCalls) ?? fakePayload();
    },
    hashFile: (file) => {
      const name = path.basename(file);
      order.push(`hash:${name}`);
      hashCalls[name] = (hashCalls[name] ?? 0) + 1;
      return pick(opts.hashes?.[name], hashCalls[name]) ?? { ok: true, sha256: sha(name) };
    },
    loadRuntime: async (target) => {
      order.push('loadRuntime');
      loaded.push(target);
      if (opts.loadFails) throw new Error(`cannot load ${URL_TEXT}`);
      return runtime;
    },
    spawn: spawner.spawn,
    childTimeoutMs: opts.childTimeoutMs ?? 2000,
    log: (line) => out.push(line),
    error: (line) => out.push(line),
  };
  for (const key of opts.omit ?? []) delete deps[key];
  // `defaultLoadRuntime`: keep the production loadRuntime and observe it through
  // a fake tsImport whose module exports a fake createLocalTestRuntime.
  const imports = [];
  const factoryInputs = [];
  if (opts.defaultLoadRuntime) {
    delete deps.loadRuntime;
    deps.tsImport = async (specifier, parent) => {
      order.push('tsImport');
      imports.push({ specifier, parent });
      if (opts.tsImportFails) throw new Error(`cannot import ${URL_TEXT}`);
      if (opts.moduleWithoutFactory) return {};
      return {
        createLocalTestRuntime: (input) => {
          order.push('factory');
          factoryInputs.push(input);
          return runtime;
        },
      };
    };
  }
  const code = await main(argv, deps);
  const after = order.findIndex((step) => step === 'loadRuntime' || step === 'tsImport');
  return {
    code,
    order,
    runtimeOrder: after === -1 ? [] : order.slice(after),
    text: out.join('\n'),
    loaded,
    imports,
    factoryInputs,
    counts,
    spawned: spawner.spawned,
    killed: spawner.killed,
  };
}

// The operator flow: the digest printed by the reviewed --dry-run.
async function planFor(opts = {}, argv = DRY) {
  const r = await run(argv, opts);
  const match = /plan digest: ([0-9a-f]{64})/.exec(r.text);
  assert.ok(match, 'dry-run printed no plan digest');
  return match[1];
}
async function execute(opts = {}) {
  return run(EXECUTE(opts.plan ?? (await planFor({ env: opts.env }))), opts);
}
const afterSpawn = (r) => r.order.slice(r.order.indexOf('spawn') + 1);
const MUTATIONS = ['spawn', 'seed', 'backfill'];

// --- A. imports / scaffold safety ---------------------------------------------------

test('A1 exposes the orchestrator seams and the contract constants', () => {
  for (const fn of [parsePrepareArgs, readPrepareEnvironment, buildPrismaMigrationSpec, buildPrismaChildEnv, buildPreparePlan,
    canonicalPreparePlan, digestPreparePlan, decidePrepareAction, preparePhaseList, createRedactor, hashRegularFile, main]) {
    assert.equal(typeof fn, 'function');
  }
  assert.equal(CONFIRM_LOCAL_TARGET, 'mona_local_test@127.0.0.1:5432/mona_local_test');
  assert.equal(PRISMA_CONFIG, 'prisma.local-test.config.ts');
  assert.deepEqual([...PRISMA_MIGRATE_ARGS], ['migrate', 'deploy', '--config', 'prisma.local-test.config.ts']);
  assert.ok(Object.isFrozen(PRISMA_MIGRATE_ARGS) && Object.isFrozen(PREPARE_PHASES) && Object.isFrozen(CHILD_ENV_KEYS));
  assert.deepEqual([...PREPARE_STATES], ['FRESH', 'MIGRATED_EMPTY', 'EXACT_BASELINE', 'POST_SEED1', 'POST_BACKFILL',
    'PARTIAL_UNSAFE', 'OPERATIONAL_DATA', 'MIGRATION_DRIFT', 'UNKNOWN']);
});

// RED6F contract evolution: node:child_process is now allowed (the default spawn).
// tsx stays out of the static imports: it is not resolvable from scripts/database
// (only api/node_modules has it), so the orchestrator may load its API only
// through a single computed import of the verified api/ copy (A8). Still no pg,
// Prisma, marker tool, require/createRequire or literal dynamic import.
test('A2 imports nothing DB-capable, no Prisma, no static tsx and no marker tool; child_process only for the default spawn', () => {
  const specifiers = [...SOURCE.matchAll(/\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1] ?? m[2]);
  const allowed = ['node:child_process', 'node:crypto', 'node:fs', 'node:os', 'node:path', 'node:string_decoder', 'node:url', './pilot-migrate.mjs'];
  for (const s of specifiers) assert.ok(allowed.includes(s), `unexpected import ${s}`);
  assert.doesNotMatch(SOURCE, /\brequire\s*\(|createRequire/);
  assert.ok(!specifiers.some((s) => s === 'tsx' || s.startsWith('tsx/')), 'tsx must not be imported statically');
  assert.ok((CODE.match(/\bimport\s*\(/g) ?? []).length <= 1, 'at most one (the verified tsx API) dynamic import');
  assert.doesNotMatch(CODE, /PrismaClient|PrismaPg|@prisma\/|\bnew\s+Pool\b/);
});

test('A3 migration pins come only from pilot-migrate.mjs: no SHA-256 literal is duplicated here', () => {
  assert.match(SOURCE, /import\s*\{[^}]*\bAPPROVED_MIGRATION_PAYLOAD\b[^}]*\}\s*from\s*'\.\/pilot-migrate\.mjs'/);
  assert.match(SOURCE, /import\s*\{[^}]*\bverifyMigrationPayload\b[^}]*\}\s*from\s*'\.\/pilot-migrate\.mjs'/);
  assert.doesNotMatch(SOURCE, /[0-9a-f]{64}/);
});

test('A4 direct execution is guarded and process.env is read only by the default deps', () => {
  assert.match(SOURCE, /if \(process\.argv\[1\] && import\.meta\.url === pathToFileURL\(process\.argv\[1\]\)\.href\)/);
  assert.equal(CODE.match(/process\.env/g)?.length, 1);
  assert.doesNotMatch(CODE, /\benv(\.|\[['"])(DATABASE_URL|DIRECT_URL|TEST_DATABASE_URL)\b/);
});

// RED6F contract evolution: the defaults are no longer permanently unwired; they
// are wired but lazy. A runtime that cannot be imported or built still fails
// closed at phase=runtime (A5a); a loadable one is imported exactly once, only by
// --check/--execute after the static gates (A5b, A5c).
test('A5a a default runtime that cannot be imported or built fails at phase=runtime: nothing proven, nothing spawned', async () => {
  for (const opts of [{ tsImportFails: true }, { moduleWithoutFactory: true }]) {
    const r = await run(CHECK, { defaultLoadRuntime: true, ...opts });
    assert.equal(r.code, 1);
    assert.match(r.text, /phase=runtime/);
    assert.equal(r.counts.prove, undefined);
    assert.equal(r.spawned.length, 0);
    assertNoLeak(r.text);
  }
});

test('A5b the default loadRuntime tsImports the runtime once from the verified api/ directory and builds it from the reviewed input', async () => {
  const check = await run(CHECK, { defaultLoadRuntime: true, runtime: { states: ['EXACT_BASELINE'] } });
  assert.equal(check.code, 0, check.text);
  assert.deepEqual(check.imports, [{ specifier: RUNTIME_URL, parent: PREPARE_URL }]);
  assert.deepEqual(check.factoryInputs, [expectedRuntimeInput()]);
  assert.deepEqual(check.runtimeOrder, ['tsImport', 'factory', COMPANY_HASH, 'prove', 'classify', 'verify', 'close']);

  // The path follows the realpath Prisma resolution verified (prisma.cwd), not deps.apiDir, HOME or cwd.
  const moved = await run(CHECK, {
    defaultLoadRuntime: true,
    runtime: { states: ['EXACT_BASELINE'] },
    prisma: { ok: true, cwd: '/synthetic/real-api', script: '/synthetic/real-api/node_modules/prisma/build/index.js', version: '7.10.0' },
  });
  assert.deepEqual(moved.imports.map((i) => i.specifier), [pathToFileURL('/synthetic/real-api/scripts/local-test-runtime.ts').href]);

  const exec = await execute({ defaultLoadRuntime: true });
  assert.equal(exec.code, 0, exec.text);
  assert.equal(exec.imports.length, 1);
  assert.deepEqual(exec.factoryInputs, [expectedRuntimeInput()]);
  assert.equal(exec.factoryInputs[0].databaseUrl, exec.spawned[0].options.env.LOCAL_TEST_DATABASE_URL);
});

test('A5c dry-run and a plan mismatch never import the runtime or spawn, even with the default loadRuntime', async () => {
  for (const argv of [DRY, EXECUTE(ANY_PLAN)]) {
    const r = await run(argv, { defaultLoadRuntime: true });
    assert.equal(r.imports.length, 0);
    assert.equal(r.factoryInputs.length, 0);
    assert.equal(r.spawned.length, 0);
    assert.deepEqual(r.runtimeOrder, []);
  }
});

test('A6 dry-run against the real repository tree (read-only default static deps) passes every static gate', async () => {
  const out = [];
  const code = await main(DRY, { env: { ...ENV }, log: (l) => out.push(l), error: (l) => out.push(l) });
  const text = out.join('\n');
  assert.equal(code, 0, text);
  assert.match(text, /plan digest: [0-9a-f]{64}/);
  for (const m of APPROVED_MIGRATION_PAYLOAD.migrations) assert.ok(text.includes(`${m.name}  sha256 ${m.sha256}`));
  assertNoLeak(text);
});

test('A7 the default spawn is node:child_process spawn, reached only through runChild; the scaffold stubs are gone', () => {
  assert.match(CODE, /^import \{ spawn \} from 'node:child_process';$/m);
  assert.doesNotMatch(CODE, /unwired/);
  const defaults = /const DEFAULT_DEPS = Object\.freeze\(\{([\s\S]*?)\n\}\);/.exec(CODE);
  assert.ok(defaults, 'DEFAULT_DEPS not found');
  assert.match(defaults[1], /^\s*spawn(\s*:\s*spawn)?,\s*$/m);
  assert.equal([...CODE.matchAll(/(?<![\w.])spawn\s*\(/g)].length, 0, 'spawn is only ever called as deps.spawn inside runChild');
  assert.equal((CODE.match(/\bdeps\.spawn\s*\(/g) ?? []).length, 1);
});

test('A8 the tsx API comes only from the verified api/ copy, pinned to api/package.json (read-only resolution, nothing imported)', () => {
  const { resolveTsxApi, RUNTIME_MODULE } = prepareModule;
  assert.equal(typeof resolveTsxApi, 'function', 'local-test-prepare.mjs does not export resolveTsxApi');
  assert.equal(RUNTIME_MODULE, 'scripts/local-test-runtime.ts');
  const apiDir = realpathSync(REAL_API_DIR);
  const tsxDir = path.join(apiDir, 'node_modules', 'tsx');
  const tsxPkg = JSON.parse(readFileSync(path.join(tsxDir, 'package.json'), 'utf8'));
  const apiPkg = JSON.parse(readFileSync(path.join(apiDir, 'package.json'), 'utf8'));
  const pinned = apiPkg.devDependencies?.tsx ?? apiPkg.dependencies?.tsx;
  const entry = realpathSync(path.join(tsxDir, tsxPkg.exports['./esm/api'].import.default));
  assert.deepEqual(resolveTsxApi(apiDir), { ok: true, url: pathToFileURL(entry).href, version: pinned });
  const missing = resolveTsxApi('/synthetic/missing-api');
  assert.equal(missing.ok, false);
  assert.ok(!JSON.stringify(missing).includes('/synthetic/missing-api'));
});

// --- B. CLI -------------------------------------------------------------------------

test('B1 exactly one mode and a canonical marker; --execute also needs the exact confirmation and a plan', () => {
  assert.deepEqual(parsePrepareArgs(DRY), { ok: true, mode: 'dry-run', markerId: MARKER, confirm: null, plan: null });
  assert.deepEqual(parsePrepareArgs(CHECK), { ok: true, mode: 'check', markerId: MARKER, confirm: null, plan: null });
  assert.deepEqual(parsePrepareArgs(EXECUTE(ANY_PLAN)), { ok: true, mode: 'execute', markerId: MARKER, confirm: CONFIRM_LOCAL_TARGET, plan: ANY_PLAN });
});

test('B2 rejects malformed, duplicate, positional, unknown and mode-inappropriate arguments without echoing them', () => {
  const m = `--marker-id=${MARKER}`;
  const c = `--confirm-local-target=${CONFIRM_LOCAL_TARGET}`;
  const p = `--plan=${ANY_PLAN}`;
  const cases = [
    [], [m], ['--dry-run', '--check', m], ['--dry-run', '--dry-run', m], ['--dry-run', m, m], ['--execute', m, c, p, p],
    ['--execute', m, c, c, p], [`${CANARY}`, '--dry-run', m], ['--dry-run', m, `--${CANARY}=1`], ['--dry-run=1', m], ['--dry-run'],
    ['--dry-run', `--marker-id=${MARKER.toUpperCase()}`], ['--dry-run', '--marker-id=c1d2e3f4-a5b6-1c7d-8e9f-0a1b2c3d4e5f'],
    ['--dry-run', m, c], ['--dry-run', m, p], ['--check', m, c], ['--check', m, p], ['--execute', m, p], ['--execute', m, c],
    ['--execute', m, `--confirm-local-target=${CANARY}@127.0.0.1:5432/mona_local_test`, p],
    ['--execute', m, c, `--plan=${ANY_PLAN.slice(1)}`], ['--execute', m, c, `--plan=${ANY_PLAN}0`],
    ['--execute', m, c, `--plan=${ANY_PLAN.toUpperCase()}`], ['--execute', m, c, `--plan=${'g'.repeat(64)}`], ['--execute', m, c, '--plan'],
    ['--dry-run', m, 42],
  ];
  for (const argv of cases) {
    const r = parsePrepareArgs(argv);
    assert.equal(r.ok, false, `accepted ${JSON.stringify(argv)}`);
    assert.ok(!r.error.includes(CANARY));
  }
});

test('B3 --marker-id must equal LOCAL_TEST_DATABASE_MARKER_ID; refused before any static read', async () => {
  const r = await run(DRY, { env: { ...ENV, LOCAL_TEST_DATABASE_MARKER_ID: OTHER } });
  assert.equal(r.code, 1);
  assert.match(r.text, /phase=config/);
  assert.deepEqual(r.order, []);
  assert.ok(!r.text.includes(OTHER));
});

// --- C. environment isolation ----------------------------------------------------------

test('C1 LOCAL_TEST_DATABASE_URL must be the exact canonical loopback text', async () => {
  for (const url of [
    undefined, '', 'not a url', HOSTILE_URL,
    `postgresql://mona_local_test:${SECRET}@localhost:5432/mona_local_test`,
    `postgresql://mona_local_test:${SECRET}@127.0.0.1:5433/mona_local_test`,
    `postgresql://mona_local_test:${SECRET}@127.0.0.1:5432/mona_local_test?options=-c%20search_path%3Dpublic`,
    `postgresql://mona_local_test@127.0.0.1:5432/mona_local_test`, ` ${URL_TEXT}`, `${URL_TEXT}\n`, URL_TEXT.replace('postgresql', 'POSTGRESQL'),
  ]) {
    const env = { ...ENV, LOCAL_TEST_DATABASE_URL: url };
    if (url === undefined) delete env.LOCAL_TEST_DATABASE_URL;
    const r = await run(DRY, { env });
    assert.equal(r.code, 1, `accepted ${JSON.stringify(url)}`);
    assert.match(r.text, /phase=config/);
    assert.deepEqual(r.order, []);
    assertNoLeak(r.text);
  }
});

for (const [name, value] of [
  ['PGOPTIONS', '-c search_path=public'],
  ['PGOPTIONS', ''],
  ['NODE_OPTIONS', `--require /tmp/${CANARY}.cjs`],
  ['NODE_OPTIONS', ''],
  ['NODE_PATH', `/tmp/${CANARY}`],
  ['NODE_EXTRA_CA_CERTS', `/tmp/${CANARY}.pem`],
  ['DEBUG', 'prisma:*'],
  ['DATABASE_URL', HOSTILE_URL],
  ['DIRECT_URL', HOSTILE_URL],
  ['TEST_DATABASE_URL', HOSTILE_URL],
  ['TEST_DATABASE_MARKER_ID', OTHER],
  ['MONA_TEST_DATABASE_TARGET', 'local'],
  ['PGHOST', '10.9.9.9'],
  ['PGPASSWORD', CANARY],
  ['PGSSLMODE', 'disable'],
  ['PRISMA_QUERY_ENGINE_LIBRARY', `/tmp/${CANARY}.so`],
  ['DOTENV_KEY', CANARY],
]) {
  test(`C2 ambient ${name}=${JSON.stringify(value)} refuses in every mode before any static read, runtime or spawn`, async () => {
    for (const argv of [DRY, CHECK, EXECUTE(ANY_PLAN)]) {
      const r = await run(argv, { env: { ...ENV, [name]: value } });
      assert.equal(r.code, 1, `${argv[0]} accepted ambient ${name}`);
      assert.match(r.text, /phase=config/);
      assert.deepEqual(r.order, []);
      assertNoLeak(r.text);
      assert.ok(!r.text.includes(OTHER));
    }
  });
}

test('C3 the Prisma child environment is a fresh allowlist: exact keys, the held URL, nothing ambient', () => {
  const ambient = { ...ENV, DATABASE_URL: HOSTILE_URL, NODE_OPTIONS: `--require ${CANARY}`, PATH: '/evil/bin', PGHOST: '10.9.9.9', DEBUG: '*', PRISMA_X: '1' };
  const env = buildPrismaChildEnv(URL_TEXT, { env: ambient, execPath: EXEC, home: HOME, tmpdir: TMP });
  assert.deepEqual(Object.keys(env).sort(), [...CHILD_ENV_KEYS]);
  assert.deepEqual(env, {
    CHECKPOINT_DISABLE: '1',
    HOME,
    LOCAL_TEST_DATABASE_URL: URL_TEXT,
    NODE_ENV: 'production',
    PATH: ['/synthetic/node/bin', '/usr/local/bin', '/usr/bin', '/bin'].join(path.delimiter),
    PRISMA_HIDE_UPDATE_MESSAGE: '1',
    TMPDIR: TMP,
  });
});

// --- D. migration spec ------------------------------------------------------------------

test('D1 migration spec: this Node binary, the local Prisma script, the explicit LOCAL config, api/ cwd, no shell, no --schema', () => {
  const spec = buildPrismaMigrationSpec({ execPath: EXEC, prisma: { cwd: API, script: SCRIPT, version: '7.10.0' } });
  assert.equal(spec.command, EXEC);
  assert.deepEqual([...spec.args], [SCRIPT, 'migrate', 'deploy', '--config', 'prisma.local-test.config.ts']);
  assert.deepEqual({ ...spec.options, stdio: [...spec.options.stdio] }, { cwd: API, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
  assert.ok(!spec.args.some((a) => a.startsWith('--schema')));
  assert.ok(Object.isFrozen(spec) && Object.isFrozen(spec.args) && Object.isFrozen(spec.options));
});

test('D2 execute spawns exactly that spec once, with the allowlisted environment', async () => {
  const r = await execute();
  assert.equal(r.spawned.length, 1);
  const [{ command, args, options }] = r.spawned;
  assert.equal(command, EXEC);
  assert.deepEqual(args, [SCRIPT, 'migrate', 'deploy', '--config', 'prisma.local-test.config.ts']);
  assert.equal(options.cwd, API);
  assert.equal(options.shell, false);
  assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.deepEqual(Object.keys(options.env).sort(), [...CHILD_ENV_KEYS]);
  assert.equal(options.env.LOCAL_TEST_DATABASE_URL, URL_TEXT);
});

// --- E. migration payload pins --------------------------------------------------------------

test('E1 dry-run lists exactly the pilot-migrate approved migrations, in order', async () => {
  const r = await run(DRY);
  const positions = APPROVED_MIGRATION_PAYLOAD.migrations.map((m) => r.text.indexOf(`${m.name}  sha256 ${m.sha256}`));
  assert.ok(positions.every((p) => p >= 0));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
  assert.match(r.text, /pilot-migrate\.mjs/);
});

test('E2 a static payload failure stops every mode before the runtime', async () => {
  for (const argv of [DRY, CHECK, EXECUTE(ANY_PLAN)]) {
    const r = await run(argv, { payloads: [{ ok: false, reason: 'synthetic drift' }] });
    assert.equal(r.code, 1);
    assert.match(r.text, /phase=payload/);
    assert.deepEqual(r.runtimeOrder, []);
    assert.equal(r.spawned.length, 0);
  }
});

test('E3 execute re-verifies the payload and the LOCAL config immediately before spawning', async () => {
  const r = await execute();
  const i = r.order.indexOf('spawn');
  assert.deepEqual(r.order.slice(i - 3, i), ['classify', 'payload', CONFIG_HASH]);
});

test('E4 a payload change caught by the pre-spawn recheck stops before spawning', async () => {
  const plan = await planFor();
  const r = await execute({ plan, payloads: [fakePayload(), { ok: false, reason: 'changed' }] });
  assert.equal(r.code, 1);
  assert.equal(r.spawned.length, 0);
  assert.match(r.text, /phase=payload/);
  assert.deepEqual(r.runtimeOrder, ['loadRuntime', COMPANY_HASH, 'prove', 'classify', 'payload', 'close']);
});

test('E5 a config swapped after the reviewed dry-run fails the plan match before the runtime loads', async () => {
  const plan = await planFor();
  const r = await execute({ plan, hashes: { [PRISMA_CONFIG]: [{ ok: true, sha256: sha('swapped config') }] } });
  assert.equal(r.code, 1);
  assert.match(r.text, /phase=plan/);
  assert.deepEqual(r.runtimeOrder, []);
  assert.equal(r.spawned.length, 0);
});

test('E6 a config swapped between the plan match and the spawn stops before spawning', async () => {
  const plan = await planFor();
  const r = await execute({ plan, hashes: { [PRISMA_CONFIG]: [{ ok: true, sha256: sha(PRISMA_CONFIG) }, { ok: true, sha256: sha('swapped') }] } });
  assert.equal(r.code, 1);
  assert.equal(r.spawned.length, 0);
  assert.ok(!r.order.includes('seed'));
});

// --- F. plan digest ---------------------------------------------------------------------------

const PLAN_INPUT = () => ({
  markerId: MARKER,
  prisma: { ok: true, cwd: API, script: SCRIPT, version: '7.10.0' },
  apiDir: API,
  configSha256: sha(PRISMA_CONFIG),
  companySha256: sha('company'),
  payload: fakePayload(),
});

test('F1 the plan digest is deterministic lowercase hex, independent of input key order', async () => {
  const a = PLAN_INPUT();
  const b = Object.fromEntries(Object.entries(PLAN_INPUT()).reverse());
  b.prisma = { version: '7.10.0', script: SCRIPT, cwd: API, ok: true };
  assert.match(digestPreparePlan(buildPreparePlan(a)), /^[0-9a-f]{64}$/);
  assert.equal(digestPreparePlan(buildPreparePlan(a)), digestPreparePlan(buildPreparePlan(b)));
  assert.equal(await planFor(), await planFor());
});

test('F2 every bound input changes the digest', () => {
  const base = digestPreparePlan(buildPreparePlan(PLAN_INPUT()));
  const variants = [
    (p) => { p.markerId = OTHER; },
    (p) => { p.prisma.version = '7.10.1'; },
    (p) => { p.prisma.script = `${API}/node_modules/prisma/build/other.js`; },
    (p) => { p.configSha256 = sha('other config'); },
    (p) => { p.companySha256 = sha('other company'); },
    ...p4((i) => (p) => { p.payload.migrations[i].sha256 = sha(`m${i}`); }),
    (p) => { p.payload.migrations[0].name = '20260907015311_init_x'; },
    (p) => { p.payload.migrations.reverse(); },
    (p) => { p.payload.lock.sha256 = sha('lock'); },
    (p) => { p.payload.lock.provider = 'sqlite'; },
  ];
  const digests = variants.map((mutate) => {
    const p = PLAN_INPUT();
    mutate(p);
    return digestPreparePlan(buildPreparePlan(p));
  });
  for (const d of digests) assert.notEqual(d, base);
  assert.equal(new Set(digests).size, digests.length);
});
function p4(make) {
  return [0, 1, 2, 3].map(make);
}

test('F3 the canonical plan binds target, argv, config, child env keys and phases, and holds no secret', async () => {
  const text = canonicalPreparePlan(buildPreparePlan(PLAN_INPUT()));
  for (const bound of [CONFIRM_LOCAL_TARGET, JSON.stringify(['argv', ...PRISMA_MIGRATE_ARGS]), JSON.stringify(['childEnv', ...CHILD_ENV_KEYS]),
    JSON.stringify(['phases', ...PREPARE_PHASES]), sha(PRISMA_CONFIG), MARKER]) {
    assert.ok(text.includes(bound), `plan does not bind ${bound}`);
  }
  for (const leak of [SECRET, URL_TEXT, HOME, TMP, API]) assert.ok(!text.includes(leak));
});

test('F4 the plan binds the reviewed phase contract: a proof before every mutation, the verifier last', () => {
  assert.equal(preparePhaseList(), PREPARE_PHASES);
  assert.deepEqual([...PREPARE_PHASES], [
    'static-gates', 'load-runtime', 'prove-identity', 'classify', 'recheck-payload-and-config', 'migrate',
    'prove-identity', 'classify-expect-MIGRATED_EMPTY', 'prove-identity', 'seed-demo', 'prove-identity',
    'backfill-company-locations', 'prove-identity', 'seed-demo', 'verify-baseline',
  ]);
});

// --- G. dry-run -------------------------------------------------------------------------------

test('G1 dry-run loads no runtime, proves nothing, spawns nothing and prints a sanitized plan', async () => {
  const r = await run(DRY);
  assert.equal(r.code, 0);
  assert.deepEqual(r.order, ['resolve', CONFIG_HASH, 'payload', COMPANY_HASH]);
  assert.equal(r.loaded.length, 0);
  assert.equal(r.spawned.length, 0);
  assert.match(r.text, /plan digest: [0-9a-f]{64}/);
  assert.match(r.text, /prisma migrate deploy --config prisma\.local-test\.config\.ts/);
  assert.match(r.text, /--execute requires --confirm-local-target=mona_local_test@127\.0\.0\.1:5432\/mona_local_test --plan=[0-9a-f]{64}/);
  assertNoLeak(r.text);
});

// --- H. check ---------------------------------------------------------------------------------

test('H1 check on EXACT_BASELINE proves, classifies, runs the strict read-only verifier and closes', async () => {
  const r = await run(CHECK, { runtime: { states: ['EXACT_BASELINE'] } });
  assert.equal(r.code, 0);
  assert.deepEqual(r.runtimeOrder, ['loadRuntime', COMPANY_HASH, 'prove', 'classify', 'verify', 'close']);
  assert.equal(r.spawned.length, 0);
});

test('H2 check on a convergent but unprepared state reports it and exits non-zero without mutating', async () => {
  for (const state of ['FRESH', 'MIGRATED_EMPTY', 'POST_SEED1', 'POST_BACKFILL']) {
    const r = await run(CHECK, { runtime: { states: [state] } });
    assert.equal(r.code, 1, `check exited 0 on ${state}`);
    assert.deepEqual(r.runtimeOrder, ['loadRuntime', COMPANY_HASH, 'prove', 'classify', 'close']);
    assert.ok(r.text.includes(state));
    assert.equal(r.spawned.length, 0);
  }
});

test('H3 check refuses an unsafe state without mutating', async () => {
  const r = await run(CHECK, { runtime: { states: ['PARTIAL_UNSAFE'] } });
  assert.equal(r.code, 1);
  assert.deepEqual(r.runtimeOrder, ['loadRuntime', COMPANY_HASH, 'prove', 'classify', 'close']);
});

test('H4 check fails when the verifier rejects a classifier-reported EXACT_BASELINE', async () => {
  const r = await run(CHECK, { runtime: { states: ['EXACT_BASELINE'], failOn: { verify: [1] } } });
  assert.equal(r.code, 1);
  assert.ok(r.order.includes('verify'));
  assertNoLeak(r.text);
});

// --- I. state decisions -------------------------------------------------------------------------

for (const [state, phases] of [
  ['FRESH', ['migrate', 'seed-demo', 'backfill-company-locations', 'seed-demo', 'verify-baseline']],
  ['MIGRATED_EMPTY', ['seed-demo', 'backfill-company-locations', 'seed-demo', 'verify-baseline']],
  ['EXACT_BASELINE', ['verify-baseline']],
  ['POST_SEED1', ['backfill-company-locations', 'seed-demo', 'verify-baseline']],
  ['POST_BACKFILL', ['seed-demo', 'verify-baseline']],
]) {
  test(`I ${state} decides ${phases.join(' → ')}`, () => {
    assert.deepEqual(decidePrepareAction(state), { ok: true, phases });
  });
}

test('I6 unsafe, drifted, operational, unknown and malformed states refuse; nothing is repaired', () => {
  for (const state of ['PARTIAL_UNSAFE', 'OPERATIONAL_DATA', 'MIGRATION_DRIFT', 'UNKNOWN', 'fresh', '', undefined, null, {}, 'EXACT_BASELINE ']) {
    assert.equal(decidePrepareAction(state).ok, false, `accepted ${JSON.stringify(state)}`);
  }
});

// --- J. execute sequencing -------------------------------------------------------------------------

// RED6F: the Company descriptor is re-hashed right after the runtime loads and
// before the first proof (R1-R6).
const FRESH_ORDER = ['loadRuntime', COMPANY_HASH, 'prove', 'classify', 'payload', CONFIG_HASH, 'spawn', 'prove', 'classify',
  'prove', 'seed', 'prove', 'backfill', 'prove', 'seed', 'verify', 'close'];

test('J1 FRESH: migrate, re-prove, re-classify, then seed/backfill/seed each behind a proof, then verify', async () => {
  const r = await execute();
  assert.equal(r.code, 0, r.text);
  assert.deepEqual(r.runtimeOrder, FRESH_ORDER);
  assert.match(r.text, /OK/);
});

test('J2 MIGRATED_EMPTY: seed/backfill/seed behind proofs, then verify; no migration', async () => {
  const r = await execute({ runtime: { states: ['MIGRATED_EMPTY'] } });
  assert.equal(r.code, 0);
  assert.deepEqual(r.runtimeOrder, ['loadRuntime', COMPANY_HASH, 'prove', 'classify', 'prove', 'seed', 'prove', 'backfill', 'prove', 'seed', 'verify', 'close']);
});

test('J3 POST_SEED1: backfill and the second seed behind proofs, then verify', async () => {
  const r = await execute({ runtime: { states: ['POST_SEED1'] } });
  assert.equal(r.code, 0);
  assert.deepEqual(r.runtimeOrder, ['loadRuntime', COMPANY_HASH, 'prove', 'classify', 'prove', 'backfill', 'prove', 'seed', 'verify', 'close']);
});

test('J4 POST_BACKFILL: the second seed behind a proof, then verify', async () => {
  const r = await execute({ runtime: { states: ['POST_BACKFILL'] } });
  assert.equal(r.code, 0);
  assert.deepEqual(r.runtimeOrder, ['loadRuntime', COMPANY_HASH, 'prove', 'classify', 'prove', 'seed', 'verify', 'close']);
});

test('J5 EXACT_BASELINE is a verified no-op: no migration, no seed', async () => {
  const r = await execute({ runtime: { states: ['EXACT_BASELINE'] } });
  assert.equal(r.code, 0);
  assert.deepEqual(r.runtimeOrder, ['loadRuntime', COMPANY_HASH, 'prove', 'classify', 'verify', 'close']);
  assert.equal(r.spawned.length, 0);
});

test('J6 a well-formed but different --plan fails before the runtime loads', async () => {
  const r = await run(EXECUTE(ANY_PLAN));
  assert.equal(r.code, 1);
  assert.match(r.text, /phase=plan/);
  assert.deepEqual(r.runtimeOrder, []);
  assert.equal(r.spawned.length, 0);
  assert.ok(!r.text.includes(ANY_PLAN));
});

test('J7 a plan reviewed for another marker is refused', async () => {
  const foreign = await planFor({ env: { ...ENV, LOCAL_TEST_DATABASE_MARKER_ID: OTHER } }, ['--dry-run', `--marker-id=${OTHER}`]);
  const r = await run(EXECUTE(foreign));
  assert.equal(r.code, 1);
  assert.match(r.text, /phase=plan/);
  assert.deepEqual(r.runtimeOrder, []);
});

test('J8 refused states in execute: proof and classification only, then close; no mutation', async () => {
  for (const state of ['PARTIAL_UNSAFE', 'OPERATIONAL_DATA', 'MIGRATION_DRIFT', 'UNKNOWN']) {
    const r = await execute({ runtime: { states: [state] } });
    assert.equal(r.code, 1);
    assert.deepEqual(r.runtimeOrder, ['loadRuntime', COMPANY_HASH, 'prove', 'classify', 'close']);
    assert.equal(r.spawned.length, 0);
  }
});

test('J9 after migration the database must classify exactly MIGRATED_EMPTY, or nothing more runs', async () => {
  const r = await execute({ runtime: { states: ['FRESH', 'PARTIAL_UNSAFE'] } });
  assert.equal(r.code, 1);
  assert.deepEqual(afterSpawn(r), ['prove', 'classify', 'close']);
});

// RED6F contract evolution: loadRuntime gets exactly the reviewed runtime input
// (databaseUrl, markerId, approvedMigrations from the verified payload), frozen;
// the URL is the same held string the child gets; the marker never reaches the child.
test('J10 the runtime gets the held URL (byte-identical to the child), the pinned marker and the frozen approved migrations', async () => {
  const r = await execute();
  assert.deepEqual(r.loaded, [expectedRuntimeInput()]);
  const [input] = r.loaded;
  assert.equal(input.databaseUrl, URL_TEXT);
  assert.equal(input.databaseUrl, r.spawned[0].options.env.LOCAL_TEST_DATABASE_URL);
  assert.ok(Object.isFrozen(input) && Object.isFrozen(input.approvedMigrations));
  assert.ok(input.approvedMigrations.every((m) => Object.isFrozen(m)));
  assert.ok(!Object.values(r.spawned[0].options.env).includes(MARKER), 'the marker id never reaches the migration child');
});

// --- K. proof before mutation -------------------------------------------------------------------------

test('K1 every mutation (spawn, seed, backfill) follows a proof with no mutation in between', async () => {
  for (const states of [['FRESH', 'MIGRATED_EMPTY'], ['MIGRATED_EMPTY'], ['POST_SEED1'], ['POST_BACKFILL']]) {
    const { order } = await execute({ runtime: { states } });
    order.forEach((step, i) => {
      if (!MUTATIONS.includes(step)) return;
      const lastProof = order.lastIndexOf('prove', i);
      assert.ok(lastProof !== -1, `${step} without any proof (${states[0]})`);
      assert.ok(!order.slice(lastProof + 1, i).some((s) => MUTATIONS.includes(s)), `${step} reuses an earlier proof (${states[0]})`);
    });
  }
});

test('K2 migration success is not identity: the first runtime call after the child is a proof', async () => {
  const r = await execute();
  assert.equal(afterSpawn(r)[0], 'prove');
});

// --- L. failure containment -------------------------------------------------------------------------

test('L1 a failed first proof stops everything; the runtime is still closed', async () => {
  const r = await execute({ runtime: { failOn: { prove: [1] } } });
  assert.equal(r.code, 1);
  assert.deepEqual(r.runtimeOrder, ['loadRuntime', COMPANY_HASH, 'prove', 'close']);
  assertNoLeak(r.text);
});

test('L2 a failed classification stops before any mutation', async () => {
  const r = await execute({ runtime: { failOn: { classify: [1] } } });
  assert.equal(r.code, 1);
  assert.deepEqual(r.runtimeOrder, ['loadRuntime', COMPANY_HASH, 'prove', 'classify', 'close']);
});

test('L3 a failed post-migration proof stops before any baseline mutation', async () => {
  const r = await execute({ runtime: { failOn: { prove: [2] } } });
  assert.equal(r.code, 1);
  assert.deepEqual(afterSpawn(r), ['prove', 'close']);
});

test('L4 a failed first seed stops before backfill, the second seed and verification', async () => {
  const r = await execute({ runtime: { states: ['MIGRATED_EMPTY'], failOn: { seed: [1] } } });
  assert.equal(r.code, 1);
  assert.equal(r.counts.seed, 1);
  assert.ok(!r.order.includes('backfill') && !r.order.includes('verify'));
  assert.equal(r.order.at(-1), 'close');
});

test('L5 a failed backfill stops before the second seed', async () => {
  const r = await execute({ runtime: { states: ['MIGRATED_EMPTY'], failOn: { backfill: [1] } } });
  assert.equal(r.code, 1);
  assert.equal(r.counts.seed, 1);
  assert.ok(!r.order.includes('verify'));
});

test('L6 a failed second seed is a failure, never success', async () => {
  const r = await execute({ runtime: { states: ['MIGRATED_EMPTY'], failOn: { seed: [2] } } });
  assert.equal(r.code, 1);
  assert.ok(!r.order.includes('verify'));
  assert.doesNotMatch(r.text, /OK/);
});

test('L7 a failed final verification is a failure', async () => {
  const r = await execute({ runtime: { states: ['MIGRATED_EMPTY'], failOn: { verify: [1] } } });
  assert.equal(r.code, 1);
  assert.ok(r.order.includes('verify'));
  assert.doesNotMatch(r.text, /OK/);
});

test('L8 a failed verification on the EXACT_BASELINE no-op is a failure', async () => {
  const r = await execute({ runtime: { states: ['EXACT_BASELINE'], failOn: { verify: [1] } } });
  assert.equal(r.code, 1);
  assert.ok(r.order.includes('verify'));
});

test('L9 a failed proof before the backfill stops before the backfill', async () => {
  const r = await execute({ runtime: { states: ['MIGRATED_EMPTY'], failOn: { prove: [3] } } });
  assert.equal(r.code, 1);
  assert.deepEqual(r.runtimeOrder, ['loadRuntime', COMPANY_HASH, 'prove', 'classify', 'prove', 'seed', 'prove', 'close']);
});

test('L10 a runtime that cannot be loaded stops at phase=runtime', async () => {
  const r = await execute({ loadFails: true });
  assert.equal(r.code, 1);
  assert.match(r.text, /phase=runtime/);
  assert.equal(r.spawned.length, 0);
  assertNoLeak(r.text);
});

// --- M. child process contract ------------------------------------------------------------------------

for (const [label, spawn] of [
  ['M1 non-zero exit', { code: 1 }],
  ['M2 termination by signal', { code: null, signal: 'SIGTERM' }],
  ['M3 synchronous spawn failure', { throwSync: true }],
  ['M4 spawn error (missing executable)', { emitError: true }],
  ['M5 error followed by close', { emitError: true, errorThenClose: true }],
]) {
  test(`${label}: only a clean exit 0 continues; nothing but close follows`, async () => {
    const r = await execute({ spawn });
    assert.equal(r.code, 1);
    assert.match(r.text, /phase=prisma/);
    assert.deepEqual(afterSpawn(r), ['close']);
    assertNoLeak(r.text);
  });
}

test('M6 a child that never exits is killed at the timeout and nothing follows', async () => {
  const r = await execute({ spawn: { hang: true }, childTimeoutMs: 20 });
  assert.equal(r.code, 1);
  assert.deepEqual(r.killed, ['SIGKILL']);
  assert.deepEqual(afterSpawn(r), ['close']);
});

test('M7 child output is redacted line by line, even with a secret split across chunks', async () => {
  const half = Math.floor(URL_TEXT.length / 2);
  const r = await execute({
    spawn: {
      code: 1,
      stdout: ['applying ', URL_TEXT.slice(0, half), `${URL_TEXT.slice(half)}\n`],
      stderr: [`auth: ${SECRET.slice(0, 5)}`, `${SECRET.slice(5)} ${encodeURIComponent(SECRET)}\n`, 'tail without newline'],
    },
  });
  assert.match(r.text, /prisma\| applying «redacted»/);
  assert.match(r.text, /prisma\| tail without newline/);
  assertNoLeak(r.text);
});

// --- N/O. marker and provisioning separation --------------------------------------------------------------

test('N1 prepare never references the marker tool or mutates the marker schema', async () => {
  assert.doesNotMatch(CODE, /local-test-marker/);
  assert.doesNotMatch(SOURCE, /mona_local_test_guard|database_identity/);
  assert.doesNotMatch(SOURCE, /\b(CREATE\s+SCHEMA|CREATE\s+TABLE|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|DROP\s+(SCHEMA|TABLE))\b/i);
  const r = await execute();
  assert.ok(!JSON.stringify(r.spawned).includes('local-test-marker'));
});

test('O1 prepare never provisions databases, roles or users', () => {
  assert.doesNotMatch(SOURCE, /\b(CREATE|DROP|ALTER)\s+(DATABASE|ROLE|USER)\b/i);
  assert.doesNotMatch(SOURCE, /\b(GRANT|REVOKE)\s/);
});

// --- P. sanitization / no shell ------------------------------------------------------------------------------

test('P1 runtime failures carrying the URL never reach the output', async () => {
  for (const failOn of [{ prove: [1] }, { classify: [1] }, { seed: [1] }, { backfill: [1] }]) {
    const r = await execute({ runtime: { states: ['MIGRATED_EMPTY'], failOn } });
    assert.equal(r.code, 1);
    assertNoLeak(r.text);
  }
});

test('P2 argv arrays only: no shell, no exec-style command strings', () => {
  assert.doesNotMatch(CODE, /shell:\s*true|\bexecSync\b|\bexec\(|\bspawnSync\b|\bexecFile/);
  assert.match(CODE, /shell:\s*false/);
});

// --- Q. idempotency ----------------------------------------------------------------------------------------------

test('Q1 a second execute on the resulting EXACT_BASELINE is a verified no-op', async () => {
  const first = await execute({ runtime: { states: ['MIGRATED_EMPTY'] } });
  const second = await execute({ runtime: { states: ['EXACT_BASELINE'] } });
  assert.equal(first.code, 0);
  assert.equal(second.code, 0);
  assert.deepEqual(second.runtimeOrder, ['loadRuntime', COMPANY_HASH, 'prove', 'classify', 'verify', 'close']);
  assert.equal(second.spawned.length, 0);
});

// --- R. Company descriptor recheck after the runtime loads (RED6F) --------------------------------------------------
//
// Importing the runtime executes api/scripts/test-company-bootstrap.ts; the plan
// bound its sha256. --check and --execute re-hash it after loading and before the
// first proof; a difference stops at phase=company with the runtime closed.

const companyHashes = (second) => ({ hashes: { [COMPANY_FILE]: [{ ok: true, sha256: sha(COMPANY_FILE) }, second] } });

test('R1 check and execute re-hash the Company descriptor once, after loading the runtime and before the first proof', async () => {
  for (const r of [await run(CHECK, { runtime: { states: ['EXACT_BASELINE'] } }), await execute()]) {
    assert.equal(r.code, 0, r.text);
    assert.equal(r.order.filter((step) => step === COMPANY_HASH).length, 2);
    assert.deepEqual(r.runtimeOrder.slice(0, 3), ['loadRuntime', COMPANY_HASH, 'prove']);
  }
});

for (const [label, go] of [['R2 execute', (opts) => execute(opts)], ['R3 check', (opts) => run(CHECK, opts)]]) {
  test(`${label}: a Company descriptor changed after the runtime loaded stops before any proof; the runtime is closed`, async () => {
    const r = await go(companyHashes({ ok: true, sha256: sha('swapped company') }));
    assert.equal(r.code, 1);
    assert.match(r.text, /phase=company/);
    assert.deepEqual(r.runtimeOrder, ['loadRuntime', COMPANY_HASH, 'close']);
    assert.equal(r.counts.prove, undefined);
    assert.equal(r.counts.classify, undefined);
    assert.equal(r.spawned.length, 0);
    assert.ok(!r.order.includes('seed') && !r.order.includes('backfill'));
    assertNoLeak(r.text);
  });
}

test('R4 an unreadable Company descriptor after the runtime loaded stops the same way', async () => {
  const r = await execute(companyHashes({ ok: false, reason: 'is missing or is a symlink' }));
  assert.equal(r.code, 1);
  assert.match(r.text, /phase=company/);
  assert.deepEqual(r.runtimeOrder, ['loadRuntime', COMPANY_HASH, 'close']);
  assert.equal(r.spawned.length, 0);
});

test('R5 dry-run never loads the runtime, so it hashes the Company descriptor exactly once', async () => {
  const r = await run(DRY);
  assert.equal(r.code, 0);
  assert.equal(r.order.filter((step) => step === COMPANY_HASH).length, 1);
  assert.equal(r.loaded.length, 0);
});

test('R6 a Company mismatch whose close also fails still reports the original phase=company failure', async () => {
  const r = await execute({ ...companyHashes({ ok: true, sha256: sha('swapped company') }), runtime: { failOn: { close: [1] } } });
  assert.equal(r.code, 1);
  assert.match(r.text, /phase=company/);
  assert.doesNotMatch(r.text, /phase=close/);
  assert.deepEqual(r.runtimeOrder, ['loadRuntime', COMPANY_HASH, 'close']);
});
