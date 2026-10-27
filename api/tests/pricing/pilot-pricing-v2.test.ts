// Pilot Pricing V2 adversarial preregistration (2026-10-06), expected before
// execution:
// P01 zero CASH adjustment -> DERIVE exact base.
// P02 LIST 0 bps -> DERIVE base.
// P03 CREDIT_CARD 2000 bps over 70000 -> DERIVE 84000.
// P04 half-up boundary 1 cent + 50% -> DERIVE 2.
// P05 below half boundary 1 cent + 49.99% -> DERIVE 1.
// P06 max 10000 bps -> ALLOW.
// P07 above max -> DENY.
// P08 negative bps -> DENY.
// P09 very large valid centavos exact integer -> DERIVE without float.
// P10 retail missing cash base -> FAIL_CLOSED.
// P11 wholesale missing base -> FAIL_CLOSED.
// P12 QR 0 bps equals CASH -> DERIVE.
// P13 CASH-priced sale + CASH payment -> ALLOW.
// P14 CREDIT_CARD-priced sale + CARD_CREDIT -> ALLOW.
// P15 DEBIT_CARD-priced sale + CARD_DEBIT -> ALLOW.
// P16 BANK_TRANSFER-priced sale + TRANSFER -> ALLOW.
// P17 QR-priced sale + QR -> ALLOW.
// P18 CREDIT_CARD-priced sale + CASH -> FAIL_CLOSED.
// P19 CASH-priced sale + CARD_DEBIT -> FAIL_CLOSED.
// P20 LIST-priced sale + CASH -> ALLOW (explicit list mode, no method twin).
// P21 LIST-priced sale + CARD_CREDIT -> ALLOW (explicit list mode, no method twin).
// P22 unknown payment method -> DENY.
// P23 later config change must not alter existing SaleItem snapshot -> PRESERVE_SNAPSHOT.
// P24 wholesale 70000 + CREDIT_CARD 20% -> DERIVE 84000.
// P25 adjustment validation rejects arbitrary unbounded values -> DENY.
// P26 basis-point config is exact integer, not decimal float -> DERIVE.
import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/shared/errors.js';
import {
  MAX_PRICE_ADJUSTMENT_BPS,
  assertAdjustmentBps,
  assertPaymentCompatible,
  calculateUnitPrice,
  roundHalfUpBps,
  type PricingConfigSnapshot,
} from '../../src/modules/pricing/pricing.js';

const config = (overrides: Partial<PricingConfigSnapshot['adjustmentsBps']> = {}): PricingConfigSnapshot => ({
  id: 'cfg-1',
  updatedAt: new Date('2026-10-06T12:00:00.000Z'),
  adjustmentsBps: {
    CASH: 0,
    LIST: 0,
    CREDIT_CARD: 2000,
    DEBIT_CARD: 1500,
    BANK_TRANSFER: 500,
    QR: 0,
    ...overrides,
  },
});

function expectAppError(fn: () => unknown, code: string) {
  expect(fn).toThrow(AppError);
  try {
    fn();
  } catch (error) {
    expect((error as AppError).code).toBe(code);
  }
}

describe('Pilot Pricing V2 calculator', () => {
  it('derives cash/list/card/QR prices with exact half-up integer math', () => {
    expect(roundHalfUpBps(70000n, 2000)).toBe(84000n);
    expect(roundHalfUpBps(1n, 5000)).toBe(2n);
    expect(roundHalfUpBps(1n, 4999)).toBe(1n);
    expect(roundHalfUpBps(123456789012345n, 10000)).toBe(246913578024690n);
    expect(calculateUnitPrice({ baseTier: 'LIST', priceMode: 'CASH', baseUnitPrice: 10000n, config: config() }).unitPrice).toBe(10000n);
    expect(calculateUnitPrice({ baseTier: 'LIST', priceMode: 'LIST', baseUnitPrice: 10000n, config: config() }).unitPrice).toBe(10000n);
    expect(calculateUnitPrice({ baseTier: 'WHOLESALE', priceMode: 'CREDIT_CARD', baseUnitPrice: 70000n, config: config() }).unitPrice).toBe(84000n);
    expect(calculateUnitPrice({ baseTier: 'LIST', priceMode: 'QR', baseUnitPrice: 10000n, config: config() }).unitPrice).toBe(10000n);
  });

  it('rejects invalid adjustment bounds and missing bases', () => {
    expect(MAX_PRICE_ADJUSTMENT_BPS).toBe(10000);
    expect(() => assertAdjustmentBps(0)).not.toThrow();
    expect(() => assertAdjustmentBps(10000)).not.toThrow();
    expectAppError(() => assertAdjustmentBps(10001), 'INVALID_PRICE_ADJUSTMENT');
    expectAppError(() => assertAdjustmentBps(-1), 'INVALID_PRICE_ADJUSTMENT');
    expectAppError(() => calculateUnitPrice({ baseTier: 'LIST', priceMode: 'CASH', baseUnitPrice: 0n, config: config() }), 'PRICE_BASE_MISSING');
  });
});

describe('Pilot Pricing V2 payment compatibility', () => {
  it('allows matching method modes and explicit LIST settlement', () => {
    expect(() => assertPaymentCompatible('CASH', 'CASH')).not.toThrow();
    expect(() => assertPaymentCompatible('CREDIT_CARD', 'CARD_CREDIT')).not.toThrow();
    expect(() => assertPaymentCompatible('DEBIT_CARD', 'CARD_DEBIT')).not.toThrow();
    expect(() => assertPaymentCompatible('BANK_TRANSFER', 'TRANSFER')).not.toThrow();
    expect(() => assertPaymentCompatible('QR', 'QR')).not.toThrow();
    expect(() => assertPaymentCompatible('LIST', 'CASH')).not.toThrow();
    expect(() => assertPaymentCompatible('LIST', 'CARD_CREDIT')).not.toThrow();
  });

  it('fails closed when a payment method would imply another price mode', () => {
    expectAppError(() => assertPaymentCompatible('CREDIT_CARD', 'CASH'), 'PAYMENT_METHOD_PRICE_MODE_CONFLICT');
    expectAppError(() => assertPaymentCompatible('CASH', 'CARD_DEBIT'), 'PAYMENT_METHOD_PRICE_MODE_CONFLICT');
    expectAppError(() => assertPaymentCompatible('QR', 'CARD_CREDIT'), 'PAYMENT_METHOD_PRICE_MODE_CONFLICT');
    expectAppError(() => assertPaymentCompatible('CASH', 'CHEQUE'), 'UNSUPPORTED_PAYMENT_METHOD');
  });
});
