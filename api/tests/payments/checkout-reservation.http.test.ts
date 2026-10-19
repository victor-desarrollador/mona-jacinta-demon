// R3-A4.3 S4 — HTTP boundary of the reservation routes and of
// GET /api/v1/checkout-attempts/recent. DB-free: the services are injected and
// recorded; supertest needs only the namespace-local loopback.
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { errorHandler } from '../../src/middleware/errorHandler.js';
import { createPaymentsRouter } from '../../src/modules/payments/payments.routes.js';
import { createCheckoutAttemptsRouter } from '../../src/modules/payments/checkout-attempts-recent.routes.js';
import type { CheckoutReservationService } from '../../src/modules/payments/checkout-reservation.service.js';
import type { CheckoutAttemptsRecentService } from '../../src/modules/payments/checkout-attempts-recent.service.js';
import { DEFAULT_ROLE_GRANTS } from '../../src/modules/rbac/role-permission-matrix.js';
import { AppError } from '../../src/shared/errors.js';

const BRANCH = 'a1b2c3d4-1111-4111-8111-11111111abcd';
const SALE = 'b2c3d4e5-2222-4222-8222-22222222bcde';
const SESSION = '44444444-4444-4444-8444-444444444444';
const RESERVE = 'c3d4e5f6-6666-4666-8666-66666666cdef';
const ENDPOINT = `/api/v1/sales/${SALE}/checkout/reservations`;

const body = (patch: Record<string, unknown> = {}) => ({
  reserveKey: RESERVE, cashSessionId: SESSION, balanceMethod: 'CASH', expectedTotal: '15000', expectedBalanceAmount: '15000',
  tenders: [{ method: 'CASH', role: 'BALANCE', source: 'NEW' }], ...patch,
});
const view = { reserveKey: RESERVE, operationKey: '77777777-7777-4777-8777-777777777777', status: 'RESERVED', plan: { expectedTotal: 15000n } };

function app(options: { role?: 'CASHIER' | 'SELLER'; reservation?: Partial<CheckoutReservationService>; recent?: Partial<CheckoutAttemptsRecentService> } = {}) {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const record = <T>(name: string, value: T) => async (...args: unknown[]) => { calls.push({ name, args }); return typeof value === 'function' ? (value as (...a: unknown[]) => unknown)(...args) : value; };
  const reservation = {
    reserve: record('reserve', { replayed: false, view }),
    listForSale: record('listForSale', { open: view, recent: [view] }),
    getForSale: record('getForSale', { view, checkout: null }),
    ...options.reservation,
  } as unknown as CheckoutReservationService;
  const recent = { recent: record('recent', { items: [] }), ...options.recent } as unknown as CheckoutAttemptsRecentService;
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    const role = options.role ?? 'CASHIER';
    req.auth = { userId: 'u1', roles: [role], effectiveLocationIds: [BRANCH],
      assignments: [{ roleId: role, roleCode: role, scopeKind: 'LOCATION', locationId: BRANCH, permissions: [...DEFAULT_ROLE_GRANTS[role]] }] } as never;
    next();
  });
  server.use('/api/v1/sales', createPaymentsRouter({} as PrismaClient, undefined, { checkoutReservationService: reservation }));
  server.use('/api/v1/checkout-attempts', createCheckoutAttemptsRouter({} as PrismaClient, { service: recent }));
  server.use(errorHandler);
  return { server, calls };
}

describe('R3-A4.3 S4 — reservation routes', () => {
  it('H01 POST → 201 for a new reservation, 200 for a replay; money serialised as strings; the parsed DTO reaches the service', async () => {
    const created = app();
    const response = await request(created.server).post(ENDPOINT).send(body());
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ reserveKey: RESERVE, plan: { expectedTotal: '15000' } });
    const [call] = created.calls;
    expect(call!.name).toBe('reserve');
    expect(call!.args[1]).toBe(SALE);
    expect(call!.args[2]).toMatchObject({ reserveKey: RESERVE, expectedTotal: 15000n, recovery: null });
    const replay = app({ reservation: { reserve: (async () => ({ replayed: true, view })) as never } });
    expect((await request(replay.server).post(ENDPOINT).send(body())).status).toBe(200);
  });

  it('H02 malformed bodies and params die at the edge with 400; the service is never called', async () => {
    for (const [path, payload] of [
      [ENDPOINT, body({ expectedTotal: 15000 })],
      [ENDPOINT, body({ tenders: [{ method: 'QR', role: 'BALANCE', source: 'NEW' }], balanceMethod: 'QR' })],
      [ENDPOINT, body({ branchId: BRANCH })],
      [`/api/v1/sales/${SALE.toUpperCase()}/checkout/reservations`, body()],
    ] as const) {
      const harness = app();
      expect((await request(harness.server).post(path).send(payload)).status).toBe(400);
      expect(harness.calls).toEqual([]);
    }
  });

  it('H03 the route gate is SALE_CHARGE (a SELLER is refused before the service); service AppErrors keep their status and code', async () => {
    const seller = app({ role: 'SELLER' });
    expect((await request(seller.server).post(ENDPOINT).send(body())).status).toBe(403);
    expect(seller.calls).toEqual([]);
    const open = app({ reservation: { reserve: (async () => { throw new AppError(409, 'CHECKOUT_RESERVATION_OPEN', 'x', { open: { reserveKey: RESERVE } }); }) as never } });
    const response = await request(open.server).post(ENDPOINT).send(body());
    expect(response.status).toBe(409);
    expect(response.body.error ?? response.body).toMatchObject({ code: 'CHECKOUT_RESERVATION_OPEN' });
  });

  it('H04 GET list and GET by reserveKey: canonical params, 200, the reserveKey param is forwarded', async () => {
    const harness = app();
    expect((await request(harness.server).get(ENDPOINT)).status).toBe(200);
    const one = await request(harness.server).get(`${ENDPOINT}/${RESERVE}`);
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ view: { reserveKey: RESERVE }, checkout: null });
    expect(harness.calls.map((call) => [call.name, call.args.slice(1)])).toEqual([
      ['listForSale', [SALE]],
      ['getForSale', [SALE, RESERVE]],
    ]);
    const bad = app();
    expect((await request(bad.server).get(`${ENDPOINT}/${RESERVE.toUpperCase()}`)).status).toBe(400);
    expect(bad.calls).toEqual([]);
  });

  it('H05 (R3-A4.3 S7-K) a recovery body (T-RR) → 201 for a fresh recovery reservation, 200 for its replay; the parsed recovery reaches the service', async () => {
    const recovery = { reason: 'el cobro externo quedó sin imputar', evidence: 'cupón 0042' };
    const fresh = app();
    const response = await request(fresh.server).post(ENDPOINT).send(body({ recovery }));
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ reserveKey: RESERVE });
    expect(fresh.calls.map((call) => call.args[2])).toMatchObject([{ reserveKey: RESERVE, recovery }]);
    const replay = app({ reservation: { reserve: (async () => ({ replayed: true, view })) as never } });
    expect((await request(replay.server).post(ENDPOINT).send(body({ recovery }))).status).toBe(200);
  });
});

describe('R3-A4.3 S4 — GET /api/v1/checkout-attempts/recent', () => {
  it('H10 parses branchId, scope, limit and since and forwards them; defaults limit 20 and since null', async () => {
    const harness = app();
    expect((await request(harness.server).get(`/api/v1/checkout-attempts/recent?branchId=${BRANCH}&scope=mine`)).status).toBe(200);
    expect((await request(harness.server).get(`/api/v1/checkout-attempts/recent?branchId=${BRANCH}&scope=branch&limit=50&since=2026-10-16T00:00:00.000Z`)).status).toBe(200);
    expect(harness.calls.map((call) => call.args[1])).toEqual([
      { branchId: BRANCH, scope: 'mine', limit: 20, since: null },
      { branchId: BRANCH, scope: 'branch', limit: 50, since: new Date('2026-10-16T00:00:00.000Z') },
    ]);
  });

  it('H11 invalid queries → 400 without reaching the service', async () => {
    for (const query of [
      `scope=mine`, `branchId=${BRANCH}`, `branchId=${BRANCH}&scope=all`, `branchId=${BRANCH.toUpperCase()}&scope=mine`,
      `branchId=${BRANCH}&scope=mine&limit=0`, `branchId=${BRANCH}&scope=mine&limit=51`, `branchId=${BRANCH}&scope=mine&limit=1.5`,
      `branchId=${BRANCH}&scope=mine&since=yesterday`, `branchId=${BRANCH}&scope=mine&extra=1`,
    ]) {
      const harness = app();
      expect((await request(harness.server).get(`/api/v1/checkout-attempts/recent?${query}`)).status, query).toBe(400);
      expect(harness.calls).toEqual([]);
    }
  });
});
