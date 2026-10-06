// Property-access class fixture PA-12 (remediation 1): the forbidden construct (if any) exists ONLY inside a callee body, never at the call site.
// Never imported by production code; never executed. Expected verdict is fixed in tests/protected-capability-static.test.ts (sealed preregistration).
import type { ProtectedTx } from '../../../scripts/local-test-fingerprint.js';
import { PrismaClient } from '../../../src/generated/prisma/client.js';
const wrapper = { db: {} as PrismaClient };
const svc = { exec() { return wrapper.db.$transaction(async () => 1); } };
export function root(tx: ProtectedTx) {
  void tx;
  return svc.exec();
}
