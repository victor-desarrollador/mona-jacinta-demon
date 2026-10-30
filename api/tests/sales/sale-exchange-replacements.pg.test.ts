// Sale exchange v1 — the replacement candidates (GET /sales/:saleId/exchange-replacements, sale-exchange-replacements.service.ts) on REAL PostgreSQL,
// next to the REAL exchange service.
//
// WHAT THIS ADDS over sale-exchange-replacements.http.test.ts (in-memory): the Prisma query itself (case-insensitive search, relation filters,
// relation ordering, skip / take / count, the per-branch Inventory select) against the real schema; BIGINT columns above 2^53 read back exactly; and the
// parity with POST /exchanges against the real constraints: what the preview calls EQUAL is accepted with the same price, CHEAPER / MORE_EXPENSIVE are
// refused with their codes.
//
// GUARDED: this file only runs when the suite is explicitly pointed at the disposable LOCAL_TEST database (MONA_TEST_DATABASE_TARGET=local, the CI
// `local-postgres` job). On the default hosted-TEST target it is SKIPPED (the exchange migrations are an OWNER-only gate there).
// Same harness as sale-exchange-read.pg.test.ts: createTestPrismaClient proves the database identity before anything is written.
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedDemo } from '../../prisma/seed.js';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { createSaleExchangeService } from '../../src/modules/sales/sale-exchange.service.js';
import { createSaleExchangeReplacementsService } from '../../src/modules/sales/sale-exchange-replacements.service.js';
import { createTestPrismaClient, truncateAllTables } from '../helpers/test-db.js';

const ON_LOCAL_TEST = process.env.MONA_TEST_DATABASE_TARGET === 'local';

describe.skipIf(!ON_LOCAL_TEST)('sale exchange replacements (PostgreSQL, LOCAL_TEST only)', () => {
  let db: PrismaClient;
  let userId: string;
  let branchId: string;
  let owner: Request;
  let variants: string[]; // [A, B, C, D]: A is sold; B equal, C cheaper, D more expensive
  let counter = 0;
  const P = 10000n;

  beforeAll(async () => { db = await createTestPrismaClient(); }, 120000);
  beforeEach(async () => {
    await truncateAllTables(db);
    await seedDemo(db);
    const [cashierUser, branch] = await Promise.all([
      db.user.findUniqueOrThrow({ where: { email: 'cashier01@demo.local' } }),
      db.branch.findUniqueOrThrow({ where: { code: 'CEN' } }),
    ]);
    userId = cashierUser.id; branchId = branch.id;
    const inventories = await db.inventory.findMany({ where: { branchId }, orderBy: { id: 'asc' }, take: 4 });
    expect(inventories.length, 'the demo seed must provide at least 4 inventories in CEN').toBe(4);
    variants = inventories.map((row) => row.variantId);
    const shape: Array<[string, bigint, string, string]> = [['PGX-A', P, 'Negro', 'M'], ['PGX-B', P, 'Negro', 'L'], ['PGX-C', P - 100n, 'Rojo', 'M'], ['PGX-D', P + 100n, 'Azul', 'M']];
    for (const [index, [sku, cashPrice, color, size]] of shape.entries()) {
      await db.productVariant.update({ where: { id: variants[index]! }, data: { sku, barcode: `BC-${sku}`, cashPrice, price: cashPrice, wholesalePrice: null, color, size, isActive: true } });
    }
    await db.inventory.updateMany({ where: { id: { in: inventories.map((row) => row.id) } }, data: { physical: 100n, reserved: 0n } });
    owner = { auth: { userId, roles: ['OWNER'], assignments: [{ roleId: 'OWNER-company', roleCode: 'OWNER', scopeKind: 'COMPANY', locationId: null, permissions: [] }], effectiveLocationIds: [branchId] } } as unknown as Request;
  }, 120000);
  afterAll(async () => { await db?.$disconnect(); }, 120000);

  async function completedSale() {
    counter += 1;
    const sale = await db.sale.create({ data: {
      sellerId: userId, branchId, saleNumber: `PGR-${counter}-${randomUUID().slice(0, 6)}`, status: 'COMPLETED', priceMode: 'CASH', pricingMode: 'LIST',
      subtotal: P, discountTotal: 0n, total: P,
    } });
    const { productId } = await db.productVariant.findUniqueOrThrow({ where: { id: variants[0]! }, select: { productId: true } });
    const item = await db.saleItem.create({ data: {
      saleId: sale.id, variantId: variants[0]!, productId, productName: 'P', variantName: 'V', sku: variants[0]!, quantity: 1n, unitPrice: P, subtotal: P,
    } });
    return { saleId: sale.id, saleItemId: item.id };
  }

  const reader = () => createSaleExchangeReplacementsService(db);
  const writer = () => createSaleExchangeService(db);
  const find = async (query: Record<string, unknown> = {}) => {
    const { saleId, saleItemId } = await completedSale();
    return reader().findReplacements(owner, saleId, { branchId, saleItemId, search: 'PGX-', ...query });
  };

  it('PGR01 search is case-insensitive over sku / barcode / color / size, and the sold variant is never offered', async () => {
    const all = await find();
    expect(all.items.map((item) => item.sku).sort()).toEqual(['PGX-B', 'PGX-C', 'PGX-D']);
    expect((await find({ search: 'pgx-c' })).items.map((item) => item.sku)).toEqual(['PGX-C']);
    expect((await find({ search: 'bc-pgx-d' })).items.map((item) => item.sku)).toEqual(['PGX-D']);
    expect((await find({ search: 'rojo' })).items.map((item) => item.sku)).toEqual(['PGX-C']);
    expect((await find({ search: 'PGX-', page: 1, limit: 1 })).pagination).toEqual({ page: 1, limit: 1, total: 3 });
  });

  it('PGR02 pagination walks the filtered set once: pages are disjoint and cover every candidate', async () => {
    const { saleId, saleItemId } = await completedSale();
    const pages = await Promise.all([1, 2, 3].map((page) => reader().findReplacements(owner, saleId, { branchId, saleItemId, search: 'PGX-', page, limit: 1 })));
    const seen = pages.flatMap((page) => page.items.map((item) => item.sku));
    expect(new Set(seen).size).toBe(3);
    expect(pages.every((page) => page.pagination.total === 3)).toBe(true);
  });

  it('PGR03 inactive variant, inactive product and a variant without cashPrice are not offered', async () => {
    await db.productVariant.update({ where: { id: variants[1]! }, data: { isActive: false } });
    const { productId } = await db.productVariant.findUniqueOrThrow({ where: { id: variants[2]! }, select: { productId: true } });
    await db.product.update({ where: { id: productId }, data: { isActive: false } });
    expect((await find()).items.map((item) => item.sku)).not.toContain('PGX-B');
    expect((await find()).items.map((item) => item.sku)).not.toContain('PGX-C');
    await db.product.update({ where: { id: productId }, data: { isActive: true } });
    await db.productVariant.update({ where: { id: variants[3]! }, data: { cashPrice: null } });
    expect((await find()).items.map((item) => item.sku)).not.toContain('PGX-D');
  });

  it('PGR04 available = physical - reserved of the sale branch, and a variant with no Inventory row is "0"', async () => {
    await db.inventory.updateMany({ where: { branchId, variantId: variants[1]! }, data: { physical: 10n, reserved: 3n } });
    await db.inventory.deleteMany({ where: { branchId, variantId: variants[2]! } });
    const result = await find();
    const byId = new Map(result.items.map((item) => [item.id, item]));
    expect(byId.get(variants[1]!)?.available).toBe(7n);
    expect(byId.get(variants[2]!)).toMatchObject({ available: 0n });
    expect(byId.get(variants[3]!)?.available).toBe(100n);
  });

  it('PGR05 BIGINT columns above 2^53 come back exactly (price and stock)', async () => {
    const huge = 9007199254740993n;
    await db.productVariant.update({ where: { id: variants[1]! }, data: { cashPrice: huge } });
    await db.inventory.updateMany({ where: { branchId, variantId: variants[1]! }, data: { physical: huge + 2n, reserved: 2n } });
    const candidate = (await find()).items.find((item) => item.id === variants[1]!)!;
    expect(candidate.replacementUnitPrice).toBe(huge);
    expect(candidate.available).toBe(huge);
    expect(candidate.comparison).toBe('MORE_EXPENSIVE');
  });

  it('PGR06 PARITY with the real exchange service: EQUAL is accepted with the previewed price, CHEAPER / MORE_EXPENSIVE are refused with their codes', async () => {
    const expected: Record<string, string> = { 'PGX-B': 'ok', 'PGX-C': 'REPLACEMENT_CHEAPER_NOT_SUPPORTED', 'PGX-D': 'REPLACEMENT_MORE_EXPENSIVE_NOT_SUPPORTED' };
    for (const [sku, outcome] of Object.entries(expected)) {
      const { saleId, saleItemId } = await completedSale();
      const preview = (await reader().findReplacements(owner, saleId, { branchId, saleItemId, search: sku })).items[0]!;
      const attempt = writer().exchangeSale(owner, saleId, {
        reason: 'Cambio', idempotencyKey: randomUUID(), lines: [{ saleItemId, replacementVariantId: preview.id, returnQuantity: 1n }],
      });
      if (outcome === 'ok') {
        const done = await attempt;
        expect(done.lines[0]!.replacementUnitPrice).toBe(preview.replacementUnitPrice);
        expect(preview.comparison).toBe('EQUAL');
      } else {
        await expect(attempt).rejects.toMatchObject({ code: outcome });
      }
    }
  });

  it('PGR07 it writes nothing: no exchange, movement, audit row or inventory change', async () => {
    const counts = async () => ({
      exchanges: await db.saleExchange.count(), movements: await db.stockMovement.count(), audits: await db.auditLog.count(),
      stock: JSON.stringify((await db.inventory.findMany({ orderBy: { id: 'asc' }, select: { id: true, physical: true, reserved: true } })).map((row) => [row.id, String(row.physical), String(row.reserved)])),
    });
    const { saleId, saleItemId } = await completedSale();
    const before = await counts();
    await reader().findReplacements(owner, saleId, { branchId, saleItemId });
    expect(await counts()).toEqual(before);
  });
});
