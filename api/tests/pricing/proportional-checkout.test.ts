// R3 rev. 2 — pure proportional checkout engine (ETAPA B §2 formulas, §3 Hamilton).
//
// These expectations were preregistered against the disposable R3 rev.1/rev.2
// reference model (`r3b-model.mjs`, ALL PASS) BEFORE this implementation was
// written, per the TDD brief. Money is centavos BigInt only; the reference
// values below were produced by that model, not by this module.
// Reference model values (centavos):
//   C1 T=4_200_000  C2 T=4_100_000  C3 T=4_150_000  C4 T=4_200_000
//   C5 B=3_000_000 T=4_100_050  C6 B=2_100_000 T=4_200_050
//   MULTI T=3_942_955  lineFinal REM-01=2_582_774 PAN-02=1_046_022 MED-03=314_159
//   HALF qty1000 base 99_950 -> P_CASH=100_000_000 (deviation +50_000)
import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/shared/errors.js';
import {
  MAX_INT8,
  PROPORTIONAL_METHODS,
  computeProportionalQuote,
  roundPeso,
  type ProportionalLineInput,
  type ProportionalMethod,
  type ProportionalPricingSnapshot,
  type ProportionalQuote,
  type ProportionalTenderInput,
} from '../../src/modules/pricing/proportional-checkout.js';

const PESO = 100n;
const p = (n: number | bigint): bigint => BigInt(n) * PESO;

const PRICING: ProportionalPricingSnapshot = {
  bankTransferAdjustmentBps: 1000,
  debitCardAdjustmentBps: 500,
};
const NO_ADJUSTMENTS: ProportionalPricingSnapshot = {
  bankTransferAdjustmentBps: 0,
  debitCardAdjustmentBps: 0,
};

// $40.000 retail base: full prices $40.000 CASH, $44.000 TRANSFER (+10%), $42.000 DEBIT (+5%).
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

function expectCode(fn: () => unknown, code: string): void {
  expect(fn).toThrow(AppError);
  try {
    fn();
  } catch (error) {
    expect((error as AppError).code).toBe(code);
  }
}

function finalsById(result: ProportionalQuote): Map<string, bigint> {
  return new Map(result.lines.map((line) => [line.saleItemId, line.finalAmount]));
}

function methodQuote(result: ProportionalQuote, method: ProportionalMethod) {
  const found = result.methods.find((entry) => entry.method === method);
  if (!found) throw new Error(`method ${method} is missing from the quote`);
  return found;
}

function methodTotal(result: ProportionalQuote, method: ProportionalMethod): bigint {
  return methodQuote(result, method).allocations.reduce((sum, entry) => sum + entry.amount, 0n);
}

// Full allocation per (saleItemId, method), independent of the input order of
// the lines: sorted by method then saleItemId so permutations compare equal.
function allocationsById(result: ProportionalQuote): string {
  return JSON.stringify(
    [...result.methods]
      .sort((left, right) => (left.method < right.method ? -1 : left.method > right.method ? 1 : 0))
      .map((entry) => ({
        method: entry.method,
        allocations: [...entry.allocations]
          .sort((left, right) => (left.saleItemId < right.saleItemId ? -1 : left.saleItemId > right.saleItemId ? 1 : 0))
          .map((allocation) => ({ saleItemId: allocation.saleItemId, method: entry.method, amount: allocation.amount })),
      })),
    (_key, value) => (typeof value === 'bigint' ? `${value}n` : value),
  );
}

function normalized(result: ProportionalQuote): string {
  return JSON.stringify(
    {
      fullPrices: result.fullPrices,
      balance: result.balance,
      total: result.total,
      methods: result.methods,
      lines: result.lines,
    },
    (_key, value) => (typeof value === 'bigint' ? `${value}n` : value),
  );
}

describe('roundPeso — half-up to the whole peso', () => {
  it('rounds an exact centavo amount to the nearest peso, half up', () => {
    expect(roundPeso(4_399_890n, 1n)).toBe(4_399_900n); // $43.998,90 -> $43.999
    expect(roundPeso(100_050n, 1n)).toBe(100_100n); // exactly half a peso -> up
    expect(roundPeso(100_049n, 1n)).toBe(100_000n); // just below half -> down
    expect(roundPeso(100_000n, 1n)).toBe(100_000n); // exact peso unchanged
  });

  it('rejects a non-positive domain', () => {
    expect(() => roundPeso(-1n, 1n)).toThrow();
    expect(() => roundPeso(1n, 0n)).toThrow();
    expect(() => roundPeso(1n, -100n)).toThrow();
  });

  it('rejects a numerator or denominator that is not a BigInt', () => {
    expectCode(() => roundPeso(100_050 as unknown as bigint, 1n), 'INVALID_MONEY_TYPE');
    expectCode(() => roundPeso(100_050n, 1 as unknown as bigint), 'INVALID_MONEY_TYPE');
    expectCode(() => roundPeso('100050' as unknown as bigint, 1n), 'INVALID_MONEY_TYPE');
  });
});

describe('R3 §2 — the four approved commercial cases', () => {
  it('C1: $20.000 CASH fixed, balance TRANSFER', () => {
    const result = quote({ tenders: [{ method: 'CASH', amount: p(20000) }], balanceMethod: 'TRANSFER' });
    expect(result.fullPrices).toEqual({ CASH: p(40000), TRANSFER: p(44000), CARD_DEBIT: p(42000), CARD_CREDIT: null, QR: null });
    expect(result.balance).toEqual({ method: 'TRANSFER', amount: p(22000) });
    expect(result.total).toBe(p(42000));
    expect(methodTotal(result, 'CASH')).toBe(p(20000));
    expect(methodTotal(result, 'TRANSFER')).toBe(p(22000));
    expect(result.lines[0]!.finalAmount).toBe(p(42000));
  });

  it('C2: $11.000 TRANSFER fixed, balance CASH', () => {
    const result = quote({ tenders: [{ method: 'TRANSFER', amount: p(11000) }], balanceMethod: 'CASH' });
    expect(result.balance.amount).toBe(p(30000));
    expect(result.total).toBe(p(41000));
    expect(result.lines[0]!.finalAmount).toBe(p(41000));
  });

  it('C3: $10.000 CASH fixed, balance CARD_DEBIT', () => {
    const result = quote({ tenders: [{ method: 'CASH', amount: p(10000) }], balanceMethod: 'CARD_DEBIT' });
    expect(result.balance.amount).toBe(p(31500));
    expect(result.total).toBe(p(41500));
    expect(result.lines[0]!.finalAmount).toBe(p(41500));
  });

  it('C4: $10.000 CASH + $11.000 TRANSFER fixed, balance CARD_DEBIT (large intermediate)', () => {
    const result = quote({
      tenders: [
        { method: 'CASH', amount: p(10000) },
        { method: 'TRANSFER', amount: p(11000) },
      ],
      balanceMethod: 'CARD_DEBIT',
    });
    expect(result.balance.amount).toBe(p(21000));
    expect(result.total).toBe(p(42000));
    expect(result.lines[0]!.finalAmount).toBe(p(42000));
  });
});

describe('R3 §2 — single-method sales', () => {
  it('a balance-only sale equals that method full price', () => {
    expect(quote({ balanceMethod: 'CASH' }).total).toBe(p(40000));
    expect(quote({ balanceMethod: 'TRANSFER' }).total).toBe(p(44000));
    expect(quote({ balanceMethod: 'CARD_DEBIT' }).total).toBe(p(42000));
  });
});

describe('R3 §3 — multiple garments and quantities (worked example)', () => {
  const lines: readonly ProportionalLineInput[] = [
    { saleItemId: 'item-rem', sku: 'REM-01', quantity: 2n, baseUnitPrice: p(12345) },
    { saleItemId: 'item-pan', sku: 'PAN-02', quantity: 1n, baseUnitPrice: p(9999) },
    { saleItemId: 'item-med', sku: 'MED-03', quantity: 3n, baseUnitPrice: p(1001) },
  ];
  const build = (ordered: readonly ProportionalLineInput[]): ProportionalQuote =>
    quote({
      lines: ordered,
      tenders: [
        { method: 'CASH', amount: p(10000) },
        { method: 'TRANSFER', amount: 777_755n },
      ],
      balanceMethod: 'CARD_DEBIT',
    });

  it('reconciles exactly per method and per line', () => {
    const result = build(lines);
    expect(result.fullPrices).toEqual({ CASH: 3_769_200n, TRANSFER: 4_146_200n, CARD_DEBIT: 3_957_600n, CARD_CREDIT: null, QR: null });
    expect(result.balance.amount).toBe(2_165_200n);
    expect(result.total).toBe(3_942_955n);
    expect(methodTotal(result, 'CASH')).toBe(1_000_000n);
    expect(methodTotal(result, 'TRANSFER')).toBe(777_755n);
    expect(methodTotal(result, 'CARD_DEBIT')).toBe(2_165_200n);
    expect(finalsById(result)).toEqual(
      new Map([
        ['item-rem', 2_582_774n],
        ['item-pan', 1_046_022n],
        ['item-med', 314_159n],
      ]),
    );
  });

  it('produces the same per-line allocations as the reference model', () => {
    const result = build(lines);
    expect(methodQuote(result, 'CASH').allocations).toEqual([
      { saleItemId: 'item-rem', sku: 'REM-01', amount: 655_000n },
      { saleItemId: 'item-pan', sku: 'PAN-02', amount: 265_300n },
      { saleItemId: 'item-med', sku: 'MED-03', amount: 79_700n },
    ]);
    expect(methodQuote(result, 'TRANSFER').allocations).toEqual([
      { saleItemId: 'item-rem', sku: 'REM-01', amount: 509_474n },
      { saleItemId: 'item-pan', sku: 'PAN-02', amount: 206_322n },
      { saleItemId: 'item-med', sku: 'MED-03', amount: 61_959n },
    ]);
    expect(methodQuote(result, 'CARD_DEBIT').allocations).toEqual([
      { saleItemId: 'item-rem', sku: 'REM-01', amount: 1_418_300n },
      { saleItemId: 'item-pan', sku: 'PAN-02', amount: 574_400n },
      { saleItemId: 'item-med', sku: 'MED-03', amount: 172_500n },
    ]);
  });
});

describe('R3 §2 — external payments with cents', () => {
  it('C5: a $11.000,50 TRANSFER fixed tender keeps its centavos, balance CASH', () => {
    const result = quote({ tenders: [{ method: 'TRANSFER', amount: 1_100_050n }], balanceMethod: 'CASH' });
    expect(result.balance.amount).toBe(p(30000));
    expect(result.total).toBe(4_100_050n);
    expect(methodQuote(result, 'TRANSFER').allocations[0]!.amount).toBe(1_100_050n);
  });

  it('C6: $11.000,50 TRANSFER + $10.000 CASH fixed, balance CARD_DEBIT', () => {
    const result = quote({
      tenders: [
        { method: 'TRANSFER', amount: 1_100_050n },
        { method: 'CASH', amount: p(10000) },
      ],
      balanceMethod: 'CARD_DEBIT',
    });
    expect(result.balance.amount).toBe(p(21000));
    expect(result.total).toBe(p(42000) + 50n);
    expect(methodQuote(result, 'TRANSFER').allocations[0]!.amount).toBe(1_100_050n);
  });

  it('accepts a one-centavo fixed tender without rounding it', () => {
    const result = quote({ tenders: [{ method: 'TRANSFER', amount: 1n }], balanceMethod: 'CASH' });
    expect(result.balance.amount).toBe(p(40000));
    expect(result.total).toBe(p(40000) + 1n);
  });

  it('allocates whole-peso tenders in whole pesos and centavo tenders to the centavo', () => {
    const result = quote({
      tenders: [
        { method: 'CASH', amount: p(10000) },
        { method: 'TRANSFER', amount: 777_755n },
      ],
      balanceMethod: 'CARD_DEBIT',
    });
    for (const allocation of methodQuote(result, 'CASH').allocations) {
      expect(allocation.amount % PESO).toBe(0n);
    }
    for (const allocation of methodQuote(result, 'CARD_DEBIT').allocations) {
      expect(allocation.amount % PESO).toBe(0n);
    }
    const transfer = methodQuote(result, 'TRANSFER');
    expect(transfer.amount % PESO).not.toBe(0n);
    expect(transfer.allocations.some((allocation) => allocation.amount % PESO !== 0n)).toBe(true);
  });

  it('conserves a fixed CASH tender with centavos exactly across lines', () => {
    const result = quote({
      lines: [
        { saleItemId: 'l1', sku: 'L1', quantity: 1n, baseUnitPrice: 200_000n },
        { saleItemId: 'l2', sku: 'L2', quantity: 1n, baseUnitPrice: 400_000n },
      ],
      pricing: NO_ADJUSTMENTS,
      tenders: [{ method: 'CASH', amount: 300_050n }],
      balanceMethod: 'TRANSFER',
    });
    const cash = methodQuote(result, 'CASH');
    expect(cash.amount).toBe(300_050n);
    expect(cash.allocations).toEqual([
      { saleItemId: 'l1', sku: 'L1', amount: 100_017n },
      { saleItemId: 'l2', sku: 'L2', amount: 200_033n },
    ]);
    expect(methodTotal(result, 'CASH')).toBe(300_050n);
    expect(result.balance.amount).toBe(300_000n);
    expect(result.total).toBe(600_050n);
    expect(finalsById(result)).toEqual(
      new Map([
        ['l1', 200_017n],
        ['l2', 400_033n],
      ]),
    );
  });

  it('keeps a fixed CASH tender with centavos untouched on a single line', () => {
    const result = quote({ tenders: [{ method: 'CASH', amount: 1_100_050n }], balanceMethod: 'TRANSFER' });
    expect(methodQuote(result, 'CASH').allocations[0]!.amount).toBe(1_100_050n);
    expect(methodQuote(result, 'CASH').allocations[0]!.amount % PESO).toBe(50n);
    expect(result.balance.amount).toBe(3_189_900n);
    expect(result.total).toBe(4_289_950n);
  });
});

describe('R3 §2 — half-up rounding', () => {
  it('HALF: 1.000 units of $999,50 round up per unit to $1.000.000 (deviation +$500)', () => {
    const result = quote({
      lines: [{ saleItemId: 'half', sku: 'HALF', quantity: 1000n, baseUnitPrice: 99_950n }],
      pricing: NO_ADJUSTMENTS,
      balanceMethod: 'CASH',
    });
    expect(result.fullPrices.CASH).toBe(100_000_000n);
    expect(result.fullPrices.CASH! - 1000n * 99_950n).toBe(50_000n);
    expect(result.total).toBe(100_000_000n);
  });

  it('rounds a half-peso unit price up', () => {
    const result = quote({
      lines: [{ saleItemId: 'unit', sku: 'UNIT', quantity: 1n, baseUnitPrice: 50n }],
      pricing: NO_ADJUSTMENTS,
      balanceMethod: 'CASH',
    });
    expect(result.fullPrices.CASH).toBe(100n);
  });
});

describe('R3 §2/§3 — order independence and deterministic tie-break', () => {
  const lines: readonly ProportionalLineInput[] = [
    { saleItemId: 'item-rem', sku: 'REM-01', quantity: 2n, baseUnitPrice: p(12345) },
    { saleItemId: 'item-pan', sku: 'PAN-02', quantity: 1n, baseUnitPrice: p(9999) },
    { saleItemId: 'item-med', sku: 'MED-03', quantity: 3n, baseUnitPrice: p(1001) },
  ];
  const permute = <T,>(items: readonly T[]): T[][] => {
    if (items.length <= 1) return [[...items]];
    return items.flatMap((item, index) =>
      permute([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]),
    );
  };

  it('is invariant to the input order of the lines', () => {
    const baseline = quote({
      lines,
      tenders: [
        { method: 'CASH', amount: p(10000) },
        { method: 'TRANSFER', amount: 777_755n },
      ],
      balanceMethod: 'CARD_DEBIT',
    });
    const expected = finalsById(baseline);
    const expectedAllocations = allocationsById(baseline);
    for (const ordered of permute(lines)) {
      const result = quote({
        lines: ordered,
        tenders: [
          { method: 'CASH', amount: p(10000) },
          { method: 'TRANSFER', amount: 777_755n },
        ],
        balanceMethod: 'CARD_DEBIT',
      });
      expect(finalsById(result)).toEqual(expected);
      expect(allocationsById(result)).toBe(expectedAllocations);
      expect(result.total).toBe(baseline.total);
    }
  });

  it('is invariant to the input order of the tenders', () => {
    const tenders: ProportionalTenderInput[] = [
      { method: 'CASH', amount: p(10000) },
      { method: 'TRANSFER', amount: 777_755n },
    ];
    const baseline = quote({ lines, tenders, balanceMethod: 'CARD_DEBIT' });
    const reversed = quote({ lines, tenders: [...tenders].reverse(), balanceMethod: 'CARD_DEBIT' });
    expect(normalized(reversed)).toBe(normalized(baseline));
  });

  it('breaks a remainder tie by the lower SKU', () => {
    const result = quote({
      lines: [
        { saleItemId: 'b2', sku: 'B', quantity: 1n, baseUnitPrice: 10_000n },
        { saleItemId: 'a1', sku: 'A', quantity: 1n, baseUnitPrice: 10_000n },
      ],
      pricing: NO_ADJUSTMENTS,
      tenders: [{ method: 'CASH', amount: 300n }],
      balanceMethod: 'TRANSFER',
    });
    expect(finalsById(result)).toEqual(
      new Map([
        ['b2', 9_900n],
        ['a1', 10_100n],
      ]),
    );
    expect(methodQuote(result, 'CASH').allocations).toEqual([
      { saleItemId: 'b2', sku: 'B', amount: 100n },
      { saleItemId: 'a1', sku: 'A', amount: 200n },
    ]);
  });

  it('distributes residual units deterministically with unequal lines', () => {
    const result = quote({
      lines: [
        { saleItemId: 'r1', sku: 'S1', quantity: 1n, baseUnitPrice: 10_000n },
        { saleItemId: 'r2', sku: 'S2', quantity: 2n, baseUnitPrice: 10_000n },
        { saleItemId: 'r3', sku: 'S3', quantity: 1n, baseUnitPrice: 10_000n },
      ],
      pricing: NO_ADJUSTMENTS,
      tenders: [{ method: 'CASH', amount: 1000n }],
      balanceMethod: 'TRANSFER',
    });
    expect(finalsById(result)).toEqual(
      new Map([
        ['r1', 10_100n],
        ['r2', 20_000n],
        ['r3', 9_900n],
      ]),
    );
  });

  it('breaks a full tie by saleItemId when two lines share a SKU', () => {
    const build = (ordered: readonly ProportionalLineInput[]): ProportionalQuote =>
      quote({
        lines: ordered,
        pricing: NO_ADJUSTMENTS,
        tenders: [{ method: 'CASH', amount: 300n }],
        balanceMethod: 'TRANSFER',
      });
    const dupB: ProportionalLineInput = { saleItemId: 'dup-b', sku: 'DUP', quantity: 1n, baseUnitPrice: 10_000n };
    const dupA: ProportionalLineInput = { saleItemId: 'dup-a', sku: 'DUP', quantity: 1n, baseUnitPrice: 10_000n };
    const result = build([dupB, dupA]);
    expect(methodQuote(result, 'CASH').allocations).toEqual([
      { saleItemId: 'dup-b', sku: 'DUP', amount: 100n },
      { saleItemId: 'dup-a', sku: 'DUP', amount: 200n },
    ]);
    expect(methodQuote(result, 'TRANSFER').allocations).toEqual([
      { saleItemId: 'dup-b', sku: 'DUP', amount: 9_800n },
      { saleItemId: 'dup-a', sku: 'DUP', amount: 9_900n },
    ]);
    expect(finalsById(result)).toEqual(
      new Map([
        ['dup-b', 9_900n],
        ['dup-a', 10_100n],
      ]),
    );
    expect(result.total).toBe(20_000n);
    // Reversing the input order must not change which duplicated SKU wins.
    expect(allocationsById(build([dupA, dupB]))).toBe(allocationsById(result));
  });
});

describe('R3 §2 — BigInt limits and overflow', () => {
  it('computes intermediates far beyond int8 while every persisted value stays bounded', () => {
    const result = quote({
      lines: [{ saleItemId: 'big', sku: 'BIG', quantity: 1n, baseUnitPrice: 1_000_000_000n }],
      pricing: NO_ADJUSTMENTS,
      tenders: [
        { method: 'CASH', amount: 1n },
        { method: 'TRANSFER', amount: 1n },
      ],
      balanceMethod: 'CARD_DEBIT',
    });
    expect(result.fullPrices).toEqual({ CASH: 1_000_000_000n, TRANSFER: 1_000_000_000n, CARD_DEBIT: 1_000_000_000n, CARD_CREDIT: null, QR: null });
    expect(result.total).toBe(1_000_000_002n);
  });

  it('exports the int8 ceiling', () => {
    expect(MAX_INT8).toBe(9_223_372_036_854_775_807n);
  });

  it('rejects an overflowing unit price', () => {
    expectCode(
      () =>
        quote({
          lines: [{ saleItemId: 'u', sku: 'U', quantity: 1n, baseUnitPrice: MAX_INT8 }],
          pricing: { bankTransferAdjustmentBps: 10000, debitCardAdjustmentBps: 0 },
          balanceMethod: 'TRANSFER',
        }),
      'AMOUNT_OVERFLOW',
    );
  });

  it('rejects an overflowing line total', () => {
    expectCode(
      () =>
        quote({
          lines: [{ saleItemId: 'l', sku: 'L', quantity: 2n, baseUnitPrice: MAX_INT8 }],
          pricing: NO_ADJUSTMENTS,
          balanceMethod: 'CASH',
        }),
      'AMOUNT_OVERFLOW',
    );
  });

  it('rejects an overflowing method full price', () => {
    expectCode(
      () =>
        quote({
          lines: [
            { saleItemId: 'p1', sku: 'P1', quantity: 1n, baseUnitPrice: MAX_INT8 },
            { saleItemId: 'p2', sku: 'P2', quantity: 1n, baseUnitPrice: MAX_INT8 },
          ],
          pricing: NO_ADJUSTMENTS,
          balanceMethod: 'CASH',
        }),
      'AMOUNT_OVERFLOW',
    );
  });

  it('rejects an overflowing final total', () => {
    expectCode(
      () =>
        quote({
          lines: [{ saleItemId: 't', sku: 'T', quantity: 1n, baseUnitPrice: MAX_INT8 }],
          pricing: NO_ADJUSTMENTS,
          tenders: [{ method: 'CASH', amount: MAX_INT8 - 99n }],
          balanceMethod: 'CARD_DEBIT',
        }),
      'AMOUNT_OVERFLOW',
    );
  });

  it('rejects a fixed tender beyond int8 before judging whether it covers the sale', () => {
    expectCode(
      () => quote({ tenders: [{ method: 'CASH', amount: MAX_INT8 + 1n }], balanceMethod: 'TRANSFER' }),
      'AMOUNT_OVERFLOW',
    );
    expectCode(
      () =>
        quote({
          tenders: [
            { method: 'CASH', amount: MAX_INT8 + 1n },
            { method: 'TRANSFER', amount: p(1000) },
          ],
          balanceMethod: 'CARD_DEBIT',
        }),
      'AMOUNT_OVERFLOW',
    );
    expectCode(
      () => quote({ tenders: [{ method: 'TRANSFER', amount: MAX_INT8 * 2n }], balanceMethod: 'CASH' }),
      'AMOUNT_OVERFLOW',
    );
  });
});

describe('R3 §2 — invalid inputs fail closed', () => {
  it('exposes exactly CASH, TRANSFER, CARD_DEBIT, CARD_CREDIT and QR', () => {
    expect(PROPORTIONAL_METHODS).toEqual(['CASH', 'TRANSFER', 'CARD_DEBIT', 'CARD_CREDIT', 'QR']);
  });

  it('rejects an empty or inconsistent sale', () => {
    expectCode(() => quote({ lines: [], balanceMethod: 'CASH' }), 'PRICING_SNAPSHOT_INCONSISTENT');
    expectCode(
      () => quote({ lines: [{ saleItemId: 'q', sku: 'Q', quantity: 0n, baseUnitPrice: 10_000n }], balanceMethod: 'CASH' }),
      'PRICING_SNAPSHOT_INCONSISTENT',
    );
    expectCode(
      () => quote({ lines: [{ saleItemId: 'q', sku: 'Q', quantity: 1n, baseUnitPrice: 0n }], balanceMethod: 'CASH' }),
      'PRICING_SNAPSHOT_INCONSISTENT',
    );
  });

  it('rejects an unsupported method', () => {
    const unknown = 'PAYPAL' as unknown as ProportionalMethod;
    expectCode(() => quote({ balanceMethod: unknown }), 'PAYMENT_METHOD_NOT_ENABLED');
    expectCode(() => quote({ tenders: [{ method: unknown, amount: p(1000) }], balanceMethod: 'CASH' }), 'PAYMENT_METHOD_NOT_ENABLED');
  });

  it('fails closed on missing configuration and only offers CASH', () => {
    expectCode(() => quote({ pricing: null, balanceMethod: 'TRANSFER' }), 'PRICING_CONFIG_MISSING');
    expectCode(
      () => quote({ pricing: null, tenders: [{ method: 'TRANSFER', amount: p(1000) }], balanceMethod: 'CASH' }),
      'PRICING_CONFIG_MISSING',
    );
    const cashOnly = quote({ pricing: null, balanceMethod: 'CASH' });
    expect(cashOnly.fullPrices).toEqual({ CASH: p(40000), TRANSFER: null, CARD_DEBIT: null, CARD_CREDIT: null, QR: null });
    expect(cashOnly.total).toBe(p(40000));
  });

  it('rejects out-of-range adjustment basis points', () => {
    expectCode(
      () => quote({ pricing: { bankTransferAdjustmentBps: -1, debitCardAdjustmentBps: 0 }, balanceMethod: 'CASH' }),
      'INVALID_PRICE_ADJUSTMENT',
    );
    expectCode(
      () => quote({ pricing: { bankTransferAdjustmentBps: 10001, debitCardAdjustmentBps: 0 }, balanceMethod: 'CASH' }),
      'INVALID_PRICE_ADJUSTMENT',
    );
  });

  it('rejects a balance method that is also a fixed tender', () => {
    expectCode(
      () => quote({ tenders: [{ method: 'CASH', amount: p(10000) }], balanceMethod: 'CASH' }),
      'BALANCE_METHOD_ALSO_FIXED',
    );
  });

  it('rejects a non-positive or duplicated tender', () => {
    expectCode(
      () => quote({ tenders: [{ method: 'CASH', amount: 0n }], balanceMethod: 'TRANSFER' }),
      'FIXED_TENDER_NOT_POSITIVE',
    );
    expectCode(
      () =>
        quote({
          tenders: [
            { method: 'CASH', amount: p(1000) },
            { method: 'CASH', amount: p(2000) },
          ],
          balanceMethod: 'TRANSFER',
        }),
      'DUPLICATE_TENDER_METHOD',
    );
  });

  it('rejects fixed tenders that cover the sale', () => {
    expectCode(
      () => quote({ tenders: [{ method: 'CASH', amount: p(40000) }], balanceMethod: 'TRANSFER' }),
      'FIXED_TENDERS_COVER_SALE',
    );
  });

  it('rejects a balance below one peso', () => {
    expectCode(
      () => quote({ tenders: [{ method: 'CASH', amount: p(40000) - 1n }], balanceMethod: 'TRANSFER' }),
      'BALANCE_TOO_SMALL',
    );
    // Exactly $1 of balance is accepted.
    expect(quote({ tenders: [{ method: 'CASH', amount: p(40000) - 100n }], balanceMethod: 'TRANSFER' }).balance.amount).toBe(100n);
  });
});

describe('R3 §2 — non-BigInt money fails closed at the public boundary', () => {
  it('rejects a quantity that is not a BigInt with a domain error, not a TypeError', () => {
    expectCode(
      () =>
        quote({
          lines: [{ saleItemId: 'q', sku: 'Q', quantity: 1 as unknown as bigint, baseUnitPrice: p(1000) }],
          balanceMethod: 'CASH',
        }),
      'INVALID_MONEY_TYPE',
    );
    expectCode(
      () =>
        quote({
          lines: [{ saleItemId: 'q', sku: 'Q', quantity: '2' as unknown as bigint, baseUnitPrice: p(1000) }],
          balanceMethod: 'CASH',
        }),
      'INVALID_MONEY_TYPE',
    );
  });

  it('rejects a base unit price that is not a BigInt', () => {
    expectCode(
      () =>
        quote({
          lines: [{ saleItemId: 'q', sku: 'Q', quantity: 1n, baseUnitPrice: 100_000 as unknown as bigint }],
          balanceMethod: 'CASH',
        }),
      'INVALID_MONEY_TYPE',
    );
    expectCode(
      () =>
        quote({
          lines: [{ saleItemId: 'q', sku: 'Q', quantity: 1n, baseUnitPrice: '100000' as unknown as bigint }],
          balanceMethod: 'CASH',
        }),
      'INVALID_MONEY_TYPE',
    );
  });

  it('rejects a fixed tender amount that is not a BigInt', () => {
    expectCode(
      () => quote({ tenders: [{ method: 'CASH', amount: 100_000 as unknown as bigint }], balanceMethod: 'TRANSFER' }),
      'INVALID_MONEY_TYPE',
    );
    expectCode(
      () => quote({ tenders: [{ method: 'CASH', amount: '100000' as unknown as bigint }], balanceMethod: 'TRANSFER' }),
      'INVALID_MONEY_TYPE',
    );
  });

  it('never surfaces a raw TypeError for a bad money type', () => {
    const runs = [
      () =>
        quote({
          lines: [{ saleItemId: 'q', sku: 'Q', quantity: 1 as unknown as bigint, baseUnitPrice: p(1000) }],
          balanceMethod: 'CASH',
        }),
      () =>
        quote({
          lines: [{ saleItemId: 'q', sku: 'Q', quantity: 1n, baseUnitPrice: 100_000 as unknown as bigint }],
          balanceMethod: 'CASH',
        }),
      () => quote({ tenders: [{ method: 'CASH', amount: 100_000 as unknown as bigint }], balanceMethod: 'TRANSFER' }),
    ];
    for (const run of runs) {
      let caught: unknown;
      try {
        run();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(AppError);
      expect(caught).not.toBeInstanceOf(TypeError);
    }
  });
});

describe('R3 §2/§3 — deterministic seeded invariant sweep', () => {
  function mulberry32(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let value = state;
      value = Math.imul(value ^ (value >>> 15), value | 1);
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
  }

  it('reconciles every method, every line and the sale total across 400 fixed-seed cases', () => {
    const rng = mulberry32(0x5eed_1234);
    const nextInt = (maxExclusive: number): number => Math.floor(rng() * maxExclusive);
    const methods: readonly ProportionalMethod[] = ['CASH', 'TRANSFER', 'CARD_DEBIT'];

    for (let caseIndex = 0; caseIndex < 400; caseIndex += 1) {
      const lineCount = 1 + nextInt(5);
      const lines: ProportionalLineInput[] = [];
      for (let index = 0; index < lineCount; index += 1) {
        lines.push({
          saleItemId: `case${caseIndex}-item${index}`,
          sku: `SKU-${caseIndex}-${index}`,
          quantity: BigInt(1 + nextInt(5)),
          baseUnitPrice: BigInt(100 + nextInt(500_000)),
        });
      }
      const pricing: ProportionalPricingSnapshot = {
        bankTransferAdjustmentBps: nextInt(10_001),
        debitCardAdjustmentBps: nextInt(10_001),
      };
      const balanceMethod = methods[nextInt(3)]!;
      // Every method full price is at least the CASH full price, so keeping each
      // fixed tender below an eighth of it can never cover a method.
      const cashFullPrice = lines.reduce((sum, line) => sum + line.quantity * roundPeso(line.baseUnitPrice, 1n), 0n);
      const cap = cashFullPrice / 8n;
      const fixedMethods = methods.filter((method) => method !== balanceMethod && nextInt(3) === 0);
      const tenders: ProportionalTenderInput[] = fixedMethods.map((method) => ({
        method,
        amount: 1n + BigInt(nextInt(Number(cap))),
      }));

      const result = computeProportionalQuote({ lines, pricing, tenders, balanceMethod });
      const context = `case ${caseIndex}`;

      for (const method of methods) {
        const tender = tenders.find((entry) => entry.method === method);
        const expected = method === balanceMethod ? result.balance.amount : tender?.amount;
        const methodEntry = result.methods.find((entry) => entry.method === method);
        if (expected === undefined) {
          expect(methodEntry, context).toBeUndefined();
          continue;
        }
        expect(methodEntry, context).toBeDefined();
        expect(methodEntry!.amount, context).toBe(expected);
        let methodSum = 0n;
        for (let index = 0; index < lines.length; index += 1) {
          const allocation = methodEntry!.allocations[index]!;
          expect(allocation.saleItemId, context).toBe(lines[index]!.saleItemId);
          expect(allocation.amount >= 0n, context).toBe(true);
          expect(allocation.amount <= result.lineFullPrices[method]![index]!, context).toBe(true);
          methodSum += allocation.amount;
        }
        expect(methodSum, context).toBe(expected);
      }

      const finalsSum = result.lines.reduce((sum, line) => sum + line.finalAmount, 0n);
      expect(finalsSum, context).toBe(result.total);
      expect(result.total, context).toBe(result.methods.reduce((sum, entry) => sum + entry.amount, 0n));
      expect(result.total, context).toBe(tenders.reduce((sum, entry) => sum + entry.amount, 0n) + result.balance.amount);
    }
  });
});
