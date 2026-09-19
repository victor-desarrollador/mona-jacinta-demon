import { pathToFileURL } from 'node:url';
import { openSeedDatabase } from './demo-database.js';
import {
  backfillUserRoleScopeFromUserBranchRole,
  planUserRoleScopeBackfill,
  verifyUserRoleScopeBackfill,
  type UserRoleScopeBackfillPlan,
} from '../src/modules/rbac/scope-backfill.service.js';

type Target = 'demo' | 'test';
type Mode = 'dry-run' | 'execute';

export type ParsedArgs = { ok: true; target: Target; mode: Mode } | { ok: false; error: string };

// GC4F1 (Phase 1 Global Closeout): before this, a bare `--target=test`
// mutated immediately (backfillUserRoleScopeFromUserBranchRole ran with no
// confirmation step at all — the same defect class GC4A already fixed for
// the ADMIN-company CLI). This parser removes that implicit-mutation
// behavior: exactly one of --dry-run/--execute is required, and every
// ambiguous or unrecognized input (both/neither mode, an invalid or
// duplicate --target, a repeated mode flag, an unknown flag, or a stray
// positional argument) fails closed before any database connection opens.
const KNOWN_MODE_FLAGS = new Set(['--dry-run', '--execute']);

export function parseCliArgs(argv: string[]): ParsedArgs {
  const positional = argv.filter((a) => !a.startsWith('--'));
  if (positional.length > 0) {
    return { ok: false, error: `Unexpected positional argument(s): ${positional.join(', ')}` };
  }

  const unknown = argv.filter(
    (a) => a.startsWith('--') && !a.startsWith('--target=') && !KNOWN_MODE_FLAGS.has(a),
  );
  if (unknown.length > 0) {
    return { ok: false, error: `Unknown argument(s): ${unknown.join(', ')}` };
  }

  const targetArgs = argv.filter((a) => a.startsWith('--target='));
  if (targetArgs.length > 1) {
    return { ok: false, error: 'Specify --target exactly once (conflicting/duplicate --target arguments)' };
  }
  const dryRunCount = argv.filter((a) => a === '--dry-run').length;
  const executeCount = argv.filter((a) => a === '--execute').length;
  if (dryRunCount > 1 || executeCount > 1) {
    return { ok: false, error: 'Specify --dry-run or --execute exactly once' };
  }

  const targetArg = targetArgs[0];
  if (!targetArg) {
    return { ok: false, error: '--target=demo or --target=test is required' };
  }
  const targetValue = targetArg.split('=')[1];
  const target: Target | null = targetValue === 'demo' || targetValue === 'test' ? targetValue : null;
  if (!target) {
    return { ok: false, error: `Invalid --target value: "${targetValue ?? ''}"; must be demo or test` };
  }

  const hasDryRun = dryRunCount === 1;
  const hasExecute = executeCount === 1;
  if (hasDryRun && hasExecute) {
    return { ok: false, error: 'Specify exactly one of --dry-run or --execute, not both' };
  }
  if (!hasDryRun && !hasExecute) {
    return {
      ok: false,
      error: 'Exactly one of --dry-run or --execute is required (a bare --target no longer mutates)',
    };
  }

  return { ok: true, target, mode: hasDryRun ? 'dry-run' : 'execute' };
}

function printDryRunReport(target: Target, plan: UserRoleScopeBackfillPlan): void {
  console.log('[db:backfill-user-role-scope] DRY RUN');
  console.log(`  target: ${target}`);
  console.log(`  legacy UserBranchRole rows: ${plan.legacyRowCount}`);
  console.log(`  current UserRoleScope rows: ${plan.currentUserRoleScopeCount}`);
  console.log(`  would create: ${plan.expectedCreateCount}`);
  console.log(`  already present: ${plan.alreadyPresentCount}`);
  console.log(`  ready for execution: ${plan.readyForExecution ? 'yes' : 'NO'}`);
  if (plan.blockers.length > 0) {
    console.log('  blockers:');
    for (const blocker of plan.blockers) console.log(`    - ${blocker}`);
  }
  console.log('');

  for (const row of plan.rows) {
    console.log(
      `  ${row.email} (${row.name}) isActive=${row.isActive}: legacy ${row.legacyRoleCode}@${row.branchCode} ` +
        `-> target ${row.target.productionRoleCode ?? 'UNMAPPED'} LOCATION(${row.target.locationCode ?? row.branchId}) ` +
        `alreadyPresent=${row.target.alreadyPresent} wouldCreate=${row.target.wouldCreate}` +
        (row.blocker ? ` BLOCKED:${row.blocker}` : ''),
    );
  }
  console.log('');

  if (plan.coexistingScopes.length > 0) {
    console.log('  coexisting Production scopes (context only — not touched by this tool):');
    for (const scope of plan.coexistingScopes) {
      console.log(
        `    - user ${scope.userId}: ${scope.roleCode} ${scope.scopeKind} locationId=${scope.locationId ?? 'null'}`,
      );
    }
    console.log('');
  }

  console.log('This Phase1C tool creates missing LOCATION UserRoleScope rows only.');
  console.log('It does NOT convert ADMIN LOCATION to ADMIN COMPANY.');
  console.log('A later ADMIN-company canonicalization step is separate.');
  console.log('');

  console.log(
    plan.readyForExecution
      ? 'DRY RUN READY — HUMAN REVIEW REQUIRED'
      : 'DRY RUN NOT READY — STATE/PREREQUISITE REVIEW REQUIRED',
  );
}

export async function main(argv: string[]): Promise<void> {
  const parsed = parseCliArgs(argv);
  if (!parsed.ok) {
    console.error(`[db:backfill-user-role-scope] FAIL: ${parsed.error}`);
    process.exitCode = 1;
    return;
  }

  const { target, mode } = parsed;
  try {
    const db = await openSeedDatabase(target);
    try {
      if (mode === 'dry-run') {
        const plan = await planUserRoleScopeBackfill(db.prisma);
        printDryRunReport(target, plan);
      } else {
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
      }
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

// Only run the CLI flow when executed directly (`tsx scripts/backfill-user-role-scope.ts`
// / `npm run db:backfill-user-role-scope`) — importing parseCliArgs/main from
// a test must never open a database connection (see check-databases.mjs /
// backfill-admin-company-scope.ts for the same guard pattern).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
