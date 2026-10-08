// TEST-H2: zero-database checks for test cleanup. Vitest runs afterAll even when
// beforeAll failed (tests and beforeEach/afterEach are skipped), so teardown must
// be a no-op for a handle that was never assigned, close an acquired handle
// exactly once, and never replace the primary setup failure with a TypeError.
//
// TEST-H2.1: the structural rule is an allowlist. Every reference to a TEST
// acquirer must be one of the canonical forms below; anything the scanner cannot
// positively recognise fails, even if it happens to be safe. Rewrite such code
// into a canonical form instead of loosening the scanner.
//
// A. Suite handle (acquired in a hook, released in the paired after-hook):
//      let db: T;                                       // same block as both hooks
//      beforeAll(async () => { db = await createTestPrismaClient(); });
//      afterAll(async () => { await db?.$disconnect(); });   // or:
//      afterAll(async () => db?.$disconnect());
//    Seed variant:
//      beforeAll(async () => { db = await safely(() => openSeedDatabase('test')); });
//      afterAll(async () => { if (db) await safely(() => db.close()); });
//    beforeEach pairs with afterEach the same way. One acquisition per handle;
//    only side-effect-only expression statements that never mention the handle
//    may precede the release; the handle is never otherwise assigned.
// B. Inline handle (anywhere, including helpers and any it/test variant):
//      const db = await createTestPrismaClient();       // or openSeedDatabase(...)
//      try { ... } finally { await db.$disconnect(); }  // or db.close(); first in finally
//    The try/finally is the very next statement.
// Releases are exact syntax: no helpers, aliases, casts, `!`, parentheses,
// method references, optional calls, `void`, or conditions other than `if (db)`.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';

const API = fileURLToPath(new URL('../', import.meta.url));
const TESTS = join(API, 'tests');

type Kind = 'prisma' | 'seed';
const ACQUIRERS = new Map<string, Kind>([
  ['createTestPrismaClient', 'prisma'],
  ['openSeedDatabase', 'seed'],
]);
const RELEASE: Record<Kind, string> = { prisma: '$disconnect', seed: 'close' };
const RELEASES = new Set(Object.values(RELEASE));
const PAIRED_TEARDOWN: Record<string, string> = { beforeAll: 'afterAll', beforeEach: 'afterEach' };

// Exempt only while the file fakes every input a TEST acquisition reads: `pg` for
// the helper's own proof pool, and dotenv/node:fs for the environment, so the
// acquirers can only "prove" the file's scripted databases. vi.mock('pg') does NOT
// reach the pg imported by @prisma/adapter-pg, so the clients it returns hold a
// real (never-connected, synthetic-URL) adapter pool; that file issues no query
// through them. Removing any of these mocks voids the exemption.
const HERMETIC: ReadonlyMap<string, readonly string[]> = new Map([
  ['tests/test-db-guard.test.ts', ['pg', 'dotenv', 'node:fs']],
]);

type Source = { path: string; text: string };

function testSources(): Source[] {
  const out: Source[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) out.push({ path: relative(API, full), text: readFileSync(full, 'utf8') });
    }
  };
  walk(TESTS);
  return out;
}

type Fn = ts.ArrowFunction | ts.FunctionExpression;
const isFn = (node: ts.Node | undefined): node is Fn => !!node && (ts.isArrowFunction(node) || ts.isFunctionExpression(node));
const isIdent = (node: ts.Node | undefined, text: string): node is ts.Identifier =>
  !!node && ts.isIdentifier(node) && node.text === text;

function each(node: ts.Node, visit: (node: ts.Node) => void) {
  visit(node);
  ts.forEachChild(node, (child) => each(child, visit));
}

// `name` positions that introduce a binding (not a use).
function isDeclarationName(id: ts.Identifier): boolean {
  const p = id.parent;
  return (
    (ts.isVariableDeclaration(p) ||
      ts.isParameter(p) ||
      ts.isBindingElement(p) ||
      ts.isFunctionDeclaration(p) ||
      ts.isFunctionExpression(p) ||
      ts.isClassDeclaration(p) ||
      ts.isImportSpecifier(p) ||
      ts.isImportClause(p) ||
      ts.isNamespaceImport(p)) &&
    p.name === id
  );
}

// Identifiers that are property names, not variable references.
const isMemberName = (id: ts.Identifier): boolean => {
  const p = id.parent;
  return (
    (ts.isPropertyAccessExpression(p) && p.name === id) ||
    ((ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isPropertySignature(p) || ts.isPropertyDeclaration(p)) &&
      p.name === id) ||
    (ts.isBindingElement(p) && p.propertyName === id) ||
    (ts.isImportSpecifier(p) && p.propertyName === id)
  );
};

const inType = (node: ts.Node): boolean => {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) if (ts.isTypeNode(n)) return true;
  return false;
};

const references = (node: ts.Node, name: string): ts.Identifier[] => {
  const out: ts.Identifier[] = [];
  each(node, (n) => {
    if (isIdent(n, name) && !isMemberName(n) && !isDeclarationName(n) && !inType(n)) out.push(n);
  });
  return out;
};

const declares = (node: ts.Node, name: string): boolean => {
  let found = false;
  each(node, (n) => {
    if (isIdent(n, name) && isDeclarationName(n)) found = true;
  });
  return found;
};

// The declaration a use of `name` binds to, by lexical scope (enough to tell an
// imported acquirer from a local of the same name, e.g. `const openSeedDatabase = vi.fn()`).
function resolve(use: ts.Identifier): ts.Node | undefined {
  const name = use.text;
  const own = (scope: ts.Node): ts.Node | undefined => {
    let hit: ts.Node | undefined;
    const bind = (binding: ts.BindingName | undefined, decl: ts.Node) => {
      if (!binding || hit) return;
      if (ts.isIdentifier(binding)) {
        if (binding.text === name) hit = decl;
        return;
      }
      for (const el of binding.elements) if (!ts.isOmittedExpression(el)) bind(el.name, el);
    };
    const statements =
      ts.isSourceFile(scope) || ts.isBlock(scope) || ts.isModuleBlock(scope) || ts.isCaseClause(scope) || ts.isDefaultClause(scope)
        ? scope.statements
        : undefined;
    for (const s of statements ?? []) {
      if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) bind(d.name, d);
      else if ((ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s)) && s.name?.text === name) hit ??= s;
      else if (ts.isImportDeclaration(s) && s.importClause) {
        const clause = s.importClause;
        if (clause.name?.text === name) hit ??= clause;
        const named = clause.namedBindings;
        if (named && ts.isNamespaceImport(named) && named.name.text === name) hit ??= named;
        if (named && ts.isNamedImports(named)) for (const el of named.elements) if (el.name.text === name) hit ??= el;
      }
    }
    if (ts.isFunctionLike(scope)) {
      for (const p of scope.parameters) bind(p.name, p);
      if (ts.isFunctionExpression(scope) && scope.name?.text === name) hit ??= scope;
    }
    if (ts.isCatchClause(scope)) bind(scope.variableDeclaration?.name, scope);
    if ((ts.isForStatement(scope) || ts.isForInStatement(scope) || ts.isForOfStatement(scope)) && scope.initializer) {
      if (ts.isVariableDeclarationList(scope.initializer)) for (const d of scope.initializer.declarations) bind(d.name, d);
    }
    return hit;
  };
  for (let n: ts.Node | undefined = use.parent; n; n = n.parent) {
    const hit = own(n);
    if (hit) return hit;
  }
  return undefined;
}

const unwrap = (node: ts.Expression): ts.Expression => {
  let n = node;
  while (
    ts.isParenthesizedExpression(n) ||
    ts.isAsExpression(n) ||
    ts.isTypeAssertionExpression(n) ||
    ts.isNonNullExpression(n) ||
    ts.isSatisfiesExpression(n)
  ) {
    n = n.expression;
  }
  return n;
};

// Exactly `h.release()` / `h?.release()`: no wrappers, arguments, or optional call.
function isRelease(node: ts.Node, h: string, kind: Kind, optional: boolean): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    !node.questionDotToken &&
    !node.typeArguments &&
    node.arguments.length === 0 &&
    ts.isPropertyAccessExpression(node.expression) &&
    !!node.expression.questionDotToken === optional &&
    ts.isIdentifier(node.expression.name) &&
    node.expression.name.text === RELEASE[kind] &&
    isIdent(node.expression.expression, h)
  );
}

const awaitedRelease = (s: ts.Statement | undefined, h: string, kind: Kind, optional: boolean): ts.CallExpression | null =>
  s && ts.isExpressionStatement(s) && ts.isAwaitExpression(s.expression) && isRelease(s.expression.expression, h, kind, optional)
    ? s.expression.expression
    : null;

// The file's own `async function safely(action) { try { return await action(); } ... }`.
function isSafelyHelper(decl: ts.Node | undefined): boolean {
  if (!decl || !ts.isFunctionDeclaration(decl) || decl.parameters.length !== 1 || !decl.body) return false;
  const param = decl.parameters[0]!.name;
  const first = decl.body.statements[0];
  const ret = first && ts.isTryStatement(first) ? first.tryBlock.statements[0] : undefined;
  return (
    ts.isIdentifier(param) &&
    !!ret &&
    ts.isReturnStatement(ret) &&
    !!ret.expression &&
    ts.isAwaitExpression(ret.expression) &&
    ts.isCallExpression(ret.expression.expression) &&
    ret.expression.expression.arguments.length === 0 &&
    isIdent(ret.expression.expression.expression, param.text)
  );
}

// `safely(() => <expr>)` with a single parameterless concise arrow.
function safelyBody(node: ts.Node | undefined): ts.Expression | null {
  if (!node || !ts.isCallExpression(node) || !isIdent(node.expression, 'safely') || node.arguments.length !== 1) return null;
  if (!isSafelyHelper(resolve(node.expression))) return null;
  const arrow = node.arguments[0]!;
  return ts.isArrowFunction(arrow) && arrow.parameters.length === 0 && !ts.isBlock(arrow.body) ? arrow.body : null;
}

// Vitest's own hook: a global, or imported from 'vitest' under its own name.
function isVitestBinding(id: ts.Identifier): boolean {
  const decl = resolve(id);
  return (
    !decl ||
    (ts.isImportSpecifier(decl) &&
      !decl.propertyName &&
      ts.isStringLiteral(decl.parent.parent.parent.moduleSpecifier) &&
      decl.parent.parent.parent.moduleSpecifier.text === 'vitest')
  );
}

// A return/throw at describe-body level can stop later hooks from registering.
function divertsRegistration(list: ts.NodeArray<ts.Statement>): boolean {
  let found = false;
  const walk = (node: ts.Node) => {
    if (ts.isFunctionLike(node) || ts.isClassLike(node)) return;
    if (ts.isReturnStatement(node) || ts.isThrowStatement(node)) found = true;
    ts.forEachChild(node, walk);
  };
  list.forEach(walk);
  return found;
}

// Canonical suite release inside an after-hook: returns [node that owns every
// allowed mention of h, the release call] or null.
function suiteRelease(fn: Fn, h: string, kind: Kind): [ts.Node, ts.CallExpression] | null {
  if (declares(fn, h)) return null;
  if (!ts.isBlock(fn.body)) return kind === 'prisma' && isRelease(fn.body, h, kind, true) ? [fn.body, fn.body] : null;
  for (const s of fn.body.statements) {
    if (kind === 'prisma') {
      const call = awaitedRelease(s, h, kind, true);
      if (call) return [s, call];
    } else if (ts.isIfStatement(s) && isIdent(s.expression, h) && !s.elseStatement) {
      const then = s.thenStatement;
      const inner = ts.isExpressionStatement(then) && ts.isAwaitExpression(then.expression) ? safelyBody(then.expression.expression) : null;
      if (inner && isRelease(inner, h, kind, false)) return [s, inner];
      return null;
    }
    // Anything before the release must be a plain expression statement that
    // cannot skip it (no return/if/try) and never touches the handle.
    if (!ts.isExpressionStatement(s) || references(s, h).length > 0) return null;
  }
  return null;
}

type Hook = { name: string; fn: Fn | null; statement: ts.ExpressionStatement };
function hookOf(s: ts.Statement): Hook | null {
  if (!ts.isExpressionStatement(s) || !ts.isCallExpression(s.expression) || !ts.isIdentifier(s.expression.expression)) return null;
  const name = s.expression.expression.text;
  if (!/^(before|after)(All|Each)$/.test(name) || !isVitestBinding(s.expression.expression)) return null;
  const fn = s.expression.arguments[0];
  return { name, fn: isFn(fn) ? fn : null, statement: s };
}

function isAssignment(node: ts.Node): node is ts.BinaryExpression {
  return (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  );
}

function hermetic(path: string, source: ts.SourceFile): boolean {
  const required = HERMETIC.get(path);
  if (!required) return false;
  const mocked = new Set<string>();
  for (const s of source.statements) {
    if (!ts.isExpressionStatement(s) || !ts.isCallExpression(s.expression)) continue;
    const { expression: callee, arguments: args } = s.expression;
    if (
      ts.isPropertyAccessExpression(callee) &&
      isIdent(callee.expression, 'vi') &&
      callee.name.text === 'mock' &&
      args.length === 2 &&
      ts.isStringLiteral(args[0]!) &&
      isFn(args[1])
    ) {
      mocked.add(args[0].text);
    }
  }
  return required.every((m) => mocked.has(m));
}

type Scan = { violations: string[]; exempt: boolean; suiteHandles: number; inlineHandles: number };

function scan({ path, text }: Source): Scan {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const violations: string[] = [];
  const at = (node: ts.Node, why: string) =>
    violations.push(`${path}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1} ${why}`);

  const syntax = ts.transpileModule(text, { fileName: path, reportDiagnostics: true }).diagnostics ?? [];
  if (syntax.length > 0) {
    violations.push(`${path}:0 unparseable; the cleanup rule cannot be checked`);
    return { violations, exempt: false, suiteHandles: 0, inlineHandles: 0 };
  }
  if (hermetic(path, source)) return { violations, exempt: true, suiteHandles: 0, inlineHandles: 0 };

  type SuiteHandle = { list: ts.NodeArray<ts.Statement>; name: string; kind: Kind; hook: string; site: ts.BinaryExpression };
  const suite: SuiteHandle[] = [];
  const canonicalReleases = new Set<ts.Node>();
  const handleNames = new Set<string>();
  let inlineHandles = 0;

  // 1. Every reference to an acquirer must be a canonical acquisition.
  const acquisition = (call: ts.CallExpression, kind: Kind) => {
    const hookSite = (): SuiteHandle | string => {
      // db = await acquire(...)  |  db = await safely(() => openSeedDatabase(...))
      let awaitNode: ts.Node = call.parent;
      if (kind === 'seed' && ts.isArrowFunction(call.parent) && call.parent.body === call) {
        const wrapper = call.parent.parent;
        if (safelyBody(wrapper) !== call) return 'acquisition wrapped in something other than safely(() => ...)';
        awaitNode = wrapper.parent;
      }
      if (!ts.isAwaitExpression(awaitNode)) return 'acquisition is not `await`ed directly into a handle';
      const assign = awaitNode.parent;
      if (!ts.isBinaryExpression(assign) || assign.operatorToken.kind !== ts.SyntaxKind.EqualsToken || assign.right !== awaitNode) {
        return 'acquisition is neither `const h = await ...` nor `h = await ...`';
      }
      if (!ts.isIdentifier(assign.left)) return 'acquisition target is not a plain identifier';
      const name = assign.left.text;
      handleNames.add(name);
      const statement = assign.parent;
      const body = statement.parent;
      const fn = body?.parent;
      if (!ts.isExpressionStatement(statement) || !ts.isBlock(body) || !isFn(fn) || !ts.isCallExpression(fn.parent)) {
        return 'suite handle is not assigned by a top-level statement of a hook callback';
      }
      const hook = hookOf(fn.parent.parent as ts.Statement);
      if (!hook || hook.fn !== fn || !(hook.name in PAIRED_TEARDOWN)) return 'suite handle is assigned outside beforeAll/beforeEach';
      if (declares(fn, name)) return 'hook callback shadows the handle it assigns';
      const list = (hook.statement.parent as ts.Block | ts.SourceFile).statements;
      const decls = list.filter(
        (s): s is ts.VariableStatement =>
          ts.isVariableStatement(s) && s.declarationList.declarations.some((d) => isIdent(d.name, name)),
      );
      const decl = decls[0]?.declarationList;
      if (
        decls.length !== 1 ||
        !(decl!.flags & ts.NodeFlags.Let) ||
        decl!.declarations.length !== 1 ||
        decl!.declarations[0]!.initializer
      ) {
        return `suite handle '${name}' must be one \`let ${name}: T;\` (no initializer) in the same block as its hooks`;
      }
      return { list, name, kind, hook: hook.name, site: assign };
    };

    // const h = await acquire(...); try { ... } finally { await h.release(); ... }
    if (ts.isAwaitExpression(call.parent) && ts.isVariableDeclaration(call.parent.parent)) {
      const decl = call.parent.parent;
      if (ts.isIdentifier(decl.name)) handleNames.add(decl.name.text);
      const list = decl.parent;
      const statement = list.parent;
      const block = statement?.parent;
      if (
        !ts.isIdentifier(decl.name) ||
        decl.initializer !== call.parent ||
        !ts.isVariableDeclarationList(list) ||
        !(list.flags & ts.NodeFlags.Const) ||
        list.declarations.length !== 1 ||
        !ts.isVariableStatement(statement) ||
        !ts.isBlock(block)
      ) {
        return at(call, 'inline acquisition must be `const h = await acquire(...)` directly in a block');
      }
      const h = decl.name.text;
      const next = block.statements[block.statements.indexOf(statement) + 1];
      const release =
        next && ts.isTryStatement(next) && next.finallyBlock && !declares(next.finallyBlock, h)
          ? awaitedRelease(next.finallyBlock.statements[0], h, kind, false)
          : null;
      if (!release) return at(call, `inline '${h}' is not immediately protected by try { } finally { await ${h}.${RELEASE[kind]}(); }`);
      canonicalReleases.add(release.expression);
      inlineHandles += 1;
      return;
    }
    const site = hookSite();
    if (typeof site === 'string') return at(call, site);
    suite.push(site);
  };

  each(source, (node) => {
    if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) && ACQUIRERS.has(node.argumentExpression.text)) {
      return at(node, 'acquirer reached through an object/namespace');
    }
    if (!ts.isIdentifier(node) || !ACQUIRERS.has(node.text) || inType(node)) return;
    const p = node.parent;
    if ((ts.isImportSpecifier(p) || ts.isBindingElement(p)) && p.propertyName) return at(node, 'renamed acquirer binding');
    if (ts.isPropertyAccessExpression(p) && p.name === node) return at(node, 'acquirer reached through an object/namespace');
    if (ts.isExportSpecifier(p)) return at(node, 'acquirer re-exported');
    if (isMemberName(node) || isDeclarationName(node)) return;
    const decl = resolve(node);
    const imported = !decl || ts.isImportSpecifier(decl) || ts.isBindingElement(decl);
    if (!imported) return; // a local of the same name (e.g. a vi.fn() mock), not the acquirer
    if (!ts.isCallExpression(p) || p.expression !== node) return at(node, 'acquirer used as a value (alias/indirection)');
    acquisition(p, ACQUIRERS.get(node.text)!);
  });

  // 2. Each suite handle: one acquisition, one canonical paired release, and no
  // other use of the handle inside any after-hook that runs when setup failed.
  const groups = new Map<string, SuiteHandle[]>();
  for (const h of suite) {
    const key = `${h.list.pos}:${h.name}`;
    groups.set(key, [...(groups.get(key) ?? []), h]);
  }
  for (const group of groups.values()) {
    const { list, name, kind, hook, site } = group[0]!;
    if (group.length > 1) {
      for (const h of group.slice(1)) at(h.site, `suite handle '${name}' acquired more than once (earlier handle leaks)`);
      continue;
    }
    if (divertsRegistration(list)) at(site, `return/throw beside the hooks of '${name}' may skip teardown registration`);
    const teardownHooks = new Set(hook === 'beforeEach' ? ['afterAll', 'afterEach'] : ['afterAll']);
    let released = false;
    for (const s of list) {
      const after = hookOf(s);
      if (!after || !teardownHooks.has(after.name)) continue;
      const found = after.fn && after.name === PAIRED_TEARDOWN[hook] ? suiteRelease(after.fn, name, kind) : null;
      if (found) {
        released = true;
        canonicalReleases.add(found[1].expression);
      }
      const allowed = found?.[0];
      for (const ref of after.fn ? references(after.fn, name) : references(after.statement, name)) {
        if (!allowed || ref.pos < allowed.pos || ref.end > allowed.end) at(ref, `'${name}' used outside the canonical release in ${after.name}`);
      }
      if (after.fn && declares(after.fn, name)) at(after.statement, `${after.name} shadows suite handle '${name}'`);
    }
    if (!released) at(site, `suite handle '${name}' has no canonical ${PAIRED_TEARDOWN[hook]} release`);
  }

  // 3. Handles are assigned only at their canonical site; release methods on
  // handles appear only at canonical release sites.
  const suiteNames = new Set(suite.map((h) => h.name));
  const sites = new Set<ts.Node>(suite.map((h) => h.site));
  each(source, (node) => {
    if (isAssignment(node) && !sites.has(node)) {
      const left = unwrap(node.left);
      const targets = ts.isIdentifier(left) ? [left] : ts.isArrayLiteralExpression(left) || ts.isObjectLiteralExpression(left) ? [left] : [];
      for (const t of targets) for (const n of suiteNames) if (isIdent(t, n) || references(t, n).length > 0) at(node, `suite handle '${n}' reassigned`);
    }
    const member =
      ts.isPropertyAccessExpression(node) && RELEASES.has(node.name.text)
        ? node.expression
        : ts.isElementAccessExpression(node) &&
            ts.isStringLiteralLike(node.argumentExpression) &&
            RELEASES.has(node.argumentExpression.text)
          ? node.expression
          : null;
    if (member && !canonicalReleases.has(node)) {
      const root = unwrap(member);
      if (ts.isIdentifier(root) && handleNames.has(root.text)) at(node, `non-canonical release of '${root.text}'`);
    }
    if (ts.isBindingElement(node)) {
      const key = node.propertyName ?? node.name;
      let decl: ts.Node = node;
      while (!ts.isVariableDeclaration(decl) && !ts.isParameter(decl) && decl.parent) decl = decl.parent;
      const init = ts.isVariableDeclaration(decl) ? decl.initializer : undefined;
      if (ts.isIdentifier(key) && RELEASES.has(key.text) && init && [...handleNames].some((n) => references(init, n).length > 0)) {
        at(node, 'release method destructured from a handle');
      }
    }
  });

  return { violations, exempt: false, suiteHandles: groups.size, inlineHandles };
}

// ---------------------------------------------------------------------------
// Contract fixtures. FAIL = at least one violation; PASS = none. Written before
// the scanner (TEST-H2.1 RED): the pre-H2.1 scanner passed 36 of the 46 unsafe ones.
const P = `import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, test, vi } from 'vitest';
import { createTestPrismaClient } from '../helpers/test-db.js';
import { openSeedDatabase } from '../../scripts/demo-database.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';
`;
const suiteFixture = (teardown: string, extra = '') => `${P}
describe('s', () => {
  let db: PrismaClient | undefined;
  beforeAll(async () => {
    db = await createTestPrismaClient();
  });
  ${extra}
  ${teardown}
  it('t', () => expect(db).toBeDefined());
});
`;
const inlineFixture = (body: string, wrapper = "it('t', async () => {\n__BODY__\n});") =>
  `${P}\ndescribe('s', () => {\n${wrapper.replace('__BODY__', body)}\n});\n`;
const FIN = `  const db = await createTestPrismaClient();
  try {
    expect(db).toBeDefined();
  } finally {
    await db.$disconnect();
  }`;
const SEED = (teardown: string) => `${P}
describe('s', () => {
  let db: Awaited<ReturnType<typeof openSeedDatabase>>;
  async function safely<T>(action: () => Promise<T>): Promise<T> {
    try { return await action(); } catch { throw new Error('suppressed'); }
  }
  beforeAll(async () => {
    db = await safely(() => openSeedDatabase('test'));
    await safely(() => Promise.resolve(db.prisma));
  }, 120000);
  afterEach(async () => { await safely(() => db.prisma.user.deleteMany()); });
  ${teardown}
  it('t', () => expect(db).toBeDefined());
});
`;

const unsafe: Array<[string, string]> = [
  // Known bypasses of the pre-H2.1 scanner.
  ['helper-wrapped teardown', suiteFixture(`async function teardown() { await db?.$disconnect(); }\n  afterAll(teardown);`)],
  ['arrow calling a teardown helper', suiteFixture(`const teardown = async () => db?.$disconnect();\n  afterAll(() => teardown());`)],
  ['non-null receiver', suiteFixture(`afterAll(async () => { await db!.$disconnect(); });`)],
  ['parenthesized receiver', suiteFixture(`afterAll(async () => { await (db).$disconnect(); });`)],
  ['cast receiver', suiteFixture(`afterAll(async () => { await (db as PrismaClient).$disconnect(); });`)],
  ['double cast receiver', suiteFixture(`afterAll(async () => { await ((db as unknown) as PrismaClient).$disconnect(); });`)],
  ['method-reference hook', suiteFixture(`afterAll(db!.$disconnect);`)],
  ['optional method-reference hook', suiteFixture(`afterAll(db?.$disconnect as () => Promise<void>);`)],
  ['spoofed if guard', suiteFixture(`afterAll(async () => { if (db || true) { await db!.$disconnect(); } });`)],
  ['compound if guard', suiteFixture(`afterAll(async () => { if (!db === false || db) await db.$disconnect(); });`)],
  ['alias receiver', suiteFixture(`afterAll(async () => { const alias = db; await alias?.$disconnect(); });`)],
  ['var handle', `${P}
describe('s', () => {
  var db: PrismaClient;
  beforeAll(async () => { db = await createTestPrismaClient(); });
  afterAll(async () => { await db.$disconnect(); });
  it('t', () => expect(db).toBeDefined());
});
`],
  ['it.each inline without finally', inlineFixture(`  const db = await createTestPrismaClient();\n  expect(db).toBeDefined();\n  await db.$disconnect();`, "it.each([1, 2])('t %i', async () => {\n__BODY__\n});")],
  ['it.skip inline without finally', inlineFixture(`  const db = await createTestPrismaClient();\n  expect(db).toBeDefined();\n  await db.$disconnect();`, "it.skip('t', async () => {\n__BODY__\n});")],
  ['guarded but not awaited', suiteFixture(`afterAll(async () => { db?.$disconnect(); });`)],
  ['void fire-and-forget', suiteFixture(`afterAll(async () => { void db?.$disconnect(); });`)],
  ['dead finally (if false)', inlineFixture(`  const db = await createTestPrismaClient();\n  try {\n    expect(db).toBeDefined();\n  } finally {\n    if (false) {\n      await db.$disconnect();\n    }\n  }`)],
  ['finally releases a different handle', inlineFixture(`  const other = { $disconnect: async () => undefined };\n  const db = await createTestPrismaClient();\n  try {\n    expect(db).toBeDefined();\n  } finally {\n    await other.$disconnect();\n  }`)],
  ['finally mentions the release only in a string', inlineFixture(`  const db = await createTestPrismaClient();\n  try {\n    expect(db).toBeDefined();\n  } finally {\n    console.log('db.$disconnect(');\n  }`)],
  // Fresh adversarial forms of the same lifecycle defects.
  ['test.concurrent inline without finally', inlineFixture(`  const db = await createTestPrismaClient();\n  expect(db).toBeDefined();\n  await db.$disconnect();`, "test.concurrent('t', async () => {\n__BODY__\n});")],
  ['describe.each suite with no teardown', `${P}
describe.each([1])('s %i', () => {
  let db: PrismaClient | undefined;
  beforeAll(async () => { db = await createTestPrismaClient(); });
  it('t', () => expect(db).toBeDefined());
});
`],
  ['teardown releases a shadowing local', suiteFixture(`afterAll(async () => { const db = undefined as PrismaClient | undefined; await db?.$disconnect(); });`)],
  ['two handles, one released', `${P}
describe('s', () => {
  let a: PrismaClient | undefined;
  let b: PrismaClient | undefined;
  beforeAll(async () => {
    a = await createTestPrismaClient();
    b = await createTestPrismaClient();
  });
  afterAll(async () => {
    await a?.$disconnect();
  });
  it('t', () => expect(b).toBeDefined());
});
`],
  ['beforeEach re-acquires into the suite handle', suiteFixture(`afterAll(async () => { await db?.$disconnect(); });`, `beforeEach(async () => { db = await createTestPrismaClient(); });`)],
  ['acquisition through a helper', `${P}
async function makeDb() {
  return createTestPrismaClient();
}
it('t', async () => {
  const db = await makeDb();
  try { expect(db).toBeDefined(); } finally { await db.$disconnect(); }
});
`],
  ['early return between acquisition and try', inlineFixture(`  const db = await createTestPrismaClient();\n  if (Math.random() > 2) return;\n  try {\n    expect(db).toBeDefined();\n  } finally {\n    await db.$disconnect();\n  }`)],
  ['sync hook, unawaited release', suiteFixture(`afterAll(() => { db?.$disconnect(); });`)],
  ['destructured release method', suiteFixture(`afterAll(async () => { const { $disconnect } = db ?? ({} as PrismaClient); await $disconnect?.(); });`)],
  ['optional call on a non-optional receiver', suiteFixture(`afterAll(async () => { await db.$disconnect?.(); });`)],
  ['release in catch, not finally', inlineFixture(`  const db = await createTestPrismaClient();\n  try {\n    expect(db).toBeDefined();\n  } catch (error) {\n    await db.$disconnect();\n    throw error;\n  }\n  await db.$disconnect();`)],
  ['two acquisitions, one finalizer', inlineFixture(`  const a = await createTestPrismaClient();\n  const b = await createTestPrismaClient();\n  try {\n    expect(a).toBeDefined();\n  } finally {\n    await a.$disconnect();\n    await b.$disconnect();\n  }`)],
  ['conditional acquisition into a test-local let', inlineFixture(`  let db: PrismaClient | undefined;\n  if (Date.now() > 0) db = await createTestPrismaClient();\n  expect(db).toBeDefined();\n  await db?.$disconnect();`)],
  ['renamed acquirer import', `import { it, expect } from 'vitest';
import { createTestPrismaClient as makeClient } from '../helpers/test-db.js';
it('t', async () => {
  const db = await makeClient();
  expect(db).toBeDefined();
});
`],
  ['acquirer aliased as a value', suiteFixture(`afterAll(async () => { await db?.$disconnect(); });`).replace('db = await createTestPrismaClient();', 'const make = createTestPrismaClient;\n    db = await make();\n    await make();')],
  ['namespace-import acquisition', `import { it, expect } from 'vitest';
import * as helpers from '../helpers/test-db.js';
it('t', async () => {
  const db = await helpers.createTestPrismaClient();
  expect(db).toBeDefined();
});
`],
  ['fallible statement before the finally release', inlineFixture(`  const db = await createTestPrismaClient();\n  try {\n    expect(db).toBeDefined();\n  } finally {\n    await db.user.deleteMany();\n    await db.$disconnect();\n  }`)],
  ['release after a conditional return', suiteFixture(`afterAll(async () => { if (Date.now() > 0) return; await db?.$disconnect(); });`)],
  ['beforeAll acquisition released only in afterEach', suiteFixture(`afterEach(async () => { await db?.$disconnect(); });`)],
  ['teardown in a sibling describe', `${P}
describe('outer', () => {
  let db: PrismaClient | undefined;
  describe('a', () => {
    beforeAll(async () => { db = await createTestPrismaClient(); });
    it('t', () => expect(db).toBeDefined());
  });
  describe('b', () => {
    afterAll(async () => { await db?.$disconnect(); });
  });
});
`],
  ['test body acquires into the suite handle', suiteFixture(`afterAll(async () => { await db?.$disconnect(); });`, `it('re', async () => { db = await createTestPrismaClient(); });`)],
  ['seed handle closed without guard', `${P}
describe('s', () => {
  let db: Awaited<ReturnType<typeof openSeedDatabase>>;
  beforeAll(async () => { db = await openSeedDatabase('test'); });
  afterAll(async () => { await db.close(); });
  it('t', () => expect(db).toBeDefined());
});
`],
  ['unguarded handle use before the release', suiteFixture(`afterAll(async () => { await db!.user.deleteMany(); await db?.$disconnect(); });`)],
  ['floating (unawaited) acquisition', inlineFixture(`  const pending = createTestPrismaClient();\n  expect(pending).toBeDefined();`)],
  ['extra non-canonical release in a test body', suiteFixture(`afterAll(async () => { await db?.$disconnect(); });`, `it('mid', async () => { db!.$disconnect(); });`)],
  ['handle declared with an initializer', suiteFixture(`afterAll(async () => { await db?.$disconnect(); });`).replace('let db: PrismaClient | undefined;', 'let db: PrismaClient | undefined = undefined as unknown as PrismaClient, other = 1;')],
  ['seed guard with a spoofed condition', SEED(`afterAll(async () => { if (db || true) await safely(() => db.close()); });`)],
  ['seed release not wrapped in the guard', SEED(`afterAll(async () => { if (db) {} await safely(() => db.close()); });`)],
  ['unparseable file', `${P}\ndescribe('s', () => {\n  const db = await createTestPrismaClient(;\n});\n`],
  ['locally redefined afterAll never registers the release', suiteFixture(`const afterAll = (fn: () => unknown) => fn;\n  afterAll(async () => { await db?.$disconnect(); });`)],
  ['return in the describe body skips teardown registration', suiteFixture(`afterAll(async () => { await db?.$disconnect(); });`, `if (Date.now() > 0) return;`)],
  ['seed safely() that never runs its action', SEED(`afterAll(async () => {\n    if (db) await safely(() => db.close());\n  });`).replace('try { return await action(); } catch', 'try { return undefined as T; } catch')],
  ['element-access acquirer', `import { it, expect } from 'vitest';
it('t', async () => {
  const mod = await import('../helpers/test-db.js');
  const db = await mod['createTestPrismaClient']();
  expect(db).toBeDefined();
});
`],
];

const safe: Array<[string, string]> = [
  ['suite handle, awaited optional release, timeout argument', suiteFixture(`afterAll(async () => { await db?.$disconnect(); }, 120000);`)],
  ['suite handle, concise arrow returns the release promise', suiteFixture(`afterAll(async () => db?.$disconnect());`)],
  ['side-effect-only statement before the release', suiteFixture(`afterAll(async () => { vi.restoreAllMocks(); await db?.$disconnect(); }, 120000);`)],
  ['beforeEach/afterEach pair', suiteFixture(`afterEach(async () => { await db?.$disconnect(); });`).replace('beforeAll(', 'beforeEach(')],
  ['seed handle released through safely', SEED(`afterAll(async () => {\n    if (db) await safely(() => db.close());\n  });`)],
  ['inline in it', inlineFixture(FIN)],
  ['inline in it.each', inlineFixture(FIN, "it.each([1, 2])('t %i', async () => {\n__BODY__\n});")],
  ['inline in test.concurrent in a nested describe', inlineFixture(FIN, "describe('n', () => {\n  test.concurrent('t', async () => {\n__BODY__\n  });\n});")],
  ['inline with a dynamic-import acquirer', `import { it, expect } from 'vitest';
it('t', async () => {
  const { createTestPrismaClient } = await import('../helpers/test-db.js');
  const db = await createTestPrismaClient();
  try {
    expect(db).toBeDefined();
  } finally {
    await db.$disconnect();
  }
});
`],
  ['inline seed handle in a plain function (globalSetup shape)', `import { openSeedDatabase } from '../scripts/demo-database.js';
async function cleanup(): Promise<void> {
  const db = await openSeedDatabase('test');
  try {
    await Promise.resolve(db.prisma);
  } finally {
    await db.close();
  }
}
export default async function setup() { await cleanup(); }
`],
  ['withDb helper using the inline form', `import { it, expect } from 'vitest';
import { createTestPrismaClient } from '../helpers/test-db.js';
async function withDb<T>(fn: (db: Awaited<ReturnType<typeof createTestPrismaClient>>) => Promise<T>): Promise<T> {
  const db = await createTestPrismaClient();
  try {
    return await fn(db);
  } finally {
    await db.$disconnect();
  }
}
it('t', async () => { expect(await withDb(async () => 1)).toBe(1); });
`],
  ['each-parameter named like a handle (no TEST resource)', `import { it, expect } from 'vitest';
const fake = { $disconnect: async () => undefined };
it.each([fake])('t', async (db) => {
  await db.$disconnect();
  expect(db).toBeDefined();
});
`],
  ['local mock shadowing the acquirer name', `import { it, expect, vi } from 'vitest';
it('t', async () => {
  const openSeedDatabase = vi.fn();
  await Promise.resolve({ openSeedDatabase: openSeedDatabase as unknown });
  expect(openSeedDatabase).not.toHaveBeenCalled();
});
`],
  ['two describes, each with its own canonical handle', `${P}
describe('a', () => {
  let db: PrismaClient | undefined;
  beforeAll(async () => { db = await createTestPrismaClient(); });
  afterAll(async () => db?.$disconnect());
  it('t', () => expect(db).toBeDefined());
});
describe('b', () => {
  let db: PrismaClient | undefined;
  beforeAll(async () => { db = await createTestPrismaClient(); });
  afterAll(async () => { await db?.$disconnect(); });
  it('t', () => expect(db).toBeDefined());
});
`],
  ['unrelated non-TEST PrismaClient', `import { it } from 'vitest';
import { PrismaClient } from '../src/generated/prisma/client.js';
it('t', async () => {
  const prisma = new PrismaClient({} as never);
  await prisma.$disconnect();
});
`],
];

// Safe code the contract deliberately rejects: rewrite it into a canonical form.
const rejectedByDesign: Array<[string, string]> = [
  ['if-block guard for a Prisma handle', suiteFixture(`afterAll(async () => { if (db) { await db.$disconnect(); } });`)],
  ['returning the release from a block body', suiteFixture(`afterAll(async () => { return db?.$disconnect(); });`)],
  ['release wrapped in try/catch inside the hook', suiteFixture(`afterAll(async () => { try { await db?.$disconnect(); } catch { /* ignore */ } });`)],
  ['statement before the release in finally', inlineFixture(`  const db = await createTestPrismaClient();\n  try {\n    expect(db).toBeDefined();\n  } finally {\n    vi.restoreAllMocks();\n    await db.$disconnect();\n  }`)],
  ['optional chaining on a const inline handle', inlineFixture(`  const db = await createTestPrismaClient();\n  try {\n    expect(db).toBeDefined();\n  } finally {\n    await db?.$disconnect();\n  }`)],
];

const fixture = (text: string) => scan({ path: 'tests/fixture.test.ts', text });

describe('cleanup contract: the scanner rejects every non-canonical TEST lifecycle', () => {
  it.each(unsafe)('rejects: %s', (_name, text) => {
    expect(fixture(text).violations.length).toBeGreaterThan(0);
  });

  it.each(rejectedByDesign)('rejects (safe but non-canonical, fail-closed): %s', (_name, text) => {
    expect(fixture(text).violations.length).toBeGreaterThan(0);
  });

  it.each(safe)('accepts: %s', (_name, text) => {
    expect(fixture(text).violations).toEqual([]);
  });

  it('the hermetic exemption is path-scoped and void once a required mock is removed', () => {
    const mocks = `import { vi } from 'vitest';\nvi.mock('pg', () => ({}));\nvi.mock('dotenv', () => ({}));\nvi.mock('node:fs', () => ({}));\n`;
    const leak = `import { createTestPrismaClient } from './helpers/test-db.js';\nexport const leak = async () => { await createTestPrismaClient(); };\n`;
    expect(scan({ path: 'tests/test-db-guard.test.ts', text: mocks + leak }).exempt).toBe(true);
    expect(scan({ path: 'tests/other.test.ts', text: mocks + leak }).violations.length).toBeGreaterThan(0);
    const partial = mocks.replace("vi.mock('dotenv', () => ({}));\n", '');
    expect(scan({ path: 'tests/test-db-guard.test.ts', text: partial + leak }).violations.length).toBeGreaterThan(0);
  });
});

describe('teardown never assumes setup succeeded (real suite)', () => {
  const results = testSources().map(scan);

  it('every TEST acquisition and release in tests/** is canonical', () => {
    expect(results.flatMap((r) => r.violations)).toEqual([]);
  });

  it('only the documented hermetic file is exempt', () => {
    const exempt = results.filter((r) => r.exempt).length;
    expect(exempt).toBe(HERMETIC.size);
  });

  it('the scanner sees the real suite (not an empty or mis-rooted file set)', () => {
    expect(results.length).toBeGreaterThan(40);
    expect(results.reduce((n, r) => n + r.suiteHandles, 0)).toBeGreaterThan(30);
    expect(results.reduce((n, r) => n + r.inlineHandles, 0)).toBeGreaterThan(0);
  });
});

// Task 4: suite tests acquire their seed database through the automated selector
// (`openSeedDatabase('automated-test', ...)`), never by pinning hosted TEST, so
// MONA_TEST_DATABASE_TARGET=local cannot reach hosted TEST from the suite. Only a
// direct string-literal first argument is judged: aliases and indirection are
// already rejected by the cleanup contract above, and a computed target (the
// globalSetup routing of its once-resolved selector) is out of this rule's reach.
// The hermetic file is exempt because it exercises the explicit targets on purpose.
type HostedTargetScan = { violations: string[]; calls: number };

function hostedTargetAcquisitions({ path, text }: Source): HostedTargetScan {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const result: HostedTargetScan = { violations: [], calls: 0 };
  if (hermetic(path, source)) return result;
  each(source, (node) => {
    if (!isIdent(node, 'openSeedDatabase') || inType(node)) return;
    const call = node.parent;
    if (!ts.isCallExpression(call) || call.expression !== node) return;
    const decl = resolve(node);
    if (decl && !ts.isImportSpecifier(decl) && !ts.isBindingElement(decl)) return; // a local mock, not the acquirer
    result.calls += 1;
    const target = call.arguments[0] && unwrap(call.arguments[0]);
    if (target && ts.isStringLiteralLike(target) && target.text === 'test') {
      const line = source.getLineAndCharacterOfPosition(call.getStart(source)).line + 1;
      result.violations.push(`${path}:${line} openSeedDatabase('test') must be openSeedDatabase('automated-test', ...)`);
    }
  });
  return result;
}

describe('integration test database acquisition follows automated target routing', () => {
  const hosted: Array<[string, string]> = [
    ['single-quoted hosted target', SEED(`afterAll(async () => {\n    if (db) await safely(() => db.close());\n  });`)],
    ['double-quoted hosted target', `import { openSeedDatabase } from '../scripts/demo-database.js';\nexport const x = () => openSeedDatabase("test");\n`],
    ['template-literal hosted target', 'import { openSeedDatabase } from \'../scripts/demo-database.js\';\nexport const x = () => openSeedDatabase(`test`);\n'],
    ['multiline hosted target with a source argument', `import { openSeedDatabase } from '../scripts/demo-database.js';\nexport const x = () =>\n  openSeedDatabase(\n    'test',\n    process.env,\n  );\n`],
    ['hosted target inside a wrapper helper', `import { openSeedDatabase } from '../scripts/demo-database.js';\nexport async function open() {\n  return openSeedDatabase('test');\n}\n`],
  ];
  const allowed: Array<[string, string]> = [
    ['automated target', `import { openSeedDatabase } from '../scripts/demo-database.js';\nexport const x = () => openSeedDatabase('automated-test');\n`],
    ['automated target with a source argument', `import { openSeedDatabase } from '../scripts/demo-database.js';\nexport const x = () => openSeedDatabase('automated-test', process.env);\n`],
    ['hosted call only in a comment', `import { openSeedDatabase } from '../scripts/demo-database.js';\n// openSeedDatabase('test')\nexport const x = () => openSeedDatabase('automated-test');\n`],
    ['hosted call only in a fixture string', `export const fixture = "openSeedDatabase('test')";\n`],
    ['local mock shadowing the acquirer name', `import { vi } from 'vitest';\nconst openSeedDatabase = vi.fn();\nopenSeedDatabase('test');\n`],
    ['computed target (globalSetup routing shape)', `import { openSeedDatabase } from '../scripts/demo-database.js';\nexport const x = (t: string) => openSeedDatabase(t === 'local' ? 'local-test' : 'test', process.env);\n`],
  ];
  const fixtureTargets = (text: string) => hostedTargetAcquisitions({ path: 'tests/fixture.test.ts', text });

  it.each(hosted)('rejects: %s', (_name, text) => {
    expect(fixtureTargets(text).violations).toHaveLength(1);
  });

  it.each(allowed)('accepts: %s', (_name, text) => {
    expect(fixtureTargets(text).violations).toEqual([]);
  });

  it('the hermetic file may exercise the explicit hosted target', () => {
    const mocks = `import { vi } from 'vitest';\nvi.mock('pg', () => ({}));\nvi.mock('dotenv', () => ({}));\nvi.mock('node:fs', () => ({}));\n`;
    const call = `import { openSeedDatabase } from '../scripts/demo-database.js';\nexport const x = () => openSeedDatabase('test');\n`;
    expect(hostedTargetAcquisitions({ path: 'tests/test-db-guard.test.ts', text: mocks + call }).violations).toEqual([]);
    expect(hostedTargetAcquisitions({ path: 'tests/other.test.ts', text: mocks + call }).violations).toHaveLength(1);
  });

  it('no suite test pins hosted TEST', () => {
    const results = testSources().map(hostedTargetAcquisitions);
    expect(results.reduce((n, r) => n + r.calls, 0)).toBeGreaterThan(0);
    expect(results.flatMap((r) => r.violations)).toEqual([]);
  });
});

// Task 4: suite tests consume a prepared database; they never prepare it. No
// executable code under tests/** may launch the Prisma CLI's migration/schema
// commands (`migrate *`, `db *`): that belongs to the explicit prepare layer.
// A child_process API is recognised through its static import (named, renamed,
// namespace or default); its command must be static literals (process.execPath
// counts as `node`), otherwise it fails closed because the scanner cannot prove
// it is not Prisma. Loading child_process dynamically, or using an API as a
// value, fails closed too. Other spawners (execa, zx, worker_threads) are not
// recognised.
const CHILD_PROCESS_MODULES = new Set(['child_process', 'node:child_process']);
const CHILD_PROCESS_APIS = new Set(['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork']);
const SHELL_APIS = new Set(['exec', 'execSync']);
const PRISMA_OWNED_BY_PREPARE = new Set(['migrate', 'db']);

const moduleOf = (decl: ts.Node): string | undefined => {
  let n: ts.Node | undefined = decl;
  while (n && !ts.isImportDeclaration(n)) n = n.parent;
  return n && ts.isStringLiteral(n.moduleSpecifier) ? n.moduleSpecifier.text : undefined;
};

const isPrismaEntry = (token: string): boolean =>
  token === 'prisma' || token.startsWith('prisma@') || token.endsWith('/prisma') || token.endsWith('prisma/build/index.js');

// The command a child_process call runs, as whitespace-split static tokens, or
// null when any part of it is not a static literal.
function commandTokens(api: string, args: ts.NodeArray<ts.Expression>): string[] | null {
  const words = (node: ts.Expression): string[] | null => {
    const x = unwrap(node);
    if (ts.isStringLiteralLike(x)) return x.text.split(/\s+/).filter(Boolean);
    if (ts.isPropertyAccessExpression(x) && isIdent(x.expression, 'process') && x.name.text === 'execPath') return ['node'];
    return null;
  };
  const [command, argv] = args;
  const head = command ? words(command) : null;
  if (!head) return null;
  if (SHELL_APIS.has(api) || !argv || ts.isObjectLiteralExpression(unwrap(argv))) return head;
  const list = unwrap(argv);
  if (!ts.isArrayLiteralExpression(list)) return null;
  const tokens = [...head];
  for (const element of list.elements) {
    const w = ts.isSpreadElement(element) ? null : words(element);
    if (!w) return null;
    tokens.push(...w);
  }
  return tokens;
}

// D4B CASE 1: a dynamic child_process import may be accepted only when the
// file structurally proves that, BEFORE any use, it replaced that exact module
// with a complete hermetic vi.mock sentinel: the vi.mock is a top-level
// statement naming the module exactly, its factory returns an object literal
// supplying every API the file accesses through the dynamic import, and each
// supplied sentinel is a process-free function expression (no identifier
// inside it resolves back to a child_process import). Anything less fails
// closed — text in comments or strings proves nothing.
function sentinelMockObject(sourceFile: ts.SourceFile, moduleName: string): ts.ObjectLiteralExpression | undefined {
  for (const raw of sourceFile.statements) {
    // `vi.mock(...)` at the top level is an ExpressionStatement wrapping the
    // call — unwrap it before checking the call shape.
    const statement = ts.isExpressionStatement(raw) ? raw.expression : raw;
    if (!ts.isCallExpression(statement)) continue;
    if (!ts.isPropertyAccessExpression(statement.expression) || !isIdent(statement.expression.expression, 'vi')) continue;
    if (statement.expression.name.text !== 'mock') continue;
    const target = statement.arguments[0];
    const factory = statement.arguments[1];
    if (!target || !ts.isStringLiteralLike(target) || target.text !== moduleName || !factory || !isFn(factory)) continue;
    // `() => ({ ... })` wraps the object literal in a ParenthesizedExpression.
    const body = unwrap(factory.body as ts.Expression);
    if (ts.isObjectLiteralExpression(body)) return body;
    if (ts.isBlock(factory.body)) {
      for (const inner of factory.body.statements) {
        if (ts.isReturnStatement(inner) && inner.expression && ts.isObjectLiteralExpression(inner.expression)) return inner.expression;
      }
    }
  }
  return undefined;
}

const mockProvides = (object: ts.ObjectLiteralExpression): Map<string, ts.Expression> => {
  const map = new Map<string, ts.Expression>();
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = property.name;
    if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) map.set(name.text, property.initializer);
  }
  return map;
};

const sentinelIsProcessFree = (fn: ts.Node): boolean => {
  // R21/R22: a sentinel may delegate to local helpers; inertness must be
  // proven at every hop. A delegation chain that reaches a child_process
  // import anywhere fails closed; a bodyless (overload-style) declaration
  // cannot be proven and also fails closed.
  const visited = new Set<ts.Node>();
  const provablyInert = (node: ts.Node): boolean => {
    if (visited.has(node)) return true;
    visited.add(node);
    let ok = true;
    each(node, (inner) => {
      if (!ok) return;
      if (ts.isCallExpression(inner) && ts.isIdentifier(inner.expression)) {
        const callee = resolve(inner.expression);
        if (callee && ts.isImportSpecifier(callee) && CHILD_PROCESS_MODULES.has(moduleOf(callee) ?? '')) {
          ok = false;
          return;
        }
        if (callee && ts.isFunctionDeclaration(callee)) {
          ok = !!callee.body && provablyInert(callee.body);
          return;
        }
        if (callee && ts.isVariableDeclaration(callee) && callee.initializer && isFn(callee.initializer)) {
          ok = provablyInert(callee.initializer.body);
          return;
        }
        return;
      }
      if (ts.isIdentifier(inner)) {
        const decl = resolve(inner);
        if (decl && ts.isImportSpecifier(decl) && CHILD_PROCESS_MODULES.has(moduleOf(decl) ?? '')) ok = false;
      }
    });
    return ok;
  };
  return provablyInert(fn);
};

// The child_process API names this file accesses through dynamic imports of
// the module: `m.spawn` property accesses and destructured bindings.
function dynamicallyImportedApis(sourceFile: ts.SourceFile): Set<string> {
  const apis = new Set<string>();
  const dynamicImport = (node: ts.VariableDeclaration): boolean => {
    if (!node.initializer) return false;
    // `const m = await import('...')` wraps the call in an AwaitExpression.
    let init = ts.isAwaitExpression(node.initializer) ? node.initializer.expression : node.initializer;
    init = unwrap(init);
    if (!ts.isCallExpression(init) || init.expression.kind !== ts.SyntaxKind.ImportKeyword) return false;
    const target = init.arguments[0];
    return !!target && ts.isStringLiteralLike(target) && CHILD_PROCESS_MODULES.has(target.text);
  };
  each(sourceFile, (node) => {
    if (!ts.isVariableDeclaration(node) || !dynamicImport(node)) return;
    if (ts.isIdentifier(node.name)) {
      // Several dynamic imports may reuse the same local name: only property
      // accesses that resolve to THIS child_process declaration count.
      for (const ref of references(sourceFile, node.name.text)) {
        if (resolve(ref) !== node) continue;
        if (ts.isPropertyAccessExpression(ref.parent) && ref.parent.expression === ref) apis.add(ref.parent.name.text);
      }
    } else {
      for (const element of node.name.elements) {
        if (!ts.isOmittedExpression(element) && ts.isIdentifier(element.name)) apis.add(element.name.text);
      }
    }
  });
  return apis;
}

// D4B CASE 2: finite, derived-from-source safe PostgreSQL tooling. Absolute-
// path pg_dump/pg_restore only — prisma, npx, node, shells and any relative or
// computed executable are outside the set.
const SAFE_PG_TOOL = /^\/usr\/lib\/postgresql\/\d+\/bin\/(pg_dump|pg_restore)$/;

// Resolves a relative import specifier from `fromPath` to a scanned source
// path ('.js' normalized to '.ts'), or undefined when it cannot be proven.
function resolveImportedPath(fromPath: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const out: string[] = [];
  for (const segment of `${fromPath.slice(0, fromPath.lastIndexOf('/'))}/${specifier}`.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length === 0) return undefined;
      out.pop();
      continue;
    }
    out.push(segment);
  }
  let resolved = out.join('/');
  if (resolved.endsWith('.js')) resolved = `${resolved.slice(0, -3)}.ts`;
  return resolved;
}

const parsedSource = (source: Source): ts.SourceFile =>
  ts.createSourceFile(source.path, source.text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

// Statically resolves an expression to a string literal: directly, through a
// file-level const, or through a named import of a file-level const in
// another scanned source. Undefined whenever it cannot be proven.
function staticString(sourceFile: ts.SourceFile, path: string, expression: ts.Expression | undefined, pool: Source[]): string | undefined {
  const node = expression ? unwrap(expression) : undefined;
  if (!node) return undefined;
  if (ts.isStringLiteralLike(node)) return node.text;
  if (!ts.isIdentifier(node)) return undefined;
  const decl = resolve(node);
  if (!decl) return undefined;
  if (ts.isVariableDeclaration(decl) && decl.initializer) {
    const init = unwrap(decl.initializer);
    if (ts.isStringLiteralLike(init)) return init.text;
  }
  if (ts.isImportSpecifier(decl)) {
    const importedPath = resolveImportedPath(path, moduleOf(decl) ?? '');
    if (!importedPath) return undefined;
    const imported = pool.find((candidate) => candidate.path === importedPath);
    if (!imported) return undefined;
    const name = (decl.propertyName ?? decl.name).text;
    const importedFile = importedPath === path ? sourceFile : parsedSource(imported);
    for (const statement of importedFile.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (!isIdent(declaration.name, name) || !declaration.initializer) continue;
        const init = unwrap(declaration.initializer);
        if (ts.isStringLiteralLike(init)) return init.text;
      }
    }
  }
  return undefined;
}

// D4B CASE 2: a child_process call with a non-literal command may be the R4
// finite PostgreSQL tooling wrapper: a top-level function that forwards one
// of its own parameters as the executable, whose EVERY suite-wide call site
// statically resolves to a safe finite tool (pg_restore sites additionally
// require the list-only '--list' literal inside their argv array). Zero call
// sites, or any unprovable site, stays fail-closed.
function finiteToolWrapper(call: ts.CallExpression, api: string, sourceFile: ts.SourceFile, path: string, suite: Source[]): boolean {
  if (SHELL_APIS.has(api)) return false;
  let wrapper: ts.FunctionDeclaration | undefined;
  for (let n: ts.Node | undefined = call.parent; n; n = n.parent) {
    if (n.parent === sourceFile && ts.isFunctionDeclaration(n)) {
      wrapper = n;
      break;
    }
  }
  if (!wrapper?.name) return false;
  const rawExecutable = call.arguments[0] ? unwrap(call.arguments[0]) : undefined;
  if (!rawExecutable || !ts.isIdentifier(rawExecutable)) return false;
  const parameter = resolve(rawExecutable);
  if (!parameter || !ts.isParameter(parameter) || parameter.parent !== wrapper) return false;
  const pool = suite.length > 0 ? suite : [{ path, text: sourceFile.text }];
  let sites = 0;
  let proven = true;
  for (const other of pool) {
    const otherFile = other.path === path ? sourceFile : parsedSource(other);
    each(otherFile, (node) => {
      if (!proven || !ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return;
      const decl = resolve(node.expression);
      const callsWrapper =
        (other.path === path && decl === wrapper) ||
        (decl !== undefined &&
          ts.isImportSpecifier(decl) &&
          (decl.propertyName ?? decl.name).text === wrapper.name!.text &&
          resolveImportedPath(other.path, moduleOf(decl) ?? '') === path);
      if (!callsWrapper) return;
      sites += 1;
      const tool = staticString(otherFile, other.path, node.arguments[0], pool);
      if (!tool || !SAFE_PG_TOOL.test(tool)) {
        proven = false;
        return;
      }
      if (tool.endsWith('/pg_restore')) {
        const rawArgv = node.arguments[1] ? unwrap(node.arguments[1]) : undefined;
        const argvList = rawArgv && ts.isArrayLiteralExpression(rawArgv) ? rawArgv : undefined;
        const listOnly =
          !!argvList &&
          argvList.elements.some((element) => {
            const value = ts.isSpreadElement(element) ? undefined : unwrap(element);
            return !!value && ts.isStringLiteralLike(value) && value.text === '--list';
          });
        if (!listOnly) proven = false;
      }
    });
  }
  return proven && sites > 0;
}

function prismaCliLaunches({ path, text }: Source, suite: Source[] = []): string[] {
  // Every static or dynamic child_process load names the module literally.
  if (!text.includes('child_process')) return [];
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const bound = new Set<string>();
  for (const s of source.statements) {
    if (!ts.isImportDeclaration(s) || !s.importClause || !CHILD_PROCESS_MODULES.has(moduleOf(s) ?? '')) continue;
    const { name, namedBindings } = s.importClause;
    if (name) bound.add(name.text);
    if (namedBindings && ts.isNamespaceImport(namedBindings)) bound.add(namedBindings.name.text);
    if (namedBindings && ts.isNamedImports(namedBindings)) for (const el of namedBindings.elements) bound.add(el.name.text);
  }
  const violations: string[] = [];
  const at = (node: ts.Node, why: string) =>
    violations.push(`${path}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1} ${why}`);

  const classify = (call: ts.CallExpression, api: string) => {
    const tokens = commandTokens(api, call.arguments);
    if (!tokens) {
      if (finiteToolWrapper(call, api, source, path, suite)) return; // D4B: proven finite pg tooling
      return at(call, `${api} with a non-literal command/argv (cannot prove it is not the Prisma CLI)`);
    }
    const entry = tokens.findIndex(isPrismaEntry);
    if (entry === -1) return;
    const rest = tokens.slice(entry + 1);
    const sub = rest.findIndex((t) => PRISMA_OWNED_BY_PREPARE.has(t));
    if (sub !== -1) at(call, `${api} launches \`prisma ${rest.slice(sub, sub + 2).join(' ')}\` (${tokens[entry]})`);
  };

  each(source, (node) => {
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword || isIdent(node.expression, 'require')) &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      CHILD_PROCESS_MODULES.has(node.arguments[0].text)
    ) {
      const moduleName = node.arguments[0].text;
      const mockObject = sentinelMockObject(source, moduleName);
      if (!mockObject) {
        return at(node, `child_process loaded dynamically without a complete hermetic vi.mock('${moduleName}') sentinel`);
      }
      const apis = dynamicallyImportedApis(source);
      const provides = mockProvides(mockObject);
      const missing = [...apis].filter((api) => !provides.has(api));
      if (missing.length > 0) {
        return at(node, `child_process loaded dynamically; the hermetic mock does not supply ${missing.join(', ')}`);
      }
      const unsafe = [...apis].filter((api) => provides.has(api)).filter((api) => {
        const sentinel = provides.get(api) as ts.Expression;
        return !isFn(sentinel) || !sentinelIsProcessFree(sentinel);
      });
      if (unsafe.length > 0) {
        return at(node, `child_process loaded dynamically; the sentinel for ${unsafe.join(', ')} is not a process-free function`);
      }
      return; // D4B: complete hermetic sentinel proven — the capability is replaced before any use
    }
    if (!ts.isIdentifier(node) || !bound.has(node.text) || isMemberName(node) || isDeclarationName(node) || inType(node)) return;
    const decl = resolve(node);
    if (!decl || !CHILD_PROCESS_MODULES.has(moduleOf(decl) ?? '')) return;
    const p = node.parent;
    if (ts.isImportSpecifier(decl)) {
      const api = (decl.propertyName ?? decl.name).text;
      if (!CHILD_PROCESS_APIS.has(api)) return;
      if (!ts.isCallExpression(p) || p.expression !== node) return at(node, `child_process ${api} used as a value`);
      return classify(p, api);
    }
    // Namespace or default import: only `ns.api(...)` is recognised.
    if (ts.isPropertyAccessExpression(p) && p.expression === node) {
      const api = p.name.text;
      if (!CHILD_PROCESS_APIS.has(api)) return;
      if (!ts.isCallExpression(p.parent) || p.parent.expression !== p) return at(p, `child_process ${api} used as a value`);
      return classify(p.parent, api);
    }
    at(node, 'child_process module used other than through a direct `ns.api(...)` call');
  });
  return violations;
}

describe('suite tests never invoke the Prisma migration CLI', () => {
  const NAMED = `import { exec, execFile, execFileSync, execSync, spawn, spawnSync } from 'node:child_process';\n`;
  const launches: Array<[string, string]> = [
    ['seed.test shape: execFileSync(process.execPath, [prisma/build/index.js, migrate, deploy])', `${NAMED}execFileSync(\n  process.execPath,\n  ['./node_modules/prisma/build/index.js', 'migrate', 'deploy'],\n  { cwd: '.', stdio: 'pipe' },\n);\n`],
    ['async execFile of the entry point', `${NAMED}execFile(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], () => undefined);\n`],
    ['spawnSync of .bin/prisma', `${NAMED}spawnSync('node_modules/.bin/prisma', ['migrate', 'deploy']);\n`],
    ['spawn migrate status', `${NAMED}spawn('./node_modules/.bin/prisma', ['migrate', 'status']);\n`],
    ['execSync through npx', `${NAMED}execSync('npx prisma migrate deploy');\n`],
    ['exec through pnpm (migrate reset)', `${NAMED}exec('pnpm prisma migrate reset --force');\n`],
    ['template-literal shell command (migrate resolve)', `${NAMED}execSync(\`npx prisma migrate resolve --applied x\`);\n`],
    ['multiline argv with flags before the subcommand (migrate dev)', `${NAMED}spawnSync('npx', [\n  'prisma',\n  '--schema',\n  'prisma/schema.prisma',\n  'migrate',\n  'dev',\n]);\n`],
    ['db push through a renamed import', `import { execFileSync as run } from 'child_process';\nrun('npx', ['prisma', 'db', 'push']);\n`],
    ['namespace import', `import * as cp from 'node:child_process';\ncp.execFileSync('npx', ['prisma', 'migrate', 'deploy']);\n`],
    ['default import', `import cp from 'child_process';\ncp.spawnSync('npx', ['prisma', 'migrate', 'deploy']);\n`],
    ['call inside a skipped test', `import { it } from 'vitest';\n${NAMED}it.skip('t', () => { execSync('npx prisma migrate deploy'); });\n`],
    ['spread argv (fail-closed)', `${NAMED}const args = ['migrate', 'deploy'];\nexecFileSync('npx', ['prisma', ...args]);\n`],
    ['wrapper with non-literal command (fail-closed)', `${NAMED}export function run(cmd: string, argv: string[]) { return execFileSync(cmd, argv); }\n`],
    ['template literal with a substitution (fail-closed)', `${NAMED}const sub = 'deploy';\nexecSync(\`npx prisma migrate \${sub}\`);\n`],
    ['API used as a value', `${NAMED}const run = execFileSync;\nrun('npx', ['prisma', 'migrate', 'deploy']);\n`],
    ['element access on the namespace', `import * as cp from 'node:child_process';\ncp['execFileSync']('npx', ['prisma', 'migrate', 'deploy']);\n`],
    ['dynamic import of child_process', `export async function x() {\n  const { execFileSync } = await import('node:child_process');\n  execFileSync('npx', ['prisma', 'migrate', 'deploy']);\n}\n`],
  ];
  const allowed: Array<[string, string]> = [
    ['command only in a comment', `${NAMED}// execFileSync(process.execPath, ['./node_modules/prisma/build/index.js', 'migrate', 'deploy'])\nexport const x = 1;\n`],
    ['command only in a fixture string', `${NAMED}export const fixture = "execSync('npx prisma migrate deploy')";\n`],
    ['unrelated process whose argv mentions migrate', `${NAMED}execFileSync('git', ['log', '--grep', 'migrate']);\n`],
    ['unrelated node script named like a migration', `${NAMED}spawnSync(process.execPath, ['scripts/migrate-legacy-data.mjs'], { stdio: 'pipe' });\n`],
    ['non-migration Prisma command', `${NAMED}execFileSync('npx', ['prisma', 'validate']);\n`],
    ['local fake shadowing the imported API', `${NAMED}export function f() {\n  const execFileSync = (..._args: unknown[]) => undefined;\n  execFileSync('npx', ['prisma', 'migrate', 'deploy']);\n}\n`],
    ['type-only child_process import', `import type { ChildProcess } from 'node:child_process';\nexport let child: ChildProcess | undefined;\n`],
  ];
  const fixtureLaunches = (text: string) => prismaCliLaunches({ path: 'tests/fixture.test.ts', text });

  it.each(launches)('rejects: %s', (_name, text) => {
    expect(fixtureLaunches(text)).toHaveLength(1);
  });

  it.each(allowed)('accepts: %s', (_name, text) => {
    expect(fixtureLaunches(text)).toEqual([]);
  });

  it('no suite code launches a Prisma migration/schema command', () => {
    const sources = testSources();
    expect(sources.length).toBeGreaterThan(40);
    expect(sources.flatMap((source) => prismaCliLaunches(source, sources))).toEqual([]);
  });

  // D4B: the hermetic child_process sentinel class (dynamic imports).
  it('S12 accepts a dynamic import under a complete top-level hermetic sentinel vi.mock', () => {
    const mock =
      `vi.mock('node:child_process', () => ({ spawn: () => trip('spawn'), exec: () => trip('exec'), execFile: () => trip('execFile'), default: {} }));\n` +
      `const trip = (what: string) => { throw new Error(what); };\n`;
    const use = `export async function probe() { const m = await import('node:child_process'); return (m.spawn as unknown as () => unknown)(); }\n`;
    expect(fixtureLaunches(mock + use)).toEqual([]);
    // S31: prisma-looking argv under a complete sentinel is inert — the
    // sentinel replaces the capability, so nothing can launch.
    const evilArgs = `export async function probe() { const m = await import('node:child_process'); return (m.execFile as unknown as (...a: unknown[]) => unknown)('npx', ['prisma', 'migrate', 'deploy']); }\n`;
    expect(fixtureLaunches(mock + evilArgs)).toEqual([]);
  });

  it('S10/S11/S26/S27/S29 reject dynamic imports the sentinel cannot structurally prove', () => {
    const use = `export async function probe() { const m = await import('node:child_process'); return (m.spawn as unknown as () => unknown)(); }\n`;
    // S10: no mock at all.
    expect(fixtureLaunches(use)).toHaveLength(1);
    // S11/M05/M10: used API not supplied by the mock.
    expect(fixtureLaunches(`vi.mock('node:child_process', () => ({ exec: () => trip('exec') }));\n` + use)).toHaveLength(1);
    // S26/M06: vi.mock text only inside a comment proves nothing.
    expect(fixtureLaunches(`// vi.mock('node:child_process', () => ({ spawn: () => trip('spawn') }))\n` + use)).toHaveLength(1);
    // S27: supplied value is not a process-free function expression.
    expect(fixtureLaunches(`vi.mock('node:child_process', () => ({ spawn: 1 }));\n` + use)).toHaveLength(1);
    // S29: mock of a different module name than the dynamically imported one.
    expect(fixtureLaunches(`vi.mock('child_process', () => ({ spawn: () => trip('spawn') }));\n` + use)).toHaveLength(1);
    // S28: sentinel value references a child_process import.
    expect(
      fixtureLaunches(
        `import { spawn as realSpawn } from 'node:child_process';\n` +
          `vi.mock('node:child_process', () => ({ spawn: realSpawn }));\n` +
          use,
      ).length,
    ).toBeGreaterThan(0);
  });

  // D4B: the finite PostgreSQL tool wrapper class (non-literal executables).
  const wrapperSource: Source = {
    path: 'tests/wrap.ts',
    text:
      `import { spawn } from 'node:child_process';\n` +
      `export function runTool(bin: string, args: readonly string[], env: NodeJS.ProcessEnv) {\n` +
      `  return new Promise((resolve) => { const child = spawn(bin, [...args], { env }); child.on('close', (code) => resolve(code)); });\n` +
      `}\n`,
  };
  const toolsSource: Source = {
    path: 'tests/tools.ts',
    text:
      `export const PG_DUMP = '/usr/lib/postgresql/17/bin/pg_dump';\n` +
      `export const PG_RESTORE = '/usr/lib/postgresql/17/bin/pg_restore';\n`,
  };
  const wrapperSuite = (callerText: string, extra: Source[] = []): Source[] => [
    wrapperSource,
    toolsSource,
    { path: 'tests/caller.test.ts', text: callerText },
    ...extra,
  ];
  const wrapperLaunches = (suite: Source[]) => prismaCliLaunches(wrapperSource, suite);
  const importLine = `import { runTool } from './wrap.js';\nimport { PG_DUMP, PG_RESTORE } from './tools.js';\n`;

  it('S14/S15/S18 accept the finite pg wrapper when every call site proves a safe executable and list-only restore', () => {
    // S14: every site resolves to the pg_dump literal.
    expect(
      wrapperLaunches(wrapperSuite(`import { runTool } from './wrap.js';\nimport { PG_DUMP } from './tools.js';\nawait runTool(PG_DUMP, ['--schema=public'], {});\nawait runTool(PG_DUMP, ['--schema=public'], {});\n`)),
    ).toEqual([]);
    // S15/S18: pg_restore sites carry the '--list' literal among (possibly spread) argv elements.
    expect(
      wrapperLaunches(
        wrapperSuite(
          `import { runTool } from './wrap.js';\nimport { PG_DUMP, PG_RESTORE } from './tools.js';\n` +
            `const connArgs = ['--host=x'] as const;\n` +
            `await runTool(PG_DUMP, ['--format=custom', ...connArgs], {});\n` +
            `await runTool(PG_RESTORE, [...connArgs, '--list', 'archive'], {});\n`,
        ),
      ),
    ).toEqual([]);
  });

  it('S13/S16/S17/S30 and non-list restore reject the wrapper whenever the executable domain cannot be proven', () => {
    // S13/S17: zero call sites (suite without any caller) stays fail-closed.
    expect(wrapperLaunches([wrapperSource, toolsSource])).toHaveLength(1);
    // S16: a call site resolving to a prisma executable.
    expect(
      wrapperLaunches(wrapperSuite(`${importLine}const PRISMA = './node_modules/.bin/prisma';\nawait runTool(PRISMA, ['migrate', 'deploy'], {});\n`)),
    ).toHaveLength(1);
    // S30: a call site whose executable cannot be statically resolved.
    expect(
      wrapperLaunches(wrapperSuite(`${importLine}const computed = ['pg_dump'].join('');\nawait runTool(computed, ['--list'], {});\n`)),
    ).toHaveLength(1);
    // pg_restore without the list-only literal.
    expect(
      wrapperLaunches(wrapperSuite(`${importLine}await runTool(PG_RESTORE, ['--clean', 'archive'], {});\n`)),
    ).toHaveLength(1);
    // A safe-looking but non-finite executable outside the derived set.
    expect(
      wrapperLaunches(wrapperSuite(`${importLine}const LOCAL = '/usr/local/bin/tool';\nawait runTool(LOCAL, ['--list'], {});\n`)),
    ).toHaveLength(1);
  });

  // D4C independent adversarial review: "what other ordinary way can someone
  // launch the same command?" (R01–R25, preregistered before execution).
  it('R01–R03, R19, R20 reject alias chains, namespace destructuring, require, assembled and template shell commands', () => {
    expect(fixtureLaunches(`import { spawn as s1 } from 'node:child_process';\nconst s2 = s1;\n`)).toHaveLength(1); // R01
    expect(fixtureLaunches(`import * as cp from 'node:child_process';\nconst { spawn } = cp;\n`)).toHaveLength(1); // R02
    expect(fixtureLaunches(`const cp = require('node:child_process');\n`)).toHaveLength(1); // R03
    expect(fixtureLaunches(`${NAMED}const CMD = 'npx prisma';\nexecSync(CMD + ' migrate deploy');\n`)).toHaveLength(1); // R19
    expect(fixtureLaunches(`${NAMED}execSync(\`npx prisma migrate deploy\`);\n`)).toHaveLength(1); // R20
  });

  it('R04 a computed module string is invisible to the scanner (documented pre-existing boundary)', () => {
    const computed = `const mod = 'node:child' + '_process';\nexport async function x() { const m = await import(mod); return (m.exec as unknown as () => unknown)(); }\n`;
    expect(fixtureLaunches(computed)).toEqual([]); // R04: no literal module name anywhere
  });

  it('R05/R07–R11/R14 reject unprovable executable domains at wrapper call sites', () => {
    // R05: an outer wrapper forwarding its own parameter to the spawn wrapper
    // leaves the inner executable unprovable.
    const outerFile: Source = {
      path: 'tests/outer.ts',
      text: `import { runTool } from './wrap.js';\nexport function outerTool(bin: string, args: readonly string[], env: NodeJS.ProcessEnv) { return runTool(bin, args, env); }\n`,
    };
    expect(
      wrapperLaunches(
        [wrapperSource, toolsSource, outerFile, { path: 'tests/caller.test.ts', text: `import { outerTool } from './outer.js';\nimport { PG_DUMP } from './tools.js';\nawait outerTool(PG_DUMP, ['--schema=public'], {});\n` }],
      ),
    ).toHaveLength(1);
    const flag = 'const flag = true;\n';
    expect(wrapperLaunches(wrapperSuite(`${importLine}${flag}await runTool(flag ? PG_DUMP : PG_RESTORE, ['--schema=public'], {});\n`))).toHaveLength(1); // R07
    expect(wrapperLaunches(wrapperSuite(`${importLine}const tools2 = [PG_DUMP];\nawait runTool(tools2[0], ['--schema=public'], {});\n`))).toHaveLength(1); // R08
    const middleFile: Source = { path: 'tests/middle.ts', text: `export { PG_DUMP } from './tools.js';\n` };
    expect(
      wrapperLaunches(
        [wrapperSource, toolsSource, middleFile, { path: 'tests/caller.test.ts', text: `import { runTool } from './wrap.js';\nimport { PG_DUMP } from './middle.js';\nawait runTool(PG_DUMP, ['--schema=public'], {});\n` }],
      ),
    ).toHaveLength(1); // R09: re-export chains are beyond the one-hop proof
    expect(wrapperLaunches(wrapperSuite(`${importLine}let tool = PG_DUMP;\ntool = PG_RESTORE;\nawait runTool(tool, ['--list'], {});\n`))).toHaveLength(1); // R10
    expect(wrapperLaunches(wrapperSuite(`${importLine}const LIST = '--list';\nawait runTool(PG_RESTORE, [LIST, 'archive'], {});\n`))).toHaveLength(1); // R11
    expect(wrapperLaunches(wrapperSuite(`import { runTool } from './wrap.js';\nawait runTool('./node_modules/.bin/prisma', ['migrate', 'deploy'], {});\n`))).toHaveLength(1); // R14
  });

  it('R06/R12/R13 accept the proven-safe classes: import alias, list-mode restore, dynamic pg_dump args', () => {
    expect(wrapperLaunches(wrapperSuite(`import { runTool as rt } from './wrap.js';\nimport { PG_DUMP } from './tools.js';\nawait rt(PG_DUMP, ['--schema=public'], {});\n`))).toEqual([]); // R06
    expect(wrapperLaunches(wrapperSuite(`${importLine}await runTool(PG_RESTORE, ['--list', '--clean', 'archive'], {});\n`))).toEqual([]); // R12: --list is list-only mode; data flags are inert there
    expect(wrapperLaunches(wrapperSuite(`${importLine}const file = ['out'].join('');\nawait runTool(PG_DUMP, ['--file=' + file, '--schema=public'], {});\n`))).toEqual([]); // R13
  });

  it('R15–R18 reject every normalized Prisma launcher shape', () => {
    expect(fixtureLaunches(`${NAMED}spawnSync('npx', ['prisma', '--schema', 'x', 'migrate', 'deploy']);\n`)).toHaveLength(1); // R15
    expect(fixtureLaunches(`${NAMED}execFileSync(process.execPath, ['./node_modules/prisma/build/index.js', 'migrate', 'status']);\n`)).toHaveLength(1); // R16
    expect(fixtureLaunches(`${NAMED}execSync('npx --yes prisma migrate deploy');\n`)).toHaveLength(1); // R17
    expect(fixtureLaunches(`${NAMED}exec('pnpm exec prisma db push');\n`)).toHaveLength(1); // R18
  });

  it('R21 accepts a sentinel delegating to a proven-inert local helper', () => {
    const mock = `vi.mock('node:child_process', () => ({ spawn: () => relay('spawn'), default: {} }));\nconst relay = (what: string) => { throw new Error(what); };\n`;
    const use = `export async function probe() { const m = await import('node:child_process'); return (m.spawn as unknown as () => unknown)(); }\n`;
    expect(fixtureLaunches(mock + use)).toEqual([]);
  });

  it('R22 rejects a sentinel whose delegation chain reaches a child_process import', () => {
    const mock =
      `import { spawn as realSpawn } from 'node:child_process';\n` +
      `const relay = () => realSpawn('x');\n` +
      `vi.mock('node:child_process', () => ({ spawn: () => relay('x'), default: {} }));\n`;
    const use = `export async function probe() { const m = await import('node:child_process'); return (m.spawn as unknown as () => unknown)(); }\n`;
    expect(fixtureLaunches(mock + use)).toHaveLength(1);
  });

  it('R23/R24 reject default-only and mixed incomplete sentinel mocks', () => {
    const use = `export async function probe() { const m = await import('node:child_process'); return (m.spawn as unknown as () => unknown)(); }\n`;
    expect(fixtureLaunches(`vi.mock('node:child_process', () => ({ default: {} }));\n` + use)).toHaveLength(1); // R23
    expect(fixtureLaunches(`vi.mock('node:child_process', () => ({ exec: () => trip('exec'), default: {} }));\n` + use)).toHaveLength(1); // R24
  });

  it('R25 accepts a local function shadowing the imported spawn', () => {
    expect(
      fixtureLaunches(`${NAMED}export function f() { const spawn = (..._args: unknown[]) => undefined; spawn('npx', ['prisma', 'migrate', 'deploy']); }\n`),
    ).toEqual([]); // R25
  });
});

describe('Prisma test-client cleanup semantics (installed @prisma/client + adapter-pg, no network)', () => {
  // Same ownership shape as createTestPrismaClient: the adapter gets a pool
  // configuration and creates/ends its own pg.Pool. Port 9 on loopback inside a
  // network namespace: nothing is ever dialled because no query is issued.
  function counted() {
    const factory = new PrismaPg({ connectionString: 'postgresql://u:p@127.0.0.1:9/x' });
    const ends: number[] = [];
    const connect = factory.connect.bind(factory);
    factory.connect = async () => {
      const adapter = await connect();
      const pool = adapter.underlyingDriver() as unknown as { end: () => Promise<void> };
      const index = ends.push(0) - 1;
      const end = pool.end.bind(pool);
      pool.end = async () => {
        ends[index]! += 1;
        return end();
      };
      return adapter;
    };
    return { prisma: new PrismaClient({ adapter: factory, log: [] }), ends };
  }

  it('connected client: $disconnect() ends its pool exactly once; a second $disconnect() is a no-op', async () => {
    const { prisma, ends } = counted();
    await prisma.$connect();
    await prisma.$disconnect();
    await prisma.$disconnect();
    expect(ends).toEqual([1]);
  });

  it('never-connected client: $disconnect() creates and ends nothing', async () => {
    const { prisma, ends } = counted();
    await prisma.$disconnect();
    await prisma.$disconnect();
    expect(ends).toEqual([]);
  });

  it('reconnect after disconnect gets a fresh pool, each ended exactly once', async () => {
    const { prisma, ends } = counted();
    await prisma.$connect();
    await prisma.$disconnect();
    await prisma.$connect();
    await prisma.$disconnect();
    expect(ends).toEqual([1, 1]);
  });
});
