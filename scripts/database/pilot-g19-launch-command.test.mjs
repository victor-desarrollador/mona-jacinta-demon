// Hermetic tests for pilot-g19-launch-command.mjs (the OWNER command builder of the G19 backup / clone-restore tools).
// Temp fixtures only; no credentials, no database, no network. Run: node --test scripts/database/pilot-g19-launch-command.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as realFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as L from './pilot-g19-launch-command.mjs';
import * as BASE from './pilot-launch-command.mjs';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const tmpRoots = [];
const mkTmp = () => { const d = realFs.mkdtempSync(path.join(os.tmpdir(), 'plc19-')); tmpRoots.push(d); return d; };
const put = (f, data, mode = 0o644) => { realFs.mkdirSync(path.dirname(f), { recursive: true }); realFs.writeFileSync(f, data); realFs.chmodSync(f, mode); };
process.on('exit', () => { for (const d of tmpRoots) realFs.rmSync(d, { recursive: true, force: true }); });

const TRUST_UID = realFs.statSync('/usr/bin/stat').uid;
const TRUST_LITERAL = 'case "$s" in 0:[0-7][0145][0145])';
const BACKUP = 'pilot-g19-backup';
const CLONE = 'pilot-g19-clone-restore';

function launchFixture(tool) {
  const base = mkTmp();
  const repo = path.join(base, 'repo dir');
  const script = `scripts/database/${tool}.mjs`;
  const manifest = `scripts/database/${tool}.manifest.json`;
  put(path.join(repo, script), "import { writeFileSync, readFileSync } from 'node:fs';\n"
    + "const ifaces = readFileSync('/proc/self/net/dev', 'utf8').split('\\n').slice(2).map((l) => l.split(':')[0].trim()).filter(Boolean);\n"
    + "writeFileSync(new URL('../../ran.json', import.meta.url), JSON.stringify({ env: process.env, argv: process.argv.slice(2), execArgv: process.execArgv, uid: process.getuid(), ifaces }));\n");
  put(path.join(repo, manifest), '{}\n');
  put(path.join(repo, 'scripts/database/pilot-g19-launch-command.mjs'), '// fixture g19 launch module\n');
  put(path.join(repo, 'scripts/database/pilot-launch-command.mjs'), '// fixture base launch module\n');
  const nodeDir = path.join(base, 'node bin');
  realFs.mkdirSync(nodeDir, { recursive: true });
  const node = path.join(nodeDir, 'node');
  realFs.symlinkSync(process.execPath, node);
  const outDir = path.join(base, 'out');
  realFs.mkdirSync(outDir, { mode: 0o700 });
  const digests = {
    toolSha256: sha(realFs.readFileSync(path.join(repo, script))),
    manifestSha256: sha(realFs.readFileSync(path.join(repo, manifest))),
    launchSha256: sha(realFs.readFileSync(path.join(repo, 'scripts/database/pilot-g19-launch-command.mjs'))),
    baseLaunchSha256: sha(realFs.readFileSync(path.join(repo, 'scripts/database/pilot-launch-command.mjs'))),
    nodeSha256: sha(realFs.readFileSync(node)),
  };
  return { base, repo, node, outDir, digests, ranFile: path.join(repo, 'ran.json') };
}
const params = (tool, fx, expectedState = 'EXACT_G19') => (tool === BACKUP
  ? { outputDir: fx.outDir, expectedState }
  : { archive: `${fx.outDir}/a.dump`, manifestFile: `${fx.outDir}/a.dump.manifest.json`, workRoot: fx.outDir, expectedState });
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

test('L19-01 the tool table is the two G19 tools only; the G14 tools are not launchable from here (and the other way round)', () => {
  assert.deepEqual(Object.keys(L.TOOLS), [BACKUP, CLONE]);
  const fx = launchFixture(BACKUP);
  const good = { tool: BACKUP, repoDir: fx.repo, nodePath: fx.node, ...fx.digests, params: params(BACKUP, fx) };
  assert.equal(typeof L.buildOwnerCommand(good), 'string');
  for (const tool of ['pilot-backup', 'pilot-clone-restore', 'pilot-migrate', 'pilot-g19-migrate']) assert.throws(() => L.buildOwnerCommand({ ...good, tool }), /unknown tool/, tool);
  // the historical builder still refuses the G19 tools and is untouched by this module
  assert.ok(!Object.hasOwn(BASE.TOOLS, BACKUP) && !Object.hasOwn(BASE.TOOLS, CLONE));
  assert.deepEqual(Object.keys(BASE.TOOLS), ['pilot-backup', 'pilot-clone-restore']);
});

test('L19-02 the exact-state enum is closed to EXACT_G16 and EXACT_G19: no intermediate (G17, G18), no G14-era state, no injection', () => {
  const fx = launchFixture(BACKUP);
  const good = { tool: BACKUP, repoDir: fx.repo, nodePath: fx.node, ...fx.digests, params: params(BACKUP, fx) };
  for (const state of ['EXACT_G16', 'EXACT_G19']) assert.match(L.buildOwnerCommand({ ...good, params: { ...good.params, expectedState: state } }), new RegExp(`--expected-state=${state}`));
  for (const state of ['EXACT_G14', 'EXACT_G15', 'EXACT_G17', 'EXACT_G18', 'EXACT_G20', 'EXACT_S4', 'EXACT_G19;id', '/tmp/x', '']) {
    assert.throws(() => L.buildOwnerCommand({ ...good, params: { ...good.params, expectedState: state } }), undefined, state);
  }
  assert.deepEqual([...L.G19_EXACT_STATES], ['EXACT_G16', 'EXACT_G19']);
});

test('L19-03 the builder rejects extra/missing keys, unsafe params and malformed digests (including the new base launch digest)', () => {
  const fx = launchFixture(BACKUP);
  const good = { tool: BACKUP, repoDir: fx.repo, nodePath: fx.node, ...fx.digests, params: params(BACKUP, fx) };
  const bad = [
    { ...good, extra: 1 }, { ...good, params: { ...good.params, outputDir: '/tmp/a b' } }, { ...good, params: { ...good.params, outputDir: "/tmp/a'b" } },
    { ...good, params: { ...good.params, outputDir: 'relative/dir' } }, { ...good, params: { ...good.params, outputDir: '/tmp/../etc' } },
    { ...good, params: { outputDir: fx.outDir } }, { ...good, params: { ...good.params, extra: '/x' } },
    { ...good, toolSha256: 'xyz' }, { ...good, baseLaunchSha256: 'A'.repeat(64) }, { ...good, repoDir: '/tmp/a"b' }, { ...good, nodePath: 'node' },
    { ...good, tool: CLONE },
  ];
  for (const [i, b] of bad.entries()) assert.throws(() => L.buildOwnerCommand(b), undefined, `case ${i}`);
  const { baseLaunchSha256, ...missing } = good;
  assert.throws(() => L.buildOwnerCommand(missing), /exactly/);
});

test('L19-04 backup command: ANY wrong digest of the chain (tool, manifest, G19 launch, G14 launch, node) stops it; the right ones run with exactly HOME/PATH/LANG', () => {
  const fx = launchFixture(BACKUP);
  for (const k of ['toolSha256', 'manifestSha256', 'launchSha256', 'baseLaunchSha256', 'nodeSha256']) {
    assert.equal(runLaunch(BACKUP, fx, { digests: { [k]: '0'.repeat(64) } }).ran, false, k);
  }
  const r = runLaunch(BACKUP, fx);
  assert.equal(r.ran, true, r.stderr);
  assert.deepEqual(Object.keys(r.rec.env).sort(), ['HOME', 'LANG', 'PATH']);
  assert.equal(r.rec.env.PATH, '/usr/bin:/bin'); assert.equal(r.rec.env.LANG, 'C.UTF-8'); assert.equal(r.rec.env.HOME, os.userInfo().homedir);
  assert.deepEqual(r.rec.argv, ['--target=pilot', '--execute', `--output-dir=${fx.outDir}`, '--expected-state=EXACT_G19']);
  assert.deepEqual(r.rec.execArgv, []);
  assert.doesNotMatch(r.cmd, /unshare/);
});

test('L19-05 clone command: a new network namespace as non-root, without HOME, exactly PATH/LANG; a wrong digest stops it', () => {
  const fx = launchFixture(CLONE);
  assert.match(L.buildOwnerCommand({ tool: CLONE, repoDir: fx.repo, nodePath: fx.node, ...fx.digests, params: params(CLONE, fx) }), /"\/usr\/bin\/unshare" -U -n --map-current-user/);
  const r = runLaunch(CLONE, fx);
  assert.equal(r.ran, true, r.stderr);
  assert.deepEqual(Object.keys(r.rec.env).sort(), ['LANG', 'PATH']);
  assert.deepEqual(r.rec.ifaces, ['lo']);
  assert.notEqual(r.rec.uid, 0);
  assert.deepEqual(r.rec.argv, [`--archive=${fx.outDir}/a.dump`, `--manifest=${fx.outDir}/a.dump.manifest.json`, `--work-root=${fx.outDir}`, '--expected-state=EXACT_G19']);
  assert.equal(runLaunch(CLONE, fx, { digests: { baseLaunchSha256: 'f'.repeat(64) } }).ran, false);
});

test('L19-06 the module re-implements none of the shared guards: it imports them from the G14 launch module and is builtins-only otherwise', () => {
  const source = realFs.readFileSync(new URL('./pilot-g19-launch-command.mjs', import.meta.url), 'utf8');
  assert.deepEqual([...source.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)].map((m) => m[1]).sort(), ['./pilot-launch-command.mjs', 'node:path']);
  assert.doesNotMatch(source, /createHash|readFileSync|spawn|process\.env|checkRuntime\s*=|readPrivateFile\s*=/);
});
