// V2.3.3 R4 HIGH-1 (found by the real PostgreSQL run): the read-only protected profiles (outcome verifier, backup snapshot exporter,
// stability transaction) must establish TimeZone = UTC INSIDE their own setup. The simulation replays exactly the statements the
// production code issues against a session whose default zone is configurable, and the verification is the REAL settings proof
// (proveSettingsOnTransaction). Nothing here sets the zone before calling production code. Preregistered T01..T20.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DigestSink, proveSettingsOnTransaction, type SettingsProfile } from '../scripts/local-test-fingerprint.js';
import {
  checkOutcomeTransaction, protectTx, withBackupSnapshotTransaction, OutcomeCheckFailure, SnapshotFailure,
  type ProtectedPrisma, type ProtectedSteps,
} from '../scripts/local-test-runtime.js';

const UUID = '11111111-1111-4111-8111-111111111111';
const SNAP = '00000003-0000001B-1';
const SCHEMA = 's'.repeat(64);
const UNIT: Record<string, string> = { '10s': '10000', '120s': '120000', '180s': '180000', '15min': '900000' };
const ISOLATION: Record<string, string> = { RepeatableRead: 'repeatable read', ReadCommitted: 'read committed' };

type Tx = { index: number; statements: string[]; state: Record<string, string> };
function simulation(defaultZone: string, hooks: { failOn?: RegExp } = {}) {
  const txs: Tx[] = [];
  const events: string[] = [];
  const prisma = {
    $transaction: async (cb: (raw: unknown) => Promise<unknown>, options?: { isolationLevel?: string }) => {
      const tx: Tx = {
        index: txs.length + 1,
        statements: [],
        state: {
          search_path: '"$user", public', transaction_isolation: ISOLATION[options?.isolationLevel ?? 'ReadCommitted'] ?? 'read committed', server_encoding: 'UTF8', client_encoding: 'UTF8',
          session_replication_role: 'origin', standard_conforming_strings: 'on', synchronous_commit: 'on', fsync: 'on', TimeZone: defaultZone,
          lock_timeout: '0', statement_timeout: '0', idle_in_transaction_session_timeout: '0',
        },
      };
      txs.push(tx);
      const raw = {
        $executeRawUnsafe: async (sql: string) => {
          tx.statements.push(sql);
          events.push(`SQL:${sql}`);
          if (hooks.failOn?.test(sql)) throw new Error('simulated SET failure');
          const m = /^SET LOCAL (\w+) = (?:'([^']*)'|(.+))$/.exec(sql);
          if (m) {
            const name = m[1] === 'timezone' ? 'TimeZone' : (m[1] as string);
            const value = (m[2] ?? m[3]) as string;
            tx.state[name] = UNIT[value] ?? value;
          }
          return 0;
        },
        $queryRawUnsafe: async (sql: string) => {
          tx.statements.push(sql);
          events.push(`SQL:${sql}`);
          if (sql.includes('pg_catalog.pg_settings')) return Object.entries(tx.state).map(([name, setting]) => ({ name, setting }));
          if (sql === 'SELECT pg_catalog.pg_export_snapshot() AS snapshot_id') return [{ snapshot_id: SNAP }];
          return [];
        },
        $queryRaw: async () => [],
        $executeRaw: async () => 0,
        $transaction: async () => { throw new Error('raw $transaction reached'); },
        $connect: async () => { throw new Error('raw $connect reached'); },
        $disconnect: async () => { throw new Error('raw $disconnect reached'); },
      };
      events.push('BEGIN');
      try {
        const result = await cb(raw);
        events.push('COMMIT');
        return result;
      } catch (error) {
        events.push('ROLLBACK');
        throw error;
      }
    },
  } as unknown as ProtectedPrisma;
  const steps = (observed: { profile: SettingsProfile; zone: string }[] = []): Partial<ProtectedSteps> => ({
    proveIdentity: async () => { events.push('identity'); },
    // the REAL settings proof, fed by the simulated pg_settings of the current transaction
    assertSettings: async (tx, profile) => {
      events.push(`settings:${profile}`);
      observed.push({ profile: profile as SettingsProfile, zone: (txs.at(-1) as Tx).state.TimeZone as string });
      await proveSettingsOnTransaction(tx, profile as SettingsProfile);
    },
    proveDomain: async () => { events.push('domain'); },
    classify: async () => { events.push('classify'); return 'POST_BACKFILL'; },
    readState: async (_tx, sinks: readonly DigestSink[]) => {
      events.push('readState');
      for (const s of sinks) s.write(Buffer.from('state'));
      return { rows: null, serverVersionNum: '170011', markerId: UUID, schemaDigest: SCHEMA };
    },
  });
  return { prisma, txs, events, steps };
}
const NON_UTC = ['America/Argentina/Buenos_Aires', 'Asia/Kolkata', 'UTC+01', 'Europe/Madrid', 'Pacific/Chatham'];
const firstLock = (statements: string[]) => statements.findIndex((s) => s.startsWith('LOCK TABLE'));

describe('HIGH-1 read-only protected profiles pin TimeZone = UTC themselves', () => {
  it.each([...NON_UTC, 'UTC'])('T01-T04/T06 outcome verifier succeeds when the session default zone is %s', async (zone) => {
    const sim = simulation(zone);
    const observed: { profile: SettingsProfile; zone: string }[] = [];
    const out = await checkOutcomeTransaction(sim.prisma, { steps: sim.steps(observed) });
    expect(out.markerId).toBe(UUID);
    expect(observed).toEqual([{ profile: 'outcome', zone: 'UTC' }]);
    expect(sim.events.indexOf('settings:outcome')).toBeLessThan(sim.events.indexOf('readState')); // T12
  });

  it.each([...NON_UTC, 'UTC'])('T07-T09 snapshot exporter and stability transaction each establish UTC when the default is %s', async (zone) => {
    const sim = simulation(zone);
    const observed: { profile: SettingsProfile; zone: string }[] = [];
    const value = await withBackupSnapshotTransaction(sim.prisma, async () => 'dump-ok', { steps: sim.steps(observed) });
    expect(value).toBe('dump-ok');
    expect(observed).toEqual([{ profile: 'snapshot', zone: 'UTC' }, { profile: 'stability', zone: 'UTC' }]);
    expect(sim.txs).toHaveLength(2); // T19: exporter + stability, no further transaction
    for (const tx of sim.txs) expect(tx.statements).toContain("SET LOCAL timezone = 'UTC'"); // T08
  });

  it('T05/T16/T20 statement order: READ ONLY first, then search_path, timeouts, the zone exactly once, all before the first LOCK; no write verbs', async () => {
    const sim = simulation('America/Argentina/Buenos_Aires');
    await checkOutcomeTransaction(sim.prisma, { steps: sim.steps() });
    const sql = (sim.txs[0] as Tx).statements;
    expect(sql.slice(0, 6)).toEqual([
      'SET TRANSACTION READ ONLY',
      'SET LOCAL search_path = pg_catalog, pg_temp',
      "SET LOCAL lock_timeout = '10s'",
      "SET LOCAL statement_timeout = '120s'",
      "SET LOCAL idle_in_transaction_session_timeout = '180s'",
      "SET LOCAL timezone = 'UTC'",
    ]);
    expect(sql.filter((s) => /^SET (LOCAL )?timezone/i.test(s))).toHaveLength(1);
    expect(firstLock(sql)).toBe(6);
    expect(sql.join('\n')).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|CREATE|ALTER)\b/i);
  });

  it('T10 the setup is idempotent: replaying the recorded setup twice still yields UTC', async () => {
    const sim = simulation('Asia/Kolkata');
    await checkOutcomeTransaction(sim.prisma, { steps: sim.steps() });
    const setup = (sim.txs[0] as Tx).statements.filter((s) => s.startsWith('SET LOCAL'));
    const replay = simulation('Asia/Kolkata');
    await replay.prisma.$transaction(async (raw) => {
      const r = raw as { $executeRawUnsafe: (s: string) => Promise<number> };
      for (const s of [...setup, ...setup]) await r.$executeRawUnsafe(s);
    });
    expect((replay.txs[0] as Tx).state.TimeZone).toBe('UTC');
  });

  it('T11 a later zone change is forbidden on the protected capability, and a changed session zone is refused by the settings proof', async () => {
    const sim = simulation('UTC');
    const error = await checkOutcomeTransaction(sim.prisma, {
      steps: {
        ...sim.steps(),
        assertSettings: async (tx) => { await (tx as unknown as { $executeRawUnsafe: (s: string) => Promise<number> }).$executeRawUnsafe("SET LOCAL timezone = 'Europe/Madrid'"); },
      },
    }).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(OutcomeCheckFailure);
    expect((sim.txs[0] as Tx).statements).not.toContain("SET LOCAL timezone = 'Europe/Madrid'");
    // and if some other path did move the zone, the REAL proof refuses it
    const moved = simulation('UTC');
    const refused = await checkOutcomeTransaction(moved.prisma, {
      steps: { ...moved.steps(), assertSettings: async (tx, profile) => { (moved.txs.at(-1) as Tx).state.TimeZone = 'Europe/Madrid'; await proveSettingsOnTransaction(tx, profile as SettingsProfile); } },
    }).then(() => null, (e: unknown) => e);
    expect(refused).toBeInstanceOf(OutcomeCheckFailure);
  });

  it('T13 failure to set UTC fails closed before any read step (outcome and snapshot)', async () => {
    const out = simulation('Asia/Kolkata', { failOn: /timezone/ });
    const outError = await checkOutcomeTransaction(out.prisma, { steps: out.steps() }).then(() => null, (e: unknown) => e);
    expect(outError).toBeInstanceOf(OutcomeCheckFailure);
    expect(out.events).not.toContain('readState');
    expect(out.events).not.toContain('identity');
    const snap = simulation('Asia/Kolkata', { failOn: /timezone/ });
    const snapError = await withBackupSnapshotTransaction(snap.prisma, async () => 'x', { steps: snap.steps() }).then(() => null, (e: unknown) => e);
    expect(snapError).toBeInstanceOf(SnapshotFailure);
    expect(snap.events).not.toContain('readState');
    expect(snap.txs).toHaveLength(1);
  });

  it.each([['utc'], ['Etc/UTC'], ['GMT'], ['UTC '], ['Z'], ['']])('T14/T18 the settings proof accepts only the exact pinned zone representation (%j refused)', async (zone) => {
    const ok = simulation('UTC');
    await ok.prisma.$transaction(async (raw) => {
      (ok.txs[0] as Tx).state.search_path = 'pg_catalog, pg_temp';
      Object.assign((ok.txs[0] as Tx).state, { lock_timeout: '10000', statement_timeout: '120000', idle_in_transaction_session_timeout: '180000', transaction_isolation: 'repeatable read' });
      const tx = protectTx(raw, { id: 't', phase: 'locked', statements: [] });
      await expect(proveSettingsOnTransaction(tx, 'outcome')).resolves.toBeUndefined();
      (ok.txs[0] as Tx).state.TimeZone = zone;
      await expect(proveSettingsOnTransaction(tx, 'outcome')).rejects.toThrow('protected settings proof failed');
    });
  });

  it('T14 a settings result without a TimeZone row is refused', async () => {
    const sim = simulation('UTC');
    await sim.prisma.$transaction(async (raw) => {
      const r = raw as { $queryRawUnsafe: (s: string) => Promise<unknown[]> };
      const original = r.$queryRawUnsafe;
      r.$queryRawUnsafe = async (sql: string) => (await original(sql)).filter((row) => (row as { name: string }).name !== 'TimeZone');
      const tx = protectTx(r, { id: 't', phase: 'locked', statements: [] });
      await expect(proveSettingsOnTransaction(tx, 'outcome')).rejects.toThrow('protected settings proof failed');
    });
  });

  it('T15/T17 no role/database/global change anywhere: statements and source; the resume profile keeps its own zone line', () => {
    const source = readFileSync(new URL('../scripts/local-test-runtime.ts', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
    expect(source).not.toMatch(/ALTER\s+(ROLE|DATABASE|SYSTEM)/i);
    expect(source).not.toMatch(/PGOPTIONS/);
    expect(source).not.toMatch(/RESET\s+ALL/i);
    expect(source).toMatch(/const OWNER_SETUP = Object\.freeze\(\[[^\]]*SET LOCAL timezone = 'UTC'/);
  });

  it('T19 every read-only profile runs on the single supplied transaction: the capability still refuses transaction control', async () => {
    const sim = simulation('Asia/Kolkata');
    let escape: unknown = null;
    await checkOutcomeTransaction(sim.prisma, {
      steps: { ...sim.steps(), proveDomain: async (tx) => { try { (tx as unknown as { $transaction: () => unknown }).$transaction(); } catch (e) { escape = e; } } },
    });
    expect(String((escape as Error)?.message)).toMatch(/MJ_PROTECTED_CAPABILITY_ESCAPE/);
    expect(sim.txs).toHaveLength(1);
  });
});
