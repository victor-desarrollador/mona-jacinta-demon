import { demoSeedOptionsFromEnv, resetDemo, type SeedOptions } from '../prisma/seed.js';
import { openSeedDatabase } from './demo-database.js';

// D3R1: optional operator password for a public DEMO seed. Validated before
// any database connection; the value itself is never printed.
function readOptions(): SeedOptions | null {
  try {
    return demoSeedOptionsFromEnv(process.env);
  } catch {
    console.error(
      '[db:reset] FAIL: DEMO_SEED_PASSWORD is set but invalid (16+ characters, at most 72 bytes, no leading/trailing spaces); nothing was changed',
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
      await resetDemo(db.prisma, options);
    } finally {
      await db.close();
    }
    console.log('[db:reset] OK: deterministic demo state restored');
  } catch {
    console.error(
      '[db:reset] FAIL: reset refused or rolled back; check local target configuration and isolation',
    );
    process.exitCode = 1;
  }
}
