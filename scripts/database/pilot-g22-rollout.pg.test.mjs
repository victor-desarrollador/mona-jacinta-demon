// OPT-IN PostgreSQL tests of the USER-MGMT rollout core (pilot-g22-rollout.mjs) against a REAL disposable PostgreSQL 17 cluster, with the REAL reviewed migrations, the REAL
// pinned references (digest, probes, the 360 columns / 38 relations fingerprint) and the REAL `prisma migrate deploy` over staged prefix trees (21 then 22 migrations).
// Skipped unless ALL of these hold (it writes permanent rows and drops the `public` schema of its target between scenarios):
//   MONA_G22_ROLLOUT_PG=1  MONA_G22_ROLLOUT_PG_DISPOSABLE=1  MONA_G22_ROLLOUT_PG_SYSTEM_ID=<pg_control_system().system_identifier of the target>
//   LOCAL_TEST_DATABASE_URL=postgresql://…@127.0.0.1:5432/mona_local_test   (exactly the canonical loopback LOCAL_TEST target; anything else is refused)
// Run it only inside a private network namespace on a throwaway cluster (the repository's cutover-lab / N-1 drivers do exactly that). It never reads a PILOT file.
//
// Scope: the migration SQL semantics (what a collision leaves behind), the data guards against a real schema, the real Prisma ledger shape after a failed step, the
// resume, and the verifier on a real EXACT_G22 database. The TLS and PILOT-marker proofs of the CLIs are covered by the hermetic tests; here the marker is a local
// stand-in table with the same name so the same snapshot code runs.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as R from './pilot-g22-rollout.mjs';
import { GENERATION_MIGRATION_PINS, pinsOf } from './pilot-migration-generations.mjs';
import { CATALOG_38 } from './pilot-rbac-catalog-generations.mjs';
import { catalogRows } from './pilot-g22-fake-db.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(path.join(REPO, 'api', 'package.json'));
const MARKER = '2b4d6f81-7a9c-4e0b-8d2f-3c5e7a9b1d0f';
const URL_ENV = process.env.LOCAL_TEST_DATABASE_URL ?? '';
const enabled = process.env.MONA_G22_ROLLOUT_PG === '1' && process.env.MONA_G22_ROLLOUT_PG_DISPOSABLE === '1' && /^postgres(ql)?:\/\/[^@/]+@127\.0\.0\.1:5432\/mona_local_test$/.test(URL_ENV);
const skip = enabled ? false : 'opt-in PostgreSQL suite (see the header)';

let pg;
let work;
async function open() {
  pg ??= require('pg');
  const c = new pg.Client({ connectionString: URL_ENV });
  await c.connect();
  const sid = (await c.query('SELECT system_identifier::text AS s FROM pg_control_system()')).rows[0].s;
  if (sid !== process.env.MONA_G22_ROLLOUT_PG_SYSTEM_ID) { await c.end(); throw new Error('the isolated cluster binding does not match MONA_G22_ROLLOUT_PG_SYSTEM_ID'); }
  return c;
}

// A fresh database: the app schema is dropped, the PILOT-named marker stand-in recreated, G20 built by the REAL Prisma over the 20-migration prefix tree.
function stage(n) {
  work ??= mkdtempSync(path.join(os.tmpdir(), 'g22-pg-'));
  const dir = path.join(work, `tree${n}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(path.join(dir, 'prisma', 'migrations'), { recursive: true });
  cpSync(path.join(REPO, 'api', 'prisma', 'schema.prisma'), path.join(dir, 'prisma', 'schema.prisma'));
  cpSync(path.join(REPO, 'api', 'prisma', 'migrations', 'migration_lock.toml'), path.join(dir, 'prisma', 'migrations', 'migration_lock.toml'));
  for (const m of GENERATION_MIGRATION_PINS.slice(0, n)) cpSync(path.join(REPO, 'api', 'prisma', 'migrations', m.name), path.join(dir, 'prisma', 'migrations', m.name), { recursive: true });
  writeFileSync(path.join(dir, 'prisma.config.ts'), `import { defineConfig, env } from 'file://${REPO}/api/node_modules/prisma/config.js';\nexport default defineConfig({ schema: 'prisma/schema.prisma', datasource: { url: env('DATABASE_URL') } });\n`);
  return dir;
}
function prismaDeploy(n) {
  const dir = stage(n);
  const r = spawnSync(process.execPath, [path.join(REPO, 'api', 'node_modules', 'prisma', 'build', 'index.js'), 'migrate', 'deploy', '--config', 'prisma.config.ts'],
    { cwd: dir, env: { PATH: process.env.PATH, HOME: process.env.HOME, DATABASE_URL: URL_ENV, CHECKPOINT_DISABLE: '1', PRISMA_HIDE_UPDATE_MESSAGE: '1', NODE_ENV: 'production' }, encoding: 'utf8' });
  rmSync(dir, { recursive: true, force: true });
  return { ok: r.status === 0, detail: `prisma exited with code ${r.status}` };
}

const UID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
async function fixture(c, { emails = ['owner@pilot.test', 'admin@pilot.test', 'cashier@pilot.test', 'seller@pilot.test', 'warehouse@pilot.test', 'Inactive@pilot.test'], owner = true } = {}) {
  const roles = { OWNER: UID(9001), ADMIN: UID(9002) };
  for (const [code, id] of Object.entries(roles)) await c.query('INSERT INTO "Role" (id, code, name) VALUES ($1, $2, $2)', [id, code]);
  for (const [i, email] of emails.entries()) {
    await c.query('INSERT INTO "User" (id, name, email, "passwordHash", "isActive", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, $5, now(), now())', [UID(i + 1), `U${i + 1}`, email, 'x'.repeat(60), i !== emails.length - 1]);
  }
  if (owner) await c.query('INSERT INTO "UserRoleScope" (id, "userId", "roleId", "scopeKind") VALUES ($1, $2, $3, $4)', [UID(7001), UID(1), roles.OWNER, 'COMPANY']);
  await c.query('INSERT INTO "UserRoleScope" (id, "userId", "roleId", "scopeKind") VALUES ($1, $2, $3, $4)', [UID(7002), UID(2), roles.ADMIN, 'COMPANY']);
  await c.query(`INSERT INTO "AuditLog" (id, "userId", action, "entityType", "entityId") VALUES ($1, $2, 'SEED', 'User', $2)`, [UID(8001), UID(1)]);
}
async function freshG20(c, options) {
  await c.query('DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS mona_pilot_guard CASCADE; CREATE SCHEMA public;');
  const built = prismaDeploy(20);
  assert.equal(built.ok, true, 'the REAL Prisma builds EXACT_G20');
  await c.query(`CREATE SCHEMA mona_pilot_guard; CREATE TABLE mona_pilot_guard.database_identity (marker_id uuid NOT NULL, environment text NOT NULL); INSERT INTO mona_pilot_guard.database_identity VALUES ('${MARKER}', 'pilot')`);
  await fixture(c, options);
}

// The same read-only snapshot the tools use; the RBAC catalog rows are the canonical CATALOG_38 (the catalog bootstrap is a separate rollout, not under test).
async function snapshot(c, options = {}) {
  const s = await R.readSnapshotOn(c, { markerId: MARKER, requireTls: false, ...options });
  assert.equal(s.ok, true, s.reason);
  s.catalog = catalogRows(CATALOG_38);
  return s;
}
const harness = (c, { before = {} } = {}) => {
  const applied = [];
  return {
    applied,
    run: (initialState) => R.runRollout({
      initialState,
      readSnapshotNow: (options) => snapshot(c, options).catch((e) => ({ ok: false, reason: String(e.message) })),
      applyStep: async (generation) => {
        applied.push(generation);
        if (before[generation]) await before[generation](c);
        return prismaDeploy(generation === 'EXACT_G21' ? 21 : 22);
      },
    }),
  };
};
const ledgerTail = async (c) => (await c.query(`SELECT migration_name, finished_at IS NOT NULL AS fin FROM "_prisma_migrations" ORDER BY migration_name DESC LIMIT 2`)).rows;
const exists = async (c, sql) => (await c.query(sql)).rows[0].n;

test('PG-G22-01 happy path on a REAL EXACT_G20 database: preflight READY, REAL Prisma G21 then G22 over prefix trees, witness, EXACT_G22 with 360 columns / 38 relations, counts unchanged, defaults false/NULL', { skip, timeout: 240000 }, async () => {
  const c = await open();
  try {
    await freshG20(c);
    const before = await snapshot(c);
    const a = R.assessSource(before);
    assert.deepEqual(a.reasons, [], 'EXACT_G20 is judged READY against the REAL pinned reference');
    assert.equal(a.schemaGeneration, 'EXACT_G20');
    assert.deepEqual(before.facts.users, { total: 6, active: 5, nonLower: 1 });
    assert.equal(before.facts.operativeOwners, 1); assert.equal(before.facts.collisionGroups, 0);
    const h = harness(c);
    const out = await h.run('EXACT_G20');
    assert.equal(out.result, 'MIGRATED', JSON.stringify({ ...out, snapshot: undefined }));
    assert.deepEqual(h.applied, ['EXACT_G21', 'EXACT_G22']);
    const after = await snapshot(c, { userDefaults: true, adminOperations: true });
    const v = R.verifyTarget(after, 'EXACT_G22', { expectedCounts: before.facts.counts });
    assert.deepEqual(v.failures, []);
    assert.equal(after.ledger.length, 22);
    assert.equal(after.facts.counts.User, 6); assert.equal(after.facts.counts.AuditLog, 1);
    assert.deepEqual(after.facts.userDefaults, { total: 6, mustChange: 0, credentialsSet: 0 });
    // the G20/G21 API shape keeps working: an INSERT with the OLD column list gets the defaults, and the case-insensitive index now refuses a case variant
    await c.query('INSERT INTO "User" (id, name, email, "passwordHash", "isActive", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, true, now(), now())', [UID(50), 'old api', 'old@pilot.test', 'x'.repeat(60)]);
    assert.deepEqual((await c.query('SELECT "mustChangePassword" AS m, "credentialsChangedAt" AS c FROM "User" WHERE id = $1', [UID(50)])).rows[0], { m: false, c: null });
    await assert.rejects(c.query('INSERT INTO "User" (id, name, email, "passwordHash", "isActive", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, true, now(), now())', [UID(51), 'dup', 'OLD@pilot.test', 'x'.repeat(60)]), (e) => e.code === '23505');
  } finally { await c.end(); }
});

test('PG-G22-02 an e-mail collision (case-insensitive) is refused by the preflight and by the rollout BEFORE any migration; the ledger stays at 20', { skip, timeout: 240000 }, async () => {
  const c = await open();
  try {
    await freshG20(c, { emails: ['owner@pilot.test', 'Dup@Pilot.test', 'dup@pilot.test', 'seller@pilot.test'] });
    const s = await snapshot(c);
    assert.equal(s.facts.collisionGroups, 1);
    assert.deepEqual(R.assessSource(s).reasons, ['EMAIL_COLLISION']);
    const h = harness(c); const out = await h.run('EXACT_G20');
    assert.equal(out.result, 'REFUSED'); assert.deepEqual(h.applied, []);
    assert.equal((await snapshot(c)).ledger.length, 20);
  } finally { await c.end(); }
});

test('PG-G22-03 no operative OWNER is refused before any migration', { skip, timeout: 240000 }, async () => {
  const c = await open();
  try {
    await freshG20(c, { owner: false });
    assert.deepEqual(R.assessSource(await snapshot(c)).reasons, ['NO_OPERATIVE_OWNER']);
    const h = harness(c); assert.equal((await h.run('EXACT_G20')).result, 'REFUSED'); assert.deepEqual(h.applied, []);
    // an INACTIVE owner is not operative either
    await c.query('UPDATE "User" SET "isActive" = false WHERE id = $1', [UID(1)]);
    await c.query('INSERT INTO "UserRoleScope" (id, "userId", "roleId", "scopeKind") VALUES ($1, $2, $3, $4)', [UID(7003), UID(1), UID(9001), 'COMPANY']);
    assert.equal((await snapshot(c)).facts.operativeOwners, 0);
  } finally { await c.end(); }
});

test('PG-G22-04 a collision that appears BETWEEN the steps (same row count) stops migration 22: the database stays a provable EXACT_G21 and nothing of G22 exists', { skip, timeout: 240000 }, async () => {
  const c = await open();
  try {
    await freshG20(c);
    const h = harness(c);
    const run = R.runRollout({
      initialState: 'EXACT_G20',
      readSnapshotNow: (options) => snapshot(c, options),
      applyStep: async (generation) => {
        h.applied.push(generation);
        const r = prismaDeploy(generation === 'EXACT_G21' ? 21 : 22);
        if (generation === 'EXACT_G21') await c.query(`UPDATE "User" SET email = 'ADMIN@pilot.test' WHERE id = $1`, [UID(3)]); // collides with admin@pilot.test; the count is unchanged
        return r;
      },
    });
    const out = await run;
    assert.equal(out.result, 'REFUSED'); assert.equal(out.step, 'G21-to-G22'); assert.match(out.detail, /EMAIL_COLLISION/);
    assert.deepEqual(h.applied, ['EXACT_G21']);
    const s = await snapshot(c, { userDefaults: true });
    assert.deepEqual(R.verifyTarget(s, 'EXACT_G21').failures, [], 'still a provable EXACT_G21');
    assert.equal(await exists(c, `SELECT count(*)::int n FROM pg_indexes WHERE indexname = 'User_email_lower_key'`), 0);
    assert.equal(await exists(c, `SELECT count(*)::int n FROM information_schema.tables WHERE table_name = 'UserAdminOperation'`), 0);
  } finally { await c.end(); }
});

test('PG-G22-05 REAL Prisma: a G22 abort on a collision leaves NO index, NO table and no change, but a failed (unfinished) ledger row → the state is no longer classifiable → RESTORE_REQUIRED, and no resume plan can be built over it', { skip, timeout: 240000 }, async () => {
  const c = await open();
  try {
    await freshG20(c);
    const h = harness(c, { before: { EXACT_G22: async (client) => { await client.query(`UPDATE "User" SET email = 'ADMIN@pilot.test' WHERE id = $1`, [UID(3)]); } } });
    const out = await h.run('EXACT_G20');
    // the race is injected AFTER the between-steps re-check, i.e. in the millisecond before Prisma runs G22
    assert.equal(out.result, 'RESTORE_REQUIRED', JSON.stringify({ ...out, snapshot: undefined }));
    assert.equal(out.step, 'G22');
    assert.deepEqual(h.applied, ['EXACT_G21', 'EXACT_G22']);
    assert.equal(await exists(c, `SELECT count(*)::int n FROM pg_indexes WHERE indexname = 'User_email_lower_key'`), 0, 'no index was left behind');
    assert.equal(await exists(c, `SELECT count(*)::int n FROM information_schema.tables WHERE table_name = 'UserAdminOperation'`), 0, 'no table was left behind');
    assert.deepEqual((await ledgerTail(c)).map((r) => r.fin), [false, true], 'G22 is an unfinished row, G21 finished');
    const s = await snapshot(c);
    assert.deepEqual(R.assessSource(s, undefined, 'EXACT_G21').reasons, ['LEDGER_UNCLASSIFIED']);
    // the REAL Prisma itself refuses to continue (P3009): there is no retry path without `migrate resolve`, which this tooling never runs
    assert.equal(prismaDeploy(22).ok, false);
  } finally { await c.end(); }
});

test('PG-G22-06 resume: a REAL EXACT_G21 database is refused by the normal run, accepted by the explicit resume, which runs ONLY G22', { skip, timeout: 240000 }, async () => {
  const c = await open();
  try {
    await freshG20(c);
    assert.equal(prismaDeploy(21).ok, true);
    const s = await snapshot(c, { userDefaults: true });
    assert.deepEqual(R.assessSource(s).reasons, ['SOURCE_IS_G21']);
    assert.equal(R.assessSource(s, undefined, 'EXACT_G21').verdict, 'READY');
    assert.equal((await harness(c).run('EXACT_G20')).result, 'REFUSED');
    const h = harness(c); const out = await h.run('EXACT_G21');
    assert.equal(out.result, 'MIGRATED'); assert.deepEqual(h.applied, ['EXACT_G22']);
    assert.deepEqual(R.assessSource(await snapshot(c)).reasons, ['ALREADY_G22']);
  } finally { await c.end(); }
});

test('PG-G22-07 a changed count (an AuditLog row appearing during the G21 step) blocks migration 22 at the witness → RESTORE_REQUIRED; the G22 objects do not exist', { skip, timeout: 240000 }, async () => {
  const c = await open();
  try {
    await freshG20(c);
    const h = harness(c);
    const out = await R.runRollout({
      initialState: 'EXACT_G20', readSnapshotNow: (options) => snapshot(c, options),
      applyStep: async (generation) => {
        h.applied.push(generation);
        const r = prismaDeploy(21);
        await c.query(`INSERT INTO "AuditLog" (id, "userId", action, "entityType", "entityId") VALUES ($1, $2, 'EXTRA', 'User', $2)`, [UID(8002), UID(1)]);
        return r;
      },
    });
    assert.equal(out.result, 'RESTORE_REQUIRED'); assert.equal(out.step, 'G21'); assert.match(out.detail, /count changed: AuditLog 1 -> 2/);
    assert.deepEqual(h.applied, ['EXACT_G21']);
    assert.equal(await exists(c, `SELECT count(*)::int n FROM information_schema.tables WHERE table_name = 'UserAdminOperation'`), 0);
  } finally { await c.end(); }
});

test('PG-G22-08 the verifier on a REAL EXACT_G22 database blocks: a dropped lower(email) index, a user with mustChangePassword, a non-empty UserAdminOperation, a moved AuditLog count', { skip, timeout: 240000 }, async () => {
  const c = await open();
  try {
    await freshG20(c);
    const baseline = (await snapshot(c)).facts.counts;
    assert.equal((await harness(c).run('EXACT_G20')).result, 'MIGRATED');
    const verify = async () => R.verifyTarget(await snapshot(c, { userDefaults: true, adminOperations: true }), 'EXACT_G22', { expectedCounts: baseline });
    assert.equal((await verify()).ok, true);
    await c.query(`INSERT INTO "AuditLog" (id, "userId", action, "entityType", "entityId") VALUES ($1, $2, 'X', 'User', $2)`, [UID(8003), UID(1)]);
    assert.match((await verify()).failures.join('|'), /count changed: AuditLog 1 -> 2/);
    await c.query('DELETE FROM "AuditLog" WHERE id = $1', [UID(8003)]);
    await c.query('UPDATE "User" SET "mustChangePassword" = true WHERE id = $1', [UID(4)]);
    assert.match((await verify()).failures.join('|'), /mustChangePassword = true/);
    await c.query('UPDATE "User" SET "mustChangePassword" = false WHERE id = $1', [UID(4)]);
    await c.query('INSERT INTO "UserAdminOperation" (id, "actorId", "targetUserId", operation, "idempotencyKey", "requestHash") VALUES ($1, $2, $3, $4, $5, $6)',
      [UID(60), UID(1), UID(2), 'CREATE_USER', '11111111-1111-4111-8111-111111111111', 'a'.repeat(64)]);
    assert.match((await verify()).failures.join('|'), /UserAdminOperation is not empty/);
    await c.query('DELETE FROM "UserAdminOperation"');
    assert.equal((await verify()).ok, true);
    await c.query('DROP INDEX "User_email_lower_key"');
    assert.match((await verify()).failures.join('|'), /PROBE_FAILED:index:User\.User_email_lower_key/);
  } finally { await c.end(); }
});

test('PG-G22-09 the real data facts: the GROUP BY lower(email) query sees the collision, non-lowercase e-mails are counted, live reservations / open cash sessions are counted (warnings only)', { skip, timeout: 240000 }, async () => {
  const c = await open();
  try {
    await freshG20(c);
    const s = await snapshot(c);
    assert.equal(s.facts.users.nonLower, 1); assert.deepEqual(s.facts.operation, { cashOpen: 0, salesDraft: 0, salesPendingPayment: 0, liveReservations: 0 });
    assert.equal(pinsOf('EXACT_G22').length, 22);
  } finally { await c.end(); }
});

after(() => { if (work) rmSync(work, { recursive: true, force: true }); });
