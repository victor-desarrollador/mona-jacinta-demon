// D5F-A: DB-free regression proving the TEST harness deterministically owns
// JWT_SECRET, JWT_ACCESS_TTL_SECONDS and CORS_ORIGINS through the synthetic
// test-runtime-env module, wired into the per-worker setup.ts entry point.
//
// D5B3 evidence: 18 files failed with
//   "Invalid API environment variables: JWT_SECRET, JWT_ACCESS_TTL_SECONDS,
//    CORS_ORIGINS"
// because setup.ts loads .env.development but does not OWN these values.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, beforeAll } from 'vitest';
import {
  SYNTHETIC_CORS_ORIGINS,
  SYNTHETIC_JWT_ACCESS_TTL_SECONDS,
  SYNTHETIC_JWT_SECRET,
  applySyntheticTestEnv,
  syntheticTestEnvKeys,
} from './helpers/test-runtime-env.js';

const SETUP_PATH = fileURLToPath(new URL('./setup.ts', import.meta.url));
const setupSource = readFileSync(SETUP_PATH, 'utf8');

// Minimal env that satisfies DATABASE_URL and TEST_DATABASE_URL requirements
// (the same sentinel/synthetic pattern setup.ts uses).
const minimalTestEnv = (): NodeJS.ProcessEnv => ({
  NODE_ENV: 'test',
  DATABASE_URL:
    'postgresql://tests:never-dev@database-url-disabled-in-tests.invalid:5432/postgres',
  TEST_DATABASE_URL: 'postgresql://test:test@test.invalid:5432/bootstrap',
});

describe('D5F-A: deterministic TEST runtime environment', () => {
  describe('RED regression: setup.ts wires the synthetic env', () => {
    it('setup.ts imports applySyntheticTestEnv from test-runtime-env', () => {
      expect(setupSource).toContain('applySyntheticTestEnv');
    });

    it('setup.ts calls applySyntheticTestEnv after dotenv and before the DB isolation guard', () => {
      const dotenvIndex = setupSource.indexOf('override: true');
      const callIndex = setupSource.indexOf('applySyntheticTestEnv();', dotenvIndex);
      const guardIndex = setupSource.indexOf('await assertTestDatabaseIsolation');
      expect(dotenvIndex).toBeGreaterThan(-1);
      expect(callIndex).toBeGreaterThan(dotenvIndex);
      expect(guardIndex).toBeGreaterThan(callIndex);
    });
  });

  describe('synthetic values satisfy current env schema (contract)', () => {
    it('JWT_SECRET is ≥32 chars and has no replace/angle-bracket patterns', () => {
      expect(SYNTHETIC_JWT_SECRET.trim().length).toBeGreaterThanOrEqual(32);
      expect(SYNTHETIC_JWT_SECRET).not.toMatch(/replace[-_ ]|<.*>/i);
    });

    it('JWT_ACCESS_TTL_SECONDS is a positive integer', () => {
      expect(Number(SYNTHETIC_JWT_ACCESS_TTL_SECONDS)).toBeGreaterThan(0);
      expect(Number.isInteger(Number(SYNTHETIC_JWT_ACCESS_TTL_SECONDS))).toBe(true);
    });

    it('CORS_ORIGINS origins are valid http URLs', () => {
      for (const origin of SYNTHETIC_CORS_ORIGINS.split(',').map((o) => o.trim())) {
        const url = new URL(origin);
        expect(['http:', 'https:']).toContain(url.protocol);
        expect(url.origin).toBe(origin);
      }
    });
  });

  describe('deterministic ownership (overrides any prior state)', () => {
    it('overwrites a hostile inherited JWT_SECRET (angle brackets)', () => {
      const env = minimalTestEnv();
      (env as Record<string, string>).JWT_SECRET = '<script>evil-replace me</script>';
      applySyntheticTestEnv(env);
      expect(env.JWT_SECRET).toBe(SYNTHETIC_JWT_SECRET);
    });

    it('overwrites a valid-looking inherited JWT_SECRET from .env.development', () => {
      const env = minimalTestEnv();
      (env as Record<string, string>).JWT_SECRET = 'real-production-secret-that-tests-must-never-use';
      applySyntheticTestEnv(env);
      expect(env.JWT_SECRET).toBe(SYNTHETIC_JWT_SECRET);
    });

    it('overwrites an inherited CORS_ORIGINS with an invalid origin', () => {
      const env = minimalTestEnv();
      (env as Record<string, string>).CORS_ORIGINS = 'ftp://bad-origin';
      applySyntheticTestEnv(env);
      expect(env.CORS_ORIGINS).toBe(SYNTHETIC_CORS_ORIGINS);
    });

    it('overwrites a zero inherited JWT_ACCESS_TTL_SECONDS', () => {
      const env = minimalTestEnv();
      (env as Record<string, string>).JWT_ACCESS_TTL_SECONDS = '0';
      applySyntheticTestEnv(env);
      expect(env.JWT_ACCESS_TTL_SECONDS).toBe(SYNTHETIC_JWT_ACCESS_TTL_SECONDS);
    });

    it('is idempotent: applying twice produces the same values', () => {
      const env = minimalTestEnv();
      applySyntheticTestEnv(env);
      const first = { ...env };
      applySyntheticTestEnv(env);
      expect(env.JWT_SECRET).toBe(first.JWT_SECRET);
      expect(env.JWT_ACCESS_TTL_SECONDS).toBe(first.JWT_ACCESS_TTL_SECONDS);
      expect(env.CORS_ORIGINS).toBe(first.CORS_ORIGINS);
    });

    it('fills in values when they were entirely absent', () => {
      const env = minimalTestEnv();
      expect(env.JWT_SECRET).toBeUndefined();
      applySyntheticTestEnv(env);
      expect(env.JWT_SECRET).toBe(SYNTHETIC_JWT_SECRET);
      expect(env.JWT_ACCESS_TTL_SECONDS).toBe(SYNTHETIC_JWT_ACCESS_TTL_SECONDS);
      expect(env.CORS_ORIGINS).toBe(SYNTHETIC_CORS_ORIGINS);
    });
  });

  describe('isolation: the function owns only JWT/CORS keys', () => {
    it('does NOT touch DATABASE_URL (never-DEV sentinel preserved)', () => {
      const env = minimalTestEnv();
      const sentinel = env.DATABASE_URL;
      applySyntheticTestEnv(env);
      expect(env.DATABASE_URL).toBe(sentinel);
    });

    it('does NOT touch TEST_DATABASE_URL', () => {
      const env = minimalTestEnv();
      const url = env.TEST_DATABASE_URL;
      applySyntheticTestEnv(env);
      expect(env.TEST_DATABASE_URL).toBe(url);
    });

    it('does NOT touch NODE_ENV', () => {
      const env = minimalTestEnv();
      applySyntheticTestEnv(env);
      expect(env.NODE_ENV).toBe('test');
    });

    it('does NOT touch CLIENT_IP_SOURCE, RESERVATION_SWEEPER_* or WHOLESALE_AUTH_CODE_HASH', () => {
      const env = minimalTestEnv();
      applySyntheticTestEnv(env);
      expect(env.CLIENT_IP_SOURCE).toBeUndefined();
      expect(env.RESERVATION_SWEEPER_ENABLED).toBeUndefined();
      expect(env.RESERVATION_SWEEP_INTERVAL_MS).toBeUndefined();
      expect(env.RESERVATION_SWEEP_BATCH_SIZE).toBeUndefined();
      expect(env.WHOLESALE_AUTH_CODE_HASH).toBeUndefined();
    });

    it('owns exactly JWT_SECRET, JWT_ACCESS_TTL_SECONDS and CORS_ORIGINS', () => {
      expect(syntheticTestEnvKeys).toEqual([
        'JWT_SECRET',
        'JWT_ACCESS_TTL_SECONDS',
        'CORS_ORIGINS',
      ]);
    });
  });

  describe('parseEnv integration (dynamic import with safe env)', () => {
    // env.ts parses process.env at module level, so set the env BEFORE importing.
    // This mirrors what setup.ts will do after the D5F-A fix.
    let parseEnv: (source: NodeJS.ProcessEnv) => ReturnType<typeof Object>;

    beforeAll(async () => {
      const env = applySyntheticTestEnv(minimalTestEnv());
      Object.assign(process.env, env);
      const mod = await import('../src/config/env.js');
      parseEnv = mod.parseEnv as typeof parseEnv;
    });

    it('parseEnv succeeds with the synthetic harness values', () => {
      const result = parseEnv(
        applySyntheticTestEnv(minimalTestEnv()),
      ) as { JWT_SECRET: string; JWT_ACCESS_TTL_SECONDS: number; CORS_ORIGINS: string[] };
      expect(result.JWT_SECRET).toBe(SYNTHETIC_JWT_SECRET);
      expect(result.JWT_ACCESS_TTL_SECONDS).toBe(900);
      expect(result.CORS_ORIGINS).toEqual([
        'http://localhost:5173',
        'http://localhost:3000',
      ]);
    });

    it('parseEnv still rejects a missing JWT_SECRET (no validation weakening)', () => {
      const env = applySyntheticTestEnv(minimalTestEnv());
      delete (env as Record<string, string | undefined>).JWT_SECRET;
      expect(() => parseEnv(env)).toThrow('JWT_SECRET');
    });

    it('parseEnv still rejects a too-short JWT_SECRET', () => {
      const env = applySyntheticTestEnv(minimalTestEnv());
      (env as Record<string, string>).JWT_SECRET = 'short';
      expect(() => parseEnv(env)).toThrow('JWT_SECRET');
    });

    it('parseEnv still rejects a zero TTL', () => {
      const env = applySyntheticTestEnv(minimalTestEnv());
      (env as Record<string, string>).JWT_ACCESS_TTL_SECONDS = '0';
      expect(() => parseEnv(env)).toThrow('JWT_ACCESS_TTL_SECONDS');
    });

    it('parseEnv still rejects an invalid CORS origin', () => {
      const env = applySyntheticTestEnv(minimalTestEnv());
      (env as Record<string, string>).CORS_ORIGINS = 'not-a-url';
      expect(() => parseEnv(env)).toThrow('CORS_ORIGINS');
    });
  });
});
