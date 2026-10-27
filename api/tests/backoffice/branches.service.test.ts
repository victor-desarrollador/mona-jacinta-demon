import { Prisma } from '../../src/generated/prisma/client.js';
import { describe, expect, it, vi } from 'vitest';
import { createBackofficeService } from '../../src/modules/backoffice/backoffice.service.js';

// DB-free contract for GET /backoffice/branches: only the Branch+Location rows
// the caller is authorized for, with Location type/state reported as-is and a
// missing Location surfaced explicitly instead of invented.
type Row = {
  id: string;
  name: string;
  code: string;
  address: string | null;
  pointOfSaleNumber: number | null;
  type: 'RETAIL_BRANCH' | 'CENTRAL_WAREHOUSE' | null;
  isActive: boolean | null;
};

const row = (overrides: Partial<Row> = {}): Row => ({
  id: 'b1',
  name: 'Local 1',
  code: 'L1',
  address: 'Dir',
  pointOfSaleNumber: 1,
  type: 'RETAIL_BRANCH',
  isActive: true,
  ...overrides,
});

function serviceWith(rows: Row[]) {
  const queryRaw = vi.fn().mockResolvedValue(rows);
  const service = createBackofficeService({ $queryRaw: queryRaw } as never);
  return { service, queryRaw };
}

const companyReq = (ids: string[]) =>
  ({
    auth: {
      userId: 'u1',
      roles: ['ADMIN'],
      effectiveLocationIds: ids,
      assignments: [
        { roleId: 'r', roleCode: 'ADMIN', scopeKind: 'COMPANY', locationId: null, permissions: ['REPORT_VIEW'] },
      ],
    },
  }) as never;

describe('backoffice branches()', () => {
  it('returns an empty list without touching the database when nothing is authorized', async () => {
    const { service, queryRaw } = serviceWith([]);
    expect(await service.branches(companyReq([]))).toEqual({ items: [] });
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('binds every authorized id as its own SQL parameter (never one comma-joined string)', async () => {
    const { service, queryRaw } = serviceWith([row()]);
    await service.branches(companyReq(['b1', 'b2', 'b3']));
    // Tagged template call: (strings, ...interpolations); the only interpolation
    // is the Prisma.join(...) fragment holding one bound value per id.
    const [, ids] = queryRaw.mock.calls[0]! as [TemplateStringsArray, Prisma.Sql];
    expect(ids).toBeInstanceOf(Prisma.Sql);
    expect(ids.values).toEqual(['b1', 'b2', 'b3']);
    expect(ids.sql).toBe('?,?,?');
  });

  it('reports Location type and state exactly as stored, including inactive', async () => {
    const { service } = serviceWith([
      row(),
      row({ id: 'b2', code: 'DEP', type: 'CENTRAL_WAREHOUSE', isActive: false }),
    ]);
    const { items } = await service.branches(companyReq(['b1', 'b2']));
    expect(items).toEqual([
      { id: 'b1', name: 'Local 1', code: 'L1', address: 'Dir', pointOfSaleNumber: 1, type: 'RETAIL_BRANCH', isActive: true, locationConsistency: 'consistent' },
      { id: 'b2', name: 'Local 1', code: 'DEP', address: 'Dir', pointOfSaleNumber: 1, type: 'CENTRAL_WAREHOUSE', isActive: false, locationConsistency: 'consistent' },
    ]);
  });

  it('flags a Branch without Location as missing_location and invents neither type nor state', async () => {
    const { service } = serviceWith([row({ type: null, isActive: null })]);
    const { items } = await service.branches(companyReq(['b1']));
    expect(items[0]).toMatchObject({ type: null, isActive: null, locationConsistency: 'missing_location' });
  });
});
