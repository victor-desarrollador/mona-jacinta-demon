// Hermetic tests for pilot-launch-command.mjs (shared launch-time guards + OWNER command builder).
// Temp fixtures only; no credentials, no database, no network (run under a no-network namespace).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as realFs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as L from './pilot-launch-command.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL_ROOT = path.resolve(HERE, '..', '..');
const sha = (b) => createHash('sha256').update(b).digest('hex');
const tmpRoots = [];
const mkTmp = () => { const d = realFs.mkdtempSync(path.join(os.tmpdir(), 'plc-')); tmpRoots.push(d); return d; };
const put = (f, data, mode = 0o644) => { realFs.mkdirSync(path.dirname(f), { recursive: true }); realFs.writeFileSync(f, data); realFs.chmodSync(f, mode); };
process.on('exit', () => { for (const d of tmpRoots) realFs.rmSync(d, { recursive: true, force: true }); });

// ---------------- builder (E09, E10) ----------------
const TRUST_UID = realFs.statSync('/usr/bin/stat').uid; // overflow uid inside a user namespace, 0 outside
const TRUST_LITERAL = 'case "$s" in 0:[0-7][0145][0145])';
function launchFixture(tool) {
  const base = mkTmp();
  const repo = path.join(base, 'repo dir');
  const script = tool === 'pilot-backup' ? 'scripts/database/pilot-backup.mjs' : 'scripts/database/pilot-clone-restore.mjs';
  const manifest = tool === 'pilot-backup' ? 'scripts/database/pilot-backup.manifest.json' : 'scripts/database/pilot-clone-restore.manifest.json';
  // The fixture "tool" records exactly what the launch chain gave it.
  put(path.join(repo, script), "import { writeFileSync, readFileSync } from 'node:fs';\n"
    + "const ifaces = readFileSync('/proc/self/net/dev', 'utf8').split('\\n').slice(2).map((l) => l.split(':')[0].trim()).filter(Boolean);\n"
    + "writeFileSync(new URL('../../ran.json', import.meta.url), JSON.stringify({ env: process.env, argv: process.argv.slice(2), execArgv: process.execArgv, uid: process.getuid(), ifaces }));\n");
  put(path.join(repo, manifest), '{}\n');
  put(path.join(repo, 'scripts/database/pilot-launch-command.mjs'), '// fixture launch module\n');
  const nodeDir = path.join(base, 'node bin');
  realFs.mkdirSync(nodeDir, { recursive: true });
  const node = path.join(nodeDir, 'node');
  realFs.symlinkSync(process.execPath, node);
  const outDir = path.join(base, 'out');
  realFs.mkdirSync(outDir, { mode: 0o700 });
  const digests = {
    toolSha256: sha(realFs.readFileSync(path.join(repo, script))),
    manifestSha256: sha(realFs.readFileSync(path.join(repo, manifest))),
    launchSha256: sha(realFs.readFileSync(path.join(repo, 'scripts/database/pilot-launch-command.mjs'))),
    nodeSha256: sha(realFs.readFileSync(node)),
  };
  return { base, repo, node, outDir, digests, ranFile: path.join(repo, 'ran.json') };
}
const params = (tool, fx) => (tool === 'pilot-backup'
  ? { outputDir: fx.outDir, expectedState: 'EXACT_S4' }
  : { archive: `${fx.outDir}/a.dump`, manifestFile: `${fx.outDir}/a.dump.manifest.json`, workRoot: fx.outDir, expectedState: 'EXACT_G11' });
function runLaunch(tool, fx, { digests = {}, keepRootUid = false } = {}) {
  realFs.rmSync(fx.ranFile, { force: true });
  let cmd = L.buildOwnerCommand({ tool, repoDir: fx.repo, nodePath: fx.node, ...fx.digests, ...digests, params: params(tool, fx) });
  if (!keepRootUid && TRUST_UID !== 0) {
    assert.equal(cmd.split(TRUST_LITERAL).length - 1, 1, 'trust literal must occur exactly once');
    cmd = cmd.split(TRUST_LITERAL).join(`case "$s" in ${TRUST_UID}:[0-7][0145][0145])`);
  }
  const r = spawnSync('/bin/sh', ['-c', cmd], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: '/tmp' }, timeout: 20000 });
  const ran = realFs.existsSync(fx.ranFile);
  return { status: r.status, stderr: r.stderr, ran, rec: ran ? JSON.parse(realFs.readFileSync(fx.ranFile, 'utf8')) : null, cmd };
}

test('E09 builder rejects unknown tools, extra/missing keys, unsafe params and malformed digests', () => {
  const fx = launchFixture('pilot-backup');
  const good = { tool: 'pilot-backup', repoDir: fx.repo, nodePath: fx.node, ...fx.digests, params: { outputDir: fx.outDir, expectedState: 'EXACT_G11' } };
  assert.equal(typeof L.buildOwnerCommand(good), 'string');
  assert.ok(L.buildOwnerCommand(good).length > 100);
  const bad = [
    { ...good, tool: 'pilot-migrate' }, { ...good, extra: 1 },
    { ...good, params: { outputDir: '/tmp/a b' } }, { ...good, params: { outputDir: "/tmp/a'b" } }, { ...good, params: { outputDir: '/tmp/$x' } },
    { ...good, params: { outputDir: 'relative/dir' } }, { ...good, params: { outputDir: '/tmp/../etc' } }, { ...good, params: { outputDir: fx.outDir, extra: '/x' } },
    { ...good, params: {} }, { ...good, params: { outputDir: fx.outDir } }, { ...good, params: { outputDir: fx.outDir, expectedState: 'EXACT_G10' } },
    { ...good, params: { outputDir: fx.outDir, expectedState: 'EXACT_S4;id' } }, { ...good, params: { outputDir: fx.outDir, expectedState: '/tmp/x' } },
    { ...good, toolSha256: 'xyz' }, { ...good, nodeSha256: 'A'.repeat(64) }, { ...good, repoDir: '/tmp/a"b' },
    { ...good, nodePath: 'node' }, { ...good, tool: 'pilot-clone-restore' },
  ];
  for (const [i, b] of bad.entries()) assert.throws(() => L.buildOwnerCommand(b), undefined, `case ${i}`);
  const { launchSha256, ...missing } = good;
  assert.throws(() => L.buildOwnerCommand(missing));
});

test('G12 launch contract: EXACT_G12 is accepted only as a member of the closed exact-state enum', () => {
  const fx = launchFixture('pilot-backup');
  const good = { tool: 'pilot-backup', repoDir: fx.repo, nodePath: fx.node, ...fx.digests,
    params: { outputDir: fx.outDir, expectedState: 'EXACT_G12' } };
  assert.match(L.buildOwnerCommand(good), /--expected-state=EXACT_G12/);
  assert.throws(() => L.buildOwnerCommand({ ...good, params: { ...good.params, expectedState: 'EXACT_G13' } }));
});

test('E10 backup command: wrong tool/manifest/launch/node digest stops the chain; correct digests run with exactly HOME/PATH/LANG', () => {
  const fx = launchFixture('pilot-backup');
  for (const k of ['toolSha256', 'manifestSha256', 'launchSha256', 'nodeSha256']) {
    assert.equal(runLaunch('pilot-backup', fx, { digests: { [k]: '0'.repeat(64) } }).ran, false, k);
  }
  const r = runLaunch('pilot-backup', fx);
  assert.equal(r.ran, true, r.stderr);
  assert.deepEqual(Object.keys(r.rec.env).sort(), ['HOME', 'LANG', 'PATH']);
  assert.equal(r.rec.env.PATH, '/usr/bin:/bin'); assert.equal(r.rec.env.LANG, 'C.UTF-8'); assert.equal(r.rec.env.HOME, os.userInfo().homedir);
  assert.deepEqual(r.rec.argv, ['--target=pilot', '--execute', `--output-dir=${fx.outDir}`, '--expected-state=EXACT_S4']);
  assert.deepEqual(r.rec.execArgv, []);
  assert.doesNotMatch(r.cmd, /unshare/);
});

test('E10 clone command: runs in a new network namespace as non-root, without HOME, with exactly PATH/LANG', () => {
  const fx = launchFixture('pilot-clone-restore');
  assert.match(L.buildOwnerCommand({ tool: 'pilot-clone-restore', repoDir: fx.repo, nodePath: fx.node, ...fx.digests, params: params('pilot-clone-restore', fx) }), /"\/usr\/bin\/unshare" -U -n --map-current-user/);
  const r = runLaunch('pilot-clone-restore', fx);
  assert.equal(r.ran, true, r.stderr);
  assert.deepEqual(Object.keys(r.rec.env).sort(), ['LANG', 'PATH']);
  assert.deepEqual(r.rec.ifaces, ['lo']);
  assert.notEqual(r.rec.uid, 0);
  assert.deepEqual(r.rec.argv, [`--archive=${fx.outDir}/a.dump`, `--manifest=${fx.outDir}/a.dump.manifest.json`, `--work-root=${fx.outDir}`, '--expected-state=EXACT_G11']);
  assert.equal(runLaunch('pilot-clone-restore', fx, { digests: { launchSha256: 'f'.repeat(64) } }).ran, false);
});

test('E10 with the fixed uid-0 trust literal, non-root-owned utilities are refused where root is unobservable', () => {
  const fx = launchFixture('pilot-backup');
  const r = runLaunch('pilot-backup', fx, { keepRootUid: true });
  if (TRUST_UID === 0) assert.equal(r.ran, true);
  else { assert.equal(r.ran, false); assert.equal(r.status, 71); }
});

// ---------------- runtime gate (D05) ----------------
test('D05/runtime: exact keys, pinned PATH/LANG, HOME = passwd home, Node v24.20.0, no exec args', () => {
  const base = { env: { HOME: '/h', PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, execArgv: [], version: 'v24.20.0', expectedKeys: ['HOME', 'LANG', 'PATH'], homedir: '/h' };
  assert.equal(L.checkRuntime(base).ok, true);
  for (const extra of ['PGHOST', 'PGPORT', 'PGUSER', 'PGDATABASE', 'PGSERVICE', 'NODE_OPTIONS', 'DATABASE_URL']) {
    const r = L.checkRuntime({ ...base, env: { ...base.env, [extra]: 'x' } });
    assert.equal(r.ok, false, extra); assert.equal(r.phase, 'env');
  }
  assert.equal(L.checkRuntime({ ...base, env: { ...base.env, HOME: '/other' } }).ok, false);
  assert.equal(L.checkRuntime({ ...base, env: { ...base.env, PATH: '/tmp:/usr/bin:/bin' } }).ok, false);
  assert.equal(L.checkRuntime({ ...base, version: 'v20.19.2' }).phase, 'runtime');
  assert.equal(L.checkRuntime({ ...base, execArgv: ['--import=x'] }).phase, 'runtime');
  const noHome = { ...base, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, expectedKeys: ['LANG', 'PATH'], homedir: undefined };
  assert.equal(L.checkRuntime(noHome).ok, true);
  assert.equal(L.checkRuntime({ ...noHome, env: { ...noHome.env, HOME: '/h' } }).ok, false);
});

// ---------------- private files (D01) ----------------
test('D01 readPrivateFile: 0600 regular accepted; symlink, FIFO, socket, 0400, 0644 refused; never blocks', async () => {
  const d = mkTmp();
  const f = path.join(d, 'f'); put(f, 'secret\n', 0o600);
  const ok = L.readPrivateFile(realFs, process.getuid(), f, 4096);
  assert.equal(ok.ok, true); assert.equal(Buffer.from(ok.bytes).toString(), 'secret\n');
  const link = path.join(d, 'l'); realFs.symlinkSync(f, link);
  assert.equal(L.readPrivateFile(realFs, process.getuid(), link, 4096).ok, false);
  for (const mode of [0o400, 0o644, 0o700]) { const g = path.join(d, `m${mode}`); put(g, 'x', mode); assert.equal(L.readPrivateFile(realFs, process.getuid(), g, 4096).ok, false, mode.toString(8)); }
  const fifo = path.join(d, 'fifo'); spawnSync('/usr/bin/mkfifo', ['-m', '600', fifo]);
  const started = Date.now();
  assert.equal(L.readPrivateFile(realFs, process.getuid(), fifo, 4096).ok, false);
  assert.ok(Date.now() - started < 2000);
  const sock = path.join(d, 'sock'); const server = net.createServer(); await new Promise((r) => server.listen(sock, r));
  try { assert.equal(L.readPrivateFile(realFs, process.getuid(), sock, 4096).ok, false); } finally { server.close(); }
  assert.equal(L.readPrivateFile(realFs, process.getuid(), path.join(d, 'missing'), 4096).ok, false);
  assert.equal(L.readPrivateFile(realFs, process.getuid(), f, 3).ok, false, 'size bound');
});

test('D01 readPrivateFile refuses an inode swapped between lstat and open', () => {
  const d = mkTmp(); const f = path.join(d, 'f'); const decoy = path.join(d, 'decoy');
  put(f, 'a', 0o600); put(decoy, 'b', 0o600);
  const fsWrap = { ...realFs, openSync: (p, ...r) => realFs.openSync(p === f ? decoy : p, ...r) };
  assert.equal(L.readPrivateFile(fsWrap, process.getuid(), f, 4096).ok, false);
});

// ---------------- directories and paths (D15, E12) ----------------
test('D15 checkPrivateDir: exactly 0700, owned, real directory', () => {
  const d = mkTmp(); const p = path.join(d, 'p'); realFs.mkdirSync(p); realFs.chmodSync(p, 0o700);
  assert.equal(L.checkPrivateDir(realFs, process.getuid(), p), true);
  realFs.chmodSync(p, 0o750); assert.equal(L.checkPrivateDir(realFs, process.getuid(), p), false);
  realFs.chmodSync(p, 0o700);
  const l = path.join(d, 'l'); realFs.symlinkSync(p, l); assert.equal(L.checkPrivateDir(realFs, process.getuid(), l), false);
  assert.equal(L.checkPrivateDir(realFs, process.getuid() + 1, p), false);
  assert.equal(L.checkPrivateDir(realFs, process.getuid(), path.join(d, 'none')), false);
});
test('D15 checkNoSymlinkComponents refuses a symlinked parent', () => {
  const d = realFs.realpathSync(mkTmp()); const real = path.join(d, 'real'); realFs.mkdirSync(path.join(real, 'x'), { recursive: true });
  const link = path.join(d, 'link'); realFs.symlinkSync(real, link);
  assert.equal(L.checkNoSymlinkComponents(realFs, path.join(real, 'x')), true);
  assert.equal(L.checkNoSymlinkComponents(realFs, path.join(link, 'x')), false);
});
test('D15 isUnderAny handles prefix traps and equality', () => {
  assert.equal(L.isUnderAny('/tmp/a', ['/tmp']), true);
  assert.equal(L.isUnderAny('/tmp', ['/tmp']), true);
  assert.equal(L.isUnderAny('/tmpx/a', ['/tmp']), false);
  assert.equal(L.isUnderAny('/home/u/.local/share/x', ['/tmp', '/var/tmp']), false);
});
test('E12 safePathChars: absolute, normalized, only [A-Za-z0-9/._-]', () => {
  assert.equal(L.safePathChars('/home/u/.local/share/mona-jacinta/pilot-backups'), true);
  for (const p of ['relative', '/a b', "/a'b", '/a"b', '/a$b', '/a/../b', '/a//b', '/a\nb', '/a;b', '/']) assert.equal(L.safePathChars(p), false, JSON.stringify(p));
});

// ---------------- code manifest ----------------
const PKGS = [['pg', '8.23.0'], ['pg-protocol', '1.16.0']];
function manifestFixture({ mutate, after, binaryContent = 'bin' } = {}) {
  const root = mkTmp();
  const repoFiles = ['scripts/database/pilot-marker.mjs', 'scripts/database/lib.mjs'];
  for (const f of repoFiles) put(path.join(root, f), `fixture ${f}\n`);
  const binDir = mkTmp(); const bin = path.join(binDir, 'pg_dump'); put(bin, binaryContent, 0o755);
  const lock = { lockfileVersion: 3, packages: { '': {} } };
  const packages = [];
  for (const [name, version] of PKGS) {
    const files = [`node_modules/${name}/package.json`, `node_modules/${name}/index.js`];
    if (name === 'pg') files.push('node_modules/pg/esm/index.mjs');
    for (const f of files) put(path.join(root, f), `fixture ${f}\n`);
    const integrity = `sha512-${Buffer.from(name + version).toString('base64')}`;
    lock.packages[`node_modules/${name}`] = { version, integrity };
    packages.push({ name, version, integrity, files: files.sort().map((f) => ({ path: f, sha256: sha(realFs.readFileSync(path.join(root, f))) })) });
  }
  put(path.join(root, 'package-lock.json'), JSON.stringify(lock));
  const m = { format: 'mona-pilot-tool-manifest/v1', tool: 'pilot-backup', node: 'v24.20.0',
    repoFiles: repoFiles.map((f) => ({ path: f, sha256: sha(realFs.readFileSync(path.join(root, f))) })),
    packages, binaries: [{ path: bin, sha256: sha(realFs.readFileSync(bin)) }] };
  mutate?.(m);
  put(path.join(root, 'scripts/database/pilot-backup.manifest.json'), JSON.stringify(m));
  after?.({ root, bin });
  return { root, bin, spec: { root, manifestRel: 'scripts/database/pilot-backup.manifest.json', fs: realFs, tool: 'pilot-backup', requiredRepoFiles: repoFiles, packageClosure: PKGS.map(([n]) => n), binaries: [bin], resolvePg: () => path.join(root, 'node_modules/pg/esm/index.mjs') } };
}
test('verifyCodeManifest accepts an exact fixture and returns repo digests', () => {
  const { spec } = manifestFixture();
  const r = L.verifyCodeManifest(spec);
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.repoSha.get('scripts/database/lib.mjs'), sha(realFs.readFileSync(path.join(spec.root, 'scripts/database/lib.mjs'))));
});
for (const [name, opts] of [
  ['tampered repo file', { after: ({ root }) => realFs.appendFileSync(path.join(root, 'scripts/database/lib.mjs'), 'x') }],
  ['tampered binary', { after: ({ bin }) => realFs.appendFileSync(bin, 'x') }],
  ['binary missing from manifest', { mutate: (m) => { m.binaries = []; } }],
  ['unlisted package file', { after: ({ root }) => put(path.join(root, 'node_modules/pg/evil.js'), 'x') }],
  ['symlink in package', { after: ({ root }) => realFs.symlinkSync('/etc/hostname', path.join(root, 'node_modules/pg/l.js')) }],
  ['lockfile integrity differs', { mutate: (m) => { m.packages[0].integrity = 'sha512-AAAA'; } }],
  ['wrong tool name', { mutate: (m) => { m.tool = 'pilot-clone-restore'; } }],
  ['wrong node', { mutate: (m) => { m.node = 'v20.0.0'; } }],
  ['traversal path', { mutate: (m) => { m.repoFiles[0].path = 'scripts/../../etc/passwd'; } }],
  ['missing required repo file', { mutate: (m) => { m.repoFiles = m.repoFiles.slice(1); } }],
]) {
  test(`verifyCodeManifest refuses: ${name}`, () => {
    const { spec } = manifestFixture(opts);
    assert.equal(L.verifyCodeManifest(spec).ok, false);
  });
}
test('verifyCodeManifest refuses a shadowed pg resolution', () => {
  const { spec } = manifestFixture();
  assert.equal(L.verifyCodeManifest({ ...spec, resolvePg: () => '/tmp/shadow/pg/esm/index.mjs' }).ok, false);
});

test('canonicalJson sorts keys deeply and sha256 hashes bytes', () => {
  assert.equal(L.canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 1, e: 0 }] } }), '{"a":{"c":[3,{"e":0,"f":1}],"d":2},"b":1}');
  assert.equal(L.sha256(Buffer.from('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('no socket attempted in this process', () => {
  // Coarse guard: the module never imports net/tls/pg.
  const src = realFs.readFileSync(path.join(HERE, 'pilot-launch-command.mjs'), 'utf8');
  assert.doesNotMatch(src, /from 'node:(net|tls|http|https|dgram)'|from 'pg'/);
  assert.ok(src.length > 1000, 'implementation present');
});
void REAL_ROOT;

// ---------------- runChild (real child processes; found by ITEST: initdb prints to stdout) ----------------
test('runChild: maxStdout 0 drains and DISCARDS stdout (not a failure); stderr is never returned', async () => {
  const r = await L.runChild(spawn, '/bin/sh', ['-c', 'echo chatty; echo secret-in-stderr >&2; exit 0'], { env: { PATH: '/usr/bin:/bin' }, timeoutMs: 5000 });
  assert.equal(r.status, 0); assert.equal(r.overflow, false); assert.equal(r.stdout, ''); assert.equal(JSON.stringify(r).includes('secret-in-stderr'), false);
});
test('runChild: capture within maxStdout, overflow beyond it is a failure', async () => {
  const ok = await L.runChild(spawn, '/bin/sh', ['-c', 'printf abc'], { env: { PATH: '/usr/bin:/bin' }, timeoutMs: 5000, maxStdout: 10 });
  assert.equal(ok.stdout, 'abc'); assert.equal(ok.overflow, false);
  const big = await L.runChild(spawn, '/bin/sh', ['-c', 'head -c 100000 /dev/zero'], { env: { PATH: '/usr/bin:/bin' }, timeoutMs: 5000, maxStdout: 10 });
  assert.equal(big.overflow, true); assert.equal(big.stdout, '');
});
test('runChild: stdin bytes reach the child; timeout escalates to SIGKILL', async () => {
  const echo = await L.runChild(spawn, '/bin/cat', [], { env: {}, input: Buffer.from('xyz'), timeoutMs: 5000, maxStdout: 10 });
  assert.equal(echo.stdout, 'xyz');
  const t0 = Date.now();
  const hung = await L.runChild(spawn, '/bin/sh', ['-c', 'trap "" TERM; sleep 30'], { env: { PATH: '/usr/bin:/bin' }, timeoutMs: 100, killGraceMs: 100 });
  assert.equal(hung.timedOut, true); assert.ok(Date.now() - t0 < 5000);
});
