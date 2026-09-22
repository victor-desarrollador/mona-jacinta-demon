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
// Regex matching here is a best-effort tripwire, not a complete shell
// parser or a SQL firewall — it will not catch every possible way to
// construct an equivalent command, and it is not trying to.

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

// Strips leading `command`/`env [KEY=val ...]` wrappers and a leading git
// `-C <path>` global option, e.g. `env git -C . add .` -> `git add .`.
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
    if (out[0] === 'git' && out[1] === '-C') {
      out = ['git', ...out.slice(3)];
      changed = true;
      continue;
    }
  }
  return out;
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

for (const seg of segments(command)) {
  if (isBroadGitAdd(normalizeSegment(seg))) {
    respond(
      'deny',
      'Mona Jacinta requires explicit path staging. This looks like broad/root staging ' +
        '(`.`, `./`, `:/`, `*`, `-A`/`--all`, or `-u`/`--update`), which risks staging opencode.json ' +
        'or unrelated work-in-progress files. Stage exact paths instead: ' +
        '`git add -- <path> [<path> ...]`.',
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
    label: 'raw SQL execution via psql containing a destructive statement',
    pattern: /\bpsql\b[\s\S]*-c\s+["'][\s\S]*\b(TRUNCATE|DROP\s+TABLE|DROP\s+SCHEMA|DELETE\s+FROM)\b/i,
  },
];

for (const { label, pattern } of riskCategories) {
  if (pattern.test(command)) {
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
