import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedDemo } from '../../prisma/seed.js';
import { createApp } from '../../src/app.js';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { bootstrapSystemActor } from '../../src/modules/audit/system-actor.service.js';
import { createCancellationService } from '../../src/modules/sales/cancellation.service.js';
import { createTestPrismaClient, truncateAllTables } from '../helpers/test-db.js';
import { getAuthToken } from '../helpers/auth.js';
import { ensureOpenCashSession } from '../helpers/cash-session.js';

type Variant = { id: string; productId: string; sku: string; price: bigint };

// OWNER 2026-10-20 (OPTION_B_NON_EXPIRING_COMMITMENT), PostgreSQL TEST. PREPARED, NOT RUN:
// this file needs the TEST database and has not been executed (no DB authorisation).
// A normal sale's hold is a stock commitment that lives until CANCELLED / COMPLETED:
// no clock release (sweeper, pre-send reconciliation, manual endpoint) takes it, so a
// second sale can never take its unit and Inventory.reserved keeps protecting it.
describe('normal sale stock commitment does not expire by the clock', () => {
  const HOUR = 60 * 60 * 1000;
  const longAgo = () => new Date(Date.now() - 24 * HOUR);

  let db: PrismaClient;
  let app: ReturnType<typeof createApp>;
  let service: ReturnType<typeof createCancellationService>;
  let sellerId: string;
  let adminId: string;
  let centroId: string;
  let remera: Variant;
  let sellerToken: string;
  let cashierToken: string;
  let saleCounter = 0;

  beforeAll(async () => {
    db = await createTestPrismaClient();
    app = createApp(db);
    service = createCancellationService(db);
  }, 120000);
  beforeEach(async () => {
    await truncateAllTables(db);
    await seedDemo(db);
    await bootstrapSystemActor(db, { createPasswordHash: async () => 'unusable-hash' });
    const [seller, admin, cashier, centro, variant] = await Promise.all([
      db.user.findUniqueOrThrow({ where: { email: 'seller01@demo.local' } }),
      db.user.findUniqueOrThrow({ where: { email: 'admin@demo.local' } }),
      db.user.findUniqueOrThrow({ where: { email: 'cashier01@demo.local' } }),
      db.branch.findUniqueOrThrow({ where: { code: 'CEN' } }),
      db.productVariant.findUniqueOrThrow({ where: { sku: 'REM-NEG-M' }, select: { id: true, productId: true, sku: true, price: true } }),
    ]);
    sellerId = seller.id; adminId = admin.id; centroId = centro.id; remera = variant;
    sellerToken = await getAuthToken(seller);
    cashierToken = await getAuthToken(cashier);
    // System V2 P0-A: the legacy FIXED_TOTAL path takes CASH only (needs an open session).
    await ensureOpenCashSession(db, centro.id, cashier.id);
  }, 120000);
  afterAll(async () => { await db?.$disconnect(); }, 120000);

  const inventory = () => db.inventory.findUniqueOrThrow({ where: { variantId_branchId: { variantId: remera.id, branchId: centroId } } });
  const setInventory = (physical: bigint, reserved: bigint) =>
    db.inventory.update({ where: { variantId_branchId: { variantId: remera.id, branchId: centroId } }, data: { physical, reserved } });
  const holdsOf = (saleId: string) => db.stockReservation.findMany({ where: { saleId } });

  // A pending sale whose single ACTIVE hold carries a review date long past.
  async function pendingSale(quantity = 1n) {
    saleCounter += 1;
    const sale = await db.sale.create({
      data: {
        sellerId, branchId: centroId, status: 'PENDING_PAYMENT', saleNumber: `T-NSC-${saleCounter}`, priceMode: 'LIST',
        subtotal: remera.price * quantity, total: remera.price * quantity,
        items: { create: { variantId: remera.id, productId: remera.productId, productName: 'P', variantName: 'V', sku: remera.sku, quantity, unitPrice: remera.price, subtotal: remera.price * quantity } },
      },
    });
    await db.inventory.update({ where: { variantId_branchId: { variantId: remera.id, branchId: centroId } }, data: { reserved: { increment: quantity } } });
    await db.stockReservation.create({ data: { saleId: sale.id, variantId: remera.id, branchId: centroId, quantity, status: 'ACTIVE', expiresAt: longAgo() } });
    return sale;
  }
  const draft = () => db.sale.create({
    data: {
      sellerId, branchId: centroId, status: 'DRAFT', subtotal: remera.price, total: remera.price,
      items: { create: { variantId: remera.id, productId: remera.productId, productName: 'P', variantName: 'V', sku: remera.sku, quantity: 1n, unitPrice: remera.price, subtotal: remera.price } },
    },
  });

  it('RED 7 / adversarial: a second sale cannot take the unit of an old pending sale, and the first keeps its reserved', async () => {
    await setInventory(1n, 0n);
    const first = await pendingSale();
    expect(await inventory()).toMatchObject({ physical: 1n, reserved: 1n });
    const second = await draft();
    const response = await request(app).post(`/api/v1/sales/${second.id}/send-to-cashier`).set('Authorization', `Bearer ${sellerToken}`);
    expect(response.status).toBe(409);
    expect(JSON.stringify(response.body)).toContain('INSUFFICIENT_STOCK');
    expect((await holdsOf(first.id)).map((row) => row.status)).toEqual(['ACTIVE']);
    expect(await inventory()).toMatchObject({ physical: 1n, reserved: 1n });
    expect(await db.auditLog.count({ where: { action: 'RESERVATION_RELEASED' } })).toBe(0);
  });

  it('RED 7: no clock release path takes an old pending hold (SYSTEM, manual endpoint, direct per-sale release)', async () => {
    await setInventory(2n, 0n);
    const sale = await pendingSale();
    expect((await service.releaseExpiredHoldsAsSystem()).released).toEqual([]);
    expect((await service.releaseExpiredReservations({ userId: adminId, branchIds: [centroId] })).released).toEqual([]);
    expect(await service.releaseExpiredSaleHolds(sale.id, { actor: { userId: adminId, trigger: 'ADMIN' }, now: new Date() }))
      .toMatchObject({ outcome: 'NOTHING_EXPIRED' });
    expect((await holdsOf(sale.id)).map((row) => row.status)).toEqual(['ACTIVE']);
    expect(await inventory()).toMatchObject({ physical: 2n, reserved: 1n });
    expect(await db.auditLog.count({ where: { action: 'RESERVATION_RELEASED' } })).toBe(0);
  });

  it('RED 2: a FIXED_TOTAL first payment on an old hold is accepted and the hold stays ACTIVE', async () => {
    await setInventory(1n, 0n);
    const sale = await pendingSale();
    const response = await request(app).post(`/api/v1/sales/${sale.id}/payments`).set('Authorization', `Bearer ${cashierToken}`)
      .send({ method: 'CASH', amount: String(remera.price), receivedAmount: String(remera.price), idempotencyKey: randomUUID() });
    expect(response.status).toBe(201);
    expect((await db.sale.findUniqueOrThrow({ where: { id: sale.id } })).status).toBe('PAID');
    expect((await holdsOf(sale.id)).map((row) => row.status)).toEqual(['ACTIVE']);
  });

  it('RED 6: cancelling an old pending sale releases its commitment', async () => {
    await setInventory(1n, 0n);
    const sale = await pendingSale();
    const response = await request(app).post(`/api/v1/sales/${sale.id}/cancel`).set('Authorization', `Bearer ${cashierToken}`)
      .send({ reason: 'CUSTOMER_CHANGED_MIND' });
    expect(response.status).toBe(200);
    expect(await inventory()).toMatchObject({ physical: 1n, reserved: 0n });
    expect((await holdsOf(sale.id)).map((row) => row.status)).toEqual(['RELEASED']);
    expect((await db.sale.findUniqueOrThrow({ where: { id: sale.id } })).status).toBe('CANCELLED');
  });

  const complete = (saleId: string, token: string) =>
    request(app).post(`/api/v1/sales/${saleId}/complete`).set('Authorization', `Bearer ${token}`).send({});
  const pay = (saleId: string, amount: bigint, token = cashierToken) =>
    request(app).post(`/api/v1/sales/${saleId}/payments`).set('Authorization', `Bearer ${token}`)
      .send({ method: 'CASH', amount: String(amount), receivedAmount: String(amount), idempotencyKey: randomUUID() });

  it('RED 4: pay then complete consumes the old commitment atomically (physical, reserved, hold, movement, audit)', async () => {
    await setInventory(3n, 0n);
    const sale = await pendingSale(2n);
    expect(await inventory()).toMatchObject({ physical: 3n, reserved: 2n });
    expect((await pay(sale.id, remera.price * 2n)).status).toBe(201);
    expect((await complete(sale.id, cashierToken)).status).toBe(200);
    expect((await db.sale.findUniqueOrThrow({ where: { id: sale.id } })).status).toBe('COMPLETED');
    expect(await inventory()).toMatchObject({ physical: 1n, reserved: 0n });
    expect((await holdsOf(sale.id)).map((row) => row.status)).toEqual(['CONSUMED']);
    const movements = await db.stockMovement.findMany({ where: { saleId: sale.id } });
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({ type: 'SALE', quantityDelta: -2n });
    expect(await db.auditLog.count({ where: { action: 'SALE_COMPLETED', entityId: sale.id } })).toBe(1);
    expect(await db.auditLog.count({ where: { action: 'RESERVATION_RELEASED' } })).toBe(0);
  });

  it('WHOLESALE: an old hold changes nothing — confirmation is still required, then pay and complete consume it', async () => {
    await setInventory(2n, 0n);
    const sale = await pendingSale();
    await db.sale.update({ where: { id: sale.id }, data: { pricingMode: 'WHOLESALE', wholesaleAuthorizedAt: new Date() } });

    const early = await pay(sale.id, remera.price);
    expect(early.status).toBe(409);
    expect(JSON.stringify(early.body)).toContain('WHOLESALE_CONFIRMATION_REQUIRED');
    expect(await db.salePayment.count({ where: { saleId: sale.id } })).toBe(0);
    expect((await holdsOf(sale.id)).map((row) => row.status)).toEqual(['ACTIVE']);

    const confirmed = await request(app).post(`/api/v1/sales/${sale.id}/wholesale/confirm`).set('Authorization', `Bearer ${cashierToken}`).send({});
    expect(confirmed.status).toBe(200);
    expect((await pay(sale.id, remera.price)).status).toBe(201);
    expect((await complete(sale.id, cashierToken)).status).toBe(200);
    expect(await inventory()).toMatchObject({ physical: 1n, reserved: 0n });
    expect((await holdsOf(sale.id)).map((row) => row.status)).toEqual(['CONSUMED']);
  });

  it('a send still creates an ACTIVE hold stamped with the shared 30-minute review date (informational only)', async () => {
    await setInventory(1n, 0n);
    const sale = await draft();
    const before = Date.now();
    const response = await request(app).post(`/api/v1/sales/${sale.id}/send-to-cashier`).set('Authorization', `Bearer ${sellerToken}`);
    expect(response.status).toBe(200);
    const [hold] = await holdsOf(sale.id);
    expect(hold!.status).toBe('ACTIVE');
    expect(hold!.expiresAt.getTime() - before).toBeGreaterThan(29 * 60_000);
    expect(hold!.expiresAt.getTime() - before).toBeLessThan(31 * 60_000);
    expect(await inventory()).toMatchObject({ physical: 1n, reserved: 1n });
  });
});
