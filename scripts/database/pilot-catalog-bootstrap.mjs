import { hash as oneShotHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CA_PATH, PROJECT_REF_PATTERN } from './lib.mjs';
import { PILOT_ACCOUNTS } from './pilot-bootstrap.mjs';
import {
  PILOT_URL_FILE,
  deriveProjectRef,
  createVerifiedClient,
  main as pilotMarkerMain,
  parsePilotUrl,
  readPrivateUrlFile,
  safeCode,
} from './pilot-marker.mjs';

// OWNER-only, PILOT-only, ADDITIVE bootstrap of a small synthetic merchandise
// catalog for client demos. Separate from the DEMO seed/reset path and from
// pilot-bootstrap.mjs (which it requires to have run: PCEN/PDEP and the OWNER).
//
//   node scripts/database/pilot-catalog-bootstrap.mjs --target=pilot --dry-run --marker-id=<uuid>
//   node scripts/database/pilot-catalog-bootstrap.mjs --target=pilot --execute --marker-id=<uuid> \
//     --confirm-project-ref=<ref> --plan=<sha256 printed by the dry-run>
//
// The only target source is the OWNER-private ~/.config/mona-jacinta/pilot-database-url
// (never .env*, DATABASE_URL or TEST_DATABASE_URL). The dataset is fixed in this
// file: synthetic, visibly PILOT, no real Mona Jacinta merchandise.
//
// Execute: pilot-marker's audited --check proves the canonical PILOT marker on the
// held URL; then ONE Prisma transaction over the same URL (verified TLS) takes the
// maintenance advisory lock, re-proves the marker, reads the catalog/ledger tables
// plus PCEN/PDEP and the OWNER, and classifies: absent → create; exact → no-op;
// anything else → roll back. Writes go through the canonical api/src catalog-admin
// (Product/ProductVariant + audit) and initial-stock (Inventory increment +
// INITIAL_STOCK movement + audit) services, run inline in this transaction, with
// the OWNER as the audit actor. Categories/brands have no API write path; they are
// plain creates (no audit, as in the API). A post-write classification in the same
// transaction must find the exact canonical state before COMMIT.

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PREFIX = '[db:pilot-catalog-bootstrap]';
const URL_LABEL = '~/.config/mona-jacinta/pilot-database-url';
// Shared maintenance advisory lock (pilot-bootstrap, canonical-owner, system-actor).
const MAINTENANCE_ADVISORY_LOCK_ID = 506005;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PLAN_DIGEST = /^[0-9a-f]{64}$/;
const MODES = ['dry-run', 'execute'];
const VALUE_ARGS = ['target', 'marker-id', 'confirm-project-ref', 'plan'];
const MARKER_RECHECK_SQL = `SELECT to_regnamespace('mona_test_guard') IS NOT NULL AS test_guard_exists,
  (SELECT coalesce(json_agg(json_build_object('environment', environment, 'marker_id', marker_id::text)), '[]'::json)
     FROM mona_pilot_guard.database_identity) AS rows`;
const PLACEHOLDER_ID = '00000000-0000-4000-8000-000000000000';
const CATALOG_AUDIT_ENTITIES = ['Product', 'ProductVariant', 'Inventory'];

export const OWNER_ACCOUNT = PILOT_ACCOUNTS.find((a) => a.role === 'OWNER' && a.scope === 'COMPANY');
export const CATALOG_LOCATIONS = Object.freeze({ retail: 'PCEN', warehouse: 'PDEP' });
const LOCATION_TYPES = Object.freeze([
  Object.freeze([CATALOG_LOCATIONS.retail, 'RETAIL_BRANCH']),
  Object.freeze([CATALOG_LOCATIONS.warehouse, 'CENTRAL_WAREHOUSE']),
]);

const deepFreeze = (value) => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
};

// --- canonical synthetic dataset --------------------------------------------------
//
// Money: ARS centavos as integer strings (the API's JSON money convention).
// Stock: units per location, as the API's positive integer strings.
let barcodeSeq = 0;
const variant = (sku, color, size, price, costPrice, pcen, pdep) => {
  barcodeSeq += 1;
  return { sku: `PILOT-${sku}`, barcode: `PILOT-BC-${String(barcodeSeq).padStart(4, '0')}`, color, size, price, costPrice, stock: { PCEN: pcen, PDEP: pdep } };
};
export const CATALOG = deepFreeze({
  categories: ['Remeras PILOT', 'Pantalones PILOT', 'Abrigos PILOT'],
  brands: ['Mona Basics PILOT', 'Jacinta Urban PILOT'],
  products: [
    { name: 'Remera Básica PILOT', slug: 'remera-basica-pilot', category: 'Remeras PILOT', brand: 'Mona Basics PILOT', variants: [
      variant('REMBAS-BLA-S', 'Blanco', 'S', '1500000', '700000', '12', '30'),
      variant('REMBAS-BLA-M', 'Blanco', 'M', '1500000', '700000', '12', '30'),
      variant('REMBAS-BLA-L', 'Blanco', 'L', '1500000', '700000', '10', '25'),
    ] },
    { name: 'Remera Oversize PILOT', slug: 'remera-oversize-pilot', category: 'Remeras PILOT', brand: 'Jacinta Urban PILOT', variants: [
      variant('REMOVR-NEG-M', 'Negro', 'M', '2200000', '1000000', '8', '20'),
      variant('REMOVR-NEG-L', 'Negro', 'L', '2200000', '1000000', '8', '20'),
    ] },
    { name: 'Jean Recto PILOT', slug: 'jean-recto-pilot', category: 'Pantalones PILOT', brand: 'Mona Basics PILOT', variants: [
      variant('JEANRC-AZU-38', 'Azul', '38', '4500000', '2100000', '6', '15'),
      variant('JEANRC-AZU-40', 'Azul', '40', '4500000', '2100000', '6', '15'),
      variant('JEANRC-AZU-42', 'Azul', '42', '4500000', '2100000', '5', '12'),
    ] },
    { name: 'Pantalón Cargo PILOT', slug: 'pantalon-cargo-pilot', category: 'Pantalones PILOT', brand: 'Jacinta Urban PILOT', variants: [
      variant('CARGO-VER-M', 'Verde', 'M', '3800000', '1800000', '6', '15'),
      variant('CARGO-VER-L', 'Verde', 'L', '3800000', '1800000', '6', '15'),
    ] },
    { name: 'Buzo Clásico PILOT', slug: 'buzo-clasico-pilot', category: 'Abrigos PILOT', brand: 'Mona Basics PILOT', variants: [
      variant('BUZO-GRI-S', 'Gris', 'S', '3500000', '1600000', '5', '12'),
      variant('BUZO-GRI-M', 'Gris', 'M', '3500000', '1600000', '5', '12'),
      variant('BUZO-GRI-L', 'Gris', 'L', '3500000', '1600000', '4', '10'),
    ] },
    { name: 'Campera Liviana PILOT', slug: 'campera-liviana-pilot', category: 'Abrigos PILOT', brand: 'Jacinta Urban PILOT', variants: [
      variant('CAMP-NEG-M', 'Negro', 'M', '6500000', '3000000', '4', '10'),
      variant('CAMP-NEG-L', 'Negro', 'L', '6500000', '3000000', '4', '10'),
      variant('CAMP-BEI-M', 'Beige', 'M', '6500000', '3000000', '3', '8'),
    ] },
  ],
});

// --- validation (pure) --------------------------------------------------------------

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const exactKeys = (obj, keys) => isPlainObject(obj) && Object.keys(obj).length === keys.length && keys.every((k) => Object.hasOwn(obj, k));
const allVariants = (catalog) => catalog.products.flatMap((p) => p.variants.map((v) => ({ product: p, variant: v })));

// The dataset must be PILOT-marked, unique, 12-18 variants, stock at exactly
// PCEN and PDEP, and every value must pass the canonical API DTO schemas
// unchanged (so the services receive exactly what the API would accept).
export function validateCatalog(catalog, canonical, locations = LOCATION_TYPES) {
  const fail = (reason) => ({ ok: false, reason });
  if (!exactKeys(catalog, ['categories', 'brands', 'products'])) return fail('dataset must be exactly {categories, brands, products}');
  const { categories, brands, products } = catalog;
  const names = (list) => Array.isArray(list) && list.length > 0 && list.every((n) => typeof n === 'string' && n.length > 0 && n === n.trim()) && new Set(list).size === list.length;
  if (!names(categories) || !categories.every((c) => /\bPILOT\b/.test(c))) return fail('categories must be distinct names marked PILOT');
  if (!names(brands) || !brands.every((b) => /\bPILOT\b/.test(b))) return fail('brands must be distinct names marked PILOT');
  if (!Array.isArray(products) || products.length === 0) return fail('products must be a non-empty list');
  const seen = { slug: new Set(), name: new Set(), sku: new Set(), barcode: new Set() };
  const stockKeys = locations.map(([code]) => code);
  let count = 0;
  for (const p of products) {
    if (!exactKeys(p, ['name', 'slug', 'category', 'brand', 'variants'])) return fail('each product must be exactly {name, slug, category, brand, variants}');
    if (typeof p.name !== 'string' || !/\bPILOT\b/.test(p.name)) return fail('product names must be marked PILOT');
    if (typeof p.slug !== 'string' || !p.slug.endsWith('-pilot')) return fail('product slugs must end in -pilot');
    if (!categories.includes(p.category) || !brands.includes(p.brand)) return fail(`${p.slug}: unknown category or brand`);
    const parsed = canonical.createProductSchema.safeParse({ name: p.name, slug: p.slug, categoryId: PLACEHOLDER_ID, brandId: PLACEHOLDER_ID });
    if (!parsed.success || parsed.data.name !== p.name || parsed.data.slug !== p.slug) return fail(`${p.slug}: rejected by the product DTO`);
    if (seen.slug.has(p.slug) || seen.name.has(p.name)) return fail(`${p.slug}: duplicated product`);
    seen.slug.add(p.slug);
    seen.name.add(p.name);
    if (!Array.isArray(p.variants) || p.variants.length === 0) return fail(`${p.slug}: needs at least one variant`);
    for (const v of p.variants) {
      count += 1;
      if (!exactKeys(v, ['sku', 'barcode', 'color', 'size', 'price', 'costPrice', 'stock'])) return fail(`${p.slug}: each variant must be exactly {sku, barcode, color, size, price, costPrice, stock}`);
      if (typeof v.sku !== 'string' || !v.sku.startsWith('PILOT-')) return fail('variant SKUs must start with PILOT-');
      if (typeof v.barcode !== 'string' || !v.barcode.startsWith('PILOT-')) return fail(`${v.sku}: barcode must start with PILOT-`);
      if (typeof v.price !== 'string' || typeof v.costPrice !== 'string') return fail(`${v.sku}: money must be integer-centavo strings`);
      // Present strings only: an undefined value would serialize into the plan like null.
      if (typeof v.color !== 'string' || typeof v.size !== 'string') return fail(`${v.sku}: color and size must be strings`);
      const { stock, ...input } = v;
      const pv = canonical.createVariantSchema.safeParse({ ...input, productId: PLACEHOLDER_ID });
      if (!pv.success || pv.data.sku !== v.sku || pv.data.barcode !== v.barcode || pv.data.color !== v.color || pv.data.size !== v.size) {
        return fail(`${v.sku}: rejected by the variant DTO`);
      }
      if (seen.sku.has(v.sku) || seen.barcode.has(v.barcode)) return fail(`${v.sku}: duplicated SKU or barcode`);
      seen.sku.add(v.sku);
      seen.barcode.add(v.barcode);
      if (!exactKeys(stock, stockKeys)) return fail(`${v.sku}: stock must be exactly ${stockKeys.join(' and ')}`);
      for (const code of stockKeys) {
        const q = canonical.initialStockSchema.safeParse({ variantId: PLACEHOLDER_ID, branchId: PLACEHOLDER_ID, quantity: stock[code] });
        if (!q.success) return fail(`${v.sku}: ${code} stock must be a positive integer string`);
      }
    }
  }
  if (count < 12 || count > 18) return fail('the dataset must hold 12 to 18 variants');
  return { ok: true };
}

// --- CLI ----------------------------------------------------------------------------

// Exactly one --target=pilot, one mode, a canonical marker id; --confirm-project-ref
// and --plan only (and always) with --execute. Rejected values are never echoed.
export function parseCliArgs(argv) {
  const values = {};
  const modes = [];
  for (const arg of argv) {
    if (!arg.startsWith('--')) return { ok: false, error: 'Unexpected positional argument (not echoed)' };
    const body = arg.slice(2);
    if (MODES.includes(body)) {
      modes.push(body);
      continue;
    }
    const eq = body.indexOf('=');
    const key = eq === -1 ? null : body.slice(0, eq);
    if (!key || !VALUE_ARGS.includes(key)) return { ok: false, error: 'Unknown argument (not echoed)' };
    if (key in values) return { ok: false, error: `--${key} may be given only once` };
    values[key] = body.slice(eq + 1);
  }
  if (modes.length !== 1) return { ok: false, error: 'Specify exactly one of --dry-run or --execute' };
  const [mode] = modes;
  if (values.target !== 'pilot') return { ok: false, error: 'Exactly --target=pilot is required' };
  if (values['marker-id'] === undefined || !UUID_V4.test(values['marker-id'])) {
    return { ok: false, error: '--marker-id must be a canonical lowercase version-4 UUID' };
  }
  const confirmProjectRef = values['confirm-project-ref'] ?? null;
  const plan = values.plan ?? null;
  if (mode === 'dry-run' && (confirmProjectRef !== null || plan !== null)) {
    return { ok: false, error: '--confirm-project-ref and --plan are accepted only with --execute' };
  }
  if (mode === 'execute' && (confirmProjectRef === null || !PROJECT_REF_PATTERN.test(confirmProjectRef))) {
    return { ok: false, error: '--execute requires --confirm-project-ref=<20-character lowercase project ref>' };
  }
  if (mode === 'execute' && (plan === null || !PLAN_DIGEST.test(plan))) {
    return { ok: false, error: '--execute requires --plan=<the exact 64-character lowercase sha256 printed by the reviewed --dry-run>' };
  }
  return { ok: true, mode, markerId: values['marker-id'], confirmProjectRef, plan };
}

// --- approved plan digest -------------------------------------------------------------
//
// Binds target (derived project ref + marker id), locations, actor and the full
// dataset. Nested arrays only, so there is no object-key order dependence.
const PLAN_DOMAIN = 'mona-jacinta-pilot-catalog-plan-v1';
export function canonicalPlan({ markerId, projectRef, catalog, locations = LOCATION_TYPES, owner = OWNER_ACCOUNT }) {
  const body = [
    ['target', 'pilot'],
    ['projectRef', projectRef],
    ['markerId', markerId],
    ['locations', ...locations.map(([code, type]) => [code, type]), 'active; Location.id = Branch.id'],
    ['actor', owner.id, owner.email, owner.role, owner.scope],
    ['categories', ...catalog.categories],
    ['brands', ...catalog.brands],
    ['products', ...catalog.products.map((p) => ['product', p.name, p.slug, p.category, p.brand,
      ...p.variants.map((v) => ['variant', v.sku, v.barcode, v.color, v.size, v.price, v.costPrice,
        ['stock', ...locations.map(([code]) => [code, v.stock[code]])]])])],
    ['audit', 'PRODUCT_CREATED and PRODUCT_VARIANT_CREATED via the canonical catalog-admin service (branchId null)'],
    ['ledger', 'per variant and location: canonical initial-stock service (physical increment, INITIAL_STOCK movement, INVENTORY_INITIAL_STOCK_LOADED audit)'],
    ['writes', 'additive only: absent → create, exact → no-op, anything else → rollback'],
  ];
  return `${PLAN_DOMAIN}\n${JSON.stringify(body)}\n`;
}
export const planDigest = (input) => oneShotHash('sha256', Buffer.from(canonicalPlan(input), 'utf8'), 'hex');

// --- classification (pure, read-only) ---------------------------------------------------

function sameSet(actual, expected) {
  if (actual.length !== expected.length) return false;
  const a = [...actual].sort();
  const e = [...expected].sort();
  return a.every((v, i) => v === e[i]);
}

// Context (always required): PCEN retail and PDEP warehouse, each exactly one
// active Location with a Branch of the same id and code; the canonical OWNER
// account, active, with exactly one COMPANY OWNER scope.
// Catalog: every catalog/ledger table empty (ABSENT) or exactly the canonical
// dataset with its ledger and audit rows and nothing else (EXACT). Anything else
// is a conflict; nothing is ever repaired.
export function classifyCatalogState(s, catalog, { ownerRoleId, locations = LOCATION_TYPES, owner = OWNER_ACCOUNT }) {
  const conflicts = [];
  const conflict = (msg) => conflicts.push(msg);

  const locationIds = {};
  for (const [code, type] of locations) {
    const locs = s.locations.filter((l) => l.code === code);
    if (locs.length !== 1) {
      conflict(`location ${code} is missing`);
      continue;
    }
    const [loc] = locs;
    const byId = s.branches.filter((b) => b.id === loc.id);
    const byCode = s.branches.filter((b) => b.code === code);
    const problems = [
      loc.type !== type && `location ${code} is not a ${type}`,
      loc.isActive !== true && `location ${code} is not active`,
      (byId.length !== 1 || byCode.length !== 1 || byId[0] !== byCode[0]) && `location ${code} has no Branch with the same id and code`,
    ].filter(Boolean);
    problems.forEach(conflict);
    if (problems.length === 0) locationIds[code] = loc.id;
  }

  const [byEmail] = s.ownerByEmail;
  const [byId] = s.ownerById;
  if (s.ownerByEmail.length !== 1 || s.ownerById.length !== 1 || byEmail.id !== owner.id || byId.email !== owner.email || byId.isActive !== true) {
    conflict('the canonical PILOT OWNER account is missing, inactive or not canonical');
  }
  const [role] = s.ownerRole;
  if (s.ownerRole.length !== 1 || role.id !== ownerRoleId || role.code !== 'OWNER') conflict('the canonical OWNER role row is missing');
  const [scope] = s.ownerScopes;
  if (s.ownerScopes.length !== 1 || scope.roleId !== ownerRoleId || scope.scopeKind !== 'COMPANY' || scope.locationId !== null) {
    conflict('the PILOT OWNER does not hold exactly one COMPANY OWNER scope');
  }

  const tables = ['categories', 'brands', 'products', 'variants', 'inventory', 'movements', 'reservations', 'saleItems', 'audits'];
  let catalogState = 'ABSENT';
  if (tables.some((t) => s[t].length > 0)) {
    const before = conflicts.length;
    exactCatalogConflicts(s, catalog, { locationIds, locations, ownerId: owner.id }, conflict);
    catalogState = conflicts.length === before ? 'EXACT' : 'CONFLICT';
  }
  return { state: conflicts.length > 0 ? 'CONFLICT' : catalogState, conflicts, locationIds };
}

function exactCatalogConflicts(s, catalog, { locationIds, locations, ownerId }, conflict) {
  const codes = locations.map(([code]) => code);
  const variants = allVariants(catalog);
  const one = (rows, pred) => {
    const found = rows.filter(pred);
    return found.length === 1 ? found[0] : null;
  };
  const auditOf = (entityType, action, entityId) => one(s.audits, (a) => a.entityType === entityType && a.action === action && a.entityId === entityId);

  if (!sameSet(s.categories.map((c) => c.name), catalog.categories)) conflict('categories differ from the canonical PILOT catalog');
  if (!sameSet(s.brands.map((b) => b.name), catalog.brands)) conflict('brands differ from the canonical PILOT catalog');
  if (s.products.length !== catalog.products.length) conflict('the product count differs from the canonical PILOT catalog');
  if (s.variants.length !== variants.length) conflict('the variant count differs from the canonical PILOT catalog');
  if (s.inventory.length !== variants.length * codes.length) conflict('the Inventory row count differs from the canonical stock');
  if (s.movements.length !== variants.length * codes.length) conflict('the StockMovement count differs from the canonical stock');
  if (s.reservations.length > 0 || s.saleItems.length > 0) conflict('stock reservations or sale items exist (the catalog has been used)');
  if (s.audits.length !== catalog.products.length + variants.length * (1 + codes.length)) conflict('the catalog audit row count differs');

  const nameOf = (rows, id) => rows.find((r) => r.id === id)?.name;
  const productIds = new Map();
  for (const p of catalog.products) {
    const row = one(s.products, (x) => x.slug === p.slug);
    if (!row || row.name !== p.name || row.description !== null || row.isActive !== true
      || nameOf(s.categories, row.categoryId) !== p.category || nameOf(s.brands, row.brandId) !== p.brand) {
      conflict(`product ${p.slug} is missing or differs`);
      continue;
    }
    productIds.set(p.slug, row.id);
    const audit = auditOf('Product', 'PRODUCT_CREATED', row.id);
    if (!audit || audit.userId !== ownerId || audit.branchId !== null || audit.after?.slug !== p.slug) conflict(`product ${p.slug}: creation audit is missing or differs`);
  }
  for (const { product, variant: v } of variants) {
    const row = one(s.variants, (x) => x.sku === v.sku);
    if (!row || row.barcode !== v.barcode || row.color !== v.color || row.size !== v.size || row.price !== BigInt(v.price)
      || row.costPrice !== BigInt(v.costPrice) || row.isActive !== true || row.productId !== productIds.get(product.slug)) {
      conflict(`variant ${v.sku} is missing or differs`);
      continue;
    }
    const audit = auditOf('ProductVariant', 'PRODUCT_VARIANT_CREATED', row.id);
    if (!audit || audit.userId !== ownerId || audit.branchId !== null || audit.after?.sku !== v.sku) conflict(`variant ${v.sku}: creation audit is missing or differs`);
    for (const code of codes) {
      const branchId = locationIds[code];
      if (!branchId) continue;
      const qty = BigInt(v.stock[code]);
      const inv = one(s.inventory, (i) => i.variantId === row.id && i.branchId === branchId);
      if (!inv || inv.physical !== qty || inv.reserved !== 0n) {
        conflict(`stock ${v.sku}@${code} is missing or differs`);
        continue;
      }
      const move = one(s.movements, (m) => m.inventoryId === inv.id);
      if (!move || move.type !== 'INITIAL_STOCK' || move.quantityDelta !== qty || move.saleId !== null || move.userId !== ownerId || move.branchId !== branchId) {
        conflict(`stock ${v.sku}@${code}: INITIAL_STOCK movement is missing or differs`);
      }
      const audit = auditOf('Inventory', 'INVENTORY_INITIAL_STOCK_LOADED', inv.id);
      if (!audit || audit.userId !== ownerId || audit.branchId !== branchId || audit.after?.quantity !== String(qty)
        || audit.after?.physical !== String(qty) || audit.after?.variantId !== row.id) {
        conflict(`stock ${v.sku}@${code}: initial-stock audit is missing or differs`);
      }
    }
  }
}

// --- canonical modules (in-process, repo-local tsx) ----------------------------------

async function tsImport(rel) {
  const api = await import(pathToFileURL(path.join(ROOT, 'api/node_modules/tsx/dist/esm/api/index.mjs')).href);
  return api.tsImport(pathToFileURL(path.join(ROOT, rel)).href, import.meta.url);
}

export async function loadCanonical() {
  const rbac = await tsImport('api/src/modules/rbac/catalog.service.ts');
  const catalogAdmin = await tsImport('api/src/modules/products/catalog-admin.service.ts');
  const initialStock = await tsImport('api/src/modules/inventory/initial-stock.service.ts');
  const productDto = await tsImport('api/src/modules/products/dto/product.dto.ts');
  const variantDto = await tsImport('api/src/modules/products/dto/variant.dto.ts');
  return {
    CANONICAL_ROLE_IDS: rbac.CANONICAL_ROLE_IDS,
    createCatalogAdminService: catalogAdmin.createCatalogAdminService,
    createInitialStockService: initialStock.createInitialStockService,
    createProductSchema: productDto.createProductSchema,
    createVariantSchema: variantDto.createVariantSchema,
    initialStockSchema: initialStock.initialStockSchema,
  };
}

// Prisma over the SAME held connection fields as the proof, with the same
// verified-TLS trust anchor (explicit CA, rejectUnauthorized) — never a URL
// string, so no query/libpq override can apply. Same as pilot-bootstrap.mjs.
async function createPilotPrisma(conn) {
  const { PrismaClient } = await tsImport('api/src/generated/prisma/client.ts');
  const require = createRequire(path.join(ROOT, 'api', 'package.json'));
  const { PrismaPg } = await import(pathToFileURL(require.resolve('@prisma/adapter-pg')).href);
  const adapter = new PrismaPg({
    ...conn,
    ssl: { rejectUnauthorized: true, ca: readFileSync(CA_PATH, 'utf8'), servername: conn.host },
    connectionTimeoutMillis: 10000,
  });
  return new PrismaClient({ adapter, log: [] });
}

// --- transaction body ---------------------------------------------------------------------

class Stop extends Error {
  constructor(phase, reason) {
    super(reason);
    this.phase = phase;
  }
}

// Least privilege: never passwordHash; only the OWNER's identity rows.
async function readSnapshot(tx, ownerRoleId, owner) {
  return {
    categories: await tx.category.findMany({ select: { id: true, name: true } }),
    brands: await tx.brand.findMany({ select: { id: true, name: true } }),
    products: await tx.product.findMany({ select: { id: true, name: true, slug: true, description: true, categoryId: true, brandId: true, isActive: true } }),
    variants: await tx.productVariant.findMany({
      select: { id: true, productId: true, sku: true, barcode: true, color: true, size: true, price: true, costPrice: true, isActive: true },
    }),
    inventory: await tx.inventory.findMany({ select: { id: true, variantId: true, branchId: true, physical: true, reserved: true } }),
    movements: await tx.stockMovement.findMany({
      select: { id: true, inventoryId: true, type: true, quantityDelta: true, saleId: true, userId: true, branchId: true },
    }),
    reservations: await tx.stockReservation.findMany({ select: { id: true } }),
    saleItems: await tx.saleItem.findMany({ select: { id: true } }),
    audits: await tx.auditLog.findMany({
      where: { entityType: { in: CATALOG_AUDIT_ENTITIES } },
      select: { id: true, userId: true, branchId: true, action: true, entityType: true, entityId: true, after: true },
    }),
    locations: await tx.location.findMany({ select: { id: true, code: true, type: true, isActive: true } }),
    branches: await tx.branch.findMany({ select: { id: true, code: true } }),
    ownerByEmail: await tx.user.findMany({ where: { email: owner.email }, select: { id: true, email: true, isActive: true } }),
    ownerById: await tx.user.findMany({ where: { id: owner.id }, select: { id: true, email: true, isActive: true } }),
    ownerScopes: await tx.userRoleScope.findMany({ where: { userId: owner.id }, select: { roleId: true, scopeKind: true, locationId: true } }),
    ownerRole: await tx.role.findMany({ where: { id: ownerRoleId }, select: { id: true, code: true } }),
  };
}

// Runs canonical services inside THIS transaction: their `$transaction(fn)` becomes
// `fn(tx)`, so nothing commits separately. A nested callback cannot be rolled back
// on its own, so a failed one must never be retried on this same transaction (the
// initial-stock service retries P2002/P2034/40001/40P01/TransactionWriteConflict,
// which is only sound with a fresh transaction per attempt). Therefore ANY callback
// failure — rejection, synchronous throw or non-Error value — becomes one fixed
// NestedTransactionFailure that no service classifies as retryable (no code, meta,
// cause or original message), the adapter refuses every later nested callback, and
// `failed` lets the caller abort even if a service swallowed the error. The outer
// transaction then rolls back as a whole.
export class NestedTransactionFailure extends Error {
  constructor() {
    super('nested catalog operation failed; the outer transaction is aborted');
    this.name = 'NestedTransactionFailure';
  }
}

export function nestedTransactionAdapter(tx) {
  let failed = false;
  const run = async (fn) => {
    if (failed || typeof fn !== 'function') {
      failed = true;
      throw new NestedTransactionFailure();
    }
    try {
      return await fn(tx);
    } catch {
      failed = true;
      throw new NestedTransactionFailure();
    }
  };
  return {
    db: new Proxy(tx, { get: (target, prop) => (prop === '$transaction' ? run : target[prop]) }),
    get failed() {
      return failed;
    },
  };
}

async function assertMarker(tx, markerId) {
  const [marker] = await tx.$queryRawUnsafe(MARKER_RECHECK_SQL);
  // json_agg may arrive decoded or as JSON text, depending on the driver adapter.
  let rows = marker?.rows;
  if (typeof rows === 'string') {
    try {
      rows = JSON.parse(rows);
    } catch {
      rows = null;
    }
  }
  if (!Array.isArray(rows)) rows = [];
  if (marker?.test_guard_exists !== false || rows.length !== 1 || rows[0].environment !== 'pilot' || rows[0].marker_id !== markerId) {
    throw new Stop('conflict', 'the write session does not see exactly the proven PILOT marker (or sees a TEST marker); nothing was written');
  }
}

async function catalogTransaction(tx, { markerId, canonical, catalog, locations, owner }) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(${MAINTENANCE_ADVISORY_LOCK_ID})::text`;
  await assertMarker(tx, markerId);

  const ownerRoleId = canonical.CANONICAL_ROLE_IDS.OWNER;
  const before = classifyCatalogState(await readSnapshot(tx, ownerRoleId, owner), catalog, { ownerRoleId, locations, owner });
  if (before.conflicts.length > 0) {
    const more = before.conflicts.length > 1 ? ` (+${before.conflicts.length - 1} more)` : '';
    throw new Stop('conflict', `${before.conflicts[0]}${more}; nothing was written`);
  }
  if (before.state === 'EXACT') return { action: 'NOOP' };

  const ownerId = owner.id;
  const categoryIds = new Map();
  for (const name of catalog.categories) categoryIds.set(name, (await tx.category.create({ data: { name }, select: { id: true } })).id);
  const brandIds = new Map();
  for (const name of catalog.brands) brandIds.set(name, (await tx.brand.create({ data: { name }, select: { id: true } })).id);

  const nested = nestedTransactionAdapter(tx);
  const admin = canonical.createCatalogAdminService(nested.db);
  const stock = canonical.createInitialStockService(nested.db);
  let variantCount = 0;
  let stockRows = 0;
  for (const p of catalog.products) {
    const product = await admin.createProduct(ownerId, canonical.createProductSchema.parse({
      name: p.name, slug: p.slug, categoryId: categoryIds.get(p.category), brandId: brandIds.get(p.brand),
    }));
    for (const v of p.variants) {
      const { stock: quantities, ...input } = v;
      const created = await admin.createVariant(ownerId, canonical.createVariantSchema.parse({ ...input, productId: product.id }));
      variantCount += 1;
      for (const [code] of locations) {
        await stock.loadInitialStock(ownerId, canonical.initialStockSchema.parse({
          variantId: created.id, branchId: before.locationIds[code], quantity: quantities[code],
        }));
        stockRows += 1;
      }
    }
  }

  // A service that swallowed a nested failure must not reach COMMIT.
  if (nested.failed) throw new NestedTransactionFailure();

  // Post-write verification in the same transaction, independent of the writes above.
  const after = classifyCatalogState(await readSnapshot(tx, ownerRoleId, owner), catalog, { ownerRoleId, locations, owner });
  if (after.state !== 'EXACT') {
    throw new Stop('verify', `post-write verification failed (${after.conflicts[0] ?? 'state not exact'}); rolled back`);
  }
  return { action: 'CREATED', counts: { categories: categoryIds.size, brands: brandIds.size, products: catalog.products.length, variants: variantCount, stockRows } };
}

// --- main ------------------------------------------------------------------------------

const defaultDeps = {
  // The plan: fixed canonical values. Overridable only programmatically (tests).
  catalog: CATALOG,
  locations: LOCATION_TYPES,
  owner: OWNER_ACCOUNT,
  urlFile: PILOT_URL_FILE,
  readPrivateFile: (file) => readPrivateUrlFile(file),
  env: process.env,
  createClient: createVerifiedClient,
  createPrisma: createPilotPrisma,
  loadCanonical,
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

export async function main(argv, deps = defaultDeps) {
  const d = { ...defaultDeps, ...deps };
  const fail = (phase, detail, code) => {
    d.error(`${PREFIX} FAIL: phase=${phase}${code ? ` code=${code}` : ''} — ${detail}`);
    return 1;
  };

  const parsed = parseCliArgs(argv);
  if (!parsed.ok) return fail('args', parsed.error);

  let urlRead;
  try {
    urlRead = d.readPrivateFile(d.urlFile);
  } catch {
    urlRead = { ok: false, reason: 'private URL file could not be read' };
  }
  if (!urlRead.ok) return fail('config', `${URL_LABEL}: ${urlRead.reason}`);
  const heldUrl = urlRead.text.replace(/\r?\n$/, '');
  const url = parsePilotUrl(heldUrl);
  if (!url.ok) return fail('config', `${URL_LABEL} must hold one PostgreSQL URL with user, password, host and database and no query/fragment (value not shown)`);

  let canonical;
  try {
    canonical = await d.loadCanonical();
  } catch {
    return fail('config', 'the canonical catalog/inventory modules could not be loaded');
  }
  const { catalog, locations, owner } = d;
  const types = locations.map(([, type]) => type).sort();
  if (locations.length !== 2 || types[0] !== 'CENTRAL_WAREHOUSE' || types[1] !== 'RETAIL_BRANCH' || !locations.every(([code]) => /^[A-Z]{2,6}$/.test(code))) {
    return fail('config', 'plan locations must be one RETAIL_BRANCH and one CENTRAL_WAREHOUSE code');
  }
  if (owner.role !== 'OWNER' || owner.scope !== 'COMPANY' || !UUID_V4.test(owner.id)) {
    return fail('config', 'the plan actor must be a COMPANY-scoped OWNER account');
  }
  const valid = validateCatalog(catalog, canonical, locations);
  if (!valid.ok) return fail('config', `canonical dataset rejected: ${valid.reason}`);
  const projectRef = deriveProjectRef(url.conn);
  const planInput = Object.freeze({ markerId: parsed.markerId, projectRef, catalog, locations, owner });
  const digest = planDigest(planInput);

  if (parsed.mode === 'dry-run') {
    const variants = allVariants(catalog);
    const [[retail], [warehouse]] = locations;
    for (const line of [
      `${PREFIX} DRY RUN — no database connection was opened and nothing was written`,
      '  target: PILOT',
      `  private URL file: accepted (${URL_LABEL}; value not shown); no .env file or DATABASE_URL/TEST variable is read`,
      projectRef !== null ? '  project identity: derivable from the URL (value not shown)' : '  project identity: NOT derivable from the URL — --execute will refuse',
      `  marker id: ${parsed.markerId} (proven against the database only during --execute, and again inside the write transaction)`,
      `  audit actor: ${owner.email} (must exist, active, with exactly one COMPANY OWNER scope; no password is used)`,
      `  locations: ${locations.map(([code, type]) => `${code} ${type}`).join(' and ')} (active, Location.id = Branch.id)`,
      '  all merchandise is synthetic PILOT data, not real Mona Jacinta inventory; money in ARS centavos',
      `  categories: ${catalog.categories.join(', ')}`,
      `  brands: ${catalog.brands.join(', ')}`,
      `  products (${catalog.products.length}) and variants (${variants.length}): sku  barcode  color/size  price/cost (centavos)  stock ${retail}/${warehouse}`,
      ...catalog.products.flatMap((p) => [
        `    "${p.name}"  ${p.slug}  [${p.category} / ${p.brand}]`,
        ...p.variants.map((v) => `      ${v.sku}  ${v.barcode}  ${v.color}/${v.size}  ${v.price}/${v.costPrice}  ${v.stock[retail]}/${v.stock[warehouse]}`),
      ]),
      '  writes: Category/Brand create; Product/ProductVariant via the canonical catalog-admin service (+ audit);',
      '    stock via the canonical initial-stock service (Inventory increment + INITIAL_STOCK movement + audit)',
      '  additive only: empty catalog → create; exact canonical catalog → no-op; anything partial or different → rollback',
      '  no seed, no reset, no deletes, no updates of existing rows, no migration',
      `  plan sha256: ${digest}`,
      `  OWNER approval token: --plan=${digest}`,
      '  --execute requires this exact digest via --plan=...; any change to target or dataset yields a different digest',
      '  STILL REQUIRED before --execute: explicit OWNER approval naming PILOT',
    ]) d.log(line);
    return 0;
  }

  if (d.env?.DEBUG !== undefined) return fail('config', 'DEBUG is set; unset it (debug output could expose query parameters)');
  if (d.env?.PGOPTIONS !== undefined) return fail('config', 'PGOPTIONS is set in the environment; unset it (value not shown)');
  if (digest !== parsed.plan) {
    return fail('plan', 'this catalog plan/target does not match the approved --plan digest; re-run --dry-run and review (nothing was opened or written)');
  }
  if (projectRef !== parsed.confirmProjectRef) {
    return fail('target', `--confirm-project-ref does not match the project addressed by ${URL_LABEL} (values not shown)`);
  }

  const proof = await pilotMarkerMain(['--target=pilot', '--check', `--marker-id=${parsed.markerId}`], {
    urlFile: d.urlFile,
    readUrlFile: () => ({ ok: true, text: heldUrl }),
    env: d.env,
    createClient: d.createClient,
    log: (line) => d.log(line),
    error: (line) => d.error(line),
  });
  if (proof !== 0) return fail('identity', 'PILOT identity proof failed; nothing was written');
  if (planDigest(planInput) !== parsed.plan) return fail('plan', 'the held plan no longer matches the approved --plan digest; nothing was written');

  const secrets = [url.conn.password, url.conn.host, url.conn.user, url.conn.database, heldUrl];
  let prisma;
  try {
    prisma = await d.createPrisma(url.conn);
    const result = await prisma.$transaction(
      (tx) => catalogTransaction(tx, { markerId: parsed.markerId, canonical, catalog, locations, owner }),
      { timeout: 180000, maxWait: 10000 },
    );
    if (result.action === 'NOOP') {
      d.log(`${PREFIX} OK — PILOT already holds exactly the canonical PILOT catalog; nothing was written`);
      return 0;
    }
    const c = result.counts;
    d.log(`${PREFIX} OK — PILOT catalog bootstrap committed (one transaction, additive only)`);
    d.log(`  categories: ${c.categories}; brands: ${c.brands}; products: ${c.products}; variants: ${c.variants}`);
    d.log(`  initial stock rows: ${c.stockRows} (each with one INITIAL_STOCK movement and one audit row, actor ${owner.email})`);
    return 0;
  } catch (err) {
    if (err instanceof Stop) return fail(err.phase, err.message);
    if (err instanceof NestedTransactionFailure) {
      return fail('bootstrap', 'a nested catalog operation failed and was not retried; transaction rolled back; nothing was written (original error not shown)');
    }
    return fail('bootstrap', 'transaction rolled back; nothing was written', safeCode(err, secrets));
  } finally {
    if (prisma) await Promise.resolve().then(() => prisma.$disconnect()).catch(() => {});
  }
}

// Only run when executed directly; importing from a test never connects.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
