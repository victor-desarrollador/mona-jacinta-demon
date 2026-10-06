import { describe, expect, it, vi } from 'vitest';
import type { Request } from 'express';
import {
  getProduct,
  getVariant,
  listVariants,
} from '../../src/modules/products/products.service.js';

const variant = {
  id: 'variant-1',
  productId: 'product-1',
  sku: 'REM-NEG-M',
  barcode: '7790000000001',
  color: 'Negro',
  size: 'M',
  price: 1000n,
  isActive: true,
  product: { id: 'product-1', name: 'Remera', slug: 'remera' },
};

function req(): Request {
  return {
    auth: {
      userId: 'user-1',
      roles: ['SELLER', 'WAREHOUSE'],
      effectiveLocationIds: ['loc-a', 'loc-b'],
      assignments: [
        {
          roleId: 'seller-role',
          roleCode: 'SELLER',
          scopeKind: 'LOCATION',
          locationId: 'loc-a',
          permissions: ['INVENTORY_VIEW'],
        },
        {
          roleId: 'warehouse-role',
          roleCode: 'WAREHOUSE',
          scopeKind: 'LOCATION',
          locationId: 'loc-b',
          permissions: ['INVENTORY_MANAGE'],
        },
      ],
    },
  } as Request;
}

describe('product inventory read location scope (DB-free)', () => {
  const query = {
    page: 1,
    limit: 20,
    isActive: true,
  };

  function databaseWithVariantFindMany(findMany: ReturnType<typeof vi.fn>) {
    return {
      productVariant: {
        findMany,
        count: vi.fn(async () => 1),
      },
      stockReservation: {
        groupBy: vi.fn(async () => []),
      },
    };
  }

  it('filters variant inventory to locations where the same assignment grants INVENTORY_VIEW', async () => {
    const findMany = vi.fn(async (args) => {
      expect(args.select.inventory.where.branchId).toEqual({ in: ['loc-a'] });
      return [
        {
          ...variant,
          inventory: [
            { id: 'inv-a', branchId: 'loc-a', physical: 3n, reserved: 0n },
          ],
        },
      ];
    });
    const database = databaseWithVariantFindMany(findMany);

    const result = await listVariants(database as never, req(), query);

    expect(result.items[0]!.inventory).toEqual([
      expect.objectContaining({ id: 'inv-a', branchId: 'loc-a', available: '3' }),
    ]);
  });

  it('filters product detail inventory with the same permission-bound location list', async () => {
    const findUnique = vi.fn(async (args) => {
      expect(args.select.variants.select.inventory.where.branchId).toEqual({ in: ['loc-a'] });
      return {
        id: 'product-1',
        name: 'Remera',
        slug: 'remera',
        description: null,
        isActive: true,
        category: { id: 'cat-1', name: 'Ropa' },
        brand: { id: 'brand-1', name: 'Mona' },
        variants: [
          {
            ...variant,
            inventory: [
              { id: 'inv-a', branchId: 'loc-a', physical: 2n, reserved: 0n },
            ],
          },
        ],
      };
    });
    const database = {
      product: { findUnique },
      stockReservation: { groupBy: vi.fn(async () => []) },
    };

    const result = await getProduct(database as never, 'product-1', req().auth);

    expect(result.variants[0]!.inventory).toEqual([
      expect.objectContaining({ id: 'inv-a', branchId: 'loc-a', available: '2' }),
    ]);
  });

  it('filters variant detail inventory with the same permission-bound location list', async () => {
    const findUnique = vi.fn(async (args) => {
      expect(args.select.inventory.where.branchId).toEqual({ in: ['loc-a'] });
      return {
        ...variant,
        product: {
          id: 'product-1',
          name: 'Remera',
          slug: 'remera',
          category: { id: 'cat-1', name: 'Ropa' },
          brand: { id: 'brand-1', name: 'Mona' },
        },
        inventory: [
          { id: 'inv-a', branchId: 'loc-a', physical: 4n, reserved: 1n },
        ],
      };
    });
    const database = {
      productVariant: { findUnique },
      stockReservation: { groupBy: vi.fn(async () => []) },
    };

    const result = await getVariant(database as never, 'variant-1', req().auth);

    expect(result.inventory).toEqual([
      expect.objectContaining({ id: 'inv-a', branchId: 'loc-a', available: '3' }),
    ]);
  });
});
