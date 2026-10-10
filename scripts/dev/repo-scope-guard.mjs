#!/usr/bin/env node
// repo-scope-guard (TOOL-2): READ-ONLY check that the git working tree is
// EXACTLY the state the caller expects, before editing or staging.
//
//   node scripts/dev/repo-scope-guard.mjs [--expect-branch <name>]
//        [--expect-head <full sha>] [--expect-dirty <path>]... [--expect-staged <path>]...
//
// Semantics (exact set equality, no allowlist):
//   dirty  = worktree-side changes + untracked, non-ignored paths
//   staged = index-side changes
//   Omitted --expect-dirty / --expect-staged mean the EMPTY set, so an extra
//   path and a missing expected path are both violations.
//   A rename contributes its old and new path; a copy only its new path.
//   Unmerged entries are always a violation. A detached HEAD is a violation
//   unless it is pinned with --expect-head and no --expect-branch is given.
//   opencode.json and .claude/settings.json are PROTECTED: dirty, staged or
//   named in an expected set is always DENY. They are identified from git's
//   pathnames only; the guard never opens, hashes or lstat()s them.
//
// It runs only `git --no-optional-locks status --porcelain=v2 -z --branch`
// and `git rev-parse --show-toplevel` (with GIT_* scrubbed from the child
// environment) plus lstat() on the non-protected paths git reported. It never
// stages, restores, resets, cleans, deletes, or writes the index/worktree.
//
// Exit codes: 0 ALLOW, 1 DENY (policy mismatch), 2 DENY (malformed input),
// 3 BLOCKED (git could not be run). Output: one deterministic JSON line.

import { execFile } from 'node:child_process';
import { lstat as fsLstat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const TOOL = 'repo-scope-guard';
export const PROTECTED_PATHS = Object.freeze(['.claude/settings.json', 'opencode.json']);

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SINGLETON_OPTIONS = new Set(['expect-branch', 'expect-head']);
const LIST_OPTIONS = new Set(['expect-dirty', 'expect-staged']);

const uniqueSorted = (items) => [...new Set(items)].sort();
const byCodeThenDetail = (a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : a.detail < b.detail ? -1 : a.detail > b.detail ? 1 : 0);

// A repo-relative, already-normalized literal path: no empty/"."/".." segment,
// not absolute, no backslash, no NUL. Anything else is rejected, never fixed up.
function repoPathProblem(value) {
  if (typeof value !== 'string' || value === '') return 'must be a non-empty string';
  if (value.includes('\0')) return 'contains a NUL byte';
  if (value.startsWith('/')) return 'is absolute';
  if (value.includes('\\')) return 'contains a backslash';
  for (const segment of value.split('/')) {
    if (segment === '') return 'has an empty segment (double or trailing slash)';
    if (segment === '.' || segment === '..') return `has a "${segment}" segment`;
  }
  return null;
}

export function parseArgs(argv) {
  const options = { expectBranch: null, expectHead: null, expectDirty: [], expectStaged: [] };
  const errors = [];
  const malformed = (code, detail) => errors.push({ code, detail });
  if (!Array.isArray(argv)) {
    malformed('MALFORMED_ARGV', 'argv must be an array of strings');
    return { ok: false, options, errors };
  }
  const seen = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (typeof token !== 'string') {
      malformed('MALFORMED_ARGV', `argument ${i} is not a string`);
      continue;
    }
    if (!token.startsWith('--')) {
      malformed('MALFORMED_POSITIONAL', `unexpected positional argument ${JSON.stringify(token)}`);
      continue;
    }
    const eq = token.indexOf('=');
    const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
    if (!SINGLETON_OPTIONS.has(name) && !LIST_OPTIONS.has(name)) {
      malformed('MALFORMED_UNKNOWN_OPTION', `unknown option --${name}`);
      continue;
    }
    let value;
    if (eq !== -1) value = token.slice(eq + 1);
    else {
      const next = argv[i + 1];
      if (next === undefined || (typeof next === 'string' && next.startsWith('--'))) {
        malformed('MALFORMED_MISSING_VALUE', `--${name} needs a value`);
        continue;
      }
      value = next;
      i += 1;
    }
    if (SINGLETON_OPTIONS.has(name)) {
      if (seen.has(name)) {
        malformed('MALFORMED_DUPLICATE_OPTION', `--${name} may be given only once`);
        continue;
      }
      seen.add(name);
    }
    if (name === 'expect-head') {
      if (typeof value === 'string' && FULL_SHA.test(value)) options.expectHead = value;
      else malformed('MALFORMED_HEAD', '--expect-head requires a full lowercase 40- or 64-hex commit id');
    } else if (name === 'expect-branch') {
      if (typeof value === 'string' && value !== '' && !value.includes('\0') && !value.includes('\n')) options.expectBranch = value;
      else malformed('MALFORMED_BRANCH', '--expect-branch requires a non-empty branch name');
    } else {
      const problem = repoPathProblem(value);
      if (problem) malformed('MALFORMED_PATH', `--${name} ${JSON.stringify(value)} ${problem}`);
      else (name === 'expect-dirty' ? options.expectDirty : options.expectStaged).push(value);
    }
  }
  options.expectDirty = uniqueSorted(options.expectDirty);
  options.expectStaged = uniqueSorted(options.expectStaged);
  errors.sort(byCodeThenDetail);
  return { ok: errors.length === 0, options, errors };
}

// Splits "f1 f2 ... fN rest" into N leading space-separated fields and the rest
// (the path, which may itself contain spaces).
function splitFields(line, count) {
  const fields = [];
  let from = 0;
  for (let i = 0; i < count; i += 1) {
    const at = line.indexOf(' ', from);
    if (at === -1) return null;
    fields.push(line.slice(from, at));
    from = at + 1;
  }
  return { fields, rest: line.slice(from) };
}

// ---- porcelain v2 record grammar (verified against real git 2.47 output: R., RM, RD, C., .T, .A, AD S...)
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MODE = /^[0-7]{6}$/;
const SUBMODULE = /^(?:N\.\.\.|S[C.][M.][U.])$/;
const SCORE = /^[RC](?:0|[1-9]\d?|100)$/;
// Status letters per record kind. '.' = unchanged. Ordinary records carry no rename/copy letter,
// rename/copy records may; 'U' is only legal in unmerged records, whose XY is one of seven pairs.
const ORDINARY_LETTERS = new Set(['M', 'T', 'A', 'D', '.']);
const RENAME_LETTERS = new Set(['M', 'T', 'A', 'D', 'R', 'C', '.']);
const UNMERGED_XY = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

// A repository-relative Git path as Git itself emits it. Untracked/ignored records may end in a
// single '/' (a nested repository or an untracked directory). Spaces, tabs, newlines, backslashes
// and non-ASCII are all legal in a Git path and are NOT rejected here.
function gitPathProblem(p, { allowTrailingSlash = false } = {}) {
  if (typeof p !== 'string' || p === '') return 'empty path';
  if (p.startsWith('/')) return 'absolute path';
  const trimmed = allowTrailingSlash && p.endsWith('/') ? p.slice(0, -1) : p;
  for (const segment of trimmed.split('/')) {
    if (segment === '') return 'empty path segment';
    if (segment === '.' || segment === '..') return 'dot path segment';
    if (segment.toLowerCase() === '.git') return '.git path segment';
  }
  return null;
}

// `git status --porcelain=v2 -z --branch`: every record is NUL-terminated and a rename/copy
// record is followed by a separate NUL-terminated original path. EVERY record is validated
// against the grammar of its kind; anything malformed is reported (the caller turns it into
// BLOCKED / STATUS_PARSE) rather than normalized into a plausible state. Error details name the
// record index and the rule, never the record content.
export function parsePorcelainV2(text) {
  const tokens = text.split('\0');
  if (tokens[tokens.length - 1] === '') tokens.pop();
  const branch = { oid: null, head: null };
  const entries = [];
  const errors = [];
  const bad = (i, rule) => errors.push(`record ${i}: ${rule}`);
  const seenHeaders = new Map();
  let sawRecord = false;

  const validPath = (i, p, what, opts) => {
    const problem = gitPathProblem(p, opts);
    if (problem) bad(i, `${what}: ${problem}`);
    return problem === null;
  };

  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (tok.startsWith('# ')) {
      if (sawRecord) {
        bad(i, 'header after entry records');
        continue;
      }
      const rest = tok.slice(2);
      const sp = rest.indexOf(' ');
      const key = sp === -1 ? rest : rest.slice(0, sp);
      const value = sp === -1 ? '' : rest.slice(sp + 1);
      if (key === 'branch.oid' || key === 'branch.head') {
        if (seenHeaders.has(key)) bad(i, `duplicate ${key} header`);
        seenHeaders.set(key, value);
        if (key === 'branch.oid') {
          if (value === '(initial)' || OID.test(value)) branch.oid = value;
          else bad(i, 'branch.oid is neither (initial) nor a full object id');
        } else if (value === '' || value !== value.trim()) {
          bad(i, 'branch.head is empty or padded');
        } else {
          branch.head = value;
        }
      }
      // other headers (branch.upstream, branch.ab, stash, future keys) are documented/extensible and unused here
      continue;
    }
    sawRecord = true;
    const kind = tok[0];
    if ((kind === '?' || kind === '!') && tok[1] === ' ') {
      if (validPath(i, tok.slice(2), `${kind} path`, { allowTrailingSlash: true })) entries.push({ kind, path: tok.slice(2) });
    } else if (kind === '1' && tok[1] === ' ') {
      const parts = splitFields(tok, 8);
      if (!parts) {
        bad(i, 'ordinary record has too few fields');
        continue;
      }
      const [, xy, sub, mH, mI, mW, hH, hI] = parts.fields;
      let ok = true;
      if (xy.length !== 2 || !ORDINARY_LETTERS.has(xy[0]) || !ORDINARY_LETTERS.has(xy[1]) || xy === '..') ok = (bad(i, 'ordinary XY invalid'), false);
      if (!SUBMODULE.test(sub)) ok = (bad(i, 'submodule field invalid'), false);
      if (![mH, mI, mW].every((m) => MODE.test(m))) ok = (bad(i, 'mode field invalid'), false);
      if (![hH, hI].every((h) => OID.test(h))) ok = (bad(i, 'object id field invalid'), false);
      if (!validPath(i, parts.rest, 'path')) ok = false;
      if (ok) entries.push({ kind: '1', x: xy[0], y: xy[1], sub, path: parts.rest });
    } else if (kind === '2' && tok[1] === ' ') {
      const parts = splitFields(tok, 9);
      const orig = tokens[i + 1];
      if (orig !== undefined) i += 1; // keep alignment even when this record is invalid
      if (!parts) {
        bad(i, 'rename/copy record has too few fields');
        continue;
      }
      const [, xy, sub, mH, mI, mW, hH, hI, score] = parts.fields;
      let ok = true;
      const letters = xy.length === 2 && RENAME_LETTERS.has(xy[0]) && RENAME_LETTERS.has(xy[1]) && xy !== '..';
      const hasRC = letters && (xy[0] === 'R' || xy[0] === 'C' || xy[1] === 'R' || xy[1] === 'C');
      if (!letters || !hasRC) ok = (bad(i, 'rename/copy XY invalid'), false);
      if (!SCORE.test(score)) ok = (bad(i, 'score field invalid'), false);
      else if (hasRC && score[0] !== xy[0] && score[0] !== xy[1]) ok = (bad(i, 'score letter contradicts XY'), false);
      if (!SUBMODULE.test(sub)) ok = (bad(i, 'submodule field invalid'), false);
      if (![mH, mI, mW].every((m) => MODE.test(m))) ok = (bad(i, 'mode field invalid'), false);
      if (![hH, hI].every((h) => OID.test(h))) ok = (bad(i, 'object id field invalid'), false);
      if (!validPath(i, parts.rest, 'path')) ok = false;
      if (orig === undefined) ok = (bad(i, 'rename/copy original path missing'), false);
      else if (!validPath(i, orig, 'original path')) ok = false;
      if (ok) entries.push({ kind: '2', x: xy[0], y: xy[1], sub, score, path: parts.rest, origPath: orig });
    } else if (kind === 'u' && tok[1] === ' ') {
      const parts = splitFields(tok, 10);
      if (!parts) {
        bad(i, 'unmerged record has too few fields');
        continue;
      }
      const [, xy, sub, m1, m2, m3, mW, h1, h2, h3] = parts.fields;
      let ok = true;
      if (!UNMERGED_XY.has(xy)) ok = (bad(i, 'unmerged XY invalid'), false);
      if (!SUBMODULE.test(sub)) ok = (bad(i, 'submodule field invalid'), false);
      if (![m1, m2, m3, mW].every((m) => MODE.test(m))) ok = (bad(i, 'mode field invalid'), false);
      if (![h1, h2, h3].every((h) => OID.test(h))) ok = (bad(i, 'object id field invalid'), false);
      if (!validPath(i, parts.rest, 'path')) ok = false;
      if (ok) entries.push({ kind: 'u', x: xy[0], y: xy[1], sub, path: parts.rest });
    } else {
      bad(i, 'unrecognized record');
    }
  }
  if (!seenHeaders.has('branch.oid')) errors.push('missing branch.oid header');
  if (!seenHeaders.has('branch.head')) errors.push('missing branch.head header');
  return { branch, entries, errors: errors.sort() };
}

// Pure classification of parsed entries into the exact sets the policy compares.
export function classifyEntries(entries) {
  const dirty = new Map();
  const staged = new Map();
  const unmerged = new Set();
  const note = (map, p, info) => {
    const prev = map.get(p);
    map.set(p, { deletion: Boolean(prev?.deletion || info.deletion), submodule: Boolean(prev?.submodule || info.submodule) });
  };
  for (const e of entries) {
    if (e.kind === '!') continue;
    if (e.kind === '?') {
      note(dirty, e.path, { deletion: false, submodule: false });
      continue;
    }
    const submodule = typeof e.sub === 'string' && e.sub[0] === 'S';
    const deletion = e.x === 'D' || e.y === 'D';
    if (e.kind === 'u') {
      unmerged.add(e.path);
      note(dirty, e.path, { deletion, submodule });
      continue;
    }
    // git status --porcelain=v2 XY semantics: X is the index-vs-HEAD side, Y the
    // worktree-vs-index side. A rename's ORIGINAL path belongs to the side whose
    // letter is 'R' only; a modification/deletion (M, D, ...) on the other side
    // concerns the destination alone. A copy ('C') leaves its source unchanged,
    // so the source never participates. The score letter is NOT consulted.
    if (e.x !== '.') {
      note(staged, e.path, { deletion, submodule });
      if (e.kind === '2' && e.x === 'R') note(staged, e.origPath, { deletion: true, submodule });
    }
    if (e.y !== '.') {
      note(dirty, e.path, { deletion, submodule });
      if (e.kind === '2' && e.y === 'R') note(dirty, e.origPath, { deletion: true, submodule });
    }
  }
  return { dirty, staged, unmerged };
}

function emptyResult(extra = {}) {
  return {
    tool: TOOL,
    verdict: 'ALLOW',
    branch: null,
    head: null,
    expectedDirty: [],
    actualDirty: [],
    unexpectedDirty: [],
    missingDirty: [],
    expectedStaged: [],
    actualStaged: [],
    unexpectedStaged: [],
    missingStaged: [],
    protected: [],
    unmerged: [],
    nonRegular: [],
    errors: [],
    ...extra,
  };
}

const difference = (a, b) => a.filter((p) => !b.includes(p));

// Pure policy decision. `fileTypes` maps path -> 'file' | 'missing' | 'other'.
export function evaluate({ options, branch, head, entries, fileTypes }) {
  const { dirty, staged, unmerged } = classifyEntries(entries);
  const actualDirty = uniqueSorted([...dirty.keys()]);
  const actualStaged = uniqueSorted([...staged.keys()]);
  const errors = [];
  const protectedSet = new Set(PROTECTED_PATHS);

  const namedProtected = uniqueSorted([...options.expectDirty, ...options.expectStaged].filter((p) => protectedSet.has(p)));
  for (const p of namedProtected) errors.push({ code: 'PROTECTED_IN_EXPECTED_SET', detail: p });

  const foundProtected = uniqueSorted([...actualDirty, ...actualStaged, ...unmerged].filter((p) => protectedSet.has(p)));

  if (options.expectBranch !== null) {
    if (branch === null) errors.push({ code: 'DETACHED_HEAD', detail: `expected branch ${options.expectBranch}` });
    else if (branch !== options.expectBranch) errors.push({ code: 'BRANCH_MISMATCH', detail: `expected ${options.expectBranch}, found ${branch}` });
  } else if (branch === null && options.expectHead === null) {
    errors.push({ code: 'DETACHED_HEAD', detail: 'HEAD is detached and no --expect-head pin was given' });
  }
  if (options.expectHead !== null && head !== options.expectHead) {
    errors.push({ code: 'HEAD_MISMATCH', detail: `expected ${options.expectHead}, found ${head ?? '(no commits)'}` });
  }

  const unmergedList = uniqueSorted([...unmerged]);
  for (const p of unmergedList) errors.push({ code: 'UNMERGED', detail: p });

  const nonRegular = uniqueSorted(
    [...new Set([...actualDirty, ...actualStaged])].filter((p) => {
      if (protectedSet.has(p)) return false;
      const info = dirty.get(p) ?? staged.get(p);
      if (info?.submodule) return false;
      const type = fileTypes.get(p);
      if (type === 'file') return false;
      if (type === 'missing') return !(dirty.get(p)?.deletion || staged.get(p)?.deletion);
      return true;
    }),
  );

  const unexpectedDirty = difference(actualDirty, options.expectDirty);
  const missingDirty = difference(options.expectDirty, actualDirty);
  const unexpectedStaged = difference(actualStaged, options.expectStaged);
  const missingStaged = difference(options.expectStaged, actualStaged);

  const violation =
    errors.length > 0 ||
    unexpectedDirty.length > 0 ||
    missingDirty.length > 0 ||
    unexpectedStaged.length > 0 ||
    missingStaged.length > 0 ||
    foundProtected.length > 0 ||
    nonRegular.length > 0;

  return emptyResult({
    verdict: violation ? 'DENY' : 'ALLOW',
    branch,
    head,
    expectedDirty: options.expectDirty,
    actualDirty,
    unexpectedDirty,
    missingDirty,
    expectedStaged: options.expectStaged,
    actualStaged,
    unexpectedStaged,
    missingStaged,
    protected: foundProtected,
    unmerged: unmergedList,
    nonRegular,
    errors: errors.sort(byCodeThenDetail),
  });
}

function scrubbedGitEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith('GIT_')) env[key] = value;
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_OPTIONAL_LOCKS = '0';
  return env;
}

// Only two read-only git invocations are ever made; both pass --no-optional-locks
// and disable fsmonitor so that nothing can refresh or write the index.
function defaultExecGit(args, cwd) {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['--no-optional-locks', '-c', 'core.fsmonitor=false', ...args],
      { cwd, env: scrubbedGitEnv(), encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 },
      (error, stdout) => {
        if (error) resolve({ ok: false, code: typeof error.code === 'number' ? error.code : null, message: error.code ?? error.message });
        else resolve({ ok: true, stdout: stdout.toString('utf8') });
      },
    );
  });
}

const blocked = (detail) => ({
  exitCode: 3,
  result: emptyResult({ verdict: 'BLOCKED', errors: [{ code: 'GIT_UNAVAILABLE', detail }] }),
});

export async function runGuard({ argv = [], cwd = process.cwd(), lstat = fsLstat, execGit = defaultExecGit } = {}) {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    return { exitCode: 2, result: emptyResult({ verdict: 'DENY', errors: parsed.errors }) };
  }
  const { options } = parsed;

  const top = await execGit(['rev-parse', '--show-toplevel'], cwd);
  if (!top.ok) return blocked(`git rev-parse --show-toplevel failed (${top.message})`);
  const root = top.stdout.replace(/\n$/, '');

  const status = await execGit(['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all'], cwd);
  if (!status.ok) return blocked(`git status failed (${status.message})`);

  const { branch, entries, errors: parseErrors } = parsePorcelainV2(status.stdout);
  if (parseErrors.length > 0) {
    return {
      exitCode: 3,
      result: emptyResult({ verdict: 'BLOCKED', errors: parseErrors.map((detail) => ({ code: 'STATUS_PARSE', detail })).sort(byCodeThenDetail) }),
    };
  }

  const { dirty, staged } = classifyEntries(entries);
  const fileTypes = new Map();
  const protectedSet = new Set(PROTECTED_PATHS);
  for (const p of new Set([...dirty.keys(), ...staged.keys()])) {
    if (protectedSet.has(p)) continue; // never inspected on disk
    try {
      const st = await lstat(path.join(root, p));
      fileTypes.set(p, st.isFile() ? 'file' : 'other');
    } catch (error) {
      fileTypes.set(p, error && error.code === 'ENOENT' ? 'missing' : 'other');
    }
  }

  const head = branch.oid === null || branch.oid === '(initial)' ? null : branch.oid;
  const branchName = branch.head === null || branch.head === '(detached)' ? null : branch.head;
  const result = evaluate({ options, branch: branchName, head, entries, fileTypes });
  return { exitCode: result.verdict === 'ALLOW' ? 0 : 1, result };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { exitCode, result } = await runGuard({ argv: process.argv.slice(2) });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = exitCode;
}
