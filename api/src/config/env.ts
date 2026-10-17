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
  // Pre-pilot fix 2B: client key of the global limiter. 'socket' (default) is
  // the TCP peer; 'x-real-ip' is an explicit opt-in only for a trusted edge
  // that overwrites X-Real-IP (Railway). X-Forwarded-For is never trusted.
  CLIENT_IP_SOURCE: z.enum(['socket', 'x-real-ip']).default('socket'),
  // Block 1: bcrypt hash (cost >= 10) of the wholesale authorization code —
  // never the code itself. Unset or empty: wholesale sales are unavailable.
  WHOLESALE_AUTH_CODE_HASH: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().regex(/^\$2[aby]\$(1[0-9]|2[0-9]|3[01])\$[./A-Za-z0-9]{53}$/).optional(),
  ),
  // R3-A3.4 (R3 rev. 2 §5): the durable selector of the proportional checkout
  // path — comma-separated Location UUIDs (Location.id === Branch.id). It is
  // read in exactly one place, createDraftSale, when a sale is created; that
  // sale's Sale.pricingModel is fixed then and forever, and every later path
  // decides from the persisted column. An absent, empty or whitespace-only
  // value enables no branch. Otherwise the comma is a separator and nothing
  // else: every segment is trimmed and KEPT, so a leading, trailing or
  // intermediate empty segment is malformed configuration (never a silently
  // dropped entry), and each segment must be a UUID. A malformed entry stops
  // startup.
  PROPORTIONAL_CHECKOUT_LOCATION_IDS: z
    .string()
    .default('')
    .transform((value) => {
      const configured = value.trim();
      return configured === '' ? [] : configured.split(',').map((locationId) => locationId.trim());
    })
    .pipe(z.array(z.uuid())),
  // R3-A4.3 S-REF (R3 rev. 2 §5): the pilot gate of the external (TRANSFER /
  // CARD_DEBIT) payment methods of the proportional checkout. Strictly opt-in,
  // exactly like the sweeper: only an explicit 'true' enables them, and the
  // default is off. It is validated once at startup and injected by app.ts into
  // the quote and the reservation; the services never read the process. When it
  // is off, the quote reports the two external methods unavailable and a NEW
  // attempt needing one is refused with PAYMENT_METHOD_NOT_ENABLED — while
  // CASH, the listing and the refund stay available.
  PROPORTIONAL_EXTERNAL_METHODS_ENABLED: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
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
