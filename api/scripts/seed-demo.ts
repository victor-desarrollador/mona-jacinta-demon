import { seedDemo } from '../prisma/seed.js';
import { openSeedDatabase } from './demo-database.js';

try {
  const db = await openSeedDatabase('demo');
  try {
    await seedDemo(db.prisma);
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
