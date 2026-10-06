// Property-access class fixture BO-30 (remediation 1): the forbidden construct (if any) exists ONLY inside a callee body, never at the call site.
// Never imported by production code; never executed. Expected verdict is fixed in tests/protected-capability-static.test.ts (sealed preregistration).
import type { ProtectedTx } from '../../../scripts/local-test-fingerprint.js';
import { spawn } from 'node:child_process';
class Opener { open() { return spawn('true'); } }
export function root(tx: ProtectedTx) {
  void tx;
  return new Opener().open();
}
