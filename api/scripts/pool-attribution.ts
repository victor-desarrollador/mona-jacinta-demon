// D4A3B — pool/PID attribution (test-only diagnostics infrastructure).
//
// Proven in D4A2: the startup application_name attribution channel was NOT
// observable in hosted TEST through the current connection path (1053 observer
// polls, zero matches, worker env verified). This module replaces that
// transport: it owns nothing about databases, never chooses a target, never
// proves markers, never writes application tables and never touches
// transaction boundaries. Given a pg Pool that a TEST HELPER owns, it:
//
//   - assigns a process-global poolInstance and per-client clientSeq;
//   - probes each physical client's exact PostgreSQL backend PID with a
//     read-only `SELECT pg_backend_pid()` — submitted synchronously inside the
//     pg-pool 'connect'/'acquire' event handler, so per-connection FIFO order
//     (pg 8.23.0, no pipelining by default) places it BEFORE the acquiring
//     caller's first query on that connection;
//   - writes a strict-allowlist NDJSON event line per lifecycle event to a
//     per-process sidecar file under /tmp/mona-d4a3/<runId>/.
//
// An observer later correlates sidecar (ownerFile, resourceClass, poolInstance,
// clientSeq, pid, timeline) with server-side pg_stat_activity
// pid/xact_start/pg_blocking_pids — never by PID alone. Diagnostics are
// default-off: when MONA_TEST_SESSION_DIAGNOSTICS != '1' every entry point is
// an inert no-op and callers keep the exact pre-D4A1 behavior.
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Pool, type PoolClient, type PoolConfig } from 'pg';

export type AttributionResourceClass = 'prisma' | 'seed';

export type AttributionOwner = {
  resourceClass: AttributionResourceClass;
  owner: string;
};

export type AttributionEventName =
  | 'pool-open'
  | 'client-connect'
  | 'client-pid'
  | 'client-pid-error'
  | 'client-acquire'
  | 'client-release'
  | 'client-remove'
  | 'pool-error'
  | 'sidecar-full';

export type AttributionSidecarEvent = {
  v: 1;
  runId: string;
  ts: string;
  event: AttributionEventName;
  resourceClass: AttributionResourceClass;
  ownerFile: string;
  poolInstance: number;
  clientSeq: number | null;
  pid?: number;
  code?: string;
};

export type AttributionAttachOptions = {
  source?: NodeJS.ProcessEnv;
  root?: string;
  processId?: number;
  lineCap?: number;
  now?: () => Date;
};

export type AttributionHandle = {
  poolInstance: number;
  writerPath: string;
  writeTestOnly: (event: AttributionSidecarEvent) => void;
};

// Mirrors the demo-database.ts exported names; a unit test asserts equality so
// the literals cannot drift apart.
export const ATTRIBUTION_DIAGNOSTICS_VAR = 'MONA_TEST_SESSION_DIAGNOSTICS';
export const ATTRIBUTION_RUN_ID_VAR = 'MONA_TEST_SESSION_DIAGNOSTIC_RUN_ID';
export const ATTRIBUTION_SIDECAR_ROOT = '/tmp/mona-d4a3';
export const PID_PROBE_SQL = 'SELECT pg_backend_pid() AS pid';

const DEFAULT_LINE_CAP = 100_000;
const SAFE_CODE = /^[A-Z0-9_]{1,40}$/;
const ALLOWED_FIELDS = new Set([
  'v',
  'runId',
  'ts',
  'event',
  'resourceClass',
  'ownerFile',
  'poolInstance',
  'clientSeq',
  'pid',
  'code',
]);
const ALLOWED_EVENTS = new Set<AttributionEventName>([
  'pool-open',
  'client-connect',
  'client-pid',
  'client-pid-error',
  'client-acquire',
  'client-release',
  'client-remove',
  'pool-error',
  'sidecar-full',
]);

// Process-global storage: Vitest re-evaluates modules per test file inside one
// worker process, so a module-level cache would forget the already-open writer
// and trip its own create-new fail-closed guard. globalThis survives module
// re-evaluation; a different process has a different pid and therefore a
// different file.
type GlobalStore = Record<string, unknown>;
const globalStore = globalThis as unknown as GlobalStore;
const WRITERS_KEY = 'monaD4a3bSidecarWriters';
const COUNTERS_KEY = 'monaD4a3bAttributionCounters';

type SidecarWriter = {
  filePath: string;
  lines: number;
  full: boolean;
  created: boolean;
};

function writerRegistry(): Map<string, SidecarWriter> {
  const existing = globalStore[WRITERS_KEY];
  if (existing instanceof Map) return existing as Map<string, SidecarWriter>;
  const created = new Map<string, SidecarWriter>();
  globalStore[WRITERS_KEY] = created;
  return created;
}

type GlobalCounters = { pool: number; client: number };

function counters(): GlobalCounters {
  const existing = globalStore[COUNTERS_KEY] as GlobalCounters | undefined;
  if (existing && typeof existing === 'object') return existing;
  const created: GlobalCounters = { pool: 1, client: 1 };
  globalStore[COUNTERS_KEY] = created;
  return created;
}

export function attributionDiagnosticsEnabled(
  source: NodeJS.ProcessEnv = process.env,
): boolean {
  return source[ATTRIBUTION_DIAGNOSTICS_VAR] === '1';
}

// A flat [A-Za-z0-9-] token: no dots, no slashes, no traversal, no secrets.
export function sanitizeRunIdForPath(value: string | undefined): string {
  const cleaned = (value ?? '')
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/[^A-Za-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return cleaned || 'unspecified';
}

export function attributedRunId(source: NodeJS.ProcessEnv = process.env): string {
  return sanitizeRunIdForPath(source[ATTRIBUTION_RUN_ID_VAR]);
}

export function sidecarFilePathFor(
  root: string,
  runId: string | undefined,
  processId: number,
): string {
  const sanitized = sanitizeRunIdForPath(runId);
  return `${root}/${sanitized}/${sanitized}-${processId}.ndjson`;
}

// Only ever a validated safe error code — never a message, stack or cause.
export function safeErrorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && SAFE_CODE.test(code) ? code : undefined;
}

// UNKNOWN (or empty) may appear in diagnostics but never counts as owner proof.
export function isOwnerProofEligible(ownerFile: string): boolean {
  return ownerFile.trim() !== '' && ownerFile !== 'UNKNOWN';
}

// Readers must correlate by (runId, process file, poolInstance, clientSeq,
// timeline) — never by PID alone (PostgreSQL recycles backend pids).
export function eventsForClient<
  T extends { poolInstance: number; clientSeq: number | null },
>(events: T[], poolInstance: number, clientSeq: number): T[] {
  return events.filter(
    (event) => event.poolInstance === poolInstance && event.clientSeq === clientSeq,
  );
}

function validateEvent(event: AttributionSidecarEvent): void {
  for (const key of Object.keys(event)) {
    if (!ALLOWED_FIELDS.has(key)) {
      throw new Error(`D4A3B sidecar: field "${key}" is outside the strict event allowlist`);
    }
  }
  if (event.v !== 1) throw new Error('D4A3B sidecar: event.v must be 1');
  if (typeof event.runId !== 'string' || event.runId === '') throw new Error('D4A3B sidecar: runId must be a non-empty string');
  if (typeof event.ts !== 'string' || event.ts === '') throw new Error('D4A3B sidecar: ts must be a non-empty ISO string');
  if (!ALLOWED_EVENTS.has(event.event)) throw new Error(`D4A3B sidecar: unknown event "${String(event.event)}"`);
  if (event.resourceClass !== 'prisma' && event.resourceClass !== 'seed') {
    throw new Error(`D4A3B sidecar: resourceClass "${String(event.resourceClass)}" is not an owner-proof class`);
  }
  if (typeof event.ownerFile !== 'string') throw new Error('D4A3B sidecar: ownerFile must be a string');
  if (!Number.isInteger(event.poolInstance)) throw new Error('D4A3B sidecar: poolInstance must be an integer');
  if (event.clientSeq !== null && !Number.isInteger(event.clientSeq)) {
    throw new Error('D4A3B sidecar: clientSeq must be an integer or null');
  }
  if (event.pid !== undefined && !Number.isInteger(event.pid)) {
    throw new Error('D4A3B sidecar: pid must be an integer when present');
  }
  if (event.code !== undefined && !SAFE_CODE.test(event.code)) {
    throw new Error('D4A3B sidecar: code must be a safe A-Z0-9_ token when present');
  }
}

function appendLine(writer: SidecarWriter, event: AttributionSidecarEvent): void {
  appendFileSync(writer.filePath, `${JSON.stringify(event)}\n`, {
    // 'ax': append, fail if the file already exists — the first write for this
    // process/run is the create point and refuses stale prior-run data.
    flag: writer.created ? 'a' : 'ax',
    mode: 0o600,
  });
  if (!writer.created) {
    chmodSync(writer.filePath, 0o600);
    writer.created = true;
  }
  writer.lines += 1;
}

function writeEvent(writer: SidecarWriter, event: AttributionSidecarEvent, lineCap: number): void {
  validateEvent(event);
  if (writer.full) return; // bounded: nothing after the explicit sidecar-full marker
  if (writer.lines >= lineCap) {
    writer.full = true;
    appendLine(writer, {
      v: 1,
      runId: event.runId,
      ts: event.ts,
      event: 'sidecar-full',
      resourceClass: event.resourceClass,
      ownerFile: event.ownerFile,
      poolInstance: event.poolInstance,
      clientSeq: null,
    });
    return;
  }
  appendLine(writer, event);
}

function openWriter(filePath: string): SidecarWriter {
  const registry = writerRegistry();
  const existing = registry.get(filePath);
  if (existing) return existing; // same live process: reuse, never fail on ourselves
  if (existsSync(filePath)) {
    throw new Error(
      `D4A3B sidecar: refusing to append to an unexpected pre-existing per-process file (stale prior-run data?): ${filePath}`,
    );
  }
  mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  chmodSync(path.dirname(filePath), 0o700);
  const writer: SidecarWriter = { filePath, lines: 0, full: false, created: false };
  registry.set(filePath, writer);
  return writer;
}

export function readSidecarEvents(filePath: string): AttributionSidecarEvent[] {
  const lines = readFileSync(filePath, 'utf8').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const events: AttributionSidecarEvent[] = [];
  lines.forEach((line, index) => {
    let parsed: AttributionSidecarEvent;
    try {
      parsed = JSON.parse(line) as AttributionSidecarEvent;
    } catch {
      throw new Error(`D4A3B sidecar: malformed line ${filePath}:${index + 1}`);
    }
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      parsed.v !== 1 ||
      typeof parsed.event !== 'string' ||
      typeof parsed.runId !== 'string'
    ) {
      throw new Error(`D4A3B sidecar: invalid event at ${filePath}:${index + 1}`);
    }
    events.push(parsed);
  });
  return events;
}

function sanitizeOwnerFile(value: string): string {
  // A repo-relative test path label — printable ASCII only, bounded; never a
  // path on disk, so '/' stays legitimate. UNKNOWN is preserved verbatim: the
  // reader-side proof rule (isOwnerProofEligible) rejects it as owner proof.
  const cleaned = value.replace(/[^\x20-\x7e]/g, '').trim().slice(0, 200);
  return cleaned || 'UNKNOWN';
}

type ClientRecord = { seq: number; pid?: number; probe: 'none' | 'pending' | 'done' | 'failed' };

const attributedPools = new WeakMap<Pool, AttributionHandle>();

export function attachPoolAttribution(
  pool: Pool,
  owner: AttributionOwner,
  options: AttributionAttachOptions = {},
): AttributionHandle | null {
  const source = options.source ?? process.env;
  if (source[ATTRIBUTION_DIAGNOSTICS_VAR] !== '1') return null;
  const existing = attributedPools.get(pool);
  if (existing) return existing; // idempotent: never duplicate listeners

  const runId = sanitizeRunIdForPath(source[ATTRIBUTION_RUN_ID_VAR]);
  const root = options.root ?? ATTRIBUTION_SIDECAR_ROOT;
  const processId = options.processId ?? process.pid;
  const lineCap = options.lineCap ?? DEFAULT_LINE_CAP;
  const now = options.now ?? (() => new Date());
  const ownerFile = sanitizeOwnerFile(owner.owner);
  const writer = openWriter(sidecarFilePathFor(root, source[ATTRIBUTION_RUN_ID_VAR], processId));
  const poolInstance = counters().pool++;

  const emit = (
    event: AttributionEventName,
    clientSeq: number | null,
    extra: { pid?: number; code?: string } = {},
  ): void => {
    writeEvent(
      writer,
      {
        v: 1,
        runId,
        ts: now().toISOString(),
        event,
        resourceClass: owner.resourceClass,
        ownerFile,
        poolInstance,
        clientSeq,
        ...(extra.pid !== undefined ? { pid: extra.pid } : {}),
        ...(extra.code !== undefined ? { code: extra.code } : {}),
      },
      lineCap,
    );
  };

  const clients = new Map<PoolClient, ClientRecord>();
  const ensureClient = (client: PoolClient): ClientRecord => {
    let record = clients.get(client);
    if (!record) {
      record = { seq: counters().client++, probe: 'none' };
      clients.set(client, record);
    }
    return record;
  };

  // Read-only PID probe. Submitted synchronously inside the event handler; on a
  // fresh connection ('connect') or at the first attributed acquire of an
  // already-existing client, pg's per-connection FIFO queue runs it before the
  // acquiring caller's first query. Never invents a pid; a failure is recorded
  // visibly and never retried on this client.
  const probePid = (client: PoolClient, record: ClientRecord): void => {
    if (record.probe !== 'none') return;
    record.probe = 'pending';
    let promise: Promise<unknown>;
    try {
      promise = client.query(PID_PROBE_SQL);
    } catch (error) {
      record.probe = 'failed';
      emit('client-pid-error', record.seq, { code: safeErrorCode(error) });
      return;
    }
    void promise.then(
      (result) => {
        const pid = Number(
          (result as { rows?: Array<{ pid?: unknown }> }).rows?.[0]?.pid,
        );
        if (!Number.isInteger(pid)) {
          record.probe = 'failed';
          emit('client-pid-error', record.seq, { code: 'PID_UNREADABLE' });
          return;
        }
        record.probe = 'done';
        record.pid = pid;
        emit('client-pid', record.seq, { pid });
      },
      (error) => {
        record.probe = 'failed';
        emit('client-pid-error', record.seq, { code: safeErrorCode(error) });
      },
    );
  };

  // Installed pg-pool 3.14.0 event signatures:
  //   connect(client) — new physical client, emitted before the caller gets it
  //   acquire(client) — every checkout, before the caller gets it
  //   release(err, client) — every return
  //   remove(client) — client discarded
  //   error(err, client) — idle client error
  pool.on('connect', (client) => {
    const record = ensureClient(client);
    emit('client-connect', record.seq);
    probePid(client, record);
  });
  pool.on('acquire', (client) => {
    const record = ensureClient(client);
    probePid(client, record); // lazy probe for pre-existing clients (seed model)
    emit('client-acquire', record.seq, { pid: record.pid });
  });
  pool.on('release', (err, client) => {
    const record = ensureClient(client);
    emit('client-release', record.seq, { pid: record.pid, code: safeErrorCode(err) });
  });
  pool.on('remove', (client) => {
    const record = ensureClient(client);
    emit('client-remove', record.seq, { pid: record.pid });
    clients.delete(client);
  });
  pool.on('error', (err) => {
    void err; // never serialize the error object itself
    emit('pool-error', null, { code: safeErrorCode(err) });
  });

  emit('pool-open', null);
  const handle: AttributionHandle = {
    poolInstance,
    writerPath: writer.filePath,
    writeTestOnly: (event) => {
      writeEvent(writer, event, lineCap);
    },
  };
  attributedPools.set(pool, handle);
  return handle;
}

// Diagnostics ON: create the helper-owned, attributed Pool from the exact same
// config the adapter would have used. Diagnostics OFF: null — the caller keeps
// the config-object path and the adapter keeps owning its pool.
export function createAttributedPool(
  config: PoolConfig,
  owner: AttributionOwner,
  options: AttributionAttachOptions = {},
): Pool | null {
  const source = options.source ?? process.env;
  if (source[ATTRIBUTION_DIAGNOSTICS_VAR] !== '1') return null;
  const pool = new Pool(config);
  const handle = attachPoolAttribution(pool, owner, options);
  if (!handle) {
    void pool.end().catch(() => undefined);
    return null;
  }
  return pool;
}
