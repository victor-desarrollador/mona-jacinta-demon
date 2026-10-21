// Hermetic tests for pilot-local1-preflight.mjs. Fakes and temporary fixtures only: no real
// credentials, no ~/.config, no .env, no socket. Run under a no-network namespace.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as realFs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as T from './pilot-local1-preflight.mjs';
import * as A4 from './pilot-a4-readonly.mjs';
import * as BK from './pilot-backup.mjs';
import * as M from './pilot-tool-manifests.mjs';
import { verifyCodeManifest } from './pilot-launch-command.mjs';
import * as marker from './pilot-marker.mjs';
import * as states from './pilot-migration-states.mjs';
import * as projection from './app-schema-projection.mjs';
import * as rbac from './pilot-rbac-catalog.mjs';
import { CATALOG as SYNTHETIC_CATALOG } from './pilot-catalog-bootstrap.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL_ROOT = path.resolve(HERE, '..', '..');

let netAttempts = 0;
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function counted(...args) { netAttempts += 1; return originalConnect.apply(this, args); };

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const refDigest = (ref) => sha256(`mona-pilot-project-ref\n${ref}`);

// Synthetic identities (never the real project refs: the repository is public).
const REF = 'aaaabbbbccccddddeeee';
const FORBIDDEN = ['ffffgggghhhhiiiijjjj', 'kkkkllllmmmmnnnnoooo', 'ppppqqqqrrrrsssstttt'];
const PASSWORD = 'S3cretPw';
const POOLER = 'aws-0-sa-east-1.pooler.supabase.com';
const MID = '11111111-1111-4111-8111-111111111111';
const OTHER_MID = '22222222-2222-4222-8222-222222222222';
const HASH = '$2b$12$ThisIsAFakeBcryptHashThatMustNeverBePrinted0123456';
const urlFor = ({ user = `postgres.${REF}`, host = POOLER } = {}) => `postgresql://${user}:${PASSWORD}@${host}:5432/postgres`;
const SECRETS = [PASSWORD, POOLER, `postgres.${REF}`, REF, MID, OTHER_MID, HASH];

const PCEN = '2477257d-2567-4fd6-9df7-1e078676b7ad';
const NOW_MS = 1792411200000n;
const PDEP = '3c1d2e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const PACKAGES = [
  ['pg', '8.23.0'], ['pg-connection-string', '2.14.0'], ['pg-pool', '3.14.0'], ['pg-protocol', '1.16.0'],
  ['pg-types', '2.2.0'], ['pgpass', '1.0.5'], ['split2', '4.2.0'], ['pg-int8', '1.0.1'], ['postgres-array', '2.0.0'],
  ['postgres-bytea', '1.0.1'], ['postgres-date', '1.0.7'], ['postgres-interval', '1.2.0'], ['pg-cloudflare', '1.4.0'], ['xtend', '4.0.2'],
];
// The preflight runs against PILOT BEFORE the G12 cut-over, so its scenarios are the exact G11 ledger (never all current pins).
const MIGRATIONS = [...states.STATES.EXACT_G11];

// Synthetic app-schema catalogs (served by the fake's projection statements) and their references.
const rawCatalog = (tables) => ({
  tables: tables.map((t) => ({ table: t })),
  columns: tables.map((t) => ({ table: t, column: 'id', type: 'text', not_null: true, default_expr: null, identity: '', generated: '' })),
  enums: [], types: [], constraints: [], indexes: [], functions: [], triggers: [],
});
const RAW_G11 = rawCatalog(['Sale', 'CompanyPricingConfig', 'SaleCheckout']);
const RAW_G7 = rawCatalog(['Sale', 'CompanyPricingConfig']);
const SYN_REFERENCES = {
  SCHEMA_REFERENCES: { EXACT_G11: { digest: projection.projectionDigest(projection.buildProjection(RAW_G11)) },
    EXACT_G7: { digest: projection.projectionDigest(projection.buildProjection(RAW_G7)) } },
  STATE_PROBES: { EXACT_G11: [{ kind: 'table', name: 'SaleCheckout' }], EXACT_G7: [] },
};
const catalogRows = (def) => {
  const roleId = new Map(def.roles.map(([code, id]) => [code, id]));
  const permId = new Map(def.permissions.map(([code, id]) => [code, id]));
  return {
    roles: def.roles.map(([code, id]) => ({ id, code })),
    permissions: def.permissions.map(([code, id]) => ({ id, code })),
    grants: def.grants.map(([r, p]) => ({ roleId: roleId.get(r), permissionId: permId.get(p) })),
  };
};
const ROLE_ID = new Map(rbac.CATALOG_36.roles.map(([code, id]) => [code, id]));
const UID = (n) => `00000000-0000-4000-9700-00000000000${n}`;

// ---------- canonical healthy G11 fixture data ----------
function healthyData() {
  return {
    locations: [
      { id: PCEN, company_id: 'co-1', code: 'PCEN', type: 'RETAIL_BRANCH', active: true },
      { id: PDEP, company_id: 'co-1', code: 'PDEP', type: 'CENTRAL_WAREHOUSE', active: true },
    ],
    branches: [{ id: PCEN, code: 'PCEN' }, { id: PDEP, code: 'PDEP' }],
    users: [
      { id: UID(1), email: 'propietario01@pilot.local', active: true, passwordHash: HASH },
      { id: UID(2), email: 'administrador01@pilot.local', active: true, passwordHash: HASH },
      { id: UID(3), email: 'vendedor01@pilot.local', active: true, passwordHash: HASH },
      { id: UID(4), email: 'cajero01@pilot.local', active: true, passwordHash: HASH },
      { id: UID(5), email: 'deposito01@pilot.local', active: true, passwordHash: HASH },
    ],
    scopes: [
      { user_id: UID(1), role_id: ROLE_ID.get('OWNER'), scope_kind: 'COMPANY', location_id: null },
      { user_id: UID(2), role_id: ROLE_ID.get('ADMIN'), scope_kind: 'COMPANY', location_id: null },
      { user_id: UID(3), role_id: ROLE_ID.get('SELLER'), scope_kind: 'LOCATION', location_id: PCEN },
      { user_id: UID(4), role_id: ROLE_ID.get('CASHIER'), scope_kind: 'LOCATION', location_id: PCEN },
      { user_id: UID(5), role_id: ROLE_ID.get('WAREHOUSE'), scope_kind: 'LOCATION', location_id: PDEP },
    ],
    products: [{ id: 'p1', active: true }, { id: 'p2', active: true }, { id: 'p3', active: false }],
    variants: [
      { id: 'v1', product_id: 'p1', sku: 'PILOT-REMBAS-BLA-S', barcode: 'PILOT-BC-0001', active: true },
      { id: 'v2', product_id: 'p2', sku: 'SKU-SECRET-2', barcode: 'BAR-SECRET-2', active: true },
      { id: 'v3', product_id: 'p3', sku: 'SKU-SECRET-3', barcode: 'BAR-SECRET-3', active: false },
    ],
    inventory: [
      { id: 'i1', variant_id: 'v1', branch_id: PCEN, physical: '5', reserved: '1' },
      { id: 'i2', variant_id: 'v2', branch_id: PCEN, physical: '0', reserved: '0' },
      { id: 'i3', variant_id: 'v2', branch_id: PDEP, physical: '900', reserved: '7' },
    ],
    movements: [
      { type: 'INITIAL_STOCK', branch_id: PCEN, delta: '5' },
      { type: 'SALE', branch_id: PCEN, delta: '-1' },
      { type: 'INITIAL_STOCK', branch_id: PDEP, delta: '900' },
    ],
    reservations: [{ id: 'r1', sale_id: 's1', variant_id: 'v1', branch_id: PCEN, quantity: '1', status: 'ACTIVE', expires_ms: String(NOW_MS + 60000n), now_ms: String(NOW_MS) }],
    sales: [
      { id: 's1', branch_id: PCEN, status: 'PENDING_PAYMENT', total: '1500000', subtotal: '1500000', discount_total: '0', pricing_model: 'FIXED_TOTAL', price_mode: 'CASH', pricing_mode: 'LIST', wholesale_confirmed: false },
      { id: 's2', branch_id: PCEN, status: 'COMPLETED', total: '100', subtotal: '100', discount_total: '0', pricing_model: 'FIXED_TOTAL', price_mode: 'CASH', pricing_mode: 'LIST', wholesale_confirmed: false },
    ],
    items: [
      { sale_id: 's1', variant_id: 'v1', quantity: '1', unit_price: '1500000', subtotal: '1500000' },
      { sale_id: 's2', variant_id: 'v2', quantity: '1', unit_price: '100', subtotal: '100' },
    ],
    payments: [{ id: 'pay2', sale_id: 's2', method: 'CASH', amount: '100', has_session: true }],
    cashMovements: [{ sale_payment_id: 'pay2', type: 'SALE_INCOME', amount: '100' }],
    cashSessions: [{ register_id: 'reg1', status: 'CLOSED' }],
    cashRegisters: [{ id: 'reg1', branch_id: PCEN }],
    saleCheckouts: [],
    attempts: [],
    companies: [{ id: 'co-1' }],
    pricing: [{ company_id: 'co-1', list_bps: 2500, credit_bps: 2500, debit_bps: 625, transfer_bps: 1250, qr_bps: 0 }],
  };
}

// ---------- fixture builders ----------
const tmpRoots = [];
function mkTmp() { const d = realFs.mkdtempSync(path.join(os.tmpdir(), 'l1pf-')); tmpRoots.push(d); return d; }
function put(file, data, mode = 0o644) { realFs.mkdirSync(path.dirname(file), { recursive: true }); realFs.writeFileSync(file, data); realFs.chmodSync(file, mode); }

function buildRoot({ manifestMutator } = {}) {
  const root = mkTmp();
  for (const f of T.REQUIRED_REPO_FILES) put(path.join(root, f), f.startsWith('api/prisma/migrations/') ? realFs.readFileSync(path.join(REAL_ROOT, f)) : `fixture ${f}\n`);
  const packages = [];
  const lock = { lockfileVersion: 3, packages: { '': { name: 'fixture' } } };
  for (const [name, version] of PACKAGES) {
    const files = [`node_modules/${name}/package.json`, `node_modules/${name}/index.js`];
    if (name === 'pg') files.push('node_modules/pg/esm/index.mjs');
    for (const f of files) put(path.join(root, f), `fixture ${f}\n`);
    const integrity = `sha512-${Buffer.from(sha256(name) + sha256(version)).toString('base64').slice(0, 86)}==`;
    lock.packages[`node_modules/${name}`] = { version, integrity };
    packages.push({ name, version, integrity, files: files.sort().map((f) => ({ path: f, sha256: sha256(realFs.readFileSync(path.join(root, f))) })) });
  }
  put(path.join(root, 'package-lock.json'), JSON.stringify(lock));
  const manifest = {
    format: 'mona-pilot-tool-manifest/v1', tool: 'pilot-local1-preflight', node: 'v24.20.0', binaries: [],
    repoFiles: T.REQUIRED_REPO_FILES.map((f) => ({ path: f, sha256: sha256(realFs.readFileSync(path.join(root, f))) })),
    packages,
  };
  manifestMutator?.(manifest);
  put(path.join(root, 'scripts/database/pilot-local1-preflight.manifest.json'), JSON.stringify(manifest));
  return root;
}

function buildHome({ url = urlFor(), markerId = `${MID}\n` } = {}) {
  const home = mkTmp();
  const cfg = path.join(home, '.config');
  const dir = path.join(cfg, 'mona-jacinta');
  realFs.mkdirSync(dir, { recursive: true });
  realFs.chmodSync(cfg, 0o700); realFs.chmodSync(dir, 0o700);
  put(path.join(dir, 'pilot-database-url'), url, 0o600);
  put(path.join(dir, 'pilot-marker-id'), markerId, 0o600);
  return home;
}

function canonicalFacts() {
  return {
    schemaOwnerIsCurrentUser: true,
    table: { kind: 'r', persistence: 'p', isPartition: false, ofType: false, ownerIsCurrentUser: true, rowSecurity: false, forceRowSecurity: false, hasSubclass: false, parents: 0, children: 0, hasRules: false, triggers: 0 },
    columns: [
      { name: 'singleton', type: 'boolean', notNull: true, default: 'true', generated: '', identity: '', collation: null },
      { name: 'environment', type: 'text', notNull: true, default: null, generated: '', identity: '', collation: 'default' },
      { name: 'marker_id', type: 'uuid', notNull: true, default: null, generated: '', identity: '', collation: null },
      { name: 'installed_at', type: 'timestamp with time zone', notNull: true, default: 'now()', generated: '', identity: '', collation: null },
    ],
    constraints: [{ type: 'c', definition: "CHECK ((environment = 'pilot'::text))" }, { type: 'c', definition: 'CHECK (singleton)' }, { type: 'p', definition: 'PRIMARY KEY (singleton)' }],
    relations: [{ name: 'database_identity', kind: 'r' }, { name: 'database_identity_pkey', kind: 'i' }],
  };
}

// Statement classification by SQL shape (independent of the tool's constants).
const READS = { User: 'users', UserRoleScope: 'scopes', Location: 'locations', Branch: 'branches', Product: 'products', ProductVariant: 'variants', Inventory: 'inventory', StockMovement: 'movements',
  StockReservation: 'reservations', Sale: 'sales', SalePayment: 'payments', CheckoutAttempt: 'attempts', Company: 'companies', CompanyPricingConfig: 'pricing',
  SaleItem: 'items', CashMovement: 'cashMovements', CashSession: 'cashSessions', CashRegister: 'cashRegisters', SaleCheckout: 'saleCheckouts' };
function classify(sql) {
  const pkey = Object.keys(projection.PROJECTION_SQL).find((k) => projection.PROJECTION_SQL[k] === sql);
  if (pkey) return `projection:${pkey}`;
  const rkey = Object.keys(rbac.CATALOG_SQL).find((k) => rbac.CATALOG_SQL[k] === sql);
  if (rkey) return `rbac:${rkey}`;
  if (sql === states.LEDGER_SQL) return 'ledger';
  if (sql === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY') return 'begin';
  if (/^SET LOCAL /.test(sql)) return 'set';
  if (/transaction_read_only/.test(sql)) return 'ro';
  if (/to_regnamespace\('mona_test_guard'\)/.test(sql)) return 'guards';
  if (sql === 'LOCK TABLE mona_pilot_guard.database_identity IN ACCESS SHARE MODE') return 'lock';
  if (/AS facts/.test(sql)) return 'facts';
  if (/AS heap_am/.test(sql) && /database_identity/.test(sql)) return 'markerAccess';
  if (/FROM mona_pilot_guard\.database_identity/.test(sql)) return 'markerRows';
  if (/relrowsecurity/.test(sql) && /AS owned/.test(sql)) return 'relations';
  const c = /^SELECT count\(\*\)::text AS n FROM ONLY public\."?([A-Za-z_]+)"?$/.exec(sql);
  if (c) return `count:${c[1]}`;
  const r = /FROM ONLY public\."([A-Za-z]+)"$/.exec(sql);
  if (r && READS[r[1]]) return READS[r[1]];
  if (sql === 'ROLLBACK') return 'rollback';
  return 'UNKNOWN';
}
const VALUE_READS = new Set(Object.values(READS));

function fakeClient(root, o = {}) {
  const log = [];
  const state = { destroyed: false, ended: false };
  const data = o.data ?? healthyData();
  const migrationSha = (m) => sha256(realFs.readFileSync(path.join(root, `api/prisma/migrations/${m}/migration.sql`)));
  const ledgerRows = () => o.ledger ?? MIGRATIONS.map((m) => ({ migration_name: m, checksum: migrationSha(m), finished: true, rolled_back: false }));
  const tables = ['User', 'Role', 'Permission', 'RolePermission', 'UserRoleScope', 'Location', 'Branch', 'Product', 'ProductVariant', 'Inventory', 'StockMovement',
    'StockReservation', 'Sale', 'SalePayment', 'CheckoutAttempt', 'Company', 'CompanyPricingConfig',
    'SaleItem', 'CashMovement', 'CashSession', 'CashRegister', 'SaleCheckout', '_prisma_migrations'];
  const responses = {
    ro: () => [{ ro: o.ro ?? 'on' }],
    guards: () => [{ test_guard: !!o.testGuard, pilot_schema: true, pilot_table: true }],
    facts: () => [{ facts: canonicalFacts() }],
    markerAccess: () => [{ heap_am: true, indexes_builtin: true }],
    markerRows: () => [{ environment: 'pilot', marker_id: o.markerId ?? MID, has_installed_at: true }],
    relations: () => tables.map((name) => ({ name, kind: 'r', rls: o.rls?.[name] ?? false, force_rls: false, rules: false, owned: true,
      heap_am: true, indexes_builtin: true, has_subclass: false, is_partition: false })),
    ledger: () => ledgerRows(),
    ...Object.fromEntries([...VALUE_READS].map((k) => [k, () => data[k]])),
  };
  const countOf = READS;
  const client = {
    log, state,
    connection: { stream: { encrypted: true, authorized: true, destroy() { state.destroyed = true; } } },
    async connect() {},
    async end() { state.ended = true; },
    async query(sql) {
      const text = typeof sql === 'string' ? sql : sql?.text;
      log.push(text);
      const kind = classify(text);
      if (o.failOn === kind) throw Object.assign(new Error('boom S3cretPw'), { code: 'XX000' });
      if (kind.startsWith('count:')) {
        const t = kind.slice(6);
        const cat = o.rbacRows ?? catalogRows(rbac.CATALOG_36);
        const rows = { Role: cat.roles, Permission: cat.permissions, RolePermission: cat.grants, _prisma_migrations: ledgerRows() }[t] ?? data[countOf[t]];
        return { rows: [{ n: o.countValue?.[t] ?? String(rows.length) }] };
      }
      if (kind === 'projection:searchPath') return { rows: [{ search_path: 'pg_catalog, pg_temp' }] };
      if (kind.startsWith('projection:')) return { rows: (o.projectionRaw ?? RAW_G11)[kind.slice(11)] };
      if (kind.startsWith('rbac:')) return { rows: (o.rbacRows ?? catalogRows(rbac.CATALOG_36))[kind.slice(5)] };
      return { rows: responses[kind]?.(text) ?? [] };
    },
  };
  return client;
}

async function run({ root = buildRoot(), home = buildHome(), env, fake = {}, argv = ['--target=pilot', '--read-only-local1'], refDigests } = {}) {
  const out = [];
  let clients = 0;
  let client;
  const deps = {
    env: env ?? { HOME: home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    homedir: home, uid: process.getuid(), execArgv: [], version: 'v24.20.0', root, fs: realFs,
    resolvePg: () => path.join(root, 'node_modules/pg/esm/index.mjs'),
    importMarker: async () => marker,
    importShared: async () => ({ states, projection, rbac, references: SYN_REFERENCES }),
    createClient: () => { clients += 1; client = fakeClient(root, fake); return client; },
    refDigests: refDigests ?? { pilot: refDigest(REF), forbidden: FORBIDDEN.map(refDigest) },
    log: (l) => out.push(String(l)), error: (l) => out.push(String(l)), endTimeoutMs: 50,
  };
  const rc = await T.main(argv, deps);
  return { rc, out, text: out.join('\n'), clients, client, kinds: (client?.log ?? []).map(classify), log: client?.log ?? [] };
}
const leaks = (text) => SECRETS.filter((s) => text.includes(s));
const line = (r, key) => r.out.find((l) => l.startsWith(`${key}=`))?.slice(key.length + 1);

// ---------- L01 the healthy canonical report ----------
test('L01 a G11 PILOT with PCEN: VERIFIED, every requested key, ROLLBACK last, deterministic', async () => {
  const a = await run();
  assert.equal(a.rc, 0, a.text);
  const expected = {
    PILOT_STATE: 'EXACT_G11', RBAC_STATE: 'CATALOG_36', MARKER: 'VERIFIED', PCEN_MATCH: 'YES', PCEN_CODE: 'PCEN',
    ADMIN_EXISTS: 'YES', ADMIN_ACTIVE: 'YES', ADMIN_PCEN_ACCESS: 'YES',
    SELLER_EXISTS: 'YES', SELLER_ACTIVE: 'YES', SELLER_PCEN_ACCESS: 'YES',
    CASHIER_EXISTS: 'YES', CASHIER_ACTIVE: 'YES', CASHIER_PCEN_ACCESS: 'YES',
    PASSWORD_HASH_READ: 'NO',
    PRODUCT_COUNT: '3', ACTIVE_PRODUCT_COUNT: '2', VARIANT_COUNT: '3', ACTIVE_VARIANT_COUNT: '2',
    MISSING_SKU: '0', MISSING_BARCODE: '0', DUPLICATE_SKU: '0', DUPLICATE_BARCODE: '0',
    INVENTORY_ROWS: '2', TOTAL_PHYSICAL: '5', TOTAL_RESERVED: '1',
    PHYSICAL_LT_ZERO: '0', RESERVED_LT_ZERO: '0', RESERVED_GT_PHYSICAL: '0', INVENTORY_WITHOUT_VARIANT: '0',
    ACTIVE_VARIANTS_WITHOUT_INVENTORY: '0', INACTIVE_VARIANTS_WITH_STOCK: '0',
    INITIAL_STOCK_MOVEMENTS: '1', INITIAL_STOCK_UNITS: '5', SALE_MOVEMENTS: '1', OTHER_MOVEMENTS: '0',
    INITIAL_STOCK_DUPLICATION_RISK: 'YES',
    SYNTHETIC_ACTIVE_RESERVATIONS: '1', SYNTHETIC_RESERVED_UNITS: '1', SYNTHETIC_ACTIVE_RESERVATION_UNITS: '1', OTHER_ACTIVE_RESERVATIONS: '0',
    RESERVATION_EXPIRED: 'NO', RESERVATION_VARIANT: 'PILOT-REMBAS-BLA-S', RESERVATION_SALE_PRESENT: 'YES', RESERVATION_SALE_STATUS: 'PENDING_PAYMENT',
    ACCEPTED_PAYMENT_PRESENT: 'NO', CHECKOUT_ATTEMPT_PRESENT: 'NO', RESERVATION_CLASSIFICATION: 'PENDING_NO_PAYMENT',
    PRICING_CONFIG_EXISTS: 'YES', LIST_ADJUSTMENT_BPS: '2500', CREDIT_CARD_ADJUSTMENT_BPS: '2500', DEBIT_CARD_ADJUSTMENT_BPS: '625',
    BANK_TRANSFER_ADJUSTMENT_BPS: '1250', QR_ADJUSTMENT_BPS: '0', PRICING_CONFIG_MATCHES_LOCAL1: 'YES',
  };
  for (const [k, v] of Object.entries(expected)) assert.equal(line(a, k), v, `${k}\n${a.text}`);
  assert.equal(a.out.at(-1), 'LOCAL1_PREFLIGHT_RESULT=VERIFIED');
  assert.equal(a.kinds[0], 'begin');
  assert.equal(a.kinds.at(-1), 'rollback');
  assert.equal(a.kinds.filter((k) => k === 'rollback').length, 1);
  assert.deepEqual(leaks(a.text), []);
  const b = await run();
  assert.deepEqual(b.out, a.out);
});

// ---------- L02–L04 target / marker / G11 ----------
test('L02 wrong target: a forbidden or unpinned project ref is refused before any client exists', async () => {
  for (const digests of [{ pilot: refDigest(REF), forbidden: [refDigest(REF)] }, { pilot: refDigest('zzzzzzzzzzzzzzzzzzzz'), forbidden: [] }]) {
    const r = await run({ refDigests: digests });
    assert.equal(r.rc, 3, r.text);
    assert.equal(r.clients, 0);
    assert.equal(r.out.at(-1), 'LOCAL1_PREFLIGHT_RESULT=REFUSED');
    assert.deepEqual(leaks(r.text), []);
  }
  const host = await run({ home: buildHome({ url: urlFor({ host: 'db.example.com', user: 'postgres' }) }) });
  assert.equal(host.rc, 3); assert.equal(host.clients, 0);
});

test('L03 wrong marker: another marker id or a TEST guard is refused, rolled back, and nothing is read', async () => {
  for (const fake of [{ markerId: OTHER_MID }, { testGuard: true }]) {
    const r = await run({ fake });
    assert.equal(r.rc, 2, r.text);
    assert.equal(r.kinds.at(-1), 'rollback');
    assert.ok(!r.kinds.some((k) => VALUE_READS.has(k) || k === 'ledger' || k.startsWith('projection:')), r.kinds.join(','));
    assert.equal(r.out.at(-1), 'LOCAL1_PREFLIGHT_RESULT=REFUSED');
    assert.deepEqual(leaks(r.text), []);
  }
});

test('L04 not EXACT_G11: a G7 ledger, a schema mismatch or CATALOG_35 is refused before any business row is read', async () => {
  const g7 = MIGRATIONS.slice(0, 7);
  const cases = [
    { ledger: g7.map((m) => ({ migration_name: m, checksum: states.MIGRATION_PINS.find((p) => p.name === m).sha256, finished: true, rolled_back: false })), projectionRaw: RAW_G7 },
    { projectionRaw: RAW_G7 },
    { rbacRows: catalogRows(rbac.CATALOG_35) },
  ];
  for (const fake of cases) {
    const r = await run({ fake });
    assert.equal(r.rc, 2, r.text);
    assert.match(r.text, /EXACT_G11/);
    assert.ok(!r.kinds.some((k) => VALUE_READS.has(k)), r.kinds.join(','));
    assert.equal(r.kinds.at(-1), 'rollback');
    assert.equal(r.out.at(-1), 'LOCAL1_PREFLIGHT_RESULT=REFUSED');
  }
});

// ---------- L05 PCEN identity ----------
test('L05 wrong PCEN identity: missing, warehouse, inactive or branch-less PCEN is refused (rolled back)', async () => {
  const mutate = (fn) => { const d = healthyData(); fn(d); return d; };
  const cases = [
    mutate((d) => { d.locations = d.locations.filter((l) => l.id !== PCEN); }),
    mutate((d) => { d.locations[0].type = 'CENTRAL_WAREHOUSE'; }),
    mutate((d) => { d.locations[0].active = false; }),
    mutate((d) => { d.branches = d.branches.filter((b) => b.id !== PCEN); }),
  ];
  for (const data of cases) {
    const r = await run({ fake: { data } });
    assert.equal(r.rc, 2, r.text);
    assert.match(r.text, /PCEN/);
    assert.equal(r.kinds.at(-1), 'rollback');
    assert.ok(!r.kinds.includes('users') && !r.kinds.includes('inventory'), r.kinds.join(','));
    assert.equal(r.out.at(-1), 'LOCAL1_PREFLIGHT_RESULT=REFUSED');
  }
});

// ---------- L06–L09 transaction and statement contract ----------
test('L06 the transaction is REPEATABLE READ READ ONLY and a read-write transaction is refused', async () => {
  assert.equal(T.STATEMENTS.BEGIN, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const r = await run({ fake: { ro: 'off' } });
  assert.equal(r.rc, 2);
  assert.equal(r.kinds.at(-1), 'rollback');
  assert.ok(!r.kinds.includes('guards'));
});

test('L07 ROLLBACK always: on a read error it still rolls back; COMMIT never appears', async () => {
  const r = await run({ fake: { failOn: 'inventory' } });
  assert.equal(r.rc, 4, r.text);
  assert.equal(r.kinds.at(-1), 'rollback');
  assert.equal(r.out.at(-1), 'LOCAL1_PREFLIGHT_RESULT=ERROR');
  assert.deepEqual(leaks(r.text), []);
  for (const res of [r, await run()]) assert.ok(!res.log.some((s) => /\bCOMMIT\b/i.test(s)));
});

const WRITE = /\b(INSERT|UPDATE|DELETE|MERGE|UPSERT|COMMIT|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|COPY|CALL|DO|VACUUM|ANALYZE|REINDEX|CLUSTER|REFRESH|NOTIFY|PREPARE|EXECUTE|DISCARD|RESET)\b/i;
test('L08 no write statement exists, and every statement sent is a frozen tool or shared-module constant', async () => {
  assert.ok(Object.isFrozen(T.STATEMENTS));
  for (const [k, sql] of Object.entries(T.STATEMENTS)) assert.ok(!WRITE.test(sql), `${k}: ${sql}`);
  const allowed = new Set([...Object.values(T.STATEMENTS), states.LEDGER_SQL, ...Object.values(projection.PROJECTION_SQL), ...Object.values(rbac.CATALOG_SQL)]);
  const r = await run();
  for (const s of r.log) assert.ok(allowed.has(s), `not allowlisted: ${s}`);
  assert.ok(!r.kinds.includes('UNKNOWN'));
});

test('L09 no password or hash column is ever selected or printed', async () => {
  for (const sql of Object.values(T.STATEMENTS)) assert.ok(!/password|hash/i.test(sql), sql);
  const r = await run();
  assert.ok(!r.log.some((s) => /password|hash/i.test(s)));
  assert.ok(!r.text.includes(HASH));
});

// ---------- L10 frozen and in sync with the reviewed tools ----------
test('L10 identity statements and the pinned PILOT digests are byte-identical to the reviewed A4/backup ones', () => {
  for (const k of ['BEGIN', 'SET_SEARCH_PATH', 'SET_LOCK_TIMEOUT', 'SET_STATEMENT_TIMEOUT', 'SET_NO_INDEXSCAN', 'SET_NO_INDEXONLYSCAN',
    'SET_NO_BITMAPSCAN', 'SET_NO_JIT', 'READ_ONLY', 'GUARDS', 'LOCK_MARKER', 'MARKER_FACTS', 'MARKER_ACCESS', 'MARKER_ROWS', 'ROLLBACK']) {
    assert.equal(T.STATEMENTS[k], A4.STATEMENTS[k], k);
  }
  assert.deepEqual(T.REF_DIGESTS, BK.REF_DIGESTS);
  assert.deepEqual(T.MIGRATIONS, A4.MIGRATIONS);
  assert.equal(T.PCEN_LOCATION_ID, PCEN);
  assert.deepEqual(T.LOCAL1_ACCOUNTS.map((a) => [a.email, a.role, a.scopeKind]), [
    ['administrador01@pilot.local', 'ADMIN', 'COMPANY'], ['vendedor01@pilot.local', 'SELLER', 'LOCATION'], ['cajero01@pilot.local', 'CASHIER', 'LOCATION']]);
});

// ---------- L11 sanitized output ----------
test('L11 output is sanitized: no credential, marker id, project ref, hash, SKU or barcode text; control characters stripped', async () => {
  const data = healthyData();
  data.locations[1].code = 'PDEP\u001b[31m';
  const r = await run({ fake: { data } });
  assert.equal(r.rc, 0, r.text);
  assert.deepEqual(leaks(r.text), []);
  for (const v of data.variants.filter((x) => !x.sku.startsWith('PILOT-'))) { assert.ok(!r.text.includes(v.sku)); assert.ok(!r.text.includes(v.barcode)); }
  assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(r.text.replace(/\n/g, '')));
});

// ---------- L12 only PCEN inventory ----------
test('L12 only PCEN rows are counted: other-location inventory and movements never reach the PCEN totals', async () => {
  const data = healthyData();
  data.inventory.push({ id: 'i9', variant_id: 'v1', branch_id: PDEP, physical: '12345678901234567890', reserved: '1' });
  data.movements.push({ type: 'SALE', branch_id: PDEP, delta: '-3' });
  const r = await run({ fake: { data } });
  assert.equal(r.rc, 0, r.text);
  assert.equal(line(r, 'INVENTORY_ROWS'), '2');
  assert.equal(line(r, 'TOTAL_PHYSICAL'), '5');
  assert.equal(line(r, 'SALE_MOVEMENTS'), '1');
  assert.equal(line(r, 'OTHER_LOCATION_INVENTORY_ROWS'), '2');
});

// ---------- L13 scope mismatch ----------
test('L13 scope mismatch: SELLER on another location, an inactive CASHIER, a missing ADMIN and an invalid COMPANY row', async () => {
  const data = healthyData();
  data.scopes.find((s) => s.user_id === UID(3)).location_id = PDEP;
  data.users.find((u) => u.id === UID(4)).active = false;
  data.users = data.users.filter((u) => u.id !== UID(2));
  const r = await run({ fake: { data } });
  assert.equal(r.rc, 0, r.text);
  assert.equal(line(r, 'SELLER_EXISTS'), 'YES');
  assert.equal(line(r, 'SELLER_PCEN_ACCESS'), 'NO');
  assert.equal(line(r, 'CASHIER_ACTIVE'), 'NO');
  assert.equal(line(r, 'CASHIER_PCEN_ACCESS'), 'NO');
  assert.equal(line(r, 'ADMIN_EXISTS'), 'NO');
  assert.equal(line(r, 'ADMIN_PCEN_ACCESS'), 'NO');
  assert.match(r.text, /SCOPE_MISMATCH:SELLER/);
  assert.match(r.text, /USER_INACTIVE:CASHIER/);
  assert.match(r.text, /USER_MISSING:ADMIN/);
  // A COMPANY row for a non-company role (SECURITY-RBAC-01a) never grants access.
  const bad = healthyData();
  bad.scopes.find((s) => s.user_id === UID(3)).scope_kind = 'COMPANY';
  bad.scopes.find((s) => s.user_id === UID(3)).location_id = null;
  const b = await run({ fake: { data: bad } });
  assert.equal(line(b, 'SELLER_PCEN_ACCESS'), 'NO');
  assert.match(b.text, /INVALID_ASSIGNMENT:SELLER/);
});

// ---------- L14 inventory invariants and catalog anomalies ----------
test('L14 inventory invariants and catalog anomalies are counted exactly (BigInt, never float)', async () => {
  const data = healthyData();
  data.inventory = [
    { id: 'i1', variant_id: 'v1', branch_id: PCEN, physical: '-2', reserved: '0' },
    { id: 'i2', variant_id: 'v2', branch_id: PCEN, physical: '3', reserved: '4' },
    { id: 'i3', variant_id: 'v3', branch_id: PCEN, physical: '9007199254740993', reserved: '-1' },
    { id: 'i4', variant_id: 'ghost', branch_id: PCEN, physical: '1', reserved: '0' },
  ];
  data.variants.push({ id: 'v4', product_id: 'p1', sku: '', barcode: 'PILOT-BC-0001', active: true });
  data.variants.push({ id: 'v5', product_id: 'p2', sku: 'PILOT-REMBAS-BLA-S', barcode: '  ', active: true });
  const r = await run({ fake: { data } });
  assert.equal(r.rc, 0, r.text);
  assert.equal(line(r, 'INVENTORY_ROWS'), '4');
  assert.equal(line(r, 'TOTAL_PHYSICAL'), String(-2n + 3n + 9007199254740993n + 1n));
  assert.equal(line(r, 'TOTAL_RESERVED'), '3');
  assert.equal(line(r, 'PHYSICAL_LT_ZERO'), '1');
  assert.equal(line(r, 'RESERVED_LT_ZERO'), '1');
  assert.equal(line(r, 'RESERVED_GT_PHYSICAL'), '1');
  assert.equal(line(r, 'INVENTORY_WITHOUT_VARIANT'), '1');
  assert.equal(line(r, 'INACTIVE_VARIANTS_WITH_STOCK'), '1');
  assert.equal(line(r, 'ACTIVE_VARIANTS_WITHOUT_INVENTORY'), '2');
  assert.equal(line(r, 'MISSING_SKU'), '1');
  assert.equal(line(r, 'MISSING_BARCODE'), '1');
  assert.equal(line(r, 'DUPLICATE_SKU'), '1');
  assert.equal(line(r, 'DUPLICATE_BARCODE'), '1');
  assert.match(r.text, /INVENTORY_INVARIANT_ERRORS=4/);
});

// ---------- L15 duplication risk ----------
test('L15 INITIAL_STOCK duplication risk follows the evidence: NO only with no PCEN initial stock and no PCEN units', async () => {
  const empty = healthyData();
  empty.inventory = empty.inventory.filter((i) => i.branch_id !== PCEN);
  empty.movements = empty.movements.filter((m) => m.branch_id !== PCEN);
  const r = await run({ fake: { data: empty } });
  assert.equal(line(r, 'INITIAL_STOCK_MOVEMENTS'), '0');
  assert.equal(line(r, 'INITIAL_STOCK_DUPLICATION_RISK'), 'NO');
  const units = healthyData();
  units.movements = units.movements.filter((m) => !(m.branch_id === PCEN && m.type === 'INITIAL_STOCK'));
  const u = await run({ fake: { data: units } });
  assert.equal(line(u, 'INITIAL_STOCK_MOVEMENTS'), '0');
  assert.equal(line(u, 'INITIAL_STOCK_DUPLICATION_RISK'), 'YES');
});

// ---------- L16 bounded reads ----------
test('L16 a row count above the cap or not a count is refused before that table is read', async () => {
  for (const n of ['100001', 'NaN']) {
    const r = await run({ fake: { countValue: { Inventory: n } } });
    assert.equal(r.rc, 2, r.text);
    assert.ok(!r.kinds.includes('inventory'));
    assert.equal(r.kinds.at(-1), 'rollback');
  }
});

// ---------- L17–L19 launch guards ----------
test('L17 arguments, runtime and environment are checked before any manifest, private file or client', async () => {
  const bad = await run({ argv: ['--target=pilot'] });
  assert.equal(bad.rc, 1); assert.equal(bad.clients, 0);
  const home = buildHome();
  for (const extra of [{ NODE_OPTIONS: '--require=x' }, { DATABASE_URL: 'postgresql://dev' }, { PGSSLMODE: 'disable' }]) {
    const r = await run({ home, env: { HOME: home, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', ...extra } });
    assert.equal(r.rc, 3); assert.equal(r.clients, 0);
  }
});

test('L18 a tampered pinned file or manifest is refused before pilot-marker is loaded', async () => {
  const root = buildRoot();
  realFs.writeFileSync(path.join(root, 'scripts/database/pilot-marker.mjs'), 'tampered\n');
  const r = await run({ root });
  assert.equal(r.rc, 3); assert.equal(r.clients, 0);
  assert.match(r.text, /integrity/);
  const wrongTool = await run({ root: buildRoot({ manifestMutator: (m) => { m.tool = 'pilot-a4-readonly'; } }) });
  assert.equal(wrongTool.rc, 3);
});

test('L19 the OWNER command pins tool, manifest, launch module and Node bytes and runs exactly the read-only arguments', () => {
  const d = (c) => c.repeat(64);
  const cmd = T.buildOwnerCommand({ repoDir: '/home/o/repo dir', nodePath: '/opt/node/bin/node', toolSha256: d('a'), manifestSha256: d('b'), launchSha256: d('c'), nodeSha256: d('e') });
  assert.match(cmd, new RegExp(`${d('a')} scripts/database/pilot-local1-preflight\\.mjs`));
  assert.match(cmd, new RegExp(`${d('b')} scripts/database/pilot-local1-preflight\\.manifest\\.json`));
  assert.match(cmd, new RegExp(`${d('c')} scripts/database/pilot-launch-command\\.mjs`));
  assert.match(cmd, /--check --strict/);
  assert.match(cmd, /env" -i HOME="\$H" PATH=\/usr\/bin:\/bin LANG=C\.UTF-8 "\/opt\/node\/bin\/node" scripts\/database\/pilot-local1-preflight\.mjs --target=pilot --read-only-local1'$/m);
  assert.throws(() => T.buildOwnerCommand({ repoDir: 'relative', nodePath: '/n', toolSha256: d('a'), manifestSha256: d('b'), launchSha256: d('c'), nodeSha256: d('e') }));
  assert.throws(() => T.buildOwnerCommand({ repoDir: '/r', nodePath: '/n', toolSha256: 'x', manifestSha256: d('b'), launchSha256: d('c'), nodeSha256: d('e') }));
});

// ---------- L20 manifest registration ----------
test('L20 the manifest generator owns this tool and its built manifest verifies with verifyCodeManifest', () => {
  assert.deepEqual(M.TOOLS['pilot-local1-preflight'].repoFiles(), T.REQUIRED_REPO_FILES);
  assert.deepEqual(M.TOOLS['pilot-local1-preflight'].binaries, []);
  const m = M.buildManifest('pilot-local1-preflight', { root: REAL_ROOT });
  assert.equal(m.format, 'mona-pilot-tool-manifest/v1'); assert.equal(m.tool, 'pilot-local1-preflight');
  const committed = realFs.readFileSync(path.join(REAL_ROOT, 'scripts/database/pilot-local1-preflight.manifest.json'), 'utf8');
  assert.equal(committed, M.serialize(m), 'the manifest on disk is current');
  const r = verifyCodeManifest({ root: REAL_ROOT, manifestRel: 'scripts/database/pilot-local1-preflight.manifest.json', fs: realFs, tool: 'pilot-local1-preflight',
    requiredRepoFiles: T.REQUIRED_REPO_FILES, packageClosure: M.PACKAGE_CLOSURE, binaries: [], resolvePg: () => path.join(REAL_ROOT, 'node_modules', 'pg', 'esm', 'index.mjs') });
  assert.equal(r.ok, true, r.reason);
});

test('L99 no socket was opened by any test', () => {
  assert.equal(netAttempts, 0);
  for (const d of tmpRoots) realFs.rmSync(d, { recursive: true, force: true });
});

// ---------- L21–L25 the synthetic active reservation ----------
const withData = (fn) => { const d = healthyData(); fn(d); return d; };
const resv = async (fn) => run({ fake: { data: withData(fn) } });

test('L21 a pending sale without payment holding the synthetic unit → PENDING_NO_PAYMENT', async () => {
  const r = await resv(() => {});
  assert.equal(r.rc, 0, r.text);
  assert.equal(line(r, 'RESERVATION_CLASSIFICATION'), 'PENDING_NO_PAYMENT');
  assert.equal(line(r, 'RESERVATION_EXPIRED'), 'NO');
  assert.equal(r.kinds.at(-1), 'rollback');
});

test('L22 an expired reservation (DB clock, epoch milliseconds) → EXPIRED', async () => {
  const r = await resv((d) => { d.reservations[0].expires_ms = String(NOW_MS - 1n); });
  assert.equal(line(r, 'RESERVATION_EXPIRED'), 'YES');
  assert.equal(line(r, 'RESERVATION_CLASSIFICATION'), 'EXPIRED');
  const edge = await resv((d) => { d.reservations[0].expires_ms = String(NOW_MS); });
  assert.equal(line(edge, 'RESERVATION_EXPIRED'), 'YES', 'expiresAt <= now is expired, as release-expired does');
});

test('L23 any SalePayment on the sale → PAYMENT_ACCEPTED (the canonical cancel would refuse it)', async () => {
  const r = await resv((d) => { d.payments.push({ id: 'pay1', sale_id: 's1', method: 'DEBIT_CARD', amount: '1', has_session: false }); d.reservations[0].expires_ms = String(NOW_MS - 1n); });
  assert.equal(line(r, 'ACCEPTED_PAYMENT_PRESENT'), 'YES');
  assert.equal(line(r, 'RESERVATION_CLASSIFICATION'), 'PAYMENT_ACCEPTED');
});

test('L24 a RESERVED checkout attempt on the sale → CHECKOUT_ATTEMPT_ACTIVE; a closed attempt is only reported present', async () => {
  const r = await resv((d) => { d.attempts.push({ sale_id: 's1', status: 'RESERVED' }); });
  assert.equal(line(r, 'CHECKOUT_ATTEMPT_PRESENT'), 'YES');
  assert.equal(line(r, 'RESERVATION_CLASSIFICATION'), 'CHECKOUT_ATTEMPT_ACTIVE');
  const closed = await resv((d) => { d.attempts.push({ sale_id: 's1', status: 'ABANDONED' }); });
  assert.equal(line(closed, 'CHECKOUT_ATTEMPT_PRESENT'), 'YES');
  assert.equal(line(closed, 'RESERVATION_CLASSIFICATION'), 'PENDING_NO_PAYMENT');
});

test('L25 orphan and none: reserved units without a reservation, a reservation without its sale or on a closed sale; nothing reserved → NONE', async () => {
  const noRow = await resv((d) => { d.reservations = []; });
  assert.equal(line(noRow, 'SYNTHETIC_ACTIVE_RESERVATIONS'), '0');
  assert.equal(line(noRow, 'SYNTHETIC_RESERVED_UNITS'), '1');
  assert.equal(line(noRow, 'RESERVATION_CLASSIFICATION'), 'ORPHAN_RESERVED_STATE');
  const noSale = await resv((d) => { d.sales = d.sales.filter((x) => x.id !== 's1'); });
  assert.equal(line(noSale, 'RESERVATION_SALE_PRESENT'), 'NO');
  assert.equal(line(noSale, 'RESERVATION_CLASSIFICATION'), 'ORPHAN_RESERVED_STATE');
  const closedSale = await resv((d) => { d.sales[0].status = 'COMPLETED'; });
  assert.equal(line(closedSale, 'RESERVATION_SALE_STATUS'), 'COMPLETED');
  assert.equal(line(closedSale, 'RESERVATION_CLASSIFICATION'), 'ORPHAN_RESERVED_STATE');
  const none = await resv((d) => { d.reservations = []; d.inventory[0].reserved = '0'; });
  assert.equal(line(none, 'RESERVATION_CLASSIFICATION'), 'NONE');
  assert.equal(line(none, 'RESERVATION_EXPIRED'), 'NONE');
  const released = await resv((d) => { d.reservations[0].status = 'RELEASED'; d.inventory[0].reserved = '0'; });
  assert.equal(line(released, 'RESERVATION_CLASSIFICATION'), 'NONE');
  const other = await resv((d) => { d.reservations[0].variant_id = 'v2'; d.inventory[0].reserved = '0'; });
  assert.equal(line(other, 'OTHER_ACTIVE_RESERVATIONS'), '1');
  assert.equal(line(other, 'RESERVATION_CLASSIFICATION'), 'NONE');
});

// ---------- L26–L28 pricing config ----------
test('L26 no CompanyPricingConfig row → EXISTS=NO, every value NONE, not ready for Local 1', async () => {
  const r = await resv((d) => { d.pricing = []; });
  assert.equal(r.rc, 0, r.text);
  assert.equal(line(r, 'PRICING_CONFIG_EXISTS'), 'NO');
  for (const k of ['LIST', 'CREDIT_CARD', 'DEBIT_CARD', 'BANK_TRANSFER', 'QR']) assert.equal(line(r, `${k}_ADJUSTMENT_BPS`), 'NONE');
  assert.equal(line(r, 'PRICING_CONFIG_MATCHES_LOCAL1'), 'NO');
  assert.match(r.text, /PRICING_CONFIG_MISSING/);
});

test('L27 the exact Local 1 values match; QR is reported but not required', async () => {
  const r = await resv((d) => { d.pricing[0].qr_bps = 300; });
  assert.equal(line(r, 'QR_ADJUSTMENT_BPS'), '300');
  assert.equal(line(r, 'PRICING_CONFIG_MATCHES_LOCAL1'), 'YES');
});

test('L28 a mismatch, a config of another company or more than one company is never reported as ready', async () => {
  const r = await resv((d) => { d.pricing[0].debit_bps = 600; d.pricing[0].list_bps = 0; });
  assert.equal(line(r, 'PRICING_CONFIG_MATCHES_LOCAL1'), 'NO');
  assert.match(r.text, /PRICING_MISMATCH:DEBIT_CARD/);
  assert.match(r.text, /PRICING_MISMATCH:LIST/);
  const foreign = await resv((d) => { d.pricing[0].company_id = 'co-9'; });
  assert.equal(line(foreign, 'PRICING_CONFIG_EXISTS'), 'NO');
  const two = await resv((d) => { d.companies.push({ id: 'co-2' }); });
  assert.equal(line(two, 'PRICING_CONFIG_MATCHES_LOCAL1'), 'NO');
  assert.match(two.text, /PRICING_COMPANY_AMBIGUOUS/);
});

// ---------- L29 the synthetic identity is the reviewed bootstrap catalog ----------
test('L29 the synthetic variant identities are exactly pilot-catalog-bootstrap.mjs (SKU + barcode pairs)', () => {
  const expected = SYNTHETIC_CATALOG.products.flatMap((p) => p.variants.map((v) => [v.sku, v.barcode]));
  assert.equal(expected.length, 16);
  assert.deepEqual(T.SYNTHETIC_VARIANTS.map((v) => [v.sku, v.barcode]), expected);
  for (const k of ['RESERVATIONS', 'SALES', 'SALE_PAYMENTS', 'CHECKOUT_ATTEMPTS', 'COMPANIES', 'PRICING_CONFIG']) assert.ok(T.STATEMENTS[k], k);
  assert.ok(!/password|hash/i.test([T.STATEMENTS.SALES, T.STATEMENTS.SALE_PAYMENTS, T.STATEMENTS.CHECKOUT_ATTEMPTS].join('\n')));
});

// ---------- L30–L35 the paid-pending synthetic sale (one-sale evidence) ----------
const paidPending = (fn = () => {}) => resv((d) => {
  d.reservations[0].expires_ms = String(NOW_MS - 1n);
  d.payments.push({ id: 'pay1', sale_id: 's1', method: 'CASH', amount: '500000', has_session: true });
  d.cashMovements.push({ sale_payment_id: 'pay1', type: 'SALE_INCOME', amount: '500000' });
  fn(d);
});

test('L30 a partial CASH payment with its SALE_INCOME → PARTIALLY_PAID, exact BigInt evidence, nothing identifying printed', async () => {
  const r = await paidPending();
  assert.equal(r.rc, 0, r.text);
  const expected = {
    RESERVATION_CLASSIFICATION: 'PAYMENT_ACCEPTED', SALE_RECOVERY_CLASSIFICATION: 'PARTIALLY_PAID',
    SALE_PRICING_MODEL: 'FIXED_TOTAL', SALE_PRICE_MODE: 'CASH', SALE_PRICING_TIER: 'LIST', SALE_STATUS: 'PENDING_PAYMENT',
    SALE_TOTAL_CENTS: '1500000', SALE_ITEMS_TOTAL_CENTS: '1500000', SALE_ITEMS_CONSISTENT: 'YES',
    ACCEPTED_PAYMENT_TOTAL_CENTS: '500000', PAYMENT_COUNT: '1', PAYMENT_METHODS: 'CASH', REMAINING_CENTS: '1000000',
    PAYMENT_COVERS_TOTAL: 'NO', CASH_MOVEMENT_ALREADY_EXISTS: 'YES', RESERVATION_ACTIVE: 'YES', RESERVATION_UNITS: '1',
    HOLDS_MATCH_ITEMS: 'YES', SALE_CHECKOUT_PRESENT: 'NO', PCEN_OPEN_CASH_SESSIONS: '0', COMPLETION_METHODS_ALLOWED: 'CASH',
  };
  for (const [k, v] of Object.entries(expected)) assert.equal(line(r, k), v, `${k}\n${r.text}`);
  // The one-way binding the synthetic-retirement tool requires (--expect-sale): never the id itself.
  assert.equal(line(r, 'SALE_IDENTITY_DIGEST'), sha256('mona-pilot-synthetic-sale\ns1'));
  assert.equal(line(await resv(() => {}), 'SALE_IDENTITY_DIGEST'), 'NONE');
  for (const id of ['s1', 'pay1', 'r1', 'reg1']) assert.ok(!r.text.includes(`=${id}`) && !r.text.includes(` ${id} `), id);
  assert.equal(r.kinds.at(-1), 'rollback');
});

test('L31 a PAID sale whose payments cover the total and whose holds match its items → SAFE_TO_COMPLETE_CANONICALLY', async () => {
  const r = await paidPending((d) => {
    d.sales[0].status = 'PAID';
    d.payments.push({ id: 'pay3', sale_id: 's1', method: 'CASH', amount: '1000000', has_session: true });
    d.cashMovements.push({ sale_payment_id: 'pay3', type: 'SALE_INCOME', amount: '1000000' });
  });
  assert.equal(line(r, 'PAYMENT_COVERS_TOTAL'), 'YES');
  assert.equal(line(r, 'REMAINING_CENTS'), '0');
  assert.equal(line(r, 'SALE_RECOVERY_CLASSIFICATION'), 'SAFE_TO_COMPLETE_CANONICALLY');
});

test('L32 PENDING_PAYMENT already covered, or payments above the total, or items that do not add up → OVERPAID_OR_INCONSISTENT', async () => {
  const covered = await paidPending((d) => { d.payments[1].amount = '1500000'; d.cashMovements[1].amount = '1500000'; });
  assert.equal(line(covered, 'SALE_RECOVERY_CLASSIFICATION'), 'OVERPAID_OR_INCONSISTENT');
  const over = await paidPending((d) => { d.sales[0].status = 'PAID'; d.payments[1].amount = '1500001'; d.cashMovements[1].amount = '1500001'; });
  assert.equal(line(over, 'SALE_RECOVERY_CLASSIFICATION'), 'OVERPAID_OR_INCONSISTENT');
  const items = await paidPending((d) => { d.items[0].subtotal = '1400000'; });
  assert.equal(line(items, 'SALE_ITEMS_CONSISTENT'), 'NO');
  assert.equal(line(items, 'SALE_RECOVERY_CLASSIFICATION'), 'OVERPAID_OR_INCONSISTENT');
  const holds = await paidPending((d) => { d.items[0].quantity = '2'; d.items[0].subtotal = '3000000'; d.sales[0].subtotal = '3000000'; d.sales[0].total = '3000000'; });
  assert.equal(line(holds, 'HOLDS_MATCH_ITEMS'), 'NO');
  assert.equal(line(holds, 'SALE_RECOVERY_CLASSIFICATION'), 'OVERPAID_OR_INCONSISTENT');
});

test('L33 a CASH payment without its SALE_INCOME, or a non-cash payment with one → PAYMENT_WITHOUT_EXPECTED_SIDE_EFFECT', async () => {
  const missing = await paidPending((d) => { d.cashMovements.pop(); });
  assert.equal(line(missing, 'CASH_MOVEMENT_ALREADY_EXISTS'), 'NO');
  assert.equal(line(missing, 'SALE_RECOVERY_CLASSIFICATION'), 'PAYMENT_WITHOUT_EXPECTED_SIDE_EFFECT');
  const extra = await paidPending((d) => { d.payments[1].method = 'TRANSFER'; d.payments[1].has_session = false; d.sales[0].price_mode = 'LIST'; });
  assert.equal(line(extra, 'SALE_RECOVERY_CLASSIFICATION'), 'PAYMENT_WITHOUT_EXPECTED_SIDE_EFFECT');
  const noncash = await paidPending((d) => { d.payments[1].method = 'TRANSFER'; d.payments[1].has_session = false; d.cashMovements.pop(); d.sales[0].price_mode = 'LIST'; });
  assert.equal(line(noncash, 'CASH_MOVEMENT_ALREADY_EXISTS'), 'NOT_APPLICABLE');
  assert.equal(line(noncash, 'SALE_RECOVERY_CLASSIFICATION'), 'PARTIALLY_PAID');
  assert.equal(line(noncash, 'COMPLETION_METHODS_ALLOWED'), 'ANY');
});

test('L34 PROPORTIONAL_V1, an open PCEN session, no paid-pending sale, or several → reported without guessing', async () => {
  const prop = await paidPending((d) => { d.sales[0].pricing_model = 'PROPORTIONAL_V1'; d.saleCheckouts.push({ sale_id: 's1' }); });
  assert.equal(line(prop, 'SALE_CHECKOUT_PRESENT'), 'YES');
  assert.equal(line(prop, 'SALE_RECOVERY_CLASSIFICATION'), 'UNKNOWN');
  const open = await paidPending((d) => { d.cashSessions.push({ register_id: 'reg1', status: 'OPEN' }); });
  assert.equal(line(open, 'PCEN_OPEN_CASH_SESSIONS'), '1');
  const unpaid = await resv(() => {});
  assert.equal(line(unpaid, 'SALE_RECOVERY_CLASSIFICATION'), 'NOT_APPLICABLE');
  assert.equal(line(unpaid, 'SALE_TOTAL_CENTS'), 'NONE');
  const two = await paidPending((d) => {
    d.reservations.push({ ...d.reservations[0], id: 'r2', sale_id: 's2' });
    d.sales[1].status = 'PENDING_PAYMENT';
    d.inventory[0].reserved = '2';
  });
  assert.equal(line(two, 'SALE_RECOVERY_CLASSIFICATION'), 'UNKNOWN');
  assert.match(two.text, /PAID_PENDING_SALES=2/);
});

test('L35 every new money value is exact text BigInt (no float), and every new statement is a frozen read', async () => {
  const r = await paidPending((d) => {
    d.sales[0].total = '9007199254740993'; d.sales[0].subtotal = '9007199254740993';
    d.items[0].unit_price = '9007199254740993'; d.items[0].subtotal = '9007199254740993';
  });
  assert.equal(line(r, 'SALE_TOTAL_CENTS'), '9007199254740993');
  assert.equal(line(r, 'REMAINING_CENTS'), String(9007199254740993n - 500000n));
  for (const k of ['SALE_ITEMS', 'CASH_MOVEMENTS', 'CASH_SESSIONS', 'CASH_REGISTERS', 'SALE_CHECKOUTS']) assert.ok(T.STATEMENTS[k], k);
});

// ---------- M01–M07 every open (DRAFT / PENDING_PAYMENT / PAID) sale holding an exact synthetic item ----------
const openSale = (r, n, k) => line(r, `OPEN_SALE_${n}_${k}`);

test('M01 a pending synthetic sale without payment: counted, classified, cancel canonical; catalog activity reported', async () => {
  const r = await resv(() => {});
  assert.equal(r.rc, 0, r.text);
  assert.equal(line(r, 'OPEN_SYNTHETIC_SALES'), '1');
  const expected = {
    SALE_IDENTITY_DIGEST: sha256('mona-pilot-synthetic-sale\ns1'), STATUS: 'PENDING_PAYMENT', PRICING_MODEL: 'FIXED_TOTAL', PRICE_MODE: 'CASH',
    ITEM_COUNT: '1', SYNTHETIC_ITEM_COUNT: '1', TOTAL_CENTS: '1500000', PAYMENT_COUNT: '0', ACCEPTED_PAYMENT_TOTAL_CENTS: '0', REMAINING_CENTS: '1500000',
    ACTIVE_RESERVATION_UNITS: '1', RESERVATION_STATUS: 'ACTIVE', CHECKOUT_PRESENT: 'NO', CHECKOUT_ATTEMPT_STATUS: 'NONE', CASH_MOVEMENT_COUNT: '0',
    OPEN_CASH_SESSION_RELATED: 'NO', CLASSIFICATION: 'PENDING_NO_PAYMENT', CANONICAL_ACTION: 'CANCEL_CANONICAL',
  };
  for (const [k, v] of Object.entries(expected)) assert.equal(openSale(r, 1, k), v, `${k}\n${r.text}`);
  assert.equal(line(r, 'SYNTHETIC_VARIANTS_FOUND'), '1');
  assert.equal(line(r, 'SYNTHETIC_PRODUCTS_FOUND'), '1');
  assert.equal(line(r, 'SYNTHETIC_ACTIVE_VARIANTS'), '1');
  assert.equal(line(r, 'SYNTHETIC_ACTIVE_PRODUCTS'), '1');
  for (const id of ['s1', 'pay1', 'r1', 'reg1']) assert.ok(!r.text.includes(`=${id}`), id);
  assert.equal(r.kinds.at(-1), 'rollback');
});

test('M02 a partially paid synthetic sale → PARTIALLY_PAID, exceptional retirement path, exact BigInt money', async () => {
  const r = await paidPending((d) => { d.cashSessions.push({ id: 'cs1', register_id: 'reg1', status: 'OPEN' }); d.payments[1].session_id = 'cs1'; });
  assert.equal(openSale(r, 1, 'CLASSIFICATION'), 'PARTIALLY_PAID');
  assert.equal(openSale(r, 1, 'CANONICAL_ACTION'), 'SYNTHETIC_RETIREMENT_EXCEPTION');
  assert.equal(openSale(r, 1, 'PAYMENT_COUNT'), '1');
  assert.equal(openSale(r, 1, 'ACCEPTED_PAYMENT_TOTAL_CENTS'), '500000');
  assert.equal(openSale(r, 1, 'REMAINING_CENTS'), '1000000');
  assert.equal(openSale(r, 1, 'CASH_MOVEMENT_COUNT'), '1');
  assert.equal(openSale(r, 1, 'OPEN_CASH_SESSION_RELATED'), 'YES');
  const big = await paidPending((d) => { d.sales[0].total = '9007199254740993'; d.sales[0].subtotal = '9007199254740993'; d.items[0].unit_price = '9007199254740993'; d.items[0].subtotal = '9007199254740993'; });
  assert.equal(openSale(big, 1, 'TOTAL_CENTS'), '9007199254740993');
  assert.equal(openSale(big, 1, 'REMAINING_CENTS'), String(9007199254740993n - 500000n));
});

test('M03 PAID covering the total → PAID_READY_TO_COMPLETE (complete canonical); PAID not covering → PAID_INCONSISTENT (new operation)', async () => {
  const ready = await paidPending((d) => {
    d.sales[0].status = 'PAID';
    d.payments.push({ id: 'pay3', sale_id: 's1', method: 'CASH', amount: '1000000', has_session: true });
    d.cashMovements.push({ sale_payment_id: 'pay3', type: 'SALE_INCOME', amount: '1000000' });
  });
  assert.equal(openSale(ready, 1, 'CLASSIFICATION'), 'PAID_READY_TO_COMPLETE');
  assert.equal(openSale(ready, 1, 'CANONICAL_ACTION'), 'COMPLETE_CANONICAL');
  const bad = await paidPending((d) => { d.sales[0].status = 'PAID'; });
  assert.equal(openSale(bad, 1, 'CLASSIFICATION'), 'PAID_INCONSISTENT');
  assert.equal(openSale(bad, 1, 'CANONICAL_ACTION'), 'NEEDS_NEW_REVIEWED_OPERATION');
});

test('M04 DRAFT without payment, PROPORTIONAL_V1 / checkout, mixed items and inconsistent money are never guessed', async () => {
  const draft = await resv((d) => { d.sales[0].status = 'DRAFT'; d.reservations.length = 0; d.inventory[0].reserved = '0'; });
  assert.equal(openSale(draft, 1, 'CLASSIFICATION'), 'DRAFT_NO_PAYMENT');
  assert.equal(openSale(draft, 1, 'CANONICAL_ACTION'), 'CANCEL_CANONICAL');
  assert.equal(openSale(draft, 1, 'RESERVATION_STATUS'), 'NONE');
  const prop = await resv((d) => { d.sales[0].pricing_model = 'PROPORTIONAL_V1'; d.attempts.push({ sale_id: 's1', status: 'RESERVED' }); });
  assert.equal(openSale(prop, 1, 'CLASSIFICATION'), 'PROPORTIONAL_ACTIVE');
  assert.equal(openSale(prop, 1, 'CHECKOUT_ATTEMPT_STATUS'), 'RESERVED');
  assert.equal(openSale(prop, 1, 'CANONICAL_ACTION'), 'NEEDS_NEW_REVIEWED_OPERATION');
  const mixed = await paidPending((d) => { d.items.push({ sale_id: 's1', variant_id: 'v2', quantity: '1', unit_price: '10', subtotal: '10' }); d.sales[0].subtotal = '1500010'; d.sales[0].total = '1500010'; });
  assert.equal(openSale(mixed, 1, 'ITEM_COUNT'), '2');
  assert.equal(openSale(mixed, 1, 'SYNTHETIC_ITEM_COUNT'), '1');
  assert.equal(openSale(mixed, 1, 'CANONICAL_ACTION'), 'NEEDS_NEW_REVIEWED_OPERATION');
  const odd = await resv((d) => { d.sales[0].total = '1'; });
  assert.equal(openSale(odd, 1, 'CLASSIFICATION'), 'OTHER_INCONSISTENT');
});

test('M05 only open sales with an exact synthetic item are listed: closed sales and non-synthetic sales are not', async () => {
  const cancelled = await resv((d) => { d.sales[0].status = 'CANCELLED'; d.reservations.length = 0; d.inventory[0].reserved = '0'; });
  assert.equal(line(cancelled, 'OPEN_SYNTHETIC_SALES'), '0');
  assert.equal(openSale(cancelled, 1, 'STATUS'), undefined);
  const lookalike = await resv((d) => { d.variants[0].barcode = 'PILOT-BC-9999'; d.reservations.length = 0; d.inventory[0].reserved = '0'; });
  assert.equal(line(lookalike, 'OPEN_SYNTHETIC_SALES'), '0', 'a PILOT-* SKU alone is not a synthetic identity');
  assert.equal(line(lookalike, 'SYNTHETIC_VARIANTS_FOUND'), '0');
});

test('M06 several open sales are listed in a stable digest order; catalog flags follow isActive', async () => {
  const two = await resv((d) => {
    d.sales.push({ id: 's3', branch_id: PCEN, status: 'DRAFT', total: '10', subtotal: '10', discount_total: '0', pricing_model: 'FIXED_TOTAL', price_mode: 'CASH', pricing_mode: 'LIST', wholesale_confirmed: false });
    d.items.push({ sale_id: 's3', variant_id: 'v1', quantity: '1', unit_price: '10', subtotal: '10' });
    d.variants[0].active = false; d.products[0].active = false;
  });
  assert.equal(line(two, 'OPEN_SYNTHETIC_SALES'), '2');
  const digests = [openSale(two, 1, 'SALE_IDENTITY_DIGEST'), openSale(two, 2, 'SALE_IDENTITY_DIGEST')];
  assert.deepEqual(digests, [...digests].sort());
  assert.equal(line(two, 'SYNTHETIC_ACTIVE_VARIANTS'), '0');
  assert.equal(line(two, 'SYNTHETIC_ACTIVE_PRODUCTS'), '0');
});

test('M07 the new reads are frozen constants and select no secret', () => {
  assert.match(T.STATEMENTS.SALE_PAYMENTS, /"cashSessionId" AS session_id/);
  assert.match(T.STATEMENTS.CASH_SESSIONS, /\bid\b/);
});

// ---------- N01–N02 real vs synthetic split (the final Local 1 data verification) ----------
test('N01 REAL_* and INACTIVE_SYNTHETIC_* separate the exact synthetic identity from the real catalog and stock', async () => {
  const r = await resv((d) => {
    d.variants[0].active = false; d.products[0].active = false; d.reservations.length = 0; d.sales[0].status = 'CANCELLED'; d.inventory[0].reserved = '0';
    d.products.push({ id: 'p9', active: true }, { id: 'p8', active: true });
    d.variants.push({ id: 'v9', product_id: 'p9', sku: 'REAL-9', barcode: 'REAL-9', active: true }, { id: 'v8', product_id: 'p8', sku: 'REAL-8', barcode: 'REAL-8', active: true });
    d.inventory.push({ id: 'i9', variant_id: 'v9', branch_id: PCEN, physical: '40', reserved: '0' }, { id: 'i8', variant_id: 'v8', branch_id: PCEN, physical: '2', reserved: '0' });
    d.movements.push({ type: 'INITIAL_STOCK', branch_id: PCEN, delta: '40', inventory_id: 'i9' }, { type: 'INITIAL_STOCK', branch_id: PCEN, delta: '2', inventory_id: 'i8' });
    d.movements[0].inventory_id = 'i1';
  });
  assert.equal(line(r, 'REAL_ACTIVE_PRODUCTS'), '3');
  assert.equal(line(r, 'REAL_ACTIVE_VARIANTS'), '3');
  assert.equal(line(r, 'INACTIVE_SYNTHETIC_PRODUCTS'), '1');
  assert.equal(line(r, 'INACTIVE_SYNTHETIC_VARIANTS'), '1');
  assert.equal(line(r, 'REAL_INITIAL_STOCK_UNITS'), '42', 'the synthetic INITIAL_STOCK (5) is not real stock');
  assert.equal(line(r, 'SYNTHETIC_INITIAL_STOCK_UNITS'), '5');
});
