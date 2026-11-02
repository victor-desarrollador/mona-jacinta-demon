// OPT-IN real-PostgreSQL test of the restored-clone migration LAB (pilot-g22-clone-lab.mjs). It never touches PILOT, Supabase or any database that it did not create.
//
// Enabled only with MONA_G22_CLONE_LAB_PG=1. The test process spawns ONE child exactly as an OWNER would launch the lab (private network namespace with only loopback, an
// empty environment but PATH/LANG, no Node options); the child
//   1. creates a SOURCE cluster with the lab's own cluster code, builds a real EXACT_G20 database with the REAL reviewed migrations through the REAL Prisma, loads a small
//      fixture (the canonical CATALOG_38, six users, one operative OWNER, audit rows) and the PILOT-shaped marker;
//   2. takes real pg_dump archives of it and authenticates them with a TEST key (a throw-away HOME under the work directory — the OWNER key is never read), producing
//      the same manifest format as pilot-g20-backup.mjs (the clean one, and variants with an e-mail collision / without an operative OWNER);
//   3. runs the real lab on them (the real pilot-g20-clone-restore proof with only its OWNER-host code-manifest check and its HOME replaced) and on tampered copies;
//   4. reports every outcome as JSON; the parent asserts on it. Cleanup is asserted from the filesystem and /proc, not from the lab's own report.
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
const skip = enabled ? false : 'opt-in real PostgreSQL suite (MONA_G22_CLONE_LAB_PG=1; needs unprivileged user namespaces and the PostgreSQL 17 binaries)';

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// CHILD (inside the network namespace)
// ---------------------------------------------------------------------------------------------------------------------------------------------------
async function driver(work) {
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
  const fs = nodeFs;
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
  await sq.query('DELETE FROM "UserRoleScope" WHERE id = $1', [UID(7001)]);
  const noOwner = await take('noowner');
  await sq.query('INSERT INTO "UserRoleScope" (id, "userId", "roleId", "scopeKind") VALUES ($1, $2, $3, $4)', [UID(7001), UID(1), roleId('OWNER'), 'COMPANY']);
  await sq.query('INSERT INTO "User" (id, name, email, "passwordHash", "isActive", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, true, now(), now())', [UID(99), 'Dup', 'OWNER@pilot.test', 'x'.repeat(60)]);
  const collision = await take('collision');
  await sq.end();
  if (!(await source.stop())) throw new Error('source cluster did not stop');
  rmSync(srcRoot, { recursive: true, force: true });

  // ---- 3. run the real lab ----
  const cloneRestoreMain = (argv, o) => CR.main(argv, {
    ...o, homedir: home,
    verifyManifest: () => ({ ok: true, repoSha: new Map([['scripts/database/pilot-g20-backup.mjs', toolSha]]) }),
  });
  const wsRoot = mkPrivate(path.join(work, 'w'));
  const live = () => {
    const found = [];
    for (const d of readdirSync('/proc')) {
      if (!/^[0-9]+$/.test(d)) continue;
      try { const cmd = readFileSync(`/proc/${d}/cmdline`, 'utf8'); if (cmd.includes('postgres') && cmd.includes(work)) found.push(d); } catch { /* gone */ }
    }
    return found;
  };
  const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
  const runLab = async (name, set, { counts: c = set.counts, argvExtra = [] } = {}) => {
    const before = [sha(set.archive), sha(set.manifest)];
    const lines = [];
    const rc = await Lab.main(
      [`--archive=${set.archive}`, `--manifest=${set.manifest}`, `--work-root=${wsRoot}`, `--expected-counts=${JSON.stringify(c)}`, ...argvExtra],
      { cloneRestoreMain, log: (l) => lines.push(l), error: (l) => lines.push(l) },
    );
    const resultLine = lines.find((l) => l.startsWith('CLONE_LAB_RESULT='));
    return {
      name, rc, result: resultLine?.slice('CLONE_LAB_RESULT='.length) ?? null, lines: lines.filter((l) => !l.startsWith('[db:')),
      wsEntries: readdirSync(wsRoot), livePostgres: live(), untouched: before[0] === sha(set.archive) && before[1] === sha(set.manifest),
    };
  };

  const results = [];
  results.push(await runLab('happy', clean));
  // corrupt archive (one flipped byte in a copy), forged MAC (valid canonical manifest, wrong mac), wrong frozen counts, collision, no OWNER
  const copyOf = (set, label, mutate) => {
    const store = mkPrivate(path.join(work, `store-${label}`));
    const archive = path.join(store, path.basename(set.archive));
    copyFileSync(set.archive, archive); chmodSync(archive, 0o600);
    copyFileSync(set.manifest, `${archive}.manifest.json`); chmodSync(`${archive}.manifest.json`, 0o600);
    mutate(archive, `${archive}.manifest.json`);
    return { ...set, archive, manifest: `${archive}.manifest.json`, store };
  };
  const corrupt = copyOf(clean, 'corrupt', (a) => { const b = readFileSync(a); b[b.length >> 1] ^= 0xff; writeFileSync(a, b); });
  results.push(await runLab('corrupt-archive', corrupt));
  const forged = copyOf(clean, 'forged', (_a, m) => { const j = JSON.parse(readFileSync(m, 'utf8')); j.mac = '0'.repeat(64); writeFileSync(m, B.buildDumpManifest(j)); });
  results.push(await runLab('forged-mac', forged));
  results.push(await runLab('wrong-counts', clean, { counts: { ...clean.counts, AuditLog: clean.counts.AuditLog + 1 } }));
  results.push(await runLab('email-collision', collision));
  results.push(await runLab('no-owner', noOwner));
  results.push(await runLab('target-flag', clean, { argvExtra: ['--target=pilot'] }));
  // an interrupt (the SIGINT/SIGTERM path) while the clone is running and G21 is about to be applied: same cleanup, real cluster
  {
    let abort;
    const lines = [];
    const argv = [`--archive=${clean.archive}`, `--manifest=${clean.manifest}`, `--work-root=${wsRoot}`, `--expected-counts=${JSON.stringify(clean.counts)}`];
    let aliveAtAbort = [];
    const rc = await Lab.main(argv, {
      cloneRestoreMain, log: (l) => lines.push(l), error: (l) => lines.push(l),
      registerAbort: (fn) => { abort = fn; },
      makeStepRunner: () => async () => { aliveAtAbort = live(); await abort(); return { ok: false, started: false, detail: 'interrupted' }; },
    });
    results.push({ name: 'abort-midway', rc, result: lines.find((l) => l.startsWith('CLONE_LAB_RESULT='))?.slice(17) ?? null, aliveAtAbort, wsEntries: readdirSync(wsRoot), livePostgres: live() });
  }
  // the staged Prisma config refuses a remote-looking URL (no network exists here: the refusal must be the config's own)
  const stagedRemote = Lab.stageLabRun({ apiDir: API_DIR, stageParent: mkPrivate(path.join(work, 'x')), generation: 'EXACT_G21', schemaSha256: schemaSha });
  const remote = spawnSync(process.execPath, [prisma.script, 'migrate', 'deploy', '--config', path.join(stagedRemote.root, 'prisma.config.ts')],
    { env: buildChildEnv('postgresql://u:p@db.example.supabase.co:5432/postgres', { execPath: process.execPath, home, tmpdir: work }), encoding: 'utf8', timeout: 120000 });
  stagedRemote.cleanup();
  results.push({ name: 'remote-url-refused', status: remote.status, refusedByConfig: /only a Unix-socket DATABASE_URL/.test(`${remote.stdout}${remote.stderr}`) });
  console.log(`LAB_PG_RESULTS=${JSON.stringify(results)}`);
  process.exitCode = 0;
}

if (process.argv.includes('--lab-driver')) {
  const work = process.argv.find((a) => a.startsWith('--work='))?.slice('--work='.length);
  driver(work).catch((e) => { console.log(`LAB_PG_ERROR=${String(e?.message ?? e).slice(0, 400)}`); process.exitCode = 1; });
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// PARENT (the actual tests)
// ---------------------------------------------------------------------------------------------------------------------------------------------------
const IS_DRIVER = process.argv.includes('--lab-driver');
let outcome;
function runDriver() {
  if (outcome) return outcome;
  const work = path.join(os.homedir(), '.cache', `gl-${randomBytes(3).toString('hex')}`);
  nodeFs.mkdirSync(path.dirname(work), { recursive: true });
  try {
    const r = spawnSync('/usr/bin/unshare', ['-U', '-n', '--map-current-user', '/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', 'LANG=C.UTF-8', process.execPath, SELF, '--lab-driver', `--work=${work}`],
      { cwd: REPO, encoding: 'utf8', timeout: 1500000, maxBuffer: 1 << 26 });
    const line = (r.stdout ?? '').split('\n').find((l) => l.startsWith('LAB_PG_RESULTS='));
    const err = (r.stdout ?? '').split('\n').find((l) => l.startsWith('LAB_PG_ERROR='));
    outcome = { status: r.status, results: line ? JSON.parse(line.slice('LAB_PG_RESULTS='.length)) : null, error: err ?? null, stderr: (r.stderr ?? '').slice(-400), work };
  } finally {
    // the work area must hold nothing the lab itself created (the driver's own fixtures are removed below)
  }
  return outcome;
}
const named = (n) => runDriver().results?.find((x) => x.name === n);
process.on('exit', () => { if (outcome?.work) rmSync(outcome.work, { recursive: true, force: true }); });

test('PGL-00 the driver ran to completion inside the network namespace', { skip: skip || IS_DRIVER, timeout: 1600000 }, () => {
  const o = runDriver();
  assert.equal(o.error, null, `${o.error} ${o.stderr}`);
  assert.ok(o.results, `no results (status ${o.status}) ${o.stderr}`);
});

test('PGL-01 a real authenticated G20 backup migrates G20 -> G21 -> G22 on the restored clone: every result line, VERIFIED, exit 0', { skip: skip || IS_DRIVER }, () => {
  const r = named('happy');
  assert.equal(r.rc, 0, JSON.stringify(r.lines));
  assert.equal(r.result, 'VERIFIED');
  assert.deepEqual(r.lines.filter((l) => l.startsWith('CLONE_') && !l.startsWith('CLONE_LAB_RESULT')),
    ['CLONE_BACKUP_VERIFIED', 'CLONE_EXACT_G20_VERIFIED', 'CLONE_G21_WITNESS_PASS', 'CLONE_G22_VERIFY_PASS', 'CLONE_COUNTS_PRESERVED']);
});

test('PGL-02 after success: no run directory, no postgres process of the lab, and the original backup bytes are untouched', { skip: skip || IS_DRIVER }, () => {
  const r = named('happy');
  assert.deepEqual(r.wsEntries, []);
  assert.deepEqual(r.livePostgres, []);
  assert.equal(r.untouched, true);
});

test('PGL-03 a corrupt archive and a forged MAC are rejected by the approved proof before any cluster exists', { skip: skip || IS_DRIVER }, () => {
  for (const n of ['corrupt-archive', 'forged-mac']) {
    const r = named(n);
    assert.equal(r.result, 'CLONE_BACKUP_REJECTED', n);
    assert.equal(r.rc, 6, n);
    assert.ok(!r.lines.includes('CLONE_BACKUP_VERIFIED'), n);
    assert.deepEqual(r.wsEntries, [], n); assert.deepEqual(r.livePostgres, [], n);
  }
});

test('PGL-04 REAL SQL facts stop the migration before G21: counts that differ from the frozen ones, a case-insensitive e-mail collision, no operative OWNER', { skip: skip || IS_DRIVER }, () => {
  for (const n of ['wrong-counts', 'email-collision', 'no-owner']) {
    const r = named(n);
    assert.equal(r.result, 'CLONE_SOURCE_INVALID', n);
    assert.ok(r.lines.includes('CLONE_BACKUP_VERIFIED'), `${n}: the backup itself is authentic`);
    assert.ok(!r.lines.includes('CLONE_EXACT_G20_VERIFIED') && !r.lines.includes('CLONE_G21_WITNESS_PASS'), n);
    assert.deepEqual(r.wsEntries, [], `${n}: cleaned after the error`); assert.deepEqual(r.livePostgres, [], n);
    assert.equal(r.untouched, true, n);
  }
});

test('PGL-06 an interrupt while the real clone is running stops the postgres cluster and removes the run directory, and the run is not VERIFIED', { skip: skip || IS_DRIVER }, () => {
  const r = named('abort-midway');
  assert.ok(r.aliveAtAbort.length > 0, 'the cluster really was running when the interrupt arrived');
  assert.notEqual(r.result, 'VERIFIED');
  assert.deepEqual(r.wsEntries, []); assert.deepEqual(r.livePostgres, []);
});

test('PGL-05 no way to name another destination: --target=pilot is refused, and the staged Prisma config itself rejects a remote URL', { skip: skip || IS_DRIVER }, () => {
  const t = named('target-flag');
  assert.equal(t.rc, 1); assert.equal(t.result, 'ARGUMENTS');
  assert.deepEqual(t.wsEntries, []);
  const remote = named('remote-url-refused');
  assert.notEqual(remote.status, 0);
  assert.equal(remote.refusedByConfig, true);
});
