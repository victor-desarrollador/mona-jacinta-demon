import { defineConfig } from 'vitest/config';

// This runner deliberately does not inherit vitest.config.ts: its globalSetup
// cleans factory rows before a test file can prove its own isolated target.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/cash/cash-close-concurrency.local-test.test.ts'],
    setupFiles: [],
    globalSetup: [],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
