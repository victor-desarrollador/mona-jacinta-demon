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
import { spawn as nodeSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
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
import * as backupModule from './local-test-backup.mjs';

const SOURCE = readFileSync(new URL('./local-test-prepare.mjs', import.meta.url), 'utf8');
const BACKUP_TOOL_SHA = createHash('sha256').update(readFileSync(new URL('./local-test-backup.mjs', import.meta.url))).digest('hex');
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
const DOMAIN_SHA = sha('domain-contract');
const TRANSFORM_SHA = sha('transformation');
// V2.3.2: the checkpoint store lives under the run's home, so runs get a real owner-only
// home (shared; tests that need isolation pass their own) and a fixed clock.
const TEST_NOW = '2026-10-03T13:00:00.000Z';
const SHARED_HOME = (() => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'mona-v232-shared-home-'));
  chmodSync(home, 0o700);
  return home;
})();
LEAKS.push(SHARED_HOME);

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

// The classifier sequence each start state produces through the reviewed
// transitions: the start, then one state after every mutating step.
const SEQ = Object.freeze({
  FRESH: ['FRESH', 'MIGRATED_EMPTY', 'POST_SEED1', 'POST_BACKFILL'],
  MIGRATED_EMPTY: ['MIGRATED_EMPTY', 'POST_SEED1', 'POST_BACKFILL'],
  POST_SEED1: ['POST_SEED1', 'POST_BACKFILL'],
  RESUME: ['POST_BACKFILL', 'EXACT_BASELINE'],
});

// Fake LOCAL_TEST runtime. classify() walks `states` (the last one repeats);
// `failOn.<name>` lists the 1-based calls that throw (with the URL in the message);
// `hooks.<name>(n)` runs before the n-th call (to change files mid-run).
function fakeRuntime(order, { states = SEQ.FRESH, failOn = {}, hooks = {}, resume = {}, outcome = {} } = {}) {
  const counts = {};
  const call = (name) => {
    order.push(name);
    counts[name] = (counts[name] ?? 0) + 1;
    hooks[name]?.(counts[name]);
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
      // R4: the protected resume. It drives the tool's callbacks in the owner's order (preconditions → consume → witness → commit)
      // and throws the owner's failure shape ({kind, stage, reason}, no cause). `resume.failAt` injects the failure point;
      // `resume.beforePreconditions` runs first (to change files mid-run).
      resumeSeed2: async (request) => {
        call('resumeSeed2');
        const rolled = (stage) => Object.assign(new Error('protected resume transaction failed'), { kind: 'ROLLED_BACK', stage, reason: 'FAILED' });
        await resume.beforePreconditions?.(request);
        try { await request.checkPreconditions(); } catch { throw rolled('preconditions'); }
        await resume.afterPreconditions?.(request);
        try { await request.consumeAuthorization(); } catch { throw rolled('consume'); }
        if (resume.failAt === 'seed' || resume.failAt === 'verify' || resume.failAt === 'guard') throw rolled(resume.failAt);
        const fPost = sha(`fpost:${request.expectedFPre}`);
        let receipt;
        try { receipt = await request.persistPostWitness({ nonce: 'n'.repeat(32), fPre: request.expectedFPre, fPost, serverVersionNum: '170004', markerId: MARKER, protectedDomainContractSha256: DOMAIN_SHA, transformationContractSha256: TRANSFORM_SHA, ...resume.persistOverride }); } catch { throw rolled('witness'); } // the owner turns a throwing callback into a rollback at the witness stage
        if (!receipt || receipt.durable !== true) throw rolled('witness');
        if (resume.failAt === 'commit-unknown') throw Object.assign(new Error('protected resume transaction failed'), { kind: 'COMMIT_UNKNOWN', stage: 'commit', reason: 'FAILED' });
        call('commit');
        return { fPost };
      },
      checkOutcome: async () => {
        call('checkOutcome');
        if (outcome.fails) throw Object.assign(new Error('outcome verification failed'), { reason: outcome.timeout ? 'TIMEOUT' : 'FAILED' });
        return { pre: sha('current-pre'), post: sha('current-post'), serverVersionNum: '170004', markerId: MARKER, protectedDomainContractSha256: DOMAIN_SHA, acceptedTransformationContractSha256s: [TRANSFORM_SHA], ...outcome.digests };
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
  // V2.3.2: the child is started contained; `command`/`args` are the wrapped command,
  // `contained` the wrapper invocation.
  const spawn = (wrapper, wrapperArgs, options) => {
    const contained = path.basename(wrapper) === 'unshare' && wrapperArgs.includes('--');
    const command = contained ? wrapperArgs[wrapperArgs.indexOf('--') + 1] : wrapper;
    const args = contained ? wrapperArgs.slice(wrapperArgs.indexOf('--') + 2) : wrapperArgs;
    spawned.push({ command, args, options, contained: { command: wrapper, args: [...wrapperArgs] } });
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
    execPath: opts.execPath ?? EXEC,
    home: opts.home ?? SHARED_HOME,
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
      // The backup tool hash is the real file's unless a test overrides it: the
      // evidence a test builds comes from the real local-test-backup.mjs code.
      const real = name === 'local-test-backup.mjs' ? { ok: true, sha256: BACKUP_TOOL_SHA } : undefined;
      return pick(opts.hashes?.[name], hashCalls[name]) ?? real ?? { ok: true, sha256: sha(name) };
    },
    loadRuntime: async (target) => {
      order.push('loadRuntime');
      loaded.push(target);
      if (opts.loadFails) throw new Error(`cannot load ${URL_TEXT}`);
      return runtime;
    },
    spawn: opts.realSpawn ? nodeSpawn : spawner.spawn,
    childTimeoutMs: opts.childTimeoutMs ?? 2000,
    repoRoot: opts.repoRoot ?? '/synthetic/repo',
    forbiddenRoots: opts.forbiddenRoots ?? ['/synthetic/tmp'],
    uid: opts.uid ?? process.getuid(),
    log: (line) => out.push(line),
    error: (line) => out.push(line),
  };
  // V2.3.2 seams: a fixed clock, the injected archive lister and binary hash (the resume
  // lists the archive; the fake lists only the genuine synthetic archive); the rest are set
  // only when a test gives them (an undefined key would replace the default).
  deps.now = opts.now ?? at(TEST_NOW);
  deps.listArchive = opts.listArchive ?? fakeListArchive();
  deps.pgRestore = opts.pgRestore ?? PG_RESTORE_SYN;
  deps.hashBinary = opts.hashBinary ?? fakeHashBinary;
  for (const key of ['containCommand', 'checkContainer', 'killAfterMs', 'reapMs']) {
    if (opts[key] !== undefined) deps[key] = opts[key];
  }
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
  const allowed = ['node:child_process', 'node:crypto', 'node:fs', 'node:os', 'node:path', 'node:string_decoder', 'node:url', './pilot-migrate.mjs', './local-test-witness.mjs', './local-test-safe-error.mjs']; // R4: + the pure evidence helper and the fixed-code error/start-guard helper
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

// V2.3.1 contract evolution: the generic plan binds the checkpoint transition
// table (each mutation behind a proof, each result re-proven and re-classified)
// and ends at POST_BACKFILL: seed #2 and the verifier are not in it.
test('F4 the plan binds the reviewed phase contract: a proof before every mutation, an exact state after it, stop at POST_BACKFILL', () => {
  assert.equal(preparePhaseList(), PREPARE_PHASES);
  assert.deepEqual([...PREPARE_PHASES], [
    'static-gates', 'load-runtime', 'prove-identity', 'classify', 'supersede-current-checkpoints',
    'FRESH: recheck-payload-and-config, migrate, prove-identity, classify-expect-MIGRATED_EMPTY',
    'MIGRATED_EMPTY: prove-identity, seed-demo, prove-identity, classify-expect-POST_SEED1',
    'POST_SEED1: prove-identity, backfill-company-locations, prove-identity, classify-expect-POST_BACKFILL',
    'record-checkpoint', 'stop-at-POST_BACKFILL',
  ]);
});

// --- G. dry-run -------------------------------------------------------------------------------

test('G1 dry-run loads no runtime, proves nothing, spawns nothing and prints a sanitized plan', async () => {
  const r = await run(DRY);
  assert.equal(r.code, 0);
  assert.deepEqual(r.order, ['resolve', CONFIG_HASH, 'payload', COMPANY_HASH, 'hash:local-test-prepare.mjs']);
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

// V2.3.1 contract evolution: the generic decision never includes seed #2 or the
// verifier; POST_BACKFILL and EXACT_BASELINE refuse.
for (const [state, phases] of [
  ['FRESH', ['migrate', 'seed-demo', 'backfill-company-locations']],
  ['MIGRATED_EMPTY', ['seed-demo', 'backfill-company-locations']],
  ['POST_SEED1', ['backfill-company-locations']],
]) {
  test(`I ${state} decides ${phases.join(' → ')} (stop at POST_BACKFILL)`, () => {
    assert.deepEqual(decidePrepareAction(state), { ok: true, phases });
  });
}

test('I5 the generic decision refuses POST_BACKFILL (seed #2 needs the resume) and EXACT_BASELINE (beyond the checkpoint)', () => {
  const pb = decidePrepareAction('POST_BACKFILL');
  assert.equal(pb.ok, false);
  assert.match(pb.reason, /--resume-from=POST_BACKFILL --backup-evidence/);
  const eb = decidePrepareAction('EXACT_BASELINE');
  assert.equal(eb.ok, false);
  assert.match(eb.reason, /beyond the backup checkpoint/);
  assert.deepEqual(decidePrepareAction('POST_BACKFILL', 'resume-after-verified-backup'), { ok: true, phases: ['seed-demo', 'verify-baseline'] });
});

test('I6 unsafe, drifted, operational, unknown and malformed states refuse; nothing is repaired', () => {
  for (const state of ['PARTIAL_UNSAFE', 'OPERATIONAL_DATA', 'MIGRATION_DRIFT', 'UNKNOWN', 'fresh', '', undefined, null, {}, 'EXACT_BASELINE ', 'constructor', '__proto__']) {
    for (const action of [undefined, 'prepare-to-post-backfill', 'resume-after-verified-backup']) {
      assert.equal(decidePrepareAction(state, action).ok, false, `accepted ${JSON.stringify(state)} for ${action}`);
    }
  }
});

// --- J. execute sequencing -------------------------------------------------------------------------

// RED6F: the Company descriptor is re-hashed right after the runtime loads and
// before the first proof (R1-R6).
// V2.3.1 contract evolution (J1-J5): the generic execute stops at POST_BACKFILL;
// every step result is re-proven and re-classified to the exact next state.
// V2.3.2: the checkpoint line names the recorded checkpoint; CHECKPOINT_LINE is its fixed prefix.
const CHECKPOINT_LINE = '[db:local-test-prepare] CHECKPOINT OK';
const CHECKPOINT_LINE_RE = /^\[db:local-test-prepare\] CHECKPOINT OK — state POST_BACKFILL, checkpoint cp-\d{8}T\d{6}Z-[0-9a-f]{32} recorded; seed #2 and verify-baseline were NOT run$/m;
const FRESH_ORDER = ['loadRuntime', COMPANY_HASH, 'prove', 'classify', 'payload', CONFIG_HASH, 'spawn', 'prove', 'classify',
  'prove', 'seed', 'prove', 'classify', 'prove', 'backfill', 'prove', 'classify', 'close'];

test('J1 FRESH: migrate, then seed #1 and backfill each behind a proof, each result re-proven and re-classified; stop at POST_BACKFILL', async () => {
  const r = await execute();
  assert.equal(r.code, 0, r.text);
  assert.deepEqual(r.runtimeOrder, FRESH_ORDER);
  assert.match(r.text, CHECKPOINT_LINE_RE);
});

test('J2 MIGRATED_EMPTY: seed #1 and backfill behind proofs; no migration; stop at POST_BACKFILL', async () => {
  const r = await execute({ runtime: { states: SEQ.MIGRATED_EMPTY } });
  assert.equal(r.code, 0, r.text);
  assert.deepEqual(r.runtimeOrder, ['loadRuntime', COMPANY_HASH, 'prove', 'classify', 'prove', 'seed', 'prove', 'classify', 'prove', 'backfill', 'prove', 'classify', 'close']);
});

test('J3 POST_SEED1: backfill behind a proof; stop at POST_BACKFILL', async () => {
  const r = await execute({ runtime: { states: SEQ.POST_SEED1 } });
  assert.equal(r.code, 0, r.text);
  assert.deepEqual(r.runtimeOrder, ['loadRuntime', COMPANY_HASH, 'prove', 'classify', 'prove', 'backfill', 'prove', 'classify', 'close']);
});

test('J4 POST_BACKFILL: the generic execute refuses (seed #2 needs the resume); proof and classification only', async () => {
  const r = await execute({ runtime: { states: ['POST_BACKFILL'] } });
  assert.equal(r.code, 1);
  assert.deepEqual(r.runtimeOrder, ['loadRuntime', COMPANY_HASH, 'prove', 'classify', 'close']);
  assert.match(r.text, /--resume-from=POST_BACKFILL --backup-evidence/);
});

test('J5 EXACT_BASELINE: the generic execute refuses without mutation or verification (use --check)', async () => {
  const r = await execute({ runtime: { states: ['EXACT_BASELINE'] } });
  assert.equal(r.code, 1);
  assert.deepEqual(r.runtimeOrder, ['loadRuntime', COMPANY_HASH, 'prove', 'classify', 'close']);
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
  for (const states of [SEQ.FRESH, SEQ.MIGRATED_EMPTY, SEQ.POST_SEED1]) {
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
  const r = await execute({ runtime: { states: SEQ.MIGRATED_EMPTY, failOn: { seed: [1] } } });
  assert.equal(r.code, 1);
  assert.equal(r.counts.seed, 1);
  assert.ok(!r.order.includes('backfill') && !r.order.includes('verify'));
  assert.equal(r.order.at(-1), 'close');
});

test('L5 a failed backfill stops before the second seed', async () => {
  const r = await execute({ runtime: { states: SEQ.MIGRATED_EMPTY, failOn: { backfill: [1] } } });
  assert.equal(r.code, 1);
  assert.equal(r.counts.seed, 1);
  assert.ok(!r.order.includes('verify'));
});

// V2.3.1 contract evolution (L6-L8): seed #2 and the verifier are resume-only
// (their failures are covered in V231-*); the generic run's last step is the
// backfill postcondition.
test('L6 a generic run that classifies wrongly after the backfill is a failure, never a checkpoint', async () => {
  const r = await execute({ runtime: { states: ['MIGRATED_EMPTY', 'POST_SEED1', 'EXACT_BASELINE'] } });
  assert.equal(r.code, 1);
  assert.ok(!r.order.includes('verify'));
  assert.doesNotMatch(r.text, /OK/);
});

test('L7 a failed post-backfill proof is a failure', async () => {
  const r = await execute({ runtime: { states: SEQ.MIGRATED_EMPTY, failOn: { prove: [5] } } });
  assert.equal(r.code, 1);
  assert.deepEqual(r.runtimeOrder.slice(-3), ['backfill', 'prove', 'close']);
  assert.doesNotMatch(r.text, /OK/);
});

test('L8 a failed post-backfill classification is a failure', async () => {
  const r = await execute({ runtime: { states: SEQ.MIGRATED_EMPTY, failOn: { classify: [3] } } });
  assert.equal(r.code, 1);
  assert.doesNotMatch(r.text, /OK/);
});

test('L9 a failed proof before the backfill stops before the backfill', async () => {
  const r = await execute({ runtime: { states: SEQ.MIGRATED_EMPTY, failOn: { prove: [4] } } });
  assert.equal(r.code, 1);
  assert.deepEqual(r.runtimeOrder, ['loadRuntime', COMPANY_HASH, 'prove', 'classify', 'prove', 'seed', 'prove', 'classify', 'prove', 'close']);
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

// V2.3.2 contract evolution: the contained child gets TERM, then KILL after the kill-after
// delay; one that is never reaped is reported as an unknown outcome after the reap bound.
test('AC-116/117 M6 a child that never exits is terminated (TERM, then KILL) at the timeout and nothing follows', async () => {
  const r = await execute({ spawn: { hang: true }, childTimeoutMs: 20, killAfterMs: 20, reapMs: 20 });
  assert.equal(r.code, 1);
  assert.deepEqual(r.killed, ['SIGTERM', 'SIGKILL']);
  assert.match(r.text, /phase=prisma — prisma timed out and was killed, but could not be reaped; outcome unknown/);
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
  // V2.3.2: the shared archive TOC rule names the marker schema exactly once, to REFUSE an
  // archive that contains it (read-only text check); nothing else may reference it.
  const guardLines = SOURCE.split('\n').filter((l) => /mona_local_test_guard|database_identity/.test(l));
  assert.deepEqual(guardLines, ["const GUARD_SCHEMA = 'mona_local_test_guard';"]);
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
    const r = await execute({ runtime: { states: SEQ.MIGRATED_EMPTY, failOn } });
    assert.equal(r.code, 1);
    assertNoLeak(r.text);
  }
});

test('P2 argv arrays only: no shell, no exec-style command strings', () => {
  // `RegExp#exec(` is not a process call: only a bare/imported exec( is refused.
  assert.doesNotMatch(CODE, /shell:\s*true|\bexecSync\b|(?<![.\w])exec\(|\bspawnSync\b|\bexecFile/);
  assert.match(CODE, /shell:\s*false/);
});

// --- Q. idempotency ----------------------------------------------------------------------------------------------

// V2.3.1 contract evolution: a second generic execute on the resulting
// POST_BACKFILL refuses instead of continuing into seed #2.
test('Q1 a second generic execute on the resulting POST_BACKFILL refuses without mutation', async () => {
  const first = await execute({ runtime: { states: SEQ.MIGRATED_EMPTY } });
  const second = await execute({ runtime: { states: ['POST_BACKFILL'] } });
  assert.equal(first.code, 0);
  assert.equal(second.code, 1);
  assert.deepEqual(second.runtimeOrder, ['loadRuntime', COMPANY_HASH, 'prove', 'classify', 'close']);
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

// --- V231. class-level backup enforcement (RED first) --------------------------------------------------
// seed #2 at POST_BACKFILL deletes/transforms existing rows; no policy exempts rows the same run created.
// Generic --execute must never reach seed #2; only the explicit resume with verified backup evidence may.
test('V231-RED-A generic execute starting at POST_BACKFILL never reaches seed #2', async () => {
  const r = await execute({ runtime: { states: ['POST_BACKFILL'] } });
  assert.equal(r.counts.seed, undefined, 'seed #2 was reached by a generic execute at POST_BACKFILL');
  assert.equal(r.counts.verify, undefined);
  assert.equal(r.code, 1);
});

test('V231-RED-B generic execute from FRESH crosses no backup boundary: seed #1 only, stop at POST_BACKFILL', async () => {
  const r = await execute({ runtime: { states: ['FRESH', 'MIGRATED_EMPTY', 'POST_SEED1', 'POST_BACKFILL'] } });
  const backfillAt = r.order.indexOf('backfill');
  assert.ok(!r.order.slice(backfillAt + 1).includes('seed'), 'seed #2 was reached after the backfill without a backup boundary');
  assert.equal(r.counts.seed, 1);
  assert.equal(r.counts.verify, undefined);
});

test('V231-RED-C an explicit resume without verified backup evidence never reaches seed #2', async () => {
  const flag = '--resume-from=POST_BACKFILL';
  const parsed = parsePrepareArgs([...EXECUTE(ANY_PLAN), flag]);
  let seeded;
  if (parsed.ok) {
    const plan = await planFor({}, [...DRY, flag]).catch(() => ANY_PLAN);
    const r = await run([...EXECUTE(plan), flag], { runtime: { states: ['POST_BACKFILL'] } });
    seeded = r.counts.seed;
  }
  assert.equal(seeded, undefined, 'seed #2 was reached by a resume without backup evidence');
  assert.equal(parsed.ok, false);
});

// --- V231 suite: evidence is produced by the real local-test-backup.mjs code (fake runtime, fake
// pg_dump/pg_restore) in a private temporary root; the policy roots of the prepare run are synthetic.
const ARCHIVE = Buffer.from('PGDMP synthetic custom archive bytes\n');
const R4_RELATIONS = ['AuditLog', 'Branch', 'Brand', 'CashMovement', 'CashRegister', 'CashSession', 'Category', 'Company', 'Inventory', 'Location', 'Permission', 'Product', 'ProductVariant', 'Role', 'RolePermission', 'Sale', 'SaleItem', 'SaleNumberCounter', 'SalePayment', 'StockMovement', 'StockReservation', 'User', 'UserBranchRole', 'UserRoleScope', '_prisma_migrations'];
// A TOC in the shape pg_restore --list prints, for the 25 protected relations plus a few allow-listed object kinds (R4 strict contract).
function r4Toc({ tables = R4_RELATIONS, data = tables, extra = [], dbname = 'mona_local_test', declared } = {}) {
  const entries = [
    '6; 2615 2200 SCHEMA - public pg_database_owner',
    '3410; 0 0 COMMENT - SCHEMA public pg_database_owner',
    '900; 1247 16385 TYPE public SaleStatus mona_local_test',
    '910; 1255 16400 FUNCTION public fn_sale_payment_history() mona_local_test',
    ...tables.map((t, i) => `${1000 + i}; 1259 ${20000 + i} TABLE public ${t} mona_local_test`),
    ...data.map((t, i) => `${3000 + i}; 0 ${20000 + i} TABLE DATA public ${t} mona_local_test`),
    ...tables.map((t, i) => `${4000 + i}; 2606 ${30000 + i} CONSTRAINT public ${t} ${t}_pkey mona_local_test`),
    '5000; 2620 40000 TRIGGER public SalePayment trg_sale_payment_history_before mona_local_test',
    ...extra,
  ];
  return [
    ';', '; Archive created at 2026-10-05 12:00:00 UTC', `;     dbname: ${dbname}`, `;     TOC Entries: ${declared ?? entries.length}`,
    ';     Compression: gzip', ';     Dump Version: 1.15-0', ';     Format: CUSTOM', ';     Integer: 4 bytes', ';     Offset: 8 bytes',
    ';     Dumped from database version: 17.4', ';     Dumped by pg_dump version: 17.4', ';', ';', '; Selected TOC Entries:', ';', ...entries, '',
  ].join('\n');
}
const TOC = r4Toc();
const RUN = 'local-test-20261003T120000Z-a1b2c3d4';
const MANIFEST = 'local-test.dump.manifest.json';
const RESUME_LINE_RE = (run, dump) => new RegExp(`^\\[db:local-test-prepare\\] RESUME OK — from POST_BACKFILL with verified backup ${run} \\(dump sha256 ${dump}, checkpoint cp-\\d{8}T\\d{6}Z-[0-9a-f]{32} consumed after COMMIT, authorization [0-9a-f]{32} consumed\\): seed #2 committed in one protected transaction; the verified post-state is witnessed \\(digest only\\)$`, 'm');

function backupRoot() {
  const base = mkdtempSync(path.join(os.tmpdir(), 'mona-v231-evidence-'));
  const root = path.join(base, 'root');
  mkdirSync(root, { mode: 0o700 });
  chmodSync(root, 0o700);
  return root;
}

// The tool a (possibly contained) spawn starts: the command after `--` when wrapped.
const realCommand = (command, args) => (args.includes('--') && path.basename(command) === 'unshare' ? args[args.indexOf('--') + 1] : command);

function fakeBackupSpawn(archive, toc = TOC) {
  return (command, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    setImmediate(() => {
      if (path.basename(realCommand(command, args)) === 'pg_dump') writeFileSync(args[args.indexOf('--file') + 1], archive, { mode: 0o600 });
      else child.stdout.write(toc);
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit('close', 0, null));
    });
    return child;
  };
}

// A finalized backup run, made by the backup tool itself.
async function makeBackup({ root = backupRoot(), marker = MARKER, payload = fakePayload(), suffix = 'a1b2c3d4', archive = ARCHIVE, home = SHARED_HOME, now = '2026-10-03T12:00:00.000Z', toc = TOC, checkpoint = true } = {}) {
  if (checkpoint) {
    const cp = await v232Checkpoint(home, new Date(Date.parse(now) - 3600 * 1000).toISOString(), { marker, payload });
    assert.equal(cp.code, 0, cp.text);
  }
  const out = [];
  const deps = {
    env: { LOCAL_TEST_DATABASE_URL: URL_TEXT, LOCAL_TEST_DATABASE_MARKER_ID: marker },
    apiDir: API,
    repoRoot: '/synthetic/repo',
    forbiddenRoots: ['/synthetic/tmp'],
    home,
    pgDump: '/synthetic/pg/bin/pg_dump',
    pgRestore: '/synthetic/pg/bin/pg_restore',
    hashBinary: (file) => ({ ok: true, sha256: sha(path.basename(file)) }),
    verifyMigrationPayload: () => payload,
    loadRuntime: async () => ({
      proveIdentity: async () => undefined,
      classify: async () => 'POST_BACKFILL',
      // R4: the exporter proves identity/state inside the snapshot and hands the driver the snapshot id and fPre
      withBackupSnapshot: async (callback) => callback({ snapshotId: '00000003-0000001B-1', fPre: sha('fpre'), serverVersionNum: '170004', markerId: marker, protectedDomainContractSha256: DOMAIN_SHA }),
      seedDemo: async () => { throw new Error('the backup must never seed'); },
      backfillCompanyLocations: async () => { throw new Error('the backup must never backfill'); },
      verifyBaseline: async () => undefined,
      close: async () => undefined,
    }),
    spawn: fakeBackupSpawn(archive, toc),
    childTimeoutMs: 2000,
    now: () => new Date(now),
    randomSuffix: () => suffix,
    log: (line) => out.push(line),
    error: (line) => out.push(line),
  };
  const common = [`--marker-id=${marker}`, `--output-root=${root}`];
  assert.equal(await backupModule.main(['--dry-run', ...common], deps), 0, out.join('\n'));
  const plan = /plan digest: ([0-9a-f]{64})/.exec(out.join('\n'))[1];
  assert.equal(await backupModule.main(['--execute', ...common, `--confirm-local-target=${CONFIRM_LOCAL_TARGET}`, `--plan=${plan}`], deps), 0, out.join('\n'));
  const run = `local-test-${new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}-${suffix}`;
  return { root, run, runDir: path.join(root, run), dumpSha: sha(archive) };
}

// Rewrites the manifest; with `rehash` the self-hash is recomputed (a deliberate,
// internally consistent edit), without it the edit is a plain tamper.
function editManifest(runDir, mutate, { rehash = true, serialize = (m) => `${JSON.stringify(m, null, 2)}\n` } = {}) {
  const file = path.join(runDir, MANIFEST);
  const m = JSON.parse(readFileSync(file, 'utf8'));
  mutate(m);
  if (rehash) {
    delete m.manifestSha256;
    m.manifestSha256 = prepareModule.backupManifestSelfHash(m);
  }
  writeFileSync(file, serialize(m));
}

// R4: the resume --execute also carries the OWNER authorization (dry-run does not accept one). ANY_AUTH is a syntactically valid id
// for tests that stop before the authorization is read; tests that reach the runtime issue a real one (issueAuthorization).
const ANY_AUTH = 'a'.repeat(32);
import * as witnessModule from './local-test-witness.mjs';
// A REAL authorization record for the evidence on disk and the given plan (what local-test-authorize-resume.mjs writes).
async function issueAuthorization(runDir, { home = SHARED_HOME, plan, now = TEST_NOW, ttlMs = 3600 * 1000 } = {}) {
  const manifestFile = path.join(runDir, MANIFEST);
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  const authId = createHash('sha256').update(`${runDir}:${plan}:${Math.random()}`).digest('hex').slice(0, 32);
  const createdAt = new Date(Date.parse(typeof now === 'function' ? now().toISOString() : now) - 5 * 60 * 1000);
  const text = witnessModule.buildAuthorizationRecord({
    authId, target: CONFIRM_LOCAL_TARGET, markerIdSha256: sha(MARKER), backupRun: path.basename(runDir), dumpSha256: manifest.dump.sha256, manifestSha256: sha(readFileSync(manifestFile)),
    fPre: manifest.preWitness.fPre, preWitnessSha256: manifest.preWitnessSha256, checkpointId: manifest.checkpoint.id, checkpointRecordSha256: manifest.checkpoint.recordSha256,
    planDigest: plan, createdAt: createdAt.toISOString(), expiresAt: new Date(createdAt.getTime() + ttlMs).toISOString(),
  });
  const store = await witnessModule.ensureAuthorizationStore({ home, fs: witnessModule.realWitnessFs });
  assert.equal(store.ok, true);
  const written = await witnessModule.writeAuthorizationRecord({ dir: store.dir, authId, text });
  assert.equal(written.durable, true);
  return authId;
}
const RESUME_ARGS = (evidence, authorization = null) => ['--resume-from=POST_BACKFILL', `--backup-evidence=${evidence}`, ...(authorization ? [`--authorization=${authorization}`] : [])];
const resumePlan = (evidence, opts = {}) => planFor(opts, [...DRY, ...RESUME_ARGS(evidence)]);
async function resume(evidence, opts = {}) {
  const plan = opts.plan ?? (await resumePlan(evidence, { ...(opts.home ? { home: opts.home } : {}), ...opts.dry }));
  const authorization = opts.authorization ?? (await issueAuthorization(evidence, { home: opts.home ?? SHARED_HOME, plan, now: opts.now ?? TEST_NOW }));
  return run([...EXECUTE(plan), ...RESUME_ARGS(evidence, authorization)], { ...opts, runtime: { states: SEQ.RESUME, ...opts.runtime } });
}
// A refusal of the evidence: static gates stop before any plan, runtime or process.
async function assertEvidenceRefused(evidence, why, opts = {}) {
  const dry = await run([...DRY, ...RESUME_ARGS(evidence)], opts);
  assert.equal(dry.code, 1, `dry-run accepted the evidence (${why})`);
  assert.match(dry.text, /phase=backup-evidence/);
  assert.doesNotMatch(dry.text, /plan digest/);
  const exec = await run([...EXECUTE(ANY_PLAN), ...RESUME_ARGS(evidence, ANY_AUTH)], { ...opts, runtime: { states: SEQ.RESUME } });
  assert.equal(exec.code, 1);
  assert.match(exec.text, /phase=backup-evidence/);
  assert.equal(exec.loaded.length, 0);
  assert.equal(exec.counts.seed, undefined, `seed #2 reached with refused evidence (${why})`);
  assertNoLeak(dry.text + exec.text);
  return dry.text;
}

test('V231-P01/P02/P03 generic execute from FRESH, MIGRATED_EMPTY, POST_SEED1 ends at POST_BACKFILL with exactly one CHECKPOINT line', async () => {
  for (const [states, seeds] of [[SEQ.FRESH, 1], [SEQ.MIGRATED_EMPTY, 1], [SEQ.POST_SEED1, undefined]]) {
    const r = await execute({ runtime: { states } });
    assert.equal(r.code, 0, r.text);
    assert.equal(r.counts.seed, seeds, states[0]);
    assert.equal(r.counts.verify, undefined, states[0]);
    assert.equal(r.text.split('\n').filter((l) => l.startsWith(CHECKPOINT_LINE)).length, 1);
    assert.match(r.text, CHECKPOINT_LINE_RE);
    assert.doesNotMatch(r.text, /EXACT_BASELINE|RESUME OK|baseline prepared/);
    assert.equal(r.spawned.length, states[0] === 'FRESH' ? 1 : 0);
  }
});

test('V231-P05/P06 seed #2 and verify-baseline sentinels: no generic execute from any start state reaches them', async () => {
  const starts = [...PREPARE_STATES, 'nonsense', undefined];
  for (const start of starts) {
    const states = SEQ[start] ?? [start];
    const r = await execute({ runtime: { states } });
    const backfillAt = r.order.indexOf('backfill');
    if (backfillAt !== -1) assert.ok(!r.order.slice(backfillAt).includes('seed'), `seed after backfill from ${start}`);
    assert.ok((r.counts.seed ?? 0) <= 1, `two seeds from ${start}`);
    if (!['FRESH', 'MIGRATED_EMPTY'].includes(start)) assert.equal(r.counts.seed, undefined, `seed from ${start}`);
    assert.equal(r.counts.verify, undefined, `verifier from ${start}`);
    assert.equal(r.code, ['FRESH', 'MIGRATED_EMPTY', 'POST_SEED1'].includes(start) ? 0 : 1, `${start}`);
  }
});

test('V231-P07/P22/I21/I22/I09/I23 resume arguments: evidence required, once, absolute, never with --check or alone; the R4 authorization belongs to the resume --execute only', async () => {
  const ev = '/synthetic/evidence/local-test-20261003T120000Z-a1b2c3d4';
  const ok = parsePrepareArgs([...EXECUTE(ANY_PLAN), ...RESUME_ARGS(ev, ANY_AUTH)]);
  assert.deepEqual(ok, { ok: true, mode: 'execute', markerId: MARKER, confirm: CONFIRM_LOCAL_TARGET, plan: ANY_PLAN, action: 'resume-after-verified-backup', backupEvidence: ev, authorization: ANY_AUTH });
  assert.equal(parsePrepareArgs([...DRY, ...RESUME_ARGS(ev)]).ok, true);
  for (const [argv, why] of [
    [[...EXECUTE(ANY_PLAN), '--resume-from=POST_BACKFILL'], /requires --backup-evidence/],
    [[...DRY, '--resume-from=POST_BACKFILL'], /requires --backup-evidence/],
    [[...EXECUTE(ANY_PLAN), ...RESUME_ARGS(ev, ANY_AUTH), `--backup-evidence=${ev}`], /only once/],
    [[...EXECUTE(ANY_PLAN), `--backup-evidence=${ev}`], /only with --resume-from/],
    [[...CHECK, ...RESUME_ARGS(ev)], /only with --dry-run or --execute/],
    [[...CHECK, `--backup-evidence=${ev}`], /only with --dry-run or --execute/],
    [[...EXECUTE(ANY_PLAN), '--resume-from=POST_BACKFILL', `--backup-evidence=relative/${CANARY}`], /absolute/],
    [[...EXECUTE(ANY_PLAN), `--resume-from=${CANARY}`, `--backup-evidence=${ev}`], /accepts only POST_BACKFILL/],
    [[...EXECUTE(ANY_PLAN), '--stop-after=backfill'], /Unknown argument/],
    [[...DRY, `--stop-after=${CANARY}`], /Unknown argument/],
    [[...EXECUTE(ANY_PLAN), '--resume-from=POST_BACKFILL', '--backup-evidence'], /Unknown argument/],
    // R4: the OWNER authorization is mandatory for the resume execute and accepted nowhere else
    [[...EXECUTE(ANY_PLAN), ...RESUME_ARGS(ev)], /requires --authorization/],
    [[...DRY, ...RESUME_ARGS(ev, ANY_AUTH)], /accepted only with the resume --execute/],
    [[...CHECK, '--authorization=' + ANY_AUTH], /accepted only with the resume --execute/],
    [[...EXECUTE(ANY_PLAN), ...RESUME_ARGS(ev, 'not-an-id')], /32-character lowercase hex/],
    [[...EXECUTE(ANY_PLAN), ...RESUME_ARGS(ev, `${CANARY}${'a'.repeat(10)}`)], /32-character lowercase hex/],
    [[...EXECUTE(ANY_PLAN), '--authorization=' + ANY_AUTH], /accepted only with the resume --execute/],
  ]) {
    const r = parsePrepareArgs(argv);
    assert.equal(r.ok, false, `accepted ${JSON.stringify(argv)}`);
    assert.match(r.error, why);
    assert.ok(!r.error.includes(CANARY));
  }
  const refused = await run([...EXECUTE(ANY_PLAN), '--resume-from=POST_BACKFILL'], { runtime: { states: SEQ.RESUME } });
  assert.equal(refused.code, 1);
  assert.match(refused.text, /phase=args/);
  assert.deepEqual(refused.order, []);
});

// V2.3.2 contract evolution: "verified" now means files + manifest + age + the current
// checkpoint + a clean pg_restore --list whose TOC is the manifest's; the resume re-verifies
// (re-hashing the backup tool) and consumes the checkpoint right before seed #2.
const RESUME_PHASES_LINE = `  phases: ${prepareModule.RESUME_PHASES.join(' → ')}`;
const RESUME_ORDER = ['loadRuntime', COMPANY_HASH, 'prove', 'classify', 'hash:local-test-backup.mjs', 'resumeSeed2', 'commit', 'close'];

test('V231-P17/I32 a valid backup + a bound OWNER authorization: the resume proves, re-verifies, runs ONE protected transaction (seed #2 never via runtime.seedDemo), witnesses, and only after COMMIT records the checkpoint', async () => {
  const home = v232Home();
  const b = await makeBackup({ home });
  const dry = await run([...DRY, ...RESUME_ARGS(b.runDir)], { home });
  assert.equal(dry.code, 0, dry.text);
  assert.equal(dry.loaded.length, 0);
  assert.equal(dry.spawned.length, 0);
  const manifestSha = sha(readFileSync(path.join(b.runDir, MANIFEST)));
  assert.match(dry.text, new RegExp(`^  backup evidence: run ${RUN} dump sha256 ${b.dumpSha} bytes ${ARCHIVE.length} manifest sha256 ${manifestSha}$`, 'm'));
  assert.match(dry.text, /^  PRE witness \(digest only\): fPre [0-9a-f]{64} \(witness sha256 [0-9a-f]{64}; TOC multiset sha256 [0-9a-f]{64}\)$/m);
  assert.match(dry.text, /^  backup verified: files \+ self-hashed manifest; age 3600s \(max 21600s\); bound to the current checkpoint cp-\d{8}T\d{6}Z-[0-9a-f]{32} \(record sha256 [0-9a-f]{64}\); pg_restore --list PASS \(\d+ entries, 25 tables with TABLE DATA, TOC sha256 [0-9a-f]{64} = manifest; pg_restore sha256 [0-9a-f]{64}\)$/m);
  assert.match(dry.text, /^\[db:local-test-prepare\] DRY RUN — no database connection was opened and no runtime was loaded; the only process started was the contained pg_restore --list/m);
  assert.match(dry.text, /^  action: resume-after-verified-backup — /m);
  assert.ok(dry.text.split('\n').includes(RESUME_PHASES_LINE));
  const digest = /plan digest: ([0-9a-f]{64})/.exec(dry.text)[1];
  assert.match(dry.text, new RegExp(`--plan=${digest} --resume-from=POST_BACKFILL --backup-evidence=<the run directory of backup ${RUN}> --authorization=<authId printed by local-test-authorize-resume.mjs for this plan>$`, 'm'));
  const r = await resume(b.runDir, { plan: digest, home });
  assert.equal(r.code, 0, r.text);
  assert.deepEqual(r.runtimeOrder, RESUME_ORDER);
  assert.equal(r.counts.seed, undefined, 'seed #2 must go through resumeSeed2 only');
  assert.equal(r.counts.resumeSeed2, 1);
  assert.equal(r.spawned.length, 0);
  assert.match(r.text, RESUME_LINE_RE(RUN, b.dumpSha));
  assert.ok(!r.text.includes(CHECKPOINT_LINE));
  assertNoLeak(dry.text + r.text);
  // evidence on disk after the acknowledged COMMIT: one consumed authorization, one digest-only POST witness, checkpoint consumed + completed
  const authDir = witnessModule.authorizationStorePath(home);
  const consumed = readdirSync(authDir).filter((n) => n.endsWith('.consumed.json'));
  assert.equal(consumed.length, 1);
  const authId = consumed[0].replace('.consumed.json', '');
  const witnessFile = path.join(prepareModule.witnessRootPath(home), RUN, `${authId}.post.json`);
  const post = witnessModule.parseWitness('POST', readFileSync(witnessFile, 'utf8'));
  assert.equal(post.ok, true, post.reason);
  assert.equal(post.obj.state, 'PRECOMMIT_EXPECTED_POST');
  assert.equal(post.obj.authId, authId);
  assert.equal(post.obj.fPost, sha(`fpost:${post.obj.fPre}`));
  assert.equal(lstatSync(witnessFile).mode & 0o777, 0o600);
  assert.deepEqual(storeEntries(home).map((n) => n.replace(/^cp-[^.]+\./, '')).sort(), ['checkpoint.json', 'completed.json', 'consumed.json']);
  const consumedCp = JSON.parse(readFileSync(path.join(storeOf(home), storeEntries(home).find((n) => n.endsWith('.consumed.json'))), 'utf8'));
  assert.equal(consumedCp.reason, 'resume-committed');
});

test('V231-P08/I10/I23b missing, trailing-slash and malformed evidence paths are refused before any plan', async () => {
  const b = await makeBackup();
  await assertEvidenceRefused(path.join(b.root, 'local-test-20261003T120000Z-deadbeef'), 'missing');
  await assertEvidenceRefused(`${b.runDir}/`, 'trailing slash');
  await assertEvidenceRefused(path.join(b.root, 'not-a-run'), 'malformed name');
});

test('V231-P09/I20/I06 a modified, loosened or symlinked dump is refused', async () => {
  const appended = await makeBackup();
  writeFileSync(path.join(appended.runDir, 'local-test.dump'), Buffer.concat([ARCHIVE, Buffer.from('x')]));
  await assertEvidenceRefused(appended.runDir, 'dump modified');
  const loose = await makeBackup();
  chmodSync(path.join(loose.runDir, 'local-test.dump'), 0o644);
  await assertEvidenceRefused(loose.runDir, 'dump 0644');
  const linked = await makeBackup();
  const copy = path.join(path.dirname(linked.root), 'dump-copy');
  copyFileSync(path.join(linked.runDir, 'local-test.dump'), copy);
  chmodSync(copy, 0o600);
  rmSync(path.join(linked.runDir, 'local-test.dump'));
  symlinkSync(copy, path.join(linked.runDir, 'local-test.dump'));
  await assertEvidenceRefused(linked.runDir, 'dump symlink');
});

test('V231-P10/P11/P12/P13/P24 wrong dump sha, wrong record self-hash, wrong target, other marker, tampered manifest are refused', async () => {
  const dumpSha = await makeBackup();
  editManifest(dumpSha.runDir, (m) => { m.dump.sha256 = sha('other archive'); });
  await assertEvidenceRefused(dumpSha.runDir, 'wrong dump sha');
  const record = await makeBackup();
  editManifest(record.runDir, (m) => { m.manifestSha256 = sha('not the self hash'); }, { rehash: false });
  await assertEvidenceRefused(record.runDir, 'wrong record sha');
  const target = await makeBackup();
  editManifest(target.runDir, (m) => { m.target = 'mona_local_test@127.0.0.1:5433/mona_local_test'; });
  await assertEvidenceRefused(target.runDir, 'wrong target');
  const marker = await makeBackup({ marker: OTHER });
  const text = await assertEvidenceRefused(marker.runDir, 'other marker');
  assert.match(text, /another LOCAL_TEST marker/);
  assert.ok(!text.includes(OTHER));
  const tampered = await makeBackup();
  editManifest(tampered.runDir, (m) => { m.createdAt = '2026-10-03T12:00:01.000Z'; }, { rehash: false });
  await assertEvidenceRefused(tampered.runDir, 'edited after creation');
});

test('V231-P14 a backup produced by a different backup tool source is refused', async () => {
  const b = await makeBackup();
  const text = await assertEvidenceRefused(b.runDir, 'tool sha', { hashes: { 'local-test-backup.mjs': [{ ok: true, sha256: sha('another backup tool') }] } });
  assert.match(text, /different scripts\/database\/local-test-backup\.mjs source/);
  const unreadable = await run([...DRY, ...RESUME_ARGS(b.runDir)], { hashes: { 'local-test-backup.mjs': [{ ok: false, reason: 'is missing or is a symlink' }] } });
  assert.equal(unreadable.code, 1);
  assert.match(unreadable.text, /phase=backup-evidence/);
});

test('V231-P21/I13/I14/I15/I16/I17/I18 stale format, wrong state, other payload, non-canonical JSON, extra field, renamed run are refused', async () => {
  const v1 = await makeBackup();
  editManifest(v1.runDir, (m) => { m.format = 'mona-local-test-backup/v1'; delete m.migrations; delete m.lock; });
  assert.match(await assertEvidenceRefused(v1.runDir, 'v1 manifest'), /format/);
  const v1Shaped = await makeBackup();
  editManifest(v1Shaped.runDir, (m) => { m.format = 'mona-local-test-backup/v1'; });
  assert.match(await assertEvidenceRefused(v1Shaped.runDir, 'v1 format string with v4 fields'), /format is not mona-local-test-backup\/v4/);
  const state = await makeBackup();
  editManifest(state.runDir, (m) => { m.state = 'EXACT_BASELINE'; });
  await assertEvidenceRefused(state.runDir, 'state');
  const migration = await makeBackup();
  editManifest(migration.runDir, (m) => { m.migrations[2][1] = sha('other migration'); });
  assert.match(await assertEvidenceRefused(migration.runDir, 'migration sha'), /different migration payload/);
  const lock = await makeBackup();
  editManifest(lock.runDir, (m) => { m.lock.sha256 = sha('other lock'); });
  await assertEvidenceRefused(lock.runDir, 'lock sha');
  const compact = await makeBackup();
  editManifest(compact.runDir, () => {}, { rehash: false, serialize: (m) => `${JSON.stringify(m)}\n` });
  await assertEvidenceRefused(compact.runDir, 'non-canonical JSON');
  const extra = await makeBackup();
  editManifest(extra.runDir, (m) => { m.note = 'extra'; });
  await assertEvidenceRefused(extra.runDir, 'extra key');
  const renamed = await makeBackup();
  const moved = path.join(renamed.root, 'local-test-20261003T120000Z-0000beef');
  renameSync(renamed.runDir, moved);
  await assertEvidenceRefused(moved, 'renamed run');
  const payloadDrift = await makeBackup({ payload: { ...fakePayload(), migrations: fakePayload().migrations.slice(0, 4) } });
  await assertEvidenceRefused(payloadDrift.runDir, 'backup under a 4-migration payload');
});

test('V231-P23/I07/I08/I19/I29 symlinked run directory, extra file, loose directory, symlinked manifest, foreign owner are refused', async () => {
  const linked = await makeBackup();
  const alias = path.join(linked.root, 'local-test-20261003T120000Z-11111111');
  symlinkSync(linked.runDir, alias);
  await assertEvidenceRefused(alias, 'symlinked run directory');
  const extra = await makeBackup();
  writeFileSync(path.join(extra.runDir, 'extra'), 'x', { mode: 0o600 });
  await assertEvidenceRefused(extra.runDir, 'extra file');
  const loose = await makeBackup();
  chmodSync(loose.runDir, 0o755);
  await assertEvidenceRefused(loose.runDir, 'run directory 0755');
  const manifestLink = await makeBackup();
  const copy = path.join(path.dirname(manifestLink.root), 'manifest-copy');
  copyFileSync(path.join(manifestLink.runDir, MANIFEST), copy);
  chmodSync(copy, 0o600);
  rmSync(path.join(manifestLink.runDir, MANIFEST));
  symlinkSync(copy, path.join(manifestLink.runDir, MANIFEST));
  await assertEvidenceRefused(manifestLink.runDir, 'manifest symlink');
  const owner = await makeBackup();
  await assertEvidenceRefused(owner.runDir, 'foreign uid', { uid: process.getuid() + 1 });
});

test('V231-I11/I12 evidence inside the repository or under temporary storage is refused', async () => {
  const b = await makeBackup();
  assert.match(await assertEvidenceRefused(b.runDir, 'inside repository', { repoRoot: path.dirname(b.root) }), /outside the repository/);
  assert.match(await assertEvidenceRefused(b.runDir, 'temporary storage', { forbiddenRoots: [os.tmpdir()] }), /outside temporary storage/);
});

test('V231-P18/P20/P29/I05 plan cross-use: generic vs resume, backup A vs backup B, same run name rebuilt — refused before the runtime', async () => {
  const a = await makeBackup();
  // V2.3.2: B is a second backup of the SAME current checkpoint (no new checkpoint recorded).
  const b = await makeBackup({ suffix: 'b2b2b2b2', root: a.root, archive: Buffer.from('PGDMP another archive\n'), checkpoint: false });
  const generic = await planFor();
  const resumeA = await resumePlan(a.runDir);
  const resumeB = await resumePlan(b.runDir);
  assert.equal(new Set([generic, resumeA, resumeB]).size, 3);
  for (const [argv, label] of [
    [[...EXECUTE(generic), ...RESUME_ARGS(a.runDir, ANY_AUTH)], 'generic plan → resume'],
    [EXECUTE(resumeA), 'resume plan → generic'],
    [[...EXECUTE(resumeA), ...RESUME_ARGS(b.runDir, ANY_AUTH)], 'plan for A → evidence B'],
  ]) {
    const r = await run(argv, { runtime: { states: SEQ.RESUME } });
    assert.equal(r.code, 1, label);
    assert.match(r.text, /phase=plan/, label);
    assert.equal(r.loaded.length, 0, label);
    assert.equal(r.counts.seed, undefined, label);
  }
  rmSync(a.runDir, { recursive: true });
  const rebuilt = await makeBackup({ root: a.root, archive: Buffer.from('PGDMP rebuilt under the same name\n'), checkpoint: false });
  assert.equal(rebuilt.runDir, a.runDir);
  const r = await resume(a.runDir, { plan: resumeA });
  assert.equal(r.code, 1);
  assert.match(r.text, /phase=plan/);
  assert.equal(r.counts.seed, undefined);
});

test('V231-P19/P27/P28/I25 no V2.2 full, V2.3 checkpoint/resume or other-domain plan is a V2.3.1 digest; removed actions cannot be built', () => {
  const PRE_V23_FULL_PLAN_DIGEST = 'fb3e9dcdfe0d8566f9d4bf3476b02c53251b15e5ecff05213f9bb4cdec5eafa4';
  const generic = buildPreparePlan(PLAN_INPUT());
  assert.notEqual(digestPreparePlan(generic), PRE_V23_FULL_PLAN_DIGEST);
  assert.equal(prepareModule.PLAN_DOMAIN, 'mona-jacinta-local-test-prepare-plan-v4'); // R4: no V2.3.2 (v3) plan digest is ever accepted
  for (const old of ['v1', 'v2', 'v3']) {
    const oldDigest = (plan) => sha(`mona-jacinta-local-test-prepare-plan-${old}\n${JSON.stringify(plan)}\n`);
    assert.notEqual(oldDigest(generic), digestPreparePlan(generic));
  }
  for (const action of ['full', 'stop-after-backfill', 'resume-from-post-backfill', 'FULL', '']) {
    assert.throws(() => buildPreparePlan({ ...PLAN_INPUT(), action }), /unknown prepare action/);
    assert.equal(decidePrepareAction('FRESH', action).ok, false, action);
  }
  assert.throws(() => buildPreparePlan({ ...PLAN_INPUT(), action: 'resume-after-verified-backup' }), /exactly one verified backup/);
  assert.throws(() => buildPreparePlan({ ...PLAN_INPUT(), backup: { run: RUN } }), /exactly one verified backup/);
});

test('V231-I26 the resume digest binds every backup field', () => {
  const backup = {
    run: RUN, dumpSha256: sha('d'), dumpBytes: 10, manifestSha256: sha('m'), toolSha256: sha('t'),
    checkpointId: 'cp-20261003T110000Z-0123456789abcdef0123456789abcdef', checkpointSha256: sha('c'), tocSha256: sha('toc'), pgRestoreSha256: sha('r'),
  };
  const digest = (b) => digestPreparePlan(buildPreparePlan({ ...PLAN_INPUT(), action: 'resume-after-verified-backup', backup: b }));
  const base = digest(backup);
  const variants = [
    { ...backup, run: 'local-test-20261003T120000Z-00000000' }, { ...backup, dumpSha256: sha('d2') }, { ...backup, dumpBytes: 11 },
    { ...backup, manifestSha256: sha('m2') }, { ...backup, toolSha256: sha('t2') },
    // V2.3.2: the checkpoint, the archive TOC and the pg_restore binary are bound too.
    { ...backup, checkpointId: 'cp-20261003T110000Z-fedcba9876543210fedcba9876543210' }, { ...backup, checkpointSha256: sha('c2') },
    { ...backup, tocSha256: sha('toc2') }, { ...backup, pgRestoreSha256: sha('r2') },
  ].map(digest);
  for (const d of variants) assert.notEqual(d, base);
  assert.equal(new Set(variants).size, variants.length);
  const text = canonicalPreparePlan(buildPreparePlan({ ...PLAN_INPUT(), action: 'resume-after-verified-backup', backup: { ...backup, path: '/synthetic/home/secret-path' } }));
  assert.ok(!text.includes('/synthetic/home'), 'the evidence path is never bound or printed in the plan');
});

test('V231-I01/I02/I03 an unexpected state after any generic step stops before seed #2 and before any checkpoint line', async () => {
  for (const [states, seeds, label] of [
    [['FRESH', 'POST_BACKFILL'], undefined, 'POST_BACKFILL after migrate'],
    [['MIGRATED_EMPTY', 'POST_BACKFILL'], 1, 'POST_BACKFILL after seed #1'],
    [['POST_SEED1', 'EXACT_BASELINE'], undefined, 'EXACT_BASELINE after backfill'],
    [['MIGRATED_EMPTY', 'POST_SEED1', 'POST_SEED1'], 1, 'backfill without effect'],
  ]) {
    const r = await execute({ runtime: { states } });
    assert.equal(r.code, 1, label);
    assert.match(r.text, /phase=classify/, label);
    assert.equal(r.counts.seed, seeds, label);
    assert.equal(r.counts.verify, undefined, label);
    assert.ok(!r.text.includes(CHECKPOINT_LINE), label);
    assert.equal(r.order.at(-1), 'close', label);
  }
  const mid = await execute({ runtime: { states: ['MIGRATED_EMPTY', 'POST_BACKFILL'] } });
  assert.ok(!mid.order.includes('backfill'));
});

test('V231-I04 the backup is re-verified before the protected transaction opens: a dump changed after the plan check stops it', async () => {
  for (const tamper of [
    (b) => writeFileSync(path.join(b.runDir, 'local-test.dump'), Buffer.from('PGDMP swapped after the plan check\n')),
    (b) => rmSync(b.runDir, { recursive: true }),
    (b) => editManifest(b.runDir, (m) => { m.createdAt = '2026-10-03T12:30:00.000Z'; }),
  ]) {
    const b = await makeBackup();
    const r = await resume(b.runDir, { runtime: { hooks: { classify: (n) => { if (n === 1) tamper(b); } } } });
    assert.equal(r.code, 1, r.text);
    assert.match(r.text, /phase=backup-evidence — the verified backup or its checkpoint changed, expired or disappeared after the plan check; seed #2 was NOT run/);
    assert.equal(r.counts.resumeSeed2, undefined);
    assert.deepEqual(r.runtimeOrder, ['loadRuntime', COMPANY_HASH, 'prove', 'classify', 'hash:local-test-backup.mjs', 'close']);
  }
});

test('V231-P25/P26/I35 the resume refuses every start state except POST_BACKFILL; EXACT_BASELINE is check-only', async () => {
  const b = await makeBackup();
  const plan = await resumePlan(b.runDir);
  for (const state of ['FRESH', 'MIGRATED_EMPTY', 'POST_SEED1', 'EXACT_BASELINE', 'PARTIAL_UNSAFE', 'OPERATIONAL_DATA', 'MIGRATION_DRIFT', 'UNKNOWN', 'nonsense']) {
    const r = await resume(b.runDir, { plan, runtime: { states: [state] } });
    assert.equal(r.code, 1, state);
    assert.deepEqual(r.runtimeOrder, ['loadRuntime', COMPANY_HASH, 'prove', 'classify', 'close'], state);
    assert.match(r.text, /requires state POST_BACKFILL/, state);
  }
  const check = await run(CHECK, { runtime: { states: ['EXACT_BASELINE'] } });
  assert.equal(check.code, 0);
});

// V2.3.2 contract evolution: every case consumes its checkpoint (single use), so each gets
// its own backup; after any failure from seed #2 on, the checkpoint stays consumed.
test('AC-180 V231-I30/I27 resume failures (R4): the owner rolls back at each stage or the COMMIT outcome is unknown — a fixed message, no RESUME line, no value, and never a retry', async () => {
  const cases = [
    [{ states: ['POST_BACKFILL', 'POST_BACKFILL'], resume: { failAt: 'seed' } }, /phase=resume — the protected transaction was rolled back at stage seed; nothing was committed; the authorization is consumed \(issue a fresh one\); the checkpoint stays current/],
    [{ states: SEQ.RESUME, resume: { failAt: 'verify' } }, /rolled back at stage verify/],
    [{ states: SEQ.RESUME, resume: { failAt: 'guard' } }, /rolled back at stage guard/],
    [{ states: SEQ.RESUME, resume: { failAt: 'commit-unknown' } }, /phase=commit — the COMMIT outcome is UNKNOWN; nothing was recorded and NO retry is attempted: run --check-outcome/],
    [{ states: SEQ.RESUME, failOn: { close: [1] } }, /phase=close/],
  ];
  for (const [runtime, phase] of cases) {
    const home = v232Home();
    const b = await makeBackup({ home });
    const r = await resume(b.runDir, { home, runtime });
    assert.equal(r.code, 1, JSON.stringify(runtime));
    assert.match(r.text, phase);
    assertNoLeak(r.text);
    const committedThenCloseFailed = runtime.failOn?.close !== undefined; // the seed committed; only the runtime close failed afterwards
    assert.equal(/RESUME OK — from/.test(r.text), committedThenCloseFailed, JSON.stringify(runtime));
    // a failed resume records nothing (R3 ordering): the checkpoint stays CURRENT and no completion exists; only a committed one records
    const recorded = storeEntries(home).filter((n) => /consumed|completed/.test(n));
    assert.equal(recorded.length, committedThenCloseFailed ? 2 : 0, JSON.stringify(runtime));
    assert.equal(r.counts.seed, undefined);
  }
});
test('V231-I28 check at POST_BACKFILL names the verified-backup resume and changes nothing', async () => {
  const r = await run(CHECK, { runtime: { states: ['POST_BACKFILL'] } });
  assert.equal(r.code, 1);
  assert.match(r.text, /seed #2 requires a verified backup of the current checkpoint and --execute --resume-from=POST_BACKFILL --backup-evidence=<run directory>/);
  assert.deepEqual(r.runtimeOrder, ['loadRuntime', COMPANY_HASH, 'prove', 'classify', 'close']);
  const fresh = await run(CHECK, { runtime: { states: ['FRESH'] } });
  assert.match(fresh.text, /would run migrate → seed-demo → backfill-company-locations and stop at POST_BACKFILL/);
});

test('V231-I31 a resume dry-run with refused evidence prints no plan and loads nothing', async () => {
  const r = await run([...DRY, ...RESUME_ARGS('/synthetic/evidence/local-test-20261003T120000Z-a1b2c3d4')]);
  assert.equal(r.code, 1);
  assert.doesNotMatch(r.text, /plan digest|--execute requires/);
  assert.equal(r.loaded.length, 0);
});

test('V231-G1 the generic dry-run names the checkpoint action and phases; its execute line has no flag', async () => {
  const r = await run(DRY);
  assert.equal(r.code, 0);
  assert.match(r.text, /^  action: prepare-to-post-backfill — ends at state POST_BACKFILL and records a new checkpoint \(every current one is superseded before the first mutation\); seed #2 and verify-baseline are NOT run/m);
  assert.match(r.text, /^  checkpoint store: ~\/\.local\/state\/mona-jacinta\/local-test-checkpoints \(owner-only 0700, outside the repository and temporary storage\)$/m);
  assert.match(r.text, /^  phases: .* → stop-at-POST_BACKFILL$/m);
  assert.doesNotMatch(r.text, /^  backup evidence:|verify-baseline →|→ verify-baseline/m);
  assert.doesNotMatch(r.text.split('\n').find((l) => l.startsWith('  phases:')), /seed-demo.*seed-demo|verify-baseline/);
  assert.match(r.text, /^  --execute requires --confirm-local-target=\S+ --plan=[0-9a-f]{64}$/m);
  assert.equal(r.text.split('\n').length, 22); // V2.3.2: + prepare source, + checkpoint store
});

test('V231-I24 static: one seedDemo call site, behind the transition table; no full-pipeline success line or --stop-after remains', () => {
  assert.equal((CODE.match(/runtime\.seedDemo\(/g) ?? []).length, 1);
  assert.equal((CODE.match(/runtime\.verifyBaseline\(/g) ?? []).length, 2); // check mode + resume
  assert.doesNotMatch(SOURCE, /baseline prepared and strictly verified|stop-after|STOP_AFTER/);
  assert.match(CODE, /POST_SEED1: Object\.freeze\(\{ phase: PHASE\.BACKFILL, next: CHECKPOINT_STATE \}\)/);
  const steps = /const CHECKPOINT_STEPS = Object\.freeze\(\{([\s\S]*?)\n\}\);/.exec(CODE)[1];
  assert.doesNotMatch(steps, /POST_BACKFILL:|EXACT_BASELINE:/);
});

// --- V2.3.2: archive validation, checkpoint binding, single use, contained children, OWNER policy ------
// Evidence is still produced by the real backup tool (fake runtime, fake pg tools). The resume's archive
// lister is injected: it lists only the genuine synthetic archive, as pg_restore --list would.
function at(iso) {
  return () => new Date(iso);
}
const V232_NOW = Object.freeze({ checkpoint: '2026-10-03T11:00:00.000Z', backup: '2026-10-03T12:00:00.000Z', resume: '2026-10-03T13:00:00.000Z' });
const PG_RESTORE_SYN = '/synthetic/pg/bin/pg_restore';
const fakeHashBinary = (file) => ({ ok: true, sha256: sha(path.basename(file)) });
// Lists like pg_restore --list would: a synthetic custom-format archive (the magic, then a
// space) lists `toc`; anything else (random bytes, text, junk after the magic) fails.
function fakeListArchive(toc = TOC) {
  return async (file) => {
    const bytes = readFileSync(file);
    return bytes.subarray(0, 6).toString('latin1') === 'PGDMP ' && !bytes.includes('junk')
      ? { ok: true, text: toc }
      : { ok: false, reason: 'pg_restore --list failed' };
  };
}
function v232Home() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'mona-v232-home-'));
  chmodSync(home, 0o700);
  return home;
}
// A generic execute from FRESH: in V2.3.2 it records the current checkpoint in `home`.
async function v232Checkpoint(home, now = V232_NOW.checkpoint, { marker = MARKER, payload } = {}) {
  const env = { LOCAL_TEST_DATABASE_URL: URL_TEXT, LOCAL_TEST_DATABASE_MARKER_ID: marker };
  const argv = (plan) => ['--execute', `--marker-id=${marker}`, `--confirm-local-target=${CONFIRM_LOCAL_TARGET}`, `--plan=${plan}`];
  const common = { home, now: at(now), env, ...(payload ? { payloads: [payload] } : {}) };
  const plan = await planFor(common, ['--dry-run', `--marker-id=${marker}`]);
  return run(argv(plan), { ...common, runtime: { states: SEQ.FRESH } });
}
// One owner flow on the resume: dry-run, then execute with the printed digest (ANY_PLAN when refused).
async function v232Attempt(evidence, home, extra = {}) {
  const common = { home, now: at(V232_NOW.resume), listArchive: fakeListArchive(), pgRestore: PG_RESTORE_SYN, hashBinary: fakeHashBinary, ...extra };
  const dry = await run([...DRY, ...RESUME_ARGS(evidence)], common);
  const plan = /plan digest: ([0-9a-f]{64})/.exec(dry.text)?.[1] ?? ANY_PLAN;
  const authorization = extra.authorization ?? (dry.code === 0 ? await issueAuthorization(evidence, { home, plan, now: common.now }) : ANY_AUTH);
  const exec = await run([...EXECUTE(plan), ...RESUME_ARGS(evidence, authorization)], { ...common, runtime: { states: SEQ.RESUME, ...extra.runtime } });
  return { dry, exec };
}

// The backup tool itself refuses a non-archive dump, so the forgery is made by hand after a
// genuine backup: the dump is replaced and the manifest re-hashed (self-consistent).
function forgeDump(runDir, bytes) {
  const file = path.join(runDir, 'local-test.dump');
  writeFileSync(file, bytes);
  editManifest(runDir, (m) => {
    m.dump.bytes = bytes.length;
    m.dump.sha256 = sha(bytes);
  });
}

test('V232-RED-1 a self-consistent backup whose archive is not a listable archive never reaches seed #2, and is never called verified', async () => {
  for (const bytes of [Buffer.from('random non-archive bytes 0123456789abcdef'), Buffer.from('PGDMP followed by junk that pg_restore cannot list')]) {
    const home = v232Home();
    const b = await makeBackup({ home });
    forgeDump(b.runDir, bytes);
    const { dry, exec } = await v232Attempt(b.runDir, home);
    assert.equal(exec.counts.seed, undefined, 'seed #2 was reached with a non-archive backup');
    assert.equal(exec.code, 1);
    assert.equal(dry.code, 1, 'the resume dry-run accepted a non-archive backup');
    assert.doesNotMatch(dry.text, /verified/, 'the resume dry-run called a non-archive backup verified');
  }
});

test('V232-RED-2 a genuine backup of an earlier checkpoint never authorizes seed #2 after the database was re-prepared', async () => {
  const home = v232Home();
  await v232Checkpoint(home, '2026-10-03T11:00:00.000Z');
  const a = await makeBackup({ home, now: '2026-10-03T11:30:00.000Z' });
  const again = await v232Checkpoint(home, '2026-10-03T12:30:00.000Z');
  assert.equal(again.code, 0, again.text);
  const { exec } = await v232Attempt(a.runDir, home);
  assert.equal(exec.counts.seed, undefined, 'seed #2 was reached with a backup of a superseded checkpoint');
  assert.equal(exec.code, 1);
});

test('V232-RED-3 a backup authorizes exactly one committed resume: a replay never reaches the protected transaction (the checkpoint is consumed after COMMIT, the authorization is consumed)', async () => {
  const home = v232Home();
  await v232Checkpoint(home);
  const b = await makeBackup({ home });
  const first = await v232Attempt(b.runDir, home);
  assert.equal(first.exec.code, 0, first.exec.text);
  assert.equal(first.exec.counts.resumeSeed2, 1);
  const replay = await v232Attempt(b.runDir, home);
  assert.equal(replay.exec.counts.resumeSeed2, undefined, 'seed #2 was reached twice with the same backup');
  assert.equal(replay.exec.code, 1);
  // even re-using the SAME consumed authorization against a re-created current checkpoint is refused at the authorization
  const authId = readdirSync(witnessModule.authorizationStorePath(home)).find((n) => n.endsWith('.consumed.json')).replace('.consumed.json', '');
  assert.match(authId, /^[0-9a-f]{32}$/);
});

test('V232-RED-4 a timed-out migrate child leaves no descendant writing after STOP (plain, setsid, double fork, TERM ignored)', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mona-v232-proc-'));
  const marks = ['plain', 'setsid', 'dfork'].map((n) => path.join(dir, n));
  const script = path.join(dir, 'prisma.sh');
  writeFileSync(script, [
    `( sleep 1; echo late > '${marks[0]}' ) &`,
    `setsid sh -c "sleep 1; echo late > '${marks[1]}'" &`,
    `sh -c '( sh -c "sleep 1; echo late > ${marks[2]}" & )'`,
    "trap '' TERM",
    'sleep 30',
    '',
  ].join('\n'), { mode: 0o700 });
  const opts = { prisma: { ok: true, cwd: dir, script, version: '7.10.0' }, execPath: '/bin/sh', realSpawn: true, childTimeoutMs: 300, killAfterMs: 300 };
  const plan = await planFor(opts);
  const r = await run(EXECUTE(plan), opts);
  assert.equal(r.code, 1);
  assert.match(r.text, /phase=prisma/);
  await new Promise((resolve) => setTimeout(resolve, 2500));
  for (const mark of marks) assert.ok(!existsSync(mark), `a descendant wrote after STOP: ${path.basename(mark)}`);
});

test('V232-RED-6 AGENTS.md records the 2026-10-03 OWNER decision separating the LOCAL_TEST test exception from prepare/resume', () => {
  const agents = readFileSync(new URL('../../AGENTS.md', import.meta.url), 'utf8');
  const safety = agents.slice(agents.indexOf('## Database safety'), agents.indexOf('## Frozen documentation'));
  assert.match(safety, /2026-10-03 — OWNER decision: LOCAL_TEST prepare\/resume backup boundary/);
  const entry = safety.slice(safety.indexOf('- **2026-10-03 — OWNER decision'), safety.indexOf('- **DEV**')).replace(/\s+/g, ' ');
  for (const required of [
    'a prior dry-run', 'a durable verified backup corresponding to the current checkpoint', 'explicit OWNER authorization naming the target',
    'are a separate testing exception', 'does **not** authorize the `local-test-prepare` destructive resume, migration tooling, production-style data preparation, any backup bypass, or any DEV/TEST/DEMO/PILOT operation',
    'resolves the ambiguity', '**Supersedes:** any interpretation that the LOCAL_TEST destructive-test permission also exempts prepare/resume from the backup boundary',
    '**Does not supersede:** the existing permission for disposable LOCAL_TEST integration-test fixtures, provided they remain within their dedicated test harness and guards',
    'DEV, TEST, DEMO and PILOT are not covered by this decision',
  ]) assert.ok(entry.includes(required), `AGENTS.md OWNER entry lacks: ${required}`);
});

test('V232-R02 the existing LOCAL_TEST destructive-test permission is unchanged byte for byte', () => {
  const agents = readFileSync(new URL('../../AGENTS.md', import.meta.url), 'utf8');
  const start = agents.indexOf('## Database safety');
  const block = agents.slice(start, agents.indexOf('- **2026-10-03 — OWNER decision', start));
  // sha256 of the section header + the permission bullet as they were before V2.3.2.
  assert.equal(sha(block), '998811b0b00b86f7e002e58488ed6c57c18490338d83dd78a5f00f0264132e4f');
});

test('V232-R04/R05 the prepare/resume refuses test-selector and DEV/TEST/PG variables before reading any evidence', async () => {
  const b = await makeBackup();
  for (const key of ['MONA_TEST_DATABASE_TARGET', 'DATABASE_URL', 'TEST_DATABASE_URL', 'TEST_DATABASE_MARKER_ID', 'PGHOST', 'PRISMA_X']) {
    const env = { ...ENV, [key]: key === 'MONA_TEST_DATABASE_TARGET' ? 'local' : 'x' };
    for (const argv of [[...DRY, ...RESUME_ARGS(b.runDir)], [...EXECUTE(ANY_PLAN), ...RESUME_ARGS(b.runDir, ANY_AUTH)], DRY]) {
      const r = await run(argv, { env, runtime: { states: SEQ.RESUME } });
      assert.equal(r.code, 1, key);
      assert.match(r.text, /phase=config — forbidden variable/, key);
      assert.equal(r.loaded.length, 0, key);
      assert.equal(r.counts.seed, undefined, key);
    }
  }
});

// --- V232 regression suite (focused; the out-of-repository adversarial harness covers more) --------
const storeOf = (home) => prepareModule.checkpointStorePath(realpathSync(home));
const storeEntries = (home) => readdirSync(storeOf(home)).sort();
const currentId = (home) => storeEntries(home).filter((n) => n.endsWith('.checkpoint.json')).map((n) => n.split('.')[0])
  .filter((id) => !existsSync(path.join(storeOf(home), `${id}.consumed.json`)));

test('V232-F age: the backup must be 0..6 h old at dry-run and again before the protected transaction opens', async () => {
  for (const [now, ok] of [['2026-10-03T17:59:59.000Z', true], ['2026-10-03T18:00:01.000Z', false], ['2026-10-03T11:59:59.000Z', false]]) {
    const home = v232Home();
    const b = await makeBackup({ home });
    const { dry, exec } = await v232Attempt(b.runDir, home, { now: at(now) });
    assert.equal(exec.code, ok ? 0 : 1, `${now}: ${exec.text}`);
    assert.equal(exec.counts.resumeSeed2, ok ? 1 : undefined, now);
    if (!ok) assert.match(dry.text, /older than 6 h|dated in the future/, now);
  }
  // valid at the plan check, expired when re-verified before the transaction: nothing consumed
  const home = v232Home();
  const b = await makeBackup({ home });
  let clock = '2026-10-03T17:59:00.000Z';
  const plan = await planFor({ home, now: () => new Date(clock) }, [...DRY, ...RESUME_ARGS(b.runDir)]);
  const authorization = await issueAuthorization(b.runDir, { home, plan, now: () => new Date(clock) });
  const r = await run([...EXECUTE(plan), ...RESUME_ARGS(b.runDir, authorization)], {
    home, now: () => new Date(clock), runtime: { states: SEQ.RESUME, hooks: { classify: (n) => { if (n === 1) clock = '2026-10-03T18:00:01.000Z'; } } },
  });
  assert.equal(r.code, 1);
  assert.equal(r.counts.resumeSeed2, undefined);
  assert.match(r.text, /phase=backup-evidence — the verified backup or its checkpoint changed, expired/);
  assert.equal(currentId(home).length, 1, 'an expired backup must not consume the checkpoint');
  assert.deepEqual(readdirSync(witnessModule.authorizationStorePath(home)).filter((n) => n.includes('consumed')), [], 'an expired backup must not consume the authorization');
});

test('V232-C/D/E the archive must list cleanly and its TOC must be exactly the manifest TOC', async () => {
  const refusals = [
    [async () => ({ ok: false, reason: 'pg_restore exited with code 1' }), /could not be listed/],
    [async () => ({ ok: true, text: '' }), /printed nothing/],
    [async () => ({ ok: true, text: TOC.replace('dbname: mona_local_test', 'dbname: other') }), /dbname is not mona_local_test/],
    [async () => ({ ok: true, text: `${TOC}216; 2615 16400 SCHEMA - mona_local_test_guard x\n` }), /mona_local_test_guard/],
    [async () => ({ ok: true, text: TOC.replace('TABLE public Role', 'TABLE audit Role') }), /non-public/],
    [async () => ({ ok: true, text: r4Toc({ data: R4_RELATIONS.slice(1) }) }), /without its TABLE DATA/],
    [async () => ({ ok: true, text: r4Toc({ tables: [], data: [] }) }), /protected relations/],
    [async () => ({ ok: true, text: r4Toc({ extra: ['9999; 0 0 COMMENT - SCHEMA public x'] }) }), /TOC does not match the manifest/],
  ];
  for (const [listArchive, why] of refusals) {
    const home = v232Home();
    const b = await makeBackup({ home });
    const { dry, exec } = await v232Attempt(b.runDir, home, { listArchive });
    assert.equal(dry.code, 1, String(why));
    assert.match(dry.text, why);
    assert.doesNotMatch(dry.text, /plan digest|backup verified/);
    assert.equal(exec.counts.seed, undefined, String(why));
    assert.equal(currentId(home).length, 1, `${why}: a refused archive must not consume the checkpoint`);
  }
  const home = v232Home();
  const b = await makeBackup({ home });
  editManifest(b.runDir, (m) => { m.list.tables = 7; });
  assert.match((await v232Attempt(b.runDir, home)).dry.text, /TOC does not match the manifest/);
  const pgr = await makeBackup({ home });
  editManifest(pgr.runDir, (m) => { m.pgRestore.sha256 = sha('another pg_restore'); });
  assert.match((await v232Attempt(pgr.runDir, home)).dry.text, /pg_restore binary differs/);
});

test('V232-K checkpoint store tampering fails closed before any runtime', async () => {
  const tampers = [
    ['record edited', (home, id) => writeFileSync(path.join(storeOf(home), `${id}.checkpoint.json`), readFileSync(path.join(storeOf(home), `${id}.checkpoint.json`), 'utf8').replace('POST_BACKFILL', 'EXACT_BASELINE'))],
    ['record mode', (home, id) => chmodSync(path.join(storeOf(home), `${id}.checkpoint.json`), 0o644)],
    ['store mode', (home) => chmodSync(storeOf(home), 0o755)],
    ['unknown entry', (home) => writeFileSync(path.join(storeOf(home), 'notes.txt'), 'x', { mode: 0o600 })],
    ['consumed symlink', (home, id) => symlinkSync('/dev/null', path.join(storeOf(home), `${id}.consumed.json`))],
    ['record deleted', (home, id) => rmSync(path.join(storeOf(home), `${id}.checkpoint.json`))],
    ['already consumed', (home, id) => writeFileSync(path.join(storeOf(home), `${id}.consumed.json`), '{}\n', { mode: 0o600 })],
  ];
  for (const [label, tamper] of tampers) {
    const home = v232Home();
    const b = await makeBackup({ home });
    tamper(home, currentId(home)[0]);
    const { dry, exec } = await v232Attempt(b.runDir, home);
    assert.equal(dry.code, 1, label);
    assert.match(dry.text, /phase=backup-evidence — backup evidence cannot be bound: checkpoint/, label);
    assert.equal(exec.loaded.length, 0, label);
    assert.equal(exec.counts.seed, undefined, label);
  }
  // two current checkpoints (a second record written by hand): ambiguous, refused
  const home = v232Home();
  const b = await makeBackup({ home });
  const [id] = currentId(home);
  const twin = id.replace(/[0-9a-f]{32}$/, 'f'.repeat(32));
  const record = JSON.parse(readFileSync(path.join(storeOf(home), `${id}.checkpoint.json`), 'utf8'));
  record.id = twin;
  delete record.recordSha256;
  record.recordSha256 = prepareModule.checkpointRecordSelfHash(record);
  writeFileSync(path.join(storeOf(home), `${twin}.checkpoint.json`), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  assert.match((await v232Attempt(b.runDir, home)).dry.text, /more than one current checkpoint/);
});

test('AC-171 V232-W single use (R4): a failure BEFORE consumption keeps the authorization usable; a failure AFTER it burns the authorization but the checkpoint stays current for a fresh one; a committed resume consumes both', async () => {
  // before consumption: preconditions fail (the backup is swapped after the full re-verification)
  {
    const home = v232Home();
    const b = await makeBackup({ home });
    const plan = await planFor({ home }, [...DRY, ...RESUME_ARGS(b.runDir)]);
    const authorization = await issueAuthorization(b.runDir, { home, plan });
    const swapped = await run([...EXECUTE(plan), ...RESUME_ARGS(b.runDir, authorization)], {
      home, runtime: { states: SEQ.RESUME, resume: { beforePreconditions: () => writeFileSync(path.join(b.runDir, 'local-test.dump'), Buffer.from('PGDMP junk now')) } },
    });
    assert.equal(swapped.code, 1);
    assert.match(swapped.text, /stage preconditions; nothing was committed; the authorization was not consumed/);
    assert.equal(currentId(home).length, 1);
    // the SAME authorization is still unconsumed (restore the dump bytes and retry)
    writeFileSync(path.join(b.runDir, 'local-test.dump'), ARCHIVE, { mode: 0o600 });
    const retry = await run([...EXECUTE(plan), ...RESUME_ARGS(b.runDir, authorization)], { home, runtime: { states: SEQ.RESUME } });
    assert.equal(retry.code, 0, retry.text);
  }
  // after consumption: the seed fails inside the transaction
  for (const failAt of ['seed', 'verify', 'guard']) {
    const home = v232Home();
    const b = await makeBackup({ home });
    const plan = await planFor({ home }, [...DRY, ...RESUME_ARGS(b.runDir)]);
    const first = await issueAuthorization(b.runDir, { home, plan });
    const burned = await run([...EXECUTE(plan), ...RESUME_ARGS(b.runDir, first)], { home, runtime: { states: SEQ.RESUME, resume: { failAt } } });
    assert.equal(burned.code, 1, failAt);
    assert.match(burned.text, new RegExp(`rolled back at stage ${failAt}; nothing was committed; the authorization is consumed \\(issue a fresh one\\); the checkpoint stays current`));
    assert.equal(currentId(home).length, 1, `${failAt}: the checkpoint must STAY current (R3 ordering)`);
    // the burned authorization never runs again
    const replay = await run([...EXECUTE(plan), ...RESUME_ARGS(b.runDir, first)], { home, runtime: { states: SEQ.RESUME } });
    assert.equal(replay.code, 1);
    assert.match(replay.text, /authorization refused \(CONSUMED\)/);
    assert.equal(replay.counts.resumeSeed2, undefined);
    // a FRESH authorization for the same backup completes it
    const second = await issueAuthorization(b.runDir, { home, plan });
    const done = await run([...EXECUTE(plan), ...RESUME_ARGS(b.runDir, second)], { home, runtime: { states: SEQ.RESUME } });
    assert.equal(done.code, 0, done.text);
    assert.equal(currentId(home).length, 0, 'a committed resume consumes the checkpoint');
  }
});

test('V232-I01 (R4) a checkpoint consumed by another actor after the re-verification stops INSIDE the protected transaction: rolled back at preconditions, the authorization NOT consumed', async () => {
  const home = v232Home();
  const b = await makeBackup({ home });
  const r = await resume(b.runDir, {
    home,
    runtime: { states: SEQ.RESUME, resume: { beforePreconditions: () => { const [id] = currentId(home); writeFileSync(path.join(storeOf(home), `${id}.consumed.json`), '{}\n', { mode: 0o600 }); } } },
  });
  assert.equal(r.code, 1, r.text);
  assert.match(r.text, /rolled back at stage preconditions; nothing was committed; the authorization was not consumed; the checkpoint stays current/);
  assert.equal(r.counts.commit, undefined);
  assert.deepEqual(readdirSync(witnessModule.authorizationStorePath(home)).filter((n) => n.includes('consumed')), []);
  assert.equal(currentId(home).length, 0, 'the racing actor consumed it; this resume did not');
});

test('AC-172 V232-N02 after RESUME OK the checkpoint is consumed (resume-started) and a completion is recorded', async () => {
  const home = v232Home();
  const b = await makeBackup({ home });
  const { exec } = await v232Attempt(b.runDir, home);
  assert.equal(exec.code, 0, exec.text);
  const entries = storeEntries(home);
  assert.equal(entries.length, 3);
  assert.ok(entries.some((n) => n.endsWith('.consumed.json')) && entries.some((n) => n.endsWith('.completed.json')));
  for (const n of entries) assert.equal(lstatSync(path.join(storeOf(home), n)).mode & 0o777, 0o600);
  assert.equal(lstatSync(storeOf(home)).mode & 0o777, 0o700);
});

test('V232-G2 the generic run supersedes the current checkpoint before its first mutation; a failed run leaves none current', async () => {
  const home = v232Home();
  await v232Checkpoint(home, '2026-10-03T10:00:00.000Z');
  const [first] = currentId(home);
  const plan = await planFor({ home });
  const r = await run(EXECUTE(plan), { home, runtime: { states: SEQ.MIGRATED_EMPTY, failOn: { seed: [1] } } });
  assert.equal(r.code, 1);
  assert.deepEqual(currentId(home), [], 'a failed generic run must leave no current checkpoint');
  assert.match(readFileSync(path.join(storeOf(home), `${first}.consumed.json`), 'utf8'), /"reason": "superseded"/);
  const refused = await run(EXECUTE(await planFor({ home })), { home, runtime: { states: ['POST_BACKFILL'] } });
  assert.equal(refused.code, 1);
  assert.equal(storeEntries(home).length, 2, 'a refused generic run (POST_BACKFILL) neither supersedes nor records');
  const dry = await run(DRY, { home: v232Home() });
  assert.equal(dry.code, 0);
});

test('V232-O/P/Q contained children: normal exit kills leftovers; the container binary must not be rewritable', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mona-v232-proc-'));
  const mark = path.join(dir, 'after-exit');
  const script = path.join(dir, 'prisma.sh');
  writeFileSync(script, `setsid sh -c "sleep 1; echo late > '${mark}'" &\nexit 0\n`, { mode: 0o700 });
  const opts = { prisma: { ok: true, cwd: dir, script, version: '7.10.0' }, execPath: '/bin/sh', realSpawn: true, runtime: { states: ['FRESH', 'MIGRATED_EMPTY', 'POST_SEED1', 'POST_BACKFILL'] }, home: v232Home() };
  const r = await run(EXECUTE(await planFor(opts)), opts);
  assert.equal(r.code, 0, r.text);
  await new Promise((resolve) => setTimeout(resolve, 2000));
  assert.ok(!existsSync(mark), 'a descendant outlived a successful contained child');
  assert.equal(prepareModule.checkContainerBinary('/usr/bin/unshare', process.getuid()).ok, true);
  const own = path.join(dir, 'unshare');
  writeFileSync(own, '#!/bin/sh\n', { mode: 0o755 });
  assert.equal(prepareModule.checkContainerBinary(own, process.getuid()).ok, false, 'a user-owned container binary was trusted');
  const refused = await execute({ checkContainer: () => ({ ok: false, reason: 'x must be a root-owned regular file' }) });
  assert.equal(refused.code, 1);
  assert.match(refused.text, /phase=prisma — prisma was not started: x must be a root-owned regular file; nothing was applied/);
  assert.equal(refused.spawned.length, 0);
});

// --- V232 mutation-gap tests (added after the first mutation run found surviving guards) ------------
test('V232-G01b a backup bound to a superseded checkpoint is refused even when it postdates the new checkpoint (clock skew)', async () => {
  const home = v232Home();
  const a = await makeBackup({ home, now: '2026-10-03T12:00:00.000Z' }); // checkpoint A at 11:00, backup at 12:00
  const again = await v232Checkpoint(home, '2026-10-03T11:30:00.000Z'); // B recorded later, with an earlier clock
  assert.equal(again.code, 0, again.text);
  const { dry, exec } = await v232Attempt(a.runDir, home);
  assert.match(dry.text, /is bound to a checkpoint that is not the current one/);
  assert.equal(exec.counts.seed, undefined);
});

test('V232-G02 a manifest re-bound to the current checkpoint id with another record sha256 is refused', async () => {
  const home = v232Home();
  const b = await makeBackup({ home });
  editManifest(b.runDir, (m) => { m.checkpoint.recordSha256 = sha('another record'); });
  const { dry, exec } = await v232Attempt(b.runDir, home);
  assert.match(dry.text, /is bound to a checkpoint that is not the current one/);
  assert.equal(exec.counts.seed, undefined);
});

test('V232-K02 a checkpoint record edited outside its identity fields fails its self-hash (store refused)', async () => {
  for (const edit of [(t) => t.replace(/"plan": "[0-9a-f]{64}"/, `"plan": "${sha('other plan')}"`), (t) => t.replace(/"createdAt": "[^"]+"/, '"createdAt": "2026-10-03T10:59:59.000Z"')]) {
    const home = v232Home();
    const b = await makeBackup({ home });
    const [id] = currentId(home);
    const file = path.join(storeOf(home), `${id}.checkpoint.json`);
    writeFileSync(file, edit(readFileSync(file, 'utf8')));
    const { dry, exec } = await v232Attempt(b.runDir, home);
    assert.match(dry.text, /checkpoint record self-hash does not match/);
    assert.equal(exec.counts.seed, undefined);
  }
});

test('V232-B05 a run whose archive lacks the custom-format magic is refused even if a lister would accept it', async () => {
  const home = v232Home();
  const b = await makeBackup({ home });
  forgeDump(b.runDir, Buffer.from('plain bytes without the archive magic'));
  const permissive = async () => ({ ok: true, text: TOC });
  const { dry, exec } = await v232Attempt(b.runDir, home, { listArchive: permissive });
  assert.match(dry.text, /archive is not a PostgreSQL custom-format archive/);
  assert.equal(exec.counts.seed, undefined);
});

test('V232-XH01 the default home (checkpoint store, child HOME) is the passwd home, never $HOME, in both tools', () => {
  const backupSource = readFileSync(new URL('./local-test-backup.mjs', import.meta.url), 'utf8');
  for (const text of [CODE, backupSource]) {
    assert.match(text, /^ {2}home: os\.userInfo\(\)\.homedir,$/m);
    assert.doesNotMatch(text, /os\.homedir\(\)/);
  }
});

// =====================================================================================================
// V2.3.3 R4 — start guard, strict archive contract (Map counts, grammar, stderr-empty), safe errors.
// =====================================================================================================
import { execFileSync as r4ExecFileSync, spawnSync as r4SpawnSync } from 'node:child_process';

const r4Check = (text) => prepareModule.checkToc(text);

test('R4-ARC-00 a well-formed strict TOC passes with 25 tables, a deterministic multiset digest independent of line order, and its entry count', () => {
  const ok = r4Check(r4Toc());
  assert.equal(ok.ok, true, ok.reason);
  assert.equal(ok.tables, 25);
  assert.match(ok.multisetSha256, /^[0-9a-f]{64}$/);
  const lines = r4Toc().split('\n');
  const body = lines.slice(14, -1).reverse();
  const shuffled = [...lines.slice(0, 14), ...body, ''].join('\n');
  assert.equal(r4Check(shuffled).multisetSha256, ok.multisetSha256);
  assert.notEqual(r4Check(r4Toc({ extra: ['5001; 2620 40001 TRIGGER public SalePayment trg_other mona_local_test'] })).multisetSha256, ok.multisetSha256);
});
test('AC-153 R4 a duplicate TABLE entry is refused (counts, not sets)', () => {
  const dup = r4Toc({ extra: ['1001; 1259 20001 TABLE public Branch mona_local_test'] });
  assert.equal(r4Check(dup).ok, false);
  assert.match(r4Check(dup).reason, /more than once/);
});
test('AC-154 R4 a duplicate TABLE DATA entry is refused', () => {
  const dup = r4Toc({ extra: ['3001; 0 20001 TABLE DATA public Branch mona_local_test'] });
  assert.equal(r4Check(dup).ok, false);
  assert.match(r4Check(dup).reason, /more than once/);
});
test('AC-155 R4 a TABLE without TABLE DATA, a TABLE DATA without TABLE, or a missing protected table is refused', () => {
  assert.equal(r4Check(r4Toc({ data: R4_RELATIONS.slice(1) })).ok, false);
  assert.equal(r4Check(r4Toc({ tables: R4_RELATIONS.slice(1), data: R4_RELATIONS })).ok, false);
  assert.equal(r4Check(r4Toc({ tables: R4_RELATIONS.slice(1), data: R4_RELATIONS.slice(1) })).ok, false);
  assert.equal(r4Check(r4Toc({ tables: [...R4_RELATIONS, 'Intruder'], data: [...R4_RELATIONS, 'Intruder'] })).ok, false);
});
test('AC-156 R4 an entry type outside the allow-list, a malformed line, or a non-public table entry is refused', () => {
  for (const line of ['6000; 1259 50000 VIEW public v mona_local_test', '6001; 1259 50001 SEQUENCE public s mona_local_test', '6002; 0 0 ACL public x mona_local_test', '6003; 3079 0 EXTENSION - pgcrypto', '6004; 2618 5 RULE public r mona_local_test', '6005; 3256 6 POLICY public p mona_local_test',
    'not a toc line', '6006; garbage', '6007;1259 1 TABLE public Z mona_local_test', '6008; 1259 1 TABLE other Z mona_local_test']) {
    const verdict = r4Check(r4Toc({ extra: [line] }));
    assert.equal(verdict.ok, false, line);
  }
  assert.equal(r4Check(r4Toc().replace(';     Format: CUSTOM', ';     Format: TAR')).ok, false);
  assert.equal(r4Check(r4Toc().replace(';     Compression: gzip', ';     Surprise: 1')).ok, false);
});
test('AC-157 R4 a declared TOC entry count that differs from the parsed count, or is missing/repeated, is refused', () => {
  assert.equal(r4Check(r4Toc({ declared: 1 })).ok, false);
  const base = r4Toc();
  assert.equal(r4Check(base.replace(/;     TOC Entries: \d+\n/, '')).ok, false);
  assert.equal(r4Check(base.replace(/(;     TOC Entries: \d+\n)/, '$1$1')).ok, false);
});
test('AC-158 R4 two dbname lines, a foreign dbname, or any marker-schema occurrence is refused', () => {
  assert.equal(r4Check(r4Toc({ dbname: 'other' })).ok, false);
  assert.equal(r4Check(r4Toc().replace(';     dbname: mona_local_test', ';     dbname: mona_local_test\n;     dbname: mona_local_test')).ok, false);
  assert.equal(r4Check(r4Toc({ extra: ['7000; 2615 1 SCHEMA - mona_local_test_guard mona_local_test'] })).ok, false);
});

// ---- LOW-10: child stderr must be exactly empty; its bytes are never forwarded ----
function r4Spawn({ stdout = '', stderr = '', code = 0 } = {}) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
    setImmediate(() => {
      if (stdout) child.stdout.write(stdout);
      if (stderr) child.stderr.write(stderr);
      child.stdout.end(); child.stderr.end();
      setImmediate(() => child.emit('close', code, null));
    });
    return child;
  };
}
const r4ListDeps = (spawn) => ({ spawn, pgRestore: '/synthetic/pg/bin/pg_restore', home: '/synthetic/home', uid: process.getuid(), checkContainer: () => ({ ok: true }), childTimeoutMs: 2000, killAfterMs: 50, reapMs: 50 });
test('AC-160 R4 pg_restore --list with exit 0 and ONE byte of stderr (even whitespace) is refused with a fixed reason that echoes nothing', async () => {
  for (const stderr of ['x', ' ', '\n', 'pg_restore: warning: CANARY_PASSWORD_HASH_DO_NOT_LEAK\n']) {
    const result = await prepareModule.listBackupArchive('/synthetic/run/local-test.dump', r4ListDeps(r4Spawn({ stdout: r4Toc(), stderr })));
    assert.equal(result.ok, false, JSON.stringify(stderr));
    assert.equal(JSON.stringify(result).includes('CANARY'), false);
    assert.match(result.reason, /stderr/);
  }
  const clean = await prepareModule.listBackupArchive('/synthetic/run/local-test.dump', r4ListDeps(r4Spawn({ stdout: r4Toc() })));
  assert.equal(clean.ok, true);
});
test('AC-162 R4 child stderr bytes are never forwarded: runContained reports only a byte count', async () => {
  const lines = [];
  const result = await prepareModule.runContained({ ...r4ListDeps(r4Spawn({ stdout: 'out\n', stderr: 'SECRET_ROW_VALUE\n' })), log: (l) => lines.push(l), error: (l) => lines.push(l) },
    { label: 'pg_restore', command: '/synthetic/pg/bin/pg_restore', args: ['--list', '/x'], options: { cwd: '/' }, env: {} }, { onOut: () => undefined, onErr: () => undefined });
  assert.equal(result.ok, true);
  assert.equal(result.stderrBytes, 'SECRET_ROW_VALUE\n'.length);
  assert.equal(JSON.stringify([result, lines]).includes('SECRET_ROW_VALUE'), false);
});

// ---- LOW-3 / C29: the start guard at every executable entry (real child processes, harmless diagnostic flag, no DB) ----
const R4_TOOLS = ['local-test-prepare.mjs', 'local-test-backup.mjs', 'local-test-authorize-resume.mjs'];
for (const tool of R4_TOOLS) {
  test(`AC-195/196 R4 ${tool} refuses to start when NODE_OPTIONS requests a diagnostic report, printing only a fixed code`, () => {
    const file = fileURLToPath(new URL(`./${tool}`, import.meta.url));
    const r = r4SpawnSync(process.execPath, [file, '--dry-run'], { env: { PATH: process.env.PATH, NODE_OPTIONS: '--report-on-signal=CANARY_FLAG_VALUE' }, encoding: 'utf8', timeout: 20000 });
    // diagnostics only (expectations unchanged): a sandbox that drops the child's stderr shows up as status 1 + empty output
    const seen = JSON.stringify({ status: r.status, signal: r.signal, spawnError: r.error?.code ?? null, stdoutBytes: r.stdout.length, stderrBytes: r.stderr.length });
    assert.equal(r.status, 1, `${seen} ${r.stdout}${r.stderr}`);
    assert.match(`${r.stdout}${r.stderr}`, /FAIL: E_DIAGNOSTIC_FLAGS/, seen);
    assert.equal(`${r.stdout}${r.stderr}`.includes('CANARY_FLAG_VALUE'), false);
    assert.equal(r.stdout, '');
  });
}
void r4ExecFileSync;

// =====================================================================================================
// V2.3.3 R4 — OWNER authorization binding, witness persistence, --check-outcome, --reconcile-completion
// =====================================================================================================
const r4Manifest = (runDir) => JSON.parse(readFileSync(path.join(runDir, MANIFEST), 'utf8'));
const r4NoDbWrites = (r) => { for (const k of ['seed', 'backfill', 'resumeSeed2', 'commit']) assert.equal(r.counts[k], undefined, k); };
// a committed resume (fake runtime) for a fresh home + backup; returns the pieces the outcome tests need
async function r4Committed() {
  const home = v232Home();
  const b = await makeBackup({ home });
  const plan = await planFor({ home }, [...DRY, ...RESUME_ARGS(b.runDir)]);
  const authId = await issueAuthorization(b.runDir, { home, plan });
  const r = await run([...EXECUTE(plan), ...RESUME_ARGS(b.runDir, authId)], { home, runtime: { states: SEQ.RESUME } });
  assert.equal(r.code, 0, r.text);
  const m = r4Manifest(b.runDir);
  return { home, b, plan, authId, fPre: m.preWitness.fPre, fPost: sha(`fpost:${m.preWitness.fPre}`), manifest: m };
}
const OUTCOME_ARGS = (b, extra = []) => ['--check-outcome', `--marker-id=${MARKER}`, `--backup-evidence=${b.runDir}`, ...extra];
const RECONCILE_ARGS = (b) => ['--reconcile-completion', `--marker-id=${MARKER}`, `--backup-evidence=${b.runDir}`, `--confirm-local-target=${CONFIRM_LOCAL_TARGET}`];

test('AC-083/084 R4 an authorization bound to another backup, plan, state, checkpoint or installation is refused before the runtime does anything; nothing is consumed', async () => {
  const mutations = {
    otherBackupRun: { backupRun: 'local-test-20261003T120000Z-00000000' }, otherDump: { dumpSha256: sha('another dump') }, otherManifest: { manifestSha256: sha('another manifest') },
    otherFPre: { fPre: sha('another state') }, otherPreWitness: { preWitnessSha256: sha('another witness') }, otherPlan: { planDigest: sha('another plan') },
    otherCheckpoint: { checkpointId: 'cp-20261003T110000Z-ffffffffffffffffffffffffffffffff' }, otherCheckpointSha: { checkpointRecordSha256: sha('another checkpoint') }, otherInstallation: { markerIdSha256: sha('another marker') },
  };
  for (const [name, patch] of Object.entries(mutations)) {
    const home = v232Home();
    const b = await makeBackup({ home });
    const plan = await planFor({ home }, [...DRY, ...RESUME_ARGS(b.runDir)]);
    const m = r4Manifest(b.runDir);
    const authId = createHash('sha256').update(name).digest('hex').slice(0, 32);
    const text = witnessModule.buildAuthorizationRecord({
      authId, target: CONFIRM_LOCAL_TARGET, markerIdSha256: sha(MARKER), backupRun: path.basename(b.runDir), dumpSha256: m.dump.sha256, manifestSha256: sha(readFileSync(path.join(b.runDir, MANIFEST))),
      fPre: m.preWitness.fPre, preWitnessSha256: m.preWitnessSha256, checkpointId: m.checkpoint.id, checkpointRecordSha256: m.checkpoint.recordSha256, planDigest: plan,
      createdAt: '2026-10-03T12:55:00.000Z', expiresAt: '2026-10-03T13:55:00.000Z', ...patch,
    });
    const store = await witnessModule.ensureAuthorizationStore({ home, fs: witnessModule.realWitnessFs });
    await witnessModule.writeAuthorizationRecord({ dir: store.dir, authId, text });
    const r = await run([...EXECUTE(plan), ...RESUME_ARGS(b.runDir, authId)], { home, runtime: { states: SEQ.RESUME } });
    assert.equal(r.code, 1, name);
    assert.match(r.text, /phase=authorization — authorization is bound to another backup, plan or state; seed #2 was NOT run/, name);
    assert.equal(r.counts.resumeSeed2, undefined, name);
    assert.deepEqual(readdirSync(store.dir).filter((n) => n.includes('consumed')), [], name);
    assert.equal(currentId(home).length, 1, name);
  }
});

test('AC-048/082/085 R4 an unknown, expired, not-yet-valid or tampered authorization is refused with a fixed reason; the witness directory problem refuses before the runtime acts', async () => {
  const home = v232Home();
  const b = await makeBackup({ home });
  const plan = await planFor({ home }, [...DRY, ...RESUME_ARGS(b.runDir)]);
  const refuse = async (authorization, pattern, why, extra = {}) => {
    const r = await run([...EXECUTE(plan), ...RESUME_ARGS(b.runDir, authorization)], { home, runtime: { states: SEQ.RESUME }, ...extra });
    assert.equal(r.code, 1, why);
    assert.match(r.text, pattern, why);
    assert.equal(r.counts.resumeSeed2, undefined, why);
    assertNoLeak(r.text);
  };
  await refuse('b'.repeat(32), /authorization refused \(MISSING\)/, 'unknown id');
  const expired = await issueAuthorization(b.runDir, { home, plan, ttlMs: 60 * 1000 }); // created 5 min before the clock, valid 1 min: expired now
  await refuse(expired, /authorization refused \(EXPIRED\)/, 'expired');
  const early = await issueAuthorization(b.runDir, { home, plan, now: '2026-10-03T12:00:00.000Z' }); // created 11:55, clock 13:00 (valid until 12:55): expired
  await refuse(early, /authorization refused \(EXPIRED\)/, 'expired (earlier clock)');
  const future = await issueAuthorization(b.runDir, { home, plan, now: '2026-10-03T14:00:00.000Z' }); // created 13:55: not yet valid at 13:00
  await refuse(future, /authorization refused \(NOT_YET_VALID\)/, 'not yet valid');
  const good = await issueAuthorization(b.runDir, { home, plan });
  const file = path.join(witnessModule.authorizationStorePath(home), `${good}.json`);
  chmodSync(file, 0o644);
  await refuse(good, /authorization refused \(MODE\)/, 'loosened mode');
  chmodSync(file, 0o600);
  // the witness directory root is a symlink: refused BEFORE the runtime acts
  const root = prepareModule.witnessRootPath(home);
  mkdirSync(path.dirname(root), { recursive: true });
  symlinkSync(mkdtempSync(path.join(os.tmpdir(), 'mona-wd-')), root);
  await refuse(good, /phase=witness-dir — the witness directory could not be prepared/, 'witness root symlink');
  assert.deepEqual(readdirSync(witnessModule.authorizationStorePath(home)).filter((n) => n.includes('consumed')), []);
});

test('AC-040/045/061 R4 a witness that cannot be made durable (its directory vanishes after the pre-transaction check) rolls the transaction back at stage witness; nothing is committed and no witness file exists', async () => {
  const home = v232Home();
  const b = await makeBackup({ home });
  const plan = await planFor({ home }, [...DRY, ...RESUME_ARGS(b.runDir)]);
  const authId = await issueAuthorization(b.runDir, { home, plan });
  const wdir = path.join(prepareModule.witnessRootPath(home), path.basename(b.runDir));
  const r = await run([...EXECUTE(plan), ...RESUME_ARGS(b.runDir, authId)], {
    home, runtime: { states: SEQ.RESUME, resume: { beforePreconditions: () => { rmSync(wdir, { recursive: true }); writeFileSync(wdir, 'not a directory'); } } },
  });
  assert.equal(r.code, 1, r.text);
  assert.match(r.text, /rolled back at stage witness; nothing was committed; the authorization is consumed \(issue a fresh one\); the checkpoint stays current/);
  assert.equal(r.counts.commit, undefined);
  assert.equal(readFileSync(wdir, 'utf8'), 'not a directory');
  assert.equal(currentId(home).length, 1);
});

test('AC-019/029 R4 the committed resume writes a POST witness that binds to the real manifest, dump, PRE witness, fPre, plan and authorization record content', async () => {
  const c = await r4Committed();
  const wfile = path.join(prepareModule.witnessRootPath(c.home), path.basename(c.b.runDir), `${c.authId}.post.json`);
  const text = readFileSync(wfile, 'utf8');
  const recText = readFileSync(path.join(witnessModule.authorizationStorePath(c.home), `${c.authId}.json`), 'utf8');
  const ctx = {
    run: path.basename(c.b.runDir), manifestSha256: sha(readFileSync(path.join(c.b.runDir, MANIFEST))), dumpSha256: c.manifest.dump.sha256, preWitnessSha256: c.manifest.preWitnessSha256,
    fPre: c.fPre, markerIdSha256: sha(MARKER), serverVersionNum: '170004', domainSha256: DOMAIN_SHA, acceptedTransformationContracts: [TRANSFORM_SHA], consumedAuthIds: [c.authId], authRecords: { [c.authId]: recText },
  };
  const bound = witnessModule.bindPost(text, ctx, c.authId);
  assert.equal(bound.ok, true, bound.reason);
  assert.equal(bound.obj.fPost, c.fPost);
  assert.equal(bound.obj.planDigest, c.plan);
  assert.equal(witnessModule.bindPost(text, { ...ctx, serverVersionNum: '170005' }, c.authId).ok, false);
  assert.equal(JSON.stringify(readdirSync(path.dirname(wfile))), JSON.stringify([`${c.authId}.post.json`]));
});

test('AC-064/065/071 R4 --check-outcome: PRE state ⇒ PRE_SEED_EXACT; the committed state ⇒ POST_SEED_EXACT naming the authorization; both read-only, exit 0', async () => {
  const c = await r4Committed();
  const before = JSON.stringify([storeEntries(c.home), readdirSync(witnessModule.authorizationStorePath(c.home))]);
  const pre = await run(OUTCOME_ARGS(c.b), { home: c.home, runtime: { outcome: { digests: { pre: c.fPre, post: sha('x') } } } });
  assert.equal(pre.code, 0, pre.text);
  assert.match(pre.text, /OUTCOME state=PRE_SEED_EXACT/);
  assert.match(pre.text, /next=RESUME_ALLOWED_AFTER_NORMAL_CHECKS/);
  const preWithAuth = await run(OUTCOME_ARGS(c.b, [`--authorization=${c.authId}`]), { home: c.home, runtime: { outcome: { digests: { pre: c.fPre, post: sha('x') } } } });
  assert.match(preWithAuth.text, /next=FRESH_AUTHORIZATION_REQUIRED/);
  const post = await run(OUTCOME_ARGS(c.b), { home: c.home, runtime: { outcome: { digests: { pre: sha('changed'), post: c.fPost } } } });
  assert.equal(post.code, 0, post.text);
  assert.match(post.text, new RegExp(`OUTCOME state=POST_SEED_EXACT authId=${c.authId} witnesses=1valid/0invalid`));
  assert.match(post.text, /next=RECORD_COMPLETION_ONLY/);
  for (const r of [pre, preWithAuth, post]) { r4NoDbWrites(r); assert.equal(r.counts.checkOutcome, 1); assertNoLeak(r.text); }
  assert.equal(JSON.stringify([storeEntries(c.home), readdirSync(witnessModule.authorizationStorePath(c.home))]), before, 'check-outcome must write nothing');
});

test('AC-066/069/074 R4 --check-outcome: a state that matches neither, a tampered witness, or the wrong run is PARTIAL_OR_UNKNOWN with exit 1 and a STOP next action', async () => {
  const c = await r4Committed();
  const neither = await run(OUTCOME_ARGS(c.b), { home: c.home, runtime: { outcome: { digests: { pre: sha('a'), post: sha('b') } } } });
  assert.equal(neither.code, 1);
  assert.match(neither.text, /OUTCOME state=PARTIAL_OR_UNKNOWN reason=NO_MATCH/);
  assert.match(neither.text, /next=STOP_OWNER_RESTORE_FROM_BACKUP/);
  // a tampered witness (fPost edited, self-hash stale) can never prove POST
  const wfile = path.join(prepareModule.witnessRootPath(c.home), path.basename(c.b.runDir), `${c.authId}.post.json`);
  const w = JSON.parse(readFileSync(wfile, 'utf8')); w.planDigest = sha('edited');
  chmodSync(wfile, 0o600); writeFileSync(wfile, `${JSON.stringify(w)}\n`, { mode: 0o600 });
  const tampered = await run(OUTCOME_ARGS(c.b), { home: c.home, runtime: { outcome: { digests: { pre: sha('a'), post: c.fPost } } } });
  assert.equal(tampered.code, 1);
  assert.match(tampered.text, /OUTCOME state=PARTIAL_OR_UNKNOWN reason=NO_MATCH witnesses=0valid\/1invalid/);
  // the same committed state seen from ANOTHER run's evidence: no witness for that run ⇒ PARTIAL (accepted fail-closed)
  const other = await makeBackup({ home: c.home, suffix: 'deadbeef' });
  const wrongRun = await run(OUTCOME_ARGS(other), { home: c.home, runtime: { outcome: { digests: { pre: sha('a'), post: c.fPost } } } });
  assert.equal(wrongRun.code, 1);
  assert.match(wrongRun.text, /reason=NO_MATCH/);
  for (const r of [neither, tampered, wrongRun]) r4NoDbWrites(r);
});

test('AC-075 R4 --check-outcome: invalid PRE evidence is PARTIAL without touching the database; a timeout is reported once with no retry; an unknown authorization id is refused', async () => {
  const c = await r4Committed();
  const file = path.join(c.b.runDir, MANIFEST);
  const m = JSON.parse(readFileSync(file, 'utf8')); m.preWitness.fPre = 'f'.repeat(64);
  chmodSync(file, 0o600); writeFileSync(file, `${JSON.stringify(m, null, 2)}\n`, { mode: 0o600 });
  const bad = await run(OUTCOME_ARGS(c.b), { home: c.home, runtime: { states: SEQ.RESUME } });
  assert.equal(bad.code, 1);
  assert.match(bad.text, /OUTCOME state=PARTIAL_OR_UNKNOWN reason=PRE_EVIDENCE_INVALID/);
  assert.equal(bad.loaded.length, 0, 'no database is contacted when the PRE evidence is invalid');
  const d = await r4Committed();
  const timeout = await run(OUTCOME_ARGS(d.b), { home: d.home, runtime: { outcome: { fails: true, timeout: true } } });
  assert.equal(timeout.code, 1);
  assert.match(timeout.text, /phase=outcome — the read-only verification timed out \(lock or statement timeout\); the read-only verification failed \(details not shown\); nothing was changed and nothing is retried/);
  assert.equal(timeout.counts.checkOutcome, 1);
  assert.ok(timeout.order.includes('close'));
  const unknown = await run(OUTCOME_ARGS(d.b, [`--authorization=${'c'.repeat(32)}`]), { home: d.home });
  assert.equal(unknown.code, 1);
  assert.match(unknown.text, /phase=authorization — the authorization id matches no record or consumed marker/);
  assert.equal(unknown.loaded.length, 0);
});

test('AC-174/176/177 R4 --reconcile-completion: only after an exact POST_SEED_EXACT, only file-side, idempotent, and crash-safe between the two records (LOW-6)', async () => {
  const c = await r4Committed();
  const cp = storeEntries(c.home);
  const id = cp.find((n) => n.endsWith('.checkpoint.json')).split('.')[0];
  const consumedFile = path.join(storeOf(c.home), `${id}.consumed.json`);
  const completedFile = path.join(storeOf(c.home), `${id}.completed.json`);
  const post = { home: c.home, runtime: { outcome: { digests: { pre: sha('changed'), post: c.fPost } } } };
  // already consistent ⇒ no-op success, nothing written
  const noop = await run(RECONCILE_ARGS(c.b), post);
  assert.equal(noop.code, 0, noop.text);
  assert.match(noop.text, /RECONCILE OK — completion already recorded and consistent; nothing was written/);
  // crash before ANY record: both are written, still zero database writes
  rmSync(consumedFile); rmSync(completedFile);
  const fresh = await run(RECONCILE_ARGS(c.b), post);
  assert.equal(fresh.code, 0, fresh.text);
  assert.match(fresh.text, /RECONCILE OK — checkpoint cp-\S+ recorded consumed and completed for authorization/);
  const completed = JSON.parse(readFileSync(completedFile, 'utf8'));
  assert.deepEqual([completed.fPre, completed.fPost, completed.authId, completed.run], [c.fPre, c.fPost, c.authId, path.basename(c.b.runDir)]);
  assert.equal(JSON.parse(readFileSync(consumedFile, 'utf8')).reason, 'resume-committed');
  // crash BETWEEN the two writes (consumed present, completed missing): the missing record is completed idempotently
  rmSync(completedFile);
  const between = await run(RECONCILE_ARGS(c.b), post);
  assert.equal(between.code, 0, between.text);
  assert.ok(existsSync(completedFile));
  // disagreement refuses: a completion naming another fPost, or a consumption by another run/reason
  const bad = JSON.parse(readFileSync(completedFile, 'utf8')); bad.fPost = sha('other');
  chmodSync(completedFile, 0o600); writeFileSync(completedFile, `${JSON.stringify(bad, null, 2)}\n`, { mode: 0o600 });
  const disagree = await run(RECONCILE_ARGS(c.b), post);
  assert.equal(disagree.code, 1);
  assert.match(disagree.text, /existing completion records disagree with the verified outcome; nothing was written/);
  rmSync(completedFile);
  const cm = JSON.parse(readFileSync(consumedFile, 'utf8')); cm.reason = 'superseded';
  chmodSync(consumedFile, 0o600); writeFileSync(consumedFile, `${JSON.stringify(cm, null, 2)}\n`, { mode: 0o600 });
  const consumedDisagree = await run(RECONCILE_ARGS(c.b), post);
  assert.equal(consumedDisagree.code, 1);
  assert.equal(existsSync(completedFile), false);
  for (const r of [noop, fresh, between, disagree, consumedDisagree]) { r4NoDbWrites(r); assertNoLeak(r.text); }
  // anything but POST_SEED_EXACT writes nothing and exits non-zero
  rmSync(consumedFile);
  const pre = await run(RECONCILE_ARGS(c.b), { home: c.home, runtime: { outcome: { digests: { pre: c.fPre, post: sha('x') } } } });
  assert.equal(pre.code, 1);
  assert.match(pre.text, /the state is PRE_SEED_EXACT; no completion is recorded \(nothing was written\)|OUTCOME state=PRE_SEED_EXACT/);
  assert.equal(existsSync(consumedFile) || existsSync(completedFile), false);
  const partial = await run(RECONCILE_ARGS(c.b), { home: c.home, runtime: { outcome: { digests: { pre: sha('a'), post: sha('b') } } } });
  assert.equal(partial.code, 1);
  assert.equal(existsSync(consumedFile) || existsSync(completedFile), false);
});

test('AC-085 R4 a consumption that cannot be made durable (the marker appears after the preconditions passed) rolls back at stage consume; the seed is never reached', async () => {
  const home = v232Home();
  const b = await makeBackup({ home });
  const plan = await planFor({ home }, [...DRY, ...RESUME_ARGS(b.runDir)]);
  const authId = await issueAuthorization(b.runDir, { home, plan });
  const r = await run([...EXECUTE(plan), ...RESUME_ARGS(b.runDir, authId)], {
    home, runtime: { states: SEQ.RESUME, resume: { afterPreconditions: () => writeFileSync(path.join(witnessModule.authorizationStorePath(home), `${authId}.consumed.json`), '{}\n', { mode: 0o600 }) } },
  });
  assert.equal(r.code, 1, r.text);
  assert.match(r.text, /rolled back at stage consume; nothing was committed; the authorization was not consumed/);
  assert.equal(r.counts.commit, undefined);
  assert.equal(currentId(home).length, 1);
});

test('AC-084 R4 an authorization record rewritten between its load and the in-transaction recheck stops at preconditions', async () => {
  const home = v232Home();
  const b = await makeBackup({ home });
  const plan = await planFor({ home }, [...DRY, ...RESUME_ARGS(b.runDir)]);
  const authId = await issueAuthorization(b.runDir, { home, plan });
  const file = path.join(witnessModule.authorizationStorePath(home), `${authId}.json`);
  const r = await run([...EXECUTE(plan), ...RESUME_ARGS(b.runDir, authId)], {
    home, runtime: { states: SEQ.RESUME, resume: { beforePreconditions: () => {
      const rec = JSON.parse(readFileSync(file, 'utf8'));
      rec.expiresAt = new Date(Date.parse(rec.expiresAt) - 1000).toISOString();
      rec.recordSha256 = createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(rec).filter(([k]) => k !== 'recordSha256')))).digest('hex');
      writeFileSync(file, `${JSON.stringify(rec)}\n`, { mode: 0o600 });
    } } },
  });
  assert.equal(r.code, 1, r.text);
  assert.match(r.text, /rolled back at stage preconditions/);
  assert.equal(r.counts.commit, undefined);
});

test('AC-012/020 R4 a witness request naming another installation or another pre-state is refused by the tool: rolled back at stage witness, no witness file', async () => {
  for (const override of [{ markerId: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d' }, { fPre: sha('another pre-state') }]) {
    const home = v232Home();
    const b = await makeBackup({ home });
    const plan = await planFor({ home }, [...DRY, ...RESUME_ARGS(b.runDir)]);
    const authId = await issueAuthorization(b.runDir, { home, plan });
    const r = await run([...EXECUTE(plan), ...RESUME_ARGS(b.runDir, authId)], { home, runtime: { states: SEQ.RESUME, resume: { persistOverride: override } } });
    assert.equal(r.code, 1, JSON.stringify(override));
    assert.match(r.text, /rolled back at stage witness/);
    assert.equal(r.counts.commit, undefined);
    assert.deepEqual(readdirSync(path.join(prepareModule.witnessRootPath(home), path.basename(b.runDir))), []);
  }
});

// --- confidentiality canaries (AC-199..203) --------------------------------------------------------------------------------------
// The canaries are injected where a secret could really enter the tool layer: errors thrown by the runtime (message, cause, stack,
// own properties), child stderr/stdout, and the runtime's returned values. The tool must print only fixed text and persist only the
// digests/ids it was designed to persist; every generated artifact under the run dir and the home is scanned in all encodings.
const CANARIES = ['CANARY_PASSWORD_HASH_DO_NOT_LEAK', 'canary@example.invalid', 'CANARY_AUDIT_SECRET'];
const canaryForms = (c) => {
  const b = Buffer.from(c);
  return [c, b.toString('hex'), b.toString('base64'), b.toString('base64url'), Buffer.from(b.toString('base64')).toString('base64'), JSON.stringify(c).slice(1, -1).replace(/[^\x20-\x7e]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`), encodeURIComponent(c), c.split('').map((ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')];
};
const ALL_FORMS = CANARIES.flatMap(canaryForms);
function walkFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFiles(p));
    else out.push(p);
  }
  return out;
}
const scanFor = (text) => ALL_FORMS.filter((f) => text.includes(f));
function scanTree(...dirs) {
  const hits = [];
  for (const d of dirs) for (const f of walkFiles(d)) { const found = scanFor(`${f}\n${readFileSync(f).toString('latin1')}${readFileSync(f, 'utf8')}`); if (found.length) hits.push(`${f}: ${found.join(',')}`); }
  return hits;
}
const canaryError = () => Object.assign(new Error(`row ${CANARIES[0]} for ${CANARIES[1]}`, { cause: new Error(CANARIES[2]) }), { detail: `Key (email)=(${CANARIES[1]})`, code: '23505', query: `INSERT ${CANARIES[0]}`, params: [CANARIES[2]], kind: 'ROLLED_BACK', stage: CANARIES[0], reason: CANARIES[2] });

test('AC-200 positive control: the scanner finds each canary in raw/hex/base64/base64url/double-base64/JSON-escaped/URL-encoded/\\u-escaped forms', () => {
  for (const c of CANARIES) for (const form of canaryForms(c)) assert.deepEqual(scanFor(`x ${form} y`).length > 0, true, form);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mona-canary-ctl-'));
  writeFileSync(path.join(dir, 'planted.json'), JSON.stringify({ v: Buffer.from(CANARIES[0]).toString('base64') }));
  assert.equal(scanTree(dir).length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test('AC-199 a runtime error carrying canaries in message/cause/detail/query/params/kind/stage/reason never reaches output or any artifact, at every runtime step', async () => {
  for (const step of ['resumeSeed2', 'proveIdentity', 'classify', 'checkOutcome']) {
    const hookName = step === 'proveIdentity' ? 'prove' : step;
    const home = v232Home();
    const b = await makeBackup({ home });
    const plan = await planFor({ home }, [...DRY, ...RESUME_ARGS(b.runDir)]);
    const authId = await issueAuthorization(b.runDir, { home, plan });
    const argv = step === 'checkOutcome' ? OUTCOME_ARGS(b) : [...EXECUTE(plan), ...RESUME_ARGS(b.runDir, authId)];
    const r = await run(argv, { home, runtime: { states: SEQ.RESUME, hooks: { [hookName]: () => { throw canaryError(); } } } });
    assert.notEqual(r.code, 0, step);
    assert.deepEqual(scanFor(r.text), [], `${step}: output`);
    assert.deepEqual(scanTree(home, b.runDir), [], `${step}: artifacts`);
  }
});

test('AC-201 child stderr/stdout carrying canaries is never echoed and never persisted (backup list, pg_restore --list)', async () => {
  const home = v232Home();
  const b = await makeBackup({ home });
  const plan = await planFor({ home }, [...DRY, ...RESUME_ARGS(b.runDir)]);
  const authId = await issueAuthorization(b.runDir, { home, plan });
  const r = await run([...EXECUTE(plan), ...RESUME_ARGS(b.runDir, authId)], { home, runtime: { states: SEQ.RESUME }, spawn: { code: 1, stderr: [CANARIES.join(' ')], stdout: [CANARIES.join(' ')] } });
  assert.deepEqual(scanFor(r.text), []);
  assert.deepEqual(scanTree(home, b.runDir), []);
});

test('AC-202 a COMMITTED resume with canary-bearing runtime values (env, markers) persists only fixed-shape files: no canary in the witness store, authorization store, checkpoint store or run dir', async () => {
  const c = await r4Committed();
  assert.deepEqual(scanTree(c.home, c.b.runDir), []);
  const files = walkFiles(c.home).concat(walkFiles(c.b.runDir)).map((f) => path.basename(f));
  assert.equal(files.some((f) => /stream|canonical|\.sd1|\.bin$/.test(f)), false, 'no canonical-stream file exists');
});

test('AC-159 a manifest whose TOC multiset digest differs from the one recomputed from the archive listing is refused (dry-run and execute), before the runtime', async () => {
  const b = await makeBackup();
  editManifest(b.runDir, (m) => { m.tocMultisetSha256 = sha('another toc multiset'); });
  await assertEvidenceRefused(b.runDir, 'toc multiset');
});

test('AC-178/175 --reconcile-completion without the exact --confirm-local-target is refused before the runtime loads; it never reaches resume, seed or backfill', async () => {
  const c = await r4Committed();
  const args = RECONCILE_ARGS(c.b).filter((a) => !a.startsWith('--confirm-local-target'));
  const r = await run(args, { home: c.home, runtime: { outcome: { digests: { pre: sha('changed'), post: c.fPost } } } });
  assert.notEqual(r.code, 0, r.text);
  assert.equal(r.loaded.length, 0);
  assert.equal(r.counts.checkOutcome, undefined);
  const wrong = await run([...args, '--confirm-local-target=some-other-target'], { home: c.home });
  assert.notEqual(wrong.code, 0, wrong.text);
  assert.equal(wrong.loaded.length, 0);
  // a permitted reconcile still drives only the read-only outcome check
  const ok = await run(RECONCILE_ARGS(c.b), { home: c.home, runtime: { outcome: { digests: { pre: sha('changed'), post: c.fPost } } } });
  for (const forbidden of ['resumeSeed2', 'seed', 'backfill', 'verify']) assert.equal(ok.counts[forbidden], undefined, forbidden);
});

test('AC-203 dry-run, check and usage outputs contain no canary, URL or password even when the environment carries canaries', async () => {
  const env = { ...ENV, CANARY_ENV_A: CANARIES[0], CANARY_ENV_B: CANARIES[1], CANARY_ENV_C: CANARIES[2] };
  for (const argv of [DRY, [], ['--bogus']]) {
    const r = await run(argv, { env });
    assert.deepEqual(scanFor(r.text), [], argv.join(' '));
    assertNoLeak(r.text);
  }
});

test('AC-173 a second resume with the SAME authorization after a committed seed is refused and never reaches the protected transaction (no seed replay)', async () => {
  const c = await r4Committed();
  const again = await run([...EXECUTE(c.plan), ...RESUME_ARGS(c.b.runDir, c.authId)], { home: c.home, runtime: { states: SEQ.RESUME } });
  assert.notEqual(again.code, 0, again.text);
  assert.equal(again.counts.resumeSeed2, undefined);
});

// ---- V2.3.3 R4 HIGH-2 (real PostgreSQL 17.11 shape): the declared "TOC Entries" counts EVERY archive entry; the plain
// `pg_restore --list` omits the header-only entries (ENCODING, STDSTRINGS, SEARCHPATH, DATABASE). Preregistered C01..C30. ----
const realShapeExtra = () => [
  ...Array.from({ length: 57 }, (_, i) => `${7000 + i}; 1259 ${60000 + i} INDEX public idx_${i} mona_local_test`),
  ...Array.from({ length: 39 }, (_, i) => `${8000 + i}; 2606 ${61000 + i} FK CONSTRAINT public fk_${i} mona_local_test`),
];
const listedCount = (toc) => toc.split('\n').filter((line) => /^\d+; /.test(line)).length;
const withDeclared = (toc, n) => toc.replace(/;     TOC Entries: \d+/, `;     TOC Entries: ${n}`);
const realToc = (hidden = 4) => { const t = r4Toc({ extra: realShapeExtra() }); return withDeclared(t, listedCount(t) + hidden); };

test('R4-C01 the real PostgreSQL 17.11 shape (declared = listed + 4 header-only entries) is accepted', () => {
  const toc = realToc(4);
  const verdict = r4Check(toc);
  assert.equal(verdict.ok, true, verdict.reason);
  assert.equal(verdict.tables, 25);
  assert.equal(verdict.entries, listedCount(toc));
});
test('R4-C02/C03/C18 declared == listed, or listed + 1..4 (other PostgreSQL versions emit fewer header-only entries), is accepted', () => {
  for (const hidden of [0, 1, 2, 3, 4]) assert.equal(r4Check(realToc(hidden)).ok, true, `hidden=${hidden}`);
});
test('R4-C04/C05/C06 declared above listed + 4, below listed, or tiny is refused', () => {
  const listed = listedCount(r4Toc({ extra: realShapeExtra() }));
  for (const n of [listed + 5, listed + 100, listed - 1, 1, 0]) assert.equal(r4Check(withDeclared(realToc(0), n)).ok, false, `declared=${n}`);
});
test('R4-C15/C16 a truncated listing (real declared count, entries removed) is refused', () => {
  const toc = realToc(4);
  const lines = toc.split('\n');
  const lastEntry = lines.map((l, i) => (/^\d+; /.test(l) ? i : -1)).filter((i) => i >= 0);
  const drop = (n) => lines.filter((_, i) => !lastEntry.slice(-n).includes(i)).join('\n');
  assert.equal(r4Check(drop(1)).ok, false); // 193 declared, 188 listed: beyond the 4 header-only entries
  assert.equal(r4Check(drop(10)).ok, false);
});
test('R4-C07..C11/C21 the real shape still refuses duplicate TABLE / TABLE DATA, a missing or extra relation, a non-public entry and the guard schema', () => {
  const real = (o) => { const t = r4Toc({ extra: realShapeExtra(), ...o }); return withDeclared(t, listedCount(t) + 4); };
  assert.equal(r4Check(real({ extra: [...realShapeExtra(), '1500; 1259 1 TABLE public Branch mona_local_test'] })).ok, false);
  assert.equal(r4Check(real({ extra: [...realShapeExtra(), '3500; 0 1 TABLE DATA public Branch mona_local_test'] })).ok, false);
  assert.equal(r4Check(real({ tables: R4_RELATIONS.slice(1), data: R4_RELATIONS.slice(1) })).ok, false);
  assert.equal(r4Check(real({ tables: [...R4_RELATIONS, 'Intruder'], data: [...R4_RELATIONS, 'Intruder'] })).ok, false);
  assert.equal(r4Check(real({ data: R4_RELATIONS.slice(1) })).ok, false);
  assert.equal(r4Check(real({ extra: [...realShapeExtra(), '6008; 1259 1 TABLE other Z mona_local_test'] })).ok, false);
  assert.equal(r4Check(real({ extra: [...realShapeExtra(), '7100; 2615 1 SCHEMA - mona_local_test_guard mona_local_test'] })).ok, false);
});
test('R4-C12..C14 a missing or repeated declared count and a malformed header stay refused on the real shape', () => {
  const toc = realToc(4);
  assert.equal(r4Check(toc.replace(/;     TOC Entries: \d+\n/, '')).ok, false);
  assert.equal(r4Check(toc.replace(/(;     TOC Entries: \d+\n)/, '$1$1')).ok, false);
  assert.equal(r4Check(toc.replace(';     dbname: mona_local_test\n', '')).ok, false);
  assert.equal(r4Check(toc.replace(';     dbname: mona_local_test', ';     dbname: other')).ok, false);
});
test('R4-C17 bare ";" comment lines are a known header form; an unknown comment line is refused', () => {
  assert.equal(r4Check(realToc(4).replace('; Selected TOC Entries:', ';\n; Selected TOC Entries:')).ok, true);
  assert.equal(r4Check(realToc(4).replace('; Selected TOC Entries:', '; Surprise comment\n; Selected TOC Entries:')).ok, false);
});
test('R4-C19/C20/C22 object kinds outside the grammar are refused, including header-only kinds printed as list lines and verbose "depends on" lines', () => {
  for (const line of ['6000; 1259 50000 VIEW public v mona_local_test', '6001; 1259 50001 SEQUENCE public s mona_local_test', '4411; 0 0 ENCODING - ENCODING ', '4412; 0 0 STDSTRINGS - STDSTRINGS ',
    '4413; 0 0 SEARCHPATH - SEARCHPATH ', '4414; 1262 5 DATABASE - mona_local_test mona_local_test', ';\tdepends on: 4']) {
    assert.equal(r4Check(withDeclared(r4Toc({ extra: [line] }), 500)).ok, false, line);
  }
});
test('R4-C23 a table named DATA is not mistaken for TABLE DATA, and TABLE DATA parses as TABLE DATA', () => {
  assert.equal(r4Check(r4Toc({ extra: ['6100; 1259 1 TABLE public DATA mona_local_test'] })).ok, false);
  assert.equal(r4Check(realToc(4)).ok, true);
});
test('R4-C24/C25 a non-canonical or unsafe declared count is refused', () => {
  const toc = realToc(0);
  const listed = listedCount(toc);
  for (const text of [`0${listed}`, `+${listed}`, `-1`, `${listed}.0`, '1e3', `${listed} `, '1000000000000000000000000000000', String(Number.MAX_SAFE_INTEGER + 2)]) {
    assert.equal(r4Check(toc.replace(/;     TOC Entries: \d+/, `;     TOC Entries: ${text}`)).ok, false, text);
  }
});
test('R4-C26 the multiset digest and counts do not depend on the declared count within the accepted range', () => {
  const a = r4Check(realToc(0));
  const b = r4Check(realToc(4));
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(a.multisetSha256, b.multisetSha256);
  assert.equal(a.entries, b.entries);
  assert.equal(a.tables, b.tables);
});
test('R4-C30 an empty or whitespace-only listing is refused', () => {
  for (const text of ['', '   \n', '\n\n']) assert.equal(r4Check(text).ok, false);
});
