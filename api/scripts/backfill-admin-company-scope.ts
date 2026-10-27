import { pathToFileURL } from 'node:url';
import { openSeedDatabase } from './demo-database.js';
import {
  backfillAdminCompanyScope,
  planAdminCompanyBackfill,
  type AdminCompanyBackfillPlan,
} from '../src/modules/rbac/admin-company-backfill.service.js';

type Target = 'demo' | 'test';
type Mode = 'dry-run' | 'execute';

export type ParsedArgs = { ok: true; target: Target; mode: Mode } | { ok: false; error: string };

// GC4A (Phase 1 Global Closeout): before this, a bare `--target=test` mutated
// immediately (backfillAdminCompanyScope ran with no confirmation step at
// all). This parser removes that implicit-mutation behavior: exactly one of
// --dry-run/--execute is now required, both/neither/an invalid target/an
// unrecognized safety-relevant argument all fail closed before any database
// connection is opened.
const KNOWN_MODE_FLAGS = new Set(['--dry-run', '--execute']);

export function parseCliArgs(argv: string[]): ParsedArgs {
  const targetArg = argv.find((a) => a.startsWith('--target='));
  const targetValue = targetArg?.split('=')[1];

  const unknown = argv.filter((a) => a.startsWith('--') && a !== targetArg && !KNOWN_MODE_FLAGS.has(a));
  if (unknown.length > 0) {
    return { ok: false, error: `Unknown argument(s): ${unknown.join(', ')}` };
  }

  if (!targetArg) {
    return { ok: false, error: '--target=demo or --target=test is required' };
  }
  const target: Target | null = targetValue === 'demo' || targetValue === 'test' ? targetValue : null;
  if (!target) {
    return { ok: false, error: `Invalid --target value: "${targetValue ?? ''}"; must be demo or test` };
  }

  const hasDryRun = argv.includes('--dry-run');
  const hasExecute = argv.includes('--execute');
  if (hasDryRun && hasExecute) {
    return { ok: false, error: 'Specify exactly one of --dry-run or --execute, not both' };
  }
  if (!hasDryRun && !hasExecute) {
    return {
      ok: false,
      error:
        'Exactly one of --dry-run or --execute is required (a bare --target no longer mutates)',
    };
  }

  return { ok: true, target, mode: hasDryRun ? 'dry-run' : 'execute' };
}

function printDryRunReport(target: Target, plan: AdminCompanyBackfillPlan): void {
  const ordinaryExpandingPermissions = plan.canonicalAdminPermissionCodes.filter(
    (code) => !plan.companyRequiredPermissionCodes.includes(code),
  );

  console.log('[db:backfill-admin-company-scope] DRY RUN');
  console.log(`  target: ${target}`);
  console.log(`  ADMIN role id: ${plan.adminRoleId}`);
  console.log(
    `  canonical Production ADMIN permissions: ${plan.productionPermissionCount} ` +
      `(${plan.canonicalAdminPermissionCodes.join(', ')})`,
  );
  console.log(`  actual ADMIN Production permission grants found: ${plan.actualAdminPermissionCodes.length}`);
  console.log(`  catalog matches expected canonical set: ${plan.catalogMatchesExpected ? 'yes' : 'NO'}`);
  console.log(
    `  COMPANY-required permissions (denied -> COMPANY-valid on conversion): ` +
      `${plan.companyRequiredPermissionCodes.join(', ')}`,
  );
  console.log(`  total ADMIN LOCATION rows: ${plan.totalAdminLocationRows}`);
  console.log(`  distinct affected ADMIN users: ${plan.affectedUserCount}`);
  console.log(`  affected users with >1 ADMIN LOCATION row: ${plan.usersWithMultipleLocationRows}`);
  console.log(`  affected users already mixed LOCATION+COMPANY: ${plan.usersAlreadyMixedLocationAndCompany}`);
  console.log(`  existing ADMIN COMPANY-only users (context): ${plan.companyOnlyAdminUsers.length}`);
  console.log(`  active locations (context): ${plan.activeLocations.length}`);
  console.log('');

  for (const user of plan.affectedUsers) {
    const locationCodes = user.locationAssignments.map((loc) => loc.locationCode).join(', ');
    console.log(`  user ${user.userId} (${user.name} <${user.email}>) isActive=${user.isActive}`);
    console.log(`    current ADMIN LOCATION assignments:`);
    for (const loc of user.locationAssignments) {
      console.log(
        `      - ${loc.locationCode} (${loc.locationName}, id=${loc.locationId}, active=${loc.locationActive})`,
      );
    }
    console.log(
      `    already has an ADMIN COMPANY row: ${user.alreadyHasCompanyAssignment ? 'YES (mixed state)' : 'no'}`,
    );
    console.log('    target state: exactly one ADMIN COMPANY assignment, locationId=null');
    console.log(
      `    authority expansion: ${plan.companyRequiredPermissionCodes.length} COMPANY-required ` +
        `permission(s) change from denied to COMPANY-valid (${plan.companyRequiredPermissionCodes.join(', ')}); ` +
        `${ordinaryExpandingPermissions.length} ordinary permission(s) expand location-paired coverage from ` +
        `[${locationCodes}] to company-wide (${ordinaryExpandingPermissions.join(', ')})`,
    );
    console.log('');
  }

  console.log(
    plan.readyForExecution
      ? 'DRY RUN READY — HUMAN REVIEW REQUIRED'
      : 'DRY RUN NOT READY — CATALOG/STATE REVIEW REQUIRED',
  );
}

export async function main(argv: string[]): Promise<void> {
  const parsed = parseCliArgs(argv);
  if (!parsed.ok) {
    console.error(`[db:backfill-admin-company-scope] FAIL: ${parsed.error}`);
    process.exitCode = 1;
    return;
  }

  const { target, mode } = parsed;
  try {
    const db = await openSeedDatabase(target);
    try {
      if (mode === 'dry-run') {
        const plan = await planAdminCompanyBackfill(db.prisma);
        printDryRunReport(target, plan);
      } else {
        const result = await backfillAdminCompanyScope(db.prisma);
        console.log('[db:backfill-admin-company-scope] OK');
        console.log(`  target: ${target}`);
        console.log(`  ADMIN users converted to COMPANY scope: ${result.usersConverted}`);
      }
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

// Only run the CLI flow when executed directly (`tsx scripts/backfill-admin-company-scope.ts`
// / `npm run db:backfill-admin-company-scope`) — importing parseCliArgs/main
// from a test must never open a database connection (see check-databases.mjs
// for the same guard pattern).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
