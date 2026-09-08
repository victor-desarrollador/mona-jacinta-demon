import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedDemo } from '../../prisma/seed.js';
import { createApp } from '../../src/app.js';
import type { Prisma } from '../../src/generated/prisma/client.js';
import { createSalesService } from '../../src/modules/sales/sales.service.js';
import { createTestPrismaClient, truncateAllTables } from '../helpers/test-db.js';
import { getAuthToken } from '../helpers/auth.js';

describe('cashier pending-sales queue', () => {
  let prisma: Awaited<ReturnType<typeof createTestPrismaClient>>;
  let app: ReturnType<typeof createApp>;
  let cashierId: string;
  let sellerId: string;
  let centroId: string;
  let yerbaId: string;
  let variantId: string;
  let productId: string;
  let token: string;

  beforeAll(async () => {
    prisma = await createTestPrismaClient();
    app = createApp(prisma);
  }, 120000);

  beforeEach(async () => {
    await truncateAllTables(prisma);
    await seedDemo(prisma);
    const [cashier, seller, centro, yerba, variant] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { email: 'cashier01@demo.local' } }),
      prisma.user.findUniqueOrThrow({ where: { email: 'seller01@demo.local' } }),
      prisma.branch.findUniqueOrThrow({ where: { code: 'CEN' } }),
      prisma.branch.findUniqueOrThrow({ where: { code: 'YB' } }),
      prisma.productVariant.findUniqueOrThrow({ where: { sku: 'REM-NEG-M' } }),
    ]);
    cashierId = cashier.id;
    sellerId = seller.id;
    centroId = centro.id;
    yerbaId = yerba.id;
    variantId = variant.id;
    productId = variant.productId;
    token = await getAuthToken(cashier);
  }, 120000);

  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => { await prisma?.$disconnect(); }, 120000);

  const queue = (query = '', accessToken = token, targetApp = app) =>
    request(targetApp).get(`/api/v1/sales/pending${query}`).set('Authorization', `Bearer ${accessToken}`);

  const pending = (data: Partial<Prisma.SaleUncheckedCreateInput> = {}) =>
    prisma.sale.create({
      data: {
        sellerId, branchId: centroId, status: 'PENDING_PAYMENT',
        saleNumber: `Q-${randomUUID()}`, subtotal: 9000000n, total: 9000000n,
        ...data,
      },
    });

  async function addSnapshot(saleId: string, unitPrice = 4500000n) {
    return prisma.saleItem.create({
      data: {
        saleId, variantId, productId, productName: 'Historical product',
        variantName: 'Historical color / size', sku: 'HISTORICAL-SKU',
        quantity: 2n, unitPrice, subtotal: unitPrice * 2n,
      },
    });
  }

  it('rejects unauthenticated requests', async () => {
    expect((await request(app).get('/api/v1/sales/pending')).status).toBe(401);
  });

  it('allows cashier01 and returns an empty queue before any pending sales', async () => {
    const response = await queue();
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ items: [] });
  });

  it('denies seller01 despite SALE_VIEW, but accepts a fresh explicit queue grant', async () => {
    const sellerToken = await getAuthToken({ id: sellerId });
    expect((await queue('', sellerToken)).status).toBe(403);
    const role = await prisma.role.findUniqueOrThrow({ where: { code: 'SELLER' } });
    const permission = await prisma.permission.findUniqueOrThrow({ where: { code: 'sale.queue.view' } });
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
    expect((await queue('', sellerToken)).status).toBe(200);
  });

  it.each(['CASHIER', 'ADMIN'])('revokes access immediately without a %s role bypass', async (code) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { email: code === 'ADMIN' ? 'admin@demo.local' : 'cashier01@demo.local' } });
    const issuedToken = await getAuthToken(user);
    expect((await queue('', issuedToken)).status).toBe(200);
    const role = await prisma.role.findUniqueOrThrow({ where: { code } });
    const permission = await prisma.permission.findUniqueOrThrow({ where: { code: 'sale.queue.view' } });
    await prisma.rolePermission.delete({ where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } } });
    expect((await queue('', issuedToken)).status).toBe(403);
  });

  it('includes only PENDING_PAYMENT and excludes every other lifecycle state', async () => {
    const included = await pending();
    for (const status of ['DRAFT', 'PAID', 'COMPLETED', 'CANCELLED'] as const) await pending({ status });
    const response = await queue();
    expect(response.status).toBe(200);
    expect(response.body.items.map((sale: { saleId: string }) => sale.saleId)).toEqual([included.id]);
  });

  it('filters by current assignments and re-scopes an already issued token', async () => {
    const centroSale = await pending();
    const yerbaSale = await pending({ branchId: yerbaId });
    expect((await queue()).body.items.map((sale: { saleId: string }) => sale.saleId)).toEqual([centroSale.id]);
    await prisma.userBranchRole.updateMany({ where: { userId: cashierId }, data: { branchId: yerbaId } });
    expect((await queue()).body.items.map((sale: { saleId: string }) => sale.saleId)).toEqual([yerbaSale.id]);
    const role = await prisma.role.findUniqueOrThrow({ where: { code: 'CASHIER' } });
    await prisma.userBranchRole.create({ data: { userId: cashierId, branchId: centroId, roleId: role.id } });
    expect((await queue()).body.items).toHaveLength(2);
  });

  it('returns no sales for an empty server-side branch scope', async () => {
    await pending();
    expect(await createSalesService(prisma).listPendingSales([])).toEqual([]);
    await prisma.userBranchRole.deleteMany({ where: { userId: cashierId } });
    expect((await queue()).status).toBe(403);
  });

  it('rejects branchId, repeated, array, nested and alternative query filters', async () => {
    await pending({ branchId: yerbaId });
    const queries = [
      `branchId=${yerbaId}`, `branchId=${centroId}&branchId=${yerbaId}`,
      `branchIds=${yerbaId}`, `branchIds[]=${yerbaId}`, `branchId[id]=${yerbaId}`,
      `filter[branchId]=${yerbaId}`, `branch_id=${yerbaId}`, `branch=${yerbaId}`,
      `branches=${yerbaId}`, `scope=all`, `filter=${encodeURIComponent(JSON.stringify({ branchId: yerbaId }))}`,
    ];
    for (const query of queries) {
      const response = await queue(`?${query}`);
      expect(response.status, query).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      expect(response.body.items).toBeUndefined();
    }
  });

  it('orders by createdAt ASC and then id ASC independent of insertion order', async () => {
    const date = new Date('2026-01-01T00:00:00.000Z');
    const later = await pending({ createdAt: new Date('2026-01-02T00:00:00.000Z') });
    const second = await pending({ id: '00000000-0000-4000-8000-000000000002', createdAt: date });
    const first = await pending({ id: '00000000-0000-4000-8000-000000000001', createdAt: date });
    expect((await queue()).body.items.map((sale: { saleId: string }) => sale.saleId)).toEqual([first.id, second.id, later.id]);
  });

  it('returns the persisted seller relationship, sale number and exact zero-payment totals', async () => {
    const sale = await pending();
    await prisma.user.update({ where: { id: sellerId }, data: { name: 'Persisted seller name' } });
    const response = await queue();
    expect(response.status).toBe(200);
    expect(response.body.items).toEqual([{
      saleId: sale.id, saleNumber: sale.saleNumber, sellerName: 'Persisted seller name',
      items: [], subtotal: '9000000', total: '9000000', paidAmount: '0', remainingBalance: '9000000',
    }]);
  });

  it('preserves SaleItem snapshots after catalog name, sku, price and variant changes', async () => {
    const sale = await pending();
    const item = await addSnapshot(sale.id);
    const before = (await queue()).body.items;
    await prisma.product.update({ where: { id: productId }, data: { name: 'Changed catalog product', isActive: false } });
    await prisma.productVariant.update({ where: { id: variantId }, data: { sku: 'CHANGED-SKU', color: 'Changed', size: 'XL', price: 1n, isActive: false } });
    const response = await queue();
    expect(response.status).toBe(200);
    expect(response.body.items).toEqual(before);
    expect(response.body.items[0].items).toEqual([{
      id: item.id, productId, variantId, productName: 'Historical product',
      variantName: 'Historical color / size', sku: 'HISTORICAL-SKU',
      quantity: '2', unitPrice: '4500000', subtotal: '9000000',
    }]);
  });

  it('sums persisted payment amounts and preserves centavos above MAX_SAFE_INTEGER', async () => {
    const price = 9007199254740993n;
    const sale = await pending({ subtotal: price * 2n, total: price * 2n - 1n });
    await addSnapshot(sale.id, price);
    await prisma.salePayment.createMany({ data: [
      { saleId: sale.id, method: 'TRANSFER', amount: price, idempotencyKey: 'transfer' },
      { saleId: sale.id, method: 'CASH', amount: 3n, receivedAmount: 10n, changeAmount: 7n, idempotencyKey: 'cash' },
    ] });
    const response = await queue();
    expect(response.status).toBe(200);
    expect(response.body.items[0]).toMatchObject({
      subtotal: '18014398509481986', total: '18014398509481985',
      paidAmount: '9007199254740996', remainingBalance: '9007199254740989',
      items: [{ unitPrice: '9007199254740993', subtotal: '18014398509481986' }],
    });
  });

  it('does not clamp the exact remaining balance or infer lifecycle from payments', async () => {
    const sale = await pending({ total: 5n });
    await prisma.salePayment.create({ data: { saleId: sale.id, method: 'TRANSFER', amount: 7n, idempotencyKey: 'persisted-payment' } });
    expect((await queue()).body.items[0]).toMatchObject({ paidAmount: '7', remainingBalance: '-2' });
    expect((await prisma.sale.findUniqueOrThrow({ where: { id: sale.id } })).status).toBe('PENDING_PAYMENT');
  });

  it('performs zero writes and uses a constant SQL query count as the queue grows', async () => {
    const sale = await pending();
    await addSnapshot(sale.id);
    await prisma.salePayment.create({ data: { saleId: sale.id, method: 'TRANSFER', amount: 1n, idempotencyKey: 'initial' } });
    const spy = vi.spyOn(Client.prototype, 'query');
    const sqlCalls = () => spy.mock.calls.map((call) => {
      const argument: unknown = call[0];
      return typeof argument === 'string' ? argument : (argument as { text: string }).text;
    });
    const small = await queue();
    expect(small.status).toBe(200);
    const smallSql = sqlCalls();
    expect(smallSql.length).toBeGreaterThan(0);
    spy.mockRestore();
    for (let i = 0; i < 5; i++) {
      const extra = await pending();
      await addSnapshot(extra.id);
      await prisma.salePayment.create({ data: { saleId: extra.id, method: 'TRANSFER', amount: 1n, idempotencyKey: 'extra' } });
    }
    const tables = ['Sale', 'SaleItem', 'SalePayment', 'Inventory', 'StockReservation', 'StockMovement', 'SaleNumberCounter', 'CashRegister', 'CashSession', 'CashMovement', 'AuditLog'];
    // Fixed test-owned table names; compare every row, including update timestamps.
    const snapshot = () => prisma.$queryRawUnsafe(`SELECT jsonb_build_object(${tables.map((table) => `'${table}', (SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]'::jsonb) FROM "${table}" t)`).join(', ')}) AS state`);
    const before = await snapshot();
    const largeSpy = vi.spyOn(Client.prototype, 'query');
    const large = await queue();
    const largeSql = largeSpy.mock.calls.map((call) => {
      const argument: unknown = call[0];
      return typeof argument === 'string' ? argument : (argument as { text: string }).text;
    });
    largeSpy.mockRestore();
    expect(large.status).toBe(200);
    expect(large.body.items).toHaveLength(6);
    expect(largeSql.length).toBe(smallSql.length);
    for (const sql of [...smallSql, ...largeSql]) expect(sql).toMatch(/^\s*SELECT\b/i);
    expect(await snapshot()).toEqual(before);
  });
});
