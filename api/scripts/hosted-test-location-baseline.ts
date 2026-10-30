import { readFileSync } from 'node:fs';
import path from 'node:path';
import { env as processEnv } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  backfillLocationsFromBranches,
  locationTypeForBranchCode,
  verifyBackfill,
  type CompanyBootstrap,
} from '../src/modules/organization/organization.service.js';
import { openProvenTestPool, openSeedDatabase } from './demo-database.js';
import { TEST_COMPANY_BOOTSTRAP } from './test-company-bootstrap.js';

// Hosted TEST Location baseline: rebuild the six canonical Locations (and nothing else) for the canonical TEST Company.
//
//   NODE_ENV=test npx tsx scripts/hosted-test-location-baseline.ts --target=test --check   --marker-id=<uuid>
//   NODE_ENV=test npx tsx scripts/hosted-test-location-baseline.ts --target=test --dry-run --marker-id=<uuid>
//   NODE_ENV=test npx tsx scripts/hosted-test-location-baseline.ts --target=test --execute --marker-id=<uuid> --confirm-project-ref=<ref> --plan=<digest>
//
// The only write is ONE call of the shared organization-service backfill, with the TEST Company, on a database that is either clean (no
// Location; the Company absent or exactly the TEST Company) or already canonical. Anything else is refused with a code and never repaired.
// The database is opened by the guarded seed opener for the 'test' target, which proves the installed marker before handing out a client.

type Facts = {
  companies: CompanyBootstrap[];
  branches: Array<{ id: string; code: string; name: string; address: string | null; pointOfSaleNumber: number }>;
  locations: Array<{ id: string; code: string; companyId: string; type: string; name: string; address: string | null; pointOfSaleNumber: number }>;
};
type Counts = { user: number; role: number; permission: number; rolePermission: number; userRoleScope: number };
type Verdict = { state: 'ABSENT_CLEAN' | 'ALREADY_CANONICAL' | 'REFUSED'; code?: string };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

// ESM without declarations, so it is typed here.
type CommonApi = {
  checkEnvironment(env: Record<string, string | undefined>): { ok: true } | { ok: false; code: string; names: string[] };
  parseStrictArgs(argv: string[], spec: unknown): Any;
  readTarget(read: () => Uint8Array): { ok: true; held: Any; evidence: { targetDigest: string; markerDigest: string } } | { ok: false; code: string };
  confirmTarget(held: Any, args: { markerId: string; projectRef?: string }): string | null;
  failureCode(err: unknown, secrets: string[]): string;
  sha256Hex(data: string | Uint8Array): string;
  hashToolingFiles(root: string, files: readonly string[]): Array<{ file: string; sha256: string }> | null;
};
// The shared .mjs modules carry a top-level await in their import graph, so they are imported (not required); the specifier is a variable so
// the untyped modules stay `any` for the compiler.
const loadShared = (file: string): Promise<Any> => import(new URL(`../../scripts/database/${file}`, import.meta.url).href);
const common = (await loadShared('hosted-test-common.mjs')) as CommonApi;
const lib = (await loadShared('lib.mjs')) as { canonicalJson(value: unknown): string; PROJECT_REF_PATTERN: RegExp };
const hostedConfig = (await loadShared('hosted-test-config.mjs')) as { toConnectionString(held: Any): string };

export const PLAN_FORMAT = 'mona-hosted-test-location-baseline-plan/v1';
export const RESULT_FORMAT = 'mona-hosted-test-location-baseline-result/v1';
export const CANONICAL_BRANCH_CODES: readonly string[] = Object.freeze(['BAN', 'CEN', 'CON', 'DEP', 'TV', 'YB']);
export const TOOLING_FILES: readonly string[] = Object.freeze([
  'api/scripts/hosted-test-location-baseline.ts',
  'api/scripts/demo-database.ts',
  'api/scripts/test-company-bootstrap.ts',
  'api/src/modules/organization/organization.service.ts',
  'scripts/database/hosted-test-common.mjs',
  'scripts/database/hosted-test-config.mjs',
  'scripts/database/lib.mjs',
]);

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const SPEC = Object.freeze({ modes: ['check', 'dry-run', 'execute'], values: ['target', 'marker-id', 'confirm-project-ref', 'plan'] });

// ------------------------------------------------------------------------------------------------------------------ arguments
export function parseCliArgs(argv: string[]): Any {
  const base = common.parseStrictArgs(argv, SPEC);
  if (!base.ok) return base;
  const invalid = (reason: string) => ({ ok: false, code: 'ARGS_INVALID', reason });
  const { mode, values: v } = base as { mode: string; values: Record<string, string> };
  if (v.target !== 'test') return invalid('TARGET');
  if (!UUID_V4.test(v['marker-id'] ?? '')) return invalid('MARKER');
  const writes = mode === 'execute';
  const allowed = new Set(['target', 'marker-id', ...(writes ? ['confirm-project-ref', 'plan'] : [])]);
  if (Object.keys(v).some((key) => !allowed.has(key))) return invalid('ARG_NOT_FOR_MODE');
  if (writes) {
    if (!Object.hasOwn(v, 'confirm-project-ref') || !Object.hasOwn(v, 'plan')) return invalid('ARG_MISSING');
    if (!lib.PROJECT_REF_PATTERN.test(v['confirm-project-ref']!)) return invalid('PROJECT_REF');
    if (!HEX64.test(v.plan!)) return invalid('PLAN');
  }
  const values: Record<string, string> = { target: v.target!, marker: v['marker-id']! };
  if (writes) {
    values.confirm = v['confirm-project-ref']!;
    values.plan = v.plan!;
  }
  return { ok: true, mode, values };
}

// ------------------------------------------------------------------------------------------------------------------ classification
const sameCompany = (a: CompanyBootstrap, b: CompanyBootstrap) => a.id === b.id && a.name === b.name && a.cuit === b.cuit && a.address === b.address;

// ABSENT_CLEAN: no Location, and the Company is absent or exactly the TEST Company. ALREADY_CANONICAL: the TEST Company and the six Locations that
// the backfill derives from the six canonical Branches. Anything else is REFUSED: this tool converges nothing.
export function classifyLocationBaseline(facts: Facts, company: CompanyBootstrap): Verdict {
  const refused = (code: string): Verdict => ({ state: 'REFUSED', code });
  if (facts.companies.length > 1) return refused('COMPANY_AMBIGUOUS');
  const existing = facts.companies[0];
  if (existing && !sameCompany(existing, company)) return refused('COMPANY_UNEXPECTED');

  const codes = facts.branches.map((b) => b.code).sort();
  if (codes.length !== CANONICAL_BRANCH_CODES.length || codes.some((code, i) => code !== CANONICAL_BRANCH_CODES[i])) return refused('BRANCH_STATE_UNEXPECTED');

  if (facts.locations.length === 0) return { state: 'ABSENT_CLEAN' };
  if (!existing || facts.locations.length !== facts.branches.length) return refused('LOCATION_STATE_UNEXPECTED');
  const byCode = new Map(facts.locations.map((l) => [l.code, l]));
  for (const branch of facts.branches) {
    const location = byCode.get(branch.code);
    if (
      !location ||
      location.id !== branch.id ||
      location.companyId !== company.id ||
      location.type !== locationTypeForBranchCode(branch.code) ||
      location.name !== branch.name ||
      location.address !== branch.address ||
      location.pointOfSaleNumber !== branch.pointOfSaleNumber
    ) {
      return refused('LOCATION_STATE_UNEXPECTED');
    }
  }
  return { state: 'ALREADY_CANONICAL' };
}

// ------------------------------------------------------------------------------------------------------------------ plan
// Digests and fixed labels only: never the Company text, a URL, host, user, password, project ref or marker id.
export function buildPlan(inputs: { company: CompanyBootstrap; tooling: Array<{ file: string; sha256: string }>; targetDigest: string; markerDigest: string }) {
  const document = {
    format: PLAN_FORMAT,
    operation: 'backfillLocationsFromBranches (one call, one transaction)',
    expectedBranchCodes: [...CANONICAL_BRANCH_CODES],
    expectedLocations: CANONICAL_BRANCH_CODES.length,
    companyDigest: common.sha256Hex(lib.canonicalJson(inputs.company)),
    tooling: [...inputs.tooling].sort((a, b) => (a.file < b.file ? -1 : 1)).map((t) => ({ file: t.file, sha256: t.sha256 })),
    targetDigest: inputs.targetDigest,
    markerDigest: inputs.markerDigest,
  };
  return { digest: common.sha256Hex(`${PLAN_FORMAT}\n${lib.canonicalJson(document)}`), document };
}

// ------------------------------------------------------------------------------------------------------------------ default collaborators
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function buildDefaultDeps(): Any {
  return {
    env: processEnv,
    readConfigBytes: () => readFileSync(path.join(repoRoot, '.env.development')),
    toolingDigests: () => common.hashToolingFiles(repoRoot, TOOLING_FILES),
    company: TEST_COMPANY_BOOTSTRAP,
    openDatabase: async () => {
      const db = await openSeedDatabase('test');
      return { prisma: db.prisma, close: db.close };
    },
    readFacts: async (db: Any): Promise<Facts> => {
      const [companies, branches, locations] = await Promise.all([db.prisma.company.findMany({ take: 3 }), db.prisma.branch.findMany(), db.prisma.location.findMany()]);
      return { companies, branches, locations };
    },
    readCounts: async (db: Any): Promise<Counts> => {
      const [user, role, permission, rolePermission, userRoleScope] = await Promise.all([
        db.prisma.user.count(),
        db.prisma.role.count(),
        db.prisma.permission.count(),
        db.prisma.rolePermission.count(),
        db.prisma.userRoleScope.count(),
      ]);
      return { user, role, permission, rolePermission, userRoleScope };
    },
    backfill: backfillLocationsFromBranches,
    verify: (db: Any) => verifyBackfill(db.prisma),
    proveMarker: async () => {
      const { pool } = await openProvenTestPool(1);
      await pool.end();
      return { ok: true };
    },
    now: () => new Date(),
    log: (line: string) => console.log(line),
    error: (line: string) => console.error(line),
  };
}

// ------------------------------------------------------------------------------------------------------------------ one run
const sameCounts = (a: Counts, b: Counts) => (Object.keys(a) as Array<keyof Counts>).every((key) => a[key] === b[key]);

export async function run(parsed: Any, deps: Any): Promise<Record<string, unknown>> {
  const { mode, values } = parsed as { mode: string; values: Record<string, string> };
  const fail = (phase: string, code: string, extra: Record<string, unknown> = {}) => ({ format: RESULT_FORMAT, mode, result: 'FAIL', phase, code, ...extra });

  const environment = common.checkEnvironment(deps.env);
  if (!environment.ok) return fail('env', environment.code, { names: environment.names });
  const target = common.readTarget(deps.readConfigBytes);
  if (!target.ok) return fail('config', target.code);
  const { held, evidence } = target;
  const mismatch = common.confirmTarget(held, { markerId: values.marker!, projectRef: mode === 'execute' ? values.confirm : undefined });
  if (mismatch) return fail('confirm', mismatch);

  const tooling = deps.toolingDigests();
  if (!Array.isArray(tooling)) return fail('plan', 'TOOLING_UNREADABLE');
  const plan = buildPlan({ company: deps.company, tooling, targetDigest: evidence.targetDigest, markerDigest: evidence.markerDigest });

  if (mode === 'dry-run') {
    return {
      format: RESULT_FORMAT, mode, result: 'PASS', planDigest: plan.digest, targetDigest: evidence.targetDigest, markerDigest: evidence.markerDigest,
      plan: { format: PLAN_FORMAT, expectedLocations: plan.document.expectedLocations, companyDigest: plan.document.companyDigest },
    };
  }
  if (mode === 'execute' && plan.digest !== values.plan) return fail('plan', 'PLAN_MISMATCH');

  const secrets = [held.password, held.host, held.username, held.projectRef, held.markerId, hostedConfig.toConnectionString(held)];
  let db: Any;
  try {
    db = await deps.openDatabase();
  } catch (error) {
    return fail('connect', common.failureCode(error, secrets));
  }
  let phase = 'precheck';
  try {
    const before: Facts = await deps.readFacts(db);
    const verdict = classifyLocationBaseline(before, deps.company);
    if (verdict.state === 'REFUSED') return fail('precheck', verdict.code ?? 'REFUSED');
    if (mode === 'check') return { format: RESULT_FORMAT, mode, result: 'PASS', state: verdict.state, locations: before.locations.length, targetDigest: evidence.targetDigest };

    const countsBefore: Counts = await deps.readCounts(db);
    const wrote = verdict.state === 'ABSENT_CLEAN';
    if (wrote) {
      phase = 'write';
      await deps.backfill(db.prisma, deps.company);
    }

    phase = 'postcheck';
    const verification = await deps.verify(db);
    if (!verification || verification.ok !== true) return fail('postcheck', 'VERIFY_FAILED', { issues: Array.isArray(verification?.issues) ? verification.issues.length : 0 });
    const after: Facts = await deps.readFacts(db);
    const countsAfter: Counts = await deps.readCounts(db);
    if (!sameCounts(countsBefore, countsAfter)) return fail('postcheck', 'PROTECTED_COUNTS_CHANGED', { protectedCounts: { before: countsBefore, after: countsAfter } });
    const final = classifyLocationBaseline(after, deps.company);
    if (final.state !== 'ALREADY_CANONICAL' || after.locations.length !== CANONICAL_BRANCH_CODES.length) return fail('postcheck', 'POSTCHECK_LOCATIONS', { locations: after.locations.length });
    const marker = await deps.proveMarker();
    if (!marker || marker.ok !== true) return fail('postcheck', 'MARKER_NOT_PROVEN');

    return {
      format: RESULT_FORMAT, mode, result: 'PASS', planDigest: plan.digest, initialState: verdict.state, finalState: final.state, wrote,
      protectedCounts: { before: countsBefore, after: countsAfter }, locations: after.locations.length,
    };
  } catch (error) {
    return fail(phase, common.failureCode(error, secrets));
  } finally {
    await db.close().catch(() => undefined);
  }
}

export async function main(argv: string[], suppliedDeps: Any = {}): Promise<number> {
  const deps = { ...buildDefaultDeps(), ...suppliedDeps };
  const parsed = parseCliArgs(argv);
  if (!parsed.ok) {
    deps.log(JSON.stringify({ format: RESULT_FORMAT, mode: null, result: 'FAIL', phase: 'args', code: parsed.code, reason: parsed.reason }));
    return 2;
  }
  const result = await run(parsed, deps);
  deps.log(JSON.stringify(result));
  return result.result === 'PASS' ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
