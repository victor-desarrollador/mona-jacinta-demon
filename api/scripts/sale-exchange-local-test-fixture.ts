import type { PrismaClient } from '../src/generated/prisma/client.js';
import { TEST_COMPANY_BOOTSTRAP } from './test-company-bootstrap.js';

// Sale exchange v1 — SYNTHETIC multi-branch fixture for the disposable LOCAL_TEST database (never PILOT, never DEV, never real data).
//
// Everything it writes is identifiable at a glance as synthetic:
//   - branch / location codes `LOCALTEST-S1..S5` and `LOCALTEST-DEP`, names "Sucursal TEST n" / "Depósito TEST";
//   - SKUs `LOCALTEST-…`, barcodes `LOCALTEST-BC-…`, product slugs `localtest-…`, users `test-…@localtest.invalid` (no login is possible:
//     the password hash is a literal that is not a hash), sale numbers `TEST-nnnn`;
//   - every id is deterministic (`00000000-0000-4000-9500-…`), so two loads of an identical database produce identical rows;
//   - prices are round synthetic centavos (10 000 = "100,00"), there are NO payments, NO cash sessions and NO cash movements: no row can be
//     mistaken for operating money.
// It writes only through the Prisma client it is given, and refuses to write ANYTHING unless that client is connected to the disposable
// LOCAL_TEST database: current_database() = mona_local_test AND the LOCAL_TEST marker row is present AND no TEST / PILOT marker schema exists.
// Loading it twice into the same database is refused (the second load would collide on its own ids); rebuild the database instead.
//
// What it models (the scenarios of the exchange validation):
//   - five retail branches and one warehouse, all distinct Branch AND Location rows (Location.id == Branch.id), one company;
//   - A: equal-price size swap (M -> L), a dearer variant (XL), a cheaper one (S), an INACTIVE variant;
//   - W: wholesale variants (M and L with the same wholesale price, XL WITHOUT a wholesale price);
//   - ST: stock cases — exactly one unit left, none left, physical > 0 but fully reserved, the same variant with different quantities per branch;
//   - sales in every state (COMPLETED, partial COMPLETED, DRAFT, PENDING_PAYMENT, PAID, CANCELLED, WHOLESALE) and four COMPLETED sales reserved
//     for the VOID <-> EXCHANGE exclusion;
//   - one user per role and scope (OWNER, ADMIN company, ADMIN location, CASHIER, SELLER, WAREHOUSE).

export const FIXTURE_COMPANY_ID = TEST_COMPANY_BOOTSTRAP.id;
const FIXTURE_NAMESPACE = '00000000-0000-4000-9500-';
export const fixtureId = (n: number) => `${FIXTURE_NAMESPACE}${String(n).padStart(12, '0')}`;

export const BRANCH_KEYS = ['S1', 'S2', 'S3', 'S4', 'S5', 'DEP'] as const;
export type BranchKey = (typeof BRANCH_KEYS)[number];
export const FIXTURE_BRANCHES: Record<BranchKey, { id: string; code: string; name: string; pointOfSaleNumber: number; type: 'RETAIL_BRANCH' | 'CENTRAL_WAREHOUSE' }> = {
  S1: { id: fixtureId(11), code: 'LOCALTEST-S1', name: 'Sucursal TEST 1', pointOfSaleNumber: 9001, type: 'RETAIL_BRANCH' },
  S2: { id: fixtureId(12), code: 'LOCALTEST-S2', name: 'Sucursal TEST 2', pointOfSaleNumber: 9002, type: 'RETAIL_BRANCH' },
  S3: { id: fixtureId(13), code: 'LOCALTEST-S3', name: 'Sucursal TEST 3', pointOfSaleNumber: 9003, type: 'RETAIL_BRANCH' },
  S4: { id: fixtureId(14), code: 'LOCALTEST-S4', name: 'Sucursal TEST 4', pointOfSaleNumber: 9004, type: 'RETAIL_BRANCH' },
  S5: { id: fixtureId(15), code: 'LOCALTEST-S5', name: 'Sucursal TEST 5', pointOfSaleNumber: 9005, type: 'RETAIL_BRANCH' },
  DEP: { id: fixtureId(16), code: 'LOCALTEST-DEP', name: 'Depósito TEST', pointOfSaleNumber: 9006, type: 'CENTRAL_WAREHOUSE' },
};
export const FIXTURE_CODE_PREFIX = 'LOCALTEST-';

export const USER_KEYS = ['OWNER', 'ADMIN_COMPANY', 'ADMIN_LOCATION', 'CASHIER', 'SELLER', 'WAREHOUSE'] as const;
export type UserKey = (typeof USER_KEYS)[number];
export const FIXTURE_USERS: Record<UserKey, { id: string; email: string; name: string; role: string; scope: 'COMPANY' | BranchKey }> = {
  OWNER: { id: fixtureId(21), email: 'test-owner@localtest.invalid', name: 'TEST Owner', role: 'OWNER', scope: 'COMPANY' },
  ADMIN_COMPANY: { id: fixtureId(22), email: 'test-admin-company@localtest.invalid', name: 'TEST Admin Company', role: 'ADMIN', scope: 'COMPANY' },
  ADMIN_LOCATION: { id: fixtureId(23), email: 'test-admin-location@localtest.invalid', name: 'TEST Admin S1', role: 'ADMIN', scope: 'S1' },
  CASHIER: { id: fixtureId(24), email: 'test-cashier@localtest.invalid', name: 'TEST Cashier S1', role: 'CASHIER', scope: 'S1' },
  SELLER: { id: fixtureId(25), email: 'test-seller@localtest.invalid', name: 'TEST Seller S1', role: 'SELLER', scope: 'S1' },
  WAREHOUSE: { id: fixtureId(26), email: 'test-warehouse@localtest.invalid', name: 'TEST Warehouse', role: 'WAREHOUSE', scope: 'DEP' },
};

// ---- catalog ------------------------------------------------------------------------------------------------------------------

export const PRICE = 10_000n; // the equal-value price of every swappable variant
type VariantSpec = { key: string; product: string; size: string; cash: bigint; wholesale?: bigint | null; active?: boolean };
const VARIANTS: VariantSpec[] = [
  // A: retail size swaps
  { key: 'A_M', product: 'A', size: 'M', cash: PRICE }, { key: 'A_L', product: 'A', size: 'L', cash: PRICE },
  { key: 'A_XL', product: 'A', size: 'XL', cash: 15_000n }, { key: 'A_S', product: 'A', size: 'S', cash: 7_000n },
  { key: 'A_OFF', product: 'A', size: 'XXL', cash: PRICE, active: false },
  // W: wholesale (the wholesale price never exceeds the cash price)
  { key: 'W_M', product: 'W', size: 'M', cash: PRICE, wholesale: 8_000n }, { key: 'W_L', product: 'W', size: 'L', cash: PRICE, wholesale: 8_000n },
  { key: 'W_XL', product: 'W', size: 'XL', cash: PRICE, wholesale: null },
  // ST: stock cases, all at the equal price
  { key: 'ST_LAST', product: 'ST', size: 'M', cash: PRICE }, { key: 'ST_NONE', product: 'ST', size: 'L', cash: PRICE },
  { key: 'ST_RES', product: 'ST', size: 'XL', cash: PRICE }, { key: 'ST_MULTI', product: 'ST', size: 'S', cash: PRICE },
];
export type VariantKey = 'A_M' | 'A_L' | 'A_XL' | 'A_S' | 'A_OFF' | 'W_M' | 'W_L' | 'W_XL' | 'ST_LAST' | 'ST_NONE' | 'ST_RES' | 'ST_MULTI';
const PRODUCTS = { A: 'TEST Remera Lisa', W: 'TEST Remera Mayorista', ST: 'TEST Remera Stock' } as const;

// Initial [physical, reserved] per variant and branch (before the COMPLETED sales consume their units; a missing entry = NO inventory row).
const STOCK: Record<VariantKey, Partial<Record<BranchKey, [number, number]>>> = {
  A_M: { S1: [50, 0], S2: [40, 0], S3: [30, 0], S4: [20, 0], S5: [10, 0], DEP: [500, 0] },
  A_L: { S1: [50, 0], S2: [5, 0], S3: [0, 0], DEP: [300, 0] },
  A_XL: { S1: [20, 0], DEP: [100, 0] }, A_S: { S1: [20, 0], DEP: [100, 0] }, A_OFF: { S1: [10, 0] },
  W_M: { S1: [30, 0], DEP: [100, 0] }, W_L: { S1: [30, 0], DEP: [100, 0] }, W_XL: { S1: [30, 0], DEP: [100, 0] },
  ST_LAST: { S1: [1, 0], S2: [100, 0], DEP: [100, 0] }, // S1: exactly the last unit
  ST_NONE: { S1: [0, 0], S2: [100, 0] }, // S1: a row with 0 units; S3..S5: no row at all
  ST_RES: { S1: [5, 5], S2: [5, 0] }, // S1: physical > 0 but fully reserved (available = 0)
  ST_MULTI: { S1: [3, 0], S2: [30, 0], S3: [300, 0], S4: [3, 0], S5: [0, 0], DEP: [3000, 0] }, // the same variant, different quantity per branch
};

// ---- sales --------------------------------------------------------------------------------------------------------------------

export type SaleKey =
  | 'EXCH_OK' | 'EXCH_PARTIAL' | 'EXCH_THEN_VOID' | 'VOID_THEN_EXCH' | 'VOID_PLAIN' | 'GENERAL' | 'STOCK_LAST' | 'STOCK_NONE' | 'STOCK_RESERVED' | 'WHOLESALE'
  | 'S2_COMPLETED' | 'S3_COMPLETED' | 'S4_COMPLETED' | 'S5_COMPLETED' | 'DRAFT' | 'PENDING_PAYMENT' | 'PAID' | 'CANCELLED';
type SaleSpec = {
  key: SaleKey; branch: BranchKey; status: 'COMPLETED' | 'DRAFT' | 'PENDING_PAYMENT' | 'PAID' | 'CANCELLED'; items: Array<[VariantKey, bigint, bigint]>;
  wholesale?: boolean; reserve?: boolean;
};
const SALES: SaleSpec[] = [
  { key: 'EXCH_OK', branch: 'S1', status: 'COMPLETED', items: [['A_M', 1n, PRICE]] },
  { key: 'EXCH_PARTIAL', branch: 'S1', status: 'COMPLETED', items: [['A_M', 2n, PRICE]] },
  { key: 'EXCH_THEN_VOID', branch: 'S1', status: 'COMPLETED', items: [['A_M', 1n, PRICE]] },
  { key: 'VOID_THEN_EXCH', branch: 'S1', status: 'COMPLETED', items: [['A_M', 1n, PRICE]] },
  { key: 'VOID_PLAIN', branch: 'S1', status: 'COMPLETED', items: [['A_M', 1n, PRICE]] },
  { key: 'GENERAL', branch: 'S1', status: 'COMPLETED', items: [['A_M', 1n, PRICE]] }, // refusals (price, stock, state) never consume it
  { key: 'STOCK_LAST', branch: 'S1', status: 'COMPLETED', items: [['A_M', 1n, PRICE]] },
  { key: 'STOCK_NONE', branch: 'S1', status: 'COMPLETED', items: [['A_M', 1n, PRICE]] },
  { key: 'STOCK_RESERVED', branch: 'S1', status: 'COMPLETED', items: [['A_M', 1n, PRICE]] },
  { key: 'WHOLESALE', branch: 'S1', status: 'COMPLETED', items: [['W_M', 2n, 8_000n]], wholesale: true },
  { key: 'S2_COMPLETED', branch: 'S2', status: 'COMPLETED', items: [['A_M', 1n, PRICE]] },
  { key: 'S3_COMPLETED', branch: 'S3', status: 'COMPLETED', items: [['A_M', 1n, PRICE]] },
  { key: 'S4_COMPLETED', branch: 'S4', status: 'COMPLETED', items: [['A_M', 1n, PRICE]] },
  { key: 'S5_COMPLETED', branch: 'S5', status: 'COMPLETED', items: [['A_M', 1n, PRICE]] },
  { key: 'DRAFT', branch: 'S1', status: 'DRAFT', items: [['A_M', 1n, PRICE]] },
  { key: 'PENDING_PAYMENT', branch: 'S1', status: 'PENDING_PAYMENT', items: [['ST_RES', 5n, PRICE]], reserve: true },
  { key: 'PAID', branch: 'S1', status: 'PAID', items: [['A_M', 1n, PRICE]], reserve: true },
  { key: 'CANCELLED', branch: 'S1', status: 'CANCELLED', items: [['A_M', 1n, PRICE]] },
];

export type SaleRef = { saleId: string; itemIds: string[] };
export type FixtureManifest = {
  branches: Record<BranchKey, { branchId: string; locationId: string }>;
  users: Record<UserKey, string>;
  variants: Record<VariantKey, string>;
  inventories: Record<string, string>; // `${variantKey}@${branchKey}` -> Inventory.id
  sales: Record<SaleKey, SaleRef>;
  counts: {
    perBranch: Record<BranchKey, { inventoryRows: number; physicalUnits: bigint; reservedUnits: bigint; sales: number; completedSales: number }>;
    users: number; variants: number; products: number; sales: number; saleItems: number; stockMovements: number; reservations: number;
  };
};

// The disposable LOCAL_TEST identity proof. Throws (writing nothing) unless it is unambiguous.
export async function assertDisposableLocalTest(db: PrismaClient): Promise<void> {
  const facts = await db.$queryRaw<{ current_database: string; local_guard: boolean; test_guard: boolean; pilot_guard: boolean; marker_rows: bigint }[]>`
    SELECT current_database() AS current_database,
           to_regnamespace('mona_local_test_guard') IS NOT NULL AS local_guard,
           to_regnamespace('mona_test_guard') IS NOT NULL AS test_guard,
           to_regnamespace('mona_pilot_guard') IS NOT NULL AS pilot_guard,
           CASE WHEN to_regclass('mona_local_test_guard.database_identity') IS NULL THEN 0
                ELSE (SELECT count(*) FROM mona_local_test_guard.database_identity WHERE environment = 'local_test') END AS marker_rows`;
  const f = facts[0];
  if (!f || f.current_database !== 'mona_local_test' || !f.local_guard || f.test_guard || f.pilot_guard || Number(f.marker_rows) !== 1) {
    throw new Error('sale-exchange fixture refused: the connected database is not provably the disposable LOCAL_TEST (nothing was written)');
  }
}

export async function loadSaleExchangeLocalTestFixture(db: PrismaClient): Promise<FixtureManifest> {
  await assertDisposableLocalTest(db);
  const company = await db.company.findUnique({ where: { id: FIXTURE_COMPANY_ID } });
  if (!company) throw new Error('sale-exchange fixture refused: the canonical TEST company is missing (run the LOCAL_TEST bootstrap first)');
  if (await db.branch.count({ where: { code: { startsWith: FIXTURE_CODE_PREFIX } } }) > 0) {
    throw new Error('sale-exchange fixture refused: it is already loaded in this database (rebuild the database to load it again)');
  }

  return db.$transaction(async (tx) => {
    // 1. topology: six distinct Branch + Location rows (Location.id == Branch.id) and their sale-number counters
    for (const key of BRANCH_KEYS) {
      const b = FIXTURE_BRANCHES[key];
      await tx.branch.create({ data: { id: b.id, code: b.code, name: b.name, address: `Dirección sintética ${b.name}`, pointOfSaleNumber: b.pointOfSaleNumber } });
      await tx.saleNumberCounter.create({ data: { branchId: b.id, nextValue: 1n } });
      await tx.location.upsert({
        where: { id: b.id },
        create: { id: b.id, companyId: company.id, name: b.name, code: b.code, type: b.type, address: `Dirección sintética ${b.name}`, pointOfSaleNumber: b.pointOfSaleNumber },
        update: {},
      });
    }

    // 2. users, one per role/scope, with the REAL role rows of the seeded catalog; no password can ever match
    const roles = new Map((await tx.role.findMany()).map((role) => [role.code, role.id]));
    for (const key of USER_KEYS) {
      const u = FIXTURE_USERS[key];
      const roleId = roles.get(u.role);
      if (!roleId) throw new Error(`sale-exchange fixture refused: role ${u.role} is missing from the seeded catalog`);
      await tx.user.create({ data: { id: u.id, name: u.name, email: u.email, passwordHash: 'LOCALTEST-NO-LOGIN-NOT-A-HASH' } });
      await tx.userRoleScope.create({
        data: { userId: u.id, roleId, scopeKind: u.scope === 'COMPANY' ? 'COMPANY' : 'LOCATION', locationId: u.scope === 'COMPANY' ? null : FIXTURE_BRANCHES[u.scope].id },
      });
    }

    // 3. catalog
    const category = await tx.category.create({ data: { id: fixtureId(31), name: 'TEST Remeras' } });
    const brand = await tx.brand.create({ data: { id: fixtureId(32), name: 'TEST Marca' } });
    const productIds = {} as Record<keyof typeof PRODUCTS, string>;
    let productN = 40;
    for (const key of Object.keys(PRODUCTS) as Array<keyof typeof PRODUCTS>) {
      const created = await tx.product.create({ data: { id: fixtureId(productN), name: PRODUCTS[key], slug: `localtest-remera-${key.toLowerCase()}`, categoryId: category.id, brandId: brand.id } });
      productIds[key] = created.id; productN += 1;
    }
    const variantIds = {} as Record<VariantKey, string>;
    let variantN = 100;
    for (const v of VARIANTS) {
      const created = await tx.productVariant.create({
        data: {
          id: fixtureId(variantN), productId: productIds[v.product as keyof typeof PRODUCTS], sku: `LOCALTEST-${v.key.replace('_', '-')}`, barcode: `LOCALTEST-BC-${v.key.replace('_', '-')}`,
          color: 'Negro', size: v.size, price: v.cash, cashPrice: v.cash, wholesalePrice: v.wholesale ?? null, costPrice: 4_000n, isActive: v.active ?? true,
        },
      });
      variantIds[v.key as VariantKey] = created.id; variantN += 1;
    }

    // 4. inventory + its INITIAL_STOCK ledger rows
    const inventories: Record<string, string> = {};
    let inventoryN = 200;
    let movementCount = 0;
    for (const v of VARIANTS) {
      for (const branchKey of BRANCH_KEYS) {
        const cell = STOCK[v.key as VariantKey][branchKey];
        if (!cell) continue;
        const inventory = await tx.inventory.create({ data: { id: fixtureId(inventoryN), variantId: variantIds[v.key as VariantKey], branchId: FIXTURE_BRANCHES[branchKey].id, physical: BigInt(cell[0]), reserved: BigInt(cell[1]) } });
        inventories[`${v.key}@${branchKey}`] = inventory.id; inventoryN += 1;
        if (cell[0] > 0) {
          await tx.stockMovement.create({ data: { inventoryId: inventory.id, type: 'INITIAL_STOCK', quantityDelta: BigInt(cell[0]), userId: FIXTURE_USERS.WAREHOUSE.id, branchId: FIXTURE_BRANCHES[branchKey].id } });
          movementCount += 1;
        }
      }
    }

    // 5. sales, as the real lifecycle leaves them
    const sales = {} as Record<SaleKey, SaleRef>;
    let saleN = 400;
    let itemN = 500;
    let reservationN = 700;
    let saleItems = 0;
    let reservations = 0;
    for (const [index, spec] of SALES.entries()) {
      const total = spec.items.reduce((sum, [, quantity, unitPrice]) => sum + quantity * unitPrice, 0n);
      const branch = FIXTURE_BRANCHES[spec.branch];
      const cashier = FIXTURE_USERS.CASHIER.id;
      const sale = await tx.sale.create({
        data: {
          id: fixtureId(saleN), saleNumber: `TEST-${String(index + 1).padStart(4, '0')}`, branchId: branch.id, sellerId: FIXTURE_USERS.SELLER.id, status: spec.status,
          priceMode: 'CASH', pricingMode: spec.wholesale ? 'WHOLESALE' : 'LIST', subtotal: total, discountTotal: 0n, total,
          ...(spec.wholesale ? { wholesaleAuthorizedAt: new Date('2026-01-01T00:00:00.000Z'), wholesaleConfirmedAt: new Date('2026-01-01T00:01:00.000Z'), wholesaleConfirmedById: cashier } : {}),
        },
      });
      saleN += 1;
      const itemIds: string[] = [];
      for (const [variantKey, quantity, unitPrice] of spec.items) {
        const variant = VARIANTS.find((candidate) => candidate.key === variantKey)!;
        const item = await tx.saleItem.create({
          data: {
            id: fixtureId(itemN), saleId: sale.id, variantId: variantIds[variantKey], productId: productIds[variant.product as keyof typeof PRODUCTS], productName: PRODUCTS[variant.product as keyof typeof PRODUCTS],
            variantName: `Negro / ${variant.size}`, sku: `LOCALTEST-${variantKey.replace('_', '-')}`, quantity, unitPrice, subtotal: quantity * unitPrice,
          },
        });
        itemN += 1; saleItems += 1; itemIds.push(item.id);
        const inventoryId = inventories[`${variantKey}@${spec.branch}`]!;
        if (spec.status === 'COMPLETED') {
          // the finalizer: physical consumed, one negative SALE movement per inventory
          await tx.stockMovement.create({ data: { inventoryId, type: 'SALE', quantityDelta: -quantity, saleId: sale.id, userId: cashier, branchId: branch.id } });
          await tx.inventory.update({ where: { id: inventoryId }, data: { physical: { decrement: quantity } } });
          movementCount += 1;
        }
        if (spec.reserve) {
          // PENDING_PAYMENT / PAID hold their stock through an ACTIVE reservation (the PENDING one is ALREADY inside ST_RES's [5, 5];
          // the PAID one adds its unit to A_M@S1's reserved counter)
          await tx.stockReservation.create({ data: { id: fixtureId(reservationN), saleId: sale.id, variantId: variantIds[variantKey], branchId: branch.id, quantity, expiresAt: new Date('2099-01-01T00:00:00.000Z'), status: 'ACTIVE' } });
          reservationN += 1; reservations += 1;
          if (spec.status === 'PAID') await tx.inventory.update({ where: { id: inventoryId }, data: { reserved: { increment: quantity } } });
        }
      }
      sales[spec.key] = { saleId: sale.id, itemIds };
    }

    // 6. the manifest the validation reads back (every number comes from the database, not from the tables above)
    const perBranch = {} as FixtureManifest['counts']['perBranch'];
    for (const key of BRANCH_KEYS) {
      const branchId = FIXTURE_BRANCHES[key].id;
      const rows = await tx.inventory.findMany({ where: { branchId } });
      perBranch[key] = {
        inventoryRows: rows.length, physicalUnits: rows.reduce((sum, row) => sum + row.physical, 0n), reservedUnits: rows.reduce((sum, row) => sum + row.reserved, 0n),
        sales: await tx.sale.count({ where: { branchId } }), completedSales: await tx.sale.count({ where: { branchId, status: 'COMPLETED' } }),
      };
    }
    return {
      branches: Object.fromEntries(BRANCH_KEYS.map((key) => [key, { branchId: FIXTURE_BRANCHES[key].id, locationId: FIXTURE_BRANCHES[key].id }])) as FixtureManifest['branches'],
      users: Object.fromEntries(USER_KEYS.map((key) => [key, FIXTURE_USERS[key].id])) as FixtureManifest['users'],
      variants: variantIds, inventories, sales,
      counts: { perBranch, users: USER_KEYS.length, variants: VARIANTS.length, products: Object.keys(PRODUCTS).length, sales: SALES.length, saleItems, stockMovements: movementCount, reservations },
    };
  }, { timeout: 120000 });
}

// Removes what this fixture added outside the tables the test harness truncates (Location rows survive truncateAllTables on purpose).
export async function removeSaleExchangeLocalTestLocations(db: PrismaClient): Promise<void> {
  await assertDisposableLocalTest(db);
  await db.location.deleteMany({ where: { code: { startsWith: FIXTURE_CODE_PREFIX } } });
}
