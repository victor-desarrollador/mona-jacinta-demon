import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedDemo } from '../../prisma/seed.js';
import { createApp } from '../../src/app.js';
import type { Prisma, PrismaClient } from '../../src/generated/prisma/client.js';
import { createTestPrismaClient, truncateAllTables } from '../helpers/test-db.js';
import { getAuthToken, createTestUser } from '../helpers/auth.js';

// D3 (Demo Operativa V1): additive initial stock load. IMPORT_RUN
// (docs/production-v1/03-role-permission-matrix.md: OWNER, ADMIN) is not
// COMPANY-required, so it is location-paired against the target branch:
// ADMIN COMPANY / OWNER anywhere, a LOCATION ADMIN only at its own location.
// physical = previous physical + quantity (never "set"), reserved untouched,
// exactly one positive INITIAL_STOCK StockMovement and one audit row, all in
// one transaction (docs/production-v1/07-inventory-ledger.md §4).
describe('POST /api/v1/inventory/initial-stock (D3)', () => {
  let db: PrismaClient;
  let app: ReturnType<typeof createApp>;
  let adminId: string;
  let adminToken: string;
  let ownerToken: string;
  let warehouseToken: string;
  let locationAdminToken: string;
  let centroId: string;
  let yerbaId: string;
  let variantId: string;

  beforeAll(async () => {
    db = await createTestPrismaClient();
    app = createApp(db);
  }, 120000);
  beforeEach(async () => {
    await truncateAllTables(db);
    await seedDemo(db);
    const [admin, owner, warehouse, centro, yerba, adminRole, variant] = await Promise.all([
      db.user.findUniqueOrThrow({ where: { email: 'admin@demo.local' } }),
      db.user.findUniqueOrThrow({ where: { email: 'owner01@demo.local' } }),
      db.user.findUniqueOrThrow({ where: { email: 'warehouse01@demo.local' } }),
      db.branch.findUniqueOrThrow({ where: { code: 'CEN' } }),
      db.branch.findUniqueOrThrow({ where: { code: 'YB' } }),
      db.role.findUniqueOrThrow({ where: { code: 'ADMIN' } }),
      db.productVariant.findUniqueOrThrow({ where: { sku: 'REM-NEG-M' } }),
    ]);
    const locationAdmin = await createTestUser(db, adminRole.id, centro.id);
    adminId = admin.id;
    adminToken = await getAuthToken(admin);
    ownerToken = await getAuthToken(owner);
    warehouseToken = await getAuthToken(warehouse);
    locationAdminToken = await getAuthToken(locationAdmin);
    centroId = centro.id;
    yerbaId = yerba.id;
    variantId = variant.id;
  }, 120000);
  afterAll(async () => { vi.restoreAllMocks(); await db?.$disconnect(); }, 120000);

  const load = (token: string, body: unknown) =>
    request(app).post('/api/v1/inventory/initial-stock').set('Authorization', `Bearer ${token}`).send(body as object);
  const inventoryAt = (branchId: string, id = variantId) =>
    db.inventory.findUnique({ where: { variantId_branchId: { variantId: id, branchId } } });

  it('adds quantity to physical, leaves reserved untouched, and records one INITIAL_STOCK movement and one audit', async () => {
    await db.inventory.update({ where: { variantId_branchId: { variantId, branchId: centroId } }, data: { reserved: 3n } });
    const before = (await inventoryAt(centroId))!;

    const response = await load(adminToken, { variantId, branchId: centroId, quantity: '15' });
    expect(response.status).toBe(201);
    expect(response.body.inventory).toMatchObject({ id: before.id, variantId, branchId: centroId, physical: '35', reserved: '3' });

    const after = (await inventoryAt(centroId))!;
    expect(after.physical).toBe(before.physical + 15n);
    expect(after.reserved).toBe(3n);

    const movements = await db.stockMovement.findMany({ where: { inventoryId: before.id } });
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({ type: 'INITIAL_STOCK', quantityDelta: 15n, saleId: null, userId: adminId, branchId: centroId });

    const audits = await db.auditLog.findMany({ where: { entityType: 'Inventory', entityId: before.id } });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: 'INVENTORY_INITIAL_STOCK_LOADED', userId: adminId, branchId: centroId });
    expect(audits[0]!.before).toEqual({ physical: '20', reserved: '3' });
    expect(audits[0]!.after).toEqual({ physical: '35', reserved: '3', quantity: '15', variantId });
  });

  it('creates the Inventory row when the variant has none at that branch yet', async () => {
    const product = await db.product.findUniqueOrThrow({ where: { slug: 'remera-basica' } });
    const fresh = await db.productVariant.create({
      data: { productId: product.id, sku: 'D3-FRESH', barcode: 'D3-FRESH', price: 1n, costPrice: 1n },
    });
    expect(await inventoryAt(centroId, fresh.id)).toBeNull();

    const response = await load(ownerToken, { variantId: fresh.id, branchId: centroId, quantity: '7' });
    expect(response.status).toBe(201);
    const created = (await inventoryAt(centroId, fresh.id))!;
    expect(created.physical).toBe(7n);
    expect(created.reserved).toBe(0n);
    expect(await db.stockMovement.count({ where: { inventoryId: created.id, type: 'INITIAL_STOCK', quantityDelta: 7n } })).toBe(1);
  });

  it('authorizes IMPORT_RUN location-paired: LOCATION ADMIN at its own branch only; callers without IMPORT_RUN are denied', async () => {
    expect((await load(locationAdminToken, { variantId, branchId: centroId, quantity: '1' })).status).toBe(201);
    expect((await load(locationAdminToken, { variantId, branchId: yerbaId, quantity: '1' })).status).toBe(403);
    // WAREHOUSE carries INVENTORY_MANAGE but not IMPORT_RUN.
    const warehouseDepot = (await db.branch.findUniqueOrThrow({ where: { code: 'DEP' } })).id;
    expect((await load(warehouseToken, { variantId, branchId: warehouseDepot, quantity: '1' })).status).toBe(403);
    expect((await inventoryAt(yerbaId))!.physical).toBe(20n);
    expect((await inventoryAt(warehouseDepot))!.physical).toBe(50n);
    expect(await db.stockMovement.count()).toBe(1);
  });

  it('rejects unknown variant or branch with 404 and no write', async () => {
    const unknown = '00000000-0000-4000-8000-999999999999';
    expect((await load(adminToken, { variantId: unknown, branchId: centroId, quantity: '1' })).status).toBe(404);
    expect((await load(adminToken, { variantId, branchId: unknown, quantity: '1' })).status).toBe(404);
    expect(await db.stockMovement.count()).toBe(0);
    expect(await db.auditLog.count()).toBe(0);
  });

  it('rejects zero, negative, fractional or malformed quantities and bodies with 400', async () => {
    for (const invalid of [
      { variantId, branchId: centroId, quantity: '0' },
      { variantId, branchId: centroId, quantity: '-5' },
      { variantId, branchId: centroId, quantity: '1.5' },
      { variantId, branchId: centroId },
      { variantId: 'nope', branchId: centroId, quantity: '1' },
      { variantId, branchId: centroId, quantity: '1', physical: '99' },
    ]) {
      expect((await load(adminToken, invalid)).status).toBe(400);
    }
    expect((await inventoryAt(centroId))!.physical).toBe(20n);
    expect(await db.stockMovement.count()).toBe(0);
  });

  it('rolls back the inventory delta and movement when the audit write fails late', async () => {
    const original = db.$transaction.bind(db);
    const spy = vi.spyOn(db, '$transaction').mockImplementation(((callback: (tx: Prisma.TransactionClient) => Promise<unknown>, options: object) =>
      original(async (tx) => {
        vi.spyOn(tx.auditLog, 'create').mockRejectedValueOnce(new Error('forced audit failure'));
        return callback(tx);
      }, options)) as typeof db.$transaction);
    try {
      expect((await load(adminToken, { variantId, branchId: centroId, quantity: '9' })).status).toBe(500);
    } finally {
      spy.mockRestore();
    }
    expect((await inventoryAt(centroId))!.physical).toBe(20n);
    expect(await db.stockMovement.count()).toBe(0);
    expect(await db.auditLog.count()).toBe(0);
  });

  it('represents concurrent additions exactly once each, including on a brand-new Inventory row', async () => {
    const product = await db.product.findUniqueOrThrow({ where: { slug: 'remera-basica' } });
    const fresh = await db.productVariant.create({
      data: { productId: product.id, sku: 'D3-RACE', barcode: 'D3-RACE', price: 1n, costPrice: 1n },
    });
    for (const target of [variantId, fresh.id]) {
      const start = (await inventoryAt(centroId, target))?.physical ?? 0n;
      const results = await Promise.all(
        ['3', '4', '5'].map((quantity) => load(adminToken, { variantId: target, branchId: centroId, quantity })),
      );
      expect(results.map((r) => r.status)).toEqual([201, 201, 201]);
      const after = (await inventoryAt(centroId, target))!;
      expect(after.physical).toBe(start + 12n);
      const movements = await db.stockMovement.findMany({ where: { inventoryId: after.id, type: 'INITIAL_STOCK' } });
      expect(movements.map((m) => m.quantityDelta).sort()).toEqual([3n, 4n, 5n]);
    }
  }, 120000);
});
