// Task 4 RED6D-S1: zero-database tests for CANONICAL_DEMO_SEED (prisma/seed.ts).
// The descriptor must be pure, deeply frozen data that is the ONE source of the
// canonical demo seed: populate()/convergeCanonicalScopes() consume it instead
// of re-deriving ids, addresses, emails, barcodes and quantities themselves.
// X1/X2 run the real seedDemo() against an in-memory recording transaction (no
// database) to pin that what the seed writes equals the descriptor.
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { CANONICAL_DEMO_SEED, branches, permissions, rolePermissions, seedDemo } from '../prisma/seed.js';
import { ROLE_CODES } from '../src/modules/rbac/roles.js';

const SEED_PATH = new URL('../prisma/seed.ts', import.meta.url);
const SOURCE = readFileSync(SEED_PATH, 'utf8');
const AST = ts.createSourceFile('seed.ts', SOURCE, ts.ScriptTarget.Latest, true);

// Source text of a node without comments (code only).
function codeOf(node: ts.Node): string {
  const printer = ts.createPrinter({ removeComments: true });
  return printer.printNode(ts.EmitHint.Unspecified, node, AST);
}
const MODULE_CODE = ts.createPrinter({ removeComments: true }).printFile(AST);
function functionCode(name: string): string {
  const fn = AST.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === name);
  if (!fn) throw new Error(`function ${name} not found in prisma/seed.ts`);
  return codeOf(fn);
}
function constInitializer(name: string): string | null {
  for (const statement of AST.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const decl of statement.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.name.text === name && decl.initializer) return codeOf(decl.initializer);
    }
  }
  return null;
}
const occurrences = (text: string, needle: string) => text.split(needle).length - 1;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const D = CANONICAL_DEMO_SEED;

// --- A. import / purity ---------------------------------------------------------------------

describe('A descriptor import and purity', () => {
  it('A1 is exported alongside the existing seed API', () => {
    expect(typeof D).toBe('object');
    expect(typeof seedDemo).toBe('function');
  });

  it('A2 is deeply frozen: every nested object and array', () => {
    const unfrozen: string[] = [];
    const walk = (value: unknown, path: string) => {
      if (typeof value !== 'object' || value === null) return;
      if (!Object.isFrozen(value)) unfrozen.push(path);
      for (const [key, nested] of Object.entries(value)) walk(nested, `${path}.${key}`);
    };
    walk(D, 'D');
    expect(unfrozen).toEqual([]);
  });

  it('A3 a consumer cannot mutate it', () => {
    expect(() => (D.branches as unknown as unknown[]).push({})).toThrow(TypeError);
    expect(() => { (D.inventory[0] as { physical: bigint }).physical = 1n; }).toThrow(TypeError);
    expect(() => { (D.roles[0]!.permissionCodes as string[]).length = 0; }).toThrow(TypeError);
  });
});

// --- B. exact canonical content (independent expectations) ---------------------------------------

describe('B exact canonical content', () => {
  it('B1 legacy permissions: 12 codes at ids 100..111, in seed order', () => {
    expect(D.permissions).toEqual(permissions.map((code, i) => ({ id: id(100 + i), code })));
    expect(D.permissions).toHaveLength(12);
  });

  it('B2 legacy roles SELLER/CASHIER/MANAGER/ADMIN at ids 200..203 with their 32 grants', () => {
    expect(D.roles.map((r) => [r.id, r.code, r.name])).toEqual([
      [id(200), 'SELLER', 'SELLER'],
      [id(201), 'CASHIER', 'CASHIER'],
      [id(202), 'MANAGER', 'MANAGER'],
      [id(203), 'ADMIN', 'ADMIN'],
    ]);
    expect(D.roles.map((r) => r.permissionCodes.length)).toEqual([3, 7, 10, 12]);
    expect(D.roles.find((r) => r.code === 'MANAGER')!.permissionCodes).not.toContain('user.manage');
    expect(D.roles.find((r) => r.code === 'MANAGER')!.permissionCodes).not.toContain('audit.view');
    for (const role of D.roles) expect([...role.permissionCodes]).toEqual([...rolePermissions[role.code as keyof typeof rolePermissions]]);
  });

  it('B3 six branches with final ids, addresses and point-of-sale numbers', () => {
    expect(D.branches).toEqual([
      { id: id(300), code: 'CEN', name: 'Centro', pointOfSaleNumber: 1, address: 'Domicilio demo — Centro' },
      { id: id(301), code: 'YB', name: 'Yerba Buena', pointOfSaleNumber: 2, address: 'Domicilio demo — Yerba Buena' },
      { id: id(302), code: 'TV', name: 'Tafí Viejo', pointOfSaleNumber: 3, address: 'Domicilio demo — Tafí Viejo' },
      { id: id(303), code: 'BAN', name: 'Banda', pointOfSaleNumber: 4, address: 'Domicilio demo — Banda' },
      { id: id(304), code: 'CON', name: 'Concepción', pointOfSaleNumber: 5, address: 'Domicilio demo — Concepción' },
      { id: id(305), code: 'DEP', name: 'Depósito Central', pointOfSaleNumber: 6, address: 'Domicilio demo — Depósito Central' },
    ]);
  });

  it('B4 one counter (nextValue 1) and one "Caja principal" register per branch', () => {
    expect(D.saleNumberCounters).toEqual(D.branches.map((b, i) => ({ id: id(400 + i), branchId: b.id, nextValue: 1n })));
    expect(D.cashRegisters).toEqual(D.branches.map((b, i) => ({ id: id(500 + i), branchId: b.id, name: 'Caja principal' })));
  });

  it('B5 four canonical users (601 reserved), the OWNER, and the pinned timestamp', () => {
    expect(D.users).toEqual([
      { id: id(600), name: 'admin', email: 'admin@demo.local' },
      { id: id(602), name: 'seller01', email: 'seller01@demo.local' },
      { id: id(603), name: 'cashier01', email: 'cashier01@demo.local' },
      { id: id(605), name: 'warehouse01', email: 'warehouse01@demo.local' },
    ]);
    expect(D.owner).toEqual({ id: id(604), name: 'Owner Demo', email: 'owner01@demo.local' });
    expect(D.userTimestamp).toBe('2026-01-01T00:00:00.000Z');
    expect([...D.users, D.owner].some((u) => u.id === id(601))).toBe(false);
  });

  it('B6 one category and one brand', () => {
    expect(D.category).toEqual({ id: id(800), name: 'Indumentaria' });
    expect(D.brand).toEqual({ id: id(801), name: 'Mona Jacinta' });
  });

  it('B7 three products and six variants with exact skus, barcodes and prices', () => {
    expect(D.products.map((p) => [p.id, p.name, p.slug, p.description, p.categoryId, p.brandId, p.isActive])).toEqual([
      [id(900), 'Remera Básica', 'remera-basica', 'Producto de demostración', id(800), id(801), true],
      [id(901), 'Jean Slim', 'jean-slim', 'Producto de demostración', id(800), id(801), true],
      [id(902), 'Campera Jean', 'campera-jean', 'Producto de demostración', id(800), id(801), true],
    ]);
    expect(D.variants.map((v) => [v.id, v.productId, v.color, v.size, v.sku, v.barcode, v.price, v.costPrice, v.isActive])).toEqual([
      [id(1000), id(900), 'Negro', 'M', 'REM-NEG-M', 'DEMO-REM-NEG-M', 4500000n, 2500000n, true],
      [id(1001), id(900), 'Blanco', 'S', 'REM-BLA-S', 'DEMO-REM-BLA-S', 4500000n, 2500000n, true],
      [id(1010), id(901), 'Azul', '42', 'JEA-AZU-42', 'DEMO-JEA-AZU-42', 7500000n, 4000000n, true],
      [id(1011), id(901), 'Azul', '44', 'JEA-AZU-44', 'DEMO-JEA-AZU-44', 7500000n, 4000000n, true],
      [id(1020), id(902), 'Azul', 'M', 'CAM-AZU-M', 'DEMO-CAM-AZU-M', 9500000n, 5500000n, true],
      [id(1021), id(902), 'Azul', 'L', 'CAM-AZU-L', 'DEMO-CAM-AZU-L', 9500000n, 5500000n, true],
    ]);
  });

  it('B8 36 inventory rows: 50 at DEP, 20 elsewhere, nothing reserved', () => {
    expect(D.inventory).toHaveLength(36);
    const variantIds = [1000, 1001, 1010, 1011, 1020, 1021];
    const expected = variantIds.flatMap((v, vi) =>
      [0, 1, 2, 3, 4, 5].map((k) => ({
        id: id(2000 + Math.floor(vi / 2) * 100 + (vi % 2) * 10 + k),
        variantId: id(v),
        branchId: id(300 + k),
        physical: k === 5 ? 50n : 20n,
        reserved: 0n,
      })),
    );
    expect(D.inventory).toEqual(expected);
  });

  it('B9 five final assignments: OWNER/ADMIN company-wide, SELLER/CASHIER at CEN, WAREHOUSE at DEP', () => {
    expect(D.assignments).toEqual([
      { userId: id(604), email: 'owner01@demo.local', roleCode: 'OWNER', scopeKind: 'COMPANY', branchCode: null },
      { userId: id(600), email: 'admin@demo.local', roleCode: 'ADMIN', scopeKind: 'COMPANY', branchCode: null },
      { userId: id(602), email: 'seller01@demo.local', roleCode: 'SELLER', scopeKind: 'LOCATION', branchCode: 'CEN' },
      { userId: id(603), email: 'cashier01@demo.local', roleCode: 'CASHIER', scopeKind: 'LOCATION', branchCode: 'CEN' },
      { userId: id(605), email: 'warehouse01@demo.local', roleCode: 'WAREHOUSE', scopeKind: 'LOCATION', branchCode: 'DEP' },
    ]);
  });

  it('B10 the seed writes no legacy UserBranchRole row', () => {
    expect(D.userBranchRoles).toEqual([]);
  });
});

// --- C. no runtime artifacts -------------------------------------------------------------------------

describe('C no nondeterministic or runtime bytes', () => {
  it('C1 holds only plain data: no password/hash fields, no Date, no functions', () => {
    const bad: string[] = [];
    const walk = (value: unknown, path: string) => {
      if (typeof value === 'function' || value instanceof Date) bad.push(path);
      if (typeof value !== 'object' || value === null) return;
      for (const [key, nested] of Object.entries(value)) {
        if (/password|hash|salt|createdAt|updatedAt/i.test(key)) bad.push(`${path}.${key}`);
        walk(nested, `${path}.${key}`);
      }
    };
    walk(D, 'D');
    expect(bad).toEqual([]);
  });

  it('C2 assignments carry no generated scope id and no runtime Location id', () => {
    for (const a of D.assignments) expect(Object.keys(a).sort()).toEqual(['branchCode', 'email', 'roleCode', 'scopeKind', 'userId']);
  });
});

// --- D. branch single source ---------------------------------------------------------------------------

describe('D branch single source', () => {
  it('D1 the existing `branches` export is exactly the descriptor projection', () => {
    expect(branches.map((b) => ({ code: b.code, name: b.name, pointOfSaleNumber: b.pointOfSaleNumber }))).toEqual(
      D.branches.map((b) => ({ code: b.code, name: b.name, pointOfSaleNumber: b.pointOfSaleNumber })),
    );
  });
});

// --- E. single-source ownership (structural) ---------------------------------------------------------------

describe('E one canonical source inside prisma/seed.ts', () => {
  it.each([
    'Centro',
    'REM-NEG-M',
    'Domicilio demo — ',
    'DEMO-',
    'Caja principal',
    'Indumentaria',
    'Mona Jacinta',
    'Producto de demostración',
    'Owner Demo',
    'owner01@demo.local',
  ])('E1 canonical literal %j is written exactly once', (literal) => {
    expect(occurrences(MODULE_CODE, literal)).toBe(1);
  });

  it.each([100, 200, 300, 400, 500, 600, 602, 603, 604, 605, 800, 801, 900, 1000, 2000])(
    'E2 canonical id namespace id(%i…) is derived exactly once',
    (n) => {
      const derivations = [...MODULE_CODE.matchAll(/\bid\((\d+)\b/g)].filter((m) => Number(m[1]) === n);
      expect(derivations).toHaveLength(1);
    },
  );

  it('E3 populate() consumes CANONICAL_DEMO_SEED', () => {
    expect(functionCode('populate')).toMatch(/\bCANONICAL_DEMO_SEED\b/);
  });

  it('E4 populate() derives no canonical id itself', () => {
    expect(functionCode('populate')).not.toMatch(/\bid\(/);
  });

  it('E5 scope convergence takes its assignments from CANONICAL_DEMO_SEED', () => {
    const converge = functionCode('convergeCanonicalScopes');
    const projection = constInitializer('canonicalAssignments');
    const fromDescriptor = /\bCANONICAL_DEMO_SEED\b/.test(converge) || (projection !== null && /\bCANONICAL_DEMO_SEED\b/.test(projection));
    expect(fromDescriptor).toBe(true);
  });
});

// --- F. assignment contract ------------------------------------------------------------------------------------

describe('F assignment contract', () => {
  it('F1 every LOCATION assignment names a canonical Branch; COMPANY ones name none', () => {
    const codes = new Set(D.branches.map((b) => b.code));
    for (const a of D.assignments) {
      if (a.scopeKind === 'LOCATION') expect(codes.has(a.branchCode!)).toBe(true);
      else expect(a.branchCode).toBeNull();
    }
  });
  it('F2 every assignment user is a canonical user, matched by both id and email', () => {
    const people = [...D.users, D.owner];
    for (const a of D.assignments) expect(people.some((u) => u.id === a.userId && u.email === a.email)).toBe(true);
    expect(new Set(D.assignments.map((a) => a.userId)).size).toBe(people.length);
  });
  it('F3 roles are Production role codes; the descriptor lists only the legacy rows the seed writes', () => {
    for (const a of D.assignments) expect(Object.values(ROLE_CODES)).toContain(a.roleCode);
    expect(D.roles.map((r) => r.code)).toEqual(['SELLER', 'CASHIER', 'MANAGER', 'ADMIN']);
  });
});

// --- G. baseline sufficiency ----------------------------------------------------------------------------------------

describe('G sufficiency for the LOCAL_TEST baseline', () => {
  it('G1 every seeded table the baseline facts contract names has a descriptor source', () => {
    const baseline = readFileSync(new URL('../scripts/local-test-baseline.ts', import.meta.url), 'utf8');
    const block = /export const SEEDED_TABLES = Object\.freeze\(\[([^\]]*)\]/.exec(baseline)?.[1] ?? '';
    const tables = [...block.matchAll(/'([a-zA-Z]+)'/g)].map((m) => m[1]);
    expect(tables.length).toBeGreaterThan(0);
    const source: Record<string, unknown> = {
      branches: D.branches,
      counters: D.saleNumberCounters,
      registers: D.cashRegisters,
      users: [...D.users, D.owner],
      roles: D.roles,
      permissions: D.permissions,
      rolePermissions: D.roles.flatMap((r) => r.permissionCodes),
      userBranchRoles: D.userBranchRoles,
      categories: [D.category],
      brands: [D.brand],
      products: D.products,
      variants: D.variants,
      inventory: D.inventory,
    };
    for (const table of tables) expect(source[table!], table).toBeDefined();
  });
  it('G2 holds no Company or Location identity (that is the TEST bootstrap, not the seed)', () => {
    expect(Object.keys(D).sort()).toEqual([
      'assignments', 'branches', 'brand', 'cashRegisters', 'category', 'inventory', 'owner', 'permissions',
      'products', 'roles', 'saleNumberCounters', 'userBranchRoles', 'userTimestamp', 'users', 'variants',
    ]);
  });
});

// --- H. no reset / env / DB ------------------------------------------------------------------------------------------

describe('H no reset, environment or database side effect', () => {
  it('H1 prisma/seed.ts reads no environment, builds no client, runs nothing at import', () => {
    expect(MODULE_CODE).not.toMatch(/process\.env|new PrismaClient|from ["']pg["']/);
    const topLevelCalls = AST.statements.filter((s) => ts.isExpressionStatement(s));
    expect(topLevelCalls).toHaveLength(0);
    const descriptor = constInitializer('CANONICAL_DEMO_SEED') ?? '';
    expect(descriptor).not.toMatch(/deleteMany|resetDemo|clear\(|truncate/i);
  });
});

// --- X. behavior preservation: the real seedDemo on a recording transaction ------------------------------------------

type Row = Record<string, unknown>;
function fakeDatabase(initial: Record<string, Row[]> = {}) {
  const tables = new Map<string, Row[]>(Object.entries(structuredClone(initial)));
  let generated = 0;
  const rows = (model: string) => {
    if (!tables.has(model)) tables.set(model, []);
    return tables.get(model)!;
  };
  const matches = (row: Row, where: Row = {}) =>
    Object.entries(where).every(([key, cond]) =>
      cond !== null && typeof cond === 'object' && 'in' in (cond as Row)
        ? ((cond as { in: unknown[] }).in).includes(row[key])
        : row[key] === cond,
    );
  const delegate = (model: string) => ({
    count: async (args?: { where?: Row }) => rows(model).filter((r) => matches(r, args?.where)).length,
    findMany: async (args?: { where?: Row }) => rows(model).filter((r) => matches(r, args?.where)).map((r) => ({ ...r })),
    findUnique: async (args: { where: Row }) => rows(model).find((r) => matches(r, args.where)) ?? null,
    upsert: async (args: { where: Row; create: Row; update: Row }) => {
      const found = rows(model).find((r) => matches(r, args.where));
      if (found) Object.assign(found, args.update);
      else rows(model).push({ ...args.create });
    },
    deleteMany: async (args?: { where?: Row }) => {
      const keep = rows(model).filter((r) => !matches(r, args?.where));
      const count = rows(model).length - keep.length;
      tables.set(model, keep);
      return { count };
    },
    createMany: async (args: { data: Row[]; skipDuplicates?: boolean }) => {
      for (const data of args.data) {
        const dup = rows(model).some((r) => Object.entries(data).every(([k, v]) => r[k] === v));
        if (!(args.skipDuplicates && dup)) rows(model).push({ ...data });
      }
    },
    create: async (args: { data: Row }) => {
      const row = { id: `generated-${++generated}`, ...args.data };
      rows(model).push(row);
      return row;
    },
  });
  const tx = new Proxy({} as Row, {
    get: (_target, prop: string) => (prop === '$queryRaw' ? async () => [] : delegate(prop)),
  });
  const client = { $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx) };
  return { client, rows };
}
const pick = (row: Row, keys: string[]) => Object.fromEntries(keys.map((k) => [k, row[k]]));
const legacyPermissionIds = new Set(D.permissions.map((p) => p.id));

describe('X behavior preservation (real seedDemo, in-memory transaction, no database)', () => {
  it('X1 seed #1 writes exactly the descriptor rows, COMPANY assignments only, no UserBranchRole', async () => {
    const db = fakeDatabase();
    await seedDemo(db.client as never);
    expect(db.rows('permission').filter((p) => legacyPermissionIds.has(p.id as string))).toEqual(D.permissions.map((p) => ({ ...p })));
    expect(db.rows('role').filter((r) => D.roles.some((d) => d.id === r.id))).toEqual(D.roles.map(({ id: rid, code, name }) => ({ id: rid, code, name })));
    const legacyGrants = db.rows('rolePermission').filter((g) => legacyPermissionIds.has(g.permissionId as string));
    const codeById = new Map(D.permissions.map((p) => [p.id, p.code]));
    for (const role of D.roles) {
      expect(legacyGrants.filter((g) => g.roleId === role.id).map((g) => codeById.get(g.permissionId as string)).sort()).toEqual([...role.permissionCodes].sort());
    }
    expect(db.rows('branch')).toEqual(D.branches.map((b) => ({ ...b })));
    expect(db.rows('saleNumberCounter')).toEqual(D.saleNumberCounters.map((c) => ({ ...c })));
    expect(db.rows('cashRegister')).toEqual(D.cashRegisters.map((c) => ({ ...c })));
    const users = db.rows('user');
    expect(users.map((u) => pick(u, ['id', 'name', 'email']))).toEqual([...D.users, D.owner].map((u) => ({ ...u })));
    for (const u of users.filter((x) => x.id !== D.owner.id)) {
      expect((u.createdAt as Date).toISOString()).toBe(D.userTimestamp);
      expect(u.isActive).toBe(true);
    }
    expect(db.rows('category')).toEqual([{ ...D.category }]);
    expect(db.rows('brand')).toEqual([{ ...D.brand }]);
    expect(db.rows('product')).toEqual(D.products.map((p) => ({ ...p })));
    expect(db.rows('productVariant')).toEqual(D.variants.map((v) => ({ ...v })));
    expect(db.rows('inventory')).toEqual(D.inventory.map((i) => ({ ...i })));
    expect(db.rows('userBranchRole')).toEqual([]);
    const scopes = db.rows('userRoleScope').map((s) => pick(s, ['userId', 'scopeKind', 'locationId']));
    expect(scopes).toEqual(D.assignments.filter((a) => a.scopeKind === 'COMPANY').map((a) => ({ userId: a.userId, scopeKind: 'COMPANY', locationId: null })));
  }, 20000);

  it('X2 with canonical Locations present, the seed converges to exactly the five descriptor assignments', async () => {
    const locations = D.branches.map((b) => ({ id: b.id, code: b.code }));
    const db = fakeDatabase({ location: locations });
    await seedDemo(db.client as never);
    const branchId = new Map(D.branches.map((b) => [b.code, b.id]));
    const scopes = db.rows('userRoleScope').map((s) => pick(s, ['userId', 'scopeKind', 'locationId']));
    expect(scopes).toEqual(
      D.assignments.map((a) => ({ userId: a.userId, scopeKind: a.scopeKind, locationId: a.branchCode === null ? null : branchId.get(a.branchCode) })),
    );
  }, 20000);
});
