import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedDemo } from '../../prisma/seed.js';
import { createApp } from '../../src/app.js';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { createTestPrismaClient, truncateAllTables } from '../helpers/test-db.js';
import { getAuthToken, createTestUser } from '../helpers/auth.js';
import { createRole } from '../helpers/factories.js';

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
    // Phase 1D.3.5 SWITCH: Backoffice REPORT_VIEW/USER_MANAGE now gate on
    // Production assignments (req.auth.assignments), not legacy UserBranchRole
    // report.view/user.manage. Legacy MANAGER maps to Production WAREHOUSE
    // (legacy-role-map.ts), which carries neither REPORT_VIEW nor USER_MANAGE
    // by default (role-permission-matrix.ts) — MANAGER can no longer stand in
    // as "the authorized single-branch caller" these tests need. ADMIN is the
    // only canonical role granted every Production permission by default, and
    // can still be LOCATION-scoped during the pre-1D.4.1-backfill
    // compatibility window this task must keep working under — a fresh
    // LOCATION-scoped ADMIN user replaces MANAGER as the default authorized,
    // single-branch caller.
    const adminRole = await prisma.role.findUniqueOrThrow({ where: { code: 'ADMIN' } });
    const scopedAdmin = await createTestUser(prisma, adminRole.id, branches.CEN!);
    users['scoped-admin'] = scopedAdmin.id;
  }, 120000);

  afterAll(async () => prisma.$disconnect(), 120000);

  async function token(email: string) {
    return getAuthToken({ id: users[email]! });
  }

  async function get(path: string, email = 'scoped-admin') {
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

  it('allows a LOCATION-scoped Production caller to read own branch data', async () => {
    await createPendingSale();
    const response = await get('/api/v1/backoffice/sales');
    expect(response.status).toBe(200);
    expect(response.body.items).toHaveLength(1);
    expect(response.body.items[0].branch).toMatchObject({ id: branches.CEN, code: 'CEN' });
  });

  it('returns 403 when a LOCATION-scoped caller queries an unauthorized branchId', async () => {
    const response = await get(`/api/v1/backoffice/sales?branchId=${branches.YB}`);
    expect(response.status).toBe(403);
  });

  it('authorizes Backoffice REPORT_VIEW reads via the Production grant alone', async () => {
    const adminRole = await prisma.role.findUniqueOrThrow({ where: { code: 'ADMIN' } });
    const user = await createTestUser(prisma, adminRole.id, branches.CEN!);
    const isolatedToken = await getAuthToken(user);
    const response = await request(app).get('/api/v1/backoffice/dashboard').set('Authorization', `Bearer ${isolatedToken}`);
    expect(response.status).toBe(200);
  });

  it('rejects a legacy-lowercase-only report.view grant, once switched', async () => {
    const permission = await prisma.permission.upsert({ where: { code: 'report.view' }, create: { code: 'report.view' }, update: {} });
    const role = await createRole(prisma, 'LEGACY-ONLY-REPORT-VIEW');
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
    const user = await createTestUser(prisma, role.id, branches.CEN!);
    const isolatedToken = await getAuthToken(user);
    const response = await request(app).get('/api/v1/backoffice/dashboard').set('Authorization', `Bearer ${isolatedToken}`);
    expect(response.status).toBe(403);
  });

  it('rejects MANAGER (mapped to WAREHOUSE, no REPORT_VIEW) on Backoffice reads', async () => {
    expect((await get('/api/v1/backoffice/dashboard', 'manager01@demo.local')).status).toBe(403);
  });

  it('revokes Production REPORT_VIEW after token issuance and fails closed', async () => {
    const adminRole = await prisma.role.findUniqueOrThrow({ where: { code: 'ADMIN' } });
    const permission = await prisma.permission.findUniqueOrThrow({ where: { code: 'REPORT_VIEW' } });
    await prisma.rolePermission.delete({ where: { roleId_permissionId: { roleId: adminRole.id, permissionId: permission.id } } });
    expect((await get('/api/v1/backoffice/dashboard')).status).toBe(403);
  });

  // Phase 1D.3.5 cross-assignment security: a permission granted by one
  // assignment must never combine with a location granted by a different
  // assignment (authorization-policy.ts's hasPermissionAtLocation contract).
  // ADMIN carries REPORT_VIEW by default; WAREHOUSE does not.
  it('does not compose ADMIN @ A REPORT_VIEW with WAREHOUSE @ B location for sale detail', async () => {
    const adminRole = await prisma.role.findUniqueOrThrow({ where: { code: 'ADMIN' } });
    const warehouseRole = await prisma.role.findUniqueOrThrow({ where: { code: 'WAREHOUSE' } });
    const multi = await prisma.user.create({ data: { name: 'multi-report', email: 'multi-report@test.local', passwordHash: 'x' } });
    await prisma.userRoleScope.createMany({
      data: [
        { userId: multi.id, roleId: adminRole.id, scopeKind: 'LOCATION', locationId: branches.CEN! },
        { userId: multi.id, roleId: warehouseRole.id, scopeKind: 'LOCATION', locationId: branches.YB! },
      ],
    });
    const multiToken = await getAuthToken(multi);
    const saleA = await createPendingSale(branches.CEN);
    const saleB = await createPendingSale(branches.YB);
    expect((await request(app).get(`/api/v1/backoffice/sales/${saleA.id}`).set('Authorization', `Bearer ${multiToken}`)).status).toBe(200);
    expect((await request(app).get(`/api/v1/backoffice/sales/${saleB.id}`).set('Authorization', `Bearer ${multiToken}`)).status).toBe(403);
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
    // MANAGER maps to Production WAREHOUSE (legacy-role-map.ts), which
    // carries neither USER_MANAGE nor REPORT_VIEW by default.
    expect((await get('/api/v1/backoffice/users', 'manager01@demo.local')).status).toBe(403);
    expect((await get('/api/v1/backoffice/users', 'admin@demo.local')).status).toBe(200);
    expect((await get('/api/v1/backoffice/users', 'admin@demo.local')).body.items[0]).not.toHaveProperty('passwordHash');
  });

  it('authorizes /backoffice/users via the Production USER_MANAGE grant alone', async () => {
    const adminRole = await prisma.role.findUniqueOrThrow({ where: { code: 'ADMIN' } });
    const user = await createTestUser(prisma, adminRole.id, branches.CEN!);
    const isolatedToken = await getAuthToken(user);
    const response = await request(app).get('/api/v1/backoffice/users').set('Authorization', `Bearer ${isolatedToken}`);
    expect(response.status).toBe(200);
  });

  it('rejects a legacy-lowercase-only user.manage grant, once switched', async () => {
    const permission = await prisma.permission.upsert({ where: { code: 'user.manage' }, create: { code: 'user.manage' }, update: {} });
    const role = await createRole(prisma, 'LEGACY-ONLY-USER-MANAGE');
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
    const user = await createTestUser(prisma, role.id, branches.CEN!);
    const isolatedToken = await getAuthToken(user);
    const response = await request(app).get('/api/v1/backoffice/users').set('Authorization', `Bearer ${isolatedToken}`);
    expect(response.status).toBe(403);
  });

  it('denies sale detail from an unauthorized branch', async () => {
    // Phase 1D.3.5 SWITCH: getSale now pairs REPORT_VIEW with the persisted
    // Sale.branchId via assertPermissionAtLocation — the default caller's
    // ADMIN assignment only covers Centro, so a sale persisted at Yerba
    // Buena must still be rejected.
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
    const centroCaller = await get('/api/v1/backoffice/dashboard');
    const admin = await get('/api/v1/backoffice/dashboard', 'admin@demo.local');
    expect(centroCaller.status).toBe(200);
    expect(admin.status).toBe(200);
    expect(centroCaller.body.pendingSalesCount).toBe(1);
    expect(admin.body.pendingSalesCount).toBe(2);
  });
});
