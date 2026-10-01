// Task 4 RED6G-A: DB-free contract for server-observed transaction semantics.
// The fake has separate outer and transaction objects. It accepts only the
// reader's read-only setup, the required static settings query, and the schema
// probe for a FRESH database; no socket or real PostgreSQL is involved.
import { describe, expect, it } from 'vitest';
import {
  APPLICATION_TABLES,
  readLocalTestBaselineFacts,
  type LocalTestBaselineReadDatabase,
} from '../scripts/local-test-baseline.js';

type SettingsRow = Record<string, unknown>;
type FakeOptions = {
  settingsRows?: SettingsRow[];
};

const SETTINGS_SQL = "SELECT current_setting('transaction_isolation') AS transaction_isolation, current_setting('transaction_read_only') AS transaction_read_only";

function fakeDatabase(options: FakeOptions = {}) {
  const calls: string[] = [];
  const settingsRows = options.settingsRows ?? [
    { transaction_isolation: 'repeatable read', transaction_read_only: 'on' },
  ];
  const queryRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('?').replace(/\s+/g, ' ').trim();
    if (values.length > 0) throw new Error('interpolated SQL is not allowed');
    if (sql === "SELECT set_config('transaction_read_only', 'on', true)") {
      calls.push('tx:set-read-only');
      return [{ set_config: 'on' }];
    }
    if (sql === SETTINGS_SQL) {
      calls.push('tx:observe-settings');
      return settingsRows;
    }
    if (sql.includes('to_regclass')) {
      calls.push('tx:presence');
      return [Object.fromEntries([...APPLICATION_TABLES, '_prisma_migrations'].map((table) => [table, false]))];
    }
    throw new Error(`unexpected transaction SQL: ${sql}`);
  };
  const tx = { $queryRaw: queryRaw };
  const db = {
    $transaction: async (fn: (client: typeof tx) => Promise<unknown>, transactionOptions: unknown) => {
      calls.push(`outer:transaction:${JSON.stringify(transactionOptions)}`);
      return fn(tx);
    },
    $queryRaw: () => {
      throw new Error('outer queryRaw must not be used');
    },
  };
  return { db: db as unknown as LocalTestBaselineReadDatabase, calls };
}

async function read(options: FakeOptions = {}) {
  const fake = fakeDatabase(options);
  const facts = await readLocalTestBaselineFacts(fake.db);
  return { ...fake, facts };
}

async function expectSanitizedFailure(options: FakeOptions) {
  await expect(read(options)).rejects.toThrow('LOCAL_TEST baseline facts could not be read');
}

describe('LOCAL_TEST baseline transaction observation', () => {
  it('observes PostgreSQL repeatable read and read-only settings on the transaction client before schema facts', async () => {
    const result = await read();

    expect('migration' in result.facts).toBe(true);
    if (!('migration' in result.facts)) throw new Error('FRESH facts were expected');
    expect(result.facts.migration).toEqual({ schemaPresent: false, rows: [] });
    expect(result.calls).toEqual([
      'outer:transaction:{"isolationLevel":"RepeatableRead","maxWait":10000,"timeout":30000}',
      'tx:set-read-only',
      'tx:observe-settings',
      'tx:presence',
    ]);
  });

  it.each([
    ['read committed isolation', [{ transaction_isolation: 'read committed', transaction_read_only: 'on' }]],
    ['serializable isolation', [{ transaction_isolation: 'serializable', transaction_read_only: 'on' }]],
    ['read-only disabled', [{ transaction_isolation: 'repeatable read', transaction_read_only: 'off' }]],
    ['boolean read-only value', [{ transaction_isolation: 'repeatable read', transaction_read_only: false }]],
    ['missing isolation', [{ transaction_read_only: 'on' }]],
    ['null read-only value', [{ transaction_isolation: 'repeatable read', transaction_read_only: null }]],
    ['no settings row', []],
    ['duplicate settings rows', [
      { transaction_isolation: 'repeatable read', transaction_read_only: 'on' },
      { transaction_isolation: 'repeatable read', transaction_read_only: 'on' },
    ]],
  ])('fails closed for %s', async (_label, settingsRows) => {
    await expectSanitizedFailure({ settingsRows });
  });
});
