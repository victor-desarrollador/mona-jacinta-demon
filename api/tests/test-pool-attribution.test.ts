// D4A3B: DB-free unit tests for the pool/PID attribution mechanism.
//
// Nothing here opens a socket: pg.Pool is constructed lazily (never connected)
// and pool events are emitted synthetically with fake clients, exactly the way
// installed pg-pool 3.14.0 emits them (connect(client), acquire(client),
// release(err, client), remove(client), error(err, client)). The real
// @prisma/adapter-pg and the real PrismaClient are exercised against a
// recording Pool subclass that never connects (the prisma-sql-capture.test.ts
// pattern).
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ATTRIBUTION_DIAGNOSTICS_VAR,
  ATTRIBUTION_RUN_ID_VAR,
  ATTRIBUTION_SIDECAR_ROOT,
  PID_PROBE_SQL,
  attachPoolAttribution,
  attributedRunId,
  attributionDiagnosticsEnabled,
  createAttributedPool,
  eventsForClient,
  isOwnerProofEligible,
  readSidecarEvents,
  safeErrorCode,
  sanitizeRunIdForPath,
  sidecarFilePathFor,
} from './helpers/pool-attribution.js';
import {
  TEST_SESSION_DIAGNOSTICS_VAR,
  TEST_SESSION_DIAGNOSTIC_RUN_ID_VAR,
  localTestPoolConfig,
  testPoolConfig,
} from '../scripts/demo-database.js';
import { buildTestPrismaAdapter } from './helpers/test-db.js';
import { PrismaClient } from '../src/generated/prisma/client.js';

// --- shared fixtures ---------------------------------------------------------

const OWNER = { resourceClass: 'prisma', owner: 'tests/test-pool-attribution.test.ts' } as const;
const SEED_OWNER = { resourceClass: 'seed', owner: 'tests/seed.test.ts' } as const;
const NEVER_CONNECTED_URL = 'postgresql://mona:fake@127.0.0.1:1/mona';

const tempRoots: string[] = [];
function freshRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mona-d4a3b-'));
  tempRoots.push(root);
  return root;
}
afterEach(() => {
  while (tempRoots.length > 0) rmSync(tempRoots.pop()!, { recursive: true, force: true });
});

const envOn = (runId: string) => ({
  [ATTRIBUTION_DIAGNOSTICS_VAR]: '1',
  [ATTRIBUTION_RUN_ID_VAR]: runId,
});

function testPool(max = 2): pg.Pool {
  return new pg.Pool({ connectionString: NEVER_CONNECTED_URL, max });
}

type ProbeSpec = { pid?: number; error?: { code?: string; message?: string }; deferred?: boolean };
function fakeClient(spec: ProbeSpec = {}) {
  const calls: string[] = [];
  let resolveProbe!: (result: { rows: { pid: number }[] }) => void;
  const query = (sql: string) => {
    calls.push(sql);
    if (spec.deferred) {
      return new Promise<{ rows: { pid: number }[] }>((resolve) => { resolveProbe = resolve; });
    }
    if (spec.error) {
      return Promise.reject(Object.assign(new Error(spec.error.message ?? 'boom'), spec.error.code ? { code: spec.error.code } : {}));
    }
    return Promise.resolve({ rows: [{ pid: spec.pid ?? 0 }] });
  };
  return {
    client: { query } as unknown as pg.PoolClient,
    calls,
    completeProbe: (pid: number) => resolveProbe({ rows: [{ pid }] }),
  };
}

function sidecarOf(root: string, runId: string, processId: number) {
  return readSidecarEvents(sidecarFilePathFor(root, runId, processId));
}

function writtenLines(root: string, runId: string, processId: number): string[] {
  return readFileSync(sidecarFilePathFor(root, runId, processId), 'utf8').trim().split('\n');
}

// --- gating, config and transport (A01–A05, A31–A33) --------------------------

describe('pool attribution gating and configuration', () => {
  it('A01 is disabled when the diagnostic env is absent: no attach, no sidecar', () => {
    const root = freshRoot();
    const pool = testPool();
    expect(attributionDiagnosticsEnabled({})).toBe(false);
    expect(attachPoolAttribution(pool, OWNER, { source: {}, root, processId: 1 })).toBeNull();
    expect(createAttributedPool({ connectionString: NEVER_CONNECTED_URL, max: 5 }, OWNER, { source: {}, root, processId: 1 })).toBeNull();
    expect(attachPoolAttribution(pool, OWNER, { source: { [ATTRIBUTION_DIAGNOSTICS_VAR]: '0' }, root, processId: 1 })).toBeNull();
    expect(pool.listenerCount('connect')).toBe(0);
    expect(pool.listenerCount('acquire')).toBe(0);
  });

  it('A03 is enabled only for exactly "1" and then attaches', () => {
    expect(attributionDiagnosticsEnabled({ [ATTRIBUTION_DIAGNOSTICS_VAR]: '1' })).toBe(true);
    expect(attributionDiagnosticsEnabled({ [ATTRIBUTION_DIAGNOSTICS_VAR]: ' 1' })).toBe(false);
    expect(attributionDiagnosticsEnabled({ [ATTRIBUTION_DIAGNOSTICS_VAR]: 'true' })).toBe(false);
    const root = freshRoot();
    const pool = testPool();
    const handle = attachPoolAttribution(pool, OWNER, { source: envOn('d4a3b-on'), root, processId: 21 });
    expect(handle).not.toBeNull();
    expect(handle!.poolInstance).toBeGreaterThan(0);
    expect(pool.listenerCount('connect')).toBe(1);
    expect(pool.listenerCount('acquire')).toBe(1);
    expect(sidecarOf(root, 'd4a3b-on', 21).map((e) => e.event)).toContain('pool-open');
  });

  it('A31/M11 the config transport carries no application_name, on or off', () => {
    const config = testPoolConfig('postgresql://u:p@127.0.0.1:1/d', 5);
    expect(Object.keys(config).sort()).toEqual([
      'connectionString',
      'connectionTimeoutMillis',
      'idleTimeoutMillis',
      'max',
      'ssl',
    ]);
    expect(config.max).toBe(5);
    expect(config.idleTimeoutMillis).toBe(0);
    // D5D: hosted TEST connection budget is 30s (pooler cold-connect hardening;
    // D5B2 phase=connect elapsedMs=10004). LOCAL_TEST stays 10s (loopback).
    expect(config.connectionTimeoutMillis).toBe(30000);
    expect((config as { application_name?: string }).application_name).toBeUndefined();

    const local = localTestPoolConfig('postgresql://mona_local_test:x@127.0.0.1:5432/mona_local_test', 3);
    expect(local.ssl).toBe(false);
    expect(local.connectionTimeoutMillis).toBe(10000);
    expect((local as { application_name?: string }).application_name).toBeUndefined();
  });

  it('A33 the pre-D4A1 config shape is preserved byte-for-key', () => {
    const config = testPoolConfig('postgresql://u:p@127.0.0.1:1/d', 2) as Record<string, unknown>;
    expect(Object.keys(config)).toHaveLength(5);
    expect(Object.keys((config.ssl as Record<string, unknown>)).sort()).toEqual(['ca', 'rejectUnauthorized']);
    expect((config.ssl as { rejectUnauthorized: boolean }).rejectUnauthorized).toBe(true);
  });

  it('mirrors the demo-database diagnostic env names exactly (drift-proof constants)', () => {
    expect(ATTRIBUTION_DIAGNOSTICS_VAR).toBe(TEST_SESSION_DIAGNOSTICS_VAR);
    expect(ATTRIBUTION_RUN_ID_VAR).toBe(TEST_SESSION_DIAGNOSTIC_RUN_ID_VAR);
    expect(ATTRIBUTION_SIDECAR_ROOT).toBe('/tmp/mona-d4a3');
  });

  it('A05 UNKNOWN owner is recorded but never counts as owner proof', () => {
    expect(isOwnerProofEligible('UNKNOWN')).toBe(false);
    expect(isOwnerProofEligible('')).toBe(false);
    expect(isOwnerProofEligible('tests/auth/me.test.ts')).toBe(true);
    const root = freshRoot();
    const pool = testPool();
    attachPoolAttribution(pool, { resourceClass: 'seed', owner: 'UNKNOWN' }, { source: envOn('d4a3b-unknown'), root, processId: 31 });
    const events = sidecarOf(root, 'd4a3b-unknown', 31);
    expect(events[0]!.ownerFile).toBe('UNKNOWN');
    expect(events[0]!.resourceClass).toBe('seed');
  });
});

// --- run id sanitization and sidecar paths (A04, A25–A27) --------------------

describe('run id sanitization and sidecar paths', () => {
  it('A04 sanitizes unsafe run ids into a flat path segment', () => {
    const cases: Array<[string | undefined, RegExp]> = [
      ['../../etc/passwd', /^etc-passwd$/],
      ['run/x; drop?', /^run-x-drop$/],
      ['', /unspecified/],
      [undefined, /unspecified/],
      ['área ñoña', /^area-nona$/],
      ['d4a-003', /^d4a-003$/],
    ];
    for (const [input, expected] of cases) {
      const sanitized = sanitizeRunIdForPath(input);
      expect(sanitized).toMatch(expected);
      expect(sanitized).not.toMatch(/[/.]/);
      expect(sanitized.length).toBeLessThanOrEqual(64);
    }
    expect(attributedRunId({})).toMatch(/unspecified/);
    expect(attributedRunId(envOn('d4a-003'))).toBe('d4a-003');
  });

  it('A04 keeps every run directory inside the sidecar root (no traversal)', () => {
    const hostile = sanitizeRunIdForPath('../../../tmp/mona-d4a3');
    const file = sidecarFilePathFor(ATTRIBUTION_SIDECAR_ROOT, hostile, 123);
    const dir = path.dirname(file);
    expect(path.resolve(dir)).toBe(path.resolve(path.join(ATTRIBUTION_SIDECAR_ROOT, hostile)));
  });

  it('A27 separates processes by pid in the file name', () => {
    expect(sidecarFilePathFor('/r', 'd4a-003', 111)).not.toBe(sidecarFilePathFor('/r', 'd4a-003', 222));
  });
});

// --- writer lifecycle (A07, A25, A26, A28, L02/L06/L07) ----------------------

describe('sidecar writer lifecycle', () => {
  it('A26/A07 two pools in one process/run share one writer file', () => {
    const root = freshRoot();
    const poolA = testPool();
    const poolB = testPool();
    const handleA = attachPoolAttribution(poolA, OWNER, { source: envOn('d4a3b-two'), root, processId: 41 });
    const handleB = attachPoolAttribution(poolB, OWNER, { source: envOn('d4a3b-two'), root, processId: 41 });
    expect(handleA!.writerPath).toBe(handleB!.writerPath);
    expect(handleA!.poolInstance).not.toBe(handleB!.poolInstance);
    const events = sidecarOf(root, 'd4a3b-two', 41);
    expect(events.filter((e) => e.event === 'pool-open')).toHaveLength(2);
    expect(new Set(events.map((e) => e.poolInstance)).size).toBe(2);
  });

  it('A25 refuses to append to an unexpected pre-existing per-process file', () => {
    const root = freshRoot();
    const file = sidecarFilePathFor(root, 'd4a3b-stale', 51);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '{"v":1,"stale":true}\n');
    const pool = testPool();
    expect(() => attachPoolAttribution(pool, OWNER, { source: envOn('d4a3b-stale'), root, processId: 51 })).toThrow(/stale|already exists/i);
    expect(readFileSync(file, 'utf8')).toBe('{"v":1,"stale":true}\n');
  });

  it('A25 a different process file is unaffected by the stale one', () => {
    const root = freshRoot();
    const staleFile = sidecarFilePathFor(root, 'd4a3b-stale', 52);
    mkdirSync(path.dirname(staleFile), { recursive: true });
    writeFileSync(staleFile, 'stale\n');
    const pool = testPool();
    expect(() => attachPoolAttribution(pool, OWNER, { source: envOn('d4a3b-stale'), root, processId: 53 })).not.toThrow();
    expect(sidecarOf(root, 'd4a3b-stale', 53).map((e) => e.event)).toContain('pool-open');
  });

  it('L06 creates the run directory 0700 and the file 0600', () => {
    const root = freshRoot();
    attachPoolAttribution(testPool(), OWNER, { source: envOn('d4a3b-modes'), root, processId: 61 });
    const dir = path.dirname(sidecarFilePathFor(root, 'd4a3b-modes', 61));
    expect((statSync(dir).mode & 0o777).toString(8)).toBe('700');
    expect((statSync(sidecarFilePathFor(root, 'd4a3b-modes', 61)).mode & 0o777).toString(8)).toBe('600');
  });

  it('A28 bounds the file and marks it full exactly once', () => {
    const root = freshRoot();
    const pool = testPool();
    attachPoolAttribution(pool, OWNER, { source: envOn('d4a3b-cap'), root, processId: 71, lineCap: 3 });
    const a = fakeClient({ pid: 1 });
    const b = fakeClient({ pid: 2 });
    pool.emit('connect', a.client);
    pool.emit('connect', b.client);
    const c = fakeClient({ pid: 3 });
    pool.emit('connect', c.client); // 4th write attempt: only the sidecar-full marker is added
    const d = fakeClient({ pid: 4 });
    pool.emit('connect', d.client); // dropped
    const lines = writtenLines(root, 'd4a3b-cap', 71);
    expect(lines).toHaveLength(4); // pool-open + client-connect + client-pid, then the cap marker
    const events = lines.map((line) => JSON.parse(line) as { event: string });
    expect(events.filter((e) => e.event === 'sidecar-full')).toHaveLength(1);
  });

  it('L02/A24 malformed lines fail visibly with file and line number', () => {
    const root = freshRoot();
    attachPoolAttribution(testPool(), OWNER, { source: envOn('d4a3b-bad'), root, processId: 81 });
    const file = sidecarFilePathFor(root, 'd4a3b-bad', 81);
    appendFileSync(file, 'not json at all\n');
    expect(() => readSidecarEvents(file)).toThrow(/d4a3b-bad.*\.ndjson:2|:2/);
  });

  it('A30 rejects any event field outside the strict allowlist', () => {
    const root = freshRoot();
    const pool = testPool();
    const handle = attachPoolAttribution(pool, OWNER, { source: envOn('d4a3b-allow'), root, processId: 91 });
    expect(() =>
      handle!.writeTestOnly({ v: 1, runId: 'd4a3b-allow', ts: new Date().toISOString(), event: 'pool-open', resourceClass: 'prisma', ownerFile: 'x', poolInstance: 1, clientSeq: null, sql: 'SELECT secret' } as never),
    ).toThrow(/field|allowlist|sql/i);
  });
});

// --- pool/client events (A06, A08–A19, A34, A35) ------------------------------

describe('pool and client attribution events', () => {
  it('A06/A08 assigns distinct poolInstance per pool and is idempotent per pool', () => {
    const root = freshRoot();
    const poolA = testPool();
    const poolB = testPool();
    const a1 = attachPoolAttribution(poolA, OWNER, { source: envOn('d4a3b-inst'), root, processId: 101 });
    const a2 = attachPoolAttribution(poolA, OWNER, { source: envOn('d4a3b-inst'), root, processId: 101 });
    const b1 = attachPoolAttribution(poolB, OWNER, { source: envOn('d4a3b-inst'), root, processId: 101 });
    expect(a2!.poolInstance).toBe(a1!.poolInstance);
    expect(b1!.poolInstance).not.toBe(a1!.poolInstance);
    expect(poolA.listenerCount('connect')).toBe(1);
    expect(poolA.listenerCount('acquire')).toBe(1);
    expect(poolA.listenerCount('release')).toBe(1);
    expect(poolA.listenerCount('remove')).toBe(1);
    expect(poolA.listenerCount('error')).toBe(1);
  });

  it('A09/A34 probes the PID synchronously at connect, first in the FIFO order', () => {
    const root = freshRoot();
    const pool = testPool();
    attachPoolAttribution(pool, OWNER, { source: envOn('d4a3b-probe'), root, processId: 111 });
    const fake = fakeClient({ pid: 11111 });
    pool.emit('connect', fake.client);
    expect(fake.calls).toEqual([PID_PROBE_SQL]); // submitted DURING the emit, before any caller query
  });

  it('A10 links the resolved pid to the exact clientSeq', async () => {
    const root = freshRoot();
    const pool = testPool();
    attachPoolAttribution(pool, OWNER, { source: envOn('d4a3b-pid'), root, processId: 121 });
    const fake = fakeClient({ pid: 22222 });
    pool.emit('connect', fake.client);
    await new Promise((resolve) => setImmediate(resolve));
    const events = sidecarOf(root, 'd4a3b-pid', 121);
    const connect = events.find((e) => e.event === 'client-connect')!;
    const pid = events.find((e) => e.event === 'client-pid')!;
    expect(connect.clientSeq).toBeGreaterThan(0);
    expect(pid.clientSeq).toBe(connect.clientSeq);
    expect(pid.pid).toBe(22222);
  });

  it('A12 keeps acquire-before-PID-resolution correlatable and never invents a pid', async () => {
    const root = freshRoot();
    const pool = testPool();
    attachPoolAttribution(pool, OWNER, { source: envOn('d4a3b-pending'), root, processId: 131 });
    const fake = fakeClient({ deferred: true });
    pool.emit('connect', fake.client);
    pool.emit('acquire', fake.client);
    let events = sidecarOf(root, 'd4a3b-pending', 131);
    const acquire = events.find((e) => e.event === 'client-acquire')!;
    const connectSeq = events.find((e) => e.event === 'client-connect')!.clientSeq;
    expect(acquire.clientSeq).toBe(connectSeq);
    expect(acquire.pid).toBeUndefined();
    fake.completeProbe(33333);
    await new Promise((resolve) => setImmediate(resolve));
    events = sidecarOf(root, 'd4a3b-pending', 131);
    const pid = events.find((e) => e.event === 'client-pid')!;
    expect(pid.clientSeq).toBe(connectSeq);
    expect(pid.pid).toBe(33333);
  });

  it('A11 records a pid failure without inventing a pid or leaking the message', async () => {
    const root = freshRoot();
    const pool = testPool();
    attachPoolAttribution(pool, OWNER, { source: envOn('d4a3b-piderr'), root, processId: 141 });
    const fake = fakeClient({ error: { code: 'ECONNRESET', message: 'postgres://secret-user:secret-pass@db.host:5432/postgres' } });
    pool.emit('connect', fake.client);
    pool.emit('acquire', fake.client);
    await new Promise((resolve) => setImmediate(resolve));
    const events = sidecarOf(root, 'd4a3b-piderr', 141);
    const failure = events.find((e) => e.event === 'client-pid-error')!;
    const connectSeq = events.find((e) => e.event === 'client-connect')!.clientSeq;
    expect(failure.clientSeq).toBe(connectSeq);
    expect(failure.code).toBe('ECONNRESET');
    expect(failure.pid).toBeUndefined();
    const raw = readFileSync(sidecarFilePathFor(root, 'd4a3b-piderr', 141), 'utf8');
    expect(raw).not.toContain('postgres://');
    expect(raw).not.toContain('secret-pass');
  });

  it('A13/A35 records release with the installed pg-pool signature (err, client)', async () => {
    const root = freshRoot();
    const pool = testPool();
    attachPoolAttribution(pool, OWNER, { source: envOn('d4a3b-rel'), root, processId: 151 });
    const fake = fakeClient({ pid: 44444 });
    pool.emit('connect', fake.client);
    await new Promise((resolve) => setImmediate(resolve)); // the probe resolves first; pid is then known on later events
    pool.emit('acquire', fake.client);
    pool.emit('release', null, fake.client);
    pool.emit('release', Object.assign(new Error('x'), { code: 'ECONNREFUSED' }), fake.client);
    const events = sidecarOf(root, 'd4a3b-rel', 151);
    const releases = events.filter((e) => e.event === 'client-release');
    const connectSeq = events.find((e) => e.event === 'client-connect')!.clientSeq;
    expect(releases).toHaveLength(2);
    expect(releases.every((e) => e.clientSeq === connectSeq && e.pid === 44444)).toBe(true);
  });

  it('A14 records removal and hands the next client a fresh clientSeq', async () => {
    const root = freshRoot();
    const pool = testPool();
    attachPoolAttribution(pool, OWNER, { source: envOn('d4a3b-rem'), root, processId: 161 });
    const first = fakeClient({ pid: 5 });
    pool.emit('connect', first.client);
    pool.emit('remove', first.client);
    const second = fakeClient({ pid: 6 });
    pool.emit('connect', second.client);
    await new Promise((resolve) => setImmediate(resolve));
    const events = sidecarOf(root, 'd4a3b-rem', 161);
    const connectSeqs = events.filter((e) => e.event === 'client-connect').map((e) => e.clientSeq);
    expect(events.find((e) => e.event === 'client-remove')!.clientSeq).toBe(connectSeqs[0]);
    const secondConnect = events.filter((e) => e.event === 'client-connect').at(-1)!;
    expect(secondConnect.clientSeq).toBeGreaterThan(connectSeqs[0]!); // fresh identity, never reused
  });

  it('A15/A29 serializes pool errors as a safe code only', () => {
    const root = freshRoot();
    const pool = testPool();
    attachPoolAttribution(pool, OWNER, { source: envOn('d4a3b-err'), root, processId: 171 });
    const error = Object.assign(new Error('postgres://secret-user:secret-pass@db.host:5432/postgres died'), { code: 'ETIMEDOUT' });
    pool.emit('error', error, fakeClient().client);
    const events = sidecarOf(root, 'd4a3b-err', 171);
    const poolError = events.find((e) => e.event === 'pool-error')!;
    expect(poolError.code).toBe('ETIMEDOUT');
    const raw = readFileSync(sidecarFilePathFor(root, 'd4a3b-err', 171), 'utf8');
    expect(raw).not.toContain('postgres://');
    expect(raw).not.toContain('secret-pass');
    expect(raw).not.toContain('died');
    expect(safeErrorCode(Object.assign(new Error('x'), { code: 'LOWER_case' }))).toBeUndefined();
    expect(safeErrorCode(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe('ECONNRESET');
  });

  it('A19 keeps independent mappings for concurrent clients of one pool', async () => {
    const root = freshRoot();
    const pool = testPool(5);
    attachPoolAttribution(pool, OWNER, { source: envOn('d4a3b-multi'), root, processId: 181 });
    const c1 = fakeClient({ pid: 700 });
    const c2 = fakeClient({ pid: 701 });
    pool.emit('connect', c1.client);
    pool.emit('connect', c2.client);
    pool.emit('acquire', c1.client);
    pool.emit('acquire', c2.client);
    pool.emit('release', null, c1.client);
    await new Promise((resolve) => setImmediate(resolve));
    const events = sidecarOf(root, 'd4a3b-multi', 181);
    const connectSeqs = events.filter((e) => e.event === 'client-connect').map((e) => e.clientSeq);
    const [seqA, seqB] = [connectSeqs[0]!, connectSeqs[1]!];
    expect(seqA).not.toBe(seqB);
    const pids = new Map(events.filter((e) => e.event === 'client-pid').map((e) => [e.clientSeq, e.pid]));
    expect(pids.get(seqA)).toBe(700);
    expect(pids.get(seqB)).toBe(701);
    const acquire1 = events.find((e) => e.event === 'client-acquire' && e.clientSeq === seqA)!;
    const acquire2 = events.find((e) => e.event === 'client-acquire' && e.clientSeq === seqB)!;
    expect(acquire1.pid).toBeUndefined(); // probes are async: pids arrive via client-pid, correlated by clientSeq
    expect(acquire2.pid).toBeUndefined();
  });

  it('A18/A22 attributes only post-attach usage and lazily probes a pre-existing client at its first attributed acquire', async () => {
    const root = freshRoot();
    const pool = testPool(1); // the max=1 seed-pool model
    // The marker-proof lifecycle happens BEFORE attribution exists:
    const proofClient = fakeClient({ pid: 900 });
    pool.emit('connect', proofClient.client);
    pool.emit('acquire', proofClient.client);
    pool.emit('release', null, proofClient.client);
    expect(existsRootRun(root)).toBe(false);
    // Attribution attaches only now (the openProvenTestDatabase seam):
    attachPoolAttribution(pool, SEED_OWNER, { source: envOn('d4a3b-seed'), root, processId: 191 });
    // The retained client's first attributed acquire (a seed transaction):
    pool.emit('acquire', proofClient.client);
    expect(proofClient.calls.filter((sql) => sql === PID_PROBE_SQL)).toHaveLength(1);
    await new Promise((resolve) => setImmediate(resolve));
    const events = sidecarOf(root, 'd4a3b-seed', 191);
    expect(events.filter((e) => e.event === 'client-connect')).toHaveLength(0); // the proof is not reported
    expect(events.find((e) => e.event === 'pool-open')!.resourceClass).toBe('seed');
    const acquire = events.find((e) => e.event === 'client-acquire')!;
    expect(acquire.resourceClass).toBe('seed');
    expect(events.find((e) => e.event === 'client-pid')!.pid).toBe(900);
  });

  it('A23 never correlates by pid alone: recycled pids stay distinct by client identity', async () => {
    const root = freshRoot();
    const pool = testPool();
    attachPoolAttribution(pool, OWNER, { source: envOn('d4a3b-recycle'), root, processId: 201 });
    const first = fakeClient({ pid: 777 });
    pool.emit('connect', first.client);
    pool.emit('remove', first.client);
    const recycled = fakeClient({ pid: 777 }); // PostgreSQL reuses the backend pid later
    pool.emit('connect', recycled.client);
    await new Promise((resolve) => setImmediate(resolve));
    const events = sidecarOf(root, 'd4a3b-recycle', 201);
    const connectSeqs = events.filter((e) => e.event === 'client-connect').map((e) => e.clientSeq);
    const [firstSeq, secondSeq] = [connectSeqs[0]!, connectSeqs[1]!];
    const firstLife = eventsForClient(events, events[0]!.poolInstance, firstSeq);
    const secondLife = eventsForClient(events, events[0]!.poolInstance, secondSeq);
    expect(firstLife).not.toEqual(secondLife);
    expect(firstLife.map((e) => e.event)).toContain('client-remove');
    expect(secondLife.map((e) => e.event)).not.toContain('client-remove');
  });
});

// --- prisma adapter path (A16, A17, M12) --------------------------------------

describe('buildTestPrismaAdapter external-pool lifecycle', () => {
  it('diagnostics off: the adapter owns its pool exactly as before', async () => {
    const factory = buildTestPrismaAdapter({ connectionString: NEVER_CONNECTED_URL, max: 5 }, null);
    const external = (factory as unknown as { externalPool: unknown }).externalPool;
    expect(external).toBeNull();
    const adapter = await factory.connect();
    expect(adapter).toBeDefined();
  });

  it('A16/M12 diagnostics on: $disconnect ends the attributed external pool exactly once; A17 repeated $disconnect is safe', async () => {
    const root = freshRoot();
    class RecordingPool extends pg.Pool {
      readonly scriptedClient = fakeClient({ pid: 606 });
      override async connect() {
        return this.scriptedClient.client;
      }
    }
    const pool = new RecordingPool();
    const endSpy = vi.spyOn(pool, 'end');
    expect(attachPoolAttribution(pool, OWNER, { source: envOn('d4a3b-disconnect'), root, processId: 211 })).not.toBeNull();
    const factory = buildTestPrismaAdapter({ connectionString: NEVER_CONNECTED_URL, max: 5 }, pool);
    expect((factory as unknown as { externalPool: unknown }).externalPool).toBe(pool);
    expect((factory as unknown as { options?: { disposeExternalPool?: boolean } }).options?.disposeExternalPool).toBe(true);
    const prisma = new PrismaClient({ adapter: factory, log: [] });
    // A bounded transaction forces the engine to connect the adapter (the
    // recording pool serves transactions exactly like prisma-sql-capture's).
    await prisma.$transaction(async (tx) => tx.user.count(), { maxWait: 200, timeout: 1000 }).catch(() => undefined);
    await prisma.$disconnect();
    expect(endSpy).toHaveBeenCalledTimes(1);
    await expect(prisma.$disconnect()).resolves.toBeUndefined();
    expect(endSpy).toHaveBeenCalledTimes(1);
  });

  it('A19/M02 the attributed pool preserves the configured max', () => {
    const root = freshRoot();
    const config = testPoolConfig(NEVER_CONNECTED_URL, 5);
    const pool = createAttributedPool(config, OWNER, { source: envOn('d4a3b-max'), root, processId: 221 });
    expect(pool).not.toBeNull();
    expect(pool!.options.max).toBe(5);
    expect(pool!.options.idleTimeoutMillis).toBe(0);
    expect(pool!.options.connectionTimeoutMillis).toBe(30000);
    expect(sidecarOf(root, 'd4a3b-max', 221).map((e) => e.event)).toContain('pool-open');
  });
});

// --- seam placement guarantees (A20–A22, A32, M03) ----------------------------

describe('proof/seed seam placement (static source contract)', () => {
  const demoSource = readFileSync(new URL('../scripts/demo-database.ts', import.meta.url), 'utf8');
  const helperSource = readFileSync(new URL('./helpers/test-db.ts', import.meta.url), 'utf8');

  const bodyOf = (source: string, marker: string, endMarkers: string[]): string => {
    const start = source.indexOf(marker);
    expect(start, `marker ${marker} not found`).toBeGreaterThan(-1);
    let end = source.length;
    for (const endMarker of endMarkers) {
      const at = source.indexOf(endMarker, start + marker.length);
      if (at !== -1) end = Math.min(end, at);
    }
    return source.slice(start, end);
  };

  it('A20/M03 proof pools are never attributed (openProvenTestPool contains no attach)', () => {
    const proofPoolBody = bodyOf(demoSource, 'export async function openProvenTestPool', ['\nexport ', '\nasync function ']);
    expect(proofPoolBody).not.toContain('attachPoolAttribution');
  });

  it('A21 the createTestPrismaClient proof path is not attributed', () => {
    const proveBody = bodyOf(helperSource, 'async function proveTestDatabase', ['\nexport ', '\nasync function ']);
    expect(proveBody).not.toContain('attachPoolAttribution');
  });

  it('A22 openProvenTestDatabase attaches after the proof pool is returned and before Prisma uses it', () => {
    const seedBody = bodyOf(demoSource, 'async function openProvenTestDatabase', ['\nexport ', '\nasync function ', '\n// ']);
    const attachAt = seedBody.indexOf('attachPoolAttribution(');
    const poolAt = seedBody.indexOf('openProvenTestPool(1');
    const prismaAt = seedBody.indexOf('new PrismaClient');
    expect(poolAt).toBeGreaterThan(-1);
    expect(attachAt).toBeGreaterThan(poolAt);
    expect(prismaAt).toBeGreaterThan(attachAt);
    expect(seedBody).toContain('openProvenTestPool(1'); // seed pool max stays 1
  });

  it('A32 LOCAL_TEST lifecycles stay unattributed', () => {
    for (const name of ['function openProvenLocalTestPool', 'async function openProvenLocalTestDatabase', 'async function openProvenLocalTestLifecycle']) {
      const body = bodyOf(demoSource, name, ['\nexport ', '\nasync function ', '\nfunction ']);
      expect(body, name).not.toContain('attachPoolAttribution');
    }
  });

  it('M11 no application_name transport remains in the helper sources', () => {
    expect(demoSource).not.toContain('buildTestSessionApplicationName');
    expect(demoSource).not.toContain('{ application_name: ');
    expect(demoSource).not.toMatch(/['"`]application_name['"`]\s*:/);
    expect(helperSource).not.toContain('application_name');
  });

  it('createTestPrismaClient composes the attributed pool through the tested adapter builder', () => {
    const body = bodyOf(helperSource, 'export async function createTestPrismaClient', ['\nexport ']);
    expect(body).toContain('createAttributedPool(');
    expect(body).toContain('buildTestPrismaAdapter(');
  });
});

function existsRootRun(root: string): boolean {
  // The sidecar run directory must not exist before the first attributed event.
  try {
    statSync(path.join(root, sanitizeRunIdForPath('d4a3b-seed')));
    return true;
  } catch {
    return false;
  }
}
