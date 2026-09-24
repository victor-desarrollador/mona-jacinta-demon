import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { openSeedDatabase } from './demo-database.js';
import { hashPassword } from '../src/modules/auth/password.js';
import {
  bootstrapSystemActor,
  planSystemActorBootstrap,
  SYSTEM_ACTOR_EMAIL,
  SYSTEM_ACTOR_USER_ID,
} from '../src/modules/audit/system-actor.service.js';

type Target = 'demo' | 'test';
type Mode = 'dry-run' | 'execute';
type ParsedArgs = { ok: true; target: Target; mode: Mode } | { ok: false; error: string };

// Pilot P0.1-B1: same fail-closed CLI contract as
// bootstrap-canonical-owner.ts — exactly one --target and exactly one of
// --dry-run/--execute; anything ambiguous fails before a database opens.
export function parseCliArgs(argv: string[]): ParsedArgs {
  if (argv.some((arg) => !arg.startsWith('--'))) return { ok: false, error: 'Unexpected positional argument(s)' };
  if (argv.some((arg) => !arg.startsWith('--target=') && arg !== '--dry-run' && arg !== '--execute')) {
    return { ok: false, error: 'Unknown argument(s)' };
  }
  const targets = argv.filter((arg) => arg.startsWith('--target='));
  const dryRun = argv.filter((arg) => arg === '--dry-run').length;
  const execute = argv.filter((arg) => arg === '--execute').length;
  if (targets.length !== 1) return { ok: false, error: '--target=demo or --target=test is required exactly once' };
  const value = targets[0]!.slice('--target='.length);
  if (value !== 'demo' && value !== 'test') return { ok: false, error: 'Invalid --target value; must be demo or test' };
  if (dryRun + execute !== 1) return { ok: false, error: 'Specify exactly one of --dry-run or --execute' };
  return { ok: true, target: value, mode: dryRun === 1 ? 'dry-run' : 'execute' };
}

// Test seam: production always uses the defaults below. The generated
// secret is only ever passed to hashPassword and never printed; the
// resulting credential is unusable in practice because the actor is inactive.
export type BootstrapSystemActorCliDeps = {
  openSeedDatabase: typeof openSeedDatabase;
  generateSecret: () => string;
};

const defaultDeps: BootstrapSystemActorCliDeps = {
  openSeedDatabase,
  generateSecret: () => randomBytes(48).toString('base64url'),
};

export async function main(argv: string[], deps: BootstrapSystemActorCliDeps = defaultDeps): Promise<void> {
  const parsed = parseCliArgs(argv);
  if (!parsed.ok) {
    console.error(`[db:bootstrap-system-actor] FAIL: ${parsed.error}`);
    process.exitCode = 1;
    return;
  }
  try {
    const db = await deps.openSeedDatabase(parsed.target);
    try {
      if (parsed.mode === 'dry-run') {
        const plan = await planSystemActorBootstrap(db.prisma);
        console.log('[db:bootstrap-system-actor] DRY RUN');
        console.log(`  target: ${parsed.target}`);
        console.log(`  system actor: ${SYSTEM_ACTOR_USER_ID} <${SYSTEM_ACTOR_EMAIL}>`);
        console.log(`  state: ${plan.state}`);
        for (const blocker of plan.blockers) console.log(`  blocker: ${blocker}`);
        console.log(plan.readyForExecution ? 'DRY RUN READY — HUMAN REVIEW REQUIRED' : 'DRY RUN NOT READY — STATE REVIEW REQUIRED');
      } else {
        const result = await bootstrapSystemActor(db.prisma, {
          createPasswordHash: () => hashPassword(deps.generateSecret()),
        });
        console.log('[db:bootstrap-system-actor] OK');
        console.log(`  target: ${parsed.target}`);
        console.log(`  action performed: ${result.action}`);
        console.log(`  system actor id: ${result.userId}`);
      }
    } finally {
      await db.close();
    }
  } catch (err) {
    console.error(`[db:bootstrap-system-actor] FAIL: ${err instanceof Error ? err.message : 'unknown error'}`);
    process.exitCode = 1;
  }
}

// Only run when executed directly; importing from a test never connects.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
