// Sale exchange v1 — the equal-value rule as ONE pure classification, shared by POST /sales/:saleId/exchanges (which refuses CHEAPER and
// MORE_EXPENSIVE) and GET /sales/:saleId/exchange-replacements (which reports it). DB-FREE.
import { describe, expect, it } from 'vitest';
import { compareReplacementPrice } from '../../src/modules/sales/replacement-price.js';

describe('compareReplacementPrice', () => {
  it('RP01 equal unit prices are EQUAL', () => {
    expect(compareReplacementPrice(10000n, 10000n)).toBe('EQUAL');
  });

  it('RP02 a replacement below the original is CHEAPER', () => {
    expect(compareReplacementPrice(10000n, 9999n)).toBe('CHEAPER');
  });

  it('RP03 a replacement above the original is MORE_EXPENSIVE', () => {
    expect(compareReplacementPrice(10000n, 10001n)).toBe('MORE_EXPENSIVE');
  });

  it('RP04 the comparison is exact BigInt: a difference of one centavo above 2^53 is not lost', () => {
    const big = 9007199254740993n;
    expect(compareReplacementPrice(big, big)).toBe('EQUAL');
    expect(compareReplacementPrice(big, big - 1n)).toBe('CHEAPER');
    expect(compareReplacementPrice(big, big + 1n)).toBe('MORE_EXPENSIVE');
  });
});
