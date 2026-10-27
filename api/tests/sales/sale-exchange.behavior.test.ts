// Sale exchange v1 — COMPLETED sale -> garment swap linked to the original Sale/SaleItem: RED behavior contract.
//
// DB-FREE: the REAL service (not written yet) runs on tests/helpers/in-memory-sales-db.ts (`withSaleExchange`),
// so no query reaches a database. Serializable races / PostgreSQL constraints belong to a later *.pg.test.ts.
//
// WHY EACH TEST FAILS TODAY: src/modules/sales/sale-exchange.service.ts does not exist. The module is loaded
// lazily INSIDE each test, so every test fails on its own with "sale-exchange service is not implemented".
// The harness sanity tests (H01..H06) test the FIXTURES and pass today.
//
// OWNER DECISIONS pinned here (sale-exchange-v1):
//   1. COMPLETED sales only. Anything else -> 409 INVALID_SALE_STATE.
//   2. Stock: the returned variant gets physical +N, the replacement physical -N, in the SALE's branch, never
//      negative. Availability of the replacement = physical - reserved, measured on the stock BEFORE the request
//      (units returned by the same request never count as availability). Lines may be partial; earlier exchanges
//      reduce what is still exchangeable.
//   3. MONEY: V1 moves NO money and leaves NO debt. Only EQUAL VALUE per line is allowed:
//        replacementUnitPrice === originalUnitPrice -> allowed
//        replacementUnitPrice  <  originalUnitPrice -> 409 REPLACEMENT_CHEAPER_NOT_SUPPORTED
//        replacementUnitPrice  >  originalUnitPrice -> 409 REPLACEMENT_MORE_EXPENSIVE_NOT_SUPPORTED
//      original price = SaleItem.unitPrice (historical snapshot); replacement price = the CURRENT price, computed
//      with the original sale's pricing context, and frozen in SaleExchangeLine. Lines are never netted. No
//      CashMovement / SalePayment / ExternalCollection is written; Sale, SaleItem and SalePayment are immutable.
//      (Charging a difference is Exchange V1.1: durable and atomic in the same operation.)
//   4. reason trimmed 1..200; idempotencyKey UUID v4; idempotency is per (sale, key): same intent -> replay,
//      different intent (lines or reason) -> 409 IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD.
//   5. Permission SALE_EXCHANGE: OWNER, or ADMIN with a COMPANY scope holding it. 403 otherwise.
//   6. One Serializable transaction, retried on P2034 / 40001 / 40P01 (3 attempts), then 409 CONCURRENCY_ERROR.
//      Lock order: Sale -> Inventory (all involved rows in ONE statement ordered by id).
//   7. AuditLog SALE_EXCHANGED in the same transaction.
//   8. Same variant (same Inventory) -> 409 NO_OP_EXCHANGE.
//   9. 400 VALIDATION_ERROR for shape/input, 409 for domain rules.
//
// CONTRACT NAMES chosen here (the implementation may refine them; then these tests follow):
//   src/modules/sales/sale-exchange.service.ts
//     createSaleExchangeService(database).exchangeSale(req, saleId, input) -> ExchangeResult   (types below)
//   StockMovement.type SALE_EXCHANGE_IN (+N) / SALE_EXCHANGE_OUT (-N) with saleExchangeId.
//   error codes: 403 FORBIDDEN, 404 NOT_FOUND, 400 VALIDATION_ERROR, 409 INVALID_SALE_STATE, SALE_ITEM_MISMATCH,
//     EXCHANGE_QUANTITY_EXCEEDED, NO_OP_EXCHANGE, REPLACEMENT_CHEAPER_NOT_SUPPORTED,
//     REPLACEMENT_MORE_EXPENSIVE_NOT_SUPPORTED, INSUFFICIENT_STOCK (existing),
//     IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD, CONCURRENCY_ERROR (existing).
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { AppError } from '../../src/shared/errors.js';
import { DEFAULT_ROLE_GRANTS } from '../../src/modules/rbac/role-permission-matrix.js';
import { createInMemorySalesDb } from '../helpers/in-memory-sales-db.js';

type Row = Record<string, unknown>;
type ExchangeLineInput = { saleItemId: string; returnQuantity: bigint; replacementVariantId: string };
type ExchangeInput = { reason: string; idempotencyKey: string; lines: ExchangeLineInput[] };
type ExchangeResult = {
  saleId: string;
  exchangeId: string;
  branchId: string;
  replayed: boolean;
  lines: Array<{
    saleItemId: string;
    returnQuantity: bigint;
    replacementVariantId: string;
    originalUnitPrice: bigint;
    replacementUnitPrice: bigint;
  }>;
};
type ExchangeService = { exchangeSale: (req: Request, saleId: string, input: ExchangeInput) => Promise<ExchangeResult> };

// Lazy on purpose: while the module does not exist EACH test fails on its own, with a clear message.
async function loadService(client: PrismaClient): Promise<ExchangeService> {
  let mod: { createSaleExchangeService?: (database: PrismaClient) => ExchangeService };
  try {
    mod = (await import('../../src/modules/sales/sale-exchange.service.js')) as typeof mod;
  } catch {
    throw new Error('sale-exchange service is not implemented: src/modules/sales/sale-exchange.service.ts does not exist yet');
  }
  if (typeof mod.createSaleExchangeService !== 'function') throw new Error('sale-exchange service is not implemented: createSaleExchangeService is not exported');
  return mod.createSaleExchangeService(client);
}

type Role = 'CASHIER' | 'SELLER' | 'WAREHOUSE' | 'ADMIN';
const locationAssignment = (role: Role, locationId: string, permissions?: string[]): Express.ProductionAssignment => ({
  roleId: `${role}-${locationId}`, roleCode: role, scopeKind: 'LOCATION', locationId, permissions: permissions ?? [...DEFAULT_ROLE_GRANTS[role]],
});
const companyAssignment = (role: 'OWNER' | 'ADMIN', permissions?: string[]): Express.ProductionAssignment => ({
  roleId: `${role}-company`, roleCode: role, scopeKind: 'COMPANY', locationId: null, permissions: role === 'ADMIN' ? (permissions ?? []) : [],
});
function requestFor(userId: string, assignments: Express.ProductionAssignment[]): Request {
  const effectiveLocationIds = assignments.flatMap(({ locationId }) => (locationId ? [locationId] : []));
  return { auth: { userId, roles: assignments.map(({ roleCode }) => roleCode), assignments, effectiveLocationIds } } as unknown as Request;
}

const P1 = 10000n; // V1 (sold), V3 (equal), LOW (equal)
const P2 = 5000n;  // V2 (sold)
const P4 = 15000n; // V4: dearer than V1
const P5 = 7000n;  // V5: cheaper than V1
// SALE_EXCHANGE is in CATALOG_38 (ADMIN grant); the grants are still built explicitly here so these DB-free tests do not depend on the catalog.
const ADMIN_ALL = [...DEFAULT_ROLE_GRANTS.ADMIN, 'SALE_EXCHANGE'];

function setup() {
  const db = createInMemorySalesDb({ withSaleExchange: true });
  const companyId = db.insert('company', { name: 'Mona Jacinta', cuit: '00000000000', address: 'Demo', isActive: true, createdAt: new Date() }).id as string;
  db.insert('companyPricingConfig', { companyId }); // every adjustment is 0 bps -> price = cashPrice
  const L1 = db.insert('location', { isActive: true }).id as string;
  const L2 = db.insert('location', { isActive: true }).id as string;
  db.insert('branch', { id: L1, code: 'S1', name: 'Sucursal 1' });
  db.insert('branch', { id: L2, code: 'S2', name: 'Sucursal 2' });
  const user = (name: string) => db.insert('user', { name, email: `${name}@test.invalid`, isActive: true }).id as string;
  const ids = { seller: user('seller'), cashier: user('cashier'), admin: user('admin'), owner: user('owner'), warehouse: user('warehouse') };
  const product = db.insert('product', { name: 'Remera', isActive: true }).id as string;
  const inactiveProduct = db.insert('product', { name: 'Vieja', isActive: false }).id as string;
  const variant = (sku: string, cashPrice: bigint) => db.insert('productVariant', {
    productId: product, sku, barcode: sku, cashPrice, price: cashPrice, wholesalePrice: null, costPrice: 1000n, color: 'Negro', size: 'M', isActive: true,
  }).id as string;
  // Same price as V1 (equal swap) but unavailable: a retired variant, and a live variant under a retired product.
  const inactiveVariant = db.insert('productVariant', {
    productId: product, sku: 'OFF', barcode: 'OFF', cashPrice: P1, price: P1, wholesalePrice: null, costPrice: 1000n, color: 'Negro', size: 'M', isActive: false,
  }).id as string;
  const variantOfInactiveProduct = db.insert('productVariant', {
    productId: inactiveProduct, sku: 'OFFP', barcode: 'OFFP', cashPrice: P1, price: P1, wholesalePrice: null, costPrice: 1000n, color: 'Negro', size: 'M', isActive: true,
  }).id as string;
  const V = { V1: variant('V1', P1), V2: variant('V2', P2), V3: variant('V3', P1), V4: variant('V4', P4), V5: variant('V5', P5), LOW: variant('LOW', P1), V2B: variant('V2B', P2) };
  const inventory = (variantId: string, physical: bigint, reserved = 0n, branchId = L1) =>
    db.insert('inventory', { branchId, variantId, physical, reserved }).id as string;
  const inv = {
    V1: inventory(V.V1, 100n), V2: inventory(V.V2, 100n), V3: inventory(V.V3, 100n), V4: inventory(V.V4, 100n), V5: inventory(V.V5, 100n),
    V2B: inventory(V.V2B, 100n),
    LOW: inventory(V.LOW, 3n, 2n), // available = 3 - 2 = 1
  };
  const otherBranchV3 = inventory(V.V3, 100n, 0n, L2);

  const reqs = {
    owner: requestFor(ids.owner, [companyAssignment('OWNER')]),
    adminCompany: requestFor(ids.admin, [companyAssignment('ADMIN', ADMIN_ALL)]),
    adminCompanyNoExchange: requestFor(ids.admin, [companyAssignment('ADMIN', DEFAULT_ROLE_GRANTS.ADMIN.filter((p: string) => p !== 'SALE_EXCHANGE'))]),
    adminLocation: requestFor(ids.admin, [locationAssignment('ADMIN', L1, ADMIN_ALL)]),
    cashier: requestFor(ids.cashier, [locationAssignment('CASHIER', L1)]),
    seller: requestFor(ids.seller, [locationAssignment('SELLER', L1)]),
    warehouse: requestFor(ids.warehouse, [locationAssignment('WAREHOUSE', L1)]),
  };

  // A sale in `status`; COMPLETED mirrors the finalizer (physical consumed, one negative SALE movement per inventory).
  function sale(status: string, items: Array<[string, bigint, bigint]> = [[V.V1, 2n, P1], [V.V2, 1n, P2]]) {
    const total = items.reduce((sum, [, quantity, unitPrice]) => sum + quantity * unitPrice, 0n);
    const saleRow = db.insert('sale', {
      branchId: L1, sellerId: ids.seller, status, priceMode: 'CASH', pricingMode: 'LIST', pricingModel: 'FIXED_TOTAL',
      subtotal: total, discountTotal: 0n, total, saleNumber: `T-${randomUUID().slice(0, 8)}`,
    });
    const itemIds: string[] = [];
    for (const [variantId, quantity, unitPrice] of items) {
      itemIds.push(db.insert('saleItem', {
        saleId: saleRow.id, variantId, productId: product, productName: 'Remera', variantName: 'Negro M', sku: variantId,
        quantity, unitPrice, subtotal: quantity * unitPrice,
      }).id as string);
      if (status === 'COMPLETED') {
        const inventoryRow = db.table('inventory').find((row) => row.variantId === variantId && row.branchId === L1)!;
        inventoryRow.physical = (inventoryRow.physical as bigint) - quantity;
        db.insert('stockMovement', { inventoryId: inventoryRow.id, type: 'SALE', quantityDelta: -quantity, saleId: saleRow.id, userId: ids.cashier, branchId: L1 });
      }
    }
    db.insert('salePayment', { saleId: saleRow.id, method: 'CASH', amount: total, idempotencyKey: randomUUID(), cashSessionId: null, externalCollectionId: null });
    return { saleId: saleRow.id as string, itemIds };
  }
  const completed = (items?: Array<[string, bigint, bigint]>) => sale('COMPLETED', items);

  const client = db.client as unknown as PrismaClient;
  const everything = () => structuredClone(db.allTables());
  const invRow = (inventoryId: string) => db.table('inventory').find((row) => row.id === inventoryId)! as Row;
  const rows = (name: Parameters<typeof db.table>[0]) => db.table(name) as Row[];
  const setPrice = (variantId: string, cashPrice: bigint) => {
    const row = db.table('productVariant').find((candidate) => candidate.id === variantId)!;
    row.cashPrice = cashPrice;
    row.price = cashPrice;
  };
  return { db, client, ids, L1, L2, V, inactiveVariant, variantOfInactiveProduct, inv, otherBranchV3, reqs, sale, completed, everything, invRow, rows, setPrice };
}
type World = ReturnType<typeof setup>;

async function appError(promise: Promise<unknown>) {
  const error = await promise.then(() => null, (cause: unknown) => cause);
  expect(error, 'expected an AppError').toBeInstanceOf(AppError);
  return { status: (error as AppError).status, code: (error as AppError).code };
}
const REASON = 'Cambio de talle';
const line = (saleItemId: string, replacementVariantId: string, returnQuantity = 1n): ExchangeLineInput => ({ saleItemId, returnQuantity, replacementVariantId });
const input = (lines: ExchangeLineInput[], extra: Partial<ExchangeInput> = {}): ExchangeInput => ({ reason: REASON, idempotencyKey: randomUUID(), lines, ...extra });
const auditsOf = (w: World, action = 'SALE_EXCHANGED') => w.rows('auditLog').filter((row) => row.action === action);
const movementsOf = (w: World, type: string) => w.rows('stockMovement').filter((row) => row.type === type);

// ---- harness sanity: FIXTURES only, pass today ------------------------------------------------------------------------------

describe('sale exchange v1 — harness sanity (passes before the feature exists)', () => {
  it('H01 opt-in models exist only with withSaleExchange; the base store is unchanged', () => {
    expect(Object.keys(createInMemorySalesDb().allTables())).not.toContain('saleExchange');
    expect(Object.keys(createInMemorySalesDb({ withSaleVoid: true }).allTables())).not.toContain('saleExchangeLine');
    const w = setup();
    expect(w.rows('saleExchange')).toEqual([]);
    expect(w.rows('saleExchangeLine')).toEqual([]);
  });

  it('H02 COMPLETED fixture: physical consumed, one negative SALE movement per inventory, items linked to the sale', () => {
    const w = setup();
    const { saleId, itemIds } = w.completed();
    expect(w.invRow(w.inv.V1)).toMatchObject({ physical: 98n, reserved: 0n });
    expect(w.invRow(w.inv.V2)).toMatchObject({ physical: 99n, reserved: 0n });
    expect(movementsOf(w, 'SALE').map((row) => row.quantityDelta)).toEqual([-2n, -1n]);
    expect(w.rows('saleItem').filter((row) => row.saleId === saleId).map((row) => row.id)).toEqual(itemIds);
  });

  it('H03 price fixtures: V3 and LOW equal to V1, V4 dearer, V5 cheaper, V2B equal to V2; LOW has 1 available unit (3 physical - 2 reserved)', () => {
    const w = setup();
    const price = (id: string) => w.rows('productVariant').find((row) => row.id === id)!.cashPrice;
    expect([price(w.V.V3), price(w.V.LOW), price(w.V.V4), price(w.V.V5), price(w.V.V2B)]).toEqual([P1, P1, P4, P5, P2]);
    expect(w.invRow(w.inv.LOW)).toMatchObject({ physical: 3n, reserved: 2n });
  });

  it('H04 non-COMPLETED fixtures keep their stock untouched (no SALE movement)', () => {
    const w = setup();
    for (const status of ['DRAFT', 'PENDING_PAYMENT', 'PAID', 'CANCELLED']) w.sale(status);
    expect(movementsOf(w, 'SALE')).toHaveLength(0);
  });

  it('H05 request fixtures: SALE_EXCHANGE is explicit (admin with it vs without it vs location-scoped)', () => {
    const w = setup();
    const permsOf = (req: Request) => (req.auth!.assignments[0] as { permissions: string[] }).permissions;
    expect(permsOf(w.reqs.adminCompany)).toContain('SALE_EXCHANGE');
    expect(permsOf(w.reqs.adminCompanyNoExchange)).not.toContain('SALE_EXCHANGE');
    expect(w.reqs.adminLocation.auth!.assignments[0]).toMatchObject({ scopeKind: 'LOCATION', locationId: w.L1 });
  });

  it('H06 the in-memory transaction restores every table on throw, including the exchange tables', async () => {
    const w = setup();
    const before = w.everything();
    await w.client.$transaction(async (tx) => {
      await (tx as unknown as { saleExchange: { create: (a: unknown) => Promise<unknown> } }).saleExchange.create({ data: { saleId: randomUUID() } });
      throw new Error('boom');
    }).catch(() => undefined);
    expect(w.everything()).toEqual(before);
  });
});

// ---- lookup, state, authorization ---------------------------------------------------------------------------------------------

describe('sale exchange v1 — sale lookup and state', () => {
  it('SX01 unknown sale -> 404 NOT_FOUND', async () => {
    const w = setup();
    expect(await appError((await loadService(w.client)).exchangeSale(w.reqs.owner, randomUUID(), input([line(randomUUID(), w.V.V3)]))))
      .toEqual({ status: 404, code: 'NOT_FOUND' });
  });

  it.each(['DRAFT', 'PENDING_PAYMENT', 'PAID', 'CANCELLED'])('SX02 %s sale -> 409 INVALID_SALE_STATE and nothing is written', async (status) => {
    const w = setup();
    const { saleId, itemIds } = w.sale(status);
    const before = w.everything();
    expect(await appError((await loadService(w.client)).exchangeSale(w.reqs.owner, saleId, input([line(itemIds[0]!, w.V.V3)]))))
      .toEqual({ status: 409, code: 'INVALID_SALE_STATE' });
    expect(w.everything()).toEqual(before);
  });

  it('SX03 a COMPLETED sale is exchangeable and stays COMPLETED; Sale, SaleItem and SalePayment are immutable and NO money row is written', async () => {
    const w = setup();
    const { saleId, itemIds } = w.completed();
    const before = {
      sale: structuredClone(w.rows('sale')), items: structuredClone(w.rows('saleItem')),
      payments: structuredClone(w.rows('salePayment')), cash: structuredClone(w.rows('cashMovement')),
    };
    const result = await (await loadService(w.client)).exchangeSale(w.reqs.owner, saleId, input([line(itemIds[0]!, w.V.V3)]));
    expect(result).toMatchObject({ saleId, branchId: w.L1, replayed: false });
    expect({
      sale: w.rows('sale'), items: w.rows('saleItem'), payments: w.rows('salePayment'), cash: w.rows('cashMovement'),
    }).toEqual(before);
    expect(w.rows('sale')[0]).toMatchObject({ status: 'COMPLETED' });
  });
});

describe('sale exchange v1 — authorization (OWNER or ADMIN COMPANY holding SALE_EXCHANGE)', () => {
  it.each([['cashier'], ['seller'], ['warehouse'], ['adminLocation'], ['adminCompanyNoExchange']] as const)('SX04 %s -> 403 and nothing is written', async (who) => {
    const w = setup();
    const { saleId, itemIds } = w.completed();
    const before = w.everything();
    expect(await appError((await loadService(w.client)).exchangeSale(w.reqs[who], saleId, input([line(itemIds[0]!, w.V.V3)]))))
      .toEqual({ status: 403, code: 'FORBIDDEN' });
    expect(w.everything()).toEqual(before);
  });

  it.each([['owner'], ['adminCompany']] as const)('SX05 %s is authorized', async (who) => {
    const w = setup();
    const { saleId, itemIds } = w.completed();
    const result = await (await loadService(w.client)).exchangeSale(w.reqs[who], saleId, input([line(itemIds[0]!, w.V.V3)]));
    expect(result.replayed).toBe(false);
  });
});

// ---- input validation ---------------------------------------------------------------------------------------------------------

describe('sale exchange v1 — input', () => {
  const cases: Array<[string, (itemId: string, w: World) => ExchangeInput]> = [
    ['empty reason', (i, w) => input([line(i, w.V.V3)], { reason: '' })],
    ['blank reason', (i, w) => input([line(i, w.V.V3)], { reason: '   ' })],
    ['reason > 200', (i, w) => input([line(i, w.V.V3)], { reason: 'x'.repeat(201) })],
    ['non-UUID idempotencyKey', (i, w) => input([line(i, w.V.V3)], { idempotencyKey: 'not-a-uuid' })],
    ['UUID v1 idempotencyKey', (i, w) => input([line(i, w.V.V3)], { idempotencyKey: '6ba7b810-9dad-11d1-80b4-00c04fd430c8' })],
    ['no lines', () => input([])],
    ['non-UUID saleItemId', (_i, w) => input([line('nope', w.V.V3)])],
    ['non-UUID replacementVariantId', (i) => input([line(i, 'nope')])],
    ['returnQuantity 0', (i, w) => input([line(i, w.V.V3, 0n)])],
    ['negative returnQuantity', (i, w) => input([line(i, w.V.V3, -1n)])],
    ['the same saleItem twice', (i, w) => input([line(i, w.V.V3), line(i, w.V.V4)])],
  ];

  it.each(cases)('SX06 %s -> 400 VALIDATION_ERROR and nothing is written', async (_label, build) => {
    const w = setup();
    const { saleId, itemIds } = w.completed();
    const before = w.everything();
    expect(await appError((await loadService(w.client)).exchangeSale(w.reqs.owner, saleId, build(itemIds[0]!, w))))
      .toEqual({ status: 400, code: 'VALIDATION_ERROR' });
    expect(w.everything()).toEqual(before);
  });

  it('SX07 reason is trimmed before it is stored', async () => {
    const w = setup();
    const { saleId, itemIds } = w.completed();
    await (await loadService(w.client)).exchangeSale(w.reqs.owner, saleId, input([line(itemIds[0]!, w.V.V3)], { reason: `  ${REASON}  ` }));
    expect(w.rows('saleExchange')[0]).toMatchObject({ reason: REASON });
  });

  it('SX08 a saleItem of ANOTHER sale -> 409 SALE_ITEM_MISMATCH and nothing is written', async () => {
    const w = setup();
    const a = w.completed();
    const b = w.completed();
    const before = w.everything();
    expect(await appError((await loadService(w.client)).exchangeSale(w.reqs.owner, a.saleId, input([line(b.itemIds[0]!, w.V.V3)]))))
      .toEqual({ status: 409, code: 'SALE_ITEM_MISMATCH' });
    expect(w.everything()).toEqual(before);
  });

  it('SX09 an unknown saleItem id -> 409 SALE_ITEM_MISMATCH', async () => {
    const w = setup();
    const { saleId } = w.completed();
    expect(await appError((await loadService(w.client)).exchangeSale(w.reqs.owner, saleId, input([line(randomUUID(), w.V.V3)]))))
      .toEqual({ status: 409, code: 'SALE_ITEM_MISMATCH' });
  });

  it('SX10 an unknown replacement variant -> 404 NOT_FOUND', async () => {
    const w = setup();
    const { saleId, itemIds } = w.completed();
    expect(await appError((await loadService(w.client)).exchangeSale(w.reqs.owner, saleId, input([line(itemIds[0]!, randomUUID())]))))
      .toEqual({ status: 404, code: 'NOT_FOUND' });
  });

  it.each([['inactiveVariant'], ['variantOfInactiveProduct']] as const)('SX10b replacement %s -> 404 NOT_FOUND and nothing is written', async (which) => {
    const w = setup();
    const { saleId, itemIds } = w.completed();
    const before = w.everything();
    expect(await appError((await loadService(w.client)).exchangeSale(w.reqs.owner, saleId, input([line(itemIds[0]!, w[which])]))))
      .toEqual({ status: 404, code: 'NOT_FOUND' });
    expect(w.everything()).toEqual(before);
  });
});

// ---- exchangeable quantity ----------------------------------------------------------------------------------------------------

describe('sale exchange v1 — exchangeable quantity', () => {
  it('SX11 more units than originally sold -> 409 EXCHANGE_QUANTITY_EXCEEDED and nothing is written', async () => {
    const w = setup();
    const { saleId, itemIds } = w.completed(); // V1 x2
    const before = w.everything();
    expect(await appError((await loadService(w.client)).exchangeSale(w.reqs.owner, saleId, input([line(itemIds[0]!, w.V.V3, 3n)]))))
      .toEqual({ status: 409, code: 'EXCHANGE_QUANTITY_EXCEEDED' });
    expect(w.everything()).toEqual(before);
  });

  it('SX12 a line can be exchanged partially (1 of 2) and the exchange keeps the link to the original SaleItem', async () => {
    const w = setup();
    const { saleId, itemIds } = w.completed();
    const result = await (await loadService(w.client)).exchangeSale(w.reqs.owner, saleId, input([line(itemIds[0]!, w.V.V3, 1n)]));
    expect(w.rows('saleExchange')).toHaveLength(1);
    expect(w.rows('saleExchange')[0]).toMatchObject({ id: result.exchangeId, saleId });
    expect(w.rows('saleExchangeLine')).toHaveLength(1);
    expect(w.rows('saleExchangeLine')[0]).toMatchObject({
      saleExchangeId: result.exchangeId, saleItemId: itemIds[0], replacementVariantId: w.V.V3, returnQuantity: 1n,
    });
  });

  it('SX13 earlier exchanges reduce the remainder: 1 + 1 of 2 is fine, a third unit is refused', async () => {
    const w = setup();
    const { saleId, itemIds } = w.completed(); // V1 x2
    const service = await loadService(w.client);
    await service.exchangeSale(w.reqs.owner, saleId, input([line(itemIds[0]!, w.V.V3, 1n)]));
    await service.exchangeSale(w.reqs.owner, saleId, input([line(itemIds[0]!, w.V.V3, 1n)]));
    const before = w.everything();
    expect(await appError(service.exchangeSale(w.reqs.owner, saleId, input([line(itemIds[0]!, w.V.V3, 1n)]))))
      .toEqual({ status: 409, code: 'EXCHANGE_QUANTITY_EXCEEDED' });
    expect(w.everything()).toEqual(before);
    expect(w.rows('saleExchange')).toHaveLength(2);
  });

  it('SX14 a request that asks for 2 after 1 was already exchanged (remainder 1) is refused whole', async () => {
    const w = setup();
    const { saleId, itemIds } = w.completed();
    const service = await loadService(w.client);
    await service.exchangeSale(w.reqs.owner, saleId, input([line(itemIds[0]!, w.V.V3, 1n)]));
    const before = w.everything();
    expect(await appError(service.exchangeSale(w.reqs.owner, saleId, input([line(itemIds[0]!, w.V.V3, 2n)]))))
      .toEqual({ status: 409, code: 'EXCHANGE_QUANTITY_EXCEEDED' });
    expect(w.everything()).toEqual(before);
  });
});

// ---- pricing: EQUAL VALUE only, no money moves --------------------------------------------------------------------------------

describe('sale exchange v1 — pricing (equal value only; original = SaleItem.unitPrice, replacement = current price, frozen)', () => {
  it('SX15 equal price -> allowed, and the original/replacement unit prices are BigInt snapshots', async () => {
    const w = setup();
    const { saleId, itemIds } = w.completed();
    const result = await (await loadService(w.client)).exchangeSale(w.reqs.owner, saleId, input([line(itemIds[0]!, w.V.V3, 2n)]));
    expect(result.lines).toEqual([{ saleItemId: itemIds[0], returnQuantity: 2n, replacementVariantId: w.V.V3, originalUnitPrice: P1, replacementUnitPrice: P1 }]);
    expect(typeof result.lines[0]!.originalUnitPrice).toBe('bigint');
    expect(w.rows('saleExchangeLine')[0]).toMatchObject({ originalUnitPrice: P1, replacementUnitPrice: P1 });
  });

  it('SX16 more expensive replacement -> 409 REPLACEMENT_MORE_EXPENSIVE_NOT_SUPPORTED and nothing is written (no debt, no cash, no stock)', async () => {
    const w = setup();
    const { saleId, itemIds } = w.completed();
    const before = w.everything();
    expect(await appError((await loadService(w.client)).exchangeSale(w.reqs.owner, saleId, input([line(itemIds[0]!, w.V.V4, 1n)]))))
      .toEqual({ status: 409, code: 'REPLACEMENT_MORE_EXPENSIVE_NOT_SUPPORTED' });
    expect(w.everything()).toEqual(before);
  });

  it('SX17 a multi-line request of equal-price lines is allowed whole (V1->V3 and V2->V2B)', async () => {
    const w = setup();
    const { saleId, itemIds } = w.completed();
    const result = await (await loadService(w.client)).exchangeSale(w.reqs.owner, saleId, input([line(itemIds[0]!, w.V.V3, 1n), line(itemIds[1]!, w.V.V2B, 1n)]));
    expect(result.lines).toHaveLength(2);
    expect(w.rows('saleExchangeLine')).toHaveLength(2);
    expect(w.rows('saleExchangeLine').every((row) => row.originalUnitPrice === row.replacementUnitPrice)).toBe(true);
  });

  it('SX18 cheaper replacement -> 409 REPLACEMENT_CHEAPER_NOT_SUPPORTED and nothing is written (no refund, no credit)', async () => {
    const w = setup();
    const { saleId, itemIds } = w.completed();
    const before = w.everything();
    expect(await appError((await loadService(w.client)).exchangeSale(w.reqs.owner, saleId, input([line(itemIds[0]!, w.V.V5, 1n)]))))
      .toEqual({ status: 409, code: 'REPLACEMENT_CHEAPER_NOT_SUPPORTED' });
    expect(w.everything()).toEqual(before);
  });

  it('SX19 one cheaper line refuses the WHOLE request even if the other line is fine (no netting)', async () => {
    const w = setup();
    const { saleId, itemIds } = w.completed();
    const before = w.everything();
    expect(await appError((await loadService(w.client)).exchangeSale(w.reqs.owner, saleId, input([line(itemIds[0]!, w.V.V5, 1n), line(itemIds[1]!, w.V.V2B, 1n)]))))
      .toEqual({ status: 409, code: 'REPLACEMENT_CHEAPER_NOT_SUPPORTED' });
    expect(w.everything()).toEqual(before);
  });

  it('SX20 one MORE EXPENSIVE line refuses the WHOLE request even if the other line is fine (no netting)', async () => {
    const w = setup();
    const { saleId, itemIds } = w.completed();
    const before = w.everything();
    expect(await appError((await loadService(w.client)).exchangeSale(w.reqs.owner, saleId, input([line(itemIds[0]!, w.V.V3, 1n), line(itemIds[1]!, w.V.V4, 1n)]))))
      .toEqual({ status: 409, code: 'REPLACEMENT_MORE_EXPENSIVE_NOT_SUPPORTED' });
    expect(w.everything()).toEqual(before);
  });

  it('SX21 the ORIGINAL price is the SaleItem snapshot, not the sold variant\'s price today', async () => {
    const w = setup();
    const { saleId, itemIds } = w.completed(); // V1 sold at 10000
    w.setPrice(w.V.V1, 99999n); // the sold variant changed price later: must not matter
    const result = await (await loadService(w.client)).exchangeSale(w.reqs.owner, saleId, input([line(itemIds[0]!, w.V.V3, 1n)]));
    expect(result.lines[0]).toMatchObject({ originalUnitPrice: P1, replacementUnitPrice: P1 });
  });

  it('SX22 the REPLACEMENT price is the CURRENT one: a price change after the sale turns an equal swap into a refusal', async () => {
    const w = setup();
    const { saleId, itemIds } = w.completed();
    const service = await loadService(w.client);
    w.setPrice(w.V.V3, 12000n);
    expect(await appError(service.exchangeSale(w.reqs.owner, saleId, input([line(itemIds[0]!, w.V.V3, 1n)]))))
      .toEqual({ status: 409, code: 'REPLACEMENT_MORE_EXPENSIVE_NOT_SUPPORTED' });
    w.setPrice(w.V.V3, 9000n);
    expect(await appError(service.exchangeSale(w.reqs.owner, saleId, input([line(itemIds[0]!, w.V.V3, 1n)]))))
      .toEqual({ status: 409, code: 'REPLACEMENT_CHEAPER_NOT_SUPPORTED' });
  });

  it('SX23 the replacement price is FROZEN in SaleExchangeLine: after a catalog change a replay returns the stored snapshot, not a repricing', async () => {
    const w = setup();
    const { saleId, itemIds } = w.completed();
    const request = input([line(itemIds[0]!, w.V.V3, 1n)]);
    const service = await loadService(w.client);
    const first = await service.exchangeSale(w.reqs.owner, saleId, request);
    const stored = structuredClone(w.rows('saleExchangeLine'));
    w.setPrice(w.V.V3, 20000n); // would be refused as a NEW exchange
    const replay = await service.exchangeSale(w.reqs.owner, saleId, request);
    expect(replay).toEqual({ ...first, replayed: true, inventories: [] });
    expect(replay.lines[0]).toMatchObject({ originalUnitPrice: P1, replacementUnitPrice: P1 });
    expect(w.rows('saleExchangeLine')).toEqual(stored);
  });

  it('SX24 an exchange writes NO money: no CashMovement, no SalePayment, no difference field anywhere', async () => {
    const w = setup();
    const { saleId, itemIds } = w.completed();
    const cashBefore = w.rows('cashMovement').length;
    const paymentsBefore = w.rows('salePayment').length;
    const result = await (await loadService(w.client)).exchangeSale(w.reqs.owner, saleId, input([line(itemIds[0]!, w.V.V3, 2n)]));
    expect(w.rows('cashMovement')).toHaveLength(cashBefore);
    expect(w.rows('salePayment')).toHaveLength(paymentsBefore);
    expect(Object.keys(w.everything())).not.toContain('externalCollection');
    expect(result).not.toHaveProperty('differenceToCollect');
    expect(w.rows('saleExchange')[0]).not.toHaveProperty('differenceToCollect');
  });
});

// ---- stock --------------------------------------------------------------------------------------------------------------------

describe('sale exchange v1 — stock (+N returned, -N replacement, never negative)', () => {
  it('SX25 physical +N on the returned variant and -N on the replacement, reserved untouched', async () => {
    const w = setup();
    const { saleId, itemIds } = w.completed(); // V1 physical 98
    await (await loadService(w.client)).exchangeSale(w.reqs.owner, saleId, input([line(itemIds[0]!, w.V.V3, 2n)]));
    expect(w.invRow(w.inv.V1)).toMatchObject({ physical: 100n, reserved: 0n });
    expect(w.invRow(w.inv.V3)).toMatchObject({ physical: 98n, reserved: 0n });
  });

  it('SX26 append-only movements: one IN (+N) and one OUT (-N) per line, linked to the exchange; SALE rows untouched', async () => {
    const w = setup();
    const { saleId, itemIds } = w.completed();
    const saleBefore = structuredClone(movementsOf(w, 'SALE'));
    const result = await (await loadService(w.client)).exchangeSale(w.reqs.owner, saleId, input([line(itemIds[0]!, w.V.V3, 2n)]));
    expect(movementsOf(w, 'SALE_EXCHANGE_IN')).toEqual([expect.objectContaining({ inventoryId: w.inv.V1, quantityDelta: 2n, saleId, saleExchangeId: result.exchangeId, branchId: w.L1, userId: w.ids.owner })]);
    expect(movementsOf(w, 'SALE_EXCHANGE_OUT')).toEqual([expect.objectContaining({ inventoryId: w.inv.V3, quantityDelta: -2n, saleId, saleExchangeId: result.exchangeId, branchId: w.L1, userId: w.ids.owner })]);
    expect(movementsOf(w, 'SALE')).toEqual(saleBefore);
  });

  it('SX27 stock is moved in the SALE\'s branch, never in another branch\'s inventory of the same variant', async () => {
    const w = setup();
    const { saleId, itemIds } = w.completed();
    await (await loadService(w.client)).exchangeSale(w.reqs.owner, saleId, input([line(itemIds[0]!, w.V.V3, 1n)]));
    expect(w.invRow(w.otherBranchV3)).toMatchObject({ physical: 100n });
  });

  it('SX28 replacement without enough AVAILABLE stock (physical - reserved) -> 409 INSUFFICIENT_STOCK and full rollback', async () => {
    const w = setup();
    const { saleId, itemIds } = w.completed();
    const before = w.everything();
    expect(await appError((await loadService(w.client)).exchangeSale(w.reqs.owner, saleId, input([line(itemIds[0]!, w.V.LOW, 2n)]))))
      .toEqual({ status: 409, code: 'INSUFFICIENT_STOCK' });
    expect(w.everything()).toEqual(before);
  });

  it('SX29 exactly the available units is enough (LOW: 3 physical - 2 reserved = 1)', async () => {
    const w = setup();
    const { saleId, itemIds } = w.completed();
    await (await loadService(w.client)).exchangeSale(w.reqs.owner, saleId, input([line(itemIds[0]!, w.V.LOW, 1n)]));
    expect(w.invRow(w.inv.LOW)).toMatchObject({ physical: 2n, reserved: 2n });
  });

  it('SX30 replacement with NO inventory row in the branch -> 409 INSUFFICIENT_STOCK', async () => {
    const w = setup();
    const { saleId, itemIds } = w.completed();
    const noStock = w.db.insert('productVariant', {
      productId: w.rows('product')[0]!.id, sku: 'NOSTOCK', barcode: 'NOSTOCK', cashPrice: P1, price: P1, wholesalePrice: null, costPrice: 1n, color: 'Negro', size: 'M', isActive: true,
    }).id as string;
    const before = w.everything();
    expect(await appError((await loadService(w.client)).exchangeSale(w.reqs.owner, saleId, input([line(itemIds[0]!, noStock, 1n)]))))
      .toEqual({ status: 409, code: 'INSUFFICIENT_STOCK' });
    expect(w.everything()).toEqual(before);
  });

  it('SX31 a multi-line request where the SECOND line lacks stock applies NOTHING (all-or-nothing)', async () => {
    const w = setup();
    const { saleId, itemIds } = w.completed();
    const before = w.everything();
    expect(await appError((await loadService(w.client)).exchangeSale(w.reqs.owner, saleId, input([line(itemIds[1]!, w.V.V2B, 1n), line(itemIds[0]!, w.V.LOW, 2n)]))))
      .toEqual({ status: 409, code: 'INSUFFICIENT_STOCK' });
    expect(w.everything()).toEqual(before);
  });

  it('SX32 several lines drawing the SAME replacement are checked together (2 x 1 against 1 available -> refused)', async () => {
    const w = setup();
    // two items of equal price, both swapped for LOW (price P1, 1 available)
    const { saleId, itemIds } = w.completed([[w.V.V1, 1n, P1], [w.V.V3, 1n, P1]]);
    const before = w.everything();
    expect(await appError((await loadService(w.client)).exchangeSale(w.reqs.owner, saleId, input([line(itemIds[0]!, w.V.LOW, 1n), line(itemIds[1]!, w.V.LOW, 1n)]))))
      .toEqual({ status: 409, code: 'INSUFFICIENT_STOCK' });
    expect(w.everything()).toEqual(before);
  });

  it('SX33 units returned by the SAME request never count as availability (cross-swap measured on the stock before the request)', async () => {
    const w = setup();
    // LOW sold x1 -> physical 2, reserved 2 -> available 0. V1 sold x1.
    const { saleId, itemIds } = w.completed([[w.V.LOW, 1n, P1], [w.V.V1, 1n, P1]]);
    const before = w.everything();
    // LOW goes back to the shelf in this very request, but V1 -> LOW must still be judged on available = 0.
    expect(await appError((await loadService(w.client)).exchangeSale(w.reqs.owner, saleId, input([line(itemIds[0]!, w.V.V3, 1n), line(itemIds[1]!, w.V.LOW, 1n)]))))
      .toEqual({ status: 409, code: 'INSUFFICIENT_STOCK' });
    expect(w.everything()).toEqual(before);
  });

  it('SX34 NO-OP: the replacement is the SAME variant (same Inventory) -> 409 NO_OP_EXCHANGE and nothing is written', async () => {
    const w = setup();
    const { saleId, itemIds } = w.completed();
    const before = w.everything();
    expect(await appError((await loadService(w.client)).exchangeSale(w.reqs.owner, saleId, input([line(itemIds[0]!, w.V.V1, 1n)]))))
      .toEqual({ status: 409, code: 'NO_OP_EXCHANGE' });
    expect(w.everything()).toEqual(before);
  });
});

// ---- idempotency --------------------------------------------------------------------------------------------------------------

describe('sale exchange v1 — idempotency (per sale + key)', () => {
  it('SX35 same key + same payload -> replay: same result, nothing duplicated (exchange, lines, movements, audit, stock)', async () => {
    const w = setup();
    const { saleId, itemIds } = w.completed();
    const request = input([line(itemIds[0]!, w.V.V3, 1n)]);
    const service = await loadService(w.client);
    const first = await service.exchangeSale(w.reqs.owner, saleId, request);
    const after = w.everything();
    const replay = await service.exchangeSale(w.reqs.owner, saleId, request);
    expect(replay).toEqual({ ...first, replayed: true, inventories: [] });
    expect(w.everything()).toEqual(after);
    expect(w.rows('saleExchange')).toHaveLength(1);
    expect(auditsOf(w)).toHaveLength(1);
  });

  it('SX36 a retry after the stock changed still replays instead of re-applying', async () => {
    const w = setup();
    const { saleId, itemIds } = w.completed();
    const request = input([line(itemIds[0]!, w.V.V3, 1n)]);
    const service = await loadService(w.client);
    await service.exchangeSale(w.reqs.owner, saleId, request);
    w.invRow(w.inv.V3).physical = 0n;
    expect((await service.exchangeSale(w.reqs.owner, saleId, request)).replayed).toBe(true);
  });

  it('SX37 same key + different lines -> 409 IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD and nothing is written', async () => {
    const w = setup();
    const { saleId, itemIds } = w.completed();
    const key = randomUUID();
    const service = await loadService(w.client);
    await service.exchangeSale(w.reqs.owner, saleId, input([line(itemIds[0]!, w.V.V3, 1n)], { idempotencyKey: key }));
    const before = w.everything();
    for (const different of [line(itemIds[0]!, w.V.V3, 2n), line(itemIds[0]!, w.V.LOW, 1n), line(itemIds[1]!, w.V.V2B, 1n)]) {
      expect(await appError(service.exchangeSale(w.reqs.owner, saleId, input([different], { idempotencyKey: key }))))
        .toEqual({ status: 409, code: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD' });
    }
    expect(w.everything()).toEqual(before);
  });

  it('SX38 same key + different reason -> 409 IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD (the void precedent includes the reason)', async () => {
    const w = setup();
    const { saleId, itemIds } = w.completed();
    const key = randomUUID();
    const service = await loadService(w.client);
    await service.exchangeSale(w.reqs.owner, saleId, input([line(itemIds[0]!, w.V.V3)], { idempotencyKey: key }));
    expect(await appError(service.exchangeSale(w.reqs.owner, saleId, input([line(itemIds[0]!, w.V.V3)], { idempotencyKey: key, reason: 'Otro motivo' }))))
      .toEqual({ status: 409, code: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD' });
  });

  it('SX39 line order does not change the intent (same lines reversed -> replay)', async () => {
    const w = setup();
    const { saleId, itemIds } = w.completed();
    const key = randomUUID();
    const service = await loadService(w.client);
    const a = line(itemIds[0]!, w.V.V3, 1n);
    const b = line(itemIds[1]!, w.V.V2B, 1n);
    await service.exchangeSale(w.reqs.owner, saleId, input([a, b], { idempotencyKey: key }));
    expect((await service.exchangeSale(w.reqs.owner, saleId, input([b, a], { idempotencyKey: key }))).replayed).toBe(true);
  });

  it('SX40 a different key for a new exchange is a NEW exchange (a sale can be exchanged many times)', async () => {
    const w = setup();
    const { saleId, itemIds } = w.completed();
    const service = await loadService(w.client);
    const one = await service.exchangeSale(w.reqs.owner, saleId, input([line(itemIds[0]!, w.V.V3, 1n)]));
    const two = await service.exchangeSale(w.reqs.owner, saleId, input([line(itemIds[0]!, w.V.V3, 1n)]));
    expect(two.exchangeId).not.toBe(one.exchangeId);
    expect(two.replayed).toBe(false);
  });
});

describe('sale exchange v1 — 2B hardening (found while implementing the service)', () => {
  it('SX51 the idempotency key has ONE spelling: the same UUID in upper case replays the exchange instead of creating a second one', async () => {
    const w = setup();
    const { saleId, itemIds } = w.completed();
    const key = randomUUID();
    const service = await loadService(w.client);
    const first = await service.exchangeSale(w.reqs.owner, saleId, input([line(itemIds[0]!, w.V.V3, 1n)], { idempotencyKey: key }));
    const replay = await service.exchangeSale(w.reqs.owner, saleId, input([line(itemIds[0]!, w.V.V3, 1n)], { idempotencyKey: key.toUpperCase() }));
    expect(replay).toEqual({ ...first, replayed: true, inventories: [] });
    expect(w.rows('saleExchange')).toHaveLength(1);
    expect(w.rows('saleExchange')[0]!.idempotencyKey).toBe(key);
  });

  // M1: every textual UUID has ONE spelling (lower case) before any query or hash.
  const upper = (value: string) => value.toUpperCase();
  const upperLine = (item: string, variant: string, quantity = 1n): ExchangeLineInput => ({ saleItemId: upper(item), replacementVariantId: upper(variant), returnQuantity: quantity });

  it('SX64 create with lower-case ids -> replay with UPPER-CASE saleId, saleItemId, replacementVariantId and key is the SAME exchange (200 path), nothing new written', async () => {
    const w = setup();
    const { saleId, itemIds } = w.completed();
    const key = randomUUID();
    const service = await loadService(w.client);
    const first = await service.exchangeSale(w.reqs.owner, saleId, input([line(itemIds[0]!, w.V.V3, 1n)], { idempotencyKey: key }));
    const replay = await service.exchangeSale(w.reqs.owner, upper(saleId), input([upperLine(itemIds[0]!, w.V.V3)], { idempotencyKey: upper(key) }));
    expect(replay).toEqual({ ...first, replayed: true, inventories: [] });
    expect(w.rows('saleExchange')).toHaveLength(1);
    expect(w.rows('saleExchangeLine')).toHaveLength(1);
  });

  it('SX65 create with UPPER-CASE ids resolves the sale, the item and the variant, and persists only lower-case ids', async () => {
    const w = setup();
    const { saleId, itemIds } = w.completed();
    const key = randomUUID();
    const result = await (await loadService(w.client)).exchangeSale(w.reqs.owner, upper(saleId), input([upperLine(itemIds[0]!, w.V.V3)], { idempotencyKey: upper(key) }));
    expect(result).toMatchObject({ saleId, replayed: false, lines: [{ saleItemId: itemIds[0], replacementVariantId: w.V.V3 }] });
    expect(w.rows('saleExchange')[0]).toMatchObject({ saleId, idempotencyKey: key });
    expect(w.rows('saleExchangeLine')[0]).toMatchObject({ saleId, saleItemId: itemIds[0], replacementVariantId: w.V.V3 });
  });

  it('SX66 same world: a lower-case request then the same intent in UPPER case under ANOTHER key is a distinct exchange but with the SAME request hash', async () => {
    const w = setup();
    const { saleId, itemIds } = w.completed();
    const service = await loadService(w.client);
    await service.exchangeSale(w.reqs.owner, saleId, input([line(itemIds[0]!, w.V.V3, 1n)]));
    await service.exchangeSale(w.reqs.owner, upper(saleId), input([upperLine(itemIds[0]!, w.V.V3)]));
    const [a, b] = w.rows('saleExchange');
    expect(a!.requestHash).toBe(b!.requestHash);
    expect(a!.id).not.toBe(b!.id);
  });

  it('SX52 a replay answers from the stored rows alone: it takes only the Sale lock (no Inventory lock, no pricing read of the catalog)', async () => {
    const w = setup();
    const { saleId, itemIds } = w.completed();
    const request = input([line(itemIds[0]!, w.V.V3, 1n)]);
    const service = await loadService(w.client);
    await service.exchangeSale(w.reqs.owner, saleId, request);
    w.db.rawQueries.length = 0;
    await service.exchangeSale(w.reqs.owner, saleId, request);
    expect(w.db.rawQueries.filter((query) => /FOR UPDATE/.test(query))).toHaveLength(1);
    expect(w.db.rawQueries[0]).toMatch(/FROM "Sale"[\s\S]*FOR UPDATE/);
  });

  it('SX53 the request hash is stored (64 lowercase hex) and does not depend on the order of the lines: the reversed request with the same key is a replay, not a conflict', async () => {
    const w = setup();
    const { saleId, itemIds } = w.completed();
    const key = randomUUID();
    const service = await loadService(w.client);
    const a = line(itemIds[0]!, w.V.V3, 1n);
    const b = line(itemIds[1]!, w.V.V2B, 1n);
    await service.exchangeSale(w.reqs.owner, saleId, input([a, b], { idempotencyKey: key }));
    expect(w.rows('saleExchange')[0]!.requestHash).toMatch(/^[0-9a-f]{64}$/);
    expect((await service.exchangeSale(w.reqs.owner, saleId, input([b, a], { idempotencyKey: key }))).replayed).toBe(true);
    expect(w.rows('saleExchange')).toHaveLength(1);
  });

  // ---- WHOLESALE sales: the replacement is priced with the SALE's own pricing context (its wholesale base), never the retail one ----

  const wholesale = (w: World) => {
    const made = w.completed();
    w.rows('sale').find((row) => row.id === made.saleId)!.pricingMode = 'WHOLESALE';
    return made;
  };
  const setVariant = (w: World, variantId: string, patch: Row) => Object.assign(w.rows('productVariant').find((row) => row.id === variantId)!, patch);

  it('SX57 WHOLESALE sale + a replacement WITHOUT a wholesale price -> 409 WHOLESALE_PRICE_MISSING and nothing is written', async () => {
    const w = setup();
    const { saleId, itemIds } = wholesale(w); // V3 has wholesalePrice null in the fixture
    const before = w.everything();
    expect(await appError((await loadService(w.client)).exchangeSale(w.reqs.owner, saleId, input([line(itemIds[0]!, w.V.V3, 1n)]))))
      .toEqual({ status: 409, code: 'WHOLESALE_PRICE_MISSING' });
    expect(w.everything()).toEqual(before);
  });

  it('SX58 WHOLESALE sale: the replacement is priced from ITS wholesale price, frozen in the line (the retail price is irrelevant)', async () => {
    const w = setup();
    const { saleId, itemIds } = wholesale(w);
    setVariant(w, w.V.V3, { wholesalePrice: P1, cashPrice: 99999n, price: 99999n }); // retail price differs wildly; wholesale equals the sold price
    const result = await (await loadService(w.client)).exchangeSale(w.reqs.owner, saleId, input([line(itemIds[0]!, w.V.V3, 1n)]));
    expect(result.lines[0]).toMatchObject({ originalUnitPrice: P1, replacementUnitPrice: P1 });
    expect(w.rows('saleExchangeLine')[0]).toMatchObject({ replacementUnitPrice: P1 });
  });

  it('SX59 WHOLESALE sale: a dearer wholesale price is refused as MORE_EXPENSIVE, a cheaper one as CHEAPER (the same equal-value rule)', async () => {
    const w = setup();
    const { saleId, itemIds } = wholesale(w);
    const service = await loadService(w.client);
    setVariant(w, w.V.V3, { wholesalePrice: P1 + 1n });
    expect(await appError(service.exchangeSale(w.reqs.owner, saleId, input([line(itemIds[0]!, w.V.V3, 1n)])))).toEqual({ status: 409, code: 'REPLACEMENT_MORE_EXPENSIVE_NOT_SUPPORTED' });
    setVariant(w, w.V.V3, { wholesalePrice: P1 - 1n });
    expect(await appError(service.exchangeSale(w.reqs.owner, saleId, input([line(itemIds[0]!, w.V.V3, 1n)])))).toEqual({ status: 409, code: 'REPLACEMENT_CHEAPER_NOT_SUPPORTED' });
  });

  it('SX60 an UPPER-CASE idempotency key is normalized: the first request persists the lower-case key, the replay in any capitalization does not duplicate', async () => {
    const w = setup();
    const { saleId, itemIds } = w.completed();
    const key = randomUUID();
    const service = await loadService(w.client);
    const request = (spelling: string) => input([line(itemIds[0]!, w.V.V3, 1n)], { idempotencyKey: spelling });
    const first = await service.exchangeSale(w.reqs.owner, saleId, request(key.toUpperCase()));
    expect(first.replayed).toBe(false);
    expect(w.rows('saleExchange')).toHaveLength(1);
    expect(w.rows('saleExchange')[0]!.idempotencyKey).toBe(key);
    const mixed = key.split('').map((c, i) => (i % 2 ? c.toUpperCase() : c)).join('');
    for (const spelling of [key, key.toUpperCase(), mixed]) {
      expect(await service.exchangeSale(w.reqs.owner, saleId, request(spelling))).toEqual({ ...first, replayed: true, inventories: [] });
    }
    expect(w.rows('saleExchange')).toHaveLength(1);
    expect(movementsOf(w, 'SALE_EXCHANGE_IN')).toHaveLength(1);
    expect(auditsOf(w)).toHaveLength(1);
  });

  it('SX54 the original variant has no Inventory row in the sale branch -> 409 SALE_EXCHANGE_STOCK_INCONSISTENT and nothing is written', async () => {
    const w = setup();
    const { saleId, itemIds } = w.completed();
    const inventory = w.rows('inventory');
    inventory.splice(inventory.findIndex((row) => row.id === w.inv.V1), 1);
    const before = w.everything();
    expect(await appError((await loadService(w.client)).exchangeSale(w.reqs.owner, saleId, input([line(itemIds[0]!, w.V.V3, 1n)]))))
      .toEqual({ status: 409, code: 'SALE_EXCHANGE_STOCK_INCONSISTENT' });
    expect(w.everything()).toEqual(before);
  });

  it('SX55 returning units past the signed BIGINT maximum of the original inventory fails closed and writes nothing', async () => {
    const w = setup();
    const { saleId, itemIds } = w.completed();
    w.invRow(w.inv.V1).physical = 9223372036854775807n;
    const before = w.everything();
    expect(await appError((await loadService(w.client)).exchangeSale(w.reqs.owner, saleId, input([line(itemIds[0]!, w.V.V3, 1n)]))))
      .toEqual({ status: 409, code: 'SALE_EXCHANGE_STOCK_INCONSISTENT' });
    expect(w.everything()).toEqual(before);
  });

  it('SX56 a request for the whole quantity then one more unit: the remainder is computed from the stored lines (2 of 2 is fine, a 3rd is not)', async () => {
    const w = setup();
    const { saleId, itemIds } = w.completed(); // V1 x2
    const service = await loadService(w.client);
    await service.exchangeSale(w.reqs.owner, saleId, input([line(itemIds[0]!, w.V.V3, 2n)]));
    expect(await appError(service.exchangeSale(w.reqs.owner, saleId, input([line(itemIds[0]!, w.V.V3, 1n)]))))
      .toEqual({ status: 409, code: 'EXCHANGE_QUANTITY_EXCEEDED' });
    expect(w.invRow(w.inv.V1)).toMatchObject({ physical: 100n });
    expect(w.invRow(w.inv.V3)).toMatchObject({ physical: 98n });
  });
});

// ---- AuditLog -----------------------------------------------------------------------------------------------------------------

describe('sale exchange v1 — AuditLog SALE_EXCHANGED (same transaction)', () => {
  it('SX41 one audit with actor, branch, reason, key, exchange id and frozen prices; BigInts stored as strings', async () => {
    const w = setup();
    const { saleId, itemIds } = w.completed();
    const key = randomUUID();
    const result = await (await loadService(w.client)).exchangeSale(w.reqs.owner, saleId, input([line(itemIds[0]!, w.V.V3, 2n)], { idempotencyKey: key }));
    const audits = auditsOf(w);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ userId: w.ids.owner, branchId: w.L1, action: 'SALE_EXCHANGED', entityType: 'Sale', entityId: saleId });
    expect(audits[0]!.before).toMatchObject({ status: 'COMPLETED' });
    expect(audits[0]!.after).toMatchObject({
      exchangeId: result.exchangeId, reason: REASON, idempotencyKey: key,
      lines: [{ saleItemId: itemIds[0], returnQuantity: '2', replacementVariantId: w.V.V3, originalUnitPrice: String(P1), replacementUnitPrice: String(P1) }],
    });
  });

  it('SX42 a refused exchange (auth, cheaper, more expensive, stock) writes no audit; a replay writes no second one', async () => {
    const w = setup();
    const { saleId, itemIds } = w.completed();
    const service = await loadService(w.client);
    await appError(service.exchangeSale(w.reqs.cashier, saleId, input([line(itemIds[0]!, w.V.V3)])));
    await appError(service.exchangeSale(w.reqs.owner, saleId, input([line(itemIds[0]!, w.V.V5)])));
    await appError(service.exchangeSale(w.reqs.owner, saleId, input([line(itemIds[0]!, w.V.V4)])));
    await appError(service.exchangeSale(w.reqs.owner, saleId, input([line(itemIds[0]!, w.V.LOW, 2n)])));
    expect(auditsOf(w)).toHaveLength(0);
    const request = input([line(itemIds[0]!, w.V.V3)]);
    await service.exchangeSale(w.reqs.owner, saleId, request);
    await service.exchangeSale(w.reqs.owner, saleId, request);
    expect(auditsOf(w)).toHaveLength(1);
  });
});

// ---- atomicity, Serializable + retry, lock order ------------------------------------------------------------------------------

type Delegate = Record<string, (...args: unknown[]) => Promise<unknown>>;
const WRITE_METHODS = new Set(['create', 'update', 'updateMany', 'upsert', 'delete']);
// A client whose k-th WRITE (any model, any of create/update/updateMany/upsert/delete) inside a transaction throws.
// failAt = 0 only counts. Independent of which writes the implementation chooses and in which order.
function writeFailingClient(w: World, failAt: number) {
  const state = { writes: 0, tripped: false };
  const real = w.db.client as Record<string, unknown>;
  const tx = new Proxy(real, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof property !== 'string' || typeof value !== 'object' || value === null || property.startsWith('$')) return value;
      return new Proxy(value as Delegate, {
        get(delegate, method) {
          const fn = delegate[method as string];
          if (typeof fn !== 'function' || !WRITE_METHODS.has(String(method))) return fn;
          return (...args: unknown[]) => {
            state.writes += 1;
            if (failAt > 0 && state.writes === failAt) {
              state.tripped = true;
              return Promise.reject(new Error(`injected failure at write ${failAt} (${property}.${String(method)})`));
            }
            return fn.apply(delegate, args);
          };
        },
      });
    },
  });
  const client = new Proxy(real, {
    get(target, property, receiver) {
      if (property === '$transaction') return (operation: (t: unknown) => Promise<unknown>, options?: unknown) => (real.$transaction as (...a: unknown[]) => Promise<unknown>)(() => operation(tx), options);
      return Reflect.get(target, property, receiver);
    },
  }) as unknown as PrismaClient;
  return { client, state };
}

describe('sale exchange v1 — atomicity', () => {
  it('SX43 a failure at ANY single write of a two-line exchange rolls everything back (stock, exchange, lines, movements, audit)', async () => {
    const scenario = () => {
      const w = setup();
      const { saleId, itemIds } = w.completed();
      return { w, saleId, request: input([line(itemIds[0]!, w.V.V3, 1n), line(itemIds[1]!, w.V.V2B, 1n)]) };
    };
    const clean = scenario();
    const counting = writeFailingClient(clean.w, 0);
    await (await loadService(counting.client)).exchangeSale(clean.w.reqs.owner, clean.saleId, clean.request);
    const total = counting.state.writes;
    // at least: exchange, 2 lines, 4 inventory updates, 4 movements, audit
    expect(total).toBeGreaterThanOrEqual(8);
    for (let k = 1; k <= total; k += 1) {
      const { w, saleId, request } = scenario();
      const before = w.everything();
      const failing = writeFailingClient(w, k);
      await expect((await loadService(failing.client)).exchangeSale(w.reqs.owner, saleId, request), `write ${k}`).rejects.toThrow();
      expect(failing.state.tripped, `write ${k} was reached`).toBe(true);
      expect(w.everything(), `rollback after failing write ${k}`).toEqual(before);
    }
  });
});

describe('sale exchange v1 — Serializable transaction and retries', () => {
  function transactionSpy(w: World, failures: Array<Record<string, unknown>>) {
    const calls: Array<{ isolationLevel?: string }> = [];
    const real = w.db.client as Record<string, unknown>;
    const pending = [...failures];
    const client = new Proxy(real, {
      get(target, property, receiver) {
        if (property !== '$transaction') return Reflect.get(target, property, receiver);
        return (operation: unknown, options?: { isolationLevel?: string }) => {
          calls.push({ isolationLevel: options?.isolationLevel });
          const failure = pending.shift();
          if (failure) return Promise.reject(Object.assign(new Error('serialization failure'), failure));
          return (real.$transaction as (...a: unknown[]) => Promise<unknown>)(operation, options);
        };
      },
    }) as unknown as PrismaClient;
    return { client, calls };
  }
  const start = async (w: World, client: PrismaClient) => {
    const { saleId, itemIds } = w.completed();
    return (await loadService(client)).exchangeSale(w.reqs.owner, saleId, input([line(itemIds[0]!, w.V.V3, 1n)]));
  };

  it('SX44 the exchange runs in ONE Serializable transaction', async () => {
    const w = setup();
    const spy = transactionSpy(w, []);
    await start(w, spy.client);
    expect(spy.calls).toEqual([{ isolationLevel: 'Serializable' }]);
  });

  it.each([
    ['P2034', { code: 'P2034' }],
    ['40001', { code: 'P2010', meta: { code: '40001' } }],
    ['40P01', { code: 'P2010', meta: { code: '40P01' } }],
    // the shapes @prisma/adapter-pg really produces (the same set the manual stock adjustment already classifies)
    ['adapter originalCode 40001', { code: 'P2010', meta: { driverAdapterError: { cause: { originalCode: '40001' } } } }],
    ['adapter originalCode 40P01', { code: 'P2010', meta: { driverAdapterError: { cause: { originalCode: '40P01' } } } }],
    ['adapter cause.code 40001', { meta: { driverAdapterError: { cause: { code: '40001' } } } }],
    ['adapter kind TransactionWriteConflict', { meta: { driverAdapterError: { cause: { kind: 'TransactionWriteConflict' } } } }],
    ['pg error code 40001 on the error itself', { code: '40001' }],
    ['pg error code 40P01 on the error itself', { code: '40P01' }],
    ['cause chain (Error.cause -> P2034)', { cause: { code: 'P2034' } }],
    ['cause chain two levels (-> adapter originalCode 40001)', { cause: { cause: { meta: { driverAdapterError: { cause: { originalCode: '40001' } } } } } }],
  ])('SX45 a transient %s failure is retried and the exchange is applied exactly once', async (_label, failure) => {
    const w = setup();
    const spy = transactionSpy(w, [failure]);
    const result = await start(w, spy.client);
    expect(result.replayed).toBe(false);
    expect(spy.calls).toHaveLength(2);
    expect(spy.calls.every((call) => call.isolationLevel === 'Serializable')).toBe(true);
    expect(w.rows('saleExchange')).toHaveLength(1);
    expect(auditsOf(w)).toHaveLength(1);
    expect(movementsOf(w, 'SALE_EXCHANGE_IN')).toHaveLength(1);
  });

  it('SX46 three consecutive transient failures -> 409 CONCURRENCY_ERROR and no effect', async () => {
    const w = setup();
    const { saleId, itemIds } = w.completed();
    const before = w.everything();
    const spy = transactionSpy(w, [{ code: 'P2034' }, { code: 'P2034' }, { code: 'P2034' }]);
    expect(await appError((await loadService(spy.client)).exchangeSale(w.reqs.owner, saleId, input([line(itemIds[0]!, w.V.V3, 1n)]))))
      .toEqual({ status: 409, code: 'CONCURRENCY_ERROR' });
    expect(spy.calls).toHaveLength(3);
    expect(w.everything()).toEqual(before);
  });

  it('SX61 a retry that succeeds after TWO adapter-shaped failures applies the exchange exactly once (3rd attempt)', async () => {
    const w = setup();
    const adapter = (originalCode: string) => ({ code: 'P2010', meta: { driverAdapterError: { cause: { originalCode } } } });
    const spy = transactionSpy(w, [adapter('40001'), adapter('40P01')]);
    const result = await start(w, spy.client);
    expect(result.replayed).toBe(false);
    expect(spy.calls).toHaveLength(3);
    expect(w.rows('saleExchange')).toHaveLength(1);
  });

  it('SX62 exhaustion with adapter-shaped failures -> 409 CONCURRENCY_ERROR, and the raw Prisma / driver error never reaches the caller', async () => {
    const w = setup();
    const { saleId, itemIds } = w.completed();
    const adapter = { code: 'P2010', meta: { driverAdapterError: { cause: { originalCode: '40001', message: 'SECRET-DRIVER-DETAIL' } } } };
    const spy = transactionSpy(w, [adapter, adapter, adapter]);
    const error = await (await loadService(spy.client)).exchangeSale(w.reqs.owner, saleId, input([line(itemIds[0]!, w.V.V3, 1n)])).then(() => null, (cause: unknown) => cause);
    expect(error).toBeInstanceOf(AppError);
    expect({ status: (error as AppError).status, code: (error as AppError).code }).toEqual({ status: 409, code: 'CONCURRENCY_ERROR' });
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain('SECRET-DRIVER-DETAIL');
    expect(spy.calls).toHaveLength(3);
  });

  it.each([
    ['P2002 unique violation', { code: 'P2002' }], ['a foreign SQLSTATE 23505', { code: '23505' }], ['a message that merely contains 140001 (not the SQLSTATE 40001 as a token)', { message: 'row 140001 missing' }],
  ])('SX63 %s is NOT transient: not retried, one attempt', async (_label, failure) => {
    const w = setup();
    const { saleId, itemIds } = w.completed();
    const spy = transactionSpy(w, [failure]);
    await expect((await loadService(spy.client)).exchangeSale(w.reqs.owner, saleId, input([line(itemIds[0]!, w.V.V3, 1n)]))).rejects.toThrow();
    expect(spy.calls).toHaveLength(1);
  });

  it('SX47 a non-transient error is NOT retried', async () => {
    const w = setup();
    const { saleId, itemIds } = w.completed();
    const spy = transactionSpy(w, [{ code: 'P2002' }]);
    await expect((await loadService(spy.client)).exchangeSale(w.reqs.owner, saleId, input([line(itemIds[0]!, w.V.V3, 1n)]))).rejects.toThrow();
    expect(spy.calls).toHaveLength(1);
  });
});

describe('sale exchange v1 — lock order Sale -> Inventory (ordered by id); no cash and no reservation locks', () => {
  const FOR_UPDATE = (table: string) => new RegExp(`FROM "${table}"[\\s\\S]*FOR UPDATE`);
  const firstIndex = (queries: string[], pattern: RegExp) => queries.findIndex((query) => pattern.test(query));

  it('SX48 locks the Sale FIRST, then Inventory; never a CashSession or a StockReservation', async () => {
    const w = setup();
    const { saleId, itemIds } = w.completed();
    await (await loadService(w.client)).exchangeSale(w.reqs.owner, saleId, input([line(itemIds[0]!, w.V.V3, 1n)]));
    const saleLock = firstIndex(w.db.rawQueries, FOR_UPDATE('Sale'));
    const inventoryLock = firstIndex(w.db.rawQueries, FOR_UPDATE('Inventory'));
    expect(saleLock).toBe(0);
    expect(inventoryLock).toBeGreaterThan(saleLock);
    expect(firstIndex(w.db.rawQueries, FOR_UPDATE('CashSession'))).toBe(-1);
    expect(firstIndex(w.db.rawQueries, FOR_UPDATE('StockReservation'))).toBe(-1);
  });

  it('SX49 returned AND replacement inventories are locked together in ONE statement ordered by id (no lock-order deadlock between exchanges)', async () => {
    const w = setup();
    const { saleId, itemIds } = w.completed();
    await (await loadService(w.client)).exchangeSale(w.reqs.owner, saleId, input([line(itemIds[0]!, w.V.V3, 1n)]));
    const inventoryLocks = w.db.rawQueries.filter((query) => FOR_UPDATE('Inventory').test(query));
    expect(inventoryLocks).toHaveLength(1);
    expect(inventoryLocks[0]).toMatch(/ORDER BY id ASC/);
  });

  it('SX50 a refused request takes only the Sale lock (the permission is checked before Inventory is locked)', async () => {
    const w = setup();
    const { saleId, itemIds } = w.completed();
    await appError((await loadService(w.client)).exchangeSale(w.reqs.cashier, saleId, input([line(itemIds[0]!, w.V.V3, 1n)])));
    expect(w.db.rawQueries.filter((query) => /FOR UPDATE/.test(query))).toHaveLength(1);
    expect(w.db.rawQueries[0]).toMatch(/FROM "Sale"[\s\S]*FOR UPDATE/);
  });
});
