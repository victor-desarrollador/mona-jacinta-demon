import { demoSeedOptionsFromEnv, seedDemo, type SeedOptions } from '../prisma/seed.js';
import { openSeedDatabase } from './demo-database.js';

// D3R1: optional operator password for a public DEMO seed. Validated before
// any database connection; the value itself is never printed.
function readOptions(): SeedOptions | null {
  try {
    return demoSeedOptionsFromEnv(process.env);
  } catch {
    console.error(
      '[db:seed] FAIL: DEMO_SEED_PASSWORD is set but invalid (16+ characters, at most 72 bytes, no leading/trailing spaces); nothing was changed',
    );
    process.exitCode = 1;
    return null;
  }
}

const options = readOptions();
if (options) {
  try {
    const db = await openSeedDatabase('demo');
    try {
      await seedDemo(db.prisma, options);
    } finally {
      await db.close();
    }
    console.log('[db:seed] OK: deterministic demo data ready');
  } catch {
    console.error(
      '[db:seed] FAIL: check local target configuration, isolation and empty business state',
    );
    process.exitCode = 1;
  }
}
