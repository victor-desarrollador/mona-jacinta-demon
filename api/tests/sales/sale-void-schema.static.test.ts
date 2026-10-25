// Sale void v1 — RED contract: the schema SURFACE the void needs (static, reads schema.prisma only).
//
// No migration is written by this task; these assertions name what the later schema + migration step
// must provide, so the behavior tests have something to bind to. They are intentionally about SHAPE,
// not about SQL: the migration design (constraints, indexes, enum split) is a separate review.
//
//   StockMovementType.SALE_VOID          the compensating stock movement (append-only, +delta, links the void)
//   CashMovementType.SALE_REFUND         the compensating cash movement (append-only)
//   CashMovement.refundOfSalePaymentId   UNIQUE: at most one refund per CASH SalePayment (name PROVISIONAL)
//   StockMovement.saleVoidId             the void a SALE_VOID movement belongs to
//   SaleVoid                             append-only: one per sale (saleId UNIQUE), reason, idempotencyKey,
//                                        previousStatus, who/when; SaleStatus gets NO new member (stays CANCELLED)
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const schema = readFileSync(new URL('../../prisma/schema.prisma', import.meta.url), 'utf8');
const block = (kind: 'enum' | 'model', name: string) => {
  const match = new RegExp(`^${kind} ${name} \\{([\\s\\S]*?)^\\}`, 'm').exec(schema);
  return match ? match[1]! : '';
};
const fieldLine = (body: string, field: string) => body.split('\n').find((line) => new RegExp(`^\\s*${field}\\s`).test(line)) ?? '';

describe('sale void v1 — schema surface', () => {
  it('SC01 StockMovementType has SALE_VOID', () => {
    expect(block('enum', 'StockMovementType')).toMatch(/^\s*SALE_VOID\s*$/m);
  });

  it('SC02 CashMovementType has SALE_REFUND', () => {
    expect(block('enum', 'CashMovementType')).toMatch(/^\s*SALE_REFUND\s*$/m);
  });

  it('SC03 CashMovement links a refund to the CASH SalePayment it returns, UNIQUE (no double refund)', () => {
    const line = fieldLine(block('model', 'CashMovement'), 'refundOfSalePaymentId');
    expect(line).not.toBe('');
    expect(line).toMatch(/@unique/);
  });

  it('SC04 SaleVoid is one row per sale with reason, idempotency key, previous status and actor', () => {
    const body = block('model', 'SaleVoid');
    expect(body).not.toBe('');
    expect(fieldLine(body, 'saleId')).toMatch(/@unique/);
    for (const field of ['branchId', 'voidedById', 'reason', 'idempotencyKey', 'previousStatus', 'voidedAt']) {
      expect(fieldLine(body, field), field).not.toBe('');
    }
  });

  it('SC05 StockMovement carries the void it belongs to', () => {
    expect(fieldLine(block('model', 'StockMovement'), 'saleVoidId')).not.toBe('');
  });

  // GUARD (passes today, must keep passing): a void is CANCELLED + SaleVoid, never a new Sale state.
  it('SC06 SaleStatus gets no VOIDED member', () => {
    const body = block('enum', 'SaleStatus');
    expect(body).toMatch(/^\s*CANCELLED\s*$/m);
    expect(body).not.toMatch(/VOID/);
  });
});
