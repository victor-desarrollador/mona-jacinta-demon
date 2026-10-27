// Sale exchange v1 — the REAL service on REAL PostgreSQL (G17 + G18 + G19 + G20 applied): stock, ledger, deferred triggers, idempotency,
// Serializable retries and the races that the in-memory behavior contract cannot model.
//
// Needs a database carrying the exchange migrations (LOCAL_TEST in CI; hosted TEST is an OWNER-only gate); run on a disposable PostgreSQL 17.11 LOCAL_TEST. Same harness as sale-exchange.pg.test.ts: createTestPrismaClient() proves the test database; fixtures are the minimum
// rows the finalizer would leave (a COMPLETED sale, its items, its SALE movements), built with Prisma; every assertion about stock reads
// the database back.
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedDemo } from '../../prisma/seed.js';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { AppError } from '../../src/shared/errors.js';
import { createSaleExchangeService } from '../../src/modules/sales/sale-exchange.service.js';
import { createSaleVoidService } from '../../src/modules/sales/sale-void.service.js';
import { createTestPrismaClient, truncateAllTables } from '../helpers/test-db.js';

describe('sale exchange service (PostgreSQL)', () => {
  let db: PrismaClient;
  let userId: string;
  let branchId: string;
  let owner: Request;
  let variants: string[]; // [A, B, R, S] — R and S are replacements
  let inv: Record<string, string>;
  let price: bigint;

  beforeAll(async () => { db = await createTestPrismaClient(); }, 120000);
  beforeEach(async () => {
    await truncateAllTables(db);
    await seedDemo(db);
    const [cashier, branch] = await Promise.all([
      db.user.findUniqueOrThrow({ where: { email: 'cashier01@demo.local' } }),
      db.branch.findUniqueOrThrow({ where: { code: 'CEN' } }),
    ]);
    userId = cashier.id; branchId = branch.id;
    const inventories = await db.inventory.findMany({ where: { branchId }, orderBy: { id: 'asc' }, take: 4 });
    expect(inventories.length, 'the demo seed must provide at least 4 inventories in CEN').toBe(4);
    variants = inventories.map((row) => row.variantId);
    inv = Object.fromEntries(inventories.map((row) => [row.variantId, row.id]));
    // equal value: one price for the four variants (the replacement is priced with the sale's own context: LIST/CASH, 0 bps)
    price = 10_000n;
    await db.productVariant.updateMany({ where: { id: { in: variants } }, data: { cashPrice: price, price } });
    await db.inventory.updateMany({ where: { id: { in: Object.values(inv) } }, data: { physical: 100n, reserved: 0n } });
    const assignments = [{ roleId: 'OWNER-company', roleCode: 'OWNER', scopeKind: 'COMPANY', locationId: null, permissions: [] }];
    owner = { auth: { userId, roles: ['OWNER'], assignments, effectiveLocationIds: [branchId] } } as unknown as Request;
  }, 120000);
  afterAll(async () => { await db?.$disconnect(); }, 120000);

  // A COMPLETED sale as the finalizer leaves it: items [A x3, B x1], one negative SALE movement per inventory, physical consumed.
  async function completedSale() {
    const sale = await db.sale.create({ data: {
      sellerId: userId, branchId, status: 'COMPLETED', priceMode: 'CASH', pricingMode: 'LIST', subtotal: price * 4n, discountTotal: 0n, total: price * 4n,
    } });
    const { productId } = await db.productVariant.findUniqueOrThrow({ where: { id: variants[0]! }, select: { productId: true } });
    const item = (variantId: string, quantity: bigint) => db.saleItem.create({ data: {
      saleId: sale.id, variantId, productId, productName: 'P', variantName: 'V', sku: variantId, quantity, unitPrice: price, subtotal: price * quantity,
    } });
    const a = await item(variants[0]!, 3n);
    const b = await item(variants[1]!, 1n);
    for (const [it, q] of [[a, 3n], [b, 1n]] as const) {
      await db.stockMovement.create({ data: { inventoryId: inv[it.variantId]!, type: 'SALE', quantityDelta: -q, saleId: sale.id, userId, branchId } });
      await db.inventory.update({ where: { id: inv[it.variantId]! }, data: { physical: { decrement: q } } });
    }
    return { saleId: sale.id, itemA: a.id, itemB: b.id };
  }
  const service = () => createSaleExchangeService(db);
  const body = (lines: Array<{ saleItemId: string; replacementVariantId: string; returnQuantity: bigint }>, idempotencyKey = randomUUID()) => ({ reason: 'Cambio de talle', idempotencyKey, lines });
  const physical = async (variantId: string) => (await db.inventory.findUniqueOrThrow({ where: { id: inv[variantId]! } })).physical;
  const count = async (table: string) => Number((await db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "${table}"`))[0]!.n);
  async function settle<T>(promise: Promise<T>) {
    return promise.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
  }

  it('XP01 a complete exchange: stock +N / -N, one IN and one OUT per line, audit, and the deferred DB guards accept it at COMMIT', async () => {
    const { saleId, itemA } = await completedSale();
    const [a0, r0] = [await physical(variants[0]!), await physical(variants[2]!)];
    const result = await service().exchangeSale(owner, saleId, body([{ saleItemId: itemA, replacementVariantId: variants[2]!, returnQuantity: 2n }]));
    expect(result).toMatchObject({ saleId, branchId, replayed: false });
    expect(await physical(variants[0]!)).toBe(a0 + 2n);
    expect(await physical(variants[2]!)).toBe(r0 - 2n);
    expect(await db.stockMovement.count({ where: { type: 'SALE_EXCHANGE_IN', saleExchangeId: result.exchangeId, quantityDelta: 2n } })).toBe(1);
    expect(await db.stockMovement.count({ where: { type: 'SALE_EXCHANGE_OUT', saleExchangeId: result.exchangeId, quantityDelta: -2n } })).toBe(1);
    expect(await db.auditLog.count({ where: { action: 'SALE_EXCHANGED', entityId: saleId } })).toBe(1);
    expect((await db.sale.findUniqueOrThrow({ where: { id: saleId } })).status).toBe('COMPLETED');
    expect(await count('CashMovement')).toBe(0);
  });

  it('XP01b the returned `inventories` snapshot (used for realtime) equals the COMMITTED Inventory rows: one entry per Inventory, final physical and reserved', async () => {
    const { saleId, itemA } = await completedSale();
    const result = await service().exchangeSale(owner, saleId, body([{ saleItemId: itemA, replacementVariantId: variants[2]!, returnQuantity: 1n }]));
    expect(result.inventories).toHaveLength(2);
    const rows = await db.inventory.findMany({ where: { id: { in: result.inventories.map((row) => row.inventoryId) } } });
    expect([...result.inventories].sort((a, b) => a.inventoryId.localeCompare(b.inventoryId)))
      .toEqual(rows.map((row) => ({ inventoryId: row.id, variantId: row.variantId, physical: row.physical, reserved: row.reserved })).sort((a, b) => a.inventoryId.localeCompare(b.inventoryId)));
  });

  it('XP02 the same key replays: same answer, no second row, no second movement, even after the stock changed', async () => {
    const { saleId, itemA } = await completedSale();
    const request = body([{ saleItemId: itemA, replacementVariantId: variants[2]!, returnQuantity: 1n }]);
    const first = await service().exchangeSale(owner, saleId, request);
    await db.inventory.update({ where: { id: inv[variants[2]!]! }, data: { physical: 0n } });
    const replay = await service().exchangeSale(owner, saleId, request);
    expect(replay).toEqual({ ...first, replayed: true, inventories: [] });
    expect(await count('SaleExchange')).toBe(1);
    expect(await db.stockMovement.count({ where: { type: { in: ['SALE_EXCHANGE_IN', 'SALE_EXCHANGE_OUT'] } } })).toBe(2);
  });

  it('XP03 two concurrent exchanges racing for the last units of one SaleItem: exactly one wins, the other is EXCHANGE_QUANTITY_EXCEEDED, the total never exceeds what was sold', async () => {
    const { saleId, itemA } = await completedSale(); // A x3
    const attempt = (replacement: string) => settle(service().exchangeSale(owner, saleId, body([{ saleItemId: itemA, replacementVariantId: replacement, returnQuantity: 2n }])));
    const [x, y] = await Promise.all([attempt(variants[2]!), attempt(variants[3]!)]);
    const wins = [x, y].filter((r) => r.ok);
    const losses = [x, y].filter((r) => !r.ok);
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(1);
    expect((losses[0] as { error: unknown }).error).toBeInstanceOf(AppError);
    expect((losses[0] as { error: AppError }).error.code).toBe('EXCHANGE_QUANTITY_EXCEEDED');
    const total = await db.$queryRaw<{ s: bigint }[]>`SELECT sum("returnQuantity")::bigint AS s FROM "SaleExchangeLine" WHERE "saleItemId" = ${itemA}`;
    expect(total[0]!.s).toBe(2n);
  }, 60000);

  it('XP04 two concurrent exchanges drawing the last unit of a replacement: exactly one wins, stock is never negative', async () => {
    const one = await completedSale();
    const two = await completedSale();
    await db.inventory.update({ where: { id: inv[variants[2]!]! }, data: { physical: 1n, reserved: 0n } });
    const attempt = (sale: { saleId: string; itemA: string }) => settle(service().exchangeSale(owner, sale.saleId, body([{ saleItemId: sale.itemA, replacementVariantId: variants[2]!, returnQuantity: 1n }])));
    const [x, y] = await Promise.all([attempt(one), attempt(two)]);
    expect([x, y].filter((r) => r.ok)).toHaveLength(1);
    const loss = [x, y].find((r) => !r.ok) as { error: AppError };
    expect(loss.error.code).toBe('INSUFFICIENT_STOCK');
    expect(await physical(variants[2]!)).toBe(0n);
  }, 60000);

  it('XP05 SaleVoid and SaleExchange exclude each other through the services: an exchanged sale cannot be voided, a voided sale cannot be exchanged', async () => {
    const exchanged = await completedSale();
    await service().exchangeSale(owner, exchanged.saleId, body([{ saleItemId: exchanged.itemA, replacementVariantId: variants[2]!, returnQuantity: 1n }]));
    await expect(createSaleVoidService(db).voidSale(owner, exchanged.saleId, { reason: 'error', idempotencyKey: randomUUID() })).rejects.toMatchObject({ status: 409, code: 'SALE_HAS_EXCHANGES' });
    const voided = await completedSale();
    await createSaleVoidService(db).voidSale(owner, voided.saleId, { reason: 'error', idempotencyKey: randomUUID() });
    await expect(service().exchangeSale(owner, voided.saleId, body([{ saleItemId: voided.itemA, replacementVariantId: variants[2]!, returnQuantity: 1n }])))
      .rejects.toMatchObject({ status: 409, code: 'INVALID_SALE_STATE' });
  });

  it('XP06 a refused exchange writes nothing at all (price, remainder, unknown item): the database is byte-for-byte the same', async () => {
    const { saleId, itemA } = await completedSale();
    const snapshot = async () => ({
      inventories: await db.inventory.findMany({ orderBy: { id: 'asc' } }), movements: await db.stockMovement.count(), exchanges: await count('SaleExchange'), audits: await db.auditLog.count(),
    });
    const before = await snapshot();
    await db.productVariant.update({ where: { id: variants[2]! }, data: { cashPrice: price + 1n, price: price + 1n } });
    await expect(service().exchangeSale(owner, saleId, body([{ saleItemId: itemA, replacementVariantId: variants[2]!, returnQuantity: 1n }]))).rejects.toMatchObject({ code: 'REPLACEMENT_MORE_EXPENSIVE_NOT_SUPPORTED' });
    await expect(service().exchangeSale(owner, saleId, body([{ saleItemId: itemA, replacementVariantId: variants[3]!, returnQuantity: 4n }]))).rejects.toMatchObject({ code: 'EXCHANGE_QUANTITY_EXCEEDED' });
    await expect(service().exchangeSale(owner, saleId, body([{ saleItemId: randomUUID(), replacementVariantId: variants[3]!, returnQuantity: 1n }]))).rejects.toMatchObject({ code: 'SALE_ITEM_MISMATCH' });
    expect(await snapshot()).toEqual(before);
  });
});
