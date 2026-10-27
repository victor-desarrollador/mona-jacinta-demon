// QR inside the proportional engine (P0-B).
//
// Expected values are computed here by hand from the approved formulas, never from the
// module: base $40.000 -> CASH $40.000, TRANSFER +10% $44.000, DEBIT +5% $42.000,
// CREDIT +15% $46.000, QR +12% $44.800. Money is centavos BigInt only. The algorithm
// (Hamilton / half-up) is untouched: QR is one more priced method behind the same functions.
import { describe, expect, it } from 'vitest';
import {
  MAX_INT8,
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
  qrAdjustmentBps: 1200,
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

describe('QR in the proportional engine', () => {
  it('exposes CASH, TRANSFER, CARD_DEBIT, CARD_CREDIT and QR, in that order', () => {
    expect([...PROPORTIONAL_METHODS]).toEqual(['CASH', 'TRANSFER', 'CARD_DEBIT', 'CARD_CREDIT', 'QR']);
  });

  it('QR-1 the quote returns the QR full price next to the other four', () => {
    const result = quote({ balanceMethod: 'CASH' });
    expect(result.fullPrices).toEqual({
      CASH: p(40000), TRANSFER: p(44000), CARD_DEBIT: p(42000), CARD_CREDIT: p(46000), QR: p(44800),
    });
    expect(result.lineFullPrices.QR).toEqual([p(44800)]);
  });

  it('QR-2 retail: base cash price plus the QR adjustment, half-up per unit (4.999,50 rounds to 5.000)', () => {
    const lines: ProportionalLineInput[] = [{ saleItemId: 'a', sku: 'A', quantity: 3n, baseUnitPrice: p(4545) }];
    const pricing = { ...PRICING, qrAdjustmentBps: 1000 };
    expect(lineFullPrices(lines, 1000)).toEqual([p(15000)]);
    const result = quote({ lines, pricing, balanceMethod: 'QR' });
    expect(result.fullPrices.QR).toBe(p(15000));
    expect(result.total).toBe(p(15000));
  });

  it('QR-3 wholesale: the wholesale base plus the same QR adjustment', () => {
    const wholesale: ProportionalLineInput[] = [{ saleItemId: 'w', sku: 'W', quantity: 1n, baseUnitPrice: p(30000) }];
    const result = quote({ lines: wholesale, balanceMethod: 'QR' });
    expect(result.fullPrices.CASH).toBe(p(30000));
    expect(result.fullPrices.QR).toBe(p(33600));
    expect(result.total).toBe(p(33600));
  });

  it('QR-4 simple QR: no fixed tenders, balance QR, one method for the whole sale', () => {
    const result = quote({ balanceMethod: 'QR' });
    expect(result.balance).toEqual({ method: 'QR', amount: p(44800) });
    expect(result.total).toBe(p(44800));
    expect(result.methods.map((entry) => entry.method)).toEqual(['QR']);
  });

  it('QR-5 CASH fixed $10.000 + balance QR', () => {
    const result = quote({ tenders: [{ method: 'CASH', amount: p(10000) }], balanceMethod: 'QR' });
    // balance = 44.800 * (40.000 - 10.000) / 40.000 = 33.600
    expect(result.balance.amount).toBe(p(33600));
    expect(result.total).toBe(p(43600));
    expect(amountOf(result, 'CASH')).toBe(p(10000));
  });

  it('QR-6 TRANSFER fixed $11.000 + balance QR', () => {
    const result = quote({ tenders: [{ method: 'TRANSFER', amount: p(11000) }], balanceMethod: 'QR' });
    // balance = 44.800 * (44.000 - 11.000) / 44.000 = 33.600
    expect(result.balance.amount).toBe(p(33600));
    expect(result.total).toBe(p(44600));
  });

  it('QR-7 CARD_DEBIT fixed $10.500 + balance QR', () => {
    const result = quote({ tenders: [{ method: 'CARD_DEBIT', amount: p(10500) }], balanceMethod: 'QR' });
    // balance = 44.800 * (42.000 - 10.500) / 42.000 = 33.600
    expect(result.balance.amount).toBe(p(33600));
    expect(result.total).toBe(p(44100));
  });

  it('QR-8 CARD_CREDIT fixed $11.500 + balance QR', () => {
    const result = quote({ tenders: [{ method: 'CARD_CREDIT', amount: p(11500) }], balanceMethod: 'QR' });
    // balance = 44.800 * (46.000 - 11.500) / 46.000 = 33.600
    expect(result.balance.amount).toBe(p(33600));
    expect(result.total).toBe(p(45100));
  });

  it('QR-9 QR as a fixed tender with each other method as balance', () => {
    // QR $22.400 is half of its full price: the CASH balance is half of $40.000.
    const cash = quote({ tenders: [{ method: 'QR', amount: p(22400) }], balanceMethod: 'CASH' });
    expect(cash.balance.amount).toBe(p(20000));
    expect(cash.total).toBe(p(42400));
    const transfer = quote({ tenders: [{ method: 'QR', amount: p(22400) }], balanceMethod: 'TRANSFER' });
    expect(transfer.balance.amount).toBe(p(22000));
    expect(transfer.total).toBe(p(44400));
    const debit = quote({ tenders: [{ method: 'QR', amount: p(22400) }], balanceMethod: 'CARD_DEBIT' });
    expect(debit.balance.amount).toBe(p(21000));
    expect(debit.total).toBe(p(43400));
    const credit = quote({ tenders: [{ method: 'QR', amount: p(22400) }], balanceMethod: 'CARD_CREDIT' });
    expect(credit.balance.amount).toBe(p(23000));
    expect(credit.total).toBe(p(45400));
  });

  it('QR-10 three tenders including QR (CASH + QR fixed, TRANSFER balance)', () => {
    const result = quote({
      tenders: [{ method: 'CASH', amount: p(10000) }, { method: 'QR', amount: p(11200) }],
      balanceMethod: 'TRANSFER',
    });
    // covered fraction: 10.000/40.000 + 11.200/44.800 = 1/4 + 1/4; TRANSFER balance = 44.000 * 1/2 = 22.000
    expect(result.balance.amount).toBe(p(22000));
    expect(result.total).toBe(p(43200));
    expect(result.methods.map((entry) => entry.method)).toEqual(['CASH', 'TRANSFER', 'QR']);
  });

  it('QR-11 allocations add up exactly to every method amount and to the total (several lines)', () => {
    const lines: ProportionalLineInput[] = [
      { saleItemId: 'i1', sku: 'S1', quantity: 2n, baseUnitPrice: 1_234_567n - (1_234_567n % 100n) },
      { saleItemId: 'i2', sku: 'S2', quantity: 1n, baseUnitPrice: 8_999_900n },
      { saleItemId: 'i3', sku: 'S3', quantity: 3n, baseUnitPrice: 312_300n },
    ];
    const result = quote({
      lines,
      tenders: [{ method: 'CASH', amount: p(7000) }, { method: 'TRANSFER', amount: 1_500_050n }],
      balanceMethod: 'QR',
    });
    for (const method of result.methods) {
      expect(method.allocations.reduce((sum, entry) => sum + entry.amount, 0n)).toBe(method.amount);
    }
    expect(result.lines.reduce((sum, line) => sum + line.finalAmount, 0n)).toBe(result.total);
    expect(result.methods.reduce((sum, method) => sum + method.amount, 0n)).toBe(result.total);
  });

  it('QR-12 Hamilton invariants hold across 400 fixed-seed cases that include QR', () => {
    let state = 20261021;
    const next = (max: number) => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * max);
    };
    const methods = [...PROPORTIONAL_METHODS];
    let withQr = 0;
    for (let index = 0; index < 400; index += 1) {
      const lines: ProportionalLineInput[] = Array.from({ length: 1 + next(4) }, (_, lineIndex) => ({
        saleItemId: `id-${lineIndex}`, sku: `SKU-${next(5)}`, quantity: BigInt(1 + next(5)), baseUnitPrice: BigInt(10_000 + next(900_000) * 100),
      }));
      const balanceMethod = methods[next(5)]!;
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
        expect(error).toBeInstanceOf(AppError);
        expect(['FIXED_TENDERS_COVER_SALE', 'BALANCE_TOO_SMALL']).toContain((error as AppError).code);
        continue;
      }
      if (result.methods.some((method) => method.method === 'QR')) withQr += 1;
      expect(result.methods.reduce((sum, method) => sum + method.amount, 0n)).toBe(result.total);
      expect(result.lines.reduce((sum, line) => sum + line.finalAmount, 0n)).toBe(result.total);
      for (const method of result.methods) {
        expect(method.allocations.reduce((sum, entry) => sum + entry.amount, 0n)).toBe(method.amount);
        const perLine = result.lineFullPrices[method.method]!;
        method.allocations.forEach((entry, position) => expect(entry.amount <= perLine[position]!).toBe(true));
      }
    }
    // The generator really exercises QR (the guard against a vacuous loop).
    expect(withQr).toBeGreaterThan(50);
  });

  it('QR-13 BigInt end to end: amounts past 2^53 stay exact, and past int8 fail closed', () => {
    const big = 9_000_000_000_000_000n - (9_000_000_000_000_000n % 100n); // > Number.MAX_SAFE_INTEGER
    const lines: ProportionalLineInput[] = [{ saleItemId: 'b', sku: 'B', quantity: 1n, baseUnitPrice: big }];
    const result = quote({ lines, pricing: { ...PRICING, qrAdjustmentBps: 0 }, balanceMethod: 'QR' });
    expect(result.total).toBe(big);
    expect(typeof result.total).toBe('bigint');
    expect(() => quote({
      lines: [{ saleItemId: 'b', sku: 'B', quantity: 1n, baseUnitPrice: MAX_INT8 - (MAX_INT8 % 100n) }],
      pricing: { ...PRICING, qrAdjustmentBps: 10_000 },
      balanceMethod: 'QR',
    })).toThrow(expect.objectContaining({ code: 'AMOUNT_OVERFLOW' }));
  });

  it('QR-14 the QR adjustment is a snapshot input, not a constant: another value, another price', () => {
    const low = quote({ pricing: { ...PRICING, qrAdjustmentBps: 0 }, balanceMethod: 'QR' });
    const high = quote({ pricing: { ...PRICING, qrAdjustmentBps: 2500 }, balanceMethod: 'QR' });
    expect(low.fullPrices.QR).toBe(p(40000));
    expect(high.fullPrices.QR).toBe(p(50000));
  });

  it('QR-15 adding QR changes no existing result: CASH/TRANSFER/DEBIT/CREDIT quotes are identical with or without a QR adjustment', () => {
    const withoutQr: ProportionalPricingSnapshot = { bankTransferAdjustmentBps: 1000, debitCardAdjustmentBps: 500, creditCardAdjustmentBps: 1500 };
    for (const balanceMethod of ['CASH', 'TRANSFER', 'CARD_DEBIT', 'CARD_CREDIT'] as const) {
      const tenders = balanceMethod === 'CASH' ? [] : [{ method: 'CASH' as const, amount: p(10000) }];
      const a = quote({ pricing: PRICING, tenders, balanceMethod });
      const b = quote({ pricing: withoutQr, tenders, balanceMethod });
      expect(a.total).toBe(b.total);
      expect(a.balance).toEqual(b.balance);
      expect(a.methods).toEqual(b.methods);
      expect(a.lines).toEqual(b.lines);
    }
  });

  it('without a QR adjustment in the snapshot QR is not priceable and fails closed', () => {
    const noQr: ProportionalPricingSnapshot = { bankTransferAdjustmentBps: 1000, debitCardAdjustmentBps: 500, creditCardAdjustmentBps: 1500 };
    const result = quote({ pricing: noQr, balanceMethod: 'CASH' });
    expect(result.fullPrices.QR).toBeNull();
    expect(() => quote({ pricing: noQr, balanceMethod: 'QR' })).toThrow(expect.objectContaining({ code: 'PRICING_CONFIG_MISSING' }));
    expect(() => quote({ pricing: noQr, tenders: [{ method: 'QR', amount: p(1000) }], balanceMethod: 'CASH' }))
      .toThrow(expect.objectContaining({ code: 'PRICING_CONFIG_MISSING' }));
  });

  it('rejects an out-of-range QR adjustment', () => {
    expect(() => quote({ pricing: { ...PRICING, qrAdjustmentBps: 10_001 }, balanceMethod: 'CASH' }))
      .toThrow(expect.objectContaining({ code: 'INVALID_PRICE_ADJUSTMENT' }));
    expect(() => quote({ pricing: { ...PRICING, qrAdjustmentBps: -1 }, balanceMethod: 'CASH' }))
      .toThrow(expect.objectContaining({ code: 'INVALID_PRICE_ADJUSTMENT' }));
  });

  it('with no pricing config only CASH is offered (QR included in the fail-closed set)', () => {
    const cashOnly = quote({ pricing: null, balanceMethod: 'CASH' });
    expect(cashOnly.fullPrices).toEqual({ CASH: p(40000), TRANSFER: null, CARD_DEBIT: null, CARD_CREDIT: null, QR: null });
    expect(() => quote({ pricing: null, balanceMethod: 'QR' })).toThrow(expect.objectContaining({ code: 'PRICING_CONFIG_MISSING' }));
  });

  it('still refuses a method outside the five', () => {
    expect(() => quote({ balanceMethod: 'PAYPAL' as unknown as ProportionalMethod })).toThrow(expect.objectContaining({ code: 'PAYMENT_METHOD_NOT_ENABLED' }));
  });
});
