// Sale exchange v1 (G18) on REAL PostgreSQL — H4 of the independent audit, MEASURED, not assumed: does the DATABASE tie the exchange ledger
// (StockMovement SALE_EXCHANGE_IN / OUT) to Inventory.physical?
//
// The G18 deferred triggers prove the ledger is complete and well formed (an IN and an OUT per line, the line's magnitude, the right
// inventories and branch, the exchange actor). Nothing in G18 reads or writes Inventory.physical. This file pins what a RAW SQL writer (the
// service skipped) can do:
//   LB01 control      header + line + ledger + the CORRECT Inventory update          -> commits, ledger == physical delta
//   LB02 no update    header + line + ledger, Inventory.physical NOT touched          -> measured outcome below
//   LB03 wrong update header + line + ledger, Inventory.physical changed by the WRONG amounts -> measured outcome below
// The expectations written here ARE the measurements of PostgreSQL 17.11 on the G19 schema (characterization): if a future migration makes the
// database enforce the balance, LB02/LB03 flip to refused and these tests must be rewritten together with that decision (architecture A vs B,
// see docs/pilot-v1.1/21-g19-sale-exchange-rollout-runbook.md).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedDemo } from '../../prisma/seed.js';
import type { Prisma, PrismaClient } from '../../src/generated/prisma/client.js';
import { createTestPrismaClient, truncateAllTables } from '../helpers/test-db.js';

const PRICE = 1_000n;

describe('exchange ledger vs Inventory.physical at the database (PostgreSQL) — H4', () => {
  let db: PrismaClient;
  let userId: string;
  let branchId: string;
  let inventoryA: string;
  let inventoryR: string;
  let variantA: string;
  let variantR: string;
  const report: string[] = [];

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
  afterAll(async () => {
    console.log(`\nH4 measurements\n${report.join('\n')}\n`);
    await db?.$disconnect();
  }, 120000);

  async function completedSale() {
    const sale = await db.sale.create({ data: {
      sellerId: userId, branchId, status: 'COMPLETED', priceMode: 'CASH', pricingMode: 'LIST', subtotal: PRICE * 2n, discountTotal: 0n, total: PRICE * 2n,
    } });
    const { productId } = await db.productVariant.findUniqueOrThrow({ where: { id: variantA }, select: { productId: true } });
    const item = await db.saleItem.create({ data: {
      saleId: sale.id, variantId: variantA, productId, productName: 'P', variantName: 'V', sku: 'S', quantity: 2n, unitPrice: PRICE, subtotal: PRICE * 2n,
    } });
    await db.stockMovement.create({ data: { inventoryId: inventoryA, type: 'SALE', quantityDelta: -2n, saleId: sale.id, userId, branchId } });
    return { saleId: sale.id, itemId: item.id };
  }
  const writeLedger = async (tx: Prisma.TransactionClient, saleId: string, itemId: string) => {
    const exchangeId = randomUUID();
    const lineId = randomUUID();
    await tx.$executeRaw`INSERT INTO "SaleExchange"(id, "saleId", "branchId", "createdById", reason, "idempotencyKey", "requestHash")
      VALUES (${exchangeId}, ${saleId}, ${branchId}, ${userId}, 'Cambio de talle', ${randomUUID()}, ${'a'.repeat(64)})`;
    await tx.$executeRaw`INSERT INTO "SaleExchangeLine"(id, "saleExchangeId", "saleId", "branchId", "saleItemId", "replacementVariantId", "returnQuantity", "originalUnitPrice", "replacementUnitPrice")
      VALUES (${lineId}, ${exchangeId}, ${saleId}, ${branchId}, ${itemId}, ${variantR}, 1, ${PRICE}, ${PRICE})`;
    await tx.$executeRaw`INSERT INTO "StockMovement"(id, "inventoryId", type, "quantityDelta", "saleId", "userId", "branchId", "saleExchangeId", "saleExchangeLineId")
      VALUES (${randomUUID()}, ${inventoryA}, 'SALE_EXCHANGE_IN'::"StockMovementType", 1, ${saleId}, ${userId}, ${branchId}, ${exchangeId}, ${lineId})`;
    await tx.$executeRaw`INSERT INTO "StockMovement"(id, "inventoryId", type, "quantityDelta", "saleId", "userId", "branchId", "saleExchangeId", "saleExchangeLineId")
      VALUES (${randomUUID()}, ${inventoryR}, 'SALE_EXCHANGE_OUT'::"StockMovementType", -1, ${saleId}, ${userId}, ${branchId}, ${exchangeId}, ${lineId})`;
  };
  const physical = async (id: string) => (await db.inventory.findUniqueOrThrow({ where: { id } })).physical;
  // for each inventory: physical now vs physical before + the sum of ITS ledger rows of this exchange
  async function state(before: { a: bigint; r: bigint }) {
    const ledger = await db.$queryRaw<{ inventoryId: string; delta: bigint }[]>`SELECT "inventoryId", sum("quantityDelta")::bigint AS delta FROM "StockMovement" WHERE "saleExchangeId" IS NOT NULL GROUP BY 1`;
    const delta = (id: string) => ledger.find((row) => row.inventoryId === id)?.delta ?? 0n;
    const [a, r] = [await physical(inventoryA), await physical(inventoryR)];
    return { a, r, ledgerA: delta(inventoryA), ledgerR: delta(inventoryR), divergentA: a - before.a !== delta(inventoryA), divergentR: r - before.r !== delta(inventoryR) };
  }
  const note = (label: string, committed: boolean, s: Awaited<ReturnType<typeof state>>) => report.push(
    `${label.padEnd(28)} commit=${committed}  physicalA=${s.a} (ledger ${s.ledgerA}) physicalR=${s.r} (ledger ${s.ledgerR})  divergent: A=${s.divergentA} R=${s.divergentR}`,
  );

  it('LB01 control: ledger + the CORRECT Inventory update commit and agree', async () => {
    const { saleId, itemId } = await completedSale();
    const before = { a: await physical(inventoryA), r: await physical(inventoryR) };
    await db.$transaction(async (tx) => {
      await writeLedger(tx, saleId, itemId);
      await tx.$executeRaw`UPDATE "Inventory" SET physical = physical + 1 WHERE id = ${inventoryA}`;
      await tx.$executeRaw`UPDATE "Inventory" SET physical = physical - 1 WHERE id = ${inventoryR}`;
    });
    const s = await state(before);
    note('LB01 correct update', true, s);
    expect([s.divergentA, s.divergentR]).toEqual([false, false]);
  });

  it('LB02 H4: a complete header + line + ledger with Inventory.physical NOT touched COMMITS: the ledger and Inventory diverge', async () => {
    const { saleId, itemId } = await completedSale();
    const before = { a: await physical(inventoryA), r: await physical(inventoryR) };
    const error = await db.$transaction((tx) => writeLedger(tx, saleId, itemId)).then(() => null, (cause: unknown) => cause);
    const s = await state(before);
    note('LB02 no Inventory update', error === null, s);
    expect(error).toBeNull();
    expect([s.divergentA, s.divergentR]).toEqual([true, true]);
  });

  it('LB03 H4: a ledger with Inventory.physical changed by the WRONG amounts COMMITS too', async () => {
    const { saleId, itemId } = await completedSale();
    const before = { a: await physical(inventoryA), r: await physical(inventoryR) };
    const error = await db.$transaction(async (tx) => {
      await writeLedger(tx, saleId, itemId);
      await tx.$executeRaw`UPDATE "Inventory" SET physical = physical + 5 WHERE id = ${inventoryA}`;
      await tx.$executeRaw`UPDATE "Inventory" SET physical = physical - 3 WHERE id = ${inventoryR}`;
    }).then(() => null, (cause: unknown) => cause);
    const s = await state(before);
    note('LB03 wrong amounts (+5/-3)', error === null, s);
    expect(error).toBeNull();
    expect([s.divergentA, s.divergentR]).toEqual([true, true]);
  });
});
