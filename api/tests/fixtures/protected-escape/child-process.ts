// Positive-control fixture for tests/protected-capability-static.test.ts: ONE forbidden construct inside a function shaped like a protected step.
// Never imported by production code; never executed.
import type { ProtectedTx } from '../../../scripts/local-test-fingerprint.js';
import { spawn } from 'node:child_process';
export function stepSpawn(tx: ProtectedTx) {
  void tx;
  return spawn('true');
}
