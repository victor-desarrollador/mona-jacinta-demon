// V2.3.3 R4 resume-verify finding (real PostgreSQL): seed #1 and the Company/Location backfill ran through the LOCAL_TEST Prisma client
// in the server's DEFAULT zone, so every Date the adapter bound as zone-less text was stored shifted by that zone's offset
// (+3h under America/Argentina/Buenos_Aires), and seed #2 (which pins UTC) correctly refused to rewrite it (USER_TIMESTAMP).
// The default LOCAL_TEST writers must pin and verify UTC inside their own transaction. Preregistered U01..U16.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ seedImpl: null as null | ((db: unknown) => Promise<unknown>), backfillImpl: null as null | ((db: unknown, c: unknown) => Promise<unknown>) }));
vi.mock('../prisma/seed.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../prisma/seed.js')>()),
  seedDemo: (db: unknown) => (h.seedImpl as (db: unknown) => Promise<unknown>)(db),
}));
vi.mock('../src/modules/organization/organization.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/modules/organization/organization.service.js')>()),
  backfillLocationsFromBranches: (db: unknown, c: unknown) => (h.backfillImpl as (db: unknown, c: unknown) => Promise<unknown>)(db, c),
}));

import { createLocalTestBaselineRuntime } from '../scripts/local-test-baseline.js';

const CANONICAL_MS = Date.parse('2026-01-01T00:00:00.000Z');
const OFFSET_MIN: Record<string, number> = { UTC: 0, 'America/Argentina/Buenos_Aires': -180, 'Asia/Kolkata': 330, 'UTC+01': -60 }; // POSIX "UTC+01" is one hour WEST of UTC
// A Date bound as zone-less text is interpreted in the transaction's zone.
const storedInstant = (zone: string) => CANONICAL_MS - (OFFSET_MIN[zone] as number) * 60_000;

type Observation = { zone: string; stored: number; statements: string[] };
function simulatedDb(defaultZone: string, hooks: { failSet?: boolean; ignoreSet?: boolean } = {}) {
  const observed: Observation[] = [];
  const session = { zone: defaultZone };
  const delegateThis: unknown[] = [];
  const db: Record<string, unknown> = {
    company: { findMany: function (this: unknown) { delegateThis.push(this); return Promise.resolve([]); } },
    $transaction: async (fn: unknown, options?: unknown) => {
      if (typeof fn !== 'function') throw new Error('array-form transaction reached the database');
      const local = { zone: session.zone };
      const statements: string[] = [];
      const tx = {
        $executeRawUnsafe: async (sql: string) => {
          statements.push(sql);
          if (hooks.failSet && /timezone/i.test(sql)) throw new Error('simulated SET failure');
          const m = /^SET LOCAL timezone = '([^']+)'$/.exec(sql);
          if (m && !hooks.ignoreSet) local.zone = m[1] as string;
          if (/^SET (?!LOCAL)/.test(sql)) session.zone = 'SESSION-LEVEL-SET';
          return 0;
        },
        $queryRawUnsafe: async (sql: string) => {
          statements.push(sql);
          return /current_setting\('TimeZone'\)/.test(sql) ? [{ tz: local.zone }] : [];
        },
        $queryRaw: async () => [],
      };
      void options;
      observed.push({ zone: local.zone, stored: storedInstant(local.zone), statements });
      const index = observed.length - 1;
      const result = await (fn as (tx: unknown) => Promise<unknown>)(tx);
      (observed[index] as Observation).zone = local.zone; // zone the body ran under
      (observed[index] as Observation).stored = storedInstant(local.zone);
      return result;
    },
  };
  return { db, observed, session, delegateThis };
}
const writer = (record: { calls: number }) => async (db: unknown) => {
  record.calls += 1;
  await (db as { $transaction: (fn: (tx: unknown) => Promise<unknown>, o?: unknown) => Promise<unknown> }).$transaction(async () => undefined, { maxWait: 1, timeout: 1 });
};
const runtimeFor = (db: unknown, extra: Record<string, unknown> = {}) =>
  createLocalTestBaselineRuntime({
    db: db as never, canonical: { migrations: [{ name: 'm', checksum: 'c' }] } as never, proveIdentity: async () => undefined, readFacts: async () => ({}), close: async () => undefined, ...extra,
  } as never);

beforeEach(() => {
  h.seedImpl = null;
  h.backfillImpl = null;
});

describe('LOCAL_TEST default writers pin UTC themselves', () => {
  it.each(['America/Argentina/Buenos_Aires', 'Asia/Kolkata', 'UTC+01', 'UTC'])('U01/U03/U04/U05 default seed #1 path under default zone %s stores the canonical instant', async (zone) => {
    const sim = simulatedDb(zone); const rec = { calls: 0 };
    h.seedImpl = writer(rec);
    await runtimeFor(sim.db).seedDemo();
    expect(rec.calls).toBe(1);
    expect(sim.observed).toHaveLength(1);
    expect((sim.observed[0] as Observation).zone).toBe('UTC');
    expect((sim.observed[0] as Observation).stored).toBe(CANONICAL_MS);
  });

  it.each(['America/Argentina/Buenos_Aires', 'Asia/Kolkata', 'UTC+01', 'UTC'])('U02/U04/U05 default location backfill under default zone %s runs in UTC', async (zone) => {
    const sim = simulatedDb(zone); const rec = { calls: 0 };
    h.backfillImpl = async (db) => writer(rec)(db);
    await runtimeFor(sim.db).backfillCompanyLocations();
    expect(rec.calls).toBe(1);
    expect((sim.observed[0] as Observation).zone).toBe('UTC');
    expect((sim.observed[0] as Observation).stored).toBe(CANONICAL_MS);
  });

  it('U06 an injected seed/backfill dependency receives the ORIGINAL db object, untouched', async () => {
    const sim = simulatedDb('Asia/Kolkata');
    const seen: unknown[] = [];
    const rt = runtimeFor(sim.db, { seed: async (db: unknown) => { seen.push(db); }, backfill: async (db: unknown) => { seen.push(db); } });
    await rt.seedDemo();
    await rt.backfillCompanyLocations();
    expect(seen).toEqual([sim.db, sim.db]);
    expect(seen[0]).toBe(sim.db);
    expect(sim.observed).toHaveLength(0);
  });

  it('U07 the array form of $transaction is refused on the pinned db and nothing reaches the database', async () => {
    const sim = simulatedDb('Asia/Kolkata');
    h.seedImpl = async (db) => (db as { $transaction: (x: unknown) => Promise<unknown> }).$transaction([Promise.resolve(1)]);
    await expect(runtimeFor(sim.db).seedDemo()).rejects.toThrow();
    expect(sim.observed).toHaveLength(0);
  });

  it('U08 a failing SET LOCAL stops the writer before its body runs, and the error propagates', async () => {
    const sim = simulatedDb('Asia/Kolkata', { failSet: true }); const rec = { calls: 0 }; let bodyRan = false;
    h.seedImpl = async (db) => { rec.calls += 1; await (db as { $transaction: (fn: () => Promise<void>) => Promise<unknown> }).$transaction(async () => { bodyRan = true; }); };
    await expect(runtimeFor(sim.db).seedDemo()).rejects.toThrow();
    expect(bodyRan).toBe(false);
  });

  it('U09 a SET that did not take effect (zone verification not UTC) is refused before the body', async () => {
    const sim = simulatedDb('America/Argentina/Buenos_Aires', { ignoreSet: true }); let bodyRan = false;
    h.seedImpl = async (db) => { await (db as { $transaction: (fn: () => Promise<void>) => Promise<unknown> }).$transaction(async () => { bodyRan = true; }); };
    await expect(runtimeFor(sim.db).seedDemo()).rejects.toThrow();
    expect(bodyRan).toBe(false);
  });

  it('U10/U14 the pin is transaction-local SET LOCAL only (no session SET, no role/database/global statement)', async () => {
    const sim = simulatedDb('Asia/Kolkata'); const rec = { calls: 0 };
    h.seedImpl = writer(rec);
    await runtimeFor(sim.db).seedDemo();
    const sql = (sim.observed[0] as Observation).statements;
    expect(sql).toContain("SET LOCAL timezone = 'UTC'");
    expect(sql.join('\n')).not.toMatch(/ALTER|ROLE|DATABASE|set_config|PGOPTIONS|RESET/i);
    expect(sql.filter((s) => /^SET (?!LOCAL)/.test(s))).toEqual([]);
    expect(sim.session.zone).toBe('Asia/Kolkata'); // the session default is untouched
  });

  it('U11 model delegates and other members pass through unchanged, bound to the real client', async () => {
    const sim = simulatedDb('UTC');
    let seen: unknown = null;
    h.seedImpl = async (db) => { seen = db; await (db as { company: { findMany: () => Promise<unknown> } }).company.findMany(); };
    await runtimeFor(sim.db).seedDemo();
    expect(sim.delegateThis[0]).toBe(sim.db.company);
    expect(seen).not.toBeNull();
  });

  it('U12 every transaction is pinned independently', async () => {
    const sim = simulatedDb('Asia/Kolkata');
    h.seedImpl = async (db) => {
      const d = db as { $transaction: (fn: () => Promise<void>) => Promise<unknown> };
      await d.$transaction(async () => undefined);
      await d.$transaction(async () => undefined);
    };
    await runtimeFor(sim.db).seedDemo();
    expect(sim.observed.map((o) => o.zone)).toEqual(['UTC', 'UTC']);
  });

  it('U13 an error thrown by the writer body propagates unchanged', async () => {
    const sim = simulatedDb('Asia/Kolkata');
    const boom = new Error('writer body failed');
    h.seedImpl = async (db) => { await (db as { $transaction: (fn: () => Promise<void>) => Promise<unknown> }).$transaction(async () => { throw boom; }); };
    await expect(runtimeFor(sim.db).seedDemo()).rejects.toBe(boom);
  });

  it('U16 the protected seed #2 path stays pinned by OWNER_SETUP and never goes through the writer wrapper', () => {
    const runtime = readFileSync(new URL('../scripts/local-test-runtime.ts', import.meta.url), 'utf8');
    expect(runtime).toMatch(/const OWNER_SETUP = Object\.freeze\(\[[^\]]*SET LOCAL timezone = 'UTC'/);
    expect(runtime.replace(/\/\/.*$/gm, '')).not.toMatch(/pinUtcWriterSession/);
  });
});
