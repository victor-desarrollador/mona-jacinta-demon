import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SAFE_CODES,
  SafeToolError,
  assertNoDiagnosticFlags,
  renderSafeError,
  runTool,
  safeCode,
} from './local-test-safe-error.mjs';

const CANARY = 'CANARY_PASSWORD_HASH_DO_NOT_LEAK';
const EMAIL = 'canary@example.invalid';
const leaks = (text) => [CANARY, EMAIL, 'CANARY_AUDIT_SECRET'].filter((c) => String(text).includes(c));

test('AC-183 a Prisma-like error carrying canaries in message/meta/cause/stack renders only a fixed code', () => {
  const err = Object.assign(new Error(`Invalid value ${CANARY}`), {
    name: 'PrismaClientValidationError',
    meta: { target: [EMAIL] },
    cause: new Error(CANARY),
    clientVersion: '7.10.0',
  });
  err.stack = `PrismaClientValidationError: ${CANARY}\n at ${EMAIL}`;
  const out = renderSafeError(err);
  assert.equal(out, 'E_INTERNAL');
  assert.deepEqual(leaks(out), []);
});

test('AC-184 a pg-like error with detail "Key (email)=(canary)" renders only a fixed DB code', () => {
  const err = Object.assign(new Error(`duplicate key ${EMAIL}`), { code: '23505', detail: `Key (email)=(${EMAIL}) already exists.`, name: 'error' });
  const out = renderSafeError(err);
  assert.equal(out, 'E_DB');
  assert.deepEqual(leaks(out), []);
});

test('AC-185 LOW-13 a hostile alphanumeric class name is never rendered', () => {
  class ValidationError_X2bX12XKAKAcanary extends Error {}
  const out = renderSafeError(new ValidationError_X2bX12XKAKAcanary('x'));
  assert.equal(out, 'E_INTERNAL');
  assert.ok(!out.includes('canary'));
});

test('AC-186 throwing getters, non-Error throws, cause chains and AggregateError render fixed codes only', () => {
  const hostile = {
    get message() { throw new Error(CANARY); },
    get name() { throw new Error(CANARY); },
    get code() { throw new Error(CANARY); },
    get syscall() { throw new Error(CANARY); },
  };
  const cases = [hostile, CANARY, { toString: () => CANARY }, null, undefined, 42, Symbol('x'),
    new AggregateError([new Error(CANARY)], CANARY), Object.assign(new Error('a'), { cause: { toString: () => CANARY } })];
  for (const c of cases) {
    const out = renderSafeError(c);
    assert.ok(SAFE_CODES.includes(out), `unexpected rendering for ${typeof c}`);
    assert.deepEqual(leaks(out), []);
  }
});

test('AC-187 the code vocabulary is a closed allow-list and unknown classification maps to E_INTERNAL', () => {
  for (const code of ['E_REFUSED', 'E_ARGS', 'E_AUTH', 'E_ARCHIVE', 'E_ARCHIVE_LIST', 'E_FINGERPRINT', 'E_CONTRACT', 'E_WITNESS_DURABILITY',
    'E_DB_STATE_MISMATCH', 'E_TRANSACTION', 'E_TIMEOUT', 'E_DB', 'E_FS', 'E_DIAGNOSTIC_FLAGS', 'E_INTERNAL']) {
    assert.ok(SAFE_CODES.includes(code), code);
  }
  assert.ok(Object.isFrozen(SAFE_CODES));
  assert.equal(safeCode(new SafeToolError('E_AUTH')), 'E_AUTH');
  assert.equal(safeCode(new SafeToolError('E_MADE_UP')), 'E_INTERNAL');
  assert.equal(safeCode(Object.assign(new Error('x'), { code: '57014' })), 'E_TIMEOUT');
  assert.equal(safeCode(Object.assign(new Error('x'), { code: '55P03' })), 'E_TIMEOUT');
  assert.equal(safeCode(Object.assign(new Error('x'), { syscall: 'open', code: 'ENOENT' })), 'E_FS');
  assert.equal(safeCode({ code: 'E_AUTH' }), 'E_INTERNAL'); // a look-alike is not a SafeToolError
});

test('AC-188 the top-level handler prints one fixed line, no stack, and returns non-zero', async () => {
  const lines = [];
  const clean = () => ({ ok: true }); // node --test itself passes default --inspect-port/--heapsnapshot flags, so the real guard is injected out
  const code = await runTool(async () => { throw Object.assign(new Error(CANARY), { stack: `S ${CANARY}` }); }, { error: (l) => lines.push(l), prefix: '[t]', guard: clean });
  assert.notEqual(code, 0);
  assert.equal(lines.length, 1);
  assert.equal(lines[0], '[t] FAIL: E_INTERNAL');
  const ok = await runTool(async () => 0, { error: (l) => lines.push(l), prefix: '[t]', guard: clean });
  assert.equal(ok, 0);
  assert.equal(lines.length, 1);
  // a refusing guard stops before main ever runs and prints only the fixed code
  let ran = false;
  const refused = await runTool(async () => { ran = true; return 0; }, { error: (l) => lines.push(l), prefix: '[t]', guard: () => ({ ok: false, code: 'E_DIAGNOSTIC_FLAGS' }) });
  assert.equal(refused, 1);
  assert.equal(ran, false);
  assert.equal(lines.at(-1), '[t] FAIL: E_DIAGNOSTIC_FLAGS');
});

test('AC-193 diagnostic flags in NODE_OPTIONS are refused', () => {
  for (const flag of ['--inspect', '--inspect=127.0.0.1:9229', '--inspect-brk', '--inspect-port=9230', '--inspect-wait', '--heapsnapshot-signal=SIGUSR2',
    '--heapsnapshot-near-heap-limit=3', '--report-on-signal', '--report-uncaught-exception', '--report-on-fatalerror', '--report-dir=/x', '--cpu-prof', '--heap-prof', '--diagnostic-dir=/x']) {
    const r = assertNoDiagnosticFlags({ env: { NODE_OPTIONS: `--max-old-space-size=64 ${flag}` }, execArgv: [] });
    assert.deepEqual(r, { ok: false, code: 'E_DIAGNOSTIC_FLAGS' }, flag);
  }
});

test('AC-194 the same flags in execArgv (equals and space forms) are refused', () => {
  assert.equal(assertNoDiagnosticFlags({ env: {}, execArgv: ['--inspect-brk'] }).ok, false);
  assert.equal(assertNoDiagnosticFlags({ env: {}, execArgv: ['--heapsnapshot-signal=SIGUSR2'] }).ok, false);
  assert.equal(assertNoDiagnosticFlags({ env: {}, execArgv: ['--report-on-signal', '--no-warnings'] }).ok, false);
  assert.equal(assertNoDiagnosticFlags({ env: {}, execArgv: ['--inspect-port', '9229'] }).ok, false);
});

test('AC-196 the refusal never echoes the flag value', () => {
  const r = assertNoDiagnosticFlags({ env: { NODE_OPTIONS: `--inspect=${CANARY}` }, execArgv: [] });
  assert.deepEqual(r, { ok: false, code: 'E_DIAGNOSTIC_FLAGS' });
  assert.deepEqual(leaks(JSON.stringify(r)), []);
});

test('AC-197 a runtime-enabled diagnostic report setting is refused', () => {
  for (const key of ['reportOnFatalError', 'reportOnSignal', 'reportOnUncaughtException']) {
    const r = assertNoDiagnosticFlags({ env: {}, execArgv: [], report: { [key]: true } });
    assert.equal(r.ok, false, key);
  }
});

test('AC-198 a clean environment passes the guard', () => {
  assert.deepEqual(assertNoDiagnosticFlags({ env: { PATH: '/usr/bin' }, execArgv: ['--no-warnings'], report: { reportOnFatalError: false } }), { ok: true });
});
