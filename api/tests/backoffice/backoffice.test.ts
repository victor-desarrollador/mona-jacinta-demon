import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedDemo } from '../../prisma/seed.js';
import { createApp } from '../../src/app.js';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { createTestPrismaClient, truncateAllTables } from '../helpers/test-db.js';
import { getAuthToken } from '../helpers/auth.js';

describe('backoffice read API', () => {
  let prisma: PrismaClient;
  let app: ReturnType<typeof createApp>;
  let branches: Record<string, string>;
  let users: Record<string, string>;
  let variants: Record<string, { id: string; productId: string; sku: string; price: bigint }>;

  beforeAll(async () => {
    prisma = await createTestPrismaClient();
    app = createApp(prisma);
  }, 120000);

  beforeEach(async () => {
    await truncateAllTables(prisma);
    await seedDemo(prisma);
    branches = Object.fromEntries(
      (await prisma.branch.findMany({ select: { code: true, id: true } })).map((branch) => [
        branch.code,
        branch.id,
      ]),
    );
    users = Object.fromEntries(
      (await prisma.user.findMany({ select: { email: true, id: true } })).map((user) => [
        user.email,
        user.id,
      ]),
    );
    variants = Object.fromEntries(
      (
        await prisma.productVariant.findMany({
          where: { sku: { in: ['REM-NEG-M', 'JEA-AZU-42'] } },
          select: { id: true, productId: true, sku: true, price: true },
        })
      ).map((variant) => [variant.sku, variant]),
    );
  }, 120000);

  afterAll(async () => prisma.$disconnect(), 120000);

  async function token(email: string) {
    return getAuthToken({ id: users[email]! });
  }

  async function get(path: string, email = 'manager01@demo.local') {
    return request(app).get(path).set('Authorization', `Bearer ${await token(email)}`);
  }

  async function createPendingSale(branchId = branches.CEN!) {
    const sellerId = users['seller01@demo.local']!;
    const remera = variants['REM-NEG-M']!;
    const jean = variants['JEA-AZU-42']!;
    return prisma.sale.create({
      data: {
        sellerId,
        branchId,
        saleNumber: `T-${branchId.slice(0, 6)}`,
        status: 'PENDING_PAYMENT',
        subtotal: 16500000n,
        total: 16500000n,
        items: {
          create: [
            {
              variantId: remera.id,
              productId: remera.productId,
              productName: 'Remera Basica',
              variantName: 'Negro / M',
              sku: remera.sku,
              quantity: 2n,
              unitPrice: 4500000n,
              subtotal: 9000000n,
            },
            {
              variantId: jean.id,
              productId: jean.productId,
              productName: 'Jean Slim',
              variantName: 'Azul / 42',
              sku: jean.sku,
              quantity: 1n,
              unitPrice: 7500000n,
              subtotal: 7500000n,
            },
          ],
        },
      },
    });
  }

  async function createPaidSale(branchId = branches.CEN!) {
    const sale = await createPendingSale(branchId);
    const register = await prisma.cashRegister.findFirstOrThrow({ where: { branchId } });
    const session = await prisma.cashSession.create({
      data: { registerId: register.id, openedById: users['cashier01@demo.local']!, startingCash: 0n },
    });
    await prisma.salePayment.create({
      data: {
        saleId: sale.id,
        method: 'CASH',
        amount: 16500000n,
        receivedAmount: 17000000n,
        changeAmount: 500000n,
        cashSessionId: session.id,
        idempotencyKey: 'cash-full',
        cashMovement: {
          create: {
            sessionId: session.id,
            type: 'SALE_INCOME',
            amount: 16500000n,
            userId: users['cashier01@demo.local']!,
          },
        },
      },
    });
    return prisma.sale.update({ where: { id: sale.id }, data: { status: 'PAID' } });
  }

  async function writeSnapshot() {
    const [
      sales,
      saleItems,
      salePayments,
      inventory,
      reservations,
      movements,
      cashSessions,
      cashMovements,
      audits,
    ] = await Promise.all([
      prisma.sale.count(),
      prisma.saleItem.count(),
      prisma.salePayment.count(),
      prisma.inventory.count(),
      prisma.stockReservation.count(),
      prisma.stockMovement.count(),
      prisma.cashSession.count(),
      prisma.cashMovement.count(),
      prisma.auditLog.count(),
    ]);
    return {
      sales,
      saleItems,
      salePayments,
      inventory,
      reservations,
      movements,
      cashSessions,
      cashMovements,
      audits,
    };
  }

  it('allows MANAGER to read own branch data', async () => {
    await createPendingSale();
    const response = await get('/api/v1/backoffice/sales');
    expect(response.status).toBe(200);
    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0].branch).toMatchObject({ id: branches.CEN, code: 'CEN' });
  });

  it('returns 403 when MANAGER queries an unauthorized branchId', async () => {
    const response = await get(`/api/v1/backoffice/sales?branchId=${branches.YB}`);
    expect(response.status).toBe(403);
  });

  it('allows ADMIN to read global authorized data', async () => {
    await createPendingSale(branches.CEN);
    await createPendingSale(branches.YB);
    const response = await get('/api/v1/backoffice/sales', 'admin@demo.local');
    expect(response.status).toBe(200);
    expect(response.body.items.map((sale: { branch: { code: string } }) => sale.branch.code).sort()).toEqual([
      'CEN',
      'YB',
    ]);
  });

  it('denies SELLER and CASHIER on REPORT_VIEW endpoints', async () => {
    expect((await get('/api/v1/backoffice/dashboard', 'seller01@demo.local')).status).toBe(403);
    expect((await get('/api/v1/backoffice/dashboard', 'cashier01@demo.local')).status).toBe(403);
  });

  it('denies /users without USER_MANAGE', async () => {
    expect((await get('/api/v1/backoffice/users')).status).toBe(403);
    expect((await get('/api/v1/backoffice/users', 'admin@demo.local')).status).toBe(200);
    expect((await get('/api/v1/backoffice/users', 'admin@demo.local')).body.items[0]).not.toHaveProperty('passwordHash');
  });

  it('denies sale detail from an unauthorized branch', async () => {
    const sale = await createPendingSale(branches.YB);
    const response = await get(`/api/v1/backoffice/sales/${sale.id}`);
    expect(response.status).toBe(403);
  });

  it('returns inventory available as physical minus reserved', async () => {
    const inventory = await prisma.inventory.findFirstOrThrow({ where: { branchId: branches.CEN } });
    await prisma.inventory.update({ where: { id: inventory.id }, data: { physical: 9n, reserved: 4n } });
    const response = await get(`/api/v1/backoffice/inventory?branchId=${branches.CEN}`);
    expect(response.status).toBe(200);
    const row = response.body.items.find((item: { id: string }) => item.id === inventory.id);
    expect(row).toMatchObject({ physical: '9', reserved: '4', available: '5' });
  });

  it('serializes sales/detail monetary BigInts as strings', async () => {
    const sale = await createPaidSale();
    const list = await get('/api/v1/backoffice/sales');
    expect(list.status).toBe(200);
    expect(list.body.items[0]).toMatchObject({
      subtotal: '16500000',
      total: '16500000',
      paymentSummary: { paidAmount: '16500000', remainingBalance: '0' },
    });
    const detail = await get(`/api/v1/backoffice/sales/${sale.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.sale.total).toBe('16500000');
    expect(detail.body.sale.items[0].unitPrice).toBeTypeOf('string');
    expect(detail.body.sale.payments[0]).toMatchObject({
      amount: '16500000',
      receivedAmount: '17000000',
      changeAmount: '500000',
      cashMovement: { amount: '16500000' },
    });
  });

  it('does not write from read-only endpoints', async () => {
    await createPaidSale();
    const before = await writeSnapshot();
    await get('/api/v1/backoffice/dashboard', 'admin@demo.local');
    await get('/api/v1/backoffice/sales', 'admin@demo.local');
    const sale = await prisma.sale.findFirstOrThrow();
    await get(`/api/v1/backoffice/sales/${sale.id}`, 'admin@demo.local');
    await get('/api/v1/backoffice/inventory', 'admin@demo.local');
    await get('/api/v1/backoffice/branches', 'admin@demo.local');
    await get('/api/v1/backoffice/users', 'admin@demo.local');
    expect(await writeSnapshot()).toEqual(before);
  });

  it('scopes dashboard aggregates to authorized branches', async () => {
    await createPendingSale(branches.CEN);
    await createPendingSale(branches.YB);
    const manager = await get('/api/v1/backoffice/dashboard');
    const admin = await get('/api/v1/backoffice/dashboard', 'admin@demo.local');
    expect(manager.status).toBe(200);
    expect(admin.status).toBe(200);
    expect(manager.body.pendingSalesCount).toBe(1);
    expect(admin.body.pendingSalesCount).toBe(2);
  });
});
