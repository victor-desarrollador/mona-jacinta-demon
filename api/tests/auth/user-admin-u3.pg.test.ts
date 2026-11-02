// USER-MGMT-01 U3 — the opt-in PostgreSQL gate for privilege-escalation hardening and LAST_OWNER_PROTECTED. OPT-IN ONLY.
// What only a real PostgreSQL proves here: the advisory lock + row locks in the fixed order never deadlock and really serialize two OWNERs removing each
// other; a target's privilege is decided from the scope rows read UNDER its row lock (a grant that queued first is seen by the ADMIN queued behind it);
// and the real middleware / permission gate / services refuse every ADMIN escalation over HTTP.
//
// Same environment contract as user-admin.pg.test.ts (disposable, isolated, marker + system id bound):
//   MONA_USER_ADMIN_PG=1 MONA_USER_ADMIN_PG_DISPOSABLE=1 MONA_TEST_DATABASE_TARGET=local LOCAL_TEST_DATABASE_URL=… LOCAL_TEST_DATABASE_MARKER_ID=…
//   MONA_USER_ADMIN_PG_SYSTEM_ID=<pg_control_system().system_identifier>
// The tests that count operative OWNERs first DEACTIVATE every other OWNER of the cluster (explicitly allowed only because the cluster is disposable).
//
// OVERLAP IS PROVEN, NOT ASSUMED: a COORDINATOR parks on the contended lock (the guard's advisory lock, or the target User row) on its own connection;
// both real service calls start on independent pools; the coordinator is released only after pg_stat_activity + pg_blocking_pids show both backends
// waiting in its chain.
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import type { Pool, PoolClient } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { PrismaClient } from '../../src/generated/prisma/client.js';
import { hashPassword } from '../../src/modules/auth/password.js';
import { signAccessToken } from '../../src/modules/auth/tokens.js';
import { createScopeAssignmentService } from '../../src/modules/backoffice/scope-assignment.service.js';
import { createUserAdminService } from '../../src/modules/backoffice/user-admin.service.js';
import { AppError } from '../../src/shared/errors.js';
import { PG_SYSTEM_ID, RACE_TIMEOUT_MS, waitForBlocked, withTimeout } from '../helpers/r3-service-pg.js';

const enabled = process.env.MONA_USER_ADMIN_PG === '1';
const ADVISORY_KEY = 7_335_210_001; // user-admin-policy.ts LAST_OWNER_ADVISORY_KEY
const BASE = '/api/v1/backoffice/users';
const posFor = (tag: string) => 16 * 10_000_000 + parseInt(tag.slice(0, 5), 16);

describe.skipIf(!enabled)('USER-MGMT-01 U3 on PostgreSQL — privilege hardening and LAST_OWNER_PROTECTED (disposable cluster)', () => {
  const pools: Pool[] = [];
  const clients: PrismaClient[] = [];
  let db: PrismaClient;
  let racerA: PrismaClient;
  let racerB: PrismaClient;
  let usersA: ReturnType<typeof createUserAdminService>;
  let usersB: ReturnType<typeof createUserAdminService>;
  let scopesA: ReturnType<typeof createScopeAssignmentService>;
  let scopesB: ReturnType<typeof createScopeAssignmentService>;
  let scopes: ReturnType<typeof createScopeAssignmentService>;
  let currentHash = '';
  const roleId: Record<string, string> = {};
  let companyId = '';

  beforeAll(async () => {
    if (process.env.MONA_USER_ADMIN_PG_DISPOSABLE !== '1') throw new Error('this suite writes permanent rows: MONA_USER_ADMIN_PG_DISPOSABLE=1 is required');
    if (process.env.MONA_TEST_DATABASE_TARGET !== 'local') throw new Error('LOCAL_TEST selector required');
    const expectedSystemId = process.env.MONA_USER_ADMIN_PG_SYSTEM_ID;
    if (!expectedSystemId || !PG_SYSTEM_ID.test(expectedSystemId)) throw new Error('isolated cluster binding is missing');
    const { openProvenLocalTestPool } = await import('../../scripts/demo-database.js');
    for (const max of [8, 3, 3]) {
      const { pool } = await openProvenLocalTestPool(max, process.env);
      pools.push(pool);
      clients.push(new PrismaClient({ adapter: new PrismaPg(pool, { schema: 'public' }), log: [] }));
    }
    [db, racerA, racerB] = clients as [PrismaClient, PrismaClient, PrismaClient];
    usersA = createUserAdminService(racerA); usersB = createUserAdminService(racerB);
    scopesA = createScopeAssignmentService(racerA); scopesB = createScopeAssignmentService(racerB);
    scopes = createScopeAssignmentService(db);
    const { rows } = await pools[0]!.query<{ system_id: string; migrated: boolean }>(
      `SELECT system_identifier::text AS system_id, EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE migration_name = '20261101130000_user_admin_lifecycle' AND finished_at IS NOT NULL) AS migrated FROM pg_control_system()`,
    );
    if (rows[0]?.system_id !== expectedSystemId) throw new Error('isolated PostgreSQL cluster does not match binding');
    if (rows[0]?.migrated !== true) throw new Error('migration 22 (G22) is required');
    currentHash = await hashPassword('current-password-123');
    for (const code of ['OWNER', 'ADMIN', 'CASHIER', 'SELLER']) roleId[code] = (await db.role.findUniqueOrThrow({ where: { code } })).id;
    companyId = (await db.company.findFirstOrThrow()).id;
  });

  afterAll(async () => {
    for (const client of clients) await client.$disconnect();
    for (const pool of pools) await pool.end();
  });

  // --- fixtures ---------------------------------------------------------------------------------
  const tag = () => randomUUID().replace(/-/g, '').slice(0, 10);
  const key = () => randomUUID();
  const ctxOf = (userId: string, roleCode: 'OWNER' | 'ADMIN'): { auth: Express.AuthContext } => ({
    auth: { userId, roles: [roleCode], assignments: [{ roleId: roleId[roleCode]!, roleCode, scopeKind: 'COMPANY', locationId: null, permissions: [] }], effectiveLocationIds: [] },
  });

  async function makeLocation(): Promise<string> {
    const t = tag();
    return (await db.location.create({ data: { companyId, name: `U3 ${t}`, code: `U3-${t}`, type: 'RETAIL_BRANCH', address: 'u3', pointOfSaleNumber: posFor(t) } })).id;
  }
  async function makeUser(roleCode: 'OWNER' | 'ADMIN' | 'CASHIER' | 'SELLER', locationId?: string, isActive = true): Promise<string> {
    const id = randomUUID();
    await db.user.create({ data: { id, name: `U3 ${roleCode} ${id.slice(0, 6)}`, email: `u3-${roleCode.toLowerCase()}-${id.slice(0, 8)}@test.invalid`, passwordHash: currentHash, isActive } });
    const company = roleCode === 'OWNER' || roleCode === 'ADMIN';
    await db.userRoleScope.create({ data: { userId: id, roleId: roleId[roleCode]!, scopeKind: company ? 'COMPANY' : 'LOCATION', locationId: company ? null : locationId! } });
    return id;
  }
  // Makes `keep` the ONLY operative OWNERs of the disposable cluster.
  async function onlyOwners(keep: string[]): Promise<void> {
    await pools[0]!.query(
      `UPDATE "User" SET "isActive" = false WHERE id <> ALL($1::text[]) AND id IN (SELECT s."userId" FROM "UserRoleScope" s JOIN "Role" r ON r.id = s."roleId" WHERE r.code = 'OWNER' AND s."scopeKind" = 'COMPANY')`,
      [keep],
    );
  }
  const operativeOwners = async (): Promise<string[]> => (await pools[0]!.query<{ id: string }>(
    `SELECT u.id FROM "User" u JOIN "UserRoleScope" s ON s."userId" = u.id JOIN "Role" r ON r.id = s."roleId" WHERE u."isActive" AND r.code = 'OWNER' AND s."scopeKind" = 'COMPANY'`,
  )).rows.map((r) => r.id);

  async function park(lockSql: string, params: unknown[] = []): Promise<{ pid: number; release: () => Promise<void> }> {
    const client: PoolClient = await pools[0]!.connect();
    await client.query('BEGIN');
    await client.query(lockSql, params);
    const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    let done = false;
    return { pid: rows[0]!.pid, release: async () => { if (done) return; done = true; try { await client.query('ROLLBACK'); } finally { client.release(); } } };
  }
  const settle = async (promises: Promise<unknown>[], what: string) => withTimeout(Promise.allSettled(promises), RACE_TIMEOUT_MS, what);
  const reasonOf = (r: PromiseSettledResult<unknown>): AppError => {
    expect(r.status).toBe('rejected');
    const reason = (r as PromiseRejectedResult).reason;
    expect(reason, JSON.stringify(reason?.message)).toBeInstanceOf(AppError);
    return reason as AppError;
  };
  const audits = (entityId: string, action: string) => db.auditLog.findMany({ where: { entityId, action } });

  // --- LAST_OWNER ----------------------------------------------------------------------------------

  it('PG-U3-01 RACE: two operative OWNERs deactivate EACH OTHER at once: exactly one wins, the other is LAST_OWNER_PROTECTED, one OWNER stays, one audit, no deadlock', async () => {
    const a = await makeUser('OWNER');
    const b = await makeUser('OWNER');
    await onlyOwners([a, b]);
    const holder = await park('SELECT pg_advisory_xact_lock($1)', [ADVISORY_KEY]);
    let results: PromiseSettledResult<unknown>[];
    try {
      const x = usersA.deactivate(ctxOf(a, 'OWNER'), b, { idempotencyKey: key() });
      const y = usersB.deactivate(ctxOf(b, 'OWNER'), a, { idempotencyKey: key() });
      expect(await waitForBlocked(pools[0]!, holder.pid, 2, /pg_advisory_xact_lock/)).toHaveLength(2);
      await holder.release();
      results = await settle([x, y], 'the two deactivations');
    } finally {
      await holder.release();
    }
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(reasonOf(results.find((r) => r.status === 'rejected')!)).toMatchObject({ status: 409, code: 'LAST_OWNER_PROTECTED' });
    expect(await operativeOwners()).toHaveLength(1);
    expect((await audits(a, 'USER_DEACTIVATED')).length + (await audits(b, 'USER_DEACTIVATED')).length).toBe(1);
    expect(await db.userAdminOperation.count({ where: { actorId: { in: [a, b] }, operation: 'DEACTIVATE_USER' } })).toBe(1);
  }, RACE_TIMEOUT_MS);

  it('PG-U3-02 RACE: one OWNER REVOKES the other\'s OWNER scope while that one DEACTIVATES the first (two different code paths): exactly one wins, one OWNER stays', async () => {
    const a = await makeUser('OWNER');
    const b = await makeUser('OWNER');
    await onlyOwners([a, b]);
    const holder = await park('SELECT pg_advisory_xact_lock($1)', [ADVISORY_KEY]);
    let results: PromiseSettledResult<unknown>[];
    try {
      const x = scopesA.revoke(ctxOf(a, 'OWNER'), b, 'OWNER');
      const y = usersB.deactivate(ctxOf(b, 'OWNER'), a, { idempotencyKey: key() });
      expect(await waitForBlocked(pools[0]!, holder.pid, 2, /pg_advisory_xact_lock/)).toHaveLength(2);
      await holder.release();
      results = await settle([x, y], 'revoke vs deactivate');
    } finally {
      await holder.release();
    }
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(reasonOf(results.find((r) => r.status === 'rejected')!)).toMatchObject({ status: 409, code: 'LAST_OWNER_PROTECTED' });
    expect(await operativeOwners()).toHaveLength(1);
    expect((await audits(b, 'USER_SCOPE_REVOKED')).length + (await audits(a, 'USER_DEACTIVATED')).length).toBe(1);
  }, RACE_TIMEOUT_MS);

  it('PG-U3-03 RACE: two OWNERs REVOKE each other\'s OWNER scope at once: exactly one wins', async () => {
    const a = await makeUser('OWNER');
    const b = await makeUser('OWNER');
    await onlyOwners([a, b]);
    const holder = await park('SELECT pg_advisory_xact_lock($1)', [ADVISORY_KEY]);
    let results: PromiseSettledResult<unknown>[];
    try {
      const x = scopesA.revoke(ctxOf(a, 'OWNER'), b, 'OWNER');
      const y = scopesB.revoke(ctxOf(b, 'OWNER'), a, 'OWNER');
      expect(await waitForBlocked(pools[0]!, holder.pid, 2, /pg_advisory_xact_lock/)).toHaveLength(2);
      await holder.release();
      results = await settle([x, y], 'the two revokes');
    } finally {
      await holder.release();
    }
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(reasonOf(results.find((r) => r.status === 'rejected')!)).toMatchObject({ status: 409, code: 'LAST_OWNER_PROTECTED' });
    expect(await operativeOwners()).toHaveLength(1);
    expect((await audits(a, 'USER_SCOPE_REVOKED')).length + (await audits(b, 'USER_SCOPE_REVOKED')).length).toBe(1);
  }, RACE_TIMEOUT_MS);

  it('PG-U3-04 sequentially: with one other operative OWNER the removal works; an inactive OWNER does not count; a refused attempt writes nothing', async () => {
    const a = await makeUser('OWNER');
    const b = await makeUser('OWNER');
    const dormant = await makeUser('OWNER', undefined, false);
    await onlyOwners([a, b]);
    const phantom = randomUUID(); // a context that claims OWNER with no operative row behind it
    expect((await usersA.deactivate(ctxOf(a, 'OWNER'), b, { idempotencyKey: key() })).user.isActive).toBe(false); // a remains
    const before = await db.auditLog.count();
    await expect(usersA.deactivate(ctxOf(phantom, 'OWNER'), a, { idempotencyKey: key() })).rejects.toMatchObject({ status: 409, code: 'LAST_OWNER_PROTECTED' }); // dormant does not count
    await expect(scopesA.revoke(ctxOf(phantom, 'OWNER'), a, 'OWNER')).rejects.toMatchObject({ status: 409, code: 'LAST_OWNER_PROTECTED' });
    expect(await db.auditLog.count()).toBe(before);
    expect((await db.user.findUniqueOrThrow({ where: { id: a } })).isActive).toBe(true);
    expect(await db.userRoleScope.count({ where: { userId: a, roleId: roleId.OWNER } })).toBe(1);
    expect((await scopes.revoke(ctxOf(a, 'OWNER'), dormant, 'OWNER')).revoked).toBe(true); // not operative: removing its row is harmless
  });

  // --- privilege decided under the target lock ------------------------------------------------------

  it('PG-U3-05 the target\'s privilege is read UNDER its row lock: an ADMIN queued behind an OWNER\'s ADMIN grant sees the grant and is refused; queued before it, it succeeds', async () => {
    const loc = await makeLocation();
    const owner = await makeUser('OWNER');
    const admin = await makeUser('ADMIN');
    for (const order of ['grant-first', 'reset-first'] as const) {
      const target = await makeUser('SELLER', loc);
      const holder = await park('SELECT id FROM "User" WHERE id = $1 FOR UPDATE', [target]);
      let grant: Promise<unknown>; let reset: Promise<unknown>;
      let results: PromiseSettledResult<unknown>[];
      try {
        const startGrant = () => scopesA.assign(ctxOf(owner, 'OWNER'), target, { roleCode: 'ADMIN', scopeKind: 'COMPANY' });
        const startReset = () => usersB.resetPassword(ctxOf(admin, 'ADMIN'), target, { idempotencyKey: key() });
        if (order === 'grant-first') {
          grant = startGrant();
          await waitForBlocked(pools[0]!, holder.pid, 1, /FOR NO KEY UPDATE/);
          reset = startReset();
        } else {
          reset = startReset();
          await waitForBlocked(pools[0]!, holder.pid, 1, /FOR NO KEY UPDATE/);
          grant = startGrant();
        }
        expect(await waitForBlocked(pools[0]!, holder.pid, 2, /FOR NO KEY UPDATE/)).toHaveLength(2);
        await holder.release();
        results = await settle(order === 'grant-first' ? [grant, reset] : [reset, grant], order);
      } finally {
        await holder.release();
      }
      if (order === 'grant-first') {
        expect(results[0]!.status).toBe('fulfilled');
        expect(reasonOf(results[1]!)).toMatchObject({ status: 403 }); // the reset saw the committed ADMIN scope
        expect(await audits(target, 'USER_PASSWORD_RESET')).toHaveLength(0);
      } else {
        expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
        expect(await audits(target, 'USER_PASSWORD_RESET')).toHaveLength(1);
      }
    }
  }, RACE_TIMEOUT_MS);

  // --- the whole matrix over HTTP on the real middleware ------------------------------------------------

  it('PG-U3-06 HTTP: a real ADMIN COMPANY is refused every escalation and every privileged target on BOTH route families; an OWNER is not', async () => {
    const loc = await makeLocation();
    const owner = await makeUser('OWNER');
    const admin = await makeUser('ADMIN');
    const admin2 = await makeUser('ADMIN');
    const seller = await makeUser('SELLER', loc);
    await onlyOwners([owner]);
    const app = createApp(db);
    const as = async (id: string) => ({ Authorization: `Bearer ${await signAccessToken(id, null)}` });
    const adminH = await as(admin); const ownerH = await as(owner);
    const status = async (req: request.Test) => (await req).status;

    // escalation
    expect(await status(request(app).post(`${BASE}/${seller}/scope`).set(adminH).send({ roleCode: 'ADMIN', scopeKind: 'COMPANY' }))).toBe(403);
    expect(await status(request(app).post(`${BASE}/${seller}/scope`).set(adminH).send({ roleCode: 'OWNER', scopeKind: 'COMPANY' }))).toBe(403);
    expect(await status(request(app).post(BASE).set(adminH).send({ name: 'X', email: `x-${tag()}@test.invalid`, roleCode: 'ADMIN', scopeKind: 'COMPANY', idempotencyKey: key() }))).toBe(403);
    // privileged targets
    for (const target of [admin2, owner]) {
      expect(await status(request(app).post(`${BASE}/${target}/scope`).set(adminH).send({ roleCode: 'CASHIER', scopeKind: 'LOCATION', locationIds: [loc] }))).toBe(403);
      expect(await status(request(app).delete(`${BASE}/${target}/scope/${target === admin2 ? 'ADMIN' : 'OWNER'}`).set(adminH))).toBe(403);
      expect(await status(request(app).patch(`${BASE}/${target}`).set(adminH).send({ name: 'Otro' }))).toBe(403);
      expect(await status(request(app).post(`${BASE}/${target}/deactivate`).set(adminH).send({ idempotencyKey: key() }))).toBe(403);
      expect(await status(request(app).post(`${BASE}/${target}/reset-password`).set(adminH).send({ idempotencyKey: key() }))).toBe(403);
    }
    // self
    expect(await status(request(app).post(`${BASE}/${admin}/deactivate`).set(adminH).send({ idempotencyKey: key() }))).toBe(403);
    expect(await status(request(app).post(`${BASE}/${admin}/scope`).set(adminH).send({ roleCode: 'CASHIER', scopeKind: 'LOCATION', locationIds: [loc] }))).toBe(403);
    expect(await db.userRoleScope.count({ where: { userId: seller, roleId: { in: [roleId.ADMIN!, roleId.OWNER!] } } })).toBe(0);
    expect((await db.user.findUniqueOrThrow({ where: { id: admin2 } })).isActive).toBe(true);
    // what an ADMIN may do
    expect(await status(request(app).post(`${BASE}/${seller}/scope`).set(adminH).send({ roleCode: 'CASHIER', scopeKind: 'LOCATION', locationIds: [loc] }))).toBe(200);
    expect(await status(request(app).delete(`${BASE}/${seller}/scope/CASHIER`).set(adminH))).toBe(200);
    expect(await status(request(app).post(`${BASE}/${seller}/reset-password`).set(adminH).send({ idempotencyKey: key() }))).toBe(200);
    // what an OWNER may do (the target ADMIN account is privileged, the actor is OWNER)
    expect(await status(request(app).post(`${BASE}/${admin2}/reset-password`).set(ownerH).send({ idempotencyKey: key() }))).toBe(200);
    expect(await status(request(app).post(`${BASE}/${seller}/scope`).set(ownerH).send({ roleCode: 'ADMIN', scopeKind: 'COMPANY' }))).toBe(200);
    // and the OWNER cannot remove the last OWNER... it is the only one, and it cannot touch itself: a SECOND owner is needed to try it
    const owner2 = await makeUser('OWNER');
    await onlyOwners([owner, owner2]);
    expect(await status(request(app).post(`${BASE}/${owner2}/deactivate`).set(ownerH).send({ idempotencyKey: key() }))).toBe(200);
    const again = await request(app).post(`${BASE}/${owner}/deactivate`).set(await as(owner2)).send({ idempotencyKey: key() });
    expect(again.status).toBe(403); // owner2 was just deactivated: its session is over (INACTIVE_USER)
    expect(await operativeOwners()).toEqual([owner]);
  }, RACE_TIMEOUT_MS);
});
