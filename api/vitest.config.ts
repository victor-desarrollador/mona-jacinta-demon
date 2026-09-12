import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    // Integration tests truncate + reseed against a real hosted PostgreSQL
    // (Supabase) TEST_DATABASE_URL per docs/development/database.md — round
    // trips are real network latency, not local disk I/O. 30s/10s defaults
    // were tuned for a local database and produced spurious timeouts here.
    testTimeout: 60000,
    hookTimeout: 60000,
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      reportsDirectory: './coverage',
    },
  },
});
