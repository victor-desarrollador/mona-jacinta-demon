// H-01 on REAL PostgreSQL: the exact constraints behind the two P2002 races that initial-stock and cash still understand, as @prisma/adapter-pg really
// reports them, and the two races themselves with the real services.
//   Inventory_variantId_branchId_key            -> the first Inventory row of a (variant, branch) created concurrently (initial-stock retries it)
//   cash_session_one_open_per_register          -> the partial unique index of CashSession(registerId) WHERE status = 'OPEN' (CASH_SESSION_ALREADY_OPEN)
// Any other unique violation (here: User.email) is classified as neither.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedDemo } from '../../prisma/seed.js';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { createCashService } from '../../src/modules/cash/cash.service.js';
import { isInventoryFirstRowRace } from '../../src/modules/inventory/inventory-unique-race.js';
import { createInitialStockService } from '../../src/modules/inventory/initial-stock.service.js';
import { uniqueViolation } from '../../src/modules/payments/prisma-unique-violation.js';
import { createTestPrismaClient, truncateAllTables } from '../helpers/test-db.js';

const settle = <T>(promise: Promise<T>) => promise.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));

describe('P2002 constraints behind initial-stock and cash (PostgreSQL)', () => {
  let db: PrismaClient;
  beforeAll(async () => { db = await createTestPrismaClient(); }, 120000);
  beforeEach(async () => { await truncateAllTables(db); await seedDemo(db); }, 120000);
  afterAll(async () => { await db?.$disconnect(); }, 120000);

  it('PU01 the REAL adapter-pg shapes name exactly the two constraints; a foreign unique violation names neither', async () => {
    const inventory = await db.inventory.findFirstOrThrow();
    const dupInventory = await db.inventory.create({ data: { variantId: inventory.variantId, branchId: inventory.branchId, physical: 0n, reserved: 0n } }).then(() => null, (e: unknown) => e);
    expect(uniqueViolation(dupInventory)).toEqual({ modelName: 'Inventory', fields: null, name: 'Inventory_variantId_branchId_key' });
    expect(isInventoryFirstRowRace(dupInventory)).toBe(true);

    const user = await db.user.findFirstOrThrow();
    const register = await db.cashRegister.findFirstOrThrow();
    await db.cashSession.create({ data: { registerId: register.id, openedById: user.id, startingCash: 0n, status: 'OPEN' } });
    const dupSession = await db.cashSession.create({ data: { registerId: register.id, openedById: user.id, startingCash: 0n, status: 'OPEN' } }).then(() => null, (e: unknown) => e);
    expect(uniqueViolation(dupSession)).toEqual({ modelName: 'CashSession', fields: null, name: 'cash_session_one_open_per_register' });
    expect(isInventoryFirstRowRace(dupSession)).toBe(false);

    const dupUser = await db.user.create({ data: { name: 'x', email: user.email, passwordHash: 'x' } }).then(() => null, (e: unknown) => e);
    expect(uniqueViolation(dupUser)?.name ?? uniqueViolation(dupUser)?.fields?.join(',')).toMatch(/email/i);
    expect(isInventoryFirstRowRace(dupUser)).toBe(false);
  });

  it('PU02 two concurrent FIRST loads of the same (variant, branch): both commit (the loser is retried), the balance is the sum, one Inventory row, two INITIAL_STOCK movements', async () => {
    const seeded = await db.inventory.findFirstOrThrow();
    await db.stockMovement.deleteMany({ where: { inventoryId: seeded.id } });
    await db.inventory.delete({ where: { id: seeded.id } });
    const user = await db.user.findFirstOrThrow();
    const service = createInitialStockService(db);
    const input = { variantId: seeded.variantId, branchId: seeded.branchId };
    const results = await Promise.all([settle(service.loadInitialStock(user.id, { ...input, quantity: 7n })), settle(service.loadInitialStock(user.id, { ...input, quantity: 5n }))]);
    expect(results.map((r) => r.ok), JSON.stringify(results.filter((r) => !r.ok))).toEqual([true, true]);
    const rows = await db.inventory.findMany({ where: input });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.physical).toBe(12n);
    expect(await db.stockMovement.count({ where: { inventoryId: rows[0]!.id, type: 'INITIAL_STOCK' } })).toBe(2);
  }, 90000);

  it('PU03 two concurrent openings of the same register: exactly one session, the other answers 409 CASH_SESSION_ALREADY_OPEN (never a raw P2002, never a CONCURRENCY_ERROR)', async () => {
    const register = await db.cashRegister.findFirstOrThrow();
    const branch = await db.branch.findUniqueOrThrow({ where: { id: register.branchId } });
    const assignments = [{ roleId: 'OWNER-company', roleCode: 'OWNER', scopeKind: 'COMPANY', locationId: null, permissions: [] }];
    const user = await db.user.findFirstOrThrow();
    const ctx = { userId: user.id, roles: ['OWNER'], assignments, effectiveLocationIds: [branch.id] } as unknown as Express.AuthContext;
    const service = createCashService(db);
    const results = await Promise.all([settle(service.openSession(register.id, ctx, 1000n)), settle(service.openSession(register.id, ctx, 2000n))]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const lost = results.find((r) => !r.ok) as { ok: false; error: unknown };
    expect(lost.error).toMatchObject({ status: 409, code: 'CASH_SESSION_ALREADY_OPEN' });
    expect(await db.cashSession.count({ where: { registerId: register.id, status: 'OPEN' } })).toBe(1);
  }, 90000);
});
