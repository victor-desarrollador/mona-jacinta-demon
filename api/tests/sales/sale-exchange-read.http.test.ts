// Sale exchange v1 — the read the Cambios UI needs: GET /api/v1/sales/exchangeable?branchId=&saleNumber=. DB-FREE.
//
// The REAL router, validation, authorization and error middlewares run on the in-memory store (tests/helpers/in-memory-sales-db.ts,
// `withSaleExchange`), plus the REAL exchange service for the parity cases (the read must agree with what POST /exchanges accepts).
//
// CONTRACT pinned:
//   - GET only, registered next to (and BEFORE) GET /:saleId, so `exchangeable` is never parsed as a sale id;
//   - coarse SALE_EXCHANGE gate (401 / 403), then the definitive supervisor decision (OWNER, or a COMPANY-scoped ADMIN holding SALE_EXCHANGE)
//     against the REQUESTED branch BEFORE any lookup: a caller who is not the supervisor learns nothing about the sale (same 403 whether it exists or not);
//   - lookup by (branchId, saleNumber), the sale's own unique key; another branch's sale with the same number is never returned;
//   - answers the sale, `exchangeable` (status === COMPLETED) and one row per SaleItem with sold / exchanged / remaining quantities;
//   - every BigInt leaves as a decimal string, exactly (no Number);
//   - informational and read-only: no lock, nothing written (no ledger, no audit, no money); POST /exchanges stays the only authority;
//   - the remainder agrees with POST: `remainingQuantity` is accepted, one more is refused with EXCHANGE_QUANTITY_EXCEEDED.
import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { errorHandler } from '../../src/middleware/errorHandler.js';
import { createCancellationRouter } from '../../src/modules/sales/cancellation.routes.js';
import { createSalesRouter } from '../../src/modules/sales/sales.routes.js';
import { DEFAULT_ROLE_GRANTS } from '../../src/modules/rbac/role-permission-matrix.js';
import { createInMemorySalesDb } from '../helpers/in-memory-sales-db.js';

type Role = 'CASHIER' | 'SELLER' | 'WAREHOUSE' | 'ADMIN';
type Actor = 'owner' | 'adminCompany' | 'adminCompanyNoExchange' | 'adminLocation' | 'cashier' | 'seller' | 'warehouse' | 'none';

const P = 10000n;
const ADMIN_ALL = [...DEFAULT_ROLE_GRANTS.ADMIN, 'SALE_EXCHANGE'];

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
  const variant = (sku: string) => db.insert('productVariant', {
    productId: product, sku, barcode: sku, cashPrice: P, price: P, wholesalePrice: null, costPrice: 1000n, color: 'Negro', size: 'M', isActive: true,
  }).id as string;
  const V = { A: variant('A'), B: variant('B'), C: variant('C') };
  for (const variantId of Object.values(V)) db.insert('inventory', { branchId: L1, variantId, physical: 100n, reserved: 0n });
  let counter = 0;
  const sale = (items: Array<[string, bigint]>, overrides: Record<string, unknown> = {}) => {
    counter += 1;
    const total = items.reduce((sum, [, quantity]) => sum + quantity * P, 0n);
    const row = db.insert('sale', {
      branchId: L1, sellerId: ids.seller, status: 'COMPLETED', priceMode: 'CASH', pricingMode: 'LIST', pricingModel: 'FIXED_TOTAL',
      subtotal: total, discountTotal: 0n, total, saleNumber: `T-${counter}`, ...overrides,
    });
    const itemIds = items.map(([variantId, quantity]) => db.insert('saleItem', {
      saleId: row.id, variantId, productId: product, productName: 'Remera', variantName: 'Negro M', sku: variantId, quantity, unitPrice: P, subtotal: quantity * P,
    }).id as string);
    return { saleId: row.id as string, saleNumber: row.saleNumber as string, itemIds };
  };
  return { db, ids, L1, L2, V, sale };
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

function appFor(w: World, actor: Actor = 'owner') {
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    const auth = authFor(w, actor);
    if (auth) req.auth = auth as never;
    next();
  });
  server.use('/api/v1/sales', (createCancellationRouter as (...args: unknown[]) => express.Router)(w.db.client as unknown as PrismaClient, undefined, {}));
  server.use(errorHandler);
  return server;
}

// The REAL composition of the sales module, where GET /exchangeable (cancellation router) and GET /:saleId (sales router) live together.
function realSalesApp(w: World, actor: Actor = 'owner') {
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    const auth = authFor(w, actor);
    if (auth) req.auth = auth as never;
    next();
  });
  server.use('/api/v1/sales', createSalesRouter(w.db.client as unknown as PrismaClient, undefined, { wholesaleVerifier: { configured: false, verify: async () => false } }));
  server.use(errorHandler);
  return server;
}

const read = (server: express.Express, query: Record<string, string>) => request(server).get('/api/v1/sales/exchangeable').query(query);
const post = (server: express.Express, saleId: string, lines: unknown[]) =>
  request(server).post(`/api/v1/sales/${saleId}/exchanges`).send({ reason: 'Cambio de talle', idempotencyKey: randomUUID(), lines });
const errorOf = (response: request.Response) => (response.body.error ?? response.body) as { code?: string };
const exchangeLine = (saleItemId: string, replacementVariantId: string, returnQuantity: number | string | bigint) => ({ saleItemId, replacementVariantId, returnQuantity: String(returnQuantity) });

describe('sale exchange read — GET /sales/exchangeable', () => {
  it('ER01 a supervisor reads a COMPLETED sale: sale, exchangeable:true and one row per item with sold / exchanged 0 / remaining, all decimal strings', async () => {
    const w = world();
    const { saleNumber, saleId, itemIds } = w.sale([[w.V.A, 3n], [w.V.B, 1n]]);
    const response = await read(appFor(w), { branchId: w.L1, saleNumber });
    expect(response.status).toBe(200);
    expect(response.body.sale).toMatchObject({ id: saleId, saleNumber, branchId: w.L1, status: 'COMPLETED', pricingMode: 'LIST', priceMode: 'CASH', total: String(4n * P) });
    expect(response.body.exchangeable).toBe(true);
    expect(response.body.lines).toHaveLength(2);
    const byId = new Map((response.body.lines as Array<Record<string, string>>).map((line) => [line.saleItemId, line]));
    expect(byId.get(itemIds[0]!)).toMatchObject({
      saleItemId: itemIds[0], variantId: w.V.A, productName: 'Remera', variantName: 'Negro M', sku: w.V.A,
      quantity: '3', unitPrice: String(P), exchangedQuantity: '0', remainingQuantity: '3',
    });
    expect(byId.get(itemIds[1]!)).toMatchObject({ quantity: '1', exchangedQuantity: '0', remainingQuantity: '1' });
  });

  it('ER02 the remainder is the sold quantity minus EVERY earlier exchange of that item (two exchanges add up)', async () => {
    const w = world();
    const server = appFor(w);
    const { saleNumber, saleId, itemIds } = w.sale([[w.V.A, 5n]]);
    expect((await post(server, saleId, [exchangeLine(itemIds[0]!, w.V.B, 1)])).status).toBe(201);
    expect((await post(server, saleId, [exchangeLine(itemIds[0]!, w.V.C, 2)])).status).toBe(201);
    const response = await read(server, { branchId: w.L1, saleNumber });
    expect(response.body.lines[0]).toMatchObject({ quantity: '5', exchangedQuantity: '3', remainingQuantity: '2' });
    expect(response.body.exchangeable).toBe(true);
  });

  it('ER03 a sale that is not COMPLETED is answered with exchangeable:false (the UI can say why) and its quantities', async () => {
    const w = world();
    const { saleNumber } = w.sale([[w.V.A, 2n]], { status: 'PENDING_PAYMENT' });
    const response = await read(appFor(w), { branchId: w.L1, saleNumber });
    expect(response.status).toBe(200);
    expect(response.body.exchangeable).toBe(false);
    expect(response.body.sale.status).toBe('PENDING_PAYMENT');
    expect(response.body.lines[0]).toMatchObject({ quantity: '2', exchangedQuantity: '0', remainingQuantity: '2' });
  });

  it('ER04 a COMPANY ADMIN holding SALE_EXCHANGE reads the same as the OWNER', async () => {
    const w = world();
    const { saleNumber } = w.sale([[w.V.A, 1n]]);
    const response = await read(appFor(w, 'adminCompany'), { branchId: w.L1, saleNumber });
    expect(response.status).toBe(200);
  });

  it('ER05 anyone who is not the exchange supervisor gets the SAME 403 whether the sale exists or not, and nothing about it', async () => {
    const w = world();
    const { saleNumber } = w.sale([[w.V.A, 1n]]);
    // Authorization comes BEFORE the lookup: nothing about the sale may be read for a caller who is not the supervisor.
    const client = w.db.client as unknown as Record<string, Record<string, (...args: unknown[]) => unknown>>;
    const lookups = [vi.spyOn(client.sale!, 'findFirst'), vi.spyOn(client.saleItem!, 'findMany'), vi.spyOn(client.saleExchangeLine!, 'findMany')];
    for (const actor of ['cashier', 'seller', 'warehouse', 'adminLocation', 'adminCompanyNoExchange'] as const) {
      const server = appFor(w, actor);
      const existing = await read(server, { branchId: w.L1, saleNumber });
      const missing = await read(server, { branchId: w.L1, saleNumber: 'NO-EXISTE' });
      expect(existing.status, actor).toBe(403);
      expect(missing.status, actor).toBe(403);
      expect(existing.body, actor).toEqual(missing.body);
      expect(JSON.stringify(existing.body), actor).not.toContain(saleNumber);
      for (const lookup of lookups) expect(lookup, actor).not.toHaveBeenCalled();
    }
  });

  it('ER06 unauthenticated is 401', async () => {
    const w = world();
    const { saleNumber } = w.sale([[w.V.A, 1n]]);
    expect((await read(appFor(w, 'none'), { branchId: w.L1, saleNumber })).status).toBe(401);
  });

  it('ER07 a supervisor asking for a saleNumber that does not exist in that branch gets 404', async () => {
    const w = world();
    w.sale([[w.V.A, 1n]]);
    const response = await read(appFor(w), { branchId: w.L1, saleNumber: 'NO-EXISTE' });
    expect(response.status).toBe(404);
    expect(errorOf(response).code).toBe('NOT_FOUND');
  });

  it('ER08 the lookup is keyed by branch: the same number in another branch is never returned', async () => {
    const w = world();
    const mine = w.sale([[w.V.A, 1n]], { saleNumber: 'DUP-1' });
    w.sale([[w.V.B, 7n]], { saleNumber: 'DUP-1', branchId: w.L2 });
    const response = await read(appFor(w), { branchId: w.L1, saleNumber: 'DUP-1' });
    expect(response.body.sale.id).toBe(mine.saleId);
    expect(response.body.sale.branchId).toBe(w.L1);
    expect(response.body.lines).toHaveLength(1);
  });

  it('ER09 invalid query is 400: missing or non-UUID branchId, blank or missing saleNumber, unknown keys', async () => {
    const w = world();
    const server = appFor(w);
    for (const query of [
      {}, { branchId: w.L1 }, { saleNumber: 'T-1' }, { branchId: 'nope', saleNumber: 'T-1' },
      { branchId: w.L1, saleNumber: '   ' }, { branchId: w.L1, saleNumber: 'T-1', extra: '1' },
    ]) {
      const response = await read(server, query as Record<string, string>);
      expect(response.status, JSON.stringify(query)).toBe(400);
    }
  });

  it('ER10 in the REAL sales router both routes coexist: /exchangeable reaches its own handler and GET /:saleId still reaches the draft handler', async () => {
    const w = world();
    const { saleNumber, saleId } = w.sale([[w.V.A, 1n]]);
    const server = realSalesApp(w);

    const exchangeable = await read(server, { branchId: w.L1, saleNumber });
    expect(exchangeable.status).toBe(200);
    expect(exchangeable.body.sale.id).toBe(saleId); // the exchange read's body, not a sale-detail body
    expect(Array.isArray(exchangeable.body.lines)).toBe(true);

    // GET /:saleId is the DRAFT reader: a COMPLETED sale is refused by ITS handler with SALE_NOT_DRAFT (not by the validator, not by 404).
    // (as the sale's own seller, who is authorized to open it: the refusal that remains is the handler's own)
    const detail = await request(realSalesApp(w, 'seller')).get(`/api/v1/sales/${saleId}`);
    expect(detail.status).toBe(409);
    expect(errorOf(detail).code).toBe('SALE_NOT_DRAFT');

    // and `exchangeable` is not mistaken for a sale id even without the query: it fails ITS validation, not the :saleId UUID check.
    const bare = await request(server).get('/api/v1/sales/exchangeable');
    expect(bare.status).toBe(400);
    expect(JSON.stringify(bare.body)).not.toContain('saleId');
  });

  it('ER11 quantities beyond 2^53 leave exactly, as decimal strings', async () => {
    const w = world();
    const { saleNumber } = w.sale([[w.V.A, 9007199254740993n]]);
    const response = await read(appFor(w), { branchId: w.L1, saleNumber });
    expect(response.body.lines[0]).toMatchObject({ quantity: '9007199254740993', exchangedQuantity: '0', remainingQuantity: '9007199254740993' });
  });

  it('ER12 it is read-only: no table changes, no ledger, audit or money row appears', async () => {
    const w = world();
    const { saleNumber } = w.sale([[w.V.A, 2n]]);
    const snapshot = () => JSON.stringify(Object.fromEntries(
      (['sale', 'saleItem', 'inventory', 'stockMovement', 'saleExchange', 'saleExchangeLine', 'salePayment', 'cashMovement', 'auditLog'] as const)
        .map((name) => [name, w.db.table(name)]),
      ), (_key, value) => (typeof value === 'bigint' ? value.toString() : value));
    const before = snapshot();
    expect((await read(appFor(w), { branchId: w.L1, saleNumber })).status).toBe(200);
    expect(snapshot()).toBe(before);
  });

  it('ER13 parity with POST: the reported remainder is accepted, one more is refused with EXCHANGE_QUANTITY_EXCEEDED', async () => {
    const w = world();
    const server = appFor(w);
    const { saleNumber, saleId, itemIds } = w.sale([[w.V.A, 3n]]);
    await post(server, saleId, [exchangeLine(itemIds[0]!, w.V.B, 1)]);
    const remaining = (await read(server, { branchId: w.L1, saleNumber })).body.lines[0].remainingQuantity as string;
    expect(remaining).toBe('2');
    const tooMany = await post(server, saleId, [exchangeLine(itemIds[0]!, w.V.C, BigInt(remaining) + 1n)]);
    expect(tooMany.status).toBe(409);
    expect(errorOf(tooMany).code).toBe('EXCHANGE_QUANTITY_EXCEEDED');
    expect((await post(server, saleId, [exchangeLine(itemIds[0]!, w.V.C, remaining)])).status).toBe(201);
    const after = (await read(server, { branchId: w.L1, saleNumber })).body.lines[0];
    expect(after).toMatchObject({ exchangedQuantity: '3', remainingQuantity: '0' });
  });
});
