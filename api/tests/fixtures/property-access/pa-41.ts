// Property-access class fixture PA-41 (remediation 1): the forbidden construct (if any) exists ONLY inside a callee body, never at the call site.
// Never imported by production code; never executed. Expected verdict is fixed in tests/protected-capability-static.test.ts (sealed preregistration).
import type { ProtectedTx } from '../../../scripts/local-test-fingerprint.js';
import { Pool } from 'pg';
interface Opener { open(): unknown }
class Impl implements Opener { open() { return new Pool({}); } }
export const impl: Opener = new Impl();
export function root(tx: ProtectedTx, o: Opener) {
  void tx;
  return o.open();
}
