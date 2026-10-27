// D5F-A: deterministic synthetic TEST-only runtime environment values.
//
// The D5B3 full suite showed 18 files failing with
// `Invalid API environment variables: JWT_SECRET, JWT_ACCESS_TTL_SECONDS,
// CORS_ORIGINS` because the per-worker setup.ts loads .env.development but
// does not OWN these three values — they depend on the ambient shell and
// the .env file content, which is not deterministic across machines,
// sessions, or worker states.
//
// This module provides the single authoritative source for synthetic,
// deterministic, clearly-non-production values that the TEST harness
// (api/tests/setup.ts) applies AFTER loading .env.development, so the
// values are always valid regardless of ambient or file state.
//
// These values are never real credentials. They are intentionally synthetic,
// deterministic, and marked as test-only. They pass the current Zod schema
// in src/config/env.ts without weakening any validation.

// ≥32 chars, no "replace" pattern, no angle brackets — passes the schema's
// min(32) + refine rules. Clearly marked as synthetic/test-only.
export const SYNTHETIC_JWT_SECRET =
  'synthetic-test-jwt-secret-not-for-real-auth-d5fa-deterministic';

// Positive integer — passes z.coerce.number().int().positive().
export const SYNTHETIC_JWT_ACCESS_TTL_SECONDS = '900';

// Comma-separated valid http origins — passes the CORS_ORIGINS URL validation.
export const SYNTHETIC_CORS_ORIGINS =
  'http://localhost:5173,http://localhost:3000';

// The keys this module owns. No other environment variable is touched.
const SYNTHETIC_TEST_ENV_KEYS = [
  'JWT_SECRET',
  'JWT_ACCESS_TTL_SECONDS',
  'CORS_ORIGINS',
] as const;

// Applies the deterministic synthetic TEST values to the given environment
// object (defaults to process.env). Idempotent: applying it multiple times
// produces the same result. Does NOT touch DATABASE_URL, TEST_DATABASE_URL,
// NODE_ENV, CLIENT_IP_SOURCE, RESERVATION_SWEEPER_* or WHOLESALE_AUTH_CODE_HASH.
// The values ALWAYS overwrite whatever was there before (deterministic ownership
// regardless of ambient, .env.development, or inherited state).
export function applySyntheticTestEnv(
  target: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  target.JWT_SECRET = SYNTHETIC_JWT_SECRET;
  target.JWT_ACCESS_TTL_SECONDS = SYNTHETIC_JWT_ACCESS_TTL_SECONDS;
  target.CORS_ORIGINS = SYNTHETIC_CORS_ORIGINS;
  return target;
}

// Returns the list of keys this module owns (for guard tests).
export const syntheticTestEnvKeys: readonly string[] = SYNTHETIC_TEST_ENV_KEYS;
