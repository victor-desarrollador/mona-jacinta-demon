import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedDemo } from '../../prisma/seed.js';
import { createApp } from '../../src/app.js';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { createTestPrismaClient, truncateAllTables } from '../helpers/test-db.js';
import { getAuthToken } from '../helpers/auth.js';

describe('split payments', () => {
  let db: PrismaClient;
  let app: ReturnType<typeof createApp>;
  let cashierId: string;
  let sellerId: string;
  let branchId: string;
  let token: string;

  beforeAll(async () => {
    db = await createTestPrismaClient();
    app = createApp(db);
  }, 120000);

  beforeEach(async () => {
    await truncateAllTables(db);
    await seedDemo(db);
    const [cashier, seller, branch] = await Promise.all([
      db.user.findUniqueOrThrow({ where: { email: 'cashier01@demo.local' } }),
      db.user.findUniqueOrThrow({ where: { email: 'seller01@demo.local' } }),
      db.branch.findUniqueOrThrow({ where: { code: 'CEN' } }),
    ]);
    cashierId = cashier.id;
    sellerId = seller.id;
    branchId = branch.id;
    token = await getAuthToken(cashier);
  }, 120000);

  afterAll(async () => { await db?.$disconnect(); }, 120000);

  async function createSale(total = 16500000n, status: 'DRAFT' | 'PENDING_PAYMENT' | 'PAID' | 'COMPLETED' | 'CANCELLED' = 'PENDING_PAYMENT') {
    return db.sale.create({ data: {
      sellerId, branchId, status, subtotal: total, total,
    } });
  }

  function pay(saleId: string, body: object, accessToken = token) {
    return request(app).post(`/api/v1/sales/${saleId}/payments`)
      .set('Authorization', `Bearer ${accessToken}`).send(body);
  }

  async function openCashSession() {
    const register = await db.cashRegister.findFirstOrThrow({ where: { branchId } });
    return db.cashSession.create({ data: { registerId: register.id, openedById: cashierId, startingCash: 0n, status: 'OPEN' } });
  }

  it('requires authentication and validates the sale resource', async () => {
    const sale = await createSale();
    expect((await request(app).post(`/api/v1/sales/${sale.id}/payments`).send({})).status).toBe(401);
    expect((await pay(randomUUID(), { method: 'TRANSFER', amount: '1', idempotencyKey: randomUUID() })).status).toBe(404);
  });

  it('requires SALE_CHARGE and has no role-name bypass or stale permission', async () => {
    const sale = await createSale(1n);
    const role = await db.role.findUniqueOrThrow({ where: { code: 'CASHIER' } });
    const permission = await db.permission.findUniqueOrThrow({ where: { code: 'sale.charge' } });
    await db.rolePermission.delete({ where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } } });
    expect((await pay(sale.id, { method: 'TRANSFER', amount: '1', idempotencyKey: randomUUID() })).status).toBe(403);

    await db.role.update({ where: { id: role.id }, data: { code: 'ADMIN_LOOKALIKE' } });
    expect((await pay(sale.id, { method: 'TRANSFER', amount: '1', idempotencyKey: randomUUID() })).status).toBe(403);
  });

  it('requires the persisted sale branch and applies branch revocation to an existing JWT', async () => {
    const sale = await createSale(1n);
    const otherBranch = await db.branch.findFirstOrThrow({ where: { id: { not: branchId } } });
    await db.userBranchRole.updateMany({ where: { userId: cashierId }, data: { branchId: otherBranch.id } });
    expect((await pay(sale.id, { method: 'TRANSFER', amount: '1', idempotencyKey: randomUUID() })).status).toBe(403);
  });

  it.each(['DRAFT', 'PAID', 'COMPLETED', 'CANCELLED'] as const)('rejects a new payment for %s', async (status) => {
    const sale = await createSale(1n, status);
    const response = await pay(sale.id, { method: 'TRANSFER', amount: '1', idempotencyKey: randomUUID() });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('INVALID_SALE_STATE');
  });

  it('supports exact split payments and leaves partial payments pending', async () => {
    const sale = await createSale();
    expect((await pay(sale.id, { method: 'TRANSFER', amount: '10000000', idempotencyKey: randomUUID() })).status).toBe(201);
    const partial = await pay(sale.id, { method: 'CARD_DEBIT', amount: '6500000', idempotencyKey: randomUUID() });
    expect(partial.status).toBe(201);
    expect((await db.sale.findUniqueOrThrow({ where: { id: sale.id } })).status).toBe('PAID');

    const pending = await createSale();
    await pay(pending.id, { method: 'TRANSFER', amount: '10000000', idempotencyKey: randomUUID() });
    await pay(pending.id, { method: 'TRANSFER', amount: '6000000', idempotencyKey: randomUUID() });
    expect((await db.sale.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe('PENDING_PAYMENT');
  });

  it('rejects zero, negative, float, exponent and BIGINT overflow amounts without Number conversion', async () => {
    const sale = await createSale();
    for (const amount of ['0', '-1', '1.5', '1e3', '9223372036854775808']) {
      const response = await pay(sale.id, { method: 'TRANSFER', amount, idempotencyKey: randomUUID() });
      expect(response.status, amount).toBe(400);
    }
    const exact = '9007199254740993';
    const exactSale = await createSale(BigInt(exact));
    const response = await pay(exactSale.id, { method: 'TRANSFER', amount: exact, idempotencyKey: randomUUID() });
    expect(response.status).toBe(201);
    expect(response.body.amount).toBe(exact);
  });

  it('rejects overpayment beyond the remaining balance', async () => {
    const sale = await createSale(10n);
    const response = await pay(sale.id, { method: 'TRANSFER', amount: '11', idempotencyKey: randomUUID() });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('OVERPAYMENT');
  });

  it('replays the same intent after PAID without duplicate payment, audit or cash movement', async () => {
    await openCashSession();
    const sale = await createSale(6500000n);
    const body = { method: 'CASH', amount: '6500000', receivedAmount: '7000000', idempotencyKey: randomUUID() };
    const first = await pay(sale.id, body);
    const second = await pay(sale.id, body);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.changeAmount).toBe('500000');
    expect(await db.salePayment.count({ where: { saleId: sale.id } })).toBe(1);
    expect(await db.cashMovement.count({ where: { type: 'SALE_INCOME' } })).toBe(1);
    expect(await db.auditLog.count({ where: { action: 'PAYMENT_REGISTERED' } })).toBe(1);
    expect((await db.cashMovement.findFirstOrThrow({ where: { type: 'SALE_INCOME' } })).amount).toBe(6500000n);
  });

  it('rejects reuse with a different amount, method or received amount', async () => {
    await openCashSession();
    const sale = await createSale(10n);
    const key = randomUUID();
    expect((await pay(sale.id, { method: 'CASH', amount: '10', receivedAmount: '10', idempotencyKey: key })).status).toBe(201);
    for (const body of [
      { method: 'CASH', amount: '9', receivedAmount: '9', idempotencyKey: key },
      { method: 'TRANSFER', amount: '10', idempotencyKey: key },
      { method: 'CASH', amount: '10', receivedAmount: '11', idempotencyKey: key },
    ]) {
      expect((await pay(sale.id, body)).body.error.code).toBe('IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD');
    }
  });

  it('requires an open cash session and keeps non-cash payments independent of cash', async () => {
    const cashSale = await createSale(10n);
    const missing = await pay(cashSale.id, { method: 'CASH', amount: '10', receivedAmount: '10', idempotencyKey: randomUUID() });
    expect(missing.status).toBe(409);
    expect(missing.body.error.code).toBe('NO_OPEN_CASH_SESSION');
    const transferSale = await createSale(10n);
    expect((await pay(transferSale.id, { method: 'TRANSFER', amount: '10', receivedAmount: null, idempotencyKey: randomUUID() })).status).toBe(201);
    expect(await db.cashMovement.count({ where: { type: 'SALE_INCOME' } })).toBe(0);
  });

  it('serializes concurrent different intents against the Sale row', async () => {
    const sale = await createSale(10n);
    const responses = await Promise.all([
      pay(sale.id, { method: 'TRANSFER', amount: '10', idempotencyKey: randomUUID() }),
      pay(sale.id, { method: 'CARD_DEBIT', amount: '10', idempotencyKey: randomUUID() }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(await db.salePayment.count({ where: { saleId: sale.id } })).toBe(1);
    expect((await db.sale.findUniqueOrThrow({ where: { id: sale.id } })).status).toBe('PAID');
  });

  it('returns payments in deterministic order and enforces GET branch access without writes', async () => {
    const sale = await createSale(2n);
    const first = await pay(sale.id, { method: 'TRANSFER', amount: '1', idempotencyKey: randomUUID() });
    const second = await pay(sale.id, { method: 'CARD_DEBIT', amount: '1', idempotencyKey: randomUUID() });
    const before = await db.auditLog.count();
    const response = await request(app).get(`/api/v1/sales/${sale.id}/payments`).set('Authorization', `Bearer ${token}`);
    expect(response.status).toBe(200);
    expect(response.body.items.map((item: { id: string }) => item.id)).toEqual([first.body.id, second.body.id]);
    expect(await db.auditLog.count()).toBe(before);
    const otherBranch = await db.branch.findFirstOrThrow({ where: { id: { not: branchId } } });
    await db.userBranchRole.updateMany({ where: { userId: cashierId }, data: { branchId: otherBranch.id } });
    expect((await request(app).get(`/api/v1/sales/${sale.id}/payments`).set('Authorization', `Bearer ${token}`)).status).toBe(403);
  });

  it('rolls back payment, cash movement and status when audit persistence fails', async () => {
    await openCashSession();
    const sale = await createSale(10n);
    const transaction = db.$transaction.bind(db);
    vi.spyOn(db, '$transaction').mockImplementation(((callback: (tx: any) => Promise<unknown>, options: object) =>
      transaction(async (tx) => {
        vi.spyOn(tx.auditLog, 'create').mockRejectedValueOnce(new Error('forced audit failure'));
        return callback(tx);
      }, options)) as typeof db.$transaction);
    expect((await pay(sale.id, { method: 'CASH', amount: '10', receivedAmount: '10', idempotencyKey: randomUUID() })).status).toBe(500);
    expect(await db.salePayment.count()).toBe(0);
    expect(await db.cashMovement.count({ where: { type: 'SALE_INCOME' } })).toBe(0);
    expect((await db.sale.findUniqueOrThrow({ where: { id: sale.id } })).status).toBe('PENDING_PAYMENT');
    vi.restoreAllMocks();
  });
});
