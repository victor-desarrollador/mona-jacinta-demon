// Sale exchange v1 is an EQUAL-value swap. This is the one place that classifies a replacement's unit price against the original SaleItem's, so
// POST /sales/:saleId/exchanges (which refuses anything but EQUAL) and GET /sales/:saleId/exchange-replacements (which only reports it) can
// never disagree. Pure: both prices are BigInt centavos, compared exactly.
export type ReplacementComparison = 'EQUAL' | 'CHEAPER' | 'MORE_EXPENSIVE';

export function compareReplacementPrice(original: bigint, replacement: bigint): ReplacementComparison {
  if (replacement < original) return 'CHEAPER';
  if (replacement > original) return 'MORE_EXPENSIVE';
  return 'EQUAL';
}
