import { describe, expect, it } from 'vitest';
import { parseEnv } from '../src/config/env.js';

const input = {
  DATABASE_URL: 'postgresql://test:test@demo.invalid:5432/bootstrap',
  TEST_DATABASE_URL: 'postgresql://test:test@test.invalid:5432/bootstrap',
  JWT_SECRET: 'synthetic-test-key-not-for-real-authentication',
  JWT_ACCESS_TTL_SECONDS: '900',
  CORS_ORIGINS: ' http://localhost:3000, http://localhost:5173 ',
};

describe('environment validation', () => {
  it('defaults the port and parses TTL and trimmed origins', () => {
    const result = parseEnv(input);
    expect(result.API_PORT).toBe(3001);
    expect(result.JWT_ACCESS_TTL_SECONDS).toBe(900);
    expect(result.CORS_ORIGINS).toEqual([
      'http://localhost:3000',
      'http://localhost:5173',
    ]);
  });

  it.each(['0', '65536', '1.5', 'invalid'])(
    'rejects invalid port %s',
    (API_PORT) => {
      expect(() => parseEnv({ ...input, API_PORT })).toThrow('API_PORT');
    },
  );

  it.each(['0', '-1', '1.5', 'invalid'])(
    'rejects invalid TTL %s',
    (JWT_ACCESS_TTL_SECONDS) => {
      expect(() => parseEnv({ ...input, JWT_ACCESS_TTL_SECONDS })).toThrow(
        'JWT_ACCESS_TTL_SECONDS',
      );
    },
  );

  it.each(['', '*', 'not-an-origin', 'https://example.invalid/path'])(
    'rejects invalid CORS origins',
    (CORS_ORIGINS) => {
      expect(() => parseEnv({ ...input, CORS_ORIGINS })).toThrow(
        'CORS_ORIGINS',
      );
    },
  );

  it.each([
    '',
    'short',
    '<replace-with-a-random-secret-of-at-least-32-characters>',
  ])('rejects missing/weak/placeholder JWT secrets', (JWT_SECRET) => {
    expect(() => parseEnv({ ...input, JWT_SECRET })).toThrow('JWT_SECRET');
  });

  it('never includes invalid connection data in its error', () => {
    const sensitiveInput = 'synthetic-sensitive-invalid-url';
    let message = '';
    try {
      parseEnv({ ...input, DATABASE_URL: sensitiveInput });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe('Invalid API environment variables: DATABASE_URL');
    expect(message.includes(sensitiveInput)).toBe(false);
  });

  it.each([
    'ssl=false',
    'sslmode=require',
    'sslrootcert=other.crt',
    'uselibpqcompat=true',
  ])('rejects pg TLS query override %s', (option) => {
    expect(() =>
      parseEnv({ ...input, DATABASE_URL: `${input.DATABASE_URL}?${option}` }),
    ).toThrow('DATABASE_URL');
    expect(() =>
      parseEnv({
        ...input,
        TEST_DATABASE_URL: `${input.TEST_DATABASE_URL}?${option}`,
      }),
    ).toThrow('TEST_DATABASE_URL');
  });
});
