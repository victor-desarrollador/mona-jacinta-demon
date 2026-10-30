// Sale exchange v1 — the Cambios read (GET /sales/exchangeable, sale-exchange-read.service.ts) on REAL PostgreSQL, next to the REAL exchange service.
//
// WHAT THIS ADDS over sale-exchange-read.http.test.ts (in-memory): the sold / exchanged / remaining arithmetic over real BIGINT columns
// (including a quantity above 2^53), several earlier exchanges summed by the database rows the service wrote, and the parity with
// POST /exchanges against the real constraints: the reported `remainingQuantity` is accepted, one more is refused.
//
// GUARDED: this file only runs when the suite is explicitly pointed at the disposable LOCAL_TEST database (MONA_TEST_DATABASE_TARGET=local,
// the CI `local-postgres` job). On the default hosted-TEST target it is SKIPPED (the exchange migrations are an OWNER-only gate there).
// Same harness as sale-exchange.service.pg.test.ts: createTestPrismaClient proves the database identity before anything is written.
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedDemo } from '../../prisma/seed.js';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { AppError } from '../../src/shared/errors.js';
import { createSaleExchangeService } from '../../src/modules/sales/sale-exchange.service.js';
import { createSaleExchangeReadService } from '../../src/modules/sales/sale-exchange-read.service.js';
import { createTestPrismaClient, truncateAllTables } from '../helpers/test-db.js';

const ON_LOCAL_TEST = process.env.MONA_TEST_DATABASE_TARGET === 'local';

describe.skipIf(!ON_LOCAL_TEST)('sale exchange read (PostgreSQL, LOCAL_TEST only)', () => {
  let db: PrismaClient;
  let userId: string;
  let branchId: string;
  let owner: Request;
  let cashier: Request;
  let variants: string[]; // [A, B, R, S] — R and S are replacements
  let inv: Record<string, string>;
  let price: bigint;
  let counter = 0;

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
    inv = Object.fromEntries(inventories.map((row) => [row.variantId, row.id]));
    price = 1n; // equal value everywhere; 1 centavo keeps a 2^53+ quantity inside BIGINT for subtotal and total
    await db.productVariant.updateMany({ where: { id: { in: variants } }, data: { cashPrice: price, price } });
    await db.inventory.updateMany({ where: { id: { in: Object.values(inv) } }, data: { physical: 100n, reserved: 0n } });
    owner = { auth: { userId, roles: ['OWNER'], assignments: [{ roleId: 'OWNER-company', roleCode: 'OWNER', scopeKind: 'COMPANY', locationId: null, permissions: [] }], effectiveLocationIds: [branchId] } } as unknown as Request;
    cashier = { auth: { userId, roles: ['CASHIER'], assignments: [{ roleId: 'CASHIER-loc', roleCode: 'CASHIER', scopeKind: 'LOCATION', locationId: branchId, permissions: ['SALE_CHARGE'] }], effectiveLocationIds: [branchId] } } as unknown as Request;
  }, 120000);
  afterAll(async () => { await db?.$disconnect(); }, 120000);

  // A COMPLETED sale as the finalizer leaves it for the arithmetic under test: its items and (for ordinary quantities) the SALE movements
  // and the consumed physical. `big` skips the stock side: only the SaleItem quantity matters to the read and to the remainder rule.
  async function completedSale(items: Array<[number, bigint]>, options: { big?: boolean; status?: 'COMPLETED' | 'PENDING_PAYMENT' } = {}) {
    counter += 1;
    const saleNumber = `PG-${counter}-${randomUUID().slice(0, 6)}`;
    const total = items.reduce((sum, [, quantity]) => sum + quantity * price, 0n);
    const sale = await db.sale.create({ data: {
      sellerId: userId, branchId, saleNumber, status: options.status ?? 'COMPLETED', priceMode: 'CASH', pricingMode: 'LIST', subtotal: total, discountTotal: 0n, total,
    } });
    const { productId } = await db.productVariant.findUniqueOrThrow({ where: { id: variants[0]! }, select: { productId: true } });
    const itemIds: string[] = [];
    for (const [index, quantity] of items) {
      const variantId = variants[index]!;
      const created = await db.saleItem.create({ data: {
        saleId: sale.id, variantId, productId, productName: 'P', variantName: 'V', sku: variantId, quantity, unitPrice: price, subtotal: price * quantity,
      } });
      itemIds.push(created.id);
      if (!options.big) {
        await db.stockMovement.create({ data: { inventoryId: inv[variantId]!, type: 'SALE', quantityDelta: -quantity, saleId: sale.id, userId, branchId } });
        await db.inventory.update({ where: { id: inv[variantId]! }, data: { physical: { decrement: quantity } } });
      }
    }
    return { saleId: sale.id, saleNumber, itemIds };
  }

  const reader = () => createSaleExchangeReadService(db);
  const writer = () => createSaleExchangeService(db);
  const read = (saleNumber: string, req: Request = owner) => reader().findExchangeableSale(req, { branchId, saleNumber });
  const exchange = (saleId: string, saleItemId: string, replacementVariantId: string, returnQuantity: bigint) =>
    writer().exchangeSale(owner, saleId, { reason: 'Cambio de talle', idempotencyKey: randomUUID(), lines: [{ saleItemId, replacementVariantId, returnQuantity }] });
  const settle = <T,>(promise: Promise<T>) => promise.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));

  it('RP01 with NO earlier exchange every line reports exchanged 0 and remaining = sold', async () => {
    const { saleNumber, itemIds } = await completedSale([[0, 3n], [1, 1n]]);
    const result = await read(saleNumber);
    expect(result.exchangeable).toBe(true);
    expect(result.lines.map((line) => [line.saleItemId, line.quantity, line.exchangedQuantity, line.remainingQuantity]))
      .toEqual(expect.arrayContaining([[itemIds[0], 3n, 0n, 3n], [itemIds[1], 1n, 0n, 1n]]));
  });

  it('RP02 with ONE earlier exchange the returned units leave the remainder, and only for that line', async () => {
    const { saleId, saleNumber, itemIds } = await completedSale([[0, 3n], [1, 1n]]);
    await exchange(saleId, itemIds[0]!, variants[2]!, 1n);
    const lines = new Map((await read(saleNumber)).lines.map((line) => [line.saleItemId, line]));
    expect(lines.get(itemIds[0]!)).toMatchObject({ quantity: 3n, exchangedQuantity: 1n, remainingQuantity: 2n });
    expect(lines.get(itemIds[1]!)).toMatchObject({ quantity: 1n, exchangedQuantity: 0n, remainingQuantity: 1n });
  });

  it('RP03 with TWO OR MORE earlier exchanges (different replacements) the remainder is the sold quantity minus all of them', async () => {
    const { saleId, saleNumber, itemIds } = await completedSale([[0, 5n]]);
    await exchange(saleId, itemIds[0]!, variants[2]!, 1n);
    await exchange(saleId, itemIds[0]!, variants[3]!, 2n);
    await exchange(saleId, itemIds[0]!, variants[2]!, 1n);
    const [line] = (await read(saleNumber)).lines;
    expect(line).toMatchObject({ quantity: 5n, exchangedQuantity: 4n, remainingQuantity: 1n });
  });

  it('RP04 a quantity above 2^53 is summed and subtracted exactly (BIGINT, never Number)', async () => {
    const sold = 9_007_199_254_740_993n; // 2^53 + 1
    const { saleId, saleNumber, itemIds } = await completedSale([[0, sold]], { big: true });
    await db.inventory.update({ where: { id: inv[variants[2]!]! }, data: { physical: sold + 100n } });
    await exchange(saleId, itemIds[0]!, variants[2]!, sold - 1n);
    const [line] = (await read(saleNumber)).lines;
    expect(line).toMatchObject({ quantity: sold, exchangedQuantity: sold - 1n, remainingQuantity: 1n });
  });

  it('RP05 parity with POST: remainingQuantity is accepted, remainingQuantity + 1 is refused with EXCHANGE_QUANTITY_EXCEEDED, and the line then reads 0', async () => {
    const { saleId, saleNumber, itemIds } = await completedSale([[0, 3n]]);
    await exchange(saleId, itemIds[0]!, variants[2]!, 1n);
    const remaining = (await read(saleNumber)).lines[0]!.remainingQuantity;
    expect(remaining).toBe(2n);

    const tooMany = await settle(exchange(saleId, itemIds[0]!, variants[3]!, remaining + 1n));
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) {
      expect(tooMany.error).toBeInstanceOf(AppError);
      expect((tooMany.error as AppError).code).toBe('EXCHANGE_QUANTITY_EXCEEDED');
    }
    // the refusal wrote nothing: the read is unchanged
    expect((await read(saleNumber)).lines[0]!.remainingQuantity).toBe(remaining);

    const exact = await settle(exchange(saleId, itemIds[0]!, variants[3]!, remaining));
    expect(exact.ok).toBe(true);
    expect((await read(saleNumber)).lines[0]).toMatchObject({ exchangedQuantity: 3n, remainingQuantity: 0n });
  });

  it('RP06 a sale that is not COMPLETED is reported exchangeable:false; an unknown number is 404; a non-supervisor is 403 before anything is read', async () => {
    const { saleNumber } = await completedSale([[0, 1n]], { big: true, status: 'PENDING_PAYMENT' });
    expect((await read(saleNumber)).exchangeable).toBe(false);

    const missing = await settle(read('NO-EXISTE'));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect((missing.error as AppError).status).toBe(404);

    const forbiddenExisting = await settle(read(saleNumber, cashier));
    const forbiddenMissing = await settle(read('NO-EXISTE', cashier));
    for (const outcome of [forbiddenExisting, forbiddenMissing]) {
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect((outcome.error as AppError).status).toBe(403);
    }
  });
});
