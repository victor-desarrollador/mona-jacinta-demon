import { describe, expect, it, vi } from 'vitest';
import { createBackofficeService } from '../../src/modules/backoffice/backoffice.service.js';

function req() {
  return {
    auth: {
      userId: 'user-1',
      roles: ['ADMIN', 'WAREHOUSE'],
      effectiveLocationIds: ['loc-a', 'loc-b'],
      assignments: [
        {
          roleId: 'admin-role',
          roleCode: 'ADMIN',
          scopeKind: 'LOCATION',
          locationId: 'loc-a',
          permissions: ['REPORT_VIEW'],
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
  };
}

describe('backoffice inventory read location scope (DB-free)', () => {
  function database(
    findMany?: unknown,
    count?: unknown,
  ) {
    return {
      inventory: {
        findMany: findMany ?? vi.fn(async (_args?: unknown) => []),
        count: count ?? vi.fn(async (_args?: unknown) => 0),
      },
      stockReservation: {
        groupBy: vi.fn(async () => []),
      },
      branch: {
        findMany: vi.fn(async () => [{ id: 'loc-a', name: 'Centro', code: 'CEN' }]),
      },
    };
  }

  it('filters inventory to locations where the same assignment grants REPORT_VIEW', async () => {
    const findMany = vi.fn(async (args) => {
      expect(args.where.branchId).toEqual({ in: ['loc-a'] });
      return [
        {
          id: 'inv-a',
          physical: 5n,
          reserved: 1n,
          branch: { id: 'loc-a', name: 'Centro', code: 'CEN' },
          variant: {
            id: 'variant-1',
            sku: 'REM-NEG-M',
            barcode: '7790000000001',
            color: 'Negro',
            size: 'M',
            price: 1000n,
            product: { id: 'product-1', name: 'Remera', slug: 'remera' },
          },
        },
      ];
    });
    const service = createBackofficeService(database(findMany, vi.fn(async () => 1)) as never);

    const result = await service.inventory(req() as never, {
      limit: 50,
      offset: 0,
    });

    expect(result.items).toEqual([
      expect.objectContaining({ id: 'inv-a', available: 4n }),
    ]);
  });

  it('rejects an explicit branch when REPORT_VIEW is held only by another assignment', async () => {
    const db = database();
    const service = createBackofficeService(db as never);

    await expect(
      service.inventory(req() as never, {
        branchId: 'loc-b',
        limit: 50,
        offset: 0,
      }),
    ).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect(db.inventory.findMany).not.toHaveBeenCalled();
  });

  it('filters the branch selector to REPORT_VIEW-qualified locations', async () => {
    const db = database();
    const service = createBackofficeService(db as never);

    await expect(service.branches(req() as never)).resolves.toEqual({
      items: [{ id: 'loc-a', name: 'Centro', code: 'CEN' }],
    });
    expect(db.branch.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['loc-a'] } },
      orderBy: [{ code: 'asc' }, { id: 'asc' }],
      select: { id: true, name: true, code: true, address: true, pointOfSaleNumber: true },
    });
  });
});
