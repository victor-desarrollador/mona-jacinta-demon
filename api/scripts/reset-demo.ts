import { resetDemo } from '../prisma/seed.js';
import { openSeedDatabase } from './demo-database.js';

try {
  const db = await openSeedDatabase('demo');
  try {
    await resetDemo(db.prisma);
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
