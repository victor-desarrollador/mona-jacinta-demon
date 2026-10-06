// Positive-control fixture for tests/protected-capability-static.test.ts: ONE forbidden construct inside a function shaped like a protected step.
// Never imported by production code; never executed.
import { readProtectedRows, type ProtectedTx } from '../../../scripts/local-test-fingerprint.js';
export async function stepClean(tx: ProtectedTx) {
  return readProtectedRows(tx, { kind: 'fingerprint', query: 'settings' });
}
