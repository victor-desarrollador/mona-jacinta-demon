import { fileURLToPath } from 'node:url';
import { defineConfig, env } from 'prisma/config';
import { loadRepositoryEnv } from './src/config/load-env.js';

loadRepositoryEnv();

// Migrate uses Prisma's native schema engine, not src/config/prisma.ts / PrismaPg.
// Its TLS options differ from pg's: sslcert is the trusted server CA here.
// Derive CLI-only TLS settings; never modify process.env or the stored database URL.
let migrationUrl: URL;
try {
  migrationUrl = new URL(env('DATABASE_URL'));
} catch {
  throw new Error('DATABASE_URL must be a valid PostgreSQL connection URL');
}
if (
  !['postgres:', 'postgresql:'].includes(migrationUrl.protocol) ||
  [...migrationUrl.searchParams.keys()].some(
    (key) => key.startsWith('ssl') || key === 'uselibpqcompat',
  )
) {
  throw new Error('DATABASE_URL must be PostgreSQL without TLS query overrides');
}
const caPath = fileURLToPath(
  new URL('../scripts/certs/supabase-prod-ca-2021.crt', import.meta.url),
);
migrationUrl.searchParams.set('sslmode', 'require');
migrationUrl.searchParams.set('sslaccept', 'strict');
migrationUrl.searchParams.set('sslcert', caPath);

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: { url: migrationUrl.toString() },
});
