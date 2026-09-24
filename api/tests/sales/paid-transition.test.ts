import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedDemo } from '../../prisma/seed.js';
import { createApp } from '../../src/app.js';
import { createCancellationService } from '../../src/modules/sales/cancellation.service.js';
import { logger } from '../../src/shared/logger.js';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { createTestPrismaClient, truncateAllTables } from '../helpers/test-db.js';
import { getAuthToken } from '../helpers/auth.js';

describe('PENDING_PAYMENT to PAID transition', () => {
  let db: PrismaClient;
  let app: ReturnType<typeof createApp>;
  let sellerId: string;
  let cashierId: string;
  let branchId: string;
  let otherBranchId: string;
  let remeraId: string;
  let remeraProductId: string;
  let jeanId: string;
  let jeanProductId: string;
  let token: string;

  beforeAll(async () => {
    db = await createTestPrismaClient();
    app = createApp(db);
  }, 120000);

  beforeEach(async () => {
    await truncateAllTables(db);
    await seedDemo(db);
    const [seller, cashier, branch, otherBranch, remera, jean] = await Promise.all([
      db.user.findUniqueOrThrow({ where: { email: 'seller01@demo.local' } }),
      db.user.findUniqueOrThrow({ where: { email: 'cashier01@demo.local' } }),
      db.branch.findUniqueOrThrow({ where: { code: 'CEN' } }),
      db.branch.findUniqueOrThrow({ where: { code: 'YB' } }),
      db.productVariant.findUniqueOrThrow({ where: { sku: 'REM-NEG-M' } }),
      db.productVariant.findUniqueOrThrow({ where: { sku: 'JEA-AZU-42' } }),
    ]);
    sellerId = seller.id;
    cashierId = cashier.id;
    branchId = branch.id;
    otherBranchId = otherBranch.id;
    remeraId = remera.id;
    remeraProductId = remera.productId;
    jeanId = jean.id;
    jeanProductId = jean.productId;
    token = await getAuthToken(cashier);
  }, 120000);

  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => { await db?.$disconnect(); }, 120000);

  const HOUR = 60 * 60 * 1000;
  const valid = () => new Date(Date.now() + HOUR);
  const expired = () => new Date(Date.now() - HOUR);

  // Pilot P0.1-C: a PENDING_PAYMENT sale is only chargeable with exact
  // current ACTIVE hold coverage, so the default fixture is a realistic
  // held sale (one SaleItem + matching unexpired ACTIVE hold + counter).
  async function createSale(
    total: bigint = 16500000n,
    status: 'DRAFT' | 'PENDING_PAYMENT' | 'PAID' | 'COMPLETED' | 'CANCELLED' = 'PENDING_PAYMENT',
    options: { held?: boolean; expiresAt?: Date } = {},
  ) {
    const sale = await db.sale.create({
      data: { sellerId, branchId, status, subtotal: total, total },
    });
    if (status === 'PENDING_PAYMENT' && options.held !== false) {
      await addItem(sale.id);
      await addHold(sale.id, { expiresAt: options.expiresAt });
    }
    return sale;
  }

  async function addItem(saleId: string, variantId = remeraId, productId = remeraProductId, quantity = 1n) {
    return db.saleItem.create({
      data: {
        saleId, variantId, productId, productName: 'Snapshot product', variantName: 'Snapshot variant',
        sku: `SNAP-${variantId}`, quantity, unitPrice: 1n, subtotal: quantity,
      },
    });
  }

  async function addHold(saleId: string, options: {
    variantId?: string; quantity?: bigint; expiresAt?: Date; branchId?: string; status?: 'ACTIVE' | 'RELEASED' | 'CONSUMED';
  } = {}) {
    const variantId = options.variantId ?? remeraId;
    const quantity = options.quantity ?? 1n;
    const holdBranchId = options.branchId ?? branchId;
    const status = options.status ?? 'ACTIVE';
    if (status === 'ACTIVE') {
      await db.inventory.update({
        where: { variantId_branchId: { variantId, branchId: holdBranchId } },
        data: { reserved: { increment: quantity } },
      });
    }
    return db.stockReservation.create({
      data: { saleId, variantId, branchId: holdBranchId, quantity, status, expiresAt: options.expiresAt ?? valid() },
    });
  }

  async function expireHolds(saleId: string) {
    await db.stockReservation.updateMany({ where: { saleId }, data: { expiresAt: expired() } });
  }

  async function sideEffects(saleId: string) {
    return {
      payments: await db.salePayment.count({ where: { saleId } }),
      movements: await db.cashMovement.count(),
      audits: await db.auditLog.count({ where: { action: 'PAYMENT_REGISTERED' } }),
      status: (await db.sale.findUniqueOrThrow({ where: { id: saleId } })).status,
      reservations: await db.stockReservation.findMany({ where: { saleId }, orderBy: { id: 'asc' } }),
      inventory: await db.inventory.findMany({ orderBy: { id: 'asc' }, select: { id: true, physical: true, reserved: true } }),
      releases: await db.auditLog.count({ where: { action: 'RESERVATION_RELEASED' } }),
      stockMovements: await db.stockMovement.count(),
    };
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
  // Pilot P0.1-C: payment against current technical-hold coverage.
  describe('current hold coverage at payment (Pilot P0.1-C)', () => {
    const transfer = (amount = '16500000') => ({ method: 'TRANSFER', amount, idempotencyKey: randomUUID() });

    async function expectRejectedWithoutSideEffects(saleId: string, body: object, code: string) {
      const before = await sideEffects(saleId);
      const response = await pay(saleId, body);
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe(code);
      expect(await sideEffects(saleId)).toEqual(before);
    }

    it('accepts a first payment with exact unexpired ACTIVE coverage', async () => {
      const sale = await createSale();
      const response = await pay(sale.id, transfer());
      expect(response.status).toBe(201);
      expect((await db.sale.findUniqueOrThrow({ where: { id: sale.id } })).status).toBe('PAID');
    });

    it('rejects a first payment on an expired zero-payment hold with no payment, cash, audit, status or release side effect', async () => {
      await openCashSession();
      const sale = await createSale(16500000n, 'PENDING_PAYMENT', { expiresAt: expired() });
      await expectRejectedWithoutSideEffects(sale.id, {
        method: 'CASH', amount: '16500000', receivedAmount: '16500000', idempotencyKey: randomUUID(),
      }, 'RESERVATION_EXPIRED');
      expect((await db.stockReservation.findFirstOrThrow({ where: { saleId: sale.id } })).status).toBe('ACTIVE');
    });

    it('rejects a first payment after the hold was released by the authoritative expiry release', async () => {
      const sale = await createSale(16500000n, 'PENDING_PAYMENT', { expiresAt: expired() });
      const released = await createCancellationService(db).releaseExpiredSaleHolds(sale.id, {
        actor: { userId: cashierId, trigger: 'ADMIN' }, now: new Date(),
      });
      expect(released.outcome).toBe('RELEASED');
      await expectRejectedWithoutSideEffects(sale.id, transfer(), 'INVALID_RESERVATION');
    });

    it.each([
      ['missing ACTIVE hold', async (saleId: string) => { await addItem(saleId); }],
      ['wrong-branch ACTIVE hold', async (saleId: string) => { await addItem(saleId); await addHold(saleId, { branchId: otherBranchId }); }],
      ['ACTIVE quantity below the items', async (saleId: string) => { await addItem(saleId, remeraId, remeraProductId, 2n); await addHold(saleId); }],
      ['ACTIVE quantity above the items', async (saleId: string) => { await addItem(saleId); await addHold(saleId, { quantity: 2n }); }],
      ['unexpected ACTIVE variant', async (saleId: string) => { await addItem(saleId); await addHold(saleId); await addHold(saleId, { variantId: jeanId }); }],
      ['only historical RELEASED coverage', async (saleId: string) => { await addItem(saleId); await addHold(saleId, { status: 'RELEASED' }); }],
      ['only historical CONSUMED coverage', async (saleId: string) => { await addItem(saleId); await addHold(saleId, { status: 'CONSUMED' }); }],
      ['no SaleItems at all', async () => undefined],
    ])('rejects a first payment with %s', async (_label, prepare) => {
      const sale = await createSale(16500000n, 'PENDING_PAYMENT', { held: false });
      await prepare(sale.id);
      await expectRejectedWithoutSideEffects(sale.id, transfer(), 'INVALID_RESERVATION');
    });

    it('ignores a historical RELEASED row next to correct current ACTIVE coverage', async () => {
      const sale = await createSale(16500000n, 'PENDING_PAYMENT', { held: false });
      await addItem(sale.id);
      await addHold(sale.id, { status: 'RELEASED', expiresAt: expired() });
      await addHold(sale.id);
      expect((await pay(sale.id, transfer())).status).toBe(201);
    });

    it('accepts exact coverage across two variants and duplicate SaleItems', async () => {
      const sale = await createSale(16500000n, 'PENDING_PAYMENT', { held: false });
      await addItem(sale.id, remeraId, remeraProductId, 1n);
      await addItem(sale.id, remeraId, remeraProductId, 2n);
      await addItem(sale.id, jeanId, jeanProductId, 1n);
      await addHold(sale.id, { quantity: 3n });
      await addHold(sale.id, { variantId: jeanId });
      expect((await pay(sale.id, transfer())).status).toBe(201);
    });

    it('lets a partially paid sale take its remaining payment after expiresAt (Policy A) and reach PAID', async () => {
      const sale = await createSale();
      expect((await pay(sale.id, transfer('10000000'))).status).toBe(201);
      await expireHolds(sale.id);
      const remainder = await pay(sale.id, transfer('6500000'));
      expect(remainder.status).toBe(201);
      expect(await acceptedTotal(sale.id)).toBe(16500000n);
      expect((await db.sale.findUniqueOrThrow({ where: { id: sale.id } })).status).toBe('PAID');
      expect((await db.stockReservation.findFirstOrThrow({ where: { saleId: sale.id } })).status).toBe('ACTIVE');
    });

    it('keeps a partial payment past expiresAt below total PENDING_PAYMENT', async () => {
      const sale = await createSale();
      await pay(sale.id, transfer('10000000'));
      await expireHolds(sale.id);
      expect((await pay(sale.id, transfer('1000000'))).status).toBe(201);
      expect((await db.sale.findUniqueOrThrow({ where: { id: sale.id } })).status).toBe('PENDING_PAYMENT');
    });

    it('still rejects OVERPAYMENT on a partially paid sale past expiresAt', async () => {
      const sale = await createSale();
      await pay(sale.id, transfer('10000000'));
      await expireHolds(sale.id);
      await expectRejectedWithoutSideEffects(sale.id, transfer('6500001'), 'OVERPAYMENT');
    });

    it.each([
      ['current coverage released', async (saleId: string) => { await db.stockReservation.updateMany({ where: { saleId }, data: { status: 'RELEASED' } }); }],
      ['current coverage moved to another branch', async (saleId: string) => { await db.stockReservation.updateMany({ where: { saleId }, data: { branchId: otherBranchId } }); }],
      ['an extra ACTIVE variant', async (saleId: string) => { await addHold(saleId, { variantId: jeanId }); }],
    ])('rejects the next payment of a partially paid sale with %s despite payment protection', async (_label, corrupt) => {
      const sale = await createSale();
      await pay(sale.id, transfer('10000000'));
      await expireHolds(sale.id);
      await corrupt(sale.id);
      await expectRejectedWithoutSideEffects(sale.id, transfer('6500000'), 'INVALID_RESERVATION');
    });

    it('replays a partial payment idempotently after the hold timestamp passed', async () => {
      const sale = await createSale();
      const body = transfer('10000000');
      const first = await pay(sale.id, body);
      await expireHolds(sale.id);
      const before = await sideEffects(sale.id);
      const replay = await pay(sale.id, body);
      expect(replay.status).toBe(200);
      expect(replay.body.id).toBe(first.body.id);
      expect(await sideEffects(sale.id)).toEqual(before);
    });

    it('replays the final payment idempotently after PAID and an expired timestamp', async () => {
      const sale = await createSale();
      const body = transfer();
      const first = await pay(sale.id, body);
      await expireHolds(sale.id);
      const replay = await pay(sale.id, body);
      expect(replay.status).toBe(200);
      expect(replay.body.id).toBe(first.body.id);
      expect(await db.salePayment.count({ where: { saleId: sale.id } })).toBe(1);
      expect(await db.auditLog.count({ where: { action: 'PAYMENT_REGISTERED' } })).toBe(1);
    });

    it('replays the final payment idempotently after the sale was COMPLETED', async () => {
      const sale = await createSale();
      const body = transfer();
      const first = await pay(sale.id, body);
      const completed = await request(app).post(`/api/v1/sales/${sale.id}/complete`).set('Authorization', `Bearer ${token}`).send({});
      expect(completed.status).toBe(200);
      const replay = await pay(sale.id, body);
      expect(replay.status).toBe(200);
      expect(replay.body.id).toBe(first.body.id);
      expect(await db.salePayment.count({ where: { saleId: sale.id } })).toBe(1);
      expect(await db.auditLog.count({ where: { action: 'PAYMENT_REGISTERED' } })).toBe(1);
    });

    it('never writes a release, reserved decrement or RESERVATION_RELEASED audit from the payment path', async () => {
      const sale = await createSale(16500000n, 'PENDING_PAYMENT', { expiresAt: expired() });
      const before = await sideEffects(sale.id);
      expect((await pay(sale.id, transfer())).status).toBe(409);
      const after = await sideEffects(sale.id);
      expect(after.reservations).toEqual(before.reservations);
      expect(after.inventory).toEqual(before.inventory);
      expect(after.releases).toBe(before.releases);
    });
  });

  // Pilot P0.1-C: payment and the authoritative expiry release both lock the
  // Sale row first, so whichever commits first decides. The release unit's
  // injected clock stands in for "the hold has since expired" while the
  // payment path keeps its own wall clock.
  describe('payment vs authoritative expiry release (Pilot P0.1-C)', () => {
    const later = () => new Date(Date.now() + 2 * HOUR);
    const release = (saleId: string) => createCancellationService(db).releaseExpiredSaleHolds(saleId, {
      actor: { userId: cashierId, trigger: 'ADMIN' }, now: later(),
    });
    const reserved = async () => (await db.inventory.findUniqueOrThrow({ where: { variantId_branchId: { variantId: remeraId, branchId } } })).reserved;

    it('payment first: the later release is PAYMENT_PROTECTED and the hold stays ACTIVE', async () => {
      const sale = await createSale(16500000n, 'PENDING_PAYMENT');
      expect((await pay(sale.id, { method: 'TRANSFER', amount: '10000000', idempotencyKey: randomUUID() })).status).toBe(201);
      const before = await reserved();
      expect((await release(sale.id)).outcome).toBe('PAYMENT_PROTECTED');
      expect((await db.stockReservation.findFirstOrThrow({ where: { saleId: sale.id } })).status).toBe('ACTIVE');
      expect(await reserved()).toBe(before);
    });

    it('release first: the hold is RELEASED and the payment is rejected with nothing persisted', async () => {
      const sale = await createSale(16500000n, 'PENDING_PAYMENT');
      const before = await reserved();
      expect((await release(sale.id)).outcome).toBe('RELEASED');
      expect(await reserved()).toBe(before - 1n);
      const response = await pay(sale.id, { method: 'TRANSFER', amount: '16500000', idempotencyKey: randomUUID() });
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('INVALID_RESERVATION');
      expect(await db.salePayment.count({ where: { saleId: sale.id } })).toBe(0);
    });

    it('a genuinely concurrent payment and release end in exactly one consistent outcome', async () => {
      const sale = await createSale(16500000n, 'PENDING_PAYMENT');
      const before = await reserved();
      const [payment, released] = await Promise.all([
        pay(sale.id, { method: 'TRANSFER', amount: '10000000', idempotencyKey: randomUUID() }),
        release(sale.id),
      ]);
      const payments = await db.salePayment.count({ where: { saleId: sale.id } });
      const hold = await db.stockReservation.findFirstOrThrow({ where: { saleId: sale.id } });
      if (payment.status === 201) {
        expect(released.outcome).toBe('PAYMENT_PROTECTED');
        expect(payments).toBe(1);
        expect(hold.status).toBe('ACTIVE');
        expect(await reserved()).toBe(before);
      } else {
        expect(payment.status).toBe(409);
        expect(released.outcome).toBe('RELEASED');
        expect(payments).toBe(0);
        expect(hold.status).toBe('RELEASED');
        expect(await reserved()).toBe(before - 1n);
      }
    });
  });

  // Pilot P0.1-C: realtime is advisory. A notification failure after the
  // payment transaction committed must never turn that committed payment
  // into an HTTP error the cashier could read as "not charged".
  describe('payment realtime isolation (Pilot P0.1-C)', () => {
    it('keeps a committed final payment successful when the sale.paid notification throws', async () => {
      const warn = vi.spyOn(logger, 'warn');
      const emit = vi.fn(() => { throw new Error('socket adapter down: secret-internal-detail'); });
      const throwingApp = createApp(db, { emit });
      const sale = await createSale();
      const body = { method: 'TRANSFER', amount: '16500000', idempotencyKey: randomUUID() };
      const response = await request(throwingApp).post(`/api/v1/sales/${sale.id}/payments`).set('Authorization', `Bearer ${token}`).send(body);
      expect(response.status).toBe(201);
      expect(emit).toHaveBeenCalledTimes(1);
      expect((await db.sale.findUniqueOrThrow({ where: { id: sale.id } })).status).toBe('PAID');
      expect(await db.salePayment.count({ where: { saleId: sale.id } })).toBe(1);
      expect(await db.auditLog.count({ where: { action: 'PAYMENT_REGISTERED' } })).toBe(1);
      const events = warn.mock.calls.map(([entry]) => entry as { event?: string });
      expect(events.filter((entry) => entry.event === 'payment_notify_failed')).toEqual([
        { event: 'payment_notify_failed', saleId: sale.id, code: 'NOTIFY_FAILED' },
      ]);
      expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-internal-detail');

      const replay = await request(throwingApp).post(`/api/v1/sales/${sale.id}/payments`).set('Authorization', `Bearer ${token}`).send(body);
      expect(replay.status).toBe(200);
      expect(replay.body.id).toBe(response.body.id);
      expect(emit).toHaveBeenCalledTimes(1);
      expect(await db.salePayment.count({ where: { saleId: sale.id } })).toBe(1);
      expect(await db.auditLog.count({ where: { action: 'PAYMENT_REGISTERED' } })).toBe(1);
    });
  });
});
