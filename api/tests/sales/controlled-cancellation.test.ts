import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedDemo } from '../../prisma/seed.js';
import { createApp } from '../../src/app.js';
import { createCancellationService } from '../../src/modules/sales/cancellation.service.js';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { createTestPrismaClient, truncateAllTables } from '../helpers/test-db.js';
import { createTestUser, getAuthToken } from '../helpers/auth.js';

// Pilot P0.2-B: controlled cancellation. DRAFT = the owning seller only;
// PENDING_PAYMENT = SALE_CANCEL_PENDING at the sale's location and ZERO
// SalePayment rows (Policy A); every cancellation carries a structured reason.
describe('POST /api/v1/sales/:saleId/cancel (Pilot P0.2-B)', () => {
  let db: PrismaClient;
  let app: ReturnType<typeof createApp>;
  let sellerId: string;
  let cashierId: string;
  let branchId: string;
  let otherBranchId: string;
  let remera: { id: string; productId: string; price: bigint };
  let tokens: Record<'seller' | 'cashier' | 'admin' | 'owner' | 'warehouse', string>;

  beforeAll(async () => {
    db = await createTestPrismaClient();
    app = createApp(db);
  }, 120000);

  beforeEach(async () => {
    await truncateAllTables(db);
    await seedDemo(db);
    const user = (name: string) => db.user.findUniqueOrThrow({ where: { email: `${name}@demo.local` } });
    const [seller, cashier, admin, owner, warehouse] = await Promise.all([
      user('seller01'), user('cashier01'), user('admin'), user('owner01'), user('warehouse01'),
    ]);
    sellerId = seller.id;
    cashierId = cashier.id;
    tokens = {
      seller: await getAuthToken(seller),
      cashier: await getAuthToken(cashier),
      admin: await getAuthToken(admin),
      owner: await getAuthToken(owner),
      warehouse: await getAuthToken(warehouse),
    };
    branchId = (await db.branch.findUniqueOrThrow({ where: { code: 'CEN' } })).id;
    otherBranchId = (await db.branch.findUniqueOrThrow({ where: { code: 'YB' } })).id;
    remera = await db.productVariant.findUniqueOrThrow({ where: { sku: 'REM-NEG-M' } });
  }, 120000);

  afterAll(async () => { await db?.$disconnect(); }, 120000);

  const HOUR = 60 * 60 * 1000;
  const REASON = { reason: 'CUSTOMER_CHANGED_MIND' };

  async function sale(status: 'DRAFT' | 'PENDING_PAYMENT' | 'PAID' | 'COMPLETED' | 'CANCELLED', options: {
    seller?: string; branch?: string; quantity?: bigint; holds?: boolean; expiresAt?: Date;
  } = {}) {
    const quantity = options.quantity ?? 2n;
    const saleBranch = options.branch ?? branchId;
    const total = quantity * remera.price;
    const created = await db.sale.create({
      data: { sellerId: options.seller ?? sellerId, branchId: saleBranch, status, subtotal: total, total },
    });
    await db.saleItem.create({
      data: {
        saleId: created.id, variantId: remera.id, productId: remera.productId, productName: 'Snapshot product',
        variantName: 'Snapshot variant', sku: 'SNAP', quantity, unitPrice: remera.price, subtotal: total,
      },
    });
    if (options.holds ?? status === 'PENDING_PAYMENT') {
      await hold(created.id, quantity, { branch: saleBranch, expiresAt: options.expiresAt });
    }
    return created;
  }

  async function hold(saleId: string, quantity: bigint, options: {
    branch?: string; expiresAt?: Date; status?: 'ACTIVE' | 'RELEASED' | 'CONSUMED';
  } = {}) {
    const holdBranch = options.branch ?? branchId;
    const status = options.status ?? 'ACTIVE';
    if (status === 'ACTIVE') {
      await db.inventory.update({
        where: { variantId_branchId: { variantId: remera.id, branchId: holdBranch } },
        data: { reserved: { increment: quantity } },
      });
    }
    return db.stockReservation.create({
      data: {
        saleId, variantId: remera.id, branchId: holdBranch, quantity, status,
        expiresAt: options.expiresAt ?? new Date(Date.now() + HOUR),
      },
    });
  }

  const payment = (saleId: string, amount = 1n) =>
    db.salePayment.create({ data: { saleId, method: 'TRANSFER', amount, idempotencyKey: randomUUID() } });

  const cancel = (saleId: string, token: string, body: object = REASON) =>
    request(app).post(`/api/v1/sales/${saleId}/cancel`).set('Authorization', `Bearer ${token}`).send(body);

  const inventory = (branch = branchId) =>
    db.inventory.findUniqueOrThrow({ where: { variantId_branchId: { variantId: remera.id, branchId: branch } } });

  async function snapshot(saleId: string) {
    return {
      sale: await db.sale.findUniqueOrThrow({ where: { id: saleId } }),
      items: await db.saleItem.findMany({ where: { saleId }, orderBy: { id: 'asc' } }),
      reservations: await db.stockReservation.findMany({ where: { saleId }, orderBy: { id: 'asc' } }),
      inventory: await db.inventory.findMany({ orderBy: { id: 'asc' }, select: { id: true, physical: true, reserved: true } }),
      payments: await db.salePayment.findMany({ where: { saleId }, orderBy: { id: 'asc' } }),
      cashMovements: await db.cashMovement.count(),
      audits: await db.auditLog.count(),
      movements: await db.stockMovement.count(),
    };
  }

  async function expectReservedMatchesActiveHolds() {
    const inventories = await db.inventory.findMany();
    const active = await db.stockReservation.findMany({ where: { status: 'ACTIVE' } });
    for (const row of inventories) {
      const held = active.filter((hold) => hold.variantId === row.variantId && hold.branchId === row.branchId)
        .reduce((sum, hold) => sum + hold.quantity, 0n);
      expect(row.reserved).toBe(held);
    }
  }

  describe('DRAFT: the owning seller only', () => {
    it('lets the seller cancel their own DRAFT without reservation, payment or stock effects, and audits the reason', async () => {
      const draft = await sale('DRAFT');
      const before = await snapshot(draft.id);
      const response = await cancel(draft.id, tokens.seller, { reason: 'WRONG_ITEM' });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ saleId: draft.id, status: 'CANCELLED', released: [] });
      const after = await snapshot(draft.id);
      expect(after.sale.status).toBe('CANCELLED');
      expect(after.inventory).toEqual(before.inventory);
      expect(after.reservations).toEqual(before.reservations);
      expect(after.payments).toEqual(before.payments);
      expect(after.movements).toBe(0);
      const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'SALE_CANCELLED', entityId: draft.id } });
      expect(audit).toMatchObject({ userId: sellerId, branchId });
      expect(audit.before).toMatchObject({ status: 'DRAFT' });
      expect(audit.after).toMatchObject({ status: 'CANCELLED', reason: 'WRONG_ITEM', released: [] });
    });

    it('refuses another seller\'s DRAFT, judged by the persisted sellerId', async () => {
      const sellerRole = await db.role.findUniqueOrThrow({ where: { code: 'SELLER' } });
      const otherSeller = await createTestUser(db, sellerRole.id, branchId);
      const draft = await sale('DRAFT');
      const before = await snapshot(draft.id);
      const response = await cancel(draft.id, await getAuthToken(otherSeller));
      expect(response.status).toBe(403);
      expect(await snapshot(draft.id)).toEqual(before);
    });

    it('refuses a DRAFT to CASHIER, ADMIN and OWNER (strict seller ownership)', async () => {
      const draft = await sale('DRAFT');
      for (const token of [tokens.cashier, tokens.admin, tokens.owner]) {
        expect((await cancel(draft.id, token)).status).toBe(403);
      }
      expect((await db.sale.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe('DRAFT');
    });

    it('still requires the seller to hold SALE_CREATE at the sale location', async () => {
      const draft = await sale('DRAFT');
      await db.userRoleScope.updateMany({ where: { userId: sellerId, scopeKind: 'LOCATION' }, data: { locationId: otherBranchId } });
      expect((await cancel(draft.id, tokens.seller)).status).toBe(403);
    });

    it('offers no way back from PENDING_PAYMENT to DRAFT', async () => {
      const pending = await sale('PENDING_PAYMENT');
      for (const path of ['return-to-draft', 'back-to-draft', 'reopen']) {
        const response = await request(app).post(`/api/v1/sales/${pending.id}/${path}`)
          .set('Authorization', `Bearer ${tokens.cashier}`).send({});
        expect(response.status).toBe(404);
      }
      expect((await db.sale.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe('PENDING_PAYMENT');
    });
  });

  describe('PENDING_PAYMENT with zero payment rows', () => {
    it('lets a CASHIER cancel: exact reserved release, physical untouched, no StockMovement, audited atomically', async () => {
      const pending = await sale('PENDING_PAYMENT', { quantity: 3n });
      const before = await inventory();
      const response = await cancel(pending.id, tokens.cashier, { reason: 'OTHER', note: '  Cliente se retiró  ' });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ saleId: pending.id, status: 'CANCELLED', released: [{ variantId: remera.id, quantity: '3' }] });
      const after = await inventory();
      expect(after.physical).toBe(before.physical);
      expect(after.reserved).toBe(before.reserved - 3n);
      expect(await db.stockReservation.count({ where: { saleId: pending.id, status: 'RELEASED' } })).toBe(1);
      expect(await db.stockReservation.count({ where: { saleId: pending.id, status: 'ACTIVE' } })).toBe(0);
      expect(await db.stockMovement.count()).toBe(0);
      expect((await db.sale.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe('CANCELLED');
      const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'SALE_CANCELLED', entityId: pending.id } });
      expect(audit).toMatchObject({ userId: cashierId, branchId });
      expect(audit.before).toMatchObject({ status: 'PENDING_PAYMENT' });
      expect(audit.after).toMatchObject({
        status: 'CANCELLED', reason: 'OTHER', note: 'Cliente se retiró', released: [{ variantId: remera.id, quantity: '3' }],
      });
      await expectReservedMatchesActiveHolds();
    });

    it('lets ADMIN (COMPANY) and OWNER (implicit) cancel', async () => {
      for (const token of [tokens.admin, tokens.owner]) {
        const pending = await sale('PENDING_PAYMENT');
        expect((await cancel(pending.id, token)).status).toBe(200);
      }
      await expectReservedMatchesActiveHolds();
    });

    it('refuses SELLER (even the sale\'s own seller) and WAREHOUSE', async () => {
      const pending = await sale('PENDING_PAYMENT');
      const before = await snapshot(pending.id);
      for (const token of [tokens.seller, tokens.warehouse]) expect((await cancel(pending.id, token)).status).toBe(403);
      expect(await snapshot(pending.id)).toEqual(before);
    });

    it('refuses a CASHIER outside the sale location', async () => {
      const pending = await sale('PENDING_PAYMENT', { branch: otherBranchId });
      expect((await cancel(pending.id, tokens.cashier)).status).toBe(403);
      expect((await db.sale.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe('PENDING_PAYMENT');
    });

    it('re-reads authority per request: revoking SALE_CANCEL_PENDING denies the next cancellation', async () => {
      const pending = await sale('PENDING_PAYMENT');
      const role = await db.role.findUniqueOrThrow({ where: { code: 'CASHIER' } });
      const permission = await db.permission.findUniqueOrThrow({ where: { code: 'SALE_CANCEL_PENDING' } });
      await db.rolePermission.delete({ where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } } });
      expect((await cancel(pending.id, tokens.cashier)).status).toBe(403);
    });

    it('cancels an EXPIRED zero-payment sale, releasing its still-ACTIVE holds', async () => {
      const pending = await sale('PENDING_PAYMENT', { expiresAt: new Date(Date.now() - HOUR) });
      expect((await cancel(pending.id, tokens.cashier)).status).toBe(200);
      await expectReservedMatchesActiveHolds();
    });

    it('releases only ACTIVE holds and never re-mutates historical RELEASED or CONSUMED rows', async () => {
      const pending = await sale('PENDING_PAYMENT', { holds: false });
      const released = await hold(pending.id, 2n, { status: 'RELEASED' });
      const consumed = await hold(pending.id, 2n, { status: 'CONSUMED' });
      const active = await hold(pending.id, 2n);
      expect((await cancel(pending.id, tokens.cashier)).status).toBe(200);
      expect((await db.stockReservation.findUniqueOrThrow({ where: { id: released.id } })).status).toBe('RELEASED');
      expect((await db.stockReservation.findUniqueOrThrow({ where: { id: consumed.id } })).status).toBe('CONSUMED');
      expect((await db.stockReservation.findUniqueOrThrow({ where: { id: active.id } })).status).toBe('RELEASED');
      await expectReservedMatchesActiveHolds();
    });

    it('rolls back on an invariant mismatch (reserved cannot absorb the release)', async () => {
      const pending = await sale('PENDING_PAYMENT');
      await db.inventory.update({ where: { variantId_branchId: { variantId: remera.id, branchId } }, data: { reserved: 1n } });
      const before = await snapshot(pending.id);
      const response = await cancel(pending.id, tokens.cashier);
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('INVALID_RESERVATION');
      expect(await snapshot(pending.id)).toEqual(before);
    });

    it('refuses CANCELLED (no double release), COMPLETED and payment-less PAID sales', async () => {
      const pending = await sale('PENDING_PAYMENT');
      expect((await cancel(pending.id, tokens.cashier)).status).toBe(200);
      const afterFirst = await snapshot(pending.id);
      const again = await cancel(pending.id, tokens.cashier);
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe('INVALID_SALE_STATE');
      expect(await snapshot(pending.id)).toEqual(afterFirst);
      for (const status of ['COMPLETED', 'PAID'] as const) {
        const other = await sale(status);
        const response = await cancel(other.id, tokens.cashier);
        expect(response.status).toBe(409);
        expect(response.body.error.code).toBe('INVALID_SALE_STATE');
      }
    });
  });

  describe('payment protection (Policy A: payment-row existence)', () => {
    it('blocks cancellation after one partial payment, even with an expired hold, and deletes nothing', async () => {
      for (const expiresAt of [new Date(Date.now() + HOUR), new Date(Date.now() - HOUR)]) {
        const pending = await sale('PENDING_PAYMENT', { expiresAt });
        await payment(pending.id, 1n);
        const before = await snapshot(pending.id);
        const response = await cancel(pending.id, tokens.cashier);
        expect(response.status).toBe(409);
        expect(response.body.error.code).toBe('PAYMENT_ALREADY_ACCEPTED');
        expect(await snapshot(pending.id)).toEqual(before);
      }
    });

    it('blocks a fully paid sale with payment rows', async () => {
      const paid = await sale('PAID', { holds: true });
      await payment(paid.id, paid.total);
      const before = await snapshot(paid.id);
      const response = await cancel(paid.id, tokens.admin);
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('PAYMENT_ALREADY_ACCEPTED');
      expect(await snapshot(paid.id)).toEqual(before);
    });
  });

  describe('structured reasons', () => {
    for (const reason of ['WRONG_ITEM', 'WRONG_QUANTITY', 'CUSTOMER_CHANGED_MIND', 'DUPLICATE_SALE']) {
      it(`accepts ${reason} without a note`, async () => {
        const pending = await sale('PENDING_PAYMENT');
        expect((await cancel(pending.id, tokens.cashier, { reason })).status).toBe(200);
        const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'SALE_CANCELLED', entityId: pending.id } });
        expect(audit.after).toMatchObject({ reason });
      });
    }

    const invalid: Array<[string, object]> = [
      ['a missing body', {}],
      ['an unknown reason', { reason: 'PRICE_TOO_HIGH' }],
      ['OTHER without a note', { reason: 'OTHER' }],
      ['OTHER with a blank note', { reason: 'OTHER', note: '   ' }],
      ['a free-text-only reason', { note: 'porque sí' }],
      ['an overlong note', { reason: 'OTHER', note: 'x'.repeat(501) }],
      ['unknown fields', { reason: 'WRONG_ITEM', refund: true }],
    ];
    for (const [name, body] of invalid) {
      it(`rejects ${name} without writes`, async () => {
        const pending = await sale('PENDING_PAYMENT');
        const before = await snapshot(pending.id);
        const response = await cancel(pending.id, tokens.cashier, body);
        expect(response.status).toBe(400);
        expect(response.body.error.code).toBe('VALIDATION_ERROR');
        expect(await snapshot(pending.id)).toEqual(before);
      });
    }
  });

  describe('concurrency (Sale-first serialization)', () => {
    it('cancel vs first payment: never an accepted payment with released stock', async () => {
      const pending = await sale('PENDING_PAYMENT');
      const [cancelled, paid] = await Promise.all([
        cancel(pending.id, tokens.cashier),
        request(app).post(`/api/v1/sales/${pending.id}/payments`).set('Authorization', `Bearer ${tokens.cashier}`)
          .send({ method: 'TRANSFER', amount: '1', idempotencyKey: randomUUID() }),
      ]);
      expect([cancelled.status === 200, paid.status === 201].filter(Boolean)).toHaveLength(1);
      const payments = await db.salePayment.count({ where: { saleId: pending.id } });
      const released = await db.stockReservation.count({ where: { saleId: pending.id, status: 'RELEASED' } });
      expect(payments > 0 && released > 0).toBe(false);
      await expectReservedMatchesActiveHolds();
    });

    it('cancel vs expiry release: the hold is released exactly once', async () => {
      const pending = await sale('PENDING_PAYMENT', { expiresAt: new Date(Date.now() - 1000) });
      const before = await inventory();
      const admin = await db.user.findUniqueOrThrow({ where: { email: 'admin@demo.local' } });
      const [cancelled] = await Promise.all([
        cancel(pending.id, tokens.cashier),
        createCancellationService(db).releaseExpiredSaleHolds(pending.id, {
          actor: { userId: admin.id, trigger: 'ADMIN' }, now: new Date(),
        }),
      ]);
      expect(cancelled.status).toBe(200);
      expect((await inventory()).reserved).toBe(before.reserved - 2n);
      await expectReservedMatchesActiveHolds();
    });

    it('cancel vs cancel: one succeeds, the stock is released once', async () => {
      const pending = await sale('PENDING_PAYMENT');
      const before = await inventory();
      const results = await Promise.all([cancel(pending.id, tokens.cashier), cancel(pending.id, tokens.admin)]);
      expect(results.filter((response) => response.status === 200)).toHaveLength(1);
      expect((await inventory()).reserved).toBe(before.reserved - 2n);
      expect(await db.auditLog.count({ where: { action: 'SALE_CANCELLED', entityId: pending.id } })).toBe(1);
    });

    it('cancel vs completion of a PAID sale: completion wins, cancellation is refused', async () => {
      const paid = await sale('PAID', { holds: true });
      await payment(paid.id, paid.total);
      const [cancelled, completed] = await Promise.all([
        cancel(paid.id, tokens.cashier),
        request(app).post(`/api/v1/sales/${paid.id}/complete`).set('Authorization', `Bearer ${tokens.cashier}`),
      ]);
      expect(cancelled.status).toBe(409);
      expect(completed.status).toBe(200);
      expect((await db.sale.findUniqueOrThrow({ where: { id: paid.id } })).status).toBe('COMPLETED');
    });

    it('draft cancel vs send-to-cashier: one lifecycle wins, reserved stays exact', async () => {
      const draft = await sale('DRAFT');
      const [cancelled, sent] = await Promise.all([
        cancel(draft.id, tokens.seller),
        request(app).post(`/api/v1/sales/${draft.id}/send-to-cashier`).set('Authorization', `Bearer ${tokens.seller}`),
      ]);
      const status = (await db.sale.findUniqueOrThrow({ where: { id: draft.id } })).status;
      if (status === 'CANCELLED') {
        expect(cancelled.status).toBe(200);
        expect(sent.status).not.toBe(200);
      } else {
        expect(status).toBe('PENDING_PAYMENT');
        expect(sent.status).toBe(200);
        expect(cancelled.status).not.toBe(200);
      }
      await expectReservedMatchesActiveHolds();
    });
  });
});
