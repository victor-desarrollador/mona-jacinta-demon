import { pino } from 'pino';

// Call sites log only fixed event names, HTTP status and generated request IDs.
// Never pass request objects, headers, URLs, environment objects or raw errors.
export const logger = pino({
  level: process.env.NODE_ENV === 'test' ? 'silent' : 'info',
  base: undefined,
  redact: {
    paths: [
      'password',
      'token',
      'authorization',
      'DATABASE_URL',
      'TEST_DATABASE_URL',
      'JWT_SECRET',
    ],
    censor: '[REDACTED]',
  },
});
