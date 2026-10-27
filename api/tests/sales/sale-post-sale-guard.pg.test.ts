// Sale exchange v1 (G20) on REAL PostgreSQL — SalePostSaleGuard: the central claim that makes SaleVoid and SaleExchange mutually exclusive per sale.
//   GS01 structure     table, PK, FK RESTRICT/RESTRICT, mode CHECK, one function, two triggers (the migration is additive: the G19 guards are still there)
//   GS02 claim         SaleVoid -> VOID; SaleExchange -> EXCHANGE; a second exchange of the same sale is allowed and keeps ONE claim row
//   GS03 rollback      a writer that fails after its claim leaves no claim behind
//   GS04 services      the void service replays idempotently and still voids a sale without exchanges; with an exchange it answers SALE_HAS_EXCHANGES
//   GS05/GS06 backfill the migration SQL itself, run inside a transaction that is ROLLED BACK (DDL is transactional): existing voids -> VOID, existing
//                      exchanges -> EXCHANGE
//   GS07 conflict      a sale already in BOTH families aborts the migration with an explicit error and writes nothing (it never picks a mode)
// The race matrix (8 scenarios, both orders, RC/SERIALIZABLE) lives in sale-void-exchange-isolation.pg.test.ts.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Request } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedDemo } from '../../prisma/seed.js';
import type { Prisma, PrismaClient } from '../../src/generated/prisma/client.js';
import { createSaleVoidService } from '../../src/modules/sales/sale-void.service.js';
import { createTestPrismaClient, truncateAllTables } from '../helpers/test-db.js';

const PRICE = 1_000n;
const MIGRATION = readFileSync(fileURLToPath(new URL('../../prisma/migrations/20261026150000_sale_post_sale_guard/migration.sql', import.meta.url)), 'utf8');
class Rollback extends Error {}

function sqlState(error: unknown): string {
  const e = error as { code?: string; message?: string; meta?: { code?: string; driverAdapterError?: { cause?: { originalCode?: string } } }; cause?: { originalCode?: string } };
  const original = e.meta?.driverAdapterError?.cause?.originalCode ?? e.cause?.originalCode ?? e.meta?.code;
  if (typeof original === 'string' && /^[0-9A-Z]{5}$/.test(original)) return original;
  const fromMessage = /\b(2[0-9]{4}|40[0-9A-Z]{3})\b/.exec(e.message ?? '');
  return fromMessage ? fromMessage[1]! : `UNKNOWN(${e.code ?? 'no-code'})`;
}

describe('SalePostSaleGuard (G20, PostgreSQL)', () => {
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
  const exchange = (client: Prisma.TransactionClient | PrismaClient, saleId: string, itemId: string) => (client as PrismaClient).$transaction
    ? (client as PrismaClient).$transaction((tx) => writeExchange(tx, saleId, itemId))
    : writeExchange(client as Prisma.TransactionClient, saleId, itemId);
  async function writeExchange(tx: Prisma.TransactionClient, saleId: string, itemId: string) {
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
  }
  const voidRow = (client: Prisma.TransactionClient | PrismaClient, saleId: string) => client.$executeRaw`INSERT INTO "SaleVoid"(id, "saleId", "branchId", "previousStatus", reason, "idempotencyKey", "voidedById")
    VALUES (${randomUUID()}, ${saleId}, ${branchId}, 'COMPLETED', 'error', ${randomUUID()}, ${userId})`;
  const guards = async (client: Prisma.TransactionClient | PrismaClient = db) =>
    (await client.$queryRaw<{ saleId: string; mode: string }[]>`SELECT "saleId", "mode" FROM "SalePostSaleGuard" ORDER BY "saleId"`);
  const refused = async (promise: Promise<unknown>) => {
    const error = await promise.then(() => null, (cause: unknown) => cause);
    expect(error, 'the database must refuse this').not.toBeNull();
    return error as Error;
  };

  it('GS01 structure: PK(saleId), FK to Sale RESTRICT/RESTRICT, mode CHECK, one claim function, two BEFORE triggers; the G19 guards are untouched', async () => {
    const cols = await db.$queryRaw<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }[]>`
      SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'SalePostSaleGuard' ORDER BY ordinal_position`;
    expect(cols.map((c) => [c.column_name, c.data_type, c.is_nullable])).toEqual([['saleId', 'text', 'NO'], ['mode', 'text', 'NO'], ['createdAt', 'timestamp with time zone', 'NO']]);
    const constraints = await db.$queryRaw<{ conname: string; contype: string; confdeltype: string | null; confupdtype: string | null }[]>`
      SELECT conname, contype::text, confdeltype::text, confupdtype::text FROM pg_constraint WHERE conrelid = 'public."SalePostSaleGuard"'::regclass ORDER BY conname`;
    expect(constraints.map((c) => [c.conname, c.contype])).toEqual([['SalePostSaleGuard_pkey', 'p'], ['SalePostSaleGuard_saleId_fkey', 'f'], ['chk_sale_post_sale_guard_mode', 'c']]);
    const fk = constraints.find((c) => c.contype === 'f')!;
    expect([fk.confdeltype, fk.confupdtype]).toEqual(['r', 'r']);
    const triggers = await db.$queryRaw<{ tgname: string; tgrelid: string }[]>`
      SELECT tgname, tgrelid::regclass::text AS tgrelid FROM pg_trigger WHERE NOT tgisinternal AND tgname IN
      ('trg_sale_void_post_sale_claim', 'trg_sale_exchange_post_sale_claim', 'trg_sale_void_exchange_guard', 'trg_sale_exchange_void_guard') ORDER BY tgname`;
    expect(triggers.map((t) => t.tgname)).toEqual(['trg_sale_exchange_post_sale_claim', 'trg_sale_exchange_void_guard', 'trg_sale_void_exchange_guard', 'trg_sale_void_post_sale_claim']);
    const fn = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM pg_proc WHERE proname = 'fn_sale_post_sale_claim' AND pronamespace = 'public'::regnamespace`;
    expect(Number(fn[0]!.n)).toBe(1);
    const { saleId } = await completedSale();
    expect(await refused(db.$executeRaw`INSERT INTO "SalePostSaleGuard"("saleId", "mode") VALUES (${saleId}, 'OTHER')`).then(sqlState)).toBe('23514');
    await db.$executeRaw`INSERT INTO "SalePostSaleGuard"("saleId", "mode") VALUES (${saleId}, 'VOID')`;
    expect(await refused(db.$executeRaw`INSERT INTO "SalePostSaleGuard"("saleId", "mode") VALUES (${saleId}, 'VOID')`).then(sqlState)).toBe('23505');
    expect(await refused(db.$executeRaw`DELETE FROM "Sale" WHERE id = ${saleId}`).then(sqlState)).toBe('23503');
  });

  it('GS02 a SaleVoid claims VOID, a SaleExchange claims EXCHANGE, and a second exchange of the same sale is allowed (still ONE claim row)', async () => {
    const a = await completedSale();
    const b = await completedSale();
    await voidRow(db, a.saleId);
    await exchange(db, b.saleId, b.itemId);
    expect(await guards()).toEqual([{ saleId: a.saleId, mode: 'VOID' }, { saleId: b.saleId, mode: 'EXCHANGE' }].sort((x, y) => x.saleId.localeCompare(y.saleId)));
    await exchange(db, b.saleId, b.itemId); // exchange 2 of the same sale
    expect((await guards()).filter((row) => row.saleId === b.saleId)).toEqual([{ saleId: b.saleId, mode: 'EXCHANGE' }]);
    expect(Number((await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "SaleExchange" WHERE "saleId" = ${b.saleId}`)[0]!.n)).toBe(2);
  });

  it('GS03 a writer that fails AFTER its claim leaves no claim behind (the claim rolls back with it)', async () => {
    const { saleId } = await completedSale();
    const error = await refused(db.$transaction(async (tx) => { await voidRow(tx, saleId); expect(await guards(tx)).toHaveLength(1); throw new Rollback('boom'); }));
    expect(error).toBeInstanceOf(Rollback);
    expect(await guards()).toEqual([]);
    // the sale is still free for the OTHER family
    await exchange(db, saleId, (await db.saleItem.findFirstOrThrow({ where: { saleId } })).id);
    expect(await guards()).toEqual([{ saleId, mode: 'EXCHANGE' }]);
  });

  it('GS04 the void service: idempotent replay unchanged, a sale without exchanges voids and claims VOID, a sale with an exchange -> SALE_HAS_EXCHANGES', async () => {
    const plain = await completedSale();
    const key = randomUUID();
    const service = createSaleVoidService(db);
    const first = await service.voidSale(owner, plain.saleId, { reason: 'error', idempotencyKey: key });
    const replay = await service.voidSale(owner, plain.saleId, { reason: 'error', idempotencyKey: key });
    expect(first).toMatchObject({ replayed: false, status: 'CANCELLED' });
    expect(replay).toMatchObject({ replayed: true, voidId: first.voidId });
    expect((await guards()).filter((row) => row.saleId === plain.saleId)).toEqual([{ saleId: plain.saleId, mode: 'VOID' }]);
    const exchanged = await completedSale();
    await exchange(db, exchanged.saleId, exchanged.itemId);
    const error = await refused(service.voidSale(owner, exchanged.saleId, { reason: 'error', idempotencyKey: randomUUID() }));
    expect(error).toMatchObject({ status: 409, code: 'SALE_HAS_EXCHANGES' });
  });

  // The migration file, executed inside a transaction that is always rolled back (PostgreSQL DDL is transactional).
  async function inRolledBackTransaction(work: (tx: Prisma.TransactionClient) => Promise<void>) {
    const error = await db.$transaction(async (tx) => { await work(tx); throw new Rollback('rollback'); }, { timeout: 60000 }).then(() => null, (cause: unknown) => cause);
    if (!(error instanceof Rollback)) throw error;
  }
  const dropG20 = async (tx: Prisma.TransactionClient) => {
    await tx.$executeRawUnsafe('DROP TRIGGER "trg_sale_void_post_sale_claim" ON "SaleVoid"');
    await tx.$executeRawUnsafe('DROP TRIGGER "trg_sale_exchange_post_sale_claim" ON "SaleExchange"');
    await tx.$executeRawUnsafe('DROP FUNCTION public."fn_sale_post_sale_claim"()');
    await tx.$executeRawUnsafe('DROP TABLE "SalePostSaleGuard"');
  };

  it('GS05 backfill: the migration turns existing SaleVoid rows into VOID and existing SaleExchange rows into EXCHANGE (several exchanges of one sale -> one claim)', async () => {
    const v = await completedSale();
    const x = await completedSale();
    const untouched = await completedSale();
    await voidRow(db, v.saleId);
    await exchange(db, x.saleId, x.itemId);
    await exchange(db, x.saleId, x.itemId);
    let after: { saleId: string; mode: string }[] = [];
    await inRolledBackTransaction(async (tx) => {
      await dropG20(tx);
      await tx.$executeRawUnsafe(MIGRATION);
      after = await guards(tx);
    });
    expect(after).toEqual([{ saleId: v.saleId, mode: 'VOID' }, { saleId: x.saleId, mode: 'EXCHANGE' }].sort((p, q) => p.saleId.localeCompare(q.saleId)));
    expect(after.map((row) => row.saleId)).not.toContain(untouched.saleId);
    // rolled back: the live objects are exactly as they were
    expect((await guards()).map((row) => row.saleId).sort()).toEqual([v.saleId, x.saleId].sort());
  }, 90000);

  it('GS06 the migration is atomic with its triggers: after running it on a database that had legacy rows, the NEXT writers are claimed (no gap)', async () => {
    const x = await completedSale();
    const y = await completedSale();
    await exchange(db, x.saleId, x.itemId);
    await inRolledBackTransaction(async (tx) => {
      await dropG20(tx);
      await tx.$executeRawUnsafe(MIGRATION);
      const error = await tx.$executeRaw`SAVEPOINT s`.then(() => voidRow(tx, x.saleId)).then(() => null, (cause: unknown) => cause);
      expect(error).not.toBeNull(); // the legacy exchange keeps the sale out of VOID (G19 guard fires first; the claim backs it)
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT s`;
      await voidRow(tx, y.saleId);
      expect(await guards(tx)).toEqual([{ saleId: x.saleId, mode: 'EXCHANGE' }, { saleId: y.saleId, mode: 'VOID' }].sort((p, q) => p.saleId.localeCompare(q.saleId)));
    });
  }, 90000);

  it('GS07 a sale already in BOTH families aborts the migration with an explicit error (23514) and writes nothing: no mode is ever chosen silently', async () => {
    const both = await completedSale();
    const fine = await completedSale();
    await exchange(db, both.saleId, both.itemId);
    await voidRow(db, fine.saleId);
    let message = '';
    let state = '';
    await inRolledBackTransaction(async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE "SaleVoid" DISABLE TRIGGER "trg_sale_void_exchange_guard"');
      await tx.$executeRawUnsafe('ALTER TABLE "SaleVoid" DISABLE TRIGGER "trg_sale_void_post_sale_claim"');
      await voidRow(tx, both.saleId); // the legacy conflict, forced in with every guard off
      await tx.$executeRawUnsafe('ALTER TABLE "SaleVoid" ENABLE TRIGGER "trg_sale_void_exchange_guard"');
      await tx.$executeRawUnsafe('ALTER TABLE "SaleVoid" ENABLE TRIGGER "trg_sale_void_post_sale_claim"');
      await dropG20(tx);
      await tx.$executeRaw`SAVEPOINT m`;
      const error = await tx.$executeRawUnsafe(MIGRATION).then(() => null, (cause: unknown) => cause);
      expect(error).not.toBeNull();
      message = String((error as Error).message);
      state = sqlState(error);
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT m`;
      // nothing of the migration survived the abort: no table, no claim function
      const leftovers = await tx.$queryRaw<{ n: bigint }[]>`SELECT (SELECT count(*) FROM pg_class WHERE relname = 'SalePostSaleGuard') + (SELECT count(*) FROM pg_proc WHERE proname = 'fn_sale_post_sale_claim') AS n`;
      expect(Number(leftovers[0]!.n)).toBe(0);
    });
    expect(state).toBe('23514');
    expect(message).toContain('backfill aborted');
    expect(message).toContain('no mode is chosen silently');
    // and the live database is untouched
    expect((await guards()).map((row) => row.saleId)).toEqual(expect.arrayContaining([both.saleId, fine.saleId]));
  }, 90000);
});
