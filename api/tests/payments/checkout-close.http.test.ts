// R3-A4.3 S6 — HTTP boundary of POST
// /sales/:saleId/checkout/reservations/:reserveKey/close (T-X). DB-free: the
// close service is injected and recorded; the REAL router, validation,
// authorization and error middlewares run. The evidence HERE is the HTTP
// contract: canonical params/body, the SALE_CHARGE gate, BigInt money in and
// strings out, a fresh close and an identical replay both 200, and AppError ->
// status mapping. The service itself is covered by
// checkout-close.behavior.test.ts.
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { errorHandler } from '../../src/middleware/errorHandler.js';
import { createPaymentsRouter } from '../../src/modules/payments/payments.routes.js';
import type { CheckoutCloseService } from '../../src/modules/payments/checkout-close.service.js';
import { DEFAULT_ROLE_GRANTS } from '../../src/modules/rbac/role-permission-matrix.js';
import { AppError } from '../../src/shared/errors.js';

const BRANCH = 'a1b2c3d4-1111-4111-8111-11111111abcd';
const SALE = 'b2c3d4e5-2222-4222-8222-22222222bcde';
const RESERVE = 'c3d4e5f6-6666-4666-8666-66666666cdef';
const ENDPOINT = `/api/v1/sales/${SALE}/checkout/reservations/${RESERVE}/close`;

const body = (patch: Record<string, unknown> = {}) => ({ declarations: [{ method: 'CASH', outcome: 'NONE' }], ...patch });
const view = { reserveKey: RESERVE, operationKey: '77777777-7777-4777-8777-777777777777', status: 'ABANDONED', plan: { expectedTotal: 15000n } };

function app(options: { role?: 'CASHIER' | 'SELLER'; auth?: boolean; close?: Partial<CheckoutCloseService> } = {}) {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const record = <T>(name: string, value: T) => async (...args: unknown[]) => { calls.push({ name, args }); return typeof value === 'function' ? (value as (...a: unknown[]) => unknown)(...args) : value; };
  const close = { close: record('close', { replayed: false, view, checkout: null }), ...options.close } as unknown as CheckoutCloseService;
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    if (options.auth === false) { next(); return; }
    const role = options.role ?? 'CASHIER';
    req.auth = {
      userId: 'u1', roles: [role], effectiveLocationIds: [BRANCH],
      assignments: [{ roleId: role, roleCode: role, scopeKind: 'LOCATION', locationId: BRANCH, permissions: [...DEFAULT_ROLE_GRANTS[role]] }],
    } as never;
    next();
  });
  server.use('/api/v1/sales', createPaymentsRouter({} as PrismaClient, undefined, { checkoutCloseService: close }));
  server.use(errorHandler);
  return { server, calls };
}

describe('R3-A4.3 S6 — close route', () => {
  it('H60 POST → 200 (fresh) and 200 (identical replay); money out as strings; the parsed DTO reaches the service with BigInt', async () => {
    const created = app();
    const response = await request(created.server).post(ENDPOINT).send(body());
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ replayed: false, view: { status: 'ABANDONED', plan: { expectedTotal: '15000' } }, checkout: null });
    const [call] = created.calls;
    expect(call!.name).toBe('close');
    expect(call!.args[1]).toBe(SALE);
    expect(call!.args[2]).toBe(RESERVE);
    expect(call!.args[3]).toEqual({
      supervisor: null,
      declarations: [{
        method: 'CASH', outcome: 'NONE', returnedAmount: null, amount: null, reference: null,
        referenceKey: null, institution: null, institutionOther: null, evidence: null,
      }],
    });

    // The DTO turns a charged transfer into BigInt + a normalised referenceKey.
    const charged = app();
    expect((await request(charged.server).post(ENDPOINT).send(body({
      declarations: [{ method: 'TRANSFER', outcome: 'CHARGED', amount: '22000', reference: 'op-123', institution: 'GALICIA', evidence: 'cupon' }],
    }))).status).toBe(200);
    expect(charged.calls[0]!.args[3]).toMatchObject({
      declarations: [{ method: 'TRANSFER', outcome: 'CHARGED', amount: 22000n, reference: 'op-123', referenceKey: 'OP123', institution: 'GALICIA', evidence: 'cupon' }],
    });

    const replay = app({ close: { close: (async () => ({ replayed: true, view, checkout: null })) as never } });
    const replayed = await request(replay.server).post(ENDPOINT).send(body());
    expect(replayed.status).toBe(200);
    expect(replayed.body).toMatchObject({ replayed: true });
  });

  it('H61 malformed params and bodies die at the edge with 400; the service is never called', async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      [ENDPOINT, body({ declarations: [] })],
      [ENDPOINT, body({ declarations: [{ method: 'CASH', outcome: 'RETAINED' }] })],
      [ENDPOINT, body({ declarations: [{ method: 'TRANSFER', outcome: 'CHARGED', amount: '0', reference: 'OP1', institution: 'GALICIA', evidence: 'x' }] })],
      [ENDPOINT, body({ declarations: [{ method: 'TRANSFER', outcome: 'CHARGED', amount: '100', reference: 'OP1', evidence: 'x' }] })],
      [ENDPOINT, body({ declarations: [{ method: 'CASH', outcome: 'RETURNED', returnedAmount: '0', evidence: 'x' }] })],
      [ENDPOINT, body({ declarations: [{ method: 'CARD_DEBIT', outcome: 'CHARGED', amount: '100', reference: 'OP1', institution: 'GALICIA', evidence: 'x' }] })],
      [ENDPOINT, body({ declarations: [{ method: 'CASH', outcome: 'NONE' }, { method: 'CASH', outcome: 'NONE' }] })],
      [ENDPOINT, body({ declarations: [{ method: 'CASH', outcome: 'NONE', extra: 1 }] })],
      [ENDPOINT, body({ supervisor: { reason: 'corto' } })],
      [`/api/v1/sales/${SALE}/checkout/reservations/${RESERVE.toUpperCase()}/close`, body()],
      [`/api/v1/sales/${SALE.toUpperCase()}/checkout/reservations/${RESERVE}/close`, body()],
    ];
    for (const [path, payload] of cases) {
      const harness = app();
      expect((await request(harness.server).post(path).send(payload)).status).toBe(400);
      expect(harness.calls).toEqual([]);
    }
  });

  it('H62 the route gate is SALE_CHARGE (a SELLER is refused before the service); unauthenticated is 401; AppErrors keep status and code', async () => {
    const seller = app({ role: 'SELLER' });
    expect((await request(seller.server).post(ENDPOINT).send(body())).status).toBe(403);
    expect(seller.calls).toEqual([]);

    const anonymous = app({ auth: false });
    expect((await request(anonymous.server).post(ENDPOINT).send(body())).status).toBe(401);
    expect(anonymous.calls).toEqual([]);

    const busy = app({ close: { close: (async () => { throw new AppError(409, 'CHECKOUT_RESERVATION_BUSY', 'x'); }) as never } });
    const response = await request(busy.server).post(ENDPOINT).send(body());
    expect(response.status).toBe(409);
    expect(response.body.error ?? response.body).toMatchObject({ code: 'CHECKOUT_RESERVATION_BUSY' });

    const boom = app({ close: { close: (async () => { throw new Error('unexpected'); }) as never } });
    expect((await request(boom.server).post(ENDPOINT).send(body())).status).toBe(500);
  });

  it('H63 the close is POST-only, forwards the parsed params, and passes through a supervised request', async () => {
    const harness = app();
    expect((await request(harness.server).get(ENDPOINT)).status).toBe(404);
    const supervised = body({
      supervisor: { reason: 'motivo suficiente para la operación', evidence: 'cupon 1' },
      declarations: [{ method: 'CASH', outcome: 'NONE', evidence: 'cupon 1' }],
    });
    expect((await request(harness.server).post(ENDPOINT).send(supervised)).status).toBe(200);
    expect(harness.calls[0]!.args[3]).toMatchObject({
      supervisor: { reason: 'motivo suficiente para la operación', evidence: 'cupon 1' },
      declarations: [{ method: 'CASH', outcome: 'NONE', evidence: 'cupon 1' }],
    });
  });

  it('S6F-13 (HTTP) a request-borne cashSessionId is refused at the edge: 400, the service is never called', async () => {
    const harness = app();
    expect((await request(harness.server).post(ENDPOINT).send(body({ cashSessionId: 'd4e5f6a7-8888-4888-8888-88888888def0' }))).status).toBe(400);
    expect(harness.calls).toEqual([]);
  });
});
