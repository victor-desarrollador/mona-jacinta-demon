// Property-access class fixture PC-01 (remediation 1): the forbidden construct (if any) exists ONLY inside a callee body, never at the call site.
// Never imported by production code; never executed. Expected verdict is fixed in tests/protected-capability-static.test.ts (sealed preregistration).
import type { ProtectedTx } from '../../../scripts/local-test-fingerprint.js';
const fmt = { pad(s: string, n: number) { return s.padEnd(n); } };
export function root(tx: ProtectedTx) {
  void tx;
  return fmt.pad('x', 4);
}
