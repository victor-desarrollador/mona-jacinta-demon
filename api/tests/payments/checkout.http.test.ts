// R3-A3.3 — HTTP integration of the proportional checkout, DB-FREE suite.
//
// The REAL payments router runs on a bare Express app with the real validation,
// authorization and error middlewares (never a re-implementation). Only two
// collaborators are replaced, both at the edges of this slice:
//   * `req.auth`            — the JWT/DB-backed auth middleware is not in scope;
//   * the CheckoutService   — injected through the router's options, plus the
//                             single `Sale.branchId` read the controller makes
//                             to route its post-commit notification.
// The checkout service itself is already covered by checkout.behavior.test.ts
// (59 cases); the evidence HERE is the HTTP contract: DTO shape and centavos,
// 201/200, the SALE_CHARGE gate, AppError -> status mapping, and the rule that
// a notification is emitted only AFTER the service resolved on a committed
// checkout — never on a replay, a rejection or a rollback.
//
// FIDELITY LIMITS: no Prisma engine, no pg Pool, no network. The DTO rules
// asserted here are the boundary mirror of the service's structural checks; the
// database CHECK constraints and the real P2002 races stay PostgreSQL-only and
// are NOT proven here.
import { readFileSync } from 'node:fs';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { errorHandler } from '../../src/middleware/errorHandler.js';
import { AppError } from '../../src/shared/errors.js';
import { createPaymentsRouter } from '../../src/modules/payments/payments.routes.js';
import {
  checkoutConfirmationDto,
  checkoutConfirmationParamsDto,
  checkoutRequestDto,
} from '../../src/modules/payments/dto/checkout.dto.js';
import type {
  CheckoutResult,
  CheckoutService,
} from '../../src/modules/payments/checkout.service.js';
import { DEFAULT_ROLE_GRANTS } from '../../src/modules/rbac/role-permission-matrix.js';
import type { RealtimeEmitter, RealtimePayload } from '../../src/realtime/socket.js';

const ROUTES_SOURCE = readFileSync(new URL('../../src/modules/payments/payments.routes.ts', import.meta.url), 'utf8');
const CHECKOUT_ROUTE_BLOCK =
  ROUTES_SOURCE.match(/router\.post\(\s*'\/:saleId\/checkout',[\s\S]*?\n {2}\);/)?.[0] ?? '';
const CONTROLLER_SOURCE = readFileSync(new URL('../../src/modules/payments/checkout.controller.ts', import.meta.url), 'utf8');

const BRANCH = '11111111-1111-4111-8111-111111111111';
const OTHER_BRANCH = '99999999-9999-4999-8999-999999999999';
const SALE = '22222222-2222-4222-8222-222222222222';
const OPERATION_KEY = '33333333-3333-4333-8333-333333333333';
const CASH_SESSION = '44444444-4444-4444-8444-444444444444';
const COLLECTION = '55555555-5555-4555-8555-555555555555';
const ENDPOINT = `/api/v1/sales/${SALE}/checkout`;
const RESERVE_KEY = '66666666-6666-4666-8666-666666666666';

type CheckoutArgs = Parameters<CheckoutService['checkout']>;
type Role = 'CASHIER' | 'SELLER' | 'WAREHOUSE';

// ---------------------------------------------------------------------------
// Wire fixtures
// ---------------------------------------------------------------------------

// A5-style content: CASH 20037 (cents) + TRANSFER fixed 11000 + CARD_DEBIT
// balance. Money travels as decimal centavo strings, never as Number.
function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    operationKey: OPERATION_KEY,
    cashSessionId: CASH_SESSION,
    balanceMethod: 'CARD_DEBIT',
    expectedTotal: '42037',
    expectedBalanceAmount: '22000',
    tenders: [
      { method: 'CASH', role: 'FIXED', amount: '20037', receivedAmount: '20037' },
      { method: 'TRANSFER', role: 'FIXED', amount: '11000', reference: 'OP 88123', institution: 'GALICIA' },
      { method: 'CARD_DEBIT', role: 'BALANCE', reference: 'D009' },
    ],
    ...overrides,
  };
}

function withTenders(tenders: unknown[]): Record<string, unknown> {
  return validBody({ tenders });
}

function confirmationBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    reserveKey: RESERVE_KEY,
    operationKey: OPERATION_KEY,
    tenders: [
      { method: 'CASH', receivedAmount: '42000' },
    ],
    ...overrides,
  };
}

function rejected(body: unknown): boolean {
  return checkoutRequestDto.safeParse(body).success === false;
}

function result(overrides: Partial<CheckoutResult> = {}): CheckoutResult {
  return {
    saleId: SALE,
    saleNumber: 'S-0001',
    status: 'COMPLETED',
    checkoutId: 'checkout-1',
    replayed: false,
    total: 42037n,
    changeAmount: 0n,
    payments: [
      {
        id: 'pay-1', method: 'CASH', tenderRole: 'FIXED', amount: 20037n, methodFullPrice: 20037n,
        adjustmentBps: 0, externalCollectionId: null, receivedAmount: 20037n, changeAmount: 0n,
      },
    ],
    lines: [{ saleItemId: 'item-1', sku: 'SKU-1', quantity: 1n, finalAmount: 42037n }],
    completedAt: new Date('2026-10-16T12:00:00.000Z'),
    ...overrides,
  };
}

function auth(role: Role, locationId: string): Express.AuthContext {
  return {
    userId: 'user-1',
    roles: [role],
    assignments: [
      { roleId: role, roleCode: role, scopeKind: 'LOCATION', locationId, permissions: [...DEFAULT_ROLE_GRANTS[role]] },
    ],
    effectiveLocationIds: [locationId],
  };
}

// ---------------------------------------------------------------------------
// Harness: real router + real middlewares, fake auth/service/branch read.
// ---------------------------------------------------------------------------
type Harness = {
  app: ReturnType<typeof express>;
  calls: CheckoutArgs[];
  events: Array<{ event: string; payload: RealtimePayload }>;
  setResult: (value: CheckoutResult | Error) => void;
  setBranch: (value: string | null) => void;
  failBranchRead: () => void;
  failNotify: () => void;
};

function harness(options: { auth?: Express.AuthContext | null } = {}): Harness {
  const calls: CheckoutArgs[] = [];
  const events: Array<{ event: string; payload: RealtimePayload }> = [];
  let outcome: CheckoutResult | Error = result();
  let branch: string | null = BRANCH;
  let branchReadFails = false;
  let notifyFails = false;

  const service = {
    checkout: async (...args: CheckoutArgs) => {
      calls.push(args);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  } as unknown as CheckoutService;

  const realtime: RealtimeEmitter = {
    emit: (event, payload) => {
      if (notifyFails) throw new Error('socket down');
      events.push({ event, payload });
    },
  };

  const database = {
    sale: {
      findFirst: async () => {
        if (branchReadFails) throw new Error('branch lookup down');
        return branch === null ? null : { branchId: branch };
      },
    },
  } as unknown as PrismaClient;

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    // `auth: null` models an unauthenticated caller of a private route.
    if (options.auth !== null) req.auth = options.auth ?? auth('CASHIER', BRANCH);
    next();
  });
  app.use('/api/v1/sales', createPaymentsRouter(database, realtime, { checkoutService: service }));
  app.use(errorHandler);

  return {
    app,
    calls,
    events,
    setResult: (value) => { outcome = value; },
    setBranch: (value) => { branch = value; },
    failBranchRead: () => { branchReadFails = true; },
    failNotify: () => { notifyFails = true; },
  };
}

// ---------------------------------------------------------------------------
// A. DTO: shape, centavos, uuids, references (pure, no HTTP)
// ---------------------------------------------------------------------------
describe('R3 checkout DTO', () => {
  it('A1 the valid body parses into the exact CheckoutRequest the service consumes', () => {
    expect(checkoutRequestDto.parse(validBody())).toEqual({
      operationKey: OPERATION_KEY,
      cashSessionId: CASH_SESSION,
      balanceMethod: 'CARD_DEBIT',
      expectedTotal: 42037n,
      expectedBalanceAmount: 22000n,
      tenders: [
        {
          method: 'CASH', role: 'FIXED', amount: 20037n, receivedAmount: 20037n,
          reference: null, institution: null, institutionOther: null, externalCollectionId: null,
        },
        {
          method: 'TRANSFER', role: 'FIXED', amount: 11000n, receivedAmount: null,
          reference: 'OP 88123', institution: 'GALICIA', institutionOther: null, externalCollectionId: null,
        },
        {
          method: 'CARD_DEBIT', role: 'BALANCE', amount: null, receivedAmount: null,
          reference: 'D009', institution: null, institutionOther: null, externalCollectionId: null,
        },
      ],
    });
  });

  it('A2 centavos are exact BigInt cents on every method, never a Number', () => {
    const parsed = checkoutRequestDto.parse(validBody({
      tenders: [
        { method: 'CASH', role: 'FIXED', amount: '20037', receivedAmount: '20050' },
        { method: 'TRANSFER', role: 'FIXED', amount: '11001', reference: 'OP 88123', institution: 'GALICIA' },
        { method: 'CARD_DEBIT', role: 'BALANCE', reference: 'D009' },
      ],
    }));
    expect(parsed.tenders.map((tender) => tender.amount)).toEqual([20037n, 11001n, null]);
    expect(parsed.tenders[0]!.receivedAmount).toBe(20050n);
    expect(typeof parsed.tenders[0]!.amount).toBe('bigint');
  });

  it('A3 an external collection replaces the reference and cannot be repeated', () => {
    expect(checkoutRequestDto.parse(validBody({
      tenders: [
        { method: 'CASH', role: 'FIXED', amount: '10000', receivedAmount: '10000' },
        { method: 'TRANSFER', role: 'FIXED', amount: '11000', externalCollectionId: COLLECTION },
        { method: 'CARD_DEBIT', role: 'BALANCE', reference: 'D009' },
      ],
    })).tenders[1]).toEqual({
      method: 'TRANSFER', role: 'FIXED', amount: 11000n, receivedAmount: null,
      reference: null, institution: null, institutionOther: null, externalCollectionId: COLLECTION,
    });
  });

  it('A4 a 64-code-point reference (astral characters) is valid, 65 is not', () => {
    const at64 = `ABC${'👍'.repeat(61)}`;
    const at65 = `ABC${'👍'.repeat(62)}`;
    expect([...at64]).toHaveLength(64);
    expect(rejected(withTenders([
      { method: 'CASH', role: 'FIXED', amount: '10000', receivedAmount: '10000' },
      { method: 'CARD_DEBIT', role: 'BALANCE', reference: at64 },
    ]))).toBe(false);
    expect(rejected(withTenders([
      { method: 'CASH', role: 'FIXED', amount: '10000', receivedAmount: '10000' },
      { method: 'CARD_DEBIT', role: 'BALANCE', reference: at65 },
    ]))).toBe(true);
  });

  it.each([
    ['an operationKey that is not a UUID', { operationKey: 'not-a-uuid' }],
    ['an operationKey that is not version 4', { operationKey: '123e4567-e89b-12d3-a456-426614174000' }],
    ['a cashSessionId that is not a UUID', { cashSessionId: 'nope' }],
    ['a balanceMethod outside CASH/TRANSFER/CARD_DEBIT', { balanceMethod: 'CARD_CREDIT' }],
    ['a QR balanceMethod', { balanceMethod: 'QR' }],
    ['an expectedTotal that is not an integer string', { expectedTotal: '42037.00' }],
    ['an expectedBalanceAmount with a sign', { expectedBalanceAmount: '-1' }],
    ['a leading zero in expectedTotal', { expectedTotal: '042037' }],
    ['an unknown top-level field', { branchId: BRANCH }],
    ['no tenders', { tenders: [] }],
    ['a tender outside CASH/TRANSFER/CARD_DEBIT', { tenders: [{ method: 'QR', role: 'BALANCE', reference: 'D009' }] }],
  ])('A5 rejects %s', (_label, overrides) => {
    expect(rejected(validBody(overrides))).toBe(true);
  });

  it.each([
    ['a decimal amount', [{ method: 'CASH', role: 'FIXED', amount: '100.50', receivedAmount: '100.50' }]],
    ['an exponent amount', [{ method: 'CASH', role: 'FIXED', amount: '1e3', receivedAmount: '1e3' }]],
    ['a negative amount', [{ method: 'CASH', role: 'FIXED', amount: '-100', receivedAmount: '-100' }]],
    ['a zero fixed amount', [{ method: 'CASH', role: 'FIXED', amount: '0', receivedAmount: '0' }]],
    ['a fixed amount missing', [{ method: 'CASH', role: 'FIXED', receivedAmount: '100' }]],
    ['cash without receivedAmount', [{ method: 'CASH', role: 'FIXED', amount: '100' }]],
    ['cash received below the amount', [{ method: 'CASH', role: 'FIXED', amount: '100', receivedAmount: '99' }]],
    ['cash carrying a reference', [{ method: 'CASH', role: 'FIXED', amount: '100', receivedAmount: '100', reference: 'OP 1' }]],
    ['cash carrying an institution', [{ method: 'CASH', role: 'FIXED', amount: '100', receivedAmount: '100', institution: 'GALICIA' }]],
    ['cash carrying an external collection', [{ method: 'CASH', role: 'FIXED', amount: '100', receivedAmount: '100', externalCollectionId: COLLECTION }]],
    ['a balance tender carrying an amount', [{ method: 'CARD_DEBIT', role: 'BALANCE', amount: '100', reference: 'D009' }]],
    ['a receivedAmount outside cash', [{ method: 'TRANSFER', role: 'FIXED', amount: '100', reference: 'OP 1', institution: 'GALICIA', receivedAmount: '100' }]],
    ['an unknown tender field', [{ method: 'CARD_DEBIT', role: 'BALANCE', reference: 'D009', priceMode: 'CASH' }]],
  ])('A6 rejects tenders with %s', (_label, tenders) => {
    expect(rejected(withTenders(tenders as unknown[]))).toBe(true);
  });

  it.each([
    ['no balance tender', [
      { method: 'CASH', role: 'FIXED', amount: '100', receivedAmount: '100' },
      { method: 'TRANSFER', role: 'FIXED', amount: '100', reference: 'OP 1', institution: 'GALICIA' },
    ]],
    ['two balance tenders', [
      { method: 'CASH', role: 'BALANCE', receivedAmount: '100' },
      { method: 'TRANSFER', role: 'BALANCE', reference: 'OP 1', institution: 'GALICIA' },
    ]],
    ['a balance tender of another method', [
      { method: 'CASH', role: 'BALANCE', receivedAmount: '100' },
      { method: 'TRANSFER', role: 'BALANCE', reference: 'OP 1', institution: 'GALICIA' },
    ]],
    ['a repeated method', [
      { method: 'CASH', role: 'FIXED', amount: '100', receivedAmount: '100' },
      { method: 'CASH', role: 'BALANCE', receivedAmount: '100' },
    ]],
  ])('A7 rejects %s', (_label, tenders) => {
    expect(rejected(withTenders(tenders as unknown[]))).toBe(true);
  });

  it.each([
    ['a reference AND an external collection', { method: 'TRANSFER', role: 'FIXED', amount: '100', reference: 'OP 1', institution: 'GALICIA', externalCollectionId: COLLECTION }],
    ['neither a reference nor an external collection', { method: 'TRANSFER', role: 'FIXED', amount: '100', institution: 'GALICIA' }],
    ['an external collection on the balance tender', { method: 'CARD_DEBIT', role: 'BALANCE', externalCollectionId: COLLECTION }],
    ['an external collection plus an institution', { method: 'TRANSFER', role: 'FIXED', amount: '100', externalCollectionId: COLLECTION, institution: 'GALICIA' }],
    ['a reference whose normalised key is too short', { method: 'CARD_DEBIT', role: 'BALANCE', reference: 'A!B' }],
    ['a reference with no alphanumerics', { method: 'CARD_DEBIT', role: 'BALANCE', reference: '  ' }],
    ['a transfer without institution', { method: 'TRANSFER', role: 'BALANCE', reference: 'OP 1' }],
    ['an unknown institution', { method: 'TRANSFER', role: 'BALANCE', reference: 'OP 1', institution: 'HSBC' }],
    ['OTHER without a name', { method: 'TRANSFER', role: 'BALANCE', reference: 'OP 1', institution: 'OTHER' }],
    ['OTHER with a blank name', { method: 'TRANSFER', role: 'BALANCE', reference: 'OP 1', institution: 'OTHER', institutionOther: '   ' }],
    ['a named institution plus institutionOther', { method: 'TRANSFER', role: 'BALANCE', reference: 'OP 1', institution: 'GALICIA', institutionOther: 'Banco X' }],
    ['a debit carrying an institution', { method: 'CARD_DEBIT', role: 'BALANCE', reference: 'D009', institution: 'GALICIA' }],
    ['a debit carrying institutionOther', { method: 'CARD_DEBIT', role: 'BALANCE', reference: 'D009', institutionOther: 'Banco X' }],
  ])('A8 rejects a reference/institution conflict: %s', (_label, tender) => {
    expect(rejected(withTenders([
      { method: 'CASH', role: 'FIXED', amount: '100', receivedAmount: '100' },
      tender,
    ]))).toBe(true);
  });

  it('A9 accepts OTHER with a name and a debit without any institution', () => {
    expect(rejected(withTenders([
      { method: 'CASH', role: 'FIXED', amount: '100', receivedAmount: '100' },
      { method: 'TRANSFER', role: 'FIXED', amount: '100', reference: 'OP 1', institution: 'OTHER', institutionOther: 'Banco X' },
      { method: 'CARD_DEBIT', role: 'BALANCE', reference: 'D009' },
    ]))).toBe(false);
  });

  it('A10 the vuelto is accepted on CASH only, and never reaches the service', () => {
    const parsed = checkoutRequestDto.parse(withTenders([
      { method: 'CASH', role: 'FIXED', amount: '20000', receivedAmount: '25000', changeAmount: '5000' },
      { method: 'CARD_DEBIT', role: 'BALANCE', reference: 'D009' },
    ]));
    expect(parsed.tenders[0]).not.toHaveProperty('changeAmount');
    expect(rejected(withTenders([
      { method: 'CASH', role: 'FIXED', amount: '20000', receivedAmount: '25000' },
      { method: 'TRANSFER', role: 'FIXED', amount: '1000', reference: 'OP 1', institution: 'GALICIA', changeAmount: '500' },
      { method: 'CARD_DEBIT', role: 'BALANCE', reference: 'D009' },
    ]))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// B. HTTP: route, permission, status codes, events
// ---------------------------------------------------------------------------
describe('POST /api/v1/sales/:saleId/checkout', () => {
  it('B1 a new checkout returns 201 with json-safe money and both events after commit', async () => {
    const t = harness();
    const response = await request(t.app).post(ENDPOINT).send(confirmationBody());

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      saleId: SALE, saleNumber: 'S-0001', status: 'COMPLETED', checkoutId: 'checkout-1', replayed: false,
      total: '42037', changeAmount: '0',
    });
    expect(response.body.payments[0]).toMatchObject({ id: 'pay-1', method: 'CASH', amount: '20037', receivedAmount: '20037' });
    expect(response.body.lines[0]).toMatchObject({ saleItemId: 'item-1', sku: 'SKU-1', finalAmount: '42037' });
    expect(response.body.completedAt).toBe('2026-10-16T12:00:00.000Z');

    expect(t.events).toEqual([
      { event: 'sale.completed', payload: { branchId: BRANCH, saleId: SALE, saleNumber: 'S-0001', status: 'COMPLETED' } },
      { event: 'inventory.updated', payload: { branchId: BRANCH, saleId: SALE, status: 'COMPLETED' } },
    ]);
  });

  it('B2 the DTO output is handed to the service unchanged (cents stay BigInt)', async () => {
    const t = harness();
    await request(t.app).post(ENDPOINT).send(confirmationBody());

    expect(t.calls).toHaveLength(1);
    const [req, userId, saleId, payload] = t.calls[0]!;
    expect(req.auth!.userId).toBe('user-1');
    expect(userId).toBe('user-1');
    expect(saleId).toBe(SALE);
    expect(payload).toEqual(checkoutConfirmationDto.parse(confirmationBody()));
    expect(payload.reserveKey).toBe(RESERVE_KEY);
    expect(payload.operationKey).toBe(OPERATION_KEY);
    expect(payload.tenders[0]!.receivedAmount).toBe(42000n);
    expect(payload).not.toHaveProperty('cashSessionId');
    expect(payload).not.toHaveProperty('balanceMethod');
    expect(payload).not.toHaveProperty('expectedTotal');
    expect(payload).not.toHaveProperty('expectedBalanceAmount');
  });

  it('B3 a replay returns 200 and emits nothing (the original call already notified)', async () => {
    const t = harness();
    t.setResult(result({ replayed: true }));

    const response = await request(t.app).post(ENDPOINT).send(confirmationBody());

    expect(response.status).toBe(200);
    expect(response.body.replayed).toBe(true);
    expect(t.events).toEqual([]);
    expect(t.calls).toHaveLength(1);
  });

  it('B4 a caller without SALE_CHARGE gets 403 and never reaches the service', async () => {
    const t = harness({ auth: auth('SELLER', BRANCH) });
    const response = await request(t.app).post(ENDPOINT).send(confirmationBody());

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: { code: 'FORBIDDEN', message: 'No cuenta con permisos para esta operación.' } });
    expect(t.calls).toEqual([]);
    expect(t.events).toEqual([]);
  });

  it('B5 a WAREHOUSE caller gets 403 as well', async () => {
    const t = harness({ auth: auth('WAREHOUSE', BRANCH) });
    expect((await request(t.app).post(ENDPOINT).send(confirmationBody())).status).toBe(403);
    expect(t.calls).toEqual([]);
  });

  it('B6 an unauthenticated caller gets 401 and nothing runs', async () => {
    const t = harness({ auth: null });
    const response = await request(t.app).post(ENDPOINT).send(confirmationBody());

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHORIZED');
    expect(t.calls).toEqual([]);
    expect(t.events).toEqual([]);
  });

  it('B7 a malformed body is rejected with 400 before any service call', async () => {
    const t = harness();
    const response = await request(t.app).post(ENDPOINT).send(confirmationBody({ operationKey: 'not-a-uuid' }));

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(t.calls).toEqual([]);
    expect(t.events).toEqual([]);
  });

  it('B8 a non-UUID saleId is rejected with 400 on the params', async () => {
    const t = harness();
    const response = await request(t.app).post('/api/v1/sales/not-an-id/checkout').send(confirmationBody());

    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(response.body.error.details).toEqual([{ path: ['saleId'], code: expect.any(String) }]);
    expect(t.calls).toEqual([]);
  });

  it('B9 a service rejection maps to its AppError status and emits nothing (rollback)', async () => {
    const t = harness();
    t.setResult(new AppError(409, 'CHECKOUT_QUOTE_CHANGED', 'La cotización cambió; vuelva a confirmar.', { total: 42037n, balance: 22000n }));

    const response = await request(t.app).post(ENDPOINT).send(confirmationBody());

    expect(response.status).toBe(409);
    expect(response.body.error).toMatchObject({
      code: 'CHECKOUT_QUOTE_CHANGED',
      message: 'La cotización cambió; vuelva a confirmar.',
      details: { total: '42037', balance: '22000' },
    });
    expect(t.events).toEqual([]);
  });

  it('B10 an unexpected failure is a 500 and emits nothing', async () => {
    const t = harness();
    t.setResult(new Error('boom'));

    const response = await request(t.app).post(ENDPOINT).send(confirmationBody());

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Ocurrió un error interno.' } });
    expect(t.events).toEqual([]);
  });

  it('B11 a failed branch lookup never turns a committed checkout into an error', async () => {
    const t = harness();
    t.failBranchRead();

    const response = await request(t.app).post(ENDPOINT).send(confirmationBody());

    expect(response.status).toBe(201);
    expect(response.body.status).toBe('COMPLETED');
    expect(t.events).toEqual([]);
  });

  it('B12 a missing sale row skips the notification without failing the request', async () => {
    const t = harness();
    t.setBranch(null);

    expect((await request(t.app).post(ENDPOINT).send(confirmationBody())).status).toBe(201);
    expect(t.events).toEqual([]);
  });

  it('B13 a notification failure is advisory: the committed checkout still returns 201', async () => {
    const t = harness();
    t.failNotify();

    expect((await request(t.app).post(ENDPOINT).send(confirmationBody())).status).toBe(201);
    expect(t.events).toEqual([]);
  });

  it('B14 the notification carries the SALE branch, not the caller scope', async () => {
    const t = harness({ auth: (() => {
      const context = auth('CASHIER', OTHER_BRANCH);
      context.effectiveLocationIds = [OTHER_BRANCH, BRANCH];
      return context;
    })() });
    t.setBranch(BRANCH);

    await request(t.app).post(ENDPOINT).send(confirmationBody());

    expect(t.events.map(({ payload }) => payload.branchId)).toEqual([BRANCH, BRANCH]);
  });
});

// ---------------------------------------------------------------------------
// C. Static wiring: the route table and the delegation contract
// ---------------------------------------------------------------------------
describe('R3 checkout wiring', () => {
  it('C1 registers POST /:saleId/checkout with the confirmation contract and SALE_CHARGE gate', () => {
    expect(CHECKOUT_ROUTE_BLOCK).toContain("validate(checkoutConfirmationParamsDto, 'params')");
    expect(CHECKOUT_ROUTE_BLOCK).toContain('validate(checkoutConfirmationDto)');
    expect(CHECKOUT_ROUTE_BLOCK).toContain('requirePermission(PRODUCTION_PERMISSIONS.SALE_CHARGE)');
    expect(CHECKOUT_ROUTE_BLOCK).toContain('checkout.create');
    expect(CHECKOUT_ROUTE_BLOCK).not.toContain("validate(checkoutParamsDto, 'params')");
    expect(CHECKOUT_ROUTE_BLOCK).not.toContain('validate(checkoutRequestDto)');
  });

  it('C2 leaves the historical /payments routes untouched and unguarded by the new policy', () => {
    expect(ROUTES_SOURCE).toContain("router.post('/:saleId/payments'");
    expect(ROUTES_SOURCE).toContain("router.get('/:saleId/payments'");
    expect(ROUTES_SOURCE).not.toContain('PROPORTIONAL_CHECKOUT_LOCATION_IDS');
  });

  it('C3 the controller only delegates: no pricing, no transaction, no row write', () => {
    expect(CONTROLLER_SOURCE).toContain('service.checkout(');
    expect(CONTROLLER_SOURCE).not.toContain('computeProportionalQuote');
    expect(CONTROLLER_SOURCE).not.toContain('$transaction');
    expect(CONTROLLER_SOURCE).not.toContain('normalizeReferenceKey');
  });
});

// ---------------------------------------------------------------------------
// D. R3-A4.3 S5 RED: confirmation contract replaces the legacy A3 body
// ---------------------------------------------------------------------------
describe('R3-A4.3 S5 — confirmation HTTP contract RED', () => {
  it('S5-A1 the confirmation DTO carries only reserve identity and confirmation evidence', () => {
    const parsed = checkoutConfirmationDto.parse(confirmationBody());

    expect(parsed).toEqual({
      reserveKey: RESERVE_KEY,
      operationKey: OPERATION_KEY,
      tenders: [
        {
          method: 'CASH',
          receivedAmount: 42000n,
          reference: null,
          referenceKey: null,
          institution: null,
          institutionOther: null,
        },
      ],
      supervisor: null,
    });

    expect(parsed.tenders[0]!.receivedAmount).toBe(42000n);
    expect(typeof parsed.tenders[0]!.receivedAmount).toBe('bigint');
    expect(parsed).not.toHaveProperty('cashSessionId');
    expect(parsed).not.toHaveProperty('balanceMethod');
    expect(parsed).not.toHaveProperty('expectedTotal');
    expect(parsed).not.toHaveProperty('expectedBalanceAmount');
  });

  it('S5-A2 POST /checkout must accept the sealed-attempt confirmation body', async () => {
    const t = harness();

    const response = await request(t.app)
      .post(ENDPOINT)
      .send(confirmationBody());

    expect(response.status).toBe(201);
    expect(t.calls).toHaveLength(1);

    const [, , saleId, payload] = t.calls[0]!;
    expect(saleId).toBe(SALE);
    expect(payload).toEqual(checkoutConfirmationDto.parse(confirmationBody()));
  });

  it('S5-A3 POST /checkout must reject the legacy A3 settlement body', async () => {
    const t = harness();

    const response = await request(t.app)
      .post(ENDPOINT)
      .send(validBody());

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(t.calls).toEqual([]);
  });

  it('S5-A4 the route is wired to the confirmation params/body DTOs', () => {
    expect(CHECKOUT_ROUTE_BLOCK).toContain(
      "validate(checkoutConfirmationParamsDto, 'params')",
    );
    expect(CHECKOUT_ROUTE_BLOCK).toContain(
      'validate(checkoutConfirmationDto)',
    );
    expect(CHECKOUT_ROUTE_BLOCK).toContain(
      'requirePermission(PRODUCTION_PERMISSIONS.SALE_CHARGE)',
    );
    expect(CHECKOUT_ROUTE_BLOCK).toContain('checkout.create');
    expect(CHECKOUT_ROUTE_BLOCK).not.toContain(
      "validate(checkoutParamsDto, 'params')",
    );
    expect(CHECKOUT_ROUTE_BLOCK).not.toContain(
      'validate(checkoutRequestDto)',
    );
  });

  it('S5-A5 confirmation saleId remains canonical lowercase UUID v4', () => {
    expect(checkoutConfirmationParamsDto.safeParse({ saleId: SALE }).success).toBe(true);

    expect(
      checkoutConfirmationParamsDto.safeParse({
        saleId: '123e4567-e89b-12d3-a456-426614174000',
      }).success,
    ).toBe(false);

    expect(
      checkoutConfirmationParamsDto.safeParse({
        saleId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'.toUpperCase(),
      }).success,
    ).toBe(false);
  });
});
