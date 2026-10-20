// CARD_CREDIT inside the proportional engine (OWNER block: Pago simple/combinado with Crédito).
//
// Expected values are computed here by hand from the approved formulas (design §2),
// never from the module: base $40.000 -> CASH $40.000, TRANSFER +10% $44.000,
// DEBIT +5% $42.000, CREDIT +15% $46.000. Money is centavos BigInt only.
import { describe, expect, it } from 'vitest';
import {
  PROPORTIONAL_METHODS,
  computeProportionalQuote,
  lineFullPrices,
  type ProportionalLineInput,
  type ProportionalMethod,
  type ProportionalPricingSnapshot,
  type ProportionalQuote,
  type ProportionalTenderInput,
} from '../../src/modules/pricing/proportional-checkout.js';
import { AppError } from '../../src/shared/errors.js';

const p = (n: number | bigint): bigint => BigInt(n) * 100n;

const PRICING: ProportionalPricingSnapshot = {
  bankTransferAdjustmentBps: 1000,
  debitCardAdjustmentBps: 500,
  creditCardAdjustmentBps: 1500,
};
const SALE_40000: readonly ProportionalLineInput[] = [
  { saleItemId: 'item-1', sku: 'SKU-1', quantity: 1n, baseUnitPrice: p(40000) },
];

function quote(input: {
  lines?: readonly ProportionalLineInput[];
  pricing?: ProportionalPricingSnapshot | null;
  tenders?: readonly ProportionalTenderInput[];
  balanceMethod: ProportionalMethod;
}): ProportionalQuote {
  return computeProportionalQuote({
    lines: input.lines ?? SALE_40000,
    pricing: input.pricing === undefined ? PRICING : input.pricing,
    tenders: input.tenders ?? [],
    balanceMethod: input.balanceMethod,
  });
}

const amountOf = (result: ProportionalQuote, method: ProportionalMethod) =>
  result.methods.find((entry) => entry.method === method)?.amount;

describe('CARD_CREDIT in the proportional engine', () => {
  it('exposes CASH, TRANSFER, CARD_DEBIT and CARD_CREDIT, in that order', () => {
    expect([...PROPORTIONAL_METHODS]).toEqual(['CASH', 'TRANSFER', 'CARD_DEBIT', 'CARD_CREDIT']);
  });

  it('CRED-1 the quote returns the CARD_CREDIT full price next to the other three', () => {
    const result = quote({ balanceMethod: 'CASH' });
    expect(result.fullPrices).toEqual({ CASH: p(40000), TRANSFER: p(44000), CARD_DEBIT: p(42000), CARD_CREDIT: p(46000) });
    expect(result.lineFullPrices.CARD_CREDIT).toEqual([p(46000)]);
  });

  it('CRED-2 retail: base cash price plus the credit adjustment, half-up per unit (4.999,50 rounds to 5.000)', () => {
    // $4.545 base +10%: 454_500 * 11_000 / 10_000 = 499_950 centavos = $4.999,50 -> $5.000 (half-up).
    const lines: ProportionalLineInput[] = [{ saleItemId: 'a', sku: 'A', quantity: 3n, baseUnitPrice: p(4545) }];
    const pricing = { ...PRICING, creditCardAdjustmentBps: 1000 };
    expect(lineFullPrices(lines, 1000)).toEqual([p(15000)]);
    const result = quote({ lines, pricing, balanceMethod: 'CARD_CREDIT' });
    expect(result.fullPrices.CARD_CREDIT).toBe(p(15000));
    expect(result.total).toBe(p(15000));
  });

  it('CRED-3 wholesale: the wholesale base plus the same credit adjustment', () => {
    // wholesalePrice $30.000 +15% = $34.500 (the engine only sees the line base).
    const wholesale: ProportionalLineInput[] = [{ saleItemId: 'w', sku: 'W', quantity: 1n, baseUnitPrice: p(30000) }];
    const result = quote({ lines: wholesale, balanceMethod: 'CARD_CREDIT' });
    expect(result.fullPrices.CASH).toBe(p(30000));
    expect(result.fullPrices.CARD_CREDIT).toBe(p(34500));
    expect(result.total).toBe(p(34500));
  });

  it('CRED-4 simple credit: no fixed tenders, balance CARD_CREDIT, one method for the whole sale', () => {
    const result = quote({ balanceMethod: 'CARD_CREDIT' });
    expect(result.balance).toEqual({ method: 'CARD_CREDIT', amount: p(46000) });
    expect(result.total).toBe(p(46000));
    expect(result.methods.map((entry) => entry.method)).toEqual(['CARD_CREDIT']);
  });

  it('CRED-5 CASH fixed $10.000 + balance CARD_CREDIT', () => {
    const result = quote({ tenders: [{ method: 'CASH', amount: p(10000) }], balanceMethod: 'CARD_CREDIT' });
    // balance = 46.000 * (40.000 - 10.000) / 40.000 = 34.500
    expect(result.balance.amount).toBe(p(34500));
    expect(result.total).toBe(p(44500));
    expect(amountOf(result, 'CASH')).toBe(p(10000));
  });

  it('CRED-6 TRANSFER fixed $11.000 + balance CARD_CREDIT', () => {
    const result = quote({ tenders: [{ method: 'TRANSFER', amount: p(11000) }], balanceMethod: 'CARD_CREDIT' });
    // balance = 46.000 * (44.000 - 11.000) / 44.000 = 34.500
    expect(result.balance.amount).toBe(p(34500));
    expect(result.total).toBe(p(45500));
  });

  it('CRED-7 CARD_DEBIT fixed $10.500 + balance CARD_CREDIT', () => {
    const result = quote({ tenders: [{ method: 'CARD_DEBIT', amount: p(10500) }], balanceMethod: 'CARD_CREDIT' });
    // balance = 46.000 * (42.000 - 10.500) / 42.000 = 34.500
    expect(result.balance.amount).toBe(p(34500));
    expect(result.total).toBe(p(45000));
  });

  it('accepts CARD_CREDIT as a fixed tender with another method as balance', () => {
    const result = quote({ tenders: [{ method: 'CARD_CREDIT', amount: p(23000) }], balanceMethod: 'CASH' });
    // balance = 40.000 * (46.000 - 23.000) / 46.000 = 20.000
    expect(result.balance.amount).toBe(p(20000));
    expect(result.total).toBe(p(43000));
  });

  it('CRED-8 allocations add up exactly to every method amount and to the total (several lines)', () => {
    const lines: ProportionalLineInput[] = [
      { saleItemId: 'i1', sku: 'S1', quantity: 2n, baseUnitPrice: 1_234_567n - (1_234_567n % 100n) },
      { saleItemId: 'i2', sku: 'S2', quantity: 1n, baseUnitPrice: 8_999_900n },
      { saleItemId: 'i3', sku: 'S3', quantity: 3n, baseUnitPrice: 312_300n },
    ];
    const result = quote({
      lines,
      tenders: [{ method: 'CASH', amount: p(7000) }, { method: 'TRANSFER', amount: 1_500_050n }],
      balanceMethod: 'CARD_CREDIT',
    });
    for (const method of result.methods) {
      expect(method.allocations.reduce((sum, entry) => sum + entry.amount, 0n)).toBe(method.amount);
    }
    expect(result.lines.reduce((sum, line) => sum + line.finalAmount, 0n)).toBe(result.total);
    expect(result.methods.reduce((sum, method) => sum + method.amount, 0n)).toBe(result.total);
  });

  it('CRED-9 Hamilton invariants hold across 300 fixed-seed cases that include credit', () => {
    // mulberry32: a small, well-mixed seeded generator (the low bits of an LCG are not).
    let state = 20261020;
    const next = (max: number) => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * max);
    };
    const methods = [...PROPORTIONAL_METHODS];
    for (let index = 0; index < 300; index += 1) {
      const lines: ProportionalLineInput[] = Array.from({ length: 1 + next(4) }, (_, lineIndex) => ({
        saleItemId: `id-${lineIndex}`, sku: `SKU-${next(5)}`, quantity: BigInt(1 + next(5)), baseUnitPrice: BigInt(10_000 + next(900_000) * 100),
      }));
      const balanceMethod = methods[next(4)]!;
      const others = methods.filter((method) => method !== balanceMethod);
      const wanted = next(3);
      const probe = quote({ lines, balanceMethod });
      const tenders: ProportionalTenderInput[] = [];
      for (const method of others.slice(0, wanted)) {
        const price = probe.fullPrices[method]!;
        tenders.push({ method, amount: 1n + (price / 4n) * BigInt(1 + next(2)) });
      }
      let result: ProportionalQuote;
      try {
        result = quote({ lines, tenders, balanceMethod });
      } catch (error) {
        // Only the documented business refusals are acceptable (coverage / tiny balance).
        expect(error).toBeInstanceOf(AppError);
        expect(['FIXED_TENDERS_COVER_SALE', 'BALANCE_TOO_SMALL']).toContain((error as AppError).code);
        continue;
      }
      expect(result.methods.reduce((sum, method) => sum + method.amount, 0n)).toBe(result.total);
      expect(result.lines.reduce((sum, line) => sum + line.finalAmount, 0n)).toBe(result.total);
      for (const method of result.methods) {
        expect(method.allocations.reduce((sum, entry) => sum + entry.amount, 0n)).toBe(method.amount);
        const perLine = result.lineFullPrices[method.method]!;
        method.allocations.forEach((entry, position) => expect(entry.amount <= perLine[position]!).toBe(true));
      }
    }
  });

  it('without a credit adjustment in the snapshot CARD_CREDIT is not priceable and fails closed', () => {
    const noCredit: ProportionalPricingSnapshot = { bankTransferAdjustmentBps: 1000, debitCardAdjustmentBps: 500 };
    const result = quote({ pricing: noCredit, balanceMethod: 'CASH' });
    expect(result.fullPrices.CARD_CREDIT).toBeNull();
    expect(() => quote({ pricing: noCredit, balanceMethod: 'CARD_CREDIT' })).toThrow(expect.objectContaining({ code: 'PRICING_CONFIG_MISSING' }));
  });

  it('rejects an out-of-range credit adjustment', () => {
    expect(() => quote({ pricing: { ...PRICING, creditCardAdjustmentBps: 10_001 }, balanceMethod: 'CASH' }))
      .toThrow(expect.objectContaining({ code: 'INVALID_PRICE_ADJUSTMENT' }));
  });

  it('still refuses QR', () => {
    expect(() => quote({ balanceMethod: 'QR' as unknown as ProportionalMethod })).toThrow(expect.objectContaining({ code: 'PAYMENT_METHOD_NOT_ENABLED' }));
  });
});
