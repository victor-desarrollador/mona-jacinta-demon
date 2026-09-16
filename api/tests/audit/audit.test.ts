import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedDemo } from '../../prisma/seed.js';
import { createApp } from '../../src/app.js';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { createAuditLog } from '../../src/shared/audit.js';
import { createSalesService } from '../../src/modules/sales/sales.service.js';
import { createPaymentsService } from '../../src/modules/payments/payments.service.js';
import { createCashService } from '../../src/modules/cash/cash.service.js';
import { createCancellationService } from '../../src/modules/sales/cancellation.service.js';
import { getAuthToken, createTestUser } from '../helpers/auth.js';
import { createRole } from '../helpers/factories.js';
import { createTestPrismaClient, truncateAllTables } from '../helpers/test-db.js';

describe('critical operation audit', () => {
  let db: PrismaClient;
  let branchId: string;
  let sellerId: string;
  let cashierId: string;
  let adminId: string;
  let token: string;
  // cancellation.service.ts's AuthScope still takes `branchIds` (its own
  // internal, service-local shape — unaffected by Phase 1D.1's rename of
  // Express.AuthContext's field, which is what `req()` below builds).
  const scope = (userId: string) => ({ userId, branchIds: [branchId] });
  // Phase 1D.2.4/1D.3.1/1D.3.2/1D.3.3: assertBranchAccess/
  // assertPermissionAtLocation/hasPermissionAtLocation now read
  // req.auth.assignments (via the centralized authorization-policy.ts), not
  // req.auth.effectiveLocationIds — this hand-built fixture must carry a
  // matching LOCATION assignment for branchId, with the Production
  // permissions the switched Sales/Cancellation/Payments/Cash code paths
  // actually check (SALE_CREATE for createDraftSale/cancelSale, SALE_VIEW
  // for ensureSaleAccess/listPayments, SALE_COMPLETE for
  // completeSaleInTransaction, SALE_CHARGE for registerPayment's
  // assertCurrentBranch, CASH_SESSION_OPEN/CLOSE for openSession/
  // closeSession), or those calls fail closed. The exact roleCode is
  // irrelevant to these checks (only OWNER is special-cased) — SELLER is an
  // arbitrary non-OWNER placeholder.
  const req = (userId: string) =>
    ({
      auth: {
        userId,
        effectiveLocationIds: [branchId],
        roles: [],
        legacyPermissions: [],
        assignments: [
          {
            roleId: 'audit-test-assignment', roleCode: 'SELLER', scopeKind: 'LOCATION', locationId: branchId,
            permissions: ['SALE_CREATE', 'SALE_VIEW', 'SALE_COMPLETE', 'SALE_CHARGE', 'CASH_SESSION_OPEN', 'CASH_SESSION_CLOSE'],
          },
        ],
      },
    }) as unknown as Request;
  const get = (accessToken = token, query = '') => request(createApp(db)).get(`/api/v1/audit${query}`).set('Authorization', `Bearer ${accessToken}`);

  beforeAll(async () => { db = await createTestPrismaClient(); });
  beforeEach(async () => {
    await truncateAllTables(db);
    await seedDemo(db);
    branchId = (await db.branch.findUniqueOrThrow({ where: { code: 'CEN' } })).id;
    sellerId = (await db.user.findUniqueOrThrow({ where: { email: 'seller01@demo.local' } })).id;
    cashierId = (await db.user.findUniqueOrThrow({ where: { email: 'cashier01@demo.local' } })).id;
    adminId = (await db.user.findUniqueOrThrow({ where: { email: 'admin@demo.local' } })).id;
    token = await getAuthToken({ id: adminId });
  });
  afterAll(async () => { await db?.$disconnect(); });

  async function audit(action: string, entityId: string, userId: string, entityType = 'Sale') {
    const rows = await db.auditLog.findMany({ where: { action, entityId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId, branchId, action, entityType, entityId });
    expect(rows[0]!.timestamp).toBeInstanceOf(Date);
    expect(rows[0]).toHaveProperty('before');
    expect(rows[0]).toHaveProperty('after');
    expect(JSON.stringify(rows)).not.toMatch(/password|passwordHash|jwt|DATABASE_URL|postgres(?:ql)?:\/\//i);
    return rows[0]!;
  }

  async function draft() {
    const service = createSalesService(db);
    const sale = await service.createDraftSale(req(sellerId), sellerId, branchId);
    const variant = await db.productVariant.findUniqueOrThrow({ where: { sku: 'REM-NEG-M' } });
    await service.addItem(req(sellerId), sellerId, sale.id, { variantId: variant.id, quantity: 1n });
    return sale;
  }

  it('audits draft creation', async () => {
    const sale = await draft();
    expect((await audit('SALE_CREATED', sale.id, sellerId)).after).toEqual({ status: 'DRAFT', subtotal: '0', discountTotal: '0', total: '0' });
  });

  it('audits handoff, payment, completion and cash lifecycle with exact snapshots', async () => {
    const sales = createSalesService(db);
    const sale = await draft();
    await sales.sendToCashier(sale.id, sellerId, [branchId]);
    const sent = await audit('SALE_SENT_TO_CASHIER', sale.id, sellerId);
    expect(sent.before).toEqual({ status: 'DRAFT', saleNumber: null });
    expect(sent.after).toMatchObject({ status: 'PENDING_PAYMENT', saleNumber: expect.any(String) });
    const cash = createCashService(db);
    const register = await db.cashRegister.findFirstOrThrow({ where: { branchId } });
    const session = await cash.openSession(register.id, req(cashierId).auth!, 9007199254740993n);
    expect((await audit('CASH_SESSION_OPENED', session.sessionId, cashierId, 'CashSession')).after).toMatchObject({ startingCash: '9007199254740993', status: 'OPEN' });
    const paid = await createPaymentsService(db).registerPayment(req(cashierId), cashierId, sale.id, {
      method: 'CASH', amount: 4500000n, receivedAmount: 5000000n, idempotencyKey: randomUUID(),
    });
    const paymentAudit = await audit('PAYMENT_REGISTERED', paid.payment.id, cashierId, 'SalePayment');
    expect(paymentAudit.before).toEqual({ saleId: sale.id, status: 'PENDING_PAYMENT' });
    expect(paymentAudit.after).toEqual({ saleId: sale.id, status: 'PAID', method: 'CASH', amount: '4500000', receivedAmount: '5000000', changeAmount: '500000' });
    await sales.completeSale(req(cashierId), cashierId, sale.id);
    const completed = await audit('SALE_COMPLETED', sale.id, cashierId);
    expect(completed.before).toEqual({ status: 'PAID' });
    expect(completed.after).toMatchObject({ status: 'COMPLETED', inventory: [{ variantId: expect.any(String), quantity: '1' }] });
    await cash.closeSession(session.sessionId, req(cashierId).auth!, 4500000n);
    const closed = await audit('CASH_SESSION_CLOSED', session.sessionId, cashierId, 'CashSession');
    expect(closed.before).toEqual({ status: 'OPEN' });
    expect(closed.after).toMatchObject({ status: 'CLOSED', closingCash: '4500000', startingCash: '9007199254740993' });
  });

  it('audits cancellation and expired reservation release', async () => {
    const sales = createSalesService(db);
    const cancellation = createCancellationService(db);
    const cancelled = await draft();
    await sales.sendToCashier(cancelled.id, sellerId, [branchId]);
    await cancellation.cancelSale(req(adminId), cancelled.id);
    const entry = await audit('SALE_CANCELLED', cancelled.id, adminId);
    expect(entry.before).toEqual({ status: 'PENDING_PAYMENT' });
    expect(entry.after).toMatchObject({ status: 'CANCELLED', released: [{ variantId: expect.any(String), quantity: '1' }] });
    const expired = await draft();
    await sales.sendToCashier(expired.id, sellerId, [branchId]);
    await db.stockReservation.updateMany({ where: { saleId: expired.id }, data: { expiresAt: new Date(0) } });
    await cancellation.releaseExpiredReservations(scope(adminId));
    const released = await audit('RESERVATION_RELEASED', expired.id, adminId);
    expect(released.before).toBeNull();
    expect(released.after).toEqual({ saleId: expired.id, reason: 'EXPIRED', released: [{ variantId: expect.any(String), quantity: '1' }] });
  });

  it('normalizes nested before/after using the supplied client and rolls back with business writes', async () => {
    const data = { userId: sellerId, branchId, action: 'TEST', entityType: 'Sale', entityId: randomUUID(), before: { nested: [9007199254740993n] }, after: { amount: 123n } };
    const saved = await createAuditLog(db, data);
    expect(saved.before).toEqual({ nested: ['9007199254740993'] });
    expect(saved.after).toEqual({ amount: '123' });
    const id = randomUUID();
    await expect(db.$transaction(async (tx) => {
      await tx.sale.create({ data: { id, sellerId, branchId, subtotal: 0n, total: 0n } });
      await createAuditLog(tx, { ...data, entityId: id });
      throw new Error('intentional rollback');
    })).rejects.toThrow('intentional rollback');
    expect(await db.sale.count({ where: { id } })).toBe(0);
    expect(await db.auditLog.count({ where: { entityId: id } })).toBe(0);
  });

  it('rolls back completion audit and stock when the final sale write fails', async () => {
    const sale = await draft();
    await createSalesService(db).sendToCashier(sale.id, sellerId, [branchId]);
    await createPaymentsService(db).registerPayment(req(cashierId), cashierId, sale.id, {
      method: 'TRANSFER', amount: 4500000n, receivedAmount: null, idempotencyKey: randomUUID(),
    });
    const stock = await db.inventory.findMany({ where: { branchId }, orderBy: { id: 'asc' } });
    const failingDb = db.$extends({ query: { sale: { update({ args, query }) {
      if (args.data.status === 'COMPLETED') throw new Error('intentional completion failure');
      return query(args);
    } } } });
    await expect(createSalesService(failingDb as unknown as PrismaClient)
      .completeSale(req(cashierId), cashierId, sale.id)).rejects.toThrow('intentional completion failure');
    expect(await db.auditLog.count({ where: { entityId: sale.id, action: 'SALE_COMPLETED' } })).toBe(0);
    expect((await db.sale.findUniqueOrThrow({ where: { id: sale.id } })).status).toBe('PAID');
    expect(await db.stockMovement.count({ where: { saleId: sale.id } })).toBe(0);
    expect(await db.inventory.findMany({ where: { branchId }, orderBy: { id: 'asc' } })).toEqual(stock);
    expect(await db.stockReservation.count({ where: { saleId: sale.id, status: 'ACTIVE' } })).toBe(1);
  });

  it('requires authentication', async () => {
    expect((await request(createApp(db)).get('/api/v1/audit')).status).toBe(401);
  });

  it('authorizes via the Production AUDIT_VIEW grant alone', async () => {
    expect((await get()).status).toBe(200);
  });

  it('rejects a caller with no AUDIT_VIEW grant', async () => {
    expect((await get(await getAuthToken({ id: sellerId }))).status).toBe(403);
  });

  it('rejects a legacy-lowercase-only audit.view grant, once switched', async () => {
    const permission = await db.permission.upsert({ where: { code: 'audit.view' }, create: { code: 'audit.view' }, update: {} });
    const role = await createRole(db, 'LEGACY-ONLY-AUDIT-VIEW');
    await db.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
    const user = await createTestUser(db, role.id, branchId);
    const isolatedToken = await getAuthToken(user);
    expect((await get(isolatedToken)).status).toBe(403);
  });

  it('rejects MANAGER (mapped to WAREHOUSE, no AUDIT_VIEW)', async () => {
    const manager = await db.user.findUniqueOrThrow({ where: { email: 'manager01@demo.local' } });
    expect((await get(await getAuthToken(manager))).status).toBe(403);
  });

  it('authorizes via a COMPANY-scoped ADMIN assignment', async () => {
    const adminRole = await db.role.findUniqueOrThrow({ where: { code: 'ADMIN' } });
    const companyAdmin = await db.user.create({ data: { name: 'company-admin-audit', email: 'company-admin-audit@test.local', passwordHash: 'x' } });
    await db.userRoleScope.create({ data: { userId: companyAdmin.id, roleId: adminRole.id, scopeKind: 'COMPANY', locationId: null } });
    const companyToken = await getAuthToken(companyAdmin);
    expect((await get(companyToken)).status).toBe(200);
  });

  // Phase 1D.3.5 correction: this test used to prove "permission works
  // without role names" by renaming ADMIN to an arbitrary code and expecting
  // continued access — a legacy-only property, since requireLegacyPermission
  // reads req.auth.legacyPermissions purely by permission code. Under the
  // Production switch that expectation is invalid: isProductionRoleCode
  // (roles.ts) filters authorization-context.ts's assignments by canonical
  // Production role code BEFORE any permission is read, so an unrecognized
  // code like AUDITOR can never contribute AUDIT_VIEW, even though the
  // underlying RolePermission grant on that Role row is untouched.
  // isProductionRoleCode must not be weakened to preserve the old behavior.
  it('fails closed for an unknown Production role code (AUDITOR), even with the underlying RolePermission grant intact', async () => {
    const role = await db.role.findUniqueOrThrow({ where: { code: 'ADMIN' } });
    await db.role.update({ where: { id: role.id }, data: { code: 'AUDITOR' } });
    expect((await get()).status).toBe(403);
    await db.role.update({ where: { id: role.id }, data: { code: 'ADMIN' } });
  });

  it('revokes Production AUDIT_VIEW after token issuance and fails closed', async () => {
    const role = await db.role.findUniqueOrThrow({ where: { code: 'ADMIN' } });
    const permission = await db.permission.findUniqueOrThrow({ where: { code: 'AUDIT_VIEW' } });
    await db.rolePermission.delete({ where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } } });
    expect((await get()).status).toBe(403);
  });

  it('returns BigInt-safe, bounded, deterministic newest-first pages and performs no writes', async () => {
    const timestamp = new Date('2026-01-01');
    const ids = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003'];
    for (const [index, id] of ids.entries()) {
      const entry = await createAuditLog(db, { userId: adminId, branchId, action: 'TEST', entityType: 'Sale', entityId: id, after: { amount: 9007199254740993n } });
      await db.auditLog.update({ where: { id: entry.id }, data: { id, timestamp: index === 0 ? new Date('2026-01-02') : timestamp } });
    }
    const operations: string[] = [];
    const readDb = db.$extends({ query: { $allOperations({ operation, args, query }) {
      operations.push(operation);
      if (!['findUnique', 'findMany'].includes(operation)) throw new Error('Unexpected database operation');
      return query(args);
    } } });
    const response = await request(createApp(readDb as unknown as PrismaClient)).get('/api/v1/audit?limit=2').set('Authorization', `Bearer ${token}`);
    expect(response.status).toBe(200);
    expect(response.body.data.map((row: { id: string }) => row.id)).toEqual([ids[0], ids[2]]);
    expect(response.body.data[0].after).toEqual({ amount: '9007199254740993' });
    expect(operations).toEqual(['findUnique', 'findMany']);
    expect((await get(token, '?limit=2&offset=2')).body.data.map((row: { id: string }) => row.id)).toEqual([ids[1]]);
    expect((await get(token, '?limit=2')).body).toEqual(response.body);
    expect(await db.auditLog.count()).toBe(3);
    for (const query of ['?limit=0', '?limit=101', '?offset=-1']) expect((await get(token, query)).status).toBe(400);
  });
});
