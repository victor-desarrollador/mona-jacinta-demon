import type { PrismaClient } from '../src/generated/prisma/client.js';
import { openProvenLocalTestPrisma, type ProvenLocalTestPrisma } from './demo-database.js';
import {
  createLocalTestBaselineRuntime,
  defaultLocalTestCanonicalBaseline,
  readLocalTestBaselineFacts,
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
};

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const INVALID_INPUT = 'LOCAL_TEST runtime requires an explicit databaseUrl, markerId and approved migrations';
const NOT_PROVEN = 'LOCAL_TEST runtime requires a successful proveIdentity() first';
const CLOSED = 'LOCAL_TEST runtime is closed';
const FAILED = 'LOCAL_TEST runtime identity could not be proven; refusing further use (details not shown)';
const CLOSE_FAILED = 'LOCAL_TEST runtime could not be closed cleanly (details not shown)';

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

export function createLocalTestRuntime(input: LocalTestRuntimeInput, deps: LocalTestRuntimeDeps = {}): LocalTestBaselineRuntime {
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
  let baseline: LocalTestBaselineRuntime | null = null;
  let opening: Promise<void> | null = null;
  let releasing: Promise<void> | null = null;
  let closing: Promise<void> | null = null;

  // The single release of the opened resources, whoever asks first: the composed
  // baseline's close, a failed composition, or close() before composition.
  const release = () => (releasing ??= resources ? resources.close() : Promise.resolve());

  const usable = (): LocalTestBaselineRuntime => {
    if (state === 'closed') throw new Error(CLOSED);
    if (state === 'failed') throw new Error(FAILED);
    if (state !== 'open' || !baseline) throw new Error(NOT_PROVEN);
    return baseline;
  };

  const compose = (opened: ProvenLocalTestPrisma): LocalTestBaselineRuntime => {
    const { prisma } = opened;
    const canonical = (options.canonicalBaseline ?? defaultLocalTestCanonicalBaseline)(approved);
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
