import { openSeedDatabase } from './demo-database.js';
import {
  backfillLocationsFromBranches,
  verifyBackfill,
  type CompanyBootstrap,
} from '../src/modules/organization/organization.service.js';

type Target = 'demo' | 'test';

// No real Company legal identity (CUIT, legal address) is approved anywhere in
// the frozen Production V1 docs (docs/production-v1/06-erd-data-model.md only
// specifies the shape, never a value) — this CUIT is NOT a real Mona Jacinta
// CUIT. Kept here, in the guarded CLI layer (openSeedDatabase restricts this
// script to the `demo`/`test` targets only — see demo-database.ts; there is no
// `production` branch to reach), rather than inside the organization domain
// service, so the service itself never encodes fake legal identity and a
// future production bootstrap process (a separate, explicit caller supplying
// its own real, approved CompanyBootstrap) can never inherit this value.
// Deterministic id (organization-module namespace "9000", see
// organization.service.ts) so the same source Branch data produces the same
// Company id across independently-bootstrapped databases.
const DEMO_COMPANY_BOOTSTRAP: CompanyBootstrap = {
  id: '00000000-0000-4000-9000-000000000001',
  name: 'Mona Jacinta (demo)',
  cuit: '00-00000000-0',
  address: 'Dirección legal demo — pendiente de dato real',
};

function parseTarget(argv: string[]): Target | null {
  const arg = argv.find((a) => a.startsWith('--target='));
  const value = arg?.split('=')[1];
  return value === 'demo' || value === 'test' ? value : null;
}

const target = parseTarget(process.argv.slice(2));
if (!target) {
  console.error(
    '[db:backfill-company-location] FAIL: --target=demo or --target=test is required',
  );
  process.exitCode = 1;
} else {
  try {
    const db = await openSeedDatabase(target);
    try {
      const result = await backfillLocationsFromBranches(db.prisma, DEMO_COMPANY_BOOTSTRAP);
      const verification = await verifyBackfill(db.prisma);
      if (!verification.ok) {
        throw new Error(`verification failed: ${verification.issues.join('; ')}`);
      }
      console.log('[db:backfill-company-location] OK');
      console.log(`  target: ${target}`);
      console.log(`  company: ${result.companyId}`);
      console.log(`  branches mapped: ${result.branchCount}`);
      console.log(`  locations: ${verification.locationCount}`);
    } finally {
      await db.close();
    }
  } catch (err) {
    console.error(
      `[db:backfill-company-location] FAIL: ${err instanceof Error ? err.message : 'unknown error'}`,
    );
    process.exitCode = 1;
  }
}
