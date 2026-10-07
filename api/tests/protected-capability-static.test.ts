// V2.3.3 R4: STATIC class-level gates over the real sources (TypeScript compiler API, not grep of known-bad strings).
//   G11–G14, G40, G48  no new client/pool/adapter, no pool.connect, no nested $transaction, no transaction-control or session SET,
//                      no child process / dynamic import / computed member call reachable from a protected step
//   C23/AC-148/192     the fingerprint and runtime modules have no fs / child_process / console egress
//   C22/AC-189         R4 modules throw only constant-message errors
//   LOW-9/AC-190/191   no Prisma query/params logging on safety paths
//   LOW-3/AC-195       every executable entry goes through the start guard
//   AC-090/213/218/220 no path from the outcome/reconcile/authorize tools to seed, restore or authorization creation
// Remediation 1: reachability is SEMANTIC (TypeChecker): property-access calls, aliases, destructuring, callbacks, `this`/`super`, re-exports,
// implementers/overriders and classes are resolved to source bodies and traversed; targets that cannot be resolved are rejected (see the long
// comment above `FORBIDDEN_CLASS_RULES`). 70 preregistered fixtures (tests/fixtures/property-access) + virtual synthetic mutants pin it.
// Every rule has a POSITIVE CONTROL: a fixture (tests/fixtures/protected-escape) that contains exactly one forbidden construct
// and MUST be reported — a checker that cannot see the construct would pass the real sources vacuously.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';
import { PROTECTED_SEARCH_PATH } from '../scripts/local-test-fingerprint.js';

const API = path.resolve(__dirname, '..');
const REPO = path.resolve(API, '..');
const DB_SCRIPTS = path.join(REPO, 'scripts', 'database');
const read = (file: string) => readFileSync(file, 'utf8');
const parse = (file: string) => ts.createSourceFile(file, read(file), ts.ScriptTarget.ES2023, true, file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);

type Finding = { rule: string; fn: string; file: string; pos: number };
type FnInfo = { name: string; node: ts.Node; body: ts.Node; file: string; sf: ts.SourceFile };

const unwrap = (e: ts.Expression): ts.Expression => {
  let cur = e;
  for (;;) {
    if (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isNonNullExpression(cur) || ts.isTypeAssertionExpression(cur) || ts.isSatisfiesExpression(cur)) cur = cur.expression;
    else return cur;
  }
};

function collectFunctions(sf: ts.SourceFile): FnInfo[] {
  const out: FnInfo[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isFunctionDeclaration(n) && n.name && n.body) out.push({ name: n.name.text, node: n, body: n.body, file: sf.fileName, sf });
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) {
      out.push({ name: n.name.text, node: n, body: n.initializer.body, file: sf.fileName, sf });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}
const childProcessNames = (sf: ts.SourceFile): Set<string> => {
  const names = new Set<string>();
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier) && /^(node:)?child_process$/.test(st.moduleSpecifier.text) && st.importClause?.namedBindings && ts.isNamedImports(st.importClause.namedBindings)) {
      for (const el of st.importClause.namedBindings.elements) names.add(el.name.text);
    }
  }
  return names;
};

const TX_CONTROL = /^\s*(BEGIN|START|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|RESET|LOCK|DISCARD)\b/i;
const PLAIN_SET = /^\s*SET\s+(?!LOCAL\b)/i;
const SET_LOCAL = /^\s*SET\s+LOCAL\b/i;
const SET_SEARCH_PATH = /\bSET\s+(?:(?:LOCAL|SESSION)\s+)?search_path\b/i;
function literalText(n: ts.Node): string | null {
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  if (ts.isTemplateExpression(n)) return n.head.text + n.templateSpans.map((s) => s.literal.text).join('');
  return null;
}
function logOption(n: ts.NewExpression): 'none' | 'empty' | 'nonEmpty' {
  const arg = n.arguments?.[0] ? unwrap(n.arguments[0]) : undefined;
  if (!arg || !ts.isObjectLiteralExpression(arg)) return 'none';
  const prop = arg.properties.find((p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'log') as ts.PropertyAssignment | undefined;
  if (!prop) return 'none';
  const v = unwrap(prop.initializer);
  return ts.isArrayLiteralExpression(v) && v.elements.length === 0 ? 'empty' : 'nonEmpty';
}

// ---- semantic reachability (remediation 1) -----------------------------------------------------------------------------------------
// Question answered: "from a protected root, which SOURCE-DEFINED executable bodies can ordinary code reach?"  The answer comes from the
// TypeScript TypeChecker (symbols, aliases, destructuring, overriders), never from the spelling of a property name:
//   * every reference (call OR value) to a project-source function/method/accessor/class/initialised variable or property inside a reachable
//     body makes the target reachable (callbacks, aliases, `bind`, registries, re-exports, namespaces, default exports, `this`/`super`);
//   * a member reached through an interface/base type also reaches every project member of the same name whose type is assignable to the
//     receiver type (implementers and overriders);
//   * a call whose target cannot be resolved to a body is rejected, never skipped: `any`, function-typed values with no body
//     (unresolvedCall), project interface members with no implementer in the program (bodylessTarget), non-literal computed keys
//     (dynamicComputed);
//   * calls into external declarations (node_modules, lib, the generated client) are allowed only through a narrow positive policy:
//     they are not traversed, and an expression whose TYPE is a forbidden client/pool class (or a subclass of one) is rejected wherever
//     it appears (forbiddenType), as is any call into child_process declarations.
// Supported boundary (documented in STATIC-ANALYSIS of the remediation packet): object spread, destructuring (object patterns), aliases
// through variables/properties/parameters-with-bodies, bind/call/apply, optional chains, static string keys, re-exports and namespace imports.
// Not followed: values stored in a container that is populated by UNREACHABLE code and read back through a bodyless function type (this is
// rejected as unresolvedCall instead), and array-pattern destructuring of functions (rejected if the signature has no body).
const FORBIDDEN_CLASS_RULES: Readonly<Record<string, string>> = { PrismaClient: 'newPrismaClient', PrismaPg: 'newPrismaPg', Pool: 'newPool', Client: 'newClient', PoolClient: 'newClient' };
const EXTERNAL_FILE = /[\\/]node_modules[\\/]|[\\/]src[\\/]generated[\\/]/;
const isExternalFile = (sf: ts.SourceFile) => sf.isDeclarationFile || EXTERNAL_FILE.test(sf.fileName);
// Positive policy for project-local BODYLESS declarations a protected step may call (exact declaration identity "file:Container.member").
// Each entry must be justified; anything else bodyless is rejected.
const BODYLESS_ALLOW: ReadonlyMap<string, string> = new Map<string, string>([
  ['local-test-fingerprint.ts:Reader.$queryRawUnsafe', 'single reviewed internal raw adapter; callers pass ProtectedReadSpec, never SQL statement text, and the adapter builds finite read SQL internally'],
  ['local-test-baseline.ts:PasswordStateFn()', 'injected pure comparator (hash string in, state out); its production default seedPasswordState is source-defined, is reached by reference and is scanned'],
]);

type Env = { program: ts.Program; checker: ts.TypeChecker; members: Map<string, { node: ts.Node; container: ts.Node }[]> };
let envCache: Env | undefined;
const SCAN_ROOTS = (): string[] => [
  ...['local-test-fingerprint.ts', 'local-test-baseline.ts', 'demo-database.ts'].map((f) => path.join(API, 'scripts', f)),
  path.join(API, 'prisma', 'seed.ts'), path.join(API, 'src', 'modules', 'rbac', 'catalog.service.ts'),
  ...['protected-escape', 'property-access'].flatMap((d) => readdirSync(path.join(API, 'tests', 'fixtures', d)).filter((f) => f.endsWith('.ts')).map((f) => path.join(API, 'tests', 'fixtures', d, f))),
];
// `virtual` overlays in-memory sources (synthetic mutants) on the real file system: nothing is written to disk.
function buildEnv(roots: string[], virtual: Readonly<Record<string, string>> = {}): Env {
  const cfg = ts.readConfigFile(path.join(API, 'tsconfig.check.json'), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, API);
  const options = { ...parsed.options, noEmit: true, incremental: false };
  const host = ts.createCompilerHost(options, true);
  const getSourceFile = host.getSourceFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const readFile = host.readFile.bind(host);
  host.getSourceFile = (f, ...rest) => (virtual[f] !== undefined ? ts.createSourceFile(f, virtual[f] as string, rest[0], true) : getSourceFile(f, ...rest));
  host.fileExists = (f) => virtual[f] !== undefined || fileExists(f);
  host.readFile = (f) => virtual[f] ?? readFile(f);
  const program = ts.createProgram(roots, options, host);
  const checker = program.getTypeChecker();
  const members = new Map<string, { node: ts.Node; container: ts.Node }[]>();
  const fnLike = (n: ts.Node | undefined) => !!n && (ts.isArrowFunction(n) || ts.isFunctionExpression(n));
  for (const sf of program.getSourceFiles()) {
    if (isExternalFile(sf)) continue;
    const visit = (n: ts.Node) => {
      const isStatic = (ts.canHaveModifiers(n) ? ts.getModifiers(n) : undefined)?.some((m) => m.kind === ts.SyntaxKind.StaticKeyword);
      if (!isStatic && (ts.isMethodDeclaration(n) || ts.isGetAccessor(n) || ts.isSetAccessor(n) || (ts.isPropertyDeclaration(n) && fnLike(n.initializer)) || (ts.isPropertyAssignment(n) && fnLike(n.initializer)))) {
        const nm = n.name;
        if (nm && (ts.isIdentifier(nm) || ts.isStringLiteral(nm) || ts.isNoSubstitutionTemplateLiteral(nm))) members.set(nm.text, [...(members.get(nm.text) ?? []), { node: n, container: n.parent }]);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return { program, checker, members };
}
function env(): Env {
  envCache ??= buildEnv(SCAN_ROOTS());
  return envCache;
}

function analyse(roots: { file: string; name: string }[], using: Env = env()): { findings: Finding[]; reachable: Set<string>; allowUsed: Set<string> } {
  const { program, checker, members } = using;
  // implementers/overriders are only looked up inside the import closure of the roots (other fixtures/modules cannot supply a body)
  const closure = new Set<string>();
  const closeOver = (file: string) => {
    if (closure.has(file)) return;
    closure.add(file);
    const sf = program.getSourceFile(file);
    if (!sf) return;
    for (const st of sf.statements) {
      const spec = (ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) ? st.moduleSpecifier.text : undefined;
      const target = spec ? ts.resolveModuleName(spec, file, program.getCompilerOptions(), ts.sys).resolvedModule?.resolvedFileName : undefined;
      if (target && !EXTERNAL_FILE.test(target) && !target.endsWith('.d.ts')) closeOver(target);
    }
  };
  for (const r of roots) closeOver(r.file);
  const found = new Map<string, Finding>();
  const reachable = new Set<string>();
  const allowUsed = new Set<string>();
  const done = new Set<ts.Node>();
  const queue: ts.Node[] = [];
  const enqueue = (n: ts.Node) => { if (!done.has(n)) { done.add(n); queue.push(n); } };
  const enclosingName = (n: ts.Node): string => {
    for (let p: ts.Node | undefined = n; p; p = p.parent) {
      if ((ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p) || ts.isClassDeclaration(p)) && p.name) return p.name.getText();
      if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
    }
    return '<module>';
  };
  const enclosingFunction = (n: ts.Node): string => {
    for (let p: ts.Node | undefined = n; p; p = p.parent) if ((ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)) && p.name) return p.name.getText();
    return '<module>';
  };
  const add = (rule: string, at: ts.Node) => {
    const sf = at.getSourceFile();
    const k = `${rule}:${sf.fileName}:${at.getStart()}`;
    if (!found.has(k)) found.set(k, { rule, fn: enclosingName(at), file: sf.fileName, pos: at.getStart() });
  };
  const hasBody = (d: ts.Node): boolean => (ts.isFunctionLike(d) && !!(d as ts.FunctionLikeDeclaration).body) || ts.isClassLike(d);
  const aliased = (s: ts.Symbol): ts.Symbol => {
    if (!(s.flags & ts.SymbolFlags.Alias)) return s;
    try { return checker.getAliasedSymbol(s); } catch { return s; }
  };
  const bindingDecls = (be: ts.BindingElement): ts.Declaration[] => {
    const pattern = be.parent;
    if (!ts.isObjectBindingPattern(pattern)) return [];
    const key = be.propertyName ?? be.name;
    const text = ts.isIdentifier(key) || ts.isStringLiteral(key) ? key.text : undefined;
    const prop = text === undefined ? undefined : checker.getTypeAtLocation(pattern).getProperty(text);
    return prop ? [...(prop.declarations ?? [])] : [];
  };
  const staticKey = (el: ts.ElementAccessExpression): boolean => {
    const arg = el.argumentExpression;
    if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return true;
    return (checker.getTypeAtLocation(arg).flags & ts.TypeFlags.StringLiteral) !== 0;
  };
  const nameNodeOf = (n: ts.Node): ts.Node | undefined => {
    if (ts.isIdentifier(n)) return n;
    if (ts.isPropertyAccessExpression(n)) return n.name;
    if (ts.isElementAccessExpression(n) && staticKey(n)) return n.argumentExpression;
    return undefined;
  };
  // implementers / overriders: project members of the same name whose containing type is assignable to the receiver's type
  const overriders = (access: ts.PropertyAccessExpression | ts.ElementAccessExpression, direct: ts.Node[]): ts.Node[] => {
    const nm = ts.isPropertyAccessExpression(access) ? access.name.text : (access.argumentExpression as ts.StringLiteral).text;
    const receiver = checker.getApparentType(checker.getTypeAtLocation(access.expression));
    const out: ts.Node[] = [];
    for (const c of members.get(nm) ?? []) {
      if (direct.includes(c.node) || !closure.has(c.node.getSourceFile().fileName)) continue;
      let ct: ts.Type | undefined;
      if (ts.isClassDeclaration(c.container) && c.container.name) { const s = checker.getSymbolAtLocation(c.container.name); ct = s ? checker.getDeclaredTypeOfSymbol(s) : undefined; }
      else if (ts.isObjectLiteralExpression(c.container)) ct = checker.getTypeAtLocation(c.container);
      if (ct && checker.isTypeAssignableTo(ct, receiver)) out.push(c.node);
    }
    return out;
  };
  const declsOf = (n: ts.Node): ts.Node[] => {
    const nameNode = nameNodeOf(n);
    if (!nameNode) return [];
    let sym = checker.getSymbolAtLocation(nameNode);
    if (!sym) return [];
    sym = aliased(sym);
    const out: ts.Node[] = [];
    for (const d of sym.declarations ?? []) {
      if (ts.isBindingElement(d)) out.push(...bindingDecls(d));
      else if (ts.isShorthandPropertyAssignment(d)) { const v = checker.getShorthandAssignmentValueSymbol(d); out.push(...(v ? aliased(v).declarations ?? [] : [])); }
      else out.push(d);
    }
    if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) out.push(...overriders(n, out));
    return out;
  };
  const processDecl = (d: ts.Node): void => {
    if (isExternalFile(d.getSourceFile())) return;
    if (ts.isClassDeclaration(d) || ts.isClassExpression(d)) {
      for (const m of d.members) {
        if (ts.isConstructorDeclaration(m) && m.body) enqueue(m);
        else if (ts.isPropertyDeclaration(m) && m.initializer) enqueue(m.initializer);
        else if (ts.isClassStaticBlockDeclaration(m)) enqueue(m);
      }
      const sym = d.name ? checker.getSymbolAtLocation(d.name) : undefined;
      if (sym) for (const b of checker.getBaseTypes(checker.getDeclaredTypeOfSymbol(sym) as ts.InterfaceType)) for (const bd of b.getSymbol()?.declarations ?? []) processDecl(bd);
      return;
    }
    if (ts.isFunctionLike(d)) { if ((d as ts.FunctionLikeDeclaration).body) enqueue(d); return; }
    if ((ts.isVariableDeclaration(d) || ts.isPropertyAssignment(d) || ts.isPropertyDeclaration(d)) && d.initializer) enqueue(d.initializer);
  };
  const forbiddenClass = (t: ts.Type): { name: string; direct: boolean } | undefined => {
    if (t.isUnion()) { for (const u of t.types) { const h = forbiddenClass(u); if (h) return h; } return undefined; }
    const sym = t.getSymbol();
    if (!sym) return undefined;
    const declared = checker.getDeclaredTypeOfSymbol(sym);
    if (t !== declared && (t as ts.TypeReference).target !== declared) return undefined; // the constructor (static) side is not an instance
    const external = (sym.declarations ?? []).some((d) => isExternalFile(d.getSourceFile()));
    if (external && FORBIDDEN_CLASS_RULES[sym.getName()]) return { name: sym.getName(), direct: true };
    if (sym.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Interface)) {
      for (const b of checker.getBaseTypes(declared as ts.InterfaceType)) { const h = forbiddenClass(b); if (h) return { name: h.name, direct: false }; }
    }
    return undefined;
  };
  const inTypePosition = (n: ts.Node) => ts.isTypeNode(n.parent) || ts.isQualifiedName(n.parent) || ts.isTypeQueryNode(n.parent);
  const bodylessKey = (decl: ts.Node): string => {
    const d = ts.isFunctionTypeNode(decl) && ts.isPropertySignature(decl.parent) ? decl.parent : decl; // `{ m: (…) => … }`: the member is the identity
    const file = path.basename(d.getSourceFile().fileName);
    if (ts.isFunctionTypeNode(d) && ts.isTypeAliasDeclaration(d.parent)) return `${file}:${d.parent.name.text}()`;
    const owner = ts.isTypeElement(d) || ts.isClassElement(d) ? d.parent : undefined;
    let cname = '<none>';
    if (owner && (ts.isInterfaceDeclaration(owner) || ts.isClassLike(owner))) cname = owner.name?.text ?? '<anonymous>';
    else if (owner && ts.isTypeLiteralNode(owner)) cname = ts.isTypeAliasDeclaration(owner.parent) ? owner.parent.name.text : `<anonymous in ${enclosingFunction(d)}>`;
    const mname = (d as { name?: ts.Node }).name?.getText() ?? '<call>';
    return `${file}:${cname}.${mname}`;
  };
  const callCheck = (call: ts.CallExpression, callee: ts.Expression) => {
    if (callee.kind === ts.SyntaxKind.SuperKeyword) {
      for (const d of checker.getTypeAtLocation(callee).getSymbol()?.declarations ?? []) processDecl(d);
      return;
    }
    const decl = checker.getResolvedSignature(call)?.declaration;
    if (decl && isExternalFile(decl.getSourceFile())) { if (/child_process/.test(decl.getSourceFile().fileName)) add('childProcess', call); return; }
    if (!decl) { add('unresolvedCall', call); return; }
    if (hasBody(decl)) return;
    if (declsOf(callee).some(hasBody)) return; // overload signature / interface member with a body-bearing implementer
    const allowKey = bodylessKey(decl);
    if (BODYLESS_ALLOW.has(allowKey)) { allowUsed.add(allowKey); return; }
    add(ts.isMethodSignature(decl) || ts.isPropertySignature(decl) ? 'bodylessTarget' : 'unresolvedCall', call);
  };
  // eval / Function(...) / new Function(...) build executable code from a string: no body exists to traverse, so they are rejected outright
  const isGlobalDynamicCode = (e: ts.Expression): boolean => {
    if (!ts.isIdentifier(e) || (e.text !== 'eval' && e.text !== 'Function')) return false;
    return (checker.getSymbolAtLocation(e)?.declarations ?? []).every((d) => d.getSourceFile().isDeclarationFile);
  };
  const rawMemberName = (callee: ts.Expression): string | null => {
    if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
    if (ts.isElementAccessExpression(callee) && staticKey(callee)) {
      const arg = callee.argumentExpression;
      return ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg) ? arg.text : null;
    }
    return null;
  };
  const isRawPrismaMember = (name: string | null): boolean => name === '$queryRaw' || name === '$queryRawUnsafe' || name === '$executeRaw' || name === '$executeRawUnsafe';
  const enclosingCallableName = (n: ts.Node): string => {
    for (let p: ts.Node | undefined = n; p; p = p.parent) {
      if ((ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)) && p.name) return p.name.getText();
      if ((ts.isArrowFunction(p) || ts.isFunctionExpression(p)) && ts.isVariableDeclaration(p.parent) && ts.isIdentifier(p.parent.name)) return p.parent.name.text;
    }
    return '<module>';
  };
  const insideApprovedRawAdapter = (n: ts.Node): boolean =>
    path.basename(n.getSourceFile().fileName) === 'local-test-fingerprint.ts' && enclosingCallableName(n) === 'readProtectedRows';
  const scanNode = (root: ts.Node) => {
    const cp = childProcessNames(root.getSourceFile());
    const visit = (n: ts.Node) => {
      if (ts.isNewExpression(n) && isGlobalDynamicCode(unwrap(n.expression))) add('dynamicCode', n);
      if (ts.isNewExpression(n)) {
        const hit = forbiddenClass(checker.getTypeAtLocation(n));
        const text = unwrap(n.expression).getText();
        if (hit) add(hit.direct ? (FORBIDDEN_CLASS_RULES[hit.name] as string) : 'forbiddenType', n);
        else if (/(^|\.)PrismaClient$/.test(text)) add('newPrismaClient', n);
        else if (/(^|\.)PrismaPg$/.test(text)) add('newPrismaPg', n);
        else if (/(^|\.)Pool$/.test(text)) add('newPool', n);
        else if (/(^|\.)Client$/.test(text)) add('newClient', n);
        if (/(^|\.)PrismaClient$/.test(text) && logOption(n) === 'nonEmpty') add('logQuery', n);
        for (const d of declsOf(unwrap(n.expression))) processDecl(d);
      }
      if (ts.isCallExpression(n)) {
        const callee = unwrap(n.expression);
        const rawName = rawMemberName(callee);
        if (isRawPrismaMember(rawName) && !insideApprovedRawAdapter(n)) add('rawSqlCapability', n);
        if (ts.isPropertyAccessExpression(callee)) {
          const name = callee.name.text;
          if (name === 'connect' || name === '$connect' || name === '$disconnect') add('connect', n);
          if (name === '$transaction') add('transaction', n);
          if (name === '$on' || name === '$use' || name === '$extends') add('clientLifecycle', n);
        }
        if (ts.isElementAccessExpression(callee) && !staticKey(callee)) add('dynamicComputed', n);
        if (isGlobalDynamicCode(callee)) add('dynamicCode', n);
        if (callee.kind === ts.SyntaxKind.ImportKeyword) add('dynamicImport', n);
        else {
          if (ts.isIdentifier(callee) && callee.text === 'require') add('require', n);
          if (ts.isIdentifier(callee) && cp.has(callee.text)) add('childProcess', n);
          if (!(ts.isElementAccessExpression(callee) && !staticKey(callee)) && !(isRawPrismaMember(rawName) && !insideApprovedRawAdapter(n))) callCheck(n, callee);
        }
      }
      const text = literalText(n);
      if (text !== null) {
        if (TX_CONTROL.test(text)) add('txControl', n);
        if (PLAIN_SET.test(text)) add('plainSet', n);
        if (SET_LOCAL.test(text)) add('setLocal', n);
        if (SET_SEARCH_PATH.test(text)) add('setSearchPath', n);
        if (/set_config\s*\(/i.test(text)) add('setConfig', n);
      }
      const isRef = ts.isIdentifier(n) || ts.isPropertyAccessExpression(n) || (ts.isElementAccessExpression(n) && staticKey(n));
      if (isRef && !inTypePosition(n) && !(ts.isIdentifier(n) && ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)) for (const d of declsOf(n)) processDecl(d);
      const typed = ts.isIdentifier(n) || ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n) || ts.isCallExpression(n) || n.kind === ts.SyntaxKind.ThisKeyword;
      if (typed && !inTypePosition(n) && forbiddenClass(checker.getTypeAtLocation(n))) add('forbiddenType', n);
      ts.forEachChild(n, visit);
    };
    visit(root);
  };

  for (const r of roots) {
    const sf = program.getSourceFile(r.file);
    const info = sf ? collectFunctions(sf).find((f) => f.name === r.name) : undefined;
    if (!info) throw new Error(`root ${r.name} not found in ${r.file}`);
    enqueue(info.node);
  }
  while (queue.length) {
    const node = queue.shift() as ts.Node;
    const sf = node.getSourceFile();
    const nm = ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) ? node.name?.getText() : ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) ? node.name.text : undefined;
    const pv = ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name) ? node.parent.name.text : undefined;
    for (const k of [nm, pv]) if (k) reachable.add(`${path.basename(sf.fileName)}:${k}`);
    scanNode(node);
  }
  return { findings: [...found.values()], reachable, allowUsed };
}
const rulesOf = (findings: Finding[]) => [...new Set(findings.map((f) => f.rule))].sort();
// building the TypeScript program over the roots is the slow part (seconds); do it once, before any test
beforeAll(() => { env(); }, 240_000);

const FIXTURES = path.join(API, 'tests', 'fixtures', 'protected-escape');
const fixtureRoots = (file: string) => collectFunctions(parse(file)).map((f) => ({ file, name: f.name }));
// Expectations were refined by remediation 1 (semantic checker): fixtures now call through the real ProtectedTx/Pool types so each still has ONE
// forbidden construct; findings that the stronger checker adds on the same construct are listed explicitly (plain-set: the SET also names search_path;
// pool-connect: the receiver is typed pg.Pool; nested-transaction: the structural cast has no declaration to follow).
const EXPECTED: Record<string, string[]> = {
  'new-prisma-client.ts': ['newPrismaClient'], 'new-prisma-pg.ts': ['newPrismaPg'], 'new-pool.ts': ['newPool'], 'new-client.ts': ['newClient'], 'pool-connect.ts': ['connect', 'forbiddenType'],
  'nested-transaction.ts': ['transaction', 'unresolvedCall'], 'begin-sql.ts': ['rawSqlCapability', 'txControl'], 'commit-template.ts': ['txControl'], 'plain-set.ts': ['plainSet', 'rawSqlCapability', 'setSearchPath'], 'set-config.ts': ['rawSqlCapability', 'setConfig'],
  'child-process.ts': ['childProcess'], 'dynamic-import.ts': ['dynamicImport'], 'computed-member.ts': ['dynamicComputed'], 'log-query.ts': ['logQuery', 'newPrismaClient'], 'clean.ts': [],
};

describe('positive controls: the checker reports every forbidden construct (AC-091..097)', () => {
  for (const [file, expected] of Object.entries(EXPECTED)) {
    it(`${file} ⇒ ${expected.length ? expected.join(', ') : 'no finding'}`, () => {
      const full = path.join(FIXTURES, file);
      expect(rulesOf(analyse(fixtureRoots(full)).findings)).toEqual([...expected].sort());
    });
  }
  it('every fixture file is covered by an expectation (a new fixture cannot be forgotten)', () => {
    expect(readdirSync(FIXTURES).sort()).toEqual(Object.keys(EXPECTED).sort());
  });
});

describe('the real protected steps (G11–G14, G40, G48, AC-091..098)', () => {
  const fingerprint = path.join(API, 'scripts', 'local-test-fingerprint.ts');
  const roots = [
    { file: path.join(API, 'scripts', 'demo-database.ts'), name: 'proveIdentityOnTransaction' },
    { file: path.join(API, 'scripts', 'local-test-baseline.ts'), name: 'readFactsOnTransaction' },
    { file: path.join(API, 'scripts', 'local-test-baseline.ts'), name: 'verifyTransformation' },
    { file: path.join(API, 'prisma', 'seed.ts'), name: 'seedDemoOnTransaction' },
    { file: fingerprint, name: 'proveSettingsOnTransaction' },
    { file: fingerprint, name: 'proveDomainOnTransaction' },
    { file: fingerprint, name: 'readStateOnTransaction' },
  ];
  let result: ReturnType<typeof analyse>;
  beforeAll(() => { result = analyse(roots); }, 180_000);

  it('AC-091..097 nothing reachable from a protected step constructs a client/pool/adapter, connects, nests a transaction, controls the transaction, sets a session value, spawns, imports dynamically or calls a computed member', () => {
    expect(result.findings.map((f) => `${f.rule} ${path.basename(f.file)}:${ts.getLineAndCharacterOfPosition(env().program.getSourceFile(f.file) as ts.SourceFile, f.pos).line + 1} in ${f.fn}`)).toEqual([]);
  });
  it('every positive-policy allowance is used by the real roots (no dead or speculative allowance), and each has a stated justification', () => {
    expect([...result.allowUsed].sort()).toEqual([...BODYLESS_ALLOW.keys()].sort());
    for (const why of BODYLESS_ALLOW.values()) expect(why.length).toBeGreaterThan(30);
  });
  it('the analysis really reached the helpers (a reachability that stops at the root would pass vacuously)', () => {
    for (const k of ['seed.ts:seedDemoOnTransaction', 'seed.ts:seedOnTransaction', 'seed.ts:populate', 'seed.ts:convergeCanonicalScopes', 'catalog.service.ts:syncProductionRbacCatalog',
      'local-test-baseline.ts:readSnapshotOnTransaction', 'local-test-baseline.ts:factsFromSnapshot', 'local-test-baseline.ts:verifyTransformation', 'local-test-fingerprint.ts:readStateOnTransaction',
      'local-test-fingerprint.ts:readProtectedRows', 'demo-database.ts:proveIdentityOnTransaction', 'demo-database.ts:assertLocalTestIdentityRows']) {
      expect(result.reachable.has(k), k).toBe(true);
    }
  });
  it('AC-105/G40 the in-transaction identity proof never reaches the connection-level proof (which issues BEGIN/COMMIT/ROLLBACK)', () => {
    expect(result.reachable.has('demo-database.ts:proveLocalTestIdentity')).toBe(false);
    expect(result.reachable.has('demo-database.ts:openProvenLocalTestPool')).toBe(false);
    expect(result.reachable.has('demo-database.ts:openProvenLocalTestLifecycle')).toBe(false);
  });
  it('AC-098 every step function takes the branded ProtectedTx as its first parameter', () => {
    for (const r of roots.filter((x) => x.name !== 'verifyTransformation')) {
      const info = collectFunctions(parse(r.file)).find((f) => f.name === r.name) as FnInfo;
      const fn = (ts.isFunctionDeclaration(info.node) ? info.node : (info.node as ts.VariableDeclaration).initializer) as ts.FunctionLikeDeclaration;
      expect(fn.parameters[0]?.type?.getText(), r.name).toBe('ProtectedTx');
    }
  });
  it('the step modules import no PrismaClient/pg/adapter value (type-only imports are allowed) outside the opener functions of demo-database.ts', () => {
    for (const file of [fingerprint, path.join(API, 'scripts', 'local-test-baseline.ts'), path.join(API, 'prisma', 'seed.ts')]) {
      for (const st of parse(file).statements) {
        if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
        const spec = st.moduleSpecifier.text;
        if (spec === 'pg' || spec === '@prisma/adapter-pg' || /generated\/prisma\/client/.test(spec)) expect(st.importClause?.isTypeOnly, `${path.basename(file)} imports ${spec}`).toBe(true);
      }
    }
  });
});

// Remediation 2: raw SQL bodyless allowance must be class-level safe. Protected callers may not receive an
// arbitrary `sql: string` capability to `$queryRawUnsafe`; the only accepted raw Prisma use is the reviewed internal
// read adapter that builds SQL from source-defined operation specs.
describe('raw SQL capability boundary (remediation 2 preregistered cases)', () => {
  const dir = path.join(API, 'tests', 'fixtures', 'property-access');
  const fileOf = (name: string) => path.join(dir, `${name}.ts`);
  const HEAD = "import type { ProtectedTx } from '../../../scripts/local-test-fingerprint.js';\n";
  const CASES: ReadonlyArray<readonly [string, string, string]> = [
    ['raw-direct-delete', 'rawSqlCapability', "export function root(tx: ProtectedTx) { return tx.$queryRawUnsafe('DELETE FROM \"Brand\"'); }"],
    ['raw-direct-select', 'rawSqlCapability', "export function root(tx: ProtectedTx) { return tx.$queryRawUnsafe('SELECT 1'); }"],
    ['raw-wrapper-dynamic', 'rawSqlCapability', "function query(tx: ProtectedTx, sql: string) { return tx.$queryRawUnsafe(sql); }\nexport function root(tx: ProtectedTx, sql: string) { return query(tx, sql); }"],
    ['raw-wrapper-helper-string', 'rawSqlCapability', "const sql = () => 'UPDATE \"Brand\" SET \"name\" = \"name\"';\nconst reader = { run(tx: ProtectedTx, text: string) { return tx.$queryRawUnsafe(text); } };\nexport function root(tx: ProtectedTx) { return reader.run(tx, sql()); }"],
    ['raw-alias-wrapper', 'rawSqlCapability', "const reader = { q(tx: ProtectedTx, sql: string) { return tx.$queryRawUnsafe(sql); } };\nconst alias = reader.q;\nexport function root(tx: ProtectedTx, sql: string) { return alias(tx, sql); }"],
  ];
  let rawEnv: Env;
  beforeAll(() => {
    const virtual: Record<string, string> = {};
    for (const [name, , body] of CASES) virtual[fileOf(name)] = `${HEAD}${body}\n`;
    rawEnv = buildEnv([...SCAN_ROOTS(), ...Object.keys(virtual)], virtual);
  }, 240_000);
  for (const [name, expected] of CASES) {
    it(`${name} is rejected (${expected})`, () => {
      expect(rulesOf(analyse([{ file: fileOf(name), name: 'root' }], rawEnv).findings)).toContain(expected);
    });
  }
});

describe('egress, errors and logging (C22/C23, AC-148/189/190/191/192)', () => {
  const tsModules = ['local-test-fingerprint.ts', 'local-test-runtime.ts'].map((f) => path.join(API, 'scripts', f));
  it('AC-148/192 the fingerprint and runtime modules import no fs/child_process/net/http and never touch console or process.stdout/stderr', () => {
    for (const file of tsModules) {
      const sf = parse(file);
      for (const st of sf.statements) {
        if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) expect(st.moduleSpecifier.text, `${path.basename(file)} import`).not.toMatch(/^(node:)?(fs|fs\/promises|child_process|net|http|https|worker_threads|vm)$/);
      }
      const text = read(file);
      expect(text, path.basename(file)).not.toMatch(/\bconsole\s*\.|process\s*\.\s*(stdout|stderr)|\bwriteFile|\bappendFile|\bcreateWriteStream/);
    }
  });
  it('AC-148 no exported function of the fingerprint module returns canonical bytes (Buffer/Uint8Array)', () => {
    const sf = parse(tsModules[0] as string);
    const exported: string[] = [];
    const visit = (n: ts.Node) => {
      if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.type && /Buffer|Uint8Array|ArrayBuffer/.test(n.type.getText())) exported.push(n.name?.getText() ?? '?');
      ts.forEachChild(n, visit);
    };
    visit(sf);
    expect(exported).toEqual([]);
    expect(Object.keys(read(tsModules[0] as string).match(/export class DigestSink[\s\S]*?\n}\n/)?.[0].match(/^ {2}(?:write|end|constructor)\b/gm) ?? [])).toHaveLength(3);
  });
  const ALLOWED_SPANS = new Set(['ESCAPE', 'name', 'step', 'verdict.state']);
  it('AC-189 R4 modules throw only constant-message errors (no interpolation of a value into a thrown message)', () => {
    const files = [
      ...tsModules, path.join(API, 'scripts', 'local-test-baseline.ts'),
      ...['local-test-witness.mjs', 'local-test-safe-error.mjs', 'local-test-authorize-resume.mjs'].map((f) => path.join(DB_SCRIPTS, f)),
    ];
    const offenders: string[] = [];
    for (const file of files) {
      const sf = parse(file);
      const visit = (n: ts.Node) => {
        if (ts.isThrowStatement(n) && n.expression && ts.isNewExpression(n.expression) && unwrap(n.expression.expression).getText() === 'Error') {
          const arg = n.expression.arguments?.[0];
          // Allowed: a literal, or a template whose only substitutions are the closed internal identifiers below (module constant /
          // step name / rule id / classified state). Anything else (a caught error, a row value, a path) is a possible secret carrier.
          const okSpan = (e: ts.Expression) => ALLOWED_SPANS.has(e.getText());
          const constant = !!arg && ((ts.isIdentifier(arg) && /^[A-Z][A-Z0-9_]+$/.test(arg.text)) || ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg) || (ts.isTemplateExpression(arg) && arg.templateSpans.every((sp) => okSpan(sp.expression))));
          if (!constant) offenders.push(`${path.basename(file)}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`);
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    expect(offenders).toEqual([]);
  });
  it('AC-190/191 every PrismaClient built on a safety path has no query/params/info/warn/error logging, and nothing subscribes to client events', () => {
    const files = [...readdirSync(path.join(API, 'scripts')).filter((f) => f.endsWith('.ts')).map((f) => path.join(API, 'scripts', f)), path.join(API, 'prisma', 'seed.ts')];
    let constructions = 0;
    for (const file of files) {
      const sf = parse(file);
      const visit = (n: ts.Node) => {
        if (ts.isNewExpression(n) && /(^|\.)PrismaClient$/.test(unwrap(n.expression).getText())) {
          constructions += 1;
          expect(logOption(n), `${path.basename(file)}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`).not.toBe('nonEmpty');
        }
        if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === '$on') throw new Error(`client event subscription in ${path.basename(file)}`);
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    expect(constructions).toBeGreaterThanOrEqual(3); // demo-database.ts openers: the rule saw real constructions
  });
  it('AC-190 positive control: a construction with log:["query"] is reported as logQuery', () => {
    const full = path.join(FIXTURES, 'log-query.ts');
    expect(analyse(fixtureRoots(full)).findings.map((f) => f.rule)).toContain('logQuery');
  });
});

describe('search_path and the no-op guard (AC-106, AC-121)', () => {
  it('AC-106 the protected search_path is exactly "pg_catalog, pg_temp" and the owner pins it as its FIRST statement', () => {
    expect(PROTECTED_SEARCH_PATH).toBe('pg_catalog, pg_temp');
    const runtime = read(path.join(API, 'scripts', 'local-test-runtime.ts'));
    expect(runtime).toContain("'SET LOCAL search_path = pg_catalog, pg_temp',\n  \"SET LOCAL lock_timeout = '10s'\"");
    expect(runtime).not.toMatch(/search_path\s*=\s*[^']*\bpublic\b/);
    expect(read(path.join(API, 'scripts', 'local-test-fingerprint.ts'))).not.toMatch(/search_path['"`]?\s*(=|:)\s*['"`][^'"`]*public/);
  });
  it('AC-121 the state-change guard compares the PRE digest of Q with fPre (same domain), never the POST digest', () => {
    const runtime = read(path.join(API, 'scripts', 'local-test-runtime.ts'));
    expect(runtime).toContain('if (dPreOfQ === request.expectedFPre)');
    expect(runtime).not.toMatch(/fPost\s*===\s*request\.expectedFPre/);
  });
});

describe('executables: start guard, no restore, no path from the outcome tools to seed/authorization (AC-090/179/181/182/195)', () => {
  const src = (f: string) => read(path.join(DB_SCRIPTS, f));
  const tools = ['local-test-prepare.mjs', 'local-test-backup.mjs', 'local-test-authorize-resume.mjs'];
  it('AC-195 every executable entry runs main through runTool (the start guard + fixed-code handler)', () => {
    for (const t of tools) {
      expect(src(t), t).toMatch(/import\.meta\.url === pathToFileURL\(process\.argv\[1\]\)\.href\) \{\n {2}process\.exitCode = await runTool\(\(\) => main\(/);
    }
  });
  it('AC-182 pg_restore is only ever listed: no restore, clean, create, single-transaction or role flag exists in any executable', () => {
    for (const t of tools) {
      const text = src(t);
      expect(text, t).not.toMatch(/['"`](--clean|--create|--single-transaction|--jobs|--role|--data-only|--exit-on-error|-c|-C|-j)['"`]/);
      for (const m of text.matchAll(/pgRestore[^\n]*\[([^\]\n]*)\]/g)) expect(m[1], t).toMatch(/^'--list'/);
    }
    expect(src('local-test-prepare.mjs')).not.toMatch(/\bpg_restore\b[^\n]*(--dbname|-d\b)/);
  });
  it('AC-090/179/181 the outcome and reconcile flow reaches no seed, resume, authorization creation, witness writer or child process', () => {
    const sf = parse(path.join(DB_SCRIPTS, 'local-test-prepare.mjs'));
    const fns = collectFunctions(sf);
    const outcome = fns.find((f) => f.name === 'outcomeFlow') as FnInfo;
    const forbidden = new Set(['resumeSeed2', 'seedDemo', 'backfillCompanyLocations', 'writeAuthorizationRecord', 'buildAuthorizationRecord', 'persistWitnessDurably', 'consumeAuthorizationMarker', 'runContained', 'spawn', 'listBackupArchive', 'ensureWitnessDir']);
    const used: string[] = [];
    const visit = (n: ts.Node) => { if (ts.isIdentifier(n) && forbidden.has(n.text)) used.push(n.text); ts.forEachChild(n, visit); };
    visit(outcome.body);
    expect(used).toEqual([]);
    const authorize = parse(path.join(DB_SCRIPTS, 'local-test-authorize-resume.mjs'));
    const used2: string[] = [];
    const visit2 = (n: ts.Node) => { if (ts.isIdentifier(n) && ['resumeSeed2', 'seedDemo', 'loadRuntime', 'checkOutcome', 'consumeAuthorizationMarker'].includes(n.text)) used2.push(n.text); ts.forEachChild(n, visit2); };
    visit2(authorize);
    expect(used2).toEqual([]);
  });
  it('AC-181 resumeSeed2 is called from the resume flow only, and nothing in the executables calls runtime.seedDemo on the resume path', () => {
    const sf = parse(path.join(DB_SCRIPTS, 'local-test-prepare.mjs'));
    const holders = new Set<string>();
    for (const f of collectFunctions(sf)) {
      const visit = (n: ts.Node) => { if (ts.isPropertyAccessExpression(n) && n.name.text === 'resumeSeed2') holders.add(f.name); ts.forEachChild(n, visit); };
      visit(f.body);
    }
    expect([...holders]).toEqual(['resumeWith']);
    const resumeWith = collectFunctions(sf).find((f) => f.name === 'resumeWith') as FnInfo;
    const bad: string[] = [];
    const visit = (n: ts.Node) => { if (ts.isIdentifier(n) && ['seedDemo', 'backfillCompanyLocations', 'verifyBaseline'].includes(n.text)) bad.push(n.text); ts.forEachChild(n, visit); };
    visit(resumeWith.body);
    expect(bad).toEqual([]);
  });
  it('AC-090 only local-test-authorize-resume.mjs creates an authorization record (the resume, backup and prepare never do)', () => {
    for (const t of ['local-test-prepare.mjs', 'local-test-backup.mjs']) expect(src(t), t).not.toMatch(/buildAuthorizationRecord|writeAuthorizationRecord/);
    expect(src('local-test-authorize-resume.mjs')).toMatch(/writeAuthorizationRecord/);
  });
});

describe('mirrored constants cannot drift (drift guard)', () => {
  it('PROTECTED_RELATION_NAMES (witness.mjs) equals PROTECTED_RELATIONS (fingerprint.ts), same order, 26 entries', async () => {
    const mod = (await import(pathToFileURL(path.join(DB_SCRIPTS, 'local-test-witness.mjs')).href)) as { PROTECTED_RELATION_NAMES: readonly string[] };
    const { PROTECTED_RELATIONS } = await import('../scripts/local-test-fingerprint.js');
    expect([...mod.PROTECTED_RELATION_NAMES]).toEqual([...PROTECTED_RELATIONS]);
    expect(PROTECTED_RELATIONS).toHaveLength(26);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Remediation 1: the property-access reachability CLASS. Verdicts are fixed by the sealed preregistration (70 cases); each fixture has one
// root whose first parameter is ProtectedTx and the forbidden construct exists ONLY inside a callee body, never at the call site.
//   REACHABLE_AND_SCAN   → the expected finding must be reported (proves the body was reached and scanned)
//   CONSERVATIVE_REJECT  → the expected conservative finding must be reported (target cannot be proven safe)
//   SAFE_EXTERNAL_ALLOW  → no finding at all
const PROPERTY_ACCESS = path.join(API, 'tests', 'fixtures', 'property-access');
const PROPERTY_CASES: ReadonlyArray<readonly [string, string, string]> = [
  ['PA-01', 'REACHABLE_AND_SCAN', 'newPrismaClient'],
  ['PA-02', 'REACHABLE_AND_SCAN', 'newPool'],
  ['PA-03', 'REACHABLE_AND_SCAN', 'connect'],
  ['PA-04', 'REACHABLE_AND_SCAN', 'connect'],
  ['PA-05', 'REACHABLE_AND_SCAN', 'newPrismaClient'],
  ['PA-06', 'REACHABLE_AND_SCAN', 'txControl'],
  ['PA-07', 'REACHABLE_AND_SCAN', 'newPool'],
  ['PA-08', 'REACHABLE_AND_SCAN', 'newPrismaClient'],
  ['PA-09', 'REACHABLE_AND_SCAN', 'newPool'],
  ['PA-10', 'REACHABLE_AND_SCAN', 'newPrismaClient'],
  ['PA-11', 'REACHABLE_AND_SCAN', 'newPrismaClient'],
  ['PA-12', 'REACHABLE_AND_SCAN', 'transaction'],
  ['PA-13', 'REACHABLE_AND_SCAN', 'txControl'],
  ['PA-14', 'REACHABLE_AND_SCAN', 'newPool'],
  ['PA-15', 'REACHABLE_AND_SCAN', 'newPrismaClient'],
  ['PA-16', 'REACHABLE_AND_SCAN', 'newPrismaClient'],
  ['AL-17', 'REACHABLE_AND_SCAN', 'newPrismaClient'],
  ['AL-18', 'REACHABLE_AND_SCAN', 'newPrismaClient'],
  ['AL-19', 'REACHABLE_AND_SCAN', 'newPrismaClient'],
  ['AL-20', 'REACHABLE_AND_SCAN', 'newPrismaClient'],
  ['AL-21', 'CONSERVATIVE_REJECT', 'unresolvedCall'],
  ['PA-22', 'REACHABLE_AND_SCAN', 'newPool'],
  ['PA-23', 'REACHABLE_AND_SCAN', 'newPool'],
  ['BO-24', 'REACHABLE_AND_SCAN', 'newPrismaClient'],
  ['BO-25', 'REACHABLE_AND_SCAN', 'newPool'],
  ['BO-26', 'REACHABLE_AND_SCAN', 'connect'],
  ['BO-27', 'REACHABLE_AND_SCAN', 'transaction'],
  ['BO-28', 'REACHABLE_AND_SCAN', 'txControl'],
  ['BO-29', 'REACHABLE_AND_SCAN', 'setSearchPath'],
  ['BO-30', 'REACHABLE_AND_SCAN', 'childProcess'],
  ['PA-31', 'REACHABLE_AND_SCAN', 'newPrismaClient'],
  ['PA-32', 'REACHABLE_AND_SCAN', 'newPool'],
  ['PA-33', 'REACHABLE_AND_SCAN', 'newPool'],
  ['PA-34', 'REACHABLE_AND_SCAN', 'newPrismaClient'],
  ['AL-35', 'REACHABLE_AND_SCAN', 'newPrismaClient'],
  ['PA-36', 'REACHABLE_AND_SCAN', 'newPool'],
  ['AL-37', 'REACHABLE_AND_SCAN', 'newPool'],
  ['AL-38', 'REACHABLE_AND_SCAN', 'newPool'],
  ['PA-39', 'REACHABLE_AND_SCAN', 'newPool'],
  ['PA-40', 'REACHABLE_AND_SCAN', 'newPrismaClient'],
  ['PA-41', 'REACHABLE_AND_SCAN', 'newPool'],
  ['PA-42', 'REACHABLE_AND_SCAN', 'newPool'],
  ['CY-43', 'REACHABLE_AND_SCAN', 'newPrismaClient'],
  ['CY-44', 'SAFE_EXTERNAL_ALLOW', 'ALLOW'],
  ['PA-45', 'CONSERVATIVE_REJECT', 'dynamicComputed'],
  ['PA-46', 'CONSERVATIVE_REJECT', 'unresolvedCall'],
  ['PA-47', 'CONSERVATIVE_REJECT', 'bodylessTarget'],
  ['AL-48', 'REACHABLE_AND_SCAN', 'newPrismaClient'],
  ['AL-49', 'REACHABLE_AND_SCAN', 'newPrismaClient'],
  ['AL-50', 'REACHABLE_AND_SCAN', 'newPrismaClient'],
  ['AL-51', 'REACHABLE_AND_SCAN', 'newPrismaClient'],
  ['AL-52', 'REACHABLE_AND_SCAN', 'newPrismaClient'],
  ['PA-53', 'REACHABLE_AND_SCAN', 'newPrismaClient'],
  ['BO-54', 'REACHABLE_AND_SCAN', 'newPool'],
  ['BO-55', 'REACHABLE_AND_SCAN', 'forbiddenType'],
  ['BO-56', 'REACHABLE_AND_SCAN', 'forbiddenType'],
  ['BO-57', 'REACHABLE_AND_SCAN', 'setSearchPath'],
  ['BO-58', 'REACHABLE_AND_SCAN', 'setConfig'],
  ['BO-59', 'REACHABLE_AND_SCAN', 'dynamicImport'],
  ['PA-60', 'REACHABLE_AND_SCAN', 'newPrismaClient'],
  ['PC-01', 'SAFE_EXTERNAL_ALLOW', 'ALLOW'],
  ['PC-02', 'SAFE_EXTERNAL_ALLOW', 'ALLOW'],
  ['PC-03', 'SAFE_EXTERNAL_ALLOW', 'ALLOW'],
  ['PC-04', 'SAFE_EXTERNAL_ALLOW', 'ALLOW'],
  ['PC-05', 'SAFE_EXTERNAL_ALLOW', 'ALLOW'],
  ['PC-06', 'REACHABLE_AND_SCAN', 'rawSqlCapability'],
  ['PC-07', 'SAFE_EXTERNAL_ALLOW', 'ALLOW'],
  ['PC-08', 'SAFE_EXTERNAL_ALLOW', 'ALLOW'],
  ['PC-09', 'SAFE_EXTERNAL_ALLOW', 'ALLOW'],
  ['PC-10', 'REACHABLE_AND_SCAN', 'rawSqlCapability'],
];
const caseFile = (id: string) => path.join(PROPERTY_ACCESS, `${id.toLowerCase()}.ts`);
describe('property-access reachability class (remediation 1, 70 preregistered cases)', () => {
  for (const [id, cls, finding] of PROPERTY_CASES) {
    it(`${id} ${cls} ⇒ ${finding}`, () => {
      const main = caseFile(id);
      const rules = rulesOf(analyse([{ file: main, name: 'root' }]).findings);
      if (finding === 'ALLOW') expect(rules).toEqual([]);
      else expect(rules).toContain(finding);
    });
  }
  it('every non-helper fixture is a preregistered case and vice versa', () => {
    const onDisk = readdirSync(PROPERTY_ACCESS).filter((f) => !f.startsWith('lib-')).map((f) => f.replace(/\.ts$/, '').toUpperCase()).sort();
    expect(onDisk).toEqual(PROPERTY_CASES.map((c) => c[0]).sort());
    expect(PROPERTY_CASES).toHaveLength(70);
  });
});

// ---- synthetic mutants (remediation 1, section 17): in-memory sources over the real tree; each is a SAFE-looking wrapper that hides ONE forbidden
// operation behind ordinary property access, at increasing depth. Every mutant must be killed (its expected finding reported).
describe('synthetic mutants of the property-access class are all killed', () => {
  const dir = PROPERTY_ACCESS;
  const HEAD = "import type { ProtectedTx } from '../../../scripts/local-test-fingerprint.js';\nimport { PrismaClient } from '../../../src/generated/prisma/client.js';\nimport { Pool } from 'pg';\nimport { spawn } from 'node:child_process';\n";
  const NEWC = 'new PrismaClient({} as never)';
  const MUTANTS: ReadonlyArray<readonly [string, string, string]> = [
    ['m01-property-body-constructor', 'newPrismaClient', `const o = { run() { return ${NEWC}; } };\nexport function root(tx: ProtectedTx) { void tx; return o.run(); }`],
    ['m02-method-returns-forbidden-helper', 'newPrismaClient', `function make() { return ${NEWC}; }\nconst o = { run() { return make(); } };\nexport function root(tx: ProtectedTx) { void tx; return o.run(); }`],
    ['m03-alias-to-property-method', 'newPool', `const o = { run() { return new Pool({}); } };\nexport function root(tx: ProtectedTx) { void tx; const f = o.run; return f(); }`],
    ['m04-nested-property-wrapper', 'newPool', `const a = { b: { c: { run() { return new Pool({}); } } } };\nexport function root(tx: ProtectedTx) { void tx; return a.b.c.run(); }`],
    ['m05-depth4-chain-begin', 'txControl', `const d = { run() { return 'BEGIN'; } };\nconst c = { run() { return d.run(); } };\nconst b = { run() { return c.run(); } };\nconst a = { run() { return b.run(); } };\nexport function root(tx: ProtectedTx) { void tx; return a.run(); }`],
    ['m06-depth3-class-search-path', 'setSearchPath', `class C { go() { return 'SET LOCAL search_path = public'; } }\nclass B { c = new C(); go() { return this.c.go(); } }\nclass A { b = new B(); go() { return this.b.go(); } }\nexport function root(tx: ProtectedTx) { void tx; return new A().go(); }`],
    ['m07-interface-implementer-spawn', 'childProcess', `interface Runner { run(): unknown }\nclass Impl implements Runner { run() { return spawn('true'); } }\nexport const impl: Runner = new Impl();\nexport function root(tx: ProtectedTx, r: Runner) { void tx; return r.run(); }`],
    ['m08-wrapper-pool-connect', 'connect', `class W { constructor(private readonly p: Pool) {} go() { return this.p.connect(); } }\nexport function root(tx: ProtectedTx, w: W) { void tx; return w.go(); }`],
    ['m09-registry-callback-transaction', 'transaction', `const db = {} as PrismaClient;\nconst o = { go() { return db.$transaction(async () => 1); } };\nconst registry = { h: o.go };\nexport function root(tx: ProtectedTx) { void tx; return registry.h(); }`],
    ['m10-destructured-nested-set-config', 'setConfig', `const deps = { a: { run() { return "select set_config('search_path','x',true)"; } } };\nexport function root(tx: ProtectedTx) { void tx; const { a: { run } } = deps; return run(); }`],
    ['m11-factory-chain-subclass', 'forbiddenType', `class P2 extends Pool {}\nconst f = { make() { return new P2({}); } };\nexport function root(tx: ProtectedTx) { void tx; return f.make(); }`],
    ['m12-reexport-namespace', 'newPool', "import * as ns from './lib-reexport-b.js';\nexport function root(tx: ProtectedTx) { void tx; return ns.runtime.open(); }"],
    ['m13-bodyless-no-implementer', 'bodylessTarget', `interface Opener { go(): unknown }\nexport function root(tx: ProtectedTx, o: Opener) { void tx; return o.go(); }`],
    ['m14-dynamic-key', 'dynamicComputed', `const o: Record<string, () => unknown> = {};\nexport function root(tx: ProtectedTx, k: string) { void tx; return o[k]!(); }`],
    ['m15-any-callee', 'unresolvedCall', `export function root(tx: ProtectedTx, x: unknown) {\n  void tx;\n  // eslint-disable-next-line @typescript-eslint/no-explicit-any\n  return (x as any).go();\n}`],
    // added after the first checker-mutation run left these paths unproven (constructor/initialiser/static-block/base-class/namespace-import)
    ['m16-constructor-body', 'newPool', `class K { p: unknown; constructor() { this.p = new Pool({}); } }\nexport function root(tx: ProtectedTx) { void tx; return new K(); }`],
    ['m17-field-initializer', 'newPrismaClient', `class K { p = ${NEWC}; }\nexport function root(tx: ProtectedTx) { void tx; return new K(); }`],
    ['m18-base-class-constructor', 'newPool', `class Base { p: unknown; constructor() { this.p = new Pool({}); } }\nclass Derived extends Base {}\nexport function root(tx: ProtectedTx) { void tx; return new Derived(); }`],
    ['m19-namespace-import-child-process', 'childProcess', "import * as cp from 'node:child_process';\nconst o = { go() { return cp.execSync('true'); } };\nexport function root(tx: ProtectedTx) { void tx; return o.go(); }"],
    ['m20-static-block', 'newPool', `class K { static { void new Pool({}); } }\nexport function root(tx: ProtectedTx) { void tx; return K; }`],
    // dynamic code: a body that exists only as a string
    ['m21-eval', 'dynamicCode', `const o = { go(src: string) { return eval(src); } };\nexport function root(tx: ProtectedTx) { void tx; return o.go('1'); }`],
    ['m22-new-function', 'dynamicCode', `const o = { go() { return new Function('return 1')(); } };\nexport function root(tx: ProtectedTx) { void tx; return o.go(); }`],
    ['m23-function-call', 'dynamicCode', `const o = { go() { return Function('return 1')(); } };\nexport function root(tx: ProtectedTx) { void tx; return o.go(); }`],
    ['m24-shadowed-eval-is-not-dynamic-code-but-unresolved', 'unresolvedCall', `const o = { go(eval: unknown) { return (eval as () => unknown)(); } };\nexport function root(tx: ProtectedTx) { void tx; return o.go(() => 1); }`],
  ];
  let mutantEnv: Env;
  const fileOf = (name: string) => path.join(dir, `${name}.ts`);
  beforeAll(() => {
    const virtual: Record<string, string> = {};
    for (const [name, , body] of MUTANTS) virtual[fileOf(name)] = `${HEAD}${body}\n`;
    mutantEnv = buildEnv([...SCAN_ROOTS(), ...Object.keys(virtual)], virtual);
  }, 240_000);
  for (const [name, expected] of MUTANTS) {
    it(`${name} is killed (${expected})`, () => {
      expect(rulesOf(analyse([{ file: fileOf(name), name: 'root' }], mutantEnv).findings)).toContain(expected);
    });
  }
  it('the mutants are virtual: none of them exists on disk', () => {
    const onDisk = new Set(readdirSync(dir));
    for (const [name] of MUTANTS) expect(onDisk.has(`${name}.ts`)).toBe(false);
  });
});
