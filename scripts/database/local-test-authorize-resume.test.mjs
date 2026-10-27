// Zero-database unit tests for scripts/database/local-test-authorize-resume.mjs (V2.3.3 R4 OWNER ceremony).
// Run with: node --test scripts/database/local-test-authorize-resume.test.mjs
// Hermetic: the evidence is produced by the REAL local-test-backup.mjs with a fake runtime and a fake pg_dump/pg_restore;
// the ceremony is driven through an injected terminal (the real tool reads /dev/tty only); no database, no process of its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import * as authorize from './local-test-authorize-resume.mjs';
import * as backup from './local-test-backup.mjs';
import * as prepare from './local-test-prepare.mjs';
import * as witness from './local-test-witness.mjs';

const SOURCE = readFileSync(new URL('./local-test-authorize-resume.mjs', import.meta.url), 'utf8');
const BACKUP_TOOL_SHA = createHash('sha256').update(readFileSync(new URL('./local-test-backup.mjs', import.meta.url))).digest('hex');
const MARKER = 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f';
const SECRET = 'AuthS3cretValue';
const URL_TEXT = `postgresql://mona_local_test:${SECRET}@127.0.0.1:5432/mona_local_test`;
const ENV = Object.freeze({ LOCAL_TEST_DATABASE_URL: URL_TEXT, LOCAL_TEST_DATABASE_MARKER_ID: MARKER });
const TARGET = prepare.CONFIRM_LOCAL_TARGET;
const API = '/synthetic/repo/api';
const sha = (label) => createHash('sha256').update(label).digest('hex');
const ARCHIVE = Buffer.from('PGDMP synthetic custom archive bytes\n');
const SNAPSHOT_ID = '00000003-0000001B-1';
const F_PRE = sha('fpre');
const PAYLOAD = Object.freeze({ ok: true, migrations: [{ name: '20260907015311_init', sha256: sha('m1') }], lock: { provider: 'postgresql', sha256: sha('lock') } });
const BACKUP_NOW = '2026-10-05T12:00:00.000Z';
const NOW = '2026-10-05T12:30:00.000Z';
const STORE_POLICY = Object.freeze({ uid: process.getuid(), repoRoot: '/synthetic/repo', forbiddenRoots: ['/synthetic/tmp'] });

const R4_RELATIONS = witness.PROTECTED_RELATION_NAMES;
function toc() {
  const entries = [
    '6; 2615 2200 SCHEMA - public pg_database_owner',
    ...R4_RELATIONS.map((t, i) => `${1000 + i}; 1259 ${20000 + i} TABLE public ${t} mona_local_test`),
    ...R4_RELATIONS.map((t, i) => `${3000 + i}; 0 ${20000 + i} TABLE DATA public ${t} mona_local_test`),
  ];
  return [';', '; Archive created at 2026-10-05 12:00:00 UTC', ';     dbname: mona_local_test', `;     TOC Entries: ${entries.length}`, ';     Compression: gzip', ';     Dump Version: 1.15-0',
    ';     Format: CUSTOM', ';     Integer: 4 bytes', ';     Offset: 8 bytes', ';     Dumped from database version: 17.4', ';     Dumped by pg_dump version: 17.4', ';', '; Selected TOC Entries:', ';', ...entries, ''].join('\n');
}
const TOC = toc();

function scratch(mode = 0o700) {
  const base = mkdtempSync(path.join(os.tmpdir(), 'mona-auth-test-'));
  const root = path.join(base, 'root');
  mkdirSync(root, { mode });
  chmodSync(root, mode);
  const home = path.join(base, 'home');
  mkdirSync(home, { mode: 0o700 });
  chmodSync(home, 0o700);
  return { base, root, home };
}

function fakeBackupSpawn() {
  return (wrapper, wrapperArgs) => {
    const contained = path.basename(wrapper) === 'unshare' && wrapperArgs.includes('--');
    const command = contained ? wrapperArgs[wrapperArgs.indexOf('--') + 1] : wrapper;
    const args = contained ? wrapperArgs.slice(wrapperArgs.indexOf('--') + 2) : wrapperArgs;
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    setImmediate(() => {
      if (path.basename(command) === 'pg_dump') writeFileSync(args[args.indexOf('--file') + 1], ARCHIVE, { mode: 0o600 });
      else child.stdout.write(TOC);
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit('close', 0, null));
    });
    return child;
  };
}

// A finalized backup run of the current checkpoint, produced by the real backup tool.
async function makeEvidence({ now = BACKUP_NOW } = {}) {
  const { root, home } = scratch();
  const when = { now: new Date(Date.parse(now) - 3600 * 1000), plan: sha('generic plan') };
  assert.ok(prepare.supersedeCheckpoints(home, STORE_POLICY, when).ok);
  const recorded = prepare.recordCheckpoint(home, STORE_POLICY, { ...when, markerId: MARKER, payload: PAYLOAD, prepareSha256: sha('prepare') });
  assert.ok(recorded.ok, recorded.reason);
  const out = [];
  const deps = {
    env: { ...ENV }, apiDir: API, repoRoot: '/synthetic/repo', forbiddenRoots: ['/synthetic/tmp'], home,
    pgDump: '/synthetic/pg/bin/pg_dump', pgRestore: '/synthetic/pg/bin/pg_restore',
    hashBinary: (file) => ({ ok: true, sha256: sha(path.basename(file)) }),
    verifyMigrationPayload: () => PAYLOAD,
    loadRuntime: async () => ({
      proveIdentity: async () => undefined,
      withBackupSnapshot: async (cb) => cb({ snapshotId: SNAPSHOT_ID, fPre: F_PRE, serverVersionNum: '170004', markerId: MARKER, protectedDomainContractSha256: sha('domain-contract') }),
      close: async () => undefined,
    }),
    spawn: fakeBackupSpawn(), childTimeoutMs: 2000, now: () => new Date(now), randomSuffix: () => 'a1b2c3d4',
    log: (l) => out.push(l), error: (l) => out.push(l),
  };
  const common = [`--marker-id=${MARKER}`, `--output-root=${root}`];
  assert.equal(await backup.main(['--dry-run', ...common], deps), 0, out.join('\n'));
  const plan = /plan digest: ([0-9a-f]{64})/.exec(out.join('\n'))[1];
  assert.equal(await backup.main(['--execute', ...common, `--confirm-local-target=${TARGET}`, `--plan=${plan}`], deps), 0, out.join('\n'));
  const run = `local-test-${new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}-a1b2c3d4`;
  return { root, home, run, runDir: path.join(root, run), dumpSha: sha(ARCHIVE) };
}

const toolDeps = (ev, over = {}) => {
  const out = [];
  const deps = {
    env: { ...ENV }, apiDir: API, execPath: '/synthetic/node/bin/node', home: ev.home, tmpdir: '/synthetic/tmp',
    resolvePrismaCli: () => ({ ok: true, cwd: API, script: `${API}/node_modules/prisma/build/index.js`, version: '7.10.0' }),
    verifyMigrationPayload: () => PAYLOAD,
    hashFile: (file) => ({ ok: true, sha256: path.basename(file) === 'local-test-backup.mjs' ? BACKUP_TOOL_SHA : sha(`hash:${path.basename(file)}`) }),
    hashBinary: (file) => ({ ok: true, sha256: sha(path.basename(file)) }),
    listArchive: async () => ({ ok: true, text: TOC }),
    pgRestore: '/synthetic/pg/bin/pg_restore',
    repoRoot: '/synthetic/repo', forbiddenRoots: ['/synthetic/tmp'], uid: process.getuid(),
    now: () => new Date(NOW), spawn: () => { throw new Error('the authorize tool must not start a process of its own'); },
    log: (l) => out.push(l), error: (l) => out.push(l), ...over,
  };
  return { deps, out };
};
async function planOf(ev) {
  const { deps, out } = toolDeps(ev, { loadRuntime: async () => { throw new Error('dry-run must not load a runtime'); } });
  const code = await prepare.main(['--dry-run', `--marker-id=${MARKER}`, '--resume-from=POST_BACKFILL', `--backup-evidence=${ev.runDir}`], deps);
  assert.equal(code, 0, out.join('\n'));
  return /plan digest: ([0-9a-f]{64})/.exec(out.join('\n'))[1];
}
const ARGS = (ev, plan) => [`--marker-id=${MARKER}`, `--backup-evidence=${ev.runDir}`, `--plan=${plan}`];
function fakeTty(answers) {
  const written = [];
  let opened = 0;
  const queue = [...answers];
  return { written, opened: () => opened, open: () => { opened += 1; return { write: (t) => written.push(t), readLine: async () => queue.shift(), close: () => undefined }; } };
}
const correct = (ev) => [TARGET, F_PRE.slice(0, 12), ev.dumpSha.slice(0, 12), 'RESUME SEED 2'];
const records = (home) => { const dir = witness.authorizationStorePath(home); return existsSync(dir) ? readdirSync(dir).sort() : []; };
const readRecord = async (home, authId) => witness.readAuthorizationRecord({ dir: witness.authorizationStorePath(home), authId, fs: witness.realWitnessFs, now: new Date(NOW) });

test('AZ-01 exactly the three reviewed arguments; unknown, positional, repeated or missing values are refused without echo', async () => {
  const ev = await makeEvidence();
  const plan = await planOf(ev);
  for (const argv of [[], [`--marker-id=${MARKER}`], [...ARGS(ev, plan), '--bogus=hush-value'], ['positional', ...ARGS(ev, plan)], [...ARGS(ev, plan), `--plan=${plan}`], [`--marker-id=${MARKER}`, `--backup-evidence=relative/dir`, `--plan=${plan}`], [`--marker-id=${MARKER}`, `--backup-evidence=${ev.runDir}`, '--plan=short'], ['--yes', ...ARGS(ev, plan)]]) {
    const tty = fakeTty(correct(ev));
    const { deps, out } = toolDeps(ev, { openTty: tty.open });
    assert.equal(await authorize.main(argv, deps), 1, JSON.stringify(argv));
    assert.equal(out.join('\n').includes('hush-value'), false);
    assert.equal(tty.opened(), 0);
    assert.deepEqual(records(ev.home), []);
  }
});

test('AC-087 AZ-02 a missing controlling terminal refuses: nothing is authorized, and the confirmation is never read from argv, stdin or the environment', async () => {
  const ev = await makeEvidence();
  const plan = await planOf(ev);
  const { deps, out } = toolDeps(ev, { openTty: () => { throw new Error('no tty'); }, env: { ...ENV, RESUME_CONFIRM: 'RESUME SEED 2' } });
  assert.equal(await authorize.main(ARGS(ev, plan), deps), 1);
  assert.match(out.join('\n'), /FAIL: phase=tty/);
  assert.deepEqual(records(ev.home), []);
  assert.doesNotMatch(SOURCE, /process\.stdin|readline|process\.env/);
  assert.match(SOURCE, /\/dev\/tty/);
});

test('AC-088 AZ-03 each typed value must match (target, first 12 hex of fPre, first 12 hex of the dump sha256, the literal): any mismatch authorizes nothing and echoes nothing', async () => {
  const ev = await makeEvidence();
  const plan = await planOf(ev);
  const good = correct(ev);
  for (let i = 0; i < 4; i += 1) {
    const answers = good.map((a, j) => (j === i ? `${a}-wrong-CANARY` : a));
    const tty = fakeTty(answers);
    const { deps, out } = toolDeps(ev, { openTty: tty.open });
    assert.equal(await authorize.main(ARGS(ev, plan), deps), 1, `answer ${i}`);
    assert.match(out.join('\n'), /FAIL: phase=confirmation/);
    assert.equal(out.join('\n').includes('CANARY'), false);
    assert.deepEqual(records(ev.home), []);
  }
  // the machine comparison is on the full values: a longer or shorter prefix is not accepted
  for (const short of [F_PRE.slice(0, 11), `${F_PRE.slice(0, 12)}0`]) {
    const tty = fakeTty([TARGET, short, ev.dumpSha.slice(0, 12), 'RESUME SEED 2']);
    const { deps } = toolDeps(ev, { openTty: tty.open });
    assert.equal(await authorize.main(ARGS(ev, plan), deps), 1);
  }
  assert.deepEqual(records(ev.home), []);
});

test('AZ-04 a plan digest that is not the one the resume would compute now is refused BEFORE the terminal is opened', async () => {
  const ev = await makeEvidence();
  const tty = fakeTty(correct(ev));
  const { deps, out } = toolDeps(ev, { openTty: tty.open });
  assert.equal(await authorize.main(ARGS(ev, sha('another plan')), deps), 1);
  assert.match(out.join('\n'), /FAIL: phase=plan/);
  assert.equal(tty.opened(), 0);
  assert.deepEqual(records(ev.home), []);
});

test('AZ-05 invalid backup evidence (tampered manifest) is refused before the terminal is opened', async () => {
  const ev = await makeEvidence();
  const plan = await planOf(ev);
  const file = path.join(ev.runDir, 'local-test.dump.manifest.json');
  const m = JSON.parse(readFileSync(file, 'utf8'));
  m.preWitness.fPre = 'f'.repeat(64); // self-hash now wrong
  writeFileSync(file, `${JSON.stringify(m, null, 2)}\n`, { mode: 0o600 });
  const tty = fakeTty(correct(ev));
  const { deps, out } = toolDeps(ev, { openTty: tty.open });
  assert.equal(await authorize.main(ARGS(ev, plan), deps), 1);
  assert.match(out.join('\n'), /FAIL: phase=backup-evidence/);
  assert.equal(tty.opened(), 0);
  assert.deepEqual(records(ev.home), []);
});

test('AC-081 AZ-06 success: one owner-only record binding target, marker, backup, dump, manifest, fPre, PRE witness, checkpoint, plan, action and expiry — and no streamSha256', async () => {
  const ev = await makeEvidence();
  const plan = await planOf(ev);
  const tty = fakeTty(correct(ev));
  const { deps, out } = toolDeps(ev, { openTty: tty.open });
  assert.equal(await authorize.main(ARGS(ev, plan), deps), 0, out.join('\n'));
  assert.equal(tty.opened(), 1);
  const [file] = records(ev.home);
  assert.match(file, /^[0-9a-f]{32}\.json$/);
  const authId = file.replace('.json', '');
  const dir = witness.authorizationStorePath(ev.home);
  assert.equal(lstatSync(dir).mode & 0o777, 0o700);
  assert.equal(lstatSync(path.join(dir, file)).mode & 0o777, 0o600);
  const read = await readRecord(ev.home, authId);
  assert.equal(read.ok, true, read.reason);
  const r = read.record;
  const manifest = JSON.parse(readFileSync(path.join(ev.runDir, 'local-test.dump.manifest.json'), 'utf8'));
  assert.deepEqual(
    { target: r.target, markerIdSha256: r.markerIdSha256, action: r.action, backupRun: r.backupRun, dumpSha256: r.dumpSha256, fPre: r.fPre, preWitnessSha256: r.preWitnessSha256, checkpointId: r.checkpointId, checkpointRecordSha256: r.checkpointRecordSha256, planDigest: r.planDigest },
    { target: TARGET, markerIdSha256: sha(MARKER), action: 'resume-seed-2', backupRun: ev.run, dumpSha256: ev.dumpSha, fPre: F_PRE, preWitnessSha256: manifest.preWitnessSha256, checkpointId: manifest.checkpoint.id, checkpointRecordSha256: manifest.checkpoint.recordSha256, planDigest: plan },
  );
  assert.equal(r.manifestSha256, createHash('sha256').update(readFileSync(path.join(ev.runDir, 'local-test.dump.manifest.json'))).digest('hex'));
  assert.ok(!('streamSha256' in r));
  assert.ok(Date.parse(r.expiresAt) <= Date.parse(r.createdAt) + 2 * 3600 * 1000);
  assert.ok(Date.parse(r.expiresAt) <= Date.parse(manifest.createdAt) + prepare.MAX_BACKUP_AGE_MS);
  assert.match(out.join('\n'), new RegExp(`AUTHORIZATION OK authId=${authId}`));
  assert.equal(out.join('\n').includes(SECRET) || out.join('\n').includes(URL_TEXT), false);
  // the ceremony text shows the reviewed values to the human (terminal), never the database URL or password
  assert.ok(tty.written.join('').includes(F_PRE.slice(0, 12)));
  assert.equal(tty.written.join('').includes(SECRET), false);
});

test('AZ-07 two ceremonies for the same backup issue two distinct authorizations', async () => {
  const ev = await makeEvidence();
  const plan = await planOf(ev);
  for (let i = 0; i < 2; i += 1) {
    const tty = fakeTty(correct(ev));
    const { deps, out } = toolDeps(ev, { openTty: tty.open });
    assert.equal(await authorize.main(ARGS(ev, plan), deps), 0, out.join('\n'));
  }
  assert.equal(records(ev.home).length, 2);
});

test('AZ-08 the expiry is the earlier of now + 2 h and the backup age limit', async () => {
  const ev = await makeEvidence();
  const plan = await planOf(ev);
  const late = new Date(Date.parse(BACKUP_NOW) + 5.5 * 3600 * 1000);
  const dry = toolDeps(ev, { now: () => late });
  const lateOut = [];
  assert.equal(await prepare.main(['--dry-run', `--marker-id=${MARKER}`, '--resume-from=POST_BACKFILL', `--backup-evidence=${ev.runDir}`], { ...dry.deps, log: (l) => lateOut.push(l), loadRuntime: async () => { throw new Error('x'); } }), 0, lateOut.join('\n'));
  const latePlan = /plan digest: ([0-9a-f]{64})/.exec(lateOut.join('\n'))[1];
  void plan;
  const tty = fakeTty(correct(ev));
  const { deps, out } = toolDeps(ev, { openTty: tty.open, now: () => late });
  assert.equal(await authorize.main(ARGS(ev, latePlan), deps), 0, out.join('\n'));
  const [file] = records(ev.home);
  const read = await witness.readAuthorizationRecord({ dir: witness.authorizationStorePath(ev.home), authId: file.replace('.json', ''), fs: witness.realWitnessFs, now: late });
  assert.equal(read.ok, true, read.reason);
  assert.equal(Date.parse(read.record.expiresAt), Date.parse(BACKUP_NOW) + prepare.MAX_BACKUP_AGE_MS); // 30 minutes left, not 2 h
});

test('AZ-09 the tool starts no process, opens no database and imports no Prisma/pg; only node built-ins and the reviewed local modules', () => {
  const specifiers = [...SOURCE.matchAll(/\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1] ?? m[2]);
  for (const s of specifiers) assert.ok(s.startsWith('node:') || ['./local-test-prepare.mjs', './local-test-safe-error.mjs', './local-test-witness.mjs'].includes(s), `unexpected import ${s}`);
  assert.doesNotMatch(SOURCE, /node:child_process|PrismaClient|new\s+Pool\b|\bspawn\(|\bexec\w*\(/);
});
