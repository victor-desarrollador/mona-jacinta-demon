// The only switch that lets the real-DB proofs run. Pure: it never opens a connection and never reads process.env itself.
export const OPT_IN_VAR = 'MONA_R4_REAL_DB_PROOF';
export const OPT_IN_VALUE = 'local-test-disposable-only';
export const SELECTOR_VAR = 'MONA_TEST_DATABASE_TARGET';
export const LOCAL_URL_VAR = 'LOCAL_TEST_DATABASE_URL';
export const LOCAL_MARKER_VAR = 'LOCAL_TEST_DATABASE_MARKER_ID';
export const EVIDENCE_DIR_VAR = 'MONA_R4_EVIDENCE_DIR';
// Targets the proofs must never be able to reach: their presence in the environment refuses the run.
export const FORBIDDEN_TARGET_VARS = Object.freeze(['DATABASE_URL', 'TEST_DATABASE_URL']);

export type GateDecision = Readonly<{ enabled: true } | { enabled: false; reason: string }>;

export function evaluateGate(env: Readonly<Record<string, string | undefined>>): GateDecision {
  if (env[OPT_IN_VAR] !== OPT_IN_VALUE) return { enabled: false, reason: 'explicit opt-in token missing' };
  if (env[SELECTOR_VAR] !== 'local') return { enabled: false, reason: 'target selector must be exactly "local"' };
  for (const name of FORBIDDEN_TARGET_VARS) {
    if (env[name] !== undefined && env[name] !== '') return { enabled: false, reason: `${name} must not be present` };
  }
  if (!env[LOCAL_URL_VAR] || !env[LOCAL_MARKER_VAR]) return { enabled: false, reason: 'LOCAL_TEST configuration incomplete' };
  return { enabled: true };
}
