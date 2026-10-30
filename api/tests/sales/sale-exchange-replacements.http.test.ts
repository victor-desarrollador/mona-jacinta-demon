// Sale exchange v1 — replacement candidates for the Cambios UI: GET /api/v1/sales/:saleId/exchange-replacements?branchId=&saleItemId=. DB-FREE.
//
// The REAL router, validation, authorization and error middlewares run on the in-memory store (tests/helpers/in-memory-sales-db.ts,
// `withSaleExchange`), plus the REAL exchange service for the parity cases: the preview must say exactly what POST /exchanges will do.
//
// CONTRACT pinned:
//   - GET only; coarse SALE_EXCHANGE gate (401 / 403), then params/query shape (400, strict), then the definitive supervisor decision (OWNER, or a
//     COMPANY-scoped ADMIN holding SALE_EXCHANGE) against the REQUESTED branch BEFORE any lookup: same 403 whether the sale exists or not;
//   - the sale is found by (id, branchId) and must be COMPLETED; the SaleItem must belong to it;
//   - each candidate carries the replacement unit price computed by the SAME function POST uses (unitPriceFor + the pricing snapshot, with the
//     sale's pricingMode / priceMode), and `comparison` against that SaleItem's unitPrice (compareReplacementPrice);
//   - candidates are active variants of active products with a base price for the sale's pricingMode, never the variant already on that SaleItem;
//     CHEAPER, MORE_EXPENSIVE and zero-stock candidates ARE returned (the UI explains why they do not work);
//   - available = max(physical - reserved, 0) of the Inventory in the SALE's branch, "0" without an Inventory row; every BigInt is a decimal string;
//   - read-only: nothing is written, no row lock, no transaction.
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
const adjust = (base: bigint, bps: number) => (base * (10000n + BigInt(bps)) + 5000n) / 10000n;

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
  const inactiveProduct = db.insert('product', { name: 'Remera vieja', isActive: false }).id as string;
  const variant = (sku: string, overrides: Record<string, unknown> = {}, productId = product) => db.insert('productVariant', {
    productId, sku, barcode: `BC-${sku}`, cashPrice: P, price: P, wholesalePrice: null, costPrice: 1000n, color: 'Negro', size: 'M', isActive: true, ...overrides,
  }).id as string;
  const stock = (variantId: string, physical: bigint, reserved = 0n, branchId = L1) => db.insert('inventory', { branchId, variantId, physical, reserved });
  // A = what the sale sold. B equal, C cheaper, D more expensive (retail cash).
  const V = {
    A: variant('A-NEGRO-M'), B: variant('B-NEGRO-L', { size: 'L' }), C: variant('C-ROJO-M', { color: 'Rojo', cashPrice: P - 100n }),
    D: variant('D-AZUL-M', { color: 'Azul', cashPrice: P + 100n }),
  };
  for (const variantId of Object.values(V)) stock(variantId, 100n);
  let counter = 0;
  const sale = (items: Array<[string, bigint]>, overrides: Record<string, unknown> = {}, unitPrice = P) => {
    counter += 1;
    const total = items.reduce((sum, [, quantity]) => sum + quantity * unitPrice, 0n);
    const row = db.insert('sale', {
      branchId: L1, sellerId: ids.seller, status: 'COMPLETED', priceMode: 'CASH', pricingMode: 'LIST', pricingModel: 'FIXED_TOTAL',
      subtotal: total, discountTotal: 0n, total, saleNumber: `T-${counter}`, ...overrides,
    });
    const itemIds = items.map(([variantId, quantity]) => db.insert('saleItem', {
      saleId: row.id, variantId, productId: product, productName: 'Remera', variantName: 'Negro M', sku: variantId, quantity, unitPrice, subtotal: quantity * unitPrice,
    }).id as string);
    return { saleId: row.id as string, saleNumber: row.saleNumber as string, itemIds };
  };
  const config = () => db.table('companyPricingConfig')[0]!;
  return { db, ids, L1, L2, V, product, inactiveProduct, variant, stock, sale, config };
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

// The REAL composition of the sales module: the new GET must win over GET /:saleId.
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

const list = (server: express.Express, saleId: string, query: Record<string, string>) =>
  request(server).get(`/api/v1/sales/${saleId}/exchange-replacements`).query(query);
const post = (server: express.Express, saleId: string, lines: unknown[]) =>
  request(server).post(`/api/v1/sales/${saleId}/exchanges`).send({ reason: 'Cambio de talle', idempotencyKey: randomUUID(), lines });
const errorOf = (response: request.Response) => (response.body.error ?? response.body) as { code?: string };
type Candidate = { id: string; productId: string; sku: string; barcode: string | null; color: string | null; size: string | null; product: { id: string; name: string };
  available: string; replacementUnitPrice: string; comparison: string };
const itemsOf = (response: request.Response) => response.body.items as Candidate[];
const skus = (response: request.Response) => itemsOf(response).map((item) => item.sku);
const bySku = (response: request.Response, sku: string) => itemsOf(response).find((item) => item.sku === sku);
const stringify = (value: unknown) => JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? `${item}n` : item));

describe('sale exchange replacements — GET /sales/:saleId/exchange-replacements', () => {
  it('RR01 without SALE_EXCHANGE the answer is 403 (and 401 without authentication)', async () => {
    const w = world();
    const { saleId, itemIds } = w.sale([[w.V.A, 1n]]);
    const query = { branchId: w.L1, saleItemId: itemIds[0]! };
    for (const actor of ['cashier', 'seller', 'warehouse', 'adminCompanyNoExchange'] as const) {
      const response = await list(appFor(w, actor), saleId, query);
      expect(response.status, actor).toBe(403);
    }
    expect((await list(appFor(w, 'none'), saleId, query)).status).toBe(401);
  });

  it('RR02 holding SALE_EXCHANGE is not enough: a LOCATION-scoped ADMIN is never the supervisor, at its own branch or another', async () => {
    const w = world();
    const { saleId, itemIds } = w.sale([[w.V.A, 1n]]);
    expect((await list(appFor(w, 'adminLocation'), saleId, { branchId: w.L1, saleItemId: itemIds[0]! })).status).toBe(403);
    expect((await list(appFor(w, 'adminLocation'), saleId, { branchId: w.L2, saleItemId: itemIds[0]! })).status).toBe(403);
  });

  it('RR03 authorization runs BEFORE the lookup: a non-supervisor gets the same 403 for an existing sale and for one that does not exist', async () => {
    const w = world();
    const { saleId, itemIds } = w.sale([[w.V.A, 1n]]);
    const server = appFor(w, 'adminLocation');
    const existing = await list(server, saleId, { branchId: w.L1, saleItemId: itemIds[0]! });
    const missing = await list(server, randomUUID(), { branchId: w.L1, saleItemId: randomUUID() });
    expect(existing.status).toBe(403);
    expect(missing.status).toBe(403);
    expect(errorOf(missing).code).toBe(errorOf(existing).code);
    expect(missing.body).toEqual(existing.body);
  });

  it('RR04 the sale is found by (id, branchId): another branch or an unknown id is 404', async () => {
    const w = world();
    const { saleId, itemIds } = w.sale([[w.V.A, 1n]]);
    const server = appFor(w);
    const otherBranch = await list(server, saleId, { branchId: w.L2, saleItemId: itemIds[0]! });
    expect(otherBranch.status).toBe(404);
    expect(errorOf(otherBranch).code).toBe('NOT_FOUND');
    expect((await list(server, randomUUID(), { branchId: w.L1, saleItemId: itemIds[0]! })).status).toBe(404);
  });

  it('RR05 a sale that is not COMPLETED is 409 INVALID_SALE_STATE', async () => {
    const w = world();
    const { saleId, itemIds } = w.sale([[w.V.A, 1n]], { status: 'PENDING_PAYMENT' });
    const response = await list(appFor(w), saleId, { branchId: w.L1, saleItemId: itemIds[0]! });
    expect(response.status).toBe(409);
    expect(errorOf(response).code).toBe('INVALID_SALE_STATE');
  });

  it('RR06 a saleItemId of another sale, or an unknown one, is 409 SALE_ITEM_MISMATCH', async () => {
    const w = world();
    const first = w.sale([[w.V.A, 1n]]);
    const second = w.sale([[w.V.A, 1n]]);
    const server = appFor(w);
    for (const saleItemId of [second.itemIds[0]!, randomUUID()]) {
      const response = await list(server, first.saleId, { branchId: w.L1, saleItemId });
      expect(response.status).toBe(409);
      expect(errorOf(response).code).toBe('SALE_ITEM_MISMATCH');
    }
  });

  it('RR07 LIST + CASH: the replacement price is the variant cashPrice, and the sale/item context is echoed', async () => {
    const w = world();
    const { saleId, saleNumber, itemIds } = w.sale([[w.V.A, 2n]]);
    const response = await list(appFor(w), saleId, { branchId: w.L1, saleItemId: itemIds[0]! });
    expect(response.status).toBe(200);
    expect(response.body.sale).toEqual({ id: saleId, saleNumber, branchId: w.L1, pricingMode: 'LIST', priceMode: 'CASH' });
    expect(response.body.saleItem).toEqual({ id: itemIds[0], variantId: w.V.A, originalUnitPrice: String(P) });
    expect(bySku(response, 'B-NEGRO-L')).toMatchObject({
      id: w.V.B, productId: w.product, barcode: 'BC-B-NEGRO-L', color: 'Negro', size: 'L', product: { id: w.product, name: 'Remera' },
      replacementUnitPrice: String(P), comparison: 'EQUAL',
    });
  });

  it('RR08 LIST + CARD / TRANSFER / QR / LIST mode applies the pricing-config adjustment of THAT mode', async () => {
    const cases = [['CREDIT_CARD', 'creditCardAdjustmentBps', 1000], ['DEBIT_CARD', 'debitCardAdjustmentBps', 500],
      ['BANK_TRANSFER', 'bankTransferAdjustmentBps', 250], ['QR', 'qrAdjustmentBps', 1500], ['LIST', 'listAdjustmentBps', 700]] as const;
    for (const [priceMode, column, bps] of cases) {
      const w = world();
      w.config()[column] = bps;
      const { saleId, itemIds } = w.sale([[w.V.A, 1n]], { priceMode }, adjust(P, bps));
      const response = await list(appFor(w), saleId, { branchId: w.L1, saleItemId: itemIds[0]! });
      expect(response.status, priceMode).toBe(200);
      expect(bySku(response, 'B-NEGRO-L'), priceMode).toMatchObject({ replacementUnitPrice: String(adjust(P, bps)), comparison: 'EQUAL' });
      expect(bySku(response, 'C-ROJO-M'), priceMode).toMatchObject({ replacementUnitPrice: String(adjust(P - 100n, bps)), comparison: 'CHEAPER' });
      expect(bySku(response, 'D-AZUL-M'), priceMode).toMatchObject({ replacementUnitPrice: String(adjust(P + 100n, bps)), comparison: 'MORE_EXPENSIVE' });
    }
  });

  it('RR09 WHOLESALE prices from wholesalePrice; a variant without one is not offered', async () => {
    const w = world();
    w.db.table('productVariant').find((row) => row.id === w.V.B)!.wholesalePrice = 8000n;
    w.db.table('productVariant').find((row) => row.id === w.V.C)!.wholesalePrice = 7000n;
    w.db.table('productVariant').find((row) => row.id === w.V.D)!.wholesalePrice = 9000n;
    const { saleId, itemIds } = w.sale([[w.V.A, 1n]], { pricingMode: 'WHOLESALE' }, 8000n);
    const response = await list(appFor(w), saleId, { branchId: w.L1, saleItemId: itemIds[0]! });
    expect(response.status).toBe(200);
    expect(response.body.sale.pricingMode).toBe('WHOLESALE');
    expect(skus(response).sort()).toEqual(['B-NEGRO-L', 'C-ROJO-M', 'D-AZUL-M']);
    expect(bySku(response, 'B-NEGRO-L')).toMatchObject({ replacementUnitPrice: '8000', comparison: 'EQUAL' });
    expect(bySku(response, 'C-ROJO-M')).toMatchObject({ replacementUnitPrice: '7000', comparison: 'CHEAPER' });
    expect(bySku(response, 'D-AZUL-M')).toMatchObject({ replacementUnitPrice: '9000', comparison: 'MORE_EXPENSIVE' });
  });

  it('RR10 an equal price is EQUAL', async () => {
    const w = world();
    const { saleId, itemIds } = w.sale([[w.V.A, 1n]]);
    expect(bySku(await list(appFor(w), saleId, { branchId: w.L1, saleItemId: itemIds[0]! }), 'B-NEGRO-L')?.comparison).toBe('EQUAL');
  });

  it('RR11 a cheaper replacement is CHEAPER and is still listed', async () => {
    const w = world();
    const { saleId, itemIds } = w.sale([[w.V.A, 1n]]);
    expect(bySku(await list(appFor(w), saleId, { branchId: w.L1, saleItemId: itemIds[0]! }), 'C-ROJO-M')).toMatchObject({ comparison: 'CHEAPER', replacementUnitPrice: String(P - 100n) });
  });

  it('RR12 a more expensive replacement is MORE_EXPENSIVE and is still listed', async () => {
    const w = world();
    const { saleId, itemIds } = w.sale([[w.V.A, 1n]]);
    expect(bySku(await list(appFor(w), saleId, { branchId: w.L1, saleItemId: itemIds[0]! }), 'D-AZUL-M')).toMatchObject({ comparison: 'MORE_EXPENSIVE', replacementUnitPrice: String(P + 100n) });
  });

  it('RR13 PARITY with POST /exchanges: what the preview says is exactly what the real exchange service does, price included', async () => {
    const outcomes: Record<string, string> = {};
    for (const sku of ['B-NEGRO-L', 'C-ROJO-M', 'D-AZUL-M']) {
      const w = world();
      const server = appFor(w);
      const { saleId, itemIds } = w.sale([[w.V.A, 1n]]);
      const preview = bySku(await list(server, saleId, { branchId: w.L1, saleItemId: itemIds[0]! }), sku)!;
      const replacementVariantId = preview.id;
      const exchange = await post(server, saleId, [{ saleItemId: itemIds[0]!, replacementVariantId, returnQuantity: '1' }]);
      if (preview.comparison === 'EQUAL') {
        expect(exchange.status).toBe(201);
        expect(exchange.body.lines[0].replacementUnitPrice).toBe(preview.replacementUnitPrice);
        expect(exchange.body.lines[0].originalUnitPrice).toBe(String(P));
        outcomes[preview.comparison] = 'accepted';
      } else {
        expect(exchange.status).toBe(409);
        outcomes[preview.comparison] = errorOf(exchange).code!;
      }
    }
    expect(outcomes).toEqual({
      EQUAL: 'accepted', CHEAPER: 'REPLACEMENT_CHEAPER_NOT_SUPPORTED', MORE_EXPENSIVE: 'REPLACEMENT_MORE_EXPENSIVE_NOT_SUPPORTED',
    });
  });

  it('RR14 every BigInt leaves as a decimal string, exactly (a price above 2^53 keeps its last centavo)', async () => {
    const w = world();
    const huge = 9007199254740993n;
    w.db.table('productVariant').find((row) => row.id === w.V.B)!.cashPrice = huge;
    const inventory = w.db.table('inventory').find((row) => row.variantId === w.V.B)!;
    inventory.physical = 9007199254740995n;
    inventory.reserved = 2n;
    const { saleId, itemIds } = w.sale([[w.V.A, 1n]]);
    const response = await list(appFor(w), saleId, { branchId: w.L1, saleItemId: itemIds[0]! });
    const candidate = bySku(response, 'B-NEGRO-L')!;
    expect(candidate.replacementUnitPrice).toBe('9007199254740993');
    expect(candidate.available).toBe('9007199254740993');
    expect(typeof response.body.saleItem.originalUnitPrice).toBe('string');
    expect(response.body.pagination).toEqual({ page: 1, limit: 20, total: 3 });
  });

  it('RR15 a variant of an inactive product is not offered', async () => {
    const w = world();
    const hidden = w.variant('Z-VIEJA', {}, w.inactiveProduct);
    w.stock(hidden, 10n);
    const { saleId, itemIds } = w.sale([[w.V.A, 1n]]);
    expect(skus(await list(appFor(w), saleId, { branchId: w.L1, saleItemId: itemIds[0]! }))).not.toContain('Z-VIEJA');
  });

  it('RR16 an inactive variant is not offered', async () => {
    const w = world();
    w.stock(w.variant('Y-INACTIVA', { isActive: false }), 10n);
    const { saleId, itemIds } = w.sale([[w.V.A, 1n]]);
    expect(skus(await list(appFor(w), saleId, { branchId: w.L1, saleItemId: itemIds[0]! }))).not.toContain('Y-INACTIVA');
  });

  it('RR17 a variant without a base price for the sale pricing mode is not offered (LIST needs cashPrice)', async () => {
    const w = world();
    w.stock(w.variant('X-SINPRECIO', { cashPrice: null }), 10n);
    const { saleId, itemIds } = w.sale([[w.V.A, 1n]]);
    const response = await list(appFor(w), saleId, { branchId: w.L1, saleItemId: itemIds[0]! });
    expect(skus(response)).not.toContain('X-SINPRECIO');
    expect(skus(response).sort()).toEqual(['B-NEGRO-L', 'C-ROJO-M', 'D-AZUL-M']);
  });

  it('RR18 the variant already on that SaleItem is never offered (POST would answer NO_OP_EXCHANGE)', async () => {
    const w = world();
    const { saleId, itemIds } = w.sale([[w.V.A, 1n]]);
    expect(skus(await list(appFor(w), saleId, { branchId: w.L1, saleItemId: itemIds[0]! }))).not.toContain('A-NEGRO-M');
  });

  it('RR19 a variant with no Inventory row in the sale branch IS offered, with available "0"', async () => {
    const w = world();
    w.variant('N-SINSTOCK');
    const { saleId, itemIds } = w.sale([[w.V.A, 1n]]);
    expect(bySku(await list(appFor(w), saleId, { branchId: w.L1, saleItemId: itemIds[0]! }), 'N-SINSTOCK')).toMatchObject({ available: '0', comparison: 'EQUAL' });
  });

  it('RR20 available = max(physical - reserved, 0) of the SALE branch only', async () => {
    const w = world();
    const inventoryOf = (variantId: string) => w.db.table('inventory').find((row) => row.variantId === variantId && row.branchId === w.L1)!;
    inventoryOf(w.V.B).physical = 10n;
    inventoryOf(w.V.B).reserved = 3n;
    inventoryOf(w.V.C).physical = 2n;
    inventoryOf(w.V.C).reserved = 5n; // reserved above physical: never negative
    w.stock(w.V.D, 500n, 0n, w.L2); // another branch's stock is not this sale's
    inventoryOf(w.V.D).physical = 4n;
    const { saleId, itemIds } = w.sale([[w.V.A, 1n]]);
    const response = await list(appFor(w), saleId, { branchId: w.L1, saleItemId: itemIds[0]! });
    expect(bySku(response, 'B-NEGRO-L')?.available).toBe('7');
    expect(bySku(response, 'C-ROJO-M')?.available).toBe('0');
    expect(bySku(response, 'D-AZUL-M')?.available).toBe('4');
  });

  it('RR21 search matches sku, barcode, color, size and product name, case-insensitively', async () => {
    const w = world();
    const { saleId, itemIds } = w.sale([[w.V.A, 1n]]);
    const server = appFor(w);
    const search = async (text: string) => skus(await list(server, saleId, { branchId: w.L1, saleItemId: itemIds[0]!, search: text }));
    expect(await search('c-rojo')).toEqual(['C-ROJO-M']);
    expect(await search('BC-D-AZUL')).toEqual(['D-AZUL-M']);
    expect(await search('rojo')).toEqual(['C-ROJO-M']);
    expect(await search('azul')).toEqual(['D-AZUL-M']);
    expect((await search('remera')).sort()).toEqual(['B-NEGRO-L', 'C-ROJO-M', 'D-AZUL-M']);
    expect(await search('no-existe')).toEqual([]);
  });

  it('RR22 pagination: page, limit and total over the filtered candidates, ordered by sku', async () => {
    const w = world();
    const { saleId, itemIds } = w.sale([[w.V.A, 1n]]);
    const server = appFor(w);
    const first = await list(server, saleId, { branchId: w.L1, saleItemId: itemIds[0]!, page: '1', limit: '2' });
    const second = await list(server, saleId, { branchId: w.L1, saleItemId: itemIds[0]!, page: '2', limit: '2' });
    expect(skus(first)).toEqual(['B-NEGRO-L', 'C-ROJO-M']);
    expect(skus(second)).toEqual(['D-AZUL-M']);
    expect(first.body.pagination).toEqual({ page: 1, limit: 2, total: 3 });
    expect(second.body.pagination).toEqual({ page: 2, limit: 2, total: 3 });
  });

  it('RR23 the shape is strict: unknown keys, missing branchId / saleItemId, a bad limit or a bad id are 400', async () => {
    const w = world();
    const { saleId, itemIds } = w.sale([[w.V.A, 1n]]);
    const server = appFor(w);
    const good = { branchId: w.L1, saleItemId: itemIds[0]! };
    const invalid: Array<Record<string, string>> = [{ ...good, extra: '1' }, { branchId: w.L1 }, { saleItemId: itemIds[0]! }, { ...good, limit: '101' }, { ...good, limit: '0' },
      { ...good, page: '0' }, { ...good, search: '' }, { ...good, branchId: 'no-es-uuid' }];
    for (const query of invalid) {
      const response = await list(server, saleId, query);
      expect(response.status, JSON.stringify(query)).toBe(400);
      expect(errorOf(response).code).toBe('VALIDATION_ERROR');
    }
    expect((await list(server, 'no-es-uuid', good)).status).toBe(400);
  });

  it('RR24 it is read-only: nothing is written, no row lock is taken and no transaction is opened', async () => {
    const w = world();
    const { saleId, itemIds } = w.sale([[w.V.A, 3n]]);
    const transaction = vi.spyOn(w.db.client as { $transaction: (...args: unknown[]) => unknown }, '$transaction');
    const before = stringify(w.db.allTables());
    const lockStatements = w.db.rawQueries.length;
    const response = await list(appFor(w), saleId, { branchId: w.L1, saleItemId: itemIds[0]!, search: 'negro' });
    expect(response.status).toBe(200);
    expect(stringify(w.db.allTables())).toBe(before);
    expect(w.db.rawQueries.length).toBe(lockStatements);
    expect(transaction).not.toHaveBeenCalled();
    const tables = w.db.allTables();
    expect(tables.stockMovement).toHaveLength(0);
    expect(tables.auditLog).toHaveLength(0);
    expect(tables.saleExchange).toHaveLength(0);
    expect(tables.stockReservation).toHaveLength(0);
  });

  it('RR25 in the real sales router the path reaches this handler, not GET /:saleId', async () => {
    const w = world();
    const { saleId, itemIds } = w.sale([[w.V.A, 1n]]);
    const response = await list(realSalesApp(w), saleId, { branchId: w.L1, saleItemId: itemIds[0]! });
    expect(response.status).toBe(200);
    expect(response.body.items).toBeDefined();
    expect(response.body.saleItem.id).toBe(itemIds[0]);
  });
});
