// GET /variants search filter, extracted as a pure function so GET /sales/:saleId/exchange-replacements searches exactly like the catalog.
// DB-FREE. The expected objects below are the literal the service built INLINE before the extraction: GET /variants must keep its behavior.
import { describe, expect, it } from 'vitest';
import { variantSearchWhere } from '../../src/modules/products/variant-search.js';

describe('variantSearchWhere', () => {
  it('VS01 no search adds no condition', () => {
    expect(variantSearchWhere(undefined)).toEqual({});
  });

  it('VS02 a search matches sku, barcode, color, size and the product name, all case-insensitive contains', () => {
    expect(variantSearchWhere('remera')).toEqual({
      OR: [
        { sku: { contains: 'remera', mode: 'insensitive' } },
        { barcode: { contains: 'remera', mode: 'insensitive' } },
        { color: { contains: 'remera', mode: 'insensitive' } },
        { size: { contains: 'remera', mode: 'insensitive' } },
        { product: { name: { contains: 'remera', mode: 'insensitive' } } },
      ],
    });
  });

  it('VS03 the text is used as given (the DTO already trims it); the function does not alter it', () => {
    const where = variantSearchWhere('A B') as { OR: Array<{ sku?: { contains: string } }> };
    expect(where.OR[0]!.sku!.contains).toBe('A B');
  });
});
