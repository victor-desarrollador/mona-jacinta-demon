// Vitest globalSetup runs once per `vitest run` invocation, in the main
// process, before any test file/worker starts — distinct from
// tests/setup.ts (setupFiles), which runs per worker. Bounds the factory's
// Location/UserRoleScope rows (tests/helpers/factories.ts) at the
// whole-invocation boundary rather than per file/test, since fileParallelism
// is false here (api/vitest.config.ts) and there is no cross-worker race to
// protect a shared row from. Only Locations are ever deleted here — the
// canonical Company is never touched (see tests/helpers/factory-cleanup.ts).
import {
  AUTOMATED_TEST_TARGET_VAR,
  LOCAL_TEST_MARKER_VAR,
  LOCAL_TEST_URL_VAR,
  openSeedDatabase,
  resolveAutomatedTestTarget,
  type AutomatedTestTarget,
} from '../scripts/demo-database.js';
import { cleanupFactoryOwnedLocations } from './helpers/factory-cleanup.js';

// openSeedDatabase('test') itself refuses to run outside NODE_ENV=test (see
// scripts/demo-database.ts), so this assignment is what makes that guard
// pass here — mirrors tests/setup.ts, which does the same for workers.
process.env.NODE_ENV = 'test';

// Task 4: the target (and, for LOCAL_TEST, its configuration) is read once per
// invocation, so teardown cleans the database setup proved even if process.env
// changes in between. Hosted TEST keeps reading its ignored repository file.
type PinnedTarget = { target: AutomatedTestTarget; source: NodeJS.ProcessEnv };

function pinTarget(): PinnedTarget {
  const source: NodeJS.ProcessEnv = {
    [AUTOMATED_TEST_TARGET_VAR]: process.env[AUTOMATED_TEST_TARGET_VAR],
    [LOCAL_TEST_URL_VAR]: process.env[LOCAL_TEST_URL_VAR],
    [LOCAL_TEST_MARKER_VAR]: process.env[LOCAL_TEST_MARKER_VAR],
  };
  return { target: resolveAutomatedTestTarget(source), source };
}

async function cleanup({ target, source }: PinnedTarget): Promise<void> {
  const db = await openSeedDatabase(target === 'local' ? 'local-test' : 'test', source);
  try {
    await cleanupFactoryOwnedLocations(db.prisma);
  } finally {
    await db.close();
  }
}

export default async function setup() {
  const pinned = pinTarget();

  // A. Recover from a previously aborted invocation (crash, Ctrl-C, timeout)
  // that never reached its own teardown.
  await cleanup(pinned);

  // B. Clean again after this invocation's own tests finish successfully.
  return async function teardown() {
    await cleanup(pinned);
  };
}
