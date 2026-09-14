import { openSeedDatabase } from './demo-database.js';
import {
  backfillUserRoleScopeFromUserBranchRole,
  verifyUserRoleScopeBackfill,
} from '../src/modules/rbac/scope-backfill.service.js';

type Target = 'demo' | 'test';

function parseTarget(argv: string[]): Target | null {
  const arg = argv.find((a) => a.startsWith('--target='));
  const value = arg?.split('=')[1];
  return value === 'demo' || value === 'test' ? value : null;
}

const target = parseTarget(process.argv.slice(2));
if (!target) {
  console.error('[db:backfill-user-role-scope] FAIL: --target=demo or --target=test is required');
  process.exitCode = 1;
} else {
  try {
    const db = await openSeedDatabase(target);
    try {
      const result = await backfillUserRoleScopeFromUserBranchRole(db.prisma);
      const verification = await verifyUserRoleScopeBackfill(db.prisma);
      if (!verification.ok) {
        throw new Error(`verification failed: ${verification.issues.join('; ')}`);
      }
      console.log('[db:backfill-user-role-scope] OK');
      console.log(`  target: ${target}`);
      console.log(`  legacy UserBranchRole rows: ${result.legacyRowCount}`);
      console.log(`  created: ${result.created}`);
      console.log(`  already present: ${result.alreadyPresent}`);
      console.log(`  verified UserRoleScope rows: ${verification.scopeCount}`);
    } finally {
      await db.close();
    }
  } catch (err) {
    console.error(
      `[db:backfill-user-role-scope] FAIL: ${err instanceof Error ? err.message : 'unknown error'}`,
    );
    process.exitCode = 1;
  }
}
