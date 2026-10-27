// Property-access class fixture BO-54 (remediation 1): the forbidden construct (if any) exists ONLY inside a callee body, never at the call site.
// Never imported by production code; never executed. Expected verdict is fixed in tests/protected-capability-static.test.ts (sealed preregistration).
import type { ProtectedTx } from '../../../scripts/local-test-fingerprint.js';
import { Pool } from 'pg';
const P = Pool;
class Opener { open() { return new P({}); } }
export function root(tx: ProtectedTx) {
  void tx;
  return new Opener().open();
}
