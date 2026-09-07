import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { assertTestDatabaseIsolation } from './helpers/test-db.js';

process.env.NODE_ENV = 'test';
config({
  path: fileURLToPath(new URL('../../.env.development', import.meta.url)),
  override: true,
  quiet: true,
});

await assertTestDatabaseIsolation();