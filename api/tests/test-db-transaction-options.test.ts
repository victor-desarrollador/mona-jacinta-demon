// DB-free proofs for the transaction options of the PrismaClient built by tests/helpers/test-db.ts.
//
// Hosted TEST pools wait up to 30 s for a connection (HOSTED_TEST_CONNECTION_TIMEOUT_MS) while Prisma gives up on
// starting a transaction after its default maxWait of 2 s. The test-client factory therefore sets
// transactionOptions.maxWait (and ONLY that). Nothing here opens a socket: the real PrismaClient and the real
// @prisma/adapter-pg run over a recording pg.Pool subclass whose connect() is scripted and never reaches a network.
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { describe, expect, it } from 'vitest';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { TEST_TRANSACTION_MAX_WAIT_MS, buildTestPrismaClient } from './helpers/test-db.js';

// Slower than Prisma's 2 s default maxWait, far below the 10 s the test client allows.
const SLOW_CONNECT_MS = 2_500;

function recordingAdapter(connectDelayMs: number) {
  const statements: string[] = [];
  const state = { connects: 0 };
  class FakeClient {
    on() { return this; }
    removeListener() { return this; }
    release() { /* nothing to release */ }
    async query(config: unknown) {
      statements.push(String(typeof config === 'string' ? config : (config as { text: string }).text).replace(/\s+/g, ' ').trim());
      return { rows: [], rowCount: 0, fields: [], command: 'SELECT' };
    }
  }
  class FakePool extends pg.Pool {
    constructor() { super({}); }
    override async connect() {
      state.connects += 1;
      if (connectDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, connectDelayMs));
      return new FakeClient() as never;
    }
  }
  return { adapter: new PrismaPg(new FakePool(), { schema: 'public' }), statements, state };
}

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8');

describe('test PrismaClient transaction options (maxWait only)', () => {
  it('TM01 the chosen maxWait is the 10 s precedent of the LOCAL_TEST runtime', () => {
    expect(TEST_TRANSACTION_MAX_WAIT_MS).toBe(10_000);
    expect(read('../scripts/local-test-runtime.ts')).toMatch(/DEFAULT_TRANSACTION_OPTIONS = Object\.freeze\(\{ maxWait: 10_000,/);
  });

  it('TM02 control: a default PrismaClient (maxWait 2 s) refuses to start a transaction when the connection takes 2.5 s', async () => {
    const { adapter } = recordingAdapter(SLOW_CONNECT_MS);
    const prisma = new PrismaClient({ adapter, log: [] });
    await expect(prisma.$transaction(async () => 'ok', { timeout: 5_000 })).rejects.toMatchObject({
      code: 'P2028',
      message: expect.stringContaining('Unable to start a transaction in the given time'),
    });
  }, 15_000);

  it('TM03 the test-client factory starts the same transaction: the 2.5 s connection fits inside maxWait', async () => {
    const { adapter, statements } = recordingAdapter(SLOW_CONNECT_MS);
    const prisma = buildTestPrismaClient(adapter);
    await expect(prisma.$transaction(async () => 'ok', { timeout: 5_000 })).resolves.toBe('ok');
    expect(statements).toEqual(['BEGIN', 'COMMIT']);
  }, 15_000);

  it('TM04 no warmup: building the client connects and queries nothing, and the first transaction is BEGIN .. COMMIT only', async () => {
    const { adapter, statements, state } = recordingAdapter(0);
    const prisma = buildTestPrismaClient(adapter);
    expect(state.connects).toBe(0);
    expect(statements).toEqual([]);
    await prisma.$transaction(async () => 'ok');
    expect(state.connects).toBe(1);
    expect(statements.some((sql) => /^SELECT\b/i.test(sql))).toBe(false);
  });

  it('TM05 no global isolationLevel: a transaction without one sets none, a service-style call still gets Serializable', async () => {
    const plain = recordingAdapter(0);
    await buildTestPrismaClient(plain.adapter).$transaction(async () => 'ok');
    expect(plain.statements.some((sql) => /^SET TRANSACTION/i.test(sql))).toBe(false);

    const serializable = recordingAdapter(0);
    await buildTestPrismaClient(serializable.adapter).$transaction(async () => 'ok', { isolationLevel: 'Serializable', timeout: 30_000 });
    expect(serializable.statements).toContain('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
  });

  it('TM06 static: the factory sets maxWait through the constant and no timeout or isolationLevel of its own', () => {
    const source = read('./helpers/test-db.ts');
    const start = source.indexOf('export function buildTestPrismaClient');
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf('\n}\n', start));
    expect(body).toContain('transactionOptions: { maxWait: TEST_TRANSACTION_MAX_WAIT_MS }');
    expect(body).not.toMatch(/timeout|isolationLevel|SELECT|\$queryRaw|\$executeRaw|\$connect/i);
    const create = source.slice(source.indexOf('export async function createTestPrismaClient'), source.indexOf('export async function truncateAllTables'));
    expect(create).toContain('buildTestPrismaClient(');
    expect(create).not.toMatch(/new PrismaClient\(/);
  });

  it('TM07 static: production and the retry classifier are untouched (no transactionOptions, no maxWait, no P2028 handling)', () => {
    for (const file of [
      '../src/config/prisma.ts',
      '../src/modules/sales/sale-void.service.ts',
      '../src/modules/cash/cash.service.ts',
      '../src/shared/transient-transaction-error.ts',
    ]) {
      const source = read(file);
      expect(source, file).not.toMatch(/transactionOptions|maxWait|P2028/);
    }
    expect(read('../src/modules/sales/sale-void.service.ts')).toContain("{ isolationLevel: 'Serializable', timeout: 30000 }");
    expect(read('../src/modules/cash/cash.service.ts')).toContain("{ isolationLevel: 'Serializable', timeout: 30000 }");
  });
});
