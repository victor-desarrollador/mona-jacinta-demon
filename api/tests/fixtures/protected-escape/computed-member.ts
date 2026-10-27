// Positive-control fixture for tests/protected-capability-static.test.ts: ONE forbidden construct inside a function shaped like a protected step.
// Never imported by production code; never executed.
import type { ProtectedTx } from '../../../scripts/local-test-fingerprint.js';
export async function stepComputedMember(tx: ProtectedTx, name: string) {
  return (tx as unknown as Record<string, () => Promise<void>>)[name]!();
}
