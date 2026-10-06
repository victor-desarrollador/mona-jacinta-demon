// Property-access class fixture PC-05 (remediation 1): the forbidden construct (if any) exists ONLY inside a callee body, never at the call site.
// Never imported by production code; never executed. Expected verdict is fixed in tests/protected-capability-static.test.ts (sealed preregistration).
import type { ProtectedTx } from '../../../scripts/local-test-fingerprint.js';
class Box {
  private readonly items = new Map<number, number>();
  add(n: number) { this.items.set(n, n); return this; }
  size() { return this.items.size; }
}
export function root(tx: ProtectedTx) {
  void tx;
  return new Box().add(1).size();
}
