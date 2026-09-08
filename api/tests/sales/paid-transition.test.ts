import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedDemo } from '../../prisma/seed.js';
import { createApp } from '../../src/app.js';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { createTestPrismaClient, truncateAllTables } from '../helpers/test-db.js';
import { getAuthToken } from '../helpers/auth.js';

describe('PENDING_PAYMENT to PAID transition', () => {
  let db: PrismaClient;
  let app: ReturnType<typeof createApp>;
  let sellerId: string;
  let cashierId: string;
  let branchId: string;
  let token: string;

  beforeAll(async () => {
    db = await createTestPrismaClient();
    app = createApp(db);
  }, 120000);

  beforeEach(async () => {
    await truncateAllTables(db);
    await seedDemo(db);
    const [seller, cashier, branch] = await Promise.all([
      db.user.findUniqueOrThrow({ where: { email: 'seller01@demo.local' } }),
      db.user.findUniqueOrThrow({ where: { email: 'cashier01@demo.local' } }),
      db.branch.findUniqueOrThrow({ where: { code: 'CEN' } }),
    ]);
    sellerId = seller.id;
    cashierId = cashier.id;
    branchId = branch.id;
    token = await getAuthToken(cashier);
  }, 120000);

  afterAll(async () => { await db?.$disconnect(); }, 120000);

  async function createSale(
    total: bigint = 16500000n,
    status: 'DRAFT' | 'PENDING_PAYMENT' | 'PAID' | 'COMPLETED' | 'CANCELLED' = 'PENDING_PAYMENT',
  ) {
    return db.sale.create({
      data: { sellerId, branchId, status, subtotal: total, total },
    });
  }

  function pay(saleId: string, body: object) {
    return request(app)
      .post(`/api/v1/sales/${saleId}/payments`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  async function acceptedTotal(saleId: string) {
    const payments = await db.salePayment.findMany({ where: { saleId }, select: { amount: true } });
    return payments.reduce((sum, payment) => sum + payment.amount, 0n);
  }

  async function openCashSession() {
    const register = await db.cashRegister.findFirstOrThrow({ where: { branchId } });
    return db.cashSession.create({
      data: { registerId: register.id, openedById: cashierId, startingCash: 0n, status: 'OPEN' },
    });
  }

  it('transitions only after exact multi-payment equality', async () => {
    const sale = await createSale();
    const first = await pay(sale.id, {
      method: 'TRANSFER', amount: '10000000', idempotencyKey: randomUUID(),
    });
    expect(first.status).toBe(201);
    expect((await db.sale.findUniqueOrThrow({ where: { id: sale.id } })).status).toBe('PENDING_PAYMENT');
    expect(await acceptedTotal(sale.id)).toBe(10000000n);

    const second = await pay(sale.id, {
      method: 'TRANSFER', amount: '6500000', idempotencyKey: randomUUID(),
    });
    expect(second.status).toBe(201);
    expect(await acceptedTotal(sale.id)).toBe(16500000n);
    expect((await db.sale.findUniqueOrThrow({ where: { id: sale.id } })).status).toBe('PAID');
  });

  it('transitions after one exact payment', async () => {
    const sale = await createSale();
    const response = await pay(sale.id, {
      method: 'CARD_DEBIT', amount: '16500000', idempotencyKey: randomUUID(),
    });
    expect(response.status).toBe(201);
    expect(response.body.amount).toBe('16500000');
    expect(await acceptedTotal(sale.id)).toBe(sale.total);
    expect((await db.sale.findUniqueOrThrow({ where: { id: sale.id } })).status).toBe('PAID');
  });

  it('does not transition after a partial split', async () => {
    const sale = await createSale();
    await pay(sale.id, { method: 'TRANSFER', amount: '10000000', idempotencyKey: randomUUID() });
    await pay(sale.id, { method: 'CARD_CREDIT', amount: '6000000', idempotencyKey: randomUUID() });
    expect(await acceptedTotal(sale.id)).toBe(16000000n);
    expect((await db.sale.findUniqueOrThrow({ where: { id: sale.id } })).status).toBe('PENDING_PAYMENT');
  });

  it('rejects overpayment without changing persisted payment or side-effect state', async () => {
    const sale = await createSale();
    await pay(sale.id, { method: 'TRANSFER', amount: '10000000', idempotencyKey: randomUUID() });
    const before = {
      payments: await db.salePayment.count({ where: { saleId: sale.id } }),
      movements: await db.cashMovement.count(),
      audits: await db.auditLog.count({ where: { action: 'PAYMENT_REGISTERED' } }),
    };
    const response = await pay(sale.id, {
      method: 'TRANSFER', amount: '6500001', idempotencyKey: randomUUID(),
    });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('OVERPAYMENT');
    expect(await acceptedTotal(sale.id)).toBe(10000000n);
    expect(await db.salePayment.count({ where: { saleId: sale.id } })).toBe(before.payments);
    expect(await db.cashMovement.count()).toBe(before.movements);
    expect(await db.auditLog.count({ where: { action: 'PAYMENT_REGISTERED' } })).toBe(before.audits);
    expect((await db.sale.findUniqueOrThrow({ where: { id: sale.id } })).status).toBe('PENDING_PAYMENT');
  });

  it('rejects a new payment on a PAID sale without side effects', async () => {
    const sale = await createSale(10n);
    await pay(sale.id, { method: 'TRANSFER', amount: '10', idempotencyKey: randomUUID() });
    const before = {
      payments: await db.salePayment.count({ where: { saleId: sale.id } }),
      movements: await db.cashMovement.count(),
      audits: await db.auditLog.count({ where: { action: 'PAYMENT_REGISTERED' } }),
    };
    const response = await pay(sale.id, {
      method: 'CARD_DEBIT', amount: '1', idempotencyKey: randomUUID(),
    });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('INVALID_SALE_STATE');
    expect(await db.salePayment.count({ where: { saleId: sale.id } })).toBe(before.payments);
    expect(await db.cashMovement.count()).toBe(before.movements);
    expect(await db.auditLog.count({ where: { action: 'PAYMENT_REGISTERED' } })).toBe(before.audits);
    expect((await db.sale.findUniqueOrThrow({ where: { id: sale.id } })).status).toBe('PAID');
  });

  it('replays the final payment after PAID idempotently', async () => {
    await openCashSession();
    const sale = await createSale(6500000n);
    const body = {
      method: 'CASH', amount: '6500000', receivedAmount: '7000000', idempotencyKey: randomUUID(),
    };
    const first = await pay(sale.id, body);
    const replay = await pay(sale.id, body);
    expect(first.status).toBe(201);
    expect(replay.status).toBe(200);
    expect(replay.body.id).toBe(first.body.id);
    expect((await db.sale.findUniqueOrThrow({ where: { id: sale.id } })).status).toBe('PAID');
    expect(await db.salePayment.count({ where: { saleId: sale.id } })).toBe(1);
    expect(await db.cashMovement.count({ where: { type: 'SALE_INCOME' } })).toBe(1);
    expect((await db.cashMovement.findFirstOrThrow({ where: { type: 'SALE_INCOME' } })).amount).toBe(6500000n);
    expect(await db.auditLog.count({ where: { action: 'PAYMENT_REGISTERED', entityId: first.body.id } })).toBe(1);
  });

  it.each(['DRAFT', 'COMPLETED', 'CANCELLED'] as const)('rejects a payment on %s', async (status) => {
    const sale = await createSale(10n, status);
    const before = await db.salePayment.count({ where: { saleId: sale.id } });
    const response = await pay(sale.id, {
      method: 'TRANSFER', amount: '10', idempotencyKey: randomUUID(),
    });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('INVALID_SALE_STATE');
    expect(await db.salePayment.count({ where: { saleId: sale.id } })).toBe(before);
    expect((await db.sale.findUniqueOrThrow({ where: { id: sale.id } })).status).toBe(status);
  });

  it('keeps exact BigInt values above Number.MAX_SAFE_INTEGER through the transition', async () => {
    const exact = '9007199254740993';
    const total = BigInt(exact);
    const sale = await createSale(total);
    const response = await pay(sale.id, {
      method: 'TRANSFER', amount: exact, idempotencyKey: randomUUID(),
    });
    expect(response.status).toBe(201);
    expect(response.body.amount).toBe(exact);
    expect(await acceptedTotal(sale.id)).toBe(total);
    expect((await db.sale.findUniqueOrThrow({ where: { id: sale.id } })).total).toBe(total);
    expect((await db.sale.findUniqueOrThrow({ where: { id: sale.id } })).status).toBe('PAID');
  });

  it('serializes competing final payments and accepts only one', async () => {
    const sale = await createSale();
    await pay(sale.id, { method: 'TRANSFER', amount: '10000000', idempotencyKey: randomUUID() });
    const [a, b] = await Promise.all([
      pay(sale.id, { method: 'TRANSFER', amount: '6500000', idempotencyKey: randomUUID() }),
      pay(sale.id, { method: 'CARD_DEBIT', amount: '6500000', idempotencyKey: randomUUID() }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(await acceptedTotal(sale.id)).toBe(16500000n);
    expect((await db.sale.findUniqueOrThrow({ where: { id: sale.id } })).status).toBe('PAID');
    expect(await db.salePayment.count({ where: { saleId: sale.id } })).toBe(2);
  });

  it('does not cross the Task 17 completion boundary when reaching PAID', async () => {
    const sale = await createSale();
    const before = {
      physical: await db.inventory.findMany({ orderBy: { id: 'asc' }, select: { id: true, physical: true, reserved: true } }),
      reservations: await db.stockReservation.count(),
      movements: await db.stockMovement.count(),
      saleAudits: await db.auditLog.count({ where: { entityType: 'Sale', entityId: sale.id } }),
    };
    const response = await pay(sale.id, {
      method: 'TRANSFER', amount: '16500000', idempotencyKey: randomUUID(),
    });
    expect(response.status).toBe(201);
    expect((await db.sale.findUniqueOrThrow({ where: { id: sale.id } })).status).toBe('PAID');
    expect(await db.inventory.findMany({ orderBy: { id: 'asc' }, select: { id: true, physical: true, reserved: true } })).toEqual(before.physical);
    expect(await db.stockReservation.count()).toBe(before.reservations);
    expect(await db.stockMovement.count()).toBe(before.movements);
    expect(await db.auditLog.count({ where: { entityType: 'Sale', entityId: sale.id } })).toBe(before.saleAudits);
    expect((await db.sale.findUniqueOrThrow({ where: { id: sale.id } })).status).not.toBe('COMPLETED');
  });
});
