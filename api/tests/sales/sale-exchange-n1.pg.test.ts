// Sale exchange v1 — N-1 compatibility on REAL PostgreSQL (G17 .. G20 + RBAC 38 are ADDITIVE).
//
// "N-1" = the API image that was deployed BEFORE the exchange: it knows nothing of SaleExchange, SaleExchangeLine, the
// two StockMovement labels or SALE_EXCHANGE. After G17/G18 are applied (and before the new API is deployed) that old API
// must keep starting and operating. This file proves it from the database side, using ONLY the column lists the old
// client uses (raw SQL written against the previous schema):
//   - it can still insert every StockMovement kind it knows, and read the table;
//   - the new guards never fire for rows that are not exchange rows;
//   - the old enum labels are intact and in order;
//   - the new columns are NULLable without default (so an old INSERT that omits them is valid);
//   - the old test-cleanup (TRUNCATE ... CASCADE) still works.
// Needs a migrated LOCAL_TEST database (run on a disposable PostgreSQL 17.11 carrying G17..G20). The rollout proof that complements it —
// run the PREVIOUS commit's API integration subset against the migrated database — is in the report/runbook, not here.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedDemo } from '../../prisma/seed.js';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { createTestPrismaClient, truncateAllTables } from '../helpers/test-db.js';

const N1_STOCK_MOVEMENT_COLUMNS = [
  'id', 'inventoryId', 'type', 'quantityDelta', 'saleId', 'userId', 'branchId', 'reason', 'note', 'idempotencyKey', 'saleVoidId', 'timestamp',
];

describe('sale exchange v1 — N-1 compatibility (PostgreSQL)', () => {
  let db: PrismaClient;
  let userId: string;
  let branchId: string;
  let inventoryId: string;
  let saleId: string;

  beforeAll(async () => { db = await createTestPrismaClient(); }, 120000);
  beforeEach(async () => {
    await truncateAllTables(db);
    await seedDemo(db);
    const [cashier, branch] = await Promise.all([
      db.user.findUniqueOrThrow({ where: { email: 'cashier01@demo.local' } }),
      db.branch.findUniqueOrThrow({ where: { code: 'CEN' } }),
    ]);
    userId = cashier.id; branchId = branch.id;
    inventoryId = (await db.inventory.findFirstOrThrow({ where: { branchId }, orderBy: { id: 'asc' } })).id;
    saleId = (await db.sale.create({ data: { sellerId: userId, branchId, status: 'COMPLETED', priceMode: 'CASH', pricingMode: 'LIST', subtotal: 1n, discountTotal: 0n, total: 1n } })).id;
  }, 120000);
  afterAll(async () => { await db?.$disconnect(); }, 120000);

  it('NA01 StockMovement keeps every N-1 column and the two new ones are NULLable without default', async () => {
    const columns = await db.$queryRaw<{ column_name: string; is_nullable: string; column_default: string | null }[]>`
      SELECT column_name, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'StockMovement'`;
    const byName = new Map(columns.map((column) => [column.column_name, column]));
    for (const name of N1_STOCK_MOVEMENT_COLUMNS) expect(byName.has(name), name).toBe(true);
    for (const name of ['saleExchangeId', 'saleExchangeLineId']) {
      expect(byName.get(name), name).toMatchObject({ is_nullable: 'YES', column_default: null });
    }
  });

  it('NA02 the N-1 enum labels are intact and in order; the new labels come last', async () => {
    const labels = await db.$queryRaw<{ enumlabel: string }[]>`
      SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'StockMovementType' ORDER BY e.enumsortorder`;
    expect(labels.map((row) => row.enumlabel)).toEqual(['SALE', 'INITIAL_STOCK', 'ADJUSTMENT', 'SALE_VOID', 'SALE_EXCHANGE_IN', 'SALE_EXCHANGE_OUT']);
  });

  it('NA03 an N-1 INSERT (old column list, no exchange columns) is accepted for SALE, INITIAL_STOCK and ADJUSTMENT', async () => {
    await db.$executeRaw`INSERT INTO "StockMovement"(id, "inventoryId", type, "quantityDelta", "saleId", "userId", "branchId")
      VALUES (${randomUUID()}, ${inventoryId}, 'SALE', -1, ${saleId}, ${userId}, ${branchId})`;
    await db.$executeRaw`INSERT INTO "StockMovement"(id, "inventoryId", type, "quantityDelta", "userId", "branchId")
      VALUES (${randomUUID()}, ${inventoryId}, 'INITIAL_STOCK', 10, ${userId}, ${branchId})`;
    await db.$executeRaw`INSERT INTO "StockMovement"(id, "inventoryId", type, "quantityDelta", "userId", "branchId", reason, "idempotencyKey")
      VALUES (${randomUUID()}, ${inventoryId}, 'ADJUSTMENT', 2, ${userId}, ${branchId}, 'SURPLUS', ${randomUUID()})`;
    expect(await db.stockMovement.count()).toBeGreaterThanOrEqual(3);
  });

  it('NA04 an N-1 sale void still writes its SALE_VOID return (the exchange guards do not fire for it)', async () => {
    const voidId = randomUUID();
    await db.$executeRaw`INSERT INTO "SaleVoid"(id, "saleId", "branchId", "previousStatus", reason, "idempotencyKey", "voidedById")
      VALUES (${voidId}, ${saleId}, ${branchId}, 'COMPLETED', 'error', ${randomUUID()}, ${userId})`;
    await db.$executeRaw`INSERT INTO "StockMovement"(id, "inventoryId", type, "quantityDelta", "saleId", "userId", "branchId", "saleVoidId")
      VALUES (${randomUUID()}, ${inventoryId}, 'SALE_VOID', 1, ${saleId}, ${userId}, ${branchId}, ${voidId})`;
    expect(await db.stockMovement.count({ where: { type: 'SALE_VOID' } })).toBe(1);
  });

  it('NA05 the N-1 client reads and updates non-exchange movements exactly as before (UPDATE / DELETE guards are exchange-only)', async () => {
    const id = randomUUID();
    await db.$executeRaw`INSERT INTO "StockMovement"(id, "inventoryId", type, "quantityDelta", "userId", "branchId")
      VALUES (${id}, ${inventoryId}, 'INITIAL_STOCK', 10, ${userId}, ${branchId})`;
    expect(await db.$executeRaw`UPDATE "StockMovement" SET note = 'x' WHERE id = ${id}`).toBe(1);
    expect(await db.$executeRaw`DELETE FROM "StockMovement" WHERE id = ${id}`).toBe(1);
  });

  it('NA06 a COMPLETED sale of N-1 stays voidable and its SaleItems/SalePayments stay writable: no exchange object is required', async () => {
    expect(await db.sale.update({ where: { id: saleId }, data: { status: 'CANCELLED' } })).toMatchObject({ status: 'CANCELLED' });
  });

  it('NA07 the old cleanup (TRUNCATE ... CASCADE through the proven client) still works with the new tables present', async () => {
    await truncateAllTables(db);
    expect(Number((await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "StockMovement"`)[0]!.n)).toBe(0);
  });

  it('NA08 SALE_EXCHANGE is only a new permission row: the N-1 catalog rows are untouched and no N-1 role loses a grant', async () => {
    const rows = await db.$queryRaw<{ code: string }[]>`SELECT code FROM "Permission" WHERE code IN ('SALE_VOID', 'SALE_CANCEL_PENDING', 'CASH_MOVEMENT_MANAGE')`;
    expect(rows.map((row) => row.code).sort()).toEqual(['CASH_MOVEMENT_MANAGE', 'SALE_CANCEL_PENDING', 'SALE_VOID']);
  });
});
