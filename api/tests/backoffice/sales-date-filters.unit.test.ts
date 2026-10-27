import { describe, expect, it, vi } from 'vitest';
import { createBackofficeService } from '../../src/modules/backoffice/backoffice.service.js';
import { parseOperatingDate } from '../../src/shared/operating-time.js';

function req() {
  return {
    auth: {
      userId: 'user-1',
      roles: ['ADMIN'],
      effectiveLocationIds: ['loc-a'],
      assignments: [
        {
          roleId: 'admin-role',
          roleCode: 'ADMIN',
          scopeKind: 'LOCATION',
          locationId: 'loc-a',
          permissions: ['REPORT_VIEW'],
        },
      ],
    },
  };
}

// P0-C: GET /backoffice/sales dateFrom/dateTo.
//
// dateFrom="YYYY-MM-DD" -> gte = inicio del día de negocio en
// America/Argentina/Tucuman.
// dateTo="YYYY-MM-DD"   -> lt  = inicio del día siguiente (exclusivo),
// nunca 23:59:59.999.
// Los timestamps ISO (Date) siguen pasando tal cual (contrato histórico).
describe('backoffice sales date filters (P0-C)', () => {
  function databaseWithCapturedWhere() {
    const findMany = vi.fn(async (_args?: unknown) => []);
    const database = {
      sale: { findMany },
      branch: { findMany: vi.fn(async () => []) },
    } as never;
    return { database, findMany };
  }

  function createdAtOf(findMany: ReturnType<typeof vi.fn>): unknown {
    const call = findMany.mock.calls[0]!;
    const args = call[0] as { where?: { createdAt?: unknown } } | undefined;
    return args?.where?.createdAt;
  }

  it('dateFrom business day -> gte equals start of that day in Tucuman', async () => {
    const { database, findMany } = databaseWithCapturedWhere();
    const service = createBackofficeService(database);

    await service.listSales(req() as never, {
      dateFrom: '2026-10-21',
      limit: 50,
      offset: 0,
    });

    expect(findMany).toHaveBeenCalledTimes(1);
    const createdAt = createdAtOf(findMany);
    const expectedStart = parseOperatingDate('2026-10-21').start;
    expect(createdAt).toMatchObject({ gte: expectedStart });
  });

  it('dateTo business day -> lt equals start of the next day in Tucuman (exclusive)', async () => {
    const { database, findMany } = databaseWithCapturedWhere();
    const service = createBackofficeService(database);

    await service.listSales(req() as never, {
      dateTo: '2026-10-21',
      limit: 50,
      offset: 0,
    });

    expect(findMany).toHaveBeenCalledTimes(1);
    const createdAt = createdAtOf(findMany);
    const expectedEnd = parseOperatingDate('2026-10-21').end;
    expect(createdAt).toMatchObject({ lt: expectedEnd });
    expect((createdAt as { lte?: unknown }).lte).toBeUndefined();
  });

  it('same day range selects only that business day [start, end)', async () => {
    const { database, findMany } = databaseWithCapturedWhere();
    const service = createBackofficeService(database);

    await service.listSales(req() as never, {
      dateFrom: '2026-10-21',
      dateTo: '2026-10-21',
      limit: 50,
      offset: 0,
    });

    expect(findMany).toHaveBeenCalledTimes(1);
    const createdAt = createdAtOf(findMany);
    const { start, end } = parseOperatingDate('2026-10-21');
    expect(createdAt).toMatchObject({ gte: start, lt: end });
    expect((createdAt as { lte?: unknown }).lte).toBeUndefined();
  });

  it('ISO timestamp dateFrom passes through unchanged (historical contract)', async () => {
    const iso = new Date(Date.UTC(2026, 9, 21, 10, 0, 0));
    const { database, findMany } = databaseWithCapturedWhere();
    const service = createBackofficeService(database);

    await service.listSales(req() as never, {
      dateFrom: iso,
      limit: 50,
      offset: 0,
    });

    const createdAt = createdAtOf(findMany);
    expect(createdAt).toMatchObject({ gte: iso });
  });

  it('ISO timestamp dateTo passes through unchanged (inclusive lte)', async () => {
    const iso = new Date(Date.UTC(2026, 9, 21, 23, 59, 59, 999));
    const { database, findMany } = databaseWithCapturedWhere();
    const service = createBackofficeService(database);

    await service.listSales(req() as never, {
      dateTo: iso,
      limit: 50,
      offset: 0,
    });

    const createdAt = createdAtOf(findMany);
    expect(createdAt).toMatchObject({ lte: iso });
  });

  it('invalid dateFrom throws', async () => {
    const { database } = databaseWithCapturedWhere();
    const service = createBackofficeService(database);

    await expect(
      service.listSales(req() as never, {
        dateFrom: '2026-02-30',
        limit: 50,
        offset: 0,
      }),
    ).rejects.toThrow(/Fecha de negocio invalida/);
  });

  it('invalid dateTo format throws', async () => {
    const { database } = databaseWithCapturedWhere();
    const service = createBackofficeService(database);

    await expect(
      service.listSales(req() as never, {
        dateTo: '21-10-2026',
        limit: 50,
        offset: 0,
      }),
    ).rejects.toThrow(/Fecha de negocio invalida/);
  });

  it('arbitrary text date throws', async () => {
    const { database } = databaseWithCapturedWhere();
    const service = createBackofficeService(database);

    await expect(
      service.listSales(req() as never, {
        dateFrom: 'texto-arbitrario',
        limit: 50,
        offset: 0,
      }),
    ).rejects.toThrow(/Fecha de negocio invalida/);
  });
});
