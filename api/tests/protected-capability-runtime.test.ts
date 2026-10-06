// V2.3.3 R4: zero-database tests of the protected transaction owner (withProtectedResumeTransaction), its commit gate,
// the ProtectedTx wrapper and the statement classifier. `pg`, `@prisma/adapter-pg`, the generated PrismaClient and
// `node:child_process` are replaced by SENTINELS: while a protected transaction is active each throws
// MJ_PROTECTED_CAPABILITY_ESCAPE (NO-ESCAPE-CONTRACT §3). Nothing here can open a socket or start a process.
// Run with a no-setup Vitest config (no setupFiles/globalSetup).
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { proveIdentityOnTransaction } from '../scripts/demo-database.js';
import { DigestSink, protectedDomainContractSha256, type ProtectedTx } from '../scripts/local-test-fingerprint.js';
import { TRANSFORMATION_CONTRACT_SHA256 } from '../scripts/local-test-baseline.js';
import {
  OutcomeCheckFailure,
  ResumeFailure,
  SnapshotFailure,
  checkOutcomeTransaction,
  withBackupSnapshotTransaction,
  classifyStatement,
  createCommitGate,
  protectTx,
  withProtectedResumeTransaction,
  type ProtectedPrisma,
  type ProtectedResumeOptions,
  type ProtectedResumeRequest,
  type ProtectedSteps,
  type PostWitnessRequest,
} from '../scripts/local-test-runtime.js';

vi.hoisted(() => {
  vi.resetModules();
});
const h = vi.hoisted(() => ({ active: false, hits: [] as string[] }));
const trip = (what: string) => {
  if (h.active) {
    h.hits.push(what);
    throw new Error(`MJ_PROTECTED_CAPABILITY_ESCAPE: ${what}`);
  }
};
vi.mock('pg', () => {
  class Pool {
    constructor() { trip('new Pool'); }
    on() { return this; }
    async connect() { trip('pool.connect'); }
  }
  class Client { constructor() { trip('new Client'); } }
  return { default: { Pool, Client }, Pool, Client };
});
vi.mock('@prisma/adapter-pg', () => ({ PrismaPg: class { constructor() { trip('new PrismaPg'); } } }));
vi.mock('../src/generated/prisma/client.js', () => ({ PrismaClient: class { constructor() { trip('new PrismaClient'); } } }));
vi.mock('node:child_process', () => ({ spawn: () => trip('child_process.spawn'), exec: () => trip('child_process.exec'), execFile: () => trip('child_process.execFile'), default: {} }));

const UUID = '11111111-1111-4111-8111-111111111111';
const NONCE = 'n'.repeat(32);
const P_BYTES = Buffer.from('P-STATE-BYTES');
const Q_BYTES = Buffer.from('Q-STATE-BYTES');
const digest = (role: 'PRE' | 'POST', bytes: Buffer) => { const s = new DigestSink(role); s.write(bytes); return s.end(); };
const F_PRE = digest('PRE', P_BYTES);
const F_POST = digest('POST', Q_BYTES);
const CANARY = 'CANARY_PASSWORD_HASH_DO_NOT_LEAK';
const SCHEMA = 's'.repeat(64);

type Raw = {
  statements: string[];
  $executeRawUnsafe: (sql: string) => Promise<number>;
  $queryRawUnsafe: (sql: string) => Promise<unknown[]>;
  $queryRaw: (strings: TemplateStringsArray) => Promise<unknown[]>;
  $executeRaw: (strings: TemplateStringsArray) => Promise<number>;
  $transaction: () => Promise<never>;
  $connect: () => Promise<never>;
  $disconnect: () => Promise<never>;
  user: { findMany: () => Promise<unknown[]> };
};
function harness(opts: { failCommit?: boolean; answer?: (sql: string, txIndex: number) => unknown[] | undefined } = {}) {
  const events: string[] = [];
  let calls = 0;
  let lastRaw: Raw | null = null;
  const txOptions: unknown[] = [];
  const prisma = {
    $transaction: async (cb: (raw: Raw) => Promise<unknown>, options?: unknown) => {
      calls += 1;
      const txIndex = calls;
      txOptions.push(options);
      const raw: Raw = {
        statements: [],
        $executeRawUnsafe: async (sql) => { raw.statements.push(sql); events.push(`SQL:${sql}`); return 0; },
        $queryRawUnsafe: async (sql) => { raw.statements.push(sql); events.push(`SQL:${sql}`); return opts.answer?.(sql, txIndex) ?? []; },
        $queryRaw: async (s) => { const sql = s.join('?'); raw.statements.push(sql); events.push(`SQL:${sql}`); return []; },
        $executeRaw: async (s) => { const sql = s.join('?'); raw.statements.push(sql); events.push(`SQL:${sql}`); return 0; },
        $transaction: async () => { throw new Error('raw $transaction reached'); },
        $connect: async () => { throw new Error('raw $connect reached'); },
        $disconnect: async () => { throw new Error('raw $disconnect reached'); },
        user: { findMany: async () => [] },
      };
      lastRaw = raw;
      h.active = true;
      events.push('BEGIN');
      try {
        const result = await cb(raw);
        if (opts.failCommit) { events.push('COMMIT-FAILED'); throw new Error('commit failed'); }
        events.push('COMMIT');
        return result;
      } catch (e) {
        if (!events.includes('COMMIT-FAILED')) events.push('ROLLBACK');
        throw e;
      } finally {
        h.active = false;
      }
    },
  } as unknown as ProtectedPrisma;
  return { prisma, events, calls: () => calls, raw: () => lastRaw as Raw, txOptions: () => txOptions };
}
const nonSql = (events: string[]) => events.filter((e) => !e.startsWith('SQL:'));
const sqlOf = (events: string[]) => events.filter((e) => e.startsWith('SQL:')).map((e) => e.slice(4));

function stepsOf(events: string[], over: Partial<ProtectedSteps> = {}): Partial<ProtectedSteps> {
  let reads = 0;
  let classifies = 0;
  return {
    proveIdentity: async () => { events.push('identity'); },
    assertSettings: async () => { events.push('settings'); },
    proveDomain: async () => { events.push('domain'); },
    classify: async () => { classifies += 1; events.push('classify'); return classifies === 1 ? 'POST_BACKFILL' : 'EXACT_BASELINE'; },
    readState: async (_tx, sinks, keep) => {
      reads += 1;
      events.push(`readState:${reads}`);
      for (const s of sinks) s.write(reads === 1 ? P_BYTES : Q_BYTES);
      return { rows: keep ? new Map([['User', [[reads === 1 ? 'p-row' : 'q-row']]]]) : null, serverVersionNum: '170004', markerId: UUID, schemaDigest: SCHEMA };
    },
    seed: async () => { events.push('seed'); },
    verifyTransformation: async () => { events.push('verify'); },
    ...over,
  };
}
function requestOf(events: string[], over: Partial<ProtectedResumeRequest> = {}): ProtectedResumeRequest {
  return {
    expectedFPre: F_PRE,
    passwordHash: 'hash',
    checkPreconditions: async () => { events.push('preconditions'); },
    consumeAuthorization: async () => { events.push('consume'); },
    persistPostWitness: async (r: PostWitnessRequest) => { events.push('witness'); return { durable: true, nonce: r.nonce, fPost: r.fPost }; },
    ...over,
  };
}
const optionsOf = (events: string[], over: Partial<ProtectedSteps> = {}, extra: ProtectedResumeOptions = {}): ProtectedResumeOptions => ({
  steps: stepsOf(events, over), randomNonce: () => NONCE, transformationContractSha256: 'c'.repeat(64), ...extra,
});
const failureOf = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as ResumeFailure; } throw new Error('expected a failure'); };
const run = (hx: ReturnType<typeof harness>, events: string[], req: Partial<ProtectedResumeRequest> = {}, over: Partial<ProtectedSteps> = {}, extra: ProtectedResumeOptions = {}) =>
  withProtectedResumeTransaction(hx.prisma, requestOf(events, req), optionsOf(events, over, extra));

describe('statement classifier (LOW-8 class-level)', () => {
  it('AC-102 classifies SET/RESET/set_config/transaction control/DDL/multi-statement text as forbidden, whatever the spelling', () => {
    const forbidden = [
      'BEGIN', 'begin', ' \n BEGIN ISOLATION LEVEL SERIALIZABLE', 'START TRANSACTION', 'COMMIT', 'END', 'ROLLBACK', 'ABORT', 'SAVEPOINT s', 'RELEASE SAVEPOINT s',
      'SET LOCAL synchronous_commit = off', 'set synchronous_commit to off', 'SET search_path = public', 'RESET ALL', 'RESET synchronous_commit',
      'LOCK TABLE "User" IN ACCESS EXCLUSIVE MODE', 'DISCARD ALL', 'DECLARE c CURSOR FOR SELECT 1', 'PREPARE p AS SELECT 1', 'LISTEN x', 'NOTIFY x',
      'CREATE TABLE t (a int)', 'ALTER TABLE "User" ADD COLUMN x int', 'DROP TABLE "User"', 'TRUNCATE "User"', 'GRANT ALL ON "User" TO x', 'COPY "User" TO STDOUT',
      'DO $$ BEGIN END $$', 'CALL p()', 'VACUUM', 'REINDEX TABLE "User"', 'EXECUTE p',
      "SELECT set_config('synchronous_commit','off',true)", "select SET_CONFIG ( 'a','b',true )", "WITH x AS (SELECT set_config('a','b',true)) SELECT 1",
      'SELECT 1; SET synchronous_commit = off', '/* c */ SET x = 1', '-- c\nSET x = 1', '/* /* nested */ SET x = 1 */ SELECT 1', '', '   ', ';', 'VALUES (1)',
    ];
    for (const sql of forbidden) expect(classifyStatement(sql), JSON.stringify(sql)).toBe('forbidden');
  });
  it('classifies ordinary SELECT/WITH as read and INSERT/UPDATE/DELETE as forbidden', () => {
    for (const sql of ['SELECT 1', ' select x from "User"', 'WITH a AS (SELECT 1) SELECT * FROM a', '-- c\nSELECT 1', '/* c */ SELECT 1', 'SELECT pg_advisory_xact_lock(506005)::text', 'SELECT 1;']) {
      expect(classifyStatement(sql), sql).toBe('read');
    }
    for (const sql of ['INSERT INTO "X" VALUES (1)', 'update "X" set a = 1', 'DELETE FROM "X"']) expect(classifyStatement(sql), sql).toBe('forbidden');
  });
});

describe('ProtectedTx wrapper', () => {
  const rawStub = () => {
    const seen: string[] = [];
    return {
      seen,
      raw: {
        $queryRawUnsafe: async (s: string) => { seen.push(s); return []; },
        $executeRawUnsafe: async (s: string) => { seen.push(s); return 0; },
        $queryRaw: async (s: TemplateStringsArray) => { seen.push(s.join('?')); return []; },
        $executeRaw: async (s: TemplateStringsArray) => { seen.push(s.join('?')); return 0; },
        $transaction: async () => 'REACHED', $connect: async () => 'REACHED', $disconnect: async () => 'REACHED', $on: () => 'REACHED', $use: () => 'REACHED', $extends: () => 'REACHED',
        user: { findMany: async () => ['row'] },
      },
    };
  };
  it('AC-101 a protected statement before the locks are complete is rejected before it reaches the database', async () => {
    const { raw, seen } = rawStub();
    const session = { id: 's1', phase: 'setup' as const, statements: [] as { sql: string; token: string }[] };
    const tx = protectTx(raw, session) as unknown as { $queryRawUnsafe: (s: string) => Promise<unknown>; $queryRaw: (s: TemplateStringsArray) => Promise<unknown> };
    await expect(tx.$queryRawUnsafe('SELECT 1')).rejects.toThrow();
    await expect(tx.$queryRaw`SELECT 2`).rejects.toThrow();
    expect(seen).toEqual([]);
    (session as { phase: string }).phase = 'locked';
    await expect(tx.$queryRawUnsafe('SELECT 1')).resolves.toEqual([]);
    expect(seen).toEqual(['SELECT 1']);
  });
  it('AC-100 transaction-control and client-lifecycle members are unreachable, and forbidden SQL never reaches the connection', async () => {
    const { raw, seen } = rawStub();
    const session = { id: 's2', phase: 'locked' as const, statements: [] as { sql: string; token: string }[] };
    const tx = protectTx(raw, session) as unknown as Record<string, (...a: unknown[]) => unknown>;
    for (const member of ['$transaction', '$connect', '$disconnect', '$on', '$use', '$extends']) {
      expect(() => (tx[member] as () => unknown)(), member).toThrow();
    }
    for (const sql of ['BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT x', 'SET LOCAL x = 1', "SELECT set_config('a','b',true)", 'LOCK TABLE "User" IN ACCESS EXCLUSIVE MODE']) {
      await expect((tx.$executeRawUnsafe as (s: string) => Promise<unknown>)(sql), sql).rejects.toThrow();
      await expect((tx.$queryRawUnsafe as (s: string) => Promise<unknown>)(sql), sql).rejects.toThrow();
    }
    expect(seen).toEqual([]);
    // model delegates pass through unchanged
    await expect((tx as unknown as { user: { findMany: () => Promise<unknown> } }).user.findMany()).resolves.toEqual(['row']);
  });
  it('every proxied statement is recorded with the one capability token of its session', async () => {
    const { raw } = rawStub();
    const session = { id: 'tok-1', phase: 'locked' as const, statements: [] as { sql: string; token: string }[] };
    const tx = protectTx(raw, session) as unknown as { $queryRawUnsafe: (s: string) => Promise<unknown>; $queryRaw: (s: TemplateStringsArray) => Promise<unknown> };
    await tx.$queryRawUnsafe('SELECT 1');
    await tx.$queryRaw`SELECT 2`;
    expect(session.statements.map((s) => s.token)).toEqual(['tok-1', 'tok-1']);
  });
});

describe('commit gate (C10)', () => {
  const good = { durable: true, nonce: NONCE, fPost: F_POST };
  it('AC-059 commit without a minted token throws and issues nothing', () => {
    const gate = createCommitGate(NONCE, F_POST);
    for (const forged of [undefined, null, {}, { kind: 'WitnessDurable' }, true, 'token', { durable: true }]) expect(() => gate.commit(forged), String(forged)).toThrow();
    const other = createCommitGate(NONCE, F_POST).mint(good);
    expect(() => gate.commit(other)).toThrow(); // a token of another gate is not accepted
  });
  it('AC-055/057/058 a malformed, wrong-nonce, wrong-fPost or forged receipt never mints a token', () => {
    const gate = createCommitGate(NONCE, F_POST);
    for (const bad of [undefined, true, 'durable', { durable: 'yes', nonce: NONCE, fPost: F_POST }, { durable: false, nonce: NONCE, fPost: F_POST }, { durable: true },
      { durable: true, nonce: 'x'.repeat(32), fPost: F_POST }, { durable: true, nonce: NONCE, fPost: 'f'.repeat(64) }, { nonce: NONCE, fPost: F_POST }]) {
      expect(() => gate.mint(bad), JSON.stringify(bad)).toThrow();
    }
  });
  it('a valid receipt mints a token that commits exactly once', () => {
    const gate = createCommitGate(NONCE, F_POST);
    const token = gate.mint(good);
    expect(() => gate.commit(token)).not.toThrow();
    expect(() => gate.commit(token)).toThrow();
  });
});

const LOCKED_TABLES = 25;
describe('withProtectedResumeTransaction (T0–T16)', () => {
  it('AC-063/122 happy path: the steps run in the reviewed order and COMMIT is the last event, issued once', async () => {
    const hx = harness(); const events = hx.events;
    const result = await run(hx, events);
    expect(result).toEqual({ fPost: F_POST });
    expect(nonSql(events)).toEqual(['BEGIN', 'identity', 'settings', 'domain', 'classify', 'readState:1', 'preconditions', 'consume', 'settings', 'seed', 'settings', 'classify', 'readState:2', 'verify', 'witness', 'settings', 'COMMIT']);
    expect(events.filter((e) => e === 'COMMIT')).toHaveLength(1);
    expect(events.at(-1)).toBe('COMMIT');
    expect(hx.calls()).toBe(1);
  });

  it('AC-107/112 the owner statements: search_path first, then the timeouts and synchronous_commit, then the marker and 25 table locks, before any step', async () => {
    const hx = harness(); const events = hx.events;
    await run(hx, events);
    const sql = sqlOf(events);
    expect(sql.slice(0, 6)).toEqual([
      'SET LOCAL search_path = pg_catalog, pg_temp',
      "SET LOCAL lock_timeout = '10s'",
      "SET LOCAL statement_timeout = '120s'",
      "SET LOCAL idle_in_transaction_session_timeout = '180s'",
      'SET LOCAL synchronous_commit = on',
      // seed timestamps are bound as zone-less text by the adapter: pin the zone so the seed writes the same instant everywhere
      "SET LOCAL timezone = 'UTC'",
    ]);
    expect(sql[6]).toBe('LOCK TABLE mona_local_test_guard.database_identity IN SHARE MODE');
    const locks = sql.slice(7, 7 + LOCKED_TABLES);
    expect(locks).toHaveLength(LOCKED_TABLES);
    for (const l of locks) expect(l).toMatch(/^LOCK TABLE public\."[A-Za-z_]+" IN EXCLUSIVE MODE$/);
    expect(locks).toContain('LOCK TABLE public."_prisma_migrations" IN EXCLUSIVE MODE');
    expect(sql).toHaveLength(7 + LOCKED_TABLES); // no other owner statement
    // every lock precedes the first step
    const lastLock = events.lastIndexOf(`SQL:${locks.at(-1)}`);
    expect(events.indexOf('identity')).toBeGreaterThan(lastLock);
  });

  it('AC-086 the authorization is consumed only after every validation and immediately before the seed', async () => {
    const hx = harness(); const events = hx.events;
    await run(hx, events);
    const n = nonSql(events);
    const consume = n.indexOf('consume');
    expect(n.indexOf('preconditions')).toBeLessThan(consume);
    expect(n.indexOf('readState:1')).toBeLessThan(consume);
    expect(n.slice(consume, n.indexOf('seed') + 1)).toEqual(['consume', 'settings', 'seed']);
  });

  const matrix: { name: string; stage: string; over?: Partial<ProtectedSteps>; req?: Partial<ProtectedResumeRequest>; consumed: boolean; seeded: boolean }[] = [
    { name: 'identity', stage: 'identity', over: { proveIdentity: async () => { throw new Error(CANARY); } }, consumed: false, seeded: false },
    { name: 'settings', stage: 'settings', over: { assertSettings: async () => { throw new Error(CANARY); } }, consumed: false, seeded: false },
    { name: 'domain', stage: 'domain', over: { proveDomain: async () => { throw new Error(CANARY); } }, consumed: false, seeded: false },
    { name: 'classify (not POST_BACKFILL)', stage: 'classify', over: { classify: async () => 'EXACT_BASELINE' }, consumed: false, seeded: false },
    { name: 'preconditions', stage: 'preconditions', req: { checkPreconditions: async () => { throw new Error(CANARY); } }, consumed: false, seeded: false },
    { name: 'consume', stage: 'consume', req: { consumeAuthorization: async () => { throw new Error(CANARY); } }, consumed: false, seeded: false },
    { name: 'seed', stage: 'seed', over: { seed: async () => { throw new Error(CANARY); } }, consumed: true, seeded: false },
    { name: 'classify after seed (not EXACT_BASELINE)', stage: 'classify-post', over: { classify: (() => { let n = 0; return async () => (++n === 1 ? 'POST_BACKFILL' : 'POST_BACKFILL'); })() }, consumed: true, seeded: true },
    { name: 'verify', stage: 'verify', over: { verifyTransformation: async () => { throw new Error(CANARY); } }, consumed: true, seeded: true },
    { name: 'witness not durable', stage: 'witness', req: { persistPostWitness: async () => ({ durable: false }) }, consumed: true, seeded: true },
  ];
  for (const m of matrix) {
    it(`failure at ${m.name} ⇒ ROLLBACK, no COMMIT, stage ${m.stage}, authorization consumed=${m.consumed}`, async () => {
      const hx = harness(); const events = hx.events;
      const failure = await failureOf(run(hx, events, m.req, m.over));
      expect(failure).toBeInstanceOf(ResumeFailure);
      expect([failure.kind, failure.stage]).toEqual(['ROLLED_BACK', m.stage]);
      expect(events).toContain('ROLLBACK');
      expect(events).not.toContain('COMMIT');
      expect(events.includes('consume')).toBe(m.consumed);
      expect(events.includes('seed')).toBe(m.seeded);
      expect(hx.calls()).toBe(1);
    });
  }

  it('a pre-image fingerprint different from the verified fPre stops at validation before anything is consumed', async () => {
    const hx = harness(); const events = hx.events;
    const failure = await failureOf(run(hx, events, { expectedFPre: 'a'.repeat(64) }));
    expect([failure.kind, failure.stage]).toEqual(['ROLLED_BACK', 'validate']);
    expect(events).not.toContain('consume');
    expect(events).not.toContain('preconditions');
  });

  it('AC-054/055/056 a witness callback that reports not-durable, returns junk, throws or rejects ⇒ ROLLBACK and COMMIT is never issued', async () => {
    for (const persist of [async () => ({ durable: false }), async () => undefined, async () => true, async () => 'durable', async () => ({ durable: 'yes' }), async () => { throw new Error(CANARY); }]) {
      const hx = harness(); const events = hx.events;
      const failure = await failureOf(run(hx, events, { persistPostWitness: persist as ProtectedResumeRequest['persistPostWitness'] }));
      expect([failure.kind, failure.stage]).toEqual(['ROLLED_BACK', 'witness']);
      expect(events).not.toContain('COMMIT');
    }
  });

  it('AC-057/058 a receipt with a wrong or replayed nonce, a wrong fPost, or forged without the nonce ⇒ ROLLBACK', async () => {
    const receipts = [(r: PostWitnessRequest) => ({ durable: true, nonce: 'z'.repeat(32), fPost: r.fPost }), (r: PostWitnessRequest) => ({ durable: true, nonce: r.nonce, fPost: 'f'.repeat(64) }), () => ({ durable: true })];
    for (const make of receipts) {
      const hx = harness(); const events = hx.events;
      const failure = await failureOf(run(hx, events, { persistPostWitness: async (r) => make(r) }));
      expect(failure.stage).toBe('witness');
      expect(events).not.toContain('COMMIT');
    }
  });

  it('AC-060/118 a witness callback that never settles hits the owner deadline ⇒ ROLLBACK', async () => {
    let fire: () => void = () => undefined;
    const timers = { setTimeout: (fn: () => void) => { fire = fn; return 1; }, clearTimeout: () => undefined };
    const hx = harness(); const events = hx.events;
    const pending = failureOf(run(hx, events, { persistPostWitness: () => new Promise(() => undefined) }, {}, { timers, witnessDeadlineMs: 10_000 }));
    await new Promise((r) => setImmediate(r));
    fire();
    const failure = await pending;
    expect([failure.stage, failure.reason]).toEqual(['witness', 'TIMEOUT']);
    expect(events).not.toContain('COMMIT');
  });

  it('AC-061 the witness callback receives digests and bounded metadata only', async () => {
    const hx = harness(); const events = hx.events; let seen: PostWitnessRequest | null = null;
    await run(hx, events, { persistPostWitness: async (r) => { seen = r; return { durable: true, nonce: r.nonce, fPost: r.fPost }; } });
    expect(Object.keys(seen as unknown as object).sort()).toEqual(['fPost', 'fPre', 'markerId', 'nonce', 'protectedDomainContractSha256', 'serverVersionNum', 'transformationContractSha256']);
    const r = seen as unknown as PostWitnessRequest;
    expect([r.fPre, r.fPost, r.nonce, r.serverVersionNum, r.markerId]).toEqual([F_PRE, F_POST, NONCE, '170004', UUID]);
    expect(r.protectedDomainContractSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('AC-062 no database statement is issued while the witness callback runs', async () => {
    const hx = harness(); const events = hx.events; let before = -1; let after = -1;
    await run(hx, events, { persistPostWitness: async (r) => { before = hx.raw().statements.length; await new Promise((x) => setTimeout(x, 5)); after = hx.raw().statements.length; return { durable: true, nonce: r.nonce, fPost: r.fPost }; } });
    expect(before).toBeGreaterThan(0);
    expect(after).toBe(before);
  });

  it('AC-115 the settings are re-proved immediately before COMMIT; a drifted value ⇒ ROLLBACK and no COMMIT', async () => {
    const hx = harness(); const events = hx.events; let n = 0;
    const failure = await failureOf(run(hx, events, {}, { assertSettings: async () => { n += 1; events.push('settings'); if (n === 4) throw new Error('drift'); } }));
    expect(failure.stage).toBe('final-settings');
    expect(events).toContain('witness');
    expect(events).not.toContain('COMMIT');
    const ok = harness();
    await run(ok, ok.events);
    const n2 = nonSql(ok.events);
    expect(n2.slice(-3)).toEqual(['witness', 'settings', 'COMMIT']);
  });

  it('AC-108 search_path/settings are re-proved before the seed and again before the verifier: drift at either point rolls back and the later step never runs', async () => {
    for (const [driftAt, stage, mustNotRun] of [[2, 'settings', 'seed'], [3, 'settings', 'verify']] as const) {
      const hx = harness(); const events = hx.events; let n = 0;
      const failure = await failureOf(run(hx, events, {}, { assertSettings: async () => { n += 1; events.push('settings'); if (n === driftAt) throw new Error('drift'); } }));
      expect(failure.kind, `drift at ${driftAt}`).toBe('ROLLED_BACK');
      expect(failure.stage, String(stage)).toMatch(/settings/);
      expect(events).not.toContain(mustNotRun);
      expect(events).not.toContain('witness');
      expect(events).not.toContain('COMMIT');
    }
  });

  it('AC-119/121 a seed that changes nothing (H_pre(Q) == fPre) rolls back before any witness', async () => {
    const hx = harness(); const events = hx.events;
    let reads = 0;
    const failure = await failureOf(run(hx, events, {}, {
      readState: async (_tx, sinks) => { reads += 1; for (const s of sinks) s.write(P_BYTES); return { rows: new Map([['User', [['same']]]]), serverVersionNum: '170004', markerId: UUID, schemaDigest: SCHEMA }; },
    }));
    expect(reads).toBe(2);
    // AC-121: the unchanged Q is caught because the guard compares in the PRE domain; a POST-domain comparison would have missed it
    expect(digest('POST', P_BYTES)).not.toBe(F_PRE);
    expect(failure.stage).toBe('guard');
    expect(events).not.toContain('witness');
    expect(events).not.toContain('COMMIT');
  });

  it('a schema digest that differs between the pre-image and the post-image read (a DDL during the seed) stops at verify, before the witness', async () => {
    const hx = harness(); const events = hx.events; let reads = 0;
    const failure = await failureOf(run(hx, events, {}, {
      readState: async (_tx, sinks) => { reads += 1; for (const s of sinks) s.write(reads === 1 ? P_BYTES : Q_BYTES); return { rows: new Map([['User', [[`r${reads}`]]]]), serverVersionNum: '170004', markerId: UUID, schemaDigest: reads === 1 ? 'a'.repeat(64) : 'b'.repeat(64) }; },
    }));
    expect([failure.kind, failure.stage]).toEqual(['ROLLED_BACK', 'verify']);
    expect(events).not.toContain('witness');
  });

  it('AC-120 the transformation verifier runs before the guard and before any witness: a verifier failure never reaches the witness', async () => {
    const hx = harness(); const events = hx.events;
    await failureOf(run(hx, events, {}, { verifyTransformation: async () => { events.push('verify'); throw new Error('only bcrypt changed'); } }));
    expect(events.indexOf('verify')).toBeGreaterThan(-1);
    expect(events).not.toContain('witness');
  });

  it('AC-123/124 exactly one pre-image read and one post-image read; the digests handed to the witness come from the single Q read the verifier consumed', async () => {
    const hx = harness(); const events = hx.events; let preRows: unknown = null; let postRows: unknown = null; let seenPre: unknown = null; let seenPost: unknown = null;
    await run(hx, events, {}, {
      readState: (() => { let n = 0; return async (_tx: unknown, sinks: readonly DigestSink[]) => {
        n += 1; for (const s of sinks) s.write(n === 1 ? P_BYTES : Q_BYTES);
        const rows = new Map([['User', [[`row-${n}`]]]]);
        events.push(`readState:${n}`);
        if (n === 1) preRows = rows; else postRows = rows;
        return { rows, serverVersionNum: '170004', markerId: UUID, schemaDigest: SCHEMA };
      }; })(),
      verifyTransformation: async (pre, post) => { seenPre = pre; seenPost = post; events.push('verify'); },
    });
    expect(events.filter((e) => e.startsWith('readState:'))).toEqual(['readState:1', 'readState:2']);
    expect(seenPre).toBe(preRows);
    expect(seenPost).toBe(postRows);
  });

  it('AC-125 rows and thrown details never appear in the failure: no cause, constant message, no canary in any enumerable property or stack', async () => {
    const hx = harness(); const events = hx.events;
    const failure = await failureOf(run(hx, events, {}, {
      readState: async (_tx, sinks) => { for (const s of sinks) s.write(P_BYTES); return { rows: new Map([['User', [[CANARY]]]]), serverVersionNum: '170004', markerId: UUID, schemaDigest: SCHEMA }; },
      verifyTransformation: async () => { throw Object.assign(new Error(`row ${CANARY}`), { cause: { row: CANARY }, meta: { target: [CANARY] } }); },
    }));
    expect(Object.getOwnPropertyNames(failure).sort()).toEqual(['kind', 'message', 'reason', 'stack', 'stage']);
    expect(JSON.stringify(failure)).not.toContain(CANARY);
    expect(String(failure.stack)).not.toContain(CANARY);
    expect(failure.message).not.toContain(CANARY);
    expect((failure as { cause?: unknown }).cause).toBeUndefined();
  });

  it('a SQLSTATE lock/statement/idle timeout from a step maps to reason TIMEOUT, anything else to FAILED', async () => {
    for (const code of ['55P03', '57014', '25P03']) {
      const hx = harness();
      const failure = await failureOf(run(hx, hx.events, {}, { seed: async () => { throw Object.assign(new Error('x'), { code }); } }));
      expect(failure.reason, code).toBe('TIMEOUT');
    }
    const hx = harness();
    expect((await failureOf(run(hx, hx.events, {}, { seed: async () => { throw new Error('x'); } }))).reason).toBe('FAILED');
  });

  it('G37 an unknown COMMIT outcome is reported as COMMIT_UNKNOWN after exactly one attempt (never retried)', async () => {
    const hx = harness({ failCommit: true }); const events = hx.events;
    const failure = await failureOf(run(hx, events));
    expect([failure.kind, failure.stage]).toEqual(['COMMIT_UNKNOWN', 'commit']);
    expect(hx.calls()).toBe(1);
    expect(events).toContain('COMMIT-FAILED');
  });

  it('AC-099 the full path over sentinels commits with zero sentinel hits and every proxied statement carries one capability token', async () => {
    h.hits.length = 0;
    const hx = harness(); const events = hx.events; const tokens = new Set<string>();
    let reads = 0;
    await run(hx, events, {}, {
      readState: async (tx, sinks) => {
        reads += 1;
        await (tx as unknown as { $queryRawUnsafe: (s: string) => Promise<unknown> }).$queryRawUnsafe('SELECT 1');
        for (const s of sinks) s.write(reads === 1 ? P_BYTES : Q_BYTES); return { rows: new Map(), serverVersionNum: '170004', markerId: UUID, schemaDigest: SCHEMA };
      },
      seed: async (tx) => { await (tx as unknown as { $queryRaw: (s: TemplateStringsArray) => Promise<unknown> }).$queryRaw`SELECT pg_advisory_xact_lock(506005)::text`; },
    }, { observer: (r) => { if (r.source === 'step') tokens.add(r.token); } });
    expect(h.hits).toEqual([]);
    expect(events.at(-1)).toBe('COMMIT');
    expect(tokens.size).toBe(1);
  });

  const escapes: [string, (tx: Record<string, (...a: unknown[]) => unknown>) => Promise<unknown>][] = [
    ['new PrismaClient', async () => { const m = await import('../src/generated/prisma/client.js'); return new (m.PrismaClient as unknown as new () => unknown)(); }],
    ['new Pool', async () => { const m = await import('pg'); return new (m.Pool as unknown as new () => unknown)(); }],
    ['pool.connect', async () => { const m = await import('pg'); const Pool = m.Pool as unknown as new () => { connect: () => Promise<unknown> }; return new Pool().connect(); }],
    ['nested $transaction', async (tx) => (tx.$transaction as () => unknown)()],
    ['helper BEGIN', async (tx) => (tx.$executeRawUnsafe as (s: string) => unknown)('BEGIN')],
    ['helper COMMIT', async (tx) => (tx.$executeRawUnsafe as (s: string) => unknown)('COMMIT')],
    ['helper ROLLBACK', async (tx) => (tx.$queryRawUnsafe as (s: string) => unknown)('ROLLBACK')],
    ['plain SET', async (tx) => (tx.$executeRawUnsafe as (s: string) => unknown)('SET search_path = public')],
    ['synchronous_commit weakening (LOW-8)', async (tx) => (tx.$executeRawUnsafe as (s: string) => unknown)('SET LOCAL synchronous_commit = off')],
    ['set_config', async (tx) => (tx.$queryRawUnsafe as (s: string) => unknown)("SELECT set_config('synchronous_commit','off',true)")],
    ['subprocess', async () => { const m = await import('node:child_process'); return (m.spawn as unknown as () => unknown)(); }],
  ];
  for (const [name, attempt] of escapes) {
    it(`AC-100/114 an injected escape (${name}) from a protected step ⇒ ROLLBACK`, async () => {
      h.hits.length = 0;
      const hx = harness(); const events = hx.events;
      const failure = await failureOf(run(hx, events, {}, { seed: async (tx) => { await attempt(tx as unknown as Record<string, (...a: unknown[]) => unknown>); } }));
      expect([failure.kind, failure.stage]).toEqual(['ROLLED_BACK', 'seed']);
      expect(events).toContain('ROLLBACK');
      expect(events).not.toContain('COMMIT');
      const forbiddenSql = hx.raw().statements.filter((s) => /^(BEGIN|COMMIT|ROLLBACK)\b|SET search_path = public|synchronous_commit = off|set_config/i.test(s));
      expect(forbiddenSql).toEqual([]);
    });
  }
});

describe('proveIdentityOnTransaction (G40, AC-103..105)', () => {
  const MARKER = '22222222-2222-4222-8222-222222222222';
  const REFUSAL = 'LOCAL_TEST identity could not be proven; refusing destructive writes';
  const facts = () => ({
    schemaOwnerIsCurrentUser: true,
    relations: [{ name: 'database_identity', kind: 'r' }, { name: 'database_identity_pkey', kind: 'i' }],
    table: { kind: 'r', persistence: 'p', isPartition: false, ofType: false, ownerIsCurrentUser: true, rowSecurity: false, forceRowSecurity: false, hasSubclass: false, parents: 0, children: 0, hasRules: false, triggers: 0 },
    columns: [
      { name: 'singleton', type: 'boolean', notNull: true, default: 'true', generated: '', identity: '', collation: null },
      { name: 'environment', type: 'text', notNull: true, default: null, generated: '', identity: '', collation: 'default' },
      { name: 'marker_id', type: 'uuid', notNull: true, default: null, generated: '', identity: '', collation: null },
      { name: 'installed_at', type: 'timestamp with time zone', notNull: true, default: 'now()', generated: '', identity: '', collation: null },
    ],
    constraints: [{ type: 'c', definition: "CHECK ((environment = 'local_test'::text))" }, { type: 'c', definition: 'CHECK (singleton)' }, { type: 'p', definition: 'PRIMARY KEY (singleton)' }],
  });
  const live = () => ({ current_database: 'mona_local_test', current_user: 'mona_local_test', version: 'PostgreSQL 17.4 on x86_64', test_guard_exists: false, pilot_guard_exists: false });
  function fakeTx(over: { live?: object; structure?: unknown; markers?: object[]; throwOn?: RegExp; factsAsString?: boolean } = {}) {
    const statements: string[] = [];
    const tx = {
      statements,
      $queryRawUnsafe: async (sql: string) => {
        statements.push(sql);
        if (over.throwOn?.test(sql)) throw Object.assign(new Error(`password=${CANARY}`), { code: '28P01' });
        if (sql.includes('json_build_object')) return [{ facts: over.factsAsString ? JSON.stringify(over.structure ?? facts()) : (over.structure ?? facts()) }];
        if (sql.includes('current_database()')) return [over.live ?? live()];
        return over.markers ?? [{ environment: 'local_test', marker_id: MARKER, has_installed_at: true }];
      },
      $executeRawUnsafe: async (sql: string) => { statements.push(sql); return 0; },
    };
    return tx;
  }
  const prove = (tx: ReturnType<typeof fakeTx>) => proveIdentityOnTransaction(tx as unknown as ProtectedTx, MARKER);

  it('AC-103 a valid identity is proven with three SELECTs and no transaction-control, SET or LOCK statement', async () => {
    const tx = fakeTx();
    await expect(prove(tx)).resolves.toBeUndefined();
    expect(tx.statements).toHaveLength(3);
    for (const sql of tx.statements) {
      expect(classifyStatement(sql), sql).toBe('read');
      expect(sql).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK|SET|LOCK|SAVEPOINT|RELEASE)\b/i);
    }
  });
  it('the marker structure facts may arrive as a JSON string (adapter-dependent)', async () => {
    const ok = fakeTx({ factsAsString: true });
    await expect(prove(ok)).resolves.toBeUndefined();
    expect(ok.statements).toHaveLength(3);
    const badFacts = fakeTx({ factsAsString: true, structure: { ...facts(), schemaOwnerIsCurrentUser: false } });
    await expect(prove(badFacts)).rejects.toThrow(REFUSAL);
  });
  it('AC-104 a wrong database/user/version/marker/structure or a guard schema is refused with the constant message and without any ROLLBACK or COMMIT', async () => {
    const bad = [
      fakeTx({ live: { ...live(), current_database: 'other' } }),
      fakeTx({ live: { ...live(), current_user: 'other' } }),
      fakeTx({ live: { ...live(), version: 'PostgreSQL 16.2' } }),
      fakeTx({ live: { ...live(), test_guard_exists: true } }),
      fakeTx({ live: { ...live(), pilot_guard_exists: true } }),
      fakeTx({ markers: [{ environment: 'local_test', marker_id: '33333333-3333-4333-8333-333333333333', has_installed_at: true }] }),
      fakeTx({ markers: [] }),
      fakeTx({ markers: [{ environment: 'local_test', marker_id: MARKER, has_installed_at: true }, { environment: 'local_test', marker_id: MARKER, has_installed_at: true }] }),
      fakeTx({ markers: [{ environment: 'demo', marker_id: MARKER, has_installed_at: true }] }),
      fakeTx({ structure: { ...facts(), schemaOwnerIsCurrentUser: false } }),
      fakeTx({ structure: { ...facts(), columns: facts().columns.slice(1) } }),
      fakeTx({ structure: {} }),
      fakeTx({ structure: 'junk, not json', factsAsString: false }),
      fakeTx({ throwOn: /current_database\(\)/ }),
      fakeTx({ throwOn: /json_build_object/ }),
    ];
    for (const tx of bad) {
      const error = await prove(tx).then(() => null, (e: unknown) => e as Error);
      expect(error, 'must refuse').not.toBeNull();
      expect((error as Error).message).toBe(REFUSAL);
      expect((error as { cause?: unknown }).cause).toBeUndefined();
      expect(JSON.stringify(Object.getOwnPropertyNames(error))).not.toContain(CANARY);
      expect(tx.statements.filter((s) => /^\s*(BEGIN|COMMIT|ROLLBACK)\b/i.test(s))).toEqual([]);
    }
  });
  it('AC-105 the in-transaction proof reuses the protected identity read adapter and validators and never calls the connection-level proof', () => {
    const source = readFileSync(new URL('../scripts/demo-database.ts', import.meta.url), 'utf8');
    const body = /export async function proveIdentityOnTransaction[\s\S]*?\n}\n/.exec(source)?.[0] ?? '';
    expect(body.length).toBeGreaterThan(100);
    expect(body).not.toMatch(/proveLocalTestIdentity\s*\(|\bBEGIN\b|\bCOMMIT\b|\bROLLBACK\b|pool\.connect|new\s+(Pool|PrismaClient|PrismaPg)/);
    expect(body).toMatch(/readProtectedRows\(tx, \{ kind: 'identity', query: 'liveFacts' \}/);
    expect(body).toMatch(/readProtectedRows\(tx, \{ kind: 'identity', query: 'markerFacts' \}/);
    expect(body).toMatch(/readProtectedRows\(tx, \{ kind: 'identity', query: 'markerRows' \}/);
    expect(body).not.toMatch(/\$queryRawUnsafe|sql:\s*string/);
  });
});

describe('read-only outcome verifier (LOW-7, G36/G37)', () => {
  const digestsOf = (events: string[], over: Partial<ProtectedSteps> = {}) => ({
    ...stepsOf(events, over),
    readState: async (_tx: unknown, sinks: readonly DigestSink[], keep: boolean) => {
      events.push(`readState:${keep}`);
      for (const s of sinks) s.write(Q_BYTES);
      return { rows: null, serverVersionNum: '170004', markerId: UUID, schemaDigest: SCHEMA };
    },
  });
  it('AC-072/175 the verifier transaction is READ ONLY under REPEATABLE READ and sets search_path, lock_timeout and statement_timeout BEFORE any lock or read', async () => {
    const hx = harness(); const events = hx.events;
    const out = await checkOutcomeTransaction(hx.prisma, { steps: digestsOf(events) });
    const sql = sqlOf(events);
    expect(sql.slice(0, 6)).toEqual([
      'SET TRANSACTION READ ONLY',
      'SET LOCAL search_path = pg_catalog, pg_temp',
      "SET LOCAL lock_timeout = '10s'",
      "SET LOCAL statement_timeout = '120s'",
      "SET LOCAL idle_in_transaction_session_timeout = '180s'",
      "SET LOCAL timezone = 'UTC'", // HIGH-1: the profile pins the zone itself
    ]);
    const locks = sql.slice(6);
    expect(locks).toHaveLength(1 + LOCKED_TABLES);
    expect(locks[0]).toBe('LOCK TABLE mona_local_test_guard.database_identity IN ACCESS SHARE MODE');
    for (const l of locks.slice(1)) expect(l).toMatch(/^LOCK TABLE public\."[A-Za-z_]+" IN ACCESS SHARE MODE$/);
    expect(events.indexOf('identity')).toBeGreaterThan(events.lastIndexOf(`SQL:${locks.at(-1)}`));
    expect((hx.txOptions()[0] as { isolationLevel?: string }).isolationLevel).toBe('RepeatableRead');
    expect(out).toEqual({
      pre: digest('PRE', Q_BYTES), post: digest('POST', Q_BYTES), serverVersionNum: '170004', markerId: UUID,
      // metadata the tool binds witnesses to (digest values only): which domain contract and which transformation verifier(s) are current
      protectedDomainContractSha256: protectedDomainContractSha256(), acceptedTransformationContractSha256s: [TRANSFORMATION_CONTRACT_SHA256],
    });
    expect(sql.join('\n')).not.toMatch(/synchronous_commit|INSERT|UPDATE|DELETE/);
  });
  it('the verifier reads the state once, without keeping rows, and issues no seed/write step', async () => {
    const hx = harness(); const events = hx.events;
    await checkOutcomeTransaction(hx.prisma, { steps: digestsOf(events) });
    expect(events.filter((e) => e.startsWith('readState'))).toEqual(['readState:false']);
    expect(events).not.toContain('seed');
    expect(events).not.toContain('consume');
    expect(events.at(-1)).toBe('COMMIT'); // a read-only transaction ends with COMMIT; no write was issued
  });
  it('AC-073 a lock or statement timeout is reported as TIMEOUT after exactly one attempt, with no value in the error', async () => {
    for (const code of ['55P03', '57014']) {
      const hx = harness();
      const error = await checkOutcomeTransaction(hx.prisma, { steps: digestsOf(hx.events, { proveDomain: async () => { throw Object.assign(new Error(CANARY), { code }); } }) }).then(() => null, (e: unknown) => e as OutcomeCheckFailure);
      expect(error).toBeInstanceOf(OutcomeCheckFailure);
      expect(error?.reason).toBe('TIMEOUT');
      expect(hx.calls()).toBe(1);
      expect(JSON.stringify([error?.message, error?.stack, Object.getOwnPropertyNames(error as object)])).not.toContain(CANARY);
      expect((error as { cause?: unknown }).cause).toBeUndefined();
    }
    const hx = harness();
    const generic = await checkOutcomeTransaction(hx.prisma, { steps: digestsOf(hx.events, { assertSettings: async () => { throw new Error('x'); } }) }).then(() => null, (e: unknown) => e as OutcomeCheckFailure);
    expect(generic?.reason).toBe('FAILED');
  });
});

describe('backup snapshot exporter (B1–B12, LOW-11)', () => {
  const SNAP = '00000003-0000001B-1';
  const answer = (sql: string) => (sql === 'SELECT pg_catalog.pg_export_snapshot() AS snapshot_id' ? [{ snapshot_id: SNAP }] : undefined);
  const backupSteps = (events: string[], over: Partial<ProtectedSteps> = {}): Partial<ProtectedSteps> => ({
    ...stepsOf(events, { classify: async () => { events.push('classify'); return 'POST_BACKFILL'; } }),
    readState: async (_tx, sinks, keep) => {
      events.push(`readState:${keep}`);
      for (const s of sinks) s.write(P_BYTES);
      return { rows: null, serverVersionNum: '170004', markerId: UUID, schemaDigest: SCHEMA };
    },
    ...over,
  });
  it('AC-166 the exported snapshot id is the FIRST data statement and reaches the callback verbatim, with fPre computed in that snapshot', async () => {
    const hx = harness({ answer }); const events = hx.events; let seen: unknown = null;
    const value = await withBackupSnapshotTransaction(hx.prisma, async (c) => { events.push('callback'); seen = c; return 'dump-ok'; }, { steps: backupSteps(events) });
    expect(value).toBe('dump-ok');
    expect(seen).toEqual({ snapshotId: SNAP, fPre: F_PRE, serverVersionNum: '170004', markerId: UUID, protectedDomainContractSha256: protectedDomainContractSha256() });
    const sql = sqlOf(events);
    expect(sql.slice(0, 7)).toEqual([
      'SET TRANSACTION READ ONLY',
      'SET LOCAL search_path = pg_catalog, pg_temp',
      "SET LOCAL lock_timeout = '10s'",
      "SET LOCAL statement_timeout = '120s'",
      "SET LOCAL idle_in_transaction_session_timeout = '15min'",
      "SET LOCAL timezone = 'UTC'",
      'LOCK TABLE mona_local_test_guard.database_identity IN ACCESS SHARE MODE',
    ]);
    expect(sql.indexOf('SELECT pg_catalog.pg_export_snapshot() AS snapshot_id')).toBe(7 + LOCKED_TABLES);
    expect(events.indexOf('SQL:SELECT pg_catalog.pg_export_snapshot() AS snapshot_id')).toBeLessThan(events.indexOf('identity'));
    expect((hx.txOptions()[0] as { isolationLevel?: string }).isolationLevel).toBe('RepeatableRead');
  });
  it('AC-167 the exporter stays open through the callback; B11 (a second read-only transaction) runs only after the exporter COMMIT', async () => {
    const hx = harness({ answer }); const events = hx.events;
    await withBackupSnapshotTransaction(hx.prisma, async () => { events.push('callback:start'); await new Promise((r) => setTimeout(r, 2)); events.push('callback:end'); }, { steps: backupSteps(events) });
    const n = nonSql(events);
    expect(n.indexOf('callback:start')).toBeGreaterThan(n.indexOf('readState:false'));
    const firstCommit = n.indexOf('COMMIT');
    expect(firstCommit).toBeGreaterThan(n.indexOf('callback:end'));
    expect(n.indexOf('BEGIN', firstCommit)).toBeGreaterThan(firstCommit); // the stability transaction begins after the exporter committed
    expect(hx.calls()).toBe(2);
    expect(n.at(-1)).toBe('COMMIT');
  });
  it('B11 a schema digest that changed between the snapshot and the post-dump read refuses the backup (callback result discarded)', async () => {
    const hx = harness({ answer }); const events = hx.events; let reads = 0;
    const steps = backupSteps(events, { readState: async (_tx, sinks) => { reads += 1; for (const s of sinks) s.write(P_BYTES); return { rows: null, serverVersionNum: '170004', markerId: UUID, schemaDigest: reads === 1 ? 'a'.repeat(64) : 'b'.repeat(64) }; } });
    const error = await withBackupSnapshotTransaction(hx.prisma, async () => 'dump', { steps }).then(() => null, (e: unknown) => e as SnapshotFailure);
    expect(error).toBeInstanceOf(SnapshotFailure);
    expect(error?.stage).toBe('stability');
  });
  it('a state that is not POST_BACKFILL, a failing step, or a failing callback stops before/at the right stage and rolls the exporter back', async () => {
    const cases: [string, Partial<ProtectedSteps>, (() => Promise<unknown>) | null][] = [
      ['classify', { classify: async () => 'EXACT_BASELINE' }, null],
      ['identity', { proveIdentity: async () => { throw new Error(CANARY); } }, null],
      ['callback', {}, async () => { throw new Error(CANARY); }],
    ];
    for (const [stage, over, cb] of cases) {
      const hx = harness({ answer }); const events = hx.events; let called = false;
      const error = await withBackupSnapshotTransaction(hx.prisma, async (c) => { called = true; return cb ? cb() : c.fPre; }, { steps: backupSteps(events, over) }).then(() => null, (e: unknown) => e as SnapshotFailure);
      expect(error, stage).toBeInstanceOf(SnapshotFailure);
      expect(error?.stage).toBe(stage);
      expect(events).toContain('ROLLBACK');
      expect(called).toBe(stage === 'callback');
      expect(hx.calls()).toBe(1); // no stability transaction after a failed exporter
      expect(JSON.stringify([error?.message, error?.stack, Object.getOwnPropertyNames(error as object)])).not.toContain(CANARY);
    }
  });
  it('AC-169 (LOW-11) a malformed snapshot id is refused (it becomes an argv value), and a second overlapping backup in this process is refused before any transaction opens', async () => {
    for (const bad of ['', 'x', '--output=/etc/passwd', '00000003-0000001B-1; rm -rf', '00000003-0000001B']) {
      const hx = harness({ answer: (sql) => (sql.includes('pg_export_snapshot') ? [{ snapshot_id: bad }] : undefined) });
      const error = await withBackupSnapshotTransaction(hx.prisma, async () => 'x', { steps: backupSteps(hx.events) }).then(() => null, (e: unknown) => e as SnapshotFailure);
      expect(error?.stage, JSON.stringify(bad)).toBe('snapshot');
    }
    const hx1 = harness({ answer }); const hx2 = harness({ answer }); let release: () => void = () => undefined;
    const first = withBackupSnapshotTransaction(hx1.prisma, () => new Promise<string>((r) => { release = () => r('done'); }), { steps: backupSteps(hx1.events) });
    await new Promise((r) => setImmediate(r));
    const second = await withBackupSnapshotTransaction(hx2.prisma, async () => 'x', { steps: backupSteps(hx2.events) }).then(() => null, (e: unknown) => e as SnapshotFailure);
    expect(second?.stage).toBe('overlap');
    expect(hx2.calls()).toBe(0);
    release();
    expect(await first).toBe('done');
    // and the guard is released afterwards
    const hx3 = harness({ answer });
    await expect(withBackupSnapshotTransaction(hx3.prisma, async () => 'again', { steps: backupSteps(hx3.events) })).resolves.toBe('again');
  });
  it('the snapshot id is function-local: it is not in the returned value, the failure, or any later statement', async () => {
    const hx = harness({ answer }); const events = hx.events;
    const value = await withBackupSnapshotTransaction(hx.prisma, async () => ({ dump: 'ok' }), { steps: backupSteps(events) });
    expect(JSON.stringify(value)).not.toContain(SNAP);
    expect(sqlOf(events).filter((s) => s.includes(SNAP))).toEqual([]);
  });
});
