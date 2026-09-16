import { openSeedDatabase } from './demo-database.js';
import { backfillAdminCompanyScope } from '../src/modules/rbac/admin-company-backfill.service.js';

type Target = 'demo' | 'test';

function parseTarget(argv: string[]): Target | null {
  const arg = argv.find((a) => a.startsWith('--target='));
  const value = arg?.split('=')[1];
  return value === 'demo' || value === 'test' ? value : null;
}

const target = parseTarget(process.argv.slice(2));
if (!target) {
  console.error('[db:backfill-admin-company-scope] FAIL: --target=demo or --target=test is required');
  process.exitCode = 1;
} else {
  try {
    const db = await openSeedDatabase(target);
    try {
      const result = await backfillAdminCompanyScope(db.prisma);
      console.log('[db:backfill-admin-company-scope] OK');
      console.log(`  target: ${target}`);
      console.log(`  ADMIN users converted to COMPANY scope: ${result.usersConverted}`);
    } finally {
      await db.close();
    }
  } catch (err) {
    console.error(
      `[db:backfill-admin-company-scope] FAIL: ${err instanceof Error ? err.message : 'unknown error'}`,
    );
    process.exitCode = 1;
  }
}
