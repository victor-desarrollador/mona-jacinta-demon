// Zero-database tests: the pre-migration checkpoint of the USER-MGMT rollout is the EXISTING G20 backup + clone-restore at --expected-state=EXACT_G20. The repository now
// holds 22 migrations; these tests prove the G20 tools did not become unusable (or retarget to a newer generation) because of it, and that the backup stays a G20 backup.
// Run with: node --test scripts/database/pilot-g22-backup-compat.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as nodeFs from 'node:fs';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as BACKUP from './pilot-g20-backup.mjs';
import { G20_EXACT_STATES, TOOLS, buildOwnerCommand } from './pilot-g20-launch-command.mjs';
import { SCHEMA_REFERENCES_G20 } from './pilot-g20-schema-references.mjs';
import { SCHEMA_REFERENCES_G22 } from './pilot-g22-schema-references.mjs';
import { GENERATIONS, pinsOf } from './pilot-migration-generations.mjs';
import { TOOLS as MANIFEST_TOOLS, main as manifestMain } from './pilot-g20-tool-manifests.mjs';
import { EXPECTED_NODE } from './pilot-launch-command.mjs';
import { PACKAGE_CLOSURE } from './pilot-tool-manifests.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(DIR, '..', '..');
const hex = (c) => c.repeat(64);

test('BC-01 the G20 backup tool still takes exactly an EXACT_G16 or EXACT_G20 backup and lists exactly the 20 reviewed G20 migrations (not the 22 of the repository)', () => {
  assert.deepEqual([...BACKUP.BACKUP_STATES], ['EXACT_G16', 'EXACT_G20']);
  assert.deepEqual([...BACKUP.MIGRATIONS], pinsOf('EXACT_G20').map((m) => m.name));
  assert.equal(BACKUP.MIGRATIONS.length, GENERATIONS.EXACT_G20.length);
  for (const name of BACKUP.MIGRATIONS) {
    const pin = pinsOf('EXACT_G22').find((m) => m.name === name);
    assert.equal(createHash('sha256').update(readFileSync(path.join(REPO, BACKUP.migrationRepoPath(name)))).digest('hex'), pin.sha256, name);
  }
  assert.ok(!BACKUP.MIGRATIONS.some((n) => /user_credentials_epoch|user_admin_lifecycle/.test(n)), 'a backup is never converted into a G21/G22 one');
});

test('BC-02 the launch command accepts --expected-state=EXACT_G20 for both tools and refuses EXACT_G21, EXACT_G22 and anything else', () => {
  assert.deepEqual([...G20_EXACT_STATES], ['EXACT_G16', 'EXACT_G20']);
  const base = (tool, expectedState) => ({
    tool, repoDir: REPO, nodePath: process.execPath, toolSha256: hex('a'), manifestSha256: hex('b'), launchSha256: hex('c'), baseLaunchSha256: hex('d'), nodeSha256: hex('e'),
    params: tool === 'pilot-g20-backup' ? { expectedState, outputDir: '/tmp/out' } : { archive: '/tmp/a', expectedState, manifestFile: '/tmp/m', workRoot: '/tmp/w' },
  });
  for (const tool of Object.keys(TOOLS)) {
    assert.match(buildOwnerCommand(base(tool, 'EXACT_G20')), /--expected-state=EXACT_G20/);
    for (const bad of ['EXACT_G21', 'EXACT_G22', 'EXACT_G19', 'EXACT_G14', 'EXACT_G20;x']) assert.throws(() => buildOwnerCommand(base(tool, bad)), /expected state/, `${tool} ${bad}`);
  }
});

test('BC-03 the G20 tools judge an EXACT_G20 backup with the SAME pinned EXACT_G20 reference the G22 rollout tools use (one source of truth, no second digest)', () => {
  assert.equal(SCHEMA_REFERENCES_G22.EXACT_G20, SCHEMA_REFERENCES_G20.EXACT_G20);
  assert.equal(SCHEMA_REFERENCES_G20.EXACT_G20.digest, '2f9527496aa8d4881ae345baaf8a6a678ca1127ec7319313a80850cffa2026a3');
});

// BC-04 is the HERMETIC half of "the G20 manifests are current after this work": nothing here reads the host's PostgreSQL build.
// It proves the committed manifests still pin the exact repository bytes (the 20 migrations, the generation modules, the tool
// code) and the exact package-lock identities, and that they still pin exactly the binaries each tool verifies. The identity of
// the physical host (PostgreSQL binaries, installed node_modules) is the OPERATIONAL half: `pilot-g20-tool-manifests.mjs --check`
// on the authorised host before Gate B, and verifyCodeManifest inside the tools at launch. See BC-05..BC-08 for that verifier.
const STAND_IN_BINARY = (dir) => { const f = path.join(dir, 'binary'); writeFileSync(f, 'stand-in binary bytes\n'); return f; };
const mkTmp = (list) => { const d = mkdtempSync(path.join(tmpdir(), 'bc-')); list.push(d); return d; };
const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });
const standInBinaries = (stand) => Object.fromEntries(Object.entries(MANIFEST_TOOLS).map(([k, t]) => [k, t.binaries.map(() => stand)]));
const checkRun = (over) => { const lines = []; const code = manifestMain(['--check'], { log: (l) => lines.push(l), error: (l) => lines.push(l), ...over }); return { code, out: lines.join('\n') }; };

test('BC-04 the committed G20 manifests pin the exact repository bytes and package-lock identities, and exactly the binaries each tool verifies (host-independent: no host binary and no installed node_modules byte is read)', () => {
  const lock = JSON.parse(readFileSync(path.join(REPO, 'package-lock.json'), 'utf8')).packages;
  for (const tool of Object.keys(MANIFEST_TOOLS)) {
    const committed = JSON.parse(readFileSync(path.join(DIR, `${tool}.manifest.json`), 'utf8'));
    assert.equal(committed.format, 'mona-pilot-tool-manifest/v1'); assert.equal(committed.tool, tool); assert.equal(committed.node, EXPECTED_NODE);
    const expectedRepo = MANIFEST_TOOLS[tool].repoFiles().map((p) => ({ path: p, sha256: createHash('sha256').update(readFileSync(path.join(REPO, p))).digest('hex') }));
    assert.deepEqual(committed.repoFiles, expectedRepo, `${tool}: a pinned repository file changed without regenerating its manifest`);
    assert.deepEqual(committed.packages.map((p) => [p.name, p.version, p.integrity]),
      PACKAGE_CLOSURE.map((name) => [name, lock[`node_modules/${name}`].version, lock[`node_modules/${name}`].integrity]), `${tool}: the package closure differs from package-lock.json`);
    assert.deepEqual(committed.binaries.map((b) => b.path), MANIFEST_TOOLS[tool].binaries, `${tool}: the pinned binary set differs from the tool's`);
    for (const b of committed.binaries) assert.match(b.sha256, /^[0-9a-f]{64}$/, `${tool} ${b.path}`);
  }
});

test('BC-05 the operational verifier is NOT relaxed: a host whose PostgreSQL build differs from the committed pin is STALE for both tools (the CI runner is such a host)', () => {
  const stand = STAND_IN_BINARY(mkTmp(tmpDirs));
  const { code, out } = checkRun({ root: REPO, binaries: standInBinaries(stand) });
  assert.equal(code, 1);
  assert.match(out, /pilot-g20-backup: STALE/); assert.match(out, /pilot-g20-clone-restore: STALE/);
  assert.doesNotMatch(out, /CURRENT/);
});

// BC-06..BC-08 use a manifest generated on THIS host from stand-in binaries, so they hold on every host and pin the verifier's behaviour.
function fixture() {
  const dir = mkTmp(tmpDirs);
  const stand = STAND_IN_BINARY(dir);
  const manifestDir = path.join(dir, 'manifests'); mkdirSync(manifestDir);
  const binaries = standInBinaries(stand);
  const base = { root: REPO, manifestDir, binaries };
  assert.equal(checkRun({ ...base }).code, 1, 'absent manifests are not current');
  assert.equal(manifestMain(['--write'], { ...base, log: () => {}, error: () => {} }), 0);
  return { dir, stand, manifestDir, binaries, base };
}

test('BC-06 the verifier is CURRENT on the host that matches the manifest, and STALE as soon as one pinned binary byte differs', () => {
  const { stand, base } = fixture();
  const ok = checkRun(base);
  assert.equal(ok.code, 0); assert.match(ok.out, /pilot-g20-backup: CURRENT/); assert.match(ok.out, /pilot-g20-clone-restore: CURRENT/);
  appendFileSync(stand, 'one more byte');
  const bad = checkRun(base);
  assert.equal(bad.code, 1); assert.match(bad.out, /pilot-g20-backup: STALE/); assert.match(bad.out, /pilot-g20-clone-restore: STALE/);
});

test('BC-07 a missing pinned binary is a failure, never CURRENT and never a warning', () => {
  const { stand, base } = fixture();
  rmSync(stand);
  const r = checkRun(base);
  assert.notEqual(r.code, 0);
  assert.doesNotMatch(r.out, /CURRENT/);
  assert.match(r.out, /ERROR/);
});

test('BC-08 a different installed dependency tree (one pinned package file with other bytes) is STALE', () => {
  const { base } = fixture();
  const target = path.join(REPO, 'node_modules', 'pg', 'package.json');
  const altered = { ...nodeFs, readFileSync: (f, ...rest) => (path.resolve(String(f)) === target ? Buffer.concat([nodeFs.readFileSync(f), Buffer.from(' ')]) : nodeFs.readFileSync(f, ...rest)) };
  const r = checkRun({ ...base, fs: altered });
  assert.equal(r.code, 1);
  assert.match(r.out, /pilot-g20-backup: STALE/); assert.match(r.out, /pilot-g20-clone-restore: STALE/);
  assert.doesNotMatch(r.out, /CURRENT/);
});
