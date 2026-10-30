// Hermetic: the lock-proof helper shared by sale-void.pg.test.ts decides on Lock + holder blocker only.
// pg_stat_activity.query is diagnostic (it can still show the previous statement for a moment).
import { describe, expect, it } from 'vitest';
import { proveLockBlocked, type BlockSample } from '../helpers/prove-blocked.js';

const HOLDER = 111;
const LOCK_QUERY = 'SELECT id, "branchId", status, total FROM "Sale" WHERE id = $1 FOR UPDATE';
const PROBE_QUERY = "SELECT pg_backend_pid() AS pid, current_setting('transaction_isolation') AS isolation";
const fast = { holderPid: HOLDER, table: 'Sale' as const, timeoutMs: 60, intervalMs: 1 };

function sequence(...samples: BlockSample[]) {
  let calls = 0;
  const sample = async () => samples[Math.min(calls++, samples.length - 1)];
  return { sample, calls: () => calls };
}
const row = (over: Partial<NonNullable<BlockSample>>): BlockSample => ({ wait_event_type: 'Lock', wait_event: 'transactionid', query: LOCK_QUERY, blockers: [HOLDER], ...over });

describe('proveLockBlocked', () => {
  it('1 Lock + holder blocker + the expected query passes at once', async () => {
    const s = sequence(row({}));
    const result = await proveLockBlocked({ ...fast, sample: s.sample });
    expect(result).toMatchObject({ query: LOCK_QUERY, queryMatchedTable: true });
    expect(s.calls()).toBe(1);
  });

  it('2 Lock + holder blocker + the previous statement still reported does NOT fail and keeps the query as diagnostics', async () => {
    const s = sequence(row({ query: PROBE_QUERY }));
    const result = await proveLockBlocked({ ...fast, sample: s.sample });
    expect(result).toMatchObject({ query: PROBE_QUERY, queryMatchedTable: false, waitEvent: 'transactionid' });
    expect(s.calls()).toBe(1);
  });

  it('3 Lock without the holder as blocker keeps waiting (and passes once the holder appears)', async () => {
    const s = sequence(row({ blockers: [] }), row({ blockers: [999] }), row({}));
    await proveLockBlocked({ ...fast, sample: s.sample });
    expect(s.calls()).toBe(3);
  });

  it('4 holder as blocker but wait_event_type is not Lock keeps waiting', async () => {
    const s = sequence(row({ wait_event_type: 'Client', wait_event: 'ClientRead' }), row({ wait_event_type: null, wait_event: null }), row({}));
    await proveLockBlocked({ ...fast, sample: s.sample });
    expect(s.calls()).toBe(3);
  });

  it('5 timeout without Lock + holder fails with the last query, wait event and blockers', async () => {
    const s = sequence(row({ wait_event_type: 'IO', wait_event: 'DataFileRead', query: PROBE_QUERY, blockers: [7, 8] }));
    const error = await proveLockBlocked({ ...fast, sample: s.sample }).then(() => null, (cause: unknown) => cause as Error);
    expect(error).toBeInstanceOf(Error);
    expect(error!.message).toContain('Sale lock relationship was not observed');
    expect(error!.message).toContain(PROBE_QUERY);
    expect(error!.message).toContain('IO');
    expect(error!.message).toContain('DataFileRead');
    expect(error!.message).toContain('[7,8]');
  });

  it('5b timeout with no row at all still fails with a diagnostic message', async () => {
    const error = await proveLockBlocked({ ...fast, sample: async () => undefined }).then(() => null, (cause: unknown) => cause as Error);
    expect(error!.message).toContain('no pg_stat_activity row');
  });

  it('6 a query naming "Sale" FOR UPDATE without Lock + holder never passes', async () => {
    for (const bad of [row({ wait_event_type: null, wait_event: null }), row({ blockers: [] }), row({ wait_event_type: 'Client', wait_event: 'ClientRead', blockers: [HOLDER] })]) {
      await expect(proveLockBlocked({ ...fast, sample: sequence(bad).sample })).rejects.toThrow('lock relationship was not observed');
    }
  });
});
