// Lock-relationship proof for the interleaving tests.
//
// The proof is `wait_event_type = 'Lock'` AND `pg_blocking_pids(waiter)` containing the holder: the waiter is blocked
// by the holder's transaction. pg_stat_activity.query is diagnostic only — it can still show the previous statement
// (e.g. the backend-pid probe) for a moment, so it never decides pass or fail.
export type BlockSample = { wait_event_type: string | null; wait_event: string | null; query: string; blockers: number[] } | undefined;
export type BlockProof = { query: string; waitEvent: string | null; queryMatchedTable: boolean };

export async function proveLockBlocked(opts: {
  sample: () => Promise<BlockSample>; holderPid: number; table: 'Sale' | 'CashSession'; timeoutMs?: number; intervalMs?: number;
}): Promise<BlockProof> {
  const deadline = Date.now() + (opts.timeoutMs ?? 8_000);
  let last: BlockSample;
  while (Date.now() < deadline) {
    last = await opts.sample();
    if (last?.wait_event_type === 'Lock' && last.blockers.includes(opts.holderPid)) {
      return {
        query: last.query,
        waitEvent: last.wait_event,
        queryMatchedTable: last.query.includes(`"${opts.table}"`) && last.query.includes('FOR UPDATE'),
      };
    }
    await new Promise((resolve) => setTimeout(resolve, opts.intervalMs ?? 20));
  }
  const seen = last
    ? `last query=${JSON.stringify(last.query.slice(0, 200))} wait_event_type=${last.wait_event_type ?? 'null'} wait_event=${last.wait_event ?? 'null'} blockers=${JSON.stringify(last.blockers)}`
    : 'no pg_stat_activity row was observed';
  throw new Error(`the ${opts.table} lock relationship was not observed (holder pid ${opts.holderPid}); ${seen}`);
}
