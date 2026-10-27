// Property-access class fixture PA-60 (remediation 1): the forbidden construct (if any) exists ONLY inside a callee body, never at the call site.
// Never imported by production code; never executed. Expected verdict is fixed in tests/protected-capability-static.test.ts (sealed preregistration).
import type { ProtectedTx } from '../../../scripts/local-test-fingerprint.js';
import { PrismaClient } from '../../../src/generated/prisma/client.js';
const obj = { method() { return new PrismaClient({} as never); } };
function call<T>(f: () => T): T { return f(); }
export function root(tx: ProtectedTx) {
  void tx;
  return call(obj.method);
}
