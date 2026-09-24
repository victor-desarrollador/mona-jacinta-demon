import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedDemo } from '../../prisma/seed.js';
import { createApp } from '../../src/app.js';
import type { Prisma, PrismaClient } from '../../src/generated/prisma/client.js';
import { createCancellationService } from '../../src/modules/sales/cancellation.service.js';
import { createReservationService } from '../../src/modules/sales/reservation.service.js';
import { TECHNICAL_HOLD_TTL_MS } from '../../src/modules/sales/reservation-holds.js';
import { bootstrapSystemActor, SYSTEM_ACTOR_USER_ID } from '../../src/modules/audit/system-actor.service.js';
import { createTestPrismaClient, truncateAllTables } from '../helpers/test-db.js';
import { getAuthToken } from '../helpers/auth.js';

type SaleStatus = 'DRAFT' | 'PENDING_PAYMENT' | 'PAID' | 'COMPLETED' | 'CANCELLED';
type Variant = { id: string; productId: string; sku: string; price: bigint };

// Pilot P0.1-B1: one authoritative, idempotent, per-Sale release of expired
// zero-payment technical holds, shared by the manual INVENTORY_MANAGE
// endpoint (trigger ADMIN, caller is the audit actor) and automation
// (trigger SYSTEM, the dedicated inactive system actor).
describe('authoritative expired technical-hold release (Pilot P0.1-B1)', () => {
  const NOW = new Date('2030-01-01T12:00:00.000Z');
  const HOUR = 60 * 60 * 1000;
  const expired = new Date(NOW.getTime() - HOUR);
  const valid = new Date(NOW.getTime() + HOUR);

  let db: PrismaClient;
  let app: ReturnType<typeof createApp>;
  let service: ReturnType<typeof createCancellationService>;
  let sellerId: string;
  let adminId: string;
  let centroId: string;
  let depId: string;
  let remera: Variant;
  let jean: Variant;
  let saleCounter = 0;

  beforeAll(async () => {
    db = await createTestPrismaClient();
    app = createApp(db);
    service = createCancellationService(db);
  }, 120000);
  beforeEach(async () => {
    await truncateAllTables(db);
    await seedDemo(db);
    const [seller, admin, centro, dep, remeraVariant, jeanVariant] = await Promise.all([
      db.user.findUniqueOrThrow({ where: { email: 'seller01@demo.local' } }),
      db.user.findUniqueOrThrow({ where: { email: 'admin@demo.local' } }),
      db.branch.findUniqueOrThrow({ where: { code: 'CEN' } }),
      db.branch.findUniqueOrThrow({ where: { code: 'DEP' } }),
      db.productVariant.findUniqueOrThrow({ where: { sku: 'REM-NEG-M' }, select: { id: true, productId: true, sku: true, price: true } }),
      db.productVariant.findUniqueOrThrow({ where: { sku: 'JEA-AZU-42' }, select: { id: true, productId: true, sku: true, price: true } }),
    ]);
    sellerId = seller.id; adminId = admin.id; centroId = centro.id; depId = dep.id;
    remera = remeraVariant; jean = jeanVariant;
  }, 120000);
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => { await db?.$disconnect(); }, 120000);

  const admin = () => ({ userId: adminId, trigger: 'ADMIN' as const });
  const inventory = (variantId: string, branchId = centroId) =>
    db.inventory.findUniqueOrThrow({ where: { variantId_branchId: { variantId, branchId } } });
  const reservations = (saleId: string) => db.stockReservation.findMany({ where: { saleId }, orderBy: { id: 'asc' } });
  const releaseAudits = (saleId: string) => db.auditLog.findMany({ where: { action: 'RESERVATION_RELEASED', entityId: saleId } });

  // Realistic held sale: SaleItem + ACTIVE hold + matching counter increment.
  async function heldSale(options: {
    variant?: Variant;
    quantity?: bigint;
    expiresAt?: Date;
    branchId?: string;
    status?: SaleStatus;
    id?: string;
    lines?: Array<{ variant: Variant; quantity: bigint; expiresAt?: Date }>;
  } = {}) {
    const branchId = options.branchId ?? centroId;
    const lines = options.lines ?? [{ variant: options.variant ?? remera, quantity: options.quantity ?? 1n, expiresAt: options.expiresAt }];
    const total = lines.reduce((sum, line) => sum + line.quantity * line.variant.price, 0n);
    saleCounter += 1;
    const sale = await db.sale.create({
      data: {
        ...(options.id ? { id: options.id } : {}),
        sellerId, branchId, status: options.status ?? 'PENDING_PAYMENT', saleNumber: `T-EXP-${saleCounter}`,
        subtotal: total, total,
        items: { create: lines.map((line) => ({
          variantId: line.variant.id, productId: line.variant.productId, productName: 'Snapshot product',
          variantName: 'Snapshot variant', sku: line.variant.sku, quantity: line.quantity,
          unitPrice: line.variant.price, subtotal: line.quantity * line.variant.price,
        })) },
      },
    });
    for (const line of lines) {
      await db.inventory.update({
        where: { variantId_branchId: { variantId: line.variant.id, branchId } },
        data: { reserved: { increment: line.quantity } },
      });
      await db.stockReservation.create({
        data: { saleId: sale.id, variantId: line.variant.id, branchId, quantity: line.quantity, status: 'ACTIVE', expiresAt: line.expiresAt ?? options.expiresAt ?? expired },
      });
    }
    return sale;
  }
  const payment = (saleId: string, amount = 1n) =>
    db.salePayment.create({ data: { saleId, method: 'TRANSFER', amount, idempotencyKey: randomUUID() } });

  describe('TTL alignment', () => {
    it('creates reservations with the shared 30-minute technical-hold TTL', async () => {
      expect(TECHNICAL_HOLD_TTL_MS).toBe(30 * 60 * 1000);
      const draft = await db.sale.create({
        data: {
          sellerId, branchId: centroId, status: 'DRAFT', subtotal: remera.price, total: remera.price,
          items: { create: { variantId: remera.id, productId: remera.productId, productName: 'P', variantName: 'V', sku: remera.sku, quantity: 1n, unitPrice: remera.price, subtotal: remera.price } },
        },
      });
      const before = Date.now();
      await createReservationService(db).sendToCashier(draft.id, sellerId, [centroId]);
      const after = Date.now();
      const [hold] = await reservations(draft.id);
      expect(hold!.expiresAt.getTime()).toBeGreaterThanOrEqual(before + TECHNICAL_HOLD_TTL_MS);
      expect(hold!.expiresAt.getTime()).toBeLessThanOrEqual(after + TECHNICAL_HOLD_TTL_MS);
    });

    it('keeps no duplicated TTL literal in reservation creation', () => {
      const source = readFileSync(new URL('../../src/modules/sales/reservation.service.ts', import.meta.url), 'utf8');
      expect(source).toContain('TECHNICAL_HOLD_TTL_MS');
      expect(source).not.toMatch(/30\s*\*\s*60\s*\*\s*1000/);
    });
  });

  describe('per-Sale release unit', () => {
    it('releases an expired zero-payment hold exactly: RELEASED, reserved -Q, physical unchanged, no StockMovement, one audit', async () => {
      const sale = await heldSale({ quantity: 2n });
      const before = await inventory(remera.id);
      const outcome = await service.releaseExpiredSaleHolds(sale.id, { actor: admin(), now: NOW });
      expect(outcome).toEqual({ outcome: 'RELEASED', saleId: sale.id, branchId: centroId, quantities: [{ variantId: remera.id, quantity: 2n }] });
      expect((await reservations(sale.id)).map((row) => row.status)).toEqual(['RELEASED']);
      const after = await inventory(remera.id);
      expect(after.reserved).toBe(before.reserved - 2n);
      expect(after.physical).toBe(before.physical);
      expect(await db.stockMovement.count()).toBe(0);
      const audits = await releaseAudits(sale.id);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ userId: adminId, branchId: centroId, entityType: 'Sale', entityId: sale.id });
      expect(audits[0]!.after).toEqual({ saleId: sale.id, reason: 'EXPIRED', trigger: 'ADMIN', released: [{ variantId: remera.id, quantity: '2' }] });
      expect((await db.sale.findUniqueOrThrow({ where: { id: sale.id } })).status).toBe('PENDING_PAYMENT');
    });

    it('treats expiresAt == now as releasable and expiresAt > now as valid', async () => {
      const boundary = await heldSale({ expiresAt: new Date(NOW.getTime()) });
      const future = await heldSale({ expiresAt: new Date(NOW.getTime() + 1) });
      expect((await service.releaseExpiredSaleHolds(boundary.id, { actor: admin(), now: NOW })).outcome).toBe('RELEASED');
      expect((await service.releaseExpiredSaleHolds(future.id, { actor: admin(), now: NOW })).outcome).toBe('NOTHING_EXPIRED');
      expect((await reservations(future.id))[0]!.status).toBe('ACTIVE');
    });

    it('aggregates two expired rows of the same variant and releases only the expired rows of a mixed sale', async () => {
      const sale = await heldSale({ lines: [
        { variant: remera, quantity: 1n }, { variant: remera, quantity: 2n }, { variant: jean, quantity: 1n, expiresAt: valid },
      ] });
      const [remeraBefore, jeanBefore] = [await inventory(remera.id), await inventory(jean.id)];
      const outcome = await service.releaseExpiredSaleHolds(sale.id, { actor: admin(), now: NOW });
      expect(outcome).toMatchObject({ outcome: 'RELEASED', quantities: [{ variantId: remera.id, quantity: 3n }] });
      expect((await inventory(remera.id)).reserved).toBe(remeraBefore.reserved - 3n);
      expect((await inventory(jean.id)).reserved).toBe(jeanBefore.reserved);
      const rows = await reservations(sale.id);
      expect(rows.filter((row) => row.variantId === jean.id).map((row) => row.status)).toEqual(['ACTIVE']);
    });
  });

  describe('payment protection (Policy A, row existence)', () => {
    it('does not release, decrement or audit when any SalePayment row exists — even a zero-amount corrupt row', async () => {
      const partial = await heldSale();
      await payment(partial.id, 1n);
      const corrupt = await heldSale();
      await payment(corrupt.id, 0n);
      const before = await inventory(remera.id);
      for (const sale of [partial, corrupt]) {
        expect((await service.releaseExpiredSaleHolds(sale.id, { actor: admin(), now: NOW })).outcome).toBe('PAYMENT_PROTECTED');
        expect((await reservations(sale.id))[0]!.status).toBe('ACTIVE');
        expect(await releaseAudits(sale.id)).toHaveLength(0);
      }
      expect((await inventory(remera.id)).reserved).toBe(before.reserved);
    });
  });

  describe('state safety', () => {
    it('never releases PAID, COMPLETED, CANCELLED or DRAFT sales', async () => {
      const before = await inventory(remera.id);
      for (const status of ['PAID', 'COMPLETED', 'CANCELLED', 'DRAFT'] as const) {
        const sale = await heldSale({ status });
        expect((await service.releaseExpiredSaleHolds(sale.id, { actor: admin(), now: NOW })).outcome).toBe('NOT_PENDING');
        expect((await reservations(sale.id))[0]!.status).toBe('ACTIVE');
        expect(await releaseAudits(sale.id)).toHaveLength(0);
      }
      expect((await inventory(remera.id)).reserved).toBe(before.reserved + 4n);
      expect((await service.releaseExpiredSaleHolds(randomUUID(), { actor: admin(), now: NOW })).outcome).toBe('NOT_FOUND');
    });

    it('fails closed when a selected reservation belongs to another branch', async () => {
      const sale = await heldSale();
      await db.stockReservation.create({ data: { saleId: sale.id, variantId: jean.id, branchId: depId, quantity: 1n, status: 'ACTIVE', expiresAt: expired } });
      const before = await inventory(remera.id);
      await expect(service.releaseExpiredSaleHolds(sale.id, { actor: admin(), now: NOW })).rejects.toMatchObject({ code: 'INVALID_RESERVATION' });
      expect((await inventory(remera.id)).reserved).toBe(before.reserved);
      expect((await reservations(sale.id)).every((row) => row.status === 'ACTIVE')).toBe(true);
    });

    it('fails closed on counter drift for one variant without clamping or releasing the other variant', async () => {
      const sale = await heldSale({ lines: [{ variant: remera, quantity: 1n }, { variant: jean, quantity: 2n }] });
      await db.inventory.update({ where: { variantId_branchId: { variantId: jean.id, branchId: centroId } }, data: { reserved: 1n } });
      const remeraBefore = await inventory(remera.id);
      await expect(service.releaseExpiredSaleHolds(sale.id, { actor: admin(), now: NOW })).rejects.toMatchObject({ code: 'INVALID_RESERVATION' });
      expect((await inventory(remera.id)).reserved).toBe(remeraBefore.reserved);
      expect((await inventory(jean.id)).reserved).toBe(1n);
      expect((await reservations(sale.id)).every((row) => row.status === 'ACTIVE')).toBe(true);
      expect(await releaseAudits(sale.id)).toHaveLength(0);
    });
  });

  describe('idempotency and concurrency', () => {
    it('repeated release decrements once, audits once, and the second call is a no-op', async () => {
      const sale = await heldSale({ quantity: 2n });
      const before = await inventory(remera.id);
      await service.releaseExpiredSaleHolds(sale.id, { actor: admin(), now: NOW });
      const second = await service.releaseExpiredSaleHolds(sale.id, { actor: admin(), now: NOW });
      expect(second).toEqual({ outcome: 'NOTHING_EXPIRED', saleId: sale.id });
      expect((await inventory(remera.id)).reserved).toBe(before.reserved - 2n);
      expect(await releaseAudits(sale.id)).toHaveLength(1);
    });

    it('two concurrent releases of one sale mutate exactly once', async () => {
      const sale = await heldSale({ quantity: 2n });
      const before = await inventory(remera.id);
      const results = await Promise.allSettled([
        service.releaseExpiredSaleHolds(sale.id, { actor: admin(), now: NOW }),
        service.releaseExpiredSaleHolds(sale.id, { actor: admin(), now: NOW }),
      ]);
      const outcomes = results.map((result) => (result.status === 'fulfilled' ? result.value.outcome : (result.reason as { code?: string }).code));
      expect(outcomes.filter((outcome) => outcome === 'RELEASED')).toHaveLength(1);
      expect(outcomes.every((outcome) => ['RELEASED', 'NOTHING_EXPIRED', 'CONCURRENCY_ERROR'].includes(String(outcome)))).toBe(true);
      expect((await inventory(remera.id)).reserved).toBe(before.reserved - 2n);
      expect(await releaseAudits(sale.id)).toHaveLength(1);
      expect((await reservations(sale.id))[0]!.status).toBe('RELEASED');
    });

    it('release racing manual cancellation never double-decrements', async () => {
      const sale = await heldSale({ quantity: 2n });
      const before = await inventory(remera.id);
      const seller = await db.user.findUniqueOrThrow({ where: { id: sellerId } });
      const token = await getAuthToken(seller);
      const [cancelResult, releaseResult] = await Promise.allSettled([
        request(app).post(`/api/v1/sales/${sale.id}/cancel`).set('Authorization', `Bearer ${token}`),
        service.releaseExpiredSaleHolds(sale.id, { actor: admin(), now: NOW }),
      ]);
      expect(cancelResult.status).toBe('fulfilled');
      expect((await db.sale.findUniqueOrThrow({ where: { id: sale.id } })).status).toBe('CANCELLED');
      expect((await inventory(remera.id)).reserved).toBe(before.reserved - 2n);
      expect((await reservations(sale.id))[0]!.status).toBe('RELEASED');
      const releaseCount = (await releaseAudits(sale.id)).length;
      const cancelAudit = await db.auditLog.findFirstOrThrow({ where: { action: 'SALE_CANCELLED', entityId: sale.id } });
      const cancelReleased = (cancelAudit.after as { released: unknown[] }).released;
      // Exactly one of the two paths released the hold.
      expect(releaseCount + (cancelReleased.length > 0 ? 1 : 0)).toBe(1);
      if (releaseResult.status === 'fulfilled') expect(['RELEASED', 'NOT_PENDING', 'NOTHING_EXPIRED']).toContain(releaseResult.value.outcome);
    });
  });

  describe('rollback', () => {
    async function withFailingTx(fail: (tx: Prisma.TransactionClient) => void) {
      const original = db.$transaction.bind(db);
      vi.spyOn(db, '$transaction').mockImplementation(((callback: (tx: Prisma.TransactionClient) => Promise<unknown>, options: object) => original(async (tx) => {
        fail(tx);
        return callback(tx);
      }, options)) as typeof db.$transaction);
    }

    for (const [label, fail] of [
      ['Inventory update', (tx: Prisma.TransactionClient) => { vi.spyOn(tx.inventory, 'update').mockRejectedValueOnce(new Error('forced inventory failure')); }],
      ['reservation status update', (tx: Prisma.TransactionClient) => { vi.spyOn(tx.stockReservation, 'updateMany').mockRejectedValueOnce(new Error('forced status failure')); }],
      ['audit creation', (tx: Prisma.TransactionClient) => { vi.spyOn(tx.auditLog, 'create').mockRejectedValueOnce(new Error('forced audit failure')); }],
    ] as const) {
      it(`rolls back every write when ${label} fails`, async () => {
        const sale = await heldSale({ quantity: 2n });
        const before = await inventory(remera.id);
        await withFailingTx(fail);
        await expect(service.releaseExpiredSaleHolds(sale.id, { actor: admin(), now: NOW })).rejects.toThrow(/forced/);
        vi.restoreAllMocks();
        expect((await inventory(remera.id)).reserved).toBe(before.reserved);
        expect((await reservations(sale.id))[0]!.status).toBe('ACTIVE');
        expect(await releaseAudits(sale.id)).toHaveLength(0);
      });
    }

    it('retries a serialization abort after the attempt wrote everything, persisting only the retry', async () => {
      const sale = await heldSale({ quantity: 2n });
      const before = await inventory(remera.id);
      const original = db.$transaction.bind(db);
      let attempts = 0;
      vi.spyOn(db, '$transaction').mockImplementation(((callback: (tx: Prisma.TransactionClient) => Promise<unknown>, options: object) => original(async (tx) => {
        attempts += 1;
        const value = await callback(tx);
        // Abort the first attempt after every write, as PostgreSQL would at commit.
        if (attempts === 1) throw Object.assign(new Error('could not serialize access (40001)'), { code: 'P2034' });
        return value;
      }, options)) as typeof db.$transaction);
      const outcome = await service.releaseExpiredSaleHolds(sale.id, { actor: admin(), now: NOW });
      vi.restoreAllMocks();
      expect(attempts).toBe(2);
      expect(outcome.outcome).toBe('RELEASED');
      expect((await inventory(remera.id)).reserved).toBe(before.reserved - 2n);
      expect(await releaseAudits(sale.id)).toHaveLength(1);
    });

    it('rejects and rolls back when the hardened status update affects fewer rows than were locked', async () => {
      const sale = await heldSale();
      const before = await inventory(remera.id);
      await withFailingTx((tx) => { vi.spyOn(tx.stockReservation, 'updateMany').mockResolvedValueOnce({ count: 0 }); });
      await expect(service.releaseExpiredSaleHolds(sale.id, { actor: admin(), now: NOW })).rejects.toMatchObject({ code: 'INVALID_RESERVATION' });
      vi.restoreAllMocks();
      expect((await inventory(remera.id)).reserved).toBe(before.reserved);
      expect(await releaseAudits(sale.id)).toHaveLength(0);
    });
  });

  describe('batch orchestration', () => {
    it('isolates a corrupt sale: healthy sales before and after it still commit', async () => {
      const first = await heldSale({ id: '00000000-0000-4000-8000-0000000b0001', variant: remera });
      const corrupt = await heldSale({ id: '00000000-0000-4000-8000-0000000b0002', variant: jean });
      const last = await heldSale({ id: '00000000-0000-4000-8000-0000000b0003', variant: remera });
      await db.inventory.update({ where: { variantId_branchId: { variantId: jean.id, branchId: centroId } }, data: { reserved: 0n } });
      const result = await service.reconcileExpiredHolds({ actor: admin(), now: NOW, branchIds: [centroId] });
      expect(result.released.map((entry) => entry.saleId)).toEqual([first.id, last.id]);
      expect(result.failed).toEqual([{ saleId: corrupt.id, code: 'INVALID_RESERVATION' }]);
      expect((await reservations(first.id))[0]!.status).toBe('RELEASED');
      expect((await reservations(last.id))[0]!.status).toBe('RELEASED');
      expect((await reservations(corrupt.id))[0]!.status).toBe('ACTIVE');
    });

    it('discovers only releasable sales and respects the batch limit deterministically', async () => {
      const a = await heldSale({ id: '00000000-0000-4000-8000-0000000c0001' });
      const b = await heldSale({ id: '00000000-0000-4000-8000-0000000c0002' });
      const protectedSale = await heldSale({ id: '00000000-0000-4000-8000-0000000c0000' });
      await payment(protectedSale.id);
      await heldSale({ expiresAt: valid });
      const firstBatch = await service.reconcileExpiredHolds({ actor: admin(), now: NOW, branchIds: [centroId], limit: 1 });
      expect(firstBatch.released.map((entry) => entry.saleId)).toEqual([a.id]);
      const secondBatch = await service.reconcileExpiredHolds({ actor: admin(), now: NOW, branchIds: [centroId], limit: 1 });
      expect(secondBatch.released.map((entry) => entry.saleId)).toEqual([b.id]);
      expect(await service.reconcileExpiredHolds({ actor: admin(), now: NOW, branchIds: [centroId] })).toEqual({ released: [], failed: [] });
    });

    it('attributes SYSTEM releases to the dedicated inactive actor and fails closed without it', async () => {
      // The SYSTEM entry owns its wall clock, so fixtures are wall-relative.
      const sale = await heldSale({ expiresAt: new Date(Date.now() - HOUR) });
      await expect(service.releaseExpiredHoldsAsSystem()).rejects.toMatchObject({ code: 'SYSTEM_ACTOR_UNAVAILABLE' });
      expect((await reservations(sale.id))[0]!.status).toBe('ACTIVE');
      await bootstrapSystemActor(db, { createPasswordHash: async () => 'unusable-hash' });
      const result = await service.releaseExpiredHoldsAsSystem();
      expect(result.released.map((entry) => entry.saleId)).toEqual([sale.id]);
      const [audit] = await releaseAudits(sale.id);
      expect(audit).toMatchObject({ userId: SYSTEM_ACTOR_USER_ID, branchId: centroId });
      expect(audit!.after).toMatchObject({ reason: 'EXPIRED', trigger: 'SYSTEM' });
    });

    it('never lets a SYSTEM caller supply the clock: a smuggled future now cannot release unexpired holds', async () => {
      await bootstrapSystemActor(db, { createPasswordHash: async () => 'unusable-hash' });
      const notYetExpired = await heldSale({ expiresAt: new Date(Date.now() + HOUR) });
      const before = await inventory(remera.id);
      // @ts-expect-error — the SYSTEM boundary has no clock parameter.
      const result = await service.releaseExpiredHoldsAsSystem({ now: new Date(Date.now() + 365 * 24 * HOUR) });
      expect(result).toEqual({ released: [], failed: [] });
      expect((await reservations(notYetExpired.id))[0]!.status).toBe('ACTIVE');
      expect((await inventory(remera.id)).reserved).toBe(before.reserved);
      expect(await releaseAudits(notYetExpired.id)).toHaveLength(0);
    });
  });

  describe('manual endpoint scope', () => {
    it('a caller scoped to DEP releases DEP only and never CEN', async () => {
      // The HTTP endpoint uses the wall clock.
      const wallExpired = new Date(Date.now() - HOUR);
      const atDep = await heldSale({ branchId: depId, expiresAt: wallExpired });
      const atCentro = await heldSale({ branchId: centroId, expiresAt: wallExpired });
      const warehouse = await db.user.findUniqueOrThrow({ where: { email: 'warehouse01@demo.local' } });
      const response = await request(app).post('/api/v1/admin/reservations/release-expired').set('Authorization', `Bearer ${await getAuthToken(warehouse)}`);
      expect(response.status).toBe(200);
      expect(response.body.released.map((entry: { saleId: string }) => entry.saleId)).toEqual([atDep.id]);
      expect(response.body.failed).toEqual([]);
      expect((await reservations(atDep.id))[0]!.status).toBe('RELEASED');
      expect((await reservations(atCentro.id))[0]!.status).toBe('ACTIVE');
      const [audit] = await releaseAudits(atDep.id);
      expect(audit).toMatchObject({ userId: warehouse.id });
      expect(audit!.after).toMatchObject({ trigger: 'ADMIN' });
    });

    it('never combines INVENTORY_MANAGE at one location with a different assignment\'s location', async () => {
      // WAREHOUSE (INVENTORY_MANAGE) @ DEP + SELLER (no INVENTORY_MANAGE) @ CEN:
      // effectiveLocationIds covers both, but only DEP may be released.
      const wallExpired = new Date(Date.now() - HOUR);
      const atDep = await heldSale({ branchId: depId, expiresAt: wallExpired });
      const atCentro = await heldSale({ branchId: centroId, expiresAt: wallExpired });
      const [warehouseRole, sellerRole] = await Promise.all([
        db.role.findUniqueOrThrow({ where: { code: 'WAREHOUSE' } }),
        db.role.findUniqueOrThrow({ where: { code: 'SELLER' } }),
      ]);
      const multi = await db.user.create({ data: { name: 'multi-release', email: 'multi-release@test.local', passwordHash: 'x' } });
      await db.userRoleScope.createMany({ data: [
        { userId: multi.id, roleId: warehouseRole.id, scopeKind: 'LOCATION', locationId: depId },
        { userId: multi.id, roleId: sellerRole.id, scopeKind: 'LOCATION', locationId: centroId },
      ] });
      const response = await request(app).post('/api/v1/admin/reservations/release-expired').set('Authorization', `Bearer ${await getAuthToken(multi)}`);
      expect(response.status).toBe(200);
      expect(response.body.released.map((entry: { saleId: string }) => entry.saleId)).toEqual([atDep.id]);
      expect((await reservations(atCentro.id))[0]!.status).toBe('ACTIVE');
      expect(await releaseAudits(atCentro.id)).toHaveLength(0);
    });

    it('rechecks scope under the Sale lock even when called directly with a foreign sale', async () => {
      const atCentro = await heldSale({ branchId: centroId });
      const outcome = await service.releaseExpiredSaleHolds(atCentro.id, { actor: admin(), now: NOW, branchIds: [depId] });
      expect(outcome.outcome).toBe('OUT_OF_SCOPE');
      expect((await reservations(atCentro.id))[0]!.status).toBe('ACTIVE');
    });
  });
});
