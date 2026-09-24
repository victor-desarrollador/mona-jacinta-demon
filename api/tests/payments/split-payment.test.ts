import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedDemo } from '../../prisma/seed.js';
import { createApp } from '../../src/app.js';
import type { Prisma, PrismaClient } from '../../src/generated/prisma/client.js';
import { createTestPrismaClient, truncateAllTables } from '../helpers/test-db.js';
import { getAuthToken, createTestUser } from '../helpers/auth.js';

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
    const sale = await db.sale.create({ data: {
      sellerId, branchId, status, subtotal: total, total,
    } });
    if (status === 'PENDING_PAYMENT') await hold(sale.id, branchId);
    return sale;
  }

  // Pilot P0.1-C: a PENDING_PAYMENT sale is chargeable only with exact,
  // current ACTIVE hold coverage — one SaleItem + matching unexpired hold.
  async function hold(saleId: string, saleBranchId: string) {
    const variant = await db.productVariant.findUniqueOrThrow({ where: { sku: 'REM-NEG-M' } });
    await db.saleItem.create({ data: {
      saleId, variantId: variant.id, productId: variant.productId, productName: 'Snapshot product',
      variantName: 'Snapshot variant', sku: variant.sku, quantity: 1n, unitPrice: 1n, subtotal: 1n,
    } });
    await db.inventory.update({
      where: { variantId_branchId: { variantId: variant.id, branchId: saleBranchId } },
      data: { reserved: { increment: 1n } },
    });
    await db.stockReservation.create({ data: {
      saleId, variantId: variant.id, branchId: saleBranchId, quantity: 1n, status: 'ACTIVE',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
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
    // Phase 1D.3.2 SWITCH: /payments now gates on the Production SALE_CHARGE
    // grant (req.auth.assignments), not the legacy sale.charge code.
    const permission = await db.permission.findUniqueOrThrow({ where: { code: 'SALE_CHARGE' } });
    await db.rolePermission.delete({ where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } } });
    expect((await pay(sale.id, { method: 'TRANSFER', amount: '1', idempotencyKey: randomUUID() })).status).toBe(403);

    await db.role.update({ where: { id: role.id }, data: { code: 'ADMIN_LOOKALIKE' } });
    expect((await pay(sale.id, { method: 'TRANSFER', amount: '1', idempotencyKey: randomUUID() })).status).toBe(403);
  });

  // Phase 1D.3.2 §8: isolate the authority source explicitly. Fresh users on
  // real canonical roles (never an invented Role.code — isProductionRoleCode
  // fails closed on anything else) prove the grant alone decides, not the
  // shared demo cashier01/seller01 fixtures' incidental state.
  it('authorizes payment registration via the Production SALE_CHARGE grant alone', async () => {
    const cashierRole = await db.role.findUniqueOrThrow({ where: { code: 'CASHIER' } });
    const user = await createTestUser(db, cashierRole.id, branchId);
    const isolatedToken = await getAuthToken(user);
    const sale = await createSale(1n);
    const response = await pay(sale.id, { method: 'TRANSFER', amount: '1', idempotencyKey: randomUUID() }, isolatedToken);
    expect(response.status).toBe(201);
  });

  it('rejects a legacy-lowercase-only sale.charge grant on payment registration, once switched', async () => {
    // WAREHOUSE holds neither SALE_CHARGE nor SALE_VIEW by default
    // (role-permission-matrix.ts) — granting it only the legacy lowercase
    // code proves that grant alone can never satisfy the switched route.
    const warehouseRole = await db.role.findUniqueOrThrow({ where: { code: 'WAREHOUSE' } });
    const legacyPermission = await db.permission.upsert({ where: { code: 'sale.charge' }, create: { code: 'sale.charge' }, update: {} });
    await db.rolePermission.create({ data: { roleId: warehouseRole.id, permissionId: legacyPermission.id } });
    const user = await createTestUser(db, warehouseRole.id, branchId);
    const isolatedToken = await getAuthToken(user);
    const sale = await createSale(1n);
    const response = await pay(sale.id, { method: 'TRANSFER', amount: '1', idempotencyKey: randomUUID() }, isolatedToken);
    expect(response.status).toBe(403);
  });

  // Phase 1D.3.2 §4 cross-assignment security: a permission granted by one
  // assignment must never combine with a location granted by a different
  // assignment (authorization-policy.ts's hasPermissionAtLocation contract).
  it('SELLER @ A + CASHIER @ B: a SALE_CHARGE grant at B never authorizes charging a sale persisted at A', async () => {
    const otherBranch = await db.branch.findFirstOrThrow({ where: { id: { not: branchId } } });
    const sellerRole = await db.role.findUniqueOrThrow({ where: { code: 'SELLER' } });
    const cashierRole = await db.role.findUniqueOrThrow({ where: { code: 'CASHIER' } });
    const multi = await db.user.create({ data: { name: 'multi-charge', email: 'multi-charge@test.local', passwordHash: 'x' } });
    await db.userRoleScope.createMany({
      data: [
        { userId: multi.id, roleId: sellerRole.id, scopeKind: 'LOCATION', locationId: branchId },
        { userId: multi.id, roleId: cashierRole.id, scopeKind: 'LOCATION', locationId: otherBranch.id },
      ],
    });
    const multiToken = await getAuthToken(multi);
    const saleAtA = await createSale(1n);
    expect((await pay(saleAtA.id, { method: 'TRANSFER', amount: '1', idempotencyKey: randomUUID() }, multiToken)).status).toBe(403);
    const saleAtB = await db.sale.create({ data: { sellerId, branchId: otherBranch.id, status: 'PENDING_PAYMENT', subtotal: 1n, total: 1n } });
    await hold(saleAtB.id, otherBranch.id);
    expect((await pay(saleAtB.id, { method: 'TRANSFER', amount: '1', idempotencyKey: randomUUID() }, multiToken)).status).toBe(201);
  });

  it('requires the persisted sale branch and applies branch revocation to an existing JWT', async () => {
    const sale = await createSale(1n);
    const otherBranch = await db.branch.findFirstOrThrow({ where: { id: { not: branchId } } });
    // Branch-scope revocation: move the authoritative LOCATION scope only.
    // UserBranchRole (role/permission authority) stays valid for this assertion.
    await db.userRoleScope.updateMany({ where: { userId: cashierId, scopeKind: 'LOCATION' }, data: { locationId: otherBranch.id } });
    expect((await pay(sale.id, { method: 'TRANSFER', amount: '1', idempotencyKey: randomUUID() })).status).toBe(403);
  });

  it('grants payment registration on a fresh UserRoleScope location despite a stale UserBranchRole', async () => {
    // Phase 1C SWITCH: UserRoleScope is the sole LOCATION authority.
    // UserBranchRole (role/permission authority) stays at branchId — only
    // the scope moves — so this proves the legacy row can no longer veto
    // access to a location UserRoleScope has actually authorized.
    const otherBranch = await db.branch.findFirstOrThrow({ where: { id: { not: branchId } } });
    await db.userRoleScope.updateMany({ where: { userId: cashierId, scopeKind: 'LOCATION' }, data: { locationId: otherBranch.id } });
    const sale = await db.sale.create({ data: { sellerId, branchId: otherBranch.id, status: 'PENDING_PAYMENT', subtotal: 1n, total: 1n } });
    await hold(sale.id, otherBranch.id);
    const response = await pay(sale.id, { method: 'TRANSFER', amount: '1', idempotencyKey: randomUUID() });
    expect(response.status).toBe(201);
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
    // Branch-access revocation: mutate the authoritative LOCATION scope only.
    await db.userRoleScope.updateMany({ where: { userId: cashierId, scopeKind: 'LOCATION' }, data: { locationId: otherBranch.id } });
    expect((await request(app).get(`/api/v1/sales/${sale.id}/payments`).set('Authorization', `Bearer ${token}`)).status).toBe(403);
  });

  it('authorizes payment listing via the Production SALE_VIEW grant alone', async () => {
    // SELLER holds SALE_VIEW but not SALE_CHARGE by default
    // (role-permission-matrix.ts), isolating this from the charge-authority
    // proofs above.
    const sellerRole = await db.role.findUniqueOrThrow({ where: { code: 'SELLER' } });
    const user = await createTestUser(db, sellerRole.id, branchId);
    const isolatedToken = await getAuthToken(user);
    const sale = await createSale(1n);
    const response = await request(app).get(`/api/v1/sales/${sale.id}/payments`).set('Authorization', `Bearer ${isolatedToken}`);
    expect(response.status).toBe(200);
  });

  it('allows a bare COMPANY-scoped OWNER to register and list payments for a sale at any branch', async () => {
    const ownerRole = await db.role.findUniqueOrThrow({
      where: { code: 'OWNER' },
    });

    const owner = await db.user.create({
      data: {
        name: 'owner-payments',
        email: 'owner-payments@test.local',
        passwordHash: 'x',
      },
    });

    await db.userRoleScope.create({
      data: {
        userId: owner.id,
        roleId: ownerRole.id,
        scopeKind: 'COMPANY',
        locationId: null,
      },
    });

    const ownerToken = await getAuthToken(owner);
    const sale = await createSale(1n);

    const payResponse = await pay(
      sale.id,
      {
        method: 'TRANSFER',
        amount: '1',
        idempotencyKey: randomUUID(),
      },
      ownerToken,
    );

    expect(payResponse.status).toBe(201);

    const listResponse = await request(app)
      .get(`/api/v1/sales/${sale.id}/payments`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(listResponse.status).toBe(200);
  });

  it('rejects a legacy-lowercase-only sale.view grant on payment listing, once switched', async () => {
    const warehouseRole = await db.role.findUniqueOrThrow({ where: { code: 'WAREHOUSE' } });
    const legacyPermission = await db.permission.upsert({ where: { code: 'sale.view' }, create: { code: 'sale.view' }, update: {} });
    await db.rolePermission.create({ data: { roleId: warehouseRole.id, permissionId: legacyPermission.id } });
    const user = await createTestUser(db, warehouseRole.id, branchId);
    const isolatedToken = await getAuthToken(user);
    const sale = await createSale(1n);
    const response = await request(app).get(`/api/v1/sales/${sale.id}/payments`).set('Authorization', `Bearer ${isolatedToken}`);
    expect(response.status).toBe(403);
  });

  it('grants GET payment listing on a fresh UserRoleScope location despite a stale UserBranchRole', async () => {
    // Phase 1C SWITCH: UserRoleScope is the sole LOCATION authority.
    // UserBranchRole (role/permission authority) stays at branchId — only
    // the scope moves — so this proves the legacy row can no longer veto a
    // read that UserRoleScope has actually authorized.
    const otherBranch = await db.branch.findFirstOrThrow({ where: { id: { not: branchId } } });
    await db.userRoleScope.updateMany({ where: { userId: cashierId, scopeKind: 'LOCATION' }, data: { locationId: otherBranch.id } });
    const sale = await db.sale.create({ data: { sellerId, branchId: otherBranch.id, status: 'PENDING_PAYMENT', subtotal: 1n, total: 1n } });
    const response = await request(app).get(`/api/v1/sales/${sale.id}/payments`).set('Authorization', `Bearer ${token}`);
    expect(response.status).toBe(200);
  });

  it('rolls back payment, cash movement and status when audit persistence fails', async () => {
    await openCashSession();
    const sale = await createSale(10n);
    const transaction = db.$transaction.bind(db);
    vi.spyOn(db, '$transaction').mockImplementation(((callback: (tx: Prisma.TransactionClient) => Promise<unknown>, options: object) =>
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
