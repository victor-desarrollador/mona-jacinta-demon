// RED for the CI failure of tests/rbac/seed-integration.test.ts after the sale exchange merge: resetDemo() must be able to wipe a database that
// still holds post-sale history (SaleVoid, SaleExchange + its ledger, SalePostSaleGuard) left by an earlier test file. It cannot today:
// prisma/seed.ts clear() deletes row by row, and
//   - the exchange ledger rows of StockMovement are append-only (G18: trg_sale_exchange_append_only refuses DELETE -> P2039 / 23514),
//   - SaleVoid / SaleExchange / SalePostSaleGuard reference Sale with ON DELETE RESTRICT (-> P2003 / 23503 on sale.deleteMany()).
// Whether seed-integration fails depends only on WHICH test file ran before it, so this test pins the behaviour independently of file order.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDemo, seedDemo } from '../../prisma/seed.js';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { createTestPrismaClient, truncateAllTables } from '../helpers/test-db.js';

describe('resetDemo over leftover post-sale history (PostgreSQL)', () => {
  let db: PrismaClient;
  let userId: string;
  let branchId: string;
  let inventoryA: string;
  let inventoryR: string;
  let variantA: string;
  let variantR: string;
  const PRICE = 1_000n;

  beforeAll(async () => { db = await createTestPrismaClient(); }, 120000);
  beforeEach(async () => {
    await truncateAllTables(db);
    await seedDemo(db);
    const [cashier, branch] = await Promise.all([
      db.user.findUniqueOrThrow({ where: { email: 'cashier01@demo.local' } }),
      db.branch.findUniqueOrThrow({ where: { code: 'CEN' } }),
    ]);
    userId = cashier.id; branchId = branch.id;
    const inventories = await db.inventory.findMany({ where: { branchId }, orderBy: { id: 'asc' }, take: 2 });
    [inventoryA, inventoryR] = inventories.map((row) => row.id) as [string, string];
    [variantA, variantR] = inventories.map((row) => row.variantId) as [string, string];
  }, 120000);
  afterAll(async () => { await db?.$disconnect(); }, 120000);

  async function completedSale() {
    const sale = await db.sale.create({ data: { sellerId: userId, branchId, status: 'COMPLETED', priceMode: 'CASH', pricingMode: 'LIST', subtotal: PRICE * 2n, discountTotal: 0n, total: PRICE * 2n } });
    const { productId } = await db.productVariant.findUniqueOrThrow({ where: { id: variantA }, select: { productId: true } });
    const item = await db.saleItem.create({ data: { saleId: sale.id, variantId: variantA, productId, productName: 'P', variantName: 'V', sku: 'S', quantity: 2n, unitPrice: PRICE, subtotal: PRICE * 2n } });
    await db.stockMovement.create({ data: { inventoryId: inventoryA, type: 'SALE', quantityDelta: -2n, saleId: sale.id, userId, branchId } });
    return { saleId: sale.id, itemId: item.id };
  }
  const rows = async (table: string) => Number((await db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "${table}"`))[0]!.n);
  const everythingGone = async () => {
    for (const table of ['Sale', 'SaleItem', 'StockMovement', 'SaleVoid', 'SaleVoidExternalRefund', 'SaleExchange', 'SaleExchangeLine', 'SalePostSaleGuard']) expect(await rows(table), table).toBe(0);
  };

  it('RS01 a leftover SaleVoid (and its SalePostSaleGuard claim) does not stop resetDemo', async () => {
    const { saleId } = await completedSale();
    await db.$executeRaw`INSERT INTO "SaleVoid"(id, "saleId", "branchId", "previousStatus", reason, "idempotencyKey", "voidedById")
      VALUES (${randomUUID()}, ${saleId}, ${branchId}, 'COMPLETED', 'error', ${randomUUID()}, ${userId})`;
    expect(await rows('SalePostSaleGuard')).toBe(1);
    await resetDemo(db);
    await everythingGone();
  }, 120000);

  it('RS02 a leftover SaleExchange with its append-only ledger does not stop resetDemo', async () => {
    const { saleId, itemId } = await completedSale();
    await db.$transaction(async (tx) => {
      const exchangeId = randomUUID();
      const lineId = randomUUID();
      await tx.$executeRaw`INSERT INTO "SaleExchange"(id, "saleId", "branchId", "createdById", reason, "idempotencyKey", "requestHash")
        VALUES (${exchangeId}, ${saleId}, ${branchId}, ${userId}, 'Cambio', ${randomUUID()}, ${'a'.repeat(64)})`;
      await tx.$executeRaw`INSERT INTO "SaleExchangeLine"(id, "saleExchangeId", "saleId", "branchId", "saleItemId", "replacementVariantId", "returnQuantity", "originalUnitPrice", "replacementUnitPrice")
        VALUES (${lineId}, ${exchangeId}, ${saleId}, ${branchId}, ${itemId}, ${variantR}, 1, ${PRICE}, ${PRICE})`;
      await tx.$executeRaw`INSERT INTO "StockMovement"(id, "inventoryId", type, "quantityDelta", "saleId", "userId", "branchId", "saleExchangeId", "saleExchangeLineId")
        VALUES (${randomUUID()}, ${inventoryA}, 'SALE_EXCHANGE_IN'::"StockMovementType", 1, ${saleId}, ${userId}, ${branchId}, ${exchangeId}, ${lineId})`;
      await tx.$executeRaw`INSERT INTO "StockMovement"(id, "inventoryId", type, "quantityDelta", "saleId", "userId", "branchId", "saleExchangeId", "saleExchangeLineId")
        VALUES (${randomUUID()}, ${inventoryR}, 'SALE_EXCHANGE_OUT'::"StockMovementType", -1, ${saleId}, ${userId}, ${branchId}, ${exchangeId}, ${lineId})`;
    });
    expect(await rows('SaleExchange')).toBe(1);
    await resetDemo(db);
    await everythingGone();
  }, 120000);

  it('RS03 after the reset the demo is restored (catalog and inventories present), a second reset over the restored demo works, and the append-only guard is still in force', async () => {
    const { saleId, itemId } = await completedSale();
    await db.$executeRaw`INSERT INTO "SaleVoid"(id, "saleId", "branchId", "previousStatus", reason, "idempotencyKey", "voidedById")
      VALUES (${randomUUID()}, ${saleId}, ${branchId}, 'COMPLETED', 'error', ${randomUUID()}, ${userId})`;
    expect(itemId).toBeTruthy();
    await resetDemo(db);
    await everythingGone();
    expect(await rows('Inventory')).toBeGreaterThan(0);
    expect(await rows('Permission')).toBeGreaterThanOrEqual(38);
    await resetDemo(db); // idempotent over a clean demo
    await everythingGone();
    // the guard is not weakened: a row-level DELETE of an exchange ledger row is still refused (the reset truncates, it never bypasses the trigger)
    const triggers = await db.$queryRaw<{ enabled: string }[]>`SELECT tgenabled::text AS enabled FROM pg_trigger WHERE tgname = 'trg_stock_movement_sale_exchange_no_delete'`;
    expect(triggers.map((t) => t.enabled)).toEqual(['O']);
  }, 120000);

  it('RS04 the truncation is TRANSACTIONAL: when the seed fails after clear(), nothing is lost — the leftover history is still there and the real error surfaces', async () => {
    const { saleId } = await completedSale();
    await db.$executeRaw`INSERT INTO "SaleVoid"(id, "saleId", "branchId", "previousStatus", reason, "idempotencyKey", "voidedById")
      VALUES (${randomUUID()}, ${saleId}, ${branchId}, 'COMPLETED', 'error', ${randomUUID()}, ${userId})`;
    const failing = {
      $transaction: <T>(action: (tx: never) => Promise<T>, options: { maxWait: number; timeout: number }) => db.$transaction((tx) => action(new Proxy(tx, {
        get: (target, property, receiver) => (property === 'permission'
          ? new Proxy(target.permission, { get: (delegate, method) => (method === 'upsert' ? () => Promise.reject(new Error('INJECTED_AFTER_CLEAR')) : Reflect.get(delegate, method)) })
          : Reflect.get(target, property, receiver)),
      }) as never), options),
    };
    await expect(resetDemo(failing as never)).rejects.toThrow('INJECTED_AFTER_CLEAR');
    expect(await rows('SaleVoid')).toBe(1);
    expect(await rows('SalePostSaleGuard')).toBe(1);
    expect(await rows('Sale')).toBe(1);
    expect(await rows('Inventory')).toBeGreaterThan(0); // the rest of clear() rolled back too
  }, 120000);
});
