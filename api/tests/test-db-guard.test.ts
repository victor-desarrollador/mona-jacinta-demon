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
  // Task 4: set only for scripted LOCAL_TEST databases.
  local?: {
    database: string;
    user: string;
    version: string;
    rows: Array<Record<string, unknown>>;
    // Task 4 RED-LTP1: canonical unless overridden (catalog facts, foreign guards).
    facts?: unknown;
    testGuard?: unknown;
    pilotGuard?: unknown;
  };
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
  // Task 4: ordered SQL texts and 'PrismaPg' constructions (proof-before-Prisma).
  events: [] as string[],
  // Task 4 RED-LTP2B: runs once right after a fake pool ends (deterministic
  // "after proof, before the next pool" interposition point).
  onEnd: null as null | (() => void),
  // Task 4: target URL behind each globalSetup cleanup call.
  cleanups: [] as string[],
}));

// Task 4: globalSetup's cleanup is observed, never executed (it would run real
// Prisma SQL through the adapter). Records the target of the adapter behind it.
vi.mock('./helpers/factory-cleanup.js', () => ({
  cleanupFactoryOwnedLocations: async () => {
    const arg = state.adapterArgs.at(-1)?.[0] as
      | { record?: { config: { connectionString?: string } }; connectionString?: string }
      | undefined;
    state.cleanups.push(arg?.record?.config.connectionString ?? arg?.connectionString ?? 'unknown');
    state.events.push('cleanup');
    return { locationsDeleted: 0 };
  },
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
      const onEnd = state.onEnd;
      state.onEnd = null;
      onEnd?.();
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
    state.events.push('PrismaPg');
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
  state.events.push(text);
  if (db.failOn && text.includes(db.failOn.sql)) throw db.failOn.error;
  if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/.test(text.trim())) return { rows: [] };
  // Task 4 RED-LTP1: a scripted LOCAL_TEST database also answers the hardened
  // proof (lock, foreign-guard probes, canonical catalog facts).
  if (db.local && text.startsWith('LOCK TABLE mona_local_test_guard.')) return { rows: [] };
  if (db.local && text.includes('json_build_object') && text.includes('mona_local_test_guard')) {
    return { rows: [{ facts: db.local.facts === undefined ? canonicalLocalFacts() : db.local.facts }] };
  }
  if (db.local && text.includes('current_database()')) {
    const { database, user, version } = db.local;
    return {
      rows: [
        {
          current_database: database,
          current_user: user,
          version,
          test_guard_exists: db.local.testGuard === undefined ? false : db.local.testGuard,
          pilot_guard_exists: db.local.pilotGuard === undefined ? false : db.local.pilotGuard,
        },
      ],
    };
  }
  if (db.local && text.includes('FROM mona_local_test_guard.database_identity')) {
    return { rows: db.local.rows };
  }
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

// Task 4 RED-LTP1: catalog facts of the canonical LOCAL_TEST marker, in the shape
// of scripts/database/local-test-marker.mjs's MARKER_FACTS_SQL. Hand-written (not
// derived) and pinned to the installer by T4-LTP1-09, so neither side can drift.
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

// Task 4: the automated-test target selection (test-db.ts, openSeedDatabase,
// globalSetup, setup.ts) reads these from process.env. An operator shell or CI
// job running the suite against LOCAL_TEST exports them, so every test starts
// without them; a test that needs one sets it in its body. The prior presence
// and exact value are restored after each test.
const AMBIENT_TARGET_KEYS = [
  'MONA_TEST_DATABASE_TARGET',
  'LOCAL_TEST_DATABASE_URL',
  'LOCAL_TEST_DATABASE_MARKER_ID',
] as const;
let ambientTarget: Record<string, string | undefined> = {};

beforeEach(() => {
  ambientTarget = Object.fromEntries(AMBIENT_TARGET_KEYS.map((k) => [k, process.env[k]]));
  for (const key of AMBIENT_TARGET_KEYS) delete process.env[key];
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
  for (const key of AMBIENT_TARGET_KEYS) {
    if (ambientTarget[key] === undefined) delete process.env[key];
    else process.env[key] = ambientTarget[key];
  }
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


describe('Task 4 LOCAL_TEST target selection', () => {
  async function selector() {
    return import('../scripts/demo-database.js');
  }

  it('T4-SEL-01 defaults to hosted TEST when the selector is absent', async () => {
    const { resolveAutomatedTestTarget } = await selector();

    expect(resolveAutomatedTestTarget({})).toBe('test');
  });

  it('T4-SEL-02 accepts an explicit exact test selector', async () => {
    const { resolveAutomatedTestTarget } = await selector();

    expect(
      resolveAutomatedTestTarget({
        MONA_TEST_DATABASE_TARGET: 'test',
      }),
    ).toBe('test');
  });

  it('T4-SEL-03 selects LOCAL_TEST only for the exact local selector', async () => {
    const { resolveAutomatedTestTarget } = await selector();

    expect(
      resolveAutomatedTestTarget({
        MONA_TEST_DATABASE_TARGET: 'local',
      }),
    ).toBe('local');
  });

  it.each([
    '',
    'LOCAL',
    ' local ',
    'pilot',
    'demo',
    'production',
    'test ',
    'local\n',
  ])(
    'T4-SEL-04 fails closed for malformed/unknown selector %j',
    async (value) => {
      const { resolveAutomatedTestTarget } = await selector();

      expect(() =>
        resolveAutomatedTestTarget({
          MONA_TEST_DATABASE_TARGET: value,
        }),
      ).toThrow(/MONA_TEST_DATABASE_TARGET/);
    },
  );

  it('T4-SEL-05 local selection ignores hostile DATABASE_URL and TEST_DATABASE_URL values', async () => {
    const { resolveAutomatedTestTarget } = await selector();

    expect(
      resolveAutomatedTestTarget({
        MONA_TEST_DATABASE_TARGET: 'local',
        DATABASE_URL:
          'postgresql://dev:secret@dev-must-not-be-used.invalid:5432/dev',
        TEST_DATABASE_URL:
          'postgresql://test:secret@test-must-not-be-used.invalid:5432/test',
      }),
    ).toBe('local');
  });
});


describe('Task 4 LOCAL_TEST configuration guard', () => {
  const MARKER = '123e4567-e89b-42d3-a456-426614174000';
  const URL =
    'postgresql://mona_local_test:local-secret@127.0.0.1:5432/mona_local_test';

  async function localGuard() {
    return import('../scripts/demo-database.js');
  }

  function env(
    overrides: Record<string, string | undefined> = {},
  ): NodeJS.ProcessEnv {
    const source: NodeJS.ProcessEnv = {
      LOCAL_TEST_DATABASE_URL: URL,
      LOCAL_TEST_DATABASE_MARKER_ID: MARKER,
      ...overrides,
    };

    for (const [key, value] of Object.entries(source)) {
      if (value === undefined) delete source[key];
    }

    return source;
  }

  it('T4-LOCAL-01 accepts the exact dedicated loopback LOCAL_TEST target', async () => {
    const { readLocalTestTarget } = await localGuard();

    expect(readLocalTestTarget(env())).toEqual({
      url: URL,
      markerId: MARKER,
    });
  });

  it.each([
    [
      'missing URL',
      { LOCAL_TEST_DATABASE_URL: undefined },
      /LOCAL_TEST_DATABASE_URL/,
    ],
    [
      'missing marker',
      { LOCAL_TEST_DATABASE_MARKER_ID: undefined },
      /LOCAL_TEST_DATABASE_MARKER_ID/,
    ],
    [
      'malformed URL',
      { LOCAL_TEST_DATABASE_URL: 'not-a-postgres-url' },
      /LOCAL_TEST_DATABASE_URL/,
    ],
    [
      'remote hostname',
      {
        LOCAL_TEST_DATABASE_URL:
          'postgresql://mona_local_test:local-secret@database.example.com:5432/mona_local_test',
      },
      /LOCAL_TEST_DATABASE_URL/,
    ],
    [
      'localhost alias instead of pinned loopback address',
      {
        LOCAL_TEST_DATABASE_URL:
          'postgresql://mona_local_test:local-secret@localhost:5432/mona_local_test',
      },
      /LOCAL_TEST_DATABASE_URL/,
    ],
    [
      'IPv6 loopback instead of pinned IPv4 loopback address',
      {
        LOCAL_TEST_DATABASE_URL:
          'postgresql://mona_local_test:local-secret@[::1]:5432/mona_local_test',
      },
      /LOCAL_TEST_DATABASE_URL/,
    ],
    [
      'wrong port',
      {
        LOCAL_TEST_DATABASE_URL:
          'postgresql://mona_local_test:local-secret@127.0.0.1:6543/mona_local_test',
      },
      /LOCAL_TEST_DATABASE_URL/,
    ],
    [
      'wrong database',
      {
        LOCAL_TEST_DATABASE_URL:
          'postgresql://mona_local_test:local-secret@127.0.0.1:5432/postgres',
      },
      /LOCAL_TEST_DATABASE_URL/,
    ],
    [
      'wrong username',
      {
        LOCAL_TEST_DATABASE_URL:
          'postgresql://postgres:local-secret@127.0.0.1:5432/mona_local_test',
      },
      /LOCAL_TEST_DATABASE_URL/,
    ],
    [
      'missing password',
      {
        LOCAL_TEST_DATABASE_URL:
          'postgresql://mona_local_test@127.0.0.1:5432/mona_local_test',
      },
      /LOCAL_TEST_DATABASE_URL/,
    ],
    [
      'TLS/query override',
      {
        LOCAL_TEST_DATABASE_URL:
          'postgresql://mona_local_test:local-secret@127.0.0.1:5432/mona_local_test?sslmode=disable',
      },
      /LOCAL_TEST_DATABASE_URL/,
    ],
    [
      'fragment',
      {
        LOCAL_TEST_DATABASE_URL:
          'postgresql://mona_local_test:local-secret@127.0.0.1:5432/mona_local_test#x',
      },
      /LOCAL_TEST_DATABASE_URL/,
    ],
    [
      'non-v4 marker',
      { LOCAL_TEST_DATABASE_MARKER_ID: '123e4567-e89b-12d3-a456-426614174000' },
      /LOCAL_TEST_DATABASE_MARKER_ID/,
    ],
    [
      'uppercase marker',
      {
        LOCAL_TEST_DATABASE_MARKER_ID:
          '123E4567-E89B-42D3-A456-426614174000',
      },
      /LOCAL_TEST_DATABASE_MARKER_ID/,
    ],
    [
      'padded marker',
      {
        LOCAL_TEST_DATABASE_MARKER_ID:
          ' 123e4567-e89b-42d3-a456-426614174000 ',
      },
      /LOCAL_TEST_DATABASE_MARKER_ID/,
    ],
  ])(
    'T4-LOCAL-02 fails closed for %s',
    async (_label, overrides, expected) => {
      const { readLocalTestTarget } = await localGuard();

      expect(() =>
        readLocalTestTarget(
          env(overrides as Record<string, string | undefined>),
        ),
      ).toThrow(expected as RegExp);
    },
  );

  it('T4-LOCAL-03 ignores hostile DEV and hosted TEST variables', async () => {
    const { readLocalTestTarget } = await localGuard();

    expect(
      readLocalTestTarget(
        env({
          DATABASE_URL:
            'postgresql://dev:secret@dev-must-not-be-used.invalid:5432/dev',
          TEST_DATABASE_URL:
            'postgresql://test:secret@test-must-not-be-used.invalid:5432/test',
          TEST_DATABASE_MARKER_ID:
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        }),
      ),
    ).toEqual({
      url: URL,
      markerId: MARKER,
    });
  });

  // Task 4 RED6B-URLPARITY: every LOCAL_TEST consumer accepts the same language —
  // the canonical text itself, never something a URL parser normalizes into it
  // (WHATWG trims, drops tab/LF/CR anywhere, lowercases the scheme, strips port
  // zeros, re-encodes userinfo). The raw value is refused, never normalized.
  describe('T4-URLPARITY LOCAL_TEST URL is canonical text for every consumer', () => {
    const accepted: Array<[string, string]> = [
      ['canonical postgresql:', URL],
      ['canonical postgres:', URL.replace(/^postgresql:/, 'postgres:')],
      ['a valid percent-encoded password', URL.replace('local-secret', 'p%40ss%2Fw%20rd')],
    ];
    const refused: Array<[string, string]> = [
      ['a leading space', ` ${URL}`],
      ['a trailing space', `${URL} `],
      ['a leading tab', `\t${URL}`],
      ['a trailing tab', `${URL}\t`],
      ['an embedded tab', URL.replace('127.0.0.1', '127.0.\t0.1')],
      ['an embedded newline', URL.replace('@', '@\n')],
      ['a trailing newline', `${URL}\n`],
      ['a carriage return', `${URL}\r`],
      ['a trailing vertical tab', `${URL}\v`],
      ['a leading NUL', `\u0000${URL}`],
      ['a literal space inside the password', URL.replace('local-secret', 'local secret')],
      ['a space after the scheme separator', URL.replace('//', '// ')],
      ['spaces around the hostname', URL.replace('127.0.0.1', ' 127.0.0.1 ')],
      ['an uppercase scheme', URL.replace(/^postgresql:/, 'POSTGRESQL:')],
      ['a zero-padded port', URL.replace(':5432/', ':05432/')],
      ['a percent-encoded username', URL.replace('//mona_local_test:', '//mona%5Flocal%5Ftest:')],
    ];

    it.each(accepted)('T4-URLPARITY-01 readLocalTestTarget accepts %s and returns it unchanged', async (_label, url) => {
      const { readLocalTestTarget } = await localGuard();

      expect(readLocalTestTarget(env({ LOCAL_TEST_DATABASE_URL: url })).url === url).toBe(true);
    });

    it.each(refused)('T4-URLPARITY-02 readLocalTestTarget refuses %s', async (_label, url) => {
      const { readLocalTestTarget } = await localGuard();

      expect(() => readLocalTestTarget(env({ LOCAL_TEST_DATABASE_URL: url }))).toThrow(/LOCAL_TEST_DATABASE_URL/);
    });

    // The same table through prisma.local-test.config.ts (Prisma's own loader,
    // outside Vitest's module graph): both consumers must give the same verdict.
    it.each([
      ...accepted.map(([label, url]) => [label, url, 'accepted'] as const),
      ...refused.map(([label, url]) => [label, url, 'refused'] as const),
    ])('T4-URLPARITY-03 prisma.local-test.config.ts agrees on %s', async (_label, url, verdict) => {
      const { loadConfigFromFile } = await import('@prisma/config');
      const { fileURLToPath } = await import('node:url');
      // globalThis.URL: this describe's `URL` is the canonical URL string.
      const root = fileURLToPath(new globalThis.URL('../', import.meta.url));
      const saved = process.env.LOCAL_TEST_DATABASE_URL;
      process.env.LOCAL_TEST_DATABASE_URL = url;
      try {
        const loaded = await loadConfigFromFile({ configFile: `${root}prisma.local-test.config.ts`, configRoot: root });
        const observed = loaded.error
          ? loaded.error._tag === 'ConfigLoadError' ? 'refused' : `load-error:${loaded.error._tag}`
          : loaded.config.datasource?.url === url ? 'accepted' : 'accepted-other-url';
        expect(observed).toBe(verdict);
      } finally {
        if (saved === undefined) delete process.env.LOCAL_TEST_DATABASE_URL;
        else process.env.LOCAL_TEST_DATABASE_URL = saved;
      }
    });
  });
});


describe('Task 4 LOCAL_TEST identity facts', () => {
  const MARKER = '123e4567-e89b-42d3-a456-426614174000';
  const OTHER_MARKER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  const canonicalFacts = () => ({
    currentDatabase: 'mona_local_test',
    currentUser: 'mona_local_test',
    version: 'PostgreSQL 17.11 (Debian 17.11-0+deb13u1)',
    markerRows: [
      {
        environment: 'local_test',
        markerId: MARKER,
        hasInstalledAt: true,
      },
    ],
  });

  async function identityGuard() {
    return import('../scripts/demo-database.js');
  }

  it('T4-ID-01 accepts the canonical LOCAL_TEST identity facts', async () => {
    const { assertLocalTestIdentityFacts } = await identityGuard();

    expect(() =>
      assertLocalTestIdentityFacts(canonicalFacts(), MARKER),
    ).not.toThrow();
  });

  it.each([
    [
      'wrong database',
      {
        currentDatabase: 'postgres',
      },
    ],
    [
      'wrong user',
      {
        currentUser: 'postgres',
      },
    ],
    [
      'PostgreSQL 15',
      {
        version: 'PostgreSQL 15.14',
      },
    ],
    [
      'unparseable PostgreSQL version',
      {
        version: 'unknown',
      },
    ],
    [
      'zero marker rows',
      {
        markerRows: [],
      },
    ],
    [
      'two marker rows',
      {
        markerRows: [
          {
            environment: 'local_test',
            markerId: MARKER,
            hasInstalledAt: true,
          },
          {
            environment: 'local_test',
            markerId: MARKER,
            hasInstalledAt: true,
          },
        ],
      },
    ],
    [
      'hosted TEST marker',
      {
        markerRows: [
          {
            environment: 'test',
            markerId: MARKER,
            hasInstalledAt: true,
          },
        ],
      },
    ],
    [
      'DEV marker',
      {
        markerRows: [
          {
            environment: 'dev',
            markerId: MARKER,
            hasInstalledAt: true,
          },
        ],
      },
    ],
    [
      'PILOT marker',
      {
        markerRows: [
          {
            environment: 'pilot',
            markerId: MARKER,
            hasInstalledAt: true,
          },
        ],
      },
    ],
    [
      'wrong marker id',
      {
        markerRows: [
          {
            environment: 'local_test',
            markerId: OTHER_MARKER,
            hasInstalledAt: true,
          },
        ],
      },
    ],
    [
      'missing installed_at',
      {
        markerRows: [
          {
            environment: 'local_test',
            markerId: MARKER,
            hasInstalledAt: false,
          },
        ],
      },
    ],
  ])(
    'T4-ID-02 fails closed for %s',
    async (_label, override) => {
      const { assertLocalTestIdentityFacts } = await identityGuard();

      const facts = {
        ...canonicalFacts(),
        ...override,
      };

      expect(() =>
        assertLocalTestIdentityFacts(facts, MARKER),
      ).toThrow(/LOCAL_TEST identity/);
    },
  );

  // Task 4 RED6B-PG17: LOCAL_TEST targets PostgreSQL 17; any major >= 17 is
  // accepted, anything older or unparseable is refused. Only the version fact
  // differs from the canonical identity.
  describe('T4-PG17 LOCAL_TEST requires PostgreSQL 17 or newer', () => {
    const withVersion = (version: string) => ({ ...canonicalFacts(), version });

    it.each([
      'PostgreSQL 17.0',
      'PostgreSQL 17.11 (Debian 17.11-0+deb13u1) on x86_64-pc-linux-gnu, compiled by gcc (Debian 14.2.0-19) 14.2.0, 64-bit',
      'PostgreSQL 18.1',
    ])('T4-PG17-01 accepts %j', async (version) => {
      const { assertLocalTestIdentityFacts } = await identityGuard();

      expect(() => assertLocalTestIdentityFacts(withVersion(version), MARKER)).not.toThrow();
    });

    it.each([
      'PostgreSQL 16.0',
      'PostgreSQL 16.9 (Debian 16.9-1.pgdg120+1) on x86_64-pc-linux-gnu, compiled by gcc, 64-bit',
      'PostgreSQL 16',
      'PostgreSQL 016.4',
      'PostgreSQL 15.14',
    ])('T4-PG17-02 refuses the older major %j', async (version) => {
      const { assertLocalTestIdentityFacts } = await identityGuard();

      expect(() => assertLocalTestIdentityFacts(withVersion(version), MARKER)).toThrow(/LOCAL_TEST identity/);
    });

    it.each([
      '',
      'PostgreSQL',
      'PostgreSQL x17',
      'PostgreSQL -17',
      'PostgreSQL 0.1',
      '17.4 PostgreSQL',
      'EnterpriseDB 17.2',
      ' PostgreSQL 17.4',
    ])('T4-PG17-03 refuses the malformed version %j', async (version) => {
      const { assertLocalTestIdentityFacts } = await identityGuard();

      expect(() => assertLocalTestIdentityFacts(withVersion(version), MARKER)).toThrow(/LOCAL_TEST identity/);
    });
  });
});


describe('Task 4 LOCAL_TEST live identity proof', () => {
  const MARKER = '123e4567-e89b-42d3-a456-426614174000';
  const OTHER_MARKER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  function fakeClient(options: {
    environment?: string;
    markerId?: string;
    database?: string;
    user?: string;
    version?: string;
    failOn?: 'metadata' | 'marker';
  } = {}) {
    const calls: string[] = [];

    return {
      calls,
      client: {
        async query(text: string) {
          calls.push(text);

          if (
            options.failOn === 'metadata' &&
            text.includes('current_database()')
          ) {
            throw new Error('synthetic metadata failure');
          }

          // RED-LTP1: the marker rows query specifically (the hardened proof's
          // LOCK and catalog-facts queries also name the table).
          if (
            options.failOn === 'marker' &&
            text.includes('FROM mona_local_test_guard.database_identity')
          ) {
            throw new Error('synthetic marker failure');
          }

          // RED-LTP1: canonical answers for the hardened proof.
          if (text.startsWith('LOCK TABLE')) return { rows: [] };
          if (text.includes('json_build_object')) {
            return { rows: [{ facts: canonicalLocalFacts() }] };
          }

          if (text.includes('current_database()')) {
            return {
              rows: [
                {
                  current_database:
                    options.database ?? 'mona_local_test',
                  current_user:
                    options.user ?? 'mona_local_test',
                  version:
                    options.version ??
                    'PostgreSQL 17.11 (synthetic)',
                  test_guard_exists: false,
                  pilot_guard_exists: false,
                },
              ],
            };
          }

          if (text.includes('FROM mona_local_test_guard.database_identity')) {
            return {
              rows: [
                {
                  environment:
                    options.environment ?? 'local_test',
                  marker_id:
                    options.markerId ?? MARKER,
                  has_installed_at: true,
                },
              ],
            };
          }

          return { rows: [] };
        },
      },
    };
  }

  it('T4-LIVE-01 proves canonical LOCAL_TEST inside one READ ONLY transaction', async () => {
    const { proveLocalTestIdentity } =
      await import('../scripts/demo-database.js');

    const { client, calls } = fakeClient();

    await expect(
      proveLocalTestIdentity(client, MARKER),
    ).resolves.toBeUndefined();

    // RED-LTP1: one REPEATABLE READ snapshot (was plain BEGIN READ ONLY).
    expect(calls[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(calls[1]).toBe(
      'SET LOCAL search_path TO pg_catalog, pg_temp',
    );

    expect(
      calls.some((sql) => sql.includes('current_database()')),
    ).toBe(true);

    expect(
      calls.some((sql) =>
        sql.includes('mona_local_test_guard.database_identity'),
      ),
    ).toBe(true);

    expect(calls.at(-1)).toBe('COMMIT');
  });

  it.each([
    ['wrong database', { database: 'postgres' }],
    ['wrong user', { user: 'postgres' }],
    ['old PostgreSQL', { version: 'PostgreSQL 15.14' }],
    ['TEST marker', { environment: 'test' }],
    ['DEV marker', { environment: 'dev' }],
    ['PILOT marker', { environment: 'pilot' }],
    ['wrong marker id', { markerId: OTHER_MARKER }],
  ])(
    'T4-LIVE-02 refuses %s from live facts and rolls back',
    async (_label, options) => {
      const { proveLocalTestIdentity } =
        await import('../scripts/demo-database.js');

      const { client, calls } = fakeClient(options);

      await expect(
        proveLocalTestIdentity(client, MARKER),
      ).rejects.toThrow(/LOCAL_TEST identity/);

      expect(calls).toContain('ROLLBACK');
      expect(calls).not.toContain('COMMIT');
    },
  );

  it.each(['metadata', 'marker'] as const)(
    'T4-LIVE-03 query failure at %s fails closed and does not commit',
    async (failOn) => {
      const { proveLocalTestIdentity } =
        await import('../scripts/demo-database.js');

      const { client, calls } = fakeClient({ failOn });

      await expect(
        proveLocalTestIdentity(client, MARKER),
      ).rejects.toThrow(/LOCAL_TEST identity/);

      // The failure point must actually be reached inside the pinned READ ONLY
      // transaction; an early throw with no SQL must not satisfy this test.
      const begin = calls.indexOf('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const pin = calls.indexOf(
        'SET LOCAL search_path TO pg_catalog, pg_temp',
      );
      const metadata = calls.findIndex((sql) =>
        sql.includes('current_database()'),
      );

      expect(begin).toBeGreaterThanOrEqual(0);
      expect(pin).toBeGreaterThan(begin);
      expect(metadata).toBeGreaterThan(pin);

      if (failOn === 'marker') {
        const marker = calls.findIndex((sql) =>
          sql.includes('FROM mona_local_test_guard.database_identity'),
        );

        expect(marker).toBeGreaterThan(metadata);
      }

      expect(calls.at(-1)).toBe('ROLLBACK');
      expect(calls).not.toContain('COMMIT');
    },
  );

  it('T4-LIVE-04 identity proof issues no destructive SQL', async () => {
    const { proveLocalTestIdentity } =
      await import('../scripts/demo-database.js');

    const { client, calls } = fakeClient();

    await proveLocalTestIdentity(client, MARKER);

    // Guard against a vacuous pass: with zero statements, every() is true.
    expect(
      calls.some((sql) => sql.includes('current_database()')),
    ).toBe(true);
    expect(
      calls.some((sql) =>
        sql.includes('mona_local_test_guard.database_identity'),
      ),
    ).toBe(true);

    const forbidden =
      /\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE|GRANT|REVOKE)\b/i;

    expect(calls.filter((sql) => forbidden.test(sql))).toEqual([]);
  });
});


// Task 4 RED-LTP1: the runtime LOCAL_TEST proof converges on the canonical marker
// contract of scripts/database/local-test-marker.mjs. The installer is imported
// here (never by the runtime) as the parity authority for its read-only SQL and
// its structure verifier; the runtime keeps its own TS implementation.
describe('T4-LTP1 LOCAL_TEST runtime proof matches canonical marker identity', () => {
  const MARKER_ID = '123e4567-e89b-42d3-a456-426614174000';
  const OTHER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const LEAK = 'postgresql://mona_local_test:ltp1-secret@127.0.0.1:5432/mona_local_test';
  const BEGIN_RR = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY';
  const PIN = 'SET LOCAL search_path TO pg_catalog, pg_temp';
  const LOCK = 'LOCK TABLE mona_local_test_guard.database_identity IN ACCESS SHARE MODE';
  const WRITE_SQL = /^\s*(CREATE|INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|GRANT|REVOKE|MERGE|COMMENT)\b/i;
  type Installer = {
    LIVE_FACTS_SQL: string;
    MARKER_FACTS_SQL: string;
    MARKER_ROWS_SQL: string;
    verifyMarkerStructure: (facts: unknown) => string | null;
  };
  const installer = async () =>
    (await import('../../scripts/database/local-test-marker.mjs' as string)) as Installer;
  const row = (environment: string, marker_id: string, has_installed_at = true) => ({ environment, marker_id, has_installed_at });

  type Options = {
    live?: Record<string, unknown>;
    facts?: unknown;
    rows?: Array<Record<string, unknown>>;
    lockError?: { code: string };
    failOn?: 'facts' | 'rows';
  };
  // Answers both the current and the hardened proof; every failure carries a
  // connection string so sanitization is observable.
  function ltpClient(options: Options = {}) {
    const calls: string[] = [];
    const client = {
      async query(text: string) {
        calls.push(text);
        if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/.test(text)) return { rows: [] };
        if (text.startsWith('LOCK TABLE')) {
          if (options.lockError) throw Object.assign(new Error(`lock failed ${LEAK}`), options.lockError);
          return { rows: [] };
        }
        if (text.includes('json_build_object')) {
          if (options.failOn === 'facts') throw Object.assign(new Error(`facts failed ${LEAK}`), { code: '57014' });
          return { rows: [{ facts: options.facts === undefined ? canonicalLocalFacts() : options.facts }] };
        }
        if (text.includes('current_database()')) {
          return {
            rows: [
              {
                current_database: 'mona_local_test',
                current_user: 'mona_local_test',
                version: 'PostgreSQL 17.11 (synthetic)',
                test_guard_exists: false,
                pilot_guard_exists: false,
                ...options.live,
              },
            ],
          };
        }
        if (text.includes('FROM mona_local_test_guard.database_identity')) {
          if (options.failOn === 'rows') throw Object.assign(new Error(`rows failed ${LEAK}`), { code: '57014' });
          return { rows: options.rows ?? [row('local_test', MARKER_ID)] };
        }
        return { rows: [] };
      },
    };
    return { client, calls };
  }
  async function prove(options: Options = {}) {
    const { proveLocalTestIdentity } = await import('../scripts/demo-database.js');
    const { client, calls } = ltpClient(options);
    let error: Error | null = null;
    try {
      await proveLocalTestIdentity(client, MARKER_ID);
    } catch (caught) {
      error = caught as Error;
    }
    return { error, calls };
  }
  const expectRefused = ({ error, calls }: { error: Error | null; calls: string[] }) => {
    expect(error?.message).toBe('LOCAL_TEST identity could not be proven; refusing destructive writes');
    expect(calls).toContain('ROLLBACK');
    expect(calls).not.toContain('COMMIT');
    expect(calls.filter((sql) => WRITE_SQL.test(sql))).toEqual([]);
  };

  it('T4-LTP1-01 proves the canonical marker with canonical facts and writes nothing', async () => {
    const { error, calls } = await prove();
    expect(error).toBeNull();
    expect(calls.filter((sql) => WRITE_SQL.test(sql))).toEqual([]);
    expect(calls.some((sql) => /^SELECT\b/.test(sql.trim()))).toBe(true);
  });

  it('T4-LTP1-02 runs in one REPEATABLE READ READ ONLY transaction with a pinned search_path', async () => {
    const { calls } = await prove();
    expect(calls[0]).toBe(BEGIN_RR);
    expect(calls[1]).toBe(PIN);
    expect(calls.at(-1)).toBe('COMMIT');
  });

  it('T4-LTP1-03 takes ACCESS SHARE on the marker before the first snapshot-taking SELECT', async () => {
    const { calls } = await prove();
    const lock = calls.indexOf(LOCK);
    const firstSelect = calls.findIndex((sql) => /^SELECT\b/.test(sql.trim()));
    expect(lock).toBeGreaterThan(calls.indexOf(PIN));
    expect(firstSelect).toBeGreaterThan(lock);
  });

  it.each(['LIVE_FACTS_SQL', 'MARKER_FACTS_SQL', 'MARKER_ROWS_SQL'] as const)(
    'T4-LTP1-04 issues the installer %s verbatim',
    async (name) => {
      const sql = (await installer())[name];
      const { calls } = await prove();
      expect(calls).toContain(sql);
    },
  );

  it('T4-LTP1-05 reads the live facts before the catalog facts and the rows', async () => {
    const { LIVE_FACTS_SQL, MARKER_FACTS_SQL, MARKER_ROWS_SQL } = await installer();
    const { calls } = await prove();
    const live = calls.indexOf(LIVE_FACTS_SQL);
    expect(live).toBeGreaterThan(calls.indexOf(LOCK));
    expect(calls.indexOf(MARKER_FACTS_SQL)).toBeGreaterThan(live);
    expect(calls.indexOf(MARKER_ROWS_SQL)).toBeGreaterThan(live);
  });

  it.each<[string, Record<string, unknown>]>([
    ['a foreign TEST guard schema', { test_guard_exists: true }],
    ['a foreign PILOT guard schema', { pilot_guard_exists: true }],
    ['an unknown TEST guard observation', { test_guard_exists: null }],
    ['an unknown PILOT guard observation', { pilot_guard_exists: undefined }],
  ])('T4-LTP1-06 refuses %s', async (_label, live) => {
    expectRefused(await prove({ live }));
  });

  it('T4-LTP1-07 keeps the PostgreSQL 17 minimum', async () => {
    expectRefused(await prove({ live: { version: 'PostgreSQL 16.9 (synthetic)' } }));
  });

  const structureMutations: Array<[string, (f: ReturnType<typeof canonicalLocalFacts>) => unknown]> = [
    ['unreadable catalog facts', () => null],
    ['catalog facts delivered as a string', (f) => JSON.stringify(f)],
    ['a schema owned by another role', (f) => ({ ...f, schemaOwnerIsCurrentUser: false })],
    ['a table owned by another role', (f) => ({ ...f, table: { ...f.table, ownerIsCurrentUser: false } })],
    ['a view instead of a table', (f) => ({ ...f, table: { ...f.table, kind: 'v' } })],
    ['an unlogged table', (f) => ({ ...f, table: { ...f.table, persistence: 'u' } })],
    ['row-level security', (f) => ({ ...f, table: { ...f.table, rowSecurity: true } })],
    ['a trigger', (f) => ({ ...f, table: { ...f.table, triggers: 1 } })],
    ['a rewrite rule', (f) => ({ ...f, table: { ...f.table, hasRules: true } })],
    ['an inheritance child', (f) => ({ ...f, table: { ...f.table, hasSubclass: true, children: 1 } })],
    ['a partition', (f) => ({ ...f, table: { ...f.table, isPartition: true, parents: 1 } })],
    ['an extra column', (f) => ({ ...f, columns: [...f.columns, { name: 'note', type: 'text', notNull: false, default: null, generated: '', identity: '', collation: 'default' }] })],
    ['a text marker_id', (f) => ({ ...f, columns: f.columns.map((c) => (c.name === 'marker_id' ? { ...c, type: 'text', collation: 'default' } : c)) })],
    ['the TEST environment check', (f) => ({ ...f, constraints: f.constraints.map((c) => (c.definition.includes('environment') ? { ...c, definition: "CHECK ((environment = 'test'::text))" } : c)) })],
    ['a missing primary key', (f) => ({ ...f, constraints: f.constraints.filter((c) => c.type !== 'p') })],
    ['an extra relation in the guard schema', (f) => ({ ...f, relations: [...f.relations, { name: 'shadow', kind: 'v' }] })],
  ];

  it.each(structureMutations)('T4-LTP1-08 refuses %s even with a canonical row', async (_label, mutate) => {
    expectRefused(await prove({ facts: mutate(canonicalLocalFacts()) }));
  });

  it('T4-LTP1-09 the fixtures are pinned to the installer verifier (canonical passes, every mutation fails)', async () => {
    const { verifyMarkerStructure } = await installer();
    expect(verifyMarkerStructure(canonicalLocalFacts())).toBeNull();
    for (const [, mutate] of structureMutations) {
      expect(typeof verifyMarkerStructure(mutate(canonicalLocalFacts()))).toBe('string');
    }
  });

  it.each<[string, Array<Record<string, unknown>>]>([
    ['zero rows', []],
    ['two rows', [row('local_test', MARKER_ID), row('local_test', MARKER_ID)]],
    ['a different marker id', [row('local_test', OTHER_ID)]],
    ['the TEST environment', [row('test', MARKER_ID)]],
    ['the PILOT environment', [row('pilot', MARKER_ID)]],
    ['a missing installed_at', [row('local_test', MARKER_ID, false)]],
  ])('T4-LTP1-10 refuses %s under canonical structure', async (_label, rows) => {
    expectRefused(await prove({ rows }));
  });

  it.each(['42P01', '3F000'])('T4-LTP1-11 an absent marker (LOCK fails with %s) is a sanitized refusal, never provisioned', async (code) => {
    const result = await prove({ lockError: { code } });
    expect(result.calls).toContain(LOCK);
    expectRefused(result);
    expect(result.error?.message).not.toContain('ltp1-secret');
  });

  it.each(['facts', 'rows'] as const)('T4-LTP1-12 a failing %s query rolls back, never commits, and stays sanitized', async (failOn) => {
    const { MARKER_FACTS_SQL, MARKER_ROWS_SQL } = await installer();
    const result = await prove({ failOn });
    expect(result.calls).toContain(failOn === 'facts' ? MARKER_FACTS_SQL : MARKER_ROWS_SQL);
    expectRefused(result);
    expect(result.calls.at(-1)).toBe('ROLLBACK');
    expect(result.error?.message).not.toContain('ltp1-secret');
  });

  it('T4-LTP1-13 the runtime never imports the operator marker installer', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../scripts/demo-database.ts', import.meta.url), 'utf8');
    // Import specifiers only: comments may cite the installer for parity.
    expect(source).not.toMatch(/(\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"][^'"]*(local-test-marker|scripts\/database\/)/);
  });
});

// RED-LTP2: node-postgres resolves the startup `options` from config.options
// only when truthy, otherwise from the REAL process.env.PGOPTIONS
// (pg/lib/connection-parameters.js `val`). An explicit `source` cannot hide it.
// Contract (marker parity, local-test-marker.mjs): PGOPTIONS present at all, in
// `source` or in process.env, even '', refuses at phase=config before any Pool.
describe('T4-LTP2 LOCAL_TEST runtime rejects ambient PGOPTIONS', () => {
  const MARKER_ID = '5b0c2c1e-8f3a-4d7e-9b21-6a4f0e7d3c52';
  const LOCAL_URL = 'postgresql://mona_local_test:ltp2-secret@127.0.0.1:5432/mona_local_test';
  const CANARY = 'ltp2-pgoptions-canary';
  const HOSTILE_DB_URL = 'postgresql://postgres.ltp2hostile:ltp2-dburl-secret@10.9.9.9:6543/postgres';
  const HOSTILE_TEST_URL = 'postgresql://postgres.ltp2hostile:ltp2-testurl-secret@10.9.9.8:6543/postgres';
  const REFUSAL = 'LOCAL_TEST identity could not be proven; refusing destructive writes [target=LOCAL_TEST phase=config]';
  const ENV_KEYS = [
    'PGOPTIONS',
    'PGHOST',
    'PGHOSTADDR',
    'PGPORT',
    'PGUSER',
    'PGDATABASE',
    'PGPASSWORD',
    'PGSSLMODE',
    'DATABASE_URL',
    'TEST_DATABASE_URL',
    'MONA_TEST_DATABASE_TARGET',
    'LOCAL_TEST_DATABASE_URL',
    'LOCAL_TEST_DATABASE_MARKER_ID',
  ] as const;
  const HOSTILE_OPTIONS: Array<[string, string]> = [
    ['search_path', '-c search_path=public'],
    ['statement_timeout', '-c statement_timeout=0'],
    ['multiple settings', '-c search_path=public -c statement_timeout=0 -c default_transaction_read_only=off'],
    ['sensitive-looking text', `-c application_name=${CANARY}`],
  ];
  const localSource = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    LOCAL_TEST_DATABASE_URL: LOCAL_URL,
    LOCAL_TEST_DATABASE_MARKER_ID: MARKER_ID,
    ...extra,
  });
  const markedLocal = (): FakeDb => ({
    ...unmarked('mona_local_test', '127.0.0.1'),
    local: {
      database: 'mona_local_test',
      user: 'mona_local_test',
      version: 'PostgreSQL 17.11 (synthetic)',
      rows: [{ environment: 'local_test', marker_id: MARKER_ID, has_installed_at: true }],
    },
  });
  let saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    // Hermetic start: no ambient PG* or routing value survives from the shell.
    for (const key of ENV_KEYS) delete process.env[key];
    state.databases.set(LOCAL_URL, markedLocal());
    state.events.length = 0;
  });
  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  const openPool = async (source: NodeJS.ProcessEnv) => {
    const { openProvenLocalTestPool } = await import('../scripts/demo-database.js');
    return openProvenLocalTestPool(1, source);
  };
  const allQueries = () => pools().flatMap((pool) => pool.queries);
  function expectRefusedBeforePool(error: Error) {
    expect(error.message).toBe(REFUSAL);
    expect(pools()).toHaveLength(0);
    expect(allQueries()).toHaveLength(0);
    expect(state.events).not.toContain('PrismaPg');
    const everything = [error.message, String(error.stack), JSON.stringify(error)].join('\n');
    for (const secret of [
      CANARY,
      'ltp2-secret',
      LOCAL_URL,
      'ltp2-dburl-secret',
      'ltp2-testurl-secret',
      'search_path',
      'statement_timeout',
      '-c ',
      'postgresql://',
    ]) {
      expect(everything).not.toContain(secret);
    }
  }

  it('T4-LTP2-01 positive control: PGOPTIONS absent everywhere proves LOCAL_TEST on a connectionString-only pool', async () => {
    expect(process.env.PGOPTIONS).toBeUndefined();
    const { pool, target } = await openPool(localSource());
    expect(target).toEqual({ url: LOCAL_URL, markerId: MARKER_ID });
    expect(pools()).toHaveLength(1);
    expect(pools()[0]!.config.connectionString).toBe(LOCAL_URL);
    expect(allQueries().some((sql) => sql.includes('FROM mona_local_test_guard.database_identity'))).toBe(true);
    expect(allQueries().at(-1)).toBe('COMMIT');
    await pool.end();
  });

  it.each(HOSTILE_OPTIONS)(
    'T4-LTP2-02 ambient process.env.PGOPTIONS (%s) refuses before any Pool although the explicit source is clean',
    async (_label, value) => {
      process.env.PGOPTIONS = value;
      const source = localSource();
      expect('PGOPTIONS' in source).toBe(false);
      expectRefusedBeforePool(await failure(() => openPool(source)));
    },
  );

  it.each([
    ['empty string', ''],
    ['single space', ' '],
  ])('T4-LTP2-03 ambient PGOPTIONS set but %s is refused: presence, not truthiness, is prohibited', async (_label, value) => {
    process.env.PGOPTIONS = value;
    expect(process.env.PGOPTIONS).toBe(value);
    expectRefusedBeforePool(await failure(() => openPool(localSource())));
  });

  it('T4-LTP2-04 a source whose PGOPTIONS key is explicitly undefined cannot mask a hostile ambient value', async () => {
    process.env.PGOPTIONS = `-c search_path=public -c application_name=${CANARY}`;
    const source = localSource({ PGOPTIONS: undefined });
    expect(Object.prototype.hasOwnProperty.call(source, 'PGOPTIONS')).toBe(true);
    expectRefusedBeforePool(await failure(() => openPool(source)));
  });

  it.each([
    ['hostile value', `-c search_path=public -c application_name=${CANARY}`],
    ['empty string', ''],
  ])('T4-LTP2-05 PGOPTIONS in the pinned source (%s) is refused even when process.env is clean', async (_label, value) => {
    expect(process.env.PGOPTIONS).toBeUndefined();
    expectRefusedBeforePool(await failure(() => openPool(localSource({ PGOPTIONS: value }))));
  });

  it('T4-LTP2-06 hostile DATABASE_URL / TEST_DATABASE_URL plus ambient PGOPTIONS still refuse at config without echoing any of them', async () => {
    process.env.DATABASE_URL = HOSTILE_DB_URL;
    process.env.TEST_DATABASE_URL = HOSTILE_TEST_URL;
    process.env.PGOPTIONS = `-c application_name=${CANARY}`;
    const source = localSource({ DATABASE_URL: HOSTILE_DB_URL, TEST_DATABASE_URL: HOSTILE_TEST_URL });
    expectRefusedBeforePool(await failure(() => openPool(source)));
  });

  it.each([
    ['non-loopback host', 'postgresql://mona_local_test:ltp2-secret@10.9.9.9:5432/mona_local_test'],
    ['query-string options', 'postgresql://mona_local_test:ltp2-secret@127.0.0.1:5432/mona_local_test?options=-c%20search_path%3Dpublic'],
    ['not a URL', 'ltp2-secret not a url'],
  ])('T4-LTP2-07 an invalid LOCAL URL (%s) plus PGOPTIONS refuses at config with no Pool', async (_label, url) => {
    process.env.PGOPTIONS = `-c application_name=${CANARY}`;
    expectRefusedBeforePool(await failure(() => openPool(localSource({ LOCAL_TEST_DATABASE_URL: url }))));
  });

  it('T4-LTP2-08 hostile PGHOST/PGUSER/PGDATABASE/PGPORT/PGPASSWORD (no PGOPTIONS) cannot redirect: the pool gets only the canonical connectionString', async () => {
    Object.assign(process.env, {
      PGHOST: '10.9.9.9',
      PGHOSTADDR: '10.9.9.9',
      PGPORT: '6543',
      PGUSER: 'postgres',
      PGDATABASE: 'postgres',
      PGPASSWORD: 'ltp2-pgpassword',
      PGSSLMODE: 'no-verify',
    });
    const { pool } = await openPool(localSource());
    expect(pools()).toHaveLength(1);
    const config = pools()[0]!.config as Record<string, unknown>;
    expect(config.connectionString).toBe(LOCAL_URL);
    // Every connection field pg would otherwise take from PG* comes from the
    // connectionString parse (truthy there); ssl is explicit.
    for (const field of ['host', 'port', 'user', 'database', 'password', 'options']) {
      expect(config[field]).toBeUndefined();
    }
    expect(config.ssl).toBe(false);
    await pool.end();
  });

  it.each([
    ['local-test', localSource()],
    ['automated-test', localSource({ MONA_TEST_DATABASE_TARGET: 'local' })],
  ] as const)(
    "T4-LTP2-09 openSeedDatabase('%s') with ambient PGOPTIONS refuses before any Pool or PrismaPg",
    async (target, source) => {
      process.env.PGOPTIONS = '-c search_path=public';
      const { openSeedDatabase } = await import('../scripts/demo-database.js');
      expectRefusedBeforePool(await failure(() => openSeedDatabase(target, source)));
    },
  );

  it('T4-LTP2-10 the test DB helper (default process.env source) refuses ambient PGOPTIONS before any Pool', async () => {
    const routingValues = { MONA_TEST_DATABASE_TARGET: 'local', ...localSource() } as Record<string, string>;
    standardEnv(routingValues);
    Object.assign(process.env, routingValues, { PGOPTIONS: '-c statement_timeout=0' });
    const error = await failure(() => guard().then((assertIsolation) => assertIsolation()));
    expect(pools()).toHaveLength(0);
    expect(allQueries()).toHaveLength(0);
    const everything = [error.message, String(error.stack)].join('\n');
    for (const secret of ['ltp2-secret', LOCAL_URL, 'statement_timeout']) expect(everything).not.toContain(secret);
  });

  // RED-LTP2B: PGOPTIONS that appears only AFTER the proof. pg reads it every
  // time pg-pool builds a Client (`new (options.Client || Client)(options)`,
  // pg-pool/index.js), so each later LOCAL_TEST pool or connection is its own
  // boundary: the helper's adapter config (built after the proof pool ends),
  // the PrismaPg pool (built lazily on first connect) and any reconnect of a
  // returned proven pool. The real pg Client is constructed below but never
  // connected: construction alone resolves ConnectionParameters.
  describe('T4-LTP2B LOCAL_TEST pools built after the proof reject PGOPTIONS', () => {
    type PgModule = typeof import('pg');
    type ClientCtor = new (config: unknown) => { connectionParameters: Record<string, unknown> };
    type AdapterConfig = Record<string, unknown> & { connectionString?: string };
    const adapterConfigs = () => state.adapterArgs.map((args) => args[0] as AdapterConfig);
    const AFTER_PROOF: Array<[string, string]> = [
      ['empty string', ''],
      ['single space', ' '],
      ['search_path', '-c search_path=public'],
      ['statement_timeout', `-c statement_timeout=0 -c application_name=${CANARY}`],
    ];

    async function realClientCtor(): Promise<ClientCtor> {
      const actual = (await vi.importActual<PgModule>('pg')) as PgModule & { default?: PgModule };
      return (actual.default?.Client ?? actual.Client) as unknown as ClientCtor;
    }
    // Exactly how pg-pool creates each connection's Client from its options.
    async function clientLikePgPool(config: unknown) {
      const Fallback = await realClientCtor();
      const Ctor = ((config as { Client?: ClientCtor }).Client ?? Fallback) as ClientCtor;
      return new Ctor(config);
    }
    async function refusal(action: () => unknown): Promise<Error | null> {
      try {
        await action();
        return null;
      } catch (caught) {
        return caught as Error;
      }
    }
    function expectSanitizedRefusal(error: Error | null) {
      expect(error, 'expected a refusal').not.toBeNull();
      const everything = [error!.message, String(error!.stack), JSON.stringify(error)].join('\n');
      for (const secret of [CANARY, 'ltp2-secret', LOCAL_URL, 'search_path', 'statement_timeout', '-c ', 'postgresql://']) {
        expect(everything).not.toContain(secret);
      }
    }
    function localRouting() {
      const values = { MONA_TEST_DATABASE_TARGET: 'local', ...localSource() } as Record<string, string>;
      standardEnv(values);
      Object.assign(process.env, values);
    }
    const helpers = () => import('./helpers/test-db.js');

    beforeEach(() => {
      state.onEnd = null;
    });
    afterEach(() => {
      state.onEnd = null;
    });

    it('T4-LTP2B-01 positive control: PGOPTIONS absent throughout proves on pool #1 and builds the PrismaPg adapter config', async () => {
      localRouting();
      const prisma = await (await helpers()).createTestPrismaClient();

      expect(pools()).toHaveLength(1);
      expect(pools()[0]!.ended).toBe(1);
      expect(pools()[0]!.queries.at(-1)).toBe('COMMIT');
      expect(state.events.filter((event) => event === 'PrismaPg')).toHaveLength(1);
      expect(adapterConfigs().map((config) => config.connectionString)).toEqual([LOCAL_URL]);
      const client = await clientLikePgPool(adapterConfigs()[0]);
      expect(client.connectionParameters.options).toBeUndefined();
      expect(client.connectionParameters.host).toBe('127.0.0.1');
      expect(client.connectionParameters.database).toBe('mona_local_test');
      await prisma.$disconnect();
    });

    it.each(AFTER_PROOF)(
      'T4-LTP2B-02 PGOPTIONS (%s) set after pool #1 proved and ended refuses before the PrismaPg adapter is built',
      async (_label, value) => {
        localRouting();
        state.onEnd = () => {
          process.env.PGOPTIONS = value;
        };
        const error = await refusal(async () => (await helpers()).createTestPrismaClient());

        expect(process.env.PGOPTIONS).toBe(value); // the hook really ran after the proof
        expect(pools()).toHaveLength(1); // pool #1 exists: the proof itself was clean
        expect(pools()[0]!.ended).toBe(1);
        expect(pools()[0]!.queries.some((sql) => sql.includes('FROM mona_local_test_guard.database_identity'))).toBe(true);
        expectSanitizedRefusal(error);
        expect(state.events).not.toContain('PrismaPg'); // no second-pool owner
        expect(state.adapterArgs).toHaveLength(0);
      },
    );

    it('T4-LTP2B-03 a clean first client does not cache approval: the next client refuses PGOPTIONS introduced after its proof', async () => {
      localRouting();
      const { createTestPrismaClient } = await helpers();
      const first = await createTestPrismaClient();
      await first.$disconnect();
      state.onEnd = () => {
        process.env.PGOPTIONS = '';
      };
      const error = await refusal(() => createTestPrismaClient());

      expect(pools()).toHaveLength(2);
      expectSanitizedRefusal(error);
      expect(state.events.filter((event) => event === 'PrismaPg')).toHaveLength(1);
    });

    it.each(AFTER_PROOF)(
      'T4-LTP2B-04 PGOPTIONS (%s) set after the adapter exists refuses when PrismaPg would build pool #2 connections',
      async (_label, value) => {
        localRouting();
        const prisma = await (await helpers()).createTestPrismaClient();
        const [config] = adapterConfigs();
        const before = JSON.stringify(Object.keys(config!).sort());
        process.env.PGOPTIONS = value;

        const error = await refusal(() => clientLikePgPool(config));

        expectSanitizedRefusal(error);
        expect(JSON.stringify(Object.keys(config!).sort())).toBe(before);
        await prisma.$disconnect();
      },
    );

    it.each(AFTER_PROOF)(
      'T4-LTP2B-05 a returned proven pool refuses to open a new connection once PGOPTIONS (%s) appears; the pinned source is untouched',
      async (_label, value) => {
        const { openProvenLocalTestPool } = await import('../scripts/demo-database.js');
        const source = localSource();
        const frozen = JSON.stringify(source);
        const { pool } = await openProvenLocalTestPool(1, source);
        process.env.PGOPTIONS = value;

        const error = await refusal(() => clientLikePgPool(pools()[0]!.config));

        expectSanitizedRefusal(error);
        expect(JSON.stringify(source)).toBe(frozen);
        expect(pools()).toHaveLength(1);
        await pool.end();
      },
    );

    it.each(AFTER_PROOF)(
      'T4-LTP2B-06 localTestPoolConfig used directly while PGOPTIONS (%s) is set yields no usable connection',
      async (_label, value) => {
        const { localTestPoolConfig } = await import('../scripts/demo-database.js');
        process.env.PGOPTIONS = value;

        const error = await refusal(async () => clientLikePgPool(localTestPoolConfig(LOCAL_URL, 5)));

        expectSanitizedRefusal(error);
        expect(pools()).toHaveLength(0);
      },
    );

    it('T4-LTP2B-07 observation: hostile PGHOST/PGUSER/PGDATABASE/PGPORT/PGPASSWORD/DATABASE_URL after the proof cannot redirect pool #2', async () => {
      localRouting();
      const prisma = await (await helpers()).createTestPrismaClient();
      Object.assign(process.env, {
        PGHOST: '10.9.9.9',
        PGPORT: '6543',
        PGUSER: 'postgres',
        PGDATABASE: 'postgres',
        PGPASSWORD: 'ltp2-pgpassword',
        DATABASE_URL: HOSTILE_DB_URL,
        TEST_DATABASE_URL: HOSTILE_TEST_URL,
      });

      const client = await clientLikePgPool(adapterConfigs()[0]);
      expect(client.connectionParameters.host).toBe('127.0.0.1');
      expect(client.connectionParameters.port).toBe(5432);
      expect(client.connectionParameters.user).toBe('mona_local_test');
      expect(client.connectionParameters.database).toBe('mona_local_test');
      expect((client as unknown as { password: string }).password).toBe('ltp2-secret');
      expect(client.connectionParameters.options).toBeUndefined();
      await prisma.$disconnect();
    });
  });
});

// RED5A: routes the test DB helper boundary (assertTestDatabaseIsolation) by
// MONA_TEST_DATABASE_TARGET. The selector and LOCAL_TEST variables are written
// identically to the fake .env.development and to process.env, so these tests
// do not decide which of the two sources the helper reads.
describe('Task 4 test DB helper target routing', () => {
  const LOCAL_MARKER = '3cc8a898-33c5-46c8-8c71-560ee5f6cffd';
  const LOCAL_URL =
    'postgresql://mona_local_test:local-secret@127.0.0.1:5432/mona_local_test';
  const ROUTING_KEYS = [
    'MONA_TEST_DATABASE_TARGET',
    'LOCAL_TEST_DATABASE_URL',
    'LOCAL_TEST_DATABASE_MARKER_ID',
  ] as const;
  const saved = Object.fromEntries(ROUTING_KEYS.map((k) => [k, process.env[k]]));

  const markedLocal = (overrides: Partial<NonNullable<FakeDb['local']>> = {}): FakeDb => ({
    ...unmarked('mona_local_test', '127.0.0.1'),
    local: {
      database: 'mona_local_test',
      user: 'mona_local_test',
      version: 'PostgreSQL 17.11 (synthetic)',
      rows: [{ environment: 'local_test', marker_id: LOCAL_MARKER, has_installed_at: true }],
      ...overrides,
    },
  });

  function routing(values: Partial<Record<(typeof ROUTING_KEYS)[number], string>>) {
    standardEnv(values);
    for (const key of ROUTING_KEYS) {
      const value = values[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  const localVars = { LOCAL_TEST_DATABASE_URL: LOCAL_URL, LOCAL_TEST_DATABASE_MARKER_ID: LOCAL_MARKER };
  const urls = () => pools().map((pool) => pool.config.connectionString);
  const allQueries = () => pools().flatMap((pool) => pool.queries);

  beforeEach(() => {
    state.databases.set(LOCAL_URL, markedLocal());
  });
  afterEach(() => {
    for (const key of ROUTING_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it.each([
    ['T4-HR-01 absent selector', {}],
    ['T4-HR-02 explicit test selector', { MONA_TEST_DATABASE_TARGET: 'test' }],
  ])('%s keeps hosted TEST even when LOCAL_TEST variables are present', async (_label, selector) => {
    routing({ ...localVars, ...selector });

    await expect((await guard())()).resolves.toBeUndefined();

    expect(urls().length).toBeGreaterThan(0);
    for (const url of urls()) expect(url).toBe(TEST_URL);
    expect(allQueries().some((sql) => sql.includes('FROM mona_test_guard.database_identity'))).toBe(true);
    expect(allQueries().some((sql) => sql.includes('mona_local_test_guard'))).toBe(false);
  });

  it('T4-HR-03 local selector proves LOCAL_TEST only, on one checked-out connection, and closes its pool', async () => {
    routing({ MONA_TEST_DATABASE_TARGET: 'local', ...localVars });

    await expect((await guard())()).resolves.toBeUndefined();

    expect(urls().length).toBeGreaterThan(0);
    for (const url of urls()) expect(url).toBe(LOCAL_URL);
    const queries = allQueries();
    expect(queries[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(queries.some((sql) => sql.includes('FROM mona_local_test_guard.database_identity'))).toBe(true);
    expect(queries.at(-1)).toBe('COMMIT');
    expect(queries.some((sql) => sql.includes('mona_test_guard.'))).toBe(false);
    // A transaction needs one dedicated connection, not pool.query round-robin.
    expect(pools().some((pool) => pool.released.length > 0)).toBe(true);
    expect(pools().every((pool) => pool.ended === 1)).toBe(true);
  });

  it.each([
    ['hosted TEST marker environment', () => markedLocal({ rows: [{ environment: 'test', marker_id: LOCAL_MARKER, has_installed_at: true }] })],
    ['wrong database', () => markedLocal({ database: 'postgres' })],
    ['unreachable LOCAL_TEST database', () => undefined],
  ])('T4-HR-04 local selector refuses on %s and never falls back to hosted TEST', async (_label, db) => {
    const fake = db();
    if (fake) state.databases.set(LOCAL_URL, fake);
    else state.databases.delete(LOCAL_URL);
    routing({ MONA_TEST_DATABASE_TARGET: 'local', ...localVars });

    await expect((await guard())()).rejects.toThrow();

    expect(urls()).not.toContain(TEST_URL);
    expect(allQueries()).not.toContain('COMMIT');
  });

  it.each([
    ['missing LOCAL_TEST_DATABASE_URL', { LOCAL_TEST_DATABASE_MARKER_ID: LOCAL_MARKER }],
    ['missing LOCAL_TEST_DATABASE_MARKER_ID', { LOCAL_TEST_DATABASE_URL: LOCAL_URL }],
    [
      'localhost alias instead of the pinned loopback address',
      {
        LOCAL_TEST_DATABASE_URL: 'postgresql://mona_local_test:local-secret@localhost:5432/mona_local_test',
        LOCAL_TEST_DATABASE_MARKER_ID: LOCAL_MARKER,
      },
    ],
  ])('T4-HR-05 local selector with %s fails closed before any pool', async (_label, vars) => {
    routing({ MONA_TEST_DATABASE_TARGET: 'local', ...vars });

    await expect((await guard())()).rejects.toThrow();

    expect(pools()).toHaveLength(0);
  });

  it.each(['LOCAL', 'pilot', 'production', ''])(
    'T4-HR-06 unknown selector %j fails closed before any pool',
    async (selector) => {
      routing({ MONA_TEST_DATABASE_TARGET: selector, ...localVars });

      await expect((await guard())()).rejects.toThrow();

      expect(pools()).toHaveLength(0);
    },
  );

  // RED5B: createTestPrismaClient follows the same selector. Nested to reuse the
  // routing fixtures above. The helper only builds a PrismaClient around a
  // PrismaPg adapter, so adapter constructions stand in for client constructions.
  describe('Task 4 LOCAL_TEST Prisma proven-client lifecycle', () => {
    type AdapterConfig = { connectionString?: string; ssl?: unknown };
    const adapterConfigs = () => state.adapterArgs.map((args) => args[0] as AdapterConfig);
    const helpers = () => import('./helpers/test-db.js');
    const local = { MONA_TEST_DATABASE_TARGET: 'local', ...localVars };

    beforeEach(() => {
      state.events.length = 0;
    });

    it.each([
      ['T4-PC-01 absent selector', {}],
      ['T4-PC-01 explicit test selector', { MONA_TEST_DATABASE_TARGET: 'test' }],
    ])('%s builds the hosted TEST adapter even when LOCAL_TEST variables are present', async (_label, selector) => {
      routing({ ...localVars, ...selector });

      const prisma = await (await helpers()).createTestPrismaClient();

      expect(adapterConfigs().map((config) => config.connectionString)).toEqual([TEST_URL]);
      for (const url of urls()) expect(url).toBe(TEST_URL);
      expect(allQueries().some((sql) => sql.includes('mona_local_test_guard'))).toBe(false);
      await prisma.$disconnect();
    });

    it('T4-PC-02 local selector builds exactly one LOCAL_TEST adapter without the hosted TLS configuration', async () => {
      routing(local);

      const prisma = await (await helpers()).createTestPrismaClient();

      expect(adapterConfigs().map((config) => config.connectionString)).toEqual([LOCAL_URL]);
      expect(adapterConfigs()[0]?.ssl ?? false).toBe(false);
      expect(urls().length).toBeGreaterThan(0);
      for (const url of urls()) expect(url).toBe(LOCAL_URL);
      expect(pools().every((pool) => pool.ended === 1)).toBe(true);
      expect(allQueries().some((sql) => sql.includes('mona_test_guard.'))).toBe(false);
      await prisma.$disconnect();
    });

    it('T4-PC-03 local selector proves LOCAL_TEST before constructing the Prisma adapter', async () => {
      routing(local);

      const prisma = await (await helpers()).createTestPrismaClient();

      const adapter = state.events.indexOf('PrismaPg');
      const marker = state.events.findIndex((event) =>
        event.includes('FROM mona_local_test_guard.database_identity'),
      );
      expect(marker).toBeGreaterThanOrEqual(0);
      expect(adapter).toBeGreaterThan(marker);
      expect(state.events.lastIndexOf('COMMIT', adapter)).toBeGreaterThan(marker);
      await prisma.$disconnect();
    });

    it.each([
      ['hosted TEST marker environment', () => markedLocal({ rows: [{ environment: 'test', marker_id: LOCAL_MARKER, has_installed_at: true }] })],
      ['wrong database', () => markedLocal({ database: 'postgres' })],
      ['unreachable LOCAL_TEST database', () => undefined],
    ])('T4-PC-04 local refusal on %s builds no Prisma adapter and never falls back to hosted TEST', async (_label, db) => {
      const fake = db();
      if (fake) state.databases.set(LOCAL_URL, fake);
      else state.databases.delete(LOCAL_URL);
      routing(local);

      // failure() rather than .rejects: formatting a resolved PrismaClient overflows the stack.
      const { createTestPrismaClient } = await helpers();
      await failure(() => createTestPrismaClient());

      expect(state.adapterArgs).toHaveLength(0);
      expect(urls()).not.toContain(TEST_URL);
    });

    it.each([
      ['unknown selector "pilot"', { MONA_TEST_DATABASE_TARGET: 'pilot', ...localVars }],
      [
        'a localhost LOCAL_TEST URL',
        {
          ...local,
          LOCAL_TEST_DATABASE_URL: 'postgresql://mona_local_test:local-secret@localhost:5432/mona_local_test',
        },
      ],
    ])('T4-PC-05 %s fails closed before any pool or Prisma adapter', async (_label, values) => {
      routing(values);

      // failure() rather than .rejects: formatting a resolved PrismaClient overflows the stack.
      const { createTestPrismaClient } = await helpers();
      await failure(() => createTestPrismaClient());

      expect(state.adapterArgs).toHaveLength(0);
      expect(pools()).toHaveLength(0);
    });

    it('T4-PC-06 a LOCAL_TEST-proven client passes the destructive-helper guards; a stranger still does not', async () => {
      routing(local);
      const { createTestPrismaClient, truncateAllTables, withTransaction } = await helpers();

      const prisma = await createTestPrismaClient();
      expect(adapterConfigs().map((config) => config.connectionString)).toEqual([LOCAL_URL]);

      // Guards only: the SQL entry points are stubbed, so nothing reaches a database.
      const execute = vi.spyOn(prisma, '$executeRawUnsafe').mockResolvedValue(0);
      const transaction = vi
        .spyOn(prisma, '$transaction')
        .mockImplementation((async () => 'tx-ok') as never);
      await expect(truncateAllTables(prisma)).resolves.toBeUndefined();
      expect(execute).toHaveBeenCalledTimes(1);
      await expect(withTransaction(prisma, async () => 'unused')).resolves.toBe('tx-ok');
      expect(transaction).toHaveBeenCalledTimes(1);

      const { PrismaClient } = await import('../src/generated/prisma/client.js');
      const { PrismaPg } = await import('@prisma/adapter-pg');
      const stranger = new PrismaClient({ adapter: new PrismaPg({ connectionString: LOCAL_URL }), log: [] });
      await expect(truncateAllTables(stranger)).rejects.toThrow('proven test client');
      expect(() => withTransaction(stranger, async () => 1)).toThrow('proven test client');
      await stranger.$disconnect();
      await prisma.$disconnect();
    });
  });

  // RED5C: tests/globalSetup.ts (invoked manually here; the harness config has no
  // globalSetup) must clean only the selected, proven target, in setup and in the
  // teardown it returns, even if process.env changes in between.
  describe('Task 4 globalSetup target routing', () => {
    const local = { MONA_TEST_DATABASE_TARGET: 'local', ...localVars };
    const globalSetup = async () => (await import('./globalSetup.js')).default;

    beforeEach(() => {
      state.events.length = 0;
      state.cleanups.length = 0;
    });

    it.each([
      ['T4-GS-01 absent selector', {}],
      ['T4-GS-01 explicit test selector', { MONA_TEST_DATABASE_TARGET: 'test' }],
    ])('%s cleans hosted TEST in setup and teardown even when LOCAL_TEST variables are present', async (_label, selector) => {
      routing({ ...localVars, ...selector });

      const teardown = await (await globalSetup())();
      await teardown();

      expect(state.cleanups).toEqual([TEST_URL, TEST_URL]);
      for (const url of urls()) expect(url).toBe(TEST_URL);
      expect(pools().every((pool) => pool.ended === 1)).toBe(true);
      expect(allQueries().some((sql) => sql.includes('mona_local_test_guard'))).toBe(false);
    });

    it('T4-GS-02 hosted teardown stays on hosted TEST when the selector changes to local after setup', async () => {
      routing(localVars);
      const teardown = await (await globalSetup())();

      routing(local);
      await teardown();

      expect(state.cleanups).toEqual([TEST_URL, TEST_URL]);
      expect(urls()).not.toContain(LOCAL_URL);
    });

    it('T4-GS-03 local selector cleans LOCAL_TEST only, after proving it', async () => {
      routing(local);

      await (await globalSetup())();

      expect(state.cleanups).toEqual([LOCAL_URL]);
      expect(urls()).not.toContain(TEST_URL);
      expect(allQueries().some((sql) => sql.includes('mona_test_guard.'))).toBe(false);
      const cleanup = state.events.indexOf('cleanup');
      const marker = state.events.findIndex((event) =>
        event.includes('FROM mona_local_test_guard.database_identity'),
      );
      expect(marker).toBeGreaterThanOrEqual(0);
      expect(cleanup).toBeGreaterThan(marker);
      expect(state.events.lastIndexOf('COMMIT', cleanup)).toBeGreaterThan(marker);
    });

    it('T4-GS-04 local teardown stays on LOCAL_TEST when the selector is removed after setup', async () => {
      routing(local);
      const teardown = await (await globalSetup())();

      routing(localVars);
      await teardown();

      expect(state.cleanups).toEqual([LOCAL_URL, LOCAL_URL]);
      expect(urls()).not.toContain(TEST_URL);
    });

    it.each([
      ['hosted TEST marker environment', () => markedLocal({ rows: [{ environment: 'test', marker_id: LOCAL_MARKER, has_installed_at: true }] })],
      ['wrong database', () => markedLocal({ database: 'postgres' })],
      ['unreachable LOCAL_TEST database', () => undefined],
    ])('T4-GS-05 local refusal on %s cleans nothing and never falls back to hosted TEST', async (_label, db) => {
      const fake = db();
      if (fake) state.databases.set(LOCAL_URL, fake);
      else state.databases.delete(LOCAL_URL);
      routing(local);

      const setup = await globalSetup();
      await failure(() => setup());

      expect(state.cleanups).toHaveLength(0);
      expect(urls()).not.toContain(TEST_URL);
    });

    it.each([
      ['unknown selector "pilot"', { MONA_TEST_DATABASE_TARGET: 'pilot', ...localVars }],
      [
        'a localhost LOCAL_TEST URL',
        {
          ...local,
          LOCAL_TEST_DATABASE_URL: 'postgresql://mona_local_test:local-secret@localhost:5432/mona_local_test',
        },
      ],
    ])('T4-GS-06 %s fails closed before any pool or cleanup', async (_label, values) => {
      routing(values);

      const setup = await globalSetup();
      await failure(() => setup());

      expect(state.cleanups).toHaveLength(0);
      expect(pools()).toHaveLength(0);
    });
  });

  // RED5D: openSeedDatabase('automated-test', source) is the only target the
  // selector affects, and `source` (not process.env) decides it. Explicit
  // 'test', 'local-test' and 'demo' keep their meaning whatever the selector says.
  describe('Task 4 automated SeedDatabase target routing', () => {
    type Opened = { targetUrl: string; close: () => Promise<void> };
    const local = { MONA_TEST_DATABASE_TARGET: 'local', ...localVars };
    const open = async (target: string, source: NodeJS.ProcessEnv) => {
      const { openSeedDatabase } = await import('../scripts/demo-database.js');
      return (openSeedDatabase as unknown as (t: string, s: NodeJS.ProcessEnv) => Promise<Opened>)(target, source);
    };
    const adapterUrl = () =>
      (state.adapterArgs.at(-1)?.[0] as { record?: { config: { connectionString?: string } } } | undefined)?.record
        ?.config.connectionString;
    const expectHosted = (db: Opened) => {
      expect(db.targetUrl).toBe(TEST_URL);
      expect(adapterUrl()).toBe(TEST_URL);
      for (const url of urls()) expect(url).toBe(TEST_URL);
      expect(allQueries().some((sql) => sql.includes('FROM mona_test_guard.database_identity'))).toBe(true);
      expect(allQueries().some((sql) => sql.includes('mona_local_test_guard'))).toBe(false);
    };
    const expectLocal = (db: Opened) => {
      expect(db.targetUrl).toBe(LOCAL_URL);
      expect(adapterUrl()).toBe(LOCAL_URL);
      for (const url of urls()) expect(url).toBe(LOCAL_URL);
      expect(allQueries().some((sql) => sql.includes('FROM mona_local_test_guard.database_identity'))).toBe(true);
      expect(allQueries().some((sql) => sql.includes('mona_test_guard.'))).toBe(false);
    };

    it.each([
      ['T4-SD-01 absent selector', {}],
      ['T4-SD-01 test selector', { MONA_TEST_DATABASE_TARGET: 'test' }],
    ])('%s: automated-test opens proven hosted TEST even with LOCAL_TEST variables', async (_label, selector) => {
      routing({ ...localVars, ...selector });

      const db = await open('automated-test', { ...localVars, ...selector });
      try {
        expectHosted(db);
      } finally {
        await db.close();
      }
    });

    it('T4-SD-02 local selector: automated-test opens proven LOCAL_TEST only', async () => {
      routing(localVars);

      const db = await open('automated-test', local);
      try {
        expectLocal(db);
      } finally {
        await db.close();
      }
    });

    // The message check separates "selector refused" from any outer-target failure.
    it.each(['pilot', 'LOCAL', 'production', ''])(
      'T4-SD-03 automated-test with selector %j fails closed before any pool',
      async (selector) => {
        routing(localVars);

        const error = await failure(() => open('automated-test', { ...localVars, MONA_TEST_DATABASE_TARGET: selector }));

        expect(error.message).toMatch(/MONA_TEST_DATABASE_TARGET/);
        expect(pools()).toHaveLength(0);
      },
    );

    it.each([
      ['missing LOCAL_TEST_DATABASE_URL', { MONA_TEST_DATABASE_TARGET: 'local', LOCAL_TEST_DATABASE_MARKER_ID: LOCAL_MARKER }],
      [
        'a localhost alias',
        { ...local, LOCAL_TEST_DATABASE_URL: 'postgresql://mona_local_test:local-secret@localhost:5432/mona_local_test' },
      ],
    ])('T4-SD-04 automated-test local with %s fails closed before any pool', async (_label, source) => {
      routing(localVars);

      const error = await failure(() => open('automated-test', source));

      expect(error.message).toMatch(/target=LOCAL_TEST phase=config/);
      expect(pools()).toHaveLength(0);
    });

    it('T4-SD-05 automated-test local identity refusal never falls back to hosted TEST', async () => {
      state.databases.set(LOCAL_URL, markedLocal({ database: 'postgres' }));
      routing(localVars);

      const error = await failure(() => open('automated-test', local));

      expect(error.message).toMatch(/target=LOCAL_TEST phase=identity/);
      expect(urls()).not.toContain(TEST_URL);
      expect(allQueries()).not.toContain('COMMIT');
    });

    it('T4-SD-06 explicit test stays hosted TEST when the selector says local', async () => {
      routing(local);

      const db = await open('test', local);
      try {
        expectHosted(db);
      } finally {
        await db.close();
      }
    });

    it('T4-SD-07 explicit local-test stays LOCAL_TEST when the selector says test', async () => {
      const source = { ...localVars, MONA_TEST_DATABASE_TARGET: 'test' };
      routing(source);

      const db = await open('local-test', source);
      try {
        expectLocal(db);
      } finally {
        await db.close();
      }
    });

    // openDemoDatabase refuses any shell DATABASE_URL/TEST_DATABASE_URL that differs
    // from .env.development (fake here). This test owns both for its lifetime, so
    // an ambient value (tests/setup.ts's placeholder, a CI value, an earlier test)
    // cannot decide it; the prior presence and value are restored afterwards.
    it('T4-SD-08 explicit demo stays DEMO when the selector says local', async () => {
      const shellKeys = ['DATABASE_URL', 'TEST_DATABASE_URL'] as const;
      const savedShell = Object.fromEntries(shellKeys.map((k) => [k, process.env[k]]));
      for (const key of shellKeys) delete process.env[key];
      try {
        routing(local);
        process.env.NODE_ENV = 'development';

        const db = await open('demo', local);
        try {
          expect(db.targetUrl).toBe(DEV_URL);
          expect(urls()).not.toContain(LOCAL_URL);
        } finally {
          await db.close();
        }
      } finally {
        for (const key of shellKeys) {
          if (savedShell[key] === undefined) delete process.env[key];
          else process.env[key] = savedShell[key];
        }
      }
    });

    // The refusal T4-SD-08 sidesteps: a shell DATABASE_URL/TEST_DATABASE_URL that
    // differs from .env.development (fake here) is refused before any pool or
    // adapter exists; a shell value equal to the file is not. Each test owns both
    // keys and restores their prior presence and value.
    async function withShell(values: Partial<Record<'DATABASE_URL' | 'TEST_DATABASE_URL', string>>, fn: () => Promise<void>) {
      const shellKeys = ['DATABASE_URL', 'TEST_DATABASE_URL'] as const;
      const savedShell = Object.fromEntries(shellKeys.map((k) => [k, process.env[k]]));
      for (const key of shellKeys) delete process.env[key];
      Object.assign(process.env, values);
      try {
        routing(local);
        process.env.NODE_ENV = 'development';
        await fn();
      } finally {
        for (const key of shellKeys) {
          if (savedShell[key] === undefined) delete process.env[key];
          else process.env[key] = savedShell[key];
        }
      }
    }

    it.each([
      ['DATABASE_URL naming another database', { DATABASE_URL: 'postgresql://postgres.hostile:hostile-pw@10.9.9.9:5432/postgres' }],
      ['DATABASE_URL naming LOCAL_TEST', { DATABASE_URL: LOCAL_URL }],
      ['TEST_DATABASE_URL naming the DEMO database', { TEST_DATABASE_URL: DEV_URL }],
    ])('T4-SD-11 explicit demo refuses a shell %s before any pool', async (_label, shell) => {
      await withShell(shell, async () => {
        const error = await failure(() => open('demo', local));

        expect(error.message).toBe('Shell database overrides do not match local demo configuration');
        expect(pools()).toHaveLength(0);
        expect(state.adapterArgs).toHaveLength(0);
      });
    });

    it('T4-SD-12 explicit demo accepts shell values equal to .env.development', async () => {
      await withShell({ DATABASE_URL: DEV_URL, TEST_DATABASE_URL: TEST_URL }, async () => {
        const db = await open('demo', local);
        try {
          expect(db.targetUrl).toBe(DEV_URL);
        } finally {
          await db.close();
        }
      });
    });

    it('T4-SD-09 the source argument, not process.env, selects LOCAL_TEST', async () => {
      routing({ ...localVars, MONA_TEST_DATABASE_TARGET: 'test' });

      const db = await open('automated-test', local);
      try {
        expectLocal(db);
      } finally {
        await db.close();
      }
    });

    it('T4-SD-09 the source argument, not process.env, keeps hosted TEST', async () => {
      routing(local);

      const db = await open('automated-test', {});
      try {
        expectHosted(db);
      } finally {
        await db.close();
      }
    });

    it('T4-SD-10 an unknown outer target fails closed instead of falling through to DEMO', async () => {
      routing(localVars);

      await failure(() => open('pilot', {}));

      expect(pools()).toHaveLength(0);
    });
  });
});

// Task 4 RED6B: api/prisma.local-test.config.ts is loaded through Prisma's own
// config loader (c12 + jiti with moduleCache off and dotenv off), outside
// Vitest's module graph, so the pg/dotenv/fs mocks above do not reach it and
// every load re-evaluates the file against the current process.env. Outcomes
// are asserted as labels, never as URLs, so a wrong config cannot print a
// connection string.
describe('Task 4 LOCAL_TEST Prisma config contract', () => {
  const LOCAL_URL = 'postgresql://mona_local_test:local-secret@127.0.0.1:5432/mona_local_test';
  const KEYS = [
    'LOCAL_TEST_DATABASE_URL',
    'LOCAL_TEST_DATABASE_MARKER_ID',
    'DATABASE_URL',
    'TEST_DATABASE_URL',
    'DIRECT_URL',
    'PGHOST',
    'PGPORT',
    'PGUSER',
    'PGPASSWORD',
    'PGDATABASE',
    'PGSSLMODE',
  ] as const;
  type Vars = Partial<Record<(typeof KEYS)[number], string>>;
  let saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
    for (const key of KEYS) delete process.env[key];
  });
  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  async function paths() {
    const { fileURLToPath } = await import('node:url');
    const { join } = await import('node:path');
    const root = fileURLToPath(new URL('../', import.meta.url));
    return { root, file: join(root, 'prisma.local-test.config.ts'), schema: join(root, 'prisma', 'schema.prisma') };
  }
  async function load(vars: Vars) {
    for (const [key, value] of Object.entries(vars)) process.env[key] = value;
    const { loadConfigFromFile } = await import('@prisma/config');
    const { root, file } = await paths();
    return loadConfigFromFile({ configFile: file, configRoot: root });
  }
  type Loaded = Awaited<ReturnType<typeof load>>;
  // 'refused' means the config itself threw while loading; a missing or
  // unparsable file is a load error, never a refusal.
  const outcome = (loaded: Loaded, expected = LOCAL_URL) =>
    loaded.error
      ? loaded.error._tag === 'ConfigLoadError'
        ? 'refused'
        : `load-error:${loaded.error._tag}`
      : loaded.config.datasource?.url === expected
        ? 'loaded:expected-url'
        : 'loaded:other-url';

  it("T4-CFG-01 loads the explicit config file through Prisma's loader with the repository schema", async () => {
    const loaded = await load({ LOCAL_TEST_DATABASE_URL: LOCAL_URL });
    const { file, schema } = await paths();
    expect(loaded.error?._tag).toBeUndefined();
    expect(loaded.resolvedPath).toBe(file);
    expect(loaded.config?.schema).toBe(schema);
  });

  it.each([
    ['postgresql:', LOCAL_URL],
    ['postgres:', LOCAL_URL.replace(/^postgresql:/, 'postgres:')],
  ])('T4-CFG-02 a canonical %s LOCAL_TEST_DATABASE_URL is exactly the datasource URL', async (_protocol, url) => {
    expect(outcome(await load({ LOCAL_TEST_DATABASE_URL: url }), url)).toBe('loaded:expected-url');
  });

  it('T4-CFG-03 DATABASE_URL, TEST_DATABASE_URL, DIRECT_URL and PG* cannot redirect a valid LOCAL_TEST config', async () => {
    const loaded = await load({
      LOCAL_TEST_DATABASE_URL: LOCAL_URL,
      DATABASE_URL: DEV_URL,
      TEST_DATABASE_URL: TEST_URL,
      DIRECT_URL: DEV_URL,
      PGHOST: 'aws-0-dev.pooler.supabase.com',
      PGPORT: '6543',
      PGUSER: 'postgres.devrefbbbbbbbbbbbbbb',
      PGPASSWORD: DEV_SECRET,
      PGDATABASE: 'postgres',
      PGSSLMODE: 'require',
    });
    expect(outcome(loaded)).toBe('loaded:expected-url');
  });

  it('T4-CFG-04 the datasource URL carries no hosted TLS augmentation or query', async () => {
    const loaded = await load({ LOCAL_TEST_DATABASE_URL: LOCAL_URL });
    const url = loaded.config?.datasource?.url ?? '';
    expect({ loaded: !loaded.error, tls: /ssl|supabase|uselibpqcompat/i.test(url), query: url.includes('?') }).toEqual({
      loaded: true,
      tls: false,
      query: false,
    });
  });

  it.each<[string, Vars]>([
    ['a missing LOCAL_TEST_DATABASE_URL', {}],
    ['a missing LOCAL_TEST_DATABASE_URL even with DATABASE_URL and TEST_DATABASE_URL set', { DATABASE_URL: DEV_URL, TEST_DATABASE_URL: TEST_URL }],
    ['an empty LOCAL_TEST_DATABASE_URL', { LOCAL_TEST_DATABASE_URL: '' }],
    ['a localhost alias', { LOCAL_TEST_DATABASE_URL: LOCAL_URL.replace('127.0.0.1', 'localhost') }],
    ['IPv6 loopback', { LOCAL_TEST_DATABASE_URL: LOCAL_URL.replace('127.0.0.1', '[::1]') }],
    ['a remote host', { LOCAL_TEST_DATABASE_URL: LOCAL_URL.replace('127.0.0.1', 'db.example.com') }],
    ['a hosted Supabase target', { LOCAL_TEST_DATABASE_URL: TEST_URL }],
    ['a wrong port', { LOCAL_TEST_DATABASE_URL: LOCAL_URL.replace(':5432/', ':5433/') }],
    ['a wrong database', { LOCAL_TEST_DATABASE_URL: LOCAL_URL.replace(/\/mona_local_test$/, '/postgres') }],
    ['a wrong username', { LOCAL_TEST_DATABASE_URL: LOCAL_URL.replace('//mona_local_test:', '//postgres:') }],
    ['a missing password', { LOCAL_TEST_DATABASE_URL: 'postgresql://mona_local_test@127.0.0.1:5432/mona_local_test' }],
    ['an empty password', { LOCAL_TEST_DATABASE_URL: 'postgresql://mona_local_test:@127.0.0.1:5432/mona_local_test' }],
    ['an sslmode query', { LOCAL_TEST_DATABASE_URL: `${LOCAL_URL}?sslmode=require` }],
    ['an sslcert query', { LOCAL_TEST_DATABASE_URL: `${LOCAL_URL}?sslcert=/tmp/ca.crt` }],
    ['a fragment', { LOCAL_TEST_DATABASE_URL: `${LOCAL_URL}#x` }],
    ['surrounding whitespace', { LOCAL_TEST_DATABASE_URL: ` ${LOCAL_URL} ` }],
    ['an unparsable value', { LOCAL_TEST_DATABASE_URL: 'not a url' }],
    ['malformed percent-encoding in the username', { LOCAL_TEST_DATABASE_URL: LOCAL_URL.replace('//mona_local_test:', '//mona_local_test%ZZ:') }],
    ['a non-PostgreSQL protocol', { LOCAL_TEST_DATABASE_URL: LOCAL_URL.replace(/^postgresql:/, 'mysql:') }],
  ])('T4-CFG-05 refuses %s', async (_label, vars) => {
    expect(outcome(await load(vars))).toBe('refused');
  });

  it('T4-CFG-06 the config imports nothing that can read env files or open a connection, and names no other target', async () => {
    const ts = (await import('typescript')).default;
    const { readFileSync } = await import('node:fs');
    const { file } = await paths();
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const imports: string[] = [];
    const envReads: string[] = [];
    const literals: string[] = [];
    const visit = (node: import('typescript').Node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        imports.push(node.moduleSpecifier.text);
      }
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
        const [arg] = node.arguments;
        imports.push(arg && ts.isStringLiteralLike(arg) ? arg.text : '<dynamic>');
      }
      if (ts.isPropertyAccessExpression(node) && node.expression.getText(source) === 'process.env') envReads.push(node.name.text);
      if (ts.isStringLiteralLike(node)) literals.push(node.text);
      ts.forEachChild(node, visit);
    };
    visit(source);
    const forbiddenNames = ['DATABASE_URL', 'TEST_DATABASE_URL', 'DIRECT_URL', 'PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGSSLMODE'];
    expect(imports.filter((m) => m !== 'prisma/config' && !m.startsWith('node:'))).toEqual([]);
    expect(envReads.filter((name) => name !== 'LOCAL_TEST_DATABASE_URL')).toEqual([]);
    expect(literals.filter((s) => forbiddenNames.includes(s) || /supabase|\.env|ssl/i.test(s))).toEqual([]);
  });
});
