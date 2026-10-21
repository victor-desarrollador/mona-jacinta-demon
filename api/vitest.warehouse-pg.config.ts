import { defineConfig } from 'vitest/config';

// WAREHOUSE-MVP opt-in PostgreSQL gate (tests/inventory/inventory-adjustment.pg.test.ts).
// Runs ONLY against an OWNER-authorized, disposable, marker-proven LOCAL_TEST
// cluster whose binding is passed through the environment (see the suite header);
// launched any other way the suite skips (MONA_WAREHOUSE_PG missing). It
// deliberately does not inherit vitest.config.ts: its globalSetup cleans factory
// rows against a hosted TEST target and tests/setup.ts owns the ambient .env
// selection — neither belongs to a disposable-cluster contract.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/inventory/inventory-adjustment.pg.test.ts'],
    setupFiles: [],
    globalSetup: [],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // The sales service imports the realtime module, which parses the API env at load.
    // Only synthetic, unresolvable values: the suite connects through the LOCAL_TEST
    // binding alone and never to this DATABASE_URL.
    env: {
      DATABASE_URL: 'postgresql://warehouse-pg-synthetic:never-used@database-url-disabled-in-tests.invalid:5432/postgres',
      TEST_DATABASE_URL: 'postgresql://warehouse-pg-synthetic:never-used@database-url-disabled-in-tests.invalid:5432/postgres',
      JWT_SECRET: 'warehouse-pg-synthetic-secret-never-used-0123456789',
      JWT_ACCESS_TTL_SECONDS: '900',
      CORS_ORIGINS: 'http://localhost:3000',
    },
  },
});
