// OPT-IN real-PostgreSQL test of the restored-clone migration LAB (pilot-g22-clone-lab.mjs). It never touches PILOT, Supabase or any database that it did not create.
//
// Enabled only with MONA_G22_CLONE_LAB_PG=1. The test process spawns a child exactly as an OWNER would launch the lab (private network namespace with only loopback, an
// empty environment but PATH/LANG, no Node options); the child
//   1. creates a SOURCE cluster with the lab's own cluster code, builds a real EXACT_G20 database with the REAL reviewed migrations through the REAL Prisma, loads a small
//      fixture (the canonical CATALOG_38, six users, one operative OWNER, audit rows) and the PILOT-shaped marker;
//   2. takes real pg_dump archives of it and authenticates them with a TEST key (a throw-away HOME under the work directory — the OWNER key is never read), producing
//      the same manifest format as pilot-g20-backup.mjs (the clean one, and variants with an e-mail collision / without an operative OWNER);
//   3. runs the real lab on them (the real pilot-g20-clone-restore proof with only its OWNER-host code-manifest check and its HOME replaced) and on tampered copies;
//   4. reports every outcome as JSON; the parent asserts on it. Cleanup is asserted from the filesystem and /proc by the PARENT, not from the lab's own report.
// FAILURE INJECTION is real: the hooks act on the live clone through the lab's own cluster handle (e.g. a pre-existing object makes the real `prisma migrate deploy`
// fail), and the lab's own step runner, snapshot code and cleanup run unchanged around them.
// The OWNER-host code manifest of the G20 tools is deliberately replaced here (it pins this host's PostgreSQL build): what runs is the unmodified restore logic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const REPO = path.resolve(HERE, '..', '..');
const enabled = process.env.MONA_G22_CLONE_LAB_PG === '1';
const IS_DRIVER = process.argv.includes('--lab-driver');
const skip = (enabled ? false : 'opt-in real PostgreSQL suite (MONA_G22_CLONE_LAB_PG=1; needs unprivileged user namespaces and the PostgreSQL 17 binaries)') || IS_DRIVER;

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// CHILD (inside the network namespace)
// ---------------------------------------------------------------------------------------------------------------------------------------------------
async function driver(work, happyOnly) {
  const Lab = await import('./pilot-g22-clone-lab.mjs');
  const B = await import('./pilot-g20-backup.mjs');
  const CR = await import('./pilot-g20-clone-restore.mjs');
  const { buildChildEnv, resolvePrismaCli, API_DIR } = await import('./pilot-migrate.mjs');
  const { CATALOG_38 } = await import('./pilot-rbac-catalog-generations.mjs');
  const { catalogRows } = await import('./pilot-g22-fake-db.mjs');
  const { sha256 } = await import('./pilot-launch-command.mjs');
  const { readLockedFile } = await import('./pilot-plan-binding.mjs');
  const generations = await import('./pilot-migration-generations.mjs');
  const references = await import('./pilot-g20-schema-references.mjs');
  const rbac = await import('./pilot-rbac-catalog-generations.mjs');

  const deps = Lab.defaultDeps();
  const mkPrivate = (dir) => { mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700); return dir; };
  mkPrivate(work);
  const home = mkPrivate(path.join(work, 'h'));
  mkPrivate(path.join(home, '.config'));
  const cdir = mkPrivate(path.join(home, '.config', 'mona-jacinta'));
  const keyHex = randomBytes(32).toString('hex');
  const markerId = randomUUID();
  writeFileSync(path.join(cdir, B.MAC_KEY_FILE), `${keyHex}\n`, { mode: 0o600 });
  writeFileSync(path.join(cdir, 'pilot-marker-id'), `${markerId}\n`, { mode: 0o600 });

  // ---- 1. the SOURCE cluster and a real EXACT_G20 database named `postgres` (the archive TOC requires that name) ----
  const srcRoot = mkPrivate(path.join(work, 's'));
  const runDir = path.join(srcRoot, 'src');
  mkdirSync(runDir, { mode: 0o700 });
  const source = Lab.createCluster({ deps, runDir });
  const up = await source.start();
  if (!up.ok) throw new Error(`source cluster: ${up.reason}`);
  const prisma = resolvePrismaCli(API_DIR);
  if (!prisma.ok) throw new Error('prisma');
  const schemaSha = sha256(readLockedFile(path.join(API_DIR, 'prisma', 'schema.prisma')).bytes);
  const sourceUrl = `postgresql://${CR.ADMIN_ROLE}@localhost:5432/postgres?host=${source.sock}`;
  const staged = Lab.stageLabRun({ apiDir: API_DIR, stageParent: source.childHome, generation: 'EXACT_G20', schemaSha256: schemaSha });
  if (!staged.ok) throw new Error(staged.reason);
  const built = await deps.runChild(process.execPath, [prisma.script, 'migrate', 'deploy', '--config', path.join(staged.root, 'prisma.config.ts')],
    { env: buildChildEnv(sourceUrl, { execPath: process.execPath, home: source.childHome, tmpdir: source.childHome }), timeoutMs: 600000 });
  staged.cleanup();
  if (built.status !== 0) throw new Error(`prisma build of EXACT_G20 failed (${built.status})`);

  const sq = await source.connect(CR.ADMIN_ROLE, 'postgres');
  const UID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const cat = catalogRows(CATALOG_38);
  for (const r of cat.roles) await sq.query('INSERT INTO "Role" (id, code, name) VALUES ($1, $2, $2)', [r.id, r.code]);
  for (const p of cat.permissions) await sq.query('INSERT INTO "Permission" (id, code) VALUES ($1, $2)', [p.id, p.code]);
  for (const g of cat.grants) await sq.query('INSERT INTO "RolePermission" ("roleId", "permissionId") VALUES ($1, $2)', [g.roleId, g.permissionId]);
  const roleId = (code) => cat.roles.find((r) => r.code === code).id;
  const emails = ['owner@pilot.test', 'admin@pilot.test', 'cashier@pilot.test', 'seller@pilot.test', 'warehouse@pilot.test', 'Inactive@pilot.test'];
  for (const [i, email] of emails.entries()) {
    await sq.query('INSERT INTO "User" (id, name, email, "passwordHash", "isActive", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, $5, now(), now())', [UID(i + 1), `U${i + 1}`, email, `x${i}`.repeat(30), i !== emails.length - 1]);
  }
  await sq.query('INSERT INTO "UserRoleScope" (id, "userId", "roleId", "scopeKind") VALUES ($1, $2, $3, $4)', [UID(7001), UID(1), roleId('OWNER'), 'COMPANY']);
  await sq.query('INSERT INTO "UserRoleScope" (id, "userId", "roleId", "scopeKind") VALUES ($1, $2, $3, $4)', [UID(7002), UID(2), roleId('ADMIN'), 'COMPANY']);
  for (let i = 0; i < 3; i += 1) await sq.query(`INSERT INTO "AuditLog" (id, "userId", action, "entityType", "entityId") VALUES ($1, $2, 'SEED', 'User', $2)`, [UID(8000 + i), UID(1)]);
  await sq.query('CREATE SCHEMA mona_pilot_guard');
  await sq.query('CREATE TABLE mona_pilot_guard.database_identity (singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton), environment text NOT NULL, marker_id uuid NOT NULL, installed_at timestamptz NOT NULL DEFAULT now())');
  await sq.query('INSERT INTO mona_pilot_guard.database_identity (environment, marker_id) VALUES ($1, $2)', ['pilot', markerId]);

  const counts = async () => {
    const out = {};
    for (const t of ['User', 'UserRoleScope', 'Sale', 'SalePayment', 'CashSession', 'Inventory', 'StockMovement', 'SaleExchange', 'SaleVoid', 'AuditLog']) {
      out[t] = Number((await sq.query(`SELECT count(*)::text AS n FROM ONLY public."${t}"`)).rows[0].n);
    }
    return out;
  };

  // ---- 2. real archives, authenticated like pilot-g20-backup.mjs does ----
  const pgRestore = (kind, bytes) => {
    const r = spawnSync(B.PG_RESTORE, B.pgRestoreArgs(kind), { env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', PGTZ: 'UTC' }, input: bytes, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], maxBuffer: 1 << 30 });
    return { status: r.status, stdout: r.stdout };
  };
  const shared = B.adaptShared({ generations, references, rbac });
  const toolSha = sha256(readFileSync(path.join(REPO, 'scripts/database/pilot-g20-backup.mjs')));
  const take = async (label) => {
    const tmpFile = path.join(work, `${label}.partial`);
    const r = spawnSync(B.PG_DUMP, [...B.buildPgDumpArgs(tmpFile), `--host=${source.sock}`, '--port=5432', `--username=${CR.ADMIN_ROLE}`, '--dbname=postgres'],
      { env: { ...B.pinnedLibpqEnv(source.childHome), PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', PGTZ: 'UTC' }, encoding: 'utf8' });
    if (r.status !== 0) throw new Error('pg_dump failed');
    const bytes = readFileSync(tmpFile);
    rmSync(tmpFile);
    const v = await B.verifyArchiveBytes({ bytes, pgRestore: async (kind, b) => pgRestore(kind, b), markerId, expectedState: 'EXACT_G20', shared });
    if (!v.ok) throw new Error(`the synthetic archive was refused by the backup verifier: ${v.reason}`);
    const names = B.artifactNames({ now: new Date(), hex: randomBytes(4).toString('hex') });
    const store = mkPrivate(path.join(work, `store-${label}`));
    const fields = {
      setId: randomUUID(), createdAt: new Date().toISOString(), toolSha256: toolSha, pgDumpVersion: v.pgDumpVersion, serverVersion: v.serverVersion,
      archive: { file: names.dump, bytes: bytes.length, sha256: sha256(bytes) }, tocSha256: v.tocSha256, schemas: v.schemas, tables: v.tables, refDigest: B.REF_DIGESTS.pilot,
      markerIdDigest: B.markerDigest(markerId), ledgerState: v.ledgerState, rbacCatalog: v.rbacCatalog, schemaReferenceDigest: v.schemaReferenceDigest,
    };
    const archive = path.join(store, names.dump);
    writeFileSync(archive, bytes, { mode: 0o600 });
    writeFileSync(`${archive}.manifest.json`, Buffer.from(B.buildDumpManifest({ ...fields, mac: B.computeManifestMac(keyHex, fields) }), 'utf8'), { mode: 0o600 });
    return { archive, manifest: `${archive}.manifest.json`, store, fields, counts: await counts() };
  };
  const clean = await take('clean');
  let noOwner = null; let collision = null;
  if (!happyOnly) {
    await sq.query('DELETE FROM "UserRoleScope" WHERE id = $1', [UID(7001)]);
    noOwner = await take('noowner');
    await sq.query('INSERT INTO "UserRoleScope" (id, "userId", "roleId", "scopeKind") VALUES ($1, $2, $3, $4)', [UID(7001), UID(1), roleId('OWNER'), 'COMPANY']);
    await sq.query('INSERT INTO "User" (id, name, email, "passwordHash", "isActive", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, true, now(), now())', [UID(99), 'Dup', 'OWNER@pilot.test', 'x'.repeat(60)]);
    collision = await take('collision');
  }
  await sq.end();
  if (!(await source.stop())) throw new Error('source cluster did not stop');
  rmSync(srcRoot, { recursive: true, force: true });

  // ---- 3. run the real lab ----
  const cloneRestoreMain = (argv, o) => CR.main(argv, {
    ...o, homedir: home,
    verifyManifest: () => ({ ok: true, repoSha: new Map([['scripts/database/pilot-g20-backup.mjs', toolSha]]) }),
  });
  const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
  const live = () => {
    const found = [];
    for (const d of readdirSync('/proc')) {
      if (!/^[0-9]+$/.test(d)) continue;
      try { const cmd = readFileSync(`/proc/${d}/cmdline`, 'utf8'); if (cmd.includes('postgres') && cmd.includes(work)) found.push(d); } catch { /* gone */ }
    }
    return found;
  };

  // Physical facts about the live clone (read through the lab's own cluster handle while it exists).
  const inspect = async (cluster) => {
    const c = await cluster.connect();
    try {
      const one = async (sql) => (await c.query(sql)).rows[0];
      const n = async (sql) => Number((await one(sql)).n);
      const uao = await one(`SELECT to_regclass('public."UserAdminOperation"') IS NOT NULL AS present`);
      const defaults = await one(`SELECT count(*) FILTER (WHERE "mustChangePassword")::int AS must_change, count(*) FILTER (WHERE "credentialsChangedAt" IS NOT NULL)::int AS creds, count(*)::int AS users FROM ONLY public."User"`).catch(() => null);
      return {
        migrations: await n('SELECT count(*)::text AS n FROM ONLY public."_prisma_migrations" WHERE finished_at IS NOT NULL'),
        columns: await n(`SELECT count(*)::text AS n FROM information_schema.columns WHERE table_schema = 'public'`),
        relations: await n(`SELECT count(*)::text AS n FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace WHERE s.nspname = 'public' AND c.relkind IN ('r', 'p')`),
        lowerEmailIndex: await n(`SELECT count(*)::text AS n FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'User_email_lower_key'`),
        userAdminOperationTable: uao.present,
        userAdminOperationRows: uao.present ? await n('SELECT count(*)::text AS n FROM ONLY public."UserAdminOperation"') : null,
        mustChangePasswordUsers: defaults?.must_change ?? null, credentialsChangedAtUsers: defaults?.creds ?? null, users: defaults?.users ?? null,
        auditLog: await n('SELECT count(*)::text AS n FROM ONLY public."AuditLog"'),
      };
    } finally { await c.end(); }
  };

  // One lab run with optional real failure injection around the lab's OWN step runner and cluster.
  const runLab = async (name, set, { counts: c = set.counts, argv: argvOverride = null, hooks = {}, env = null, cleanupFails = false, observe = false, abortMidway = false } = {}) => {
    const wsRoot = mkPrivate(path.join(work, `w-${name}`));
    const before = [sha(set.archive), sha(set.manifest)];
    const lines = [];
    const trace = { runs: {}, created: 0, cloneRestore: 0, evidence: {}, aliveAtAbort: [] };
    const argv = argvOverride ?? [`--archive=${set.archive}`, `--manifest=${set.manifest}`, `--work-root=${wsRoot}`, `--expected-counts=${JSON.stringify(c)}`];
    let abortFn = null;
    const overrides = {
      cloneRestoreMain: (a, o) => { trace.cloneRestore += 1; return cloneRestoreMain(a, o); },
      log: (l) => lines.push(l), error: (l) => lines.push(l),
      createCluster: (a) => {
        trace.created += 1;
        const cluster = Lab.createCluster(a);
        if (cleanupFails) { const stop = cluster.stop; cluster.stop = async () => { await stop(); return false; }; }
        return cluster;
      },
      makeStepRunner: (ctx) => {
        const real = Lab.makeLabStepRunner(ctx);
        return async (g) => {
          trace.runs[g] = (trace.runs[g] ?? 0) + 1;
          if (abortMidway) { trace.aliveAtAbort = live(); await abortFn(); return { ok: false, started: false, detail: 'interrupted' }; }
          if (hooks.before?.[g]) await hooks.before[g](ctx.cluster);
          const r = await real(g);
          if (r.ok && observe) trace.evidence[g] = await inspect(ctx.cluster);
          if (r.ok && hooks.after?.[g]) await hooks.after[g](ctx.cluster);
          return r;
        };
      },
    };
    if (env) overrides.env = env;
    if (abortMidway) overrides.registerAbort = (f) => { abortFn = f; };
    const rc = await Lab.main(argv, overrides);
    const resultLine = lines.find((l) => l.startsWith('CLONE_LAB_RESULT='));
    return {
      name, rc, result: resultLine?.slice('CLONE_LAB_RESULT='.length) ?? null, lines: lines.filter((l) => !l.startsWith('[db:')),
      trace, wsRoot, wsEntries: readdirSync(wsRoot), livePostgres: live(), untouched: before[0] === sha(set.archive) && before[1] === sha(set.manifest),
    };
  };

  const results = [];
  results.push(await runLab('happy', clean, { observe: true }));
  if (happyOnly) { console.log(`LAB_PG_RESULTS=${JSON.stringify(results)}`); return; }

  // ---- adversarial inputs (real archives, real restore proof) ----
  const copyOf = (set, label, mutate) => {
    const store = mkPrivate(path.join(work, `store-${label}`));
    const archive = path.join(store, path.basename(set.archive));
    copyFileSync(set.archive, archive); chmodSync(archive, 0o600);
    copyFileSync(set.manifest, `${archive}.manifest.json`); chmodSync(`${archive}.manifest.json`, 0o600);
    mutate(archive, `${archive}.manifest.json`);
    return { ...set, archive, manifest: `${archive}.manifest.json`, store };
  };
  results.push(await runLab('corrupt-archive', copyOf(clean, 'corrupt', (a) => { const b = readFileSync(a); b[b.length >> 1] ^= 0xff; writeFileSync(a, b); })));
  results.push(await runLab('forged-mac', copyOf(clean, 'forged', (_a, m) => { const j = JSON.parse(readFileSync(m, 'utf8')); j.mac = '0'.repeat(64); writeFileSync(m, B.buildDumpManifest(j)); })));
  results.push(await runLab('wrong-counts', clean, { counts: { ...clean.counts, AuditLog: clean.counts.AuditLog + 1 } }));
  results.push(await runLab('email-collision', collision));
  results.push(await runLab('no-owner', noOwner));

  // ---- hostile destinations: each must fail before a cluster exists or the restore proof starts (the unreachable 192.0.2.1 is a documentation address) ----
  const hostile = mkPrivate(path.join(work, 'w-hostile'));
  const okArgv = [`--archive=${clean.archive}`, `--manifest=${clean.manifest}`, `--work-root=${hostile}`, `--expected-counts=${JSON.stringify(clean.counts)}`];
  const swapWorkRoot = (flag) => okArgv.map((a) => (a.startsWith('--work-root=') ? flag : a));
  results.push(await runLab('hostile-target', clean, { argv: [...okArgv, '--target=pilot'] }));
  results.push(await runLab('hostile-host', clean, { argv: swapWorkRoot('--host=db.example.com') }));
  results.push(await runLab('hostile-url', clean, { argv: swapWorkRoot('--url=postgresql://u:p@192.0.2.1:5432/postgres') }));
  results.push(await runLab('hostile-database-url-arg', clean, { argv: swapWorkRoot('--database-url=postgresql://u:p@192.0.2.1:5432/postgres') }));
  results.push(await runLab('hostile-env-DATABASE_URL', clean, { argv: okArgv, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', DATABASE_URL: 'postgresql://u:p@192.0.2.1:5432/postgres' } }));
  // the staged Prisma config itself rejects a remote-looking URL (no network exists here: the refusal must be the config's own)
  {
    const stagedRemote = Lab.stageLabRun({ apiDir: API_DIR, stageParent: mkPrivate(path.join(work, 'x')), generation: 'EXACT_G21', schemaSha256: schemaSha });
    const remote = spawnSync(process.execPath, [prisma.script, 'migrate', 'deploy', '--config', path.join(stagedRemote.root, 'prisma.config.ts')],
      { env: buildChildEnv('postgresql://u:p@db.example.supabase.co:5432/postgres', { execPath: process.execPath, home, tmpdir: work }), encoding: 'utf8', timeout: 120000 });
    stagedRemote.cleanup();
    results.push({ name: 'remote-url-refused', status: remote.status, refusedByConfig: /only a Unix-socket DATABASE_URL/.test(`${remote.stdout}${remote.stderr}`) });
  }
  // a foreign socket / data directory: a second, healthy cluster answers on the connection the first one is about to trust. The identity guard must say no.
  {
    const rootA = mkPrivate(path.join(work, 'fa'));
    const rootB = mkPrivate(path.join(work, 'fb'));
    const dirA = path.join(rootA, 'a'); const dirB = path.join(rootB, 'b');
    mkdirSync(dirA, { mode: 0o700 }); mkdirSync(dirB, { mode: 0o700 });
    const A = Lab.createCluster({ deps, runDir: dirA });
    const redirect = { on: false };
    const Bc = Lab.createCluster({ deps: { ...deps, connect: (cfg) => deps.connect(redirect.on ? { ...cfg, host: A.sock } : cfg) }, runDir: dirB });
    const upA = await A.start(); const upB = await Bc.start();
    const ownBefore = await Bc.proveIdentity();
    redirect.on = true;
    const foreign = await Bc.proveIdentity();
    redirect.on = false;
    const stoppedA = await A.stop(); const stoppedB = await Bc.stop();
    rmSync(rootA, { recursive: true, force: true }); rmSync(rootB, { recursive: true, force: true });
    results.push({ name: 'foreign-socket-guard', started: upA.ok && upB.ok, ownIdentity: ownBefore, foreignIdentity: foreign, stopped: stoppedA && stoppedB, livePostgres: live() });
  }

  // ---- real failure injection ----
  const admin = async (cluster, sql) => { const c = await cluster.connect(); try { await c.query(sql); } finally { await c.end(); } };
  results.push(await runLab('inject-g21-deploy', clean, { hooks: { before: { EXACT_G21: (cl) => admin(cl, 'ALTER TABLE "User" ADD COLUMN "mustChangePassword" boolean') } } }));
  results.push(await runLab('inject-after-g21', clean, { hooks: { after: { EXACT_G21: (cl) => admin(cl, `UPDATE "AuditLog" SET action = 'TAMPERED'`) } } }));
  results.push(await runLab('inject-g22-deploy', clean, { hooks: { before: { EXACT_G22: (cl) => admin(cl, 'CREATE TABLE "UserAdminOperation" (x integer)') } } }));
  results.push(await runLab('inject-verify', clean, { hooks: { after: { EXACT_G22: (cl) => admin(cl, 'DROP INDEX "User_email_lower_key"') } } }));
  results.push(await runLab('inject-user-default', clean, { hooks: { after: { EXACT_G22: (cl) => admin(cl, `UPDATE "User" SET "mustChangePassword" = true WHERE id = (SELECT min(id) FROM "User")`) } } }));
  results.push(await runLab('inject-cleanup', clean, { cleanupFails: true }));
  // the run directory of the injected cleanup failure is deliberately kept by the lab: the driver removes it now (its cluster WAS really stopped by the injection)
  {
    const kept = results[results.length - 1];
    kept.keptEntries = [...kept.wsEntries];
    for (const e of kept.wsEntries) rmSync(path.join(kept.wsRoot, e), { recursive: true, force: true });
    kept.wsEntries = readdirSync(kept.wsRoot);
  }
  // an interrupt (the SIGINT/SIGTERM path) while the clone is running and G21 is about to be applied: same cleanup, real cluster
  results.push(await runLab('abort-midway', clean, { abortMidway: true }));
  console.log(`LAB_PG_RESULTS=${JSON.stringify(results)}`);
}

if (IS_DRIVER) {
  const work = process.argv.find((a) => a.startsWith('--work='))?.slice('--work='.length);
  driver(work, process.argv.includes('--happy-only')).then(() => { process.exitCode = 0; }, (e) => { console.log(`LAB_PG_ERROR=${String(e?.message ?? e).slice(0, 400)}`); process.exitCode = 1; });
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// PARENT (the actual tests)
// ---------------------------------------------------------------------------------------------------------------------------------------------------
const outcomes = new Map();
const hostPostgres = () => {
  const found = [];
  for (const d of readdirSync('/proc')) {
    if (!/^[0-9]+$/.test(d)) continue;
    try { const cmd = readFileSync(`/proc/${d}/cmdline`, 'utf8'); if (cmd.includes('postgres')) found.push({ pid: d, cmd }); } catch { /* gone */ }
  }
  return found;
};
function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    out.push({ path: p, socket: e.isSocket(), dir: e.isDirectory() });
    if (e.isDirectory() && !e.isSymbolicLink()) walk(p, out);
  }
  return out;
}
function runDriver(key) {
  if (outcomes.has(key)) return outcomes.get(key);
  const work = path.join(os.homedir(), '.cache', `gl-${randomBytes(3).toString('hex')}`);
  nodeFs.mkdirSync(path.dirname(work), { recursive: true });
  const r = spawnSync('/usr/bin/unshare', ['-U', '-n', '--map-current-user', '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', 'LANG=C.UTF-8', process.execPath, SELF, '--lab-driver', `--work=${work}`,
    ...(key === 'full' ? [] : ['--happy-only'])], { cwd: REPO, encoding: 'utf8', timeout: 1500000, maxBuffer: 1 << 26 });
  const out = (r.stdout ?? '').split('\n');
  const line = out.find((l) => l.startsWith('LAB_PG_RESULTS='));
  const err = out.find((l) => l.startsWith('LAB_PG_ERROR='));
  // EXTERNAL residue checks, taken by the parent right after the child exited (the lab's own report is not trusted)
  const tree = nodeFs.existsSync(work) ? walk(work) : [];
  const residue = {
    postmasters: hostPostgres().filter((p) => p.cmd.includes(work)).map((p) => p.pid),
    sockets: tree.filter((e) => e.socket || /\.s\.PGSQL/.test(e.path)).map((e) => e.path),
    clusterDirs: tree.filter((e) => e.dir && /\/(c|g-[0-9a-f]{8})$/.test(e.path)).map((e) => e.path),
    workRootEntries: nodeFs.existsSync(work) ? readdirSync(work).filter((e) => e.startsWith('w-')).map((e) => [e, readdirSync(path.join(work, e)).length]) : [],
  };
  const o = { status: r.status, results: line ? JSON.parse(line.slice('LAB_PG_RESULTS='.length)) : null, error: err ?? null, stderr: (r.stderr ?? '').slice(-400), work, residue };
  outcomes.set(key, o);
  return o;
}
const named = (n, key = 'full') => runDriver(key).results?.find((x) => x.name === n);
process.on('exit', () => { for (const o of outcomes.values()) if (o.work) rmSync(o.work, { recursive: true, force: true }); });

test('PGL-00 the full driver ran to completion inside the network namespace', { skip, timeout: 1600000 }, () => {
  const o = runDriver('full');
  assert.equal(o.error, null, `${o.error} ${o.stderr}`);
  assert.ok(o.results, `no results (status ${o.status}) ${o.stderr}`);
});

test('PGL-01 happy path on real PostgreSQL: EXACT_G20 -> restore -> G21 -> witness -> G22 -> verify -> cleanup, every result line, VERIFIED, exit 0', { skip }, () => {
  const r = named('happy');
  assert.equal(r.rc, 0, JSON.stringify(r.lines));
  assert.equal(r.result, 'VERIFIED');
  assert.deepEqual(r.lines.filter((l) => l.startsWith('CLONE_') && !l.startsWith('CLONE_LAB_RESULT')),
    ['CLONE_BACKUP_VERIFIED', 'CLONE_EXACT_G20_VERIFIED', 'CLONE_G21_WITNESS_PASS', 'CLONE_G22_VERIFY_PASS', 'CLONE_COUNTS_PRESERVED']);
  assert.deepEqual(r.trace.runs, { EXACT_G21: 1, EXACT_G22: 1 }, 'exactly one Prisma deploy per generation, no retry');
});

test('PGL-02 physical evidence read from the LIVE clone: 21 migrations and G21 defaults after G21; 22 migrations, 360 columns, 38 relations, lower(email) index, empty UserAdminOperation after G22; data preserved', { skip }, () => {
  const e = named('happy').trace.evidence;
  const g21 = e.EXACT_G21; const g22 = e.EXACT_G22;
  assert.equal(g21.migrations, 21);
  assert.equal(g21.userAdminOperationTable, false, 'no G22 object after G21');
  assert.equal(g21.lowerEmailIndex, 0);
  assert.equal(g21.mustChangePasswordUsers, 0); assert.equal(g21.credentialsChangedAtUsers, 0); assert.equal(g21.users, 6);
  assert.equal(g22.migrations, 22);
  assert.equal(g22.columns, 360); assert.equal(g22.relations, 38);
  assert.equal(g22.lowerEmailIndex, 1);
  assert.equal(g22.userAdminOperationTable, true); assert.equal(g22.userAdminOperationRows, 0);
  assert.equal(g22.mustChangePasswordUsers, 0); assert.equal(g22.credentialsChangedAtUsers, 0); assert.equal(g22.users, 6);
  assert.equal(g21.auditLog, 3); assert.equal(g22.auditLog, 3);
});

test('PGL-03 EXTERNAL cleanup of the happy run: no lab postmaster, no socket, no cluster directory, empty work-root, original backup bytes untouched', { skip }, () => {
  const o = runDriver('full');
  const r = named('happy');
  assert.deepEqual(r.livePostgres, []); assert.deepEqual(r.wsEntries, []); assert.equal(r.untouched, true);
  assert.deepEqual(o.residue.postmasters, []); assert.deepEqual(o.residue.sockets, []); assert.deepEqual(o.residue.clusterDirs, []);
});

test('PGL-04 a corrupt archive and a forged MAC are rejected by the approved proof before any cluster exists', { skip }, () => {
  for (const n of ['corrupt-archive', 'forged-mac']) {
    const r = named(n);
    assert.equal(r.result, 'CLONE_BACKUP_REJECTED', n); assert.equal(r.rc, 6, n);
    assert.ok(!r.lines.includes('CLONE_BACKUP_VERIFIED'), n);
    assert.equal(r.trace.created, 0, `${n}: no cluster was created`);
    assert.deepEqual(r.wsEntries, [], n); assert.deepEqual(r.livePostgres, [], n); assert.equal(r.untouched, true, n);
  }
});

test('PGL-05 REAL SQL facts stop the migration before G21: frozen counts that differ, a case-insensitive e-mail collision, no operative OWNER', { skip }, () => {
  for (const n of ['wrong-counts', 'email-collision', 'no-owner']) {
    const r = named(n);
    assert.equal(r.result, 'CLONE_SOURCE_INVALID', n);
    assert.ok(r.lines.includes('CLONE_BACKUP_VERIFIED'), `${n}: the backup itself is authentic`);
    assert.ok(!r.lines.includes('CLONE_EXACT_G20_VERIFIED') && !r.lines.includes('CLONE_G21_WITNESS_PASS'), n);
    assert.deepEqual(r.trace.runs, {}, `${n}: no Prisma deploy was attempted`);
    assert.deepEqual(r.wsEntries, [], `${n}: cleaned after the error`); assert.deepEqual(r.livePostgres, [], n); assert.equal(r.untouched, true, n);
  }
});

test('PGL-06 hostile destinations are refused before any cluster or restore proof: --target, --host, --url, --database-url, an external DATABASE_URL in the environment', { skip }, () => {
  for (const n of ['hostile-target', 'hostile-host', 'hostile-url', 'hostile-database-url-arg', 'hostile-env-DATABASE_URL']) {
    const r = named(n);
    assert.notEqual(r.rc, 0, n); assert.notEqual(r.result, 'VERIFIED', n);
    assert.equal(r.trace.created, 0, `${n}: no cluster`); assert.equal(r.trace.cloneRestore, 0, `${n}: the restore proof never started`);
    assert.deepEqual(r.trace.runs, {}, n);
  }
  assert.equal(named('hostile-env-DATABASE_URL').result, 'CLONE_ISOLATION_REFUSED');
  for (const n of ['hostile-target', 'hostile-host', 'hostile-url', 'hostile-database-url-arg']) assert.equal(named(n).result, 'ARGUMENTS', n);
});

test('PGL-07 the identity guard rejects a foreign socket / data directory: a healthy cluster that is not the lab\'s own cluster is never accepted', { skip }, () => {
  const g = named('foreign-socket-guard');
  assert.equal(g.started, true); assert.equal(g.ownIdentity, true, 'the lab\'s own cluster IS accepted');
  assert.equal(g.foreignIdentity, false); assert.equal(g.stopped, true); assert.deepEqual(g.livePostgres, []);
});

test('PGL-08 the staged Prisma config itself rejects a remote URL (no network exists in the namespace: the refusal is the config\'s own)', { skip }, () => {
  const r = named('remote-url-refused');
  assert.notEqual(r.status, 0); assert.equal(r.refusedByConfig, true);
});

test('PGL-09 real failure injection: a G21 deploy that really fails, a change after G21, a G22 deploy that really fails, a damaged G22 verify, a G22 default defect', { skip }, () => {
  const g21 = named('inject-g21-deploy');
  assert.equal(g21.result, 'CLONE_G21_FAILED'); assert.deepEqual(g21.trace.runs, { EXACT_G21: 1 });
  const after21 = named('inject-after-g21');
  assert.equal(after21.result, 'CLONE_DATA_PRESERVATION_FAILED'); assert.deepEqual(after21.trace.runs, { EXACT_G21: 1 }, 'G22 was never attempted');
  const g22 = named('inject-g22-deploy');
  assert.equal(g22.result, 'CLONE_G22_FAILED'); assert.deepEqual(g22.trace.runs, { EXACT_G21: 1, EXACT_G22: 1 }, 'no retry');
  const verify = named('inject-verify');
  assert.equal(verify.result, 'CLONE_G22_VERIFY_FAILED'); assert.deepEqual(verify.trace.runs, { EXACT_G21: 1, EXACT_G22: 1 });
  const defaults = named('inject-user-default');
  assert.equal(defaults.result, 'CLONE_G22_VERIFY_FAILED', 'a user at mustChangePassword = true after G22 fails the verifier');
  for (const r of [g21, after21, g22, verify, defaults]) {
    assert.equal(r.rc, 6, r.name);
    assert.deepEqual(r.wsEntries, [], `${r.name}: cluster dir removed`); assert.deepEqual(r.livePostgres, [], `${r.name}: no postgres left`); assert.equal(r.untouched, true, `${r.name}: backup intact`);
  }
});

test('PGL-10 a cleanup that cannot be verified is reported (never VERIFIED) and the directory is kept; no postmaster remains', { skip }, () => {
  const r = named('inject-cleanup');
  assert.equal(r.result, 'CLONE_CLEANUP_FAILED'); assert.equal(r.rc, 6);
  assert.equal(r.keptEntries.length, 1, 'the run directory was kept, not deleted');
  assert.deepEqual(r.livePostgres, []); assert.equal(r.untouched, true);
});

test('PGL-11 an interrupt while the real clone is running stops the cluster and removes the run directory; the run is not VERIFIED', { skip }, () => {
  const r = named('abort-midway');
  assert.ok(r.trace.aliveAtAbort.length > 0, 'the cluster really was running when the interrupt arrived');
  assert.notEqual(r.result, 'VERIFIED');
  assert.deepEqual(r.wsEntries, []); assert.deepEqual(r.livePostgres, []); assert.equal(r.untouched, true);
});

test('PGL-12 EXTERNAL residue after the whole adversarial driver: no lab postmaster, no socket, no cluster directory, every work-root empty', { skip }, () => {
  const o = runDriver('full');
  assert.deepEqual(o.residue.postmasters, []); assert.deepEqual(o.residue.sockets, []); assert.deepEqual(o.residue.clusterDirs, []);
  assert.ok(o.residue.workRootEntries.length > 10);
  for (const [name, n] of o.residue.workRootEntries) assert.equal(n, 0, `work root ${name} is empty`);
});

test('PGL-13 repeatability: the happy path passes in three independent runs with fresh work areas, each with the same physical evidence and clean residue', { skip, timeout: 1600000 }, () => {
  const works = new Set();
  for (const key of ['full', 'repeat-1', 'repeat-2']) {
    const o = runDriver(key);
    assert.equal(o.error, null, o.error ?? '');
    works.add(o.work);
    const r = o.results.find((x) => x.name === 'happy');
    assert.equal(r.result, 'VERIFIED', key);
    assert.equal(r.trace.evidence.EXACT_G22.columns, 360, key); assert.equal(r.trace.evidence.EXACT_G22.relations, 38, key); assert.equal(r.trace.evidence.EXACT_G22.migrations, 22, key);
    assert.deepEqual(o.residue.postmasters, [], key); assert.deepEqual(o.residue.sockets, [], key); assert.deepEqual(o.residue.clusterDirs, [], key);
  }
  assert.equal(works.size, 3, 'three distinct work areas');
});
