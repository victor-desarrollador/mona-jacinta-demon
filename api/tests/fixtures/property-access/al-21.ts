// Property-access class fixture AL-21 (remediation 1): the forbidden construct (if any) exists ONLY inside a callee body, never at the call site.
// Never imported by production code; never executed. Expected verdict is fixed in tests/protected-capability-static.test.ts (sealed preregistration).
import type { ProtectedTx } from '../../../scripts/local-test-fingerprint.js';
const map = new Map<string, () => unknown>();
map.set('handler', () => 1);
export function root(tx: ProtectedTx) {
  void tx;
  return map.get('handler')!();
}
