// Property-access class fixture PA-03 (remediation 1): the forbidden construct (if any) exists ONLY inside a callee body, never at the call site.
// Never imported by production code; never executed. Expected verdict is fixed in tests/protected-capability-static.test.ts (sealed preregistration).
import type { ProtectedTx } from '../../../scripts/local-test-fingerprint.js';
import { Pool } from 'pg';
const svc = { go(deps: { pool: Pool }) { return deps.pool.connect(); } };
export function root(tx: ProtectedTx, deps: { pool: Pool }) {
  void tx;
  return svc.go(deps);
}
