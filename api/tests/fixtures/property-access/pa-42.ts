// Property-access class fixture PA-42 (remediation 1): the forbidden construct (if any) exists ONLY inside a callee body, never at the call site.
// Never imported by production code; never executed. Expected verdict is fixed in tests/protected-capability-static.test.ts (sealed preregistration).
import type { ProtectedTx } from '../../../scripts/local-test-fingerprint.js';
import { Pool } from 'pg';
class Base { open(): unknown { return 1; } }
class Sub extends Base { open(): unknown { return new Pool({}); } }
export const sub: Base = new Sub();
export function root(tx: ProtectedTx, b: Base) {
  void tx;
  return b.open();
}
