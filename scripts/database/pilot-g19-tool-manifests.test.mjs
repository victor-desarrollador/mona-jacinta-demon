// DB-free tests for pilot-g19-tool-manifests.mjs: the reviewed generator of the two G19 PILOT tool code manifests.
// Hashes are never typed: every entry is computed from the bytes on disk. Run: node --test scripts/database/pilot-g19-tool-manifests.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as M from './pilot-g19-tool-manifests.mjs';
import * as G14 from './pilot-tool-manifests.mjs';
import * as BK from './pilot-g19-backup.mjs';
import * as CR from './pilot-g19-clone-restore.mjs';
import { verifyCodeManifest } from './pilot-launch-command.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const tmp = [];
const mkTmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ptm19-')); fs.chmodSync(d, 0o700); tmp.push(d); return d; };
process.on('exit', () => { for (const d of tmp) fs.rmSync(d, { recursive: true, force: true }); });
const BIN = '/usr/lib/postgresql/17/bin';

test('PTM19-01 exactly the two G19 tools, each repo file set taken from the tool itself; the G14 generator still lists its four, untouched', () => {
  assert.deepEqual(Object.keys(M.TOOLS), ['pilot-g19-backup', 'pilot-g19-clone-restore']);
  assert.deepEqual(M.TOOLS['pilot-g19-backup'].repoFiles(), BK.REQUIRED_REPO_FILES);
  assert.deepEqual(M.TOOLS['pilot-g19-clone-restore'].repoFiles(), CR.REQUIRED_REPO_FILES);
  assert.deepEqual(Object.keys(G14.TOOLS).sort(), ['pilot-a4-readonly', 'pilot-backup', 'pilot-clone-restore', 'pilot-local1-preflight']);
});

test('PTM19-02 the binary lists equal the ones each tool verifies (read from the tool source, not retyped)', () => {
  const src = (f) => fs.readFileSync(path.join(HERE, f), 'utf8');
  assert.match(src('pilot-g19-backup.mjs'), /binaries: \[PG_DUMP, PG_RESTORE\]/);
  assert.match(src('pilot-g19-clone-restore.mjs'), /binaries: \[INITDB, PG_CTL, PG_RESTORE_BIN, PG_DUMP_BIN, POSTGRES_BIN\]/);
  assert.deepEqual(M.TOOLS['pilot-g19-backup'].binaries, [`${BIN}/pg_dump`, `${BIN}/pg_restore`]);
  assert.deepEqual(M.TOOLS['pilot-g19-clone-restore'].binaries, ['initdb', 'pg_ctl', 'pg_restore', 'pg_dump', 'postgres'].map((b) => `${BIN}/${b}`));
});

test('PTM19-03 a built manifest covers the 19 migrations, the generation modules and the pg closure, with the pinned Node', () => {
  const stand = path.join(mkTmp(), 'binary');
  fs.writeFileSync(stand, 'stand-in binary bytes\n');
  for (const tool of Object.keys(M.TOOLS)) {
    const m = M.buildManifest(tool, { root: ROOT, binaries: M.TOOLS[tool].binaries.map(() => stand) });
    assert.equal(m.tool, tool); assert.equal(m.format, 'mona-pilot-tool-manifest/v1'); assert.equal(m.node, 'v24.20.0');
    assert.deepEqual(m.repoFiles.map((f) => f.path), M.TOOLS[tool].repoFiles());
    assert.equal(m.repoFiles.filter((f) => f.path.startsWith('api/prisma/migrations/')).length, 19);
    assert.ok(m.repoFiles.some((f) => f.path === 'scripts/database/pilot-migration-generations.mjs'));
    assert.equal(m.packages.length, 14);
    for (const f of m.repoFiles) assert.match(f.sha256, /^[0-9a-f]{64}$/);
  }
  assert.throws(() => M.buildManifest('pilot-backup', { root: ROOT }), /unknown tool/);
});

test('PTM19-04 --check never writes and reports ABSENT/STALE; --write then --check is clean; a changed byte is STALE; only the two files are written (stand-in binaries)', () => {
  const dir = mkTmp();
  const stand = path.join(mkTmp(), 'binary');
  fs.writeFileSync(stand, 'stand-in binary bytes\n');
  const binaries = Object.fromEntries(Object.entries(M.TOOLS).map(([k, t]) => [k, t.binaries.map(() => stand)]));
  const lines = [];
  const common = { root: ROOT, manifestDir: dir, binaries, log: (l) => lines.push(l), error: (l) => lines.push(l) };
  assert.equal(M.main(['--check'], common), 1, 'absent manifests are not current');
  assert.deepEqual(fs.readdirSync(dir), [], '--check wrote nothing');
  assert.match(lines.join('\n'), /pilot-g19-backup: ABSENT/);
  assert.equal(M.main(['--write'], common), 0, lines.join('\n'));
  assert.deepEqual(fs.readdirSync(dir).sort(), ['pilot-g19-backup.manifest.json', 'pilot-g19-clone-restore.manifest.json']);
  for (const f of fs.readdirSync(dir)) assert.equal(fs.statSync(path.join(dir, f)).mode & 0o777, 0o644);
  assert.equal(M.main(['--check'], common), 0);
  fs.appendFileSync(path.join(dir, 'pilot-g19-backup.manifest.json'), ' ');
  assert.equal(M.main(['--check'], common), 1);
  assert.match(lines.join('\n'), /pilot-g19-backup: STALE/);
  for (const bad of [[], ['--check', '--write'], ['--bogus']]) assert.equal(M.main(bad, common), 2);
  assert.equal(M.main(['--check'], { ...common, nodeVersion: 'v1.0.0' }), 1);
});

test('PTM19-05 a manifest it wrote verifies with the tool\'s OWN verifier (verifyCodeManifest) against this repository and the real PostgreSQL 17 binaries', (t) => {
  if (!fs.existsSync(`${BIN}/pg_dump`) || !fs.existsSync(`${BIN}/pg_restore`)) { t.skip('PostgreSQL 17 client binaries are not installed here'); return; }
  const root = mkTmp();
  const manifestRel = 'scripts/database/pilot-g19-backup.manifest.json';
  fs.mkdirSync(path.join(root, 'scripts', 'database'), { recursive: true });
  fs.writeFileSync(path.join(root, manifestRel), M.serialize(M.buildManifest('pilot-g19-backup', { root: ROOT })), { mode: 0o644 });
  // verifyCodeManifest reads the repo files from `root`: link the real tree's files into the temp root (no copy of node_modules needed: symlinks resolve there)
  for (const rel of BK.REQUIRED_REPO_FILES) { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.copyFileSync(path.join(ROOT, rel), path.join(root, rel)); }
  fs.copyFileSync(path.join(ROOT, 'package-lock.json'), path.join(root, 'package-lock.json'));
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(root, 'node_modules'));
  const verify = (tool, over = {}) => verifyCodeManifest({
    root, manifestRel, fs, tool, requiredRepoFiles: BK.REQUIRED_REPO_FILES, packageClosure: G14.PACKAGE_CLOSURE, binaries: [`${BIN}/pg_dump`, `${BIN}/pg_restore`],
    resolvePg: () => path.join(root, 'node_modules', 'pg', 'esm', 'index.mjs'), ...over,
  });
  const ok = verify('pilot-g19-backup');
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.repoSha.get('scripts/database/pilot-g19-launch-command.mjs').length, 64);
  assert.equal(verify('pilot-g19-clone-restore').ok, false, 'the tool name is part of the manifest');
  fs.appendFileSync(path.join(root, 'api/prisma/migrations/20261026130000_sale_exchange_schema/migration.sql'), '-- tampered\n');
  assert.equal(verify('pilot-g19-backup').ok, false, 'a changed migration byte stops the tool');
});
