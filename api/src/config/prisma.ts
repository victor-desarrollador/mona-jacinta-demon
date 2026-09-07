import { readFileSync } from 'node:fs';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { logger } from '../shared/logger.js';
import { env } from './env.js';

// api/src/config and api/dist/config both resolve to the existing root CA.
const ca = readFileSync(
  new URL('../../../scripts/certs/supabase-prod-ca-2021.crt', import.meta.url),
  'utf8',
);

const adapter = new PrismaPg(
  {
    connectionString: env.DATABASE_URL,
    ssl: { rejectUnauthorized: true, ca },
    connectionTimeoutMillis: 10000,
    max: 5,
  },
  {
    onPoolError: () => logger.error({ event: 'database_pool_error' }),
    onConnectionError: () =>
      logger.error({ event: 'database_connection_error' }),
  },
);

export const prisma = new PrismaClient({ adapter, log: [] });
