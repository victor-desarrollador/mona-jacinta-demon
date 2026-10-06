// Property-access class fixture PC-09 (remediation 1): the forbidden construct (if any) exists ONLY inside a callee body, never at the call site.
// Never imported by production code; never executed. Expected verdict is fixed in tests/protected-capability-static.test.ts (sealed preregistration).
import type { ProtectedTx } from '../../../scripts/local-test-fingerprint.js';
const obj = { double(n: number) { return n * 2; } };
export function root(tx: ProtectedTx) {
  void tx;
  return [1, 2].map(obj.double);
}
