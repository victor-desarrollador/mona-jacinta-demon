// USER-MGMT-01 U1 (G21) — the opt-in PostgreSQL gate for the credentials epoch and POST /auth/change-password. OPT-IN ONLY.
// What only a real PostgreSQL proves here: the live G21 DDL (defaults on existing/old-API-shaped rows, the ledger), the exact
// TIMESTAMPTZ(3) millisecond round trip of the epoch (the token's `cc` must EQUAL the stored value), the real row lock
// (SELECT ... FOR NO KEY UPDATE) that serializes two simultaneous changes made with the SAME current password, the atomicity of
// password + flag + epoch + audit under an injected audit failure, and the middleware's epoch equality over a real database.
//
// Requires an OWNER-authorized, DISPOSABLE, isolated LOCAL_TEST cluster with migrations 1–21 and the canonical baseline catalog, bound by
// marker + system id:
//   MONA_USER_CREDENTIALS_PG=1 MONA_USER_CREDENTIALS_PG_DISPOSABLE=1
//   MONA_TEST_DATABASE_TARGET=local LOCAL_TEST_DATABASE_URL=… LOCAL_TEST_DATABASE_MARKER_ID=…
//   MONA_USER_CREDENTIALS_PG_SYSTEM_ID=<pg_control_system().system_identifier>
// Fixtures are COMMITTED and PERMANENT by design (unique emails per run; nothing baseline-owned is ever mutated), hence the explicit
// DISPOSABLE acknowledgement: the cluster is discarded afterwards, never reused. The audit-failure case installs a temporary trigger on
// "AuditLog" and always drops it in `finally`.
//
// OVERLAP IS PROVEN, NOT ASSUMED (the audited R3-U2 convention): the race first holds the contended User row lock on an independent
// COORDINATOR connection, starts the two real service calls on independent pools, and only releases after pg_stat_activity +
// pg_blocking_pids prove both racing backends are genuinely in the coordinator's lock-wait chain.
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PrismaPg } from '@prisma/adapter-pg';
import { decodeJwt } from 'jose';
import type { Pool, PoolClient } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { PrismaClient } from '../../src/generated/prisma/client.js';
import { changePassword } from '../../src/modules/auth/auth.service.js';
import { hashPassword, verifyPassword } from '../../src/modules/auth/password.js';
import { signAccessToken } from '../../src/modules/auth/tokens.js';
import { AppError } from '../../src/shared/errors.js';
import { PG_SYSTEM_ID, RACE_TIMEOUT_MS, waitForBlocked, withTimeout } from '../helpers/r3-service-pg.js';

const enabled = process.env.MONA_USER_CREDENTIALS_PG === '1';
const G21 = '20261101120000_user_credentials_epoch';
const CURRENT = 'current-password-123';

describe.skipIf(!enabled)('USER-MGMT-01 U1 (G21) on PostgreSQL — credentials epoch and change-password (disposable cluster)', () => {
  const pools: Pool[] = [];
  const clients: PrismaClient[] = [];
  let db: PrismaClient;
  let racerA: PrismaClient;
  let racerB: PrismaClient;
  let currentHash = '';

  beforeAll(async () => {
    if (process.env.MONA_USER_CREDENTIALS_PG_DISPOSABLE !== '1') {
      throw new Error('this suite writes permanent rows: MONA_USER_CREDENTIALS_PG_DISPOSABLE=1 is required');
    }
    if (process.env.MONA_TEST_DATABASE_TARGET !== 'local') throw new Error('LOCAL_TEST selector required');
    const expectedSystemId = process.env.MONA_USER_CREDENTIALS_PG_SYSTEM_ID;
    if (!expectedSystemId || !PG_SYSTEM_ID.test(expectedSystemId)) {
      throw new Error('isolated cluster binding is missing: MONA_USER_CREDENTIALS_PG_SYSTEM_ID must be the decimal pg_control_system().system_identifier of the target');
    }
    const { openProvenLocalTestPool } = await import('../../scripts/demo-database.js');
    // pools[0]: coordinator + fixtures + observer; pools[1]/pools[2]: racers.
    for (const max of [6, 2, 2]) {
      const { pool } = await openProvenLocalTestPool(max, process.env);
      pools.push(pool);
      clients.push(new PrismaClient({ adapter: new PrismaPg(pool, { schema: 'public' }), log: [] }));
    }
    [db, racerA, racerB] = clients as [PrismaClient, PrismaClient, PrismaClient];
    const { rows } = await pools[0]!.query<{ system_id: string; migrated: boolean }>(
      `SELECT system_identifier::text AS system_id,
              EXISTS (SELECT 1 FROM "_prisma_migrations" WHERE migration_name = '${G21}' AND finished_at IS NOT NULL AND rolled_back_at IS NULL) AS migrated
         FROM pg_control_system()`,
    );
    if (rows[0]?.system_id !== expectedSystemId) throw new Error('isolated PostgreSQL cluster does not match binding');
    if (rows[0]?.migrated !== true) throw new Error('migration 21 (G21) is required');
    currentHash = await hashPassword(CURRENT);
  });

  afterAll(async () => {
    for (const client of clients) await client.$disconnect();
    for (const pool of pools) await pool.end();
  });

  // --- fixtures ---------------------------------------------------------------

  async function makeUser(patch: { mustChangePassword?: boolean; credentialsChangedAt?: Date | null } = {}): Promise<{ id: string; email: string }> {
    const id = randomUUID();
    const email = `u1-${id.slice(0, 8)}@test.invalid`;
    await db.user.create({ data: { id, name: `U1 ${id.slice(0, 8)}`, email, passwordHash: currentHash, ...patch } });
    return { id, email };
  }

  // The coordinator: holds the user's row lock on its own connection until released.
  async function holdUserLock(id: string): Promise<{ pid: number; release: () => Promise<void> }> {
    const client: PoolClient = await pools[0]!.connect();
    await client.query('BEGIN');
    await client.query('SELECT id FROM "User" WHERE id = $1 FOR UPDATE', [id]);
    const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    let done = false;
    return {
      pid: rows[0]!.pid,
      release: async () => {
        if (done) return;
        done = true;
        try { await client.query('ROLLBACK'); } finally { client.release(); }
      },
    };
  }

  const stored = async (id: string) => (await db.user.findUniqueOrThrow({ where: { id } }));
  const auditRows = (id: string) => db.auditLog.findMany({ where: { entityId: id, action: 'USER_PASSWORD_CHANGED' } });
  const meOf = (app: ReturnType<typeof createApp>, token: string) => request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`);

  // --- schema and compatibility ------------------------------------------------

  it('PG-U1-01 the live G21 DDL: mustChangePassword boolean NOT NULL DEFAULT false; credentialsChangedAt timestamptz(3) NULL, no default', async () => {
    const { rows } = await pools[0]!.query<{ column_name: string; data_type: string; datetime_precision: number | null; is_nullable: string; column_default: string | null }>(
      `SELECT column_name, data_type, datetime_precision, is_nullable, column_default
         FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'User' AND column_name IN ('mustChangePassword', 'credentialsChangedAt')
        ORDER BY column_name`,
    );
    expect(rows).toEqual([
      { column_name: 'credentialsChangedAt', data_type: 'timestamp with time zone', datetime_precision: 3, is_nullable: 'YES', column_default: null },
      { column_name: 'mustChangePassword', data_type: 'boolean', datetime_precision: null, is_nullable: 'NO', column_default: 'false' },
    ]);
  });

  it('PG-U1-02 the ledger holds finished migrations and G21 is the 21st (G22 follows it), with the reviewed checksum', async () => {
    const { rows } = await pools[0]!.query<{ migration_name: string; checksum: string; finished: boolean; rolled_back: boolean }>(
      `SELECT migration_name, checksum, (finished_at IS NOT NULL) AS finished, (rolled_back_at IS NOT NULL) AS rolled_back FROM "_prisma_migrations" ORDER BY migration_name`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(21);
    expect(rows.every((r) => r.finished && !r.rolled_back)).toBe(true);
    expect(rows[20]!.migration_name).toBe(G21); // USER-MGMT-01 U2: G22 is applied after it, G21 itself is untouched
    const sql = readFileSync(new URL(`../../prisma/migrations/${G21}/migration.sql`, import.meta.url));
    expect(rows[20]!.checksum).toBe(createHash('sha256').update(sql).digest('hex'));
  });

  it('PG-U1-03 an existing/old-API-shaped row (an INSERT that does not name the new columns) gets false / NULL: it keeps working with its legacy token and its password', async () => {
    const id = randomUUID();
    const email = `legacy-${id.slice(0, 8)}@test.invalid`;
    // exactly the column list a G20 API writes (Prisma names its columns explicitly; the two new ones are absent)
    await pools[0]!.query('INSERT INTO "User" (id, name, email, "passwordHash", "isActive", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, true, now(), now())', [id, 'Legacy', email, currentHash]);
    const row = await stored(id);
    expect(row.mustChangePassword).toBe(false);
    expect(row.credentialsChangedAt).toBeNull();
    const app = createApp(db);
    const login = await request(app).post('/api/v1/auth/login').send({ email, password: CURRENT });
    expect(login.status).toBe(200);
    expect(decodeJwt(login.body.accessToken as string)).not.toHaveProperty('cc');
    expect((await meOf(app, await signAccessToken(id))).status).toBe(200); // a legacy-shaped token stays valid while the epoch is NULL
    expect(login.body.user.mustChangePassword).toBe(false);
  });

  // --- the epoch over a real database --------------------------------------------

  it('PG-U1-04 millisecond round trip: the epoch the service commits, the value PostgreSQL stores and the token\'s cc are the same integer', async () => {
    const { id } = await makeUser();
    const result = await changePassword(db, id, { currentPassword: CURRENT, newPassword: 'round-trip-pass-456' });
    const { rows } = await pools[0]!.query<{ ms: string }>('SELECT (extract(epoch FROM "credentialsChangedAt") * 1000)::bigint::text AS ms FROM "User" WHERE id = $1', [id]);
    const cc = decodeJwt(result.accessToken).cc as number;
    expect(Number.isSafeInteger(cc)).toBe(true);
    expect(BigInt(rows[0]!.ms)).toBe(BigInt(cc));
    expect((await stored(id)).credentialsChangedAt!.getTime()).toBe(cc);
  });

  it('PG-U1-05 end to end on the real middleware: the previous token dies, the new one lives, and two consecutive changes kill the first change\'s token', async () => {
    const { id, email } = await makeUser({ mustChangePassword: true });
    const app = createApp(db);
    const temp = await request(app).post('/api/v1/auth/login').send({ email, password: CURRENT });
    expect(temp.status).toBe(200);
    expect(temp.body.user.mustChangePassword).toBe(true);
    const blocked = await request(app).get('/api/v1/cash/register?branchId=00000000-0000-4000-8000-000000000000').set('Authorization', `Bearer ${temp.body.accessToken}`);
    expect(blocked.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');

    const first = await request(app).post('/api/v1/auth/change-password').set('Authorization', `Bearer ${temp.body.accessToken}`).send({ currentPassword: CURRENT, newPassword: 'first-new-password-1' });
    expect(first.status).toBe(200);
    expect(first.headers['cache-control']).toMatch(/no-store/);
    expect(first.body.user.mustChangePassword).toBe(false);
    expect((await stored(id)).mustChangePassword).toBe(false);
    expect((await meOf(app, temp.body.accessToken as string)).status).toBe(401); // the temporary credentials' token
    expect((await meOf(app, first.body.accessToken as string)).status).toBe(200);

    const second = await request(app).post('/api/v1/auth/change-password').set('Authorization', `Bearer ${first.body.accessToken}`).send({ currentPassword: 'first-new-password-1', newPassword: 'second-new-password-2' });
    expect(second.status).toBe(200);
    expect((await meOf(app, first.body.accessToken as string)).status).toBe(401);
    expect((await meOf(app, second.body.accessToken as string)).status).toBe(200);
    expect(decodeJwt(second.body.accessToken as string).cc as number).toBeGreaterThan(decodeJwt(first.body.accessToken as string).cc as number);
    expect((await auditRows(id))).toHaveLength(2);
    expect((await request(app).post('/api/v1/auth/login').send({ email, password: CURRENT })).status).toBe(401);
    expect((await request(app).post('/api/v1/auth/login').send({ email, password: 'second-new-password-2' })).status).toBe(200);
  }, RACE_TIMEOUT_MS);

  // --- the epoch under a non-UTC server time zone ----------------------------------------
  // ROOT CAUSE (measured, see the U1 report): @prisma/adapter-pg serializes a JS Date parameter as a zone-less UTC wall-clock literal and
  // reads TIMESTAMPTZ back the same way, so under a server/session TimeZone other than UTC the instant PostgreSQL stores is shifted by the zone
  // offset for EVERY timestamptz this app writes (a plain `pg` Date parameter, or an ISO string with Z, is exact). Production (Supabase) and the
  // CI container run UTC. What U1 owns is that the credentials EPOCH EQUALITY is independent of the zone: write and read go through the same
  // adapter, so the token's `cc`, the value the middleware reads and the new token's validity hold under any TimeZone. The absolute instant
  // seen by raw SQL is exact under UTC (asserted) and zone-shifted under the others (a repo-wide adapter property, not asserted here).
  // New connections inherit the database-level TimeZone, so a FRESH pool is opened after ALTER DATABASE and the setting is always restored.
  it.each(['UTC', 'America/Argentina/Buenos_Aires', 'Asia/Kolkata'])('PG-U1-09 under TimeZone=%s the epoch equality holds: token cc = value read back, the new token is valid, the previous one is not', async (zone) => {
    const dbName = (await pools[0]!.query<{ n: string }>('SELECT current_database() AS n')).rows[0]!.n;
    await pools[0]!.query(`ALTER DATABASE "${dbName}" SET timezone TO '${zone}'`);
    let probePool: Pool | undefined;
    let probeDb: PrismaClient | undefined;
    try {
      const { openProvenLocalTestPool } = await import('../../scripts/demo-database.js');
      probePool = (await openProvenLocalTestPool(2, process.env)).pool;
      probeDb = new PrismaClient({ adapter: new PrismaPg(probePool, { schema: 'public' }), log: [] });
      expect((await probePool.query<{ tz: string }>("SELECT current_setting('timezone') AS tz")).rows[0]!.tz).toBe(zone);
      const { id } = await makeUser();
      const before = Date.now();
      const previous = await signAccessToken(id);
      const result = await changePassword(probeDb, id, { currentPassword: CURRENT, newPassword: 'zone-check-password-1' });
      const after = Date.now();
      const cc = decodeJwt(result.accessToken).cc as number;
      expect(cc).toBeGreaterThanOrEqual(before - 1000); // the epoch is "now" as the application sees it
      expect(cc).toBeLessThanOrEqual(after + 1000);
      expect((await probeDb.user.findUniqueOrThrow({ where: { id } })).credentialsChangedAt!.getTime()).toBe(cc);
      const app = createApp(probeDb);
      expect((await meOf(app, result.accessToken)).status).toBe(200);
      expect((await meOf(app, previous)).status).toBe(401);
      if (zone === 'UTC') {
        const { rows } = await probePool.query<{ ms: string }>('SELECT (extract(epoch FROM "credentialsChangedAt") * 1000)::bigint::text AS ms FROM "User" WHERE id = $1', [id]);
        expect(Number(rows[0]!.ms)).toBe(cc); // the absolute instant, exact
      }
    } finally {
      await probeDb?.$disconnect();
      await probePool?.end();
      await pools[0]!.query(`ALTER DATABASE "${dbName}" RESET timezone`);
    }
  }, RACE_TIMEOUT_MS);

  // --- the race --------------------------------------------------------------------

  it('PG-U1-06 two SIMULTANEOUS changes with the SAME current password: exactly one wins, the other fails on the winner\'s committed hash; one audit; one epoch; the winner\'s token is the valid one', async () => {
    const { id, email } = await makeUser({ mustChangePassword: true });
    const holder = await holdUserLock(id);
    let results: PromiseSettledResult<{ accessToken: string }>[];
    try {
      const a = changePassword(racerA, id, { currentPassword: CURRENT, newPassword: 'racer-a-password-111' });
      const b = changePassword(racerB, id, { currentPassword: CURRENT, newPassword: 'racer-b-password-222' });
      // both requests must be genuinely waiting on the coordinator's lock INSIDE their transaction before it is released
      const blockedOn = await waitForBlocked(pools[0]!, holder.pid, 2, /FOR NO KEY UPDATE/);
      expect(blockedOn).toHaveLength(2);
      await holder.release();
      results = await withTimeout(Promise.allSettled([a, b]), RACE_TIMEOUT_MS, 'the two changes');
    } finally {
      await holder.release();
    }

    const winners = results.map((r, i) => ({ r, name: i === 0 ? 'racer-a-password-111' : 'racer-b-password-222' })).filter((x) => x.r.status === 'fulfilled');
    const losers = results.filter((r) => r.status === 'rejected');
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    const lost = (losers[0] as PromiseRejectedResult).reason;
    expect(lost).toBeInstanceOf(AppError);
    expect((lost as AppError).code).toBe('INVALID_CURRENT_PASSWORD');
    expect((lost as AppError).status).toBe(400);

    const winnerPassword = winners[0]!.name;
    const loserPassword = winnerPassword === 'racer-a-password-111' ? 'racer-b-password-222' : 'racer-a-password-111';
    const winnerToken = (winners[0]!.r as PromiseFulfilledResult<{ accessToken: string }>).value.accessToken;
    const row = await stored(id);
    expect(await verifyPassword(winnerPassword, row.passwordHash)).toBe(true);
    expect(await verifyPassword(loserPassword, row.passwordHash)).toBe(false);
    expect(await verifyPassword(CURRENT, row.passwordHash)).toBe(false);
    expect(row.mustChangePassword).toBe(false);
    expect(decodeJwt(winnerToken).cc).toBe(row.credentialsChangedAt!.getTime()); // ONE epoch, and it is the winner's
    const audits = await auditRows(id);
    expect(audits).toHaveLength(1); // exactly one successful USER_PASSWORD_CHANGED
    expect(audits[0]).toMatchObject({ userId: id, entityId: id, entityType: 'User' });

    const app = createApp(db);
    expect((await meOf(app, winnerToken)).status).toBe(200);
    expect((await meOf(app, await signAccessToken(id))).status).toBe(401); // a token without the epoch (the credentials before the change)
    expect((await request(app).post('/api/v1/auth/login').send({ email, password: CURRENT })).status).toBe(401);
    expect((await request(app).post('/api/v1/auth/login').send({ email, password: winnerPassword })).status).toBe(200);
    expect((await request(app).post('/api/v1/auth/login').send({ email, password: loserPassword })).status).toBe(401);
  }, RACE_TIMEOUT_MS);

  it('PG-U1-07 the audit row holds no secret: not a password, not a hash, not a token, in the committed jsonb either', async () => {
    const { id } = await makeUser();
    const result = await changePassword(db, id, { currentPassword: CURRENT, newPassword: 'audit-secret-check-789' });
    const text = JSON.stringify(await auditRows(id));
    const row = await stored(id);
    for (const secret of [CURRENT, 'audit-secret-check-789', currentHash, row.passwordHash, result.accessToken]) expect(text).not.toContain(secret);
    expect(text).not.toMatch(/\$2[aby]\$/);
  });

  // --- atomicity -------------------------------------------------------------------

  it('PG-U1-08 an audit failure rolls the WHOLE change back on the real engine: old hash, flag and epoch intact, no audit row, no token', async () => {
    const { id } = await makeUser({ mustChangePassword: true });
    const fn = `u1_fail_${randomUUID().slice(0, 8)}`;
    await pools[0]!.query(`CREATE FUNCTION "${fn}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."entityId" = '${id}' AND NEW.action = 'USER_PASSWORD_CHANGED' THEN RAISE EXCEPTION 'injected audit failure'; END IF; RETURN NEW; END $$`);
    await pools[0]!.query(`CREATE TRIGGER "${fn}" BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION "${fn}"()`);
    try {
      const error = await changePassword(db, id, { currentPassword: CURRENT, newPassword: 'rolled-back-pass-000' }).then(() => null, (e: unknown) => e);
      expect(error).not.toBeNull();
    } finally {
      await pools[0]!.query(`DROP TRIGGER IF EXISTS "${fn}" ON "AuditLog"`);
      await pools[0]!.query(`DROP FUNCTION IF EXISTS "${fn}"()`);
    }
    const row = await stored(id);
    expect(row.passwordHash).toBe(currentHash);
    expect(row.mustChangePassword).toBe(true);
    expect(row.credentialsChangedAt).toBeNull();
    expect(await auditRows(id)).toHaveLength(0);
  });
});
