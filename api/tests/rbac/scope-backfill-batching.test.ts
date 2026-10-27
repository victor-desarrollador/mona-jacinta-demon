import { describe, expect, it } from 'vitest';
import {
  backfillUserRoleScopeFromUserBranchRole,
  syncUserRoleScopeFromUserBranchRole,
} from '../../src/modules/rbac/scope-backfill.service.js';

// D5F-C2A — DB-free structural regression for the O(N) scope-backfill
// transaction. D5F-C proved `syncUserRoleScopeFromUserBranchRole` performs
// one `userRoleScope.findFirst` + one `userRoleScope.create` PER ELIGIBLE
// legacy row inside a single interactive transaction under Prisma's default
// 5000 ms budget. Timing evidence, kept distinct: historical D5B3 recorded
// Prisma P2028 TRANSACTION elapsed ~5746 ms and ~5734 ms on hosted TEST; the
// D5F-C1B controlled comparison measured the same focused cases at
// ~3854–5226 ms TEST_WALL_TIME on hosted TEST vs ~27.5–31.9 ms TEST_WALL_TIME
// on LOCAL_TEST (test wall includes the beforeEach fixture work — it is NOT a
// direct transaction elapsed measurement). The structural fix is
// O(1)-in-N UserRoleScope DB operations (one batched read + at most one
// createMany, with the write's returned count fail-closed) plus an explicit
// maintenance transaction budget (the seed.ts precedent), with
// byte-identical business semantics.
//
// This suite never contacts a database: a deterministic fake database with
// observable delegate-call counters replaces Prisma. The single
// `as unknown as` seam per fake exists because the service's parameter types
// are Prisma-branded delegates (PrismaPromise returns) that a plain fake
// cannot structurally carry; the fake's behavior is asserted through the
// recorded calls below, not through the cast.
//
// Run DB-free via (repo root): node scripts/dev/safe-nodb-run.mjs
// api/tests/rbac/scope-backfill-batching.test.ts

type FakeScopeRow = {
  id: string;
  userId: string;
  roleId: string;
  scopeKind: 'LOCATION' | 'COMPANY';
  locationId: string | null;
};

type FakeLegacyRow = {
  id: string;
  userId: string;
  branchId: string;
  role: { code: string };
};

type FakeRole = { id: string; code: string };
type FakeLocation = { id: string };

type UserRoleScopeCall =
  | { op: 'findFirst'; where: Record<string, unknown> }
  | { op: 'findMany'; where: Record<string, unknown> }
  | { op: 'create'; data: Record<string, unknown> }
  | { op: 'createMany'; data: Record<string, unknown>[]; skipDuplicates?: boolean };

type UserBranchRoleCall = { op: string };

type FakeWorld = {
  legacy: FakeLegacyRow[];
  roles: FakeRole[];
  locations: FakeLocation[];
  scopes: FakeScopeRow[];
  failFindManyScopes?: Error;
  failCreateManyScopes?: Error;
  // Independent-review addendum (IR): delegate-level corruption knobs. None
  // of these represent states reachable through the normal schema path —
  // they exist to prove the sync fails closed against a lying delegate.
  createManyCountOverride?: number;
  scrambleFindMany?: boolean;
  duplicateFindManyRows?: boolean;
};

type CallSummary = { findMany: number; findFirst: number; createMany: number; create: number; total: number };

function buildFakeDb(world: FakeWorld) {
  const userRoleScopeCalls: UserRoleScopeCall[] = [];
  const userBranchRoleCalls: UserBranchRoleCall[] = [];
  const transactionCalls: { options: unknown }[] = [];
  const roleFindManyCalls: unknown[] = [];
  const locationFindManyCalls: unknown[] = [];
  let nextScopeSeq = 1;

  const scopeNaturalKey = (scope: FakeScopeRow) =>
    `${scope.userId}|${scope.roleId}|${scope.scopeKind}|${scope.locationId}`;

  const db = {
    userBranchRole: {
      findMany: async () => {
        userBranchRoleCalls.push({ op: 'findMany' });
        return [...world.legacy];
      },
      // Invariant G sentinels: UserBranchRole is read-only in the backfill.
      create: async () => {
        userBranchRoleCalls.push({ op: 'create' });
        throw new Error('UserBranchRole.create must never be invoked by the backfill');
      },
      update: async () => {
        userBranchRoleCalls.push({ op: 'update' });
        throw new Error('UserBranchRole.update must never be invoked by the backfill');
      },
      delete: async () => {
        userBranchRoleCalls.push({ op: 'delete' });
        throw new Error('UserBranchRole.delete must never be invoked by the backfill');
      },
      deleteMany: async () => {
        userBranchRoleCalls.push({ op: 'deleteMany' });
        throw new Error('UserBranchRole.deleteMany must never be invoked by the backfill');
      },
      upsert: async () => {
        userBranchRoleCalls.push({ op: 'upsert' });
        throw new Error('UserBranchRole.upsert must never be invoked by the backfill');
      },
    },
    role: {
      findMany: async (args: { where?: { code?: { in?: string[] } } }) => {
        roleFindManyCalls.push(args);
        return world.roles.filter((r) => args.where?.code?.in?.includes(r.code) ?? false);
      },
    },
    location: {
      findMany: async (args: { where?: { id?: { in?: string[] } } }) => {
        locationFindManyCalls.push(args);
        return world.locations.filter((l) => args.where?.id?.in?.includes(l.id) ?? false);
      },
    },
    userRoleScope: {
      // Faithful to the raw-SQL partial unique indexes: exact natural-key
      // matching, so COMPANY / wrong-location / wrong-role / wrong-user rows
      // can never satisfy a LOCATION target.
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        userRoleScopeCalls.push({ op: 'findFirst', where });
        const key = `${where.userId}|${where.roleId}|${where.scopeKind}|${where.locationId}`;
        return world.scopes.find((s) => scopeNaturalKey(s) === key) ?? null;
      },
      findMany: async ({ where }: { where?: { userId?: { in?: string[] } } }) => {
        userRoleScopeCalls.push({ op: 'findMany', where: where as Record<string, unknown> });
        if (world.failFindManyScopes) throw world.failFindManyScopes;
        const ids = where?.userId?.in;
        let rows = ids ? world.scopes.filter((s) => ids.includes(s.userId)) : [...world.scopes];
        if (world.duplicateFindManyRows) rows = rows.flatMap((row) => [row, { ...row }]);
        if (world.scrambleFindMany) rows = [...rows].reverse();
        return rows;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        userRoleScopeCalls.push({ op: 'create', data });
        const row = { ...(data as unknown as FakeScopeRow), id: `fake-scope-${nextScopeSeq++}` };
        world.scopes.push(row);
        return row;
      },
      createMany: async ({ data, skipDuplicates }: { data: Record<string, unknown>[]; skipDuplicates?: boolean }) => {
        userRoleScopeCalls.push({ op: 'createMany', data, skipDuplicates });
        if (world.failCreateManyScopes) throw world.failCreateManyScopes;
        // IR: a lying count is served without throwing so the sync's own
        // write-confirmation contract is what must reject it.
        if (world.createManyCountOverride !== undefined) return { count: world.createManyCountOverride };
        for (const item of data) {
          world.scopes.push({ ...(item as unknown as FakeScopeRow), id: `fake-scope-${nextScopeSeq++}` });
        }
        return { count: data.length };
      },
    },
    $transaction: async <R>(fn: (tx: unknown) => Promise<R>, options?: unknown): Promise<R> => {
      transactionCalls.push({ options });
      return fn(db);
    },
  };

  return { db, userRoleScopeCalls, userBranchRoleCalls, transactionCalls, roleFindManyCalls, locationFindManyCalls };
}

// The service's parameter types are Prisma-branded delegate Picks; a plain
// fake cannot carry PrismaPromise branding, so each fake crosses one
// documented structural seam. Everything past this seam is asserted through
// the recorded delegate calls above.
type SyncDb = Parameters<typeof syncUserRoleScopeFromUserBranchRole>[0];
type BackfillDb = Parameters<typeof backfillUserRoleScopeFromUserBranchRole>[0];

const asSyncDb = (fake: ReturnType<typeof buildFakeDb>) => fake.db as unknown as SyncDb;
const asBackfillDb = (fake: ReturnType<typeof buildFakeDb>) => fake.db as unknown as BackfillDb;

const PRODUCTION_ROLES: FakeRole[] = [
  { id: 'role-admin', code: 'ADMIN' },
  { id: 'role-cashier', code: 'CASHIER' },
  { id: 'role-seller', code: 'SELLER' },
  { id: 'role-manager', code: 'MANAGER' },
];

const ELIGIBLE_CODES = ['ADMIN', 'CASHIER', 'SELLER'] as const;

// N eligible legacy rows: distinct users/branches, cycling eligible codes.
function eligibleLegacyRows(n: number): FakeLegacyRow[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `legacy-${i}`,
    userId: `user-${i}`,
    branchId: `branch-${i}`,
    role: { code: ELIGIBLE_CODES[i % ELIGIBLE_CODES.length]! },
  }));
}

function locationsFor(rows: FakeLegacyRow[]): FakeLocation[] {
  return [...new Set(rows.map((r) => r.branchId))].map((id) => ({ id }));
}

// The exact LOCATION target a legacy row maps to (production role id per code).
const productionRoleIdByCode: Record<string, string> = {
  ADMIN: 'role-admin',
  CASHIER: 'role-cashier',
  SELLER: 'role-seller',
};

function exactScopeRow(row: FakeLegacyRow): FakeScopeRow {
  return {
    id: `existing-${row.id}`,
    userId: row.userId,
    roleId: productionRoleIdByCode[row.role.code]!,
    scopeKind: 'LOCATION',
    locationId: row.branchId,
  };
}

function targetKeyOf(data: Record<string, unknown>): string {
  return `${data.userId}|${data.roleId}|${data.scopeKind}|${data.locationId}`;
}

function ursSummary(calls: UserRoleScopeCall[]): CallSummary {
  const count = (op: UserRoleScopeCall['op']) => calls.filter((c) => c.op === op).length;
  return {
    findMany: count('findMany'),
    findFirst: count('findFirst'),
    createMany: count('createMany'),
    create: count('create'),
    total: calls.length,
  };
}

const expectNoUserBranchRoleMutation = (calls: UserBranchRoleCall[]) => {
  const mutations = calls.filter((c) => c.op !== 'findMany');
  expect(mutations).toEqual([]);
};

describe('UserRoleScope backfill batching (D5F-C2A structural O(N) fix, DB-free)', () => {
  it('P1: fresh N=1 — created=1/alreadyPresent=0, exactly one batched read + one createMany, zero per-row ops', async () => {
    const rows = eligibleLegacyRows(1);
    const world: FakeWorld = { legacy: rows, roles: PRODUCTION_ROLES, locations: locationsFor(rows), scopes: [] };
    const fake = buildFakeDb(world);

    const result = await syncUserRoleScopeFromUserBranchRole(asSyncDb(fake));

    expect(result).toEqual({ legacyRowCount: 1, eligibleRowCount: 1, deferredRowCount: 0, created: 1, alreadyPresent: 0 });
    expect(ursSummary(fake.userRoleScopeCalls)).toEqual({ findMany: 1, findFirst: 0, createMany: 1, create: 0, total: 2 });
    expectNoUserBranchRoleMutation(fake.userBranchRoleCalls);
  });

  it('P2/R5: fresh N=50 — correct counters and the SAME UserRoleScope call class as N=1', async () => {
    const rows = eligibleLegacyRows(50);
    const world: FakeWorld = { legacy: rows, roles: PRODUCTION_ROLES, locations: locationsFor(rows), scopes: [] };
    const fake = buildFakeDb(world);

    const result = await syncUserRoleScopeFromUserBranchRole(asSyncDb(fake));

    expect(result).toEqual({ legacyRowCount: 50, eligibleRowCount: 50, deferredRowCount: 0, created: 50, alreadyPresent: 0 });
    expect(ursSummary(fake.userRoleScopeCalls)).toEqual({ findMany: 1, findFirst: 0, createMany: 1, create: 0, total: 2 });
  });

  it('P3: all N targets already present — created=0/alreadyPresent=N, one read, zero createMany', async () => {
    const rows = eligibleLegacyRows(8);
    const world: FakeWorld = {
      legacy: rows,
      roles: PRODUCTION_ROLES,
      locations: locationsFor(rows),
      scopes: rows.map(exactScopeRow),
    };
    const fake = buildFakeDb(world);

    const result = await syncUserRoleScopeFromUserBranchRole(asSyncDb(fake));

    expect(result).toEqual({ legacyRowCount: 8, eligibleRowCount: 8, deferredRowCount: 0, created: 0, alreadyPresent: 8 });
    expect(ursSummary(fake.userRoleScopeCalls)).toEqual({ findMany: 1, findFirst: 0, createMany: 0, create: 0, total: 1 });
  });

  it('P4: mixed present/missing — exact counters and createMany contains EXACTLY the missing exact targets', async () => {
    const rows = eligibleLegacyRows(8);
    const presentRows = [rows[0]!, rows[3]!, rows[6]!];
    const missingRows = rows.filter((r) => !presentRows.includes(r));
    const world: FakeWorld = {
      legacy: rows,
      roles: PRODUCTION_ROLES,
      locations: locationsFor(rows),
      scopes: presentRows.map(exactScopeRow),
    };
    const fake = buildFakeDb(world);

    const result = await syncUserRoleScopeFromUserBranchRole(asSyncDb(fake));

    expect(result).toEqual({ legacyRowCount: 8, eligibleRowCount: 8, deferredRowCount: 0, created: 5, alreadyPresent: 3 });

    const createManyCalls = fake.userRoleScopeCalls.filter((c) => c.op === 'createMany');
    expect(createManyCalls).toHaveLength(1);
    const written = createManyCalls[0]!.data.map(targetKeyOf).sort();
    const expected = missingRows.map((r) => targetKeyOf(exactScopeRow(r) as unknown as Record<string, unknown>)).sort();
    expect(written).toEqual(expected);
  });

  it('P5: an existing COMPANY scope for the same user+role does NOT satisfy a LOCATION target', async () => {
    const rows = eligibleLegacyRows(1);
    const companyScope: FakeScopeRow = {
      id: 'company-scope',
      userId: rows[0]!.userId,
      roleId: productionRoleIdByCode[rows[0]!.role.code]!,
      scopeKind: 'COMPANY',
      locationId: null,
    };
    const world: FakeWorld = {
      legacy: rows,
      roles: PRODUCTION_ROLES,
      locations: locationsFor(rows),
      scopes: [companyScope],
    };
    const fake = buildFakeDb(world);

    const result = await syncUserRoleScopeFromUserBranchRole(asSyncDb(fake));

    expect(result).toEqual({ legacyRowCount: 1, eligibleRowCount: 1, deferredRowCount: 0, created: 1, alreadyPresent: 0 });
    expect(world.scopes).toHaveLength(2); // COMPANY row untouched, LOCATION row created
    expect(world.scopes.filter((s) => s.scopeKind === 'LOCATION')).toHaveLength(1);
  });

  it('P6: a LOCATION scope at the WRONG location does not satisfy the target (nor wrong role, nor wrong user)', async () => {
    const rows = eligibleLegacyRows(3);
    const decoys: FakeScopeRow[] = [
      { id: 'wrong-location', userId: rows[0]!.userId, roleId: productionRoleIdByCode[rows[0]!.role.code]!, scopeKind: 'LOCATION', locationId: 'branch-elsewhere' },
      { id: 'wrong-role', userId: rows[1]!.userId, roleId: 'role-manager', scopeKind: 'LOCATION', locationId: rows[1]!.branchId },
      { id: 'wrong-user', userId: 'someone-else', roleId: productionRoleIdByCode[rows[2]!.role.code]!, scopeKind: 'LOCATION', locationId: rows[2]!.branchId },
    ];
    const world: FakeWorld = { legacy: rows, roles: PRODUCTION_ROLES, locations: locationsFor(rows), scopes: decoys };
    const fake = buildFakeDb(world);

    const result = await syncUserRoleScopeFromUserBranchRole(asSyncDb(fake));

    expect(result).toEqual({ legacyRowCount: 3, eligibleRowCount: 3, deferredRowCount: 0, created: 3, alreadyPresent: 0 });
  });

  it('P7: DEFERRED MANAGER rows produce no target, no write, and no UserRoleScope read', async () => {
    const managerRows: FakeLegacyRow[] = [
      { id: 'manager-1', userId: 'manager-user', branchId: 'branch-0', role: { code: 'MANAGER' } },
      { id: 'manager-2', userId: 'manager-user-2', branchId: 'branch-1', role: { code: 'MANAGER' } },
    ];
    const world: FakeWorld = {
      legacy: managerRows,
      roles: PRODUCTION_ROLES,
      locations: locationsFor(managerRows),
      scopes: [],
    };
    const fake = buildFakeDb(world);

    const result = await syncUserRoleScopeFromUserBranchRole(asSyncDb(fake));

    expect(result).toEqual({ legacyRowCount: 2, eligibleRowCount: 0, deferredRowCount: 2, created: 0, alreadyPresent: 0 });
    expect(ursSummary(fake.userRoleScopeCalls)).toEqual({ findMany: 0, findFirst: 0, createMany: 0, create: 0, total: 0 });
  });

  it('P8: an unknown legacy role code fails closed BEFORE any UserRoleScope operation', async () => {
    const rows: FakeLegacyRow[] = [
      { id: 'ghost', userId: 'user-0', branchId: 'branch-0', role: { code: 'GHOST' } },
      ...eligibleLegacyRows(1).map((r) => ({ ...r, id: `${r.id}-ok` })),
    ];
    const world: FakeWorld = { legacy: rows, roles: PRODUCTION_ROLES, locations: locationsFor(rows), scopes: [] };
    const fake = buildFakeDb(world);

    await expect(syncUserRoleScopeFromUserBranchRole(asSyncDb(fake))).rejects.toThrow(
      /No explicit Production role mapping or deferral/,
    );
    expect(fake.userRoleScopeCalls).toEqual([]);
    expect(world.scopes).toEqual([]);
  });

  it('P9: a missing Production Role fails closed BEFORE any UserRoleScope operation', async () => {
    const rows = eligibleLegacyRows(3);
    const world: FakeWorld = {
      legacy: rows,
      roles: PRODUCTION_ROLES.filter((r) => r.code !== 'SELLER'), // SELLER row present, role missing
      locations: locationsFor(rows),
      scopes: [],
    };
    const fake = buildFakeDb(world);

    await expect(syncUserRoleScopeFromUserBranchRole(asSyncDb(fake))).rejects.toThrow(/Production Role\(s\) SELLER do not exist/);
    expect(fake.userRoleScopeCalls).toEqual([]);
  });

  it('P10: a missing Location for an ELIGIBLE row fails closed BEFORE any UserRoleScope operation', async () => {
    const rows = eligibleLegacyRows(3);
    const world: FakeWorld = {
      legacy: rows,
      roles: PRODUCTION_ROLES,
      locations: locationsFor(rows).filter((l) => l.id !== rows[2]!.branchId),
      scopes: [],
    };
    const fake = buildFakeDb(world);

    await expect(syncUserRoleScopeFromUserBranchRole(asSyncDb(fake))).rejects.toThrow(/Location row\(s\) missing/);
    expect(fake.userRoleScopeCalls).toEqual([]);
  });

  it('P11: a missing Location belonging ONLY to a DEFERRED MANAGER row never blocks readiness', async () => {
    const eligible = eligibleLegacyRows(2);
    const managerRow: FakeLegacyRow = { id: 'manager', userId: 'manager-user', branchId: 'branch-manager-only', role: { code: 'MANAGER' } };
    const rows = [...eligible, managerRow];
    const world: FakeWorld = {
      legacy: rows,
      roles: PRODUCTION_ROLES,
      locations: locationsFor(eligible), // manager's branch deliberately absent
      scopes: [],
    };
    const fake = buildFakeDb(world);

    const result = await syncUserRoleScopeFromUserBranchRole(asSyncDb(fake));

    expect(result).toEqual({ legacyRowCount: 3, eligibleRowCount: 2, deferredRowCount: 1, created: 2, alreadyPresent: 0 });
  });

  it('P12: a createMany failure propagates — no suppression, no silent skip', async () => {
    const rows = eligibleLegacyRows(4);
    const world: FakeWorld = {
      legacy: rows,
      roles: PRODUCTION_ROLES,
      locations: locationsFor(rows),
      scopes: [],
      failCreateManyScopes: new Error('simulated unique conflict / createMany failure'),
    };
    const fake = buildFakeDb(world);

    await expect(syncUserRoleScopeFromUserBranchRole(asSyncDb(fake))).rejects.toThrow(/createMany failure/);
    expect(fake.userRoleScopeCalls.filter((c) => c.op === 'createMany')).toHaveLength(1);
    expect(world.scopes).toEqual([]);
  });

  it('P13: UserBranchRole mutation delegates are never invoked anywhere in the backfill', async () => {
    const rows = [...eligibleLegacyRows(3), { id: 'manager', userId: 'm', branchId: 'branch-0', role: { code: 'MANAGER' } }];
    const world: FakeWorld = { legacy: rows, roles: PRODUCTION_ROLES, locations: locationsFor(rows), scopes: [] };
    const fake = buildFakeDb(world);

    await syncUserRoleScopeFromUserBranchRole(asSyncDb(fake));
    expectNoUserBranchRoleMutation(fake.userBranchRoleCalls);

    await backfillUserRoleScopeFromUserBranchRole(asBackfillDb(fake));
    expectNoUserBranchRoleMutation(fake.userBranchRoleCalls);
  });

  it('P14: the standalone entry point wraps the sync in EXACTLY ONE transaction', async () => {
    const rows = eligibleLegacyRows(5);
    const world: FakeWorld = { legacy: rows, roles: PRODUCTION_ROLES, locations: locationsFor(rows), scopes: [] };
    const fake = buildFakeDb(world);

    const result = await backfillUserRoleScopeFromUserBranchRole(asBackfillDb(fake));

    expect(result).toEqual({ legacyRowCount: 5, eligibleRowCount: 5, deferredRowCount: 0, created: 5, alreadyPresent: 0 });
    expect(fake.transactionCalls).toHaveLength(1);
  });

  it('P15/R6: the standalone transaction receives the explicit seed.ts maintenance budget verbatim', async () => {
    const rows = eligibleLegacyRows(1);
    const world: FakeWorld = { legacy: rows, roles: PRODUCTION_ROLES, locations: locationsFor(rows), scopes: [] };
    const fake = buildFakeDb(world);

    await backfillUserRoleScopeFromUserBranchRole(asBackfillDb(fake));

    expect(fake.transactionCalls).toEqual([{ options: { maxWait: 10_000, timeout: 120_000 } }]);
  });

  it('no skipDuplicates is ever passed to createMany (concurrent conflicts must fail the transaction)', async () => {
    const rows = eligibleLegacyRows(6);
    const world: FakeWorld = { legacy: rows, roles: PRODUCTION_ROLES, locations: locationsFor(rows), scopes: [] };
    const fake = buildFakeDb(world);

    await syncUserRoleScopeFromUserBranchRole(asSyncDb(fake));

    const createManyCalls = fake.userRoleScopeCalls.filter((c) => c.op === 'createMany');
    expect(createManyCalls).toHaveLength(1);
    expect(createManyCalls[0]!.skipDuplicates).toBeUndefined();
  });

  it('AC1: zero legacy rows — all counters zero, zero UserRoleScope operations', async () => {
    const world: FakeWorld = { legacy: [], roles: PRODUCTION_ROLES, locations: [], scopes: [] };
    const fake = buildFakeDb(world);

    const result = await syncUserRoleScopeFromUserBranchRole(asSyncDb(fake));

    expect(result).toEqual({ legacyRowCount: 0, eligibleRowCount: 0, deferredRowCount: 0, created: 0, alreadyPresent: 0 });
    expect(fake.userRoleScopeCalls).toEqual([]);
  });

  it('AC11: one user holding the same role across many locations — all targets land in ONE createMany', async () => {
    const rows: FakeLegacyRow[] = Array.from({ length: 6 }, (_, i) => ({
      id: `admin-${i}`,
      userId: 'the-admin',
      branchId: `branch-${i}`,
      role: { code: 'ADMIN' },
    }));
    const world: FakeWorld = { legacy: rows, roles: PRODUCTION_ROLES, locations: locationsFor(rows), scopes: [] };
    const fake = buildFakeDb(world);

    const result = await syncUserRoleScopeFromUserBranchRole(asSyncDb(fake));

    expect(result).toEqual({ legacyRowCount: 6, eligibleRowCount: 6, deferredRowCount: 0, created: 6, alreadyPresent: 0 });
    expect(ursSummary(fake.userRoleScopeCalls)).toEqual({ findMany: 1, findFirst: 0, createMany: 1, create: 0, total: 2 });
  });

  it('AC13/AC14: duplicate legacy rows for the same (user, role, branch) keep per-row counter semantics', async () => {
    const duplicated: FakeLegacyRow[] = [
      { id: 'dup-a', userId: 'user-x', branchId: 'branch-1', role: { code: 'SELLER' } },
      { id: 'dup-b', userId: 'user-x', branchId: 'branch-1', role: { code: 'SELLER' } },
    ];

    // Target absent: exactly one write; the sibling row counts as alreadyPresent
    // (the second row observes the first row's landed scope — per-row semantics).
    const freshWorld: FakeWorld = { legacy: duplicated, roles: PRODUCTION_ROLES, locations: locationsFor(duplicated), scopes: [] };
    const freshFake = buildFakeDb(freshWorld);
    const fresh = await syncUserRoleScopeFromUserBranchRole(asSyncDb(freshFake));
    expect(fresh).toEqual({ legacyRowCount: 2, eligibleRowCount: 2, deferredRowCount: 0, created: 1, alreadyPresent: 1 });
    expect(ursSummary(freshFake.userRoleScopeCalls)).toEqual({ findMany: 1, findFirst: 0, createMany: 1, create: 0, total: 2 });

    // Target already present: both rows count as alreadyPresent, zero writes.
    const presentWorld: FakeWorld = {
      legacy: duplicated,
      roles: PRODUCTION_ROLES,
      locations: locationsFor(duplicated),
      scopes: [exactScopeRow(duplicated[0]!)],
    };
    const presentFake = buildFakeDb(presentWorld);
    const present = await syncUserRoleScopeFromUserBranchRole(asSyncDb(presentFake));
    expect(present).toEqual({ legacyRowCount: 2, eligibleRowCount: 2, deferredRowCount: 0, created: 0, alreadyPresent: 2 });
  });

  it('AC20: a batched findMany failure propagates — no suppression', async () => {
    const rows = eligibleLegacyRows(2);
    const world: FakeWorld = {
      legacy: rows,
      roles: PRODUCTION_ROLES,
      locations: locationsFor(rows),
      scopes: [],
      failFindManyScopes: new Error('simulated batched read failure'),
    };
    const fake = buildFakeDb(world);

    await expect(syncUserRoleScopeFromUserBranchRole(asSyncDb(fake))).rejects.toThrow(/batched read failure/);
  });

  it('AC21: a throw inside the transaction callback rejects the standalone entry point (no swallow)', async () => {
    const rows: FakeLegacyRow[] = [{ id: 'ghost', userId: 'u', branchId: 'b', role: { code: 'GHOST' } }];
    const world: FakeWorld = { legacy: rows, roles: PRODUCTION_ROLES, locations: locationsFor(rows), scopes: [] };
    const fake = buildFakeDb(world);

    await expect(backfillUserRoleScopeFromUserBranchRole(asBackfillDb(fake))).rejects.toThrow(
      /No explicit Production role mapping or deferral/,
    );
    expect(fake.transactionCalls).toHaveLength(1);
  });

  it('AC27: mixed ELIGIBLE + DEFERRED fixture (D2.1 shape) — only eligible targets written, MANAGER deferred', async () => {
    const eligible = eligibleLegacyRows(8);
    const managerRow: FakeLegacyRow = { id: 'manager', userId: 'manager01', branchId: 'branch-0', role: { code: 'MANAGER' } };
    const rows = [...eligible, managerRow];
    const world: FakeWorld = { legacy: rows, roles: PRODUCTION_ROLES, locations: locationsFor(rows), scopes: [] };
    const fake = buildFakeDb(world);

    const result = await syncUserRoleScopeFromUserBranchRole(asSyncDb(fake));

    expect(result).toEqual({ legacyRowCount: 9, eligibleRowCount: 8, deferredRowCount: 1, created: 8, alreadyPresent: 0 });
    const createManyCalls = fake.userRoleScopeCalls.filter((c) => c.op === 'createMany');
    expect(createManyCalls).toHaveLength(1);
    expect(createManyCalls[0]!.data).toHaveLength(8);
    expect(createManyCalls[0]!.data.some((d) => d.userId === 'manager01')).toBe(false);
  });

  it('AC26: idempotent re-run — second pass reports every eligible row as alreadyPresent, zero writes', async () => {
    const rows = eligibleLegacyRows(7);
    const world: FakeWorld = { legacy: rows, roles: PRODUCTION_ROLES, locations: locationsFor(rows), scopes: [] };
    const fake = buildFakeDb(world);

    const first = await syncUserRoleScopeFromUserBranchRole(asSyncDb(fake));
    expect(first).toEqual({ legacyRowCount: 7, eligibleRowCount: 7, deferredRowCount: 0, created: 7, alreadyPresent: 0 });

    const second = await syncUserRoleScopeFromUserBranchRole(asSyncDb(fake));
    expect(second).toEqual({ legacyRowCount: 7, eligibleRowCount: 7, deferredRowCount: 0, created: 0, alreadyPresent: 7 });
    expect(fake.userRoleScopeCalls.filter((c) => c.op === 'createMany')).toHaveLength(1); // only the first pass wrote
  });
});

describe('independent review addendum — reviewer adversarial cases (IR01–IR14, DB-free)', () => {
  const IN_KEY = (call: { op: string; where?: Record<string, unknown> }) =>
    ((call.where as { userId?: { in?: string[] } })?.userId?.in ?? []) as string[];

  it('IR01: same user with ADMIN and SELLER at the SAME location — two distinct targets, neither satisfies the other', async () => {
    const rows: FakeLegacyRow[] = [
      { id: 'admin-1', userId: 'u1', branchId: 'loc-1', role: { code: 'ADMIN' } },
      { id: 'seller-1', userId: 'u1', branchId: 'loc-1', role: { code: 'SELLER' } },
    ];
    const world: FakeWorld = { legacy: rows, roles: PRODUCTION_ROLES, locations: locationsFor(rows), scopes: [] };
    const fake = buildFakeDb(world);

    const result = await syncUserRoleScopeFromUserBranchRole(asSyncDb(fake));

    expect(result).toEqual({ legacyRowCount: 2, eligibleRowCount: 2, deferredRowCount: 0, created: 2, alreadyPresent: 0 });
    const written = fake.userRoleScopeCalls.filter((c) => c.op === 'createMany')[0]!.data.map(targetKeyOf).sort();
    expect(written).toEqual(['u1|role-admin|LOCATION|loc-1', 'u1|role-seller|LOCATION|loc-1']);
  });

  it('IR02: same user with ADMIN/CASHIER/SELLER across mixed locations — exact unique targets only, no cross-role matches', async () => {
    const rows: FakeLegacyRow[] = [
      { id: 'a', userId: 'u1', branchId: 'locA', role: { code: 'ADMIN' } },
      { id: 'c', userId: 'u1', branchId: 'locA', role: { code: 'CASHIER' } },
      { id: 's', userId: 'u1', branchId: 'locB', role: { code: 'SELLER' } },
    ];
    const decoy: FakeScopeRow = { id: 'decoy', userId: 'u1', roleId: 'role-cashier', scopeKind: 'LOCATION', locationId: 'locB' };
    const world: FakeWorld = { legacy: rows, roles: PRODUCTION_ROLES, locations: locationsFor(rows), scopes: [decoy] };
    const fake = buildFakeDb(world);

    const result = await syncUserRoleScopeFromUserBranchRole(asSyncDb(fake));

    expect(result).toEqual({ legacyRowCount: 3, eligibleRowCount: 3, deferredRowCount: 0, created: 3, alreadyPresent: 0 });
    const written = fake.userRoleScopeCalls.filter((c) => c.op === 'createMany')[0]!.data.map(targetKeyOf).sort();
    expect(written).toEqual(['u1|role-admin|LOCATION|locA', 'u1|role-cashier|LOCATION|locA', 'u1|role-seller|LOCATION|locB']);
  });

  it('IR03: a user with many unrelated scopes plus exactly one correct target — only the exact one counts alreadyPresent', async () => {
    const rows: FakeLegacyRow[] = [
      { id: 'cashier', userId: 'u1', branchId: 'loc-1', role: { code: 'CASHIER' } },
      { id: 'seller', userId: 'u2', branchId: 'loc-2', role: { code: 'SELLER' } },
    ];
    const scopes: FakeScopeRow[] = [
      { id: 'company', userId: 'u1', roleId: 'role-admin', scopeKind: 'COMPANY', locationId: null },
      { id: 'wrong-loc', userId: 'u1', roleId: 'role-cashier', scopeKind: 'LOCATION', locationId: 'elsewhere' },
      { id: 'wrong-role', userId: 'u1', roleId: 'role-manager', scopeKind: 'LOCATION', locationId: 'loc-1' },
      { id: 'exact', userId: 'u1', roleId: 'role-cashier', scopeKind: 'LOCATION', locationId: 'loc-1' },
    ];
    const world: FakeWorld = { legacy: rows, roles: PRODUCTION_ROLES, locations: locationsFor(rows), scopes };
    const fake = buildFakeDb(world);

    const result = await syncUserRoleScopeFromUserBranchRole(asSyncDb(fake));

    expect(result).toEqual({ legacyRowCount: 2, eligibleRowCount: 2, deferredRowCount: 0, created: 1, alreadyPresent: 1 });
  });

  it('IR04: findMany serving relevant scopes in reversed order — identical result and counters', async () => {
    const rows = eligibleLegacyRows(8);
    const present = [rows[0]!, rows[1]!, rows[2]!, rows[3]!].map(exactScopeRow);

    const plainWorld: FakeWorld = { legacy: rows, roles: PRODUCTION_ROLES, locations: locationsFor(rows), scopes: [...present] };
    const plain = await syncUserRoleScopeFromUserBranchRole(asSyncDb(buildFakeDb(plainWorld)));

    const scrambledWorld: FakeWorld = {
      legacy: rows,
      roles: PRODUCTION_ROLES,
      locations: locationsFor(rows),
      scopes: [...present].reverse(),
      scrambleFindMany: true,
    };
    const scrambledFake = buildFakeDb(scrambledWorld);
    const scrambled = await syncUserRoleScopeFromUserBranchRole(asSyncDb(scrambledFake));

    expect(scrambled).toEqual(plain);
    expect(scrambled).toEqual({ legacyRowCount: 8, eligibleRowCount: 8, deferredRowCount: 0, created: 4, alreadyPresent: 4 });
  });

  it('IR05: findMany returning duplicate copies of the same exact scope stays deterministic and writes nothing extra', async () => {
    const rows = eligibleLegacyRows(3);
    const present = [exactScopeRow(rows[0]!)];
    const world: FakeWorld = {
      legacy: rows,
      roles: PRODUCTION_ROLES,
      locations: locationsFor(rows),
      scopes: present,
      duplicateFindManyRows: true,
    };
    const fake = buildFakeDb(world);

    const result = await syncUserRoleScopeFromUserBranchRole(asSyncDb(fake));

    // Note: duplicate scope rows are unreachable through the normal schema
    // path (raw-SQL partial unique indexes); the fake serves them only to
    // prove the in-memory key Set keeps the outcome deterministic.
    expect(result).toEqual({ legacyRowCount: 3, eligibleRowCount: 3, deferredRowCount: 0, created: 2, alreadyPresent: 1 });
    expect(fake.userRoleScopeCalls.filter((c) => c.op === 'createMany')).toHaveLength(1);
  });

  it('IR06: createMany returning count = missing.length − 1 (no throw) must FAIL CLOSED', async () => {
    const rows = eligibleLegacyRows(5);
    const world: FakeWorld = {
      legacy: rows,
      roles: PRODUCTION_ROLES,
      locations: locationsFor(rows),
      scopes: [],
      createManyCountOverride: 4, // lying short count, no exception from the delegate
    };
    const fake = buildFakeDb(world);

    await expect(syncUserRoleScopeFromUserBranchRole(asSyncDb(fake))).rejects.toThrow(
      /inserted 4 row\(s\) but 5 were intended/,
    );
  });

  it('IR07: createMany returning count = missing.length + 1 must FAIL CLOSED', async () => {
    const rows = eligibleLegacyRows(5);
    const world: FakeWorld = {
      legacy: rows,
      roles: PRODUCTION_ROLES,
      locations: locationsFor(rows),
      scopes: [],
      createManyCountOverride: 6, // lying long count, no exception from the delegate
    };
    const fake = buildFakeDb(world);

    await expect(syncUserRoleScopeFromUserBranchRole(asSyncDb(fake))).rejects.toThrow(
      /inserted 6 row\(s\) but 5 were intended/,
    );
  });

  it('IR08: duplicate legacy rows mapping to one missing target — createMany DATA contains that target exactly once', async () => {
    const duplicated: FakeLegacyRow[] = [
      { id: 'dup-a', userId: 'u1', branchId: 'loc-1', role: { code: 'SELLER' } },
      { id: 'dup-b', userId: 'u1', branchId: 'loc-1', role: { code: 'SELLER' } },
      { id: 'dup-c', userId: 'u1', branchId: 'loc-1', role: { code: 'SELLER' } },
    ];
    const world: FakeWorld = { legacy: duplicated, roles: PRODUCTION_ROLES, locations: locationsFor(duplicated), scopes: [] };
    const fake = buildFakeDb(world);

    const result = await syncUserRoleScopeFromUserBranchRole(asSyncDb(fake));

    expect(result).toEqual({ legacyRowCount: 3, eligibleRowCount: 3, deferredRowCount: 0, created: 1, alreadyPresent: 2 });
    const createManyCalls = fake.userRoleScopeCalls.filter((c) => c.op === 'createMany');
    expect(createManyCalls).toHaveLength(1);
    const targetKey = 'u1|role-seller|LOCATION|loc-1';
    expect(createManyCalls[0]!.data.map(targetKeyOf).filter((k) => k === targetKey)).toHaveLength(1);
  });

  it('IR09: 50 eligible rows for ONE user — the batched read IN list contains that user exactly once', async () => {
    const rows: FakeLegacyRow[] = Array.from({ length: 50 }, (_, i) => ({
      id: `r-${i}`,
      userId: 'the-one-user',
      branchId: `branch-${i}`,
      role: { code: ELIGIBLE_CODES[i % ELIGIBLE_CODES.length]! },
    }));
    const world: FakeWorld = { legacy: rows, roles: PRODUCTION_ROLES, locations: locationsFor(rows), scopes: [] };
    const fake = buildFakeDb(world);

    const result = await syncUserRoleScopeFromUserBranchRole(asSyncDb(fake));

    expect(result.created).toBe(50);
    const reads = fake.userRoleScopeCalls.filter((c) => c.op === 'findMany');
    expect(reads).toHaveLength(1);
    expect(IN_KEY(reads[0]!)).toEqual(['the-one-user']);
  });

  it('IR10: 50 eligible rows for 50 users — one findMany with 50 distinct IN values, at most one createMany', async () => {
    const rows = eligibleLegacyRows(50);
    const world: FakeWorld = { legacy: rows, roles: PRODUCTION_ROLES, locations: locationsFor(rows), scopes: [] };
    const fake = buildFakeDb(world);

    const result = await syncUserRoleScopeFromUserBranchRole(asSyncDb(fake));

    expect(result.created).toBe(50);
    const reads = fake.userRoleScopeCalls.filter((c) => c.op === 'findMany');
    expect(reads).toHaveLength(1);
    const inList = IN_KEY(reads[0]!);
    expect(inList).toHaveLength(50);
    expect(new Set(inList).size).toBe(50);
    expect(fake.userRoleScopeCalls.filter((c) => c.op === 'createMany').length).toBeLessThanOrEqual(1);
  });

  it('IR11: an unknown legacy code appearing LAST — classification fails before ANY role/location/UserRoleScope work', async () => {
    const valid = eligibleLegacyRows(5).map((r) => ({ ...r, id: `v-${r.id}` }));
    const unknownLast: FakeLegacyRow = { id: 'unknown-last', userId: 'user-x', branchId: 'branch-x', role: { code: 'GHOST' } };
    const world: FakeWorld = { legacy: [...valid, unknownLast], roles: PRODUCTION_ROLES, locations: locationsFor(valid), scopes: [] };
    const fake = buildFakeDb(world);

    await expect(syncUserRoleScopeFromUserBranchRole(asSyncDb(fake))).rejects.toThrow(
      /No explicit Production role mapping or deferral/,
    );
    expect(fake.userRoleScopeCalls).toEqual([]);
    expect(fake.roleFindManyCalls).toEqual([]);
    expect(fake.locationFindManyCalls).toEqual([]);
  });

  it('IR12: a missing Production Role fails before the Location lookup and before any UserRoleScope operation', async () => {
    const rows = eligibleLegacyRows(3);
    const world: FakeWorld = {
      legacy: rows,
      roles: PRODUCTION_ROLES.filter((r) => r.code !== 'SELLER'),
      locations: locationsFor(rows),
      scopes: [],
    };
    const fake = buildFakeDb(world);

    await expect(syncUserRoleScopeFromUserBranchRole(asSyncDb(fake))).rejects.toThrow(/Production Role\(s\) SELLER do not exist/);
    expect(fake.roleFindManyCalls).toHaveLength(1);
    expect(fake.locationFindManyCalls).toEqual([]);
    expect(fake.userRoleScopeCalls).toEqual([]);
  });

  it('IR13: a corrupt LOCATION scope with locationId NULL (unreachable via the normal schema path) satisfies no target and crashes nothing', async () => {
    const rows: FakeLegacyRow[] = [{ id: 'r', userId: 'u1', branchId: 'loc-1', role: { code: 'ADMIN' } }];
    const corrupt: FakeScopeRow = { id: 'corrupt', userId: 'u1', roleId: 'role-admin', scopeKind: 'LOCATION', locationId: null };
    const world: FakeWorld = { legacy: rows, roles: PRODUCTION_ROLES, locations: locationsFor(rows), scopes: [corrupt] };
    const fake = buildFakeDb(world);

    const result = await syncUserRoleScopeFromUserBranchRole(asSyncDb(fake));

    // The corrupt row matches NEITHER raw-SQL partial unique index and is only
    // reachable by raw SQL manipulation; exact key matching (`…|LOCATION|null`)
    // keeps it from satisfying the real target.
    expect(result).toEqual({ legacyRowCount: 1, eligibleRowCount: 1, deferredRowCount: 0, created: 1, alreadyPresent: 0 });
  });

  it('IR14: two users sharing role and location — one user’s existing scope never satisfies the other’s target', async () => {
    const rows: FakeLegacyRow[] = [
      { id: 'u1-seller', userId: 'u1', branchId: 'loc-1', role: { code: 'SELLER' } },
      { id: 'u2-seller', userId: 'u2', branchId: 'loc-1', role: { code: 'SELLER' } },
    ];
    const world: FakeWorld = {
      legacy: rows,
      roles: PRODUCTION_ROLES,
      locations: locationsFor(rows),
      scopes: [exactScopeRow(rows[0]!)], // u1 already scoped
    };
    const fake = buildFakeDb(world);

    const result = await syncUserRoleScopeFromUserBranchRole(asSyncDb(fake));

    expect(result).toEqual({ legacyRowCount: 2, eligibleRowCount: 2, deferredRowCount: 0, created: 1, alreadyPresent: 1 });
    const written = fake.userRoleScopeCalls.filter((c) => c.op === 'createMany')[0]!.data.map(targetKeyOf);
    expect(written).toEqual(['u2|role-seller|LOCATION|loc-1']);
  });
});
