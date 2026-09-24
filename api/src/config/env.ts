import { z } from 'zod';
import { loadRepositoryEnv } from './load-env.js';
import { EXPIRED_HOLD_RELEASE_BATCH_LIMIT } from '../modules/sales/reservation-holds.js';

const databaseUrl = z.string().refine((value) => {
  try {
    const url = new URL(value);
    // Preserve Task 2's explicit TLS settings: pg URL options otherwise replace ssl.ca.
    return (
      ['postgres:', 'postgresql:'].includes(url.protocol) &&
      url.hostname.length > 0 &&
      ![
        'ssl',
        'sslmode',
        'sslcert',
        'sslkey',
        'sslrootcert',
        'uselibpqcompat',
      ].some((key) => url.searchParams.has(key))
    );
  } catch {
    return false;
  }
});

const port = z.coerce.number().int().min(1).max(65535);

const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  DATABASE_URL: databaseUrl,
  // Integration tests only: required for NODE_ENV=test (below), validated
  // whenever supplied, never needed by the production/development runtime,
  // which connects exclusively through DATABASE_URL.
  TEST_DATABASE_URL: databaseUrl.optional(),
  // Explicit Mona port; wins over the host-provided PORT.
  API_PORT: port.optional(),
  // Conventional host variable, validated only when it is the one selected.
  PORT: z.string().optional(),
  JWT_SECRET: z
    .string()
    .min(32)
    .refine(
      (value) => value.trim().length >= 32 && !/replace[-_ ]|<.*>/i.test(value),
    ),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive(),
  CORS_ORIGINS: z
    .string()
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    )
    .pipe(
      z
        .array(
          z.string().refine((value) => {
            try {
              const url = new URL(value);
              return (
                ['http:', 'https:'].includes(url.protocol) &&
                url.origin === value
              );
            } catch {
              return false;
            }
          }),
        )
        .min(1),
    ),
  // Pilot P0.1-B2: the expired-hold sweeper writes automatically, so it is
  // strictly opt-in (explicit 'true' only) and bounded.
  RESERVATION_SWEEPER_ENABLED: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  RESERVATION_SWEEP_INTERVAL_MS: z.coerce.number().int().min(1000).default(60000),
  RESERVATION_SWEEP_BATCH_SIZE: z.coerce.number().int().min(1).max(EXPIRED_HOLD_RELEASE_BATCH_LIMIT).default(100),
}).transform(({ PORT, API_PORT, ...rest }, ctx) => {
  if (rest.NODE_ENV === 'test' && rest.TEST_DATABASE_URL === undefined) {
    ctx.addIssue({ code: 'custom', path: ['TEST_DATABASE_URL'], message: 'Required for tests' });
    return z.NEVER;
  }
  let effectivePort = API_PORT;
  if (effectivePort === undefined && PORT !== undefined) {
    const parsedPort = port.safeParse(PORT);
    if (!parsedPort.success) {
      ctx.addIssue({ code: 'custom', path: ['PORT'], message: 'Invalid port' });
      return z.NEVER;
    }
    effectivePort = parsedPort.data;
  }
  // The single validated port the server listens on.
  return { ...rest, API_PORT: effectivePort ?? 3001 };
});

export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: NodeJS.ProcessEnv): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    // Zod messages/inputs may contain secrets. Report only known variable names.
    const fields = [
      ...new Set(parsed.error.issues.map((issue) => String(issue.path[0]))),
    ];
    throw new Error(`Invalid API environment variables: ${fields.join(', ')}`);
  }
  return parsed.data;
}

loadRepositoryEnv();
export const env = parseEnv(process.env);
