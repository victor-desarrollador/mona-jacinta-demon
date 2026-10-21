// System V2 · P0-A — the legacy FIXED_TOTAL payment path takes CASH only.
//
// DB-FREE: the REAL sales and payments services run against
// tests/helpers/in-memory-sales-db.ts, so no query reaches a database (run it
// through scripts/dev/safe-nodb-run.mjs).
//
// WHY: the legacy path (POST /sales/:id/payments → payments.service) accepted
// TRANSFER, CARD_DEBIT, CARD_CREDIT and QR with no reference, institution or
// evidence at all, so a sale could be marked PAID with a payment that never
// existed (Matrix R4 domain 6, FR-PAY-006). The only valid evidence contract
// for a non-cash payment is ExternalCollection, which exists only inside the
// PROPORTIONAL_V1 checkout. Therefore a FIXED_TOTAL sale accepts CASH only and
// every non-cash method is refused with NON_CASH_REQUIRES_PROPORTIONAL_CHECKOUT.
//
// PRE-REGISTERED EXPECTATIONS (written before the guard existed):
//   F01-F04 TRANSFER / CARD_DEBIT / CARD_CREDIT / QR on a FIXED_TOTAL sale →
//           409 NON_CASH_REQUIRES_PROPORTIONAL_CHECKOUT; no SalePayment, no
//           CashMovement, no audit row, sale stays PENDING_PAYMENT, and the
//           idempotency key is NOT consumed
//   F05     CASH keeps working: BigInt amounts, received/change, SALE_INCOME,
//           PAYMENT_REGISTERED audit, exact replay
//   F06     CASH partial, then TRANSFER → refused; the CASH row is untouched;
//           the remaining CASH completes the sale
//   F07     HISTORICAL replay: an existing non-cash row with the same
//           (saleId, idempotencyKey) is still returned, never refused; reuse
//           with a different payload keeps its 409
//   F08     the guard is the first thing a NEW intent meets: a non-cash intent
//           on a sale that is no longer payable gets the guard error
//   F09     a PROPORTIONAL_V1 sale is still routed to the checkout
//           (CHECKOUT_REQUIRED), not to the new guard
//   F10     the wire DTO is unchanged (the pricing model is unknown at the edge)
//   P01-P05 PROPORTIONAL_V1 regression: a non-cash tender needs a reference or
//           a registered external collection; CASH takes neither
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { AppError } from '../../src/shared/errors.js';
import { DEFAULT_ROLE_GRANTS } from '../../src/modules/rbac/role-permission-matrix.js';
import { createSalesService } from '../../src/modules/sales/sales.service.js';
import { createPaymentsService } from '../../src/modules/payments/payments.service.js';
import { registerPaymentDto } from '../../src/modules/payments/dto/payment.dto.js';
import { checkoutRequestDto } from '../../src/modules/payments/dto/checkout.dto.js';
import { createInMemorySalesDb } from '../helpers/in-memory-sales-db.js';

const NON_CASH = ['TRANSFER', 'CARD_DEBIT', 'CARD_CREDIT', 'QR'] as const;
const GUARD_CODE = 'NON_CASH_REQUIRES_PROPORTIONAL_CHECKOUT';

function assignment(role: 'SELLER' | 'CASHIER', locationId: string): Express.ProductionAssignment {
  return { roleId: role, roleCode: role, scopeKind: 'LOCATION', locationId, permissions: [...DEFAULT_ROLE_GRANTS[role]] };
}

function requestFor(userId: string, assignments: Express.ProductionAssignment[]): Request {
  const effectiveLocationIds = assignments.flatMap(({ locationId }) => (locationId ? [locationId] : []));
  return { auth: { userId, roles: assignments.map(({ roleCode }) => roleCode), assignments, effectiveLocationIds } } as unknown as Request;
}

function setup(options: { proportional?: boolean } = {}) {
  const db = createInMemorySalesDb();
  db.insert('company', { name: 'Mona Jacinta', cuit: '00000000000', address: 'Demo', isActive: true, createdAt: new Date() });
  const L1 = db.insert('location', { isActive: true }).id as string;
  db.insert('branch', { id: L1, code: 'S1', name: 'Sucursal 1' });
  db.insert('saleNumberCounter', { branchId: L1, nextValue: 1n });
  const user = (name: string) => db.insert('user', { name, email: `${name}@test.invalid`, isActive: true }).id as string;
  const ids = { seller: user('seller'), cashier: user('cashier') };
  const product = db.insert('product', { name: 'Remera', isActive: true }).id as string;
  const V1 = db.insert('productVariant', {
    productId: product, sku: 'V1', barcode: 'V1', cashPrice: 10000n, price: 10000n, wholesalePrice: null, costPrice: 1000n, color: 'Negro', size: 'M',
  }).id as string;
  db.insert('inventory', { branchId: L1, variantId: V1, physical: 100n, reserved: 0n });
  const registerId = db.insert('cashRegister', { branchId: L1, name: 'Caja 1' }).id as string;
  const session = db.insert('cashSession', { registerId, openedById: ids.cashier, startingCash: 0n, status: 'OPEN' }).id as string;
  const reqs = {
    seller: requestFor(ids.seller, [assignment('SELLER', L1)]),
    cashier: requestFor(ids.cashier, [assignment('CASHIER', L1)]),
  };
  const client = db.client as unknown as PrismaClient;
  const sales = createSalesService(client, { proportionalCheckoutLocationIds: options.proportional ? [L1] : [] });
  const payments = createPaymentsService(client);

  // A PENDING_PAYMENT sale of 2 x 10000 in LIST mode: LIST accepts every method
  // at the price-mode check, so the ONLY thing that can refuse a non-cash
  // payment here is the FIXED_TOTAL guard under test.
  async function pendingSale() {
    const created = await sales.createDraftSale(reqs.seller, ids.seller, L1);
    await sales.addItem(reqs.seller, ids.seller, created.id, { variantId: V1, quantity: 2n });
    if (!options.proportional) await sales.updatePriceMode(reqs.seller, ids.seller, created.id, 'LIST');
    await sales.sendToCashier(created.id, ids.seller, [L1]);
    return created.id;
  }
  const sale = (saleId: string) => db.table('sale').find((row) => row.id === saleId)!;
  const cashPayment = (saleId: string, amount: bigint, key = randomUUID(), received = amount) =>
    payments.registerPayment(reqs.cashier, ids.cashier, saleId, { method: 'CASH', amount, receivedAmount: received, idempotencyKey: key });
  const nonCash = (saleId: string, method: (typeof NON_CASH)[number], amount: bigint, key = randomUUID()) =>
    payments.registerPayment(reqs.cashier, ids.cashier, saleId, { method, amount, receivedAmount: null, idempotencyKey: key });
  const counts = () => ({
    payments: db.table('salePayment').length,
    cash: db.table('cashMovement').length,
    audits: db.table('auditLog').length,
  });
  return { db, L1, ids, session, sales, payments, pendingSale, sale, cashPayment, nonCash, counts };
}

async function appError(promise: Promise<unknown>) {
  const error = await promise.then(() => null, (cause: unknown) => cause);
  expect(error, 'expected an AppError').toBeInstanceOf(AppError);
  return { status: (error as AppError).status, code: (error as AppError).code, message: (error as AppError).message };
}

describe('P0-A FIXED_TOTAL accepts CASH only', () => {
  it.each(NON_CASH)('F01-F04 %s on a FIXED_TOTAL sale is refused and writes nothing', async (method) => {
    const t = setup();
    const saleId = await t.pendingSale();
    expect(t.sale(saleId)).toMatchObject({ pricingModel: 'FIXED_TOTAL', status: 'PENDING_PAYMENT', total: 20000n });
    const before = t.counts();
    const key = randomUUID();

    const refusal = await appError(t.nonCash(saleId, method, 20000n, key));

    expect(refusal).toMatchObject({ status: 409, code: GUARD_CODE });
    expect(refusal.message).toMatch(/checkout proporcional/i);
    expect(t.counts()).toEqual(before);
    expect(t.sale(saleId).status).toBe('PENDING_PAYMENT');
    expect(t.db.table('auditLog').some((row) => row.action === 'PAYMENT_REGISTERED')).toBe(false);

    // The refused intent did not consume its idempotency key: the same key is
    // free for a valid CASH payment.
    const cash = await t.cashPayment(saleId, 20000n, key);
    expect(cash.replayed).toBe(false);
  });

  it('F05 CASH still works: BigInt, received/change, SALE_INCOME, audit and exact replay', async () => {
    const t = setup();
    const saleId = await t.pendingSale();
    const key = randomUUID();

    const first = await t.cashPayment(saleId, 20000n, key, 25000n);

    expect(first).toMatchObject({ replayed: false, resultingStatus: 'PAID' });
    expect(first.payment).toMatchObject({ method: 'CASH', amount: 20000n, receivedAmount: 25000n, changeAmount: 5000n });
    expect(typeof first.payment.amount).toBe('bigint');
    expect(t.sale(saleId).status).toBe('PAID');
    expect(t.db.table('cashMovement')).toHaveLength(1);
    expect(t.db.table('cashMovement')[0]).toMatchObject({ type: 'SALE_INCOME', amount: 20000n, sessionId: t.session });
    expect(t.db.table('auditLog').filter((row) => row.action === 'PAYMENT_REGISTERED')).toHaveLength(1);

    const replay = await t.cashPayment(saleId, 20000n, key, 25000n);
    expect(replay.replayed).toBe(true);
    expect(t.db.table('salePayment')).toHaveLength(1);
    expect(t.db.table('cashMovement')).toHaveLength(1);
    expect(t.db.table('auditLog').filter((row) => row.action === 'PAYMENT_REGISTERED')).toHaveLength(1);
  });

  it('F06 CASH then TRANSFER: the transfer is refused, the CASH row is intact, CASH completes the sale', async () => {
    const t = setup();
    const saleId = await t.pendingSale();
    const cash = await t.cashPayment(saleId, 5000n);
    expect(cash.resultingStatus).toBe('PENDING_PAYMENT');
    const afterCash = t.counts();
    const cashRow = { ...t.db.table('salePayment')[0] };

    expect(await appError(t.nonCash(saleId, 'TRANSFER', 15000n))).toMatchObject({ status: 409, code: GUARD_CODE });

    expect(t.counts()).toEqual(afterCash);
    expect(t.db.table('salePayment')[0]).toEqual(cashRow);
    expect(t.sale(saleId).status).toBe('PENDING_PAYMENT');

    const rest = await t.cashPayment(saleId, 15000n);
    expect(rest.resultingStatus).toBe('PAID');
    expect(t.db.table('cashMovement').map((row) => row.amount)).toEqual([5000n, 15000n]);
  });

  it('F07 an existing HISTORICAL non-cash payment still replays; a different payload keeps its 409', async () => {
    const t = setup();
    const saleId = await t.pendingSale();
    const key = randomUUID();
    // A row written by the legacy path before this guard existed.
    t.db.insert('salePayment', {
      saleId, method: 'TRANSFER', amount: 20000n, receivedAmount: null, changeAmount: null, cashSessionId: null,
      idempotencyKey: key, pricingModel: 'FIXED_TOTAL', paidAt: new Date(),
    });
    const before = t.counts();

    const replay = await t.nonCash(saleId, 'TRANSFER', 20000n, key);

    expect(replay.replayed).toBe(true);
    expect(replay.payment).toMatchObject({ method: 'TRANSFER', amount: 20000n });
    expect(t.counts()).toEqual(before);

    expect(await appError(t.nonCash(saleId, 'QR', 20000n, key))).toMatchObject({
      status: 409, code: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD',
    });
    expect(t.counts()).toEqual(before);
  });

  it('F08 a NEW non-cash intent meets the guard before the sale-state check', async () => {
    const t = setup();
    const saleId = await t.pendingSale();
    await t.cashPayment(saleId, 20000n);
    expect(t.sale(saleId).status).toBe('PAID');

    expect(await appError(t.nonCash(saleId, 'CARD_DEBIT', 1n))).toMatchObject({ status: 409, code: GUARD_CODE });
  });

  it('F09 a PROPORTIONAL_V1 sale is still routed to the checkout, not to the guard', async () => {
    const t = setup({ proportional: true });
    const saleId = await t.pendingSale();
    expect(t.sale(saleId).pricingModel).toBe('PROPORTIONAL_V1');

    for (const attempt of [t.nonCash(saleId, 'TRANSFER', 20000n), t.cashPayment(saleId, 20000n)]) {
      expect(await appError(attempt)).toMatchObject({ status: 409, code: 'CHECKOUT_REQUIRED' });
    }
  });

  it('F10 the wire DTO is unchanged: the pricing model is unknown at the edge, so the service decides', () => {
    for (const method of NON_CASH) {
      expect(registerPaymentDto.safeParse({ method, amount: '100', idempotencyKey: randomUUID() }).success).toBe(true);
    }
    expect(registerPaymentDto.safeParse({ method: 'CASH', amount: '100', idempotencyKey: randomUUID() }).success).toBe(false);
  });
});

describe('P0-A regression: PROPORTIONAL_V1 non-cash tenders still need evidence', () => {
  const base = () => ({
    operationKey: randomUUID(),
    cashSessionId: randomUUID(),
    balanceMethod: 'CASH',
    expectedTotal: '20000',
    expectedBalanceAmount: '10000',
  });
  const cashBalance = { method: 'CASH', role: 'BALANCE', receivedAmount: '10000' };

  it('P01 a non-cash FIXED tender with neither reference nor external collection is invalid', () => {
    for (const method of ['TRANSFER', 'CARD_DEBIT', 'CARD_CREDIT']) {
      const tender = { method, role: 'FIXED', amount: '10000', ...(method === 'TRANSFER' ? { institution: 'MACRO' } : {}) };
      expect(checkoutRequestDto.safeParse({ ...base(), tenders: [tender, cashBalance] }).success, method).toBe(false);
    }
  });

  it('P02 a non-cash FIXED tender with a valid reference is accepted', () => {
    const tenders = [
      { method: 'TRANSFER', role: 'FIXED', amount: '10000', reference: 'TRF-0001', institution: 'MACRO' },
      cashBalance,
    ];
    expect(checkoutRequestDto.safeParse({ ...base(), tenders }).success).toBe(true);
    const card = [{ method: 'CARD_DEBIT', role: 'FIXED', amount: '10000', reference: 'CUPON-0001' }, cashBalance];
    expect(checkoutRequestDto.safeParse({ ...base(), tenders: card }).success).toBe(true);
  });

  it('P03 a non-cash tender with BOTH a reference and an external collection is invalid', () => {
    const tenders = [
      { method: 'CARD_DEBIT', role: 'FIXED', amount: '10000', reference: 'CUPON-0001', externalCollectionId: randomUUID() },
      cashBalance,
    ];
    expect(checkoutRequestDto.safeParse({ ...base(), tenders }).success).toBe(false);
  });

  it('P04 a non-cash tender backed by a registered external collection is accepted', () => {
    const tenders = [{ method: 'CARD_DEBIT', role: 'FIXED', amount: '10000', externalCollectionId: randomUUID() }, cashBalance];
    expect(checkoutRequestDto.safeParse({ ...base(), tenders }).success).toBe(true);
  });

  it('P05 CASH takes no reference, institution or external collection', () => {
    const tenders = [{ method: 'CASH', role: 'FIXED', amount: '10000', receivedAmount: '10000', reference: 'X-0001' }, { method: 'TRANSFER', role: 'BALANCE', reference: 'TRF-0002', institution: 'MACRO' }];
    expect(checkoutRequestDto.safeParse({ ...base(), balanceMethod: 'TRANSFER', tenders }).success).toBe(false);
  });
});
