// Task 4 RED6D: zero-database tests for scripts/local-test-baseline.ts.
// Classification/verification are pure over a facts snapshot; the runtime is
// exercised with injected fakes (db, proof, reader, seed, backfill, close).
// The canonical fixture below is derived independently from prisma/seed.ts
// (ids, addresses, users, catalog, inventory, assignments) — it is NOT read
// from production code, so it can pin the production default descriptor.
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  LOCAL_TEST_BASELINE_STATES,
  OPERATIONAL_MODELS,
  SEEDED_TABLES,
  canonicalLocations,
  classifyLocalTestBaseline,
  createLocalTestBaselineRuntime,
  defaultLocalTestCanonicalBaseline,
  verifyLocalTestBaseline,
  type LocalTestBaselineDatabase,
  type LocalTestBaselineFacts,
  type LocalTestCanonicalBaseline,
  type ScopeRow,
} from '../scripts/local-test-baseline.js';
import { TEST_COMPANY_BOOTSTRAP } from '../scripts/test-company-bootstrap.js';
import { permissions as legacyPermissions, rolePermissions as legacyGrants } from '../prisma/seed.js';
import { verifyBackfill } from '../src/modules/organization/organization.service.js';
import { CANONICAL_PERMISSION_IDS, CANONICAL_ROLE_IDS } from '../src/modules/rbac/catalog.service.js';
import { DEFAULT_ROLE_GRANTS } from '../src/modules/rbac/role-permission-matrix.js';
import { productionPermissionValues } from '../src/modules/rbac/permissions.js';

const SOURCE = readFileSync(new URL('../scripts/local-test-baseline.ts', import.meta.url), 'utf8');
const CODE = SOURCE.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');

// --- independent canonical fixture (prisma/seed.ts, read by hand) ------------------------

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SEED_BRANCHES = [
  ['CEN', 'Centro', 1],
  ['YB', 'Yerba Buena', 2],
  ['TV', 'Tafí Viejo', 3],
  ['BAN', 'Banda', 4],
  ['CON', 'Concepción', 5],
  ['DEP', 'Depósito Central', 6],
] as const;
const SEED_PRODUCTS = [
  ['Remera Básica', 'remera-basica', 4500000n, 2500000n, [['Negro', 'M', 'REM-NEG-M'], ['Blanco', 'S', 'REM-BLA-S']]],
  ['Jean Slim', 'jean-slim', 7500000n, 4000000n, [['Azul', '42', 'JEA-AZU-42'], ['Azul', '44', 'JEA-AZU-44']]],
  ['Campera Jean', 'campera-jean', 9500000n, 5500000n, [['Azul', 'M', 'CAM-AZU-M'], ['Azul', 'L', 'CAM-AZU-L']]],
] as const;
const LEGACY_ROLE_IDS: Record<string, string> = { SELLER: id(200), CASHIER: id(201), MANAGER: id(202), ADMIN: id(203) };
const roleIdFor = (code: string) => LEGACY_ROLE_IDS[code] ?? CANONICAL_ROLE_IDS[code as keyof typeof CANONICAL_ROLE_IDS];
const USER = { admin: id(600), seller: id(602), cashier: id(603), owner: id(604), warehouse: id(605) };
const MIGRATIONS = [
  { name: '20260101000000_alpha', checksum: 'a'.repeat(64) },
  { name: '20260102000000_beta', checksum: 'b'.repeat(64) },
];

function canonicalFixture(): LocalTestCanonicalBaseline {
  const branches = SEED_BRANCHES.map(([code, name, pos], i) => ({
    id: id(300 + i),
    code,
    name,
    address: `Domicilio demo — ${name}`,
    pointOfSaleNumber: pos,
  }));
  const products = SEED_PRODUCTS.map(([name, slug], i) => ({
    id: id(900 + i),
    name,
    slug,
    description: 'Producto de demostración',
    categoryId: id(800),
    brandId: id(801),
    isActive: true,
  }));
  const variants = SEED_PRODUCTS.flatMap(([, , price, costPrice, options], i) =>
    options.map(([color, size, sku], j) => ({
      id: id(1000 + i * 10 + j),
      productId: id(900 + i),
      sku,
      barcode: `DEMO-${sku}`,
      color,
      size,
      price,
      costPrice,
      isActive: true,
    })),
  );
  const inventory = SEED_PRODUCTS.flatMap(([, , , , options], i) =>
    options.flatMap((_, j) =>
      SEED_BRANCHES.map((_b, k) => ({
        id: id(2000 + i * 100 + j * 10 + k),
        variantId: id(1000 + i * 10 + j),
        branchId: id(300 + k),
        physical: k === 5 ? 50n : 20n,
        reserved: 0n,
      })),
    ),
  );
  const permissions = [
    ...legacyPermissions.map((code, i) => ({ id: id(100 + i), code })),
    ...productionPermissionValues.map((code) => ({ id: CANONICAL_PERMISSION_IDS[code], code })),
  ];
  const permissionId = new Map<string, string>(permissions.map((p) => [p.code, p.id]));
  const rolePermissions = [
    ...Object.entries(legacyGrants).flatMap(([role, codes]) => codes.map((c) => ({ roleId: roleIdFor(role)!, permissionId: permissionId.get(c)! }))),
    ...Object.entries(DEFAULT_ROLE_GRANTS).flatMap(([role, codes]) => codes.map((c) => ({ roleId: roleIdFor(role)!, permissionId: permissionId.get(c)! }))),
  ];
  const company: ScopeRow[] = [
    { userId: USER.owner, roleId: roleIdFor('OWNER')!, scopeKind: 'COMPANY', locationId: null },
    { userId: USER.admin, roleId: roleIdFor('ADMIN')!, scopeKind: 'COMPANY', locationId: null },
  ];
  return {
    migrations: MIGRATIONS,
    company: TEST_COMPANY_BOOTSTRAP,
    seeded: {
      branches,
      counters: branches.map((b, i) => ({ id: id(400 + i), branchId: b.id, nextValue: 1n })),
      registers: branches.map((b, i) => ({ id: id(500 + i), branchId: b.id, name: 'Caja principal' })),
      users: [
        { id: USER.admin, name: 'admin', email: 'admin@demo.local', isActive: true, password: 'default' },
        { id: USER.seller, name: 'seller01', email: 'seller01@demo.local', isActive: true, password: 'default' },
        { id: USER.cashier, name: 'cashier01', email: 'cashier01@demo.local', isActive: true, password: 'default' },
        { id: USER.owner, name: 'Owner Demo', email: 'owner01@demo.local', isActive: true, password: 'default' },
        { id: USER.warehouse, name: 'warehouse01', email: 'warehouse01@demo.local', isActive: true, password: 'default' },
      ],
      roles: [
        ...Object.entries(LEGACY_ROLE_IDS).map(([code, roleId]) => ({ id: roleId, code, name: code })),
        { id: CANONICAL_ROLE_IDS.OWNER, code: 'OWNER', name: 'OWNER' },
        { id: CANONICAL_ROLE_IDS.WAREHOUSE, code: 'WAREHOUSE', name: 'WAREHOUSE' },
      ],
      permissions,
      rolePermissions,
      userBranchRoles: [],
      categories: [{ id: id(800), name: 'Indumentaria' }],
      brands: [{ id: id(801), name: 'Mona Jacinta' }],
      products,
      variants,
      inventory,
    },
    seed1Scopes: company,
    finalScopes: [
      ...company,
      { userId: USER.seller, roleId: roleIdFor('SELLER')!, scopeKind: 'LOCATION', locationId: id(300) },
      { userId: USER.cashier, roleId: roleIdFor('CASHIER')!, scopeKind: 'LOCATION', locationId: id(300) },
      { userId: USER.warehouse, roleId: roleIdFor('WAREHOUSE')!, scopeKind: 'LOCATION', locationId: id(305) },
    ],
  };
}
const CANONICAL = canonicalFixture();

// --- facts per pipeline state --------------------------------------------------------------

const zeroOperational = () => Object.fromEntries(OPERATIONAL_MODELS.map((m) => [m, 0])) as LocalTestBaselineFacts['operational'];
const emptySeeded = () => Object.fromEntries(SEEDED_TABLES.map((t) => [t, []])) as unknown as LocalTestBaselineFacts['seeded'];
const migratedRows = () => MIGRATIONS.map((m) => ({ ...m, finished: true, rolledBack: false }));

type Stage = 'FRESH' | 'MIGRATED_EMPTY' | 'POST_SEED1' | 'POST_BACKFILL' | 'EXACT_BASELINE';
function facts(stage: Stage): LocalTestBaselineFacts {
  const c = structuredClone(CANONICAL);
  const base: LocalTestBaselineFacts = {
    migration: { schemaPresent: stage !== 'FRESH', rows: stage === 'FRESH' ? [] : migratedRows() },
    operational: zeroOperational(),
    seeded: emptySeeded(),
    companies: [],
    locations: [],
    userRoleScopes: [],
  };
  if (stage === 'FRESH' || stage === 'MIGRATED_EMPTY') return base;
  base.seeded = c.seeded;
  base.userRoleScopes = [...c.seed1Scopes];
  if (stage === 'POST_SEED1') return base;
  base.companies = [{ ...TEST_COMPANY_BOOTSTRAP, isActive: true }];
  base.locations = canonicalLocations(c);
  if (stage === 'EXACT_BASELINE') base.userRoleScopes = [...c.finalScopes];
  return base;
}
const classify = (f: unknown) => classifyLocalTestBaseline(f, CANONICAL).state;
function variant(stage: Stage, mutate: (f: LocalTestBaselineFacts) => void) {
  const f = facts(stage);
  mutate(f);
  return f;
}

// --- A. module / import safety ---------------------------------------------------------------

describe('A module and import safety', () => {
  it('A1 exposes the classifier, verifier, descriptor and runtime factory', () => {
    for (const fn of [classifyLocalTestBaseline, verifyLocalTestBaseline, canonicalLocations, defaultLocalTestCanonicalBaseline, createLocalTestBaselineRuntime]) {
      expect(typeof fn).toBe('function');
    }
    expect([...OPERATIONAL_MODELS].sort()).toEqual(
      ['auditLog', 'cashMovement', 'cashSession', 'sale', 'saleItem', 'salePayment', 'stockMovement', 'stockReservation'].sort(),
    );
  });

  it('A2 never reads the environment, builds a client or pool, resets, or selects a target itself', () => {
    expect(CODE).not.toMatch(/process\.env|new PrismaClient|from 'pg'|new Pool|\bresetDemo\b|demo-database|DATABASE_URL|\$executeRaw|deleteMany|DEMO_COMPANY/);
    expect(SOURCE).toMatch(/import \{ branches as seedBranches, seedDemo \} from '\.\.\/prisma\/seed\.js'/);
  });

  it('A3 the state vocabulary is exactly the prepare orchestrator one', () => {
    const prepare = readFileSync(new URL('../../scripts/database/local-test-prepare.mjs', import.meta.url), 'utf8');
    const block = /export const PREPARE_STATES = Object\.freeze\(\[([^\]]*)\]\)/.exec(prepare)?.[1] ?? '';
    const states = [...block.matchAll(/'([A-Z_0-9]+)'/g)].map((m) => m[1]);
    expect(states).toHaveLength(9);
    expect([...LOCAL_TEST_BASELINE_STATES]).toEqual(states);
  });
});

// --- C. migration state -------------------------------------------------------------------------

describe('C migration-state classification', () => {
  it('C1 no application schema and no history is FRESH', () => {
    expect(classify(facts('FRESH'))).toBe('FRESH');
  });
  it('C2 history without the schema is MIGRATION_DRIFT', () => {
    expect(classify(variant('FRESH', (f) => { f.migration.rows = migratedRows(); }))).toBe('MIGRATION_DRIFT');
  });
  it('C3 a schema without any history is MIGRATION_DRIFT', () => {
    expect(classify(variant('MIGRATED_EMPTY', (f) => { f.migration.rows = []; }))).toBe('MIGRATION_DRIFT');
  });
  it('C4 exact names with a different checksum are MIGRATION_DRIFT', () => {
    expect(classify(variant('MIGRATED_EMPTY', (f) => { f.migration.rows[1]!.checksum = 'c'.repeat(64); }))).toBe('MIGRATION_DRIFT');
  });
  it('C5 an unfinished migration is MIGRATION_DRIFT', () => {
    expect(classify(variant('MIGRATED_EMPTY', (f) => { f.migration.rows[1]!.finished = false; }))).toBe('MIGRATION_DRIFT');
  });
  it('C6 a rolled-back migration row is MIGRATION_DRIFT', () => {
    expect(classify(variant('MIGRATED_EMPTY', (f) => { f.migration.rows[0]!.rolledBack = true; }))).toBe('MIGRATION_DRIFT');
  });
  it('C7 a foreign migration appended is MIGRATION_DRIFT', () => {
    expect(classify(variant('MIGRATED_EMPTY', (f) => { f.migration.rows.push({ name: '20270101000000_foreign', checksum: 'f'.repeat(64), finished: true, rolledBack: false }); }))).toBe('MIGRATION_DRIFT');
  });
  it('C8 a partial set is MIGRATION_DRIFT', () => {
    expect(classify(variant('MIGRATED_EMPTY', (f) => { f.migration.rows.pop(); }))).toBe('MIGRATION_DRIFT');
  });
  it('C9 a checksum drift outranks an otherwise exact baseline', () => {
    expect(classify(variant('EXACT_BASELINE', (f) => { f.migration.rows[0]!.checksum = 'd'.repeat(64); }))).toBe('MIGRATION_DRIFT');
  });
});

// --- D. operational data gate --------------------------------------------------------------------

describe('D operational-data gate', () => {
  for (const model of OPERATIONAL_MODELS) {
    it(`D1 one ${model} row on an exact baseline is OPERATIONAL_DATA`, () => {
      expect(classify(variant('EXACT_BASELINE', (f) => { f.operational[model] = 1; }))).toBe('OPERATIONAL_DATA');
    });
  }
  it('D2 operational rows outrank unsafe business shape (POST_SEED1 + foreign Company + Sale)', () => {
    expect(classify(variant('POST_SEED1', (f) => {
      f.companies = [{ id: id(9999), name: 'Other', cuit: '30-99999999-9', address: 'x', isActive: true }];
      f.operational.sale = 1;
    }))).toBe('OPERATIONAL_DATA');
  });
});

// --- E/F/G/H. recognized pipeline states -------------------------------------------------------------

describe('E-H recognized pipeline states', () => {
  it.each(['MIGRATED_EMPTY', 'POST_SEED1', 'POST_BACKFILL', 'EXACT_BASELINE'] as const)('E1 the exact %s facts classify as %s', (stage) => {
    expect(classify(facts(stage))).toBe(stage);
  });
});

// --- I. unsafe / partial drift ----------------------------------------------------------------------

const UNSAFE: Array<[string, Stage, (f: LocalTestBaselineFacts) => void]> = [
  // migrated-empty neighbours
  ['E2 a stray Branch after migration', 'MIGRATED_EMPTY', (f) => { f.seeded.branches.push({ ...CANONICAL.seeded.branches[0]! }); }],
  ['E3 only a Company after migration', 'MIGRATED_EMPTY', (f) => { f.companies = [{ ...TEST_COMPANY_BOOTSTRAP, isActive: true }]; }],
  // seeded-data overwrite hazards (seedDemo would silently reset these)
  ['N1 SaleNumberCounter.nextValue 2 with no Sale', 'POST_SEED1', (f) => { f.seeded.counters[0]!.nextValue = 2n; }],
  ['N2 one Inventory quantity changed with no StockMovement', 'POST_SEED1', (f) => { f.seeded.inventory[3]!.physical = 19n; }],
  ['N3 reserved stock without a reservation row', 'POST_BACKFILL', (f) => { f.seeded.inventory[0]!.reserved = 1n; }],
  ['N4 one extra Product', 'POST_SEED1', (f) => { f.seeded.products.push({ ...f.seeded.products[0]!, id: id(999), slug: 'extra' }); }],
  ['N5 one missing Variant', 'POST_SEED1', (f) => { f.seeded.variants.pop(); }],
  ['N6 a Variant price changed', 'EXACT_BASELINE', (f) => { f.seeded.variants[0]!.price = 1n; }],
  ['N7 canonical email with a different user id', 'POST_SEED1', (f) => { f.seeded.users[1]!.id = id(777); }],
  ['N8 canonical user id with a different email', 'POST_SEED1', (f) => { f.seeded.users[1]!.email = 'someone@demo.local'; }],
  ['N9 a canonical user whose password is not the LOCAL_TEST default', 'EXACT_BASELINE', (f) => { f.seeded.users[0]!.password = 'other'; }],
  ['N10 a deactivated canonical user', 'EXACT_BASELINE', (f) => { f.seeded.users[2]!.isActive = false; }],
  ['N11 an extra non-canonical user', 'POST_SEED1', (f) => { f.seeded.users.push({ id: id(888), name: 'x', email: 'x@demo.local', isActive: true, password: 'default' }); }],
  // SELLER's first legacy grant (sale.create) becomes legacy audit.view, which SELLER never holds.
  ['N12 a Role grant swapped (same grant count)', 'POST_SEED1', (f) => { f.seeded.rolePermissions[0]!.permissionId = id(111); }],
  ['N13 a legacy UserBranchRole row', 'EXACT_BASELINE', (f) => { f.seeded.userBranchRoles.push({ userId: USER.seller, branchId: id(300), roleId: id(200) }); }],
  ['N14 an extra CashRegister', 'POST_SEED1', (f) => { f.seeded.registers.push({ id: id(599), branchId: id(300), name: 'Caja 2' }); }],
  ['N15 a CashRegister renamed', 'POST_SEED1', (f) => { f.seeded.registers[0]!.name = 'Caja secundaria'; }],
  // Branch exactness
  ['K1 a Branch code changed (same count)', 'POST_SEED1', (f) => { f.seeded.branches[1]!.code = 'YBX'; }],
  ['K2 a Branch id changed (same code)', 'POST_SEED1', (f) => { f.seeded.branches[2]!.id = id(399); }],
  ['K3 a Branch pointOfSaleNumber changed', 'POST_SEED1', (f) => { f.seeded.branches[3]!.pointOfSaleNumber = 44; }],
  // seed-1 scope shape
  ['M1 zero Locations but a different COMPANY role at the right count', 'POST_SEED1', (f) => { f.userRoleScopes[1]!.roleId = roleIdFor('WAREHOUSE')!; }],
  ['M2 zero Locations but a third COMPANY scope', 'POST_SEED1', (f) => { f.userRoleScopes.push({ userId: USER.seller, roleId: roleIdFor('SELLER')!, scopeKind: 'COMPANY', locationId: null }); }],
  // Company exactness
  ['J1 Company with the right cuit but a different id', 'POST_BACKFILL', (f) => { f.companies[0]!.id = id(9001); for (const l of f.locations) l.companyId = id(9001); }],
  ['J2 Company with the right id but a different cuit', 'POST_BACKFILL', (f) => { f.companies[0]!.cuit = '30-00000000-0'; }],
  ['J3 Company with fallback (non-descriptor) name', 'EXACT_BASELINE', (f) => { f.companies[0]!.name = 'Mona Jacinta'; }],
  ['J4 Company with a different address', 'EXACT_BASELINE', (f) => { f.companies[0]!.address = 'Otra dirección'; }],
  ['J5 an inactive Company', 'EXACT_BASELINE', (f) => { f.companies[0]!.isActive = false; }],
  ['J6 the canonical Company plus a second Company', 'EXACT_BASELINE', (f) => { f.companies.push({ id: id(9002), name: 'B', cuit: '30-22222222-2', address: 'b', isActive: true }); }],
  ['J7 a Company but no Locations', 'POST_SEED1', (f) => { f.companies = [{ ...TEST_COMPANY_BOOTSTRAP, isActive: true }]; }],
  // Location exactness
  ['L1 five of six Locations', 'POST_BACKFILL', (f) => { f.locations.pop(); }],
  ['L2 six Locations plus a factory Location', 'EXACT_BASELINE', (f) => { f.locations.push({ ...f.locations[0]!, id: id(3999), code: 'FAC-1', pointOfSaleNumber: 99 }); }],
  ['L3 six Locations, one with the wrong type', 'POST_BACKFILL', (f) => { f.locations[0]!.type = 'CENTRAL_WAREHOUSE'; }],
  ['L4 six Locations with two Branch mappings swapped', 'POST_BACKFILL', (f) => { const a = f.locations[0]!.id; f.locations[0]!.id = f.locations[1]!.id; f.locations[1]!.id = a; }],
  ['L5 a Location display-name drift', 'EXACT_BASELINE', (f) => { f.locations[4]!.name = 'Concepción Norte'; }],
  ['L6 a Location address drift', 'POST_BACKFILL', (f) => { f.locations[2]!.address = 'Otra calle'; }],
  ['L7 an inactive Location', 'EXACT_BASELINE', (f) => { f.locations[5]!.isActive = false; }],
  ['L8 a Location with a different pointOfSaleNumber', 'EXACT_BASELINE', (f) => { f.locations[1]!.pointOfSaleNumber = 22; }],
  // final scope exactness
  ['M3 right scope count but seller at the wrong Location', 'EXACT_BASELINE', (f) => { f.userRoleScopes[2]!.locationId = id(301); }],
  ['M4 right scope count but warehouse scoped COMPANY', 'EXACT_BASELINE', (f) => { f.userRoleScopes[4] = { ...f.userRoleScopes[4]!, scopeKind: 'COMPANY', locationId: null }; }],
  ['M5 an extra UserRoleScope', 'EXACT_BASELINE', (f) => { f.userRoleScopes.push({ userId: USER.admin, roleId: roleIdFor('SELLER')!, scopeKind: 'LOCATION', locationId: id(301) }); }],
  ['M6 a missing UserRoleScope', 'EXACT_BASELINE', (f) => { f.userRoleScopes.pop(); }],
  ['M7 backfilled with a partial second seed (three scopes)', 'POST_BACKFILL', (f) => { f.userRoleScopes.push({ userId: USER.seller, roleId: roleIdFor('SELLER')!, scopeKind: 'LOCATION', locationId: id(300) }); }],
  // half-applied transactional phases
  ['T1 users seeded but no inventory (half a seed)', 'POST_SEED1', (f) => { f.seeded.inventory = []; }],
  ['T2 exact baseline with its Company removed but Locations kept', 'EXACT_BASELINE', (f) => { f.companies = []; }],
];

describe('I unsafe or partial states are PARTIAL_UNSAFE, never a resumable state', () => {
  it.each(UNSAFE)('%s', (_label, stage, mutate) => {
    expect(classify(variant(stage, mutate))).toBe('PARTIAL_UNSAFE');
  });
});

// --- U. malformed facts --------------------------------------------------------------------------------

describe('U malformed facts are UNKNOWN', () => {
  it.each([['null', null], ['undefined', undefined], ['a number', 42], ['an array', []]])('U1 %s', (_label, value) => {
    expect(classify(value)).toBe('UNKNOWN');
  });
  it('U2 duplicate primary keys (impossible under the schema) are UNKNOWN', () => {
    expect(classify(variant('EXACT_BASELINE', (f) => { f.seeded.branches[1] = { ...f.seeded.branches[0]! }; }))).toBe('UNKNOWN');
  });
  it('U3 a negative or non-integer operational count is UNKNOWN', () => {
    expect(classify(variant('EXACT_BASELINE', (f) => { f.operational.sale = -1; }))).toBe('UNKNOWN');
    expect(classify(variant('EXACT_BASELINE', (f) => { f.operational.auditLog = Number.NaN; }))).toBe('UNKNOWN');
  });
  it('U4 a missing table is UNKNOWN, not a crash', () => {
    const f = facts('EXACT_BASELINE') as unknown as { seeded: Record<string, unknown> };
    delete f.seeded.inventory;
    expect(classify(f)).toBe('UNKNOWN');
  });
  it('U5 duplicate identical scope rows are UNKNOWN', () => {
    expect(classify(variant('EXACT_BASELINE', (f) => { f.userRoleScopes[4] = { ...f.userRoleScopes[0]! }; }))).toBe('UNKNOWN');
  });
});

// --- O. strict verifier ----------------------------------------------------------------------------------

describe('O strict final verifier', () => {
  it('O1 accepts only the exact baseline', () => {
    expect(verifyLocalTestBaseline(facts('EXACT_BASELINE'), CANONICAL).ok).toBe(true);
  });
  it.each(['FRESH', 'MIGRATED_EMPTY', 'POST_SEED1', 'POST_BACKFILL'] as const)('O2 rejects the resumable state %s', (stage) => {
    expect(verifyLocalTestBaseline(facts(stage), CANONICAL).ok).toBe(false);
  });
  it('O3 rejects every value drift that a count-only check would miss', () => {
    for (const [label, stage, mutate] of UNSAFE.filter(([, stage]) => stage === 'EXACT_BASELINE')) {
      expect(verifyLocalTestBaseline(variant(stage, mutate), CANONICAL).ok, label).toBe(false);
    }
    const drifted = variant('EXACT_BASELINE', (f) => { f.seeded.counters[5]!.nextValue = 7n; f.seeded.inventory[0]!.physical = 1n; });
    expect(verifyLocalTestBaseline(drifted, CANONICAL).ok).toBe(false);
  });
  it('O4 is stricter than verifyBackfill: a non-canonical singleton Company passes verifyBackfill, fails the baseline', async () => {
    const f = variant('EXACT_BASELINE', (x) => {
      x.companies[0] = { ...x.companies[0]!, id: id(9003), name: 'Fallback SA' };
      for (const l of x.locations) l.companyId = id(9003);
    });
    const db = {
      branch: { findMany: async () => f.seeded.branches },
      location: { findMany: async () => f.locations },
      company: { findMany: async () => f.companies },
    };
    const backfill = await verifyBackfill(db as unknown as Parameters<typeof verifyBackfill>[0]);
    expect(backfill.ok).toBe(true);
    expect(verifyLocalTestBaseline(f, CANONICAL).ok).toBe(false);
  });
  it('O5 classifying and verifying never mutate the facts', () => {
    const f = facts('EXACT_BASELINE');
    const before = JSON.stringify(f, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v));
    classifyLocalTestBaseline(f, CANONICAL);
    verifyLocalTestBaseline(f, CANONICAL);
    expect(JSON.stringify(f, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v))).toBe(before);
  });
});

// --- V. production canonical descriptor ------------------------------------------------------------------

describe('V production canonical descriptor', () => {
  it('V1 uses the shared TEST Company descriptor object and requires approved migrations', () => {
    expect(defaultLocalTestCanonicalBaseline(MIGRATIONS).company).toBe(TEST_COMPANY_BOOTSTRAP);
    expect(() => defaultLocalTestCanonicalBaseline([])).toThrow();
  });
  it('V2 equals the canonical seed data (ids, addresses, users, catalog, inventory, assignments)', () => {
    const d = defaultLocalTestCanonicalBaseline(MIGRATIONS);
    for (const table of ['branches', 'counters', 'registers', 'users', 'userBranchRoles', 'categories', 'brands', 'products', 'variants', 'inventory'] as const) {
      expect(d.seeded[table], table).toEqual(CANONICAL.seeded[table]);
    }
    expect(d.seed1Scopes).toEqual(CANONICAL.seed1Scopes);
    expect(d.finalScopes).toEqual(CANONICAL.finalScopes);
  });
});

// --- P/Q/R. runtime factory ---------------------------------------------------------------------------------

function runtimeHarness(readFacts: () => unknown = () => facts('EXACT_BASELINE')) {
  const calls: string[] = [];
  const db = { fake: 'db' } as unknown as LocalTestBaselineDatabase;
  const deps = {
    db,
    canonical: CANONICAL,
    proveIdentity: vi.fn(async () => { calls.push('prove'); }),
    readFacts: vi.fn(async () => { calls.push('read'); return readFacts(); }),
    close: vi.fn(async () => { calls.push('close'); }),
    seed: vi.fn(async (..._args: unknown[]) => { calls.push('seed'); }),
    backfill: vi.fn(async (..._args: unknown[]) => { calls.push('backfill'); }),
  };
  return { runtime: createLocalTestBaselineRuntime(deps), deps, calls, db };
}

describe('P/Q/R runtime factory', () => {
  it('P1 seedDemo runs the seed exactly once with the db only (default password, no options)', async () => {
    const { runtime, deps, db } = runtimeHarness();
    await runtime.seedDemo();
    expect(deps.seed).toHaveBeenCalledTimes(1);
    expect(deps.seed.mock.calls[0]).toEqual([db]);
  });
  it('Q1 backfill runs once with the shared TEST Company descriptor object', async () => {
    const { runtime, deps, db } = runtimeHarness();
    await runtime.backfillCompanyLocations();
    expect(deps.backfill).toHaveBeenCalledTimes(1);
    expect(deps.backfill.mock.calls[0]![0]).toBe(db);
    expect(deps.backfill.mock.calls[0]![1]).toBe(TEST_COMPANY_BOOTSTRAP);
  });
  it('R1 classify and verify only read; they never seed, backfill or close', async () => {
    const { runtime, calls } = runtimeHarness();
    expect(await runtime.classify()).toBe('EXACT_BASELINE');
    await runtime.verifyBaseline();
    expect(calls).toEqual(['read', 'read']);
  });
  it('R2 proveIdentity delegates to the supplied LOCAL_TEST proof', async () => {
    const { runtime, calls } = runtimeHarness();
    await runtime.proveIdentity();
    expect(calls).toEqual(['prove']);
  });
  it('R3 verifyBaseline throws a fixed message on a non-exact state', async () => {
    const { runtime } = runtimeHarness(() => facts('POST_BACKFILL'));
    await expect(runtime.verifyBaseline()).rejects.toThrow(/^LOCAL_TEST baseline verification failed/);
  });
  it('R4 close releases the caller resources exactly once', async () => {
    const { runtime, deps } = runtimeHarness();
    await runtime.close();
    await runtime.close();
    expect(deps.close).toHaveBeenCalledTimes(1);
  });
  it('R5 after close every method refuses without touching its dependency', async () => {
    const { runtime, calls } = runtimeHarness();
    await runtime.close();
    for (const method of ['proveIdentity', 'classify', 'seedDemo', 'backfillCompanyLocations', 'verifyBaseline'] as const) {
      await expect(runtime[method](), method).rejects.toThrow();
    }
    expect(calls).toEqual(['close']);
  });
  it('R6 the factory refuses incomplete dependencies (no implicit target or proof)', () => {
    const { deps } = runtimeHarness();
    for (const key of ['db', 'proveIdentity', 'readFacts', 'close', 'canonical'] as const) {
      expect(() => createLocalTestBaselineRuntime({ ...deps, [key]: undefined } as never), key).toThrow();
    }
    expect(() => createLocalTestBaselineRuntime({ ...deps, canonical: { ...CANONICAL, migrations: [] } })).toThrow();
  });
});
