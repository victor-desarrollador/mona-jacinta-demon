// Property-access class fixture PA-33 (remediation 1): the forbidden construct (if any) exists ONLY inside a callee body, never at the call site.
// Never imported by production code; never executed. Expected verdict is fixed in tests/protected-capability-static.test.ts (sealed preregistration).
import type { ProtectedTx } from '../../../scripts/local-test-fingerprint.js';
import { Pool } from 'pg';
class Base { open() { return new Pool({}); } }
class Derived extends Base {}
export function root(tx: ProtectedTx) {
  void tx;
  return new Derived().open();
}
