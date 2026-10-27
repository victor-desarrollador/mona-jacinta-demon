// Property-access class fixture PC-08 (remediation 1): the forbidden construct (if any) exists ONLY inside a callee body, never at the call site.
// Never imported by production code; never executed. Expected verdict is fixed in tests/protected-capability-static.test.ts (sealed preregistration).
import type { ProtectedTx } from '../../../scripts/local-test-fingerprint.js';
class Sized { get size() { return 3; } }
export function root(tx: ProtectedTx) {
  void tx;
  return new Sized().size;
}
