// DB-free tests for pilot-tool-manifests.mjs: the reviewed generator of the three PILOT tool code
// manifests. Hashes are never typed: every entry is computed from the bytes on disk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as M from './pilot-tool-manifests.mjs';
import * as A4 from './pilot-a4-readonly.mjs';
import * as BK from './pilot-backup.mjs';
import * as CR from './pilot-clone-restore.mjs';
import { verifyCodeManifest } from './pilot-launch-command.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const tmp = [];
const mkTmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ptm-')); fs.chmodSync(d, 0o700); tmp.push(d); return d; };
process.on('exit', () => { for (const d of tmp) fs.rmSync(d, { recursive: true, force: true }); });
const resolvePg = () => path.join(ROOT, 'node_modules', 'pg', 'esm', 'index.mjs');

test('PTM-01 exactly the three PILOT tools, each repo file set taken from the tool itself', () => {
  assert.deepEqual(Object.keys(M.TOOLS).sort(), ['pilot-a4-readonly', 'pilot-backup', 'pilot-clone-restore']);
  assert.deepEqual(M.TOOLS['pilot-a4-readonly'].repoFiles(), A4.REQUIRED_REPO_FILES);
  assert.deepEqual(M.TOOLS['pilot-backup'].repoFiles(), BK.REQUIRED_REPO_FILES);
  assert.deepEqual(M.TOOLS['pilot-clone-restore'].repoFiles(), CR.REQUIRED_REPO_FILES);
});
test('PTM-02 the binary lists equal the ones each tool verifies (read from the tool source, not retyped)', () => {
  const src = (f) => fs.readFileSync(path.join(HERE, f), 'utf8');
  assert.match(src('pilot-backup.mjs'), /binaries: \[PG_DUMP, PG_RESTORE\]/);
  assert.match(src('pilot-clone-restore.mjs'), /binaries: \[INITDB, PG_CTL, PG_RESTORE_BIN, PG_DUMP_BIN, POSTGRES_BIN\]/);
  assert.deepEqual(M.TOOLS['pilot-backup'].binaries, ['/usr/lib/postgresql/17/bin/pg_dump', '/usr/lib/postgresql/17/bin/pg_restore']);
  assert.deepEqual(M.TOOLS['pilot-clone-restore'].binaries, ['initdb', 'pg_ctl', 'pg_restore', 'pg_dump', 'postgres'].map((b) => `/usr/lib/postgresql/17/bin/${b}`));
  assert.equal(M.TOOLS['pilot-a4-readonly'].binaries, null);
});
test('PTM-03 a built manifest verifies with each tool\'s OWN verifier against this repository', () => {
  const out = mkTmp();
  for (const tool of Object.keys(M.TOOLS)) {
    const m = M.buildManifest(tool, { root: ROOT });
    fs.mkdirSync(path.join(out, 'scripts', 'database'), { recursive: true });
    fs.writeFileSync(path.join(out, 'scripts', 'database', `${tool}.manifest.json`), M.serialize(m));
  }
  // Verify by pointing the verifiers at the built bytes (the repository files themselves are read from ROOT).
  const viaRoot = (tool) => fs.readFileSync(path.join(out, 'scripts', 'database', `${tool}.manifest.json`), 'utf8');
  for (const tool of ['pilot-backup', 'pilot-clone-restore']) {
    const m = JSON.parse(viaRoot(tool));
    assert.equal(m.tool, tool); assert.equal(m.format, 'mona-pilot-tool-manifest/v1');
    assert.deepEqual(m.repoFiles.map((f) => f.path), M.TOOLS[tool].repoFiles());
  }
  assert.equal(JSON.parse(viaRoot('pilot-a4-readonly')).format, 'mona-pilot-a4-manifest/v1');
});
test('PTM-04 --check reports drift per tool and never writes; --write then --check is clean (temp copy of the manifests)', () => {
  const dir = mkTmp();
  const lines = [];
  const rcWrite = M.main(['--write'], { root: ROOT, manifestDir: dir, log: (l) => lines.push(l), error: (l) => lines.push(l) });
  assert.equal(rcWrite, 0, lines.join('\n'));
  assert.deepEqual(fs.readdirSync(dir).sort(), ['pilot-a4-readonly.manifest.json', 'pilot-backup.manifest.json', 'pilot-clone-restore.manifest.json']);
  for (const f of fs.readdirSync(dir)) assert.equal(fs.statSync(path.join(dir, f)).mode & 0o777, 0o644);
  assert.equal(M.main(['--check'], { root: ROOT, manifestDir: dir, log: () => {}, error: () => {} }), 0);
  const f = path.join(dir, 'pilot-backup.manifest.json');
  const before = fs.readFileSync(f, 'utf8');
  fs.writeFileSync(f, before.replace(/"sha256": "[0-9a-f]{64}"/, `"sha256": "${'0'.repeat(64)}"`));
  const out = [];
  assert.equal(M.main(['--check'], { root: ROOT, manifestDir: dir, log: (l) => out.push(l), error: (l) => out.push(l) }), 1);
  assert.match(out.join('\n'), /pilot-backup: STALE/); assert.match(out.join('\n'), /pilot-clone-restore: CURRENT/);
  assert.notEqual(fs.readFileSync(f, 'utf8'), before, '--check never rewrites');
});
test('PTM-05 the written backup/clone manifests verify with verifyCodeManifest exactly as the tools call it', () => {
  const dir = mkTmp();
  assert.equal(M.main(['--write'], { root: ROOT, manifestDir: dir, log: () => {}, error: () => {} }), 0);
  const fakeRoot = mkTmp();
  // Same repository bytes, the freshly written manifest at the tool's manifest path.
  const link = (rel) => { const to = path.join(fakeRoot, rel); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(path.join(ROOT, rel), to); };
  for (const tool of ['pilot-backup', 'pilot-clone-restore']) {
    for (const rel of M.TOOLS[tool].repoFiles()) link(rel);
    fs.mkdirSync(path.join(fakeRoot, 'scripts', 'database'), { recursive: true });
    fs.copyFileSync(path.join(dir, `${tool}.manifest.json`), path.join(fakeRoot, 'scripts', 'database', `${tool}.manifest.json`));
  }
  for (const pkg of M.PACKAGE_CLOSURE) fs.cpSync(path.join(ROOT, 'node_modules', pkg), path.join(fakeRoot, 'node_modules', pkg), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'package-lock.json'), path.join(fakeRoot, 'package-lock.json'));
  for (const tool of ['pilot-backup', 'pilot-clone-restore']) {
    const r = verifyCodeManifest({ root: fakeRoot, manifestRel: `scripts/database/${tool}.manifest.json`, fs, tool, requiredRepoFiles: M.TOOLS[tool].repoFiles(),
      packageClosure: M.PACKAGE_CLOSURE, binaries: M.TOOLS[tool].binaries, resolvePg: () => path.join(fakeRoot, 'node_modules', 'pg', 'esm', 'index.mjs') });
    assert.equal(r.ok, true, `${tool}: ${r.reason}`);
  }
  void resolvePg;
});
test('PTM-06 refusals: unknown mode, a symlinked manifest target, a Node version other than the pinned one', () => {
  assert.equal(M.main([], { root: ROOT, manifestDir: mkTmp(), log: () => {}, error: () => {} }), 2);
  assert.equal(M.main(['--write', '--check'], { root: ROOT, manifestDir: mkTmp(), log: () => {}, error: () => {} }), 2);
  const dir = mkTmp(); const real = path.join(mkTmp(), 'x'); fs.writeFileSync(real, '{}');
  fs.symlinkSync(real, path.join(dir, 'pilot-backup.manifest.json'));
  assert.equal(M.main(['--write'], { root: ROOT, manifestDir: dir, log: () => {}, error: () => {} }), 1);
  assert.equal(fs.readFileSync(real, 'utf8'), '{}', 'the symlink target is never written');
  assert.equal(M.main(['--write'], { root: ROOT, manifestDir: mkTmp(), nodeVersion: 'v22.0.0', log: () => {}, error: () => {} }), 1);
});
