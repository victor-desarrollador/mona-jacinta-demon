import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { assertTestDatabaseIsolation } from './helpers/test-db.js';
import {
  AUTOMATED_TEST_TARGET_VAR,
  D5H_PINNED_TARGET_VAR,
  LOCAL_TEST_MARKER_VAR,
  LOCAL_TEST_URL_VAR,
  readD5hPinnedTarget,
} from '../scripts/demo-database.js';
// D5F-A: the TEST harness deterministically OWNS the application configuration
// that test imports require (JWT_SECRET, JWT_ACCESS_TTL_SECONDS, CORS_ORIGINS).
// D5B3 proved that relying on .env.development or the ambient shell for these
// values causes non-deterministic failures (18 files failed with
// "Invalid API environment variables: JWT_SECRET, JWT_ACCESS_TTL_SECONDS,
// CORS_ORIGINS"). The synthetic values are applied AFTER dotenv and BEFORE
// the DB isolation guard, so every worker has valid, deterministic, clearly
// non-production values regardless of ambient or .env state.
import { applySyntheticTestEnv } from './helpers/test-runtime-env.js';

process.env.NODE_ENV = 'test';
// D5H-I1b: gate mode was decided when scripts/demo-database.ts was first loaded (it is
// imported above, before this body runs). In a gate process the repository file is NEVER
// read: the hosted TEST target comes from the pinned channel alone. TEST_DATABASE_URL is
// set only because src/config/env.ts requires a valid value under NODE_ENV=test; it is
// not the target authority.
const pinnedGateTarget = readD5hPinnedTarget();
if (pinnedGateTarget) {
  process.env.TEST_DATABASE_URL = pinnedGateTarget.url;
} else {
  // Target-selection controls belong to the invoker, never to .env.development: the file
  // must not switch an ambient LOCAL_TEST run back to hosted TEST, introduce a selector or
  // LOCAL_TEST credentials, or manufacture the D5H gate variable. Their ambient state
  // (including absence) is restored exactly after the file is loaded.
  const ambientControls = [
    AUTOMATED_TEST_TARGET_VAR,
    LOCAL_TEST_URL_VAR,
    LOCAL_TEST_MARKER_VAR,
    D5H_PINNED_TARGET_VAR,
  ].map((key) => [key, process.env[key]] as const);
  config({
    path: fileURLToPath(new URL('../../.env.development', import.meta.url)),
    override: true,
    quiet: true,
  });
  for (const [key, value] of ambientControls) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
// D5F-A: deterministically own the JWT/CORS test values (after dotenv, so
// they override whatever .env.development or the ambient shell provided).
applySyntheticTestEnv();
// TEST-H1: src/config/prisma.ts binds the app's default client to DATABASE_URL
// (DEV) on import. Tests must never reach DEV through it, so it is replaced by
// an unresolvable target: an accidental default-client query fails loudly.
process.env.DATABASE_URL =
  'postgresql://tests:never-dev@database-url-disabled-in-tests.invalid:5432/postgres';

await assertTestDatabaseIsolation();