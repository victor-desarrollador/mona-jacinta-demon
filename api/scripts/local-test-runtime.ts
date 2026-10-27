import type { PrismaClient } from '../src/generated/prisma/client.js';
import { openProvenLocalTestPrisma, proveIdentityOnTransaction, type ProvenLocalTestPrisma } from './demo-database.js';
import { defaultSeedPasswordHash, seedDemoOnTransaction } from '../prisma/seed.js';
import { randomBytes } from 'node:crypto';
import {
  DigestSink,
  PROTECTED_RELATIONS,
  protectedDomainContractSha256,
  proveDomainOnTransaction,
  proveSettingsOnTransaction,
  readStateOnTransaction,
  type ProtectedTx,
  type SettingsProfile,
  type StateRows,
} from './local-test-fingerprint.js';
import {
  TRANSFORMATION_CONTRACT_SHA256,
  classifyLocalTestBaseline,
  createLocalTestBaselineRuntime,
  defaultLocalTestCanonicalBaseline,
  readFactsOnTransaction,
  readLocalTestBaselineFacts,
  verifyTransformation,
  type ApprovedMigration,
  type LocalTestBaselineRuntime,
  type LocalTestBaselineRuntimeDeps,
  type LocalTestCanonicalBaseline,
} from './local-test-baseline.js';

// Task 4: LOCAL_TEST runtime integration — the object the LOCAL_TEST prepare
// orchestrator (local-test-prepare.mjs) loads through tsx and drives.
//
// It owns the LOCAL_TEST resources it opens: on the first proveIdentity() it asks
// the demo-database.ts proven-Prisma opener for a PrismaClient built on the very
// pg.Pool the identity was proven on, then composes the pure baseline runtime
// (local-test-baseline.ts) over that client. Target and approved migrations are
// supplied explicitly by the caller and copied at construction; nothing here
// reads the environment, the filesystem or starts a process.
//
// Construction performs no I/O at all. Before the first successful proof every
// other operation refuses; a failed open, composition or later proof latches the
// runtime (nothing is retried or reopened); after close() every operation refuses.

export const LOCAL_TEST_PROVEN_PRISMA_EXPORT = 'openProvenLocalTestPrisma';
export type { ProvenLocalTestPrisma };

export type LocalTestApprovedMigration = { name: string; sha256: string };
export type LocalTestRuntimeInput = {
  databaseUrl: string;
  markerId: string;
  approvedMigrations: readonly LocalTestApprovedMigration[];
};
// The explicit LOCAL_TEST configuration handed to the opener (the same keys
// readLocalTestTarget reads), never the process environment.
export type LocalTestRuntimeSource = Readonly<{
  LOCAL_TEST_DATABASE_URL: string;
  LOCAL_TEST_DATABASE_MARKER_ID: string;
}>;
export type LocalTestRuntimeDeps = {
  openProvenPrisma?: (source: LocalTestRuntimeSource) => Promise<ProvenLocalTestPrisma>;
  canonicalBaseline?: (migrations: readonly ApprovedMigration[]) => LocalTestCanonicalBaseline;
  readFacts?: (db: PrismaClient) => Promise<unknown>;
  createBaselineRuntime?: (deps: LocalTestBaselineRuntimeDeps) => LocalTestBaselineRuntime;
  // Test seam for the protected operations: replaces individual in-transaction steps (default: the real ones).
  protectedSteps?: Partial<ProtectedSteps>;
  // Test seam: the seed password hash (default: bcrypt cost 12 of the seed password).
  hashPassword?: () => Promise<string>;
};

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const INVALID_INPUT = 'LOCAL_TEST runtime requires an explicit databaseUrl, markerId and approved migrations';
const NOT_PROVEN = 'LOCAL_TEST runtime requires a successful proveIdentity() first';
const CLOSED = 'LOCAL_TEST runtime is closed';
const FAILED = 'LOCAL_TEST runtime identity could not be proven; refusing further use (details not shown)';
const CLOSE_FAILED = 'LOCAL_TEST runtime could not be closed cleanly (details not shown)';
const RESUME_LATCHED = 'LOCAL_TEST resume outcome is unknown; refusing another resume (run the outcome verifier; details not shown)';

function copyInput(input: LocalTestRuntimeInput) {
  const valid =
    input !== null &&
    typeof input === 'object' &&
    typeof input.databaseUrl === 'string' &&
    input.databaseUrl !== '' &&
    typeof input.markerId === 'string' &&
    UUID_V4.test(input.markerId) &&
    Array.isArray(input.approvedMigrations) &&
    input.approvedMigrations.length > 0 &&
    input.approvedMigrations.every(
      (m) => m !== null && typeof m === 'object' && typeof m.name === 'string' && m.name !== '' && typeof m.sha256 === 'string' && SHA256.test(m.sha256),
    );
  if (!valid) throw new Error(INVALID_INPUT);
  return Object.freeze({
    databaseUrl: input.databaseUrl,
    markerId: input.markerId,
    approvedMigrations: Object.freeze(input.approvedMigrations.map(({ name, sha256 }) => Object.freeze({ name, sha256 }))),
  });
}

export type LocalTestRuntime = LocalTestBaselineRuntime & {
  // Seed #2 inside the single protected transaction (design T0–T16). Resolves only after an acknowledged COMMIT.
  resumeSeed2: (request: Omit<ProtectedResumeRequest, 'passwordHash'> & { passwordHash?: string }) => Promise<ResumeResult>;
  // Read-only, finite-timeout verification of an unknown state: the two digests only.
  checkOutcome: () => Promise<OutcomeDigests>;
  // Runs the backup driver while the REPEATABLE READ exporter holds the snapshot; then proves schema stability (B11).
  withBackupSnapshot: <T>(callback: (context: BackupSnapshotContext) => Promise<T>) => Promise<T>;
};

// The real in-transaction implementations of every protected step. Each takes the supplied ProtectedTx; none opens a
// transaction, client or connection (static contract: protected-capability-static.test.ts).
function realProtectedSteps(markerId: string, canonical: LocalTestCanonicalBaseline): ProtectedSteps {
  return {
    proveIdentity: (tx) => proveIdentityOnTransaction(tx, markerId),
    assertSettings: (tx, profile) => proveSettingsOnTransaction(tx, profile),
    proveDomain: (tx) => proveDomainOnTransaction(tx),
    classify: async (tx) => classifyLocalTestBaseline(await readFactsOnTransaction(tx), canonical).state,
    readState: (tx, sinks, keepRows) => readStateOnTransaction(tx, sinks, keepRows),
    seed: (tx, passwordHash) => seedDemoOnTransaction(tx, passwordHash),
    verifyTransformation: (pre, post) => verifyTransformation(pre, post),
  };
}

export function createLocalTestRuntime(input: LocalTestRuntimeInput, deps: LocalTestRuntimeDeps = {}): LocalTestRuntime {
  const reviewed = copyInput(input);
  const source: LocalTestRuntimeSource = Object.freeze({
    LOCAL_TEST_DATABASE_URL: reviewed.databaseUrl,
    LOCAL_TEST_DATABASE_MARKER_ID: reviewed.markerId,
  });
  // The one sha256 -> checksum adaptation the canonical descriptor needs; order kept.
  const approved: readonly ApprovedMigration[] = Object.freeze(
    reviewed.approvedMigrations.map(({ name, sha256 }) => Object.freeze({ name, checksum: sha256 })),
  );
  const options = Object.freeze({ ...deps });
  const openProvenPrisma = options.openProvenPrisma ?? openProvenLocalTestPrisma;

  let state: 'new' | 'opening' | 'open' | 'failed' | 'closed' = 'new';
  let resources: ProvenLocalTestPrisma | null = null;
  let canonicalForSteps: LocalTestCanonicalBaseline | null = null;
  // After an UNKNOWN commit outcome nothing here may start another resume: the outcome verifier decides (never retry).
  let resumeLatched = false;
  let baseline: LocalTestBaselineRuntime | null = null;
  let opening: Promise<void> | null = null;
  let releasing: Promise<void> | null = null;
  let closing: Promise<void> | null = null;

  // The single release of the opened resources, whoever asks first: the composed
  // baseline's close, a failed composition, or close() before composition.
  const release = () => (releasing ??= resources ? resources.close() : Promise.resolve());

  const protectedSteps = (): ProtectedSteps => ({ ...realProtectedSteps(reviewed.markerId, canonicalForSteps!), ...options.protectedSteps });
  const usable = (): LocalTestBaselineRuntime => {
    if (state === 'closed') throw new Error(CLOSED);
    if (state === 'failed') throw new Error(FAILED);
    if (state !== 'open' || !baseline) throw new Error(NOT_PROVEN);
    return baseline;
  };

  const compose = (opened: ProvenLocalTestPrisma): LocalTestBaselineRuntime => {
    const { prisma } = opened;
    const canonical = (options.canonicalBaseline ?? defaultLocalTestCanonicalBaseline)(approved);
    canonicalForSteps = canonical;
    const readFacts = options.readFacts ?? ((db: PrismaClient) => readLocalTestBaselineFacts(db));
    return (options.createBaselineRuntime ?? createLocalTestBaselineRuntime)({
      db: prisma,
      canonical,
      proveIdentity: () => opened.proveIdentity(),
      readFacts: () => readFacts(prisma),
      close: release,
    });
  };

  // First proof: the opener's own proof is it. If anything after the open fails,
  // the opened resources are released once; every failure is latched.
  const open = async () => {
    state = 'opening';
    let opened: ProvenLocalTestPrisma;
    try {
      opened = await openProvenPrisma(source);
    } catch {
      if (state === 'opening') state = 'failed';
      throw new Error(FAILED);
    }
    resources = opened;
    if (state !== 'opening') throw new Error(CLOSED); // closed meanwhile; close() releases
    try {
      baseline = compose(opened);
    } catch {
      state = 'failed';
      await release().catch(() => undefined);
      throw new Error(FAILED);
    }
    state = 'open';
  };

  return {
    proveIdentity: async () => {
      if (state === 'new') return (opening = open());
      const composed = usable();
      try {
        await composed.proveIdentity();
      } catch {
        if (state === 'open') state = 'failed';
        throw new Error(FAILED);
      }
    },
    resumeSeed2: async (request) => {
      usable();
      if (resumeLatched) throw new Error(RESUME_LATCHED);
      // bcrypt is CPU only: computed BEFORE the transaction so it never runs inside the locked window
      const passwordHash = request.passwordHash ?? (await (options.hashPassword ?? (() => defaultSeedPasswordHash()))());
      try {
        return await withProtectedResumeTransaction(resources!.prisma, { ...request, passwordHash }, { steps: protectedSteps() });
      } catch (error) {
        if (error instanceof ResumeFailure && error.kind === 'COMMIT_UNKNOWN') resumeLatched = true;
        throw error;
      }
    },
    checkOutcome: async () => {
      usable();
      return checkOutcomeTransaction(resources!.prisma, { steps: protectedSteps() });
    },
    withBackupSnapshot: async (callback) => {
      usable();
      return withBackupSnapshotTransaction(resources!.prisma, callback, { steps: protectedSteps() });
    },
    classify: async () => usable().classify(),
    seedDemo: async () => usable().seedDemo(),
    backfillCompanyLocations: async () => usable().backfillCompanyLocations(),
    verifyBaseline: async () => usable().verifyBaseline(),
    close: () =>
      (closing ??= (async () => {
        state = 'closed';
        await opening?.catch(() => undefined);
        try {
          await (baseline ? baseline.close() : release());
        } catch {
          throw new Error(CLOSE_FAILED);
        }
      })()),
  };
}

// ===== R4 protected transaction owner =====
//
// One Prisma interactive transaction is the ONLY database capability of the protected phase. The owner (this section)
// issues the fixed session/lock statements itself; every protected step receives a ProtectedTx, a wrapper over the
// transaction client through which transaction control, client lifecycle, session SET and arbitrary raw statements
// are unreachable. COMMIT is implicit in Prisma's callback return, so the commit gate is the last statement of the
// callback: it is reachable only with a token minted from a durable witness receipt (design C10).

export type StatementClass = 'read' | 'forbidden';

// Removes block and line comments (a nested comment is left half-stripped, which can only make the result look MORE
// suspicious: that fails closed), then classifies by the first keyword. Anything that is not a plain SELECT/WITH single
// statement is forbidden, as is any set_config call.
export function classifyStatement(sql: string): StatementClass {
  if (typeof sql !== 'string') return 'forbidden';
  let text = sql;
  for (;;) {
    const next = text.replace(/\/\*[\s\S]*?\*\//, ' ');
    if (next === text) break;
    text = next;
  }
  text = text.replace(/--[^\n]*/g, ' ').trim().replace(/;+\s*$/, '').trim();
  if (text === '' || text.includes(';') || /set_config\s*\(/i.test(text)) return 'forbidden';
  const keyword = /^([A-Za-z]+)/.exec(text)?.[1]?.toLowerCase();
  if (keyword === 'select' || keyword === 'with') return 'read';
  return 'forbidden';
}

export type ProtectedSession = {
  id: string;
  phase: 'setup' | 'locked' | 'closed';
  statements: { sql: string; token: string }[];
  onStatement?: (record: { source: 'step'; token: string; sql: string }) => void;
};
const ESCAPE = 'MJ_PROTECTED_CAPABILITY_ESCAPE';
const DENIED_MEMBERS = new Set<string | symbol>(['$transaction', '$connect', '$disconnect', '$on', '$use', '$extends']);
const RAW_MEMBERS = new Set<string | symbol>(['$queryRaw', '$queryRawUnsafe', '$executeRaw', '$executeRawUnsafe']);

// Wraps the interactive-transaction client. Model delegates pass through (their SQL is Prisma-generated DML/SELECT);
// raw statements pass only in the 'locked' phase and only if classifyStatement allows them; everything that could end,
// nest or re-open a transaction, or open another connection, throws.
export function protectTx(raw: unknown, session: ProtectedSession): ProtectedTx {
  const target = raw as Record<string | symbol, unknown>;
  return new Proxy(target, {
    get(t, prop) {
      if (DENIED_MEMBERS.has(prop)) {
        return () => {
          throw new Error(`${ESCAPE}: transaction control or client lifecycle is not available to protected steps`);
        };
      }
      if (RAW_MEMBERS.has(prop)) {
        const unsafe = String(prop).endsWith('Unsafe');
        return async (first: unknown, ...rest: unknown[]) => {
          const sql = unsafe ? String(first) : (first as readonly string[]).join('?');
          if (session.phase !== 'locked') throw new Error(`${ESCAPE}: protected statement outside the locked phase`);
          if (classifyStatement(sql) === 'forbidden') throw new Error(`${ESCAPE}: statement is not allowed on the protected capability`);
          session.statements.push({ sql, token: session.id });
          session.onStatement?.({ source: 'step', token: session.id, sql });
          return (t[prop] as (...a: unknown[]) => unknown)(first, ...rest);
        };
      }
      return Reflect.get(t, prop);
    },
    set() {
      throw new Error(`${ESCAPE}: the protected capability is immutable`);
    },
  }) as unknown as ProtectedTx;
}

export type ResumeStage =
  | 'setup' | 'locks' | 'identity' | 'settings' | 'domain' | 'classify' | 'fingerprint' | 'validate' | 'preconditions'
  | 'consume' | 'seed' | 'classify-post' | 'verify' | 'guard' | 'witness' | 'final-settings' | 'commit';
// The only error the owner throws. It carries no cause, no message of the underlying error and no value: the
// underlying error is dropped on purpose (it may carry protected rows). kind says whether the transaction is known to
// be rolled back or whether the COMMIT outcome is unknown (never retry: run the outcome verifier).
export class ResumeFailure extends Error {
  readonly kind: 'ROLLED_BACK' | 'COMMIT_UNKNOWN';
  readonly stage: ResumeStage;
  readonly reason: 'TIMEOUT' | 'FAILED';
  constructor(kind: 'ROLLED_BACK' | 'COMMIT_UNKNOWN', stage: ResumeStage, reason: 'TIMEOUT' | 'FAILED') {
    super('protected resume transaction failed');
    this.kind = kind;
    this.stage = stage;
    this.reason = reason;
  }
}

export type ReadStateResult = Readonly<{ rows: StateRows | null; serverVersionNum: string; markerId: string; schemaDigest: string }>;
export type ProtectedSteps = Readonly<{
  proveIdentity: (tx: ProtectedTx) => Promise<void>;
  assertSettings: (tx: ProtectedTx, profile: SettingsProfile) => Promise<void>;
  proveDomain: (tx: ProtectedTx) => Promise<void>;
  classify: (tx: ProtectedTx) => Promise<string>;
  readState: (tx: ProtectedTx, sinks: readonly DigestSink[], keepRows: boolean) => Promise<ReadStateResult>;
  seed: (tx: ProtectedTx, passwordHash: string) => Promise<void>;
  verifyTransformation: (pre: StateRows, post: StateRows) => void | Promise<void>;
}>;
export type PostWitnessRequest = Readonly<{
  nonce: string;
  fPre: string;
  fPost: string;
  serverVersionNum: string;
  markerId: string;
  protectedDomainContractSha256: string;
  transformationContractSha256: string;
}>;
export type ProtectedResumeRequest = Readonly<{
  expectedFPre: string;
  passwordHash: string;
  checkPreconditions: () => Promise<void>;
  consumeAuthorization: () => Promise<void>;
  persistPostWitness: (request: PostWitnessRequest) => Promise<unknown>;
}>;
export type ProtectedResumeOptions = Readonly<{
  steps?: Partial<ProtectedSteps>;
  randomNonce?: () => string;
  timers?: Readonly<{ setTimeout: (fn: () => void, ms: number) => unknown; clearTimeout: (handle: unknown) => void }>;
  witnessDeadlineMs?: number;
  transactionOptions?: Readonly<{ maxWait: number; timeout: number }>;
  transformationContractSha256?: string;
  observer?: (record: { source: 'owner' | 'step'; token: string; sql: string }) => void;
}>;
export type ProtectedPrisma = Pick<PrismaClient, '$transaction'>;
export type ResumeResult = Readonly<{ fPost: string }>;

export type CommitToken = Readonly<{ readonly kind: 'WitnessDurable' }>;
// The commit gate: a token is minted only from a receipt that echoes THIS transaction's nonce and the runtime-computed
// fPost, is recorded in a private WeakSet, and is consumed once. A plain object, a token of another gate or a replay
// cannot pass commit().
export function createCommitGate(nonce: string, fPost: string): { mint: (receipt: unknown) => CommitToken; commit: (token: unknown) => void } {
  const issued = new WeakSet<object>();
  let used = false;
  return {
    mint(receipt) {
      const r = receipt as { durable?: unknown; nonce?: unknown; fPost?: unknown } | null;
      if (r === null || typeof r !== 'object' || r.durable !== true || r.nonce !== nonce || r.fPost !== fPost) throw new Error('witness receipt rejected');
      const token: CommitToken = Object.freeze({ kind: 'WitnessDurable' as const });
      issued.add(token);
      return token;
    },
    commit(token) {
      if (token === null || typeof token !== 'object' || !issued.has(token) || used) throw new Error('commit gate refused');
      used = true;
    },
  };
}

const OWNER_SETUP = Object.freeze([
  'SET LOCAL search_path = pg_catalog, pg_temp',
  "SET LOCAL lock_timeout = '10s'",
  "SET LOCAL statement_timeout = '120s'",
  "SET LOCAL idle_in_transaction_session_timeout = '180s'",
  'SET LOCAL synchronous_commit = on',
  // The adapter binds Date parameters as zone-less text; pin the zone so seed #2 writes the same instants whatever the server default.
  "SET LOCAL timezone = 'UTC'",
]);
const MARKER_LOCK = 'LOCK TABLE mona_local_test_guard.database_identity IN SHARE MODE';
const tableLock = (relation: string) => `LOCK TABLE public."${relation}" IN EXCLUSIVE MODE`;
const TIMEOUT_SQLSTATE = new Set(['55P03', '57014', '25P03']);
const WITNESS_DEADLINE_MS = 10_000;
const DEFAULT_TRANSACTION_OPTIONS = Object.freeze({ maxWait: 10_000, timeout: 150_000 });

class DeadlineError extends Error {
  constructor() {
    super('deadline exceeded');
  }
}
const readCode = (error: unknown): unknown => {
  try {
    return (error as { code?: unknown } | null)?.code;
  } catch {
    return undefined;
  }
};
const reasonOf = (error: unknown): 'TIMEOUT' | 'FAILED' => {
  const code = readCode(error);
  return error instanceof DeadlineError || (typeof code === 'string' && TIMEOUT_SQLSTATE.has(code)) ? 'TIMEOUT' : 'FAILED';
};
const unwired = (name: string) => async (): Promise<never> => {
  throw new Error(`protected step ${name} is not wired`);
};
const DEFAULT_STEPS: ProtectedSteps = Object.freeze({
  proveIdentity: unwired('proveIdentity'),
  assertSettings: unwired('assertSettings'),
  proveDomain: unwired('proveDomain'),
  classify: unwired('classify'),
  readState: unwired('readState'),
  seed: unwired('seed'),
  verifyTransformation: unwired('verifyTransformation'),
});

// Resumes seed #2 inside the single protected transaction (design T0–T16). Resolves only after an acknowledged COMMIT.
// Every failure is a ResumeFailure: ROLLED_BACK (nothing committed) or COMMIT_UNKNOWN (never retried here).
export async function withProtectedResumeTransaction(
  prisma: ProtectedPrisma,
  request: ProtectedResumeRequest,
  options: ProtectedResumeOptions = {},
): Promise<ResumeResult> {
  const steps: ProtectedSteps = { ...DEFAULT_STEPS, ...options.steps };
  const timers = options.timers ?? { setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms), clearTimeout: (h: unknown) => clearTimeout(h as NodeJS.Timeout) };
  const nonce = (options.randomNonce ?? (() => randomBytes(16).toString('hex')))();
  const contractDigest = options.transformationContractSha256 ?? TRANSFORMATION_CONTRACT_SHA256;
  let stage: ResumeStage = 'setup';
  let commitRequested = false;
  let fPostResult = '';

  // Runs one step; any error becomes a ResumeFailure (no cause, no message) carrying only the stage and a timeout flag.
  const at = async <T>(name: ResumeStage, fn: () => Promise<T> | T): Promise<T> => {
    stage = name;
    try {
      return await fn();
    } catch (error) {
      throw new ResumeFailure('ROLLED_BACK', name, reasonOf(error));
    }
  };
  const withDeadline = <T>(promise: Promise<T>, ms: number): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const handle = timers.setTimeout(() => reject(new DeadlineError()), ms);
      promise.then(
        (value) => { timers.clearTimeout(handle); resolve(value); },
        (error: unknown) => { timers.clearTimeout(handle); reject(error); },
      );
    });

  try {
    await prisma.$transaction(
      async (raw) => {
        const session: ProtectedSession = { id: randomBytes(8).toString('hex'), phase: 'setup', statements: [], onStatement: options.observer ? (r) => options.observer?.(r) : undefined };
        const ownerSql = (sql: string) => {
          options.observer?.({ source: 'owner', token: 'owner', sql });
          return raw.$executeRawUnsafe(sql);
        };
        await at('setup', async () => {
          for (const sql of OWNER_SETUP) await ownerSql(sql);
        });
        await at('locks', async () => {
          await ownerSql(MARKER_LOCK);
          for (const relation of PROTECTED_RELATIONS) await ownerSql(tableLock(relation));
          session.phase = 'locked';
        });
        const tx = protectTx(raw, session);

        await at('identity', () => steps.proveIdentity(tx));
        await at('settings', () => steps.assertSettings(tx, 'resume'));
        await at('domain', () => steps.proveDomain(tx));
        await at('classify', async () => {
          if ((await steps.classify(tx)) !== 'POST_BACKFILL') throw new Error('state is not POST_BACKFILL');
        });

        // T8: the pre-image state is hashed (PRE domain) and its rows held in memory for the transformation verifier.
        const preSink = new DigestSink('PRE');
        const pre = await at('fingerprint', () => steps.readState(tx, [preSink], true));
        const preRows = pre.rows;
        const fPreNow = preSink.end();
        await at('validate', () => {
          if (preRows === null || fPreNow !== request.expectedFPre) throw new Error('state differs from the verified backup');
        });
        await at('preconditions', () => request.checkPreconditions());
        // T11: the single use of the authorization — after every validation, immediately before the first write.
        await at('consume', () => request.consumeAuthorization());
        await at('settings', () => steps.assertSettings(tx, 'resume'));
        await at('seed', () => steps.seed(tx, request.passwordHash));

        await at('settings', () => steps.assertSettings(tx, 'resume'));
        await at('classify-post', async () => {
          if ((await steps.classify(tx)) !== 'EXACT_BASELINE') throw new Error('state is not EXACT_BASELINE');
        });
        // T14: ONE read of Q. The same rows feed the transformation verifier and both digest sinks (verified == witnessed).
        const postPre = new DigestSink('PRE');
        const postPost = new DigestSink('POST');
        const post = await at('fingerprint', () => steps.readState(tx, [postPre, postPost], true));
        const postRows = post.rows;
        const dPreOfQ = postPre.end();
        const fPost = postPost.end();
        await at('verify', async () => {
          if (preRows === null || postRows === null) throw new Error('state rows are unavailable');
          // seed #2 performs no DDL: the schema-only digest of Q equals that of P (R3 transformation contract)
          if (pre.schemaDigest !== post.schemaDigest) throw new Error('the schema changed during the seed');
          await steps.verifyTransformation(preRows, postRows);
        });
        // T14a: state-change guard (defence in depth), compared in the SAME (PRE) domain as fPre.
        await at('guard', () => {
          if (dPreOfQ === request.expectedFPre) throw new Error('the seed changed nothing');
        });

        // T14b: the witness must be durable BEFORE COMMIT; only a valid receipt mints the commit token.
        const gate = createCommitGate(nonce, fPost);
        const token = await at('witness', async () => {
          if (!contractDigest) throw new Error('transformation contract digest is required');
          const receipt = await withDeadline(
            Promise.resolve(request.persistPostWitness({
              nonce,
              fPre: request.expectedFPre,
              fPost,
              serverVersionNum: post.serverVersionNum,
              markerId: post.markerId,
              protectedDomainContractSha256: protectedDomainContractSha256(),
              transformationContractSha256: contractDigest,
            })),
            options.witnessDeadlineMs ?? WITNESS_DEADLINE_MS,
          );
          return gate.mint(receipt);
        });
        await at('final-settings', () => steps.assertSettings(tx, 'resume'));
        stage = 'commit';
        gate.commit(token);
        fPostResult = fPost;
        commitRequested = true; // the callback returns next: Prisma issues COMMIT
        session.phase = 'closed';
      },
      { ...DEFAULT_TRANSACTION_OPTIONS, ...options.transactionOptions, isolationLevel: 'ReadCommitted' } as Parameters<PrismaClient['$transaction']>[1] & object,
    );
  } catch (error) {
    if (error instanceof ResumeFailure) throw error;
    throw new ResumeFailure(commitRequested ? 'COMMIT_UNKNOWN' : 'ROLLED_BACK', commitRequested ? 'commit' : stage, reasonOf(error));
  }
  return { fPost: fPostResult };
}

// ===== R4 read-only outcome verifier (design OUTCOME-VERIFIER §2; breaker LOW-7: finite timeouts) =====
export type OutcomeDigests = Readonly<{
  pre: string;
  post: string;
  serverVersionNum: string;
  markerId: string;
  // digest values only: the domain contract and the transformation verifier(s) the CURRENT code stands for; the tool binds
  // witnesses to them (a witness approved by another verifier is invalid)
  protectedDomainContractSha256: string;
  acceptedTransformationContractSha256s: readonly string[];
}>;
export class OutcomeCheckFailure extends Error {
  readonly reason: 'TIMEOUT' | 'FAILED';
  constructor(reason: 'TIMEOUT' | 'FAILED') {
    super('outcome verification failed');
    this.reason = reason;
  }
}

const lockStatements = (mode: 'ACCESS SHARE' | 'SHARE' | 'EXCLUSIVE') => [
  `LOCK TABLE mona_local_test_guard.database_identity IN ${mode === 'EXCLUSIVE' ? 'SHARE' : mode} MODE`,
  ...PROTECTED_RELATIONS.map((relation) => `LOCK TABLE public."${relation}" IN ${mode} MODE`),
];
const READ_ONLY_SETUP = (idle: string) => Object.freeze([
  'SET TRANSACTION READ ONLY',
  'SET LOCAL search_path = pg_catalog, pg_temp',
  "SET LOCAL lock_timeout = '10s'",
  "SET LOCAL statement_timeout = '120s'",
  `SET LOCAL idle_in_transaction_session_timeout = '${idle}'`,
  // The settings proof pins TimeZone = UTC for every profile: establish it here (transaction-local, no role/database/global change)
  // instead of relying on the server or role default, which differs between machines and CI.
  "SET LOCAL timezone = 'UTC'",
]);

// One read-only REPEATABLE READ transaction: finite lock/statement timeouts are set BEFORE any lock or read, ACCESS SHARE
// locks (utility, before the first read), identity, settings, domain and type contract, then ONE pass over the state fed
// to both digest roles (the unknown state must be compared against fPre in the PRE domain and against each witness fPost
// in the POST domain). Only the two digests and two metadata values leave this function; there is no retry here or above.
export async function checkOutcomeTransaction(prisma: ProtectedPrisma, options: ProtectedResumeOptions = {}): Promise<OutcomeDigests> {
  const steps: ProtectedSteps = { ...DEFAULT_STEPS, ...options.steps };
  try {
    return await prisma.$transaction(
      async (raw) => {
        const session: ProtectedSession = { id: randomBytes(8).toString('hex'), phase: 'setup', statements: [], onStatement: options.observer ? (r) => options.observer?.(r) : undefined };
        for (const sql of [...READ_ONLY_SETUP('180s'), ...lockStatements('ACCESS SHARE')]) {
          options.observer?.({ source: 'owner', token: 'owner', sql });
          await raw.$executeRawUnsafe(sql);
        }
        session.phase = 'locked';
        const tx = protectTx(raw, session);
        await steps.proveIdentity(tx);
        await steps.assertSettings(tx, 'outcome');
        await steps.proveDomain(tx);
        const pre = new DigestSink('PRE');
        const post = new DigestSink('POST');
        const read = await steps.readState(tx, [pre, post], false);
        session.phase = 'closed';
        return {
          pre: pre.end(),
          post: post.end(),
          serverVersionNum: read.serverVersionNum,
          markerId: read.markerId,
          protectedDomainContractSha256: protectedDomainContractSha256(),
          acceptedTransformationContractSha256s: [TRANSFORMATION_CONTRACT_SHA256],
        };
      },
      { ...DEFAULT_TRANSACTION_OPTIONS, ...options.transactionOptions, isolationLevel: 'RepeatableRead' } as Parameters<PrismaClient['$transaction']>[1] & object,
    );
  } catch (error) {
    throw new OutcomeCheckFailure(reasonOf(error));
  }
}

// ===== R4 backup snapshot exporter (design BACKUP-SNAPSHOT B1–B12) =====
export type BackupSnapshotContext = Readonly<{ snapshotId: string; fPre: string; serverVersionNum: string; markerId: string; protectedDomainContractSha256: string }>;
export class SnapshotFailure extends Error {
  readonly stage: 'overlap' | 'setup' | 'locks' | 'snapshot' | 'identity' | 'settings' | 'domain' | 'classify' | 'fingerprint' | 'callback' | 'stability';
  readonly reason: 'TIMEOUT' | 'FAILED';
  constructor(stage: SnapshotFailure['stage'], reason: 'TIMEOUT' | 'FAILED') {
    super('backup snapshot failed');
    this.stage = stage;
    this.reason = reason;
  }
}
const SNAPSHOT_ID = /^[0-9A-F]{8}-[0-9A-F]{8}-[0-9]{1,10}$/;
// LOW-11: one exporter per process at a time. Cross-process overlap is a procedural residual (same class as the inherited
// ABA-DDL residual): the snapshot id is function-local to one run, never stored, and refused unless it has PostgreSQL's shape.
let backupInFlight = false;

// Runs `callback` (the tool's pg_dump/list driver) while the exporter transaction — REPEATABLE READ READ ONLY, ACCESS SHARE
// on the protected relations, snapshot exported as the FIRST data statement — stays open; fPre is computed in that same
// snapshot. After the exporter COMMIT a second read-only transaction proves the schema did not change during the dump (B11).
// The snapshot id is handed to the callback only; it is not returned, stored or logged.
export async function withBackupSnapshotTransaction<T>(
  prisma: ProtectedPrisma,
  callback: (context: BackupSnapshotContext) => Promise<T>,
  options: ProtectedResumeOptions = {},
): Promise<T> {
  if (backupInFlight) throw new SnapshotFailure('overlap', 'FAILED');
  backupInFlight = true;
  const steps: ProtectedSteps = { ...DEFAULT_STEPS, ...options.steps };
  let stage: SnapshotFailure['stage'] = 'setup';
  const at = async <R>(name: SnapshotFailure['stage'], fn: () => Promise<R> | R): Promise<R> => {
    stage = name;
    try {
      return await fn();
    } catch (error) {
      throw new SnapshotFailure(name, reasonOf(error));
    }
  };
  let schemaBefore = '';
  let value: T;
  try {
    value = (await prisma.$transaction(
      async (raw) => {
        const session: ProtectedSession = { id: randomBytes(8).toString('hex'), phase: 'setup', statements: [], onStatement: options.observer ? (r) => options.observer?.(r) : undefined };
        const owner = async (sql: string) => {
          options.observer?.({ source: 'owner', token: 'owner', sql });
          await raw.$executeRawUnsafe(sql);
        };
        await at('setup', async () => { for (const sql of READ_ONLY_SETUP('15min')) await owner(sql); });
        await at('locks', async () => { for (const sql of lockStatements('ACCESS SHARE')) await owner(sql); });
        // the FIRST data statement: it fixes the REPEATABLE READ snapshot and exports exactly that snapshot
        const snapshotId = await at('snapshot', async () => {
          const rows = (await raw.$queryRawUnsafe('SELECT pg_catalog.pg_export_snapshot() AS snapshot_id')) as { snapshot_id?: unknown }[];
          const id = rows[0]?.snapshot_id;
          if (rows.length !== 1 || typeof id !== 'string' || !SNAPSHOT_ID.test(id)) throw new Error('snapshot id is malformed');
          return id;
        });
        session.phase = 'locked';
        const tx = protectTx(raw, session);
        await at('identity', () => steps.proveIdentity(tx));
        await at('settings', () => steps.assertSettings(tx, 'snapshot'));
        await at('domain', () => steps.proveDomain(tx));
        await at('classify', async () => {
          if ((await steps.classify(tx)) !== 'POST_BACKFILL') throw new Error('state is not POST_BACKFILL');
        });
        const pre = new DigestSink('PRE');
        const read = await at('fingerprint', () => steps.readState(tx, [pre], false));
        const fPre = pre.end();
        schemaBefore = read.schemaDigest;
        const result = await at('callback', () => callback({ snapshotId, fPre, serverVersionNum: read.serverVersionNum, markerId: read.markerId, protectedDomainContractSha256: protectedDomainContractSha256() }));
        session.phase = 'closed';
        return result;
      },
      { ...DEFAULT_TRANSACTION_OPTIONS, timeout: 900_000, ...options.transactionOptions, isolationLevel: 'RepeatableRead' } as Parameters<PrismaClient['$transaction']>[1] & object,
    )) as T;

    // B11: the catalog did not change while pg_dump read it (net change only; an ABA round trip is the stated LOW residual)
    stage = 'stability';
    await prisma.$transaction(
      async (raw) => {
        const session: ProtectedSession = { id: randomBytes(8).toString('hex'), phase: 'setup', statements: [], onStatement: options.observer ? (r) => options.observer?.(r) : undefined };
        for (const sql of [...READ_ONLY_SETUP('180s'), ...lockStatements('ACCESS SHARE')]) {
          options.observer?.({ source: 'owner', token: 'owner', sql });
          await raw.$executeRawUnsafe(sql);
        }
        session.phase = 'locked';
        const tx = protectTx(raw, session);
        await steps.proveIdentity(tx);
        await steps.assertSettings(tx, 'stability');
        const after = await steps.readState(tx, [new DigestSink('PRE')], false);
        session.phase = 'closed';
        if (after.schemaDigest !== schemaBefore) throw new Error('the catalog changed during the dump');
      },
      { ...DEFAULT_TRANSACTION_OPTIONS, ...options.transactionOptions, isolationLevel: 'ReadCommitted' } as Parameters<PrismaClient['$transaction']>[1] & object,
    );
    return value;
  } catch (error) {
    if (error instanceof SnapshotFailure) throw error;
    throw new SnapshotFailure(stage, reasonOf(error));
  } finally {
    backupInFlight = false;
  }
}
