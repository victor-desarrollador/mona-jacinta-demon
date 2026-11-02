// Zero-database tests: the pre-migration checkpoint of the USER-MGMT rollout is the EXISTING G20 backup + clone-restore at --expected-state=EXACT_G20. The repository now
// holds 22 migrations; these tests prove the G20 tools did not become unusable (or retarget to a newer generation) because of it, and that the backup stays a G20 backup.
// Run with: node --test scripts/database/pilot-g22-backup-compat.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as BACKUP from './pilot-g20-backup.mjs';
import { G20_EXACT_STATES, TOOLS, buildOwnerCommand } from './pilot-g20-launch-command.mjs';
import { SCHEMA_REFERENCES_G20 } from './pilot-g20-schema-references.mjs';
import { SCHEMA_REFERENCES_G22 } from './pilot-g22-schema-references.mjs';
import { GENERATIONS, pinsOf } from './pilot-migration-generations.mjs';

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

test('BC-04 the G20 backup / clone-restore manifests are CURRENT after this work (no pinned file of theirs changed): the canonical --check says so', () => {
  const r = spawnSync(process.execPath, [path.join(DIR, 'pilot-g20-tool-manifests.mjs'), '--check'], { cwd: REPO, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /pilot-g20-backup: CURRENT/); assert.match(r.stdout, /pilot-g20-clone-restore: CURRENT/);
});
