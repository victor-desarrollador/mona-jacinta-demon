// Generic DB-free Vitest config: no setupFiles, no globalSetup, so nothing here
// proves or contacts a database. Used ONLY through scripts/dev/safe-nodb-run.mjs,
// which adds the sanitized environment and the network namespace. The API root
// is derived from this file's own location, so it works in any worktree.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export default {
  test: {
    root: path.dirname(fileURLToPath(import.meta.url)),
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: [],
    globalSetup: [],
    testTimeout: 20_000,
    fileParallelism: false,
  },
};
