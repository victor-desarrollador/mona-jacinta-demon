// Zero-database tests for scripts/hosted-test-location-baseline.ts. The tool rebuilds the six canonical TEST Locations (and nothing else) for the
// canonical TEST Company; here its database, marker proof, backfill and verification are all injected doubles, and nothing connects anywhere.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { TEST_COMPANY_BOOTSTRAP } from '../scripts/test-company-bootstrap.js';
import { backfillLocationsFromBranches, locationTypeForBranchCode } from '../src/modules/organization/organization.service.js';
import {
  CANONICAL_BRANCH_CODES,
  PLAN_FORMAT,
  RESULT_FORMAT,
  TOOLING_FILES,
  buildDefaultDeps,
  buildPlan,
  classifyLocationBaseline,
  main,
  parseCliArgs,
} from '../scripts/hosted-test-location-baseline.js';

const REF = 'abcdefghij0123456789';
const MARKER = '3b1c2d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d';
const PASSWORD = 'S3cretPassw0rd';
const HOST = 'aws-0-sa-east-1.pooler.supabase.com';
const CONFIG = `TEST_DATABASE_URL=postgresql://postgres.${REF}:${PASSWORD}@${HOST}:5432/postgres\nTEST_DATABASE_MARKER_ID=${MARKER}\n`;
const CANARIES = [PASSWORD, HOST, REF, MARKER, 'postgresql://'];
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

type Company = { id: string; name: string; cuit: string; address: string };
type Branch = { id: string; code: string; name: string; address: string | null; pointOfSaleNumber: number };
type Location = { id: string; code: string; companyId: string; type: string; name: string; address: string | null; pointOfSaleNumber: number };
type Facts = { companies: Company[]; branches: Branch[]; locations: Location[] };
type Counts = { user: number; role: number; permission: number; rolePermission: number; userRoleScope: number };

const CANON: ReadonlyArray<[string, string, number]> = [
  ['CEN', 'Centro', 1], ['YB', 'Yerba Buena', 2], ['TV', 'Tafí Viejo', 3], ['BAN', 'Banda', 4], ['CON', 'Concepción', 5], ['DEP', 'Depósito Central', 6],
];
const branches = (): Branch[] => CANON.map(([code, name, pointOfSaleNumber], i) => ({ id: `00000000-0000-4000-8000-00000000030${i}`, code, name, address: `Dir ${code}`, pointOfSaleNumber }));
const locationsFor = (companyId: string): Location[] => branches().map((b) => ({ id: b.id, code: b.code, companyId, type: locationTypeForBranchCode(b.code), name: b.name, address: b.address, pointOfSaleNumber: b.pointOfSaleNumber }));
const testCompany = (): Company => ({ ...TEST_COMPANY_BOOTSTRAP });
const facts = (over: Partial<Facts> = {}): Facts => ({ companies: [testCompany()], branches: branches(), locations: [], ...over });
const COUNTS: Counts = { user: 5, role: 6, permission: 50, rolePermission: 109, userRoleScope: 2 };

type World = ReturnType<typeof makeWorld>;
function makeWorld(options: { facts?: Facts; after?: Facts; counts?: Counts; countsAfter?: Counts; config?: string | Error; env?: Record<string, string>; backfill?: () => Promise<unknown>; verify?: () => unknown; marker?: boolean; open?: () => Promise<unknown>; tooling?: Array<{ file: string; sha256: string }> } = {}) {
  const state = {
    opens: 0, closes: 0, backfills: [] as unknown[], verifies: 0, markerProofs: 0, factsReads: 0, out: [] as string[], err: [] as string[],
    current: options.facts ?? facts(), counts: options.counts ?? COUNTS,
  };
  const prisma = { id: 'fake-prisma' };
  const deps = {
    env: options.env ?? { PATH: '/usr/bin' },
    readConfigBytes: () => {
      if (options.config instanceof Error) throw options.config;
      return new Uint8Array(Buffer.from(options.config ?? CONFIG, 'utf8'));
    },
    toolingDigests: () => options.tooling ?? [{ file: 'hosted-test-location-baseline.ts', sha256: sha('tool') }],
    company: testCompany(),
    openDatabase: async () => {
      state.opens += 1;
      if (options.open) await options.open();
      return { prisma, close: async () => { state.closes += 1; } };
    },
    readFacts: async () => {
      state.factsReads += 1;
      return JSON.parse(JSON.stringify(state.current)) as Facts;
    },
    readCounts: async () => (state.factsReads > 1 && options.countsAfter ? options.countsAfter : state.counts),
    backfill: async (_db: unknown, company: unknown) => {
      state.backfills.push(company);
      if (options.backfill) return options.backfill();
      state.current = options.after ?? facts({ locations: locationsFor(TEST_COMPANY_BOOTSTRAP.id) });
      return { companyId: TEST_COMPANY_BOOTSTRAP.id, branchCount: 6 };
    },
    verify: async () => {
      state.verifies += 1;
      return options.verify ? options.verify() : { ok: true, issues: [], companyCount: 1, branchCount: 6, locationCount: state.current.locations.length };
    },
    proveMarker: async () => { state.markerProofs += 1; return { ok: options.marker !== false }; },
    now: () => new Date('2026-10-28T12:00:00.000Z'),
    log: (line: string) => state.out.push(line),
    error: (line: string) => state.err.push(line),
  };
  return { state, deps, last: () => JSON.parse(state.out.at(-1) as string) as Record<string, unknown> };
}

const ARGS = {
  check: ['--target=test', '--check', `--marker-id=${MARKER}`],
  dry: ['--target=test', '--dry-run', `--marker-id=${MARKER}`],
  exec: (plan: string) => ['--target=test', '--execute', `--marker-id=${MARKER}`, `--confirm-project-ref=${REF}`, `--plan=${plan}`],
};

async function planOf(world: World): Promise<string> {
  expect(await main(ARGS.dry, world.deps)).toBe(0);
  return world.last().planDigest as string;
}
const noSecrets = (world: World) => {
  const text = [...world.state.out, ...world.state.err].join('\n');
  for (const canary of CANARIES) expect(text.includes(canary), `output leaked ${canary}`).toBe(false);
};

describe('hosted TEST Location baseline: arguments', () => {
  it('LB-01a the three modes and their exact argument sets', () => {
    expect(parseCliArgs(ARGS.check).ok).toBe(true);
    expect(parseCliArgs(ARGS.dry).ok).toBe(true);
    const exec = parseCliArgs(ARGS.exec('a'.repeat(64)));
    expect(exec.ok).toBe(true);
    expect(exec.mode).toBe('execute');
    expect(Object.keys(exec.values).sort()).toEqual(['confirm', 'marker', 'plan', 'target']);
  });

  it('LB-01b only the literal target "test" is ever accepted, and it is mandatory', () => {
    for (const target of ['pilot', 'dev', 'demo', 'local', 'local-test', 'TEST', 'automated-test', '']) {
      expect(parseCliArgs(ARGS.check.map((a) => (a.startsWith('--target=') ? `--target=${target}` : a))).ok, target).toBe(false);
    }
    expect(parseCliArgs(ARGS.check.filter((a) => !a.startsWith('--target='))).ok).toBe(false);
    expect(parseCliArgs(ARGS.check.filter((a) => !a.startsWith('--marker-id='))).ok).toBe(false);
    expect(parseCliArgs([...ARGS.check.slice(0, 2), '--marker-id=nope']).ok).toBe(false);
  });

  it('LB-01c each mode refuses the arguments of another, and execute needs both the project ref and the plan', () => {
    const plan = 'a'.repeat(64);
    expect(parseCliArgs([...ARGS.check, `--plan=${plan}`]).ok).toBe(false);
    expect(parseCliArgs([...ARGS.dry, `--confirm-project-ref=${REF}`]).ok).toBe(false);
    expect(parseCliArgs([...ARGS.dry, `--plan=${plan}`]).ok).toBe(false);
    expect(parseCliArgs(ARGS.exec(plan).filter((a) => !a.startsWith('--confirm-project-ref='))).ok).toBe(false);
    expect(parseCliArgs(ARGS.exec(plan).filter((a) => !a.startsWith('--plan='))).ok).toBe(false);
    expect(parseCliArgs(ARGS.exec('short')).ok).toBe(false);
    expect(parseCliArgs(ARGS.exec('A'.repeat(64))).ok).toBe(false);
    expect(parseCliArgs([...ARGS.check, '--reset']).ok).toBe(false);
    expect(parseCliArgs([...ARGS.check, '--execute']).ok).toBe(false);
    expect(parseCliArgs([]).ok).toBe(false);
  });
});

describe('hosted TEST Location baseline: classification', () => {
  const canonical = () => ({ ...TEST_COMPANY_BOOTSTRAP });

  it('LB-02a the clean slates: no Locations, with the test Company or with no Company at all', () => {
    expect(classifyLocationBaseline(facts(), canonical()).state).toBe('ABSENT_CLEAN');
    expect(classifyLocationBaseline(facts({ companies: [] }), canonical()).state).toBe('ABSENT_CLEAN');
  });

  it('LB-02b the baseline already in place: the test Company and exactly the six canonical Locations', () => {
    const verdict = classifyLocationBaseline(facts({ locations: locationsFor(TEST_COMPANY_BOOTSTRAP.id) }), canonical());
    expect(verdict.state).toBe('ALREADY_CANONICAL');
    expect(CANONICAL_BRANCH_CODES).toEqual(['BAN', 'CEN', 'CON', 'DEP', 'TV', 'YB']);
  });

  it('LB-02c anything else is refused, with a code, and never repaired', () => {
    const six = locationsFor(TEST_COMPANY_BOOTSTRAP.id);
    const demo: Company = { id: '00000000-0000-4000-9000-000000000001', name: 'Mona Jacinta (demo)', cuit: '00-00000000-0', address: 'Dirección legal demo — pendiente de dato real' };
    const refused: Record<string, [Facts, string]> = {
      'the demo Company': [facts({ companies: [demo] }), 'COMPANY_UNEXPECTED'],
      'a test Company with another cuit': [facts({ companies: [{ ...testCompany(), cuit: '00-99999999-9' }] }), 'COMPANY_UNEXPECTED'],
      'a test Company with another name': [facts({ companies: [{ ...testCompany(), name: 'Other' }] }), 'COMPANY_UNEXPECTED'],
      'two Companies': [facts({ companies: [testCompany(), demo] }), 'COMPANY_AMBIGUOUS'],
      'only five Branches': [facts({ branches: branches().slice(0, 5) }), 'BRANCH_STATE_UNEXPECTED'],
      'a seventh Branch': [facts({ branches: [...branches(), { id: 'x', code: 'ZZZ', name: 'Z', address: null, pointOfSaleNumber: 7 }] }), 'BRANCH_STATE_UNEXPECTED'],
      'a renamed Branch code': [facts({ branches: branches().map((b, i) => (i === 0 ? { ...b, code: 'XXX' } : b)) }), 'BRANCH_STATE_UNEXPECTED'],
      'three Locations only': [facts({ locations: six.slice(0, 3) }), 'LOCATION_STATE_UNEXPECTED'],
      'seven Locations': [facts({ locations: [...six, { ...six[0]!, id: 'zz', code: 'FACTORY-1', pointOfSaleNumber: 99 }] }), 'LOCATION_STATE_UNEXPECTED'],
      'a Location with another id': [facts({ locations: six.map((l, i) => (i === 1 ? { ...l, id: '00000000-0000-4000-8000-0000000009ff' } : l)) }), 'LOCATION_STATE_UNEXPECTED'],
      'a Location of another Company': [facts({ locations: six.map((l, i) => (i === 2 ? { ...l, companyId: demo.id } : l)) }), 'LOCATION_STATE_UNEXPECTED'],
      'a Location with the wrong type': [facts({ locations: six.map((l, i) => (i === 5 ? { ...l, type: 'RETAIL_BRANCH' } : l)) }), 'LOCATION_STATE_UNEXPECTED'],
      'a Location with another POS number': [facts({ locations: six.map((l, i) => (i === 0 ? { ...l, pointOfSaleNumber: 42 } : l)) }), 'LOCATION_STATE_UNEXPECTED'],
      'six Locations but no Company': [facts({ companies: [], locations: six }), 'LOCATION_STATE_UNEXPECTED'],
    };
    for (const [name, [input, code]] of Object.entries(refused)) {
      const verdict = classifyLocationBaseline(input, canonical());
      expect(verdict.state, name).toBe('REFUSED');
      expect(verdict.code, name).toBe(code);
    }
  });
});

describe('hosted TEST Location baseline: plan and dry-run', () => {
  it('LB-03a the dry-run opens no database and prints a deterministic plan', async () => {
    const world = makeWorld();
    const first = await planOf(world);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(world.state.opens).toBe(0);
    expect(world.state.backfills).toHaveLength(0);
    const result = world.last();
    expect(result.format).toBe(RESULT_FORMAT);
    expect(result.mode).toBe('dry-run');
    expect((result.plan as { format: string }).format).toBe(PLAN_FORMAT);
    expect(await planOf(makeWorld())).toBe(first);
    noSecrets(world);
  });

  it('LB-03b the plan changes with the tool bytes, the target and the marker', async () => {
    const base = await planOf(makeWorld());
    const digests = new Set([
      base,
      await planOf(makeWorld({ tooling: [{ file: 'hosted-test-location-baseline.ts', sha256: sha('edited') }] })),
      await planOf(makeWorld({ config: CONFIG.replace(REF, 'zzzzzzzzzzzzzzzzzzzz') })),
      await (async () => {
        const other = '4b1c2d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d';
        const world = makeWorld({ config: CONFIG.replace(MARKER, other) });
        expect(await main(ARGS.dry.map((a) => (a.startsWith('--marker-id=') ? `--marker-id=${other}` : a)), world.deps)).toBe(0);
        return world.last().planDigest as string;
      })(),
    ]);
    expect(digests.size).toBe(4);
  });

  it('LB-03c buildPlan is pure and carries the Company identity digest, never the Company text or any secret', () => {
    const inputs = { company: testCompany(), tooling: [{ file: 'a.ts', sha256: sha('a') }], targetDigest: 't'.repeat(64), markerDigest: 'm'.repeat(64) };
    const a = buildPlan(inputs);
    expect(a.digest).toBe(buildPlan(JSON.parse(JSON.stringify(inputs))).digest);
    expect(a.document.format).toBe(PLAN_FORMAT);
    expect(JSON.stringify(a.document)).not.toContain(TEST_COMPANY_BOOTSTRAP.cuit);
    expect(buildPlan({ ...inputs, company: { ...testCompany(), cuit: '00-99999999-9' } }).digest).not.toBe(a.digest);
  });
});

describe('hosted TEST Location baseline: nothing else than the canonical TEST can be reached', () => {
  it('LB-04 a contaminated environment is refused before the config is read or any database is opened', async () => {
    for (const name of ['DATABASE_URL', 'PILOT_DATABASE_URL', 'LOCAL_TEST_DATABASE_URL', 'MONA_TEST_DATABASE_TARGET', 'MONA_D5H_PINNED_TEST_TARGET', 'TEST_DATABASE_URL', 'PGHOST', 'NODE_OPTIONS']) {
      const world = makeWorld({ env: { PATH: '/usr/bin', [name]: 'postgresql://u:SECRETVALUE@h/d' } });
      expect(await main(ARGS.check, world.deps), name).toBe(1);
      expect([world.last().phase, world.last().code]).toEqual(['env', 'ENV_FORBIDDEN']);
      expect(world.state.opens).toBe(0);
      expect([...world.state.out, ...world.state.err].join('\n')).not.toContain('SECRETVALUE');
    }
  });

  it('LB-05 an invalid configuration, a wrong marker-id or a wrong project ref opens nothing', async () => {
    for (const bad of [CONFIG.replace(HOST, 'localhost'), CONFIG.replace(HOST, `db.${REF}.supabase.co`), CONFIG.replace('/postgres\n', '/postgres?sslmode=disable\n'), new Error(`ENOENT ${PASSWORD}`)]) {
      const world = makeWorld({ config: bad });
      expect(await main(ARGS.check, world.deps)).toBe(1);
      expect(world.last().phase).toBe('config');
      expect(world.state.opens).toBe(0);
      noSecrets(world);
    }
    const world = makeWorld();
    expect(await main(ARGS.check.map((a) => (a.startsWith('--marker-id=') ? '--marker-id=4b1c2d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d' : a)), world.deps)).toBe(1);
    expect([world.last().phase, world.last().code]).toEqual(['confirm', 'MARKER_ARG_MISMATCH']);
    const plan = await planOf(world);
    expect(await main(ARGS.exec(plan).map((a) => (a.startsWith('--confirm-project-ref=') ? '--confirm-project-ref=zzzzzzzzzzzzzzzzzzzz' : a)), world.deps)).toBe(1);
    expect([world.last().phase, world.last().code]).toEqual(['confirm', 'PROJECT_REF_MISMATCH']);
    expect(world.state.opens).toBe(0);
  });

  it('LB-06 the plan must be the one the dry-run printed; a wrong one never opens a database', async () => {
    const world = makeWorld();
    const plan = await planOf(world);
    for (const wrong of ['0'.repeat(64), plan.replace(/^./, plan[0] === 'a' ? 'b' : 'a')]) {
      expect(await main(ARGS.exec(wrong), world.deps)).toBe(1);
      expect([world.last().phase, world.last().code]).toEqual(['plan', 'PLAN_MISMATCH']);
    }
    expect(world.state.opens).toBe(0);
    const edited = makeWorld({ tooling: [{ file: 'hosted-test-location-baseline.ts', sha256: sha('edited later') }] });
    expect(await main(ARGS.exec(plan), edited.deps)).toBe(1);
    expect(edited.last().code).toBe('PLAN_MISMATCH');
  });

  it('LB-06b a connection failure is final: one attempt, a safe code, no fallback', async () => {
    const world = makeWorld({ open: async () => { throw Object.assign(new Error(`cannot connect to ${HOST} with ${PASSWORD}`), { code: 'ECONNREFUSED' }); } });
    expect(await main(ARGS.check, world.deps)).toBe(1);
    expect([world.last().phase, world.last().code]).toEqual(['connect', 'ECONNREFUSED']);
    expect(world.state.opens).toBe(1);
    noSecrets(world);
  });
});

describe('hosted TEST Location baseline: --check', () => {
  it('LB-07 reports the classification with zero writes and the database closed', async () => {
    const world = makeWorld();
    expect(await main(ARGS.check, world.deps)).toBe(0);
    expect(world.last()).toMatchObject({ mode: 'check', result: 'PASS', state: 'ABSENT_CLEAN' });
    expect(world.state.backfills).toHaveLength(0);
    expect(world.state.closes).toBe(world.state.opens);
    const refused = makeWorld({ facts: facts({ companies: [{ ...testCompany(), cuit: '00-99999999-9' }] }) });
    expect(await main(ARGS.check, refused.deps)).toBe(1);
    expect(refused.last()).toMatchObject({ result: 'FAIL', code: 'COMPANY_UNEXPECTED' });
  });
});

describe('hosted TEST Location baseline: --execute', () => {
  it('LB-08 from a clean slate: ONE backfill with the TEST Company, verified, protected counts unchanged, marker proven again', async () => {
    const world = makeWorld();
    const plan = await planOf(world);
    expect(await main(ARGS.exec(plan), world.deps)).toBe(0);
    const result = world.last();
    expect(result).toMatchObject({ mode: 'execute', result: 'PASS', initialState: 'ABSENT_CLEAN', finalState: 'ALREADY_CANONICAL', wrote: true, planDigest: plan });
    expect(world.state.backfills).toHaveLength(1);
    expect(world.state.backfills[0]).toEqual(TEST_COMPANY_BOOTSTRAP);
    expect(world.state.verifies).toBeGreaterThanOrEqual(1);
    expect(world.state.markerProofs).toBe(1);
    expect(result.protectedCounts).toEqual({ before: COUNTS, after: COUNTS });
    expect(result.locations).toBe(6);
    expect(world.state.closes).toBe(world.state.opens);
    noSecrets(world);
  });

  it('LB-09 a Company that does not exist yet is created by that same single call, only on a clean slate', async () => {
    const world = makeWorld({ facts: facts({ companies: [] }), after: facts({ locations: locationsFor(TEST_COMPANY_BOOTSTRAP.id) }) });
    expect(await main(ARGS.exec(await planOf(world)), world.deps)).toBe(0);
    expect(world.state.backfills).toHaveLength(1);
    expect(world.last().initialState).toBe('ABSENT_CLEAN');
  });

  it('LB-10 the second execute is idempotent: verified, nothing written, backfill never called', async () => {
    const world = makeWorld({ facts: facts({ locations: locationsFor(TEST_COMPANY_BOOTSTRAP.id) }) });
    const plan = await planOf(world);
    expect(await main(ARGS.exec(plan), world.deps)).toBe(0);
    expect(world.last()).toMatchObject({ result: 'PASS', initialState: 'ALREADY_CANONICAL', finalState: 'ALREADY_CANONICAL', wrote: false });
    expect(world.state.backfills).toHaveLength(0);
    expect(world.state.verifies).toBeGreaterThanOrEqual(1);
  });

  it('LB-11 every refused state writes nothing: the backfill is never called', async () => {
    const six = locationsFor(TEST_COMPANY_BOOTSTRAP.id);
    const demo: Company = { id: '00000000-0000-4000-9000-000000000001', name: 'Mona Jacinta (demo)', cuit: '00-00000000-0', address: 'x' };
    for (const input of [facts({ companies: [demo] }), facts({ companies: [testCompany(), demo] }), facts({ locations: six.slice(0, 2) }), facts({ branches: branches().slice(1) }), facts({ locations: six.map((l) => ({ ...l, companyId: demo.id })) })]) {
      const world = makeWorld({ facts: input });
      const plan = await planOf(world);
      expect(await main(ARGS.exec(plan), world.deps)).toBe(1);
      expect(world.last().phase).toBe('precheck');
      expect(world.state.backfills).toHaveLength(0);
      expect(world.state.closes).toBe(world.state.opens);
    }
  });

  it('LB-12 a failure inside the backfill is reported once, never retried, and the connection is closed', async () => {
    const world = makeWorld({ backfill: async () => { throw Object.assign(new Error(`write failed for ${HOST} ${PASSWORD}`), { code: '23505' }); } });
    const plan = await planOf(world);
    expect(await main(ARGS.exec(plan), world.deps)).toBe(1);
    expect([world.last().phase, world.last().code]).toEqual(['write', '23505']);
    expect(world.state.backfills).toHaveLength(1);
    expect(world.state.closes).toBe(world.state.opens);
    noSecrets(world);
  });

  it('LB-13 the postcheck is strict: a failing verification, a changed protected table, a wrong count or a lost marker is a FAIL', async () => {
    const cases: Array<[string, Parameters<typeof makeWorld>[0], string]> = [
      ['verifyBackfill not ok', { verify: () => ({ ok: false, issues: ['x'], locationCount: 6 }) }, 'VERIFY_FAILED'],
      ['users changed', { countsAfter: { ...COUNTS, user: 6 } }, 'PROTECTED_COUNTS_CHANGED'],
      ['permissions changed', { countsAfter: { ...COUNTS, permission: 49 } }, 'PROTECTED_COUNTS_CHANGED'],
      ['role scopes changed', { countsAfter: { ...COUNTS, userRoleScope: 3 } }, 'PROTECTED_COUNTS_CHANGED'],
      ['only five Locations came out', { after: facts({ locations: locationsFor(TEST_COMPANY_BOOTSTRAP.id).slice(0, 5) }) }, 'POSTCHECK_LOCATIONS'],
      ['the marker is gone', { marker: false }, 'MARKER_NOT_PROVEN'],
    ];
    for (const [name, options, code] of cases) {
      const world = makeWorld(options);
      const plan = await planOf(world);
      expect(await main(ARGS.exec(plan), world.deps), name).toBe(1);
      expect([world.last().phase, world.last().code], name).toEqual(['postcheck', code]);
      expect(world.state.backfills, name).toHaveLength(1);
    }
  });

  it('LB-14 the output is secret-free in every outcome', async () => {
    for (const options of [{}, { marker: false }, { facts: facts({ locations: locationsFor(TEST_COMPANY_BOOTSTRAP.id) }) }, { open: async () => { throw Object.assign(new Error(PASSWORD), { code: 'ECONNREFUSED' }); } }]) {
      const world = makeWorld(options);
      await main(ARGS.check, world.deps);
      await main(ARGS.exec(await planOf(world)), world.deps);
      noSecrets(world);
    }
  });
});

describe('hosted TEST Location baseline: static properties and defaults', () => {
  const SOURCE = readFileSync(new URL('../scripts/hosted-test-location-baseline.ts', import.meta.url), 'utf8');

  it('LB-15a it can never reach another target or run lifecycle code', () => {
    expect(SOURCE).not.toMatch(/pilot-marker|pilot-backup|pilot-launch|pilot-migrate|local-test-prepare|PILOT_DATABASE_URL|LOCAL_TEST_DATABASE_URL\s*[=:]/);
    expect(SOURCE).not.toMatch(/seedDemo|resetDemo|syncProductionRbacCatalog|bootstrapProductionRbacCatalog|backfill-company-location|createTestPrismaClient/);
    expect(SOURCE).not.toMatch(/'automated-test'|"automated-test"|openSeedDatabase\((?!\s*'test'\s*\))/);
    expect(SOURCE).not.toMatch(/process\.env/);
    expect(SOURCE).not.toMatch(/\$executeRaw|\$queryRaw|\$executeRawUnsafe|\$queryRawUnsafe|TRUNCATE|DROP\s+TABLE/i);
    expect(SOURCE).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/);
    expect((SOURCE.match(/backfillLocationsFromBranches/g) ?? []).length).toBeLessThanOrEqual(3);
  });

  it('LB-15b the production defaults are the real, shared functions and the canonical TEST Company', () => {
    const defaults = buildDefaultDeps();
    expect(defaults.company).toEqual(TEST_COMPANY_BOOTSTRAP);
    expect(defaults.backfill).toBe(backfillLocationsFromBranches);
    expect(typeof defaults.openDatabase).toBe('function');
    expect(typeof defaults.proveMarker).toBe('function');
    expect(TOOLING_FILES).toContain('api/scripts/hosted-test-location-baseline.ts');
  });

  it('LB-16 main: exit codes (0 pass, 1 refused/failed, 2 usage) and one JSON line per run', async () => {
    const world = makeWorld();
    expect(await main([], world.deps)).toBe(2);
    expect(world.last().code).toBe('ARGS_INVALID');
    expect(await main(['--target=pilot', '--check', `--marker-id=${MARKER}`], world.deps)).toBe(2);
    const before = world.state.out.length;
    expect(await main(ARGS.check, world.deps)).toBe(0);
    expect(world.state.out.length).toBe(before + 1);
  });
});

vi.setConfig({ testTimeout: 30000 });
