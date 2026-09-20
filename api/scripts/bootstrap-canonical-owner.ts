import { pathToFileURL } from 'node:url';
import { hash } from 'bcryptjs';
import { openSeedDatabase } from './demo-database.js';
import {
  bootstrapCanonicalOwner,
  planCanonicalOwnerBootstrap,
  type BootstrapCanonicalOwnerOptions,
  type BootstrapCanonicalOwnerResult,
  type CanonicalOwnerBootstrapPlan,
} from '../src/modules/rbac/canonical-owner-bootstrap.service.js';

type Target = 'demo' | 'test';
type Mode = 'dry-run' | 'execute';

export type ParsedArgs = { ok: true; target: Target; mode: Mode } | { ok: false; error: string };

// GC4F3 (Phase 1 Global Closeout): same fail-closed safety contract as
// GC4A/GC4F1's CLIs — exactly one of --dry-run/--execute is required, and
// every ambiguous or unrecognized input fails closed before any database
// connection opens. This is the maximum-privilege bootstrap tool in the
// series, so the parser is at least as strict as its predecessors: bare
// target, missing target, both/neither mode, an invalid or duplicate
// --target (even identical duplicates), a repeated mode flag, an unknown
// flag, and a stray positional argument are all rejected.
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
    return { ok: false, error: 'Exactly one of --dry-run or --execute is required' };
  }

  return { ok: true, target, mode: hasDryRun ? 'dry-run' : 'execute' };
}

function printDryRunReport(target: Target, plan: CanonicalOwnerBootstrapPlan): void {
  console.log('[db:bootstrap-canonical-owner] DRY RUN');
  console.log(`  target: ${target}`);
  console.log(`  canonical userId: ${plan.canonical.userId}`);
  console.log(`  canonical email: ${plan.canonical.email}`);
  console.log(`  OWNER role: ${plan.ownerRole.exists ? plan.ownerRole.id : 'MISSING'}`);
  console.log(`  unexpected OWNER RolePermission grants: ${plan.ownerRole.unexpectedRolePermissionCount}`);
  console.log(`  identity state: ${plan.identityState}`);
  if (plan.existingCanonicalUser) {
    console.log(
      `  existing user: ${plan.existingCanonicalUser.name} <${plan.existingCanonicalUser.email}> ` +
        `isActive=${plan.existingCanonicalUser.isActive}`,
    );
  }
  console.log(`  existing OWNER scopes: ${plan.existingOwnerScopes.length}`);
  for (const scope of plan.existingOwnerScopes) {
    console.log(`    - ${scope.scopeKind} locationId=${scope.locationId ?? 'null'}`);
  }
  console.log(`  existing non-OWNER scopes (preserved, context only): ${plan.existingNonOwnerScopes.length}`);
  for (const scope of plan.existingNonOwnerScopes) {
    console.log(`    - ${scope.roleCode} ${scope.scopeKind} locationId=${scope.locationId ?? 'null'}`);
  }
  console.log(`  legacy UserBranchRole rows: ${plan.legacyUserBranchRoleRows.length}`);
  for (const row of plan.legacyUserBranchRoleRows) {
    console.log(`    - ${row.roleCode}@${row.branchCode}`);
  }
  console.log(`  other OWNER users (context only, never modified): ${plan.otherOwnerUsers.length}`);
  for (const user of plan.otherOwnerUsers) {
    const isCompanyOnly = user.scopes.every((s) => s.scopeKind === 'COMPANY');
    const isLocationOnly = user.scopes.every((s) => s.scopeKind === 'LOCATION');
    const shape =
      user.scopes.length === 0
        ? 'no OWNER-role scopes'
        : isCompanyOnly
          ? 'COMPANY'
          : isLocationOnly
            ? `LOCATION (${user.scopes.map((s) => s.locationId).join(', ')})`
            : `mixed (${user.scopes.map((s) => (s.scopeKind === 'COMPANY' ? 'COMPANY' : `LOCATION:${s.locationId}`)).join(', ')})`;
    console.log(`    - ${user.name} <${user.email}> isActive=${user.isActive}: ${shape}`);
  }
  console.log('  target scope: OWNER COMPANY locationId=null');
  console.log(`  action: ${plan.action}`);
  console.log(
    `  password required for execute: ${plan.passwordRequiredForExecute ? 'yes (OWNER_BOOTSTRAP_PASSWORD)' : 'no'}`,
  );
  if (plan.blockers.length > 0) {
    console.log('  blockers:');
    for (const blocker of plan.blockers) console.log(`    - ${blocker}`);
  }
  console.log('');
  console.log(
    plan.readyForExecution
      ? 'DRY RUN READY — HUMAN REVIEW REQUIRED'
      : 'DRY RUN NOT READY — STATE/CATALOG REVIEW REQUIRED',
  );
}

// GC4F3R1 (Phase 1 Global Closeout): a narrow dependency-injection seam so
// main()'s real branching logic (dry-run vs execute, password-required-vs-
// not, hash-only-transfer) is exercisable in tests without weakening
// production behavior — the direct-execution guard at the bottom of this
// file always calls `main(argv)` with no override, so production always
// gets the real openSeedDatabase/planCanonicalOwnerBootstrap/
// bootstrapCanonicalOwner/bcrypt hash/process.env read below. `readPassword`
// and `hashPassword` exist specifically so a test can observe "the password
// path was/was not touched" as a plain spy call count, rather than trying to
// prove non-access to the real process.env.
export type BootstrapCanonicalOwnerCliDeps = {
  openSeedDatabase: typeof openSeedDatabase;
  planCanonicalOwnerBootstrap: typeof planCanonicalOwnerBootstrap;
  bootstrapCanonicalOwner: (
    db: Awaited<ReturnType<typeof openSeedDatabase>>['prisma'],
    options: BootstrapCanonicalOwnerOptions,
  ) => Promise<BootstrapCanonicalOwnerResult>;
  hashPassword: (plaintext: string) => Promise<string>;
  readPassword: () => string | undefined;
};

const defaultDeps: BootstrapCanonicalOwnerCliDeps = {
  openSeedDatabase,
  planCanonicalOwnerBootstrap,
  bootstrapCanonicalOwner,
  hashPassword: (plaintext) => hash(plaintext, 12),
  readPassword: () => process.env.OWNER_BOOTSTRAP_PASSWORD,
};

export async function main(argv: string[], deps: BootstrapCanonicalOwnerCliDeps = defaultDeps): Promise<void> {
  const parsed = parseCliArgs(argv);
  if (!parsed.ok) {
    console.error(`[db:bootstrap-canonical-owner] FAIL: ${parsed.error}`);
    process.exitCode = 1;
    return;
  }

  const { target, mode } = parsed;
  try {
    const db = await deps.openSeedDatabase(target);
    try {
      const plan = await deps.planCanonicalOwnerBootstrap(db.prisma);
      if (mode === 'dry-run') {
        printDryRunReport(target, plan);
      } else {
        if (!plan.readyForExecution) {
          throw new Error(`plan not ready: ${plan.blockers.join('; ')}`);
        }
        let createPasswordHash: string | undefined;
        if (plan.action === 'CREATE_USER_AND_OWNER_SCOPE') {
          const secret = deps.readPassword();
          if (!secret) {
            throw new Error('OWNER_BOOTSTRAP_PASSWORD is required to create the absent canonical OWNER user');
          }
          createPasswordHash = await deps.hashPassword(secret);
        }
        const result = await deps.bootstrapCanonicalOwner(db.prisma, { createPasswordHash });
        console.log('[db:bootstrap-canonical-owner] OK');
        console.log(`  target: ${target}`);
        console.log(`  action performed: ${result.actionPerformed}`);
        console.log(`  user created: ${result.userCreated}`);
        console.log(`  owner scope changed: ${result.ownerScopeChanged}`);
        console.log(`  canonical user id: ${result.canonicalUserId}`);
      }
    } finally {
      await db.close();
    }
  } catch (err) {
    console.error(
      `[db:bootstrap-canonical-owner] FAIL: ${err instanceof Error ? err.message : 'unknown error'}`,
    );
    process.exitCode = 1;
  }
}

// Only run the CLI flow when executed directly (`tsx scripts/bootstrap-canonical-owner.ts`
// / `npm run db:bootstrap-canonical-owner`) — importing parseCliArgs/main
// from a test must never open a database connection or read
// OWNER_BOOTSTRAP_PASSWORD (see check-databases.mjs / backfill-admin-company-scope.ts
// for the same guard pattern). No deps override here, so this always uses
// the real defaults above.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
