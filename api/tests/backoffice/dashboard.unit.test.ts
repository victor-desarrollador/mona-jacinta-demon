import { describe, expect, it, vi } from 'vitest';
import { createBackofficeService } from '../../src/modules/backoffice/backoffice.service.js';
import { operatingDayBounds } from '../../src/shared/operating-time.js';

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

// P0-C: el dashboard debe usar el dia operativo de America/Argentina/Tucuman,
// no el corte a medianoche de la zona del servidor.
describe('backoffice dashboard uses operating day bounds (DB-free)', () => {
  it('salesToday and revenueToday are scoped to the operating day of the controlled instant', async () => {
    // Argentina 2026-10-22 00:30 = UTC 2026-10-22 03:30.
    const fixedNow = new Date(Date.UTC(2026, 9, 22, 3, 30, 0));
    const { start, end } = operatingDayBounds(fixedNow);

    const count = vi.fn(async () => 7);
    const aggregate = vi.fn(async () => ({ _sum: { total: 12345n } }));
    const database = {
      sale: { count, aggregate },
      inventory: { count: vi.fn(async () => 1) },
    } as never;

    const service = createBackofficeService(database);

    await service.dashboard(req() as never, fixedNow);

    // La venta de hoy y el ingreso de hoy usan el mismo intervalo [start, end).
    expect(count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdAt: expect.objectContaining({ gte: start, lt: end }),
        }),
      }),
    );
    expect(aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdAt: expect.objectContaining({ gte: start, lt: end }),
        }),
      }),
    );
  });

  it('defaults to the real clock when no instant is supplied', async () => {
    const count = vi.fn(async (_args: { where: { createdAt: { gte: Date } } }) => 0);
    const database = {
      sale: { count, aggregate: vi.fn(async () => ({ _sum: { total: null } })) },
      inventory: { count: vi.fn(async () => 0) },
    } as never;
    const service = createBackofficeService(database);

    // Debe ejecutarse sin instant (usa new Date() internamente) sin explotar.
    await service.dashboard(req() as never);
    // count se invoca dos veces (salesToday y pendingSalesCount).
    expect(count).toHaveBeenCalledTimes(2);
    const startArg = count.mock.calls[0]![0].where.createdAt.gte as Date;
    expect(startArg).toBeInstanceOf(Date);
  });
});
