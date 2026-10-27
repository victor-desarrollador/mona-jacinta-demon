#!/usr/bin/env node
// PreToolUse / Bash — command-risk guard only.
//
// This hook classifies Bash COMMAND TEXT into risk categories. It does not
// and cannot know which database (DEV/TEST) a command will actually reach —
// that depends on environment variables and .env.development, resolved only
// at run time inside the process the command spawns. Proving DEV/TEST
// identity is the job of the repo's existing in-process checks
// (scripts/check-databases.mjs, api/scripts/demo-database.ts,
// api/tests/helpers/test-db.ts), never this hook. This hook only decides
// whether a human should be asked before a risky-looking command runs.
//
// This is a small tokenize/normalize/inspect pipeline for Git subcommands
// (see below), plus targeted regex matching for DB/Prisma/SQL command
// families — a best-effort tripwire, not a complete shell parser or a SQL
// firewall. It will not catch every possible way to construct an equivalent
// command, and it is not trying to.

import { readFileSync } from 'node:fs';

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function respond(decision, reason) {
  if (decision === null) {
    // No opinion: emit nothing so normal Claude Code permission behavior applies.
    process.exit(0);
  }
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision,
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
}

let input;
try {
  input = JSON.parse(readStdin());
} catch {
  respond(null, '');
}

if (input.tool_name !== 'Bash') respond(null, '');

const command = String(input.tool_input?.command ?? '');
if (!command.trim()) respond(null, '');

// --- Exact-staging rule: BLOCK, not ASK -------------------------------
// Mona Jacinta requires explicit path staging (see CLAUDE.md): only
// `git add -- <exact paths>` is allowed. A single regex on the raw string
// can't reliably tell "git add ." (broad) apart from "git add ./foo.ts"
// (explicit) or survive `git -C . add .`/`env`/`command` wrappers, so this
// is a small tokenize -> normalize -> inspect pipeline instead of one
// mega-regex. It still only understands ordinary command text — basic
// quoting and unquoted &&/||/;/| chaining — not deliberate shell
// obfuscation (variable indirection, eval, encoded commands, etc.).

// Tokenizes into words and chain operators, honoring simple '...'/"..."
// quoting (quotes are stripped, not shell-expanded).
function tokenize(str) {
  const tokens = [];
  let i = 0;
  const n = str.length;
  while (i < n) {
    const ch = str[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (str.startsWith('&&', i)) {
      tokens.push({ op: '&&' });
      i += 2;
      continue;
    }
    if (str.startsWith('||', i)) {
      tokens.push({ op: '||' });
      i += 2;
      continue;
    }
    if (ch === ';' || ch === '|') {
      tokens.push({ op: ch });
      i++;
      continue;
    }
    let word = '';
    while (i < n) {
      const c = str[i];
      if (/\s/.test(c) || c === ';' || c === '|' || str.startsWith('&&', i)) break;
      if (c === "'" || c === '"') {
        const quote = c;
        i++;
        while (i < n && str[i] !== quote) {
          word += str[i];
          i++;
        }
        i++; // skip closing quote (missing one just runs to end, harmless here)
        continue;
      }
      word += c;
      i++;
    }
    if (word) tokens.push({ word });
  }
  return tokens;
}

// Splits into ordinary command segments at unquoted chain operators.
function segments(str) {
  const segs = [[]];
  for (const t of tokenize(str)) {
    if (t.op) segs.push([]);
    else segs[segs.length - 1].push(t.word);
  }
  return segs.filter((s) => s.length > 0);
}

// Ordinary `git` global options that can appear between `git` and the real
// subcommand — a small data-driven model, not a full Git parser. Grouped by
// how they consume tokens:
//   - no value at all (the option itself is the whole thing)
//   - a value as the next SEPARATE token (`-C <path>`, `-c <name>=<value>`)
//   - a value ordinarily attached via `=` (`--git-dir=<path>`), though git
//     also accepts these as a separate token, so both forms are handled.
const GIT_GLOBAL_NO_VALUE = new Set([
  '--no-pager', '-P', '--paginate', '-p', '--bare',
  '--no-replace-objects', '--no-lazy-fetch', '--no-optional-locks', '--no-advice',
  '--literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs',
]);
const GIT_GLOBAL_SEPARATE_VALUE = new Set(['-C', '-c']);
const GIT_GLOBAL_ATTACHABLE = ['--git-dir', '--work-tree', '--namespace', '--config-env'];

// Skips ordinary global options so the returned array starts at the real
// subcommand, e.g. `git -c x=y --no-pager -C . add .` -> `['git','add','.']`.
// A token this model doesn't recognize (including things like `--version`)
// simply stops the scan — it's then just whatever `words[1]` ends up being,
// which none of this file's subcommand checks will match, so it's a no-op.
function skipGitGlobals(words) {
  if (words[0] !== 'git') return words;
  let i = 1;
  while (i < words.length) {
    const tok = words[i];
    if (GIT_GLOBAL_NO_VALUE.has(tok)) {
      i += 1;
      continue;
    }
    if (GIT_GLOBAL_SEPARATE_VALUE.has(tok)) {
      i += 2;
      continue;
    }
    if (GIT_GLOBAL_ATTACHABLE.includes(tok)) {
      i += 2; // `--git-dir <path>` (separate-token form)
      continue;
    }
    if (GIT_GLOBAL_ATTACHABLE.some((name) => tok.startsWith(`${name}=`))) {
      i += 1; // `--git-dir=<path>` (attached form)
      continue;
    }
    break;
  }
  return ['git', ...words.slice(i)];
}

// Strips leading `command`/`env [KEY=val ...]` wrappers and a bare leading
// `KEY=VALUE` assignment (no `env` keyword), then any ordinary git global
// options, e.g. `FOO=x env git -c a=b -C . add .` -> `['git','add','.']`.
function normalizeSegment(words) {
  let out = words;
  let changed = true;
  while (changed) {
    changed = false;
    if (out[0] === 'command') {
      out = out.slice(1);
      changed = true;
      continue;
    }
    if (out[0] === 'env') {
      out = out.slice(1);
      while (out.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(out[0])) out = out.slice(1);
      changed = true;
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(out[0] ?? '')) {
      out = out.slice(1);
      changed = true;
      continue;
    }
  }
  return skipGitGlobals(out);
}

// Root/broad pathspecs and flags that stage indiscriminately. `-u`/`--update`
// is included: the supported Mona Jacinta workflow is `git add -- <exact
// paths>` only, so there's no case here that needs -u preserved.
const BROAD_PATHSPECS = new Set(['.', './', ':/', '*']);
const BROAD_FLAGS = new Set(['-A', '--all', '-u', '--update']);

function isBroadGitAdd(words) {
  if (words[0] !== 'git' || words[1] !== 'add') return false;
  for (const arg of words.slice(2)) {
    if (arg === '--') continue;
    if (BROAD_FLAGS.has(arg) || BROAD_PATHSPECS.has(arg)) return true;
  }
  return false;
}

// --- Broad worktree-destructive Git operations: DENY -------------------
// These bypass explicit-path review entirely by mutating tracked state (or
// discarding untracked work) without naming individual paths — e.g.
// `git commit -a` auto-stages every tracked modification, including
// opencode.json's local change, with no separate `git add` step to catch it.
// Returns a short label describing what was detected, or null.
const STASH_READONLY = new Set(['list', 'show']);

// `git commit`'s own short options that require a value: attached to the
// same token (`-mmsg`) if characters follow the letter, else the next
// SEPARATE token (`-m msg`). `-S`/--gpg-sign's value is optional and only
// ever attaches from the same token (`-Sdeadbeef`) — a bare `-S` takes
// nothing further. Long options are never themselves the auto-stage flag
// (only `--all` is), so they're skipped without inspecting their value.
const COMMIT_VALUE_REQUIRED_SHORT = new Set(['m', 'F', 'C', 'c', 't']);
const COMMIT_VALUE_OPTIONAL_SHORT = new Set(['S']);
// Long options: required-value ones accept their value either attached
// (`--message=x`) or as a separate following token (`--message x`). Optional-
// value ones (only `--gpg-sign` here) follow Git's own optional-argument
// long-option rule: the value is ONLY ever attached (`--gpg-sign=<keyid>`); a
// bare `--gpg-sign` consumes nothing further, so a following `-a`/`--all`
// remains a real, independent flag. Ordinary no-value long options (e.g.
// `--no-gpg-sign`, `--amend`) are simply absent from both sets below and so
// never consume a separate token either — no enumeration needed for those.
const COMMIT_VALUE_REQUIRED_LONG = new Set([
  '--message', '--file', '--reuse-message', '--reedit-message', '--template',
  '--author', '--date', '--fixup', '--squash',
]);
const COMMIT_VALUE_OPTIONAL_LONG = new Set(['--gpg-sign']);

// Proper left-to-right parse of `git commit`'s arguments: `-a` only counts
// as auto-stage when it actually occupies a flag position in a short-option
// bundle, never when it's part of a value attached to an earlier
// value-consuming option in that same bundle (e.g. `-malpha`'s "a" is `-m`'s
// message text, not a second flag).
function isCommitAutoStage(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') break; // end of options: everything after is a pathspec, never a flag
    if (a === '--all') return true;
    if (a.startsWith('--')) {
      const name = a.split('=')[0];
      if (!a.includes('=') && COMMIT_VALUE_REQUIRED_LONG.has(name)) {
        i++; // skip separate-token value
      } else if (COMMIT_VALUE_OPTIONAL_LONG.has(name)) {
        // attached-only value (`=`); a bare form consumes nothing further
      }
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      const chars = a.slice(1);
      for (let j = 0; j < chars.length; j++) {
        const c = chars[j];
        if (c === 'a') return true;
        if (COMMIT_VALUE_REQUIRED_SHORT.has(c)) {
          if (j + 1 >= chars.length) i++; // bare flag: value is the next separate token
          break; // remaining chars in this bundle (if any) are the value, not flags
        }
        if (COMMIT_VALUE_OPTIONAL_SHORT.has(c)) {
          break; // any trailing chars here are its attached value, never a flag
        }
        // an ordinary boolean short flag (-v, -n, -q, -e, -s, ...): keep scanning
      }
    }
  }
  return false;
}

function worktreeDestructiveLabel(words) {
  if (words[0] !== 'git') return null;

  if (words[1] === 'commit') {
    if (isCommitAutoStage(words.slice(2))) {
      return 'git commit with auto-staging (-a/--all), which stages tracked modifications ' +
        '(including opencode.json) without an explicit git add';
    }
    return null;
  }

  if (words[1] === 'stash') {
    const sub = words[2];
    if (sub === undefined || !STASH_READONLY.has(sub)) {
      return 'git stash (a mutating form), which can hide or discard local work-in-progress';
    }
    return null;
  }

  if (words[1] === 'checkout') {
    const args = words.slice(2);
    if (args.some((a) => a === '-f' || a === '--force')) {
      return 'git checkout --force/-f, which can discard local tracked changes on branch switch';
    }
    if (args.some((a) => BROAD_PATHSPECS.has(a))) {
      return 'git checkout targeting the whole working tree, which discards local changes broadly';
    }
    return null;
  }

  if (words[1] === 'restore') {
    if (words.slice(2).some((a) => BROAD_PATHSPECS.has(a))) {
      return 'git restore targeting the whole working tree, which discards local changes broadly';
    }
    return null;
  }

  if (words[1] === 'switch') {
    if (words.slice(2).some((a) => a === '-f' || a === '--force' || a === '--discard-changes')) {
      return 'git switch with a force/discard flag, which can discard local tracked changes';
    }
    return null;
  }

  if (words[1] === 'reset') {
    if (words.slice(2).some((a) => a === '--hard')) {
      return 'git reset --hard, which discards tracked working-tree and index changes';
    }
    return null;
  }

  if (words[1] === 'clean') {
    const args = words.slice(2);
    const isShortBundle = (a) => a.startsWith('-') && !a.startsWith('--');
    const hasDryRun = args.some((a) => a === '--dry-run' || (isShortBundle(a) && a.includes('n')));
    const hasForce = args.some((a) => a === '--force' || (isShortBundle(a) && a.includes('f')));
    if (hasForce && !hasDryRun) {
      return 'git clean with -f/--force and no dry-run flag, which permanently deletes untracked files';
    }
    return null;
  }

  return null;
}

// --- Repository shell-wrapper entry points: ASK ------------------------
// scripts/demo-reset.sh and scripts/demo-seed.sh are first-class entry
// points to `npm run demo:reset`/`demo:seed` (they just cd to the repo root
// and run that script). Detected by executable/runner POSITION, not a bare
// filename substring — so a read like `cat scripts/demo-reset.sh` never
// matches (the filename never occupies an executable or runner-argument
// position there).
const DEMO_SHELL_SCRIPT = /(?:^|\/)(?:demo-reset|demo-seed)\.sh$/;
// `source`/`.` take only a filename (no options of their own), so the script
// is always the very next word. `bash`/`sh` accept ordinary runner options
// first, so finding their script operand needs findShellRunnerScript below.
const SHELL_RUNNERS_DIRECT = new Set(['source', '.']);
const SHELL_RUNNERS_WITH_FLAGS = new Set(['bash', 'sh']);

// Ordinary bash/sh runner options that can precede the script path — a small
// model, not a full shell-argument parser (mirrors the Git-global model
// above). `-c` (command-string mode) is deliberately not "skip its value and
// keep looking": once a short bundle contains `c`, everything after it is
// the command STRING (and anything further is a positional parameter, not a
// script to execute), so there is nothing left here that can be trusted as a
// script path — this hook stays silent rather than inspecting that string.
// A bare `--` ends runner-option parsing (the standard shell convention): the
// token right after it is always the script, never inspected as an option.
// `+`-prefixed forms (`+x`, `+e`, ...) are the ordinary way to toggle these
// same shell options off and are recognized the same way as their `-` forms.
const SHELL_RUNNER_NO_VALUE_SHORT = new Set(['e', 'u', 'x', 'v', 'n', 'f']);
const SHELL_RUNNER_NO_VALUE_LONG = new Set(['--posix', '--noprofile', '--norc']);
const SHELL_RUNNER_SEPARATE_VALUE_SHORT = new Set(['-o', '-O']);
const SHELL_RUNNER_SEPARATE_VALUE_LONG = new Set(['--rcfile', '--init-file']);

// Returns the script operand after ordinary bash/sh runner options, or null
// if none can be identified (an unrecognized option, `-c` command-string
// mode, or the word list simply runs out).
function findShellRunnerScript(words) {
  let i = 1;
  while (i < words.length) {
    const tok = words[i];
    if (tok === '--') return words[i + 1] ?? null; // end of runner options: next word is the script
    if (tok.startsWith('--')) {
      if (SHELL_RUNNER_NO_VALUE_LONG.has(tok)) { i += 1; continue; }
      if (SHELL_RUNNER_SEPARATE_VALUE_LONG.has(tok)) { i += 2; continue; }
      return null; // unrecognized long option: nothing further can be trusted
    }
    if (tok.startsWith('+') && tok.length > 1) {
      const chars = tok.slice(1);
      if ([...chars].every((c) => SHELL_RUNNER_NO_VALUE_SHORT.has(c))) { i += 1; continue; }
      return null; // unrecognized `+` option/bundle
    }
    if (tok.startsWith('-') && tok.length > 1) {
      if (SHELL_RUNNER_SEPARATE_VALUE_SHORT.has(tok)) { i += 2; continue; }
      const chars = tok.slice(1);
      if (chars.includes('c')) return null; // command-string mode: out of scope
      if ([...chars].every((c) => SHELL_RUNNER_NO_VALUE_SHORT.has(c))) { i += 1; continue; }
      return null; // unrecognized short option/bundle
    }
    return tok; // first non-option token: the script operand
  }
  return null;
}

function isDemoShellWrapperExecution(words) {
  const first = words[0];
  if (!first) return false;
  if (DEMO_SHELL_SCRIPT.test(first)) return true; // run directly as the executable
  if (SHELL_RUNNERS_DIRECT.has(first) && DEMO_SHELL_SCRIPT.test(words[1] ?? '')) return true;
  if (SHELL_RUNNERS_WITH_FLAGS.has(first)) {
    const script = findShellRunnerScript(words);
    return script !== null && DEMO_SHELL_SCRIPT.test(script);
  }
  return false;
}

for (const seg of segments(command)) {
  const words = normalizeSegment(seg);

  if (isDemoShellWrapperExecution(words)) {
    respond(
      'ask',
      'Detected risk category: direct execution of scripts/demo-reset.sh or scripts/demo-seed.sh ' +
        '(repository entry points equivalent to npm run demo:reset/demo:seed). This hook only ' +
        'flags command risk — it cannot tell whether this targets DEV or TEST. Confirm this is ' +
        'intentional before proceeding.',
    );
  }

  if (isBroadGitAdd(words)) {
    respond(
      'deny',
      'Mona Jacinta requires explicit path staging. This looks like broad/root staging ' +
        '(`.`, `./`, `:/`, `*`, `-A`/`--all`, or `-u`/`--update`), which risks staging opencode.json ' +
        'or unrelated work-in-progress files. Stage exact paths instead: ' +
        '`git add -- <path> [<path> ...]`.',
    );
  }

  const worktreeLabel = worktreeDestructiveLabel(words);
  if (worktreeLabel) {
    respond(
      'deny',
      `Mona Jacinta blocks broad worktree-destructive Git operations. Detected: ${worktreeLabel}. ` +
        'Use an explicit, narrowly-scoped equivalent instead (e.g. stage exact paths first, then ' +
        '`git commit -m`; restore/reset an exact path, not the whole tree).',
    );
  }
}

// --- Dangerous DB / schema command families: ASK ----------------------
const riskCategories = [
  {
    label: 'npm demo/db lifecycle script (destructive)',
    pattern: /\b(db|demo):(push|migrate|seed|reset|restore)\b/,
  },
  {
    label: 'npm db backfill/bootstrap script (mutates RBAC/scope data)',
    pattern: /\bdb:(backfill|bootstrap)-[\w-]+\b/,
  },
  {
    label: 'direct Prisma schema/migration command (bypasses npm script wrapper)',
    pattern: /\bprisma\s+db\s+push\b|\bprisma\s+migrate\s+(dev|reset|deploy)\b/,
  },
  {
    label: 'Prisma db execute (can run arbitrary SQL)',
    pattern: /\bprisma\s+db\s+execute\b/,
  },
  {
    label: 'database GUI with write capability (Prisma Studio)',
    pattern: /\b(?:db|demo):studio\b|\bprisma\s+studio\b/,
  },
  {
    label: 'raw SQL execution via psql containing a destructive statement',
    pattern: /\bpsql\b[\s\S]*-c\s+["'][\s\S]*\b(TRUNCATE|DROP\s+TABLE|DROP\s+SCHEMA|DELETE\s+FROM)\b/i,
  },
  {
    label: 'direct execution of a repository db lifecycle script (reset-demo/seed-demo/backfill-*/bootstrap-*) ' +
      'via a TS runner, bypassing the npm script wrapper',
    // Requires BOTH a TS-runner invocation (tsx/ts-node, in any of their
    // ordinary wrapped forms — npx tsx, pnpm exec tsx, yarn tsx, bunx tsx,
    // node --import tsx all contain the word "tsx") AND one of the
    // repository's mutator script names — never on a bare read like
    // `cat api/scripts/reset-demo.ts`, which contains neither.
    pattern: /\b(?:tsx|ts-node)\b/,
    also: /\b(?:reset-demo|seed-demo|backfill-[\w-]+|bootstrap-[\w-]+)\.ts\b/,
  },
];

for (const { label, pattern, also } of riskCategories) {
  if (pattern.test(command) && (!also || also.test(command))) {
    respond(
      'ask',
      `Detected risk category: ${label}. This hook only flags command risk — it cannot tell ` +
        'whether this targets DEV or TEST (that proof belongs to scripts/check-databases.mjs / ' +
        'api/scripts/demo-database.ts / api/tests/helpers/test-db.ts). Confirm this is intentional ' +
        'and that you know which database it will reach before proceeding.',
    );
  }
}

respond(null, '');
