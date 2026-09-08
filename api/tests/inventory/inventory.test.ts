import { randomUUID } from 'node:crypto';
import request from 'supertest';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { seedDemo } from '../../prisma/seed.js';
import { createApp } from '../../src/app.js';
import { createInventoryService } from '../../src/modules/inventory/inventory.service.js';
import {
  createTestPrismaClient,
  truncateAllTables,
} from '../helpers/test-db.js';
import { getAuthToken } from '../helpers/auth.js';

describe('branch inventory read and availability', () => {
  let prisma: Awaited<ReturnType<typeof createTestPrismaClient>>;
  let app: ReturnType<typeof createApp>;
  let service: ReturnType<typeof createInventoryService>;
  let token: string;
  let sellerId: string;
  let centroId: string;
  let yerbaId: string;
  let remeraId: string;
  let jeanId: string;

  beforeAll(async () => {
    prisma = await createTestPrismaClient();
    app = createApp(prisma);
    service = createInventoryService(prisma);
  });
  beforeEach(async () => {
    await truncateAllTables(prisma);
    await seedDemo(prisma);
    const [seller, centro, yerba, remera, jean] = await Promise.all([
      prisma.user.findUniqueOrThrow({
        where: { email: 'seller01@demo.local' },
      }),
      prisma.branch.findUniqueOrThrow({ where: { code: 'CEN' } }),
      prisma.branch.findUniqueOrThrow({ where: { code: 'YB' } }),
      prisma.productVariant.findUniqueOrThrow({ where: { sku: 'REM-NEG-M' } }),
      prisma.productVariant.findUniqueOrThrow({ where: { sku: 'JEA-AZU-42' } }),
    ]);
    sellerId = seller.id;
    token = await getAuthToken(seller);
    centroId = centro.id;
    yerbaId = yerba.id;
    remeraId = remera.id;
    jeanId = jean.id;
  });
  afterAll(async () => prisma?.$disconnect());

  const get = (
    path = '',
    query: Record<string, unknown> = { branchId: centroId },
  ) =>
    request(app)
      .get(`/api/v1/inventory${path}`)
      .query(query)
      .set('Authorization', `Bearer ${token}`);

  it('requires authentication on both routes', async () => {
    for (const path of ['', '/availability']) {
      const response = await request(app)
        .get(`/api/v1/inventory${path}`)
        .query({ branchId: centroId });
      expect(response.status).toBe(401);
    }
  });

  it('uses current database permissions even with a previously issued token', async () => {
    await prisma.rolePermission.deleteMany({
      where: {
        role: { code: 'SELLER' },
        permission: { code: 'inventory.view' },
      },
    });
    for (const path of ['', '/availability'])
      expect((await get(path)).status).toBe(403);
  });

  it('returns only Centro inventory with safe quantities and POS product details', async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.body.items).toHaveLength(6);
    for (const row of response.body.items) {
      expect(row.branchId).toBe(centroId);
      for (const field of ['physical', 'reserved', 'available'])
        expect(typeof row[field]).toBe('string');
      expect(BigInt(row.available)).toBe(
        BigInt(row.physical) - BigInt(row.reserved),
      );
      expect(row.variant.product.name).toEqual(expect.any(String));
      expect(row.variant).not.toHaveProperty('costPrice');
      expect(row.variant).not.toHaveProperty('inventory');
    }
    for (const variantId of [remeraId, jeanId]) {
      expect(response.body.items).toContainEqual(
        expect.objectContaining({
          variantId,
          physical: '20',
          reserved: '0',
          available: '20',
        }),
      );
    }
  });

  it('rejects every other explicit branch before reading inventory', async () => {
    const otherBranches = await prisma.branch.findMany({
      where: { id: { not: centroId } },
    });
    const findMany = vi.spyOn(prisma.inventory, 'findMany');
    try {
      for (const branch of otherBranches) {
        for (const path of ['', '/availability']) {
          const response = await get(path, { branchId: branch.id });
          expect(response.status).toBe(403);
          expect(response.body).not.toHaveProperty('items');
        }
      }
      expect(findMany).not.toHaveBeenCalled();
    } finally {
      findMany.mockRestore();
    }
  });

  it('honors branch revocation after token issuance', async () => {
    await prisma.userBranchRole.updateMany({
      where: { userId: sellerId },
      data: { branchId: yerbaId },
    });
    expect((await get()).status).toBe(403);
    expect((await get('', { branchId: yerbaId })).status).toBe(200);
  });

  it('validates missing, malformed, repeated branch IDs and invalid variant filters', async () => {
    for (const path of ['', '/availability']) {
      for (const query of [
        {},
        { branchId: 'invalid' },
        { branchId: [centroId, yerbaId] },
      ]) {
        expect((await get(path, query)).status).toBe(400);
      }
    }
    expect(
      (await get('/availability', { branchId: centroId, variantId: 'invalid' }))
        .status,
    ).toBe(400);
    expect(
      (
        await get('/availability', {
          branchId: centroId,
          variantId: [remeraId, 'invalid'],
        })
      ).status,
    ).toBe(400);
  });

  it('supports one or repeated variantId filters at the JSON boundary', async () => {
    for (const variantId of [remeraId, [remeraId, jeanId]]) {
      const response = await get('/availability', {
        branchId: centroId,
        variantId,
      });
      expect(response.status).toBe(200);
      expect(
        response.body.items
          .map((row: { variantId: string }) => row.variantId)
          .sort(),
      ).toEqual((Array.isArray(variantId) ? variantId : [variantId]).sort());
      expect(response.body.items[0]).toMatchObject({
        physical: '20',
        reserved: '0',
        available: '20',
      });
    }
  });

  it('filters service availability and keeps BigInts internally', async () => {
    expect(await service.getAvailability(centroId, [remeraId])).toEqual([
      { variantId: remeraId, physical: 20n, reserved: 0n, available: 20n },
    ]);
    expect(await service.getAvailability(centroId)).toHaveLength(6);
    expect(await service.getAvailability(centroId, [])).toEqual([]);
  });

  it('passes the demo quantities using one batched inventory read', async () => {
    const findMany = vi.spyOn(prisma.inventory, 'findMany');
    try {
      await expect(
        service.checkAvailability(centroId, [
          { variantId: remeraId, quantity: 2n },
          { variantId: jeanId, quantity: 1n },
        ]),
      ).resolves.toBeUndefined();
      expect(findMany).toHaveBeenCalledTimes(1);
    } finally {
      findMany.mockRestore();
    }
  });

  it('rejects insufficient stock', async () => {
    await expect(
      service.checkAvailability(centroId, [
        { variantId: remeraId, quantity: 999n },
      ]),
    ).rejects.toMatchObject({ status: 409, code: 'INSUFFICIENT_STOCK' });
  });

  it('rejects unknown variants and variants without inventory in the requested branch', async () => {
    await expect(
      service.checkAvailability(centroId, [
        { variantId: randomUUID(), quantity: 1n },
      ]),
    ).rejects.toMatchObject({ status: 409, code: 'INSUFFICIENT_STOCK' });
    await prisma.inventory.deleteMany({
      where: { branchId: centroId, variantId: remeraId },
    });
    await expect(
      service.checkAvailability(centroId, [
        { variantId: remeraId, quantity: 1n },
      ]),
    ).rejects.toMatchObject({ status: 409, code: 'INSUFFICIENT_STOCK' });
  });

  it('subtracts reservations in both reads and checks', async () => {
    await prisma.inventory.update({
      where: {
        variantId_branchId: { variantId: remeraId, branchId: centroId },
      },
      data: { reserved: 5n },
    });
    expect(await service.getAvailability(centroId, [remeraId])).toEqual([
      { variantId: remeraId, physical: 20n, reserved: 5n, available: 15n },
    ]);
    const response = await get();
    expect(response.body.items).toContainEqual(
      expect.objectContaining({ variantId: remeraId, available: '15' }),
    );
    await expect(
      service.checkAvailability(centroId, [
        { variantId: remeraId, quantity: 15n },
      ]),
    ).resolves.toBeUndefined();
    await expect(
      service.checkAvailability(centroId, [
        { variantId: remeraId, quantity: 16n },
      ]),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });
  });

  it('aggregates duplicate variants so split lines cannot exceed availability', async () => {
    await expect(
      service.checkAvailability(centroId, [
        { variantId: remeraId, quantity: 11n },
        { variantId: remeraId, quantity: 10n },
      ]),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });
  });

  it('rejects non-positive or non-BigInt service quantities and malformed IDs', async () => {
    for (const quantity of [0n, -1n, 1.5, Number.MAX_SAFE_INTEGER + 1, '2']) {
      await expect(
        service.checkAvailability(centroId, [
          { variantId: remeraId, quantity: quantity as bigint },
        ]),
      ).rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
    }
    await expect(
      service.checkAvailability(centroId, [
        { variantId: 'invalid', quantity: 1n },
      ]),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('preserves precision above the safe JS number range', async () => {
    const physical = 9007199254740993n;
    await prisma.inventory.update({
      where: {
        variantId_branchId: { variantId: remeraId, branchId: centroId },
      },
      data: { physical, reserved: 2n },
    });
    const response = await get('/availability', {
      branchId: centroId,
      variantId: remeraId,
    });
    expect(response.body.items[0]).toMatchObject({
      physical: '9007199254740993',
      reserved: '2',
      available: '9007199254740991',
    });
    await expect(
      service.checkAvailability(centroId, [
        { variantId: remeraId, quantity: physical - 1n },
      ]),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });
  });

  it('never mutates inventory on reads, successful checks, or failed checks', async () => {
    const snapshot = () =>
      prisma.inventory.findMany({ orderBy: { id: 'asc' } });
    const before = await snapshot();
    await service.getAvailability(centroId);
    expect(await snapshot()).toEqual(before);
    await service.getInventoryByBranch(centroId);
    expect(await snapshot()).toEqual(before);
    await service.checkAvailability(centroId, [
      { variantId: remeraId, quantity: 2n },
    ]);
    expect(await snapshot()).toEqual(before);
    await expect(
      service.checkAvailability(centroId, [
        { variantId: remeraId, quantity: 999n },
      ]),
    ).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });
});
