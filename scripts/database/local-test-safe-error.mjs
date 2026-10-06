// R4 safe-error contract and start guard for the LOCAL_TEST safety tools.
//
// Protected rows (password hashes, e-mails, names, AuditLog JSON, ...) can reach error objects through
// Prisma/pg/adapter messages, `meta`, `detail`, `params`, `cause`, `stack` and even class names. Nothing here
// ever reads or renders any of those: an error is mapped to ONE code from a closed vocabulary, using only
// brand/shape checks (private-field brand, SQLSTATE shape, `syscall` presence). The class name is dropped
// entirely (breaker LOW-13). Reading a property can itself throw (hostile getters), so every read is guarded.

export const SAFE_CODES = Object.freeze([
  'E_REFUSED',
  'E_ARGS',
  'E_AUTH',
  'E_ARCHIVE',
  'E_ARCHIVE_LIST',
  'E_FINGERPRINT',
  'E_CONTRACT',
  'E_WITNESS_DURABILITY',
  'E_DB_STATE_MISMATCH',
  'E_TRANSACTION',
  'E_TIMEOUT',
  'E_DB',
  'E_FS',
  'E_DIAGNOSTIC_FLAGS',
  'E_INTERNAL',
]);

// Unforgeable brand: only code constructed through this class carries a vocabulary code.
export class SafeToolError extends Error {
  #code;
  constructor(code) {
    super('tool refused');
    this.#code = SAFE_CODES.includes(code) ? code : 'E_INTERNAL';
  }
  static codeOf(value) {
    return value instanceof SafeToolError && #code in value ? value.#code : null;
  }
}

const read = (object, key) => {
  try {
    return object[key];
  } catch {
    return undefined;
  }
};
// 57014 query_canceled (statement_timeout), 55P03 lock_not_available (lock_timeout), 25P03 idle_in_transaction timeout
const TIMEOUT_SQLSTATE = new Set(['57014', '55P03', '25P03']);
const SQLSTATE = /^[0-9A-Z]{5}$/;

export function safeCode(err) {
  const branded = SafeToolError.codeOf(err);
  if (branded) return branded;
  if (err === null || (typeof err !== 'object' && typeof err !== 'function')) return 'E_INTERNAL';
  const code = read(err, 'code');
  if (typeof code === 'string' && TIMEOUT_SQLSTATE.has(code)) return 'E_TIMEOUT';
  if (typeof read(err, 'syscall') === 'string') return 'E_FS';
  if (typeof code === 'string' && SQLSTATE.test(code)) return 'E_DB';
  return 'E_INTERNAL';
}

export const renderSafeError = (err) => safeCode(err);

// Diagnostic flags that could write process memory (heap snapshots, reports, core dumps, profiles) or attach a debugger.
const DIAGNOSTIC_FLAG = /^--(?:inspect|heapsnapshot-|report-|cpu-prof|heap-prof|prof(?:-process)?$|diagnostic-dir|abort-on-uncaught-exception)/;
const REPORT_KEYS = ['reportOnFatalError', 'reportOnSignal', 'reportOnUncaughtException'];

export function assertNoDiagnosticFlags({ env = process.env, execArgv = process.execArgv, report = process.report } = {}) {
  const tokens = [...String(env?.NODE_OPTIONS ?? '').split(/\s+/), ...(Array.isArray(execArgv) ? execArgv : [])].filter((t) => typeof t === 'string' && t !== '');
  if (tokens.some((t) => DIAGNOSTIC_FLAG.test(t))) return { ok: false, code: 'E_DIAGNOSTIC_FLAGS' };
  if (report && REPORT_KEYS.some((key) => read(report, key) === true)) return { ok: false, code: 'E_DIAGNOSTIC_FLAGS' };
  return { ok: true };
}

// Top-level handler shared by the executables: guard first, then main; any throw prints one fixed line.
export async function runTool(main, { error = (line) => console.error(line), prefix = '[db:local-test]', guard = assertNoDiagnosticFlags } = {}) {
  const fail = (code) => {
    error(`${prefix} FAIL: ${code}`);
    return 1;
  };
  try {
    const guarded = guard();
    if (!guarded.ok) return fail(guarded.code);
    return await main();
  } catch (err) {
    return fail(safeCode(err));
  }
}
