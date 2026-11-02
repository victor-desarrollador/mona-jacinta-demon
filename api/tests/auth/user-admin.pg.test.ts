// USER-MGMT-01 U2 (G22) — the opt-in PostgreSQL gate for the identity lifecycle. OPT-IN ONLY.
// What only a real PostgreSQL proves here: the live G22 DDL (the lower(email) unique index, the UserAdminOperation CHECKs / unique / FKs), the
// real race outcomes (two creates of the same e-mail in different capitalisations, the same idempotency key arriving twice, two resets of the same
// account, two edits fighting for one e-mail) resolving to the domain answer with exactly one effect, the atomicity of user + scope + operation +
// audit under an injected audit failure, and the whole HTTP flow (create -> login -> forced change) over a real database.
//
// Requires an OWNER-authorized, DISPOSABLE, isolated LOCAL_TEST cluster with migrations 1–22 and the canonical baseline catalog, bound by
// marker + system id:
//   MONA_USER_ADMIN_PG=1 MONA_USER_ADMIN_PG_DISPOSABLE=1
//   MONA_TEST_DATABASE_TARGET=local LOCAL_TEST_DATABASE_URL=… LOCAL_TEST_DATABASE_MARKER_ID=…
//   MONA_USER_ADMIN_PG_SYSTEM_ID=<pg_control_system().system_identifier>
// Fixtures are COMMITTED and PERMANENT by design (unique e-mails / codes per run; nothing baseline-owned is mutated): the cluster is discarded
// afterwards, never reused. The audit-failure case installs a temporary trigger on "AuditLog" and always drops it in `finally`.
//
// OVERLAP IS PROVEN, NOT ASSUMED (the audited R3-U2 convention): each race first parks a COORDINATOR transaction on its own connection on the
// resource both racers need (a Location row, a User row, or an uncommitted e-mail on the unique index), starts both real service calls on
// independent pools, and only releases after pg_stat_activity + pg_blocking_pids prove both backends are in the coordinator's wait chain.
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PrismaPg } from '@prisma/adapter-pg';
import type { Pool, PoolClient } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { PrismaClient } from '../../src/generated/prisma/client.js';
import { hashPassword, verifyPassword } from '../../src/modules/auth/password.js';
import { signAccessToken } from '../../src/modules/auth/tokens.js';
import { createUserAdminService } from '../../src/modules/backoffice/user-admin.service.js';
import { AppError } from '../../src/shared/errors.js';
import { PG_SYSTEM_ID, RACE_TIMEOUT_MS, waitForBlocked, withTimeout } from '../helpers/r3-service-pg.js';

const enabled = process.env.MONA_USER_ADMIN_PG === '1';
const G22 = '20261101130000_user_admin_lifecycle';
const BASE = '/api/v1/backoffice/users';
const CURRENT = 'current-password-123';
// A private pointOfSaleNumber slot for this suite (the registered slots stop at 14): 15 * 10_000_000 + a 5-hex-digit tag.
const posFor = (tag: string) => 15 * 10_000_000 + parseInt(tag.slice(0, 5), 16);

describe.skipIf(!enabled)('USER-MGMT-01 U2 (G22) on PostgreSQL — identity lifecycle (disposable cluster)', () => {
  const pools: Pool[] = [];
  const clients: PrismaClient[] = [];
  let db: PrismaClient;
  let racerA: PrismaClient;
  let racerB: PrismaClient;
  let svc: ReturnType<typeof createUserAdminService>;
  let svcA: ReturnType<typeof createUserAdminService>;
  let svcB: ReturnType<typeof createUserAdminService>;
  let currentHash = '';
  let ownerRoleId = '';
  let sellerRoleId = '';
  let companyId = '';

  beforeAll(async () => {
    if (process.env.MONA_USER_ADMIN_PG_DISPOSABLE !== '1') throw new Error('this suite writes permanent rows: MONA_USER_ADMIN_PG_DISPOSABLE=1 is required');
    if (process.env.MONA_TEST_DATABASE_TARGET !== 'local') throw new Error('LOCAL_TEST selector required');
    const expectedSystemId = process.env.MONA_USER_ADMIN_PG_SYSTEM_ID;
    if (!expectedSystemId || !PG_SYSTEM_ID.test(expectedSystemId)) {
      throw new Error('isolated cluster binding is missing: MONA_USER_ADMIN_PG_SYSTEM_ID must be the decimal pg_control_system().system_identifier of the target');
    }
    const { openProvenLocalTestPool } = await import('../../scripts/demo-database.js');
    // pools[0]: coordinator + fixtures + observer; pools[1]/pools[2]: racers.
    for (const max of [8, 3, 3]) {
      const { pool } = await openProvenLocalTestPool(max, process.env);
      pools.push(pool);
      clients.push(new PrismaClient({ adapter: new PrismaPg(pool, { schema: 'public' }), log: [] }));
    }
    [db, racerA, racerB] = clients as [PrismaClient, PrismaClient, PrismaClient];
    svc = createUserAdminService(db);
    svcA = createUserAdminService(racerA);
    svcB = createUserAdminService(racerB);
    const { rows } = await pools[0]!.query<{ system_id: string; migrated: boolean }>(
      `SELECT system_identifier::text AS system_id,
              EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE migration_name = '${G22}' AND finished_at IS NOT NULL AND rolled_back_at IS NULL) AS migrated
         FROM pg_control_system()`,
    );
    if (rows[0]?.system_id !== expectedSystemId) throw new Error('isolated PostgreSQL cluster does not match binding');
    if (rows[0]?.migrated !== true) throw new Error('migration 22 (G22) is required');
    currentHash = await hashPassword(CURRENT);
    ownerRoleId = (await db.role.findUniqueOrThrow({ where: { code: 'OWNER' } })).id;
    sellerRoleId = (await db.role.findUniqueOrThrow({ where: { code: 'SELLER' } })).id;
    companyId = (await db.company.findFirstOrThrow()).id;
  });

  afterAll(async () => {
    for (const client of clients) await client.$disconnect();
    for (const pool of pools) await pool.end();
  });

  // --- fixtures ---------------------------------------------------------------

  const tag = () => randomUUID().replace(/-/g, '').slice(0, 10);
  const key = () => randomUUID(); // a v4 UUID

  async function makeLocation(isActive = true): Promise<string> {
    const t = tag();
    const location = await db.location.create({ data: { companyId, name: `U2 ${t}`, code: `U2-${t}`, type: 'RETAIL_BRANCH', address: 'u2', pointOfSaleNumber: posFor(t), isActive } });
    return location.id;
  }

  // A committed OWNER actor: its Express auth context for the service, its token for HTTP.
  async function makeOwner(): Promise<{ id: string; req: { auth: Express.AuthContext } }> {
    const id = randomUUID();
    await db.user.create({ data: { id, name: `Owner ${id.slice(0, 6)}`, email: `u2-owner-${id.slice(0, 8)}@test.invalid`, passwordHash: currentHash } });
    await db.userRoleScope.create({ data: { userId: id, roleId: ownerRoleId, scopeKind: 'COMPANY', locationId: null } });
    return { id, req: { auth: { userId: id, roles: ['OWNER'], assignments: [{ roleId: ownerRoleId, roleCode: 'OWNER', scopeKind: 'COMPANY', locationId: null, permissions: [] }], effectiveLocationIds: [] } } };
  }

  async function makeSeller(locationId: string, patch: { isActive?: boolean } = {}): Promise<{ id: string; email: string }> {
    const id = randomUUID();
    const email = `u2-seller-${id.slice(0, 8)}@test.invalid`;
    await db.user.create({ data: { id, name: `Seller ${id.slice(0, 6)}`, email, passwordHash: currentHash, ...patch } });
    await db.userRoleScope.create({ data: { userId: id, roleId: sellerRoleId, scopeKind: 'LOCATION', locationId } });
    return { id, email };
  }

  const createInput = (locationId: string, patch: Record<string, unknown> = {}) =>
    ({ name: 'Maria Lopez', email: `u2-new-${tag()}@test.invalid`, roleCode: 'SELLER', scopeKind: 'LOCATION', locationIds: [locationId], idempotencyKey: key(), ...patch }) as never;

  // The coordinator: parks a transaction on its own connection holding `lockSql` until released.
  async function park(lockSql: string, params: unknown[] = []): Promise<{ pid: number; release: () => Promise<void>; commit: () => Promise<void> }> {
    const client: PoolClient = await pools[0]!.connect();
    await client.query('BEGIN');
    await client.query(lockSql, params);
    const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    let done = false;
    const finish = (mode: 'ROLLBACK' | 'COMMIT') => async () => {
      if (done) return;
      done = true;
      try { await client.query(mode); } finally { client.release(); }
    };
    return { pid: rows[0]!.pid, release: finish('ROLLBACK'), commit: finish('COMMIT') };
  }

  const stored = (id: string) => db.user.findUniqueOrThrow({ where: { id } });
  const byEmail = (email: string) => pools[0]!.query<{ id: string }>('SELECT id FROM "User" WHERE lower("email") = lower($1)', [email]).then((r) => r.rows);
  const audits = (entityId: string, action?: string) => db.auditLog.findMany({ where: { entityId, ...(action ? { action } : {}) } });
  const ops = (targetUserId: string) => db.userAdminOperation.findMany({ where: { targetUserId } });
  const failureOf = (result: PromiseSettledResult<unknown>): AppError => {
    expect(result.status).toBe('rejected');
    const reason = (result as PromiseRejectedResult).reason;
    expect(reason).toBeInstanceOf(AppError);
    return reason as AppError;
  };

  // --- schema --------------------------------------------------------------------

  it('PG-U2-01 the live G22 DDL: UserAdminOperation columns, CHECKs, unique (actorId, idempotencyKey), RESTRICT FKs and the lower(email) unique index', async () => {
    const cols = await pools[0]!.query(`SELECT column_name, data_type, datetime_precision, is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'UserAdminOperation' ORDER BY ordinal_position`);
    expect(cols.rows).toEqual([
      { column_name: 'id', data_type: 'text', datetime_precision: null, is_nullable: 'NO' },
      { column_name: 'actorId', data_type: 'text', datetime_precision: null, is_nullable: 'NO' },
      { column_name: 'targetUserId', data_type: 'text', datetime_precision: null, is_nullable: 'NO' },
      { column_name: 'operation', data_type: 'text', datetime_precision: null, is_nullable: 'NO' },
      { column_name: 'idempotencyKey', data_type: 'text', datetime_precision: null, is_nullable: 'NO' },
      { column_name: 'requestHash', data_type: 'text', datetime_precision: null, is_nullable: 'NO' },
      { column_name: 'createdAt', data_type: 'timestamp with time zone', datetime_precision: 3, is_nullable: 'NO' },
    ]);
    const idx = await pools[0]!.query<{ indexdef: string }>(`SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'User_email_lower_key'`);
    expect(idx.rows[0]!.indexdef).toMatch(/CREATE UNIQUE INDEX "User_email_lower_key" ON public\."User" USING btree \(lower\(email\)\)/);
    const fks = await pools[0]!.query<{ conname: string; confdeltype: string; confupdtype: string }>(
      `SELECT conname, confdeltype, confupdtype FROM pg_constraint WHERE conrelid = 'public."UserAdminOperation"'::regclass AND contype = 'f' ORDER BY conname`,
    );
    expect(fks.rows.map((r) => [r.confdeltype, r.confupdtype])).toEqual([['r', 'c'], ['r', 'c']]); // ON DELETE RESTRICT, ON UPDATE CASCADE
    // the CHECKs reject: an unknown operation, a non-UUID-v4 key, a hash that is not 64 lower-case hex
    const o = await makeOwner();
    const bad = async (operation: string, idempotencyKey: string, requestHash: string) =>
      pools[0]!.query('INSERT INTO "UserAdminOperation" (id, "actorId", "targetUserId", operation, "idempotencyKey", "requestHash") VALUES ($1, $2, $2, $3, $4, $5)', [randomUUID(), o.id, operation, idempotencyKey, requestHash]);
    const hash = 'a'.repeat(64);
    await expect(bad('DROP_USER', key(), hash)).rejects.toMatchObject({ code: '23514' });
    await expect(bad('CREATE_USER', 'not-a-uuid', hash)).rejects.toMatchObject({ code: '23514' });
    await expect(bad('CREATE_USER', key(), 'A'.repeat(64))).rejects.toMatchObject({ code: '23514' });
    await expect(bad('CREATE_USER', key(), 'a'.repeat(63))).rejects.toMatchObject({ code: '23514' });
    const good = key();
    await bad('CREATE_USER', good, hash);
    await expect(bad('RESET_PASSWORD', good, hash)).rejects.toMatchObject({ code: '23505' }); // unique (actorId, idempotencyKey)
    await expect(pools[0]!.query('DELETE FROM "User" WHERE id = $1', [o.id])).rejects.toMatchObject({ code: '23503' }); // RESTRICT: history is never deleted with the user
  });

  it('PG-U2-02 the ledger holds exactly 22 finished migrations and G22 is the last, with the reviewed checksum', async () => {
    const { rows } = await pools[0]!.query<{ migration_name: string; checksum: string; finished: boolean; rolled_back: boolean }>(
      `SELECT migration_name, checksum, (finished_at IS NOT NULL) AS finished, (rolled_back_at IS NOT NULL) AS rolled_back FROM "_prisma_migrations" ORDER BY migration_name`,
    );
    expect(rows).toHaveLength(22);
    expect(rows.every((r) => r.finished && !r.rolled_back)).toBe(true);
    expect(rows.at(-1)!.migration_name).toBe(G22);
    const sql = readFileSync(new URL(`../../prisma/migrations/${G22}/migration.sql`, import.meta.url));
    expect(rows.at(-1)!.checksum).toBe(createHash('sha256').update(sql).digest('hex'));
  });

  it('PG-U2-03 the index is case-insensitive at the engine: a second e-mail differing only in case is rejected (23505), even from raw SQL', async () => {
    const t = tag();
    const a = randomUUID();
    await db.user.create({ data: { id: a, name: 'A', email: `Case-${t}@test.invalid`, passwordHash: currentHash } });
    await expect(pools[0]!.query('INSERT INTO "User" (id, name, email, "passwordHash", "isActive", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, true, now(), now())', [randomUUID(), 'B', `CASE-${t}@TEST.invalid`, currentHash]))
      .rejects.toMatchObject({ code: '23505', constraint: 'User_email_lower_key' });
    await expect(pools[0]!.query('INSERT INTO "User" (id, name, email, "passwordHash", "isActive", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, true, now(), now())', [randomUUID(), 'C', `case-${t}@test.invalid`, currentHash]))
      .rejects.toMatchObject({ code: '23505' });
  });

  // --- create ----------------------------------------------------------------------

  it('PG-U2-04 create persists user + scope + operation + audit; the temporary password verifies, lives only as a bcrypt hash, and is in no persisted artifact', async () => {
    const owner = await makeOwner();
    const loc = await makeLocation();
    const input = createInput(loc, { email: `  U2-Mixed-${tag()}@Test.Invalid ` });
    const res = await svc.create(owner.req, input);
    expect(res.replayed).toBe(false);
    const row = await stored(res.user.id);
    expect(row.email).toBe((input as { email: string }).email.trim().toLowerCase());
    expect(row.mustChangePassword).toBe(true);
    expect(row.isActive).toBe(true);
    expect(await verifyPassword(res.temporaryPassword!, row.passwordHash)).toBe(true);
    const scopes = await db.userRoleScope.findMany({ where: { userId: res.user.id } });
    expect(scopes).toHaveLength(1);
    expect(scopes[0]).toMatchObject({ roleId: sellerRoleId, scopeKind: 'LOCATION', locationId: loc });
    const operation = await ops(res.user.id);
    expect(operation).toHaveLength(1);
    expect(operation[0]).toMatchObject({ actorId: owner.id, operation: 'CREATE_USER' });
    const created = await audits(res.user.id, 'USER_CREATED');
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ userId: owner.id, branchId: null, entityType: 'User' });
    const everything = JSON.stringify([operation, created, await audits(res.user.id)]);
    expect(everything).not.toContain(res.temporaryPassword!);
    expect(everything).not.toMatch(/\$2[aby]\$/);
    // the audit JSON survives the real jsonb round trip with the documented shape
    expect(created[0]!.after).toMatchObject({ isActive: true, mustChangePassword: true, roleCode: 'SELLER', scopeKind: 'LOCATION', locationIds: [loc] });
  });

  it('PG-U2-05 RACE: Maria@… and maria@… created SIMULTANEOUSLY by two actors: exactly one account, one scope, one operation, one audit; the loser is EMAIL_TAKEN', async () => {
    const ownerA = await makeOwner();
    const ownerB = await makeOwner();
    const loc = await makeLocation();
    const t = tag();
    // both racers park on the Location FOR SHARE lock (after their e-mail pre-check passed), then race for the unique index
    const holder = await park('SELECT id FROM "Location" WHERE id = $1 FOR UPDATE', [loc]);
    let results: PromiseSettledResult<Awaited<ReturnType<typeof svc.create>>>[];
    try {
      const a = svcA.create(ownerA.req, createInput(loc, { email: `Race-${t}@Test.Invalid` }));
      const b = svcB.create(ownerB.req, createInput(loc, { email: `race-${t}@test.invalid` }));
      expect(await waitForBlocked(pools[0]!, holder.pid, 2, /FOR SHARE/)).toHaveLength(2);
      await holder.release();
      results = await withTimeout(Promise.allSettled([a, b]), RACE_TIMEOUT_MS, 'the two creates');
    } finally {
      await holder.release();
    }
    const winners = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof svc.create>>>[];
    const losers = results.filter((r) => r.status === 'rejected');
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(failureOf(losers[0]!)).toMatchObject({ status: 409, code: 'EMAIL_TAKEN' });
    const accounts = await byEmail(`race-${t}@test.invalid`);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.id).toBe(winners[0]!.value.user.id);
    expect(await db.userRoleScope.count({ where: { userId: accounts[0]!.id } })).toBe(1);
    expect(await ops(accounts[0]!.id)).toHaveLength(1);
    expect(await audits(accounts[0]!.id, 'USER_CREATED')).toHaveLength(1);
    // the loser left NOTHING behind: its operation record is gone with its rolled-back transaction
    expect(await db.userAdminOperation.count({ where: { actorId: { in: [ownerA.id, ownerB.id] } } })).toBe(1);
  }, RACE_TIMEOUT_MS);

  it('PG-U2-06 RACE: the SAME key and intent arriving twice at once: one real create (password issued once), the other resolves to the REPLAY; one account, one audit', async () => {
    const owner = await makeOwner();
    const loc = await makeLocation();
    const input = createInput(loc);
    const holder = await park('SELECT id FROM "Location" WHERE id = $1 FOR UPDATE', [loc]);
    let results: PromiseSettledResult<Awaited<ReturnType<typeof svc.create>>>[];
    try {
      const a = svcA.create(owner.req, input);
      const b = svcB.create(owner.req, input);
      expect(await waitForBlocked(pools[0]!, holder.pid, 2, /FOR SHARE/)).toHaveLength(2);
      await holder.release();
      results = await withTimeout(Promise.allSettled([a, b]), RACE_TIMEOUT_MS, 'the two creates');
    } finally {
      await holder.release();
    }
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    const values = results.map((r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof svc.create>>>).value);
    expect(values.filter((v) => !v.replayed)).toHaveLength(1);
    const replay = values.find((v) => v.replayed)!;
    const real = values.find((v) => !v.replayed)!;
    expect(replay.temporaryPassword).toBeNull();
    expect(real.temporaryPassword).not.toBeNull();
    expect(replay.user.id).toBe(real.user.id);
    expect(await byEmail((input as { email: string }).email)).toHaveLength(1);
    expect(await ops(real.user.id)).toHaveLength(1);
    expect(await audits(real.user.id, 'USER_CREATED')).toHaveLength(1);
    expect(await verifyPassword(real.temporaryPassword!, (await stored(real.user.id)).passwordHash)).toBe(true);
  }, RACE_TIMEOUT_MS);

  it('PG-U2-07 RACE: the SAME key with DIFFERENT intents: one wins, the other is 409 IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD and creates no account', async () => {
    const owner = await makeOwner();
    const loc = await makeLocation();
    const k = key();
    const first = createInput(loc, { idempotencyKey: k });
    const second = createInput(loc, { idempotencyKey: k });
    const holder = await park('SELECT id FROM "Location" WHERE id = $1 FOR UPDATE', [loc]);
    let results: PromiseSettledResult<Awaited<ReturnType<typeof svc.create>>>[];
    try {
      const a = svcA.create(owner.req, first);
      const b = svcB.create(owner.req, second);
      expect(await waitForBlocked(pools[0]!, holder.pid, 2, /FOR SHARE/)).toHaveLength(2);
      await holder.release();
      results = await withTimeout(Promise.allSettled([a, b]), RACE_TIMEOUT_MS, 'the two creates');
    } finally {
      await holder.release();
    }
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(failureOf(results.find((r) => r.status === 'rejected')!)).toMatchObject({ status: 409, code: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD' });
    const emails = [(first as { email: string }).email, (second as { email: string }).email];
    const present = (await Promise.all(emails.map(byEmail))).flat();
    expect(present).toHaveLength(1);
    expect(await db.userAdminOperation.count({ where: { actorId: owner.id, idempotencyKey: k } })).toBe(1);
  }, RACE_TIMEOUT_MS);

  it('PG-U2-08 a legacy MIXED-CASE e-mail is protected: create with another capitalisation is EMAIL_TAKEN and login finds it in any capitalisation', async () => {
    const owner = await makeOwner();
    const loc = await makeLocation();
    const t = tag();
    const id = randomUUID();
    await pools[0]!.query('INSERT INTO "User" (id, name, email, "passwordHash", "isActive", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, true, now(), now())', [id, 'Legacy', `Legacy-${t}@Test.Invalid`, currentHash]);
    await expect(svc.create(owner.req, createInput(loc, { email: `legacy-${t}@test.invalid` }))).rejects.toMatchObject({ status: 409, code: 'EMAIL_TAKEN' });
    const app = createApp(db);
    for (const email of [`Legacy-${t}@Test.Invalid`, `legacy-${t}@test.invalid`, `LEGACY-${t}@TEST.INVALID`]) {
      expect((await request(app).post('/api/v1/auth/login').send({ email, password: CURRENT })).status, email).toBe(200);
    }
    expect(await db.userAdminOperation.count({ where: { actorId: owner.id } })).toBe(0);
  });

  it('PG-U2-09 ATOMICITY: an audit failure after the user, scope and operation inserts rolls EVERYTHING back (temporary trigger, always dropped)', async () => {
    const owner = await makeOwner();
    const loc = await makeLocation();
    const email = `u2-atomic-${tag()}@test.invalid`;
    const fn = `u2_fail_${tag()}`;
    await pools[0]!.query(`CREATE FUNCTION "${fn}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'USER_CREATED' AND NEW."userId" = '${owner.id}' THEN RAISE EXCEPTION 'injected audit failure'; END IF; RETURN NEW; END $$`);
    await pools[0]!.query(`CREATE TRIGGER "${fn}" BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION "${fn}"()`);
    try {
      await expect(svc.create(owner.req, createInput(loc, { email }))).rejects.toThrow();
    } finally {
      await pools[0]!.query(`DROP TRIGGER IF EXISTS "${fn}" ON "AuditLog"`);
      await pools[0]!.query(`DROP FUNCTION IF EXISTS "${fn}"()`);
    }
    expect(await byEmail(email)).toHaveLength(0);
    expect(await db.userAdminOperation.count({ where: { actorId: owner.id } })).toBe(0);
    expect(await db.auditLog.count({ where: { userId: owner.id, action: 'USER_CREATED' } })).toBe(0);
    // and the same call works once the trigger is gone (the failure was the trigger's, nothing was left half-done)
    expect((await svc.create(owner.req, createInput(loc, { email }))).replayed).toBe(false);
  });

  it('PG-U2-10 an inactive Location is refused and a Location closed AFTER the scope was granted blocks the reactivation', async () => {
    const owner = await makeOwner();
    const closed = await makeLocation(false);
    await expect(svc.create(owner.req, createInput(closed))).rejects.toMatchObject({ status: 400, code: 'LOCATION_INACTIVE' });
    const loc = await makeLocation();
    const seller = await makeSeller(loc, { isActive: false });
    await pools[0]!.query('UPDATE "Location" SET "isActive" = false WHERE id = $1', [loc]);
    const hashBefore = (await stored(seller.id)).passwordHash;
    await expect(svc.reactivate(owner.req, seller.id, { idempotencyKey: key() })).rejects.toMatchObject({ status: 400, code: 'LOCATION_INACTIVE' });
    expect((await stored(seller.id)).passwordHash).toBe(hashBefore);
    expect((await stored(seller.id)).isActive).toBe(false);
  });

  // --- reset password ----------------------------------------------------------------

  it('PG-U2-11 RACE: two resets of the SAME account with DIFFERENT keys serialize on the row lock: two real resets, the second epoch strictly greater, the final hash is the LAST one', async () => {
    const owner = await makeOwner();
    const loc = await makeLocation();
    const seller = await makeSeller(loc);
    const holder = await park('SELECT id FROM "User" WHERE id = $1 FOR UPDATE', [seller.id]);
    let results: PromiseSettledResult<Awaited<ReturnType<typeof svc.resetPassword>>>[];
    try {
      const a = svcA.resetPassword(owner.req, seller.id, { idempotencyKey: key() });
      const b = svcB.resetPassword(owner.req, seller.id, { idempotencyKey: key() });
      expect(await waitForBlocked(pools[0]!, holder.pid, 2, /FOR NO KEY UPDATE/)).toHaveLength(2);
      await holder.release();
      results = await withTimeout(Promise.allSettled([a, b]), RACE_TIMEOUT_MS, 'the two resets');
    } finally {
      await holder.release();
    }
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    const values = results.map((r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof svc.resetPassword>>>).value);
    expect(values.every((v) => !v.replayed && v.temporaryPassword !== null)).toBe(true);
    const row = await stored(seller.id);
    const live = [];
    for (const v of values) if (await verifyPassword(v.temporaryPassword!, row.passwordHash)) live.push(v);
    expect(live).toHaveLength(1); // exactly one of the two passwords is the current one
    const resetAudits = await audits(seller.id, 'USER_PASSWORD_RESET');
    expect(resetAudits).toHaveLength(2);
    const epochs = resetAudits.map((a) => Date.parse((a.after as { credentialsChangedAt: string }).credentialsChangedAt)).sort((x, y) => x - y);
    expect(epochs[1]!).toBeGreaterThan(epochs[0]!);
    expect(row.credentialsChangedAt!.getTime()).toBe(epochs[1]!); // the stored epoch is the LAST one
    expect(await ops(seller.id)).toHaveLength(2);
  }, RACE_TIMEOUT_MS);

  it('PG-U2-12 RACE: the SAME reset key twice at once: one real reset, one replay; one audit, one epoch, the password issued once is the live one', async () => {
    const owner = await makeOwner();
    const loc = await makeLocation();
    const seller = await makeSeller(loc);
    const k = key();
    const holder = await park('SELECT id FROM "User" WHERE id = $1 FOR UPDATE', [seller.id]);
    let results: PromiseSettledResult<Awaited<ReturnType<typeof svc.resetPassword>>>[];
    try {
      const a = svcA.resetPassword(owner.req, seller.id, { idempotencyKey: k });
      const b = svcB.resetPassword(owner.req, seller.id, { idempotencyKey: k });
      expect(await waitForBlocked(pools[0]!, holder.pid, 2, /FOR NO KEY UPDATE/)).toHaveLength(2);
      await holder.release();
      results = await withTimeout(Promise.allSettled([a, b]), RACE_TIMEOUT_MS, 'the two resets');
    } finally {
      await holder.release();
    }
    const values = results.map((r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof svc.resetPassword>>>).value);
    expect(values.filter((v) => !v.replayed)).toHaveLength(1);
    const real = values.find((v) => !v.replayed)!;
    const replay = values.find((v) => v.replayed)!;
    expect(replay.temporaryPassword).toBeNull();
    expect(await verifyPassword(real.temporaryPassword!, (await stored(seller.id)).passwordHash)).toBe(true);
    expect(await audits(seller.id, 'USER_PASSWORD_RESET')).toHaveLength(1);
    expect(await ops(seller.id)).toHaveLength(1);
  }, RACE_TIMEOUT_MS);

  // --- edit --------------------------------------------------------------------------

  it('PG-U2-13 RACE: two edits of DIFFERENT accounts to the SAME e-mail (different capitalisation) parked on an uncommitted ghost of that e-mail: exactly one wins, the other is EMAIL_TAKEN', async () => {
    const owner = await makeOwner();
    const loc = await makeLocation();
    const x = await makeSeller(loc);
    const y = await makeSeller(loc);
    const t = tag();
    const ghost = randomUUID();
    // an UNCOMMITTED row holding the e-mail: both edits block on the unique index until the ghost rolls back
    const holder = await park('INSERT INTO "User" (id, name, email, "passwordHash", "isActive", "createdAt", "updatedAt") VALUES ($1, \'ghost\', $2, \'x\', true, now(), now())', [ghost, `edit-${t}@test.invalid`]);
    let results: PromiseSettledResult<Awaited<ReturnType<typeof svc.update>>>[];
    try {
      const a = svcA.update(owner.req, x.id, { email: `Edit-${t}@Test.Invalid` });
      const b = svcB.update(owner.req, y.id, { email: `edit-${t}@test.invalid` });
      expect(await waitForBlocked(pools[0]!, holder.pid, 2, /UPDATE .*"User"/)).toHaveLength(2);
      await holder.release(); // the ghost disappears: both proceed against the same index entry
      results = await withTimeout(Promise.allSettled([a, b]), RACE_TIMEOUT_MS, 'the two edits');
    } finally {
      await holder.release();
    }
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(failureOf(results.find((r) => r.status === 'rejected')!)).toMatchObject({ status: 409, code: 'EMAIL_TAKEN' });
    expect(await byEmail(`edit-${t}@test.invalid`)).toHaveLength(1);
    expect(await db.auditLog.count({ where: { entityId: { in: [x.id, y.id] }, action: 'USER_UPDATED' } })).toBe(1);
  }, RACE_TIMEOUT_MS);

  // --- the whole flow over HTTP -----------------------------------------------------------

  it('PG-U2-14 HTTP end to end on the real middleware: create -> login (any capitalisation) -> blocked -> change password -> deactivate ends the session -> reactivate -> reset', async () => {
    const owner = await makeOwner();
    const loc = await makeLocation();
    const app = createApp(db);
    const ownerHeader = { Authorization: `Bearer ${await signAccessToken(owner.id, null)}` };
    const email = `u2-flow-${tag()}@test.invalid`;
    const body = { name: 'Flow User', email: email.toUpperCase(), roleCode: 'SELLER', scopeKind: 'LOCATION', locationIds: [loc], idempotencyKey: key() };

    const created = await request(app).post(BASE).set(ownerHeader).send(body);
    expect(created.status).toBe(201);
    expect(created.headers['cache-control']).toBe('no-store');
    const userId = created.body.user.id as string;
    const temporary = created.body.temporaryPassword as string;
    expect((await request(app).post(BASE).set(ownerHeader).send(body)).body).toMatchObject({ replayed: true, temporaryPassword: null });

    const login = await request(app).post('/api/v1/auth/login').send({ email: email.toUpperCase(), password: temporary });
    expect(login.status).toBe(200);
    const blocked = await request(app).get(BASE).set({ Authorization: `Bearer ${login.body.accessToken}` });
    expect(blocked.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    const changed = await request(app).post('/api/v1/auth/change-password').set({ Authorization: `Bearer ${login.body.accessToken}` }).send({ currentPassword: temporary, newPassword: 'definitive-password-789' });
    expect(changed.status).toBe(200);
    const live = { Authorization: `Bearer ${changed.body.accessToken}` };
    expect((await request(app).get('/api/v1/auth/me').set(live)).status).toBe(200);

    const off = await request(app).post(`${BASE}/${userId}/deactivate`).set(ownerHeader).send({ idempotencyKey: key() });
    expect(off.status).toBe(200);
    expect((await request(app).get('/api/v1/auth/me').set(live)).status).toBe(403);
    expect((await request(app).post('/api/v1/auth/login').send({ email, password: 'definitive-password-789' })).status).toBe(403);

    const back = await request(app).post(`${BASE}/${userId}/reactivate`).set(ownerHeader).send({ idempotencyKey: key() });
    expect(back.status).toBe(200);
    expect((await request(app).post('/api/v1/auth/login').send({ email, password: 'definitive-password-789' })).status).toBe(401);
    const again = await request(app).post('/api/v1/auth/login').send({ email, password: back.body.temporaryPassword });
    expect(again.status).toBe(200);
    expect(again.body.user.mustChangePassword).toBe(true);

    const reset = await request(app).post(`${BASE}/${userId}/reset-password`).set(ownerHeader).send({ idempotencyKey: key() });
    expect(reset.status).toBe(200);
    expect((await request(app).get('/api/v1/auth/me').set({ Authorization: `Bearer ${again.body.accessToken}` })).status).toBe(401); // the epoch moved
    expect((await audits(userId)).map((a) => a.action).sort()).toEqual(['USER_CREATED', 'USER_DEACTIVATED', 'USER_PASSWORD_CHANGED', 'USER_PASSWORD_RESET', 'USER_REACTIVATED']);
    // no persisted artifact of this account holds any password it ever had
    const dump = JSON.stringify([await audits(userId), await ops(userId)]);
    for (const secret of [temporary, 'definitive-password-789', back.body.temporaryPassword, reset.body.temporaryPassword]) expect(dump).not.toContain(secret);
  }, RACE_TIMEOUT_MS);
});
