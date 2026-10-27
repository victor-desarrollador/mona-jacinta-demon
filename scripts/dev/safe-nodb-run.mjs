#!/usr/bin/env node
// safe-nodb-run (TOOL-1): run explicitly listed, DB-free API test files with
// the pinned local Vitest inside layered containment, with an environment built
// from scratch.
//
//   node scripts/dev/safe-nodb-run.mjs api/tests/<dir>/<name>.test.ts [...]
//
// CONTAINMENT MODEL (layered; what the tool actually does):
//   1. Environment: the child env is constructed explicitly, nothing is inherited.
//      Both database URLs are synthetic `.invalid` hosts. PGHOST/PGPORT/PGPASSFILE/
//      PGSERVICEFILE are forced to values that send ordinary libpq/pg defaults into
//      the isolated TCP namespace (additional containment, NOT identity proof).
//   2. Namespaces: `/usr/bin/unshare -rnm --propagation private` = user + network +
//      mount namespaces with PRIVATE mount propagation (re-verified inside: any
//      "shared:" mount => BLOCKED). Only namespace-local loopback is brought up, so
//      TCP and DNS are contained.
//   3. Runtime socket directories: /run (and /var/run only when it is a distinct
//      directory; normally it is a symlink into /run) are masked with empty,
//      namespace-local tmpfs mounts before Vitest starts. Host mounts are not changed.
//   If unshare, the mount setup, propagation check, runtime masking or loopback
//   fails the run is BLOCKED; it never falls back to a weaker (e.g. `-rn`) model.
//
// RESIDUAL, NOT GUARANTEED: arbitrary FILESYSTEM AF_UNIX sockets outside the masked
// runtime directories (for example under /tmp) remain reachable. The evidence says so
// explicitly (arbitraryFilesystemUnixSocketIsolation: NOT_GUARANTEED); a PASS never
// means all IPC was isolated. Abstract-namespace sockets belong to the network
// namespace and are contained.
//
// DEFENSE IN DEPTH (NOT an identity proof): a TypeScript-AST screen runs over the
// BOUNDED, cycle-safe TRANSITIVE closure of repository-local imports (api/tests and
// api/src; never node_modules; generated output and the config/prisma boundary are
// leaves). It works by syntax class: DB drivers/helpers, DB client construction,
// child_process, socket primitives and socketPath, dynamic code generation, loader
// and createRequire indirection, mock registrations that can load the real module
// (vi.mock/vi.doMock unless the factory has zero parameters), and non-literal
// dynamic loading (fail closed). Module specifiers are normalized (query/hash,
// percent-encoding, aliases) before classification.
// DATABASE IDENTITY IS NOT INFERRED OR PROVEN BY THIS TOOL, from source or command
// text or anything else: it remains the job of the existing in-process safety code
// (api/tests/helpers/test-db.ts, api/scripts/demo-database.ts,
// scripts/check-databases.mjs).
//
// Verdicts / exit codes:  PASS 0 | FAIL 1 | DENY (input policy or screening,
// nothing spawned) 2 | BLOCKED (no valid execution could be established) 3.
// Output is one deterministic JSON line.

import { execFile, spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, lstat, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const TOOL = 'safe-nodb-run';
export const REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const UNSHARE_BIN = '/usr/bin/unshare';
export const SH_BIN = '/bin/sh';
export const IP_CANDIDATES = Object.freeze(['/usr/sbin/ip', '/sbin/ip', '/usr/bin/ip', '/bin/ip']);
export const CONFIG_REL = 'api/vitest.nodb.config.mjs';
export const VITEST_REL = 'api/node_modules/vitest/vitest.mjs';
export const TIMEOUT_MS = 30 * 60 * 1000;

// Mirrors api/tests/helpers/test-runtime-env.ts (a test asserts they match) plus
// unresolvable database URLs required only by the NODE_ENV=test env schema.
export const SYNTHETIC_ENV = Object.freeze({
  JWT_SECRET: 'synthetic-test-jwt-secret-not-for-real-auth-d5fa-deterministic',
  JWT_ACCESS_TTL_SECONDS: '900',
  CORS_ORIGINS: 'http://localhost:5173,http://localhost:3000',
  DATABASE_URL: 'postgresql://tests:never-dev@database-url-disabled-in-tests.invalid:5432/postgres',
  TEST_DATABASE_URL: 'postgresql://hosted-test-disabled:unused@hosted-test-disabled-in-ci.invalid:5432/postgres',
});

// Additional containment, NOT database identity proof: ordinary libpq/pg defaults (PGHOST etc.)
// are forced to the isolated TCP namespace (nothing listens there) so a default connection never
// resolves to a filesystem socket. Caller PG* values are never copied; the service/password files
// are neutralized so HOME-relative lookups cannot pick anything up either.
export const PG_CONTAINMENT_ENV = Object.freeze({
  PGHOST: '127.0.0.1',
  PGPORT: '1',
  PGPASSFILE: '/dev/null',
  PGSERVICEFILE: '/dev/null',
});
export const MOUNT_CANDIDATES = Object.freeze(['/usr/bin/mount', '/bin/mount']);
export const ISOLATION_MODEL = 'unshare -rnm --propagation private (user+net+mount namespaces); loopback only; runtime dirs masked by tmpfs';

// Executed by /bin/sh INSIDE the new user+net+mount namespace (unshare already made mount
// propagation private; we re-verify it). Order: verify no mount is still "shared", bring
// loopback up, mask every runtime directory with an empty namespace-local tmpfs, drop the
// marker, exec the real command. Sentinel exits (95 propagation, 96 mask, 97 loopback, 98
// marker) let the caller tell "isolation failed" from "Vitest failed". The marker exists
// ONLY when every step succeeded. Args: ip mount marker N dir1..dirN command...
const WRAPPER_SCRIPT = [
  'ip="$1"; mnt="$2"; marker="$3"; n="$4"; shift 4',
  'grep -q " shared:" /proc/self/mountinfo; rc=$?; [ "$rc" -eq 1 ] || exit 95',
  '"$ip" link set lo up || exit 97',
  'i=0',
  'while [ "$i" -lt "$n" ]; do "$mnt" -t tmpfs -o mode=0755,nosuid,nodev,noexec,size=1m tmpfs "$1" || exit 96; shift; i=$((i + 1)); done',
  ': > "$marker" || exit 98',
  'exec "$@"',
].join('\n');

// Untrusted values reach the evidence only through safeText: String() can throw
// (null-prototype objects, throwing toString/toPrimitive), so it is guarded, and
// the result is length-bounded so evidence cannot grow with attacker input.
function safeText(value, max = 200) {
  let text;
  try {
    text = typeof value === 'string' ? value : String(value);
  } catch {
    text = '<unprintable>';
  }
  return text.length > max ? `${text.slice(0, max)}...(${text.length} chars)` : text;
}

function safeRequested(paths) {
  try {
    if (!Array.isArray(paths)) return [];
    const out = [];
    for (let i = 0; i < paths.length; i += 1) out.push(safeText(paths[i], 500));
    return out;
  } catch {
    return [];
  }
}

const byCodeThenDetail = (a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : a.detail < b.detail ? -1 : a.detail > b.detail ? 1 : 0);
const uniqueSorted = (items) => [...new Set(items)].sort();

// ------------------------------------------------------------ input policy

const GLOB_CHARS = /[*?[\]{}()!]/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function pathProblem(p) {
  if (typeof p !== 'string') return 'NOT_A_STRING';
  if (p === '' || p !== p.trim()) return 'BAD_WHITESPACE';
  if (CONTROL_CHARS.test(p)) return 'CONTROL_CHARACTER';
  if (p.startsWith('-')) return 'OPTION_LIKE_ARGUMENT';
  if (p.startsWith('/')) return 'ABSOLUTE_PATH';
  if (p.includes('\\')) return 'BACKSLASH';
  if (GLOB_CHARS.test(p)) return 'GLOB_SYNTAX';
  for (const segment of p.split('/')) {
    if (segment === '') return 'EMPTY_SEGMENT';
    if (segment === '.') return 'DOT_SEGMENT';
    if (segment === '..') return 'PARENT_SEGMENT';
  }
  if (!p.startsWith('api/tests/')) return 'OUTSIDE_API_TESTS';
  if (!p.endsWith('.test.ts')) return 'NOT_A_TEST_FILE';
  return null;
}

// Pure string-level policy: nothing here touches the filesystem.
export function validateTestPathStrings(paths) {
  if (!Array.isArray(paths)) return { ok: false, errors: [{ code: 'INVALID_TEST_LIST', detail: 'expected a list of paths' }], validated: [] };
  if (paths.length === 0) return { ok: false, errors: [{ code: 'EMPTY_TEST_LIST', detail: 'at least one explicit test path is required' }], validated: [] };
  const errors = [];
  const good = [];
  for (const p of paths) {
    const problem = pathProblem(p);
    if (problem) errors.push({ code: problem, detail: JSON.stringify(safeText(p)) });
    else good.push(p);
  }
  errors.sort(byCodeThenDetail);
  return { ok: errors.length === 0, errors, validated: uniqueSorted(good) };
}

function scrubbedGitEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith('GIT_')) env[key] = value;
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}

function git(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('git', ['--no-optional-locks', ...args], { cwd, env: scrubbedGitEnv(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

async function gitTracked(repoRoot, rels) {
  const out = await git(['--literal-pathspecs', 'ls-files', '-z', '--cached', '--', ...rels], repoRoot);
  return new Set(out.split('\0').filter(Boolean));
}

async function gitHead(repoRoot) {
  try {
    return (await git(['rev-parse', 'HEAD'], repoRoot)).trim() || null;
  } catch {
    return null;
  }
}

// Filesystem-level policy: tracked, a regular file, and not reached through a symlink.
async function validateFiles(rels, repoRoot, tracked) {
  const errors = [];
  const realRoot = await realpath(repoRoot);
  for (const rel of rels) {
    const abs = path.join(repoRoot, rel);
    if (!tracked.has(rel)) errors.push({ code: 'NOT_TRACKED', detail: rel });
    let regular = false;
    try {
      regular = (await lstat(abs)).isFile();
    } catch {
      regular = false;
    }
    if (!regular) {
      errors.push({ code: 'NOT_REGULAR_FILE', detail: rel });
      continue;
    }
    try {
      if ((await realpath(abs)) !== path.join(realRoot, rel)) errors.push({ code: 'PATH_THROUGH_SYMLINK', detail: rel });
    } catch {
      errors.push({ code: 'NOT_REGULAR_FILE', detail: rel });
    }
  }
  return errors.sort(byCodeThenDetail);
}

// ------------------------------------------------------- static AST screening
//
// DEFENSE IN DEPTH ONLY. It never proves database identity and it is not complete
// socket containment; it layers with the sanitized env, the PG* defaults, the
// TCP/DNS namespace and the /run mount mask. It works by SYNTAX CLASS on the
// TypeScript AST, over the bounded transitive closure of repository-local
// imports starting at each requested test.

const DB_HELPER_RESOLVED = new Set([
  'api/tests/helpers/test-db',
  'api/tests/helpers/factories',
  'api/tests/helpers/factory-cleanup',
  'api/tests/helpers/pool-attribution',
  'api/tests/globalSetup',
  'api/tests/setup',
  'api/scripts/demo-database',
]);
const DB_HELPER_PREFIXES = ['api/tests/r4-real-db/', 'api/tests/r4-reset/'];
// Constructs a client on import without connecting; WARN and NOT traversed (the closure
// would otherwise always find its pg import and `new PrismaClient`).
const WARN_RESOLVED = new Set(['api/src/config/prisma']);
const GENERATED_PREFIX = 'api/src/generated/';
const DB_HELPER_IDENTIFIERS = new Set(['createTestPrismaClient', 'openSeedDatabase', 'openProvenTestPool']);
const CLIENT_CONSTRUCTORS = new Set(['Pool', 'Client', 'PrismaClient', 'PrismaPg']);
const DB_ENV_NAME = /(?:DATABASE|DIRECT)_URL/;
// node:net exports used by repository code that are pure functions (rateLimit.ts uses isIP).
const PURE_NET_BINDINGS = new Set(['isIP', 'isIPv4', 'isIPv6']);
// Module-loading entry points of the test runner; reached by NAME so aliasing the receiver does not help.
const LOADER_NAMES = new Set(['importActual', 'doImportActual', 'importMock', 'doImportMock', 'requireActual', 'requireMock']);
const MOCK_NAMES = new Set(['mock', 'doMock']);
// Receivers that make `.mock`/`.doMock` a mock REGISTRATION (not spy bookkeeping such as fn.mock.calls).
// Local aliases of these (const v = vi; import { vi as v }; const { ...rest } = vi) are tracked per file.
const MOCK_RECEIVERS = new Set(['vi', 'vitest', 'jest']);
const TEST_API_MODULES = /^(?:vitest(?:\/.*)?|@jest\/globals)$/;
const TIMER_NAMES = new Set(['setTimeout', 'setInterval', 'setImmediate']);
const UNIX_SOCKET_LITERAL = /(?:^|[^\w])\/(?:var\/)?run\/|\.sock(?:et)?\b|\.s\.PGSQL\.|^unix:/i;
const CODE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];
export const MAX_SCREEN_FILES = 2000;

function isDriverSpecifier(spec) {
  return spec === 'pg' || spec.startsWith('pg/') || /^pg-[a-z0-9-]+$/.test(spec) || spec === '@prisma/adapter-pg' || spec === 'postgres' || spec.startsWith('postgres/');
}

// Normalize BEFORE classifying: strip query/hash suffixes, percent-decode relative
// specifiers, and refuse anything that cannot be classified statically.
function normalizeSpecifier(raw) {
  if (typeof raw !== 'string' || raw === '') return { kind: 'unanalyzable', value: String(raw) };
  if (raw.startsWith('#') || raw.startsWith('/') || /^(?:file|data|https?|blob|ftp|ws|wss):/i.test(raw)) return { kind: 'unanalyzable', value: raw };
  const cut = raw.search(/[?#]/);
  let value = cut === -1 ? raw : raw.slice(0, cut);
  if (value.startsWith('.') || value.startsWith('@/')) {
    try {
      value = decodeURIComponent(value);
    } catch {
      return { kind: 'unanalyzable', value: raw };
    }
    return { kind: 'local', value };
  }
  return { kind: 'bare', value };
}

// Repo-relative posix target of a local specifier imported from `file` (extension kept).
function localTarget(raw, file) {
  const n = normalizeSpecifier(raw);
  if (n.kind !== 'local') return null;
  const joined = n.value.startsWith('@/') ? path.posix.join('api/src', n.value.slice(2)) : path.posix.join(path.posix.dirname(file), n.value);
  return path.posix.normalize(joined);
}

const stripExt = (target) => target.replace(/\.(?:[mc]?[jt]s|[jt]sx)$/, '');

function isBoundary(target) {
  const key = stripExt(target);
  return DB_HELPER_RESOLVED.has(key) || DB_HELPER_PREFIXES.some((x) => key.startsWith(x)) || WARN_RESOLVED.has(key);
}

// `names`: the bindings an import brings in (['*'] for namespace/default/dynamic/side-effect).
function classifySpecifier(raw, names, file, report) {
  const n = normalizeSpecifier(raw);
  if (n.kind === 'unanalyzable') return report('deny', 'UNANALYZABLE_SPECIFIER', safeText(raw, 80));
  if (n.kind === 'bare') {
    const b = n.value.replace(/^node:/, '');
    if (isDriverSpecifier(b)) return report('deny', 'DB_DRIVER_IMPORT', n.value);
    if (b === 'child_process') return report('deny', 'CHILD_PROCESS_IMPORT', n.value);
    if (b === 'net') return names.every((x) => PURE_NET_BINDINGS.has(x)) ? undefined : report('deny', 'SOCKET_PRIMITIVE_IMPORT', n.value);
    if (b === 'tls') return report('deny', 'SOCKET_PRIMITIVE_IMPORT', n.value);
    if (b === 'vm') return report('deny', 'DYNAMIC_CODE_IMPORT', n.value);
    if (b === 'module') return report('deny', 'LOADER_MODULE_IMPORT', n.value);
    return undefined;
  }
  const resolved = stripExt(localTarget(raw, file));
  if (DB_HELPER_RESOLVED.has(resolved) || DB_HELPER_PREFIXES.some((x) => resolved.startsWith(x))) return report('deny', 'DB_HELPER_IMPORT', resolved);
  if (WARN_RESOLVED.has(resolved)) return report('warn', 'PRISMA_CONFIG_IMPORT', resolved);
  return undefined;
}

export function screenSource({ ts, text, file }) {
  const denies = [];
  const warnings = [];
  const imports = [];

  const syntactic = ts.transpileModule(text, {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  }).diagnostics;
  if (syntactic && syntactic.length > 0) {
    return { denies: [{ code: 'UNPARSABLE', detail: 'file has syntax errors and cannot be screened', line: 1 }], warnings: [], imports: [] };
  }

  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const K = ts.SyntaxKind;
  const lineOf = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const seen = new Set();
  const add = (list, code, detail, node) => {
    const line = lineOf(node);
    const key = `${code}|${detail}|${line}`;
    if (seen.has(key)) return;
    seen.add(key);
    list.push({ code, detail, line });
  };
  const reportAt = (node) => (kind, code, detail) => add(kind === 'deny' ? denies : warnings, code, detail, node);
  const isLiteral = (n) => n && (n.kind === K.StringLiteral || n.kind === K.NoSubstitutionTemplateLiteral);
  const isStringish = (n) => isLiteral(n) || (n && n.kind === K.TemplateExpression);
  const isFunctionLike = (n) => n && (n.kind === K.ArrowFunction || n.kind === K.FunctionExpression);
  const handled = new WeakSet(); // loader-name nodes already examined at a call site

  // ---- syntax helpers for the mock-access class -------------------------------------------------
  const isWrapper = (n) =>
    n.kind === K.ParenthesizedExpression || n.kind === K.AsExpression || n.kind === K.NonNullExpression || n.kind === K.TypeAssertionExpression || n.kind === K.SatisfiesExpression;
  const unwrap = (n) => {
    let cur = n;
    while (cur && isWrapper(cur)) cur = cur.expression;
    return cur;
  };
  // true when `node` (through any wrapper parents) is exactly the callee of a call
  const isDirectCallee = (node) => {
    let cur = node;
    while (cur.parent && isWrapper(cur.parent)) cur = cur.parent;
    return Boolean(cur.parent && cur.parent.kind === K.CallExpression && cur.parent.expression === cur);
  };

  // Per-file receiver aliases and trusted `const` string bindings, gathered BEFORE the main walk.
  const receivers = new Set(MOCK_RECEIVERS);
  const constants = new Map(); // name -> initializer node, or null when the name is declared/assigned more than once
  const aliasEdges = [];
  const noteConstant = (name, init) => constants.set(name, constants.has(name) ? null : init);
  const isMockReceiver = (expr) => {
    const e = unwrap(expr);
    if (!e) return false;
    if (e.kind === K.Identifier) return receivers.has(e.text);
    if (e.kind === K.PropertyAccessExpression) return MOCK_RECEIVERS.has(e.name.text); // V.vi, globalThis.vi
    return false;
  };
  const collect = (node) => {
    if (node.kind === K.ImportDeclaration && node.importClause && isLiteral(node.moduleSpecifier) && TEST_API_MODULES.test(node.moduleSpecifier.text)) {
      const nb = node.importClause.namedBindings;
      if (nb && nb.kind === K.NamedImports) {
        for (const el of nb.elements) if (MOCK_RECEIVERS.has((el.propertyName || el.name).text)) receivers.add(el.name.text);
      }
    } else if (node.kind === K.VariableDeclaration && node.initializer) {
      const list = node.parent;
      const isConst = list && list.kind === K.VariableDeclarationList && (list.flags & ts.NodeFlags.Const) !== 0;
      if (node.name.kind === K.Identifier) {
        if (isConst) noteConstant(node.name.text, node.initializer);
        else constants.set(node.name.text, null);
        aliasEdges.push([node.name.text, node.initializer]);
      } else if (node.name.kind === K.ObjectBindingPattern) {
        for (const el of node.name.elements) {
          if (el.dotDotDotToken && el.name.kind === K.Identifier) aliasEdges.push([el.name.text, node.initializer]);
        }
      }
    } else if (node.kind === K.BinaryExpression && node.operatorToken.kind === K.EqualsToken && node.left.kind === K.Identifier) {
      constants.set(node.left.text, null);
      aliasEdges.push([node.left.text, node.right]);
    }
    ts.forEachChild(node, collect);
  };
  collect(sf);
  for (let changed = true; changed; ) {
    changed = false;
    for (const [name, init] of aliasEdges) {
      if (!receivers.has(name) && isMockReceiver(init)) {
        receivers.add(name);
        changed = true;
      }
    }
  }

  // Small, bounded, deterministic static-string evaluator (literals, +, template spans, `const` names).
  // It never executes code; anything else is unresolvable (null).
  const evalStatic = (n, depth = 0) => {
    const e = unwrap(n);
    if (!e || depth > 8) return null;
    if (isLiteral(e)) return e.text;
    if (e.kind === K.TemplateExpression) {
      let out = e.head.text;
      for (const span of e.templateSpans) {
        const v = evalStatic(span.expression, depth + 1);
        if (v === null) return null;
        out += v + span.literal.text;
      }
      return out;
    }
    if (e.kind === K.BinaryExpression && e.operatorToken.kind === K.PlusToken) {
      const l = evalStatic(e.left, depth + 1);
      const r = l === null ? null : evalStatic(e.right, depth + 1);
      return l === null || r === null ? null : l + r;
    }
    if (e.kind === K.Identifier) {
      const init = constants.get(e.text);
      return init ? evalStatic(init, depth + 1) : null;
    }
    return null;
  };

  const useSpecifier = (node, raw, names) => {
    classifySpecifier(raw, names, file, reportAt(node));
    imports.push({ spec: raw, line: lineOf(node) });
  };
  const namesOfImport = (node) => {
    const c = node.importClause;
    if (!c) return ['*'];
    const out = [];
    if (c.name) out.push('default');
    if (c.namedBindings) {
      if (c.namedBindings.kind === K.NamespaceImport) out.push('*');
      else for (const el of c.namedBindings.elements) out.push((el.propertyName || el.name).text);
    }
    return out.length > 0 ? out : ['*'];
  };
  const namesOfExport = (node) =>
    !node.exportClause || node.exportClause.kind === K.NamespaceExport ? ['*'] : node.exportClause.elements.map((el) => (el.propertyName || el.name).text);

  // import()/require()/<loader>(...): the first argument is the module specifier.
  const loaderCall = (node, label) => {
    const first = node.arguments[0];
    if (isLiteral(first)) useSpecifier(node, first.text, ['*']);
    else add(denies, 'NON_LITERAL_IMPORT', `${label}(<non-literal>)`, node);
  };
  // vi.mock/vi.doMock(spec, ...) is a MODULE-LOAD EDGE whenever Vitest can load the real module:
  // automock (no factory, `undefined`, or an options object such as { spy: true }) and any factory
  // that could receive `importOriginal` (>= 1 parameter, or an expression whose arity is unknown).
  // The ONLY non-edge is a function-like factory with ZERO parameters. An edge goes through the
  // same normalized classification and local closure as a real import; a non-literal specifier
  // on an edge cannot be analyzed and is DENY.
  const mockCall = (node) => {
    const first = node.arguments[0];
    const factory = node.arguments[1];
    if (isFunctionLike(factory) && factory.parameters.length === 0) return;
    if (first && first.kind === K.CallExpression && first.expression.kind === K.ImportKeyword) return; // typed vi.mock(import('x')): classified through the import() call itself
    if (isLiteral(first)) useSpecifier(node, first.text, ['*']);
    else add(denies, 'NON_LITERAL_IMPORT', 'mock(<non-literal>)', node);
  };

  const visit = (node) => {
    let skipChildren = false;
    const parent = node.parent;
    if (node.kind === K.ImportDeclaration) {
      if (node.importClause && node.importClause.isTypeOnly) skipChildren = true;
      else if (isLiteral(node.moduleSpecifier)) useSpecifier(node, node.moduleSpecifier.text, namesOfImport(node));
    } else if (node.kind === K.ExportDeclaration && node.moduleSpecifier) {
      if (node.isTypeOnly) skipChildren = true;
      else if (isLiteral(node.moduleSpecifier)) useSpecifier(node, node.moduleSpecifier.text, namesOfExport(node));
    } else if (node.kind === K.ImportEqualsDeclaration && node.moduleReference.kind === K.ExternalModuleReference) {
      if (node.isTypeOnly) skipChildren = true;
      else if (isLiteral(node.moduleReference.expression)) useSpecifier(node, node.moduleReference.expression.text, ['*']);
      else add(denies, 'NON_LITERAL_IMPORT', 'import = require(<non-literal>)', node);
    } else if (node.kind === K.CallExpression) {
      const callee = unwrap(node.expression);
      const first = node.arguments[0];
      if (callee.kind === K.ImportKeyword) {
        loaderCall(node, 'import');
      } else if (callee.kind === K.Identifier) {
        if (callee.text === 'require') loaderCall(node, 'require');
        else if (LOADER_NAMES.has(callee.text)) {
          handled.add(callee);
          loaderCall(node, callee.text);
        } else if (MOCK_NAMES.has(callee.text)) mockCall(node);
        else if (TIMER_NAMES.has(callee.text) && isStringish(first)) add(denies, 'DYNAMIC_CODE', `${callee.text}(<string>)`, node);
      } else if (callee.kind === K.PropertyAccessExpression) {
        const name = callee.name.text;
        if (LOADER_NAMES.has(name)) {
          handled.add(callee.name);
          loaderCall(node, name);
        } else if (MOCK_NAMES.has(name)) mockCall(node);
        else if (name === 'constructor') add(denies, 'DYNAMIC_CODE', '<expr>.constructor(...)', node);
        else if (TIMER_NAMES.has(name) && isStringish(first)) add(denies, 'DYNAMIC_CODE', `${name}(<string>)`, node);
      } else if (callee.kind === K.ElementAccessExpression) {
        // statically resolvable names (literal, concatenation, template, const binding) behave like `.name`;
        // an unresolvable computed name on a mock receiver is flagged by the ElementAccess visit below
        const name = evalStatic(callee.argumentExpression);
        if (name !== null && LOADER_NAMES.has(name)) {
          handled.add(callee.argumentExpression);
          loaderCall(node, name);
        } else if (name !== null && MOCK_NAMES.has(name)) mockCall(node);
      }
    } else if (node.kind === K.NewExpression) {
      const callee = node.expression;
      const name = callee.kind === K.Identifier ? callee.text : callee.kind === K.PropertyAccessExpression ? callee.name.text : null;
      if (name && CLIENT_CONSTRUCTORS.has(name)) add(denies, 'DB_CLIENT_CONSTRUCTION', `new ${name}(...)`, node);
    } else if (node.kind === K.PropertyAccessExpression) {
      if (node.expression.kind === K.MetaProperty && (node.name.text === 'glob' || node.name.text === 'globEager')) {
        add(denies, 'NON_LITERAL_IMPORT', `import.meta.${node.name.text}(...)`, node);
      }
      // `const m = vi.mock;` / `vi.mock.bind(vi)` / `const f = alias.doMock;` hides the registration from call-site analysis.
      if (MOCK_NAMES.has(node.name.text) && isMockReceiver(node.expression) && !isDirectCallee(node)) {
        add(denies, 'INDIRECT_MOCK', `${node.name.text} of a mock receiver used other than as a direct call`, node);
      }
    } else if (node.kind === K.ElementAccessExpression) {
      // Same class through brackets: vi['mock'], vi[`doMock`], vi['do' + 'Mock'], vi[k]. A name that cannot be
      // resolved statically on a mock receiver can hold ANY member (including mock/doMock): fail closed.
      if (isMockReceiver(node.expression)) {
        const name = evalStatic(node.argumentExpression);
        if (name === null) add(denies, 'INDIRECT_MOCK', 'computed property of a mock receiver cannot be resolved statically', node);
        else if (MOCK_NAMES.has(name) && !isDirectCallee(node)) add(denies, 'INDIRECT_MOCK', `${name} of a mock receiver used other than as a direct call`, node);
      }
    } else if (node.kind === K.BindingElement) {
      // `const { doMock } = vi;` / `const { mock: reg } = vitest;` / `const { [k]: reg } = vi;`
      const pattern = parent;
      const decl = pattern && pattern.parent;
      const source = decl && decl.kind === K.VariableDeclaration ? decl.initializer : null;
      if (pattern && pattern.kind === K.ObjectBindingPattern && source && isMockReceiver(source) && !node.dotDotDotToken) {
        const key = node.propertyName ? (node.propertyName.kind === K.ComputedPropertyName ? evalStatic(node.propertyName.expression) : node.propertyName.text) : node.name.text;
        if (key === null) add(denies, 'INDIRECT_MOCK', 'computed destructuring key from a mock receiver cannot be resolved statically', node);
        else if (MOCK_NAMES.has(key)) add(denies, 'INDIRECT_MOCK', `${key} destructured from a mock receiver`, node);
      }
    } else if (node.kind === K.Identifier) {
      const t = node.text;
      const isMember = parent && parent.kind === K.PropertyAccessExpression && parent.name === node;
      const isDeclName =
        parent && (parent.kind === K.VariableDeclaration || parent.kind === K.Parameter || parent.kind === K.BindingElement) && parent.name === node;
      if (DB_HELPER_IDENTIFIERS.has(t)) add(denies, 'DB_HELPER_IDENTIFIER', t, node);
      if (DB_ENV_NAME.test(t)) add(warnings, 'DB_ENV_NAME_REFERENCE', t, node);
      if (t === 'createRequire') add(denies, 'INDIRECT_REQUIRE', 'createRequire hides module specifiers', node);
      if (t === 'socketPath') add(denies, 'SOCKET_PATH_USE', 'socketPath', node);
      if (t === 'eval') add(denies, 'DYNAMIC_CODE', 'eval', node);
      if (t === 'Function' && parent && (((parent.kind === K.CallExpression || parent.kind === K.NewExpression) && parent.expression === node) || isMember)) {
        add(denies, 'DYNAMIC_CODE', 'Function constructor', node);
      }
      if (LOADER_NAMES.has(t) && !handled.has(node)) add(denies, 'INDIRECT_LOADER', `${t} used other than as a direct call`, node);
      if (t === 'require') {
        const isCallee = parent && parent.kind === K.CallExpression && parent.expression === node;
        const isPropName = parent && parent.kind === K.PropertyAssignment && parent.name === node;
        if (!isCallee && !isMember && !isDeclName && !isPropName) add(denies, 'INDIRECT_REQUIRE', 'require used other than as a direct call', node);
      }
    } else if (node.kind === K.StringLiteral || node.kind === K.NoSubstitutionTemplateLiteral) {
      const isSpecifier = parent && (parent.kind === K.ImportDeclaration || parent.kind === K.ExportDeclaration) && parent.moduleSpecifier === node;
      if (!isSpecifier) {
        const t = node.text;
        if (DB_ENV_NAME.test(t)) add(warnings, 'DB_ENV_NAME_REFERENCE', DB_ENV_NAME.exec(t)[0], node);
        if (t === 'socketPath') add(denies, 'SOCKET_PATH_USE', 'socketPath', node);
        if (t === 'createRequire') add(denies, 'INDIRECT_REQUIRE', 'createRequire hides module specifiers', node);
        if (LOADER_NAMES.has(t) && !handled.has(node)) add(denies, 'INDIRECT_LOADER', `${t} used other than as a direct call`, node);
        if (UNIX_SOCKET_LITERAL.test(t)) add(warnings, 'UNIX_SOCKET_PATH_LITERAL', 'unix-socket-like path literal', node);
      }
    } else if (node.kind === K.TemplateHead || node.kind === K.TemplateMiddle || node.kind === K.TemplateTail) {
      if (DB_ENV_NAME.test(node.text)) add(warnings, 'DB_ENV_NAME_REFERENCE', DB_ENV_NAME.exec(node.text)[0], node);
      if (UNIX_SOCKET_LITERAL.test(node.text)) add(warnings, 'UNIX_SOCKET_PATH_LITERAL', 'unix-socket-like path literal', node);
    }
    if (!skipChildren) ts.forEachChild(node, visit);
  };
  visit(sf);

  const order = (a, b) => a.line - b.line || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
  return { denies: denies.sort(order), warnings: warnings.sort(order), imports: imports.sort((a, b) => a.line - b.line || (a.spec < b.spec ? -1 : a.spec > b.spec ? 1 : 0)) };
}

// Resolve a repo-relative local target to a regular, non-symlinked file. Never follows
// a symlink (the file or any parent directory). Returns { rel, analyze } or null.
async function resolveLocalFile(target, { repoRoot, realRoot, lstat: lstatFn, realpath: realpathFn }) {
  if (target.startsWith('..') || target.startsWith('/')) return null;
  const ext = path.posix.extname(target);
  const candidates = [];
  if (CODE_EXTS.includes(ext)) {
    candidates.push(target);
    const stem = target.slice(0, -ext.length);
    if (ext === '.js') candidates.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.jsx`);
    if (ext === '.mjs') candidates.push(`${stem}.mts`);
    if (ext === '.cjs') candidates.push(`${stem}.cts`);
  } else {
    if (ext !== '') candidates.push(target);
    for (const e of CODE_EXTS) candidates.push(`${target}${e}`);
    for (const e of CODE_EXTS) candidates.push(`${target}/index${e}`);
  }
  for (const rel of candidates) {
    const abs = path.join(repoRoot, rel);
    try {
      if (!(await lstatFn(abs)).isFile()) continue;
      if ((await realpathFn(abs)) !== path.join(realRoot, rel)) continue;
    } catch {
      continue;
    }
    return { rel, analyze: CODE_EXTS.includes(path.posix.extname(rel)) };
  }
  return null;
}

// Bounded, deterministic, cycle-safe transitive closure over repository-local imports.
export async function screenClosure({ ts, repoRoot, entries, readFile: readFn = readFile, lstat: lstatFn = lstat, realpath: realpathFn = realpath, maxFiles = MAX_SCREEN_FILES }) {
  const realRoot = await realpathFn(repoRoot);
  const denies = [];
  const warnings = [];
  const visited = new Map();
  const queue = [];
  const enqueue = (rel, via) => {
    visited.set(rel, via);
    queue.push(rel);
  };
  for (const rel of [...entries].sort()) enqueue(rel, rel);
  let truncated = false;
  for (let i = 0; i < queue.length && !truncated; i += 1) {
    const rel = queue[i];
    const via = visited.get(rel);
    const found = screenSource({ ts, text: await readFn(path.join(repoRoot, rel), 'utf8'), file: rel });
    for (const d of found.denies) denies.push({ file: rel, via, ...d });
    for (const w of found.warnings) warnings.push({ file: rel, via, ...w });
    for (const imp of found.imports) {
      const target = localTarget(imp.spec, rel);
      if (target === null || isBoundary(target)) continue;
      if (target.startsWith(GENERATED_PREFIX) || target.split('/').includes('node_modules')) continue; // build output / third-party: leaf
      const resolved = await resolveLocalFile(target, { repoRoot, realRoot, lstat: lstatFn, realpath: realpathFn });
      if (resolved === null) {
        denies.push({ file: rel, via, code: 'UNRESOLVED_LOCAL_IMPORT', detail: safeText(imp.spec, 120), line: imp.line });
        continue;
      }
      if (!resolved.analyze || visited.has(resolved.rel)) continue;
      if (visited.size >= maxFiles) {
        denies.push({ file: rel, via, code: 'CLOSURE_TOO_LARGE', detail: `more than ${maxFiles} repository-local files`, line: imp.line });
        truncated = true;
        break;
      }
      enqueue(resolved.rel, via);
    }
  }
  return { denies, warnings, visited: [...visited.keys()].sort() };
}

// Resolve TypeScript ONLY from this repository's own installs (never an ancestor
// directory, never a global); loaded lazily so the module itself needs no deps.
async function defaultLoadTypescript(repoRoot) {
  for (const rel of ['api/node_modules/typescript/lib/typescript.js', 'node_modules/typescript/lib/typescript.js']) {
    const candidate = path.join(repoRoot, rel);
    try {
      await access(candidate, fsConstants.R_OK);
    } catch {
      continue;
    }
    return createRequire(candidate)(candidate);
  }
  throw new Error('typescript is not installed under api/node_modules or node_modules');
}

async function defaultScreen({ repoRoot, files, loadTypescript, maxScreenFiles }) {
  let ts;
  try {
    ts = await loadTypescript(repoRoot);
  } catch (error) {
    const wrapped = new Error(`TypeScript unavailable: ${error && error.message ? error.message : error}`);
    wrapped.blockedCode = 'TYPESCRIPT_UNAVAILABLE';
    throw wrapped;
  }
  return screenClosure({ ts, repoRoot, entries: files, maxFiles: maxScreenFiles });
}

// ----------------------------------------------------------- report parsing

const TEST_COUNT_FIELDS = ['numTotalTests', 'numPassedTests', 'numFailedTests', 'numPendingTests', 'numTodoTests'];
const SUITE_COUNT_FIELDS = ['numTotalTestSuites', 'numPassedTestSuites', 'numFailedTestSuites', 'numPendingTestSuites'];
// Status vocabulary the parser has always accepted for assertions; suites are held to the same set.
// Anything else is unknown evidence and BLOCKS (never silently treated as pass or fail).
const STATUS_PASSED = 'passed';
const STATUS_FAILED = 'failed';
const STATUS_NOT_RUN = new Set(['pending', 'skipped', 'disabled', 'todo']);
const isCount = (n) => Number.isSafeInteger(n) && n >= 0;
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Returns { problem: 'MALFORMED' | 'INCONSISTENT', detail } or { report }. Every field the runner
// relies on is validated BEFORE a verdict can be derived from it.
export function parseVitestReport(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { problem: 'MALFORMED', detail: 'not valid JSON' };
  }
  if (!isPlainObject(raw)) return { problem: 'MALFORMED', detail: 'not a JSON object' };
  for (const f of [...TEST_COUNT_FIELDS, ...SUITE_COUNT_FIELDS]) {
    if (!isCount(raw[f])) return { problem: 'MALFORMED', detail: `${f} is not a finite non-negative integer` };
  }
  if (typeof raw.success !== 'boolean') return { problem: 'MALFORMED', detail: 'success is not a boolean' };
  if (!Array.isArray(raw.testResults)) return { problem: 'MALFORMED', detail: 'testResults is not an array' };

  const per = { passed: 0, failed: 0, pending: 0, todo: 0 };
  let failedFileEntries = 0; // file-level entries marked failed (a file is itself one suite)
  for (const [i, file] of raw.testResults.entries()) {
    if (!isPlainObject(file)) return { problem: 'MALFORMED', detail: `testResults[${i}] is not an object` };
    if (typeof file.name !== 'string' || file.name === '' || !path.isAbsolute(file.name)) {
      return { problem: 'MALFORMED', detail: `testResults[${i}].name is not an absolute file path` };
    }
    if (typeof file.status !== 'string') return { problem: 'MALFORMED', detail: `testResults[${i}].status is not a string` };
    if (!Array.isArray(file.assertionResults)) return { problem: 'MALFORMED', detail: `testResults[${i}].assertionResults is not an array` };
    let filePassed = 0;
    let fileFailed = 0;
    for (const [j, a] of file.assertionResults.entries()) {
      if (!isPlainObject(a) || typeof a.status !== 'string') return { problem: 'MALFORMED', detail: `testResults[${i}].assertionResults[${j}] is not an object with a string status` };
      if (a.status === STATUS_PASSED) {
        per.passed += 1;
        filePassed += 1;
      } else if (a.status === STATUS_FAILED) {
        per.failed += 1;
        fileFailed += 1;
      } else if (a.status === 'todo') per.todo += 1;
      else if (STATUS_NOT_RUN.has(a.status)) per.pending += 1;
      else return { problem: 'INCONSISTENT', detail: 'unknown assertion status' };
    }
    if (file.status === STATUS_PASSED) {
      if (fileFailed > 0) return { problem: 'INCONSISTENT', detail: 'a suite marked passed holds a failed assertion' };
    } else if (file.status === STATUS_FAILED) failedFileEntries += 1;
    else if (STATUS_NOT_RUN.has(file.status)) {
      if (filePassed > 0 || fileFailed > 0) return { problem: 'INCONSISTENT', detail: 'a suite marked not-run holds executed assertions' };
    } else return { problem: 'INCONSISTENT', detail: 'unknown suite status' };
  }

  if (raw.numTotalTests !== raw.numPassedTests + raw.numFailedTests + raw.numPendingTests + raw.numTodoTests) {
    return { problem: 'INCONSISTENT', detail: 'numTotalTests differs from the sum of passed, failed, pending and todo' };
  }
  if (per.passed !== raw.numPassedTests || per.failed !== raw.numFailedTests || per.pending !== raw.numPendingTests || per.todo !== raw.numTodoTests) {
    return { problem: 'INCONSISTENT', detail: 'per-test statuses differ from the aggregate counts' };
  }
  // SUITE counters are Vitest's, not the file list's: a FILE is itself a suite and every nested
  // `describe` is another, so numTotalTestSuites may exceed testResults.length. They are therefore NOT
  // tied to per-file entry counts. Only relationships the pinned reporter model supports are enforced:
  //   * total === passed + failed + pending (suite sub-counts; no component can exceed the total);
  //   * every reported file is a suite, so total >= number of file entries;
  //   * a file entry marked failed is a failed suite, so it must be counted in numFailedTestSuites.
  // File CARDINALITY (each requested file exactly once) is checked separately by the runner.
  if (raw.numTotalTestSuites !== raw.numPassedTestSuites + raw.numFailedTestSuites + raw.numPendingTestSuites) {
    return { problem: 'INCONSISTENT', detail: 'numTotalTestSuites differs from the sum of passed, failed and pending suites' };
  }
  if (raw.numTotalTestSuites < raw.testResults.length) {
    return { problem: 'INCONSISTENT', detail: 'fewer suites counted than reported files (each file is itself a suite)' };
  }
  if (failedFileEntries > raw.numFailedTestSuites) {
    return { problem: 'INCONSISTENT', detail: 'a file entry is marked failed but is not counted among the failed suites' };
  }
  // Any failed suite (a failed file entry OR a failed suite counted anywhere, e.g. a nested describe) is
  // negative evidence: it can never become PASS and it contradicts success:true.
  const suiteFailed = failedFileEntries > 0 || raw.numFailedTestSuites > 0;
  if (raw.success === true && (raw.numFailedTests > 0 || suiteFailed)) {
    return { problem: 'INCONSISTENT', detail: 'success is true although failures are recorded' };
  }
  return {
    report: {
      success: raw.success,
      passed: raw.numPassedTests,
      failed: raw.numFailedTests,
      skipped: raw.numPendingTests,
      todo: raw.numTodoTests,
      total: raw.numTotalTests,
      suiteFailed,
      files: raw.testResults.map((r) => r.name),
    },
  };
}

// ------------------------------------------------------------------- runner

function defaultRun({ command, args, cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    let child;
    let timedOut = false;
    let timer = null;
    try {
      child = spawn(command, args, { cwd, env, stdio: 'ignore', detached: true });
    } catch (error) {
      resolve({ code: null, signal: null, timedOut: false, spawnError: error && error.code ? error.code : 'SPAWN_THROW' });
      return;
    }
    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      resolve({ code: null, signal: null, timedOut: false, spawnError: error && error.code ? error.code : 'SPAWN_ERROR' });
    });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ code, signal, timedOut, spawnError: null });
    });
    timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          // already gone
        }
      }
    }, timeoutMs);
  });
}

async function executable(p) {
  try {
    await access(p, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function isRegularFile(p) {
  try {
    return (await lstat(p)).isFile();
  } catch {
    return false;
  }
}

async function exists(p) {
  try {
    await access(p, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function normalizeName(p) {
  try {
    return await realpath(p);
  } catch {
    return path.resolve(p);
  }
}

const EXIT = { PASS: 0, FAIL: 1, DENY: 2, BLOCKED: 3 };

function buildResult(partial) {
  return {
    tool: TOOL,
    verdict: 'DENY',
    head: null,
    testsRequested: [],
    testsValidated: [],
    warnings: [],
    config: CONFIG_REL,
    tcpDnsIsolation: 'NOT_ATTEMPTED',
    runtimeSocketIsolation: 'NOT_ATTEMPTED',
    maskedRuntimeDirs: [],
    arbitraryFilesystemUnixSocketIsolation: 'NOT_GUARANTEED',
    isolationModel: ISOLATION_MODEL,
    screenedFiles: null,
    command: null,
    processExit: null,
    reporterParsed: false,
    testsExecuted: null,
    testsPassed: null,
    testsFailed: null,
    testsSkipped: null,
    testsTodo: null,
    errors: [],
    ...partial,
  };
}

// ---------------------------------------------------------------------------------------------
// RESULT DECISION PIPELINE. The verdict is selected in this fixed precedence; the evidence is
// validated BEFORE the process/test outcome is interpreted, so a numeric non-zero exit can never
// turn unusable evidence into a test FAIL:
//   1. execution established?      (spawn / timeout / signal / isolation marker / numeric exit)  else BLOCKED
//   2. reporter evidence usable?   (exists -> parses -> structure -> statuses/counters/consistency
//                                   -> exact requested/reported file cardinality)                else BLOCKED
//   3. outcome of USABLE evidence: non-zero exit, failed tests/suites, success:false, zero executed -> FAIL
//   4. otherwise                                                                                  -> PASS
// (Pre-spawn input policy / screening rejection is DENY and never reaches this pipeline.)

// Steps 2a-2e. Independent of the process exit code. Returns { usable, parsed?, problem? }; `parsed`
// is kept even when only the file-set check failed so the evidence can still report counts.
async function assessReporterEvidence({ reportPath, filesAbs }) {
  let text;
  try {
    text = await readFile(reportPath, 'utf8');
  } catch {
    return { usable: false, problem: { code: 'REPORTER_MISSING', detail: 'Vitest did not produce the JSON report' } };
  }
  const attempt = parseVitestReport(text);
  if (!attempt.report) {
    return { usable: false, problem: { code: attempt.problem === 'INCONSISTENT' ? 'REPORTER_INCONSISTENT' : 'REPORTER_MALFORMED', detail: attempt.detail } };
  }
  const parsed = attempt.report;
  // Cardinality (multiset): every requested file is reported EXACTLY once. Names are normalized first so a
  // differently-spelled duplicate collapses to the same file; the reported list is never de-duplicated first.
  const expectedNames = uniqueSorted(await Promise.all(filesAbs.map(normalizeName)));
  const reportedList = await Promise.all(parsed.files.map(normalizeName));
  const occurrences = new Map();
  for (const name of reportedList) occurrences.set(name, (occurrences.get(name) || 0) + 1);
  const duplicated = [...occurrences.values()].filter((n) => n > 1).length;
  if (duplicated > 0) {
    return {
      usable: false,
      parsed,
      problem: { code: 'REPORT_DUPLICATE_FILE', detail: `${duplicated} file(s) reported more than once (${reportedList.length} entries for ${expectedNames.length} requested)` },
    };
  }
  if (JSON.stringify(expectedNames) !== JSON.stringify([...reportedList].sort())) {
    return { usable: false, parsed, problem: { code: 'REPORT_FILE_SET_MISMATCH', detail: `validated ${expectedNames.length} file(s), report names ${reportedList.length}` } };
  }
  return { usable: true, parsed };
}

// Step 3-4, only ever called with USABLE evidence and a numeric exit status.
function classifyOutcome(exitCode, parsed) {
  const reportFailures = [];
  if (parsed.suiteFailed) reportFailures.push({ code: 'SUITE_FAILED', detail: 'a test suite failed to run' });
  if (parsed.failed > 0) reportFailures.push({ code: 'TESTS_FAILED', detail: `${parsed.failed} failed` });
  if (!parsed.success && reportFailures.length === 0) reportFailures.push({ code: 'REPORT_NOT_SUCCESS', detail: 'the report says success=false' });
  if (reportFailures.length === 0 && parsed.passed + parsed.failed === 0) {
    reportFailures.push({ code: 'NO_TESTS_EXECUTED', detail: 'no test was executed (zero, or all skipped/todo)' });
  }
  const errors = exitCode === 0 ? reportFailures : [{ code: 'VITEST_EXIT_NONZERO', detail: `exit ${exitCode}` }, ...reportFailures];
  return { verdict: errors.length > 0 ? 'FAIL' : 'PASS', errors };
}

// Directories whose host sockets must be hidden: /run, plus /var/run only when it is a
// DISTINCT directory (it is normally a symlink into /run, which the /run mask already covers).
export async function computeMaskDirs({ realpath: realpathFn = realpath, lstat: lstatFn = lstat } = {}) {
  const dirs = [];
  let runReal = null;
  try {
    if ((await lstatFn('/run')).isDirectory()) {
      dirs.push('/run');
      runReal = await realpathFn('/run');
    }
  } catch {
    // /run absent: nothing to mask there
  }
  try {
    await lstatFn('/var/run');
    const varReal = await realpathFn('/var/run');
    if (varReal !== runReal && (await lstatFn(varReal)).isDirectory()) dirs.push('/var/run');
  } catch {
    // /var/run absent
  }
  return dirs;
}

async function runSafeNodbUnguarded({ paths, repoRoot = REPO_ROOT, deps = {} } = {}) {
  const {
    run = defaultRun,
    screen = defaultScreen,
    loadTypescript = defaultLoadTypescript,
    unshareBin = UNSHARE_BIN,
    ipCandidates = IP_CANDIDATES,
    mountCandidates = MOUNT_CANDIDATES,
    runtimeMaskDirs,
    fsOps = {},
    maxScreenFiles = MAX_SCREEN_FILES,
    timeoutMs = TIMEOUT_MS,
  } = deps;
  const maskFs = { realpath: fsOps.realpath || realpath, lstat: fsOps.lstat || lstat };

  const requested = safeRequested(paths);
  const head = await gitHead(repoRoot);
  const finish = (verdict, partial) => {
    const result = buildResult({ verdict, head, testsRequested: requested, ...partial });
    result.errors = [...result.errors].sort(byCodeThenDetail);
    return { exitCode: EXIT[verdict], result };
  };

  // 1. input policy (strings only; nothing touches the filesystem)
  const policy = validateTestPathStrings(paths);
  if (!policy.ok) return finish('DENY', { errors: policy.errors });
  const files = policy.validated;

  // 2. tracked + regular + no symlink traversal
  let tracked;
  try {
    tracked = await gitTracked(repoRoot, files);
  } catch (error) {
    return finish('BLOCKED', { testsValidated: files, errors: [{ code: 'GIT_UNAVAILABLE', detail: `git ls-files failed (${error && error.code ? error.code : 'error'})` }] });
  }
  const fileProblems = await validateFiles(files, repoRoot, tracked);
  if (fileProblems.length > 0) return finish('DENY', { testsValidated: files, errors: fileProblems });

  // 3. defense-in-depth AST screen (BLOCKED when it cannot run)
  let screening;
  try {
    screening = await screen({ repoRoot, files, loadTypescript, maxScreenFiles });
    if (!screening || !Array.isArray(screening.denies) || !Array.isArray(screening.warnings)) throw new Error('screening returned no result');
  } catch (error) {
    return finish('BLOCKED', {
      testsValidated: files,
      errors: [{ code: (error && error.blockedCode) || 'SCREENING_FAILED', detail: error && error.message ? error.message : 'screening failed' }],
    });
  }
  const warnings = [...screening.warnings].sort(
    (a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) || a.line - b.line || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0),
  );
  if (screening.denies.length > 0) {
    return finish('DENY', {
      testsValidated: files,
      warnings,
      screenedFiles: screening.visited ? screening.visited.length : null,
      errors: screening.denies.map((d) => ({ code: 'SCREEN_DENY', detail: safeText(`${d.file}:${d.line} ${d.code} ${d.detail}`, 400) })),
    });
  }

  // 4. containment prerequisites: all must exist, no fallback exists
  const apiDir = path.join(repoRoot, 'api');
  const configAbs = path.join(repoRoot, CONFIG_REL);
  const vitestAbs = path.join(repoRoot, VITEST_REL);
  const missing = [];
  if (!(await isRegularFile(configAbs))) missing.push({ code: 'CONFIG_MISSING', detail: CONFIG_REL });
  if (!(await isRegularFile(vitestAbs))) missing.push({ code: 'VITEST_MISSING', detail: VITEST_REL });
  if (!(await executable(unshareBin))) missing.push({ code: 'UNSHARE_MISSING', detail: unshareBin });
  if (!(await executable(SH_BIN))) missing.push({ code: 'SH_MISSING', detail: SH_BIN });
  let ipBin = null;
  for (const candidate of ipCandidates) {
    if (await executable(candidate)) {
      ipBin = candidate;
      break;
    }
  }
  if (ipBin === null) missing.push({ code: 'IP_MISSING', detail: ipCandidates.join(', ') });
  let mountBin = null;
  for (const candidate of mountCandidates) {
    if (await executable(candidate)) {
      mountBin = candidate;
      break;
    }
  }
  if (mountBin === null) missing.push({ code: 'MOUNT_MISSING', detail: mountCandidates.join(', ') });
  let maskDirs = [];
  try {
    maskDirs = runtimeMaskDirs ? [...runtimeMaskDirs] : await computeMaskDirs(maskFs);
    for (const dir of maskDirs) {
      if (typeof dir !== 'string' || !dir.startsWith('/') || !(await maskFs.lstat(dir)).isDirectory()) throw new Error('not a directory');
    }
    if (maskDirs.length === 0) throw new Error('no runtime directory to mask');
  } catch {
    missing.push({ code: 'RUNTIME_DIR_UNAVAILABLE', detail: safeText(runtimeMaskDirs ? runtimeMaskDirs.join(', ') : '/run', 200) });
  }
  if (missing.length > 0) return finish('BLOCKED', { testsValidated: files, warnings, errors: missing });

  // 5. run inside the namespace, reporter output outside the repository
  let tmp;
  try {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'mona-nodb-'));
  } catch (error) {
    return finish('BLOCKED', { testsValidated: files, warnings, errors: [{ code: 'TMPDIR_UNUSABLE', detail: errorTag(error) }] });
  }
  try {
    const realRoot = await realpath(repoRoot);
    const realTmp = await realpath(tmp);
    if (realTmp === realRoot || realTmp.startsWith(realRoot + path.sep)) {
      return finish('BLOCKED', { testsValidated: files, warnings, errors: [{ code: 'TMPDIR_IN_REPO', detail: 'temporary directory resolves inside the repository' }] });
    }
    for (const dir of maskDirs) {
      let realDir = dir;
      try {
        realDir = await maskFs.realpath(dir);
      } catch {
        realDir = dir;
      }
      const within = (p) => p === realDir || p.startsWith(realDir + path.sep);
      if (within(realTmp)) return finish('BLOCKED', { testsValidated: files, warnings, errors: [{ code: 'TMPDIR_UNDER_MASKED_DIR', detail: dir }] });
      if (within(realRoot)) return finish('BLOCKED', { testsValidated: files, warnings, errors: [{ code: 'REPO_UNDER_MASKED_DIR', detail: dir }] });
    }
    const markerPath = path.join(tmp, 'isolation.marker');
    const reportPath = path.join(tmp, 'report.json');
    const filesAbs = files.map((f) => path.join(repoRoot, f));
    const args = [
      '-rnm', '--propagation', 'private', '--', SH_BIN, '-c', WRAPPER_SCRIPT, 'sh', ipBin, mountBin, markerPath, String(maskDirs.length), ...maskDirs,
      process.execPath, vitestAbs, 'run', '--config', configAbs, '--reporter=json', `--outputFile=${reportPath}`, ...filesAbs,
    ];
    const env = { PATH: '/usr/bin:/bin', NODE_ENV: 'test', HOME: tmp, TMPDIR: tmp, ...SYNTHETIC_ENV, ...PG_CONTAINMENT_ENV };
    const command = {
      argv: [
        unshareBin, '-rnm', '--propagation', 'private', '--', SH_BIN, '-c', WRAPPER_SCRIPT, 'sh', '<ip>', '<mount>', '<marker>', String(maskDirs.length), ...maskDirs,
        '<node>', VITEST_REL, 'run', '--config', CONFIG_REL, '--reporter=json', '--outputFile=<report>', ...files,
      ],
      envNames: Object.keys(env).sort(),
    };
    const common = { testsValidated: files, warnings, command, screenedFiles: screening.visited ? screening.visited.length : null };

    const outcome = await run({ command: unshareBin, args, cwd: apiDir, env, timeoutMs, markerPath, reportPath });
    const markerPresent = await exists(markerPath);
    // Separate guarantees (never one over-claiming flag): TCP/DNS via the net namespace, runtime
    // socket dirs via the tmpfs mask. Arbitrary filesystem AF_UNIX sockets elsewhere are NOT guaranteed.
    const isolation = {
      tcpDnsIsolation: markerPresent ? 'ENFORCED' : 'NOT_ESTABLISHED',
      runtimeSocketIsolation: markerPresent ? 'MASKED' : 'NOT_ESTABLISHED',
      maskedRuntimeDirs: markerPresent ? maskDirs : [],
    };
    const processExit = { code: outcome.code ?? null, signal: outcome.signal ?? null };
    const blockedWith = (code, detail) => finish('BLOCKED', { ...common, ...isolation, processExit, errors: [{ code, detail }] });

    if (outcome.spawnError) return blockedWith('SPAWN_FAILED', String(outcome.spawnError));
    if (outcome.timedOut) return blockedWith('TIMEOUT', `no exit within ${timeoutMs} ms; process group killed`);
    if (outcome.signal) return blockedWith('KILLED_BY_SIGNAL', String(outcome.signal));
    if (!markerPresent) {
      if (outcome.code === 95) return blockedWith('PROPAGATION_NOT_PRIVATE', 'a mount in the new namespace is still shared');
      if (outcome.code === 96) return blockedWith('RUNTIME_MASK_FAILED', 'could not mask a runtime directory with a namespace-local tmpfs');
      if (outcome.code === 97) return blockedWith('LOOPBACK_FAILED', 'could not bring namespace-local loopback up');
      if (outcome.code === 98) return blockedWith('ISOLATION_MARKER_FAILED', 'could not create the isolation marker');
      return blockedWith('ISOLATION_NOT_ESTABLISHED', `unshare/loopback did not reach exec (exit ${outcome.code})`);
    }

    // 1 (cont.). a FAIL needs a numeric exit status from a Vitest that really ran; anything else is not an outcome.
    if (!Number.isSafeInteger(outcome.code)) return blockedWith('NO_EXIT_STATUS', 'the process ended without a numeric exit status');

    // 2. evidence first ...
    const evidence = await assessReporterEvidence({ reportPath, filesAbs });
    const parsed = evidence.parsed || null;
    const counts = parsed
      ? { reporterParsed: true, testsPassed: parsed.passed, testsFailed: parsed.failed, testsSkipped: parsed.skipped, testsTodo: parsed.todo, testsExecuted: parsed.passed + parsed.failed }
      : { reporterParsed: false };
    const base = { ...common, ...isolation, processExit, ...counts };
    if (!evidence.usable) return finish('BLOCKED', { ...base, errors: [evidence.problem] });

    // 3-4. ... then the outcome of the usable evidence.
    const decided = classifyOutcome(outcome.code, evidence.parsed);
    return finish(decided.verdict, { ...base, errors: decided.errors });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

// Code or name only: never a message, which may contain local paths.
function errorTag(error) {
  try {
    return safeText((error && (error.code || error.name)) || 'Error', 60);
  } catch {
    return 'Error';
  }
}

// Any unexpected operational exception is BLOCKED (exit 3), never a thrown crash:
// an uncaught exception exits 1, which a caller would read as a test FAIL.
export async function runSafeNodb(input = {}) {
  try {
    return await runSafeNodbUnguarded(input);
  } catch (error) {
    const requested = safeRequested(input && input.paths);
    return {
      exitCode: EXIT.BLOCKED,
      result: buildResult({ verdict: 'BLOCKED', testsRequested: requested, errors: [{ code: 'RUNNER_INTERNAL_ERROR', detail: errorTag(error) }] }),
    };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { exitCode, result } = await runSafeNodb({ paths: process.argv.slice(2) });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = exitCode;
}
