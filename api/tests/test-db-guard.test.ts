// TEST-H1: zero-database tests for the TEST identity guard. `pg` and the
// `.env.development` read are replaced with in-memory fakes, so nothing here can
// open a socket: every "database" below is a scripted answer keyed by URL.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Facts = Record<string, unknown> | null;
type FakeDb = {
  schemaExists: boolean;
  tableExists: boolean;
  facts: Facts;
  rows: Array<Record<string, unknown>>;
  username: string;
  address: string;
  failOn?: { sql: string; error: unknown };
  connectError?: unknown;
};
type FakePoolRecord = {
  config: { connectionString?: string };
  ended: number;
  released: unknown[];
  queries: string[];
};

type FsModule = typeof import('node:fs');
type PrismaAdapterPgModule = typeof import('@prisma/adapter-pg');
type DotenvModule = typeof import('dotenv');

const state = vi.hoisted(() => ({
  envText: '',
  databases: new Map<string, unknown>(),
  pools: [] as unknown[],
  endError: null as unknown,
  adapterArgs: [] as unknown[][],
}));

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<FsModule>();
  const readFileSync = ((path: unknown, options?: unknown) => {
    if (String(path).endsWith('.env.development')) {
      return options ? state.envText : Buffer.from(state.envText);
    }
    return (real.readFileSync as (p: unknown, o?: unknown) => unknown)(path, options);
  }) as typeof real.readFileSync;
  return { ...real, default: { ...real, readFileSync }, readFileSync };
});

vi.mock('pg', () => {
  class Pool {
    record: FakePoolRecord;
    constructor(config: { connectionString?: string }) {
      this.record = { config, ended: 0, released: [], queries: [] };
      state.pools.push(this.record);
    }
    on() {
      return this;
    }
    async connect() {
      const db = state.databases.get(this.record.config.connectionString ?? '') as FakeDb | undefined;
      if (!db) throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
      if (db.connectError !== undefined) throw db.connectError;
      const record = this.record;
      return {
        query: async (text: string) => respond(db, record, text),
        release: (arg?: unknown) => {
          record.released.push(arg ?? null);
        },
      };
    }
    async query(text: string) {
      const db = state.databases.get(this.record.config.connectionString ?? '') as FakeDb;
      return respond(db, this.record, text);
    }
    async end() {
      this.record.ended += 1;
      if (this.record.ended > 1) throw new Error('Called end on pool more than once');
      if (state.endError !== null) throw state.endError;
    }
  }
  return { Pool, default: { Pool } };
});

vi.mock('@prisma/adapter-pg', async (importOriginal) => {
  const real = await importOriginal<PrismaAdapterPgModule>();
  const PrismaPg = function (this: unknown, ...args: unknown[]) {
    state.adapterArgs.push(args);
    return new (real.PrismaPg as unknown as new (...a: unknown[]) => object)(...args);
  };
  return { PrismaPg };
});

// tests/setup.ts loads .env.development through dotenv.config; serve the fake file.
vi.mock('dotenv', async (importOriginal) => {
  const real = await importOriginal<DotenvModule>();
  const config = (() => {
    Object.assign(process.env, real.parse(state.envText));
    return { parsed: {} };
  }) as unknown as typeof real.config;
  return { ...real, default: { ...real, config }, config };
});

function respond(db: FakeDb, record: FakePoolRecord, text: string) {
  record.queries.push(text);
  if (db.failOn && text.includes(db.failOn.sql)) throw db.failOn.error;
  if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/.test(text.trim())) return { rows: [] };
  if (text.includes('current_database()')) {
    // Only the pre-TEST-H1 comparative guard asks this.
    return {
      rows: [{ db: 'postgres', username: db.username, address: db.address, port: 5432, version: 'PostgreSQL 17.4' }],
    };
  }
  if (text.includes('to_regnamespace')) {
    return { rows: [{ schema_exists: db.schemaExists, table_exists: db.tableExists }] };
  }
  if (text.startsWith('LOCK TABLE')) {
    if (!db.tableExists) throw Object.assign(new Error('relation does not exist'), { code: '42P01' });
    return { rows: [] };
  }
  if (text.includes('json_build_object')) return { rows: [{ facts: db.facts }] };
  if (text.includes('FROM mona_test_guard.database_identity')) return { rows: db.rows };
  if (text.startsWith('TRUNCATE')) throw new Error('fake pool refuses destructive SQL');
  return { rows: [] };
}

const MARKER = '1aa8a898-33c5-46c8-8c71-560ee5f6cffd';
const OTHER_MARKER = '2bb8a898-33c5-46c8-8c71-560ee5f6cffd';
const TEST_SECRET = 'tEsT-SeCrEt-PW';
const DEV_SECRET = 'dEv-SeCrEt-PW';
const TEST_URL = `postgresql://postgres.testrefaaaaaaaaaaaaa:${TEST_SECRET}@aws-0-test.pooler.supabase.com:5432/postgres`;
const DEV_URL = `postgresql://postgres.devrefbbbbbbbbbbbbbb:${DEV_SECRET}@aws-0-dev.pooler.supabase.com:5432/postgres`;
const DEMO_URL = `postgresql://postgres.demorefccccccccccccc:dEmO-SeCrEt-PW@aws-0-demo.pooler.supabase.com:5432/postgres`;
const GENERIC = 'Test database safety/connection check failed; no destructive write authorized';

const canonicalFacts = () => ({
  schemaOwnerIsCurrentUser: true,
  relations: [
    { name: 'database_identity', kind: 'r' },
    { name: 'database_identity_pkey', kind: 'i' },
  ],
  table: {
    kind: 'r',
    ownerIsCurrentUser: true,
    rowSecurity: false,
    forceRowSecurity: false,
    hasSubclass: false,
    parents: 0 as unknown,
    children: 0 as unknown,
    hasRules: false,
    triggers: 0,
  },
  columns: [
    { name: 'singleton', type: 'boolean', notNull: true, default: 'true', generated: '', identity: '' },
    { name: 'environment', type: 'text', notNull: true, default: null, generated: '', identity: '' },
    { name: 'marker_id', type: 'uuid', notNull: true, default: null, generated: '', identity: '' },
    { name: 'installed_at', type: 'timestamp with time zone', notNull: true, default: 'now()', generated: '', identity: '' },
  ],
  constraints: [
    { type: 'c', definition: "CHECK ((environment = 'test'::text))" },
    { type: 'c', definition: 'CHECK (singleton)' },
    { type: 'p', definition: 'PRIMARY KEY (singleton)' },
  ],
});
const canonicalRow = () => ({ environment: 'test', marker_id: MARKER, has_installed_at: true });

function markedTest(overrides: Partial<FakeDb> = {}): FakeDb {
  return {
    schemaExists: true,
    tableExists: true,
    facts: canonicalFacts(),
    rows: [canonicalRow()],
    username: 'postgres.testrefaaaaaaaaaaaaa',
    address: '10.0.0.2',
    ...overrides,
  };
}
function unmarked(username: string, address: string): FakeDb {
  return { schemaExists: false, tableExists: false, facts: null, rows: [], username, address };
}
function env(lines: Record<string, string | undefined>) {
  state.envText = Object.entries(lines)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}
const standardEnv = (extra: Record<string, string | undefined> = {}) =>
  env({ DATABASE_URL: DEV_URL, TEST_DATABASE_URL: TEST_URL, TEST_DATABASE_MARKER_ID: MARKER, ...extra });
const pools = () => state.pools as FakePoolRecord[];

async function guard() {
  const { assertTestDatabaseIsolation } = await import('./helpers/test-db.js');
  return assertTestDatabaseIsolation;
}
async function failure(action: () => Promise<unknown>) {
  try {
    await action();
  } catch (error) {
    return error as Error & Record<string, unknown>;
  }
  throw new Error('expected the guard to refuse');
}
function expectSanitized(error: Error & Record<string, unknown>) {
  const everything = [
    error.message,
    String(error.stack),
    JSON.stringify(error),
    JSON.stringify(Object.getOwnPropertyNames(error).map((k) => String(error[k]))),
  ].join('\n');
  for (const secret of [
    TEST_SECRET,
    DEV_SECRET,
    'testrefaaaaaaaaaaaaa',
    'devrefbbbbbbbbbbbbbb',
    'pooler.supabase.com',
    'aws-0-',
    '5432',
    'postgresql://',
    '10.0.0.',
    'ENOTFOUND',
  ].filter((s) => !(s === 'ENOTFOUND' && error.code === 'ENOTFOUND'))) {
    expect(everything).not.toContain(secret);
  }
  expect(error.message.startsWith(GENERIC)).toBe(true);
  expect(error.cause).toBeUndefined();
  expect(error.target).toBe('TEST');
  expect(typeof error.elapsedMs).toBe('number');
}

beforeEach(() => {
  vi.resetModules();
  state.databases.clear();
  state.pools.length = 0;
  state.adapterArgs.length = 0;
  state.endError = null;
  process.env.NODE_ENV = 'test';
  state.databases.set(TEST_URL, markedTest());
  state.databases.set(DEV_URL, unmarked('postgres.devrefbbbbbbbbbbbbbb', '10.0.0.1'));
  state.databases.set(DEMO_URL, unmarked('postgres.demorefccccccccccccc', '10.0.0.3'));
  standardEnv();
});
afterEach(() => {
  delete process.env.TEST_DATABASE_URL;
});

describe('TEST identity comes from the TEST marker alone', () => {
  it('accepts the canonical marker and never builds a pool for DATABASE_URL', async () => {
    await (await guard())();
    expect(pools().length).toBeGreaterThan(0);
    for (const pool of pools()) expect(pool.config.connectionString).toBe(TEST_URL);
    expect(pools().every((pool) => pool.ended === 1)).toBe(true);
  });

  it('does not need DATABASE_URL at all', async () => {
    standardEnv({ DATABASE_URL: undefined });
    await expect((await guard())()).resolves.toBeUndefined();
  });

  it.each([
    ['malformed', 'not a url'],
    ['equal to TEST (poisoned)', TEST_URL],
    ['pointing at an unreachable host', 'postgresql://x:y@unreachable.invalid:5432/postgres'],
  ])('ignores a DATABASE_URL that is %s', async (_label, value) => {
    standardEnv({ DATABASE_URL: value });
    await expect((await guard())()).resolves.toBeUndefined();
    for (const pool of pools()) expect(pool.config.connectionString).toBe(TEST_URL);
  });

  it('ignores a shell TEST_DATABASE_URL: the ignored repository file is authoritative', async () => {
    process.env.TEST_DATABASE_URL = DEV_URL;
    await (await guard())();
    for (const pool of pools()) expect(pool.config.connectionString).toBe(TEST_URL);
  });

  it('reads the marker inside one read-only transaction with a pinned search_path', async () => {
    await (await guard())();
    const queries = pools()[0]!.queries.map((q) => q.trim());
    expect(queries[0]).toBe('BEGIN READ ONLY');
    expect(queries[1]).toBe('SET LOCAL search_path TO pg_catalog, pg_temp');
    expect(queries.some((q) => q === 'LOCK TABLE mona_test_guard.database_identity IN ACCESS SHARE MODE')).toBe(true);
    expect(queries.at(-1)).toBe('COMMIT');
    expect(queries.join('\n')).not.toMatch(/INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE/);
  });
});

describe('wrong or unproven databases fail closed', () => {
  it.each<[string, () => void, string]>([
    ['TEST_DATABASE_URL points at DEV', () => standardEnv({ TEST_DATABASE_URL: DEV_URL }), 'identity'],
    ['TEST_DATABASE_URL points at DEMO', () => standardEnv({ TEST_DATABASE_URL: DEMO_URL }), 'identity'],
    ['marker schema absent', () => state.databases.set(TEST_URL, markedTest({ schemaExists: false, tableExists: false })), 'identity'],
    ['marker table absent', () => state.databases.set(TEST_URL, markedTest({ tableExists: false })), 'identity'],
    ['zero marker rows', () => state.databases.set(TEST_URL, markedTest({ rows: [] })), 'identity'],
    ['two marker rows', () => state.databases.set(TEST_URL, markedTest({ rows: [canonicalRow(), canonicalRow()] })), 'identity'],
    ['environment is not test', () => state.databases.set(TEST_URL, markedTest({ rows: [{ ...canonicalRow(), environment: 'dev' }] })), 'identity'],
    ['installed_at missing', () => state.databases.set(TEST_URL, markedTest({ rows: [{ ...canonicalRow(), has_installed_at: false }] })), 'identity'],
    ['marker UUID differs from the pinned id', () => standardEnv({ TEST_DATABASE_MARKER_ID: OTHER_MARKER }), 'mismatch'],
    ['pinned marker id missing', () => standardEnv({ TEST_DATABASE_MARKER_ID: undefined }), 'config'],
    ['pinned marker id malformed', () => standardEnv({ TEST_DATABASE_MARKER_ID: 'not-a-uuid' }), 'config'],
    ['pinned marker id uppercase', () => standardEnv({ TEST_DATABASE_MARKER_ID: MARKER.toUpperCase() }), 'config'],
    ['pinned marker id padded', () => standardEnv({ TEST_DATABASE_MARKER_ID: `" ${MARKER} "` }), 'config'],
    ['TEST_DATABASE_URL missing', () => standardEnv({ TEST_DATABASE_URL: undefined }), 'config'],
    ['TEST_DATABASE_URL malformed', () => standardEnv({ TEST_DATABASE_URL: 'postgres://' }), 'config'],
    ['TEST_DATABASE_URL with a TLS override', () => standardEnv({ TEST_DATABASE_URL: `${TEST_URL}?sslmode=disable` }), 'config'],
  ])('%s', async (_label, arrange, phase) => {
    arrange();
    const error = await failure(await guard());
    expect(error.phase).toBe(phase);
    expectSanitized(error);
    for (const pool of pools()) expect(pool.ended).toBe(1);
    if (phase === 'config') expect(pools()).toHaveLength(0);
  });

  it('never falls back to DATABASE_URL when the TEST configuration is broken', async () => {
    standardEnv({ TEST_DATABASE_URL: undefined });
    await failure(await guard());
    expect(pools()).toHaveLength(0);
  });
});

describe('a matching row inside a non-canonical marker structure is refused', () => {
  const mutate = (change: (facts: ReturnType<typeof canonicalFacts>) => unknown) => () => {
    const facts = canonicalFacts();
    change(facts);
    state.databases.set(TEST_URL, markedTest({ facts }));
  };
  it.each<[string, () => void]>([
    ['arbitrary two-column table', mutate((f) => (f.columns = f.columns.slice(1, 3)))],
    ['extra column', mutate((f) => f.columns.push({ name: 'note', type: 'text', notNull: false, default: null, generated: '', identity: '' }))],
    ['environment column is varchar', mutate((f) => (f.columns[1]!.type = 'character varying'))],
    ['marker_id column is text', mutate((f) => (f.columns[2]!.type = 'text'))],
    ['marker_id nullable', mutate((f) => (f.columns[2]!.notNull = false))],
    ['marker_id generated', mutate((f) => (f.columns[2]!.generated = 's'))],
    ['missing environment CHECK', mutate((f) => (f.constraints = f.constraints.slice(1)))],
    ['CHECK through a shadow operator', mutate((f) => (f.constraints[0]!.definition = "CHECK ((environment OPERATOR(public.=) 'test'::text))"))],
    ['no singleton primary key', mutate((f) => (f.constraints = f.constraints.slice(0, 2)))],
    ['a view instead of a table', mutate((f) => (f.table.kind = 'v'))],
    ['row-level security enabled', mutate((f) => (f.table.rowSecurity = true))],
    ['forced row-level security', mutate((f) => (f.table.forceRowSecurity = true))],
    ['a rewrite rule', mutate((f) => (f.table.hasRules = true))],
    ['a trigger', mutate((f) => (f.table.triggers = 1))],
    ['inheritance children', mutate((f) => (f.table.hasSubclass = true))],
    // H1.3: neither a parent nor a child in pg_inherits (INHERITS or partitions).
    ['an inheritance parent outside the marker schema', mutate((f) => (f.table.parents = 1))],
    ['multiple inheritance parents', mutate((f) => (f.table.parents = 2))],
    ['a partition of a partitioned parent', mutate((f) => (f.table.parents = 1))],
    ['a child while relhassubclass is stale false', mutate((f) => (f.table.children = 1))],
    ['both a parent and a child', mutate((f) => ((f.table.parents = 1), (f.table.children = 1), (f.table.hasSubclass = true)))],
    ['parents fact missing', mutate((f) => delete (f.table as Record<string, unknown>).parents)],
    ['parents fact is a string', mutate((f) => (f.table.parents = '0'))],
    ['parents fact is null', mutate((f) => (f.table.parents = null))],
    ['children fact missing', mutate((f) => delete (f.table as Record<string, unknown>).children)],
    ['table owned by another role', mutate((f) => (f.table.ownerIsCurrentUser = false))],
    ['schema owned by another role', mutate((f) => (f.schemaOwnerIsCurrentUser = false))],
    ['extra relation in the marker schema', mutate((f) => f.relations.push({ name: 'shadow_seq', kind: 'S' }))],
    ['unreadable structure', () => state.databases.set(TEST_URL, markedTest({ facts: null }))],
  ])('%s', async (_label, arrange) => {
    arrange();
    const error = await failure(await guard());
    expect(error.phase).toBe('structure');
    expectSanitized(error);
  });

  it('refuses a canonical row and columns behind an external parent, before any Prisma client', async () => {
    const facts = canonicalFacts();
    facts.table.parents = 1;
    state.databases.set(TEST_URL, markedTest({ facts }));
    const { createTestPrismaClient } = await import('./helpers/test-db.js');
    const error = await failure(() => createTestPrismaClient());
    expect(error.phase).toBe('structure');
    expectSanitized(error);
    expect(state.adapterArgs).toHaveLength(0);
  });

  it('fails closed when the inheritance catalog cannot be read', async () => {
    state.databases.set(TEST_URL, markedTest({ failOn: { sql: 'pg_inherits', error: Object.assign(new Error(TEST_URL), { code: '42501' }) } }));
    const error = await failure(await guard());
    expect(error.phase).toBe('structure');
    expect(error.code).toBe('42501');
    expectSanitized(error);
  });

  it('runs the same catalog facts SQL as the installer, reading pg_inherits both ways', async () => {
    const installer = (await import('../../scripts/database/test-marker.mjs' as string)) as { MARKER_FACTS_SQL?: string };
    const runtime = await import('../scripts/demo-database.js');
    const runtimeSql = (runtime as { MARKER_FACTS_SQL?: string }).MARKER_FACTS_SQL;
    expect(typeof runtimeSql).toBe('string');
    expect(runtimeSql).toBe(installer.MARKER_FACTS_SQL);
    expect(runtimeSql).toMatch(/FROM pg_inherits \w+ WHERE \w+\.inhrelid = c\.oid/);
    expect(runtimeSql).toMatch(/FROM pg_inherits \w+ WHERE \w+\.inhparent = c\.oid/);
    await (await guard())();
    expect(pools()[0]!.queries).toContain(runtimeSql);
  });

  it('agrees with the installer verifier on every parent/child fact shape', async () => {
    const installer = (await import('../../scripts/database/test-marker.mjs' as string)) as {
      verifyMarkerStructure: (facts: unknown) => string | null;
    };
    const { verifyTestMarkerFacts } = await import('../scripts/demo-database.js');
    const values: unknown[] = [0, 1, 2, -1, 0.5, '0', null, undefined, true, false];
    let accepted = 0;
    for (const parents of values) {
      for (const children of values) {
        for (const hasSubclass of [false, true]) {
          const facts = canonicalFacts();
          const table = facts.table as Record<string, unknown>;
          table.hasSubclass = hasSubclass;
          if (parents === undefined) delete table.parents;
          else table.parents = parents;
          if (children === undefined) delete table.children;
          else table.children = children;
          const runtimeOk = verifyTestMarkerFacts(facts) === null;
          expect(runtimeOk, JSON.stringify(table)).toBe(installer.verifyMarkerStructure(facts) === null);
          if (runtimeOk) accepted += 1;
        }
      }
    }
    // Exactly one shape is acceptable: no parents, no children, no subclass flag.
    expect(accepted).toBe(1);
  });

  it('keeps the runtime canonical definition identical to the installer', async () => {
    const installer = (await import('../../scripts/database/test-marker.mjs' as string)) as {
      verifyMarkerStructure: (facts: unknown) => string | null;
    };
    expect(installer.verifyMarkerStructure(canonicalFacts())).toBeNull();
    const variants: unknown[] = [null, { ...canonicalFacts(), relations: [] }];
    const f1 = canonicalFacts();
    f1.columns[3]!.default = null;
    variants.push(f1);
    const f2 = canonicalFacts();
    f2.constraints.reverse();
    variants.push(f2);
    const { verifyTestMarkerFacts } = await import('../scripts/demo-database.js');
    for (const facts of variants) {
      expect(verifyTestMarkerFacts(facts) === null).toBe(installer.verifyMarkerStructure(facts) === null);
    }
    expect(verifyTestMarkerFacts(canonicalFacts())).toBeNull();
  });
});

describe('failures are sanitized', () => {
  it.each<[string, () => void, string, string | undefined]>([
    ['connection refused', () => state.databases.set(TEST_URL, markedTest({ connectError: Object.assign(new Error(`connect ECONNREFUSED ${TEST_URL}`), { code: 'ECONNREFUSED' }) })), 'connect', 'ECONNREFUSED'],
    ['DNS failure', () => standardEnv({ TEST_DATABASE_URL: TEST_URL.replace('aws-0-test', 'aws-0-nowhere') }), 'connect', 'ENOTFOUND'],
    ['identity query failure', () => state.databases.set(TEST_URL, markedTest({ failOn: { sql: 'to_regnamespace', error: Object.assign(new Error(`permission denied for ${TEST_URL}`), { code: '42501' }) } })), 'identity', '42501'],
    ['structural query failure', () => state.databases.set(TEST_URL, markedTest({ failOn: { sql: 'json_build_object', error: Object.assign(new Error('x'), { code: '57014' }) } })), 'structure', '57014'],
    ['lock failure after the table vanished', () => state.databases.set(TEST_URL, markedTest({ failOn: { sql: 'LOCK TABLE', error: Object.assign(new Error('gone'), { code: '42P01' }) } })), 'identity', '42P01'],
    ['non-Error throw', () => state.databases.set(TEST_URL, markedTest({ failOn: { sql: 'to_regnamespace', error: `boom ${TEST_URL}` } })), 'identity', undefined],
    ['error code built from secret material', () => state.databases.set(TEST_URL, markedTest({ failOn: { sql: 'to_regnamespace', error: Object.assign(new Error(TEST_URL), { code: TEST_SECRET }) } })), 'identity', 'unexpected'],
    [
      'SQLSTATE-shaped code that occurs in the connection URL',
      () => {
        const url = TEST_URL.replace('aws-0-test', 'aws-0-test-ABCDE');
        standardEnv({ TEST_DATABASE_URL: url });
        state.databases.set(url, markedTest({ failOn: { sql: 'to_regnamespace', error: Object.assign(new Error('x'), { code: 'ABCDE' }) } }));
      },
      'identity',
      'unexpected',
    ],
  ])('%s', async (_label, arrange, phase, code) => {
    arrange();
    const error = await failure(await guard());
    expect(error.phase).toBe(phase);
    expect(error.code).toBe(code);
    expectSanitized(error);
    for (const pool of pools()) expect(pool.ended).toBe(1);
    // A client that failed mid-transaction is destroyed, never returned to the pool.
    for (const pool of pools()) for (const r of pool.released) expect(r).not.toBeNull();
  });

  it('reports a pool cleanup failure after a successful proof as a refusal', async () => {
    state.endError = Object.assign(new Error(TEST_URL), { code: 'EPIPE' });
    const error = await failure(await guard());
    expect(error.phase).toBe('cleanup');
    expect(error.cleanupFailed).toBe(true);
    expectSanitized(error);
  });

  it('keeps the original phase when cleanup also fails after a refusal', async () => {
    state.databases.set(TEST_URL, markedTest({ rows: [] }));
    state.endError = new Error(TEST_URL);
    const error = await failure(await guard());
    expect(error.phase).toBe('identity');
    expect(error.cleanupFailed).toBe(true);
    expectSanitized(error);
  });
});

describe('proven Prisma clients own their pool', () => {
  it('creates a client only after proof and leaves no helper-owned pool open', async () => {
    const { createTestPrismaClient } = await import('./helpers/test-db.js');
    const prisma = await createTestPrismaClient();
    // Every pg.Pool the helper built itself was closed exactly once...
    expect(pools().every((pool) => pool.ended === 1)).toBe(true);
    // ...and the Prisma adapter received a TEST pool *configuration*, so the
    // adapter creates, owns and ends its own pool on every $disconnect().
    const [adapterConfig] = state.adapterArgs.at(-1)! as [{ connectionString?: string }];
    expect(pools().some((pool) => pool === (adapterConfig as unknown))).toBe(false);
    expect(adapterConfig.connectionString).toBe(TEST_URL);
    await prisma.$disconnect();
    await prisma.$disconnect();
  });

  it('survives repeated create/disconnect cycles without leaking helper pools', async () => {
    const { createTestPrismaClient } = await import('./helpers/test-db.js');
    for (let i = 0; i < 3; i += 1) {
      const prisma = await createTestPrismaClient();
      await prisma.$disconnect();
    }
    expect(pools()).toHaveLength(3);
    expect(pools().every((pool) => pool.ended === 1)).toBe(true);
  });

  it('never creates a Prisma client for an unproven database', async () => {
    standardEnv({ TEST_DATABASE_URL: DEV_URL });
    const { createTestPrismaClient } = await import('./helpers/test-db.js');
    const error = await failure(() => createTestPrismaClient());
    expectSanitized(error);
    expect(state.adapterArgs).toHaveLength(0);
  });

  it('refuses destructive helpers on a client it did not prove', async () => {
    const { truncateAllTables, withTransaction } = await import('./helpers/test-db.js');
    const { PrismaClient } = await import('../src/generated/prisma/client.js');
    const { PrismaPg } = await import('@prisma/adapter-pg');
    const stranger = new PrismaClient({ adapter: new PrismaPg({ connectionString: TEST_URL }), log: [] });
    await expect(truncateAllTables(stranger)).rejects.toThrow('proven test client');
    expect(() => withTransaction(stranger, async () => 1)).toThrow('proven test client');
    await stranger.$disconnect();
  });

  it('adapter contract (installed @prisma/adapter-pg): a configured pool is created per connect and ended by dispose', async () => {
    const real = await vi.importActual<typeof import('@prisma/adapter-pg')>('@prisma/adapter-pg');
    const factory = new real.PrismaPg({ connectionString: 'postgresql://u:p@127.0.0.1:9/x' });
    const adapter = await factory.connect();
    const pool = adapter.underlyingDriver() as { ended: boolean };
    expect(pool.ended).toBe(false);
    await adapter.dispose();
    expect(pool.ended).toBe(true);
  });
});

describe("openSeedDatabase('test')", () => {
  async function open() {
    const { openSeedDatabase } = await import('../scripts/demo-database.js');
    return openSeedDatabase('test');
  }

  it('proves TEST from the marker and never builds a DATABASE_URL pool', async () => {
    const db = await open();
    for (const pool of pools()) expect(pool.config.connectionString).toBe(TEST_URL);
    await db.close();
  });

  it('works without DATABASE_URL', async () => {
    standardEnv({ DATABASE_URL: undefined });
    const db = await open();
    await db.close();
  });

  it('refuses an unmarked database behind TEST_DATABASE_URL', async () => {
    standardEnv({ TEST_DATABASE_URL: DEMO_URL });
    const error = await failure(open);
    expect(error.phase).toBe('identity');
    expectSanitized(error);
    expect(pools().every((pool) => pool.ended === 1)).toBe(true);
  });

  it('closes its pool exactly once even if close() is called twice', async () => {
    const db = await open();
    await db.close();
    await db.close();
    expect(pools()).toHaveLength(1);
    expect(pools()[0]!.ended).toBe(1);
  });

  it('refuses outside NODE_ENV=test before reading configuration', async () => {
    process.env.NODE_ENV = 'development';
    await expect(open()).rejects.toThrow('Test target is available only to automated tests');
    expect(pools()).toHaveLength(0);
  });
});

describe('tests/setup.ts', () => {
  const keys = ['DATABASE_URL', 'TEST_DATABASE_URL', 'TEST_DATABASE_MARKER_ID'] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('proves TEST and leaves no DEV URL behind for the app default Prisma client', async () => {
    await import('./setup.js');
    expect(pools().length).toBeGreaterThan(0);
    for (const pool of pools()) expect(pool.config.connectionString).toBe(TEST_URL);
    expect(process.env.DATABASE_URL).not.toBe(DEV_URL);
    expect(new URL(process.env.DATABASE_URL!).hostname.endsWith('.invalid')).toBe(true);
    expect(process.env.TEST_DATABASE_URL).toBe(TEST_URL);
  });
});
