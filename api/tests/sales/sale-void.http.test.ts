// Sale void v1 — HTTP boundary of POST /api/v1/sales/:saleId/void (stage 3). DB-FREE.
//
// The REAL router, validation, authorization and error middlewares run. Two modes:
//   - injected service (a recorder): the HTTP contract of the INPUT — what reaches the service, what never does;
//   - the REAL sale void service on the in-memory store (tests/helpers/in-memory-sales-db.ts): statuses, the
//     serialized body, the preserved AppError codes and the realtime behaviour. The domain itself is pinned by
//     sale-void.behavior.test.ts and sale-void.pg.test.ts; nothing here re-tests it.
//
// CONTRACT pinned:
//   - POST /:saleId/void, a route of its own next to (and never replacing) POST /:saleId/cancel.
//   - validation at the edge: params (saleIdDto) and body (voidSaleDto, strict) -> 400 VALIDATION_ERROR;
//   - coarse gate SALE_VOID (no auth 401; a role without it 403, service never called); the definitive decision
//     stays in the service against the persisted sale.branchId (an ADMIN with only a LOCATION scope holds the
//     permission and is still refused 403 by the service);
//   - 201 for a new void, 200 for an idempotent replay; BigInt money leaves as decimal strings;
//   - every AppError of the service keeps its status and code (no translation in the controller);
//   - realtime, only after a NEW void succeeded and never for a replay or a refusal:
//       sale.voided (safe summary: no reason, evidence or payments) and, only when stock moved,
//       inventory.updated. sale.cancelled is NEVER used for a void (it belongs to the pre-payment cancel).
//     There is no cash realtime pattern in the project: the cash UI reads the session through its HTTP endpoints.
import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { errorHandler } from '../../src/middleware/errorHandler.js';
import { createCancellationRouter } from '../../src/modules/sales/cancellation.routes.js';
import { DEFAULT_ROLE_GRANTS } from '../../src/modules/rbac/role-permission-matrix.js';
import { AppError } from '../../src/shared/errors.js';
import { createInMemorySalesDb } from '../helpers/in-memory-sales-db.js';

type Row = Record<string, unknown>;
type Role = 'CASHIER' | 'SELLER' | 'WAREHOUSE' | 'ADMIN';
type Actor = 'owner' | 'adminCompany' | 'adminLocation' | 'cashier' | 'seller' | 'none';
type Emitted = { event: string; payload: Record<string, unknown> };

const PRICE_V1 = 10000n;
const PRICE_V2 = 5000n;
const TOTAL = 2n * PRICE_V1 + PRICE_V2;
const REASON = 'Error de carga: producto equivocado';
const EVIDENCE = 'Transferencia devuelta, comprobante 000123';

function world() {
  const db = createInMemorySalesDb({ withSaleVoid: true });
  db.insert('company', { name: 'Mona Jacinta', cuit: '00000000000', address: 'Demo', isActive: true, createdAt: new Date() });
  const L1 = db.insert('location', { isActive: true }).id as string;
  const L2 = db.insert('location', { isActive: true }).id as string;
  db.insert('branch', { id: L1, code: 'S1', name: 'Sucursal 1' });
  db.insert('branch', { id: L2, code: 'S2', name: 'Sucursal 2' });
  const user = (name: string) => db.insert('user', { name, email: `${name}@test.invalid`, isActive: true }).id as string;
  const ids = { seller: user('seller'), cashier: user('cashier'), admin: user('admin'), owner: user('owner') };
  const product = db.insert('product', { name: 'Remera', isActive: true }).id as string;
  const variant = (sku: string, cashPrice: bigint) => db.insert('productVariant', {
    productId: product, sku, barcode: sku, cashPrice, price: cashPrice, wholesalePrice: null, costPrice: 1000n, color: 'Negro', size: 'M',
  }).id as string;
  const V1 = variant('V1', PRICE_V1);
  const V2 = variant('V2', PRICE_V2);
  const inventory = (branchId: string, variantId: string, physical: bigint, reserved: bigint) =>
    db.insert('inventory', { branchId, variantId, physical, reserved }).id as string;
  const inv = { V1: inventory(L1, V1, 100n, 0n), V2: inventory(L1, V2, 100n, 0n) };
  const register1 = db.insert('cashRegister', { branchId: L1, name: 'Caja 1' }).id as string;
  const register2 = db.insert('cashRegister', { branchId: L2, name: 'Caja 2' }).id as string;
  const openSession = (registerId: string, startingCash: bigint) => {
    const session = db.insert('cashSession', { registerId, openedById: ids.cashier, startingCash, status: 'OPEN' });
    db.insert('cashMovement', { sessionId: session.id, type: 'OPENING', amount: startingCash, salePaymentId: null, userId: ids.cashier });
    return session.id as string;
  };
  const S1 = openSession(register1, 10_000n);
  const S2 = openSession(register2, 10_000n);

  const sale = (status: string, items: Array<[string, bigint, bigint]>, pricingModel: 'FIXED_TOTAL' | 'PROPORTIONAL_V1') => {
    const saleTotal = items.reduce((sum, [, q, p]) => sum + q * p, 0n);
    const row = db.insert('sale', {
      branchId: L1, sellerId: ids.seller, status, priceMode: 'CASH', pricingModel, subtotal: saleTotal, discountTotal: 0n, total: saleTotal,
      saleNumber: `T-${randomUUID().slice(0, 8)}`,
    });
    for (const [variantId, quantity, unitPrice] of items) {
      db.insert('saleItem', { saleId: row.id, variantId, productId: product, productName: 'Remera', variantName: 'Negro M', sku: variantId, quantity, unitPrice, subtotal: quantity * unitPrice });
    }
    return row.id as string;
  };
  const pay = (saleId: string, method: string, amount: bigint) => {
    const external = method !== 'CASH';
    const collection = external ? db.insert('externalCollection', {
      branchId: L1, method, amount, reference: `REF-${method}`, referenceKey: `ref-${randomUUID()}`, status: 'APPLIED', appliedSaleId: saleId, originSaleId: saleId, recordedById: ids.cashier,
    }).id : null;
    const payment = db.insert('salePayment', { saleId, method, amount, idempotencyKey: randomUUID(), cashSessionId: external ? null : S1, externalCollectionId: collection });
    if (!external) db.insert('cashMovement', { sessionId: S1, type: 'SALE_INCOME', amount, salePaymentId: payment.id, userId: ids.cashier });
    return payment.id as string;
  };
  const consume = (saleId: string) => {
    for (const [inventoryId, sold] of [[inv.V1, 2n], [inv.V2, 1n]] as const) {
      db.table('inventory').find((row) => row.id === inventoryId)!.physical = 100n - sold;
      db.insert('stockMovement', { inventoryId, type: 'SALE', quantityDelta: -sold, saleId, userId: ids.cashier, branchId: L1 });
    }
  };
  const items: Array<[string, bigint, bigint]> = [[V1, 2n, PRICE_V1], [V2, 1n, PRICE_V2]];
  // COMPLETED, proportional, TRANSFER + CARD_DEBIT (needs evidence, no cash).
  const externalSale = () => {
    const saleId = sale('COMPLETED', items, 'PROPORTIONAL_V1');
    const payments = { TRANSFER: pay(saleId, 'TRANSFER', 15000n), CARD_DEBIT: pay(saleId, 'CARD_DEBIT', 10000n) };
    consume(saleId);
    return { saleId, payments };
  };
  // COMPLETED, fixed total, CASH.
  const cashSale = () => {
    const saleId = sale('COMPLETED', items, 'FIXED_TOTAL');
    pay(saleId, 'CASH', TOTAL);
    consume(saleId);
    return saleId;
  };
  // PAID, fixed total, CASH, stock held by ACTIVE reservations.
  const paidSale = (activeHolds = true) => {
    const saleId = sale('PAID', items, 'FIXED_TOTAL');
    pay(saleId, 'CASH', TOTAL);
    if (activeHolds) {
      db.table('inventory').find((row) => row.id === inv.V1)!.reserved = 2n;
      db.table('inventory').find((row) => row.id === inv.V2)!.reserved = 1n;
      db.insert('stockReservation', { saleId, variantId: V1, branchId: L1, quantity: 2n, status: 'ACTIVE', expiresAt: new Date(Date.now() + 3600_000) });
      db.insert('stockReservation', { saleId, variantId: V2, branchId: L1, quantity: 1n, status: 'ACTIVE', expiresAt: new Date(Date.now() + 3600_000) });
    }
    return saleId;
  };
  const evidenceFor = (payments: Record<string, string>) => Object.entries(payments).map(([method, salePaymentId]) => ({ salePaymentId, evidence: `${EVIDENCE} ${method}` }));
  return { db, ids, L1, L2, S1, S2, register1, openSession, sale, items, externalSale, cashSale, paidSale, evidenceFor };
}
type World = ReturnType<typeof world>;

function authFor(w: World, actor: Actor) {
  const location = (role: Role, locationId: string): Express.ProductionAssignment => ({
    roleId: `${role}-${locationId}`, roleCode: role, scopeKind: 'LOCATION', locationId, permissions: [...DEFAULT_ROLE_GRANTS[role]],
  });
  const company = (role: 'OWNER' | 'ADMIN'): Express.ProductionAssignment => ({
    roleId: `${role}-company`, roleCode: role, scopeKind: 'COMPANY', locationId: null, permissions: role === 'ADMIN' ? [...DEFAULT_ROLE_GRANTS.ADMIN] : [],
  });
  const table: Record<Exclude<Actor, 'none'>, [string, Express.ProductionAssignment]> = {
    owner: [w.ids.owner, company('OWNER')], adminCompany: [w.ids.admin, company('ADMIN')], adminLocation: [w.ids.admin, location('ADMIN', w.L1)],
    cashier: [w.ids.cashier, location('CASHIER', w.L1)], seller: [w.ids.seller, location('SELLER', w.L1)],
  };
  if (actor === 'none') return undefined;
  const [userId, assignment] = table[actor];
  return { userId, roles: [assignment.roleCode], assignments: [assignment], effectiveLocationIds: assignment.locationId ? [assignment.locationId] : [] };
}

function appFor(w: World, options: { actor?: Actor; service?: unknown; onEmit?: (event: Emitted) => void } = {}) {
  const emitted: Emitted[] = [];
  const realtime = { emit: (event: string, payload: Record<string, unknown>) => { emitted.push({ event, payload }); options.onEmit?.({ event, payload }); } };
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    const auth = authFor(w, options.actor ?? 'owner');
    if (auth) req.auth = auth as never;
    next();
  });
  server.use('/api/v1/sales', (createCancellationRouter as (...args: unknown[]) => express.Router)(
    w.db.client as unknown as PrismaClient, realtime, options.service ? { saleVoidService: options.service } : {},
  ));
  server.use(errorHandler);
  return { server, emitted };
}

const body = (extra: Row = {}) => ({ reason: REASON, idempotencyKey: randomUUID(), ...extra });
const post = (server: express.Express, saleId: string, payload: unknown) => request(server).post(`/api/v1/sales/${saleId}/void`).send(payload as object);
const errorOf = (response: request.Response) => (response.body.error ?? response.body) as { code?: string };

// An injected service that records what the controller hands it.
function recorder(result: Row = {}) {
  const calls: unknown[][] = [];
  const service = {
    voidSale: async (...args: unknown[]) => {
      calls.push(args);
      return { saleId: args[1], branchId: 'b', voidId: 'v', status: 'CANCELLED', previousStatus: 'COMPLETED', reason: REASON, replayed: false,
        stockReturned: [], reservationsReleased: [], cashRefund: null, externalRefunds: [], ...result };
    },
  };
  return { service, calls };
}

describe('sale void v1 — HTTP: the route and what reaches the service', () => {
  it('HT01 POST /:saleId/void exists and hands (req, saleId, parsed body) to the service; the parsed body is the DTO output', async () => {
    const w = world();
    const { service, calls } = recorder();
    const { server } = appFor(w, { service });
    const saleId = randomUUID();
    const key = randomUUID();
    const response = await post(server, saleId, { reason: `  ${REASON}  `, idempotencyKey: key });
    expect(response.status).toBe(201);
    expect(calls).toHaveLength(1);
    const [req, id, input] = calls[0]!;
    expect((req as { auth?: { userId: string } }).auth?.userId).toBe(w.ids.owner);
    expect(id).toBe(saleId);
    expect(input).toMatchObject({ reason: REASON, idempotencyKey: key, externalRefunds: [] });
  });

  it('HT02 invalid bodies die at the edge with 400 VALIDATION_ERROR and never reach the service', async () => {
    const w = world();
    const { service, calls } = recorder();
    const { server } = appFor(w, { service });
    const saleId = randomUUID();
    const paymentId = randomUUID();
    const cases: unknown[] = [
      {}, { reason: REASON }, { idempotencyKey: randomUUID() },
      body({ reason: '   ' }), body({ reason: 'x'.repeat(201) }), body({ idempotencyKey: 'not-a-uuid' }),
      body({ cashSessionId: 'not-a-uuid' }),
      body({ extra: 1 }),
      body({ externalRefunds: [{ salePaymentId: paymentId, evidence: '   ' }] }),
      body({ externalRefunds: [{ salePaymentId: 'nope', evidence: EVIDENCE }] }),
      body({ externalRefunds: [{ salePaymentId: paymentId, evidence: EVIDENCE }, { salePaymentId: paymentId, evidence: EVIDENCE }] }),
      body({ externalRefunds: [{ salePaymentId: paymentId, evidence: EVIDENCE, extra: 1 }] }),
    ];
    for (const payload of cases) {
      const response = await post(server, saleId, payload);
      expect(response.status, JSON.stringify(payload)).toBe(400);
      expect(errorOf(response).code).toBe('VALIDATION_ERROR');
    }
    expect(calls).toHaveLength(0);
  });

  it('HT03 a saleId that is not a UUID -> 400 VALIDATION_ERROR, service not called', async () => {
    const w = world();
    const { service, calls } = recorder();
    const { server } = appFor(w, { service });
    const response = await post(server, 'not-a-uuid', body());
    expect(response.status).toBe(400);
    expect(errorOf(response).code).toBe('VALIDATION_ERROR');
    expect(calls).toHaveLength(0);
  });

  it('HT04 no authentication -> 401, service not called', async () => {
    const w = world();
    const { service, calls } = recorder();
    const { server } = appFor(w, { service, actor: 'none' });
    const response = await post(server, randomUUID(), body());
    expect(response.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it.each([['cashier'], ['seller']] as const)('HT05 the coarse gate: a %s (no SALE_VOID) -> 403 FORBIDDEN and the service is never called', async (actor) => {
    const w = world();
    const { service, calls } = recorder();
    const { server } = appFor(w, { service, actor });
    const response = await post(server, randomUUID(), body());
    expect(response.status).toBe(403);
    expect(errorOf(response).code).toBe('FORBIDDEN');
    expect(calls).toHaveLength(0);
  });

  it('HT06 the coarse gate is not the decision: an ADMIN with only a LOCATION scope passes it and the SERVICE refuses 403 against the persisted branch', async () => {
    const w = world();
    const { saleId, payments } = w.externalSale();
    const { server, emitted } = appFor(w, { actor: 'adminLocation' });
    const response = await post(server, saleId, body({ externalRefunds: w.evidenceFor(payments) }));
    expect(response.status).toBe(403);
    expect(errorOf(response).code).toBe('FORBIDDEN');
    expect(w.db.table('saleVoid')).toHaveLength(0);
    expect(emitted).toEqual([]);
  });

  it('HT07 the pre-payment cancel is a different route: /void never reaches it and /cancel keeps answering on its own contract', async () => {
    const w = world();
    const { server } = appFor(w);
    const draft = w.sale('DRAFT', w.items, 'FIXED_TOTAL');
    const voided = await post(server, draft, body());
    expect(voided.status).toBe(409);
    expect(errorOf(voided).code).toBe('INVALID_SALE_STATE');
    expect(w.db.table('sale').find((row) => row.id === draft)!.status).toBe('DRAFT');
    // /cancel validates ITS body (the reason catalog), not the void body
    const cancelled = await request(server).post(`/api/v1/sales/${draft}/cancel`).send({ reason: REASON, idempotencyKey: randomUUID() });
    expect(cancelled.status).toBe(400);
    expect(errorOf(cancelled).code).toBe('VALIDATION_ERROR');
  });
});

describe('sale void v1 — HTTP: statuses, serialization and preserved errors (real service)', () => {
  it('HT10 a new void answers 201 and an identical replay answers 200 with replayed:true and the same voidId', async () => {
    const w = world();
    const saleId = w.cashSale();
    const { server } = appFor(w);
    const payload = body({ cashSessionId: w.S1 });
    const first = await post(server, saleId, payload);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ saleId, status: 'CANCELLED', previousStatus: 'COMPLETED', replayed: false });
    const second = await post(server, saleId, payload);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ replayed: true, voidId: first.body.voidId });
    expect(w.db.table('saleVoid')).toHaveLength(1);
  });

  it('HT11 BigInt money and quantities leave as decimal STRINGS, never numbers and never a BigInt error', async () => {
    const w = world();
    const saleId = w.cashSale();
    const { server } = appFor(w);
    const response = await post(server, saleId, body({ cashSessionId: w.S1 }));
    expect(response.status).toBe(201);
    expect(response.body.cashRefund.total).toBe('25000');
    expect(response.body.cashRefund.movements[0]).toMatchObject({ amount: '25000' });
    expect(response.body.cashRefund.cashSessionId).toBe(w.S1);
    expect(response.body.stockReturned.map((line: Row) => line.quantity).sort()).toEqual(['1', '2']);
    const external = world();
    const sale = external.externalSale();
    const viaExternal = await post(appFor(external).server, sale.saleId, body({ externalRefunds: external.evidenceFor(sale.payments) }));
    expect(viaExternal.status).toBe(201);
    expect(viaExternal.body.cashRefund).toBeNull();
    expect(viaExternal.body.externalRefunds.map((refund: Row) => refund.amount).sort()).toEqual(['10000', '15000']);
    expect(viaExternal.body.externalRefunds.every((refund: Row) => refund.refundPerformed === true)).toBe(true);
  });

  it('HT12 the service errors keep their status and code (no translation in the controller)', async () => {
    const w = world();
    const { server } = appFor(w);
    const expectError = async (saleId: string, payload: unknown, status: number, code: string, label: string) => {
      const response = await post(server, saleId, payload);
      expect([label, response.status, errorOf(response).code]).toEqual([label, status, code]);
    };
    // 404
    await expectError(randomUUID(), body(), 404, 'NOT_FOUND', 'unknown sale');
    // 409 invalid state
    await expectError(w.sale('PENDING_PAYMENT', w.items, 'FIXED_TOTAL'), body(), 409, 'INVALID_SALE_STATE', 'pending');
    // 409 evidence required
    const external = w.externalSale();
    await expectError(external.saleId, body(), 409, 'EXTERNAL_REFUND_EVIDENCE_REQUIRED', 'evidence');
    // 409 session branch mismatch / closed / insufficient drawer
    const cash = w.cashSale();
    await expectError(cash, body({ cashSessionId: w.S2 }), 409, 'CASH_SESSION_BRANCH_MISMATCH', 'branch');
    await expectError(cash, body(), 409, 'CASH_SESSION_REQUIRED', 'session required');
    const poor = w.openSession(w.register1, 1_000n);
    await expectError(cash, body({ cashSessionId: poor }), 409, 'INSUFFICIENT_CASH_IN_DRAWER', 'drawer');
    w.db.table('cashSession').find((row) => row.id === poor)!.status = 'CLOSED';
    await expectError(cash, body({ cashSessionId: poor }), 409, 'CASH_SESSION_ALREADY_CLOSED', 'closed');
    // 409 idempotency conflict, then already voided
    const key = randomUUID();
    const voided = await post(server, cash, body({ idempotencyKey: key, cashSessionId: w.S1 }));
    expect(voided.status).toBe(201);
    await expectError(cash, body({ idempotencyKey: key, reason: 'Otro motivo', cashSessionId: w.S1 }), 409, 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD', 'idempotency');
    await expectError(cash, body({ cashSessionId: w.S1 }), 409, 'SALE_ALREADY_VOIDED', 'already voided');
  });

  it('HT13 a refused request leaves no trace: nothing written, nothing emitted', async () => {
    const w = world();
    const { saleId } = w.externalSale();
    const before = structuredClone(w.db.allTables());
    const { server, emitted } = appFor(w);
    expect((await post(server, saleId, body())).status).toBe(409); // evidence missing
    expect(w.db.allTables()).toEqual(before);
    expect(emitted).toEqual([]);
  });
});

describe('sale void v1 — HTTP: realtime', () => {
  // The real emitter serializes through toJsonSafe before the socket; the recorder keeps the raw payload.
  const safe = (emitted: Emitted[]) => JSON.stringify(emitted, (_key, value) => (typeof value === 'bigint' ? value.toString() : value));

  it('HT20 a NEW COMPLETED void emits sale.voided once and inventory.updated once, never sale.cancelled; the payload is a safe summary', async () => {
    const w = world();
    const { saleId, payments } = w.externalSale();
    const { server, emitted } = appFor(w);
    const evidence = w.evidenceFor(payments);
    const response = await post(server, saleId, body({ externalRefunds: evidence }));
    expect(response.status).toBe(201);
    const events = emitted.map((e) => e.event);
    expect(events.filter((e) => e === 'sale.voided')).toHaveLength(1);
    expect(events.filter((e) => e === 'inventory.updated')).toHaveLength(1);
    expect(events).not.toContain('sale.cancelled');
    expect(emitted.every((e) => e.payload.branchId === w.L1)).toBe(true);
    const voided = emitted.find((e) => e.event === 'sale.voided')!.payload;
    expect(voided).toMatchObject({ saleId, status: 'CANCELLED', previousStatus: 'COMPLETED', voidId: response.body.voidId });
    // nothing sensitive travels on the socket: no reason, no evidence, no payments
    for (const secret of [REASON, EVIDENCE, 'comprobante']) expect(safe(emitted)).not.toContain(secret);
    expect(Object.keys(voided)).not.toContain('payments');
    expect(Object.keys(voided)).not.toContain('externalRefunds');
  });

  it('HT21 a NEW PAID void emits inventory.updated (the released holds) once', async () => {
    const w = world();
    const saleId = w.paidSale();
    const { server, emitted } = appFor(w);
    expect((await post(server, saleId, body({ cashSessionId: w.S1 }))).status).toBe(201);
    expect(emitted.map((e) => e.event).sort()).toEqual(['inventory.updated', 'sale.voided']);
  });

  it('HT22 inventory.updated is emitted ONLY when stock was returned or holds were released', async () => {
    const w = world();
    const saleId = w.paidSale(false); // PAID with no ACTIVE hold: nothing to release
    const { server, emitted } = appFor(w);
    expect((await post(server, saleId, body({ cashSessionId: w.S1 }))).status).toBe(201);
    expect(emitted.map((e) => e.event)).toEqual(['sale.voided']);
  });

  it('HT23 an idempotent replay (200) emits NOTHING: it is not another void', async () => {
    const w = world();
    const saleId = w.cashSale();
    const { server, emitted } = appFor(w);
    const payload = body({ cashSessionId: w.S1 });
    expect((await post(server, saleId, payload)).status).toBe(201);
    const afterFirst = emitted.length;
    expect(afterFirst).toBeGreaterThan(0);
    expect((await post(server, saleId, payload)).status).toBe(200);
    expect(emitted).toHaveLength(afterFirst);
  });

  it('HT24 realtime is emitted only AFTER the void is committed (the sale is already CANCELLED when the event fires)', async () => {
    const w = world();
    const saleId = w.cashSale();
    const seen: string[] = [];
    const { server } = appFor(w, { onEmit: () => { seen.push(String(w.db.table('sale').find((row) => row.id === saleId)!.status)); } });
    expect((await post(server, saleId, body({ cashSessionId: w.S1 }))).status).toBe(201);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((status) => status === 'CANCELLED')).toBe(true);
  });

  it('HT25 a failing realtime emitter after the commit does not turn a committed void into an error', async () => {
    const w = world();
    const saleId = w.cashSale();
    const { server } = appFor(w, { onEmit: () => { throw new AppError(500, 'REALTIME_DOWN', 'boom'); } });
    const response = await post(server, saleId, body({ cashSessionId: w.S1 }));
    expect(response.status).toBe(201);
    expect(w.db.table('sale').find((row) => row.id === saleId)!.status).toBe('CANCELLED');
  });
});
