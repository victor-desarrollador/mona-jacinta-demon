// Property-access class fixture AL-50 (remediation 1): the forbidden construct (if any) exists ONLY inside a callee body, never at the call site.
// Never imported by production code; never executed. Expected verdict is fixed in tests/protected-capability-static.test.ts (sealed preregistration).
import type { ProtectedTx } from '../../../scripts/local-test-fingerprint.js';
import { PrismaClient } from '../../../src/generated/prisma/client.js';
const obj = { method() { return new PrismaClient({} as never); } };
export function root(tx: ProtectedTx) {
  void tx;
  return [1].map(obj.method);
}
