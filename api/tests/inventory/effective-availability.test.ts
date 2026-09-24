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
import { createReservationService } from '../../src/modules/sales/reservation.service.js';
import { loadReleasableExpiredHolds } from '../../src/modules/sales/reservation-holds.js';
import {
  createTestPrismaClient,
  truncateAllTables,
} from '../helpers/test-db.js';
import { getAuthToken } from '../helpers/auth.js';

type SaleStatus = 'DRAFT' | 'PENDING_PAYMENT' | 'PAID' | 'COMPLETED' | 'CANCELLED';
type ReservationStatus = 'ACTIVE' | 'RELEASED' | 'CONSUMED';

// Pilot P0.1-A: read-side effective availability. A unit held only by an
// expired, zero-payment technical hold is reported as available; every
// other hold class stays protected. Reads never write.
describe('expiry-aware effective availability (Pilot P0.1-A)', () => {
  // Deterministic, injected instant for service-level tests.
  const NOW = new Date('2030-01-01T12:00:00.000Z');
  const HOUR = 60 * 60 * 1000;

  let prisma: Awaited<ReturnType<typeof createTestPrismaClient>>;
  let app: ReturnType<typeof createApp>;
  let service: ReturnType<typeof createInventoryService>;
  let token: string;
  let sellerId: string;
  let centroId: string;
  let yerbaId: string;
  let remera: { id: string; productId: string; sku: string; price: bigint };
  let jean: { id: string; productId: string; sku: string; price: bigint };
  let saleCounter = 0;

  beforeAll(async () => {
    prisma = await createTestPrismaClient();
    app = createApp(prisma);
    service = createInventoryService(prisma, { now: () => NOW });
  });
  beforeEach(async () => {
    await truncateAllTables(prisma);
    await seedDemo(prisma);
    const [seller, centro, yerba, remeraVariant, jeanVariant] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { email: 'seller01@demo.local' } }),
      prisma.branch.findUniqueOrThrow({ where: { code: 'CEN' } }),
      prisma.branch.findUniqueOrThrow({ where: { code: 'YB' } }),
      prisma.productVariant.findUniqueOrThrow({
        where: { sku: 'REM-NEG-M' },
        select: { id: true, productId: true, sku: true, price: true },
      }),
      prisma.productVariant.findUniqueOrThrow({
        where: { sku: 'JEA-AZU-42' },
        select: { id: true, productId: true, sku: true, price: true },
      }),
    ]);
    sellerId = seller.id;
    token = await getAuthToken(seller);
    centroId = centro.id;
    yerbaId = yerba.id;
    remera = remeraVariant;
    jean = jeanVariant;
  });
  afterAll(async () => prisma?.$disconnect());

  // Sets the persisted counter explicitly so each test states the raw
  // transitional state it starts from.
  async function setInventory(branchId: string, variantId: string, physical: bigint, reserved: bigint) {
    await prisma.inventory.update({
      where: { variantId_branchId: { variantId, branchId } },
      data: { physical, reserved },
    });
  }

  // A Sale with one SaleItem backed by one technical hold row. The counter
  // is set separately by setInventory.
  async function heldSale(options: {
    branchId: string;
    variant: typeof remera;
    quantity?: bigint;
    expiresAt: Date;
    status?: SaleStatus;
    reservationStatus?: ReservationStatus;
    partialPayment?: boolean;
  }) {
    const quantity = options.quantity ?? 1n;
    const total = quantity * options.variant.price;
    saleCounter += 1;
    const sale = await prisma.sale.create({
      data: {
        sellerId,
        branchId: options.branchId,
        status: options.status ?? 'PENDING_PAYMENT',
        saleNumber: `T-EA-${saleCounter}`,
        subtotal: total,
        total,
        items: {
          create: {
            variantId: options.variant.id,
            productId: options.variant.productId,
            productName: 'Snapshot product',
            variantName: 'Snapshot variant',
            sku: options.variant.sku,
            quantity,
            unitPrice: options.variant.price,
            subtotal: total,
          },
        },
      },
    });
    await prisma.stockReservation.create({
      data: {
        saleId: sale.id,
        variantId: options.variant.id,
        branchId: options.branchId,
        quantity,
        status: options.reservationStatus ?? 'ACTIVE',
        expiresAt: options.expiresAt,
      },
    });
    if (options.partialPayment) {
      // Minimal legitimate partial payment: non-cash, below the total.
      await prisma.salePayment.create({
        data: { saleId: sale.id, method: 'TRANSFER', amount: 1n, idempotencyKey: randomUUID() },
      });
    }
    return sale;
  }

  const expired = new Date(NOW.getTime() - HOUR);
  const valid = new Date(NOW.getTime() + HOUR);

  async function available(branchId: string, variantId: string) {
    const [row] = await service.getAvailability(branchId, [variantId]);
    return row;
  }

  it('reports a unit held only by an expired zero-payment hold as available', async () => {
    await setInventory(centroId, remera.id, 1n, 1n);
    await heldSale({ branchId: centroId, variant: remera, expiresAt: expired });
    expect(await available(centroId, remera.id)).toEqual({
      variantId: remera.id, physical: 1n, reserved: 1n, available: 1n,
    });
  });

  it('keeps an unexpired zero-payment hold blocking availability', async () => {
    await setInventory(centroId, remera.id, 1n, 1n);
    await heldSale({ branchId: centroId, variant: remera, expiresAt: valid });
    expect((await available(centroId, remera.id))!.available).toBe(0n);
  });

  it('protects an expired hold on a partially paid PENDING_PAYMENT sale (Policy A)', async () => {
    await setInventory(centroId, remera.id, 1n, 1n);
    await heldSale({ branchId: centroId, variant: remera, expiresAt: expired, partialPayment: true });
    expect((await available(centroId, remera.id))!.available).toBe(0n);
  });

  it('protects an ACTIVE hold of a PAID sale whatever its timestamp', async () => {
    await setInventory(centroId, remera.id, 1n, 1n);
    await heldSale({ branchId: centroId, variant: remera, expiresAt: expired, status: 'PAID' });
    expect((await available(centroId, remera.id))!.available).toBe(0n);
  });

  it('never treats RELEASED or CONSUMED history as a releasable contribution', async () => {
    // Raw counter drift of 1 with only historical rows: stays unavailable.
    await setInventory(centroId, remera.id, 1n, 1n);
    await heldSale({ branchId: centroId, variant: remera, expiresAt: expired, reservationStatus: 'RELEASED' });
    await heldSale({ branchId: centroId, variant: remera, expiresAt: expired, reservationStatus: 'CONSUMED' });
    expect((await available(centroId, remera.id))!.available).toBe(0n);
  });

  it('keeps unexpected ACTIVE rows on CANCELLED, COMPLETED or DRAFT sales conservatively unavailable', async () => {
    await setInventory(centroId, remera.id, 3n, 3n);
    for (const status of ['CANCELLED', 'COMPLETED', 'DRAFT'] as const) {
      await heldSale({ branchId: centroId, variant: remera, expiresAt: expired, status });
    }
    expect((await available(centroId, remera.id))!.available).toBe(0n);
  });

  it('sums several releasable sales and ignores a payment-protected one for the same variant', async () => {
    await setInventory(centroId, remera.id, 5n, 5n);
    await heldSale({ branchId: centroId, variant: remera, quantity: 2n, expiresAt: expired });
    await heldSale({ branchId: centroId, variant: remera, quantity: 1n, expiresAt: expired });
    await heldSale({ branchId: centroId, variant: remera, quantity: 1n, expiresAt: expired, partialPayment: true });
    await heldSale({ branchId: centroId, variant: remera, quantity: 1n, expiresAt: valid });
    expect((await available(centroId, remera.id))!.available).toBe(3n);
  });

  it('groups releasable quantities per variant', async () => {
    await setInventory(centroId, remera.id, 2n, 2n);
    await setInventory(centroId, jean.id, 2n, 2n);
    await heldSale({ branchId: centroId, variant: remera, quantity: 2n, expiresAt: expired });
    await heldSale({ branchId: centroId, variant: jean, quantity: 1n, expiresAt: expired });
    const rows = await service.getAvailability(centroId, [remera.id, jean.id]);
    const byVariant = new Map(rows.map((row) => [row.variantId, row.available]));
    expect(byVariant.get(remera.id)).toBe(2n);
    expect(byVariant.get(jean.id)).toBe(1n);
  });

  it('does not leak a releasable hold from one branch into another', async () => {
    await setInventory(centroId, remera.id, 1n, 1n);
    await setInventory(yerbaId, remera.id, 1n, 1n);
    await heldSale({ branchId: yerbaId, variant: remera, expiresAt: expired });
    // Yerba's own unit is pinned by an unexpired hold, Centro's by a valid one.
    await heldSale({ branchId: centroId, variant: remera, expiresAt: valid });
    expect((await available(centroId, remera.id))!.available).toBe(0n);
    expect((await available(yerbaId, remera.id))!.available).toBe(1n);
  });

  it('clamps effectiveReserved at zero when the raw counter is lower than the releasable sum', async () => {
    await setInventory(centroId, remera.id, 4n, 1n);
    await heldSale({ branchId: centroId, variant: remera, quantity: 3n, expiresAt: expired });
    const row = await available(centroId, remera.id);
    // Raw reserved stays the persisted diagnostic value; available never
    // exceeds physical.
    expect(row).toEqual({ variantId: remera.id, physical: 4n, reserved: 1n, available: 4n });
  });

  it('treats expiresAt == now as expired and expiresAt > now as valid', async () => {
    await setInventory(centroId, remera.id, 2n, 2n);
    await heldSale({ branchId: centroId, variant: remera, expiresAt: new Date(NOW.getTime()) });
    await heldSale({ branchId: centroId, variant: remera, expiresAt: new Date(NOW.getTime() + 1) });
    expect((await available(centroId, remera.id))!.available).toBe(1n);
  });

  it('uses the effective projection in getInventoryByBranch with raw reserved preserved', async () => {
    await setInventory(centroId, remera.id, 1n, 1n);
    await heldSale({ branchId: centroId, variant: remera, expiresAt: expired });
    const rows = await service.getInventoryByBranch(centroId);
    expect(rows.find((row) => row.variantId === remera.id)).toMatchObject({
      physical: 1n, reserved: 1n, available: 1n,
    });
  });

  it('lets checkAvailability pass when the counter is stale only because of a releasable hold', async () => {
    await setInventory(centroId, remera.id, 1n, 1n);
    await heldSale({ branchId: centroId, variant: remera, expiresAt: expired });
    await expect(
      service.checkAvailability(centroId, [{ variantId: remera.id, quantity: 1n }]),
    ).resolves.toBeUndefined();
  });

  it('still rejects a real shortage in checkAvailability', async () => {
    await setInventory(centroId, remera.id, 1n, 1n);
    await heldSale({ branchId: centroId, variant: remera, expiresAt: expired });
    await expect(
      service.checkAvailability(centroId, [{ variantId: remera.id, quantity: 2n }]),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });
    await setInventory(centroId, jean.id, 1n, 1n);
    await heldSale({ branchId: centroId, variant: jean, expiresAt: expired, partialPayment: true });
    await expect(
      service.checkAvailability(centroId, [{ variantId: jean.id, quantity: 1n }]),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });
  });

  it('uses one grouped reservation aggregate bounded to the caller branch', async () => {
    await setInventory(centroId, remera.id, 1n, 1n);
    await heldSale({ branchId: centroId, variant: remera, expiresAt: expired });
    const findMany = vi.spyOn(prisma.inventory, 'findMany');
    const groupBy = vi.spyOn(prisma.stockReservation, 'groupBy');
    try {
      await service.getInventoryByBranch(centroId);
      expect(findMany).toHaveBeenCalledTimes(1);
      expect(groupBy).toHaveBeenCalledTimes(1);
      const where = (groupBy.mock.calls[0]![0] as { where: { branchId: { in: string[] } } }).where;
      expect(where.branchId.in).toEqual([centroId]);
      findMany.mockClear();
      groupBy.mockClear();
      await service.checkAvailability(centroId, [
        { variantId: remera.id, quantity: 1n },
        { variantId: jean.id, quantity: 1n },
      ]);
      expect(findMany).toHaveBeenCalledTimes(1);
      expect(groupBy).toHaveBeenCalledTimes(1);
    } finally {
      findMany.mockRestore();
      groupBy.mockRestore();
    }
  });

  it('performs no writes on reads or prechecks, successful or failed', async () => {
    await setInventory(centroId, remera.id, 1n, 1n);
    await heldSale({ branchId: centroId, variant: remera, expiresAt: expired });
    const tables = ['Inventory', 'StockReservation', 'Sale', 'SalePayment', 'StockMovement', 'AuditLog'];
    // Fixed test-owned table names; compare every row, including timestamps.
    const snapshot = () => prisma.$queryRawUnsafe(`SELECT jsonb_build_object(${tables.map((table) => `'${table}', (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]'::jsonb) FROM "${table}" t)`).join(', ')}) AS state`);
    const before = await snapshot();
    await service.getAvailability(centroId);
    await service.getInventoryByBranch(centroId);
    await service.checkAvailability(centroId, [{ variantId: remera.id, quantity: 1n }]);
    await expect(
      service.checkAvailability(centroId, [{ variantId: remera.id, quantity: 2n }]),
    ).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
  });

  it('aggregates only the exact requested (branch, variant) pairs, never the IN x IN cross pairs', async () => {
    // Requested: (CEN, remera) and (YB, jean). Cross pairs (CEN, jean) and
    // (YB, remera) also hold releasable quantities and must not leak.
    await heldSale({ branchId: centroId, variant: remera, quantity: 1n, expiresAt: expired });
    await heldSale({ branchId: yerbaId, variant: jean, quantity: 2n, expiresAt: expired });
    await heldSale({ branchId: centroId, variant: jean, quantity: 4n, expiresAt: expired });
    await heldSale({ branchId: yerbaId, variant: remera, quantity: 8n, expiresAt: expired });
    const releasable = await loadReleasableExpiredHolds(
      prisma,
      [{ branchId: centroId, variantId: remera.id }, { branchId: yerbaId, variantId: jean.id }],
      NOW,
    );
    expect(releasable(centroId, remera.id)).toBe(1n);
    expect(releasable(yerbaId, jean.id)).toBe(2n);
    expect(releasable(centroId, jean.id)).toBe(0n);
    expect(releasable(yerbaId, remera.id)).toBe(0n);
  });

  // The lower reservation service invoked WITHOUT the P0.1-B2 pre-send
  // reconciliation (the HTTP send path wires that in via sales.service and
  // may release expired holds first): its locked transaction still validates
  // the raw persisted physical - reserved, whatever the read projection says.
  it('keeps the authoritative reserve transaction on raw physical - reserved without pre-send reconciliation', async () => {
    await setInventory(centroId, remera.id, 1n, 1n);
    await heldSale({ branchId: centroId, variant: remera, expiresAt: new Date(Date.now() - HOUR) });
    // The optimistic precheck admits the unit...
    await expect(
      createInventoryService(prisma).checkAvailability(centroId, [{ variantId: remera.id, quantity: 1n }]),
    ).resolves.toBeUndefined();
    const draft = await prisma.sale.create({
      data: {
        sellerId, branchId: centroId, status: 'DRAFT', subtotal: remera.price, total: remera.price,
        items: { create: {
          variantId: remera.id, productId: remera.productId, productName: 'Snapshot product',
          variantName: 'Snapshot variant', sku: remera.sku, quantity: 1n, unitPrice: remera.price, subtotal: remera.price,
        } },
      },
    });
    // ...but the locked physical - reserved validation still decides.
    await expect(
      createReservationService(prisma).sendToCashier(draft.id, sellerId, [centroId]),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });
    const inventory = await prisma.inventory.findUniqueOrThrow({
      where: { variantId_branchId: { variantId: remera.id, branchId: centroId } },
    });
    expect(inventory).toMatchObject({ physical: 1n, reserved: 1n });
    expect((await prisma.sale.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe('DRAFT');
  });

  it('serves the effective projection over HTTP with the wall clock', async () => {
    await setInventory(centroId, remera.id, 1n, 1n);
    await heldSale({ branchId: centroId, variant: remera, expiresAt: new Date(Date.now() - HOUR) });
    const response = await request(app)
      .get('/api/v1/inventory/availability')
      .query({ branchId: centroId, variantId: remera.id })
      .set('Authorization', `Bearer ${token}`);
    expect(response.status).toBe(200);
    expect(response.body.items[0]).toMatchObject({ physical: '1', reserved: '1', available: '1' });
  });
});
