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

  // D3R1: TEST_DATABASE_URL is an integration-test setting, not a runtime
  // one. Production/development never connect with it, so they must not
  // require it (no placeholder/DEMO URL workarounds); NODE_ENV=test does.
  describe('TEST_DATABASE_URL by NODE_ENV', () => {
    const withoutTestUrl: Record<string, string> = { ...input };
    delete withoutTestUrl.TEST_DATABASE_URL;

    it.each(['production', 'development'])('is optional for NODE_ENV=%s', (NODE_ENV) => {
      const result = parseEnv({ ...withoutTestUrl, NODE_ENV });
      expect(result.NODE_ENV).toBe(NODE_ENV);
      expect(result.TEST_DATABASE_URL).toBeUndefined();
      expect(result.DATABASE_URL).toBe(input.DATABASE_URL);
    });

    it('is required for NODE_ENV=test and named in the error', () => {
      expect(() => parseEnv({ ...withoutTestUrl, NODE_ENV: 'test' })).toThrow(
        'Invalid API environment variables: TEST_DATABASE_URL',
      );
    });

    it('is accepted for NODE_ENV=test when valid', () => {
      expect(parseEnv({ ...input, NODE_ENV: 'test' }).TEST_DATABASE_URL).toBe(input.TEST_DATABASE_URL);
    });

    it.each(['production', 'development', 'test'])(
      'is still validated when supplied with NODE_ENV=%s, without echoing it',
      (NODE_ENV) => {
        const sensitiveInput = 'synthetic-sensitive-invalid-test-url';
        let message = '';
        try {
          parseEnv({ ...input, NODE_ENV, TEST_DATABASE_URL: sensitiveInput });
        } catch (error) {
          message = (error as Error).message;
        }
        expect(message).toBe('Invalid API environment variables: TEST_DATABASE_URL');
        expect(message.includes(sensitiveInput)).toBe(false);
      },
    );

    it('keeps DATABASE_URL required in production', () => {
      const withoutDatabase = { ...withoutTestUrl };
      delete withoutDatabase.DATABASE_URL;
      expect(() => parseEnv({ ...withoutDatabase, NODE_ENV: 'production' })).toThrow('DATABASE_URL');
    });
  });

  // D3R1: explicit API_PORT wins, else the host-provided PORT, else 3001.
  // The server listens on the single validated API_PORT value.
  describe('effective port', () => {
    it('prefers an explicit API_PORT over PORT', () => {
      const result = parseEnv({ ...input, API_PORT: '4000', PORT: '8080' });
      expect(result.API_PORT).toBe(4000);
      expect(result).not.toHaveProperty('PORT');
    });

    it('falls back to PORT when API_PORT is absent', () => {
      expect(parseEnv({ ...input, PORT: '10000' }).API_PORT).toBe(10000);
    });

    it('defaults to 3001 when neither is set', () => {
      expect(parseEnv(input).API_PORT).toBe(3001);
    });

    it.each(['0', '65536', '1.5', 'invalid', ''])('rejects invalid fallback PORT %j', (PORT) => {
      expect(() => parseEnv({ ...input, PORT })).toThrow('Invalid API environment variables: PORT');
    });

    it('ignores PORT entirely when an explicit API_PORT is selected', () => {
      expect(parseEnv({ ...input, API_PORT: '4000', PORT: 'invalid' }).API_PORT).toBe(4000);
    });

    it('still rejects an invalid explicit API_PORT even when PORT is valid', () => {
      expect(() => parseEnv({ ...input, API_PORT: 'invalid', PORT: '8080' })).toThrow('API_PORT');
    });
  });
});
