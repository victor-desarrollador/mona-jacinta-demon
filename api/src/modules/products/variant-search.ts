// The text filter of GET /variants (sku, barcode, color, size, product name), as a pure where-fragment so every catalog-style search over
// ProductVariant (GET /variants, GET /sales/:saleId/exchange-replacements) matches the same way. Spread the result into a `where`.
export function variantSearchWhere(search?: string) {
  if (!search) return {};
  return {
    OR: [
      { sku: { contains: search, mode: 'insensitive' as const } },
      { barcode: { contains: search, mode: 'insensitive' as const } },
      { color: { contains: search, mode: 'insensitive' as const } },
      { size: { contains: search, mode: 'insensitive' as const } },
      { product: { name: { contains: search, mode: 'insensitive' as const } } },
    ],
  };
}
