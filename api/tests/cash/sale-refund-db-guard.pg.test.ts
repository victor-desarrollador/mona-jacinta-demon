// Sale void v1 — database guard of CashMovement SALE_REFUND (real PostgreSQL, raw SQL).
//
// The FK on refundOfSalePaymentId only proves the payment EXISTS. The migration also installs, for rows with
// type = 'SALE_REFUND' only:
//   - trg_cash_movement_refund_guard (BEFORE INSERT OR UPDATE on CashMovement): the referenced SalePayment must
//     exist, be CASH and have EXACTLY the refund's amount (row locked FOR SHARE, so a concurrent change waits);
//   - trg_sale_payment_refund_frozen (BEFORE UPDATE OF method, amount on SalePayment): a payment that has a
//     refund can no longer change method or amount (the guard above would otherwise be bypassable afterwards).
// UNIQUE(refundOfSalePaymentId), the FK RESTRICT and the shape CHECKs stay as they were.
//
// Every statement is sent as raw SQL so nothing but the database decides; the SQLSTATE of each refusal is asserted.
// Standard destructive integration test (same harness as complete-sale.test.ts): LOCAL_TEST in CI.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedDemo } from '../../prisma/seed.js';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { createTestPrismaClient, truncateAllTables } from '../helpers/test-db.js';

type Method = 'CASH' | 'TRANSFER' | 'CARD_DEBIT' | 'CARD_CREDIT' | 'QR';
const AMOUNT = 1_000n;

// The SQLSTATE of a failed raw statement, wherever the driver adapter put it.
function sqlState(error: unknown): string {
  const e = error as {
    code?: string; message?: string;
    meta?: { code?: string; driverAdapterError?: { cause?: { originalCode?: string } } };
  };
  const original = e.meta?.driverAdapterError?.cause?.originalCode ?? e.meta?.code;
  if (typeof original === 'string' && /^[0-9A-Z]{5}$/.test(original)) return original;
  const fromMessage = /\b(2[0-9]{4})\b/.exec(e.message ?? '');
  return fromMessage ? fromMessage[1]! : `UNKNOWN(${e.code ?? 'no-code'})`;
}
const message = (error: unknown) => String((error as { message?: string }).message ?? '');

describe('sale void v1 — SALE_REFUND database guard (PostgreSQL)', () => {
  let db: PrismaClient;
  let sessionId: string;
  let userId: string;
  const payments = {} as Record<Method, string>;

  beforeAll(async () => {
    db = await createTestPrismaClient();
  }, 120000);

  beforeEach(async () => {
    await truncateAllTables(db);
    await seedDemo(db);
    const [cashier, branch] = await Promise.all([
      db.user.findUniqueOrThrow({ where: { email: 'cashier01@demo.local' } }),
      db.branch.findUniqueOrThrow({ where: { code: 'CEN' } }),
    ]);
    userId = cashier.id;
    const register = await db.cashRegister.findFirstOrThrow({ where: { branchId: branch.id }, orderBy: { id: 'asc' } });
    sessionId = (await db.cashSession.create({ data: { registerId: register.id, openedById: userId, startingCash: 0n, status: 'OPEN' } })).id;
    const sale = await db.sale.create({ data: {
      sellerId: userId, branchId: branch.id, status: 'COMPLETED', priceMode: 'CASH', pricingMode: 'LIST',
      subtotal: AMOUNT * 5n, discountTotal: 0n, total: AMOUNT * 5n,
    } });
    for (const method of ['CASH', 'TRANSFER', 'CARD_DEBIT', 'CARD_CREDIT', 'QR'] as const) {
      payments[method] = (await db.salePayment.create({ data: { saleId: sale.id, method, amount: AMOUNT, idempotencyKey: randomUUID() } })).id;
    }
  }, 120000);

  afterAll(async () => {
    await db?.$disconnect();
  }, 120000);

  const insertRefund = (paymentId: string, amount: bigint, id = randomUUID()) => db.$executeRaw`
    INSERT INTO "CashMovement"(id, "sessionId", type, amount, "userId", "refundOfSalePaymentId")
    VALUES (${id}, ${sessionId}, 'SALE_REFUND', ${amount}, ${userId}, ${paymentId})`;
  const refundCount = async () => Number((await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "CashMovement" WHERE type::text = 'SALE_REFUND'`)[0]!.n);
  async function refused(promise: Promise<unknown>) {
    const error = await promise.then(() => null, (cause: unknown) => cause);
    expect(error, 'the database must refuse this statement').not.toBeNull();
    return error;
  }

  it('DG01 a SALE_REFUND of a CASH payment with exactly its amount is accepted', async () => {
    await insertRefund(payments.CASH, AMOUNT);
    expect(await refundCount()).toBe(1);
  });

  it('DG02 a SALE_REFUND whose amount differs from the CASH payment is refused (23514), higher or lower', async () => {
    for (const amount of [AMOUNT - 1n, AMOUNT + 1n]) {
      const error = await refused(insertRefund(payments.CASH, amount));
      expect(sqlState(error), String(amount)).toBe('23514');
      expect(message(error)).toContain('chk_cash_movement_refund_payment');
    }
    expect(await refundCount()).toBe(0);
  });

  it.each([['TRANSFER'], ['CARD_DEBIT'], ['CARD_CREDIT'], ['QR']] as const)(
    'DG03 a SALE_REFUND of a %s payment is refused (23514), even with the exact amount',
    async (method) => {
      const error = await refused(insertRefund(payments[method], AMOUNT));
      expect(sqlState(error)).toBe('23514');
      expect(message(error)).toContain('chk_cash_movement_refund_payment');
      expect(await refundCount()).toBe(0);
    },
  );

  it('DG04 a SALE_REFUND of a payment that does not exist is refused (23503)', async () => {
    expect(sqlState(await refused(insertRefund(randomUUID(), AMOUNT)))).toBe('23503');
  });

  it('DG05 a second SALE_REFUND of the SAME payment is refused by UNIQUE (23505)', async () => {
    await insertRefund(payments.CASH, AMOUNT);
    expect(sqlState(await refused(insertRefund(payments.CASH, AMOUNT)))).toBe('23505');
    expect(await refundCount()).toBe(1);
  });

  it('DG06 a SalePayment that has a SALE_REFUND cannot be deleted (23503, RESTRICT)', async () => {
    await insertRefund(payments.CASH, AMOUNT);
    expect(sqlState(await refused(db.$executeRaw`DELETE FROM "SalePayment" WHERE id = ${payments.CASH}`))).toBe('23503');
    expect(await db.salePayment.count({ where: { id: payments.CASH } })).toBe(1);
  });

  it('DG07 after a SALE_REFUND the payment can no longer change amount or method (23514): the guard cannot be bypassed afterwards', async () => {
    await insertRefund(payments.CASH, AMOUNT);
    const amountError = await refused(db.$executeRaw`UPDATE "SalePayment" SET amount = ${AMOUNT + 1n} WHERE id = ${payments.CASH}`);
    expect(sqlState(amountError)).toBe('23514');
    expect(message(amountError)).toContain('trg_sale_payment_refund_frozen');
    expect(sqlState(await refused(db.$executeRaw`UPDATE "SalePayment" SET method = 'QR' WHERE id = ${payments.CASH}`))).toBe('23514');
    expect(await db.salePayment.findUniqueOrThrow({ where: { id: payments.CASH } })).toMatchObject({ method: 'CASH', amount: AMOUNT });
  });

  it('DG08 an existing SALE_REFUND cannot be edited into a different amount or re-pointed to a non-CASH payment (23514)', async () => {
    const id = randomUUID();
    await insertRefund(payments.CASH, AMOUNT, id);
    expect(sqlState(await refused(db.$executeRaw`UPDATE "CashMovement" SET amount = ${AMOUNT + 1n} WHERE id = ${id}`))).toBe('23514');
    expect(sqlState(await refused(db.$executeRaw`UPDATE "CashMovement" SET "refundOfSalePaymentId" = ${payments.TRANSFER} WHERE id = ${id}`))).toBe('23514');
  });

  it('DG09 a payment WITHOUT a refund is still editable (the freeze is only for refunded payments)', async () => {
    expect(await db.$executeRaw`UPDATE "SalePayment" SET "receivedAmount" = ${AMOUNT} WHERE id = ${payments.CASH}`).toBe(1);
    expect(await db.$executeRaw`UPDATE "SalePayment" SET amount = ${AMOUNT + 5n} WHERE id = ${payments.TRANSFER}`).toBe(1);
  });

  it('DG10 the other CashMovement forms are unaffected: SALE_INCOME for any payment/amount shape and an EXPENSE still insert', async () => {
    await db.$executeRaw`INSERT INTO "CashMovement"(id, "sessionId", type, amount, "userId", "salePaymentId")
      VALUES (${randomUUID()}, ${sessionId}, 'SALE_INCOME', ${AMOUNT}, ${userId}, ${payments.CASH})`;
    await db.$executeRaw`INSERT INTO "CashMovement"(id, "sessionId", type, amount, "userId", reason, "idempotencyKey")
      VALUES (${randomUUID()}, ${sessionId}, 'EXPENSE', 7, ${userId}, 'insumos', ${randomUUID()})`;
    expect(await db.cashMovement.count({ where: { sessionId } })).toBe(2);
  });

  it('DG11 the shape CHECKs still apply: no link, a salePaymentId, or a non-positive amount (23514)', async () => {
    expect(sqlState(await refused(db.$executeRaw`INSERT INTO "CashMovement"(id, "sessionId", type, amount, "userId")
      VALUES (${randomUUID()}, ${sessionId}, 'SALE_REFUND', ${AMOUNT}, ${userId})`))).toBe('23514');
    expect(sqlState(await refused(db.$executeRaw`INSERT INTO "CashMovement"(id, "sessionId", type, amount, "userId", "salePaymentId", "refundOfSalePaymentId")
      VALUES (${randomUUID()}, ${sessionId}, 'SALE_REFUND', ${AMOUNT}, ${userId}, ${payments.CASH}, ${payments.CASH})`))).toBe('23514');
    expect(sqlState(await refused(insertRefund(payments.CASH, 0n)))).toBe('23514');
    expect(await refundCount()).toBe(0);
  });
});
