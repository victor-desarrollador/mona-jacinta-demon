// Property-access class fixture PC-02 (remediation 1): the forbidden construct (if any) exists ONLY inside a callee body, never at the call site.
// Never imported by production code; never executed. Expected verdict is fixed in tests/protected-capability-static.test.ts (sealed preregistration).
import type { ProtectedTx } from '../../../scripts/local-test-fingerprint.js';
import { createHash } from 'node:crypto';
const hasher = { hex(x: string) { return createHash('sha256').update(x).digest('hex'); } };
export function root(tx: ProtectedTx) {
  void tx;
  return hasher.hex('x');
}
