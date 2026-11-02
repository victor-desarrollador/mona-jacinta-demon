// DB-free tests of pilot-g22-clone-lab.mjs (the restored-clone migration LABORATORY). The cluster, the approved restore proof and the Prisma step are injected; the
// rollout core, the snapshot code, the real pinned references/probes and the failure classification are the real modules. The real-PostgreSQL flow is in
// pilot-g22-clone-lab.pg.test.mjs (opt-in, inside a network namespace). Run: node --test scripts/database/pilot-g22-clone-lab.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Lab from './pilot-g22-clone-lab.mjs';
import * as B from './pilot-g20-backup.mjs';
import { FakeDb, MARKER, SCHEMA, FINGERPRINT, baseData } from './pilot-g22-fake-db.mjs';
import { API_DIR } from './pilot-migrate.mjs';
import { pinsOf } from './pilot-migration-generations.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmp = [];
const mk = () => { const d = mkdtempSync(path.join(os.tmpdir(), 'g22lab-')); nodeFs.chmodSync(d, 0o700); tmp.push(d); return d; };
process.on('exit', () => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });
const hex = (c) => c.repeat(64);

// ---- fixtures --------------------------------------------------------------------------------------------------------------------------------

function manifestBytes({ ledgerState = 'EXACT_G20' } = {}) {
  const fields = {
    setId: '143a7560-4592-4d92-a8bb-329b69c3e867', createdAt: '2030-01-01T00:00:00.000Z', toolSha256: hex('a'), pgDumpVersion: '17.11', serverVersion: '17.6',
    archive: { file: 'pilot_x.dump', bytes: 10, sha256: hex('b') }, tocSha256: hex('c'), schemas: ['mona_pilot_guard', 'public'], tables: { User: { rows: 6, copySha256: hex('d') } },
    refDigest: B.REF_DIGESTS.pilot, markerIdDigest: B.markerDigest(MARKER), ledgerState, rbacCatalog: { catalog: ledgerState === 'EXACT_G16' ? 'CATALOG_37' : 'CATALOG_38', digest: hex('e'), permissions: 38, grants: 77 },
    schemaReferenceDigest: hex('f'), mac: hex('0'),
  };
  return Buffer.from(B.buildDumpManifest(fields), 'utf8');
}

function inputs(manifestOpts) {
  const store = mk();
  const archive = path.join(store, 'pilot_x.dump');
  writeFileSync(archive, Buffer.from('PGDMP-fixture'), { mode: 0o600 });
  writeFileSync(`${archive}.manifest.json`, manifestBytes(manifestOpts), { mode: 0o600 });
  return { archive, manifest: `${archive}.manifest.json`, workRoot: mk() };
}

// A fake cluster: FakeDb answers the snapshot; `events` records the lifecycle so cleanup can be asserted.
function fakeCluster({ db, events, fp, start = { ok: true }, restore = true, identity = () => true, stopOk = true }) {
  return ({ runDir }) => ({
    url: 'postgresql://x@localhost:5432/mona_clone?host=/fake', sock: '/fake', data: '/fake/data',
    async start() { events.push('start'); mkdirSync(path.join(runDir, 'c'), { recursive: true }); writeFileSync(path.join(runDir, 'c', 'marker'), 'x'); return start; },
    async restore() { events.push('restore'); return restore; },
    async seedMarker() { events.push('seed'); },
    async connect() { return db.client({ tls: false }); },
    async proveIdentity() { events.push('identity'); return identity(); },
    async fingerprint() { return fp.current; },
    async stop() { events.push('stop'); return stopOk; },
  });
}

const FP = () => ({ current: Object.fromEntries(Object.keys(Lab.FINGERPRINT_SQL).map((t) => [t, `10:${t}`])) });

function harness({ db = new FakeDb(), manifestOpts, cloneRestore = { rc: 0, lines: ['A5C_RESULT=VERIFIED'] }, onStep = {}, cluster = {}, expectedCounts = baseData().counts, prisma = { ok: true, script: 'x', version: 'x' } } = {}) {
  const inp = inputs(manifestOpts);
  const events = [];
  const fp = FP();
  const lines = [];
  const errors = [];
  const stepLog = [];
  const deps = {
    fs: nodeFs, uid: process.getuid(), forbiddenRoots: [], apiDir: API_DIR, execPath: process.execPath, schema: SCHEMA, fingerprint: FINGERPRINT,
    randomHex: () => Math.random().toString(16).slice(2, 10).padEnd(8, '0'),
    log: (l) => lines.push(l), error: (l) => errors.push(l),
    cloneRestoreMain: async (_argv, o) => { events.push('clone-restore'); for (const l of cloneRestore.lines) o.log(l); return cloneRestore.rc; },
    readMarkerId: async () => MARKER,
    resolvePrisma: () => prisma,
    createCluster: fakeCluster({ db, events, fp, ...cluster }),
    makeStepRunner: () => async (generation) => {
      stepLog.push(generation);
      if (onStep[generation]) { const r = await onStep[generation]({ db, fp }); if (r) return r; }
      db.advance(generation);
      return { ok: true };
    },
  };
  const args = { ...inp, expectedCounts };
  return { deps, args, events, lines, errors, fp, db, stepLog, inp };
}

const run = (h) => Lab.runLab({ deps: h.deps, args: h.args, say: () => {} });
const printed = (h) => h.lines.filter((l) => !l.startsWith('[db:'));

// ---- arguments and destination ---------------------------------------------------------------------------------------------------------------

test('CL-01 arguments: exactly archive, manifest (= archive + .manifest.json), work-root and the ROLLOUT_COUNTS JSON; nothing that could name another database exists', () => {
  const counts = JSON.stringify(baseData().counts);
  const ok = ['--archive=/h/b/a.dump', '--manifest=/h/b/a.dump.manifest.json', '--work-root=/h/w', `--expected-counts=${counts}`];
  assert.equal(Lab.parseArgs(ok).ok, true);
  assert.deepEqual(Lab.parseArgs(ok).expectedCounts, baseData().counts);
  const bad = [
    [...ok, '--target=pilot'], [...ok, '--database-url=postgresql://u:p@db.supabase.co/x'], [...ok, '--host=db.example.com'], ok.slice(0, 3),
    [ok[0], '--manifest=/h/b/other.json', ok[2], ok[3]], [ok[0], ok[1], '--work-root=relative/dir', ok[3]], [ok[0], ok[1], ok[2], '--expected-counts={}'],
    [ok[0], ok[0], ok[2], ok[3]], [ok[0], ok[1], '--work-root=/h/w;rm', ok[3]],
  ];
  for (const argv of bad) assert.equal(Lab.parseArgs(argv).ok, false, JSON.stringify(argv).slice(0, 80));
  assert.equal(Lab.parseArgs('x').ok, false);
});

test('CL-02 the only connection string the lab builds is a Unix-socket URL of the local host name with the clone role and no password, no host, no TLS parameter', () => {
  const url = new URL(Lab.buildCloneUrl('/home/u/gb/g-1/c/s'));
  assert.equal(url.hostname, 'localhost'); assert.equal(url.password, ''); assert.equal(url.username, 'mona_clone_restorer');
  assert.deepEqual([...url.searchParams.keys()], ['host']); assert.equal(url.searchParams.get('host'), '/home/u/gb/g-1/c/s');
  for (const bad of ['relative', '/a/../b', '/a b', `/${'x'.repeat(120)}`, '', null, '/a;b', "/a'b"]) assert.throws(() => Lab.buildCloneUrl(bad), /unsafe socket directory/, String(bad).slice(0, 20));
});

test('CL-03 main refuses outside the approved isolation: root, a wider environment, a network namespace with more than loopback; and it never starts a cluster', async () => {
  const counts = JSON.stringify(baseData().counts);
  const argv = ['--archive=/h/b/a.dump', '--manifest=/h/b/a.dump.manifest.json', '--work-root=/h/w', `--expected-counts=${counts}`];
  let created = 0;
  const base = { uid: 1000, execArgv: [], version: 'v24.20.0', env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, readNetDev: () => 'h1\nh2\n    lo: 0 0\n', log: () => {}, error: () => {}, createCluster: () => { created += 1; } };
  const lines = [];
  const call = (o) => Lab.main(argv, { ...base, ...o, log: (l) => lines.push(l) });
  assert.equal(await call({ uid: 0 }), 3);
  assert.equal(await call({ env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', DATABASE_URL: 'postgresql://x' } }), 3);
  assert.equal(await call({ readNetDev: () => 'h1\nh2\n    lo: 0 0\n  eth0: 1 1\n' }), 3);
  assert.equal(await call({ version: 'v1.0.0' }), 3);
  assert.equal(await Lab.main(['--target=pilot'], { ...base, log: () => {} }), 1);
  assert.equal(created, 0);
  assert.ok(lines.some((l) => l === `CLONE_LAB_RESULT=${Lab.FAILURES.ISOLATION_REFUSED}`));
});

// ---- happy path and cleanup --------------------------------------------------------------------------------------------------------------------

test('CL-04 a valid G20 backup migrates G20 -> G21 -> G22 on the clone with the real core: every result line, counts preserved, then the cluster is stopped and the run directory removed', async () => {
  const h = harness();
  const r = await run(h);
  assert.equal(r.code, 'VERIFIED', JSON.stringify(h.errors));
  assert.deepEqual(printed(h), ['CLONE_BACKUP_VERIFIED', 'CLONE_EXACT_G20_VERIFIED', 'CLONE_G21_WITNESS_PASS', 'CLONE_G22_VERIFY_PASS', 'CLONE_COUNTS_PRESERVED']);
  assert.deepEqual(h.stepLog, ['EXACT_G21', 'EXACT_G22']);
  assert.deepEqual(h.events.filter((e) => ['clone-restore', 'start', 'restore', 'seed', 'stop'].includes(e)), ['clone-restore', 'start', 'restore', 'seed', 'stop']);
  assert.deepEqual(readdirSync(h.args.workRoot), [], 'the run directory is gone after success');
  assert.ok(existsSync(h.args.archive) && existsSync(h.args.manifest), 'the original backup is untouched');
});

test('CL-05 the output carries no e-mail, hash, URL or row value: only fixed words, counts and generation names', async () => {
  const h = harness();
  await run(h);
  const all = [...h.lines, ...h.errors].join('\n');
  assert.doesNotMatch(all, /@|postgres(ql)?:\/\/|passwordHash|\$2[aby]\$/);
});

// ---- rejection before any cluster -----------------------------------------------------------------------------------------------------------------

test('CL-06 a corrupt backup or an invalid manifest/MAC is rejected by the approved restore proof and nothing else starts', async () => {
  for (const cloneRestore of [{ rc: 3, lines: ['[db:pilot-g20-clone] REFUSED: phase=archive — the archive does not match the size/SHA-256 pinned by its manifest', 'A5C_RESULT=REFUSED'] },
    { rc: 3, lines: ['[db:pilot-g20-clone] REFUSED: phase=provenance — the manifest is not authenticated by the OWNER backup key', 'A5C_RESULT=REFUSED'] }]) {
    const h = harness({ cloneRestore });
    const r = await run(h);
    assert.equal(r.code, Lab.FAILURES.BACKUP_REJECTED);
    assert.deepEqual(h.events.filter((e) => e === 'start' || e === 'restore'), []);
    assert.deepEqual(h.stepLog, []);
  }
});

test('CL-07 an unreadable or non-private input is rejected before the approved proof runs', async () => {
  const h = harness();
  nodeFs.chmodSync(h.args.archive, 0o644);
  assert.equal((await run(h)).code, Lab.FAILURES.BACKUP_REJECTED);
  assert.deepEqual(h.events, []);
});

test('CL-08 a backup that declares another generation, or that the approved proof refuses for the generation, is SOURCE_INVALID', async () => {
  const g16 = harness({ manifestOpts: { ledgerState: 'EXACT_G16' } });
  assert.equal((await run(g16)).code, Lab.FAILURES.SOURCE_INVALID);
  assert.deepEqual(g16.events, []);
  const refused = harness({ cloneRestore: { rc: 3, lines: ['[db:pilot-g20-clone] REFUSED: phase=manifest — the manifest declares EXACT_G16, the OWNER expected EXACT_G20; nothing started', 'A5C_RESULT=REFUSED'] } });
  assert.equal((await run(refused)).code, Lab.FAILURES.SOURCE_INVALID);
});

test('CL-09 the approved proof failing its restore is CLONE_RESTORE_FAILED; so is the lab\'s own restore failing, and the cluster is still stopped and removed', async () => {
  const proof = harness({ cloneRestore: { rc: 6, lines: ['A5C_RESULT=FAILED'] } });
  assert.equal((await run(proof)).code, Lab.FAILURES.RESTORE_FAILED);
  const own = harness({ cluster: { restore: false } });
  assert.equal((await run(own)).code, Lab.FAILURES.RESTORE_FAILED);
  assert.ok(own.events.includes('stop'));
  assert.deepEqual(readdirSync(own.args.workRoot), []);
});

test('CL-10 the files swapped between the approved proof and the lab\'s use are detected (the proof is about the bytes the lab uses)', async () => {
  const h = harness();
  h.deps.cloneRestoreMain = async (_a, o) => { o.log('A5C_RESULT=VERIFIED'); writeFileSync(h.args.archive, Buffer.from('PGDMP-swapped!'), { mode: 0o600 }); return 0; };
  const r = await run(h);
  assert.equal(r.code, Lab.FAILURES.BACKUP_REJECTED);
  assert.ok(!h.events.includes('start'));
});

// ---- pre-migration verification (nothing is migrated unless the copy is exactly the frozen EXACT_G20) -------------------------------------------

test('CL-11 source generations G19-like / G21 / G22 are refused before any migration', async () => {
  for (const generation of ['EXACT_G21', 'EXACT_G22']) {
    const h = harness({ db: new FakeDb({ generation }) });
    assert.equal((await run(h)).code, Lab.FAILURES.SOURCE_INVALID, generation);
    assert.deepEqual(h.stepLog, [], generation);
  }
  const older = harness({ db: new FakeDb({ ledger: [] }) });
  assert.equal((await run(older)).code, Lab.FAILURES.SOURCE_INVALID);
  assert.deepEqual(older.stepLog, []);
});

test('CL-12 an e-mail collision, no operative OWNER and a drifted G20 schema each stop before any migration', async () => {
  const collision = harness({ db: new FakeDb({ data: { collisionGroups: 1 } }) });
  assert.equal((await run(collision)).code, Lab.FAILURES.SOURCE_INVALID);
  const noOwner = harness({ db: new FakeDb({ data: { operativeOwners: 0 } }) });
  assert.equal((await run(noOwner)).code, Lab.FAILURES.SOURCE_INVALID);
  const drift = new FakeDb();
  const raw = (await import('./pilot-g22-fake-db.mjs')).rawFor('EXACT_G20');
  raw.columns = raw.columns.filter((c) => !(c.table === 'SaleExchange' && c.column !== 'id'));
  drift.rawOverride = raw;
  const drifted = harness({ db: drift });
  assert.equal((await run(drifted)).code, Lab.FAILURES.SOURCE_INVALID);
  for (const h of [collision, noOwner, drifted]) assert.deepEqual(h.stepLog, []);
});

test('CL-13 counts that differ from the OWNER-frozen ROLLOUT_COUNTS before the first migration stop the lab', async () => {
  const h = harness({ expectedCounts: { ...baseData().counts, AuditLog: 896 } });
  assert.equal((await run(h)).code, Lab.FAILURES.SOURCE_INVALID);
  assert.deepEqual(h.stepLog, []);
});

test('CL-14 the hard isolation guard: when the cluster identity cannot be proven, nothing is migrated (before and between the pre-checks)', async () => {
  const h = harness({ cluster: { identity: () => false } });
  assert.equal((await run(h)).code, Lab.FAILURES.ISOLATION_REFUSED);
  assert.deepEqual(h.stepLog, []);
  const notUp = harness({ cluster: { start: { ok: false, reason: 'identity' } } });
  assert.equal((await run(notUp)).code, Lab.FAILURES.ISOLATION_REFUSED);
  assert.ok(notUp.events.includes('stop'));
});

// ---- migration failures ------------------------------------------------------------------------------------------------------------------------

test('CL-15 a failing G21 deploy is CLONE_G21_FAILED and G22 is never attempted', async () => {
  const h = harness({ onStep: { EXACT_G21: () => ({ ok: false, detail: 'prisma exited with code 1' }) } });
  assert.equal((await run(h)).code, Lab.FAILURES.G21_FAILED);
  assert.deepEqual(h.stepLog, ['EXACT_G21']);
});

test('CL-16 a G21 deploy that "succeeds" but leaves the wrong generation, or a user at mustChangePassword = true, fails the witness', async () => {
  const wrong = harness({ onStep: { EXACT_G21: ({ db }) => { db.advance('EXACT_G20'); return { ok: true }; } } });
  assert.equal((await run(wrong)).code, Lab.FAILURES.G21_WITNESS_FAILED);
  assert.deepEqual(wrong.stepLog, ['EXACT_G21']);
  const defaults = harness({ onStep: { EXACT_G21: ({ db }) => { db.advance('EXACT_G21'); db.data.userDefaults = { total: 6, mustChange: 1, credentialsSet: 0 }; return { ok: true }; } } });
  assert.equal((await run(defaults)).code, Lab.FAILURES.G21_WITNESS_FAILED);
  const stamped = harness({ onStep: { EXACT_G21: ({ db }) => { db.advance('EXACT_G21'); db.data.userDefaults = { total: 6, mustChange: 0, credentialsSet: 2 }; return { ok: true }; } } });
  assert.equal((await run(stamped)).code, Lab.FAILURES.G21_WITNESS_FAILED);
});

test('CL-17 a row count that changes during G21 is CLONE_DATA_PRESERVATION_FAILED (the witness stops G22)', async () => {
  const h = harness({ onStep: { EXACT_G21: ({ db }) => { db.advance('EXACT_G21'); db.data.counts.Sale += 1; return { ok: true }; } } });
  assert.equal((await run(h)).code, Lab.FAILURES.DATA_PRESERVATION_FAILED);
  assert.deepEqual(h.stepLog, ['EXACT_G21']);
});

test('CL-18 an UPDATE that keeps every count (the AuditLog content, a user hash) is caught by the content fingerprint', async () => {
  for (const table of ['AuditLog', 'User', 'Sale']) {
    const h = harness({ onStep: { EXACT_G21: ({ db, fp }) => { db.advance('EXACT_G21'); fp.current = { ...fp.current, [table]: `10:mutated-${table}` }; return { ok: true }; } } });
    assert.equal((await run(h)).code, Lab.FAILURES.DATA_PRESERVATION_FAILED, table);
    assert.deepEqual(h.stepLog, ['EXACT_G21'], table);
  }
});

test('CL-19 a failing G22 deploy is CLONE_G22_FAILED', async () => {
  const h = harness({ onStep: { EXACT_G22: () => ({ ok: false, detail: 'prisma exited with code 1' }) } });
  assert.equal((await run(h)).code, Lab.FAILURES.G22_FAILED);
  assert.deepEqual(h.stepLog, ['EXACT_G21', 'EXACT_G22']);
});

test('CL-20 after G22: the lower(email) index missing, UserAdminOperation not empty, or a changed AuditLog are CLONE_G22_VERIFY_FAILED / DATA_PRESERVATION_FAILED', async () => {
  const noIndex = harness({ onStep: { EXACT_G22: ({ db }) => { db.advance('EXACT_G22'); db.data.lowerIndexDef = null; return { ok: true }; } } });
  assert.equal((await run(noIndex)).code, Lab.FAILURES.G22_VERIFY_FAILED);
  const rows = harness({ onStep: { EXACT_G22: ({ db }) => { db.advance('EXACT_G22'); db.data.adminOperations = 1; return { ok: true }; } } });
  assert.equal((await run(rows)).code, Lab.FAILURES.G22_VERIFY_FAILED);
  const audit = harness({ onStep: { EXACT_G22: ({ db, fp }) => { db.advance('EXACT_G22'); fp.current = { ...fp.current, AuditLog: '10:other' }; return { ok: true }; } } });
  assert.equal((await run(audit)).code, Lab.FAILURES.DATA_PRESERVATION_FAILED);
  const count = harness({ onStep: { EXACT_G22: ({ db }) => { db.advance('EXACT_G22'); db.data.counts.AuditLog += 1; return { ok: true }; } } });
  assert.equal((await run(count)).code, Lab.FAILURES.DATA_PRESERVATION_FAILED);
});

test('CL-21 a successful run reports the counts as preserved against the OWNER-frozen JSON (defence in depth: the start check CL-13 plus the core baseline already imply it)', async () => {
  // the final comparison with the frozen counts is redundant with CL-13 + the core witness by construction; this pins the reported line
  const h = harness();
  const r = await run(h);
  assert.equal(r.code, 'VERIFIED');
  assert.ok(printed(h).includes('CLONE_COUNTS_PRESERVED'));
});

test('CL-22 the core is read-only on the snapshot path: the fake answered only fixed SELECTs while the lab verified (no DDL/DML from the lab itself)', async () => {
  const h = harness();
  await run(h);
  assert.equal(h.db.readOnlyOnly, true);
});

// ---- cleanup ---------------------------------------------------------------------------------------------------------------------------------------

test('CL-23 cleanup after an error: the cluster is stopped and the run directory removed whatever failed, and the original backup is left intact', async () => {
  for (const onStep of [{ EXACT_G21: () => ({ ok: false, detail: 'x' }) }, { EXACT_G22: () => ({ ok: false, detail: 'x' }) }]) {
    const h = harness({ onStep });
    await run(h);
    assert.ok(h.events.includes('stop'));
    assert.deepEqual(readdirSync(h.args.workRoot), []);
    assert.ok(existsSync(h.args.archive));
  }
  const thrown = harness();
  thrown.deps.readMarkerId = async () => { throw new Error('boom'); };
  assert.equal((await run(thrown)).code, Lab.FAILURES.RESTORE_FAILED);
  assert.ok(thrown.events.includes('stop'));
  assert.deepEqual(readdirSync(thrown.args.workRoot), []);
});

test('CL-24 a cluster that cannot be verified stopped keeps its directory (never deletes under a possibly running PostgreSQL) and the result is not VERIFIED', async () => {
  const h = harness({ cluster: { stopOk: false } });
  const r = await run(h);
  assert.equal(r.code, Lab.FAILURES.CLEANUP_FAILED);
  assert.equal(readdirSync(h.args.workRoot).length, 1, 'the run directory is kept');
});

test('CL-25 a SIGINT/SIGTERM handler registered by the lab performs the same cleanup', async () => {
  const h = harness();
  let abort;
  h.deps.registerAbort = (fn) => { abort = fn; };
  h.deps.makeStepRunner = () => async () => { await abort(); return { ok: false, detail: 'interrupted' }; };
  await run(h);
  assert.ok(h.events.includes('stop'));
  assert.deepEqual(readdirSync(h.args.workRoot), []);
});

// ---- classification, fingerprint, stop verification, staging ---------------------------------------------------------------------------------

test('CL-26 classification is pure and total: every core outcome maps to exactly one lab code, and data preservation wins over the step', () => {
  const c = Lab.classifyOutcome;
  assert.equal(c({ result: 'MIGRATED' }), null);
  assert.equal(c({ result: 'REFUSED', step: 'precheck', detail: 'EMAIL_COLLISION' }), Lab.FAILURES.SOURCE_INVALID);
  assert.equal(c({ result: 'RESTORE_REQUIRED', step: 'G21', detail: 'the ledger/schema is not provably EXACT_G20' }, { applyFailed: ['EXACT_G21'] }), Lab.FAILURES.G21_FAILED);
  assert.equal(c({ result: 'RESTORE_REQUIRED', step: 'G21', detail: 'ledger: x' }, { applyFailed: [] }), Lab.FAILURES.G21_WITNESS_FAILED);
  assert.equal(c({ result: 'REFUSED', step: 'G21-to-G22', detail: 'EMAIL_COLLISION' }), Lab.FAILURES.G21_WITNESS_FAILED);
  assert.equal(c({ result: 'RESUMABLE', step: 'G22', detail: 'x' }, { applyFailed: ['EXACT_G22'] }), Lab.FAILURES.G22_FAILED);
  assert.equal(c({ result: 'RESTORE_REQUIRED', step: 'G22', detail: 'UserAdminOperation is not empty' }, { applyFailed: [] }), Lab.FAILURES.G22_VERIFY_FAILED);
  assert.equal(c({ result: 'RESTORE_REQUIRED', step: 'G21', detail: 'count changed: Sale 36 -> 37' }, { applyFailed: [] }), Lab.FAILURES.DATA_PRESERVATION_FAILED);
  assert.equal(c({ result: 'RESTORE_REQUIRED', step: 'G22', detail: 'data fingerprint changed: AuditLog' }, { applyFailed: [] }), Lab.FAILURES.DATA_PRESERVATION_FAILED);
});

test('CL-27 the fingerprint queries are fixed literals over the business tables and detect a changed table by name', async () => {
  assert.deepEqual(Object.keys(Lab.FINGERPRINT_SQL).sort(), ['AuditLog', 'CashSession', 'Inventory', 'Sale', 'SaleExchange', 'SalePayment', 'SaleVoid', 'StockMovement', 'User', 'UserRoleScope']);
  for (const sql of Object.values(Lab.FINGERPRINT_SQL)) assert.match(sql, /^SELECT count\(\*\)::text AS n, COALESCE\(md5\(/);
  const client = { query: async () => ({ rows: [{ n: '3', d: 'abc' }] }) };
  const fp = await Lab.readFingerprint(client);
  assert.deepEqual(Lab.diffFingerprint(fp, { ...fp, Sale: '3:zzz' }), ['Sale']);
});

test('CL-28 stop verification: stopped only when every recorded process (pid + start time) is gone and pid file / socket are released; escalation reaches SIGKILL', async () => {
  const dir = mk();
  const pidFile = path.join(dir, 'postmaster.pid'); const sockFile = path.join(dir, '.s.PGSQL.5432');
  writeFileSync(pidFile, '1\n'); writeFileSync(sockFile, '');
  const calls = []; const killed = [];
  let alive = true;
  const deps = { fs: nodeFs, stopVerifyMs: 30, pollMs: 5, procs: { stat: (pid) => (alive ? { state: 'S', start: '77', exe: 'x', ppid: 0, pid } : null), children: () => [], kill: (pid, sig) => { killed.push([pid, sig]); alive = false; rmSync(pidFile); rmSync(sockFile); } } };
  const child = async (_f, args) => { calls.push(args.find((a) => a.startsWith('--mode='))); return { status: 0, timedOut: false }; };
  const ok = await Lab.stopAndVerify({ deps, child, data: dir, pidFile, sockFile, tracked: new Map([[4242, '77']]), trackCluster: () => {} });
  assert.equal(ok, true);
  assert.deepEqual(calls, ['--mode=fast', '--mode=immediate']);
  assert.deepEqual(killed, [[4242, 'SIGKILL']]);
  // a process that survives everything leaves the run NOT stopped
  writeFileSync(pidFile, '1\n');
  const stuck = { ...deps, procs: { ...deps.procs, stat: () => ({ state: 'S', start: '77' }), kill: () => {} } };
  assert.equal(await Lab.stopAndVerify({ deps: stuck, child, data: dir, pidFile, sockFile, tracked: new Map([[4242, '77']]), trackCluster: () => {} }), false);
});

test('CL-29 the staged tree of one generation is exactly the approved prefix (config, schema, lock, N migrations), verified twice, and any change is caught', async () => {
  const { readLockedFile } = await import('./pilot-plan-binding.mjs');
  const { sha256 } = await import('./pilot-launch-command.mjs');
  const schemaSha256 = sha256(readLockedFile(path.join(API_DIR, 'prisma', 'schema.prisma')).bytes);
  const parent = mk();
  for (const [generation, n] of [['EXACT_G21', 21], ['EXACT_G22', 22]]) {
    const staged = Lab.stageLabRun({ apiDir: API_DIR, stageParent: parent, generation, schemaSha256 });
    assert.equal(staged.ok, true, staged.reason);
    assert.equal(pinsOf(generation).length, n);
    const names = readdirSync(path.join(staged.root, 'prisma', 'migrations')).filter((x) => x !== 'migration_lock.toml');
    assert.equal(names.length, n);
    assert.equal(staged.verify().ok, true);
    const cfg = nodeFs.readFileSync(path.join(staged.root, 'prisma.config.ts'), 'utf8');
    assert.match(cfg, /only a Unix-socket DATABASE_URL/); assert.doesNotMatch(cfg, /sslmode|supabase|\.crt/);
    writeFileSync(path.join(staged.root, 'prisma', 'migrations', names[0], 'migration.sql'), '-- tampered\n');
    assert.equal(staged.verify().ok, false);
    writeFileSync(path.join(staged.root, 'extra.txt'), 'x');
    assert.equal(staged.verify().ok, false);
    staged.cleanup();
    assert.equal(existsSync(staged.root), false);
  }
  assert.equal(Lab.stageLabRun({ apiDir: API_DIR, stageParent: parent, generation: 'EXACT_G21', schemaSha256: 'f'.repeat(64) }).ok, false, 'a schema that is not the verified copy is refused');
});

test('CL-30 the lab never reads a PILOT file or opens a remote path: its source has no URL-file, marker-file or remote-capable reference', () => {
  const src = nodeFs.readFileSync(path.join(HERE, 'pilot-g22-clone-lab.mjs'), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(src, /pilot-database-url|PILOT_URL_FILE|createVerifiedClient|readPrivateUrlFile|pilot-marker-id|supabase|\.config\/mona-jacinta/i);
  assert.doesNotMatch(src, /--target|DATABASE_URL\s*=\s*process|process\.env\.DATABASE_URL/);
});
