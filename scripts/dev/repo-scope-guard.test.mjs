// Hermetic tests for scripts/dev/repo-scope-guard.mjs (TOOL-2).
//
// Node built-ins only. Every fixture is a throwaway git repository under
// os.tmpdir(); the real repository is never touched, no database, no network.
//
// PREREGISTRATION (written before the first run). EXPECTED is the verdict the
// tool contract requires. "P0A #n" = row n of the approved 61-case matrix;
// "P0B-Xnn" = independently derived cases added in TOOLING-P0B.
//
//   P0A #1  protected file dirty ................................ DENY (exit 1)
//   P0A #2  protected file staged ............................... DENY (exit 1)
//   P0A #3  unexpected untracked file ........................... DENY
//   P0A #4  expected dirty path actually clean .................. DENY
//   P0A #5  branch != --expect-branch ........................... DENY
//   P0A #6  HEAD != --expect-head ............................... DENY
//   P0A #7  detached HEAD ....................................... DENY
//   P0A #8  symlink where regular file expected ................. DENY
//   P0A #21 untracked generated file, non-ignored ............... DENY
//   P0A #24 valid clean tree .................................... ALLOW
//   P0A #50 protected path named in --expect-dirty .............. DENY
//   P0A #51 staged rename, only new path expected ............... DENY
//   P0A #52 staged rename, both paths expected .................. ALLOW
//   P0A #53 tracked file deleted and listed ..................... ALLOW
//   P0A #54 tracked file deleted, not listed .................... DENY
//   P0A #55 staged file clean in worktree, not in expect-staged . DENY
//   P0A #56 same file listed in --expect-staged ................. ALLOW
//   P0A #57 gitignored file present ............................. N/A (not observable; not executed)
//   P0A #58 malformed arguments ................................. DENY (exit 2)
//   P0A #59 listed path is a FIFO ............................... DENY
//   P0A #60 clean tree, no expectations ......................... ALLOW
//   P0A #61 matching --expect-branch ............................ ALLOW
//   P0A #18-20, #23 (T3/T4 deferred), #9-17/#22/#25/#27/#28-49 (T1), #26 (hook): not applicable here.
//
//   P0B-XG01 same path staged + modified: in BOTH sets .......... ALLOW only when both listed; DENY when only dirty listed
//   P0B-XG02 spaces/unicode filename ............................ ALLOW exact
//   P0B-XG03 newline inside filename ............................ ALLOW exact
//   P0B-XG04 glob/quote characters inside filename .............. ALLOW exact (paths are literal, not patterns)
//   P0B-XG05 path normalization bypasses (./a, dir//b, dir/../a, /abs, trailing /) .. DENY exit 2
//   P0B-XG06 repeated identical --expect-dirty .................. ALLOW (set semantics)
//   P0B-XG07 repeated --expect-branch / --expect-head ........... DENY exit 2
//   P0B-XG08 abbreviated --expect-head .......................... DENY exit 2 (full SHA required)
//   P0B-XG09 unmerged (merge conflict) .......................... DENY, unmerged reported
//   P0B-XG10 mode change on tracked file ........................ dirty set contains it; DENY unless listed
//   P0B-XG11 staged removal + untracked recreation of same path . path in BOTH sets
//   P0B-XG12 intent-to-add (git add -N) ......................... dirty set contains it
//   P0B-XG13 caller GIT_DIR/GIT_WORK_TREE redirection ........... ignored (env scrubbed): verdict from cwd repo
//   P0B-XG14 directory prefix given instead of file path ........ DENY (exact file paths only)
//   P0B-XG15 case-differing path ................................ DENY (case-sensitive exact)
//   P0B-XG16 cwd not a git repository ........................... BLOCKED (exit 3)
//   P0B-XG17 repository with no commits ......................... head null; ALLOW clean; --expect-head DENY
//   P0B-XG18 protected file removed / renamed away .............. DENY, old path reported
//   P0B-XG19 protected path replaced by symlink ................. DENY, protected path NEVER lstat'ed (nonRegular empty)
//   P0B-XG20 stale-stat index must not be rewritten ............. index bytes identical (read-only guarantee)
//   P0B-XG21 worktree bytes unchanged by a run .................. identical snapshot
//   P0B-XG22 tracked file replaced by directory ................. DENY nonRegular
//   P0B-XG23 deterministic output ............................... two runs deepEqual, arrays sorted
//   P0B-XG24 positional / unknown argument ...................... DENY exit 2
//   P0B-XG25 --opt=value form ................................... accepted, equals separated form
//   P0B-XG26 detached HEAD with exact --expect-head ............. ALLOW

//
// TOOLING-P0D PREREGISTRATION (written BEFORE the first P0D run; EXPECTED outcomes). Finding: P0C showed
// RM/RD porcelain-v2 records attributed the rename ORIGINAL to the worktree-side (DIRTY) set because the
// code keyed off the score letter instead of git's XY semantics (X = index side, Y = worktree side).
//   P0D-G44 `git mv a b` + modify b (RM): staged {a,b}, dirty {b}; ALLOW with those sets; DENY if dirty also lists a
//   P0D-G45 `git mv a b` + delete b (RD): staged {a,b}, dirty {b}
//   P0D-G46 pure staged rename (R.): staged {a,b}, dirty {}
//   P0D-G47 rename then recreate the original untracked: staged {a,b}, dirty {a}
//   P0D-G48 rename chain a->b->c: staged {a,c}, dirty {}
//   P0D-G49 rename + chmod of the destination: staged {a,b}, dirty {b}
//   P0D-G50 protected file renamed away + destination modified: DENY, protected [opencode.json]
//   P0D-G51 another file renamed ONTO a protected path (absent at HEAD): DENY, protected [opencode.json]
//   P0D-G52 oracle matrix: for every X in {. M A D R C T} x Y in {. M D T R C A} x score letter {R,C}: the original
//           participates in STAGED iff X=='R' and in DIRTY iff Y=='R'; the new path iff X!='.' / Y!='.'
//   P0D-G53 synthetic copy (X=='C'): the unchanged source participates in NEITHER set
//   P0D-G54 truncated rename record (original path missing), via injected git: BLOCKED STATUS_PARSE
//   P0D-G55 synthetic worktree-side rename (Y=='R'): original and destination both DIRTY, neither STAGED

//
// TOOLING-P0H PREREGISTRATION for TOOL-2 (written BEFORE the first P0H run). Codex final review MEDIUM C:
// synthetic malformed porcelain-v2 output was accepted instead of failing closed. Expected for EVERY malformed
// shape below: verdict BLOCKED, exit 3, error code STATUS_PARSE (never ALLOW, never DENY). The REQUIRED Codex
// regressions are listed first and do NOT count toward the independent set.
//
//  REQUIRED CODEX REGRESSIONS (not independent)
//   P0H-CX-C1 malformed XY on an ordinary record (`ZZ`) ............................................ BLOCKED
//   P0H-CX-C2 rename record whose original path is empty ............................................ BLOCKED
//   P0H-CX-C3 path `../escape.txt` (traversal) ...................................................... BLOCKED
//   P0H-CX-C4 conflicting duplicate `# branch.head` headers ......................................... BLOCKED
//
//  INDEPENDENT CASES (new in P0H)
//   P0H-P01 ordinary record with an R/C letter (`RM` on a kind-1 record) ........................... BLOCKED
//   P0H-P02 ordinary record `..` (no change recorded); lowercase letters `mM`; `U` on a kind-1 ...... BLOCKED
//   P0H-P03 rename/copy record whose XY carries no R/C at all (`MM` ... R100) ....................... BLOCKED
//   P0H-P04 unmerged record with an XY outside {DD,AU,UD,UA,DU,AA,UU} (`MM`, `.U`) ................. BLOCKED
//   P0H-P05 mode field that is not six octal digits (`10064`, `100x44`, `1006444`) ................... BLOCKED
//   P0H-P06 object-id field that is not 40/64 lowercase hex (39 hex, uppercase, `zz`) ................ BLOCKED
//   P0H-P07 submodule field outside N... / S[C.][M.][U.] (`X...`, `S....`, `n...`) ................... BLOCKED
//   P0H-P08 score field malformed (`R`, `X100`, `R101`, `R-1`, `100R`) .............................. BLOCKED
//   P0H-P09 score letter contradicting the XY letters (`2 R. ... C100`) ............................. BLOCKED
//   P0H-P10 paths: empty segment `a//b`, leading `/`, `./x`, `a/./b`, `a/../b`, `.git/config`,
//           trailing `/` on a tracked record ......................................................... BLOCKED
//   P0H-P11 rename original with traversal / trailing slash / absolute .............................. BLOCKED
//   P0H-P12 missing `# branch.oid` or missing `# branch.head` ....................................... BLOCKED
//   P0H-P13 identical duplicate `# branch.oid` header (selected policy: duplicates are corruption) .. BLOCKED
//   P0H-P14 invalid `# branch.oid` value (`zzz`, 12 hex) and empty `# branch.head` value ............. BLOCKED
//   P0H-P15 a header appearing AFTER entry records ................................................... BLOCKED
//   P0H-P16 empty record in the middle (double NUL); record type without a space (`1X`); `U` type ... BLOCKED
//   P0H-P17 CONTROL harmless/unknown headers (`# branch.upstream`, `# branch.ab`, `# stash 3`,
//           `# future.key value`) ..................................................................... ALLOW (clean tree)
//   P0H-P18 CONTROL `? nested/` (nested repo; git itself emits a trailing slash for untracked) ....... not BLOCKED; DENY by policy
//   P0H-P19 CONTROL real git: typechange (.T), intent-to-add (.A), gitlink (AD S...), copy (C.),
//           RM/RD/R., unmerged UU, filenames with tab / newline / backslash / unicode ................ not BLOCKED; exact sets
//
//  MISMATCH RECORDED DURING P0H RED (not rewritten): the first version of P0H-P19 expected `--expect-dirty 'back\slash.txt'`
//  to ALLOW. It DENIED, because the guard's EXISTING argument contract (P0B, unchanged) rejects a backslash in an
//  expected-path argument (exit 2). Classification: EXPECTATION_ERROR (the test conflated "valid Git path the parser
//  must accept" with "path a user may list"). Class: names that are legal in Git but constrained by the argument
//  contract. Extra cases derived BEFORE continuing, expectations fixed before they ran:
//   P0H-P20 untracked file with a backslash in its name: parser accepts it (not BLOCKED), it is reported in actualDirty;
//           listing it via --expect-dirty is malformed (exit 2); unlisted => DENY unexpectedDirty .... DENY
//   P0H-P21 file named `-dash`: `--expect-dirty -dash` works (only "--" prefixed values are ambiguous) .... ALLOW
//   P0H-P22 file named `--weird.txt`: separated form is malformed (exit 2); `--expect-dirty=--weird.txt` ... ALLOW
//   P0H-P23 names with leading / trailing spaces (` y`, `x `) ............................................ ALLOW exact
//   P0H-P24 pathspec-magic-looking names (`a:b`, `:(top)x`, `[ab]?*`) are literal, never passed to git as pathspecs ... ALLOW exact
//   P0H-P25 NFC vs NFD spelling of the same visible name: exact bytes are compared ..................... DENY (unexpected + missing)
//
//  SECOND MISMATCH RECORDED DURING P0H (not rewritten): the first P0H-P10/P11 "valid unusual names" check built the
//  synthetic record with XY `M.` (index side only) but asserted actualDirty. The parser was right and the test wrong:
//  EXPECTATION_ERROR (XY side confusion in a synthetic fixture). Class: "which side of XY lands in which set".
//  Extra cases derived BEFORE correcting it, expectations fixed before they ran:
//   P0H-P26 `M.` / `A.` / `T.` / `D.` => STAGED only .............................................. staged {p}, dirty {}
//   P0H-P27 `.M` / `.T` / `.D` / `.A` => DIRTY only ................................................ dirty {p}, staged {}
//   P0H-P28 `MM`, `AM`, `TD` => both sets ............................................................ staged {p}, dirty {p}
//   P0H-P29 `?` untracked => dirty only; `!` ignored => neither set ................................. as stated
//   P0H-P30 unusual legal names behave identically on each side (dirty via `.M`, staged via `M.`) ... exact sets

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { classifyEntries, parseArgs, runGuard } from './repo-scope-guard.mjs';

const GUARD_CLI = fileURLToPath(new URL('./repo-scope-guard.mjs', import.meta.url));
const created = [];
after(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

function gitEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) env[k] = v;
  return {
    ...env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.invalid',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.invalid',
  };
}

function git(dir, ...args) {
  return execFileSync('git', args, { cwd: dir, env: gitEnv(), encoding: 'utf8' });
}

function put(dir, rel, content = 'x\n') {
  const abs = path.join(dir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function mkRepo({ commit = true } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'guard-fixture-'));
  created.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  if (!commit) return dir;
  put(dir, 'a.txt', 'a\n');
  put(dir, 'dir/b.txt', 'b\n');
  put(dir, 'sp ace é.txt', 's\n');
  put(dir, 'run.sh', '#!/bin/sh\n');
  put(dir, 'opencode.json', '{}\n');
  put(dir, '.claude/settings.json', '{}\n');
  git(dir, 'add', '--', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

const head = (dir) => git(dir, 'rev-parse', 'HEAD').trim();
const guard = (dir, argv = []) => runGuard({ argv, cwd: dir });

function snapshotWorktree(dir) {
  const out = {};
  const walk = (rel) => {
    for (const name of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      if (name.name === '.git' && rel === '') continue;
      const r = path.join(rel, name.name);
      if (name.isDirectory()) walk(r);
      else if (name.isFile()) {
        out[r] = createHash('sha256').update(readFileSync(path.join(dir, r))).digest('hex');
      } else out[r] = `special:${name.name}`;
    }
  };
  walk('');
  return out;
}

const sorted = (a) => [...a].sort();

// ---------------------------------------------------------------- baseline

test('[P0A #60][P0A #24] clean tree with no expectations is ALLOW with empty exact sets', async () => {
  const dir = mkRepo();
  const { exitCode, result } = await guard(dir);
  assert.equal(result.tool, 'repo-scope-guard');
  assert.equal(result.verdict, 'ALLOW');
  assert.equal(exitCode, 0);
  assert.equal(result.branch, 'main');
  assert.equal(result.head, head(dir));
  for (const key of [
    'expectedDirty', 'actualDirty', 'unexpectedDirty', 'missingDirty',
    'expectedStaged', 'actualStaged', 'unexpectedStaged', 'missingStaged',
    'protected', 'nonRegular', 'errors',
  ]) {
    assert.deepEqual(result[key], [], key);
  }
});

test('[P0A #61] matching --expect-branch is ALLOW', async () => {
  const dir = mkRepo();
  const { exitCode, result } = await guard(dir, ['--expect-branch', 'main', '--expect-head', head(dir)]);
  assert.equal(result.verdict, 'ALLOW');
  assert.equal(exitCode, 0);
  assert.equal(result.branch, 'main');
  assert.equal(result.head, head(dir));
});

test('[P0A #5] branch different from --expect-branch is DENY', async () => {
  const dir = mkRepo();
  const { exitCode, result } = await guard(dir, ['--expect-branch', 'other']);
  assert.equal(result.verdict, 'DENY');
  assert.equal(exitCode, 1);
  assert.ok(result.errors.some((e) => e.code === 'BRANCH_MISMATCH'));
});

test('[P0A #6] HEAD different from --expect-head is DENY', async () => {
  const dir = mkRepo();
  const { exitCode, result } = await guard(dir, ['--expect-head', 'f'.repeat(40)]);
  assert.equal(result.verdict, 'DENY');
  assert.equal(exitCode, 1);
  assert.ok(result.errors.some((e) => e.code === 'HEAD_MISMATCH'));
});

test('[P0A #7] detached HEAD is DENY with --expect-branch and when nothing is pinned', async () => {
  const dir = mkRepo();
  git(dir, 'checkout', '-q', '--detach');
  const pinned = await guard(dir, ['--expect-branch', 'main']);
  assert.equal(pinned.result.verdict, 'DENY');
  assert.equal(pinned.exitCode, 1);
  assert.equal(pinned.result.branch, null);
  assert.ok(pinned.result.errors.some((e) => e.code === 'DETACHED_HEAD'));
  const unpinned = await guard(dir);
  assert.equal(unpinned.result.verdict, 'DENY');
  assert.ok(unpinned.result.errors.some((e) => e.code === 'DETACHED_HEAD'));
});

test('[P0B-XG26] detached HEAD with an exact --expect-head and no branch pin is ALLOW', async () => {
  const dir = mkRepo();
  const h = head(dir);
  git(dir, 'checkout', '-q', '--detach');
  const { result, exitCode } = await guard(dir, ['--expect-head', h]);
  assert.equal(result.verdict, 'ALLOW');
  assert.equal(exitCode, 0);
  assert.equal(result.head, h);
});

// ------------------------------------------------------- exact dirty/staged

test('[P0A #3] an unexpected untracked file is DENY and reported as unexpected', async () => {
  const dir = mkRepo();
  put(dir, 'stray.txt');
  const { exitCode, result } = await guard(dir);
  assert.equal(result.verdict, 'DENY');
  assert.equal(exitCode, 1);
  assert.deepEqual(result.actualDirty, ['stray.txt']);
  assert.deepEqual(result.unexpectedDirty, ['stray.txt']);
});

test('[P0A #21] an untracked generated file (non-ignored, nested) is DENY', async () => {
  const dir = mkRepo();
  put(dir, 'out/deep/report.json', '{}');
  const { result } = await guard(dir);
  assert.equal(result.verdict, 'DENY');
  assert.deepEqual(result.unexpectedDirty, ['out/deep/report.json']);
});

test('[P0A #4] an expected dirty path that is actually clean is DENY (missing)', async () => {
  const dir = mkRepo();
  const { exitCode, result } = await guard(dir, ['--expect-dirty', 'a.txt']);
  assert.equal(result.verdict, 'DENY');
  assert.equal(exitCode, 1);
  assert.deepEqual(result.missingDirty, ['a.txt']);
  assert.deepEqual(result.expectedDirty, ['a.txt']);
});

test('exact dirty set equality is ALLOW with modified + untracked paths listed', async () => {
  const dir = mkRepo();
  put(dir, 'a.txt', 'changed\n');
  put(dir, 'new.txt');
  const { exitCode, result } = await guard(dir, ['--expect-dirty', 'new.txt', '--expect-dirty', 'a.txt']);
  assert.equal(result.verdict, 'ALLOW');
  assert.equal(exitCode, 0);
  assert.deepEqual(result.actualDirty, ['a.txt', 'new.txt']);
  assert.deepEqual(result.expectedDirty, ['a.txt', 'new.txt']);
  assert.deepEqual(result.actualStaged, []);
});

test('[P0A #55] a staged file that is clean in the worktree is DENY unless listed in --expect-staged', async () => {
  const dir = mkRepo();
  put(dir, 'a.txt', 'staged change\n');
  git(dir, 'add', '--', 'a.txt');
  const denied = await guard(dir);
  assert.equal(denied.result.verdict, 'DENY');
  assert.deepEqual(denied.result.actualStaged, ['a.txt']);
  assert.deepEqual(denied.result.unexpectedStaged, ['a.txt']);
  assert.deepEqual(denied.result.actualDirty, []);
});

test('[P0A #56] the same staged file listed in --expect-staged is ALLOW', async () => {
  const dir = mkRepo();
  put(dir, 'a.txt', 'staged change\n');
  git(dir, 'add', '--', 'a.txt');
  const { exitCode, result } = await guard(dir, ['--expect-staged', 'a.txt']);
  assert.equal(result.verdict, 'ALLOW');
  assert.equal(exitCode, 0);
  assert.deepEqual(result.actualStaged, ['a.txt']);
  assert.deepEqual(result.actualDirty, []);
});

test('a staged expectation that is not staged is DENY (missingStaged)', async () => {
  const dir = mkRepo();
  const { result } = await guard(dir, ['--expect-staged', 'a.txt']);
  assert.equal(result.verdict, 'DENY');
  assert.deepEqual(result.missingStaged, ['a.txt']);
});

test('[P0B-XG01] a path both staged and modified is in BOTH sets', async () => {
  const dir = mkRepo();
  put(dir, 'a.txt', 'one\n');
  git(dir, 'add', '--', 'a.txt');
  put(dir, 'a.txt', 'two\n');
  const both = await guard(dir, ['--expect-dirty', 'a.txt', '--expect-staged', 'a.txt']);
  assert.equal(both.result.verdict, 'ALLOW');
  assert.deepEqual(both.result.actualDirty, ['a.txt']);
  assert.deepEqual(both.result.actualStaged, ['a.txt']);
  const onlyDirty = await guard(dir, ['--expect-dirty', 'a.txt']);
  assert.equal(onlyDirty.result.verdict, 'DENY');
  assert.deepEqual(onlyDirty.result.unexpectedStaged, ['a.txt']);
  assert.deepEqual(onlyDirty.result.unexpectedDirty, []);
});

test('[P0A #51] a staged rename with only the new path expected is DENY (old path is part of the set)', async () => {
  const dir = mkRepo();
  git(dir, 'mv', 'a.txt', 'a2.txt');
  const { result } = await guard(dir, ['--expect-staged', 'a2.txt']);
  assert.equal(result.verdict, 'DENY');
  assert.deepEqual(result.actualStaged, ['a.txt', 'a2.txt']);
  assert.deepEqual(result.unexpectedStaged, ['a.txt']);
});

test('[P0A #52] a staged rename with both paths expected is ALLOW', async () => {
  const dir = mkRepo();
  git(dir, 'mv', 'a.txt', 'a2.txt');
  const { exitCode, result } = await guard(dir, ['--expect-staged', 'a.txt', '--expect-staged', 'a2.txt']);
  assert.equal(result.verdict, 'ALLOW');
  assert.equal(exitCode, 0);
  assert.deepEqual(result.actualStaged, ['a.txt', 'a2.txt']);
  assert.deepEqual(result.actualDirty, []);
});

test('[P0A #53] a deleted tracked file listed as expected is ALLOW (absence allowed for a deletion)', async () => {
  const dir = mkRepo();
  unlinkSync(path.join(dir, 'a.txt'));
  const { exitCode, result } = await guard(dir, ['--expect-dirty', 'a.txt']);
  assert.equal(result.verdict, 'ALLOW');
  assert.equal(exitCode, 0);
  assert.deepEqual(result.actualDirty, ['a.txt']);
  assert.deepEqual(result.nonRegular, []);
});

test('[P0A #54] a deleted tracked file that is not listed is DENY', async () => {
  const dir = mkRepo();
  unlinkSync(path.join(dir, 'a.txt'));
  const { result } = await guard(dir);
  assert.equal(result.verdict, 'DENY');
  assert.deepEqual(result.unexpectedDirty, ['a.txt']);
});

test('[P0B-XG10] a mode change on a tracked file counts as dirty', async () => {
  const dir = mkRepo();
  chmodSync(path.join(dir, 'run.sh'), 0o755);
  const denied = await guard(dir);
  assert.equal(denied.result.verdict, 'DENY');
  assert.deepEqual(denied.result.actualDirty, ['run.sh']);
  const allowed = await guard(dir, ['--expect-dirty', 'run.sh']);
  assert.equal(allowed.result.verdict, 'ALLOW');
});

test('[P0B-XG11] staged removal plus untracked recreation puts the path in both sets', async () => {
  const dir = mkRepo();
  git(dir, 'rm', '-q', '--cached', '--', 'a.txt');
  const { result } = await guard(dir, ['--expect-dirty', 'a.txt', '--expect-staged', 'a.txt']);
  assert.equal(result.verdict, 'ALLOW');
  assert.deepEqual(result.actualDirty, ['a.txt']);
  assert.deepEqual(result.actualStaged, ['a.txt']);
});

test('[P0B-XG12] intent-to-add shows up as a dirty path', async () => {
  const dir = mkRepo();
  put(dir, 'ita.txt');
  git(dir, 'add', '-N', '--', 'ita.txt');
  const { result } = await guard(dir, ['--expect-dirty', 'ita.txt']);
  assert.equal(result.verdict, 'ALLOW');
  assert.deepEqual(result.actualDirty, ['ita.txt']);
  assert.deepEqual(result.actualStaged, []);
});

test('[P0B-XG09] an unmerged (conflict) path is always DENY and reported', async () => {
  const dir = mkRepo();
  git(dir, 'checkout', '-q', '-b', 'side');
  put(dir, 'a.txt', 'side\n');
  git(dir, 'commit', '-q', '-am', 'side');
  git(dir, 'checkout', '-q', 'main');
  put(dir, 'a.txt', 'main\n');
  git(dir, 'commit', '-q', '-am', 'main');
  assert.throws(() => git(dir, 'merge', 'side'));
  const { exitCode, result } = await guard(dir, ['--expect-dirty', 'a.txt', '--expect-staged', 'a.txt']);
  assert.equal(result.verdict, 'DENY');
  assert.equal(exitCode, 1);
  assert.deepEqual(result.unmerged, ['a.txt']);
  assert.ok(result.errors.some((e) => e.code === 'UNMERGED'));
});

// -------------------------------------------------- weird but valid filenames

test('[P0B-XG02] spaces and non-ASCII filenames are matched exactly', async () => {
  const dir = mkRepo();
  put(dir, 'sp ace é.txt', 'changed\n');
  put(dir, 'ñandú dir/ü file.txt');
  const { result } = await guard(dir, ['--expect-dirty', 'sp ace é.txt', '--expect-dirty', 'ñandú dir/ü file.txt']);
  assert.equal(result.verdict, 'ALLOW');
  assert.deepEqual(result.actualDirty, sorted(['sp ace é.txt', 'ñandú dir/ü file.txt']));
});

test('[P0B-XG03] a newline inside a filename is handled (NUL-delimited parsing)', async () => {
  const dir = mkRepo();
  put(dir, 'line\nbreak.txt');
  const { result } = await guard(dir, ['--expect-dirty', 'line\nbreak.txt']);
  assert.equal(result.verdict, 'ALLOW');
  assert.deepEqual(result.actualDirty, ['line\nbreak.txt']);
});

test('[P0B-XG04] glob and quote characters in filenames are literal, not patterns', async () => {
  const dir = mkRepo();
  put(dir, 'star*.txt');
  put(dir, 'q"uote\'s.txt');
  const exact = await guard(dir, ['--expect-dirty', 'star*.txt', '--expect-dirty', 'q"uote\'s.txt']);
  assert.equal(exact.result.verdict, 'ALLOW');
  const glob = await guard(dir, ['--expect-dirty', '*.txt']);
  assert.equal(glob.result.verdict, 'DENY');
  assert.deepEqual(glob.result.missingDirty, ['*.txt']);
});

test('[P0B-XG14] a directory prefix does not stand in for the files below it', async () => {
  const dir = mkRepo();
  put(dir, 'newdir/one.txt');
  const { result } = await guard(dir, ['--expect-dirty', 'newdir']);
  assert.equal(result.verdict, 'DENY');
  assert.deepEqual(result.actualDirty, ['newdir/one.txt']);
  assert.deepEqual(result.missingDirty, ['newdir']);
});

test('[P0B-XG15] path comparison is case-sensitive and exact', async () => {
  const dir = mkRepo();
  put(dir, 'New.txt');
  const { result } = await guard(dir, ['--expect-dirty', 'new.txt']);
  assert.equal(result.verdict, 'DENY');
  assert.deepEqual(result.unexpectedDirty, ['New.txt']);
  assert.deepEqual(result.missingDirty, ['new.txt']);
});

test('[P0B-XG06] a repeated identical --expect-dirty has set semantics', async () => {
  const dir = mkRepo();
  put(dir, 'new.txt');
  const { result } = await guard(dir, ['--expect-dirty', 'new.txt', '--expect-dirty', 'new.txt']);
  assert.equal(result.verdict, 'ALLOW');
  assert.deepEqual(result.expectedDirty, ['new.txt']);
});

// --------------------------------------------------------------- protected

for (const protectedPath of ['opencode.json', '.claude/settings.json']) {
  test(`[P0A #1] ${protectedPath} dirty is DENY even when named in --expect-dirty`, async () => {
    const dir = mkRepo();
    put(dir, protectedPath, '{"changed":true}\n');
    const unnamed = await guard(dir);
    assert.equal(unnamed.result.verdict, 'DENY');
    assert.equal(unnamed.exitCode, 1);
    assert.deepEqual(unnamed.result.protected, [protectedPath]);
    const named = await guard(dir, ['--expect-dirty', protectedPath]);
    assert.equal(named.result.verdict, 'DENY');
    assert.deepEqual(named.result.protected, [protectedPath]);
  });

  test(`[P0A #2] ${protectedPath} staged is DENY even when named in --expect-staged`, async () => {
    const dir = mkRepo();
    put(dir, protectedPath, '{"changed":true}\n');
    git(dir, 'add', '--', protectedPath);
    const named = await guard(dir, ['--expect-staged', protectedPath]);
    assert.equal(named.result.verdict, 'DENY');
    assert.deepEqual(named.result.protected, [protectedPath]);
  });

  test(`[P0A #50] naming ${protectedPath} in an expected set is DENY even when the tree is clean`, async () => {
    const dir = mkRepo();
    for (const flag of ['--expect-dirty', '--expect-staged']) {
      const { exitCode, result } = await guard(dir, [flag, protectedPath]);
      assert.equal(result.verdict, 'DENY', flag);
      assert.equal(exitCode, 1, flag);
      assert.ok(result.errors.some((e) => e.code === 'PROTECTED_IN_EXPECTED_SET'), flag);
    }
  });
}

test('[P0B-XG18] removing or renaming a protected file away is DENY (the old path is reported)', async () => {
  const removed = mkRepo();
  git(removed, 'rm', '-q', '--', '.claude/settings.json');
  const r1 = await guard(removed, ['--expect-staged', '.claude/settings.json']);
  assert.equal(r1.result.verdict, 'DENY');
  assert.deepEqual(r1.result.protected, ['.claude/settings.json']);

  const renamed = mkRepo();
  git(renamed, 'mv', 'opencode.json', 'oc2.json');
  const r2 = await guard(renamed, ['--expect-staged', 'oc2.json']);
  assert.equal(r2.result.verdict, 'DENY');
  assert.deepEqual(r2.result.protected, ['opencode.json']);
});

test('[P0B-XG19] a protected path replaced by a symlink is DENY and is never lstat-checked', async () => {
  const dir = mkRepo();
  unlinkSync(path.join(dir, 'opencode.json'));
  symlinkSync('a.txt', path.join(dir, 'opencode.json'));
  const { result } = await guard(dir);
  assert.equal(result.verdict, 'DENY');
  assert.deepEqual(result.protected, ['opencode.json']);
  assert.deepEqual(result.nonRegular, [], 'protected paths must not be inspected on disk');
});

// ----------------------------------------------------------- file types

test('[P0A #8] an untracked symlink is DENY (nonRegular) even when listed', async () => {
  const dir = mkRepo();
  symlinkSync('a.txt', path.join(dir, 'link'));
  const { exitCode, result } = await guard(dir, ['--expect-dirty', 'link']);
  assert.equal(result.verdict, 'DENY');
  assert.equal(exitCode, 1);
  assert.deepEqual(result.nonRegular, ['link']);
  assert.deepEqual(result.unexpectedDirty, []);
});

test('[P0A #8] a tracked file replaced by a symlink (typechange) is DENY', async () => {
  const dir = mkRepo();
  unlinkSync(path.join(dir, 'a.txt'));
  symlinkSync('dir/b.txt', path.join(dir, 'a.txt'));
  const { result } = await guard(dir, ['--expect-dirty', 'a.txt']);
  assert.equal(result.verdict, 'DENY');
  assert.deepEqual(result.nonRegular, ['a.txt']);
});

test('[P0A #59] a tracked file replaced by a FIFO is DENY (nonRegular) even when listed', async () => {
  const dir = mkRepo();
  unlinkSync(path.join(dir, 'run.sh'));
  execFileSync('mkfifo', [path.join(dir, 'run.sh')]);
  const { result } = await guard(dir, ['--expect-dirty', 'run.sh']);
  assert.equal(result.verdict, 'DENY');
  assert.deepEqual(result.nonRegular, ['run.sh']);
});

test('[P0B-XG22] a tracked file replaced by a directory is DENY (nonRegular)', async () => {
  const dir = mkRepo();
  unlinkSync(path.join(dir, 'a.txt'));
  put(dir, 'a.txt/inner.txt');
  const { result } = await guard(dir, ['--expect-dirty', 'a.txt', '--expect-dirty', 'a.txt/inner.txt']);
  assert.equal(result.verdict, 'DENY');
  assert.deepEqual(result.nonRegular, ['a.txt']);
});

// ------------------------------------------------------- malformed input

test('[P0A #58][P0B-XG05] malformed arguments and non-normalized paths are DENY with exit 2', async () => {
  const dir = mkRepo();
  const cases = [
    ['--expect-dirty'],
    ['--expect-dirty', '--expect-staged', 'a.txt'],
    ['--expect-dirty', ''],
    ['--expect-dirty', './a.txt'],
    ['--expect-dirty', 'dir//b.txt'],
    ['--expect-dirty', 'dir/../a.txt'],
    ['--expect-dirty', '../a.txt'],
    ['--expect-dirty', '/etc/passwd'],
    ['--expect-dirty', 'dir/'],
    ['--expect-dirty', 'a\0b'],
    ['--expect-dirty', 'back\\slash'],
    ['--expect-staged', '.'],
    ['--expect-branch'],
    ['--expect-head'],
    ['--bogus'],
    ['--bogus=1'],
    ['a.txt'],
    ['--expect-dirty=./a.txt'],
  ];
  for (const argv of cases) {
    const { exitCode, result } = await guard(dir, argv);
    assert.equal(exitCode, 2, JSON.stringify(argv));
    assert.equal(result.verdict, 'DENY', JSON.stringify(argv));
    assert.ok(result.errors.length > 0 && result.errors.every((e) => e.code.startsWith('MALFORMED')), JSON.stringify(argv));
  }
});

test('[P0B-XG07] repeated --expect-branch / --expect-head are malformed', async () => {
  const dir = mkRepo();
  const h = head(dir);
  for (const argv of [
    ['--expect-branch', 'main', '--expect-branch', 'main'],
    ['--expect-head', h, '--expect-head', h],
  ]) {
    const { exitCode, result } = await guard(dir, argv);
    assert.equal(exitCode, 2, JSON.stringify(argv));
    assert.equal(result.verdict, 'DENY');
  }
});

test('[P0B-XG08] an abbreviated --expect-head is malformed (full SHA required)', async () => {
  const dir = mkRepo();
  for (const sha of [head(dir).slice(0, 7), head(dir).slice(0, 39), 'HEAD', 'main', head(dir).toUpperCase().replace(/[A-F]/g, 'G')]) {
    const { exitCode, result } = await guard(dir, ['--expect-head', sha]);
    assert.equal(exitCode, 2, sha);
    assert.equal(result.verdict, 'DENY', sha);
  }
});

test('[P0B-XG25] --opt=value and "--opt value" are equivalent', async () => {
  const dir = mkRepo();
  put(dir, 'new.txt');
  const a = await guard(dir, ['--expect-dirty=new.txt', `--expect-head=${head(dir)}`, '--expect-branch=main']);
  const b = await guard(dir, ['--expect-dirty', 'new.txt', '--expect-head', head(dir), '--expect-branch', 'main']);
  assert.equal(a.result.verdict, 'ALLOW');
  assert.deepEqual(a.result.actualDirty, ['new.txt']);
  assert.deepEqual(a, b);
});

test('parseArgs reports empty expected sets by default and never throws on junk', () => {
  const ok = parseArgs([]);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.options.expectDirty, []);
  assert.deepEqual(ok.options.expectStaged, []);
  for (const junk of [[undefined], [null], [42], ['--expect-dirty', {}]]) {
    assert.doesNotThrow(() => parseArgs(junk));
    assert.equal(parseArgs(junk).ok, false);
  }
});

// ------------------------------------------------------- operational/BLOCKED

test('[P0B-XG16] a directory that is not a git repository is BLOCKED (exit 3)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'guard-norepo-'));
  created.push(dir);
  const { exitCode, result } = await guard(dir);
  assert.equal(result.verdict, 'BLOCKED');
  assert.equal(exitCode, 3);
  assert.ok(result.errors.some((e) => e.code === 'GIT_UNAVAILABLE'));
});

test('[P0B-XG17] a repository with no commits has head null; ALLOW when clean, DENY for an --expect-head pin', async () => {
  const dir = mkRepo({ commit: false });
  const clean = await guard(dir);
  assert.equal(clean.result.verdict, 'ALLOW');
  assert.equal(clean.result.head, null);
  assert.equal(clean.result.branch, 'main');
  const pinned = await guard(dir, ['--expect-head', 'a'.repeat(40)]);
  assert.equal(pinned.result.verdict, 'DENY');
  assert.ok(pinned.result.errors.some((e) => e.code === 'HEAD_MISMATCH'));
});

// --------------------------------------------------- environment / read-only

test('[P0B-XG13] caller GIT_* variables cannot redirect the repository the guard inspects', () => {
  const dir = mkRepo();
  const decoy = mkdtempSync(path.join(tmpdir(), 'guard-decoy-'));
  created.push(decoy);
  git(decoy, 'init', '-q', '-b', 'decoy');
  put(dir, 'only-in-fixture.txt');
  const res = spawnSync(process.execPath, [GUARD_CLI, '--expect-dirty', 'only-in-fixture.txt'], {
    cwd: dir,
    env: { ...process.env, GIT_DIR: path.join(decoy, '.git'), GIT_WORK_TREE: decoy, GIT_INDEX_FILE: path.join(decoy, 'nope') },
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, res.stderr);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.verdict, 'ALLOW');
  assert.equal(parsed.branch, 'main');
  assert.deepEqual(parsed.actualDirty, ['only-in-fixture.txt']);
});

test('[P0B-XG20] a stale-stat index is not rewritten (git runs with --no-optional-locks)', async () => {
  const dir = mkRepo();
  put(dir, 'a.txt', 'staged\n');
  git(dir, 'add', '--', 'a.txt');
  // Same bytes, new mtime: a plain `git status` would refresh and rewrite the index.
  const future = new Date(Date.now() + 5000);
  utimesSync(path.join(dir, 'a.txt'), future, future);
  const indexPath = path.join(dir, '.git', 'index');
  const before = createHash('sha256').update(readFileSync(indexPath)).digest('hex');
  const { result } = await guard(dir, ['--expect-staged', 'a.txt']);
  assert.equal(result.verdict, 'ALLOW');
  assert.deepEqual(result.actualStaged, ['a.txt'], 'the guard must actually have inspected the repository');
  const after = createHash('sha256').update(readFileSync(indexPath)).digest('hex');
  assert.equal(after, before, 'the guard must not write the index');
  // Premise check: a plain git status DOES rewrite this index, so the assertion above discriminates.
  git(dir, 'status', '--porcelain');
  const rewritten = createHash('sha256').update(readFileSync(indexPath)).digest('hex');
  assert.notEqual(rewritten, before, 'fixture premise: plain git status refreshes the index');
});

test('[P0B-XG21] a run leaves the worktree bytes and the file set untouched', async () => {
  const dir = mkRepo();
  put(dir, 'a.txt', 'changed\n');
  put(dir, 'stray.txt');
  symlinkSync('a.txt', path.join(dir, 'link'));
  renameSync(path.join(dir, 'dir'), path.join(dir, 'dir2'));
  const before = snapshotWorktree(dir);
  const first = await guard(dir, ['--expect-dirty', 'a.txt']);
  assert.deepEqual(first.result.actualDirty, ['a.txt', 'dir/b.txt', 'dir2/b.txt', 'link', 'stray.txt']);
  await guard(dir);
  assert.deepEqual(snapshotWorktree(dir), before);
  assert.ok(statSync(path.join(dir, 'stray.txt')).isFile());
});

test('[P0B-XG23] output is deterministic and every array is sorted', async () => {
  const dir = mkRepo();
  for (const n of ['z.txt', 'm.txt', 'a2.txt', 'B.txt']) put(dir, n);
  const first = await guard(dir, ['--expect-dirty', 'z.txt']);
  const second = await guard(dir, ['--expect-dirty', 'z.txt']);
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first.result), JSON.stringify(second.result));
  assert.deepEqual(first.result.actualDirty, ['B.txt', 'a2.txt', 'm.txt', 'z.txt']);
  assert.deepEqual(first.result.unexpectedDirty, ['B.txt', 'a2.txt', 'm.txt']);
  const keys = Object.keys(first.result);
  for (const k of ['tool', 'verdict', 'branch', 'head', 'expectedDirty', 'actualDirty', 'unexpectedDirty', 'missingDirty', 'expectedStaged', 'actualStaged', 'unexpectedStaged', 'missingStaged', 'protected', 'nonRegular', 'errors']) {
    assert.ok(keys.includes(k), k);
  }
});

test('[P0B-XG24] the CLI prints one JSON line and maps verdicts to exit codes', () => {
  const dir = mkRepo();
  const run = (args) => spawnSync(process.execPath, [GUARD_CLI, ...args], { cwd: dir, encoding: 'utf8' });
  const ok = run([]);
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout.trim().split('\n').length, 1);
  assert.equal(JSON.parse(ok.stdout).verdict, 'ALLOW');
  put(dir, 'stray.txt');
  assert.equal(run([]).status, 1);
  assert.equal(run(['positional']).status, 2);
  const none = spawnSync(process.execPath, [GUARD_CLI], { cwd: tmpdir(), encoding: 'utf8' });
  assert.equal(none.status, 3);
});

// ======================================================= TOOLING-P0D rename attribution

async function renameFixture(setup) {
  const dir = mkRepo();
  setup(dir);
  return dir;
}

test('[P0D-G44] RM: a modified rename destination is DIRTY, the original is only STAGED', async () => {
  const dir = await renameFixture((d) => {
    git(d, 'mv', 'a.txt', 'b2.txt');
    put(d, 'b2.txt', 'modified after rename\n');
  });
  const ok = await guard(dir, ['--expect-staged', 'a.txt', '--expect-staged', 'b2.txt', '--expect-dirty', 'b2.txt']);
  assert.deepEqual(ok.result.actualStaged, ['a.txt', 'b2.txt']);
  assert.deepEqual(ok.result.actualDirty, ['b2.txt']);
  assert.equal(ok.result.verdict, 'ALLOW');
  const wrong = await guard(dir, ['--expect-staged', 'a.txt', '--expect-staged', 'b2.txt', '--expect-dirty', 'a.txt', '--expect-dirty', 'b2.txt']);
  assert.equal(wrong.result.verdict, 'DENY');
  assert.deepEqual(wrong.result.missingDirty, ['a.txt']);
});

test('[P0D-G45] RD: a rename destination deleted in the worktree is DIRTY (and absent is allowed), original only STAGED', async () => {
  const dir = await renameFixture((d) => {
    git(d, 'mv', 'a.txt', 'b2.txt');
    unlinkSync(path.join(d, 'b2.txt'));
  });
  const { result } = await guard(dir, ['--expect-staged', 'a.txt', '--expect-staged', 'b2.txt', '--expect-dirty', 'b2.txt']);
  assert.deepEqual(result.actualStaged, ['a.txt', 'b2.txt']);
  assert.deepEqual(result.actualDirty, ['b2.txt']);
  assert.deepEqual(result.nonRegular, []);
  assert.equal(result.verdict, 'ALLOW');
});

test('[P0D-G46][P0D-G48] a pure staged rename and a rename chain leave the worktree-side set empty', async () => {
  const pure = await renameFixture((d) => git(d, 'mv', 'a.txt', 'b2.txt'));
  const p = await guard(pure, ['--expect-staged', 'a.txt', '--expect-staged', 'b2.txt']);
  assert.deepEqual(p.result.actualDirty, []);
  assert.equal(p.result.verdict, 'ALLOW');
  const chain = await renameFixture((d) => {
    git(d, 'mv', 'a.txt', 'b2.txt');
    git(d, 'mv', 'b2.txt', 'c2.txt');
  });
  const c = await guard(chain, ['--expect-staged', 'a.txt', '--expect-staged', 'c2.txt']);
  assert.deepEqual(c.result.actualStaged, ['a.txt', 'c2.txt']);
  assert.deepEqual(c.result.actualDirty, []);
  assert.equal(c.result.verdict, 'ALLOW');
});

test('[P0D-G47] rename then recreating the original path untracked: original is dirty (untracked) AND staged', async () => {
  const dir = await renameFixture((d) => {
    git(d, 'mv', 'a.txt', 'b2.txt');
    put(d, 'a.txt', 'recreated\n');
  });
  const { result } = await guard(dir, ['--expect-staged', 'a.txt', '--expect-staged', 'b2.txt', '--expect-dirty', 'a.txt']);
  assert.deepEqual(result.actualStaged, ['a.txt', 'b2.txt']);
  assert.deepEqual(result.actualDirty, ['a.txt']);
  assert.equal(result.verdict, 'ALLOW');
});

test('[P0D-G49] a mode change on a rename destination is dirty for the destination only', async () => {
  const dir = await renameFixture((d) => {
    git(d, 'mv', 'run.sh', 'run2.sh');
    chmodSync(path.join(d, 'run2.sh'), 0o755);
  });
  const { result } = await guard(dir, ['--expect-staged', 'run.sh', '--expect-staged', 'run2.sh', '--expect-dirty', 'run2.sh']);
  assert.deepEqual(result.actualDirty, ['run2.sh']);
  assert.equal(result.verdict, 'ALLOW');
});

test('[P0D-G50][P0D-G51] protected rename-away and rename-onto stay DENY', async () => {
  const away = await renameFixture((d) => {
    git(d, 'mv', 'opencode.json', 'oc2.json');
    put(d, 'oc2.json', '{"x":1}\n');
  });
  const a = await guard(away, ['--expect-staged', 'oc2.json', '--expect-dirty', 'oc2.json']);
  assert.equal(a.result.verdict, 'DENY');
  assert.deepEqual(a.result.protected, ['opencode.json']);

  const onto = mkRepo();
  git(onto, 'rm', '-q', '--', 'opencode.json');
  git(onto, 'commit', '-q', '-m', 'drop protected');
  git(onto, 'mv', 'a.txt', 'opencode.json');
  const b = await guard(onto, ['--expect-staged', 'a.txt']);
  assert.equal(b.result.verdict, 'DENY');
  assert.deepEqual(b.result.protected, ['opencode.json']);
  put(onto, 'opencode.json', '{"changed":true}\n');
  const c = await guard(onto, []);
  assert.equal(c.result.verdict, 'DENY');
  assert.deepEqual(c.result.protected, ['opencode.json']);
});

test('[P0D-G52] oracle: rename/copy attribution follows the X (index) and Y (worktree) letters, never the score letter', () => {
  const X = ['.', 'M', 'A', 'D', 'R', 'C', 'T'];
  const Y = ['.', 'M', 'D', 'T', 'R', 'C', 'A'];
  let checked = 0;
  for (const score of ['R100', 'C75', 'R50']) {
    for (const x of X) {
      for (const y of Y) {
        if (x === '.' && y === '.') continue;
        const { dirty, staged } = classifyEntries([{ kind: '2', x, y, sub: 'N...', score, path: 'new.txt', origPath: 'old.txt' }]);
        const label = `${x}${y}/${score}`;
        assert.equal(staged.has('new.txt'), x !== '.', `${label} staged new`);
        assert.equal(staged.has('old.txt'), x === 'R', `${label} staged old`);
        assert.equal(dirty.has('new.txt'), y !== '.', `${label} dirty new`);
        assert.equal(dirty.has('old.txt'), y === 'R', `${label} dirty old`);
        checked += 1;
      }
    }
  }
  assert.equal(checked, 3 * (X.length * Y.length - 1));
});

test('[P0D-G53][P0D-G55] a copy never touches its unchanged source; a worktree-side rename puts both paths in DIRTY only', () => {
  const copy = classifyEntries([{ kind: '2', x: 'C', y: '.', sub: 'N...', score: 'C90', path: 'dup.txt', origPath: 'src.txt' }]);
  assert.deepEqual([...copy.staged.keys()], ['dup.txt']);
  assert.deepEqual([...copy.dirty.keys()], []);
  const wt = classifyEntries([{ kind: '2', x: '.', y: 'R', sub: 'N...', score: 'R100', path: 'new.txt', origPath: 'old.txt' }]);
  assert.deepEqual([...wt.dirty.keys()].sort(), ['new.txt', 'old.txt']);
  assert.deepEqual([...wt.staged.keys()], []);
});

test('[P0D-G54] a truncated rename record (original path missing) is BLOCKED STATUS_PARSE, not an exact-set guess', async () => {
  const h = 'a'.repeat(40);
  const status = `# branch.oid ${h}\0# branch.head main\0` + `2 R. N... 100644 100644 100644 ${h} ${h} R100 new.txt`;
  const execGit = async (args) => (args[0] === 'rev-parse' ? { ok: true, stdout: '/tmp\n' } : { ok: true, stdout: status });
  const { exitCode, result } = await runGuard({ argv: [], cwd: '/', execGit });
  assert.equal(result.verdict, 'BLOCKED');
  assert.equal(exitCode, 3);
  assert.ok(result.errors.some((e) => e.code === 'STATUS_PARSE'));
});


// ======================================================= TOOLING-P0H porcelain-v2 record grammar

const H40 = 'a'.repeat(40);
const OID = `# branch.oid ${H40}`;
const HEAD = '# branch.head main';
const ord = (xy, p, o = {}) => `1 ${xy} ${o.sub ?? 'N...'} ${o.mH ?? '100644'} ${o.mI ?? '100644'} ${o.mW ?? '100644'} ${o.hH ?? H40} ${o.hI ?? H40} ${p}`;
const ren = (xy, score, p, orig, o = {}) => [`2 ${xy} ${o.sub ?? 'N...'} 100644 100644 100644 ${H40} ${H40} ${score} ${p}`, orig];
const unm = (xy, p) => `u ${xy} N... 100644 100644 100644 100644 ${H40} ${H40} ${H40} ${p}`;

async function synth(records, { headers = [OID, HEAD] } = {}) {
  const status = [...headers, ...records.flat()].join('\0') + '\0';
  const execGit = async (args) => (args[0] === 'rev-parse' ? { ok: true, stdout: '/tmp\n' } : { ok: true, stdout: status });
  return runGuard({ argv: [], cwd: '/', execGit, lstat: async () => ({ isFile: () => true }) });
}
const isParseBlock = (out) => {
  assert.equal(out.result.verdict, 'BLOCKED', JSON.stringify(out.result.errors));
  assert.equal(out.exitCode, 3);
  assert.ok(out.result.errors.some((e) => e.code === 'STATUS_PARSE'));
};

test('[P0H-CX-C1][P0H-CX-C2][P0H-CX-C3][P0H-CX-C4] the four Codex malformed-output classes are BLOCKED STATUS_PARSE', async () => {
  isParseBlock(await synth([ord('ZZ', 'a.txt')]));
  isParseBlock(await synth([ren('R.', 'R100', 'new.txt', '')]));
  isParseBlock(await synth([ord('M.', '../escape.txt')]));
  isParseBlock(await synth([], { headers: [OID, HEAD, '# branch.head other'] }));
});

test('[P0H-P01][P0H-P02][P0H-P03] X/Y letters are validated against the record kind', async () => {
  for (const rec of [
    [ord('RM', 'a.txt')],
    [ord('.C', 'a.txt')],
    [ord('..', 'a.txt')],
    [ord('mM', 'a.txt')],
    [ord('UM', 'a.txt')],
    [ord('M', 'a.txt')],
    [ord('MMM', 'a.txt')],
    [ren('MM', 'R100', 'n.txt', 'o.txt')],
    [ren('..', 'R100', 'n.txt', 'o.txt')],
  ]) {
    isParseBlock(await synth(rec));
  }
});

test('[P0H-P04] unmerged records accept only the seven documented XY combinations', async () => {
  for (const xy of ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']) {
    const out = await synth([unm(xy, 'c.txt')]);
    assert.notEqual(out.result.verdict, 'BLOCKED', xy);
    assert.deepEqual(out.result.unmerged, ['c.txt'], xy);
  }
  for (const xy of ['MM', '.U', 'U.', 'UM', 'AD', '..']) isParseBlock(await synth([unm(xy, 'c.txt')]));
});

test('[P0H-P05][P0H-P06][P0H-P07][P0H-P08][P0H-P09] mode, object-id, submodule and score fields are validated', async () => {
  for (const o of [{ mH: '10064' }, { mI: '100x44' }, { mW: '1006444' }, { mH: '' }]) isParseBlock(await synth([ord('M.', 'a.txt', o)]));
  for (const o of [{ hH: 'a'.repeat(39) }, { hI: 'A'.repeat(40) }, { hH: 'zz' }, { hI: 'a'.repeat(41) }]) isParseBlock(await synth([ord('M.', 'a.txt', o)]));
  for (const sub of ['X...', 'S....', 'n...', 'S.', 'N..', 'SCMU1']) isParseBlock(await synth([ord('M.', 'a.txt', { sub })]));
  for (const score of ['R', 'X100', 'R101', 'R-1', '100R', 'R1000', 'r100']) isParseBlock(await synth([ren('R.', score, 'n.txt', 'o.txt')]));
  isParseBlock(await synth([ren('R.', 'C100', 'n.txt', 'o.txt')]));
  isParseBlock(await synth([ren('C.', 'R100', 'n.txt', 'o.txt')]));
});

test('[P0H-P10][P0H-P11] every pathname must be a repository-relative Git path; valid unusual names stay valid', async () => {
  for (const bad of ['a//b', '/abs/x', './x', 'a/./b', 'a/../b', '..', '.', '.git/config', 'dir/', '']) {
    isParseBlock(await synth([ord('M.', bad)]));
  }
  for (const orig of ['../x', '/abs', 'o/', 'a//b', './o', '']) isParseBlock(await synth([ren('R.', 'R100', 'n.txt', orig)]));
  for (const good of ['sp ace.txt', 'tab\there.txt', 'new\nline.txt', 'back\\slash.txt', 'ünï/çødé.txt', '-dash', 'a.b/c.d', '.hidden/.cfg', 'dot.git/x', '.gitignore']) {
    const out = await synth([ord('.M', good)]);
    assert.notEqual(out.result.verdict, 'BLOCKED', JSON.stringify(good));
    assert.deepEqual(out.result.actualDirty, [good], JSON.stringify(good));
    const staged = await synth([ord('M.', good)]);
    assert.deepEqual(staged.result.actualStaged, [good], JSON.stringify(good));
    assert.deepEqual(staged.result.actualDirty, [], JSON.stringify(good));
  }
});

test('[P0H-P12][P0H-P13][P0H-P14][P0H-CX-C4] identity headers must be present exactly once with valid values', async () => {
  isParseBlock(await synth([], { headers: [HEAD] }));
  isParseBlock(await synth([], { headers: [OID] }));
  isParseBlock(await synth([], { headers: [] }));
  isParseBlock(await synth([], { headers: [OID, OID, HEAD] }));
  isParseBlock(await synth([], { headers: [OID, HEAD, HEAD] }));
  isParseBlock(await synth([], { headers: [OID, HEAD, '# branch.head other'] }));
  isParseBlock(await synth([], { headers: [OID, `# branch.oid ${'b'.repeat(40)}`, HEAD] }));
  for (const oid of ['zzz', 'a'.repeat(12), 'A'.repeat(40), '', '(initial) x']) isParseBlock(await synth([], { headers: [`# branch.oid ${oid}`, HEAD] }));
  isParseBlock(await synth([], { headers: [OID, '# branch.head'] }));
  isParseBlock(await synth([], { headers: [OID, '# branch.head '] }));
  const initial = await synth([], { headers: ['# branch.oid (initial)', HEAD] });
  assert.equal(initial.result.verdict, 'ALLOW');
  const detached = await synth([], { headers: [OID, '# branch.head (detached)'] });
  assert.equal(detached.result.branch, null);
});

test('[P0H-P15][P0H-P16] a header after records, an empty middle record, a missing type space and an unknown type are BLOCKED', async () => {
  isParseBlock(await synth([ord('M.', 'a.txt'), '# branch.upstream origin/main']));
  const mid = [OID, HEAD, ord('M.', 'a.txt'), '', ord('M.', 'b.txt')].join('\0') + '\0';
  const execGit = async (args) => (args[0] === 'rev-parse' ? { ok: true, stdout: '/tmp\n' } : { ok: true, stdout: mid });
  isParseBlock(await runGuard({ argv: [], cwd: '/', execGit, lstat: async () => ({ isFile: () => true }) }));
  isParseBlock(await synth(['1X M. N... 100644 100644 100644 ' + H40 + ' ' + H40 + ' a.txt']));
  isParseBlock(await synth(['U M. a.txt']));
  isParseBlock(await synth(['x something']));
  isParseBlock(await synth(['?']));
  isParseBlock(await synth(['? ']));
});

test('[P0H-P17] CONTROL: harmless or unknown headers are accepted (porcelain v2 is extensible)', async () => {
  const out = await synth([], { headers: [OID, HEAD, '# branch.upstream origin/main', '# branch.ab +0 -0', '# stash 3', '# future.key some value'] });
  assert.equal(out.result.verdict, 'ALLOW');
  assert.equal(out.exitCode, 0);
});

test('[P0H-P18][P0H-P19] CONTROL real git: nested repo, typechange, intent-to-add, gitlink, copy, RM/RD/R., unmerged and unusual names are all valid grammar with exact sets', async () => {
  const nested = mkRepo();
  mkdirSync(path.join(nested, 'sub'));
  execFileSync('git', ['init', '-q'], { cwd: path.join(nested, 'sub'), env: gitEnv() });
  put(path.join(nested, 'sub'), 'f.txt', 'y\n');
  git(path.join(nested, 'sub'), 'add', '--', 'f.txt');
  git(path.join(nested, 'sub'), 'commit', '-q', '-m', 'n');
  const n = await guard(nested);
  assert.notEqual(n.result.verdict, 'BLOCKED');
  assert.equal(n.result.verdict, 'DENY');
  assert.ok(n.result.actualDirty.includes('sub/'));

  const tc = mkRepo();
  unlinkSync(path.join(tc, 'a.txt'));
  symlinkSync('dir/b.txt', path.join(tc, 'a.txt'));
  put(tc, 'ita.txt');
  git(tc, 'add', '-N', '--', 'ita.txt');
  const t = await guard(tc, ['--expect-dirty', 'a.txt', '--expect-dirty', 'ita.txt']);
  assert.notEqual(t.result.verdict, 'BLOCKED');
  assert.deepEqual(t.result.actualDirty, ['a.txt', 'ita.txt']);
  assert.deepEqual(t.result.nonRegular, ['a.txt']);

  const gl = mkRepo();
  git(gl, 'update-index', '--add', '--cacheinfo', `160000,${head(gl)},subm`);
  const g = await guard(gl, ['--expect-staged', 'subm', '--expect-dirty', 'subm']);
  assert.notEqual(g.result.verdict, 'BLOCKED');
  assert.deepEqual(g.result.actualStaged, ['subm']);

  const cp = mkRepo();
  git(cp, 'config', 'status.renames', 'copies');
  put(cp, 'a.txt', 'a\nchanged\n');
  put(cp, 'a-copy.txt', 'a\n');
  git(cp, 'add', '--', 'a.txt', 'a-copy.txt');
  const c = await guard(cp, ['--expect-staged', 'a.txt', '--expect-staged', 'a-copy.txt']);
  assert.notEqual(c.result.verdict, 'BLOCKED');
  assert.equal(c.result.verdict, 'ALLOW');

  const odd = mkRepo();
  for (const name of ['tab\there.txt', 'new\nline.txt', 'ünï çødé.txt']) put(odd, name);
  const o = await guard(odd, ['--expect-dirty', 'tab\there.txt', '--expect-dirty', 'new\nline.txt', '--expect-dirty', 'ünï çødé.txt']);
  assert.equal(o.result.verdict, 'ALLOW');
});

test('[P0H-P20] a backslash in a file name is valid Git grammar; the argument contract just cannot list it', async () => {
  const dir = mkRepo();
  put(dir, 'back\\slash.txt');
  const listed = await guard(dir, ['--expect-dirty', 'back\\slash.txt']);
  assert.equal(listed.exitCode, 2);
  const bare = await guard(dir);
  assert.notEqual(bare.result.verdict, 'BLOCKED');
  assert.equal(bare.result.verdict, 'DENY');
  assert.deepEqual(bare.result.unexpectedDirty, ['back\\slash.txt']);
});

test('[P0H-P21][P0H-P22][P0H-P23][P0H-P24] unusual but legal names are matched exactly and literally', async () => {
  const dir = mkRepo();
  const names = ['-dash', ' y', 'x ', 'a:b', ':(top)x', '[ab]?*', '--weird.txt'];
  for (const n of names) put(dir, n);
  const argv = [];
  for (const n of names) argv.push(`--expect-dirty=${n}`);
  const ok = await guard(dir, argv);
  assert.equal(ok.result.verdict, 'ALLOW', JSON.stringify(ok.result));
  assert.deepEqual(ok.result.actualDirty, [...names].sort());
  const separatedDash = await guard(dir, ['--expect-dirty', '-dash']);
  assert.notEqual(separatedDash.exitCode, 2, 'a single leading dash is not ambiguous');
  const separatedWeird = await guard(dir, ['--expect-dirty', '--weird.txt']);
  assert.equal(separatedWeird.exitCode, 2, 'a "--" prefixed value in separated form is ambiguous and malformed');
});

test('[P0H-P25] NFC and NFD spellings are different paths (exact bytes)', async () => {
  const dir = mkRepo();
  const nfd = 'caf\u0065\u0301.txt';
  const nfc = 'caf\u00e9.txt';
  put(dir, nfd);
  const out = await guard(dir, [`--expect-dirty=${nfc}`]);
  assert.equal(out.result.verdict, 'DENY');
  assert.deepEqual(out.result.unexpectedDirty, [nfd]);
  assert.deepEqual(out.result.missingDirty, [nfc]);
  const exact = await guard(dir, [`--expect-dirty=${nfd}`]);
  assert.equal(exact.result.verdict, 'ALLOW');
});

test('[P0H-P26][P0H-P27][P0H-P28][P0H-P29] valid ordinary records land in exactly the sets their X (index) and Y (worktree) letters name', async () => {
  const sets = async (rec) => {
    const out = await synth([rec]);
    assert.notEqual(out.result.verdict, 'BLOCKED', JSON.stringify(rec));
    return { staged: out.result.actualStaged, dirty: out.result.actualDirty };
  };
  for (const xy of ['M.', 'A.', 'T.', 'D.']) assert.deepEqual(await sets(ord(xy, 'p.txt')), { staged: ['p.txt'], dirty: [] }, xy);
  for (const xy of ['.M', '.T', '.D', '.A']) assert.deepEqual(await sets(ord(xy, 'p.txt')), { staged: [], dirty: ['p.txt'] }, xy);
  for (const xy of ['MM', 'AM', 'TD', 'AD', 'MT']) assert.deepEqual(await sets(ord(xy, 'p.txt')), { staged: ['p.txt'], dirty: ['p.txt'] }, xy);
  assert.deepEqual(await sets('? p.txt'), { staged: [], dirty: ['p.txt'] });
  assert.deepEqual(await sets('! p.txt'), { staged: [], dirty: [] });
});
