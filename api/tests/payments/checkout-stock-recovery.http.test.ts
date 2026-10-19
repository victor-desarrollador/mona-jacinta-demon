// R3-A4.3 S7-G — HTTP boundary of POST /sales/:saleId/checkout/stock-recovery
// (T-S). DB-free: the stock-recovery service is injected and recorded; the REAL
// payments router, validation, authorization and error middlewares run. The
// evidence HERE is the HTTP contract: the canonical params, the strict DTO, the
// SALE_CHARGE route gate (an edge defence only — the service's supervisor
// predicate stays the authority), 200 for a changed and an unchanged recovery,
// BigInt out as strings, and AppErrors passed through untouched. The service is
// covered by checkout-stock-recovery.behavior.test.ts.
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { errorHandler } from '../../src/middleware/errorHandler.js';
import { createPaymentsRouter } from '../../src/modules/payments/payments.routes.js';
import type { CheckoutStockRecoveryService } from '../../src/modules/payments/checkout-stock-recovery.service.js';
import { DEFAULT_ROLE_GRANTS } from '../../src/modules/rbac/role-permission-matrix.js';
import { AppError } from '../../src/shared/errors.js';

const BRANCH = 'a1b2c3d4-1111-4111-8111-11111111abcd';
const SALE = 'b2c3d4e5-2222-4222-8222-22222222bcde';
const RESERVE = 'c3d4e5f6-6666-4666-8666-66666666cdef';
const ENDPOINT = `/api/v1/sales/${SALE}/checkout/stock-recovery`;
const REASON = 'el posnet tardó y la reserva venció';
const EVIDENCE = 'cupón 0042';

const body = (patch: Record<string, unknown> = {}) => ({ reserveKey: RESERVE, reason: REASON, evidence: EVIDENCE, ...patch });
const view = { reserveKey: RESERVE, status: 'RESERVED', stockState: 'VALID', plan: { expectedTotal: 13000n } };

function app(options: { role?: 'CASHIER' | 'SELLER'; auth?: boolean; recover?: CheckoutStockRecoveryService['recover'] } = {}) {
  const calls: unknown[][] = [];
  const service = {
    recover: async (...args: unknown[]) => {
      calls.push(args);
      return options.recover ? (options.recover as (...a: unknown[]) => unknown)(...args) : { changed: true, view };
    },
  } as unknown as CheckoutStockRecoveryService;
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
  server.use('/api/v1/sales', createPaymentsRouter({} as PrismaClient, undefined, { checkoutStockRecoveryService: service }));
  server.use(errorHandler);
  return { server, calls };
}

describe('R3-A4.3 S7-G — stock-recovery route', () => {
  it('TS-H01 POST is mounted: 200, and the service receives the request, the path saleId and the parsed, trimmed DTO', async () => {
    const harness = app();
    const response = await request(harness.server).post(ENDPOINT).send(body({ reason: `  ${REASON}  `, evidence: ` ${EVIDENCE} ` }));
    expect(response.status).toBe(200);
    expect(harness.calls).toHaveLength(1);
    const [req, saleId, dto] = harness.calls[0]!;
    expect((req as { auth: { userId: string } }).auth.userId).toBe('u1');
    expect(saleId).toBe(SALE);
    expect(dto).toEqual({ reserveKey: RESERVE, reason: REASON, evidence: EVIDENCE });
  });

  it('TS-H02 an unauthenticated request is 401 and never reaches the service', async () => {
    const anonymous = app({ auth: false });
    expect((await request(anonymous.server).post(ENDPOINT).send(body())).status).toBe(401);
    expect(anonymous.calls).toEqual([]);
  });

  it('TS-H03 the DTO is strict: a missing, malformed or uppercase reserveKey, an extra field or a bad saleId is 400 and the service is never called', async () => {
    const withoutKey: Record<string, unknown> = body();
    delete withoutKey.reserveKey;
    const cases: Array<[string, Record<string, unknown>]> = [
      [ENDPOINT, withoutKey],
      [ENDPOINT, body({ reserveKey: 'not-a-uuid' })],
      [ENDPOINT, body({ reserveKey: RESERVE.toUpperCase() })],
      // A UUID that is not v4 (version nibble 1): the canonical DTO refuses it.
      [ENDPOINT, body({ reserveKey: 'c3d4e5f6-6666-1666-8666-66666666cdef' })],
      [ENDPOINT, body({ variants: [] })],
      [`/api/v1/sales/${SALE.toUpperCase()}/checkout/stock-recovery`, body()],
    ];
    for (const [path, payload] of cases) {
      const harness = app();
      expect((await request(harness.server).post(path).send(payload)).status, JSON.stringify(payload)).toBe(400);
      expect(harness.calls).toEqual([]);
    }
  });

  it('TS-H04 reason is 10..500 and evidence 3..200 code points AFTER trim', async () => {
    const statusOf = async (payload: Record<string, unknown>) => {
      const harness = app();
      return { status: (await request(harness.server).post(ENDPOINT).send(body(payload))).status, calls: harness.calls };
    };
    expect((await statusOf({ reason: 'x'.repeat(9) })).status).toBe(400);
    expect((await statusOf({ reason: 'x'.repeat(10) })).status).toBe(200);
    expect((await statusOf({ reason: 'x'.repeat(500) })).status).toBe(200);
    expect((await statusOf({ reason: 'x'.repeat(501) })).status).toBe(400);
    expect((await statusOf({ evidence: 'x'.repeat(2) })).status).toBe(400);
    expect((await statusOf({ evidence: 'x'.repeat(3) })).status).toBe(200);
    expect((await statusOf({ evidence: 'x'.repeat(200) })).status).toBe(200);
    expect((await statusOf({ evidence: 'x'.repeat(201) })).status).toBe(400);
    // Padding does not count: 9 characters padded with spaces are still 9.
    expect((await statusOf({ reason: `   ${'x'.repeat(9)}   ` })).status).toBe(400);
    expect((await statusOf({ evidence: `   ${'x'.repeat(2)}   ` })).status).toBe(400);
    const padded = await statusOf({ reason: `   ${'x'.repeat(10)}   `, evidence: '  abc  ' });
    expect(padded.status).toBe(200);
    expect(padded.calls[0]![2]).toMatchObject({ reason: 'x'.repeat(10), evidence: 'abc' });
  });

  it('TS-H05 both a changed and an unchanged recovery are 200 with { changed, view }; BigInt in the view leaves as a string', async () => {
    for (const changed of [true, false]) {
      const harness = app({ recover: (async () => ({ changed, view })) as never });
      const response = await request(harness.server).post(ENDPOINT).send(body());
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ changed, view: { reserveKey: RESERVE, status: 'RESERVED', stockState: 'VALID', plan: { expectedTotal: '13000' } } });
    }
  });

  it('TS-H06 domain AppErrors pass through untouched: status, code and details', async () => {
    const cases: AppError[] = [
      new AppError(404, 'NOT_FOUND', 'No se encontró la reserva de cobro.'),
      new AppError(403, 'FORBIDDEN', 'No cuenta con acceso a esta sucursal.'),
      new AppError(409, 'STOCK_RECOVERY_NOT_APPLICABLE', 'x'),
      new AppError(409, 'INSUFFICIENT_STOCK', 'No hay stock disponible suficiente para la variante.', { variantId: 'var-1' }),
      new AppError(409, 'CONCURRENCY_ERROR', 'x'),
      new AppError(500, 'CHECKOUT_STATE_INCONSISTENT', 'x'),
      new AppError(500, 'CHECKOUT_PLAN_INCONSISTENT', 'x'),
    ];
    for (const error of cases) {
      const harness = app({ recover: (async () => { throw error; }) as never });
      const response = await request(harness.server).post(ENDPOINT).send(body());
      expect(response.status, error.code).toBe(error.status);
      expect(response.body.error, error.code).toMatchObject({ code: error.code, ...(error.details ? { details: error.details } : {}) });
    }
    const boom = app({ recover: (async () => { throw new Error('unexpected'); }) as never });
    expect((await request(boom.server).post(ENDPOINT).send(body())).status).toBe(500);
  });

  it('TS-H07 two distinct layers: no SALE_CHARGE is 403 at the route gate (service never called); SALE_CHARGE passes the gate and the service still applies its stricter supervisor check', async () => {
    const seller = app({ role: 'SELLER' });
    expect((await request(seller.server).post(ENDPOINT).send(body())).status).toBe(403);
    expect(seller.calls).toEqual([]);

    // A CASHIER holds SALE_CHARGE: the edge lets it through, the service refuses.
    const cashier = app({ recover: (async () => { throw new AppError(403, 'FORBIDDEN', 'No cuenta con acceso a esta sucursal.'); }) as never });
    const response = await request(cashier.server).post(ENDPOINT).send(body());
    expect(response.status).toBe(403);
    expect(cashier.calls).toHaveLength(1);
  });

  it('TS-H08 a 400 from the edge never echoes the rejected values back', async () => {
    const secrets = { reserveKey: 'secret-reserve-key-value', reason: 'secreto', evidence: 'S'.repeat(201) };
    const harness = app();
    const response = await request(harness.server).post(ENDPOINT).send(body(secrets));
    expect(response.status).toBe(400);
    const text = JSON.stringify(response.body);
    for (const value of Object.values(secrets)) expect(text).not.toContain(value);
    expect(harness.calls).toEqual([]);
  });

  it('TS-H09 the stock recovery is POST-only', async () => {
    const harness = app();
    expect((await request(harness.server).get(ENDPOINT)).status).toBe(404);
    expect(harness.calls).toEqual([]);
  });
});
