// Sale exchange v1 — RED contract on REAL PostgreSQL: what G18 (sale_exchange_schema) must enforce by itself.
//
// They were written RED first (the migrations did not exist) and now pass on a disposable PostgreSQL 17.11 LOCAL_TEST carrying
// 20261026120000_sale_exchange_enum / 20261026130000_sale_exchange_schema; in CI they run against the disposable LOCAL_TEST database
// (hosted TEST is an OWNER-only gate).
//
// Standard destructive integration test (same harness as sale-refund-db-guard.pg.test.ts): createTestPrismaClient()
// proves the marker-proven test database; every statement below is RAW SQL so that nothing but the database decides,
// and the SQLSTATE of every refusal is asserted. Deferred guards (ledger / lines / remainder) fire at COMMIT, so a
// refusal is asserted on the whole $transaction.
//
// What the database owns (this file): shape CHECKs, composite FKs (no cross sale / branch / exchange links), the
// equal-value CHECK, one IN + one OUT per line with the right magnitude, inventory and branch, the remainder of a
// SaleItem, "sale is COMPLETED", idempotency uniqueness, RESTRICT, append-only history.
// What stays with the service (sale-exchange.behavior.test.ts): authorization, availability (physical - reserved),
// the current price of the replacement, that Inventory.physical really moves, retries, audit.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedDemo } from '../../prisma/seed.js';
import type { Prisma, PrismaClient } from '../../src/generated/prisma/client.js';
import { createTestPrismaClient, truncateAllTables } from '../helpers/test-db.js';

const CHECK = '23514';
const FK = '23503';
const UNIQUE = '23505';
const HASH = 'a'.repeat(64);
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
  return sqlState(error);
}

type LineSpec = {
  lineId?: string; saleItemId: string; replacementVariantId: string; quantity?: bigint; originalPrice?: bigint; replacementPrice?: bigint;
  // the ledger of the line: undefined = the correct one
  inInventoryId?: string; outInventoryId?: string; inDelta?: bigint; outDelta?: bigint; skipIn?: boolean; skipOut?: boolean;
};
type ExchangeSpec = {
  exchangeId?: string; saleId?: string; branchId?: string; idempotencyKey?: string; reason?: string; requestHash?: string; lines: LineSpec[]; userId?: string;
};

describe('sale exchange v1 — database guards (PostgreSQL)', () => {
  let db: PrismaClient;
  let userId: string;
  let branchId: string;
  let otherBranchId: string;
  let saleId: string;
  let itemA: string; // variant A, quantity 3
  let itemB: string; // variant B, quantity 1
  let variantA: string;
  let variantB: string;
  let variantR: string; // replacement
  let inv: { A: string; B: string; R: string; ROther: string };

  beforeAll(async () => {
    db = await createTestPrismaClient();
  }, 120000);

  beforeEach(async () => {
    await truncateAllTables(db);
    await seedDemo(db);
    const [cashier, branch, other] = await Promise.all([
      db.user.findUniqueOrThrow({ where: { email: 'cashier01@demo.local' } }),
      db.branch.findUniqueOrThrow({ where: { code: 'CEN' } }),
      db.branch.findFirstOrThrow({ where: { code: { not: 'CEN' } }, orderBy: { code: 'asc' } }),
    ]);
    userId = cashier.id; branchId = branch.id; otherBranchId = other.id;
    const inventories = await db.inventory.findMany({ where: { branchId }, orderBy: { id: 'asc' }, take: 3 });
    expect(inventories.length, 'the demo seed must provide at least 3 inventories in CEN').toBe(3);
    [variantA, variantB, variantR] = inventories.map((row) => row.variantId) as [string, string, string];
    const rOther = await db.inventory.upsert({
      where: { variantId_branchId: { variantId: variantR, branchId: otherBranchId } }, update: {}, create: { variantId: variantR, branchId: otherBranchId, physical: 100n },
    });
    inv = { A: inventories[0]!.id, B: inventories[1]!.id, R: inventories[2]!.id, ROther: rOther.id };
    ({ saleId, itemA, itemB } = await completedSale());
  }, 120000);

  afterAll(async () => {
    await db?.$disconnect();
  }, 120000);

  async function completedSale(status: 'COMPLETED' | 'PAID' | 'CANCELLED' = 'COMPLETED') {
    const sale = await db.sale.create({ data: {
      sellerId: userId, branchId, status, priceMode: 'CASH', pricingMode: 'LIST', subtotal: PRICE * 4n, discountTotal: 0n, total: PRICE * 4n,
    } });
    const product = await db.productVariant.findUniqueOrThrow({ where: { id: variantA }, select: { productId: true } });
    const item = (variantId: string, quantity: bigint) => db.saleItem.create({ data: {
      saleId: sale.id, variantId, productId: product.productId, productName: 'P', variantName: 'V', sku: variantId, quantity, unitPrice: PRICE, subtotal: PRICE * quantity,
    } });
    return { saleId: sale.id, itemA: (await item(variantA, 3n)).id, itemB: (await item(variantB, 1n)).id };
  }

  // Writes header + lines + ledger inside ONE transaction, exactly as the service will.
  async function write(tx: Prisma.TransactionClient, spec: ExchangeSpec) {
    const exchangeId = spec.exchangeId ?? randomUUID();
    const sale = spec.saleId ?? saleId;
    const branch = spec.branchId ?? branchId;
    await tx.$executeRaw`INSERT INTO "SaleExchange"(id, "saleId", "branchId", "createdById", reason, "idempotencyKey", "requestHash")
      VALUES (${exchangeId}, ${sale}, ${branch}, ${spec.userId ?? userId}, ${spec.reason ?? 'Cambio de talle'}, ${spec.idempotencyKey ?? randomUUID()}, ${spec.requestHash ?? HASH})`;
    for (const line of spec.lines) {
      const lineId = line.lineId ?? randomUUID();
      const quantity = line.quantity ?? 1n;
      await tx.$executeRaw`INSERT INTO "SaleExchangeLine"(id, "saleExchangeId", "saleId", "branchId", "saleItemId", "replacementVariantId", "returnQuantity", "originalUnitPrice", "replacementUnitPrice")
        VALUES (${lineId}, ${exchangeId}, ${sale}, ${branch}, ${line.saleItemId}, ${line.replacementVariantId}, ${quantity}, ${line.originalPrice ?? PRICE}, ${line.replacementPrice ?? PRICE})`;
      const originalInventory = line.saleItemId === itemA ? inv.A : inv.B;
      if (!line.skipIn) await movement(tx, 'SALE_EXCHANGE_IN', line.inInventoryId ?? originalInventory, line.inDelta ?? quantity, { exchangeId, lineId, sale, branch });
      if (!line.skipOut) await movement(tx, 'SALE_EXCHANGE_OUT', line.outInventoryId ?? inv.R, line.outDelta ?? -quantity, { exchangeId, lineId, sale, branch });
    }
    return exchangeId;
  }
  const movement = (tx: Prisma.TransactionClient, type: string, inventoryId: string, delta: bigint, at: { exchangeId: string | null; lineId: string | null; sale: string | null; branch: string }) =>
    tx.$executeRaw`INSERT INTO "StockMovement"(id, "inventoryId", type, "quantityDelta", "saleId", "userId", "branchId", "saleExchangeId", "saleExchangeLineId")
      VALUES (${randomUUID()}, ${inventoryId}, ${type}::"StockMovementType", ${delta}, ${at.sale}, ${userId}, ${at.branch}, ${at.exchangeId}, ${at.lineId})`;
  const exchange = (spec: ExchangeSpec) => db.$transaction((tx) => write(tx, spec));
  const line = (over: Partial<LineSpec> = {}): LineSpec => ({ saleItemId: itemA, replacementVariantId: variantR, ...over });
  const count = async (table: string) => Number((await db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "${table}"`))[0]!.n);

  // ---- the accepted path ---------------------------------------------------------------------------------------------

  it('PX01 a complete exchange (header, line, one IN, one OUT) commits; a two-line exchange too', async () => {
    await exchange({ lines: [line()] });
    await exchange({ lines: [line({ saleItemId: itemA }), line({ saleItemId: itemB, replacementVariantId: variantR })] });
    expect(await count('SaleExchange')).toBe(2);
    expect(await count('SaleExchangeLine')).toBe(3);
    expect(await db.stockMovement.count({ where: { type: 'SALE_EXCHANGE_IN' } })).toBe(3);
    expect(await db.stockMovement.count({ where: { type: 'SALE_EXCHANGE_OUT' } })).toBe(3);
  });

  // ---- ledger integrity (deferred, at COMMIT) ------------------------------------------------------------------------

  it('PX02 a header without lines is refused at commit (23514)', async () => {
    expect(await refused(exchange({ lines: [] }))).toBe(CHECK);
    expect(await count('SaleExchange')).toBe(0);
  });

  it.each([['skipIn'], ['skipOut']] as const)('PX03 a line missing its ledger (%s) is refused at commit (23514) and nothing is stored', async (which) => {
    expect(await refused(exchange({ lines: [line({ [which]: true })] }))).toBe(CHECK);
    expect(await count('SaleExchange')).toBe(0);
    expect(await count('SaleExchangeLine')).toBe(0);
  });

  it('PX04 an IN or OUT whose magnitude differs from returnQuantity is refused at commit (23514)', async () => {
    expect(await refused(exchange({ lines: [line({ quantity: 1n, inDelta: 2n })] }))).toBe(CHECK);
    expect(await refused(exchange({ lines: [line({ quantity: 2n, outDelta: -1n })] }))).toBe(CHECK);
  });

  it('PX05 the IN must be on the inventory of the ORIGINAL variant and the OUT on the REPLACEMENT variant, in the line branch (23514)', async () => {
    expect(await refused(exchange({ lines: [line({ inInventoryId: inv.R })] }))).toBe(CHECK); // IN on the replacement
    expect(await refused(exchange({ lines: [line({ outInventoryId: inv.A })] }))).toBe(CHECK); // OUT on the original
    expect(await refused(exchange({ lines: [line({ outInventoryId: inv.ROther })] }))).toBe(CHECK); // right variant, WRONG branch
    expect(await count('SaleExchange')).toBe(0);
  });

  it('PX06 the movements carry the exchange actor (23514 when another user wrote them)', async () => {
    const other = await db.user.findFirstOrThrow({ where: { id: { not: userId } } });
    expect(await refused(db.$transaction(async (tx) => {
      const exchangeId = await write(tx, { lines: [line({ skipIn: true })] });
      const lineId = (await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "SaleExchangeLine" WHERE "saleExchangeId" = ${exchangeId}`)[0]!.id;
      await tx.$executeRaw`INSERT INTO "StockMovement"(id, "inventoryId", type, "quantityDelta", "saleId", "userId", "branchId", "saleExchangeId", "saleExchangeLineId")
        VALUES (${randomUUID()}, ${inv.A}, 'SALE_EXCHANGE_IN'::"StockMovementType", 1, ${saleId}, ${other.id}, ${branchId}, ${exchangeId}, ${lineId})`;
    }))).toBe(CHECK);
  });

  // ---- shape CHECKs and composite FKs ----------------------------------------------------------------------------------

  it('PX07 IN must be positive and OUT negative (23514)', async () => {
    expect(await refused(exchange({ lines: [line({ inDelta: -1n })] }))).toBe(CHECK);
    expect(await refused(exchange({ lines: [line({ outDelta: 1n })] }))).toBe(CHECK);
  });

  it('PX08 a second IN (or OUT) for the same line is refused by UNIQUE(line, type) (23505)', async () => {
    expect(await refused(db.$transaction(async (tx) => {
      const exchangeId = await write(tx, { lines: [line()] });
      const lineRow = (await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "SaleExchangeLine" WHERE "saleExchangeId" = ${exchangeId}`)[0]!.id;
      await movement(tx, 'SALE_EXCHANGE_IN', inv.A, 1n, { exchangeId, lineId: lineRow, sale: saleId, branch: branchId });
    }))).toBe(UNIQUE);
  });

  it('PX09 an exchange movement without its exchange / line / sale, or a normal movement carrying them, is refused (23514)', async () => {
    const bare = (type: string, exchangeId: string | null, lineId: string | null, sale: string | null, delta: bigint) =>
      db.$transaction((tx) => movement(tx, type, inv.A, delta, { exchangeId, lineId, sale, branch: branchId }));
    expect(await refused(bare('SALE_EXCHANGE_IN', null, null, saleId, 1n))).toBe(CHECK);
    expect(await refused(bare('SALE_EXCHANGE_IN', randomUUID(), null, saleId, 1n))).toBe(CHECK);
    expect(await refused(bare('SALE_EXCHANGE_OUT', randomUUID(), randomUUID(), null, -1n))).toBe(CHECK);
    expect(await refused(bare('INITIAL_STOCK', randomUUID(), randomUUID(), saleId, 1n))).toBe(CHECK);
  });

  it('PX10 a movement cannot point to a line of ANOTHER sale or ANOTHER branch (composite FK, 23503)', async () => {
    const other = await completedSale();
    // The line is written WITHOUT its IN, so the offending IN is the only one and the composite FK (not the unique index) is what refuses it.
    const attempt = (sale: string, branch: string, inventoryId: string) => db.$transaction(async (tx) => {
      const exchangeId = await write(tx, { lines: [line({ skipIn: true })] });
      const lineId = (await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "SaleExchangeLine" WHERE "saleExchangeId" = ${exchangeId}`)[0]!.id;
      await movement(tx, 'SALE_EXCHANGE_IN', inventoryId, 1n, { exchangeId, lineId, sale, branch });
    });
    expect(await refused(attempt(other.saleId, branchId, inv.A))).toBe(FK); // another SALE
    expect(await refused(attempt(saleId, otherBranchId, inv.ROther))).toBe(FK); // another BRANCH
    expect(await count('SaleExchange')).toBe(0);
  });

  it('PX11 a line cannot use a saleItem of ANOTHER sale, an unknown variant, or a header of another sale/branch (23503)', async () => {
    const other = await completedSale();
    expect(await refused(exchange({ lines: [line({ saleItemId: other.itemA })] }))).toBe(FK);
    expect(await refused(exchange({ lines: [line({ replacementVariantId: randomUUID() })] }))).toBe(FK);
    expect(await refused(exchange({ branchId: otherBranchId, lines: [line()] }))).toBe(FK); // the sale lives in CEN
  });

  it('PX12 equal value is a CHECK: different prices, zero prices and non-positive quantity are refused (23514)', async () => {
    expect(await refused(exchange({ lines: [line({ replacementPrice: PRICE + 1n })] }))).toBe(CHECK);
    expect(await refused(exchange({ lines: [line({ replacementPrice: PRICE - 1n })] }))).toBe(CHECK);
    expect(await refused(exchange({ lines: [line({ originalPrice: 0n, replacementPrice: 0n })] }))).toBe(CHECK);
    expect(await refused(exchange({ lines: [line({ quantity: 0n, inDelta: 1n, outDelta: -1n })] }))).toBe(CHECK);
    expect(await refused(exchange({ lines: [line({ quantity: -1n, inDelta: 1n, outDelta: -1n })] }))).toBe(CHECK);
  });

  it('PX13 header text CHECKs: reason (blank, padded, > 200), key (not a UUID v4), hash (not 64 lowercase hex) are refused (23514)', async () => {
    for (const reason of ['', '   ', ' x', 'x ', 'x'.repeat(201)]) expect(await refused(exchange({ reason, lines: [line()] })), JSON.stringify(reason)).toBe(CHECK);
    for (const idempotencyKey of ['not-a-uuid', '6ba7b810-9dad-11d1-80b4-00c04fd430c8']) expect(await refused(exchange({ idempotencyKey, lines: [line()] })), idempotencyKey).toBe(CHECK);
    for (const requestHash of ['a'.repeat(63), 'A'.repeat(64), 'g'.repeat(64)]) expect(await refused(exchange({ requestHash, lines: [line()] })), requestHash).toBe(CHECK);
    await exchange({ reason: 'x'.repeat(200), lines: [line()] }); // the boundary is accepted
  });

  // ---- sale state, remainder, idempotency ------------------------------------------------------------------------------

  it.each([['PAID'], ['CANCELLED']] as const)('PX14 a %s sale cannot be exchanged, even by raw SQL (23514)', async (status) => {
    const other = await completedSale(status);
    expect(await refused(exchange({ saleId: other.saleId, lines: [line({ saleItemId: other.itemA })] }))).toBe(CHECK);
  });

  it('PX15 the remainder is a database rule: 1 + 2 of 3 is fine, one more unit is refused at commit (23514)', async () => {
    await exchange({ lines: [line({ quantity: 1n })] });
    await exchange({ lines: [line({ quantity: 2n })] });
    expect(await refused(exchange({ lines: [line({ quantity: 1n })] }))).toBe(CHECK);
    expect(await refused(exchange({ lines: [line({ saleItemId: itemB, quantity: 2n })] }))).toBe(CHECK); // itemB was sold x1
    expect(await count('SaleExchange')).toBe(2);
  });

  it('PX16 (sale, key) is unique (23505); the same key on ANOTHER sale is a different exchange', async () => {
    const idempotencyKey = randomUUID();
    await exchange({ idempotencyKey, lines: [line()] });
    expect(await refused(exchange({ idempotencyKey, lines: [line()] }))).toBe(UNIQUE);
    const other = await completedSale();
    await exchange({ saleId: other.saleId, idempotencyKey, lines: [line({ saleItemId: other.itemA, inInventoryId: inv.A })] });
    expect(await count('SaleExchange')).toBe(2);
  });

  it('PX17 two exchanges racing for the LAST unit serialize on the Sale lock: one commits, the other is refused (23514)', async () => {
    await exchange({ lines: [line({ quantity: 2n })] }); // 1 unit of itemA left
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let holderHasLock!: () => void;
    const locked = new Promise<void>((resolve) => { holderHasLock = resolve; });
    const holder = db.$transaction(async (tx) => {
      await write(tx, { lines: [line({ quantity: 1n })] });
      holderHasLock();
      await gate;
    }, { timeout: 30000 });
    await locked;
    const waiter = db.$transaction((tx) => write(tx, { lines: [line({ quantity: 1n })] }), { timeout: 30000 });
    // The waiter is blocked on the Sale row held by the holder (pg_blocking_pids), not on a sleep.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const blocked = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM pg_stat_activity WHERE cardinality(pg_blocking_pids(pid)) > 0`;
      if (Number(blocked[0]!.n) > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    release();
    await holder;
    expect(await refused(waiter)).toBe(CHECK);
    const total = await db.$queryRaw<{ s: bigint }[]>`SELECT sum("returnQuantity")::bigint AS s FROM "SaleExchangeLine" WHERE "saleItemId" = ${itemA}`;
    expect(total[0]!.s).toBe(3n);
  }, 60000);

  // ---- append-only, RESTRICT -------------------------------------------------------------------------------------------

  it('PX18 history is append-only: no UPDATE or DELETE of the header, the line or the exchange movements (23514)', async () => {
    const exchangeId = await exchange({ lines: [line()] });
    expect(await refused(db.$executeRaw`UPDATE "SaleExchange" SET reason = 'otro' WHERE id = ${exchangeId}`)).toBe(CHECK);
    expect(await refused(db.$executeRaw`DELETE FROM "SaleExchange" WHERE id = ${exchangeId}`)).toBe(CHECK);
    expect(await refused(db.$executeRaw`UPDATE "SaleExchangeLine" SET "returnQuantity" = 2 WHERE "saleExchangeId" = ${exchangeId}`)).toBe(CHECK);
    expect(await refused(db.$executeRaw`DELETE FROM "SaleExchangeLine" WHERE "saleExchangeId" = ${exchangeId}`)).toBe(CHECK);
    expect(await refused(db.$executeRaw`UPDATE "StockMovement" SET "quantityDelta" = 5 WHERE "saleExchangeId" = ${exchangeId} AND type::text = 'SALE_EXCHANGE_IN'`)).toBe(CHECK);
    expect(await refused(db.$executeRaw`DELETE FROM "StockMovement" WHERE "saleExchangeId" = ${exchangeId}`)).toBe(CHECK);
  });

  it('PX19 an existing SALE movement cannot be turned into an exchange movement, and other movements stay editable-as-before', async () => {
    const sale = await db.stockMovement.create({ data: { inventoryId: inv.A, type: 'SALE', quantityDelta: -1n, saleId, userId, branchId } });
    expect(await refused(db.$executeRaw`UPDATE "StockMovement" SET type = 'SALE_EXCHANGE_IN'::"StockMovementType" WHERE id = ${sale.id}`)).toBe(CHECK);
    expect(await db.$executeRaw`UPDATE "StockMovement" SET note = 'nota' WHERE id = ${sale.id}`).toBe(1);
  });

  it('PX20 the history cannot be orphaned: deleting a SaleItem, the Sale or a replacement variant that an exchange uses is refused (23503)', async () => {
    await exchange({ lines: [line()] });
    expect(await refused(db.$executeRaw`DELETE FROM "SaleItem" WHERE id = ${itemA}`)).toBe(FK);
    expect(await refused(db.$executeRaw`DELETE FROM "Sale" WHERE id = ${saleId}`)).toBe(FK);
    expect(await refused(db.$executeRaw`DELETE FROM "ProductVariant" WHERE id = ${variantR}`)).toBe(FK);
  });

  it('PX21 test cleanup keeps working: TRUNCATE ... CASCADE removes the exchange history (the append-only guard is row-level)', async () => {
    await exchange({ lines: [line()] });
    await truncateAllTables(db);
    expect(await count('SaleExchange')).toBe(0);
    expect(await count('SaleExchangeLine')).toBe(0);
  });
});
