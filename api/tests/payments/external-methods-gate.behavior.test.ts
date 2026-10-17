// R3-A4.3 S-REF.2 — P40 (the PROPORTIONAL_EXTERNAL_METHODS_ENABLED gate) and
// C-01 (the gate is injected, and fails closed at EVERY boundary), DB-FREE.
//
// P40 previously proved only that a NEW TRANSFER tender is refused at the direct
// reservation factory. This suite covers the COMPLETE set of surfaces with the
// gate at `false`, and runs the chain through the REAL wiring
// (parseEnv -> createPaymentsRouter option -> controller -> service -> HTTP, and
// the REAL external-collections router), never a hand-built service alone:
//   P40-01 quote: TRANSFER/CARD_DEBIT unavailable + the recorded candidates hid;
//   P40-02 T-R NEW TRANSFER      -> 409 PAYMENT_METHOD_NOT_ENABLED;
//   P40-03 T-R NEW CARD_DEBIT     -> 409 PAYMENT_METHOD_NOT_ENABLED;
//   P40-04 T-R COLLECTION         -> 409 PAYMENT_METHOD_NOT_ENABLED, untouched;
//   P40-05 CASH still allowed;
//   P40-06 the refund and the branch listing stay available (never gated).
//
// C-01: removing a gate-propagation step must break a test. The controller and
// router boundaries are driven WITHOUT the option (fail-closed) AND WITH an
// explicit `true` (so a dropped propagation is RED, not silently green). No
// grep/comment evidence: every assertion observes runtime behaviour over HTTP.
//
// The double (tests/helpers/checkout-reservation-fake-db.ts) is NOT PostgreSQL:
// the F1–F6 triggers, the CHECKs and the real locks are proven only by the
// opt-in *.pg.test.ts files. What it proves here is the service/controller/
// router composition and the gate value that reaches it.
import { randomUUID } from 'node:crypto';
import express from 'express';
import supertest from 'supertest';
import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { parseEnv } from '../../src/config/env.js';
import { errorHandler } from '../../src/middleware/errorHandler.js';
import { validate } from '../../src/middleware/validation.js';
import { DEFAULT_ROLE_GRANTS } from '../../src/modules/rbac/role-permission-matrix.js';
import { computeProportionalQuote } from '../../src/modules/pricing/proportional-checkout.js';
import type { PlanTenderInput } from '../../src/modules/payments/checkout-canonical.js';
import { createCheckoutQuoteController } from '../../src/modules/payments/checkout-quote.controller.js';
import { createCheckoutReservationController } from '../../src/modules/payments/checkout-reservation.controller.js';
import { createExternalCollectionsRouter } from '../../src/modules/payments/external-collections.routes.js';
import { createPaymentsRouter } from '../../src/modules/payments/payments.routes.js';
import { checkoutQuoteRequestDto } from '../../src/modules/payments/dto/checkout-quote.dto.js';
import { checkoutReservationDto } from '../../src/modules/payments/dto/checkout-reservation.dto.js';
import { createCheckoutReservationFakeDb } from '../helpers/checkout-reservation-fake-db.js';

// The minimum accepted environment, the SAME shape tests/env.test.ts uses.
// PROPORTIONAL_EXTERNAL_METHODS_ENABLED is deliberately ABSENT: the env default
// is exactly what C-01-04 puts under test.
const ENV_BASE = {
  DATABASE_URL: 'postgresql://test:test@demo.invalid:5432/bootstrap',
  TEST_DATABASE_URL: 'postgresql://test:test@test.invalid:5432/bootstrap',
  JWT_SECRET: 'synthetic-test-key-not-for-real-authentication',
  JWT_ACCESS_TTL_SECONDS: '900',
  CORS_ORIGINS: 'http://localhost:3000',
};

type Role = 'CASHIER' | 'ADMIN' | 'OWNER';

function auth(userId: string, role: Role, branchId: string | null): unknown {
  const permissions = role === 'CASHIER' ? [...DEFAULT_ROLE_GRANTS.CASHIER] : role === 'ADMIN' ? [...DEFAULT_ROLE_GRANTS.ADMIN] : [];
  return {
    userId, roles: [role], effectiveLocationIds: branchId ? [branchId] : [],
    assignments: [{ roleId: role, roleCode: role, scopeKind: branchId ? 'LOCATION' : 'COMPANY', locationId: branchId, permissions }],
  };
}

const CASH_TENDER: PlanTenderInput = { method: 'CASH', role: 'BALANCE', source: 'NEW', amount: null, externalCollectionId: null };
const newTender = (method: 'TRANSFER' | 'CARD_DEBIT', amount: bigint): PlanTenderInput[] =>
  [CASH_TENDER, { method, role: 'FIXED', source: 'NEW', amount, externalCollectionId: null }];
const collectionTender = (id: string, amount: bigint): PlanTenderInput[] =>
  [CASH_TENDER, { method: 'TRANSFER', role: 'FIXED', source: 'COLLECTION', amount, externalCollectionId: id }];

const OFF_METHODS = [
  { method: 'CASH', available: true },
  { method: 'TRANSFER', available: false, reason: 'PAYMENT_METHOD_NOT_ENABLED' },
  { method: 'CARD_DEBIT', available: false, reason: 'PAYMENT_METHOD_NOT_ENABLED' },
];
const ON_METHODS = [
  { method: 'CASH', available: true },
  { method: 'TRANSFER', available: true },
  { method: 'CARD_DEBIT', available: true },
];

function setup(options: { withCandidate?: boolean } = {}) {
  const db = createCheckoutReservationFakeDb();
  const branch = randomUUID();
  const cashier = db.insert('user', { id: randomUUID(), name: 'Caja 1' });
  const companyId = db.insert('company', { id: randomUUID(), createdAt: new Date(0) }).id as string;
  db.insert('companyPricingConfig', {
    id: randomUUID(), companyId, updatedAt: new Date('2026-10-01T00:00:00Z'), listAdjustmentBps: 0,
    creditCardAdjustmentBps: 0, debitCardAdjustmentBps: 300, bankTransferAdjustmentBps: 200, qrAdjustmentBps: 0,
  });
  const register = db.insert('cashRegister', { id: randomUUID(), branchId: branch });
  const session = db.insert('cashSession', { id: randomUUID(), registerId: register.id, status: 'OPEN' });
  const sale = db.insert('sale', {
    id: randomUUID(), branchId: branch, status: 'PENDING_PAYMENT', saleNumber: 'B-0001', pricingMode: 'LIST', priceMode: 'CASH',
    pricingModel: 'PROPORTIONAL_V1', paymentStartedAt: null, wholesaleConfirmedAt: null, wholesaleConfirmedById: null, updatedAt: new Date(0),
  });
  const items = [
    db.insert('saleItem', { id: randomUUID(), saleId: sale.id, variantId: 'v1', sku: 'SKU1', quantity: 2n, baseUnitPrice: 5000n, priceMode: 'CASH', priceBaseType: 'LIST' }),
    db.insert('saleItem', { id: randomUUID(), saleId: sale.id, variantId: 'v2', sku: 'SKU2', quantity: 1n, baseUnitPrice: 5000n, priceMode: 'CASH', priceBaseType: 'LIST' }),
  ];
  // A hold well into the future: the router builds the real service with its own
  // real clock, so the hold must not be expired when a real CASH reservation runs.
  const holdExpires = new Date(Date.now() + 365 * 24 * 60 * 60_000);
  for (const item of items) {
    db.insert('stockReservation', { id: randomUUID(), saleId: sale.id, variantId: item.variantId, branchId: branch, quantity: item.quantity, status: 'ACTIVE', expiresAt: holdExpires });
  }
  const candidate = options.withCandidate
    ? db.insert('externalCollection', {
      id: randomUUID(), branchId: branch, method: 'TRANSFER', amount: 5000n, status: 'UNAPPLIED', claimAttemptId: null,
      reference: 'OP 88001', referenceKey: 'OP88001', institution: 'GALICIA', institutionOther: null, originSaleId: sale.id,
    })
    : null;
  const client = db.client as unknown as PrismaClient;
  const lines = items.map((item) => ({ saleItemId: item.id as string, sku: item.sku as string, quantity: item.quantity as bigint, baseUnitPrice: item.baseUnitPrice as bigint }));
  const pricing = { bankTransferAdjustmentBps: 200, debitCardAdjustmentBps: 300 };
  const base = (tenders: PlanTenderInput[]) => {
    const balance = tenders.find((tender) => tender.role === 'BALANCE')!.method;
    const quote = computeProportionalQuote({
      lines, pricing, balanceMethod: balance,
      tenders: tenders.filter((tender) => tender.role === 'FIXED').map((tender) => ({ method: tender.method, amount: tender.amount! })),
    });
    return {
      reserveKey: randomUUID(), cashSessionId: session.id as string, balanceMethod: balance,
      expectedTotal: quote.total, expectedBalanceAmount: quote.balance.amount, tenders, recovery: null,
    };
  };
  return {
    db, client, branch, candidate,
    saleId: sale.id as string, asCashier: auth(cashier.id as string, 'CASHIER', branch), owner: auth(cashier.id as string, 'OWNER', null),
    base,
  };
}

const reserveBody = (input: ReturnType<ReturnType<typeof setup>['base']>) => ({
  reserveKey: input.reserveKey, cashSessionId: input.cashSessionId, balanceMethod: input.balanceMethod,
  expectedTotal: input.expectedTotal.toString(), expectedBalanceAmount: input.expectedBalanceAmount.toString(),
  tenders: input.tenders.map((tender) => ({
    method: tender.method, role: tender.role, source: tender.source,
    ...(tender.amount === null ? {} : { amount: tender.amount.toString() }),
    ...(tender.externalCollectionId === null ? {} : { externalCollectionId: tender.externalCollectionId }),
  })),
  ...(input.recovery === null ? {} : { recovery: input.recovery }),
});

function buildApp(mounts: Array<[string, express.Router]>, authContext: unknown) {
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    (req as { auth?: unknown }).auth = authContext;
    next();
  });
  for (const [path, router] of mounts) server.use(path, router);
  server.use(errorHandler);
  return server;
}

// The REAL payments router, exactly as app.ts composes it (the option is the
// only difference from production).
const paymentsApp = (t: ReturnType<typeof setup>, externalMethodsEnabled: boolean) =>
  buildApp([['/api/v1/sales', createPaymentsRouter(t.client, undefined, { externalMethodsEnabled })]], t.asCashier);
// The REAL payments router built WITHOUT the option at all (C-01-03).
const barePaymentsApp = (t: ReturnType<typeof setup>) => buildApp([['/api/v1/sales', createPaymentsRouter(t.client)]], t.asCashier);

const quote = (app: express.Express, saleId: string, body: object = { balanceMethod: 'CASH', tenders: [] }) =>
  supertest(app).post(`/api/v1/sales/${saleId}/checkout/quote`).send(body);
const reserve = (app: express.Express, saleId: string, body: object) =>
  supertest(app).post(`/api/v1/sales/${saleId}/checkout/reservations`).send(body);

// ---------------------------------------------------------------------------
// P40 — the complete set of surfaces with the gate at false.
// ---------------------------------------------------------------------------
describe('P40 — PROPORTIONAL_EXTERNAL_METHODS_ENABLED=false across every surface', () => {
  it('P40-01 the quote (real router) marks TRANSFER/CARD_DEBIT unavailable with PAYMENT_METHOD_NOT_ENABLED and hides the recorded candidates', async () => {
    const t = setup({ withCandidate: true });
    const response = await quote(paymentsApp(t, false), t.saleId);
    expect(response.status).toBe(200);
    expect(response.body.enabledMethods).toEqual(OFF_METHODS);
    // The sale HAS an UNAPPLIED candidate; the gate OFF never offers it.
    expect(response.body.unappliedCollections).toEqual([]);
  });

  it('P40-02 a NEW TRANSFER tender (real router) is 409 PAYMENT_METHOD_NOT_ENABLED and writes nothing', async () => {
    const t = setup();
    const response = await reserve(paymentsApp(t, false), t.saleId, reserveBody(t.base(newTender('TRANSFER', 3000n))));
    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: { code: 'PAYMENT_METHOD_NOT_ENABLED', message: expect.any(String) } });
    expect(t.db.table('checkoutAttempt')).toEqual([]);
  });

  it('P40-03 a NEW CARD_DEBIT tender (real router) is 409 PAYMENT_METHOD_NOT_ENABLED and writes nothing', async () => {
    const t = setup();
    const response = await reserve(paymentsApp(t, false), t.saleId, reserveBody(t.base(newTender('CARD_DEBIT', 3000n))));
    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: { code: 'PAYMENT_METHOD_NOT_ENABLED', message: expect.any(String) } });
    expect(t.db.table('checkoutAttempt')).toEqual([]);
  });

  it('P40-04 consuming a recorded COLLECTION (real router) is 409 PAYMENT_METHOD_NOT_ENABLED and the collection is untouched', async () => {
    const t = setup({ withCandidate: true });
    const response = await reserve(paymentsApp(t, false), t.saleId, reserveBody(t.base(collectionTender(t.candidate!.id as string, 5000n))));
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('PAYMENT_METHOD_NOT_ENABLED');
    expect(t.db.table('externalCollection')[0]).toMatchObject({ status: 'UNAPPLIED', claimAttemptId: null });
    expect(t.db.table('checkoutAttempt')).toEqual([]);
  });

  it('P40-05 CASH stays allowed with the gate OFF (real router, 201 RESERVED)', async () => {
    const t = setup();
    const response = await reserve(paymentsApp(t, false), t.saleId, reserveBody(t.base([CASH_TENDER])));
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(response.body.status).toBe('RESERVED');
    expect(t.db.table('checkoutAttempt')[0]).toMatchObject({ status: 'RESERVED', tenderCount: 1 });
  });

  it('P40-06 the refund and the branch listing are never gated (real external-collections router), while the gate is OFF', async () => {
    const t = setup({ withCandidate: true });
    const app = buildApp([['/api/v1/external-collections', createExternalCollectionsRouter(t.client)]], t.owner);
    const refund = await supertest(app)
      .post(`/api/v1/external-collections/${String(t.candidate!.id)}/refund`)
      .send({ refundReference: 'REF-2020-1', externalRefundedAt: '2020-01-01T00:00:00.000Z', reason: 'devolución de prueba acordada' });
    expect(refund.status, JSON.stringify(refund.body)).toBe(200);
    expect(refund.body.replayed).toBe(false);
    const list = await supertest(app).get('/api/v1/external-collections').query({ branchId: t.branch });
    expect(list.status).toBe(200);
    expect((list.body.items as Array<{ id: string }>).map((item) => item.id)).toContain(t.candidate!.id);
  });
});

// ---------------------------------------------------------------------------
// C-01 — the gate is INJECTED; an omitted option fails closed at every boundary,
// and a dropped propagation turns a test RED.
// ---------------------------------------------------------------------------
describe('C-01 — every boundary fails closed and every propagation is observable', () => {
  const quoteControllerApp = (client: PrismaClient, option?: { externalMethodsEnabled?: boolean }) => {
    const controller = createCheckoutQuoteController(client, option);
    const router = express.Router();
    router.post('/:saleId/checkout/quote', validate(checkoutQuoteRequestDto), controller.quote);
    return router;
  };
  const reservationControllerApp = (client: PrismaClient, option?: { externalMethodsEnabled?: boolean }) => {
    const controller = createCheckoutReservationController(client, option);
    const router = express.Router();
    router.post('/:saleId/checkout/reservations', validate(checkoutReservationDto), controller.reserve);
    return router;
  };

  it('C-01-01 the quote controller WITHOUT the option is OFF; WITH an explicit true it is ON', async () => {
    const off = setup();
    const offResponse = await quote(buildApp([['/api/v1/sales', quoteControllerApp(off.client)]], off.asCashier), off.saleId);
    expect(offResponse.status).toBe(200);
    expect(offResponse.body.enabledMethods).toEqual(OFF_METHODS);

    const on = setup();
    const onResponse = await quote(buildApp([['/api/v1/sales', quoteControllerApp(on.client, { externalMethodsEnabled: true })]], on.asCashier), on.saleId);
    expect(onResponse.status).toBe(200);
    expect(onResponse.body.enabledMethods).toEqual(ON_METHODS);
  });

  it('C-01-02 the reservation controller WITHOUT the option is OFF; WITH an explicit true it is ON', async () => {
    const off = setup();
    const offResponse = await reserve(buildApp([['/api/v1/sales', reservationControllerApp(off.client)]], off.asCashier), off.saleId, reserveBody(off.base(newTender('TRANSFER', 3000n))));
    expect(offResponse.status).toBe(409);
    expect(offResponse.body.error.code).toBe('PAYMENT_METHOD_NOT_ENABLED');

    const on = setup();
    const onResponse = await reserve(buildApp([['/api/v1/sales', reservationControllerApp(on.client, { externalMethodsEnabled: true })]], on.asCashier), on.saleId, reserveBody(on.base(newTender('TRANSFER', 3000n))));
    expect(onResponse.status, JSON.stringify(onResponse.body)).toBe(201);
    expect(onResponse.body.status).toBe('RESERVED');
  });

  it('C-01-03 the payments router WITHOUT the option is OFF; WITH an explicit true it is ON', async () => {
    const off = setup();
    const offQuote = await quote(barePaymentsApp(off), off.saleId);
    expect(offQuote.body.enabledMethods).toEqual(OFF_METHODS);
    const offReserve = await reserve(barePaymentsApp(off), off.saleId, reserveBody(off.base(newTender('TRANSFER', 3000n))));
    expect(offReserve.status).toBe(409);
    expect(offReserve.body.error.code).toBe('PAYMENT_METHOD_NOT_ENABLED');

    const on = setup();
    const onQuote = await quote(paymentsApp(on, true), on.saleId);
    expect(onQuote.body.enabledMethods).toEqual(ON_METHODS);
    const onReserve = await reserve(paymentsApp(on, true), on.saleId, reserveBody(on.base(newTender('TRANSFER', 3000n))));
    expect(onReserve.status, JSON.stringify(onReserve.body)).toBe(201);
  });

  it('C-01-04 parseEnv without the variable is false and drives the router to fail closed; an explicit true enables it', async () => {
    // The env default IS the value app.ts injects.
    expect(parseEnv({ ...ENV_BASE }).PROPORTIONAL_EXTERNAL_METHODS_ENABLED).toBe(false);
    expect(parseEnv({ ...ENV_BASE, PROPORTIONAL_EXTERNAL_METHODS_ENABLED: 'true' }).PROPORTIONAL_EXTERNAL_METHODS_ENABLED).toBe(true);

    // parseEnv -> router option -> controller -> service -> HTTP, exactly as
    // app.ts composes it with env.PROPORTIONAL_EXTERNAL_METHODS_ENABLED.
    const off = setup();
    const gateOff = parseEnv({ ...ENV_BASE }).PROPORTIONAL_EXTERNAL_METHODS_ENABLED;
    const offQuote = await quote(paymentsApp(off, gateOff), off.saleId);
    expect(offQuote.body.enabledMethods).toEqual(OFF_METHODS);

    const on = setup();
    const gateOn = parseEnv({ ...ENV_BASE, PROPORTIONAL_EXTERNAL_METHODS_ENABLED: 'true' }).PROPORTIONAL_EXTERNAL_METHODS_ENABLED;
    const onQuote = await quote(paymentsApp(on, gateOn), on.saleId);
    expect(onQuote.body.enabledMethods).toEqual(ON_METHODS);
  });
});
