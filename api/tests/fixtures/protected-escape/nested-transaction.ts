// Positive-control fixture for tests/protected-capability-static.test.ts: ONE forbidden construct inside a function shaped like a protected step.
// Never imported by production code; never executed.
import type { ProtectedTx } from '../../../scripts/local-test-fingerprint.js';
export async function stepNestedTransaction(tx: ProtectedTx) {
  return (tx as unknown as { $transaction: (fn: () => Promise<void>) => Promise<void> }).$transaction(async () => undefined);
}
