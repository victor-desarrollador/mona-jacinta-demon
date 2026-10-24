// Zero-database unit tests for scripts/database/ci-local-test-fixture.mjs.
// Run with: node --test scripts/database/ci-local-test-fixture.test.mjs
// Every runtime, gate and child process below is an injected fake: no test opens a
// socket, spawns a process or reads the real environment. Hostile TEST/DEV/PILOT
// targets are synthetic (*.invalid) and must never influence the run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { main, parseCiArgs } from './ci-local-test-fixture.mjs';

const MARKER = '6d2f9a41-8c3b-4e5d-9f7a-1b2c3d4e5f60';
const OTHER_MARKER = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const SECRET = 'L0calS3cret-pw';
const URL_TEXT = `postgresql://mona_local_test:${SECRET}@127.0.0.1:5432/mona_local_test`;
const RUNNER_TEMP = '/home/runner/work/_temp';
const HOSTILE_TEST = 'postgresql://postgres.testhostileaaaaaaaaa:TestHostilePw@test-hostile.invalid:5432/postgres';
const HOSTILE_DEV = 'postgresql://postgres.devhostileaaaaaaaaaa:DevHostilePw@dev-hostile.invalid:5432/postgres';
const HOSTILE_PILOT = 'postgresql://mona_pilot:PilotHostilePw@pilot-hostile.invalid:5432/mona_pilot';
const LEAKS = [SECRET, URL_TEXT, 'TestHostilePw', 'DevHostilePw', 'PilotHostilePw', 'hostile.invalid'];

const GOOD_ENV = Object.freeze({
  CI: 'true',
  GITHUB_ACTIONS: 'true',
  RUNNER_TEMP,
  PATH: '/usr/bin:/bin',
  HOME: '/home/runner',
  LOCAL_TEST_DATABASE_URL: URL_TEXT,
  LOCAL_TEST_DATABASE_MARKER_ID: MARKER,
});
const ARGS = [`--marker-id=${MARKER}`];

// A scripted runtime + gates. `calls` records the observable order of effects.
function harness({ env = GOOD_ENV, states = ['FRESH', 'MIGRATED_EMPTY', 'POST_SEED1', 'POST_BACKFILL'], proveFails = false, gateFails = false, migrateFails = false } = {}) {
  const calls = [];
  const out = [];
  const err = [];
  let stateIndex = 0;
  const runtime = {
    async proveIdentity() {
      calls.push('prove');
      if (proveFails) throw new Error(`marker missing ${URL_TEXT}`);
    },
    async classify() {
      calls.push('classify');
      return states[Math.min(stateIndex++, states.length - 1)];
    },
    async seedDemo() {
      calls.push('seed');
    },
    async backfillCompanyLocations() {
      calls.push('backfill');
    },
    async close() {
      calls.push('close');
    },
  };
  const deps = {
    env,
    apiDir: '/repo/api',
    execPath: '/usr/bin/node',
    home: '/home/runner',
    tmpdir: '/tmp',
    uid: 1001,
    log: (line) => out.push(line),
    error: (line) => err.push(line),
    staticGates: async () => {
      calls.push('gates');
      if (gateFails) return { ok: false, phase: 'payload', detail: 'payload drift' };
      return { ok: true, target: { url: URL_TEXT, markerId: MARKER }, payload: { migrations: [{ name: 'm1', sha256: 'a'.repeat(64) }] }, spec: {} };
    },
    loadRuntime: async () => {
      calls.push('load');
      return runtime;
    },
    runMigration: async () => {
      calls.push('migrate');
      return migrateFails ? { ok: false, detail: 'prisma exited with code 1' } : { ok: true };
    },
  };
  return { deps, calls, out, err };
}

const MUTATIONS = ['migrate', 'seed', 'backfill'];
const assertNoMutation = (calls) => {
  for (const mutation of MUTATIONS) assert.ok(!calls.includes(mutation), `${mutation} must not run`);
};
const assertNoLeak = (...texts) => {
  for (const text of texts.flat().join('\n').split('\n')) for (const leak of LEAKS) assert.ok(!text.includes(leak), 'output leaked a secret or hostile target');
};
async function expectReject(overrides, label) {
  const h = harness(overrides);
  const code = await main(ARGS, h.deps);
  assert.equal(code, 1, `${label}: must exit 1`);
  assertNoMutation(h.calls);
  assertNoLeak(h.out, h.err);
  return h;
}

// ---- CI-only gate --------------------------------------------------------------------------------------------------

test('rejects when CI is not exactly "true"', async () => {
  for (const CI of [undefined, '', 'false', '1', 'TRUE']) {
    const env = { ...GOOD_ENV, CI };
    if (CI === undefined) delete env.CI;
    const h = await expectReject({ env }, `CI=${CI}`);
    assert.ok(!h.calls.includes('load'), 'no runtime may be loaded');
  }
});

test('rejects when GITHUB_ACTIONS is not exactly "true"', async () => {
  for (const GITHUB_ACTIONS of [undefined, '', 'false', '1']) {
    const env = { ...GOOD_ENV, GITHUB_ACTIONS };
    if (GITHUB_ACTIONS === undefined) delete env.GITHUB_ACTIONS;
    await expectReject({ env }, `GITHUB_ACTIONS=${GITHUB_ACTIONS}`);
  }
});

test('rejects a missing or invalid RUNNER_TEMP', async () => {
  const missing = { ...GOOD_ENV };
  delete missing.RUNNER_TEMP;
  await expectReject({ env: missing }, 'missing');
  for (const RUNNER_TEMP_VALUE of ['', 'relative/tmp', '/', '/home/runner/../../etc', '/tmp/x\0y']) {
    await expectReject({ env: { ...GOOD_ENV, RUNNER_TEMP: RUNNER_TEMP_VALUE } }, `RUNNER_TEMP=${JSON.stringify(RUNNER_TEMP_VALUE)}`);
  }
});

// ---- target identity -----------------------------------------------------------------------------------------------

test('rejects remote hosts, localhost and non-canonical loopback forms', async () => {
  for (const host of ['db.example.com', 'localhost', '10.0.0.5', '0.0.0.0', '[::1]', '127.0.0.2']) {
    const url = `postgresql://mona_local_test:${SECRET}@${host}:5432/mona_local_test`;
    await expectReject({ env: { ...GOOD_ENV, LOCAL_TEST_DATABASE_URL: url } }, `host ${host}`);
  }
  await expectReject({ env: { ...GOOD_ENV, LOCAL_TEST_DATABASE_URL: `postgresql://mona_local_test:${SECRET}@127.0.0.1:5433/mona_local_test` } }, 'port');
});

test('rejects a wrong user', async () => {
  const url = `postgresql://postgres:${SECRET}@127.0.0.1:5432/mona_local_test`;
  await expectReject({ env: { ...GOOD_ENV, LOCAL_TEST_DATABASE_URL: url } }, 'user');
});

test('rejects a wrong database', async () => {
  const url = `postgresql://mona_local_test:${SECRET}@127.0.0.1:5432/postgres`;
  await expectReject({ env: { ...GOOD_ENV, LOCAL_TEST_DATABASE_URL: url } }, 'database');
});

test('rejects a TEST identity (hosted URL as target, or any TEST variable present)', async () => {
  await expectReject({ env: { ...GOOD_ENV, LOCAL_TEST_DATABASE_URL: HOSTILE_TEST } }, 'TEST url as target');
  await expectReject({ env: { ...GOOD_ENV, TEST_DATABASE_URL: HOSTILE_TEST } }, 'TEST_DATABASE_URL present');
  await expectReject({ env: { ...GOOD_ENV, TEST_DATABASE_MARKER_ID: MARKER } }, 'TEST marker id present');
  await expectReject({ env: { ...GOOD_ENV, MONA_TEST_DATABASE_TARGET: 'test' } }, 'selector present');
});

test('rejects a DEV identity (hosted URL as target, or any DEV variable present)', async () => {
  await expectReject({ env: { ...GOOD_ENV, LOCAL_TEST_DATABASE_URL: HOSTILE_DEV } }, 'DEV url as target');
  await expectReject({ env: { ...GOOD_ENV, DATABASE_URL: HOSTILE_DEV } }, 'DATABASE_URL present');
  await expectReject({ env: { ...GOOD_ENV, DIRECT_URL: HOSTILE_DEV } }, 'DIRECT_URL present');
});

test('rejects a PILOT identity (hosted URL as target, or any PILOT variable present)', async () => {
  await expectReject({ env: { ...GOOD_ENV, LOCAL_TEST_DATABASE_URL: HOSTILE_PILOT } }, 'PILOT url as target');
  await expectReject({ env: { ...GOOD_ENV, PILOT_DATABASE_URL: HOSTILE_PILOT } }, 'PILOT_DATABASE_URL present');
  await expectReject({ env: { ...GOOD_ENV, PILOT_DATABASE_MARKER_ID: MARKER } }, 'PILOT marker id present');
});

test('rejects a marker id that differs from the pinned one', async () => {
  const h = harness();
  const code = await main([`--marker-id=${OTHER_MARKER}`], h.deps);
  assert.equal(code, 1);
  assertNoMutation(h.calls);
});

// ---- no bypass surface ---------------------------------------------------------------------------------------------

test('accepts exactly one --marker-id argument and nothing else (no bypass flags)', () => {
  assert.deepEqual(parseCiArgs(ARGS), { ok: true, markerId: MARKER });
  for (const flag of ['--force', '--skip-safety', '--no-verify', '--ci-bypass', '--yes', '--execute', '--plan=' + 'a'.repeat(64)]) {
    assert.equal(parseCiArgs([...ARGS, flag]).ok, false, flag);
  }
  assert.equal(parseCiArgs([]).ok, false);
  assert.equal(parseCiArgs([ARGS[0], ARGS[0]]).ok, false);
  assert.equal(parseCiArgs(['--marker-id=not-a-uuid']).ok, false);
  assert.equal(parseCiArgs(['positional']).ok, false);
});

test('bypass-style environment variables do not open the gate', async () => {
  const noCi = { ...GOOD_ENV, CI_BYPASS: '1', FORCE: '1', SKIP_SAFETY: '1' };
  delete noCi.CI;
  await expectReject({ env: noCi }, 'bypass variables without CI');
});

test('the tool source carries no bypass flag or variable', () => {
  const source = readFileSync(new URL('./ci-local-test-fixture.mjs', import.meta.url), 'utf8');
  for (const forbidden of [/--force/, /--skip-safety/, /--no-verify/, /CI_BYPASS/i, /skip[-_]?safety/i]) {
    // The only allowed mention is a rejection list, never an accepted option.
    const accepted = source.split('\n').filter((line) => forbidden.test(line) && !/^\s*\/\//.test(line));
    assert.deepEqual(accepted, [], String(forbidden));
  }
});

// ---- marker / state ------------------------------------------------------------------------------------------------

test('rejects when the LOCAL_TEST marker is absent or not provable', async () => {
  const h = await expectReject({ proveFails: true }, 'marker absent');
  assert.ok(h.calls.includes('prove'));
  assert.ok(!h.calls.includes('classify'), 'nothing is classified before identity is proven');
  assert.ok(h.calls.includes('close'), 'the runtime is released');
});

test('rejects a database that is not FRESH', async () => {
  for (const state of ['MIGRATED_EMPTY', 'POST_SEED1', 'POST_BACKFILL', 'EXACT_BASELINE', 'OPERATIONAL_DATA', 'MIGRATION_DRIFT', 'PARTIAL_UNSAFE', 'UNKNOWN', undefined, 'fresh']) {
    const h = await expectReject({ states: [state] }, `state ${state}`);
    assert.ok(h.calls.includes('close'));
  }
});

test('rejects when the static gates (payload/config pins) fail', async () => {
  const h = await expectReject({ gateFails: true }, 'gates');
  assert.ok(!h.calls.includes('load'));
});

// ---- the allowed path ----------------------------------------------------------------------------------------------

test('allows the exact target + marker + FRESH database, in the reviewed order', async () => {
  const h = harness();
  const code = await main(ARGS, h.deps);
  assert.equal(code, 0, h.err.join('\n'));
  const effects = h.calls.filter((call) => ['gates', 'load', 'migrate', 'seed', 'backfill', 'close'].includes(call));
  assert.deepEqual(effects.slice(0, 3), ['gates', 'load', 'migrate']);
  assert.equal(effects.at(-1), 'close');
  // The first mutation is always preceded by an identity proof and a FRESH classification.
  const firstMutation = h.calls.findIndex((call) => MUTATIONS.includes(call));
  assert.deepEqual(h.calls.slice(0, firstMutation).filter((c) => c === 'prove' || c === 'classify').slice(0, 2), ['prove', 'classify']);
  assertNoLeak(h.out, h.err);
});

test('stops without further mutation when migration fails', async () => {
  const h = harness({ migrateFails: true });
  assert.equal(await main(ARGS, h.deps), 1);
  assert.ok(!h.calls.includes('seed') && !h.calls.includes('backfill'));
  assert.ok(h.calls.includes('close'));
});

test('stops when a step does not produce the expected next state', async () => {
  const h = harness({ states: ['FRESH', 'PARTIAL_UNSAFE'] });
  assert.equal(await main(ARGS, h.deps), 1);
  assert.ok(!h.calls.includes('seed') && !h.calls.includes('backfill'));
});
