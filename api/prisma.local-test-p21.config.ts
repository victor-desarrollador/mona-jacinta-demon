import { defineConfig } from 'prisma/config';

// U1 (R3-T): Prisma CLI config for the P21 base of the disposable LOCAL_TEST
// database — migrations 1–8 only, for the P21 suite (r3-attempts-schema.pg.test.ts
// Suite B). Only ever selected explicitly by local-test-prepare.mjs
// `--migration-set=r3-p21-base` (`prisma migrate deploy --config
// prisma.local-test-p21.config.ts`); Prisma's implicit discovery never picks it.
//
// The migrations directory is the private staged copy that local-test-prepare.mjs
// made from the reviewed tree and verified byte-for-byte against the G8 pins
// (scripts/database/local-test-migration-payload.mjs). It is handed over in
// LOCAL_TEST_P21_MIGRATIONS_DIR and accepted only in the exact staging layout
// <abs>/mona-local-test-p21-XXXXXX/prisma/migrations. The reviewed
// prisma/migrations directory is never read by this config.
//
// The URL rule is the one of prisma.local-test.config.ts: the raw value must
// already be the canonical LOCAL_TEST loopback text. Errors never echo a value.
const STAGED_MIGRATIONS_DIR = /^(?:\/(?!\.\.?(?:\/|$))[^/\p{Cc}]+)*\/mona-local-test-p21-[A-Za-z0-9]{6}\/prisma\/migrations$/u;

function localTestDatabaseUrl(): string {
  const raw = process.env.LOCAL_TEST_DATABASE_URL;
  if (!raw) throw new Error('LOCAL_TEST_DATABASE_URL is required for the LOCAL_TEST Prisma config');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('LOCAL_TEST_DATABASE_URL is not a valid URL');
  }
  const canonical = `${url.protocol}//mona_local_test:${url.password}@127.0.0.1:5432/mona_local_test`;
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.password || raw !== canonical) {
    throw new Error('LOCAL_TEST_DATABASE_URL must be exactly the canonical LOCAL_TEST loopback target');
  }
  return raw;
}

function stagedMigrationsDir(): string {
  const dir = process.env.LOCAL_TEST_P21_MIGRATIONS_DIR;
  if (!dir || !STAGED_MIGRATIONS_DIR.test(dir)) {
    throw new Error('LOCAL_TEST_P21_MIGRATIONS_DIR must be the staged P21 base directory created by local-test-prepare.mjs');
  }
  return dir;
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: stagedMigrationsDir() },
  datasource: { url: localTestDatabaseUrl() },
});
