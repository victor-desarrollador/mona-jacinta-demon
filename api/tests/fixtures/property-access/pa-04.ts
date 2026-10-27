// Property-access class fixture PA-04 (remediation 1): the forbidden construct (if any) exists ONLY inside a callee body, never at the call site.
// Never imported by production code; never executed. Expected verdict is fixed in tests/protected-capability-static.test.ts (sealed preregistration).
import type { ProtectedTx } from '../../../scripts/local-test-fingerprint.js';
import { Pool } from 'pg';
class PoolWrapper {
  constructor(private readonly pool: Pool) {}
  connectViaWrapper() { return this.pool.connect(); }
}
export function root(tx: ProtectedTx, deps: { pool: PoolWrapper }) {
  void tx;
  return deps.pool.connectViaWrapper();
}
