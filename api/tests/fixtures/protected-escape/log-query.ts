// Positive-control fixture for tests/protected-capability-static.test.ts: ONE forbidden construct inside a function shaped like a protected step.
// Never imported by production code; never executed.
import { PrismaClient } from '../../../src/generated/prisma/client.js';
export function stepLogQuery() {
  return new PrismaClient({ log: ['query'] } as never);
}
