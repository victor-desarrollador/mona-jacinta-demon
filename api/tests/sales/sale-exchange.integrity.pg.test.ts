// Sale exchange v1 — the SUPPORTED writer on REAL PostgreSQL: HTTP/service -> ONE Serializable transaction -> Inventory + StockMovement + AuditLog.
//
// TRUST BOUNDARY (OWNER decision A for V1, runbook 21): raw SQL DML is NOT a supported commercial writer. The database refuses malformed exchanges
// (G18 deferred ledger triggers) and the SaleVoid <-> SaleExchange conflict (G20), but it does not tie the ledger to Inventory.physical
// (sale-exchange-ledger-balance.pg.test.ts documents that limit). What guarantees Inventory == ledger is this path, and this file proves it:
//   IN01 a failing StockMovement insert            -> NOTHING survives (exchange, line, movements, Inventory, audit)
//   IN02 a failing AuditLog insert (the LAST write) -> NOTHING survives, Inventory included (it was already written)
//   IN03 a failure on the SECOND line               -> the first line's Inventory moves and rows are rolled back too
//   IN04 a committed cross-swap                     -> every Inventory.physical == before + the sum of ITS exchange movements; `inventories` == the rows
//   IN05 pg_dump / pg_restore of a committed exchange -> the same consistency afterwards (skipped when the PostgreSQL client tools are not installed)
// The failures are injected with TEMPORARY triggers (created and dropped inside each test), so the real service code is what runs.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedDemo } from '../../prisma/seed.js';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { createSaleExchangeService } from '../../src/modules/sales/sale-exchange.service.js';
import { createTestPrismaClient, truncateAllTables } from '../helpers/test-db.js';

// Literal commands and argv only (tests/test-cleanup.test.ts refuses any child_process call it cannot prove is not the Prisma CLI).
const LOCAL_URL = process.env.LOCAL_TEST_DATABASE_URL;
const CAN_DUMP = Boolean(LOCAL_URL) && new URL(LOCAL_URL!).pathname === '/mona_local_test' && spawnSync('pg_dump', ['--version'], { stdio: 'ignore' }).status === 0 && spawnSync('pg_restore', ['--version'], { stdio: 'ignore' }).status === 0;

describe('sale exchange — supported writer integrity (PostgreSQL)', () => {
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

  // A COMPLETED sale as the finalizer leaves it: items [A x3, B x2], one negative SALE movement per inventory, physical consumed.
  async function completedSale() {
    const sale = await db.sale.create({ data: {
      sellerId: userId, branchId, status: 'COMPLETED', priceMode: 'CASH', pricingMode: 'LIST', subtotal: price * 5n, discountTotal: 0n, total: price * 5n,
    } });
    const { productId } = await db.productVariant.findUniqueOrThrow({ where: { id: variants[0]! }, select: { productId: true } });
    const item = (variantId: string, quantity: bigint) => db.saleItem.create({ data: {
      saleId: sale.id, variantId, productId, productName: 'P', variantName: 'V', sku: variantId, quantity, unitPrice: price, subtotal: price * quantity,
    } });
    const a = await item(variants[0]!, 3n);
    const b = await item(variants[1]!, 2n);
    for (const [it, q] of [[a, 3n], [b, 2n]] as const) {
      await db.stockMovement.create({ data: { inventoryId: inv[it.variantId]!, type: 'SALE', quantityDelta: -q, saleId: sale.id, userId, branchId } });
      await db.inventory.update({ where: { id: inv[it.variantId]! }, data: { physical: { decrement: q } } });
    }
    return { saleId: sale.id, itemA: a.id, itemB: b.id };
  }
  const service = () => createSaleExchangeService(db);
  const body = (lines: Array<{ saleItemId: string; replacementVariantId: string; returnQuantity: bigint }>) => ({ reason: 'Cambio de talle', idempotencyKey: randomUUID(), lines });
  const count = async (table: string, where = 'TRUE') => Number((await db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "${table}" WHERE ${where}`))[0]!.n);
  // everything the exchange could have touched
  async function snapshot() {
    const physical = Object.fromEntries(await Promise.all(Object.entries(inv).map(async ([variantId, id]) => [variantId, (await db.inventory.findUniqueOrThrow({ where: { id } })).physical])));
    return {
      physical,
      exchanges: await count('SaleExchange'), lines: await count('SaleExchangeLine'),
      movements: await count('StockMovement', `"saleExchangeId" IS NOT NULL`), allMovements: await count('StockMovement'),
      audits: await count('AuditLog', `action = 'SALE_EXCHANGED'`), claims: await count('SalePostSaleGuard'),
    };
  }
  async function withInjectedFailure(table: '"StockMovement"' | '"AuditLog"', condition: string, run: () => Promise<void>) {
    const fn = `zz_inject_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
    await db.$executeRawUnsafe(`CREATE FUNCTION public.${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN RAISE EXCEPTION 'injected failure' USING ERRCODE = 'XX000'; END IF; RETURN NEW; END $$`);
    await db.$executeRawUnsafe(`CREATE TRIGGER ${fn} BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION public.${fn}()`);
    try { await run(); } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${fn} ON ${table}`);
      await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS public.${fn}()`);
    }
  }

  it('IN01 a StockMovement insert that fails -> no exchange, no line, no movement, no Inventory change, no audit, no claim', async () => {
    const { saleId, itemA } = await completedSale();
    const before = await snapshot();
    await withInjectedFailure('"StockMovement"', `NEW.type::text = 'SALE_EXCHANGE_OUT'`, async () => {
      await expect(service().exchangeSale(owner, saleId, body([{ saleItemId: itemA, replacementVariantId: variants[2]!, returnQuantity: 1n }]))).rejects.toThrow(/injected failure/);
    });
    expect(await snapshot()).toEqual(before);
  });

  it('IN02 an AuditLog insert that fails (the LAST write, Inventory already updated) -> everything rolls back: Inventory, movements, lines, exchange, claim', async () => {
    const { saleId, itemA, itemB } = await completedSale();
    const before = await snapshot();
    await withInjectedFailure('"AuditLog"', `NEW.action = 'SALE_EXCHANGED'`, async () => {
      await expect(service().exchangeSale(owner, saleId, body([
        { saleItemId: itemA, replacementVariantId: variants[2]!, returnQuantity: 2n }, { saleItemId: itemB, replacementVariantId: variants[3]!, returnQuantity: 1n },
      ]))).rejects.toThrow(/injected failure/);
    });
    expect(await snapshot()).toEqual(before);
  });

  it('IN03 a failure on the SECOND line rolls back the first line too (its Inventory moves, rows and movements)', async () => {
    const { saleId, itemA, itemB } = await completedSale();
    const before = await snapshot();
    // fail when the SECOND OUT movement of the same exchange is inserted
    await withInjectedFailure('"StockMovement"', `NEW.type::text = 'SALE_EXCHANGE_OUT' AND EXISTS (SELECT 1 FROM "StockMovement" m WHERE m."saleExchangeId" = NEW."saleExchangeId" AND m.type::text = 'SALE_EXCHANGE_OUT')`, async () => {
      await expect(service().exchangeSale(owner, saleId, body([
        { saleItemId: itemA, replacementVariantId: variants[2]!, returnQuantity: 2n }, { saleItemId: itemB, replacementVariantId: variants[3]!, returnQuantity: 1n },
      ]))).rejects.toThrow(/injected failure/);
    });
    expect(await snapshot()).toEqual(before);
  });

  // Every Inventory.physical == before + the sum of ITS exchange movements.
  async function expectBalanced(before: Awaited<ReturnType<typeof snapshot>>) {
    const ledger = await db.$queryRaw<{ inventoryId: string; delta: bigint }[]>`SELECT "inventoryId", sum("quantityDelta")::bigint AS delta FROM "StockMovement" WHERE "saleExchangeId" IS NOT NULL GROUP BY 1`;
    const after = await snapshot();
    for (const [variantId, id] of Object.entries(inv)) {
      const delta = ledger.find((row) => row.inventoryId === id)?.delta ?? 0n;
      expect(after.physical[variantId], `inventory of ${variantId}`).toBe((before.physical[variantId] as bigint) + delta);
    }
    return after;
  }

  it('IN04 a committed cross-swap: every Inventory.physical == before + the sum of its exchange movements, and `inventories` is the committed state', async () => {
    const { saleId, itemA, itemB } = await completedSale();
    const before = await snapshot();
    // A -> B and B -> A in one request (the same inventories are IN of one line and OUT of the other)
    const result = await service().exchangeSale(owner, saleId, body([
      { saleItemId: itemA, replacementVariantId: variants[1]!, returnQuantity: 2n }, { saleItemId: itemB, replacementVariantId: variants[0]!, returnQuantity: 1n },
    ]));
    const after = await expectBalanced(before);
    expect(after.exchanges).toBe(1);
    expect(after.lines).toBe(2);
    expect(after.movements).toBe(4);
    expect(after.audits).toBe(1);
    expect(result.inventories).toHaveLength(2);
    for (const state of result.inventories) {
      const row = await db.inventory.findUniqueOrThrow({ where: { id: state.inventoryId } });
      expect({ physical: state.physical, reserved: state.reserved, variantId: state.variantId }).toEqual({ physical: row.physical, reserved: row.reserved, variantId: row.variantId });
    }
  });

  // pg_dump -> mutate -> pg_restore --clean over the same disposable database: the committed exchange comes back consistent.
  it.skipIf(!CAN_DUMP)('IN05 backup / restore: a committed exchange comes back with the same ledger, the same Inventory and the same balance', async () => {
    const { saleId, itemA, itemB } = await completedSale();
    const before = await snapshot();
    await service().exchangeSale(owner, saleId, body([
      { saleItemId: itemA, replacementVariantId: variants[2]!, returnQuantity: 2n }, { saleItemId: itemB, replacementVariantId: variants[3]!, returnQuantity: 1n },
    ]));
    const committed = await expectBalanced(before);
    // Literal commands and argv only; the connection travels in the libpq environment and the archive through the pipes (the database name is the canonical
    // LOCAL_TEST one, spelled out, so this can never be pointed anywhere else).
    const url = new URL(LOCAL_URL!);
    const env = { PATH: process.env.PATH ?? '', PGHOST: url.hostname, PGPORT: url.port || '5432', PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password) };
    const dump = spawnSync('pg_dump', ['-Fc', '-d', 'mona_local_test'], { env, maxBuffer: 256 * 1024 * 1024 });
    expect(dump.status, String(dump.stderr)).toBe(0);
    await db.$executeRawUnsafe('TRUNCATE "AuditLog", "StockMovement", "SalePostSaleGuard", "SaleExchangeLine", "SaleExchange" CASCADE'); // the backup is what brings them back
    const restore = spawnSync('pg_restore', ['--clean', '--if-exists', '--no-owner', '--no-acl', '-d', 'mona_local_test'], { env, input: dump.stdout, maxBuffer: 64 * 1024 * 1024 });
    expect(restore.status, String(restore.stderr)).toBe(0);
    expect(await snapshot()).toEqual(committed);
    await expectBalanced(before);
    expect(await count('SalePostSaleGuard', `"saleId" = '${saleId}' AND mode = 'EXCHANGE'`)).toBe(1);
  }, 180000);
});
