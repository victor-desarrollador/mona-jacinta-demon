// OPT-IN SERVICE-LEVEL PostgreSQL regression for the scope-assignment target
// lock contract (scope-assignment.service.ts: target User row FOR NO KEY UPDATE).
// The static source pin lives in scope-assignment.test.ts; only a real
// PostgreSQL proves the behaviour: crossed admins never deadlock, and two
// operations on the same target serialize on that lock.
//
// OPT-IN ONLY: without MONA_SCOPE_ASSIGNMENT_PG=1 the suite is skipped. Requires a
// DISPOSABLE, isolated LOCAL_TEST cluster with the repository migrations applied,
// bound by marker (openProvenLocalTestPool) + system id:
//   MONA_SCOPE_ASSIGNMENT_PG=1 MONA_SCOPE_ASSIGNMENT_PG_DISPOSABLE=1
//   MONA_TEST_DATABASE_TARGET=local LOCAL_TEST_DATABASE_URL=…
//   LOCAL_TEST_DATABASE_MARKER_ID=…
//   MONA_SCOPE_ASSIGNMENT_PG_SYSTEM_ID=<pg_control_system().system_identifier>
// Fixtures are committed and permanent (unique tags), hence the DISPOSABLE flag.
//
// Overlap is proven, never assumed: a coordinator holds a Location row lock the
// service needs only AFTER it has locked its target User row, and
// waitForBlocked() (pg_stat_activity + pg_blocking_pids) confirms who waits on
// whom before the coordinator is released.
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../src/generated/prisma/client.js';
import { createScopeAssignmentService } from '../../src/modules/backoffice/scope-assignment.service.js';
import { ensureProductionRoleCatalog } from '../../src/modules/rbac/catalog.service.js';
import {
  PG_SYSTEM_ID,
  RACE_TIMEOUT_MS,
  companyAdminActor,
  holdRowLock,
  pointOfSaleNumberFor,
  waitForBlocked,
  withTimeout,
} from '../helpers/r3-service-pg.js';

const enabled = process.env.MONA_SCOPE_ASSIGNMENT_PG === '1';

type Req = { auth: Express.AuthContext };
const admin = (userId: string) => companyAdminActor(userId) as Req;

const LOCATION_SHARE = /FROM "Location" WHERE id IN[\s\S]*FOR SHARE/;
const TARGET_USER_LOCK = /FROM "User" WHERE id = \$1 FOR/;

describe.skipIf(!enabled)('scope-assignment target lock on PostgreSQL (disposable cluster)', () => {
  const pools: Pool[] = [];
  const clients: PrismaClient[] = [];
  let db: PrismaClient;
  let racerA: PrismaClient;
  let racerB: PrismaClient;
  let companyId: string;
  let roleIds: Record<string, string>;

  beforeAll(async () => {
    if (process.env.MONA_SCOPE_ASSIGNMENT_PG_DISPOSABLE !== '1') {
      throw new Error('the scope-assignment PG suite writes permanent rows: MONA_SCOPE_ASSIGNMENT_PG_DISPOSABLE=1 is required');
    }
    if (process.env.MONA_TEST_DATABASE_TARGET !== 'local') throw new Error('LOCAL_TEST selector required');
    const expectedSystemId = process.env.MONA_SCOPE_ASSIGNMENT_PG_SYSTEM_ID;
    if (!expectedSystemId || !PG_SYSTEM_ID.test(expectedSystemId)) {
      throw new Error('isolated cluster binding is missing: MONA_SCOPE_ASSIGNMENT_PG_SYSTEM_ID must be the decimal pg_control_system().system_identifier of the target');
    }
    const { openProvenLocalTestPool } = await import('../../scripts/demo-database.js');
    // pools[0]: coordinator + fixtures + observer; pools[1]/pools[2]: racers.
    for (const max of [6, 3, 3]) {
      const { pool } = await openProvenLocalTestPool(max, process.env);
      pools.push(pool);
      clients.push(new PrismaClient({ adapter: new PrismaPg(pool, { schema: 'public' }), log: [] }));
    }
    [db, racerA, racerB] = clients as [PrismaClient, PrismaClient, PrismaClient];
    const { rows } = await pools[0]!.query<{ system_id: string }>(
      `SELECT system_identifier::text AS system_id FROM pg_control_system()`,
    );
    if (rows[0]?.system_id !== expectedSystemId) throw new Error('isolated PostgreSQL cluster does not match binding');

    roleIds = await ensureProductionRoleCatalog(db);
    const suite = randomUUID().slice(0, 8);
    const company = await db.company.findFirst({ orderBy: { createdAt: 'asc' }, select: { id: true } })
      ?? await db.company.create({ data: { name: `SC ${suite}`, cuit: `sc-${suite}`, address: 'Test' } });
    companyId = company.id;
  });

  afterAll(async () => {
    for (const client of clients) await client.$disconnect();
    for (const pool of pools) await pool.end();
  });

  // --- fixtures ---------------------------------------------------------------

  async function makeLocation(): Promise<string> {
    const tag = randomUUID().slice(0, 8);
    const id = randomUUID();
    await db.location.create({ data: {
      id, companyId, code: `sc-${tag}`, name: `SC ${tag}`, type: 'RETAIL_BRANCH', address: 'Test',
      pointOfSaleNumber: pointOfSaleNumberFor('SC', tag),
    } });
    return id;
  }

  async function makeUser(label: string, scopes: Array<{ role: string; locationId: string | null }>): Promise<string> {
    const id = randomUUID();
    await db.user.create({ data: { id, name: `SC ${label}`, email: `sc-${id}@test.invalid`, passwordHash: 'not-used' } });
    for (const { role, locationId } of scopes) {
      await db.userRoleScope.create({
        data: { userId: id, roleId: roleIds[role]!, scopeKind: locationId ? 'LOCATION' : 'COMPANY', locationId },
      });
    }
    return id;
  }

  const makeAdmin = (label: string) => makeUser(label, [{ role: 'ADMIN', locationId: null }]);

  async function locationsOf(userId: string, role: string): Promise<string[]> {
    const rows = await db.userRoleScope.findMany({ where: { userId, roleId: roleIds[role]! }, select: { locationId: true } });
    return rows.map((row) => row.locationId!).sort();
  }

  // xmin order = serialization order: every effective mutation writes only
  // after it holds the target lock, and keeps it until commit.
  async function auditsOf(targetId: string) {
    const { rows } = await pools[0]!.query<{ action: string; userId: string; before: unknown; after: unknown }>(
      `SELECT action, "userId", before, after FROM "AuditLog" WHERE "entityId" = $1 ORDER BY xmin::text::bigint`,
      [targetId],
    );
    return rows;
  }

  // --- PG-SCOPE-C1 / C2 ---------------------------------------------------------

  it('PG-SCOPE-C1 crossed admins (A -> B while B -> A) both commit without 40P01 — FOR UPDATE caused cross-target FK deadlock C1', async () => {
    const location = await makeLocation();
    const adminA = await makeAdmin('a');
    const adminB = await makeAdmin('b');
    const serviceA = createScopeAssignmentService(racerA);
    const serviceB = createScopeAssignmentService(racerB);

    const coordinator = await holdRowLock(pools[0]!, 'Location', location);
    try {
      const aToB = serviceA.assign(admin(adminA), adminB, { roleCode: 'CASHIER', scopeKind: 'LOCATION', locationIds: [location] });
      const bToA = serviceB.assign(admin(adminB), adminA, { roleCode: 'CASHIER', scopeKind: 'LOCATION', locationIds: [location] });
      aToB.catch(() => undefined);
      bToA.catch(() => undefined);
      // Both now hold their target lock (the other admin) and wait on the
      // coordinator; on release both reach the AuditLog insert, whose FK takes
      // KEY SHARE on the actor row the other transaction has locked.
      await waitForBlocked(pools[0]!, coordinator.pid, 2, LOCATION_SHARE);
      await coordinator.release();
      const results = await withTimeout(Promise.all([aToB, bToA]), RACE_TIMEOUT_MS, 'crossed assignments');
      expect(results).toEqual([
        { userId: adminB, roleCode: 'CASHIER', scopeKind: 'LOCATION' },
        { userId: adminA, roleCode: 'CASHIER', scopeKind: 'LOCATION' },
      ]);
    } finally {
      await coordinator.release();
    }

    expect(await locationsOf(adminB, 'CASHIER')).toEqual([location]);
    expect(await locationsOf(adminA, 'CASHIER')).toEqual([location]);
    for (const [target, actor] of [[adminB, adminA], [adminA, adminB]] as const) {
      expect(await auditsOf(target)).toEqual([{
        action: 'USER_SCOPE_ASSIGNED', userId: actor, before: null,
        after: { roleCode: 'CASHIER', scopeKind: 'LOCATION', locationIds: [location] },
      }]);
    }
  }, RACE_TIMEOUT_MS * 2);

  it('PG-SCOPE-C2 same target: B waits on A\'s target lock and then acts on the state A committed', async () => {
    const [initial, next] = [await makeLocation(), await makeLocation()];
    const adminA = await makeAdmin('a');
    const adminB = await makeAdmin('b');
    const target = await makeUser('x', [{ role: 'CASHIER', locationId: initial }]);
    const serviceA = createScopeAssignmentService(racerA);
    const serviceB = createScopeAssignmentService(racerB);

    const coordinator = await holdRowLock(pools[0]!, 'Location', next);
    try {
      const assign = serviceA.assign(admin(adminA), target, { roleCode: 'CASHIER', scopeKind: 'LOCATION', locationIds: [next] });
      assign.catch(() => undefined);
      const [a] = await waitForBlocked(pools[0]!, coordinator.pid, 1, LOCATION_SHARE) as Array<{ pid: number }>;
      const revoke = serviceB.revoke(admin(adminB), target, 'CASHIER');
      revoke.catch(() => undefined);
      const [b] = await waitForBlocked(pools[0]!, coordinator.pid, 1, TARGET_USER_LOCK) as Array<{ blockers: number[] }>;
      expect(b!.blockers).toContain(a!.pid);
      await coordinator.release();
      await withTimeout(Promise.all([assign, revoke]), RACE_TIMEOUT_MS, 'same-target operations');
    } finally {
      await coordinator.release();
    }

    // B revoked exactly what A committed — no lost update, linear audit chain.
    expect(await locationsOf(target, 'CASHIER')).toEqual([]);
    expect(await auditsOf(target)).toEqual([
      {
        action: 'USER_SCOPE_ASSIGNED', userId: adminA,
        before: { roleCode: 'CASHIER', scopeKind: 'LOCATION', locationIds: [initial] },
        after: { roleCode: 'CASHIER', scopeKind: 'LOCATION', locationIds: [next] },
      },
      {
        action: 'USER_SCOPE_REVOKED', userId: adminB,
        before: { roleCode: 'CASHIER', scopeKind: 'LOCATION', locationIds: [next] },
        after: null,
      },
    ]);
  }, RACE_TIMEOUT_MS * 2);
});
