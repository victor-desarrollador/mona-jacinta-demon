#!/usr/bin/env node
// PreToolUse / Edit|Write|NotebookEdit|Bash — protects repository-root
// opencode.json from being modified, overwritten, or deleted by Claude Code.
//
// The committed opencode.json is minimal (schema declaration only); the
// working copy is treated as local-only, out-of-scope configuration for this
// project. This hook mechanically denies both direct file-tool writes and
// obvious Bash-mediated writes/deletes targeting it.
//
// Bash coverage here is text-pattern matching, not a shell parser: it cannot
// mathematically enumerate every possible shell-mediated way to rewrite a
// file (arbitrary indirection through variables, encoded commands, other
// interpreters, etc.). This is defense-in-depth against ordinary/obvious
// forms, not a sandbox — it does not replace human review of Bash tool calls.

import { readFileSync } from 'node:fs';
import path from 'node:path';

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
}

function allow() {
  // No opinion: emit nothing so normal Claude Code permission behavior applies.
  process.exit(0);
}

let input;
try {
  input = JSON.parse(readStdin());
} catch {
  allow();
}

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const opencodePath = path.resolve(projectDir, 'opencode.json');

const REASON =
  'opencode.json is protected: this repository treats the local working copy as ' +
  'local-only/out-of-scope configuration. It must not be edited, overwritten, or deleted ' +
  'by Claude Code. Ask the human to change it directly if a change is genuinely needed.';

// --- Direct file tools: Edit, Write, NotebookEdit ----------------------
if (input.tool_name === 'Edit' || input.tool_name === 'Write') {
  const filePath = input.tool_input?.file_path;
  if (typeof filePath === 'string' && path.resolve(projectDir, filePath) === opencodePath) {
    deny(REASON);
  }
  allow();
}

if (input.tool_name === 'NotebookEdit') {
  const notebookPath = input.tool_input?.notebook_path;
  if (typeof notebookPath === 'string' && path.resolve(projectDir, notebookPath) === opencodePath) {
    deny(REASON);
  }
  allow();
}

// --- Bash-mediated writes/deletes --------------------------------------
if (input.tool_name !== 'Bash') allow();

const command = String(input.tool_input?.command ?? '');
if (!command.trim()) allow();

// Self-contained tokenizer (deliberately not shared with
// guard-dangerous-bash.mjs — this file stands on its own). Splits into
// words (respecting basic '...'/"..." quoting), chain operators
// (&&, ||, ;, |) and redirect operators (>, >>). This is still command-text
// analysis, not a shell parser or sandbox: it does not resolve variable
// indirection, eval, encoded commands, or arbitrary subshell construction.
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
      tokens.push({ type: 'chain', value: '&&' });
      i += 2;
      continue;
    }
    if (str.startsWith('||', i)) {
      tokens.push({ type: 'chain', value: '||' });
      i += 2;
      continue;
    }
    if (ch === ';' || ch === '|') {
      tokens.push({ type: 'chain', value: ch });
      i++;
      continue;
    }
    if (str.startsWith('>>', i)) {
      tokens.push({ type: 'redirect', value: '>>' });
      i += 2;
      continue;
    }
    if (ch === '>') {
      tokens.push({ type: 'redirect', value: '>' });
      i++;
      continue;
    }
    let word = '';
    while (i < n) {
      const c = str[i];
      if (/\s/.test(c) || c === ';' || c === '|' || c === '>' || str.startsWith('&&', i)) break;
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
    if (word) tokens.push({ type: 'word', value: word });
  }
  return tokens;
}

// Splits into ordinary command segments at unquoted chain operators.
// Redirect tokens stay inside their segment (they're part of that command).
function segments(str) {
  const segs = [[]];
  for (const t of tokenize(str)) {
    if (t.type === 'chain') segs.push([]);
    else segs[segs.length - 1].push(t);
  }
  return segs.filter((s) => s.length > 0);
}

function wordsOf(seg) {
  return seg.filter((t) => t.type === 'word').map((t) => t.value);
}

// True only for a token that resolves to the repository-root opencode.json —
// never a same-named file elsewhere (api/opencode.json) or a similarly
// prefixed filename (opencode.json-notes.md).
function isRootOpencode(token) {
  if (!token || token === '--') return false;
  let t = token;
  if (t.startsWith('./')) t = t.slice(2);
  if (t === 'opencode.json') return true;
  return path.isAbsolute(token) && path.resolve(token) === opencodePath;
}

// Ordinary `git` global options that can appear between `git` and the real
// subcommand — a small data-driven model, not a full Git parser. Kept
// self-contained here (duplicated from guard-dangerous-bash.mjs by design —
// this file stands on its own, see the top-of-file note). Grouped by how
// they consume tokens: no value, a value as the next separate token
// (`-C <path>`, `-c <name>=<value>`), or a value ordinarily attached via
// `=` (`--git-dir=<path>`) — git also accepts the latter as a separate
// token, so both forms are handled.
const GIT_GLOBAL_NO_VALUE = new Set([
  '--no-pager', '-P', '--paginate', '-p', '--bare',
  '--no-replace-objects', '--no-lazy-fetch', '--no-optional-locks', '--no-advice',
  '--literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs',
]);
const GIT_GLOBAL_SEPARATE_VALUE = new Set(['-C', '-c']);
const GIT_GLOBAL_ATTACHABLE = ['--git-dir', '--work-tree', '--namespace', '--config-env'];

// Skips ordinary global options so the returned array starts at the real
// subcommand, e.g. `git -c x=y --no-pager -C . add opencode.json` ->
// `['git','add','opencode.json']`. An unrecognized token (including things
// like `--version`) simply stops the scan — `words[1]` then won't match any
// mutator this file checks for, so it's a safe no-op.
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
      i += 2;
      continue;
    }
    if (GIT_GLOBAL_ATTACHABLE.some((name) => tok.startsWith(`${name}=`))) {
      i += 1;
      continue;
    }
    break;
  }
  return ['git', ...words.slice(i)];
}

// Strips leading `command`/`env [KEY=val ...]` wrappers, a bare leading
// `KEY=VALUE` assignment (no `env` keyword), then any ordinary git global
// options, e.g. `FOO=x env git -c a=b -C . add opencode.json` ->
// `['git', 'add', 'opencode.json']`.
function normalizeGitWords(w) {
  let out = w;
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

// git subcommands that mutate the index/worktree state of a pathspec.
const GIT_MUTATORS = new Set(['add', 'restore', 'checkout', 'reset']);

for (const seg of segments(command)) {
  const w = normalizeGitWords(wordsOf(seg));

  // --- git add/restore/checkout/reset targeting root opencode.json ------
  if (w[0] === 'git' && GIT_MUTATORS.has(w[1]) && w.slice(2).some(isRootOpencode)) {
    deny(REASON);
  }

  const first = w[0];
  const rest = w.slice(1);

  // --- tee / truncate / rm: any argument targeting root opencode.json ---
  if ((first === 'tee' || first === 'truncate' || first === 'rm') && rest.some(isRootOpencode)) {
    deny(REASON);
  }

  // --- sed -i / perl -pi targeting root opencode.json --------------------
  if (
    first === 'sed' &&
    rest.some((a) => a === '-i' || /^-i\S*$/.test(a)) &&
    rest.some(isRootOpencode)
  ) {
    deny(REASON);
  }
  if (first === 'perl' && rest.some((a) => /^-\w*p\w*i\w*$/.test(a)) && rest.some(isRootOpencode)) {
    deny(REASON);
  }

  // --- cp: only the destination (direction-aware) -------------------------
  // Reading FROM root opencode.json (`cp opencode.json /tmp/backup.json`) is
  // not a mutation of the original and is left alone.
  if (first === 'cp') {
    const positional = rest.filter((a) => !a.startsWith('-'));
    if (isRootOpencode(positional.at(-1))) deny(REASON);
  }

  // --- mv: either side (moving root away still mutates/removes it) -------
  if (first === 'mv') {
    const positional = rest.filter((a) => !a.startsWith('-'));
    if (isRootOpencode(positional[0]) || isRootOpencode(positional.at(-1))) deny(REASON);
  }

  // --- shell redirection (>, >>) into root opencode.json ------------------
  for (let i = 0; i < seg.length - 1; i++) {
    if (seg[i].type === 'redirect' && seg[i + 1].type === 'word' && isRootOpencode(seg[i + 1].value)) {
      deny(REASON);
    }
  }
}

allow();
