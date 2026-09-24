import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedDemo } from '../../prisma/seed.js';
import { createApp } from '../../src/app.js';
import type { Prisma } from '../../src/generated/prisma/client.js';
import { createSalesService } from '../../src/modules/sales/sales.service.js';
import { createTestPrismaClient, truncateAllTables } from '../helpers/test-db.js';
import { getAuthToken, createTestUser } from '../helpers/auth.js';
import { createRole } from '../helpers/factories.js';

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

  async function hold(saleId: string, quantity = 2n, options: { expiresAt?: Date; status?: 'ACTIVE' | 'RELEASED'; branchId?: string } = {}) {
    return prisma.stockReservation.create({
      data: {
        saleId, variantId, branchId: options.branchId ?? centroId, quantity, status: options.status ?? 'ACTIVE',
        expiresAt: options.expiresAt ?? new Date(Date.now() + 60 * 60 * 1000),
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
    // Phase 1D.3.1 SWITCH: gated on the Production SALE_QUEUE_VIEW grant now.
    const role = await prisma.role.findUniqueOrThrow({ where: { code: 'SELLER' } });
    const permission = await prisma.permission.findUniqueOrThrow({ where: { code: 'SALE_QUEUE_VIEW' } });
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
    expect((await queue('', sellerToken)).status).toBe(200);
  });

  it.each(['CASHIER', 'ADMIN'])('revokes access immediately without a %s role bypass', async (code) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { email: code === 'ADMIN' ? 'admin@demo.local' : 'cashier01@demo.local' } });
    const issuedToken = await getAuthToken(user);
    expect((await queue('', issuedToken)).status).toBe(200);
    // Phase 1D.3.1 SWITCH: gated on the Production SALE_QUEUE_VIEW grant now.
    const role = await prisma.role.findUniqueOrThrow({ where: { code } });
    const permission = await prisma.permission.findUniqueOrThrow({ where: { code: 'SALE_QUEUE_VIEW' } });
    await prisma.rolePermission.delete({ where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } } });
    expect((await queue('', issuedToken)).status).toBe(403);
  });

  // Phase 1D.3.1 §8: isolate the authority source explicitly — a caller
  // whose only grant is the Production uppercase code must be authorized,
  // and a caller whose only grant is the legacy lowercase code must be
  // rejected, once this route is switched.
  it('authorizes the pending-queue route via the Production SALE_QUEUE_VIEW grant alone, once switched', async () => {
    // Isolated via a fresh user, not a fresh role: authorization-context.ts
    // validates a persisted UserRoleScope's Role.code against the canonical
    // Production catalog (isProductionRoleCode) before it can ever become an
    // assignment — an arbitrary test-only role code would be skipped
    // entirely and prove nothing. CASHIER carries SALE_QUEUE_VIEW as its own
    // real default grant (role-permission-matrix.ts), so a brand-new CASHIER
    // user with no other state still isolates "the grant alone authorizes".
    const cashierRole = await prisma.role.findUniqueOrThrow({ where: { code: 'CASHIER' } });
    const user = await createTestUser(prisma, cashierRole.id, centroId);
    const isolatedToken = await getAuthToken(user);
    const response = await queue('', isolatedToken);
    expect(response.status).toBe(200);
  });

  it('rejects a legacy-lowercase-only grant on the pending-queue route once switched', async () => {
    const legacyPermission = await prisma.permission.upsert({ where: { code: 'sale.queue.view' }, create: { code: 'sale.queue.view' }, update: {} });
    const legacyRole = await createRole(prisma, 'LEGACY-ONLY-ROLE');
    await prisma.rolePermission.create({ data: { roleId: legacyRole.id, permissionId: legacyPermission.id } });
    const user = await createTestUser(prisma, legacyRole.id, centroId);
    const isolatedToken = await getAuthToken(user);
    const response = await queue('', isolatedToken);
    expect(response.status).toBe(403);
  });

  // Pilot P0.1-C: the cashier work queue is PENDING_PAYMENT + PAID, so a
  // fully paid sale stays visible until it is completed.
  it('includes PENDING_PAYMENT and PAID and excludes DRAFT, COMPLETED and CANCELLED', async () => {
    const included = await pending({ createdAt: new Date('2026-01-01T00:00:00.000Z') });
    const paid = await pending({ status: 'PAID', createdAt: new Date('2026-01-02T00:00:00.000Z') });
    for (const status of ['DRAFT', 'COMPLETED', 'CANCELLED'] as const) await pending({ status });
    const response = await queue();
    expect(response.status).toBe(200);
    expect(response.body.items.map((sale: { saleId: string }) => sale.saleId)).toEqual([included.id, paid.id]);
    expect(response.body.items.map((sale: { status: string }) => sale.status)).toEqual(['PENDING_PAYMENT', 'PAID']);
  });

  it('filters by current assignments and re-scopes an already issued token', async () => {
    const centroSale = await pending();
    const yerbaSale = await pending({ branchId: yerbaId });
    expect((await queue()).body.items.map((sale: { saleId: string }) => sale.saleId)).toEqual([centroSale.id]);
    // Phase 1C SWITCH: UserRoleScope is the authoritative LOCATION scope
    // source for req.auth.branchIds, not UserBranchRole — re-scope it
    // directly (seedDemo already backfilled cashier01 a UserRoleScope row
    // for Centro, so this is an update, not a create).
    await prisma.userRoleScope.updateMany({ where: { userId: cashierId }, data: { locationId: yerbaId } });
    expect((await queue()).body.items.map((sale: { saleId: string }) => sale.saleId)).toEqual([yerbaSale.id]);
    const role = await prisma.role.findUniqueOrThrow({ where: { code: 'CASHIER' } });
    await prisma.userRoleScope.create({
      data: { userId: cashierId, roleId: role.id, scopeKind: 'LOCATION', locationId: centroId },
    });
    expect((await queue()).body.items).toHaveLength(2);
  });

  it('handles an empty server-side branch scope safely at the service layer', async () => {
    await pending();
    expect(await createSalesService(prisma).listPendingSales([])).toEqual([]);
  });

  it('rejects a cashier with zero UserRoleScope rows (permission and scope now share one source)', async () => {
    // Phase 1D.3.1 SWITCH: permission and location both come from the same
    // UserRoleScope-derived assignment now (authorization-context.ts) —
    // unlike the pre-switch legacy model, there is no longer a
    // UserBranchRole-only path that can keep SALE_QUEUE_VIEW alive once every
    // UserRoleScope row is gone. Deleting them all removes the grant itself,
    // not just the branch scope, so this now correctly 403s.
    await prisma.userRoleScope.deleteMany({ where: { userId: cashierId } });
    const response = await queue();
    expect(response.status).toBe(403);
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
    // Pilot P0.1-C: a sale without items has no honest hold coverage, so it
    // is reported fail-closed as COVERAGE_INVALID and is not chargeable.
    expect(response.body.items).toEqual([{
      saleId: sale.id, saleNumber: sale.saleNumber, sellerName: 'Persisted seller name', status: 'PENDING_PAYMENT',
      items: [], subtotal: '9000000', total: '9000000', paidAmount: '0', remainingBalance: '9000000',
      holdState: 'COVERAGE_INVALID', canAcceptPayment: false,
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
      const extra = await pending(i % 2 === 0 ? {} : { status: 'PAID' });
      await addSnapshot(extra.id);
      await hold(extra.id, 2n);
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

  // Pilot P0.1-C: informational hold state. The payment transaction stays
  // authoritative; the queue only tells the cashier which action is valid.
  describe('hold state and chargeability (Pilot P0.1-C)', () => {
    const past = () => new Date(Date.now() - 60 * 60 * 1000);
    const row = async (saleId: string) => (await queue()).body.items.find((item: { saleId: string }) => item.saleId === saleId);
    const partial = (saleId: string, amount = 1000000n) =>
      prisma.salePayment.create({ data: { saleId, method: 'TRANSFER', amount, idempotencyKey: randomUUID() } });

    it('reports VALID for a zero-payment sale with exact unexpired coverage', async () => {
      const sale = await pending(); await addSnapshot(sale.id); await hold(sale.id);
      expect(await row(sale.id)).toMatchObject({ status: 'PENDING_PAYMENT', holdState: 'VALID', canAcceptPayment: true, remainingBalance: '9000000' });
    });

    it('reports EXPIRED for a zero-payment sale whose ACTIVE hold is past expiresAt', async () => {
      const sale = await pending(); await addSnapshot(sale.id); await hold(sale.id, 2n, { expiresAt: past() });
      expect(await row(sale.id)).toMatchObject({ holdState: 'EXPIRED', canAcceptPayment: false });
    });

    it('reports EXPIRED for a zero-payment sale whose hold was already RELEASED', async () => {
      const sale = await pending(); await addSnapshot(sale.id); await hold(sale.id, 2n, { expiresAt: past(), status: 'RELEASED' });
      expect(await row(sale.id)).toMatchObject({ status: 'PENDING_PAYMENT', holdState: 'EXPIRED', canAcceptPayment: false });
    });

    it('reports PAYMENT_PROTECTED for a partially paid sale past expiresAt, with the exact remaining balance', async () => {
      const sale = await pending(); await addSnapshot(sale.id); await hold(sale.id, 2n, { expiresAt: past() });
      await partial(sale.id, 1000001n);
      expect(await row(sale.id)).toMatchObject({
        holdState: 'PAYMENT_PROTECTED', canAcceptPayment: true, paidAmount: '1000001', remainingBalance: '7999999',
      });
    });

    it('reports PAID with a zero remaining balance after expiresAt, and no new payment action', async () => {
      const sale = await pending({ status: 'PAID' }); await addSnapshot(sale.id); await hold(sale.id, 2n, { expiresAt: past() });
      await partial(sale.id, 9000000n);
      expect(await row(sale.id)).toMatchObject({ status: 'PAID', holdState: 'PAID', canAcceptPayment: false, paidAmount: '9000000', remainingBalance: '0' });
    });

    it('reports COVERAGE_INVALID instead of hiding a mismatched or wrong-branch hold', async () => {
      const mismatched = await pending(); await addSnapshot(mismatched.id); await hold(mismatched.id, 1n);
      const wrongBranch = await pending(); await addSnapshot(wrongBranch.id); await hold(wrongBranch.id, 2n, { branchId: yerbaId });
      const protectedButBroken = await pending(); await addSnapshot(protectedButBroken.id); await partial(protectedButBroken.id);
      for (const sale of [mismatched, wrongBranch, protectedButBroken]) {
        expect(await row(sale.id)).toMatchObject({ holdState: 'COVERAGE_INVALID', canAcceptPayment: false });
      }
    });

    it('applies live location scope to PAID rows exactly like PENDING_PAYMENT rows', async () => {
      const paidAtYerba = await pending({ branchId: yerbaId, status: 'PAID' });
      expect((await queue()).body.items.map((sale: { saleId: string }) => sale.saleId)).not.toContain(paidAtYerba.id);
      await prisma.userRoleScope.updateMany({ where: { userId: cashierId }, data: { locationId: yerbaId } });
      expect((await queue()).body.items.map((sale: { saleId: string }) => sale.saleId)).toEqual([paidAtYerba.id]);
    });
  });
});
