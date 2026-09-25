import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedDemo } from '../../prisma/seed.js';
import { createApp } from '../../src/app.js';
import { createCancellationService } from '../../src/modules/sales/cancellation.service.js';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { createTestPrismaClient, truncateAllTables } from '../helpers/test-db.js';
import { getAuthToken } from '../helpers/auth.js';

// Pilot P0.2-A: a cashier corrects a PENDING_PAYMENT sale before its first
// payment. Only reservations move (never physical stock), the original hold
// expiry is preserved, and ACTIVE coverage must match the items exactly.
describe('POST /api/v1/sales/:saleId/correct (Pilot P0.2-A)', () => {
  let db: PrismaClient;
  let app: ReturnType<typeof createApp>;
  let sellerId: string;
  let cashierId: string;
  let branchId: string;
  let otherBranchId: string;
  let remera: { id: string; productId: string; price: bigint };
  let jean: { id: string; productId: string; price: bigint };
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
    jean = await db.productVariant.findUniqueOrThrow({ where: { sku: 'JEA-AZU-42' } });
  }, 120000);

  afterAll(async () => { await db?.$disconnect(); }, 120000);

  const HOUR = 60 * 60 * 1000;

  type Line = { variant: { id: string; productId: string; price: bigint }; quantity: bigint };

  // Realistic held sale: SaleItems (price snapshot) + exactly matching ACTIVE
  // holds with one shared expiry, and Inventory.reserved incremented to match.
  async function heldSale(lines: Line[], options: {
    status?: 'DRAFT' | 'PENDING_PAYMENT' | 'PAID' | 'COMPLETED' | 'CANCELLED';
    expiresAt?: Date; branch?: string; holds?: boolean;
  } = {}) {
    const saleBranch = options.branch ?? branchId;
    const total = lines.reduce((sum, line) => sum + line.quantity * line.variant.price, 0n);
    const sale = await db.sale.create({
      data: {
        sellerId, branchId: saleBranch, status: options.status ?? 'PENDING_PAYMENT', subtotal: total, total,
        saleNumber: `T-${randomUUID().slice(0, 8)}`,
      },
    });
    const expiresAt = options.expiresAt ?? new Date(Date.now() + HOUR);
    for (const line of lines) {
      await db.saleItem.create({
        data: {
          saleId: sale.id, variantId: line.variant.id, productId: line.variant.productId,
          productName: 'Snapshot product', variantName: 'Snapshot variant', sku: `SNAP-${line.variant.id}`,
          quantity: line.quantity, unitPrice: line.variant.price, subtotal: line.quantity * line.variant.price,
        },
      });
      if (options.holds !== false) await hold(sale.id, line.variant.id, line.quantity, { expiresAt, branch: saleBranch });
    }
    return { sale, expiresAt };
  }

  async function hold(saleId: string, variantId: string, quantity: bigint, options: {
    expiresAt?: Date; branch?: string; status?: 'ACTIVE' | 'RELEASED' | 'CONSUMED';
  } = {}) {
    const holdBranch = options.branch ?? branchId;
    const status = options.status ?? 'ACTIVE';
    if (status === 'ACTIVE') {
      await db.inventory.update({
        where: { variantId_branchId: { variantId, branchId: holdBranch } },
        data: { reserved: { increment: quantity } },
      });
    }
    return db.stockReservation.create({
      data: { saleId, variantId, branchId: holdBranch, quantity, status, expiresAt: options.expiresAt ?? new Date(Date.now() + HOUR) },
    });
  }

  const correct = (saleId: string, items: Array<{ variantId: string; quantity: string | number }>, token = tokens.cashier) =>
    request(app).post(`/api/v1/sales/${saleId}/correct`).set('Authorization', `Bearer ${token}`)
      .send({ items: items.map((item) => ({ variantId: item.variantId, quantity: String(item.quantity) })) });

  const inventoryOf = (variantId: string, branch = branchId) =>
    db.inventory.findUniqueOrThrow({ where: { variantId_branchId: { variantId, branchId: branch } } });

  async function snapshot(saleId: string) {
    return {
      sale: await db.sale.findUniqueOrThrow({ where: { id: saleId } }),
      items: await db.saleItem.findMany({ where: { saleId }, orderBy: { id: 'asc' } }),
      reservations: await db.stockReservation.findMany({ where: { saleId }, orderBy: { id: 'asc' } }),
      inventory: await db.inventory.findMany({ orderBy: { id: 'asc' }, select: { id: true, physical: true, reserved: true } }),
      audits: await db.auditLog.count(),
      movements: await db.stockMovement.count(),
    };
  }

  // Global invariant: every Inventory.reserved equals the sum of the ACTIVE
  // holds on it — correction must never let the counter drift.
  async function expectReservedMatchesActiveHolds() {
    const inventories = await db.inventory.findMany();
    const active = await db.stockReservation.findMany({ where: { status: 'ACTIVE' } });
    for (const inventory of inventories) {
      const held = active
        .filter((row) => row.variantId === inventory.variantId && row.branchId === inventory.branchId)
        .reduce((sum, row) => sum + row.quantity, 0n);
      expect(inventory.reserved).toBe(held);
    }
  }

  async function expectExactCoverage(saleId: string) {
    const items = await db.saleItem.findMany({ where: { saleId } });
    const active = await db.stockReservation.findMany({ where: { saleId, status: 'ACTIVE' } });
    const need = new Map<string, bigint>();
    for (const item of items) need.set(item.variantId, (need.get(item.variantId) ?? 0n) + item.quantity);
    const have = new Map<string, bigint>();
    for (const row of active) have.set(row.variantId, (have.get(row.variantId) ?? 0n) + row.quantity);
    expect(Object.fromEntries(have)).toEqual(Object.fromEntries(need));
  }

  describe('authorization', () => {
    it('requires authentication', async () => {
      const { sale } = await heldSale([{ variant: remera, quantity: 2n }]);
      const response = await request(app).post(`/api/v1/sales/${sale.id}/correct`).send({ items: [] });
      expect(response.status).toBe(401);
    });

    it('lets ADMIN (COMPANY) and OWNER (implicit) correct, but not SELLER or WAREHOUSE', async () => {
      const { sale } = await heldSale([{ variant: remera, quantity: 3n }]);
      for (const token of [tokens.seller, tokens.warehouse]) {
        const before = await snapshot(sale.id);
        const denied = await correct(sale.id, [{ variantId: remera.id, quantity: 2 }], token);
        expect(denied.status).toBe(403);
        expect(await snapshot(sale.id)).toEqual(before);
      }
      expect((await correct(sale.id, [{ variantId: remera.id, quantity: 2 }], tokens.admin)).status).toBe(200);
      expect((await correct(sale.id, [{ variantId: remera.id, quantity: 1 }], tokens.owner)).status).toBe(200);
      expect((await db.saleItem.findFirstOrThrow({ where: { saleId: sale.id } })).quantity).toBe(1n);
      await expectReservedMatchesActiveHolds();
    });

    it('denies a CASHIER outside the sale location, from the persisted sale branch', async () => {
      const { sale } = await heldSale([{ variant: remera, quantity: 2n }], { branch: otherBranchId });
      const before = await snapshot(sale.id);
      const response = await correct(sale.id, [{ variantId: remera.id, quantity: 1 }]);
      expect(response.status).toBe(403);
      expect(await snapshot(sale.id)).toEqual(before);
    });

    it('re-reads authority per request: revoking SALE_CORRECT_PENDING denies the next correction', async () => {
      const { sale } = await heldSale([{ variant: remera, quantity: 3n }]);
      const role = await db.role.findUniqueOrThrow({ where: { code: 'CASHIER' } });
      const permission = await db.permission.findUniqueOrThrow({ where: { code: 'SALE_CORRECT_PENDING' } });
      await db.rolePermission.delete({ where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } } });
      expect((await correct(sale.id, [{ variantId: remera.id, quantity: 2 }])).status).toBe(403);
    });
  });

  describe('eligibility', () => {
    it('blocks correction once any SalePayment row exists, whatever its amount', async () => {
      const { sale } = await heldSale([{ variant: remera, quantity: 2n }]);
      await db.salePayment.create({ data: { saleId: sale.id, method: 'TRANSFER', amount: 1n, idempotencyKey: randomUUID() } });
      const before = await snapshot(sale.id);
      const response = await correct(sale.id, [{ variantId: remera.id, quantity: 1 }]);
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('PAYMENT_ALREADY_ACCEPTED');
      expect(await snapshot(sale.id)).toEqual(before);
    });

    it('rejects DRAFT, PAID, COMPLETED and CANCELLED sales', async () => {
      for (const status of ['DRAFT', 'PAID', 'COMPLETED', 'CANCELLED'] as const) {
        const { sale } = await heldSale([{ variant: remera, quantity: 2n }], { status, holds: false });
        const response = await correct(sale.id, [{ variantId: remera.id, quantity: 1 }]);
        expect(response.status).toBe(409);
        expect(response.body.error.code).toBe('INVALID_SALE_STATE');
      }
    });

    it('returns 404 for an unknown sale', async () => {
      const response = await correct(randomUUID(), [{ variantId: remera.id, quantity: 1 }]);
      expect(response.status).toBe(404);
    });

    it('rejects an expired hold without refreshing it (RESERVATION_EXPIRED)', async () => {
      const { sale } = await heldSale([{ variant: remera, quantity: 2n }], { expiresAt: new Date(Date.now() - 1000) });
      const before = await snapshot(sale.id);
      const response = await correct(sale.id, [{ variantId: remera.id, quantity: 1 }]);
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('RESERVATION_EXPIRED');
      expect(await snapshot(sale.id)).toEqual(before);
    });

    it('rejects a zero-payment sale whose holds were already released (RESERVATION_EXPIRED)', async () => {
      const { sale } = await heldSale([{ variant: remera, quantity: 2n }], { holds: false });
      await hold(sale.id, remera.id, 2n, { status: 'RELEASED' });
      const response = await correct(sale.id, [{ variantId: remera.id, quantity: 1 }]);
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('RESERVATION_EXPIRED');
    });
  });

  describe('current coverage must be exact before correcting', () => {
    const cases: Array<[string, (saleId: string) => Promise<unknown>]> = [
      ['under-coverage', (saleId) => hold(saleId, remera.id, 1n)],
      ['over-coverage', (saleId) => hold(saleId, remera.id, 3n)],
      ['an extra variant', async (saleId) => { await hold(saleId, remera.id, 2n); await hold(saleId, jean.id, 1n); }],
      ['a hold on another branch', (saleId) => hold(saleId, remera.id, 2n, { branch: otherBranchId })],
    ];
    for (const [name, arrange] of cases) {
      it(`fails closed on ${name} without writes`, async () => {
        const { sale } = await heldSale([{ variant: remera, quantity: 2n }], { holds: false });
        await arrange(sale.id);
        const before = await snapshot(sale.id);
        const response = await correct(sale.id, [{ variantId: remera.id, quantity: 1 }]);
        expect(response.status).toBe(409);
        expect(response.body.error.code).toBe('INVALID_RESERVATION');
        expect(await snapshot(sale.id)).toEqual(before);
      });
    }

    it('treats a missing variant hold as invalid coverage', async () => {
      const { sale } = await heldSale([{ variant: remera, quantity: 2n }, { variant: jean, quantity: 1n }], { holds: false });
      await hold(sale.id, remera.id, 2n);
      const response = await correct(sale.id, [{ variantId: remera.id, quantity: 1 }, { variantId: jean.id, quantity: 1 }]);
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('INVALID_RESERVATION');
    });

    it('never counts historical RELEASED or CONSUMED rows as current coverage', async () => {
      const { sale } = await heldSale([{ variant: remera, quantity: 2n }, { variant: jean, quantity: 1n }], { holds: false });
      await hold(sale.id, remera.id, 2n);
      await hold(sale.id, jean.id, 1n, { status: 'RELEASED' });
      await hold(sale.id, jean.id, 1n, { status: 'CONSUMED' });
      const response = await correct(sale.id, [{ variantId: remera.id, quantity: 1 }, { variantId: jean.id, quantity: 1 }]);
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('INVALID_RESERVATION');
    });
  });

  describe('reservation and item effects', () => {
    it('decreases a quantity: exact reserved delta, preserved expiry, no physical change, audited', async () => {
      const { sale, expiresAt } = await heldSale([{ variant: remera, quantity: 3n }]);
      const inventoryBefore = await inventoryOf(remera.id);
      const response = await correct(sale.id, [{ variantId: remera.id, quantity: 1 }]);
      expect(response.status).toBe(200);
      expect(response.body.total).toBe(String(remera.price));

      const inventoryAfter = await inventoryOf(remera.id);
      expect(inventoryAfter.physical).toBe(inventoryBefore.physical);
      expect(inventoryAfter.reserved).toBe(inventoryBefore.reserved - 2n);
      const active = await db.stockReservation.findMany({ where: { saleId: sale.id, status: 'ACTIVE' } });
      expect(active).toHaveLength(1);
      expect(active[0]).toMatchObject({ quantity: 1n, branchId });
      expect(active[0]!.expiresAt.getTime()).toBe(expiresAt.getTime());
      const current = await db.sale.findUniqueOrThrow({ where: { id: sale.id } });
      expect(current).toMatchObject({ status: 'PENDING_PAYMENT', subtotal: remera.price, total: remera.price });
      expect(await db.stockMovement.count()).toBe(0);
      await expectExactCoverage(sale.id);
      await expectReservedMatchesActiveHolds();

      const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'SALE_CORRECTED', entityId: sale.id } });
      expect(audit).toMatchObject({ userId: cashierId, branchId, entityType: 'Sale' });
      expect(audit.before).toMatchObject({
        status: 'PENDING_PAYMENT', total: String(3n * remera.price),
        items: [{ variantId: remera.id, quantity: '3', unitPrice: String(remera.price) }],
      });
      expect(audit.after).toMatchObject({
        status: 'PENDING_PAYMENT', total: String(remera.price),
        items: [{ variantId: remera.id, quantity: '1', unitPrice: String(remera.price) }],
        reservationChanges: [{ variantId: remera.id, before: '3', after: '1' }],
        expiresAt: expiresAt.toISOString(),
      });
    });

    it('increases a quantity against current availability without touching physical stock', async () => {
      const { sale, expiresAt } = await heldSale([{ variant: remera, quantity: 1n }]);
      const inventoryBefore = await inventoryOf(remera.id);
      const response = await correct(sale.id, [{ variantId: remera.id, quantity: 4 }]);
      expect(response.status).toBe(200);
      const inventoryAfter = await inventoryOf(remera.id);
      expect(inventoryAfter.physical).toBe(inventoryBefore.physical);
      expect(inventoryAfter.reserved).toBe(inventoryBefore.reserved + 3n);
      const active = await db.stockReservation.findMany({ where: { saleId: sale.id, status: 'ACTIVE' } });
      expect(active.map((row) => row.expiresAt.getTime())).toEqual([expiresAt.getTime()]);
      expect((await db.sale.findUniqueOrThrow({ where: { id: sale.id } })).total).toBe(4n * remera.price);
      expect(await db.stockMovement.count()).toBe(0);
      await expectExactCoverage(sale.id);
      await expectReservedMatchesActiveHolds();
    });

    it('removes a wrong item by physically deleting its SaleItem and releasing its hold', async () => {
      const { sale } = await heldSale([{ variant: remera, quantity: 2n }, { variant: jean, quantity: 1n }]);
      const jeanItem = await db.saleItem.findFirstOrThrow({ where: { saleId: sale.id, variantId: jean.id } });
      const jeanBefore = await inventoryOf(jean.id);
      const response = await correct(sale.id, [{ variantId: remera.id, quantity: 2 }]);
      expect(response.status).toBe(200);
      expect(await db.saleItem.findUnique({ where: { id: jeanItem.id } })).toBeNull();
      expect((await inventoryOf(jean.id)).reserved).toBe(jeanBefore.reserved - 1n);
      expect((await inventoryOf(jean.id)).physical).toBe(jeanBefore.physical);
      expect((await db.sale.findUniqueOrThrow({ where: { id: sale.id } })).total).toBe(2n * remera.price);
      const audit = await db.auditLog.findFirstOrThrow({ where: { action: 'SALE_CORRECTED' } });
      // The deleted line survives only in the audit's before-state.
      expect(audit.before).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ variantId: jean.id, quantity: '1' })]) });
      expect(await db.stockMovement.count()).toBe(0);
      await expectExactCoverage(sale.id);
      await expectReservedMatchesActiveHolds();
    });

    it('replaces a variant with a current price snapshot and a hold on the ORIGINAL expiry', async () => {
      const { sale, expiresAt } = await heldSale([{ variant: remera, quantity: 1n }]);
      const response = await correct(sale.id, [{ variantId: jean.id, quantity: 2 }]);
      expect(response.status).toBe(200);
      const items = await db.saleItem.findMany({ where: { saleId: sale.id } });
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ variantId: jean.id, productId: jean.productId, quantity: 2n, unitPrice: jean.price, subtotal: 2n * jean.price });
      const active = await db.stockReservation.findMany({ where: { saleId: sale.id, status: 'ACTIVE' } });
      expect(active).toHaveLength(1);
      expect(active[0]).toMatchObject({ variantId: jean.id, quantity: 2n });
      expect(active[0]!.expiresAt.getTime()).toBe(expiresAt.getTime());
      expect((await db.sale.findUniqueOrThrow({ where: { id: sale.id } })).total).toBe(2n * jean.price);
      await expectExactCoverage(sale.id);
      await expectReservedMatchesActiveHolds();
    });

    it('rolls everything back when an increase exceeds availability (INSUFFICIENT_STOCK)', async () => {
      const { sale } = await heldSale([{ variant: remera, quantity: 2n }, { variant: jean, quantity: 1n }]);
      const inventory = await inventoryOf(jean.id);
      const available = inventory.physical - inventory.reserved;
      const before = await snapshot(sale.id);
      const response = await correct(sale.id, [
        { variantId: remera.id, quantity: 1 },
        { variantId: jean.id, quantity: String(1n + available + 1n) },
      ]);
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('INSUFFICIENT_STOCK');
      expect(await snapshot(sale.id)).toEqual(before);
    });

    it('rolls back when the reserved counter cannot absorb a decrease', async () => {
      const { sale } = await heldSale([{ variant: remera, quantity: 3n }]);
      await db.inventory.update({ where: { variantId_branchId: { variantId: remera.id, branchId } }, data: { reserved: 1n } });
      const before = await snapshot(sale.id);
      const response = await correct(sale.id, [{ variantId: remera.id, quantity: 1 }]);
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('INVALID_RESERVATION');
      expect(await snapshot(sale.id)).toEqual(before);
    });

    it('rejects a correction that changes nothing (NO_CHANGES), so a replay is harmless', async () => {
      const { sale } = await heldSale([{ variant: remera, quantity: 3n }]);
      expect((await correct(sale.id, [{ variantId: remera.id, quantity: 2 }])).status).toBe(200);
      const before = await snapshot(sale.id);
      const replay = await correct(sale.id, [{ variantId: remera.id, quantity: 2 }]);
      expect(replay.status).toBe(409);
      expect(replay.body.error.code).toBe('NO_CHANGES');
      expect(await snapshot(sale.id)).toEqual(before);
      await expectReservedMatchesActiveHolds();
    });

    it('rejects an inactive or unknown target variant', async () => {
      const { sale } = await heldSale([{ variant: remera, quantity: 1n }]);
      await db.productVariant.update({ where: { id: jean.id }, data: { isActive: false } });
      expect((await correct(sale.id, [{ variantId: jean.id, quantity: 1 }])).status).toBe(404);
      expect((await correct(sale.id, [{ variantId: randomUUID(), quantity: 1 }])).status).toBe(404);
    });
  });

  describe('input validation', () => {
    const invalid: Array<[string, object]> = [
      ['an empty item list (an empty sale is never valid)', { items: [] }],
      ['a zero quantity', { items: [{ variantId: '00000000-0000-4000-8000-000000000001', quantity: '0' }] }],
      ['a negative quantity', { items: [{ variantId: '00000000-0000-4000-8000-000000000001', quantity: '-1' }] }],
      ['a fractional quantity', { items: [{ variantId: '00000000-0000-4000-8000-000000000001', quantity: '1.5' }] }],
      ['a non-uuid variant', { items: [{ variantId: 'abc', quantity: '1' }] }],
      ['unknown fields', { items: [{ variantId: '00000000-0000-4000-8000-000000000001', quantity: '1' }], branchId: 'x' }],
    ];
    for (const [name, body] of invalid) {
      it(`rejects ${name}`, async () => {
        const { sale } = await heldSale([{ variant: remera, quantity: 1n }]);
        const response = await request(app).post(`/api/v1/sales/${sale.id}/correct`)
          .set('Authorization', `Bearer ${tokens.cashier}`).send(body);
        expect(response.status).toBe(400);
        expect(response.body.error.code).toBe('VALIDATION_ERROR');
      });
    }

    it('rejects the same variant twice in one correction (one SaleItem per variant)', async () => {
      const { sale } = await heldSale([{ variant: remera, quantity: 1n }]);
      const response = await correct(sale.id, [{ variantId: remera.id, quantity: 1 }, { variantId: remera.id, quantity: 2 }]);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('concurrency (Sale-first serialization)', () => {
    it('concurrent corrections never let reserved drift from the ACTIVE holds', async () => {
      const { sale } = await heldSale([{ variant: remera, quantity: 1n }]);
      const results = await Promise.all([
        correct(sale.id, [{ variantId: remera.id, quantity: 3 }]),
        correct(sale.id, [{ variantId: remera.id, quantity: 5 }]),
      ]);
      expect(results.some((response) => response.status === 200)).toBe(true);
      for (const response of results) expect([200, 409]).toContain(response.status);
      await expectExactCoverage(sale.id);
      await expectReservedMatchesActiveHolds();
    });

    it('correction vs first payment: exactly one of them commits, never both', async () => {
      // The payment pays the ORIGINAL total exactly. If it commits first the
      // sale is PAID and the correction is refused; if the correction commits
      // first the total shrinks and the stale payment is an OVERPAYMENT.
      const { sale } = await heldSale([{ variant: remera, quantity: 2n }]);
      const [correction, payment] = await Promise.all([
        correct(sale.id, [{ variantId: remera.id, quantity: 1 }]),
        request(app).post(`/api/v1/sales/${sale.id}/payments`).set('Authorization', `Bearer ${tokens.cashier}`)
          .send({ method: 'TRANSFER', amount: String(2n * remera.price), idempotencyKey: randomUUID() }),
      ]);
      const committed = [correction.status === 200, payment.status === 201].filter(Boolean);
      expect(committed).toHaveLength(1);
      if (payment.status === 201) {
        expect(correction.status).toBe(409);
        expect(['INVALID_SALE_STATE', 'PAYMENT_ALREADY_ACCEPTED']).toContain(correction.body.error.code);
        expect(await db.auditLog.count({ where: { action: 'SALE_CORRECTED' } })).toBe(0);
      } else {
        expect(payment.body.error.code).toBe('OVERPAYMENT');
        expect(await db.salePayment.count({ where: { saleId: sale.id } })).toBe(0);
      }
      await expectExactCoverage(sale.id);
      await expectReservedMatchesActiveHolds();
    });

    it('correction vs expiry release: whichever commits first, the counter stays exact', async () => {
      const { sale, expiresAt } = await heldSale([{ variant: remera, quantity: 2n }]);
      const service = createCancellationService(db);
      const system = await db.user.findFirstOrThrow({ where: { email: 'owner01@demo.local' } });
      const [correction, release] = await Promise.all([
        correct(sale.id, [{ variantId: remera.id, quantity: 4 }]),
        // A release evaluated just after the ORIGINAL expiry: it still
        // releases corrected holds, proving correction never extended them.
        service.releaseExpiredSaleHolds(sale.id, {
          actor: { userId: system.id, trigger: 'ADMIN' }, now: new Date(expiresAt.getTime() + 1),
        }),
      ]);
      expect(release.outcome).toBe('RELEASED');
      expect([200, 409]).toContain(correction.status);
      expect(await db.stockReservation.count({ where: { saleId: sale.id, status: 'ACTIVE' } })).toBe(0);
      await expectReservedMatchesActiveHolds();
    });
  });
});
