// Sale void v1 + exchange v1 (G19) on REAL PostgreSQL — H3 of the independent audit: does the SaleVoid <-> SaleExchange exclusion survive MIXED
// transaction isolation levels?
//
// THE QUESTION. The guard triggers take the Sale row FOR UPDATE and then look for the opposite row with an EXISTS. Under SERIALIZABLE (and
// REPEATABLE READ) a statement sees the snapshot taken when the transaction ran its FIRST statement, not what committed while it waited for
// the lock. The audit asked whether a transaction that took its snapshot BEFORE the other one committed can then insert the opposite row, leaving a
// sale with BOTH a SaleVoid and a SaleExchange. This file does not assume the answer: it runs the 8 scenarios and records commit/rollback and
// SQLSTATE of every transaction, then asserts the invariant.
//
//   first writer:  SaleVoid | SaleExchange   x   isolation of the first: ReadCommitted | Serializable
//   second writer: the other one             x   isolation of the second: ReadCommitted | Serializable
//
// Protocol per scenario (deterministic, no sleeps as synchronisation): T1 runs `SELECT 1` (its snapshot), then writes its row and HOLDS the
// transaction open; T2 runs `SELECT 1` (its snapshot is now OLDER than T1's commit), then writes the opposite row and blocks on the Sale lock
// (waiting is observed in pg_stat_activity / pg_blocking_pids); T1 commits; T2 is released. The fixture rows are raw SQL: only the database decides.
// INVARIANT: for one sale, never SaleVoid AND SaleExchange.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedDemo } from '../../prisma/seed.js';
import type { Prisma, PrismaClient } from '../../src/generated/prisma/client.js';
import { createTestPrismaClient, truncateAllTables } from '../helpers/test-db.js';

const PRICE = 1_000n;
type Level = 'ReadCommitted' | 'Serializable';
type Kind = 'VOID' | 'EXCHANGE';
type Outcome = { committed: boolean; sqlstate: string | null };

function sqlState(error: unknown): string {
  const e = error as {
    code?: string; message?: string;
    meta?: { code?: string; driverAdapterError?: { cause?: { originalCode?: string } } };
    cause?: { originalCode?: string; code?: string };
  };
  const original = e.meta?.driverAdapterError?.cause?.originalCode ?? e.cause?.originalCode ?? e.meta?.code;
  if (typeof original === 'string' && /^[0-9A-Z]{5}$/.test(original)) return original;
  const fromMessage = /\b(2[0-9]{4}|40[0-9A-Z]{3})\b/.exec(e.message ?? '');
  return fromMessage ? fromMessage[1]! : `UNKNOWN(${e.code ?? 'no-code'})`;
}

describe('SaleVoid <-> SaleExchange exclusion under mixed isolation (PostgreSQL) — H3', () => {
  let db: PrismaClient;
  let userId: string;
  let branchId: string;
  let inventoryA: string;
  let inventoryR: string;
  let variantA: string;
  let variantR: string;
  const table: string[] = [];

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
    console.log(`\nH3 matrix (T1 commits first, T2 took its snapshot BEFORE and waited on the Sale lock)\n${table.join('\n')}\n`);
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

  const writeVoid = (tx: Prisma.TransactionClient, saleId: string) => tx.$executeRaw`INSERT INTO "SaleVoid"(id, "saleId", "branchId", "previousStatus", reason, "idempotencyKey", "voidedById")
    VALUES (${randomUUID()}, ${saleId}, ${branchId}, 'COMPLETED', 'error', ${randomUUID()}, ${userId})`;
  // header + line + the two ledger rows; the Inventory.physical is moved too so the ONLY thing that can refuse this exchange is the void guard
  const writeExchange = async (tx: Prisma.TransactionClient, saleId: string, itemId: string) => {
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
    await tx.$executeRaw`UPDATE "Inventory" SET physical = physical + 1 WHERE id = ${inventoryA}`;
    await tx.$executeRaw`UPDATE "Inventory" SET physical = physical - 1 WHERE id = ${inventoryR}`;
  };
  const write = (kind: Kind, tx: Prisma.TransactionClient, saleId: string, itemId: string) => (kind === 'VOID' ? writeVoid(tx, saleId) : writeExchange(tx, saleId, itemId));
  const count = async (name: string, saleId: string) => Number((await db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "${name}" WHERE "saleId" = '${saleId}'`))[0]!.n);

  async function race(first: Kind, firstLevel: Level, secondLevel: Level) {
    const second: Kind = first === 'VOID' ? 'EXCHANGE' : 'VOID';
    const { saleId, itemId } = await completedSale();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let firstWrote!: () => void;
    const firstHolds = new Promise<void>((resolve) => { firstWrote = resolve; });
    let secondSnapshot!: () => void;
    const secondHasSnapshot = new Promise<void>((resolve) => { secondSnapshot = resolve; });

    const t1 = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1`;
      await write(first, tx, saleId, itemId);
      firstWrote();
      await gate;
    }, { isolationLevel: firstLevel, timeout: 60000 });
    await firstHolds;
    const t2 = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1`; // the snapshot of a Serializable T2 is taken HERE, before T1 commits
      secondSnapshot();
      await write(second, tx, saleId, itemId);
    }, { isolationLevel: secondLevel, timeout: 60000 });
    await secondHasSnapshot;
    let waited = false;
    for (let attempt = 0; attempt < 200 && !waited; attempt += 1) {
      const blocked = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM pg_stat_activity WHERE cardinality(pg_blocking_pids(pid)) > 0`;
      waited = Number(blocked[0]!.n) > 0;
      if (!waited) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    release();
    const settle = async (promise: Promise<unknown>): Promise<Outcome> => promise.then(() => ({ committed: true, sqlstate: null }), (error: unknown) => ({ committed: false, sqlstate: sqlState(error) }));
    const [o1, o2] = await Promise.all([settle(t1), settle(t2)]);
    const voids = await count('SaleVoid', saleId);
    const exchanges = await count('SaleExchange', saleId);
    const label = `${first} ${firstLevel} -> ${second} ${secondLevel}`;
    const fmt = (o: Outcome) => (o.committed ? 'COMMIT' : `ROLLBACK ${o.sqlstate}`);
    table.push(`${label.padEnd(44)} | T1 ${fmt(o1).padEnd(18)} | T2 ${fmt(o2).padEnd(18)} | T2 waited=${waited} | SaleVoid=${voids} SaleExchange=${exchanges}${voids > 0 && exchanges > 0 ? '  <== BOTH (VIOLATION)' : ''}`);
    return { o1, o2, voids, exchanges, waited };
  }

  const levels: Level[] = ['ReadCommitted', 'Serializable'];
  const scenarios = (['VOID', 'EXCHANGE'] as const).flatMap((first) => levels.flatMap((l1) => levels.map((l2) => [first, l1, l2] as const)));
  // The SQLSTATE of the refused second writer: a READ COMMITTED T2 waits, then sees the committed row and the guard refuses it (23514); a SERIALIZABLE T2
  // whose snapshot predates T1's commit cannot update the claim row T1 wrote -> 40001 (the services retry it and then get the domain answer).
  const expectedSqlstate = (secondLevel: Level) => (secondLevel === 'Serializable' ? '40001' : '23514');
  // G20 (SalePostSaleGuard) closed H3: before it, VOID RC -> EXCHANGE SER and EXCHANGE RC -> VOID SER COMMITTED both rows (see the runbook).
  describe.each(scenarios)('H3/G20 first=%s(%s) then second=(%s)', (first, firstLevel, secondLevel) => {
    it('T2 really waited, T1 commits, T2 is refused with the expected SQLSTATE, and the sale never ends with BOTH a SaleVoid and a SaleExchange', async () => {
      const result = await race(first, firstLevel, secondLevel);
      expect(result.waited, 'the second writer must be blocked on the Sale lock for the scenario to mean anything').toBe(true);
      expect(result.o1.committed, 'T1 was first and alone: it commits').toBe(true);
      expect(result.o2).toEqual({ committed: false, sqlstate: expectedSqlstate(secondLevel) });
      expect(result.voids > 0 && result.exchanges > 0, `BOTH rows exist: ${JSON.stringify(result)}`).toBe(false);
      expect(first === 'VOID' ? [result.voids, result.exchanges] : [result.exchanges, result.voids]).toEqual([1, 0]);
    }, 90000);
  });

  // The claim must not depend on the G19 triggers: the same 8 races with the two G19 guards DISABLED (restored in finally) still never leave both rows.
  describe('H3/G20 the claim alone (G19 guards disabled)', () => {
    const toggle = async (state: 'DISABLE' | 'ENABLE') => {
      await db.$executeRawUnsafe(`ALTER TABLE "SaleVoid" ${state} TRIGGER "trg_sale_void_exchange_guard"`);
      await db.$executeRawUnsafe(`ALTER TABLE "SaleExchange" ${state} TRIGGER "trg_sale_exchange_void_guard"`);
    };
    it.each(scenarios)('first=%s(%s) then second=(%s): never both rows, and T2 is refused by the G20 claim', async (first, firstLevel, secondLevel) => {
      await toggle('DISABLE');
      try {
        const result = await race(first, firstLevel, secondLevel);
        expect(result.o1.committed).toBe(true);
        expect(result.o2.committed).toBe(false);
        expect(result.o2.sqlstate).toBe(expectedSqlstate(secondLevel));
        expect(result.voids > 0 && result.exchanges > 0).toBe(false);
      } finally {
        await toggle('ENABLE');
      }
    }, 90000);
  });
});
