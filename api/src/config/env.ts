import { z } from 'zod';
import { loadRepositoryEnv } from './load-env.js';

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

const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  DATABASE_URL: databaseUrl,
  TEST_DATABASE_URL: databaseUrl,
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
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
