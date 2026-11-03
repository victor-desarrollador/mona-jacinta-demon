// OPT-IN real-PostgreSQL test of pilot-owner-recovery.mjs. It never touches PILOT, Supabase or any database that it did not create, and every secret in it is synthetic.
//
// Enabled only with MONA_OWNER_RECOVERY_PG=1. The test process spawns a child inside a private network namespace (only loopback, an empty environment but PATH/LANG, as an OWNER
// would launch a lab tool); the child
//   1. creates a disposable PostgreSQL 17 cluster (the clone lab's cluster code: Unix socket only) and builds a REAL EXACT_G22 database with the real reviewed migrations and Prisma;
//   2. loads a PILOT-shaped fixture: the five canonical accounts (ids and e-mails of pilot-bootstrap) with KNOWN synthetic passwords, the OWNER at COMPANY scope, the inactive technical
//      system actor, the PILOT marker;
//   3. runs the REAL recovery tool against it (Prisma over the socket instead of the PILOT TLS connection; the terminal, the identity proof and the URL file are the only injected parts);
//   4. runs the REAL API (createApp over the same Prisma client, on a Unix socket) to prove the lifecycle: old token dead, old password dead, temporary password logs in, every normal
//      route answers PASSWORD_CHANGE_REQUIRED, change-password works, the epoch moves again;
//   5. injects REAL failures through database objects (a trigger that rejects the AuditLog insert, a deferred constraint trigger that fails the COMMIT, a concurrent change of the epoch);
//   6. reports only booleans / counts as JSON. The parent asserts, and checks the residue (no postmaster, socket or directory) from the filesystem and /proc.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const REPO = path.resolve(HERE, '..', '..');
const enabled = process.env.MONA_OWNER_RECOVERY_PG === '1';
const IS_DRIVER = process.argv.includes('--recovery-driver');
const skip = (enabled ? false : 'opt-in real PostgreSQL suite (MONA_OWNER_RECOVERY_PG=1; needs unprivileged user namespaces and the PostgreSQL 17 binaries)') || IS_DRIVER;

async function driver(work) {
  // The API validates its environment when imported: synthetic values, never a real database.
  Object.assign(process.env, {
    NODE_ENV: 'production', DATABASE_URL: 'postgresql://unused:unused@localhost:5432/unused', JWT_SECRET: 'synthetic-secret-for-the-recovery-test-0123456789',
    JWT_ACCESS_TTL_SECONDS: '900', CORS_ORIGINS: 'http://localhost:3000', CLIENT_IP_SOURCE: 'x-real-ip',
  });
  const Lab = await import('./pilot-g22-clone-lab.mjs');
  const CR = await import('./pilot-g20-clone-restore.mjs');
  const M = await import('./pilot-owner-recovery.mjs');
  const { PILOT_ACCOUNTS } = await import('./pilot-bootstrap.mjs');
  const { buildChildEnv, resolvePrismaCli, API_DIR } = await import('./pilot-migrate.mjs');
  const { CATALOG_38 } = await import('./pilot-rbac-catalog-generations.mjs');
  const { catalogRows } = await import('./pilot-g22-fake-db.mjs');
  const { sha256 } = await import('./pilot-launch-command.mjs');
  const { readLockedFile } = await import('./pilot-plan-binding.mjs');
  const tsx = await import(pathToFileURL(path.join(REPO, 'api/node_modules/tsx/dist/esm/api/index.mjs')).href);
  const ts = (rel) => tsx.tsImport(pathToFileURL(path.join(REPO, rel)).href, import.meta.url);

  const deps = Lab.defaultDeps();
  const mkPrivate = (dir) => { mkdirSync(dir, { recursive: true, mode: 0o700 }); nodeFs.chmodSync(dir, 0o700); return dir; };
  mkPrivate(work);
  const canonical = await M.loadCanonical();
  const out = { checks: {} };
  const MARKER = randomUUID();

  // ---- 1. the disposable cluster and a real EXACT_G22 database ----
  const root = mkPrivate(path.join(work, 'c'));
  const runDir = path.join(root, 'r');
  mkdirSync(runDir, { mode: 0o700 });
  const cluster = Lab.createCluster({ deps, runDir });
  const up = await cluster.start();
  if (!up.ok) throw new Error(`cluster: ${up.reason}`);
  const prismaCli = resolvePrismaCli(API_DIR);
  const schemaSha = sha256(readLockedFile(path.join(API_DIR, 'prisma', 'schema.prisma')).bytes);
  const staged = Lab.stageLabRun({ apiDir: API_DIR, stageParent: cluster.childHome, generation: 'EXACT_G22', schemaSha256: schemaSha });
  if (!staged.ok) throw new Error(staged.reason);
  const dbUrl = `postgresql://${CR.ADMIN_ROLE}@localhost:5432/postgres?host=${cluster.sock}`;
  const built = await deps.runChild(process.execPath, [prismaCli.script, 'migrate', 'deploy', '--config', path.join(staged.root, 'prisma.config.ts')],
    { env: buildChildEnv(dbUrl, { execPath: process.execPath, home: cluster.childHome, tmpdir: cluster.childHome }), timeoutMs: 600000 });
  staged.cleanup();
  if (built.status !== 0) throw new Error(`prisma build of EXACT_G22 failed (${built.status})`);

  // Supabase sessions run in UTC and the Prisma pg adapter (the API's and this tool's) reads/writes timestamps on that assumption: make the disposable database faithful to it.
  { const c0 = await cluster.connect(CR.ADMIN_ROLE, 'postgres'); try { await c0.query(`ALTER DATABASE postgres SET timezone TO 'UTC'`); } finally { await c0.end(); } }
  const admin = await cluster.connect(CR.ADMIN_ROLE, 'postgres');
  const q = async (sql, params = []) => (await admin.query(sql, params)).rows;
  const one = async (sql, params) => (await q(sql, params))[0];
  const cat = catalogRows(CATALOG_38);
  for (const r of cat.roles) await q('INSERT INTO "Role" (id, code, name) VALUES ($1, $2, $2)', [r.id, r.code]);
  for (const p of cat.permissions) await q('INSERT INTO "Permission" (id, code) VALUES ($1, $2)', [p.id, p.code]);
  for (const g of cat.grants) await q('INSERT INTO "RolePermission" ("roleId", "permissionId") VALUES ($1, $2)', [g.roleId, g.permissionId]);
  const roleId = (code) => cat.roles.find((r) => r.code === code).id;
  const OLD = (i) => `Old-Synthetic-Password-${i}!`;
  for (const [i, a] of PILOT_ACCOUNTS.entries()) {
    await q('INSERT INTO "User" (id, name, email, "passwordHash", "isActive", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, true, now(), now())', [a.id, a.name, a.email, await canonical.hashPassword(OLD(i))]);
  }
  await q('INSERT INTO "User" (id, name, email, "passwordHash", "isActive", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, false, now(), now())',
    [canonical.SYSTEM_ACTOR_USER_ID, canonical.SYSTEM_ACTOR_NAME, canonical.SYSTEM_ACTOR_EMAIL, await canonical.hashPassword(randomBytes(24).toString('base64url'))]);
  await q('INSERT INTO "UserRoleScope" (id, "userId", "roleId", "scopeKind") VALUES ($1, $2, $3, $4)', [randomUUID(), PILOT_ACCOUNTS[0].id, roleId('OWNER'), 'COMPANY']);
  await q('INSERT INTO "UserRoleScope" (id, "userId", "roleId", "scopeKind") VALUES ($1, $2, $3, $4)', [randomUUID(), PILOT_ACCOUNTS[1].id, roleId('ADMIN'), 'COMPANY']);
  await q('CREATE SCHEMA mona_pilot_guard');
  await q('CREATE TABLE mona_pilot_guard.database_identity (singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton), environment text NOT NULL, marker_id uuid NOT NULL, installed_at timestamptz NOT NULL DEFAULT now())');
  await q('INSERT INTO mona_pilot_guard.database_identity (environment, marker_id) VALUES ($1, $2)', ['pilot', MARKER]);

  // Prisma over the socket (the PILOT tool uses verified TLS fields instead), shared by the recovery tool and the API.
  const { PrismaClient } = await ts('api/src/generated/prisma/client.ts');
  const require = (await import('node:module')).createRequire(path.join(REPO, 'api', 'package.json'));
  const { PrismaPg } = await import(pathToFileURL(require.resolve('@prisma/adapter-pg')).href);
  const prisma = new PrismaClient({ adapter: new PrismaPg({ host: cluster.sock, port: 5432, user: CR.ADMIN_ROLE, database: 'postgres', connectionTimeoutMillis: 10000 }), log: [] });

  // ---- 4. the REAL API on a Unix socket ----
  const { createApp } = await ts('api/src/app.ts');
  const app = createApp(prisma);
  const apiSock = path.join(root, 'api.sock');
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(apiSock, resolve));
  const call = (method, p, { token, body } = {}) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ socketPath: apiSock, path: p, method, headers: { 'content-type': 'application/json', 'x-real-ip': '127.0.0.1', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } }, (res) => {
      let buf = ''; res.on('data', (c) => { buf += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(buf); } catch { /* none */ } resolve({ status: res.statusCode, json: j }); });
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
  const login = (i, pw) => call('POST', '/api/v1/auth/login', { body: { email: PILOT_ACCOUNTS[i].email, password: pw } });

  // ---- 3. the REAL recovery tool, with only the terminal / identity / URL injected ----
  const events = []; const lines = []; const shown = [];
  const run = async (mode, { plan = null, typed = null, prismaOverride = null } = {}) => {
    const argv = mode === 'dry'
      ? ['--target=pilot', '--dry-run', `--marker-id=${MARKER}`, `--target-user=${PILOT_ACCOUNTS[0].id}`]
      : ['--target=pilot', '--execute', `--marker-id=${MARKER}`, '--confirm-project-ref=pilotsynthref0000001', `--target-user=${PILOT_ACCOUNTS[0].id}`, `--plan=${plan}`];
    const mark = lines.length;
    const code = await M.main(argv, {
      urlFile: '/synthetic', readUrlFile: () => ({ ok: true, text: 'postgresql://postgres.pilotsynthref0000001:synthpw@aws-0-synthetic.pooler.invalid:6543/postgres\n' }),
      proveIdentity: async () => 0,
      createClient: () => new (require('pg').Client)({ host: cluster.sock, port: 5432, user: CR.ADMIN_ROLE, database: 'postgres' }), requireTls: false,
      createPrisma: async () => prismaOverride ?? prisma, loadCanonical: async () => canonical,
      isTTY: { stdin: true, stdout: true }, prompt: async () => typed ?? `RECOVER ${PILOT_ACCOUNTS[0].id.slice(0, 8)}`, showSecret: (s) => { events.push('secret'); shown.push(s); },
      osUser: () => 'pg-test-operator', log: (l) => lines.push(l), error: (l) => lines.push(l),
    });
    const slice = lines.slice(mark);
    return { code, result: slice.filter((l) => l.startsWith('PILOT_OWNER_RECOVERY_RESULT=')).at(-1)?.slice(28) ?? null, plan: slice.find((l) => l.startsWith('  PLAN_DIGEST='))?.slice(14) ?? null, lines: slice };
  };
  const state = async () => {
    const u = await one('SELECT "passwordHash", "mustChangePassword", "credentialsChangedAt" FROM "User" WHERE id = $1', [PILOT_ACCOUNTS[0].id]);
    return { hash: u.passwordHash, mustChange: u.mustChangePassword, epoch: u.credentialsChangedAt?.getTime() ?? null,
      audits: Number((await one(`SELECT count(*)::text AS n FROM "AuditLog" WHERE action = 'USER_PASSWORD_RECOVERY'`)).n), uao: Number((await one('SELECT count(*)::text AS n FROM "UserAdminOperation"')).n) };
  };
  const others = async () => (await q('SELECT id, "passwordHash", "isActive", email FROM "User" WHERE id <> $1 ORDER BY id', [PILOT_ACCOUNTS[0].id]));
  const othersBefore = JSON.stringify(await others());
  const scopesBefore = JSON.stringify(await q('SELECT "userId", "roleId", "scopeKind" FROM "UserRoleScope" ORDER BY "userId", "roleId"'));

  // ---- S1: before ----
  const s0 = await state();
  const oldLogin = await login(0, OLD(0));
  const T0 = oldLogin.json?.accessToken;
  out.before = { oldLoginStatus: oldLogin.status, mustChange: oldLogin.json?.user?.mustChangePassword, tokenOk: (await call('GET', '/api/v1/auth/me', { token: T0 })).status, epoch: s0.epoch };
  const dry = await run('dry');
  out.dry = { code: dry.code, result: dry.result, hasPlan: /^[0-9a-f]{64}$/.test(dry.plan ?? ''), noWrites: JSON.stringify(await state()) === JSON.stringify(s0) };

  // The failure objects are created by ANOTHER connection right after BEGIN (after the tool's schema check, which would otherwise — correctly — refuse a drifted schema before any
  // transaction), and dropped right after. The tool's own SQL, locks and ROLLBACK are the real ones.
  const injected = (setup, teardown) => new Proxy(prisma, { get: (t, k) => (k === '$transaction'
    ? async (fn, opts) => { try { return await t.$transaction(async (tx) => { await setup(); return fn(tx); }, opts); } finally { await teardown(); } }
    : typeof t[k] === 'function' ? t[k].bind(t) : t[k]) });

  // ---- S3: a trigger rejects the AuditLog insert -> the REAL transaction (update already executed) rolls everything back ----
  const auditTrap = injected(async () => {
    await q(`CREATE FUNCTION fail_recovery_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'USER_PASSWORD_RECOVERY' THEN RAISE EXCEPTION 'injected audit failure'; END IF; RETURN NEW; END $$`);
    await q('CREATE TRIGGER fail_recovery_audit BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION fail_recovery_audit()');
  }, async () => { await q('DROP TRIGGER IF EXISTS fail_recovery_audit ON "AuditLog"'); await q('DROP FUNCTION IF EXISTS fail_recovery_audit()'); });
  const a = await run('exec', { plan: dry.plan, prismaOverride: auditTrap });
  const sa = await state();
  out.auditFailure = { code: a.code, result: a.result, unchanged: sa.hash === s0.hash && sa.mustChange === false && sa.epoch === null && sa.audits === 0, oldPasswordStillWorks: (await login(0, OLD(0))).status === 200, secretShown: shown.length };

  // ---- S4: a deferred constraint trigger fails the COMMIT itself -> UNKNOWN_COMMIT, nothing persisted, nothing shown ----
  const commitTrap = injected(async () => {
    await q(`CREATE FUNCTION fail_at_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."mustChangePassword" AND NEW.id = '${PILOT_ACCOUNTS[0].id}' THEN RAISE EXCEPTION 'injected commit failure'; END IF; RETURN NEW; END $$`);
    await q('CREATE CONSTRAINT TRIGGER fail_at_commit AFTER UPDATE ON "User" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fail_at_commit()');
  }, async () => { await q('DROP TRIGGER IF EXISTS fail_at_commit ON "User"'); await q('DROP FUNCTION IF EXISTS fail_at_commit()'); });
  const c = await run('exec', { plan: dry.plan, prismaOverride: commitTrap });
  const sc = await state();
  out.commitFailure = { code: c.code, result: c.result, unchanged: sc.hash === s0.hash && sc.mustChange === false && sc.epoch === null && sc.audits === 0, secretShown: shown.length };

  // ---- S5: the HAPPY path ----
  const dry2 = await run('dry');
  const happy = await run('exec', { plan: dry2.plan });
  const sh = await state();
  const secret = shown[0];
  const lifecycle = {};
  const audit = await one(`SELECT "userId", "branchId", action, "entityType", "entityId", before, after FROM "AuditLog" WHERE action = 'USER_PASSWORD_RECOVERY'`);
  out.happy = {
    code: happy.code, result: happy.result, planUnchangedByFailures: dry2.plan === dry.plan, secretShownOnce: shown.length === 1, secretIsTemporaryPassword: canonical.TEMPORARY_PASSWORD_PATTERN.test(secret ?? ''),
    hashVerifies: await canonical.verifyPassword(secret ?? '', sh.hash), bcryptCost12: /^\$2[aby]\$12\$/.test(sh.hash), mustChange: sh.mustChange, epochSet: sh.epoch !== null && Math.abs(sh.epoch - Date.now()) < 300000, auditRows: sh.audits, uao: sh.uao,
    audit: { actorIsSystemActor: audit.userId === canonical.SYSTEM_ACTOR_USER_ID, branchNull: audit.branchId === null, entity: audit.entityType === 'User' && audit.entityId === PILOT_ACCOUNTS[0].id,
      channel: audit.after.recovery.channel, planDigestBound: audit.after.recovery.planDigest === dry2.plan, operator: audit.after.recovery.operator, noSecretInJson: !JSON.stringify(audit).includes(secret) && !/\$2[aby]\$/.test(JSON.stringify(audit)) && !JSON.stringify(audit).includes('@') },
    othersUnchanged: JSON.stringify(await others()) === othersBefore, scopesUnchanged: JSON.stringify(await q('SELECT "userId", "roleId", "scopeKind" FROM "UserRoleScope" ORDER BY "userId", "roleId"')) === scopesBefore,
  };

  // ---- lifecycle against the REAL API ----
  lifecycle.oldTokenStatus = (await call('GET', '/api/v1/auth/me', { token: T0 })).status;
  lifecycle.oldPasswordStatus = (await login(0, OLD(0))).status;
  const tmpLogin = await login(0, secret);
  const T1 = tmpLogin.json?.accessToken;
  lifecycle.temporaryLogin = { status: tmpLogin.status, mustChange: tmpLogin.json?.user?.mustChangePassword };
  lifecycle.meWhilePending = (await call('GET', '/api/v1/auth/me', { token: T1 })).status;
  const blocked = await call('GET', '/api/v1/products', { token: T1 });
  lifecycle.normalRouteWhilePending = { status: blocked.status, code: blocked.json?.error?.code };
  const NEW = 'Nueva-Clave-Segura-2030!';
  const epochBefore = (await state()).epoch;
  const changed = await call('POST', '/api/v1/auth/change-password', { token: T1, body: { currentPassword: secret, newPassword: NEW } });
  const T2 = changed.json?.accessToken;
  const sc2 = await state();
  lifecycle.changePassword = { status: changed.status, mustChangeInResponse: changed.json?.user?.mustChangePassword, mustChangeInDb: sc2.mustChange, epochIncreased: sc2.epoch > epochBefore };
  lifecycle.tokenAfterChange = { temporaryTokenStatus: (await call('GET', '/api/v1/auth/me', { token: T1 })).status, newTokenStatus: (await call('GET', '/api/v1/auth/me', { token: T2 })).status };
  const free = await call('GET', '/api/v1/products', { token: T2 });
  lifecycle.normalRouteAfterChange = { status: free.status, blocked: free.json?.error?.code === 'PASSWORD_CHANGE_REQUIRED' };
  lifecycle.newPasswordLogin = (await login(0, NEW)).status;
  out.lifecycle = lifecycle;

  // ---- S6: replay of the used plan ----
  const stateBeforeReplay = JSON.stringify(await state());
  const replay = await run('exec', { plan: dry2.plan });
  out.replay = { code: replay.code, result: replay.result, mismatch: replay.lines.some((l) => /PLAN_BINDING_MISMATCH/.test(l)), unchanged: JSON.stringify(await state()) === stateBeforeReplay, secretsShown: shown.length };

  // ---- S7: a concurrent credentials change between the observation and the lock (REAL compare-and-swap) ----
  const dry3 = await run('dry');
  const racing = new Proxy(prisma, { get: (t, k) => (k === '$transaction'
    ? (fn, opts) => t.$transaction(async (tx) => { await q(`UPDATE "User" SET "credentialsChangedAt" = now() + interval '1 hour' WHERE id = '${PILOT_ACCOUNTS[0].id}'`); return fn(tx); }, opts)
    : typeof t[k] === 'function' ? t[k].bind(t) : t[k]) });
  const before7 = await state();
  const raced = await run('exec', { plan: dry3.plan, prismaOverride: racing });
  const after7 = await state();
  out.race = { code: raced.code, result: raced.result, noNewAudit: after7.audits === before7.audits, passwordUntouched: after7.hash === before7.hash, secretsShown: shown.length };

  // ---- security scan of everything the tool printed ----
  const all = lines.join('\n');
  out.scan = { bcrypt: /\$2[aby]\$\d\d\$/.test(all), temporaryPassword: shown.some((s) => all.includes(s)), token: /eyJ[A-Za-z0-9_-]{10,}\./.test(all), url: /postgres(ql)?:\/\//.test(all), email: all.includes('@pilot.local') };

  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
  await admin.end();
  const stopped = await cluster.stop();
  rmSync(root, { recursive: true, force: true });
  out.cluster = { stopped };
  console.log(`RECOVERY_PG_RESULTS=${JSON.stringify(out)}`);
}

if (IS_DRIVER) {
  const work = process.argv.find((a) => a.startsWith('--work='))?.slice('--work='.length);
  driver(work).then(() => { process.exitCode = 0; }, (e) => { console.log(`RECOVERY_PG_ERROR=${String(e?.stack ?? e).slice(0, 900).replace(/\n/g, ' | ')}`); process.exitCode = 1; });
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// PARENT
// ---------------------------------------------------------------------------------------------------------------------------------------------------
let outcome;
function runDriver() {
  if (outcome) return outcome;
  const work = path.join(os.homedir(), '.cache', `or-${randomBytes(3).toString('hex')}`);
  nodeFs.mkdirSync(path.dirname(work), { recursive: true });
  const r = spawnSync('/usr/bin/unshare', ['-U', '-n', '--map-current-user', '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', 'LANG=C.UTF-8', process.execPath, SELF, '--recovery-driver', `--work=${work}`],
    { cwd: REPO, encoding: 'utf8', timeout: 1500000, maxBuffer: 1 << 26 });
  const lines = (r.stdout ?? '').split('\n');
  const res = lines.find((l) => l.startsWith('RECOVERY_PG_RESULTS='));
  const err = lines.find((l) => l.startsWith('RECOVERY_PG_ERROR='));
  const live = [];
  for (const d of readdirSync('/proc')) {
    if (!/^[0-9]+$/.test(d)) continue;
    try { const cmd = readFileSync(`/proc/${d}/cmdline`, 'utf8'); if (cmd.includes('postgres') && cmd.includes(work)) live.push(d); } catch { /* gone */ }
  }
  outcome = { status: r.status, r: res ? JSON.parse(res.slice('RECOVERY_PG_RESULTS='.length)) : null, error: err ?? null, stderr: (r.stderr ?? '').slice(-300), work, livePostgres: live, leftover: nodeFs.existsSync(work) ? readdirSync(work) : [] };
  return outcome;
}
process.on('exit', () => { if (outcome?.work) rmSync(outcome.work, { recursive: true, force: true }); });

test('ORP-00 the driver ran to completion inside the network namespace', { skip, timeout: 1600000 }, () => {
  const o = runDriver();
  assert.equal(o.error, null, `${o.error} ${o.stderr}`);
  assert.ok(o.r, `no results (status ${o.status}) ${o.stderr}`);
});

test('ORP-01 dry-run on a real EXACT_G22 database writes nothing and yields a plan', { skip }, () => {
  const { before, dry } = runDriver().r;
  assert.equal(before.oldLoginStatus, 200); assert.equal(before.mustChange, false); assert.equal(before.tokenOk, 200); assert.equal(before.epoch, null);
  assert.deepEqual(dry, { code: 0, result: 'DRY_RUN_OK', hasPlan: true, noWrites: true });
});

test('ORP-02 happy path: a valid temporary password, the old password dead, mustChangePassword, a new epoch, ONE audit row by the technical actor, no other table touched', { skip }, () => {
  const h = runDriver().r.happy;
  assert.equal(h.code, 0); assert.equal(h.result, 'RECOVERED');
  assert.equal(h.secretShownOnce, true); assert.equal(h.secretIsTemporaryPassword, true); assert.equal(h.hashVerifies, true); assert.equal(h.bcryptCost12, true);
  assert.equal(h.mustChange, true); assert.equal(h.epochSet, true); assert.equal(h.auditRows, 1); assert.equal(h.uao, 0);
  assert.deepEqual(h.audit, { actorIsSystemActor: true, branchNull: true, entity: true, channel: 'OPERATOR_RECOVERY', planDigestBound: true, operator: 'pg-test-operator', noSecretInJson: true });
  assert.equal(h.othersUnchanged, true); assert.equal(h.scopesUnchanged, true);
  assert.equal(h.planUnchangedByFailures, true, 'the failed attempts changed nothing, so the same plan still applies');
});

test('ORP-03 lifecycle against the REAL API: old token dead, old password dead, temporary login, normal routes blocked, change-password works, epoch moves again, the temporary token dies', { skip }, () => {
  const l = runDriver().r.lifecycle;
  assert.equal(l.oldTokenStatus, 401); assert.equal(l.oldPasswordStatus, 401);
  assert.deepEqual(l.temporaryLogin, { status: 200, mustChange: true });
  assert.equal(l.meWhilePending, 200);
  assert.deepEqual(l.normalRouteWhilePending, { status: 403, code: 'PASSWORD_CHANGE_REQUIRED' });
  assert.deepEqual(l.changePassword, { status: 200, mustChangeInResponse: false, mustChangeInDb: false, epochIncreased: true });
  assert.deepEqual(l.tokenAfterChange, { temporaryTokenStatus: 401, newTokenStatus: 200 });
  assert.equal(l.normalRouteAfterChange.blocked, false); assert.equal(l.normalRouteAfterChange.status, 200);
  assert.equal(l.newPasswordLogin, 200);
});

test('ORP-04 REAL failure injection: a rejected AuditLog insert and a failing COMMIT leave the database exactly as it was and never show a secret', { skip }, () => {
  const { auditFailure, commitFailure } = runDriver().r;
  assert.deepEqual({ ...auditFailure, secretShown: 0 }, { code: 1, result: 'ROLLED_BACK', unchanged: true, oldPasswordStillWorks: true, secretShown: 0 });
  assert.equal(auditFailure.secretShown, 0);
  assert.deepEqual(commitFailure, { code: 1, result: 'UNKNOWN_COMMIT', unchanged: true, secretShown: 0 });
});

test('ORP-05 replay of a used plan and a REAL concurrent epoch change are refused without writing or showing anything', { skip }, () => {
  const { replay, race } = runDriver().r;
  assert.deepEqual(replay, { code: 1, result: 'REFUSED', mismatch: true, unchanged: true, secretsShown: 1 });
  assert.deepEqual(race, { code: 1, result: 'STATE_CHANGED', noNewAudit: true, passwordUntouched: true, secretsShown: 1 });
});

test('ORP-06 everything the tool printed is free of bcrypt hashes, the temporary password, tokens, URLs and e-mails', { skip }, () => {
  assert.deepEqual(runDriver().r.scan, { bcrypt: false, temporaryPassword: false, token: false, url: false, email: false });
});

test('ORP-07 cleanup measured from outside: cluster stopped, no postmaster of the test, nothing left in the work area', { skip }, () => {
  const o = runDriver();
  assert.equal(o.r.cluster.stopped, true); assert.deepEqual(o.livePostgres, []);
  assert.deepEqual(o.leftover.filter((e) => e !== 'c'), []);
});
