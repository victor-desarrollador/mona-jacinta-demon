import { openSeedDatabase } from './demo-database.js';
import {
  bootstrapProductionRbacCatalog,
  verifyProductionRbacCatalog,
} from '../src/modules/rbac/catalog.service.js';

type Target = 'demo' | 'test';

function parseTarget(argv: string[]): Target | null {
  const arg = argv.find((a) => a.startsWith('--target='));
  const value = arg?.split('=')[1];
  return value === 'demo' || value === 'test' ? value : null;
}

const target = parseTarget(process.argv.slice(2));
if (!target) {
  console.error('[db:bootstrap-rbac-catalog] FAIL: --target=demo or --target=test is required');
  process.exitCode = 1;
} else {
  try {
    const db = await openSeedDatabase(target);
    try {
      const result = await bootstrapProductionRbacCatalog(db.prisma);
      const verification = await verifyProductionRbacCatalog(db.prisma);
      if (!verification.ok) {
        throw new Error(`verification failed: ${verification.issues.join('; ')}`);
      }
      console.log('[db:bootstrap-rbac-catalog] OK');
      console.log(`  target: ${target}`);
      console.log(`  roles: ${verification.roleCount}`);
      console.log(`  permissions: ${verification.permissionCount}`);
      console.log(`  rolePermission grants ensured: ${result.rolePermissionGrantCount}`);
    } finally {
      await db.close();
    }
  } catch (err) {
    console.error(
      `[db:bootstrap-rbac-catalog] FAIL: ${err instanceof Error ? err.message : 'unknown error'}`,
    );
    process.exitCode = 1;
  }
}
