import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    fileParallelism: false,
    // Bootstrap tests use synthetic configuration and never access PostgreSQL.
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://test:test@demo.invalid:5432/bootstrap',
      TEST_DATABASE_URL: 'postgresql://test:test@test.invalid:5432/bootstrap',
      API_PORT: '3001',
      JWT_SECRET: 'synthetic-test-key-not-for-real-authentication',
      JWT_ACCESS_TTL_SECONDS: '900',
      CORS_ORIGINS: 'http://localhost:3000,http://localhost:5173',
    },
  },
});
