import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { assertTestDatabaseIsolation } from './helpers/test-db.js';
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
config({
  path: fileURLToPath(new URL('../../.env.development', import.meta.url)),
  override: true,
  quiet: true,
});
// D5F-A: deterministically own the JWT/CORS test values (after dotenv, so
// they override whatever .env.development or the ambient shell provided).
applySyntheticTestEnv();
// TEST-H1: src/config/prisma.ts binds the app's default client to DATABASE_URL
// (DEV) on import. Tests must never reach DEV through it, so it is replaced by
// an unresolvable target: an accidental default-client query fails loudly.
process.env.DATABASE_URL =
  'postgresql://tests:never-dev@database-url-disabled-in-tests.invalid:5432/postgres';

await assertTestDatabaseIsolation();