// Zero-database unit tests for scripts/database/pilot-catalog-bootstrap.mjs.
// Run with: node --test scripts/database/pilot-catalog-bootstrap.test.mjs
// Hermetic: synthetic *.invalid URLs, an injected fake pg client for the marker
// proof, an in-memory fake Prisma (unique keys, FKs, rollback, and an additive
// guard that refuses update/upsert of any row not created in the same
// transaction), synthetic private files in a temp dir. The canonical api/src
// catalog-admin / initial-stock services and DTO schemas are loaded in-process
// (pure code, no connection) as the write path and test oracle. Nothing reads
// the real ~/.config/mona-jacinta files; nothing opens a socket.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CATALOG,
  CATALOG_LOCATIONS,
  classifyCatalogState,
  NestedTransactionFailure,
  main,
  nestedTransactionAdapter,
  parseCliArgs,
  planDigest,
  validateCatalog,
} from './pilot-catalog-bootstrap.mjs';
import { PILOT_ACCOUNTS } from './pilot-bootstrap.mjs';
import { parsePilotUrl } from './pilot-marker.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MARKER = '6d1e3f5a-2b4c-4d6e-8f0a-1b2c3d4e5f60';
const OTHER = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const REF = 'pilotsynthref0000001';
const SECRET = 'Catal0gSecretPw';
const HOST = 'aws-0-synthetic.pooler.invalid';
const URL_TEXT = `postgresql://postgres.${REF}:${SECRET}@${HOST}:6543/postgres`;
const HOSTILE_URL = 'postgresql://postgres.hostileref00000000x:hostilepw@dev-hostile.invalid:5432/postgres';
const LEAKS = [SECRET, HOST, REF, `postgres.${REF}`, URL_TEXT, `${HOST}:6543`, 'hostilepw', 'dev-hostile'];
function assertNoLeak(text) {
  for (const leak of LEAKS) assert.ok(!text.includes(leak), `output leaked ${JSON.stringify(leak.slice(0, 12))}…`);
}

const DRY = ['--target=pilot', '--dry-run', `--marker-id=${MARKER}`];
const EXECUTE = ['--target=pilot', '--execute', `--marker-id=${MARKER}`, `--confirm-project-ref=${REF}`];

// --- canonical oracle (real api/src modules, loaded in-process) ------------------

const tsx = await import(pathToFileURL(path.join(ROOT, 'api/node_modules/tsx/dist/esm/api/index.mjs')).href);
const ts = (rel) => tsx.tsImport(pathToFileURL(path.join(ROOT, rel)).href, import.meta.url);
const rbac = await ts('api/src/modules/rbac/catalog.service.ts');
const catalogAdmin = await ts('api/src/modules/products/catalog-admin.service.ts');
const initialStock = await ts('api/src/modules/inventory/initial-stock.service.ts');
const productDto = await ts('api/src/modules/products/dto/product.dto.ts');
const variantDto = await ts('api/src/modules/products/dto/variant.dto.ts');
const CANONICAL = {
  CANONICAL_ROLE_IDS: rbac.CANONICAL_ROLE_IDS,
  createCatalogAdminService: catalogAdmin.createCatalogAdminService,
  createInitialStockService: initialStock.createInitialStockService,
  createProductSchema: productDto.createProductSchema,
  createVariantSchema: variantDto.createVariantSchema,
  initialStockSchema: initialStock.initialStockSchema,
};
const OWNER = PILOT_ACCOUNTS.find((a) => a.role === 'OWNER');
const ADMIN = PILOT_ACCOUNTS.find((a) => a.role === 'ADMIN');
const ROLE_ID = rbac.CANONICAL_ROLE_IDS;

// --- in-memory fake Prisma --------------------------------------------------------

const TABLES = [
  'role', 'company', 'location', 'branch', 'user', 'userRoleScope',
  'category', 'brand', 'product', 'productVariant', 'inventory', 'stockMovement', 'stockReservation', 'saleItem', 'auditLog',
];
const BUSINESS = ['category', 'brand', 'product', 'productVariant', 'inventory', 'stockMovement', 'stockReservation', 'saleItem', 'auditLog'];
const UNIQUE = {
  role: [['id'], ['code']], company: [['id']], location: [['id'], ['code'], ['pointOfSaleNumber']], branch: [['id'], ['code']],
  user: [['id'], ['email']], userRoleScope: [['id']], category: [['id'], ['name']], brand: [['id'], ['name']],
  product: [['id'], ['slug']], productVariant: [['id'], ['sku'], ['barcode']], inventory: [['id'], ['variantId', 'branchId']],
  stockMovement: [['id']], stockReservation: [['id']], saleItem: [['id']], auditLog: [['id']],
};
const FK = {
  location: [['companyId', 'company']],
  userRoleScope: [['userId', 'user'], ['roleId', 'role'], ['locationId', 'location']],
  product: [['categoryId', 'category'], ['brandId', 'brand']],
  productVariant: [['productId', 'product']],
  inventory: [['variantId', 'productVariant'], ['branchId', 'branch']],
  stockMovement: [['inventoryId', 'inventory'], ['userId', 'user'], ['branchId', 'branch']],
  auditLog: [['userId', 'user'], ['branchId', 'branch']],
};
const DEFAULTS = {
  product: { description: null, isActive: true }, productVariant: { color: null, size: null, isActive: true },
  inventory: { physical: 0n, reserved: 0n }, location: { isActive: true }, user: { isActive: true },
};
const clone = (tables) => Object.fromEntries(Object.entries(tables).map(([k, rows]) => [k, rows.map((r) => structuredClone(r))]));
const MUTATIONS = new Set(['create', 'update', 'upsert']);

function fakeDb({ seed = baseSeed(), marker = { rows: [{ environment: 'pilot', marker_id: MARKER }], testGuard: false }, failOn } = {}) {
  let tables = Object.fromEntries(TABLES.map((t) => [t, (seed[t] ?? []).map((r) => structuredClone(r))]));
  const calls = [];
  const violations = [];
  const stats = { transactions: 0, commits: 0, rollbacks: 0 };
  let createdInTx = new Set();
  const counts = {};
  const matches = (row, where = {}) =>
    Object.entries(where).every(([k, v]) => {
      if (v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
        if ('in' in v) return v.in.includes(row[k]);
        throw new Error(`fake: unsupported where operator on ${k}`);
      }
      return row[k] === v;
    });
  const pick = (row, select) => (select ? Object.fromEntries(Object.keys(select).filter((k) => select[k] === true).map((k) => [k, row[k]])) : { ...row });
  const whereOf = (where) => (where?.variantId_branchId ? where.variantId_branchId : where);
  // failOn: { op, nth, error?: () => thrown value, sync?: true } — the injected
  // failure fires once; `sync` throws synchronously instead of rejecting.
  const updates = [];
  const injected = (op) => {
    counts[op] = (counts[op] ?? 0) + 1;
    if (failOn && failOn.op === op && counts[op] === (failOn.nth ?? 1)) {
      return failOn.error ? failOn.error() : Object.assign(new Error(`db exploded ${URL_TEXT}`), { code: 'P2010' });
    }
    return undefined;
  };
  const write = (op, fn) => {
    const err = injected(op);
    if (err !== undefined) {
      if (failOn.sync) throw err;
      return Promise.reject(err);
    }
    return Promise.resolve().then(fn);
  };
  const insert = (table, data) => {
    const row = { ...(DEFAULTS[table] ?? {}), id: randomUUID(), ...data };
    for (const keys of UNIQUE[table]) {
      if (tables[table].some((r) => keys.every((k) => r[k] === row[k]))) {
        throw Object.assign(new Error(`Unique constraint failed on ${keys.join(',')} ${URL_TEXT}`), { code: 'P2002' });
      }
    }
    for (const [col, ref] of FK[table] ?? []) {
      if (row[col] !== null && row[col] !== undefined && !tables[ref].some((r) => r.id === row[col])) {
        throw Object.assign(new Error(`Foreign key failed ${col}`), { code: 'P2003' });
      }
    }
    tables[table].push(row);
    createdInTx.add(`${table}:${row.id}`);
    return row;
  };
  const applyUpdate = (table, row, data) => {
    if (!createdInTx.has(`${table}:${row.id}`)) {
      violations.push(`${table}.update of a pre-existing row`);
      throw new Error('fake: non-additive mutation of a pre-existing row');
    }
    for (const [k, v] of Object.entries(data)) {
      if (v !== null && typeof v === 'object' && 'increment' in v) row[k] += v.increment;
      else row[k] = v;
    }
    updates.push(`${table}:${row.id}`);
    return row;
  };
  const delegate = (table) =>
    new Proxy(
      {
        findMany: async (args = {}) => tables[table].filter((r) => matches(r, args.where)).map((r) => pick(r, args.select)),
        findUnique: async (args) => {
          const row = tables[table].find((r) => matches(r, whereOf(args.where)));
          return row ? pick(row, args.select) : null;
        },
        create: ({ data, select }) => write(`${table}.create`, () => pick(insert(table, data), select)),
        update: ({ where, data, select }) => write(`${table}.update`, () => {
          const row = tables[table].find((r) => matches(r, whereOf(where)));
          if (!row) throw Object.assign(new Error('Record not found'), { code: 'P2025' });
          return pick(applyUpdate(table, row, data), select);
        }),
        upsert: ({ where, create, update, select }) => write(`${table}.upsert`, () => {
          const row = tables[table].find((r) => matches(r, whereOf(where)));
          if (row) return pick(applyUpdate(table, row, update), select);
          return pick(insert(table, create), select);
        }),
      },
      {
        get(target, prop) {
          if (typeof prop === 'string') calls.push(`${table}.${prop}`);
          if (!(prop in target)) {
            violations.push(`${table}.${String(prop)}`);
            return () => Promise.reject(new Error(`fake: ${table}.${String(prop)} is not permitted`));
          }
          return target[prop];
        },
      },
    );
  const client = {
    calls,
    updates,
    violations,
    stats,
    get tables() {
      return tables;
    },
    async $queryRaw(strings, ...values) {
      const text = Array.isArray(strings) ? strings.join('?') : String(strings);
      if (text.includes('pg_advisory_xact_lock')) {
        calls.push('$queryRaw:advisory-lock');
        return [{ pg_advisory_xact_lock: '' }];
      }
      if (text.includes('FROM "Inventory"') && text.includes('FOR UPDATE')) {
        calls.push('$queryRaw:inventory-lock');
        const [variantId, branchId] = values;
        return tables.inventory.filter((r) => r.variantId === variantId && r.branchId === branchId)
          .map((r) => ({ id: r.id, physical: r.physical, reserved: r.reserved }));
      }
      throw new Error('fake: unexpected $queryRaw');
    },
    async $queryRawUnsafe(text) {
      calls.push('$queryRawUnsafe:marker');
      if (text.includes('mona_pilot_guard.database_identity') && text.includes('mona_test_guard')) {
        return [{ test_guard_exists: marker.testGuard, rows: marker.rows }];
      }
      throw new Error('fake: unexpected $queryRawUnsafe');
    },
    async $transaction(fn) {
      stats.transactions += 1;
      const snapshot = clone(tables);
      createdInTx = new Set();
      const tx = {};
      for (const t of TABLES) tx[t] = delegate(t);
      tx.$queryRaw = client.$queryRaw;
      tx.$queryRawUnsafe = client.$queryRawUnsafe;
      try {
        const result = await fn(tx);
        stats.commits += 1;
        return result;
      } catch (err) {
        tables = snapshot;
        stats.rollbacks += 1;
        throw err;
      } finally {
        createdInTx = new Set();
      }
    },
    async $disconnect() {
      calls.push('$disconnect');
    },
  };
  for (const t of TABLES) client[t] = delegate(t);
  return client;
}

// The already-bootstrapped PILOT base state (pilot-bootstrap.mjs output shape):
// PCEN retail, PDEP warehouse, an extra retail PNOR, the OWNER and ADMIN with
// COMPANY scope. Empty business catalog.
const IDS = { company: randomUUID(), PCEN: randomUUID(), PDEP: randomUUID(), PNOR: randomUUID() };
function baseSeed(patch = {}) {
  const seed = {
    role: [
      { id: ROLE_ID.OWNER, code: 'OWNER', name: 'OWNER' },
      { id: ROLE_ID.ADMIN, code: 'ADMIN', name: 'ADMIN' },
    ],
    company: [{ id: IDS.company, name: 'Mona Jacinta PILOT', cuit: 'PILOT-NO-FISCAL', address: 'PILOT', isActive: true }],
    location: [
      { id: IDS.PCEN, companyId: IDS.company, code: 'PCEN', name: 'Centro PILOT', type: 'RETAIL_BRANCH', address: 'PILOT', pointOfSaleNumber: 11, isActive: true },
      { id: IDS.PDEP, companyId: IDS.company, code: 'PDEP', name: 'Depósito PILOT', type: 'CENTRAL_WAREHOUSE', address: 'PILOT', pointOfSaleNumber: 19, isActive: true },
      { id: IDS.PNOR, companyId: IDS.company, code: 'PNOR', name: 'Norte PILOT', type: 'RETAIL_BRANCH', address: 'PILOT', pointOfSaleNumber: 12, isActive: true },
    ],
    branch: [
      { id: IDS.PCEN, code: 'PCEN', name: 'Centro PILOT', address: 'PILOT', pointOfSaleNumber: 11 },
      { id: IDS.PDEP, code: 'PDEP', name: 'Depósito PILOT', address: 'PILOT', pointOfSaleNumber: 19 },
      { id: IDS.PNOR, code: 'PNOR', name: 'Norte PILOT', address: 'PILOT', pointOfSaleNumber: 12 },
    ],
    user: [
      { id: OWNER.id, email: OWNER.email, name: OWNER.name, isActive: true, passwordHash: '$2b$12$syntheticownerhashsyntheticownerhashsynthet' },
      { id: ADMIN.id, email: ADMIN.email, name: ADMIN.name, isActive: true, passwordHash: '$2b$12$syntheticadminhashsyntheticadminhashsynthet' },
    ],
    userRoleScope: [
      { id: randomUUID(), userId: OWNER.id, roleId: ROLE_ID.OWNER, scopeKind: 'COMPANY', locationId: null },
      { id: randomUUID(), userId: ADMIN.id, roleId: ROLE_ID.ADMIN, scopeKind: 'COMPANY', locationId: null },
    ],
  };
  for (const [table, fn] of Object.entries(patch)) seed[table] = fn(seed[table] ?? []);
  return seed;
}

// --- fake pg client speaking pilot-marker's --check protocol --------------------------

function markerFacts() {
  return {
    schemaOwnerIsCurrentUser: true,
    relations: [{ name: 'database_identity_pkey', kind: 'i' }, { name: 'database_identity', kind: 'r' }],
    table: { kind: 'r', persistence: 'p', isPartition: false, ofType: false, ownerIsCurrentUser: true, rowSecurity: false, forceRowSecurity: false, hasSubclass: false, parents: 0, children: 0, hasRules: false, triggers: 0 },
    columns: [
      { name: 'singleton', type: 'boolean', notNull: true, default: 'true', generated: '', identity: '', collation: null },
      { name: 'environment', type: 'text', notNull: true, default: null, generated: '', identity: '', collation: 'default' },
      { name: 'marker_id', type: 'uuid', notNull: true, default: null, generated: '', identity: '', collation: null },
      { name: 'installed_at', type: 'timestamp with time zone', notNull: true, default: 'now()', generated: '', identity: '', collation: null },
    ],
    constraints: [{ type: 'p', definition: 'PRIMARY KEY (singleton)' }, { type: 'c', definition: 'CHECK (singleton)' }, { type: 'c', definition: "CHECK ((environment = 'pilot'::text))" }],
  };
}
function fakePg({ testGuard = false, authorized = true, markerId = MARKER } = {}) {
  const sql = [];
  return {
    sql,
    connection: { stream: { encrypted: authorized, authorized } },
    async connect() {},
    async query(q) {
      const text = typeof q === 'string' ? q : q.text;
      sql.push(text);
      if (text.includes('to_regnamespace')) return { rows: [{ schema_exists: true, table_exists: true, test_guard_exists: testGuard }] };
      if (text.includes('json_build_object')) return { rows: [{ facts: markerFacts() }] };
      if (text.startsWith('SELECT environment')) return { rows: [{ environment: 'pilot', marker_id: markerId, has_installed_at: true }] };
      return { rows: [] };
    },
    async end() {},
  };
}

// --- private files and runner --------------------------------------------------------

const TMP = mkdtempSync(path.join(os.tmpdir(), 'pilot-catalog-test-'));
process.on('exit', () => rmSync(TMP, { recursive: true, force: true }));
let fileCount = 0;
function privateFile(content, mode = 0o600) {
  const file = path.join(TMP, `f-${fileCount++}`);
  writeFileSync(file, content);
  chmodSync(file, mode);
  return file;
}

async function approvedDigest(argv, opts = {}) {
  const marker = argv.find((a) => a.startsWith('--marker-id='));
  const out = [];
  await main(['--target=pilot', '--dry-run', marker], {
    urlFile: opts.urlFile ?? privateFile(`${URL_TEXT}\n`),
    env: {},
    createClient: () => {
      throw new Error('dry-run must not create a client');
    },
    createPrisma: async () => {
      throw new Error('dry-run must not create Prisma');
    },
    loadCanonical: async () => CANONICAL,
    log: (line) => out.push(line),
    error: (line) => out.push(line),
  });
  return /plan sha256: ([0-9a-f]{64})/.exec(out.join('\n'))?.[1] ?? null;
}

async function run(argv, opts = {}) {
  const out = [];
  const pg = opts.pg ?? fakePg();
  const db = opts.db ?? fakeDb();
  const counters = { pgClients: [], prisma: [], urlReads: 0 };
  const urlFile = opts.urlFile ?? privateFile(`${URL_TEXT}\n`);
  const deps = {
    urlFile,
    env: opts.env ?? {},
    createClient: (conn) => {
      counters.pgClients.push(conn);
      return pg;
    },
    createPrisma: opts.createPrisma ?? (async (conn) => {
      counters.prisma.push(conn);
      return db;
    }),
    loadCanonical: async () => opts.canonical ?? CANONICAL,
    log: (line) => out.push(line),
    error: (line) => out.push(line),
  };
  if (opts.readPrivateFile) deps.readPrivateFile = opts.readPrivateFile;
  Object.assign(deps, opts.deps ?? {});
  let args = argv;
  if (argv.includes('--execute') && argv.includes('--target=pilot') && !argv.some((a) => a.startsWith('--plan')) && opts.plan !== false) {
    args = [...argv, `--plan=${opts.plan ?? (await approvedDigest(argv, { urlFile })) ?? '0'.repeat(64)}`];
  }
  const code = await main(args, deps);
  const text = out.join('\n');
  assert.deepEqual(db.violations, [], `non-additive or unexpected Prisma call: ${db.violations.join(', ')}`);
  return { code, text, db, pg, counters };
}
const businessWrites = (db) => db.calls.filter((c) => BUSINESS.includes(c.split('.')[0]) && MUTATIONS.has(c.split('.')[1]));
const variantsOf = (catalog = CATALOG) => catalog.products.flatMap((p) => p.variants.map((v) => ({ ...v, product: p })));

async function bootstrapped() {
  const r = await run(EXECUTE);
  assert.equal(r.code, 0, r.text);
  return clone(r.db.tables);
}
async function assertRefused(seed, label, pattern = /phase=conflict/) {
  const db = fakeDb({ seed });
  const before = clone(db.tables);
  const r = await run(EXECUTE, { db });
  assert.equal(r.code, 1, `${label}: ${r.text}`);
  assert.match(r.text, pattern, label);
  assert.deepEqual(db.tables, before, `${label}: state changed`);
  assertNoLeak(r.text);
  return r;
}

// --- dataset -------------------------------------------------------------------------

test('A38: the canonical dataset is synthetic, PILOT-marked, deterministic and API-valid', () => {
  assert.deepEqual(CATALOG_LOCATIONS, { retail: 'PCEN', warehouse: 'PDEP' });
  assert.deepEqual([...CATALOG.categories], ['Remeras PILOT', 'Pantalones PILOT', 'Abrigos PILOT']);
  assert.deepEqual([...CATALOG.brands], ['Mona Basics PILOT', 'Jacinta Urban PILOT']);
  assert.deepEqual(CATALOG.products.map((p) => p.name), [
    'Remera Básica PILOT', 'Remera Oversize PILOT', 'Jean Recto PILOT', 'Pantalón Cargo PILOT', 'Buzo Clásico PILOT', 'Campera Liviana PILOT',
  ]);
  const variants = variantsOf();
  assert.ok(variants.length >= 12 && variants.length <= 18, `variant count ${variants.length}`);
  for (const p of CATALOG.products) {
    assert.match(p.slug, /-pilot$/);
    assert.ok(CATALOG.categories.includes(p.category) && CATALOG.brands.includes(p.brand));
    assert.equal(productDto.createProductSchema.safeParse({ name: p.name, slug: p.slug, categoryId: randomUUID(), brandId: randomUUID() }).success, true, p.slug);
  }
  for (const v of variants) {
    assert.match(v.sku, /^PILOT-/);
    assert.match(v.barcode, /PILOT/);
    const { stock, product, ...input } = v;
    assert.equal(variantDto.createVariantSchema.safeParse({ ...input, productId: randomUUID() }).success, true, v.sku);
    assert.ok(BigInt(v.price) > BigInt(v.costPrice), `${v.sku}: price above cost`);
    assert.deepEqual(Object.keys(stock).sort(), ['PCEN', 'PDEP']);
    for (const q of Object.values(stock)) assert.equal(initialStock.initialStockSchema.safeParse({ variantId: randomUUID(), branchId: randomUUID(), quantity: q }).success, true);
  }
  assert.equal(new Set(variants.map((v) => v.sku)).size, variants.length);
  assert.equal(new Set(variants.map((v) => v.barcode)).size, variants.length);
  assert.equal(Object.isFrozen(CATALOG) && Object.isFrozen(CATALOG.products[0].variants[0]), true, 'dataset is deeply frozen');
  assert.equal(validateCatalog(CATALOG, CANONICAL).ok, true);
});

test('A38: invalid datasets are refused by validateCatalog', () => {
  const base = structuredClone({ ...CATALOG, products: CATALOG.products.map((p) => ({ ...p, variants: p.variants.map((v) => ({ ...v, stock: { ...v.stock } })) })) });
  const mutate = (fn) => {
    const c = structuredClone(base);
    fn(c);
    return c;
  };
  const bad = {
    'duplicate SKU': mutate((c) => { c.products[1].variants[0].sku = c.products[0].variants[0].sku; }),
    'duplicate barcode': mutate((c) => { c.products[1].variants[0].barcode = c.products[0].variants[0].barcode; }),
    'duplicate slug': mutate((c) => { c.products[1].slug = c.products[0].slug; }),
    'SKU not PILOT': mutate((c) => { c.products[0].variants[0].sku = 'REM-BAS-S'; }),
    'barcode not PILOT': mutate((c) => { c.products[0].variants[0].barcode = '7790000000001'; }),
    'product name not PILOT': mutate((c) => { c.products[0].name = 'Remera Básica'; }),
    'category not PILOT': mutate((c) => { c.categories[0] = 'Remeras'; c.products.forEach((p) => { if (p.category === 'Remeras PILOT') p.category = 'Remeras'; }); }),
    'brand not PILOT': mutate((c) => { c.brands[0] = 'Mona Basics'; c.products.forEach((p) => { if (p.brand === 'Mona Basics PILOT') p.brand = 'Mona Basics'; }); }),
    'zero price': mutate((c) => { c.products[0].variants[0].price = '0'; }),
    'decimal price': mutate((c) => { c.products[0].variants[0].price = '1500.50'; }),
    'numeric price': mutate((c) => { c.products[0].variants[0].price = 1500000; }),
    'zero stock': mutate((c) => { c.products[0].variants[0].stock.PCEN = '0'; }),
    'missing PDEP stock': mutate((c) => { delete c.products[0].variants[0].stock.PDEP; }),
    'stock at unknown location': mutate((c) => { c.products[0].variants[0].stock.PNOR = '3'; }),
    'unknown category': mutate((c) => { c.products[0].category = 'Calzado'; }),
    'too few variants (11)': mutate((c) => { let n = variantsOf(c).length - 11; for (const p of c.products) while (n > 0 && p.variants.length > 1) { p.variants.pop(); n -= 1; } }),
    'too many variants (19)': mutate((c) => { const n = 19 - variantsOf(c).length; for (let i = 0; i < n; i += 1) c.products[0].variants.push({ ...c.products[0].variants[0], sku: `PILOT-X-${i}`, barcode: `PILOT-X-${i}`, size: `X${i}` }); }),
  };
  for (const [label, dataset] of Object.entries(bad)) {
    assert.equal(validateCatalog(dataset, CANONICAL).ok, false, label);
  }
});

// --- CLI -------------------------------------------------------------------------------

test('A7/A8: non-canonical CLI fails closed without echoing values', () => {
  assert.deepEqual(parseCliArgs(DRY), { ok: true, mode: 'dry-run', markerId: MARKER, confirmProjectRef: null, plan: null });
  const plan = 'b2'.repeat(32);
  assert.deepEqual(parseCliArgs([...EXECUTE, `--plan=${plan}`]), { ok: true, mode: 'execute', markerId: MARKER, confirmProjectRef: REF, plan });
  for (const argv of [
    [], ['--target=test', '--dry-run', `--marker-id=${MARKER}`], ['--target=PILOT', '--dry-run', `--marker-id=${MARKER}`],
    ['--target=pilot ', '--dry-run', `--marker-id=${MARKER}`], ['--target=pilot', '--target=pilot', '--dry-run', `--marker-id=${MARKER}`],
    ['--dry-run', `--marker-id=${MARKER}`], ['--target=demo', '--dry-run', `--marker-id=${MARKER}`],
    ['--target=pilot', '--dry-run', '--execute', `--marker-id=${MARKER}`], ['--target=pilot', `--marker-id=${MARKER}`],
    ['--target=pilot', '--dry-run', `--marker-id=${MARKER}`, 'seed'], ['--target=pilot', '--dry-run', `--marker-id=${MARKER}`, '--reset'],
    ['--target=pilot', '--dry-run', `--marker-id=${MARKER.toUpperCase()}`], ['--target=pilot', '--dry-run'],
    ['--target=pilot', '--execute', `--marker-id=${MARKER}`], ['--target=pilot', '--execute', `--marker-id=${MARKER}`, `--plan=${plan}`],
    [...EXECUTE], ['--target=pilot', '--dry-run', `--marker-id=${MARKER}`, `--confirm-project-ref=${REF}`],
    ['--target=pilot', '--dry-run', `--marker-id=${MARKER}`, `--url=${URL_TEXT}`],
  ]) {
    const parsed = parseCliArgs(argv);
    assert.equal(parsed.ok, false, argv.join(' '));
    assertNoLeak(parsed.error);
  }
});

test('A7: an invalid CLI reads no file and opens nothing', async () => {
  let reads = 0;
  const r = await run(['--target=test', '--execute', `--marker-id=${MARKER}`, `--confirm-project-ref=${REF}`], {
    plan: false,
    readPrivateFile: () => {
      reads += 1;
      return { ok: false, reason: 'x' };
    },
  });
  assert.equal(r.code, 1);
  assert.match(r.text, /phase=args/);
  assert.equal(reads, 0);
  assert.equal(r.counters.pgClients.length + r.counters.prisma.length, 0);
});

test('A13: missing, symlinked or group-readable URL file fails at phase=config before any client', async () => {
  const good = privateFile(`${URL_TEXT}\n`);
  const link = path.join(TMP, `link-${fileCount++}`);
  symlinkSync(good, link);
  for (const [label, urlFile] of Object.entries({
    missing: path.join(TMP, 'nope-url'),
    symlink: link,
    '0640': privateFile(`${URL_TEXT}\n`, 0o640),
    'query override': privateFile(`${URL_TEXT}?sslmode=disable\n`),
  })) {
    for (const argv of [DRY, EXECUTE]) {
      const r = await run(argv, { urlFile, plan: 'c3'.repeat(32) });
      assert.equal(r.code, 1, label);
      assert.match(r.text, /phase=config/, label);
      assert.equal(r.counters.pgClients.length + r.counters.prisma.length, 0, label);
      assertNoLeak(r.text);
    }
  }
});

// --- dry-run ---------------------------------------------------------------------------

test('A39: dry-run opens nothing and prints the sanitized catalog plan with a digest', async () => {
  const r = await run(DRY);
  assert.equal(r.code, 0, r.text);
  assert.equal(r.counters.pgClients.length + r.counters.prisma.length, 0);
  assert.equal(r.db.calls.length, 0);
  for (const needle of [
    /DRY RUN — no database connection was opened and nothing was written/, /target: PILOT/, /PCEN/, /PDEP/,
    new RegExp(OWNER.email.replace('.', '\\.')), /synthetic/i, /additive only/i, /plan sha256: [0-9a-f]{64}/,
    /--plan=[0-9a-f]{64}/, /explicit OWNER approval naming PILOT/,
  ]) assert.match(r.text, needle);
  for (const v of variantsOf()) assert.ok(r.text.includes(v.sku), v.sku);
  for (const p of CATALOG.products) assert.ok(r.text.includes(p.name), p.name);
  assertNoLeak(r.text);
});

test('A10: the plan digest binds marker id and project ref; a foreign digest fails before any client', async () => {
  const a = planDigest({ markerId: MARKER, projectRef: REF, catalog: CATALOG });
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(planDigest({ markerId: MARKER, projectRef: REF, catalog: CATALOG }), a);
  assert.notEqual(planDigest({ markerId: OTHER, projectRef: REF, catalog: CATALOG }), a);
  assert.notEqual(planDigest({ markerId: MARKER, projectRef: 'othersynthref0000002', catalog: CATALOG }), a);
  const r = await run(EXECUTE, { plan: planDigest({ markerId: OTHER, projectRef: REF, catalog: CATALOG }) });
  assert.equal(r.code, 1);
  assert.match(r.text, /phase=plan/);
  assert.equal(r.counters.pgClients.length + r.counters.prisma.length, 0);
});

// --- execute: target binding --------------------------------------------------------------

test('A9: wrong project confirmation fails before any client', async () => {
  const r = await run(EXECUTE.map((a) => (a.startsWith('--confirm') ? '--confirm-project-ref=othersynthref0000002' : a)));
  assert.equal(r.code, 1);
  assert.match(r.text, /phase=target/);
  assert.equal(r.counters.pgClients.length + r.counters.prisma.length, 0);
});

test('A11: hostile DB env never reaches the proof or the Prisma connection', async () => {
  const env = { DATABASE_URL: HOSTILE_URL, TEST_DATABASE_URL: HOSTILE_URL, DIRECT_URL: HOSTILE_URL, PGHOST: 'dev-hostile.invalid', PGUSER: 'hostile', PGPASSWORD: 'hostilepw', PGDATABASE: 'hostile' };
  const r = await run(EXECUTE, { env });
  assert.equal(r.code, 0, r.text);
  const expected = parsePilotUrl(URL_TEXT).conn;
  assert.deepEqual(r.counters.pgClients, [expected]);
  assert.deepEqual(r.counters.prisma, [expected]);
  assertNoLeak(r.text);
});

test('A12: PGOPTIONS is refused by this tool itself at phase=config, before the marker proof opens a client', async () => {
  const r = await run(EXECUTE, { env: { PGOPTIONS: '-c search_path=hostile' } });
  assert.equal(r.code, 1);
  assert.match(r.text, /\[db:pilot-catalog-bootstrap\] FAIL: phase=config — PGOPTIONS/);
  assert.doesNotMatch(r.text, /pilot-marker|phase=identity/, 'refused by this tool, not only by the marker proof');
  assert.equal(r.counters.pgClients.length + r.counters.prisma.length, 0);
});

test('A38: main refuses to run when the canonical DTOs reject the dataset (validation is wired in)', async () => {
  const rejecting = { ...CANONICAL, createVariantSchema: { safeParse: () => ({ success: false }) } };
  for (const argv of [DRY, EXECUTE]) {
    const r = await run(argv, { canonical: rejecting, plan: 'd4'.repeat(32) });
    assert.equal(r.code, 1);
    assert.match(r.text, /phase=config/);
    assert.match(r.text, /dataset rejected/);
    assert.equal(r.counters.pgClients.length + r.counters.prisma.length, 0);
  }
});

test('A12: DEBUG or PGOPTIONS fails before Prisma', async () => {
  for (const env of [{ DEBUG: 'prisma:*' }, { PGOPTIONS: '-c search_path=hostile' }]) {
    const r = await run(EXECUTE, { env });
    assert.equal(r.code, 1, JSON.stringify(env));
    assert.equal(r.counters.prisma.length, 0);
    assert.ok(!r.text.includes('hostile'));
  }
});

test('A3/A4: marker proof failures (wrong id, TEST marker, unverified TLS) stop before Prisma', async () => {
  for (const pg of [fakePg({ markerId: OTHER }), fakePg({ testGuard: true }), fakePg({ authorized: false })]) {
    const r = await run(EXECUTE, { pg });
    assert.equal(r.code, 1);
    assert.match(r.text, /phase=identity/);
    assert.equal(r.counters.prisma.length, 0);
    assert.ok(!r.text.includes(OTHER));
  }
});

test('A5/A6: the write transaction re-proves the marker and refuses a swapped/TEST/missing/duplicated marker', async () => {
  for (const marker of [
    { rows: [{ environment: 'pilot', marker_id: OTHER }], testGuard: false },
    { rows: [{ environment: 'pilot', marker_id: MARKER }], testGuard: true },
    { rows: [{ environment: 'pilot', marker_id: MARKER }], testGuard: null },
    { rows: [], testGuard: false },
    { rows: [{ environment: 'pilot', marker_id: MARKER }, { environment: 'pilot', marker_id: MARKER }], testGuard: false },
    { rows: JSON.stringify([{ environment: 'test', marker_id: MARKER }]), testGuard: false },
  ]) {
    const db = fakeDb({ marker });
    const before = clone(db.tables);
    const r = await run(EXECUTE, { db });
    assert.equal(r.code, 1, JSON.stringify(marker));
    assert.match(r.text, /phase=conflict/);
    assert.deepEqual(businessWrites(db), []);
    assert.deepEqual(db.tables, before);
    assert.ok(!r.text.includes(OTHER));
  }
});

test('A12: the marker re-check accepts a JSON-text row list (driver decoding)', async () => {
  const db = fakeDb({ marker: { rows: JSON.stringify([{ environment: 'pilot', marker_id: MARKER }]), testGuard: false } });
  const r = await run(EXECUTE, { db });
  assert.equal(r.code, 0, r.text);
  assert.ok(variantsOf().length >= 12, 'dataset present');
  assert.equal(db.tables.productVariant.length, variantsOf().length);
});

// --- execute: fresh catalog --------------------------------------------------------------

test('A1/A36/A37: a fresh PILOT gets exactly the canonical catalog with ledger + audit, in one transaction', async () => {
  const r = await run(EXECUTE);
  assert.equal(r.code, 0, r.text);
  const t = r.db.tables;
  assert.equal(r.db.stats.transactions, 1);
  assert.equal(r.db.stats.commits, 1);
  assert.equal(r.counters.pgClients.length, 1, 'one marker proof');
  assert.ok(r.db.calls.includes('$queryRaw:advisory-lock'));
  assert.ok(r.db.calls.includes('$queryRawUnsafe:marker'));
  assert.ok(r.db.calls.indexOf('$queryRawUnsafe:marker') < r.db.calls.findIndex((c) => c === 'category.create'), 'marker re-proved before the first write');
  assert.ok(r.db.calls.includes('$disconnect'));

  assert.deepEqual(t.category.map((c) => c.name).sort(), [...CATALOG.categories].sort());
  assert.deepEqual(t.brand.map((b) => b.name).sort(), [...CATALOG.brands].sort());
  assert.equal(t.product.length, CATALOG.products.length);
  const variants = variantsOf();
  assert.equal(t.productVariant.length, variants.length);
  for (const p of CATALOG.products) {
    const row = t.product.find((x) => x.slug === p.slug);
    assert.ok(row, p.slug);
    assert.equal(row.name, p.name);
    assert.equal(t.category.find((c) => c.id === row.categoryId).name, p.category);
    assert.equal(t.brand.find((b) => b.id === row.brandId).name, p.brand);
    assert.equal(row.isActive, true);
    const audits = t.auditLog.filter((a) => a.action === 'PRODUCT_CREATED' && a.entityId === row.id);
    assert.equal(audits.length, 1, `${p.slug}: one PRODUCT_CREATED audit`);
    assert.equal(audits[0].userId, OWNER.id);
    assert.equal(audits[0].branchId, null);
    assert.equal(audits[0].entityType, 'Product');
    assert.equal(audits[0].after.slug, p.slug);
  }
  const branchIds = { PCEN: IDS.PCEN, PDEP: IDS.PDEP };
  for (const v of variants) {
    const row = t.productVariant.find((x) => x.sku === v.sku);
    assert.ok(row, v.sku);
    assert.equal(row.barcode, v.barcode);
    assert.equal(row.color ?? undefined, v.color);
    assert.equal(row.size ?? undefined, v.size);
    assert.equal(row.price, BigInt(v.price));
    assert.equal(row.costPrice, BigInt(v.costPrice));
    assert.equal(t.product.find((p) => p.id === row.productId).slug, v.product.slug);
    const vAudit = t.auditLog.filter((a) => a.action === 'PRODUCT_VARIANT_CREATED' && a.entityId === row.id);
    assert.equal(vAudit.length, 1, `${v.sku}: one PRODUCT_VARIANT_CREATED audit`);
    assert.equal(vAudit[0].userId, OWNER.id);
    assert.equal(vAudit[0].branchId, null);
    assert.equal(vAudit[0].after.price, v.price, 'BigInt serialized like the API');
    for (const code of ['PCEN', 'PDEP']) {
      const qty = BigInt(v.stock[code]);
      const inv = t.inventory.filter((i) => i.variantId === row.id && i.branchId === branchIds[code]);
      assert.equal(inv.length, 1, `${v.sku}@${code}: one Inventory row`);
      assert.equal(inv[0].physical, qty);
      assert.equal(inv[0].reserved, 0n);
      const moves = t.stockMovement.filter((m) => m.inventoryId === inv[0].id);
      assert.equal(moves.length, 1, `${v.sku}@${code}: one movement`);
      assert.deepEqual(
        { type: moves[0].type, quantityDelta: moves[0].quantityDelta, saleId: moves[0].saleId, userId: moves[0].userId, branchId: moves[0].branchId },
        { type: 'INITIAL_STOCK', quantityDelta: qty, saleId: null, userId: OWNER.id, branchId: branchIds[code] },
      );
      const sAudit = t.auditLog.filter((a) => a.action === 'INVENTORY_INITIAL_STOCK_LOADED' && a.entityId === inv[0].id);
      assert.equal(sAudit.length, 1);
      assert.equal(sAudit[0].branchId, branchIds[code], 'stock audit records the real location');
      assert.equal(sAudit[0].userId, OWNER.id);
      assert.deepEqual(sAudit[0].before, { physical: '0', reserved: '0' });
      assert.deepEqual(sAudit[0].after, { physical: String(qty), reserved: '0', quantity: String(qty), variantId: row.id });
    }
  }
  assert.equal(t.inventory.length, variants.length * 2);
  assert.equal(t.stockMovement.length, variants.length * 2);
  assert.equal(t.inventory.filter((i) => i.branchId === IDS.PNOR).length, 0, 'no stock at other locations');
  assert.equal(t.auditLog.length, CATALOG.products.length + variants.length * 3);
  assert.equal(t.user.length, 2, 'no user created');
  assert.match(r.text, /OK — PILOT catalog bootstrap committed/);
  assertNoLeak(r.text);
  assert.ok(!r.text.includes('$2b$'), 'no hash printed');
});

test('A1: the result classifies as EXACT with the pure classifier', async () => {
  const tables = await bootstrapped();
  const result = classifyCatalogState(snapshotOf(tables), CATALOG, { ownerRoleId: ROLE_ID.OWNER });
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.state, 'EXACT');
});

// --- idempotency -----------------------------------------------------------------------------

test('A2: a second run on the exact result performs zero business writes', async () => {
  const seed = await bootstrapped();
  const db = fakeDb({ seed });
  const before = clone(db.tables);
  const r = await run(EXECUTE, { db });
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /already holds exactly the canonical PILOT catalog; nothing was written/);
  assert.deepEqual(businessWrites(db), []);
  assert.deepEqual(db.tables, before);
});

// --- conflicts (all: exit 1, nothing written) ------------------------------------------------

const withRows = (table, rows) => baseSeed({ [table]: (x) => [...x, ...rows] });
const foreignCatalog = () => {
  const cat = { id: randomUUID(), name: 'Calzado' };
  const brand = { id: randomUUID(), name: 'Marca Real' };
  const product = { id: randomUUID(), name: 'Zapatilla', slug: 'zapatilla', description: null, categoryId: cat.id, brandId: brand.id, isActive: true };
  return { cat, brand, product };
};

test('A14/A15: a partially present catalog (category or brand only) is refused', async () => {
  await assertRefused(withRows('category', [{ id: randomUUID(), name: 'Remeras PILOT' }]), 'category only');
  await assertRefused(withRows('brand', [{ id: randomUUID(), name: 'Mona Basics PILOT' }]), 'brand only');
});

test('A16/A17: a foreign product (canonical slug, or any unrelated product) is refused', async () => {
  const { cat, brand, product } = foreignCatalog();
  const base = (p) => baseSeed({ category: () => [cat], brand: () => [brand], product: () => [p] });
  await assertRefused(base({ ...product, slug: CATALOG.products[0].slug }), 'canonical slug');
  await assertRefused(base(product), 'unrelated real product');
});

test('A18/A19: a foreign variant holding a canonical SKU or barcode is refused', async () => {
  const { cat, brand, product } = foreignCatalog();
  const [v0] = variantsOf();
  const variant = { id: randomUUID(), productId: product.id, sku: 'REAL-1', barcode: 'REAL-1', color: null, size: null, price: 100n, costPrice: 50n, isActive: true };
  const seed = (v) => baseSeed({ category: () => [cat], brand: () => [brand], product: () => [product], productVariant: () => [v] });
  await assertRefused(seed({ ...variant, sku: v0.sku }), 'sku');
  await assertRefused(seed({ ...variant, barcode: v0.barcode }), 'barcode');
});

test('A20-A26: every deviation from the exact canonical result is refused and never repaired', async () => {
  const exact = await bootstrapped();
  const [v0] = variantsOf();
  const variantId = exact.productVariant.find((v) => v.sku === v0.sku).id;
  const inv = exact.inventory.find((i) => i.variantId === variantId && i.branchId === IDS.PCEN);
  const edit = (fn) => {
    const s = clone(exact);
    fn(s);
    return s;
  };
  const cases = {
    'A20 price drift': edit((s) => { s.productVariant.find((v) => v.id === variantId).price += 1n; }),
    'A20 barcode drift': edit((s) => { s.productVariant.find((v) => v.id === variantId).barcode = 'PILOT-BC-9999'; }),
    'A20 cost drift': edit((s) => { s.productVariant.find((v) => v.id === variantId).costPrice += 1n; }),
    'A20 size drift': edit((s) => { s.productVariant.find((v) => v.id === variantId).size = 'XL'; }),
    'A20 inactive variant': edit((s) => { s.productVariant.find((v) => v.id === variantId).isActive = false; }),
    'A20 inactive product': edit((s) => { s.product[0].isActive = false; }),
    'A20 product renamed': edit((s) => { s.product[0].name = 'Otro PILOT'; }),
    'A20 product moved to another brand': edit((s) => { const other = s.brand.find((b) => b.id !== s.product[0].brandId); s.product[0].brandId = other.id; }),
    'A21 extra PILOT-looking variant': edit((s) => { s.productVariant.push({ ...s.productVariant[0], id: randomUUID(), sku: 'PILOT-EXTRA', barcode: 'PILOT-EXTRA' }); }),
    'A21 extra PILOT-looking product': edit((s) => { s.product.push({ ...s.product[0], id: randomUUID(), slug: 'extra-pilot', name: 'Extra PILOT' }); }),
    'A21 extra category': edit((s) => { s.category.push({ id: randomUUID(), name: 'Accesorios' }); }),
    'A22 inventory row missing': edit((s) => { s.inventory = s.inventory.filter((i) => i.id !== inv.id); s.stockMovement = s.stockMovement.filter((m) => m.inventoryId !== inv.id); }),
    'A23 stock movement missing': edit((s) => { s.stockMovement = s.stockMovement.filter((m) => m.inventoryId !== inv.id); }),
    'A23 duplicated stock movement': edit((s) => { const m = s.stockMovement.find((x) => x.inventoryId === inv.id); s.stockMovement.push({ ...m, id: randomUUID() }); }),
    'A24 movement by another user': edit((s) => { s.stockMovement.find((m) => m.inventoryId === inv.id).userId = ADMIN.id; }),
    'A24 movement at another branch': edit((s) => { s.stockMovement.find((m) => m.inventoryId === inv.id).branchId = IDS.PNOR; }),
    'A24 movement of type SALE': edit((s) => { s.stockMovement.find((m) => m.inventoryId === inv.id).type = 'SALE'; }),
    'A25 product audit missing': edit((s) => { s.auditLog = s.auditLog.filter((a) => a.action !== 'PRODUCT_CREATED' || a.entityId !== s.product[0].id); }),
    'A25 variant audit missing': edit((s) => { s.auditLog = s.auditLog.filter((a) => a.action !== 'PRODUCT_VARIANT_CREATED' || a.entityId !== variantId); }),
    'A25 product audit by another user (same count)': edit((s) => { s.auditLog.find((a) => a.action === 'PRODUCT_CREATED').userId = ADMIN.id; }),
    'A25 product audit with a branch (same count)': edit((s) => { s.auditLog.find((a) => a.action === 'PRODUCT_CREATED').branchId = IDS.PCEN; }),
    'A25 variant audit by another user (same count)': edit((s) => { s.auditLog.find((a) => a.action === 'PRODUCT_VARIANT_CREATED' && a.entityId === variantId).userId = ADMIN.id; }),
    'A25 stock audit for the wrong quantity (same count)': edit((s) => { s.auditLog.find((a) => a.entityId === inv.id).after = { physical: '1', reserved: '0', quantity: '1', variantId }; }),
    'A25 stock audit missing': edit((s) => { s.auditLog = s.auditLog.filter((a) => a.entityId !== inv.id); }),
    'A25 stock audit by another user': edit((s) => { s.auditLog.find((a) => a.entityId === inv.id).userId = ADMIN.id; }),
    'A25 stock audit branch null': edit((s) => { s.auditLog.find((a) => a.entityId === inv.id).branchId = null; }),
    'A25 extra catalog audit': edit((s) => { s.auditLog.push({ ...s.auditLog[0], id: randomUUID() }); }),
    'A26 reserved stock': edit((s) => { s.inventory.find((i) => i.id === inv.id).reserved = 1n; }),
    'A26 physical changed by a sale': edit((s) => { s.inventory.find((i) => i.id === inv.id).physical -= 1n; }),
    'A26 stock reservation exists': edit((s) => { s.stockReservation.push({ id: randomUUID(), variantId, branchId: IDS.PCEN }); }),
    'A26 sale item exists': edit((s) => { s.saleItem.push({ id: randomUUID(), variantId }); }),
    'A36 inventory at another location': edit((s) => { s.inventory.push({ id: randomUUID(), variantId, branchId: IDS.PNOR, physical: 1n, reserved: 0n }); }),
  };
  for (const [label, seed] of Object.entries(cases)) await assertRefused(seed, label);
});

// --- context: locations and actor --------------------------------------------------------------

test('A27-A30: missing, swapped, inactive or split PCEN/PDEP locations are refused', async () => {
  const loc = (fn) => baseSeed({ location: (rows) => fn(rows.map((r) => ({ ...r }))) });
  const cases = {
    'PCEN missing': baseSeed({ location: (rows) => rows.filter((r) => r.code !== 'PCEN'), branch: (rows) => rows.filter((r) => r.code !== 'PCEN') }),
    'PDEP missing': baseSeed({ location: (rows) => rows.filter((r) => r.code !== 'PDEP'), branch: (rows) => rows.filter((r) => r.code !== 'PDEP') }),
    'types swapped': loc((rows) => rows.map((r) => (r.code === 'PCEN' ? { ...r, type: 'CENTRAL_WAREHOUSE' } : r.code === 'PDEP' ? { ...r, type: 'RETAIL_BRANCH' } : r))),
    'PCEN inactive': loc((rows) => rows.map((r) => (r.code === 'PCEN' ? { ...r, isActive: false } : r))),
    'PDEP inactive': loc((rows) => rows.map((r) => (r.code === 'PDEP' ? { ...r, isActive: false } : r))),
    'Location.id != Branch.id': baseSeed({ branch: (rows) => rows.map((r) => (r.code === 'PCEN' ? { ...r, id: randomUUID() } : r)) }),
    'Branch missing for PCEN': baseSeed({ branch: (rows) => rows.filter((r) => r.code !== 'PCEN') }),
    'Branch code differs': baseSeed({ branch: (rows) => rows.map((r) => (r.code === 'PCEN' ? { ...r, code: 'XCEN' } : r)) }),
  };
  for (const [label, seed] of Object.entries(cases)) await assertRefused(seed, label);
});

test('A31/A32: the OWNER actor must be exactly the canonical PILOT OWNER with one COMPANY OWNER scope', async () => {
  const ownerScope = (patch) => baseSeed({ userRoleScope: (rows) => rows.map((r) => (r.userId === OWNER.id ? { ...r, ...patch } : r)) });
  const cases = {
    'owner missing': baseSeed({ user: (rows) => rows.filter((u) => u.id !== OWNER.id), userRoleScope: (rows) => rows.filter((s) => s.userId !== OWNER.id) }),
    'owner inactive': baseSeed({ user: (rows) => rows.map((u) => (u.id === OWNER.id ? { ...u, isActive: false } : u)) }),
    'owner email on another id': baseSeed({ user: (rows) => rows.map((u) => (u.id === OWNER.id ? { ...u, id: randomUUID() } : u)), userRoleScope: (rows) => rows.filter((s) => s.userId !== OWNER.id) }),
    'owner id with another email': baseSeed({ user: (rows) => rows.map((u) => (u.id === OWNER.id ? { ...u, email: 'otro@pilot.local' } : u)) }),
    'owner LOCATION scope': ownerScope({ scopeKind: 'LOCATION', locationId: IDS.PCEN }),
    'owner ADMIN role': ownerScope({ roleId: ROLE_ID.ADMIN }),
    'owner no scope': baseSeed({ userRoleScope: (rows) => rows.filter((s) => s.userId !== OWNER.id) }),
    'owner extra scope': baseSeed({ userRoleScope: (rows) => [...rows, { id: randomUUID(), userId: OWNER.id, roleId: ROLE_ID.ADMIN, scopeKind: 'COMPANY', locationId: null }] }),
    'OWNER role row missing': baseSeed({ role: (rows) => rows.filter((r) => r.code !== 'OWNER') }),
    'OWNER role id holds another code': baseSeed({ role: (rows) => rows.map((r) => (r.id === ROLE_ID.OWNER ? { ...r, code: 'ADMIN_X' } : r)) }),
  };
  for (const [label, seed] of Object.entries(cases)) await assertRefused(seed, label);
});

test('A31: context is also enforced on an otherwise exact rerun (no NOOP under a broken actor)', async () => {
  const exact = await bootstrapped();
  const s = clone(exact);
  s.user.find((u) => u.id === OWNER.id).isActive = false;
  await assertRefused(s, 'exact catalog, inactive owner');
});

// --- atomicity and verification -----------------------------------------------------------------

test('A33: a failure midway rolls back the entire bootstrap and prints only a sanitized code', async () => {
  for (const failOn of [{ op: 'stockMovement.create', nth: 10 }, { op: 'productVariant.create', nth: 7 }, { op: 'auditLog.create', nth: 20 }, { op: 'inventory.update', nth: 3 }]) {
    const db = fakeDb({ failOn });
    const before = clone(db.tables);
    const r = await run(EXECUTE, { db });
    assert.equal(r.code, 1, JSON.stringify(failOn));
    assert.match(r.text, /phase=bootstrap/);
    assert.match(r.text, /rolled back/);
    assert.equal(db.stats.rollbacks, 1);
    assert.equal(db.stats.commits, 0);
    assert.deepEqual(db.tables, before, `${failOn.op}: partial state persisted`);
    assertNoLeak(r.text);
    assert.ok(!r.text.includes('exploded'));
  }
});

test('A34: post-write verification rolls back when the stock path skips its movement', async () => {
  const broken = {
    ...CANONICAL,
    createInitialStockService: (database) => ({
      async loadInitialStock(userId, input) {
        return database.$transaction(async (tx) => {
          await tx.inventory.create({ data: { variantId: input.variantId, branchId: input.branchId, physical: input.quantity, reserved: 0n } });
        });
      },
    }),
  };
  const db = fakeDb();
  const before = clone(db.tables);
  const r = await run(EXECUTE, { db, canonical: broken });
  assert.equal(r.code, 1, r.text);
  assert.match(r.text, /phase=verify/);
  assert.deepEqual(db.tables, before);
});

test('A40: a Prisma failure whose message holds the URL is reported as a code only', async () => {
  const r = await run(EXECUTE, {
    createPrisma: async () => {
      throw Object.assign(new Error(`cannot connect ${URL_TEXT}`), { code: 'ECONNREFUSED' });
    },
  });
  assert.equal(r.code, 1);
  assert.match(r.text, /code=ECONNREFUSED/);
  assertNoLeak(r.text);
});

test('A35: the fresh run mutates only rows it created in the same transaction (update/upsert guard)', async () => {
  const r = await run(EXECUTE);
  assert.equal(r.code, 0, r.text);
  const methods = new Set(r.db.calls.map((c) => c.split('.')[1]).filter(Boolean));
  for (const m of methods) assert.ok(['findMany', 'findUnique', 'create', 'update', 'upsert'].includes(m), `unexpected method ${m}`);
  // The canonical ledger path (upsert → FOR UPDATE → physical increment) really ran,
  // and the fake's guard proved each update/upsert touched only a row created in this transaction.
  const variants = variantsOf().length;
  assert.ok(variants >= 12, 'dataset present');
  assert.equal(r.db.calls.filter((c) => c === 'inventory.upsert').length, variants * 2);
  assert.equal(r.db.calls.filter((c) => c === 'inventory.update').length, variants * 2);
  assert.equal(r.db.calls.filter((c) => c === '$queryRaw:inventory-lock').length, variants * 2);
  assert.deepEqual(r.db.calls.filter((c) => /\.(update|upsert)$/.test(c) && !c.startsWith('inventory.')), []);
});

// Snapshot shape the classifier consumes (mirrors the transaction's reads).
function snapshotOf(t) {
  const catalogEntities = new Set(['Product', 'ProductVariant', 'Inventory']);
  return {
    categories: t.category, brands: t.brand, products: t.product, variants: t.productVariant, inventory: t.inventory,
    movements: t.stockMovement, reservations: t.stockReservation, saleItems: t.saleItem,
    audits: t.auditLog.filter((a) => catalogEntities.has(a.entityType)),
    locations: t.location, branches: t.branch,
    ownerByEmail: t.user.filter((u) => u.email === OWNER.email), ownerById: t.user.filter((u) => u.id === OWNER.id),
    ownerScopes: t.userRoleScope.filter((s) => s.userId === OWNER.id), ownerRole: t.role.filter((r) => r.id === ROLE_ID.OWNER),
  };
}

// --- F1: nested transactional services never retry on the outer transaction ------------------
//
// The REAL createInitialStockService / createCatalogAdminService run through the
// REAL bootstrap adapter (via main). A failure injected inside a nested callback
// must end that operation: one attempt, no second increment, no duplicate
// movement/audit, outer rollback, and nothing of the original error printed.

const F1_LEAKS = ['exploded', 'deadlock', 'serialize', 'TransactionWriteConflict', 'write conflict', 'cause', 'Unique'];
async function nestedFailure(failOn, opts = {}) {
  const db = fakeDb({ failOn });
  const before = clone(db.tables);
  const r = await run(EXECUTE, { db, ...opts });
  assert.equal(r.code, 1, `${failOn.op}: ${r.text}`);
  assert.match(r.text, /phase=bootstrap/, failOn.op);
  assert.match(r.text, /nested catalog operation failed/, failOn.op);
  assert.equal(db.stats.rollbacks, 1, 'outer transaction rolled back');
  assert.equal(db.stats.commits, 0);
  assert.deepEqual(db.tables, before, 'nothing persisted');
  const perRow = db.updates.reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map());
  for (const [row, n] of perRow) assert.equal(n, 1, `${row} incremented ${n} times (retried on the same transaction)`);
  assertNoLeak(r.text);
  for (const leak of F1_LEAKS) assert.ok(!r.text.includes(leak), `original error text leaked: ${leak}`);
  return { r, db, count: (call) => db.calls.filter((c) => c === call).length };
}
const retryable = {
  P2034: () => Object.assign(new Error(`write conflict ${URL_TEXT}`), { code: 'P2034' }),
  P2002: () => Object.assign(new Error(`Unique constraint ${URL_TEXT}`), { code: 'P2002' }),
  'meta 40P01': () => Object.assign(new Error(`deadlock detected ${URL_TEXT}`), { code: 'P2010', meta: { code: '40P01' } }),
  'message 40001': () => new Error(`could not serialize access 40001 ${URL_TEXT}`),
  TransactionWriteConflict: () => new Error(`TransactionWriteConflict ${URL_TEXT}`),
  arbitrary: () => new Error(`db exploded ${URL_TEXT}`),
};

test('F1: a retryable failure after inventory.update is never retried on the outer transaction (every classification)', async () => {
  for (const [label, error] of Object.entries(retryable)) {
    const { count } = await nestedFailure({ op: 'stockMovement.create', nth: 1, error });
    assert.equal(count('inventory.upsert'), 1, `${label}: one nested attempt`);
    assert.equal(count('inventory.update'), 1, `${label}: no second increment`);
    assert.equal(count('stockMovement.create'), 1, `${label}: no duplicated movement`);
    assert.equal(count('auditLog.create'), 2, `${label}: only the product + variant audits, no stock audit`);
  }
});

test('N1: P2034 on the initial-stock audit (after the movement exists) is not retried', async () => {
  const { count } = await nestedFailure({ op: 'auditLog.create', nth: 3, error: retryable.P2034 });
  assert.equal(count('inventory.update'), 1);
  assert.equal(count('stockMovement.create'), 1);
  assert.equal(count('auditLog.create'), 3);
});

test('N2: P2002 on inventory.upsert (before any increment) is not retried', async () => {
  const { count } = await nestedFailure({ op: 'inventory.upsert', nth: 1, error: retryable.P2002 });
  assert.equal(count('inventory.upsert'), 1);
  assert.equal(count('inventory.update'), 0);
});

test('N3/N5: a meta-nested 40P01 and a synchronous TransactionWriteConflict throw are not retried', async () => {
  for (const failOn of [
    { op: 'stockMovement.create', nth: 1, error: retryable['meta 40P01'] },
    { op: 'stockMovement.create', nth: 1, error: retryable.TransactionWriteConflict, sync: true },
    { op: 'inventory.update', nth: 1, error: retryable.P2034, sync: true },
  ]) {
    const { count } = await nestedFailure(failOn);
    assert.equal(count('inventory.upsert'), 1, JSON.stringify(failOn));
  }
});

test('N4: a non-Error rejection carrying 40001 and the URL is not retried and not printed', async () => {
  const { count } = await nestedFailure({ op: 'stockMovement.create', nth: 1, error: () => `40001 serialization ${URL_TEXT}` });
  assert.equal(count('inventory.upsert'), 1);
});

test('N6/N16: failures inside the catalog-admin callbacks (variant audit, product create) abort with one attempt', async () => {
  const a = await nestedFailure({ op: 'auditLog.create', nth: 2, error: retryable.P2034 });
  assert.equal(a.count('productVariant.create'), 1);
  const b = await nestedFailure({ op: 'product.create', nth: 1, error: retryable.P2002 });
  assert.equal(b.count('product.create'), 1);
  assert.equal(b.count('productVariant.create'), 0);
});

test('N7: a service that swallows the nested failure cannot continue or commit', async () => {
  const swallowing = {
    ...CANONICAL,
    createInitialStockService: (database) => {
      const real = initialStock.createInitialStockService(database);
      return { loadInitialStock: (u, i) => real.loadInitialStock(u, i).catch(() => null) };
    },
  };
  const { count } = await nestedFailure({ op: 'stockMovement.create', nth: 1 }, { canonical: swallowing });
  assert.equal(count('inventory.upsert'), 1, 'no nested callback runs after a failed one');
});

test('N8: a service that retries itself never gets a second callback on the same transaction', async () => {
  const selfRetrying = {
    ...CANONICAL,
    createInitialStockService: (database) => {
      const real = initialStock.createInitialStockService(database);
      return {
        async loadInitialStock(u, i) {
          try {
            return await real.loadInitialStock(u, i);
          } catch {
            return real.loadInitialStock(u, i);
          }
        },
      };
    },
  };
  const { count } = await nestedFailure({ op: 'stockMovement.create', nth: 1 }, { canonical: selfRetrying });
  assert.equal(count('inventory.upsert'), 1);
  assert.equal(count('inventory.update'), 1);
});

test('N9: an error whose cause holds the URL prints neither the cause nor the URL', async () => {
  await nestedFailure({ op: 'stockMovement.create', nth: 1, error: () => Object.assign(new Error('x'), { code: 'P2034', cause: new Error(URL_TEXT) }) });
});

// --- F2: the approved plan digest binds every plan fact ------------------------------------------

const PLAN_LOCATIONS = [['PCEN', 'RETAIL_BRANCH'], ['PDEP', 'CENTRAL_WAREHOUSE']];
const PLAN_OWNER = { id: OWNER.id, email: OWNER.email, role: 'OWNER', scope: 'COMPANY' };
const planBase = () => ({ markerId: MARKER, projectRef: REF, catalog: structuredClone(CATALOG), locations: structuredClone(PLAN_LOCATIONS), owner: { ...PLAN_OWNER } });
const withPlan = (fn) => {
  const p = planBase();
  fn(p);
  return p;
};
const renameCategory = (c, from, to) => {
  c.categories = c.categories.map((x) => (x === from ? to : x));
  c.products.forEach((p) => { if (p.category === from) p.category = to; });
};
const renameBrand = (c, from, to) => {
  c.brands = c.brands.map((x) => (x === from ? to : x));
  c.products.forEach((p) => { if (p.brand === from) p.brand = to; });
};
const V = (p) => p.catalog.products[0].variants[0];
const F2_CASES = {
  'category name': (p) => renameCategory(p.catalog, 'Remeras PILOT', 'Remeras Nuevas PILOT'),
  'brand name': (p) => renameBrand(p.catalog, 'Mona Basics PILOT', 'Mona Otra PILOT'),
  'product name': (p) => { p.catalog.products[0].name = 'Remera Distinta PILOT'; },
  'product slug': (p) => { p.catalog.products[0].slug = 'remera-distinta-pilot'; },
  'product → category mapping': (p) => { p.catalog.products[0].category = 'Abrigos PILOT'; },
  'product → brand mapping': (p) => { p.catalog.products[0].brand = 'Jacinta Urban PILOT'; },
  SKU: (p) => { V(p).sku = 'PILOT-REMBAS-BLA-XS'; },
  barcode: (p) => { V(p).barcode = 'PILOT-BC-0099'; },
  color: (p) => { V(p).color = 'Crudo'; },
  size: (p) => { V(p).size = 'XS'; },
  'sell price': (p) => { V(p).price = '1500001'; },
  'cost price': (p) => { V(p).costPrice = '700001'; },
  'stock quantity': (p) => { V(p).stock.PDEP = '31'; },
  'location code': (p) => {
    p.locations[0][0] = 'PCEX';
    p.catalog.products.forEach((pr) => pr.variants.forEach((v) => { v.stock = { PCEX: v.stock.PCEN, PDEP: v.stock.PDEP }; }));
  },
  'location types swapped': (p) => { p.locations = [['PCEN', 'CENTRAL_WAREHOUSE'], ['PDEP', 'RETAIL_BRANCH']]; },
  'OWNER id': (p) => { p.owner.id = '00000000-0000-4000-9700-000000000099'; },
  'OWNER email': (p) => { p.owner.email = 'propietario02@pilot.local'; },
  'OWNER scope fact': (p) => { p.owner.scope = 'LOCATION'; },
  'OWNER role fact': (p) => { p.owner.role = 'ADMIN'; },
  'marker id': (p) => { p.markerId = OTHER; },
  'project ref': (p) => { p.projectRef = 'othersynthref0000002'; },
};

test('F2: changing any single plan fact changes the digest', () => {
  const base = planDigest(planBase());
  assert.equal(base, planDigest({ markerId: MARKER, projectRef: REF, catalog: CATALOG }), 'defaults are the canonical locations/owner');
  const seen = new Set([base]);
  for (const [label, fn] of Object.entries(F2_CASES)) {
    const d = planDigest(withPlan(fn));
    assert.notEqual(d, base, label);
    assert.ok(!seen.has(d), `${label}: collides with another case`);
    seen.add(d);
  }
});

test('F2: the old approved digest is refused after any plan change, before any client or transaction', async () => {
  const old = planDigest(planBase());
  for (const [label, fn] of Object.entries(F2_CASES)) {
    const p = withPlan(fn);
    let argv = EXECUTE;
    let urlFile;
    if (p.markerId !== MARKER) argv = EXECUTE.map((a) => (a.startsWith('--marker-id=') ? `--marker-id=${p.markerId}` : a));
    if (p.projectRef !== REF) {
      urlFile = privateFile(`${URL_TEXT.replace(REF, p.projectRef)}\n`);
      argv = argv.map((a) => (a.startsWith('--confirm-project-ref=') ? `--confirm-project-ref=${p.projectRef}` : a));
    }
    const db = fakeDb();
    const r = await run(argv, { db, plan: old, urlFile, deps: { catalog: deepFreezeClone(p.catalog), locations: p.locations, owner: p.owner } });
    assert.equal(r.code, 1, `${label}: ${r.text}`);
    assert.match(r.text, /phase=(plan|config)/, label);
    assert.equal(r.counters.pgClients.length + r.counters.prisma.length, 0, `${label}: a client was opened`);
    assert.equal(db.stats.transactions, 0, label);
    assertNoLeak(r.text);
  }
  const baseline = await run(EXECUTE, { plan: old });
  assert.equal(baseline.code, 0, `the unchanged plan still executes with the old digest: ${baseline.text}`);
});
function deepFreezeClone(value) {
  const c = structuredClone(value);
  const freeze = (v) => {
    if (v && typeof v === 'object') {
      Object.freeze(v);
      Object.values(v).forEach(freeze);
    }
    return v;
  };
  return freeze(c);
}

// --- N10-N15: canonical serialization and dataset edge cases -------------------------------------

test('N10/N12/N13: array order is significant, key order is not, and numeric money is distinct and refused', () => {
  const base = planDigest(planBase());
  assert.notEqual(planDigest(withPlan((p) => p.catalog.categories.reverse())), base, 'N10 category order');
  assert.notEqual(planDigest(withPlan((p) => p.catalog.products.reverse())), base, 'N10 product order');
  const numeric = withPlan((p) => { V(p).price = 1500000; });
  assert.notEqual(planDigest(numeric), base, 'N12 numeric price digest');
  assert.equal(validateCatalog(numeric.catalog, CANONICAL).ok, false, 'N12 numeric price refused');
  const swapped = withPlan((p) => p.catalog.products.forEach((pr) => pr.variants.forEach((v) => { v.stock = { PDEP: v.stock.PDEP, PCEN: v.stock.PCEN }; })));
  assert.equal(planDigest(swapped), base, 'N13 stock key order does not change the digest');
  assert.equal(validateCatalog(swapped.catalog, CANONICAL).ok, true, 'N13 still valid');
});

test('N11/N15: undefined vs null color, and a padded name, are refused by validation', () => {
  const undef = withPlan((p) => { V(p).color = undefined; });
  const nul = withPlan((p) => { V(p).color = null; });
  assert.equal(validateCatalog(nul.catalog, CANONICAL).ok, false, 'null color refused');
  assert.equal(validateCatalog(undef.catalog, CANONICAL).ok, false, 'undefined color refused (it would serialize like null)');
  const padded = withPlan((p) => { p.catalog.products[0].name = 'Remera Básica PILOT '; });
  assert.equal(validateCatalog(padded.catalog, CANONICAL).ok, false, 'N15 padded name refused');
});

test('N14: an injected dataset with an extra product key is refused at phase=config before any client', async () => {
  const extra = withPlan((p) => { p.catalog.products[0].description = 'real merchandise'; });
  const r = await run(EXECUTE, { plan: planDigest(extra), deps: { catalog: deepFreezeClone(extra.catalog) } });
  assert.equal(r.code, 1, r.text);
  assert.match(r.text, /phase=config/);
  assert.equal(r.counters.pgClients.length + r.counters.prisma.length, 0);
});

// --- F1: adapter unit proof (real initial-stock retry loop, minimal transaction double) -------------

test('F1: the adapter runs a failed callback once, refuses later callbacks, and never exposes the original error', async () => {
  const tx = { marker: 'outer-tx' };
  const nested = nestedTransactionAdapter(tx);
  assert.equal(await nested.db.$transaction(async (t) => t.marker), 'outer-tx', 'success passes through on the SAME tx');
  assert.equal(nested.failed, false);
  let calls = 0;
  const secret = Object.assign(new Error(`serialize 40001 ${URL_TEXT}`), { code: 'P2034', meta: { code: '40P01' }, cause: new Error(URL_TEXT) });
  const err = await nested.db.$transaction(() => { calls += 1; throw secret; }).catch((e) => e);
  assert.ok(err instanceof NestedTransactionFailure);
  assert.equal(nested.failed, true);
  for (const k of ['code', 'meta', 'cause']) assert.equal(err[k], undefined, `${k} not carried`);
  assert.ok(!/40001|P2034|40P01|TransactionWriteConflict/.test(err.message));
  assertNoLeak(`${err.message} ${err.stack}`);
  const second = await nested.db.$transaction(() => { calls += 1; }).catch((e) => e);
  assert.ok(second instanceof NestedTransactionFailure, 'later callbacks are refused');
  assert.equal(calls, 1, 'no callback runs after a failed one');
  const fresh = nestedTransactionAdapter(tx);
  assert.ok((await fresh.db.$transaction('not a function').catch((e) => e)) instanceof NestedTransactionFailure);
});

test('F1: the REAL initial-stock retry loop makes exactly one attempt through the adapter', async () => {
  for (const [label, error] of Object.entries(retryable)) {
    let increments = 0;
    const tx = {
      productVariant: { findUnique: async () => ({ id: 'v' }) },
      branch: { findUnique: async () => ({ id: 'b' }) },
      location: { findUnique: async () => ({ isActive: true }) },
      inventory: {
        upsert: async () => ({}),
        update: async () => { increments += 1; return { id: 'i', variantId: 'v', branchId: 'b', physical: 5n * BigInt(increments), reserved: 0n }; },
      },
      $queryRaw: async () => [{ id: 'i', physical: 0n, reserved: 0n }],
      stockMovement: { create: async () => { throw error(); } },
      auditLog: { create: async () => { throw new Error('audit must not be reached'); } },
    };
    const nested = nestedTransactionAdapter(tx);
    const service = initialStock.createInitialStockService(nested.db);
    const err = await service.loadInitialStock(OWNER.id, { variantId: randomUUID(), branchId: randomUUID(), quantity: 5n }).catch((e) => e);
    assert.ok(err instanceof NestedTransactionFailure, `${label}: ${err?.constructor?.name}`);
    assert.equal(increments, 1, `${label}: physical incremented ${increments} times`);
  }
});

test('N7b: a swallowed failure on the LAST nested operation still cannot reach COMMIT', async () => {
  const swallowing = {
    ...CANONICAL,
    createInitialStockService: (database) => {
      const real = initialStock.createInitialStockService(database);
      return { loadInitialStock: (u, i) => real.loadInitialStock(u, i).catch(() => null) };
    },
  };
  const last = variantsOf().length * 2;
  const { count } = await nestedFailure({ op: 'stockMovement.create', nth: last, error: retryable.P2034 }, { canonical: swallowing });
  assert.equal(count('inventory.upsert'), last, 'the failure was on the final stock row');
});

test('F2: a non-OWNER or non-COMPANY actor is refused at phase=config even with its own matching digest', async () => {
  for (const owner of [{ ...PLAN_OWNER, scope: 'LOCATION' }, { ...PLAN_OWNER, role: 'ADMIN' }, { ...PLAN_OWNER, id: 'not-a-uuid' }]) {
    const plan = planDigest({ ...planBase(), owner });
    const r = await run(EXECUTE, { plan, deps: { owner } });
    assert.equal(r.code, 1, JSON.stringify(owner));
    assert.match(r.text, /phase=config — the plan actor must be a COMPANY-scoped OWNER/);
    assert.equal(r.counters.pgClients.length + r.counters.prisma.length, 0);
  }
});
