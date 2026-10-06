// Property-access class fixture CY-44 (remediation 1): the forbidden construct (if any) exists ONLY inside a callee body, never at the call site.
// Never imported by production code; never executed. Expected verdict is fixed in tests/protected-capability-static.test.ts (sealed preregistration).
import type { ProtectedTx } from '../../../scripts/local-test-fingerprint.js';
const a = { method(n: number): unknown { return n > 0 ? b.method(n - 1) : 0; } };
const b = { method(n: number): unknown { return n > 0 ? a.method(n - 1) : 1; } };
export function root(tx: ProtectedTx) {
  void tx;
  return a.method(2);
}
