import { defineConfig } from 'vitest/config';

// S9 G11 startup-gate PG proof (G11-ADV-004). Runs ONLY through the LOCAL_TEST
// cut-over lab (--op=integration-test), which provisions the disposable,
// marker-proven EXACT_G11 cluster and passes the binding through the
// environment; launched any other way the suite skips (opt-in env missing).
// This runner deliberately does not inherit vitest.config.ts: its globalSetup
// cleans factory rows against a hosted TEST target and tests/setup.ts owns the
// ambient .env selection — neither belongs to the lab-gated cluster contract.
// The suite itself synthesizes every application variable it needs.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/payments/checkout-readiness.pg.test.ts'],
    setupFiles: [],
    globalSetup: [],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // The S9-PG suite's documented PG-gate contract: only NODE_ENV and a TEST_DATABASE_URL
    // are supplied, and here it is the same synthetic, unresolvable literal the suite's own
    // startup path synthesizes — never a real target.
    env: { TEST_DATABASE_URL: 'postgresql://s9-synthetic:never-used@database-url-disabled-in-tests.invalid:5432/postgres' },
  },
});
