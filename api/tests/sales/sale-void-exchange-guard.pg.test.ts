// Sale void v1 + exchange v1 — G19 on REAL PostgreSQL: a sale with an exchange cannot be voided.
//
// Needs a database carrying G17 + G18 + G19 (+ G20, which adds the central claim: sale-post-sale-guard.pg.test.ts); LOCAL_TEST in CI, hosted TEST is
// an OWNER-only gate; run on a disposable PostgreSQL 17.11 LOCAL_TEST. Same harness as sale-exchange.pg.test.ts: createTestPrismaClient() proves the test database,
// every fixture row is raw SQL so nothing but the database decides, and the SQLSTATE of each refusal is asserted.
//   - exchange exists + a SaleVoid inserted DIRECTLY (service skipped)        -> 23514, nothing stored
//   - exchange exists + the sale-void SERVICE                                  -> 409 SALE_HAS_EXCHANGES, no effect at all
//   - a sale WITHOUT exchanges still voids, directly and through the service  -> unchanged behaviour
//   - the exclusion is SYMMETRIC: a SaleVoid that already exists -> a direct SaleExchange insert is refused (even when Sale.status was
//     never updated), in both directions and in both race orders
//   - an exchange of ANOTHER sale does not block; re-pointing a void is guarded too
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedDemo } from '../../prisma/seed.js';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { AppError } from '../../src/shared/errors.js';
import { createSaleVoidService } from '../../src/modules/sales/sale-void.service.js';
import { createTestPrismaClient, truncateAllTables } from '../helpers/test-db.js';

const CHECK = '23514';
const PRICE = 1_000n;

function sqlState(error: unknown): string {
  const e = error as {
    code?: string; message?: string;
    meta?: { code?: string; driverAdapterError?: { cause?: { originalCode?: string } } };
    // a trigger/constraint refusal raised at COMMIT (deferred) surfaces as a DriverAdapterError whose `cause` carries the SQLSTATE
    cause?: { originalCode?: string; code?: string };
  };
  const original = e.meta?.driverAdapterError?.cause?.originalCode ?? e.cause?.originalCode ?? e.meta?.code;
  if (typeof original === 'string' && /^[0-9A-Z]{5}$/.test(original)) return original;
  const fromMessage = /\b(2[0-9]{4})\b/.exec(e.message ?? '');
  return fromMessage ? fromMessage[1]! : `UNKNOWN(${e.code ?? 'no-code'})`;
}
async function refused(promise: Promise<unknown>) {
  const error = await promise.then(() => null, (cause: unknown) => cause);
  expect(error, 'the database must refuse this').not.toBeNull();
  return error;
}

describe('sale void exchange guard (PostgreSQL)', () => {
  let db: PrismaClient;
  let userId: string;
  let branchId: string;
  let inventoryA: string;
  let inventoryR: string;
  let variantA: string;
  let variantR: string;
  let owner: Request;

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
    const assignments = [{ roleId: 'OWNER-company', roleCode: 'OWNER', scopeKind: 'COMPANY', locationId: null, permissions: [] }];
    owner = { auth: { userId, roles: ['OWNER'], assignments, effectiveLocationIds: [branchId] } } as unknown as Request;
  }, 120000);
  afterAll(async () => { await db?.$disconnect(); }, 120000);

  // A COMPLETED sale as the finalizer leaves it: one item, one negative SALE movement on the item's inventory.
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

  // One complete exchange (header, line, IN on the original inventory, OUT on the replacement) in one transaction.
  const exchange = (saleId: string, itemId: string) => db.$transaction(async (tx) => {
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
  });
  const insertVoid = (saleId: string) => db.$executeRaw`INSERT INTO "SaleVoid"(id, "saleId", "branchId", "previousStatus", reason, "idempotencyKey", "voidedById")
    VALUES (${randomUUID()}, ${saleId}, ${branchId}, 'COMPLETED', 'error', ${randomUUID()}, ${userId})`;
  const count = async (table: string) => Number((await db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "${table}"`))[0]!.n);
  const physical = async (inventoryId: string) => (await db.inventory.findUniqueOrThrow({ where: { id: inventoryId } })).physical;

  it('GP01 a SaleVoid inserted DIRECTLY for a sale with an exchange is refused (23514) and nothing is stored', async () => {
    const { saleId, itemId } = await completedSale();
    await exchange(saleId, itemId);
    const error = await refused(insertVoid(saleId));
    expect(sqlState(error)).toBe(CHECK);
    expect(String((error as Error).message)).toContain('chk_sale_void_has_exchanges');
    expect(await count('SaleVoid')).toBe(0);
  });

  it('GP02 the sale-void SERVICE on a sale with an exchange -> 409 SALE_HAS_EXCHANGES and no effect at all', async () => {
    const { saleId, itemId } = await completedSale();
    await exchange(saleId, itemId);
    const before = { a: await physical(inventoryA), r: await physical(inventoryR), movements: await count('StockMovement'), audits: await count('AuditLog'), cash: await count('CashMovement') };
    const error = await refused(createSaleVoidService(db).voidSale(owner, saleId, { reason: 'error', idempotencyKey: randomUUID() }));
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ status: 409, code: 'SALE_HAS_EXCHANGES' });
    expect({ a: await physical(inventoryA), r: await physical(inventoryR), movements: await count('StockMovement'), audits: await count('AuditLog'), cash: await count('CashMovement') }).toEqual(before);
    expect(await count('SaleVoid')).toBe(0);
    expect((await db.sale.findUniqueOrThrow({ where: { id: saleId } })).status).toBe('COMPLETED');
  });

  it('GP03 a sale WITHOUT exchanges voids normally through the service: stock comes back from the SALE movement, one SaleVoid, CANCELLED', async () => {
    const { saleId } = await completedSale();
    const before = await physical(inventoryA);
    const result = await createSaleVoidService(db).voidSale(owner, saleId, { reason: 'error', idempotencyKey: randomUUID() });
    expect(result).toMatchObject({ saleId, status: 'CANCELLED', previousStatus: 'COMPLETED', replayed: false });
    expect(await physical(inventoryA)).toBe(before + 2n);
    expect(await count('SaleVoid')).toBe(1);
    expect((await db.sale.findUniqueOrThrow({ where: { id: saleId } })).status).toBe('CANCELLED');
  });

  it('GP04 a direct SaleVoid insert for a sale WITHOUT exchanges is accepted (the guard is exchange-only)', async () => {
    const { saleId } = await completedSale();
    await insertVoid(saleId);
    expect(await count('SaleVoid')).toBe(1);
  });

  it('GP05 an exchange of ANOTHER sale does not block this one', async () => {
    const a = await completedSale();
    const b = await completedSale();
    await exchange(b.saleId, b.itemId);
    await insertVoid(a.saleId);
    expect(await count('SaleVoid')).toBe(1);
  });

  it('GP06 a SaleVoid cannot be re-pointed (UPDATE OF saleId) to a sale that has an exchange (23514)', async () => {
    const a = await completedSale();
    const b = await completedSale();
    await exchange(b.saleId, b.itemId);
    await insertVoid(a.saleId);
    expect(sqlState(await refused(db.$executeRaw`UPDATE "SaleVoid" SET "saleId" = ${b.saleId} WHERE "saleId" = ${a.saleId}`))).toBe(CHECK);
  });

  it('GP07 an exchange in flight blocks the void until it commits, and the void is then refused (Sale lock first)', async () => {
    const { saleId, itemId } = await completedSale();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const holding = new Promise<void>((resolve) => { started = resolve; });
    const holder = db.$transaction(async (tx) => {
      const exchangeId = randomUUID();
      const lineId = randomUUID();
      await tx.$executeRaw`INSERT INTO "SaleExchange"(id, "saleId", "branchId", "createdById", reason, "idempotencyKey", "requestHash")
        VALUES (${exchangeId}, ${saleId}, ${branchId}, ${userId}, 'x', ${randomUUID()}, ${'a'.repeat(64)})`;
      await tx.$executeRaw`INSERT INTO "SaleExchangeLine"(id, "saleExchangeId", "saleId", "branchId", "saleItemId", "replacementVariantId", "returnQuantity", "originalUnitPrice", "replacementUnitPrice")
        VALUES (${lineId}, ${exchangeId}, ${saleId}, ${branchId}, ${itemId}, ${variantR}, 1, ${PRICE}, ${PRICE})`;
      await tx.$executeRaw`INSERT INTO "StockMovement"(id, "inventoryId", type, "quantityDelta", "saleId", "userId", "branchId", "saleExchangeId", "saleExchangeLineId")
        VALUES (${randomUUID()}, ${inventoryA}, 'SALE_EXCHANGE_IN'::"StockMovementType", 1, ${saleId}, ${userId}, ${branchId}, ${exchangeId}, ${lineId})`;
      await tx.$executeRaw`INSERT INTO "StockMovement"(id, "inventoryId", type, "quantityDelta", "saleId", "userId", "branchId", "saleExchangeId", "saleExchangeLineId")
        VALUES (${randomUUID()}, ${inventoryR}, 'SALE_EXCHANGE_OUT'::"StockMovementType", -1, ${saleId}, ${userId}, ${branchId}, ${exchangeId}, ${lineId})`;
      started();
      await gate;
    }, { timeout: 30000 });
    await holding;
    const waiter = db.$transaction((tx) => tx.$executeRaw`INSERT INTO "SaleVoid"(id, "saleId", "branchId", "previousStatus", reason, "idempotencyKey", "voidedById")
      VALUES (${randomUUID()}, ${saleId}, ${branchId}, 'COMPLETED', 'error', ${randomUUID()}, ${userId})`, { timeout: 30000 });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const blocked = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM pg_stat_activity WHERE cardinality(pg_blocking_pids(pid)) > 0`;
      if (Number(blocked[0]!.n) > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    release();
    await holder;
    expect(sqlState(await refused(waiter))).toBe(CHECK);
    expect(await count('SaleVoid')).toBe(0);
    expect(await count('SaleExchange')).toBe(1);
  }, 60000);

  // ---- the other direction: a voided sale cannot be exchanged (G19 symmetric guard) -------------------------------------------

  // The attempt: header + line + the two ledger rows in one transaction (the ledger is complete so only the void guard can refuse it).
  const exchangeAttempt = (saleId: string, itemId: string) => exchange(saleId, itemId);

  it('GP08 a SaleVoid that already exists -> a DIRECT SaleExchange insert is refused (23514) even though Sale.status is still COMPLETED', async () => {
    const { saleId, itemId } = await completedSale();
    await insertVoid(saleId); // raw writer: the sale is NOT cancelled
    expect((await db.sale.findUniqueOrThrow({ where: { id: saleId } })).status).toBe('COMPLETED');
    const error = await refused(exchangeAttempt(saleId, itemId));
    expect(sqlState(error)).toBe(CHECK);
    // since G20 the claim trigger (trg_sale_exchange_post_sale_claim) fires before the G19 guard, so either guard may be the one that names the refusal
    expect(String((error as Error).message)).toMatch(/chk_sale_(exchange_has_void|post_sale_guard)/);
    expect(await count('SaleExchange')).toBe(0);
    expect(await count('SaleExchangeLine')).toBe(0);
  });

  it('GP09 the same through the real void service: a voided sale (CANCELLED) is refused by the exchange guards, nothing is stored', async () => {
    const { saleId, itemId } = await completedSale();
    await createSaleVoidService(db).voidSale(owner, saleId, { reason: 'error', idempotencyKey: randomUUID() });
    expect(sqlState(await refused(exchangeAttempt(saleId, itemId)))).toBe(CHECK);
    expect(await count('SaleExchange')).toBe(0);
  });

  it('GP10 a voided sale of ANOTHER sale does not block this exchange; a sale without a void exchanges normally', async () => {
    const a = await completedSale();
    const b = await completedSale();
    await insertVoid(b.saleId);
    await exchange(a.saleId, a.itemId);
    expect(await count('SaleExchange')).toBe(1);
  });

  it('GP11 mutual exclusion in BOTH orders on the same sale: whichever came first wins, the other is refused, never both', async () => {
    const first = await completedSale();
    await exchange(first.saleId, first.itemId);
    expect(sqlState(await refused(insertVoid(first.saleId)))).toBe(CHECK);
    const second = await completedSale();
    await insertVoid(second.saleId);
    expect(sqlState(await refused(exchangeAttempt(second.saleId, second.itemId)))).toBe(CHECK);
    const both = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "SaleVoid" v JOIN "SaleExchange" x ON x."saleId" = v."saleId"`;
    expect(Number(both[0]!.n)).toBe(0);
  });

  it('GP12 a void in flight blocks an exchange until it commits (Sale lock first), and the exchange is then refused', async () => {
    const { saleId, itemId } = await completedSale();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const holding = new Promise<void>((resolve) => { started = resolve; });
    const holder = db.$transaction(async (tx) => {
      await tx.$executeRaw`INSERT INTO "SaleVoid"(id, "saleId", "branchId", "previousStatus", reason, "idempotencyKey", "voidedById")
        VALUES (${randomUUID()}, ${saleId}, ${branchId}, 'COMPLETED', 'error', ${randomUUID()}, ${userId})`;
      started();
      await gate;
    }, { timeout: 30000 });
    await holding;
    const waiter = exchangeAttempt(saleId, itemId);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const blocked = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM pg_stat_activity WHERE cardinality(pg_blocking_pids(pid)) > 0`;
      if (Number(blocked[0]!.n) > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    release();
    await holder;
    expect(sqlState(await refused(waiter))).toBe(CHECK);
    expect(await count('SaleVoid')).toBe(1);
    expect(await count('SaleExchange')).toBe(0);
  }, 60000);
});
