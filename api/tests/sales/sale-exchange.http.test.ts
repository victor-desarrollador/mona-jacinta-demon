// Sale exchange v1 — HTTP + realtime boundary of POST /api/v1/sales/:saleId/exchanges. DB-FREE.
//
// The REAL router, validation, authorization and error middlewares run, plus the REAL exchange service on the in-memory store
// (tests/helpers/in-memory-sales-db.ts, `withSaleExchange`). The domain itself is pinned by sale-exchange.behavior.test.ts and
// sale-exchange.pg.test.ts; nothing here re-tests it beyond proving that every AppError reaches the client unchanged.
// Two modes: an injected recorder (what reaches the service, what never does) and the real service (status, body, realtime).
//
// CONTRACT pinned (same shape as the sale void route, which is the precedent in this module):
//   - POST /:saleId/exchanges next to (never replacing) /cancel and /void;
//   - validation at the edge: params (saleIdDto) -> 400, coarse SALE_EXCHANGE gate (401 / 403, service never called), strict body
//     (exchangeSaleHttpDto) -> 400 VALIDATION_ERROR; returnQuantity travels over HTTP ONLY as a canonical positive decimal STRING (a JSON number of any size is 400: the HTTP edge removes Number altogether);
//   - the definitive decision stays in the service (OWNER, or a COMPANY-scoped ADMIN holding SALE_EXCHANGE; a LOCATION ADMIN holds the
//     permission and is refused 403 by the service);
//   - 201 + replayed:false for a NEW exchange, 200 + replayed:true for an idempotent replay (byte-identical body apart from `replayed`);
//   - every BigInt leaves as a decimal string; the internal `inventories` snapshot used for realtime NEVER travels in the response;
//   - every AppError keeps its status and code (no translation in the route);
//   - realtime: ONE inventory.updated per NEW exchange, after the service returned (i.e. after the commit), never for a replay or a
//     refusal; the payload carries the FINAL state of every Inventory the exchange modified, deduplicated by inventoryId;
//   - money: no SalePayment / CashMovement / ExternalCollection is written and the Sale / SaleItem are untouched.
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
type Actor = 'owner' | 'adminCompany' | 'adminCompanyNoExchange' | 'adminLocation' | 'cashier' | 'seller' | 'warehouse' | 'none';
type Emitted = { event: string; payload: Record<string, unknown> };

const P1 = 10000n;
const P2 = 5000n;
const P4 = 15000n;
const P5 = 7000n;
const ADMIN_ALL = [...DEFAULT_ROLE_GRANTS.ADMIN, 'SALE_EXCHANGE'];
const REASON = 'Cambio de talle';

function world() {
  const db = createInMemorySalesDb({ withSaleExchange: true });
  const companyId = db.insert('company', { name: 'Mona Jacinta', cuit: '00000000000', address: 'Demo', isActive: true, createdAt: new Date() }).id as string;
  db.insert('companyPricingConfig', { companyId });
  const L1 = db.insert('location', { isActive: true }).id as string;
  const L2 = db.insert('location', { isActive: true }).id as string;
  db.insert('branch', { id: L1, code: 'S1', name: 'Sucursal 1' });
  db.insert('branch', { id: L2, code: 'S2', name: 'Sucursal 2' });
  const user = (name: string) => db.insert('user', { name, email: `${name}@test.invalid`, isActive: true }).id as string;
  const ids = { seller: user('seller'), cashier: user('cashier'), admin: user('admin'), owner: user('owner'), warehouse: user('warehouse') };
  const product = db.insert('product', { name: 'Remera', isActive: true }).id as string;
  const variant = (sku: string, cashPrice: bigint) => db.insert('productVariant', {
    productId: product, sku, barcode: sku, cashPrice, price: cashPrice, wholesalePrice: null, costPrice: 1000n, color: 'Negro', size: 'M', isActive: true,
  }).id as string;
  const V = { V1: variant('V1', P1), V2: variant('V2', P2), V3: variant('V3', P1), V4: variant('V4', P4), V5: variant('V5', P5), LOW: variant('LOW', P1), V6: variant('V6', P1) };
  const inventory = (variantId: string, physical: bigint, reserved = 0n) => db.insert('inventory', { branchId: L1, variantId, physical, reserved }).id as string;
  const inv = {
    V1: inventory(V.V1, 100n), V2: inventory(V.V2, 100n), V3: inventory(V.V3, 100n), V4: inventory(V.V4, 100n), V5: inventory(V.V5, 100n),
    LOW: inventory(V.LOW, 3n, 2n), // available = 1
    V6: inventory(V.V6, 100n),
  };
  // A COMPLETED sale mirrors the finalizer: physical consumed, one negative SALE movement per inventory, a CASH payment.
  const completed = (items: Array<[string, bigint, bigint]> = [[V.V1, 2n, P1], [V.V2, 1n, P2]]) => {
    const total = items.reduce((sum, [, quantity, unitPrice]) => sum + quantity * unitPrice, 0n);
    const saleRow = db.insert('sale', {
      branchId: L1, sellerId: ids.seller, status: 'COMPLETED', priceMode: 'CASH', pricingMode: 'LIST', pricingModel: 'FIXED_TOTAL',
      subtotal: total, discountTotal: 0n, total, saleNumber: `T-${randomUUID().slice(0, 8)}`,
    });
    const itemIds: string[] = [];
    for (const [variantId, quantity, unitPrice] of items) {
      itemIds.push(db.insert('saleItem', {
        saleId: saleRow.id, variantId, productId: product, productName: 'Remera', variantName: 'Negro M', sku: variantId, quantity, unitPrice, subtotal: quantity * unitPrice,
      }).id as string);
      const row = db.table('inventory').find((candidate) => candidate.variantId === variantId && candidate.branchId === L1)!;
      row.physical = (row.physical as bigint) - quantity;
      db.insert('stockMovement', { inventoryId: row.id, type: 'SALE', quantityDelta: -quantity, saleId: saleRow.id, userId: ids.cashier, branchId: L1 });
    }
    db.insert('salePayment', { saleId: saleRow.id, method: 'CASH', amount: total, idempotencyKey: randomUUID(), cashSessionId: null, externalCollectionId: null });
    return { saleId: saleRow.id as string, itemIds };
  };
  const invRow = (inventoryId: string) => db.table('inventory').find((row) => row.id === inventoryId)! as Row;
  const money = () => structuredClone({
    salePayment: db.table('salePayment'), cashMovement: db.table('cashMovement'), externalCollection: db.table('externalCollection'),
    sale: db.table('sale'), saleItem: db.table('saleItem'),
  });
  return { db, ids, L1, L2, V, inv, completed, invRow, money };
}
type World = ReturnType<typeof world>;

function authFor(w: World, actor: Actor) {
  const location = (role: Role, locationId: string, permissions?: string[]): Express.ProductionAssignment => ({
    roleId: `${role}-${locationId}`, roleCode: role, scopeKind: 'LOCATION', locationId, permissions: permissions ?? [...DEFAULT_ROLE_GRANTS[role]],
  });
  const company = (role: 'OWNER' | 'ADMIN', permissions: string[] = []): Express.ProductionAssignment => ({
    roleId: `${role}-company`, roleCode: role, scopeKind: 'COMPANY', locationId: null, permissions: role === 'ADMIN' ? permissions : [],
  });
  const table: Record<Exclude<Actor, 'none'>, [string, Express.ProductionAssignment]> = {
    owner: [w.ids.owner, company('OWNER')],
    adminCompany: [w.ids.admin, company('ADMIN', ADMIN_ALL)],
    adminCompanyNoExchange: [w.ids.admin, company('ADMIN', DEFAULT_ROLE_GRANTS.ADMIN.filter((p: string) => p !== 'SALE_EXCHANGE'))],
    adminLocation: [w.ids.admin, location('ADMIN', w.L1, ADMIN_ALL)],
    cashier: [w.ids.cashier, location('CASHIER', w.L1)],
    seller: [w.ids.seller, location('SELLER', w.L1)],
    warehouse: [w.ids.warehouse, location('WAREHOUSE', w.L1)],
  };
  if (actor === 'none') return undefined;
  const [userId, assignment] = table[actor];
  return { userId, roles: [assignment.roleCode], assignments: [assignment], effectiveLocationIds: assignment.locationId ? [assignment.locationId] : [] };
}

function appFor(w: World, options: { actor?: Actor; service?: unknown; failEmit?: boolean } = {}) {
  const emitted: Emitted[] = [];
  const realtime = {
    emit: (event: string, payload: Record<string, unknown>) => {
      if (options.failEmit) throw new Error('socket down');
      emitted.push({ event, payload });
    },
  };
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    const auth = authFor(w, options.actor ?? 'owner');
    if (auth) req.auth = auth as never;
    next();
  });
  server.use('/api/v1/sales', (createCancellationRouter as (...args: unknown[]) => express.Router)(
    w.db.client as unknown as PrismaClient, realtime, options.service ? { saleExchangeService: options.service } : {},
  ));
  server.use(errorHandler);
  return { server, emitted };
}

// `lineOf` builds a VALID HTTP line: the quantity is a decimal string. `rawLine` puts any JSON value there, for the refusals.
const lineOf = (saleItemId: string, replacementVariantId: string, returnQuantity: number | string = 1) => ({ saleItemId, replacementVariantId, returnQuantity: String(returnQuantity) });
const rawLine = (saleItemId: string, replacementVariantId: string, returnQuantity: unknown) => ({ saleItemId, replacementVariantId, returnQuantity });
const body = (lines: unknown[], extra: Row = {}) => ({ reason: REASON, idempotencyKey: randomUUID(), lines, ...extra });
const post = (server: express.Express, saleId: string, payload: unknown) => request(server).post(`/api/v1/sales/${saleId}/exchanges`).send(payload as object);
const errorOf = (response: request.Response) => (response.body.error ?? response.body) as { code?: string };

function recorder(result: Row = {}) {
  const calls: unknown[][] = [];
  const service = {
    exchangeSale: async (...args: unknown[]) => {
      calls.push(args);
      return { saleId: args[1], exchangeId: randomUUID(), branchId: 'b', replayed: false, lines: [], inventories: [], ...result };
    },
  };
  return { service, calls };
}

describe('sale exchange v1 — HTTP: the route and what reaches the service', () => {
  it('HX01 POST /:saleId/exchanges hands (req, saleId, parsed body) to the service; returnQuantity (a decimal string) becomes a BigInt, the key is lowercased', async () => {
    const w = world();
    const { service, calls } = recorder();
    const { server } = appFor(w, { service });
    const saleId = randomUUID();
    const itemId = randomUUID();
    const variantId = randomUUID();
    const key = randomUUID().toUpperCase();
    const response = await post(server, saleId, { reason: `  ${REASON}  `, idempotencyKey: key, lines: [lineOf(itemId, variantId, '2')] });
    expect(response.status).toBe(201);
    expect(calls).toHaveLength(1);
    const [req, id, input] = calls[0]!;
    expect((req as { auth?: { userId: string } }).auth?.userId).toBe(w.ids.owner);
    expect(id).toBe(saleId);
    expect(input).toEqual({ reason: REASON, idempotencyKey: key.toLowerCase(), lines: [{ saleItemId: itemId, replacementVariantId: variantId, returnQuantity: 2n }] });
  });

  it('HX02 invalid bodies die at the edge with 400 VALIDATION_ERROR and never reach the service', async () => {
    const w = world();
    const { service, calls } = recorder();
    const { server } = appFor(w, { service });
    const saleId = randomUUID();
    const okLine = lineOf(randomUUID(), randomUUID());
    const invalid: unknown[] = [
      {}, { reason: REASON, idempotencyKey: randomUUID() }, { ...body([okLine]), lines: [] }, { ...body([okLine]), reason: '   ' }, { ...body([okLine]), reason: 'x'.repeat(201) },
      { ...body([okLine]), idempotencyKey: 'not-a-uuid' }, { ...body([okLine]), extra: 1 }, body([{ ...okLine, extra: 1 }]), body([rawLine(randomUUID(), randomUUID(), '0')]),
      body([rawLine(randomUUID(), randomUUID(), '-1')]), body([rawLine(randomUUID(), randomUUID(), '1.5')]), body([rawLine(randomUUID(), randomUUID(), 'abc')]),
      body([{ saleItemId: 'x', replacementVariantId: okLine.replacementVariantId, returnQuantity: '1' }]),
      body([okLine, okLine]), body([lineOf(randomUUID(), randomUUID(), '9223372036854775808')]),
    ];
    for (const payload of invalid) {
      const response = await post(server, saleId, payload);
      expect(response.status, JSON.stringify(payload)).toBe(400);
      expect(errorOf(response).code).toBe('VALIDATION_ERROR');
    }
    expect((await post(server, 'not-a-uuid', body([okLine]))).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it.each([
    ['true', true], ['[1]', [1]], ['{}', {}], ['null', null], ['1.5', 1.5], ['"1.5"', '1.5'], ['"1e3"', '1e3'], ['" 1"', ' 1'], ['"01"', '01'], ['"+1"', '+1'], ['"0x10"', '0x10'], ['""', ''],
    ['a JSON number 1', 1], ['a JSON number 2', 2], ['a JSON number 1000', 1000], ['a JSON number MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER],
    ['a string above the signed bigint max', '9223372036854775808'], ['a 40-digit string', '1'.repeat(40)],
  ])('HX05 H1: returnQuantity %s -> 400 VALIDATION_ERROR and the service is never called', async (_label, quantity) => {
    const w = world();
    const { service, calls } = recorder();
    const response = await post(appFor(w, { service }).server, randomUUID(), body([rawLine(randomUUID(), randomUUID(), quantity)]));
    expect(response.status).toBe(400);
    expect(errorOf(response).code).toBe('VALIDATION_ERROR');
    expect(calls).toHaveLength(0);
  });

  it('HX06 M-01: canonical decimal STRINGS are accepted and reach the service as exact BigInts', async () => {
    const w = world();
    const { service, calls } = recorder();
    const { server } = appFor(w, { service });
    const [a, b, c, d] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    expect((await post(server, randomUUID(), body([lineOf(a, d, '1')]))).status).toBe(201);
    expect((await post(server, randomUUID(), body([lineOf(b, d, '1000')]))).status).toBe(201);
    expect((await post(server, randomUUID(), body([lineOf(c, d, '9007199254740993')]))).status).toBe(201); // 2^53 + 1, exact because it is a string
    expect((await post(server, randomUUID(), body([lineOf(a, d, '9223372036854775807')]))).status).toBe(201);
    const quantities = calls.map(([, , input]) => (input as { lines: Array<{ returnQuantity: bigint }> }).lines[0]!.returnQuantity);
    expect(quantities).toEqual([1n, 1000n, 9007199254740993n, 9223372036854775807n]);
  });

  // The REAL textual body, not a JS object serialized by the test: `1e3` and 2^53+1 are valid JSON NUMBERS, which the edge refuses outright (no raw-body parsing).
  it.each([
    ['1e3', '1e3'], ['1E3', '1E3'], ['1', '1'], ['2', '2'], ['1000', '1000'], ['9007199254740993', '9007199254740993'], ['1.0', '1.0'], ['-1', '-1'],
  ])('HX08 M-01: a textual JSON body with the NUMBER returnQuantity %s -> 400 VALIDATION_ERROR, the service is never called', async (_label, literal) => {
    const w = world();
    const { service, calls } = recorder();
    const text = `{"reason":"Cambio","idempotencyKey":"${randomUUID()}","lines":[{"saleItemId":"${randomUUID()}","replacementVariantId":"${randomUUID()}","returnQuantity":${literal}}]}`;
    const response = await request(appFor(w, { service }).server).post(`/api/v1/sales/${randomUUID()}/exchanges`).set('Content-Type', 'application/json').send(text);
    expect(response.status).toBe(400);
    expect(errorOf(response).code).toBe('VALIDATION_ERROR');
    expect(calls).toHaveLength(0);
  });

  it('HX07 L1: 101 lines -> 400 VALIDATION_ERROR before any commercial work (the service is never called); 100 lines reach the service', async () => {
    const w = world();
    const { service, calls } = recorder();
    const { server } = appFor(w, { service });
    const many = (count: number) => Array.from({ length: count }, () => lineOf(randomUUID(), randomUUID()));
    const tooMany = await post(server, randomUUID(), body(many(101)));
    expect(tooMany.status).toBe(400);
    expect(errorOf(tooMany).code).toBe('VALIDATION_ERROR');
    expect(calls).toHaveLength(0);
    expect((await post(server, randomUUID(), body(many(100)))).status).toBe(201);
    expect(calls).toHaveLength(1);
  });

  it('HX03 coarse gate: no auth -> 401, a role without SALE_EXCHANGE -> 403, the service is never called', async () => {
    const w = world();
    const { service, calls } = recorder();
    const saleId = randomUUID();
    const payload = body([lineOf(randomUUID(), randomUUID())]);
    expect((await post(appFor(w, { actor: 'none', service }).server, saleId, payload)).status).toBe(401);
    for (const actor of ['cashier', 'seller', 'warehouse', 'adminCompanyNoExchange'] as const) {
      const response = await post(appFor(w, { actor, service }).server, saleId, payload);
      expect(response.status, actor).toBe(403);
    }
    expect(calls).toHaveLength(0);
  });

  it('HX04 the gate runs before the body: an unauthorized caller with an invalid body learns 403, not 400', async () => {
    const w = world();
    const { service } = recorder();
    const response = await post(appFor(w, { actor: 'cashier', service }).server, randomUUID(), {});
    expect(response.status).toBe(403);
  });
});

describe('sale exchange v1 — HTTP: status, body, BigInt and authorization with the REAL service', () => {
  it('HX10 a NEW exchange answers 201 with replayed:false and the exchange; every BigInt is a decimal string; no internal snapshot leaks', async () => {
    const w = world();
    const { saleId, itemIds } = w.completed();
    const { server } = appFor(w);
    const response = await post(server, saleId, body([lineOf(itemIds[0]!, w.V.V3, 2)]));
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ saleId, branchId: w.L1, replayed: false });
    expect(typeof response.body.exchangeId).toBe('string');
    expect(response.body.lines).toEqual([{
      saleItemId: itemIds[0], returnQuantity: '2', replacementVariantId: w.V.V3, originalUnitPrice: '10000', replacementUnitPrice: '10000',
    }]);
    expect(Object.keys(response.body).sort()).toEqual(['branchId', 'exchangeId', 'lines', 'replayed', 'saleId']);
    expect(response.text).not.toMatch(/"(returnQuantity|originalUnitPrice|replacementUnitPrice)":\d/);
    // stock really moved: V1 +2, V3 -2
    expect(w.invRow(w.inv.V1).physical).toBe(100n);
    expect(w.invRow(w.inv.V3).physical).toBe(98n);
  });

  it('HX11 BigInt beyond Number.MAX_SAFE_INTEGER survives as an exact decimal string (a string in the request keeps its precision)', async () => {
    const w = world();
    const huge = 9007199254740993n; // 2^53 + 1
    const { saleId, itemIds } = w.completed([[w.V.V1, huge, P1]]);
    const { server } = appFor(w);
    const response = await post(server, saleId, body([lineOf(itemIds[0]!, w.V.V3, huge.toString())]));
    // the replacement has 100 units only: the refusal itself proves the exact quantity travelled (never rounded to ...992)
    expect(response.status).toBe(409);
    expect(errorOf(response).code).toBe('INSUFFICIENT_STOCK');
  });

  it('HX12 an idempotent replay answers 200 with replayed:true and the SAME exchange; the body equals the first apart from replayed', async () => {
    const w = world();
    const { saleId, itemIds } = w.completed();
    const { server } = appFor(w);
    const payload = body([lineOf(itemIds[0]!, w.V.V3, 1)]);
    const first = await post(server, saleId, payload);
    const physicalAfterFirst = w.invRow(w.inv.V3).physical;
    const second = await post(server, saleId, payload);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.replayed).toBe(true);
    expect(second.body.exchangeId).toBe(first.body.exchangeId);
    expect({ ...second.body, replayed: false }).toEqual(first.body);
    expect(w.invRow(w.inv.V3).physical).toBe(physicalAfterFirst);
  });

  it('HX20 M1: an UPPER-CASE :saleId / ids / key replay a lower-case exchange (200, same exchange) and create-in-upper resolves the sale; no second exchange, no second event', async () => {
    const w = world();
    const { saleId, itemIds } = w.completed();
    const { server, emitted } = appFor(w);
    const key = randomUUID();
    const first = await post(server, saleId, body([lineOf(itemIds[0]!, w.V.V3)], { idempotencyKey: key }));
    expect(first.status).toBe(201);
    const replay = await post(server, saleId.toUpperCase(), body([lineOf(itemIds[0]!.toUpperCase(), w.V.V3.toUpperCase())], { idempotencyKey: key.toUpperCase() }));
    expect(replay.status).toBe(200);
    expect(replay.body.exchangeId).toBe(first.body.exchangeId);
    expect(w.db.table('saleExchange')).toHaveLength(1);
    expect(emitted).toHaveLength(1);
    const other = w.completed();
    const created = await post(server, other.saleId.toUpperCase(), body([lineOf(other.itemIds[0]!.toUpperCase(), w.V.V3.toUpperCase())]));
    expect(created.status).toBe(201);
    expect(created.body.saleId).toBe(other.saleId);
  });

  it('HX13 OWNER and a COMPANY ADMIN holding SALE_EXCHANGE are allowed', async () => {
    for (const actor of ['owner', 'adminCompany'] as const) {
      const w = world();
      const { saleId, itemIds } = w.completed();
      const response = await post(appFor(w, { actor }).server, saleId, body([lineOf(itemIds[0]!, w.V.V3)]));
      expect(response.status, actor).toBe(201);
    }
  });

  it('HX14 a LOCATION ADMIN passes the coarse gate and is refused by the SERVICE with 403 FORBIDDEN; nothing is written, nothing emitted', async () => {
    const w = world();
    const { saleId, itemIds } = w.completed();
    const before = structuredClone(w.db.allTables());
    const { server, emitted } = appFor(w, { actor: 'adminLocation' });
    const response = await post(server, saleId, body([lineOf(itemIds[0]!, w.V.V3)]));
    expect(response.status).toBe(403);
    expect(errorOf(response).code).toBe('FORBIDDEN');
    expect(w.db.allTables()).toEqual(before);
    expect(emitted).toEqual([]);
  });

  it('HX15 CASHIER / SELLER / WAREHOUSE are refused 403 before the service and write nothing', async () => {
    const w = world();
    const { saleId, itemIds } = w.completed();
    const before = structuredClone(w.db.allTables());
    for (const actor of ['cashier', 'seller', 'warehouse'] as const) {
      const { server, emitted } = appFor(w, { actor });
      expect((await post(server, saleId, body([lineOf(itemIds[0]!, w.V.V3)]))).status).toBe(403);
      expect(emitted).toEqual([]);
    }
    expect(w.db.allTables()).toEqual(before);
  });

  it('HX16 domain AppErrors keep their status and code; each refusal writes nothing and emits nothing', async () => {
    const w = world();
    const { saleId, itemIds } = w.completed(); // V1 x2 (item 0), V2 x1 (item 1)
    const other = w.completed();
    const exchanged = w.completed([[w.V.V1, 1n, P1]]);
    const { server: seed } = appFor(w);
    expect((await post(seed, exchanged.saleId, body([lineOf(exchanged.itemIds[0]!, w.V.V3)]))).status).toBe(201);
    const cases: Array<[string, string, unknown, number, string]> = [
      ['SALE_ITEM_MISMATCH', saleId, body([lineOf(other.itemIds[0]!, w.V.V3)]), 409, 'SALE_ITEM_MISMATCH'],
      ['NO_OP_EXCHANGE', saleId, body([lineOf(itemIds[0]!, w.V.V1)]), 409, 'NO_OP_EXCHANGE'],
      ['EXCHANGE_QUANTITY_EXCEEDED', saleId, body([lineOf(itemIds[0]!, w.V.V3, 3)]), 409, 'EXCHANGE_QUANTITY_EXCEEDED'],
      ['REPLACEMENT_CHEAPER_NOT_SUPPORTED', saleId, body([lineOf(itemIds[0]!, w.V.V5)]), 409, 'REPLACEMENT_CHEAPER_NOT_SUPPORTED'],
      ['REPLACEMENT_MORE_EXPENSIVE_NOT_SUPPORTED', saleId, body([lineOf(itemIds[0]!, w.V.V4)]), 409, 'REPLACEMENT_MORE_EXPENSIVE_NOT_SUPPORTED'],
      ['INSUFFICIENT_STOCK', saleId, body([lineOf(itemIds[0]!, w.V.LOW, 2)]), 409, 'INSUFFICIENT_STOCK'],
      ['NOT_FOUND', randomUUID(), body([lineOf(itemIds[0]!, w.V.V3)]), 404, 'NOT_FOUND'],
    ];
    for (const [label, id, payload, status, code] of cases) {
      const before = structuredClone(w.db.allTables());
      const { server, emitted } = appFor(w);
      const response = await post(server, id, payload);
      expect([label, response.status, errorOf(response).code]).toEqual([label, status, code]);
      expect(w.db.allTables(), label).toEqual(before);
      expect(emitted, label).toEqual([]);
    }
  });

  it('HX17 a reused key with another intent -> 409 IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD and nothing is emitted', async () => {
    const w = world();
    const { saleId, itemIds } = w.completed();
    const key = randomUUID();
    expect((await post(appFor(w).server, saleId, body([lineOf(itemIds[0]!, w.V.V3)], { idempotencyKey: key }))).status).toBe(201);
    const { server, emitted } = appFor(w);
    const response = await post(server, saleId, body([lineOf(itemIds[0]!, w.V.V3, 2)], { idempotencyKey: key }));
    expect(response.status).toBe(409);
    expect(errorOf(response).code).toBe('IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD');
    expect(emitted).toEqual([]);
  });

  it('HX18 INVALID_SALE_STATE for a non-COMPLETED sale and SALE_HAS_EXCHANGES-style refusals keep the service code', async () => {
    const w = world();
    const { saleId, itemIds } = w.completed();
    w.db.table('sale').find((row) => row.id === saleId)!.status = 'CANCELLED';
    const { server, emitted } = appFor(w);
    const response = await post(server, saleId, body([lineOf(itemIds[0]!, w.V.V3)]));
    expect(response.status).toBe(409);
    expect(errorOf(response).code).toBe('INVALID_SALE_STATE');
    expect(emitted).toEqual([]);
  });

  it('HX19 an unexpected non-AppError never leaks: 500 INTERNAL_ERROR through the error middleware', async () => {
    const w = world();
    const service = { exchangeSale: async () => { throw new Error('boom: secret'); } };
    const response = await post(appFor(w, { service }).server, randomUUID(), body([lineOf(randomUUID(), randomUUID())]));
    expect(response.status).toBe(500);
    expect(response.text).not.toContain('secret');
  });
});

describe('sale exchange v1 — realtime inventory.updated', () => {
  it('HR01 a NEW exchange emits exactly one inventory.updated, to the sale branch, with the FINAL state of the two inventories it modified', async () => {
    const w = world();
    const { saleId, itemIds } = w.completed();
    const { server, emitted } = appFor(w);
    const response = await post(server, saleId, body([lineOf(itemIds[0]!, w.V.V3, 2)]));
    expect(response.status).toBe(201);
    expect(emitted.map((e) => e.event)).toEqual(['inventory.updated']);
    const payload = emitted[0]!.payload as { branchId: string; saleId: string; exchangeId: string; inventories: Array<Row> };
    expect(payload).toMatchObject({ branchId: w.L1, saleId, exchangeId: response.body.exchangeId });
    expect([...payload.inventories].sort((a, b) => String(a.inventoryId).localeCompare(String(b.inventoryId)))).toEqual([
      { inventoryId: w.inv.V1, variantId: w.V.V1, physical: 100n, reserved: 0n },
      { inventoryId: w.inv.V3, variantId: w.V.V3, physical: 98n, reserved: 0n },
    ].sort((a, b) => a.inventoryId.localeCompare(b.inventoryId)));
    // only inventories the exchange really modified
    expect(payload.inventories.map((row) => row.inventoryId)).not.toContain(w.inv.V2);
  });

  it('HR02 an idempotent replay emits NOTHING', async () => {
    const w = world();
    const { saleId, itemIds } = w.completed();
    const { server, emitted } = appFor(w);
    const payload = body([lineOf(itemIds[0]!, w.V.V3)]);
    expect((await post(server, saleId, payload)).status).toBe(201);
    expect(emitted).toHaveLength(1);
    expect((await post(server, saleId, payload)).status).toBe(200);
    expect(emitted).toHaveLength(1);
  });

  it('HR03 a refusal (validation, gate, service) emits NOTHING', async () => {
    const w = world();
    const { saleId, itemIds } = w.completed();
    const { server, emitted } = appFor(w);
    await post(server, saleId, {});
    await post(server, saleId, body([lineOf(itemIds[0]!, w.V.V4)]));
    await post(server, randomUUID(), body([lineOf(itemIds[0]!, w.V.V3)]));
    await post(appFor(w, { actor: 'cashier' }).server, saleId, body([lineOf(itemIds[0]!, w.V.V3)]));
    expect(emitted).toEqual([]);
  });

  it('HR04 two lines that swap INTO the same replacement inventory emit ONE entry for it, with its final physical', async () => {
    const w = world();
    const { saleId, itemIds } = w.completed([[w.V.V1, 1n, P1], [w.V.V3, 1n, P1]]);
    const { server, emitted } = appFor(w);
    const response = await post(server, saleId, body([lineOf(itemIds[0]!, w.V.V6, 1), lineOf(itemIds[1]!, w.V.V6, 1)]));
    expect(response.status).toBe(201);
    expect(emitted.map((e) => e.event)).toEqual(['inventory.updated']);
    const inventories = (emitted[0]!.payload as { inventories: Row[] }).inventories;
    expect(inventories.map((row) => row.inventoryId as string).sort()).toEqual([w.inv.V1, w.inv.V3, w.inv.V6].sort());
    expect(inventories.find((row) => row.inventoryId === w.inv.V6)).toEqual({ inventoryId: w.inv.V6, variantId: w.V.V6, physical: 98n, reserved: 0n });
    expect(w.invRow(w.inv.V6).physical).toBe(98n);
  });

  it('HR05 the same inventory in IN and OUT of one request (cross-swap) is emitted ONCE with its final physical, and every id appears once', async () => {
    const w = world();
    // item0: V1 x3, item1: V3 x2 (both priced P1). Lines: V1 -> V3 (x2) and V3 -> V1 (x1).
    const { saleId, itemIds } = w.completed([[w.V.V1, 3n, P1], [w.V.V3, 2n, P1]]);
    expect([w.invRow(w.inv.V1).physical, w.invRow(w.inv.V3).physical]).toEqual([97n, 98n]);
    const { server, emitted } = appFor(w);
    const response = await post(server, saleId, body([lineOf(itemIds[0]!, w.V.V3, 2), lineOf(itemIds[1]!, w.V.V1, 1)]));
    expect(response.status).toBe(201);
    expect(emitted.map((e) => e.event)).toEqual(['inventory.updated']);
    const inventories = (emitted[0]!.payload as { inventories: Row[] }).inventories;
    const ids = inventories.map((row) => row.inventoryId as string);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual([w.inv.V1, w.inv.V3].sort());
    // V1: +2 (returned) -1 (replacement) = 98; V3: +1 (returned) -2 (replacement) = 97 (final states, not the intermediate ones)
    const byId = Object.fromEntries(inventories.map((row) => [row.inventoryId as string, row]));
    expect(byId[w.inv.V1]).toEqual({ inventoryId: w.inv.V1, variantId: w.V.V1, physical: 98n, reserved: 0n });
    expect(byId[w.inv.V3]).toEqual({ inventoryId: w.inv.V3, variantId: w.V.V3, physical: 97n, reserved: 0n });
    expect(w.invRow(w.inv.V1).physical).toBe(98n);
    expect(w.invRow(w.inv.V3).physical).toBe(97n);
  });

  it('HR06 a failing socket never turns the committed exchange into an error response', async () => {
    const w = world();
    const { saleId, itemIds } = w.completed();
    const { server } = appFor(w, { failEmit: true });
    const response = await post(server, saleId, body([lineOf(itemIds[0]!, w.V.V3)]));
    expect(response.status).toBe(201);
    expect(w.invRow(w.inv.V3).physical).toBe(99n);
  });

  it('HR07 the notification happens AFTER the service returned (post-commit): the stock is already moved when the emit runs', async () => {
    const w = world();
    const { saleId, itemIds } = w.completed();
    const seen: bigint[] = [];
    const base = appFor(w);
    const realtime = { emit: () => { seen.push(w.invRow(w.inv.V3).physical as bigint); } };
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => { req.auth = authFor(w, 'owner') as never; next(); });
    server.use('/api/v1/sales', createCancellationRouter(w.db.client as unknown as PrismaClient, realtime));
    server.use(errorHandler);
    expect(base.emitted).toEqual([]);
    expect((await post(server, saleId, body([lineOf(itemIds[0]!, w.V.V3)]))).status).toBe(201);
    expect(seen).toEqual([99n]);
  });

  it('HR08 an exchange whose service throws after partial work (injected) emits nothing and the route adds no write of its own', async () => {
    const w = world();
    const before = structuredClone(w.db.allTables());
    const service = { exchangeSale: async () => { throw new AppError(409, 'CONCURRENCY_ERROR', 'x'); } };
    const { server, emitted } = appFor(w, { service });
    const response = await post(server, randomUUID(), body([lineOf(randomUUID(), randomUUID())]));
    expect(response.status).toBe(409);
    expect(errorOf(response).code).toBe('CONCURRENCY_ERROR');
    expect(emitted).toEqual([]);
    expect(w.db.allTables()).toEqual(before);
  });
});

describe('sale exchange v1 — HTTP: no money side effects', () => {
  it('HM01 a NEW exchange and its replay write no SalePayment / CashMovement / ExternalCollection and leave Sale and SaleItem untouched', async () => {
    const w = world();
    const { saleId, itemIds } = w.completed();
    const before = w.money();
    const { server } = appFor(w);
    const payload = body([lineOf(itemIds[0]!, w.V.V3, 2), lineOf(itemIds[1]!, w.V.V2, 1)]);
    expect((await post(server, saleId, payload)).status).toBe(409); // V2 -> V2 is a no-op
    expect(w.money()).toEqual(before);
    const ok = body([lineOf(itemIds[0]!, w.V.V3, 2)]);
    expect((await post(server, saleId, ok)).status).toBe(201);
    expect((await post(server, saleId, ok)).status).toBe(200);
    expect(w.money()).toEqual(before);
    expect(w.db.table('saleExchange')).toHaveLength(1);
  });
});
