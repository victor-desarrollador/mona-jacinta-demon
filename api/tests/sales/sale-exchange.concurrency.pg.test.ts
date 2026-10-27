// Sale exchange v1 — the REAL service on REAL PostgreSQL under concurrency, replay and BIGINT limits (third round of the second audit).
//   CR01/CR02 a reservation that changes `reserved` of the replacement WHILE the exchange validates it: the exchange waits for the row lock, retries under
//             Serializable (40001) and judges the COMMITTED availability (physical - reserved): 409 INSUFFICIENT_STOCK when the hold grew, success when it shrank
//   CR03      two different sales exchanging crossed inventories (A->B and B->A), repeatedly: the inventories are locked in ONE statement ordered by id, so no
//             deadlock survives; if PostgreSQL ever raises 40001/40P01 the service retries and both finish
//   CR04      two exchanges of DIFFERENT SaleItems of the SAME sale: serialized by the Sale lock, both commit, ONE SalePostSaleGuard row (EXCHANGE)
//   CR05      replay after the sale changed state and the stock moved: the stored exchange is returned with no repricing, no stock check and no write at all
//   CR06..    BIGINT: sums are never wrapped and never go through Number — an overflow of the aggregated demand or of the aggregated return is refused before
//             anything is persisted, while a sum landing EXACTLY on the limit is accepted
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedDemo } from '../../prisma/seed.js';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { AppError } from '../../src/shared/errors.js';
import { createSaleExchangeService } from '../../src/modules/sales/sale-exchange.service.js';
import { createTestPrismaClient, truncateAllTables } from '../helpers/test-db.js';

const MAX = 9223372036854775807n;

describe('sale exchange service — concurrency, replay and BIGINT limits (PostgreSQL)', () => {
  let db: PrismaClient;
  let userId: string;
  let branchId: string;
  let owner: Request;
  let variants: string[]; // [A, B, R, S]
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
    expect(inventories.length).toBe(4);
    variants = inventories.map((row) => row.variantId);
    inv = Object.fromEntries(inventories.map((row) => [row.variantId, row.id]));
    price = 10_000n;
    await db.productVariant.updateMany({ where: { id: { in: variants } }, data: { cashPrice: price, price } });
    await db.inventory.updateMany({ where: { id: { in: Object.values(inv) } }, data: { physical: 100n, reserved: 0n } });
    const assignments = [{ roleId: 'OWNER-company', roleCode: 'OWNER', scopeKind: 'COMPANY', locationId: null, permissions: [] }];
    owner = { auth: { userId, roles: ['OWNER'], assignments, effectiveLocationIds: [branchId] } } as unknown as Request;
  }, 120000);
  afterAll(async () => { await db?.$disconnect(); }, 120000);

  // A COMPLETED sale as the finalizer leaves it, for [variant, quantity, unitPrice] items; physical is consumed too (unless `consume` is false).
  async function completedSale(items: Array<[string, bigint]>, { unitPrice = price, consume = true }: { unitPrice?: bigint; consume?: boolean } = {}) {
    const total = 1n; // the sale total is irrelevant to the exchange (it never reads or writes it)
    const sale = await db.sale.create({ data: { sellerId: userId, branchId, status: 'COMPLETED', priceMode: 'CASH', pricingMode: 'LIST', subtotal: total, discountTotal: 0n, total } });
    const { productId } = await db.productVariant.findUniqueOrThrow({ where: { id: variants[0]! }, select: { productId: true } });
    const itemIds: string[] = [];
    for (const [variantId, quantity] of items) {
      const item = await db.saleItem.create({ data: { saleId: sale.id, variantId, productId, productName: 'P', variantName: 'V', sku: `${variantId}-${itemIds.length}`, quantity, unitPrice, subtotal: 1n } });
      itemIds.push(item.id);
      await db.stockMovement.create({ data: { inventoryId: inv[variantId]!, type: 'SALE', quantityDelta: -quantity, saleId: sale.id, userId, branchId } });
      if (consume) await db.inventory.update({ where: { id: inv[variantId]! }, data: { physical: { decrement: quantity } } });
    }
    return { saleId: sale.id, itemIds };
  }
  const service = () => createSaleExchangeService(db);
  const body = (lines: Array<{ saleItemId: string; replacementVariantId: string; returnQuantity: bigint }>, idempotencyKey = randomUUID()) => ({ reason: 'Cambio de talle', idempotencyKey, lines });
  const inventoryOf = async (variantId: string) => db.inventory.findUniqueOrThrow({ where: { id: inv[variantId]! } });
  const count = async (table: string, where = 'TRUE') => Number((await db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "${table}" WHERE ${where}`))[0]!.n);
  const settle = <T>(promise: Promise<T>) => promise.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
  async function waitForLockWait() {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const blocked = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM pg_stat_activity WHERE cardinality(pg_blocking_pids(pid)) > 0`;
      if (Number(blocked[0]!.n) > 0) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
  }
  // A concurrent writer of `reserved` (what a reservation does): holds the inventory row lock, changes `reserved`, and commits only when released.
  async function holdReservation(variantId: string, delta: bigint) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let locked!: () => void;
    const holding = new Promise<void>((resolve) => { locked = resolve; });
    const tx = db.$transaction(async (t) => {
      await t.$queryRaw`SELECT id FROM "Inventory" WHERE id = ${inv[variantId]!} FOR UPDATE`;
      await t.$executeRaw`UPDATE "Inventory" SET reserved = reserved + ${delta} WHERE id = ${inv[variantId]!}`;
      locked();
      await gate;
    }, { timeout: 60000 });
    await holding;
    return { release, done: tx };
  }

  it('CR01 a reservation that GROWS `reserved` of the replacement while the exchange waits -> the exchange retries and sees the committed hold: 409 INSUFFICIENT_STOCK, nothing persisted', async () => {
    const [A, , R] = variants as [string, string, string];
    await db.inventory.update({ where: { id: inv[R]! }, data: { physical: 5n, reserved: 0n } });
    const { saleId, itemIds } = await completedSale([[A, 3n]]);
    const before = { r: await inventoryOf(R), a: await inventoryOf(A) };
    const hold = await holdReservation(R, 4n); // available becomes 5 - 4 = 1 < 3
    const exchange = settle(service().exchangeSale(owner, saleId, body([{ saleItemId: itemIds[0]!, replacementVariantId: R, returnQuantity: 3n }])));
    expect(await waitForLockWait(), 'the exchange must be blocked on the inventory row lock').toBe(true);
    hold.release();
    await hold.done;
    const result = await exchange;
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.error).toBeInstanceOf(AppError);
    expect(result.ok ? null : { status: (result.error as AppError).status, code: (result.error as AppError).code }).toEqual({ status: 409, code: 'INSUFFICIENT_STOCK' });
    expect(await count('SaleExchange')).toBe(0);
    expect(await count('StockMovement', `"saleExchangeId" IS NOT NULL`)).toBe(0);
    expect(await count('SalePostSaleGuard')).toBe(0);
    const after = { r: await inventoryOf(R), a: await inventoryOf(A) };
    expect([after.r.physical, after.r.reserved]).toEqual([before.r.physical, 4n]); // only the reservation's own change
    expect(after.a.physical).toBe(before.a.physical);
  }, 90000);

  it('CR02 a reservation that SHRINKS `reserved` while the exchange waits -> the exchange retries and succeeds on the committed availability', async () => {
    const [A, , R] = variants as [string, string, string];
    await db.inventory.update({ where: { id: inv[R]! }, data: { physical: 5n, reserved: 4n } }); // available 1 < 3 right now
    const { saleId, itemIds } = await completedSale([[A, 3n]]);
    const hold = await holdReservation(R, -4n); // released: available becomes 5
    const exchange = settle(service().exchangeSale(owner, saleId, body([{ saleItemId: itemIds[0]!, replacementVariantId: R, returnQuantity: 3n }])));
    expect(await waitForLockWait()).toBe(true);
    hold.release();
    await hold.done;
    const result = await exchange;
    expect(result.ok, result.ok ? '' : String((result.error as Error).message)).toBe(true);
    const after = await inventoryOf(R);
    expect([after.physical, after.reserved]).toEqual([2n, 0n]);
    expect(await count('SaleExchange')).toBe(1);
  }, 90000);

  it('CR03 two different sales exchanging CROSSED inventories (A->B and B->A), 8 rounds in parallel: no permanent deadlock, every exchange commits, balances net to zero', async () => {
    const [A, B] = variants as [string, string];
    const outcomes: Array<{ ok: boolean; code?: string }> = [];
    for (let round = 0; round < 8; round += 1) {
      const s1 = await completedSale([[A, 1n]]);
      const s2 = await completedSale([[B, 1n]]);
      const results = await Promise.all([
        settle(service().exchangeSale(owner, s1.saleId, body([{ saleItemId: s1.itemIds[0]!, replacementVariantId: B, returnQuantity: 1n }]))),
        settle(service().exchangeSale(owner, s2.saleId, body([{ saleItemId: s2.itemIds[0]!, replacementVariantId: A, returnQuantity: 1n }]))),
      ]);
      for (const r of results) outcomes.push(r.ok ? { ok: true } : { ok: false, code: (r.error as { code?: string }).code });
    }
    // 40P01 is never what the caller sees; if PostgreSQL raised 40001/40P01 inside, the service retried, so every exchange finished
    expect(outcomes.filter((o) => !o.ok), JSON.stringify(outcomes)).toEqual([]);
    expect(await count('SaleExchange')).toBe(16);
    // each round: sale1 gives A back (+1) and takes B (-1); sale2 gives B back (+1) and takes A (-1): net 0 per round; the sales themselves consumed 1+1 per round
    expect((await inventoryOf(A)).physical).toBe(100n - 8n);
    expect((await inventoryOf(B)).physical).toBe(100n - 8n);
    const idle = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM pg_stat_activity WHERE state = 'idle in transaction'`;
    expect(Number(idle[0]!.n)).toBe(0);
  }, 180000);

  it('CR04 two exchanges of DIFFERENT SaleItems of the SAME sale, concurrently: serialized by the Sale lock, both commit, ONE SalePostSaleGuard EXCHANGE', async () => {
    const [A, B, R, S] = variants as [string, string, string, string];
    const { saleId, itemIds } = await completedSale([[A, 3n], [B, 2n]]);
    const results = await Promise.all([
      settle(service().exchangeSale(owner, saleId, body([{ saleItemId: itemIds[0]!, replacementVariantId: R, returnQuantity: 2n }]))),
      settle(service().exchangeSale(owner, saleId, body([{ saleItemId: itemIds[1]!, replacementVariantId: S, returnQuantity: 1n }]))),
    ]);
    expect(results.map((r) => r.ok), JSON.stringify(results.filter((r) => !r.ok).map((r) => (r as { error: unknown }).error))).toEqual([true, true]);
    expect(await count('SaleExchange', `"saleId" = '${saleId}'`)).toBe(2);
    expect(await count('SaleExchangeLine', `"saleId" = '${saleId}'`)).toBe(2);
    expect(await db.$queryRaw`SELECT "mode" FROM "SalePostSaleGuard" WHERE "saleId" = ${saleId}`).toEqual([{ mode: 'EXCHANGE' }]);
    // A: 100 - 3 + 2; B: 100 - 2 + 1; R: 100 - 2; S: 100 - 1
    expect([(await inventoryOf(A)).physical, (await inventoryOf(B)).physical, (await inventoryOf(R)).physical, (await inventoryOf(S)).physical]).toEqual([99n, 99n, 98n, 99n]);
  }, 120000);

  it('CR05 replay after the sale changed state AND the stock moved: the stored exchange comes back, with no repricing, no stock check and no write', async () => {
    const [A, , R] = variants as [string, string, string];
    const { saleId, itemIds } = await completedSale([[A, 3n]]);
    const request = body([{ saleItemId: itemIds[0]!, replacementVariantId: R, returnQuantity: 2n }]);
    const first = await service().exchangeSale(owner, saleId, request);
    expect(first.replayed).toBe(false);
    // a controlled change: the sale leaves COMPLETED, the replacement runs out and its price changes — a fresh exchange would now be refused three ways
    await db.$executeRaw`UPDATE "Sale" SET status = 'CANCELLED' WHERE id = ${saleId}`;
    await db.inventory.update({ where: { id: inv[R]! }, data: { physical: 0n } });
    await db.productVariant.update({ where: { id: variants[2]! }, data: { cashPrice: price * 2n, price: price * 2n } });
    const tables = async () => ({
      exchanges: await db.$queryRaw`SELECT * FROM "SaleExchange" ORDER BY id`, lines: await db.$queryRaw`SELECT * FROM "SaleExchangeLine" ORDER BY id`,
      movements: await db.$queryRaw`SELECT id, "inventoryId", type::text AS type, "quantityDelta" FROM "StockMovement" ORDER BY id`, audits: await count('AuditLog'),
      inventory: await db.$queryRaw`SELECT id, physical, reserved FROM "Inventory" ORDER BY id`, guard: await db.$queryRaw`SELECT * FROM "SalePostSaleGuard" ORDER BY "saleId"`,
    });
    const before = JSON.stringify(await tables(), (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
    const replay = await service().exchangeSale(owner, saleId, request);
    expect(replay).toEqual({ ...first, replayed: true, inventories: [] });
    expect(JSON.stringify(await tables(), (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).toBe(before);
    // a DIFFERENT intent under the same key is still a conflict, and a new key is now refused (the sale is no longer COMPLETED)
    const changed = await service().exchangeSale(owner, saleId, { ...request, lines: [{ ...request.lines[0]!, returnQuantity: 1n }] }).then(() => null, (e: unknown) => e);
    expect(changed).toMatchObject({ status: 409, code: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD' });
    const fresh = await service().exchangeSale(owner, saleId, body(request.lines)).then(() => null, (e: unknown) => e);
    expect(fresh).toMatchObject({ status: 409, code: 'INVALID_SALE_STATE' });
  }, 90000);

  it('CR06 BIGINT: two lines returning the SAME original variant whose individual quantities fit but whose SUM overflows the original inventory -> refused, nothing persisted, no wrap', async () => {
    const [A, , R] = variants as [string, string, string];
    await db.productVariant.updateMany({ where: { id: { in: variants } }, data: { cashPrice: 1n, price: 1n } });
    const { saleId, itemIds } = await completedSale([[A, 6n], [A, 6n]], { unitPrice: 1n });
    await db.inventory.update({ where: { id: inv[A]! }, data: { physical: MAX - 10n } }); // headroom 10: 6 fits, 6 + 6 = 12 does not
    const before = { a: (await inventoryOf(A)).physical, r: (await inventoryOf(R)).physical };
    const error = await service().exchangeSale(owner, saleId, body([
      { saleItemId: itemIds[0]!, replacementVariantId: R, returnQuantity: 6n }, { saleItemId: itemIds[1]!, replacementVariantId: R, returnQuantity: 6n },
    ])).then(() => null, (cause: unknown) => cause);
    expect(error).toMatchObject({ status: 409, code: 'SALE_EXCHANGE_STOCK_INCONSISTENT' });
    expect(await count('SaleExchange')).toBe(0);
    expect([(await inventoryOf(A)).physical, (await inventoryOf(R)).physical]).toEqual([before.a, before.r]);
    // 6 alone fits and lands strictly below the limit
    const ok = await service().exchangeSale(owner, saleId, body([{ saleItemId: itemIds[0]!, replacementVariantId: R, returnQuantity: 6n }]));
    expect(ok.replayed).toBe(false);
    expect((await inventoryOf(A)).physical).toBe(MAX - 4n);
  }, 90000);

  it('CR07 BIGINT: the aggregated DEMAND of two lines drawing the same replacement is 2^63 (> the signed maximum): refused as insufficient stock, never wrapped; a sum landing exactly on the maximum is accepted', async () => {
    const [A, B, R] = variants as [string, string, string];
    await db.productVariant.updateMany({ where: { id: { in: variants } }, data: { cashPrice: 1n, price: 1n } });
    const half = 2n ** 62n;
    const { saleId, itemIds } = await completedSale([[A, half], [B, half]], { unitPrice: 1n, consume: false });
    await db.inventory.updateMany({ where: { id: { in: [inv[A]!, inv[B]!] } }, data: { physical: 0n } });
    await db.inventory.update({ where: { id: inv[R]! }, data: { physical: MAX, reserved: 0n } });
    const before = (await inventoryOf(R)).physical;
    const refused = await service().exchangeSale(owner, saleId, body([
      { saleItemId: itemIds[0]!, replacementVariantId: R, returnQuantity: half }, { saleItemId: itemIds[1]!, replacementVariantId: R, returnQuantity: half },
    ])).then(() => null, (cause: unknown) => cause);
    expect(refused).toMatchObject({ status: 409, code: 'INSUFFICIENT_STOCK' }); // 2^62 + 2^62 = MAX + 1 > MAX available
    expect(await count('SaleExchange')).toBe(0);
    expect((await inventoryOf(R)).physical).toBe(before);
    // exactly the limit: 2^62 + (2^62 - 1) = MAX
    const exact = await service().exchangeSale(owner, saleId, body([
      { saleItemId: itemIds[0]!, replacementVariantId: R, returnQuantity: half }, { saleItemId: itemIds[1]!, replacementVariantId: R, returnQuantity: half - 1n },
    ]));
    expect(exact.replayed).toBe(false);
    expect((await inventoryOf(R)).physical).toBe(0n);
    expect((await inventoryOf(A)).physical).toBe(half);
    expect((await inventoryOf(B)).physical).toBe(half - 1n);
    expect(exact.inventories.find((row) => row.inventoryId === inv[R])).toMatchObject({ physical: 0n });
  }, 90000);
});
