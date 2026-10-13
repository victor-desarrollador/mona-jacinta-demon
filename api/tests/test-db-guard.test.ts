// TEST-H1: zero-database tests for the TEST identity guard. `pg` and the
// `.env.development` read are replaced with in-memory fakes, so nothing here can
// open a socket: every "database" below is a scripted answer keyed by URL.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHILD_PATTERN_VAR, CHILD_RESULT_PREFIX } from './helpers/d5h-guard-child-runner.js';

// D5H-I1b.1: the D5H gate decision is pinned for the life of the PROCESS (it survives
// vi.resetModules), so a case about a specific start-up state runs in a child Vitest
// process started in exactly that state (see the D5H-I1b block at the end). A child gets
// this variable; a worker that itself STARTED gated cannot host the non-gate cases and
// hands them to one child instead.
const CHILD_SUBJECT_VAR = 'MONA_D5H_GUARD_CHILD_SUBJECT';
const CHILD_SUBJECT = process.env[CHILD_SUBJECT_VAR];
const STARTED_GATED =
  CHILD_SUBJECT === undefined && process.env.MONA_D5H_PINNED_TEST_TARGET !== undefined;
const LAUNCH_TAG = '[launch]';

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
  // D5H-I1b: observed reads of the ignored repository file and dotenv loads.
  envReads: 0,
  dotenvCalls: 0,
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
      state.envReads += 1;
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
    state.dotenvCalls += 1;
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
  // D5H-I1b: the pinned gate channel is a target-selection control too.
  'MONA_D5H_PINNED_TEST_TARGET',
] as const;
let ambientTarget: Record<string, string | undefined> = {};

beforeEach((context) => {
  ambientTarget = Object.fromEntries(AMBIENT_TARGET_KEYS.map((k) => [k, process.env[k]]));
  if (STARTED_GATED && !context.task.name.includes(LAUNCH_TAG)) context.skip();
  // A child keeps the pinned variable it was started with: that start-up state is the
  // subject of its cases (the cases themselves delete or mutate it where relevant).
  for (const key of AMBIENT_TARGET_KEYS) {
    if (CHILD_SUBJECT !== undefined && key === 'MONA_D5H_PINNED_TEST_TARGET') continue;
    delete process.env[key];
  }
  vi.resetModules();
  state.envReads = 0;
  state.dotenvCalls = 0;
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

  // D5H-I1b.1 F02: reading the error code is itself part of the failure path. A code
  // that cannot be read (throwing getter, throwing Proxy trap) must still produce the
  // fixed refusal, and a code that occurs in the URL only after case folding is secret-
  // derived and must not be exposed.
  const throwingGetter = () =>
    Object.defineProperty(new Error(`boom ${TEST_URL}`), 'code', {
      get() {
        throw new Error(`getter ${TEST_SECRET}`);
      },
    });
  const throwingProxy = () =>
    new Proxy(new Error(`proxy ${TEST_URL}`), {
      get(target, key) {
        if (key === 'code') throw new Error(`trap ${TEST_SECRET}`);
        return Reflect.get(target, key);
      },
    });
  it.each<[string, () => FakeDb, string]>([
    ['a throwing code getter at connect', () => markedTest({ connectError: throwingGetter() }), 'connect'],
    ['a Proxy whose code trap throws at connect', () => markedTest({ connectError: throwingProxy() }), 'connect'],
    ['a throwing code getter in the identity query', () => markedTest({ failOn: { sql: 'to_regnamespace', error: throwingGetter() } }), 'identity'],
    ['a Proxy whose code trap throws in the structure query', () => markedTest({ failOn: { sql: 'json_build_object', error: throwingProxy() } }), 'structure'],
  ])('F02 %s still yields the fixed sanitized refusal', async (_label, db, phase) => {
    state.databases.set(TEST_URL, db());
    const error = await failure(await guard());
    expect(error.name).toBe('TestDatabaseGuardError');
    expect(error.phase).toBe(phase);
    expect(error.code).toBe('unexpected');
    expectSanitized(error);
    for (const leak of ['boom', 'getter', 'proxy', 'trap']) expect(error.message).not.toContain(leak);
    for (const pool of pools()) expect(pool.ended).toBe(1);
  });

  it.each([
    ['a password fragment', 'SECRE'],
    ['a project-ref fragment', 'TESTR'],
  ])('F02 a SQLSTATE-shaped code matching %s only after case folding is not exposed', async (_label, code) => {
    state.databases.set(TEST_URL, markedTest({ failOn: { sql: 'to_regnamespace', error: Object.assign(new Error('x'), { code }) } }));
    const error = await failure(await guard());
    expect(error.phase).toBe('identity');
    expect(error.code).toBe('unexpected');
    expect(error.message).not.toContain(code);
    expectSanitized(error);
  });

  // D5H-I1b.1 adversarial: other ordinary shapes of an unreadable or secret-derived code.
  const sanitizedRefusal = (error: Error & Record<string, unknown>, phase: string, code: string | undefined) => {
    expect(error.name).toBe('TestDatabaseGuardError');
    expect(error.phase).toBe(phase);
    expect(error.code).toBe(code);
    expectSanitized(error);
    for (const leak of ['boom', 'getter', 'proxy', 'trap', 'revoked']) expect(error.message).not.toContain(leak);
  };

  it('ADV-A19 a revoked Proxy thrown at connect is a sanitized refusal', async () => {
    const { proxy, revoke } = Proxy.revocable(new Error(`revoked ${TEST_URL}`), {});
    revoke();
    state.databases.set(TEST_URL, markedTest({ connectError: proxy }));
    sanitizedRefusal(await failure(await guard()), 'connect', 'unexpected');
  });

  it('ADV-A20 a code getter is read once: a later secret-bearing answer is never consulted', async () => {
    let reads = 0;
    const error = Object.defineProperty(new Error('x'), 'code', {
      get() {
        reads += 1;
        return reads === 1 ? '42501' : TEST_SECRET;
      },
    });
    state.databases.set(TEST_URL, markedTest({ failOn: { sql: 'to_regnamespace', error } }));
    sanitizedRefusal(await failure(await guard()), 'identity', '42501');
    expect(reads).toBe(1);
  });

  it.each<[string, unknown]>([
    ['a String object', new String('42501')],
    ['a Symbol', Symbol('42501')],
    ['a number', 42501],
  ])('ADV-A21/A22 a code that is %s is not coerced', async (_label, code) => {
    state.databases.set(TEST_URL, markedTest({ failOn: { sql: 'to_regnamespace', error: Object.assign(new Error('x'), { code }) } }));
    sanitizedRefusal(await failure(await guard()), 'identity', undefined);
  });

  it('ADV-A23 a thrown function carrying a code is not treated as an error object', async () => {
    const thrown = Object.assign(() => TEST_URL, { code: 'ECONNREFUSED' });
    state.databases.set(TEST_URL, markedTest({ connectError: thrown }));
    sanitizedRefusal(await failure(await guard()), 'connect', undefined);
  });

  it('ADV-A24 an allowlisted Node code that occurs in the URL only after case folding is not exposed', async () => {
    const url = TEST_URL.replace('aws-0-test', 'aws-0-test-epipe');
    standardEnv({ TEST_DATABASE_URL: url });
    state.databases.set(url, markedTest({ connectError: Object.assign(new Error('x'), { code: 'EPIPE' }) }));
    sanitizedRefusal(await failure(await guard()), 'connect', 'unexpected');
  });

  it('ADV-A25 an error whose prototype lookup throws is still a sanitized refusal', async () => {
    const hostile = new Proxy(new Error(`proxy ${TEST_URL}`), {
      getPrototypeOf() {
        throw new Error(`trap ${TEST_SECRET}`);
      },
    });
    state.databases.set(TEST_URL, markedTest({ connectError: hostile }));
    sanitizedRefusal(await failure(await guard()), 'connect', 'unexpected');
  });

  it('ADV-A26 a code getter that throws a secret-bearing string is a sanitized refusal', async () => {
    const error = Object.defineProperty(new Error('x'), 'code', {
      get() {
        throw `getter ${TEST_URL}`;
      },
    });
    state.databases.set(TEST_URL, markedTest({ failOn: { sql: 'json_build_object', error } }));
    sanitizedRefusal(await failure(await guard()), 'structure', 'unexpected');
  });

  it('ADV-A27 a cleanup failure whose code cannot be read is a sanitized cleanup refusal', async () => {
    state.endError = Object.defineProperty(new Error(`boom ${TEST_URL}`), 'code', {
      get() {
        throw new Error(`getter ${TEST_SECRET}`);
      },
    });
    const error = await failure(await guard());
    sanitizedRefusal(error, 'cleanup', 'unexpected');
    expect(error.cleanupFailed).toBe(true);
  });

  it('ADV-A28 a SQLSTATE-shaped code that matches the pinned marker id after case folding is not exposed', async () => {
    const code = MARKER.slice(2, 7).toUpperCase();
    state.databases.set(TEST_URL, markedTest({ failOn: { sql: 'to_regnamespace', error: Object.assign(new Error('x'), { code }) } }));
    const error = await failure(await guard());
    sanitizedRefusal(error, 'identity', 'unexpected');
    expect(error.message).not.toContain(code);
  });

  // D5H-I1b.1 class C1: classifying a thrown value (instanceof) can itself run hostile
  // Proxy traps; the failure path must still end in the fixed refusal.
  const revokedProxy = (text: string) => {
    const { proxy, revoke } = Proxy.revocable(new Error(`revoked ${text}`), {});
    revoke();
    return proxy;
  };
  it('C1-a a revoked Proxy thrown by the identity query is a sanitized refusal', async () => {
    state.databases.set(TEST_URL, markedTest({ failOn: { sql: 'to_regnamespace', error: revokedProxy(TEST_URL) } }));
    sanitizedRefusal(await failure(await guard()), 'identity', 'unexpected');
  });
  it('C1-b a prototype trap that throws a secret-bearing string in the structure query is a sanitized refusal', async () => {
    const hostile = new Proxy(new Error('x'), {
      getPrototypeOf() {
        throw `trap ${TEST_URL}`;
      },
    });
    state.databases.set(TEST_URL, markedTest({ failOn: { sql: 'json_build_object', error: hostile } }));
    sanitizedRefusal(await failure(await guard()), 'structure', 'unexpected');
  });
  it('C1-c a revoked Proxy as the cleanup error is a sanitized cleanup refusal', async () => {
    state.endError = revokedProxy(TEST_URL);
    const error = await failure(await guard());
    sanitizedRefusal(error, 'cleanup', 'unexpected');
    expect(error.cleanupFailed).toBe(true);
  });
  it('C1-d a revoked Proxy from pool.end on the failure path only marks cleanupFailed', async () => {
    state.endError = revokedProxy(TEST_URL);
    state.databases.set(TEST_URL, markedTest({ connectError: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }) }));
    const error = await failure(await guard());
    sanitizedRefusal(error, 'connect', 'ECONNREFUSED');
    expect(error.cleanupFailed).toBe(true);
  });
  it('C1-f openSeedDatabase(test) with a revoked Proxy at connect is a sanitized refusal', async () => {
    state.databases.set(TEST_URL, markedTest({ connectError: revokedProxy(TEST_URL) }));
    const { openSeedDatabase } = await import('../scripts/demo-database.js');
    sanitizedRefusal(await failure(() => openSeedDatabase('test')), 'connect', 'unexpected');
  });

  // D5H-I1b.1 class C2: identifiers bound to the target (marker id, gate attempt id) are
  // secrets for code suppression too; ordinary SQLSTATEs stay visible.
  it.each([
    ['the marker tail', MARKER.slice(-12, -7).toUpperCase(), 'unexpected'],
    ['the marker end', MARKER.slice(-5).toUpperCase(), 'unexpected'],
    ['nothing (control)', '08006', '08006'],
  ])('C2 a SQLSTATE-shaped code matching %s', async (_label, code, expected) => {
    state.databases.set(TEST_URL, markedTest({ failOn: { sql: 'to_regnamespace', error: Object.assign(new Error('x'), { code }) } }));
    sanitizedRefusal(await failure(await guard()), 'identity', expected);
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

// ---------------------------------------------------------------------------------------
// D5H-I1b: the pinned, gate-only hosted TEST runtime adapter. A future D5H wrapper reads
// and validates the hosted TEST configuration once and starts the suite with ONE inherited
// variable; this process then proves THAT target and never re-reads the mutable repository
// file. All databases below are scripted fakes keyed by URL; nothing can open a socket.
//
// D5H-I1b.1: the gate decision and its subject are pinned for the life of the PROCESS, so
// vi.resetModules() can no longer move a worker between gate and non-gate. Every case that
// is about a start-up state is registered with `isolated(subject, ...)` and runs in a child
// Vitest process started with exactly that subject (null: started without the variable).
// The child is spawned with a constructed environment (synthetic .invalid URLs, PGHOST
// 127.0.0.1, PGPORT 1, nothing inherited but PATH), no config file, no setupFiles and no
// globalSetup, so this file's own pg/fs/dotenv fakes are the only "databases" it can see.
// ---------------------------------------------------------------------------------------
describe('D5H-I1b pinned gate-only hosted TEST target', () => {
  const GATE_VAR = 'MONA_D5H_PINNED_TEST_TARGET';
  const GATE_SECRET = 'gAtE-SeCrEt-PW';
  const GATE_REF = 'gaterefddddddddddddd';
  const GATE_HOST = 'aws-0-gate.pooler.supabase.com';
  const GATE_URL = `postgresql://postgres.${GATE_REF}:${GATE_SECRET}@${GATE_HOST}:5432/postgres`;
  const GATE_MARKER = '3f2b8c1e-5d4a-4b6f-8a7c-1d2e3f4a5b6c';
  const GATE_ATTEMPT = '9c1d2e3f-0a1b-4c2d-9e3f-a1b2c3d4e5f6';
  const OTHER_REF = 'otherrefeeeeeeeeeeee';
  const OTHER_SECRET = 'oThEr-SeCrEt-PW';
  const OTHER_URL = `postgresql://postgres.${OTHER_REF}:${OTHER_SECRET}@${GATE_HOST}:5432/postgres`;
  const OTHER_MARKER = '4a3b8c1e-5d4a-4b6f-8a7c-1d2e3f4a5b6c';
  const LOCAL_MARKER = '3cc8a898-33c5-46c8-8c71-560ee5f6cffd';
  const LOCAL_URL = 'postgresql://mona_local_test:local-secret@127.0.0.1:5432/mona_local_test';
  const LEAKS = [GATE_SECRET, GATE_REF, GATE_HOST, GATE_URL, GATE_MARKER, GATE_ATTEMPT, `postgres.${GATE_REF}`, OTHER_SECRET, OTHER_REF, OTHER_MARKER];

  const gateRaw = (patch: Record<string, unknown> = {}) =>
    JSON.stringify({ v: 1, url: GATE_URL, markerId: GATE_MARKER, attemptId: GATE_ATTEMPT, ...patch });
  const VALID = gateRaw();
  const OTHER = JSON.stringify({ v: 1, url: OTHER_URL, markerId: OTHER_MARKER, attemptId: GATE_ATTEMPT });
  // Registers the scripted databases a pinned subject may point at. The subject itself
  // is the child's start-up environment; nothing here sets the gate variable.
  function armDb() {
    state.databases.set(
      GATE_URL,
      markedTest({ username: `postgres.${GATE_REF}`, address: '10.0.0.9', rows: [{ ...canonicalRow(), marker_id: GATE_MARKER }] }),
    );
    state.databases.set(
      OTHER_URL,
      markedTest({ username: `postgres.${OTHER_REF}`, address: '10.0.0.10', rows: [{ ...canonicalRow(), marker_id: OTHER_MARKER }] }),
    );
  }
  const localDb = (): FakeDb => ({ ...unmarked('mona_local_test', '127.0.0.1'), local: { database: 'mona_local_test', user: 'mona_local_test', version: 'PostgreSQL 17.11 (synthetic)', rows: [{ environment: 'local_test', marker_id: LOCAL_MARKER, has_installed_at: true }] } });
  const urls = () => pools().map((pool) => pool.config.connectionString);
  const noGateLeak = (error: Error & Record<string, unknown>) => {
    const everything = [error.message, String(error.stack), JSON.stringify(error), JSON.stringify(Object.getOwnPropertyNames(error).map((k) => String(error[k])))].join('\n');
    for (const leak of LEAKS) expect(everything).not.toContain(leak);
  };
  const demo = () => import('../scripts/demo-database.js');

  type Subject = string | null;
  const registry = new Map<string, { id: string; subject: Subject; names: string[] }>();
  // `slot` gives a case its own process even when another case shares its subject.
  function isolated(subject: Subject, name: string, body: () => Promise<void>, slot = '') {
    const key = JSON.stringify([subject, slot]);
    let entry = registry.get(key);
    if (!entry) {
      entry = { id: String(registry.size), subject, names: [] };
      registry.set(key, entry);
    }
    const full = `${name} [iso:${entry.id}]`;
    entry.names.push(full);
    if (CHILD_SUBJECT !== entry.id) return;
    it(full, async () => {
      // The child really started in the state this case is about.
      expect(process.env[GATE_VAR]).toBe(subject ?? undefined);
      await body();
    });
  }

  isolated(VALID, 'G-01 a valid pinned target is proven INSTEAD of the repository-file target', async () => {
    armDb();
    await expect((await guard())()).resolves.toBeUndefined();
    expect(urls().length).toBeGreaterThan(0);
    for (const url of urls()) expect(url).toBe(GATE_URL);
    expect(urls()).not.toContain(TEST_URL);
    expect(pools().every((pool) => pool.ended === 1)).toBe(true);
  });

  isolated(VALID, 'G-02 gate mode performs zero .env.development reads, through every hosted entry point', async () => {
    armDb();
    await (await guard())();
    const { openSeedDatabase } = await demo();
    const db = await openSeedDatabase('test');
    await db.close();
    expect(state.envReads).toBe(0);
  });

  isolated(VALID, 'G-03 setup.ts in gate mode skips dotenv, never reads the file and feeds env.ts only a presence value', async () => {
    armDb();
    await import('./setup.js');
    expect(state.dotenvCalls).toBe(0);
    expect(state.envReads).toBe(0);
    for (const url of urls()) expect(url).toBe(GATE_URL);
    expect(urls().length).toBeGreaterThan(0);
    expect(process.env.TEST_DATABASE_URL).toBe(GATE_URL);
    expect(new URL(process.env.DATABASE_URL!).hostname.endsWith('.invalid')).toBe(true);
    expect(process.env.NODE_ENV).toBe('test');
  });

  isolated(VALID, 'G-04 the pool and the proof use the canonical reconstructed URL', async () => {
    armDb();
    const { openProvenTestPool, testPoolConfig } = await demo();
    const { pool, target } = await openProvenTestPool(1);
    await pool.end();
    expect(target.url).toBe(GATE_URL);
    expect(target.markerId).toBe(GATE_MARKER);
    expect(testPoolConfig(target.url, 1).connectionString).toBe(GATE_URL);
  });

  const refusedAtStartUp = async () => {
    armDb();
    const error = await failure(await guard());
    expect(error.phase).toBe('config');
    noGateLeak(error);
    expect(pools()).toHaveLength(0);
  };
  for (const [label, raw] of [
    ['not JSON', 'not json'],
    ['empty value', ''],
    ['truncated', gateRaw().slice(0, -3)],
    ['an array', '[]'],
    ['null', 'null'],
    ['a string', JSON.stringify(gateRaw())],
    ['a number', '1'],
    ['appended text', `${gateRaw()} `],
    ['appended garbage', `${gateRaw()}x`],
    ['a leading BOM', `\ufeff${gateRaw()}`],
  ] as const) {
    isolated(raw, `G-05 malformed pinned JSON (${label}) fails before any pool`, refusedAtStartUp);
  }

  const without = (key: string) => {
    const o = JSON.parse(gateRaw());
    delete o[key];
    return JSON.stringify(o);
  };
  for (const [label, raw] of [
    ['missing v', without('v')],
    ['missing url', without('url')],
    ['missing markerId', without('markerId')],
    ['missing attemptId', without('attemptId')],
    ['an extra key', gateRaw({ extra: 1 })],
    ['an extra __proto__ own key', gateRaw().replace('{', '{"__proto__":{"x":1},')],
    ['an empty object', '{}'],
  ] as const) {
    isolated(raw, `G-06 pinned JSON with ${label} fails before any pool`, refusedAtStartUp);
  }

  for (const [label, raw] of [
    ['pretty-printed', JSON.stringify(JSON.parse(gateRaw()), null, 2)],
    ['reordered keys', JSON.stringify({ url: GATE_URL, v: 1, markerId: GATE_MARKER, attemptId: GATE_ATTEMPT })],
    ['a duplicate key', gateRaw().replace('{"v":1,', '{"v":1,"v":1,')],
    ['an escaped key spelling', gateRaw().replace('"url"', '"\\u0075rl"')],
    ['inserted whitespace', gateRaw().replace(':1,', ': 1,')],
    ['a decimal-point version', gateRaw().replace('"v":1,', '"v":1.0,')],
  ] as const) {
    isolated(raw, `G-07 a non-canonical JSON rendering (${label}) is refused`, refusedAtStartUp);
  }

  for (const [label, url] of [
    ['the postgres:// spelling of the same target', GATE_URL.replace('postgresql://', 'postgres://')],
    ['an unnecessarily percent-encoded password', GATE_URL.replace('gAtE-SeCrEt-PW', 'gAtE%2DSeCrEt%2DPW')],
    ['an upper-case host', GATE_URL.replace(GATE_HOST, GATE_HOST.toUpperCase())],
    ['a trailing query', `${GATE_URL}?sslmode=disable`],
    ['an unrelated host class', GATE_URL.replace(GATE_HOST, 'db.example.invalid')],
    ['a non-5432 port', GATE_URL.replace(':5432/', ':6543/')],
  ] as const) {
    isolated(gateRaw({ url }), `G-08 a url that is not the canonical reconstruction (${label}) is refused`, refusedAtStartUp);
  }

  for (const [label, markerId] of [
    ['upper-case', GATE_MARKER.toUpperCase()],
    ['version 1', '3f2b8c1e-5d4a-1b6f-8a7c-1d2e3f4a5b6c'],
    ['no hyphens', GATE_MARKER.replace(/-/g, '')],
    ['padded', ` ${GATE_MARKER}`],
    ['empty', ''],
    ['a number', 12345],
    ['null', null],
  ] as const) {
    isolated(gateRaw({ markerId }), `G-09 an invalid pinned markerId (${label}) fails before any pool`, refusedAtStartUp);
  }

  for (const [label, attemptId] of [
    ['upper-case', GATE_ATTEMPT.toUpperCase()],
    ['version 1', '9c1d2e3f-0a1b-1c2d-9e3f-a1b2c3d4e5f6'],
    ['no hyphens', GATE_ATTEMPT.replace(/-/g, '')],
    ['empty', ''],
    ['an object', {}],
    ['the marker id reused', GATE_MARKER + 'x'],
  ] as const) {
    isolated(gateRaw({ attemptId }), `G-10 an invalid pinned attemptId (${label}) fails before any pool`, refusedAtStartUp);
  }

  for (const [label, v] of [['the string "1"', '"1"'], ['2', '2'], ['true', 'true'], ['null', 'null']] as const) {
    isolated(gateRaw().replace('"v":1', `"v":${v}`), `G-11 a pinned version of ${label} is refused`, refusedAtStartUp);
  }

  isolated(VALID, 'G-12 gate mode can never select LOCAL_TEST, by selector or by explicit target', async () => {
    armDb();
    state.databases.set(LOCAL_URL, localDb());
    const { resolveAutomatedTestTarget, openSeedDatabase } = await demo();
    expect(resolveAutomatedTestTarget({})).toBe('test');
    expect(resolveAutomatedTestTarget({ MONA_TEST_DATABASE_TARGET: 'test' })).toBe('test');
    expect(() => resolveAutomatedTestTarget({ MONA_TEST_DATABASE_TARGET: 'local' })).toThrow();
    expect(() => resolveAutomatedTestTarget({ MONA_TEST_DATABASE_TARGET: 'anything' })).toThrow();
    process.env.MONA_TEST_DATABASE_TARGET = 'local';
    process.env.LOCAL_TEST_DATABASE_URL = LOCAL_URL;
    process.env.LOCAL_TEST_DATABASE_MARKER_ID = LOCAL_MARKER;
    await expect((await guard())()).rejects.toThrow();
    await expect(openSeedDatabase('local-test')).rejects.toThrow();
    await expect(openSeedDatabase('automated-test')).rejects.toThrow();
    expect(urls()).not.toContain(LOCAL_URL);
  });

  // D5H-I1b.1: deleting or changing the pin after start-up no longer "keeps going" on the
  // captured target: the process fails closed, and never falls back to the repository file.
  isolated(VALID, 'G-13 deleting or mutating the pin after start-up fails closed and never redirects', async () => {
    armDb();
    const { openProvenTestPool } = await demo();
    const first = await openProvenTestPool(1);
    await first.pool.end();
    expect(first.target.url).toBe(GATE_URL);
    delete process.env[GATE_VAR];
    process.env.TEST_DATABASE_URL = DEV_URL;
    standardEnv({ TEST_DATABASE_URL: DEMO_URL });
    const deleted = await failure(() => openProvenTestPool(1));
    expect(deleted.phase).toBe('config');
    noGateLeak(deleted);
    process.env[GATE_VAR] = gateRaw({ attemptId: '1d2e3f4a-0a1b-4c2d-9e3f-a1b2c3d4e5f6' });
    const mutated = await failure(() => openProvenTestPool(1));
    expect(mutated.phase).toBe('config');
    noGateLeak(mutated);
    expect(urls()).toEqual([GATE_URL]);
    expect(state.envReads).toBe(0);
  });

  for (const [index, raw] of [gateRaw({ markerId: GATE_MARKER.toUpperCase() }), gateRaw({ attemptId: 'x' }), gateRaw({ url: `${GATE_URL}?x=1` }), `${gateRaw()}${GATE_SECRET}`, gateRaw({ extra: GATE_SECRET })].entries()) {
    isolated(raw, `G-14 gate refusals never carry the URL, password, host, project ref, marker or attempt id (${index})`, async () => {
      const { D5H_PINNED_TARGET_VAR } = await demo().then((m) => m as unknown as { D5H_PINNED_TARGET_VAR?: string });
      expect(D5H_PINNED_TARGET_VAR).toBe(GATE_VAR);
      armDb();
      const error = await failure(await guard());
      noGateLeak(error);
      const setup = await import('./setup.js').then(() => null, (e: Error & Record<string, unknown>) => e);
      expect(setup).not.toBeNull();
      noGateLeak(setup!);
    });
  }

  it('G-15 without the gate variable at start-up, hosted TEST keeps reading the repository file exactly as before', async () => {
    await (await guard())();
    expect(state.envReads).toBeGreaterThan(0);
    for (const url of urls()) expect(url).toBe(TEST_URL);
    const { resolveAutomatedTestTarget } = await demo();
    expect(resolveAutomatedTestTarget({ MONA_TEST_DATABASE_TARGET: 'local' })).toBe('local');
  });

  it('G-16 non-gate setup restores the ambient selector and LOCAL_TEST controls after dotenv, so the file cannot switch targets', async () => {
    state.databases.set(LOCAL_URL, localDb());
    process.env.MONA_TEST_DATABASE_TARGET = 'local';
    process.env.LOCAL_TEST_DATABASE_URL = LOCAL_URL;
    process.env.LOCAL_TEST_DATABASE_MARKER_ID = LOCAL_MARKER;
    standardEnv({ MONA_TEST_DATABASE_TARGET: 'test', LOCAL_TEST_DATABASE_URL: 'postgresql://evil:evil@127.0.0.1:5432/other', LOCAL_TEST_DATABASE_MARKER_ID: GATE_MARKER });
    await import('./setup.js');
    expect(process.env.MONA_TEST_DATABASE_TARGET).toBe('local');
    expect(process.env.LOCAL_TEST_DATABASE_URL).toBe(LOCAL_URL);
    expect(process.env.LOCAL_TEST_DATABASE_MARKER_ID).toBe(LOCAL_MARKER);
    for (const url of urls()) expect(url).toBe(LOCAL_URL);
    expect(urls().length).toBeGreaterThan(0);
  });

  it('G-17 non-gate setup does not let the file introduce a selector or LOCAL_TEST variables that were absent', async () => {
    standardEnv({ MONA_TEST_DATABASE_TARGET: 'local', LOCAL_TEST_DATABASE_URL: LOCAL_URL, LOCAL_TEST_DATABASE_MARKER_ID: LOCAL_MARKER });
    await import('./setup.js');
    expect(process.env.MONA_TEST_DATABASE_TARGET).toBeUndefined();
    expect(process.env.LOCAL_TEST_DATABASE_URL).toBeUndefined();
    expect(process.env.LOCAL_TEST_DATABASE_MARKER_ID).toBeUndefined();
    expect(state.dotenvCalls).toBe(1);
    for (const url of urls()) expect(url).toBe(TEST_URL);
  });

  it('G-18 .env.development cannot manufacture the gate: the variable is removed again and the file target is used', async () => {
    standardEnv({ [GATE_VAR]: gateRaw() });
    armDb();
    await import('./setup.js');
    expect(process.env[GATE_VAR]).toBeUndefined();
    expect(state.envReads).toBeGreaterThan(0);
    for (const url of urls()) expect(url).toBe(TEST_URL);
    vi.resetModules();
    await (await guard())();
    for (const url of urls()) expect(url).toBe(TEST_URL);
  });

  isolated(VALID, 'G-19 the marker proof stays mandatory in gate mode: an unmarked pinned target is refused', async () => {
    state.databases.set(GATE_URL, unmarked(`postgres.${GATE_REF}`, '10.0.0.9'));
    const unproven = await failure(await guard());
    expect(unproven.phase).toBe('identity');
    noGateLeak(unproven);
    expect(pools().every((pool) => pool.ended === 1)).toBe(true);
  });

  isolated(gateRaw({ markerId: '1d2e3f4a-5d4a-4b6f-8a7c-1d2e3f4a5b6c' }), 'G-19 the marker proof stays mandatory in gate mode: a wrong-marker pinned target is refused', async () => {
    armDb();
    const wrong = await failure(await guard());
    expect(wrong.phase).toBe('mismatch');
    noGateLeak(wrong);
  });

  // D5H-I1b.1 F01: the start-up decision and subject survive module re-evaluation.
  isolated(VALID, 'F01-1 a gate process whose pin is deleted cannot downgrade through a re-evaluated module', async () => {
    armDb();
    state.databases.set(LOCAL_URL, localDb());
    const before = await demo();
    expect(() => before.resolveAutomatedTestTarget({ MONA_TEST_DATABASE_TARGET: 'local' })).toThrow();
    delete process.env[GATE_VAR];
    vi.resetModules();
    const after = await demo();
    expect(() => after.resolveAutomatedTestTarget({ MONA_TEST_DATABASE_TARGET: 'local' })).toThrow();
    expect(() => after.resolveAutomatedTestTarget({})).toThrow();
    expect(() => after.readD5hPinnedTarget()).toThrow();
    process.env.MONA_TEST_DATABASE_TARGET = 'local';
    process.env.LOCAL_TEST_DATABASE_URL = LOCAL_URL;
    process.env.LOCAL_TEST_DATABASE_MARKER_ID = LOCAL_MARKER;
    await expect(after.openSeedDatabase('local-test')).rejects.toThrow();
    await expect(after.openSeedDatabase('automated-test')).rejects.toThrow();
    const refused = await failure(() => after.openProvenTestPool(1));
    expect(refused.phase).toBe('config');
    noGateLeak(refused);
    await expect((await guard())()).rejects.toThrow();
    expect(urls()).toEqual([]);
    expect(state.envReads).toBe(0);
  });

  isolated(VALID, 'F01-2 a gate process whose pin is changed cannot be redirected through a re-evaluated module', async () => {
    armDb();
    await demo();
    process.env[GATE_VAR] = OTHER;
    vi.resetModules();
    const after = await demo();
    expect(() => after.readD5hPinnedTarget()).toThrow();
    const refused = await failure(() => after.openProvenTestPool(1));
    expect(refused.phase).toBe('config');
    noGateLeak(refused);
    await expect((await guard())()).rejects.toThrow();
    expect(urls()).toEqual([]);
    expect(state.envReads).toBe(0);
  });

  isolated(OTHER, 'F01-2 control: the replacement subject is itself a valid pinned target when present at start-up', async () => {
    armDb();
    const { openProvenTestPool } = await demo();
    const { pool, target } = await openProvenTestPool(1);
    await pool.end();
    expect(target.url).toBe(OTHER_URL);
  });

  isolated(null, 'F01-3 a process started without the gate cannot enable it later, even through a re-evaluated module', async () => {
    armDb();
    const before = await demo();
    expect(before.readD5hPinnedTarget()).toBeNull();
    process.env[GATE_VAR] = VALID;
    vi.resetModules();
    const after = await demo();
    expect(() => after.readD5hPinnedTarget()).toThrow();
    const refused = await failure(() => after.openProvenTestPool(1));
    expect(refused.phase).toBe('config');
    noGateLeak(refused);
    expect(urls()).toEqual([]);
  });

  // ---- D5H-I1b.1 adversarial: the process-lifetime store and its interaction with errors ----
  const PIN_KEY = Symbol.for('mona.d5h.pinnedTestTarget.v1');
  const globalRecord = globalThis as unknown as Record<symbol, unknown>;
  const pinnedPool = async () => {
    const { openProvenTestPool } = await demo();
    const { pool, target } = await openProvenTestPool(1);
    await pool.end();
    return target.url;
  };
  const refusedPool = async () => {
    const { openProvenTestPool } = await demo();
    const error = await failure(() => openProvenTestPool(1));
    expect(error.phase).toBe('config');
    noGateLeak(error);
  };

  isolated(VALID, 'ADV-A01 the stored pin cannot be deleted, and a re-evaluated module stays gated', async () => {
    armDb();
    await demo();
    expect(() => delete globalRecord[PIN_KEY]).toThrow(TypeError);
    vi.resetModules();
    const after = await demo();
    expect(() => after.resolveAutomatedTestTarget({ MONA_TEST_DATABASE_TARGET: 'local' })).toThrow();
    expect(await pinnedPool()).toBe(GATE_URL);
  });

  isolated(VALID, 'ADV-A02 the stored pin cannot be redefined as a non-gate record', async () => {
    armDb();
    await demo();
    const forged = Object.freeze(Object.assign(Object.create(null) as object, { gate: false, raw: undefined }));
    expect(() => Object.defineProperty(globalThis, PIN_KEY, { value: forged })).toThrow(TypeError);
    vi.resetModules();
    expect(await pinnedPool()).toBe(GATE_URL);
    expect(state.envReads).toBe(0);
  });

  isolated(VALID, 'ADV-A03 the stored record itself cannot be mutated', async () => {
    armDb();
    await demo();
    const record = globalRecord[PIN_KEY] as Record<string, unknown>;
    expect(() => {
      record.gate = false;
    }).toThrow(TypeError);
    expect(() => {
      record.raw = OTHER;
    }).toThrow(TypeError);
    vi.resetModules();
    expect(await pinnedPool()).toBe(GATE_URL);
  });

  const plant = (descriptor: PropertyDescriptor) => Object.defineProperty(globalThis, PIN_KEY, { configurable: false, enumerable: false, ...descriptor });
  const nullRecord = (fields: Record<string, unknown>) => Object.freeze(Object.assign(Object.create(null) as object, fields));

  isolated(null, 'ADV-A04 a pre-planted gate record that disagrees with the environment refuses every target', async () => {
    armDb();
    plant({ value: nullRecord({ gate: true, raw: OTHER }), writable: false });
    const mod = await demo();
    expect(() => mod.readD5hPinnedTarget()).toThrow();
    await refusedPool();
    expect(urls()).toEqual([]);
  }, 'planted-gate');

  isolated(VALID, 'ADV-A05 a pre-planted non-gate record cannot downgrade a gated process', async () => {
    armDb();
    plant({ value: nullRecord({ gate: false, raw: undefined }), writable: false });
    const mod = await demo();
    expect(() => mod.resolveAutomatedTestTarget({ MONA_TEST_DATABASE_TARGET: 'local' })).toThrow();
    await refusedPool();
    expect(urls()).toEqual([]);
    expect(state.envReads).toBe(0);
  }, 'planted-nongate');

  for (const [slot, label, descriptor] of [
    ['planted-accessor', 'an accessor', { get: () => nullRecord({ gate: false, raw: undefined }) }],
    ['planted-writable', 'a writable record', { value: nullRecord({ gate: false, raw: undefined }), writable: true }],
    ['planted-proto', 'a record with Object.prototype', { value: Object.freeze({ gate: false, raw: undefined }), writable: false }],
    ['planted-extra', 'a record with an extra key', { value: nullRecord({ gate: false, raw: undefined, extra: 1 }), writable: false }],
  ] as const) {
    isolated(null, `ADV-A06..09 a pre-planted pin that is ${label} is untrusted and refuses every target`, async () => {
      armDb();
      plant(descriptor as PropertyDescriptor);
      const mod = await demo();
      expect(mod.resolveAutomatedTestTarget({})).toBe('test');
      expect(() => mod.resolveAutomatedTestTarget({ MONA_TEST_DATABASE_TARGET: 'local' })).toThrow();
      await refusedPool();
      expect(urls()).toEqual([]);
      expect(state.envReads).toBe(0);
    }, slot);
  }

  isolated(VALID, 'ADV-A10 repeated re-evaluation keeps the pin; once deleted every later evaluation refuses', async () => {
    armDb();
    for (let i = 0; i < 5; i += 1) {
      vi.resetModules();
      expect(await pinnedPool()).toBe(GATE_URL);
    }
    delete process.env[GATE_VAR];
    for (let i = 0; i < 3; i += 1) {
      vi.resetModules();
      await refusedPool();
    }
    expect(urls()).toEqual(Array(5).fill(GATE_URL));
    expect(state.envReads).toBe(0);
  });

  isolated(VALID, 'ADV-A11 a pin that differs only by trailing whitespace is a different subject', async () => {
    armDb();
    await demo();
    process.env[GATE_VAR] = `${VALID} `;
    vi.resetModules();
    await refusedPool();
    process.env[GATE_VAR] = VALID;
    expect(await pinnedPool()).toBe(GATE_URL);
  });

  isolated(VALID, 'ADV-A12 an emptied pin refuses and never reads the repository file', async () => {
    armDb();
    await demo();
    process.env[GATE_VAR] = '';
    vi.resetModules();
    await refusedPool();
    expect(state.envReads).toBe(0);
  });

  isolated(VALID, 'ADV-A13 a gated process with a deleted pin cannot open the demo target', async () => {
    armDb();
    const { openSeedDatabase } = await demo();
    delete process.env[GATE_VAR];
    process.env.NODE_ENV = 'development';
    await expect(openSeedDatabase('demo')).rejects.toThrow();
    expect(state.envReads).toBe(0);
    expect(pools()).toHaveLength(0);
  });

  isolated(null, 'ADV-A14 a non-gate process that gains a pin cannot open the demo target', async () => {
    armDb();
    const { openSeedDatabase } = await demo();
    process.env[GATE_VAR] = VALID;
    process.env.NODE_ENV = 'development';
    await expect(openSeedDatabase('demo')).rejects.toThrow();
    expect(state.envReads).toBe(0);
    expect(pools()).toHaveLength(0);
  });

  isolated(null, 'ADV-A15 a non-gate process that gains a pin cannot open LOCAL_TEST', async () => {
    armDb();
    state.databases.set(LOCAL_URL, localDb());
    const { openProvenLocalTestPool } = await demo();
    process.env[GATE_VAR] = VALID;
    const error = await failure(() => openProvenLocalTestPool(1, { LOCAL_TEST_DATABASE_URL: LOCAL_URL, LOCAL_TEST_DATABASE_MARKER_ID: LOCAL_MARKER }));
    expect(error.message).toContain('phase=config');
    noGateLeak(error);
    expect(urls()).not.toContain(LOCAL_URL);
  });

  isolated(null, 'ADV-A16 a non-gate process refuses while a late pin is present and resumes the file target once it is gone', async () => {
    armDb();
    await demo();
    process.env[GATE_VAR] = VALID;
    vi.resetModules();
    await refusedPool();
    delete process.env[GATE_VAR];
    vi.resetModules();
    expect(await pinnedPool()).toBe(TEST_URL);
    expect(urls()).not.toContain(GATE_URL);
  });

  isolated(VALID, 'ADV-A17 setup.ts in a gated process whose pin was deleted refuses and never falls back to dotenv', async () => {
    armDb();
    await demo();
    delete process.env[GATE_VAR];
    vi.resetModules();
    const setup = await import('./setup.js').then(() => null, (e: Error & Record<string, unknown>) => e);
    expect(setup).not.toBeNull();
    noGateLeak(setup!);
    expect(state.dotenvCalls).toBe(0);
    expect(state.envReads).toBe(0);
  });

  isolated(VALID, 'ADV-A18 the stored pin is a non-writable, non-configurable, non-enumerable frozen record', async () => {
    await demo();
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, PIN_KEY)!;
    expect(descriptor.writable).toBe(false);
    expect(descriptor.configurable).toBe(false);
    expect(descriptor.enumerable).toBe(false);
    expect(Object.isFrozen(descriptor.value)).toBe(true);
    expect(Object.keys(globalThis)).not.toContain(String(PIN_KEY));
  });

  isolated(VALID, 'ADV-A29 gate-mode connect errors: an unreadable code and a code matching the attempt id are not exposed', async () => {
    armDb();
    state.databases.set(GATE_URL, markedTest({ connectError: Object.defineProperty(new Error(`boom ${GATE_URL}`), 'code', { get() { throw new Error(GATE_SECRET); } }) }));
    const unreadable = await failure(await guard());
    expect(unreadable.phase).toBe('connect');
    expect(unreadable.code).toBe('unexpected');
    noGateLeak(unreadable);
    vi.resetModules();
    state.databases.set(GATE_URL, markedTest({ connectError: Object.assign(new Error('x'), { code: GATE_ATTEMPT.slice(0, 5).toUpperCase() }) }));
    const attempt = await failure(await guard());
    expect(attempt.code).toBe('unexpected');
    noGateLeak(attempt);
  });

  isolated(VALID, 'ADV-A30 gate-mode: a code matching the pinned password only after case folding is not exposed', async () => {
    armDb();
    state.databases.set(GATE_URL, markedTest({ rows: [{ ...canonicalRow(), marker_id: GATE_MARKER }], failOn: { sql: 'to_regnamespace', error: Object.assign(new Error('x'), { code: 'SECRE' }) } }));
    const error = await failure(await guard());
    expect(error.phase).toBe('identity');
    expect(error.code).toBe('unexpected');
    noGateLeak(error);
  });

  isolated(VALID, 'C1-e gate-mode: a revoked Proxy at connect is a sanitized refusal', async () => {
    armDb();
    const { proxy, revoke } = Proxy.revocable(new Error(`revoked ${GATE_URL}`), {});
    revoke();
    state.databases.set(GATE_URL, markedTest({ connectError: proxy }));
    const error = await failure(await guard());
    expect(error.name).toBe('TestDatabaseGuardError');
    expect(error.phase).toBe('connect');
    expect(error.code).toBe('unexpected');
    noGateLeak(error);
  });

  for (const [label, code, expected] of [
    ['the pinned marker id', GATE_MARKER.slice(0, 5).toUpperCase(), 'unexpected'],
    ['the attempt id at a later offset', GATE_ATTEMPT.slice(-7, -2).toUpperCase(), 'unexpected'],
    ['nothing (control)', '42P01', '42P01'],
  ] as const) {
    isolated(VALID, `C2 gate-mode: a SQLSTATE-shaped code matching ${label}`, async () => {
      armDb();
      state.databases.set(GATE_URL, markedTest({ rows: [{ ...canonicalRow(), marker_id: GATE_MARKER }], failOn: { sql: 'to_regnamespace', error: Object.assign(new Error('x'), { code }) } }));
      const error = await failure(await guard());
      expect(error.phase).toBe('identity');
      expect(error.code).toBe(expected);
      noGateLeak(error);
    });
  }

  // ---- launchers: one fresh, contained child process per start-up subject ----
  type ChildResult = { exit: number | null; passed: string[]; failed: string[] };
  const API_DIR = fileURLToPath(new URL('..', import.meta.url));
  const RESULT_PREFIX = CHILD_RESULT_PREFIX;
  const ISOLATED_URL = 'postgresql://isolated:isolated@child-database-url.invalid:5432/postgres';
  // The child runs this file through tests/helpers/d5h-guard-child-runner.ts (Vitest node
  // API: no config file, no setupFiles, no globalSetup; only the tests whose full name
  // matches `pattern` execute). The argv is literal so the Task 4 scanner can prove the
  // launch; the pattern travels in the child's explicit environment.
  function runChild(id: string, subject: Subject, pattern: string): Promise<ChildResult> {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      NODE_ENV: 'test',
      PGHOST: '127.0.0.1',
      PGPORT: '1',
      DATABASE_URL: ISOLATED_URL,
      TEST_DATABASE_URL: ISOLATED_URL,
      [CHILD_SUBJECT_VAR]: id,
      [CHILD_PATTERN_VAR]: pattern,
    };
    if (subject !== null) env[GATE_VAR] = subject;
    return new Promise((resolve) => {
      let output = '';
      // Literal flag: type stripping is unflagged only from Node 22.18; api/package.json allows >=22.12.
      const child = spawn(process.execPath, ['--experimental-strip-types', 'tests/helpers/d5h-guard-child-runner.ts', 'tests/test-db-guard.test.ts'], {
        cwd: API_DIR,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const timer = setTimeout(() => child.kill('SIGKILL'), 150_000);
      child.stdout.on('data', (chunk) => (output += chunk));
      child.stderr.on('data', (chunk) => (output += chunk));
      const settle = (exit: number | null) => {
        clearTimeout(timer);
        const line = output.split('\n').find((l) => l.startsWith(RESULT_PREFIX));
        if (!line) return resolve({ exit, passed: [], failed: [`no child result (exit ${exit}): ${output.slice(-4000)}`] });
        resolve({ exit, ...(JSON.parse(line.slice(RESULT_PREFIX.length)) as Omit<ChildResult, 'exit'>) });
      };
      child.on('error', () => settle(null));
      child.on('close', settle);
    });
  }
  let active = 0;
  const waiting: Array<() => void> = [];
  async function limited<T>(run: () => Promise<T>): Promise<T> {
    while (active >= 4) await new Promise<void>((wake) => waiting.push(wake));
    active += 1;
    try {
      return await run();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  }
  const runs = new Map<string, Promise<ChildResult>>();
  beforeAll(() => {
    if (CHILD_SUBJECT !== undefined) return;
    for (const entry of registry.values()) {
      runs.set(entry.id, limited(() => runChild(entry.id, entry.subject, `\\[iso:${entry.id}\\]`)));
    }
  });
  for (const entry of registry.values()) {
    const label = entry.subject === null ? `no gate variable (#${entry.id})` : `pinned subject #${entry.id}`;
    it.skipIf(CHILD_SUBJECT !== undefined)(`${LAUNCH_TAG} start-up with ${label}: ${entry.names.length} case(s) in a fresh contained process`, async () => {
      const result = await runs.get(entry.id)!;
      expect(result.failed).toEqual([]);
      expect([...result.passed].sort()).toEqual([...entry.names].sort());
      expect(result.exit).toBe(0);
    }, 300_000);
  }

  // A worker that itself started gated (e.g. a D5H gate run whose setup already pinned the
  // process) skips every non-gate case above and runs them here, in one child that starts
  // without the variable.
  it.runIf(STARTED_GATED)(`${LAUNCH_TAG} non-gate cases of this file in a fresh process started without the gate variable`, async (context) => {
    const expected: string[] = [];
    const collect = (task: { type: string; name: string; tasks?: unknown[] }) => {
      if (task.type === 'test' && !/\[(?:iso:\d+|launch)\]/.test(task.name)) expected.push(task.name);
      for (const child of (task.tasks ?? []) as Array<typeof task>) collect(child);
    };
    collect(context.task.file as unknown as { type: string; name: string; tasks?: unknown[] });
    const result = await runChild('legacy', null, '^(?!.*\\[(?:iso:\\d+|launch)\\])');
    expect(result.failed).toEqual([]);
    expect([...result.passed].sort()).toEqual(expected.sort());
    expect(result.exit).toBe(0);
  }, 300_000);
});
