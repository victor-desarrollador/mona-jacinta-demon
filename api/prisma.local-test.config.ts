import { defineConfig } from 'prisma/config';

// Task 4: Prisma CLI config for the disposable LOCAL_TEST database. It is only
// ever selected explicitly (`prisma … --config prisma.local-test.config.ts`);
// Prisma's implicit discovery never picks this filename. It reads
// LOCAL_TEST_DATABASE_URL and nothing else: no DATABASE_URL/TEST_DATABASE_URL
// fallback, no env files, no TLS options. It proves only the target's shape;
// the database's identity (marker, current_database/current_user, version) is
// proven by the caller before any Prisma command runs.
//
// Mirrors readLocalTestTarget (scripts/demo-database.ts), which cannot be
// imported here without loading pg/dotenv/Prisma runtime, and is stricter: the
// raw value must already be the canonical text, so no URL parser can read a
// different target from it than the one validated. That same raw string is
// what Prisma receives. Errors never echo the value.
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

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: { url: localTestDatabaseUrl() },
});
