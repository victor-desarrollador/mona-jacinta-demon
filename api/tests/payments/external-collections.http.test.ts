// R3-A4.3 S-REF — HTTP boundary of POST /api/v1/external-collections/:id/refund
// (T-F) and GET /api/v1/external-collections. DB-free: the service is injected
// and recorded; the REAL router, validation, authorization and error
// middlewares run. The evidence HERE is the HTTP contract: canonical params,
// the .strict() body (no amount), BigInt money in and out as strings, the
// refundReference/reason bounds of the OWNER decision (3..64 raw, 10..500),
// the trimmed values reaching the service, the GET query parsing and the
// AppError -> status mapping. The service logic lives in
// external-collections.behavior.test.ts.
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { errorHandler } from '../../src/middleware/errorHandler.js';
import { createExternalCollectionsRouter } from '../../src/modules/payments/external-collections.routes.js';
import type { ExternalCollectionsService } from '../../src/modules/payments/external-collections.service.js';
import { DEFAULT_ROLE_GRANTS } from '../../src/modules/rbac/role-permission-matrix.js';
import { AppError } from '../../src/shared/errors.js';

const BRANCH = 'a1b2c3d4-1111-4111-8111-11111111abcd';
const EC = 'd4e5f6a7-8888-4888-8888-88888888def0';
const REFUND = `/api/v1/external-collections/${EC}/refund`;
const LIST = '/api/v1/external-collections';

const view = {
  id: EC, branchId: BRANCH, method: 'TRANSFER', amount: 25000n, reference: 'OP 123', referenceKey: 'OP123',
  institution: 'GALICIA', institutionOther: null, status: 'REFUNDED', originSaleId: null, originAttemptId: null,
  cashSessionId: null, recordedById: 'u1', recordedAt: new Date('2026-10-16T12:00:00.000Z'),
  resolvedById: 'u1', resolvedAt: new Date('2026-10-16T12:00:00.000Z'), refundReference: 'REF-001',
  resolutionNote: 'devolución acordada con el cliente', externalRefundedAt: new Date('2026-10-16T11:59:00.000Z'),
};

const body = (patch: Record<string, unknown> = {}) => ({
  refundReference: 'REF-001',
  externalRefundedAt: '2026-10-16T11:59:00.000Z',
  reason: 'devolución acordada con el cliente',
  ...patch,
});

function app(options: { role?: 'CASHIER' | 'SELLER' | 'ADMIN'; auth?: boolean; service?: Partial<ExternalCollectionsService> } = {}) {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const record = <T>(name: string, value: T) => async (...args: unknown[]) => { calls.push({ name, args }); return typeof value === 'function' ? (value as (...a: unknown[]) => unknown)(...args) : value; };
  const service = {
    refund: record('refund', { replayed: false, collection: view }),
    list: record('list', { items: [view] }),
    ...options.service,
  } as unknown as ExternalCollectionsService;
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    // Mirrors the real composition: app.ts mounts createRequireAuth before this
    // router, so an unauthenticated request never reaches it (401 first).
    if (options.auth === false) { next(new AppError(401, 'UNAUTHORIZED', 'Se requiere autenticación.')); return; }
    const role = options.role ?? 'CASHIER';
    req.auth = {
      userId: 'u1', roles: [role], effectiveLocationIds: [BRANCH],
      assignments: [{ roleId: role, roleCode: role, scopeKind: 'LOCATION', locationId: BRANCH, permissions: [...DEFAULT_ROLE_GRANTS[role]] }],
    } as never;
    next();
  });
  server.use('/api/v1/external-collections', createExternalCollectionsRouter({} as PrismaClient, { service }));
  server.use(errorHandler);
  return { server, calls };
}

describe('R3-A4.3 S-REF — refund route', () => {
  it('REF-H-01 POST → 200 fresh and 200 replay; the parsed DTO reaches the service; BigInt out as a string', async () => {
    const created = app();
    const response = await request(created.server).post(REFUND).send(body());
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ replayed: false, collection: { id: EC, status: 'REFUNDED', amount: '25000' } });
    const [call] = created.calls;
    expect(call!.name).toBe('refund');
    expect(call!.args[1]).toBe(EC);
    expect(call!.args[2]).toEqual({
      refundReference: 'REF-001',
      externalRefundedAt: new Date('2026-10-16T11:59:00.000Z'),
      reason: 'devolución acordada con el cliente',
    });

    const replay = app({ service: { refund: (async () => ({ replayed: true, collection: view })) as never } });
    expect((await request(replay.server).post(REFUND).send(body())).status).toBe(200);
  });

  it('REF-H-02 the route forwards a trimmed raw reference and reason; the canonical form is never sent by the client', async () => {
    const harness = app();
    expect((await request(harness.server).post(REFUND).send(body({ refundReference: '  op-123  ', reason: '  motivo de devolución válido  ' }))).status).toBe(200);
    expect(harness.calls[0]!.args[2]).toMatchObject({ refundReference: 'op-123', reason: 'motivo de devolución válido' });
    expect(harness.calls[0]!.args[2]).not.toHaveProperty('refundReferenceKey');
  });

  it('REF-H-03 malformed params (uppercase UUID / non-UUID) die at the edge with 400 and the service is never called', async () => {
    for (const path of [`/api/v1/external-collections/${EC.toUpperCase()}/refund`, '/api/v1/external-collections/not-a-uuid/refund']) {
      const harness = app();
      expect((await request(harness.server).post(path).send(body())).status).toBe(400);
      expect(harness.calls).toEqual([]);
    }
  });

  it('REF-H-04 the body is strict: an extra field (amount included) is a 400 and never reaches the service', async () => {
    for (const patch of [{ amount: '25000' }, { refundReference: 'REF-001', externalRefundedAt: '2026-10-16T11:59:00.000Z', reason: 'devolución acordada con el cliente', extra: 1 }, {}]) {
      const harness = app();
      expect((await request(harness.server).post(REFUND).send(patch)).status).toBe(400);
      expect(harness.calls).toEqual([]);
    }
  });

  it('REF-H-05 refundReference: 2 and 65 code points are 400; 3 and 64 are 200; a 3-char raw with a 2-char canonical is 400', async () => {
    const rejected = ['AB', 'A'.repeat(65), 'a-b'];
    for (const refundReference of rejected) {
      const harness = app();
      expect((await request(harness.server).post(REFUND).send(body({ refundReference }))).status, refundReference).toBe(400);
      expect(harness.calls).toEqual([]);
    }
    for (const refundReference of ['ABC', 'A'.repeat(64)]) {
      const harness = app();
      expect((await request(harness.server).post(REFUND).send(body({ refundReference }))).status, refundReference).toBe(200);
      expect(harness.calls[0]!.args[2]).toMatchObject({ refundReference });
    }
  });

  it('REF-H-06 reason: 9 and 501 code points are 400; 10 and 500 are 200', async () => {
    for (const reason of ['a'.repeat(9), 'a'.repeat(501)]) {
      const harness = app();
      expect((await request(harness.server).post(REFUND).send(body({ reason }))).status, String(reason.length)).toBe(400);
      expect(harness.calls).toEqual([]);
    }
    for (const reason of ['a'.repeat(10), 'a'.repeat(500)]) {
      const harness = app();
      expect((await request(harness.server).post(REFUND).send(body({ reason }))).status, String(reason.length)).toBe(200);
    }
  });

  it('REF-H-07 the OWNER bound is 64, not REFERENCE_KEY 40: a 41..64 alphanumeric reference is accepted', async () => {
    const harness = app();
    expect((await request(harness.server).post(REFUND).send(body({ refundReference: 'B'.repeat(41) }))).status).toBe(200);
    expect(harness.calls[0]!.args[2]).toMatchObject({ refundReference: 'B'.repeat(41) });
  });

  it('REF-H-08 a malformed externalRefundedAt is a 400 and never reaches the service', async () => {
    for (const externalRefundedAt of ['ayer', '2026-10-16', '', 1700000000]) {
      const harness = app();
      expect((await request(harness.server).post(REFUND).send(body({ externalRefundedAt }))).status, String(externalRefundedAt)).toBe(400);
      expect(harness.calls).toEqual([]);
    }
  });

  // S-REF.1 (A2): the timestamp is validated STRICTLY. Date.parse alone silently
  // normalises impossible values (2026-02-30 -> 2026-03-02, 24:00:00 -> next
  // day 00:00), which would let a date that never existed reach the service.
  it('SREF-F06 an impossible calendar day is 400 and never reaches the service', async () => {
    for (const externalRefundedAt of ['2026-02-30T00:00:00Z', '2026-04-31T00:00:00Z', '2026-02-29T00:00:00Z', '2026-13-01T00:00:00Z', '2026-00-10T00:00:00Z']) {
      const harness = app();
      expect((await request(harness.server).post(REFUND).send(body({ externalRefundedAt }))).status, externalRefundedAt).toBe(400);
      expect(harness.calls).toEqual([]);
    }
  });

  it('SREF-F07 24:00:00 and other impossible clock components are 400 and never reach the service', async () => {
    for (const externalRefundedAt of ['2026-01-01T24:00:00Z', '2026-01-01T00:60:00Z', '2026-01-01T00:00:61Z', '2026-01-01T00:00:00+24:00']) {
      const harness = app();
      expect((await request(harness.server).post(REFUND).send(body({ externalRefundedAt }))).status, externalRefundedAt).toBe(400);
      expect(harness.calls).toEqual([]);
    }
  });

  it('SREF-F08 a valid leap day is accepted and reaches the service as its exact instant', async () => {
    const harness = app();
    const response = await request(harness.server).post(REFUND).send(body({ externalRefundedAt: '2024-02-29T10:00:00Z' }));
    expect(response.status).toBe(200);
    expect(harness.calls[0]!.args[2]).toMatchObject({ externalRefundedAt: new Date('2024-02-29T10:00:00.000Z') });
  });

  it('SREF-F09 a valid offset timestamp is accepted and normalised to the exact instant, never re-interpreted', async () => {
    const harness = app();
    const response = await request(harness.server).post(REFUND).send(body({ externalRefundedAt: '2026-10-16T08:59:00-03:00' }));
    expect(response.status).toBe(200);
    expect(harness.calls[0]!.args[2]).toMatchObject({ externalRefundedAt: new Date('2026-10-16T11:59:00.000Z') });
  });

  it('SREF-F17 a valid but future timestamp is forwarded as a Date; the future refusal keeps its code at the edge', async () => {
    const forwarded = app();
    expect((await request(forwarded.server).post(REFUND).send(body({ externalRefundedAt: '2027-01-01T00:00:00Z' }))).status).toBe(200);
    expect(forwarded.calls[0]!.args[2]).toMatchObject({ externalRefundedAt: new Date('2027-01-01T00:00:00.000Z') });

    const future = app({ service: { refund: (async () => { throw new AppError(400, 'EXTERNAL_REFUND_DATE_IN_FUTURE', 'x'); }) as never } });
    const response = await request(future.server).post(REFUND).send(body({ externalRefundedAt: '2027-01-01T00:00:00Z' }));
    expect(response.status).toBe(400);
    expect(response.body.error ?? response.body).toMatchObject({ code: 'EXTERNAL_REFUND_DATE_IN_FUTURE' });
  });

  it('REF-H-09 unauthenticated is 401; the refund is POST-only', async () => {
    const anonymous = app({ auth: false });
    expect((await request(anonymous.server).post(REFUND).send(body())).status).toBe(401);
    expect((await request(anonymous.server).get(REFUND)).status).toBe(401);
    expect(anonymous.calls).toEqual([]);
    const harness = app();
    expect((await request(harness.server).get(REFUND)).status).toBe(404);
  });

  it('REF-H-10 AppErrors keep status and code; an unexpected error is 500', async () => {
    const applied = app({ service: { refund: (async () => { throw new AppError(409, 'EXTERNAL_COLLECTION_ALREADY_APPLIED', 'x'); }) as never } });
    const response = await request(applied.server).post(REFUND).send(body());
    expect(response.status).toBe(409);
    expect(response.body.error ?? response.body).toMatchObject({ code: 'EXTERNAL_COLLECTION_ALREADY_APPLIED' });

    const forbidden = app({ service: { refund: (async () => { throw new AppError(403, 'FORBIDDEN', 'x'); }) as never } });
    expect((await request(forbidden.server).post(REFUND).send(body())).status).toBe(403);

    const boom = app({ service: { refund: (async () => { throw new Error('unexpected'); }) as never } });
    expect((await request(boom.server).post(REFUND).send(body())).status).toBe(500);
  });

  it('REF-H-16 a 400 from the edge never echoes the rejected value back', async () => {
    const tooLong = 'S'.repeat(65);
    const refund = app();
    const response = await request(refund.server).post(REFUND).send(body({ refundReference: tooLong }));
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).not.toContain(tooLong);

    const listing = app();
    const query = await request(listing.server).get(`${LIST}?branchId=secret-not-a-uuid`);
    expect(query.status).toBe(400);
    expect(JSON.stringify(query.body)).not.toContain('secret-not-a-uuid');
    expect(refund.calls.concat(listing.calls)).toEqual([]);
  });
});

describe('R3-A4.3 S-REF — listing route', () => {
  it('REF-H-11 GET parses branchId/status/limit (default 100) and forwards them; the items carry BigInt money as strings', async () => {
    const harness = app();
    const plain = await request(harness.server).get(`${LIST}?branchId=${BRANCH}`);
    expect(plain.status).toBe(200);
    expect(plain.body.items[0]).toMatchObject({ id: EC, amount: '25000' });
    const filtered = await request(harness.server).get(`${LIST}?branchId=${BRANCH}&status=UNAPPLIED&limit=100`);
    expect(filtered.status).toBe(200);
    expect(harness.calls.map((call) => call.args[1])).toEqual([
      { branchId: BRANCH, status: null, limit: 100 },
      { branchId: BRANCH, status: 'UNAPPLIED', limit: 100 },
    ]);
  });

  it('REF-H-12 an invalid listing query is a 400 and never reaches the service', async () => {
    for (const query of ['', `branchId=${BRANCH.toUpperCase()}`, 'branchId=' + BRANCH + '&status=DONE', `branchId=${BRANCH}&limit=0`, `branchId=${BRANCH}&limit=101`, `branchId=${BRANCH}&limit=1.5`, `branchId=${BRANCH}&extra=1`]) {
      const harness = app();
      expect((await request(harness.server).get(`${LIST}?${query}`)).status, query).toBe(400);
      expect(harness.calls).toEqual([]);
    }
  });

  it('REF-H-13 the listing is GET-only and an AppError from the service keeps its status', async () => {
    const harness = app();
    expect((await request(harness.server).post(LIST).send({})).status).toBe(404);
    const forbidden = app({ service: { list: (async () => { throw new AppError(403, 'FORBIDDEN', 'x'); }) as never } });
    const response = await request(forbidden.server).get(`${LIST}?branchId=${BRANCH}`);
    expect(response.status).toBe(403);
    expect(response.body.error ?? response.body).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('REF-H-14 unauthenticated is 401 and the service is never called', async () => {
    const anonymous = app({ auth: false });
    expect((await request(anonymous.server).get(`${LIST}?branchId=${BRANCH}`)).status).toBe(401);
    expect(anonymous.calls).toEqual([]);
  });

  it('REF-H-15 a SELLER without any branch authority is refused by the service (403)', async () => {
    const seller = app({ role: 'SELLER', service: { list: (async () => { throw new AppError(403, 'FORBIDDEN', 'x'); }) as never } });
    expect((await request(seller.server).get(`${LIST}?branchId=${BRANCH}`)).status).toBe(403);
  });

  it('REF-H-17 only the two method/path pairs exist: every other pair is 404 and the service is never called', async () => {
    const harness = app();
    const probes = await Promise.all([
      request(harness.server).post(LIST).send({}),
      request(harness.server).patch(REFUND).send({}),
      request(harness.server).put(REFUND).send({}),
      request(harness.server).delete(REFUND).send({}),
      request(harness.server).get(REFUND),
      request(harness.server).post(`/api/v1/external-collections/${EC}`).send({}),
    ]);
    for (const response of probes) expect(response.status).toBe(404);
    expect(harness.calls).toEqual([]);
  });
});
