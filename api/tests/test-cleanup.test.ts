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
