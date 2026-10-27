// D5H-I1b.1 child runner. tests/test-db-guard.test.ts spawns this file with a LITERAL argv
// (`node tests/helpers/d5h-guard-child-runner.ts tests/test-db-guard.test.ts`) instead of
// `node -e <code>`, so the Task 4 scanner in tests/test-cleanup.test.ts can prove the launch
// is not the Prisma CLI, and this code is itself scanned as a test source. It runs one test
// file through the Vitest node API: no config file, no setupFiles, no globalSetup; only the
// tests whose full name matches MONA_D5H_GUARD_CHILD_PATTERN execute. Node runs it with
// type stripping, so only erasable TypeScript syntax is used here.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const CHILD_RESULT_PREFIX = 'D5H_I1B1_CHILD_RESULT ';
export const CHILD_PATTERN_VAR = 'MONA_D5H_GUARD_CHILD_PATTERN';

type Task = {
  type: string;
  name: string;
  result?: { state?: string; errors?: Array<{ message: string }> };
  tasks?: Task[];
};

const file = process.argv[2];
const pattern = process.env[CHILD_PATTERN_VAR];
const result: { passed: string[]; failed: string[] } = { passed: [], failed: [] };

// Runs only as the entry module; importing it (for the two constants) has no side effect.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (!file || pattern === undefined) {
    result.failed.push('runner :: missing test file argument or pattern variable');
    console.log(CHILD_RESULT_PREFIX + JSON.stringify(result));
    process.exit(2);
  }
  const { startVitest } = await import(createRequire(process.cwd() + '/runner.js').resolve('vitest/node'));
  const vitest = await startVitest('test', [file], {
    config: false, root: process.cwd(), watch: false, setupFiles: [], globalSetup: [],
    testNamePattern: pattern, reporters: [{}], testTimeout: 60000,
  });
  const walk = (task: Task) => {
    if (task.type === 'test' && task.result?.state === 'pass') result.passed.push(task.name);
    if (task.type === 'test' && task.result?.state === 'fail')
      result.failed.push(task.name + ' :: ' + (task.result.errors ?? []).map((e) => e.message).join(' | '));
    for (const child of task.tasks ?? []) walk(child);
  };
  for (const tested of vitest.state.getFiles()) {
    walk(tested as Task);
    for (const e of tested.result?.errors ?? []) result.failed.push('file :: ' + e.message);
  }
  for (const e of vitest.state.getUnhandledErrors()) result.failed.push('unhandled :: ' + String((e as Error)?.message ?? e));
  console.log(CHILD_RESULT_PREFIX + JSON.stringify(result));
  await vitest.close();
}
