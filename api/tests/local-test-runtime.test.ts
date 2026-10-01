// Task 4 RED6F: zero-database tests for scripts/local-test-runtime.ts (the object
// local-test-prepare.mjs loads and drives) and for the demo-database.ts
// proven-Prisma lifecycle helper it composes. `pg`, `@prisma/adapter-pg` and the
// generated PrismaClient are replaced with in-memory fakes: nothing here can open
// a socket. The fake LOCAL_TEST database answers the hardened identity proof and
// refuses any other SQL. Run with a no-setup Vitest config (no setupFiles, no
// globalSetup): this file needs no database.
import { createRequire } from 'node:module';
import { readFileSync, realpathSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import {
  APPLICATION_TABLES,
  OPERATIONAL_MODELS,
  SEEDED_TABLES,
  type LocalTestBaselineRuntime,
  type LocalTestBaselineRuntimeDeps,
} from '../scripts/local-test-baseline.js';
import {
  LOCAL_TEST_PROVEN_PRISMA_EXPORT,
  createLocalTestRuntime,
  type LocalTestRuntimeDeps,
  type LocalTestRuntimeInput,
  type LocalTestRuntimeSource,
  type ProvenLocalTestPrisma,
} from '../scripts/local-test-runtime.js';

type PoolRecord = {
  config: Record<string, unknown>;
  instance: unknown;
  ended: number;
  connects: number;
  released: unknown[];
};

// Under the repository config, tests/setup.ts has already evaluated
// scripts/demo-database.ts (via helpers/test-db.ts) with the real `pg`,
// @prisma/adapter-pg and PrismaClient bound; a cached module is never re-bound to
// the fakes below. Clearing the module cache before this file's own imports run
// makes every import here (static or dynamic) evaluate against the fakes.
vi.hoisted(() => {
  vi.resetModules();
});

const h = vi.hoisted(() => ({
  events: [] as string[],
  pools: [] as PoolRecord[],
  adapters: [] as Array<{ pool: unknown; options: unknown; instance: unknown }>,
  clients: [] as Array<{ options: unknown; instance: unknown; disconnects: number }>,
  // Marker row served by the fake LOCAL_TEST database, and the 1-based proof
  // (marker read) that answers a foreign marker instead; 0 = never.
  marker: '',
  foreignMarker: '',
  proofFailOn: 0,
  proofs: 0,
  adapterThrows: false,
  clientThrows: false,
  disconnectThrows: false,
  secret: '',
}));

// Hand-written catalog facts of the canonical LOCAL_TEST marker (the same shape
// tests/test-db-guard.test.ts pins to the installer).
function canonicalLocalFacts() {
  return {
    schemaOwnerIsCurrentUser: true,
    relations: [
      { name: 'database_identity', kind: 'r' },
      { name: 'database_identity_pkey', kind: 'i' },
    ],
    table: {
      kind: 'r', persistence: 'p', isPartition: false, ofType: false,
      ownerIsCurrentUser: true, rowSecurity: false, forceRowSecurity: false,
      hasSubclass: false, parents: 0, children: 0, hasRules: false, triggers: 0,
    },
    columns: [
      { name: 'singleton', type: 'boolean', notNull: true, default: 'true', generated: '', identity: '', collation: null },
      { name: 'environment', type: 'text', notNull: true, default: null, generated: '', identity: '', collation: 'default' },
      { name: 'marker_id', type: 'uuid', notNull: true, default: null, generated: '', identity: '', collation: null },
      { name: 'installed_at', type: 'timestamp with time zone', notNull: true, default: 'now()', generated: '', identity: '', collation: null },
    ],
    constraints: [
      { type: 'c', definition: "CHECK ((environment = 'local_test'::text))" },
      { type: 'c', definition: 'CHECK (singleton)' },
      { type: 'p', definition: 'PRIMARY KEY (singleton)' },
    ],
  };
}

vi.mock('pg', () => {
  class Pool {
    record: PoolRecord;
    constructor(config: Record<string, unknown>) {
      this.record = { config, instance: this, ended: 0, connects: 0, released: [] };
      h.pools.push(this.record);
      h.events.push('pool:new');
    }
    on() {
      return this;
    }
    removeListener() {
      return this;
    }
    async connect() {
      const record = this.record;
      record.connects += 1;
      h.events.push('pool:connect');
      return {
        query: async (text: string) => {
          const sql = text.trim();
          if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL|LOCK TABLE mona_local_test_guard\.)/.test(sql)) {
            h.events.push(sql.split(' ')[0]!);
            return { rows: [] };
          }
          if (sql.includes('json_build_object') && sql.includes('mona_local_test_guard')) {
            return { rows: [{ facts: canonicalLocalFacts() }] };
          }
          if (sql.includes('current_database()')) {
            return {
              rows: [{
                current_database: 'mona_local_test',
                current_user: 'mona_local_test',
                version: 'PostgreSQL 17.4 on x86_64-pc-linux-gnu',
                test_guard_exists: false,
                pilot_guard_exists: false,
              }],
            };
          }
          if (sql.includes('FROM mona_local_test_guard.database_identity')) {
            h.proofs += 1;
            h.events.push('proof:marker');
            const markerId = h.proofFailOn === h.proofs ? h.foreignMarker : h.marker;
            return { rows: [{ environment: 'local_test', marker_id: markerId, has_installed_at: true }] };
          }
          throw new Error(`fake LOCAL_TEST database refuses unexpected SQL (${h.secret})`);
        },
        release: (arg?: unknown) => {
          record.released.push(arg ?? null);
          h.events.push(arg ? 'pool:release:destroy' : 'pool:release');
        },
      };
    }
    async end() {
      this.record.ended += 1;
      h.events.push('pool:end');
      if (this.record.ended > 1) throw new Error('Called end on pool more than once');
    }
  }
  return { Pool, default: { Pool } };
});

vi.mock('@prisma/adapter-pg', () => {
  class PrismaPg {
    constructor(pool: unknown, options?: unknown) {
      if (h.adapterThrows) throw new Error(`adapter construction failed for ${h.secret}`);
      h.adapters.push({ pool, options, instance: this });
      h.events.push('PrismaPg');
    }
  }
  return { PrismaPg };
});

vi.mock('../src/generated/prisma/client.js', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  class PrismaClient {
    record: { options: unknown; instance: unknown; disconnects: number };
    constructor(options: unknown) {
      if (h.clientThrows) throw new Error(`client construction failed for ${h.secret}`);
      this.record = { options, instance: this, disconnects: 0 };
      h.clients.push(this.record);
      h.events.push('PrismaClient');
    }
    async $disconnect() {
      this.record.disconnects += 1;
      h.events.push('$disconnect');
      if (h.disconnectThrows) throw new Error(`disconnect failed for ${h.secret}`);
    }
  }
  return { ...real, PrismaClient };
});

// Captured after every static import resolved: importing constructed nothing.
const AT_IMPORT = { pools: h.pools.length, adapters: h.adapters.length, clients: h.clients.length, events: [...h.events] };

const MARKER = 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f';
const OTHER = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const SECRET = 'Rt6fLocalS3cret';
const URL_TEXT = `postgresql://mona_local_test:${SECRET}@127.0.0.1:5432/mona_local_test`;
const HOSTILE_URL = 'postgresql://postgres:hostile-canary@10.9.9.9:5432/postgres';
const OTHER_LOCAL_URL = 'postgresql://mona_local_test:other-local-pw@127.0.0.1:5432/mona_local_test';
const MIGRATIONS = Object.freeze([
  { name: '20260907015311_init', sha256: 'a'.repeat(64) },
  { name: '20260912182432_add_company_location', sha256: 'b'.repeat(64) },
  { name: '20260912191702_add_user_role_scope', sha256: 'c'.repeat(64) },
  { name: '20260922210000_d3_initial_stock_and_global_audit', sha256: 'd'.repeat(64) },
]);
const input = (): LocalTestRuntimeInput => ({
  databaseUrl: URL_TEXT,
  markerId: MARKER,
  approvedMigrations: MIGRATIONS.map((m) => ({ ...m })),
});
const SOURCE: LocalTestRuntimeSource = Object.freeze({
  LOCAL_TEST_DATABASE_URL: URL_TEXT,
  LOCAL_TEST_DATABASE_MARKER_ID: MARKER,
});
const HOSTILE_ENV: Record<string, string> = {
  DATABASE_URL: HOSTILE_URL,
  TEST_DATABASE_URL: HOSTILE_URL,
  DIRECT_URL: HOSTILE_URL,
  MONA_TEST_DATABASE_TARGET: 'test',
  LOCAL_TEST_DATABASE_URL: OTHER_LOCAL_URL,
  LOCAL_TEST_DATABASE_MARKER_ID: OTHER,
};
const OPS = ['classify', 'seedDemo', 'backfillCompanyLocations', 'verifyBaseline'] as const;
const SETTINGS_SQL =
  "SELECT current_setting('transaction_isolation') AS transaction_isolation, current_setting('transaction_read_only') AS transaction_read_only";

function expectSanitized(error: unknown) {
  expect(error, 'expected a refusal').toBeInstanceOf(Error);
  const everything = [(error as Error).message, String((error as Error).stack)].join('\n');
  for (const leak of [SECRET, URL_TEXT, 'postgresql://', HOSTILE_URL]) expect(everything).not.toContain(leak);
}
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

// --- injected fakes ---------------------------------------------------------------

function fakeResources(opts: { proveFailOn?: number[]; closeFails?: boolean } = {}) {
  const calls = { prove: 0, close: 0 };
  const prisma = { fake: 'prisma' } as unknown as PrismaClient;
  const resources: ProvenLocalTestPrisma = {
    prisma,
    proveIdentity: async () => {
      calls.prove += 1;
      if (opts.proveFailOn?.includes(calls.prove)) throw new Error(`re-proof failed on ${URL_TEXT}`);
    },
    close: async () => {
      calls.close += 1;
      if (opts.closeFails) throw new Error(`close failed on ${URL_TEXT}`);
    },
  };
  const opener = vi.fn(async (_source: LocalTestRuntimeSource) => resources);
  return { calls, prisma, resources, opener };
}

function fakeBaseline() {
  let captured: LocalTestBaselineRuntimeDeps | null = null;
  const runtime = {
    proveIdentity: vi.fn(async () => captured!.proveIdentity()),
    classify: vi.fn(async () => 'EXACT_BASELINE' as const),
    seedDemo: vi.fn(async () => undefined),
    backfillCompanyLocations: vi.fn(async () => undefined),
    verifyBaseline: vi.fn(async () => undefined),
    close: vi.fn(async () => captured!.close()),
  } satisfies LocalTestBaselineRuntime;
  const create = vi.fn((deps: LocalTestBaselineRuntimeDeps) => {
    captured = deps;
    return runtime;
  });
  return { create, runtime, deps: () => captured };
}

function emptyFacts(migrationRows: Array<{ name: string; checksum: string; finished: boolean; rolledBack: boolean }>) {
  return {
    migration: { schemaPresent: true, rows: migrationRows },
    operational: Object.fromEntries(OPERATIONAL_MODELS.map((m) => [m, 0])),
    seeded: Object.fromEntries(SEEDED_TABLES.map((t) => [t, []])),
    companies: [],
    locations: [],
    userRoleScopes: [],
  };
}
const approvedRows = () => MIGRATIONS.map((m) => ({ name: m.name, checksum: m.sha256, finished: true, rolledBack: false }));

// The future demo-database.ts helper, looked up by name so its absence is an
// assertion failure, never an import/compile failure.
async function provenPrismaHelper() {
  const ns = (await import('../scripts/demo-database.js')) as unknown as Record<string, unknown>;
  const helper = ns[LOCAL_TEST_PROVEN_PRISMA_EXPORT];
  expect(typeof helper, `demo-database.ts does not export ${LOCAL_TEST_PROVEN_PRISMA_EXPORT}`).toBe('function');
  return helper as (source: LocalTestRuntimeSource) => Promise<ProvenLocalTestPrisma>;
}

const savedEnv = { ...process.env };
beforeEach(() => {
  h.events.length = 0;
  h.pools.length = 0;
  h.adapters.length = 0;
  h.clients.length = 0;
  h.marker = MARKER;
  h.foreignMarker = OTHER;
  h.proofFailOn = 0;
  h.proofs = 0;
  h.adapterThrows = false;
  h.clientThrows = false;
  h.disconnectThrows = false;
  h.secret = URL_TEXT;
  delete process.env.PGOPTIONS;
});
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

// --- A. import / inertness -----------------------------------------------------------

describe('A. import and inertness', () => {
  it('A1 importing the runtime constructs no Pool, PrismaPg or PrismaClient and runs no SQL', () => {
    expect(AT_IMPORT).toEqual({ pools: 0, adapters: 0, clients: 0, events: [] });
  });

  it('A2 exposes the runtime factory and names the demo-database proven-Prisma helper', () => {
    expect(typeof createLocalTestRuntime).toBe('function');
    expect(LOCAL_TEST_PROVEN_PRISMA_EXPORT).toBe('openProvenLocalTestPrisma');
  });
});

// --- B. explicit inputs -------------------------------------------------------------

describe('B. explicit, copied inputs; no environment', () => {
  it('B1 construction performs no I/O: nothing opened, proven, read or composed', () => {
    const { opener } = fakeResources();
    const canonicalBaseline = vi.fn();
    const readFacts = vi.fn();
    const createBaselineRuntime = vi.fn();
    const rt = createLocalTestRuntime(input(), {
      openProvenPrisma: opener,
      canonicalBaseline,
      readFacts,
      createBaselineRuntime,
    } as unknown as LocalTestRuntimeDeps);
    expect(Object.keys(rt).sort()).toEqual(['backfillCompanyLocations', 'classify', 'close', 'proveIdentity', 'seedDemo', 'verifyBaseline']);
    for (const spy of [opener, canonicalBaseline, readFacts, createBaselineRuntime]) expect(spy).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
  });

  it('B2 malformed reviewed input is refused at construction, before any dependency is touched', () => {
    const { opener } = fakeResources();
    const bad: unknown[] = [
      null,
      {},
      { ...input(), databaseUrl: '' },
      { ...input(), databaseUrl: 42 },
      { ...input(), markerId: MARKER.toUpperCase() },
      { ...input(), markerId: undefined },
      { ...input(), approvedMigrations: [] },
      { ...input(), approvedMigrations: [{ name: MIGRATIONS[0]!.name }] },
      { ...input(), approvedMigrations: [{ name: MIGRATIONS[0]!.name, sha256: 'A'.repeat(64) }] },
      { ...input(), approvedMigrations: [{ name: MIGRATIONS[0]!.name, checksum: 'a'.repeat(64) }] },
      { ...input(), approvedMigrations: 'not a list' },
    ];
    for (const value of bad) {
      expect(() => createLocalTestRuntime(value as LocalTestRuntimeInput, { openProvenPrisma: opener }), JSON.stringify(value)).toThrow();
    }
    expect(opener).not.toHaveBeenCalled();
    expect(h.events).toEqual([]);
  });

  it('B3 the reviewed values are copied at construction: later caller mutation cannot redirect the opener', async () => {
    const { opener } = fakeResources();
    const mutable = input() as { databaseUrl: string; markerId: string; approvedMigrations: Array<{ name: string; sha256: string }> };
    const rt = createLocalTestRuntime(mutable, { openProvenPrisma: opener });
    mutable.databaseUrl = OTHER_LOCAL_URL;
    mutable.markerId = OTHER;
    mutable.approvedMigrations.reverse();
    await rt.proveIdentity();
    expect(opener).toHaveBeenCalledTimes(1);
    expect(opener.mock.calls[0]![0]).toStrictEqual(SOURCE);
  });

  it('B4 hostile ambient target variables cannot alter the opener source, which is exactly the two reviewed values', async () => {
    Object.assign(process.env, HOSTILE_ENV);
    const { opener } = fakeResources();
    const rt = createLocalTestRuntime(input(), { openProvenPrisma: opener });
    await rt.proveIdentity();
    const source = opener.mock.calls[0]![0];
    expect(source).toStrictEqual(SOURCE);
    expect(Object.isFrozen(source)).toBe(true);
  });
});

// --- C. before the first proof -------------------------------------------------------------

describe('C. nothing runs before the first successful proof', () => {
  it('C1 classify, seed, backfill and verify refuse before the first proof and open nothing', async () => {
    const { opener, calls } = fakeResources();
    const baseline = fakeBaseline();
    const rt = createLocalTestRuntime(input(), { openProvenPrisma: opener, createBaselineRuntime: baseline.create });
    for (const op of OPS) expectSanitized(await rejection(rt[op]()));
    expect(opener).not.toHaveBeenCalled();
    expect(baseline.create).not.toHaveBeenCalled();
    expect(calls).toEqual({ prove: 0, close: 0 });
  });

  it('C2 close before the first proof is a no-op that constructs nothing', async () => {
    const { opener, calls } = fakeResources();
    const rt = createLocalTestRuntime(input(), { openProvenPrisma: opener });
    await rt.close();
    await rt.close();
    expect(opener).not.toHaveBeenCalled();
    expect(calls.close).toBe(0);
  });

  it('C3 a pre-proof refusal never auto-opens: the later first proof opens exactly once', async () => {
    const { opener } = fakeResources();
    const rt = createLocalTestRuntime(input(), { openProvenPrisma: opener });
    await rejection(rt.classify());
    await rejection(rt.seedDemo());
    expect(opener).not.toHaveBeenCalled();
    await rt.proveIdentity();
    expect(opener).toHaveBeenCalledTimes(1);
  });
});

// --- D. lazy first proof -------------------------------------------------------------------

describe('D. the first proof is lazy initialization', () => {
  it('D1 the first proof opens once through the opener, whose resources are already proven (no extra re-proof)', async () => {
    const { opener, calls } = fakeResources();
    const rt = createLocalTestRuntime(input(), { openProvenPrisma: opener });
    await rt.proveIdentity();
    expect(opener).toHaveBeenCalledTimes(1);
    expect(calls).toEqual({ prove: 0, close: 0 });
  });

  it('D2 the first proof composes the baseline runtime exactly once, over the opened client', async () => {
    const { opener, prisma } = fakeResources();
    const baseline = fakeBaseline();
    const canonical = { migrations: [{ name: 'x', checksum: 'y' }] };
    const canonicalBaseline = vi.fn(() => canonical);
    const rt = createLocalTestRuntime(input(), {
      openProvenPrisma: opener,
      canonicalBaseline: canonicalBaseline as unknown as LocalTestRuntimeDeps['canonicalBaseline'],
      createBaselineRuntime: baseline.create,
    });
    await rt.proveIdentity();
    expect(canonicalBaseline).toHaveBeenCalledTimes(1);
    expect(baseline.create).toHaveBeenCalledTimes(1);
    expect(baseline.deps()!.db).toBe(prisma);
    expect(baseline.deps()!.canonical).toBe(canonical);
  });

  it('D3 after the first proof every operation delegates to the composed baseline runtime', async () => {
    const { opener } = fakeResources();
    const baseline = fakeBaseline();
    const rt = createLocalTestRuntime(input(), { openProvenPrisma: opener, createBaselineRuntime: baseline.create });
    await rt.proveIdentity();
    expect(await rt.classify()).toBe('EXACT_BASELINE');
    await rt.seedDemo();
    await rt.backfillCompanyLocations();
    await rt.verifyBaseline();
    expect(baseline.runtime.classify).toHaveBeenCalledTimes(1);
    expect(baseline.runtime.seedDemo).toHaveBeenCalledTimes(1);
    expect(baseline.runtime.backfillCompanyLocations).toHaveBeenCalledTimes(1);
    expect(baseline.runtime.verifyBaseline).toHaveBeenCalledTimes(1);
  });
});

// --- E. same pool, end to end through the default opener ------------------------------------

describe('E. one proven pool shared by proof, Prisma and re-proof (default opener, fake pg)', () => {
  it('E0 @prisma/adapter-pg and demo-database.ts resolve the same pg module (PrismaPg only adopts `instanceof pg.Pool`)', () => {
    const require = createRequire(import.meta.url);
    const fromAdapter = createRequire(require.resolve('@prisma/adapter-pg')).resolve('pg');
    const fromDemoDatabase = createRequire(new URL('../scripts/demo-database.ts', import.meta.url)).resolve('pg');
    expect(realpathSync(fromAdapter)).toBe(realpathSync(fromDemoDatabase));
  });

  const freshReader = async () => emptyFacts(approvedRows());

  it('E1 the default opener proves on one pool and hands that exact pool to PrismaPg', async () => {
    const rt = createLocalTestRuntime(input(), { readFacts: freshReader });
    await rt.proveIdentity();
    expect(h.pools).toHaveLength(1);
    expect(h.adapters).toHaveLength(1);
    expect(h.adapters[0]!.pool).toBe(h.pools[0]!.instance);
    expect((h.clients[0]!.options as { adapter?: unknown }).adapter).toBe(h.adapters[0]!.instance);
    await rt.close();
  });

  it('E2 later proofs check out the same pool again; no second pool is ever built', async () => {
    const rt = createLocalTestRuntime(input(), { readFacts: freshReader });
    await rt.proveIdentity();
    await rt.proveIdentity();
    await rt.proveIdentity();
    expect(h.pools).toHaveLength(1);
    expect(h.pools[0]!.connects).toBe(3);
    expect(h.proofs).toBe(3);
    expect(h.adapters).toHaveLength(1);
    await rt.close();
  });

  it('E3 close disconnects Prisma, then ends that pool, exactly once each', async () => {
    const rt = createLocalTestRuntime(input(), { readFacts: freshReader });
    await rt.proveIdentity();
    await rt.close();
    await rt.close();
    expect(h.clients[0]!.disconnects).toBe(1);
    expect(h.pools[0]!.ended).toBe(1);
    expect(h.events.indexOf('$disconnect')).toBeLessThan(h.events.indexOf('pool:end'));
  });
});

// --- F. baseline composition ------------------------------------------------------------------

describe('F. composition reuses the GREEN baseline pieces', () => {
  it('F1 the composed deps: db is the proven client, proofs re-prove on it, facts are read from it, default seed/backfill kept', async () => {
    const { opener, prisma, calls } = fakeResources();
    const baseline = fakeBaseline();
    const readFacts = vi.fn(async (_db: unknown) => ({}));
    const rt = createLocalTestRuntime(input(), { openProvenPrisma: opener, createBaselineRuntime: baseline.create, readFacts });
    await rt.proveIdentity();
    expect(baseline.create).toHaveBeenCalledTimes(1);
    const deps = baseline.deps()!;
    expect(deps.db).toBe(prisma);
    expect(Object.keys(deps)).not.toContain('seed');
    expect(Object.keys(deps)).not.toContain('backfill');
    await deps.proveIdentity();
    expect(calls.prove).toBe(1);
    await deps.readFacts(deps.db);
    expect(readFacts).toHaveBeenCalledTimes(1);
    expect(readFacts.mock.calls[0]![0]).toBe(prisma);
  });

  it('F2 the real canonical + baseline runtime classify MIGRATED_EMPTY when history equals the approved sha256 pins', async () => {
    const { opener } = fakeResources();
    const rt = createLocalTestRuntime(input(), { openProvenPrisma: opener, readFacts: async () => emptyFacts(approvedRows()) });
    await rt.proveIdentity();
    expect(await rt.classify()).toBe('MIGRATED_EMPTY');
  });

  it('F3 a history checksum that differs from the approved sha256 classifies MIGRATION_DRIFT', async () => {
    const { opener } = fakeResources();
    const rows = approvedRows();
    rows[2] = { ...rows[2]!, checksum: 'e'.repeat(64) };
    const rt = createLocalTestRuntime(input(), { openProvenPrisma: opener, readFacts: async () => emptyFacts(rows) });
    await rt.proveIdentity();
    expect(await rt.classify()).toBe('MIGRATION_DRIFT');
  });

  it('F4 the default facts reader reads through the same proven client (fresh database → FRESH)', async () => {
    const transactions: unknown[] = [];
    const presence = Object.fromEntries([...APPLICATION_TABLES, '_prisma_migrations'].map((t) => [t, false]));
    const prisma = {
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        transactions.push(prisma);
        return fn({
          // A server honouring the requested snapshot; any other SQL is refused.
          $queryRaw: async (strings: TemplateStringsArray) => {
            const sql = strings.join('?');
            if (sql.includes('to_regclass')) return [presence];
            if (sql === "SELECT set_config('transaction_read_only', 'on', true)") return [{ set_config: 'on' }];
            if (sql === SETTINGS_SQL) return [{ transaction_isolation: 'repeatable read', transaction_read_only: 'on' }];
            throw new Error('fake LOCAL_TEST database refuses unexpected SQL');
          },
        });
      },
    } as unknown as PrismaClient;
    const opener = vi.fn(async () => ({ prisma, proveIdentity: async () => undefined, close: async () => undefined }));
    const rt = createLocalTestRuntime(input(), { openProvenPrisma: opener });
    await rt.proveIdentity();
    expect(await rt.classify()).toBe('FRESH');
    expect(transactions).toEqual([prisma]);
  });
});

// --- G. repeated proofs ---------------------------------------------------------------------------

describe('G. later proofs', () => {
  it('G1 every later proof re-proves through the opened resources; the opener is never called again', async () => {
    const { opener, calls } = fakeResources();
    const rt = createLocalTestRuntime(input(), { openProvenPrisma: opener, readFacts: async () => ({}) });
    await rt.proveIdentity();
    await rt.proveIdentity();
    await rt.proveIdentity();
    expect(opener).toHaveBeenCalledTimes(1);
    expect(calls.prove).toBe(2);
  });
});

// --- H. failure containment ---------------------------------------------------------------------------

describe('H. failure containment', () => {
  it('H1 an opener failure is sanitized and latched: no retry, every operation refuses, close is a no-op', async () => {
    const opener = vi.fn(async () => {
      throw new Error(`could not open ${URL_TEXT}`);
    });
    const rt = createLocalTestRuntime(input(), { openProvenPrisma: opener });
    expectSanitized(await rejection(rt.proveIdentity()));
    expectSanitized(await rejection(rt.proveIdentity()));
    for (const op of OPS) expectSanitized(await rejection(rt[op]()));
    await rt.close();
    expect(opener).toHaveBeenCalledTimes(1);
  });

  it('H2 a canonical-descriptor failure after opening closes the opened resources once and latches', async () => {
    const { opener, calls } = fakeResources();
    const canonicalBaseline = vi.fn(() => {
      throw new Error(`descriptor failed for ${URL_TEXT}`);
    });
    const rt = createLocalTestRuntime(input(), {
      openProvenPrisma: opener,
      canonicalBaseline: canonicalBaseline as unknown as LocalTestRuntimeDeps['canonicalBaseline'],
    });
    expectSanitized(await rejection(rt.proveIdentity()));
    expect(calls.close).toBe(1);
    expectSanitized(await rejection(rt.proveIdentity()));
    await rt.close();
    expect(opener).toHaveBeenCalledTimes(1);
    expect(calls.close).toBe(1);
  });

  it('H3 a baseline-runtime composition failure after opening closes the opened resources once and latches', async () => {
    const { opener, calls } = fakeResources();
    const createBaselineRuntime = vi.fn(() => {
      throw new Error(`composition failed for ${URL_TEXT}`);
    });
    const rt = createLocalTestRuntime(input(), { openProvenPrisma: opener, createBaselineRuntime });
    expectSanitized(await rejection(rt.proveIdentity()));
    expect(createBaselineRuntime).toHaveBeenCalledTimes(1);
    expect(calls.close).toBe(1);
    for (const op of OPS) await rejection(rt[op]());
    await rt.close();
    expect(calls.close).toBe(1);
  });

  it('H4 a failed later proof is sanitized and fail-closed: no mutation can follow it', async () => {
    const { opener } = fakeResources({ proveFailOn: [1] });
    const baseline = fakeBaseline();
    const rt = createLocalTestRuntime(input(), { openProvenPrisma: opener, createBaselineRuntime: baseline.create });
    await rt.proveIdentity();
    expectSanitized(await rejection(rt.proveIdentity()));
    expect(baseline.runtime.proveIdentity).toHaveBeenCalledTimes(1);
    await rejection(rt.seedDemo());
    await rejection(rt.backfillCompanyLocations());
    expect(baseline.runtime.seedDemo).not.toHaveBeenCalled();
    expect(baseline.runtime.backfillCompanyLocations).not.toHaveBeenCalled();
  });
});

// --- I. close ownership ------------------------------------------------------------------------------------

describe('I. the runtime owns and releases what it opened', () => {
  it('I1 close after opening releases the resources exactly once, however often it is called', async () => {
    const { opener, calls } = fakeResources();
    const rt = createLocalTestRuntime(input(), { openProvenPrisma: opener });
    await rt.proveIdentity();
    await Promise.all([rt.close(), rt.close()]);
    await rt.close();
    expect(calls.close).toBe(1);
  });

  it('I2 after composition the resources are still released exactly once in total', async () => {
    const { opener, calls } = fakeResources();
    const baseline = fakeBaseline();
    const rt = createLocalTestRuntime(input(), { openProvenPrisma: opener, createBaselineRuntime: baseline.create });
    await rt.proveIdentity();
    expect(baseline.create).toHaveBeenCalledTimes(1);
    await rt.close();
    await rt.close();
    expect(calls.close).toBe(1);
  });

  it('I3 a close failure after otherwise-successful work is reported (sanitized), never swallowed', async () => {
    const { opener } = fakeResources({ closeFails: true });
    const rt = createLocalTestRuntime(input(), { openProvenPrisma: opener });
    await rt.proveIdentity();
    expectSanitized(await rejection(rt.close()));
  });
});

// --- J. use after close ---------------------------------------------------------------------------------------

describe('J. nothing runs or reopens after close', () => {
  it('J1 after close every operation refuses, the opener is not called again and the resources are untouched', async () => {
    const { opener, calls } = fakeResources();
    const rt = createLocalTestRuntime(input(), { openProvenPrisma: opener });
    await rt.proveIdentity();
    await rt.close();
    for (const op of ['proveIdentity', ...OPS] as const) {
      const error = await rejection(rt[op]());
      expectSanitized(error);
      expect((error as Error).message).toMatch(/closed/);
    }
    expect(opener).toHaveBeenCalledTimes(1);
    expect(calls).toEqual({ prove: 0, close: 1 });
  });
});

// --- K. approved migrations ---------------------------------------------------------------------------------------

describe('K. approved migrations come only from the reviewed input', () => {
  it('K1 the canonical descriptor receives exactly {name, checksum = sha256} in the reviewed order', async () => {
    const { opener } = fakeResources();
    const canonicalBaseline = vi.fn(() => ({ migrations: [] }));
    const rt = createLocalTestRuntime(input(), {
      openProvenPrisma: opener,
      canonicalBaseline: canonicalBaseline as unknown as LocalTestRuntimeDeps['canonicalBaseline'],
      createBaselineRuntime: fakeBaseline().create,
    });
    await rt.proveIdentity();
    expect(canonicalBaseline).toHaveBeenCalledTimes(1);
    expect((canonicalBaseline.mock.calls as unknown[][])[0]![0]).toStrictEqual(
      MIGRATIONS.map((m) => ({ name: m.name, checksum: m.sha256 })),
    );
  });

  it('K2 reordering or editing the caller migration list after construction changes nothing', async () => {
    const { opener } = fakeResources();
    const canonicalBaseline = vi.fn(() => ({ migrations: [] }));
    const mutable = input() as { databaseUrl: string; markerId: string; approvedMigrations: Array<{ name: string; sha256: string }> };
    const rt = createLocalTestRuntime(mutable, {
      openProvenPrisma: opener,
      canonicalBaseline: canonicalBaseline as unknown as LocalTestRuntimeDeps['canonicalBaseline'],
      createBaselineRuntime: fakeBaseline().create,
    });
    mutable.approvedMigrations.reverse();
    mutable.approvedMigrations[0]!.sha256 = 'f'.repeat(64);
    mutable.approvedMigrations.push({ name: '20990101000000_extra', sha256: '0'.repeat(64) });
    await rt.proveIdentity();
    expect(canonicalBaseline).toHaveBeenCalledTimes(1);
    expect((canonicalBaseline.mock.calls as unknown[][])[0]![0]).toStrictEqual(
      MIGRATIONS.map((m) => ({ name: m.name, checksum: m.sha256 })),
    );
  });
});

// --- L. static boundaries ---------------------------------------------------------------------------------------

describe('L. static boundaries', () => {
  const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
  const specifiers = (source: string) =>
    [...source.matchAll(/\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1] ?? m[2]);

  it('L1 the runtime reads no environment/filesystem, builds no pg/Prisma resource, imports no tests or marker tool', () => {
    const source = read('../scripts/local-test-runtime.ts');
    expect(source).not.toMatch(/process\.env/);
    expect(source).not.toMatch(/\bnew\s+(Pool|PrismaClient|PrismaPg|Client)\b/);
    expect(source).not.toMatch(/\bprocess\.(on|once)\(|\bsetTimeout\(|\bsetInterval\(/);
    expect(source).not.toMatch(/readFileSync|createHash|\brequire\s*\(|createRequire/);
    expect(new Set(specifiers(source))).toEqual(
      new Set(['../src/generated/prisma/client.js', './demo-database.js', './local-test-baseline.js']),
    );
    expect(source).not.toMatch(/tests\/|local-test-marker|scripts\/database/);
  });

  it('L2 the baseline module stays pure: no pg, no adapter, no PrismaClient construction, no environment', () => {
    const source = read('../scripts/local-test-baseline.ts');
    for (const forbidden of ['pg', '@prisma/adapter-pg', './demo-database.js', './local-test-runtime.js']) {
      expect(specifiers(source)).not.toContain(forbidden);
    }
    expect(source).not.toMatch(/\bnew\s+(Pool|PrismaClient|PrismaPg)\b|process\.env/);
  });
});

// --- M. future demo-database.ts proven-Prisma helper ----------------------------------------------------------------

describe('M. demo-database.ts openProvenLocalTestPrisma (future helper, fake pg)', () => {
  it('M1 demo-database.ts exports the ungated LOCAL_TEST proven-Prisma helper', async () => {
    await provenPrismaHelper();
  });

  it('M2 one guarded pool, proof first, proof client released, then PrismaPg on that exact pool and PrismaClient on that adapter', async () => {
    const open = await provenPrismaHelper();
    const opened = await open(SOURCE);
    expect(h.pools).toHaveLength(1);
    const pool = h.pools[0]!;
    expect(pool.config.connectionString).toBe(URL_TEXT);
    expect((pool.config.Client as { name?: string }).name).toBe('LocalTestClient');
    expect(pool.config.max).toBe(1);
    expect(pool.config.ssl).toBe(false);
    expect(h.adapters).toHaveLength(1);
    expect(h.adapters[0]!.pool).toBe(pool.instance);
    expect((h.adapters[0]!.options as { disposeExternalPool?: unknown } | undefined)?.disposeExternalPool ?? false).toBe(false);
    expect(h.clients).toHaveLength(1);
    expect((h.clients[0]!.options as { adapter?: unknown }).adapter).toBe(h.adapters[0]!.instance);
    expect(opened.prisma).toBe(h.clients[0]!.instance);
    const at = (event: string) => h.events.indexOf(event);
    expect(at('proof:marker')).toBeGreaterThan(-1);
    expect(at('proof:marker')).toBeLessThan(at('pool:release'));
    expect(at('pool:release')).toBeLessThan(at('PrismaPg'));
    expect(at('PrismaPg')).toBeLessThan(at('PrismaClient'));
    expect(pool.released).toEqual([null]);
    expect(pool.ended).toBe(0);
  });

  it('M3 the returned surface is exactly {prisma, proveIdentity, close}: the pool is never handed out', async () => {
    const open = await provenPrismaHelper();
    const opened = await open(SOURCE);
    expect(Object.keys(opened).sort()).toEqual(['close', 'prisma', 'proveIdentity']);
  });

  it('M4 re-proof checks out the same pool, proves, and releases the client; no new pool or adapter', async () => {
    const open = await provenPrismaHelper();
    const opened = await open(SOURCE);
    await opened.proveIdentity();
    await opened.proveIdentity();
    expect(h.pools).toHaveLength(1);
    expect(h.pools[0]!.connects).toBe(3);
    expect(h.pools[0]!.released).toEqual([null, null, null]);
    expect(h.proofs).toBe(3);
    expect(h.adapters).toHaveLength(1);
    expect(h.pools[0]!.ended).toBe(0);
  });

  it('M5 a failed re-proof is sanitized, destroys its client and leaves the pool for the owner to close', async () => {
    const open = await provenPrismaHelper();
    const opened = await open(SOURCE);
    h.proofFailOn = 2;
    expectSanitized(await rejection(opened.proveIdentity()));
    expect(h.pools[0]!.released).toEqual([null, true]);
    expect(h.pools[0]!.ended).toBe(0);
    await opened.close();
    expect(h.pools[0]!.ended).toBe(1);
  });

  it('M6 close disconnects Prisma, then ends the pool, each exactly once', async () => {
    const open = await provenPrismaHelper();
    const opened = await open(SOURCE);
    await opened.close();
    await opened.close();
    expect(h.clients[0]!.disconnects).toBe(1);
    expect(h.pools[0]!.ended).toBe(1);
    expect(h.events.indexOf('$disconnect')).toBeLessThan(h.events.indexOf('pool:end'));
  });

  it('M7 a Prisma disconnect failure still ends the pool, and close rejects', async () => {
    const open = await provenPrismaHelper();
    const opened = await open(SOURCE);
    h.disconnectThrows = true;
    await rejection(opened.close());
    expect(h.pools[0]!.ended).toBe(1);
  });

  it('M8 a failed initial proof ends the pool and builds no adapter or client', async () => {
    const open = await provenPrismaHelper();
    h.proofFailOn = 1;
    expectSanitized(await rejection(open(SOURCE)));
    expect(h.pools).toHaveLength(1);
    expect(h.pools[0]!.ended).toBe(1);
    expect(h.adapters).toHaveLength(0);
    expect(h.clients).toHaveLength(0);
  });

  it('M9 a PrismaPg construction failure ends the proven pool; no client is built; sanitized', async () => {
    const open = await provenPrismaHelper();
    h.adapterThrows = true;
    expectSanitized(await rejection(open(SOURCE)));
    expect(h.pools[0]!.ended).toBe(1);
    expect(h.clients).toHaveLength(0);
  });

  it('M10 a PrismaClient construction failure ends the proven pool; sanitized', async () => {
    const open = await provenPrismaHelper();
    h.clientThrows = true;
    expectSanitized(await rejection(open(SOURCE)));
    expect(h.pools[0]!.ended).toBe(1);
  });

  it('M11 the helper is not NODE_ENV-gated (prepare runs outside automated tests)', async () => {
    const open = await provenPrismaHelper();
    process.env.NODE_ENV = 'production';
    const opened = await open(SOURCE);
    expect(h.pools).toHaveLength(1);
    await opened.close();
  });

  it('M12 only the explicit source selects the target: hostile ambient variables cannot redirect the pool', async () => {
    const open = await provenPrismaHelper();
    Object.assign(process.env, HOSTILE_ENV);
    const opened = await open(SOURCE);
    expect(h.pools.map((p) => p.config.connectionString)).toEqual([URL_TEXT]);
    await opened.close();
  });

  it('M13 PGOPTIONS in the explicit source refuses before any pool is built', async () => {
    const open = await provenPrismaHelper();
    expectSanitized(await rejection(open({ ...SOURCE, PGOPTIONS: '-c search_path=public' } as LocalTestRuntimeSource)));
    expect(h.pools).toHaveLength(0);
  });
});
