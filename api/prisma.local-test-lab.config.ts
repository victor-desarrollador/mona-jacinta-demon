import { defineConfig } from 'prisma/config';

// PILOT cut-over lab: Prisma CLI config for a disposable LOCAL_TEST cluster built FRESH
// with EXACTLY one state's migrations (EXACT_S4 = 1–4, EXACT_G7 = 1–7, EXACT_G11 = 1–11, … EXACT_G14 = 1–14).
// Only ever selected explicitly by scripts/database/local-test-cutover-lab-ops.mjs, after its
// identity and FRESH proofs; Prisma's implicit discovery never picks this filename.
//
// The migrations directory is the private staged copy the lab made from the reviewed tree and
// verified byte-for-byte against the state's pins (local-test-cutover-lab-core.mjs
// stageStatePayload). It is handed over in LOCAL_TEST_LAB_MIGRATIONS_DIR and accepted only in
// the exact staging layout <abs>/mona-local-test-lab-XXXXXX/prisma/migrations. The reviewed
// prisma/migrations directory is never read by this config (the migration rehearsal uses
// prisma.local-test.config.ts on the reviewed tree, as pilot-migrate does on PILOT).
//
// The URL rule is the one of prisma.local-test.config.ts: the raw value must already be the
// canonical LOCAL_TEST loopback text. Errors never echo a value.
const STAGED_MIGRATIONS_DIR = /^(?:\/(?!\.\.?(?:\/|$))[^/\p{Cc}]+)*\/mona-local-test-lab-[A-Za-z0-9]{6}\/prisma\/migrations$/u;

function localTestDatabaseUrl(): string {
  const raw = process.env.LOCAL_TEST_DATABASE_URL;
  if (!raw) throw new Error('LOCAL_TEST_DATABASE_URL is required for the LOCAL_TEST lab Prisma config');
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
  const dir = process.env.LOCAL_TEST_LAB_MIGRATIONS_DIR;
  if (!dir || !STAGED_MIGRATIONS_DIR.test(dir)) {
    throw new Error('LOCAL_TEST_LAB_MIGRATIONS_DIR must be the staged lab directory created by local-test-cutover-lab-core.mjs');
  }
  return dir;
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: stagedMigrationsDir() },
  datasource: { url: localTestDatabaseUrl() },
});
