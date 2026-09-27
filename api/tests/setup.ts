import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { assertTestDatabaseIsolation } from './helpers/test-db.js';

process.env.NODE_ENV = 'test';
config({
  path: fileURLToPath(new URL('../../.env.development', import.meta.url)),
  override: true,
  quiet: true,
});
// TEST-H1: src/config/prisma.ts binds the app's default client to DATABASE_URL
// (DEV) on import. Tests must never reach DEV through it, so it is replaced by
// an unresolvable target: an accidental default-client query fails loudly.
process.env.DATABASE_URL =
  'postgresql://tests:never-dev@database-url-disabled-in-tests.invalid:5432/postgres';

await assertTestDatabaseIsolation();