// Task 4 TEST-BOOTSTRAP-D1: zero-database contract for the shared canonical
// TEST Company descriptor (scripts/test-company-bootstrap.ts). Everything
// here is either the descriptor's own in-memory value or a static read of
// repository source, parsed with the TypeScript compiler API so comments and
// test-name prose never count as code. Nothing opens a socket.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import * as descriptorModule from '../../scripts/test-company-bootstrap.js';
import { TEST_COMPANY_BOOTSTRAP } from '../../scripts/test-company-bootstrap.js';

// Independent literals: deliberately not read back from the module under test.
const CANONICAL_ID = '00000000-0000-4000-9100-000000000001';
const CANONICAL_CUIT = '00-11111111-1';
const CANONICAL = {
  id: CANONICAL_ID,
  name: 'Mona Jacinta (test)',
  cuit: CANONICAL_CUIT,
  address: 'Dirección legal test — pendiente de dato real',
};

const API_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DESCRIPTOR_PATH = 'scripts/test-company-bootstrap.ts';
const SELF_PATH = 'tests/organization/test-company-bootstrap.test.ts';
const BACKFILL_TEST_PATH = 'tests/organization/company-location-backfill.test.ts';
const FACTORIES_PATH = 'tests/helpers/factories.ts';
// Both consumers sit two directories below api/, so they share one specifier.
const SHARED_SPECIFIER = '../../scripts/test-company-bootstrap.js';
const FALLBACK_COMPANY_FILES = [
  'tests/rbac/user-role-scope.test.ts',
  'tests/rbac/scope-backfill.test.ts',
  'tests/rbac/scope-resolver.test.ts',
  'tests/rbac/scope-seed-integration.test.ts',
  'tests/rbac/seed-integration.test.ts',
];

const read = (path: string) => readFileSync(`${API_ROOT}${path}`, 'utf8').replace(/\r\n/g, '\n');
const parse = (path: string) =>
  ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

function nodes(root: ts.Node): ts.Node[] {
  const all: ts.Node[] = [];
  const visit = (node: ts.Node) => {
    all.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return all;
}

// The first argument of describe/it/test (incl. .each/.skip chains) is prose.
function isTestTitle(node: ts.Node): boolean {
  const call = node.parent;
  if (!call || !ts.isCallExpression(call) || call.arguments[0] !== node) return false;
  let callee: ts.Expression = call.expression;
  while (ts.isCallExpression(callee) || ts.isPropertyAccessExpression(callee)) callee = callee.expression;
  return ts.isIdentifier(callee) && ['describe', 'it', 'test'].includes(callee.text);
}

function codeStrings(file: ts.SourceFile): string[] {
  return nodes(file)
    .filter((n) => ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n))
    .filter((n) => !isTestTitle(n))
    .map((n) => (n as ts.StringLiteral).text);
}

const imports = (file: ts.SourceFile) =>
  file.statements.filter(ts.isImportDeclaration).map((decl) => ({
    specifier: (decl.moduleSpecifier as ts.StringLiteral).text,
    typeOnly: decl.importClause?.isTypeOnly === true,
    names: (() => {
      const bindings = decl.importClause?.namedBindings;
      return bindings && ts.isNamedImports(bindings)
        ? bindings.elements.map((el) => (el.propertyName ?? el.name).text)
        : [];
    })(),
  }));

const declaresVariable = (file: ts.SourceFile, name: string) =>
  nodes(file).some((n) => ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name);

const identifiers = (file: ts.SourceFile) =>
  new Set(nodes(file).filter(ts.isIdentifier).map((n) => n.text));

// Reads the string properties of `const <name> = { ... }` in a frozen file,
// so the distinctness guard follows the CURRENT identities without importing
// (and so executing) the scripts/tests that declare them.
function objectLiteralOf(path: string, name: string): Record<string, string> {
  const decl = nodes(parse(path)).find(
    (n): n is ts.VariableDeclaration =>
      ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name,
  );
  if (!decl?.initializer || !ts.isObjectLiteralExpression(decl.initializer)) {
    throw new Error(`${name} object literal not found in ${path}`);
  }
  const out: Record<string, string> = {};
  for (const prop of decl.initializer.properties) {
    if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && ts.isStringLiteral(prop.initializer)) {
      out[prop.name.text] = prop.initializer.text;
    }
  }
  return out;
}

function sourceFilesUnder(dir: string): string[] {
  return (readdirSync(`${API_ROOT}${dir}`, { recursive: true }) as string[])
    .map((rel) => `${dir}/${rel.replace(/\\/g, '/')}`)
    .filter((path) => path.endsWith('.ts') && !path.startsWith('src/generated/'));
}

describe('A. canonical TEST Company descriptor value', () => {
  it('A1 is exactly the canonical TEST Company, four fields, byte for byte', () => {
    expect({ ...TEST_COMPANY_BOOTSTRAP }).toStrictEqual(CANONICAL);
    expect(Object.keys(TEST_COMPANY_BOOTSTRAP).sort()).toEqual(['address', 'cuit', 'id', 'name']);
  });

  it('A2 is frozen: a consumer cannot rewrite the shared identity at runtime', () => {
    expect(Object.isFrozen(TEST_COMPANY_BOOTSTRAP)).toBe(true);
    expect(() => {
      (TEST_COMPANY_BOOTSTRAP as { cuit: string }).cuit = '00-00000000-0';
    }).toThrow(TypeError);
    expect(TEST_COMPANY_BOOTSTRAP.cuit).toBe(CANONICAL_CUIT);
  });
});

describe('B. descriptor module is pure data', () => {
  const file = parse(DESCRIPTOR_PATH);

  it('B1 its only import is a clause-level type-only import of the organization domain type', () => {
    expect(imports(file)).toEqual([
      {
        specifier: '../src/modules/organization/organization.service.js',
        typeOnly: true,
        names: ['CompanyBootstrap'],
      },
    ]);
  });

  it('B2 never reads the environment or loads code at runtime', () => {
    const ids = identifiers(file);
    for (const forbidden of ['process', 'require', 'globalThis', 'fetch']) expect(ids.has(forbidden)).toBe(false);
    expect(nodes(file).some((n) => n.kind === ts.SyntaxKind.ImportKeyword && ts.isCallExpression(n.parent))).toBe(false);
    const strings = codeStrings(file).join('\n');
    for (const forbidden of ['tests/', 'prisma', 'seed', 'backfill-company-location', 'pg', 'dotenv', 'generated', 'demo-database', 'marker', 'prepare']) {
      expect(imports(file).some((i) => i.specifier.includes(forbidden))).toBe(false);
    }
    expect(strings).not.toMatch(/DATABASE_URL|postgres(ql)?:\/\//);
  });

  it('B3 top level is one exported frozen constant: no functions, and Object.freeze is the only call', () => {
    const statements = file.statements.filter((s) => !ts.isImportDeclaration(s));
    expect(statements).toHaveLength(1);
    const [statement] = statements;
    expect(statement && ts.isVariableStatement(statement)).toBe(true);
    const calls = nodes(file).filter(ts.isCallExpression).map((c) => c.expression.getText(file));
    expect(calls).toEqual(['Object.freeze']);
    expect(
      nodes(file).some(
        (n) =>
          ts.isFunctionDeclaration(n) ||
          ts.isArrowFunction(n) ||
          ts.isFunctionExpression(n) ||
          ts.isMethodDeclaration(n) ||
          ts.isGetAccessor(n) ||
          ts.isClassDeclaration(n),
      ),
    ).toBe(false);
  });

  it('B4 no production src module imports the descriptor (it never reaches dist)', () => {
    const offenders = sourceFilesUnder('src').filter((path) =>
      imports(parse(path)).some((i) => i.specifier.includes('test-company-bootstrap')),
    );
    expect(offenders).toEqual([]);
  });
});

describe('C. single source of truth for the canonical TEST Company', () => {
  it('C1 company-location-backfill imports TEST_COMPANY_BOOTSTRAP from the shared descriptor', () => {
    expect(imports(parse(BACKFILL_TEST_PATH))).toContainEqual(
      expect.objectContaining({ specifier: SHARED_SPECIFIER, names: ['TEST_COMPANY_BOOTSTRAP'] }),
    );
  });

  it('C2 company-location-backfill declares no local TEST_COMPANY_BOOTSTRAP', () => {
    expect(declaresVariable(parse(BACKFILL_TEST_PATH), 'TEST_COMPANY_BOOTSTRAP')).toBe(false);
  });

  it('C3 company-location-backfill carries no canonical Company id or cuit literal', () => {
    const strings = codeStrings(parse(BACKFILL_TEST_PATH));
    expect(strings).not.toContain(CANONICAL_ID);
    expect(strings).not.toContain(CANONICAL_CUIT);
  });

  it('C4 factories imports TEST_COMPANY_BOOTSTRAP from the shared descriptor', () => {
    expect(imports(parse(FACTORIES_PATH))).toContainEqual(
      expect.objectContaining({ specifier: SHARED_SPECIFIER, names: ['TEST_COMPANY_BOOTSTRAP'] }),
    );
  });

  it('C5 factories carries no canonical Company id or cuit literal', () => {
    const strings = codeStrings(parse(FACTORIES_PATH));
    expect(strings).not.toContain(CANONICAL_ID);
    expect(strings).not.toContain(CANONICAL_CUIT);
  });

  it('C6 ensureTestLocation looks the canonical Company up by TEST_COMPANY_BOOTSTRAP.cuit', () => {
    const file = parse(FACTORIES_PATH);
    const fn = nodes(file).find(
      (n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === 'ensureTestLocation',
    );
    expect(fn).toBeDefined();
    const accesses = nodes(fn!)
      .filter(ts.isPropertyAccessExpression)
      .map((n) => n.getText(file));
    expect(accesses).toContain('TEST_COMPANY_BOOTSTRAP.cuit');
  });

  it('C7 no other api source declares TEST_COMPANY_BOOTSTRAP or the canonical id/cuit literal', () => {
    const rootFiles = (readdirSync(API_ROOT) as string[]).filter((f) => f.endsWith('.ts'));
    const files = [
      ...sourceFilesUnder('src'),
      ...sourceFilesUnder('tests'),
      ...sourceFilesUnder('scripts'),
      ...sourceFilesUnder('prisma'),
      ...rootFiles,
    ].filter((path) => path !== DESCRIPTOR_PATH && path !== SELF_PATH);
    const offenders = files.filter((path) => {
      const file = parse(path);
      const strings = codeStrings(file);
      return (
        declaresVariable(file, 'TEST_COMPANY_BOOTSTRAP') ||
        strings.includes(CANONICAL_ID) ||
        strings.includes(CANONICAL_CUIT)
      );
    });
    expect(offenders).toEqual([]);
  });
});

describe('D. hosted TEST startup never bootstraps Company/Location', () => {
  it.each(['tests/globalSetup.ts', 'tests/setup.ts'])(
    'D1 %s neither imports the descriptor nor runs the Company/Location bootstrap',
    (path) => {
      const file = parse(path);
      expect(imports(file).some((i) => /test-company-bootstrap|organization\.service/.test(i.specifier))).toBe(false);
      const ids = identifiers(file);
      for (const name of ['TEST_COMPANY_BOOTSTRAP', 'backfillLocationsFromBranches', 'ensureCompany']) {
        expect(ids.has(name)).toBe(false);
      }
    },
  );
});

describe('E. canonical TEST identity is distinct from every other bootstrap Company', () => {
  it('E1 differs from the operator DEMO_COMPANY_BOOTSTRAP in id and cuit', () => {
    const demo = objectLiteralOf('scripts/backfill-company-location.ts', 'DEMO_COMPANY_BOOTSTRAP');
    expect(demo.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(demo.cuit).toBeTruthy();
    expect(demo.id).not.toBe(CANONICAL_ID);
    expect(demo.cuit).not.toBe(CANONICAL_CUIT);
  });

  it.each(FALLBACK_COMPANY_FILES)('E2 differs from the fallback Company in %s (id and cuit)', (path) => {
    const fallback = objectLiteralOf(path, 'FALLBACK_COMPANY_BOOTSTRAP');
    expect(fallback.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(fallback.cuit).toBeTruthy();
    expect(fallback.id).not.toBe(CANONICAL_ID);
    expect(fallback.cuit).not.toBe(CANONICAL_CUIT);
  });
});

describe('F. the descriptor carries the Company only, never Locations', () => {
  it('F1 exports nothing but TEST_COMPANY_BOOTSTRAP', () => {
    expect(Object.keys(descriptorModule)).toEqual(['TEST_COMPANY_BOOTSTRAP']);
  });

  it('F2 copies no Branch codes, Location ids, types or point-of-sale numbers', () => {
    const file = parse(DESCRIPTOR_PATH);
    const strings = codeStrings(file);
    for (const code of ['CEN', 'YB', 'TV', 'BAN', 'CON', 'DEP', 'CENTRAL_WAREHOUSE', 'RETAIL_BRANCH']) {
      expect(strings).not.toContain(code);
    }
    expect(strings.some((s) => s.includes('-4000-8000-'))).toBe(false);
    expect(nodes(file).some(ts.isNumericLiteral)).toBe(false);
    expect(nodes(file).some(ts.isArrayLiteralExpression)).toBe(false);
  });
});
