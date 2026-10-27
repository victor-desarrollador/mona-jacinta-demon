// Task 4 RED6E: zero-database tests for readLocalTestBaselineFacts (the live
// LOCAL_TEST database → LocalTestBaselineFacts mapping). An adversarial fake
// Prisma client stands in for the database: it serves fixture rows, records
// every call on the outer client and on the transaction client separately, and
// turns anything a read-only reader must never do (mutations, $disconnect,
// queries on missing tables, unselected reads, filtered reads, unregistered or
// interpolated raw SQL) into a recorded violation plus a thrown error.
import { readFileSync } from 'node:fs';
import { hash } from 'bcryptjs';
import { describe, expect, it } from 'vitest';
import {
  APPLICATION_TABLES,
  OPERATIONAL_MODELS,
  canonicalLocations,
  classifyLocalTestBaseline,
  defaultLocalTestCanonicalBaseline,
  readFactsOnTransaction,
  readLocalTestBaselineFacts,
  seedPasswordState,
  type LocalTestBaselineFacts,
  type LocalTestBaselineReadDatabase,
  type PasswordState,
} from '../scripts/local-test-baseline.js';
import { resolveSeedPassword } from '../prisma/seed.js';
import { TEST_COMPANY_BOOTSTRAP } from '../scripts/test-company-bootstrap.js';

const SOURCE = readFileSync(new URL('../scripts/local-test-baseline.ts', import.meta.url), 'utf8');
const READER_SOURCE = SOURCE.slice(SOURCE.indexOf('export async function readLocalTestBaselineFacts'));
const MIGRATIONS = [
  { name: '20260101000000_alpha', checksum: 'a'.repeat(64) },
  { name: '20260102000000_beta', checksum: 'b'.repeat(64) },
];
const K = defaultLocalTestCanonicalBaseline(MIGRATIONS);
const SENTINEL = 'postgresql://mona_local_test:reader-secret@127.0.0.1:5432/mona_local_test';

// --- fake database ----------------------------------------------------------------------------

type Row = Record<string, unknown>;
const DELEGATE_TABLE: Record<string, string> = {
  company: 'Company', location: 'Location', user: 'User', role: 'Role', permission: 'Permission',
  rolePermission: 'RolePermission', userRoleScope: 'UserRoleScope', branch: 'Branch', userBranchRole: 'UserBranchRole',
  category: 'Category', brand: 'Brand', product: 'Product', productVariant: 'ProductVariant', inventory: 'Inventory',
  stockMovement: 'StockMovement', stockReservation: 'StockReservation', sale: 'Sale', saleItem: 'SaleItem',
  salePayment: 'SalePayment', cashRegister: 'CashRegister', cashSession: 'CashSession', cashMovement: 'CashMovement',
  auditLog: 'AuditLog', saleNumberCounter: 'SaleNumberCounter',
};
type Call = { channel: 'outer' | 'tx'; kind: string; target: string; args?: unknown };
const SETTINGS_SQL =
  "SELECT current_setting('transaction_isolation') AS transaction_isolation, current_setting('transaction_read_only') AS transaction_read_only";
type FakeOptions = {
  present?: readonly string[];
  data?: Record<string, Row[]>;
  counts?: Partial<Record<string, number>>;
  migrationRows?: Row[];
  presenceRows?: Row[];
  failDelegate?: string;
  failRaw?: 'presence' | 'migrations';
};

function fakeDatabase(options: FakeOptions = {}) {
  const present = new Set(options.present ?? [...APPLICATION_TABLES, '_prisma_migrations']);
  const data = options.data ?? {};
  const calls: Call[] = [];
  const violations: string[] = [];
  const violate = (message: string): never => {
    violations.push(message);
    throw new Error(`fake-db violation: ${message}`);
  };
  const delegate = (name: string, channel: Call['channel']) =>
    new Proxy({} as Row, {
      get: (_t, method: string) => async (args?: Row) => {
        calls.push({ channel, kind: method, target: name, args });
        const table = DELEGATE_TABLE[name]!;
        if (!['findMany', 'count'].includes(method)) return violate(`forbidden ${name}.${method}`);
        if (!present.has(table)) return violate(`query on missing table ${table}`);
        if (options.failDelegate === name) throw new Error(`read failed on ${SENTINEL}`);
        if (args && 'where' in args) violations.push(`filtered read ${name}`);
        if (method === 'count') return options.counts?.[name] ?? (data[name] ?? []).length;
        const select = args?.select as Record<string, boolean> | undefined;
        if (!select) return violate(`unselected read ${name}`);
        return (data[name] ?? []).map((row) =>
          Object.fromEntries(
            Object.keys(select).map((key) => {
              if (!(key in row)) violate(`${name}.${key} is not a fixture column`);
              return [key, row[key]];
            }),
          ),
        );
      },
    });
  const queryRaw = (channel: Call['channel']) => async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('?');
    calls.push({ channel, kind: '$queryRaw', target: sql });
    if (values.length > 0) violate('interpolated raw SQL');
    if (sql.includes('to_regclass')) {
      if (options.failRaw === 'presence') throw new Error(`presence failed on ${SENTINEL}`);
      return options.presenceRows ?? [Object.fromEntries([...APPLICATION_TABLES, '_prisma_migrations'].map((t) => [t, present.has(t)]))];
    }
    if (/FROM public\._prisma_migrations/.test(sql)) {
      if (!present.has('_prisma_migrations')) return violate('query on missing _prisma_migrations');
      if (options.failRaw === 'migrations') throw new Error(`migrations failed on ${SENTINEL}`);
      return options.migrationRows ?? [];
    }
    if (/set_config\('transaction_read_only', 'on', true\)/.test(sql)) return [{ set_config: 'on' }];
    // Exact match only; a server that honours the requested snapshot semantics.
    if (sql === SETTINGS_SQL) {
      if (channel !== 'tx') return violate('transaction settings observed outside the transaction');
      return [{ transaction_isolation: 'repeatable read', transaction_read_only: 'on' }];
    }
    return violate(`unregistered raw SQL: ${sql.slice(0, 60)}`);
  };
  const client = (channel: Call['channel']): Row =>
    new Proxy({} as Row, {
      get: (_t, prop: string) => {
        if (prop === 'then') return undefined;
        if (prop === '$queryRaw') return queryRaw(channel);
        if (prop in DELEGATE_TABLE) return delegate(prop, channel);
        if (channel === 'outer' && prop === '$transaction') {
          return async (fn: unknown, txOptions?: unknown) => {
            calls.push({ channel, kind: '$transaction', target: 'interactive', args: txOptions });
            if (typeof fn !== 'function') return violate('batch $transaction');
            return (fn as (tx: unknown) => Promise<unknown>)(client('tx'));
          };
        }
        return () => violate(`forbidden ${channel}.${prop}`);
      },
    });
  return { db: client('outer') as unknown as LocalTestBaselineReadDatabase, calls, violations };
}

// Database rows (with the extra columns a real row carries) for the exact baseline.
function exactData(): Record<string, Row[]> {
  const s = structuredClone(K.seeded);
  return {
    branch: s.branches,
    saleNumberCounter: s.counters,
    cashRegister: s.registers,
    user: s.users.map(({ password: _password, ...u }) => ({ ...u, passwordHash: `hash-of-${u.id}`, createdAt: new Date(0) })),
    role: s.roles,
    permission: s.permissions,
    rolePermission: s.rolePermissions,
    userBranchRole: [],
    category: s.categories,
    brand: s.brands,
    product: s.products,
    productVariant: s.variants,
    inventory: s.inventory,
    company: [{ ...TEST_COMPANY_BOOTSTRAP, isActive: true, createdAt: new Date(0) }],
    location: canonicalLocations(K).map((l) => ({ ...l })),
    userRoleScope: K.finalScopes.map((scope, i) => ({ id: `scope-${i}`, ...scope })),
  };
}
const exactMigrationRows = () => MIGRATIONS.map((m) => ({ ...m, finished: true, rolledBack: false }));
const expectedFacts = (): LocalTestBaselineFacts => ({
  migration: { schemaPresent: true, rows: exactMigrationRows() },
  operational: Object.fromEntries(OPERATIONAL_MODELS.map((m) => [m, 0])) as LocalTestBaselineFacts['operational'],
  seeded: structuredClone(K.seeded) as LocalTestBaselineFacts['seeded'],
  companies: [{ ...TEST_COMPANY_BOOTSTRAP, isActive: true }],
  locations: canonicalLocations(K),
  userRoleScopes: [...K.finalScopes],
});
// Deterministic comparator: fixture hashes `hash-of-<id>` are the default password.
function comparator() {
  const seen: string[] = [];
  const fn = async (passwordHash: string): Promise<PasswordState> => {
    seen.push(passwordHash);
    return passwordHash.startsWith('hash-of-') ? 'default' : 'other';
  };
  return { fn, seen };
}
async function read(options: FakeOptions = {}, passwordState = comparator().fn) {
  const fake = fakeDatabase({ data: exactData(), migrationRows: exactMigrationRows(), ...options });
  const facts = await readLocalTestBaselineFacts(fake.db, { passwordState });
  return { ...fake, facts, state: classifyLocalTestBaseline(facts, K).state };
}
const delegateCalls = (calls: Call[]) => calls.filter((c) => c.kind === 'findMany' || c.kind === 'count');
const withoutTable = (table: string) => [...APPLICATION_TABLES, '_prisma_migrations'].filter((t) => t !== table);

// --- A. module ---------------------------------------------------------------------------------

describe('A reader module', () => {
  it('A1 exports the reader, the seed password state and the application table list', () => {
    expect(typeof readLocalTestBaselineFacts).toBe('function');
    expect(typeof seedPasswordState).toBe('function');
    expect(APPLICATION_TABLES).toHaveLength(24);
  });
  it('A2 selects no target, closes nothing, never uses unsafe/mutating raw SQL and never reads canonical data', () => {
    expect(READER_SOURCE).not.toMatch(/process\.env|DATABASE_URL|\$queryRawUnsafe|\$executeRaw|\$disconnect|\.end\(\)/);
    expect(READER_SOURCE).not.toMatch(/CANONICAL_DEMO_SEED|defaultLocalTestCanonicalBaseline|TEST_COMPANY_BOOTSTRAP|canonicalLocations/);
    expect(SOURCE).not.toMatch(/demo123/);
  });
});

// --- B. schema presence --------------------------------------------------------------------------

describe('B schema presence before any model query', () => {
  it('B1 no application tables and no migration table: FRESH facts, zero model queries', async () => {
    const r = await read({ present: [] });
    expect(r.state).toBe('FRESH');
    expect(delegateCalls(r.calls)).toEqual([]);
    expect(r.violations).toEqual([]);
  });
  it('B2 an empty migration table without application tables is still FRESH', async () => {
    const r = await read({ present: ['_prisma_migrations'], migrationRows: [] });
    expect(r.state).toBe('FRESH');
    expect(delegateCalls(r.calls)).toEqual([]);
  });
  it('B3 migration history without the application schema is read and classified MIGRATION_DRIFT', async () => {
    const r = await read({ present: ['_prisma_migrations'] });
    expect((r.facts as LocalTestBaselineFacts).migration.rows).toEqual(exactMigrationRows());
    expect(r.state).toBe('MIGRATION_DRIFT');
    expect(delegateCalls(r.calls)).toEqual([]);
  });
  it('B4 only one application table (Branch) is unreadable → UNKNOWN, with no model query', async () => {
    const r = await read({ present: ['Branch', '_prisma_migrations'] });
    expect(r.state).toBe('UNKNOWN');
    expect(delegateCalls(r.calls)).toEqual([]);
    expect(r.violations).toEqual([]);
  });
  it('B5 every application table but AuditLog → UNKNOWN, with no model query', async () => {
    const r = await read({ present: withoutTable('AuditLog') });
    expect(r.state).toBe('UNKNOWN');
    expect(delegateCalls(r.calls)).toEqual([]);
    expect(r.violations).toEqual([]);
  });
  it('B6 every application table but Inventory → UNKNOWN, with no model query', async () => {
    const r = await read({ present: withoutTable('Inventory') });
    expect(r.state).toBe('UNKNOWN');
    expect(delegateCalls(r.calls)).toEqual([]);
    expect(r.violations).toEqual([]);
  });
  it('B7 the full application schema without a migration table reads as MIGRATION_DRIFT', async () => {
    const r = await read({ present: [...APPLICATION_TABLES] });
    expect((r.facts as LocalTestBaselineFacts).migration).toEqual({ schemaPresent: true, rows: [] });
    expect(r.state).toBe('MIGRATION_DRIFT');
    expect(r.violations).toEqual([]);
  });
  it.each([
    ['no presence row', []],
    ['two presence rows', [Object.fromEntries(APPLICATION_TABLES.map((t) => [t, true])), Object.fromEntries(APPLICATION_TABLES.map((t) => [t, true]))]],
    ['a non-boolean presence value', [{ ...Object.fromEntries([...APPLICATION_TABLES, '_prisma_migrations'].map((t) => [t, true])), Branch: 't' }]],
  ])('B8 a malformed presence result (%s) is UNKNOWN', async (_label, presenceRows) => {
    const r = await read({ presenceRows: presenceRows as Row[] });
    expect(r.state).toBe('UNKNOWN');
    expect(delegateCalls(r.calls)).toEqual([]);
  });
});

// --- C. migration history --------------------------------------------------------------------------

describe('C migration history rows', () => {
  it('C1 the exact live database maps to facts the classifier recognizes as EXACT_BASELINE', async () => {
    const r = await read();
    expect(r.facts).toEqual(expectedFacts());
    expect(r.state).toBe('EXACT_BASELINE');
    expect(r.violations).toEqual([]);
  });
  it('C2 a duplicated migration row is preserved (→ MIGRATION_DRIFT)', async () => {
    const r = await read({ migrationRows: [...exactMigrationRows(), exactMigrationRows()[1]!] });
    expect((r.facts as LocalTestBaselineFacts).migration.rows).toHaveLength(3);
    expect(r.state).toBe('MIGRATION_DRIFT');
  });
  it.each([
    ['a null migration name', { name: null }],
    ['a non-string checksum', { checksum: 42 }],
    ['a non-boolean finished flag', { finished: 't' }],
    ['a missing rolledBack flag', { rolledBack: undefined }],
  ])('C3 %s is never coerced: UNKNOWN', async (_label, patch) => {
    const rows = exactMigrationRows().map((row, i) => (i === 0 ? { ...row, ...patch } : row));
    const r = await read({ migrationRows: rows as Row[] });
    expect(r.state).toBe('UNKNOWN');
  });
  it('C4 every raw query is static (no interpolated values) and registered', async () => {
    const r = await read();
    expect(r.calls.filter((c) => c.kind === '$queryRaw').length).toBeGreaterThan(0);
    expect(r.violations.filter((v) => /raw SQL/.test(v))).toEqual([]);
  });
});

// --- D. operational counts --------------------------------------------------------------------------

describe('D operational counts', () => {
  for (const model of OPERATIONAL_MODELS) {
    it(`D1 a ${model} row is counted (→ OPERATIONAL_DATA)`, async () => {
      const r = await read({ counts: { [model]: 1 } });
      expect((r.facts as LocalTestBaselineFacts).operational[model]).toBe(1);
      expect(r.state).toBe('OPERATIONAL_DATA');
    });
  }
  it('D2 all eight models are counted exactly once each, never inferred from a parent', async () => {
    const r = await read();
    const counted = r.calls.filter((c) => c.kind === 'count').map((c) => c.target).sort();
    expect(counted).toEqual([...OPERATIONAL_MODELS].sort());
  });
});

// --- E. row mapping ------------------------------------------------------------------------------------

describe('E row mapping', () => {
  it('E1 every read uses an explicit select and no filter: whole tables, never canonical subsets', async () => {
    const r = await read();
    const reads = r.calls.filter((c) => c.kind === 'findMany');
    expect(new Set(reads.map((c) => c.target)).size).toBe(16);
    for (const c of reads) expect((c.args as Row).select, c.target).toBeDefined();
    expect(r.violations).toEqual([]);
  });
  it('E2 foreign rows survive mapping (extra Company, Branch, Location, scope, product, UserBranchRole)', async () => {
    const data = exactData();
    data.company!.push({ id: 'foreign-company', name: 'X', cuit: '30-9', address: 'x', isActive: true, createdAt: new Date(0) });
    data.branch!.push({ id: 'foreign-branch', code: 'ZZ', name: 'Z', address: 'z', pointOfSaleNumber: 99 });
    data.location!.push({ ...data.location![0]!, id: 'foreign-location', code: 'ZZ', companyId: 'foreign-company', pointOfSaleNumber: 98 });
    data.userRoleScope!.push({ id: 'scope-x', userId: K.seeded.users[0]!.id, roleId: K.seeded.roles[0]!.id, scopeKind: 'COMPANY', locationId: null });
    data.product!.push({ ...data.product![0]!, id: 'foreign-product', slug: 'foreign' });
    data.userBranchRole!.push({ id: 'ubr-1', userId: K.seeded.users[1]!.id, branchId: K.seeded.branches[0]!.id, roleId: K.seeded.roles[0]!.id });
    const r = await read({ data });
    const f = r.facts as LocalTestBaselineFacts;
    expect(f.companies.map((c) => c.id)).toContain('foreign-company');
    expect(f.seeded.branches.map((b) => b.id)).toContain('foreign-branch');
    expect(f.locations.find((l) => l.id === 'foreign-location')?.companyId).toBe('foreign-company');
    expect(f.userRoleScopes).toHaveLength(K.finalScopes.length + 1);
    expect(f.seeded.products.map((p) => p.id)).toContain('foreign-product');
    expect(f.seeded.userBranchRoles).toEqual([{ userId: K.seeded.users[1]!.id, branchId: K.seeded.branches[0]!.id, roleId: K.seeded.roles[0]!.id }]);
    expect(r.state).toBe('PARTIAL_UNSAFE');
  });
  it('E3 duplicates are never normalized away (two scope rows with the same content → UNKNOWN)', async () => {
    const data = exactData();
    data.userRoleScope!.push({ ...data.userRoleScope![0]!, id: 'scope-dup' });
    data.rolePermission!.push({ ...data.rolePermission![0]! });
    const r = await read({ data });
    const f = r.facts as LocalTestBaselineFacts;
    expect(f.userRoleScopes).toHaveLength(K.finalScopes.length + 1);
    expect(f.seeded.rolePermissions).toHaveLength(K.seeded.rolePermissions.length + 1);
    expect(r.state).toBe('UNKNOWN');
  });
  it('E4 bigints stay bigints (counters, inventory, prices)', async () => {
    const f = (await read()).facts as LocalTestBaselineFacts;
    expect(f.seeded.counters.every((c) => typeof c.nextValue === 'bigint')).toBe(true);
    expect(f.seeded.inventory.every((i) => typeof i.physical === 'bigint' && typeof i.reserved === 'bigint')).toBe(true);
    expect(f.seeded.variants.every((v) => typeof v.price === 'bigint' && typeof v.costPrice === 'bigint')).toBe(true);
  });
  it('E5 shuffled database rows classify the same', async () => {
    const data = exactData();
    for (const rows of Object.values(data)) rows.reverse();
    expect((await read({ data })).state).toBe('EXACT_BASELINE');
  });
  it('E6 an inactive Company and a foreign Location companyId are reported verbatim, not repaired', async () => {
    const data = exactData();
    data.company![0]!.isActive = false;
    data.location![0]!.companyId = 'someone-else';
    const f = (await read({ data })).facts as LocalTestBaselineFacts;
    expect(f.companies[0]!.isActive).toBe(false);
    expect(f.locations.find((l) => l.id === data.location![0]!.id)?.companyId).toBe('someone-else');
  });
  it('E7 generated ids and extra columns (scope/UserBranchRole ids, timestamps) are projected out', async () => {
    const f = (await read()).facts as LocalTestBaselineFacts;
    for (const scope of f.userRoleScopes) expect(Object.keys(scope).sort()).toEqual(['locationId', 'roleId', 'scopeKind', 'userId']);
    expect(Object.keys(f.companies[0]!).sort()).toEqual(['address', 'cuit', 'id', 'isActive', 'name']);
  });
});

// --- F. password state ------------------------------------------------------------------------------------

describe('F password state', () => {
  it('F1 the comparator sees every stored hash once, OWNER included; facts carry only the state', async () => {
    const c = comparator();
    const data = exactData();
    const r = await read({ data }, c.fn);
    expect([...c.seen].sort()).toEqual(data.user!.map((u) => u.passwordHash as string).sort());
    expect((r.facts as LocalTestBaselineFacts).seeded.users.every((u) => u.password === 'default')).toBe(true);
  });
  it('F2 a comparator that throws on one hash marks that user invalid instead of failing the read', async () => {
    const data = exactData();
    const owner = data.user!.find((u) => u.email === 'owner01@demo.local')!;
    owner.passwordHash = 'corrupt';
    const r = await read({ data }, async (h) => {
      if (h === 'corrupt') throw new Error('bad hash');
      return 'default';
    });
    const f = r.facts as LocalTestBaselineFacts;
    expect(f.seeded.users.find((u) => u.id === owner.id)?.password).toBe('invalid');
    expect(r.state).toBe('PARTIAL_UNSAFE');
  });
  it('F3 the seed-owned default: the seed password → default, another password → other, a non-bcrypt value → invalid', async () => {
    expect(await seedPasswordState(await hash(resolveSeedPassword(), 4))).toBe('default');
    expect(await seedPasswordState(await hash('not the seed password', 4))).toBe('other');
    expect(await seedPasswordState('not-a-bcrypt-hash')).toBe('invalid');
    expect(await seedPasswordState('')).toBe('invalid');
  });
  it('F4 no passwordHash (or any hash text) appears anywhere in the returned facts', async () => {
    const r = await read();
    const text = JSON.stringify(r.facts, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v));
    expect(text).not.toMatch(/passwordHash|hash-of-/);
  });
});

// --- G. snapshot and read-only ------------------------------------------------------------------------------

describe('G one read-only snapshot', () => {
  it('G1 every read (schema, history, counts, rows) happens on the transaction client', async () => {
    const r = await read();
    const reads = r.calls.filter((c) => c.kind !== '$transaction');
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.filter((c) => c.channel === 'outer')).toEqual([]);
  });
  it('G2 one interactive REPEATABLE READ transaction that first sets itself read-only', async () => {
    const r = await read();
    const tx = r.calls.filter((c) => c.kind === '$transaction');
    expect(tx).toHaveLength(1);
    expect((tx[0]!.args as Row).isolationLevel).toBe('RepeatableRead');
    const first = r.calls.find((c) => c.channel === 'tx');
    expect(first?.target).toMatch(/set_config\('transaction_read_only', 'on', true\)/);
    const txCalls = r.calls.filter((c) => c.channel === 'tx');
    expect(txCalls[1]).toEqual({ channel: 'tx', kind: '$queryRaw', target: SETTINGS_SQL });
    expect(r.calls.filter((c) => c.target === SETTINGS_SQL)).toHaveLength(1);
  });
  it('G3 no mutation, no $disconnect, on either client', async () => {
    const data = exactData();
    data.company!.push({ id: 'foreign', name: 'X', cuit: '1', address: 'x', isActive: false, createdAt: new Date(0) });
    const r = await read({ data });
    expect(r.violations).toEqual([]);
    expect(r.calls.every((c) => ['findMany', 'count', '$queryRaw', '$transaction'].includes(c.kind))).toBe(true);
  });
  it('G4 hostile environment variables change nothing', async () => {
    const before = (await read()).facts;
    const saved = { ...process.env };
    Object.assign(process.env, { DATABASE_URL: SENTINEL, TEST_DATABASE_URL: SENTINEL, LOCAL_TEST_DATABASE_URL: SENTINEL, DEMO_SEED_PASSWORD: 'x'.repeat(20) });
    try {
      expect((await read()).facts).toEqual(before);
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  });
});

// --- H. read failures ------------------------------------------------------------------------------------------

describe('H read failures', () => {
  it('H1 a failing read rejects with a fixed message that carries no target detail', async () => {
    const fake = fakeDatabase({ data: exactData(), migrationRows: exactMigrationRows(), failDelegate: 'location' });
    const error = await readLocalTestBaselineFacts(fake.db, { passwordState: comparator().fn }).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(error).not.toBeNull();
    expect(error!.message).toMatch(/^LOCAL_TEST baseline facts could not be read/);
    expect([error!.message, String(error!.stack), String((error as { cause?: unknown }).cause)].join('\n')).not.toContain('reader-secret');
    // The rejection comes from the injected Location failure, not from the fake.
    expect(fake.violations).toEqual([]);
    expect(fake.calls.at(-1)).toMatchObject({ channel: 'tx', kind: 'findMany', target: 'location' });
  });
  it('H2 a failing schema probe is a read failure, never FRESH', async () => {
    const fake = fakeDatabase({ failRaw: 'presence' });
    await expect(readLocalTestBaselineFacts(fake.db, { passwordState: comparator().fn })).rejects.toThrow();
    expect(fake.violations).toEqual([]);
    expect(fake.calls.at(-1)?.target).toMatch(/to_regclass/);
  });
});


// --- R4. the reader on a supplied transaction (no transaction of its own) ---------------------------------

describe('R4 readFactsOnTransaction', () => {
  type Tx = (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
  const onTx = (options: FakeOptions = {}, passwordState = comparator().fn) => {
    const fake = fakeDatabase({ data: exactData(), migrationRows: exactMigrationRows(), ...options });
    const result = (fake.db.$transaction as unknown as Tx)(async (tx) => readFactsOnTransaction(tx as never, { passwordState }));
    return { ...fake, result };
  };
  it('AC-099 (G22) it reads the same facts as the own-transaction reader, on the supplied transaction only: no $transaction, no set_config, no settings probe', async () => {
    const r = onTx();
    expect(await r.result).toEqual(expectedFacts());
    expect(r.calls.filter((c) => c.kind === '$transaction')).toHaveLength(1); // the test's own outer transaction, none from the reader
    expect(r.calls.filter((c) => c.channel === 'outer' && c.kind !== '$transaction')).toEqual([]);
    expect(r.calls.filter((c) => /set_config|current_setting/.test(String(c.target)))).toEqual([]);
    expect(r.violations).toEqual([]);
  });
  it('the same schema-presence outcomes as the own-transaction reader (fresh, partial, drift)', async () => {
    for (const present of [[], ['_prisma_migrations'], ['Branch', '_prisma_migrations'], [...APPLICATION_TABLES]]) {
      const own = await read({ present });
      const tx = onTx({ present });
      expect(await tx.result, JSON.stringify(present)).toEqual(own.facts);
      expect(tx.violations).toEqual([]);
    }
  });
  it('a read failure surfaces only the constant message, never the driver text', async () => {
    const r = onTx({ failDelegate: 'user' });
    const error = await (r.result as Promise<unknown>).then(() => null, (e: Error) => e);
    expect((error as Error).message).toBe('LOCAL_TEST baseline facts could not be read (details not shown)');
    expect(JSON.stringify([(error as Error).message, (error as Error).stack])).not.toContain(SENTINEL);
    expect((error as { cause?: unknown }).cause).toBeUndefined();
  });
  it('its source opens no transaction and issues no session SET', () => {
    const body = /export async function readFactsOnTransaction[\s\S]*?\n}\n/.exec(SOURCE)?.[0] ?? '';
    expect(body.length).toBeGreaterThan(80);
    expect(body).not.toMatch(/\$transaction|set_config|\$connect|\$disconnect|new\s+(Pool|PrismaClient)/);
  });
});
